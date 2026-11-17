use crate::{
    contracts,
    modules::{ingestion, knowledge},
    persistence::AppTx,
    types::{AccessContext, Error, Result, epoch, fingerprint},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::MySqlPool;
use std::collections::{BTreeSet, HashSet};

use super::evidence_delivery::ResponseCapacity;

const CURSOR_PREFIX: &str = "source_identity:1:";

#[derive(Serialize, Deserialize)]
#[serde(
    tag = "directory",
    content = "after",
    rename_all = "snake_case",
    deny_unknown_fields
)]
enum Position {
    Knowledge(String),
    Platform(String),
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct IdentityCursor {
    schema: u8,
    binding: String,
    position: Position,
}

impl IdentityCursor {
    fn restore(cursor: &str, binding: &str) -> Result<Position> {
        if cursor.len() > 65_536 {
            return Err(Error::new("invalid_cursor"));
        }
        let encoded = cursor
            .strip_prefix(CURSOR_PREFIX)
            .ok_or(Error::new("invalid_cursor"))?;
        let bytes = URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| Error::new("invalid_cursor"))?;
        let saved: Self =
            serde_json::from_slice(&bytes).map_err(|_| Error::new("invalid_cursor"))?;
        let (Position::Knowledge(after) | Position::Platform(after)) = &saved.position;
        if saved.schema != 1
            || saved.binding != binding
            || after.is_empty()
            || after.len() > 64
            || !after
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        {
            return Err(Error::new("invalid_cursor"));
        }
        Ok(saved.position)
    }

    fn next(binding: &str, position: &Position) -> Result<String> {
        let bytes = serde_json::to_vec(&json!({
            "schema": 1, "binding": binding, "position": position,
        }))
        .map_err(|_| Error::new("invalid_cursor"))?;
        Ok(format!("{CURSOR_PREFIX}{}", URL_SAFE_NO_PAD.encode(bytes)))
    }
}

// 当前头目录只发现身份，不要求当前消息已归属任务，也不登记已读正文依赖。
// keyset按知识对象、平台来源两个目录推进；它不冻结正文或提供语义排名。
pub(super) async fn search(
    pool: &MySqlPool,
    ctx: &AccessContext,
    request: &Value,
    budget: Option<&contracts::generated::ResponseBudget>,
) -> Result<Value> {
    let query = request["query"].as_str().expect("validated query").trim();
    if query.is_empty() {
        return Err(Error::new("invalid_input"));
    }
    let terms: Vec<_> = query.split_whitespace().collect();
    let limit = request["limit"].as_u64().unwrap_or(10) as usize;
    let kinds: Vec<_> = request["kinds"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|kind| kind.as_str().expect("validated kind"))
        .collect();
    // hints保留在绑定内，但不作为权限/来源限制；目录按稳定标识排序。
    let binding = fingerprint(&json!({
        "view": "source_identity", "match_semantics": "whitespace_any_1",
        "query": request["query"], "limit": limit,
        "kinds": request["kinds"], "hints": request["hints"],
        "user_id": ctx.user_id, "space_id": ctx.space_id,
    }));
    let resumed = request["cursor"]
        .as_str()
        .map(|cursor| IdentityCursor::restore(cursor, &binding))
        .transpose()?;
    let mut tx = AppTx::begin(pool).await?;
    let readable_platform: BTreeSet<_> =
        ingestion::readable_source_heads_in_tx(&mut tx, &ctx.space_id)
            .await?
            .into_iter()
            .map(|(id, _)| id)
            .collect();
    let ids = match &resumed {
        Some(Position::Platform(_)) => Vec::new(),
        position => {
            let after = match position {
                Some(Position::Knowledge(id)) => Some(id.as_str()),
                _ => None,
            };
            knowledge::identity_candidate_ids_in_tx(&mut tx, ctx, &terms, &kinds, after, limit + 1)
                .await?
        }
    };
    let metadata = knowledge::candidate_meta_in_tx(&mut tx, ctx, &ids, None).await?;
    let mut objects = Vec::new();
    for meta in &metadata {
        if meta["kind"] != "document" {
            objects.push((
                meta["id"]
                    .as_str()
                    .ok_or(Error::new("not_available"))?
                    .to_owned(),
                epoch(
                    meta["version"]
                        .as_str()
                        .ok_or(Error::new("not_available"))?,
                )?,
            ));
        }
    }
    let roots = knowledge::dependency_index::contribution_roots_in_tx(&mut tx, &objects).await?;
    let document_roots: BTreeSet<_> = roots
        .iter()
        .flat_map(|root| &root.sources)
        .filter(|(kind, _)| kind == "document")
        .map(|(_, id)| id.clone())
        .collect();
    let document_metadata = knowledge::candidate_meta_in_tx(
        &mut tx,
        ctx,
        &document_roots.into_iter().collect::<Vec<_>>(),
        None,
    )
    .await?;
    let readable_documents: HashSet<_> = document_metadata
        .iter()
        .filter(|meta| meta["state"] == "enabled" && meta["kind"] == "document")
        .filter_map(|meta| meta["id"].as_str())
        .collect();
    let mut candidates = Vec::with_capacity(limit + 1);
    for id in ids {
        let meta = metadata
            .iter()
            .find(|meta| meta["id"] == id && meta["state"] == "enabled")
            .ok_or(Error::new("not_available"))?;
        let mut source_keys = Vec::new();
        let mut complete;
        if meta["kind"] == "document" {
            // 文档身份就是该文档；关联知识和派生陈述不改变它的原文身份。
            source_keys.push(json!({"kind": "document", "id": id}));
            complete = true;
        } else {
            let own = roots.iter().find(|root| root.owner_id == id);
            complete = own.is_some_and(|root| root.unknown.is_empty());
            for (kind, source) in own.into_iter().flat_map(|root| &root.sources) {
                let readable = match kind.as_str() {
                    "platform" => readable_platform.contains(source),
                    "document" => readable_documents.contains(source.as_str()),
                    _ => false,
                };
                if !readable || source_keys.len() == 1000 {
                    complete = false;
                    continue;
                }
                // 保留真正源级根；schema/semantic-catalog整包不能被重命名成单表范围。
                source_keys.push(json!({"kind": kind, "id": source}));
            }
        }
        candidates.push((
            Position::Knowledge(id),
            json!({
                "record_kind": "source_identity", "name": meta["name"], "kind": meta["kind"],
                "object_id": meta["id"], "object_version": meta["version"],
                "source_keys": source_keys, "roots_complete": complete,
            }),
        ));
    }
    // 来源没有知识对象时仍可按稳定ID发现；显式kinds只列对应种类的知识身份。
    if kinds.is_empty() && candidates.len() < limit + 1 {
        for id in &readable_platform {
            if let Some(Position::Platform(after)) = &resumed
                && id <= after
            {
                continue;
            }
            let normalized_id = id.to_lowercase();
            if terms.as_slice() != ["*"]
                && !terms
                    .iter()
                    .any(|term| normalized_id.contains(&term.to_lowercase()))
            {
                continue;
            }
            candidates.push((
                Position::Platform(id.clone()),
                json!({
                    "record_kind": "source_identity", "name": id,
                    "source_keys": [{"kind": "platform", "id": id}], "roots_complete": true,
                }),
            ));
            if candidates.len() == limit + 1 {
                break;
            }
        }
    }
    tx.commit().await?;
    let capacity = ResponseCapacity::new(budget);
    let mut count = limit.min(candidates.len());
    loop {
        let next = if count < candidates.len() && count > 0 {
            json!(IdentityCursor::next(&binding, &candidates[count - 1].0)?)
        } else {
            Value::Null
        };
        let bounded = !next.is_null();
        let reply = json!({
            "hits": candidates[..count].iter().map(|(_, hit)| hit).collect::<Vec<_>>(),
            "search_coverage": {
                "channels": [{"channel": "exact", "state": "available"}],
                "state": if bounded {"bounded"} else {"searched"},
                "reasons": if bounded {json!(["candidate_limit"])} else {json!([])}, "next": next,
            },
            "personal_memories": [], "selected_skills": [], "next_asset_after": null,
            "asset_total": 0, "asset_cursor_invalid": false, "memory_retrieval": "excluded_by_view",
        });
        if capacity.fits(&reply) {
            contracts::validate("KnowledgeSearchReply", &reply)?;
            return Ok(reply);
        }
        // 至少交付一条完整身份和原续读位置；装不下不能伪装成零结果。
        if count <= 1 {
            return Err(Error::new("tool_response_capacity"));
        }
        count -= 1;
    }
}

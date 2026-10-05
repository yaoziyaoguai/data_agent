use super::knowledge_sources;
use crate::{
    modules::{ingestion, knowledge},
    persistence::AppTx,
    types::{AccessContext, Error, Result, epoch},
};
use serde_json::{Value, json};
use std::collections::{HashSet, VecDeque};

const MAX_SOURCES: usize = 32;
const MAX_DEPTH: usize = 8;
const MAX_BODY_BYTES: usize = 24576;

pub async fn queue_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &Value,
    sources: Vec<Value>,
) -> Result<()> {
    let material = collect_in_tx(tx, ctx, object, sources).await?;
    ingestion::queue_prefill_in_tx(tx, ctx, object, &material).await
}

pub async fn collect_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &Value,
    initial: Vec<Value>,
) -> Result<Value> {
    let mut sources = Vec::new();
    let mut gaps = Vec::new();
    let mut seen = HashSet::new();
    let mut related = vec![object["id"].as_str().unwrap_or("").to_owned()];
    related.extend(
        object["related_ids"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|id| id.as_str().map(str::to_owned)),
    );
    let mut queue = VecDeque::new();
    for source in initial {
        queue.push_back((
            source["source_id"].as_str().unwrap_or("").to_owned(),
            0,
            Some(source),
        ));
    }
    while let Some((source_id, depth, supplied)) = queue.pop_front() {
        if !seen.insert(source_id.clone()) {
            continue;
        }
        if seen.len() > 128 || sources.len() >= MAX_SOURCES {
            gaps.push(json!({"reason":"lineage_limit"}));
            break;
        }
        if depth > MAX_DEPTH {
            gaps.push(json!({"source_id":source_id,"reason":"lineage_depth_limit"}));
            continue;
        }
        let source = if let Some(source) = supplied {
            source
        } else {
            match knowledge_sources::read_in_tx(tx, ctx, &source_id, None).await {
                Ok(source) => source,
                Err(error) if matches!(error.code, "not_available" | "stale_knowledge") => {
                    gaps.push(json!({"source_id":source_id,"reason":"upstream_unavailable"}));
                    continue;
                }
                Err(error) => return Err(error),
            }
        };
        if source["complete"] != true {
            gaps.push(json!({"source_id":source_id,"reason":"source_incomplete"}));
        }
        sources.push(source);
        if source_id.starts_with("catalog-") {
            for (upstream, table) in ingestion::catalog_upstream_in_tx(tx, ctx, &source_id).await? {
                related.push(table);
                queue.push_back((upstream, depth + 1, None));
            }
        }
    }
    let documents = knowledge::related_documents_in_tx(tx, ctx, &related).await?;
    if documents.len() > 32 {
        gaps.push(json!({"reason":"document_limit"}));
    }
    for document in documents.into_iter().take(32) {
        if document["id"] == object["id"] {
            continue;
        }
        match knowledge_sources::assert_in_tx(tx, ctx, &document).await {
            Ok(()) => {
                let source = knowledge_sources::document_source(&document);
                if source["complete"] != true {
                    gaps.push(json!({"source_id":source["source_id"],"reason":"document_body_unavailable"}));
                }
                sources.push(source);
            }
            Err(error) if matches!(error.code, "not_available" | "stale_knowledge") => {
                gaps.push(json!({"object_id":document["id"],"reason":"document_unavailable"}));
            }
            Err(error) => return Err(error),
        }
    }
    bound_bodies(&mut sources, &mut gaps);
    Ok(
        json!({"sources":sources,"coverage":{"state":if gaps.is_empty(){"complete"}else{"incomplete"},"gaps":gaps}}),
    )
}

// 按材料均分剩余额度，短材料释放余量；文档不会被排在前面的长SQL完全挤掉。
fn bound_bodies(sources: &mut [Value], gaps: &mut Vec<Value>) {
    let mut order: Vec<_> = (0..sources.len()).collect();
    order.sort_by_key(|i| sources[*i]["body"].as_str().unwrap_or("").len());
    let mut remaining = MAX_BODY_BYTES;
    let count = order.len();
    for (position, index) in order.into_iter().enumerate() {
        let source = &mut sources[index];
        let body = source["body"].as_str().unwrap_or("");
        let allowance = remaining / (count - position);
        if body.len() > allowance {
            let mut end = allowance;
            while !body.is_char_boundary(end) {
                end -= 1;
            }
            let excerpt = body[..end].to_owned();
            gaps.push(json!({"source_id":source["source_id"],"reason":"body_limit","included_bytes":end,"total_bytes":body.len()}));
            source["body"] = json!(excerpt);
            source["complete"] = json!(false);
        }
        remaining = remaining.saturating_sub(source["body"].as_str().unwrap_or("").len());
    }
}

pub async fn check_in_tx(tx: &mut AppTx<'_>, ctx: &AccessContext, input: &Value) -> Result<()> {
    let mut raw = Vec::new();
    let mut refs = vec![(
        input["object"]["id"]
            .as_str()
            .ok_or(Error::new("invalid_input"))?
            .to_owned(),
        epoch(input["object"]["version"].as_str().unwrap_or(""))?,
    )];
    let mut pending = input["sources"]
        .as_array()
        .ok_or(Error::new("invalid_input"))?
        .clone();
    let mut seen = HashSet::new();
    while let Some(source) = pending.pop() {
        let source_id = source["source_id"]
            .as_str()
            .ok_or(Error::new("invalid_input"))?;
        let version = epoch(source["version"].as_str().unwrap_or(""))?;
        if !seen.insert((source_id.to_owned(), version)) {
            continue;
        }
        if let Some(id) = knowledge_sources::document_id(source_id) {
            refs.push((id.to_owned(), version));
            let document = knowledge::read_in_tx(tx, ctx, id, Some(version), false).await?;
            if document["kind"] != "document" {
                return Err(Error::new("not_available"));
            }
            for (id, version) in knowledge_sources::requirements(&document)? {
                pending.push(json!({"source_id":id,"version":version.to_string()}));
            }
        } else {
            raw.push(source);
        }
    }
    // 与来源同步相同的锁序：先来源空间，再按ID锁目标和文档，持有至正式建议落库。
    ingestion::check_prefill_sources_in_tx(tx, &ctx.space_id, &json!(raw)).await?;
    knowledge::lock_versions_in_tx(tx, ctx, &refs).await
}

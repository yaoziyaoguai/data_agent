use super::context_authority::{has_sources, items, knowledge_paths, result_query_ids};
use crate::{
    contracts::{
        self,
        generated::{SourceKey, SourceKeyKind, SourceLimits},
    },
    modules::retrieval::{self, vector::AllowedRecords},
    modules::{analysis, conversations, ingestion, knowledge, queries},
    persistence::AppTx,
    search_scope::KnowledgeSearchScope,
    types::{AccessContext, Error, Result, epoch},
};
use serde_json::{Value, json};
use std::collections::BTreeSet;

// 独立于检索范围的本轮来源允许集。
#[derive(Clone)]
pub(super) struct SourceGate(Vec<SourceKey>);

impl SourceGate {
    fn keys(&self) -> impl Iterator<Item = (&str, &str)> {
        self.0.iter().map(|key| {
            let kind = match key.kind {
                SourceKeyKind::Document => "document",
                SourceKeyKind::Platform => "platform",
            };
            (kind, key.id.as_str())
        })
    }

    fn member(&self, kind: &str, id: &str) -> bool {
        self.keys().any(|key| key == (kind, id))
    }

    pub fn allowed_keys(&self) -> BTreeSet<(String, String)> {
        self.keys()
            .map(|(kind, id)| (kind.to_owned(), id.to_owned()))
            .collect()
    }

    // read_source参数用稳定来源身份：document-前缀或平台source_id。
    pub fn allows_source_arg(&self, source_id: &str) -> bool {
        match source_id.strip_prefix("document-") {
            Some(id) => self.member("document", id),
            None => self.member("platform", source_id),
        }
    }

    pub fn assert_source_arg(&self, source_id: &str) -> Result<()> {
        self.allows_source_arg(source_id)
            .then_some(())
            .ok_or(Error::new("source_not_allowed"))
    }

    fn permits(&self, kind: &str, id: &str, source: Option<&str>, table: Option<&str>) -> bool {
        let kind = if kind == "document" {
            "document"
        } else {
            "platform"
        };
        self.member(kind, id)
            || source.is_some_and(|id| self.allows_source_arg(id))
            || table.is_some_and(|id| self.member("platform", id))
    }

    pub fn allows_object(&self, object: &Value) -> Result<bool> {
        let entries = items(&object["entries"]);
        let table = object["table_id"].as_str().or_else(|| {
            entries
                .iter()
                .find_map(|entry| entry["effective_structure"]["table"]["object_id"].as_str())
        });
        if self.permits(
            object["kind"]
                .as_str()
                .ok_or(crate::types::Error::new("unavailable"))?,
            object["id"]
                .as_str()
                .ok_or(crate::types::Error::new("unavailable"))?,
            None,
            table,
        ) {
            return Ok(true);
        }
        let object_source = object["source_id"].as_str();
        if entries.is_empty() {
            return Ok(object_source.is_some_and(|source| self.allows_source_arg(source)));
        }
        Ok(entries.iter().all(|entry| {
            entry["source_facts"]["source_id"]
                .as_str()
                .or(object_source)
                .is_some_and(|source| self.allows_source_arg(source))
        }))
    }

    pub fn allowed_sources(&self) -> &[SourceKey] {
        &self.0
    }
}

// 沿活动任务解析。旧消息缺少活动绑定时仍须能证明来源范围。
pub(super) async fn resolve_in_tx(
    tx: &mut AppTx<'_>,
    conv: &conversations::LockedConversation,
    message: &str,
) -> Result<Option<SourceGate>> {
    if let Some((task, _)) = conversations::active_task_ref_in_tx(tx, conv).await? {
        return resolve_for_task_in_tx(tx, &conv.id, &task).await;
    }
    let tasks = conversations::message_task_ids_in_tx(tx, conv, message).await?;
    if let [task] = tasks.as_slice() {
        return resolve_for_task_in_tx(tx, &conv.id, task).await;
    }
    if tasks.is_empty() && !analysis::active_task_sources_unrestricted_in_tx(tx, &conv.id).await? {
        return Err(Error::new("task_context_required"));
    }
    for task in tasks {
        if resolve_for_task_in_tx(tx, &conv.id, &task).await?.is_some() {
            return Err(Error::new("task_context_required"));
        }
    }
    Ok(None)
}

pub(super) struct ActiveProjection {
    pub task: Option<(String, u64)>,
    pub gate: Option<SourceGate>,
    pub scope_known: bool,
}

pub(super) async fn active_projection_in_tx(
    tx: &mut AppTx<'_>,
    locked: &conversations::LockedConversation,
) -> Result<ActiveProjection> {
    let task = conversations::active_task_ref_in_tx(tx, locked).await?;
    let declaration = match &task {
        Some((id, _)) => analysis::declared_source_limits_in_tx(tx, &locked.id, id).await?,
        None => analysis::active_task_sources_unrestricted_in_tx(tx, &locked.id)
            .await?
            .then_some(Value::Null),
    };
    ActiveProjection::new(task, declaration.as_ref())
}

impl ActiveProjection {
    pub(super) fn new(task: Option<(String, u64)>, declaration: Option<&Value>) -> Result<Self> {
        Ok(Self {
            task,
            scope_known: declaration.is_some(),
            gate: declaration.map(decode_declared).transpose()?.flatten(),
        })
    }

    pub(super) fn baseline(&self) -> Value {
        let (task, version) = self
            .task
            .as_ref()
            .map(|(id, version)| (id, version))
            .unzip();
        json!({"task_id":task,"condition_version":version.map(u64::to_string)})
    }

    pub(super) fn scope_changed(&self, authority: &Value, prior: Option<&Value>) -> Result<bool> {
        let previous = &authority["active_task"];
        let baseline = self.baseline();
        let sources = has_sources(authority);
        if !self.scope_known {
            return Ok(sources || (previous.is_object() && previous != &baseline));
        }
        if previous == &baseline {
            return Ok(false);
        }
        if !previous["task_id"].is_string() {
            return Ok(
                self.gate.is_some() || (!previous.is_object() && self.task.is_some() && sources)
            );
        }
        let Some(prior) = prior else { return Ok(true) };
        let allowed = decode_declared(prior)?;
        Ok(allowed.as_ref().map(SourceGate::allowed_keys)
            != self.gate.as_ref().map(SourceGate::allowed_keys))
    }
}

pub(super) fn previous_task(authority: &Value) -> Result<Option<(&str, u64)>> {
    let prev = &authority["active_task"];
    prev["task_id"]
        .as_str()
        .map(|task| {
            Ok((
                task,
                epoch(prev["condition_version"].as_str().unwrap_or(""))?,
            ))
        })
        .transpose()
}

pub(super) async fn scope_changed_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
    authority: &Value,
    projection: &ActiveProjection,
) -> Result<bool> {
    let prior = if projection.scope_known
        && authority["active_task"] != projection.baseline()
        && let Some((task, version)) = previous_task(authority)?
    {
        analysis::source_limits_at_version_in_tx(tx, cid, task, version).await?
    } else {
        None
    };
    projection.scope_changed(authority, prior.as_ref())
}

/// 只对本次交付声明的直接依据应用用户的来源限制。
pub(super) async fn authority_within_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    gate: &SourceGate,
    authority: &Value,
) -> Result<bool> {
    if !items(&authority["sources"]).iter().all(|pair| {
        pair[0]
            .as_str()
            .is_some_and(|id| gate.allows_source_arg(id))
    }) {
        return Ok(false);
    }
    let ids = result_query_ids(authority)?;
    let queries = queries::read_map_in_tx(tx, ctx, &ids).await?;
    if queries.len() != ids.len() {
        return Ok(false);
    }
    for query in queries.values() {
        let target = query["target_id"]
            .as_str()
            .ok_or(Error::new("unavailable"))?;
        if !gate.member("platform", target) {
            return Ok(false);
        }
    }
    let ids: BTreeSet<_> = items(&authority["knowledge"])
        .iter()
        .map(|item| {
            item[0]
                .as_str()
                .map(str::to_owned)
                .ok_or(Error::new("unavailable"))
        })
        .collect::<Result<_>>()?;
    let ids: Vec<_> = ids.into_iter().collect();
    let heads: std::collections::HashMap<_, _> =
        knowledge::candidate_meta_in_tx(tx, ctx, &ids, None)
            .await?
            .into_iter()
            .filter(|object| object["state"] == "enabled")
            .map(|object| {
                let id = object["id"]
                    .as_str()
                    .ok_or(Error::new("unavailable"))?
                    .to_owned();
                Ok((id, object))
            })
            .collect::<Result<_>>()?;
    for (id, version, path) in knowledge_paths(authority) {
        let id = id.as_str().ok_or(crate::types::Error::new("unavailable"))?;
        let Some(head) = heads.get(id) else {
            return Ok(false);
        };
        let version = version
            .as_str()
            .ok_or(crate::types::Error::new("unavailable"))?;
        let selected = if head["version"] == version {
            if gate.permits(
                head["kind"]
                    .as_str()
                    .ok_or(crate::types::Error::new("unavailable"))?,
                id,
                None,
                head["table_id"].as_str(),
            ) {
                continue;
            }
            knowledge::read_selected_structure_in_tx(tx, ctx, id, epoch(version)?, Some(path))
                .await?
        } else {
            // 历史报告按原版本的直接来源裁决，当前头只证明对象仍可访问。
            let Some(mut archived) =
                knowledge::archived_body_in_tx(tx, ctx, id, epoch(version)?).await?
            else {
                return Ok(false);
            };
            if !path.is_empty() {
                let entries = archived["entries"]
                    .as_array_mut()
                    .ok_or(crate::types::Error::new("unavailable"))?;
                entries.retain(|entry| entry["path"] == path || entry["entry_id"] == path);
                if entries.is_empty() {
                    return Ok(false);
                }
            }
            archived
        };
        if !gate.allows_object(&selected)? {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(super) async fn assert_asset_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    gate: Option<&SourceGate>,
    asset: &Value,
) -> Result<()> {
    let refs = &asset["dependencies"];
    if gate.is_some() && items(refs).is_empty() {
        return Err(Error::new("source_not_allowed"));
    }
    super::knowledge::check_refs_for_task_in_tx(tx, ctx, refs, gate)
        .await
        .map_err(|error| {
            if error.code == "stale_knowledge" {
                Error::new("not_available")
            } else {
                error
            }
        })
}

// 正式草稿沿其任务限定范围，消息的活动任务可能不同。
pub(super) async fn resolve_for_task_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
    task_id: &str,
) -> Result<Option<SourceGate>> {
    let declaration = analysis::declared_source_limits_in_tx(tx, cid, task_id)
        .await?
        .ok_or(Error::new("task_context_required"))?;
    decode_declared(&declaration)
}

fn decode_declared(limits: &Value) -> Result<Option<SourceGate>> {
    (!limits.is_null())
        .then(|| gate_from_contract(limits))
        .transpose()
}

// 每路召回复用同一允许集合。
pub(super) async fn allowed_records_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    gate: Option<&SourceGate>,
    scope: &KnowledgeSearchScope,
) -> Result<AllowedRecords> {
    let heads = knowledge::scoped_enabled_heads_in_tx(tx, ctx, scope).await?;
    let long_sources = retrieval::long_platform_source_ids_in_tx(tx, &ctx.space_id).await?;
    let table_sources: BTreeSet<_> = heads
        .iter()
        .filter(|head| head.kind == "table")
        .filter_map(|head| head.source_id.as_deref())
        .collect();
    let sources = ingestion::readable_source_heads_in_tx(tx, &ctx.space_id)
        .await?
        .into_iter()
        .filter(|(id, _)| {
            long_sources.contains(id)
                && ctx.can_read_platform_source(id)
                && (scope.is_unscoped() || table_sources.contains(id.as_str()))
                && gate.is_none_or(|g| g.member("platform", id))
        })
        .map(|(id, _)| ("platform".into(), id))
        .collect();
    let knowledge_ids = heads
        .into_iter()
        .filter(|head| {
            gate.is_none_or(|gate| {
                gate.permits(
                    &head.kind,
                    &head.id,
                    head.source_id.as_deref(),
                    head.table_id.as_deref(),
                )
            })
        })
        .map(|head| head.id)
        .collect();
    Ok(AllowedRecords {
        knowledge_ids,
        sources,
    })
}

/// 限制声明由本次真实消息绑定；继承原限制时保留原身份。
pub(super) async fn bind_update_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
    message_id: &str,
    user_supplied: bool,
    input: &mut Value,
) -> Result<()> {
    if input["action"] == "route" {
        return Ok(());
    }
    let action = input["action"]
        .as_str()
        .ok_or(crate::types::Error::new("invalid_input"))?;
    let task = input["task_id"].as_str().map(str::to_owned);
    let inherit = action == "split" && input["conditions"]["source_limits"].is_null();
    if !user_supplied && items(&input["condition_patch"]["unset"]).contains(&json!("source_limits"))
    {
        return Err(Error::new("invalid_evidence"));
    }
    let fields = if matches!(action, "create" | "split") || task.is_none() {
        &mut input["conditions"]
    } else {
        &mut input["condition_patch"]["set"]
    };
    if !inherit && !fields["source_limits"].is_object() {
        return Ok(());
    }
    let limit = &mut fields["source_limits"];
    if inherit || !user_supplied {
        let code = if inherit {
            "task_context_required"
        } else {
            "invalid_evidence"
        };
        let task = task.as_deref().ok_or(Error::new(code))?;
        *limit = analysis::declared_source_limits_in_tx(tx, cid, task)
            .await?
            .filter(|old| inherit || old["allowed_sources"] == limit["allowed_sources"])
            .ok_or(Error::new(code))?;
    }
    if user_supplied && limit.is_object() {
        limit["origin_message_ids"] = json!([message_id]);
    }
    Ok(())
}

pub(super) fn gate_from_contract(limits: &Value) -> Result<SourceGate> {
    let limits: SourceLimits = contracts::decode("SourceLimits", limits.clone())?;
    Ok(SourceGate(limits.allowed_sources))
}

#[cfg(test)]
#[path = "source_limits/tests/behavior.rs"]
mod tests;

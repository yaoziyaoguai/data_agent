use crate::{
    contracts,
    modules::{
        conversations,
        knowledge::dependency_index::{ContributionRoots, contribution_roots_in_tx},
    },
    persistence::AppTx,
    types::{Error, Result, epoch},
};
use serde_json::{Value, json};

// 本轮消息绑定任务声明的来源允许集。None表示本轮未声明限制：不设门，
// 共享定义与无限制浏览行为不变（限制是独立于检索范围的来源允许层，
// 不进KnowledgeSearchScope——scope描述去哪找，gate裁决能不能作为依据交付）。
pub(super) struct SourceGate {
    allowed: Vec<(String, String)>,
    limits: Value,
}

impl SourceGate {
    fn member(&self, kind: &str, id: &str) -> bool {
        self.allowed.iter().any(|(k, i)| k == kind && i == id)
    }

    // read_source参数用稳定来源身份：document-前缀或平台source_id。
    pub fn allows_source_arg(&self, source_id: &str) -> bool {
        match source_id.strip_prefix("document-") {
            Some(id) => self.member("document", id),
            None => self.member("platform", source_id),
        }
    }

    pub fn assert_source_arg(&self, source_id: &str) -> Result<()> {
        if self.allows_source_arg(source_id) {
            Ok(())
        } else {
            Err(Error::new("source_not_allowed"))
        }
    }

    // 文档是允许来源时整体可读：限制跟稳定来源身份走，用户允许的是该文档
    // 当前修订的全部内容；其余对象按贡献根闭包判定。
    fn object_allowed(&self, object: &Value, roots: Option<&ContributionRoots>) -> bool {
        if object["kind"] == "document"
            && object["id"]
                .as_str()
                .is_some_and(|id| self.member("document", id))
        {
            return true;
        }
        // 空根是独立人工内容，不因“空集是任意集合子集”放行；unknown非空
        // 按闭包不完整拒绝；可核验且完整时须全部落在允许集内。
        roots.is_some_and(|roots| {
            roots.unknown.is_empty()
                && !roots.sources.is_empty()
                && roots.sources.iter().all(|(kind, id)| self.member(kind, id))
        })
    }

    fn roots_of(object: &Value) -> Option<(String, u64)> {
        Some((
            object["id"].as_str()?.to_owned(),
            epoch(object["version"].as_str()?).ok()?,
        ))
    }

    pub async fn allows_object_in_tx(&self, tx: &mut AppTx<'_>, object: &Value) -> Result<bool> {
        let Some(root) = Self::roots_of(object) else {
            return Ok(false);
        };
        let roots = contribution_roots_in_tx(tx, &[root]).await?;
        Ok(self.object_allowed(object, roots.first()))
    }

    pub async fn assert_object_in_tx(&self, tx: &mut AppTx<'_>, object: &Value) -> Result<()> {
        if self.allows_object_in_tx(tx, object).await? {
            Ok(())
        } else {
            Err(Error::new("source_not_allowed"))
        }
    }

    // 检索候选批量判定：一次闭包查询摊平全部候选的贡献根，返回保留的下标
    // 与被过滤数量。身份或版本读不出的候选按不可判据处理。
    pub async fn filter_objects_in_tx(
        &self,
        tx: &mut AppTx<'_>,
        objects: &[Value],
    ) -> Result<(Vec<usize>, usize)> {
        let roots = objects
            .iter()
            .filter_map(Self::roots_of)
            .collect::<Vec<_>>();
        let resolved = if roots.is_empty() {
            Vec::new()
        } else {
            contribution_roots_in_tx(tx, &roots).await?
        };
        let mut kept = Vec::new();
        let mut filtered = 0usize;
        for (index, object) in objects.iter().enumerate() {
            let own = Self::roots_of(object)
                .and_then(|(id, _)| resolved.iter().find(|roots| roots.owner_id == id));
            if self.object_allowed(object, own) {
                kept.push(index);
            } else {
                filtered += 1;
            }
        }
        Ok((kept, filtered))
    }

    pub fn receipt(&self, filtered_candidates: usize) -> Value {
        json!({
            "allowed_sources": self.limits["allowed_sources"],
            "filtered_candidates": filtered_candidates,
        })
    }
}

// 解析本轮消息生效的来源限制。门只跟“本题”走：恰好绑定一个任务且该任务
// 当前条件显式声明source_limits时生效；绑定多个任务而任一声明限制时，
// 限制归属未定（不同来源限制不取并集），受限读取按未确定目标拒绝。
pub(super) async fn resolve_in_tx(
    tx: &mut AppTx<'_>,
    locked: &conversations::LockedConversation,
    message_id: &str,
) -> Result<Option<SourceGate>> {
    let tasks = conversations::message_task_ids_in_tx(tx, locked, message_id).await?;
    let mut declared: Vec<Value> = Vec::new();
    for task in &tasks {
        let body: Option<sqlx::types::Json<Value>> = sqlx::query_scalar(
            "SELECT c.body FROM condition_revisions c \
                 JOIN analysis_tasks t ON t.id=c.task_id AND t.condition_version=c.version \
                 WHERE t.conversation_id=? AND t.id=?",
        )
        .bind(&locked.id)
        .bind(task)
        .fetch_optional(tx.connection())
        .await?;
        // 缺失与显式null都不构成声明；只有非空对象才是本轮生效的允许集。
        let limits = body
            .map(|v| v.0)
            .and_then(|body| body.get("source_limits").cloned())
            .filter(|v| v.is_object());
        if let Some(limits) = limits {
            contracts::validate("SourceLimits", &limits)?;
            declared.push(limits);
        }
    }
    match (declared.len(), tasks.len()) {
        (0, _) => Ok(None),
        (1, 1) => Ok(Some(gate_of(&declared[0])?)),
        _ => Err(Error::new("task_context_required")),
    }
}

// 正式草稿的门跟草稿所属任务走：request_query显式携带task_id且版本已核对当前，
// 限制按该任务当前条件解析，不按消息绑定集（消息绑定的可能是另一个无限制任务）。
pub(super) async fn resolve_for_task_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
    task_id: &str,
) -> Result<Option<SourceGate>> {
    let body: Option<sqlx::types::Json<Value>> = sqlx::query_scalar(
        "SELECT c.body FROM condition_revisions c \
             JOIN analysis_tasks t ON t.id=c.task_id AND t.condition_version=c.version \
             WHERE t.conversation_id=? AND t.id=?",
    )
    .bind(cid)
    .bind(task_id)
    .fetch_optional(tx.connection())
    .await?;
    let Some(limits) = body
        .map(|v| v.0)
        .and_then(|body| body.get("source_limits").cloned())
        .filter(|v| v.is_object())
    else {
        return Ok(None);
    };
    Ok(Some(gate_of(&limits)?))
}

// 合同SourceLimits值构造门（06交付层与门控集成测试共用；消息内解析仍走
// resolve_in_tx）。
pub(super) fn gate_from_contract(limits: &Value) -> Result<SourceGate> {
    gate_of(limits)
}

fn gate_of(limits: &Value) -> Result<SourceGate> {
    contracts::validate("SourceLimits", limits)?;
    let allowed = limits["allowed_sources"]
        .as_array()
        .expect("validated limits")
        .iter()
        .filter_map(|key| {
            Some((
                key["kind"].as_str()?.to_owned(),
                key["id"].as_str()?.to_owned(),
            ))
        })
        .collect::<Vec<_>>();
    Ok(SourceGate {
        allowed,
        limits: limits.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::knowledge::dependency_index::ContributionRoots;
    use serde_json::json;

    fn gate(kinds: &[(&str, &str)]) -> SourceGate {
        let limits = json!({"allowed_sources": kinds
            .iter()
            .map(|(kind, id)| json!({"kind": kind, "id": id}))
            .collect::<Vec<_>>(),
            "origin_message_ids": ["m1"]});
        gate_of(&limits).expect("valid limits")
    }

    fn roots(sources: &[(&str, &str)], unknown: &[(&str, u64)]) -> ContributionRoots {
        ContributionRoots {
            owner_id: "obj".into(),
            owner_version: 1,
            sources: sources
                .iter()
                .map(|(k, i)| (k.to_string(), i.to_string()))
                .collect(),
            unknown: unknown.iter().map(|(k, v)| (k.to_string(), *v)).collect(),
        }
    }

    fn object(kind: &str, id: &str) -> Value {
        json!({"id": id, "kind": kind, "version": "1"})
    }

    #[test]
    fn judgment_matrix_over_document_shortcut_empty_partial_and_unknown() {
        let gate = gate(&[("document", "a"), ("platform", "p")]);
        // 文档按稳定身份整体放行：限制跟来源身份走，不逐条目判根。
        assert!(gate.object_allowed(&object("document", "a"), None));
        assert!(!gate.object_allowed(&object("document", "b"), None));
        // 完整可核验且全在允许集内才放行。
        assert!(gate.object_allowed(
            &object("metric", "m"),
            Some(&roots(&[("platform", "p")], &[]))
        ));
        // 传递根部分在允许集外：不因主根在允许集而放行。
        assert!(!gate.object_allowed(
            &object("metric", "m"),
            Some(&roots(&[("platform", "p"), ("platform", "q")], &[]))
        ));
        // 空根是独立人工内容，不能当任意集合的子集放行。
        assert!(!gate.object_allowed(&object("metric", "m"), Some(&roots(&[], &[]))));
        // unknown非空按闭包不完整拒绝，即使已知部分全在允许集内。
        assert!(!gate.object_allowed(
            &object("metric", "m"),
            Some(&roots(&[("platform", "p")], &[("unmapped", 2)]))
        ));
        // 无根可查（读不出身份或不在结果集）同样不放行。
        assert!(!gate.object_allowed(&object("metric", "m"), None));
    }

    #[test]
    fn source_arg_membership_strips_document_prefix() {
        let gate = gate(&[("document", "a"), ("platform", "business-guide")]);
        assert!(gate.allows_source_arg("document-a"));
        assert!(gate.allows_source_arg("business-guide"));
        assert!(!gate.allows_source_arg("document-b"));
        assert!(!gate.allows_source_arg("other"));
    }
}

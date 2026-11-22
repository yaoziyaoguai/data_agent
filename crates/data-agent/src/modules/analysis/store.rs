use super::decisions::{
    ConditionRevision, DecisionStateVersion, LegacyDecisionMigration, normalized_adoption,
};
use super::{
    AnalysisUpdateDialect, AnalysisUpdateRequest, clarification_preview_for_task_in_tx,
    condition_revision_in_tx, read_task_in_tx,
};
use crate::{
    persistence::AppTx,
    types::{Error, Result, epoch, id},
};
use serde_json::{Value, json};
use sqlx::Row;

pub async fn begin_lifecycle_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &crate::types::AccessContext,
    operation: &str,
    input: &Value,
) -> Result<Option<Value>> {
    crate::persistence::receipts::Operation::new(ctx, "task_lifecycle", operation, input)
        .begin(tx)
        .await
}

pub async fn record_lifecycle_receipt_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &crate::types::AccessContext,
    operation: &str,
    input: &Value,
    receipt: &Value,
) -> Result<()> {
    crate::persistence::receipts::Operation::new(ctx, "task_lifecycle", operation, input)
        .complete(tx, receipt)
        .await
}

pub struct LockedTasks {
    conversation_id: String,
    transaction_id: String,
}
impl LockedTasks {
    pub(super) fn assert_transaction(&self, tx: &AppTx<'_>) -> Result<()> {
        tx.assert_snapshot(&self.transaction_id)
    }
    pub(super) fn conversation_id(&self) -> &str {
        &self.conversation_id
    }
}
pub async fn lock_tasks_in_tx(tx: &mut AppTx<'_>, cid: &str) -> Result<LockedTasks> {
    tx.lock_rank(4)?;
    sqlx::query("SELECT id FROM analysis_tasks WHERE conversation_id=? ORDER BY id FOR UPDATE")
        .bind(cid)
        .fetch_all(tx.connection())
        .await?;
    Ok(LockedTasks {
        conversation_id: cid.into(),
        transaction_id: tx.id().into(),
    })
}
pub async fn create_task_in_tx(
    tx: &mut AppTx<'_>,
    tasks: &LockedTasks,
    owner: &str,
    operation: &str,
    goal: &str,
) -> Result<Value> {
    tx.assert_snapshot(&tasks.transaction_id)?;
    let task_id = id();
    sqlx::query("INSERT INTO analysis_tasks(id,conversation_id,owner_id,operation_id,goal,goal_condition_version) VALUES(?,?,?,?,?,1)").bind(&task_id).bind(&tasks.conversation_id).bind(owner).bind(operation).bind(goal).execute(tx.connection()).await?;
    Ok(json!({"operation_id":operation,"task_id":task_id,"condition_version":"1","state":"active"}))
}
async fn split_task_in_tx(
    tx: &mut AppTx<'_>,
    tasks: &LockedTasks,
    owner: &str,
    operation: &str,
    input: &Value,
) -> Result<Value> {
    let source = input["task_id"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?;
    let row = sqlx::query("SELECT condition_version,lifecycle,phase FROM analysis_tasks WHERE id=? AND conversation_id=? AND owner_id=?")
        .bind(source).bind(&tasks.conversation_id).bind(owner)
        .fetch_optional(tx.connection()).await?.ok_or(Error::new("not_available"))?;
    let version = row.get::<u64, _>("condition_version");
    assert_task_state(
        version,
        epoch(input["expected_version"].as_str().unwrap_or(""))?,
        &row.get::<String, _>("lifecycle"),
        "",
        false,
    )?;
    let mut conditions = input["conditions"].clone();
    if let Some(resolution) = conditions.get_mut("semantic_resolution") {
        *resolution = normalized_adoption(resolution)?;
    }
    crate::contracts::validate("Conditions", &conditions)?;
    let goal = input["goal"]
        .as_str()
        .filter(|goal| !goal.trim().is_empty())
        .ok_or(Error::new("invalid_input"))?;
    let previous = condition_revision_in_tx(tx, &tasks.conversation_id, source, version).await?;
    if previous.legacy_pending(version)?.is_some() {
        return Err(Error::new("clarification_required"));
    }
    let created = create_task_in_tx(tx, tasks, owner, operation, goal).await?;
    let target = created["task_id"].as_str().expect("created task");
    sqlx::query(
        "INSERT INTO condition_revisions(task_id,version,body,decision_state_version) VALUES(?,1,?,2)",
    )
    .bind(target)
    .bind(sqlx::types::Json(&conditions))
    .execute(tx.connection())
    .await?;
    let moved = input["moved_clarification_ids"]
        .as_array()
        .ok_or(Error::new("invalid_input"))?;
    for clarification in moved {
        let question = clarification.as_str().ok_or(Error::new("invalid_input"))?;
        // 仅迁移指定开放题的归属；ID、问题、选项和生成来源原样保留，既有查询不迁移。
        let updated = sqlx::query("UPDATE clarifications SET task_id=?,condition_version=1 WHERE id=? AND conversation_id=? AND task_id=? AND state='open'")
            .bind(target).bind(question).bind(&tasks.conversation_id).bind(source)
            .execute(tx.connection()).await?;
        if updated.rows_affected() != 1 {
            return Err(Error::new("clarification_not_open"));
        }
    }
    let (clarification, has_more_clarifications) =
        clarification_preview_for_task_in_tx(tx, target).await?;
    let phase = if clarification.is_some() {
        "waiting_clarification"
    } else {
        "investigating"
    };
    let (remaining, _) = clarification_preview_for_task_in_tx(tx, source).await?;
    let previous_phase = row.get::<String, _>("phase");
    let source_phase = if remaining.is_some() {
        "waiting_clarification"
    } else if previous_phase == "waiting_clarification" {
        "investigating"
    } else {
        &previous_phase
    };
    set_phase_in_tx(tx, target, 1, phase).await?;
    set_phase_in_tx(tx, source, version, source_phase).await?;
    Ok(
        json!({"task_id":target,"condition_version":"1","state":"active","phase":phase,
        "conditions":conditions,"decision_state_version":2,"question":null,"options":[],"clarification":clarification,
        "has_more_clarifications":has_more_clarifications,"opened_clarification":null,"opened_clarifications":[],
        "source_task_id":source,"source_condition_version":version.to_string(),"source_phase":source_phase,
        "moved_clarification_ids":moved}),
    )
}

#[allow(clippy::too_many_arguments)]
async fn migrate_legacy_decisions_in_tx(
    tx: &mut AppTx<'_>,
    tasks: &LockedTasks,
    input: &Value,
    previous: &ConditionRevision,
    revised: &mut ConditionRevision,
    migration: &LegacyDecisionMigration,
    new_version: u64,
) -> Result<Vec<Value>> {
    if previous.decision_state != DecisionStateVersion::Legacy
        || epoch(&migration.request.from_condition_version)? != new_version - 1
    {
        return Err(Error::new("version_conflict"));
    }
    let pending = previous.legacy_pending(new_version - 1)?;
    let items = pending
        .as_ref()
        .and_then(|pending| pending["items"].as_array());
    let task = input["task_id"].as_str().expect("revise task");
    let mut linked = std::collections::HashSet::new();
    let mut historical_adoptions = Vec::new();
    for link in &migration.request.links {
        let index = link.pending_index as usize;
        if items.and_then(|items| items.get(index)).is_none() || !linked.insert(index) {
            return Err(Error::new("invalid_evidence"));
        }
        let state: String = sqlx::query_scalar(
            "SELECT state FROM clarifications WHERE id=? AND conversation_id=? AND task_id=?",
        )
        .bind(&link.clarification_id)
        .bind(&tasks.conversation_id)
        .bind(task)
        .fetch_optional(tx.connection())
        .await?
        .ok_or(Error::new("not_available"))?;
        if state == "open" {
            continue;
        }
        if state != "resolved" {
            return Err(Error::new("clarification_not_open"));
        }
        // 同次真实回答沿常规关闭入口；旧resolved须有实际条件回执，不能只认状态。
        let answered_now = input["resolved_clarification_ids"]
            .as_array()
            .is_some_and(|ids| {
                ids.iter()
                    .any(|id| id.as_str() == Some(link.clarification_id.as_str()))
            });
        let mut proven = answered_now;
        if !proven
            && let (Some(version), Some(fields)) =
                (&link.resolution_condition_version, &link.condition_fields)
        {
            let version = epoch(version)?;
            if let Some(proof) = migration
                .proofs
                .iter()
                .find(|proof| proof.condition_version == version && proof.user_supplied)
            {
                let original =
                    condition_revision_in_tx(tx, &tasks.conversation_id, task, version).await?;
                proven = original.body == proof.conditions;
                for field in fields {
                    let field = serde_json::to_value(field).expect("condition field");
                    let key = field.as_str().expect("condition field enum");
                    proven &= original.body.get(key).is_some()
                        && original.body.get(key) == revised.body.get(key);
                }
                if proven && let Some(adopted) = &proof.verified_adoption {
                    historical_adoptions.push(adopted.clone());
                }
            }
        }
        if !proven {
            sqlx::query("UPDATE clarifications SET state='open' WHERE id=?")
                .bind(&link.clarification_id)
                .execute(tx.connection())
                .await?;
        }
    }
    let mut questions = Vec::new();
    for (index, item) in items.into_iter().flatten().enumerate() {
        if !linked.contains(&index) {
            questions.push(json!({"question":item["text"],"options":[]}));
        }
    }
    let changed_adoption = input["condition_patch"]["set"]
        .get("semantic_resolution")
        .is_some()
        || input["condition_patch"]["unset"]
            .as_array()
            .is_some_and(|keys| keys.contains(&json!("semantic_resolution")));
    if changed_adoption || pending.is_none() {
        if let Some(resolution) = revised.body.get_mut("semantic_resolution") {
            *resolution = normalized_adoption(resolution)?;
            if resolution["basis"] == "explicit_user"
                && resolution["adoption_message_id"].as_str()
                    != Some(migration.current_message_id.as_str())
                && !historical_adoptions.contains(resolution)
            {
                return Err(Error::new("invalid_evidence"));
            }
        }
    } else {
        let mut original = previous.body["semantic_resolution"].clone();
        if let Some(object) = original.as_object_mut() {
            object.remove("unresolved_differences");
        }
        let original = normalized_adoption(&original).unwrap_or(Value::Null);
        let verified = historical_adoptions.iter().find(|adopted| {
            let mut candidate = (*adopted).clone();
            if original["adoption_message_id"].is_null() && candidate["basis"] == "explicit_user" {
                candidate["adoption_message_id"] = Value::Null;
            }
            candidate == original
        });
        if let Some(adopted) = verified {
            revised.body["semantic_resolution"] = adopted.clone();
        } else {
            revised.body["semantic_resolution"] = Value::Null;
        }
    }
    revised.decision_state = DecisionStateVersion::Clarifications;
    Ok(questions)
}

pub async fn apply_update_in_tx(
    tx: &mut AppTx<'_>,
    tasks: &LockedTasks,
    owner: &str,
    operation: &str,
    request: AnalysisUpdateRequest<'_>,
    migration: Option<&LegacyDecisionMigration>,
) -> Result<Value> {
    let input = request.arguments;
    let dialect = request.dialect;
    tx.assert_snapshot(&tasks.transaction_id)?;
    let mut questions = clarification_inputs(input)?;
    if input["action"] == "split" {
        if !questions.is_empty() {
            return Err(Error::new("invalid_input"));
        }
        return split_task_in_tx(tx, tasks, owner, operation, input).await;
    }
    if input["action"] == "clarify" && questions.is_empty() {
        return Err(Error::new("invalid_input"));
    }
    if input["action"] == "route" {
        if let Some(task) = input["task_id"].as_str() {
            let current = read_task_in_tx(tx, &tasks.conversation_id, task).await?;
            assert_task_state(
                epoch(current["condition_version"].as_str().unwrap_or("0"))?,
                epoch(input["expected_version"].as_str().unwrap_or("0"))?,
                current["lifecycle"].as_str().unwrap_or(""),
                current["phase"].as_str().unwrap_or(""),
                false,
            )?;
            if input["replaces_query_id"].is_string() {
                assert_current_in_tx(
                    tx,
                    &tasks.conversation_id,
                    task,
                    epoch(input["expected_version"].as_str().unwrap_or("0"))?,
                )
                .await?;
            }
            return Ok(
                json!({"routed":true,"task_id":task,"condition_version":current["condition_version"]}),
            );
        }
        return Ok(json!({"routed":true,"task_id":input["task_id"]}));
    }
    let mut conditions = input["conditions"].clone();
    let mut decision_state = if dialect == AnalysisUpdateDialect::Legacy {
        DecisionStateVersion::Legacy
    } else {
        DecisionStateVersion::Clarifications
    };
    let (task, version) = if input["action"] == "create" || input["task_id"].is_null() {
        if dialect == AnalysisUpdateDialect::Current
            && let Some(resolution) = conditions.get_mut("semantic_resolution")
        {
            *resolution = normalized_adoption(resolution)?;
        }
        crate::contracts::validate("Conditions", &conditions)?;
        if input["goal"].as_str().unwrap_or("").is_empty() {
            return Err(crate::types::Error::new("invalid_input"));
        }
        let v = create_task_in_tx(
            tx,
            tasks,
            owner,
            operation,
            input["goal"].as_str().unwrap_or(""),
        )
        .await?;
        (v["task_id"].as_str().unwrap_or("").to_string(), 1)
    } else {
        let task = input["task_id"].as_str().unwrap_or("");
        let row=sqlx::query("SELECT condition_version,lifecycle FROM analysis_tasks WHERE id=? AND conversation_id=? AND owner_id=?").bind(task).bind(&tasks.conversation_id).bind(owner).fetch_optional(tx.connection()).await?.ok_or(crate::types::Error::new("not_available"))?;
        let current = row.get::<u64, _>("condition_version");
        assert_task_state(
            current,
            epoch(input["expected_version"].as_str().unwrap_or(""))?,
            &row.get::<String, _>("lifecycle"),
            "",
            false,
        )?;
        crate::contracts::validate("ConditionPatch", &input["condition_patch"])?;
        let previous = condition_revision_in_tx(tx, &tasks.conversation_id, task, current).await?;
        conditions = previous.body.clone();
        // §6.1合同：unset省略即空集合，在本唯一入口规范化使用；
        // 显式数组仍清除指定字段，null由ConditionPatch合同拒绝。
        for key in input["condition_patch"]
            .get("unset")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let key = key.as_str().expect("validated path");
            if input["condition_patch"]["set"].get(key).is_some() {
                return Err(crate::types::Error::new("invalid_input"));
            }
            conditions[key] = match key {
                "group_by" | "filters" | "knowledge_refs" | "time_roles" => json!([]),
                "notes" => json!(""),
                _ => Value::Null,
            };
        }
        for (key, value) in input["condition_patch"]["set"]
            .as_object()
            .expect("validated patch")
        {
            conditions[key] = value.clone();
        }
        crate::contracts::validate("Conditions", &conditions)?;
        // 普通修订不代表已经回答；只解决本次明确引用且仍开放的问题。
        if let Some(resolved) = input["resolved_clarification_ids"].as_array() {
            for reference in resolved {
                let clarification_id = reference.as_str().ok_or(Error::new("invalid_input"))?;
                let state = sqlx::query_scalar::<_, String>(
                    "SELECT state FROM clarifications WHERE id=? AND task_id=? AND conversation_id=?",
                )
                .bind(clarification_id)
                .bind(task)
                .bind(&tasks.conversation_id)
                .fetch_optional(tx.connection())
                .await?
                .ok_or(Error::new("not_available"))?;
                if state != "open" {
                    return Err(Error::new("clarification_not_open"));
                }
                sqlx::query("UPDATE clarifications SET state='resolved' WHERE id=?")
                    .bind(clarification_id)
                    .execute(tx.connection())
                    .await?;
            }
        }
        let mut revision = ConditionRevision {
            body: conditions,
            decision_state: previous.decision_state,
        };
        if let Some(migration) = migration {
            questions.extend(
                migrate_legacy_decisions_in_tx(
                    tx,
                    tasks,
                    input,
                    &previous,
                    &mut revision,
                    migration,
                    current + 1,
                )
                .await?,
            );
        } else if dialect == AnalysisUpdateDialect::Current
            || previous.decision_state == DecisionStateVersion::Clarifications
        {
            if previous.legacy_pending(current)?.is_some() {
                if revision.body["semantic_resolution"] != previous.body["semantic_resolution"] {
                    return Err(Error::new("clarification_required"));
                }
            } else {
                if let Some(resolution) = revision.body.get_mut("semantic_resolution") {
                    *resolution = normalized_adoption(resolution)?;
                }
                revision.decision_state = DecisionStateVersion::Clarifications;
            }
        }
        conditions = revision.body;
        decision_state = revision.decision_state;
        (task.to_string(), current + 1)
    };
    sqlx::query(
        "INSERT INTO condition_revisions(task_id,version,body,decision_state_version) VALUES(?,?,?,?)",
    )
    .bind(&task)
    .bind(version)
    .bind(sqlx::types::Json(&conditions))
    .bind(decision_state.number())
    .execute(tx.connection())
    .await?;
    let mut opened_clarifications = Vec::new();
    let clarification_batch = id();
    for (index, question) in questions.into_iter().enumerate() {
        // 同一条件版本内保留提问顺序；转换遗留问题沿原说明来源，不重绑本轮来源。
        let clarification_id = format!("{clarification_batch}-{index}");
        sqlx::query("INSERT INTO clarifications(id,conversation_id,task_id,condition_version,question,options) VALUES(?,?,?,?,?,?)").bind(&clarification_id).bind(&tasks.conversation_id).bind(&task).bind(version).bind(question["question"].as_str()).bind(sqlx::types::Json(&question["options"])).execute(tx.connection()).await?;
        opened_clarifications.push(json!({"id":clarification_id,"question":question["question"],"options":question["options"]}));
    }
    let opened_clarification = opened_clarifications.first().cloned();
    let (clarification, has_more_clarifications) =
        clarification_preview_for_task_in_tx(tx, &task).await?;
    let phase = if clarification.is_some() {
        "waiting_clarification"
    } else {
        "investigating"
    };
    sqlx::query(
        "UPDATE analysis_tasks SET condition_version=?,phase=?,goal_condition_version=IF(?<>'' AND BINARY goal<>BINARY ?,?,goal_condition_version),goal=IF(?='',goal,?) WHERE id=?",
    )
    .bind(version)
    .bind(phase)
    .bind(input["goal"].as_str().unwrap_or(""))
    .bind(input["goal"].as_str().unwrap_or(""))
    .bind(version)
    .bind(input["goal"].as_str().unwrap_or(""))
    .bind(input["goal"].as_str().unwrap_or(""))
    .bind(&task)
    .execute(tx.connection())
    .await?;
    Ok(
        json!({"task_id":task,"condition_version":version.to_string(),"state":"active","phase":phase,"decision_state_version":decision_state.number(),"conditions":conditions,"question":input["question"],"options":input["options"],"clarification":clarification,"has_more_clarifications":has_more_clarifications,"opened_clarification":opened_clarification,"opened_clarifications":opened_clarifications}),
    )
}
pub async fn assert_current_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
    task: &str,
    version: u64,
) -> Result<()> {
    assert_task_context_in_tx(tx, cid, task, version, true).await
}

// 资料调查只要求当前活动版本；开放问题不等于失去资料读取权，也不因读取自动解决。
pub async fn assert_read_context_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
    task: &str,
    version: u64,
) -> Result<()> {
    assert_task_context_in_tx(tx, cid, task, version, false).await
}

async fn assert_task_context_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
    task: &str,
    version: u64,
    requires_resolved: bool,
) -> Result<()> {
    let row=sqlx::query("SELECT condition_version,lifecycle,phase FROM analysis_tasks WHERE id=? AND conversation_id=?").bind(task).bind(cid).fetch_optional(tx.connection()).await?.ok_or(crate::types::Error::new("not_available"))?;
    assert_task_state(
        row.get::<u64, _>("condition_version"),
        version,
        &row.get::<String, _>("lifecycle"),
        &row.get::<String, _>("phase"),
        requires_resolved,
    )
}

fn assert_task_state(
    current: u64,
    expected: u64,
    lifecycle: &str,
    phase: &str,
    requires_resolved: bool,
) -> Result<()> {
    if current != expected {
        return Err(Error::new("version_conflict"));
    }
    if lifecycle != "active" {
        return Err(Error::new("task_inactive"));
    }
    if requires_resolved && phase == "waiting_clarification" {
        return Err(Error::new("waiting_clarification"));
    }
    Ok(())
}

fn clarification_inputs(input: &Value) -> Result<Vec<Value>> {
    let mut questions = input["clarifications"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if let Some(question) = input["question"].as_str() {
        if !questions.is_empty() {
            return Err(Error::new("invalid_input"));
        }
        questions.push(json!({"question":question,"options":input["options"]}));
    }
    if questions.len() > 8
        || (input["action"] == "route" && !questions.is_empty())
        || questions.iter().any(|question| {
            question["question"]
                .as_str()
                .is_none_or(|text| text.trim().is_empty())
                || !question["options"].is_array()
        })
    {
        return Err(Error::new("invalid_input"));
    }
    Ok(questions)
}

/// 拒绝回执只带控制状态和问题身份；条件、来源正文仍通过正式读取入口校验。
pub async fn set_phase_in_tx(
    tx: &mut AppTx<'_>,
    task: &str,
    version: u64,
    phase: &str,
) -> Result<()> {
    sqlx::query("UPDATE analysis_tasks SET phase=? WHERE id=? AND condition_version=? AND lifecycle='active'").bind(phase).bind(task).bind(version).execute(tx.connection()).await?;
    Ok(())
}
pub async fn cancel_task_in_tx(tx: &mut AppTx<'_>, tasks: &LockedTasks, task: &str) -> Result<()> {
    tx.assert_snapshot(&tasks.transaction_id)?;
    let r = sqlx::query(
        "UPDATE analysis_tasks SET lifecycle='cancelled' WHERE id=? AND conversation_id=?",
    )
    .bind(task)
    .bind(&tasks.conversation_id)
    .execute(tx.connection())
    .await?;
    if r.rows_affected() == 0 {
        return Err(crate::types::Error::new("not_available"));
    }
    sqlx::query("UPDATE clarifications SET state='cancelled' WHERE task_id=? AND state='open'")
        .bind(task)
        .execute(tx.connection())
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_guards_distinguish_revision_lifecycle_and_unanswered_questions() {
        assert_eq!(
            assert_task_state(5, 4, "active", "waiting_clarification", true)
                .unwrap_err()
                .code,
            "version_conflict"
        );
        assert_eq!(
            assert_task_state(5, 5, "cancelled", "waiting_clarification", true)
                .unwrap_err()
                .code,
            "task_inactive"
        );
        assert_eq!(
            assert_task_state(5, 5, "active", "waiting_clarification", true)
                .unwrap_err()
                .code,
            "waiting_clarification"
        );
        assert!(assert_task_state(5, 5, "active", "waiting_clarification", false).is_ok());
        assert!(assert_task_state(5, 5, "active", "investigating", true).is_ok());
    }

    #[test]
    fn independent_questions_use_one_input_form_and_cannot_change_on_route() {
        let questions = json!([{"question":"采用哪个分母？","options":["订单","金额"]},{"question":"地区使用哪个时点？","options":["发生时","当前"]}]);
        assert_eq!(
            clarification_inputs(
                &json!({"action":"clarify","clarifications":questions,"options":[]})
            )
            .unwrap()
            .len(),
            2
        );
        assert!(clarification_inputs(&json!({"action":"clarify","question":"合并问题","clarifications":questions,"options":[]})).is_err());
        assert!(
            clarification_inputs(
                &json!({"action":"route","clarifications":questions,"options":[]})
            )
            .is_err()
        );
        assert!(clarification_inputs(&json!({"action":"clarify","clarifications":[{"question":"  ","options":[]}],"options":[]})).is_err());
    }
}

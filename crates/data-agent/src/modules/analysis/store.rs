use super::decisions::{
    ConditionRevision, DecisionStateVersion, LegacyDecisionMigration, normalized_adoption,
    same_adoption,
};
use super::{AnalysisUpdateDialect, AnalysisUpdateRequest};
use crate::{
    persistence::AppTx,
    types::{Error, Result, epoch, fingerprint, id},
};
use serde_json::{Value, json};
use sqlx::Row;

pub async fn lifecycle_receipt_in_tx(
    tx: &mut AppTx<'_>,
    owner: &str,
    operation: &str,
    input: &Value,
) -> Result<Option<Value>> {
    let row = sqlx::query("SELECT fingerprint,receipt FROM task_lifecycle_operations WHERE owner_id=? AND operation_id=?")
        .bind(owner).bind(operation).fetch_optional(tx.connection()).await?;
    if let Some(row) = row {
        if row.get::<String, _>("fingerprint") != fingerprint(input) {
            return Err(Error::new("idempotency_conflict"));
        }
        return Ok(Some(row.get::<sqlx::types::Json<Value>, _>("receipt").0));
    }
    Ok(None)
}

pub async fn record_lifecycle_receipt_in_tx(
    tx: &mut AppTx<'_>,
    owner: &str,
    operation: &str,
    input: &Value,
    receipt: &Value,
) -> Result<()> {
    let saved = sqlx::query("INSERT IGNORE INTO task_lifecycle_operations(owner_id,operation_id,fingerprint,receipt) VALUES(?,?,?,?)")
        .bind(owner).bind(operation).bind(fingerprint(input)).bind(sqlx::types::Json(receipt)).execute(tx.connection()).await?;
    if saved.rows_affected() == 0 {
        // 同一会话锁已串行化同载荷；这里只可能是另一会话抢占了相同操作身份。
        return Err(Error::new("idempotency_conflict"));
    }
    Ok(())
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
    authority: Option<&Value>,
) -> Result<Value> {
    tx.assert_snapshot(&tasks.transaction_id)?;
    let task_id = id();
    sqlx::query("INSERT INTO analysis_tasks(id,conversation_id,owner_id,operation_id,goal,goal_condition_version,goal_authority) VALUES(?,?,?,?,?,1,?)").bind(&task_id).bind(&tasks.conversation_id).bind(owner).bind(operation).bind(goal).bind(authority.map(sqlx::types::Json)).execute(tx.connection()).await?;
    Ok(json!({"operation_id":operation,"task_id":task_id,"condition_version":"1","state":"active"}))
}
pub async fn read_tasks_in_tx(tx: &mut AppTx<'_>, cid: &str) -> Result<Vec<Value>> {
    let rows = sqlx::query("SELECT * FROM analysis_tasks WHERE conversation_id=? ORDER BY id")
        .bind(cid)
        .fetch_all(tx.connection())
        .await?;
    let mut result = Vec::new();
    for row in rows {
        let task = row.get::<String, _>("id");
        let version = row.get::<u64, _>("condition_version");
        let refs = super::evidence::refs_in_tx(tx, cid, &task, version).await?;
        let mut snapshot = json!({"id":task,"goal":row.get::<String,_>("goal"),"condition_version":version.to_string(),"lifecycle":row.get::<String,_>("lifecycle"),"phase":row.get::<String,_>("phase"),"evidence_refs":refs});
        if let Some(reference) = super::report::report_ref_in_tx(tx, cid, &task).await? {
            snapshot["report_ref"] = reference;
        }
        result.push(snapshot);
    }
    Ok(result)
}

pub async fn context_in_tx(tx: &mut AppTx<'_>, cid: &str) -> Result<Vec<Value>> {
    let rows=sqlx::query("SELECT t.id,t.goal,t.condition_version,t.lifecycle,t.phase,c.body,c.field_authorities,c.decision_state_version FROM analysis_tasks t LEFT JOIN condition_revisions c ON t.id=c.task_id AND t.condition_version=c.version WHERE t.conversation_id=? ORDER BY t.id").bind(cid).fetch_all(tx.connection()).await?;
    let mut result = Vec::new();
    for r in rows {
        let task = r.get::<String, _>("id");
        let refs =
            super::evidence::refs_in_tx(tx, cid, &task, r.get::<u64, _>("condition_version"))
                .await?;
        let (clarification, has_more_clarifications) =
            clarification_preview_in_tx(tx, &task).await?;
        let mut snapshot = json!({"id":task,"goal":r.get::<String,_>("goal"),"condition_version":r.get::<u64,_>("condition_version").to_string(),"lifecycle":r.get::<String,_>("lifecycle"),"phase":r.get::<String,_>("phase"),"conditions":r.get::<Option<sqlx::types::Json<Value>>,_>("body").map(|v|v.0),"clarification":clarification,"has_more_clarifications":has_more_clarifications,"evidence_refs":refs});
        if let Some(body) = snapshot.get("conditions").filter(|body| !body.is_null()) {
            let revision = ConditionRevision::from_stored(
                body.clone(),
                r.get::<Option<sqlx::types::Json<Value>>, _>("field_authorities")
                    .map(|value| value.0)
                    .unwrap_or(Value::Null),
                r.get::<Option<u8>, _>("decision_state_version")
                    .expect("condition revision"),
            )?;
            snapshot["decision_state_version"] = json!(revision.decision_state.number());
            if let Some(pending) = revision.legacy_pending(r.get("condition_version"))? {
                snapshot["legacy_pending"] = pending;
            }
        }
        if has_more_clarifications {
            snapshot["context_complete"] = json!(false);
        }
        if let Some(reference) = super::report::report_ref_in_tx(tx, cid, &task).await? {
            snapshot["report_ref"] = reference;
        }
        result.push(snapshot);
    }
    Ok(result)
}

async fn clarification_preview_in_tx(
    tx: &mut AppTx<'_>,
    task: &str,
) -> Result<(Option<Value>, bool)> {
    // 只交付首题正文，但保留省略信号，避免把未答问题预览当作全集。
    let rows = sqlx::query("SELECT id,question,options FROM clarifications WHERE task_id=? AND state='open' ORDER BY condition_version,id LIMIT 2")
        .bind(task).fetch_all(tx.connection()).await?;
    let first = rows.first().map(|value| {
        json!({"id":value.get::<String,_>("id"),"question":value.get::<String,_>("question"),"options":value.get::<sqlx::types::Json<Value>,_>("options").0})
    });
    Ok((first, rows.len() > 1))
}

/// 宿主最终交付使用的可见澄清预览；与任务卡读取同一首题和省略信号。
pub async fn clarification_preview_for_task_in_tx(
    tx: &mut AppTx<'_>,
    task: &str,
) -> Result<(Option<Value>, bool)> {
    clarification_preview_in_tx(tx, task).await
}

pub struct TaskTextAuthority {
    pub generated: Value,
    pub goal: Value,
    pub cleared: Value,
}

fn empty_condition(value: &Value) -> bool {
    value.is_null()
        || value.as_str().is_some_and(str::is_empty)
        || value.as_array().is_some_and(Vec::is_empty)
}

async fn split_task_in_tx(
    tx: &mut AppTx<'_>,
    tasks: &LockedTasks,
    owner: &str,
    operation: &str,
    input: &Value,
    authority: &TaskTextAuthority,
) -> Result<Value> {
    let source = input["task_id"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?;
    let row = sqlx::query("SELECT condition_version,lifecycle,phase,goal,goal_authority FROM analysis_tasks WHERE id=? AND conversation_id=? AND owner_id=?")
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
    let original = previous.body;
    let original_authorities = previous.field_authorities;
    let mut field_authorities = json!({});
    for (key, value) in conditions.as_object().expect("validated conditions") {
        // 拆分复制已知条件时保留原来源；新目标不能通过同文复制解除旧资料约束。
        field_authorities[key] = if key == "source_limits" || empty_condition(value) {
            authority.cleared.clone()
        } else if original[key] == *value
            || (key == "semantic_resolution" && same_adoption(&original[key], value))
        {
            original_authorities[key].clone()
        } else {
            authority.generated.clone()
        };
    }
    let goal_authority = if row.get::<String, _>("goal") == goal {
        row.get::<Option<sqlx::types::Json<Value>>, _>("goal_authority")
            .map(|value| value.0)
            .unwrap_or(Value::Null)
    } else {
        authority.goal.clone()
    };
    let created =
        create_task_in_tx(tx, tasks, owner, operation, goal, Some(&goal_authority)).await?;
    let target = created["task_id"].as_str().expect("created task");
    sqlx::query(
        "INSERT INTO condition_revisions(task_id,version,body,field_authorities,decision_state_version) VALUES(?,1,?,?,2)",
    )
    .bind(target)
    .bind(sqlx::types::Json(&conditions))
    .bind(sqlx::types::Json(&field_authorities))
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
    let (clarification, has_more_clarifications) = clarification_preview_in_tx(tx, target).await?;
    let phase = if clarification.is_some() {
        "waiting_clarification"
    } else {
        "investigating"
    };
    let (remaining, _) = clarification_preview_in_tx(tx, source).await?;
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
    cleared_authority: &Value,
) -> Result<Vec<(Value, Value)>> {
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
                        && original.body.get(key) == revised.body.get(key)
                        && original.field_authorities[key].is_object()
                        && original.field_authorities[key] == revised.field_authorities[key];
                }
                if proven
                    && original.field_authorities["semantic_resolution"].is_object()
                    && let Some(adopted) = &proof.verified_adoption
                {
                    historical_adoptions.push((
                        adopted.clone(),
                        original.field_authorities["semantic_resolution"].clone(),
                    ));
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
            questions.push((
                json!({"question":item["text"],"options":[]}),
                previous.field_authorities["semantic_resolution"].clone(),
            ));
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
            {
                let (_, authority) = historical_adoptions
                    .iter()
                    .find(|(adopted, _)| adopted == resolution)
                    .ok_or(Error::new("invalid_evidence"))?;
                revised.field_authorities["semantic_resolution"] = authority.clone();
            }
        }
    } else {
        let mut original = previous.body["semantic_resolution"].clone();
        if let Some(object) = original.as_object_mut() {
            object.remove("unresolved_differences");
        }
        let original = normalized_adoption(&original).unwrap_or(Value::Null);
        let verified = historical_adoptions.iter().find(|(adopted, _)| {
            let mut candidate = adopted.clone();
            if original["adoption_message_id"].is_null() && candidate["basis"] == "explicit_user" {
                candidate["adoption_message_id"] = Value::Null;
            }
            candidate == original
        });
        if let Some((adopted, authority)) = verified {
            revised.body["semantic_resolution"] = adopted.clone();
            revised.field_authorities["semantic_resolution"] = authority.clone();
        } else {
            revised.body["semantic_resolution"] = Value::Null;
            revised.field_authorities["semantic_resolution"] = cleared_authority.clone();
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
    authority: &TaskTextAuthority,
    migration: Option<&LegacyDecisionMigration>,
) -> Result<Value> {
    let input = request.arguments;
    let dialect = request.dialect;
    tx.assert_snapshot(&tasks.transaction_id)?;
    let mut questions = clarification_inputs(input)?
        .into_iter()
        .map(|question| (question, authority.generated.clone()))
        .collect::<Vec<_>>();
    if input["action"] == "split" {
        if !questions.is_empty() {
            return Err(Error::new("invalid_input"));
        }
        return split_task_in_tx(tx, tasks, owner, operation, input, authority).await;
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
    let mut field_authorities = json!({});
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
        for (key, value) in conditions.as_object().expect("validated conditions") {
            field_authorities[key] = if key == "source_limits" || empty_condition(value) {
                authority.cleared.clone()
            } else {
                authority.generated.clone()
            };
        }
        let v = create_task_in_tx(
            tx,
            tasks,
            owner,
            operation,
            input["goal"].as_str().unwrap_or(""),
            Some(&authority.goal),
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
        field_authorities = previous.field_authorities.clone();
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
            field_authorities[key] = authority.cleared.clone();
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
            // 同文重传不能洗掉原来源；只有真实改值才绑定本轮已交付资料。
            if conditions[key] != *value
                && !(key == "semantic_resolution" && same_adoption(&conditions[key], value))
            {
                field_authorities[key] = if key == "source_limits" || empty_condition(value) {
                    authority.cleared.clone()
                } else {
                    authority.generated.clone()
                };
            }
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
            field_authorities,
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
                    &authority.cleared,
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
        field_authorities = revision.field_authorities;
        decision_state = revision.decision_state;
        (task.to_string(), current + 1)
    };
    sqlx::query(
        "INSERT INTO condition_revisions(task_id,version,body,field_authorities,decision_state_version) VALUES(?,?,?,?,?)",
    )
    .bind(&task)
    .bind(version)
    .bind(sqlx::types::Json(&conditions))
    .bind(sqlx::types::Json(&field_authorities))
    .bind(decision_state.number())
    .execute(tx.connection())
    .await?;
    let mut opened_clarifications = Vec::new();
    let clarification_batch = id();
    for (index, (question, question_authority)) in questions.into_iter().enumerate() {
        // 同一条件版本内保留提问顺序；转换遗留问题沿原说明来源，不重绑本轮来源。
        let clarification_id = format!("{clarification_batch}-{index}");
        sqlx::query("INSERT INTO clarifications(id,conversation_id,task_id,condition_version,question,options,text_authority) VALUES(?,?,?,?,?,?,?)").bind(&clarification_id).bind(&tasks.conversation_id).bind(&task).bind(version).bind(question["question"].as_str()).bind(sqlx::types::Json(&question["options"])).bind(sqlx::types::Json(&question_authority)).execute(tx.connection()).await?;
        opened_clarifications.push(json!({"id":clarification_id,"question":question["question"],"options":question["options"]}));
    }
    let opened_clarification = opened_clarifications.first().cloned();
    let (clarification, has_more_clarifications) = clarification_preview_in_tx(tx, &task).await?;
    let phase = if clarification.is_some() {
        "waiting_clarification"
    } else {
        "investigating"
    };
    sqlx::query(
        "UPDATE analysis_tasks SET condition_version=?,phase=?,goal_authority=IF(?<>'' AND BINARY goal<>BINARY ?,CAST(? AS JSON),goal_authority),goal_condition_version=IF(?<>'' AND BINARY goal<>BINARY ?,?,goal_condition_version),goal=IF(?='',goal,?) WHERE id=?",
    )
    .bind(version)
    .bind(phase)
    .bind(input["goal"].as_str().unwrap_or(""))
    .bind(input["goal"].as_str().unwrap_or(""))
    .bind(sqlx::types::Json(&authority.goal))
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
pub async fn recovery_state_in_tx(tx: &mut AppTx<'_>, cid: &str, task: &str) -> Result<Value> {
    let row = sqlx::query("SELECT condition_version,lifecycle,phase FROM analysis_tasks WHERE id=? AND conversation_id=?")
        .bind(task).bind(cid).fetch_optional(tx.connection()).await?
        .ok_or(Error::new("not_available"))?;
    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM clarifications WHERE task_id=? AND state='open' ORDER BY id LIMIT 9",
    )
    .bind(task)
    .fetch_all(tx.connection())
    .await?;
    Ok(json!({
        "task_id":task,
        "condition_version":row.get::<u64,_>("condition_version").to_string(),
        "lifecycle":row.get::<String,_>("lifecycle"),
        "phase":row.get::<String,_>("phase"),
        "open_clarification_ids":ids.iter().take(8).collect::<Vec<_>>(),
        "has_more_clarifications":ids.len()>8,
        "read_tool":{"name":"read_analysis_task","arguments":{"task_id":task}}
    }))
}

/// 正文来源由宿主传入并持久保存；NULL 表示升级前缺少完整来源，不能当空依赖。
pub async fn task_text_authorities_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
    task: &str,
) -> Result<Value> {
    let goal = sqlx::query_scalar::<_, Option<sqlx::types::Json<Value>>>(
        "SELECT goal_authority FROM analysis_tasks WHERE id=? AND conversation_id=?",
    )
    .bind(task)
    .bind(cid)
    .fetch_optional(tx.connection())
    .await?
    .ok_or(Error::new("not_available"))?;
    let rows = sqlx::query(
        "SELECT id,text_authority FROM clarifications WHERE task_id=? AND conversation_id=?",
    )
    .bind(task)
    .bind(cid)
    .fetch_all(tx.connection())
    .await?;
    let questions = rows
        .into_iter()
        .map(|row| {
            (
                row.get::<String, _>("id"),
                row.get::<Option<sqlx::types::Json<Value>>, _>("text_authority")
                    .map(|v| v.0)
                    .unwrap_or(Value::Null),
            )
        })
        .collect::<serde_json::Map<_, _>>();
    Ok(json!({"goal":goal.map(|v|v.0),"clarifications":questions}))
}

pub async fn condition_text_authorities_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
    task: &str,
    version: u64,
) -> Result<Value> {
    Ok(sqlx::query_scalar::<_, Option<sqlx::types::Json<Value>>>(
        "SELECT c.field_authorities FROM condition_revisions c JOIN analysis_tasks t ON t.id=c.task_id WHERE t.conversation_id=? AND c.task_id=? AND c.version=?",
    ).bind(cid).bind(task).bind(version).fetch_optional(tx.connection()).await?.ok_or(Error::new("not_available"))?.map(|v|v.0).unwrap_or_else(||json!({})))
}

/// 仅投影外部结果引用，供 use_case 在取得业务锁之前预检平台授权。
pub async fn task_text_result_dependencies_in_tx(tx: &mut AppTx<'_>, cid: &str) -> Result<Value> {
    let rows = sqlx::query_scalar::<_, Option<sqlx::types::Json<Value>>>(
        "SELECT goal_authority FROM analysis_tasks WHERE conversation_id=? UNION ALL SELECT text_authority FROM clarifications WHERE conversation_id=?",
    ).bind(cid).bind(cid).fetch_all(tx.connection()).await?;
    let fields = sqlx::query_scalar::<_, Option<sqlx::types::Json<Value>>>(
        "SELECT c.field_authorities FROM condition_revisions c JOIN analysis_tasks t ON t.id=c.task_id WHERE t.conversation_id=?",
    ).bind(cid).fetch_all(tx.connection()).await?;
    let mut authorities = rows.into_iter().flatten().map(|v| v.0).collect::<Vec<_>>();
    for fields in fields.into_iter().flatten() {
        authorities.extend(
            fields
                .0
                .as_object()
                .into_iter()
                .flat_map(|fields| fields.values())
                .cloned(),
        );
    }
    let mut references = Vec::new();
    for authority in authorities {
        for kind in ["query_results", "source_query_results"] {
            for reference in authority[kind].as_array().into_iter().flatten() {
                if !references.contains(reference) {
                    references.push(reference.clone());
                }
            }
        }
    }
    Ok(json!(references))
}
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

pub async fn read_task_in_tx(tx: &mut AppTx<'_>, cid: &str, task: &str) -> Result<Value> {
    context_in_tx(tx, cid)
        .await?
        .into_iter()
        .find(|t| t["id"] == task)
        .ok_or(crate::types::Error::new("not_available"))
}

// 条件修订按会话归属读取正文、字段来源与宿主格式；读取不迁移旧版本。
pub async fn condition_revision_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
    task: &str,
    version: u64,
) -> Result<ConditionRevision> {
    let row = sqlx::query(
        "SELECT c.body,c.field_authorities,c.decision_state_version FROM condition_revisions c \
         JOIN analysis_tasks t ON t.id=c.task_id WHERE t.conversation_id=? AND c.task_id=? AND c.version=?",
    ).bind(cid).bind(task).bind(version).fetch_optional(tx.connection()).await?.ok_or(Error::new("not_available"))?;
    ConditionRevision::from_stored(
        row.get::<sqlx::types::Json<Value>, _>("body").0,
        row.get::<Option<sqlx::types::Json<Value>>, _>("field_authorities")
            .map(|value| value.0)
            .unwrap_or(Value::Null),
        row.get("decision_state_version"),
    )
}

pub async fn current_condition_revision_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
    task: &str,
) -> Result<Option<ConditionRevision>> {
    let row = sqlx::query(
        "SELECT c.body,c.field_authorities,c.decision_state_version FROM condition_revisions c \
         JOIN analysis_tasks t ON t.id=c.task_id AND t.condition_version=c.version WHERE t.conversation_id=? AND t.id=?",
    ).bind(cid).bind(task).fetch_optional(tx.connection()).await?;
    row.map(|row| {
        ConditionRevision::from_stored(
            row.get::<sqlx::types::Json<Value>, _>("body").0,
            row.get::<Option<sqlx::types::Json<Value>>, _>("field_authorities")
                .map(|value| value.0)
                .unwrap_or(Value::Null),
            row.get("decision_state_version"),
        )
    })
    .transpose()
}

/// 原修订里最后一次明确保存的范围；缺字段与显式null保持不同含义。
pub async fn declared_source_limits_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
    task: &str,
) -> Result<Option<Value>> {
    source_limits_at_version_in_tx(tx, cid, task, u64::MAX).await
}

/// 未选定活动任务时，只有所有未取消任务均明确无限制才能继续普通调查。
pub async fn active_task_sources_unrestricted_in_tx(tx: &mut AppTx<'_>, cid: &str) -> Result<bool> {
    let needs_scope = sqlx::query_scalar::<_, i64>(
        "SELECT EXISTS(SELECT 1 FROM analysis_tasks t \
         LEFT JOIN condition_revisions c ON c.task_id=t.id AND c.version=(\
           SELECT MAX(v.version) FROM condition_revisions v \
           WHERE v.task_id=t.id AND v.version<=t.condition_version \
           AND JSON_CONTAINS_PATH(v.body,'one','$.source_limits')) \
         WHERE t.conversation_id=? AND t.lifecycle='active' AND \
         (c.task_id IS NULL OR JSON_TYPE(JSON_EXTRACT(c.body,'$.source_limits'))<>'NULL'))",
    )
    .bind(cid)
    .fetch_one(tx.connection())
    .await?;
    Ok(needs_scope == 0)
}

pub async fn source_limits_at_version_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
    task: &str,
    version: u64,
) -> Result<Option<Value>> {
    let body = sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
        "SELECT c.body FROM condition_revisions c JOIN analysis_tasks t ON t.id=c.task_id \
         WHERE t.conversation_id=? AND t.id=? AND c.version<=LEAST(t.condition_version,?) \
         AND JSON_CONTAINS_PATH(c.body,'one','$.source_limits') \
         ORDER BY c.version DESC LIMIT 1",
    )
    .bind(cid)
    .bind(task)
    .bind(version)
    .fetch_optional(tx.connection())
    .await?;
    Ok(body.and_then(|body| body.0.get("source_limits").cloned()))
}

pub async fn read_task_with_clarifications_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
    task: &str,
    after: Option<&str>,
    version: Option<u64>,
) -> Result<Value> {
    let mut snapshot = read_task_in_tx(tx, cid, task).await?;
    // 正式读取以本页问题和游标表达范围；正文来源保护在组装完成后继续执行。
    for key in ["has_more_clarifications", "context_complete"] {
        snapshot.as_object_mut().expect("task snapshot").remove(key);
    }
    let current_version = epoch(snapshot["condition_version"].as_str().unwrap_or("0"))?;
    let requested_version = version.unwrap_or(current_version);
    snapshot["current_condition_version"] = snapshot["condition_version"].clone();
    snapshot["is_historical"] = json!(requested_version != current_version);
    if requested_version != current_version {
        let revision = condition_revision_in_tx(tx, cid, task, requested_version).await?;
        snapshot["legacy_pending"] = revision
            .legacy_pending(requested_version)?
            .unwrap_or(Value::Null);
        if snapshot["legacy_pending"].is_null() {
            snapshot
                .as_object_mut()
                .expect("task snapshot")
                .remove("legacy_pending");
        }
        snapshot["decision_state_version"] = json!(revision.decision_state.number());
        snapshot["conditions"] = revision.body;
        snapshot["condition_version"] = json!(requested_version.to_string());
        snapshot["evidence_refs"] =
            json!(super::evidence::refs_in_tx(tx, cid, task, requested_version).await?);
        // 历史条件不能借当前任务文本带出另一个版本的资料；goal没有历史版本。
        for key in ["report_ref", "goal", "clarification"] {
            snapshot.as_object_mut().expect("task snapshot").remove(key);
        }
    }
    snapshot["note"] = json!(
        "conditions与evidence_refs属于所读condition_version；current_condition_version/lifecycle/phase为当前控制状态。历史读取仅带当前开放问题ID，不携当前目标、问题或选项正文；当前正文须另按当前版本读取并校验依据。历史条件只供调查和引用，不授予执行权。"
    );
    if let Some(cursor) = after {
        // 翻页期间问题可能已被回答，但游标仍须属于当前任务。
        sqlx::query_scalar::<_, String>(
            "SELECT id FROM clarifications WHERE id=? AND task_id=? AND conversation_id=?",
        )
        .bind(cursor)
        .bind(task)
        .bind(cid)
        .fetch_optional(tx.connection())
        .await?
        .ok_or(Error::new("not_available"))?;
    }
    let rows = sqlx::query("SELECT id,question,options FROM clarifications WHERE task_id=? AND state='open' AND (? IS NULL OR id>?) ORDER BY id LIMIT 9")
        .bind(task).bind(after).bind(after).fetch_all(tx.connection()).await?;
    let clarifications = rows.iter().take(8).map(|row| {
        json!({"id":row.get::<String,_>("id"),"question":row.get::<String,_>("question"),"options":row.get::<sqlx::types::Json<Value>,_>("options").0})
    }).collect::<Vec<_>>();
    snapshot["next_clarification_after"] = if rows.len() > 8 {
        clarifications.last().expect("bounded nonempty page")["id"].clone()
    } else {
        Value::Null
    };
    if requested_version == current_version {
        snapshot["open_clarifications"] = json!(clarifications);
    } else {
        snapshot["current_open_clarification_ids"] = json!(
            clarifications
                .iter()
                .map(|item| &item["id"])
                .collect::<Vec<_>>()
        );
    }
    Ok(snapshot)
}

pub async fn task_directory_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
    after: Option<&str>,
) -> Result<Value> {
    let rows=sqlx::query("SELECT id,goal,condition_version,lifecycle,phase FROM analysis_tasks WHERE conversation_id=? AND (? IS NULL OR id>?) ORDER BY id LIMIT 21")
       .bind(cid).bind(after).bind(after).fetch_all(tx.connection()).await?;
    let tasks=rows.iter().take(20).map(|r|json!({"id":r.get::<String,_>("id"),"goal":r.get::<String,_>("goal").chars().take(240).collect::<String>(),"condition_version":r.get::<u64,_>("condition_version").to_string(),"lifecycle":r.get::<String,_>("lifecycle"),"phase":r.get::<String,_>("phase")})).collect::<Vec<_>>();
    let next = if rows.len() > 20 {
        tasks.last().map(|v| v["id"].clone())
    } else {
        None
    };
    Ok(
        json!({"tasks":tasks,"next_task_after":next,"note":"仅目录摘要；按真实ID用read_analysis_task读取当前条件。该目录覆盖同一消息建立的多个任务。"}),
    )
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

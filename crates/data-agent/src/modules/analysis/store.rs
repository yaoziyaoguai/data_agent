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
    let rows=sqlx::query("SELECT t.id,t.goal,t.condition_version,t.lifecycle,t.phase,c.body FROM analysis_tasks t LEFT JOIN condition_revisions c ON t.id=c.task_id AND t.condition_version=c.version WHERE t.conversation_id=? ORDER BY t.id").bind(cid).fetch_all(tx.connection()).await?;
    let mut result = Vec::new();
    for r in rows {
        let task = r.get::<String, _>("id");
        let refs =
            super::evidence::refs_in_tx(tx, cid, &task, r.get::<u64, _>("condition_version"))
                .await?;
        let (clarification, has_more_clarifications) =
            clarification_preview_in_tx(tx, &task).await?;
        let mut snapshot = json!({"id":task,"goal":r.get::<String,_>("goal"),"condition_version":r.get::<u64,_>("condition_version").to_string(),"lifecycle":r.get::<String,_>("lifecycle"),"phase":r.get::<String,_>("phase"),"conditions":r.get::<Option<sqlx::types::Json<Value>>,_>("body").map(|v|v.0),"clarification":clarification,"has_more_clarifications":has_more_clarifications,"evidence_refs":refs});
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

pub async fn apply_update_in_tx(
    tx: &mut AppTx<'_>,
    tasks: &LockedTasks,
    owner: &str,
    operation: &str,
    input: &Value,
    authority: &TaskTextAuthority,
) -> Result<Value> {
    tx.assert_snapshot(&tasks.transaction_id)?;
    let questions = clarification_inputs(input)?;
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
    let (task, version) = if input["action"] == "create" || input["task_id"].is_null() {
        crate::contracts::validate("Conditions", &conditions)?;
        if input["goal"].as_str().unwrap_or("").is_empty() {
            return Err(crate::types::Error::new("invalid_input"));
        }
        for (key, value) in conditions.as_object().expect("validated conditions") {
            field_authorities[key] = if empty_condition(value) {
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
        conditions = sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
            "SELECT body FROM condition_revisions WHERE task_id=? AND version=?",
        )
        .bind(task)
        .bind(current)
        .fetch_one(tx.connection())
        .await?
        .0;
        field_authorities = sqlx::query_scalar::<_, Option<sqlx::types::Json<Value>>>(
            "SELECT field_authorities FROM condition_revisions WHERE task_id=? AND version=?",
        )
        .bind(task)
        .bind(current)
        .fetch_one(tx.connection())
        .await?
        .map(|v| v.0)
        .unwrap_or_else(|| json!({}));
        for key in input["condition_patch"]["unset"]
            .as_array()
            .expect("validated patch")
        {
            let key = key.as_str().expect("validated path");
            if input["condition_patch"]["set"].get(key).is_some() {
                return Err(crate::types::Error::new("invalid_input"));
            }
            field_authorities[key] = authority.cleared.clone();
            conditions[key] = match key {
                "group_by" | "filters" | "knowledge_refs" => json!([]),
                "notes" => json!(""),
                _ => Value::Null,
            };
        }
        for (key, value) in input["condition_patch"]["set"]
            .as_object()
            .expect("validated patch")
        {
            // 同文重传不能洗掉原来源；只有真实改值才绑定本轮已交付资料。
            if conditions[key] != *value {
                field_authorities[key] = if empty_condition(value) {
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
        (task.to_string(), current + 1)
    };
    sqlx::query(
        "INSERT INTO condition_revisions(task_id,version,body,field_authorities) VALUES(?,?,?,?)",
    )
    .bind(&task)
    .bind(version)
    .bind(sqlx::types::Json(&conditions))
    .bind(sqlx::types::Json(&field_authorities))
    .execute(tx.connection())
    .await?;
    let mut opened_clarifications = Vec::new();
    let clarification_batch = id();
    for (index, question) in questions.into_iter().enumerate() {
        // 同一条件版本内保留提问顺序，恢复摘要不能随机换成批次中的另一题。
        let clarification_id = format!("{clarification_batch}-{index}");
        sqlx::query("INSERT INTO clarifications(id,conversation_id,task_id,condition_version,question,options,text_authority) VALUES(?,?,?,?,?,?,?)").bind(&clarification_id).bind(&tasks.conversation_id).bind(&task).bind(version).bind(question["question"].as_str()).bind(sqlx::types::Json(&question["options"])).bind(sqlx::types::Json(&authority.generated)).execute(tx.connection()).await?;
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
        json!({"task_id":task,"condition_version":version.to_string(),"state":"active","phase":phase,"conditions":conditions,"question":input["question"],"options":input["options"],"clarification":clarification,"has_more_clarifications":has_more_clarifications,"opened_clarification":opened_clarification,"opened_clarifications":opened_clarifications}),
    )
}
pub async fn assert_current_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
    task: &str,
    version: u64,
) -> Result<()> {
    let row=sqlx::query("SELECT condition_version,lifecycle,phase FROM analysis_tasks WHERE id=? AND conversation_id=?").bind(task).bind(cid).fetch_optional(tx.connection()).await?.ok_or(crate::types::Error::new("not_available"))?;
    assert_task_state(
        row.get::<u64, _>("condition_version"),
        version,
        &row.get::<String, _>("lifecycle"),
        &row.get::<String, _>("phase"),
        true,
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
        let conditions = sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
            "SELECT body FROM condition_revisions WHERE task_id=? AND version=?",
        )
        .bind(task)
        .bind(requested_version)
        .fetch_optional(tx.connection())
        .await?
        .ok_or(Error::new("not_available"))?
        .0;
        snapshot["conditions"] = conditions;
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

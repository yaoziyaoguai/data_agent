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
) -> Result<Value> {
    tx.assert_snapshot(&tasks.transaction_id)?;
    let task_id = id();
    sqlx::query("INSERT INTO analysis_tasks(id,conversation_id,owner_id,operation_id,goal) VALUES(?,?,?,?,?)").bind(&task_id).bind(&tasks.conversation_id).bind(owner).bind(operation).bind(goal).execute(tx.connection()).await?;
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
        let clarification = first_open_clarification_in_tx(tx, &task).await?;
        let mut snapshot = json!({"id":task,"goal":r.get::<String,_>("goal"),"condition_version":r.get::<u64,_>("condition_version").to_string(),"lifecycle":r.get::<String,_>("lifecycle"),"phase":r.get::<String,_>("phase"),"conditions":r.get::<Option<sqlx::types::Json<Value>>,_>("body").map(|v|v.0),"clarification":clarification,"evidence_refs":refs});
        if let Some(reference) = super::report::report_ref_in_tx(tx, cid, &task).await? {
            snapshot["report_ref"] = reference;
        }
        result.push(snapshot);
    }
    Ok(result)
}

async fn first_open_clarification_in_tx(tx: &mut AppTx<'_>, task: &str) -> Result<Option<Value>> {
    let row = sqlx::query("SELECT id,question,options FROM clarifications WHERE task_id=? AND state='open' ORDER BY condition_version,id LIMIT 1")
        .bind(task).fetch_optional(tx.connection()).await?;
    Ok(row.map(|value| {
        json!({"id":value.get::<String,_>("id"),"question":value.get::<String,_>("question"),"options":value.get::<sqlx::types::Json<Value>,_>("options").0})
    }))
}

pub async fn apply_update_in_tx(
    tx: &mut AppTx<'_>,
    tasks: &LockedTasks,
    owner: &str,
    operation: &str,
    input: &Value,
) -> Result<Value> {
    tx.assert_snapshot(&tasks.transaction_id)?;
    if input["action"] == "clarify"
        && input["question"]
            .as_str()
            .is_none_or(|question| question.trim().is_empty())
    {
        return Err(Error::new("invalid_input"));
    }
    if input["action"] == "route" {
        if let Some(task) = input["task_id"].as_str() {
            let current = read_task_in_tx(tx, &tasks.conversation_id, task).await?;
            if current["condition_version"] != input["expected_version"]
                || current["lifecycle"] != "active"
            {
                return Err(crate::types::Error::new("version_conflict"));
            }
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
    let (task, version) = if input["action"] == "create" || input["task_id"].is_null() {
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
        if row.get::<String, _>("lifecycle") != "active" {
            return Err(crate::types::Error::new("version_conflict"));
        }
        let current = row.get::<u64, _>("condition_version");
        if epoch(input["expected_version"].as_str().unwrap_or(""))? != current {
            return Err(crate::types::Error::new("version_conflict"));
        }
        crate::contracts::validate("ConditionPatch", &input["condition_patch"])?;
        conditions = sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
            "SELECT body FROM condition_revisions WHERE task_id=? AND version=?",
        )
        .bind(task)
        .bind(current)
        .fetch_one(tx.connection())
        .await?
        .0;
        for key in input["condition_patch"]["unset"]
            .as_array()
            .expect("validated patch")
        {
            let key = key.as_str().expect("validated path");
            if input["condition_patch"]["set"].get(key).is_some() {
                return Err(crate::types::Error::new("invalid_input"));
            }
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
                    return Err(Error::new("version_conflict"));
                }
                sqlx::query("UPDATE clarifications SET state='resolved' WHERE id=?")
                    .bind(clarification_id)
                    .execute(tx.connection())
                    .await?;
            }
        }
        (task.to_string(), current + 1)
    };
    sqlx::query("INSERT INTO condition_revisions(task_id,version,body) VALUES(?,?,?)")
        .bind(&task)
        .bind(version)
        .bind(sqlx::types::Json(&conditions))
        .execute(tx.connection())
        .await?;
    let opened_clarification = if let Some(question) = input["question"].as_str() {
        let clarification_id = id();
        sqlx::query("INSERT INTO clarifications(id,conversation_id,task_id,condition_version,question,options) VALUES(?,?,?,?,?,?)").bind(&clarification_id).bind(&tasks.conversation_id).bind(&task).bind(version).bind(question).bind(sqlx::types::Json(&input["options"])).execute(tx.connection()).await?;
        Some(json!({"id":clarification_id,"question":question,"options":input["options"]}))
    } else {
        None
    };
    let clarification = first_open_clarification_in_tx(tx, &task).await?;
    let phase = if clarification.is_some() {
        "waiting_clarification"
    } else {
        "investigating"
    };
    sqlx::query(
        "UPDATE analysis_tasks SET condition_version=?,phase=?,goal=IF(?='',goal,?) WHERE id=?",
    )
    .bind(version)
    .bind(phase)
    .bind(input["goal"].as_str().unwrap_or(""))
    .bind(input["goal"].as_str().unwrap_or(""))
    .bind(&task)
    .execute(tx.connection())
    .await?;
    Ok(
        json!({"task_id":task,"condition_version":version.to_string(),"state":"active","phase":phase,"conditions":conditions,"question":input["question"],"options":input["options"],"clarification":clarification,"opened_clarification":opened_clarification}),
    )
}
pub async fn assert_current_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
    task: &str,
    version: u64,
) -> Result<()> {
    let row=sqlx::query("SELECT condition_version,lifecycle,phase FROM analysis_tasks WHERE id=? AND conversation_id=?").bind(task).bind(cid).fetch_optional(tx.connection()).await?.ok_or(crate::types::Error::new("not_available"))?;
    if row.get::<u64, _>("condition_version") != version
        || row.get::<String, _>("lifecycle") != "active"
        || row.get::<String, _>("phase") == "waiting_clarification"
    {
        return Err(crate::types::Error::new("version_conflict"));
    }
    Ok(())
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
) -> Result<Value> {
    let mut snapshot = read_task_in_tx(tx, cid, task).await?;
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
    snapshot["open_clarifications"] = json!(clarifications);
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

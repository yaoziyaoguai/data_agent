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
    Ok(rows.iter().map(|r|json!({"id":r.get::<String,_>("id"),"goal":r.get::<String,_>("goal"),"condition_version":r.get::<u64,_>("condition_version").to_string(),"lifecycle":r.get::<String,_>("lifecycle"),"phase":r.get::<String,_>("phase")})).collect())
}

pub async fn context_in_tx(tx: &mut AppTx<'_>, cid: &str) -> Result<Vec<Value>> {
    let rows=sqlx::query("SELECT t.id,t.goal,t.condition_version,t.lifecycle,t.phase,c.body FROM analysis_tasks t LEFT JOIN condition_revisions c ON t.id=c.task_id AND t.condition_version=c.version WHERE t.conversation_id=? ORDER BY t.id").bind(cid).fetch_all(tx.connection()).await?;
    let mut result = Vec::new();
    for r in rows {
        let task = r.get::<String, _>("id");
        let clarification=sqlx::query("SELECT id,question,options FROM clarifications WHERE task_id=? AND state='open' ORDER BY id LIMIT 1").bind(&task).fetch_optional(tx.connection()).await?;
        result.push(json!({"id":task,"goal":r.get::<String,_>("goal"),"condition_version":r.get::<u64,_>("condition_version").to_string(),"lifecycle":r.get::<String,_>("lifecycle"),"phase":r.get::<String,_>("phase"),"conditions":r.get::<Option<sqlx::types::Json<Value>>,_>("body").map(|v|v.0),"clarification":clarification.map(|v|json!({"id":v.get::<String,_>("id"),"question":v.get::<String,_>("question"),"options":v.get::<sqlx::types::Json<Value>,_>("options").0}))}));
    }
    Ok(result)
}
pub async fn apply_update_in_tx(
    tx: &mut AppTx<'_>,
    tasks: &LockedTasks,
    owner: &str,
    operation: &str,
    input: &Value,
) -> Result<Value> {
    tx.assert_snapshot(&tasks.transaction_id)?;
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
        sqlx::query("UPDATE clarifications SET state='resolved' WHERE task_id=? AND state='open'")
            .bind(task)
            .execute(tx.connection())
            .await?;
        (task.to_string(), current + 1)
    };
    let phase = if input["question"].is_string() {
        "waiting_clarification"
    } else {
        "investigating"
    };
    sqlx::query("INSERT INTO condition_revisions(task_id,version,body) VALUES(?,?,?)")
        .bind(&task)
        .bind(version)
        .bind(sqlx::types::Json(&conditions))
        .execute(tx.connection())
        .await?;
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
    if let Some(question) = input["question"].as_str() {
        sqlx::query("INSERT INTO clarifications(id,conversation_id,task_id,condition_version,question,options) VALUES(?,?,?,?,?,?)").bind(id()).bind(&tasks.conversation_id).bind(&task).bind(version).bind(question).bind(sqlx::types::Json(&input["options"])).execute(tx.connection()).await?;
    }
    Ok(
        json!({"task_id":task,"condition_version":version.to_string(),"state":"active","phase":phase,"conditions":conditions,"question":input["question"],"options":input["options"]}),
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

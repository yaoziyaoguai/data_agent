use crate::{
    live_changes::Change,
    persistence::AppTx,
    types::{AccessContext, Error, Result, RunLocation, epoch, id},
};
use serde_json::{Value, json};
use sqlx::{MySqlPool, Row};

pub const LEASE_SECONDS: u32 = 15;

pub async fn task_waiting_phase_in_tx(
    tx: &mut AppTx<'_>,
    task: &str,
    version: u64,
) -> Result<Option<&'static str>> {
    let awaiting:i64=sqlx::query_scalar("SELECT COUNT(*) FROM query_requests WHERE task_id=? AND condition_version=? AND execution_state='not_submitted' AND confirmation_state='awaiting_confirmation' AND check_state='passed'")
        .bind(task).bind(version).fetch_one(tx.connection()).await?;
    if awaiting > 0 {
        return Ok(Some("waiting_confirmation"));
    }
    let running:i64=sqlx::query_scalar("SELECT COUNT(*) FROM query_requests WHERE task_id=? AND condition_version=? AND execution_state IN ('queued','submitting','running','submission_unknown')")
        .bind(task).bind(version).fetch_one(tx.connection()).await?;
    Ok(if running > 0 {
        Some("waiting_query")
    } else {
        None
    })
}
fn view(r: &sqlx::mysql::MySqlRow) -> Value {
    json!({"id":r.get::<String,_>("id"),"conversation_id":r.get::<String,_>("conversation_id"),"task_id":r.get::<String,_>("task_id"),"condition_version":r.get::<u64,_>("condition_version").to_string(),"draft_version":r.get::<u64,_>("draft_version").to_string(),"sql":r.get::<String,_>("sql_text"),"parameters":r.get::<sqlx::types::Json<Value>,_>("parameters").0,"target_id":r.get::<String,_>("target_id"),"summary":r.get::<String,_>("summary"),"knowledge_refs":r.get::<sqlx::types::Json<Value>,_>("knowledge_refs").0,"confirmation_state":r.get::<String,_>("confirmation_state"),"execution_state":r.get::<String,_>("execution_state"),"cancel_state":r.get::<String,_>("cancel_state"),"result_ref":r.get::<Option<String>,_>("result_ref"),"check_state":r.get::<String,_>("check_state"),"error":r.get::<Option<String>,_>("error_code"),"replaces_query_id":r.get::<Option<String>,_>("replaces_query_id"),"error_details":r.get::<Option<sqlx::types::Json<Value>>,_>("error_details").map(|v|v.0),"semantic_resolution":r.get::<Option<sqlx::types::Json<Value>>,_>("semantic_resolution").map(|v|v.0).unwrap_or(Value::Null),"time_basis":r.get::<Option<sqlx::types::Json<Value>>,_>("time_basis").map(|v|v.0).unwrap_or(Value::Null)})
}
pub async fn locate(pool: &MySqlPool, qid: &str) -> Result<RunLocation> {
    let r = sqlx::query("SELECT conversation_id,owner_id FROM query_requests WHERE id=?")
        .bind(qid)
        .fetch_optional(pool)
        .await?
        .ok_or(Error::new("not_available"))?;
    Ok(RunLocation {
        conversation_id: r.get("conversation_id"),
        owner_id: r.get("owner_id"),
        space_id: "demo".into(),
    })
}
pub async fn list_in_tx(tx: &mut AppTx<'_>, cid: &str) -> Result<Vec<Value>> {
    let rows =
        sqlx::query("SELECT * FROM query_requests WHERE conversation_id=? ORDER BY created_at,id")
            .bind(cid)
            .fetch_all(tx.connection())
            .await?;
    Ok(rows.iter().map(view).collect())
}

/// 跨会话历史分页：按创建时间倒序，游标为已见查询id；正文授权由协调层另行套用。
/// limit由调用方给足一页加一，用于判断是否还有更早记录。
pub async fn list_history_page_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    before: Option<&str>,
    query: &str,
    limit: u64,
) -> Result<Vec<Value>> {
    let cursor = if let Some(id) = before {
        Some(sqlx::query_scalar::<_, String>(
            "SELECT DATE_FORMAT(created_at,'%Y-%m-%d %H:%i:%s.%f') FROM query_requests WHERE id=? AND owner_id=?",
        )
        .bind(id)
        .bind(&ctx.user_id)
        .fetch_optional(tx.connection())
        .await?
        .ok_or(Error::new("invalid_input"))?)
    } else {
        None
    };
    let rows = sqlx::query(
        "SELECT id,conversation_id,task_id,condition_version,draft_version,sql_text,summary,knowledge_refs,result_ref,confirmation_state,execution_state,DATE_FORMAT(created_at,'%Y-%m-%dT%H:%i:%s.%fZ') AS created_at \
         FROM query_requests WHERE owner_id=? AND INSTR(LOWER(CONCAT_WS(' ',summary,sql_text)),LOWER(?))>0 \
         AND (? IS NULL OR created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?",
    )
    .bind(&ctx.user_id)
    .bind(query)
    .bind(&cursor)
    .bind(&cursor)
    .bind(&cursor)
    .bind(before)
    .bind(limit)
    .fetch_all(tx.connection())
    .await?;
    Ok(rows
        .iter()
        .map(|r| {
            json!({"id":r.get::<String,_>("id"),"conversation_id":r.get::<String,_>("conversation_id"),"task_id":r.get::<String,_>("task_id"),"condition_version":r.get::<u64,_>("condition_version").to_string(),"draft_version":r.get::<u64,_>("draft_version").to_string(),"sql":r.get::<String,_>("sql_text"),"summary":r.get::<String,_>("summary"),"knowledge_refs":r.get::<sqlx::types::Json<Value>,_>("knowledge_refs").0,"result_ref":r.get::<Option<String>,_>("result_ref"),"confirmation_state":r.get::<String,_>("confirmation_state"),"execution_state":r.get::<String,_>("execution_state"),"created_at":r.get::<String,_>("created_at")})
        })
        .collect())
}
pub async fn read_in_tx(tx: &mut AppTx<'_>, ctx: &AccessContext, qid: &str) -> Result<Value> {
    let r = sqlx::query("SELECT * FROM query_requests WHERE id=? AND owner_id=?")
        .bind(qid)
        .bind(&ctx.user_id)
        .fetch_optional(tx.connection())
        .await?
        .ok_or(Error::new("not_available"))?;
    Ok(view(&r))
}
// 快照/历史核验的批量读取：与单条read_in_tx同一属主过滤，把N+1循环合并为一条IN查询。
pub async fn read_map_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    ids: &[String],
) -> Result<std::collections::HashMap<String, Value>> {
    let mut queries = std::collections::HashMap::new();
    for chunk in ids.chunks(500) {
        let mut query =
            sqlx::QueryBuilder::<sqlx::MySql>::new("SELECT * FROM query_requests WHERE owner_id=");
        query.push_bind(&ctx.user_id).push(" AND id IN (");
        let mut keys = query.separated(",");
        for id in chunk {
            keys.push_bind(id);
        }
        query.push(")");
        for row in query.build().fetch_all(tx.connection()).await? {
            let id = row.get::<String, _>("id");
            let value = view(&row);
            queries.insert(id, value);
        }
    }
    Ok(queries)
}
// 历史投影需要的生成时间：查询视图不携带created_at，历史读取按行取原始时间。
pub async fn created_at_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    qid: &str,
) -> Result<String> {
    sqlx::query_scalar::<_, String>("SELECT DATE_FORMAT(created_at,'%Y-%m-%dT%H:%i:%s.000Z') FROM query_requests WHERE id=? AND owner_id=?")
        .bind(qid)
        .bind(&ctx.user_id)
        .fetch_optional(tx.connection())
        .await?
        .ok_or(Error::new("not_available"))
}

pub async fn text_authority_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    qid: &str,
) -> Result<Value> {
    Ok(sqlx::query_scalar::<_, Option<sqlx::types::Json<Value>>>(
        "SELECT text_authority FROM query_requests WHERE id=? AND owner_id=?",
    )
    .bind(qid)
    .bind(&ctx.user_id)
    .fetch_optional(tx.connection())
    .await?
    .ok_or(Error::new("not_available"))?
    .map(|value| value.0)
    .unwrap_or(Value::Null))
}

pub async fn text_authorities_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    qid: Option<&str>,
) -> Result<Vec<Value>> {
    Ok(sqlx::query_scalar::<_, Option<sqlx::types::Json<Value>>>(
        "SELECT text_authority FROM query_requests WHERE conversation_id=? AND owner_id=? AND (? IS NULL OR id=?)",
    ).bind(cid).bind(&ctx.user_id).bind(qid).bind(qid).fetch_all(tx.connection()).await?.into_iter().map(|value|value.map(|value|value.0).unwrap_or(Value::Null)).collect())
}

pub async fn is_confirmation_message_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    qid: &str,
    message_id: &str,
) -> Result<bool> {
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM query_requests WHERE id=? AND owner_id=? AND confirmation_message_id=?",
    )
    .bind(qid)
    .bind(&ctx.user_id)
    .bind(message_id)
    .fetch_one(tx.connection())
    .await?;
    Ok(count > 0)
}
pub async fn supersede_in_tx(tx: &mut AppTx<'_>, cid: &str, task: &str) -> Result<Vec<String>> {
    tx.lock_rank(5)?;
    let ids = sqlx::query_scalar::<_, String>("SELECT id FROM query_requests WHERE conversation_id=? AND task_id=? AND confirmation_state='awaiting_confirmation' AND execution_state='not_submitted' ORDER BY created_at,id FOR UPDATE")
        .bind(cid).bind(task).fetch_all(tx.connection()).await?;
    sqlx::query("UPDATE query_requests SET confirmation_state='superseded' WHERE conversation_id=? AND task_id=? AND confirmation_state='awaiting_confirmation' AND execution_state='not_submitted'").bind(cid).bind(task).execute(tx.connection()).await?;
    Ok(ids)
}
pub async fn begin_revision_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    task: &str,
    target: Option<&str>,
    replaced: &str,
) -> Result<()> {
    tx.lock_rank(5)?;
    let previous = sqlx::query("SELECT task_id,target_id FROM query_requests WHERE id=? AND owner_id=? AND conversation_id=? FOR UPDATE")
            .bind(replaced).bind(&ctx.user_id).bind(cid).fetch_optional(tx.connection()).await?
            .ok_or(Error::new("not_available"))?;
    if previous.get::<String, _>("task_id") != task
        || target.is_some_and(|target| previous.get::<String, _>("target_id") != target)
    {
        return Err(Error::new("version_conflict"));
    }
    if sqlx::query("SELECT id FROM query_requests WHERE replaces_query_id=? LIMIT 1")
        .bind(replaced)
        .fetch_optional(tx.connection())
        .await?
        .is_some()
    {
        return Err(Error::new("version_conflict"));
    }
    // 修订检查失败也不允许执行被纠正的旧稿；已确认的原查询独立收尾。
    sqlx::query("UPDATE query_requests SET confirmation_state='superseded' WHERE id=? AND confirmation_state='awaiting_confirmation' AND execution_state='not_submitted'")
            .bind(replaced).execute(tx.connection()).await?;
    Ok(())
}
pub struct DraftValidation<'a> {
    pub platform_report: &'a Value,
    pub text_authority: &'a Value,
    pub time_basis: Option<&'a Value>,
    // 与目标条件版本对齐后的口径决策：由授权路径按条件声明继承或核对，不直接取模型参数。
    pub semantic_resolution: Option<&'a Value>,
}

pub async fn save_draft_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    budget: &str,
    operation: &str,
    input: &Value,
    validation: DraftValidation<'_>,
) -> Result<Value> {
    let DraftValidation {
        platform_report: report,
        text_authority,
        time_basis,
        semantic_resolution,
    } = validation;
    tx.lock_rank(5)?;
    let task = input["task_id"].as_str().unwrap_or("");
    let replaced = input["replaces_query_id"].as_str();
    if let Some(replaced) = replaced {
        begin_revision_in_tx(tx, ctx, cid, task, input["target_id"].as_str(), replaced).await?;
    }
    let draft: u64 = sqlx::query_scalar(
        "SELECT CAST(COALESCE(MAX(draft_version),0)+1 AS UNSIGNED) FROM query_requests WHERE task_id=?",
    )
    .bind(task)
    .fetch_one(tx.connection())
    .await?;
    let qid = id();
    let passed = report["state"] == "passed";
    if report["target_id"] != input["target_id"]
        || report["target_version"].as_str().is_none_or(str::is_empty)
    {
        return Err(Error::new("upstream_failed"));
    }
    sqlx::query("INSERT INTO query_requests(id,conversation_id,owner_id,task_id,condition_version,draft_version,operation_id,sql_text,parameters,target_id,target_version,summary,knowledge_refs,check_state,confirmation_state,budget_scope_id,error_code,replaces_query_id,error_details,text_authority,semantic_resolution,time_basis) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(&qid).bind(cid).bind(&ctx.user_id).bind(task).bind(epoch(input["condition_version"].as_str().unwrap_or("0"))?).bind(draft).bind(operation).bind(input["sql"].as_str()).bind(sqlx::types::Json(&input["parameters"])).bind(input["target_id"].as_str()).bind(report["target_version"].as_str()).bind(input["summary"].as_str()).bind(sqlx::types::Json(&input["knowledge_refs"])).bind(if passed{"passed"}else{"rejected"}).bind(if passed{"awaiting_confirmation"}else{"rejected"}).bind(budget).bind(if passed{None}else{Some("sql_not_supported")}).bind(replaced).bind(if passed {None} else {report.get("diagnostic").map(sqlx::types::Json)}).bind(sqlx::types::Json(text_authority)).bind(semantic_resolution.filter(|v| !v.is_null()).map(sqlx::types::Json)).bind(time_basis.filter(|v| !v.is_null()).map(sqlx::types::Json)).execute(tx.connection()).await?;
    read_in_tx(tx, ctx, &qid).await
}
pub struct MessageAuthorization<'a> {
    pub message_id: &'a str,
    pub budget_scope_id: &'a str,
}

pub async fn confirm_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    qid: &str,
    input: &Value,
    blocked: bool,
    message_authorization: Option<MessageAuthorization<'_>>,
) -> Result<Value> {
    tx.lock_rank(5)?;
    let row = sqlx::query("SELECT * FROM query_requests WHERE id=? AND owner_id=? FOR UPDATE")
        .bind(qid)
        .bind(&ctx.user_id)
        .fetch_optional(tx.connection())
        .await?
        .ok_or(Error::new("not_available"))?;
    let v = view(&row);
    if v["draft_version"] != input["draft_version"]
        || v["condition_version"] != input["condition_version"]
    {
        return Err(Error::new("version_conflict"));
    }
    if v["confirmation_state"] == "confirmed" {
        return Ok(v);
    }
    if blocked {
        return Err(Error::new("message_pending"));
    }
    if v["confirmation_state"] != "awaiting_confirmation"
        || v["execution_state"] != "not_submitted"
        || v["check_state"] != "passed"
        || v["cancel_state"] != "none"
    {
        return Err(Error::new("version_conflict"));
    }
    // 首次执行由明确提出执行的消息承担结果解释预算；幂等重放在上方返回，不能补额。
    sqlx::query("UPDATE query_requests SET confirmation_state='confirmed',execution_state='queued',confirmation_key=?,confirmation_message_id=?,budget_scope_id=COALESCE(?,budget_scope_id) WHERE id=?")
        .bind(input["operation_id"].as_str())
        .bind(message_authorization.as_ref().map(|a| a.message_id))
        .bind(message_authorization.as_ref().map(|a| a.budget_scope_id))
        .bind(qid).execute(tx.connection()).await?;
    read_in_tx(tx, ctx, qid).await
}
pub async fn cancel_in_tx(tx: &mut AppTx<'_>, ctx: &AccessContext, qid: &str) -> Result<Value> {
    tx.lock_rank(5)?;
    let row = sqlx::query("SELECT * FROM query_requests WHERE id=? AND owner_id=? FOR UPDATE")
        .bind(qid)
        .bind(&ctx.user_id)
        .fetch_optional(tx.connection())
        .await?
        .ok_or(Error::new("not_available"))?;
    let v = view(&row);
    let local = v["execution_state"] == "not_submitted" || v["execution_state"] == "queued";
    if !matches!(
        v["execution_state"].as_str(),
        Some("succeeded" | "failed" | "cancelled")
    ) {
        sqlx::query("UPDATE query_requests SET cancel_state=?,execution_state=? WHERE id=?")
            .bind(if local { "completed" } else { "requested" })
            .bind(if local {
                "cancelled"
            } else {
                v["execution_state"]
                    .as_str()
                    .unwrap_or("submission_unknown")
            })
            .bind(qid)
            .execute(tx.connection())
            .await?;
        tx.notify(Change::Query {
            conversation_id: row.get("conversation_id"),
        });
    }
    read_in_tx(tx, ctx, qid).await
}
pub async fn claim_due(pool: &MySqlPool, worker: &str) -> Result<Option<Value>> {
    let mut tx = AppTx::begin(pool).await?;
    // 先处理尚未领取和较早到期的查询，避免旧查询的反复轮询阻塞后来的请求。
    let row=sqlx::query("SELECT * FROM query_requests WHERE execution_state IN ('queued','submitting','submission_unknown','running') AND (lease_until IS NULL OR lease_until<UTC_TIMESTAMP(3)) ORDER BY lease_until,created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED").fetch_optional(tx.connection()).await?;
    let result = if let Some(r) = row {
        let qid = r.get::<String, _>("id");
        let lease = r.get::<u64, _>("lease_epoch") + 1;
        sqlx::query("UPDATE query_requests SET lease_owner=?,lease_epoch=?,lease_until=TIMESTAMPADD(SECOND,?,UTC_TIMESTAMP(3)) WHERE id=?").bind(worker).bind(lease).bind(LEASE_SECONDS).bind(&qid).execute(tx.connection()).await?;
        Some(
            json!({"query_id":qid,"lease_epoch":lease.to_string(),"owner_id":r.get::<String,_>("owner_id"),"conversation_id":r.get::<String,_>("conversation_id"),"budget_scope_id":r.get::<String,_>("budget_scope_id")}),
        )
    } else {
        None
    };
    tx.commit().await?;
    Ok(result)
}
pub async fn renew_claim(pool: &MySqlPool, job: &Value, worker: &str) -> Result<()> {
    let changed = sqlx::query("UPDATE query_requests SET lease_until=TIMESTAMPADD(SECOND,?,UTC_TIMESTAMP(3)) WHERE id=? AND lease_owner=? AND lease_epoch=? AND lease_until>UTC_TIMESTAMP(3) AND execution_state IN ('queued','submitting','submission_unknown','running')")
        .bind(LEASE_SECONDS).bind(job["query_id"].as_str()).bind(worker)
        .bind(epoch(job["lease_epoch"].as_str().unwrap_or("0"))?)
        .execute(pool).await?;
    if changed.rows_affected() != 1 {
        return Err(Error::new("lease_lost"));
    }
    Ok(())
}
pub async fn begin_submission_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    job: &Value,
) -> Result<Value> {
    tx.lock_rank(5)?;
    let qid = job["query_id"].as_str().unwrap_or("");
    let row=sqlx::query("SELECT * FROM query_requests WHERE id=? AND lease_epoch=? AND lease_until>UTC_TIMESTAMP(3) FOR UPDATE").bind(qid).bind(epoch(job["lease_epoch"].as_str().unwrap_or("0"))?).fetch_optional(tx.connection()).await?.ok_or(Error::new("lease_lost"))?;
    let mut v = view(&row);
    if v["execution_state"] == "queued" && v["cancel_state"] == "none" {
        sqlx::query("UPDATE query_requests SET execution_state='submitting',submission_attempts=submission_attempts+1 WHERE id=?")
            .bind(qid)
            .execute(tx.connection())
            .await?;
        v["action"] = json!("submit");
        tx.notify(Change::Query {
            conversation_id: row.get("conversation_id"),
        });
    } else {
        v["action"] = json!(if v["cancel_state"] == "requested" {
            "cancel"
        } else {
            "lookup"
        });
    }
    v["target_version"] = json!(row.get::<String, _>("target_version"));
    v["owner_id"] = json!(ctx.user_id);
    v["query_id"] = json!(qid);
    // 持行锁期间时间仍会流逝；交接刷新自身核未过期，拒绝时由原事务回滚提交计数。
    let changed = sqlx::query("UPDATE query_requests SET lease_until=TIMESTAMPADD(SECOND,?,UTC_TIMESTAMP(3)) WHERE id=? AND lease_epoch=? AND lease_until>UTC_TIMESTAMP(3)")
        .bind(LEASE_SECONDS).bind(qid).bind(epoch(job["lease_epoch"].as_str().unwrap_or("0"))?)
        .execute(tx.connection()).await?;
    if changed.rows_affected() != 1 {
        return Err(Error::new("lease_lost"));
    }
    Ok(v)
}
pub async fn record_observation_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    job: &Value,
    observation: &Value,
) -> Result<Value> {
    tx.lock_rank(5)?;
    let qid = job["query_id"].as_str().unwrap_or("");
    let row = sqlx::query("SELECT * FROM query_requests WHERE id=? AND lease_epoch=? FOR UPDATE")
        .bind(qid)
        .bind(epoch(job["lease_epoch"].as_str().unwrap_or("0"))?)
        .fetch_optional(tx.connection())
        .await?
        .ok_or(Error::new("lease_lost"))?;
    let previous: &str = row.try_get("execution_state")?;
    if !matches!(previous, "succeeded" | "failed" | "cancelled") {
        let state = observation["state"]
            .as_str()
            .unwrap_or("submission_unknown");
        if !matches!(
            state,
            "running" | "succeeded" | "failed" | "cancelled" | "submission_unknown"
        ) {
            return Err(Error::new("invalid_input"));
        }
        sqlx::query("UPDATE query_requests SET execution_state=?,result_ref=?,error_code=?,error_details=?,cancel_state=IF(?='cancelled','completed',cancel_state),lease_until=TIMESTAMPADD(MICROSECOND,250000,UTC_TIMESTAMP(3)) WHERE id=?").bind(state).bind(observation["result_ref"].as_str()).bind(observation["error"].as_str()).bind(observation.get("diagnostic").map(sqlx::types::Json)).bind(state).bind(qid).execute(tx.connection()).await?;
        if state != previous {
            tx.notify(Change::Query {
                conversation_id: row.get("conversation_id"),
            });
        }
    }
    read_in_tx(tx, ctx, qid).await
}
pub async fn retry_missing_in_tx(tx: &mut AppTx<'_>, job: &Value) -> Result<bool> {
    tx.lock_rank(5)?;
    let changed = sqlx::query("UPDATE query_requests SET execution_state='queued',lease_until=UTC_TIMESTAMP(3) WHERE id=? AND lease_epoch=? AND execution_state IN ('submitting','submission_unknown') AND cancel_state='none' AND submission_attempts<3")
        .bind(job["query_id"].as_str()).bind(epoch(job["lease_epoch"].as_str().unwrap_or("0"))?).execute(tx.connection()).await?;
    Ok(changed.rows_affected() > 0)
}
pub async fn mark_notified_in_tx(tx: &mut AppTx<'_>, qid: &str) -> Result<bool> {
    let row =
        sqlx::query("UPDATE query_requests SET result_notified=1 WHERE id=? AND result_notified=0")
            .bind(qid)
            .execute(tx.connection())
            .await?;
    Ok(row.rows_affected() > 0)
}

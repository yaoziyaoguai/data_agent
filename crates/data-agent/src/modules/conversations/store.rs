use crate::{
    persistence::AppTx,
    types::{AccessContext, Error, Result, RunLocation, id},
};
use serde_json::{Value, json};
use sqlx::{MySqlPool, Row};

pub async fn locate_conversation(pool: &MySqlPool, cid: &str) -> Result<RunLocation> {
    let row = sqlx::query("SELECT owner_id,space_id FROM conversations WHERE id=?")
        .bind(cid)
        .fetch_optional(pool)
        .await?
        .ok_or(Error::new("not_available"))?;
    Ok(RunLocation {
        conversation_id: cid.into(),
        owner_id: row.get("owner_id"),
        space_id: row.get("space_id"),
    })
}

pub struct LockedConversation {
    pub id: String,
    pub owner_id: String,
    pub space_id: String,
    pub lease_epoch: u64,
    pub lease_owner: Option<String>,
    pub lease_valid: bool,
    pub deleted: bool,
    transaction_id: String,
}
#[derive(Clone)]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub body: String,
    pub recovery_chain_id: String,
    pub budget_scope_id: String,
    pub disposition: String,
    pub request_id: String,
    pub request_clock: Value,
}

pub async fn result_query_for_message_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
    message: &str,
) -> Result<Option<String>> {
    let key: String = sqlx::query_scalar(
        "SELECT client_key FROM conversation_messages WHERE conversation_id=? AND id=?",
    )
    .bind(cid)
    .bind(message)
    .fetch_one(tx.connection())
    .await?;
    Ok(key.strip_prefix("server:query-result:").map(str::to_owned))
}
pub async fn create_conversation_in_tx(
    tx: &mut AppTx<'_>,
    context: &AccessContext,
    key: &str,
) -> Result<String> {
    let candidate = id();
    sqlx::query("INSERT INTO conversations(id,owner_id,space_id,creation_key) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE creation_key=creation_key")
 .bind(candidate).bind(&context.user_id).bind(&context.space_id).bind(key).execute(tx.connection()).await?;
    Ok(sqlx::query_scalar(
        "SELECT id FROM conversations WHERE owner_id=? AND space_id=? AND creation_key=?",
    )
    .bind(&context.user_id)
    .bind(&context.space_id)
    .bind(key)
    .fetch_one(tx.connection())
    .await?)
}
pub async fn lock_conversation_in_tx(
    tx: &mut AppTx<'_>,
    context: &AccessContext,
    cid: &str,
) -> Result<LockedConversation> {
    let locked = lock_for_cleanup_in_tx(tx, context, cid).await?;
    if locked.deleted {
        return Err(Error::new("not_available"));
    }
    Ok(locked)
}
pub async fn lock_for_cleanup_in_tx(
    tx: &mut AppTx<'_>,
    context: &AccessContext,
    cid: &str,
) -> Result<LockedConversation> {
    tx.lock_rank(1)?;
    let row=sqlx::query("SELECT *,COALESCE(lease_until>UTC_TIMESTAMP(3),0) AS lease_valid FROM conversations WHERE id=? FOR UPDATE").bind(cid).fetch_optional(tx.connection()).await?.ok_or(Error::new("not_available"))?;
    let owner_id: String = row.get("owner_id");
    let space_id: String = row.get("space_id");
    if owner_id != context.user_id || space_id != context.space_id {
        return Err(Error::new("not_available"));
    }
    Ok(LockedConversation {
        id: cid.into(),
        owner_id,
        space_id,
        lease_epoch: row.get("lease_epoch"),
        lease_owner: row.get("lease_owner"),
        lease_valid: row.get::<i64, _>("lease_valid") != 0,
        deleted: row.get::<bool, _>("deleted"),
        transaction_id: tx.id().into(),
    })
}
fn current(tx: &AppTx<'_>, locked: &LockedConversation) -> Result<()> {
    tx.assert_snapshot(&locked.transaction_id)
}
pub async fn find_message_in_tx(
    tx: &mut AppTx<'_>,
    context: &AccessContext,
    cid: &str,
    key: &str,
    fp: &str,
) -> Result<Option<Message>> {
    let row = sqlx::query(
        "SELECT * FROM conversation_messages WHERE owner_id=? AND client_key=? FOR UPDATE",
    )
    .bind(&context.user_id)
    .bind(key)
    .fetch_optional(tx.connection())
    .await?;
    if let Some(row) = row {
        if row.get::<String, _>("conversation_id") != cid
            || row.get::<String, _>("fingerprint") != fp
        {
            return Err(Error::new("idempotency_conflict"));
        }
        return Ok(Some(message_from_row(&row)));
    }
    Ok(None)
}
fn message_from_row(row: &sqlx::mysql::MySqlRow) -> Message {
    Message {
        id: row.get("id"),
        conversation_id: row.get("conversation_id"),
        body: row.get("body"),
        request_clock: json!({"reference_time_utc":row.get::<String,_>("reference_time_utc"),"business_timezone":row.get::<String,_>("business_timezone")}),
        recovery_chain_id: row.get("recovery_chain_id"),
        budget_scope_id: row.get("budget_scope_id"),
        disposition: row.get("disposition"),
        request_id: row
            .get::<Option<String>, _>("request_id")
            .unwrap_or_else(|| row.get("id")),
    }
}
pub async fn read_message_in_tx(
    tx: &mut AppTx<'_>,
    locked: &LockedConversation,
    message_id: &str,
) -> Result<Message> {
    current(tx, locked)?;
    let row = sqlx::query(
        "SELECT * FROM conversation_messages WHERE id=? AND conversation_id=? FOR UPDATE",
    )
    .bind(message_id)
    .bind(&locked.id)
    .fetch_optional(tx.connection())
    .await?
    .ok_or(Error::new("not_available"))?;
    Ok(message_from_row(&row))
}
pub async fn accept_message_in_tx(
    tx: &mut AppTx<'_>,
    locked: &LockedConversation,
    key: &str,
    body: &str,
    fp: &str,
    request_id: &str,
) -> Result<Message> {
    current(tx, locked)?;
    let timezone = std::env::var("DATA_AGENT_BUSINESS_TIMEZONE").unwrap_or_else(|_| "UTC".into());
    if !matches!(timezone.as_str(), "UTC" | "Asia/Shanghai") {
        return Err(Error::new("invalid_input"));
    }
    let reference: String =
        sqlx::query_scalar("SELECT DATE_FORMAT(UTC_TIMESTAMP(3),'%Y-%m-%dT%H:%i:%s.%fZ')")
            .fetch_one(tx.connection())
            .await?;
    let message = Message {
        id: id(),
        conversation_id: locked.id.clone(),
        body: body.into(),
        recovery_chain_id: id(),
        budget_scope_id: id(),
        disposition: "pending".into(),
        request_id: request_id.into(),
        request_clock: json!({"reference_time_utc":reference,"business_timezone":timezone}),
    };
    sqlx::query("INSERT INTO conversation_messages(id,conversation_id,owner_id,client_key,body,fingerprint,recovery_chain_id,budget_scope_id,request_id,reference_time_utc,business_timezone) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
 .bind(&message.id).bind(&locked.id).bind(&locked.owner_id).bind(key).bind(body).bind(fp).bind(&message.recovery_chain_id).bind(&message.budget_scope_id).bind(request_id).bind(&reference).bind(&timezone).execute(tx.connection()).await?;
    sqlx::query("UPDATE conversations SET title=COALESCE(title,LEFT(?,240)) WHERE id=?")
        .bind(body)
        .bind(&locked.id)
        .execute(tx.connection())
        .await?;
    Ok(message)
}
pub async fn claim_turn_in_tx(
    tx: &mut AppTx<'_>,
    locked: &LockedConversation,
    run_id: &str,
    ttl_ms: u32,
) -> Result<u64> {
    current(tx, locked)?;
    if locked.lease_valid {
        return Err(Error::new("lease_lost"));
    }
    let epoch = locked.lease_epoch + 1;
    sqlx::query("UPDATE conversations SET lease_epoch=?,lease_owner=?,lease_until=TIMESTAMPADD(MICROSECOND,?,UTC_TIMESTAMP(3)) WHERE id=?")
 .bind(epoch).bind(run_id).bind(ttl_ms*1000).bind(&locked.id).execute(tx.connection()).await?;
    Ok(epoch)
}
pub fn assert_turn_in_tx(
    tx: &AppTx<'_>,
    locked: &LockedConversation,
    run_id: &str,
    epoch: u64,
) -> Result<()> {
    current(tx, locked)?;
    if !locked.lease_valid
        || locked.lease_owner.as_deref() != Some(run_id)
        || locked.lease_epoch != epoch
    {
        return Err(Error::new("lease_lost"));
    }
    Ok(())
}
pub async fn renew_turn_in_tx(
    tx: &mut AppTx<'_>,
    locked: &LockedConversation,
    run_id: &str,
    epoch: u64,
    ttl_ms: u32,
) -> Result<()> {
    assert_turn_in_tx(tx, locked, run_id, epoch)?;
    sqlx::query("UPDATE conversations SET lease_until=TIMESTAMPADD(MICROSECOND,?,UTC_TIMESTAMP(3)) WHERE id=?").bind(ttl_ms*1000).bind(&locked.id).execute(tx.connection()).await?;
    Ok(())
}
pub async fn release_turn_in_tx(
    tx: &mut AppTx<'_>,
    locked: &LockedConversation,
    run_id: &str,
    epoch: u64,
) -> Result<()> {
    assert_turn_in_tx(tx, locked, run_id, epoch)?;
    sqlx::query("UPDATE conversations SET lease_owner=NULL,lease_until=NULL WHERE id=?")
        .bind(&locked.id)
        .execute(tx.connection())
        .await?;
    Ok(())
}
pub async fn commit_consumption_in_tx(
    tx: &mut AppTx<'_>,
    locked: &LockedConversation,
    message_id: &str,
) -> Result<()> {
    current(tx, locked)?;
    sqlx::query("UPDATE conversation_messages SET disposition='consumed' WHERE id=? AND conversation_id=? AND disposition='pending'").bind(message_id).bind(&locked.id).execute(tx.connection()).await?;
    Ok(())
}
pub async fn append_event_in_tx(
    tx: &mut AppTx<'_>,
    locked: &LockedConversation,
    event_id: &str,
    event_type: &str,
    payload: Value,
) -> Result<Value> {
    current(tx, locked)?;
    if let Some(row)=sqlx::query("SELECT event_seq,event_type,payload FROM conversation_events WHERE event_id=? AND conversation_id=?").bind(event_id).bind(&locked.id).fetch_optional(tx.connection()).await? {
  if row.get::<String,_>("event_type")!=event_type || row.get::<sqlx::types::Json<Value>,_>("payload").0!=payload {return Err(Error::new("idempotency_conflict"));}
  return Ok(json!({"event_seq":row.get::<u64,_>("event_seq").to_string()}));
 }
    sqlx::query("UPDATE conversations SET event_seq=event_seq+1 WHERE id=?")
        .bind(&locked.id)
        .execute(tx.connection())
        .await?;
    let seq: u64 = sqlx::query_scalar("SELECT event_seq FROM conversations WHERE id=?")
        .bind(&locked.id)
        .fetch_one(tx.connection())
        .await?;
    sqlx::query("INSERT INTO conversation_events(event_id,conversation_id,event_seq,event_type,payload) VALUES(?,?,?,?,?)").bind(event_id).bind(&locked.id).bind(seq).bind(event_type).bind(sqlx::types::Json(&payload)).execute(tx.connection()).await?;
    Ok(
        json!({"schema_version":1,"event_seq":seq.to_string(),"event_id":event_id,"conversation_id":locked.id,"type":event_type,"payload":payload}),
    )
}
pub async fn read_events_in_tx(
    tx: &mut AppTx<'_>,
    locked: &LockedConversation,
    after: u64,
) -> Result<Vec<Value>> {
    current(tx, locked)?;
    let rows=sqlx::query("SELECT * FROM conversation_events WHERE conversation_id=? AND event_seq>? ORDER BY event_seq LIMIT 1000").bind(&locked.id).bind(after).fetch_all(tx.connection()).await?;
    Ok(rows.iter().map(|r|json!({"schema_version":1,"event_id":r.get::<String,_>("event_id"),"event_seq":r.get::<u64,_>("event_seq").to_string(),"conversation_id":locked.id,"type":r.get::<String,_>("event_type"),"payload":r.get::<sqlx::types::Json<Value>,_>("payload").0})).collect())
}
pub async fn list_conversations_in_tx(
    tx: &mut AppTx<'_>,
    context: &AccessContext,
    before: Option<&str>,
    query: &str,
) -> Result<Value> {
    let cursor = if let Some(id) = before {
        Some(sqlx::query_scalar::<_,String>("SELECT DATE_FORMAT(created_at,'%Y-%m-%d %H:%i:%s.%f') FROM conversations WHERE id=? AND owner_id=? AND space_id=?")
            .bind(id).bind(&context.user_id).bind(&context.space_id).fetch_optional(tx.connection()).await?.ok_or(Error::new("invalid_input"))?)
    } else {
        None
    };
    let rows = sqlx::query("SELECT id,COALESCE(title,'新对话') AS title FROM conversations WHERE owner_id=? AND space_id=? AND deleted=0 AND INSTR(LOWER(COALESCE(title,'')),LOWER(?))>0 AND (? IS NULL OR created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT 101")
        .bind(&context.user_id).bind(&context.space_id).bind(query).bind(&cursor).bind(&cursor).bind(&cursor).bind(before).fetch_all(tx.connection()).await?;
    let next = if rows.len() > 100 {
        rows.get(99).map(|r| r.get::<String, _>("id"))
    } else {
        None
    };
    Ok(
        json!({"conversations":rows.iter().take(100).map(|r|json!({"id":r.get::<String,_>("id"),"title":r.get::<String,_>("title")})).collect::<Vec<_>>(),"next_before_id":next}),
    )
}

pub async fn fail_consumption_in_tx(
    tx: &mut AppTx<'_>,
    locked: &LockedConversation,
    message_id: &str,
) -> Result<()> {
    current(tx, locked)?;
    sqlx::query("UPDATE conversation_messages SET disposition='failed' WHERE id=? AND conversation_id=? AND disposition='pending'")
        .bind(message_id).bind(&locked.id).execute(tx.connection()).await?;
    Ok(())
}

pub async fn locate_message_request(pool: &MySqlPool, message_id: &str) -> Result<String> {
    sqlx::query_scalar("SELECT COALESCE(request_id,id) FROM conversation_messages WHERE id=?")
        .bind(message_id)
        .fetch_optional(pool)
        .await?
        .ok_or(Error::new("not_available"))
}

pub async fn cancel_consumption_in_tx(
    tx: &mut AppTx<'_>,
    locked: &LockedConversation,
    message_id: &str,
    run_id: &str,
    epoch: u64,
) -> Result<()> {
    current(tx, locked)?;
    sqlx::query("UPDATE conversation_messages SET disposition='withdrawn' WHERE id=? AND conversation_id=? AND disposition='pending'").bind(message_id).bind(&locked.id).execute(tx.connection()).await?;
    // 取消可以处理已到期租约，但不能撤销已被后来运行取得的权利。
    sqlx::query("UPDATE conversations SET lease_owner=NULL,lease_until=NULL WHERE id=? AND lease_owner=? AND lease_epoch=?").bind(&locked.id).bind(run_id).bind(epoch).execute(tx.connection()).await?;
    Ok(())
}

pub async fn route_message_in_tx(
    tx: &mut AppTx<'_>,
    locked: &LockedConversation,
    message: &str,
    task: Option<&str>,
    applied: bool,
) -> Result<()> {
    current(tx, locked)?;
    sqlx::query("UPDATE conversation_messages SET routed_task_id=COALESCE(?,routed_task_id),routing_state='routed',applied_to_task=applied_to_task OR ? WHERE id=? AND conversation_id=? AND disposition='pending'").bind(task).bind(applied).bind(message).bind(&locked.id).execute(tx.connection()).await?;
    if let Some(task) = task {
        sqlx::query("INSERT IGNORE INTO conversation_message_tasks(message_id,task_id) SELECT id,? FROM conversation_messages WHERE id=? AND conversation_id=? AND disposition='pending'").bind(task).bind(message).bind(&locked.id).execute(tx.connection()).await?;
    }
    Ok(())
}
pub async fn confirmation_blocked_in_tx(tx: &mut AppTx<'_>, cid: &str) -> Result<bool> {
    let count:i64=sqlx::query_scalar("SELECT COUNT(*) FROM conversation_messages WHERE conversation_id=? AND routing_state='pending' AND disposition IN ('pending','failed')").bind(cid).fetch_one(tx.connection()).await?;
    Ok(count > 0)
}
pub async fn recent_messages_in_tx(
    tx: &mut AppTx<'_>,
    locked: &LockedConversation,
) -> Result<Vec<Value>> {
    current(tx, locked)?;
    let rows = sqlx::query("SELECT payload,event_type FROM conversation_events WHERE conversation_id=? AND event_type IN ('message','assistant_committed') AND (event_type<>'message' OR JSON_UNQUOTE(JSON_EXTRACT(payload,'$.message_id')) NOT IN (SELECT id FROM conversation_messages WHERE disposition='withdrawn')) ORDER BY event_seq DESC LIMIT 16")
        .bind(&locked.id).fetch_all(tx.connection()).await?;
    Ok(rows.iter().rev().map(|r| {
        let payload = r.get::<sqlx::types::Json<Value>, _>("payload").0;
        let mut message = json!({"role":if r.get::<String,_>("event_type")=="message"{"user"}else{"assistant"},"text":payload["text"],"attempt_id":null,"committed":true});
        if let Some(clock)=payload.get("request_clock") { message["request_clock"]=clock.clone(); }
        message
    }).collect())
}
pub async fn delete_in_tx(tx: &mut AppTx<'_>, locked: &LockedConversation) -> Result<()> {
    current(tx, locked)?;
    sqlx::query("UPDATE conversations SET deleted=1,lease_owner=NULL,lease_until=NULL WHERE id=?")
        .bind(&locked.id)
        .execute(tx.connection())
        .await?;
    sqlx::query("UPDATE conversation_messages SET disposition='withdrawn' WHERE conversation_id=? AND disposition IN ('pending','failed')").bind(&locked.id).execute(tx.connection()).await?;
    Ok(())
}
pub async fn enqueue_result_input_in_tx(
    tx: &mut AppTx<'_>,
    locked: &LockedConversation,
    text: &str,
    query_id: &str,
    task_id: &str,
    budget: &str,
    origin_message_id: &str,
) -> Result<Option<Message>> {
    current(tx, locked)?;
    // 客户端消息ID不允许冒号，避免普通用户消息占用查询结果的幂等键。
    let key = format!("server:query-result:{query_id}");
    if sqlx::query("SELECT id FROM conversation_messages WHERE owner_id=? AND client_key=?")
        .bind(&locked.owner_id)
        .bind(&key)
        .fetch_optional(tx.connection())
        .await?
        .is_some()
    {
        return Ok(None);
    }
    let row = sqlx::query("SELECT reference_time_utc,business_timezone FROM conversation_messages WHERE conversation_id=? AND budget_scope_id=? AND id=?")
        .bind(&locked.id).bind(budget).bind(origin_message_id).fetch_optional(tx.connection()).await?.ok_or(Error::new("not_available"))?;
    let reference: String = row.get("reference_time_utc");
    let timezone: String = row.get("business_timezone");
    let message = Message {
        id: id(),
        conversation_id: locked.id.clone(),
        body: text.into(),
        recovery_chain_id: id(),
        budget_scope_id: budget.into(),
        disposition: "pending".into(),
        request_id: id(),
        request_clock: json!({"reference_time_utc":reference,"business_timezone":timezone}),
    };
    sqlx::query("INSERT INTO conversation_messages(id,conversation_id,owner_id,client_key,body,fingerprint,recovery_chain_id,budget_scope_id,request_id,routing_state,routed_task_id,reference_time_utc,business_timezone) VALUES(?,?,?,?,?,?,?,?,?,'routed',?,?,?)").bind(&message.id).bind(&locked.id).bind(&locked.owner_id).bind(&key).bind(text).bind(crate::types::fingerprint(&json!(text))).bind(&message.recovery_chain_id).bind(budget).bind(&message.request_id).bind(task_id).bind(&reference).bind(&timezone).execute(tx.connection()).await?;
    Ok(Some(message))
}

pub async fn event_page_in_tx(
    tx: &mut AppTx<'_>,
    locked: &LockedConversation,
    before: Option<u64>,
    after: Option<u64>,
) -> Result<Vec<Value>> {
    current(tx, locked)?;
    let rows = if let Some(after) = after {
        sqlx::query("SELECT * FROM conversation_events WHERE conversation_id=? AND event_seq>? ORDER BY event_seq LIMIT 1000")
            .bind(&locked.id).bind(after).fetch_all(tx.connection()).await?
    } else {
        sqlx::query("SELECT * FROM conversation_events WHERE conversation_id=? AND (? IS NULL OR event_seq<?) ORDER BY event_seq DESC LIMIT 1000")
            .bind(&locked.id).bind(before).bind(before).fetch_all(tx.connection()).await?
    };
    let mut events:Vec<Value> = rows.iter().map(|r|json!({"schema_version":1,"event_id":r.get::<String,_>("event_id"),"conversation_id":locked.id,"event_seq":r.get::<u64,_>("event_seq").to_string(),"type":r.get::<String,_>("event_type"),"payload":r.get::<sqlx::types::Json<Value>,_>("payload").0})).collect();
    if after.is_none() {
        events.reverse();
    }
    Ok(events)
}
pub async fn last_event_seq_in_tx(tx: &mut AppTx<'_>, locked: &LockedConversation) -> Result<u64> {
    current(tx, locked)?;
    Ok(
        sqlx::query_scalar("SELECT event_seq FROM conversations WHERE id=?")
            .bind(&locked.id)
            .fetch_one(tx.connection())
            .await?,
    )
}

pub async fn assert_routed_in_tx(
    tx: &mut AppTx<'_>,
    locked: &LockedConversation,
    message: &str,
) -> Result<()> {
    current(tx, locked)?;
    let routed: String = sqlx::query_scalar(
        "SELECT routing_state FROM conversation_messages WHERE id=? AND conversation_id=?",
    )
    .bind(message)
    .bind(&locked.id)
    .fetch_one(tx.connection())
    .await?;
    if routed != "routed" {
        return Err(Error::new("message_pending"));
    }
    Ok(())
}
pub async fn withdraw_in_tx(
    tx: &mut AppTx<'_>,
    locked: &LockedConversation,
    message: &str,
) -> Result<()> {
    current(tx, locked)?;
    let row = sqlx::query(
        "SELECT disposition,applied_to_task FROM conversation_messages WHERE id=? AND conversation_id=?",
    )
    .bind(message)
    .bind(&locked.id)
    .fetch_optional(tx.connection())
    .await?
    .ok_or(Error::new("not_available"))?;
    let status = row.get::<String, _>("disposition");
    if status == "withdrawn" {
        return Ok(());
    }
    if !matches!(status.as_str(), "pending" | "failed") {
        return Err(Error::new("version_conflict"));
    }
    if row.get::<bool, _>("applied_to_task") {
        return Err(Error::new("input_already_applied"));
    }
    sqlx::query("UPDATE conversation_messages SET disposition='withdrawn',routing_state='withdrawn' WHERE id=?").bind(message).execute(tx.connection()).await?;
    append_event_in_tx(
        tx,
        locked,
        &format!("withdraw-{message}"),
        "message_withdrawn",
        json!({"message_id":message,"reason":"user_withdrew"}),
    )
    .await?;
    Ok(())
}

pub async fn pending_ids_in_tx(
    tx: &mut AppTx<'_>,
    locked: &LockedConversation,
) -> Result<Vec<String>> {
    current(tx, locked)?;
    Ok(sqlx::query_scalar("SELECT id FROM conversation_messages WHERE conversation_id=? AND disposition IN ('pending','failed')")
        .bind(&locked.id).fetch_all(tx.connection()).await?)
}

// 模型回看只返回未撤回的用户输入；旧助手、工具正文可能已依赖失效资料。
pub async fn model_history_in_tx(
    tx: &mut AppTx<'_>,
    locked: &LockedConversation,
    after: u64,
) -> Result<Vec<Value>> {
    current(tx, locked)?;
    let rows = sqlx::query("SELECT e.*,m.routed_task_id,m.reference_time_utc,m.business_timezone FROM conversation_events e JOIN conversation_messages m ON m.id=JSON_UNQUOTE(JSON_EXTRACT(e.payload,'$.message_id')) AND m.conversation_id=e.conversation_id WHERE e.conversation_id=? AND e.event_type='message' AND e.event_seq>? AND m.disposition<>'withdrawn' ORDER BY e.event_seq LIMIT 100")
        .bind(&locked.id).bind(after).fetch_all(tx.connection()).await?;
    Ok(rows.iter().map(|r| {
        let mut payload = r.get::<sqlx::types::Json<Value>,_>("payload").0;
        payload["request_clock"] = json!({"reference_time_utc":r.get::<String,_>("reference_time_utc"),"business_timezone":r.get::<String,_>("business_timezone")});
        payload["task_id"] = json!(r.get::<Option<String>,_>("routed_task_id"));
        json!({"event_seq":r.get::<u64,_>("event_seq").to_string(),"type":"message","payload":payload})
    }).collect())
}

pub async fn task_pending_ids_in_tx(
    tx: &mut AppTx<'_>,
    locked: &LockedConversation,
    task: &str,
) -> Result<Vec<String>> {
    current(tx, locked)?;
    Ok(sqlx::query_scalar("SELECT DISTINCT m.id FROM conversation_messages m LEFT JOIN conversation_message_tasks b ON b.message_id=m.id WHERE m.conversation_id=? AND (b.task_id=? OR m.routed_task_id=?) AND m.disposition IN ('pending','failed')").bind(&locked.id).bind(task).bind(task).fetch_all(tx.connection()).await?)
}

pub async fn message_task_ids_in_tx(
    tx: &mut AppTx<'_>,
    locked: &LockedConversation,
    message: &str,
) -> Result<Vec<String>> {
    current(tx, locked)?;
    Ok(sqlx::query_scalar("SELECT task_id FROM conversation_message_tasks b JOIN conversation_messages m ON m.id=b.message_id WHERE m.conversation_id=? AND m.id=? UNION SELECT routed_task_id FROM conversation_messages WHERE conversation_id=? AND id=? AND routed_task_id IS NOT NULL").bind(&locked.id).bind(message).bind(&locked.id).bind(message).fetch_all(tx.connection()).await?)
}
pub async fn resume_task_input_in_tx(
    tx: &mut AppTx<'_>,
    locked: &LockedConversation,
    message: &str,
    task: &str,
) -> Result<()> {
    current(tx, locked)?;
    sqlx::query("UPDATE conversation_messages SET disposition='pending',routing_state='routed',routed_task_id=? WHERE id=? AND conversation_id=? AND disposition IN ('withdrawn','pending','failed')").bind(task).bind(message).bind(&locked.id).execute(tx.connection()).await?;
    Ok(())
}

pub async fn skip_task_input_in_tx(
    tx: &mut AppTx<'_>,
    locked: &LockedConversation,
    message: &str,
) -> Result<()> {
    current(tx, locked)?;
    sqlx::query("UPDATE conversation_messages SET disposition='withdrawn',routing_state='withdrawn' WHERE id=? AND conversation_id=? AND disposition IN ('pending','failed')").bind(message).bind(&locked.id).execute(tx.connection()).await?;
    append_event_in_tx(
        tx,
        locked,
        &format!("withdraw-{message}"),
        "message_withdrawn",
        json!({"message_id":message,"reason":"task_cancelled"}),
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence;
    async fn fixture() -> (MySqlPool, AccessContext, String) {
        let url = std::env::var("DATA_AGENT_DATABASE_URL")
            .expect("locking tests require explicit isolated MySQL");
        let pool = persistence::connect(&url).await.expect("MySQL");
        let context = AccessContext {
            user_id: "locking-user".into(),
            space_id: "demo".into(),
            request_id: id(),
        };
        let mut tx = AppTx::begin(&pool).await.unwrap();
        let cid = create_conversation_in_tx(&mut tx, &context, &id())
            .await
            .unwrap();
        tx.commit().await.unwrap();
        (pool, context, cid)
    }
    #[tokio::test]
    async fn locking_reads_current_after_snapshot() {
        let (pool, context, cid) = fixture().await;
        let mut earlier = AppTx::begin(&pool).await.unwrap();
        let old: u64 = sqlx::query_scalar("SELECT lease_epoch FROM conversations WHERE id=?")
            .bind(&cid)
            .fetch_one(earlier.connection())
            .await
            .unwrap();
        assert_eq!(old, 0);
        let mut newer = AppTx::begin(&pool).await.unwrap();
        let locked = lock_conversation_in_tx(&mut newer, &context, &cid)
            .await
            .unwrap();
        claim_turn_in_tx(&mut newer, &locked, "new-run", 10000)
            .await
            .unwrap();
        newer.commit().await.unwrap();
        let current = lock_conversation_in_tx(&mut earlier, &context, &cid)
            .await
            .unwrap();
        assert_eq!(current.lease_epoch, 1);
        assert!(current.lease_valid);
        assert_eq!(
            claim_turn_in_tx(&mut earlier, &current, "old-run", 10000)
                .await
                .unwrap_err()
                .code,
            "lease_lost"
        );
    }
    #[tokio::test]
    async fn locking_snapshot_cannot_cross_transactions() {
        let (pool, context, cid) = fixture().await;
        let mut tx = AppTx::begin(&pool).await.unwrap();
        let locked = lock_conversation_in_tx(&mut tx, &context, &cid)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let mut other = AppTx::begin(&pool).await.unwrap();
        assert_eq!(
            claim_turn_in_tx(&mut other, &locked, "bad-run", 10000)
                .await
                .unwrap_err()
                .code,
            "invalid_input"
        );
    }
    #[tokio::test]
    async fn locking_reversed_order_is_rejected() {
        let (pool, context, cid) = fixture().await;
        let mut tx = AppTx::begin(&pool).await.unwrap();
        tx.lock_rank(4).unwrap();
        assert!(
            matches!(lock_conversation_in_tx(&mut tx,&context,&cid).await,Err(error) if error.code=="invalid_input")
        );
    }
    #[tokio::test]
    async fn locking_parallel_claims_have_one_winner() {
        let (pool, context, cid) = fixture().await;
        async fn claim(pool: &MySqlPool, context: &AccessContext, cid: &str) -> Result<u64> {
            let mut tx = AppTx::begin(pool).await?;
            let locked = lock_conversation_in_tx(&mut tx, context, cid).await?;
            let epoch = claim_turn_in_tx(&mut tx, &locked, &id(), 10000).await?;
            tx.commit().await?;
            Ok(epoch)
        }
        let (first, second) =
            tokio::join!(claim(&pool, &context, &cid), claim(&pool, &context, &cid));
        assert_eq!(usize::from(first.is_ok()) + usize::from(second.is_ok()), 1);
    }
}

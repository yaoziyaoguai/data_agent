use super::{LockedConversation, assert_readable_in_tx, current};
use crate::{
    live_changes::Change,
    persistence::AppTx,
    types::{AccessContext, Error, Result},
};
use serde_json::{Value, json};
use sqlx::Row;

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
// 会话内全部server:query-result消息关联的批量读取：message_id -> 原查询ID。
pub async fn result_query_map_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
) -> Result<std::collections::HashMap<String, String>> {
    let rows = sqlx::query(
        "SELECT id,client_key FROM conversation_messages WHERE conversation_id=? AND client_key LIKE 'server:query-result:%'",
    )
    .bind(cid)
    .fetch_all(tx.connection())
    .await?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            let key = row.get::<String, _>("client_key");
            Some((
                row.get::<String, _>("id"),
                key.strip_prefix("server:query-result:")?.to_owned(),
            ))
        })
        .collect())
}
// 每个查询首次query_changed事件的持久序号：查询卡在时间线中的稳定锚点。
pub async fn first_query_changed_seq_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
) -> Result<std::collections::HashMap<String, String>> {
    let rows = sqlx::query(
        "SELECT JSON_UNQUOTE(JSON_EXTRACT(payload,'$.query_id')) AS qid,MIN(event_seq) AS seq \
         FROM conversation_events WHERE conversation_id=? AND event_type='query_changed' GROUP BY qid HAVING qid IS NOT NULL",
    )
    .bind(cid)
    .fetch_all(tx.connection())
    .await?;
    Ok(rows
        .iter()
        .map(|row| {
            (
                row.get::<String, _>("qid"),
                row.get::<u64, _>("seq").to_string(),
            )
        })
        .collect())
}
// 每个报告首次analysis_report_saved事件的持久序号：报告卡在时间线中的稳定展示锚点。
// 按conversation_id+report_id的全部已保存版本取MIN，不按当前版本或事件页筛选；单次窄查询，不逐报告N+1。
pub async fn report_first_saved_seq_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
    report_ids: &[String],
) -> Result<std::collections::HashMap<String, String>> {
    if report_ids.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    let placeholders = std::iter::repeat_n("?", report_ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT JSON_UNQUOTE(JSON_EXTRACT(payload,'$.report_id')) AS rid,MIN(event_seq) AS seq \
         FROM conversation_events WHERE conversation_id=? AND event_type='analysis_report_saved' \
         AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.report_id')) IN ({placeholders}) GROUP BY rid"
    );
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(cid);
    for id in report_ids {
        query = query.bind(id);
    }
    let rows = query.fetch_all(tx.connection()).await?;
    Ok(rows
        .iter()
        .map(|row| {
            (
                row.get::<String, _>("rid"),
                row.get::<u64, _>("seq").to_string(),
            )
        })
        .collect())
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
    let event = json!({"schema_version":1,"event_seq":seq.to_string(),"event_id":event_id,"conversation_id":locked.id,"type":event_type,"payload":payload});
    tx.notify(Change::Timeline {
        scope: locked.live_scope(),
        event: event.clone(),
    });
    Ok(event)
}
pub async fn read_events_in_tx(
    tx: &mut AppTx<'_>,
    context: &AccessContext,
    cid: &str,
    after: u64,
) -> Result<Vec<Value>> {
    assert_readable_in_tx(tx, context, cid).await?;
    let rows=sqlx::query("SELECT * FROM conversation_events WHERE conversation_id=? AND event_seq>? ORDER BY event_seq LIMIT 1000").bind(cid).bind(after).fetch_all(tx.connection()).await?;
    Ok(rows.iter().map(event_value).collect())
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
    let mut events: Vec<Value> = rows.iter().map(event_value).collect();
    if after.is_none() {
        events.reverse();
    }
    Ok(events)
}
fn event_value(row: &sqlx::mysql::MySqlRow) -> Value {
    json!({"schema_version":1,"event_id":row.get::<String,_>("event_id"),"conversation_id":row.get::<String,_>("conversation_id"),
        "event_seq":row.get::<u64,_>("event_seq").to_string(),"type":row.get::<String,_>("event_type"),
        "payload":row.get::<sqlx::types::Json<Value>,_>("payload").0})
}

pub async fn output_event_range_in_tx(
    tx: &mut AppTx<'_>,
    locked: &LockedConversation,
    attempt: &str,
    first: u64,
    last: u64,
) -> Result<Vec<Value>> {
    current(tx, locked)?;
    let rows = sqlx::query(
        "SELECT * FROM conversation_events WHERE conversation_id=? AND event_seq>=? AND event_seq<=? \
         AND event_type IN ('assistant_delta','assistant_committed','assistant_replaced') \
         AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.attempt_id'))=? ORDER BY event_seq",
    ).bind(&locked.id).bind(first).bind(last).bind(attempt).fetch_all(tx.connection()).await?;
    Ok(rows.iter().map(event_value).collect())
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

use crate::{
    persistence::AppTx,
    types::{Error, Result},
};
use serde_json::{Value, json};
use sqlx::Row;

// source_preparations的私有存储：整理进度、冻结批次与在途调用状态都只经
// ingestion::preparation的公开入口读写，正文仍归source_current/source_snapshots。
pub async fn ensure_preparation_in_tx(
    tx: &mut AppTx<'_>,
    space: &str,
    source: &str,
    revision: u64,
    input_fingerprint: &str,
    dependency_fingerprint: &str,
) -> Result<()> {
    sqlx::query(
        "INSERT IGNORE INTO source_preparations(source_id,space_id,revision,method_version,input_fingerprint,dependency_fingerprint,unresolved) VALUES(?,?,?,?,?,?,CAST('[]' AS JSON))",
    )
    .bind(source)
    .bind(space)
    .bind(revision)
    .bind(super::PREPARATION_METHOD)
    .bind(input_fingerprint)
    .bind(dependency_fingerprint)
    .execute(tx.connection())
    .await?;
    Ok(())
}

pub async fn read_preparation_in_tx(
    tx: &mut AppTx<'_>,
    space: &str,
    source: &str,
    revision: u64,
) -> Result<Option<Value>> {
    let row = sqlx::query(
        "SELECT *,(issued_until IS NOT NULL AND issued_until>UTC_TIMESTAMP(3)) AS lease_valid FROM source_preparations WHERE source_id=? AND space_id=? AND revision=? AND method_version=?",
    )
    .bind(source)
    .bind(space)
    .bind(revision)
    .bind(super::PREPARATION_METHOD)
    .fetch_optional(tx.connection())
    .await?;
    Ok(row.map(|row| preparation_row(&row)))
}

fn preparation_row(row: &sqlx::mysql::MySqlRow) -> Value {
    json!({
        "source_id": row.get::<String,_>("source_id"),
        "revision": row.get::<u64,_>("revision").to_string(),
        "input_fingerprint": row.get::<String,_>("input_fingerprint"),
        "dependency_fingerprint": row.get::<String,_>("dependency_fingerprint"),
        "segment_cursor": row.get::<Option<sqlx::types::Json<Value>>,_>("segment_cursor").map(|v| v.0).unwrap_or(Value::Null),
        "segments_read": row.get::<u64,_>("segments_read"),
        "covered_chars": row.get::<u64,_>("covered_chars"),
        "semantic_status": row.get::<String,_>("semantic_status"),
        "unresolved": row.get::<sqlx::types::Json<Value>,_>("unresolved").0,
        "error_code": row.get::<Option<String>,_>("error_code"),
        "frozen_batch": row.get::<Option<sqlx::types::Json<Value>>,_>("frozen_batch").map(|v| v.0).unwrap_or(Value::Null),
        "pending_draft": row.get::<Option<sqlx::types::Json<Value>>,_>("pending_draft").map(|v| v.0).unwrap_or(Value::Null),
        "call_state": row.get::<Option<String>,_>("call_state"),
        "lease_valid": row.get::<i64,_>("lease_valid") == 1,
        "batch_sequence": row.get::<u64,_>("batch_sequence"),
    })
}

// 过期调用不能重发；释放不再消费的批次正文，原调用身份、草稿与覆盖进度保留。
pub async fn expire_issued_preparations_in_tx(tx: &mut AppTx<'_>) -> Result<()> {
    sqlx::query(
        "UPDATE source_preparations SET call_state='unknown',error_code='model_unknown',frozen_batch=NULL,issued_until=NULL WHERE call_state IN ('analysis','review') AND issued_until<UTC_TIMESTAMP(3)",
    )
    .execute(tx.connection())
    .await?;
    Ok(())
}

// 冻结本批输入并登记在途分析调用；只有无在途调用时才允许开批。
pub async fn begin_batch_in_tx(
    tx: &mut AppTx<'_>,
    source: &str,
    revision: u64,
    frozen_batch: &Value,
    dependency_fingerprint: &str,
    lease_seconds: u64,
) -> Result<()> {
    let changed = sqlx::query(
        "UPDATE source_preparations SET frozen_batch=?,pending_draft=NULL,call_state='analysis',error_code=NULL,dependency_fingerprint=?,batch_sequence=batch_sequence+1,issued_until=TIMESTAMPADD(SECOND,?,UTC_TIMESTAMP(3)) WHERE source_id=? AND revision=? AND method_version=? AND call_state IS NULL",
    )
    .bind(sqlx::types::Json(frozen_batch))
    .bind(dependency_fingerprint)
    .bind(lease_seconds)
    .bind(source)
    .bind(revision)
    .bind(super::PREPARATION_METHOD)
    .execute(tx.connection())
    .await?;
    if changed.rows_affected() != 1 {
        return Err(Error::new("version_conflict"));
    }
    Ok(())
}

// 已知失败的批次清理在途状态，允许以新的调用身份重新开批；游标与覆盖不动。
pub async fn reset_batch_in_tx(tx: &mut AppTx<'_>, source: &str, revision: u64) -> Result<()> {
    sqlx::query(
        "UPDATE source_preparations SET frozen_batch=NULL,pending_draft=NULL,call_state=NULL,issued_until=NULL WHERE source_id=? AND revision=? AND method_version=? AND call_state IN ('analysis','review','applying')",
    )
    .bind(source)
    .bind(revision)
    .bind(super::PREPARATION_METHOD)
    .execute(tx.connection())
    .await?;
    Ok(())
}

pub async fn stage_draft_in_tx(
    tx: &mut AppTx<'_>,
    source: &str,
    revision: u64,
    draft: &Value,
    lease_seconds: u64,
) -> Result<()> {
    let changed = sqlx::query(
        "UPDATE source_preparations SET pending_draft=?,call_state='review',issued_until=TIMESTAMPADD(SECOND,?,UTC_TIMESTAMP(3)) WHERE source_id=? AND revision=? AND method_version=? AND call_state='analysis' AND issued_until>UTC_TIMESTAMP(3)",
    )
    .bind(sqlx::types::Json(draft))
    .bind(lease_seconds)
    .bind(source)
    .bind(revision)
    .bind(super::PREPARATION_METHOD)
    .execute(tx.connection())
    .await?;
    if changed.rows_affected() != 1 {
        return Err(Error::new("lease_lost"));
    }
    Ok(())
}

// 复核成果在应用前落库并转入applying：成果自此确定，issued窗口清除，在途
// unknown语义只保留给结果未知的analysis/review。此后应用事务回滚（死锁、
// 瞬时断库）时，重试从已提交输出恢复应用，不重发模型调用。
pub async fn stage_apply_in_tx(
    tx: &mut AppTx<'_>,
    source: &str,
    revision: u64,
    output: &Value,
) -> Result<()> {
    let changed = sqlx::query(
        "UPDATE source_preparations SET pending_draft=?,call_state='applying',issued_until=NULL WHERE source_id=? AND revision=? AND method_version=? AND call_state='review' AND issued_until>UTC_TIMESTAMP(3)",
    )
    .bind(sqlx::types::Json(output))
    .bind(source)
    .bind(revision)
    .bind(super::PREPARATION_METHOD)
    .execute(tx.connection())
    .await?;
    if changed.rows_affected() != 1 {
        // 复核在途窗口已过期：按既有纪律视结果不确定，不落库、不重发。
        return Err(Error::new("lease_lost"));
    }
    Ok(())
}

// 扇出重开结果：Reset=终态准备已复位待重整；NoRow=该修订尚无准备记录，
// 由重排队后的整理消费者按需ensure；Busy=在途/进行中/unknown的准备未被
// 打断，其作业不重排。
pub enum ReopenOutcome {
    Reset,
    NoRow,
    Busy,
}

// 扇出重开：依赖者真正失效时把终态准备复位重整。只复位ready/failed且无在途
// 调用的行——进行中的整理在自己的批次推进中会按当前内容重新登记指纹；
// model_unknown终态的failed行同样不动（结果不确定的回执预算预留不释放、
// 不自动重整），其余failed（重试耗尽、成果不合法等）的调用都已结算或从未
// 发起，复位重整安全。批次序列不归零：重开后的新批必须沿单调序列取得新的
// 调用与应用身份，不能复用已结算旧批的身份。
pub async fn reopen_preparation_in_tx(
    tx: &mut AppTx<'_>,
    space: &str,
    source: &str,
    revision: u64,
) -> Result<ReopenOutcome> {
    let changed = sqlx::query(
        "UPDATE source_preparations SET segment_cursor=NULL,segments_read=0,covered_chars=0,unresolved=CAST('[]' AS JSON),semantic_status='pending',error_code=NULL,frozen_batch=NULL,pending_draft=NULL WHERE source_id=? AND space_id=? AND revision=? AND method_version=? AND semantic_status IN ('ready','failed') AND call_state IS NULL AND (semantic_status='ready' OR error_code IS NULL OR error_code<>'model_unknown')",
    )
    .bind(source)
    .bind(space)
    .bind(revision)
    .bind(super::PREPARATION_METHOD)
    .execute(tx.connection())
    .await?;
    if changed.rows_affected() > 0 {
        return Ok(ReopenOutcome::Reset);
    }
    let exists = sqlx::query(
        "SELECT 1 FROM source_preparations WHERE source_id=? AND space_id=? AND revision=? AND method_version=?",
    )
    .bind(source)
    .bind(space)
    .bind(revision)
    .bind(super::PREPARATION_METHOD)
    .fetch_optional(tx.connection())
    .await?;
    Ok(if exists.is_some() {
        ReopenOutcome::Busy
    } else {
        ReopenOutcome::NoRow
    })
}

// 来源失效或被新修订取代的未完成准备收敛终态。source是全局身份，来源头已消失
// 时也可结束原修订；已完成成果与unknown事实不改写，指纹、覆盖与账本保持。
pub async fn supersede_preparation_in_tx(
    tx: &mut AppTx<'_>,
    source: &str,
    revision: u64,
) -> Result<()> {
    sqlx::query(
        "UPDATE source_preparations SET semantic_status='superseded',frozen_batch=NULL,pending_draft=NULL,call_state=NULL,issued_until=NULL WHERE source_id=? AND revision=? AND method_version=? AND semantic_status NOT IN ('ready','failed','superseded') AND (call_state IS NULL OR call_state<>'unknown')",
    )
    .bind(source)
    .bind(revision)
    .bind(super::PREPARATION_METHOD)
    .execute(tx.connection())
    .await?;
    Ok(())
}

// 应用成果后推进游标与覆盖；覆盖完成且没有未解释项即ready，否则如实保持partial。
pub async fn complete_batch_in_tx(
    tx: &mut AppTx<'_>,
    source: &str,
    revision: u64,
    next_cursor: Option<&Value>,
    batch_segments: u64,
    batch_chars: u64,
    unresolved: &[String],
) -> Result<()> {
    let changed = sqlx::query(
        "UPDATE source_preparations SET segment_cursor=?,segments_read=segments_read+?,covered_chars=covered_chars+?,unresolved=?,semantic_status=IF(? IS NULL,IF(JSON_LENGTH(?)=0,'ready','partial'),'partial'),frozen_batch=NULL,pending_draft=NULL,call_state=NULL,issued_until=NULL WHERE source_id=? AND revision=? AND method_version=? AND call_state='applying'",
    )
    .bind(next_cursor.map(sqlx::types::Json::from))
    .bind(batch_segments)
    .bind(batch_chars)
    .bind(sqlx::types::Json(json!(unresolved)))
    .bind(next_cursor.map(sqlx::types::Json::from))
    .bind(sqlx::types::Json(json!(unresolved)))
    .bind(source)
    .bind(revision)
    .bind(super::PREPARATION_METHOD)
    .execute(tx.connection())
    .await?;
    if changed.rows_affected() != 1 {
        return Err(Error::new("lease_lost"));
    }
    Ok(())
}

pub async fn fail_preparation_in_tx(
    tx: &mut AppTx<'_>,
    source: &str,
    revision: u64,
    error_code: &str,
) -> Result<()> {
    sqlx::query(
        "UPDATE source_preparations SET semantic_status='failed',error_code=?,frozen_batch=NULL,pending_draft=NULL,call_state=NULL,issued_until=NULL WHERE source_id=? AND revision=? AND method_version=?",
    )
    .bind(error_code)
    .bind(source)
    .bind(revision)
    .bind(super::PREPARATION_METHOD)
    .execute(tx.connection())
    .await?;
    Ok(())
}

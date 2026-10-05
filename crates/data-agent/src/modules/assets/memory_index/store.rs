use crate::{
    persistence::AppTx,
    types::{AccessContext, Error, Result, epoch, id},
};
use serde_json::{Value, json};
use sqlx::{MySqlPool, Row};

pub async fn queue_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    asset: &Value,
    scope: Option<&str>,
    profile: Option<&Value>,
    extraction: Option<&str>,
) -> Result<()> {
    if asset["kind"] != "memory" {
        return Ok(());
    }
    sqlx::query("INSERT IGNORE INTO personal_memory_index_jobs(id,owner_id,space_id,asset_id,asset_version,asset_json,extraction_operation_id,budget_scope_id,model_profile,index_target) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .bind(id()).bind(&ctx.user_id).bind(&ctx.space_id).bind(asset["id"].as_str()).bind(epoch(asset["version"].as_str().ok_or(Error::new("invalid_input"))?)?).bind(sqlx::types::Json(asset)).bind(extraction).bind(scope).bind(profile.map(sqlx::types::Json)).bind(super::super::memory_provider::index_target()).execute(tx.connection()).await?;
    Ok(())
}

pub async fn queue_missing(pool: &MySqlPool, profile: &Value) -> Result<()> {
    let target = super::super::memory_provider::index_target();
    // 只为当前目标缺失的正式版本排队，失败/未知作业不会借启动换身份补额。
    sqlx::query("INSERT IGNORE INTO personal_memory_index_jobs(id,owner_id,space_id,asset_id,asset_version,asset_json,model_profile,index_target) SELECT UUID(),p.owner_id,p.space_id,p.id,p.version,p.body,?,? FROM personal_assets p WHERE p.kind='memory' AND p.state='enabled' AND NOT EXISTS(SELECT 1 FROM personal_memory_index_jobs j WHERE j.asset_id=p.id AND j.asset_version=p.version AND j.owner_id=p.owner_id AND j.space_id=p.space_id AND j.index_target=?) ORDER BY p.id LIMIT 32")
        .bind(sqlx::types::Json(profile)).bind(&target).bind(target).execute(pool).await?;
    Ok(())
}
fn value(row: &sqlx::mysql::MySqlRow) -> Value {
    json!({"id":row.get::<String,_>("id"),"owner_id":row.get::<String,_>("owner_id"),"space_id":row.get::<String,_>("space_id"),"asset":row.get::<sqlx::types::Json<Value>,_>("asset_json").0,"extraction_operation_id":row.get::<Option<String>,_>("extraction_operation_id"),"budget_scope_id":row.get::<Option<String>,_>("budget_scope_id"),"model_profile":row.get::<Option<sqlx::types::Json<Value>>,_>("model_profile").map(|v|v.0),"epoch":row.get::<u64,_>("lease_epoch").to_string(),"state":row.get::<String,_>("state"),"valid":row.get::<i64,_>("valid")!=0})
}
pub async fn read_job_in_tx(tx: &mut AppTx<'_>, job: &str) -> Result<Value> {
    let row=sqlx::query("SELECT *,COALESCE(lease_until>UTC_TIMESTAMP(3),0) AS valid FROM personal_memory_index_jobs WHERE id=? FOR UPDATE").bind(job).fetch_optional(tx.connection()).await?.ok_or(Error::new("not_available"))?;
    Ok(value(&row))
}
pub async fn claim(pool: &MySqlPool) -> Result<Option<Value>> {
    let mut tx = AppTx::begin(pool).await?;
    // 超时重领同一作业，侧车先接回持久结果；模型回执未知不会重做付费调用。
    let target = super::super::memory_provider::index_target();
    sqlx::query("UPDATE personal_memory_index_jobs SET state='failed',error_code='outcome_unknown' WHERE index_target=? AND state='issued' AND lease_until<UTC_TIMESTAMP(3) AND attempts>=3").bind(&target).execute(tx.connection()).await?;
    let row=sqlx::query("SELECT *,COALESCE(lease_until>UTC_TIMESTAMP(3),0) AS valid FROM personal_memory_index_jobs WHERE index_target=? AND (state='queued' OR (state='issued' AND lease_until<UTC_TIMESTAMP(3))) AND attempts<3 ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED").bind(target).fetch_optional(tx.connection()).await?;
    let Some(row) = row else {
        tx.commit().await?;
        return Ok(None);
    };
    let job = row.get::<String, _>("id");
    // 后到旧作业无需再处理；已删除的资产仍存在状态头以清理索引。
    let current: Option<u64> = sqlx::query_scalar(
        "SELECT version FROM personal_assets WHERE id=? AND owner_id=? AND space_id=?",
    )
    .bind(row.get::<String, _>("asset_id"))
    .bind(row.get::<String, _>("owner_id"))
    .bind(row.get::<String, _>("space_id"))
    .fetch_optional(tx.connection())
    .await?;
    if current != Some(row.get::<u64, _>("asset_version")) {
        sqlx::query("UPDATE personal_memory_index_jobs SET state='superseded' WHERE id=?")
            .bind(job)
            .execute(tx.connection())
            .await?;
        tx.commit().await?;
        return Ok(None);
    }
    sqlx::query("UPDATE personal_memory_index_jobs SET state='issued',lease_epoch=lease_epoch+1,attempts=attempts+1,lease_until=TIMESTAMPADD(SECOND,180,UTC_TIMESTAMP(3)) WHERE id=?").bind(&job).execute(tx.connection()).await?;
    let v = read_job_in_tx(&mut tx, &job).await?;
    tx.commit().await?;
    Ok(Some(v))
}
pub async fn complete(pool: &MySqlPool, job: &Value, error: Option<&str>) -> Result<()> {
    let mut tx = AppTx::begin(pool).await?;
    sqlx::query("UPDATE personal_memory_index_jobs SET state=IF(? AND attempts<3,'queued',?),error_code=? WHERE id=? AND lease_epoch=? AND state='issued'").bind(error==Some("memory_unavailable"))
        .bind(if error.is_some(){"failed"}else{"indexed"}).bind(error).bind(job["id"].as_str()).bind(epoch(job["epoch"].as_str().unwrap_or("0"))?).execute(tx.connection()).await?;
    tx.commit().await
}

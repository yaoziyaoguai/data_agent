use crate::{
    persistence::AppTx,
    types::{AccessContext, Error, Result, epoch, fingerprint},
};
use serde_json::Value;
use sqlx::Row;

pub async fn begin_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    input: &Value,
) -> Result<Option<Value>> {
    let key = input["input"]["operation_id"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?;
    sqlx::query("INSERT INTO semantic_correction_operations(space_id,owner_id,operation_id,fingerprint,receipt) VALUES(?,?,?,?,CAST('null' AS JSON)) ON DUPLICATE KEY UPDATE operation_id=VALUES(operation_id)")
        .bind(&ctx.space_id).bind(&ctx.user_id).bind(key).bind(fingerprint(input)).execute(tx.connection()).await?;
    let row=sqlx::query("SELECT fingerprint,receipt FROM semantic_correction_operations WHERE space_id=? AND owner_id=? AND operation_id=? FOR UPDATE")
        .bind(&ctx.space_id).bind(&ctx.user_id).bind(key).fetch_one(tx.connection()).await?;
    if row.get::<String, _>("fingerprint") != fingerprint(input) {
        return Err(Error::new("idempotency_conflict"));
    }
    let value = row.get::<sqlx::types::Json<Value>, _>("receipt").0;
    Ok(if value.is_null() { None } else { Some(value) })
}
pub async fn record_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    input: &Value,
    value: &Value,
) -> Result<()> {
    sqlx::query("UPDATE semantic_correction_operations SET receipt=? WHERE space_id=? AND owner_id=? AND operation_id=?")
        .bind(sqlx::types::Json(value)).bind(&ctx.space_id).bind(&ctx.user_id).bind(input["input"]["operation_id"].as_str()).execute(tx.connection()).await?;
    Ok(())
}
pub async fn read_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    id: &str,
    lock: bool,
) -> Result<Value> {
    let sql = if lock {
        "SELECT body FROM semantic_corrections WHERE space_id=? AND id=? FOR UPDATE"
    } else {
        "SELECT body FROM semantic_corrections WHERE space_id=? AND id=?"
    };
    Ok(sqlx::query_scalar::<_, sqlx::types::Json<Value>>(sql)
        .bind(&ctx.space_id)
        .bind(id)
        .fetch_optional(tx.connection())
        .await?
        .ok_or(Error::new("not_available"))?
        .0)
}
pub async fn page_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    admin: bool,
    managed: &[String],
    after: Option<&str>,
) -> Result<Vec<Value>> {
    let ids = serde_json::to_string(managed).map_err(|_| Error::new("invalid_input"))?;
    let rows=sqlx::query("SELECT body FROM semantic_corrections WHERE space_id=? AND id>? AND (?=1 OR submitter_id=? OR JSON_CONTAINS(CAST(? AS JSON),JSON_QUOTE(object_id))) ORDER BY id LIMIT 51")
        .bind(&ctx.space_id).bind(after.unwrap_or("")).bind(admin).bind(&ctx.user_id).bind(ids).fetch_all(tx.connection()).await?;
    Ok(rows
        .iter()
        .map(|r| r.get::<sqlx::types::Json<Value>, _>("body").0)
        .collect())
}
pub async fn save_in_tx(tx: &mut AppTx<'_>, ctx: &AccessContext, v: &Value) -> Result<()> {
    sqlx::query("INSERT INTO semantic_corrections(id,space_id,submitter_id,object_id,revision,state,body) VALUES(?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE revision=VALUES(revision),state=VALUES(state),body=VALUES(body)")
        .bind(v["id"].as_str()).bind(&ctx.space_id).bind(v["submitter_id"].as_str()).bind(v["object_id"].as_str()).bind(epoch(v["revision"].as_str().unwrap_or(""))?).bind(v["state"].as_str()).bind(sqlx::types::Json(v)).execute(tx.connection()).await?;
    Ok(())
}

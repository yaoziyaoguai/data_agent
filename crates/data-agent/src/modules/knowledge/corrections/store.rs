use crate::{
    persistence::{AppTx, receipts::Operation},
    types::{AccessContext, Error, Result, epoch},
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
    Operation::new(ctx, "semantic_correction", key, input)
        .begin(tx)
        .await
}
pub async fn record_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    input: &Value,
    value: &Value,
) -> Result<()> {
    let key = input["input"]["operation_id"]
        .as_str()
        .expect("validated operation");
    Operation::new(ctx, "semantic_correction", key, input)
        .complete(tx, value)
        .await
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
    let mut sql = sqlx::QueryBuilder::new(
        "SELECT c.body FROM semantic_corrections c JOIN knowledge_objects k ON k.id=c.object_id AND k.space_id=c.space_id WHERE c.space_id=",
    );
    sql.push_bind(&ctx.space_id)
        .push(" AND c.id>")
        .push_bind(after.unwrap_or(""))
        .push(" AND (")
        .push_bind(admin)
        .push("=1 OR c.submitter_id=")
        .push_bind(&ctx.user_id)
        .push(" OR JSON_CONTAINS( CAST(")
        .push_bind(sqlx::types::Json(managed))
        .push(" AS JSON),JSON_QUOTE(c.object_id)))");
    super::super::store::push_table_access(&mut sql, ctx);
    let rows = sql
        .push(" ORDER BY c.id LIMIT 51")
        .build()
        .fetch_all(tx.connection())
        .await?;
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

use crate::{
    persistence::AppTx,
    types::{AccessContext, Error, Result, epoch, fingerprint, id},
};
use serde_json::{Value, json};
use sqlx::Row;
fn body(r: &sqlx::mysql::MySqlRow) -> Value {
    let mut v = r.get::<sqlx::types::Json<Value>, _>("body").0;
    if let Ok(Some(state)) = r.try_get::<Option<String>, _>("index_state") {
        v["memory_index_state"] = json!(state);
    }
    v
}
pub async fn list_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    active: bool,
) -> Result<Vec<Value>> {
    let rows=sqlx::query("SELECT p.body,(SELECT j.state FROM personal_memory_index_jobs j WHERE j.asset_id=p.id AND j.asset_version=p.version AND j.owner_id=p.owner_id AND j.space_id=p.space_id AND j.index_target=? LIMIT 1) AS index_state FROM personal_assets p WHERE owner_id=? AND space_id=? AND state<>'deleted' AND (?=0 OR state='enabled') ORDER BY id").bind(super::memory_provider::index_target()).bind(&ctx.user_id).bind(&ctx.space_id).bind(active).fetch_all(tx.connection()).await?;
    Ok(rows.iter().map(body).collect())
}
pub async fn read_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    asset: &str,
    active: bool,
) -> Result<Value> {
    let row=sqlx::query("SELECT body FROM personal_assets WHERE id=? AND owner_id=? AND space_id=? AND state<>'deleted' AND (?=0 OR state='enabled')").bind(asset).bind(&ctx.user_id).bind(&ctx.space_id).bind(active).fetch_optional(tx.connection()).await?.ok_or(Error::new("not_available"))?;
    Ok(body(&row))
}
async fn begin_operation(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    key: &str,
    input: &Value,
) -> Result<Option<Value>> {
    // 先锁唯一操作身份，再核对业务版本；同参重传接回原回执。
    sqlx::query("INSERT INTO asset_operations(owner_id,operation_id,fingerprint,receipt) VALUES(?,?,?,CAST('null' AS JSON)) ON DUPLICATE KEY UPDATE operation_id=VALUES(operation_id)")
        .bind(&ctx.user_id).bind(key).bind(fingerprint(input)).execute(tx.connection()).await?;
    let row = sqlx::query("SELECT fingerprint,receipt FROM asset_operations WHERE owner_id=? AND operation_id=? FOR UPDATE")
        .bind(&ctx.user_id).bind(key).fetch_one(tx.connection()).await?;
    if row.get::<String, _>("fingerprint") != fingerprint(input) {
        return Err(Error::new("idempotency_conflict"));
    }
    let receipt = row.get::<sqlx::types::Json<Value>, _>("receipt").0;
    if !receipt.is_null() {
        return Ok(Some(receipt));
    }
    Ok(None)
}
async fn persist(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    key: &str,
    input: &Value,
    value: &Value,
) -> Result<()> {
    sqlx::query("INSERT INTO personal_assets(id,owner_id,space_id,version,kind,state,body) VALUES(?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE version=VALUES(version),state=VALUES(state),body=VALUES(body)").bind(value["id"].as_str()).bind(&ctx.user_id).bind(&ctx.space_id).bind(epoch(value["version"].as_str().unwrap_or("0"))?).bind(value["kind"].as_str()).bind(value["state"].as_str()).bind(sqlx::types::Json(value)).execute(tx.connection()).await?;
    sqlx::query("INSERT INTO personal_asset_versions(asset_id,version,body) VALUES(?,?,?)")
        .bind(value["id"].as_str())
        .bind(epoch(value["version"].as_str().unwrap_or("0"))?)
        .bind(sqlx::types::Json(value))
        .execute(tx.connection())
        .await?;
    record_operation(tx, ctx, key, input, value).await
}
async fn record_operation(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    key: &str,
    input: &Value,
    value: &Value,
) -> Result<()> {
    sqlx::query(
        "UPDATE asset_operations SET receipt=? WHERE owner_id=? AND operation_id=? AND fingerprint=?",
    )
    .bind(sqlx::types::Json(value))
    .bind(&ctx.user_id)
    .bind(key)
    .bind(fingerprint(input))
    .execute(tx.connection())
    .await?;
    Ok(())
}
async fn locked(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    asset: &str,
    expected: &str,
) -> Result<Value> {
    let row=sqlx::query("SELECT body FROM personal_assets WHERE id=? AND owner_id=? AND space_id=? AND state<>'deleted' FOR UPDATE").bind(asset).bind(&ctx.user_id).bind(&ctx.space_id).fetch_optional(tx.connection()).await?.ok_or(Error::new("not_available"))?;
    let v = body(&row);
    if v["version"] != expected {
        return Err(Error::new("version_conflict"));
    }
    Ok(v)
}
pub async fn begin_save_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    input: &Value,
) -> Result<Option<Value>> {
    let key = input["operation_id"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?;
    begin_operation(tx, ctx, key, input).await
}
pub async fn begin_selection_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    input: &Value,
) -> Result<Option<Value>> {
    let key = input["operation_id"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?;
    begin_operation(
        tx,
        ctx,
        key,
        &json!({"action":"select_skill","conversation_id":cid,"input":input}),
    )
    .await
}
pub async fn save_in_tx(tx: &mut AppTx<'_>, ctx: &AccessContext, input: &Value) -> Result<Value> {
    let key = input["operation_id"].as_str().unwrap_or("");
    if let Some(v) = begin_operation(tx, ctx, key, input).await? {
        return Ok(v);
    }
    let (asset, version, state) = if let Some(asset) = input["id"].as_str() {
        let old = locked(
            tx,
            ctx,
            asset,
            input["expected_version"].as_str().unwrap_or(""),
        )
        .await?;
        if old["kind"] != input["kind"] {
            return Err(Error::new("invalid_input"));
        }
        (
            asset.to_string(),
            epoch(old["version"].as_str().unwrap_or("0"))? + 1,
            old["state"].clone(),
        )
    } else {
        if !input["expected_version"].is_null() {
            return Err(Error::new("version_conflict"));
        }
        (id(), 1, json!("enabled"))
    };
    let v = json!({"id":asset,"kind":input["kind"],"name":input["name"],"body":input["body"],"scope":input["scope"],"version":version.to_string(),"state":state,"verified":input["verified"],"source_text":input["source_text"],"dependencies":input["dependencies"],"selected":false});
    persist(tx, ctx, key, input, &v).await?;
    Ok(v)
}
pub async fn change_state_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    asset: &str,
    input: &Value,
    state: &str,
) -> Result<Value> {
    let command = json!({"asset_id":asset,"input":input,"state":state});
    let key = input["operation_id"].as_str().unwrap_or("");
    if let Some(v) = begin_operation(tx, ctx, key, &command).await? {
        return Ok(v);
    }
    let mut v = locked(
        tx,
        ctx,
        asset,
        input["expected_version"].as_str().unwrap_or(""),
    )
    .await?;
    v["state"] = json!(state);
    v["selected"] = json!(false);
    v["version"] = json!((epoch(v["version"].as_str().unwrap_or("0"))? + 1).to_string());
    persist(tx, ctx, key, &command, &v).await?;
    Ok(v)
}
pub async fn select_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    input: &Value,
) -> Result<Value> {
    let key = input["operation_id"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?;
    let command = json!({"action":"select_skill","conversation_id":cid,"input":input});
    if let Some(receipt) = begin_operation(tx, ctx, key, &command).await? {
        return Ok(receipt);
    }
    let asset = input["asset_id"].as_str().unwrap_or("");
    let v = read_in_tx(tx, ctx, asset, true).await?;
    if v["kind"] != "skill" || v["version"] != input["version"] {
        return Err(Error::new("version_conflict"));
    }
    sqlx::query("INSERT INTO skill_selections(id,owner_id,conversation_id,asset_id,asset_version) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE asset_version=VALUES(asset_version)").bind(id()).bind(&ctx.user_id).bind(cid).bind(asset).bind(epoch(input["version"].as_str().unwrap_or("0"))?).execute(tx.connection()).await?;
    let mut v = v;
    v["selected"] = json!(true);
    record_operation(tx, ctx, key, &command, &v).await?;
    Ok(v)
}
pub async fn selected_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
) -> Result<Vec<Value>> {
    let rows=sqlx::query("SELECT p.body FROM personal_assets p JOIN skill_selections s ON p.id=s.asset_id AND p.version=s.asset_version WHERE p.owner_id=? AND p.space_id=? AND p.state='enabled' AND s.owner_id=? AND s.conversation_id=?").bind(&ctx.user_id).bind(&ctx.space_id).bind(&ctx.user_id).bind(cid).fetch_all(tx.connection()).await?;
    Ok(rows
        .iter()
        .map(|r| {
            let mut v = body(r);
            v["selected"] = json!(true);
            v
        })
        .collect())
}
pub async fn record_adoption_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    run: &str,
    v: &Value,
    kind: &str,
) -> Result<()> {
    sqlx::query("INSERT IGNORE INTO asset_adoptions(id,owner_id,asset_id,asset_version,run_id,usage_kind) VALUES(?,?,?,?,?,?)").bind(id()).bind(&ctx.user_id).bind(v["id"].as_str()).bind(epoch(v["version"].as_str().unwrap_or("0"))?).bind(run).bind(kind).execute(tx.connection()).await?;
    Ok(())
}

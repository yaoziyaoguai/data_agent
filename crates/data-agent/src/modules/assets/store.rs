use crate::{
    persistence::AppTx,
    types::{AccessContext, Error, Result, epoch, fingerprint, id},
};
use serde_json::{Value, json};
use sqlx::Row;
fn body(r: &sqlx::mysql::MySqlRow) -> Value {
    let mut v = r.get::<sqlx::types::Json<Value>, _>("body").0;
    v["owner_id"] = json!(r.get::<String, _>("owner_id"));
    v["visibility"] = json!(r.get::<String, _>("visibility"));
    if v.get("files").is_none() {
        v["files"] = json!([]);
    }
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
    let rows=sqlx::query("SELECT p.body,p.owner_id,p.visibility,(SELECT j.state FROM personal_memory_index_jobs j WHERE j.asset_id=p.id AND j.asset_version=p.version AND j.owner_id=p.owner_id AND j.space_id=p.space_id AND j.index_target=? LIMIT 1) AS index_state FROM personal_assets p WHERE (owner_id=? OR (visibility='space' AND kind='skill')) AND space_id=? AND state<>'deleted' AND (?=0 OR state='enabled') ORDER BY id").bind(super::memory_provider::index_target()).bind(&ctx.user_id).bind(&ctx.space_id).bind(active).fetch_all(tx.connection()).await?;
    Ok(rows.iter().map(body).collect())
}
pub async fn read_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    asset: &str,
    active: bool,
) -> Result<Value> {
    let row=sqlx::query("SELECT body,owner_id,visibility FROM personal_assets WHERE id=? AND (owner_id=? OR (visibility='space' AND kind='skill')) AND space_id=? AND state<>'deleted' AND (?=0 OR state='enabled')").bind(asset).bind(&ctx.user_id).bind(&ctx.space_id).bind(active).fetch_optional(tx.connection()).await?.ok_or(Error::new("not_available"))?;
    Ok(body(&row))
}
async fn begin_operation(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    key: &str,
    input: &Value,
) -> Result<Option<Value>> {
    // 先锁唯一操作身份，再核对业务版本；同参重传接回原回执。
    sqlx::query("INSERT INTO asset_operations(owner_id,space_id,operation_id,fingerprint,receipt) VALUES(?,?,?,?,CAST('null' AS JSON)) ON DUPLICATE KEY UPDATE operation_id=VALUES(operation_id)")
        .bind(&ctx.user_id).bind(&ctx.space_id).bind(key).bind(fingerprint(input)).execute(tx.connection()).await?;
    let row = sqlx::query("SELECT fingerprint,receipt FROM asset_operations WHERE owner_id=? AND space_id=? AND operation_id=? FOR UPDATE")
        .bind(&ctx.user_id).bind(&ctx.space_id).bind(key).fetch_one(tx.connection()).await?;
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
    sqlx::query("INSERT INTO personal_assets(id,owner_id,space_id,version,kind,state,body,visibility) VALUES(?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE version=VALUES(version),state=VALUES(state),body=VALUES(body)").bind(value["id"].as_str()).bind(value["owner_id"].as_str().unwrap_or(&ctx.user_id)).bind(&ctx.space_id).bind(epoch(value["version"].as_str().unwrap_or("0"))?).bind(value["kind"].as_str()).bind(value["state"].as_str()).bind(sqlx::types::Json(value)).bind(value["visibility"].as_str().unwrap_or("personal")).execute(tx.connection()).await?;
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
        "UPDATE asset_operations SET receipt=? WHERE owner_id=? AND space_id=? AND operation_id=? AND fingerprint=?",
    )
    .bind(sqlx::types::Json(value))
    .bind(&ctx.user_id)
    .bind(&ctx.space_id)
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
    let row=sqlx::query("SELECT body,owner_id,visibility FROM personal_assets WHERE id=? AND (owner_id=? OR (visibility='space' AND kind='skill')) AND space_id=? AND state<>'deleted' FOR UPDATE").bind(asset).bind(&ctx.user_id).bind(&ctx.space_id).fetch_optional(tx.connection()).await?.ok_or(Error::new("not_available"))?;
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
    save_authorized_in_tx(tx, ctx, input, false).await
}
pub async fn save_authorized_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    input: &Value,
    can_admin: bool,
) -> Result<Value> {
    let key = input["operation_id"].as_str().unwrap_or("");
    if let Some(v) = begin_operation(tx, ctx, key, input).await? {
        return Ok(v);
    }
    let (asset, version, state, owner, visibility, files) =
        if let Some(asset) = input["id"].as_str() {
            let old = locked(
                tx,
                ctx,
                asset,
                input["expected_version"].as_str().unwrap_or(""),
            )
            .await?;
            require_edit(ctx, &old, can_admin)?;
            if old["kind"] != input["kind"] {
                return Err(Error::new("invalid_input"));
            }
            (
                asset.to_string(),
                epoch(old["version"].as_str().unwrap_or("0"))? + 1,
                old["state"].clone(),
                old["owner_id"].clone(),
                old["visibility"].clone(),
                input
                    .get("files")
                    .cloned()
                    .unwrap_or_else(|| old["files"].clone()),
            )
        } else {
            if !input["expected_version"].is_null() {
                return Err(Error::new("version_conflict"));
            }
            (
                id(),
                1,
                json!("enabled"),
                json!(ctx.user_id),
                json!("personal"),
                input.get("files").cloned().unwrap_or(json!([])),
            )
        };
    super::skill_files::validate(&input["kind"], &files)?;
    let v = json!({"owner_id":owner,"visibility":visibility,"files":files,"id":asset,"kind":input["kind"],"name":input["name"],"body":input["body"],"scope":input["scope"],"version":version.to_string(),"state":state,"verified":input["verified"],"source_text":if visibility=="space" { json!("") } else { input["source_text"].clone() },"dependencies":input["dependencies"],"selected":false});
    if v["kind"] == "skill" {
        super::skill_files::content(&v, "SKILL.md")?;
    }
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
    change_state_authorized_in_tx(tx, ctx, asset, input, state, false).await
}
pub async fn change_state_authorized_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    asset: &str,
    input: &Value,
    state: &str,
    can_admin: bool,
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
    require_edit(ctx, &v, can_admin)?;
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
    super::skill_files::content(&v, "SKILL.md")?;
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
    let rows=sqlx::query("SELECT p.body,p.owner_id,p.visibility FROM personal_assets p JOIN skill_selections s ON p.id=s.asset_id AND p.version=s.asset_version WHERE (p.owner_id=? OR (p.visibility='space' AND p.kind='skill')) AND p.space_id=? AND p.state='enabled' AND s.owner_id=? AND s.conversation_id=?").bind(&ctx.user_id).bind(&ctx.space_id).bind(&ctx.user_id).bind(cid).fetch_all(tx.connection()).await?;
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

pub fn can_edit(ctx: &AccessContext, asset: &Value, can_admin: bool) -> bool {
    asset["owner_id"] == ctx.user_id || (asset["visibility"] == "space" && can_admin)
}
fn require_edit(ctx: &AccessContext, asset: &Value, can_admin: bool) -> Result<()> {
    if !can_edit(ctx, asset, can_admin) {
        return Err(Error::new("forbidden"));
    }
    Ok(())
}
pub async fn publish_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    asset: &str,
    input: &Value,
) -> Result<Value> {
    let key = input["operation_id"].as_str().unwrap_or("");
    let command =
        json!({"action":"publish_skill","space_id":ctx.space_id,"asset_id":asset,"input":input});
    if let Some(v) = begin_operation(tx, ctx, key, &command).await? {
        return Ok(v);
    }
    let mut value = locked(
        tx,
        ctx,
        asset,
        input["expected_version"].as_str().unwrap_or(""),
    )
    .await?;
    if value["owner_id"] != ctx.user_id
        || value["visibility"] != "personal"
        || value["kind"] != "skill"
        || value["state"] != "enabled"
    {
        return Err(Error::new("not_available"));
    }
    let exists: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM skill_publications WHERE source_asset_id=?")
            .bind(asset)
            .fetch_one(tx.connection())
            .await?;
    if exists > 0 {
        return Err(Error::new("skill_already_published"));
    }
    super::skill_files::content(&value, "SKILL.md")?;
    let source_version = epoch(value["version"].as_str().unwrap_or("0"))?;
    value["id"] = json!(id());
    value["version"] = json!("1");
    value["visibility"] = json!("space");
    value["source_text"] = json!("");
    value["selected"] = json!(false);
    persist(tx, ctx, key, &command, &value).await?;
    sqlx::query("INSERT INTO skill_publications(source_asset_id,public_asset_id,source_version,space_id) VALUES(?,?,?,?)").bind(asset).bind(value["id"].as_str()).bind(source_version).bind(&ctx.space_id).execute(tx.connection()).await?;
    Ok(value)
}
pub async fn selection_page_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    after: &str,
) -> Result<Vec<Value>> {
    let rows=sqlx::query("SELECT s.asset_id,s.asset_version,p.body,p.owner_id,p.visibility FROM skill_selections s LEFT JOIN personal_assets p ON p.id=s.asset_id AND p.space_id=? AND p.state<>'deleted' AND (p.owner_id=? OR (p.visibility='space' AND p.kind='skill')) WHERE s.owner_id=? AND s.conversation_id=? AND s.asset_id>? ORDER BY s.asset_id LIMIT 51").bind(&ctx.space_id).bind(&ctx.user_id).bind(&ctx.user_id).bind(cid).bind(after).fetch_all(tx.connection()).await?;
    Ok(rows.iter().map(|r| {
        let current = r.get::<Option<sqlx::types::Json<Value>>, _>("body").map(|_| body(r)).unwrap_or(Value::Null);
        json!({"asset_id":r.get::<String,_>("asset_id"),"selected_version":r.get::<u64,_>("asset_version").to_string(),"asset":current})
    }).collect())
}
async fn require_shared(tx: &mut AppTx<'_>, ctx: &AccessContext, asset: &str) -> Result<Value> {
    let v = read_in_tx(tx, ctx, asset, false).await?;
    if v["visibility"] != "space" || v["kind"] != "skill" {
        return Err(Error::new("not_available"));
    }
    Ok(v)
}
pub async fn suggestions_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    asset: &str,
    after: &str,
) -> Result<Value> {
    require_shared(tx, ctx, asset).await?;
    let rows=sqlx::query("SELECT body FROM skill_suggestions WHERE asset_id=? AND space_id=? AND id>? ORDER BY id LIMIT 51").bind(asset).bind(&ctx.space_id).bind(after).fetch_all(tx.connection()).await?;
    let mut items: Vec<Value> = rows
        .iter()
        .map(|r| r.get::<sqlx::types::Json<Value>, _>("body").0)
        .collect();
    let next = if items.len() > 50 {
        items.truncate(50);
        items.last().map(|v| v["id"].clone())
    } else {
        None
    };
    Ok(json!({"suggestions":items,"next_after_id":next}))
}
pub async fn suggest_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    asset: &str,
    input: &Value,
) -> Result<Value> {
    let key = input["operation_id"].as_str().unwrap_or("");
    let command =
        json!({"action":"suggest_skill","space_id":ctx.space_id,"asset_id":asset,"input":input});
    let current = require_shared(tx, ctx, asset).await?;
    if let Some(v) = begin_operation(tx, ctx, key, &command).await? {
        return Ok(v);
    }
    if current["version"] != input["expected_version"] {
        return Err(Error::new("version_conflict"));
    }
    if input["content"].as_str().unwrap_or("").trim().is_empty() {
        return Err(Error::new("invalid_input"));
    }
    let v = json!({"id":id(),"asset_id":asset,"author_id":ctx.user_id,"asset_version":current["version"],"content":input["content"],"state":"pending","revision":"1","response":"","reviewed_by":null});
    sqlx::query(
        "INSERT INTO skill_suggestions(id,asset_id,space_id,revision,body) VALUES(?,?,?,1,?)",
    )
    .bind(v["id"].as_str())
    .bind(asset)
    .bind(&ctx.space_id)
    .bind(sqlx::types::Json(&v))
    .execute(tx.connection())
    .await?;
    record_operation(tx, ctx, key, &command, &v).await?;
    Ok(v)
}
pub async fn review_suggestion_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    asset: &str,
    suggestion: &str,
    input: &Value,
    can_admin: bool,
) -> Result<Value> {
    let current = require_shared(tx, ctx, asset).await?;
    require_edit(ctx, &current, can_admin)?;
    let key = input["operation_id"].as_str().unwrap_or("");
    let command = json!({"action":"review_skill_suggestion","space_id":ctx.space_id,"asset_id":asset,"suggestion_id":suggestion,"input":input});
    if let Some(v) = begin_operation(tx, ctx, key, &command).await? {
        return Ok(v);
    }
    let row = sqlx::query(
        "SELECT body FROM skill_suggestions WHERE id=? AND asset_id=? AND space_id=? FOR UPDATE",
    )
    .bind(suggestion)
    .bind(asset)
    .bind(&ctx.space_id)
    .fetch_optional(tx.connection())
    .await?
    .ok_or(Error::new("not_available"))?;
    let mut v = row.get::<sqlx::types::Json<Value>, _>("body").0;
    if v["revision"] != input["expected_revision"] || v["state"] != "pending" {
        return Err(Error::new("version_conflict"));
    }
    if input["response"].as_str().unwrap_or("").trim().is_empty() {
        return Err(Error::new("invalid_input"));
    }
    v["state"] = input["state"].clone();
    v["response"] = input["response"].clone();
    v["reviewed_by"] = json!(ctx.user_id);
    let revision = epoch(v["revision"].as_str().unwrap_or("0"))? + 1;
    v["revision"] = json!(revision.to_string());
    sqlx::query("UPDATE skill_suggestions SET revision=?,body=? WHERE id=?")
        .bind(revision)
        .bind(sqlx::types::Json(&v))
        .bind(suggestion)
        .execute(tx.connection())
        .await?;
    record_operation(tx, ctx, key, &command, &v).await?;
    Ok(v)
}

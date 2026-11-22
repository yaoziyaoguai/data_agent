use crate::{
    persistence::{AppTx, receipts::Operation},
    types::{AccessContext, Error, Result, epoch, id},
};
use serde_json::{Value, json};
use sqlx::Row;

pub fn hide_skill_text(asset: &mut Value) {
    for field in ["name", "scope"] {
        asset[field] = json!("来源不可用，正文已隐藏");
    }
    for field in ["body", "source_text"] {
        asset[field] = json!("");
    }
    for field in ["files", "dependencies"] {
        asset[field] = json!([]);
    }
    asset["text_unavailable"] = json!(true);
}

fn without_skill_sources(mut asset: Value) -> Result<Value> {
    asset
        .as_object_mut()
        .ok_or(crate::types::Error::new("unavailable"))?
        .remove("skill_sources");
    Ok(asset)
}

fn body_with_sources(r: &sqlx::mysql::MySqlRow) -> Value {
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
    Ok(rows.iter().map(body_with_sources).collect())
}
pub async fn enabled_sources_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    ids: &[String],
) -> Result<std::collections::HashMap<(String, String), Vec<Value>>> {
    // 锁外读取资产目录后，提交前按(id,version)核对仍是当前有效版本。
    let mut result = std::collections::HashMap::new();
    for chunk in ids.chunks(500) {
        let mut query = sqlx::QueryBuilder::<sqlx::MySql>::new(
            "SELECT id AS asset_id, CAST(version AS CHAR) AS asset_version,JSON_EXTRACT(body,'$.dependencies') AS dependencies FROM personal_assets WHERE state='enabled' AND space_id=",
        );
        query.push_bind(&ctx.space_id).push(" AND (owner_id=");
        query
            .push_bind(&ctx.user_id)
            .push(" OR visibility='space') AND id IN (");
        let mut keys = query.separated(",");
        for id in chunk {
            keys.push_bind(id);
        }
        query.push(")");
        for row in query.build().fetch_all(tx.connection()).await? {
            result.insert(
                (
                    row.get::<String, _>("asset_id"),
                    row.get::<String, _>("asset_version"),
                ),
                row.get::<sqlx::types::Json<Vec<Value>>, _>("dependencies")
                    .0,
            );
        }
    }
    Ok(result)
}

pub async fn read_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    asset: &str,
    active: bool,
) -> Result<Value> {
    without_skill_sources(read_with_sources_in_tx(tx, ctx, asset, active).await?)
}

pub async fn read_with_sources_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    asset: &str,
    active: bool,
) -> Result<Value> {
    let row=sqlx::query("SELECT body,owner_id,visibility FROM personal_assets WHERE id=? AND (owner_id=? OR (visibility='space' AND kind='skill')) AND space_id=? AND state<>'deleted' AND (?=0 OR state='enabled')").bind(asset).bind(&ctx.user_id).bind(&ctx.space_id).bind(active).fetch_optional(tx.connection()).await?.ok_or(Error::new("not_available"))?;
    Ok(body_with_sources(&row))
}
// 快照/历史核验的批量读取：与单条read_in_tx(active=true)同一可见性语义，
// 把N+1循环合并为一条IN查询；缺失项由调用方按原not_available处理。
pub async fn read_enabled_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    ids: &[String],
) -> Result<std::collections::HashMap<String, Value>> {
    read_assets_with_sources_in_tx(tx, ctx, ids, true).await
}

pub async fn read_assets_with_sources_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    ids: &[String],
    active: bool,
) -> Result<std::collections::HashMap<String, Value>> {
    let mut assets = std::collections::HashMap::new();
    for chunk in ids.chunks(500) {
        let mut query = sqlx::QueryBuilder::<sqlx::MySql>::new(
            "SELECT id,body,owner_id,visibility FROM personal_assets WHERE (owner_id=",
        );
        query
            .push_bind(&ctx.user_id)
            .push(" OR (visibility='space' AND kind='skill')) AND space_id=")
            .push_bind(&ctx.space_id)
            .push(" AND state NOT IN ('deleted','draft') AND (")
            .push_bind(active)
            .push("=FALSE OR state='enabled') AND id IN (");
        let mut keys = query.separated(",");
        for id in chunk {
            keys.push_bind(id);
        }
        query.push(")");
        for row in query.build().fetch_all(tx.connection()).await? {
            assets.insert(row.get::<String, _>("id"), body_with_sources(&row));
        }
    }
    Ok(assets)
}
pub async fn version_skill_sources_in_tx(
    tx: &mut AppTx<'_>,
    asset: &Value,
) -> Result<Option<Value>> {
    let id = asset["id"]
        .as_str()
        .ok_or(crate::types::Error::new("unavailable"))?;
    let version = epoch(
        asset["version"]
            .as_str()
            .ok_or(crate::types::Error::new("unavailable"))?,
    )?;
    let sources = sqlx::query_scalar::<_, Option<sqlx::types::Json<Value>>>(
        "SELECT JSON_EXTRACT(body,'$.skill_sources') FROM personal_asset_versions WHERE asset_id=? AND version=?",
    )
    .bind(id)
    .bind(version)
    .fetch_one(tx.connection())
    .await?;
    Ok(sources.map(|proof| proof.0))
}
async fn begin_operation(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    key: &str,
    input: &Value,
) -> Result<Option<Value>> {
    Operation::new(ctx, "asset", key, input).begin(tx).await
}

async fn persist(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    key: &str,
    input: &Value,
    value: &Value,
) -> Result<Value> {
    sqlx::query("INSERT INTO personal_assets(id,owner_id,space_id,version,kind,state,body,visibility) VALUES(?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE version=VALUES(version),state=VALUES(state),body=VALUES(body)").bind(value["id"].as_str()).bind(value["owner_id"].as_str().unwrap_or(&ctx.user_id)).bind(&ctx.space_id).bind(epoch(value["version"].as_str().unwrap_or("0"))?).bind(value["kind"].as_str()).bind(value["state"].as_str()).bind(sqlx::types::Json(value)).bind(value["visibility"].as_str().unwrap_or("personal")).execute(tx.connection()).await?;
    sqlx::query("INSERT INTO personal_asset_versions(asset_id,version,body) VALUES(?,?,?)")
        .bind(value["id"].as_str())
        .bind(epoch(value["version"].as_str().unwrap_or("0"))?)
        .bind(sqlx::types::Json(value))
        .execute(tx.connection())
        .await?;
    let receipt = without_skill_sources(value.clone())?;
    record_operation(tx, ctx, key, input, &receipt).await?;
    Ok(receipt)
}
async fn record_operation(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    key: &str,
    input: &Value,
    value: &Value,
) -> Result<()> {
    Operation::new(ctx, "asset", key, input)
        .complete(tx, value)
        .await
}

async fn locked(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    asset: &str,
    expected: &str,
    include_draft: bool,
) -> Result<Value> {
    let row=sqlx::query("SELECT body,owner_id,visibility FROM personal_assets WHERE id=? AND (owner_id=? OR (visibility='space' AND kind='skill')) AND space_id=? AND state<>'deleted' AND (? OR state<>'draft') FOR UPDATE").bind(asset).bind(&ctx.user_id).bind(&ctx.space_id).bind(include_draft).fetch_optional(tx.connection()).await?.ok_or(Error::new("not_available"))?;
    let v = body_with_sources(&row);
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
pub async fn begin_removal_in_tx(
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
        &json!({"action":"remove_skill","conversation_id":cid,"input":input}),
    )
    .await
}

pub async fn remove_selection_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    input: &Value,
) -> Result<Value> {
    let key = input["operation_id"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?;
    let command = json!({"action":"remove_skill","conversation_id":cid,"input":input});
    if let Some(receipt) = begin_operation(tx, ctx, key, &command).await? {
        return Ok(receipt);
    }
    // 选择身份在明确重选时变化；旧页面或晚到请求不能移除新的选择。
    let removed = sqlx::query("DELETE FROM skill_selections WHERE id=? AND owner_id=? AND conversation_id=? AND asset_id=?")
        .bind(input["selection_id"].as_str()).bind(&ctx.user_id).bind(cid).bind(input["asset_id"].as_str())
        .execute(tx.connection()).await?;
    if removed.rows_affected() != 1 {
        return Err(Error::new("version_conflict"));
    }
    let receipt = json!({"operation_id":key,"conversation_id":cid,"asset_id":input["asset_id"],"selection_id":input["selection_id"],"state":"removed"});
    record_operation(tx, ctx, key, &command, &receipt).await?;
    Ok(receipt)
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
    save_with_skill_sources_in_tx(tx, ctx, input, can_admin, None).await
}

pub async fn save_with_skill_sources_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    input: &Value,
    can_admin: bool,
    mut skill_sources: Option<Value>,
) -> Result<Value> {
    let key = input["operation_id"].as_str().unwrap_or("");
    if let Some(v) = begin_operation(tx, ctx, key, input).await? {
        return Ok(v);
    }
    let (asset, version, state, owner, visibility, files) =
        if let Some(asset) = input["id"].as_str() {
            let mut old = locked(
                tx,
                ctx,
                asset,
                input["expected_version"].as_str().unwrap_or(""),
                false,
            )
            .await?;
            require_edit(ctx, &old, can_admin)?;
            if old["kind"] != input["kind"] {
                return Err(Error::new("invalid_input"));
            }
            let replaces_contents = if ["name", "body", "scope", "source_text"]
                .into_iter()
                .all(|field| input[field] != old[field])
                && let Some(files) = input.get("files")
            {
                // 完整人工重写可解除旧来源。沿用任何旧附件时仍保留来源。
                let previous = old["files"].as_array().ok_or(Error::new("unavailable"))?;
                files
                    .as_array()
                    .ok_or(Error::new("invalid_input"))?
                    .iter()
                    .all(|file| !previous.contains(file))
            } else {
                false
            };
            skill_sources = if replaces_contents {
                None
            } else {
                old.as_object_mut()
                    .ok_or(crate::types::Error::new("unavailable"))?
                    .remove("skill_sources")
            };
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
            let draft = input["draft_id"].as_str();
            (
                draft.map(str::to_owned).unwrap_or_else(id),
                if draft.is_some() { 2 } else { 1 },
                json!("enabled"),
                json!(ctx.user_id),
                json!("personal"),
                input.get("files").cloned().unwrap_or(json!([])),
            )
        };
    super::skill_files::validate(&input["kind"], &files)?;
    let mut v = json!({"owner_id":owner,"visibility":visibility,"files":files,"id":asset,"kind":input["kind"],"name":input["name"],"body":input["body"],"scope":input["scope"],"version":version.to_string(),"state":state,"verified":input["verified"],"source_text":if visibility=="space" { json!("") } else { input["source_text"].clone() },"dependencies":input["dependencies"],"selected":false});
    if v["kind"] == "skill" {
        super::skill_files::content(&v, "SKILL.md")?;
    }
    if let Some(sources) = skill_sources {
        v["skill_sources"] = sources;
    }
    persist(tx, ctx, key, input, &v).await
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
        state == "deleted",
    )
    .await?;
    require_edit(ctx, &v, can_admin)?;
    if v["state"] == "draft" {
        super::skill_drafts::invalidate_in_tx(tx, ctx, asset, "sources_unavailable").await?;
        // 草稿从未形成正式 Skill 版本。保留删除回执，正文与待确认依据由草稿入口清除。
        v["state"] = json!("deleted");
        hide_skill_text(&mut v);
        let receipt = without_skill_sources(v)?;
        record_operation(tx, ctx, key, &command, &receipt).await?;
        return Ok(receipt);
    }
    v["state"] = json!(state);
    v["selected"] = json!(false);
    v["version"] = json!((epoch(v["version"].as_str().unwrap_or("0"))? + 1).to_string());
    persist(tx, ctx, key, &command, &v).await
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
    sqlx::query("INSERT INTO skill_selections(id,owner_id,conversation_id,asset_id,asset_version) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE id=VALUES(id),asset_version=VALUES(asset_version)").bind(id()).bind(&ctx.user_id).bind(cid).bind(asset).bind(epoch(input["version"].as_str().unwrap_or("0"))?).execute(tx.connection()).await?;
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
            let mut v = body_with_sources(r);
            v["selected"] = json!(true);
            v
        })
        .collect())
}

pub(crate) const WORKSPACE_ASSETS_SQL: &str = "workspace_assets AS (
    SELECT p.id, JSON_SET(p.body,'$.owner_id',p.owner_id,'$.visibility',p.visibility,
        '$.files',IFNULL(JSON_EXTRACT(p.body,'$.files'),JSON_ARRAY()),
        '$.selected',CAST(IF(p.kind='skill','true','false') AS JSON)) AS body
    FROM delivery_input i JOIN personal_assets p ON p.space_id=i.space_id AND p.state='enabled'
    LEFT JOIN skill_selections s ON p.id=s.asset_id AND p.version=s.asset_version
          AND s.owner_id=i.owner_id AND s.conversation_id=i.conversation_id
    WHERE (p.kind='memory' AND p.owner_id=i.owner_id) OR
          (p.kind='skill' AND s.asset_id IS NOT NULL AND (p.owner_id=i.owner_id OR p.visibility='space'))
)";

pub(crate) fn push_checkpoint_asset_heads(
    sql: &mut sqlx::QueryBuilder<sqlx::MySql>,
    ctx: &AccessContext,
    ids: &[&str],
    workspace: bool,
) {
    sql.push(
        "checkpoint_asset_heads AS (
        SELECT p.id,p.version,JSON_EXTRACT(p.body,'$.dependencies') AS dependencies
        FROM personal_assets p WHERE p.state='enabled' AND p.space_id=",
    )
    .push_bind(&ctx.space_id)
    .push(" AND (p.owner_id=")
    .push_bind(&ctx.user_id)
    .push(
        " OR (p.kind='skill' AND p.visibility='space'))
        AND p.id IN (SELECT id FROM JSON_TABLE(CAST(",
    )
    .push_bind(sqlx::types::Json(ids))
    .push(" AS JSON),'$[*]' COLUMNS(id VARCHAR(64) PATH '$')) refs");
    if workspace {
        sql.push(" UNION DISTINCT SELECT ref.id FROM workspace_assets w,
            JSON_TABLE(CAST(w.body AS JSON),'$.skill_sources.source_skills[*]' COLUMNS(id VARCHAR(64) PATH '$[0]')) ref");
    }
    sql.push("))");
}

pub(crate) const WORKSPACE_SELECTED_PROVENANCE_SQL: &str = "(SELECT JSON_ARRAYAGG(
    JSON_OBJECT('id',p.id,'version',CAST(p.version AS CHAR),'kind','skill',
        'dependencies',JSON_EXTRACT(p.body,'$.dependencies'),
        'skill_sources',JSON_EXTRACT(p.body,'$.skill_sources')))
    FROM skill_selections s JOIN personal_assets p ON p.id=s.asset_id AND p.version=s.asset_version
    WHERE s.owner_id=i.owner_id AND s.conversation_id=i.conversation_id AND p.space_id=i.space_id
       AND p.kind='skill' AND p.state='enabled' AND (p.owner_id=i.owner_id OR p.visibility='space')
       AND JSON_CONTAINS_PATH(p.body,'one','$.skill_sources')) AS selected_skill_provenance";

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
        false,
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
    let receipt = persist(tx, ctx, key, &command, &value).await?;
    sqlx::query("INSERT INTO skill_publications(source_asset_id,public_asset_id,source_version,space_id) VALUES(?,?,?,?)").bind(asset).bind(value["id"].as_str()).bind(source_version).bind(&ctx.space_id).execute(tx.connection()).await?;
    Ok(receipt)
}
pub async fn selection_page_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    after: &str,
) -> Result<Vec<Value>> {
    let rows=sqlx::query("SELECT s.id AS selection_id,s.asset_id,s.asset_version,p.body,p.owner_id,p.visibility FROM skill_selections s LEFT JOIN personal_assets p ON p.id=s.asset_id AND p.space_id=? AND p.state<>'deleted' AND (p.owner_id=? OR (p.visibility='space' AND p.kind='skill')) WHERE s.owner_id=? AND s.conversation_id=? AND s.asset_id>? ORDER BY s.asset_id LIMIT 51").bind(&ctx.space_id).bind(&ctx.user_id).bind(&ctx.user_id).bind(cid).bind(after).fetch_all(tx.connection()).await?;
    Ok(rows.iter().map(|r| {
        let current = r.get::<Option<sqlx::types::Json<Value>>, _>("body").map(|_| body_with_sources(r)).unwrap_or(Value::Null);
        json!({"selection_id":r.get::<String,_>("selection_id"),"asset_id":r.get::<String,_>("asset_id"),"selected_version":r.get::<u64,_>("asset_version").to_string(),"asset":current})
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

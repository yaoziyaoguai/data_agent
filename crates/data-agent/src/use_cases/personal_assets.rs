use crate::{
    contracts,
    modules::{access, assets, conversations},
    persistence::AppTx,
    types::{AccessContext, Error, Result},
};
use serde_json::{Value, json};
use sqlx::MySqlPool;
pub async fn list(pool: &MySqlPool, ctx: &AccessContext) -> Result<Value> {
    let mut tx = AppTx::begin(pool).await?;
    let mut v = assets::list_in_tx(&mut tx, ctx, false).await?;
    let can_admin = access::is_super_maintainer(ctx)?;
    for asset in &mut v {
        asset["can_edit"] = json!(assets::can_edit(ctx, asset, can_admin));
    }
    tx.commit().await?;
    Ok(json!({"assets":v}))
}
pub async fn save(pool: &MySqlPool, ctx: &AccessContext, input: Value) -> Result<Value> {
    contracts::validate("AssetSave", &input)?;
    let mut tx = AppTx::begin(pool).await?;
    let v = if let Some(receipt) = assets::begin_save_in_tx(&mut tx, ctx, &input).await? {
        receipt
    } else {
        super::knowledge::check_refs_in_tx(&mut tx, ctx, &input["dependencies"]).await?;
        assets::save_authorized_in_tx(&mut tx, ctx, &input, access::is_super_maintainer(ctx)?)
            .await?
    };
    super::personal_memory::queue_in_tx(&mut tx, ctx, &v, None, None).await?;
    tx.commit().await?;
    Ok(v)
}
pub async fn state(
    pool: &MySqlPool,
    ctx: &AccessContext,
    asset: &str,
    input: Value,
    state: &str,
) -> Result<Value> {
    contracts::validate("VersionCommand", &input)?;
    if !matches!(state, "enabled" | "disabled" | "deleted") {
        return Err(Error::new("invalid_input"));
    }
    let mut tx = AppTx::begin(pool).await?;
    let v = assets::change_state_authorized_in_tx(
        &mut tx,
        ctx,
        asset,
        &input,
        state,
        access::is_super_maintainer(ctx)?,
    )
    .await?;
    super::personal_memory::queue_in_tx(&mut tx, ctx, &v, None, None).await?;
    tx.commit().await?;
    Ok(v)
}
pub async fn select(
    pool: &MySqlPool,
    ctx: &AccessContext,
    cid: &str,
    input: Value,
) -> Result<Value> {
    contracts::validate("SkillSelection", &input)?;
    let mut tx = AppTx::begin(pool).await?;
    conversations::lock_conversation_in_tx(&mut tx, ctx, cid).await?;
    let v = if let Some(receipt) = assets::begin_selection_in_tx(&mut tx, ctx, cid, &input).await? {
        receipt
    } else {
        let value = assets::select_in_tx(&mut tx, ctx, cid, &input).await?;
        super::knowledge::check_refs_in_tx(&mut tx, ctx, &value["dependencies"]).await?;
        value
    };
    tx.commit().await?;
    Ok(v)
}

pub async fn publish(
    pool: &MySqlPool,
    ctx: &AccessContext,
    asset: &str,
    input: Value,
) -> Result<Value> {
    contracts::validate("PublishSkill", &input)?;
    let mut tx = AppTx::begin(pool).await?;
    let value = assets::publish_in_tx(&mut tx, ctx, asset, &input).await?;
    super::knowledge::check_refs_in_tx(&mut tx, ctx, &value["dependencies"]).await?;
    tx.commit().await?;
    Ok(value)
}
pub async fn selections(
    pool: &MySqlPool,
    ctx: &AccessContext,
    cid: &str,
    after: &str,
) -> Result<Value> {
    let mut tx = AppTx::begin(pool).await?;
    conversations::lock_conversation_in_tx(&mut tx, ctx, cid).await?;
    let mut rows = assets::selection_page_in_tx(&mut tx, ctx, cid, after).await?;
    let next = if rows.len() > 50 {
        rows.truncate(50);
        rows.last().map(|r| r["asset_id"].clone())
    } else {
        None
    };
    let mut selections = Vec::new();
    for row in rows {
        let asset = &row["asset"];
        let availability = if asset.is_null() {
            "unavailable"
        } else if asset["state"] != "enabled" {
            "disabled"
        } else if asset["version"] != row["selected_version"] {
            "version_changed"
        } else {
            match super::knowledge::check_refs_in_tx(&mut tx, ctx, &asset["dependencies"]).await {
                Ok(()) => "available",
                Err(e) if matches!(e.code, "stale_knowledge" | "not_available") => {
                    "dependency_unavailable"
                }
                Err(e) => return Err(e),
            }
        };
        selections.push(json!({"asset_id":row["asset_id"],"selected_version":row["selected_version"],"current_version":asset["version"],"name":asset["name"],"visibility":asset["visibility"],"owner_id":asset["owner_id"],"availability":availability}));
    }
    tx.commit().await?;
    Ok(json!({"conversation_id":cid,"selections":selections,"next_after_id":next}))
}
pub async fn suggestions(
    pool: &MySqlPool,
    ctx: &AccessContext,
    asset: &str,
    after: &str,
) -> Result<Value> {
    let mut tx = AppTx::begin(pool).await?;
    let value = assets::suggestions_in_tx(&mut tx, ctx, asset, after).await?;
    tx.commit().await?;
    Ok(value)
}
pub async fn suggest(
    pool: &MySqlPool,
    ctx: &AccessContext,
    asset: &str,
    input: Value,
) -> Result<Value> {
    contracts::validate("SuggestSkill", &input)?;
    let mut tx = AppTx::begin(pool).await?;
    let value = assets::suggest_in_tx(&mut tx, ctx, asset, &input).await?;
    tx.commit().await?;
    Ok(value)
}
pub async fn review_suggestion(
    pool: &MySqlPool,
    ctx: &AccessContext,
    asset: &str,
    suggestion: &str,
    input: Value,
) -> Result<Value> {
    contracts::validate("ReviewSkillSuggestion", &input)?;
    let mut tx = AppTx::begin(pool).await?;
    let value = assets::review_suggestion_in_tx(
        &mut tx,
        ctx,
        asset,
        suggestion,
        &input,
        access::is_super_maintainer(ctx)?,
    )
    .await?;
    tx.commit().await?;
    Ok(value)
}

pub async fn read_skill_file_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    run: &str,
    path: &str,
) -> Result<Value> {
    let (id, version, file) = assets::skill_files::parse_location(path)?;
    let asset = assets::read_in_tx(tx, ctx, id, true).await?;
    if asset["kind"] != "skill" || asset["version"] != version {
        return Err(Error::new("stale_knowledge"));
    }
    if !assets::selected_in_tx(tx, ctx, cid)
        .await?
        .iter()
        .any(|v| v["id"] == id && v["version"] == version)
    {
        return Err(Error::new("selection_required"));
    }
    super::knowledge::check_refs_in_tx(tx, ctx, &asset["dependencies"]).await?;
    let text = assets::skill_files::content(&asset, file)?;
    assets::record_adoption_in_tx(tx, ctx, run, &asset, "read").await?;
    Ok(json!({"id":id,"kind":"skill","version":version,"path":path,"text":text}))
}

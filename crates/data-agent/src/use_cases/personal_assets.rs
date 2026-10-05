use crate::{
    contracts,
    modules::{assets, conversations},
    persistence::AppTx,
    types::{AccessContext, Error, Result},
};
use serde_json::{Value, json};
use sqlx::MySqlPool;
pub async fn list(pool: &MySqlPool, ctx: &AccessContext) -> Result<Value> {
    let mut tx = AppTx::begin(pool).await?;
    let v = assets::list_in_tx(&mut tx, ctx, false).await?;
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
        assets::save_in_tx(&mut tx, ctx, &input).await?
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
    let v = assets::change_state_in_tx(&mut tx, ctx, asset, &input, state).await?;
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

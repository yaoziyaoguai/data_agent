use crate::{
    contracts::generated::{ModelProfile, SaveModelSelection},
    modules::{conversations, runtime},
    persistence::AppTx,
    types::{AccessContext, Result, epoch},
};
use serde_json::Value;
use sqlx::MySqlPool;

pub async fn read(pool: &MySqlPool, context: &AccessContext, cid: &str) -> Result<Value> {
    conversations::read_model_selection(pool, context, cid).await
}

pub async fn save(
    pool: &MySqlPool,
    context: &AccessContext,
    cid: &str,
    input: SaveModelSelection,
    profile: Option<&ModelProfile>,
) -> Result<Value> {
    super::model_configuration::initialize(pool, context, profile).await?;
    let mut tx = AppTx::begin(pool).await?;
    let locked = conversations::lock_conversation_in_tx(&mut tx, context, cid).await?;
    runtime::model_configuration::selection_in_tx(
        &mut tx,
        &context.space_id,
        profile,
        Some(&input.selection),
    )
    .await?;
    let value = conversations::save_model_selection_in_tx(
        &mut tx,
        &locked,
        epoch(&input.expected_version)?,
        &input.selection,
    )
    .await?;
    tx.commit().await?;
    Ok(value)
}

use crate::{
    contracts::generated::{ModelProfile, ReadModelConnection},
    modules::{access, conversations, runtime},
    persistence::AppTx,
    types::{AccessContext, Error, Result, epoch},
};
use serde_json::{Value, json};
use sqlx::MySqlPool;

pub fn access(ctx: &AccessContext) -> Result<Value> {
    Ok(json!({"can_manage_models":access::is_super_maintainer(ctx)?}))
}

pub async fn initialize(
    pool: &MySqlPool,
    ctx: &AccessContext,
    profile: Option<&ModelProfile>,
) -> Result<()> {
    runtime::model_configuration::initialize(pool, &ctx.space_id, profile).await
}
pub async fn read(
    pool: &MySqlPool,
    ctx: &AccessContext,
    profile: Option<&ModelProfile>,
) -> Result<Value> {
    access::authorize_model_configuration(ctx)?;
    initialize(pool, ctx, profile).await?;
    runtime::model_configuration::snapshot(pool, &ctx.space_id).await
}
pub async fn catalog(
    pool: &MySqlPool,
    ctx: &AccessContext,
    profile: Option<&ModelProfile>,
) -> Result<Value> {
    initialize(pool, ctx, profile).await?;
    runtime::model_configuration::catalog(pool, &ctx.space_id).await
}
pub async fn save(
    pool: &MySqlPool,
    ctx: &AccessContext,
    profile: Option<&ModelProfile>,
    kind: &str,
    input: Value,
) -> Result<Value> {
    access::authorize_model_configuration(ctx)?;
    let contract = match kind {
        "service" => "SaveModelService",
        "model" => "SaveModelDefinition",
        "default" => "SaveDefaultModel",
        _ => return Err(Error::new("invalid_input")),
    };
    crate::contracts::validate(contract, &input)?;
    initialize(pool, ctx, profile).await?;
    match kind {
        "service" => {
            runtime::model_configuration::validate_service(&input)?;
            runtime::model_configuration::save_service(pool, ctx, input).await?;
        }
        "model" => {
            runtime::model_configuration::validate_model(&input)?;
            runtime::model_configuration::save_model(pool, ctx, input).await?;
        }
        _ => runtime::model_configuration::default_model(pool, &ctx.space_id, input).await?,
    }
    runtime::model_configuration::snapshot(pool, &ctx.space_id).await
}
pub async fn connection(
    pool: &MySqlPool,
    ctx: &AccessContext,
    input: ReadModelConnection,
) -> Result<Value> {
    let cid = runtime::locate_run(pool, &input.run_id).await?;
    let mut tx = AppTx::begin(pool).await?;
    let conversation = conversations::lock_conversation_in_tx(&mut tx, ctx, &cid).await?;
    conversations::assert_turn_in_tx(
        &tx,
        &conversation,
        &input.run_id,
        epoch(&input.lease_epoch)?,
    )?;
    let run = runtime::lock_run_in_tx(&mut tx, &input.run_id, &cid).await?;
    if run.state != "running" {
        return Err(Error::new("lease_lost"));
    }
    let profile = runtime::read_budget_profile_in_tx(&mut tx, &run.budget_scope_id)
        .await?
        .ok_or(Error::new("model_unavailable"))?;
    let connection =
        runtime::model_configuration::connection_in_tx(&mut tx, &ctx.space_id, &profile).await?;
    tx.commit().await?;
    Ok(connection)
}

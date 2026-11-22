use crate::{
    contracts::generated::{FinalizeModelCall, ReserveModelCall, SendModelCall},
    modules::{conversations, runtime},
    persistence::AppTx,
    types::{AccessContext, Error, Result, epoch},
};
use serde_json::Value;
use sqlx::MySqlPool;

pub async fn release_abandoned_reservations(pool: &MySqlPool) -> Result<bool> {
    let active = conversations::active_run_leases(pool).await?;
    runtime::release_abandoned_reservations(pool, &active).await
}

pub async fn reserve(
    pool: &MySqlPool,
    context: &AccessContext,
    input: ReserveModelCall,
) -> Result<Value> {
    let (mut tx, run) = authorize(pool, context, &input.run_id, &input.lease_epoch).await?;
    let receipt = runtime::reserve_model_call_in_tx(&mut tx, &run, &input).await?;
    tx.commit().await?;
    Ok(receipt)
}

pub async fn send(
    pool: &MySqlPool,
    context: &AccessContext,
    input: SendModelCall,
) -> Result<Value> {
    let (mut tx, run) = authorize(pool, context, &input.run_id, &input.lease_epoch).await?;
    let receipt = runtime::send_model_call_in_tx(&mut tx, &run, &input).await?;
    tx.commit().await?;
    Ok(receipt)
}

async fn authorize<'a>(
    pool: &'a MySqlPool,
    context: &AccessContext,
    id: &str,
    lease: &str,
) -> Result<(AppTx<'a>, runtime::LockedRun)> {
    let cid = runtime::locate_run(pool, id).await?;
    let mut tx = AppTx::begin(pool).await?;
    let conversation = conversations::lock_conversation_in_tx(&mut tx, context, &cid).await?;
    conversations::assert_turn_in_tx(&tx, &conversation, id, epoch(lease)?)?;
    let run = runtime::lock_run_in_tx(&mut tx, id, &cid).await?;
    if run.state != "running" {
        return Err(Error::new("lease_lost"));
    }
    let profile = runtime::read_budget_profile_in_tx(&mut tx, &run.budget_scope_id)
        .await?
        .ok_or(Error::new("model_unavailable"))?;
    runtime::model_configuration::assert_active_in_tx(&mut tx, &context.space_id, &profile).await?;
    Ok((tx, run))
}

pub async fn finalize(
    pool: &MySqlPool,
    context: &AccessContext,
    input: FinalizeModelCall,
) -> Result<Value> {
    let cid = runtime::locate_run(pool, &input.run_id).await?;
    let mut tx = AppTx::begin(pool).await?;
    // 删除/取消后只结算原调用；收尾锁仍核对归属，不授予发送或业务写权限。
    let _conversation = conversations::lock_for_cleanup_in_tx(&mut tx, context, &cid).await?;
    let run = runtime::lock_run_in_tx(&mut tx, &input.run_id, &cid).await?;
    if run.lease_epoch != epoch(&input.lease_epoch)? {
        return Err(Error::new("lease_lost"));
    }
    let receipt = runtime::finalize_model_call_in_tx(&mut tx, &run, &input).await?;
    tx.commit().await?;
    Ok(receipt)
}

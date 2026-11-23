use crate::{
    contracts::generated::{FinalizeModelCall, ReserveModelCall, SendModelCall},
    modules::{access, conversations, runtime},
    persistence::AppTx,
    types::{AccessContext, Error, Result, epoch},
};
use serde_json::{Value, json};
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
    let (mut tx, run) =
        lock_for_model(pool, context, &input.run_id, &input.lease_epoch, false).await?;
    assert_profile(&mut tx, context, &run).await?;
    let receipt = runtime::reserve_model_call_in_tx(&mut tx, &run, &input).await?;
    tx.commit().await?;
    Ok(receipt)
}

pub async fn send(
    pool: &MySqlPool,
    context: &AccessContext,
    input: SendModelCall,
) -> Result<Value> {
    let (mut tx, run) =
        lock_for_model(pool, context, &input.run_id, &input.lease_epoch, true).await?;
    assert_profile(&mut tx, context, &run).await?;
    let receipt = runtime::send_model_call_in_tx(&mut tx, &run, &input).await?;
    tx.commit().await?;
    Ok(receipt)
}

pub async fn mock_attempt(
    pool: &MySqlPool,
    context: &AccessContext,
    run_id: &str,
    lease: &str,
    attempt: &str,
    settle: bool,
) -> Result<Value> {
    let (mut tx, run) = lock_for_model(pool, context, run_id, lease, !settle).await?;
    if settle {
        runtime::settle_model_call_in_tx(&mut tx, &run, attempt).await?;
    } else {
        access::authorize_model("local_mock")?;
        runtime::issue_model_call_in_tx(&mut tx, &run, attempt).await?;
    }
    tx.commit().await?;
    Ok(json!({"state":if settle {"settled"}else{"issued"}}))
}

async fn lock_for_model<'a>(
    pool: &'a MySqlPool,
    context: &AccessContext,
    id: &str,
    lease: &str,
    sending: bool,
) -> Result<(AppTx<'a>, runtime::LockedRun)> {
    let cid = runtime::locate_run(pool, id).await?;
    let mut tx = AppTx::begin(pool).await?;
    let lease = epoch(lease)?;
    let mut run = lock_running(&mut tx, context, &cid, id, lease).await?;
    if sending {
        let authority = super::personal_assets::read_skill_authority_in_tx(
            &mut tx,
            context,
            &cid,
            &run.recovery_chain_id,
            Some(id),
        )
        .await?;
        if super::context_authority::has_sources(&authority) {
            // 平台实时权限在锁外取得，发送前重锁原租约并核对实际精读版本。
            tx.commit().await?;
            let catalog = super::knowledge::catalog_context(context).await?;
            let mut checked = super::context_authority::CheckedTextResults::default();
            checked
                .include(pool, &catalog, std::slice::from_ref(&authority), false)
                .await?;
            tx = AppTx::begin(pool).await?;
            run = lock_running(&mut tx, &catalog, &cid, id, lease).await?;
            super::personal_assets::assert_read_skill_authority_in_tx(
                &mut tx, &catalog, &authority, &checked,
            )
            .await?;
        }
    }
    Ok((tx, run))
}

async fn lock_running(
    tx: &mut AppTx<'_>,
    context: &AccessContext,
    cid: &str,
    id: &str,
    lease: u64,
) -> Result<runtime::LockedRun> {
    let conversation = conversations::lock_conversation_in_tx(tx, context, cid).await?;
    conversations::assert_turn_in_tx(tx, &conversation, id, lease)?;
    let run = runtime::lock_run_in_tx(tx, id, cid).await?;
    if run.state != "running" {
        return Err(Error::new("lease_lost"));
    }
    Ok(run)
}

async fn assert_profile(
    tx: &mut AppTx<'_>,
    context: &AccessContext,
    run: &runtime::LockedRun,
) -> Result<()> {
    let profile = runtime::read_budget_profile_in_tx(tx, &run.budget_scope_id)
        .await?
        .ok_or(Error::new("model_unavailable"))?;
    runtime::model_configuration::assert_active_in_tx(tx, &context.space_id, &profile).await
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

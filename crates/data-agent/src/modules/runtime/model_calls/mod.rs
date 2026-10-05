mod store;
use super::store::LockedRun;
use crate::{
    contracts::generated::{FinalizeModelCall, ModelProfile, ReserveModelCall, SendModelCall},
    persistence::AppTx,
    types::Result,
};
use serde_json::Value;
use sqlx::MySqlPool;

pub async fn configure_trial(pool: &MySqlPool, profile: &ModelProfile) -> Result<()> {
    store::configure_trial(pool, profile).await
}
pub async fn reserve_maintenance_in_tx(
    tx: &mut AppTx<'_>,
    attempt: &str,
    profile: &ModelProfile,
) -> Result<()> {
    store::reserve_maintenance_in_tx(tx, attempt, profile).await
}
pub async fn settle_maintenance_in_tx(
    tx: &mut AppTx<'_>,
    attempt: &str,
    profile: &ModelProfile,
    usage: &Value,
) -> Result<()> {
    store::settle_maintenance_in_tx(tx, attempt, profile, usage).await
}
pub async fn reserve_model_call_in_tx(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
    input: &ReserveModelCall,
) -> Result<Value> {
    store::reserve_model_call(tx, run, input).await
}
pub async fn send_model_call_in_tx(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
    input: &SendModelCall,
) -> Result<Value> {
    store::send_model_call(tx, run, input).await
}
pub async fn finalize_model_call_in_tx(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
    input: &FinalizeModelCall,
) -> Result<Value> {
    store::finalize_model_call(tx, run, input).await
}

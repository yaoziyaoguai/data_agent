use super::store::{self, LockedRun};
use crate::{persistence::AppTx, types::Result};
pub async fn open_budget_scope_in_tx(
    tx: &mut AppTx<'_>,
    scope: &str,
    message: &str,
    profile: Option<&crate::contracts::generated::ModelProfile>,
) -> Result<()> {
    store::open_budget(
        tx,
        scope,
        message,
        profile
            .map(|p| p.request_call_limit.unwrap_or(6) as u32)
            .unwrap_or(12),
        profile,
    )
    .await
}
pub async fn issue_model_call_in_tx(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
    attempt: &str,
) -> Result<()> {
    store::issue_call(tx, run, attempt).await
}
pub async fn settle_model_call_in_tx(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
    attempt: &str,
) -> Result<()> {
    store::settle_call(tx, run, attempt).await
}

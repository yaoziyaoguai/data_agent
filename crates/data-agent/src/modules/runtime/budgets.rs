use super::store::{self, LockedRun};
use crate::contracts::generated::BudgetMode;
use crate::{persistence::AppTx, types::Result};
pub async fn open_budget_scope_in_tx(
    tx: &mut AppTx<'_>,
    scope: &str,
    message: &str,
    profile: Option<&crate::contracts::generated::ModelProfile>,
) -> Result<()> {
    // 正常request与无profile的本地模拟使用不设累计调用门；有限trial沿用原额度。
    let limit = match profile {
        Some(profile) if matches!(profile.budget_mode, Some(BudgetMode::Request)) => None,
        Some(profile) => Some(profile.request_call_limit.unwrap_or(6) as u32),
        None => None,
    };
    store::open_budget(tx, scope, message, limit, profile).await
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

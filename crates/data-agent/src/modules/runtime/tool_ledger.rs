use super::store::{self, LockedRun, LockedTool};
use crate::{
    persistence::AppTx,
    types::{Error, Result},
};
use serde_json::Value;
pub async fn lock_tool_call_in_tx(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
    sdk_id: &str,
) -> Result<Option<LockedTool>> {
    store::lock_tool(tx, run, sdk_id).await
}
pub async fn register_tool_call_in_tx(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
    sdk_id: &str,
    fp: &str,
) -> Result<String> {
    store::insert_tool(tx, run, sdk_id, fp, "update_analysis_task").await
}
pub async fn record_tool_receipt_in_tx(
    tx: &mut AppTx<'_>,
    tool: &LockedTool,
    receipt: &Value,
) -> Result<()> {
    if tool.state != "registered" {
        return Err(Error::new("version_conflict"));
    }
    store::record_receipt(tx, tool, receipt).await
}

pub async fn register_named_tool_in_tx(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
    sdk_id: &str,
    fp: &str,
    name: &str,
) -> Result<String> {
    store::insert_tool(tx, run, sdk_id, fp, name).await
}

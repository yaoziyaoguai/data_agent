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
pub async fn read_answer_tool_in_tx(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
    sdk_id: &str,
) -> Result<Option<LockedTool>> {
    store::read_answer_tool(tx, run, sdk_id).await
}
pub async fn read_prepare_tool_in_tx(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
    sdk_id: &str,
) -> Result<Option<LockedTool>> {
    store::read_prepare_tool(tx, run, sdk_id).await
}
pub async fn read_search_cursor_in_tx(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
    operation: &str,
) -> Result<String> {
    store::read_search_cursor(tx, run, operation).await
}

pub async fn register_tool_call_in_tx(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
    sdk_id: &str,
    fp: &str,
) -> Result<String> {
    store::insert_tool(tx, run, sdk_id, fp, "update_analysis_task").await
}
pub async fn bind_answer_handoff_in_tx(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
    operation: &str,
    handoff: &Value,
) -> Result<()> {
    store::bind_answer_handoff(tx, run, operation, handoff).await
}

pub async fn record_tool_receipt_in_tx(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
    tool: &LockedTool,
    receipt: &Value,
) -> Result<()> {
    if tool.state != "registered" {
        return Err(Error::new("version_conflict"));
    }
    store::record_receipt(tx, tool, receipt).await?;
    tx.notify(crate::live_changes::Change::Activity {
        conversation_id: run.conversation_id.clone(),
    });
    Ok(())
}

pub async fn register_named_tool_in_tx(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
    sdk_id: &str,
    fp: &str,
    name: &str,
) -> Result<String> {
    let operation = store::insert_tool(tx, run, sdk_id, fp, name).await?;
    tx.notify(crate::live_changes::Change::Activity {
        conversation_id: run.conversation_id.clone(),
    });
    Ok(operation)
}

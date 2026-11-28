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

pub(super) fn step_target_ids(tool_name: &str, receipt: Option<&Value>) -> Vec<String> {
    let Some(data) = receipt.and_then(|r| r.get("data")) else {
        return Vec::new();
    };
    let mut ids = Vec::new();
    if tool_name == "read_knowledge" {
        for item in data["items"].as_array().into_iter().flatten() {
            if item["state"] == "ok"
                && let Some(id) = item["ref"]["object_id"].as_str()
                && !ids.iter().any(|existing| existing == id)
            {
                ids.push(id.to_owned());
            }
        }
    } else if tool_name == "read_source"
        && data["source"]["kind"] == "document"
        && let Some(id) = data["source"]["id"].as_str()
    {
        ids.push(id.to_owned());
    }
    ids
}

#[cfg(test)]
mod tests {
    use super::step_target_ids;
    use serde_json::json;

    #[test]
    fn extracts_deduplicated_ok_targets_from_batched_reads() {
        let receipt = json!({"data":{"items":[
            {"state":"ok","ref":{"object_id":"metric-a","path":"definition"}},
            {"state":"ok","ref":{"object_id":"metric-a","path":"sql"}},
            {"state":"not_available","ref":{"object_id":"table-hidden","path":"columns"}},
            {"state":"ok","asset_ref":{"id":"mem-1"}},
            {"state":"ok","ref":{"object_id":"metric-b","path":"definition"}}
        ]}});
        assert_eq!(
            step_target_ids("read_knowledge", Some(&receipt)),
            vec!["metric-a".to_owned(), "metric-b".to_owned()]
        );
    }
}

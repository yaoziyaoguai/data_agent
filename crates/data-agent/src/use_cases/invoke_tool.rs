use crate::{
    contracts::generated::ToolInvocation,
    modules::{access, analysis, conversations, runtime},
    persistence::AppTx,
    types::{AccessContext, Error, Result, epoch, fingerprint, id},
};
use serde_json::{Value, json};
use sqlx::MySqlPool;

pub async fn register_tool(
    pool: &MySqlPool,
    context: &AccessContext,
    input: &ToolInvocation,
) -> Result<Value> {
    let cid = runtime::locate_run(pool, &input.run_id).await?;
    let mut tx = AppTx::begin(pool).await?;
    let conversation = conversations::lock_conversation_in_tx(&mut tx, context, &cid).await?;
    conversations::assert_turn_in_tx(
        &tx,
        &conversation,
        &input.run_id,
        epoch(&input.lease_epoch)?,
    )?;
    let run = runtime::lock_run_in_tx(&mut tx, &input.run_id, &cid).await?;
    let fp = fingerprint(&serde_json::to_value(&input.arguments).expect("tool input"));
    let operation_id = if let Some(tool) =
        runtime::lock_tool_call_in_tx(&mut tx, &run, &input.sdk_tool_call_id).await?
    {
        if tool.fingerprint != fp {
            return Err(Error::new("idempotency_conflict"));
        }
        tool.operation_id
    } else {
        runtime::register_tool_call_in_tx(&mut tx, &run, &input.sdk_tool_call_id, &fp).await?
    };
    runtime::save_checkpoint_in_tx(
        &mut tx,
        &run,
        &serde_json::to_value(&input.checkpoint).expect("checkpoint"),
    )
    .await?;
    tx.commit().await?;
    Ok(json!({"operation_id":operation_id}))
}
pub async fn invoke_tool(
    pool: &MySqlPool,
    context: &AccessContext,
    input: ToolInvocation,
) -> Result<Value> {
    let cid = runtime::locate_run(pool, &input.run_id).await?;
    let mut tx = AppTx::begin(pool).await?;
    let conversation = conversations::lock_conversation_in_tx(&mut tx, context, &cid).await?;
    let run = runtime::lock_run_in_tx(&mut tx, &input.run_id, &cid).await?;
    let tool = runtime::lock_tool_call_in_tx(&mut tx, &run, &input.sdk_tool_call_id)
        .await?
        .ok_or(Error::new("version_conflict"))?;
    let fp = fingerprint(&serde_json::to_value(&input.arguments).expect("tool input"));
    if tool.fingerprint != fp {
        return Err(Error::new("idempotency_conflict"));
    }
    access::authorize_owner(context, &conversation.owner_id, &conversation.space_id)?;
    if let Some(receipt) = tool.receipt {
        tx.commit().await?;
        return Ok(json!({"type":"succeeded","receipt":receipt}));
    }
    conversations::assert_turn_in_tx(
        &tx,
        &conversation,
        &input.run_id,
        epoch(&input.lease_epoch)?,
    )?;
    if run.state != "running" {
        return Err(Error::new("lease_lost"));
    }
    let tasks = analysis::lock_tasks_in_tx(&mut tx, &cid).await?;
    let receipt = analysis::create_task_in_tx(
        &mut tx,
        &tasks,
        &context.user_id,
        &tool.operation_id,
        &input.arguments.goal,
    )
    .await?;
    runtime::record_tool_receipt_in_tx(&mut tx, &tool, &receipt).await?;
    conversations::append_event_in_tx(
        &mut tx,
        &conversation,
        &id(),
        "tool_result",
        receipt.clone(),
    )
    .await?;
    tx.commit().await?;
    eprintln!(
        "tool_committed request={} run={} sdk_call={} operation={} origin={}",
        context.request_id,
        input.run_id,
        input.sdk_tool_call_id,
        tool.operation_id,
        tool.origin_run_id
    );
    Ok(json!({"type":"succeeded","receipt":receipt}))
}

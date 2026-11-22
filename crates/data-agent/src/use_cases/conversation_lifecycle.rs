use crate::{
    contracts,
    modules::{analysis, assets, conversations, jobs, queries, runtime},
    persistence::AppTx,
    types::{AccessContext, Error, Result, id},
};
use serde_json::{Value, json};
use sqlx::MySqlPool;
pub async fn cancel_task(
    pool: &MySqlPool,
    ctx: &AccessContext,
    cid: &str,
    task: &str,
    input: Value,
) -> Result<Value> {
    contracts::validate("VersionCommand", &input)?;
    let mut tx = AppTx::begin(pool).await?;
    let conv = conversations::lock_conversation_in_tx(&mut tx, ctx, cid).await?;
    let operation = input["operation_id"].as_str().expect("validated operation");
    let command = json!({"action":"cancel_task","conversation_id":cid,"task_id":task,"expected_version":input["expected_version"]});
    if let Some(receipt) =
        analysis::begin_lifecycle_in_tx(&mut tx, ctx, operation, &command).await?
    {
        tx.commit().await?;
        return Ok(receipt);
    }
    // 会话锁覆盖任务写入口；先核对终态，重复取消不能撤回剩余任务的新运行。
    let current = analysis::read_task_in_tx(&mut tx, cid, task).await?;
    if current["condition_version"] != input["expected_version"] {
        return Err(Error::new("version_conflict"));
    }
    let receipt = json!({"operation_id":operation,"resource_id":task,"version":input["expected_version"],"state":"cancelled"});
    if current["lifecycle"] == "cancelled" {
        analysis::record_lifecycle_receipt_in_tx(&mut tx, ctx, operation, &command, &receipt)
            .await?;
        tx.commit().await?;
        return Ok(receipt);
    }
    let pending = conversations::task_pending_ids_in_tx(&mut tx, &conv, task).await?;
    let mut interrupted_jobs = std::collections::HashMap::<String, u64>::new();
    for snapshot in runtime::read_runs_in_tx(&mut tx, cid)
        .await?
        .iter()
        .filter(|r| r["state"] == "running")
    {
        let run = runtime::lock_run_in_tx(&mut tx, snapshot["run_id"].as_str().unwrap_or(""), cid)
            .await?;
        if pending.contains(&run.message_id) {
            interrupted_jobs
                .entry(run.message_id.clone())
                .and_modify(|epoch| *epoch = (*epoch).max(run.job_lease_epoch))
                .or_insert(run.job_lease_epoch);
            runtime::cancel_run_in_tx(&mut tx, &run).await?;
            conversations::cancel_consumption_in_tx(
                &mut tx,
                &conv,
                &run.message_id,
                &run.id,
                run.lease_epoch,
            )
            .await?;
        }
    }
    runtime::reject_unstarted_task_tools_in_tx(
        &mut tx,
        cid,
        task,
        crate::types::epoch(
            input["expected_version"]
                .as_str()
                .expect("validated version"),
        )?,
    )
    .await?;
    let tasks = analysis::lock_tasks_in_tx(&mut tx, cid).await?;
    analysis::cancel_task_in_tx(&mut tx, &tasks, task).await?;
    // 取消只清掉被取消任务自身的活动绑定；其他任务的条件与归属不变。
    conversations::clear_active_task_in_tx(&mut tx, &conv, task).await?;
    analysis::record_lifecycle_receipt_in_tx(&mut tx, ctx, operation, &command, &receipt).await?;
    for query in queries::list_in_tx(&mut tx, cid)
        .await?
        .iter()
        .filter(|q| q["task_id"] == task)
    {
        queries::cancel_in_tx(&mut tx, ctx, query["id"].as_str().unwrap_or("")).await?;
    }
    conversations::append_event_in_tx(
        &mut tx,
        &conv,
        &id(),
        "task_cancelled",
        json!({"task_id":task}),
    )
    .await?;
    for message in pending {
        let mut remaining = None;
        for bound in conversations::message_task_ids_in_tx(&mut tx, &conv, &message).await? {
            let snapshot = analysis::read_task_in_tx(&mut tx, cid, &bound).await?;
            if bound != task && snapshot["lifecycle"] == "active" {
                remaining = Some((
                    bound,
                    snapshot["condition_version"]
                        .as_str()
                        .unwrap_or("0")
                        .to_owned(),
                ));
                break;
            }
        }
        if let Some((task, version)) = remaining {
            conversations::resume_task_input_in_tx(&mut tx, &conv, &message, &task).await?;
            // 混合输入取消后续接：剩余任务成为明确归属，活动绑定随之更新，
            // 不残留被取消任务的读取范围。
            conversations::bind_active_task_in_tx(
                &mut tx,
                &conv,
                &task,
                crate::types::epoch(&version)?,
            )
            .await?;
            jobs::resume_message_job_in_tx(
                &mut tx,
                &message,
                interrupted_jobs.get(&message).copied(),
            )
            .await?;
        } else {
            conversations::skip_task_input_in_tx(&mut tx, &conv, &message).await?;
            jobs::cancel_message_job_in_tx(&mut tx, &message).await?;
        }
    }
    tx.commit().await?;
    Ok(receipt)
}
pub async fn withdraw(
    pool: &MySqlPool,
    ctx: &AccessContext,
    cid: &str,
    message: &str,
    input: Value,
) -> Result<Value> {
    contracts::validate("CreateConversation", &input)?;
    let mut tx = AppTx::begin(pool).await?;
    let conv = conversations::lock_conversation_in_tx(&mut tx, ctx, cid).await?;
    conversations::withdraw_in_tx(&mut tx, &conv, message).await?;
    let runs = runtime::read_runs_in_tx(&mut tx, cid).await?;
    for run in runs.iter().filter(|r| r["state"] == "running") {
        let r = runtime::lock_run_in_tx(&mut tx, run["run_id"].as_str().unwrap_or(""), cid).await?;
        if r.message_id == message {
            runtime::cancel_run_in_tx(&mut tx, &r).await?;
            conversations::cancel_consumption_in_tx(&mut tx, &conv, message, &r.id, r.lease_epoch)
                .await?;
        }
    }
    jobs::cancel_message_job_in_tx(&mut tx, message).await?;
    tx.commit().await?;
    Ok(
        json!({"operation_id":input["operation_id"],"resource_id":message,"version":"0","state":"withdrawn"}),
    )
}
pub async fn delete(
    pool: &MySqlPool,
    ctx: &AccessContext,
    cid: &str,
    input: Value,
) -> Result<Value> {
    contracts::validate("CreateConversation", &input)?;
    let mut tx = AppTx::begin(pool).await?;
    let conv = conversations::lock_for_cleanup_in_tx(&mut tx, ctx, cid).await?;
    if !conv.deleted {
        let messages = conversations::pending_ids_in_tx(&mut tx, &conv).await?;
        for run in runtime::read_runs_in_tx(&mut tx, cid)
            .await?
            .iter()
            .filter(|r| r["state"] == "running")
        {
            let run =
                runtime::lock_run_in_tx(&mut tx, run["run_id"].as_str().unwrap_or(""), cid).await?;
            runtime::cancel_run_in_tx(&mut tx, &run).await?;
        }
        let tasks = analysis::lock_tasks_in_tx(&mut tx, cid).await?;
        for task in analysis::context_in_tx(&mut tx, cid).await? {
            analysis::cancel_task_in_tx(&mut tx, &tasks, task["id"].as_str().unwrap_or("")).await?;
        }
        for query in queries::list_in_tx(&mut tx, cid).await? {
            queries::cancel_in_tx(&mut tx, ctx, query["id"].as_str().unwrap_or("")).await?;
        }
        conversations::delete_in_tx(&mut tx, &conv).await?;
        assets::skill_drafts::delete_conversation_drafts_in_tx(&mut tx, ctx, cid).await?;
        analysis::delete_conversation_reports_in_tx(&mut tx, ctx, cid).await?;
        analysis::delete_conversation_evidence_in_tx(&mut tx, ctx, cid).await?;
        for message in messages {
            jobs::cancel_message_job_in_tx(&mut tx, &message).await?;
        }
    }
    tx.commit().await?;
    Ok(
        json!({"operation_id":input["operation_id"],"resource_id":cid,"version":"0","state":"deleted"}),
    )
}

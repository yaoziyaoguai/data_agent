use crate::{
    contracts::generated::{AppendOutput, FinishRun},
    modules::{analysis, conversations, jobs, queries, runtime},
    persistence::AppTx,
    types::{AccessContext, Error, Result, epoch, fingerprint, id},
};
use serde_json::{Value, json};
use sqlx::MySqlPool;

pub async fn append_output(
    pool: &MySqlPool,
    context: &AccessContext,
    input: AppendOutput,
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
    if run.state != "running" {
        return Err(Error::new("lease_lost"));
    }
    runtime::append_output_in_tx(&mut tx, &run, epoch(&input.chunk_seq)?, &input.text).await?;
    let event_id = format!("{}-{}", run.attempt_id, input.chunk_seq);
    conversations::append_event_in_tx(&mut tx,&conversation,&event_id,"assistant_delta",json!({"output_id":run.output_id,"attempt_id":run.attempt_id,"chunk_seq":input.chunk_seq,"text":input.text})).await?;
    tx.commit().await?;
    Ok(json!({"chunk_seq":input.chunk_seq}))
}
pub async fn finish_run(
    pool: &MySqlPool,
    context: &AccessContext,
    input: FinishRun,
) -> Result<Value> {
    let cid = runtime::locate_run(pool, &input.run_id).await?;
    let mut tx = AppTx::begin(pool).await?;
    let conversation = conversations::lock_conversation_in_tx(&mut tx, context, &cid).await?;
    let run = runtime::lock_run_in_tx(&mut tx, &input.run_id, &cid).await?;
    let fp = fingerprint(&serde_json::to_value(&input).expect("finish input"));
    if let Some(commit) = &run.commit_id {
        if commit != &input.commit_id || run.commit_fingerprint.as_deref() != Some(&fp) {
            return Err(Error::new("idempotency_conflict"));
        }
        tx.commit().await?;
        return Ok(json!({"state":"finished","output_id":run.output_id}));
    }
    conversations::assert_turn_in_tx(
        &tx,
        &conversation,
        &input.run_id,
        epoch(&input.lease_epoch)?,
    )?;
    if std::env::var("DATA_AGENT_TOOLSET").as_deref() == Ok("data") {
        conversations::assert_routed_in_tx(&mut tx, &conversation, &run.message_id).await?;
    }
    let final_start = input
        .final_start_chunk_seq
        .as_deref()
        .map(epoch)
        .transpose()?
        .unwrap_or(1);
    let persisted = runtime::read_output_text_in_tx(&mut tx, &run, final_start).await?;
    if persisted != input.final_text {
        return Err(Error::new("chunk_gap"));
    }
    runtime::save_checkpoint_in_tx(
        &mut tx,
        &run,
        &serde_json::to_value(&input.checkpoint).expect("checkpoint"),
    )
    .await?;
    runtime::commit_run_in_tx(&mut tx, &run, &input.commit_id, &fp, &input.final_text).await?;
    if std::env::var("DATA_AGENT_TOOLSET").as_deref() == Ok("data") {
        let refs = if let Some(query_id) =
            conversations::result_query_for_message_in_tx(&mut tx, &cid, &run.message_id).await?
        {
            // 宿主结果唤醒的交付只推进原查询版本；route到当前任务不能把旧结果升级为新答案。
            vec![queries::read_in_tx(&mut tx, context, &query_id).await?]
        } else {
            runtime::delivery_task_refs_in_tx(&mut tx, &run).await?
        };
        analysis::lock_tasks_in_tx(&mut tx, &cid).await?;
        for reference in refs {
            let task_id = reference["task_id"]
                .as_str()
                .ok_or(Error::new("invalid_input"))?;
            let version = epoch(
                reference["condition_version"]
                    .as_str()
                    .ok_or(Error::new("invalid_input"))?,
            )?;
            let task = analysis::read_task_in_tx(&mut tx, &cid, task_id).await?;
            // 回答只属于提交时的原条件版本；开放澄清和其他查询仍保留可操作阶段。
            if task["condition_version"] == reference["condition_version"]
                && task["phase"] != "waiting_clarification"
            {
                let phase = queries::task_waiting_phase_in_tx(&mut tx, task_id, version)
                    .await?
                    .unwrap_or("answered");
                analysis::set_phase_in_tx(&mut tx, task_id, version, phase).await?;
            }
        }
    }
    conversations::commit_consumption_in_tx(&mut tx, &conversation, &run.message_id).await?;
    conversations::append_event_in_tx(
        &mut tx,
        &conversation,
        &id(),
        "assistant_committed",
        json!({"output_id":run.output_id,"attempt_id":run.attempt_id,"text":input.final_text}),
    )
    .await?;
    conversations::release_turn_in_tx(&mut tx, &conversation, &input.run_id, run.lease_epoch)
        .await?;
    jobs::settle_in_tx(&mut tx, &run.job_id, run.job_lease_epoch).await?;
    tx.commit().await?;
    Ok(json!({"state":"finished","output_id":run.output_id}))
}

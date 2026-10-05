use crate::{
    contracts,
    modules::{access, analysis, conversations, jobs, queries},
    persistence::AppTx,
    types::{AccessContext, Error, Result, epoch, id},
};
use serde_json::{Value, json};
use sqlx::MySqlPool;
pub async fn list(pool: &MySqlPool, ctx: &AccessContext, cid: &str) -> Result<Value> {
    let mut tx = AppTx::begin(pool).await?;
    conversations::lock_conversation_in_tx(&mut tx, ctx, cid).await?;
    let queries = queries::list_in_tx(&mut tx, cid).await?;
    let blocked = conversations::confirmation_blocked_in_tx(&mut tx, cid).await?;
    tx.commit().await?;
    Ok(json!({"queries":queries,"confirmation_blocked":blocked}))
}
pub async fn read(pool: &MySqlPool, ctx: &AccessContext, qid: &str) -> Result<Value> {
    let location = queries::locate(pool, qid).await?;
    access::authorize_owner(ctx, &location.owner_id, &location.space_id)?;
    let mut tx = AppTx::begin(pool).await?;
    conversations::lock_conversation_in_tx(&mut tx, ctx, &location.conversation_id).await?;
    let v = queries::read_in_tx(&mut tx, ctx, qid).await?;
    tx.commit().await?;
    Ok(v)
}
pub async fn confirm(
    pool: &MySqlPool,
    ctx: &AccessContext,
    qid: &str,
    input: Value,
) -> Result<Value> {
    contracts::validate("ConfirmQuery", &input)?;
    let location = queries::locate(pool, qid).await?;
    access::authorize_owner(ctx, &location.owner_id, &location.space_id)?;
    let mut tx = AppTx::begin(pool).await?;
    let conv =
        conversations::lock_conversation_in_tx(&mut tx, ctx, &location.conversation_id).await?;
    let blocked = conversations::confirmation_blocked_in_tx(&mut tx, &conv.id).await?;
    analysis::lock_tasks_in_tx(&mut tx, &conv.id).await?;
    let v = queries::read_in_tx(&mut tx, ctx, qid).await?;
    let first_confirmation = v["confirmation_state"] != "confirmed";
    if first_confirmation {
        analysis::assert_current_in_tx(
            &mut tx,
            &conv.id,
            v["task_id"].as_str().unwrap_or(""),
            epoch(v["condition_version"].as_str().unwrap_or("0"))?,
        )
        .await?;
        super::knowledge::check_refs_in_tx(&mut tx, ctx, &v["knowledge_refs"]).await?;
    }
    let v = queries::confirm_in_tx(&mut tx, ctx, qid, &input, blocked).await?;
    if first_confirmation {
        conversations::append_event_in_tx(
        &mut tx,
        &conv,
        &format!("confirm-{qid}"),
        "query_changed",
        json!({"query_id":qid,"task_id":v["task_id"],"condition_version":v["condition_version"]}),
    )
    .await?;
        analysis::set_phase_in_tx(
            &mut tx,
            v["task_id"].as_str().unwrap_or(""),
            epoch(v["condition_version"].as_str().unwrap_or("0"))?,
            "waiting_query",
        )
        .await?;
    }
    tx.commit().await?;
    Ok(v)
}
pub async fn cancel(pool: &MySqlPool, ctx: &AccessContext, qid: &str) -> Result<Value> {
    let location = queries::locate(pool, qid).await?;
    access::authorize_owner(ctx, &location.owner_id, &location.space_id)?;
    let mut tx = AppTx::begin(pool).await?;
    conversations::lock_conversation_in_tx(&mut tx, ctx, &location.conversation_id).await?;
    let v = queries::cancel_in_tx(&mut tx, ctx, qid).await?;
    tx.commit().await?;
    Ok(v)
}
pub async fn results(
    pool: &MySqlPool,
    ctx: &AccessContext,
    qid: &str,
    cursor: Option<&str>,
) -> Result<Value> {
    let v = read(pool, ctx, qid).await?;
    if v["execution_state"] != "succeeded" {
        return Err(Error::new("result_unavailable"));
    }
    knowledge_check(pool, ctx, &v["knowledge_refs"]).await?;
    let result = queries::platform::call(
        "/results",
        &json!({"query_id":qid,"owner_id":ctx.user_id,"cursor":cursor}),
    )
    .await?;
    contracts::validate("QueryResults", &result)?;
    Ok(result)
}
async fn knowledge_check(pool: &MySqlPool, ctx: &AccessContext, refs: &Value) -> Result<()> {
    let mut tx = AppTx::begin(pool).await?;
    super::knowledge::check_refs_in_tx(&mut tx, ctx, refs).await?;
    tx.commit().await
}
pub async fn process_due(pool: &MySqlPool, worker: &str) -> Result<bool> {
    let Some(job) = queries::claim_due(pool, worker).await? else {
        return Ok(false);
    };
    let ctx = AccessContext {
        user_id: job["owner_id"].as_str().unwrap_or("").into(),
        space_id: "demo".into(),
        request_id: id(),
    };
    let cid = job["conversation_id"].as_str().unwrap_or("");
    let mut tx = AppTx::begin(pool).await?;
    let conv = conversations::lock_for_cleanup_in_tx(&mut tx, &ctx, cid).await?;
    analysis::lock_tasks_in_tx(&mut tx, cid).await?;
    let query = queries::read_in_tx(&mut tx, &ctx, job["query_id"].as_str().unwrap_or("")).await?;
    let authorized = super::knowledge::check_refs_in_tx(&mut tx, &ctx, &query["knowledge_refs"])
        .await
        .is_ok();
    let packet = queries::begin_submission_in_tx(&mut tx, &ctx, &job).await?;
    tx.commit().await?;
    let qid = job["query_id"].as_str().unwrap_or("");
    let action = packet["action"].as_str().unwrap_or("lookup");
    let observation = if action == "submit" && !authorized {
        json!({"state":"failed","error":"stale_knowledge"})
    } else {
        let path = match action {
            "submit" => "/submit",
            "cancel" => "/cancel",
            _ => "/lookup",
        };
        let payload = if action == "submit" {
            json!({"query_id":qid,"owner_id":ctx.user_id,"sql":packet["sql"],"parameters":packet["parameters"],"target_id":packet["target_id"],"target_version":"1"})
        } else {
            json!({"query_id":qid,"owner_id":ctx.user_id})
        };
        match queries::platform::call(path, &payload).await {
            Ok(v) => v,
            Err(e) if action == "cancel" && e.code == "not_available" => {
                json!({"state":"cancelled","error":"platform_confirmed_absent"})
            }
            Err(e)
                if action == "submit"
                    && matches!(
                        e.code,
                        "sql_not_supported"
                            | "invalid_input"
                            | "forbidden"
                            | "idempotency_conflict"
                    ) =>
            {
                json!({"state":"failed","error":e.code})
            }
            Err(e) => json!({"state":"submission_unknown","error":e.code}),
        }
    };
    let mut tx = AppTx::begin(pool).await?;
    let conv = conversations::lock_for_cleanup_in_tx(&mut tx, &ctx, &conv.id).await?;
    analysis::lock_tasks_in_tx(&mut tx, cid).await?;
    if action == "lookup"
        && observation["error"] == "not_available"
        && queries::retry_missing_in_tx(&mut tx, &job).await?
    {
        tx.commit().await?;
        return Ok(true);
    }
    let observation = if action == "lookup" && observation["error"] == "not_available" {
        json!({"state":"failed","error":"submission_retry_exhausted"})
    } else {
        observation
    };
    let v = queries::record_observation_in_tx(&mut tx, &ctx, &job, &observation).await?;
    if !conv.deleted
        && matches!(
            v["execution_state"].as_str(),
            Some("succeeded" | "failed" | "cancelled")
        )
        && queries::mark_notified_in_tx(&mut tx, qid).await?
    {
        conversations::append_event_in_tx(&mut tx,&conv,&format!("result-{qid}"),"query_result",json!({"query_id":qid,"task_id":v["task_id"],"condition_version":v["condition_version"],"state":v["execution_state"]})).await?;
        let task =
            analysis::read_task_in_tx(&mut tx, cid, v["task_id"].as_str().unwrap_or("")).await?;
        if task["condition_version"] == v["condition_version"]
            && task["phase"] != "waiting_clarification"
        {
            let version = epoch(v["condition_version"].as_str().unwrap_or("0"))?;
            let phase = queries::task_waiting_phase_in_tx(
                &mut tx,
                v["task_id"].as_str().unwrap_or(""),
                version,
            )
            .await?
            .unwrap_or("investigating");
            analysis::set_phase_in_tx(&mut tx, v["task_id"].as_str().unwrap_or(""), version, phase)
                .await?;
        }
        if task["lifecycle"] == "cancelled" {
            tx.commit().await?;
            return Ok(true);
        }
        let text = format!(
            "[已确认查询结果事件] query_id={qid}，task_id={}，condition_version={}，state={}。读取这个查询的结果并解释；这是原条件下的结果，保留后来问题的条件。",
            v["task_id"], v["condition_version"], v["execution_state"]
        );
        let budget = job["budget_scope_id"].as_str().unwrap_or("");
        let origin_message_id =
            crate::modules::runtime::budget_message_in_tx(&mut tx, budget).await?;
        if let Some(message) = conversations::enqueue_result_input_in_tx(
            &mut tx,
            &conv,
            &text,
            qid,
            v["task_id"].as_str().unwrap_or(""),
            budget,
            &origin_message_id,
        )
        .await?
        {
            jobs::enqueue_in_tx(&mut tx, cid, &message.id).await?;
        }
    }
    tx.commit().await?;
    Ok(true)
}

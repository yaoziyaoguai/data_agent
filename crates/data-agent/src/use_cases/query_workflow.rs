use crate::{
    contracts,
    modules::{access, analysis, conversations, jobs, queries, runtime},
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
    let v = confirm_bound_in_tx(&mut tx, ctx, &conv, qid, &input, None).await?;
    tx.commit().await?;
    Ok(v)
}

pub async fn execute_from_message_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    conv: &conversations::LockedConversation,
    run: &runtime::LockedRun,
    operation: &str,
    input: &Value,
) -> Result<Value> {
    let message = conversations::read_message_in_tx(tx, conv, &run.message_id).await?;
    // Pi解释执行意图；宿主只接受当前真实用户完整原话，不接受资料或结果唤醒授权。
    if message.disposition != "pending"
        || input["instruction_quote"].as_str().map(str::trim) != Some(message.body.trim())
        || conversations::result_query_for_message_in_tx(tx, &conv.id, &message.id)
            .await?
            .is_some()
    {
        return Err(Error::new("invalid_evidence"));
    }
    conversations::assert_routed_in_tx(tx, conv, &message.id).await?;
    let qid = input["query_id"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?;
    let query = queries::read_in_tx(tx, ctx, qid).await?;
    let tasks = conversations::message_task_ids_in_tx(tx, conv, &message.id).await?;
    if query["conversation_id"] != conv.id || !tasks.iter().any(|task| query["task_id"] == *task) {
        return Err(Error::new("not_available"));
    }
    super::context_authority::assert_run_in_tx(tx, ctx, &conv.id, &run.id).await?;
    let confirmation = json!({"operation_id":operation,"draft_version":input["draft_version"],"condition_version":input["condition_version"]});
    let confirmed = confirm_bound_in_tx(
        tx,
        ctx,
        conv,
        qid,
        &confirmation,
        Some(queries::MessageAuthorization {
            message_id: &message.id,
            budget_scope_id: &run.budget_scope_id,
        }),
    )
    .await?;
    if query["confirmation_state"] != "confirmed" {
        // 确认与消息生效原子提交，不能撤回已授予查询执行权的输入。
        conversations::route_message_in_tx(tx, conv, &message.id, query["task_id"].as_str(), true)
            .await?;
    }
    Ok(confirmed)
}

async fn confirm_bound_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    conv: &conversations::LockedConversation,
    qid: &str,
    input: &Value,
    authorization: Option<queries::MessageAuthorization<'_>>,
) -> Result<Value> {
    let blocked = conversations::confirmation_blocked_in_tx(tx, &conv.id).await?;
    analysis::lock_tasks_in_tx(tx, &conv.id).await?;
    let v = queries::read_in_tx(tx, ctx, qid).await?;
    let first_confirmation = v["confirmation_state"] != "confirmed";
    if first_confirmation {
        analysis::assert_current_in_tx(
            tx,
            &conv.id,
            v["task_id"].as_str().unwrap_or(""),
            epoch(v["condition_version"].as_str().unwrap_or("0"))?,
        )
        .await?;
        super::knowledge::check_refs_in_tx(tx, ctx, &v["knowledge_refs"]).await?;
    }
    let v = queries::confirm_in_tx(tx, ctx, qid, input, blocked, authorization).await?;
    if first_confirmation {
        conversations::append_event_in_tx(
        tx,
        conv,
        &format!("confirm-{qid}"),
        "query_changed",
        json!({"query_id":qid,"task_id":v["task_id"],"condition_version":v["condition_version"]}),
    )
    .await?;
        analysis::set_phase_in_tx(
            tx,
            v["task_id"].as_str().unwrap_or(""),
            epoch(v["condition_version"].as_str().unwrap_or("0"))?,
            "waiting_query",
        )
        .await?;
    }
    Ok(v)
}
pub async fn cancel(pool: &MySqlPool, ctx: &AccessContext, qid: &str) -> Result<Value> {
    let location = queries::locate(pool, qid).await?;
    access::authorize_owner(ctx, &location.owner_id, &location.space_id)?;
    let mut tx = AppTx::begin(pool).await?;
    let conv =
        conversations::lock_conversation_in_tx(&mut tx, ctx, &location.conversation_id).await?;
    let v = cancel_in_tx(&mut tx, ctx, &conv, qid).await?;
    tx.commit().await?;
    Ok(v)
}
pub(super) async fn cancel_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    conv: &conversations::LockedConversation,
    qid: &str,
) -> Result<Value> {
    analysis::lock_tasks_in_tx(tx, &conv.id).await?;
    let v = queries::cancel_in_tx(tx, ctx, qid).await?;
    // 未提交的查询可在本地结束，Worker不会再领取它；在同一事务保存终态通知。
    // 此时没有平台结果需要解释，不另唤醒模型。
    record_terminal_in_tx(tx, conv, &v).await?;
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
    if let Some(task) = record_terminal_in_tx(&mut tx, &conv, &v).await? {
        if task["lifecycle"] == "cancelled" {
            tx.commit().await?;
            return Ok(true);
        }
        let text = format!(
            "[已确认查询结果事件] query_id={qid}，task_id={}，condition_version={}，state={}。读取这个查询的结果并解释；以该查询实际SQL和已绑定的绝对日期参数为准，不能按本轮时钟重新展开相对日期，保留后来问题的条件。",
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

async fn record_terminal_in_tx(
    tx: &mut AppTx<'_>,
    conv: &conversations::LockedConversation,
    query: &Value,
) -> Result<Option<Value>> {
    let qid = query["id"].as_str().ok_or(Error::new("invalid_input"))?;
    if conv.deleted
        || !matches!(
            query["execution_state"].as_str(),
            Some("succeeded" | "failed" | "cancelled")
        )
        || !queries::mark_notified_in_tx(tx, qid).await?
    {
        return Ok(None);
    }
    conversations::append_event_in_tx(tx, conv, &format!("result-{qid}"), "query_result",
        json!({"query_id":qid,"task_id":query["task_id"],"condition_version":query["condition_version"],"state":query["execution_state"]})).await?;
    let task_id = query["task_id"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?;
    let task = analysis::read_task_in_tx(tx, &conv.id, task_id).await?;
    if task["condition_version"] == query["condition_version"]
        && task["phase"] != "waiting_clarification"
    {
        let version = epoch(query["condition_version"].as_str().unwrap_or("0"))?;
        let phase = queries::task_waiting_phase_in_tx(tx, task_id, version)
            .await?
            .unwrap_or("investigating");
        analysis::set_phase_in_tx(tx, task_id, version, phase).await?;
    }
    Ok(Some(task))
}

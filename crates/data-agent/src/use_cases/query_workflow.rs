use crate::{
    contracts,
    modules::{access, analysis, conversations, jobs, queries, runtime},
    persistence::AppTx,
    types::{AccessContext, Error, Result, epoch, id},
};
use serde_json::{Value, json};
use sqlx::MySqlPool;
pub async fn check_text_results(
    pool: &MySqlPool,
    ctx: &AccessContext,
    cid: &str,
    qid: Option<&str>,
) -> Result<super::context_authority::CheckedTextResults> {
    let mut tx = AppTx::begin(pool).await?;
    let authorities = queries::text_authorities_in_tx(&mut tx, ctx, cid, qid).await?;
    tx.commit().await?;
    let mut checked = super::context_authority::CheckedTextResults::default();
    checked.include_authorities(pool, ctx, &authorities).await?;
    Ok(checked)
}

pub async fn validate_text_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    qid: &str,
    checked: &super::context_authority::CheckedTextResults,
) -> Result<Value> {
    let query = queries::read_in_tx(tx, ctx, qid).await?;
    if query["conversation_id"] != cid {
        return Err(Error::new("not_available"));
    }
    conversations::assert_readable_in_tx(tx, ctx, cid).await?;
    let authority = queries::text_authority_in_tx(tx, ctx, qid).await?;
    super::context_authority::validate_text_in_tx(tx, ctx, cid, &authority, checked).await?;
    Ok(authority)
}

pub fn control_projection(mut query: Value) -> Value {
    for key in [
        "sql",
        "parameters",
        "summary",
        "knowledge_refs",
        "error_details",
        "semantic_checks",
    ] {
        query.as_object_mut().expect("query").remove(key);
    }
    query["text_unavailable"] = json!(true);
    query
}

pub async fn protect_text_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    query: &mut Value,
    checked: &super::context_authority::CheckedTextResults,
) -> Result<Value> {
    match validate_text_in_tx(
        tx,
        ctx,
        cid,
        query["id"].as_str().ok_or(Error::new("invalid_input"))?,
        checked,
    )
    .await
    {
        Ok(authority) => Ok(authority),
        Err(error)
            if matches!(
                error.code,
                "stale_context"
                    | "stale_knowledge"
                    | "not_available"
                    | "forbidden"
                    | "invalid_input"
            ) =>
        {
            *query = control_projection(query.clone());
            Ok(super::context_authority::empty())
        }
        Err(error) => Err(error),
    }
}

pub async fn list(pool: &MySqlPool, ctx: &AccessContext, cid: &str) -> Result<Value> {
    let checked = check_text_results(pool, ctx, cid, None).await?;
    let mut tx = AppTx::begin(pool).await?;
    conversations::lock_conversation_in_tx(&mut tx, ctx, cid).await?;
    let mut queries = queries::list_in_tx(&mut tx, cid).await?;
    for query in &mut queries {
        protect_text_in_tx(&mut tx, ctx, cid, query, &checked).await?;
    }
    let blocked = conversations::confirmation_blocked_in_tx(&mut tx, cid).await?;
    tx.commit().await?;
    Ok(json!({"queries":queries,"confirmation_blocked":blocked}))
}
pub async fn read(pool: &MySqlPool, ctx: &AccessContext, qid: &str) -> Result<Value> {
    let location = queries::locate(pool, qid).await?;
    access::authorize_owner(ctx, &location.owner_id, &location.space_id)?;
    let checked = check_text_results(pool, ctx, &location.conversation_id, Some(qid)).await?;
    let mut tx = AppTx::begin(pool).await?;
    conversations::lock_conversation_in_tx(&mut tx, ctx, &location.conversation_id).await?;
    let mut v = queries::read_in_tx(&mut tx, ctx, qid).await?;
    protect_text_in_tx(&mut tx, ctx, &location.conversation_id, &mut v, &checked).await?;
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
    let checked = check_text_results(pool, ctx, &location.conversation_id, Some(qid)).await?;
    let mut tx = AppTx::begin(pool).await?;
    let conv =
        conversations::lock_conversation_in_tx(&mut tx, ctx, &location.conversation_id).await?;
    let v = confirm_bound_in_tx(&mut tx, ctx, &conv, qid, &input, None, &checked).await?;
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
    checked: &super::context_authority::CheckedTextResults,
) -> Result<Value> {
    let message = conversations::read_message_in_tx(tx, conv, &run.message_id).await?;
    // Pi解释执行意图；宿主只接受当前真实用户完整原话，不接受资料或结果唤醒授权。
    if message.disposition != "pending"
        || !message.user_supplied
        || input["instruction_quote"].as_str().map(str::trim) != Some(message.body.trim())
        || conversations::result_query_for_message_in_tx(tx, &conv.id, &message.id)
            .await?
            .is_some()
    {
        return Err(Error::new("invalid_evidence"));
    }
    let qid = input["query_id"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?;
    let query = queries::read_in_tx(tx, ctx, qid).await?;
    let tasks = conversations::message_task_ids_in_tx(tx, conv, &message.id).await?;
    if query["conversation_id"] != conv.id
        || (!tasks.is_empty() && !tasks.iter().any(|task| query["task_id"] == *task))
    {
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
        checked,
    )
    .await?;
    // 只在确认成功后登记；拒绝不遗留新归属。旧查询重放不让本条输入承担旧授权。
    conversations::route_message_in_tx(
        tx,
        conv,
        &message.id,
        query["task_id"].as_str(),
        query["confirmation_state"] != "confirmed",
    )
    .await?;
    Ok(confirmed)
}

async fn confirm_bound_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    conv: &conversations::LockedConversation,
    qid: &str,
    input: &Value,
    authorization: Option<queries::MessageAuthorization<'_>>,
    checked: &super::context_authority::CheckedTextResults,
) -> Result<Value> {
    let blocked = if let Some(message) = &authorization {
        // 本条消息由上层核对真实原话和目标；其他输入的暂停不能随之解除。
        conversations::other_input_blocks_confirmation_in_tx(tx, conv, message.message_id).await?
    } else {
        conversations::confirmation_blocked_in_tx(tx, &conv.id).await?
    };
    analysis::lock_tasks_in_tx(tx, &conv.id).await?;
    let v = queries::read_in_tx(tx, ctx, qid).await?;
    let first_confirmation = v["confirmation_state"] != "confirmed";
    if first_confirmation {
        validate_text_in_tx(tx, ctx, &conv.id, qid, checked).await?;
        analysis::assert_current_in_tx(
            tx,
            &conv.id,
            v["task_id"].as_str().unwrap_or(""),
            epoch(v["condition_version"].as_str().unwrap_or("0"))?,
        )
        .await?;
        super::knowledge::check_refs_in_tx(tx, ctx, &v["knowledge_refs"]).await?;
    }
    let mut v = queries::confirm_in_tx(tx, ctx, qid, input, blocked, authorization).await?;
    protect_text_in_tx(tx, ctx, &conv.id, &mut v, checked).await?;
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
    Ok(control_projection(v))
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
    if v["text_unavailable"] == true {
        return Err(Error::new("stale_context"));
    }
    if v["execution_state"] != "succeeded" {
        return Err(Error::new("result_unavailable"));
    }
    knowledge_check(pool, ctx, &v["knowledge_refs"]).await?;
    let mut result = queries::platform::saved_result_page(
        &json!({"query_id":qid,"owner_id":ctx.user_id,"cursor":cursor}),
    )
    .await?;
    contracts::validate("QueryResults", &result)?;
    if result["query_id"] != qid || result["result_ref"] != v["result_ref"] {
        return Err(Error::new("result_unavailable"));
    }
    result["statistics"] = queries::page_statistics(&result)?;
    contracts::validate("QueryResults", &result)?;
    Ok(result)
}

/// Agent读取投影沿用完整结果页的鉴权、来源和版本检查。
pub async fn agent_results(
    pool: &MySqlPool,
    ctx: &AccessContext,
    qid: &str,
    input: &Value,
) -> Result<Value> {
    let cell_cursor = input["row_index"].as_u64().map(|row| row.to_string());
    let cursor = if input["view"] == "cell" {
        cell_cursor.as_deref()
    } else {
        input["cursor"].as_str()
    };
    let result = results(pool, ctx, qid, cursor).await?;
    queries::agent_result_page(&result, input)
}

pub async fn result_authority(
    pool: &MySqlPool,
    ctx: &AccessContext,
    qid: &str,
    result_ref: &str,
) -> Result<()> {
    let location = queries::locate(pool, qid).await?;
    let checked = check_text_results(pool, ctx, &location.conversation_id, Some(qid)).await?;
    let mut tx = AppTx::begin(pool).await?;
    validate_text_in_tx(&mut tx, ctx, &location.conversation_id, qid, &checked).await?;
    tx.commit().await?;
    result_state_authority(pool, ctx, qid, result_ref).await
}

/// 仅供完整来源快照的结果预检；不交付查询正文，不递归调用正文授权 read。
pub(super) async fn result_state_authority(
    pool: &MySqlPool,
    ctx: &AccessContext,
    qid: &str,
    result_ref: &str,
) -> Result<()> {
    let mut tx = AppTx::begin(pool).await?;
    let query = queries::read_in_tx(&mut tx, ctx, qid).await?;
    conversations::assert_readable_in_tx(
        &mut tx,
        ctx,
        query["conversation_id"]
            .as_str()
            .ok_or(Error::new("not_available"))?,
    )
    .await?;
    if query["execution_state"] != "succeeded" || query["result_ref"].as_str() != Some(result_ref) {
        return Err(Error::new("result_unavailable"));
    }
    super::knowledge::check_refs_in_tx(&mut tx, ctx, &query["knowledge_refs"]).await?;
    tx.commit().await?;
    queries::platform::result_authority(qid, &ctx.user_id, result_ref).await
}

/// 读取已保存页不会创建新查询；每一页复用正常结果读取的当前授权与依据检查。
pub async fn collect_saved_results(
    pool: &MySqlPool,
    ctx: &AccessContext,
    qid: &str,
) -> Result<Value> {
    let mut pages = Vec::new();
    let mut cursor = None;
    let mut received_bytes = 0_usize;
    for _ in 0..queries::SAVED_RESULT_MAX_PAGES {
        let page = results(pool, ctx, qid, cursor.as_deref()).await?;
        if page["fetched_offset"].as_str() != Some(cursor.as_deref().unwrap_or("0"))
            || pages.first().is_some_and(|first: &Value| {
                [
                    "columns",
                    "result_ref",
                    "source",
                    "data_freshness",
                    "saved_row_count",
                    "saved_result_complete",
                    "truncated",
                ]
                .iter()
                .any(|key| page[*key] != first[*key])
            })
        {
            return Err(Error::new("result_unavailable"));
        }
        received_bytes = received_bytes
            .checked_add(
                serde_json::to_vec(&page)
                    .map_err(|_| Error::new("result_unavailable"))?
                    .len(),
            )
            .ok_or(Error::new("request_too_large"))?;
        if received_bytes > queries::SAVED_RESULT_LIMIT {
            return Err(Error::new("request_too_large"));
        }
        cursor = queries::saved_result_next_cursor(&page)?;
        pages.push(page);
        if cursor.is_none() {
            let result = queries::merge_saved_result_pages(qid, &pages)?;
            contracts::validate("QueryResults", &result)?;
            result_authority(
                pool,
                ctx,
                qid,
                result["result_ref"]
                    .as_str()
                    .ok_or(Error::new("result_unavailable"))?,
            )
            .await?;
            return Ok(result);
        }
    }
    Err(Error::new("request_too_large"))
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
    let qid = job["query_id"].as_str().unwrap_or("");
    let mut preflight = AppTx::begin(pool).await?;
    let pending = queries::read_in_tx(&mut preflight, &ctx, qid).await?;
    preflight.commit().await?;
    // unknown 只查证、取消只发送控制操作；不能因旧正文失效而重新提交或中止查证。
    let checked = if pending["execution_state"] == "queued" && pending["cancel_state"] == "none" {
        Some(check_text_results(pool, &ctx, cid, Some(qid)).await?)
    } else {
        None
    };
    let mut tx = AppTx::begin(pool).await?;
    let conv = conversations::lock_for_cleanup_in_tx(&mut tx, &ctx, cid).await?;
    analysis::lock_tasks_in_tx(&mut tx, cid).await?;
    let query = queries::read_in_tx(&mut tx, &ctx, qid).await?;
    let authorization_error = if query["execution_state"] == "queued"
        && query["cancel_state"] == "none"
    {
        match checked.as_ref() {
            Some(checked) => match validate_text_in_tx(&mut tx, &ctx, cid, qid, checked).await {
                Ok(_) => None,
                Err(error)
                    if matches!(
                        error.code,
                        "stale_context"
                            | "stale_knowledge"
                            | "not_available"
                            | "forbidden"
                            | "invalid_input"
                    ) =>
                {
                    Some(error.code)
                }
                Err(error) => return Err(error),
            },
            None => Some("stale_context"),
        }
    } else {
        None
    };
    let packet = queries::begin_submission_in_tx(&mut tx, &ctx, &job).await?;
    tx.commit().await?;
    let qid = job["query_id"].as_str().unwrap_or("");
    let action = packet["action"].as_str().unwrap_or("lookup");
    let observation = if action == "submit" && authorization_error.is_some() {
        json!({"state":"failed","error":authorization_error})
    } else {
        let path = match action {
            "submit" => "/submit",
            "cancel" => "/cancel",
            _ => "/lookup",
        };
        let payload = if action == "submit" {
            json!({"query_id":qid,"owner_id":ctx.user_id,"sql":packet["sql"],"parameters":packet["parameters"],"target_id":packet["target_id"],"target_version":packet["target_version"]})
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
                            | "version_conflict"
                            | "source_version_conflict"
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

mod saved_results;
pub use saved_results::{
    agent_results, collect_saved_results, collect_saved_results_for_display, result_authority,
    results,
};
pub(super) use saved_results::{check_result_authority, result_state_authority};
mod execution;
pub(super) use execution::authorize_pending_execution;
pub use execution::process_due;

use crate::{
    contracts::generated::ConfirmQuery,
    modules::{access, analysis, conversations, jobs, knowledge, queries, runtime},
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
    conversations::assert_readable_in_tx(&mut tx, ctx, cid).await?;
    let mut historical = Vec::new();
    for query in queries::list_in_tx(&mut tx, cid).await? {
        if qid.is_some_and(|id| query["id"] != id) {
            continue;
        }
        let conditions = analysis::read_evidence_conditions_in_tx(
            &mut tx,
            ctx,
            cid,
            query["task_id"]
                .as_str()
                .ok_or(Error::new("invalid_input"))?,
            epoch(
                query["condition_version"]
                    .as_str()
                    .ok_or(Error::new("invalid_input"))?,
            )?,
        )
        .await?;
        match super::historical_analysis::query_projection_in_tx(&mut tx, ctx, &query, &conditions)
            .await
        {
            Ok(entry) => historical.push(entry["actual_sources"]["authority"].clone()),
            Err(error) if matches!(error.code, "stale_context" | "not_available") => (),
            Err(error) => return Err(error),
        }
    }
    tx.commit().await?;
    let mut checked = super::context_authority::CheckedTextResults::default();
    checked.include(pool, ctx, &historical, true).await?;
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
    let authority = super::context_authority::from_sources(&query)?;
    if !checked.allows(&authority, false) {
        return Err(Error::new("stale_context"));
    }
    super::knowledge::check_refs_in_tx(tx, ctx, &query["knowledge_refs"]).await?;
    Ok(authority)
}

pub fn control_projection(mut query: Value) -> Result<Value> {
    let fields = query.as_object_mut().ok_or(Error::new("unavailable"))?;
    for key in [
        "sql",
        "parameters",
        "summary",
        "knowledge_refs",
        "error_details",
        "semantic_checks",
        "semantic_resolution",
        "time_basis",
    ] {
        fields.remove(key);
    }
    fields.insert("text_unavailable".into(), json!(true));
    Ok(query)
}

/// 查询正文读取的三种结局：Current=当前核验通过；Historical=严格
/// 核验因语义改版或结果漂移失败、但历史展示核验仍通过（正文作为已存记录展示，
/// 不再是当前口径依据）；Restricted=撤权/删除/停用/越权，正文隐藏。
pub enum ProtectedText {
    Current(Value),
    Historical { entry: Value, conditions: Value },
    Restricted,
}

pub async fn protect_text_outcome_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    query: &Value,
    checked: &super::context_authority::CheckedTextResults,
) -> Result<ProtectedText> {
    let authority = super::context_authority::from_sources(query)?;
    let strict = super::context_authority::validate_in_tx(
        tx,
        ctx,
        &authority,
        super::context_authority::AuthorityUse::Text(checked),
    )
    .await;
    match strict {
        Ok(_) => Ok(ProtectedText::Current(authority)),
        Err(error)
            if matches!(
                error.code,
                "stale_context" | "stale_knowledge" | "invalid_input"
            ) =>
        {
            // 读取前核全部历史来源，包括原条件及已保存结果；不能等下一次派发才拒绝。
            let historical = async {
                let conditions = analysis::read_evidence_conditions_in_tx(
                    tx,
                    ctx,
                    cid,
                    query["task_id"]
                        .as_str()
                        .ok_or(Error::new("invalid_input"))?,
                    epoch(
                        query["condition_version"]
                            .as_str()
                            .ok_or(Error::new("invalid_input"))?,
                    )?,
                )
                .await?;
                let entry =
                    super::historical_analysis::query_projection_in_tx(tx, ctx, query, &conditions)
                        .await?;
                let sources = &entry["actual_sources"]["authority"];
                if !checked.allows(sources, true) {
                    return Err(Error::new("not_available"));
                }
                super::context_authority::validate_in_tx(
                    tx,
                    ctx,
                    sources,
                    super::context_authority::AuthorityUse::Historical,
                )
                .await?;
                Ok((entry, conditions))
            }
            .await;
            match historical {
                Ok((entry, conditions)) => Ok(ProtectedText::Historical { entry, conditions }),
                Err(error) if super::personal_assets::unavailable_text(&error) => {
                    Ok(ProtectedText::Restricted)
                }
                Err(error) => Err(error),
            }
        }
        Err(error) if matches!(error.code, "forbidden" | "not_available") => {
            Ok(ProtectedText::Restricted)
        }
        Err(error) => Err(error),
    }
}

/// Web查询读取固定为history_display：语义改版保留已存SQL/参数/说明并标记
/// text_historical；撤权类仍隐藏正文。模型路径（get_query）不复用此函数。
pub async fn protect_text_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    query: &mut Value,
    checked: &super::context_authority::CheckedTextResults,
) -> Result<Value> {
    match protect_text_outcome_in_tx(tx, ctx, cid, query, checked).await? {
        ProtectedText::Current(authority) => Ok(authority),
        ProtectedText::Historical { .. } => {
            query["text_historical"] = json!(true);
            Ok(super::context_authority::empty())
        }
        ProtectedText::Restricted => {
            *query = control_projection(query.clone())?;
            Ok(super::context_authority::empty())
        }
    }
}

pub async fn list(pool: &MySqlPool, ctx: &AccessContext, cid: &str) -> Result<Value> {
    let checked = check_text_results(pool, ctx, cid, None).await?;
    let mut tx = AppTx::begin(pool).await?;
    conversations::lock_conversation_in_tx(&mut tx, ctx, cid).await?;
    let mut queries = queries::list_in_tx(&mut tx, cid).await?;
    let anchors = conversations::first_query_changed_seq_in_tx(&mut tx, cid).await?;
    for query in &mut queries {
        protect_text_in_tx(&mut tx, ctx, cid, query, &checked).await?;
        query["timeline_event_seq"] = query["id"]
            .as_str()
            .and_then(|id| anchors.get(id))
            .map(|seq| json!(seq))
            .unwrap_or(Value::Null);
    }
    let blocked = conversations::confirmation_blocked_in_tx(&mut tx, cid).await?;
    tx.commit().await?;
    Ok(json!({"queries":queries,"confirmation_blocked":blocked}))
}
/// 跨会话查询历史：按创建时间倒序，正文授权沿用会话内同一保护逻辑。
/// 不可见会话（已删除/越权）的查询被过滤；每轮多取一页原料以判断是否还有更早记录。
pub async fn history(
    pool: &MySqlPool,
    ctx: &AccessContext,
    before: Option<&str>,
    query: &str,
) -> Result<Value> {
    const PAGE: usize = 50;
    let mut items = Vec::new();
    let mut cursor = before.map(str::to_owned);
    loop {
        let mut tx = AppTx::begin(pool).await?;
        let mut rows = queries::list_history_page_in_tx(
            &mut tx,
            ctx,
            cursor.as_deref(),
            query,
            PAGE as u64 + 1,
        )
        .await?;
        let exhausted = rows.len() <= PAGE;
        cursor = rows
            .last()
            .and_then(|row| row["id"].as_str())
            .map(str::to_owned);
        let conversations: std::collections::HashSet<_> = rows
            .iter()
            .filter_map(|row| row["conversation_id"].as_str().map(str::to_owned))
            .collect();
        let visible = conversations::visible_ids_in_tx(
            &mut tx,
            ctx,
            &conversations.into_iter().collect::<Vec<_>>(),
        )
        .await?;
        tx.commit().await?;
        rows.retain(|row| {
            row["conversation_id"]
                .as_str()
                .is_some_and(|cid| visible.contains(cid))
        });
        for cid in visible {
            let checked = check_text_results(pool, ctx, &cid, None).await?;
            let mut tx = AppTx::begin(pool).await?;
            let anchors = conversations::first_query_changed_seq_in_tx(&mut tx, &cid).await?;
            for row in rows.iter_mut().filter(|row| row["conversation_id"] == cid) {
                protect_text_in_tx(&mut tx, ctx, &cid, row, &checked).await?;
                // 核验历史来源所需的字段不属于列表的公共返回形状。
                let fields = row
                    .as_object_mut()
                    .ok_or(crate::types::Error::new("unavailable"))?;
                fields.remove("knowledge_refs");
                fields.remove("result_ref");
                row["timeline_event_seq"] =
                    json!(row["id"].as_str().and_then(|id| anchors.get(id)));
            }
            tx.commit().await?;
        }
        items.extend(
            rows.into_iter()
                .filter(|row| query.is_empty() || row["text_unavailable"] != true),
        );
        if items.len() > PAGE || exhausted {
            break;
        }
    }
    let has_more = items.len() > PAGE;
    items.truncate(PAGE);
    let next = if has_more {
        items.last().and_then(|row| row["id"].as_str())
    } else {
        None
    };
    Ok(json!({"queries":items,"next_before_id":next}))
}

async fn query_location(pool: &MySqlPool, qid: &str) -> Result<crate::types::RunLocation> {
    let (cid, owner) = queries::locate(pool, qid).await?;
    let location = conversations::locate_conversation(pool, &cid).await?;
    if location.owner_id != owner {
        return Err(Error::new("not_available"));
    }
    Ok(location)
}

pub async fn read(pool: &MySqlPool, ctx: &AccessContext, qid: &str) -> Result<Value> {
    let location = query_location(pool, qid).await?;
    access::authorize_owner(ctx, &location.owner_id, &location.space_id)?;
    let checked = check_text_results(pool, ctx, &location.conversation_id, Some(qid)).await?;
    let mut tx = AppTx::begin(pool).await?;
    conversations::lock_conversation_in_tx(&mut tx, ctx, &location.conversation_id).await?;
    let mut v = queries::read_in_tx(&mut tx, ctx, qid).await?;
    protect_text_in_tx(&mut tx, ctx, &location.conversation_id, &mut v, &checked).await?;
    v["timeline_event_seq"] =
        conversations::first_query_changed_seq_in_tx(&mut tx, &location.conversation_id)
            .await?
            .get(v["id"].as_str().unwrap_or(""))
            .map(|seq| json!(seq))
            .unwrap_or(Value::Null);
    tx.commit().await?;
    Ok(v)
}
pub async fn confirm(
    pool: &MySqlPool,
    ctx: &AccessContext,
    qid: &str,
    input: ConfirmQuery,
) -> Result<Value> {
    let input = json!({"operation_id": input.operation_id, "draft_version": input.draft_version, "condition_version": input.condition_version});
    let location = query_location(pool, qid).await?;
    access::authorize_owner(ctx, &location.owner_id, &location.space_id)?;
    authorize_pending_execution(pool, ctx, &location.conversation_id, &[qid.into()]).await?;
    let checked = check_text_results(pool, ctx, &location.conversation_id, Some(qid)).await?;
    let mut tx = AppTx::begin(pool).await?;
    let conv =
        conversations::lock_conversation_in_tx(&mut tx, ctx, &location.conversation_id).await?;
    let v = confirm_bound_in_tx(&mut tx, ctx, &conv, qid, &input, None, &checked)
        .await
        .map_err(|mut error| {
            if error.code == "stale_knowledge" {
                error.code = "stale_context";
            }
            error
        })?;
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
    let batch = input.get("queries").and_then(Value::as_array);
    let requested: Vec<&Value> = batch
        .map(|queries| queries.iter().collect())
        .unwrap_or_else(|| vec![input]);
    let tasks = conversations::message_task_ids_in_tx(tx, conv, &message.id).await?;
    let mut ids = std::collections::BTreeSet::new();
    let mut queries = Vec::with_capacity(requested.len());
    for item in &requested {
        let qid = item["query_id"]
            .as_str()
            .ok_or(Error::new("invalid_input"))?;
        if !ids.insert(qid) {
            return Err(Error::new("invalid_input"));
        }
        let query = queries::read_in_tx(tx, ctx, qid).await?;
        // 批量入口的完整查询集合明确本次目标；旧单条入口保留已登记目标边界。
        if query["conversation_id"] != conv.id
            || (batch.is_none()
                && !tasks.is_empty()
                && !tasks.iter().any(|task| query["task_id"] == *task))
        {
            return Err(Error::new("not_available"));
        }
        queries.push(query);
    }
    // 整批共用任务锁与事务；后续项失败会回滚前面确认，不让首项的路由改变准入范围。
    analysis::lock_tasks_in_tx(tx, &conv.id).await?;
    let mut confirmed = Vec::with_capacity(queries.len());
    for (item, query) in requested.iter().zip(&queries) {
        let confirmation = json!({"operation_id":operation,"draft_version":item["draft_version"],"condition_version":item["condition_version"]});
        confirmed.push(
            confirm_locked_in_tx(
                tx,
                ctx,
                conv,
                query["id"].as_str().ok_or(Error::new("invalid_input"))?,
                &confirmation,
                Some(queries::MessageAuthorization {
                    message_id: &message.id,
                    budget_scope_id: &run.budget_scope_id,
                }),
                checked,
            )
            .await?,
        );
    }
    // 整批确认后才登记；已确认项重放不让本条输入承担旧授权和预算。
    let mut confirmed_tasks = std::collections::BTreeSet::new();
    for query in &queries {
        let task = query["task_id"].as_str();
        if let Some(task) = task {
            confirmed_tasks.insert(task.to_owned());
        }
        conversations::route_message_in_tx(
            tx,
            conv,
            &message.id,
            task,
            query["confirmation_state"] != "confirmed",
        )
        .await?;
    }
    // 批量已确认SQL控制仍逐项校验；同批跨任务不隐式切换活动目标，只有唯一
    // 所属任务时按其当前版本保存活动绑定（每项的condition_version已核当前）。
    if let [task] = confirmed_tasks.iter().collect::<Vec<_>>()[..] {
        let version = queries
            .iter()
            .find(|query| query["task_id"].as_str() == Some(task.as_str()))
            .and_then(|query| query["condition_version"].as_str())
            .unwrap_or("0");
        conversations::bind_active_task_in_tx(tx, conv, task, epoch(version)?).await?;
    }
    if batch.is_some() {
        Ok(json!({"queries":confirmed}))
    } else {
        confirmed.pop().ok_or(Error::new("invalid_input"))
    }
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
    analysis::lock_tasks_in_tx(tx, &conv.id).await?;
    confirm_locked_in_tx(tx, ctx, conv, qid, input, authorization, checked).await
}

async fn confirm_locked_in_tx(
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
    let location = query_location(pool, qid).await?;
    access::authorize_owner(ctx, &location.owner_id, &location.space_id)?;
    let mut tx = AppTx::begin(pool).await?;
    let conv =
        conversations::lock_conversation_in_tx(&mut tx, ctx, &location.conversation_id).await?;
    let v = cancel_in_tx(&mut tx, ctx, &conv, qid).await?;
    tx.commit().await?;
    control_projection(v)
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

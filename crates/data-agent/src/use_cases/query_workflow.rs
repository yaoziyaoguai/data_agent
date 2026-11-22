mod execution;
pub(super) use execution::authorize_pending_execution;
pub use execution::process_due;

use crate::{
    contracts,
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
    let authority = super::context_authority::from_sources(&query);
    if !checked.allows(&authority, false) {
        return Err(Error::new("stale_context"));
    }
    super::knowledge::check_refs_in_tx(tx, ctx, &query["knowledge_refs"]).await?;
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
        "semantic_resolution",
        "time_basis",
    ] {
        query.as_object_mut().expect("query").remove(key);
    }
    query["text_unavailable"] = json!(true);
    query
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
    let authority = super::context_authority::from_sources(query);
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
            *query = control_projection(query.clone());
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
                let fields = row.as_object_mut().expect("query history row");
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

pub async fn read(pool: &MySqlPool, ctx: &AccessContext, qid: &str) -> Result<Value> {
    let location = queries::locate(pool, qid).await?;
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
    input: Value,
) -> Result<Value> {
    contracts::validate("ConfirmQuery", &input)?;
    let location = queries::locate(pool, qid).await?;
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
    results_with(pool, ctx, qid, cursor, false).await
}

/// 展示路径的结果读取（04切片7）：知识引用按历史规则核验——版本漂移不隐藏
/// 已存结果数据；对象撤下或上游被撤仍拒绝。保存/采用路径沿用results。
async fn results_for_display(
    pool: &MySqlPool,
    ctx: &AccessContext,
    qid: &str,
    cursor: Option<&str>,
) -> Result<Value> {
    results_with(pool, ctx, qid, cursor, true).await
}

async fn results_with(
    pool: &MySqlPool,
    ctx: &AccessContext,
    qid: &str,
    cursor: Option<&str>,
    history_refs: bool,
) -> Result<Value> {
    let v = read(pool, ctx, qid).await?;
    if v["text_unavailable"] == true {
        return Err(Error::new("stale_context"));
    }
    if v["execution_state"] != "succeeded" {
        return Err(Error::new("result_unavailable"));
    }
    if history_refs {
        history_knowledge_check(pool, ctx, &v["knowledge_refs"]).await?;
    } else {
        knowledge_check(pool, ctx, &v["knowledge_refs"]).await?;
    }
    let mut result = queries::platform::saved_result_page(
        &json!({"query_id":qid,"owner_id":ctx.user_id,"cursor":cursor}),
    )
    .await?;
    contracts::validate("QueryResults", &result)?;
    if result["query_id"] != qid || result["result_ref"] != v["result_ref"] {
        return Err(Error::new("result_unavailable"));
    }
    result["statistics"] = queries::page_statistics(&result)?;
    if let Some(refs) = v["knowledge_refs"]
        .as_array()
        .filter(|refs| !refs.is_empty())
    {
        let mut tx = AppTx::begin(pool).await?;
        let snapshot =
            knowledge::semantic_snapshot_in_tx(&mut tx, ctx, &v["knowledge_refs"]).await?;
        tx.commit().await?;
        if let (Some(sql), Some(columns)) = (v["sql"].as_str(), result["columns"].as_array_mut()) {
            queries::annotate_result_columns(sql, columns, &snapshot, refs);
        }
    }
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
    check_result_authority(pool, ctx, qid, result_ref, false).await
}

/// 核对结果出处和现有平台访问。已保存的历史正文只免除结果 TTL。
pub(super) async fn check_result_authority(
    pool: &MySqlPool,
    ctx: &AccessContext,
    qid: &str,
    result_ref: &str,
    historical: bool,
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
        return Err(Error::new(if historical {
            "invalid_evidence"
        } else {
            "result_unavailable"
        }));
    }
    if historical {
        super::knowledge::history_check_refs_in_tx(&mut tx, ctx, &query["knowledge_refs"]).await?;
    } else {
        super::knowledge::check_refs_in_tx(&mut tx, ctx, &query["knowledge_refs"]).await?;
    }
    tx.commit().await?;
    match queries::platform::result_authority(qid, &ctx.user_id, result_ref).await {
        Err(error) if historical && error.code == "result_expired" => Ok(()),
        result => result,
    }
}

pub(super) async fn result_state_authority(
    pool: &MySqlPool,
    ctx: &AccessContext,
    qid: &str,
    reference: &str,
) -> Result<()> {
    check_result_authority(pool, ctx, qid, reference, false).await
}

/// 读取已保存页不会创建新查询；每一页复用正常结果读取的当前授权与依据检查。
pub async fn collect_saved_results(
    pool: &MySqlPool,
    ctx: &AccessContext,
    qid: &str,
) -> Result<Value> {
    collect_saved_results_with(pool, ctx, qid, true).await
}

/// 展示路径的已存结果收集（04切片7）：图表数据按结果状态授权交付，不做正文
/// 严格核验——查询正文曾依赖的其他结果过期只影响口径说明，不隐藏本结果数据；
/// 撤权类仍由结果状态授权拒绝。保存/采用路径继续用collect_saved_results。
pub async fn collect_saved_results_for_display(
    pool: &MySqlPool,
    ctx: &AccessContext,
    qid: &str,
) -> Result<Value> {
    collect_saved_results_with(pool, ctx, qid, false).await
}

async fn collect_saved_results_with(
    pool: &MySqlPool,
    ctx: &AccessContext,
    qid: &str,
    strict_text: bool,
) -> Result<Value> {
    let mut pages = Vec::new();
    let mut cursor = None;
    let mut received_bytes = 0_usize;
    for _ in 0..queries::SAVED_RESULT_MAX_PAGES {
        let page = if strict_text {
            results(pool, ctx, qid, cursor.as_deref()).await?
        } else {
            results_for_display(pool, ctx, qid, cursor.as_deref()).await?
        };
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
            let reference = result["result_ref"]
                .as_str()
                .ok_or(Error::new("result_unavailable"))?;
            if strict_text {
                result_authority(pool, ctx, qid, reference).await?;
            } else if let Err(error) =
                check_result_authority(pool, ctx, qid, reference, false).await
            {
                // 展示路径的知识引用已在results_for_display按历史规则核验（撤权类
                // 在那层整份拒绝）；末次状态授权里的严格引用核验对版本漂移类失败
                // 不隐藏图表数据（04切片7），撤权与过期类照常上抛——与展示路径
                // 直接调用处的容忍清单一致。
                if !matches!(
                    error.code,
                    "stale_context" | "stale_knowledge" | "invalid_input"
                ) {
                    return Err(error);
                }
            }
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

async fn history_knowledge_check(
    pool: &MySqlPool,
    ctx: &AccessContext,
    refs: &Value,
) -> Result<()> {
    let mut tx = AppTx::begin(pool).await?;
    super::knowledge::history_check_refs_in_tx(&mut tx, ctx, refs).await?;
    tx.commit().await
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

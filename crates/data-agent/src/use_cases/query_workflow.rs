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
    let authorities = queries::text_authorities_in_tx(&mut tx, ctx, cid, qid).await?;
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
    checked.include_authorities(pool, ctx, &authorities).await?;
    checked.include_history(pool, ctx, &historical).await?;
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
    let qid = query["id"].as_str().ok_or(Error::new("invalid_input"))?;
    let authority = queries::text_authority_in_tx(tx, ctx, qid).await?;
    let strict = if !checked.allows(&authority) {
        Err(Error::new("stale_context"))
    } else {
        super::context_authority::validate_in_tx(tx, ctx, cid, &authority).await
    };
    match strict {
        Ok(()) => Ok(ProtectedText::Current(authority)),
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
                if !checked.allows_history(sources) {
                    return Err(Error::new("not_available"));
                }
                super::context_authority::validate_history_in_tx(tx, ctx, cid, sources).await?;
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
    const FETCH_ROUNDS: usize = 5;
    let mut items = Vec::new();
    let mut next_before_id = Value::Null;
    let mut cursor = before.map(str::to_owned);
    for _ in 0..FETCH_ROUNDS {
        let mut tx = AppTx::begin(pool).await?;
        let rows = queries::list_history_page_in_tx(
            &mut tx,
            ctx,
            cursor.as_deref(),
            query,
            PAGE as u64 + 1,
        )
        .await?;
        let cids: Vec<String> = rows
            .iter()
            .filter_map(|row| row["conversation_id"].as_str().map(str::to_owned))
            .collect::<std::collections::HashSet<_>>()
            .into_iter()
            .collect();
        let visible = conversations::visible_ids_in_tx(&mut tx, ctx, &cids).await?;
        tx.commit().await?;
        let exhausted = rows.len() <= PAGE;
        for row in rows {
            if items.len() == PAGE {
                break;
            }
            if !row["conversation_id"]
                .as_str()
                .is_some_and(|cid| visible.contains(cid))
            {
                continue;
            }
            cursor = row["id"].as_str().map(str::to_owned);
            items.push(row);
        }
        if items.len() == PAGE {
            next_before_id = json!(cursor);
            break;
        }
        if exhausted {
            break;
        }
    }
    // 正文保护按会话分组做同一授权检查；timeline锚点也在同会话读取事务中取。
    let mut tx = AppTx::begin(pool).await?;
    let by_conversation: std::collections::HashMap<String, Vec<usize>> = items
        .iter()
        .enumerate()
        .filter_map(|(index, row)| {
            row["conversation_id"]
                .as_str()
                .map(|cid| (cid.to_owned(), index))
        })
        .fold(
            std::collections::HashMap::new(),
            |mut groups, (cid, index)| {
                groups.entry(cid).or_default().push(index);
                groups
            },
        );
    let mut anchors = std::collections::HashMap::new();
    for (cid, indexes) in &by_conversation {
        let checked = check_text_results(pool, ctx, cid, None).await?;
        for index in indexes {
            protect_text_in_tx(&mut tx, ctx, cid, &mut items[*index], &checked).await?;
        }
        let conversation_anchors =
            conversations::first_query_changed_seq_in_tx(&mut tx, cid).await?;
        anchors.extend(conversation_anchors);
    }
    tx.commit().await?;
    let queries: Vec<Value> = items
        .iter_mut()
        .map(|row| {
            row["timeline_event_seq"] = row["id"]
                .as_str()
                .and_then(|id| anchors.get(id))
                .map(|seq| json!(seq))
                .unwrap_or(Value::Null);
            row.clone()
        })
        .collect();
    Ok(json!({"queries":queries,"next_before_id":next_before_id}))
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
    super::context_authority::assert_run_in_tx(tx, ctx, &conv.id, &run.id).await?;
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

/// U-05列注解：SQL投影列名与知识对象精确相等才附带中文列名/单位。
/// metric同时认对象名与指标标识；字段含义取meaning条目、单位取unit条目，
/// 缺条目就不注解——聚合别名、未知列一律保持原始列名，不从列名猜业务含义。
async fn column_annotations(
    pool: &MySqlPool,
    ctx: &AccessContext,
    knowledge_refs: &Value,
) -> Result<std::collections::HashMap<String, (String, Option<String>)>> {
    let mut annotations = std::collections::HashMap::new();
    let Some(refs) = knowledge_refs.as_array() else {
        return Ok(annotations);
    };
    let mut tx = AppTx::begin(pool).await?;
    for reference in refs {
        let Some(object_id) = reference["object_id"].as_str() else {
            continue;
        };
        let version = reference["version"].as_str().and_then(|v| epoch(v).ok());
        let object = match knowledge::read_in_tx(&mut tx, ctx, object_id, version, false).await {
            Ok(object) => object,
            Err(_) => continue,
        };
        let kind = object["kind"].as_str().unwrap_or("");
        if kind != "field" && kind != "metric" {
            continue;
        }
        let entries = object["entries"].as_array().cloned().unwrap_or_default();
        let value_of = |path: &str| {
            entries
                .iter()
                .find(|entry| entry["path"] == path)
                .and_then(|entry| entry["effective_value"].as_str())
                .filter(|value| !value.trim().is_empty())
                .map(str::to_owned)
        };
        let unit = value_of("unit");
        let label = if kind == "metric" {
            object["name"].as_str().unwrap_or("").trim().to_owned()
        } else {
            value_of("meaning").unwrap_or_default()
        };
        if label.is_empty() {
            continue;
        }
        let mut keys = vec![object["name"].as_str().unwrap_or("").to_owned()];
        if kind == "metric" {
            keys.extend(object_id.strip_prefix("metric-").map(str::to_owned));
        }
        for key in keys.into_iter().filter(|key| !key.is_empty()) {
            annotations
                .entry(key)
                .or_insert_with(|| (label.clone(), unit.clone()));
        }
    }
    Ok(annotations)
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
    // 列注解按引用对象的精确名匹配附加；未匹配列保持原样，校验含新增可选字段。
    let annotations = column_annotations(pool, ctx, &v["knowledge_refs"]).await?;
    if let Some(columns) = result["columns"].as_array_mut() {
        for column in columns {
            if let Some((label, unit)) = column["name"]
                .as_str()
                .and_then(|name| annotations.get(name))
            {
                column["display_label"] = json!(label);
                if let Some(unit) = unit {
                    column["unit"] = json!(unit);
                }
            }
        }
    }
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

/// 历史正文仍核当前平台访问；只忽略原始结果TTL，不能用语义改版跳过平台。
pub(super) async fn historical_result_authority(
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
        return Err(Error::new("invalid_evidence"));
    }
    super::knowledge::history_check_refs_in_tx(&mut tx, ctx, &query["knowledge_refs"]).await?;
    tx.commit().await?;
    match queries::platform::result_authority(qid, &ctx.user_id, result_ref).await {
        Err(error) if error.code == "result_expired" => Ok(()),
        result => result,
    }
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
            } else if let Err(error) = result_state_authority(pool, ctx, qid, reference).await {
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
    // 与消息准备相同，两份future并行推进；续租等待查询行锁时不能暂停准备事务。
    let heartbeat = async {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(
            u64::from(queries::LEASE_SECONDS) / 3,
        ));
        loop {
            interval.tick().await;
            if let Err(error) = queries::renew_claim(pool, &job, worker).await {
                if !error.is_transient_storage() {
                    return Err(error);
                }
                eprintln!(
                    "query_prepare_renew_transient query={qid} code={}",
                    error.code
                );
            }
        }
    };
    let prepare = async {
        let mut preflight = AppTx::begin(pool).await?;
        let pending = queries::read_in_tx(&mut preflight, &ctx, qid).await?;
        preflight.commit().await?;
        // unknown 只查证、取消只发送控制操作；不能因旧正文失效而重新提交或中止查证。
        let checked = if pending["execution_state"] == "queued" && pending["cancel_state"] == "none"
        {
            Some(check_text_results(pool, &ctx, cid, Some(qid)).await?)
        } else {
            None
        };
        let mut tx = AppTx::begin(pool).await?;
        let conv = conversations::lock_for_cleanup_in_tx(&mut tx, &ctx, cid).await?;
        analysis::lock_tasks_in_tx(&mut tx, cid).await?;
        let query = queries::read_in_tx(&mut tx, &ctx, qid).await?;
        let authorization_error =
            if query["execution_state"] == "queued" && query["cancel_state"] == "none" {
                match checked.as_ref() {
                    Some(checked) => {
                        match validate_text_in_tx(&mut tx, &ctx, cid, qid, checked).await {
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
                        }
                    }
                    None => Some("stale_context"),
                }
            } else {
                None
            };
        let packet = queries::begin_submission_in_tx(&mut tx, &ctx, &job).await?;
        tx.commit().await?;
        Ok::<_, Error>((conv, packet, authorization_error))
    };
    let (conv, packet, authorization_error) = tokio::select! {
        result = prepare => result?,
        result = heartbeat => return result,
    };
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
            // 活动任务绑定不在完成事务里做：worker完成时刻不持轮租约，晚到查询
            // 会改写其他任务运行中的会话活动范围（04关闭审查修复）。归属在结果
            // 输入自己的交付事务（deliver_run，持租约串行）里落到该查询的任务。
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

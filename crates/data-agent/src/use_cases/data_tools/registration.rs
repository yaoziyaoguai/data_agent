use super::*;

pub(super) fn input_schema(name: &str) -> Result<&'static str> {
    Ok(match name {
        "search_knowledge" => "KnowledgeSearchInput",
        "read_knowledge" => "KnowledgeReadInput",
        "read_source" => "SourceReadInput",
        "read" => "SkillReadInput",
        "validate_sql" => "SQLInput",
        "request_query" => "CurrentRequestQueryInput",
        "execute_query" => "ExecuteQueryInput",
        "update_analysis_task" => "CurrentAnalysisUpdate",
        "get_query" => "GetQueryInput",
        "cancel_query" => "ReadQueryInput",
        "save_analysis_evidence" => "SaveAnalysisEvidenceInput",
        "prepare_analysis_answer" => "PrepareAnalysisAnswerInput",
        "save_analysis_report" => "SaveAnalysisReportInput",
        "read_analysis_report" => "ReadAnalysisReportInput",
        "prepare_skill_draft" => "PrepareSkillDraftInput",
        "manage_personal_asset" => "AssetToolInput",
        "propose_semantic_change" => "ProposalInput",
        "read_conversation" => "ConversationReadInput",
        "read_analysis_task" => "ReadTaskInput",
        _ => return Err(Error::new("unsupported")),
    })
}
pub(super) fn text<'a>(input: &'a Value, key: &str) -> Result<&'a str> {
    input[key].as_str().ok_or(Error::new("invalid_input"))
}
pub(super) fn cancellation_state(query: &Value) -> Value {
    json!({"id":query["id"],"task_id":query["task_id"],"condition_version":query["condition_version"],"execution_state":query["execution_state"],"cancel_state":query["cancel_state"]})
}
pub(super) fn query_recovery(query: &Value) -> Value {
    json!({
        "query_id":query["id"],"task_id":query["task_id"],
        "condition_version":query["condition_version"],"draft_version":query["draft_version"],
        "confirmation_state":query["confirmation_state"],"execution_state":query["execution_state"],
        "cancel_state":query["cancel_state"],
        "read_tool":{"name":"get_query","arguments":{"query_id":query["id"]}}
    })
}
// 读任务当前条件声明的口径决策（整列读body在模块store提取：JSON路径表达式遇NULL
// 会解码失败）。任务尚不可读时返回None，由后续授权路径给出明确错误。
pub(super) async fn condition_decision_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
    task: Option<&str>,
) -> Result<Option<analysis::ConditionRevision>> {
    let Some(task) = task else {
        return Ok(None);
    };
    analysis::current_condition_revision_in_tx(tx, cid, task).await
}

pub(super) async fn request_conditions_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    conversation: &conversations::LockedConversation,
    message_id: &str,
    args: &Value,
) -> Result<Value> {
    let cid = &conversation.id;
    analysis::lock_tasks_in_tx(tx, cid).await?;
    let task = text(args, "task_id")?;
    let version = epoch(text(args, "condition_version")?)?;
    analysis::assert_current_in_tx(tx, cid, task, version).await?;
    conversations::assert_routed_in_tx(tx, conversation, message_id).await?;
    let conditions = analysis::read_evidence_conditions_in_tx(tx, ctx, cid, task, version).await?;
    let references = super::super::query_semantics::knowledge_references(&[args, &conditions]);
    // 草稿沿同一已核条目选择及当前结构绑定核来源门，不再回读整对象扩大范围。
    let draft_gate = super::super::source_limits::resolve_for_task_in_tx(tx, cid, task).await?;
    super::super::knowledge::check_refs_for_task_in_tx(tx, ctx, &references, draft_gate.as_ref())
        .await?;
    Ok(conditions)
}

// 时间基准从任务当前条件投影成草稿快照：观察截点/批次跟草稿走，任务后来改版不改写
// 已保存草稿的含义。只在time_roles非空时投影；未声明的草稿保存NULL，答案侧
// 不得以request_clock或平台data_freshness冒充截点/批次。
pub(super) fn time_basis_of(conditions: &Value) -> Result<Option<Value>> {
    let Some(roles) = conditions.get("time_roles").and_then(Value::as_array) else {
        return Ok(None);
    };
    if roles.is_empty() {
        return Ok(None);
    }
    let basis = json!({
        "time_start": conditions.get("time_start").cloned().unwrap_or(Value::Null),
        "time_end": conditions.get("time_end").cloned().unwrap_or(Value::Null),
        "timezone": conditions.get("timezone").cloned().unwrap_or(Value::Null),
        "time_roles": roles,
    });
    contracts::validate("TimeBasis", &basis)?;
    Ok(Some(basis))
}

pub(super) async fn semantic_diagnostics_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    args: &Value,
    gate: Option<&super::super::source_limits::SourceGate>,
) -> Result<Value> {
    let refs = args
        .get("knowledge_refs")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let mut snapshot = knowledge::semantic_snapshot_in_tx(tx, ctx, &refs).await?;
    let mut valid = Vec::new();
    let objects = snapshot["objects"].as_array().cloned().unwrap_or_default();
    for object in objects {
        match super::super::knowledge::assert_source_in_tx(tx, ctx, &object).await {
            Ok(()) => {
                // 只读诊断把范围外对象记为覆盖缺口；正式保存路径在条件授权处已硬拒绝。
                let within_limits = gate
                    .map(|gate| gate.allows_object(&object))
                    .transpose()?
                    .unwrap_or(true);
                if within_limits {
                    valid.push(object);
                } else {
                    snapshot["coverage"]["notes"]
                        .as_array_mut()
                        .ok_or(Error::new("invalid_input"))?
                        .push(json!(
                            "部分参考知识不在本题声明的来源允许范围内，本次未用于检查。"
                        ));
                }
            }
            Err(error) if matches!(error.code, "stale_knowledge" | "not_available") => {
                snapshot["coverage"]["notes"]
                    .as_array_mut()
                    .ok_or(Error::new("invalid_input"))?
                    .push(json!("部分规则的来源已失效，本次未用于检查。"));
            }
            Err(error) => return Err(error),
        }
    }
    snapshot["objects"] = json!(valid);
    // 口径诊断需要知道复合列是否已获用户明确确认；validate_sql等未携带时视为未确认。
    snapshot["semantic_resolution"] = args
        .get("semantic_resolution")
        .cloned()
        .unwrap_or(Value::Null);
    let report = queries::check_semantics(text(args, "sql")?, &args["parameters"], &snapshot);
    contracts::validate("SemanticCheckReport", &report)?;
    Ok(report)
}
pub(super) const SEARCH_RECEIPT_PREFIX: &str = "rc1:";

// 公开回执只携带不可推导的短引用；完整候选窗口留在已提交的工具回执中。
// 引用只在原成功回执已持久化后生成（invoke在execute提交后才投影），
// 同一操作重放仍由同一operation_id确定同一引用。
pub(super) fn public_search_receipt(input: &Value, mut receipt: Value) -> Value {
    let next = &receipt["data"]["search_coverage"]["next"];
    if input["tool_name"] != "search_knowledge"
        || input["arguments"]["view"] == "source_identity"
        || receipt["tool_contract_version"] != 2
        || receipt["tool_name"] != "search_knowledge"
        || !receipt["data"]["error"].is_null()
        || receipt["data"]["memory_retrieval"] == "excluded_by_view"
        || !next.is_string()
        || next.as_str() == Some("")
        || next
            .as_str()
            .is_some_and(|next| next.starts_with(SEARCH_RECEIPT_PREFIX))
    {
        return receipt;
    }
    let Some(operation) = receipt["operation_id"].as_str() else {
        return receipt;
    };
    receipt["data"]["search_coverage"]["next"] =
        json!(format!("{SEARCH_RECEIPT_PREFIX}{operation}"));
    receipt
}

// 短引用只在本轮已核会话/租约的短事务里展开为原完整窗口；原登记参数与指纹保持短引用。
pub(super) async fn effective_cursor_in_tx<'a>(
    tx: &mut AppTx<'_>,
    run: &runtime::LockedRun,
    cursor: &'a str,
) -> Result<SearchCursorInput<'a>> {
    let Some(operation) = cursor.strip_prefix(SEARCH_RECEIPT_PREFIX) else {
        return Ok(SearchCursorInput::Inline(cursor));
    };
    if operation.is_empty()
        || operation.len() > 64
        || !operation
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(Error::new("invalid_cursor"));
    }
    runtime::read_search_cursor_in_tx(tx, run, operation)
        .await
        .map(SearchCursorInput::Receipt)
}

pub(super) fn replay_receipt(name: &str, mut receipt: Value) -> Result<Value> {
    // 重放只复述原操作；通知覆盖采用启动/刷新的当前事实，不能被历史值覆盖。
    if let Some(fields) = receipt.as_object_mut() {
        fields.remove("frozen_notification_covered");
    }
    // 旧取消回执也只接回控制状态，防止历史正文经重传进入当前模型上下文。
    if name == "cancel_query" && receipt["data"].get("id").is_some() {
        receipt["data"] = cancellation_state(&receipt["data"]);
        contracts::validate("QueryCancellation", &receipt["data"])?;
    }
    Ok(receipt)
}
pub(super) async fn protect_query_result_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    _conv: &crate::modules::conversations::LockedConversation,
    cid: &str,
    run_id: &str,
    data: &mut Value,
    text_results: &super::super::context_authority::CheckedTextResults,
) -> Result<()> {
    let queries: Vec<&mut Value> = if data["queries"].is_array() {
        data["queries"]
            .as_array_mut()
            .ok_or(crate::types::Error::new("unavailable"))?
            .iter_mut()
            .collect()
    } else if data["id"].is_string() {
        vec![data]
    } else {
        Vec::new()
    };
    for query in queries {
        let authority =
            super::super::query_workflow::protect_text_in_tx(tx, ctx, cid, query, text_results)
                .await?;
        super::super::context_authority::merge_run_in_tx(tx, run_id, &authority).await?;
    }
    Ok(())
}
pub(super) async fn replay_receipt_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    conv: &crate::modules::conversations::LockedConversation,
    run_id: &str,
    name: &str,
    tool: &runtime::LockedTool,
    text_results: &super::super::context_authority::CheckedTextResults,
) -> Result<Value> {
    let cid = conv.id.as_str();
    let receipt = tool
        .receipt
        .as_ref()
        .ok_or(Error::new("invalid_evidence"))?;
    let mut receipt = replay_receipt(name, receipt.clone())?;
    if matches!(name, "present_analysis_answer" | "prepare_analysis_answer")
        && tool.state == "succeeded"
        && let Some(owner) = super::super::task_answers::candidate_task_ref(tool, &receipt)?
    {
        receipt["answer_task_ref"] = owner;
    }
    if receipt["data"]["error"].is_null() && receipt["control_delivery"].is_object() {
        match super::super::task_answers::validate_control_tasks_in_tx(
            tx,
            conv,
            &receipt["control_delivery"],
        )
        .await
        {
            Ok(()) => {}
            Err(error)
                if matches!(
                    error.code,
                    "stale_context"
                        | "stale_knowledge"
                        | "not_available"
                        | "forbidden"
                        | "source_not_allowed"
                ) =>
            {
                receipt["control_delivery"] = Value::Null
            }
            Err(error) => return Err(error),
        }
    }
    if matches!(name, "request_query" | "execute_query") {
        protect_query_result_in_tx(
            tx,
            ctx,
            conv,
            cid,
            run_id,
            &mut receipt["data"],
            text_results,
        )
        .await?;
    }
    if name == "update_analysis_task" {
        super::super::context_authority::extend_run_in_tx(tx, run_id, &receipt["data"]).await?;
    }
    if matches!(name, "present_analysis_answer" | "prepare_analysis_answer")
        && receipt["data"]["error"].is_null()
    {
        // prepare与present的回执都携带已核sources/result_dependencies，复用同一来源核验。
        let sources = super::super::analysis_answers::check_in_tx(
            tx,
            ctx,
            cid,
            run_id,
            &receipt["data"],
            text_results,
        )
        .await?;
        if let Some(owner) = super::super::task_answers::candidate_task_ref(tool, &receipt)? {
            let scope =
                super::super::task_answers::source_scope_at_version_in_tx(tx, conv, &owner).await?;
            super::super::task_answers::validate_sources_in_tx(
                tx,
                ctx,
                cid,
                &scope,
                &sources,
                text_results,
            )
            .await?;
        }
    }
    if name == "read" && receipt["data"]["kind"] == "skill" {
        let data = &receipt["data"];
        let asset = assets::read_with_sources_in_tx(tx, ctx, text(data, "id")?, true).await?;
        if asset["version"] != data["version"]
            || !assets::selected_in_tx(tx, ctx, cid)
                .await?
                .iter()
                .any(|entry| entry["id"] == asset["id"] && entry["version"] == asset["version"])
        {
            return Err(Error::new("stale_context"));
        }
        let authority =
            super::super::personal_assets::validate_skill_in_tx(tx, ctx, &asset, text_results)
                .await?;
        super::super::context_authority::record_skill_read_in_tx(tx, run_id, authority, &asset)
            .await?;
    }
    if name == "manage_personal_asset" && receipt["data"]["kind"] == "memory" {
        let data = &receipt["data"];
        let current = match assets::read_in_tx(tx, ctx, text(data, "id")?, false).await {
            Ok(current) => current,
            Err(error) if super::super::personal_assets::unavailable_text(&error) => {
                receipt["data"] =
                    json!({"id":data["id"],"version":data["version"],"text_unavailable":true});
                return Ok(receipt);
            }
            Err(error) => return Err(error),
        };
        let available = if current["version"] == data["version"] && current["state"] == "enabled" {
            match super::super::knowledge::check_refs_in_tx(tx, ctx, &current["dependencies"]).await
            {
                Ok(()) => true,
                Err(error) if super::super::personal_assets::unavailable_text(&error) => false,
                Err(error) => return Err(error),
            }
        } else {
            false
        };
        if available {
            super::super::context_authority::extend_run_in_tx(tx, run_id, &receipt["data"]).await?;
        } else {
            receipt["data"] = json!({"id":data["id"],"version":data["version"],"state":current["state"],"text_unavailable":true});
        }
    }
    Ok(receipt)
}
pub(super) fn can_replay_receipt(name: &str) -> bool {
    matches!(
        name,
        "request_query"
            | "execute_query"
            | "update_analysis_task"
            | "manage_personal_asset"
            | "propose_semantic_change"
            | "cancel_query"
            | "save_analysis_evidence"
            | "present_analysis_answer"
            | "prepare_analysis_answer"
            | "save_analysis_report"
            | "prepare_skill_draft"
    )
}
pub async fn recorded_rejection(
    pool: &MySqlPool,
    ctx: &AccessContext,
    input: Value,
) -> Result<Value> {
    let request = contracts::decode("DataToolInvocation", input.clone())?;
    recorded_rejection_validated(pool, ctx, &request, input).await
}

pub async fn recorded_rejection_validated(
    pool: &MySqlPool,
    ctx: &AccessContext,
    request: &contracts::generated::DataToolInvocation,
    input: Value,
) -> Result<Value> {
    let name = text(&input, "tool_name")?;
    let cid = runtime::locate_run(pool, &request.run_id).await?;
    let mut tx = AppTx::begin(pool).await?;
    let conv = conversations::lock_conversation_in_tx(&mut tx, ctx, &cid).await?;
    conversations::assert_turn_in_tx(&tx, &conv, &request.run_id, epoch(&request.lease_epoch)?)?;
    let run = runtime::lock_run_in_tx(&mut tx, &request.run_id, &cid).await?;
    let tool = runtime::lock_tool_call_in_tx(&mut tx, &run, &request.sdk_tool_call_id)
        .await?
        .ok_or(Error::new("not_available"))?;
    if tool.fingerprint != fingerprint(&json!({"name":name,"arguments":input["arguments"]})) {
        return Err(Error::new("idempotency_conflict"));
    }
    if tool.state != "rejected" {
        return Err(Error::new("not_available"));
    }
    let receipt = tool.receipt.ok_or(Error::new("not_available"))?;
    contracts::validate("DataToolOutcome", &receipt)?;
    tx.commit().await?;
    Ok(receipt)
}
pub async fn register(pool: &MySqlPool, ctx: &AccessContext, input: Value) -> Result<Value> {
    let request = contracts::decode("DataToolInvocation", input.clone())?;
    register_validated(pool, ctx, &request, input).await
}

pub async fn register_validated(
    pool: &MySqlPool,
    ctx: &AccessContext,
    request: &contracts::generated::DataToolInvocation,
    input: Value,
) -> Result<Value> {
    let name = text(&input, "tool_name")?;
    let cid = runtime::locate_run(pool, &request.run_id).await?;
    let mut tx = AppTx::begin(pool).await?;
    let conv = conversations::lock_conversation_in_tx(&mut tx, ctx, &cid).await?;
    conversations::assert_turn_in_tx(&tx, &conv, &request.run_id, epoch(&request.lease_epoch)?)?;
    let run = runtime::lock_run_in_tx(&mut tx, &request.run_id, &cid).await?;
    let fp = fingerprint(&json!({"name":name,"arguments":input["arguments"]}));
    let (operation, tool_contract_version) = if let Some(tool) =
        runtime::lock_tool_call_in_tx(&mut tx, &run, &request.sdk_tool_call_id).await?
    {
        if tool.fingerprint != fp {
            return Err(Error::new("idempotency_conflict"));
        }
        (tool.operation_id, tool.tool_contract_version)
    } else {
        // 退役版本只接回已登记的原操作，避免留下无法执行的新登记。
        if run.tool_contract_version != 2 {
            return Err(Error::new("invalid_input"));
        }
        contracts::validate(input_schema(name)?, &input["arguments"])?;
        let handoff =
            super::super::task_answers::register_in_tx(&mut tx, &conv, &run, &input).await?;
        let operation =
            runtime::register_named_tool_in_tx(&mut tx, &run, &request.sdk_tool_call_id, &fp, name)
                .await?;
        let args = &input["arguments"];
        let mut task = conversations::active_task_ref_in_tx(&mut tx, &conv).await?;
        let target = args["task_id"]
            .as_str()
            .or_else(|| args["task_ref"]["task_id"].as_str());
        // 定稿route属于原任务；普通route和其他显式目标沿真实对象归属，不猜活动任务。
        if name == "update_analysis_task"
            && (matches!(args["action"].as_str(), Some("create" | "split"))
                || (args["action"] != "route" && args["task_id"].is_null()))
        {
            task = None;
        } else if args["finalize_current_answer"] != true {
            if let Some(id) = target {
                task = match analysis::read_task_in_tx(&mut tx, &cid, id).await {
                    Ok(current) => {
                        Some((id.to_owned(), epoch(text(&current, "condition_version")?)?))
                    }
                    Err(error) if error.code == "not_available" => None,
                    Err(error) => return Err(error),
                };
            } else if let Some(query) = args["query_id"].as_str() {
                task = match queries::read_in_tx(&mut tx, ctx, query).await {
                    Ok(current) if current["conversation_id"] == cid => Some((
                        text(&current, "task_id")?.to_owned(),
                        epoch(text(&current, "condition_version")?)?,
                    )),
                    Ok(_) => None,
                    Err(error) if error.code == "not_available" => None,
                    Err(error) => return Err(error),
                };
            } else if args["queries"].is_array() {
                // 跨任务批量确认不随单一任务取消；恢复仍按原整体身份核对。
                task = None;
            }
        }
        runtime::bind_tool_task_in_tx(&mut tx, &run, &operation, task.as_ref()).await?;
        if let Some(handoff) = handoff {
            runtime::bind_answer_handoff_in_tx(&mut tx, &run, &operation, &handoff).await?;
        }
        (operation, run.tool_contract_version)
    };
    runtime::save_checkpoint_in_tx(&mut tx, &run, &input["checkpoint"]).await?;
    tx.commit().await?;
    Ok(json!({"operation_id":operation,"tool_contract_version":tool_contract_version}))
}

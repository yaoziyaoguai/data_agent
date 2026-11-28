use super::*;

async fn rejection_data_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    conv: &conversations::LockedConversation,
    run: &runtime::LockedRun,
    input: &Value,
    error: &Error,
) -> Result<Value> {
    let mut data = json!({"error":error.code,"outcome":"rejected"});
    let name = input["tool_name"].as_str().unwrap_or("");
    let mut hint = match (name, error.code) {
        ("execute_query", "invalid_evidence") => {
            "本次执行授权被拒绝，未新增执行授权。instruction_quote须逐字包含本轮真实用户完整原话，包括粘贴SQL、换行、否定和限定；系统结果唤醒不能授权。先核对查询当前SQL、参数、状态和版本；若只是漏引原话且本轮仍有有效执行要求，可用新的工具调用修正，不必再次询问用户；不得修改已登记调用参数或另建查询。已提交查询只接回状态，未知先按原身份查证，不能换ID重做。任务、版本、权限与预算检查保持。"
        }
        (_, "task_context_required") => {
            "本条输入尚缺有效任务归属或资料范围裁决。先按受控任务目录或本回执recovery.task核对目标。若recovery.task.source_limits_declared为true，已有任务用update_analysis_task（action=route，task_id取该目标，expected_version取condition_version，options=[]）登记本条输入；若source_limits_declared为false（route不会补来源声明），须对照本任务真实用户原话：用户确未附加来源限制（如create漏填source_limits）用revise传condition_patch={set:{},unset:[\"source_limits\"]}显式记为无限制，用户明确限制了来源则先search_knowledge(view=source_identity)核明身份后用revise设置set.source_limits，历史旧任务范围仍未知时先read_analysis_task/read_conversation查证、不得盲补null或编造允许集；新目标才create（无额外限制须显式填conditions.source_limits=null）。确定归属和范围后沿原请求继续。执行已有SQL应先get_query核对该query的SQL、参数和版本，再execute_query；需要条件或依据时按当前范围补读，不重造草稿或无故改为澄清。"
        }
        (_, "stale_knowledge") => {
            "知识正文版本、结构绑定或必要依据已变化，本次未保存或执行。先用search_knowledge定位可读的当前条目，再用read_knowledge补读正文和所需结构；structure_only返回本次实际结构依赖。重新采用前核对object_id/version/path及任务许可，不能只替换版本数字。若原文或结构依据无法核实，保留具体缺口。"
        }
        (_, "waiting_clarification") => {
            "任务仍有开放问题，本次未生成或执行查询。先用read_analysis_task核对问题ID：用户选择须有真实回答；待查事实可由当前有效、获准且唯一的资料解决。在同次revise更新相应事实条件、semantic_resolution的依据及resolved_clarification_ids。已有用户选择和任务时间优先；仍有多义、冲突或未回答的问题保持开放。解决全部阻塞后，原话明确授权仍覆盖当前SQL时可继续，无需重复询问同一授权。"
        }
        (_, "clarification_required") => {
            "当前说明仍含未决差异，本次未编译、保存或替换查询。先核允许资料能否唯一回答事实问题；可核事实用revise连同依据采用，真实用户选择或仍有多义的问题用clarify独立登记。不能把自己的假设写成用户采用，也不能重复登记已存在的问题。"
        }
        (_, "task_inactive") => {
            "任务已取消或归档，本次未推进任务或执行查询。请读取当前任务状态并说明原因；不能重开旧任务、另建查询或改变操作身份来绕过停用。新分析必须有真实用户新目标。"
        }
        (_, "clarification_not_open") => {
            "引用的问题已不再开放，本次更新未生效。用read_analysis_task核对当前条件与开放问题，只登记本轮实际回答且仍开放的问题；已完成操作按原调用身份接回，不要重复解决旧问题。"
        }
        (_, "version_conflict") => {
            "所引用的版本或对象状态不再匹配，本次未取得成功回执。先读取recovery中的任务或查询，核对当前条件、草稿、替换关系和状态，再决定是否需要修订；不能只把版本数字改成最新值重试。已提交或未知的查询先按原身份查证，不能另建查询重复执行。"
        }
        (_, "scope_incomplete") => {
            "instruction_quote必须逐字包含完整指令起点（例如‘请记住：’），不能只引用冒号后的偏好。请对照本条用户原话修正引用；若含仅本次或不要保存，不得写入长期记忆。"
        }
        (_, "skill_line_too_long") => {
            "此Skill有单行超过50KiB，请让维护者在网页中分行后保存，再重新选用；本次未读取正文。"
        }
        _ => "本次操作未取得成功回执；请按错误原因核对，不得声称已执行或已保存。",
    };
    let mut recovery = json!({});
    if error.code == "message_pending" {
        let routed = match conversations::assert_routed_in_tx(tx, conv, &run.message_id).await {
            Ok(()) => true,
            Err(error) if error.code == "message_pending" => false,
            Err(error) => return Err(error),
        };
        let other_input = name == "execute_query"
            && conversations::other_input_blocks_confirmation_in_tx(tx, conv, &run.message_id)
                .await?;
        recovery["reason"] = json!(if routed || other_input {
            "other_message_unrouted"
        } else {
            "current_message_unrouted"
        });
        hint = if routed || other_input {
            "会话另有待归属输入，执行暂缓，本次未新增执行授权或任务归属。不能用当前消息替另一条消息登记，也不能自动撤回其他输入或循环重试；先完成本条消息的归属与说明，再结束本轮，让待处理消息按真实原话更新条件，之后重新核对查询和执行要求。"
        } else {
            "当前真实用户消息尚未登记任务归属，本次未新增执行授权。先用update_analysis_task登记本轮归属：仅说明或执行既有SQL用route，修改条件用revise，独立目标用create；涉及多个独立任务须分别登记。成功后重新核对任务、查询和完整用户原话；若原话明确要求执行且范围仍匹配，使用新的execute_query调用继续，不必再次询问同一授权。登记本身不授予执行权，其他待处理消息仍可阻塞执行。"
        };
    }
    if matches!(
        error.code,
        "message_pending"
            | "task_context_required"
            | "stale_knowledge"
            | "waiting_clarification"
            | "clarification_required"
            | "task_inactive"
            | "clarification_not_open"
            | "version_conflict"
            | "invalid_evidence"
    ) {
        let args = &input["arguments"];
        let mut task = args["task_id"]
            .as_str()
            .or_else(|| args["task_ref"]["task_id"].as_str())
            .map(str::to_owned);
        if task.is_none()
            && error.code == "task_context_required"
            && let Some((active, _)) = conversations::active_task_ref_in_tx(tx, conv).await?
        {
            task = Some(active);
        }
        if let Some(query_id) = args["query_id"].as_str() {
            match queries::read_in_tx(tx, ctx, query_id).await {
                Ok(query) if query["conversation_id"] == conv.id => {
                    task = query["task_id"].as_str().map(str::to_owned);
                    recovery["query"] = query_recovery(&query);
                }
                Ok(_) => {}
                Err(error) if error.code == "not_available" => {}
                Err(error) => return Err(error),
            }
        }
        if let Some(task) = task {
            match analysis::recovery_state_in_tx(tx, &conv.id, &task).await {
                Ok(state) => recovery["task"] = state,
                Err(error) if error.code == "not_available" => {}
                Err(error) => return Err(error),
            }
        }
        if let Some(requested) = args["queries"].as_array() {
            let mut states = Vec::with_capacity(requested.len());
            for item in requested {
                let Some(qid) = item["query_id"].as_str() else {
                    continue;
                };
                match queries::read_in_tx(tx, ctx, qid).await {
                    Ok(query) if query["conversation_id"] == conv.id => {
                        let mut state = query_recovery(&query);
                        state["task"] =
                            analysis::recovery_state_in_tx(tx, &conv.id, text(&query, "task_id")?)
                                .await?;
                        states.push(state);
                    }
                    Ok(_) => {}
                    Err(error) if error.code == "not_available" => {}
                    Err(error) => return Err(error),
                }
            }
            recovery["queries"] = json!(states);
        }
    }
    if name == "execute_query" {
        // 只描述本调用的拒绝；查询可能早已由其他成功调用提交，状态见recovery。
        data["new_execution_authorized"] = json!(false);
    }
    if let Some(Value::Object(details)) = &error.details {
        for (key, value) in details {
            if !matches!(key.as_str(), "error" | "outcome" | "text" | "hint") {
                data[key] = value.clone();
            }
        }
    }
    let detail_hint = error
        .details
        .as_ref()
        .and_then(|details| details.get("hint"))
        .and_then(Value::as_str);
    let hint = if let Some(detail) = detail_hint {
        detail.to_owned()
    } else if error.code == "stale_knowledge"
        && let Some(detail) = &error.message
    {
        format!("{detail} {hint}")
    } else {
        hint.to_owned()
    };
    data["hint"] = if name == "execute_query" && input["arguments"]["queries"].is_array() {
        json!(format!(
            "本次批量确认整体未生效，没有新增任一查询的授权；先核对各项当前状态和原执行范围，不要擅自缩小集合或改用下一条普通消息补授权。{hint}"
        ))
    } else {
        json!(hint)
    };
    if recovery.as_object().is_some_and(|value| !value.is_empty()) {
        data["recovery"] = recovery;
    }
    Ok(data)
}

pub async fn invoke(pool: &MySqlPool, ctx: &AccessContext, input: Value) -> Result<Value> {
    let request = contracts::decode("DataToolInvocation", input.clone())?;
    invoke_validated(pool, ctx, &request, input).await
}

pub async fn invoke_validated(
    pool: &MySqlPool,
    ctx: &AccessContext,
    request: &contracts::generated::DataToolInvocation,
    input: Value,
) -> Result<Value> {
    // 目录读取需要可核对的表集合，控制和幂等回执则可在平台暂不可用时处理。
    if ctx
        .table_access
        .as_ref()
        .is_some_and(|access| access.unavailable)
        && matches!(
            request.tool_name,
            contracts::generated::ToolName::SearchKnowledge
                | contracts::generated::ToolName::ReadKnowledge
                | contracts::generated::ToolName::ReadSource
        )
    {
        return Err(Error::new("source_unavailable"));
    }
    let result = super::execute(pool, ctx, input.clone()).await;
    let result = result.map(|receipt| public_search_receipt(&input, receipt));
    if let Err(error) = &result
        && matches!(
            error.code,
            "invalid_input"
                | "invalid_cursor"
                | "stale_cursor"
                | "tool_response_capacity"
                | "skill_line_too_long"
                | "not_available"
                | "forbidden"
                | "selection_required"
                | "scope_incomplete"
                | "memory_unavailable"
                | "memory_busy"
                | "memory_extraction_empty"
                | "memory_operation_unknown"
                | "stale_knowledge"
                | "stale_source"
                | "stale_context"
                | "version_conflict"
                | "waiting_clarification"
                | "clarification_required"
                | "task_inactive"
                | "clarification_not_open"
                | "invalid_evidence"
                | "message_pending"
                | "source_not_allowed"
                | "task_context_required"
                | "unsupported"
                | "sql_not_supported"
                | "unavailable"
                | "upstream_failed"
        )
    {
        let cid = runtime::locate_run(pool, &request.run_id).await?;
        let text_results = super::super::context_authority::CheckedTextResults::default();
        let mut tx = AppTx::begin(pool).await?;
        let conv = conversations::lock_conversation_in_tx(&mut tx, ctx, &cid).await?;
        conversations::assert_turn_in_tx(
            &tx,
            &conv,
            &request.run_id,
            epoch(&request.lease_epoch)?,
        )?;
        let run = runtime::lock_run_in_tx(&mut tx, &request.run_id, &cid).await?;
        if let Some(tool) =
            runtime::lock_tool_call_in_tx(&mut tx, &run, &request.sdk_tool_call_id).await?
            && tool.fingerprint
                == fingerprint(&json!({"name":input["tool_name"],"arguments":input["arguments"]}))
        {
            if error.code == "unavailable"
                && can_replay_receipt(text(&input, "tool_name")?)
                && tool.receipt.is_some()
            {
                // 已提交操作接回原结果；只读工具必须保留本次回源核验失败。
                let receipt = replay_receipt_in_tx(
                    &mut tx,
                    ctx,
                    &conv,
                    &run.id,
                    text(&input, "tool_name")?,
                    &tool,
                    &text_results,
                )
                .await?;
                tx.commit().await?;
                return Ok(public_search_receipt(&input, receipt));
            }
            if tool.state == "registered" {
                let data = rejection_data_in_tx(&mut tx, ctx, &conv, &run, &input, error).await?;
                let receipt = json!({"operation_id":tool.operation_id,"tool_name":input["tool_name"],"tool_contract_version":tool.tool_contract_version,"data":data});
                runtime::reject_tool_in_tx(&mut tx, &tool, &receipt).await?;
            }
        }
        tx.commit().await?;
    }
    result
}

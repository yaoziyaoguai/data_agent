use super::evidence_delivery::{SearchCursorInput, SearchScope, SearchSelection};
use crate::{
    contracts,
    modules::{analysis, assets, conversations, knowledge, queries, retrieval, runtime},
    persistence::AppTx,
    search_scope::KnowledgeSearchScope,
    types::{AccessContext, Error, Result, epoch, fingerprint, id},
};
use serde_json::{Value, json};
use sqlx::MySqlPool;
fn input_schema(name: &str, version: u8) -> Result<&'static str> {
    Ok(match name {
        "search_knowledge" if version == 2 => "KnowledgeSearchInput",
        "search_knowledge" => "SearchInput",
        "read_knowledge" if version == 2 => "KnowledgeReadInput",
        "read_knowledge" => "ReadKnowledgeInput",
        "read_source" if version == 2 => "SourceReadInput",
        "read_source" => "ReadSourceInput",
        "read" => "SkillReadInput",
        "validate_sql" => "SQLInput",
        "request_query" => "RequestQueryInput",
        "execute_query" => "ExecuteQueryInput",
        "update_analysis_task" => "AnalysisUpdate",
        "get_query" => "GetQueryInput",
        "cancel_query" => "ReadQueryInput",
        "save_analysis_evidence" => "SaveAnalysisEvidenceInput",
        "present_analysis_answer" => "PresentAnalysisAnswerInput",
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
fn text<'a>(input: &'a Value, key: &str) -> Result<&'a str> {
    input[key].as_str().ok_or(Error::new("invalid_input"))
}
fn cancellation_state(query: &Value) -> Value {
    json!({"id":query["id"],"task_id":query["task_id"],"condition_version":query["condition_version"],"execution_state":query["execution_state"],"cancel_state":query["cancel_state"]})
}
fn query_recovery(query: &Value) -> Value {
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
async fn condition_decision_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
    task: Option<&str>,
) -> Result<Option<analysis::ConditionRevision>> {
    let Some(task) = task else {
        return Ok(None);
    };
    analysis::current_condition_revision_in_tx(tx, cid, task).await
}

async fn request_condition_authority_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    conversation: &conversations::LockedConversation,
    message_id: &str,
    args: &Value,
    checked: &super::context_authority::CheckedTextResults,
) -> Result<(Value, Value)> {
    let cid = &conversation.id;
    analysis::lock_tasks_in_tx(tx, cid).await?;
    let task = text(args, "task_id")?;
    let version = epoch(text(args, "condition_version")?)?;
    analysis::assert_current_in_tx(tx, cid, task, version).await?;
    conversations::assert_routed_in_tx(tx, conversation, message_id).await?;
    let conditions = analysis::read_evidence_conditions_in_tx(tx, ctx, cid, task, version).await?;
    let references = super::query_semantics::knowledge_references(&[args, &conditions]);
    // 草稿沿同一已核条目选择及当前结构绑定核来源门，不再回读整对象扩大范围。
    let draft_gate = super::source_limits::resolve_for_task_in_tx(tx, cid, task).await?;
    super::knowledge::check_refs_for_task_in_tx(tx, ctx, &references, draft_gate.as_ref()).await?;
    let authority = super::context_authority::validate_condition_text_in_tx(
        tx,
        ctx,
        cid,
        task,
        version,
        &conditions,
        checked,
    )
    .await?;
    Ok((authority, conditions))
}

// 时间基准从任务当前条件投影成草稿快照：观察截点/批次跟草稿走，任务后来改版不改写
// 已保存草稿的含义。只在time_roles非空时投影；未声明的草稿保存NULL，答案侧
// 不得以request_clock或平台data_freshness冒充截点/批次。
fn time_basis_of(conditions: &Value) -> Result<Option<Value>> {
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

async fn semantic_diagnostics_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    args: &Value,
    gate: Option<&super::source_limits::SourceGate>,
) -> Result<Value> {
    let refs = args
        .get("knowledge_refs")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let mut snapshot = knowledge::semantic_snapshot_in_tx(tx, ctx, &refs).await?;
    let mut valid = Vec::new();
    let objects = snapshot["objects"].as_array().cloned().unwrap_or_default();
    for object in objects {
        match super::knowledge::assert_source_in_tx(tx, ctx, &object).await {
            Ok(()) => {
                // 只读诊断把范围外对象记为覆盖缺口；正式保存路径在条件授权处已硬拒绝。
                let within_limits = match gate {
                    Some(gate) => gate.allows_object_in_tx(tx, &object).await?,
                    None => true,
                };
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
const SEARCH_RECEIPT_PREFIX: &str = "rc1:";

// 公开回执只携带不可推导的短引用；完整候选窗口留在已提交的工具回执中。
// 引用只在原成功回执已持久化后生成（invoke在execute提交后才投影），
// 同一操作重放仍由同一operation_id确定同一引用。
fn public_search_receipt(input: &Value, mut receipt: Value) -> Value {
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
async fn effective_cursor_in_tx<'a>(
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

fn replay_receipt(name: &str, mut receipt: Value) -> Result<Value> {
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
async fn protect_update_result_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    conv: &crate::modules::conversations::LockedConversation,
    cid: &str,
    run_id: &str,
    result: &mut Value,
    text_results: &super::context_authority::CheckedTextResults,
) -> Result<()> {
    let projection = super::source_limits::active_projection_in_tx(tx, conv).await?;
    let refs = super::context_authority::protect_task_context_in_tx(
        tx,
        ctx,
        cid,
        result,
        text_results,
        Some(&projection),
    )
    .await?;
    // 任务正文与读取入口共用完整来源清单。
    super::context_authority::merge_run_in_tx(tx, run_id, &refs).await?;
    Ok(())
}
async fn protect_query_result_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    _conv: &crate::modules::conversations::LockedConversation,
    cid: &str,
    run_id: &str,
    data: &mut Value,
    text_results: &super::context_authority::CheckedTextResults,
) -> Result<()> {
    let queries: Vec<&mut Value> = if data["queries"].is_array() {
        data["queries"]
            .as_array_mut()
            .expect("query batch")
            .iter_mut()
            .collect()
    } else if data["id"].is_string() {
        vec![data]
    } else {
        Vec::new()
    };
    for query in queries {
        let authority =
            super::query_workflow::protect_text_in_tx(tx, ctx, cid, query, text_results).await?;
        super::context_authority::merge_run_in_tx(tx, run_id, &authority).await?;
    }
    Ok(())
}
async fn replay_receipt_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    conv: &crate::modules::conversations::LockedConversation,
    run_id: &str,
    name: &str,
    tool: &runtime::LockedTool,
    text_results: &super::context_authority::CheckedTextResults,
) -> Result<Value> {
    let cid = conv.id.as_str();
    let receipt = tool
        .receipt
        .as_ref()
        .ok_or(Error::new("invalid_evidence"))?;
    let mut receipt = replay_receipt(name, receipt.clone())?;
    if matches!(name, "present_analysis_answer" | "prepare_analysis_answer")
        && tool.state == "succeeded"
        && let Some(owner) = super::task_answers::candidate_task_ref(tool, &receipt)?
    {
        receipt["answer_task_ref"] = owner;
    }
    if receipt["data"]["error"].is_null() && receipt["control_delivery"].is_object() {
        match super::task_answers::validate_control_text_in_tx(
            tx,
            ctx,
            conv,
            &receipt["control_delivery"],
            text_results,
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
        protect_update_result_in_tx(
            tx,
            ctx,
            conv,
            cid,
            run_id,
            &mut receipt["data"],
            text_results,
        )
        .await?;
        super::context_authority::extend_run_in_tx(tx, conv, run_id, &receipt["data"]).await?;
    }
    if matches!(name, "present_analysis_answer" | "prepare_analysis_answer")
        && receipt["data"]["error"].is_null()
    {
        // prepare与present的回执都携带已核sources/result_dependencies，复用同一来源核验。
        let sources = super::analysis_answers::check_in_tx(
            tx,
            ctx,
            cid,
            run_id,
            &receipt["data"],
            text_results,
        )
        .await?;
        if let Some(owner) = super::task_answers::candidate_task_ref(tool, &receipt)? {
            let scope =
                super::task_answers::source_scope_at_version_in_tx(tx, conv, &owner).await?;
            super::task_answers::validate_sources_in_tx(
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
    if name == "manage_personal_asset" && receipt["data"]["kind"] == "memory" {
        let data = &receipt["data"];
        let current = match assets::read_in_tx(tx, ctx, text(data, "id")?, false).await {
            Ok(current) => current,
            Err(error) if super::personal_assets::unavailable_text(&error) => {
                receipt["data"] =
                    json!({"id":data["id"],"version":data["version"],"text_unavailable":true});
                return Ok(receipt);
            }
            Err(error) => return Err(error),
        };
        let authority = if current["version"] == data["version"] && current["state"] == "enabled" {
            super::personal_assets::text_authority_in_tx(tx, ctx, cid, &current, text_results).await
        } else {
            Err(Error::new("stale_context"))
        };
        match authority {
            Ok(authority) => {
                super::context_authority::merge_run_in_tx(tx, run_id, &authority).await?;
                super::context_authority::extend_run_in_tx(tx, conv, run_id, &receipt["data"])
                    .await?;
            }
            Err(error) if super::personal_assets::unavailable_text(&error) => {
                receipt["data"] = json!({"id":data["id"],"version":data["version"],"state":current["state"],"text_unavailable":true});
            }
            Err(error) => return Err(error),
        }
    }
    Ok(receipt)
}
fn requires_source_context(name: &str, args: &Value) -> bool {
    match name {
        "update_analysis_task" | "cancel_query" => false,
        "search_knowledge" if args["view"] == "source_identity" => false,
        "read_conversation" if args["task_directory"] == true => false,
        "manage_personal_asset" if args["action"] == "disable_memory" => false,
        _ => true,
    }
}

async fn attach_source_readiness_in_tx(
    tx: &mut AppTx<'_>,
    conv: &conversations::LockedConversation,
    run: &runtime::LockedRun,
    version: u8,
    receipt: &mut Value,
) -> Result<()> {
    // v2正文准入投影随冻结工具行版本走：已存v2回执在旧版本run上接回时形状不变，
    // 首次执行按本次有效版本（工具行或run行）决定是否附加。
    if version == 2 {
        let blocker =
            super::source_limits::input_context_blocker_in_tx(tx, conv, &run.message_id).await?;
        receipt["source_context_ready"] = json!(blocker.is_none());
        if let Some(blocker) = blocker {
            receipt["source_context_blocker"] = json!(blocker);
        } else {
            receipt
                .as_object_mut()
                .expect("tool receipt")
                .remove("source_context_blocker");
        }
    }
    Ok(())
}

fn can_replay_receipt(name: &str) -> bool {
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
    contracts::validate("DataToolInvocation", &input)?;
    let name = text(&input, "tool_name")?;
    let cid = runtime::locate_run(pool, text(&input, "run_id")?).await?;
    let mut tx = AppTx::begin(pool).await?;
    let conv = conversations::lock_conversation_in_tx(&mut tx, ctx, &cid).await?;
    conversations::assert_turn_in_tx(
        &tx,
        &conv,
        text(&input, "run_id")?,
        epoch(text(&input, "lease_epoch")?)?,
    )?;
    let run = runtime::lock_run_in_tx(&mut tx, text(&input, "run_id")?, &cid).await?;
    let tool = runtime::lock_tool_call_in_tx(&mut tx, &run, text(&input, "sdk_tool_call_id")?)
        .await?
        .ok_or(Error::new("not_available"))?;
    if tool.fingerprint != fingerprint(&json!({"name":name,"arguments":input["arguments"]})) {
        return Err(Error::new("idempotency_conflict"));
    }
    if tool.state != "rejected" {
        return Err(Error::new("not_available"));
    }
    let mut receipt = tool.receipt.ok_or(Error::new("not_available"))?;
    // 同一拒绝的两种读法等形：重放读附加的v2正文准入投影，在读取已记录拒绝时同样给出，
    // 模型经任一回退路径得到的回执一致；存储记录保持纯拒绝事实。版本随冻结工具行。
    attach_source_readiness_in_tx(
        &mut tx,
        &conv,
        &run,
        tool.tool_contract_version,
        &mut receipt,
    )
    .await?;
    contracts::validate("DataToolOutcome", &receipt)?;
    tx.commit().await?;
    Ok(receipt)
}
pub async fn register(pool: &MySqlPool, ctx: &AccessContext, input: Value) -> Result<Value> {
    contracts::validate("DataToolInvocation", &input)?;
    let name = text(&input, "tool_name")?;
    let cid = runtime::locate_run(pool, text(&input, "run_id")?).await?;
    let mut tx = AppTx::begin(pool).await?;
    let conv = conversations::lock_conversation_in_tx(&mut tx, ctx, &cid).await?;
    conversations::assert_turn_in_tx(
        &tx,
        &conv,
        text(&input, "run_id")?,
        epoch(text(&input, "lease_epoch")?)?,
    )?;
    let run = runtime::lock_run_in_tx(&mut tx, text(&input, "run_id")?, &cid).await?;
    let fp = fingerprint(&json!({"name":name,"arguments":input["arguments"]}));
    let (operation, tool_contract_version) = if let Some(tool) =
        runtime::lock_tool_call_in_tx(&mut tx, &run, text(&input, "sdk_tool_call_id")?).await?
    {
        if tool.fingerprint != fp {
            return Err(Error::new("idempotency_conflict"));
        }
        if contracts::validate(
            input_schema(name, tool.tool_contract_version)?,
            &input["arguments"],
        )
        .is_err()
            && !(matches!(tool.state.as_str(), "succeeded" | "rejected") && tool.receipt.is_some())
        {
            // 已登记且没有完成回执，不能把升级后的参数拒绝说成从未执行。
            return Err(Error::new("outcome_unknown"));
        }
        (tool.operation_id, tool.tool_contract_version)
    } else {
        // 新动作仍按当前契约校验；旧映射只凭原参数指纹接回。
        let schema = match (name, run.tool_contract_version) {
            ("update_analysis_task", 2) => "CurrentAnalysisUpdate",
            ("request_query", 2) => "CurrentRequestQueryInput",
            _ => input_schema(name, run.tool_contract_version)?,
        };
        contracts::validate(schema, &input["arguments"])?;
        let handoff = super::task_answers::register_in_tx(&mut tx, &conv, &run, &input).await?;
        let operation = runtime::register_named_tool_in_tx(
            &mut tx,
            &run,
            text(&input, "sdk_tool_call_id")?,
            &fp,
            name,
        )
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
async fn execute(pool: &MySqlPool, ctx: &AccessContext, input: Value) -> Result<Value> {
    contracts::validate("DataToolInvocation", &input)?;
    let name = text(&input, "tool_name")?;
    let args = &input["arguments"];
    let source_identity_view = name == "search_knowledge" && args["view"] == "source_identity";
    let response_budget: Option<contracts::generated::ResponseBudget> = input
        .get("response_budget")
        .map(|value| serde_json::from_value(value.clone()).map_err(|_| Error::new("invalid_input")))
        .transpose()?;
    // 采纳身份宿主绑定：条件写入路径验证通过后，把省略的adoption_message_id
    // 回填为本轮真实消息身份的完整args克隆；arm持久化用它，apply层幂等指纹
    // 基于回填后的值，同消息重试指纹一致。
    let mut bound_args: Option<Value> = None;
    let mut legacy_migration: Option<analysis::LegacyDecisionMigration> = None;
    let mut update_dialect = analysis::AnalysisUpdateDialect::Current;
    let mut query_resolution: Option<Value> = None;
    let tool_contract_version;
    let validation;
    let mut effective_cursor = None;
    let cid = runtime::locate_run(pool, text(&input, "run_id")?).await?;
    // 正文回放先查外部结果权限，最终事务再核当前依赖和活动范围。
    let replay_checked = if !source_identity_view
        && matches!(
            name,
            "present_analysis_answer"
                | "prepare_analysis_answer"
                | "search_knowledge"
                | "read_knowledge"
                | "read_source"
        ) {
        Some(super::context_authority::check_run_results(pool, ctx, text(&input, "run_id")?).await?)
    } else {
        None
    };
    let mut text_results = if matches!(
        name,
        "update_analysis_task"
            | "read_analysis_task"
            | "read_conversation"
            | "save_analysis_evidence"
            | "present_analysis_answer"
            | "prepare_analysis_answer"
            | "save_analysis_report"
            | "read_analysis_report"
            | "prepare_skill_draft"
            | "request_query"
            | "get_query"
            | "execute_query"
    ) {
        super::context_authority::check_task_text_results(pool, ctx, &cid, None).await?
    } else {
        super::context_authority::CheckedTextResults::default()
    };
    if matches!(
        name,
        "request_query"
            | "get_query"
            | "execute_query"
            | "present_analysis_answer"
            | "prepare_analysis_answer"
    ) {
        let checked =
            super::query_workflow::check_text_results(pool, ctx, &cid, args["query_id"].as_str())
                .await?;
        text_results.include_checked(&checked);
    }
    if !source_identity_view
        && matches!(
            name,
            "search_knowledge" | "read_knowledge" | "read" | "manage_personal_asset"
        )
    {
        let checked =
            super::context_authority::check_available_asset_results(pool, ctx, &cid).await?;
        text_results.include_checked(&checked);
    }
    if let Some(checked) = &replay_checked {
        text_results.include_run(checked);
    }
    if name == "update_analysis_task" && args["finalize_current_answer"] == true {
        let checked =
            super::task_answers::check_results(pool, ctx, text(&input, "run_id")?).await?;
        text_results.include_checked(&checked);
    }
    // 短引用只在本轮已核会话/租约的短事务里展开；原登记参数与指纹保持短引用。
    {
        let mut tx = AppTx::begin(pool).await?;
        let conv = conversations::lock_conversation_in_tx(&mut tx, ctx, &cid).await?;
        conversations::assert_turn_in_tx(
            &tx,
            &conv,
            text(&input, "run_id")?,
            epoch(text(&input, "lease_epoch")?)?,
        )?;
        let run = runtime::lock_run_in_tx(&mut tx, text(&input, "run_id")?, &cid).await?;
        if let Some(checked) = &replay_checked {
            super::context_authority::assert_checked_run_in_tx(&mut tx, &run.id, checked).await?;
        }
        let tool =
            runtime::lock_tool_call_in_tx(&mut tx, &run, text(&input, "sdk_tool_call_id")?).await?;
        tool_contract_version = tool
            .as_ref()
            .map_or(run.tool_contract_version, |tool| tool.tool_contract_version);
        if name == "search_knowledge"
            && !source_identity_view
            && tool_contract_version == 2
            && let Some(cursor) = args["cursor"].as_str()
            // 已结算回执直接接回原结果，重放不再做参数级游标展开；
            // 首次执行（含新会话引用定位失败）仍在此处给出invalid_cursor。
            && tool.as_ref().is_none_or(|tool| tool.receipt.is_none())
        {
            effective_cursor = Some(effective_cursor_in_tx(&mut tx, &run, cursor).await?);
        }
        if let Some(tool) = &tool
            && tool.fingerprint != fingerprint(&json!({"name":name,"arguments":args}))
        {
            return Err(Error::new("idempotency_conflict"));
        }
        validation = if name == "update_analysis_task" && tool_contract_version == 2 {
            let current = contracts::validate("CurrentAnalysisUpdate", args);
            if current.is_err()
                && tool
                    .as_ref()
                    .is_some_and(|tool| tool.state == "registered" && tool.receipt.is_none())
            {
                let legacy = contracts::validate("AnalysisUpdate", args);
                if legacy.is_ok() {
                    update_dialect = analysis::AnalysisUpdateDialect::Legacy;
                    legacy
                } else {
                    current
                }
            } else {
                current
            }
        } else {
            if name == "update_analysis_task" {
                update_dialect = analysis::AnalysisUpdateDialect::Legacy;
            }
            contracts::validate(input_schema(name, tool_contract_version)?, args)
        };
        if let Some(tool) = tool {
            if validation.is_ok()
                && run.tool_contract_version == 2
                && tool.state != "rejected"
                && requires_source_context(name, args)
                && super::source_limits::input_context_blocker_in_tx(
                    &mut tx,
                    &conv,
                    &run.message_id,
                )
                .await?
                .is_some()
            {
                return Err(Error::new("task_context_required"));
            }
            if let Some(receipt) = &tool.receipt
                && (tool.state == "rejected"
                    || (tool.state == "succeeded"
                        && (can_replay_receipt(name)
                            || (!source_identity_view
                                && matches!(
                                    name,
                                    "search_knowledge" | "read_knowledge" | "read_source"
                                )))))
            {
                if tool.state == "succeeded"
                    && matches!(name, "search_knowledge" | "read_knowledge" | "read_source")
                {
                    if run.state != "running" {
                        return Err(Error::new("lease_lost"));
                    }
                    super::evidence_delivery::assert_replay_in_tx(
                        &mut tx,
                        ctx,
                        &conv,
                        &run.id,
                        args,
                        receipt,
                        &text_results,
                    )
                    .await?;
                }
                let mut receipt =
                    replay_receipt_in_tx(&mut tx, ctx, &conv, &run.id, name, &tool, &text_results)
                        .await?;
                attach_source_readiness_in_tx(
                    &mut tx,
                    &conv,
                    &run,
                    tool_contract_version,
                    &mut receipt,
                )
                .await?;
                tx.commit().await?;
                return Ok(receipt);
            }
            if validation.is_err() {
                return Err(Error::new("outcome_unknown"));
            }
            // 先持久化越过执行入口的事实；取消不能把在途或旧行未知结果当成未执行。
            if tool.state == "registered" && tool.execution_started == Some(false) {
                runtime::start_tool_execution_in_tx(&mut tx, &tool).await?;
            }
        }
        if matches!(name, "request_query" | "update_analysis_task") && validation.is_ok() {
            let message =
                conversations::read_message_in_tx(&mut tx, &conv, &run.message_id).await?;
            if name == "request_query" {
                // 失效旧稿前核对目标条件的决定；最终事务仍核原条件版本和当前权限，
                // 不对同一不可变版本另作一份采纳判断。
                let declared =
                    condition_decision_in_tx(&mut tx, &cid, args["task_id"].as_str()).await?;
                query_resolution = super::query_semantics::draft_for_condition(
                    args.get("semantic_resolution"),
                    declared.as_ref(),
                    &message.body,
                    message.user_supplied,
                    &run.message_id,
                )?;
            } else {
                if args["resolved_clarification_ids"]
                    .as_array()
                    .is_some_and(|ids| !ids.is_empty())
                    && !message.user_supplied
                {
                    return Err(Error::new("invalid_evidence"));
                }
                if let Some(request) = args.get("legacy_resolution_migration") {
                    let request: contracts::generated::LegacyResolutionMigration =
                        serde_json::from_value(request.clone())
                            .map_err(|_| Error::new("invalid_input"))?;
                    let mut proofs = Vec::new();
                    let versions = request
                        .links
                        .iter()
                        .filter_map(|link| link.resolution_condition_version.as_deref())
                        .collect::<std::collections::BTreeSet<_>>();
                    for version in versions {
                        let version = epoch(version)?;
                        if let Some(update) = runtime::task_condition_update_in_tx(
                            &mut tx,
                            &cid,
                            text(args, "task_id")?,
                            version,
                        )
                        .await?
                        {
                            let original = conversations::read_message_in_tx(
                                &mut tx,
                                &conv,
                                &update.message_id,
                            )
                            .await?;
                            let verified_adoption =
                                super::query_semantics::verified_legacy_adoption(
                                    update.conditions.get("semantic_resolution"),
                                    &original.body,
                                    original.user_supplied,
                                    &original.id,
                                );
                            proofs.push(analysis::LegacyResolutionProof {
                                condition_version: version,
                                conditions: update.conditions,
                                user_supplied: original.user_supplied,
                                verified_adoption,
                            });
                        }
                    }
                    legacy_migration = Some(analysis::LegacyDecisionMigration {
                        request,
                        proofs,
                        current_message_id: run.message_id.clone(),
                    });
                }
                // create完整条件与revise补丁同一采纳纪律：explicit_user绑定本轮真实消息
                // 或逐字复制同任务已验证原身份；未决状态允许如实记录，随后按条件版本
                // 阻断草稿保存（needs_clarification不能用省略变unambiguous）。
                // 分支判定与apply_update一致：create、task_id缺省的等同create及split都
                // 经完整conditions写入（split复制原任务条件，inherited取原任务声明），
                // 不看condition_patch是否携带，防止补丁分支漏掉conditions里的采纳声明。
                let action = args["action"].as_str().unwrap_or("");
                let conditions_path =
                    action == "create" || action == "split" || args["task_id"].is_null();
                let (resolution, task) = if conditions_path {
                    (
                        args["conditions"]
                            .get("semantic_resolution")
                            .filter(|value| !value.is_null()),
                        if action == "split" {
                            args["task_id"].as_str()
                        } else {
                            None
                        },
                    )
                } else {
                    (
                        args["condition_patch"]["set"]
                            .get("semantic_resolution")
                            .filter(|value| !value.is_null()),
                        args["task_id"].as_str(),
                    )
                };
                if let Some(resolution) = resolution {
                    let prior = condition_decision_in_tx(&mut tx, &cid, task).await?;
                    let inherited = legacy_migration
                        .as_ref()
                        .and_then(|migration| {
                            migration
                                .proofs
                                .iter()
                                .filter_map(|proof| proof.verified_adoption.as_ref())
                                .find(|adopted| analysis::same_adoption(adopted, resolution))
                        })
                        .or_else(|| {
                            prior
                                .as_ref()
                                .and_then(|revision| revision.body.get("semantic_resolution"))
                        });
                    super::query_semantics::validate_condition_resolution(
                        resolution,
                        &message.body,
                        message.user_supplied,
                        &run.message_id,
                        inherited,
                    )?;
                    // 新采纳省略身份：回填本轮真实消息ID后交给持久化，模型无需
                    // 也无从知道消息ID；验证已核对引用确为本轮完整原话。
                    if resolution["basis"] == "explicit_user"
                        && resolution["adoption_message_id"].is_null()
                    {
                        let mut bound = args.clone();
                        let target = if conditions_path {
                            &mut bound["conditions"]["semantic_resolution"]
                        } else {
                            &mut bound["condition_patch"]["set"]["semantic_resolution"]
                        };
                        *target = resolution.clone();
                        target["adoption_message_id"] = json!(run.message_id);
                        bound_args = Some(bound);
                    }
                }
            }
        }
        tx.commit().await?;
    }
    validation?;
    // 停止动作只返回控制状态；旧结果失效不能剥夺当前用户停止本人查询的能力。
    let checked = if name == "cancel_query" || source_identity_view {
        None
    } else if let Some(checked) = replay_checked {
        Some(checked)
    } else {
        Some(super::context_authority::check_run_results(pool, ctx, text(&input, "run_id")?).await?)
    };
    if let Some(checked) = &checked {
        text_results.include_run(checked);
    }
    if matches!(name, "request_query" | "validate_sql") {
        let mut tx = AppTx::begin(pool).await?;
        let conv = conversations::lock_conversation_in_tx(&mut tx, ctx, &cid).await?;
        conversations::assert_turn_in_tx(
            &tx,
            &conv,
            text(&input, "run_id")?,
            epoch(text(&input, "lease_epoch")?)?,
        )?;
        let run = runtime::lock_run_in_tx(&mut tx, text(&input, "run_id")?, &cid).await?;
        if run.state != "running" {
            return Err(Error::new("lease_lost"));
        }
        super::context_authority::assert_checked_run_in_tx(
            &mut tx,
            &run.id,
            checked.as_ref().expect("query check"),
        )
        .await?;
        super::context_authority::assert_run_in_tx(&mut tx, ctx, &cid, &run.id).await?;
        let tool = runtime::lock_tool_call_in_tx(&mut tx, &run, text(&input, "sdk_tool_call_id")?)
            .await?
            .ok_or(Error::new("version_conflict"))?;
        if tool.fingerprint != fingerprint(&json!({"name":name,"arguments":args})) {
            return Err(Error::new("idempotency_conflict"));
        }
        if tool.receipt.is_some() && name == "request_query" {
            let receipt =
                replay_receipt_in_tx(&mut tx, ctx, &conv, &run.id, name, &tool, &text_results)
                    .await?;
            tx.commit().await?;
            return Ok(receipt);
        }
        if name == "request_query" {
            // 预检只核条件授权；来源门在条件授权内部按草稿所属任务解析。
            request_condition_authority_in_tx(
                &mut tx,
                ctx,
                &conv,
                &run.message_id,
                args,
                &text_results,
            )
            .await?;
            if let Some(replaced) = args["replaces_query_id"].as_str() {
                // 有效修订在外部编译前失效旧稿；失效来源不能先改变旧稿或向平台发送SQL。
                queries::begin_revision_in_tx(
                    &mut tx,
                    ctx,
                    &cid,
                    text(args, "task_id")?,
                    args["target_id"].as_str(),
                    replaced,
                )
                .await?;
                conversations::route_message_in_tx(
                    &mut tx,
                    &conv,
                    &run.message_id,
                    args["task_id"].as_str(),
                    true,
                )
                .await?;
                // 有效修订按草稿所属任务显式归属；版本已在条件授权处核对为当前。
                conversations::bind_active_task_in_tx(
                    &mut tx,
                    &conv,
                    text(args, "task_id")?,
                    epoch(text(args, "condition_version")?)?,
                )
                .await?;
            }
        }
        tx.commit().await?;
    }
    // 模型检查和结果读取在业务事务外；写入时重新校验运行及当前权限。
    let external = match name {
        "search_knowledge" if source_identity_view => {
            Some(super::source_identity::search(pool, ctx, args, response_budget.as_ref()).await?)
        }
        "validate_sql" | "request_query" => {
            Some(queries::platform::check(text(args, "sql")?, &args["parameters"]).await?)
        }
        "get_query" => {
            let qid = text(args, "query_id")?;
            let q = super::query_workflow::read(pool, ctx, qid).await?;
            if q["execution_state"] == "succeeded" {
                let mut tx = AppTx::begin(pool).await?;
                let conv = conversations::lock_conversation_in_tx(&mut tx, ctx, &cid).await?;
                conversations::assert_turn_in_tx(
                    &tx,
                    &conv,
                    text(&input, "run_id")?,
                    epoch(text(&input, "lease_epoch")?)?,
                )?;
                let run = runtime::lock_run_in_tx(&mut tx, text(&input, "run_id")?, &cid).await?;
                let defer_results =
                    queries::is_confirmation_message_in_tx(&mut tx, ctx, qid, &run.message_id)
                        .await?;
                tx.commit().await?;
                if defer_results {
                    None
                } else {
                    match super::query_workflow::agent_results(pool, ctx, qid, args).await {
                        Ok(v) => Some(v),
                        Err(e) => Some(json!({"error":e.code})),
                    }
                }
            } else {
                None
            }
        }
        "present_analysis_answer" => Some(
            super::analysis_answers::present(
                pool,
                ctx,
                &cid,
                &runtime::locate_run_message(pool, text(&input, "run_id")?).await?,
                args,
                &mut text_results,
            )
            .await?,
        ),
        "prepare_analysis_answer" => Some(
            super::analysis_answers::prepare(
                pool,
                ctx,
                &cid,
                &runtime::locate_run_message(pool, text(&input, "run_id")?).await?,
                args,
                &mut text_results,
            )
            .await?,
        ),
        "save_analysis_evidence" => Some(
            super::analysis_evidence::validate_sources(
                pool,
                ctx,
                &cid,
                &runtime::locate_run_message(pool, text(&input, "run_id")?).await?,
                args,
                &mut text_results,
            )
            .await?,
        ),
        "save_analysis_report" => Some(
            super::analysis_reports::validate_sources(pool, ctx, &cid, args, &mut text_results)
                .await?,
        ),
        "read_analysis_report" => Some(
            super::analysis_reports::read_for_agent(pool, ctx, &cid, args, &mut text_results)
                .await?,
        ),
        "prepare_skill_draft" => Some(
            super::skill_drafts::validate_sources(
                pool,
                ctx,
                &cid,
                &runtime::locate_run_message(pool, text(&input, "run_id")?).await?,
                args,
                &mut text_results,
            )
            .await?,
        ),
        _ => None,
    };
    let extracted_memory = super::personal_memory::extract(pool, ctx, &input).await?;
    let (memory_candidates, mut memory_retrieval) = if source_identity_view {
        (vec![], "directory")
    } else {
        super::personal_memory::search(pool, ctx, &input).await
    };
    let scope = if name == "search_knowledge" && !source_identity_view {
        KnowledgeSearchScope::from_validated(args)?
    } else {
        KnowledgeSearchScope::default()
    };
    let search_request =
        if name == "search_knowledge" && tool_contract_version == 2 && !source_identity_view {
            Some(
                serde_json::from_value::<contracts::generated::KnowledgeSearchInput>(args.clone())
                    .map_err(|_| Error::new("invalid_input"))?,
            )
        } else {
            None
        };
    let source_selection = search_request
        .as_ref()
        .and_then(|request| request.source_selection.as_deref());
    let search_deadline = retrieval::vector::retrieval_deadline();
    // 普通召回把空间、启停、硬范围与来源门换算为通道允许集。精读只准备任务与门，
    // 在锁外按已选对象和版本核定原文。最终裁决仍使用提交事务内的当前权限。
    let (search_selection, source_selection_gate, allowed_records) =
        if name == "search_knowledge" && !source_identity_view {
            match tokio::time::timeout_at(search_deadline, async {
                let message = runtime::locate_run_message(pool, text(&input, "run_id")?).await?;
                let mut tx = AppTx::begin(pool).await?;
                let conv = conversations::lock_conversation_in_tx(&mut tx, ctx, &cid).await?;
                let active = if let Some(request) = &search_request {
                    super::evidence_delivery::current_task_in_tx(
                        &mut tx,
                        &conv,
                        request.task_ref.as_ref(),
                    )
                    .await?
                } else {
                    None
                };
                let gate = super::source_limits::resolve_in_tx(&mut tx, &conv, &message).await?;
                let records = if source_selection.is_some() {
                    None
                } else {
                    Some(
                        super::source_limits::allowed_records_in_tx(
                            &mut tx,
                            ctx,
                            gate.as_ref(),
                            &scope,
                        )
                        .await?,
                    )
                };
                let selection = search_request.as_ref().map(|request| {
                    let scope = match &records {
                        Some(records) => SearchScope::Recall(records),
                        None => SearchScope::Selected(gate.as_ref()),
                    };
                    SearchSelection::new(ctx, request, active, scope)
                });
                tx.commit().await?;
                Ok::<_, Error>((selection, gate, records))
            })
            .await
            {
                Ok(prepared) => prepared?,
                Err(_) if source_selection.is_some() => return Err(Error::new("unavailable")),
                Err(_) => (
                    None,
                    None,
                    Some(retrieval::vector::AllowedRecords {
                        knowledge_ids: Vec::new(),
                        sources: Vec::new(),
                    }),
                ),
            }
        } else {
            (None, None, None)
        };
    let continuation = search_request
        .as_ref()
        .and_then(|request| request.cursor.as_deref())
        .map(|_| {
            let cursor = effective_cursor.ok_or(Error::new("unavailable"))?;
            search_selection
                .as_ref()
                .ok_or(Error::new("unavailable"))?
                .restore(cursor)
        })
        .transpose()?;
    let launch =
        if name == "search_knowledge" && !source_identity_view && source_selection.is_none() {
            if let Some(anchor) = &scope.anchor
                && tokio::time::Instant::now() < search_deadline
            {
                // anchor元信息沿范围准备前的同一期限；普通读取错误仍传播。
                if let Ok(result) = tokio::time::timeout_at(search_deadline, async {
                    let mut tx = AppTx::begin(pool).await?;
                    knowledge::read_meta_in_tx(&mut tx, ctx, anchor, None).await?;
                    tx.commit().await
                })
                .await
                {
                    result?;
                }
            }
            // 05切片4：词法Milvus路与查询嵌入并行发出；锁外检索阶段在词法就绪后
            // 即核验/预读，嵌入就绪后dense首轮并入共同排序，不等待慢嵌入。
            super::knowledge_embeddings::launch_scoped(
                pool,
                ctx,
                text(args, "query")?,
                Some(&input),
                tool_contract_version == 2,
                allowed_records.as_ref(),
                search_deadline,
            )
            .await
        } else {
            None
        };
    let mut search_stage = if name == "search_knowledge" && !source_identity_view {
        let mut candidates = retrieval::vector::Candidates::lexical();
        candidates.deadline = search_deadline;
        candidates.bounded = tokio::time::Instant::now() >= search_deadline;
        let mut request = super::knowledge::ScopedSearchRequest {
            query: text(args, "query")?,
            limit: args["limit"].as_u64().unwrap_or(10) as usize,
            launch,
            vector: candidates,
            scope: &scope,
            allowed: allowed_records.as_ref(),
            asset_after: args["asset_after"].as_str(),
            hints: search_request
                .as_ref()
                .and_then(|request| request.hints.as_ref()),
            cid: &cid,
            text_results: &text_results,
            include_raw: tool_contract_version == 2,
        };
        Some(if let Some(selection) = source_selection {
            super::knowledge::search_selected_sources_outside_lock(
                pool,
                ctx,
                &request,
                selection,
                source_selection_gate.as_ref(),
                continuation,
            )
            .await?
        } else if let Some(continuation) = continuation {
            super::knowledge::restore_search_stage_outside_lock(
                pool,
                ctx,
                &mut request,
                continuation,
            )
            .await?
        } else {
            super::knowledge::search_stage_outside_lock(pool, ctx, &mut request).await?
        })
    } else {
        None
    };
    // 合成验收在召回完成后延迟，验证锁外续租以及提交前的版本竞争。
    if search_stage.is_some()
        && let Ok(delay) = std::env::var("DATA_AGENT_TEST_RETRIEVAL_DELAY_MS")
        && let Ok(ms) = delay.parse::<u64>()
        && ms > 0
    {
        eprintln!("test_retrieval_stage_ready run={}", text(&input, "run_id")?);
        tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
    }
    let mut tx = AppTx::begin(pool).await?;
    let mut conv = conversations::lock_conversation_in_tx(&mut tx, ctx, &cid).await?;
    let mut run = runtime::lock_run_in_tx(&mut tx, text(&input, "run_id")?, &cid).await?;
    let mut tool = runtime::lock_tool_call_in_tx(&mut tx, &run, text(&input, "sdk_tool_call_id")?)
        .await?
        .ok_or(Error::new("version_conflict"))?;
    if tool.fingerprint != fingerprint(&json!({"name":name,"arguments":args})) {
        return Err(Error::new("idempotency_conflict"));
    }
    conversations::assert_turn_in_tx(&tx, &conv, &run.id, epoch(text(&input, "lease_epoch")?)?)?;
    if run.state != "running" {
        return Err(Error::new("lease_lost"));
    }
    if run.tool_contract_version == 2
        && requires_source_context(name, args)
        && super::source_limits::input_context_blocker_in_tx(&mut tx, &conv, &run.message_id)
            .await?
            .is_some()
    {
        return Err(Error::new("task_context_required"));
    }
    if let Some(checked) = &checked {
        super::context_authority::assert_checked_run_in_tx(&mut tx, &run.id, checked).await?;
        super::context_authority::assert_run_in_tx(&mut tx, ctx, &cid, &run.id).await?;
    }
    if tool.receipt.is_some()
        && (tool.state == "rejected"
            || !matches!(
                name,
                "search_knowledge"
                    | "read_knowledge"
                    | "read_source"
                    | "read"
                    | "get_query"
                    | "read_conversation"
                    | "read_analysis_task"
                    | "read_analysis_report"
                    | "validate_sql"
            ))
    {
        let mut receipt =
            replay_receipt_in_tx(&mut tx, ctx, &conv, &run.id, name, &tool, &text_results).await?;
        attach_source_readiness_in_tx(&mut tx, &conv, &run, tool_contract_version, &mut receipt)
            .await?;
        tx.commit().await?;
        return Ok(receipt);
    }
    // 本题声明的来源允许集在执行事务内重查：allowed_sources跟任务条件走，
    // 不取自run快照，修订后下一轮读取立即生效。request_query的门在条件授权处
    // 按草稿所属任务解析（args.task_id显式指明，不经消息绑定集），不在此解析。
    let source_gate = if !source_identity_view
        && matches!(
            name,
            "search_knowledge"
                | "read_knowledge"
                | "read_source"
                | "validate_sql"
                | "read"
                | "get_query"
                | "read_analysis_report"
        ) {
        super::source_limits::resolve_in_tx(&mut tx, &conv, &run.message_id).await?
    } else {
        None
    };
    let evidence_read = tool_contract_version == 2
        && !source_identity_view
        && matches!(name, "search_knowledge" | "read_knowledge" | "read_source");
    let evidence_task = if evidence_read {
        let reference = args
            .get("task_ref")
            .filter(|value| !value.is_null())
            .map(|value| {
                serde_json::from_value(value.clone()).map_err(|_| Error::new("invalid_input"))
            })
            .transpose()?;
        super::evidence_delivery::current_task_in_tx(&mut tx, &conv, reference.as_ref()).await?
    } else {
        None
    };
    if let Some(selection) = &search_selection {
        selection.assert_task(
            &evidence_task,
            search_request
                .as_ref()
                .is_some_and(|request| request.cursor.is_some()),
        )?;
    }
    // 正文和支持准备不持会话/运行锁；本次交付依赖和采用记录只在最终重核后保存。
    if evidence_read {
        tx.commit().await?;
        tx = AppTx::begin(pool).await?;
    }
    let mut delivery_authority = super::context_authority::empty();
    let mut read_asset_authority = super::context_authority::empty();
    let mut adopted_assets = Vec::new();
    let data = match name {
        "search_knowledge" if source_identity_view => {
            external.as_ref().ok_or(Error::new("unavailable"))?.clone()
        }
        "search_knowledge" => {
            // 召回与目录已在锁外短读事务完成；提交前重核对象、依赖与资产版本。
            let stage = search_stage.take().ok_or(Error::new("unavailable"))?;
            super::knowledge::assert_search_fresh_in_tx(&mut tx, ctx, &stage).await?;
            let mut search = stage.search;
            let vector_available = search.coverage["vector_state"] == "available";
            let items = stage.items;
            let mut page = stage.page;
            // 受限检索只交付允许来源实际贡献的命中；个人记忆不作为查证线索交付。
            // 过滤事实进入回执的source_limits块，与candidate_limit空结果可区分。
            let mut limits_receipt = None;
            if let Some(gate) = &source_gate {
                let (kept, filtered) = gate.filter_objects_in_tx(&mut tx, &search.objects).await?;
                let allowed_objects = kept
                    .into_iter()
                    .map(|index| search.objects[index].clone())
                    .collect::<Vec<_>>();
                search.objects = allowed_objects;
                search.hits.retain(|hit| match hit {
                    super::knowledge::SearchHit::Knowledge { content, .. } => {
                        search.objects.iter().any(|object| {
                            object["id"] == content["id"] && object["version"] == content["version"]
                        })
                    }
                    super::knowledge::SearchHit::SourceExcerpt { content, .. } => {
                        let citation = &content["citation"];
                        let id = citation["source"]["id"]
                            .as_str()
                            .expect("verified source identity");
                        let source = if citation["source"]["kind"] == "document" {
                            format!("document-{id}")
                        } else {
                            id.to_owned()
                        };
                        gate.allows_source_arg(&source)
                    }
                });
                // v1保留已取候选的实际过滤数；不查询范围外资料来构造计数。
                limits_receipt = Some(gate.receipt(filtered));
            }
            if !memory_candidates.is_empty() {
                let mut merged = Vec::new();
                for hit in &memory_candidates {
                    if let Some(asset) = items.iter().find(|asset| {
                        asset["kind"] == "memory"
                            && asset["id"] == hit["asset_id"]
                            && asset["version"] == hit["version"]
                    }) {
                        let preview = retrieval::asset_directory(vec![asset.clone()], "*", None, 1);
                        merged.extend(
                            preview["memories"]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .cloned(),
                        );
                    }
                    if merged.len() >= args["limit"].as_u64().unwrap_or(10) as usize
                        || serde_json::to_vec(&merged).expect("memories").len() > 9000
                    {
                        break;
                    }
                }
                for memory in page["memories"].as_array().into_iter().flatten() {
                    if !merged.iter().any(|m| m["id"] == memory["id"]) {
                        merged.push(memory.clone());
                    }
                }
                // 召回候选可补充目录，但不能挤掉游标已经越过的当页资产。
                page["memories"] = json!(merged);
            }
            if let Some(gate) = &source_gate {
                // 个人资产按真实来源过滤而非整类排除：合法同源记忆与已选Skill保留，
                // 未知来源、停用、改版、越界项剔除，不因人工资产无来源闭包拖累
                // 合法检索整次409。
                for key in ["memories", "selected_skills"] {
                    let mut kept = Vec::new();
                    for asset in page[key].as_array().into_iter().flatten() {
                        if super::source_limits::asset_within_in_tx(&mut tx, ctx, gate, asset)
                            .await?
                        {
                            kept.push(asset.clone());
                        }
                    }
                    page[key] = json!(kept);
                }
                if page["memories"]
                    .as_array()
                    .is_none_or(|memories| memories.is_empty())
                {
                    memory_retrieval = "excluded_by_source_limits";
                }
            }
            let contents = search
                .hits
                .iter()
                .filter_map(|hit| match hit {
                    super::knowledge::SearchHit::Knowledge { content, .. } => Some(content.clone()),
                    super::knowledge::SearchHit::SourceExcerpt { .. } => None,
                })
                .collect::<Vec<_>>();
            let reply = if tool_contract_version == 2 {
                let active = &evidence_task;
                let mut hits = Vec::with_capacity(search.hits.len());
                let mut support_pages = Vec::with_capacity(search.hits.len());
                let mut support_deadline = false;
                for hit in &search.hits {
                    let mut support_position = None;
                    let hit = match hit {
                        super::knowledge::SearchHit::Knowledge { content, .. } => {
                            let entry = &content["entries"][0];
                            let statement = &entry["statement_content"];
                            let offset = statement["statement_offset"]
                                .as_u64()
                                .or_else(|| entry["content_page"]["offset"].as_u64())
                                .unwrap_or(0);
                            let value = entry["effective_value"].as_str().unwrap_or("");
                            let end = offset + value.chars().count() as u64;
                            // 携statement_id补读时坐标属于单陈述，不能使用整个entry的基址或长度。
                            let total = if statement.is_object() {
                                let scope = statement["scope_chars"].as_u64().unwrap_or(0);
                                statement["text_chars"].as_u64().unwrap_or(0)
                                    + if scope > 0 { 1 + scope } else { 0 }
                            } else {
                                entry["content_page"]["total_chars"].as_u64().unwrap_or(end)
                            };
                            let reference: contracts::generated::EvidenceRef = serde_json::from_value(json!({
                            "object_id":content["id"],"version":content["version"],"path":entry["path"],
                        })).map_err(|_| Error::new("invalid_input"))?;
                            let statement_id = statement["statement_id"].as_str();
                            let mut support_selection =
                                super::knowledge_supports::SupportSelection::new(
                                    &json!({"space_id":ctx.space_id,"user_id":ctx.user_id,
                                "object_id":reference.object_id,"path":reference.path,
                                "statement_id":statement_id,"structure_only":false,
                                "task_id":active.as_ref().map(|(task,_)|task),
                                "limits":source_gate.as_ref().map(|gate|gate.receipt(0)["allowed_sources"].clone())}),
                                    &reference.version,
                                    active.as_ref().map(|(_, version)| *version),
                                    None,
                                )?;
                            let definition_path = format!("/hits/{}/definition", hits.len());
                            let scope_path = format!("/hits/{}/scope_text", hits.len());
                            let statement_offset =
                                statement["statement_offset"].as_u64().unwrap_or(0);
                            let scope_offset = statement_offset
                                .saturating_sub(statement["text_chars"].as_u64().unwrap_or(0) + 1);
                            let visible = [
                                super::knowledge_supports::VisibleSupportContent {
                                    field: Some("text"),
                                    offset: statement_offset,
                                    text: statement["text"].as_str().unwrap_or(""),
                                    path: &definition_path,
                                },
                                super::knowledge_supports::VisibleSupportContent {
                                    field: Some("scope_text"),
                                    offset: scope_offset,
                                    text: statement["scope_text"].as_str().unwrap_or(""),
                                    path: &scope_path,
                                },
                            ];
                            // 支持读取仍受本次搜索绝对期限约束；超时留下原支持位置，
                            // 不丢弃已取主命中，也不把未读目录说成没有条件。
                            let prepared = if tokio::time::Instant::now() < search_deadline {
                                tokio::time::timeout_at(search_deadline, async {
                                    let mut support_tx = AppTx::begin(pool).await?;
                                    let page = super::knowledge_supports::read_in_tx(
                                        &mut support_tx,
                                        ctx,
                                        super::knowledge_supports::SupportRead {
                                            reference: &reference,
                                            statement_id,
                                            selection: &mut support_selection,
                                            visible: &visible,
                                        },
                                        source_gate.as_ref(),
                                    )
                                    .await?;
                                    support_tx.commit().await?;
                                    Ok::<_, Error>(page)
                                })
                                .await
                                .ok()
                            } else {
                                None
                            };
                            let support_page = match prepared {
                                Some(page) => page?,
                                None => {
                                    let total = statement["supports"].as_array().map(Vec::len);
                                    support_deadline |= total != Some(0);
                                    json!({"supports":[], "total":total,
                                        "next_cursor":support_selection.next_cursor(&[], &[])?})
                                }
                            };
                            let incomplete_support =
                                support_page["total"].as_u64().is_some_and(|total| {
                                    support_page["supports"].as_array().map_or(0, Vec::len)
                                        < total as usize
                                }) || support_page["supports"]
                                    .as_array()
                                    .into_iter()
                                    .flatten()
                                    .any(super::knowledge_supports::incomplete);
                            let complete = if statement.is_object() {
                                statement["statement_offset"] == 0
                                    && statement["text"].as_str().unwrap_or("").chars().count()
                                        as u64
                                        == statement["text_chars"].as_u64().unwrap_or(0)
                                    && statement["scope_text"]
                                        .as_str()
                                        .unwrap_or("")
                                        .chars()
                                        .count() as u64
                                        == statement["scope_chars"].as_u64().unwrap_or(0)
                            } else {
                                offset == 0 && end == total
                            };
                            let mut hit = json!({
                                "record_kind":"knowledge_entry",
                                "ref":{"object_id":content["id"],"version":content["version"],"path":entry["path"]},
                                "name":content["name"],"kind":content["kind"],
                                "definition":if statement.is_object(){statement["text"].clone()}else{json!(value)},
                                "scope_text":statement["scope_text"].as_str().unwrap_or(""),
                                "support_state":if incomplete_support{"partial"}else if statement["supports_complete"]==true{"delivered"}else{"unknown"},
                                "supports":support_page["supports"],"supports_complete":statement["supports_complete"],"example_refs":[],
                                "citations":statement["citations"].as_array().cloned().unwrap_or_default(),
                                "content_state":if complete{"complete"}else{"partial"},
                                "continuation":{"content_next_offset":if end < total {Some(end)}else{None},"supports_next_cursor":support_page["next_cursor"]}
                            });
                            if statement["statement_id"].is_string() {
                                hit["statement_id"] = statement["statement_id"].clone();
                            }
                            support_position = Some(super::knowledge_supports::SupportPage {
                                selection: support_selection,
                                total: support_page["total"].as_u64().map(|total| total as usize),
                                positions: support_page["positions"]
                                    .as_array()
                                    .into_iter()
                                    .flatten()
                                    .map(|position| position.as_u64().unwrap_or(0) as usize)
                                    .collect(),
                            });
                            hit
                        }
                        super::knowledge::SearchHit::SourceExcerpt { content, .. } => json!({
                            "record_kind":"source_excerpt","citation":content["citation"],
                            "source_length":content["source_length"],"text":content["text"],"name":content["name"],
                            "content_state":content["content_state"],"support_state":"unknown","semantic_status":content["semantic_status"]
                        }),
                    };
                    hits.push(hit);
                    support_pages.push(support_position);
                }
                let exact = &search.scan_progress["exact"];
                let mut channels = vec![json!({"channel":"exact","state":exact})];
                let mut reasons = Vec::new();
                if exact == "unavailable" {
                    reasons.push("channel_unavailable");
                }
                if search.scan_progress["deadline"] == true {
                    reasons.push("deadline");
                }
                for (channel, keys) in [
                    ("bm25", ["lexical", "raw_lexical"]),
                    ("dense", ["dense", "raw_dense"]),
                ] {
                    let cursors = keys
                        .iter()
                        .filter_map(|key| search.scan_progress["milvus"].get(*key))
                        .collect::<Vec<_>>();
                    // 空分片游标（该路未配置/未派发）不能为通道作保：只有真实
                    // 成功过的分片证明可用。
                    let shard_succeeded = cursors.iter().any(|cursor| {
                        cursor["shards"].as_array().is_some_and(|shards| {
                            shards.iter().any(|shard| shard["succeeded"] == true)
                        })
                    });
                    // R12：BM25整路明确失败时SQL替代词法正文，替代真实成功仍算
                    // 词法能力可用；dense没有SQL替代票。
                    let sql_substitute = channel == "bm25"
                        && search.scan_progress["sql"].as_array().is_some_and(|sql| {
                            sql.iter().any(|cursor| cursor["succeeded"] == true)
                        });
                    let available = shard_succeeded || sql_substitute;
                    let state = if available {
                        "available"
                    } else if cursors.is_empty() {
                        "not_configured"
                    } else {
                        "unavailable"
                    };
                    // R14：某片成功不抹掉另片失败。部分失败时通道保持available
                    // （仍有可用正文），同时以channel_unavailable并列说明未覆盖
                    // 的失败分片；不把局部失败改成全败。
                    let shard_failed = cursors.iter().any(|cursor| {
                        cursor["shards"].as_array().is_some_and(|shards| {
                            shards.iter().any(|shard| shard["failed"] == true)
                        })
                    });
                    if (state == "unavailable" || shard_failed)
                        && !reasons.contains(&"channel_unavailable")
                    {
                        reasons.push("channel_unavailable");
                    }
                    channels.push(json!({"channel":channel,"state":state}));
                }
                if support_deadline && !reasons.contains(&"deadline") {
                    reasons.push("deadline");
                }
                // R13：只有真实查到旧投影/漏索引才报index_lag；期限耗尽/读取
                // 超时的未核完由deadline事实表达，不能反推滞后。
                if search.coverage["index_lag"] == true {
                    reasons.push("index_lag");
                }
                if search.coverage["state"] == "candidate_limit" {
                    reasons.push("candidate_limit");
                }
                let reply = json!({"hits":hits,
                    "search_coverage":{"channels":channels,"state":if search.coverage["state"]=="complete" && reasons.is_empty(){"searched"}else{"bounded"},"reasons":reasons,"next":null},
                    "personal_memories":page["memories"],"selected_skills":page["selected_skills"],
                    "next_asset_after":page["next_asset_after"],"asset_total":page["total"],
                    "asset_cursor_invalid":page["cursor_invalid"]==true,"memory_retrieval":memory_retrieval});
                let reply = super::evidence_delivery::search_reply(
                    reply,
                    response_budget.as_ref(),
                    super::evidence_delivery::SearchDelivery {
                        search: &search,
                        selection: search_selection.as_ref().ok_or(Error::new("unavailable"))?,
                        support_pages: &support_pages,
                        assets: &page,
                        asset_after: search_request
                            .as_ref()
                            .and_then(|request| request.asset_after.as_deref()),
                        public_next: &format!("{SEARCH_RECEIPT_PREFIX}{}", tool.operation_id),
                    },
                )?;
                contracts::validate("KnowledgeSearchReply", &reply)?;
                reply
            } else {
                let mut reply = json!({"objects":search.objects.into_iter().map(|object|retrieval::search_preview(object,text(args,"query").unwrap_or(""))).collect::<Vec<_>>(),"search_coverage":search.coverage,"search_scope":{"kinds":scope.kinds,"related_object_id":scope.anchor,"business_domain":scope.domain},"personal_memories":page["memories"],"selected_skills":page["selected_skills"],"next_asset_after":page["next_asset_after"],"asset_total":page["total"],"asset_cursor_invalid":page["cursor_invalid"]==true,"memory_retrieval":memory_retrieval,"retrieval_mode":if vector_available{"hybrid_authoritative"}else{"lexical_authoritative"},"note":"命中已回源。search_scope是本次检索范围；空结果只表示此范围未找到资料，不证明全空间不存在。search_coverage.state=candidate_limit或bounded表示只检查了有界候选或部分索引，空结果不能证明不存在；可在用户限定范围内改写或按已知ID读取，扩大用户明确范围须先征得同意。reply_coverage与omitted_objects说明回执裁剪，正文按同版entry_id/offset补读。个人记忆是查证线索；Skill仅列出本会话已选当前版本。query=*可分页查看本人有效资产目录，按next_asset_after继续；记忆正文用read_knowledge，Skill用read按行续读。"});
                if let Some(limits) = limits_receipt {
                    reply["source_limits"] = limits;
                }
                retrieval::bounded_search_reply(reply)
            };
            let authority =
                super::context_authority::search_delivery_dependencies(&contents, &reply);
            if evidence_read {
                delivery_authority = authority;
            } else {
                super::context_authority::merge_run_in_tx(&mut tx, &run.id, &authority).await?;
            }
            reply
        }
        "read_knowledge" if tool_contract_version == 2 => {
            let request: contracts::generated::KnowledgeReadInput =
                serde_json::from_value(args.clone()).map_err(|_| Error::new("invalid_input"))?;
            let active = &evidence_task;
            let mut items = Vec::with_capacity(request.items.len());
            let mut support_pages = Vec::with_capacity(request.items.len());
            for (index, item) in request.items.into_iter().enumerate() {
                let mut support_position = None;
                let identity = match &item {
                    contracts::generated::KnowledgeReadItem::Knowledge {
                        knowledge_read_item_ref: reference,
                        ..
                    } => json!({"kind":"knowledge","ref":reference}),
                    contracts::generated::KnowledgeReadItem::Memory {
                        asset_ref, part, ..
                    } => {
                        json!({"kind":"memory","asset_ref":asset_ref,"part":part})
                    }
                    contracts::generated::KnowledgeReadItem::Skill { asset_ref } => {
                        json!({"kind":"skill","asset_ref":asset_ref})
                    }
                };
                let result: Result<Value> = async {
                    match item {
                        contracts::generated::KnowledgeReadItem::Knowledge {
                            knowledge_read_item_ref: reference, statement_id, structure_only, offset, limit, supports_cursor,
                        } => {
                            let structure_only = structure_only.unwrap_or(false);
                            let mut support_selection = super::knowledge_supports::SupportSelection::new(
                                &json!({"space_id":ctx.space_id,"user_id":ctx.user_id,
                                    "object_id":reference.object_id,"path":reference.path,
                                    "statement_id":statement_id,"structure_only":structure_only,
                                    "task_id":active.as_ref().map(|(task,_)|task),
                                    "limits":source_gate.as_ref().map(|gate|gate.receipt(0)["allowed_sources"].clone())}),
                                &reference.version, active.as_ref().map(|(_,version)|*version),
                                supports_cursor.as_deref(),
                            )?;
                            let meta = knowledge::read_selected_structure_in_tx(
                                &mut tx, ctx, &reference.object_id, epoch(&reference.version)?, Some(&reference.path),
                            ).await.map_err(|error| if supports_cursor.is_some() && error.code == "stale_knowledge" {
                                Error::new("stale_cursor")
                            } else if error.code == "invalid_evidence" { Error::new("not_available") } else { error })?;
                            let selected_path = meta["entries"][0]["path"].as_str().ok_or(Error::new("invalid_evidence"))?;
                            let canonical_reference=contracts::generated::EvidenceRef {path:selected_path.to_owned(),..reference.clone()};
                            // 范围先于正文，读取、采用和草稿共用owner核实的条目选择。
                            if let Some(gate) = &source_gate {
                                gate.assert_selection_in_tx(&mut tx, &meta, selected_path).await?;
                            }
                            super::knowledge_sources::assert_selected_in_tx(&mut tx, ctx, &meta, selected_path).await
                                .map_err(|error| if supports_cursor.is_some() && matches!(error.code,"stale_context"|"stale_source"|"stale_knowledge") {
                                    Error::new("stale_cursor")
                                } else { error })?;
                            let mut page = knowledge::read_entry_page_in_tx(
                                &mut tx, ctx, &canonical_reference, statement_id.as_deref(), structure_only,
                                offset.unwrap_or(0) as usize, limit.unwrap_or(4096) as usize,
                            ).await?;
                            let support_refs = page["supports"].as_array().into_iter().flatten()
                                .filter(|support| support["reference"]["kind"] == "knowledge")
                                .map(|support| support["reference"]["ref"].clone()).collect::<Vec<_>>();
                            super::knowledge::check_refs_for_task_in_tx(&mut tx, ctx, &json!(support_refs), source_gate.as_ref()).await?;
                            let mut reply = json!({"kind":"knowledge","ref":reference,"state":"ok"});
                            if let Some(statement_id) = &statement_id {
                                reply["statement_id"] = json!(statement_id);
                            }
                            if structure_only {
                                // 分页正文不能替代完整列绑定；只取所选的有界结构交给原采用规则。
                                let binding = json!({"id":reference.object_id,"version":reference.version,
                                    "kind":meta["kind"],"name":meta["name"],"related_ids":page["related_ids"],
                                    "entries":[{"entry_id":page["entry_id"],"path":canonical_reference.path,
                                        "effective_structure":page["binding_structure"]}]});
                                let checked = super::knowledge::semantic_object_in_tx(&mut tx, ctx, binding).await?;
                                reply["structure_coverage"] = checked["structure_coverage"].clone();
                                reply["structure_dependencies"] = checked["structure_dependencies"].clone();
                                if checked["structure_coverage"]["state"] != "complete" {
                                    page["content"] = json!("");
                                    page["content_page"] = json!({"offset":0,"total_chars":0,"complete":true,"next_offset":null});
                                    page["structure_text"] = json!("");
                                    page["structure_page"] = page["content_page"].clone();
                                    page["effective_structure"] = Value::Null;
                                }
                                for field in ["structure_text", "structure_page", "effective_structure"] {
                                    reply[field] = page[field].clone();
                                }
                            }
                            let content_path = format!("/items/{index}/content");
                            let visible = [super::knowledge_supports::VisibleSupportContent {
                                field: None, offset: page["content_page"]["offset"].as_u64().unwrap_or(0),
                                text: page["content"].as_str().unwrap_or(""), path: &content_path,
                            }];
                            let support_page = super::knowledge_supports::read_in_tx(
                                &mut tx, ctx, super::knowledge_supports::SupportRead {
                                    reference:&canonical_reference, statement_id:statement_id.as_deref(), selection:&mut support_selection,
                                    visible: if structure_only { &[] } else { &visible },
                                }, source_gate.as_ref(),
                            ).await.map_err(|error| if supports_cursor.is_some() && matches!(error.code,"stale_context"|"stale_source"|"stale_knowledge") {
                                Error::new("stale_cursor")
                            } else { error })?;
                            reply["content"] = page["content"].clone();
                            reply["content_page"] = page["content_page"].clone();
                            reply["supports"] = support_page["supports"].clone();
                            reply["supports_total"] = support_page["total"].clone();
                            reply["supports_complete"] = page["supports_complete"].clone();
                            reply["citations"] = page["citations"].clone();
                            reply["content_state"] = json!(if page["content_page"]["next_offset"].is_null(){"complete"}else{"partial"});
                            reply["support_state"] = json!(if support_page["total"].as_u64().is_some_and(|total| support_page["supports"].as_array().map_or(0, Vec::len) < total as usize)
                                || support_page["supports"].as_array().into_iter().flatten().any(super::knowledge_supports::incomplete) {
                                "partial"
                            } else if page["supports_complete"] == true { "delivered" } else { "unknown" });
                            reply["continuation"] = json!({"content_next_offset":page["content_page"]["next_offset"],"supports_next_cursor":support_page["next_cursor"]});
                            support_position = Some(super::knowledge_supports::SupportPage {
                                selection: support_selection,
                                total: support_page["total"].as_u64().map(|total| total as usize),
                                positions: support_page["positions"]
                                    .as_array()
                                    .into_iter()
                                    .flatten()
                                    .map(|position| position.as_u64().unwrap_or(0) as usize)
                                    .collect(),
                            });
                            Ok(reply)
                        }
                        contracts::generated::KnowledgeReadItem::Memory { asset_ref, part, offset, limit } => {
                            let asset = assets::read_in_tx(&mut tx, ctx, &asset_ref.id, true).await?;
                            if asset["kind"] != "memory" {
                                return Err(Error::new("not_available"));
                            }
                            if asset["version"] != asset_ref.version {
                                return Err(Error::new("stale_knowledge"));
                            }
                            if let Some(gate) = &source_gate {
                                super::source_limits::assert_asset_in_tx(&mut tx, ctx, gate, &asset)
                                    .await?;
                            }
                            let authority = super::personal_assets::text_authority_in_tx(
                                &mut tx, ctx, &cid, &asset, &text_results,
                            ).await?;
                            let field = match part {
                                contracts::generated::PartEnum::Body => "body",
                                contracts::generated::PartEnum::Scope => "scope",
                                contracts::generated::PartEnum::SourceText => "source_text",
                            };
                            let offset = offset.unwrap_or(0) as usize;
                            if offset > asset[field].as_str().unwrap_or("").chars().count() {
                                return Err(Error::new("invalid_input"));
                            }
                            adopted_assets.push(json!({"id":asset["id"],"version":asset["version"]}));
                            super::context_authority::merge(&mut read_asset_authority, &authority)?;
                            let asset = retrieval::model_page(asset, offset, limit.unwrap_or(4096) as usize, Some(field));
                            Ok(json!({"kind":"memory","asset_ref":asset_ref,"part":part,"state":"ok","asset":asset}))
                        }
                        contracts::generated::KnowledgeReadItem::Skill { asset_ref } => {
                            let asset = assets::read_in_tx(&mut tx, ctx, &asset_ref.id, true).await?;
                            if asset["kind"] != "skill" {
                                return Err(Error::new("not_available"));
                            }
                            if asset["version"] != asset_ref.version {
                                return Err(Error::new("stale_knowledge"));
                            }
                            if !assets::selected_in_tx(&mut tx, ctx, &cid).await?.iter()
                                .any(|selected| selected["id"] == asset_ref.id && selected["version"] == asset_ref.version)
                            {
                                return Err(Error::new("not_available"));
                            }
                            if let Some(gate) = &source_gate {
                                super::source_limits::assert_asset_in_tx(&mut tx, ctx, gate, &asset)
                                    .await?;
                            }
                            let authority = super::personal_assets::text_authority_in_tx(
                                &mut tx, ctx, &cid, &asset, &text_results,
                            ).await?;
                            adopted_assets.push(json!({"id":asset["id"],"version":asset["version"]}));
                            super::context_authority::merge(&mut read_asset_authority, &authority)?;
                            let mut descriptor = assets::skill_files::descriptor(&asset);
                            let scope = asset["scope"].as_str().unwrap_or("").chars().count();
                            let visible = descriptor["scope"].as_str().unwrap_or("").chars().count();
                            descriptor["scope_page"] = json!({"offset":0,"total_chars":scope,
                                "complete":visible==scope,"next_offset":if visible<scope {Some(visible)} else {None}});
                            Ok(json!({"kind":"skill","asset_ref":asset_ref,"state":"ok","asset":descriptor}))
                        }
                    }
                }.await;
                support_pages.push(support_position);
                match result {
                    Ok(value) => items.push(value),
                    Err(error) if error.code == "stale_knowledge" => {
                        let mut value = identity;
                        value["state"] = json!("stale");
                        items.push(value);
                    }
                    Err(error)
                        if matches!(
                            error.code,
                            "not_available"
                                | "forbidden"
                                | "source_not_allowed"
                                | "stale_context"
                                | "result_expired"
                                | "result_unavailable"
                        ) =>
                    {
                        let mut value = identity;
                        value["state"] = json!("not_available");
                        items.push(value);
                    }
                    Err(error) if error.code == "unavailable" => {
                        return Err(Error::new("upstream_failed"));
                    }
                    Err(error) => return Err(error),
                }
            }
            let reply = super::evidence_delivery::knowledge_reply(
                json!({"items":items}),
                response_budget.as_ref(),
                &support_pages,
            )?;
            contracts::validate("KnowledgeReadReply", &reply)?;
            reply
        }
        "read_knowledge" => {
            let object = text(args, "object_id")?;
            if object.starts_with("asset-") {
                let asset =
                    assets::read_in_tx(&mut tx, ctx, object.trim_start_matches("asset-"), true)
                        .await?;
                if args["version"]
                    .as_str()
                    .is_some_and(|v| asset["version"] != v)
                {
                    return Err(Error::new("stale_knowledge"));
                }
                super::knowledge::check_refs_in_tx(&mut tx, ctx, &asset["dependencies"]).await?;
                // 个人资产按自身dependencies/字段authority核来源：无可核验允许来源
                // 的资产不能作为依据交付，也不能拿资产ID查知识贡献根。
                if let Some(gate) = &source_gate {
                    super::source_limits::assert_asset_in_tx(&mut tx, ctx, gate, &asset).await?;
                }
                if asset["kind"] == "skill"
                    && !assets::selected_in_tx(&mut tx, ctx, &cid)
                        .await?
                        .iter()
                        .any(|v| v["id"] == asset["id"] && v["version"] == asset["version"])
                {
                    return Err(Error::new("selection_required"));
                }
                assets::record_adoption_in_tx(&mut tx, ctx, &run.id, &asset, "read").await?;
                if asset["kind"] == "skill" {
                    assets::skill_files::descriptor(&asset)
                } else {
                    retrieval::model_page(
                        asset,
                        args["offset"].as_u64().unwrap_or(0) as usize,
                        args["limit"].as_u64().unwrap_or(4096) as usize,
                        args["entry_id"].as_str(),
                    )
                }
            } else {
                let mut v = knowledge::read_in_tx(
                    &mut tx,
                    ctx,
                    object,
                    args["version"].as_str().map(epoch).transpose()?,
                    false,
                )
                .await?;
                let path = if let Some(entry_id) = args["entry_id"].as_str() {
                    let entry = v["entries"]
                        .as_array()
                        .and_then(|entries| {
                            entries.iter().find(|entry| entry["entry_id"] == entry_id)
                        })
                        .cloned()
                        .ok_or(Error::new("not_available"))?;
                    let path = entry["path"]
                        .as_str()
                        .ok_or(Error::new("invalid_evidence"))?
                        .to_owned();
                    v["entries"] = json!([entry]);
                    path
                } else {
                    String::new()
                };
                super::knowledge_sources::assert_selected_in_tx(&mut tx, ctx, &v, &path).await?;
                if let Some(gate) = &source_gate {
                    gate.assert_selection_in_tx(&mut tx, &v, &path).await?;
                }
                let v = super::knowledge::semantic_object_in_tx(&mut tx, ctx, v).await?;
                if args["structure_only"] == true {
                    retrieval::model_structure_page(
                        v,
                        args["offset"].as_u64().unwrap_or(0) as usize,
                        args["limit"].as_u64().unwrap_or(4096) as usize,
                        args["entry_id"].as_str(),
                    )
                } else {
                    retrieval::model_page(
                        v,
                        args["offset"].as_u64().unwrap_or(0) as usize,
                        args["limit"].as_u64().unwrap_or(4096) as usize,
                        args["entry_id"].as_str(),
                    )
                }
            }
        }
        "read" => {
            super::personal_assets::read_skill_file_in_tx(
                &mut tx,
                ctx,
                &conv,
                &run.id,
                text(args, "path")?,
                &text_results,
                source_gate.as_ref(),
            )
            .await?
        }
        "read_source" if tool_contract_version == 2 => {
            let request: contracts::generated::SourceReadInput =
                serde_json::from_value(args.clone()).map_err(|_| Error::new("invalid_input"))?;
            let source = match request.citation.source.kind {
                contracts::generated::SourceKeyKind::Document => {
                    format!("document-{}", request.citation.source.id)
                }
                contracts::generated::SourceKeyKind::Platform => request.citation.source.id.clone(),
            };
            if let Some(gate) = &source_gate {
                gate.assert_source_arg(&source)?;
            }
            let reply = super::knowledge_sources::read_citation_page_in_tx(
                &mut tx,
                ctx,
                request.citation,
                request.limit.unwrap_or(8192) as usize,
            )
            .await?;
            let reply = super::evidence_delivery::source_reply(
                serde_json::to_value(reply).expect("source read reply"),
                response_budget.as_ref(),
            )?;
            contracts::validate("SourceReadReply", &reply)?;
            reply
        }
        "read_source" => {
            // 来源身份先行判定：范围外来源不读正文，避免先加载再拒绝。
            if let Some(gate) = &source_gate {
                gate.assert_source_arg(text(args, "source_id")?)?;
            }
            let source = super::knowledge_sources::read_in_tx(
                &mut tx,
                ctx,
                text(args, "source_id")?,
                Some(epoch(text(args, "version")?)?),
            )
            .await?;
            if source["current_version"] != source["version"] || source["complete"] != true {
                return Err(Error::new("stale_knowledge"));
            }
            retrieval::model_page(
                source,
                args["offset"].as_u64().unwrap_or(0) as usize,
                args["limit"].as_u64().unwrap_or(4096) as usize,
                None,
            )
        }
        "read_analysis_task" => {
            let projection = super::source_limits::active_projection_in_tx(&mut tx, &conv).await?;
            let requested_version = args["condition_version"].as_str().map(epoch).transpose()?;
            let mut task = analysis::read_task_with_clarifications_in_tx(
                &mut tx,
                &cid,
                text(args, "task_id")?,
                args["clarification_after"].as_str(),
                requested_version,
            )
            .await?;
            let refs = super::context_authority::protect_task_context_in_tx(
                &mut tx,
                ctx,
                &cid,
                &mut task,
                &text_results,
                Some(&projection),
            )
            .await?;
            super::context_authority::merge_run_in_tx(&mut tx, &run.id, &refs).await?;
            if let Some(version) = requested_version
                && task["decision_state_version"] == 1
                && task["conditions"].is_object()
                && let Some(update) = runtime::task_condition_update_in_tx(
                    &mut tx,
                    &cid,
                    text(args, "task_id")?,
                    version,
                )
                .await?
                && task["conditions"] == update.conditions
            {
                let original =
                    conversations::read_message_in_tx(&mut tx, &conv, &update.message_id).await?;
                task["revision_origin"] = json!({
                    "operation_id":update.operation_id,"origin_run_id":update.origin_run_id,
                    "message_id":update.message_id,"user_supplied":original.user_supplied,
                    "user_quote":original.user_supplied.then_some(original.body),
                });
            }
            task
        }
        "read_conversation" => {
            if args["task_directory"] == true {
                // 身份目录也用于尚未裁决的新输入，旧活动范围不能为派生标题背书。
                let projection = super::source_limits::ActiveProjection {
                    task: None,
                    gate: None,
                    scope_known: false,
                };
                let mut directory =
                    analysis::task_directory_in_tx(&mut tx, &cid, args["task_after"].as_str())
                        .await?;
                for task in directory["tasks"]
                    .as_array_mut()
                    .ok_or(Error::new("invalid_input"))?
                {
                    task["context_complete"] = json!(false);
                    let refs = super::context_authority::protect_task_context_in_tx(
                        &mut tx,
                        ctx,
                        &cid,
                        task,
                        &text_results,
                        Some(&projection),
                    )
                    .await?;
                    super::context_authority::merge_run_in_tx(&mut tx, &run.id, &refs).await?;
                }
                directory
            } else if let Some(message_id) = args["message_id"].as_str() {
                let message = conversations::read_message_in_tx(&mut tx, &conv, message_id).await?;
                if message.disposition == "withdrawn" {
                    return Err(Error::new("not_available"));
                }
                let (body, page) = retrieval::text_page(
                    &message.body,
                    args["offset"].as_u64().unwrap_or(0) as usize,
                    2048,
                );
                json!({"message_id":message.id,"text":body,"content_page":page})
            } else {
                let mut events = conversations::model_history_in_tx(
                    &mut tx,
                    &conv,
                    epoch(text(args, "after_seq")?)?,
                )
                .await?;
                for event in &mut events {
                    let (body, page) = retrieval::text_page(
                        event["payload"]["text"].as_str().unwrap_or(""),
                        0,
                        800,
                    );
                    event["payload"]["text"] = json!(body);
                    event["payload"]["content_page"] = page;
                }
                let mut limited = false;
                while events.len() > 1
                    && serde_json::to_vec(&events).expect("history events").len() > 12000
                {
                    events.pop();
                    limited = true;
                }
                let last = events.last().map(|v| v["event_seq"].clone());
                json!({"events":events,"next_after_seq":last,"page_limited":limited,"note":"仅返回未撤回用户输入的有界页。按next_after_seq继续翻页，正文片段不完整时用message_id及offset分块读取；旧助手和工具结论需重新调查；任务用read_analysis_task读取。"})
            }
        }
        "validate_sql" => {
            let mut result = external.clone().ok_or(Error::new("unavailable"))?;
            result["semantic_checks"] =
                semantic_diagnostics_in_tx(&mut tx, ctx, args, source_gate.as_ref()).await?;
            result
        }
        "update_analysis_task" => {
            let message =
                conversations::read_message_in_tx(&mut tx, &conv, &run.message_id).await?;
            // v2未归属时Pi只采用本轮用户原话和控制目录，旧历史及资产预览尚未交付。
            // 原运行授权仍留给恢复校验；不能把它误记成新目标、条件正文的来源。
            let text_authority = if tool_contract_version == 2 && message.routing_state != "routed"
            {
                let mut authority = super::context_authority::empty();
                super::context_authority::observe(&mut authority, args);
                authority
            } else {
                super::context_authority::generated_text_authority_in_tx(&mut tx, &run.id, args)
                    .await?
            };
            // 只豁免真实用户完整原话；结果唤醒消息和模型自报引用不能授予独立来源。
            let goal_authority =
                if message.user_supplied && args["goal"].as_str() == Some(message.body.as_str()) {
                    super::context_authority::empty()
                } else {
                    text_authority.clone()
                };
            let mut task_input = bound_args.as_ref().unwrap_or(args).clone();
            super::source_limits::bind_update_in_tx(
                &mut tx,
                &cid,
                &run.message_id,
                message.user_supplied,
                &mut task_input,
                tool_contract_version,
            )
            .await?;
            if args["finalize_current_answer"] == true {
                let finalized = super::task_answers::finalize_in_tx(
                    &mut tx,
                    ctx,
                    &conv,
                    &run,
                    &tool,
                    &text_results,
                )
                .await?;
                tool.answer_handoff = Some(finalized);
            }
            let tasks = analysis::lock_tasks_in_tx(&mut tx, &cid).await?;
            let mut result = analysis::apply_update_in_tx(
                &mut tx,
                &tasks,
                &ctx.user_id,
                &tool.operation_id,
                analysis::AnalysisUpdateRequest {
                    arguments: &task_input,
                    dialect: update_dialect,
                },
                &analysis::TaskTextAuthority {
                    generated: text_authority,
                    goal: goal_authority,
                    cleared: super::context_authority::empty(),
                },
                legacy_migration.as_ref(),
            )
            .await?;
            if result["conditions"].is_object() {
                let references =
                    super::query_semantics::knowledge_references(&[&result["conditions"]]);
                super::knowledge::check_refs_in_tx(&mut tx, ctx, &references).await?;
            }
            if args["action"] == "split" && result["source_phase"] != "waiting_clarification" {
                let source = text(&result, "source_task_id")?;
                let version = epoch(text(&result, "source_condition_version")?)?;
                let phase = queries::task_waiting_phase_in_tx(&mut tx, source, version)
                    .await?
                    .map(str::to_owned)
                    .unwrap_or_else(|| {
                        result["source_phase"]
                            .as_str()
                            .unwrap_or("investigating")
                            .to_owned()
                    });
                analysis::set_phase_in_tx(&mut tx, source, version, &phase).await?;
                result["source_phase"] = json!(phase);
            }
            if (args["action"] == "revise" || args["action"] == "clarify")
                && let Some(task) = result["task_id"].as_str()
            {
                result["superseded_query_ids"] =
                    json!(queries::supersede_in_tx(&mut tx, &cid, task).await?);
            }
            if let Some(replaced) = args["replaces_query_id"].as_str() {
                if args["action"] != "route" {
                    return Err(Error::new("invalid_input"));
                }
                queries::begin_revision_in_tx(
                    &mut tx,
                    ctx,
                    &cid,
                    text(args, "task_id")?,
                    None,
                    replaced,
                )
                .await?;
            }
            conversations::route_message_in_tx(
                &mut tx,
                &conv,
                &run.message_id,
                result["task_id"].as_str(),
                args["action"] != "route" || args["replaces_query_id"].is_string(),
            )
            .await?;
            // 活动任务绑定：任务归属与版本已由apply_update核验，显式route/创建/
            // 修订/拆分即指定本轮工作目标；受限读取与派发投影继承活动任务，
            // 不取任务并集。条件版本推进只经本入口，随之更新绑定版本。
            if let Some(task) = result["task_id"].as_str()
                && let Ok(version) = epoch(result["condition_version"].as_str().unwrap_or(""))
            {
                conversations::bind_active_task_in_tx(&mut tx, &conv, task, version).await?;
            }
            protect_update_result_in_tx(
                &mut tx,
                ctx,
                &conv,
                &cid,
                &run.id,
                &mut result,
                &text_results,
            )
            .await?;
            conversations::append_event_in_tx(
                &mut tx,
                &conv,
                &id(),
                "task_changed",
                result.clone(),
            )
            .await?;
            result
        }
        "request_query" => {
            // 门跟草稿所属任务走：条件授权内部按args.task_id当前条件解析并硬拒范围外引用；
            // 时间基准与口径决策同源：条件体由授权路径一并返回。
            let (condition_authority, conditions) = request_condition_authority_in_tx(
                &mut tx,
                ctx,
                &conv,
                &run.message_id,
                args,
                &text_results,
            )
            .await?;
            // 原条件版本及当前来源已由request_condition_authority重核；
            // 采纳说明使用前置核对的同一份结果，不能在草稿入口独立改决定。
            let mut text_authority =
                super::context_authority::generated_text_authority_in_tx(&mut tx, &run.id, args)
                    .await?;
            super::context_authority::merge(&mut text_authority, &condition_authority)?;
            let draft_gate =
                super::source_limits::resolve_for_task_in_tx(&mut tx, &cid, text(args, "task_id")?)
                    .await?;
            let report =
                semantic_diagnostics_in_tx(&mut tx, ctx, args, draft_gate.as_ref()).await?;
            let time_basis = time_basis_of(&conditions)?;
            let mut result = queries::save_draft_in_tx(
                &mut tx,
                ctx,
                &cid,
                &run.budget_scope_id,
                &tool.operation_id,
                args,
                queries::DraftValidation {
                    platform_report: external.as_ref().ok_or(Error::new("unavailable"))?,
                    text_authority: &text_authority,
                    time_basis: time_basis.as_ref(),
                    semantic_resolution: query_resolution.as_ref(),
                },
            )
            .await?;
            super::context_authority::merge_run_in_tx(&mut tx, &run.id, &text_authority).await?;
            result["semantic_checks"] = report;
            analysis::set_phase_in_tx(
                &mut tx,
                text(args, "task_id")?,
                epoch(text(args, "condition_version")?)?,
                "waiting_confirmation",
            )
            .await?;
            conversations::append_event_in_tx(&mut tx,&conv,&id(),"query_changed",json!({"query_id":result["id"],"task_id":args["task_id"],"condition_version":args["condition_version"]})).await?;
            result
        }
        "get_query" => {
            let qid = text(args, "query_id")?;
            let mut q = queries::read_in_tx(&mut tx, ctx, qid).await?;
            if q["conversation_id"] != cid {
                return Err(Error::new("not_available"));
            }
            // 历史查询交付保存时正文和条件；撤权仍隐藏正文，历史读取不授予当前采用资格。
            let outcome = super::query_workflow::protect_text_outcome_in_tx(
                &mut tx,
                ctx,
                &cid,
                &q,
                &text_results,
            )
            .await?;
            if let Some(gate) = &source_gate
                && !matches!(outcome, super::query_workflow::ProtectedText::Restricted)
            {
                let authority = match &outcome {
                    super::query_workflow::ProtectedText::Current(authority) => {
                        let mut authority = authority.clone();
                        if let Some(result) =
                            external.as_ref().filter(|result| result["error"].is_null())
                        {
                            super::context_authority::observe(&mut authority, result);
                        }
                        authority
                    }
                    super::query_workflow::ProtectedText::Historical { entry, .. } => {
                        entry["actual_sources"]["authority"].clone()
                    }
                    super::query_workflow::ProtectedText::Restricted => unreachable!(),
                };
                if !super::source_limits::authority_within_in_tx(&mut tx, ctx, gate, &authority)
                    .await?
                {
                    return Err(Error::new("source_not_allowed"));
                }
            }
            if let super::query_workflow::ProtectedText::Current(authority) = &outcome {
                super::context_authority::merge_run_in_tx(&mut tx, &run.id, authority).await?;
            }
            match outcome {
                super::query_workflow::ProtectedText::Current(_) => {
                    if q["execution_state"] == "succeeded"
                        && queries::is_confirmation_message_in_tx(
                            &mut tx,
                            ctx,
                            qid,
                            &run.message_id,
                        )
                        .await?
                    {
                        // 快查询也只在已有的结果交付轮解释，避免执行轮与结果通知重复作答。
                        json!({"query":q,"results":null,"hint":"本消息刚提交的查询已完成。请结束本轮，系统会自动交付结果并续接解释；不要继续轮询或在本轮推断结果。"})
                    } else {
                        json!({"query":q,"results":external})
                    }
                }
                super::query_workflow::ProtectedText::Historical { entry, conditions } => {
                    super::context_authority::merge_run_in_tx(
                        &mut tx,
                        &run.id,
                        &super::historical_analysis::carrying(&entry),
                    )
                    .await?;
                    let content = json!({"sql":q["sql"],"parameters":q["parameters"],
                        "summary":q["summary"],"semantic_resolution":q["semantic_resolution"],
                        "conditions":conditions});
                    q = super::query_workflow::control_projection(q);
                    super::historical_analysis::content_page(
                        json!({"query":q,"results":null,"historical_analysis":entry,
                            "hint":"这是保存时的SQL、原条件和说明，只用于复述当时的分析。当前口径与新执行仍需重新核对。正文按content_page.next_offset用content_offset续读。"}),
                        &content,
                        args["content_offset"].as_u64().unwrap_or(0) as usize,
                        8192,
                    )?
                }
                super::query_workflow::ProtectedText::Restricted => {
                    q = super::query_workflow::control_projection(q);
                    json!({"query":q,"results":null,"hint":"查询正文来源已失效或缺少完整记录；只返回原状态，可停止查询，不能据此确认执行或恢复旧正文。"})
                }
            }
        }
        "present_analysis_answer" | "prepare_analysis_answer" => {
            conversations::assert_routed_in_tx(&mut tx, &conv, &run.message_id).await?;
            let answer = external.as_ref().ok_or(Error::new("invalid_evidence"))?;
            let sources = super::analysis_answers::check_in_tx(
                &mut tx,
                ctx,
                &cid,
                &run.id,
                answer,
                &text_results,
            )
            .await?;
            let owner = super::task_answers::candidate_task_ref(&tool, &json!({}))?
                .ok_or(Error::new("task_context_required"))?;
            let scope =
                super::task_answers::source_scope_at_version_in_tx(&mut tx, &conv, &owner).await?;
            super::task_answers::validate_sources_in_tx(
                &mut tx,
                ctx,
                &cid,
                &scope,
                &sources,
                &text_results,
            )
            .await?;
            answer.clone()
        }
        "save_analysis_evidence" => {
            conversations::assert_routed_in_tx(&mut tx, &conv, &run.message_id).await?;
            // 依据绑定来源任务；当前消息可归属报告容器，历史来源身份由依据用例独立核对。
            let sources = external.as_ref().ok_or(Error::new("invalid_evidence"))?;
            let receipt = super::analysis_evidence::save_in_tx(
                &mut tx,
                ctx,
                &conv,
                super::analysis_evidence::EvidenceWrite {
                    operation_id: &tool.operation_id,
                    message_id: &run.message_id,
                    run_id: &run.id,
                },
                args,
                sources,
                &text_results,
            )
            .await?;
            super::context_authority::extend_run_in_tx(
                &mut tx,
                &conv,
                &run.id,
                &sources["knowledge_refs"],
            )
            .await?;
            conversations::append_event_in_tx(
                &mut tx,
                &conv,
                &id(),
                "analysis_evidence_saved",
                receipt.clone(),
            )
            .await?;
            receipt
        }
        "read_analysis_report" => {
            let checked = external.as_ref().ok_or(Error::new("invalid_evidence"))?;
            let text_authority = super::analysis_reports::assert_page_in_tx(
                &mut tx,
                ctx,
                &cid,
                args,
                checked,
                &text_results,
            )
            .await?;
            if let Some(gate) = &source_gate
                && !super::source_limits::authority_within_in_tx(
                    &mut tx,
                    ctx,
                    gate,
                    &text_authority,
                )
                .await?
            {
                return Err(Error::new("source_not_allowed"));
            }
            super::context_authority::merge_run_in_tx(&mut tx, &run.id, &text_authority).await?;
            if checked["page"]["status"] == "available" {
                super::context_authority::extend_run_in_tx(
                    &mut tx,
                    &conv,
                    &run.id,
                    &checked["sources"]["knowledge_refs"],
                )
                .await?;
                super::context_authority::extend_result_dependencies_in_tx(
                    &mut tx,
                    &conv,
                    &run.id,
                    &checked["sources"]["result_dependencies"],
                )
                .await?;
                // 回执data是页面本身（无sources字段）：报告全文的知识引用与结果
                // 依赖的平台目标在读取点按来源信封登记证据读取——查询目标经
                // 报告全文交付同样进入重核范围（04关闭审查修复，第三轮补目标
                // 折算），轮内收紧后随派发重核（切片6）。
                let mut report_targets = Vec::new();
                for reference in checked["sources"]["result_dependencies"]
                    .as_array()
                    .into_iter()
                    .flatten()
                {
                    if let Some(qid) = reference["query_id"].as_str()
                        && let Ok(query) = queries::read_in_tx(&mut tx, ctx, qid).await
                        && let Some(target) = query["target_id"].as_str()
                        && !report_targets.contains(&json!(target))
                    {
                        report_targets.push(json!(target));
                    }
                }
                super::context_authority::observe_evidence_reads_in_tx(
                    &mut tx,
                    &run.id,
                    "read_analysis_report",
                    &json!({"sources": checked["sources"], "result_targets": report_targets}),
                )
                .await?;
            }
            checked["page"].clone()
        }
        "save_analysis_report" => {
            conversations::assert_routed_in_tx(&mut tx, &conv, &run.message_id).await?;
            if !conversations::message_task_ids_in_tx(&mut tx, &conv, &run.message_id)
                .await?
                .iter()
                .any(|task| args["task_id"] == *task)
            {
                return Err(Error::new("invalid_evidence"));
            }
            let evidence = external.as_ref().ok_or(Error::new("invalid_evidence"))?;
            let receipt = super::analysis_reports::save_in_tx(
                &mut tx,
                ctx,
                &conv,
                super::analysis_reports::ReportWrite {
                    operation_id: &tool.operation_id,
                    message_id: &run.message_id,
                    model_run_id: Some(&run.id),
                },
                args,
                evidence,
                &text_results,
            )
            .await?;
            let adopted = super::analysis_reports::sources(evidence)?;
            super::context_authority::extend_run_in_tx(
                &mut tx,
                &conv,
                &run.id,
                &adopted["knowledge_refs"],
            )
            .await?;
            super::context_authority::extend_result_dependencies_in_tx(
                &mut tx,
                &conv,
                &run.id,
                &adopted["result_dependencies"],
            )
            .await?;
            conversations::append_event_in_tx(
                &mut tx,
                &conv,
                &id(),
                "analysis_report_saved",
                receipt.clone(),
            )
            .await?;
            receipt
        }
        "execute_query" => {
            let mut query = super::query_workflow::execute_from_message_in_tx(
                &mut tx,
                ctx,
                &conv,
                &run,
                &tool.operation_id,
                args,
                &text_results,
            )
            .await?;
            protect_query_result_in_tx(
                &mut tx,
                ctx,
                &conv,
                &cid,
                &run.id,
                &mut query,
                &text_results,
            )
            .await?;
            query
        }
        "prepare_skill_draft" => {
            let reference = super::skill_drafts::prepare_in_tx(
                &mut tx,
                ctx,
                &conv,
                &run,
                &tool,
                args,
                super::skill_drafts::CheckedDraftSources {
                    evidence: external.as_ref().ok_or(Error::new("invalid_evidence"))?,
                    text_results: &text_results,
                },
            )
            .await?;
            conversations::append_event_in_tx(
                &mut tx,
                &conv,
                &id(),
                "skill_draft_prepared",
                reference.clone(),
            )
            .await?;
            reference
        }
        "cancel_query" => {
            let qid = text(args, "query_id")?;
            let q = queries::read_in_tx(&mut tx, ctx, qid).await?;
            if q["conversation_id"] != cid {
                return Err(Error::new("not_available"));
            }
            let cancelled = super::query_workflow::cancel_in_tx(&mut tx, ctx, &conv, qid).await?;
            let state = cancellation_state(&cancelled);
            contracts::validate("QueryCancellation", &state)?;
            state
        }
        "manage_personal_asset" => {
            let message =
                conversations::read_message_in_tx(&mut tx, &conv, &run.message_id).await?;
            let action = text(args, "action")?;
            if !message.user_supplied {
                return Err(Error::new("scope_incomplete"));
            }
            let source_text = if action == "disable_memory" {
                None
            } else {
                Some(assets::memory_source(
                    &message.body,
                    text(args, "instruction_quote")?,
                    text(args, "scope")?,
                )?)
            };
            super::context_authority::assert_run_in_tx(&mut tx, ctx, &cid, &run.id).await?;
            let old = if action != "save_memory" {
                let asset =
                    assets::read_in_tx(&mut tx, ctx, text(args, "asset_id")?, false).await?;
                if asset["kind"] != "memory" {
                    return Err(Error::new("selection_required"));
                }
                if asset["version"] != args["expected_version"] {
                    return Err(Error::new("version_conflict"));
                }
                Some(asset)
            } else {
                None
            };
            if let Some(asset) = &old {
                super::personal_assets::ensure_field_authorities_in_tx(&mut tx, ctx, asset).await?;
            }
            let value = if action == "disable_memory" {
                assets::change_state_in_tx(&mut tx, ctx, text(args, "asset_id")?,
                    &json!({"operation_id":tool.operation_id,"expected_version":args["expected_version"]}), "disabled").await?
            } else {
                let mut dependencies = args["dependencies"]
                    .as_array()
                    .expect("validated dependencies")
                    .clone();
                // 修订提取使用旧正文，旧来源不能因新参数省略而脱离新版。
                if extracted_memory.is_some()
                    && let Some(old) = &old
                {
                    for reference in old["dependencies"].as_array().expect("asset dependencies") {
                        if !dependencies.contains(reference) {
                            dependencies.push(reference.clone());
                        }
                    }
                }
                let dependencies = json!(dependencies);
                super::knowledge::check_refs_in_tx(&mut tx, ctx, &dependencies).await?;
                let body = extracted_memory.as_deref().unwrap_or(text(args, "body")?);
                // 同一份提取保留完整限定，名称只作标签，避免另一次概括引入不同指标。
                let name: String = body.chars().take(40).collect();
                let save = json!({"operation_id":tool.operation_id,"id":args["asset_id"],"expected_version":args["expected_version"],"kind":"memory","name":name,"body":body,"scope":body,"verified":false,"source_text":source_text,"dependencies":dependencies});
                let mut authority = if extracted_memory.is_some() {
                    super::context_authority::empty()
                } else {
                    super::context_authority::generated_text_authority_in_tx(&mut tx, &run.id, args)
                        .await?
                };
                if let Some(old) = &old {
                    for source in
                        super::personal_assets::authorities_in_tx(&mut tx, ctx, old).await?
                    {
                        super::context_authority::merge(&mut authority, &source)?;
                    }
                    for kind in ["memories", "skills", "source_skills"] {
                        authority[kind]
                            .as_array_mut()
                            .expect("authority")
                            .retain(|reference| reference[0] != old["id"]);
                    }
                }
                assets::save_with_authority_in_tx(
                    &mut tx,
                    ctx,
                    &save,
                    false,
                    (extracted_memory.is_none() || old.is_some()).then_some(&authority),
                )
                .await?
            };
            super::personal_memory::queue_in_tx(
                &mut tx,
                ctx,
                &value,
                Some(&run.budget_scope_id),
                extracted_memory
                    .as_ref()
                    .map(|_| tool.operation_id.as_str()),
            )
            .await?;
            if let Some(old) = old {
                super::context_authority::record_memory_change_in_tx(
                    &mut tx, &run.id, &old, &value,
                )
                .await?;
            }
            conversations::append_event_in_tx(&mut tx, &conv, &id(),
                if action == "disable_memory" { "memory_disabled" } else { "memory_saved" },
                json!({"asset_id":value["id"],"version":value["version"],"state":value["state"],"action":action})).await?;
            if action == "disable_memory" {
                json!({"id":value["id"],"version":value["version"],"state":value["state"]})
            } else {
                retrieval::model_page(value, 0, 4096, None)
            }
        }
        "propose_semantic_change" => {
            knowledge::propose_in_tx(&mut tx, ctx, &tool.operation_id, args).await?
        }
        _ => return Err(Error::new("unsupported")),
    };
    let asset_authority = if source_identity_view {
        super::context_authority::empty()
    } else if name == "read_knowledge" && tool_contract_version == 2 {
        read_asset_authority
    } else {
        super::context_authority::asset_text_dependencies_in_tx(
            &mut tx,
            ctx,
            &cid,
            &data,
            &text_results,
        )
        .await?
    };
    if evidence_read {
        super::context_authority::merge(&mut delivery_authority, &asset_authority)?;
        super::context_authority::observe(&mut delivery_authority, &data);
        tx.commit().await?;
        tx = AppTx::begin(pool).await?;
        conv = conversations::lock_conversation_in_tx(&mut tx, ctx, &cid).await?;
        run = runtime::lock_run_in_tx(&mut tx, text(&input, "run_id")?, &cid).await?;
        let current_tool =
            runtime::lock_tool_call_in_tx(&mut tx, &run, text(&input, "sdk_tool_call_id")?)
                .await?
                .ok_or(Error::new("version_conflict"))?;
        if current_tool.fingerprint != tool.fingerprint
            || current_tool.operation_id != tool.operation_id
        {
            return Err(Error::new("idempotency_conflict"));
        }
        tool = current_tool;
        conversations::assert_turn_in_tx(
            &tx,
            &conv,
            &run.id,
            epoch(text(&input, "lease_epoch")?)?,
        )?;
        if run.state != "running" {
            return Err(Error::new("lease_lost"));
        }
        if let Some(receipt) = &tool.receipt {
            if tool.state == "succeeded" {
                super::evidence_delivery::assert_replay_in_tx(
                    &mut tx,
                    ctx,
                    &conv,
                    &run.id,
                    args,
                    receipt,
                    &text_results,
                )
                .await?;
            }
            let mut receipt =
                replay_receipt_in_tx(&mut tx, ctx, &conv, &run.id, name, &tool, &text_results)
                    .await?;
            attach_source_readiness_in_tx(
                &mut tx,
                &conv,
                &run,
                tool_contract_version,
                &mut receipt,
            )
            .await?;
            tx.commit().await?;
            return Ok(receipt);
        }
        if super::evidence_delivery::current_task_in_tx(&mut tx, &conv, None).await?
            != evidence_task
        {
            return Err(Error::new("version_conflict"));
        }
        let current_gate =
            super::source_limits::resolve_in_tx(&mut tx, &conv, &run.message_id).await?;
        if current_gate.as_ref().map(|gate| gate.receipt(0))
            != source_gate.as_ref().map(|gate| gate.receipt(0))
        {
            return Err(Error::new("source_not_allowed"));
        }
        if let Some(checked) = &checked {
            super::context_authority::assert_checked_run_in_tx(&mut tx, &run.id, checked).await?;
            super::context_authority::assert_run_in_tx(&mut tx, ctx, &cid, &run.id).await?;
        }
        super::context_authority::validate_text_in_tx(
            &mut tx,
            ctx,
            &cid,
            &delivery_authority,
            &text_results,
        )
        .await
        .map_err(|error| {
            if error.code == "stale_context" {
                Error::new("stale_knowledge")
            } else {
                error
            }
        })?;
        if let Some(gate) = &current_gate
            && !super::source_limits::authority_within_in_tx(
                &mut tx,
                ctx,
                gate,
                &delivery_authority,
            )
            .await?
        {
            return Err(Error::new("source_not_allowed"));
        }
        for asset in adopted_assets {
            assets::record_adoption_in_tx(&mut tx, ctx, &run.id, &asset, "read").await?;
        }
        super::context_authority::merge_run_in_tx(&mut tx, &run.id, &delivery_authority).await?;
    } else if !source_identity_view {
        super::context_authority::merge_run_in_tx(&mut tx, &run.id, &asset_authority).await?;
        super::context_authority::extend_run_in_tx(&mut tx, &conv, &run.id, &data).await?;
    }
    if !source_identity_view
        && matches!(
            name,
            "read_knowledge"
                | "read_source"
                | "search_knowledge"
                | "get_query"
                | "execute_query"
                | "request_query"
                | "validate_sql"
        )
    {
        // 旧查询正文、确认执行的目标、草稿与语义诊断摘要同属已交付派生内容：
        // 引用与平台目标进入证据读取清单，供轮内收紧后的派发重核（04切片6）。
        super::context_authority::observe_evidence_reads_in_tx(&mut tx, &run.id, name, &data)
            .await?;
    }
    if name == "save_analysis_evidence" {
        super::context_authority::extend_result_dependencies_in_tx(
            &mut tx,
            &conv,
            &run.id,
            &data["result_dependencies"],
        )
        .await?;
    }
    let mut receipt = json!({"operation_id":tool.operation_id,"tool_name":name,"tool_contract_version":tool.tool_contract_version,"data":data});
    if let Some(ids) = receipt["data"]
        .as_object_mut()
        .expect("tool data")
        .remove("superseded_query_ids")
    {
        receipt["superseded_query_ids"] = ids;
    }
    if matches!(name, "present_analysis_answer" | "prepare_analysis_answer") {
        receipt["answer_task_ref"] = super::task_answers::candidate_task_ref(&tool, &receipt)?
            .ok_or(Error::new("task_context_required"))?;
    }
    if matches!(name, "update_analysis_task" | "request_query") {
        let projection = super::source_limits::active_projection_in_tx(&mut tx, &conv).await?;
        let mut authority = runtime::read_authority_in_tx(&mut tx, &run.id)
            .await?
            .ok_or(Error::new("stale_context"))?;
        if super::source_limits::active_reset_required_in_tx(&mut tx, ctx, &conv, &authority)
            .await?
        {
            receipt["context_reset"] = super::source_limits::projection_baseline(&projection);
        } else {
            authority["active_task"] = super::source_limits::projection_baseline(&projection);
            runtime::save_authority_in_tx(&mut tx, &run.id, &authority).await?;
        }
    }
    if name == "update_analysis_task" && args["finalize_current_answer"] == true {
        let mut parts = super::task_answers::references_in_tx(&mut tx, &run).await?;
        parts.push(
            tool.answer_handoff
                .as_ref()
                .ok_or(Error::new("invalid_evidence"))?["reference"]
                .clone(),
        );
        receipt["answer_parts"] = json!(parts);
    }
    // 本次定稿的handoff尚未落为succeeded，控制投影按工具行上的原引用计入冻结项。
    let just_frozen = if name == "update_analysis_task" && args["finalize_current_answer"] == true {
        tool.answer_handoff.as_ref()
    } else {
        None
    };
    if run.tool_contract_version == 2
        && matches!(
            name,
            "update_analysis_task" | "request_query" | "execute_query"
        )
    {
        // 只有会改变任务/查询控制状态的工具才回传宿主投影，普通检索不重复计算。
        // 控制投影与control_delivery_ref提交属v2合同；v1兼容交付没有该提交路径，
        // 回传只会让Node走进被compose拒绝的控制分支（快照与compose同样按v2门控）。
        let delivery = super::task_answers::control_delivery_in_tx(
            &mut tx,
            ctx,
            &conv,
            &run,
            &text_results,
            just_frozen,
        )
        .await?;
        receipt["control_delivery"] = delivery.control_delivery.unwrap_or(Value::Null);
        receipt["frozen_notification_covered"] = json!(delivery.frozen_notification_covered);
    }
    attach_source_readiness_in_tx(&mut tx, &conv, &run, tool_contract_version, &mut receipt)
        .await?;
    contracts::validate("DataToolOutcome", &receipt)?;
    if tool.state == "registered" {
        runtime::record_tool_receipt_in_tx(&mut tx, &tool, &receipt).await?;
    }
    tx.commit().await?;
    Ok(receipt)
}

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
            "本条输入尚缺有效任务归属或资料范围裁决。先按受控任务目录或本回执recovery.task中的task_id/condition_version核对目标。已有任务用update_analysis_task（action=route，task_id取该目标，expected_version取condition_version，options=[]）登记本条输入；目标或范围确需修改时用revise，新目标才create。等待必要的宿主刷新，仅在回执或刷新确认source_context_ready=true后继续原请求；route成功本身不够。执行已有SQL应先get_query核对该query的SQL、参数和版本，再execute_query；需要条件或依据时按当前范围补读，不重造草稿或无故改为澄清。继承原许可，来源仍未知不能自动补source_limits=null或扩大范围；新任务确无额外来源限制才显式声明null。"
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
        let mut task = args["task_id"].as_str().map(str::to_owned);
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
    let result = execute(pool, ctx, input.clone()).await;
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
        let cid = runtime::locate_run(pool, text(&input, "run_id")?).await?;
        // 目标正文失效可以明确拒绝；运行本身已失权时仍交给原恢复链重建。
        let checked_run = if error.code == "stale_context" {
            Some(
                super::context_authority::check_run_results(pool, ctx, text(&input, "run_id")?)
                    .await?,
            )
        } else {
            None
        };
        let mut text_results = if matches!(
            input["tool_name"].as_str(),
            Some("update_analysis_task" | "request_query" | "execute_query")
        ) {
            super::context_authority::check_task_text_results(pool, ctx, &cid, None).await?
        } else {
            super::context_authority::CheckedTextResults::default()
        };
        if matches!(
            input["tool_name"].as_str(),
            Some("request_query" | "execute_query")
        ) {
            let mut tx = AppTx::begin(pool).await?;
            let authorities = queries::text_authorities_in_tx(
                &mut tx,
                ctx,
                &cid,
                input["arguments"]["query_id"].as_str(),
            )
            .await?;
            tx.commit().await?;
            text_results
                .include_authorities(pool, ctx, &authorities)
                .await?;
        }
        if input["tool_name"] == "manage_personal_asset" {
            let checked =
                super::context_authority::check_available_asset_results(pool, ctx, &cid).await?;
            text_results.include_checked(&checked);
        }
        let mut tx = AppTx::begin(pool).await?;
        let conv = conversations::lock_conversation_in_tx(&mut tx, ctx, &cid).await?;
        conversations::assert_turn_in_tx(
            &tx,
            &conv,
            text(&input, "run_id")?,
            epoch(text(&input, "lease_epoch")?)?,
        )?;
        let run = runtime::lock_run_in_tx(&mut tx, text(&input, "run_id")?, &cid).await?;
        if let Some(checked) = &checked_run {
            super::context_authority::assert_checked_run_in_tx(&mut tx, &run.id, checked).await?;
            super::context_authority::assert_run_in_tx(&mut tx, ctx, &cid, &run.id).await?;
        }
        if let Some(tool) =
            runtime::lock_tool_call_in_tx(&mut tx, &run, text(&input, "sdk_tool_call_id")?).await?
            && tool.fingerprint
                == fingerprint(&json!({"name":input["tool_name"],"arguments":input["arguments"]}))
        {
            if error.code == "unavailable"
                && can_replay_receipt(text(&input, "tool_name")?)
                && tool.receipt.is_some()
            {
                // 已提交操作接回原结果；只读工具必须保留本次回源核验失败。
                let mut receipt = replay_receipt_in_tx(
                    &mut tx,
                    ctx,
                    &conv,
                    &run.id,
                    text(&input, "tool_name")?,
                    &tool,
                    &text_results,
                )
                .await?;
                attach_source_readiness_in_tx(
                    &mut tx,
                    &conv,
                    &run,
                    tool.tool_contract_version,
                    &mut receipt,
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

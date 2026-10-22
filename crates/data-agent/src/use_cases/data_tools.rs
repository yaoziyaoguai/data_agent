use crate::{
    contracts,
    modules::{analysis, assets, conversations, knowledge, queries, retrieval, runtime},
    persistence::AppTx,
    search_scope::KnowledgeSearchScope,
    types::{AccessContext, Error, Result, epoch, fingerprint, id},
};
use serde_json::{Value, json};
use sqlx::MySqlPool;
fn input_schema(name: &str) -> Result<&'static str> {
    Ok(match name {
        "search_knowledge" => "SearchInput",
        "read_knowledge" => "ReadKnowledgeInput",
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
async fn request_condition_authority_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    args: &Value,
    checked: &super::context_authority::CheckedTextResults,
) -> Result<Value> {
    super::knowledge::check_refs_in_tx(tx, ctx, &args["knowledge_refs"]).await?;
    analysis::lock_tasks_in_tx(tx, cid).await?;
    let task = text(args, "task_id")?;
    let version = epoch(text(args, "condition_version")?)?;
    analysis::assert_current_in_tx(tx, cid, task, version).await?;
    if conversations::confirmation_blocked_in_tx(tx, cid).await? {
        return Err(Error::new("message_pending"));
    }
    let conditions = analysis::read_evidence_conditions_in_tx(tx, ctx, cid, task, version).await?;
    super::context_authority::validate_condition_text_in_tx(
        tx,
        ctx,
        cid,
        task,
        version,
        &conditions,
        checked,
    )
    .await
}

async fn semantic_diagnostics_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    args: &Value,
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
            Ok(()) => valid.push(object),
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
    let report = queries::check_semantics(text(args, "sql")?, &args["parameters"], &snapshot);
    contracts::validate("SemanticCheckReport", &report)?;
    Ok(report)
}
fn replay_receipt(name: &str, mut receipt: Value) -> Result<Value> {
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
    cid: &str,
    run_id: &str,
    result: &mut Value,
    text_results: &super::context_authority::CheckedTextResults,
) -> Result<()> {
    let refs =
        super::context_authority::protect_task_context_in_tx(tx, ctx, cid, result, text_results)
            .await?;
    super::context_authority::merge_run_in_tx(tx, run_id, &refs).await?;
    Ok(())
}
async fn protect_query_result_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
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
    cid: &str,
    run_id: &str,
    name: &str,
    receipt: Value,
    text_results: &super::context_authority::CheckedTextResults,
) -> Result<Value> {
    let mut receipt = replay_receipt(name, receipt)?;
    if matches!(name, "request_query" | "execute_query") {
        protect_query_result_in_tx(tx, ctx, cid, run_id, &mut receipt["data"], text_results)
            .await?;
    }
    if name == "update_analysis_task" {
        protect_update_result_in_tx(tx, ctx, cid, run_id, &mut receipt["data"], text_results)
            .await?;
        super::context_authority::extend_run_in_tx(tx, run_id, &receipt["data"]).await?;
    }
    if name == "present_analysis_answer" && receipt["data"]["error"].is_null() {
        super::analysis_answers::check_in_tx(tx, ctx, cid, run_id, &receipt["data"], text_results)
            .await?;
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
                super::context_authority::extend_run_in_tx(tx, run_id, &receipt["data"]).await?;
            }
            Err(error) if super::personal_assets::unavailable_text(&error) => {
                receipt["data"] = json!({"id":data["id"],"version":data["version"],"state":current["state"],"text_unavailable":true});
            }
            Err(error) => return Err(error),
        }
    }
    Ok(receipt)
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
    let receipt = tool.receipt.ok_or(Error::new("not_available"))?;
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
    let operation = if let Some(tool) =
        runtime::lock_tool_call_in_tx(&mut tx, &run, text(&input, "sdk_tool_call_id")?).await?
    {
        if tool.fingerprint != fp {
            return Err(Error::new("idempotency_conflict"));
        }
        if contracts::validate(input_schema(name)?, &input["arguments"]).is_err()
            && !(matches!(tool.state.as_str(), "succeeded" | "rejected") && tool.receipt.is_some())
        {
            // 已登记且没有完成回执，不能把升级后的参数拒绝说成从未执行。
            return Err(Error::new("outcome_unknown"));
        }
        tool.operation_id
    } else {
        // 新动作仍按当前契约校验；旧映射只凭原参数指纹接回。
        contracts::validate(input_schema(name)?, &input["arguments"])?;
        runtime::register_named_tool_in_tx(
            &mut tx,
            &run,
            text(&input, "sdk_tool_call_id")?,
            &fp,
            name,
        )
        .await?
    };
    runtime::save_checkpoint_in_tx(&mut tx, &run, &input["checkpoint"]).await?;
    tx.commit().await?;
    Ok(json!({"operation_id":operation}))
}
async fn execute(pool: &MySqlPool, ctx: &AccessContext, input: Value) -> Result<Value> {
    contracts::validate("DataToolInvocation", &input)?;
    let name = text(&input, "tool_name")?;
    let args = &input["arguments"];
    let validation = contracts::validate(input_schema(name)?, args);
    let cid = runtime::locate_run(pool, text(&input, "run_id")?).await?;
    // 答案回放也要查证原结果，不能通过已有成功回执恢复已撤权的正文。
    let answer_checked = if name == "present_analysis_answer" {
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
        "request_query" | "get_query" | "execute_query" | "present_analysis_answer"
    ) {
        let mut tx = AppTx::begin(pool).await?;
        let authorities =
            queries::text_authorities_in_tx(&mut tx, ctx, &cid, args["query_id"].as_str()).await?;
        tx.commit().await?;
        text_results
            .include_authorities(pool, ctx, &authorities)
            .await?;
    }
    if matches!(
        name,
        "search_knowledge" | "read_knowledge" | "read" | "manage_personal_asset"
    ) {
        let checked =
            super::context_authority::check_available_asset_results(pool, ctx, &cid).await?;
        text_results.include_checked(&checked);
    }
    // 原回执不按新参数契约重判；读取工具仍须回源，未知操作不能变成新拒绝。
    if can_replay_receipt(name) || validation.is_err() {
        let mut tx = AppTx::begin(pool).await?;
        let conv = conversations::lock_conversation_in_tx(&mut tx, ctx, &cid).await?;
        conversations::assert_turn_in_tx(
            &tx,
            &conv,
            text(&input, "run_id")?,
            epoch(text(&input, "lease_epoch")?)?,
        )?;
        let run = runtime::lock_run_in_tx(&mut tx, text(&input, "run_id")?, &cid).await?;
        if let Some(checked) = &answer_checked {
            super::context_authority::assert_checked_run_in_tx(&mut tx, &run.id, checked).await?;
        }
        if let Some(tool) =
            runtime::lock_tool_call_in_tx(&mut tx, &run, text(&input, "sdk_tool_call_id")?).await?
        {
            if tool.fingerprint != fingerprint(&json!({"name":name,"arguments":args})) {
                return Err(Error::new("idempotency_conflict"));
            }
            if let Some(receipt) = tool.receipt
                && (tool.state == "rejected"
                    || (tool.state == "succeeded" && can_replay_receipt(name)))
            {
                let receipt =
                    replay_receipt_in_tx(&mut tx, ctx, &cid, &run.id, name, receipt, &text_results)
                        .await?;
                tx.commit().await?;
                return Ok(receipt);
            }
            if validation.is_err() {
                return Err(Error::new("outcome_unknown"));
            }
        }
        if name == "request_query" && validation.is_ok() {
            let message =
                conversations::read_message_in_tx(&mut tx, &conv, &run.message_id).await?;
            super::query_semantics::validate_resolution(
                args,
                &message.body,
                message.user_supplied,
            )?;
        }
        tx.commit().await?;
    }
    validation?;
    // 停止动作只返回控制状态；旧结果失效不能剥夺当前用户停止本人查询的能力。
    let checked = if name == "cancel_query" {
        None
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
        if let Some(receipt) = tool.receipt
            && name == "request_query"
        {
            let receipt =
                replay_receipt_in_tx(&mut tx, ctx, &cid, &run.id, name, receipt, &text_results)
                    .await?;
            tx.commit().await?;
            return Ok(receipt);
        }
        if name == "request_query" {
            request_condition_authority_in_tx(&mut tx, ctx, &cid, args, &text_results).await?;
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
            }
        }
        tx.commit().await?;
    }
    // 模型检查和结果读取在业务事务外；写入时重新校验运行及当前权限。
    let external = match name {
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
    let (memory_candidates, memory_retrieval) =
        super::personal_memory::search(pool, ctx, &input).await;
    let scope = if name == "search_knowledge" {
        KnowledgeSearchScope::from_input(args)?
    } else {
        KnowledgeSearchScope::default()
    };
    let vector = if name == "search_knowledge" {
        if let Some(anchor) = &scope.anchor {
            let mut tx = AppTx::begin(pool).await?;
            let object = knowledge::read_in_tx(&mut tx, ctx, anchor, None, false).await?;
            super::knowledge::assert_source_in_tx(&mut tx, ctx, &object).await?;
            tx.commit().await?;
        }
        super::knowledge_embeddings::search_scoped(
            pool,
            ctx,
            text(args, "query")?,
            Some(&input),
            &scope,
        )
        .await
    } else {
        retrieval::vector::Candidates::lexical()
    };
    let mut tx = AppTx::begin(pool).await?;
    let conv = conversations::lock_conversation_in_tx(&mut tx, ctx, &cid).await?;
    let run = runtime::lock_run_in_tx(&mut tx, text(&input, "run_id")?, &cid).await?;
    let tool = runtime::lock_tool_call_in_tx(&mut tx, &run, text(&input, "sdk_tool_call_id")?)
        .await?
        .ok_or(Error::new("version_conflict"))?;
    if tool.fingerprint != fingerprint(&json!({"name":name,"arguments":args})) {
        return Err(Error::new("idempotency_conflict"));
    }
    conversations::assert_turn_in_tx(&tx, &conv, &run.id, epoch(text(&input, "lease_epoch")?)?)?;
    if run.state != "running" {
        return Err(Error::new("lease_lost"));
    }
    if let Some(checked) = &checked {
        super::context_authority::assert_checked_run_in_tx(&mut tx, &run.id, checked).await?;
        super::context_authority::assert_run_in_tx(&mut tx, ctx, &cid, &run.id).await?;
    }
    if let Some(receipt) = &tool.receipt
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
        let receipt = replay_receipt_in_tx(
            &mut tx,
            ctx,
            &cid,
            &run.id,
            name,
            receipt.clone(),
            &text_results,
        )
        .await?;
        tx.commit().await?;
        return Ok(receipt);
    }
    let data = match name {
        "search_knowledge" => {
            let search = super::knowledge::retrieve_scoped_in_tx(
                &mut tx,
                ctx,
                text(args, "query")?,
                args["limit"].as_u64().unwrap_or(10) as usize,
                &vector,
                &scope,
            )
            .await?;
            let memories = assets::list_in_tx(&mut tx, ctx, true)
                .await?
                .into_iter()
                .filter(|v| v["kind"] == "memory")
                .collect();
            let mut items =
                super::knowledge::valid_assets_in_tx(&mut tx, ctx, memories, &cid, &text_results)
                    .await?;
            let selected = assets::selected_in_tx(&mut tx, ctx, &cid).await?;
            items.extend(
                super::knowledge::valid_assets_in_tx(&mut tx, ctx, selected, &cid, &text_results)
                    .await?,
            );
            let mut page = retrieval::asset_directory(
                items.clone(),
                text(args, "query")?,
                args["asset_after"].as_str(),
                args["limit"].as_u64().unwrap_or(10) as usize,
            );
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
            retrieval::bounded_search_reply(
                json!({"objects":search.objects.into_iter().map(|object|retrieval::search_preview(object,text(args,"query").unwrap_or(""))).collect::<Vec<_>>(),"search_coverage":search.coverage,"search_scope":{"kinds":scope.kinds,"related_object_id":scope.anchor,"business_domain":scope.domain},"personal_memories":page["memories"],"selected_skills":page["selected_skills"],"next_asset_after":page["next_asset_after"],"asset_total":page["total"],"asset_cursor_invalid":page["cursor_invalid"]==true,"memory_retrieval":memory_retrieval,"retrieval_mode":if vector.state=="available"{"hybrid_authoritative"}else{"lexical_authoritative"},"note":"命中已回源。search_scope是本次检索范围；空结果只表示此范围未找到资料，不证明全空间不存在。search_coverage.state=candidate_limit或bounded表示只检查了有界候选或部分索引，空结果不能证明不存在；可在用户限定范围内改写或按已知ID读取，扩大用户明确范围须先征得同意。reply_coverage与omitted_objects说明回执裁剪，正文按同版entry_id/offset补读。个人记忆是查证线索；Skill仅列出本会话已选当前版本。query=*可分页查看本人有效资产目录，按next_asset_after继续；记忆正文用read_knowledge，Skill用read按行续读。"}),
            )
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
                let v = knowledge::read_in_tx(
                    &mut tx,
                    ctx,
                    object,
                    args["version"].as_str().map(epoch).transpose()?,
                    false,
                )
                .await?;
                super::knowledge::assert_source_in_tx(&mut tx, ctx, &v).await?;
                if let Some(entry_id) = args["entry_id"].as_str()
                    && !v["entries"]
                        .as_array()
                        .is_some_and(|es| es.iter().any(|e| e["entry_id"] == entry_id))
                {
                    return Err(Error::new("not_available"));
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
                &cid,
                &run.id,
                text(args, "path")?,
                &text_results,
            )
            .await?
        }
        "read_source" => {
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
            let mut task = analysis::read_task_with_clarifications_in_tx(
                &mut tx,
                &cid,
                text(args, "task_id")?,
                args["clarification_after"].as_str(),
                args["condition_version"].as_str().map(epoch).transpose()?,
            )
            .await?;
            let refs = super::context_authority::protect_task_context_in_tx(
                &mut tx,
                ctx,
                &cid,
                &mut task,
                &text_results,
            )
            .await?;
            super::context_authority::merge_run_in_tx(&mut tx, &run.id, &refs).await?;
            task
        }
        "read_conversation" => {
            if args["task_directory"] == true {
                let mut directory =
                    analysis::task_directory_in_tx(&mut tx, &cid, args["task_after"].as_str())
                        .await?;
                for task in directory["tasks"]
                    .as_array_mut()
                    .ok_or(Error::new("invalid_input"))?
                {
                    let refs = super::context_authority::protect_task_context_in_tx(
                        &mut tx,
                        ctx,
                        &cid,
                        task,
                        &text_results,
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
            result["semantic_checks"] = semantic_diagnostics_in_tx(&mut tx, ctx, args).await?;
            result
        }
        "update_analysis_task" => {
            let text_authority =
                super::context_authority::generated_text_authority_in_tx(&mut tx, &run.id, args)
                    .await?;
            let message =
                conversations::read_message_in_tx(&mut tx, &conv, &run.message_id).await?;
            // 只豁免真实用户完整原话；结果唤醒消息和模型自报引用不能授予独立来源。
            let goal_authority =
                if message.user_supplied && args["goal"].as_str() == Some(message.body.as_str()) {
                    super::context_authority::empty()
                } else {
                    text_authority.clone()
                };
            let tasks = analysis::lock_tasks_in_tx(&mut tx, &cid).await?;
            let mut result = analysis::apply_update_in_tx(
                &mut tx,
                &tasks,
                &ctx.user_id,
                &tool.operation_id,
                args,
                &analysis::TaskTextAuthority {
                    generated: text_authority,
                    goal: goal_authority,
                    cleared: super::context_authority::empty(),
                },
            )
            .await?;
            if result["conditions"].is_object() {
                super::knowledge::check_refs_in_tx(
                    &mut tx,
                    ctx,
                    &result["conditions"]["knowledge_refs"],
                )
                .await?;
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
            protect_update_result_in_tx(&mut tx, ctx, &cid, &run.id, &mut result, &text_results)
                .await?;
            if (args["action"] == "revise" || args["action"] == "clarify")
                && let Some(task) = result["task_id"].as_str()
            {
                queries::supersede_in_tx(&mut tx, &cid, task).await?;
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
            let condition_authority =
                request_condition_authority_in_tx(&mut tx, ctx, &cid, args, &text_results).await?;
            let mut text_authority =
                super::context_authority::generated_text_authority_in_tx(&mut tx, &run.id, args)
                    .await?;
            super::context_authority::merge(&mut text_authority, &condition_authority)?;
            let report = semantic_diagnostics_in_tx(&mut tx, ctx, args).await?;
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
            let authority = super::query_workflow::protect_text_in_tx(
                &mut tx,
                ctx,
                &cid,
                &mut q,
                &text_results,
            )
            .await?;
            super::context_authority::merge_run_in_tx(&mut tx, &run.id, &authority).await?;
            if q["text_unavailable"] == true {
                json!({"query":q,"results":null,"hint":"查询正文来源已失效或缺少完整记录；只返回原状态，可停止查询，不能据此确认执行或恢复旧正文。"})
            } else if q["execution_state"] == "succeeded"
                && queries::is_confirmation_message_in_tx(&mut tx, ctx, qid, &run.message_id)
                    .await?
            {
                // 快查询也只在已有的结果交付轮解释，避免执行轮与结果通知重复作答。
                json!({"query":q,"results":null,"hint":"本消息刚提交的查询已完成。请结束本轮，系统会自动交付结果并续接解释；不要继续轮询或在本轮推断结果。"})
            } else {
                json!({"query":q,"results":external})
            }
        }
        "present_analysis_answer" => {
            conversations::assert_routed_in_tx(&mut tx, &conv, &run.message_id).await?;
            let answer = external.as_ref().ok_or(Error::new("invalid_evidence"))?;
            super::analysis_answers::check_in_tx(
                &mut tx,
                ctx,
                &cid,
                &run.id,
                answer,
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
                &cid,
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
            super::context_authority::merge_run_in_tx(&mut tx, &run.id, &text_authority).await?;
            if checked["page"]["status"] == "available" {
                super::context_authority::extend_run_in_tx(
                    &mut tx,
                    &run.id,
                    &checked["sources"]["knowledge_refs"],
                )
                .await?;
                super::context_authority::extend_result_dependencies_in_tx(
                    &mut tx,
                    &run.id,
                    &checked["sources"]["result_dependencies"],
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
                &cid,
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
                &run.id,
                &adopted["knowledge_refs"],
            )
            .await?;
            super::context_authority::extend_result_dependencies_in_tx(
                &mut tx,
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
            protect_query_result_in_tx(&mut tx, ctx, &cid, &run.id, &mut query, &text_results)
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
                super::knowledge::check_refs_in_tx(&mut tx, ctx, &args["dependencies"]).await?;
                let body = extracted_memory.as_deref().unwrap_or(text(args, "body")?);
                // 同一份提取保留完整限定，名称只作标签，避免另一次概括引入不同指标。
                let name: String = body.chars().take(40).collect();
                let save = json!({"operation_id":tool.operation_id,"id":args["asset_id"],"expected_version":args["expected_version"],"kind":"memory","name":name,"body":body,"scope":body,"verified":false,"source_text":source_text,"dependencies":args["dependencies"]});
                let mut authority = super::context_authority::generated_text_authority_in_tx(
                    &mut tx, &run.id, args,
                )
                .await?;
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
                    extracted_memory.is_none().then_some(&authority),
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
    let asset_authority = super::context_authority::asset_text_dependencies_in_tx(
        &mut tx,
        ctx,
        &cid,
        &data,
        &text_results,
    )
    .await?;
    super::context_authority::merge_run_in_tx(&mut tx, &run.id, &asset_authority).await?;
    super::context_authority::extend_run_in_tx(&mut tx, &run.id, &data).await?;
    if name == "save_analysis_evidence" {
        super::context_authority::extend_result_dependencies_in_tx(
            &mut tx,
            &run.id,
            &data["result_dependencies"],
        )
        .await?;
    }
    let receipt = json!({"operation_id":tool.operation_id,"tool_name":name,"data":data});
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
        (_, "waiting_clarification") => {
            "任务条件版本正确，但仍有未回答问题，本次未生成或执行查询。先用read_analysis_task读取开放问题；只有本轮原话确实回答了某项，才用revise及resolved_clarification_ids合并该回答。解释选项或未回答不等于接受，其他问题必须保留。解决全部阻塞后，可在原话明确授权仍覆盖当前SQL时继续，不必重复请求同一授权。"
        }
        (_, "clarification_required") => {
            "已声明的口径仍有未决差异，本次未编译、保存或替换查询。先用update_analysis_task的clarify把独立问题登记到任务；只有用户真实回答后再修订条件并解决对应问题。与waiting_clarification不同，这些差异尚未登记，不能把自己的假设当作用户采用。"
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
    if let Err(error) = &result
        && matches!(
            error.code,
            "invalid_input"
                | "skill_line_too_long"
                | "not_available"
                | "forbidden"
                | "selection_required"
                | "scope_incomplete"
                | "memory_unavailable"
                | "memory_extraction_empty"
                | "memory_operation_unknown"
                | "stale_knowledge"
                | "stale_context"
                | "version_conflict"
                | "waiting_clarification"
                | "clarification_required"
                | "task_inactive"
                | "clarification_not_open"
                | "invalid_evidence"
                | "message_pending"
                | "unsupported"
                | "sql_not_supported"
                | "unavailable"
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
        let mut text_results = if input["tool_name"] == "update_analysis_task" {
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
                && let Some(receipt) = &tool.receipt
            {
                // 已提交操作接回原结果；只读工具必须保留本次回源核验失败。
                let receipt = replay_receipt_in_tx(
                    &mut tx,
                    ctx,
                    &cid,
                    &run.id,
                    text(&input, "tool_name")?,
                    receipt.clone(),
                    &text_results,
                )
                .await?;
                tx.commit().await?;
                return Ok(receipt);
            }
            if tool.state == "registered" {
                let data = rejection_data_in_tx(&mut tx, ctx, &conv, &run, &input, error).await?;
                let receipt = json!({"operation_id":tool.operation_id,"tool_name":input["tool_name"],"data":data});
                runtime::reject_tool_in_tx(&mut tx, &tool, &receipt).await?;
            }
        }
        tx.commit().await?;
    }
    result
}

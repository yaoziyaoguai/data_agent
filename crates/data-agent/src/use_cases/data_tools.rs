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
fn can_replay_receipt(name: &str) -> bool {
    matches!(
        name,
        "request_query"
            | "execute_query"
            | "validate_sql"
            | "update_analysis_task"
            | "manage_personal_asset"
            | "propose_semantic_change"
            | "cancel_query"
            | "save_analysis_evidence"
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
                tx.commit().await?;
                return replay_receipt(name, receipt);
            }
            if validation.is_err() {
                return Err(Error::new("outcome_unknown"));
            }
        }
        tx.commit().await?;
    }
    validation?;
    if name == "request_query"
        && let Some(replaced) = args["replaces_query_id"].as_str()
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
        let tool = runtime::lock_tool_call_in_tx(&mut tx, &run, text(&input, "sdk_tool_call_id")?)
            .await?
            .ok_or(Error::new("version_conflict"))?;
        if tool.fingerprint != fingerprint(&json!({"name":name,"arguments":args})) {
            return Err(Error::new("idempotency_conflict"));
        }
        if let Some(receipt) = tool.receipt {
            tx.commit().await?;
            return replay_receipt(name, receipt);
        }
        analysis::lock_tasks_in_tx(&mut tx, &cid).await?;
        analysis::assert_current_in_tx(
            &mut tx,
            &cid,
            text(args, "task_id")?,
            epoch(text(args, "condition_version")?)?,
        )
        .await?;
        super::knowledge::check_refs_in_tx(&mut tx, ctx, &args["knowledge_refs"]).await?;
        // 在外部编译检查前失效明确被纠正的旧稿；检查失败也不能恢复旧确认权。
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
        tx.commit().await?;
    }
    // 停止动作只返回控制状态；旧结果失效不能剥夺当前用户停止本人查询的能力。
    let checked = if name == "cancel_query" {
        None
    } else {
        Some(super::context_authority::check_run_results(pool, ctx, text(&input, "run_id")?).await?)
    };
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
                    match super::query_workflow::results(pool, ctx, qid, args["cursor"].as_str())
                        .await
                    {
                        Ok(v) => Some(v),
                        Err(e) => Some(json!({"error":e.code})),
                    }
                }
            } else {
                None
            }
        }
        "save_analysis_evidence" => Some(
            super::analysis_evidence::validate_sources(
                pool,
                ctx,
                &cid,
                &runtime::locate_run_message(pool, text(&input, "run_id")?).await?,
                args,
            )
            .await?,
        ),
        "save_analysis_report" => {
            Some(super::analysis_reports::validate_sources(pool, ctx, &cid, args).await?)
        }
        "read_analysis_report" => {
            Some(super::analysis_reports::read_for_agent(pool, ctx, &cid, args).await?)
        }
        "prepare_skill_draft" => Some(
            super::skill_drafts::validate_sources(
                pool,
                ctx,
                &cid,
                &runtime::locate_run_message(pool, text(&input, "run_id")?).await?,
                args,
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
            ))
    {
        tx.commit().await?;
        return replay_receipt(name, receipt.clone());
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
            let mut items = super::knowledge::valid_assets_in_tx(&mut tx, ctx, memories).await?;
            let selected = assets::selected_in_tx(&mut tx, ctx, &cid).await?;
            items.extend(super::knowledge::valid_assets_in_tx(&mut tx, ctx, selected).await?);
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
                json!({"objects":search.objects.into_iter().map(|object|retrieval::search_preview(object,text(args,"query").unwrap_or(""))).collect::<Vec<_>>(),"search_coverage":search.coverage,"search_scope":{"kinds":scope.kinds,"related_object_id":scope.anchor,"business_domain":scope.domain},"personal_memories":page["memories"],"selected_skills":page["selected_skills"],"next_asset_after":page["next_asset_after"],"asset_total":page["total"],"asset_cursor_invalid":page["cursor_invalid"]==true,"memory_retrieval":memory_retrieval,"retrieval_mode":if vector.state=="available"{"hybrid_authoritative"}else{"lexical_authoritative"},"note":"命中已回源。search_scope是本次检索范围；空结果只表示此范围未找到资料，不证明全空间不存在。search_coverage.state=candidate_limit或bounded表示只检查了有界候选或部分索引，空结果不能证明不存在；请调整范围或按已知ID读取。reply_coverage与omitted_objects说明回执裁剪，正文按同版entry_id/offset补读。个人记忆是查证线索；Skill仅列出本会话已选当前版本。query=*可分页查看本人有效资产目录，按next_asset_after继续；记忆正文用read_knowledge，Skill用read按行续读。"}),
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
            let task = analysis::read_task_in_tx(&mut tx, &cid, text(args, "task_id")?).await?;
            super::knowledge::check_refs_in_tx(&mut tx, ctx, &task["conditions"]["knowledge_refs"])
                .await?;
            task
        }
        "read_conversation" => {
            if args["task_directory"] == true {
                analysis::task_directory_in_tx(&mut tx, &cid, args["task_after"].as_str()).await?
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
            let tasks = analysis::lock_tasks_in_tx(&mut tx, &cid).await?;
            let result = analysis::apply_update_in_tx(
                &mut tx,
                &tasks,
                &ctx.user_id,
                &tool.operation_id,
                args,
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
            super::knowledge::check_refs_in_tx(&mut tx, ctx, &args["knowledge_refs"]).await?;
            analysis::lock_tasks_in_tx(&mut tx, &cid).await?;
            analysis::assert_current_in_tx(
                &mut tx,
                &cid,
                text(args, "task_id")?,
                epoch(text(args, "condition_version")?)?,
            )
            .await?;
            if conversations::confirmation_blocked_in_tx(&mut tx, &cid).await? {
                return Err(Error::new("message_pending"));
            }
            let report = semantic_diagnostics_in_tx(&mut tx, ctx, args).await?;
            let mut result = queries::save_draft_in_tx(
                &mut tx,
                ctx,
                &cid,
                &run.budget_scope_id,
                &tool.operation_id,
                args,
                external.as_ref().ok_or(Error::new("unavailable"))?,
            )
            .await?;
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
            let q = queries::read_in_tx(&mut tx, ctx, qid).await?;
            if q["conversation_id"] != cid {
                return Err(Error::new("not_available"));
            }
            super::knowledge::check_refs_in_tx(&mut tx, ctx, &q["knowledge_refs"]).await?;
            if q["execution_state"] == "succeeded"
                && queries::is_confirmation_message_in_tx(&mut tx, ctx, qid, &run.message_id)
                    .await?
            {
                // 快查询也只在已有的结果交付轮解释，避免执行轮与结果通知重复作答。
                json!({"query":q,"results":null,"hint":"本消息刚提交的查询已完成。请结束本轮，系统会自动交付结果并续接解释；不要继续轮询或在本轮推断结果。"})
            } else {
                json!({"query":q,"results":external})
            }
        }
        "save_analysis_evidence" => {
            conversations::assert_routed_in_tx(&mut tx, &conv, &run.message_id).await?;
            if !conversations::message_task_ids_in_tx(&mut tx, &conv, &run.message_id)
                .await?
                .iter()
                .any(|task| args["task_id"] == *task)
            {
                return Err(Error::new("invalid_evidence"));
            }
            let sources = external.as_ref().ok_or(Error::new("invalid_evidence"))?;
            let receipt = super::analysis_evidence::save_in_tx(
                &mut tx,
                ctx,
                &cid,
                &tool.operation_id,
                &run.message_id,
                args,
                sources,
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
            super::analysis_reports::assert_page_in_tx(&mut tx, ctx, &cid, args, checked).await?;
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
                &tool.operation_id,
                &run.message_id,
                args,
                evidence,
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
            super::query_workflow::execute_from_message_in_tx(
                &mut tx,
                ctx,
                &conv,
                &run,
                &tool.operation_id,
                args,
            )
            .await?
        }
        "prepare_skill_draft" => {
            super::skill_drafts::prepare_in_tx(
                &mut tx,
                ctx,
                &conv,
                &run,
                &tool,
                args,
                external.as_ref().ok_or(Error::new("invalid_evidence"))?,
            )
            .await?
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
            let value = if action == "disable_memory" {
                assets::change_state_in_tx(&mut tx, ctx, text(args, "asset_id")?,
                    &json!({"operation_id":tool.operation_id,"expected_version":args["expected_version"]}), "disabled").await?
            } else {
                super::knowledge::check_refs_in_tx(&mut tx, ctx, &args["dependencies"]).await?;
                let body = extracted_memory.as_deref().unwrap_or(text(args, "body")?);
                // 同一份提取保留完整限定，名称只作标签，避免另一次概括引入不同指标。
                let name: String = body.chars().take(40).collect();
                let save = json!({"operation_id":tool.operation_id,"id":args["asset_id"],"expected_version":args["expected_version"],"kind":"memory","name":name,"body":body,"scope":body,"verified":false,"source_text":source_text,"dependencies":args["dependencies"]});
                assets::save_in_tx(&mut tx, ctx, &save).await?
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
                json!({"asset_id":value["id"],"version":value["version"],"scope":value["scope"],"action":action})).await?;
            retrieval::model_page(value, 0, 4096, None)
        }
        "propose_semantic_change" => {
            knowledge::propose_in_tx(&mut tx, ctx, &tool.operation_id, args).await?
        }
        _ => return Err(Error::new("unsupported")),
    };
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
                | "version_conflict"
                | "invalid_evidence"
                | "message_pending"
                | "unsupported"
                | "sql_not_supported"
                | "unavailable"
        )
    {
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
                tx.commit().await?;
                return replay_receipt(text(&input, "tool_name")?, receipt.clone());
            }
            if tool.state == "registered" {
                let receipt = json!({"operation_id":tool.operation_id,"tool_name":input["tool_name"],"data":{"error":error.code,"hint":if error.code=="scope_incomplete"{"instruction_quote必须逐字包含完整指令起点（例如‘请记住：’），不能只引用冒号后的偏好。请对照本条用户原话修正引用；若含仅本次或不要保存，不得写入长期记忆。"}else if error.code=="skill_line_too_long"{"此Skill有单行超过50KiB，请让维护者在网页中分行后保存，再重新选用；本次未读取正文。"}else{"本次操作没有成功保存；请按错误原因处理，不能告知已记住。"}}});
                runtime::reject_tool_in_tx(&mut tx, &tool, &receipt).await?;
            }
        }
        tx.commit().await?;
    }
    result
}

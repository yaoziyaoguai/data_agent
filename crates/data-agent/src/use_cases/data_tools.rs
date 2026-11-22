mod conversation_history;
mod invoke;
mod preflight;
mod saved_analyses;
pub use invoke::{invoke, invoke_validated};

use super::evidence_delivery::{SearchCursorInput, SearchScope, SearchSelection};
use super::source_limits::SourceGate;
use crate::{
    contracts,
    modules::{analysis, assets, conversations, knowledge, queries, retrieval, runtime},
    persistence::AppTx,
    search_scope::KnowledgeSearchScope,
    types::{AccessContext, Error, Result, epoch, fingerprint, id},
};
use serde_json::{Value, json};
use sqlx::MySqlPool;
mod registration;
use registration::*;
pub use registration::{
    recorded_rejection, recorded_rejection_validated, register, register_validated,
};
mod evidence;

async fn execute(pool: &MySqlPool, ctx: &AccessContext, input: Value) -> Result<Value> {
    let name = text(&input, "tool_name")?;
    let args = &input["arguments"];
    let source_identity_view = name == "search_knowledge" && args["view"] == "source_identity";
    let preflight = preflight::prepare(pool, ctx, &input, name, args, source_identity_view).await?;
    let prepared = match preflight {
        preflight::Preflight::Replayed(value) => return Ok(value),
        preflight::Preflight::Prepared(prepared) => prepared,
    };
    let preflight::PreparedTool {
        cid,
        response_budget,
        bound_args,
        legacy_migration,
        query_resolution,
        text_results,
        external,
        extracted_memory,
        memory_candidates,
        memory_retrieval,
        search_request,
        search_deadline,
        search_selection,
        search_gate,
        mut search_stage,
    } = *prepared;
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
        let receipt =
            replay_receipt_in_tx(&mut tx, ctx, &conv, &run.id, name, &tool, &text_results).await?;
        tx.commit().await?;
        return Ok(receipt);
    }
    // 搜索复用准备召回时的范围。交付提交前只核对同一任务及条件版本。
    let source_gate = if name == "search_knowledge" {
        search_gate
    } else if matches!(
        name,
        "read_knowledge"
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
    let evidence_read = !source_identity_view
        && matches!(name, "search_knowledge" | "read_knowledge" | "read_source");
    let evidence_task = if let Some(selection) = &search_selection {
        selection.task.clone()
    } else if evidence_read {
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
    // 正文和支持准备不持会话/运行锁；本次交付依赖和采用记录只在最终重核后保存。
    if evidence_read {
        tx.commit().await?;
        tx = AppTx::begin(pool).await?;
    }
    let mut delivery_authority = super::context_authority::empty();
    let mut adopted_assets = Vec::new();
    let data = match name {
        "search_knowledge" if source_identity_view => {
            external.as_ref().ok_or(Error::new("unavailable"))?.clone()
        }
        "search_knowledge" => {
            evidence::search(
                &mut tx,
                pool,
                ctx,
                evidence::SearchReplyInput {
                    stage: search_stage.take().ok_or(Error::new("unavailable"))?,
                    selection: search_selection.as_ref().ok_or(Error::new("unavailable"))?,
                    task: &evidence_task,
                    source_gate: source_gate.as_ref(),
                    budget: response_budget.as_ref(),
                    text_results: &text_results,
                    memory_candidates: &memory_candidates,
                    memory_retrieval,
                    deadline: search_deadline,
                    limit: args["limit"].as_u64().unwrap_or(10) as usize,
                    query: text(args, "query")?,
                    asset_after: search_request
                        .as_ref()
                        .and_then(|request| request.asset_after.as_deref()),
                    operation_id: &tool.operation_id,
                },
                &mut delivery_authority,
            )
            .await?
        }
        "read_knowledge" => {
            let (reply, adoptions) = evidence::read_knowledge(
                &mut tx,
                ctx,
                &cid,
                args,
                &evidence_task,
                (source_gate.as_ref(), &text_results, &mut delivery_authority),
                response_budget.as_ref(),
            )
            .await?;
            adopted_assets = adoptions;
            reply
        }
        "read" => {
            super::personal_assets::read_skill_file_in_tx(
                &mut tx,
                ctx,
                &conv,
                &run.id,
                text(args, "path")?,
                source_gate.as_ref(),
                &text_results,
            )
            .await?
        }
        "read_source" => {
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
                serde_json::to_value(reply).map_err(|_| crate::types::Error::new("unavailable"))?,
                response_budget.as_ref(),
            )?;
            contracts::validate("SourceReadReply", &reply)?;
            reply
        }
        "read_analysis_task" => conversation_history::task(&mut tx, &conv, args).await?,
        "read_conversation" => conversation_history::history(&mut tx, &conv, args).await?,
        "validate_sql" => {
            let mut result = external.clone().ok_or(Error::new("unavailable"))?;
            result["semantic_checks"] =
                semantic_diagnostics_in_tx(&mut tx, ctx, args, source_gate.as_ref()).await?;
            result
        }
        "update_analysis_task" => {
            let message =
                conversations::read_message_in_tx(&mut tx, &conv, &run.message_id).await?;
            let mut task_input = bound_args.as_ref().unwrap_or(args).clone();
            super::source_limits::bind_update_in_tx(
                &mut tx,
                &cid,
                &run.message_id,
                message.user_supplied,
                &mut task_input,
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
            // 尚未完成的旧决定已用原登记指纹绑定。新工具登记不接受旧未决形状。
            let legacy = [
                &task_input["conditions"],
                &task_input["condition_patch"]["set"],
            ]
            .into_iter()
            .any(|conditions| {
                conditions["semantic_resolution"]
                    .get("unresolved_differences")
                    .is_some()
            });
            let tasks = analysis::lock_tasks_in_tx(&mut tx, &cid).await?;
            let mut result = analysis::apply_update_in_tx(
                &mut tx,
                &tasks,
                &ctx.user_id,
                &tool.operation_id,
                analysis::AnalysisUpdateRequest {
                    arguments: &task_input,
                    dialect: if legacy {
                        analysis::AnalysisUpdateDialect::Legacy
                    } else {
                        analysis::AnalysisUpdateDialect::Current
                    },
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
            let conditions =
                request_conditions_in_tx(&mut tx, ctx, &conv, &run.message_id, args).await?;
            // 原条件版本及当前来源已由request_condition_authority重核；
            // 采纳说明使用前置核对的同一份结果，不能在草稿入口独立改决定。
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
                    time_basis: time_basis.as_ref(),
                    semantic_resolution: query_resolution.as_ref(),
                },
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
            saved_analyses::query(
                &mut tx,
                ctx,
                &conv,
                &run,
                args,
                external.as_ref(),
                source_gate.as_ref(),
                &text_results,
            )
            .await?
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
            saved_analyses::read_report(
                &mut tx,
                ctx,
                &conv,
                &run,
                args,
                external.as_ref(),
                source_gate.as_ref(),
                &text_results,
            )
            .await?
        }
        "save_analysis_report" => {
            saved_analyses::save_report(
                &mut tx,
                ctx,
                &conv,
                &run,
                &tool.operation_id,
                args,
                external.as_ref(),
                &text_results,
            )
            .await?
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
                let mut dependencies = args["dependencies"]
                    .as_array()
                    .ok_or(crate::types::Error::new("invalid_input"))?
                    .clone();
                // 修订提取使用旧正文，旧来源不能因新参数省略而脱离新版。
                if extracted_memory.is_some()
                    && let Some(old) = &old
                {
                    for reference in old["dependencies"]
                        .as_array()
                        .ok_or(crate::types::Error::new("unavailable"))?
                    {
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
    if evidence_read {
        super::context_authority::observe(&mut delivery_authority, &data)?;
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
            let receipt =
                replay_receipt_in_tx(&mut tx, ctx, &conv, &run.id, name, &tool, &text_results)
                    .await?;
            tx.commit().await?;
            return Ok(receipt);
        }
        if super::evidence_delivery::current_task_in_tx(&mut tx, &conv, None).await?
            != evidence_task
        {
            return Err(Error::new(
                if search_request.as_ref().is_some_and(|r| r.cursor.is_some()) {
                    "stale_cursor"
                } else {
                    "version_conflict"
                },
            ));
        }
        super::context_authority::validate_in_tx(
            &mut tx,
            ctx,
            &delivery_authority,
            super::context_authority::AuthorityUse::Text(&text_results),
        )
        .await
        .map_err(|error| {
            if error.code == "stale_context" {
                Error::new("stale_knowledge")
            } else {
                error
            }
        })?;
        for asset in adopted_assets {
            assets::record_adoption_in_tx(&mut tx, ctx, &run.id, &asset, "read").await?;
        }
        super::context_authority::merge_run_in_tx(&mut tx, &run.id, &delivery_authority).await?;
    } else if !source_identity_view {
        super::context_authority::extend_run_in_tx(&mut tx, &run.id, &data).await?;
    }
    let mut receipt = json!({"operation_id":tool.operation_id,"tool_name":name,"tool_contract_version":tool.tool_contract_version,"data":data});
    if let Some(ids) = receipt["data"]
        .as_object_mut()
        .ok_or(crate::types::Error::new("unavailable"))?
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
        let baseline = projection.baseline();
        if authority["active_task"] != baseline {
            if super::source_limits::scope_changed_in_tx(&mut tx, &cid, &authority, &projection)
                .await?
            {
                // 原基线保留到 Pi 提交新分支，成功回执先落库时仍可恢复。
                receipt["context_reset"] = baseline;
            } else {
                authority["active_task"] = baseline;
                runtime::save_authority_in_tx(&mut tx, &run.id, &authority).await?;
            }
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
    if matches!(
        name,
        "update_analysis_task" | "request_query" | "execute_query"
    ) {
        // 只有改变任务或查询控制状态的工具才回传投影。
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
    contracts::validate("DataToolOutcome", &receipt)?;
    if tool.state == "registered" {
        runtime::record_tool_receipt_in_tx(&mut tx, &run, &tool, &receipt).await?;
    }
    tx.commit().await?;
    Ok(receipt)
}

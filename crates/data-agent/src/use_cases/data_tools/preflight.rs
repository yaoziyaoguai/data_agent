use super::*;

pub(super) enum Preflight {
    Replayed(Value),
    Prepared(Box<PreparedTool>),
}

pub(super) struct PreparedTool {
    pub cid: String,
    pub response_budget: Option<contracts::generated::ResponseBudget>,
    pub bound_args: Option<Value>,
    pub legacy_migration: Option<analysis::LegacyDecisionMigration>,
    pub query_resolution: Option<Value>,
    pub text_results: super::super::context_authority::CheckedTextResults,
    pub external: Option<Value>,
    pub extracted_memory: Option<String>,
    pub memory_candidates: Vec<Value>,
    pub memory_retrieval: &'static str,
    pub search_request: Option<contracts::generated::KnowledgeSearchInput>,
    pub search_deadline: tokio::time::Instant,
    pub search_selection: Option<SearchSelection>,
    pub search_gate: Option<SourceGate>,
    pub search_stage: Option<super::super::knowledge::ScopedSearchStage>,
}

pub(super) async fn prepare(
    pool: &MySqlPool,
    ctx: &AccessContext,
    input: &Value,
    name: &str,
    args: &Value,
    source_identity_view: bool,
) -> Result<Preflight> {
    let response_budget: Option<contracts::generated::ResponseBudget> = input
        .get("response_budget")
        .map(|value| serde_json::from_value(value.clone()).map_err(|_| Error::new("invalid_input")))
        .transpose()?;
    // 采纳身份宿主绑定：条件写入路径验证通过后，把省略的adoption_message_id
    // 回填为本轮真实消息身份的完整args克隆；arm持久化用它，apply层幂等指纹
    // 基于回填后的值，同消息重试指纹一致。
    let mut bound_args: Option<Value> = None;
    let mut legacy_migration: Option<analysis::LegacyDecisionMigration> = None;
    let mut query_resolution: Option<Value> = None;
    let tool_contract_version;
    let recovery_chain;
    let mut effective_cursor = None;
    let cid = runtime::locate_run(pool, text(input, "run_id")?).await?;
    let skill_ids = match name {
        "read" => args["path"]
            .as_str()
            .and_then(|path| assets::skill_files::parse_location(path).ok())
            .map(|(id, _, _)| id)
            .into_iter()
            .collect(),
        "read_knowledge" => args["items"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|item| item["kind"] == "skill")
            .filter_map(|item| item["asset_ref"]["id"].as_str())
            .collect(),
        _ => Vec::new(),
    };
    let mut text_results = if matches!(
        name,
        "request_query"
            | "get_query"
            | "execute_query"
            | "present_analysis_answer"
            | "prepare_analysis_answer"
    ) {
        super::super::query_workflow::check_text_results(pool, ctx, &cid, args["query_id"].as_str())
            .await?
    } else if name == "update_analysis_task" && args["finalize_current_answer"] == true {
        super::super::task_answers::check_results(pool, ctx, text(input, "run_id")?).await?
    } else if !skill_ids.is_empty() || (name == "search_knowledge" && !source_identity_view) {
        super::super::personal_assets::checked_selected_skills(
            pool,
            ctx,
            &cid,
            (name != "search_knowledge").then_some(skill_ids.as_slice()),
        )
        .await?
    } else {
        super::super::context_authority::CheckedTextResults::default()
    };
    // 短引用只在本轮已核会话/租约的短事务里展开；原登记参数与指纹保持短引用。
    {
        let mut tx = AppTx::begin(pool).await?;
        let conv = conversations::lock_conversation_in_tx(&mut tx, ctx, &cid).await?;
        conversations::assert_turn_in_tx(
            &tx,
            &conv,
            text(input, "run_id")?,
            epoch(text(input, "lease_epoch")?)?,
        )?;
        let run = runtime::lock_run_in_tx(&mut tx, text(input, "run_id")?, &cid).await?;
        recovery_chain = run.recovery_chain_id.clone();
        let tool = runtime::lock_tool_call_in_tx(&mut tx, &run, text(input, "sdk_tool_call_id")?)
            .await?
            .ok_or(Error::new("version_conflict"))?;
        if tool.fingerprint != fingerprint(&json!({"name":name,"arguments":args})) {
            return Err(Error::new("idempotency_conflict"));
        }
        tool_contract_version = tool.tool_contract_version;
        if let Some(receipt) = &tool.receipt
            && (tool_contract_version != 2
                || tool.state == "rejected"
                || (tool.state == "succeeded"
                    && (can_replay_receipt(name)
                        || (!source_identity_view
                            && matches!(
                                name,
                                "search_knowledge" | "read_knowledge" | "read_source"
                            )))))
        {
            if tool.state == "succeeded"
                && !source_identity_view
                && matches!(name, "search_knowledge" | "read_knowledge" | "read_source")
            {
                super::super::evidence_delivery::assert_replay_in_tx(
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
            // 旧只读回执可接回原结果，但结果正文仍须通过当前平台权限。
            let result = &receipt["data"]["results"];
            if name == "get_query"
                && tool_contract_version != 2
                && tool.state == "succeeded"
                && let Some(result_ref) = result["result_ref"].as_str()
            {
                super::super::query_workflow::result_state_authority(
                    pool,
                    ctx,
                    text(result, "query_id")?,
                    result_ref,
                )
                .await?;
            }
            return Ok(Preflight::Replayed(receipt));
        }
        if tool_contract_version != 2 {
            return Err(Error::new("outcome_unknown"));
        }
        if name == "search_knowledge"
            && !source_identity_view
            && let Some(cursor) = args["cursor"].as_str()
        {
            effective_cursor = Some(effective_cursor_in_tx(&mut tx, &run, cursor).await?);
        }
        // 登记时校验参数，执行只核对登记指纹。旧回执不按现行参数重新扫描。
        if tool.state == "registered" && tool.execution_started == Some(false) {
            runtime::start_tool_execution_in_tx(&mut tx, &tool).await?;
        }
        if matches!(name, "request_query" | "update_analysis_task") {
            let message =
                conversations::read_message_in_tx(&mut tx, &conv, &run.message_id).await?;
            if name == "request_query" {
                // 失效旧稿前核对目标条件的决定；最终事务仍核原条件版本和当前权限，
                // 不对同一不可变版本另作一份采纳判断。
                let declared =
                    condition_decision_in_tx(&mut tx, &cid, args["task_id"].as_str()).await?;
                query_resolution = super::super::query_semantics::draft_for_condition(
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
                                super::super::query_semantics::verified_legacy_adoption(
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
                    super::super::query_semantics::validate_condition_resolution(
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
    if matches!(name, "request_query" | "validate_sql") {
        let mut tx = AppTx::begin(pool).await?;
        let conv = conversations::lock_conversation_in_tx(&mut tx, ctx, &cid).await?;
        conversations::assert_turn_in_tx(
            &tx,
            &conv,
            text(input, "run_id")?,
            epoch(text(input, "lease_epoch")?)?,
        )?;
        let run = runtime::lock_run_in_tx(&mut tx, text(input, "run_id")?, &cid).await?;
        if run.state != "running" {
            return Err(Error::new("lease_lost"));
        }
        let tool = runtime::lock_tool_call_in_tx(&mut tx, &run, text(input, "sdk_tool_call_id")?)
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
            return Ok(Preflight::Replayed(receipt));
        }
        if name == "request_query" {
            // 预检只核条件授权；来源门在条件授权内部按草稿所属任务解析。
            request_conditions_in_tx(&mut tx, ctx, &conv, &run.message_id, args).await?;
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
        "search_knowledge" if source_identity_view => Some(
            super::super::source_identity::search(pool, ctx, args, response_budget.as_ref())
                .await?,
        ),
        "validate_sql" | "request_query" => {
            Some(queries::platform::check(text(args, "sql")?, &args["parameters"]).await?)
        }
        "execute_query" => {
            let ids = if let Some(batch) = args["queries"].as_array() {
                batch
                    .iter()
                    .map(|item| text(item, "query_id").map(str::to_owned))
                    .collect::<Result<Vec<_>>>()?
            } else {
                vec![text(args, "query_id")?.into()]
            };
            super::super::query_workflow::authorize_pending_execution(pool, ctx, &cid, &ids)
                .await?;
            None
        }
        "get_query" => {
            let qid = text(args, "query_id")?;
            let q = super::super::query_workflow::read(pool, ctx, qid).await?;
            if q["execution_state"] == "succeeded" {
                let mut tx = AppTx::begin(pool).await?;
                let conv = conversations::lock_conversation_in_tx(&mut tx, ctx, &cid).await?;
                conversations::assert_turn_in_tx(
                    &tx,
                    &conv,
                    text(input, "run_id")?,
                    epoch(text(input, "lease_epoch")?)?,
                )?;
                let run = runtime::lock_run_in_tx(&mut tx, text(input, "run_id")?, &cid).await?;
                let defer_results =
                    queries::is_confirmation_message_in_tx(&mut tx, ctx, qid, &run.message_id)
                        .await?;
                tx.commit().await?;
                if defer_results {
                    None
                } else {
                    match super::super::query_workflow::agent_results(pool, ctx, qid, args).await {
                        Ok(v) => Some(v),
                        Err(error) if error.code == "forbidden" => return Err(error),
                        Err(e) => Some(json!({"error":e.code})),
                    }
                }
            } else {
                None
            }
        }
        "present_analysis_answer" => Some(
            super::super::analysis_answers::present(
                pool,
                ctx,
                &cid,
                &runtime::locate_run_message(pool, text(input, "run_id")?).await?,
                args,
                &mut text_results,
            )
            .await?,
        ),
        "prepare_analysis_answer" => Some(
            super::super::analysis_answers::prepare(
                pool,
                ctx,
                &cid,
                &runtime::locate_run_message(pool, text(input, "run_id")?).await?,
                args,
                &mut text_results,
            )
            .await?,
        ),
        "save_analysis_evidence" => Some(
            super::super::analysis_evidence::validate_sources(
                pool,
                ctx,
                &cid,
                &runtime::locate_run_message(pool, text(input, "run_id")?).await?,
                args,
                &mut text_results,
            )
            .await?,
        ),
        "save_analysis_report" => Some(
            super::super::analysis_reports::validate_sources(
                pool,
                ctx,
                &cid,
                args,
                &mut text_results,
            )
            .await?,
        ),
        "read_analysis_report" => Some(
            super::super::analysis_reports::read_for_agent(
                pool,
                ctx,
                &cid,
                args,
                &mut text_results,
            )
            .await?,
        ),
        "prepare_skill_draft" => Some(
            super::super::skill_drafts::validate_sources(
                pool,
                ctx,
                &cid,
                (
                    &runtime::locate_run_message(pool, text(input, "run_id")?).await?,
                    &recovery_chain,
                ),
                args,
                &mut text_results,
            )
            .await?,
        ),
        _ => None,
    };
    let extracted_memory = super::super::personal_memory::extract(pool, ctx, input).await?;
    let (memory_candidates, memory_retrieval) = if source_identity_view {
        (vec![], "directory")
    } else {
        super::super::personal_memory::search(pool, ctx, input).await
    };
    let scope = if name == "search_knowledge" && !source_identity_view {
        KnowledgeSearchScope::from_validated(args)?
    } else {
        KnowledgeSearchScope::default()
    };
    let search_request = if name == "search_knowledge" && !source_identity_view {
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
    let (search_selection, source_selection_gate, allowed_records) = if name == "search_knowledge"
        && !source_identity_view
    {
        match tokio::time::timeout_at(search_deadline, async {
            let message = runtime::locate_run_message(pool, text(input, "run_id")?).await?;
            let mut tx = AppTx::begin(pool).await?;
            let conv = conversations::lock_conversation_in_tx(&mut tx, ctx, &cid).await?;
            let active = if let Some(request) = &search_request {
                super::super::evidence_delivery::current_task_in_tx(
                    &mut tx,
                    &conv,
                    request.task_ref.as_ref(),
                )
                .await?
            } else {
                None
            };
            let gate = super::super::source_limits::resolve_in_tx(&mut tx, &conv, &message).await?;
            tx.commit().await?;
            let records = if source_selection.is_some() {
                None
            } else {
                let mut read = AppTx::begin(pool).await?;
                let records = super::super::source_limits::allowed_records_in_tx(
                    &mut read,
                    ctx,
                    gate.as_ref(),
                    &scope,
                )
                .await?;
                read.commit().await?;
                Some(records)
            };
            let selection = search_request.as_ref().map(|request| {
                let scope = match &records {
                    Some(records) => SearchScope::Recall(records),
                    None => SearchScope::Selected(gate.as_ref()),
                };
                SearchSelection::new(ctx, request, active, scope)
            });
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
            super::super::knowledge_embeddings::launch_scoped(
                pool,
                ctx,
                text(args, "query")?,
                Some(input),
                true,
                allowed_records.as_ref(),
                search_deadline,
            )
            .await
        } else {
            None
        };
    let search_stage = if name == "search_knowledge" && !source_identity_view {
        let mut candidates = retrieval::vector::Candidates::lexical();
        candidates.deadline = search_deadline;
        candidates.bounded = tokio::time::Instant::now() >= search_deadline;
        let mut request = super::super::knowledge::ScopedSearchRequest {
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
            include_raw: true,
        };
        Some(if let Some(selection) = source_selection {
            super::super::knowledge::search_selected_sources_outside_lock(
                pool,
                ctx,
                &request,
                selection,
                source_selection_gate.as_ref(),
                continuation,
            )
            .await?
        } else if let Some(continuation) = continuation {
            super::super::knowledge::restore_search_stage_outside_lock(
                pool,
                ctx,
                &mut request,
                continuation,
            )
            .await?
        } else {
            super::super::knowledge::search_stage_outside_lock(pool, ctx, &mut request).await?
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
        eprintln!("test_retrieval_stage_ready run={}", text(input, "run_id")?);
        tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
    }
    Ok(Preflight::Prepared(Box::new(PreparedTool {
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
        search_gate: source_selection_gate,
        search_stage,
    })))
}

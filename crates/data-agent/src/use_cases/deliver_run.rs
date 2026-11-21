use crate::{
    modules::{access, analysis, conversations, jobs, runtime},
    persistence::AppTx,
    types::{AccessContext, Error, Result, epoch, fingerprint, id},
};
use serde_json::{Value, json};
use sqlx::MySqlPool;

pub async fn start_delivery(
    pool: &MySqlPool,
    job: &jobs::ClaimedJob,
    ttl_ms: u32,
) -> Result<Value> {
    // 外部来源预检也可能超过TTL；领取后即续job，建立run后再交给正常会话心跳。
    // 两个future同时推进，不能在持锁的准备future旁串行等待续租而阻止它提交。
    let started = std::time::Instant::now();
    let diagnostics = std::env::var("DATA_AGENT_DIAGNOSTICS").as_deref() == Ok("1");
    if diagnostics {
        eprintln!(
            "delivery_prepare_enter job={} worker={} job_epoch={} ttl_ms={ttl_ms}",
            job.id, job.worker_id, job.lease_epoch
        );
    }
    // 先完成首次续租再启动准备：失效领取不能在BEGIN尚未完成时取消准备分支，
    // 否则驱动还未登记事务深度，连接可能带未回滚事务回到池中。
    jobs::renew_claim(pool, job, ttl_ms).await?;
    let heartbeat = async {
        let mut interval =
            tokio::time::interval(std::time::Duration::from_millis(u64::from(ttl_ms) / 3));
        interval.tick().await;
        loop {
            interval.tick().await;
            if diagnostics {
                eprintln!(
                    "delivery_prepare_tick job={} elapsed_ms={}",
                    job.id,
                    started.elapsed().as_millis()
                );
            }
            if let Err(error) = jobs::renew_claim(pool, job, ttl_ms).await {
                if !error.is_transient_storage() {
                    return Err(error);
                }
                eprintln!(
                    "delivery_prepare_renew_transient job={} code={}",
                    job.id, error.code
                );
            }
        }
    };
    tokio::select! {
        result = prepare_delivery(pool, job, ttl_ms, started) => {
            if diagnostics {
                eprintln!("delivery_prepare_exit job={} branch=prepare elapsed_ms={} code={}",job.id,started.elapsed().as_millis(),result.as_ref().map(|_|"ready").unwrap_or_else(|error|error.code));
            }
            result
        },
        result = heartbeat => {
            if diagnostics {
                eprintln!("delivery_prepare_exit job={} branch=heartbeat elapsed_ms={} code={}",job.id,started.elapsed().as_millis(),result.as_ref().map(|_|"ready").unwrap_or_else(|error|error.code));
            }
            result
        },
    }
}

async fn prepare_delivery(
    pool: &MySqlPool,
    job: &jobs::ClaimedJob,
    ttl_ms: u32,
    started: std::time::Instant,
) -> Result<Value> {
    let diagnostics = std::env::var("DATA_AGENT_DIAGNOSTICS").as_deref() == Ok("1");
    if diagnostics {
        eprintln!(
            "delivery_prepare_stage job={} stage=preflight elapsed_ms={}",
            job.id,
            started.elapsed().as_millis()
        );
    }
    let location = conversations::locate_conversation(pool, &job.conversation_id).await?;
    let mut context = AccessContext {
        user_id: location.owner_id,
        space_id: location.space_id,
        request_id: id(),
    };
    // 先释放业务锁再查平台结果授权；正式领取时重核所采用的依赖清单。
    let mut preflight = AppTx::begin(pool).await?;
    if diagnostics {
        eprintln!(
            "delivery_prepare_stage job={} stage=preflight_transaction elapsed_ms={}",
            job.id,
            started.elapsed().as_millis()
        );
    }
    let owner =
        conversations::lock_conversation_in_tx(&mut preflight, &context, &job.conversation_id)
            .await?;
    let input = conversations::read_message_in_tx(&mut preflight, &owner, &job.message_id).await?;
    let previous = if let Some(value) =
        runtime::read_checkpoint_in_tx(&mut preflight, &input.recovery_chain_id).await?
    {
        Some(value)
    } else {
        runtime::read_conversation_checkpoint_in_tx(&mut preflight, &owner.id).await?
    };
    let frozen_authorities = runtime::read_frozen_answer_authorities_in_tx(
        &mut preflight,
        &owner.id,
        &input.recovery_chain_id,
    )
    .await?;
    preflight.commit().await?;
    if diagnostics {
        eprintln!(
            "delivery_prepare_stage job={} stage=authority elapsed_ms={}",
            job.id,
            started.elapsed().as_millis()
        );
    }
    let checked = super::context_authority::check_results(
        pool,
        &context,
        &previous
            .as_ref()
            .map(|v| v["authority_snapshot"].clone())
            .unwrap_or_else(super::context_authority::empty),
    )
    .await?;
    let mut text_results = super::context_authority::check_task_text_results(
        pool,
        &context,
        &job.conversation_id,
        Some(&checked),
    )
    .await?;
    let asset_results = super::context_authority::check_available_asset_results(
        pool,
        &context,
        &job.conversation_id,
    )
    .await?;
    text_results.include_checked(&asset_results);
    // 冻结前项只补交付有效性证明，不进入当前活动任务的snapshot或模型材料。
    text_results
        .include_authorities(pool, &context, &frozen_authorities)
        .await?;
    if diagnostics {
        eprintln!(
            "delivery_prepare_stage job={} stage=transaction elapsed_ms={}",
            job.id,
            started.elapsed().as_millis()
        );
    }
    let mut tx = AppTx::begin(pool).await?;
    let conversation =
        conversations::lock_conversation_in_tx(&mut tx, &context, &job.conversation_id).await?;
    let message =
        conversations::read_message_in_tx(&mut tx, &conversation, &job.message_id).await?;
    if message.disposition != "pending" {
        return Err(Error::new("version_conflict"));
    }
    let profile = runtime::read_budget_profile_in_tx(&mut tx, &message.budget_scope_id).await?;
    if let Some(configured) = profile.as_ref().filter(|p| p.configured_model.is_some()) {
        runtime::model_configuration::assert_active_in_tx(&mut tx, &context.space_id, configured)
            .await?;
    } else {
        access::authorize_model(if profile.is_some() {
            "deepseek"
        } else {
            "local_mock"
        })?;
    }
    context.request_id = message.request_id.clone();
    let run_id = id();
    if conversation.lease_valid {
        return Err(Error::new("lease_lost"));
    }
    // 会话行锁使下一代次固定；准备完成前只绑定账本，不提前消耗会话租约。
    let lease_epoch = conversation.lease_epoch + 1;
    if diagnostics {
        eprintln!(
            "delivery_prepare_stage job={} stage=run elapsed_ms={}",
            job.id,
            started.elapsed().as_millis()
        );
    }
    let (output_id, attempt_id, replaces) = runtime::start_run_in_tx(
        &mut tx,
        runtime::RunStart {
            run_id: &run_id,
            conversation_id: &conversation.id,
            message_id: &message.id,
            recovery_chain_id: &message.recovery_chain_id,
            budget_scope_id: &message.budget_scope_id,
            tool_contract_version: configured_tool_contract_version(),
            lease_epoch,
            job_id: &job.id,
            job_lease_epoch: job.lease_epoch,
        },
    )
    .await?;
    let started_run = runtime::lock_run_in_tx(&mut tx, &run_id, &conversation.id).await?;
    let tool_contract_version = started_run.tool_contract_version;
    let answer_parts = if tool_contract_version == 2 {
        super::task_answers::references_in_tx(&mut tx, &started_run).await?
    } else {
        Vec::new()
    };
    let mut checkpoint =
        runtime::read_checkpoint_in_tx(&mut tx, &message.recovery_chain_id).await?;
    let resume_same_input = checkpoint.is_some();
    let mut workspace_context = None;
    if std::env::var("DATA_AGENT_TOOLSET").as_deref() == Ok("data") {
        let mut tasks = crate::modules::analysis::context_in_tx(&mut tx, &conversation.id).await?;
        let input_task_ids =
            conversations::message_task_ids_in_tx(&mut tx, &conversation, &message.id).await?;
        // 结果输入首次交付按原查询绑定；同输入恢复保留已提交的route进度。
        // 晚到查询的完成事务不改写其他任务的活动绑定。
        if !resume_same_input
            && let Some(qid) = conversations::result_query_for_message_in_tx(
                &mut tx,
                &conversation.id,
                &message.id,
            )
            .await?
            && let Ok(query) = crate::modules::queries::read_in_tx(&mut tx, &context, &qid).await
            && let Some(task) = query["task_id"].as_str()
            && let Ok(version) = epoch(query["condition_version"].as_str().unwrap_or(""))
            && analysis::read_task_in_tx(&mut tx, &conversation.id, task)
                .await
                .ok()
                .and_then(|task| task["lifecycle"].as_str().map(str::to_owned))
                .as_deref()
                == Some("active")
        {
            conversations::bind_active_task_in_tx(&mut tx, &conversation, task, version).await?;
        }
        let recent_tasks = conversations::recent_task_ids_in_tx(&mut tx, &conversation).await?;
        // 活动任务与消息任务清单分离：一次派发只绑定一个active_task_ref，
        // 受限读取与重投影纪律都从这里继承。
        let projection =
            super::source_limits::active_projection_in_tx(&mut tx, &conversation).await?;
        let active_task_ref = match &projection.task {
            Some((task, version)) => {
                json!({"task_id":task,"condition_version":version.to_string()})
            }
            None => Value::Null,
        };
        let mut priorities = std::collections::HashMap::new();
        for task in input_task_ids.iter().chain(&recent_tasks) {
            let next = priorities.len();
            priorities.entry(task.as_str()).or_insert(next);
        }
        tasks.sort_by_key(|task| {
            let id = task["id"].as_str().unwrap_or("");
            (
                priorities.get(id).copied().unwrap_or(usize::MAX),
                id.to_owned(),
            )
        });
        let (memories, selected, asset_counts) = workspace_assets_in_tx(
            &mut tx,
            &context,
            &conversation.id,
            &projection,
            &text_results,
        )
        .await?;
        if checkpoint.is_none() {
            checkpoint =
                runtime::read_conversation_checkpoint_in_tx(&mut tx, &conversation.id).await?;
        }
        let (invalidated, scope_changed) = if let Some(previous) = &checkpoint {
            checked.assert_snapshot(&previous["authority_snapshot"])?;
            let invalidated = checked.invalidated
                || super::context_authority::needs_reset_in_tx(
                    &mut tx,
                    &context,
                    &conversation.id,
                    &previous["authority_snapshot"],
                )
                .await?;
            let scope_changed = super::source_limits::active_reset_required_in_tx(
                &mut tx,
                &context,
                &conversation,
                &previous["authority_snapshot"],
            )
            .await?;
            (invalidated, scope_changed)
        } else {
            (false, false)
        };
        if invalidated {
            // 丢弃未完成输入的检查点会换SDK调用身份；结束本输入后由新消息重新调查。
            if resume_same_input {
                return Err(Error::new("stale_context"));
            }
            checkpoint = None;
        } else if scope_changed && !resume_same_input {
            checkpoint = None;
        }
        let mut snapshot = checkpoint
            .as_ref()
            .map(|v| v["authority_snapshot"].clone())
            .unwrap_or_else(super::context_authority::empty);
        // 历史只由Pi恢复；完整原话可经read_conversation分页补读，不再注入300字副本。
        let mut visible = json!({"request_clock":message.request_clock,"input_task_ids":input_task_ids,"active_task_ref":active_task_ref,"tasks":tasks.iter().take(24.max(input_task_ids.len())).map(|t|if invalidated{json!({"id":t["id"],"condition_version":t["condition_version"],"lifecycle":t["lifecycle"],"phase":t["phase"],"context_complete":false,"note":"依据已失效，请重新调查"})}else{t.clone()}).collect::<Vec<_>>(),"recent_messages":[],"selected_skills":selected,"memories":memories,"query_observations":crate::modules::queries::list_in_tx(&mut tx,&conversation.id).await?.iter().rev().take(12).map(|q|json!({"id":q["id"],"task_id":q["task_id"],"condition_version":q["condition_version"],"draft_version":q["draft_version"],"confirmation_state":q["confirmation_state"],"execution_state":q["execution_state"]})).collect::<Vec<_>>(),"asset_counts":asset_counts});
        // 宿主控制投影只覆盖已落库的等待/澄清事实；普通分析义务仍由模型答案承担。
        visible["control_delivery"] = Value::Null;
        if tool_contract_version == 2 {
            let delivery = super::task_answers::reconnect_control_delivery_in_tx(
                &mut tx,
                &context,
                &conversation,
                &started_run,
                &text_results,
            )
            .await?;
            visible["control_delivery"] = delivery.control_delivery.unwrap_or(Value::Null);
            visible["frozen_notification_covered"] = json!(delivery.frozen_notification_covered);
        }
        if let Some(qid) =
            conversations::result_query_for_message_in_tx(&mut tx, &conversation.id, &message.id)
                .await?
        {
            let query = crate::modules::queries::read_in_tx(&mut tx, &context, &qid).await?;
            visible["result_notification"] = json!({"query_id":qid,"execution_state":query["execution_state"],
                    "task_ref":{"task_id":query["task_id"],"condition_version":query["condition_version"]}});
        }
        // 已失效任务只交付状态，不能把旧口径经初始工作区再次送入模型。
        let mut task_text_dependencies = std::collections::HashMap::new();
        for task in visible["tasks"].as_array_mut().into_iter().flatten() {
            let refs = super::context_authority::protect_task_context_in_tx(
                &mut tx,
                &context,
                &conversation.id,
                task,
                &text_results,
                Some(&projection),
            )
            .await?;
            task_text_dependencies.insert(task["id"].as_str().unwrap_or("").to_owned(), refs);
        }
        crate::modules::retrieval::bound_workspace(&mut visible);
        for task in visible["tasks"].as_array().into_iter().flatten() {
            if (task["goal"].is_string()
                || task["clarification"].is_object()
                || task["conditions"].is_object())
                && let Some(refs) = task_text_dependencies.get(task["id"].as_str().unwrap_or(""))
            {
                // 已交付任务正文继承完整出处；不把出处误当成本轮预览。
                super::context_authority::merge(&mut snapshot, refs)?;
            }
        }
        let asset_authority = super::context_authority::asset_text_dependencies_in_tx(
            &mut tx,
            &context,
            &conversation.id,
            &visible,
            &text_results,
        )
        .await?;
        super::context_authority::merge(&mut snapshot, &asset_authority)?;
        // 派发基线：本运行的轮内重投影纪律以键存在为准，任务/版本仅记录当时状态。
        // 原输入只变更范围时保留旧基线，待Pi接回原工具并确认新投影后再推进。
        // 普通和摘要派发仍会核对这条基线，不会将恢复读取当作派发许可。
        if !(scope_changed && resume_same_input) {
            snapshot["active_task"] = super::source_limits::projection_baseline(&projection);
        }
        super::context_authority::observe(&mut snapshot, &visible);
        super::context_authority::observe_workspace_previews(&mut snapshot, &visible);
        runtime::save_authority_in_tx(&mut tx, &run_id, &snapshot).await?;
        visible["authority_revision"] = json!(fingerprint(&snapshot));
        visible["authority_snapshot"] = snapshot;
        if tool_contract_version == 2 {
            let blocker = super::source_limits::source_context_blocker(
                message.routing_state == "routed",
                projection.scope_known,
                scope_changed && resume_same_input,
            );
            visible["source_context_ready"] = json!(blocker.is_none());
            if let Some(blocker) = blocker {
                visible["source_context_blocker"] = json!(blocker);
            }
        }
        workspace_context = Some(visible);
    }
    if let Some(previous) = replaces {
        conversations::append_event_in_tx(
            &mut tx,
            &conversation,
            &id(),
            "assistant_replaced",
            json!({"output_id":output_id,"attempt_id":attempt_id,"replaces_attempt_id":previous}),
        )
        .await?;
    }
    if let Some(value) = checkpoint {
        checkpoint = Some(runtime::bind_delivery_checkpoint_in_tx(&mut tx, &run_id, &value).await?);
    }
    // 两份租约和attempt同事务提交；领取已失效时回滚准备成果，不能先记失败次数再续租。
    if diagnostics {
        eprintln!(
            "delivery_prepare_stage job={} stage=claim_turn elapsed_ms={}",
            job.id,
            started.elapsed().as_millis()
        );
    }
    conversations::claim_turn_in_tx(&mut tx, &conversation, &run_id, ttl_ms).await?;
    jobs::renew_lease_in_tx(&mut tx, &job.id, job.lease_epoch, ttl_ms).await?;
    jobs::begin_attempt_in_tx(&mut tx, job).await?;
    tx.notify(crate::live_changes::Change::Run {
        scope: conversation.live_scope(),
    });
    tx.commit().await?;
    if diagnostics {
        eprintln!(
            "delivery_prepare_stage job={} stage=committed elapsed_ms={}",
            job.id,
            started.elapsed().as_millis()
        );
    }
    eprintln!(
        "run_started request={} conversation={} run={} epoch={}",
        context.request_id, conversation.id, run_id, lease_epoch
    );
    let envelope = json!({"request_id":message.request_id,"run_id":run_id,"conversation_id":conversation.id,"recovery_chain_id":message.recovery_chain_id,"lease_epoch":lease_epoch.to_string(),"budget_scope_id":message.budget_scope_id,"output_id":output_id,"attempt_id":attempt_id,"message_id":message.id,"text":message.body,"request_clock":message.request_clock,"checkpoint":checkpoint,"model_profile":profile,"workspace_context":workspace_context,"resume_same_input":resume_same_input && checkpoint.is_some(),"tool_contract_version":tool_contract_version,"answer_parts":answer_parts});
    Ok(envelope)
}
// 只影响新消息；恢复链的合同版本由原run账本保持，与模型和索引配置无关。
fn configured_tool_contract_version() -> u8 {
    if std::env::var("DATA_AGENT_TOOL_CONTRACT_VERSION").as_deref() == Ok("2") {
        2
    } else {
        1
    }
}

pub async fn read_delivery_checkpoint(
    pool: &MySqlPool,
    context: &AccessContext,
    run_id: &str,
    lease: &str,
) -> Result<Value> {
    let cid = runtime::locate_run(pool, run_id).await?;
    let checked = super::context_authority::check_run_results(pool, context, run_id).await?;
    let mut tx = AppTx::begin(pool).await?;
    let conversation = conversations::lock_conversation_in_tx(&mut tx, context, &cid).await?;
    conversations::assert_turn_in_tx(&tx, &conversation, run_id, epoch(lease)?)?;
    let run = runtime::lock_run_in_tx(&mut tx, run_id, &cid).await?;
    if run.state != "running" {
        return Err(Error::new("lease_lost"));
    }
    super::context_authority::assert_run_in_tx(&mut tx, context, &cid, run_id).await?;
    super::context_authority::assert_checked_run_in_tx(&mut tx, run_id, &checked).await?;
    // 内部检查点读取只用于接回原SDK调用；provider派发另核活动任务投影。
    let checkpoint = runtime::read_delivery_checkpoint_in_tx(&mut tx, &run).await?;
    tx.commit().await?;
    Ok(checkpoint)
}
pub async fn defer_busy_delivery(
    pool: &MySqlPool,
    context: &AccessContext,
    run_id: &str,
    lease: u64,
) -> Result<()> {
    let cid = runtime::locate_run(pool, run_id).await?;
    let mut tx = AppTx::begin(pool).await?;
    let conversation = conversations::lock_conversation_in_tx(&mut tx, context, &cid).await?;
    conversations::assert_turn_in_tx(&tx, &conversation, run_id, lease)?;
    let run = runtime::lock_run_in_tx(&mut tx, run_id, &cid).await?;
    runtime::interrupt_run_in_tx(&mut tx, &run).await?;
    conversations::release_turn_in_tx(&mut tx, &conversation, run_id, lease).await?;
    jobs::defer_unaccepted_in_tx(&mut tx, &run.job_id, run.job_lease_epoch).await?;
    tx.commit().await
}

pub async fn context_for_run(pool: &MySqlPool, run_id: &str) -> Result<AccessContext> {
    let cid = runtime::locate_run(pool, run_id).await?;
    let location = conversations::locate_conversation(pool, &cid).await?;
    let message_id = runtime::locate_run_message(pool, run_id).await?;
    let request_id = conversations::locate_message_request(pool, &message_id).await?;
    Ok(AccessContext {
        user_id: location.owner_id,
        space_id: location.space_id,
        request_id,
    })
}
pub async fn model_attempt(
    pool: &MySqlPool,
    context: &AccessContext,
    run_id: &str,
    lease: &str,
    attempt: &str,
    settle: bool,
) -> Result<Value> {
    let cid = runtime::locate_run(pool, run_id).await?;
    let checked = if settle {
        None
    } else {
        Some(super::context_authority::check_run_results(pool, context, run_id).await?)
    };
    let mut tx = AppTx::begin(pool).await?;
    let conversation = conversations::lock_conversation_in_tx(&mut tx, context, &cid).await?;
    conversations::assert_turn_in_tx(&tx, &conversation, run_id, epoch(lease)?)?;
    let run = runtime::lock_run_in_tx(&mut tx, run_id, &cid).await?;
    if settle {
        runtime::settle_model_call_in_tx(&mut tx, &run, attempt).await?;
    } else {
        access::authorize_model("local_mock")?;
        super::context_authority::assert_run_in_tx(&mut tx, context, &cid, run_id).await?;
        super::context_authority::assert_checked_run_in_tx(
            &mut tx,
            run_id,
            checked.as_ref().expect("issuance preflight"),
        )
        .await?;
        // 轮内收紧/切任务后，模拟模型的下一次派发同样先重核活动任务投影。
        let authority = runtime::read_authority_in_tx(&mut tx, run_id).await?;
        super::source_limits::assert_dispatch_projection_in_tx(
            &mut tx,
            context,
            &conversation,
            authority.as_ref(),
        )
        .await?;
        runtime::issue_model_call_in_tx(&mut tx, &run, attempt).await?;
    }
    tx.commit().await?;
    Ok(json!({"state":if settle {"settled"}else{"issued"}}))
}
pub async fn renew_delivery(
    pool: &MySqlPool,
    context: &AccessContext,
    run_id: &str,
    lease: u64,
    ttl_ms: u32,
) -> Result<()> {
    let cid = runtime::locate_run(pool, run_id).await?;
    let mut tx = AppTx::begin(pool).await?;
    let conversation = conversations::lock_conversation_in_tx(&mut tx, context, &cid).await?;
    conversations::renew_turn_in_tx(&mut tx, &conversation, run_id, lease, ttl_ms).await?;
    let run = runtime::lock_run_in_tx(&mut tx, run_id, &cid).await?;
    jobs::renew_lease_in_tx(&mut tx, &run.job_id, run.job_lease_epoch, ttl_ms).await?;
    tx.commit().await
}

fn delivery_failure_code(code: &str) -> Value {
    if code == "retry_exhausted" {
        return json!(code);
    }
    // 只交付同源契约允许的错误码，不能把内部异常内容送进用户事件。
    let public_code = serde_json::from_value::<crate::contracts::generated::Code>(json!(code))
        .unwrap_or(crate::contracts::generated::Code::Unavailable);
    json!(public_code)
}

// 原子保存交付终止原因；安全拒绝与真实重试耗尽不能混为一种失败。
pub async fn fail_delivery(pool: &MySqlPool, job: &jobs::ClaimedJob, code: &str) -> Result<()> {
    let location = conversations::locate_conversation(pool, &job.conversation_id).await?;
    let context = AccessContext {
        user_id: location.owner_id,
        space_id: location.space_id,
        request_id: id(),
    };
    let mut tx = AppTx::begin(pool).await?;
    let conversation =
        conversations::lock_conversation_in_tx(&mut tx, &context, &job.conversation_id).await?;
    let message =
        conversations::read_message_in_tx(&mut tx, &conversation, &job.message_id).await?;
    if message.disposition != "pending" {
        return Ok(());
    }
    conversations::fail_consumption_in_tx(&mut tx, &conversation, &job.message_id).await?;
    conversations::append_event_in_tx(
        &mut tx,
        &conversation,
        &id(),
        "run_failed",
        json!({"message_id":job.message_id,"code":delivery_failure_code(code)}),
    )
    .await?;
    runtime::fail_message_runs_in_tx(&mut tx, &job.message_id).await?;
    jobs::fail_in_tx(&mut tx, job).await?;
    tx.commit().await
}

/// Pi已完成本轮工具组并建立原生投影边界后，原子保存新上下文与原检查点。
/// 只接受宿主成功控制回执触发的当前任务；不改变运行、预算或工具身份。
pub async fn refresh_context(
    pool: &MySqlPool,
    ctx: &AccessContext,
    input: crate::contracts::generated::RefreshRunContext,
) -> Result<Value> {
    let cid = runtime::locate_run(pool, &input.run_id).await?;
    let mut checked = super::task_answers::check_results(pool, ctx, &input.run_id).await?;
    checked.include_checked(
        &super::context_authority::check_available_asset_results(pool, ctx, &cid).await?,
    );
    let mut tx = AppTx::begin(pool).await?;
    let conv = conversations::lock_conversation_in_tx(&mut tx, ctx, &cid).await?;
    conversations::assert_turn_in_tx(&tx, &conv, &input.run_id, epoch(&input.lease_epoch)?)?;
    let run = runtime::lock_run_in_tx(&mut tx, &input.run_id, &cid).await?;
    if run.state != "running" {
        return Err(Error::new("lease_lost"));
    }
    let tool = runtime::lock_tool_call_in_tx(&mut tx, &run, &input.sdk_tool_call_id)
        .await?
        .ok_or(Error::new("stale_context"))?;
    let receipt = tool.receipt.ok_or(Error::new("stale_context"))?;
    let projection = super::source_limits::active_projection_in_tx(&mut tx, &conv).await?;
    let baseline = super::source_limits::projection_baseline(&projection);
    if tool.state != "succeeded"
        || receipt["context_reset"].is_null()
        || receipt["context_reset"] != baseline
    {
        return Err(Error::new("stale_context"));
    }
    runtime::assert_tools_settled_in_tx(&mut tx, &run).await?;
    let message = conversations::read_message_in_tx(&mut tx, &conv, &run.message_id).await?;
    let tasks = analysis::context_in_tx(&mut tx, &cid).await?;
    let input_tasks = conversations::message_task_ids_in_tx(&mut tx, &conv, &message.id).await?;
    let mut snapshot = super::context_authority::empty();
    let (memories, selected, asset_counts) =
        workspace_assets_in_tx(&mut tx, ctx, &cid, &projection, &checked).await?;
    let mut visible_tasks = Vec::new();
    for mut task in tasks {
        if task["id"] == baseline["task_id"] {
            let sources = super::context_authority::protect_task_context_in_tx(
                &mut tx,
                ctx,
                &cid,
                &mut task,
                &checked,
                Some(&projection),
            )
            .await?;
            super::context_authority::merge(&mut snapshot, &sources)?;
            visible_tasks.insert(0, task);
        } else {
            visible_tasks.push(
                json!({"id":task["id"],"condition_version":task["condition_version"],
                "lifecycle":task["lifecycle"],"phase":task["phase"],"context_complete":false}),
            );
        }
    }
    visible_tasks.truncate(24.max(input_tasks.len()));
    let mut visible = json!({"request_clock":message.request_clock,"input_task_ids":input_tasks,
        "active_task_ref":baseline,"tasks":visible_tasks,"recent_messages":[],
        "selected_skills":selected,"memories":memories,"query_observations":crate::modules::queries::list_in_tx(&mut tx,&cid).await?.iter().rev().take(12).map(|q|json!({"id":q["id"],"task_id":q["task_id"],"condition_version":q["condition_version"],"draft_version":q["draft_version"],"confirmation_state":q["confirmation_state"],"execution_state":q["execution_state"]})).collect::<Vec<_>>(),
        "asset_counts":asset_counts});
    visible["control_delivery"] = Value::Null;
    if run.tool_contract_version == 2 {
        let delivery = super::task_answers::reconnect_control_delivery_in_tx(
            &mut tx, ctx, &conv, &run, &checked,
        )
        .await?;
        visible["control_delivery"] = delivery.control_delivery.unwrap_or(Value::Null);
        visible["frozen_notification_covered"] = json!(delivery.frozen_notification_covered);
    }
    crate::modules::retrieval::bound_workspace(&mut visible);
    let assets = super::context_authority::asset_text_dependencies_in_tx(
        &mut tx, ctx, &cid, &visible, &checked,
    )
    .await?;
    super::context_authority::merge(&mut snapshot, &assets)?;
    super::context_authority::observe(&mut snapshot, &visible);
    super::context_authority::observe_workspace_previews(&mut snapshot, &visible);
    snapshot["active_task"] = baseline;
    runtime::save_authority_in_tx(&mut tx, &run.id, &snapshot).await?;
    runtime::save_checkpoint_in_tx(
        &mut tx,
        &run,
        &serde_json::to_value(&input.checkpoint).expect("checkpoint"),
    )
    .await?;
    visible["authority_revision"] = json!(fingerprint(&snapshot));
    visible["authority_snapshot"] = snapshot;
    if run.tool_contract_version == 2 {
        let blocker = super::source_limits::source_context_blocker(
            message.routing_state == "routed",
            projection.scope_known,
            false,
        );
        visible["source_context_ready"] = json!(blocker.is_none());
        if let Some(blocker) = blocker {
            visible["source_context_blocker"] = json!(blocker);
        }
    }
    crate::contracts::validate("WorkspaceContext", &visible)?;
    tx.commit().await?;
    Ok(visible)
}

// 启动与轮内切换共用资产选择规则；目标解除限制时恢复仍有效的明确选用。
async fn workspace_assets_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    projection: &super::source_limits::ActiveProjection,
    checked: &super::context_authority::CheckedTextResults,
) -> Result<(Vec<Value>, Vec<Value>, Value)> {
    let memories = crate::modules::assets::list_in_tx(tx, ctx, true)
        .await?
        .into_iter()
        .filter(|v| v["kind"] == "memory")
        .collect();
    let mut memories =
        super::knowledge::valid_assets_in_tx(tx, ctx, memories, cid, checked).await?;
    let selected = crate::modules::assets::selected_in_tx(tx, ctx, cid).await?;
    let mut selected =
        super::knowledge::valid_assets_in_tx(tx, ctx, selected, cid, checked).await?;
    // 选用事实与可交付预览分开：来源门可以隐藏预览，不能把有效选用报告为零。
    let selected_count = selected.len();
    // 未知来源范围保守清空；已知受限范围按资产真实来源过滤，合法同源资产保留，
    // 不再把限制来源扩大成禁止一类能力。
    if !projection.scope_known {
        memories.clear();
        selected.clear();
    } else if let Some(gate) = &projection.gate {
        for assets in [&mut memories, &mut selected] {
            let mut kept = Vec::new();
            for asset in assets.drain(..) {
                if super::source_limits::asset_within_in_tx(tx, ctx, gate, &asset).await? {
                    kept.push(asset);
                }
            }
            *assets = kept;
        }
    }
    let counts = json!({"memories":memories.len(),"selected_skills":selected_count});
    let memories = memories
        .into_iter()
        .take(20)
        .map(|v| crate::modules::retrieval::model_page(v, 0, 600, None))
        .collect();
    let selected = selected
        .iter()
        .take(20)
        .map(crate::modules::assets::skill_files::descriptor)
        .collect();
    Ok((memories, selected, counts))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delivery_failure_preserves_public_reasons_and_hides_internal_details() {
        for code in [
            "stale_context",
            "forbidden",
            "budget_exhausted",
            "unavailable",
            "retry_exhausted",
            "provider_configuration_invalid",
            "model_input_limit",
            "model_retry_exhausted",
            "model_usage_unknown",
            "model_auth_failed",
        ] {
            assert_eq!(delivery_failure_code(code), json!(code));
        }
        assert_eq!(
            delivery_failure_code("internal_database_detail: synthetic"),
            json!("unavailable")
        );
    }
}

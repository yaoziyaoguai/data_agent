use crate::{
    modules::{access, conversations, jobs, queries, runtime},
    persistence::{AppTx, delivery},
    types::{AccessContext, Error, Result, epoch, fingerprint, id},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::MySqlPool;
use std::collections::{BTreeSet, HashMap};

#[derive(Debug)]
pub struct PreparedDelivery {
    pub context: AccessContext,
    pub envelope: Value,
}

pub async fn start_delivery(
    pool: &MySqlPool,
    job: &jobs::ClaimedJob,
    ttl_ms: u32,
) -> Result<PreparedDelivery> {
    // 外部来源预检也可能超过TTL；领取后即续job，建立run后再交给正常会话心跳。
    // 两个future同时推进，不能在持锁的准备future旁串行等待续租而阻止它提交。
    // 先完成首次续租再启动准备：失效领取不能在BEGIN尚未完成时取消准备分支，
    // 否则驱动还未登记事务深度，连接可能带未回滚事务回到池中。
    jobs::renew_claim(pool, job, ttl_ms).await?;
    let heartbeat = async {
        let mut interval =
            tokio::time::interval(std::time::Duration::from_millis(u64::from(ttl_ms) / 3));
        interval.tick().await;
        loop {
            interval.tick().await;
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
        result = prepare_delivery(pool, job, ttl_ms) => result,
        result = heartbeat => result,
    }
}

async fn prepare_delivery(
    pool: &MySqlPool,
    job: &jobs::ClaimedJob,
    ttl_ms: u32,
) -> Result<PreparedDelivery> {
    let delivery::PendingDelivery {
        mut context,
        lease_epoch: prior_epoch,
        history,
        selected_skill_provenance,
    } = delivery::pending(pool, &job.conversation_id, &job.message_id).await?;
    let data_workspace = std::env::var("DATA_AGENT_TOOLSET").as_deref() == Ok("data");
    if data_workspace {
        context = super::knowledge::catalog_context(&context).await?;
    }
    let runtime::DeliveryHistory {
        mut checkpoint,
        same_input: resume_same_input,
        answer_handoffs,
        task_resets,
    } = history;
    if !data_workspace && !resume_same_input {
        checkpoint = None;
    }
    let mut authorities: Vec<_> = answer_handoffs
        .iter()
        .map(|v| Ok(v["authority"].clone()))
        .chain(
            selected_skill_provenance
                .iter()
                .map(super::personal_assets::skill_authority),
        )
        .collect::<Result<Vec<_>>>()?;
    let checkpoint_authority = checkpoint
        .as_ref()
        .map(|previous| {
            super::context_authority::including_skill_previews(&previous["authority_snapshot"])
                .map(std::borrow::Cow::into_owned)
        })
        .transpose()?;
    if let Some(previous) = &checkpoint_authority {
        authorities.push(previous.clone());
    }
    let result_proofs = verify_checkpoint_results(pool, &context, &authorities).await?;
    let mut tx = AppTx::begin(pool).await?;
    let delivery::LockedDelivery {
        input:
            conversations::DeliveryInput {
                conversation,
                message,
                mut active_task,
            },
        profile,
        previous_attempt,
    } = delivery::lock(&mut tx, &context, &job.conversation_id, &job.message_id).await?;
    if message.disposition != "pending" {
        return Err(Error::new("version_conflict"));
    }
    // 已配置模型在每次真实发送前由原 provider gate 验冻结服务状态。
    if profile
        .as_ref()
        .is_none_or(|p| p.configured_model.is_none())
    {
        access::authorize_model(if profile.is_some() {
            "deepseek"
        } else {
            "local_mock"
        })?;
    }
    context.request_id = message.request_id.clone();
    let run_id = id();
    if conversation.lease_valid || conversation.lease_epoch != prior_epoch {
        return Err(Error::new("lease_lost"));
    }
    // 会话行锁使下一代次固定；准备完成前只绑定账本，不提前消耗会话租约。
    let lease_epoch = conversation.lease_epoch + 1;
    let workspace = if data_workspace {
        let previous = checkpoint
            .as_ref()
            .map(|v| super::source_limits::previous_task(&v["authority_snapshot"]))
            .transpose()?
            .flatten();
        let checkpoint_sources = checkpoint_authority
            .as_ref()
            .and_then(|previous| delivery::CheckpointSources::deserialize(previous).ok());
        let result_objects = result_proofs
            .iter()
            .flat_map(|(_, result)| result.objects.iter().map(String::as_str));
        Some(
            delivery::workspace(
                &mut tx,
                &context,
                &message,
                previous,
                checkpoint_sources.as_ref(),
                result_objects,
            )
            .await?,
        )
    } else {
        None
    };
    let (started_run, replaces) = runtime::start_run_in_tx(
        &mut tx,
        runtime::RunStart {
            run_id: &run_id,
            conversation_id: &conversation.id,
            message_id: &message.id,
            recovery_chain_id: &message.recovery_chain_id,
            budget_scope_id: &message.budget_scope_id,
            tool_contract_version: 2,
            lease_epoch,
            job_id: &job.id,
            job_lease_epoch: job.lease_epoch,
        },
        previous_attempt,
    )
    .await?;
    let answer_parts: Vec<_> = answer_handoffs
        .into_iter()
        .map(|mut v| v["reference"].take())
        .collect();
    let mut workspace_context = None;
    if let Some(mut workspace) = workspace {
        let text_results = available_results(&result_proofs, &workspace.asset_sources);
        // 结果输入首次交付按原查询绑定；同输入恢复保留已提交的route进度。
        let notification = workspace.notification.take();
        if message.result_query_id.is_some() && notification.is_none() {
            return Err(Error::new("not_available"));
        }
        if !resume_same_input
            && let Some(query) = &notification
            && let Some(task) = query["task_id"].as_str()
            && let Ok(version) = epoch(query["condition_version"].as_str().unwrap_or(""))
            && workspace
                .tasks
                .iter()
                .any(|record| record["id"] == task && record["lifecycle"] == "active")
        {
            conversations::bind_active_task_in_tx(&mut tx, &conversation, task, version).await?;
            active_task = Some((task.to_owned(), version));
        }
        let unrestricted = Value::Null;
        let declaration = match &active_task {
            Some((id, _)) => workspace.declared_scopes.get(id).and_then(Option::as_ref),
            None => workspace.scopes_unrestricted.then_some(&unrestricted),
        };
        let projection = super::source_limits::ActiveProjection::new(active_task, declaration)?;
        let active_task_ref = if projection.task.is_some() {
            projection.baseline()
        } else {
            Value::Null
        };
        let delivery::Workspace {
            mut tasks,
            assets,
            asset_sources,
            active_source_skills,
            observations,
            input_tasks: input_task_ids,
            recent_tasks,
            previous_scope,
            checkpoint_sources_available,
            ..
        } = workspace;
        let mut priorities = HashMap::new();
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
        let WorkspaceAssets {
            memories,
            selected,
            counts: asset_counts,
            selected_provenance,
        } = workspace_assets(
            assets,
            &asset_sources,
            &active_source_skills,
            &text_results,
            &result_proofs,
            &projection,
        )?;
        let (invalidated, scope_changed) = if let Some(previous) = &checkpoint_authority {
            let invalidated = !text_results.allows(previous, false)
                || previous["checkpoint_reset_required"] == true
                || !checkpoint_sources_available;
            let scope_changed = projection.scope_changed(previous, previous_scope.as_ref())?;
            (invalidated, scope_changed)
        } else {
            (false, false)
        };
        if invalidated {
            // 丢弃未完成输入的检查点会换SDK调用身份；结束本输入后由新消息重新调查。
            if resume_same_input {
                // 查不到实时权限与确知撤权不同，保留原检查点等待平台恢复。
                return Err(Error::new(
                    if context
                        .table_access
                        .as_ref()
                        .is_some_and(|access| access.unavailable)
                    {
                        "source_unavailable"
                    } else {
                        "stale_context"
                    },
                ));
            }
            checkpoint = None;
        } else if scope_changed {
            if resume_same_input {
                if !task_resets.contains(&projection.baseline()) {
                    return Err(Error::new("stale_context"));
                }
            } else {
                checkpoint = None;
            }
        }
        let mut snapshot = checkpoint
            .as_ref()
            .map(|v| v["authority_snapshot"].clone())
            .unwrap_or_else(super::context_authority::empty);
        if !resume_same_input || checkpoint.is_none() {
            super::context_authority::start_input_skill_reads(&mut snapshot)?;
        }
        // 历史只由Pi恢复；完整原话可经read_conversation分页补读，不再注入300字副本。
        if invalidated || !projection.scope_known {
            tasks
                .iter_mut()
                .for_each(|task| *task = task_identity(task));
        }
        tasks.truncate(24.max(input_task_ids.len()));
        let mut visible = json!({"request_clock":message.request_clock,"input_task_ids":input_task_ids,"active_task_ref":active_task_ref,"tasks":tasks,"recent_messages":[],"selected_skills":selected,"memories":memories,"query_observations":observations,"asset_counts":asset_counts});
        // 宿主控制投影只覆盖已落库的等待/澄清事实；普通分析义务仍由模型答案承担。
        visible["control_delivery"] = Value::Null;
        visible["frozen_notification_covered"] = json!(false);
        if !input_task_ids.is_empty() || notification.is_some() {
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
        if let Some(query) = notification {
            visible["result_notification"] = json!({"query_id":query["id"],"execution_state":query["execution_state"],
                    "task_ref":{"task_id":query["task_id"],"condition_version":query["condition_version"]}});
        }
        crate::modules::retrieval::bound_workspace(&mut visible);
        // 派发基线：本运行的轮内重投影纪律以键存在为准，任务/版本仅记录当时状态。
        // 原输入只变更范围时保留旧基线，待Pi接回原工具并确认新投影后再推进。
        if !(scope_changed && resume_same_input) {
            snapshot["active_task"] = projection.baseline();
        }
        observe_previews(&mut snapshot, &visible, &selected_provenance)?;
        runtime::save_authority_in_tx(&mut tx, &run_id, &snapshot).await?;
        visible["authority_revision"] = json!(fingerprint(&snapshot));
        visible["authority_snapshot"] = snapshot;
        workspace_context = Some(visible);
    }
    if let Some(previous) = replaces {
        conversations::append_event_in_tx(
            &mut tx,
            &conversation,
            &id(),
            "assistant_replaced",
            json!({"output_id":started_run.output_id,"attempt_id":started_run.attempt_id,"replaces_attempt_id":previous}),
        )
        .await?;
    }
    if let Some(value) = checkpoint {
        checkpoint = Some(runtime::bind_delivery_checkpoint_in_tx(&mut tx, &run_id, &value).await?);
    }
    // 两份租约和attempt同事务提交；领取已失效时回滚准备成果，不能先记失败次数再续租。
    conversations::claim_turn_in_tx(&mut tx, &conversation, &run_id, ttl_ms).await?;
    jobs::start_delivery_attempt_in_tx(&mut tx, job, ttl_ms).await?;
    tx.notify(crate::live_changes::Change::Run {
        scope: conversation.live_scope(),
    });
    tx.commit().await?;
    eprintln!(
        "run_started request={} conversation={} run={} epoch={}",
        context.request_id, conversation.id, run_id, lease_epoch
    );
    let envelope = json!({"request_id":message.request_id,"run_id":run_id,"conversation_id":conversation.id,"recovery_chain_id":message.recovery_chain_id,"lease_epoch":lease_epoch.to_string(),"budget_scope_id":message.budget_scope_id,"output_id":started_run.output_id,"attempt_id":started_run.attempt_id,"message_id":message.id,"text":message.body,"request_clock":message.request_clock,"checkpoint":checkpoint,"model_profile":profile,"workspace_context":workspace_context,"resume_same_input":resume_same_input && checkpoint.is_some(),"tool_contract_version":started_run.tool_contract_version,"answer_parts":answer_parts});
    Ok(PreparedDelivery { context, envelope })
}
// 只影响新消息；恢复链的合同版本由原run账本保持，与模型和索引配置无关。
pub async fn read_delivery_checkpoint(
    pool: &MySqlPool,
    run_id: &str,
    lease: &str,
) -> Result<Value> {
    let lease = epoch(lease)?;
    let (context, cid, checkpoint) = delivery::legacy_checkpoint(pool, run_id, lease).await?;
    // 旧内联历史经由桥接请求交付，再核一次领取租约和当前可读来源。
    let context = &super::knowledge::catalog_context(&context).await?;
    let snapshot =
        super::context_authority::including_skill_previews(&checkpoint["authority_snapshot"])?;
    let sources = delivery::CheckpointSources::deserialize(snapshot.as_ref())
        .map_err(|_| Error::new("stale_context"))?;
    let proofs =
        verify_checkpoint_results(pool, context, std::slice::from_ref(snapshot.as_ref())).await?;
    let mut tx = AppTx::begin(pool).await?;
    let conversation = conversations::lock_conversation_in_tx(&mut tx, context, &cid).await?;
    conversations::assert_turn_in_tx(&tx, &conversation, run_id, lease)?;
    let objects = proofs
        .iter()
        .flat_map(|(_, result)| result.objects.iter().map(String::as_str));
    let heads = delivery::legacy_checkpoint_heads(&mut tx, context, &sources, objects)
        .await?
        .ok_or(Error::new("stale_context"))?;
    if !available_results(&proofs, &heads).allows(&snapshot, false) {
        return Err(Error::new("stale_context"));
    }
    tx.commit().await?;
    Ok(checkpoint)
}
type ResultProof = (
    super::context_authority::ResultKey,
    delivery::DeliveryResult,
);

async fn verify_checkpoint_results(
    pool: &MySqlPool,
    context: &AccessContext,
    authorities: &[Value],
) -> Result<Vec<ResultProof>> {
    // 历史结果正文仍需原执行身份与当前平台权限。查询状态和归属一次批读后，
    // 释放连接，再向平台核对。结构矩阵与来源链由精读、执行和交付边界核验。
    let mut result_keys = BTreeSet::new();
    for snapshot in authorities {
        result_keys.extend(super::context_authority::result_keys(snapshot, false)?);
    }
    let ids: BTreeSet<_> = result_keys.iter().map(|(id, _, _)| id.as_str()).collect();
    let result_heads =
        delivery::result_heads(pool, context, &ids.into_iter().collect::<Vec<_>>()).await?;
    let mut result_proofs = Vec::new();
    for key in result_keys {
        let (id, reference, historical) = &key;
        let Some(result) = result_heads
            .get(id)
            .filter(|result| &result.reference == reference)
        else {
            continue;
        };
        match queries::platform::result_authority(id, &context.user_id, reference).await {
            Ok(()) => result_proofs.push((key, result.clone())),
            Err(error) if error.code == "result_expired" && *historical => {
                result_proofs.push((key, result.clone()))
            }
            Err(error) if matches!(error.code, "outcome_unknown" | "upstream_failed") => {
                // 交付前只读查证尚未完成，原作业及账本可以等待平台恢复。
                return Err(Error::new("source_unavailable"));
            }
            Err(error)
                if matches!(
                    error.code,
                    "result_expired"
                        | "result_unavailable"
                        | "forbidden"
                        | "not_available"
                        | "invalid_evidence"
                ) => {}
            Err(error) => return Err(error),
        }
    }
    Ok(result_proofs)
}

fn available_results(
    proofs: &[ResultProof],
    heads: &HashMap<String, Value>,
) -> super::context_authority::CheckedTextResults {
    let mut results = super::context_authority::CheckedTextResults::default();
    for (key, result) in proofs {
        results.record_checked_result(
            key.clone(),
            result.objects.iter().all(|id| heads.contains_key(id)),
        );
    }
    results
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
        table_access: None,
    })
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
        table_access: None,
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
    let ctx = &super::knowledge::catalog_context(ctx).await?;
    let cid = runtime::locate_run(pool, &input.run_id).await?;
    let checked = super::task_answers::check_results(pool, ctx, &input.run_id).await?;
    let authorities = delivery::selected_skill_provenance(pool, ctx, &cid)
        .await?
        .iter()
        .map(super::personal_assets::skill_authority)
        .collect::<Result<Vec<_>>>()?;
    let result_proofs = verify_checkpoint_results(pool, ctx, &authorities).await?;
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
    let baseline = projection.baseline();
    if tool.state != "succeeded"
        || receipt["context_reset"].is_null()
        || receipt["context_reset"] != baseline
    {
        return Err(Error::new("stale_context"));
    }
    runtime::assert_tools_settled_in_tx(&mut tx, &run).await?;
    let message = conversations::read_message_in_tx(&mut tx, &conv, &run.message_id).await?;
    let delivery::Workspace {
        tasks,
        assets,
        asset_sources,
        active_source_skills,
        observations,
        input_tasks,
        ..
    } = delivery::workspace(
        &mut tx,
        ctx,
        &message,
        None,
        None,
        result_proofs
            .iter()
            .flat_map(|(_, result)| result.objects.iter().map(String::as_str)),
    )
    .await?;
    // 仅实际来源集合改变时，Pi 从同一会话的新分支接续，不再采用旧分支材料。
    let mut snapshot = super::context_authority::empty();
    snapshot["active_skill_reads"] = json!([]);
    let text_results = available_results(&result_proofs, &asset_sources);
    let WorkspaceAssets {
        memories,
        selected,
        counts: asset_counts,
        selected_provenance,
    } = workspace_assets(
        assets,
        &asset_sources,
        &active_source_skills,
        &text_results,
        &result_proofs,
        &projection,
    )?;
    let mut visible_tasks = Vec::new();
    for task in tasks {
        if projection.scope_known && task["id"] == baseline["task_id"] {
            visible_tasks.insert(0, task);
        } else {
            visible_tasks.push(task_identity(&task));
        }
    }
    visible_tasks.truncate(24.max(input_tasks.len()));
    let mut visible = json!({"request_clock":message.request_clock,"input_task_ids":input_tasks,
        "active_task_ref":baseline,"tasks":visible_tasks,"recent_messages":[],
        "selected_skills":selected,"memories":memories,"query_observations":observations,
        "asset_counts":asset_counts});
    let delivery =
        super::task_answers::reconnect_control_delivery_in_tx(&mut tx, ctx, &conv, &run, &checked)
            .await?;
    visible["control_delivery"] = delivery.control_delivery.unwrap_or(Value::Null);
    visible["frozen_notification_covered"] = json!(delivery.frozen_notification_covered);
    crate::modules::retrieval::bound_workspace(&mut visible);
    observe_previews(&mut snapshot, &visible, &selected_provenance)?;
    snapshot["active_task"] = baseline;
    runtime::save_authority_in_tx(&mut tx, &run.id, &snapshot).await?;
    runtime::save_checkpoint_in_tx(
        &mut tx,
        &run,
        &serde_json::to_value(&input.checkpoint)
            .map_err(|_| crate::types::Error::new("unavailable"))?,
    )
    .await?;
    visible["authority_revision"] = json!(fingerprint(&snapshot));
    visible["authority_snapshot"] = snapshot;
    crate::contracts::validate("WorkspaceContext", &visible)?;
    tx.commit().await?;
    Ok(visible)
}

fn task_identity(task: &Value) -> Value {
    json!({"id":task["id"],"condition_version":task["condition_version"],
        "lifecycle":task["lifecycle"],"phase":task["phase"],"context_complete":false})
}

struct WorkspaceAssets {
    memories: Vec<Value>,
    selected: Vec<Value>,
    counts: Value,
    selected_provenance: HashMap<String, Value>,
}

fn observe_previews(
    snapshot: &mut Value,
    visible: &Value,
    selected_provenance: &HashMap<String, Value>,
) -> Result<()> {
    super::context_authority::observe_workspace_previews(snapshot, visible)?;
    for skill in super::context_authority::items(&visible["selected_skills"]) {
        if let Some(authority) = selected_provenance.get(
            skill["id"]
                .as_str()
                .ok_or(crate::types::Error::new("unavailable"))?,
        ) {
            super::context_authority::merge_skill_preview_sources(snapshot, authority)?;
        }
    }
    Ok(())
}

fn workspace_assets(
    assets: Vec<Value>,
    sources: &HashMap<String, Value>,
    active_source_skills: &HashMap<String, Value>,
    results: &super::context_authority::CheckedTextResults,
    result_proofs: &[ResultProof],
    projection: &super::source_limits::ActiveProjection,
) -> Result<WorkspaceAssets> {
    let mut selected_provenance = HashMap::new();
    let mut memories = Vec::new();
    let mut selected = Vec::new();
    let mut selected_count = 0;
    for asset in assets {
        let dependencies = super::context_authority::items(&asset["dependencies"]);
        if !dependencies.iter().all(|reference| {
            reference["object_id"]
                .as_str()
                .and_then(|id| sources.get(id))
                .is_some_and(|source| source["version"] == reference["version"])
        }) {
            continue;
        }
        let ancestors = super::context_authority::items(&asset["skill_sources"]["source_skills"]);
        let query_sources =
            super::context_authority::items(&asset["skill_sources"]["source_query_results"]);
        let mut authorized_ancestors = Vec::new();
        if asset.get("skill_sources").is_some() {
            let authority = super::personal_assets::skill_authority(&asset)?;
            if !results.allows(&authority, false) {
                continue;
            }
            for pair in ancestors {
                let id = pair[0].as_str().ok_or(Error::new("unavailable"))?;
                if let Some(source) = active_source_skills
                    .get(id)
                    .filter(|source| pair[1] == source["version"])
                {
                    authorized_ancestors.push(source);
                }
            }
            if authorized_ancestors.len() != ancestors.len() {
                continue;
            }
            let id = asset["id"].as_str().ok_or(Error::new("unavailable"))?;
            selected_provenance.insert(id.to_owned(), authority);
        }
        let is_memory = asset["kind"] == "memory";
        // 选用事实与实际交付预览分开，限源过滤后仍保留合法选用计数。
        selected_count += usize::from(!is_memory);
        if !projection.scope_known {
            continue;
        }
        if let Some(gate) = &projection.gate {
            let in_scope = dependencies
                .iter()
                .chain(authorized_ancestors.into_iter().flat_map(|ancestor| {
                    super::context_authority::items(&ancestor["dependencies"])
                }))
                .try_fold(!dependencies.is_empty(), |visible, reference| {
                    let id = reference["object_id"]
                        .as_str()
                        .ok_or(Error::new("unavailable"))?;
                    let object = sources.get(id).ok_or(Error::new("unavailable"))?;
                    Ok::<_, Error>(visible && gate.allows_object(object)?)
                })?;
            if !in_scope
                || !query_sources.iter().all(|pair| {
                    result_proofs.iter().any(|((id, reference, _), result)| {
                        pair[0] == id.as_str()
                            && pair[1] == reference.as_str()
                            && gate.allows_source_arg(&result.target_id)
                    })
                })
            {
                continue;
            }
        }
        if is_memory {
            memories.push(asset);
        } else {
            selected.push(asset);
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
    Ok(WorkspaceAssets {
        memories,
        selected,
        counts,
        selected_provenance,
    })
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

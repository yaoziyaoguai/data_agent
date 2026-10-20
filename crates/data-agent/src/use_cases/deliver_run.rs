use crate::{
    modules::{access, conversations, jobs, runtime},
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
    let location = conversations::locate_conversation(pool, &job.conversation_id).await?;
    let mut context = AccessContext {
        user_id: location.owner_id,
        space_id: location.space_id,
        request_id: id(),
    };
    // 先释放业务锁再查平台结果授权；正式领取时重核所采用的依赖清单。
    let mut preflight = AppTx::begin(pool).await?;
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
    preflight.commit().await?;
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
    let lease_epoch =
        conversations::claim_turn_in_tx(&mut tx, &conversation, &run_id, ttl_ms).await?;
    let (output_id, attempt_id, replaces) = runtime::start_run_in_tx(
        &mut tx,
        runtime::RunStart {
            run_id: &run_id,
            conversation_id: &conversation.id,
            message_id: &message.id,
            recovery_chain_id: &message.recovery_chain_id,
            budget_scope_id: &message.budget_scope_id,
            lease_epoch,
            job_id: &job.id,
            job_lease_epoch: job.lease_epoch,
        },
    )
    .await?;
    let mut checkpoint =
        runtime::read_checkpoint_in_tx(&mut tx, &message.recovery_chain_id).await?;
    let resume_same_input = checkpoint.is_some();
    let mut workspace_context = None;
    if std::env::var("DATA_AGENT_TOOLSET").as_deref() == Ok("data") {
        let mut tasks = crate::modules::analysis::context_in_tx(&mut tx, &conversation.id).await?;
        let input_task_ids =
            conversations::message_task_ids_in_tx(&mut tx, &conversation, &message.id).await?;
        let recent_tasks = conversations::recent_task_ids_in_tx(&mut tx, &conversation).await?;
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
        let memories = crate::modules::assets::list_in_tx(&mut tx, &context, true)
            .await?
            .into_iter()
            .filter(|v| v["kind"] == "memory")
            .collect();
        let mut memories = super::knowledge::valid_assets_in_tx(
            &mut tx,
            &context,
            memories,
            &conversation.id,
            &text_results,
        )
        .await?;
        let selected =
            crate::modules::assets::selected_in_tx(&mut tx, &context, &conversation.id).await?;
        let selected = super::knowledge::valid_assets_in_tx(
            &mut tx,
            &context,
            selected,
            &conversation.id,
            &text_results,
        )
        .await?;
        let asset_counts = json!({"memories":memories.len(),"selected_skills":selected.len()});
        memories.truncate(20);
        let memories = memories
            .into_iter()
            .map(|v| crate::modules::retrieval::model_page(v, 0, 600, None))
            .collect::<Vec<_>>();
        let selected = selected
            .into_iter()
            .take(20)
            .map(|v| crate::modules::assets::skill_files::descriptor(&v))
            .collect::<Vec<_>>();
        if checkpoint.is_none() {
            checkpoint =
                runtime::read_conversation_checkpoint_in_tx(&mut tx, &conversation.id).await?;
        }
        let invalidated = if let Some(previous) = &checkpoint {
            checked.assert_snapshot(&previous["authority_snapshot"])?;
            checked.invalidated
                || super::context_authority::needs_reset_in_tx(
                    &mut tx,
                    &context,
                    &conversation.id,
                    &previous["authority_snapshot"],
                )
                .await?
        } else {
            false
        };
        if invalidated {
            // 丢弃未完成输入的检查点会换SDK调用身份；结束本输入后由新消息重新调查。
            if resume_same_input {
                return Err(Error::new("stale_context"));
            }
            checkpoint = None;
        }
        let mut snapshot = checkpoint
            .as_ref()
            .map(|v| v["authority_snapshot"].clone())
            .unwrap_or_else(super::context_authority::empty);
        // 历史只由Pi恢复；完整原话可经read_conversation分页补读，不再注入300字副本。
        let mut visible = json!({"request_clock":message.request_clock,"input_task_ids":input_task_ids,"tasks":tasks.iter().take(24.max(input_task_ids.len())).map(|t|if invalidated{json!({"id":t["id"],"condition_version":t["condition_version"],"lifecycle":t["lifecycle"],"phase":t["phase"],"context_complete":false,"note":"依据已失效，请重新调查"})}else{t.clone()}).collect::<Vec<_>>(),"recent_messages":[],"selected_skills":selected,"memories":memories,"query_observations":crate::modules::queries::list_in_tx(&mut tx,&conversation.id).await?.iter().rev().take(12).map(|q|json!({"id":q["id"],"task_id":q["task_id"],"condition_version":q["condition_version"],"execution_state":q["execution_state"]})).collect::<Vec<_>>(),"asset_counts":asset_counts});
        // 已失效任务只交付状态，不能把旧口径经初始工作区再次送入模型。
        let mut task_text_dependencies = std::collections::HashMap::new();
        for task in visible["tasks"].as_array_mut().into_iter().flatten() {
            let refs = super::context_authority::protect_task_context_in_tx(
                &mut tx,
                &context,
                &conversation.id,
                task,
                &text_results,
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
        super::context_authority::observe(&mut snapshot, &visible);
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
            json!({"output_id":output_id,"attempt_id":attempt_id,"replaces_attempt_id":previous}),
        )
        .await?;
    }
    jobs::begin_attempt_in_tx(&mut tx, job).await?;
    if let Some(value) = checkpoint {
        checkpoint = Some(runtime::bind_delivery_checkpoint_in_tx(&mut tx, &run_id, &value).await?);
    }
    tx.commit().await?;
    eprintln!(
        "run_started request={} conversation={} run={} epoch={}",
        context.request_id, conversation.id, run_id, lease_epoch
    );
    let envelope = json!({"request_id":message.request_id,"run_id":run_id,"conversation_id":conversation.id,"recovery_chain_id":message.recovery_chain_id,"lease_epoch":lease_epoch.to_string(),"budget_scope_id":message.budget_scope_id,"output_id":output_id,"attempt_id":attempt_id,"message_id":message.id,"text":message.body,"request_clock":message.request_clock,"checkpoint":checkpoint,"model_profile":profile,"workspace_context":workspace_context,"resume_same_input":resume_same_input && checkpoint.is_some()});
    Ok(envelope)
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
        ] {
            assert_eq!(delivery_failure_code(code), json!(code));
        }
        assert_eq!(
            delivery_failure_code("internal_database_detail: synthetic"),
            json!("unavailable")
        );
    }
}

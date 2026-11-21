use super::*;

pub async fn process_due(pool: &MySqlPool, worker: &str) -> Result<bool> {
    let Some(job) = queries::claim_due(pool, worker).await? else {
        return Ok(false);
    };
    let ctx = AccessContext {
        user_id: job["owner_id"].as_str().unwrap_or("").into(),
        space_id: "demo".into(),
        request_id: id(),
    };
    let cid = job["conversation_id"].as_str().unwrap_or("");
    let qid = job["query_id"].as_str().unwrap_or("");
    // 与消息准备相同，两份future并行推进；续租等待查询行锁时不能暂停准备事务。
    let heartbeat = async {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(
            u64::from(queries::LEASE_SECONDS) / 3,
        ));
        loop {
            interval.tick().await;
            if let Err(error) = queries::renew_claim(pool, &job, worker).await {
                if !error.is_transient_storage() {
                    return Err(error);
                }
                eprintln!(
                    "query_prepare_renew_transient query={qid} code={}",
                    error.code
                );
            }
        }
    };
    let prepare = async {
        let mut preflight = AppTx::begin(pool).await?;
        let pending = queries::read_in_tx(&mut preflight, &ctx, qid).await?;
        preflight.commit().await?;
        // unknown 只查证、取消只发送控制操作；不能因旧正文失效而重新提交或中止查证。
        let checked = if pending["execution_state"] == "queued" && pending["cancel_state"] == "none"
        {
            Some(check_text_results(pool, &ctx, cid, Some(qid)).await?)
        } else {
            None
        };
        let mut tx = AppTx::begin(pool).await?;
        let conv = conversations::lock_for_cleanup_in_tx(&mut tx, &ctx, cid).await?;
        analysis::lock_tasks_in_tx(&mut tx, cid).await?;
        let query = queries::read_in_tx(&mut tx, &ctx, qid).await?;
        let authorization_error =
            if query["execution_state"] == "queued" && query["cancel_state"] == "none" {
                match checked.as_ref() {
                    Some(checked) => {
                        match validate_text_in_tx(&mut tx, &ctx, cid, qid, checked).await {
                            Ok(_) => None,
                            Err(error)
                                if matches!(
                                    error.code,
                                    "stale_context"
                                        | "stale_knowledge"
                                        | "not_available"
                                        | "forbidden"
                                        | "invalid_input"
                                ) =>
                            {
                                Some(error.code)
                            }
                            Err(error) => return Err(error),
                        }
                    }
                    None => Some("stale_context"),
                }
            } else {
                None
            };
        let packet = queries::begin_submission_in_tx(&mut tx, &ctx, &job).await?;
        tx.commit().await?;
        Ok::<_, Error>((conv, packet, authorization_error))
    };
    let (conv, packet, authorization_error) = tokio::select! {
        result = prepare => result?,
        result = heartbeat => return result,
    };
    let action = packet["action"].as_str().unwrap_or("lookup");
    let observation = if action == "submit" && authorization_error.is_some() {
        json!({"state":"failed","error":authorization_error})
    } else {
        let path = match action {
            "submit" => "/submit",
            "cancel" => "/cancel",
            _ => "/lookup",
        };
        let payload = if action == "submit" {
            json!({"query_id":qid,"owner_id":ctx.user_id,"sql":packet["sql"],"parameters":packet["parameters"],"target_id":packet["target_id"],"target_version":packet["target_version"]})
        } else {
            json!({"query_id":qid,"owner_id":ctx.user_id})
        };
        match queries::platform::call(path, &payload).await {
            Ok(v) => v,
            Err(e) if action == "cancel" && e.code == "not_available" => {
                json!({"state":"cancelled","error":"platform_confirmed_absent"})
            }
            Err(e)
                if action == "submit"
                    && matches!(
                        e.code,
                        "sql_not_supported"
                            | "invalid_input"
                            | "forbidden"
                            | "idempotency_conflict"
                            | "version_conflict"
                            | "source_version_conflict"
                    ) =>
            {
                json!({"state":"failed","error":e.code})
            }
            Err(e) => json!({"state":"submission_unknown","error":e.code}),
        }
    };
    let mut tx = AppTx::begin(pool).await?;
    let conv = conversations::lock_for_cleanup_in_tx(&mut tx, &ctx, &conv.id).await?;
    analysis::lock_tasks_in_tx(&mut tx, cid).await?;
    if action == "lookup"
        && observation["error"] == "not_available"
        && queries::retry_missing_in_tx(&mut tx, &job).await?
    {
        tx.commit().await?;
        return Ok(true);
    }
    let observation = if action == "lookup" && observation["error"] == "not_available" {
        json!({"state":"failed","error":"submission_retry_exhausted"})
    } else {
        observation
    };
    let v = queries::record_observation_in_tx(&mut tx, &ctx, &job, &observation).await?;
    if let Some(task) = record_terminal_in_tx(&mut tx, &conv, &v).await? {
        if task["lifecycle"] == "cancelled" {
            tx.commit().await?;
            return Ok(true);
        }
        let text = format!(
            "[已确认查询结果事件] query_id={qid}，task_id={}，condition_version={}，state={}。读取这个查询的结果并解释；以该查询实际SQL和已绑定的绝对日期参数为准，不能按本轮时钟重新展开相对日期，保留后来问题的条件。",
            v["task_id"], v["condition_version"], v["execution_state"]
        );
        let budget = job["budget_scope_id"].as_str().unwrap_or("");
        let origin_message_id =
            crate::modules::runtime::budget_message_in_tx(&mut tx, budget).await?;
        if let Some(message) = conversations::enqueue_result_input_in_tx(
            &mut tx,
            &conv,
            &text,
            qid,
            v["task_id"].as_str().unwrap_or(""),
            budget,
            &origin_message_id,
        )
        .await?
        {
            jobs::enqueue_in_tx(&mut tx, cid, &message.id).await?;
            // 活动任务绑定不在完成事务里做：worker完成时刻不持轮租约，晚到查询
            // 会改写其他任务运行中的会话活动范围（04关闭审查修复）。归属在结果
            // 输入自己的交付事务（deliver_run，持租约串行）里落到该查询的任务。
        }
    }
    tx.commit().await?;
    Ok(true)
}

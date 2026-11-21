mod background;
use data_agent::{
    modules::jobs,
    persistence::{self, MySqlPool},
    types::{Error, id},
    use_cases::deliver_run,
};
use std::{
    collections::HashMap,
    env,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::{Notify, Semaphore, watch},
    task::JoinSet,
};

// 空闲退避阶梯：连续无任务时从100ms放缓到2s；一轮处理了任务立即复位。
const BACKOFF_STEPS_MS: [u64; 5] = [100, 250, 500, 1000, 2000];
fn backoff_delay(consecutive_idle: u32) -> Duration {
    Duration::from_millis(BACKOFF_STEPS_MS[(consecutive_idle.min(4)) as usize])
}
fn interactive_delay(consecutive_idle: u32) -> Duration {
    backoff_delay(consecutive_idle.min(2))
}

// 合成验收钩子：按阶段注入一次临时存储故障（claim/context/renew/defer/defer_lease/fail），
// 验证worker不退出、任务可继续。未设置时不产生任何行为差异。
static TEST_STORAGE_FAULTS: Mutex<Option<HashMap<String, u32>>> = Mutex::new(None);
fn storage_fault_injected(phase: &str) -> bool {
    let Ok(mut faults) = TEST_STORAGE_FAULTS.lock() else {
        return false;
    };
    let map = faults.get_or_insert_with(|| {
        env::var("DATA_AGENT_TEST_STORAGE_FAULT")
            .ok()
            .map(|value| {
                value
                    .split(',')
                    .filter(|phase| !phase.is_empty())
                    .map(|phase| (phase.trim().to_owned(), 1))
                    .collect::<HashMap<String, u32>>()
            })
            .unwrap_or_default()
    });
    let configured = map.get(phase).copied().unwrap_or(0);
    if configured == 0 {
        return false;
    }
    map.insert(phase.to_owned(), configured - 1);
    eprintln!("storage_fault_injected phase={phase}");
    true
}

// 只恢复存储边界明确分类的临时故障；同名业务unavailable或永久SQL错误不按临时故障重试。
fn is_transient(error: &Error) -> bool {
    error.is_transient_storage()
}

// 这些错误由Pi完成自身重试/压缩后明确返回。Worker不重新开启模型循环；
// 未知用量/结算保留原调用账本和占额，原ID仍可补结算，不能换一次交付假装未发送。
fn is_terminal_dispatch_failure(code: &str) -> bool {
    matches!(
        code,
        "provider_configuration_invalid"
            | "provider_model_unavailable"
            | "model_unavailable"
            | "model_secret_unavailable"
            | "model_credential_required"
            | "model_capacity_invalid"
            | "invalid_model_endpoint"
            | "invalid_skill_resource"
            | "invalid_skill_receipt"
            | "checkpoint_conflict"
            | "stale_context"
            | "model_run_failed"
            | "model_request_failed"
            | "model_input_limit"
            | "model_output_limit"
            | "model_limits_exceeded"
            | "model_budget_exhausted"
            | "budget_exhausted"
            | "model_auth_failed"
            | "model_quota_exhausted"
            | "model_retry_exhausted"
            | "model_timeout"
            | "model_rate_limited"
            | "model_service_unavailable"
            | "model_network_error"
            | "model_usage_unknown"
            | "model_usage_invalid"
            | "model_finalize_unconfirmed"
            | "model_receipt_unknown"
            | "outcome_unknown"
            | "provider_transport_rejected"
            | "provider_parameters_changed"
            | "provider_payload_invalid"
            | "answer_sources_required"
            | "no_final_output"
            | "invalid_tool_arguments"
    )
}

fn public_dispatch_code(code: &str) -> &str {
    // Pi识别此内部溢出文本；对外保存同源错误码，避免落入unavailable。
    if code == "request_too_large: model_input_limit" {
        "model_input_limit"
    } else {
        code
    }
}

async fn record_delivery_failure<F, Fut>(
    job: &jobs::ClaimedJob,
    code: &str,
    mut operation: F,
) -> Result<(), Error>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<(), Error>>,
{
    for retry in 0..3 {
        let result = if storage_fault_injected("fail") {
            Err(Error::transient_storage())
        } else {
            operation().await
        };
        match result {
            Ok(()) => {
                eprintln!("delivery_failed job={} code={code}", job.id);
                return Ok(());
            }
            Err(error) if is_transient(&error) => {
                // 原job/原因内短重试持久收尾，不重新派发模型，也不清理未知调用占额。
                eprintln!("worker_fail_transient job={} code={}", job.id, error.code);
                if retry < 2 {
                    tokio::time::sleep(Duration::from_millis(50 * (retry + 1))).await;
                }
            }
            Err(error) if error.code == "lease_lost" => {
                eprintln!("worker_fail_lease_lost job={}", job.id);
                return Ok(());
            }
            Err(error) => return Err(error),
        }
    }
    // 持续不可用时不伪称已保存终态，任务仍保留；本轮不扩建跨进程错误恢复账本。
    eprintln!(
        "worker_failure_persistence_unconfirmed job={} code={code}",
        job.id
    );
    Ok(())
}

async fn dispatch_failure_code(response: reqwest::Response) -> String {
    match response.text().await {
        Ok(body) => serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|value| {
                value["code"]
                    .as_str()
                    .filter(|code| !code.is_empty())
                    .map(|code| public_dispatch_code(code).to_owned())
            })
            .unwrap_or_else(|| "unexpected_error".into()),
        Err(_) => "unexpected_error".into(),
    }
}

async fn notify_run_cancelled(
    client: &reqwest::Client,
    url: &str,
    token: &str,
    envelope: &serde_json::Value,
) {
    // 运行权已失效时通知Pi中止生成；精确run/代次不会影响后来持有者，未知用量仍保留。
    let result = client
        .post(format!("{url}/cancel-run"))
        .timeout(Duration::from_secs(2))
        .bearer_auth(token)
        .json(
            &serde_json::json!({"run_id":envelope["run_id"],"lease_epoch":envelope["lease_epoch"]}),
        )
        .send()
        .await;
    if !matches!(result,Ok(ref response) if response.status().is_success()) {
        eprintln!(
            "cancel_notification_unconfirmed run={}",
            envelope["run_id"].as_str().unwrap_or("unknown")
        );
    }
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if env::var("DATA_AGENT_MODE")?.as_str() != "development" {
        return Err("explicit development configuration required".into());
    }
    let pool = persistence::connect_with_default(&env::var("DATA_AGENT_DATABASE_URL")?, 32).await?;
    let worker_id = id();
    let ttl_ms = env::var("DATA_AGENT_LEASE_MS")
        .unwrap_or_else(|_| "15000".into())
        .parse::<u32>()?;
    if !(1000..=120000).contains(&ttl_ms) {
        return Err("invalid lease duration".into());
    }
    let url = env::var("DATA_AGENT_BRIDGE_URL")?;
    let token = env::var("DATA_AGENT_INTERNAL_TOKEN")?;
    let bridge_url = reqwest::Url::parse(&url)?;
    if bridge_url.scheme() != "http"
        || bridge_url.host_str() != Some("127.0.0.1")
        || token.len() < 32
    {
        return Err("loopback bridge and internal token required".into());
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(5))
        .build()?;
    let change_sink =
        reqwest::Url::parse(&env::var("DATA_AGENT_API_URL")?)?.join("/internal/live-changes")?;
    data_agent::live_changes::install(data_agent::live_changes::Publisher::Worker {
        client: client.clone(),
        api: change_sink,
        token: token.clone(),
    })?;
    let concurrency = env::var("DATA_AGENT_DELIVERY_CONCURRENCY")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(16);
    if concurrency == 0 {
        return Err("invalid delivery concurrency".into());
    }
    let semaphore = Arc::new(Semaphore::new(concurrency));
    let (shutdown_tx, mut shutdown) = watch::channel(false);
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let signal_shutdown = shutdown_tx.clone();
    tokio::spawn(async move {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = terminate.recv() => {}
        }
        eprintln!("worker_shutdown_requested");
        signal_shutdown.send_replace(true);
    });
    let data_tools = env::var("DATA_AGENT_TOOLSET").as_deref() == Ok("data");
    // 合成验收可单独推进真实来源队列。
    let source_only =
        data_tools && env::var("DATA_AGENT_TEST_WORKER_ROLE").as_deref() == Ok("source_sync");
    let delivery_ready = Arc::new(Notify::new());
    let query_ready = Arc::new(Notify::new());
    let mut background = if data_tools {
        background::start(
            &pool,
            ttl_ms,
            source_only,
            shutdown.clone(),
            delivery_ready.clone(),
            query_ready.clone(),
        )
    } else {
        JoinSet::new()
    };
    if !source_only {
        background::start_session_cleanup(&pool, &shutdown, &mut background);
    }
    let mut deliveries = JoinSet::new();
    let mut idle = 0u32;
    let dispatch = loop {
        while let Some(result) = deliveries.try_join_next() {
            if let Err(error) = result {
                eprintln!("worker_delivery_join_error {error}");
            }
        }
        if source_only {
            shutdown.changed().await?;
            break Ok(());
        }
        // 先等空闲槽位再领取；等待期间收到停机信号则不再新派。
        let permit = tokio::select! {
            biased;
            _ = shutdown.changed() => break Ok(()),
            permit = Arc::clone(&semaphore).acquire_owned() => match permit {
                Ok(permit) => permit,
                Err(error) => break Err(error.into()),
            },
        };
        let claimed = if storage_fault_injected("claim") {
            Err(Error::transient_storage())
        } else {
            jobs::claim_due(&pool, &worker_id, ttl_ms).await
        };
        match claimed {
            Ok(Some(job)) => {
                idle = 0;
                // 同会话串行由 claim_due 保证，跨会话共用并发槽位。
                let delivery = deliver_job(
                    pool.clone(),
                    client.clone(),
                    url.clone(),
                    token.clone(),
                    job,
                    ttl_ms,
                    permit,
                );
                let ready = query_ready.clone();
                deliveries.spawn(async move {
                    if delivery.await {
                        ready.notify_one();
                    }
                });
                continue;
            }
            Ok(None) => {}
            Err(error) if is_transient(&error) => {
                eprintln!("worker_claim_transient code={}", error.code);
            }
            Err(error) => break Err(error.into()),
        }
        tokio::select! {
            biased;
            _ = shutdown.changed() => break Ok(()),
            _ = delivery_ready.notified() => { idle = 0; continue; }
            _ = tokio::time::sleep(interactive_delay(idle)) => {}
        }
        idle = idle.saturating_add(1);
    };
    shutdown_tx.send_replace(true);
    while let Some(result) = deliveries.join_next().await {
        if let Err(error) = result {
            eprintln!("worker_delivery_join_error {error}");
        }
    }
    while let Some(result) = background.join_next().await {
        result?;
    }
    pool.close().await;
    dispatch
}

// 单条任务的全周期交付协程；并发槽位随协程结束自动释放。
async fn deliver_job(
    pool: MySqlPool,
    client: reqwest::Client,
    url: String,
    token: String,
    job: jobs::ClaimedJob,
    ttl_ms: u32,
    _permit: tokio::sync::OwnedSemaphorePermit,
) -> bool {
    match run_delivery(&pool, &client, &url, &token, &job, ttl_ms).await {
        Ok(()) => true,
        Err(error) => {
            eprintln!("worker_delivery_fatal job={} code={}", job.id, error.code);
            false
        }
    }
}
async fn run_delivery(
    pool: &MySqlPool,
    client: &reqwest::Client,
    url: &str,
    token: &str,
    job: &jobs::ClaimedJob,
    ttl_ms: u32,
) -> Result<(), Error> {
    if job.attempts >= 4 {
        record_delivery_failure(job, "retry_exhausted", || {
            deliver_run::fail_delivery(pool, job, "retry_exhausted")
        })
        .await?;
        return Ok(());
    }
    match deliver_run::start_delivery(pool, job, ttl_ms).await {
        Ok(envelope) => {
            let run_id = envelope["run_id"]
                .as_str()
                .ok_or_else(|| Error::new("unavailable"))?;
            let context = if storage_fault_injected("context") {
                Err(Error::transient_storage())
            } else {
                deliver_run::context_for_run(pool, run_id).await
            };
            let context = match context {
                Ok(context) => context,
                Err(error) if is_transient(&error) => {
                    // 运行已建立但上下文读取暂时失败：退回任务等待会话租约到期后重派，不结束worker。
                    eprintln!(
                        "worker_context_transient run={} code={}",
                        run_id, error.code
                    );
                    if let Err(defer_error) = jobs::defer(pool, job).await {
                        eprintln!(
                            "worker_defer_rejected job={} code={}",
                            job.id, defer_error.code
                        );
                    }
                    return Ok(());
                }
                Err(error) => {
                    record_delivery_failure(job, error.code, || {
                        deliver_run::fail_delivery(pool, job, error.code)
                    })
                    .await?;
                    return Ok(());
                }
            };
            let mut dispatch_envelope = envelope.clone();
            let request = async {
                data_agent::use_cases::personal_memory::prepare_workspace(
                    pool,
                    &context,
                    &mut dispatch_envelope,
                )
                .await
                .map_err(|e| e.code)?;
                client
                    .post(format!("{url}/resume-and-deliver"))
                    // Pi每次调用有超时；宿主按原请求限次并持续续租，不另设整轮截止。
                    .bearer_auth(token)
                    .json(&dispatch_envelope)
                    .send()
                    .await
                    .map_err(|_| "bridge_unavailable")
            };
            tokio::pin!(request);
            // 准备记忆上下文也会持会话锁。续租必须与request同时推进，
            // 不能在select分支内等待续租，饿死持锁的request。
            let lease_epoch = envelope["lease_epoch"]
                .as_str()
                .ok_or_else(|| Error::new("invalid_input"))?
                .parse::<u64>()
                .map_err(|_| Error::new("invalid_input"))?;
            let (stop_heartbeat, mut stopped) = tokio::sync::oneshot::channel::<()>();
            let heartbeat = async {
                let mut interval =
                    tokio::time::interval(Duration::from_millis(u64::from(ttl_ms) / 3));
                loop {
                    tokio::select! {
                        biased;
                        _ = &mut stopped => return None,
                        _ = interval.tick() => {}
                    }
                    let renewed = if storage_fault_injected("renew") {
                        Err(Error::transient_storage())
                    } else {
                        deliver_run::renew_delivery(pool, &context, run_id, lease_epoch, ttl_ms)
                            .await
                    };
                    match renewed {
                        Ok(()) => {}
                        Err(error) if is_transient(&error) => {
                            eprintln!(
                                "delivery_renew_transient job={} code={}",
                                job.id, error.code
                            );
                        }
                        Err(error) => return Some(error),
                    }
                }
            };
            tokio::pin!(heartbeat);
            tokio::select! {
                 result=&mut request=>{
                    // 已开始的数据库续租完成后再退出，避免在BEGIN中途取消连接。
                    let _ = stop_heartbeat.send(());
                    if let Some(error) = heartbeat.await {
                        // 桥接2xx已完成finish并释放租约，此时lease_lost是正常收尾。
                        // 其他结果仍沿下面的拒绝/中断路径处理，保留续租失败诊断。
                        if error.code != "lease_lost"
                            || !matches!(&result, Ok(response) if response.status().is_success())
                        {
                            eprintln!("delivery_renew_after_dispatch job={} code={}", job.id, error.code);
                        }
                    }
                    match result {
                        Ok(response) if response.status()==reqwest::StatusCode::CONFLICT => {
                            let deferred = if storage_fault_injected("defer") {
                                Err(Error::transient_storage())
                            } else {
                                deliver_run::defer_busy_delivery(pool,&context,envelope["run_id"].as_str().ok_or_else(|| Error::new("unavailable"))?,envelope["lease_epoch"].as_str().ok_or_else(|| Error::new("invalid_input"))?.parse::<u64>().map_err(|_| Error::new("invalid_input"))?).await
                            };
                            if let Err(error) = deferred {
                                if is_transient(&error) {
                                    // 桥接未接纳但回退失败：保持领取，租约到期自然重派。
                                    eprintln!("delivery_defer_transient job={} code={}",job.id,error.code);
                                } else {
                                    eprintln!("delivery_defer_rejected job={} code={}",job.id,error.code);
                                }
                            }
                        }
                        Ok(response) if !response.status().is_success() => {
                            let status=response.status().as_u16();
                            let code=dispatch_failure_code(response).await;
                            eprintln!("delivery_interrupted job={} epoch={} status={} code={}",job.id,job.lease_epoch,status,code);
                            if is_terminal_dispatch_failure(&code) {
                                record_delivery_failure(job,&code,||deliver_run::fail_delivery(pool,job,&code)).await?;
                            } else {
                                notify_run_cancelled(client,url,token,&envelope).await;
                            }
                        }
                        Ok(_) => {}
                        Err(transport) => {
                            eprintln!("delivery_interrupted job={} epoch={} transport={:?}",job.id,job.lease_epoch,transport);
                            notify_run_cancelled(client,url,token,&envelope).await;
                        }
                    }
                 }
                 lost=&mut heartbeat=>{
                    if let Some(error) = lost {
                        eprintln!("delivery_lease_lost job={} code={}",job.id,error.code);
                        notify_run_cancelled(client,url,token,&envelope).await;
                    }
                 }
            }
        }
        Err(error) => {
            eprintln!("delivery_rejected job={} code={}", job.id, error.code);
            if is_transient(&error) {
                // 建立运行的事务未确认，不持久化为业务失败；原任务租约到期后核对并恢复。
                eprintln!("worker_start_transient job={} code={}", job.id, error.code);
            } else if error.code == "lease_lost" {
                let deferred = if storage_fault_injected("defer_lease") {
                    Err(Error::transient_storage())
                } else {
                    jobs::defer(pool, job).await
                };
                match deferred {
                    Ok(()) => {}
                    Err(error) if is_transient(&error) => {
                        eprintln!("worker_defer_transient job={} code={}", job.id, error.code);
                    }
                    Err(error) => return Err(error),
                }
            } else {
                record_delivery_failure(job, error.code, || {
                    deliver_run::fail_delivery(pool, job, error.code)
                })
                .await?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completed_provider_failures_are_not_redelivered() {
        for code in [
            "model_capacity_invalid",
            "model_input_limit",
            "model_output_limit",
            "model_budget_exhausted",
            "model_retry_exhausted",
            "model_auth_failed",
            "model_quota_exhausted",
            "model_timeout",
            "provider_configuration_invalid",
            "model_usage_unknown",
            "model_receipt_unknown",
            "model_finalize_unconfirmed",
        ] {
            assert!(is_terminal_dispatch_failure(code), "{code}");
        }
        for code in [
            "unavailable",
            "unexpected_error",
            "bridge_unavailable",
            "run_cancelled",
            "lease_lost",
        ] {
            assert!(!is_terminal_dispatch_failure(code), "{code}");
        }
        assert_eq!(
            public_dispatch_code("request_too_large: model_input_limit"),
            "model_input_limit"
        );
    }

    #[test]
    fn business_unavailability_is_not_a_transient_storage_fault() {
        assert!(!is_transient(&Error::new("unavailable")));
        assert!(is_transient(&Error::transient_storage()));
    }
}

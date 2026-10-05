use data_agent::{modules::jobs, persistence, types::id, use_cases::deliver_run};
use std::{env, time::Duration};

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
    let pool = persistence::connect(&env::var("DATA_AGENT_DATABASE_URL")?).await?;
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
    if env::var("DATA_AGENT_TOOLSET").as_deref() == Ok("data") {
        let prefill_pool = pool.clone();
        tokio::spawn(async move {
            loop {
                if let Err(e) =
                    data_agent::use_cases::semantic_prefill::process_due(&prefill_pool).await
                {
                    eprintln!("prefill_failure code={}", e.code);
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        });
        let index_pool = pool.clone();
        tokio::spawn(async move {
            loop {
                if let Err(e) = data_agent::use_cases::knowledge::process_index(&index_pool).await {
                    eprintln!("knowledge_index_failure code={}", e.code);
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        });
        let memory_pool = pool.clone();
        tokio::spawn(async move {
            loop {
                if let Err(e) =
                    data_agent::use_cases::personal_memory::process_index(&memory_pool).await
                {
                    eprintln!("memory_worker_failure code={}", e.code);
                }
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
        });
        let query_pool = pool.clone();
        let query_worker = id();
        tokio::spawn(async move {
            loop {
                if let Err(e) =
                    data_agent::use_cases::query_workflow::process_due(&query_pool, &query_worker)
                        .await
                {
                    eprintln!("query_worker_failure code={}", e.code);
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        });
    }
    loop {
        if let Some(job) = jobs::claim_due(&pool, &worker_id, ttl_ms).await? {
            if job.attempts >= 4 {
                deliver_run::fail_exhausted(&pool, &job).await?;
                eprintln!("delivery_failed job={} code=retry_exhausted", job.id);
                continue;
            }
            match deliver_run::start_delivery(&pool, &job, ttl_ms).await {
                Ok(envelope) => {
                    let context = deliver_run::context_for_run(
                        &pool,
                        envelope["run_id"].as_str().ok_or("missing run")?,
                    )
                    .await?;
                    let mut dispatch_envelope = envelope.clone();
                    let request = async {
                        data_agent::use_cases::personal_memory::prepare_workspace(
                            &pool,
                            &context,
                            &mut dispatch_envelope,
                        )
                        .await
                        .map_err(|e| e.code)?;
                        client
                            .post(format!("{url}/resume-and-deliver"))
                            // 单次思考和工具循环共用有限运行期限，期间持续续租。
                            .timeout(Duration::from_secs(
                                envelope["model_profile"]["request_call_limit"]
                                    .as_u64()
                                    .unwrap_or(6)
                                    .min(24)
                                    * 90
                                    + 60,
                            ))
                            .bearer_auth(&token)
                            .json(&dispatch_envelope)
                            .send()
                            .await
                            .map_err(|_| "bridge_unavailable")
                    };
                    tokio::pin!(request);
                    let mut heartbeat =
                        tokio::time::interval(Duration::from_millis(u64::from(ttl_ms) / 3));
                    heartbeat.tick().await;
                    loop {
                        tokio::select! {
                         result=&mut request=>{
                            if matches!(result,Ok(ref r) if r.status()==reqwest::StatusCode::CONFLICT) {
                                if let Err(error)=deliver_run::defer_busy_delivery(&pool,&context,envelope["run_id"].as_str().ok_or("missing run")?,envelope["lease_epoch"].as_str().ok_or("missing epoch")?.parse()?).await {
                                    eprintln!("delivery_defer_rejected job={} code={}",job.id,error.code);
                                }
                            } else if !matches!(result,Ok(ref r) if r.status().is_success()) {
                                eprintln!("delivery_interrupted job={} epoch={} status={:?}",job.id,job.lease_epoch,result.as_ref().map(|r|r.status().as_u16()));
                                notify_run_cancelled(&client,&url,&token,&envelope).await;
                            }
                            break;
                         }
                         _=heartbeat.tick()=>{if deliver_run::renew_delivery(&pool,&context,envelope["run_id"].as_str().ok_or("missing run")?,envelope["lease_epoch"].as_str().ok_or("missing epoch")?.parse()?,ttl_ms).await.is_err(){eprintln!("delivery_lease_lost job={}",job.id);notify_run_cancelled(&client,&url,&token,&envelope).await;break;}}
                        }
                    }
                }
                Err(error) => {
                    eprintln!("delivery_rejected job={} code={}", job.id, error.code);
                    if error.code == "lease_lost" {
                        jobs::defer(&pool, &job).await?;
                    } else {
                        deliver_run::fail_exhausted(&pool, &job).await?;
                    }
                }
            }
        } else {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}

use data_agent::{
    contracts::{self, generated::RunEnvelope},
    modules::{analysis, conversations, jobs, runtime},
    persistence::{self, AppTx},
    types::{AccessContext, fingerprint, id},
    use_cases::{data_tools, deliver_run},
};
use serde_json::{Value, json};
use sqlx::MySqlPool;
use std::process::Command;

fn envelope() -> Value {
    json!({
        "request_id":"synthetic-version-request", "run_id":"synthetic-run",
        "conversation_id":"synthetic-conversation", "recovery_chain_id":"synthetic-chain",
        "lease_epoch":"1", "budget_scope_id":"synthetic-budget", "output_id":"synthetic-output",
        "attempt_id":"synthetic-attempt", "message_id":"synthetic-message", "text":"合成版本恢复输入",
        "checkpoint":null, "model_profile":null
    })
}

#[test]
fn historical_envelopes_default_to_one_and_explicit_versions_decode() {
    let historical: RunEnvelope = contracts::decode("RunEnvelope", envelope()).unwrap();
    assert_eq!(historical.tool_contract_version.unwrap_or(1), 1);
    for version in [1, 2] {
        let mut value = envelope();
        value["tool_contract_version"] = json!(version);
        let decoded: RunEnvelope = contracts::decode("RunEnvelope", value).unwrap();
        assert_eq!(decoded.tool_contract_version, Some(version));
    }
}

fn fixture_database(name: &str) -> String {
    let databases: Value = serde_json::from_str(
        &std::env::var("DATA_AGENT_CONTRACT_DATABASES").expect("isolated contract runner"),
    )
    .unwrap();
    let url = databases[name]
        .as_str()
        .expect("own fixture database")
        .to_owned();
    assert!(
        url.rsplit('/')
            .next()
            .unwrap()
            .starts_with("data_agent_test_")
    );
    url
}

async fn lease_sample(
    pool: &MySqlPool,
    job: &jobs::ClaimedJob,
    started: std::time::Instant,
    stage: &str,
) -> Result<Value, sqlx::Error> {
    let sample = sqlx::query_scalar::<_, Value>("SELECT JSON_OBJECT('utc',CAST(UTC_TIMESTAMP(6) AS CHAR),'lease_until',CAST(lease_until AS CHAR),'remaining_us',TIMESTAMPDIFF(MICROSECOND,UTC_TIMESTAMP(6),lease_until),'job',id,'conversation',conversation_id,'message',message_id,'owner',lease_owner,'epoch',lease_epoch,'attempts',attempts,'state',state,'valid',lease_until>UTC_TIMESTAMP(3)) FROM background_jobs WHERE id=?")
        .bind(&job.id).fetch_one(pool).await;
    println!(
        "lease_sample stage={stage} elapsed_ms={} sample={}",
        started.elapsed().as_millis(),
        sample
            .as_ref()
            .map(|value| value.to_string())
            .unwrap_or_else(|_| "storage_error".into())
    );
    sample
}

async fn message(pool: &MySqlPool, ctx: &AccessContext) -> jobs::ClaimedJob {
    let mut tx = AppTx::begin(pool).await.unwrap();
    let cid = conversations::create_conversation_in_tx(&mut tx, ctx, &id())
        .await
        .unwrap();
    let conversation = conversations::lock_conversation_in_tx(&mut tx, ctx, &cid)
        .await
        .unwrap();
    let input = conversations::accept_message_in_tx(
        &mut tx,
        &conversation,
        &id(),
        "合成版本恢复输入",
        &fingerprint(&json!("合成版本恢复输入")),
        &ctx.request_id,
    )
    .await
    .unwrap();
    runtime::open_budget_scope_in_tx(&mut tx, &input.budget_scope_id, &input.id, None)
        .await
        .unwrap();
    jobs::enqueue_in_tx(&mut tx, &cid, &input.id).await.unwrap();
    tx.commit().await.unwrap();
    let expected_job: String =
        sqlx::query_scalar("SELECT id FROM background_jobs WHERE message_id=?")
            .bind(&input.id)
            .fetch_one(pool)
            .await
            .unwrap();
    let job = jobs::claim_due(pool, "synthetic-version-worker", 120000)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (&job.id, &job.conversation_id, &job.message_id),
        (&expected_job, &cid, &input.id),
        "领取必须属于本场景刚创建的job/会话/消息"
    );
    assert_eq!(job.lease_epoch, 1);
    assert_eq!(job.attempts, 0);
    assert_eq!(job.worker_id, "synthetic-version-worker");
    job
}

// 仅使用随机隔离库，直接推进真实交付事务；不启动Worker、Pi或模型端点。
#[tokio::test]
#[ignore = "requires exclusive isolated MySQL fixture; never runs against a daily service"]
async fn delivery_preparation_longer_than_ttl_does_not_burn_an_undispatched_attempt() {
    let url = fixture_database(
        "delivery_preparation_longer_than_ttl_does_not_burn_an_undispatched_attempt",
    );
    let pool = persistence::connect(&url).await.unwrap();
    let ctx = AccessContext {
        user_id: "synthetic-lease-owner".into(),
        space_id: "synthetic-lease-space".into(),
        request_id: "synthetic-lease-request".into(),
        table_access: None,
    };
    let observed = std::time::Instant::now();
    let initial_job = message(&pool, &ctx).await;
    lease_sample(&pool, &initial_job, observed, "initial_claim")
        .await
        .unwrap();
    let initial = deliver_run::start_delivery(&pool, &initial_job, 120000)
        .await
        .unwrap()
        .envelope;
    deliver_run::defer_busy_delivery(
        &pool,
        &ctx,
        initial["run_id"].as_str().unwrap(),
        initial["lease_epoch"].as_str().unwrap().parse().unwrap(),
    )
    .await
    .unwrap();
    // 连接和旧run锁属于夹具准备，短TTL从首次有效领取后才开始覆盖被测等待。
    let mut held = pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM agent_runs WHERE id=? FOR UPDATE")
        .bind(initial["run_id"].as_str().unwrap())
        .fetch_one(&mut *held)
        .await
        .unwrap();
    let ttl_ms = 1000;
    let waiting = std::time::Instant::now();
    let job = loop {
        if let Some(job) = jobs::claim_due(&pool, "synthetic-lease-recovery-worker", ttl_ms)
            .await
            .unwrap()
        {
            break job;
        }
        let state = lease_sample(&pool, &initial_job, observed, "waiting_until_claimable")
            .await
            .unwrap();
        assert!(
            waiting.elapsed() < std::time::Duration::from_secs(5),
            "原job须在夹具准备期限内可领取，数据库实际状态：{state}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    };
    assert_eq!(
        (&job.id, &job.conversation_id, &job.message_id),
        (
            &initial_job.id,
            &initial_job.conversation_id,
            &initial_job.message_id
        )
    );
    assert_eq!(job.lease_epoch, initial_job.lease_epoch + 1);
    assert_eq!(job.attempts, 0);
    lease_sample(&pool, &job, observed, "recovery_claim")
        .await
        .unwrap();
    lease_sample(&pool, &job, observed, "run_lock_held_before_entry")
        .await
        .unwrap();
    let started = std::time::Instant::now();
    let release = async {
        // 只采样；必须先释放锁，再报告准备分支的原错误和所有严格断言。
        let mut preparing = Ok(false);
        for _ in 0..500 {
            match sqlx::query("SELECT id FROM conversations WHERE id=? FOR UPDATE NOWAIT")
                .bind(&job.conversation_id)
                .fetch_one(&pool)
                .await
            {
                Ok(_) => tokio::time::sleep(std::time::Duration::from_millis(10)).await,
                Err(error) => {
                    preparing = if error.as_database_error().is_some_and(|error| {
                        error
                            .downcast_ref::<sqlx::mysql::MySqlDatabaseError>()
                            .number()
                            == 3572
                    }) {
                        Ok(true)
                    } else {
                        Err(error)
                    };
                    break;
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(2500)).await;
        let during = lease_sample(&pool, &job, observed, "before_run_unlock").await;
        let unlocked = held.commit().await;
        (preparing, during, unlocked)
    };
    let (result, (preparing, during, unlocked)) =
        tokio::join!(deliver_run::start_delivery(&pool, &job, ttl_ms), release);
    println!(
        "lease_prepare_result code={}",
        result
            .as_ref()
            .map(|_| "ready")
            .unwrap_or_else(|error| error.code)
    );
    assert!(result.is_ok(), "原准备结果：{result:?}");
    unlocked.unwrap();
    assert!(preparing.unwrap(), "恢复准备必须已锁会话并等原run");
    assert_eq!(during.unwrap()["valid"], true);
    lease_sample(&pool, &job, observed, "after_run_unlock")
        .await
        .unwrap();
    let state: sqlx::types::Json<Value> = sqlx::query_scalar(
        "SELECT JSON_OBJECT('attempts',j.attempts,'job_epoch',j.lease_epoch,
          'job_valid',j.lease_until>UTC_TIMESTAMP(3),'conversation_valid',c.lease_until>UTC_TIMESTAMP(3),
          'runs',(SELECT COUNT(*) FROM agent_runs r WHERE r.message_id=m.id),
          'model_calls',(SELECT COUNT(*) FROM model_call_attempts a WHERE a.budget_scope_id=m.budget_scope_id),
          'issued',(SELECT issued_calls FROM budget_scopes b WHERE b.id=m.budget_scope_id),
          'scope',m.budget_scope_id,'chain',m.recovery_chain_id)
         FROM background_jobs j JOIN conversation_messages m ON m.id=j.message_id
         JOIN conversations c ON c.id=j.conversation_id WHERE j.id=?",
    ).bind(&job.id).fetch_one(&pool).await.unwrap();
    println!(
        "lease-preparation={}",
        json!({"elapsed_ms":started.elapsed().as_millis(),
        "result":result.as_ref().map(|_| "ready").unwrap_or_else(|e| e.code),"state":state.0})
    );
    assert!(
        started.elapsed().as_millis() >= 2500,
        "必须实际覆盖超过TTL的准备等待"
    );
    let envelope = result.unwrap().envelope;
    assert_eq!(state.0["attempts"], 1);
    assert_eq!(state.0["runs"], 2);
    assert_eq!(state.0["job_epoch"], job.lease_epoch);
    assert_eq!(state.0["job_valid"], true);
    assert_eq!(state.0["conversation_valid"], true);
    assert_eq!(state.0["model_calls"], 0);
    assert_eq!(state.0["issued"], 0);
    assert_eq!(envelope["budget_scope_id"], state.0["scope"]);
    assert_eq!(envelope["recovery_chain_id"], state.0["chain"]);
    for key in [
        "budget_scope_id",
        "recovery_chain_id",
        "output_id",
        "message_id",
    ] {
        assert_eq!(envelope[key], initial[key], "恢复保留原{key}");
    }
    deliver_run::renew_delivery(
        &pool,
        &ctx,
        envelope["run_id"].as_str().unwrap(),
        envelope["lease_epoch"].as_str().unwrap().parse().unwrap(),
        ttl_ms,
    )
    .await
    .unwrap();
    pool.close().await;
}

#[tokio::test]
#[ignore = "requires exclusive isolated MySQL fixture; never runs against a daily service"]
async fn delivery_preparation_maintains_claim_while_waiting_for_conversation_lock() {
    let url = fixture_database(
        "delivery_preparation_maintains_claim_while_waiting_for_conversation_lock",
    );
    let pool = persistence::connect(&url).await.unwrap();
    let ctx = AccessContext {
        user_id: "synthetic-lease-owner".into(),
        space_id: "synthetic-lease-space".into(),
        request_id: "synthetic-claim-request".into(),
        table_access: None,
    };
    let observed = std::time::Instant::now();
    let job = message(&pool, &ctx).await;
    lease_sample(&pool, &job, observed, "initial_claim")
        .await
        .unwrap();
    let ttl_ms = 1000;
    let mut held = pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM conversations WHERE id=? FOR UPDATE")
        .bind(&job.conversation_id)
        .fetch_one(&mut *held)
        .await
        .unwrap();
    jobs::renew_claim(&pool, &job, ttl_ms).await.unwrap();
    lease_sample(&pool, &job, observed, "short_claim")
        .await
        .unwrap();
    lease_sample(&pool, &job, observed, "conversation_lock_held_before_entry")
        .await
        .unwrap();
    let started = std::time::Instant::now();
    let release = async {
        tokio::time::sleep(std::time::Duration::from_millis(2500)).await;
        let during = lease_sample(&pool, &job, observed, "before_conversation_unlock").await;
        let unlocked = held.commit().await;
        (during, unlocked)
    };
    let (result, (during, unlocked)) =
        tokio::join!(deliver_run::start_delivery(&pool, &job, ttl_ms), release);
    println!(
        "lease_prepare_result code={}",
        result
            .as_ref()
            .map(|_| "ready")
            .unwrap_or_else(|error| error.code)
    );
    assert!(result.is_ok(), "锁外准备必须沿原job心跳覆盖TTL: {result:?}");
    unlocked.unwrap();
    let during = during.unwrap();
    assert_eq!(
        json!({"attempts":during["attempts"],"epoch":during["epoch"],"valid":during["valid"]}),
        json!({"attempts":0,"epoch":job.lease_epoch,"valid":true})
    );
    assert!(started.elapsed().as_millis() >= 2500);
    let envelope = result.unwrap().envelope;
    let state: Value = sqlx::query_scalar("SELECT JSON_OBJECT('attempts',j.attempts,'job_valid',j.lease_until>UTC_TIMESTAMP(3),'conversation_valid',c.lease_until>UTC_TIMESTAMP(3),'scope',m.budget_scope_id,'chain',m.recovery_chain_id,'issued',b.issued_calls,'model_calls',(SELECT COUNT(*) FROM model_call_attempts a WHERE a.budget_scope_id=b.id)) FROM background_jobs j JOIN conversations c ON c.id=j.conversation_id JOIN conversation_messages m ON m.id=j.message_id JOIN budget_scopes b ON b.id=m.budget_scope_id WHERE j.id=?")
        .bind(&job.id).fetch_one(&pool).await.unwrap();
    assert_eq!(state["attempts"], 1);
    assert_eq!(state["job_valid"], true);
    assert_eq!(state["conversation_valid"], true);
    assert_eq!(state["issued"], 0);
    assert_eq!(state["model_calls"], 0);
    assert_eq!(envelope["budget_scope_id"], state["scope"]);
    assert_eq!(envelope["recovery_chain_id"], state["chain"]);
    lease_sample(&pool, &job, observed, "after_conversation_unlock")
        .await
        .unwrap();

    // 数据库时钟在虚拟机里，宿主高负载时会落后于本机睡眠，余量要盖住这段偏差。
    tokio::time::sleep(std::time::Duration::from_millis(u64::from(ttl_ms) + 350)).await;
    let expired = lease_sample(&pool, &job, observed, "actually_expired")
        .await
        .unwrap();
    assert_eq!(expired["valid"], false);
    assert_eq!(
        jobs::renew_claim(&pool, &job, ttl_ms)
            .await
            .unwrap_err()
            .code,
        "lease_lost"
    );
    assert_eq!(
        deliver_run::start_delivery(&pool, &job, ttl_ms)
            .await
            .unwrap_err()
            .code,
        "lease_lost"
    );
    let after_expired = lease_sample(&pool, &job, observed, "expired_rejected")
        .await
        .unwrap();
    for field in ["lease_until", "owner", "epoch", "attempts", "state"] {
        assert_eq!(
            after_expired[field], expired[field],
            "过期领取不能续活或提交attempt：{field}"
        );
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM agent_runs WHERE message_id=?")
            .bind(&job.message_id)
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
    let next = jobs::claim_due(&pool, "synthetic-next-claim-worker", ttl_ms)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (&next.id, &next.conversation_id, &next.message_id),
        (&job.id, &job.conversation_id, &job.message_id)
    );
    assert_eq!(next.lease_epoch, job.lease_epoch + 1);
    assert_eq!(next.attempts, 1);
    assert_eq!(
        jobs::renew_claim(&pool, &job, ttl_ms)
            .await
            .unwrap_err()
            .code,
        "lease_lost"
    );
    let mut wrong_owner = next.clone();
    wrong_owner.worker_id = "synthetic-wrong-worker".into();
    assert_eq!(
        jobs::renew_claim(&pool, &wrong_owner, ttl_ms)
            .await
            .unwrap_err()
            .code,
        "lease_lost"
    );
    let after_replacement =
        lease_sample(&pool, &next, observed, "old_epoch_and_wrong_owner_rejected")
            .await
            .unwrap();
    assert_eq!(after_replacement["epoch"], next.lease_epoch);
    assert_eq!(after_replacement["owner"], next.worker_id);
    assert_eq!(after_replacement["attempts"], 1);
    assert_eq!(after_replacement["valid"], true);
    pool.close().await;
}

fn deliver_in_new_process(
    database_url: &str,
    job: &jobs::ClaimedJob,
    version: &str,
    collection: &str,
) -> Value {
    deliver_with_environment(database_url, job, version, collection, &[])
}

fn deliver_with_environment(
    database_url: &str,
    job: &jobs::ClaimedJob,
    version: &str,
    collection: &str,
    overrides: &[(&str, &str)],
) -> Value {
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--exact", "delivery_process", "--nocapture"])
        .env("DATA_AGENT_DATABASE_URL", database_url)
        .env("DATA_AGENT_MODE", "development")
        .env("DATA_AGENT_PROVIDER_TEST", "1")
        .env("DATA_AGENT_TOOLSET", "synthetic-version-ledger")
        .env("DATA_AGENT_TOOL_CONTRACT_VERSION", version)
        .env("DATA_AGENT_VECTOR_URL", "http://127.0.0.1:19530")
        .env("DATA_AGENT_VECTOR_COLLECTION", collection)
        .env(
            "DATA_AGENT_VERSION_TEST_JOB",
            json!({"id":job.id,"conversation_id":job.conversation_id,"message_id":job.message_id,
                "lease_epoch":job.lease_epoch,"worker_id":job.worker_id,"attempts":job.attempts})
            .to_string(),
        )
        .envs(overrides.iter().copied())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "delivery process failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let envelope: Value = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .find_map(|line| line.strip_prefix("version-envelope=").map(str::to_owned))
        .map(|line| serde_json::from_str(&line).unwrap())
        .expect("delivery process must return its actual envelope");
    assert_eq!(envelope["conversation_id"], job.conversation_id);
    assert_eq!(envelope["message_id"], job.message_id);
    envelope
}

#[tokio::test]
#[ignore = "only invoked by the isolated version recovery test"]
async fn delivery_process() {
    let value: Value = serde_json::from_str(
        &std::env::var("DATA_AGENT_VERSION_TEST_JOB").expect("isolated parent process"),
    )
    .unwrap();
    let job = jobs::ClaimedJob {
        id: value["id"].as_str().unwrap().into(),
        conversation_id: value["conversation_id"].as_str().unwrap().into(),
        message_id: value["message_id"].as_str().unwrap().into(),
        lease_epoch: value["lease_epoch"].as_u64().unwrap(),
        worker_id: value["worker_id"].as_str().unwrap().into(),
        attempts: value["attempts"].as_u64().unwrap() as u32,
    };
    let url = std::env::var("DATA_AGENT_DATABASE_URL").expect("isolated MySQL fixture");
    assert!(
        url.rsplit('/')
            .next()
            .unwrap()
            .starts_with("data_agent_test_")
    );
    let pool = persistence::connect(&url).await.unwrap();
    let value = deliver_run::start_delivery(&pool, &job, 120000)
        .await
        .unwrap()
        .envelope;
    contracts::validate("RunEnvelope", &value).unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let run = runtime::lock_run_in_tx(
        &mut tx,
        value["run_id"].as_str().unwrap(),
        &job.conversation_id,
    )
    .await
    .unwrap();
    assert_eq!(run.job_id, job.id);
    assert_eq!(run.job_lease_epoch, job.lease_epoch);
    assert_eq!(run.message_id, job.message_id);
    tx.commit().await.unwrap();
    println!("version-envelope={value}");
    pool.close().await;
}

#[tokio::test]
#[ignore = "requires exclusive isolated MySQL fixture; never runs against a daily service"]
async fn historical_receipts_keep_identity_when_recovery_uses_current_tools() {
    let url =
        fixture_database("historical_receipts_keep_identity_when_recovery_uses_current_tools");
    let pool = MySqlPool::connect(&url).await.unwrap();
    let migrations = sqlx::migrate!("../../migrations");
    migrations.run_to(202610260003, &pool).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='agent_runs' AND column_name='tool_contract_version'")
            .fetch_one(&pool).await.unwrap(),
        0,
        "历史样本必须由真实旧结构建立"
    );
    let ctx = AccessContext {
        user_id: "synthetic-version-owner".into(),
        space_id: "synthetic-version-space".into(),
        request_id: "synthetic-version-request".into(),
        table_access: None,
    };
    // 按旧writer建立数字scope；当前无上限入口不能用于迁移前的NOT NULL结构。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let cid = conversations::create_conversation_in_tx(&mut tx, &ctx, &id())
        .await
        .unwrap();
    let conversation = conversations::lock_conversation_in_tx(&mut tx, &ctx, &cid)
        .await
        .unwrap();
    let input = conversations::accept_message_in_tx(
        &mut tx,
        &conversation,
        &id(),
        "合成版本恢复输入",
        &fingerprint(&json!("合成版本恢复输入")),
        &ctx.request_id,
    )
    .await
    .unwrap();
    jobs::enqueue_in_tx(&mut tx, &cid, &input.id).await.unwrap();
    tx.commit().await.unwrap();
    sqlx::query("INSERT INTO budget_scopes(id,message_id,call_limit) VALUES(?,?,24)")
        .bind(&input.budget_scope_id)
        .bind(&input.id)
        .execute(&pool)
        .await
        .unwrap();
    let expected_job: String =
        sqlx::query_scalar("SELECT id FROM background_jobs WHERE message_id=?")
            .bind(&input.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    let job = jobs::claim_due(&pool, "synthetic-version-worker", 120000)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (&job.id, &job.conversation_id, &job.message_id),
        (&expected_job, &cid, &input.id)
    );
    let legacy_run = id();
    let legacy_output = id();
    let legacy_attempt = id();
    // 先建立迁移前的真实历史行，再应用版本迁移。
    sqlx::query("INSERT INTO agent_runs(id,conversation_id,message_id,recovery_chain_id,budget_scope_id,lease_epoch,state,output_id,attempt_id,job_id,job_lease_epoch) SELECT ?,conversation_id,id,recovery_chain_id,budget_scope_id,1,'interrupted',?,?,?,? FROM conversation_messages WHERE id=?")
        .bind(&legacy_run).bind(&legacy_output).bind(&legacy_attempt).bind(&job.id).bind(job.lease_epoch)
        .bind(&job.message_id).execute(&pool).await.unwrap();
    let arguments = json!({"sql":"legacy accepted syntax"});
    let fp = fingerprint(&json!({"name":"cancel_query","arguments":arguments}));
    let old_receipt = json!({"operation_id":id(),"tool_name":"cancel_query","data":{"legacy_body":"旧合同已提交正文","cursor":"old-next"}});
    let rejection = json!({"operation_id":id(),"tool_name":"cancel_query","data":{"error":"invalid_input","hint":"旧合同明确拒绝"}});
    for (sdk_id, state, receipt) in [
        ("legacy-succeeded", "succeeded", &old_receipt),
        ("legacy-rejected", "rejected", &rejection),
    ] {
        sqlx::query("INSERT INTO tool_calls(operation_id,conversation_id,recovery_chain_id,sdk_tool_call_id,origin_run_id,tool_name,arguments_fingerprint,state,receipt) SELECT ?,conversation_id,recovery_chain_id,?,?,'cancel_query',?,?,? FROM conversation_messages WHERE id=?")
            .bind(receipt["operation_id"].as_str().unwrap()).bind(sdk_id).bind(&legacy_run)
            .bind(&fp).bind(state).bind(sqlx::types::Json(receipt)).bind(&job.message_id)
            .execute(&pool).await.unwrap();
    }
    migrations.run(&pool).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, u8>("SELECT tool_contract_version FROM agent_runs WHERE id=?")
            .bind(&legacy_run)
            .fetch_one(&pool)
            .await
            .unwrap(),
        1,
        "迁移补列后旧运行仍默认合同1"
    );
    let resumed = deliver_in_new_process(&url, &job, "2", "data_agent_test_tool_contract");
    assert_eq!(
        resumed["tool_contract_version"], 2,
        "恢复的新运行只用现行工具，原登记回执版本独立保存"
    );
    assert_eq!(resumed["output_id"], legacy_output);
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let run = runtime::lock_run_in_tx(
        &mut tx,
        resumed["run_id"].as_str().unwrap(),
        &job.conversation_id,
    )
    .await
    .unwrap();
    assert_eq!(run.tool_contract_version, 2);
    for (sdk_id, receipt) in [
        ("legacy-succeeded", &old_receipt),
        ("legacy-rejected", &rejection),
    ] {
        let tool = runtime::lock_tool_call_in_tx(&mut tx, &run, sdk_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(tool.tool_contract_version, 1);
        assert_eq!(tool.operation_id, receipt["operation_id"]);
        assert_eq!(tool.origin_run_id, legacy_run);
        assert_eq!(tool.fingerprint, fp);
        assert_eq!(tool.receipt.as_ref(), Some(receipt));
    }
    tx.commit().await.unwrap();
    // 原Schema已不接受的参数仍须先接原成功/拒绝回执，不能重新登记未知副作用。
    let input = json!({"run_id":resumed["run_id"],"lease_epoch":resumed["lease_epoch"],
        "sdk_tool_call_id":"legacy-succeeded","tool_name":"cancel_query","arguments":arguments,
        "checkpoint":{"sdk_version":"1.3.0","entries":[],"leaf_id":null}});
    assert_eq!(
        data_tools::register(&pool, &ctx, input.clone())
            .await
            .unwrap()["operation_id"],
        old_receipt["operation_id"]
    );
    assert_eq!(
        data_tools::invoke(&pool, &ctx, input.clone())
            .await
            .unwrap(),
        old_receipt
    );
    assert_eq!(
        data_tools::invoke(&pool, &ctx, input.clone())
            .await
            .unwrap(),
        old_receipt
    );
    let mut rejected = input.clone();
    rejected["sdk_tool_call_id"] = json!("legacy-rejected");
    assert_eq!(
        data_tools::recorded_rejection(&pool, &ctx, rejected.clone())
            .await
            .unwrap(),
        rejection
    );
    assert_eq!(
        data_tools::invoke(&pool, &ctx, rejected).await.unwrap(),
        rejection
    );
    let mut other = ctx.clone();
    other.user_id = "synthetic-other-user".into();
    assert_eq!(
        data_tools::register(&pool, &other, input.clone())
            .await
            .unwrap_err()
            .code,
        "not_available"
    );
    let mut wrong_lease = input.clone();
    wrong_lease["lease_epoch"] = json!("0");
    assert_eq!(
        data_tools::register(&pool, &ctx, wrong_lease)
            .await
            .unwrap_err()
            .code,
        "lease_lost"
    );
    let mut changed = input;
    changed["arguments"] = json!({"sql":"changed business arguments"});
    assert_eq!(
        data_tools::register(&pool, &ctx, changed)
            .await
            .unwrap_err()
            .code,
        "idempotency_conflict"
    );
    pool.close().await;
}

#[tokio::test]
#[ignore = "requires exclusive isolated MySQL fixture; never runs against a daily service"]
async fn fresh_messages_use_current_tools_independent_of_inherited_configuration() {
    let url =
        fixture_database("fresh_messages_use_current_tools_independent_of_inherited_configuration");
    let pool = persistence::connect(&url).await.unwrap();
    let ctx = AccessContext {
        user_id: "synthetic-version-owner".into(),
        space_id: "synthetic-version-space".into(),
        request_id: "synthetic-version-request".into(),
        table_access: None,
    };
    for (version, collection, overrides) in [
        ("", "data_agent_test_tool_contract", vec![]),
        ("1", "data_agent_test_tool_contract", vec![]),
        ("2", "data_agent_shared_qwen1024", vec![]),
        (
            "2",
            "data_agent_test_tool_contract",
            vec![("DATA_AGENT_PROVIDER_TEST", "0")],
        ),
        (
            "2",
            "data_agent_test_tool_contract",
            vec![("DATA_AGENT_MODE", "production")],
        ),
        ("2", "", vec![("DATA_AGENT_VECTOR_URL", "")]),
    ] {
        let job = message(&pool, &ctx).await;
        let result = deliver_with_environment(&url, &job, version, collection, &overrides);
        assert_eq!(
            result["tool_contract_version"], 2,
            "新消息采用现行合同，遗留环境变量、模型和索引配置均不能切回旧合同"
        );
        let mut tx = AppTx::begin(&pool).await.unwrap();
        let run = runtime::lock_run_in_tx(
            &mut tx,
            result["run_id"].as_str().unwrap(),
            &job.conversation_id,
        )
        .await
        .unwrap();
        assert_eq!(run.tool_contract_version, 2);
        jobs::cancel_message_job_in_tx(&mut tx, &job.message_id)
            .await
            .unwrap();
        tx.commit().await.unwrap();
    }
    pool.close().await;
}

#[tokio::test]
#[ignore = "requires exclusive isolated MySQL fixture; never runs against a daily service"]
async fn run_version_is_frozen_across_process_recovery() {
    let url = fixture_database("run_version_is_frozen_across_process_recovery");
    let pool = persistence::connect(&url).await.unwrap();
    let ctx = AccessContext {
        user_id: "synthetic-version-owner".into(),
        space_id: "synthetic-version-space".into(),
        request_id: "synthetic-version-request".into(),
        table_access: None,
    };
    let job = message(&pool, &ctx).await;
    let first = deliver_in_new_process(&url, &job, "2", "data_agent_test_tool_contract");
    assert_eq!(first["tool_contract_version"], 2, "受控新运行应显式发2");
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let run = runtime::lock_run_in_tx(
        &mut tx,
        first["run_id"].as_str().unwrap(),
        &job.conversation_id,
    )
    .await
    .unwrap();
    assert_eq!(run.tool_contract_version, 2);
    let arguments = json!({"query":"合成版本工具"});
    let fp = fingerprint(&json!({"name":"search_knowledge","arguments":arguments}));
    let operation = runtime::register_named_tool_in_tx(
        &mut tx,
        &run,
        "current-call|synthetic-item",
        &fp,
        "search_knowledge",
    )
    .await
    .unwrap();
    let tool = runtime::lock_tool_call_in_tx(&mut tx, &run, "current-call|synthetic-item")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(tool.tool_contract_version, 2);
    let receipt = json!({"operation_id":operation,"tool_name":"search_knowledge",
        "data":{"synthetic_frozen_body":"原正文","cursor":"original-next-position"}});
    runtime::record_tool_receipt_in_tx(&mut tx, &run, &tool, &receipt)
        .await
        .unwrap();
    let pending_operation = runtime::register_named_tool_in_tx(
        &mut tx,
        &run,
        "pending-call|synthetic-item",
        &fp,
        "search_knowledge",
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let legacy_operation = id();
    let legacy_receipt = json!({"operation_id":legacy_operation,"tool_name":"search_knowledge",
        "data":{"objects":[],"synthetic_legacy_body":"旧回执"}});
    // 模拟旧writer：不提供版本列，默认1；它的版本不能由当前run2重新推断。
    sqlx::query("INSERT INTO tool_calls(operation_id,conversation_id,recovery_chain_id,sdk_tool_call_id,origin_run_id,tool_name,arguments_fingerprint,state,receipt) VALUES(?,?,?,?,?,?,?,'succeeded',?)")
        .bind(&legacy_operation).bind(&job.conversation_id).bind(first["recovery_chain_id"].as_str().unwrap())
        .bind("legacy-call|synthetic-item").bind(first["run_id"].as_str().unwrap()).bind("search_knowledge")
        .bind(&fp).bind(sqlx::types::Json(&legacy_receipt)).execute(&pool).await.unwrap();
    deliver_run::defer_busy_delivery(
        &pool,
        &ctx,
        first["run_id"].as_str().unwrap(),
        first["lease_epoch"].as_str().unwrap().parse().unwrap(),
    )
    .await
    .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    let retry = jobs::claim_due(&pool, "synthetic-recovery-worker", 120000)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (&retry.id, &retry.conversation_id, &retry.message_id),
        (&job.id, &job.conversation_id, &job.message_id)
    );
    assert_eq!(retry.lease_epoch, job.lease_epoch + 1);
    assert_eq!(retry.attempts, 0);
    let resumed = deliver_in_new_process(&url, &retry, "1", "data_agent_shared_qwen1024");
    assert_ne!(resumed["run_id"], first["run_id"]);
    assert_eq!(
        resumed["tool_contract_version"], 2,
        "恢复不能按新进程配置降级"
    );
    for key in [
        "recovery_chain_id",
        "budget_scope_id",
        "output_id",
        "message_id",
    ] {
        assert_eq!(resumed[key], first[key], "恢复必须保留{key}");
    }
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let run = runtime::lock_run_in_tx(
        &mut tx,
        resumed["run_id"].as_str().unwrap(),
        &job.conversation_id,
    )
    .await
    .unwrap();
    assert_eq!(run.tool_contract_version, 2);
    for (sdk_id, expected_version, expected_operation, expected_receipt) in [
        ("current-call|synthetic-item", 2, &operation, &receipt),
        (
            "legacy-call|synthetic-item",
            1,
            &legacy_operation,
            &legacy_receipt,
        ),
    ] {
        let tool = runtime::lock_tool_call_in_tx(&mut tx, &run, sdk_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(tool.tool_contract_version, expected_version);
        assert_eq!(&tool.operation_id, expected_operation);
        assert_eq!(tool.origin_run_id, first["run_id"]);
        assert_eq!(tool.fingerprint, fp);
        assert_eq!(tool.state, "succeeded");
        assert_eq!(tool.receipt.as_ref(), Some(expected_receipt));
    }
    let pending = runtime::lock_tool_call_in_tx(&mut tx, &run, "pending-call|synthetic-item")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(pending.tool_contract_version, 2);
    assert_eq!(pending.operation_id, pending_operation);
    assert_eq!(pending.origin_run_id, first["run_id"]);
    assert_eq!(pending.state, "registered");
    assert_eq!(pending.receipt, None);
    assert!(
        runtime::lock_tool_call_in_tx(&mut tx, &run, "CURRENT-call|synthetic-item")
            .await
            .unwrap()
            .is_none(),
        "SDK调用身份仍区分大小写"
    );
    tx.commit().await.unwrap();
    pool.close().await;
}

fn native_checkpoint(workspace: &Value) -> Value {
    let output=Command::new("node").args(["--input-type=module","-e",r#"
        import {SessionManager} from '@earendil-works/pi-coding-agent';
        import {exportCheckpoint} from './apps/agent/session/checkpoint.ts';
        const workspace=JSON.parse(process.env.SYNTHETIC_CHECKPOINT_AUTHORITY);
        process.stdout.write(JSON.stringify(exportCheckpoint(SessionManager.inMemory('/synthetic/data-agent'),workspace.authority_revision,workspace.authority_snapshot)));
    "#]).current_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .env("SYNTHETIC_CHECKPOINT_AUTHORITY",workspace.to_string()).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

// 存储夹具只建立升级前合法登记；后续register/invoke及条件写入均走真实业务边界。
async fn registered_legacy_update(
    pool: &MySqlPool,
    ctx: &AccessContext,
    envelope: &Value,
    checkpoint: &Value,
    sdk: &str,
    args: Value,
) -> (Value, String) {
    contracts::validate("AnalysisUpdate", &args).unwrap();
    assert!(contracts::validate("CurrentAnalysisUpdate", &args).is_err());
    let input = json!({"run_id":envelope["run_id"],"lease_epoch":envelope["lease_epoch"],
        "sdk_tool_call_id":sdk,"tool_name":"update_analysis_task","arguments":args,"checkpoint":checkpoint});
    let mut tx = AppTx::begin(pool).await.unwrap();
    let run = runtime::lock_run_in_tx(
        &mut tx,
        envelope["run_id"].as_str().unwrap(),
        envelope["conversation_id"].as_str().unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(run.tool_contract_version, 2);
    let operation = runtime::register_named_tool_in_tx(
        &mut tx,
        &run,
        sdk,
        &fingerprint(&json!({"name":"update_analysis_task","arguments":input["arguments"]})),
        "update_analysis_task",
    )
    .await
    .unwrap();
    let tool = runtime::lock_tool_call_in_tx(&mut tx, &run, sdk)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(tool.tool_contract_version, 2);
    assert_eq!(tool.state, "registered");
    assert_eq!(tool.receipt, None);
    tx.commit().await.unwrap();
    assert_eq!(
        data_tools::register(pool, ctx, input.clone())
            .await
            .unwrap()["operation_id"],
        operation
    );
    (input, operation)
}

#[tokio::test]
#[ignore = "requires exclusive isolated MySQL fixture; never runs against a daily service"]
async fn registered_legacy_decisions_complete_within_contract_two_without_downgrading_new_state() {
    let url = fixture_database(
        "registered_legacy_decisions_complete_within_contract_two_without_downgrading_new_state",
    );
    let pool = persistence::connect(&url).await.unwrap();
    let ctx = AccessContext {
        user_id: "synthetic-decision-owner".into(),
        space_id: "synthetic-decision-space".into(),
        request_id: id(),
        table_access: None,
    };
    let job = message(&pool, &ctx).await;
    let envelope = deliver_with_environment(
        &url,
        &job,
        "2",
        "data_agent_test_tool_contract",
        &[("DATA_AGENT_TOOLSET", "data")],
    );
    let checkpoint = native_checkpoint(&envelope["workspace_context"]);
    let question = "资料中的业务日定义是什么？";
    let pending = json!({"interpretation":"时间事实仍待核实","basis":"needs_clarification","user_quote":null,
        "adoption_message_id":null,"evidence_refs":[],"unresolved_differences":[question]});
    let create = json!({"action":"create","goal":"旧已登记决定恢复","options":["沿任务已定时间","核对资料"],"question":question,
        "conditions":{"time_start":null,"time_end":null,"timezone":"UTC","metric":"synthetic_sample","channel":null,
            "group_by":[],"filters":[],"knowledge_refs":[],"source_limits":null,"notes":"",
            "semantic_resolution":pending}});
    let (create_input, create_operation) = registered_legacy_update(
        &pool,
        &ctx,
        &envelope,
        &checkpoint,
        "old-pending-create",
        create.clone(),
    )
    .await;
    let created = data_tools::invoke(&pool, &ctx, create_input.clone())
        .await
        .unwrap();
    assert_eq!(created["operation_id"], create_operation);
    assert_eq!(created["data"]["decision_state_version"], 1);
    assert_eq!(
        created["data"]["conditions"]["semantic_resolution"],
        pending
    );
    let task = created["data"]["task_id"].as_str().unwrap();
    let clarification = created["data"]["opened_clarification"]["id"]
        .as_str()
        .unwrap();
    // 重放不复述历史通知覆盖事实（以启动/刷新的当前事实为准）；其余字段须完全一致。
    let mut replay_expected = created.clone();
    assert_eq!(
        replay_expected
            .as_object_mut()
            .unwrap()
            .remove("frozen_notification_covered"),
        Some(json!(false)),
        "首次回执的通知覆盖事实为false"
    );
    assert_eq!(
        data_tools::invoke(&pool, &ctx, create_input.clone())
            .await
            .unwrap(),
        replay_expected
    );
    let mut fresh = create_input.clone();
    fresh["sdk_tool_call_id"] = json!("new-legacy-shaped-create");
    assert_eq!(
        data_tools::register(&pool, &ctx, fresh)
            .await
            .unwrap_err()
            .code,
        "invalid_input",
        "普通新v2登记不能借宽AnalysisUpdate降级"
    );

    let mut revised_pending = pending.clone();
    revised_pending["interpretation"] = json!("仍待核实，保留原未决身份");
    let revise = json!({"action":"revise","task_id":task,"expected_version":"1","goal":"","question":null,"options":[],
        "condition_patch":{"set":{"notes":"旧操作继续修订","semantic_resolution":revised_pending},"unset":[]}});
    let (revise_input, revise_operation) = registered_legacy_update(
        &pool,
        &ctx,
        &envelope,
        &checkpoint,
        "old-pending-revise",
        revise.clone(),
    )
    .await;
    let revised = data_tools::invoke(&pool, &ctx, revise_input.clone())
        .await
        .unwrap();
    assert_eq!(revised["operation_id"], revise_operation);
    assert_eq!(revised["data"]["condition_version"], "2");
    assert_eq!(revised["data"]["decision_state_version"], 1);
    assert_eq!(
        revised["data"]["conditions"]["semantic_resolution"],
        revised_pending
    );
    // 同上：revise 重放不复述历史通知覆盖事实，其余字段完全一致。
    let mut revise_replay_expected = revised.clone();
    assert_eq!(
        revise_replay_expected
            .as_object_mut()
            .unwrap()
            .remove("frozen_notification_covered"),
        Some(json!(false)),
        "revise 首次回执的通知覆盖事实为false"
    );
    assert_eq!(
        data_tools::invoke(&pool, &ctx, revise_input.clone())
            .await
            .unwrap(),
        revise_replay_expected
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM condition_revisions WHERE task_id=?")
            .bind(task)
            .fetch_one(&pool)
            .await
            .unwrap(),
        2
    );

    let mut stale_revise = revise;
    stale_revise["expected_version"] = json!("2");
    let (stale_input, stale_operation) = registered_legacy_update(
        &pool,
        &ctx,
        &envelope,
        &checkpoint,
        "old-before-migration",
        stale_revise,
    )
    .await;
    let migration = json!({"run_id":envelope["run_id"],"lease_epoch":envelope["lease_epoch"],"sdk_tool_call_id":"current-migration",
        "tool_name":"update_analysis_task","checkpoint":checkpoint,"arguments":{"action":"revise","task_id":task,
            "expected_version":"2","goal":"","question":null,"options":[],"condition_patch":{"set":{"notes":"迁移后问题仍开放"},"unset":[]},
            "legacy_resolution_migration":{"from_condition_version":"2","links":[{"pending_index":0,"clarification_id":clarification}]}}});
    data_tools::register(&pool, &ctx, migration.clone())
        .await
        .unwrap();
    let migrated = data_tools::invoke(&pool, &ctx, migration).await.unwrap();
    assert_eq!(migrated["data"]["condition_version"], "3");
    assert_eq!(migrated["data"]["decision_state_version"], 2);
    assert_eq!(
        data_tools::invoke(&pool, &ctx, stale_input.clone())
            .await
            .unwrap_err()
            .code,
        "version_conflict"
    );
    let rejection = data_tools::recorded_rejection(&pool, &ctx, stale_input.clone())
        .await
        .unwrap();
    assert_eq!(rejection["operation_id"], stale_operation);
    assert_eq!(rejection["data"]["error"], "version_conflict");
    let replay = data_tools::invoke(&pool, &ctx, stale_input.clone())
        .await
        .unwrap();
    assert_eq!(replay["data"], rejection["data"]);
    assert_eq!(replay["operation_id"], rejection["operation_id"]);
    assert_eq!(replay["tool_name"], rejection["tool_name"]);
    assert_eq!(replay["tool_contract_version"], 2);
    assert!(
        replay.get("source_context_ready").is_none(),
        "回执接回原拒绝，读取工具不再因来源状态冻结"
    );
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let run = runtime::lock_run_in_tx(
        &mut tx,
        envelope["run_id"].as_str().unwrap(),
        &job.conversation_id,
    )
    .await
    .unwrap();
    let current =
        analysis::current_condition_revision_in_tx(&mut tx, job.conversation_id.as_str(), task)
            .await
            .unwrap()
            .unwrap();
    assert!(current.decision_state == analysis::DecisionStateVersion::Clarifications);
    for (sdk, operation, input, state) in [
        (
            "old-pending-create",
            create_operation,
            &create_input,
            "succeeded",
        ),
        (
            "old-pending-revise",
            revise_operation,
            &revise_input,
            "succeeded",
        ),
        (
            "old-before-migration",
            stale_operation,
            &stale_input,
            "rejected",
        ),
    ] {
        let tool = runtime::lock_tool_call_in_tx(&mut tx, &run, sdk)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(tool.operation_id, operation);
        assert_eq!(tool.tool_contract_version, 2);
        assert_eq!(tool.origin_run_id, envelope["run_id"]);
        assert_eq!(
            tool.fingerprint,
            fingerprint(&json!({"name":"update_analysis_task","arguments":input["arguments"]}))
        );
        assert_eq!(tool.state, state);
        assert!(tool.receipt.is_some());
    }
    tx.commit().await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM clarifications WHERE task_id=? AND state='open'"
        )
        .bind(task)
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM condition_revisions WHERE task_id=?")
            .bind(task)
            .fetch_one(&pool)
            .await
            .unwrap(),
        3
    );
    pool.close().await;
}

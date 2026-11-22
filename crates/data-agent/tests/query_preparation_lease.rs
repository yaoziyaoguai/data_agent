use data_agent::{
    modules::{analysis, conversations, queries},
    persistence::{self, AppTx},
    types::{AccessContext, id},
};
use serde_json::{Value, json};
use sqlx::MySqlPool;

const WORKER: &str = "synthetic-query-worker";

async fn claimed_query(pool: &MySqlPool, ctx: &AccessContext) -> Value {
    let mut tx = AppTx::begin(pool).await.unwrap();
    let cid = conversations::create_conversation_in_tx(&mut tx, ctx, &id())
        .await
        .unwrap();
    let tasks = analysis::lock_tasks_in_tx(&mut tx, &cid).await.unwrap();
    let task = analysis::create_task_in_tx(&mut tx, &tasks, &ctx.user_id, &id(), "合成查询租约")
        .await
        .unwrap();
    let input = json!({"task_id":task["task_id"],"condition_version":"1","sql":"SELECT 17 AS value",
        "parameters":{},"target_id":"synthetic-sqlite","summary":"合成领取","knowledge_refs":[],"replaces_query_id":null});
    let query = queries::save_draft_in_tx(
        &mut tx,
        ctx,
        &cid,
        &id(),
        &id(),
        &input,
        queries::DraftValidation {
            platform_report: &json!({"state":"passed","target_id":"synthetic-sqlite","target_version":"synthetic-v1"}),
            time_basis: None,
            semantic_resolution: None,
        },
    )
    .await
    .unwrap();
    queries::confirm_in_tx(
        &mut tx,
        ctx,
        query["id"].as_str().unwrap(),
        &json!({"operation_id":id(),"draft_version":"1","condition_version":"1"}),
        false,
        None,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let claim = queries::claim_due(pool, WORKER).await.unwrap().unwrap();
    assert_eq!(claim["query_id"], query["id"]);
    claim
}

async fn state(pool: &MySqlPool, job: &Value) -> Value {
    sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
        "SELECT JSON_OBJECT('owner',lease_owner,'epoch',lease_epoch,'until_ms',UNIX_TIMESTAMP(lease_until)*1000,'state',execution_state,'attempts',submission_attempts,'operation',operation_id,'confirmation',confirmation_key,'budget',budget_scope_id) FROM query_requests WHERE id=?",
    )
    .bind(job["query_id"].as_str())
    .fetch_one(pool)
    .await
    .unwrap()
    .0
}

#[tokio::test]
#[ignore = "requires exclusive isolated MySQL fixture; never runs against a daily service"]
async fn query_renewal_and_submission_handoff_require_a_live_original_claim() {
    let url = std::env::var("DATA_AGENT_DATABASE_URL").expect("isolated MySQL fixture");
    assert!(
        url.rsplit('/')
            .next()
            .unwrap()
            .starts_with("data_agent_test_")
    );
    let pool = persistence::connect(&url).await.unwrap();
    let ctx = AccessContext {
        user_id: "synthetic-business-user".into(),
        space_id: "demo".into(),
        request_id: id(),
        table_access: None,
    };
    let job = claimed_query(&pool, &ctx).await;
    sqlx::query(
        "UPDATE query_requests SET lease_until=TIMESTAMPADD(SECOND,2,UTC_TIMESTAMP(3)) WHERE id=?",
    )
    .bind(job["query_id"].as_str())
    .execute(&pool)
    .await
    .unwrap();
    let before = state(&pool, &job).await;
    queries::renew_claim(&pool, &job, WORKER).await.unwrap();
    let mut renewed = state(&pool, &job).await;
    assert!(renewed["until_ms"].as_f64().unwrap() > before["until_ms"].as_f64().unwrap());
    renewed["until_ms"] = before["until_ms"].clone();
    assert_eq!(renewed, before, "续租不更改领取身份、业务状态、计数或授权");
    let mut stale = job.clone();
    stale["lease_epoch"] = json!("0");
    for (claim, worker) in [(&job, ctx.user_id.as_str()), (&stale, WORKER)] {
        let before = state(&pool, &job).await;
        assert_eq!(
            queries::renew_claim(&pool, claim, worker)
                .await
                .unwrap_err()
                .code,
            "lease_lost"
        );
        assert_eq!(state(&pool, &job).await, before);
    }
    sqlx::query(
        "UPDATE query_requests SET lease_until=TIMESTAMPADD(SECOND,-1,UTC_TIMESTAMP(3)) WHERE id=?",
    )
    .bind(job["query_id"].as_str())
    .execute(&pool)
    .await
    .unwrap();
    let expired = state(&pool, &job).await;
    assert_eq!(
        queries::renew_claim(&pool, &job, WORKER)
            .await
            .unwrap_err()
            .code,
        "lease_lost"
    );
    assert_eq!(state(&pool, &job).await, expired);
    sqlx::query("UPDATE query_requests SET execution_state='failed',lease_until=TIMESTAMPADD(SECOND,15,UTC_TIMESTAMP(3)) WHERE id=?")
        .bind(job["query_id"].as_str()).execute(&pool).await.unwrap();
    let terminal = state(&pool, &job).await;
    assert_eq!(
        queries::renew_claim(&pool, &job, WORKER)
            .await
            .unwrap_err()
            .code,
        "lease_lost"
    );
    assert_eq!(state(&pool, &job).await, terminal);

    let job = claimed_query(&pool, &ctx).await;
    let qid = job["query_id"].as_str().unwrap();
    let mut stale = job.clone();
    stale["lease_epoch"] = json!("0");
    for claim in [&stale, &job] {
        if claim == &job {
            sqlx::query("UPDATE query_requests SET lease_until=TIMESTAMPADD(SECOND,-1,UTC_TIMESTAMP(3)) WHERE id=?")
                .bind(qid).execute(&pool).await.unwrap();
        }
        let before = state(&pool, &job).await;
        let mut tx = AppTx::begin(&pool).await.unwrap();
        assert_eq!(
            queries::begin_submission_in_tx(&mut tx, &ctx, claim)
                .await
                .unwrap_err()
                .code,
            "lease_lost"
        );
        drop(tx);
        assert_eq!(
            state(&pool, &job).await,
            before,
            "失效领取不交付平台动作或计数"
        );
    }
    // 在首次SELECT之后、事务末尾刷新之前跨过到期值，验证刷新UPDATE自身的条件。
    sqlx::query(
        "UPDATE query_requests SET summary='synthetic_slow_handoff',lease_until=TIMESTAMPADD(SECOND,1,UTC_TIMESTAMP(3)) WHERE id=?",
    )
    .bind(qid)
    .execute(&pool)
    .await
    .unwrap();
    let before = state(&pool, &job).await;
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let rejected = queries::begin_submission_in_tx(&mut tx, &ctx, &job).await;
    drop(tx);
    assert_eq!(rejected.unwrap_err().code, "lease_lost");
    assert_eq!(
        state(&pool, &job).await,
        before,
        "末尾失租回滚queued→submitting及新增计数"
    );

    sqlx::query(
        "UPDATE query_requests SET summary='synthetic_handoff',lease_until=TIMESTAMPADD(SECOND,2,UTC_TIMESTAMP(3)) WHERE id=?",
    )
    .bind(qid)
    .execute(&pool)
    .await
    .unwrap();
    let before = state(&pool, &job).await;
    let db_before: i64 =
        sqlx::query_scalar("SELECT CAST(UNIX_TIMESTAMP(UTC_TIMESTAMP(3))*1000 AS SIGNED)")
            .fetch_one(&pool)
            .await
            .unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let packet = queries::begin_submission_in_tx(&mut tx, &ctx, &job)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let db_after: i64 =
        sqlx::query_scalar("SELECT CAST(UNIX_TIMESTAMP(UTC_TIMESTAMP(3))*1000 AS SIGNED)")
            .fetch_one(&pool)
            .await
            .unwrap();
    let after = state(&pool, &job).await;
    assert_eq!(packet["action"], "submit");
    assert_eq!(packet["query_id"], job["query_id"]);
    assert_eq!(after["state"], "submitting");
    assert_eq!(after["attempts"], 1);
    for key in ["owner", "epoch", "operation", "confirmation", "budget"] {
        assert_eq!(after[key], before[key]);
    }
    let until = after["until_ms"].as_f64().unwrap();
    assert!(
        (db_before as f64 + 15000.0..=db_after as f64 + 15000.0).contains(&until),
        "15秒从数据库刷新时刻计算"
    );
    pool.close().await;
}

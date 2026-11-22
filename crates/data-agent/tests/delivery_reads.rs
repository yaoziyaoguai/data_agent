use data_agent::{
    modules::jobs,
    types::fingerprint,
    use_cases::{deliver_run, personal_memory},
};
use serde_json::json;
use sqlx::{MySqlPool, mysql::MySqlPoolOptions};
use std::collections::HashMap;

async fn counters(pool: &MySqlPool) -> HashMap<String, u64> {
    sqlx::query_as::<_, (String, String)>(
        "SHOW SESSION STATUS WHERE Variable_name IN ('Com_select','Com_insert','Com_update','Com_delete','Com_stmt_execute')",
    )
    .fetch_all(pool)
    .await
    .expect("session counters")
    .into_iter()
    .map(|(name, value)| (name, value.parse().expect("counter")))
    .collect()
}

#[tokio::test]
#[ignore = "uses a pending job seeded by check-table-catalog-access in its isolated MySQL"]
async fn measures_complete_delivery_preparation() {
    let url = std::env::var("DATA_AGENT_DATABASE_URL").expect("isolated MySQL");
    assert!(
        url.rsplit('/')
            .next()
            .unwrap()
            .starts_with("data_agent_test_")
    );
    let expected = std::env::var("DATA_AGENT_EXPECTED_MESSAGE").expect("fixture message");
    let expect_checkpoint = match std::env::var("DATA_AGENT_EXPECTED_CHECKPOINT").as_deref() {
        Ok("readable") => true,
        Ok("revoked") => false,
        _ => panic!("fixture checkpoint expectation"),
    };
    let pool = MySqlPoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .unwrap();
    // 领取后到 Pi 恢复前，采样 Worker 交付与桥接旧检查点读取的正式路径。
    let job = jobs::claim_due(&pool, "synthetic-dispatch-measurement", 120000)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(job.message_id, expected);
    let before = counters(&pool).await;
    let deliver_run::PreparedDelivery {
        context,
        mut envelope,
    } = deliver_run::start_delivery(&pool, &job, 120000)
        .await
        .unwrap();
    personal_memory::prepare_workspace(&pool, &context, &mut envelope)
        .await
        .unwrap();
    let checkpoint = &envelope["checkpoint"];
    let legacy_read = checkpoint["storage"]["kind"] == "host_checkpoint";
    if legacy_read {
        let history = deliver_run::read_delivery_checkpoint(
            &pool,
            envelope["run_id"].as_str().unwrap(),
            envelope["lease_epoch"].as_str().unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(history["leaf_id"], checkpoint["leaf_id"]);
        assert!(history.get("storage").is_none());
        assert_eq!(checkpoint["storage"]["fingerprint"], fingerprint(&history));
    }
    let after = counters(&pool).await;
    let delta = |key: &str| after[key] - before[key];
    println!(
        "DELIVERY_READS={}",
        json!({"selects":delta("Com_select"), "inserts":delta("Com_insert"),
        "updates":delta("Com_update"),"deletes":delta("Com_delete"),
        "preparedExecutions":delta("Com_stmt_execute")-1,"legacyCheckpointRead":legacy_read,"envelope":envelope})
    );
    assert_eq!(envelope["checkpoint"].is_object(), expect_checkpoint);
    assert_eq!(
        legacy_read, expect_checkpoint,
        "fixture measures actual legacy inline restoration"
    );
    let max_selects = if expect_checkpoint { 6 } else { 4 };
    assert!(
        delta("Com_select") <= max_selects,
        "full dispatch preparation made {} SELECTs",
        delta("Com_select")
    );
}

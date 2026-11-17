use data_agent::{
    modules::{ingestion, runtime},
    persistence::AppTx,
    use_cases::semantic_prefill,
};
use serde_json::{Value, json};
use sqlx::MySqlPool;

async fn isolated_pool() -> MySqlPool {
    let url = std::env::var("DATA_AGENT_DATABASE_URL").expect("isolated maintenance harness");
    assert!(url.contains("/data_agent_test_"));
    sqlx::mysql::MySqlPoolOptions::new()
        .max_connections(4)
        .connect(&url)
        .await
        .unwrap()
}

#[tokio::test]
async fn prefill_owner_commits_known_usage_and_releases_only_its_call_reservation() {
    let pool = isolated_pool().await;
    let profile = ingestion::prefill::maintenance_profile().unwrap();
    let outcome = std::env::var("DATA_AGENT_TEST_MAINTENANCE_OUTCOME").unwrap();
    runtime::configure_trial(&pool, &profile).await.unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    runtime::reserve_maintenance_in_tx(&mut tx, "unrelated-unknown", &profile)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    sqlx::query("UPDATE maintenance_model_calls SET state='unknown' WHERE id='unrelated-unknown'")
        .execute(&pool)
        .await
        .unwrap();
    let unknown_before: Value = sqlx::query_scalar("SELECT JSON_OBJECT('id',id,'trial',trial_id,'state',state,'reserved',reserved_micros,'usage',usage_json) FROM maintenance_model_calls WHERE id='unrelated-unknown'")
        .fetch_one(&pool).await.unwrap();

    assert!(semantic_prefill::process_due(&pool).await.unwrap());
    let owner: Value = sqlx::query_scalar("SELECT JSON_OBJECT('id',id,'state',state,'error',error_code) FROM prefill_attempts WHERE object_id='field-paid_amount_cents' ORDER BY created_at DESC LIMIT 1")
        .fetch_one(&pool).await.unwrap();
    let expected_state = match outcome.as_str() {
        "above_estimate" => "succeeded",
        "input_exceeded" | "output_exceeded" => "budget_unavailable",
        "usage_missing" => "unknown",
        _ => panic!("unknown synthetic usage case"),
    };
    assert_eq!(
        owner["state"], expected_state,
        "actual owner outcome: {owner}"
    );
    let calls: Vec<Value> = sqlx::query_scalar("SELECT JSON_OBJECT('id',id,'state',state,'trial',trial_id,'reserved',reserved_micros,'usage',usage_json,'budget',budget_json) FROM maintenance_model_calls WHERE trial_id=? AND id<>'unrelated-unknown' ORDER BY id")
        .bind(&profile.trial_id).fetch_all(&pool).await.unwrap();
    let trial: Value = sqlx::query_scalar("SELECT JSON_OBJECT('spent',spent_micros,'reserved',reserved_micros,'state',state,'calls',allocated_calls) FROM model_trials WHERE id=?")
        .bind(&profile.trial_id).fetch_one(&pool).await.unwrap();
    assert_eq!(calls.len(), if outcome == "above_estimate" { 2 } else { 1 });
    assert_eq!(trial["calls"], calls.len() + 1);
    for call in &calls {
        assert_eq!(call["trial"], profile.trial_id);
        assert_eq!(call["reserved"], 319488);
        assert_eq!(call["budget"]["input_tokens_upper"], 1048576);
        assert_eq!(call["budget"]["output_tokens_max"], 4096);
        assert_eq!(call["budget"]["profile"]["input_limit"], 32768);
        assert_eq!(call["budget"]["profile"]["trial_id"], profile.trial_id);
    }
    let unknown_after: Value = sqlx::query_scalar("SELECT JSON_OBJECT('id',id,'trial',trial_id,'state',state,'reserved',reserved_micros,'usage',usage_json) FROM maintenance_model_calls WHERE id='unrelated-unknown'")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(
        unknown_after, unknown_before,
        "other unknown identity/reservation must survive"
    );
    if outcome == "usage_missing" {
        assert_eq!(calls[0]["state"], "issued");
        assert_eq!(trial["spent"], 0);
        assert_eq!(trial["reserved"], 638976);
        assert_eq!(trial["state"], "active");
    } else {
        assert!(calls.iter().all(|call| call["state"] == "settled"));
        assert_eq!(trial["reserved"], 319488, "release only the owner call(s)");
        assert_eq!(
            trial["spent"],
            match outcome.as_str() {
                "above_estimate" => 39370,
                "input_exceeded" => 314598,
                "output_exceeded" => 4947,
                _ => unreachable!(),
            }
        );
        if outcome == "above_estimate" {
            assert_eq!(
                trial["state"], "active",
                "local estimate is not a billing upper bound"
            );
        } else {
            assert_eq!(trial["state"], "breached");
            let mut tx = AppTx::begin(&pool).await.unwrap();
            assert_eq!(
                runtime::reserve_maintenance_in_tx(&mut tx, "after-breach", &profile)
                    .await
                    .unwrap_err()
                    .code,
                "budget_exhausted"
            );
            tx.commit().await.unwrap();
        }
    }
    println!(
        "maintenance_owner_settlement={}",
        json!({"outcome":outcome,"owner":owner,"calls":calls,"trial":trial,"unrelated_unknown":unknown_after})
    );
    pool.close().await;
}

#[tokio::test]
async fn late_usage_uses_original_budget_and_legacy_calls_keep_original_limits() {
    let pool = isolated_pool().await;
    let profile = ingestion::prefill::maintenance_profile().unwrap();
    runtime::configure_trial(&pool, &profile).await.unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    runtime::reserve_maintenance_in_tx(&mut tx, "frozen-call", &profile)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let mut current = profile.clone();
    current.trial_id = "unrelated-current-trial".into();
    current.input_limit = 1;
    current.output_limit = 1;
    let mut tx = AppTx::begin(&pool).await.unwrap();
    runtime::settle_maintenance_in_tx(
        &mut tx,
        "frozen-call",
        &current,
        &json!({"prompt_tokens":65536,"completion_tokens":20}),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let after: Value = sqlx::query_scalar("SELECT JSON_OBJECT('spent',spent_micros,'reserved',reserved_micros,'state',state) FROM model_trials WHERE id=?")
        .bind(&profile.trial_id).fetch_one(&pool).await.unwrap();
    assert_eq!(after, json!({"spent":19685,"reserved":0,"state":"active"}));

    // 模拟升级前已签发/未知行：新字段省略为NULL，不能回填当前服务上界或清占用。
    sqlx::query("INSERT INTO maintenance_model_calls(id,trial_id,state,reserved_micros) VALUES('legacy-issued',?,'issued',14746),('legacy-unknown',?,'unknown',14746)")
        .bind(&profile.trial_id).bind(&profile.trial_id).execute(&pool).await.unwrap();
    sqlx::query("UPDATE model_trials SET allocated_calls=allocated_calls+2,reserved_micros=reserved_micros+29492 WHERE id=?")
        .bind(&profile.trial_id).execute(&pool).await.unwrap();
    let unknown_before: Value = sqlx::query_scalar("SELECT JSON_OBJECT('id',id,'trial',trial_id,'state',state,'reserved',reserved_micros,'usage',usage_json,'budget',budget_json) FROM maintenance_model_calls WHERE id='legacy-unknown'")
        .fetch_one(&pool).await.unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    assert!(
        runtime::settle_maintenance_in_tx(
            &mut tx,
            "legacy-issued",
            &current,
            &json!({"prompt_tokens":100,"completion_tokens":20})
        )
        .await
        .is_err()
    );
    tx.commit().await.unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let result = runtime::settle_maintenance_in_tx(
        &mut tx,
        "legacy-issued",
        &profile,
        &json!({"prompt_tokens":32769,"completion_tokens":20}),
    )
    .await;
    tx.commit().await.unwrap();
    assert_eq!(
        result.unwrap_err().code,
        "budget_exhausted",
        "legacy input bound remains 32768"
    );
    let legacy: Value = sqlx::query_scalar("SELECT JSON_OBJECT('state',state,'budget',budget_json,'usage',usage_json) FROM maintenance_model_calls WHERE id='legacy-issued'")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(legacy["state"], "settled");
    assert!(legacy["budget"].is_null());
    let trial: Value = sqlx::query_scalar("SELECT JSON_OBJECT('spent',spent_micros,'reserved',reserved_micros,'state',state) FROM model_trials WHERE id=?")
        .bind(&profile.trial_id).fetch_one(&pool).await.unwrap();
    assert_eq!(
        trial,
        json!({"spent":29540,"reserved":14746,"state":"breached"})
    );
    let unknown_after: Value = sqlx::query_scalar("SELECT JSON_OBJECT('id',id,'trial',trial_id,'state',state,'reserved',reserved_micros,'usage',usage_json,'budget',budget_json) FROM maintenance_model_calls WHERE id='legacy-unknown'")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(unknown_after, unknown_before);
    println!(
        "maintenance_late_usage={}",
        json!({"new_call_trial":after,"legacy":legacy,"trial":trial,"unknown":unknown_after})
    );
    pool.close().await;
}

use data_agent::{persistence::connect, use_cases::knowledge};

// 旧dense集合不兼容时，统一消费者在领取事务之前拒绝：不领取、不消耗嵌入
// 预算、不向旧集合写入并报告完成（由check-index-target准备专用不兼容集合）。
#[tokio::test]
async fn incompatible_index_target_does_not_claim_or_complete_raw_work() {
    let Ok(url) = std::env::var("DATA_AGENT_DATABASE_URL") else {
        return;
    };
    assert!(url.contains("/data_agent_test_"), "只使用隔离合成库");
    assert!(
        std::env::var("DATA_AGENT_VECTOR_COLLECTION")
            .unwrap_or_default()
            .starts_with("da_target_"),
        "该反例由check-index-target准备不兼容的专用集合"
    );
    let pool = connect(&url).await.unwrap();
    let error = knowledge::process_index(&pool)
        .await
        .expect_err("统一消费者不能向旧dense集合写入并报告完成");
    assert_eq!(error.code, "vector_schema_mismatch");
    pool.close().await;
}

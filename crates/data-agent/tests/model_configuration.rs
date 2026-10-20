use data_agent::{
    contracts::{self, generated::ModelSelection},
    modules::runtime::model_configuration,
    persistence::{self, AppTx},
    types::AccessContext,
    use_cases,
};
use serde_json::json;

#[tokio::test]
async fn configuration_is_scoped_and_frozen_service_remains_authoritative() {
    let pool = persistence::connect(
        &std::env::var("DATA_AGENT_DATABASE_URL").expect("isolated harness database"),
    )
    .await
    .unwrap();
    let ctx = |space: &str| AccessContext {
        user_id: "alice".into(),
        space_id: space.into(),
        request_id: "synthetic-configuration".into(),
    };
    let a = ctx("model-scope-a");
    let b = ctx("model-scope-b");
    use_cases::model_configuration::initialize(&pool, &a, None)
        .await
        .unwrap();
    use_cases::model_configuration::initialize(&pool, &b, None)
        .await
        .unwrap();
    let service = json!({"id":"shared-id","name":"Synthetic service","provider_id":"compatible","api":"openai-completions","base_url":"https://example.com/v1","enabled":true,"expected_version":"0","api_key":"synthetic-space-a"});
    let save = |ctx: AccessContext, kind: &'static str, input: serde_json::Value| {
        let pool = pool.clone();
        async move { use_cases::model_configuration::save(&pool, &ctx, None, kind, input).await }
    };
    save(a.clone(), "service", service.clone()).await.unwrap();
    assert!(
        use_cases::model_configuration::read(&pool, &b, None)
            .await
            .unwrap()["services"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let model = json!({"id":"shared-model","service_id":"shared-id","model_id":"synthetic/model","label":"Synthetic model","thinking_levels":["off"],"reasoning_supported":false,"default_thinking":"off","input_limit":128000,"output_limit":16000,"payload_bytes_limit":262144,"input_rate":"1000000","output_rate":"4000000","enabled":true,"expected_version":"0"});
    assert_eq!(
        save(b.clone(), "model", model.clone())
            .await
            .unwrap_err()
            .code,
        "not_available"
    );
    save(a.clone(), "model", model.clone()).await.unwrap();
    let selection: ModelSelection = contracts::decode(
        "ModelSelection",
        json!({"model_id":"shared-model","thinking_level":"off"}),
    )
    .unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    assert_eq!(
        model_configuration::selection_in_tx(&mut tx, &b.space_id, None, Some(&selection))
            .await
            .unwrap_err()
            .code,
        "model_unavailable"
    );
    tx.commit().await.unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let (profile, _) =
        model_configuration::selection_in_tx(&mut tx, &a.space_id, None, Some(&selection))
            .await
            .unwrap();
    let profile = profile.unwrap();
    tx.commit().await.unwrap();
    let mut other = service.clone();
    other["api_key"] = json!("synthetic-space-b");
    save(b.clone(), "service", other).await.unwrap();
    save(b.clone(), "model", model.clone()).await.unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let connection = model_configuration::connection_in_tx(&mut tx, &a.space_id, &profile)
        .await
        .unwrap();
    assert_eq!(connection["api_key"], "synthetic-space-a");
    tx.commit().await.unwrap();
    let mut new_service = service.clone();
    new_service["id"] = json!("rebound-service");
    new_service["enabled"] = json!(false);
    save(a.clone(), "service", new_service).await.unwrap();
    let mut rebound = model.clone();
    rebound["service_id"] = json!("rebound-service");
    rebound["expected_version"] = json!("1");
    save(a.clone(), "model", rebound).await.unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    assert_eq!(
        model_configuration::connection_in_tx(&mut tx, &a.space_id, &profile)
            .await
            .unwrap()["api_key"],
        "synthetic-space-a"
    );
    tx.commit().await.unwrap();
    let mut disabled = service.clone();
    disabled["expected_version"] = json!("1");
    disabled["enabled"] = json!(false);
    disabled.as_object_mut().unwrap().remove("api_key");
    save(a.clone(), "service", disabled).await.unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    assert_eq!(
        model_configuration::connection_in_tx(&mut tx, &a.space_id, &profile)
            .await
            .unwrap_err()
            .code,
        "model_unavailable"
    );
    tx.commit().await.unwrap();
    let mut overflow = model.clone();
    overflow["expected_version"] = json!(u64::MAX.to_string());
    assert_eq!(
        save(a.clone(), "model", overflow).await.unwrap_err().code,
        "invalid_input"
    );
    let mut ordinary = a.clone();
    ordinary.user_id = "bob".into();
    assert_eq!(
        use_cases::model_configuration::read(&pool, &ordinary, None)
            .await
            .unwrap_err()
            .code,
        "forbidden"
    );
    let seeded = ctx("model-scope-seeded");
    let original = contracts::decode("ModelProfile", json!({"provider_id":"deepseek","model_id":"deepseek-flash","trial_id":"synthetic-seed","price_version":"2026-10-04-peak-usd","input_limit":65536,"output_limit":4096,"request_call_limit":24,"budget_mode":"request","thinking_level":"off","toolset":"data","payload_bytes_limit":131072})).unwrap();
    use_cases::model_configuration::initialize(&pool, &seeded, Some(&original))
        .await
        .unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let (frozen, _) =
        model_configuration::selection_in_tx(&mut tx, &seeded.space_id, Some(&original), None)
            .await
            .unwrap();
    let frozen = frozen.unwrap();
    assert_eq!(
        frozen.configured_model.as_ref().unwrap().service_id,
        "deployment-deepseek"
    );
    assert_eq!(frozen.price_version, original.price_version);
    assert_eq!(
        model_configuration::connection_in_tx(&mut tx, &seeded.space_id, &frozen)
            .await
            .unwrap()["api_key"],
        "synthetic-protocol-key"
    );
    tx.commit().await.unwrap();
    let snapshot = use_cases::model_configuration::read(&pool, &seeded, Some(&original))
        .await
        .unwrap();
    let mut deployment = snapshot["services"][0].clone();
    deployment.as_object_mut().unwrap().remove("version");
    deployment
        .as_object_mut()
        .unwrap()
        .remove("credential_configured");
    deployment["expected_version"] = json!("1");
    deployment["api_key"] = json!("synthetic-rotated");
    save(seeded.clone(), "service", deployment.clone())
        .await
        .unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    assert_eq!(
        model_configuration::connection_in_tx(&mut tx, &seeded.space_id, &frozen)
            .await
            .unwrap()["api_key"],
        "synthetic-protocol-key"
    );
    let (new, _) =
        model_configuration::selection_in_tx(&mut tx, &seeded.space_id, Some(&original), None)
            .await
            .unwrap();
    assert_eq!(
        model_configuration::connection_in_tx(&mut tx, &seeded.space_id, &new.unwrap())
            .await
            .unwrap()["api_key"],
        "synthetic-rotated"
    );
    tx.commit().await.unwrap();
    save(seeded.clone(), "service", service.clone())
        .await
        .unwrap();
    let mut rebound = snapshot["models"][0].clone();
    rebound.as_object_mut().unwrap().remove("version");
    rebound["expected_version"] = json!("1");
    rebound["service_id"] = json!("shared-id");
    save(seeded.clone(), "model", rebound).await.unwrap();
    deployment["expected_version"] = json!("2");
    deployment["enabled"] = json!(false);
    deployment.as_object_mut().unwrap().remove("api_key");
    save(seeded.clone(), "service", deployment).await.unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    for profile in [&original, &frozen] {
        assert_eq!(
            model_configuration::assert_active_in_tx(&mut tx, &seeded.space_id, profile)
                .await
                .unwrap_err()
                .code,
            "model_unavailable"
        );
    }
    tx.commit().await.unwrap();
    pool.close().await;
}

use data_agent::{
    contracts,
    modules::{ingestion::preparation, knowledge},
    persistence::{self, AppTx},
    types::AccessContext,
};
use serde_json::json;

#[tokio::test]
async fn knowledge_without_prepared_relations_remains_readable_under_its_response_contract() {
    let pool = persistence::connect(
        &std::env::var("DATA_AGENT_DATABASE_URL").expect("isolated harness database"),
    )
    .await
    .unwrap();
    let ctx = AccessContext {
        user_id: "alice".into(),
        space_id: "demo".into(),
        request_id: "synthetic-knowledge-without-preparation".into(),
    };
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let object = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({
            "operation_id":"create-unprepared-term", "kind":"term", "name":"合成唤醒定义",
            "body":"一次唤醒对应一个会话入口", "related_ids":[], "source_url":null,
            "structured_value":null
        }),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let read = knowledge::read_in_tx(&mut tx, &ctx, object["id"].as_str().unwrap(), None, true)
        .await
        .unwrap();
    contracts::validate("KnowledgeObject", &read).unwrap();
    assert_eq!(
        read["entries"][0]["effective_value"],
        "一次唤醒对应一个会话入口"
    );
    tx.commit().await.unwrap();
}

#[tokio::test]
async fn source_target_catalog_keeps_metadata_order_with_large_source_quotes() {
    let pool = persistence::connect(
        &std::env::var("DATA_AGENT_DATABASE_URL").expect("isolated harness database"),
    )
    .await
    .unwrap();
    let ctx = AccessContext {
        user_id: "alice".into(),
        space_id: "demo".into(),
        request_id: "synthetic-wide-source-targets".into(),
    };
    let source = "synthetic-wide-source-targets";
    let mut expected = Vec::new();
    for index in 0..2 {
        let mut tx = AppTx::begin(&pool).await.unwrap();
        let object = knowledge::create_in_tx(
            &mut tx,
            &ctx,
            &json!({"operation_id":format!("wide-target-{index}"), "kind":"term",
                "name":format!("合成整理对象{index}"), "body":"对象正文不进入整理目标目录。",
                "related_ids":[], "source_url":null, "structured_value":null}),
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        // 复现真实整理后积累的大原文引用；本接口仅消费条目身份，不应排序整份正文。
        sqlx::query("UPDATE knowledge_objects SET source_id=?,body=JSON_SET(body,'$.entries[0].source_facts',JSON_OBJECT('complete',FALSE,'gap','合成宽材料','quote',REPEAT('合成引文。',30000))) WHERE id=?")
            .bind(source)
            .bind(object["id"].as_str().unwrap())
            .execute(&pool)
            .await
            .unwrap();
        expected.push(json!({"id":object["id"],"kind":"term","version":"1","name":object["name"],
            "entries":[{"entry_id":object["entries"][0]["entry_id"],"path":object["entries"][0]["path"],"label":object["entries"][0]["label"]}]}));
    }
    expected.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let targets = knowledge::source_objects_in_tx(&mut tx, &ctx, source)
        .await
        .unwrap();
    assert_eq!(
        targets, expected,
        "宽原文不改变整理目录的身份、版本、顺序和条目元数据"
    );
    tx.commit().await.unwrap();
}

#[tokio::test]
async fn prepared_statement_keeps_support_and_host_origin_without_replacing_human_text() {
    let pool = persistence::connect(
        &std::env::var("DATA_AGENT_DATABASE_URL").expect("isolated harness database"),
    )
    .await
    .unwrap();
    let ctx = AccessContext {
        user_id: "alice".into(),
        space_id: "demo".into(),
        request_id: "synthetic-source-preparation".into(),
    };
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let object = knowledge::create_in_tx(
        &mut tx,
        &ctx,
        &json!({
            "operation_id":"create-prepared-term", "kind":"term", "name":"合成识别率",
            "body":"维护者确认的识别率定义", "related_ids":[], "source_url":null,
            "structured_value":null
        }),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let citation = json!({"source":{"kind":"document","id":"synthetic-voice-guide"},
        "revision":"1","locator":{"offset":100000,"length":12}});
    let result = json!({"statements":[{
        "key":"recognition-rate", "target":{"object_id":object["id"],"version":"1","path":"body"},
        "text":"识别率分母排除取消请求。", "scope_text":"正式语音请求",
        "citations":[citation], "supports":[{"key":"cancelled-requests", "role":"exception",
            "reference":{"kind":"source","citation":citation},
            "content":"识别率分母排除取消请求。",
            "embedded_in":{"field":"text","locator":{"offset":0,"length":12}}}]
    }],"relations":[],"unresolved":[],"semantic_status":"ready"});
    let source = contracts::decode("SourceKey", citation["source"].clone()).unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let saved = knowledge::apply_preparation_in_tx(
        &mut tx,
        &ctx,
        "prepare-statement",
        &source,
        "1",
        &result,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(saved.len(), 1);
    let entry = &saved[0]["entries"][0];
    assert_eq!(entry["effective_value"], "维护者确认的识别率定义");
    assert!(entry["statements"].as_array().unwrap().is_empty());
    let suggestion = &entry["suggestion"]["statements"][0];
    assert_eq!(suggestion["origin"], "model_inference");
    assert_eq!(
        suggestion["supports"][0]["content"],
        "识别率分母排除取消请求。"
    );
    assert_eq!(suggestion["citations"][0]["locator"]["offset"], 100000);
    assert!(!suggestion["statement_id"].as_str().unwrap().is_empty());
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let replay = knowledge::apply_preparation_in_tx(
        &mut tx,
        &ctx,
        "prepare-statement",
        &source,
        "1",
        &result,
    )
    .await
    .unwrap();
    assert_eq!(replay, saved, "原批次重放不生成新修订或新陈述身份");
    tx.commit().await.unwrap();
}

// 来源准备状态机：只有无在途调用才可开批，在途调用受租约保护，
// 过期转unknown终态，应用后按覆盖完成与未解释项判定ready/partial。
#[tokio::test]
async fn source_preparation_state_machine_guards_in_flight_calls_and_readiness() {
    let pool = persistence::connect(
        &std::env::var("DATA_AGENT_DATABASE_URL").expect("isolated harness database"),
    )
    .await
    .unwrap();
    let ctx = AccessContext {
        user_id: "alice".into(),
        space_id: "demo".into(),
        request_id: "synthetic-preparation-state".into(),
    };
    let source = format!(
        "catalog-{}",
        &data_agent::types::fingerprint(&json!([
            "prep-state",
            ctx.request_id,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ]))[..48]
    );
    let revision = 7u64;
    let frozen = json!({"source":{"kind":"platform","id":source},"revision":"7",
        "segments":[],"next_cursor":null,"objects":[],
        "coverage":{"batch_start":0,"batch_segments":1,"batch_chars":10,"final_batch":false}});

    let mut tx = AppTx::begin(&pool).await.unwrap();
    preparation::ensure_preparation_in_tx(
        &mut tx,
        &ctx.space_id,
        &source,
        revision,
        "input-fp",
        "dep-fp",
    )
    .await
    .unwrap();
    preparation::begin_batch_in_tx(&mut tx, &source, revision, &frozen, "dep-fp", 60)
        .await
        .unwrap();
    let opened = preparation::read_preparation_in_tx(&mut tx, &ctx.space_id, &source, revision)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(opened["call_state"], "analysis");
    assert_eq!(opened["batch_sequence"], 1);
    assert_eq!(opened["lease_valid"], true);
    assert_eq!(opened["semantic_status"], "pending");
    // 在途调用未到期前不得重复开批，也不得被过期清扫误伤。
    assert_eq!(
        preparation::begin_batch_in_tx(&mut tx, &source, revision, &frozen, "dep-fp", 60)
            .await
            .unwrap_err()
            .code,
        "version_conflict"
    );
    preparation::expire_issued_preparations_in_tx(&mut tx)
        .await
        .unwrap();
    let still_in_flight =
        preparation::read_preparation_in_tx(&mut tx, &ctx.space_id, &source, revision)
            .await
            .unwrap()
            .unwrap();
    assert_eq!(still_in_flight["call_state"], "analysis");
    // 分析成果须在租约内登记复核；复核成果应用前先落库转applying（此后应用
    // 事务回滚可从已提交输出恢复），登记后才可以应用并推进。
    preparation::stage_draft_in_tx(&mut tx, &source, revision, &json!({"statements":[]}), 60)
        .await
        .unwrap();
    assert_eq!(
        preparation::stage_draft_in_tx(&mut tx, &source, revision, &json!({"statements":[]}), 60)
            .await
            .unwrap_err()
            .code,
        "lease_lost"
    );
    preparation::stage_apply_in_tx(&mut tx, &source, revision, &json!({"statements":[]}))
        .await
        .unwrap();
    preparation::complete_batch_in_tx(
        &mut tx,
        &source,
        revision,
        Some(
            &json!({"binding":"sql","segmentation_version":"source-structure-1","next_offset":900}),
        ),
        1,
        900,
        &["税费口径未解释".to_owned()],
    )
    .await
    .unwrap();
    let partial = preparation::read_preparation_in_tx(&mut tx, &ctx.space_id, &source, revision)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(partial["semantic_status"], "partial");
    assert_eq!(partial["call_state"], serde_json::Value::Null);
    assert_eq!(partial["segments_read"], 1);
    assert_eq!(partial["covered_chars"], 900);
    assert_eq!(partial["unresolved"], json!(["税费口径未解释"]));
    // 覆盖完成且未解释项清空才允许ready；早前批次的partial不永久压制ready。
    preparation::begin_batch_in_tx(&mut tx, &source, revision, &frozen, "dep-fp", 60)
        .await
        .unwrap();
    preparation::stage_draft_in_tx(&mut tx, &source, revision, &json!({"statements":[]}), 60)
        .await
        .unwrap();
    preparation::stage_apply_in_tx(&mut tx, &source, revision, &json!({"statements":[]}))
        .await
        .unwrap();
    preparation::complete_batch_in_tx(&mut tx, &source, revision, None, 2, 100, &[])
        .await
        .unwrap();
    let ready = preparation::read_preparation_in_tx(&mut tx, &ctx.space_id, &source, revision)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(ready["semantic_status"], "ready");
    assert_eq!(ready["batch_sequence"], 2);
    assert_eq!(ready["segments_read"], 3);
    tx.commit().await.unwrap();
    // 过期在途调用按unknown终态记录；已知失败清理在途状态后允许新的调用身份。
    // 人工过期SQL在池连接上执行，不与持有行锁的事务互相等待。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    preparation::begin_batch_in_tx(&mut tx, &source, revision, &frozen, "dep-fp", 60)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    sqlx::query("UPDATE source_preparations SET issued_until=TIMESTAMPADD(SECOND,-1,UTC_TIMESTAMP(3)) WHERE source_id=?")
        .bind(&source)
        .execute(&pool)
        .await
        .unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    preparation::expire_issued_preparations_in_tx(&mut tx)
        .await
        .unwrap();
    let unknown = preparation::read_preparation_in_tx(&mut tx, &ctx.space_id, &source, revision)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(unknown["call_state"], "unknown");
    assert_eq!(unknown["error_code"], "model_unknown");
    preparation::fail_preparation_in_tx(&mut tx, &source, revision, "model_unknown")
        .await
        .unwrap();
    let failed = preparation::read_preparation_in_tx(&mut tx, &ctx.space_id, &source, revision)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(failed["semantic_status"], "failed");
    tx.commit().await.unwrap();
}

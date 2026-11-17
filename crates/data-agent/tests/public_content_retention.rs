use data_agent::{
    modules::{ingestion, knowledge},
    persistence::{self, AppTx},
    types::AccessContext,
};
use serde_json::{Value, json};
use sqlx::{MySqlPool, Row};

fn catalog_table(comment: &str) -> Value {
    json!({"id":"retained_events","name":"retained_events","platform_version":"1","maintainer_id":"alice",
        "comment":comment,"ddl":"CREATE TABLE retained_events (event_id INTEGER);",
        "columns":[{"id":"event_id","name":"event_id","data_type":"INTEGER","nullable":false,"comment":"合成事件标识"}],
        "node":{"id":"load_retained_events","sql":"INSERT INTO retained_events SELECT event_id FROM synthetic_events;","upstream_ids":["synthetic_events"]}})
}

async fn save_catalog(
    pool: &MySqlPool,
    ctx: &AccessContext,
    namespace: &str,
    table: &Value,
) -> (u64, bool) {
    let mut tx = AppTx::begin(pool).await.unwrap();
    let read = ingestion::begin_catalog_read_in_tx(&mut tx, ctx, &data_agent::types::id())
        .await
        .unwrap();
    let saved = ingestion::save_catalog_table_in_tx(&mut tx, ctx, &read, namespace, table)
        .await
        .unwrap();
    ingestion::complete_catalog_namespace_in_tx(&mut tx, ctx, &read, namespace)
        .await
        .unwrap();
    ingestion::finish_catalog_read_in_tx(&mut tx, &read, Some(&json!({})), None)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    saved
}

async fn harness_pool() -> MySqlPool {
    let url = std::env::var("DATA_AGENT_DATABASE_URL").expect("isolated harness database");
    assert!(
        url.contains("/data_agent_test_"),
        "must use the isolated harness"
    );
    persistence::connect(&url).await.unwrap()
}

#[test]
fn retention_configuration_is_explicit_and_rejects_invalid_values() {
    for (value, expected) in [
        (None, "true"),
        (Some("archive"), "true"),
        (Some("latest_only"), "false"),
        (Some(""), "invalid_input"),
        (Some("latest"), "invalid_input"),
    ] {
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command.args([
            "--ignored",
            "--exact",
            "retention_configuration_process",
            "--nocapture",
        ]);
        match value {
            Some(value) => {
                command.env("DATA_AGENT_PUBLIC_CONTENT_RETENTION", value);
            }
            None => {
                command.env_remove("DATA_AGENT_PUBLIC_CONTENT_RETENTION");
            }
        }
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "isolated configuration process must finish"
        );
        assert!(
            String::from_utf8(output.stdout)
                .unwrap()
                .lines()
                .any(|line| line == format!("retention-result={expected}")),
            "configuration {value:?}"
        );
    }
}

#[test]
#[ignore = "only invoked by the configuration test in an isolated process"]
fn retention_configuration_process() {
    let value = data_agent::types::retain_public_content_archives()
        .map(|value| value.to_string())
        .unwrap_or_else(|error| error.code.into());
    println!("retention-result={value}");
}

#[tokio::test]
#[ignore = "only invoked by the archive compatibility runner"]
async fn archive_mode_keeps_full_revisions_and_same_revision_document_preparation() {
    assert_eq!(
        std::env::var("DATA_AGENT_PUBLIC_CONTENT_RETENTION").unwrap(),
        "archive"
    );
    let pool = harness_pool().await;
    let ctx = AccessContext {
        user_id: "alice".into(),
        space_id: "archive-compatibility".into(),
        request_id: "archive-compatibility".into(),
    };
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let original = knowledge::create_in_tx(&mut tx, &ctx, &json!({"operation_id":"archive-create-document","kind":"document","name":"合成兼容文档","body":"兼容模式文档原文。","related_ids":[],"source_url":null,"structured_value":null})).await.unwrap();
    let id = original["id"].as_str().unwrap().to_owned();
    let source =
        data_agent::contracts::decode("SourceKey", json!({"kind":"document","id":id})).unwrap();
    tx.commit().await.unwrap();
    let archive_before: Value = sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
        "SELECT body FROM knowledge_versions WHERE object_id=? AND version=1",
    )
    .bind(&id)
    .fetch_one(&pool)
    .await
    .unwrap()
    .0;
    let frozen_profile = json!({"provider_id":"deepseek","model_id":"deepseek-flash","trial_id":"archive-frozen-trial","price_version":"2026-10-04-peak-usd"});
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM knowledge_index_jobs WHERE target_kind='knowledge_entry' AND object_id=? AND version=1"
        )
        .bind(&id)
        .fetch_one(&pool)
        .await
        .unwrap(),
        1,
        "首次保存已登记知识索引待办"
    );
    sqlx::query(
        "UPDATE knowledge_index_jobs SET state='indexed',vector_state='indexed',vector_attempts=2,lease_epoch=5,embedding_profile=?,vector_target='collection-a',vector_error=NULL,vector_receipt=CAST('{\"state\":\"indexed\"}' AS JSON),lease_until=NULL WHERE target_kind='knowledge_entry' AND object_id=? AND version=1",
    )
    .bind(sqlx::types::Json(&frozen_profile))
    .bind(&id)
    .execute(&pool)
    .await
    .unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let prepared = knowledge::apply_preparation_in_tx(&mut tx, &ctx, "archive-prepare-document", &source, "1", &json!({"statements":[{
        "key":"archive-derived","target":{"object_id":id,"version":"1","path":"body"},"text":"兼容派生说明。","scope_text":"","citations":[{"source":source,"revision":"1","locator":{"offset":0,"length":6}}],"supports":[],"supports_complete":true
    }],"relations":[],"unresolved":[],"semantic_status":"ready"})).await.unwrap();
    assert_eq!(prepared[0]["version"], "1");
    assert_eq!(
        prepared[0]["entries"][0]["effective_value"],
        "兼容模式文档原文。"
    );
    assert_eq!(
        prepared[0]["entries"][0]["suggestion"]["statements"][0]["text"], "兼容派生说明。",
        "同修订整理只更新current派生视图"
    );
    tx.commit().await.unwrap();
    let job_after_apply = sqlx::query(
        "SELECT embedding_profile,vector_attempts,lease_epoch,state,vector_state,vector_error,vector_receipt,lease_until FROM knowledge_index_jobs WHERE target_kind='knowledge_entry' AND object_id=? AND version=1",
    )
    .bind(&id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        job_after_apply
            .get::<Option<sqlx::types::Json<Value>>, _>("embedding_profile")
            .map(|value| value.0),
        Some(frozen_profile.clone()),
        "同修订整理保留首次冻结的embedding配置"
    );
    assert_eq!(
        job_after_apply.get::<u64, _>("lease_epoch"),
        6,
        "同修订整理只单调推进租约代次"
    );
    assert_eq!(job_after_apply.get::<String, _>("state"), "pending");
    assert_eq!(job_after_apply.get::<String, _>("vector_state"), "pending");
    assert_eq!(job_after_apply.get::<u32, _>("vector_attempts"), 0);
    assert_eq!(
        job_after_apply.get::<Option<String>, _>("vector_error"),
        None
    );
    assert_eq!(
        job_after_apply
            .get::<Option<sqlx::types::Json<Value>>, _>("vector_receipt")
            .map(|value| value.0),
        None
    );
    assert_eq!(
        job_after_apply.get::<Option<String>, _>("lease_until"),
        None
    );
    let issued_receipt = json!({"state":"issued","request":"archive-issued"});
    sqlx::query(
        "UPDATE knowledge_index_jobs SET state='pending',vector_state='sending',vector_attempts=2,lease_epoch=10,lease_until=TIMESTAMPADD(SECOND,120,UTC_TIMESTAMP(3)),vector_error=NULL,vector_receipt=?,embedding_profile=? WHERE target_kind='knowledge_entry' AND object_id=? AND version=1",
    )
    .bind(sqlx::types::Json(&issued_receipt))
    .bind(sqlx::types::Json(&frozen_profile))
    .bind(&id)
    .execute(&pool)
    .await
    .unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let prepared_issued = knowledge::apply_preparation_in_tx(&mut tx, &ctx, "archive-prepare-document-issued", &source, "1", &json!({"statements":[{
        "key":"archive-derived","target":{"object_id":id,"version":"1","path":"body"},"text":"兼容派生说明（重开）。","scope_text":"","citations":[{"source":source,"revision":"1","locator":{"offset":0,"length":6}}],"supports":[],"supports_complete":true
    }],"relations":[],"unresolved":[],"semantic_status":"ready"})).await.unwrap();
    assert_eq!(prepared_issued[0]["version"], "1");
    let edited = knowledge::save_edit_in_tx(&mut tx, &ctx, &id, &json!({"operation_id":"archive-edit-document","expected_version":"1","entry_id":"body","clear_override":false,"value":"兼容模式第二版。","structured_value":null}), None).await.unwrap();
    assert_eq!(edited["version"], "2");
    let historical = knowledge::read_in_tx(&mut tx, &ctx, &id, Some(1), true)
        .await
        .unwrap();
    assert!(
        historical["entries"][0]["suggestion"]["statements"]
            .as_array()
            .is_none_or(Vec::is_empty),
        "精确历史读取返回原归档，不冒充同修订整理后的current"
    );
    tx.commit().await.unwrap();
    let job_after_issued = sqlx::query(
        "SELECT embedding_profile,vector_attempts,lease_epoch,state,vector_state,vector_receipt FROM knowledge_index_jobs WHERE target_kind='knowledge_entry' AND object_id=? AND version=1",
    )
    .bind(&id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        job_after_issued.get::<u64, _>("lease_epoch"),
        11,
        "重整继续单调推进租约代次"
    );
    assert_eq!(
        job_after_issued.get::<u32, _>("vector_attempts"),
        2,
        "已发出的调用不因重整清空重试次数"
    );
    assert_eq!(
        job_after_issued.get::<String, _>("vector_state"),
        "sending",
        "issued调用不被重整改成可重发"
    );
    assert_eq!(
        job_after_issued
            .get::<Option<sqlx::types::Json<Value>>, _>("vector_receipt")
            .map(|value| value.0),
        Some(issued_receipt),
        "结果未知的回执保持原样"
    );
    assert_eq!(
        job_after_issued
            .get::<Option<sqlx::types::Json<Value>>, _>("embedding_profile")
            .map(|value| value.0),
        Some(frozen_profile),
        "issued窗口同样保留首次冻结配置"
    );
    let archive_after: Value = sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
        "SELECT body FROM knowledge_versions WHERE object_id=? AND version=1",
    )
    .bind(&id)
    .fetch_one(&pool)
    .await
    .unwrap()
    .0;
    assert_eq!(
        archive_after, archive_before,
        "同修订整理保留既有完整归档字节"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM knowledge_versions WHERE object_id=?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap(),
        2
    );
    let namespace = "synthetic-archive-compatible";
    assert_eq!(
        save_catalog(&pool, &ctx, namespace, &catalog_table("兼容来源第一版。")).await,
        (1, true)
    );
    let mut second = catalog_table("兼容来源第二版。");
    second["platform_version"] = json!("2");
    assert_eq!(
        save_catalog(&pool, &ctx, namespace, &second).await,
        (2, true)
    );
    let source = ingestion::catalog::source_id(&ctx.space_id, namespace, "retained_events");
    for query in [
        "SELECT COUNT(*) FROM source_snapshots WHERE source_id=?",
        "SELECT COUNT(*) FROM catalog_table_snapshots WHERE source_id=?",
    ] {
        assert_eq!(
            sqlx::query_scalar::<_, i64>(query)
                .bind(&source)
                .fetch_one(&pool)
                .await
                .unwrap(),
            2
        );
    }
    pool.close().await;
}

#[tokio::test]
async fn new_knowledge_revisions_keep_current_and_metadata_without_growing_the_legacy_archive() {
    assert_eq!(
        std::env::var("DATA_AGENT_PUBLIC_CONTENT_RETENTION").unwrap(),
        "latest_only"
    );
    let pool = harness_pool().await;
    let ctx = AccessContext {
        user_id: "alice".into(),
        space_id: "public-content-retention".into(),
        request_id: "public-content-retention".into(),
    };
    let object = "retained-current-rule";
    let mut tx = AppTx::begin(&pool).await.unwrap();
    knowledge::seed_in_tx(&mut tx, &ctx, &json!({"objects":[{
        "id":object,"kind":"term","name":"合成保留规则","version":"1","state":"enabled",
        "source_id":null,"source_version":"0","related_ids":[],"updated_by":"alice","owner_id":"alice",
        "entries":[{"entry_id":"body","path":"body","source_facts":{},"suggestion":{},
            "human_override":{"value":"升级前第一版🧪。"},"effective_value":"升级前第一版🧪。"},
            {"entry_id":"untouched","path":"untouched","source_facts":{},"suggestion":{},
             "human_override":{"value":"未变条目。"},"effective_value":"未变条目。"}]
    }]})).await.unwrap();
    let original = knowledge::read_in_tx(&mut tx, &ctx, object, Some(1), true)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    // 显式保留升级前精确旧档；新策略不能改写或删除该历史行。
    sqlx::query("INSERT IGNORE INTO knowledge_versions(object_id,version,body) VALUES(?,1,?)")
        .bind(object)
        .bind(sqlx::types::Json(&original))
        .execute(&pool)
        .await
        .unwrap();
    let baseline = sqlx::query_scalar::<_, String>(
        "SELECT CAST(body AS CHAR) FROM knowledge_versions WHERE object_id=? AND version=1",
    )
    .bind(object)
    .fetch_one(&pool)
    .await
    .unwrap();
    let command = json!({"operation_id":"retention-edit-second","expected_version":"1", "entry_id":"body",
        "clear_override":false,"value":"第二版当前内容e\u{301}。","structured_value":null});
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let saved = knowledge::save_edit_in_tx(&mut tx, &ctx, object, &command, None)
        .await
        .unwrap();
    assert_eq!(saved["version"], "2");
    assert_eq!(
        knowledge::save_edit_in_tx(&mut tx, &ctx, object, &command, None)
            .await
            .unwrap(),
        saved,
        "原操作重传沿原回执，不再推进修订"
    );
    tx.commit().await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM knowledge_versions WHERE object_id=?")
            .bind(object)
            .fetch_one(&pool)
            .await
            .unwrap(),
        1,
        "新修订不增加逐版全文，旧档基线原样保留"
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT CAST(body AS CHAR) FROM knowledge_versions WHERE object_id=? AND version=1"
        )
        .bind(object)
        .fetch_one(&pool)
        .await
        .unwrap(),
        baseline
    );
    let metadata = sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
        "SELECT JSON_OBJECT('version',version,'updated_by',updated_by,'fingerprint',fingerprint,'changed_paths',changed_paths) FROM knowledge_revisions WHERE object_id=? AND version=2")
        .bind(object).fetch_one(&pool).await.unwrap().0;
    assert_eq!(metadata["version"], 2);
    assert_eq!(metadata["updated_by"], "alice");
    assert_eq!(
        metadata["fingerprint"],
        data_agent::types::fingerprint(&saved)
    );
    assert_eq!(metadata["changed_paths"], json!(["body"]));
    let mut tx = AppTx::begin(&pool).await.unwrap();
    assert_eq!(
        knowledge::read_in_tx(&mut tx, &ctx, object, Some(2), false)
            .await
            .unwrap(),
        saved
    );
    assert_eq!(
        knowledge::read_in_tx(&mut tx, &ctx, object, Some(1), true)
            .await
            .unwrap()["entries"][0]["effective_value"],
        "升级前第一版🧪。"
    );
    let third = knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        object,
        &json!({
            "operation_id":"retention-edit-third","expected_version":"2","entry_id":"body",
            "clear_override":false,"value":"第三版当前内容。","structured_value":null
        }),
        None,
    )
    .await
    .unwrap();
    assert_eq!(third["version"], "3");
    assert_eq!(
        knowledge::read_in_tx(&mut tx, &ctx, object, Some(2), true)
            .await
            .unwrap_err()
            .code,
        "not_available",
        "第二版未保留全文时不能拿第三版替代"
    );
    tx.commit().await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM knowledge_revisions WHERE object_id=?")
            .bind(object)
            .fetch_one(&pool)
            .await
            .unwrap(),
        3,
        "每个实际修订只保一份必要元信息"
    );
    pool.close().await;
}

#[tokio::test]
async fn catalog_revisions_keep_current_metadata_and_exact_legacy_content_without_new_archives() {
    assert_eq!(
        std::env::var("DATA_AGENT_PUBLIC_CONTENT_RETENTION").unwrap(),
        "latest_only"
    );
    let pool = harness_pool().await;
    let ctx = AccessContext {
        user_id: "alice".into(),
        space_id: "catalog-content-retention".into(),
        request_id: "catalog-content-retention".into(),
    };
    let namespace = "synthetic-retained-catalog";
    let original = catalog_table("升级前目录内容🧪。");
    assert_eq!(
        save_catalog(&pool, &ctx, namespace, &original).await,
        (1, true)
    );
    let source = ingestion::catalog::source_id(&ctx.space_id, namespace, "retained_events");
    let object = ingestion::catalog::table_object_id(&ctx.space_id, namespace, "retained_events");
    sqlx::query("INSERT IGNORE INTO source_snapshots(source_id,version,body,complete) SELECT source_id,revision,body,complete FROM source_current WHERE source_id=?")
        .bind(&source).execute(&pool).await.unwrap();
    sqlx::query("INSERT IGNORE INTO catalog_table_snapshots(source_id,version,namespace,body) SELECT source_id,revision,namespace,metadata FROM source_current WHERE source_id=?")
        .bind(&source).execute(&pool).await.unwrap();
    let old_body = sqlx::query_scalar::<_, String>(
        "SELECT body FROM source_snapshots WHERE source_id=? AND version=1",
    )
    .bind(&source)
    .fetch_one(&pool)
    .await
    .unwrap();
    let old_metadata = sqlx::query_scalar::<_, String>(
        "SELECT CAST(body AS CHAR) FROM catalog_table_snapshots WHERE source_id=? AND version=1",
    )
    .bind(&source)
    .fetch_one(&pool)
    .await
    .unwrap();
    let mut second = original.clone();
    second["platform_version"] = json!("2");
    second["comment"] = json!("当前第二版目录内容e\u{301}。");
    assert_eq!(
        save_catalog(&pool, &ctx, namespace, &second).await,
        (2, true)
    );
    assert_eq!(
        save_catalog(&pool, &ctx, namespace, &second).await,
        (2, false),
        "相同来源内容不重复推进修订"
    );
    for query in [
        "SELECT COUNT(*) FROM source_snapshots WHERE source_id=?",
        "SELECT COUNT(*) FROM catalog_table_snapshots WHERE source_id=?",
    ] {
        let count = sqlx::query_scalar::<_, i64>(query)
            .bind(&source)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 1, "新目录修订不能增加全文旧档：{query}");
    }
    let metadata = sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
        "SELECT JSON_OBJECT('version',r.version,'updated_by',r.updated_by,'content_fingerprint',r.content_fingerprint,'explanation_fingerprint',r.explanation_fingerprint,'comparison_method',r.comparison_method,'parsed',r.parsed,'complete',r.complete,'head_fingerprint',h.fingerprint,'current_fingerprint',c.content_fingerprint) FROM source_revisions r JOIN source_heads h ON h.id=r.source_id JOIN source_current c ON c.source_id=r.source_id AND c.revision=r.version WHERE r.source_id=? AND r.version=2")
        .bind(&source).fetch_one(&pool).await.unwrap().0;
    assert_eq!(metadata["version"], 2);
    assert_eq!(metadata["updated_by"], "alice");
    assert_eq!(metadata["comparison_method"], "sql_tokens_v2");
    assert_eq!(
        metadata["content_fingerprint"],
        metadata["head_fingerprint"]
    );
    assert_eq!(
        metadata["content_fingerprint"],
        metadata["current_fingerprint"]
    );
    assert_eq!(
        metadata["explanation_fingerprint"],
        metadata["content_fingerprint"]
    );
    assert_eq!(metadata["parsed"], 1);
    assert_eq!(metadata["complete"], 1);
    let mut observed = second.clone();
    observed["platform_version"] = json!("9");
    observed["maintainer_id"] = json!("bob");
    observed["node"]["sql"] =
        json!("INSERT  INTO retained_events\nSELECT event_id FROM synthetic_events;");
    assert_eq!(
        save_catalog(&pool, &ctx, namespace, &observed).await,
        (2, false),
        "纯排版及观测变化复用原修订"
    );
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let retained = ingestion::read_source_in_tx(&mut tx, &ctx, &source, 2)
        .await
        .unwrap();
    assert!(
        retained["body"]
            .as_str()
            .unwrap()
            .contains("当前第二版目录内容e\u{301}。")
    );
    assert_eq!(
        ingestion::read_source_in_tx(&mut tx, &ctx, &source, 1)
            .await
            .unwrap()["body"],
        old_body
    );
    assert_eq!(
        ingestion::catalog_candidate_in_tx(&mut tx, &ctx, &source, &object)
            .await
            .unwrap()["entries"][0]["effective_value"],
        second["comment"]
    );
    tx.commit().await.unwrap();
    let current = sqlx::query_scalar::<_, sqlx::types::Json<Value>>("SELECT JSON_OBJECT('body',body,'metadata',metadata,'observed',observed_metadata) FROM source_current WHERE source_id=?")
        .bind(&source).fetch_one(&pool).await.unwrap().0;
    assert_eq!(current["body"], retained["body"]);
    assert_eq!(current["metadata"], second, "纯排版不覆盖原正文元数据");
    assert_eq!(
        current["observed"],
        json!({"platform_version":"9","maintainer_id":"bob"})
    );
    let mut third = observed.clone();
    third["platform_version"] = json!("10");
    third["comment"] = json!("当前第三版目录内容。");
    assert_eq!(
        save_catalog(&pool, &ctx, namespace, &third).await,
        (3, true)
    );
    let mut tx = AppTx::begin(&pool).await.unwrap();
    assert_eq!(
        ingestion::read_source_in_tx(&mut tx, &ctx, &source, 2)
            .await
            .unwrap_err()
            .code,
        "not_available",
        "未保第二版全文不能由当前第三版替代"
    );
    assert_eq!(
        ingestion::read_source_in_tx(&mut tx, &ctx, &source, 1)
            .await
            .unwrap()["body"],
        old_body
    );
    tx.commit().await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT CAST(body AS CHAR) FROM catalog_table_snapshots WHERE source_id=? AND version=1"
        )
        .bind(&source)
        .fetch_one(&pool)
        .await
        .unwrap(),
        old_metadata
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM source_revisions WHERE source_id=?")
            .bind(&source)
            .fetch_one(&pool)
            .await
            .unwrap(),
        3
    );
    pool.close().await;
}

#[tokio::test]
async fn catalog_retirement_keeps_the_current_tombstone_and_metadata_without_new_archives() {
    let pool = harness_pool().await;
    let ctx = AccessContext {
        user_id: "alice".into(),
        space_id: "retired-content-retention".into(),
        request_id: "retired-content-retention".into(),
    };
    let namespace = "synthetic-retained-retirement";
    assert_eq!(
        save_catalog(&pool, &ctx, namespace, &catalog_table("退休前的合成来源。")).await,
        (1, true)
    );
    let source = ingestion::catalog::source_id(&ctx.space_id, namespace, "retained_events");
    sqlx::query("INSERT IGNORE INTO source_snapshots(source_id,version,body,complete) SELECT source_id,revision,body,complete FROM source_current WHERE source_id=?")
        .bind(&source).execute(&pool).await.unwrap();
    let baseline = sqlx::query_scalar::<_, String>(
        "SELECT body FROM source_snapshots WHERE source_id=? AND version=1",
    )
    .bind(&source)
    .fetch_one(&pool)
    .await
    .unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let read = ingestion::begin_catalog_read_in_tx(&mut tx, &ctx, "retention-retire")
        .await
        .unwrap();
    ingestion::retire_catalog_source_in_tx(&mut tx, &ctx, &read, &source)
        .await
        .unwrap();
    assert_eq!(
        ingestion::read_source_in_tx(&mut tx, &ctx, &source, 2)
            .await
            .unwrap()["body"],
        "平台已在权威完整目录中移除此表；历史说明保留，但不能继续用于新分析。"
    );
    tx.commit().await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM source_snapshots WHERE source_id=?")
            .bind(&source)
            .fetch_one(&pool)
            .await
            .unwrap(),
        1,
        "退休修订不能新增永久全文旧档"
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT body FROM source_snapshots WHERE source_id=? AND version=1"
        )
        .bind(&source)
        .fetch_one(&pool)
        .await
        .unwrap(),
        baseline
    );
    let metadata = sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
        "SELECT JSON_OBJECT('version',r.version,'updated_by',r.updated_by,'method',r.comparison_method,'fingerprint',r.content_fingerprint,'current_fingerprint',c.content_fingerprint,'head_fingerprint',h.fingerprint,'retired',p.retired) FROM source_revisions r JOIN source_current c ON c.source_id=r.source_id AND c.revision=r.version JOIN source_heads h ON h.id=r.source_id JOIN catalog_platform_heads p ON p.source_id=r.source_id WHERE r.source_id=? AND r.version=2")
        .bind(&source).fetch_one(&pool).await.unwrap().0;
    assert_eq!(metadata["version"], 2);
    assert_eq!(metadata["updated_by"], "alice");
    assert_eq!(metadata["method"], "raw_v1");
    assert_eq!(metadata["retired"], 1);
    assert_eq!(metadata["fingerprint"], metadata["current_fingerprint"]);
    assert_eq!(metadata["fingerprint"], metadata["head_fingerprint"]);
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let read = ingestion::begin_catalog_read_in_tx(&mut tx, &ctx, "retention-retire-again")
        .await
        .unwrap();
    ingestion::retire_catalog_source_in_tx(&mut tx, &ctx, &read, &source)
        .await
        .unwrap();
    assert_eq!(
        ingestion::source_version_in_tx(&mut tx, &ctx.space_id, &source)
            .await
            .unwrap(),
        2
    );
    tx.commit().await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM source_revisions WHERE source_id=?")
            .bind(&source)
            .fetch_one(&pool)
            .await
            .unwrap(),
        2,
        "已退休内容重传不增加修订元信息"
    );
    pool.close().await;
}

#[tokio::test]
async fn synthetic_source_revisions_keep_current_and_metadata_without_growing_the_legacy_archive() {
    let pool = harness_pool().await;
    let ctx = AccessContext {
        user_id: "alice".into(),
        space_id: "demo".into(),
        request_id: "synthetic-content-retention".into(),
    };
    let baseline = sqlx::query_as::<_, (u64, String)>(
        "SELECT version,body FROM source_snapshots WHERE source_id='schema' ORDER BY version",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert!(!baseline.is_empty(), "harness提供明确的升级前合成来源旧档");
    let revision_baseline = sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
        "SELECT JSON_OBJECT('version',version,'updated_by',updated_by,'content_fingerprint',content_fingerprint,'explanation_fingerprint',explanation_fingerprint,'comparison_method',comparison_method,'parsed',parsed,'complete',complete,'created_at',created_at) FROM source_revisions WHERE source_id='schema' ORDER BY version",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    let before = sqlx::query_scalar::<_, u64>(
        "SELECT version FROM source_heads WHERE id='schema' AND space_id='demo'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE source_heads SET fingerprint=REPEAT('0',64) WHERE id='schema' AND space_id='demo'",
    )
    .execute(&pool)
    .await
    .unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let changed = ingestion::sync_sources_in_tx(&mut tx, &ctx).await.unwrap();
    assert!(changed.changed.contains(&("schema".into(), before + 1)));
    assert_eq!(
        ingestion::read_source_in_tx(&mut tx, &ctx, "schema", before + 1)
            .await
            .unwrap()["body"],
        ingestion::source_body("schema.sql").unwrap()
    );
    tx.commit().await.unwrap();
    assert_eq!(
        sqlx::query_as::<_, (u64, String)>(
            "SELECT version,body FROM source_snapshots WHERE source_id='schema' ORDER BY version"
        )
        .fetch_all(&pool)
        .await
        .unwrap(),
        baseline,
        "合成来源新修订不增删或改写已有全文旧档"
    );
    let metadata = sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
        "SELECT JSON_OBJECT('version',r.version,'updated_by',r.updated_by,'method',r.comparison_method,'fingerprint',r.content_fingerprint,'current_fingerprint',c.content_fingerprint,'head_fingerprint',h.fingerprint) FROM source_revisions r JOIN source_current c ON c.source_id=r.source_id AND c.revision=r.version JOIN source_heads h ON h.id=r.source_id WHERE r.source_id='schema' AND r.version=?")
        .bind(before + 1).fetch_one(&pool).await.unwrap().0;
    assert_eq!(metadata["version"], before + 1);
    assert_eq!(metadata["updated_by"], "alice");
    assert_eq!(metadata["method"], "raw_v1");
    assert_eq!(metadata["fingerprint"], metadata["current_fingerprint"]);
    assert_eq!(metadata["fingerprint"], metadata["head_fingerprint"]);
    let revised = sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
        "SELECT JSON_OBJECT('version',version,'updated_by',updated_by,'content_fingerprint',content_fingerprint,'explanation_fingerprint',explanation_fingerprint,'comparison_method',comparison_method,'parsed',parsed,'complete',complete,'created_at',created_at) FROM source_revisions WHERE source_id='schema' ORDER BY version",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        revised.len(),
        revision_baseline.len() + 1,
        "实际改版恰增一份元信息"
    );
    assert_eq!(
        &revised[..revision_baseline.len()],
        revision_baseline.as_slice(),
        "原修订元信息逐字段保留"
    );
    let mut tx = AppTx::begin(&pool).await.unwrap();
    assert!(
        ingestion::sync_sources_in_tx(&mut tx, &ctx)
            .await
            .unwrap()
            .changed
            .is_empty()
    );
    tx.commit().await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
            "SELECT JSON_OBJECT('version',version,'updated_by',updated_by,'content_fingerprint',content_fingerprint,'explanation_fingerprint',explanation_fingerprint,'comparison_method',comparison_method,'parsed',parsed,'complete',complete,'created_at',created_at) FROM source_revisions WHERE source_id='schema' ORDER BY version",
        )
        .fetch_all(&pool)
        .await
        .unwrap(),
        revised,
        "未变合成来源不补造或改写历史元信息"
    );
    pool.close().await;
}

#[tokio::test]
async fn document_preparation_preserves_the_legacy_archive_and_independent_raw_index_job() {
    assert_eq!(
        std::env::var("DATA_AGENT_PUBLIC_CONTENT_RETENTION").unwrap(),
        "latest_only"
    );
    let pool = harness_pool().await;
    let ctx = AccessContext {
        user_id: "alice".into(),
        space_id: "document-content-retention".into(),
        request_id: "document-content-retention".into(),
    };
    let object = "retained-original-document";
    let original_text = "人工文档原文🧪e\u{301}，整理只补充解释。";
    let source =
        data_agent::contracts::decode("SourceKey", json!({"kind":"document","id":object})).unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    knowledge::seed_in_tx(&mut tx, &ctx, &json!({"objects":[{
        "id":object,"kind":"document","name":"合成旧档文档","version":"1","state":"enabled",
        "source_id":null,"source_version":"0","related_ids":[],"updated_by":"alice","owner_id":"alice",
        "entries":[{"entry_id":"body","path":"body","source_facts":{},"suggestion":{},
            "human_override":{"value":original_text},"effective_value":original_text}]
    }]})).await.unwrap();
    let original = knowledge::read_in_tx(&mut tx, &ctx, object, Some(1), true)
        .await
        .unwrap();
    knowledge::register_source_index_target_in_tx(
        &mut tx,
        &ctx.space_id,
        &source,
        1,
        Some(("original-raw-job", 2)),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    sqlx::query("INSERT INTO knowledge_versions(object_id,version,body) VALUES(?,1,?)")
        .bind(object)
        .bind(sqlx::types::Json(&original))
        .execute(&pool)
        .await
        .unwrap();
    let baseline = sqlx::query_scalar::<_, String>(
        "SELECT CAST(body AS CHAR) FROM knowledge_versions WHERE object_id=? AND version=1",
    )
    .bind(object)
    .fetch_one(&pool)
    .await
    .unwrap();
    let raw_before = sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
        "SELECT JSON_OBJECT('state',state,'vector_state',vector_state,'attempts',vector_attempts,'origin',origin_job_id,'target',vector_target,'lease',lease_until) FROM knowledge_index_jobs WHERE target_kind='source_excerpt' AND source_kind='document' AND object_id=? AND version=1")
        .bind(object).fetch_one(&pool).await.unwrap().0;
    sqlx::query("UPDATE knowledge_index_jobs SET state='done',vector_state='indexed',vector_attempts=2 WHERE target_kind='knowledge_entry' AND object_id=? AND version=1")
        .bind(object).execute(&pool).await.unwrap();
    let result = json!({"statements":[{
        "key":"derived-rule","target":{"object_id":object,"version":"1","path":"body"},
        "text":"整理所得的独立说明。","scope_text":"仅合成文档",
        "citations":[{"source":source,"revision":"1","locator":{"offset":0,"length":6}}],
        "supports":[],"supports_complete":true
    }],"relations":[],"unresolved":[],"semantic_status":"ready"});
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let saved = knowledge::apply_preparation_in_tx(
        &mut tx,
        &ctx,
        "retain-document-preparation",
        &source,
        "1",
        &result,
    )
    .await
    .unwrap();
    assert_eq!(saved[0]["version"], "1", "派生保存不推进原文修订");
    assert_eq!(saved[0]["entries"][0]["effective_value"], original_text);
    assert_eq!(
        knowledge::apply_preparation_in_tx(
            &mut tx,
            &ctx,
            "retain-document-preparation",
            &source,
            "1",
            &result
        )
        .await
        .unwrap(),
        saved,
        "原准备操作重传仍返回原回执"
    );
    tx.commit().await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT CAST(body AS CHAR) FROM knowledge_versions WHERE object_id=? AND version=1"
        )
        .bind(object)
        .fetch_optional(&pool)
        .await
        .unwrap(),
        Some(baseline),
        "同修订派生保存不能删除或重写升级前旧档"
    );
    let raw_after = sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
        "SELECT JSON_OBJECT('state',state,'vector_state',vector_state,'attempts',vector_attempts,'origin',origin_job_id,'target',vector_target,'lease',lease_until) FROM knowledge_index_jobs WHERE target_kind='source_excerpt' AND source_kind='document' AND object_id=? AND version=1")
        .bind(object).fetch_one(&pool).await.unwrap().0;
    assert_eq!(
        raw_after, raw_before,
        "派生解释不重置独立原文索引及原作业身份"
    );
    assert_eq!(sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
        "SELECT JSON_OBJECT('state',state,'vector_state',vector_state,'attempts',vector_attempts) FROM knowledge_index_jobs WHERE target_kind='knowledge_entry' AND object_id=? AND version=1")
        .bind(object).fetch_one(&pool).await.unwrap().0, json!({"state":"pending","vector_state":"pending","attempts":0}));
    let sid = saved[0]["entries"][0]["suggestion"]["statements"][0]["statement_id"]
        .as_str()
        .unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let reference = data_agent::contracts::decode(
        "EvidenceRef",
        json!({"object_id":object,"version":"1","path":"body"}),
    )
    .unwrap();
    assert_eq!(
        knowledge::read_entry_page_in_tx(&mut tx, &ctx, &reference, Some(sid), false, 0, 100)
            .await
            .unwrap()["content"],
        "整理所得的独立说明。\n仅合成文档"
    );
    assert_eq!(
        knowledge::read_entry_page_in_tx(&mut tx, &ctx, &reference, None, false, 0, 100)
            .await
            .unwrap()["content"],
        original_text
    );
    tx.commit().await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM knowledge_revisions WHERE object_id=?")
            .bind(object)
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
    pool.close().await;
}

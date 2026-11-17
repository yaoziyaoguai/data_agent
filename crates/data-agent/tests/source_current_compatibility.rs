use data_agent::{modules::ingestion, persistence::AppTx, types::AccessContext};
use serde_json::{Value, json};
use sqlx::MySqlPool;

async fn harness_pool() -> MySqlPool {
    let url = std::env::var("DATA_AGENT_DATABASE_URL").expect("isolated harness database");
    assert!(
        url.contains("/data_agent_test_"),
        "must use the isolated harness"
    );
    sqlx::mysql::MySqlPoolOptions::new()
        .max_connections(4)
        .connect(&url)
        .await
        .unwrap()
}

fn context(space: &str) -> AccessContext {
    AccessContext {
        user_id: "alice".into(),
        space_id: space.into(),
        request_id: "source-current-compatibility".into(),
    }
}

fn table(id: &str, comment: &str) -> Value {
    json!({"id":id,"name":id,"platform_version":"1","maintainer_id":"alice",
        "comment":comment,"ddl":format!("CREATE TABLE {id} (event_id INTEGER);"),
        "columns":[{"id":"event_id","name":"event_id","data_type":"INTEGER","nullable":false,"comment":"合成事件标识"}],
        "node":{"id":format!("load_{id}"),"sql":format!("INSERT INTO {id} SELECT event_id FROM synthetic_events;"),"upstream_ids":["synthetic_events"]}})
}

async fn save(
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

#[tokio::test]
async fn catalog_reads_use_same_revision_current_without_archive() {
    let pool = harness_pool().await;
    let ctx = context("source-current-catalog");
    let namespace = "synthetic-voice-current";
    let table = table("voice_events", "当前目录说明🧪");
    assert_eq!(save(&pool, &ctx, namespace, &table).await, (1, true));
    let source = ingestion::catalog::source_id(&ctx.space_id, namespace, "voice_events");
    let object = ingestion::catalog::table_object_id(&ctx.space_id, namespace, "voice_events");
    // 只在隔离夹具移除派生旧档，证明当前目录读取不依赖历史全文行。
    for statement in [
        "DELETE FROM catalog_table_snapshots WHERE source_id=? AND version=1",
        "DELETE FROM source_snapshots WHERE source_id=? AND version=1",
    ] {
        sqlx::query(statement)
            .bind(&source)
            .execute(&pool)
            .await
            .unwrap();
    }
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let candidate = ingestion::catalog_candidate_in_tx(&mut tx, &ctx, &source, &object)
        .await
        .expect("当前同修订目录候选须从 source_current 回读");
    assert_eq!(candidate["source_version"], "1");
    assert_eq!(candidate["entries"][0]["effective_value"], "当前目录说明🧪");
    assert_eq!(
        ingestion::catalog_upstream_in_tx(&mut tx, &ctx, &source)
            .await
            .unwrap(),
        vec![(
            ingestion::catalog::source_id(&ctx.space_id, namespace, "synthetic_events"),
            ingestion::catalog::table_object_id(&ctx.space_id, namespace, "synthetic_events"),
        )]
    );
    tx.commit().await.unwrap();
    pool.close().await;
}

#[tokio::test]
async fn missing_catalog_revision_cannot_be_replaced_by_empty_or_older_metadata() {
    let pool = harness_pool().await;
    let ctx = context("source-current-missing");
    let namespace = "synthetic-current-missing";
    let original = table("voice_missing", "第一版仅保留作精确历史");
    save(&pool, &ctx, namespace, &original).await;
    let mut latest = original.clone();
    latest["platform_version"] = json!("2");
    latest["comment"] = json!("当前第二版");
    save(&pool, &ctx, namespace, &latest).await;
    let source = ingestion::catalog::source_id(&ctx.space_id, namespace, "voice_missing");
    let object = ingestion::catalog::table_object_id(&ctx.space_id, namespace, "voice_missing");
    sqlx::query("UPDATE source_current SET revision=9 WHERE source_id=?")
        .bind(&source)
        .execute(&pool)
        .await
        .unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    assert_eq!(
        ingestion::catalog_candidate_in_tx(&mut tx, &ctx, &source, &object)
            .await
            .unwrap()["entries"][0]["effective_value"],
        "当前第二版"
    );
    assert_eq!(
        ingestion::catalog_upstream_in_tx(&mut tx, &ctx, &source)
            .await
            .unwrap()
            .len(),
        1
    );
    tx.commit().await.unwrap();
    sqlx::query("DELETE FROM catalog_table_snapshots WHERE source_id=? AND version=2")
        .bind(&source)
        .execute(&pool)
        .await
        .unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    assert_eq!(
        ingestion::catalog_candidate_in_tx(&mut tx, &ctx, &source, &object)
            .await
            .unwrap_err()
            .code,
        "not_available"
    );
    assert_eq!(
        ingestion::catalog_upstream_in_tx(&mut tx, &ctx, &source)
            .await
            .unwrap_err()
            .code,
        "not_available",
        "缺目录正文不能冒充没有上游"
    );
    let read = ingestion::begin_catalog_read_in_tx(&mut tx, &ctx, &data_agent::types::id())
        .await
        .unwrap();
    assert_eq!(
        ingestion::save_catalog_table_in_tx(&mut tx, &ctx, &read, namespace, &latest)
            .await
            .expect_err("缺少当前比较材料必须明确不可得，不能猜内容已变")
            .code,
        "not_available"
    );
    drop(tx);
    let mut tx = AppTx::begin(&pool).await.unwrap();
    assert_eq!(
        ingestion::backfill_current_in_tx(&mut tx)
            .await
            .expect_err("活动平台表缺少同修订元数据不能回填为空目录")
            .code,
        "not_available"
    );
    drop(tx);
    pool.close().await;
}

#[tokio::test]
async fn synthetic_writes_keep_current_and_head_in_one_transaction() {
    let pool = harness_pool().await;
    let ctx = context("demo");
    let sources = ingestion::synthetic_sources().unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    ingestion::sync_sources_in_tx(&mut tx, &ctx).await.unwrap();
    for (source, body) in &sources {
        assert_eq!(
            ingestion::current_source_body_in_tx(&mut tx, &ctx.space_id, source)
                .await
                .unwrap()
                .as_deref(),
            Some(body.as_str()),
            "未变合成来源也须在同步事务内建立同修订 current"
        );
    }
    tx.commit().await.unwrap();
    sqlx::query(
        "UPDATE source_heads SET fingerprint=REPEAT('0',64) WHERE id='schema' AND space_id='demo'",
    )
    .execute(&pool)
    .await
    .unwrap();
    let before = sqlx::query_scalar::<_, u64>("SELECT version FROM source_heads WHERE id='schema'")
        .fetch_one(&pool)
        .await
        .unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let changed = ingestion::sync_sources_in_tx(&mut tx, &ctx).await.unwrap();
    assert!(changed.changed.contains(&("schema".to_owned(), before + 1)));
    assert_eq!(
        ingestion::current_source_body_in_tx(&mut tx, &ctx.space_id, "schema")
            .await
            .unwrap(),
        Some(ingestion::source_body("schema.sql").unwrap())
    );
    let visible: (u64, u64) = sqlx::query_as(
        "SELECT h.version,c.revision FROM source_heads h JOIN source_current c ON c.source_id=h.id WHERE h.id='schema'",
    ).fetch_one(&pool).await.unwrap();
    assert_eq!(
        visible,
        (before, before),
        "事务提交前外部连接只能看见上一致版本"
    );
    tx.commit().await.unwrap();
    let visible: (u64, u64, i64) = sqlx::query_as(
        "SELECT h.version,c.revision,(SELECT COUNT(*) FROM source_snapshots s WHERE s.source_id=h.id AND s.version=h.version) FROM source_heads h JOIN source_current c ON c.source_id=h.id WHERE h.id='schema'",
    ).fetch_one(&pool).await.unwrap();
    assert_eq!(visible, (before + 1, before + 1, 1));
    pool.close().await;
}

#[tokio::test]
async fn retirement_writes_current_and_head_in_one_transaction() {
    let pool = harness_pool().await;
    let ctx = context("source-current-retire");
    let namespace = "synthetic-current-retire";
    let original = table("voice_retire", "退休前的完整旧正文");
    save(&pool, &ctx, namespace, &original).await;
    let source = ingestion::catalog::source_id(&ctx.space_id, namespace, "voice_retire");
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let read = ingestion::begin_catalog_read_in_tx(&mut tx, &ctx, &data_agent::types::id())
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
    let body = ingestion::current_source_body_in_tx(&mut tx, &ctx.space_id, &source)
        .await
        .unwrap()
        .expect("退休事务须同步写 current 墓碑");
    assert!(body.contains("平台已在权威完整目录中移除此表"));
    assert!(
        ingestion::effective_versions_in_tx(&mut tx, &ctx.space_id)
            .await
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty()
    );
    let visible: (u64, u64, bool) = sqlx::query_as(
        "SELECT h.version,c.revision,p.retired FROM source_heads h JOIN source_current c ON c.source_id=h.id JOIN catalog_platform_heads p ON p.source_id=h.id WHERE h.id=?",
    ).bind(&source).fetch_one(&pool).await.unwrap();
    assert_eq!(visible, (1, 1, false));
    tx.commit().await.unwrap();
    let visible: (u64, u64, bool) = sqlx::query_as(
        "SELECT h.version,c.revision,p.retired FROM source_heads h JOIN source_current c ON c.source_id=h.id JOIN catalog_platform_heads p ON p.source_id=h.id WHERE h.id=?",
    ).bind(&source).fetch_one(&pool).await.unwrap();
    assert_eq!(visible, (2, 2, true));
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let archived = ingestion::read_source_in_tx(&mut tx, &ctx, &source, 1)
        .await
        .unwrap();
    assert!(
        archived["body"]
            .as_str()
            .unwrap()
            .contains("退休前的完整旧正文")
    );
    let read = ingestion::begin_catalog_read_in_tx(&mut tx, &ctx, &data_agent::types::id())
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
    pool.close().await;
}

#[tokio::test]
async fn backfill_upgrades_current_without_archive_and_preserves_observation() {
    let pool = harness_pool().await;
    // harness 启动已登记四份合成来源；先完成其回填，再计量本例的单条方法升级。
    let mut bootstrap = AppTx::begin(&pool).await.unwrap();
    while ingestion::backfill_current_in_tx(&mut bootstrap)
        .await
        .unwrap()
        > 0
    {}
    bootstrap.commit().await.unwrap();
    let ctx = context("source-current-backfill");
    let namespace = "synthetic-current-backfill";
    let original = table("voice_backfill", "回填保留原文🧪");
    save(&pool, &ctx, namespace, &original).await;
    let source = ingestion::catalog::source_id(&ctx.space_id, namespace, "voice_backfill");
    let mut observed = original.clone();
    observed["platform_version"] = json!("9");
    observed["maintainer_id"] = json!("bob");
    assert_eq!(save(&pool, &ctx, namespace, &observed).await, (1, false));
    for statement in [
        "DELETE FROM catalog_table_snapshots WHERE source_id=? AND version=1",
        "DELETE FROM source_snapshots WHERE source_id=? AND version=1",
    ] {
        sqlx::query(statement)
            .bind(&source)
            .execute(&pool)
            .await
            .unwrap();
    }
    sqlx::query("UPDATE source_current SET comparison_method='legacy_comparison_v0',complete=0 WHERE source_id=?")
        .bind(&source).execute(&pool).await.unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    assert_eq!(
        ingestion::backfill_current_in_tx(&mut tx)
            .await
            .expect("同修订 current 的方法升级无需读取旧档"),
        1
    );
    let source_body = ingestion::read_source_in_tx(&mut tx, &ctx, &source, 1)
        .await
        .unwrap();
    assert_eq!(source_body["complete"], false, "方法升级保留正文完整性");
    assert!(
        source_body["body"]
            .as_str()
            .unwrap()
            .contains("回填保留原文🧪")
    );
    assert_eq!(ingestion::backfill_current_in_tx(&mut tx).await.unwrap(), 0);
    tx.commit().await.unwrap();
    let observation = sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
        "SELECT observed_metadata FROM source_current WHERE source_id=?",
    )
    .bind(&source)
    .fetch_one(&pool)
    .await
    .unwrap()
    .0;
    assert_eq!(
        observation,
        json!({"platform_version":"9","maintainer_id":"bob"})
    );
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let object = ingestion::catalog::table_object_id(&ctx.space_id, namespace, "voice_backfill");
    assert_eq!(
        ingestion::catalog_candidate_in_tx(&mut tx, &ctx, &source, &object)
            .await
            .unwrap()["entries"][0]["effective_value"],
        "回填保留原文🧪"
    );
    tx.commit().await.unwrap();
    pool.close().await;
}

#[tokio::test]
async fn effective_versions_use_current_completeness_and_exact_archive_fallback() {
    let pool = harness_pool().await;
    let ctx = context("source-current-effective");
    let namespace = "synthetic-current-effective";
    let mut sources = Vec::new();
    for (id, comment) in [
        ("current_only", "完整当前正文"),
        ("current_incomplete", "不完整当前正文"),
        ("legacy_only", "旧档完整正文"),
        ("stale_current", "旧当前内容不能冒充新头"),
    ] {
        save(&pool, &ctx, namespace, &table(id, comment)).await;
        sources.push(ingestion::catalog::source_id(&ctx.space_id, namespace, id));
    }
    sqlx::query("DELETE FROM source_snapshots WHERE source_id=?")
        .bind(&sources[0])
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE source_current SET complete=0 WHERE source_id=?")
        .bind(&sources[1])
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM source_current WHERE source_id=?")
        .bind(&sources[2])
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE source_current SET revision=9 WHERE source_id=?")
        .bind(&sources[3])
        .execute(&pool)
        .await
        .unwrap();
    let mut expected = [sources[0].clone(), sources[2].clone(), sources[3].clone()];
    expected.sort();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let versions = ingestion::effective_versions_in_tx(&mut tx, &ctx.space_id)
        .await
        .unwrap();
    assert_eq!(
        versions,
        json!(
            expected
                .iter()
                .map(|id| json!([id, "1"]))
                .collect::<Vec<_>>()
        ),
        "当前完整性优先，缺同修订 current 时只回退该头的完整 archive"
    );
    assert_eq!(
        ingestion::current_source_body_in_tx(&mut tx, &ctx.space_id, &sources[3])
            .await
            .unwrap(),
        None,
        "不匹配 head 的 current 正文不能参与当前依赖核验"
    );
    tx.commit().await.unwrap();
    pool.close().await;
}

#[tokio::test]
async fn comparison_reuses_retained_current_body_without_archive() {
    let pool = harness_pool().await;
    let ctx = context("source-current-comparison");
    let namespace = "synthetic-current-comparison";
    let original = table("voice_comparison", "业务说明保持原文");
    assert_eq!(save(&pool, &ctx, namespace, &original).await, (1, true));
    let source = ingestion::catalog::source_id(&ctx.space_id, namespace, "voice_comparison");
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let retained = ingestion::read_source_in_tx(&mut tx, &ctx, &source, 1)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    for statement in [
        "DELETE FROM catalog_table_snapshots WHERE source_id=? AND version=1",
        "DELETE FROM source_snapshots WHERE source_id=? AND version=1",
    ] {
        sqlx::query(statement)
            .bind(&source)
            .execute(&pool)
            .await
            .unwrap();
    }
    let mut observed = original.clone();
    observed["platform_version"] = json!("9");
    observed["maintainer_id"] = json!("bob");
    observed["node"]["sql"] =
        json!("INSERT  INTO voice_comparison\nSELECT event_id FROM synthetic_events;");
    assert_eq!(
        save(&pool, &ctx, namespace, &observed).await,
        (1, false),
        "同含义内容不能因旧档缺失升版或覆盖保留原文"
    );
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let reread = ingestion::read_source_in_tx(&mut tx, &ctx, &source, 1)
        .await
        .unwrap();
    assert_eq!(reread["body"], retained["body"]);
    tx.commit().await.unwrap();
    let observation = sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
        "SELECT observed_metadata FROM source_current WHERE source_id=?",
    )
    .bind(&source)
    .fetch_one(&pool)
    .await
    .unwrap()
    .0;
    assert_eq!(
        observation,
        json!({"platform_version":"9","maintainer_id":"bob"})
    );
    observed["platform_version"] = json!("10");
    observed["comment"] = json!("真实业务说明改版");
    assert_eq!(save(&pool, &ctx, namespace, &observed).await, (2, true));
    // 兼容阶段仍保存新修订的两份旧档，尚未切换 latest-only。
    for statement in [
        "SELECT COUNT(*) FROM source_snapshots WHERE source_id=? AND version=2",
        "SELECT COUNT(*) FROM catalog_table_snapshots WHERE source_id=? AND version=2",
    ] {
        assert_eq!(
            sqlx::query_scalar::<_, i64>(statement)
                .bind(&source)
                .fetch_one(&pool)
                .await
                .unwrap(),
            1
        );
    }
    pool.close().await;
}

#[tokio::test]
async fn source_bodies_preserve_exact_revisions_when_current_has_no_archive() {
    let pool = harness_pool().await;
    let ctx = context("source-current-bodies");
    let namespace = "synthetic-body-revisions";
    let original = table("voice_bodies", "旧第一版\n逐字原文🧪");
    assert_eq!(save(&pool, &ctx, namespace, &original).await, (1, true));
    let source = ingestion::catalog::source_id(&ctx.space_id, namespace, "voice_bodies");
    let mut second = original.clone();
    second["platform_version"] = json!("2");
    second["comment"] = json!("中间第二版");
    assert_eq!(save(&pool, &ctx, namespace, &second).await, (2, true));
    let mut latest = second.clone();
    latest["platform_version"] = json!("3");
    latest["comment"] = json!("当前第三版🧪e\u{301}。");
    assert_eq!(save(&pool, &ctx, namespace, &latest).await, (3, true));
    sqlx::query("DELETE FROM source_snapshots WHERE source_id=? AND version IN (2,3)")
        .bind(&source)
        .execute(&pool)
        .await
        .unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let archived = ingestion::read_source_in_tx(&mut tx, &ctx, &source, 1)
        .await
        .unwrap();
    let current = ingestion::read_source_in_tx(&mut tx, &ctx, &source, 3)
        .await
        .unwrap();
    assert!(
        archived["body"]
            .as_str()
            .unwrap()
            .contains("旧第一版\n逐字原文🧪")
    );
    assert!(
        current["body"]
            .as_str()
            .unwrap()
            .contains("当前第三版🧪e\u{301}。")
    );
    assert_eq!(
        ingestion::read_source_in_tx(&mut tx, &ctx, &source, 2)
            .await
            .unwrap_err()
            .code,
        "not_available"
    );
    let pairs = [
        (source.clone(), 3),
        (source.clone(), 1),
        (source.clone(), 2),
    ];
    let bodies = ingestion::snapshot_bodies_in_tx(&mut tx, &pairs)
        .await
        .unwrap();
    assert_eq!(
        bodies.get(&pairs[0]).map(String::as_str),
        current["body"].as_str(),
        "依赖登记读取当前修订不能依赖 archive"
    );
    assert_eq!(
        bodies.get(&pairs[1]).map(String::as_str),
        archived["body"].as_str()
    );
    assert!(
        !bodies.contains_key(&pairs[2]),
        "缺失的旧修订不能返回空白或当前正文"
    );
    let other = context("source-current-bodies-other-space");
    assert_eq!(
        ingestion::read_source_in_tx(&mut tx, &other, &source, 3)
            .await
            .unwrap_err()
            .code,
        "not_available"
    );
    tx.commit().await.unwrap();
    pool.close().await;
}

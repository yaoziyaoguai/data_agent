use data_agent::{
    contracts::generated::EvidenceRef, modules::knowledge, persistence::AppTx,
    types::AccessContext, use_cases::dependency_registration::after_content_saved_in_tx,
};
use serde_json::{Value, json};
use sqlx::{MySqlPool, Row};

async fn harness_pool() -> MySqlPool {
    let url = std::env::var("DATA_AGENT_DATABASE_URL").expect("isolated harness database");
    assert!(
        url.contains("/data_agent_test_"),
        "must use the isolated harness"
    );
    sqlx::mysql::MySqlPoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .unwrap()
}

fn context(request: &str) -> AccessContext {
    AccessContext {
        user_id: "alice".into(),
        space_id: "demo".into(),
        request_id: request.into(),
    }
}

fn reference(object: &str, path: &str, version: &str) -> EvidenceRef {
    EvidenceRef {
        object_id: object.into(),
        version: version.into(),
        path: path.into(),
    }
}

fn object(id: &str, kind: &str, entries: Value) -> Value {
    json!({"id":id,"kind":kind,"name":id,"version":"1","state":"enabled",
        "source_id":null,"source_version":"0","related_ids":[],
        "updated_by":"alice","owner_id":"alice","entries":entries})
}

fn statement(id: &str, text: &str, scope: &str, supports: Value) -> Value {
    json!({"statement_id":id,
        "object_ref":{"object_id":"placeholder","version":"1","path":"placeholder"},
        "text":text,"scope_text":scope,"origin":"human","citations":[],
        "supports":supports,"supports_complete":true})
}

async fn seed(pool: &MySqlPool, ctx: &AccessContext, objects: Value) {
    let mut tx = AppTx::begin(pool).await.unwrap();
    let saved = knowledge::seed_in_tx(&mut tx, ctx, &json!({"objects":objects}))
        .await
        .unwrap();
    after_content_saved_in_tx(&mut tx, ctx, &saved)
        .await
        .unwrap();
    tx.commit().await.unwrap();
}

async fn bytes_sent(pool: &MySqlPool) -> u64 {
    sqlx::query("SHOW SESSION STATUS LIKE 'Bytes_sent'")
        .fetch_one(pool)
        .await
        .unwrap()
        .get::<String, _>("Value")
        .parse()
        .unwrap()
}

#[tokio::test]
async fn revision_reads_use_current_content_and_only_the_exact_legacy_archive() {
    let pool = harness_pool().await;
    let ctx = context("synthetic-revision-read");
    let id = "read-current-with-legacy-archive";
    let mut current = object(
        id,
        "term",
        json!([
            {"entry_id":"body","path":"body","source_facts":{},"suggestion":{},
                "human_override":{"value":"当前第三版🧪e\u{301}。"},
                "effective_value":"当前第三版🧪e\u{301}。"}
        ]),
    );
    current["version"] = json!("3");
    seed(&pool, &ctx, json!([current])).await;
    // 显式构造升级前旧档；当前修订没有历史全文行。
    sqlx::query("DELETE FROM knowledge_versions WHERE object_id=?")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    let mut legacy = current.clone();
    legacy["version"] = json!("1");
    legacy["entries"][0]["human_override"]["value"] = json!("旧第一版\n逐字原文🧪。");
    legacy["entries"][0]["effective_value"] = json!("旧第一版\n逐字原文🧪。");
    sqlx::query("INSERT INTO knowledge_versions(object_id,version,body) VALUES(?,1,?)")
        .bind(id)
        .bind(sqlx::types::Json(&legacy))
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM knowledge_versions WHERE object_id=? AND version=3"
        )
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap(),
        0
    );
    let mut tx = AppTx::begin(&pool).await.unwrap();
    for manage in [true, false] {
        let read = knowledge::read_in_tx(&mut tx, &ctx, id, Some(3), manage)
            .await
            .expect("指定当前修订不能依赖旧档全文");
        assert_eq!(read["version"], "3");
        assert_eq!(
            read["entries"][0]["effective_value"],
            "当前第三版🧪e\u{301}。"
        );
    }
    let archived = knowledge::read_in_tx(&mut tx, &ctx, id, Some(1), true)
        .await
        .unwrap();
    assert_eq!(archived["version"], "1");
    assert_eq!(
        archived["entries"][0]["effective_value"],
        "旧第一版\n逐字原文🧪。"
    );
    for (version, manage, code) in [
        (2, true, "not_available"),
        (1, false, "stale_knowledge"),
        (2, false, "stale_knowledge"),
    ] {
        assert_eq!(
            knowledge::read_in_tx(&mut tx, &ctx, id, Some(version), manage)
                .await
                .unwrap_err()
                .code,
            code,
            "缺失旧档不能借当前正文，current_use仍拒绝过期修订"
        );
    }
    let foreign = AccessContext {
        space_id: "foreign-space".into(),
        ..ctx.clone()
    };
    for version in [1, 3] {
        assert_eq!(
            knowledge::read_in_tx(&mut tx, &foreign, id, Some(version), true)
                .await
                .unwrap_err()
                .code,
            "not_available"
        );
    }
    knowledge::change_state_in_tx(
        &mut tx,
        &ctx,
        id,
        &json!({"operation_id":"disable-revision-read","expected_version":"3"}),
        "disabled",
    )
    .await
    .unwrap();
    assert_eq!(
        knowledge::read_in_tx(&mut tx, &ctx, id, None, false)
            .await
            .unwrap_err()
            .code,
        "not_available"
    );
    assert_eq!(
        knowledge::read_in_tx(&mut tx, &ctx, id, None, true)
            .await
            .unwrap()["state"],
        "disabled"
    );
    tx.commit().await.unwrap();
    pool.close().await;
}

#[tokio::test]
async fn legacy_history_body_uses_same_revision_current_and_never_substitutes_for_a_missing_archive()
 {
    let pool = harness_pool().await;
    let ctx = context("synthetic-history-current-read");
    let id = "history-current-without-archive";
    let mut current = object(
        id,
        "term",
        json!([
            {"entry_id":"body","path":"body","source_facts":{},"suggestion":{},
                "human_override":{"value":"当前第三版。"},"effective_value":"当前第三版。"}
        ]),
    );
    current["version"] = json!("3");
    seed(&pool, &ctx, json!([current])).await;
    sqlx::query("DELETE FROM knowledge_versions WHERE object_id=?")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    let mut legacy = current.clone();
    legacy["version"] = json!("1");
    legacy["entries"][0]["effective_value"] = json!("精确旧版原文。");
    sqlx::query("INSERT INTO knowledge_versions(object_id,version,body) VALUES(?,1,?)")
        .bind(id)
        .bind(sqlx::types::Json(&legacy))
        .execute(&pool)
        .await
        .unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let read = knowledge::archived_body_in_tx(&mut tx, &ctx, id, 3)
        .await
        .unwrap()
        .expect("legacy历史核验应支持同版current");
    assert_eq!(read["entries"][0]["effective_value"], "当前第三版。");
    let archived = knowledge::archived_body_in_tx(&mut tx, &ctx, id, 1)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(archived["entries"][0]["effective_value"], "精确旧版原文。");
    assert!(
        knowledge::archived_body_in_tx(&mut tx, &ctx, id, 2)
            .await
            .unwrap()
            .is_none(),
        "缺失第二版不能用第三版代替"
    );
    let foreign = AccessContext {
        space_id: "foreign-space".into(),
        ..ctx.clone()
    };
    for revision in [1, 3] {
        assert!(
            knowledge::archived_body_in_tx(&mut tx, &foreign, id, revision)
                .await
                .unwrap()
                .is_none()
        );
    }
    tx.commit().await.unwrap();
    pool.close().await;
}

#[tokio::test]
async fn index_claim_freezes_the_locked_current_revision_without_an_archive() {
    let pool = harness_pool().await;
    let ctx = context("synthetic-current-index-claim");
    let id = "current-index-without-archive";
    seed(&pool, &ctx, json!([object(id, "term", json!([
        {"entry_id":"body","path":"body","source_facts":{},"suggestion":{},
            "human_override":{"value":"当前索引正文🧪。"},"effective_value":"当前索引正文🧪。"}
    ]))])).await;
    sqlx::query("DELETE FROM knowledge_versions WHERE object_id=?")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM knowledge_versions WHERE object_id=?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let jobs = knowledge::claim_index_batch_in_tx(&mut tx, &ctx, false, None, false)
        .await
        .expect("锁内索引领取不能依赖当前修订的archive");
    let job = jobs
        .iter()
        .find(|job| job["object_id"] == id)
        .expect("本次领取包含新对象");
    assert_eq!(job["job_version"], "1");
    assert_eq!(job["lease_epoch"], "1");
    assert_eq!(job["object"]["id"], id);
    assert_eq!(job["object"]["version"], "1");
    assert_eq!(
        job["object"]["entries"][0]["effective_value"],
        "当前索引正文🧪。"
    );
    tx.commit().await.unwrap();
    pool.close().await;
}

#[tokio::test]
async fn index_claim_does_not_wait_for_an_unrelated_job() {
    let pool = harness_pool().await;
    let ctx = context("synthetic-index-row-isolation");
    let id = "aa-isolated-index-target";
    seed(
        &pool,
        &ctx,
        json!([object(
            id,
            "term",
            json!([
                {"entry_id":"body","path":"body","source_facts":{},"suggestion":{},
                 "human_override":{"value":"索引锁隔离正文。"},"effective_value":"索引锁隔离正文。"}
            ])
        )]),
    )
    .await;
    let url = std::env::var("DATA_AGENT_DATABASE_URL").unwrap();
    let blocker = sqlx::mysql::MySqlPoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .unwrap();
    sqlx::query("UPDATE knowledge_index_jobs SET state='indexed',vector_state='indexed',vector_target='isolation-target'")
        .execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO knowledge_index_jobs(target_kind,source_kind,object_id,version,state) VALUES('knowledge_entry','','zz-unrelated-index-job',1,'pending')")
        .execute(&pool).await.unwrap();
    sqlx::query("UPDATE knowledge_index_jobs SET state='pending',vector_state='pending' WHERE target_kind='knowledge_entry' AND source_kind='' AND object_id=?")
        .bind(id).execute(&pool).await.unwrap();
    let mut held = blocker.begin().await.unwrap();
    sqlx::query("SELECT version FROM knowledge_index_jobs WHERE target_kind='knowledge_entry' AND source_kind='' AND object_id='zz-unrelated-index-job' AND version=1 FOR UPDATE")
        .fetch_one(&mut *held).await.unwrap();
    sqlx::query("SET SESSION innodb_lock_wait_timeout=1")
        .execute(&pool)
        .await
        .unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let jobs =
        knowledge::claim_index_batch_in_tx(&mut tx, &ctx, true, Some("isolation-target"), false)
            .await
            .expect("索引领取不能等待无关待办行");
    assert!(jobs.iter().any(|job| job["object_id"] == id));
    tx.commit().await.unwrap();
    held.rollback().await.unwrap();
    blocker.close().await;
    pool.close().await;
}

#[tokio::test]
async fn source_retirement_does_not_wait_for_an_unrelated_object() {
    let pool = harness_pool().await;
    let ctx = context("synthetic-retirement-row-isolation");
    let mut target = object("aa-retirement-target", "term", json!([]));
    target["source_id"] = json!("isolation-source");
    seed(
        &pool,
        &ctx,
        json!([
            target,
            object("zz-unrelated-retirement-object", "term", json!([]))
        ]),
    )
    .await;
    let url = std::env::var("DATA_AGENT_DATABASE_URL").unwrap();
    let blocker = sqlx::mysql::MySqlPoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .unwrap();
    let mut held = blocker.begin().await.unwrap();
    sqlx::query(
        "SELECT id FROM knowledge_objects WHERE id='zz-unrelated-retirement-object' FOR UPDATE",
    )
    .fetch_one(&mut *held)
    .await
    .unwrap();
    sqlx::query("SET SESSION innodb_lock_wait_timeout=1")
        .execute(&pool)
        .await
        .unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let retired = knowledge::retire_source_objects_in_tx(
        &mut tx,
        &ctx,
        "isolation-source",
        &Default::default(),
    )
    .await
    .expect("来源退休不能扫描锁住无关对象");
    assert_eq!(retired.len(), 1);
    assert_eq!(retired[0]["id"], "aa-retirement-target");
    tx.commit().await.unwrap();
    held.rollback().await.unwrap();
    blocker.close().await;
    pool.close().await;
}

#[tokio::test]
async fn source_retirement_rechecks_enable_after_the_transaction_snapshot() {
    let pool = harness_pool().await;
    let ctx = context("synthetic-retirement-current-state");
    let id = "snapshot-retirement-target";
    let mut target = object(id, "term", json!([]));
    target["state"] = json!("disabled");
    target["source_id"] = json!("snapshot-source");
    seed(&pool, &ctx, json!([target])).await;
    let url = std::env::var("DATA_AGENT_DATABASE_URL").unwrap();
    let peer = sqlx::mysql::MySqlPoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    assert_eq!(
        knowledge::read_in_tx(&mut tx, &ctx, id, None, true)
            .await
            .unwrap()["state"],
        "disabled"
    );
    let mut enabled = AppTx::begin(&peer).await.unwrap();
    knowledge::change_state_in_tx(
        &mut enabled,
        &ctx,
        id,
        &json!({"operation_id":"snapshot-enable","expected_version":"1"}),
        "enabled",
    )
    .await
    .unwrap();
    enabled.commit().await.unwrap();
    let retired = knowledge::retire_source_objects_in_tx(
        &mut tx,
        &ctx,
        "snapshot-source",
        &Default::default(),
    )
    .await
    .unwrap();
    assert_eq!(retired.len(), 1, "旧快照中的停用状态不能漏掉当前已启用对象");
    assert_eq!(retired[0]["state"], "disabled");
    tx.commit().await.unwrap();
    peer.close().await;
    pool.close().await;
}

#[tokio::test]
async fn canonical_statement_reads_keep_all_source_requirements_without_an_archive() {
    let pool = harness_pool().await;
    let ctx = context("synthetic-current-canonical-read");
    let id = "current-canonical-without-archive";
    let earlier = "不能整读的前置陈述。".repeat(12000);
    let selected = "甲🧪e\u{301}乙\n仅合成";
    let mut picked = statement("current-picked", "甲🧪e\u{301}乙", "仅合成", json!([]));
    picked["citations"] = json!([{"source":{"kind":"document","id":"current-canonical-citation"},
        "revision":"1","locator":{"offset":0,"length":4}}]);
    seed(&pool, &ctx, json!([
        object("current-canonical-citation", "document", json!([
            {"entry_id":"body","path":"body","source_facts":{},"suggestion":{},
                "human_override":{"value":"合成出处"},"effective_value":"合成出处"}
        ])),
        object(id, "term", json!([
            {"entry_id":"background","path":"background",
                "source_facts":{"source_id":"source-outside-selected-window","version":"7",
                    "value":"未选背景。".repeat(16000)},"suggestion":{},"human_override":null,
                "effective_value":"未选背景。".repeat(16000)},
            {"entry_id":"rule","path":"rule","source_facts":{},"suggestion":{},
                "human_override":{"value":format!("{earlier}\n\n{selected}"),"statements":[
                    statement("current-earlier", &earlier, "", json!([])),picked]},
                "effective_value":format!("{earlier}\n\n{selected}")}
        ]))
    ])).await;
    sqlx::query("DELETE FROM knowledge_versions WHERE object_id=?")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM knowledge_versions WHERE object_id=?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    pool.close().await;
    let pool = harness_pool().await;
    let before = bytes_sent(&pool).await;
    let offset = earlier.chars().count() + 2;
    let record = data_agent::types::fingerprint(&json!([
        "knowledge-statement-window-3",
        "demo",
        id,
        "1",
        "rule",
        "rule",
        "current-picked",
        offset
    ]));
    let mut location = json!({"entry_id":"rule","path":"rule","statement_id":"current-picked",
        "offset":offset,"length":9,"content_hash":data_agent::types::fingerprint(&json!(selected))});
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let read = knowledge::read_entries_in_tx(
        &mut tx,
        &ctx,
        id,
        1,
        &record,
        &mut location,
        &Default::default(),
    )
    .await
    .unwrap()
    .expect("规范窗口直接读取同版current");
    assert_eq!(read["entries"][0]["effective_value"], selected);
    assert_eq!(
        read["entries"][0]["statement_content"]["text"],
        "甲🧪e\u{301}乙"
    );
    assert_eq!(
        read["entries"][0]["statement_content"]["scope_text"],
        "仅合成"
    );
    assert_eq!(
        read["entries"][0]["statement_content"]["supports_complete"],
        true
    );
    assert_eq!(read["entries_total"], 2);
    assert_eq!(
        read["required_sources"],
        json!([
            ["document-current-canonical-citation", "1"],
            ["source-outside-selected-window", "7"]
        ]),
        "裁小非首陈述不能缩窄未选条目的必要来源"
    );
    let plain_record = data_agent::types::fingerprint(&json!([
        "knowledge-statement-window-3",
        "demo",
        id,
        "1",
        "background",
        "background",
        null,
        0
    ]));
    let mut plain_location =
        json!({"entry_id":"background","path":"background","offset":0,"length":5});
    let plain = knowledge::read_entries_in_tx(
        &mut tx,
        &ctx,
        id,
        1,
        &plain_record,
        &mut plain_location,
        &Default::default(),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(plain["entries"][0]["effective_value"], "未选背景。");
    assert_eq!(plain["required_sources"], read["required_sources"]);
    tx.commit().await.unwrap();
    let transferred = bytes_sent(&pool).await - before;
    assert!(
        transferred < 24_576,
        "两次窄读不能搬回背景/前陈述全文，实际{transferred}B"
    );
    println!("current canonical statement and plain window transferred {transferred}B");
    pool.close().await;
}

#[tokio::test]
async fn structure_references_read_the_current_effective_layer_without_an_archive() {
    let pool = harness_pool().await;
    let ctx = context("synthetic-current-structure-read");
    let id = "current-structure-without-archive";
    seed(&pool, &ctx, json!([object(id, "field", json!([
        {"entry_id":"binding","path":"binding","source_facts":{},
            "suggestion":{"value":"被人工替换的结构", "structured_value":{"kind":"field",
                "table":{"object_id":"replaced-table","version":"1"},"column":"old","unit":null}},
            "human_override":{"value":"当前结构正文。".repeat(18000),"structured_value":{"kind":"field",
                "table":{"object_id":"current-table","version":"4"},"column":"reading","unit":null}},
            "effective_value":"当前结构正文。".repeat(18000)}
    ]))])).await;
    sqlx::query("DELETE FROM knowledge_versions WHERE object_id=?")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM knowledge_versions WHERE object_id=?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    pool.close().await;
    let pool = harness_pool().await;
    let before = bytes_sent(&pool).await;
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let read = knowledge::read_structure_refs_in_tx(&mut tx, &ctx, id, 1)
        .await
        .unwrap();
    let entry = read["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["entry_id"] == "binding")
        .expect("同修订current结构不可因缺旧档消失");
    assert_eq!(entry["effective_structure"]["kind"], "field");
    assert_eq!(
        entry["effective_structure"]["table"],
        json!({"object_id":"current-table","version":"4"})
    );
    assert!(entry.get("effective_value").is_none());
    assert_eq!(
        knowledge::read_structure_refs_in_tx(&mut tx, &ctx, id, 2)
            .await
            .unwrap_err()
            .code,
        "stale_knowledge"
    );
    tx.commit().await.unwrap();
    let transferred = bytes_sent(&pool).await - before;
    assert!(
        transferred < 16_384,
        "结构引用不能下行条目长正文，实际{transferred}B"
    );
    println!("current structure references transferred {transferred}B");
    pool.close().await;
}

#[tokio::test]
async fn dependency_fingerprints_use_exact_current_or_legacy_content_without_guessing_missing_revisions()
 {
    let pool = harness_pool().await;
    let ctx = context("synthetic-current-dependency-fingerprint");
    let target = "current-fingerprint-target";
    let mut current = object(
        target,
        "term",
        json!([
            {"entry_id":"body","path":"body","source_facts":{},"suggestion":{},
                "human_override":{"value":"当前第三版内容"},"effective_value":"当前第三版内容"}
        ]),
    );
    current["version"] = json!("3");
    seed(&pool, &ctx, json!([current])).await;
    sqlx::query("DELETE FROM knowledge_versions WHERE object_id=?")
        .bind(target)
        .execute(&pool)
        .await
        .unwrap();
    let mut legacy = current.clone();
    legacy["version"] = json!("1");
    legacy["entries"][0]["effective_value"] = json!("旧版内容");
    sqlx::query("INSERT INTO knowledge_versions(object_id,version,body) VALUES(?,1,?)")
        .bind(target)
        .bind(sqlx::types::Json(&legacy))
        .execute(&pool)
        .await
        .unwrap();
    for (version, expected) in [
        (3, Some("当前第三版内容")),
        (1, Some("旧版内容")),
        (2, None),
    ] {
        let owner = format!("fingerprint-citing-{version}");
        let support = json!([{"support_id":"needed","role":"prerequisite",
            "reference":{"kind":"knowledge","ref":{"object_id":target,"version":version.to_string(),"path":"body"}},
            "content":null,"embedded_in":null}]);
        seed(&pool, &ctx, json!([object(&owner,"term",json!([
            {"entry_id":"rule","path":"rule","source_facts":{},"suggestion":{},
                "human_override":{"value":"合成规则","statements":[
                    statement("fingerprint-rule","合成规则","",support)]},"effective_value":"合成规则"}
        ]))])).await;
        let mut tx = AppTx::begin(&pool).await.unwrap();
        let rows = knowledge::dependency_index::effective_required_in_tx(&mut tx, &[(owner, 1)])
            .await
            .unwrap();
        let row = rows
            .iter()
            .find(|row| row.target_id == target)
            .expect("保留登记依赖身份");
        assert_eq!(row.target_revision, version);
        assert_eq!(row.target_path, "body");
        assert_eq!(
            row.target_fingerprint,
            expected
                .map(|text| data_agent::types::fingerprint(&json!(text)))
                .unwrap_or_default(),
            "同版current/精确旧档计算相关内容指纹，缺版保持unknown"
        );
        tx.commit().await.unwrap();
    }
    pool.close().await;
}

#[tokio::test]
async fn explicit_statement_pages_keep_unicode_fields_and_support_directory_without_large_transfer()
{
    let pool = harness_pool().await;
    let ctx = context("synthetic-statement-pages");
    let id = "page-human-statements";
    let support_ref = json!({"object_id":"page-prerequisite","version":"1","path":"body"});
    let citation = json!({"source":{"kind":"document","id":"page-citation"},
        "revision":"1","locator":{"offset":0,"length":5}});
    let mut picked = statement(
        "human-picked",
        "甲🧪e\u{301}乙",
        "仅👩\u{200d}🔬合成",
        json!([
            {"support_id":"embedded-condition","role":"prerequisite",
                "reference":{"kind":"knowledge","ref":support_ref},
                "content":"🧪e\u{301}","embedded_in":{"field":"text","locator":{"offset":1,"length":3}}},
            {"support_id":"large-exception","role":"exception",
                "reference":{"kind":"knowledge","ref":support_ref},
                "content":"未交付支持正文。".repeat(12000),"embedded_in":null}
        ]),
    );
    picked["citations"] = json!([citation]);
    let first = "非首陈述之前的未选长内容。".repeat(12000);
    let last = "最后一条独立陈述。";
    let rendered = format!("{first}\n\n甲🧪e\u{301}乙\n仅👩\u{200d}🔬合成\n\n{last}");
    seed(&pool, &ctx, json!([
        object("page-prerequisite", "term", json!([
            {"entry_id":"body","path":"body","source_facts":{},"suggestion":{},
                "human_override":{"value":"公开合成前提。"},"effective_value":"公开合成前提。"}
        ])),
        object("page-citation", "document", json!([
            {"entry_id":"body","path":"body","source_facts":{},"suggestion":{},
                "human_override":{"value":"合成出处正文。"},"effective_value":"合成出处正文。"}
        ])),
        object(id, "term", json!([
            {"entry_id":"unselected","path":"unselected","source_facts":{},"suggestion":{},
                "human_override":{"value":"未选条目。".repeat(18000)},
                "effective_value":"未选条目。".repeat(18000)},
            {"entry_id":"selected-entry","path":"rule","label":"合成规则","review_state":"confirmed",
                "source_facts":{},"suggestion":{"value":"已被人工替换的建议。",
                    "statements":[statement("hidden-suggestion", "已替换建议陈述。", "", json!([]))]},
                "human_override":{"value":rendered,"edited_by":"alice","statements":[
                    statement("human-first", &first, "", json!([])),picked,
                    statement("human-last", last, "", json!([]))]},"effective_value":rendered}
        ]))
    ])).await;
    pool.close().await;

    // 重连后只经公开 owner 读取；会话字节计数证明没有先把大正文搬回应用再裁剪。
    let pool = harness_pool().await;
    let before = bytes_sent(&pool).await;
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let reference = reference(id, "rule", "1");
    let first = knowledge::read_entry_page_in_tx(
        &mut tx,
        &ctx,
        &reference,
        Some("human-picked"),
        false,
        1,
        3,
    )
    .await
    .unwrap();
    assert_eq!(
        first["content"], "🧪e\u{301}",
        "按非首陈述自己的 Unicode 坐标分页"
    );
    assert_eq!(first["entry_id"], "selected-entry");
    assert_eq!(first["path"], "rule");
    assert_eq!(first["statement_id"], "human-picked");
    assert_eq!(
        first["content_page"],
        json!({"offset":1,"total_chars":12,"complete":false,"next_offset":4})
    );
    assert_eq!(first["text"], "🧪e\u{301}");
    assert_eq!(first["text_chars"], 5);
    assert_eq!(first["scope_text"], "");
    assert_eq!(first["scope_chars"], 6);
    assert_eq!(first["supports_complete"], true);
    assert_eq!(first["citations"], json!([citation]));
    assert_eq!(
        first["supports"],
        json!([
            {"support_id":"embedded-condition","role":"prerequisite",
                "reference":{"kind":"knowledge","ref":support_ref},
                "embedded_in":{"field":"text","locator":{"offset":1,"length":3}}},
            {"support_id":"large-exception","role":"exception",
                "reference":{"kind":"knowledge","ref":support_ref},"embedded_in":null}
        ]),
        "保留支持目录及承载坐标，不能附带支持正文"
    );
    let middle = knowledge::read_entry_page_in_tx(
        &mut tx,
        &ctx,
        &reference,
        Some("human-picked"),
        false,
        4,
        4,
    )
    .await
    .unwrap();
    assert_eq!(middle["content"], "乙\n仅👩");
    assert_eq!(middle["text"], "乙");
    assert_eq!(middle["scope_text"], "仅👩");
    assert_eq!(middle["content_page"]["next_offset"], 8);
    let tail = knowledge::read_entry_page_in_tx(
        &mut tx,
        &ctx,
        &reference,
        Some("human-picked"),
        false,
        8,
        4,
    )
    .await
    .unwrap();
    assert_eq!(tail["content"], "\u{200d}🔬合成");
    assert_eq!(tail["text"], "");
    assert_eq!(tail["scope_text"], "\u{200d}🔬合成");
    assert_eq!(
        tail["content_page"],
        json!({"offset":8,"total_chars":12,"complete":false,"next_offset":null})
    );
    let full = knowledge::read_entry_page_in_tx(
        &mut tx,
        &ctx,
        &reference,
        Some("human-picked"),
        false,
        0,
        12,
    )
    .await
    .unwrap();
    assert_eq!(full["content"], "甲🧪e\u{301}乙\n仅👩\u{200d}🔬合成");
    assert_eq!(full["text"], "甲🧪e\u{301}乙");
    assert_eq!(full["scope_text"], "仅👩\u{200d}🔬合成");
    assert_eq!(full["content_page"]["complete"], true);
    let directory = knowledge::read_entry_page_in_tx(
        &mut tx,
        &ctx,
        &reference,
        Some("human-picked"),
        false,
        0,
        0,
    )
    .await
    .unwrap();
    assert_eq!(directory["content"], "");
    assert_eq!(directory["content_page"]["next_offset"], 0);
    assert_eq!(directory["supports"], first["supports"]);
    tx.commit().await.unwrap();
    let transferred = bytes_sent(&pool).await - before;
    assert!(
        transferred < 24_576,
        "五次短页不应下行大支持、前陈述或其他条目，实际 {transferred}B"
    );
    println!("selected statement pages transferred {transferred}B");
    pool.close().await;
}

#[tokio::test]
async fn entry_pages_keep_original_content_and_saved_declarations_without_guessing_completeness() {
    let pool = harness_pool().await;
    let ctx = context("synthetic-entry-pages");
    let id = "page-source-statements";
    let citation = json!({"source":{"kind":"document","id":"page-entry-citation"},
        "revision":"1","locator":{"offset":0,"length":3}});
    let support_ref = json!({"object_id":"page-entry-support","version":"1","path":"body"});
    let mut statements = Vec::new();
    for (sid, declaration) in [
        ("saved-true", Some(json!(true))),
        ("saved-false", Some(json!(false))),
        ("saved-null", Some(Value::Null)),
        ("saved-legacy", None),
    ] {
        let mut saved = statement(sid, "原陈述🧪", "仅合成范围", json!([]));
        saved["origin"] = json!("source_fact");
        if let Some(value) = declaration {
            saved["supports_complete"] = value;
        } else {
            saved.as_object_mut().unwrap().remove("supports_complete");
        }
        statements.push(saved);
    }
    statements[0]["citations"] = json!([citation]);
    statements[0]["supports"] = json!([{"support_id":"entry-exception","role":"exception",
        "reference":{"kind":"knowledge","ref":support_ref},
        "content":"未选支持正文。".repeat(16000),"embedded_in":null}]);
    seed(&pool, &ctx, json!([
        object("page-entry-citation", "document", json!([
            {"entry_id":"body","path":"body","source_facts":{},"suggestion":{},
                "human_override":{"value":"合成出处"},"effective_value":"合成出处"}
        ])),
        object("page-entry-support", "term", json!([
            {"entry_id":"body","path":"body","source_facts":{},"suggestion":{},
                "human_override":{"value":"合成支持"},"effective_value":"合成支持"}
        ])),
        object(id, "term", json!([
            {"entry_id":"unselected","path":"unselected","source_facts":{},"suggestion":{},
                "human_override":{"value":"无关条目。".repeat(16000)},
                "effective_value":"无关条目。".repeat(16000)},
            {"entry_id":"source-entry","path":"source-rule","label":"合成来源陈述",
                "source_facts":{"value":"原条目🧪e\u{301}尾","statements":statements},
                "suggestion":{},"human_override":null,"effective_value":"原条目🧪e\u{301}尾"}
        ]))
    ])).await;
    pool.close().await;

    let pool = harness_pool().await;
    let before = bytes_sent(&pool).await;
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let reference = reference(id, "source-rule", "1");
    let page = knowledge::read_entry_page_in_tx(&mut tx, &ctx, &reference, None, false, 3, 3)
        .await
        .unwrap();
    assert_eq!(
        page["content"], "🧪e\u{301}",
        "entry 读取沿保存原文，不能拼接陈述替换"
    );
    assert_eq!(page["entry_id"], "source-entry");
    assert!(page.get("statement_id").is_none());
    assert_eq!(
        page["content_page"],
        json!({"offset":3,"total_chars":7,"complete":false,"next_offset":6})
    );
    assert_eq!(
        page.get("supports_complete"),
        Some(&Value::Null),
        "条目不能凭已知四条陈述猜支持完整"
    );
    assert_eq!(page["citations"], json!([citation]));
    assert_eq!(
        page["supports"],
        json!([{"support_id":"entry-exception","role":"exception",
        "reference":{"kind":"knowledge","ref":support_ref},"embedded_in":null}])
    );
    for (sid, declaration) in [
        ("saved-true", json!(true)),
        ("saved-false", json!(false)),
        ("saved-null", Value::Null),
        ("saved-legacy", Value::Null),
    ] {
        let selected =
            knowledge::read_entry_page_in_tx(&mut tx, &ctx, &reference, Some(sid), false, 0, 40)
                .await
                .unwrap();
        assert_eq!(selected["content"], "原陈述🧪\n仅合成范围");
        assert_eq!(selected["text"], "原陈述🧪");
        assert_eq!(selected["scope_text"], "仅合成范围");
        assert_eq!(
            selected.get("supports_complete"),
            Some(&declaration),
            "{sid} 必须保留保存声明"
        );
    }
    let tail = knowledge::read_entry_page_in_tx(&mut tx, &ctx, &reference, None, false, 6, 1)
        .await
        .unwrap();
    assert_eq!(tail["content"], "尾");
    assert_eq!(
        tail["content_page"],
        json!({"offset":6,"total_chars":7,"complete":false,"next_offset":null})
    );
    tx.commit().await.unwrap();
    let transferred = bytes_sent(&pool).await - before;
    assert!(
        transferred < 24_576,
        "entry 与陈述页不得下行支持/未选条目，实际 {transferred}B"
    );
    println!("entry and saved declaration pages transferred {transferred}B");
    pool.close().await;
}

#[tokio::test]
async fn structure_pages_are_independent_and_only_a_whole_json_page_exposes_the_saved_structure() {
    let pool = harness_pool().await;
    let ctx = context("synthetic-structure-pages");
    let id = "page-structured-field";
    let table_ref = json!({"object_id":"page-structure-table","version":"1"});
    let structure =
        json!({"kind":"field","table":table_ref,"column":"reading","unit":"分🧪e\u{301}"});
    seed(&pool, &ctx, json!([
        object("page-structure-table", "table", json!([
            {"entry_id":"ddl","path":"ddl","source_facts":{"value":"CREATE TABLE synthetic_meter (reading INTEGER);"},
                "suggestion":{},"human_override":null,"effective_value":"CREATE TABLE synthetic_meter (reading INTEGER);"},
            {"entry_id":"etl","path":"etl","source_facts":{"value":"未选加工SQL。".repeat(16000)},
                "suggestion":{},"human_override":null,"effective_value":"未选加工SQL。".repeat(16000)}
        ])),
        object(id, "field", json!([
            {"entry_id":"unselected","path":"unselected","source_facts":{},"suggestion":{},
                "human_override":{"value":"无关字段背景。".repeat(16000)},
                "effective_value":"无关字段背景。".repeat(16000)},
            {"entry_id":"binding-entry","path":"binding","label":"合成字段结构","review_state":"confirmed",
                "source_facts":{"value":"底层解释","structured_value":{"kind":"field","table":table_ref,
                    "column":"replaced_column","unit":null}},"suggestion":{},
                "human_override":{"value":"结构正文不参与结构分页。".repeat(12000),"structured_value":structure},
                "effective_value":"结构正文不参与结构分页。".repeat(12000)}
        ]))
    ])).await;
    pool.close().await;

    let pool = harness_pool().await;
    let before = bytes_sent(&pool).await;
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let reference = reference(id, "binding", "1");
    let first = knowledge::read_entry_page_in_tx(&mut tx, &ctx, &reference, None, true, 0, 1)
        .await
        .unwrap();
    assert_eq!(
        first["content"], "{",
        "结构页自己的 offset0 不得读取长正文的首字"
    );
    assert_eq!(first["structure_text"], "{");
    assert_eq!(first["structure_page"], first["content_page"]);
    assert_eq!(first["structure_page"]["next_offset"], 1);
    assert_eq!(first["structure_page"]["complete"], false);
    assert!(
        first["effective_structure"].is_null(),
        "部分 JSON 不是可采用的结构"
    );
    assert_eq!(
        first["structure_refs"],
        json!({"kind":"field","table":table_ref,
        "left_table":null,"right_table":null,"dependencies":null,"verification":{"evidence_refs":null}})
    );
    let tail = knowledge::read_entry_page_in_tx(&mut tx, &ctx, &reference, None, true, 1, 4096)
        .await
        .unwrap();
    assert_eq!(tail["structure_page"]["next_offset"], Value::Null);
    assert_eq!(
        tail["structure_page"]["complete"], false,
        "尾页到末尾也没有独自带上完整 JSON"
    );
    assert!(tail["effective_structure"].is_null());
    let combined = format!(
        "{}{}",
        first["content"].as_str().unwrap(),
        tail["content"].as_str().unwrap()
    );
    assert_eq!(serde_json::from_str::<Value>(&combined).unwrap(), structure);
    let full = knowledge::read_entry_page_in_tx(&mut tx, &ctx, &reference, None, true, 0, 4096)
        .await
        .unwrap();
    assert_eq!(
        full["effective_structure"], structure,
        "只有同页完整 JSON 才能交给原 use_cases 采用核验"
    );
    assert_eq!(full["structure_text"], combined);
    assert_eq!(full["content_page"]["complete"], true);
    assert_eq!(full["entry_id"], "binding-entry");
    assert_eq!(
        full["content_page"]["total_chars"],
        combined.chars().count()
    );
    assert_eq!(full["supports"], json!([]));
    assert_eq!(full.get("supports_complete"), Some(&Value::Null));
    assert_eq!(full["citations"], json!([]));
    let body = knowledge::read_entry_page_in_tx(&mut tx, &ctx, &reference, None, false, 0, 2)
        .await
        .unwrap();
    assert_eq!(body["content"], "结构");
    assert!(
        body.get("effective_structure").is_none(),
        "正文读取不顺带搬回结构对象"
    );
    tx.commit().await.unwrap();
    let transferred = bytes_sent(&pool).await - before;
    assert!(
        transferred < 16_384,
        "结构独立分页不得下行正文或未选加工SQL，实际 {transferred}B"
    );
    println!("independent structure pages transferred {transferred}B");
    pool.close().await;
}

#[tokio::test]
async fn prepared_document_statements_remain_selectable_without_replacing_the_original_entry() {
    let pool = harness_pool().await;
    let ctx = context("synthetic-prepared-page");
    let id = "page-prepared-document";
    let citation = json!({"source":{"kind":"document","id":id},"revision":"1",
        "locator":{"offset":0,"length":5}});
    let source = data_agent::contracts::decode("SourceKey", citation["source"].clone()).unwrap();
    seed(&pool, &ctx, json!([object(id, "document", json!([
        {"entry_id":"unselected","path":"unselected","source_facts":{},"suggestion":{},
            "human_override":{"value":"未选背景。".repeat(18000)},"effective_value":"未选背景。".repeat(18000)},
        {"entry_id":"document-rule","path":"rule","source_facts":{},"suggestion":{},
            "human_override":{"value":"文档原文🧪e\u{301}。"},"effective_value":"文档原文🧪e\u{301}。"}
    ]))])).await;
    let result = json!({"statements":[
        {"key":"before","target":{"object_id":id,"version":"1","path":"rule"},
            "text":"未选整理陈述。".repeat(16000),"scope_text":"","citations":[citation],"supports":[]},
        {"key":"picked","target":{"object_id":id,"version":"1","path":"rule"},
            "text":"计数🧪e\u{301}","scope_text":"仅已确认","citations":[citation],"supports":[],"supports_complete":false},
        {"key":"last","target":{"object_id":id,"version":"1","path":"rule"},
            "text":"旧整理陈述。","scope_text":"","citations":[citation],"supports":[]}
    ],"relations":[],"unresolved":[],"semantic_status":"ready"});
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let saved = knowledge::apply_preparation_in_tx(
        &mut tx,
        &ctx,
        "prepare-page-document",
        &source,
        "1",
        &result,
    )
    .await
    .unwrap();
    after_content_saved_in_tx(&mut tx, &ctx, &saved)
        .await
        .unwrap();
    // 陈述 ID 来自公开保存回执；正文与坐标预期来自上面的独立合成文字。
    let sid = saved[0]["entries"][1]["suggestion"]["statements"][1]["statement_id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(saved[0]["version"], "1", "文档整理不推进原文修订");
    tx.commit().await.unwrap();
    pool.close().await;

    let pool = harness_pool().await;
    let before = bytes_sent(&pool).await;
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let reference = reference(id, "rule", "1");
    let picked =
        knowledge::read_entry_page_in_tx(&mut tx, &ctx, &reference, Some(&sid), false, 1, 8)
            .await
            .unwrap();
    assert_eq!(picked["content"], "数🧪e\u{301}\n仅已确");
    assert_eq!(picked["text"], "数🧪e\u{301}");
    assert_eq!(picked["scope_text"], "仅已确");
    assert_eq!(picked["supports_complete"], false);
    assert_eq!(picked["citations"], json!([citation]));
    assert_eq!(
        picked["content_page"],
        json!({"offset":1,"total_chars":10,"complete":false,"next_offset":9})
    );
    let entry = knowledge::read_entry_page_in_tx(&mut tx, &ctx, &reference, None, false, 0, 30)
        .await
        .unwrap();
    assert_eq!(entry["content"], "文档原文🧪e\u{301}。");
    assert_eq!(entry.get("supports_complete"), Some(&Value::Null));
    tx.commit().await.unwrap();
    let transferred = bytes_sent(&pool).await - before;
    assert!(
        transferred < 16_384,
        "document 整理解释不能下行大背景或其他整理正文，实际 {transferred}B"
    );
    println!("prepared document pages transferred {transferred}B");
    pool.close().await;
}

#[tokio::test]
async fn unavailable_statement_and_structure_locations_keep_state_version_and_layer_boundaries() {
    let pool = harness_pool().await;
    let ctx = context("synthetic-page-boundaries");
    let id = "page-location-boundaries";
    let table_ref = json!({"object_id":"page-boundary-table","version":"1"});
    seed(&pool, &ctx, json!([
        object(id, "field", json!([
            {"entry_id":"active-entry","path":"active","source_facts":{"value":"底层旧文",
                "structured_value":{"kind":"field","table":table_ref,"column":"old","unit":null}},
                "suggestion":{"value":"已替换建议","statements":[statement("replaced-suggestion", "已替换建议", "", json!([]))]},
                "human_override":{"value":"当前🧪e\u{301}","statements":[statement("current-statement", "当前🧪e\u{301}", "", json!([]))]},
                "effective_value":"当前🧪e\u{301}"},
            {"entry_id":"other-entry","path":"other","source_facts":{},"suggestion":{},
                "human_override":{"value":"别条陈述","statements":[statement("other-statement", "别条陈述", "", json!([]))]},
                "effective_value":"别条陈述"}
        ])),
        object("page-has-structure", "field", json!([
            {"entry_id":"rule","path":"rule","source_facts":{},"suggestion":{},
                "human_override":{"value":"结构对应正文","structured_value":{"kind":"field",
                    "table":table_ref,"column":"reading","unit":null},
                    "statements":[statement("structured-statement", "结构对应正文", "", json!([]))]},
                "effective_value":"结构对应正文"}
        ]))
    ])).await;
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let active = reference(id, "active", "1");
    for (reference, sid, structure_only, code) in [
        (
            reference("page-object-missing", "active", "1"),
            None,
            false,
            "not_available",
        ),
        (reference(id, "missing", "1"), None, false, "not_available"),
        (reference(id, "Active", "1"), None, false, "not_available"),
        (
            active.clone(),
            Some("missing-statement"),
            false,
            "not_available",
        ),
        (
            active.clone(),
            Some("other-statement"),
            false,
            "not_available",
        ),
        (
            active.clone(),
            Some("Current-statement"),
            false,
            "not_available",
        ),
        (
            active.clone(),
            Some("replaced-suggestion"),
            false,
            "not_available",
        ),
        (active.clone(), None, true, "not_available"),
        (
            reference("page-has-structure", "rule", "1"),
            Some("missing-statement"),
            true,
            "not_available",
        ),
    ] {
        assert_eq!(
            knowledge::read_entry_page_in_tx(&mut tx, &ctx, &reference, sid, structure_only, 0, 8)
                .await
                .unwrap_err()
                .code,
            code,
            "引用/陈述/有效层缺项必须拒绝，不能选中别处内容"
        );
    }
    let full_structure = knowledge::read_entry_page_in_tx(
        &mut tx,
        &ctx,
        &reference("page-has-structure", "rule", "1"),
        Some("structured-statement"),
        true,
        0,
        4096,
    )
    .await
    .unwrap();
    assert_eq!(full_structure["effective_structure"]["column"], "reading");
    assert_eq!(full_structure["statement_id"], "structured-statement");
    assert_eq!(
        full_structure["supports_complete"], true,
        "结构读取的显式陈述仍保留保存的支持声明"
    );
    for sid in [None, Some("current-statement")] {
        let empty = knowledge::read_entry_page_in_tx(&mut tx, &ctx, &active, sid, false, 5, 1)
            .await
            .unwrap();
        assert_eq!(empty["content"], "");
        assert_eq!(empty["content_page"]["next_offset"], Value::Null);
        assert_eq!(
            knowledge::read_entry_page_in_tx(&mut tx, &ctx, &active, sid, false, 6, 1)
                .await
                .unwrap_err()
                .code,
            "invalid_input",
            "不能把超出正文的offset静默当成功空页"
        );
    }
    let foreign = AccessContext {
        space_id: "other-space".into(),
        ..ctx.clone()
    };
    assert_eq!(
        knowledge::read_entry_page_in_tx(&mut tx, &foreign, &active, None, false, 0, 2)
            .await
            .unwrap_err()
            .code,
        "not_available"
    );
    let changed = knowledge::save_edit_in_tx(
        &mut tx,
        &ctx,
        id,
        &json!({"operation_id":"revise-page-boundaries","expected_version":"1",
            "entry_id":"active-entry","value":"改版正文","structured_value":null}),
        None,
    )
    .await
    .unwrap();
    after_content_saved_in_tx(&mut tx, &ctx, std::slice::from_ref(&changed))
        .await
        .unwrap();
    tx.commit().await.unwrap();
    pool.close().await;

    let pool = harness_pool().await;
    let mut tx = AppTx::begin(&pool).await.unwrap();
    for (sid, structure_only) in [
        (None, false),
        (Some("current-statement"), false),
        (None, true),
    ] {
        assert_eq!(
            knowledge::read_entry_page_in_tx(&mut tx, &ctx, &active, sid, structure_only, 0, 8)
                .await
                .unwrap_err()
                .code,
            "stale_knowledge",
            "旧版本即使陈述已消失也必须明确stale"
        );
    }
    let disabled = knowledge::change_state_in_tx(
        &mut tx,
        &ctx,
        id,
        &json!({"operation_id":"disable-page-boundaries","expected_version":"2"}),
        "disabled",
    )
    .await
    .unwrap();
    after_content_saved_in_tx(&mut tx, &ctx, std::slice::from_ref(&disabled))
        .await
        .unwrap();
    let disabled_ref = reference(id, "active", "3");
    for (sid, structure_only) in [
        (None, false),
        (Some("current-statement"), false),
        (None, true),
    ] {
        assert_eq!(
            knowledge::read_entry_page_in_tx(
                &mut tx,
                &ctx,
                &disabled_ref,
                sid,
                structure_only,
                0,
                8
            )
            .await
            .unwrap_err()
            .code,
            "not_available"
        );
    }
    tx.commit().await.unwrap();
    pool.close().await;
}

#[tokio::test]
async fn bounded_support_directories_keep_the_total_and_first_undelivered_position() {
    let pool = harness_pool().await;
    let ctx = context("synthetic-support-directory-bound");
    let id = "page-support-directory-bound";
    let supports = (0..51)
        .map(|index| {
            json!({
                "support_id":format!("support-{index:02}"),"role":"prerequisite",
                "reference":{"kind":"knowledge","ref":{"object_id":"page-directory-prerequisite",
                    "version":"1","path":"body"}},
                "content":"不属于目录的长支持正文。".repeat(600),"embedded_in":null
            })
        })
        .collect::<Vec<_>>();
    seed(&pool, &ctx, json!([
        object("page-directory-prerequisite", "term", json!([
            {"entry_id":"body","path":"body","source_facts":{},"suggestion":{},
                "human_override":{"value":"合成前提"},"effective_value":"合成前提"}
        ])),
        object(id, "table", json!([
            {"entry_id":"rule","path":"rule","source_facts":{},"suggestion":{},
                "human_override":{"value":"只读指定内容","structured_value":{"kind":"table",
                    "grain":"一行一条合成读数","unique_keys":[],"time_columns":[],"default_filters":[],"constraints":[]},
                    "statements":[statement("directory-statement", "只读指定内容", "", json!(supports))]},
                "effective_value":"只读指定内容"}
        ]))
    ])).await;
    pool.close().await;

    let pool = harness_pool().await;
    let before = bytes_sent(&pool).await;
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let reference = reference(id, "rule", "1");
    for (sid, structure_only) in [
        (None, false),
        (Some("directory-statement"), false),
        (None, true),
    ] {
        let page =
            knowledge::read_entry_page_in_tx(&mut tx, &ctx, &reference, sid, structure_only, 0, 1)
                .await
                .unwrap();
        let directory = page["supports"].as_array().unwrap();
        assert_eq!(
            directory.len(),
            50,
            "内部目录保留本页上限，不能把全部大支持下行"
        );
        assert_eq!(page["supports_total"], 51);
        assert_eq!(
            page["supports_next_offset"], 50,
            "目录被截下的第51项必须有明确未交位置"
        );
        assert_eq!(directory[0]["support_id"], "support-00");
        assert_eq!(directory[49]["support_id"], "support-49");
        assert!(directory.iter().all(|item| item.get("content").is_none()));
        assert_eq!(
            page["supports_complete"],
            if sid.is_some() {
                json!(true)
            } else {
                Value::Null
            }
        );
    }
    tx.commit().await.unwrap();
    let transferred = bytes_sent(&pool).await - before;
    assert!(
        transferred < 65_536,
        "三个有界目录不得搬回51项大支持内容，实际 {transferred}B"
    );
    println!("bounded support directories transferred {transferred}B");
    pool.close().await;
}

#[tokio::test]
async fn selected_support_content_keeps_bounded_pages_and_the_original_embedded_coordinates() {
    let pool = harness_pool().await;
    let ctx = context("synthetic-support-content-page");
    let id = "page-selected-support-content";
    let mut rule = statement(
        "content-statement",
        "合成定义。",
        "仅合成🧪演练。",
        json!([
            {"support_id":"selected-exception","role":"exception",
                "reference":{"kind":"knowledge","ref":{"object_id":"page-content-prerequisite","version":"1","path":"body"}},
                "content":"合成🧪","embedded_in":{"field":"scope_text","locator":{"offset":1,"length":3}}},
            {"support_id":"huge-prerequisite","role":"prerequisite",
                "reference":{"kind":"knowledge","ref":{"object_id":"page-content-prerequisite","version":"1","path":"body"}},
                "content":"不能整读的支持正文。".repeat(20000),"embedded_in":null}
        ]),
    );
    rule["supports_complete"] = json!(true);
    seed(
        &pool,
        &ctx,
        json!([
            object(
                "page-content-prerequisite",
                "term",
                json!([
                    {"entry_id":"body","path":"body","source_facts":{},"suggestion":{},
                        "human_override":{"value":"合成支持原文"},"effective_value":"合成支持原文"}
                ])
            ),
            object(
                id,
                "term",
                json!([
                    {"entry_id":"body","path":"body","source_facts":{},"suggestion":{},
                        "human_override":{"value":"合成定义。\n仅合成🧪演练。","statements":[rule]},
                        "effective_value":"合成定义。\n仅合成🧪演练。"}
                ])
            )
        ]),
    )
    .await;
    pool.close().await;
    let pool = harness_pool().await;
    let before = bytes_sent(&pool).await;
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let page = knowledge::read_supports_in_tx(
        &mut tx,
        &ctx,
        &reference(id, "body", "1"),
        Some("content-statement"),
        0,
        50,
    )
    .await
    .unwrap();
    assert_eq!(page["total"], 2);
    assert_eq!(page["supports"][0]["content"], "合成🧪");
    assert_eq!(page["supports"][0]["embedded_offset"], 7);
    assert_eq!(
        page["supports"][1]["content"],
        Value::Null,
        "超长支持不整读或截半句冒充完整"
    );
    assert_eq!(page["next_offset"], Value::Null);
    let content = knowledge::read_support_content_in_tx(
        &mut tx,
        &ctx,
        &reference(id, "body", "1"),
        ("content-statement", "huge-prerequisite"),
        7,
        5,
    )
    .await
    .unwrap();
    assert_eq!(
        content["content"], "正文。不能",
        "只读原保存支持的指定窗口，不能用短引用替换"
    );
    assert_eq!(
        content["content_page"],
        json!({"offset":7,"total_chars":200000,"complete":false,"next_offset":12})
    );
    tx.commit().await.unwrap();
    let transferred = bytes_sent(&pool).await - before;
    assert!(
        transferred < 16384,
        "所选短支持不得搬回未选大正文，实际{transferred}B"
    );
    pool.close().await;
}

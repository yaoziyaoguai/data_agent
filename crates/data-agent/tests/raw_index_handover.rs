use data_agent::{
    contracts::generated::{SourceKey, SourceKeyKind},
    modules::{
        jobs, knowledge,
        retrieval::{
            embedding::{self, SPEC},
            source_segments::{SourceFormat, SourceText, segment_source},
        },
    },
    persistence::{AppTx, connect},
    types::AccessContext,
    use_cases::{Binding, embed, raw_index_handover},
};
use serde_json::{Value, json};
use sqlx::Row;

fn test_url() -> Option<String> {
    std::env::var("DATA_AGENT_DATABASE_URL")
        .ok()
        .filter(|url| url.contains("/data_agent_test_"))
}

const SPACE: &str = "demo";
const RESOURCES: [&str; 4] = [
    "handover-plat",
    "document-handover-doc",
    "handover-live",
    "handover-failed",
];

async fn seed(pool: &sqlx::MySqlPool, resource: &str, version: u64) -> String {
    // 旧作业夹具同时提供真实owner；队列里的字符串不能授予来源或空间身份。
    if let Some(object) = resource.strip_prefix("document-") {
        let body = json!({"id":object,"kind":"document","state":"enabled","version":version.to_string(),
            "source_id":null,"entries":[{"entry_id":"body","path":"body","effective_value":"合成旧作业原文"}]});
        sqlx::query("INSERT IGNORE INTO knowledge_objects(id,space_id,kind,name,version,state,body,source_version,updated_by) VALUES(?,'demo','document','合成移交来源',?,'enabled',?,0,'handover-test')")
            .bind(object).bind(version).bind(sqlx::types::Json(body)).execute(pool).await.unwrap();
    } else {
        sqlx::query("INSERT INTO source_heads(id,space_id,version,fingerprint) VALUES(?,'demo',?,'synthetic-handover') ON DUPLICATE KEY UPDATE version=VALUES(version)")
            .bind(resource).bind(version).execute(pool).await.unwrap();
        sqlx::query("INSERT IGNORE INTO source_revisions(source_id,version,body) VALUES(?,?,'合成旧作业原文')")
            .bind(resource).bind(version).execute(pool).await.unwrap();
    }
    let mut tx = AppTx::begin(pool).await.unwrap();
    jobs::enqueue_source_in_tx(&mut tx, "raw_source_index", resource, version)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    sqlx::query_scalar::<_, String>(
        "SELECT id FROM background_jobs WHERE kind='raw_source_index' AND resource_id=?",
    )
    .bind(resource)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn todo(pool: &sqlx::MySqlPool, resource: &str) -> Option<(String, u64, u32, String)> {
    let id = resource.strip_prefix("document-").unwrap_or(resource);
    sqlx::query(
        "SELECT source_kind,version,vector_attempts,origin_job_id FROM knowledge_index_jobs \
         WHERE target_kind='source_excerpt' AND space_id=? AND object_id=?",
    )
    .bind(SPACE)
    .bind(id)
    .fetch_optional(pool)
    .await
    .unwrap()
    .map(|row| {
        (
            row.get("source_kind"),
            row.get::<u64, _>("version"),
            row.get::<u32, _>("vector_attempts"),
            row.get::<Option<String>, _>("origin_job_id")
                .unwrap_or_default(),
        )
    })
}

async fn legacy_state(pool: &sqlx::MySqlPool, resource: &str) -> (String, u32) {
    let row = sqlx::query(
        "SELECT state,attempts FROM background_jobs WHERE kind='raw_source_index' AND resource_id=?",
    )
    .bind(resource)
    .fetch_one(pool)
    .await
    .unwrap();
    (row.get("state"), row.get("attempts"))
}

// 旧raw积压的有界移交：事务中断不留下两份可领取记录；提交后旧项收敛、新待办
// 经owner公开入口建立并可领取；有效租约内的旧作业不抢身份；失败终态保留历史；
// 重复移交幂等。
#[tokio::test]
async fn handover_is_atomic_idempotent_and_respects_live_leases() {
    let Some(url) = test_url() else {
        return;
    };
    let pool = connect(&url).await.unwrap();
    for resource in RESOURCES {
        sqlx::query(
            "DELETE FROM knowledge_index_jobs WHERE target_kind='source_excerpt' AND object_id=?",
        )
        .bind(resource.strip_prefix("document-").unwrap_or(resource))
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("DELETE FROM background_jobs WHERE kind='raw_source_index' AND resource_id=?")
            .bind(resource)
            .execute(&pool)
            .await
            .unwrap();
    }
    let plat = seed(&pool, "handover-plat", 3).await;
    sqlx::query("UPDATE background_jobs SET attempts=2 WHERE id=?")
        .bind(&plat)
        .execute(&pool)
        .await
        .unwrap();
    let doc = seed(&pool, "document-handover-doc", 1).await;
    let live = seed(&pool, "handover-live", 5).await;
    sqlx::query(
        "UPDATE background_jobs SET state='running',attempts=1,lease_owner='legacy-worker',\
         lease_until=TIMESTAMPADD(SECOND,60,UTC_TIMESTAMP(3)) WHERE id=?",
    )
    .bind(&live)
    .execute(&pool)
    .await
    .unwrap();
    let failed = seed(&pool, "handover-failed", 2).await;
    sqlx::query("UPDATE background_jobs SET state='failed' WHERE id=?")
        .bind(&failed)
        .execute(&pool)
        .await
        .unwrap();

    // 事务中断：回滚后既无新待办，旧项也未被收敛——不出现两份可领取记录。
    {
        let mut tx = AppTx::begin(&pool).await.unwrap();
        let moved = raw_index_handover::hand_over_in_tx(&mut tx, SPACE)
            .await
            .unwrap();
        assert_eq!(moved, 2);
        drop(tx); // 回滚即中断
    }
    assert!(todo(&pool, "handover-plat").await.is_none());
    assert_eq!(
        legacy_state(&pool, "handover-plat").await,
        ("queued".into(), 2)
    );
    assert_eq!(
        legacy_state(&pool, "handover-live").await,
        ("running".into(), 1)
    );

    // 提交路径：两个可移交项接回原作业身份；有效租约与失败终态原样保留。
    {
        let mut tx = AppTx::begin(&pool).await.unwrap();
        let moved = raw_index_handover::hand_over_in_tx(&mut tx, SPACE)
            .await
            .unwrap();
        assert_eq!(moved, 2);
        tx.commit().await.unwrap();
    }
    assert_eq!(
        todo(&pool, "handover-plat").await.unwrap(),
        ("platform".into(), 3, 2, plat.clone())
    );
    assert_eq!(
        todo(&pool, "document-handover-doc").await.unwrap(),
        ("document".into(), 1, 0, doc.clone())
    );
    assert!(todo(&pool, "handover-live").await.is_none());
    assert!(todo(&pool, "handover-failed").await.is_none());
    assert_eq!(
        legacy_state(&pool, "handover-plat").await,
        ("finished".into(), 2),
        "旧项收敛为终态，尝试计数保留在历史行"
    );
    assert_eq!(
        legacy_state(&pool, "handover-live").await,
        ("running".into(), 1),
        "有效租约不抢身份"
    );
    assert_eq!(legacy_state(&pool, "handover-failed").await.0, "failed");

    // 重复移交：已收敛项不再出现，同一目标登记幂等。
    {
        let mut tx = AppTx::begin(&pool).await.unwrap();
        let moved = raw_index_handover::hand_over_in_tx(&mut tx, SPACE)
            .await
            .unwrap();
        assert_eq!(moved, 0);
        tx.commit().await.unwrap();
    }
    assert_eq!(
        todo(&pool, "handover-plat").await.unwrap(),
        ("platform".into(), 3, 2, plat.clone())
    );

    // 移交后的新待办可被统一消费者领取：领取即绑定实际集合并进入sending。
    let claimed = {
        let mut tx = AppTx::begin(&pool).await.unwrap();
        let claimed = knowledge::claim_source_index_in_tx(
            &mut tx,
            SPACE,
            true,
            Some("data_agent_test_handover"),
            None,
        )
        .await
        .unwrap()
        .expect("移交后的待办必须可领取");
        tx.commit().await.unwrap();
        claimed
    };
    assert_eq!(claimed["source_kind"], "document");
    assert_eq!(claimed["object_id"], "handover-doc");
    assert_eq!(claimed["job_version"], "1");
    let row = sqlx::query(
        "SELECT vector_state,vector_attempts,vector_target FROM knowledge_index_jobs \
         WHERE target_kind='source_excerpt' AND source_kind='document' AND object_id='handover-doc'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row.get::<String, _>("vector_state"), "sending");
    assert_eq!(row.get::<u32, _>("vector_attempts"), 1);
    assert_eq!(
        row.get::<String, _>("vector_target"),
        "data_agent_test_handover"
    );
    // 另一移交目标不受本次领取影响。
    let other = sqlx::query(
        "SELECT vector_state,vector_attempts FROM knowledge_index_jobs \
         WHERE target_kind='source_excerpt' AND source_kind='platform' AND object_id='handover-plat'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(other.get::<String, _>("vector_state"), "pending");
    assert_eq!(other.get::<u32, _>("vector_attempts"), 2);
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let plat_claim = knowledge::claim_source_index_in_tx(
        &mut tx,
        SPACE,
        true,
        Some("data_agent_test_handover"),
        None,
    )
    .await
    .unwrap()
    .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(plat_claim["object_id"], "handover-plat");
    assert_eq!(
        todo(&pool, "handover-plat").await.unwrap().2,
        3,
        "首次绑定集合不抹掉旧失败次数，只剩一次尝试"
    );

    for resource in RESOURCES {
        sqlx::query(
            "DELETE FROM knowledge_index_jobs WHERE target_kind='source_excerpt' AND object_id=?",
        )
        .bind(resource.strip_prefix("document-").unwrap_or(resource))
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("DELETE FROM background_jobs WHERE kind='raw_source_index' AND resource_id=?")
            .bind(resource)
            .execute(&pool)
            .await
            .unwrap();
    }
    pool.close().await;
}

#[tokio::test]
async fn exhausted_handover_reaches_terminal_state_without_another_claim() {
    let Some(url) = test_url() else {
        return;
    };
    let pool = connect(&url).await.unwrap();
    let resource = "handover-exhausted";
    let old = seed(&pool, resource, 1).await;
    sqlx::query(
        "UPDATE background_jobs SET state='running',attempts=3,\
         lease_until=TIMESTAMPADD(SECOND,-1,UTC_TIMESTAMP(3)) WHERE id=?",
    )
    .bind(&old)
    .execute(&pool)
    .await
    .unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    raw_index_handover::hand_over_in_tx(&mut tx, SPACE)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(todo(&pool, resource).await.unwrap().2, 3);

    let mut tx = AppTx::begin(&pool).await.unwrap();
    let claimed = knowledge::claim_source_index_in_tx(
        &mut tx,
        SPACE,
        true,
        Some("data_agent_test_handover"),
        None,
    )
    .await
    .unwrap();
    assert!(
        claimed
            .as_ref()
            .is_none_or(|job| job["object_id"] != resource)
    );
    tx.commit().await.unwrap();
    let row = sqlx::query(
        "SELECT vector_state,vector_attempts,vector_error FROM knowledge_index_jobs \
         WHERE target_kind='source_excerpt' AND source_kind='platform' AND object_id=?",
    )
    .bind(resource)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row.get::<String, _>("vector_state"), "failed");
    assert_eq!(row.get::<u32, _>("vector_attempts"), 3);
    assert_eq!(
        row.get::<String, _>("vector_error"),
        "vector_receipt_unknown"
    );
    sqlx::query(
        "DELETE FROM knowledge_index_jobs WHERE target_kind='source_excerpt' AND object_id=?",
    )
    .bind(resource)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("DELETE FROM background_jobs WHERE id=?")
        .bind(old)
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
}

#[tokio::test]
async fn handover_only_moves_sources_owned_by_the_requested_space() {
    let Some(url) = test_url() else { return };
    let pool = connect(&url).await.unwrap();
    let local = format!("handover-local-{}", data_agent::types::id());
    let foreign = format!("handover-foreign-{}", data_agent::types::id());
    for (object, space) in [(&local, SPACE), (&foreign, "other-space")] {
        let value = json!({"id":object,"kind":"document","state":"enabled","version":"1",
            "source_id":null,"entries":[{"entry_id":"body","path":"body","effective_value":"合成空间隔离原文"}]});
        sqlx::query("INSERT INTO knowledge_objects(id,space_id,kind,name,version,state,body,source_version,updated_by) VALUES(?,?,'document','合成空间隔离文档',1,'enabled',?,0,'handover-test')")
            .bind(object).bind(space).bind(sqlx::types::Json(value)).execute(&pool).await.unwrap();
        seed(&pool, &format!("document-{object}"), 1).await;
    }
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let moved = raw_index_handover::hand_over_in_tx(&mut tx, SPACE)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(moved, 1, "只移交请求空间owner证明的来源");
    assert!(todo(&pool, &local).await.is_some());
    assert!(
        todo(&pool, &foreign).await.is_none(),
        "外空间作业不能登记到请求空间"
    );
    assert_eq!(
        legacy_state(&pool, &format!("document-{foreign}")).await.0,
        "queued"
    );
    for object in [&local, &foreign] {
        sqlx::query("DELETE FROM knowledge_index_jobs WHERE object_id=?")
            .bind(object)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM background_jobs WHERE kind='raw_source_index' AND resource_id=?")
            .bind(format!("document-{object}"))
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM knowledge_objects WHERE id=?")
            .bind(object)
            .execute(&pool)
            .await
            .unwrap();
    }
    pool.close().await;
}

#[tokio::test]
async fn rebuild_registers_current_sources_preserves_legacy_work_and_replays_once() {
    let Some(url) = test_url() else { return };
    let pool = connect(&url).await.unwrap();
    let ctx = AccessContext {
        user_id: "alice".into(),
        space_id: SPACE.into(),
        request_id: data_agent::types::id(),
        table_access: None,
    };
    let prefix = format!("rebuild-{}", data_agent::types::id());
    let mut documents = Vec::new();
    for index in 0..70 {
        let object = format!("{prefix}-{index}");
        let (space, state, source, text) = match index {
            0 => ("other-space", "enabled", None, "合成外空间原文"),
            1 => (SPACE, "disabled", None, "合成停用原文"),
            2 => (SPACE, "enabled", None, "   "),
            3 => (SPACE, "enabled", Some("schema"), "合成来源派生章节"),
            _ => (SPACE, "enabled", None, "合成待补登当前原文"),
        };
        let body = json!({"id":object,"kind":"document","state":state,"version":"1","source_id":source,
            "entries":[{"entry_id":"body","path":"body","effective_value":text}]});
        sqlx::query("INSERT INTO knowledge_objects(id,space_id,kind,name,version,state,body,source_id,source_version,updated_by) VALUES(?,?,'document','合成补登文档',1,?,?,?,0,'rebuild-test')")
            .bind(&object).bind(space).bind(state).bind(sqlx::types::Json(body)).bind(source).execute(&pool).await.unwrap();
        documents.push(object);
    }
    let inherited = seed(&pool, &format!("document-{}", documents[4]), 1).await;
    sqlx::query("UPDATE background_jobs SET attempts=2 WHERE id=?")
        .bind(&inherited)
        .execute(&pool)
        .await
        .unwrap();
    let live = seed(&pool, &format!("document-{}", documents[5]), 1).await;
    sqlx::query("UPDATE background_jobs SET state='running',attempts=1,lease_owner='old-worker',lease_until=TIMESTAMPADD(SECOND,120,UTC_TIMESTAMP(3)) WHERE id=?")
        .bind(&live).execute(&pool).await.unwrap();
    let failed = seed(&pool, &format!("document-{}", documents[6]), 1).await;
    sqlx::query("UPDATE background_jobs SET state='failed',attempts=3 WHERE id=?")
        .bind(&failed)
        .execute(&pool)
        .await
        .unwrap();
    let frozen = json!({"trial_id":"synthetic-original-frozen-budget","call_limit":23,"cost_limit_micros":"200000"});
    let mut tx = AppTx::begin(&pool).await.unwrap();
    knowledge::register_source_index_target_in_tx(
        &mut tx,
        SPACE,
        &SourceKey {
            kind: SourceKeyKind::Document,
            id: documents[4].clone(),
        },
        1,
        None,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    sqlx::query("UPDATE knowledge_index_jobs SET embedding_profile=? WHERE target_kind='source_excerpt' AND object_id=?")
        .bind(sqlx::types::Json(&frozen)).bind(&documents[4]).execute(&pool).await.unwrap();
    let prepare_before: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM background_jobs WHERE kind='prepare_source'")
            .fetch_one(&pool)
            .await
            .unwrap();
    let operation = json!({"operation_id":data_agent::types::id()});
    let (left, right) = tokio::join!(
        data_agent::use_cases::knowledge::rebuild_index(&pool, &ctx, &operation),
        data_agent::use_cases::knowledge::rebuild_index(&pool, &ctx, &operation),
    );
    let receipt = left.unwrap();
    assert_eq!(right.unwrap(), receipt, "并发同操作接回原回执");
    for (index, object) in documents.iter().enumerate() {
        let current = todo(&pool, object).await;
        if index < 4 || index == 5 {
            assert!(
                current.is_none(),
                "外空间、停用、空正文、派生章节和有效旧租约不旁路补登：{index}"
            );
        } else {
            assert!(current.is_some(), "超过单批64项的当前来源均补登：{index}");
        }
    }
    assert_eq!(
        todo(&pool, &documents[4]).await.unwrap(),
        ("document".into(), 1, 2, inherited.clone())
    );
    let preserved:sqlx::types::Json<Value> = sqlx::query_scalar("SELECT embedding_profile FROM knowledge_index_jobs WHERE target_kind='source_excerpt' AND object_id=?")
        .bind(&documents[4]).fetch_one(&pool).await.unwrap();
    assert_eq!(preserved.0, frozen, "移交和重建不重绑冻结额度");
    assert_eq!(
        legacy_state(&pool, &format!("document-{}", documents[5])).await,
        ("running".into(), 1)
    );
    assert_eq!(
        legacy_state(&pool, &format!("document-{}", documents[6])).await,
        ("failed".into(), 3)
    );
    assert_eq!(
        legacy_state(&pool, &format!("document-{}", documents[4])).await,
        ("finished".into(), 2)
    );
    let before:Vec<(String,u64,u32,String)> = sqlx::query_as("SELECT object_id,lease_epoch,vector_attempts,vector_target FROM knowledge_index_jobs WHERE target_kind='source_excerpt' AND object_id LIKE ? ORDER BY object_id")
        .bind(format!("{prefix}%")).fetch_all(&pool).await.unwrap();
    assert_eq!(
        data_agent::use_cases::knowledge::rebuild_index(&pool, &ctx, &operation)
            .await
            .unwrap(),
        receipt
    );
    let after:Vec<(String,u64,u32,String)> = sqlx::query_as("SELECT object_id,lease_epoch,vector_attempts,vector_target FROM knowledge_index_jobs WHERE target_kind='source_excerpt' AND object_id LIKE ? ORDER BY object_id")
        .bind(format!("{prefix}%")).fetch_all(&pool).await.unwrap();
    assert_eq!(after, before, "重复维护不重置代次或次数");
    let prepare_after: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM background_jobs WHERE kind='prepare_source'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(prepare_after, prepare_before, "纯索引重建不排语义准备");
    for object in &documents {
        sqlx::query("DELETE FROM knowledge_index_jobs WHERE object_id=?")
            .bind(object)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM background_jobs WHERE kind='raw_source_index' AND resource_id=?")
            .bind(format!("document-{object}"))
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM knowledge_objects WHERE id=?")
            .bind(object)
            .execute(&pool)
            .await
            .unwrap();
    }
    pool.close().await;
}

#[tokio::test]
async fn rebuild_live_legacy_lease_resumes_after_expiry_in_production_index_loop() {
    let Some(url) = test_url() else { return };
    let pool = connect(&url).await.unwrap();
    let api = std::env::var("DATA_AGENT_API_URL").unwrap();
    let identities: Value =
        serde_json::from_str(&std::env::var("DATA_AGENT_DEV_IDENTITIES").unwrap()).unwrap();
    let token = identities
        .as_object()
        .unwrap()
        .iter()
        .find(|(_, user)| *user == "alice")
        .unwrap()
        .0;
    let client = reqwest::Client::new();
    let operation = json!({"operation_id": data_agent::types::id()});
    let object = format!("expiry-{}", data_agent::types::id());
    let resource = format!("document-{object}");
    let body = (0..400)
        .map(|i| format!("第{i}行合成租约接续资料：到期后必须沿原索引作业完成原文投影。\n"))
        .collect::<String>();
    let old = seed(&pool, &resource, 1).await;
    let document = json!({"id":object,"kind":"document","state":"enabled","version":"1","source_id":null,
        "entries":[{"entry_id":"body","path":"body","effective_value":body}]});
    sqlx::query("UPDATE knowledge_objects SET body=? WHERE id=?")
        .bind(sqlx::types::Json(document))
        .bind(&object)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE background_jobs SET state='running',attempts=2,lease_owner='stopped-old-writer',lease_until=TIMESTAMPADD(SECOND,120,UTC_TIMESTAMP(3)) WHERE id=?")
        .bind(&old).execute(&pool).await.unwrap();

    let key = SourceKey {
        kind: SourceKeyKind::Document,
        id: object.clone(),
    };
    let source = SourceText {
        source: &key,
        revision: "1",
        text: &body,
        format: SourceFormat::Markdown,
        background: &[],
    };
    let mut pieces = Vec::new();
    let mut cursor = None;
    loop {
        let batch = segment_source(&source, cursor.as_ref()).unwrap();
        pieces.extend(
            batch
                .segments
                .into_iter()
                .map(|segment| json!({"text":segment.text})),
        );
        match batch.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    let batches = embedding::batches(&pieces).unwrap();
    assert!(
        batches.len() > 1,
        "回放旧批后仍有未发送批，才能验证冻结配置"
    );
    let first: Vec<String> = batches[0]
        .iter()
        .map(|piece| piece["text"].as_str().unwrap().to_owned())
        .collect();
    let request = embedding::prepare(&first).unwrap();
    let embedding_operation = data_agent::types::fingerprint(&json!([
        "raw-source-index",
        SPACE,
        resource,
        1u64,
        SPEC.version,
        data_agent::types::fingerprint(&json!(&first))
    ]));
    let attempt = data_agent::types::fingerprint(&json!([
        "shared-embedding",
        embedding_operation,
        request.fingerprint
    ]));
    let original_trial = format!("expiry-legacy-{}", data_agent::types::id());
    let vectors: Vec<Vec<f32>> = first
        .iter()
        .map(|_| {
            let mut vector = vec![0.0; SPEC.dimension];
            vector[0] = 1.0;
            vector
        })
        .collect();
    sqlx::query("INSERT INTO model_call_attempts(id,budget_scope_id,run_id,state,parameters_fingerprint,input_tokens_upper,output_tokens_max,reserved_micros,purpose,trial_id,operation_id,price_version,actual_micros,usage_json,response_json) VALUES(?,NULL,NULL,'settled',?,?,0,64,'knowledge_embedding',?,?,'2026-10-05-qwen-cny-usd-ceiling',0,?,?)")
        .bind(&attempt).bind(&request.fingerprint).bind(request.input_upper as u32).bind(&original_trial).bind(&embedding_operation)
        .bind(sqlx::types::Json(json!({"input_tokens":8,"output_tokens":0,"elapsed_ms":1})))
        .bind(sqlx::types::Json(vectors)).execute(&pool).await.unwrap();
    let ledger_before: sqlx::types::Json<Value> = sqlx::query_scalar("SELECT JSON_OBJECT('id',id,'state',state,'trial',trial_id,'operation',operation_id,'parameters',parameters_fingerprint,'reserved',reserved_micros,'actual',actual_micros,'usage',usage_json,'response',response_json) FROM model_call_attempts WHERE id=?")
        .bind(&attempt).fetch_one(&pool).await.unwrap();
    let frozen: Value =
        serde_json::from_str(&std::env::var("DATA_AGENT_EMBEDDING_PROFILE").unwrap()).unwrap();
    let before_calls: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM model_call_attempts WHERE purpose='knowledge_embedding'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    let response = client
        .post(format!("{api}/knowledge-index/rebuilds"))
        .bearer_auth(token)
        .json(&operation)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let receipt: Value = response.json().await.unwrap();
    assert!(
        todo(&pool, &resource).await.is_none(),
        "重建时有效旧租约不能旁路补登"
    );
    // 只用生产入口推进；旧writer已经停止，不再续租。
    for _ in 0..256 {
        if !data_agent::use_cases::knowledge::process_index(&pool)
            .await
            .unwrap()
        {
            break;
        }
    }
    assert!(
        todo(&pool, &resource).await.is_none(),
        "生产循环也不能抢有效旧租约"
    );
    assert_eq!(legacy_state(&pool, &resource).await, ("running".into(), 2));
    let before_expiry_calls: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM model_call_attempts WHERE purpose='knowledge_embedding'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(before_expiry_calls >= before_calls);
    // 夹具仅推进已知停止writer的租约时刻，不制造新队列或改作业状态。
    let changed = sqlx::query("UPDATE background_jobs SET lease_until=TIMESTAMPADD(SECOND,-1,UTC_TIMESTAMP(3)) WHERE id=? AND state='running' AND lease_owner='stopped-old-writer'")
        .bind(&old).execute(&pool).await.unwrap();
    assert_eq!(changed.rows_affected(), 1);
    let replay = client
        .post(format!("{api}/knowledge-index/rebuilds"))
        .bearer_auth(token)
        .json(&operation)
        .send()
        .await
        .unwrap();
    assert_eq!(replay.status(), reqwest::StatusCode::OK);
    assert_eq!(
        replay.json::<Value>().await.unwrap(),
        receipt,
        "同operation只接回原回执"
    );
    assert!(
        todo(&pool, &resource).await.is_none(),
        "回执重放不能代替生产接续"
    );
    for _ in 0..256 {
        if !data_agent::use_cases::knowledge::process_index(&pool)
            .await
            .unwrap()
        {
            break;
        }
    }
    let resumed = todo(&pool, &resource)
        .await
        .expect("旧租约到期后，生产process_index必须自动接回原raw作业");
    assert_eq!(
        resumed,
        ("document".into(), 1, 3, old.clone()),
        "保原身份和2次尝试，仅消费时再加1"
    );
    assert_eq!(legacy_state(&pool, &resource).await, ("finished".into(), 2));
    let state: (String, sqlx::types::Json<Value>) = sqlx::query_as("SELECT vector_state,embedding_profile FROM knowledge_index_jobs WHERE target_kind='source_excerpt' AND source_kind='document' AND object_id=?")
        .bind(&object).fetch_one(&pool).await.unwrap();
    assert_eq!(state.0, "indexed", "真实切块、Embedding与Milvus写入完成");
    assert_eq!(state.1.0, frozen, "新批沿原配置冻结，不为到期恢复重绑额度");
    let projection: (u64, u64, bool) = sqlx::query_as("SELECT revision,applied_position,complete FROM retrieval_source_projections WHERE source_kind='document' AND source_id=?")
        .bind(&object).fetch_one(&pool).await.unwrap();
    assert_eq!(projection, (1, body.chars().count() as u64, true));
    let ledger_after: sqlx::types::Json<Value> = sqlx::query_scalar("SELECT JSON_OBJECT('id',id,'state',state,'trial',trial_id,'operation',operation_id,'parameters',parameters_fingerprint,'reserved',reserved_micros,'actual',actual_micros,'usage',usage_json,'response',response_json) FROM model_call_attempts WHERE id=?")
        .bind(&attempt).fetch_one(&pool).await.unwrap();
    assert_eq!(
        ledger_after.0, ledger_before.0,
        "旧成功批只回放，账本与原trial逐字段不变"
    );
    let prefix = format!("{object}%");
    let jobs_before: Vec<(String, u64, u32)> = sqlx::query_as("SELECT vector_state,lease_epoch,vector_attempts FROM knowledge_index_jobs WHERE object_id LIKE ? ORDER BY target_kind")
        .bind(&prefix).fetch_all(&pool).await.unwrap();
    let replay = client
        .post(format!("{api}/knowledge-index/rebuilds"))
        .bearer_auth(token)
        .json(&operation)
        .send()
        .await
        .unwrap();
    assert_eq!(replay.status(), reqwest::StatusCode::OK);
    assert_eq!(replay.json::<Value>().await.unwrap(), receipt);
    let jobs_after: Vec<(String, u64, u32)> = sqlx::query_as("SELECT vector_state,lease_epoch,vector_attempts FROM knowledge_index_jobs WHERE object_id LIKE ? ORDER BY target_kind")
        .bind(&prefix).fetch_all(&pool).await.unwrap();
    assert_eq!(jobs_after, jobs_before, "恢复完成后同回执不重排或清零");
    println!(
        "raw_handover_expiry_resumed origin_job_id={old} attempts=2->3 projection_complete=true"
    );
    pool.close().await;
}

#[tokio::test]
async fn production_handover_advances_past_unusable_due_prefix_without_changing_it() {
    let Some(url) = test_url() else { return };
    let pool = connect(&url).await.unwrap();
    // 先由生产消费者完成harness初始重建，让有限轮数只度量本例队列的推进。
    let mut drained = false;
    for _ in 0..256 {
        if !data_agent::use_cases::knowledge::process_index(&pool)
            .await
            .unwrap()
        {
            drained = true;
            break;
        }
    }
    assert!(drained, "初始公开索引待办必须先完成");
    let suffix = data_agent::types::id();
    let mut resources = Vec::new();
    // 两页不可移交前缀覆盖queued空租约与running到期租约两种发现游标。
    for index in 0..128 {
        let object = format!("skip-{index:02}-{suffix}");
        let platform = index % 8 >= 6;
        let resource = if platform {
            object.clone()
        } else {
            format!("document-{object}")
        };
        let old = seed(&pool, &resource, 1).await;
        sqlx::query("UPDATE background_jobs SET id=?,state='running',attempts=1,lease_owner='stopped-prefix',lease_until='2000-01-01 00:00:00.000' WHERE id=?")
            .bind(format!("0000-{index:02}-{suffix}")).bind(old).execute(&pool).await.unwrap();
        if index < 64 {
            sqlx::query("UPDATE background_jobs SET state='queued',lease_until=NULL WHERE id=?")
                .bind(format!("0000-{index:02}-{suffix}"))
                .execute(&pool)
                .await
                .unwrap();
        }
        match index % 8 {
            0 => {
                sqlx::query("UPDATE knowledge_objects SET space_id='other-space' WHERE id=?")
                    .bind(&object)
                    .execute(&pool)
                    .await
                    .unwrap();
            }
            1 => {
                sqlx::query("UPDATE knowledge_objects SET state='disabled' WHERE id=?")
                    .bind(&object)
                    .execute(&pool)
                    .await
                    .unwrap();
            }
            2 => {
                sqlx::query("UPDATE knowledge_objects SET version=2,body=JSON_SET(body,'$.version','2') WHERE id=?").bind(&object).execute(&pool).await.unwrap();
            }
            3 => {
                sqlx::query("UPDATE knowledge_objects SET source_id='schema' WHERE id=?")
                    .bind(&object)
                    .execute(&pool)
                    .await
                    .unwrap();
            }
            4 => {
                sqlx::query("UPDATE knowledge_objects SET body=JSON_SET(body,'$.entries[0].effective_value','   ') WHERE id=?").bind(&object).execute(&pool).await.unwrap();
            }
            5 => {
                sqlx::query("DELETE FROM knowledge_objects WHERE id=?")
                    .bind(&object)
                    .execute(&pool)
                    .await
                    .unwrap();
            }
            6 => {
                sqlx::query("UPDATE source_revisions SET archive_complete=FALSE WHERE source_id=?")
                    .bind(&object)
                    .execute(&pool)
                    .await
                    .unwrap();
            }
            7 => {
                sqlx::query("INSERT INTO catalog_platform_heads(source_id,platform_version,namespace,platform_table_id,retired) VALUES(?,1,'synthetic-expiry',?,TRUE)").bind(&object).bind(&object).execute(&pool).await.unwrap();
            }
            _ => unreachable!(),
        }
        resources.push(resource);
    }
    let prefix_before: Vec<(String, String, u32, u64, Option<String>)> = sqlx::query_as(
        "SELECT id,state,attempts,lease_epoch,CAST(lease_until AS CHAR) FROM background_jobs WHERE lease_owner='stopped-prefix' ORDER BY id",
    ).fetch_all(&pool).await.unwrap();
    assert_eq!(prefix_before.len(), 128);
    let object = format!("valid-{suffix}");
    let resource = format!("document-{object}");
    let old = seed(&pool, &resource, 1).await;
    let origin = format!("zzzz-valid-{suffix}");
    sqlx::query("UPDATE background_jobs SET id=?,state='running',attempts=2,lease_owner='stopped-valid',lease_until='2000-01-01 00:00:00.000' WHERE id=?")
        .bind(&origin).bind(old).execute(&pool).await.unwrap();
    for _ in 0..16 {
        data_agent::use_cases::knowledge::process_index(&pool)
            .await
            .unwrap();
        if todo(&pool, &resource).await.is_some_and(|job| job.2 == 3) {
            break;
        }
    }
    let resumed = todo(&pool, &resource)
        .await
        .expect("跳过两页外空间/失效/旧修订后，生产接续必须最终发现有效项");
    assert_eq!(resumed, ("document".into(), 1, 3, origin));
    assert_eq!(legacy_state(&pool, &resource).await, ("finished".into(), 2));
    let late_object = format!("late-{suffix}");
    let late_resource = format!("document-{late_object}");
    let late_origin = seed(&pool, &late_resource, 1).await;
    // 新due项位于刚扫过的页之前；页尾必须回绕，游标不能成为已处理事实。
    for _ in 0..16 {
        data_agent::use_cases::knowledge::process_index(&pool)
            .await
            .unwrap();
        if todo(&pool, &late_resource)
            .await
            .is_some_and(|job| job.2 == 1)
        {
            break;
        }
    }
    assert_eq!(
        todo(&pool, &late_resource)
            .await
            .expect("页尾回绕后必须发现新due项"),
        ("document".into(), 1, 1, late_origin)
    );
    let prefix_after: Vec<(String, String, u32, u64, Option<String>)> = sqlx::query_as(
        "SELECT id,state,attempts,lease_epoch,CAST(lease_until AS CHAR) FROM background_jobs WHERE lease_owner='stopped-prefix' ORDER BY id",
    ).fetch_all(&pool).await.unwrap();
    assert_eq!(prefix_after, prefix_before, "跳过项不结算、不改租约或次数");
    for skipped in &resources {
        assert!(
            todo(&pool, skipped).await.is_none(),
            "不可索引前缀不能登记到demo：{skipped}"
        );
    }
    resources.push(resource);
    resources.push(late_resource);
    for resource in resources {
        let object = resource.strip_prefix("document-").unwrap_or(&resource);
        sqlx::query(
            "DELETE FROM knowledge_index_jobs WHERE target_kind='source_excerpt' AND object_id=?",
        )
        .bind(object)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("DELETE FROM background_jobs WHERE kind='raw_source_index' AND resource_id=?")
            .bind(&resource)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM knowledge_objects WHERE id=?")
            .bind(object)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM catalog_platform_heads WHERE source_id=?")
            .bind(object)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE source_revisions SET body=NULL WHERE source_id=?")
            .bind(object)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM source_heads WHERE id=?")
            .bind(object)
            .execute(&pool)
            .await
            .unwrap();
    }
    println!(
        "raw_handover_prefix_advanced skipped=128 null_and_expired_pages=true wraparound=true attempts_unchanged=true valid_attempts=2->3"
    );
    pool.close().await;
}

// 本地嵌入协议替身：记录每次外发的文本批，按固定规格返回可规范化向量。
// 不依赖真实外部调用即可验证账本身份与发送事实。线程随进程退出。
struct EmbeddingStub {
    port: u16,
    sent: std::sync::Arc<std::sync::Mutex<Vec<Vec<String>>>>,
}
impl EmbeddingStub {
    fn start() -> Self {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let sent = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let record = sent.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut buffer = Vec::new();
                let mut chunk = [0u8; 8192];
                // 头部与定长正文一次连接内读完即应答（客户端不流式上传）。
                loop {
                    match std::io::Read::read(&mut stream, &mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            buffer.extend_from_slice(&chunk[..n]);
                            let head_end = buffer
                                .windows(4)
                                .position(|w| w == b"\r\n\r\n")
                                .map(|i| i + 4);
                            let Some(head_end) = head_end else { continue };
                            let head = String::from_utf8_lossy(&buffer[..head_end]).into_owned();
                            let length = head
                                .lines()
                                .find_map(|line| line.strip_prefix("content-length:"))
                                .and_then(|v| v.trim().parse::<usize>().ok())
                                .unwrap_or(0);
                            if buffer.len() >= head_end + length {
                                break;
                            }
                        }
                    }
                }
                let head_end = buffer
                    .windows(4)
                    .position(|w| w == b"\r\n\r\n")
                    .map(|i| i + 4)
                    .unwrap_or(buffer.len());
                let payload: Value =
                    serde_json::from_slice(&buffer[head_end..]).unwrap_or(Value::Null);
                if let Some(texts) = payload["input"].as_array() {
                    record.lock().unwrap().push(
                        texts
                            .iter()
                            .filter_map(|v| v.as_str().map(str::to_owned))
                            .collect(),
                    );
                }
                let data: Vec<Value> = (0..payload["input"].as_array().map(Vec::len).unwrap_or(0))
                    .map(|index| {
                        let mut vector = vec![0.0f64; SPEC.dimension];
                        vector[index % SPEC.dimension] = 1.0;
                        json!({"index": index, "embedding": vector})
                    })
                    .collect();
                let body = json!({"data": data, "usage": {"prompt_tokens": 16}});
                let body = serde_json::to_vec(&body).unwrap();
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    body.len()
                );
                let _ = std::io::Write::write_all(&mut stream, response.as_bytes());
                let _ = std::io::Write::write_all(&mut stream, &body);
            }
        });
        EmbeddingStub { port, sent }
    }
    fn sends(&self) -> Vec<Vec<String>> {
        self.sent.lock().unwrap().clone()
    }
}

// 移交后的账本接续（05接续D）：旧raw消费者在background_jobs未保存Embedding
// profile，新消费者按原operation/参数指纹与provider账本续用——已结算批次经共享
// 缓存回放不重发计费、未知批次保持原身份不换trial重发、未发送批次沿当前授权
// 发送；目标首次绑定冻结trial后，环境配置再变也不换trial补额。
#[tokio::test]
async fn handed_over_target_resumes_ledger_under_original_identities() {
    let Some(url) = test_url() else {
        return;
    };
    const RESOURCE: &str = "handover-ledger";
    const LEGACY_TRIAL: &str = "handover-ledger-legacy-trial";
    const FROZEN_TRIAL: &str = "handover-ledger-frozen-trial";
    const CHANGED_TRIAL: &str = "handover-ledger-changed-trial";
    let pool = connect(&url).await.unwrap();
    let profile =
        |trial: &str| json!({"trial_id":trial,"call_limit":10000,"cost_limit_micros":"1000000"});
    // 环境变量仅在进程内测试有效；其余用例不读取这些键。
    let restore: Vec<(String, String)> = [
        "DATA_AGENT_MODE",
        "DATA_AGENT_EMBEDDING_TEST",
        "DATA_AGENT_EMBEDDING_URL",
        "DATA_AGENT_EMBEDDING_PROFILE",
    ]
    .into_iter()
    .map(|key| (key.to_owned(), std::env::var(key).unwrap_or_default()))
    .collect();
    let stub = EmbeddingStub::start();
    unsafe {
        std::env::set_var("DATA_AGENT_MODE", "development");
        std::env::set_var("DATA_AGENT_EMBEDDING_TEST", "1");
        std::env::set_var(
            "DATA_AGENT_EMBEDDING_URL",
            format!("http://127.0.0.1:{}", stub.port),
        );
    }
    sqlx::query(
        "DELETE FROM knowledge_index_jobs WHERE target_kind='source_excerpt' AND object_id=?",
    )
    .bind(RESOURCE)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("DELETE FROM background_jobs WHERE kind='raw_source_index' AND resource_id=?")
        .bind(RESOURCE)
        .execute(&pool)
        .await
        .unwrap();
    for trial in [LEGACY_TRIAL, FROZEN_TRIAL, CHANGED_TRIAL] {
        sqlx::query("DELETE FROM model_call_attempts WHERE trial_id=?")
            .bind(trial)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM model_trials WHERE id=?")
            .bind(trial)
            .execute(&pool)
            .await
            .unwrap();
    }

    // 旧积压：2次失败尝试后移交，新待办由统一消费者领取。
    seed(&pool, RESOURCE, 7).await;
    sqlx::query(
        "UPDATE background_jobs SET attempts=2 WHERE kind='raw_source_index' AND resource_id=?",
    )
    .bind(RESOURCE)
    .execute(&pool)
    .await
    .unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    raw_index_handover::hand_over_in_tx(&mut tx, SPACE)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let job = knowledge::claim_source_index_in_tx(
        &mut tx,
        SPACE,
        true,
        Some("data_agent_test_ledger"),
        None,
    )
    .await
    .unwrap()
    .expect("移交后的原文待办必须可领取");
    tx.commit().await.unwrap();

    // 消费者真实批次文本：与index_source_target同一确定性切块与分批。
    let key = SourceKey {
        kind: SourceKeyKind::Platform,
        id: RESOURCE.to_owned(),
    };
    let mut body = String::new();
    for i in 0..3000 {
        body.push_str(&format!(
            "-- 迁移账本接续样本第{i}行：口径说明与依据记录。\n"
        ));
    }
    let source = SourceText {
        source: &key,
        revision: "7",
        text: &body,
        format: SourceFormat::Sql,
        background: &[],
    };
    let mut pieces: Vec<Value> = Vec::new();
    let mut cursor: Option<data_agent::modules::retrieval::source_segments::SegmentCursor> = None;
    loop {
        let batch = segment_source(&source, cursor.as_ref()).unwrap();
        for segment in &batch.segments {
            pieces.push(json!({"text": segment.text}));
        }
        // 与生产消费者同款终止条件：末批非空但cursor为None。
        match batch.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    let chunks = embedding::batches(&pieces).unwrap();
    assert!(chunks.len() >= 4, "夹具必须产生至少4个嵌入批");
    let texts_of = |index: usize| -> Vec<String> {
        chunks[index]
            .iter()
            .map(|piece| piece["text"].as_str().unwrap_or("").to_owned())
            .collect()
    };
    let identity = |index: usize| -> (String, String, String) {
        let texts = texts_of(index);
        let texts_fp = data_agent::types::fingerprint(&json!(&texts));
        let request = embedding::prepare(&texts).unwrap();
        let operation = data_agent::types::fingerprint(&json!([
            "raw-source-index",
            SPACE,
            RESOURCE,
            7u64,
            SPEC.version,
            texts_fp
        ]));
        let attempt = data_agent::types::fingerprint(&json!([
            "shared-embedding",
            operation,
            request.fingerprint
        ]));
        (attempt, operation, request.fingerprint)
    };

    // 预置旧链回执：批0已结算（含可回放向量），批1发出后回执未知。
    let (settled_id, settled_operation, settled_parameters) = identity(0);
    let settled_vectors: Vec<Value> = (0..texts_of(0).len())
        .map(|index| {
            let mut vector = vec![0.0f32; SPEC.dimension];
            vector[index % SPEC.dimension] = 1.0;
            json!(vector)
        })
        .collect();
    sqlx::query(
        "INSERT INTO model_call_attempts(id,budget_scope_id,run_id,state,parameters_fingerprint,\
         input_tokens_upper,output_tokens_max,reserved_micros,purpose,trial_id,operation_id,\
         price_version,actual_micros,usage_json,response_json) \
         VALUES(?,NULL,NULL,'settled',?,?,0,?, 'knowledge_embedding',?,?,?,0,?,?)",
    )
    .bind(&settled_id)
    .bind(&settled_parameters)
    .bind(embedding::prepare(&texts_of(0)).unwrap().input_upper as u32)
    .bind(64u64)
    .bind(LEGACY_TRIAL)
    .bind(&settled_operation)
    .bind("2026-10-05-qwen-cny-usd-ceiling")
    .bind(sqlx::types::Json(
        json!({"input_tokens":8,"output_tokens":0,"elapsed_ms":1}),
    ))
    .bind(sqlx::types::Json(json!(settled_vectors)))
    .execute(&pool)
    .await
    .unwrap();
    let (unknown_id, unknown_operation, unknown_parameters) = identity(1);
    sqlx::query(
        "INSERT INTO model_call_attempts(id,budget_scope_id,run_id,state,parameters_fingerprint,\
         input_tokens_upper,output_tokens_max,reserved_micros,purpose,trial_id,operation_id,price_version) \
         VALUES(?,NULL,NULL,'unknown',?,?,0,?,'knowledge_embedding',?,?,?)",
    )
    .bind(&unknown_id)
    .bind(&unknown_parameters)
    .bind(embedding::prepare(&texts_of(1)).unwrap().input_upper as u32)
    .bind(64u64)
    .bind(LEGACY_TRIAL)
    .bind(&unknown_operation)
    .bind("2026-10-05-qwen-cny-usd-ceiling")
    .execute(&pool)
    .await
    .unwrap();

    let ctx = AccessContext {
        user_id: "handover-ledger-check".into(),
        space_id: SPACE.into(),
        request_id: "handover-ledger".into(),
        table_access: None,
    };
    // 已发送批次只认原账本；当前配置缺失或不可解析都不能阻止接回旧回执，
    // 也不能提前把移交目标绑定到新trial。
    for current_profile in [
        None,
        Some("invalid-profile".to_owned()),
        Some(profile(FROZEN_TRIAL).to_string()),
    ] {
        unsafe {
            match current_profile {
                Some(value) => std::env::set_var("DATA_AGENT_EMBEDDING_PROFILE", value),
                None => std::env::remove_var("DATA_AGENT_EMBEDDING_PROFILE"),
            }
        }
        let replayed = embed(
            &pool,
            &ctx,
            Binding::RawIndex(
                &job,
                RESOURCE,
                7,
                data_agent::types::fingerprint(&json!(&texts_of(0))),
            ),
            texts_of(0),
            None,
        )
        .await
        .expect("当前配置不影响原成功回执接回");
        assert_eq!(replayed.len(), texts_of(0).len(), "已结算回执必须整批回放");
        let unknown = embed(
            &pool,
            &ctx,
            Binding::RawIndex(
                &job,
                RESOURCE,
                7,
                data_agent::types::fingerprint(&json!(&texts_of(1))),
            ),
            texts_of(1),
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(unknown.code, "embedding_unknown");
        let bound: Option<sqlx::types::Json<Value>> = sqlx::query_scalar(
            "SELECT embedding_profile FROM knowledge_index_jobs WHERE target_kind='source_excerpt' AND source_kind='platform' AND object_id=? AND version=7"
        ).bind(RESOURCE).fetch_one(&pool).await.unwrap();
        assert!(bound.is_none(), "回读旧账本不能冻结当前profile");
        assert!(stub.sends().is_empty(), "成功和未知批次不得重发");
    }
    let fresh_fp = data_agent::types::fingerprint(&json!(&texts_of(2)));
    let changed_fp = data_agent::types::fingerprint(&json!(&texts_of(3)));

    // 未发送批次：沿既有授权规则实际外发一次并结算。
    embed(
        &pool,
        &ctx,
        Binding::RawIndex(&job, RESOURCE, 7, fresh_fp),
        texts_of(2),
        None,
    )
    .await
    .unwrap();

    // 环境配置再次变化：目标已冻结trial，不换trial补额。
    unsafe {
        std::env::set_var(
            "DATA_AGENT_EMBEDDING_PROFILE",
            profile(CHANGED_TRIAL).to_string(),
        )
    };
    embed(
        &pool,
        &ctx,
        Binding::RawIndex(&job, RESOURCE, 7, changed_fp),
        texts_of(3),
        None,
    )
    .await
    .unwrap();

    let sends = stub.sends();
    assert_eq!(
        sends.len(),
        2,
        "只有未发送批次实际外发：{:?}",
        sends.iter().map(|b| b.len()).collect::<Vec<_>>()
    );
    assert_eq!(sends[0], texts_of(2), "首个外发批是批2原文");
    assert_eq!(sends[1], texts_of(3), "配置变化后的外发批是批3原文");
    async fn attempt_row(pool: &sqlx::MySqlPool, id: &str) -> sqlx::mysql::MySqlRow {
        sqlx::query("SELECT state,trial_id FROM model_call_attempts WHERE id=?")
            .bind(id)
            .fetch_one(pool)
            .await
            .unwrap()
    }
    let settled = attempt_row(&pool, &settled_id).await;
    assert_eq!(settled.get::<String, _>("state"), "settled");
    assert_eq!(
        settled.get::<String, _>("trial_id"),
        LEGACY_TRIAL,
        "已结算回执保留原trial"
    );
    let unknown_row = attempt_row(&pool, &unknown_id).await;
    assert_eq!(unknown_row.get::<String, _>("state"), "unknown");
    assert_eq!(unknown_row.get::<String, _>("trial_id"), LEGACY_TRIAL);
    let (fresh_id, _, _) = identity(2);
    let fresh = attempt_row(&pool, &fresh_id).await;
    assert_eq!(fresh.get::<String, _>("state"), "settled");
    assert_eq!(fresh.get::<String, _>("trial_id"), FROZEN_TRIAL);
    let (changed_id, _, _) = identity(3);
    let changed = attempt_row(&pool, &changed_id).await;
    assert_eq!(changed.get::<String, _>("state"), "settled");
    assert_eq!(
        changed.get::<String, _>("trial_id"),
        FROZEN_TRIAL,
        "配置再变仍沿目标冻结trial，不换trial补额"
    );
    let changed_registered: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM model_trials WHERE id=?")
            .bind(CHANGED_TRIAL)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(changed_registered, 0, "更换后的当前trial不登记不消耗");

    // 清理与还原。
    for id in [settled_id, unknown_id, fresh_id, changed_id] {
        sqlx::query("DELETE FROM model_call_attempts WHERE id=?")
            .bind(&id)
            .execute(&pool)
            .await
            .unwrap();
    }
    for trial in [LEGACY_TRIAL, FROZEN_TRIAL, CHANGED_TRIAL] {
        sqlx::query("DELETE FROM model_trials WHERE id=?")
            .bind(trial)
            .execute(&pool)
            .await
            .unwrap();
    }
    sqlx::query(
        "DELETE FROM knowledge_index_jobs WHERE target_kind='source_excerpt' AND object_id=?",
    )
    .bind(RESOURCE)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("DELETE FROM background_jobs WHERE kind='raw_source_index' AND resource_id=?")
        .bind(RESOURCE)
        .execute(&pool)
        .await
        .unwrap();
    unsafe {
        for (key, value) in restore {
            if value.is_empty() {
                std::env::remove_var(&key);
            } else {
                std::env::set_var(&key, value);
            }
        }
    }
    drop(stub);
    pool.close().await;
}

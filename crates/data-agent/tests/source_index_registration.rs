use data_agent::{
    contracts::generated::{SourceKey, SourceKeyKind},
    modules::{
        knowledge,
        retrieval::{source_segments, vector},
    },
    persistence::{AppTx, connect},
    types::AccessContext,
    use_cases::knowledge_documents,
};
use serde_json::json;
use sqlx::Row;

fn test_url() -> Option<String> {
    std::env::var("DATA_AGENT_DATABASE_URL")
        .ok()
        .filter(|url| url.contains("/data_agent_test_"))
}

fn ctx() -> AccessContext {
    AccessContext {
        user_id: "source-index-registration".into(),
        space_id: "demo".into(),
        request_id: "source-index-registration".into(),
        table_access: None,
    }
}

// 同名平台来源与文档来源是两个不同目标：SourceKey的kind进入公共待办身份，
// 登记互不覆盖；旧队列不再接收新的raw登记。
#[tokio::test]
async fn registration_targets_shared_todo_with_source_key_identity() {
    let Some(url) = test_url() else {
        return;
    };
    let pool = connect(&url).await.unwrap();
    let ctx = ctx();
    for statement in [
        "DELETE FROM knowledge_index_jobs WHERE target_kind='source_excerpt' AND object_id='shared-id'",
        "DELETE FROM background_jobs WHERE kind='raw_source_index' AND resource_id IN ('shared-id','document-shared-id')",
    ] {
        sqlx::query(statement).execute(&pool).await.unwrap();
    }
    let mut tx = AppTx::begin(&pool).await.unwrap();
    knowledge::register_source_index_target_in_tx(
        &mut tx,
        &ctx.space_id,
        &SourceKey {
            kind: SourceKeyKind::Platform,
            id: "shared-id".into(),
        },
        4,
        None,
    )
    .await
    .unwrap();
    knowledge::register_source_index_target_in_tx(
        &mut tx,
        &ctx.space_id,
        &SourceKey {
            kind: SourceKeyKind::Document,
            id: "shared-id".into(),
        },
        7,
        None,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let rows = sqlx::query(
        "SELECT source_kind,version,space_id FROM knowledge_index_jobs \
         WHERE target_kind='source_excerpt' AND object_id='shared-id' ORDER BY source_kind",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(rows.len(), 2, "平台与文档同ID是两个独立目标");
    assert_eq!(rows[0].get::<String, _>("source_kind"), "document");
    assert_eq!(rows[0].get::<u64, _>("version"), 7);
    assert_eq!(rows[1].get::<String, _>("source_kind"), "platform");
    assert_eq!(rows[1].get::<u64, _>("version"), 4);
    assert_eq!(rows[0].get::<String, _>("space_id"), "demo");
    let legacy = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM background_jobs WHERE kind='raw_source_index'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(legacy, 0, "新登记不得再进入旧raw队列");
    for statement in [
        "DELETE FROM knowledge_index_jobs WHERE target_kind='source_excerpt' AND object_id='shared-id'",
    ] {
        sqlx::query(statement).execute(&pool).await.unwrap();
    }
    pool.close().await;
}

// 独立文档以知识条目定位：保存只原子排队该修订的语义准备，不登记原文向量目标。
#[tokio::test]
async fn document_save_queues_semantic_preparation_without_raw_target() {
    let Some(url) = test_url() else {
        return;
    };
    let pool = connect(&url).await.unwrap();
    for statement in [
        "DELETE FROM knowledge_index_jobs WHERE target_kind='source_excerpt' AND object_id='prepared-only'",
        "DELETE FROM background_jobs WHERE resource_id='document-prepared-only'",
    ] {
        sqlx::query(statement).execute(&pool).await.unwrap();
    }
    let document = json!({
        "id":"prepared-only","kind":"document","state":"enabled","version":"7",
        "entries":[{"entry_id":"body","path":"body","label":"正文","effective_value":"未付款订单不产生退款，首次申请免费处理。"}]
    });
    let mut tx = AppTx::begin(&pool).await.unwrap();
    knowledge_documents::register_document_preparation_in_tx(&mut tx, &document)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let prepared = sqlx::query(
        "SELECT kind,resource_version FROM background_jobs WHERE resource_id='document-prepared-only'",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(prepared.len(), 1, "文档保存只排一项后台工作");
    assert_eq!(prepared[0].get::<String, _>("kind"), "prepare_source");
    assert_eq!(
        prepared[0].get::<Option<u64>, _>("resource_version"),
        Some(7)
    );
    let raw = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM knowledge_index_jobs WHERE target_kind='source_excerpt' AND object_id='prepared-only'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(raw, 0, "文档保存不登记原文向量目标");
    for statement in [
        "DELETE FROM knowledge_index_jobs WHERE target_kind='source_excerpt' AND object_id='prepared-only'",
        "DELETE FROM background_jobs WHERE resource_id='document-prepared-only'",
    ] {
        sqlx::query(statement).execute(&pool).await.unwrap();
    }
    pool.close().await;
}

// 封板前登记的文档原文目标仍由统一消费者收敛到投影完成。普通原文召回只使用
// 平台来源：同一集合内平台摘录两路可召回并按来源限定，已写入的文档摘录不进入
// 原文通道。
#[tokio::test]
async fn legacy_document_target_converges_while_recall_stays_platform_only() {
    let Some(url) = test_url() else {
        return;
    };
    let dedicated = std::env::var("DATA_AGENT_VECTOR_COLLECTION")
        .unwrap_or_default()
        .starts_with("data_agent_test_");
    if std::env::var("DATA_AGENT_VECTOR_URL").is_err()
        || std::env::var("DATA_AGENT_EMBEDDING_PROFILE").is_err()
        || !dedicated
    {
        return;
    }
    let pool = connect(&url).await.unwrap();
    let ctx = ctx();
    const DOCUMENT: &str = "raw-registration-doc";
    const PLATFORM: &str = "raw-registration-platform";
    const CLEANUP: [&str; 6] = [
        "DELETE FROM knowledge_index_jobs WHERE target_kind='source_excerpt' AND object_id IN ('raw-registration-doc','raw-registration-platform')",
        "DELETE FROM retrieval_source_projections WHERE source_id IN ('raw-registration-doc','raw-registration-platform')",
        "UPDATE knowledge_revisions SET archived_body=NULL WHERE object_id='raw-registration-doc'",
        "DELETE FROM knowledge_objects WHERE id='raw-registration-doc'",
        "DELETE FROM source_current WHERE source_id='raw-registration-platform'",
        "DELETE FROM source_heads WHERE id='raw-registration-platform'",
    ];
    for statement in CLEANUP {
        sqlx::query(statement).execute(&pool).await.unwrap();
    }
    // 关键句独占一段：Sql与Markdown两种切块格式下都不被段内边界拆开。
    let body = format!(
        "{}\n\n未付款订单不产生退款，首次申请免费处理。\n\n{}",
        "背景说明。".repeat(300),
        "尾部条款。".repeat(300)
    );
    let document = json!({
        "id":DOCUMENT,"kind":"document","state":"enabled","version":"1",
        "entries":[{"entry_id":"body","path":"body","label":"正文","effective_value":body}]
    });
    sqlx::query("INSERT INTO knowledge_objects(id,space_id,kind,name,version,state,body,source_version,updated_by) VALUES(?,?,?,?,?,?,?,0,'source-index-registration')")
        .bind(DOCUMENT).bind(&ctx.space_id).bind("document").bind("登记回环文档").bind(1u64).bind("enabled")
        .bind(sqlx::types::Json(&document))
        .execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO knowledge_revisions(object_id,version,archived_body) VALUES(?,?,?)")
        .bind(DOCUMENT)
        .bind(1u64)
        .bind(sqlx::types::Json(&document))
        .execute(&pool)
        .await
        .unwrap();
    // 与source_excerpt_recall同一做法：同一正文另存为平台来源，承担原文召回的正例。
    sqlx::query("INSERT INTO source_heads(id,space_id,version,fingerprint) VALUES('raw-registration-platform','demo',1,'synthetic')")
        .execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO source_current(source_id,space_id,adapter_id,source_kind,namespace,external_id,revision,body,complete,metadata,content_fingerprint,explanation_fingerprint,comparison_method,parsed,observed_metadata) VALUES('raw-registration-platform','demo','synthetic','platform','synthetic','raw-registration-platform',1,?,TRUE,'{}','synthetic','synthetic','exact',TRUE,'{}')")
        .bind(&body).execute(&pool).await.unwrap();
    // 保存路径已不登记文档原文目标；封板前登记的行直接经knowledge登记入口建立。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    for key in [
        SourceKey {
            kind: SourceKeyKind::Document,
            id: DOCUMENT.into(),
        },
        SourceKey {
            kind: SourceKeyKind::Platform,
            id: PLATFORM.into(),
        },
    ] {
        knowledge::register_source_index_target_in_tx(&mut tx, &ctx.space_id, &key, 1, None)
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();
    let pending_knowledge = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM knowledge_index_jobs WHERE target_kind='knowledge_entry' AND vector_state='pending'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(pending_knowledge > 0, "夹具须同时存在待处理知识与原文任务");
    data_agent::use_cases::knowledge::process_index(&pool)
        .await
        .unwrap();
    let waiting = sqlx::query(
        "SELECT vector_state,vector_attempts FROM knowledge_index_jobs \
         WHERE target_kind='source_excerpt' AND source_kind='document' AND object_id=?",
    )
    .bind(DOCUMENT)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(waiting.get::<String, _>("vector_state"), "pending");
    assert_eq!(waiting.get::<u32, _>("vector_attempts"), 0);
    // 知识批次完成后再领取原文，不能让尚未执行的另一类任务空耗租约。
    while data_agent::use_cases::knowledge::process_index(&pool)
        .await
        .unwrap()
    {}
    for (kind, id) in [("document", DOCUMENT), ("platform", PLATFORM)] {
        let settled = sqlx::query(
            "SELECT vector_state,vector_target FROM knowledge_index_jobs \
             WHERE target_kind='source_excerpt' AND source_kind=? AND object_id=?",
        )
        .bind(kind)
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            settled.get::<String, _>("vector_state"),
            "indexed",
            "{kind}原文目标经统一消费者完成"
        );
        let target: String = settled.get("vector_target");
        assert!(!target.is_empty(), "完成状态必须绑定实际集合身份");
        let projection = sqlx::query(
            "SELECT revision,complete,applied_position,collection_target FROM retrieval_source_projections \
             WHERE source_kind=? AND source_id=? AND space_id='demo'",
        )
        .bind(kind)
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(projection.get::<u64, _>("revision"), 1);
        assert_eq!(projection.get::<u8, _>("complete"), 1);
        assert_eq!(projection.get::<String, _>("collection_target"), target);
        assert!(
            projection.get::<u64, _>("applied_position") >= body.chars().count() as u64,
            "投影进度必须推进到正文末尾"
        );
    }
    // 长文切出多个片段；查询与入库文本使用同一个本地Embedding协议，避免固定伪向量
    // 污染共同排序。
    let segments = source_segments::segment_source(
        &source_segments::SourceText {
            source: &SourceKey {
                kind: SourceKeyKind::Document,
                id: DOCUMENT.into(),
            },
            revision: "1",
            text: &body,
            format: source_segments::SourceFormat::Markdown,
            background: &[],
        },
        None,
    )
    .unwrap();
    assert!(segments.segments.len() >= 2, "长文应切出多个片段");
    let query = "未付款订单首次申请免费处理";
    let mut vectors = data_agent::use_cases::embed(
        &pool,
        &ctx,
        data_agent::use_cases::Binding::Browse,
        vec![query.to_owned()],
        Some(vector::retrieval_deadline()),
    )
    .await
    .unwrap();
    let query_vector = vectors.remove(0);
    // 无来源限制的内部检索会执行原文通道：两路都召回平台来源，文档摘录不出现。
    let unscoped = vector::search(&ctx.space_id, query, query_vector.clone(), 10)
        .await
        .unwrap();
    assert_eq!(unscoped.raw.state, "available");
    for channel in [&unscoped.raw.lexical, &unscoped.raw.dense] {
        assert!(
            channel.iter().any(|hit| hit["source_id"] == PLATFORM),
            "原文通道必须召回同一正文的平台来源：{:?}",
            channel
        );
        assert!(
            channel.iter().all(|hit| hit["source_kind"] != "document"),
            "原文通道不得召回文档摘录：{:?}",
            channel
        );
    }
    // 来源限定：平台来源两路均实际召回且只返回该来源；限定为独立文档时没有原文分片。
    for (kind, id, recall) in [("platform", PLATFORM, true), ("document", DOCUMENT, false)] {
        let allowed = vector::AllowedRecords {
            knowledge_ids: vec![],
            sources: vec![(kind.into(), id.into())],
        };
        let candidates = vector::search_scoped(vector::ScopedQuery {
            space: &ctx.space_id,
            query,
            vector: Some(query_vector.clone()),
            scope: &data_agent::search_scope::KnowledgeSearchScope::default(),
            limit: 10,
            allowed: Some(&allowed),
            include_raw: true,
            deadline: vector::retrieval_deadline(),
        })
        .await
        .unwrap();
        for channel in [&candidates.raw.lexical, &candidates.raw.dense] {
            assert_eq!(!channel.is_empty(), recall, "来源限定为{kind}时的原文召回");
            assert!(
                channel
                    .iter()
                    .all(|hit| hit["source_id"] == id && hit["source_kind"] == kind),
                "来源过滤后只能命中限定的来源"
            );
        }
    }
    // 清理：删行与两类摘录向量；专用集合本身由harness管理。
    for statement in CLEANUP {
        sqlx::query(statement).execute(&pool).await.unwrap();
    }
    for (kind, id) in [("document", DOCUMENT), ("platform", PLATFORM)] {
        vector::drop_source_excerpts(&ctx.space_id, kind, id, 2)
            .await
            .unwrap();
    }
    pool.close().await;
}

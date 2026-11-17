use data_agent::{
    contracts::generated::{SourceKey, SourceKeyKind},
    modules::{
        knowledge,
        retrieval::{self, source_segments, vector},
    },
    persistence::{AppTx, connect},
    types::AccessContext,
    use_cases::knowledge_documents,
};
use serde_json::{Value, json};
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
    // 文档保存路径的原子登记走同一公开入口，别名不进待办身份。
    let document = json!({
        "id":"shared-id","kind":"document","state":"enabled","version":"7",
        "entries":[{"entry_id":"body","path":"body","label":"正文","effective_value":"未付款订单不产生退款，首次申请免费处理。"}]
    });
    knowledge_documents::register_document_preparation_in_tx(&mut tx, &ctx.space_id, &document)
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

// 统一消费者接通文档原文：登记→领取→切块→向量写入→投影进度→旧修订清理，
// 全程不依赖语义整理；旧队列与重复Worker入口不再参与。
#[tokio::test]
async fn unified_consumer_projects_document_source_into_shared_collection() {
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
    let document_id = "raw-registration-doc";
    let body = format!(
        "{}未付款订单不产生退款，首次申请免费处理。{}最终解释以协议为准，运费除外。",
        "背景说明。".repeat(300),
        "尾部条款。".repeat(300)
    );
    let document = json!({
        "id":document_id,"kind":"document","state":"enabled","version":"1",
        "entries":[{"entry_id":"body","path":"body","label":"正文","effective_value":body}]
    });
    for statement in [
        "DELETE FROM knowledge_index_jobs WHERE target_kind='source_excerpt' AND object_id='raw-registration-doc'",
        "DELETE FROM retrieval_source_projections WHERE source_id='raw-registration-doc'",
        "DELETE FROM knowledge_versions WHERE object_id='raw-registration-doc'",
        "DELETE FROM knowledge_objects WHERE id='raw-registration-doc'",
    ] {
        sqlx::query(statement).execute(&pool).await.unwrap();
    }
    sqlx::query("INSERT INTO knowledge_objects(id,space_id,kind,name,version,state,body,source_version,updated_by) VALUES(?,?,?,?,?,?,?,0,'source-index-registration')")
        .bind(document_id).bind(&ctx.space_id).bind("document").bind("登记回环文档").bind(1u64).bind("enabled")
        .bind(sqlx::types::Json(&document))
        .execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO knowledge_versions(object_id,version,body) VALUES(?,?,?)")
        .bind(document_id)
        .bind(1u64)
        .bind(sqlx::types::Json(&document))
        .execute(&pool)
        .await
        .unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    knowledge_documents::register_document_preparation_in_tx(&mut tx, &ctx.space_id, &document)
        .await
        .unwrap();
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
    .bind(document_id)
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
    let settled = sqlx::query(
        "SELECT vector_state,vector_target FROM knowledge_index_jobs \
         WHERE target_kind='source_excerpt' AND source_kind='document' AND object_id=?",
    )
    .bind(document_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(settled.get::<String, _>("vector_state"), "indexed");
    let target: String = settled.get("vector_target");
    assert!(!target.is_empty(), "完成状态必须绑定实际集合身份");
    let projection = sqlx::query(
        "SELECT revision,complete,applied_position,collection_target FROM retrieval_source_projections \
         WHERE source_kind='document' AND source_id=? AND space_id='demo'",
    )
    .bind(document_id)
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
    // 多片段原文经统一消费者切块入库，可经检索通道召回。
    let key = SourceKey {
        kind: SourceKeyKind::Document,
        id: document_id.into(),
    };
    let segments = source_segments::segment_source(
        &source_segments::SourceText {
            source: &key,
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
    // 查询与入库文本使用同一个本地Embedding协议，避免固定伪向量污染共同排序。
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
    let unscoped = vector::search(&ctx.space_id, query, query_vector.clone(), 10).await;
    assert_eq!(unscoped.raw.state, "available");
    assert!(
        unscoped
            .raw
            .lexical
            .iter()
            .any(|hit| { hit["source_id"] == document_id && hit["source_kind"] == "document" }),
        "无来源限制的BM25必须召回登记文档"
    );
    assert!(
        unscoped
            .raw
            .dense
            .iter()
            .any(|hit| { hit["source_id"] == document_id && hit["source_kind"] == "document" }),
        "同端点查询向量必须召回登记文档"
    );
    // 登记回环不依赖协议向量的全库相关性；正式来源过滤后仍须经两路共同排序。
    let allowed = vector::AllowedRecords {
        knowledge_ids: vec![],
        sources: vec![("document".into(), document_id.into())],
    };
    let candidates = vector::search_scoped(vector::ScopedQuery {
        space: &ctx.space_id,
        query,
        vector: Some(query_vector),
        scope: &data_agent::search_scope::KnowledgeSearchScope::default(),
        limit: 10,
        allowed: Some(&allowed),
        include_raw: true,
        deadline: vector::retrieval_deadline(),
    })
    .await;
    assert_eq!(candidates.raw.state, "available");
    for channel in [&candidates.raw.lexical, &candidates.raw.dense] {
        assert!(!channel.is_empty(), "来源过滤后两路均须实际召回");
        assert!(
            channel
                .iter()
                .all(|hit| { hit["source_id"] == document_id && hit["source_kind"] == "document" })
        );
    }
    // 共同排序（内部双类型）：同一位置跨通道去重，不同位置分别保留。
    let fused = retrieval::rank_common(
        "未付款订单首次申请免费处理",
        vec![],
        &retrieval::Channels::all(
            &candidates.lexical,
            &candidates.values,
            &candidates.raw.lexical,
            &candidates.raw.dense,
        ),
        10,
        true,
    );
    let mine: Vec<&Value> = fused
        .raw
        .iter()
        .filter(|hit| hit["source_id"] == document_id && hit["source_kind"] == "document")
        .collect();
    assert!(
        !mine.is_empty(),
        "原文通道必须召回本来源命中：{:?}",
        fused.raw
    );
    // 清理：删行与摘录向量；专用集合本身由harness管理。
    for statement in [
        "DELETE FROM knowledge_index_jobs WHERE target_kind='source_excerpt' AND object_id='raw-registration-doc'",
        "DELETE FROM retrieval_source_projections WHERE source_id='raw-registration-doc'",
        "DELETE FROM knowledge_versions WHERE object_id='raw-registration-doc'",
        "DELETE FROM knowledge_objects WHERE id='raw-registration-doc'",
    ] {
        sqlx::query(statement).execute(&pool).await.unwrap();
    }
    vector::drop_source_excerpts(&ctx.space_id, "document", document_id, 2)
        .await
        .unwrap();
    pool.close().await;
}

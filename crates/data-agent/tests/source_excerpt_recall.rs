use data_agent::{
    contracts::generated::{SourceKey, SourceKeyKind},
    modules::retrieval::{
        Channels,
        embedding::SPEC,
        rank_common,
        source_segments::{SourceFormat, SourceText, segment_source},
        vector::{
            ScopedQuery, apply_source_excerpts, drop_source_excerpts, retrieval_deadline,
            search_scoped,
        },
    },
    persistence::{AppTx, connect},
    search_scope::KnowledgeSearchScope,
    types::AccessContext,
    use_cases::recall_excerpts_in_tx,
};
use serde_json::{Value, json};
use sqlx::Row;

// 封板后普通原文召回只使用平台来源。原文场景把同一正文登记为平台来源，经正式
// 消费者写入索引；切块格式随之是Sql，含非SQL字符的正文回退到段落结构。
async fn saved_platform_source(pool: &sqlx::MySqlPool, id: &str, body: &str) -> SourceKey {
    // 夹具SQL经连接池自动提交；AppTx的底层连接是crate私有，外部测试按公共入口组装。
    sqlx::query(
        "INSERT INTO source_heads(id,space_id,version,fingerprint) VALUES(?,'demo',1,'synthetic')",
    )
    .bind(id)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO source_current(source_id,space_id,adapter_id,source_kind,namespace,\
         external_id,revision,body,complete,metadata,content_fingerprint,\
         explanation_fingerprint,comparison_method,parsed,observed_metadata) \
         VALUES(?,'demo','synthetic','platform','synthetic',?,1,?,TRUE,'{}','synthetic',\
         'synthetic','exact',TRUE,'{}')",
    )
    .bind(id)
    .bind(id)
    .bind(body)
    .execute(pool)
    .await
    .unwrap();
    let key = SourceKey {
        kind: SourceKeyKind::Platform,
        id: id.to_owned(),
    };
    let mut tx = AppTx::begin(pool).await.unwrap();
    data_agent::modules::knowledge::register_source_index_target_in_tx(
        &mut tx, "demo", &key, 1, None,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    key
}

async fn indexed_platform_source(pool: &sqlx::MySqlPool, id: &str, body: &str) -> SourceKey {
    let key = saved_platform_source(pool, id, body).await;
    while data_agent::use_cases::knowledge::process_index(pool)
        .await
        .unwrap()
    {}
    key
}

// 只推进平台来源修订：旧修订的索引命中不得再解释为当前正文。
async fn revise_platform_source(pool: &sqlx::MySqlPool, id: &str, revision: u64, body: &str) {
    sqlx::query("UPDATE source_heads SET version=? WHERE id=?")
        .bind(revision)
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("UPDATE source_current SET revision=?,body=? WHERE source_id=?")
        .bind(revision)
        .bind(body)
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn document_windows_keep_entry_boundaries_without_transferring_unselected_text() {
    let Ok(url) = std::env::var("DATA_AGENT_DATABASE_URL") else {
        return;
    };
    assert!(url.contains("/data_agent_test_"));
    let pool = connect(&url).await.unwrap();
    let ctx = AccessContext {
        user_id: "document-window-check".into(),
        space_id: "demo".into(),
        request_id: "document-window".into(),
        table_access: None,
    };
    let id = "document-window-unicode";
    let document = json!({
        "id":id,"kind":"document","name":"合成多条目文档","version":"1","state":"enabled",
        "source_id":null,"source_version":"0","related_ids":[],
        "entries":[
            {"entry_id":"z","effective_value":"语🧪"},
            {"entry_id":"empty","effective_value":""},
            {"entry_id":"non-string","effective_value":7},
            {"entry_id":"a","effective_value":"e\u{301}\nZ"},
            {"entry_id":"unselected","effective_value":"背景填充。".repeat(12000)}
        ]
    });
    sqlx::query("INSERT INTO knowledge_objects(id,space_id,kind,name,version,state,body,source_id,source_version,updated_by) VALUES(?,'demo','document','合成多条目文档',1,'enabled',?,NULL,0,'synthetic-test')")
        .bind(id).bind(sqlx::types::Json(&document)).execute(&pool).await.unwrap();
    // 单连接池使SESSION字节计数覆盖实际读取；不以耗时或结果被裁短冒充窄读。
    // 不建立依赖映射，兼容分支也只能读取引用元信息，不能把正文搬回应用。
    let measured = sqlx::mysql::MySqlPoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .unwrap();
    let before: u64 = sqlx::query("SHOW SESSION STATUS LIKE 'Bytes_sent'")
        .fetch_one(&measured)
        .await
        .unwrap()
        .get::<String, _>("Value")
        .parse()
        .unwrap();
    let citation = json!({"source":{"kind":"document","id":id},"revision":"1",
        "locator":{"offset":1,"length":8}});
    let excerpt =
        data_agent::use_cases::knowledge::source_excerpt(&measured, &ctx, citation.clone())
            .await
            .unwrap();
    assert_eq!(excerpt["citation"], citation);
    assert_eq!(excerpt["content"], "🧪\n\n\n\ne\u{301}\n");
    let hits = [
        json!({"source_kind":"document","source_id":id,"revision":1,"offset":0,
            "length":8,"score":2.,"content_hash":data_agent::types::fingerprint(&json!("语🧪\n\n\n\ne\u{301}"))}),
        json!({"source_kind":"document","source_id":id,"revision":1,"offset":6,
            "length":4,"score":1.,"content_hash":data_agent::types::fingerprint(&json!("e\u{301}\nZ"))}),
    ];
    let mut tx = AppTx::begin(&measured).await.unwrap();
    let recalled = recall_excerpts_in_tx(&mut tx, &ctx, None, &hits)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(recalled["lagged"], 0);
    assert_eq!(recalled["hits"].as_array().unwrap().len(), 1);
    assert_eq!(recalled["hits"][0]["text"], "语🧪\n\n\n\ne\u{301}\nZ");
    assert_eq!(
        recalled["hits"][0]["citation"]["locator"],
        json!({"offset":0,"length":10})
    );
    assert_eq!(recalled["hits"][0]["source_length"], 60012);
    let after: u64 = sqlx::query("SHOW SESSION STATUS LIKE 'Bytes_sent'")
        .fetch_one(&measured)
        .await
        .unwrap()
        .get::<String, _>("Value")
        .parse()
        .unwrap();
    assert!(
        after - before < 16_384,
        "两次短窗口读取不得传输未选正文：实际下行{}B",
        after - before
    );
    // 明确旧修订仍拒绝；不是拿新版同位置文字替换旧引用。
    let mut stale = citation;
    stale["revision"] = json!("2");
    assert_eq!(
        data_agent::use_cases::knowledge::source_excerpt(&measured, &ctx, stale)
            .await
            .unwrap_err()
            .code,
        "stale_source"
    );
    let mut tx = AppTx::begin(&measured).await.unwrap();
    let mut outdated = hits[0].clone();
    outdated["revision"] = json!(2);
    let recalled = recall_excerpts_in_tx(&mut tx, &ctx, None, &[outdated])
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(recalled["hits"], json!([]));
    assert_eq!(recalled["lagged"], 1);
    measured.close().await;
    sqlx::query("DELETE FROM knowledge_objects WHERE id=?")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
}

#[tokio::test]
async fn platform_citation_reads_only_requested_unicode_window() {
    let Ok(url) = std::env::var("DATA_AGENT_DATABASE_URL") else {
        return;
    };
    assert!(url.contains("/data_agent_test_"));
    let pool = connect(&url).await.unwrap();
    let ctx = AccessContext {
        user_id: "platform-window-check".into(),
        space_id: "demo".into(),
        request_id: "platform-window".into(),
        table_access: None,
    };
    let prefix = "背景🌏。".repeat(20000);
    let selected = "窄读规则🧪e\u{301}：校验完成之后才能使用。";
    let body = format!("{prefix}{selected}{}", "未选附录。".repeat(20000));
    let measured = sqlx::mysql::MySqlPoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .unwrap();
    for (id, current) in [
        ("platform-window-current", true),
        ("platform-window-snapshot", false),
    ] {
        sqlx::query("INSERT INTO source_heads(id,space_id,version,fingerprint) VALUES(?,'demo',1,'synthetic')")
            .bind(id).execute(&pool).await.unwrap();
        if current {
            sqlx::query("INSERT INTO source_current(source_id,space_id,adapter_id,source_kind,namespace,external_id,revision,body,complete,metadata,content_fingerprint,explanation_fingerprint,comparison_method,parsed,observed_metadata) VALUES(?,'demo','synthetic','platform','window',?,1,?,TRUE,'{}','synthetic','synthetic','exact',TRUE,'{}')")
                .bind(id).bind(id).bind(&body).execute(&pool).await.unwrap();
        } else {
            sqlx::query(
                "INSERT INTO source_revisions(source_id,version,body,archive_complete) VALUES(?,1,?,TRUE)",
            )
            .bind(id)
            .bind(&body)
            .execute(&pool)
            .await
            .unwrap();
        }
        let before: u64 = sqlx::query("SHOW SESSION STATUS LIKE 'Bytes_sent'")
            .fetch_one(&measured)
            .await
            .unwrap()
            .get::<String, _>("Value")
            .parse()
            .unwrap();
        let citation = json!({"source":{"kind":"platform","id":id},"revision":"1",
            "locator":{"offset":prefix.chars().count(),"length":selected.chars().count()}});
        let excerpt =
            data_agent::use_cases::knowledge::source_excerpt(&measured, &ctx, citation.clone())
                .await
                .unwrap();
        assert_eq!(excerpt["citation"], citation);
        assert_eq!(excerpt["content"], selected);
        let after: u64 = sqlx::query("SHOW SESSION STATUS LIKE 'Bytes_sent'")
            .fetch_one(&measured)
            .await
            .unwrap()
            .get::<String, _>("Value")
            .parse()
            .unwrap();
        assert!(
            after - before < 16384,
            "{id}显式citation补读不得下行未选正文，实际{}B",
            after - before
        );
        let mut stale = citation.clone();
        stale["revision"] = json!("2");
        assert_eq!(
            data_agent::use_cases::knowledge::source_excerpt(&measured, &ctx, stale)
                .await
                .unwrap_err()
                .code,
            "stale_source"
        );
        let mut outside = citation;
        outside["locator"] = json!({"offset":body.chars().count() - 1,"length":2});
        assert_eq!(
            data_agent::use_cases::knowledge::source_excerpt(&measured, &ctx, outside)
                .await
                .unwrap_err()
                .code,
            "invalid_input",
            "越界不能交付截短正文配旧locator"
        );
    }
    measured.close().await;
    pool.close().await;
}

#[tokio::test]
async fn document_windows_preserve_legacy_source_checks_and_empty_content() {
    let Ok(url) = std::env::var("DATA_AGENT_DATABASE_URL") else {
        return;
    };
    assert!(url.contains("/data_agent_test_"));
    let pool = connect(&url).await.unwrap();
    let ctx = AccessContext {
        user_id: "document-reference-check".into(),
        space_id: "demo".into(),
        request_id: "document-reference".into(),
        table_access: None,
    };
    let id = "document-window-references";
    let sources = [
        "window-root",
        "window-fact",
        "window-evidence",
        "window-material",
        "window-structured",
    ];
    for source in sources {
        sqlx::query("INSERT INTO source_heads(id,space_id,version,fingerprint) VALUES(?,'demo',1,'synthetic')")
            .bind(source).execute(&pool).await.unwrap();
    }
    let mut document = json!({
        "id":id,"kind":"document","name":"合成来源文档","version":"1","state":"enabled",
        "source_id":"window-root","source_version":"1","related_ids":[],
        "entries":[{"entry_id":"body","effective_value":"语音说明",
            "source_facts":{"source_id":"window-fact","version":"1",
                "structured_evidence":[{"source_id":"window-structured","version":"1"}]},
            "suggestion":{"evidence":[{"source_id":"window-evidence","version":"1","quote":"引用背景。".repeat(12000)}],
                "material_refs":[{"source_id":"window-material","version":"1"}]}}]
    });
    sqlx::query("INSERT INTO knowledge_objects(id,space_id,kind,name,version,state,body,source_id,source_version,updated_by) VALUES(?,'demo','document','合成来源文档',1,'enabled',?,'window-root',1,'synthetic-test')")
        .bind(id).bind(sqlx::types::Json(&document)).execute(&pool).await.unwrap();
    let citation = json!({"source":{"kind":"document","id":id},"revision":"1",
        "locator":{"offset":0,"length":2}});
    assert_eq!(
        data_agent::use_cases::knowledge::source_excerpt(&pool, &ctx, citation.clone())
            .await
            .unwrap()["content"],
        "语音"
    );
    // 每一种旧来源字段仍独立生效；窄投影不能仅保留其中一类。
    for source in sources {
        sqlx::query("UPDATE source_heads SET version=2 WHERE id=?")
            .bind(source)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            data_agent::use_cases::knowledge::source_excerpt(&pool, &ctx, citation.clone())
                .await
                .unwrap_err()
                .code,
            "stale_knowledge",
            "必须检查来源{source}"
        );
        sqlx::query("UPDATE source_heads SET version=1 WHERE id=?")
            .bind(source)
            .execute(&pool)
            .await
            .unwrap();
    }
    document["entries"][0]["effective_value"] = json!(" \t\n\u{a0}");
    sqlx::query("UPDATE knowledge_objects SET body=? WHERE id=?")
        .bind(sqlx::types::Json(&document))
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        data_agent::use_cases::knowledge::source_excerpt(&pool, &ctx, citation)
            .await
            .unwrap_err()
            .code,
        "not_available",
        "只有Unicode空白不能变成完整文档"
    );
    sqlx::query("DELETE FROM knowledge_objects WHERE id=?")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    for source in sources {
        sqlx::query("DELETE FROM source_heads WHERE id=?")
            .bind(source)
            .execute(&pool)
            .await
            .unwrap();
    }
    pool.close().await;
}

#[tokio::test]
async fn source_recall_keeps_global_order_across_document_positions() {
    let Ok(url) = std::env::var("DATA_AGENT_DATABASE_URL") else {
        return;
    };
    assert!(url.contains("/data_agent_test_"));
    let pool = connect(&url).await.unwrap();
    let ctx = AccessContext {
        user_id: "source-order-check".into(),
        space_id: "demo".into(),
        request_id: "source-order".into(),
        table_access: None,
    };
    let bodies = [
        (
            "source-order-a",
            format!("{}例外条款", "一般说明".repeat(100)),
        ),
        ("source-order-b", "中间相关说明".to_owned()),
    ];
    for (id, body) in &bodies {
        sqlx::query(
            "INSERT INTO source_heads(id,space_id,version,fingerprint) VALUES(?,'demo',1,'fp')",
        )
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO source_current(source_id,space_id,adapter_id,source_kind,namespace,external_id,revision,body,complete,metadata,content_fingerprint,explanation_fingerprint,comparison_method,parsed,observed_metadata) VALUES(?,'demo','adapter','platform','ns',?,1,?,TRUE,'{}','fp','fp','exact',TRUE,'{}')")
            .bind(id).bind(id).bind(body).execute(&pool).await.unwrap();
    }
    let hits: Vec<Value> = [(0,400,4,3.), (1,0,6,2.), (0,0,4,1.)].into_iter().map(|(doc,offset,length,score)| {
        let text: String = bodies[doc].1.chars().skip(offset).take(length).collect();
        json!({"source_kind":"platform","source_id":bodies[doc].0,"revision":1,"offset":offset,"length":length,"score":score,"content_hash":data_agent::types::fingerprint(&json!(text))})
    }).collect();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let result = recall_excerpts_in_tx(&mut tx, &ctx, None, &hits)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let delivered = result["hits"].as_array().unwrap();
    assert_eq!(
        delivered
            .iter()
            .map(|h| h["score"].as_f64().unwrap())
            .collect::<Vec<_>>(),
        [3., 2., 1.],
        "同文两个位置不能整组交付而打乱全局相关性"
    );
    assert_eq!(delivered[0]["citation"]["locator"]["offset"], 400);
    assert_eq!(delivered[1]["citation"]["source"]["id"], "source-order-b");
    for (id, _) in &bodies {
        sqlx::query("DELETE FROM source_current WHERE source_id=?")
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM source_heads WHERE id=?")
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
    }
    pool.close().await;
}

#[tokio::test]
async fn source_recall_preserves_database_failure_and_missing_source_distinction() {
    let Ok(url) = std::env::var("DATA_AGENT_DATABASE_URL") else {
        return;
    };
    assert!(url.contains("/data_agent_test_"), "只在隔离合成库注入故障");
    let pool = sqlx::mysql::MySqlPoolOptions::new()
        .max_connections(3)
        .after_connect(|connection, _| {
            Box::pin(async move {
                sqlx::query("SET SESSION lock_wait_timeout=1")
                    .execute(connection)
                    .await?;
                Ok(())
            })
        })
        .connect(&url)
        .await
        .unwrap();
    let ctx = AccessContext {
        user_id: "source-recall-check".into(),
        space_id: "demo".into(),
        request_id: "source-recall-failure".into(),
        table_access: None,
    };
    let hits = [
        json!({"source_kind":"platform", "source_id":"missing-recall-source",
        "revision":1, "offset":0, "length":10, "content_hash":"synthetic"}),
    ];
    // 实际 MySQL 元数据锁超时；调用方必须收到可重试故障，不能被改成索引滞后。
    let mut blocker = pool.acquire().await.unwrap();
    sqlx::raw_sql("LOCK TABLES source_heads WRITE")
        .execute(&mut *blocker)
        .await
        .unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let failed = recall_excerpts_in_tx(&mut tx, &ctx, None, &hits).await;
    tx.commit().await.unwrap();
    sqlx::raw_sql("UNLOCK TABLES")
        .execute(&mut *blocker)
        .await
        .unwrap();
    drop(blocker);
    let error = failed.expect_err("数据库故障不能作为成功的空搜索回执");
    assert!(error.is_transient_storage());
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let missing = recall_excerpts_in_tx(&mut tx, &ctx, None, &hits)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(missing["hits"], json!([]));
    assert_eq!(missing["lagged"], 1);
    pool.close().await;
}

#[tokio::test]
async fn raw_stage_returns_preparation_state_and_rejects_revision_changed_after_read() {
    let Ok(url) = std::env::var("DATA_AGENT_DATABASE_URL") else {
        return;
    };
    assert!(url.contains("/data_agent_test_"));
    if std::env::var("DATA_AGENT_EMBEDDING_PROFILE").is_err() {
        return;
    }
    let pool = connect(&url).await.unwrap();
    let ctx = AccessContext {
        user_id: "alice".into(),
        space_id: "demo".into(),
        request_id: "raw-stage-preparation".into(),
        table_access: None,
    };
    let mut sources = Vec::new();
    for (state, marker) in [
        ("pending", "rawstagependingneedle"),
        ("failed", "rawstagefailedneedle"),
    ] {
        let source = format!("raw-stage-{state}");
        saved_platform_source(
            &pool,
            &source,
            &format!("{marker}：未付款订单不产生退款，运费除外。"),
        )
        .await;
        let mut tx = AppTx::begin(&pool).await.unwrap();
        data_agent::modules::ingestion::preparation::ensure_preparation_in_tx(
            &mut tx,
            "demo",
            &source,
            1,
            "synthetic-input",
            "synthetic-dependency",
        )
        .await
        .unwrap();
        if state == "failed" {
            data_agent::modules::ingestion::preparation::fail_preparation_in_tx(
                &mut tx,
                &source,
                1,
                "model_fault",
            )
            .await
            .unwrap();
        }
        tx.commit().await.unwrap();
        sources.push((state, marker, source));
    }
    while data_agent::use_cases::knowledge::process_index(&pool)
        .await
        .unwrap()
    {}
    for (state, marker, source) in &sources {
        let scope = KnowledgeSearchScope::default();
        let allowed = data_agent::modules::retrieval::vector::AllowedRecords {
            knowledge_ids: Vec::new(),
            sources: vec![("platform".into(), source.clone())],
        };
        let stage = data_agent::use_cases::knowledge::search_stage_outside_lock(
            &pool,
            &ctx,
            &mut data_agent::use_cases::knowledge::ScopedSearchRequest {
                query: marker,
                limit: 1,
                launch: None,
                vector: data_agent::modules::retrieval::vector::Candidates::lexical(),
                scope: &scope,
                allowed: Some(&allowed),
                asset_after: None,
                hints: None,
                cid: "",
                text_results: &Default::default(),
                include_raw: true,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            stage.search.hits.len(),
            1,
            "{state}原文必须经正式组合入口交付"
        );
        let data_agent::use_cases::knowledge::SearchHit::SourceExcerpt { content, .. } =
            &stage.search.hits[0]
        else {
            panic!("内部raw命中不能伪装成知识对象");
        };
        assert!(content["text"].as_str().unwrap().contains(marker));
        assert_eq!(
            content["semantic_status"], *state,
            "不能从全文可读性推断整理ready"
        );
        assert_eq!(content["content_state"], "complete");
        assert_eq!(content["support_state"], "unknown");
        let mut tx = AppTx::begin(&pool).await.unwrap();
        data_agent::use_cases::knowledge::assert_search_fresh_in_tx(&mut tx, &ctx, &stage)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        revise_platform_source(
            &pool,
            source,
            2,
            "新修订改变了原文条款，旧位置不能解释为新正文。",
        )
        .await;
        let mut tx = AppTx::begin(&pool).await.unwrap();
        let error =
            data_agent::use_cases::knowledge::assert_search_fresh_in_tx(&mut tx, &ctx, &stage)
                .await
                .expect_err("锁外raw回源后改版必须被最终事务拒绝");
        assert_eq!(error.code, "stale_source");
        eprintln!(
            "raw_preparation_state state={state} content_state=complete support_state=unknown changed_revision_error={}",
            error.code
        );
    }
    pool.close().await;
}

#[tokio::test]
async fn raw_stage_reads_tail_after_129_segments_from_saved_platform_consumer() {
    let Ok(url) = std::env::var("DATA_AGENT_DATABASE_URL") else {
        return;
    };
    assert!(url.contains("/data_agent_test_"));
    assert!(
        std::env::var("DATA_AGENT_VECTOR_COLLECTION")
            .unwrap_or_default()
            .starts_with("data_agent_test_")
    );
    let pool = connect(&url).await.unwrap();
    let ctx = AccessContext {
        user_id: "alice".into(),
        space_id: "demo".into(),
        request_id: "raw-stage-long-source".into(),
        table_access: None,
    };
    let marker = "rawstagelastsegmentneedle";
    let table = json!({
        "id":"raw-stage-long-table","name":"synthetic_raw_stage_long",
        "platform_version":"1","comment":"背景说明。".repeat(32000),
        "ddl":"CREATE TABLE synthetic_raw_stage_long (id BIGINT);",
        "columns":[{"id":"id","name":"id","data_type":"BIGINT","nullable":false,"comment":"合成编号"}],
        "node":{"id":"synthetic-long-node","sql":format!("SELECT id FROM synthetic_raw_stage_long; -- {marker}：尾部条款，运费除外。"),"upstream_ids":[]},
        "maintainer_id":"alice"
    });
    data_agent::contracts::validate("CatalogTable", &table).unwrap();
    let source_id = data_agent::modules::ingestion::catalog::source_id(
        "demo",
        "raw-stage-long",
        "raw-stage-long-table",
    );
    let body = data_agent::modules::ingestion::catalog::source_text(&table);
    let key = SourceKey {
        kind: SourceKeyKind::Platform,
        id: source_id.clone(),
    };
    let source = SourceText {
        source: &key,
        revision: "1",
        text: &body,
        format: SourceFormat::Sql,
        background: &[],
    };
    let mut segments = Vec::new();
    let mut cursor = None;
    loop {
        let batch = segment_source(&source, cursor.as_ref()).unwrap();
        segments.extend(batch.segments);
        cursor = batch.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    assert!(
        segments.len() > 129,
        "必须实际超过129块，实测{}",
        segments.len()
    );
    let marker_segments = segments
        .iter()
        .enumerate()
        .filter(|(_, segment)| segment.text.contains(marker))
        .collect::<Vec<_>>();
    assert!(!marker_segments.is_empty());
    assert!(
        marker_segments.iter().all(|(index, _)| *index >= 129),
        "目标在前129块中不得提前出现"
    );
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let read = data_agent::modules::ingestion::begin_catalog_read_in_tx(
        &mut tx,
        &ctx,
        "raw-stage-long-save",
    )
    .await
    .unwrap();
    let (revision, changed) = data_agent::modules::ingestion::save_catalog_table_in_tx(
        &mut tx,
        &ctx,
        &read,
        "raw-stage-long",
        &table,
    )
    .await
    .unwrap();
    assert_eq!(revision, 1);
    assert!(changed);
    data_agent::modules::knowledge::register_source_index_target_in_tx(
        &mut tx, "demo", &key, revision, None,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    while data_agent::use_cases::knowledge::process_index(&pool)
        .await
        .unwrap()
    {}
    let scope = KnowledgeSearchScope::default();
    let allowed = data_agent::modules::retrieval::vector::AllowedRecords {
        knowledge_ids: Vec::new(),
        sources: vec![("platform".into(), source_id.clone())],
    };
    let stage = data_agent::use_cases::knowledge::search_stage_outside_lock(
        &pool,
        &ctx,
        &mut data_agent::use_cases::knowledge::ScopedSearchRequest {
            query: marker,
            limit: 1,
            launch: None,
            vector: data_agent::modules::retrieval::vector::Candidates::lexical(),
            scope: &scope,
            allowed: Some(&allowed),
            asset_after: None,
            hints: None,
            cid: "",
            text_results: &Default::default(),
            include_raw: true,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        stage.search.hits.len(),
        1,
        "尾部必须经正式组合入口回源，不能只证明已写索引"
    );
    let data_agent::use_cases::knowledge::SearchHit::SourceExcerpt { content, score, .. } =
        &stage.search.hits[0]
    else {
        panic!("平台原文不能伪装为知识命中");
    };
    assert!(*score > 0.);
    assert_eq!(
        content["citation"]["source"],
        json!({"kind":"platform","id":source_id})
    );
    assert_eq!(content["citation"]["revision"], "1");
    let offset = content["citation"]["locator"]["offset"].as_u64().unwrap() as usize;
    let length = content["citation"]["locator"]["length"].as_u64().unwrap() as usize;
    assert!(offset > 129000);
    assert!(length <= 2400);
    assert_eq!(content["source_length"], body.chars().count());
    assert_eq!(
        content["text"],
        body.chars().skip(offset).take(length).collect::<String>()
    );
    assert!(content["text"].as_str().unwrap().contains(marker));
    assert_eq!(content["semantic_status"], "pending");
    assert_eq!(content["content_state"], "complete");
    assert_eq!(content["support_state"], "unknown");
    let mut tx = AppTx::begin(&pool).await.unwrap();
    data_agent::use_cases::knowledge::assert_search_fresh_in_tx(&mut tx, &ctx, &stage)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    eprintln!(
        "raw_saved_consumer_tail segments={} first_target_segment={} source_chars={} offset={} length={}",
        segments.len(),
        marker_segments[0].0,
        body.chars().count(),
        offset,
        length
    );
    pool.close().await;
}

#[tokio::test]
async fn raw_stage_keeps_healthy_raw_bm25_without_adding_sql_knowledge_vote() {
    let Ok(url) = std::env::var("DATA_AGENT_DATABASE_URL") else {
        return;
    };
    assert!(url.contains("/data_agent_test_"));
    let pool = connect(&url).await.unwrap();
    let ctx = AccessContext {
        user_id: "alice".into(),
        space_id: "demo".into(),
        request_id: "raw-stage-healthy-bm25".into(),
        table_access: None,
    };
    let query = "rawstagerawhealthyneedle";
    let raw = indexed_platform_source(
        &pool,
        "raw-stage-healthy",
        &format!("{query}：已保存原文的条款，运费除外。"),
    )
    .await;
    let sql_only = data_agent::use_cases::knowledge::edit(&pool, &ctx, None, "create", json!({
        "operation_id":"raw-stage-sql-only-create","kind":"term","name":query,
        "body":format!("{query}：未索引的SQL知识强项，不可在已有BM25成功页时加票。"),"related_ids":[],"source_url":null
    })).await.unwrap();
    let scope = KnowledgeSearchScope::default();
    let allowed = data_agent::modules::retrieval::vector::AllowedRecords {
        knowledge_ids: vec![sql_only["id"].as_str().unwrap().to_owned()],
        sources: vec![("platform".into(), raw.id.clone())],
    };
    let stage = data_agent::use_cases::knowledge::search_stage_outside_lock(
        &pool,
        &ctx,
        &mut data_agent::use_cases::knowledge::ScopedSearchRequest {
            query,
            limit: 2,
            launch: None,
            vector: data_agent::modules::retrieval::vector::Candidates::lexical(),
            scope: &scope,
            allowed: Some(&allowed),
            asset_after: None,
            hints: None,
            cid: "",
            text_results: &Default::default(),
            include_raw: true,
        },
    )
    .await
    .unwrap();
    assert!(
        stage.search.objects.is_empty(),
        "raw BM25已有成功页时，knowledge整路失败不能另启SQL知识票"
    );
    assert_eq!(stage.search.hits.len(), 1);
    let data_agent::use_cases::knowledge::SearchHit::SourceExcerpt { content, .. } =
        &stage.search.hits[0]
    else {
        panic!("健康raw通道正文必须保留");
    };
    assert!(content["text"].as_str().unwrap().contains(query));
    assert_eq!(content["citation"]["source"]["id"], raw.id.as_str());
    assert_eq!(
        stage.search.coverage["candidate_count"], 1,
        "未索引SQL强项不得进入共同候选计数"
    );
    let mut tx = AppTx::begin(&pool).await.unwrap();
    data_agent::use_cases::knowledge::assert_search_fresh_in_tx(&mut tx, &ctx, &stage)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    pool.close().await;
}

#[tokio::test]
async fn raw_stage_launches_dense_for_raw_only_allowed_sources() {
    let Ok(url) = std::env::var("DATA_AGENT_DATABASE_URL") else {
        return;
    };
    assert!(url.contains("/data_agent_test_"));
    assert!(
        std::env::var("DATA_AGENT_VECTOR_COLLECTION")
            .unwrap_or_default()
            .starts_with("data_agent_test_")
    );
    let pool = connect(&url).await.unwrap();
    let ctx = AccessContext {
        user_id: "alice".into(),
        space_id: "demo".into(),
        request_id: "raw-stage-only-dense".into(),
        table_access: None,
    };
    let query = "rawstageonlydenseprobe";
    let body = "合成校准规定：设备校验完成之前不得投入使用。";
    assert!(
        body.chars().all(|ch| !query.contains(ch)),
        "查询与原文无字面交集，只能由可控dense向量命中"
    );
    let raw = indexed_platform_source(&pool, "raw-stage-only-dense", body).await;
    let scope = KnowledgeSearchScope::default();
    let allowed = data_agent::modules::retrieval::vector::AllowedRecords {
        knowledge_ids: Vec::new(),
        sources: vec![("platform".into(), raw.id.clone())],
    };
    let deadline = data_agent::modules::retrieval::vector::retrieval_deadline();
    let launch = data_agent::use_cases::launch_search_embedding(
        &pool,
        &ctx,
        query,
        None,
        true,
        Some(&allowed),
        deadline,
    )
    .await;
    let mut vector = data_agent::modules::retrieval::vector::Candidates::lexical();
    vector.deadline = deadline;
    let checked = Default::default();
    let mut request = data_agent::use_cases::knowledge::ScopedSearchRequest {
        query,
        limit: 1,
        launch,
        vector,
        scope: &scope,
        allowed: Some(&allowed),
        asset_after: None,
        hints: None,
        cid: "",
        text_results: &checked,
        include_raw: true,
    };
    let stage =
        data_agent::use_cases::knowledge::search_stage_outside_lock(&pool, &ctx, &mut request)
            .await
            .unwrap();
    assert_eq!(
        stage.search.hits.len(),
        1,
        "知识允许集为空但原文可读时，原launch仍须驱动dense并交付原文"
    );
    assert!(stage.search.objects.is_empty());
    let data_agent::use_cases::knowledge::SearchHit::SourceExcerpt { content, score, .. } =
        &stage.search.hits[0]
    else {
        panic!("raw-only dense不能伪装为知识对象");
    };
    assert!(*score > 0.);
    assert_eq!(content["text"], body);
    assert_eq!(
        content["citation"]["source"],
        json!({"kind":"platform","id":raw.id})
    );
    assert_eq!(content["citation"]["revision"], "1");
    assert_eq!(content["citation"]["locator"]["offset"], 0);
    assert_eq!(
        content["citation"]["locator"]["length"],
        body.chars().count()
    );
    assert_eq!(stage.search.coverage["candidate_count"], 1);
    let mut tx = AppTx::begin(&pool).await.unwrap();
    data_agent::use_cases::knowledge::assert_search_fresh_in_tx(&mut tx, &ctx, &stage)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    eprintln!(
        "raw_only_dense hits=1 candidates=1 source={} chars={}",
        raw.id,
        body.chars().count()
    );
    pool.close().await;
}

#[tokio::test]
async fn raw_stage_filters_old_segmentation_before_candidates_and_owner_reads() {
    let Ok(url) = std::env::var("DATA_AGENT_DATABASE_URL") else {
        return;
    };
    assert!(url.contains("/data_agent_test_"));
    assert!(
        std::env::var("DATA_AGENT_VECTOR_COLLECTION")
            .unwrap_or_default()
            .starts_with("data_agent_test_")
    );
    let pool = connect(&url).await.unwrap();
    let ctx = AccessContext {
        user_id: "alice".into(),
        space_id: "demo".into(),
        request_id: "raw-segmentation-version".into(),
        table_access: None,
    };
    let query = "rawversionneedle";
    let body = "rawversionneedle 合成版本规则：设备完成复核后方可使用。";
    let saved = indexed_platform_source(&pool, "raw-segmentation-version", body).await;
    let allowed = data_agent::modules::retrieval::vector::AllowedRecords {
        knowledge_ids: vec![],
        sources: vec![("platform".into(), saved.id.clone())],
    };
    let scope = KnowledgeSearchScope::default();
    let deadline = retrieval_deadline();
    let launch = data_agent::use_cases::launch_search_embedding(
        &pool,
        &ctx,
        query,
        None,
        true,
        Some(&allowed),
        deadline,
    )
    .await;
    let mut vector = data_agent::modules::retrieval::vector::Candidates::lexical();
    vector.deadline = deadline;
    let checked = Default::default();
    let mut request = data_agent::use_cases::knowledge::ScopedSearchRequest {
        query,
        limit: 3,
        launch,
        vector,
        scope: &scope,
        allowed: Some(&allowed),
        asset_after: None,
        hints: None,
        cid: "",
        text_results: &checked,
        include_raw: true,
    };
    let stage =
        data_agent::use_cases::knowledge::search_stage_outside_lock(&pool, &ctx, &mut request)
            .await
            .unwrap();
    for channel in [&request.vector.raw.lexical, &request.vector.raw.dense] {
        assert_eq!(
            channel.len(),
            1,
            "旧切块版本和缺版本的索引行必须在各路召回前排除"
        );
        assert_eq!(
            channel[0]["segmentation_version"], "source-structure-1",
            "不能以当前常量补造缺失表示身份"
        );
    }
    assert_eq!(stage.search.coverage["candidate_count"], 1);
    assert_eq!(stage.search.scan_progress["main_reads"], 1);
    assert_eq!(stage.search.hits.len(), 1);
    let data_agent::use_cases::knowledge::SearchHit::SourceExcerpt { content, .. } =
        &stage.search.hits[0]
    else {
        panic!("raw-only仅交付原文");
    };
    assert_eq!(content["text"], body);
    assert_eq!(content["citation"]["source"]["id"], saved.id.as_str());
    let mut tx = AppTx::begin(&pool).await.unwrap();
    data_agent::use_cases::knowledge::assert_search_fresh_in_tx(&mut tx, &ctx, &stage)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    pool.close().await;
}

#[tokio::test]
async fn raw_stage_reports_projection_lag_for_actual_allowed_sources() {
    let Ok(url) = std::env::var("DATA_AGENT_DATABASE_URL") else {
        return;
    };
    assert!(url.contains("/data_agent_test_"));
    assert!(
        std::env::var("DATA_AGENT_VECTOR_COLLECTION")
            .unwrap_or_default()
            .starts_with("data_agent_test_")
    );
    let pool = connect(&url).await.unwrap();
    let ctx = AccessContext {
        user_id: "alice".into(),
        space_id: "demo".into(),
        request_id: "raw-scope-coverage".into(),
        table_access: None,
    };
    // A已索引，B只登记未索引：范围内有待索引原文时必须如实报告。
    let a = indexed_platform_source(
        &pool,
        "raw-coverage-a",
        "rawcoveragealpha 合成设备复核规则。",
    )
    .await
    .id;
    let b = saved_platform_source(
        &pool,
        "raw-coverage-b",
        "rawcoveragebeta 合成独立运输规则。",
    )
    .await
    .id;
    let inspect = |ids: Vec<String>, include_raw, query: &'static str| {
        let pool = pool.clone();
        let ctx = ctx.clone();
        async move {
            let allowed = data_agent::modules::retrieval::vector::AllowedRecords {
                knowledge_ids: vec![],
                sources: ids.into_iter().map(|id| ("platform".into(), id)).collect(),
            };
            let scope = KnowledgeSearchScope::default();
            data_agent::use_cases::knowledge::search_stage_outside_lock(
                &pool,
                &ctx,
                &mut data_agent::use_cases::knowledge::ScopedSearchRequest {
                    query,
                    limit: 1,
                    launch: None,
                    vector: data_agent::modules::retrieval::vector::Candidates::lexical(),
                    scope: &scope,
                    allowed: Some(&allowed),
                    asset_after: None,
                    hints: None,
                    cid: "",
                    text_results: &Default::default(),
                    include_raw,
                },
            )
            .await
            .unwrap()
        }
    };
    let only_a = inspect(vec![a.clone()], true, "rawcoveragealpha").await;
    assert_eq!(only_a.search.hits.len(), 1);
    assert_eq!(
        only_a.search.coverage["index_state"], "current",
        "范围外B待索引不影响仅A范围"
    );
    let both = inspect(vec![a.clone(), b.clone()], true, "rawcoveragealpha").await;
    assert_eq!(both.search.hits.len(), 1);
    assert_eq!(
        both.search.coverage["index_state"], "incomplete",
        "范围含B时不能因主题仅问A而忽略B待索引"
    );
    let missing = inspect(vec![b.clone()], true, "rawcoveragenomatch").await;
    assert!(missing.search.hits.is_empty());
    assert_eq!(
        missing.search.coverage["index_state"], "incomplete",
        "零候选仍须如实报告范围内未索引原文"
    );
    let v1 = inspect(vec![a.clone(), b.clone()], false, "rawcoveragealpha").await;
    assert_eq!(
        v1.search.coverage["index_state"], "current",
        "v1不召回raw，不混入raw待办"
    );
    while data_agent::use_cases::knowledge::process_index(&pool)
        .await
        .unwrap()
    {}
    assert_eq!(
        inspect(vec![b.clone()], true, "rawcoveragebeta")
            .await
            .search
            .coverage["index_state"],
        "current"
    );
    for (column, invalid) in [
        ("collection_target", "'synthetic-old-target'"),
        ("embedding_model", "'synthetic-old-model'"),
        ("segmentation_version", "0"),
        ("complete", "0"),
    ] {
        // 仅隔离夹具的投影标量失配；真实集合和正式内容保持不动。
        let previous: String = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "SELECT CAST({column} AS CHAR) FROM retrieval_source_projections WHERE source_kind='platform' AND source_id=?"
        ))).bind(&b).fetch_one(&pool).await.unwrap();
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "UPDATE retrieval_source_projections SET {column}={invalid} WHERE source_kind='platform' AND source_id=?"
        ))).bind(&b).execute(&pool).await.unwrap();
        assert_eq!(
            inspect(vec![a.clone(), b.clone()], true, "rawcoveragealpha")
                .await
                .search
                .coverage["index_state"],
            "incomplete",
            "覆盖必须绑定当前{column}"
        );
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "UPDATE retrieval_source_projections SET {column}=? WHERE source_kind='platform' AND source_id=?"
        ))).bind(previous).bind(&b).execute(&pool).await.unwrap();
    }
    revise_platform_source(&pool, &b, 2, "rawcoveragebeta 合成运输规则已修订。").await;
    let revised = inspect(vec![b], true, "rawcoveragebeta").await;
    assert!(revised.search.hits.is_empty(), "旧修订索引不能交付");
    assert_eq!(
        revised.search.coverage["index_state"], "incomplete",
        "旧修订complete不能冒充当前修订覆盖"
    );
    eprintln!(
        "raw_coverage actual_scope_and_zero_candidates_and_target_model_segmentation_revision_checked"
    );
    pool.close().await;
}

#[tokio::test]
async fn raw_stage_merges_selected_overlapping_windows_without_refunding_identity() {
    let Ok(url) = std::env::var("DATA_AGENT_DATABASE_URL") else {
        return;
    };
    assert!(url.contains("/data_agent_test_"));
    assert!(
        std::env::var("DATA_AGENT_VECTOR_COLLECTION")
            .unwrap_or_default()
            .starts_with("data_agent_test_")
    );
    let pool = connect(&url).await.unwrap();
    let ctx = AccessContext {
        user_id: "alice".into(),
        space_id: "demo".into(),
        request_id: "raw-overlap-stage".into(),
        table_access: None,
    };
    let marker = "rawoverlapneedle";
    // 1200处的段落边界生成两个相交规范窗口，合并后的2000字符在既定2400上限内。
    // 结尾句号让Sql切块回退到段落结构；纯标识符正文只会按语句末尾切成一块。
    let body = format!(
        "{}{}{}\n\n{}。",
        "甲".repeat(1100),
        marker,
        "甲".repeat(1198 - 1100 - marker.len()),
        "乙".repeat(799)
    );
    let key = indexed_platform_source(&pool, "raw-overlap", &body).await;
    let source_id = key.id.clone();
    let parts = segment_source(
        &SourceText {
            source: &key,
            revision: "1",
            text: &body,
            format: SourceFormat::Sql,
            background: &[],
        },
        None,
    )
    .unwrap();
    assert_eq!(parts.segments.len(), 2);
    assert!(
        parts
            .segments
            .iter()
            .all(|segment| segment.text.contains(marker))
    );
    assert!(
        parts.segments[0].citation.locator.offset + parts.segments[0].citation.locator.length
            > parts.segments[1].citation.locator.offset
    );
    let allowed = data_agent::modules::retrieval::vector::AllowedRecords {
        knowledge_ids: vec![],
        sources: vec![("platform".into(), source_id.clone())],
    };
    let scope = KnowledgeSearchScope::default();
    let stage = data_agent::use_cases::knowledge::search_stage_outside_lock(
        &pool,
        &ctx,
        &mut data_agent::use_cases::knowledge::ScopedSearchRequest {
            query: marker,
            limit: 2,
            launch: None,
            vector: data_agent::modules::retrieval::vector::Candidates::lexical(),
            scope: &scope,
            allowed: Some(&allowed),
            asset_after: None,
            hints: None,
            cid: "",
            text_results: &Default::default(),
            include_raw: true,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        stage.search.coverage["candidate_count"], 2,
        "交付合并不退还已消费规范身份"
    );
    assert_eq!(
        stage.search.scan_progress["main_reads"], 2,
        "两个规范窗口均实际占读取名额"
    );
    assert_eq!(
        stage.search.hits.len(),
        1,
        "正式stage也须合并已选相交窗口，不能只在helper测试合并"
    );
    let data_agent::use_cases::knowledge::SearchHit::SourceExcerpt { content, score, .. } =
        &stage.search.hits[0]
    else {
        panic!("原文保持raw身份");
    };
    assert_eq!(content["text"], body);
    assert_eq!(
        content["citation"]["locator"],
        json!({"offset":0,"length":2000})
    );
    assert_eq!(content["source_length"], 2000);
    assert_eq!(content["semantic_status"], "pending");
    assert_eq!(content["content_state"], "complete");
    assert_eq!(content["support_state"], "unknown");
    assert!(
        (*score - 1. / 60.).abs() < 1e-12,
        "合并取已融合分数的最大值，不再投票"
    );
    assert!(
        stage.search.pending.is_empty(),
        "已交付的两个窗口不能被误报为pending"
    );
    let mut tx = AppTx::begin(&pool).await.unwrap();
    data_agent::use_cases::knowledge::assert_search_fresh_in_tx(&mut tx, &ctx, &stage)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    pool.close().await;
}

#[tokio::test]
async fn raw_stage_preserves_a_high_knowledge_b_middle_a_low_and_v1_kind_scope() {
    let Ok(url) = std::env::var("DATA_AGENT_DATABASE_URL") else {
        return;
    };
    assert!(url.contains("/data_agent_test_"));
    assert!(
        std::env::var("DATA_AGENT_VECTOR_COLLECTION")
            .unwrap_or_default()
            .starts_with("data_agent_test_")
    );
    let pool = connect(&url).await.unwrap();
    let ctx = AccessContext {
        user_id: "alice".into(),
        space_id: "demo".into(),
        request_id: "raw-stage-order".into(),
        table_access: None,
    };
    let marker = "rawstageorderneedle";
    let high = format!("{marker} ").repeat(20);
    let body_a = format!(
        "{}{}{marker}：运费除外。{}",
        high,
        "甲".repeat(6800 - high.chars().count()),
        "乙".repeat(400)
    );
    let medium = format!("{marker} ");
    let body_b = format!("{}{}", medium, "丙".repeat(300 - medium.chars().count()));
    let term = data_agent::use_cases::knowledge::edit(
        &pool,
        &ctx,
        None,
        "create",
        json!({
            "operation_id":"raw-stage-order-1","kind":"term","name":"合成中间条款",
            "body":body_b,"related_ids":[],"source_url":null
        }),
    )
    .await
    .unwrap();
    let id_b = term["id"].as_str().unwrap().to_owned();
    let key_a = saved_platform_source(&pool, "raw-stage-order-a", &body_a).await;
    let id_a = key_a.id.clone();
    let parts = segment_source(
        &SourceText {
            source: &key_a,
            revision: "1",
            text: &body_a,
            format: SourceFormat::Sql,
            background: &[],
        },
        None,
    )
    .unwrap();
    assert_eq!(
        parts
            .segments
            .iter()
            .filter(|segment| segment.text.contains(marker))
            .count(),
        2,
        "A的规则和例外必须恰为两个不相交的规范位置"
    );
    while data_agent::use_cases::knowledge::process_index(&pool)
        .await
        .unwrap()
    {}
    let scope = KnowledgeSearchScope::default();
    let allowed = data_agent::modules::retrieval::vector::AllowedRecords {
        knowledge_ids: vec![id_b.clone()],
        sources: vec![("platform".into(), id_a.clone())],
    };
    let mut request = data_agent::use_cases::knowledge::ScopedSearchRequest {
        query: marker,
        limit: 3,
        launch: None,
        vector: data_agent::modules::retrieval::vector::Candidates::lexical(),
        scope: &scope,
        allowed: Some(&allowed),
        asset_after: None,
        hints: None,
        cid: "",
        text_results: &Default::default(),
        include_raw: true,
    };
    let stage =
        data_agent::use_cases::knowledge::search_stage_outside_lock(&pool, &ctx, &mut request)
            .await
            .unwrap();
    assert_eq!(
        stage.search.hits.len(),
        3,
        "共同限额内须保留A规则、B知识、A例外"
    );
    let hits = &stage.search.hits;
    let raw_scores = request
        .vector
        .raw
        .lexical
        .iter()
        .map(|row| row["distance"].as_f64().unwrap())
        .collect::<Vec<_>>();
    let knowledge_score = request.vector.lexical[0]["matches"][0]["score"]
        .as_f64()
        .unwrap();
    assert!(
        raw_scores.len() == 2 && raw_scores[0] > knowledge_score && knowledge_score > raw_scores[1],
        "夹具须先满足实际BM25 A高/B中/A低，不能仅按词频猜排序：raw={raw_scores:?}, knowledge={knowledge_score}"
    );
    eprintln!(
        "raw_mixed_ranking knowledge={} raw={} sequence={}",
        json!(request.vector.lexical),
        json!(request.vector.raw.lexical),
        json!(
            hits.iter()
                .map(|hit| match hit {
                    data_agent::use_cases::knowledge::SearchHit::Knowledge {
                        record,
                        score,
                        ..
                    } => json!([record, score]),
                    data_agent::use_cases::knowledge::SearchHit::SourceExcerpt {
                        records,
                        score,
                        ..
                    } => json!([records, score]),
                })
                .collect::<Vec<_>>()
        )
    );
    let data_agent::use_cases::knowledge::SearchHit::SourceExcerpt {
        content: first,
        score: high_score,
        ..
    } = &hits[0]
    else {
        panic!("最高相关的A原文必须排第一");
    };
    let data_agent::use_cases::knowledge::SearchHit::Knowledge {
        content: middle,
        score: middle_score,
        ..
    } = &hits[1]
    else {
        panic!("B知识必须排在A两个位置之间");
    };
    let data_agent::use_cases::knowledge::SearchHit::SourceExcerpt {
        content: last,
        score: low_score,
        ..
    } = &hits[2]
    else {
        panic!("A例外不能因为同来源已交付而被抹掉");
    };
    assert_eq!(first["citation"]["source"]["id"], id_a);
    assert_eq!(middle["id"], id_b);
    assert_eq!(last["citation"]["source"]["id"], id_a);
    assert_eq!(first["citation"]["locator"]["offset"], 0);
    assert!(last["citation"]["locator"]["offset"].as_u64().unwrap() > 4000);
    assert!(last["text"].as_str().unwrap().contains("运费除外"));
    for (actual, rank) in [(*high_score, 60.), (*middle_score, 61.), (*low_score, 62.)] {
        assert!(
            (actual - 1. / rank).abs() < 1e-12,
            "一次BM25名次只给一张RRF票"
        );
    }
    let mut tx = AppTx::begin(&pool).await.unwrap();
    data_agent::use_cases::knowledge::assert_search_fresh_in_tx(&mut tx, &ctx, &stage)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    request.limit = 1;
    request.vector = data_agent::modules::retrieval::vector::Candidates::lexical();
    let raw_first =
        data_agent::use_cases::knowledge::search_stage_outside_lock(&pool, &ctx, &mut request)
            .await
            .unwrap();
    assert!(matches!(
        &raw_first.search.hits[..],
        [data_agent::use_cases::knowledge::SearchHit::SourceExcerpt { .. }]
    ));
    assert!(
        raw_first.search.objects.is_empty(),
        "内部raw第一时不能另发一份知识类型配额"
    );
    let mut tx = AppTx::begin(&pool).await.unwrap();
    data_agent::use_cases::knowledge::assert_search_fresh_in_tx(&mut tx, &ctx, &raw_first)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    request.include_raw = false;
    request.vector = data_agent::modules::retrieval::vector::Candidates::lexical();
    let v1 = data_agent::use_cases::knowledge::search_stage_outside_lock(&pool, &ctx, &mut request)
        .await
        .unwrap();
    assert!(matches!(
        &v1.search.hits[..],
        [data_agent::use_cases::knowledge::SearchHit::Knowledge { .. }]
    ));
    assert_eq!(
        v1.search.objects[0]["id"], id_b,
        "v1在候选与名额前排除raw后仍返回第二相关的知识"
    );
    assert_eq!(
        v1.search.coverage["candidate_count"], 1,
        "v1只计B知识的命中窗口，raw不进入候选额度"
    );
    assert!(request.vector.cursors.raw_lexical.is_none());
    assert!(request.vector.cursors.raw_dense.is_none());
    let mut tx = AppTx::begin(&pool).await.unwrap();
    data_agent::use_cases::knowledge::assert_search_fresh_in_tx(&mut tx, &ctx, &v1)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    eprintln!(
        "raw_knowledge_global_order scores={high_score},{middle_score},{low_score} raw_high_offset=0 raw_low_offset={} v1_candidates=1",
        last["citation"]["locator"]["offset"]
    );
    pool.close().await;
}

// 门控集成：隔离库+专用测试集合（data_agent_test_前缀，防误写共享集合）才
// 执行；缺环境时跳过，不冒充通过。链路=确定性切块→摘录写入→双通道召回→
// 门控回源→升版滞后（05切片3的局部集成证明；嵌入协议由共享嵌入检查覆盖，
// 此处用替身向量）。
#[tokio::test]
async fn gated_raw_source_round_trip_recalls_revision_and_reports_lag() {
    let Ok(url) = std::env::var("DATA_AGENT_DATABASE_URL") else {
        return;
    };
    let dedicated = std::env::var("DATA_AGENT_VECTOR_COLLECTION")
        .unwrap_or_default()
        .starts_with("data_agent_test_")
        || std::env::var("DATA_AGENT_VECTOR_COLLECTION")
            .unwrap_or_default()
            .starts_with("da_app_");
    if std::env::var("DATA_AGENT_VECTOR_URL").is_err()
        || std::env::var("DATA_AGENT_VECTOR_TOKEN_FILE").is_err()
        || !dedicated
    {
        return;
    }
    let pool = connect(&url).await.unwrap();
    let ctx = AccessContext {
        user_id: "raw-recall-check".into(),
        space_id: "demo".into(),
        request_id: "raw-recall-round-trip".into(),
        table_access: None,
    };
    let source_id = "raw-recall-it";
    let body = format!(
        "{}未付款订单不产生退款，首次申请免费处理。{}最终解释以协议为准，运费除外。{}",
        "背景说明。".repeat(240),
        "补充条款。".repeat(240),
        "尾部备注。".repeat(240)
    );
    // 夹具SQL经连接池自动提交；AppTx的底层连接是crate私有，外部测试按公共入口组装。
    for statement in [
        "DELETE FROM source_current WHERE source_id='raw-recall-it'",
        "DELETE FROM source_heads WHERE id='raw-recall-it'",
    ] {
        sqlx::query(statement).execute(&pool).await.unwrap();
    }
    sqlx::query("INSERT INTO source_heads(id,space_id,version,fingerprint) VALUES(?,?,1,'fp')")
        .bind(source_id)
        .bind(&ctx.space_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO source_current(source_id,space_id,adapter_id,source_kind,namespace,\
             external_id,revision,body,complete,metadata,content_fingerprint,\
             explanation_fingerprint,comparison_method,parsed,observed_metadata) \
             VALUES(?,?,?,?,?,?,1,?,TRUE,'{}','fp','fp','exact',TRUE,'{}')",
    )
    .bind(source_id)
    .bind(&ctx.space_id)
    .bind("adapter")
    .bind("platform")
    .bind("ns")
    .bind(source_id)
    .bind(&body)
    .execute(&pool)
    .await
    .unwrap();
    drop_source_excerpts(&ctx.space_id, "platform", source_id, 2)
        .await
        .unwrap();

    let key = SourceKey {
        kind: SourceKeyKind::Platform,
        id: source_id.into(),
    };
    let revision_text = "1".to_string();
    let text_source = SourceText {
        source: &key,
        revision: &revision_text,
        text: &body,
        format: SourceFormat::Sql,
        background: &[],
    };
    let mut segments = Vec::new();
    let mut cursor = None;
    loop {
        let batch = segment_source(&text_source, cursor.as_ref()).unwrap();
        if batch.segments.is_empty() {
            break;
        }
        segments.extend(batch.segments.iter().cloned());
        cursor = batch.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    assert!(
        segments.len() >= 3,
        "长文应切出多段，实测{}",
        segments.len()
    );
    let dim = SPEC.dimension;
    apply_source_excerpts(&ctx.space_id, &segments, |_, texts| async move {
        Ok::<_, data_agent::types::Error>(
            texts.iter().map(|_| vec![0.01f32; dim]).collect::<Vec<_>>(),
        )
    })
    .await
    .unwrap();

    let candidates = search_scoped(ScopedQuery {
        space: &ctx.space_id,
        query: "未付款订单首次申请免费处理",
        vector: Some(vec![0.02f32; dim]),
        scope: &KnowledgeSearchScope::default(),
        limit: 10,
        allowed: None,
        include_raw: true,
        deadline: retrieval_deadline(),
    })
    .await
    .unwrap();
    assert_eq!(candidates.raw.state, "available");
    assert!(
        !candidates.raw.lexical.is_empty(),
        "raw词法通道必须可召回：{:?}",
        candidates.raw.lexical
    );
    // 共同排序（内部双类型）：raw与知识进同一名次表，一次RRF后同record取最佳
    // 片段。本隔离库无知识对象，名次表即raw选择结果，供回源。
    let fused = rank_common(
        "未付款订单首次申请免费处理",
        vec![],
        &Channels::all(
            &candidates.lexical,
            &candidates.values,
            &candidates.raw.lexical,
            &candidates.raw.dense,
        ),
        10,
        true,
    );
    // 同集合可能混有其他来源的摘录（E2E里是数千条目录正文）：只认本测试来源
    // 的命中做回环断言；dense通道按伪向量近邻会召回无关来源，属预期。
    let mine: Vec<Value> = fused
        .raw
        .iter()
        .filter(|hit| hit["source_id"] == source_id)
        .cloned()
        .collect();
    assert!(!mine.is_empty(), "BM25通道必须召回本来源：{:?}", fused.raw);
    for hit in &mine {
        assert_eq!(hit["source_kind"], "platform");
        assert_eq!(hit["revision"].as_u64(), Some(1));
    }

    let mut tx = AppTx::begin(&pool).await.unwrap();
    let recall = recall_excerpts_in_tx(&mut tx, &ctx, None, &mine)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(recall["state"], "located", "recall={recall}");
    assert_eq!(recall["lagged"], 0);
    let total = body.chars().count();
    for hit in recall["hits"].as_array().unwrap() {
        let offset = hit["citation"]["locator"]["offset"].as_u64().unwrap() as usize;
        let length = hit["citation"]["locator"]["length"].as_u64().unwrap() as usize;
        assert!(length <= 2400, "合并窗口不得超过2400");
        assert!(offset + length <= total);
        assert_eq!(hit["citation"]["revision"], "1");
        let expect: String = body.chars().skip(offset).take(length).collect();
        assert_eq!(
            hit["text"].as_str().unwrap(),
            expect,
            "回读必须与当前正文切片一致"
        );
        assert_eq!(hit["source_length"].as_u64().unwrap() as usize, total);
    }

    // 门控：允许集不含该来源→只报过滤计数；不泄露受限名称，不读回源。
    let limits = json!({
        "allowed_sources":[{"kind":"platform","id":"other-source"}],
        "origin_message_ids":["m1"]
    });
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let gated = recall_excerpts_in_tx(&mut tx, &ctx, Some(&limits), &mine)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        gated["filtered"].as_u64().unwrap(),
        mine.len().min(30) as u64
    );
    assert_eq!(gated["hits"].as_array().unwrap().len(), 0);
    assert_eq!(gated["lagged"], 0);

    // 升版：旧修订命中不再回源成正文，按滞后如实报告。
    let body2 = format!(
        "{}已付款订单可以申请退款，运费除外。",
        "新版背景。".repeat(240)
    );
    sqlx::query("UPDATE source_heads SET version=2 WHERE id=?")
        .bind(source_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE source_current SET revision=2, body=? WHERE source_id=?")
        .bind(&body2)
        .bind(source_id)
        .execute(&pool)
        .await
        .unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let lagged_view = recall_excerpts_in_tx(&mut tx, &ctx, None, &mine)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(lagged_view["state"], "unlocated");
    assert_eq!(
        lagged_view["lagged"].as_u64().unwrap(),
        mine.len().min(30) as u64
    );

    // 清理：删行与摘录向量；专用集合本身由harness管理。
    for statement in [
        "DELETE FROM source_current WHERE source_id='raw-recall-it'",
        "DELETE FROM source_heads WHERE id='raw-recall-it'",
    ] {
        sqlx::query(statement).execute(&pool).await.unwrap();
    }
    drop_source_excerpts(&ctx.space_id, "platform", source_id, 3)
        .await
        .unwrap();
}

use super::*;
use crate::{
    modules::{assets, retrieval},
    search_scope::KnowledgeSearchScope,
};
use serde_json::json;
use sqlx::MySqlPool;

fn gate(kinds: &[(&str, &str)]) -> SourceGate {
    let limits = json!({"allowed_sources": kinds
            .iter()
            .map(|(kind, id)| json!({"kind": kind, "id": id}))
            .collect::<Vec<_>>(),
            "origin_message_ids": ["m1"]});
    gate_from_contract(&limits).expect("valid limits")
}

async fn database(space: &str) -> Option<(MySqlPool, AccessContext)> {
    let url = std::env::var("DATA_AGENT_DATABASE_URL").ok()?;
    assert!(url.contains("/data_agent_test_"));
    let pool = crate::persistence::connect(&url).await.unwrap();
    let ctx = AccessContext {
        user_id: "alice".into(),
        space_id: space.into(),
        request_id: "source-limit-tests".into(),
        table_access: None,
    };
    Some((pool, ctx))
}

#[test]
fn limits_match_only_direct_object_source_or_table() {
    let gate = gate(&[("document", "a"), ("platform", "p")]);
    assert!(gate.permits("document", "a", Some("another-source"), None));
    assert!(gate.permits("field", "f", Some("p"), None));
    assert!(gate.permits("field", "f", None, Some("p")));
    assert!(gate.permits("table", "p", None, None));
    assert!(
        !gate
            .allows_object(&json!({
                "id":"f","kind":"field","related_ids":["p"],"mapping_state":"unknown"
            }))
            .unwrap()
    );
}

#[tokio::test]
async fn synchronized_document_recalls_its_own_windows_without_upstream_access() {
    let Some((pool, ctx)) = database("demo").await else {
        return;
    };
    let source = "synchronized-document-upstream";
    let id = "synchronized-document";
    let query = "synchronizeddocumentneedle";
    let body = format!(
        "{} {query}：复核完成后才可计入。{}",
        "无关背景。".repeat(300),
        "未选附录。".repeat(300)
    );
    let object = json!({
        "id":id,"kind":"document","name":"合成同步文档","version":"1","state":"enabled",
        "source_id":source,"source_version":"1","related_ids":[],
        "entries":[{"entry_id":"body","path":"body","label":"正文","effective_value":body,
            "source_facts":{"source_id":source,"version":"1","value":body},"suggestion":{},"human_override":null}]
    });
    let mut tx = AppTx::begin(&pool).await.unwrap();
    knowledge::seed_in_tx(&mut tx, &ctx, &json!({"objects":[object]}))
        .await
        .unwrap();
    tx.commit().await.unwrap();
    super::super::knowledge::rebuild_index(
        &pool,
        &ctx,
        &json!({"operation_id":"index-synchronized-document"}),
    )
    .await
    .unwrap();
    while super::super::knowledge::process_index(&pool).await.unwrap() {}
    let scope = KnowledgeSearchScope::default();
    let permitted = gate(&[("document", id)]);
    let mut tx = AppTx::begin(&pool).await.unwrap();
    assert!(permitted.allows_object(&object).unwrap());
    assert!(
        !gate(&[("document", "outside-document")])
            .allows_object(&object)
            .unwrap()
    );
    let allowed = allowed_records_in_tx(&mut tx, &ctx, Some(&permitted), &scope)
        .await
        .unwrap();
    // 两个词法owner也必须保留这类文档；它不走独立文档的raw索引。
    let terms = vec![query.to_owned()];
    let current = knowledge::matching_content_in_tx(
        &mut tx,
        &ctx,
        query,
        &terms,
        &terms,
        &scope,
        Some(&allowed.knowledge_ids),
        10,
        0,
        true,
    )
    .await
    .unwrap();
    let indexed = retrieval::content_candidates_scoped_in_tx(
        &mut tx,
        &ctx.space_id,
        query,
        &terms,
        &terms,
        &scope,
        Some(&allowed.knowledge_ids),
        10,
        0,
        true,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    // 用已建索引的真实dense通道核对同一允许集；向量只测试可达性，不冒充语义质量。
    let dense = retrieval::vector::search_scoped(retrieval::vector::ScopedQuery {
        space: &ctx.space_id,
        query,
        vector: Some(vec![0.01; retrieval::embedding::SPEC.dimension]),
        scope: &scope,
        limit: 10,
        allowed: Some(&allowed),
        include_raw: true,
        deadline: retrieval::vector::retrieval_deadline(),
    })
    .await
    .unwrap();
    assert_eq!(dense.dense_state, "available");
    assert!(
        !dense.values.is_empty(),
        "真实dense过滤也须保留同步文档正文"
    );
    assert!(dense.values.iter().all(|hit| hit["id"] == id));
    let stage = super::super::knowledge::search_stage_outside_lock(
        &pool,
        &ctx,
        &mut super::super::knowledge::ScopedSearchRequest {
            query,
            limit: 10,
            launch: None,
            vector: retrieval::vector::Candidates::lexical(),
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
        !current.is_empty() && !indexed.is_empty() && !stage.search.hits.is_empty(),
        "同步文档正文须可由现有窗口召回：current={}, projection={}, hybrid={}",
        current.len(),
        indexed.len(),
        stage.search.hits.len()
    );
    assert!(
        allowed.sources.is_empty(),
        "许可文档不授权整个上游，也不虚报不存在的独立文档raw索引"
    );
    assert_eq!(stage.search.coverage["index_state"], "current");
    for hit in stage.search.hits {
        let super::super::knowledge::SearchHit::Knowledge { content, .. } = hit else {
            panic!("不得借上游原文交付");
        };
        assert_eq!(content["id"], id);
        let text = content["entries"][0]["effective_value"].as_str().unwrap();
        assert!(text.contains(query));
        assert!(text.chars().count() <= crate::types::KNOWLEDGE_WINDOW);
    }
    pool.close().await;
}

#[tokio::test]
async fn raw_allowed_records_include_readable_heads_without_task_gate() {
    let Some((pool, ctx)) = database("raw-allowed-scope").await else {
        return;
    };
    let mut tx = AppTx::begin(&pool).await.unwrap();
    const DOCUMENT: &str = "raw-allowed-document";
    const DISABLED: &str = "raw-allowed-disabled";
    const TABLE: &str = "raw-allowed-table";
    const FIELD: &str = "raw-allowed-field";
    const CURRENT: &str = "raw-allowed-current";
    let objects = [
        (DOCUMENT, "document", "enabled", None),
        (DISABLED, "document", "disabled", None),
        (TABLE, "table", "enabled", Some(CURRENT)),
        (FIELD, "field", "enabled", Some(CURRENT)),
    ]
    .map(|(id, kind, state, source_id)| {
        json!({
            "id":id, "kind":kind, "name":id, "version":"1", "state":state,
            "source_id":source_id, "source_version":if source_id.is_some() { "3" } else { "0" },
            "related_ids":[], "entries":[],
        })
    });
    knowledge::seed_in_tx(&mut tx, &ctx, &json!({"objects":objects}))
        .await
        .unwrap();
    let unscoped = KnowledgeSearchScope::default();
    let kind = |kind: &str| KnowledgeSearchScope {
        kinds: vec![kind.into()],
        ..Default::default()
    };
    let documents = kind("document");
    let table = KnowledgeSearchScope {
        anchor: Some(TABLE.into()),
        ..Default::default()
    };
    let field = kind("field");
    let doc = ("document", DOCUMENT);
    let current = ("platform", CURRENT);
    let legacy = ("platform", "raw-allowed-legacy");
    let old_current = ("platform", "raw-allowed-old-current");
    let active_ids = [DOCUMENT, FIELD, TABLE];
    let open_sources = [doc, current, legacy, old_current];
    let limited_sources = [doc, current, legacy];
    let restricted = gate(&[
        doc,
        current,
        legacy,
        ("platform", "raw-allowed-retired"),
        ("document", DISABLED),
    ]);
    for (scope, gate, ids, sources) in [
        (&unscoped, None, Some(&active_ids[..]), &open_sources[..]),
        (&documents, None, None, &[doc][..]),
        (&table, None, None, &[current][..]),
        // 字段引用不授整篇平台原文权限。
        (&field, None, Some(&[FIELD][..]), &[][..]),
        (&documents, Some(&restricted), None, &[doc][..]),
        (&unscoped, Some(&restricted), None, &limited_sources[..]),
    ] {
        let found = allowed_records_in_tx(&mut tx, &ctx, gate, scope)
            .await
            .unwrap();
        let actual = found
            .sources
            .iter()
            .map(|(kind, id)| (kind.as_str(), id.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(actual, sources, "{scope:?}, restricted={}", gate.is_some());
        if let Some(ids) = ids {
            assert_eq!(found.knowledge_ids, ids, "{scope:?}");
        }
    }
    tx.commit().await.unwrap();
    pool.close().await;
}

#[test]
fn source_arg_membership_strips_document_prefix() {
    let gate = gate(&[("document", "a"), ("platform", "business-guide")]);
    assert!(gate.allows_source_arg("document-a"));
    assert!(gate.allows_source_arg("business-guide"));
    assert!(!gate.allows_source_arg("document-b"));
    assert!(!gate.allows_source_arg("other"));
}

// 资产按自身声明的依赖核来源。同源保留，混合、范围外及无源资产拒绝。
#[tokio::test]
async fn asset_gate_judges_real_asset_sources() {
    let Some((pool, ctx)) = database("asset-gate-scope").await else {
        return;
    };
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let (inside, outside) = ("asset-gate-d", "asset-gate-e");
    let documents = [(inside, "允许文档正文"), (outside, "范围外文档正文")].map(|(id, body)| {
        json!({
            "id":id, "kind":"document", "name":id, "version":"1", "state":"enabled",
            "source_id":null, "source_version":"0", "related_ids":[],
            "entries":[{"path":"body", "effective_value":body}],
        })
    });
    knowledge::seed_in_tx(&mut tx, &ctx, &json!({"objects":documents}))
        .await
        .unwrap();
    let allowed = gate(&[("document", inside)]);
    let denied = gate(&[("document", outside)]);
    for (name, sources, expected) in [
        ("同源合成方法", &[inside][..], true),
        ("混合依赖合成方法", &[inside, outside][..], false),
        ("无来源人工方法", &[][..], false),
    ] {
        let dependencies = json!(
            sources
                .iter()
                .map(|id| json!({
                    "object_id":id, "version":"1", "path":"body",
                }))
                .collect::<Vec<_>>()
        );
        knowledge::check_refs_in_tx(&mut tx, &ctx, &dependencies)
            .await
            .unwrap();
        let asset = assets::save_authorized_in_tx(
            &mut tx,
            &ctx,
            &json!({
                "operation_id":format!("asset-gate-{name}"), "id":null, "expected_version":null,
                "kind":"skill", "name":name, "body":"合成方法正文。", "scope":"合成范围。",
                "source_text":"本人录入", "dependencies":dependencies, "verified":false,
            }),
            false,
        )
        .await
        .unwrap();
        assert_eq!(
            !super::super::knowledge::valid_assets_in_tx(
                &mut tx,
                &ctx,
                vec![asset.clone()],
                Some(&allowed)
            )
            .await
            .unwrap()
            .is_empty(),
            expected,
            "{name}"
        );
        if expected {
            assert!(
                super::super::knowledge::valid_assets_in_tx(
                    &mut tx,
                    &ctx,
                    vec![asset],
                    Some(&denied)
                )
                .await
                .unwrap()
                .is_empty(),
                "来源不在允许集时拒绝"
            );
        }
    }
    tx.commit().await.unwrap();
    pool.close().await;
}

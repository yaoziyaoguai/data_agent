use data_agent::{
    modules::retrieval::vector::{
        AllowedRecords, ScanChannel, ScopedQuery, fetch_page, prepare_cursors, retrieval_deadline,
        search_scoped,
    },
    search_scope::KnowledgeSearchScope,
};

#[tokio::test]
async fn partial_channel_failure_preserves_results_and_reports_bounded() {
    if std::env::var("DATA_AGENT_VECTOR_COLLECTION").as_deref() != Ok("synthetic_channel_coverage")
    {
        return;
    }
    let allowed = AllowedRecords {
        knowledge_ids: (0..201).map(|i| format!("object-{i:03}")).collect(),
        sources: vec![],
    };
    let result = search_scoped(ScopedQuery {
        space: "demo",
        query: "范围检索",
        vector: Some(vec![0.01; 1024]),
        scope: &KnowledgeSearchScope::default(),
        limit: 10,
        allowed: Some(&allowed),
        include_raw: false,
        deadline: retrieval_deadline(),
    })
    .await
    .unwrap();
    assert_eq!(result.state, "available");
    assert!(!result.values.is_empty(), "dense成功结果必须保留");
    assert!(!result.lexical.is_empty(), "BM25未失败分片的结果必须保留");
    assert!(result.bounded, "BM25只覆盖部分允许集，不得冒称完整覆盖");
    assert_eq!(result.lexical_state, "available");
    assert_eq!(result.lexical_progress.completed, 1);
    assert!(!result.lexical_progress.exhausted);

    // 同一页原语由组合用例推进；先词法后dense也保留partial事实。
    let deadline = retrieval_deadline();
    let scope = KnowledgeSearchScope::default();
    let mut result = prepare_cursors("demo", &scope, Some(&allowed), false, deadline);
    for channel in [ScanChannel::Lexical, ScanChannel::Dense] {
        if channel == ScanChannel::Dense {
            result.dense_vector = Some(vec![0.01; 1024]);
        }
        while let Some(page) = result.next_page(channel, "范围检索", 1, 10) {
            result
                .accept_page(fetch_page(page).await, Some(&allowed))
                .unwrap();
        }
    }
    assert_eq!(result.lexical_state, "available");
    assert!(!result.lexical.is_empty());
    assert_eq!(result.lexical_progress.completed, 1);
    assert!(!result.lexical_progress.exhausted);
    assert!(result.bounded);
}

#[tokio::test]
async fn healthy_shard_advances_after_another_shard_fails() {
    if std::env::var("DATA_AGENT_VECTOR_COLLECTION").as_deref() != Ok("synthetic_channel_coverage")
    {
        return;
    }
    let allowed = AllowedRecords {
        knowledge_ids: (0..201)
            .map(|i| format!("partial-{i:03}"))
            .chain(["partial-target".into()])
            .collect(),
        sources: vec![],
    };
    let deadline = retrieval_deadline();
    let scope = KnowledgeSearchScope::default();
    let mut candidates = prepare_cursors("demo", &scope, Some(&allowed), false, deadline);
    while let Some(page) = candidates.next_page(ScanChannel::Lexical, "后页专用", 1, 1) {
        candidates
            .accept_page(fetch_page(page).await, Some(&allowed))
            .unwrap();
    }
    assert_eq!(candidates.lexical_state, "available");
    assert_eq!(candidates.lexical_progress.completed, 1);
    assert!(
        !candidates
            .lexical
            .iter()
            .any(|row| row["id"] == "partial-target")
    );
    let page = candidates
        .next_page(ScanChannel::Lexical, "后页专用", 2, 1)
        .expect("另一片失败不能阻止健康满页片继续");
    candidates
        .accept_page(fetch_page(page).await, Some(&allowed))
        .unwrap();
    assert!(
        candidates
            .lexical
            .iter()
            .any(|row| row["id"] == "partial-target"),
        "offset=50的健康片目标必须进入同一通道"
    );
    assert_eq!(
        candidates.lexical_state, "available",
        "partial仍用成功BM25，不改为SQL"
    );
    assert_eq!(candidates.lexical_progress.rounds, 2);
    assert_eq!(candidates.lexical_progress.completed, 1);
    assert!(!candidates.lexical_progress.exhausted);
}

#[tokio::test]
async fn successful_first_page_remains_available_after_later_page_fails() {
    if std::env::var("DATA_AGENT_VECTOR_COLLECTION").as_deref() != Ok("synthetic_channel_coverage")
    {
        return;
    }
    let allowed = AllowedRecords {
        knowledge_ids: vec!["later-failed".into()],
        sources: vec![],
    };
    let scope = KnowledgeSearchScope::default();
    let mut candidates =
        prepare_cursors("demo", &scope, Some(&allowed), false, retrieval_deadline());
    let first = candidates
        .next_page(ScanChannel::Lexical, "后页失败", 1, 1)
        .unwrap();
    candidates
        .accept_page(fetch_page(first).await, Some(&allowed))
        .unwrap();
    let later = candidates
        .next_page(ScanChannel::Lexical, "后页失败", 2, 1)
        .unwrap();
    assert_eq!(later.offset, 50);
    candidates
        .accept_page(fetch_page(later).await, Some(&allowed))
        .unwrap();
    assert_eq!(candidates.lexical.len(), 50, "已经成功接收的首批内容保留");
    assert_eq!(
        candidates.lexical_state, "available",
        "已有成功页时不能改成全路不可用并加SQL票"
    );
    assert_eq!(candidates.lexical_progress.completed, 1);
    assert!(!candidates.lexical_progress.exhausted);
    assert!(candidates.bounded);
}

#[tokio::test]
async fn statement_locator_preserves_explicit_offset_without_identity() {
    if std::env::var("DATA_AGENT_VECTOR_COLLECTION").as_deref() != Ok("synthetic_channel_coverage")
    {
        return;
    }
    let allowed = AllowedRecords {
        knowledge_ids: vec!["statement-locator".into()],
        sources: vec![],
    };
    let scope = KnowledgeSearchScope::default();
    let mut candidates =
        prepare_cursors("demo", &scope, Some(&allowed), false, retrieval_deadline());
    let page = candidates
        .next_page(ScanChannel::Lexical, "陈述定位", 1, 3)
        .unwrap();
    candidates
        .accept_page(fetch_page(page).await, Some(&allowed))
        .unwrap();
    assert_eq!(candidates.lexical_state, "available");
    assert_eq!(candidates.lexical.len(), 3);
    let location = |record| {
        candidates
            .lexical
            .iter()
            .find(|row| row["record_id"] == record)
            .unwrap()["matches"][0]
            .clone()
    };
    let missing = location("missing-statement-id");
    assert!(missing["statement_id"].is_null());
    assert_eq!(missing["statement_offset"], 17, "缺身份不能丢掉原显式坐标");
    let selected = location("selected-statement");
    assert_eq!(selected["statement_id"], "selected-rule");
    assert_eq!(selected["statement_offset"], 0);
    let plain = location("plain-entry");
    assert!(plain["statement_id"].is_null());
    assert!(
        plain["statement_offset"].is_null(),
        "普通entry的空标记不携非适用局部坐标"
    );
    assert_eq!(plain["offset"], 80, "普通entry的合法展示子窗口保原坐标");
}

#[tokio::test]
async fn fully_covered_channels_report_not_bounded() {
    if std::env::var("DATA_AGENT_VECTOR_COLLECTION").as_deref() != Ok("synthetic_channel_coverage")
    {
        return;
    }
    let allowed = AllowedRecords {
        knowledge_ids: vec!["all-success-object".into()],
        sources: vec![],
    };
    let scope = KnowledgeSearchScope::default();
    let deadline = retrieval_deadline();
    let mut result = prepare_cursors("demo", &scope, Some(&allowed), false, deadline);
    for channel in [ScanChannel::Lexical, ScanChannel::Dense] {
        if channel == ScanChannel::Dense {
            result.dense_vector = Some(vec![0.01; 1024]);
        }
        while let Some(page) = result.next_page(channel, "全成功检索", 1, 10) {
            result
                .accept_page(fetch_page(page).await, Some(&allowed))
                .unwrap();
        }
    }
    // R12/R14正例：两通道单页不满即真实穷尽、全成功，bounded只能来自实际执行
    // 通道的限制，不得在无失败、无截词参与时虚构。
    assert_eq!(result.state, "available");
    assert_eq!(result.lexical_state, "available");
    assert!(!result.lexical.is_empty());
    assert!(!result.values.is_empty(), "dense成功结果必须保留");
    assert_eq!(
        result.lexical_progress.rounds, 1,
        "未满页的通道已见底，不空转扩轮"
    );
    assert!(result.lexical_progress.exhausted, "末轮未满页即该通道穷尽");
    assert!(result.dense_progress.exhausted);
    assert!(!result.bounded, "全通道成功且穷尽不得报bounded");
}

#[tokio::test]
async fn failed_knowledge_channels_are_not_masked_by_unrequested_raw() {
    if std::env::var("DATA_AGENT_VECTOR_COLLECTION").as_deref() != Ok("synthetic_channel_coverage")
    {
        return;
    }
    let allowed = AllowedRecords {
        knowledge_ids: vec!["only-failed".into()],
        sources: vec![],
    };
    let scope = KnowledgeSearchScope::default();
    let deadline = retrieval_deadline();
    let mut result = prepare_cursors("demo", &scope, Some(&allowed), false, deadline);
    for channel in [ScanChannel::Lexical, ScanChannel::Dense] {
        if channel == ScanChannel::Dense {
            result.dense_vector = Some(vec![0.01; 1024]);
        }
        while let Some(page) = result.next_page(channel, "范围检索", 1, 10) {
            result
                .accept_page(fetch_page(page).await, Some(&allowed))
                .unwrap();
        }
    }
    assert_eq!(result.state, "unavailable", "未执行raw不能算成功通道");
    assert!(result.bounded);
    assert_eq!(result.lexical_progress.completed, 0);
    assert!(!result.lexical_progress.exhausted);
    assert_eq!(result.dense_progress.completed, 0);
    assert!(!result.dense_progress.exhausted);

    let result = search_scoped(ScopedQuery {
        space: "demo",
        query: "范围检索",
        vector: Some(vec![0.01; 1024]),
        scope: &scope,
        limit: 10,
        allowed: Some(&allowed),
        include_raw: false,
        deadline: retrieval_deadline(),
    })
    .await
    .unwrap();
    assert_eq!(result.state, "unavailable");
    assert!(result.bounded);
}

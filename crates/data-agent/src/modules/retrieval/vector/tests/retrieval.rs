use super::*;
#[test]
fn continuation_scan_restores_offsets_without_filter_or_budget_reset() {
    let mut original = Candidates::lexical();
    original.target = Some("synthetic-target".into());
    original.cursors.lexical = Some(ChannelCursor::new(vec!["private-filter".into()]));
    let page = original
        .next_page(ScanChannel::Lexical, "合成问题", 1, 1)
        .unwrap();
    original
        .accept_page(
            CandidatePage {
                count: page.reserved,
                request: page,
                rows: vec![],
                failed: false,
            },
            None,
        )
        .unwrap();
    let snapshot = original.snapshot_scan().unwrap();
    let encoded = serde_json::to_string(&snapshot).unwrap();
    assert!(!encoded.contains("private-filter"));
    let mut resumed = Candidates::lexical();
    resumed.cursors.lexical = Some(ChannelCursor::new(vec!["private-filter".into()]));
    let deadline = resumed.deadline;
    assert_eq!(resumed.budget.allocate(1, 950), 950);
    resumed
        .budget
        .restore_candidates(["restored".to_owned()].into_iter())
        .unwrap();
    resumed.restore_scan(&snapshot).unwrap();
    let page = resumed
        .next_page(ScanChannel::Lexical, "合成问题", 1, 1)
        .unwrap();
    assert_eq!(page.offset, 50);
    assert_eq!(page.reserved, 49, "恢复候选与在途预留共用1000额度");
    assert_eq!(resumed.deadline, deadline, "内部恢复不能续期");
    assert_eq!(resumed.budget.count(), 1);
}

#[test]
fn continuation_scan_rejects_live_pages_and_changed_current_scope() {
    let mut original = Candidates::lexical();
    original.cursors.lexical = Some(ChannelCursor::new(vec!["original-scope".into()]));
    let page = original
        .next_page(ScanChannel::Lexical, "合成问题", 1, 1)
        .unwrap();
    assert_eq!(original.snapshot_scan().unwrap_err().code, "invalid_cursor");
    original
        .accept_page(
            CandidatePage {
                request: page,
                count: 0,
                rows: vec![],
                failed: false,
            },
            None,
        )
        .unwrap();
    let snapshot = original.snapshot_scan().unwrap();
    let mut changed = Candidates::lexical();
    changed.cursors.lexical = Some(ChannelCursor::new(vec!["changed-scope".into()]));
    assert_eq!(
        changed.restore_scan(&snapshot).unwrap_err().code,
        "stale_cursor"
    );
}

#[test]
fn restored_candidates_cannot_spend_reserved_capacity_or_an_extra_depth() {
    let mut budget = CandidateBudget::default();
    assert_eq!(budget.allocate(1, 999), 999);
    budget
        .restore_candidates(["restored".into()].into_iter())
        .unwrap();
    assert_eq!(
        budget
            .restore_candidates(["overflow".into()].into_iter())
            .unwrap_err()
            .code,
        "tool_response_capacity"
    );
    assert_eq!(budget.count(), 1, "失败不部分修改账本");
    budget.record(999, std::iter::empty());
    assert_eq!(budget.allocate(5, 999), 999);
    assert_eq!(budget.allocate(6, 1), 0);
    assert_eq!(budget.rounds(), 5);
}

#[test]
fn channel_failures_isolate_and_report_partial_availability() {
    for (knowledge, raw, expected) in [
        (Some(true), Some(true), ("available", false)),
        (Some(true), Some(false), ("available", true)),
        (Some(false), Some(true), ("available", true)),
        (Some(false), Some(false), ("unavailable", true)),
        (Some(false), None, ("unavailable", true)),
        (None, Some(false), ("unavailable", true)),
        (None, None, ("available", false)),
    ] {
        let mut candidates = Candidates::lexical();
        if knowledge.is_some() || raw.is_none() {
            let filters = if knowledge.is_some() {
                vec!["synthetic".to_owned()]
            } else {
                vec![]
            };
            candidates.cursors.lexical = Some(ChannelCursor::new(filters));
        }
        if raw.is_some() {
            candidates.cursors.raw_lexical = Some(ChannelCursor::new(vec!["synthetic".to_owned()]));
            candidates.cursors.raw_dense = Some(ChannelCursor::new(vec![]));
        }
        for (channel, available) in [
            (ScanChannel::Lexical, knowledge),
            (ScanChannel::RawLexical, raw),
        ] {
            if let Some(available) = available {
                let request = candidates.next_page(channel, "范围", 1, 1).unwrap();
                candidates
                    .accept_page(
                        CandidatePage {
                            request,
                            count: 0,
                            rows: vec![],
                            failed: !available,
                        },
                        None,
                    )
                    .unwrap();
            }
        }
        candidates.refresh_progress().unwrap();
        assert_eq!((candidates.state, candidates.bounded), expected);
    }
    // 单路批次吸收：失败只记本路，不改写为空成功；解析失败同样只记本路。
    let ok = absorb_batch(
        Ok(
            json!([{"id":"frag-1","object_id":"a","object_version":1,"entry_id":"body",
            "char_offset":0,"char_length":10,"content_hash":"h","distance":1.5}]),
        ),
        aggregate_hits,
    );
    assert_eq!(
        ok,
        (
            1,
            vec![
                json!({"id":"a","version":"1","record_id":"frag-1","matches":[{"fragment_id":"frag-1",
                "entry_id":"body","path":null,"offset":0,"length":10,"content_hash":"h","score":1.5}]})
            ],
            false
        )
    );
    for failed in [
        absorb_batch(Err(Error::new("unavailable")), aggregate_hits),
        absorb_batch(Ok(json!({"not":"array"})), aggregate_hits),
    ] {
        assert_eq!(failed, (0, Vec::<Value>::new(), true));
    }
}

#[test]
fn raw_response_requires_explicit_current_representation_and_location() {
    let hit = json!({"id":"raw-fragment","source_kind":"document","object_id":"synthetic-source",
        "object_version":1,"char_offset":12,"char_length":36,"content_hash":"synthetic-hash",
        "segmentation_version":"source-structure-1","distance":0.75});
    let (count, rows, failed) = absorb_batch(Ok(json!([hit])), excerpt_rows);
    assert_eq!(count, 1);
    assert!(!failed);
    assert_eq!(
        super::super::raw_record(&rows[0]).as_deref(),
        Some("document:synthetic-source:1:12:36:source-structure-1")
    );
    for field in [
        "id",
        "source_kind",
        "object_id",
        "object_version",
        "char_offset",
        "char_length",
        "content_hash",
        "segmentation_version",
        "distance",
    ] {
        let mut missing = hit.clone();
        missing.as_object_mut().unwrap().remove(field);
        assert_eq!(
            absorb_batch(Ok(json!([missing])), excerpt_rows),
            (0, vec![], true),
            "缺失{field}须在Milvus响应边界判为该路失败"
        );
    }
    for (field, value) in [
        ("source_kind", json!("unknown")),
        ("object_version", json!("1")),
        ("char_offset", json!(-1)),
        ("char_length", json!(0)),
        ("content_hash", json!(42)),
        ("segmentation_version", json!("source-structure-0")),
        ("distance", json!("0.75")),
    ] {
        let mut invalid = hit.clone();
        invalid[field] = value;
        assert_eq!(
            absorb_batch(Ok(json!([invalid])), excerpt_rows),
            (0, vec![], true),
            "非法{field}须在Milvus响应边界判为该路失败"
        );
    }
}

#[tokio::test]
async fn deadline_cuts_slow_calls_at_one_shared_instant() {
    // 一次调用统一截止：后续批次沿用同一绝对期限的剩余预算，不逐批重置。
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(80);
    let started = std::time::Instant::now();
    assert!(
        call_at_deadline(
            deadline,
            tokio::time::sleep(std::time::Duration::from_secs(2))
        )
        .await
        .is_err()
    );
    assert!(
        call_at_deadline(
            deadline,
            tokio::time::sleep(std::time::Duration::from_secs(2))
        )
        .await
        .is_err()
    );
    assert!(started.elapsed() < std::time::Duration::from_secs(1));
    assert_eq!(
        call_at_deadline(
            tokio::time::Instant::now() + std::time::Duration::from_secs(1),
            async { serde_json::json!({"ok":true}) }
        )
        .await
        .unwrap()["ok"],
        true
    );
}

#[test]
fn version_and_fragment_keys_cannot_overwrite_newer_documents() {
    let object = json!({"id":"doc","name":"合成说明","kind":"document","state":"enabled","version":"1","entries":[{"entry_id":"body","label":"正文","effective_value":"中文说明".repeat(200)}]});
    let (first, bounded) = fragments("demo", &object);
    assert!(!bounded);
    assert!(first.len() > 1);
    let mut newer = object.clone();
    newer["version"] = json!("2");
    let (second, _) = fragments("demo", &newer);
    assert!(
        first
            .iter()
            .all(|a| second.iter().all(|b| a["id"] != b["id"]))
    );
    newer["state"] = json!("disabled");
    assert!(fragments("demo", &newer).0.is_empty());
}

#[test]
fn statement_projection_keeps_original_entry_offsets_and_distinct_identity() {
    let first = "合成背景🌏。".repeat(151);
    let second = "设备停用后不得计入有效设备数。\n仅适用完成复核的设备。";
    let entry = json!({"entry_id":"rules","path":"rules","label":"规则",
        "effective_value":format!("{first}\n\n{second}"),"human_override":null,
        "suggestion":{"value":format!("{first}\n\n{second}"),"statements":[
            {"statement_id":"first","text":first,"scope_text":""},
            {"statement_id":"second","text":"设备停用后不得计入有效设备数。","scope_text":"仅适用完成复核的设备。"}]}});
    let object = json!({"id":"metric","name":"合成资料","version":"1","state":"enabled","kind":"metric","entries":[entry]});
    let (pieces, _) = fragments("demo", &object);
    let selected = pieces
        .iter()
        .find(|piece| piece["statement_id"] == "second")
        .unwrap();
    assert_eq!(selected["char_offset"], first.chars().count() + 2);
    assert_eq!(selected["statement_offset"], 0);
    assert_eq!(selected["char_length"], second.chars().count());
    assert_eq!(selected["content_hash"], fingerprint(&json!(second)));
    let mut locator = object["entries"][0].clone();
    locator["statement_id"] = json!("second");
    assert_eq!(
        selected["id"],
        crate::types::knowledge_record_id("demo", &object, &locator, first.chars().count() + 2)
    );
    let mut modified = object.clone();
    modified["entries"][0]["effective_value"] = json!("人工已替换正文，旧陈述不再有效。");
    let (modified, _) = fragments("demo", &modified);
    assert!(modified.iter().all(|piece| piece["statement_id"] == ""));
    assert!(
        modified
            .iter()
            .all(|piece| piece["text"].as_str().unwrap().contains("人工已替换正文"))
    );
}

#[test]
fn document_statements_keep_local_coordinates_without_replacing_original_text() {
    let object = json!({"id":"document","name":"合成文档","version":"1","state":"enabled","kind":"document",
        "entries":[{"entry_id":"body","path":"body","label":"正文","effective_value":"这是独立保存的原文。",
            "human_override":{"value":"这是独立保存的原文。"},"suggestion":{"statements":[
                {"statement_id":"derived","text":"整理后的定义。","scope_text":"仅限合成范围。"}]}}]});
    let (pieces, _) = fragments("demo", &object);
    let original = pieces
        .iter()
        .find(|piece| piece["statement_id"] == "")
        .unwrap();
    let derived = pieces
        .iter()
        .find(|piece| piece["statement_id"] == "derived")
        .unwrap();
    assert_eq!(derived["char_offset"], 0);
    assert_eq!(derived["statement_offset"], 0);
    assert_eq!(
        derived["content_hash"],
        fingerprint(&json!("整理后的定义。\n仅限合成范围。"))
    );
    assert!(
        original["text"]
            .as_str()
            .unwrap()
            .contains("这是独立保存的原文。")
    );
    assert_ne!(original["id"], derived["id"]);
}

// 允许集分片合并按原始分数全局排序：不同身份子集的命中不能以批次顺序拼接，
// 同id去重保留首批已收行。
#[test]
fn shard_merges_rank_by_raw_score_across_batches() {
    let rows = |pairs: &[(&str, f64)]| {
        pairs
            .iter()
            .map(|(id, distance)| json!({"id":id,"distance":distance}))
            .collect::<Vec<_>>()
    };
    let primary = rows(&[("a", 0.9), ("b", 0.4)]);
    let extra = rows(&[("c", 0.95), ("a", 0.1), ("d", 0.7)]);
    let merged = merge_by_score(primary, extra, row_score);
    assert_eq!(
        merged
            .iter()
            .map(|v| v["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["c", "a", "d", "b"]
    );
    // 知识对象聚合取片段最高分参与排序，不丢片段。
    let object = |id: &str, scores: &[f64]| {
        json!({"id":id,"matches":scores
            .iter()
            .map(|score| json!({"score":score}))
            .collect::<Vec<_>>()})
    };
    let merged_objects = merge_by_score(
        vec![object("k1", &[0.2, 0.5])],
        vec![object("k2", &[0.3, 0.8])],
        object_best_score,
    );
    assert_eq!(
        merged_objects
            .iter()
            .map(|v| v["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["k2", "k1"]
    );
    assert_eq!(merged_objects[0]["matches"].as_array().unwrap().len(), 2);
}

#[test]
fn deeper_results_keep_new_positions_and_the_best_channel_score() {
    let first = json!({"id":"document-a","version":"1","matches":[
        {"fragment_id":"definition","entry_id":"body","offset":0,"length":80,"score":0.5}
    ]});
    let expanded = json!({"id":"document-a","version":"1","matches":[
        {"fragment_id":"definition","entry_id":"body","offset":0,"length":80,"score":0.7},
        {"fragment_id":"exception","entry_id":"body","offset":600,"length":80,"score":0.6}
    ]});
    let second = json!({"id":"document-b","version":"1","matches":[
        {"fragment_id":"other","entry_id":"body","offset":0,"length":80,"score":0.65}
    ]});
    let merged = merge_by_score(vec![first, second], vec![expanded], object_best_score);
    assert_eq!(merged[0]["id"], "document-a", "同通道的新高分参与排序");
    let positions = merged[0]["matches"].as_array().unwrap();
    assert_eq!(positions.len(), 2, "扩深得到的例外片段不能被整行丢弃");
    assert_eq!(positions[0]["score"], 0.7);
    assert_eq!(positions[1]["offset"], 600);
}

// 05接续：共享候选预算的账本真值——唯一身份跨通道/跨轮去重、在合并/筛除前
// 计数、失效不退还；请求前分配永不超过剩余额度；超过最大轮深返回0。
#[test]
fn concurrent_candidate_requests_share_remaining_capacity() {
    let mut budget = CandidateBudget::default();
    budget.allocate(1, 900);
    budget.record(900, (0..900).map(|i| format!("entry:{i}")));
    let lexical = budget.allocate(2, 100);
    let dense = budget.allocate(2, 100);
    assert_eq!(lexical + dense, 100, "在途请求不能重复占用剩余名额");
}

#[test]
fn candidate_budget_allocates_before_requests_and_counts_unique_identities() {
    let mut budget = CandidateBudget::default();
    assert_eq!(budget.allocate(1, 200), 200);
    assert_eq!(
        budget.record(200, (0..200).map(|i| format!("entry:{i}"))),
        200
    );
    assert_eq!(budget.allocate(1, 250), 250);
    assert_eq!(
        budget.record(250, (0..250).map(|i| format!("entry:{i}"))),
        50
    );
    assert_eq!(budget.count(), 250);
    assert_eq!(budget.remaining(), 750);
    assert_eq!(budget.allocate(2, 800), 750);
    assert_eq!(budget.allocate(2, 100), 0, "在途请求已占满剩余额度");
    assert_eq!(budget.rounds(), 2);
    assert_eq!(budget.allocate(6, 100), 0);
    // 请求失败或返回重复身份时释放未消费的预留，不退还已收到的记录。
    budget.record(750, std::iter::empty());
    assert_eq!(budget.remaining(), 750);
    assert_eq!(budget.allocate(2, 1), 1);
    assert_eq!(budget.record(1, ["sql:obj-1".to_owned()].into_iter()), 1);
    assert_eq!(budget.count(), 251);
    let mut full = CandidateBudget::default();
    full.allocate(1, CANDIDATE_CEILING);
    full.record(
        CANDIDATE_CEILING,
        (0..CANDIDATE_CEILING).map(|i| format!("excerpt:{i}")),
    );
    assert_eq!(full.remaining(), 0);
    assert_eq!(full.allocate(1, 50), 0);
}

// 通道进度真值（05切片3游标版）：末轮满页=可能还有更多（足够本页不表示穷
// 举）；停轮原因如实保留；空分片范围按已覆盖穷举；末轮未满页即该通道穷举。
#[test]
fn channel_progress_separates_exhausted_from_uncovered() {
    // 两片都已请求且末轮未满页：穷举、无未覆盖原因。
    let mut drained = ChannelCursor::new(vec!["a".into(), "b".into()]);
    drained.rounds = 1;
    for shard in &mut drained.shards {
        shard.requested = true;
        shard.succeeded = true;
    }
    let progress = drained.progress();
    assert!(progress.exhausted && progress.uncovered.is_none());
    assert_eq!(progress.completed, 2);
    // 末轮任一片满页：可能还有更多，未覆盖原因为candidate_limit。
    let mut full = ChannelCursor::new(vec!["a".into(), "b".into()]);
    full.rounds = 1;
    for shard in &mut full.shards {
        shard.requested = true;
        shard.succeeded = true;
    }
    full.shards[0].full_page = true;
    full.last_full_page = true;
    let progress = full.progress();
    assert!(!progress.exhausted);
    assert_eq!(progress.uncovered, Some("candidate_limit"));
    // 停轮原因如实保留（额度到界）。
    let mut stopped = ChannelCursor::new(vec!["a".into(), "b".into()]);
    stopped.rounds = 2;
    for shard in &mut stopped.shards {
        shard.requested = true;
        shard.succeeded = true;
    }
    stopped.stopped = Some("candidate_limit");
    let progress = stopped.progress();
    assert!(!progress.exhausted);
    assert_eq!(progress.uncovered, Some("candidate_limit"));
    // 期限停止保留deadline原因。
    let mut deadline_hit = ChannelCursor::new(vec!["a".into()]);
    deadline_hit.rounds = 1;
    deadline_hit.shards[0].requested = true;
    deadline_hit.stopped = Some("deadline");
    assert_eq!(deadline_hit.progress().uncovered, Some("deadline"));
    // 空允许集：范围内无可召回记录，按已覆盖穷举。
    let empty = ChannelCursor::new(Vec::new());
    assert!(empty.progress().exhausted && empty.progress().uncovered.is_none());
}

#[tokio::test]
async fn failed_shard_is_not_completed_or_exhausted() {
    // 连接拒绝是实际边界故障，不用空成功结果代替失败。
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    let milvus = Milvus {
        url: reqwest::Url::parse(&format!("http://{address}")).unwrap(),
        client: reqwest::Client::builder().no_proxy().build().unwrap(),
        collection: "synthetic_failed_shard".into(),
        token: "synthetic-only".into(),
    };
    let mut candidates = Candidates::lexical();
    candidates.cursors.lexical = Some(ChannelCursor::new(vec!["space_id == \"demo\"".into()]));
    let request = candidates
        .next_page(ScanChannel::Lexical, "语音定义", 1, 10)
        .unwrap();
    let result = run_lexical(
        &milvus,
        &request.filter,
        &knowledge_output(),
        &request.query,
        request.reserved,
        request.offset,
        request.deadline,
    )
    .await;
    let (count, rows, failed) = absorb_batch(result, aggregate_hits);
    candidates
        .accept_page(
            CandidatePage {
                request,
                count,
                rows,
                failed,
            },
            None,
        )
        .unwrap();
    let cursor = candidates.cursors.lexical.as_ref().unwrap();
    assert!(cursor.failed);
    assert_eq!(cursor.progress().completed, 0, "失败分片没有完成检索");
    assert!(!cursor.drained(), "请求失败不能说明该通道已见底");
    assert!(!cursor.progress().exhausted, "失败不能成为穷举证据");
}

// 合同“有效候选不足才扩大”的反向：通道返回数未达额度即该深度已见底，
// 不得为凑轮数重复发同一批请求（05切片3起以游标事实判定）。
#[test]
fn drained_rounds_stop_expansion_instead_of_repeating_requests() {
    let mut drained = ChannelCursor::new(vec!["base".into()]);
    drained.rounds = 1;
    drained.shards[0].requested = true;
    assert!(drained.drained(), "未满页的分片执行即通道见底");
    assert!(!drained.advanceable());
    // 未执行任何分片（空允许集/期限已过）不构成见底，避免把未尝试当成已穷举。
    let mut skipped = ChannelCursor::new(vec!["base".into()]);
    skipped.stopped = Some("deadline");
    assert!(!skipped.drained());
    assert!(!skipped.advanceable());
    // 满页说明可能还有更多，仍值得扩轮（offset位置前进，不重复请求）。
    let mut full = ChannelCursor::new(vec!["base".into()]);
    full.rounds = 1;
    full.shards[0].requested = true;
    full.shards[0].full_page = true;
    full.last_full_page = true;
    assert!(!full.drained());
    assert!(full.advanceable());
    // 失败片不再重试，也不计入completed。
    let mut failed = ChannelCursor::new(vec!["base".into()]);
    failed.rounds = 1;
    failed.shards[0].requested = true;
    failed.shards[0].failed = true;
    failed.failed = true;
    assert!(!failed.advanceable());
    assert_eq!(failed.progress().completed, 0);
}

#[test]
fn vector_results_must_stay_within_the_sent_source_scope() {
    let allowed = AllowedRecords {
        knowledge_ids: vec!["allowed-guide".to_owned()],
        sources: vec![],
    };
    let mut result = Candidates::lexical();
    result.cursors.lexical = Some(ChannelCursor::new(vec!["scope-filter".to_owned()]));
    let request = result
        .next_page(ScanChannel::Lexical, "指南", 1, 10)
        .unwrap();
    let rows = aggregate_hits(&json!([
        {"id":"in-scope","object_id":"allowed-guide","object_version":1},
        {"id":"out-of-scope","object_id":"other-guide","object_version":1},
    ]))
    .unwrap();
    result
        .accept_page(
            CandidatePage {
                count: rows.len(),
                request,
                rows,
                failed: false,
            },
            Some(&allowed),
        )
        .unwrap();
    assert!(result.lexical.is_empty());
    assert_eq!(result.lexical_state, "unavailable");
    assert!(result.bounded);
}

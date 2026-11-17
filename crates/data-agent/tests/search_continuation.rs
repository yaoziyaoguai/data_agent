use data_agent::{
    modules::retrieval::vector::Candidates,
    use_cases::knowledge::{SearchContinuation, SearchHit},
};
use serde_json::json;

#[test]
fn snapshot_retains_original_cross_channel_order_after_first_delivery() {
    let row = |record, offset, score| {
        json!({"id":"synthetic-object","version":"1","record_id":record,
        "name":"cursor must not retain this name", "body":"cursor must not retain this body",
        "matches":[{"fragment_id":record,"entry_id":"definition","path":"definition","offset":offset,"length":20,"score":score}]})
    };
    let mut vector = Candidates::lexical();
    vector.lexical = vec![row("first", 0, 10.0), row("second", 280, 9.0)];
    vector.values = vec![row("second", 280, 0.9), row("first", 0, 0.8)];
    let continuation = SearchContinuation::capture(&vector, &[vec![], vec![]], &[]).unwrap();
    let encoded = continuation
        .snapshot(&["k:first".into()], 65_536)
        .unwrap()
        .unwrap();
    assert!(!encoded.contains("cursor must not retain"));
    let resumed = SearchContinuation::decode(&encoded).unwrap();
    let rank = resumed.rank_window(
        "unmatched",
        vec![row("first", 0, 0.0), row("second", 280, 0.0)],
    );
    assert_eq!(
        rank.sequence
            .iter()
            .map(|(_, key)| key.as_str())
            .collect::<Vec<_>>(),
        ["k:second"]
    );
    assert!((rank.sequence[0].0 - (1.0 / 61.0 + 1.0 / 60.0)).abs() < 1e-12);
}

#[test]
fn merged_raw_delivery_retires_every_original_window_member() {
    let raw = |offset| {
        json!({"source_kind":"document","source_id":"synthetic-source","revision":1,
        "offset":offset,"length":1200,"content_hash":"synthetic-hash",
        "segmentation_version":"source-structure-1","distance":1.0})
    };
    let mut vector = Candidates::lexical();
    vector.raw.lexical = vec![raw(0), raw(1040), raw(3200)];
    let continuation = SearchContinuation::capture(&vector, &[vec![], vec![]], &[]).unwrap();
    let hit = SearchHit::SourceExcerpt {
        records: vec![
            "raw:document:synthetic-source:1:0:1200:source-structure-1".into(),
            "raw:document:synthetic-source:1:1040:1200:source-structure-1".into(),
        ],
        score: 1.0,
        content: json!({"text":"cursor must not retain merged body"}),
    };
    let encoded = continuation
        .snapshot(&hit.record_keys(), 65_536)
        .unwrap()
        .unwrap();
    let resumed = SearchContinuation::decode(&encoded).unwrap();
    let rank = resumed.rank_window("unmatched", vec![]);
    assert_eq!(
        rank.sequence
            .iter()
            .map(|(_, key)| key.as_str())
            .collect::<Vec<_>>(),
        ["raw:document:synthetic-source:1:3200:1200:source-structure-1"]
    );
}

#[test]
fn snapshot_returns_capacity_error_without_dropping_pending() {
    let mut vector = Candidates::lexical();
    vector.lexical = vec![
        json!({"id":"synthetic-object","version":"1","record_id":"pending",
        "matches":[{"entry_id":"definition","path":"definition","offset":0,"length":20,"score":1.0}]}),
    ];
    let saved = SearchContinuation::capture(&vector, &[vec![], vec![]], &[]).unwrap();
    assert_eq!(
        saved.snapshot(&[], 1).unwrap_err().code,
        "tool_response_capacity"
    );
    let encoded = saved.snapshot(&[], 65_536).unwrap().unwrap();
    assert_eq!(
        SearchContinuation::decode(&encoded)
            .unwrap()
            .rank_window(
                "unmatched",
                vec![json!({"id":"synthetic-object","version":"1","record_id":"pending"})]
            )
            .sequence[0]
            .1,
        "k:pending"
    );
    assert!(
        saved
            .snapshot(&["k:pending".into()], 65_536)
            .unwrap()
            .is_none()
    );
}

#[test]
fn typical_fifty_candidate_window_fits_without_retaining_names_or_text() {
    let mut vector = Candidates::lexical();
    vector.lexical = (0..50).map(|index| json!({"id":"synthetic-object","version":"1",
        "record_id":format!("{index:064x}"),"name":"not retained", "body":"not retained".repeat(300),
        "matches":[{"entry_id":"definition","path":"definition","offset":index*280,"length":360,
            "content_hash":"a".repeat(64),"score":50-index}]})).collect();
    let saved = SearchContinuation::capture(&vector, &[vec![], vec![]], &[]).unwrap();
    let encoded = saved.snapshot(&[], 65_536).unwrap().unwrap();
    assert!(encoded.len() < 32_768);
    assert!(!encoded.contains("not retained"));
}

#[test]
fn thousand_canonical_windows_keep_every_pending_location_within_cursor_limit() {
    let object = json!({"id":"00000000-0000-4000-8000-000000000001","version":"1"});
    let entry = json!({"entry_id":"body","path":"body","statement_id":null});
    let mut vector = Candidates::lexical();
    vector.space = Some("demo".into());
    vector.lexical = (0..1000)
        .map(|index| {
            let offset = index * 280;
            let record = data_agent::types::knowledge_record_id("demo", &object, &entry, offset);
            json!({"id":object["id"],"version":"1","space_id":"demo","record_id":record,
                "matches":[{"entry_id":"body","path":"body","offset":offset,"length":360,
                    "content_hash":data_agent::types::fingerprint(&json!(["synthetic-window",index])),
                    "score":1000-index}]})
        })
        .collect();
    let saved = SearchContinuation::capture(&vector, &[vec![], vec![]], &[]).unwrap();
    let before = serde_json::to_string(&saved).unwrap().len();
    let encoded = saved.snapshot(&[], 65_536);
    assert!(
        encoded.is_ok(),
        "1000规范位置应可续页，当前全窗JSON={before}字节，错误={encoded:?}"
    );
    let encoded = encoded.unwrap().unwrap();
    println!("compact_thousand_cursor_bytes={}", encoded.len());
    let restored = SearchContinuation::decode(&encoded).unwrap();
    restored.assert_pending_knowledge(&vector.lexical).unwrap();
    let ranked = restored.rank_window("unmatched", vector.lexical.clone());
    assert_eq!(
        ranked.sequence.len(),
        1000,
        "不能裁掉未交付位置后推进扫描尾"
    );
    assert_eq!(
        ranked.sequence[0].1,
        format!("k:{}", vector.lexical[0]["record_id"].as_str().unwrap())
    );
    assert!((ranked.sequence[999].0 - 1.0 / 1059.0).abs() < 1e-12);
    let mut terminal: serde_json::Value = serde_json::from_str(&encoded).unwrap();
    terminal["q"] = json!([[1000, true, false], [0, true, true]]);
    terminal["a"] = json!(true);
    let terminal = SearchContinuation::decode(&terminal.to_string()).unwrap();
    let delivered = ranked
        .sequence
        .into_iter()
        .map(|(_, key)| key)
        .collect::<Vec<_>>();
    let bookmark = terminal.snapshot(&delivered, 65_536).unwrap().unwrap();
    println!("compact_thousand_history_bytes={}", bookmark.len());
    let resumed = SearchContinuation::decode(&bookmark).unwrap();
    assert!(
        resumed
            .rank_window("unmatched", vector.lexical)
            .sequence
            .is_empty(),
        "窗口完成后只留原身份摘要去重"
    );
}

#[test]
fn thousand_two_channel_window_keeps_last_pending_position_within_cursor_limit() {
    let owner = json!({"id":"00000000-0000-4000-8000-000000000004","version":"1"});
    let entry = json!({"entry_id":"body","path":"body","statement_id":null});
    let mut vector = Candidates::lexical();
    vector.space = Some("demo".into());
    vector.lexical = (0..1000).map(|index| {
        let record = data_agent::types::knowledge_record_id("demo", &owner, &entry, index * 280);
        json!({"id":owner["id"],"version":"1","record_id":record,"matches":[{
            "entry_id":"body","path":"body","offset":index*280,"length":360,
            "content_hash":data_agent::types::fingerprint(&json!(["two-channel",index])),"score":1000-index}]})
    }).collect();
    vector.values = vector
        .lexical
        .iter()
        .rev()
        .enumerate()
        .map(|(rank, row)| {
            let mut row = row.clone();
            row["matches"][0]["score"] = json!(1000 - rank);
            row
        })
        .collect();
    let saved = SearchContinuation::capture(&vector, &[vec![], vec![]], &[]).unwrap();
    let original = saved.rank_window("unmatched", vector.lexical.clone());
    let pending = original.sequence.last().unwrap().clone();
    let delivered = original.sequence[..999]
        .iter()
        .map(|(_, key)| key.clone())
        .collect::<Vec<_>>();
    let encoded = saved.snapshot(&delivered, 65_536);
    assert!(
        encoded.is_ok(),
        "同一1000候选双通道窗口末页必须仍可恢复最后未交位置：{encoded:?}"
    );
    let encoded = encoded.unwrap().unwrap();
    println!(
        "compact_thousand_two_channel_last_cursor_bytes={}",
        encoded.len()
    );
    let rank = SearchContinuation::decode(&encoded)
        .unwrap()
        .rank_window("unmatched", vector.lexical);
    assert_eq!(
        rank.sequence,
        vec![pending],
        "末页保持原RRF，不能丢pending或重传已交位置"
    );
}

#[test]
fn compact_mixed_window_preserves_hashes_positions_channel_ranks_and_retirement() {
    let owner = json!({"id":"00000000-0000-4000-8000-000000000002","version":"7"});
    let entry = json!({"entry_id":"body","path":"body","statement_id":"synthetic-statement"});
    let knowledge = |offset, score| {
        let record = data_agent::types::knowledge_record_id("demo", &owner, &entry, offset);
        json!({"id":owner["id"],"version":"7","record_id":record,"matches":[{
            "entry_id":"body","path":"body","statement_id":"synthetic-statement",
            "statement_offset":offset-280,"offset":offset,"length":360,
            "content_hash":data_agent::types::fingerprint(&json!(["synthetic",offset])),"score":score}]})
    };
    let raw = |offset, score| {
        json!({"source_kind":"document","source_id":"synthetic-source",
        "revision":4,"offset":offset,"length":1200,"content_hash":data_agent::types::fingerprint(&json!(["raw",offset])),
        "segmentation_version":"source-structure-1","distance":score})
    };
    let mut vector = Candidates::lexical();
    vector.space = Some("demo".into());
    vector.lexical = vec![knowledge(280, 3.0), knowledge(560, 1.0)];
    vector.values = vec![knowledge(560, -0.8), knowledge(280, -0.9)];
    vector.raw.lexical = vec![raw(0, 2.0), raw(4000, 0.5)];
    vector.raw.dense = vec![raw(4000, -0.2), raw(0, -0.5)];
    let saved = SearchContinuation::capture(&vector, &[vec![], vec![]], &[]).unwrap();
    let before = saved.rank_window("unmatched", vector.lexical.clone());
    let encoded = saved.snapshot(&[], 65_536).unwrap().unwrap();
    let restored = SearchContinuation::decode(&encoded).unwrap();
    let after = restored.rank_window("unmatched", vector.lexical.clone());
    assert_eq!(
        before.sequence, after.sequence,
        "两通道共同原名次和负COSINE次序逐项相等"
    );
    let locations = |rows: &[serde_json::Value]| {
        rows.iter().map(|row| row["matches"].as_array().unwrap().iter()
        .map(|location| json!({"entry":location["entry_id"],"path":location["path"],"statement":location["statement_id"],
            "local":location["statement_offset"],"offset":location["offset"],"length":location["length"],"hash":location["content_hash"]}))
        .collect::<Vec<_>>()).collect::<Vec<_>>()
    };
    assert_eq!(locations(&before.objects), locations(&after.objects));
    for original in &before.raw {
        let row = after
            .raw
            .iter()
            .find(|row| {
                data_agent::modules::retrieval::raw_record(row)
                    == data_agent::modules::retrieval::raw_record(original)
            })
            .unwrap();
        for key in [
            "source_kind",
            "source_id",
            "revision",
            "offset",
            "length",
            "content_hash",
        ] {
            assert_eq!(row[key], original[key]);
        }
    }
    let delivered = before.sequence[0].1.clone();
    let encoded = restored
        .snapshot(std::slice::from_ref(&delivered), 65_536)
        .unwrap()
        .unwrap();
    let resumed = SearchContinuation::decode(&encoded)
        .unwrap()
        .rank_window("unmatched", vector.lexical.clone());
    assert_eq!(
        resumed.sequence,
        before
            .sequence
            .into_iter()
            .filter(|(_, key)| key != &delivered)
            .collect::<Vec<_>>()
    );
}

#[test]
fn compact_fifty_window_cursor_leaves_room_for_a_small_final_reply() {
    let owner = json!({"id":"00000000-0000-4000-8000-000000000003","version":"1"});
    let entry = json!({"entry_id":"body","path":"body","statement_id":null});
    let mut vector = Candidates::lexical();
    vector.space = Some("demo".into());
    vector.lexical = (0..50).map(|index| {
        let record = data_agent::types::knowledge_record_id("demo", &owner, &entry, index*280);
        json!({"id":owner["id"],"version":"1","record_id":record,"matches":[{"entry_id":"body","path":"body",
            "offset":index*280,"length":360,"content_hash":data_agent::types::fingerprint(&json!(["short",index])),"score":50-index}]})
    }).collect();
    let saved = SearchContinuation::capture(&vector, &[vec![], vec![]], &[]).unwrap();
    let cursor = saved.snapshot(&[], 65_536).unwrap().unwrap();
    println!("compact_fifty_cursor_bytes={}", cursor.len());
    assert!(
        cursor.len() < 4000,
        "定位cursor应给5000B最终回执留正文与coverage空间"
    );
    let restored = SearchContinuation::decode(&cursor).unwrap();
    assert_eq!(
        restored
            .rank_window("unmatched", vector.lexical)
            .sequence
            .len(),
        50
    );
}

#[test]
fn sql_null_hash_windows_fit_small_escaped_cursor_without_inventing_hashes() {
    let owner = json!({"id":"00000000-0000-4000-8000-000000000005","version":"7"});
    let entry = json!({"entry_id":"body","path":"body","statement_id":"synthetic-sql-statement"});
    let mut vector = Candidates::lexical();
    // 当前请求已知space；SQL owner本身不返回space_id，也不读取正文计算hash。
    vector.space = Some("demo".into());
    let rows = (0..24)
        .map(|index| {
            let offset = 80 + index * 280;
            let record = data_agent::types::knowledge_record_id("demo", &owner, &entry, offset);
            json!({"id":owner["id"],"version":"7","kind":"term","record_id":record,
            "name_hit":false,"name_term_hits":0,"term_hits":24-index,
            "matches":[{"fragment_id":record,"entry_id":"body","path":"body",
                "statement_id":"synthetic-sql-statement","statement_offset":index*280,
                "offset":offset,"length":360,"content_hash":null,"score":24-index}]})
        })
        .collect::<Vec<_>>();
    let saved = SearchContinuation::capture(&vector, &[rows.clone(), rows.clone()], &[]).unwrap();
    let original = saved.rank_window("unmatched", rows.clone());
    let encoded = saved.snapshot(&[], 65_536).unwrap().unwrap();
    let outer = serde_json::to_string(&json!({"schema":1,"binding":"b".repeat(64),
        "scope":"s".repeat(64),"task":null,
        "window":serde_json::from_str::<serde_json::Value>(&encoded).unwrap()}))
    .unwrap();
    let reply = serde_json::to_string(&json!({"hits":[{"record_kind":"knowledge_entry",
        "ref":{"object_id":owner["id"],"version":"7","path":"body"},
        "name":"synthetic SQL term","kind":"term","statement_id":"synthetic-sql-statement",
        "definition":"synthetic rule. ".repeat(8),"scope_text":"","supports":[],"supports_complete":null,
        "support_state":"unknown","example_refs":[],"citations":[],"content_state":"partial",
        "continuation":{"content_next_offset":120,"supports_next_cursor":null}}],
        "search_coverage":{"state":"bounded","next":outer},
        "personal_memories":[],"selected_skills":[],"next_asset_after":null,"asset_cursor_invalid":false})).unwrap();
    println!(
        "sql_null_hash_cursor_bytes={} escaped_reply_bytes={}",
        encoded.len(),
        reply.len()
    );
    assert!(
        reply.len() <= 5000,
        "24个同owner SQL规范位置及外层cursor转义应给一个普通命中留出5000B容量，实际{}B",
        reply.len()
    );
    let restored = SearchContinuation::decode(&encoded).unwrap();
    restored.assert_pending_knowledge(&rows).unwrap();
    let ranked = restored.rank_window("unmatched", rows.clone());
    assert_eq!(
        ranked.sequence, original.sequence,
        "SQL去重后的共同原名次逐项保留"
    );
    assert_eq!(ranked.sequence.len(), 24);
    assert!((ranked.sequence[23].0 - 1. / 83.).abs() < 1e-12);
    for (candidate, original) in ranked.objects.iter().zip(&original.objects) {
        for field in [
            "entry_id",
            "path",
            "statement_id",
            "statement_offset",
            "offset",
            "length",
            "content_hash",
        ] {
            assert_eq!(
                candidate["matches"][0][field],
                original["matches"][0][field]
            );
        }
        assert!(
            candidate["matches"][0]["content_hash"].is_null(),
            "不能把SQL未知hash补造成已核摘要"
        );
    }
    let delivered = &original.sequence[0].1;
    let next = restored
        .snapshot(std::slice::from_ref(delivered), 65_536)
        .unwrap()
        .unwrap();
    assert_eq!(
        SearchContinuation::decode(&next)
            .unwrap()
            .rank_window("unmatched", rows)
            .sequence,
        original.sequence[1..],
        "不能重传已交位置或把剩余名次归零"
    );
}

#[test]
fn sql_null_hash_and_raw_preserve_common_ranks_and_legacy_cursor_restore() {
    let owner = json!({"id":"00000000-0000-4000-8000-000000000006","version":"3"});
    let entry = json!({"entry_id":"body","path":"body","statement_id":null});
    let row = |offset, score| {
        let key = data_agent::types::knowledge_record_id("demo", &owner, &entry, offset);
        json!({"id":owner["id"],"version":"3","record_id":key,
            "name_hit":false,"name_term_hits":0,"term_hits":score,
            "matches":[{"entry_id":"body","path":"body","statement_offset":offset,
                "offset":offset,"length":360,"content_hash":null,"score":score}]})
    };
    let sql = [vec![row(0, 10), row(280, 1)], vec![]];
    let mut vector = Candidates::lexical();
    vector.raw.lexical = vec![
        json!({"source_kind":"document","source_id":"synthetic-sql-raw",
        "revision":1,"offset":0,"length":20,"content_hash":"a".repeat(64),
        "segmentation_version":"source-structure-1","distance":2.5}),
    ];
    let legacy = SearchContinuation::capture(&vector, &sql, &[]).unwrap();
    let original = legacy.rank_window("unmatched", sql[0].clone());
    assert_eq!(
        original
            .sequence
            .iter()
            .map(|(score, _)| *score)
            .collect::<Vec<_>>(),
        vec![1. / 60., 1. / 61., 1. / 62.]
    );
    assert!(original.sequence[1].1.starts_with("raw:"));
    let legacy_encoded = legacy.snapshot(&[], 65_536).unwrap().unwrap();
    assert_eq!(
        SearchContinuation::decode(&legacy_encoded)
            .unwrap()
            .rank_window("unmatched", sql[0].clone())
            .sequence,
        original.sequence
    );
    vector.space = Some("demo".into());
    let compact = SearchContinuation::capture(&vector, &sql, &[]).unwrap();
    let encoded = compact.snapshot(&[], 65_536).unwrap().unwrap();
    assert_eq!(
        SearchContinuation::decode(&encoded)
            .unwrap()
            .rank_window("unmatched", sql[0].clone())
            .sequence,
        original.sequence,
        "SQL未知hash与raw原hash混排不能形成额外票或局部名次"
    );
    let mut invalid: serde_json::Value = serde_json::from_str(&encoded).unwrap();
    let knowledge_group = invalid["p"]["g"]
        .as_array()
        .unwrap()
        .iter()
        .position(|group| group["u"].is_array())
        .unwrap();
    let member = invalid["p"]["g"][knowledge_group]["u"][0].clone();
    invalid["p"]["g"][knowledge_group]["u"]
        .as_array_mut()
        .unwrap()
        .push(member);
    assert_eq!(
        SearchContinuation::decode(&invalid.to_string())
            .unwrap_err()
            .code,
        "invalid_cursor",
        "未知hash位置也必须拒绝重复成员"
    );
    let mut invalid: serde_json::Value = serde_json::from_str(&encoded).unwrap();
    invalid["p"]["g"][knowledge_group]["u"][0][1] = json!(u64::MAX);
    assert_eq!(
        SearchContinuation::decode(&invalid.to_string())
            .unwrap_err()
            .code,
        "invalid_cursor",
        "未知hash不豁免原offset+length溢出检查"
    );
}

#[test]
fn compact_sql_replacement_preserves_raw_interleaving_without_an_extra_vote() {
    let mut vector = Candidates::lexical();
    vector.space = Some("demo".into());
    vector.raw.lexical = vec![
        json!({"source_kind":"document","source_id":"raw-synthetic","revision":1,
        "offset":0,"length":20,"content_hash":"a".repeat(64),"segmentation_version":"source-structure-1","distance":2.5}),
    ];
    let row = |record, score| {
        json!({"id":"synthetic-owner","version":"1","record_id":record,
        "matches":[{"entry_id":"body","path":"body","offset":0,"length":20,"score":score}],
        "name_hit":false,"name_term_hits":0,"term_hits":score})
    };
    let sql = [vec![row("first", 10), row("second", 1)], vec![]];
    let saved = SearchContinuation::capture(&vector, &sql, &[]).unwrap();
    let objects = vec![row("first", 0), row("second", 0)];
    let original = saved.rank_window("unmatched", objects.clone());
    let encoded = saved.snapshot(&[], 65536).unwrap().unwrap();
    let resumed = SearchContinuation::decode(&encoded)
        .unwrap()
        .rank_window("unmatched", objects);
    assert_eq!(
        resumed.sequence, original.sequence,
        "SQL替代与raw词法共同原名次不能按各自局部名次重新混排"
    );
}

#[test]
fn compact_cursor_rejects_missing_duplicate_and_corrupt_position_members() {
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    let owner = json!({"id":"synthetic-owner","version":"1"});
    let entry = json!({"entry_id":"body","path":"body","statement_id":null});
    let mut vector = Candidates::lexical();
    vector.space = Some("demo".into());
    let key = data_agent::types::knowledge_record_id("demo", &owner, &entry, 0);
    vector.lexical = vec![
        json!({"id":"synthetic-owner","version":"1","record_id":key,"matches":[{
        "entry_id":"body","path":"body","offset":0,"length":20,"content_hash":"a".repeat(64),"score":1.0}]}),
    ];
    let saved = SearchContinuation::capture(&vector, &[vec![], vec![]], &[]).unwrap();
    let value: serde_json::Value =
        serde_json::from_str(&saved.snapshot(&[], 65536).unwrap().unwrap()).unwrap();
    let mut missing = value.clone();
    missing["p"]["n"] = json!(2);
    assert_eq!(
        SearchContinuation::decode(&missing.to_string())
            .unwrap_err()
            .code,
        "invalid_cursor"
    );
    let mut duplicate = value.clone();
    duplicate["p"]["g"]
        .as_array_mut()
        .unwrap()
        .push(value["p"]["g"][0].clone());
    assert_eq!(
        SearchContinuation::decode(&duplicate.to_string())
            .unwrap_err()
            .code,
        "invalid_cursor"
    );
    let mut corrupt = value.clone();
    corrupt["p"]["g"][0]["d"] = json!("*");
    assert_eq!(
        SearchContinuation::decode(&corrupt.to_string())
            .unwrap_err()
            .code,
        "invalid_cursor"
    );
    let mut overflow = value.clone();
    let mut bytes = URL_SAFE_NO_PAD
        .decode(overflow["p"]["g"][0]["d"].as_str().unwrap())
        .unwrap();
    bytes[2..10].copy_from_slice(&u64::MAX.to_be_bytes());
    overflow["p"]["g"][0]["d"] = json!(URL_SAFE_NO_PAD.encode(bytes));
    assert_eq!(
        SearchContinuation::decode(&overflow.to_string())
            .unwrap_err()
            .code,
        "invalid_cursor"
    );
    for bitmap in ["*".to_owned(), String::new(), URL_SAFE_NO_PAD.encode([2u8])] {
        let mut invalid = value.clone();
        invalid["d"] = json!(bitmap);
        assert_eq!(
            SearchContinuation::decode(&invalid.to_string())
                .unwrap_err()
                .code,
            "invalid_cursor",
            "损坏、缺字节及越过成员末尾的位图不能静默吞掉pending"
        );
    }
    let mut extra = value;
    extra["p"]["body"] = json!("cannot enter cursor");
    assert_eq!(
        SearchContinuation::decode(&extra.to_string())
            .unwrap_err()
            .code,
        "invalid_cursor"
    );
}

#[test]
fn duplicate_retired_indexes_cannot_hide_an_undelivered_record() {
    let mut vector = Candidates::lexical();
    vector.lexical = ["first", "second"].map(|record| json!({"id":"synthetic-object","version":"1","record_id":record,
        "matches":[{"entry_id":"definition","path":"definition","offset":0,"length":20,"score":1.0}]})).to_vec();
    let saved = SearchContinuation::capture(&vector, &[vec![], vec![]], &[]).unwrap();
    let encoded = saved.snapshot(&[], 65_536).unwrap().unwrap();
    let mut value: serde_json::Value = serde_json::from_str(&encoded).unwrap();
    value["d"] = json!([0, 0]);
    assert_eq!(
        SearchContinuation::decode(&value.to_string())
            .unwrap_err()
            .code,
        "invalid_cursor"
    );
}

#[test]
fn missing_or_replaced_pending_version_is_stale_instead_of_silently_skipped() {
    let mut vector = Candidates::lexical();
    vector.lexical = vec![
        json!({"id":"synthetic-object","version":"1","record_id":"pending",
        "matches":[{"entry_id":"definition","path":"definition","offset":0,"length":20,"score":1.0}]}),
    ];
    let saved = SearchContinuation::capture(&vector, &[vec![], vec![]], &[]).unwrap();
    assert_eq!(
        saved.assert_pending_knowledge(&[]).unwrap_err().code,
        "stale_cursor"
    );
    assert_eq!(
        saved
            .assert_pending_knowledge(&[
                json!({"id":"synthetic-object","version":"2","record_id":"pending"})
            ])
            .unwrap_err()
            .code,
        "stale_cursor"
    );
    saved
        .assert_pending_knowledge(&[
            json!({"id":"synthetic-object","version":"1","record_id":"pending"}),
        ])
        .unwrap();
}

#[test]
fn sql_restores_one_lexical_order_and_successful_bm25_blocks_an_extra_vote() {
    let row = |record, score| {
        json!({"id":"synthetic-object","version":"1","record_id":record,
        "matches":[{"entry_id":"definition","path":"definition","offset":0,"length":20,"score":score}],
        "name_hit":false,"name_term_hits":0,"term_hits":score})
    };
    let mut vector = Candidates::lexical();
    let sql = [
        vec![row("second", 3), row("first", 1)],
        vec![row("second", 2)],
    ];
    let saved = SearchContinuation::capture(&vector, &sql, &[]).unwrap();
    let encoded = saved.snapshot(&[], 65_536).unwrap().unwrap();
    let objects = vec![row("first", 0), row("second", 0)];
    let rank = SearchContinuation::decode(&encoded)
        .unwrap()
        .rank_window("unmatched", objects.clone());
    assert_eq!(rank.sequence[0].1, "k:second");
    assert!((rank.sequence[0].0 - 1.0 / 60.0).abs() < 1e-12);
    vector.lexical = vec![row("first", 10)];
    let saved = SearchContinuation::capture(&vector, &sql, &[]).unwrap();
    let rank = saved.rank_window("unmatched", objects);
    assert_eq!(
        rank.sequence
            .iter()
            .map(|(_, key)| key.as_str())
            .collect::<Vec<_>>(),
        ["k:first"]
    );
    assert!((rank.sequence[0].0 - 1.0 / 60.0).abs() < 1e-12);
}

#[test]
fn exhausted_window_compacts_to_bookmark_without_replaying_delivered_records() {
    let mut vector = Candidates::lexical();
    vector.lexical = vec![
        json!({"id":"synthetic-object","version":"1","record_id":"first",
        "matches":[{"entry_id":"definition","path":"definition","offset":0,"length":20,"score":1.0}]}),
    ];
    let sql = [vector.lexical.clone(), vec![]];
    vector.lexical.clear();
    let saved = SearchContinuation::capture(&vector, &sql, &[]).unwrap();
    let encoded = saved
        .snapshot(&["k:first".into()], 65_536)
        .unwrap()
        .unwrap();
    let resumed = SearchContinuation::decode(&encoded).unwrap();
    assert!(
        !encoded.contains("synthetic-object"),
        "已交付窗只保身份指纹和扫描bookmark"
    );
    assert!(
        resumed
            .rank_window(
                "unmatched",
                vec![json!({"id":"synthetic-object","version":"1","record_id":"first"})]
            )
            .sequence
            .is_empty()
    );
}

#[test]
fn negative_dense_scores_keep_their_place_relative_to_raw() {
    let mut vector = Candidates::lexical();
    vector.values = vec![
        json!({"id":"synthetic-object","version":"1","record_id":"knowledge",
        "matches":[{"entry_id":"definition","path":"definition","offset":0,"length":20,"score":-0.8}]}),
    ];
    vector.raw.dense = vec![
        json!({"source_kind":"platform","source_id":"synthetic-source","revision":1,
        "offset":0,"length":20,"content_hash":"hash","segmentation_version":"source-structure-1","distance":-0.2}),
    ];
    let saved = SearchContinuation::capture(&vector, &[vec![], vec![]], &[]).unwrap();
    let rank = saved.rank_window(
        "unmatched",
        vec![json!({"id":"synthetic-object","version":"1","record_id":"knowledge"})],
    );
    assert!(rank.sequence[0].1.starts_with("raw:"));
    assert!((rank.sequence[1].0 - 1.0 / 61.0).abs() < 1e-12);
}

#[test]
fn representation_change_and_unknown_cursor_fields_are_rejected() {
    let mut vector = Candidates::lexical();
    vector.raw.lexical = vec![
        json!({"source_kind":"platform","source_id":"synthetic-source",
        "revision":1,"offset":0,"length":20,"content_hash":"hash","segmentation_version":"source-structure-1","distance":0.8}),
    ];
    let saved = SearchContinuation::capture(&vector, &[vec![], vec![]], &[]).unwrap();
    let encoded = saved.snapshot(&[], 65_536).unwrap().unwrap();
    let mut value: serde_json::Value = serde_json::from_str(&encoded).unwrap();
    value["s"]["i"]["projection"] = json!("old-projection");
    assert_eq!(
        SearchContinuation::decode(&value.to_string())
            .unwrap_err()
            .code,
        "stale_cursor"
    );
    let mut value: serde_json::Value = serde_json::from_str(&encoded).unwrap();
    value["body"] = json!("untrusted body");
    assert_eq!(
        SearchContinuation::decode(&value.to_string())
            .unwrap_err()
            .code,
        "invalid_cursor"
    );
}

use data_agent::{
    contracts::generated::{SourceKey, SourceKeyKind},
    modules::retrieval::source_segments::{
        SegmentCursor, SourceFormat, SourceText, segment_source, segment_source_with_limit,
    },
};

#[test]
fn unicode_source_is_returned_with_a_round_trippable_code_point_citation() {
    let key = SourceKey {
        kind: SourceKeyKind::Document,
        id: "voice-definitions".into(),
    };
    let source = SourceText {
        source: &key,
        revision: "7",
        text: "A语🧪e\u{301}\r\n最终成功率。",
        format: SourceFormat::Text,
        background: &[],
    };
    let batch = segment_source(&source, None).unwrap();
    assert_eq!(batch.segments.len(), 1);
    let segment = &batch.segments[0];
    assert_eq!(segment.text, source.text);
    assert_eq!(segment.citation.locator.offset, 0);
    assert_eq!(segment.citation.locator.length, 13);
    assert_eq!(segment.citation.revision, "7");
    assert_eq!(segment.citation.source.id, key.id);
    assert_eq!(
        segment.citation.locator.slice(source.text).unwrap(),
        source.text
    );
    assert!(batch.next_cursor.is_none());
}

#[test]
fn long_sources_resume_past_the_old_fragment_limit_without_losing_the_tail() {
    let key = SourceKey {
        kind: SourceKeyKind::Document,
        id: "complete-voice-guide".into(),
    };
    let text = format!(
        "{}最终条件：未发生重试才计入首次成功。",
        "语🧪e\u{301}".repeat(40_000)
    );
    let source = SourceText {
        source: &key,
        revision: "9",
        text: &text,
        format: SourceFormat::Text,
        background: &[],
    };
    let first = segment_source(&source, None).unwrap();
    assert_eq!(first.segments.len(), 64);
    let mut cursor = None;
    let mut segments = Vec::new();
    loop {
        let batch = segment_source(&source, cursor.as_ref()).unwrap();
        assert!(!batch.segments.is_empty());
        assert!(batch.segments.len() <= 64);
        segments.extend(batch.segments);
        let Some(next) = batch.next_cursor else { break };
        // 模拟持久化后重新启动；游标不持有进程内迭代器。
        cursor = Some(
            serde_json::from_value::<SegmentCursor>(serde_json::to_value(next).unwrap()).unwrap(),
        );
    }
    assert!(segments.len() > 129);
    let mut reconstructed = String::new();
    let mut covered = 0;
    for segment in &segments {
        let locator = &segment.citation.locator;
        assert!(locator.length > 0 && locator.length <= 2400);
        assert_eq!(locator.slice(&text).unwrap(), segment.text);
        assert!(locator.offset <= covered);
        if covered > 0 {
            assert_eq!(covered - locator.offset, 160);
        }
        reconstructed.extend(
            segment
                .text
                .chars()
                .skip((covered - locator.offset) as usize),
        );
        let next = locator.offset + locator.length;
        assert!(next > covered);
        covered = next;
    }
    assert_eq!(reconstructed, text);
    assert!(
        segments
            .last()
            .unwrap()
            .text
            .ends_with("未发生重试才计入首次成功。")
    );
    let repeat = segment_source(&source, None).unwrap();
    assert_eq!(
        serde_json::to_value(first).unwrap(),
        serde_json::to_value(repeat).unwrap()
    );
    let old = cursor.unwrap();
    let changed = SourceText {
        revision: "10",
        ..source
    };
    assert_eq!(
        segment_source(&changed, Some(&old)).unwrap_err().code,
        "stale_source"
    );
}

#[test]
fn paragraphs_and_fenced_code_are_kept_whole_when_they_fit_the_hard_bound() {
    let key = SourceKey {
        kind: SourceKeyKind::Document,
        id: "structured-guide".into(),
    };
    for prefix in [
        format!("{}\n\n", "首段".repeat(900)),
        format!("```sql\n{}\n```\n", "语".repeat(1700)),
    ] {
        let text = format!("{prefix}{}", "后续解释。".repeat(500));
        let source = SourceText {
            source: &key,
            revision: "1",
            text: &text,
            format: SourceFormat::Markdown,
            background: &[],
        };
        let batch = segment_source(&source, None).unwrap();
        assert_eq!(batch.segments[0].text, prefix);
        assert!(
            batch
                .segments
                .iter()
                .all(|s| s.citation.locator.length <= 2400)
        );
        assert_eq!(
            batch.segments[1].citation.locator.offset,
            prefix.chars().count() as i64 - 160
        );
    }
}

#[test]
fn table_row_groups_repeat_the_original_header_as_separately_cited_background() {
    let key = SourceKey {
        kind: SourceKeyKind::Document,
        id: "voice-stages".into(),
    };
    let header = "|阶段|口径|\n|---|---|\n";
    let text = format!(
        "# 语音阶段\n\n{header}{}\n下一节。",
        format!("|ASR|{}|\n", "首次且未重试".repeat(20)).repeat(60)
    );
    let source = SourceText {
        source: &key,
        revision: "2",
        text: &text,
        format: SourceFormat::Markdown,
        background: &[],
    };
    let batch = segment_source(&source, None).unwrap();
    assert!(batch.segments.len() > 3);
    assert!(batch.segments[0].text.ends_with("|\n"));
    assert!(
        batch.segments[1]
            .background
            .iter()
            .any(|part| part.text == header)
    );
    for segment in &batch.segments {
        assert_eq!(segment.citation.locator.slice(&text).unwrap(), segment.text);
        assert!(
            segment
                .background
                .iter()
                .map(|part| part.text.chars().count())
                .sum::<usize>()
                <= 256
        );
        for part in &segment.background {
            assert_eq!(part.citation.locator.slice(&text).unwrap(), part.text);
            assert_eq!(part.citation.source.id, key.id);
            assert_eq!(part.citation.revision, "2");
        }
    }
}

#[test]
fn sql_keeps_ctes_together_without_treating_quoted_or_commented_punctuation_as_boundaries() {
    let key = SourceKey {
        kind: SourceKeyKind::Platform,
        id: "voice-production-sql".into(),
    };
    let first_cte = format!(
        "WITH first_attempt AS (\r\n  SELECT 'literal ), ; WITH fake AS (' AS note,\r\n    '{}' AS padding\r\n  FROM voice_events /* ), ; not a boundary */\r\n),\r\n",
        "语🧪".repeat(800)
    );
    let text = format!(
        "{first_cte}retries AS (\n  SELECT event_id, '{}' AS reason FROM voice_events\n)\nSELECT first_attempt.note FROM first_attempt JOIN retries USING (event_id);\n",
        "重试范围".repeat(500)
    );
    let source = SourceText {
        source: &key,
        revision: "3",
        text: &text,
        format: SourceFormat::Sql,
        background: &[],
    };
    let batch = segment_source(&source, None).unwrap();
    assert_eq!(batch.segments[0].text, first_cte);
    assert_eq!(
        batch.segments[1].citation.locator.offset,
        first_cte.chars().count() as i64 - 160
    );
    assert!(batch.next_cursor.is_none());
    for segment in batch.segments {
        assert!(segment.citation.locator.length <= 2400);
        assert_eq!(segment.citation.source.id, "voice-production-sql");
        assert_eq!(segment.citation.revision, "3");
        assert_eq!(segment.citation.locator.slice(&text).unwrap(), segment.text);
    }
}

#[test]
fn smaller_batches_resume_without_skipping_or_changing_segment_identity() {
    let key = SourceKey {
        kind: SourceKeyKind::Document,
        id: "capacity-bounded-guide".into(),
    };
    let text = format!("{}最终例外：重试另计。", "语🧪e\u{301}".repeat(20_000));
    let source = SourceText {
        source: &key,
        revision: "4",
        text: &text,
        format: SourceFormat::Text,
        background: &[],
    };
    let collect = |limits: &[usize]| {
        let mut cursor = None;
        let mut segments = Vec::new();
        for page in 0..200 {
            let limit = limits[page % limits.len()];
            let batch = segment_source_with_limit(&source, cursor.as_ref(), limit).unwrap();
            assert!(!batch.segments.is_empty() && batch.segments.len() <= limit);
            segments.extend(batch.segments);
            let Some(next) = batch.next_cursor else {
                return segments;
            };
            cursor = Some(
                serde_json::from_value::<SegmentCursor>(serde_json::to_value(next).unwrap())
                    .unwrap(),
            );
        }
        panic!("有界页必须持续前进并读到文末");
    };
    let fixed = collect(&[64]);
    let varied = collect(&[1, 7, 32, 3, 64]);
    assert!(fixed.len() > 64);
    assert_eq!(
        serde_json::to_value(&fixed).unwrap(),
        serde_json::to_value(&varied).unwrap()
    );
    assert_eq!(
        varied
            .iter()
            .map(|segment| &segment.id)
            .collect::<std::collections::HashSet<_>>()
            .len(),
        varied.len(),
        "重复正文位于不同位置时仍有不同身份"
    );
    assert!(
        varied
            .last()
            .unwrap()
            .text
            .ends_with("最终例外：重试另计。")
    );
    for invalid in [0, 65, usize::MAX] {
        assert_eq!(
            segment_source_with_limit(&source, None, invalid)
                .unwrap_err()
                .code,
            "invalid_input"
        );
    }
}

#[test]
fn char_budget_prefix_keeps_one_segment_and_a_strictly_advancing_cursor() {
    let key = SourceKey {
        kind: SourceKeyKind::Document,
        id: "budget-prefix-guide".into(),
    };
    let text = format!("{}末尾定义：成功才计数。", "口径说明段落。".repeat(4_000));
    let source = SourceText {
        source: &key,
        revision: "2",
        text: &text,
        format: SourceFormat::Text,
        background: &[],
    };
    let full = segment_source(&source, None).unwrap();
    assert!(full.segments.len() > 2);

    // 极小预算仍至少保留一个片段，不会空批。
    let (single, next) =
        data_agent::modules::retrieval::source_segments::prefix_by_char_budget(&full, 1);
    assert_eq!(single.len(), 1);
    let cursor =
        serde_json::from_value::<SegmentCursor>(serde_json::to_value(next.unwrap()).unwrap())
            .unwrap();

    // 从前缀游标续接并按预算推进，最终必须覆盖到文末且与整体分段一致。
    let mut cursor = Some(cursor);
    let mut delivered = Vec::new();
    delivered.extend(single);
    for _ in 0..200 {
        let batch = segment_source(&source, cursor.as_ref()).unwrap();
        let (taken, next) =
            data_agent::modules::retrieval::source_segments::prefix_by_char_budget(&batch, 2_600);
        assert!(!taken.is_empty());
        delivered.extend(taken);
        match next {
            Some(next) => {
                cursor = Some(
                    serde_json::from_value::<SegmentCursor>(serde_json::to_value(next).unwrap())
                        .unwrap(),
                );
            }
            None => break,
        }
    }
    assert!(
        delivered
            .last()
            .unwrap()
            .text
            .ends_with("末尾定义：成功才计数。"),
        "分预算续接仍覆盖文末"
    );
    let whole: Vec<_> = full.segments.iter().map(|s| s.id.clone()).collect();
    let split: Vec<_> = delivered.iter().map(|s| s.id.clone()).collect();
    assert_eq!(whole, split, "按预算续接与整批分段身份一致");
}

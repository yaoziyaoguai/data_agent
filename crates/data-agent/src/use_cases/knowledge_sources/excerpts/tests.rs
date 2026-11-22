use super::*;
use serde_json::json;

fn hit(kind: &str, source: &str, revision: u64, offset: usize, text: &str, score: f64) -> Value {
    json!({"id":format!("{source}-{offset}"),"source_kind":kind,"source_id":source,
        "revision":revision,"offset":offset,"length":text.chars().count(),
        "content_hash":crate::types::fingerprint(&json!(text)),"score":score})
}

fn slice(body: &[char], offset: usize, length: usize) -> String {
    body[offset..offset + length].iter().collect()
}

#[test]
fn windows_merge_by_overlap_keep_distinct_positions_and_report_lag() {
    // 分区字符保证不同窗口的切片文本互不相同，hash核验才有区分力。
    let mut body: Vec<char> = "甲".repeat(60).chars().collect();
    body.extend("乙".repeat(140).chars());
    let text = |offset: usize, length: usize| slice(&body, offset, length);
    let hits = [
        hit("platform", "src", 4, 0, &text(0, 40), 0.03),
        hit("platform", "src", 4, 20, &text(20, 40), 0.02),
        hit("platform", "src", 4, 120, &text(120, 40), 0.01),
        // 修订过期：计滞后，不参与窗口。
        hit("platform", "src", 3, 0, &text(0, 40), 0.5),
        // hash不符（旧offset切新原文失败）：计滞后。
        hit("platform", "src", 4, 60, &text(30, 40), 0.4),
    ];
    let refs = hits.iter().collect::<Vec<_>>();
    let texts = [(0, 40), (20, 40), (120, 40), (60, 40)]
        .into_iter()
        .map(|range @ (offset, length)| (range, text(offset, length)))
        .collect();
    let (merged, lagged) =
        verify_and_merge_windows(&refs, &texts, body.len(), "4", "platform", "src").unwrap();
    assert_eq!(lagged, 2);
    assert_eq!(merged.len(), 2, "相交窗口合并，远端位置保持独立");
    assert_eq!(merged[0]["citation"]["locator"]["offset"], 0);
    assert_eq!(merged[0]["citation"]["locator"]["length"], 60);
    assert_eq!(merged[0]["citation"]["revision"], "4");
    assert_eq!(merged[0]["citation"]["source"]["id"], "src");
    assert_eq!(merged[0]["text"], text(0, 60));
    assert_eq!(merged[1]["citation"]["locator"]["offset"], 120);
}

#[test]
fn merge_cap_keeps_overlapping_windows_separate_beyond_2400() {
    let body: Vec<char> = "据".repeat(4200).chars().collect();
    let text = |offset: usize, length: usize| slice(&body, offset, length);
    // 合并后2400：允许合并。
    let within = [
        hit("platform", "s", 1, 0, &text(0, 2000), 0.02),
        hit("platform", "s", 1, 1600, &text(1600, 800), 0.01),
    ];
    let refs = within.iter().collect::<Vec<_>>();
    let texts = [(0, 2000), (1600, 800), (1900, 2000)]
        .into_iter()
        .map(|range @ (offset, length)| (range, text(offset, length)))
        .collect();
    let (merged, lagged) =
        verify_and_merge_windows(&refs, &texts, body.len(), "1", "platform", "s").unwrap();
    assert_eq!((merged.len(), lagged), (1, 0));
    assert_eq!(merged[0]["citation"]["locator"]["length"], 2400);
    // 相交但合并后超上限：保持独立，不链式合并成全文。
    let beyond = [
        hit("platform", "s", 1, 0, &text(0, 2000), 0.02),
        hit("platform", "s", 1, 1900, &text(1900, 2000), 0.01),
    ];
    let refs = beyond.iter().collect::<Vec<_>>();
    let (merged, _) =
        verify_and_merge_windows(&refs, &texts, body.len(), "1", "platform", "s").unwrap();
    assert_eq!(merged.len(), 2);
    assert!(merged[0]["citation"]["locator"]["length"].as_u64().unwrap() <= 2400);
    assert!(merged[1]["citation"]["locator"]["length"].as_u64().unwrap() <= 2400);
}

// 05接续C：平台来源定点窗口核验——text来自按字符定位的窗口读回（不依赖整篇
// 正文），相交窗口去重叠拼接不重复不丢字；修订/hash不符与未读回窗口计滞后。
#[test]
fn windowed_verify_merges_read_texts_without_full_body() {
    let mut body: Vec<char> = "甲".repeat(60).chars().collect();
    body.extend("乙".repeat(140).chars());
    let text = |offset: usize, length: usize| slice(&body, offset, length);
    let hits = [
        hit("platform", "src", 4, 0, &text(0, 40), 0.03),
        hit("platform", "src", 4, 20, &text(20, 40), 0.02),
        hit("platform", "src", 4, 120, &text(120, 40), 0.01),
        // 修订过期：计滞后。
        hit("platform", "src", 3, 0, &text(0, 40), 0.5),
        // hash不符：计滞后。
        hit("platform", "src", 4, 60, &text(30, 40), 0.4),
    ];
    // 读回的窗口文本：只包含实际请求的(offset,length)。
    let texts: HashMap<(usize, usize), String> =
        [(0usize, 40usize), (20, 40), (120, 40), (0, 40), (60, 40)]
            .into_iter()
            .map(|(offset, length)| ((offset, length), text(offset, length)))
            .collect();
    let refs = hits.iter().collect::<Vec<_>>();
    let (merged, lagged) =
        verify_and_merge_windows(&refs, &texts, body.len(), "4", "platform", "src").unwrap();
    assert_eq!(lagged, 2);
    assert_eq!(merged.len(), 2, "相交窗口合并，远端位置保持独立");
    assert_eq!(merged[0]["citation"]["locator"]["offset"], 0);
    assert_eq!(merged[0]["citation"]["locator"]["length"], 60);
    assert_eq!(
        merged[0]["text"],
        text(0, 60),
        "相交段去重叠拼接：不重复不丢字"
    );
    assert_eq!(
        merged[0]["source_length"],
        body.len() as u64,
        "总长度来自读回的长度列"
    );
    assert_eq!(merged[1]["citation"]["locator"]["offset"], 120);
    // 未读回的窗口（读侧缺该定位文本）：hash无从核验，计滞后不编造。
    let missing: HashMap<(usize, usize), String> = HashMap::new();
    let (merged, lagged) =
        verify_and_merge_windows(&refs, &missing, body.len(), "4", "platform", "src").unwrap();
    assert_eq!(lagged, hits.len());
    assert!(merged.is_empty());
}

#[test]
fn truncated_source_window_cannot_validate_an_out_of_range_locator() {
    let mut indexed = hit("document", "short", 1, 1, "乙", 1.);
    indexed["length"] = json!(9);
    // SUBSTRING会在末尾截短；即使剩余文字的hash相符，也不能交付越界定位。
    let texts = HashMap::from([((1, 9), "乙".to_owned())]);
    let (merged, lagged) =
        verify_and_merge_windows(&[&indexed], &texts, 2, "1", "document", "short").unwrap();
    assert!(merged.is_empty());
    assert_eq!(lagged, 1);
}

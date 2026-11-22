use super::*;

fn source(body: String) -> Value {
    json!({"source_id":"guide","version":"1","body":body,"complete":true})
}
fn material(full: &[Value]) -> Value {
    let mut sources = full.to_vec();
    let mut gaps = Vec::new();
    bound_bodies(&mut sources, &mut gaps).unwrap();
    json!({"object":{"entries":[{"entry_id":"meaning","path":"meaning"}]},"sources":sources,
            "coverage":{"state":if gaps.is_empty(){"complete"}else{"incomplete"},"gaps":gaps}})
}
fn result(quote: &str) -> Value {
    json!({"entries":[{"entry_id":"meaning","value":"合成定义","gaps":[],
            "evidence":[{"source_id":"guide","version":"1","location":"原文","quote":quote}]}]})
}
fn parts(source: &Value) -> Vec<(&str, usize, usize)> {
    std::iter::once((
        source["body"].as_str().unwrap(),
        source["body_range"]["start_byte"].as_u64().unwrap() as usize,
        source["body_range"]["end_byte"].as_u64().unwrap() as usize,
    ))
    .chain(
        source["supporting_excerpts"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|part| {
                (
                    part["body"].as_str().unwrap(),
                    part["start_byte"].as_u64().unwrap() as usize,
                    part["end_byte"].as_u64().unwrap() as usize,
                )
            }),
    )
    .collect()
}

#[test]
fn review_reads_new_tail_and_keeps_old_quotes_without_joining_unseen_text() {
    let body = format!(
        "首部规则：金额以元保存。\n{}中段特殊规则。\n{}尾部例外：撤销记录不计入。\n",
        "常规说明。\n".repeat(1000),
        "合成填充。\n".repeat(1500)
    );
    let full = vec![source(body.clone())];
    let input = material(&full);
    let draft = result("首部规则：金额以元保存。");
    assert!(
        input["sources"][0]["body"]
            .as_str()
            .unwrap()
            .contains("中段特殊规则")
    );
    assert!(
        !input["sources"][0]["body"]
            .as_str()
            .unwrap()
            .contains("尾部例外")
    );
    let review = review_material(&input, &draft, &full).unwrap();
    let visible = parts(&review["sources"][0]);
    assert!(visible.iter().any(|(text, _, _)| text.contains("尾部例外")));
    assert!(visible.iter().any(|(text, _, _)| text.contains("首部规则")));
    assert!(
        !visible
            .iter()
            .any(|(text, _, _)| text.contains("中段特殊规则"))
    );
    assert!(visible.iter().map(|(text, _, _)| text.len()).sum::<usize>() <= MAX_BODY_BYTES);
    for (text, start, end) in visible {
        assert_eq!(text, &body[start..end]);
    }
    let coverage = &review["coverage"]["source_ranges"][0];
    assert_eq!(
        coverage["seen_byte_ranges"],
        json!([{"start":0,"end":body.len()}])
    );
    assert_eq!(coverage["visible_byte_ranges"].as_array().unwrap().len(), 2);
    assert_eq!(review["coverage"]["state"], "incomplete");
    assert_eq!(review["sources"][0]["complete"], false);
    assert!(ingestion::prefill::validate_result(&review, &draft).is_ok());
    assert!(
        ingestion::prefill::validate_result(&review, &result("尾部例外：撤销记录不计入。")).is_ok()
    );
    assert!(ingestion::prefill::validate_result(&review, &result("中段特殊规则。")).is_err());
    let joined = format!(
        "{}{}",
        review["sources"][0]["supporting_excerpts"][0]["body"]
            .as_str()
            .unwrap(),
        review["sources"][0]["body"].as_str().unwrap()
    );
    assert!(ingestion::prefill::validate_result(&review, &result(&joined)).is_err());
}

#[test]
fn huge_sources_keep_precise_unread_ranges_instead_of_claiming_full_coverage() {
    let full = vec![source(format!(
        "规则。\n{}未读尾部。",
        "很长的合成正文。\n".repeat(6000)
    ))];
    let input = material(&full);
    let review = review_material(&input, &result("规则。"), &full).unwrap();
    assert!(
        !parts(&review["sources"][0])
            .iter()
            .any(|(text, _, _)| text.contains("未读尾部"))
    );
    let ranges = &review["coverage"]["source_ranges"][0];
    assert!(
        ranges["seen_byte_ranges"][0]["end"].as_u64().unwrap()
            < full[0]["body"].as_str().unwrap().len() as u64
    );
    assert_eq!(review["coverage"]["gaps"][0]["reason"], "body_limit");
}

#[test]
fn quotes_that_fill_budget_do_not_get_silently_dropped_for_supplement() {
    let full = vec![source("界".repeat(20000))];
    let input = material(&full);
    let quote = input["sources"][0]["body"].as_str().unwrap();
    let draft = result(quote);
    let review = review_material(&input, &draft, &full).unwrap();
    assert_eq!(review["sources"][0]["body"], quote);
    assert!(
        review["coverage"]["gaps"]
            .as_array()
            .unwrap()
            .iter()
            .any(|gap| gap["reason"] == "supplement_capacity")
    );
    assert!(ingestion::prefill::validate_result(&review, &draft).is_ok());
}

#[test]
fn review_keeps_short_material_and_rejects_changed_frozen_source() {
    let full = vec![source("原文说明。".into())];
    let input = material(&full);
    assert_eq!(
        review_material(&input, &result("原文说明。"), &full).unwrap(),
        input
    );
    let mut changed = full.clone();
    changed[0]["version"] = json!("2");
    assert!(review_material(&input, &result("原文说明。"), &changed).is_err());
    changed[0]["version"] = json!("1");
    changed[0]["body"] = json!("原文说明已变。");
    assert!(review_material(&input, &result("原文说明。"), &changed).is_err());
}

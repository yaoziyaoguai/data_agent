use super::*;

fn entry(structure: Value) -> Value {
    json!({"effective_structure":structure,"review_state":"confirmed"})
}

fn snapshot() -> Value {
    json!({"objects":[
            {"id":"purchase","kind":"table","name":"warehouse.purchases","version":"7","state":"enabled",
                "column_names_complete":true,"column_names":["tenant_code","purchase_key","net_minor","event_day","loaded_day"],
                "entries":[entry(json!({"kind":"table","grain":"一行一笔购买",
                    "unique_keys":[["tenant_code","purchase_key"]],"time_columns":[
                        {"column":"event_day","role":"业务发生日"},{"column":"loaded_day","role":"入库日"}],
                    "default_filters":[],"constraints":[]}))]},
            {"id":"line","kind":"table","name":"warehouse.lines","version":"3","state":"enabled",
                "column_names_complete":true,"column_names":["tenant_code","purchase_key","line_key","line_minor"],"entries":[]},
            {"id":"purchase_lines","kind":"relationship","name":"购买关联条目","version":"5","state":"enabled",
                "entries":[entry(json!({"kind":"relationship","left_table":{"object_id":"purchase","version":"7"},
                    "right_table":{"object_id":"line","version":"3"},"join_keys":[
                        {"left_column":"tenant_code","right_column":"tenant_code"},
                        {"left_column":"purchase_key","right_column":"purchase_key"}],
                    "cardinality":"one_to_many","scope":"同一租户内按购买标识关联"}))]}
        ],"coverage":{"state":"complete","notes":[]}})
}

fn with_metric(unit: &str) -> Value {
    let mut snapshot = snapshot();
    snapshot["objects"].as_array_mut().unwrap().extend([
            json!({"id":"purchase_amount","kind":"metric","name":"购买净额","version":"4","state":"enabled",
                "entries":[entry(json!({"kind":"metric","table":{"object_id":"purchase","version":"7"},
                    "expression":"SUM(net_minor)","input_grain":"一行一笔购买","time_column":"event_day",
                    "unit":unit,"required_filters":[],"dimensions":[]}))]}),
            json!({"id":"purchase_net","kind":"field","name":"warehouse.purchases.net_minor","version":"2","state":"enabled",
                "entries":[entry(json!({"kind":"field","table":{"object_id":"purchase","version":"7"},
                    "column":"net_minor","unit":"分"}))]})
        ]);
    snapshot
}

fn state(report: &Value, rule: &str) -> String {
    report["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|check| check["rule"] == rule)
        .unwrap_or_else(|| panic!("missing {rule}: {report}"))["state"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[test]
fn result_annotations_follow_the_bound_projection_and_confirmed_structure() {
    let mut snapshot = with_metric("分");
    let refs = [
        json!({"object_id":"purchase_net","version":"2","path":""}),
        json!({"object_id":"purchase_amount","version":"4","path":"sql"}),
        json!({"object_id":"purchase_amount","version":"4","path":"definition"}),
    ];
    let objects = snapshot["objects"].as_array_mut().unwrap();
    for object in objects {
        match object["kind"].as_str() {
            Some("field") => {
                object["entries"][0]["path"] = json!("meaning");
                object["entries"][0]["effective_value"] = json!("购买净额");
            }
            Some("metric") => object["entries"][0]["path"] = json!("definition"),
            _ => (),
        }
    }
    let mut cols = vec![
        json!({"name":"amount"}),
        json!({"name":"net_minor"}),
        json!({"name":"total"}),
    ];
    annotate_result_columns(
        "SELECT p.net_minor AS amount, p.net_minor / 100 AS net_minor, SUM(p.net_minor) AS total FROM warehouse.purchases p",
        &mut cols,
        &snapshot,
        &refs,
    );
    assert_eq!(cols[0]["display_label"], "购买净额");
    assert_eq!(cols[0]["unit"], "分");
    assert!(cols[1].get("unit").is_none());
    assert_eq!(cols[2]["unit"], "分");
    let objects = snapshot["objects"].as_array_mut().unwrap();
    let metric = objects.iter_mut().find(|o| o["kind"] == "metric").unwrap();
    metric["entries"][0]["path"] = json!("sql");
    let field = objects.iter_mut().find(|o| o["kind"] == "field").unwrap();
    field["entries"][0]["path"] = json!("unit");
    let mut col = [json!({"name":"net_minor"})];
    annotate_result_columns(
        "SELECT * FROM warehouse.purchases",
        &mut col,
        &snapshot,
        &refs,
    );
    assert!(col[0].get("display_label").is_none());
    assert_eq!(col[0]["unit"], "分");
    let field = snapshot["objects"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|o| o["kind"] == "field")
        .unwrap();
    field["entries"].as_array_mut().unwrap().push(
        json!({"path":"meaning","review_state":"confirmed","effective_value":"其他依据的说明"}),
    );
    let unit_ref = [json!({"object_id":"purchase_net","version":"2","path":"unit"})];
    let mut selected = [json!({"name":"net_minor"})];
    annotate_result_columns(
        "SELECT net_minor FROM warehouse.purchases",
        &mut selected,
        &snapshot,
        &unit_ref,
    );
    assert_eq!(selected[0]["unit"], "分");
    assert!(selected[0].get("display_label").is_none());
    let mut total = [json!({"name":"total"})];
    annotate_result_columns(
        "SELECT SUM(net_minor) AS total FROM warehouse.purchases",
        &mut total,
        &snapshot,
        &refs,
    );
    assert_eq!(total[0]["display_label"], "购买净额");
    snapshot["objects"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|o| o["kind"] == "field")
        .unwrap()["entries"][0]["review_state"] = json!("needs_review");
    let mut omitted = [json!({"name":"net_minor"})];
    annotate_result_columns(
        "SELECT net_minor FROM warehouse.purchases",
        &mut omitted,
        &snapshot,
        &refs,
    );
    assert!(omitted[0].get("unit").is_none());
}

#[test]
fn mixed_metric_warns_without_inferring_user_approval_from_the_alias() {
    let mut snapshot = with_metric("分");
    let metric = snapshot["objects"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|o| o["kind"] == "metric")
        .unwrap();
    metric["entries"][0]["effective_structure"]["expression"] =
        json!("COUNT(DISTINCT purchase_key)");
    snapshot["semantic_resolution"] =
        json!({"basis":"explicit_user","interpretation":"不要使用 merged_count"});
    let count = "COUNT(DISTINCT p.purchase_key)";
    let patch = "SUM(CASE WHEN p.purchase_key IS NULL THEN 1 ELSE 0 END)";
    let query = |projection: &str| {
        check_semantics(
            &format!("SELECT {projection} FROM warehouse.purchases p"),
            &json!({}),
            &snapshot,
        )
    };
    let mixed = query(&format!("{count} + {patch} AS merged_count"));
    assert_eq!(state(&mixed, "metric_boundary_mixed"), "warning");
    assert_eq!(state(&mixed, "sql_shape"), "not_checked");
    let separate = query(&format!("{count}, {patch}"));
    assert!(
        separate["checks"]
            .as_array()
            .unwrap()
            .iter()
            .all(|c| c["rule"] != "metric_boundary_mixed")
    );
}

#[test]
fn checked_warning_and_unknown_reports_follow_the_shared_contract() {
    for report in [
        check_semantics(
            &format!("SELECT SUM(p.net_minor) {JOIN}"),
            &json!({}),
            &snapshot(),
        ),
        check_semantics(
            "SELECT SUM(net_minor) FROM warehouse.purchases",
            &json!({}),
            &with_metric("元"),
        ),
        check_semantics(
            "SELECT COUNT(*) FROM warehouse.purchases",
            &json!({}),
            &snapshot(),
        ),
        check_semantics(
            "SELECT SUM(net_minor) FROM warehouse.purchases",
            &json!({}),
            &json!({"objects":[]}),
        ),
    ] {
        crate::contracts::validate("SemanticCheckReport", &report)
            .unwrap_or_else(|error| panic!("{error:?}: {report}"));
    }
}

const JOIN: &str = "FROM warehouse.purchases p LEFT JOIN warehouse.lines d ON d.tenant_code=p.tenant_code AND p.purchase_key=d.purchase_key";

#[test]
fn multi_grain_rewrite_keeps_both_inputs_filters_and_composite_keys() {
    let mut snapshot = with_metric("分");
    snapshot["objects"].as_array_mut().unwrap().push(json!({
        "id":"line_amount","kind":"metric","name":"条目金额","version":"2","state":"enabled",
        "entries":[entry(json!({"kind":"metric","table":{"object_id":"line","version":"3"},
            "expression":"SUM(line_minor)","input_grain":"每行一个条目",
            "required_filters":["line_minor>0"],"dimensions":[],"unit":"分","time_column":null}))]
    }));
    let report = check_semantics(
        &format!("SELECT SUM(p.net_minor),SUM(d.line_minor) {JOIN}"),
        &json!({}),
        &snapshot,
    );
    let outline = report["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|check| check["rule"] == "multi_grain_cte")
        .expect("two distinct metric grains");
    let sql = outline["finding"].as_str().unwrap();
    for fragment in [
        "WITH metric_1 AS",
        "metric_2 AS",
        "SUM(net_minor)",
        "SUM(line_minor)",
        "line_minor>0",
        "GROUP BY \"tenant_code\", \"purchase_key\"",
        "metric_1.join_key_2 = metric_2.join_key_2",
    ] {
        assert!(sql.contains(fragment), "{fragment}: {sql}");
    }
    assert_eq!(outline["state"], "warning");
    let incomplete = check_semantics(
        "SELECT SUM(p.net_minor), SUM(d.line_minor) FROM warehouse.purchases p JOIN warehouse.lines d ON p.purchase_key=d.purchase_key",
        &json!({}),
        &snapshot,
    );
    assert!(
        incomplete["checks"]
            .as_array()
            .unwrap()
            .iter()
            .all(|check| check["rule"] != "multi_grain_cte")
    );
}

#[test]
fn complete_composite_keys_and_one_side_sum_warn_without_blocking() {
    let report = check_semantics(
        &format!("SELECT SUM(p.net_minor) {JOIN}"),
        &json!({}),
        &snapshot(),
    );
    assert_eq!(state(&report, "join_keys"), "checked");
    assert_eq!(state(&report, "aggregate_cardinality"), "warning");
    assert_eq!(report["coverage"]["sql_shape"], "supported");
    assert!(report.get("semantic_passed").is_none());
    assert_eq!(
        report["checks"][1]["evidence_refs"][0],
        json!({"object_id":"purchase_lines","version":"5"})
    );
}

#[test]
fn missing_or_wrong_composite_keys_are_warning_even_with_existing_columns() {
    for condition in [
        "p.purchase_key=d.purchase_key",
        "p.purchase_key=d.line_key AND p.tenant_code=d.tenant_code",
        "p.purchase_key=p.tenant_code AND p.tenant_code=d.tenant_code",
    ] {
        let sql = format!(
            "SELECT SUM(p.net_minor) FROM warehouse.purchases p INNER JOIN warehouse.lines d ON {condition}"
        );
        let report = check_semantics(&sql, &json!({}), &snapshot());
        assert_eq!(state(&report, "join_keys"), "warning", "{condition}");
        assert!(
            !report["checks"]
                .as_array()
                .unwrap()
                .iter()
                .any(|check| check["rule"] == "aggregate_cardinality")
        );
    }
}

#[test]
fn relationship_direction_comes_from_stable_refs_and_not_from_sql_from_order() {
    let report = check_semantics(
        "SELECT SUM(p.net_minor) FROM warehouse.lines d INNER JOIN warehouse.purchases p ON p.purchase_key=d.purchase_key AND p.tenant_code=d.tenant_code",
        &json!({}),
        &snapshot(),
    );
    assert_eq!(state(&report, "join_keys"), "checked");
    assert_eq!(state(&report, "aggregate_cardinality"), "warning");
    let report = check_semantics(
        &format!("SELECT SUM(d.line_minor) {JOIN}"),
        &json!({}),
        &snapshot(),
    );
    assert_eq!(state(&report, "aggregate_cardinality"), "checked");
}

#[test]
fn many_to_one_and_many_to_many_risk_directions_are_distinct() {
    let mut snapshot = snapshot();
    snapshot["objects"][2]["entries"][0]["effective_structure"]["cardinality"] =
        json!("many_to_one");
    assert_eq!(
        state(
            &check_semantics(
                &format!("SELECT SUM(d.line_minor) {JOIN}"),
                &json!({}),
                &snapshot
            ),
            "aggregate_cardinality"
        ),
        "warning"
    );
    assert_eq!(
        state(
            &check_semantics(
                &format!("SELECT SUM(p.net_minor) {JOIN}"),
                &json!({}),
                &snapshot
            ),
            "aggregate_cardinality"
        ),
        "checked"
    );
    snapshot["objects"][2]["entries"][0]["effective_structure"]["cardinality"] =
        json!("many_to_many");
    assert_eq!(
        state(
            &check_semantics(
                &format!("SELECT SUM(p.net_minor) {JOIN}"),
                &json!({}),
                &snapshot
            ),
            "aggregate_cardinality"
        ),
        "warning"
    );
    snapshot["objects"][2]["entries"][0]["effective_structure"]["cardinality"] =
        json!("one_to_one");
    assert_eq!(
        state(
            &check_semantics(
                &format!("SELECT SUM(p.net_minor) {JOIN}"),
                &json!({}),
                &snapshot
            ),
            "aggregate_cardinality"
        ),
        "checked"
    );
}

#[test]
fn stale_disabled_needs_review_and_absent_rules_remain_not_checked() {
    for mutation in 0..5 {
        let mut snapshot = snapshot();
        match mutation {
            0 => {
                snapshot["objects"][2]["entries"][0]["effective_structure"]["left_table"]["version"] =
                    json!("6")
            }
            1 => snapshot["objects"][2]["state"] = json!("disabled"),
            2 => snapshot["objects"][2]["entries"][0]["review_state"] = json!("needs_review"),
            3 => snapshot["objects"][2]["entries"] = json!([]),
            _ => snapshot["objects"][2]["entries"][0]["review_state"] = json!("unverified"),
        }
        let report = check_semantics(
            &format!("SELECT SUM(p.net_minor) {JOIN}"),
            &json!({}),
            &snapshot,
        );
        assert_eq!(state(&report, "join_keys"), "not_checked");
        assert!(
            !report["coverage"]["missing_semantics"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
    assert_eq!(
        state(
            &check_semantics(
                &format!("SELECT SUM(p.net_minor) {JOIN}"),
                &json!({}),
                &json!({"objects":[]})
            ),
            "join_keys"
        ),
        "not_checked"
    );
}

#[test]
fn incomplete_column_catalog_never_claims_expression_or_join_was_checked() {
    let mut snapshot = with_metric("分");
    snapshot["objects"][0]["column_names_complete"] = json!(false);
    let report = check_semantics(
        &format!("SELECT SUM(p.net_minor) {JOIN}"),
        &json!({}),
        &snapshot,
    );
    assert_eq!(state(&report, "join_keys"), "not_checked");
    assert_eq!(state(&report, "metric_expression"), "not_checked");
    assert_eq!(state(&report, "aggregate_columns"), "not_checked");
    assert!(
        !report["coverage"]["missing_semantics"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn ambiguous_relationship_and_unqualified_column_are_not_checked() {
    let mut snapshot = snapshot();
    let mut second = snapshot["objects"][2].clone();
    second["id"] = json!("alternate");
    snapshot["objects"].as_array_mut().unwrap().push(second);
    assert_eq!(
        state(
            &check_semantics(
                &format!("SELECT SUM(p.net_minor) {JOIN}"),
                &json!({}),
                &snapshot
            ),
            "join_keys"
        ),
        "not_checked"
    );
    let report = check_semantics(
        "SELECT SUM(p.net_minor) FROM warehouse.purchases p JOIN warehouse.lines d ON tenant_code=p.tenant_code AND p.purchase_key=d.purchase_key",
        &json!({}),
        &super::tests::snapshot(),
    );
    assert_eq!(state(&report, "join_keys"), "not_checked");
}

#[test]
fn aliases_are_not_used_to_guess_metric_meaning() {
    let report = check_semantics(
        "SELECT SUM(net_minor) AS purchase_amount FROM warehouse.purchases",
        &json!({}),
        &snapshot(),
    );
    assert_eq!(state(&report, "metric_binding"), "not_checked");
    assert!(
        !report["checks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|check| check["rule"] == "metric_unit")
    );
}

#[test]
fn explicitly_bound_metric_matches_direct_sum_time_and_unit() {
    let report = check_semantics(
        "SELECT SUM(p.net_minor) AS total FROM warehouse.purchases p WHERE p.event_day >= :start AND p.event_day < :end",
        &json!({"start":"2035-02-01","end":"2035-03-01"}),
        &with_metric("分"),
    );
    assert_eq!(state(&report, "metric_expression"), "checked");
    assert_eq!(state(&report, "metric_time"), "checked");
    assert_eq!(state(&report, "metric_unit"), "checked");
}

#[test]
fn explicit_time_column_and_unit_mismatches_warn() {
    let report = check_semantics(
        "SELECT SUM(p.net_minor) FROM warehouse.purchases p WHERE p.loaded_day >= '2035-02-01' AND p.loaded_day < '2035-03-01'",
        &json!({}),
        &with_metric("元"),
    );
    assert_eq!(state(&report, "metric_time"), "warning");
    assert_eq!(state(&report, "metric_unit"), "warning");
}

#[test]
fn missing_time_bounds_or_parameters_do_not_claim_checked() {
    for (sql, parameters) in [
        ("SELECT SUM(net_minor) FROM warehouse.purchases", json!({})),
        (
            "SELECT SUM(net_minor) FROM warehouse.purchases WHERE event_day >= :start AND event_day < :end",
            json!({"start":"2035-01-01"}),
        ),
        (
            "SELECT SUM(net_minor) FROM warehouse.purchases WHERE event_day >= '2035-01-01'",
            json!({}),
        ),
    ] {
        assert_eq!(
            state(
                &check_semantics(sql, &parameters, &with_metric("分")),
                "metric_time"
            ),
            "not_checked"
        );
    }
    let report = check_semantics(
        "SELECT SUM(net_minor) FROM warehouse.purchases WHERE '2035-01-01' <= event_day AND '2035-02-01' > event_day",
        &json!({}),
        &with_metric("分"),
    );
    assert_eq!(state(&report, "metric_time"), "checked");
}

#[test]
fn missing_units_and_wrong_metric_expressions_are_explicit() {
    let mut snapshot = with_metric("分");
    snapshot["objects"][4]["entries"][0]["effective_structure"]["unit"] = Value::Null;
    let report = check_semantics(
        "SELECT SUM(net_minor) FROM warehouse.purchases",
        &json!({}),
        &snapshot,
    );
    assert_eq!(state(&report, "metric_unit"), "not_checked");
    let report = check_semantics(
        "SELECT SUM(p.purchase_key) FROM warehouse.purchases p",
        &json!({}),
        &snapshot,
    );
    assert_eq!(state(&report, "metric_expression"), "warning");
    assert!(
        !report["checks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|check| check["rule"] == "metric_unit")
    );
    snapshot["objects"][3]["entries"][0]["effective_structure"]["expression"] =
        json!("SUM(net_minor) / 100");
    assert_eq!(
        state(
            &check_semantics(
                "SELECT SUM(net_minor) FROM warehouse.purchases",
                &json!({}),
                &snapshot
            ),
            "metric_expression"
        ),
        "not_checked"
    );
}

#[test]
fn complex_sql_is_not_checked_instead_of_flagged_as_semantic_failure() {
    for sql in [
        "WITH p AS (SELECT purchase_key, SUM(net_minor) AS net FROM warehouse.purchases GROUP BY purchase_key) SELECT SUM(net) FROM p",
        "SELECT SUM(p.net) FROM (SELECT purchase_key, SUM(net_minor) AS net FROM warehouse.purchases GROUP BY purchase_key) p",
        "SELECT SUM(net_minor) FROM warehouse.purchases UNION ALL SELECT SUM(line_minor) FROM warehouse.lines",
        "SELECT SUM(DISTINCT net_minor) FROM warehouse.purchases",
        "SELECT SUM(net_minor) OVER (PARTITION BY tenant_code) FROM warehouse.purchases",
        "SELECT SUM(net_minor / 100) FROM warehouse.purchases",
        "SELECT COUNT(*) FROM warehouse.purchases",
        "SELECT SUM(net_minor) FROM warehouse.purchases WHERE event_day > '2035-01-01' OR event_day IS NULL",
        "SELECT SUM(p.net_minor) FROM warehouse.purchases p JOIN warehouse.lines d USING(purchase_key)",
        "SELECT SUM(p.net_minor) FROM warehouse.purchases p JOIN warehouse.lines d ON p.purchase_key=d.purchase_key JOIN warehouse.lines e ON e.line_key=d.line_key",
        "SELECT SUM(net_minor) FROM warehouse.purchases; SELECT * FROM warehouse.lines",
    ] {
        let report = check_semantics(sql, &json!({}), &with_metric("分"));
        assert_eq!(state(&report, "sql_shape"), "not_checked", "{sql}");
        assert_eq!(report["coverage"]["sql_shape"], "unsupported");
        assert_eq!(report["checks"].as_array().unwrap().len(), 1);
    }
}

#[test]
fn quoted_table_names_and_column_case_use_ast_identity() {
    let report = check_semantics(
        "SELECT SUM(P.NET_MINOR) FROM \"warehouse\".\"purchases\" AS P JOIN warehouse.lines AS D ON P.TENANT_CODE=D.TENANT_CODE AND P.PURCHASE_KEY=D.PURCHASE_KEY",
        &json!({}),
        &snapshot(),
    );
    assert_eq!(state(&report, "join_keys"), "checked");
    assert_eq!(state(&report, "aggregate_cardinality"), "warning");
}

#[test]
fn malformed_and_overly_deep_sql_are_bounded_parser_failures() {
    for sql in [
        "SELECT (FROM",
        &format!(
            "SELECT {}net_minor{} FROM warehouse.purchases",
            "(".repeat(80),
            ")".repeat(80)
        ),
    ] {
        let report = check_semantics(sql, &json!({}), &snapshot());
        assert_eq!(report["coverage"]["sql_shape"], "unsupported");
    }
}

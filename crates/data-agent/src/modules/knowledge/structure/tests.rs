use super::*;
fn rule() -> Value {
    json!({"kind":"table","grain":"每行一个订单","unique_keys":[["id"]],"time_columns":[],"default_filters":[],"constraints":[]})
}
#[test]
fn proposal_listing_preserves_records_without_entries() {
    let original = json!({"id":"proposal-demo","object_id":"table-demo","base_version":"1",
        "entry_id":"description","value":"建议说明","reason":"核对资料",
        "evidence":[{"object_id":"table-demo","version":"1","path":"description"}],"state":"open"});
    contracts::validate("Proposal", &original).unwrap();
    let mut projected = original.clone();
    project_object(&mut projected);
    assert_eq!(projected, original);
    contracts::validate("Proposal", &projected).unwrap();
}
#[test]
fn manual_text_does_not_reuse_source_structure() {
    let mut entry = json!({"source_facts":{"value":"来源","structured_value":rule()},"suggestion":{},"human_override":{"value":"人工正文"}});
    project_entry(&mut entry);
    assert!(entry["effective_structure"].is_null());
    entry["human_override"] = Value::Null;
    project_entry(&mut entry);
    assert_eq!(entry["effective_structure"], rule());
}
#[test]
fn suggestion_and_structure_are_selected_together() {
    let mut entry = json!({"source_facts":{"value":"来源","structured_value":rule()},"suggestion":{"value":"新建议"},"human_override":null});
    project_entry(&mut entry);
    assert!(entry["effective_structure"].is_null());
    entry["suggestion"]["structured_value"] = rule();
    project_entry(&mut entry);
    assert_eq!(entry["effective_structure"], rule());
}
#[test]
fn editing_another_definition_requires_rule_review() {
    let mut object = json!({"entries":[
        {"entry_id":"definition","effective_structure":rule(),"review_state":"confirmed"},
        {"entry_id":"sql","effective_structure":null,"review_state":"confirmed"}
    ]});
    mark_other_rules_for_review(&mut object, "sql");
    assert_eq!(object["entries"][0]["review_state"], "needs_review");
    assert_eq!(object["entries"][0]["effective_structure"], rule());
    assert_eq!(object["entries"][1]["review_state"], "confirmed");
}
#[test]
fn ddl_columns_handle_quoted_arbitrary_tables_and_partial_fields() {
    let table = json!({"id":"arbitrary","name":"purchase lines","entries":[{"path":"ddl","effective_value":"CREATE TABLE \"purchase lines\" (\"record id\" TEXT PRIMARY KEY, amount INTEGER)"}]});
    assert_eq!(
        columns(&table, &[]),
        (vec!["record id".into(), "amount".into()], true)
    );
    let mut missing = table;
    missing["entries"][0]["effective_value"] = json!("CREATE TABLE unrelated (id TEXT)");
    let fields = vec![json!({"kind":"field","name":"record id","related_ids":["arbitrary"]})];
    assert_eq!(
        columns(&missing, &fields),
        (vec!["record id".into()], false)
    );
}
#[test]
fn structure_kind_and_metadata_paths_are_checked() {
    let object = json!({"kind":"table"});
    assert!(validate_shape(&object, &json!({"path":"grain"}), &rule()).is_ok());
    assert!(validate_shape(&object, &json!({"path":"ddl"}), &rule()).is_err());
    assert!(validate_shape(&json!({"kind":"metric"}), &json!({"path":"body"}), &rule()).is_err());
}
#[test]
fn multiple_rules_and_oversized_structures_are_rejected() {
    let object = json!({"kind":"table","entries":[
        {"effective_structure":rule()}, {"effective_structure":rule()}
    ]});
    assert!(validate_single_structure(&object).is_err());
    let mut large = rule();
    large["constraints"] = json!([
        "约束".repeat(300),
        "约束".repeat(300),
        "约束".repeat(300),
        "约束".repeat(300),
        "约束".repeat(300)
    ]);
    assert!(contracts::validate("SemanticStructure", &large).is_ok());
    assert!(validate_shape(&object, &json!({"path":"description"}), &large).is_err());
}
#[test]
fn stale_table_references_and_unknown_columns_are_rejected() {
    let mut tables = BTreeMap::new();
    tables.insert("orders".into(),json!({"id":"orders","kind":"table","version":"2","column_names":["id"],"column_names_complete":true}));
    assert_eq!(
        table_for(&tables, &json!({"object_id":"orders","version":"1"}))
            .unwrap_err()
            .code,
        "stale_knowledge"
    );
    assert!(check_column(&tables["orders"], "absent").is_err());
    assert!(check_column(&tables["orders"], "ID").is_ok());
}
#[test]
fn structural_dependencies_keep_versions_and_complete_evidence_paths() {
    let object = json!({"entries":[{"effective_structure":{
        "kind":"relationship","left_table":{"object_id":"purchases","version":"4"},
        "right_table":{"object_id":"purchases","version":"5"}
    }}]});
    let refs = structure_dependencies(&object);
    assert_eq!(
        refs,
        json!([
            {"object_id":"purchases","version":"4","path":"ddl"},
            {"object_id":"purchases","version":"5","path":"ddl"}
        ])
        .as_array()
        .unwrap()
        .clone()
    );
    for reference in refs {
        assert!(contracts::validate("EvidenceRef", &reference).is_ok());
    }
}
#[test]
fn query_example_dependencies_keep_document_paths_and_verification_evidence() {
    let refs = structure_dependencies(&json!({"entries":[{"effective_structure":{
        "kind":"query_example",
        "dependencies":[
            {"object_id":"table","version":"2","path":"ddl"},
            {"object_id":"guide","version":"3","path":"grain"},
            {"object_id":"guide","version":"3","path":"limits"}
        ],
        "verification":{"note":"已核对","evidence_refs":[
            {"object_id":"guide","version":"3","path":"grain"},
            {"object_id":"metric","version":"4","path":"body"}
        ]}
    }}]}));
    assert_eq!(
        refs,
        json!([
            {"object_id":"table","version":"2","path":"ddl"},
            {"object_id":"guide","version":"3","path":"grain"},
            {"object_id":"guide","version":"3","path":"limits"},
            {"object_id":"metric","version":"4","path":"body"}
        ])
        .as_array()
        .unwrap()
        .clone()
    );
}
#[test]
fn query_example_rejects_empty_questions_and_duplicate_parameter_names() {
    let mut structure = json!({"kind":"query_example","applicable_question":"按标签统计商品行数",
        "parameters":[{"name":"cohort","type":"string","description":"结果标签","required":true}],
        "sql":"SELECT :cohort, COUNT(*) FROM purchases","grain":"单行汇总",
        "dependencies":[{"object_id":"purchases","version":"1","path":"ddl"}],"verification":null});
    let object = json!({"kind":"query_example"});
    assert!(validate_shape(&object, &json!({"path":"body"}), &structure).is_ok());
    assert!(validate_bindings(&object, &structure, &BTreeMap::new()).is_ok());
    let duplicate = structure["parameters"][0].clone();
    structure["parameters"]
        .as_array_mut()
        .unwrap()
        .push(duplicate);
    assert!(validate_bindings(&object, &structure, &BTreeMap::new()).is_err());
    structure["parameters"] = json!([]);
    structure["applicable_question"] = json!("  ");
    assert!(validate_bindings(&object, &structure, &BTreeMap::new()).is_err());
}
#[test]
fn directly_bound_metric_columns_are_checked_without_compiling_complex_sql() {
    let table = json!({"name":"purchases","column_names":["gross"],"column_names_complete":true});
    assert!(check_metric_expression(&table, "SUM(gross) / 100").is_ok());
    assert!(check_metric_expression(&table, "SUM(absent) / 100").is_err());
    assert!(check_metric_expression(&table, "SUM(purchases.absent)").is_err());
    assert!(check_metric_expression(&table, "SELECT SUM(gross) FROM purchases").is_ok());
    assert!(check_metric_expression(&table, "SUM(").is_err());
}

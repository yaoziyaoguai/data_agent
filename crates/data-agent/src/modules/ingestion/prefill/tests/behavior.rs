use super::*;

#[test]
fn business_domain_keeps_the_explicit_declaration_and_does_not_guess_from_words() {
    let quote = "业务域标识：`合成零售`。全部合成对象属于本域。";
    let base = json!({"id":"any-table","entries":[{"path":"business_domain","source_facts":{
        "source_id":"business-guide","version":"1","value":"合成零售","quote":quote,
        "classification":"authored_definition","complete":true
    },"effective_value":"合成零售","suggestion":{},"human_override":null}]});
    let mut present = base.clone();
    refresh_facts(
        &mut present,
        &[json!({"source_id":"business-guide","version":"2","body":quote})],
    );
    assert_eq!(present["entries"][0]["effective_value"], "合成零售");
    assert_eq!(present["entries"][0]["source_facts"]["quote"], quote);
    assert_eq!(present["entries"][0]["source_facts"]["version"], "2");
    let mut missing = base;
    refresh_facts(
        &mut missing,
        &[
            json!({"source_id":"business-guide","version":"2","body":"仅提及合成零售，但域指定已撤下。"}),
        ],
    );
    assert_eq!(missing["entries"][0]["source_facts"]["complete"], false);
    assert_eq!(missing["entries"][0]["effective_value"], "");
}

#[test]
fn authored_multiline_value_survives_escaped_source_and_expires_with_its_quote() {
    let value = "分子：成功轮次\n分母：合格轮次";
    let quote = json!({"description":value}).to_string();
    let base = json!({"id":"metric-example","entries":[{"path":"definition",
        "source_facts":{"source_id":"rules","version":"1","value":value,"quote":quote,
        "classification":"authored_definition"},"suggestion":{},"effective_value":value,"human_override":null}]});
    let mut current = base.clone();
    refresh_facts(
        &mut current,
        &[json!({"source_id":"rules","version":"2","body":quote})],
    );
    assert_eq!(current["entries"][0]["effective_value"], value);
    assert_eq!(current["entries"][0]["source_facts"]["value"], value);
    assert_eq!(current["entries"][0]["suggestion"], json!({}));
    let mut removed = base.clone();
    refresh_facts(
        &mut removed,
        &[json!({"source_id":"rules","version":"3","body":"新定义不再包含旧映射"})],
    );
    assert_eq!(removed["entries"][0]["effective_value"], "");
    let mut manual = base;
    manual["entries"][0]["human_override"] = json!({"value":"人工当前解释"});
    manual["entries"][0]["effective_value"] = json!("人工当前解释");
    refresh_facts(
        &mut manual,
        &[json!({"source_id":"rules","version":"3","body":"新定义"})],
    );
    assert_eq!(manual["entries"][0]["effective_value"], "人工当前解释");
}

#[test]
fn malformed_and_truncated_responses_keep_diagnostics_without_becoming_valid() {
    for (content, reason) in [
        ("{\"entries\":[", Some("stop")),
        ("{\"entries\":[]}", Some("length")),
    ] {
        let output = decode_response(content, reason);
        assert!(output["invalid_response"].is_object());
        assert_eq!(output["invalid_response"]["content"], content);
        assert!(validate_result(&input(), &output).is_err());
    }
}

#[test]
fn only_one_complete_named_tool_result_is_accepted() {
    let output =
        json!({"entries":[entry("meaning","含义",json!([])),entry("boundary","边界",json!([]))]});
    let call = json!({"type":"function","function":{"name":"submit_semantic_prefill","arguments":output.to_string()}});
    let valid = json!({"finish_reason":"tool_calls","message":{"tool_calls":[call.clone()]}});
    assert_eq!(decode_completion(&valid), output);
    for invalid in [
        json!({"finish_reason":"stop","message":{"content":output.to_string()}}),
        json!({"finish_reason":"tool_calls","message":{"tool_calls":[call.clone(),call.clone()]}}),
        json!({"finish_reason":"tool_calls","message":{"tool_calls":[{"type":"function","function":{"name":"other","arguments":output.to_string()}}]}}),
        json!({"finish_reason":"length","message":{"tool_calls":[call]}}),
    ] {
        let decoded = decode_completion(&invalid);
        assert!(decoded["invalid_response"].is_object());
        assert!(validate_result(&input(), &decoded).is_err());
    }
}

fn input() -> Value {
    json!({"object":{"entries":[
        {"entry_id":"type","path":"type","suggestion":{"value":"INTEGER"}},
        {"entry_id":"meaning","path":"meaning","suggestion":{"value":"旧建议"}},
        {"entry_id":"boundary","path":"boundary","suggestion":{"value":"旧边界"}}
    ]},"sources":[{"source_id":"schema","version":"1","body":"合成来源原文"}]})
}

fn entry(id: &str, value: &str, gaps: Value) -> Value {
    json!({"entry_id":id,"value":value,"gaps":gaps,"evidence":[{
        "source_id":"schema","version":"1","location":"字段定义","quote":"合成来源原文"
    }]})
}

#[test]
fn incomplete_or_irrelevant_result_is_rejected() {
    for entries in [
        json!([]),
        json!([entry("type", "INTEGER", json!([]))]),
        json!([entry("meaning", "含义", json!([]))]),
        json!([
            entry("meaning", "含义", json!([])),
            entry("boundary", "边界", json!([])),
            entry("type", "INTEGER", json!([]))
        ]),
    ] {
        assert!(validate_result(&input(), &json!({"entries":entries})).is_err());
    }
}

#[test]
fn blank_explanation_requires_a_real_gap() {
    for gaps in [json!([]), json!([""]), json!(["  "])] {
        let result = json!({"entries":[
            entry("meaning", "  ", gaps),
            entry("boundary", "边界", json!([]))
        ]});
        assert!(validate_result(&input(), &result).is_err());
    }
    let result = json!({"entries":[
        entry("meaning", "", json!(["没有业务定义资料"])),
        entry("boundary", "仅解释已给定范围", json!([]))
    ]});
    assert!(validate_result(&input(), &result).is_ok());
}

#[test]
fn every_semantic_entry_is_updated_without_changing_source_facts() {
    let result = json!({"entries":[
        entry("boundary", "新边界", json!([])),
        entry("meaning", "新含义", json!([]))
    ]});
    let candidate = validate_result(&input(), &result).expect("完整建议合法");
    assert_eq!(candidate["entries"][0]["suggestion"]["value"], "INTEGER");
    assert_eq!(candidate["entries"][1]["suggestion"]["value"], "新含义");
    assert_eq!(candidate["entries"][2]["suggestion"]["value"], "新边界");
    let mut wrong_version = result.clone();
    wrong_version["entries"][0]["evidence"][0]["version"] = json!("2");
    assert!(
        validate_result(&input(), &wrong_version).is_err(),
        "相同原句的错误来源修订仍拒绝"
    );
    let mut forged = result;
    forged["entries"][0]["evidence"][0]["quote"] = json!("没有交付的伪造原句");
    assert!(
        validate_result(&input(), &forged).is_err(),
        "有正确来源身份也不能引用未交付原句"
    );
}
#[test]
fn source_structure_needs_its_own_current_quote() {
    let structure = json!({"kind":"table","grain":"一行一个订单","unique_keys":[],"time_columns":[],"default_filters":[],"constraints":[]});
    let quote = structure.to_string();
    let entry = json!({"source_facts":{"structured_value":structure,"structured_evidence":[{"source_id":"guide","version":"1","quote":quote,"location":"rules"}]}});
    let source = json!({"source_id":"guide","version":"9","body":format!("规则：{quote}")});
    let (value, evidence) = source_structure(&entry, &[source]).expect("明确结构出处仍在");
    assert_eq!(value, structure);
    assert_eq!(evidence[0]["version"], "9");
    assert!(
        source_structure(
            &entry,
            &[json!({"source_id":"guide","version":"10","body":"已移除旧计算规则"})]
        )
        .is_none()
    );
}
#[test]
fn prefill_keeps_structural_candidates_without_claiming_formal_projection() {
    let mut original = input();
    original["object"]["kind"] = json!("table");
    original["object"]["entries"][1]["source_facts"]["structured_value"] = json!({"kind":"table","grain":"旧规则","unique_keys":[],"time_columns":[],"default_filters":[],"constraints":[]});
    original["object"]["entries"][1]["effective_structure"] =
        original["object"]["entries"][1]["source_facts"]["structured_value"].clone();
    let result = json!({"entries":[entry("meaning","新含义",json!([])),entry("boundary","新边界",json!([]))]});
    let candidate = validate_result(&original, &result).expect("新建议完整");
    assert!(candidate["entries"][1].get("effective_structure").is_none());
    assert_eq!(
        candidate["entries"][1]["source_facts"]["structured_value"],
        original["object"]["entries"][1]["source_facts"]["structured_value"]
    );
    assert!(candidate["entries"][1]["suggestion"]["structured_value"].is_null());
}
#[test]
fn review_draft_reuses_quotes_without_losing_per_entry_evidence() {
    let original = json!({"entries":[entry("meaning","含义",json!([])),entry("boundary","边界",json!(["缺口"]))]});
    let compact = review_draft(&original);
    assert!(compact.to_string().len() < original.to_string().len());
    assert_eq!(compact["evidence_catalog"].as_array().unwrap().len(), 1);
    let mut restored = compact.clone();
    let catalog = restored
        .as_object_mut()
        .unwrap()
        .remove("evidence_catalog")
        .unwrap();
    for entry in restored["entries"].as_array_mut().unwrap() {
        let indices = entry
            .as_object_mut()
            .unwrap()
            .remove("evidence_indices")
            .unwrap();
        entry["evidence"] = json!(
            indices
                .as_array()
                .unwrap()
                .iter()
                .map(|i| catalog[i.as_u64().unwrap() as usize].clone())
                .collect::<Vec<_>>()
        );
    }
    assert_eq!(restored, original);
}

fn token_dense_material() -> Value {
    let list = vec!["0"; 5000].join(",");
    let table = json!({"id":"synthetic-dense-table","name":"t","platform_version":"1","comment":"",
        "columns":[{"id":"v","name":"v","data_type":"INTEGER","nullable":false,"comment":""}],
        "ddl":"CREATE TABLE t(v INTEGER NOT NULL);","node":{"id":"synthetic-load","sql":format!("INSERT INTO t SELECT v FROM raw_values WHERE v IN ({list});"),"upstream_ids":[]}});
    let ctx = crate::types::AccessContext {
        user_id: "synthetic-prefill-owner".into(),
        space_id: "synthetic-prefill-space".into(),
        request_id: "synthetic-prefill-request".into(),
        table_access: None,
    };
    let object = super::super::catalog::objects(&ctx, "synthetic-capacity", &table, 1)
        .unwrap()
        .remove(0);
    let body = super::super::catalog::source_text(&table);
    assert!(body.len() < 24576, "合法来源仍在现有正文容量内");
    assert_eq!(
        body.matches(&list).count(),
        2,
        "生产来源同时保留元数据和原加工SQL"
    );
    json!({"sources":[{"source_id":object["source_id"],"version":"1","body":body,"complete":true,
        "body_range":{"start_byte":0,"end_byte":body.len(),"start_line":1,"total_bytes":body.len()}}],
        "object":object,"frozen_review_sources":[],"coverage":{"state":"complete","source_ranges":[],"gaps":[]}})
}

#[test]
#[ignore = "requires the controlled prefill URL provided by check-prefill-materials"]
fn token_dense_analysis_is_rejected_before_maintenance_reservation() {
    let profile = crate::contracts::decode("ModelProfile",json!({"provider_id":"deepseek","model_id":"deepseek-flash","trial_id":"synthetic-input-capacity","price_version":"2026-10-04-peak-usd","input_limit":4096,"output_limit":4096,"toolset":"data","payload_bytes_limit":65536,"thinking_level":"high","budget_mode":"request"})).unwrap();
    // 官方预分词的数字隔离规则使每份5000项列表至少9999 token；两份已超过4096。
    match prepare(&token_dense_material(), &profile) {
        Err(error) => assert_eq!(error.code, "payload_limit"),
        Ok(prepared) => {
            let request = prepared.request.build().unwrap();
            let bytes = request.body().unwrap().as_bytes().unwrap().len();
            assert!(bytes <= 65536, "反例不能先被旧字节门挡住");
            panic!("合法请求{bytes}字节、可见输入至少19998 token，不能按4096 token签发预留");
        }
    }
}

#[test]
#[ignore = "requires the controlled prefill URL provided by check-prefill-materials"]
fn token_dense_review_is_rejected_before_its_second_reservation() {
    let profile = crate::contracts::decode("ModelProfile",json!({"provider_id":"deepseek","model_id":"deepseek-flash","trial_id":"synthetic-review-capacity","price_version":"2026-10-04-peak-usd","input_limit":32768,"output_limit":32768,"toolset":"data","payload_bytes_limit":65536,"thinking_level":"high","budget_mode":"request"})).unwrap();
    let input = token_dense_material();
    let entries: Vec<_> = ["description","grain","time","keys","filters","metrics","limitations"].into_iter().enumerate().map(|(index,id)|json!({"entry_id":id,"value":if index==0 {vec!["0";9000].join(",")} else {"仅说明已给定的合成材料".into()},"gaps":[],"evidence":[{"source_id":input["sources"][0]["source_id"],"version":"1","location":"L1","quote":"# 平台原始元数据"}]})).collect();
    let draft = json!({"entries":entries});
    validate_result(&input, &draft).unwrap();
    // 合法草稿再带至少17999 token，加上两份SQL列表后至少37997，输出cap足够生成此草稿。
    match prepare_review(&input, &profile, &draft) {
        Err(error) => assert_eq!(error.code, "payload_limit"),
        Ok(prepared) => {
            let request = prepared.request.build().unwrap();
            let bytes = request.body().unwrap().as_bytes().unwrap().len();
            assert!(bytes <= 65536, "复核反例也必须低于旧字节门");
            panic!("合法复核{bytes}字节、输入至少37997 token，不能按32768 token签发预留");
        }
    }
}

#[test]
fn provider_tool_schema_resolves_nested_structural_references() {
    let schema = prefill_parameters().unwrap();
    let validator = jsonschema::validator_for(&schema).expect("外发的独立Schema可解析");
    let structure = json!({"kind":"field","table":{"object_id":"purchases","version":"2"},"column":"gross","unit":null});
    let result = json!({"entries":[{"entry_id":"unit","value":"金额单位尚未定义","structured_value":structure,"gaps":[],"evidence":[{"source_id":"guide","version":"2","quote":"金额","location":"L1"}]}]});
    assert!(validator.is_valid(&result));
    let mut bad = result;
    bad["entries"][0]["structured_value"]["table"]["version"] = json!("not-a-version");
    assert!(!validator.is_valid(&bad));
}

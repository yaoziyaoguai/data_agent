use serde_json::{Value, json};

pub const SEARCH_REPLY_LIMIT: usize = 24 * 1024;
// 留出工具operation_id/name及JSON envelope的空间；模型接收的完整回执仍有上限。
const CONTENT_LIMIT: usize = SEARCH_REPLY_LIMIT - 512;

/// 工具专用相关条目投影；HTTP完整对象和现有目录preview不受影响。
pub fn search_preview(mut object: Value, query: &str) -> Value {
    super::attach_lexical_matches(&mut object, query);
    let excerpts = object["retrieval"]["excerpts"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if let Some(entries) = object.get_mut("entries").and_then(Value::as_array_mut) {
        let original_count = entries.len();
        if !excerpts.is_empty() {
            entries.retain(|entry| {
                excerpts
                    .iter()
                    .any(|excerpt| excerpt["entry_id"] == entry["entry_id"])
            });
            entries.truncate(3);
        } else {
            let tokens = super::tokens(query);
            entries.sort_by_key(|entry| {
                std::cmp::Reverse(
                    tokens
                        .iter()
                        .filter(|token| {
                            ["label", "path"].iter().any(|key| {
                                entry[*key]
                                    .as_str()
                                    .unwrap_or("")
                                    .to_lowercase()
                                    .contains(token.as_str())
                            })
                        })
                        .count(),
                )
            });
            entries.truncate(3);
        }
        for entry in entries.iter_mut() {
            let (_, page) =
                super::text_page(entry["effective_value"].as_str().unwrap_or(""), 0, 160);
            entry["content_page"] = page;
        }
        object["entries_complete"] = json!(entries.len() == original_count);
    }
    compact_object(super::preview(object), false)
}

/// 按实际UTF8 JSON体积逐项交付。资产ID先全部保留，不能因裁剪跳过目录游标之前的资产。
pub fn bounded_search_reply(data: Value) -> Value {
    let objects = items(&data, "objects");
    let memories = items(&data, "personal_memories");
    let skills = items(&data, "selected_skills");
    let mut reply = json!({"objects":[],"personal_memories":memories.iter().map(|v|asset_view(v,true)).collect::<Vec<_>>(),
        "selected_skills":skills.iter().map(|v|asset_view(v,true)).collect::<Vec<_>>(),
        "next_asset_after":data["next_asset_after"],"asset_total":data["asset_total"],
        "asset_cursor_invalid":data["asset_cursor_invalid"],
        "search_coverage":bounded_metadata(&data["search_coverage"],0),
        "search_scope":data["search_scope"],
        "memory_retrieval":bounded_metadata(&data["memory_retrieval"],0),
        "retrieval_mode":bounded_metadata(&data["retrieval_mode"],0),
        "note":"片段与目录只覆盖当前回执范围。此范围未找到资料时，空结果不能证明不存在；按同版对象补读或调整范围。资产游标只用于个人资产目录。",
        "reply_coverage":{"state":"bounded","byte_limit":SEARCH_REPLY_LIMIT,"content_limit":CONTENT_LIMIT,
            "returned_object_count":0,"omitted_objects":objects.iter().map(object_ref).collect::<Vec<_>>(),
            "note":"state只说明该次目录交付，正文和空间覆盖另看分页/检索范围。对象与资产可按同版标识补读；省略引用均为当前有权对象。"}});
    if bytes(&reply) > CONTENT_LIMIT {
        return json!({"error":"request_too_large","hint":"当前资产与引用目录无法完整交付，请减小limit后重试。未推进资产游标。"});
    }
    let mut bounded = objects.iter().any(|object| {
        object.get("name_complete") == Some(&json!(false))
            || object.get("entries_complete") == Some(&json!(false))
    }) || bounded_metadata(&data["search_coverage"], 0)
        != data["search_coverage"]
        || bounded_metadata(&data["memory_retrieval"], 0) != data["memory_retrieval"]
        || bounded_metadata(&data["search_scope"], 0) != data["search_scope"];
    for (key, originals) in [
        ("personal_memories", &memories),
        ("selected_skills", &skills),
    ] {
        for (index, asset) in originals.iter().enumerate() {
            let original = reply[key][index].clone();
            reply[key][index] = asset_view(asset, false);
            if bytes(&reply) > CONTENT_LIMIT {
                reply[key][index] = original;
                bounded = true;
            } else if reply[key][index] != *asset {
                bounded = true;
            }
        }
    }
    for object in &objects {
        let omitted = reply["reply_coverage"]["omitted_objects"].clone();
        let delivered = reply["objects"].clone();
        let refs = reply["reply_coverage"]["omitted_objects"]
            .as_array_mut()
            .expect("references");
        if let Some(index) = refs.iter().position(|reference| {
            reference["object_id"] == object["id"] && reference["version"] == object["version"]
        }) {
            refs.remove(index);
        }
        reply["objects"]
            .as_array_mut()
            .expect("objects")
            .push(compact_object(object.clone(), false));
        reply["reply_coverage"]["returned_object_count"] =
            json!(reply["objects"].as_array().expect("objects").len());
        if bytes(&reply) > CONTENT_LIMIT {
            let last = reply["objects"]
                .as_array_mut()
                .expect("objects")
                .last_mut()
                .expect("last object");
            *last = compact_object(object.clone(), true);
            bounded = true;
        }
        if bytes(&reply) > CONTENT_LIMIT {
            reply["objects"] = delivered;
            reply["reply_coverage"]["omitted_objects"] = omitted;
            reply["reply_coverage"]["returned_object_count"] =
                json!(reply["objects"].as_array().expect("objects").len());
            bounded = true;
        }
    }
    if !bounded
        && reply["reply_coverage"]["omitted_objects"]
            .as_array()
            .is_some_and(|refs| refs.is_empty())
    {
        reply["reply_coverage"]["state"] = json!("complete");
        if bytes(&reply) > CONTENT_LIMIT {
            reply["reply_coverage"]["state"] = json!("bounded");
        }
    }
    debug_assert!(bytes(&reply) <= CONTENT_LIMIT);
    reply
}

fn items(data: &Value, key: &str) -> Vec<Value> {
    data[key].as_array().cloned().unwrap_or_default()
}

fn bytes(value: &Value) -> usize {
    serde_json::to_vec(value).expect("JSON value").len()
}

fn object_ref(object: &Value) -> Value {
    json!({"object_id":object["id"],"version":object["version"]})
}

fn short(value: &Value, limit: usize) -> Value {
    value.as_str().map_or(Value::Null, |text| {
        json!(text.chars().take(limit).collect::<String>())
    })
}

fn bounded_metadata(value: &Value, depth: usize) -> Value {
    match value {
        Value::String(_) => short(value, 80),
        Value::Array(values) if depth < 3 => json!(
            values
                .iter()
                .take(8)
                .map(|value| bounded_metadata(value, depth + 1))
                .collect::<Vec<_>>()
        ),
        Value::Object(values) if depth < 3 => Value::Object(
            values
                .iter()
                .take(12)
                .map(|(key, value)| {
                    (
                        key.chars().take(80).collect(),
                        bounded_metadata(value, depth + 1),
                    )
                })
                .collect(),
        ),
        Value::Array(_) | Value::Object(_) => Value::Null,
        value => value.clone(),
    }
}

fn asset_view(asset: &Value, minimal: bool) -> Value {
    let mut result = json!({"id":asset["id"],"kind":asset["kind"],"version":asset["version"],
        "name":short(&asset["name"],if minimal{40}else{160}),"name_complete":asset["name_complete"]!=false && asset["name"].as_str().is_some_and(|name|name.chars().count()<=if minimal{40}else{160}),
        "selected":asset["selected"]});
    if asset["kind"] == "skill" {
        result["native_path"] = asset["native_path"].clone();
        result["visibility"] = asset["visibility"].clone();
        result["scope"] = short(&asset["scope"], if minimal { 0 } else { 160 });
        result["scope_complete"] = json!(
            !minimal
                && asset["scope_complete"] != false
                && asset["scope"]
                    .as_str()
                    .is_some_and(|scope| scope.chars().count() <= 160)
        );
    } else {
        result["object_id"] = asset["object_id"].clone();
        result["verified"] = asset["verified"].clone();
        for (key, page_key) in [("body", "content_page"), ("scope", "scope_page")] {
            let text = asset[key].as_str().unwrap_or("");
            let length = if minimal { 0 } else { 160 };
            let output = text.chars().take(length).collect::<String>();
            let total = asset[page_key]["total_chars"]
                .as_u64()
                .unwrap_or(text.chars().count() as u64);
            let end = output.chars().count();
            result[key] = json!(output);
            result[page_key] = json!({"offset":0,"total_chars":total,"complete":asset[page_key]["complete"]==true && end as u64>=total,
                "next_offset":if (end as u64)<total{Some(end)}else{None}});
        }
    }
    result
}

fn compact_object(object: Value, minimal: bool) -> Value {
    let mut result = json!({"id":object["id"],"kind":object["kind"],"name":short(&object["name"],if minimal{40}else{160}),
        "name_complete":object["name_complete"]!=false && object["name"].as_str().is_some_and(|name|name.chars().count()<=if minimal{40}else{160}),
        "version":object["version"],"state":object["state"],
        "entries_complete":object["entries_complete"]!=false && object["entries"].as_array().is_some_and(|entries|entries.len()<=3),
        "related_ids":object["related_ids"].as_array().map(|ids|ids.iter().take(8).cloned().collect::<Vec<_>>()).unwrap_or_default(),
        "related_ids_complete":object["related_ids_complete"]!=false && object["related_ids"].as_array().is_none_or(|ids|ids.len()<=8),"entries":[]});
    // 结构正文可以分页；已核验的依赖仍须进入宿主采用清单。
    if let Some(summary) = object.get("query_example_summary") {
        result["query_example_summary"] = if minimal {
            json!({"applicable_question":short(&summary["applicable_question"],80),
                "question_complete":false,"parameters":[],"parameters_complete":false,
                "verification_recorded":summary["verification_recorded"],
                "note":"案例摘要已裁剪，采用前须用同版read_knowledge补读结构与参数。"})
        } else {
            summary.clone()
        };
    }
    if let Some(dependencies) = object.get("structure_dependencies") {
        result["structure_dependencies"] = dependencies.clone();
    }
    for entry in object["entries"].as_array().into_iter().flatten().take(3) {
        let text = entry["effective_value"].as_str().unwrap_or("");
        let (body, page) = super::text_page(text, 0, if minimal { 0 } else { 160 });
        let available =
            entry["structure_available"] == true || !entry["effective_structure"].is_null();
        let structure = &entry["effective_structure"];
        let full_structure = !minimal && !structure.is_null() && bytes(structure) <= 1024;
        let mut summary = json!({"entry_id":entry["entry_id"],"path":short(&entry["path"],if minimal{40}else{128}),
            "label":short(&entry["label"],if minimal{40}else{80}),"effective_value":body,
            "review_state":entry["review_state"],"content_page":entry.get("content_page").cloned().unwrap_or(page),
            "source_facts":{"source_id":entry["source_facts"]["source_id"],"version":entry["source_facts"]["version"]},
            "suggestion":bounded_metadata(&entry["suggestion"],0),
            "human_override":if entry["human_override"].is_null(){Value::Null}else{json!({"has_override":true})},
            "structure_available":available,"effective_structure":if full_structure{structure.clone()}else{Value::Null},
            "structure_page":{"complete":full_structure,"next_offset":if available && !full_structure{Some(0)}else{None}}});
        let delivered = body.chars().count() as u64;
        let total = summary["content_page"]["total_chars"]
            .as_u64()
            .unwrap_or(text.chars().count() as u64);
        summary["content_page"]["complete"] = json!(delivered >= total);
        summary["content_page"]["next_offset"] = json!(if delivered < total {
            Some(delivered)
        } else {
            None
        });
        result["entries"]
            .as_array_mut()
            .expect("entries")
            .push(summary);
    }
    if let Some(retrieval) = object.get("retrieval") {
        let mut retrieval = retrieval.clone();
        if minimal {
            retrieval["excerpts"] = json!([]);
            retrieval["state"] = json!("unlocated");
            retrieval["note"] = json!(
                "原命中片段因回执体积省略，请按本对象同版标识及条目补读。目录开头不是命中片段。"
            );
        }
        result["retrieval"] = retrieval;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legitimate_long_scope_is_returned_without_changing_the_applied_filter() {
        let scope = json!({"kinds":["document"],"related_object_id":"table-reference","business_domain":"业务域🌏".repeat(30)});
        let mut original = data(vec![]);
        original["search_scope"] = scope.clone();
        let reply = bounded_search_reply(original);
        assert_eq!(reply["search_scope"], scope);
        assert!(bytes(&reply) <= CONTENT_LIMIT);
    }

    fn object(index: usize) -> Value {
        json!({"id":format!("doc-{index}"),"kind":"document","name":"中文资料🌏".repeat(800),"version":"17","state":"enabled",
            "related_ids":[],"entries":(0..12).map(|entry|json!({"entry_id":format!("entry-{entry}"),"path":format!("part-{entry}"),
                "label":"业务规则", "effective_value":format!("{}设备校准超过有效期后必须停用。{}","前言🌏".repeat(500),"补充说明".repeat(100)),
                "source_facts":{"source_id":"manual-source","version":"6","value":"不应进入工具的完整来源".repeat(500)},
                "suggestion":{},"human_override":null,"review_state":"confirmed","effective_structure":null})).collect::<Vec<_>>()})
    }

    fn data(objects: Vec<Value>) -> Value {
        json!({"objects":objects,"personal_memories":[],"selected_skills":[],"next_asset_after":null,
            "asset_total":0,"asset_cursor_invalid":false,"search_coverage":{"state":"complete","vector_state":"unconfigured","index_state":"unconfigured"},
            "memory_retrieval":{"state":"unconfigured"},"retrieval_mode":"lexical_authoritative"})
    }

    #[test]
    fn selected_entries_keep_current_tail_excerpt_and_bounded_prefix_with_correct_pages() {
        let mut original = object(1);
        original["entries"][0]["effective_value"] = json!("与设备无关的登记信息");
        let preview = search_preview(original.clone(), "校准有效期");
        assert_eq!(preview["entries"].as_array().unwrap().len(), 3);
        assert_eq!(preview["entries_complete"], false);
        assert!(
            !preview["entries"]
                .as_array()
                .unwrap()
                .iter()
                .any(|entry| entry["entry_id"] == "entry-0")
        );
        let excerpt = &preview["retrieval"]["excerpts"][0];
        assert_eq!(preview["retrieval"]["channel"], "lexical");
        assert!(excerpt["offset"].as_u64().unwrap() > 600);
        let entry = preview["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["entry_id"] == excerpt["entry_id"])
            .unwrap();
        let full = original["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["entry_id"] == excerpt["entry_id"])
            .unwrap()["effective_value"]
            .as_str()
            .unwrap();
        assert_eq!(entry["content_page"]["total_chars"], full.chars().count());
        assert_eq!(entry["content_page"]["complete"], false);
        assert_eq!(entry["content_page"]["next_offset"], 160);
        assert!(!preview.to_string().contains("不应进入工具的完整来源"));
    }

    #[test]
    fn full_utf8_reply_and_envelope_fit_limit_and_every_object_remains_readable() {
        let objects = (0..30)
            .map(|index| search_preview(object(index), "设备校准有效期"))
            .collect::<Vec<_>>();
        let reply = bounded_search_reply(data(objects.clone()));
        assert!(reply.get("error").is_none());
        assert!(bytes(&reply) <= CONTENT_LIMIT);
        let envelope =
            json!({"operation_id":"0".repeat(64),"tool_name":"search_knowledge","data":reply});
        assert!(bytes(&envelope) <= SEARCH_REPLY_LIMIT);
        let encoded = serde_json::to_vec(&envelope).unwrap();
        let decoded: Value = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(decoded, envelope);
        let ids = objects
            .iter()
            .map(|object| object["id"].clone())
            .collect::<Vec<_>>();
        let delivered = reply["objects"]
            .as_array()
            .unwrap()
            .iter()
            .map(|object| object["id"].clone())
            .chain(
                reply["reply_coverage"]["omitted_objects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|object| object["object_id"].clone()),
            )
            .collect::<Vec<_>>();
        assert_eq!(delivered.len(), ids.len());
        assert!(ids.iter().all(|id| delivered.contains(id)));
        for reference in reply["reply_coverage"]["omitted_objects"]
            .as_array()
            .unwrap()
        {
            assert_eq!(reference["version"], "17");
        }
        assert_eq!(reply["reply_coverage"]["state"], "bounded");
    }

    #[test]
    fn asset_ids_and_cursor_survive_body_budget_without_skipping_a_page_member() {
        let memories=(0..30).map(|index|json!({"id":format!("memory-{index}"),"object_id":format!("asset-memory-{index}"),
            "kind":"memory","version":"3","name":"个人约定🙂".repeat(100),"body":"正文需要补读🌏".repeat(500),
            "scope":"仅限该个人特定分析".repeat(500),"content_page":{"total_chars":5000,"complete":false},
            "scope_page":{"total_chars":5000,"complete":false},"verified":false,"selected":false})).collect::<Vec<_>>();
        let skills=(0..10).map(|index|json!({"id":format!("skill-{index}"),"kind":"skill","version":"4","name":"分析方法🌏".repeat(100),
            "scope":"限定方法范围".repeat(100),"selected":true,"visibility":"personal","native_path":format!("/skills/skill-{index}/4/SKILL.md")})).collect::<Vec<_>>();
        let mut input = data(
            (0..30)
                .map(|index| search_preview(object(index), "校准有效期"))
                .collect(),
        );
        input["personal_memories"] = json!(memories);
        input["selected_skills"] = json!(skills);
        input["next_asset_after"] = json!("memory-29");
        input["asset_total"] = json!(100);
        let reply = bounded_search_reply(input);
        assert!(reply.get("error").is_none());
        assert!(bytes(&reply) <= CONTENT_LIMIT);
        assert_eq!(reply["next_asset_after"], "memory-29");
        assert_eq!(reply["asset_total"], 100);
        assert_eq!(
            reply["personal_memories"].as_array().unwrap().len(),
            memories.len()
        );
        for (original, delivered) in memories
            .iter()
            .zip(reply["personal_memories"].as_array().unwrap())
        {
            assert_eq!(delivered["id"], original["id"]);
            assert_eq!(delivered["object_id"], original["object_id"]);
            assert_eq!(delivered["version"], original["version"]);
            assert_eq!(delivered["content_page"]["complete"], false);
        }
        for (original, delivered) in skills
            .iter()
            .zip(reply["selected_skills"].as_array().unwrap())
        {
            assert_eq!(original["native_path"], delivered["native_path"]);
        }
    }

    #[test]
    fn oversized_identity_metadata_fails_explicitly_instead_of_advancing_asset_cursor() {
        let mut input = data(vec![]);
        input["personal_memories"] = json!([{"id":"a".repeat(SEARCH_REPLY_LIMIT),"kind":"memory","version":"1","body":"x","scope":"y"}]);
        input["next_asset_after"] = json!("never-advance");
        let reply = bounded_search_reply(input);
        assert_eq!(reply["error"], "request_too_large");
        assert!(reply.get("next_asset_after").is_none());
        assert!(bytes(&reply) < SEARCH_REPLY_LIMIT);
    }

    #[test]
    fn empty_reply_preserves_scoped_coverage_and_does_not_claim_global_absence() {
        let mut input = data(vec![]);
        input["search_coverage"] = json!({"state":"scope_empty","scope":{"kinds":["metric"],"business_domain":"设备管理"}});
        input["search_scope"] = json!({"kinds":["metric"],"business_domain":"设备管理","related_object_id":"known-table"});
        let reply = bounded_search_reply(input);
        assert_eq!(reply["objects"], json!([]));
        assert_eq!(reply["search_coverage"]["state"], "scope_empty");
        assert_eq!(
            reply["search_coverage"]["scope"]["business_domain"],
            "设备管理"
        );
        assert_eq!(
            reply["search_scope"],
            json!({"kinds":["metric"],"business_domain":"设备管理","related_object_id":"known-table"})
        );
        assert!(
            reply["note"]
                .as_str()
                .unwrap()
                .contains("空结果不能证明不存在")
        );
    }

    #[test]
    fn oversized_structure_keeps_whole_json_for_same_version_paginated_read() {
        let mut object = object(7);
        object["entries"][0]["effective_value"] = json!("设备校准限制");
        object["entries"][0]["effective_structure"] =
            json!({"kind":"metric","expression":"SUM(value)","constraints":"限制".repeat(3000)});
        let preview = search_preview(object, "设备校准限制");
        let entry = preview["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["entry_id"] == "entry-0")
            .unwrap();
        assert_eq!(entry["structure_available"], true);
        assert!(entry["effective_structure"].is_null());
        assert_eq!(entry["structure_page"]["complete"], false);
        assert_eq!(entry["structure_page"]["next_offset"], 0);
        assert_eq!(preview["version"], "17");
    }
}

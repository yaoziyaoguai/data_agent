use serde_json::Value;
// 词法通道始终可用；向量候选必须回源后再由组合层合并。
pub fn rank(mut objects: Vec<Value>, query: &str, limit: usize) -> Vec<Value> {
    let tokens = tokens(query);
    let score = |v: &Value| {
        let name = v["name"].as_str().unwrap_or("").to_lowercase();
        let all = v.to_string().to_lowercase();
        tokens
            .iter()
            .map(|t| {
                if name.contains(t) {
                    8
                } else if all.contains(t) {
                    1
                } else {
                    0
                }
            })
            .sum::<u32>()
    };
    objects.sort_by_key(|v| std::cmp::Reverse(score(v)));
    objects.retain(|v| score(v) > 0);
    objects.truncate(limit);
    objects
}

pub fn rank_hybrid(
    objects: Vec<Value>,
    query: &str,
    limit: usize,
    vectors: &[Value],
) -> Vec<Value> {
    let lexical = rank(objects.clone(), query, objects.len());
    let score = |object: &Value| {
        let exact = object["id"]
            .as_str()
            .is_some_and(|v| v.eq_ignore_ascii_case(query))
            || object["name"]
                .as_str()
                .is_some_and(|v| v.eq_ignore_ascii_case(query));
        let lexical = lexical
            .iter()
            .position(|v| v["id"] == object["id"])
            .map_or(0., |r| 1. / (20. + r as f64));
        let vector = vectors
            .iter()
            .position(|v| v["id"] == object["id"] && v["version"] == object["version"])
            .map_or(0., |r| 1. / (20. + r as f64));
        if exact { 100. } else { lexical + vector }
    };
    let mut objects = objects;
    objects.retain(|v| score(v) > 0.);
    objects.sort_by(|a, b| {
        score(b)
            .total_cmp(&score(a))
            .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
    });
    let mut selected = Vec::new();
    let mut seen = std::collections::HashSet::new();
    if let Some(first) = objects.first() {
        seen.insert(first["id"].clone());
        selected.push(first.clone());
    }
    if limit >= 6 {
        for kind in [
            "table",
            "field",
            "metric",
            "document",
            "relationship",
            "term",
        ] {
            if selected.len() >= limit {
                break;
            }
            if selected.iter().any(|v| v["kind"] == kind) {
                continue;
            }
            if let Some(object) = objects.iter().find(|v| v["kind"] == kind) {
                seen.insert(object["id"].clone());
                selected.push(object.clone());
            }
        }
    }
    for object in objects {
        if selected.len() >= limit {
            break;
        }
        if seen.insert(object["id"].clone()) {
            selected.push(object);
        }
    }
    selected
}
mod store;
pub use store::{candidates_in_tx, index_in_tx};
// 检索先返回短摘录；全文由read_knowledge按当前授权版本读取。
pub fn preview(mut object: Value) -> Value {
    if let Some(entries) = object.get_mut("entries").and_then(Value::as_array_mut) {
        for entry in entries {
            let text = entry["effective_value"].as_str().unwrap_or("");
            let limit = if entry["path"] == "sql" { 2048 } else { 600 };
            let complete = text.chars().count() <= limit;
            entry["effective_value"] =
                serde_json::json!(text.chars().take(limit).collect::<String>());
            entry["source_facts"] = serde_json::json!({"source_id":entry["source_facts"]["source_id"],"version":entry["source_facts"]["version"],"location":entry["source_facts"]["location"],"excerpt_complete":complete});
            entry["suggestion"] = suggestion_preview(entry);
            if !entry["human_override"].is_null() {
                entry["human_override"] = serde_json::json!({"edited_by":entry["human_override"]["edited_by"],"has_override":true});
            }
        }
    }
    object
}

pub fn text_page(text: &str, offset: usize, limit: usize) -> (String, Value) {
    let total = text.chars().count();
    let body = text.chars().skip(offset).take(limit).collect::<String>();
    let end = offset.saturating_add(body.chars().count());
    (
        body,
        serde_json::json!({"offset":offset,"total_chars":total,"complete":offset==0 && end>=total,"next_offset":if end<total{Some(end)}else{None}}),
    )
}

fn suggestion_preview(entry: &Value) -> Value {
    if entry["suggestion"]
        .as_object()
        .is_none_or(|value| value.is_empty())
    {
        return serde_json::json!({});
    }
    serde_json::json!({
        "application": if entry["human_override"].is_null() { "effective" } else { "pending_review" },
        "analysis_state": entry["suggestion"]["analysis_state"],
        "details_available": true
    })
}

// 建议正文与有效值分别分页；人工覆盖后的建议只作待复核材料。
fn suggestion_page(entry: &Value, offset: usize, limit: usize) -> (Value, usize) {
    let mut value = suggestion_preview(entry);
    if value["details_available"] != true {
        return (value, 0);
    }
    let mut details = serde_json::json!({
        "gaps":entry["suggestion"]["gaps"],
        "evidence":entry["suggestion"]["evidence"],
        "validated":entry["suggestion"]["validated"]
    });
    if let Some(coverage) = entry["suggestion"].get("material_coverage") {
        details["material_coverage"] = coverage.clone();
    }
    if !entry["human_override"].is_null() {
        details["value"] = entry["suggestion"]["value"].clone();
    }
    let (body, page) = text_page(&details.to_string(), offset, limit);
    let size = body.chars().count();
    value["details"] = serde_json::json!(body);
    value["content_page"] = page;
    (value, size)
}

// 模型按条目/字符范围读正文；保留来源标识，避免人工和建议的重复正文占满上下文。
pub fn model_page(mut object: Value, offset: usize, limit: usize, entry_id: Option<&str>) -> Value {
    if let Some(value) = object.as_object_mut() {
        value.remove("memory_index_state");
    }
    let asset_scope = object.get("scope").is_some() && entry_id == Some("scope");
    if let Some(body) = object["body"].as_str() {
        let (body, page) = text_page(
            body,
            if asset_scope { 0 } else { offset },
            if asset_scope { 0 } else { limit },
        );
        object["body"] = serde_json::json!(body);
        object["content_page"] = page;
        if object.get("source_text").is_some() {
            object["source_text"] = serde_json::json!("");
        }
    }
    if let Some(scope) = object["scope"].as_str() {
        let (value, page) = text_page(
            scope,
            if asset_scope { offset } else { 0 },
            if asset_scope { limit } else { 160 },
        );
        object["scope"] = serde_json::json!(value);
        object["scope_page"] = page;
    }
    if let Some(name) = object["name"].as_str() {
        object["name"] = serde_json::json!(name.chars().take(160).collect::<String>());
    }
    let mut remaining = limit;
    let mut analysis_remaining = limit;
    if let Some(entries) = object.get_mut("entries").and_then(Value::as_array_mut) {
        if let Some(selected) = entry_id {
            entries.retain(|e| e["entry_id"] == selected);
        }
        for entry in entries {
            let (suggestion, size) = suggestion_page(entry, offset, analysis_remaining);
            analysis_remaining = analysis_remaining.saturating_sub(size);
            let (body, page) = text_page(
                entry["effective_value"].as_str().unwrap_or(""),
                offset,
                remaining,
            );
            remaining = remaining.saturating_sub(body.chars().count());
            entry["effective_value"] = serde_json::json!(body);
            entry["content_page"] = page;
            entry["source_facts"] = serde_json::json!({"source_id":entry["source_facts"]["source_id"],"version":entry["source_facts"]["version"],"location":entry["source_facts"]["location"],"gap":entry["source_facts"]["gap"]});
            entry["suggestion"] = suggestion;
            if !entry["human_override"].is_null() {
                entry["human_override"] = serde_json::json!({"edited_by":entry["human_override"]["edited_by"],"has_override":true});
            }
        }
    }
    object
}

pub fn tokens(query: &str) -> Vec<String> {
    let query = query.to_lowercase();
    let mut tokens: Vec<String> = query
        .split(|c: char| c.is_whitespace() || c.is_ascii_punctuation())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    let chars: Vec<char> = query.chars().collect();
    tokens.extend(
        chars
            .windows(2)
            .filter(|w| w.iter().all(|c| !c.is_ascii()))
            .map(|w| w.iter().collect()),
    );
    tokens
}

// 目录按稳定ID分页；检索检查全体有效资产，启动候选裁剪不影响可发现性。
pub fn asset_directory(
    mut items: Vec<Value>,
    query: &str,
    after: Option<&str>,
    limit: usize,
) -> Value {
    let tokens = tokens(query);
    items.retain(|v| {
        query == "*"
            || tokens.iter().any(|token| {
                ["name", "body", "scope"]
                    .iter()
                    .any(|key| v[key].as_str().unwrap_or("").to_lowercase().contains(token))
            })
    });
    items.sort_by(|a, b| {
        let exact = |v: &Value| {
            v["name"]
                .as_str()
                .unwrap_or("")
                .to_lowercase()
                .contains(&query.to_lowercase())
        };
        exact(b)
            .cmp(&exact(a))
            .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
    });
    let total = items.len();
    if let Some(after) = after {
        let Some(index) = items.iter().position(|v| v["id"] == after) else {
            return serde_json::json!({"memories":[],"selected_skills":[],"next_asset_after":null,"total":total,"cursor_invalid":true});
        };
        items.drain(..=index);
    }
    let mut page = Vec::new();
    let mut next = None;
    for item in &items {
        if page.len() >= limit || serde_json::to_vec(&page).expect("asset directory").len() > 10000
        {
            next = page.last().map(|v: &Value| v["id"].clone());
            break;
        }
        let (body, content_page) = text_page(item["body"].as_str().unwrap_or(""), 0, 160);
        let (scope, scope_page) = text_page(item["scope"].as_str().unwrap_or(""), 0, 160);
        page.push(serde_json::json!({"id":item["id"],"object_id":format!("asset-{}",item["id"].as_str().unwrap_or("")),"kind":item["kind"],"version":item["version"],"name":item["name"].as_str().unwrap_or("").chars().take(160).collect::<String>(),"body":body,"content_page":content_page,"scope":scope,"scope_page":scope_page,"verified":item["verified"],"selected":item["selected"]}));
    }
    serde_json::json!({"memories":page.iter().filter(|v|v["kind"]=="memory").collect::<Vec<_>>(),"selected_skills":page.iter().filter(|v|v["kind"]=="skill").collect::<Vec<_>>(),"next_asset_after":next,"total":total})
}

pub fn bound_workspace(context: &mut Value) {
    if let Some(tasks) = context["tasks"].as_array_mut() {
        for task in tasks {
            if let Some(goal) = task["goal"].as_str() {
                task["goal"] = serde_json::json!(goal.chars().take(240).collect::<String>());
            }
        }
    }
    if let Some(messages) = context["recent_messages"].as_array_mut() {
        for message in messages {
            if let Some(text) = message["text"].as_str() {
                message["text"] = serde_json::json!(text.chars().take(300).collect::<String>());
            }
        }
    }
    for index in 0..context["tasks"].as_array().map_or(0, Vec::len) {
        if context.to_string().len() <= 16000 {
            break;
        }
        context["tasks"][index]["conditions"] = Value::Null;
        context["tasks"][index]["clarification"] = Value::Null;
        context["tasks"][index]["context_complete"] = serde_json::json!(false);
    }
    for key in ["recent_messages", "memories", "selected_skills", "tasks"] {
        while context.to_string().len() > 16000
            && context[key].as_array().is_some_and(|a| !a.is_empty())
        {
            let items = context[key].as_array_mut().expect("context array");
            if key == "memories" {
                items.pop();
            } else {
                items.remove(0);
            }
        }
    }
}

pub mod embedding;
pub mod vector;

#[cfg(test)]
mod semantic_context_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn model_can_read_all_analysis_gaps_and_evidence_across_pages() {
        let details = json!({"gaps":["税费规则未提供", "上游验证范围待补充".repeat(60)],
            "evidence":[{"source_id":"upstream","version":"2","location":"L1","quote":"上游计算规则"},
                {"source_id":"business-guide","version":"3","location":"L9","quote":"业务范围"}],
            "validated":"引用已核对，业务含义待确认"});
        let object = json!({"entries":[{"entry_id":"meaning","effective_value":"当前定义", "source_facts":{},
            "suggestion":details,"human_override":null}]});
        let mut joined = String::new();
        let mut offset = 0;
        loop {
            let page = model_page(object.clone(), offset, 100, Some("meaning"));
            let suggestion = &page["entries"][0]["suggestion"];
            assert_eq!(suggestion["application"], "effective");
            joined.push_str(suggestion["details"].as_str().unwrap());
            match suggestion["content_page"]["next_offset"].as_u64() {
                Some(next) => {
                    assert!(next as usize > offset);
                    offset = next as usize;
                }
                None => break,
            }
        }
        assert_eq!(serde_json::from_str::<Value>(&joined).unwrap(), details);
    }

    #[test]
    fn human_definition_and_unadopted_analysis_stay_distinct() {
        let object = json!({"entries":[{"entry_id":"meaning","effective_value":"人工定义",
            "source_facts":{},"suggestion":{"value":"新分析","gaps":["未确定范围"],"evidence":[]},
            "human_override":{"edited_by":"alice"}}]});
        let directory = preview(object.clone());
        assert_eq!(
            directory["entries"][0]["suggestion"]["details_available"],
            true
        );
        let page = model_page(object, 0, 4096, Some("meaning"));
        assert_eq!(page["entries"][0]["effective_value"], "人工定义");
        assert_eq!(
            page["entries"][0]["suggestion"]["application"],
            "pending_review"
        );
        assert_eq!(page["entries"][0]["human_override"]["has_override"], true);
        let details: Value = serde_json::from_str(
            page["entries"][0]["suggestion"]["details"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(details["value"], "新分析");
        assert!(
            page["entries"][0]["suggestion"]["details"]
                .as_str()
                .unwrap()
                .contains("未确定范围")
        );
    }
}

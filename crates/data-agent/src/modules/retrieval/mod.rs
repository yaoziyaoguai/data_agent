use serde_json::Value;
use std::collections::HashMap;

// 词法通道始终可用；正文序列化和词法计分每个对象只做一次。
fn lexical_score(object: &Value, tokens: &[String]) -> u32 {
    let name = object["name"].as_str().unwrap_or("").to_lowercase();
    let all = object.to_string().to_lowercase();
    tokens
        .iter()
        .map(|token| {
            if name.contains(token) {
                8
            } else if all.contains(token) {
                1
            } else {
                0
            }
        })
        .sum()
}

pub fn rank(objects: Vec<Value>, query: &str, limit: usize) -> Vec<Value> {
    let tokens = tokens(query);
    let mut scored: Vec<_> = objects
        .into_iter()
        .map(|object| {
            let score = lexical_score(&object, &tokens);
            (object, score)
        })
        .filter(|(_, score)| *score > 0)
        .collect();
    scored.sort_by_key(|(_, score)| std::cmp::Reverse(*score));
    scored
        .into_iter()
        .take(limit)
        .map(|(object, _)| object)
        .collect()
}

pub fn rank_hybrid(
    objects: Vec<Value>,
    query: &str,
    limit: usize,
    vectors: &[Value],
) -> Vec<Value> {
    let tokens = tokens(query);
    let mut lexical: Vec<_> = objects
        .iter()
        .map(|object| (object["id"].clone(), lexical_score(object, &tokens)))
        .filter(|(_, score)| *score > 0)
        .collect();
    lexical.sort_by_key(|(_, score)| std::cmp::Reverse(*score));
    let mut lexical_ranks = HashMap::new();
    for (rank, (id, _)) in lexical.into_iter().enumerate() {
        lexical_ranks.entry(id).or_insert(rank);
    }
    let mut vector_ranks = HashMap::new();
    for (rank, vector) in vectors.iter().enumerate() {
        vector_ranks
            .entry((vector["id"].clone(), vector["version"].clone()))
            .or_insert(rank);
    }
    let mut scored: Vec<_> = objects
        .into_iter()
        .map(|object| {
            let exact = object["id"]
                .as_str()
                .is_some_and(|v| v.eq_ignore_ascii_case(query))
                || object["name"]
                    .as_str()
                    .is_some_and(|v| v.eq_ignore_ascii_case(query));
            let lexical = lexical_ranks
                .get(&object["id"])
                .map_or(0., |r| 1. / (20. + *r as f64));
            let vector = vector_ranks
                .get(&(object["id"].clone(), object["version"].clone()))
                .map_or(0., |r| 1. / (20. + *r as f64));
            let score = if exact { 100. } else { lexical + vector };
            (object, score)
        })
        .filter(|(_, score)| *score > 0.)
        .collect();
    scored.sort_by(|(a, a_score), (b, b_score)| {
        b_score
            .total_cmp(a_score)
            .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
    });
    let objects: Vec<_> = scored.into_iter().map(|(object, _)| object).collect();
    let mut seen = std::collections::HashSet::new();
    // 先保住最相关的三项，类型覆盖只能使用余位，不能挤走同类强命中。
    let mut selected: Vec<_> = objects
        .iter()
        .filter(|object| seen.insert(object["id"].clone()))
        .take(limit.min(3))
        .cloned()
        .collect();
    if limit >= 6 {
        for kind in [
            "table",
            "field",
            "metric",
            "query_example",
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
mod excerpts;
pub use excerpts::{attach_lexical_matches, attach_matches};
mod search_reply;
pub use search_reply::{SEARCH_REPLY_LIMIT, bounded_search_reply, search_preview};
mod store;
pub use store::{candidates_in_tx, candidates_scoped_in_tx, index_in_tx};
// 检索先返回短摘录；全文由read_knowledge按当前授权版本读取。
pub fn preview(mut object: Value) -> Value {
    if let Some(summary) = query_example_summary(&object) {
        object["query_example_summary"] = summary;
    }
    let mut structure_budget = 4096;
    if let Some(entries) = object.get_mut("entries").and_then(Value::as_array_mut) {
        for entry in entries {
            bounded_structure(entry, &mut structure_budget);
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

fn query_example_summary(object: &Value) -> Option<Value> {
    if object["kind"] != "query_example" {
        return None;
    }
    let structure = object["entries"]
        .as_array()?
        .iter()
        .map(|entry| &entry["effective_structure"])
        .find(|structure| structure["kind"] == "query_example")?;
    let question = structure["applicable_question"].as_str().unwrap_or("");
    let parameters = structure["parameters"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    Some(serde_json::json!({
        "applicable_question":question.chars().take(400).collect::<String>(),
        "question_complete":question.chars().count()<=400,
        "parameters":parameters.iter().take(12).map(|parameter| serde_json::json!({
            "name":parameter["name"],"type":parameter["type"],"required":parameter["required"],
            "description":parameter["description"].as_str().unwrap_or("").chars().take(120).collect::<String>(),
            "description_complete":parameter["description"].as_str().is_some_and(|text|text.chars().count()<=120)
        })).collect::<Vec<_>>(),
        "parameters_complete":parameters.len()<=12,
        "verification_recorded":!structure["verification"].is_null(),
        "note":"适用问题与参数是案例摘要，采用前须用同版read_knowledge读取完整结构并核对依赖。核对记录来自维护者，不授予SQL执行权限。"
    }))
}

pub(super) fn query_example_index_text(entry: &Value) -> String {
    let structure = &entry["effective_structure"];
    if structure["kind"] != "query_example" {
        return String::new();
    }
    let parameters = structure["parameters"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|parameter| {
            format!(
                "{} {} {}",
                parameter["name"].as_str().unwrap_or(""),
                parameter["type"].as_str().unwrap_or(""),
                parameter["description"].as_str().unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join("；");
    format!(
        "适用问题：{}；参数：{}；",
        structure["applicable_question"].as_str().unwrap_or(""),
        parameters
    )
}

fn bounded_structure(entry: &mut Value, remaining: &mut usize) {
    let structure = entry["effective_structure"].clone();
    if structure.is_null() {
        entry["structure_available"] = serde_json::json!(false);
        return;
    }
    let size = structure.to_string().len();
    entry["structure_available"] = serde_json::json!(true);
    if size > *remaining {
        entry["effective_structure"] = Value::Null;
        entry["structure_page"] = serde_json::json!({"complete":false,"next_offset":0});
    } else {
        *remaining -= size;
        entry["structure_page"] = serde_json::json!({"complete":true,"next_offset":null});
    }
}

// 大结构独立分页；只在完整读取时返回可采用的结构对象，不生成截断JSON。
pub fn model_structure_page(
    mut object: Value,
    offset: usize,
    limit: usize,
    entry_id: Option<&str>,
) -> Value {
    if let Some(entries) = object.get_mut("entries").and_then(Value::as_array_mut) {
        if let Some(entry_id) = entry_id {
            entries.retain(|entry| entry["entry_id"] == entry_id);
        }
        let mut remaining = limit;
        for entry in entries {
            let structure = entry["effective_structure"].clone();
            let (text, page) = text_page(&structure.to_string(), offset, remaining);
            remaining = remaining.saturating_sub(text.chars().count());
            *entry = serde_json::json!({"entry_id":entry["entry_id"],"path":entry["path"],"label":entry["label"],"review_state":entry["review_state"],"structure_available":!structure.is_null(),"effective_structure":if page["complete"]==true{structure}else{Value::Null},"structure_text":text,"structure_page":page});
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
    let mut structure_budget = 4096;
    if let Some(value) = object.as_object_mut() {
        value.remove("memory_index_state");
        value.remove("files");
        value.remove("can_edit");
    }
    let asset_scope = object.get("scope").is_some() && entry_id == Some("scope");
    let asset_source = object.get("source_text").is_some() && entry_id == Some("source_text");
    if let Some(source) = object["source_text"].as_str() {
        // 缺省只声明来源可补读；原话按同一资产版本独立分页，保留尾部限定。
        let (value, page) = text_page(
            source,
            if asset_source { offset } else { 0 },
            if asset_source { limit } else { 0 },
        );
        object["source_text"] = serde_json::json!(value);
        object["source_page"] = page;
    }
    if let Some(body) = object["body"].as_str() {
        let (body, page) = text_page(
            body,
            if asset_scope || asset_source {
                0
            } else {
                offset
            },
            if asset_scope || asset_source {
                0
            } else {
                limit
            },
        );
        object["body"] = serde_json::json!(body);
        object["content_page"] = page;
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
            bounded_structure(entry, &mut structure_budget);
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
    let normalized_query = query.to_lowercase();
    let name_match = |v: &Value| {
        let name = v["name"].as_str().unwrap_or("").to_lowercase();
        (name == normalized_query, name.contains(&normalized_query))
    };
    items.sort_by(|a, b| {
        name_match(b)
            .cmp(&name_match(a))
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
        let name = item["name"].as_str().unwrap_or("");
        let name_complete = name.chars().count() <= 160;
        if item["kind"] == "skill" {
            // 目录仅交付元信息；正文由 Pi 原生 read 经受控入口加载。
            page.push(serde_json::json!({"id":item["id"],"kind":"skill","version":item["version"],"name":name.chars().take(160).collect::<String>(),"name_complete":name_complete,"scope":item["scope"].as_str().unwrap_or("").chars().take(160).collect::<String>(),"scope_complete":item["scope"].as_str().is_some_and(|scope|scope.chars().count()<=160),"selected":true,"visibility":item["visibility"],"native_path":format!("/skills/{}/{}/SKILL.md",item["id"].as_str().unwrap_or(""),item["version"].as_str().unwrap_or(""))}));
            continue;
        }
        let (body, content_page) = text_page(item["body"].as_str().unwrap_or(""), 0, 160);
        let (scope, scope_page) = text_page(item["scope"].as_str().unwrap_or(""), 0, 160);
        page.push(serde_json::json!({"id":item["id"],"object_id":format!("asset-{}",item["id"].as_str().unwrap_or("")),"kind":item["kind"],"version":item["version"],"name":name.chars().take(160).collect::<String>(),"name_complete":name_complete,"body":body,"content_page":content_page,"scope":scope,"scope_page":scope_page,"verified":item["verified"],"selected":item["selected"]}));
    }
    serde_json::json!({"memories":page.iter().filter(|v|v["kind"]=="memory").collect::<Vec<_>>(),"selected_skills":page.iter().filter(|v|v["kind"]=="skill").collect::<Vec<_>>(),"next_asset_after":next,"total":total})
}

pub fn bound_workspace(context: &mut Value) {
    // authority只用于宿主校验，不进入模型；Mem0补充候选时也使用同一可见预算。
    let oversized = |value: &Value| {
        let mut visible = value.clone();
        if let Some(fields) = visible.as_object_mut() {
            fields.remove("authority_snapshot");
            fields.remove("authority_revision");
        }
        visible.to_string().len() > 16000
    };
    let input_tasks = context["input_task_ids"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    context["recent_messages"] = serde_json::json!([]);
    if let Some(tasks) = context["tasks"].as_array_mut() {
        for task in tasks {
            if let Some(goal) = task["goal"].as_str()
                && goal.chars().count() > 240
            {
                task["goal"] = serde_json::json!(goal.chars().take(240).collect::<String>());
                task["context_complete"] = serde_json::json!(false);
            }
        }
    }
    // 候选已按当前归属、最近消息排序，从低优先级端裁剪，先保全当前任务的条件/问题。
    let task_count = context["tasks"].as_array().map_or(0, Vec::len);
    for index in (0..task_count).rev() {
        if !oversized(context) {
            break;
        }
        let task = &mut context["tasks"][index];
        if !input_tasks.contains(&task["id"]) {
            task["conditions"] = Value::Null;
            task["clarification"] = Value::Null;
            task["context_complete"] = serde_json::json!(false);
        }
    }
    for key in ["memories", "selected_skills", "query_observations", "tasks"] {
        while oversized(context) {
            let Some(items) = context[key].as_array_mut() else {
                break;
            };
            let index = items
                .iter()
                .rposition(|item| key != "tasks" || !input_tasks.contains(&item["id"]));
            let Some(index) = index else { break };
            items.remove(index);
        }
    }
    for index in (0..context["tasks"].as_array().map_or(0, Vec::len)).rev() {
        if !oversized(context) {
            break;
        }
        let task = &mut context["tasks"][index];
        // 当前任务本身过大时保留身份/版本和状态，正文由受控工具补读。
        *task = serde_json::json!({"id":task["id"],"condition_version":task["condition_version"],"lifecycle":task["lifecycle"],"phase":task["phase"],"context_complete":false});
    }
}

pub mod embedding;
pub mod vector;

#[cfg(test)]
mod semantic_context_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn workspace_trims_old_candidates_before_current_task_and_keeps_authority_private() {
        let current = json!({"id":"current","goal":"合成当前目标","condition_version":"3","lifecycle":"active","phase":"waiting_clarification","conditions":{"notes":"当前条件".repeat(600)},"clarification":{"question":"当前问题？"}});
        let mut workspace = json!({"tasks":[current.clone(),{"id":"old","conditions":{"notes":"旧条件".repeat(1600)},"clarification":{"question":"旧问题？"}}],"input_task_ids":["current"],"memories":[],"selected_skills":[],"query_observations":[],"recent_messages":[],"authority_snapshot":{"private":"宿主校验".repeat(10000)}});
        let authority = workspace["authority_snapshot"].clone();
        bound_workspace(&mut workspace);
        assert_eq!(workspace["tasks"][0], current);
        assert_eq!(workspace["tasks"][1]["context_complete"], false);
        assert_eq!(workspace["tasks"][1]["conditions"], Value::Null);
        assert_eq!(workspace["authority_snapshot"], authority);
        workspace
            .as_object_mut()
            .unwrap()
            .remove("authority_snapshot");
        assert!(workspace.to_string().len() <= 16000);
    }

    #[test]
    fn oversized_current_task_keeps_identity_and_an_explicit_read_hint() {
        let mut workspace = json!({"tasks":[{"id":"current","goal":"长目标".repeat(300),"condition_version":"3","lifecycle":"active","phase":"waiting_clarification","conditions":{"notes":"当前条件".repeat(3000)},"clarification":{"question":"当前问题？"}}],"input_task_ids":["current"],"memories":[{"id":"optional","body":"记忆".repeat(2000)}],"selected_skills":[],"query_observations":[],"recent_messages":[]});
        bound_workspace(&mut workspace);
        assert!(workspace.to_string().len() <= 16000);
        assert_eq!(workspace["input_task_ids"], json!(["current"]));
        assert_eq!(workspace["tasks"].as_array().unwrap().len(), 1);
        assert_eq!(
            workspace["tasks"][0],
            json!({"id":"current","condition_version":"3","lifecycle":"active","phase":"waiting_clarification","context_complete":false})
        );
        assert!(workspace["memories"].as_array().unwrap().is_empty());
    }

    #[test]
    fn query_example_summary_keeps_questions_parameters_and_a_complete_read_hint() {
        let object = json!({"id":"example","kind":"query_example","entries":[{
            "entry_id":"body","path":"body","effective_value":"合成案例说明",
            "effective_structure":{"kind":"query_example","applicable_question":"需要按指定标签统计商品行数",
                "parameters":[{"name":"cohort","type":"string","description":"输出标签，不改变范围","required":true}],
                "sql":"SELECT COUNT(*) FROM purchases","grain":"单行汇总","dependencies":[],"verification":null}
        }]});
        let preview = search_preview(object.clone(), "商品行数");
        assert_eq!(
            preview["query_example_summary"]["applicable_question"],
            "需要按指定标签统计商品行数"
        );
        assert_eq!(
            preview["query_example_summary"]["parameters"][0]["description"],
            "输出标签，不改变范围"
        );
        assert_eq!(
            preview["query_example_summary"]["verification_recorded"],
            false
        );
        assert!(
            preview["query_example_summary"]["note"]
                .as_str()
                .unwrap()
                .contains("read_knowledge")
        );
        let index = query_example_index_text(&object["entries"][0]);
        assert!(
            index.contains("需要按指定标签统计商品行数") && index.contains("输出标签，不改变范围")
        );
    }

    #[test]
    fn hybrid_ranking_keeps_three_relevant_fields_before_kind_fillers() {
        let fields = ["amount", "rate", "count"].map(|field| {
            json!({"id":field,"name":format!("sales refund {field}"),"kind":"field","version":"1"})
        });
        let mut objects = fields.to_vec();
        for kind in [
            "table",
            "metric",
            "query_example",
            "document",
            "relationship",
            "term",
        ] {
            objects.push(
                json!({"id":kind,"name":"unrelated","kind":kind,"version":"1","body":"refund"}),
            );
        }
        for limit in [0, 1, 2, 3, 4, 6, 10] {
            let ranked = rank_hybrid(objects.clone(), "sales refund", limit, &[]);
            let protected = limit.min(3);
            assert_eq!(&ranked[..protected], &fields[..protected], "limit={limit}");
            assert!(ranked.len() <= limit);
        }
        objects.insert(0, fields[0].clone());
        assert_eq!(
            &rank_hybrid(objects, "sales refund", 6, &[])[..3],
            &fields,
            "同一对象重复候选不能占用受保护的前三位置"
        );
    }

    #[test]
    fn hybrid_ranking_keeps_exact_names_ties_versions_and_kind_diversity() {
        let object = |id: &str, name: &str, kind: &str| json!({"id":id,"name":name,"kind":kind,"version":"2"});
        let objects = vec![
            object("table-b", "needle detail", "table"),
            object("table-a", "needle archive", "table"),
            object("field", "needle value", "field"),
            object("metric", "needle count", "metric"),
            object("document", "needle rules", "document"),
            object("relationship", "needle link", "relationship"),
            object("term", "needle term", "term"),
            object("exact", "NEEDLE", "document"),
            object("only-vector", "other domain", "table"),
            object("obsolete", "outdated unrelated", "table"),
        ];
        let vectors = vec![
            json!({"id":"only-vector","version":"2"}),
            json!({"id":"obsolete","version":"1"}),
        ];
        let ids = |items: Vec<Value>| {
            items
                .into_iter()
                .map(|v| v["id"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            ids(rank_hybrid(objects.clone(), "needle", 3, &vectors)),
            ["exact", "only-vector", "table-b"]
        );
        assert_eq!(
            ids(rank_hybrid(objects, "needle", 6, &vectors)),
            [
                "exact",
                "only-vector",
                "table-b",
                "field",
                "metric",
                "relationship"
            ]
        );
        // 同分词法结果保持输入顺序；混合通道同分按ID确定次序。
        let ties = vec![
            object("z", "needle", "metric"),
            object("a", "needle", "metric"),
        ];
        assert_eq!(ids(rank(ties.clone(), "needle", 2)), ["z", "a"]);
        assert_eq!(ids(rank_hybrid(ties, "needle", 2, &[])), ["a", "z"]);
    }

    #[test]
    fn asset_search_keeps_exact_name_ahead_of_prefix_matches() {
        for (query, name) in [("合成方法1", "合成方法1"), ("REPORT", "report")] {
            let asset = |id: String, name: String| {
                json!({"id":id,"kind":"memory","name":name,"version":"1",
                    "body":"合成正文".repeat(60),"scope":"合成范围".repeat(60),
                    "verified":false,"selected":false})
            };
            let mut items: Vec<Value> = (0..20)
                .map(|i| asset(format!("prefix-{i:02}"), format!("{name}{i}")))
                .collect();
            items.push(asset("target".into(), name.into()));
            let page = asset_directory(items, query, None, 30);
            // 长摘要触发字节分页时，完整名称仍应留在首页，不能被同前缀条目挤掉。
            assert_eq!(page["memories"][0]["id"], "target");
            assert!(!page["next_asset_after"].is_null());
            assert_eq!(page["total"], 21);
        }
    }

    #[test]
    fn memory_source_can_be_read_without_losing_trailing_exceptions() {
        let source = format!(
            "以后默认按渠道展示。{}但仅限订单分析，退款分析仍按当次要求。",
            "补充范围🙂".repeat(170)
        );
        let asset = json!({"id":"memory","kind":"memory","body":"按渠道展示",
            "scope":"订单分析","source_text":source,"version":"2"});
        let preview = model_page(asset.clone(), 0, 600, None);
        assert_eq!(preview["source_text"], "");
        assert_eq!(
            preview["source_page"]["total_chars"],
            source.chars().count()
        );
        assert_eq!(preview["source_page"]["complete"], false);
        assert_eq!(preview["source_page"]["next_offset"], 0);
        let mut joined = String::new();
        let mut offset = 0;
        loop {
            let page = model_page(asset.clone(), offset, 101, Some("source_text"));
            assert_eq!(page["body"], "");
            assert_eq!(page["version"], "2");
            joined.push_str(page["source_text"].as_str().unwrap());
            match page["source_page"]["next_offset"].as_u64() {
                Some(next) => {
                    assert!(next as usize > offset);
                    offset = next as usize;
                }
                None => break,
            }
        }
        assert_eq!(joined, source);
        let empty = model_page(json!({"body":"正文","source_text":""}), 0, 600, None);
        assert_eq!(empty["source_page"]["complete"], true);
        assert!(empty["source_page"]["next_offset"].is_null());
    }

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

use serde_json::{Value, json};
use std::collections::HashMap;

// BM25/dense同权RRF k=60，精确ID优先。
pub(crate) const RRF_K: f64 = 60.;

// 知识与原文在每个通道内按同metric的分数排序，然后共同做一次RRF。
// 原文身份包含位置；同文的定义与例外可以各占一个名额。
// include_raw=false维持v1可交付范围，raw不参与排名。
// sequence保留跨record_kind的统一交付次序（05接续），objects/raw是类型视图。
pub struct CommonRank {
    pub objects: Vec<Value>,
    pub raw: Vec<Value>,
    pub sequence: Vec<(f64, String)>,
}

pub fn knowledge_record(row: &Value) -> &str {
    row["record_id"]
        .as_str()
        .or_else(|| row["id"].as_str())
        .unwrap_or("")
}

// 稳定业务位置跨通道去重，不把同一文档的不同位置压成一条。
pub fn raw_record(row: &Value) -> Option<String> {
    Some(format!(
        "{}:{}:{}:{}:{}:{}",
        row["source_kind"].as_str()?,
        row["source_id"].as_str()?,
        row["revision"].as_u64()?,
        row["offset"].as_u64()?,
        row["length"].as_u64()?,
        row["segmentation_version"].as_str()?
    ))
}

// 知识命中行的通道分数：片段最高分；无分数的旧行按0参与合并。
fn knowledge_score(row: &Value) -> f64 {
    row["matches"]
        .as_array()
        .map_or(row["distance"].as_f64().unwrap_or(0.), |matches| {
            matches
                .iter()
                .map(|m| m["score"].as_f64().unwrap_or(0.))
                .fold(f64::NEG_INFINITY, f64::max)
        })
}

// 通道内全局合并（仅include_raw）：knowledge行与raw行同metric分数可比，按分数
// 降序、同分按record稳定排序；同一位置在该通道只计一票。
fn merge_channel(knowledge: &[(&str, f64)], raw: &[&Value]) -> Vec<(f64, String)> {
    let mut merged: Vec<(f64, String, bool)> = knowledge
        .iter()
        .map(|(id, score)| (*score, format!("k:{id}"), false))
        .collect();
    for row in raw {
        let record = raw_record(row).unwrap_or_default();
        let distance = row["distance"].as_f64().unwrap_or(0.);
        if let Some(entry) = merged
            .iter_mut()
            .find(|(_, seen, is_raw)| *is_raw && *seen == format!("raw:{record}"))
        {
            if distance > entry.0 {
                entry.0 = distance;
            }
            continue;
        }
        merged.push((distance, format!("raw:{record}"), true));
    }
    merged.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    merged
        .into_iter()
        .map(|(score, record, _)| (score, record))
        .collect()
}

// 共同排序的通道输入：BM25/dense知识命中行与raw两通道摘录行。
pub struct Channels<'a> {
    pub bm25: &'a [Value],
    pub dense: &'a [Value],
    pub raw_bm25: &'a [Value],
    pub raw_dense: &'a [Value],
}
impl<'a> Channels<'a> {
    // 仅知识两通道（v1可交付范围）。
    pub fn knowledge(bm25: &'a [Value], dense: &'a [Value]) -> Self {
        Self {
            bm25,
            dense,
            raw_bm25: &[],
            raw_dense: &[],
        }
    }

    // 全通道（内部双类型混排）。
    pub fn all(
        bm25: &'a [Value],
        dense: &'a [Value],
        raw_bm25: &'a [Value],
        raw_dense: &'a [Value],
    ) -> Self {
        Self {
            bm25,
            dense,
            raw_bm25,
            raw_dense,
        }
    }
}

pub fn rank_common(
    query: &str,
    objects: Vec<Value>,
    channels: &Channels<'_>,
    limit: usize,
    include_raw: bool,
) -> CommonRank {
    // 词法名次直接取通道输入序：组合入口已按通道状态选定本次词法路（Milvus
    // BM25或SQL统一路径，二者评分含义不同不混比），rank_common不再另起一条
    // 内存子串重排链，成功空通道也不会触发补扫计分（05接续）。
    let lexical: Vec<(String, f64)> = channels
        .bm25
        .iter()
        .map(|hit| (knowledge_record(hit).to_owned(), knowledge_score(hit)))
        .collect();
    // dense知识通道按输入序；版本绑定跟命中行走（旧行为）。
    let mut lexical_k_ranks = HashMap::new();
    let mut lexical_raw_ranks = HashMap::new();
    if include_raw {
        let knowledge: Vec<(&str, f64)> = lexical
            .iter()
            .map(|(id, score)| (id.as_str(), *score))
            .collect();
        let order = merge_channel(&knowledge, &channels.raw_bm25.iter().collect::<Vec<_>>());
        for (rank, (_, record)) in order.iter().enumerate() {
            if let Some(raw) = record.strip_prefix("raw:") {
                lexical_raw_ranks.insert(raw.to_owned(), rank);
            } else if let Some(id) = record.strip_prefix("k:") {
                lexical_k_ranks.insert(id.to_owned(), rank);
            }
        }
    } else {
        for (rank, (id, _)) in lexical.iter().enumerate() {
            lexical_k_ranks.insert(id.clone(), rank);
        }
    }
    let mut vector_k_ranks = HashMap::new();
    let mut vector_k_merged_ranks = HashMap::new();
    let mut vector_raw_ranks = HashMap::new();
    if include_raw {
        let knowledge: Vec<(&str, f64)> = channels
            .dense
            .iter()
            .map(|hit| (knowledge_record(hit), knowledge_score(hit)))
            .collect();
        let order = merge_channel(&knowledge, &channels.raw_dense.iter().collect::<Vec<_>>());
        for (rank, (_, record)) in order.iter().enumerate() {
            if let Some(raw) = record.strip_prefix("raw:") {
                vector_raw_ranks.insert(raw.to_owned(), rank);
            } else if let Some(id) = record.strip_prefix("k:") {
                vector_k_merged_ranks.insert(id.to_owned(), rank);
            }
        }
    }
    for (rank, hit) in channels.dense.iter().enumerate() {
        vector_k_ranks.insert((json!(knowledge_record(hit)), hit["version"].clone()), rank);
    }
    // 一次RRF：raw record两通道各一票，独立于知识对象累加。
    let mut raw_scores: HashMap<String, f64> = HashMap::new();
    if include_raw {
        for record in lexical_raw_ranks.keys() {
            let score = 1. / (RRF_K + lexical_raw_ranks[record] as f64)
                + vector_raw_ranks
                    .get(record)
                    .map_or(0., |r| 1. / (RRF_K + *r as f64));
            *raw_scores.entry(record.clone()).or_default() += score;
        }
        for record in vector_raw_ranks.keys() {
            if !lexical_raw_ranks.contains_key(record) {
                *raw_scores.entry(record.clone()).or_default() +=
                    1. / (RRF_K + vector_raw_ranks[record] as f64);
            }
        }
    }
    // 知识对象评分：精确ID/名称优先（加分不构成第三票）；BM25名次在include_raw
    // 时来自合并序（raw挤位是共同排序的预期，仅内部双类型路径生效），v1名次不
    // 受raw影响。
    let knowledge: Vec<(f64, f64, String, Value)> = objects
        .into_iter()
        .map(|object| {
            let exact = object["id"]
                .as_str()
                .is_some_and(|v| v.eq_ignore_ascii_case(query))
                || object["name"]
                    .as_str()
                    .is_some_and(|v| v.eq_ignore_ascii_case(query));
            let lexical = lexical_k_ranks
                .get(knowledge_record(&object))
                .map_or(0., |r| 1. / (RRF_K + *r as f64));
            // dense名次：v1按输入序且绑定版本；内部混排按合并序（按id，双类型
            // 集成由调用方保证版本一致）。
            let vector = if include_raw {
                vector_k_merged_ranks
                    .get(knowledge_record(&object))
                    .map_or(0., |r| 1. / (RRF_K + *r as f64))
            } else {
                vector_k_ranks
                    .get(&(json!(knowledge_record(&object)), object["version"].clone()))
                    .map_or(0., |r| 1. / (RRF_K + *r as f64))
            };
            let channel_score = lexical + vector;
            let score = if exact { 100. } else { channel_score };
            (
                score,
                channel_score,
                format!("k:{}", knowledge_record(&object)),
                object,
            )
        })
        .filter(|(score, _, _, _)| *score > 0.)
        .collect();
    // 同一位置的定位信息相同，直接取一份；跨BM25/COSINE只融合名次，不比原始分数。
    let mut raw_rows: HashMap<String, Value> = HashMap::new();
    for row in channels.raw_bm25.iter().chain(channels.raw_dense.iter()) {
        let record = raw_record(row).unwrap_or_default();
        raw_rows.entry(record).or_insert_with(|| row.clone());
    }
    let raws: Vec<(f64, String, Value)> = raw_rows
        .into_iter()
        .filter_map(|(record, row)| {
            raw_scores
                .get(&record)
                .map(|score| (*score, format!("raw:{record}"), row))
        })
        .collect();
    // 共同名次表：一次RRF的分数统一排序，名额窗口跨record_kind（raw第一、
    // limit=1即返回raw）；v1的raw未入表，等于可交付record_kind在名额计算前
    // 前置过滤。精确匹配同分时保留该次RRF的内容次序，最后按record键稳定排序。
    let mut fused: Vec<_> = knowledge
        .into_iter()
        .map(|(score, channel_score, key, object)| (score, channel_score, key, Some(object), None))
        .chain(
            raws.into_iter()
                .map(|(score, key, row)| (score, score, key, None, Some(row))),
        )
        .collect();
    fused.sort_by(|a, b| {
        b.0.total_cmp(&a.0)
            .then_with(|| b.1.total_cmp(&a.1))
            .then_with(|| a.2.cmp(&b.2))
    });
    let mut objects = Vec::new();
    let mut raw = Vec::new();
    // 统一命中次序（05接续）：一次RRF的交付序跨record_kind保留在sequence里，
    // objects/raw数组只是按类型的投影视图，不再让相对名次只存在于两个数组的
    // 隐含顺序中。
    let mut sequence: Vec<(f64, String)> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (score, _, key, object, row) in fused {
        // 重复候选不占名额：同名次表内同键条目排序相邻，跳过后继续填补。
        if !seen.insert(key.clone()) {
            continue;
        }
        if objects.len() + raw.len() >= limit {
            break;
        }
        sequence.push((score, key));
        match (object, row) {
            (Some(object), _) => objects.push(object),
            (_, Some(mut row)) => {
                row["score"] = serde_json::json!(score);
                raw.push(row);
            }
            _ => break,
        }
    }
    CommonRank {
        objects,
        raw,
        sequence,
    }
}
mod excerpts;
pub mod source_segments;
pub use excerpts::{attach_lexical_matches, attach_matches};
mod search_reply;
pub use search_reply::{SEARCH_REPLY_LIMIT, bounded_search_reply, search_preview};
mod store;
pub use store::{content_candidates_scoped_in_tx, index_in_tx, long_platform_source_ids_in_tx};
pub use store::{record_source_projection_in_tx, source_projection_states_in_tx};

// 两个 SQL 来源共用一条词法路；同一规范 record 保留最高相关性和原定位。
// 不把同对象不同 entry/窗口合并，也不在合并层读取正文或追加 RRF 票。
pub fn merge_sql_lexical(current: Vec<Value>, indexed: Vec<Value>) -> Vec<Value> {
    let relevance = |row: &Value| {
        (
            row["name_hit"].as_bool().unwrap_or(false),
            row["name_term_hits"].as_i64().unwrap_or(0),
            row["term_hits"].as_i64().unwrap_or(0),
        )
    };
    let mut merged: HashMap<String, Value> = HashMap::new();
    for row in current.into_iter().chain(indexed) {
        let record = knowledge_record(&row);
        if record.is_empty() {
            continue;
        }
        match merged.entry(record.to_owned()) {
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(row);
            }
            std::collections::hash_map::Entry::Occupied(mut entry) => {
                let previous = entry.get();
                let previous_relevance = relevance(previous);
                let row_relevance = relevance(&row);
                let score = knowledge_score(previous).max(knowledge_score(&row));
                if row_relevance > previous_relevance {
                    entry.insert(row);
                }
                entry.get_mut()["name_hit"] = json!(previous_relevance.0 || row_relevance.0);
                entry.get_mut()["name_term_hits"] =
                    json!(previous_relevance.1.max(row_relevance.1));
                entry.get_mut()["term_hits"] = json!(previous_relevance.2.max(row_relevance.2));
                // 每行已是一个规范窗口，同 record 的定位相同；保留获胜来源的
                // 完整 matches，不重新拼成对象级命中或抹掉版本、entry、offset。
                if let Some(matches) = entry
                    .get_mut()
                    .get_mut("matches")
                    .and_then(Value::as_array_mut)
                {
                    for hit in matches {
                        hit["score"] = json!(score);
                    }
                }
            }
        }
    }
    let mut rows: Vec<Value> = merged.into_values().collect();
    rows.sort_by(|a, b| {
        relevance(b)
            .cmp(&relevance(a))
            .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
            .then_with(|| {
                let a = &a["matches"][0];
                let b = &b["matches"][0];
                a["entry_id"]
                    .as_str()
                    .cmp(&b["entry_id"].as_str())
                    .then_with(|| a["path"].as_str().cmp(&b["path"].as_str()))
                    .then_with(|| a["offset"].as_u64().cmp(&b["offset"].as_u64()))
            })
            .then_with(|| knowledge_record(a).cmp(knowledge_record(b)))
    });
    rows
}

// 原文来源在某个实际集合代次上的投影进度：由统一索引消费者按批推进，
// 完成状态绑定实际集合身份而非配置名。
pub struct SourceProjection {
    pub source_kind: String,
    pub source_id: String,
    pub space_id: String,
    pub revision: u64,
    pub collection_target: String,
    pub embedding_model: String,
    pub segmentation_version: u32,
    pub applied_position: u64,
    pub complete: bool,
}
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

pub struct CandidateTerms {
    pub values: Vec<String>,
    pub complete: bool,
}

// 只裁候选查找词，不裁后续评分。重复词不消耗预算，长问句覆盖首尾和中间位置。
pub fn candidate_terms(query: &str) -> CandidateTerms {
    const LIMIT: usize = 24;
    let mut seen = std::collections::HashSet::new();
    let unique: Vec<_> = tokens(query)
        .into_iter()
        .filter(|token| seen.insert(token.clone()))
        .collect();
    let complete = unique.len() <= LIMIT;
    let values = if complete {
        unique
    } else {
        (0..LIMIT)
            .map(|position| unique[position * (unique.len() - 1) / (LIMIT - 1)].clone())
            .collect()
    };
    CandidateTerms { values, complete }
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
    serde_json::json!({"memories":page.iter().filter(|v|v["kind"]=="memory").collect::<Vec<_>>(),"selected_skills":page.iter().filter(|v|v["kind"]=="skill").collect::<Vec<_>>(),"order":page.iter().map(|v|&v["id"]).collect::<Vec<_>>(),"next_asset_after":next,"total":total})
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
#[path = "tests/semantic_context.rs"]
mod semantic_context_tests;

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
pub use store::{content_candidates_scoped_in_tx, index_in_tx};
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
mod semantic_context_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn candidate_terms_keep_all_distinct_terms_within_budget() {
        for query in ["", "_ ,", "退款率", "Revenue refund_rate"] {
            let selected = candidate_terms(query);
            let expected = tokens(query)
                .into_iter()
                .collect::<std::collections::HashSet<_>>();
            assert!(selected.complete);
            assert_eq!(
                selected
                    .values
                    .iter()
                    .cloned()
                    .collect::<std::collections::HashSet<_>>(),
                expected
            );
        }
        let repeated = candidate_terms(&format!("{}退款率", "unusedprefix ".repeat(30)));
        assert!(repeated.complete);
        assert_eq!(repeated.values, ["unusedprefix", "退款率", "退款", "款率"]);
        let boundary = (0..24).map(|n| format!("word{n}")).collect::<Vec<_>>();
        let selected = candidate_terms(&boundary.join(" "));
        assert!(selected.complete);
        assert_eq!(selected.values, boundary);
    }

    #[test]
    fn candidate_terms_cover_long_queries_without_narrowing_score() {
        for query in [
            "退款率请先按照当前可见的业务资料帮我认真核对一下这张表在最近一个统计周期内的口径",
            "请先按照当前可见的业务资料退款率帮我认真核对一下这张表在最近一个统计周期内的口径",
            "请先按照当前可见的业务资料帮我认真核对一下这张表在最近一个统计周期内的退款率",
        ] {
            let selected = candidate_terms(query);
            assert!(!selected.complete);
            assert_eq!(selected.values.len(), 24);
            assert!(
                selected.values.iter().any(|term| "退款率".contains(term)),
                "{query}"
            );
        }
        let query = (0..48)
            .map(|n| format!("qtoken{n:02}"))
            .collect::<Vec<_>>()
            .join(" ");
        let selected = candidate_terms(&query);
        assert!(!selected.complete);
        assert_eq!(selected.values.len(), 24);
        assert_eq!(selected.values.first().unwrap(), "qtoken00");
        assert_eq!(selected.values.last().unwrap(), "qtoken47");
        assert!(!selected.values.iter().any(|term| term == "qtoken45"));
        // 候选词裁剪只影响召回，不裁完整问句的词面：qtoken45不在选定的24个候选
        // 词里，但完整问句token仍包含它（定位/展示计分用完整问句，不经候选词表）。
        assert!(!selected.values.iter().any(|term| term == "qtoken45"));
        assert!(tokens(&query).iter().any(|term| term == "qtoken45"));
    }

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
    fn hybrid_ranking_keeps_relevant_fields_without_kind_quotas() {
        let fields = ["amount", "rate", "count", "net", "total", "tax"].map(|field| {
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
        // 后备词法路（SQL统一合并序，05接续）：名称含整句且名称双词命中的字段在
        // 先（按稳定ID），仅正文弱命中的六类对象在后；排名消费该输入序。
        let lexical = vec![
            json!({"id":"amount","name_hit":true,"name_term_hits":2,"term_hits":3}),
            json!({"id":"count","name_hit":true,"name_term_hits":2,"term_hits":3}),
            json!({"id":"net","name_hit":true,"name_term_hits":2,"term_hits":3}),
            json!({"id":"rate","name_hit":true,"name_term_hits":2,"term_hits":3}),
            json!({"id":"tax","name_hit":true,"name_term_hits":2,"term_hits":3}),
            json!({"id":"total","name_hit":true,"name_term_hits":2,"term_hits":3}),
            json!({"id":"document","name_hit":false,"name_term_hits":0,"term_hits":1}),
            json!({"id":"metric","name_hit":false,"name_term_hits":0,"term_hits":1}),
            json!({"id":"query_example","name_hit":false,"name_term_hits":0,"term_hits":1}),
            json!({"id":"relationship","name_hit":false,"name_term_hits":0,"term_hits":1}),
            json!({"id":"table","name_hit":false,"name_term_hits":0,"term_hits":1}),
            json!({"id":"term","name_hit":false,"name_term_hits":0,"term_hits":1}),
        ];
        let fields_sorted = {
            let mut sorted = fields.to_vec();
            sorted.sort_by_key(|object| object["id"].as_str().unwrap().to_owned());
            sorted
        };
        for limit in [0, 1, 2, 3, 4, 6, 10] {
            let ranked = rank_common(
                "sales refund",
                objects.clone(),
                &Channels::knowledge(&lexical, &[]),
                limit,
                false,
            )
            .objects;
            let protected = limit.min(fields_sorted.len());
            assert_eq!(
                &ranked[..protected],
                &fields_sorted[..protected],
                "limit={limit}"
            );
            assert!(ranked.len() <= limit);
        }
        objects.insert(0, fields[0].clone());
        assert_eq!(
            &rank_common(
                "sales refund",
                objects,
                &Channels::knowledge(&lexical, &[]),
                6,
                false
            )
            .objects[..6],
            &fields_sorted,
            "重复候选不能占位，也不能让弱类型挤掉高相关字段"
        );
    }

    #[test]
    fn hybrid_ranking_keeps_exact_names_ties_versions_and_relevance() {
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
        // 后备词法路输入序（SQL统一合并序）：名称含整句的对象按稳定ID排，全部
        // 同分（name_hit=1,name_term_hits=1,term_hits=0）→ document,exact,field,
        // metric,relationship,table-a,table-b,term。dense命中only-vector(v2绑定)。
        let lexical = vec![
            json!({"id":"document","name_hit":true,"name_term_hits":1,"term_hits":0}),
            json!({"id":"exact","name_hit":true,"name_term_hits":1,"term_hits":0}),
            json!({"id":"field","name_hit":true,"name_term_hits":1,"term_hits":0}),
            json!({"id":"metric","name_hit":true,"name_term_hits":1,"term_hits":0}),
            json!({"id":"relationship","name_hit":true,"name_term_hits":1,"term_hits":0}),
            json!({"id":"table-a","name_hit":true,"name_term_hits":1,"term_hits":0}),
            json!({"id":"table-b","name_hit":true,"name_term_hits":1,"term_hits":0}),
            json!({"id":"term","name_hit":true,"name_term_hits":1,"term_hits":0}),
        ];
        // exact优先(100+1/61)；document词法第一1/60与only-vector dense第一1/60
        // 同分，按record键k:document<k:only-vector稳定；obsolete的dense命中版本
        // (v1)与对象版本(v2)不符，不得计票。
        assert_eq!(
            ids(rank_common(
                "needle",
                objects.clone(),
                &Channels::knowledge(&lexical, &vectors),
                3,
                false
            )
            .objects),
            ["exact", "document", "only-vector"]
        );
        assert_eq!(
            ids(rank_common(
                "needle",
                objects,
                &Channels::knowledge(&lexical, &vectors),
                6,
                false
            )
            .objects),
            [
                "exact",
                "document",
                "only-vector",
                "field",
                "metric",
                "relationship"
            ]
        );
        // 同分词法候选的名次来自SQL统一合并的稳定ID序，rank_common按输入序计票。
        let ties = vec![
            object("z", "needle", "metric"),
            object("a", "needle", "metric"),
        ];
        let ties_lexical = vec![
            json!({"id":"a","name_hit":true,"name_term_hits":1,"term_hits":0}),
            json!({"id":"z","name_hit":true,"name_term_hits":1,"term_hits":0}),
        ];
        assert_eq!(
            ids(rank_common(
                "needle",
                ties,
                &Channels::knowledge(&ties_lexical, &[]),
                2,
                false
            )
            .objects),
            ["a", "z"]
        );
    }

    #[test]
    fn sql_lexical_merge_unifies_scores_and_identity_order() {
        // 两个SQL来源按记录身份合并：各维命中取最高、名称含整句按任一来源命中
        // 即保留；名次序=名称含整句、名称词命中、正文词命中降序、稳定ID；末尾
        // 多词强项不因来源不同或ID靠后被挤掉（05接续反例的合并层判定）。名称词
        // 命中优先于正文命中数：名称是更强的相关信号。
        let current = vec![
            json!({"id":"aa-weak","name_hit":false,"name_term_hits":0,"term_hits":1}),
            json!({"id":"zz-strong","name_hit":false,"name_term_hits":0,"term_hits":4}),
            json!({"id":"name-probe","name_hit":false,"name_term_hits":2,"term_hits":2}),
        ];
        let indexed = vec![
            json!({"id":"aa-weak","name_term_hits":0,"term_hits":1}),
            json!({"id":"mid-name","name_hit":true,"name_term_hits":1,"term_hits":2}),
            json!({"id":"zz-strong","name_term_hits":0,"term_hits":3}),
            json!({"id":"name-probe","name_term_hits":1,"term_hits":3}),
        ];
        let merged = merge_sql_lexical(current, indexed);
        let ids: Vec<_> = merged
            .iter()
            .map(|row| row["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["mid-name", "name-probe", "zz-strong", "aa-weak"]);
        assert_eq!(merged[2]["term_hits"], 4, "跨来源取最高命中");
        assert_eq!(merged[0]["name_hit"], true, "名称含整句按任一来源保留");
        assert_eq!(merged[1]["name_term_hits"], 2, "名称词命中跨来源取最高");
    }

    #[test]
    fn sql_lexical_merge_preserves_content_records_and_highest_relevance() {
        let content = |record: &str, version: &str, entry: &str, offset: usize, hits: i64| {
            json!({"id":"shared-object","version":version,"record_id":record,
                "projection_version":crate::types::KNOWLEDGE_PROJECTION,
                "name_hit":false,"name_term_hits":0,"term_hits":hits,
                "matches":[{"fragment_id":record,"entry_id":entry,"path":"description",
                    "offset":offset,"length":360,"content_hash":null,"score":hits}]})
        };
        let merged = merge_sql_lexical(
            vec![
                content("entry-a-0", "1", "a", 0, 1),
                content("entry-a-280", "1", "a", 280, 2),
                content("entry-b-0", "1", "b", 0, 3),
                content("entry-a-v2", "2", "a", 0, 4),
            ],
            vec![content("entry-a-0", "1", "a", 0, 5)],
        );
        assert_eq!(
            merged.iter().map(knowledge_record).collect::<Vec<_>>(),
            ["entry-a-0", "entry-a-v2", "entry-b-0", "entry-a-280"],
            "同一对象不同条目、窗口和修订各占身份；重复record取最高相关性",
        );
        assert_eq!(merged[0]["term_hits"], 5);
        assert_eq!(merged[0]["matches"][0]["score"].as_f64(), Some(5.0));
        assert_eq!(merged[0]["matches"][0]["entry_id"], "a");
        assert_eq!(merged[1]["version"], "2");
        assert_eq!(merged[2]["matches"][0]["entry_id"], "b");
        assert_eq!(merged[3]["matches"][0]["offset"], 280);
        assert_eq!(merged[3]["matches"][0]["length"], 360);
    }

    #[test]
    fn bm25_channel_ranks_without_memory_scoring_and_rrf_uses_k60() {
        // BM25通道可用时：命中按外部顺序参与RRF，未命中对象不得再靠内存子串计分混入。
        let object = |id: &str, name: &str, kind: &str| json!({"id":id,"name":name,"kind":kind,"version":"1"});
        let objects = vec![
            object("bm-hit", "语义无关但BM25命中", "table"),
            object("substring", "needle 子串", "table"),
            object("both", "needle 双通道", "table"),
        ];
        let lexical_hits = vec![
            json!({"id":"bm-hit","version":"1"}),
            json!({"id":"both","version":"1"}),
        ];
        let dense = vec![json!({"id":"both","version":"1"})];
        // RRF k=60：both = 2/(60+1)，bm-hit = 1/(60+1)；substring无BM25命中被内存回退
        // 排除。精确名仍优先。
        let ranked = rank_common(
            "查询",
            objects,
            &Channels::knowledge(&lexical_hits, &dense),
            3,
            false,
        )
        .objects;
        let ids: Vec<_> = ranked
            .iter()
            .map(|v| v["id"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(ids, ["both", "bm-hit"]);
        let exact = rank_common(
            "needle",
            vec![
                object("needle", "别名正文", "table"),
                object("dense-only", "别名无关", "table"),
            ],
            &Channels::knowledge(&lexical_hits, &dense),
            2,
            false,
        )
        .objects;
        assert_eq!(exact[0]["id"], "needle");
    }

    #[test]
    fn common_ranking_keeps_every_selected_raw_location_for_owner_reads() {
        let rows = (0..31).map(|offset| {
            json!({"id":format!("raw-{offset}"),"source_kind":"document","source_id":"many-positions",
                "revision":1,"offset":offset * 100,"length":100,"segmentation_version":"source-structure-1","distance":100 - offset})
        }).collect::<Vec<_>>();
        let ranked = rank_common(
            "规则",
            vec![],
            &Channels::all(&[], &[], &rows, &[]),
            31,
            true,
        );
        assert_eq!(ranked.sequence.len(), 31);
        assert_eq!(
            ranked.raw.len(),
            31,
            "共同排序保留所有已选定位，30个owner读取名额由组合入口统一分配"
        );
        for (_, key) in ranked.sequence {
            assert!(
                ranked
                    .raw
                    .iter()
                    .any(|row| key == format!("raw:{}", raw_record(row).unwrap()))
            );
        }
    }

    #[test]
    fn common_ranking_keeps_distinct_source_positions_and_fused_scores() {
        let row = |id: &str, offset: u64, distance: f64| {
            json!({"id":id,"source_kind":"document","source_id":"policy","revision":1,
                "offset":offset,"length":100,"segmentation_version":"source-structure-1","content_hash":"h","distance":distance})
        };
        // 一般规则与后段例外均相关；BM25与COSINE数值不可跨通道比较。
        let bm25 = vec![row("general", 0, 18.), row("exception", 2000, 3.)];
        let dense = vec![row("exception", 2000, 0.95)];
        let ranked = rank_common(
            "退款除外",
            vec![],
            &Channels::all(&[], &[], &bm25, &dense),
            2,
            true,
        );
        assert_eq!(ranked.raw.len(), 2, "同文不同位置各占一项");
        assert_eq!(
            ranked.raw[0]["id"], "exception",
            "双通道例外段排在单通道规则段之前"
        );
        assert_eq!(ranked.raw[1]["id"], "general");
        assert!(
            ranked.raw[0]["score"].as_f64().unwrap() > ranked.raw[1]["score"].as_f64().unwrap()
        );
    }

    #[test]
    fn common_ranking_merges_raw_and_knowledge_in_one_rrf() {
        // 05切片4：raw与knowledge共同参与每个通道，两通道同权一次RRF。强raw
        // （双通道首位）不被弱知识挤掉；同一位置跨通道去重计票，不同位置独立；两个
        // 来源record与知识对象在名次表内按全局分数交错（跨文档高/低窗口不整篇
        // 分组），raw按同一序供回源。
        let row = |id: &str, source: &str, offset: u64, distance: f64| {
            json!({"id":id,"source_kind":"platform","source_id":source,"revision":3,
                "offset":offset,"length":120,"segmentation_version":"source-structure-1","content_hash":"h","distance":distance})
        };
        let object =
            |id: &str| json!({"id":id,"name":"弱相关知识","kind":"document","version":"1"});
        let objects = vec![object("weak-doc"), object("mid-doc")];
        let bm25 = vec![
            json!({"id":"weak-doc","version":"1","matches":[{"score":9.}]}),
            json!({"id":"mid-doc","version":"1","matches":[{"score":2.}]}),
        ];
        let dense = vec![json!({"id":"mid-doc","version":"1","matches":[{"score":0.5}]})];
        let raw_bm25 = vec![
            row("frag-a", "strong-src", 0, 8.),
            row("frag-b", "strong-src", 480, 7.),
            row("frag-d", "other-src", 240, 5.),
        ];
        let raw_dense = vec![
            row("frag-c", "strong-src", 0, 0.9),
            row("frag-e", "other-src", 240, 0.4),
        ];
        let mixed = rank_common(
            "退款时效",
            objects.clone(),
            &Channels::all(&bm25, &dense, &raw_bm25, &raw_dense),
            3,
            true,
        );
        // 同一名次表：strong-src(≈1/61+1/60)居首，双通道mid-doc(≈1/63+1/61)第
        // 二，other-src(≈2/62)第三——弱知识不挤高分raw，raw与知识交错分占名额。
        assert_eq!(
            mixed
                .objects
                .iter()
                .map(|v| v["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["mid-doc"],
            "内部混排：raw占两名额，知识对象按剩余名额交付"
        );
        assert_eq!(mixed.raw.len(), 2, "共同名额保留两个最高分位置");
        assert_eq!(
            mixed
                .raw
                .iter()
                .map(|v| v["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["frag-a", "frag-d"],
            "位置按全局RRF分数交错，跨通道保留一份定位"
        );
        // 统一次序（05接续）：sequence跨record_kind保留交错名次，raw与知识的
        // 相对位置不因类型视图拆分而丢失。
        let order: Vec<&str> = mixed
            .sequence
            .iter()
            .map(|(_, key)| {
                key.strip_prefix("raw:platform:strong-src")
                    .map(|_| "strong-src")
                    .or_else(|| {
                        key.strip_prefix("raw:platform:other-src")
                            .map(|_| "other-src")
                    })
                    .or_else(|| key.strip_prefix("k:").map(|_| "mid-doc"))
                    .unwrap_or("?")
            })
            .collect();
        assert_eq!(order, ["strong-src", "mid-doc", "other-src"]);
        assert!(
            mixed.sequence[0].0 > mixed.sequence[1].0 && mixed.sequence[1].0 > mixed.sequence[2].0,
            "统一次序按融合分数单调"
        );
        // v1可交付范围：raw不参与排名不占名额，limit=1交付知识对象。
        let v1 = rank_common(
            "退款时效",
            objects,
            &Channels::knowledge(&bm25, &dense),
            1,
            false,
        );
        assert_eq!(v1.raw.len(), 0, "v1不交付raw");
        assert_eq!(v1.objects.len(), 1);
        assert_eq!(v1.objects[0]["id"], "mid-doc", "v1名额在raw前置过滤后计算");
    }

    #[test]
    fn common_ranking_raw_first_at_limit_one_and_exact_not_a_third_vote() {
        // 必须覆盖：raw第一、knowledge第二、limit=1——内部双类型返回raw；v1在
        // 可交付范围内返回knowledge。exact是加分优先不是第三票：无通道命中的
        // exact对象仍排首，但不再叠加通道票。
        let row = |id: &str, source: &str, distance: f64| {
            json!({"id":id,"source_kind":"document","source_id":source,"revision":1,
                "offset":0,"length":200,"segmentation_version":"source-structure-1","content_hash":"h","distance":distance})
        };
        let objects = vec![
            json!({"id":"doc-strong","name":"非精确名","kind":"document","version":"1"}),
            json!({"id":"exact-id","name":"别名","kind":"document","version":"1"}),
        ];
        let bm25 = vec![json!({"id":"doc-strong","version":"1","matches":[{"score":10.}]})];
        let raw_bm25 = vec![row("rf", "src-a", 9.)];
        let raw_dense = vec![row("rf2", "src-a", 0.95)];
        let internal = rank_common(
            "query",
            objects.clone(),
            &Channels::all(&bm25, &[], &raw_bm25, &raw_dense),
            1,
            true,
        );
        // 内部双类型：raw双通道票(≈1/61+1/60)高于知识单通道票(1/60)，limit=1
        // 的唯一名额给raw，知识对象为空。
        assert_eq!(internal.raw.len(), 1);
        assert_eq!(
            internal.raw[0]["id"], "rf",
            "同一位置只保留一份定位，不比较跨通道原始分数"
        );
        assert!(
            internal.objects.is_empty(),
            "limit=1名额被raw占据（内部语义）"
        );
        // exact优先：exact-id无通道命中仍以加分优先返回。
        let exact = rank_common(
            "exact-id",
            objects,
            &Channels::knowledge(&[], &[]),
            2,
            false,
        );
        assert_eq!(exact.objects[0]["id"], "exact-id");
    }

    #[test]
    fn exact_name_keeps_channel_ranks_between_content_records() {
        let content = |record: &str| json!({"id":"shared-object","name":"exactneedle","version":"1","record_id":record});
        let channels = vec![content("z-body"), content("a-domain")];
        let ranked = rank_common(
            "exactneedle",
            vec![content("a-domain"), content("z-body")],
            &Channels::knowledge(&channels, &[]),
            2,
            false,
        );
        assert_eq!(
            ranked
                .objects
                .iter()
                .map(knowledge_record)
                .collect::<Vec<_>>(),
            ["z-body", "a-domain"],
            "精确名称只决定优先级，同对象内容仍按原通道名次排序",
        );
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

use super::knowledge_sources;
use crate::{
    modules::{ingestion, knowledge},
    persistence::AppTx,
    types::{AccessContext, Error, Result, epoch},
};
use serde_json::{Value, json};
use std::collections::{HashSet, VecDeque};

const MAX_SOURCES: usize = 32;
const MAX_DEPTH: usize = 8;
const MAX_BODY_BYTES: usize = 24576;

pub async fn queue_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &Value,
    sources: Vec<Value>,
) -> Result<()> {
    let material = collect_in_tx(tx, ctx, object, sources).await?;
    ingestion::queue_prefill_in_tx(tx, ctx, object, &material).await
}

pub async fn collect_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &Value,
    initial: Vec<Value>,
) -> Result<Value> {
    let mut sources = Vec::new();
    let mut gaps = Vec::new();
    let mut seen = HashSet::new();
    let mut related = vec![object["id"].as_str().unwrap_or("").to_owned()];
    related.extend(
        object["related_ids"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|id| id.as_str().map(str::to_owned)),
    );
    let mut queue = VecDeque::new();
    for source in initial {
        queue.push_back((
            source["source_id"].as_str().unwrap_or("").to_owned(),
            0,
            Some(source),
        ));
    }
    while let Some((source_id, depth, supplied)) = queue.pop_front() {
        if !seen.insert(source_id.clone()) {
            continue;
        }
        if seen.len() > 128 || sources.len() >= MAX_SOURCES {
            gaps.push(json!({"reason":"lineage_limit"}));
            break;
        }
        if depth > MAX_DEPTH {
            gaps.push(json!({"source_id":source_id,"reason":"lineage_depth_limit"}));
            continue;
        }
        let source = if let Some(source) = supplied {
            source
        } else {
            match knowledge_sources::read_in_tx(tx, ctx, &source_id, None).await {
                Ok(source) => source,
                Err(error) if matches!(error.code, "not_available" | "stale_knowledge") => {
                    gaps.push(json!({"source_id":source_id,"reason":"upstream_unavailable"}));
                    continue;
                }
                Err(error) => return Err(error),
            }
        };
        if source["complete"] != true {
            gaps.push(json!({"source_id":source_id,"reason":"source_incomplete"}));
        }
        sources.push(source);
        if source_id.starts_with("catalog-") {
            for (upstream, table) in ingestion::catalog_upstream_in_tx(tx, ctx, &source_id).await? {
                related.push(table);
                queue.push_back((upstream, depth + 1, None));
            }
        }
    }
    let documents = knowledge::related_documents_in_tx(tx, ctx, &related).await?;
    if documents.len() > 32 {
        gaps.push(json!({"reason":"document_limit"}));
    }
    for document in documents.into_iter().take(32) {
        if document["id"] == object["id"] {
            continue;
        }
        match knowledge_sources::assert_in_tx(tx, ctx, &document).await {
            Ok(()) => {
                let source = knowledge_sources::document_source(&document);
                if source["complete"] != true {
                    gaps.push(json!({"source_id":source["source_id"],"reason":"document_body_unavailable"}));
                }
                sources.push(source);
            }
            Err(error) if matches!(error.code, "not_available" | "stale_knowledge") => {
                gaps.push(json!({"object_id":document["id"],"reason":"document_unavailable"}));
            }
            Err(error) => return Err(error),
        }
    }
    let mut table_name = object["entries"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|entry| entry["path"] == "type")
        .and_then(|entry| entry["source_facts"]["table"].as_str())
        .map(str::to_owned);
    if object["kind"] == "table" {
        table_name = object["name"].as_str().map(str::to_owned);
    }
    if object["kind"] == "field" && table_name.is_none() {
        for id in object["related_ids"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            match knowledge::read_meta_in_tx(tx, ctx, id, None).await {
                Ok(meta) if meta["kind"] == "table" => {
                    if table_name.is_some() {
                        table_name = None;
                        break;
                    }
                    table_name = meta["name"].as_str().map(str::to_owned);
                }
                Ok(_) => (),
                Err(error) if error.code == "not_available" => (),
                Err(error) => return Err(error),
            }
        }
    }
    let mut metadata =
        prioritize_object_materials(object, &mut sources, table_name.as_deref(), &mut gaps);
    let frozen = bound_bodies(&mut sources, &mut gaps);
    for entry in &mut metadata {
        let fact = &entry["source_facts"];
        if fact["quote"].is_string()
            && !sources.iter().any(|source| {
                source["source_id"] == fact["source_id"]
                    && source["version"] == fact["version"]
                    && visible_contains(source, fact["quote"].as_str().unwrap_or(""))
            })
        {
            entry["source_facts"]
                .as_object_mut()
                .expect("metadata")
                .remove("quote");
            entry["source_facts"]["complete"] = json!(false);
        }
    }
    let ranges = source_coverage(&sources);
    Ok(
        json!({"metadata":metadata,"sources":sources,"frozen_review_sources":frozen,
        "coverage":{"state":if gaps.is_empty(){"complete"}else{"incomplete"},"gaps":gaps,"source_ranges":ranges}}),
    )
}

fn visible_contains(source: &Value, quote: &str) -> bool {
    source["body"].as_str().unwrap_or("").contains(quote)
        || source["supporting_excerpts"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|part| part["body"].as_str().unwrap_or("").contains(quote))
}

// 优先装配当前对象的同版核心位置，剩余额度再交给普通来源前缀。
fn prioritize_object_materials(
    object: &Value,
    sources: &mut [Value],
    table: Option<&str>,
    gaps: &mut Vec<Value>,
) -> Vec<Value> {
    let entries: Vec<_> = object["entries"].as_array().into_iter().flatten().collect();
    let mut metadata:Vec<_>=entries.iter().filter(|entry|matches!(entry["path"].as_str(),Some("ddl"|"etl"|"type"))).map(|entry|json!({"entry_id":entry["entry_id"],"path":entry["path"],
        "source_facts":{"source_id":entry["source_facts"]["source_id"],"version":entry["source_facts"]["version"],
            "location":entry["source_facts"]["location"]}})).collect();
    let mut candidates = Vec::new();
    let mut quotes = Vec::new();
    for entry in &entries {
        let fact = &entry["source_facts"];
        let Some(quote) = fact["quote"].as_str().filter(|q| !q.is_empty()) else {
            continue;
        };
        let Some(index) = sources.iter().position(|source| {
            source["source_id"] == fact["source_id"] && source["version"] == fact["version"]
        }) else {
            continue;
        };
        let body = sources[index]["body"].as_str().unwrap_or("");
        let ddl = table.and_then(|name| ingestion::prefill::table_ddl_range(body, name));
        let range = if entry["path"] == "type" {
            let column = fact["column"]
                .as_str()
                .or_else(|| {
                    object["name"]
                        .as_str()
                        .and_then(|name| name.rsplit('.').next())
                })
                .unwrap_or("");
            table
                .and_then(|table| ingestion::prefill::field_declaration_range(body, table, column))
                .filter(|range| body[range.clone()].contains(quote))
                .map(|range| (range.start, range.end))
                .or_else(|| {
                    (body.len() <= MAX_BODY_BYTES && body.contains(quote))
                        .then_some((0, body.len()))
                })
        } else {
            let mut matches = body.match_indices(quote);
            matches.next().and_then(|(start, _)| {
                matches
                    .next()
                    .is_none()
                    .then_some((start, start + quote.len()))
            })
        };
        if let Some(range) = range {
            candidates.push((
                if matches!(entry["path"].as_str(), Some("ddl" | "etl")) {
                    1
                } else {
                    0
                },
                index,
                range,
            ));
            if entry["path"] == "type" {
                let metadata_index = metadata
                    .iter()
                    .position(|metadata| metadata["entry_id"] == entry["entry_id"])
                    .expect("type metadata");
                quotes.push((
                    metadata_index,
                    index,
                    range,
                    quote.to_owned(),
                    fact["complete"] == true,
                ));
                if let Some(ddl) = ddl {
                    candidates.push((1, index, (ddl.start, ddl.end)));
                }
            }
        } else if entry["path"] == "type" {
            gaps.push(json!({"entry_id":entry["entry_id"],"source_id":fact["source_id"],"reason":"metadata_location_unavailable"}));
        }
    }
    candidates.sort_by_key(|(priority, index, range)| (*priority, *index, *range));
    let mut selected = vec![Vec::new(); sources.len()];
    let mut remaining = MAX_BODY_BYTES;
    for (_, index, range) in candidates {
        let old: usize = selected[index].iter().map(|(s, e)| e - s).sum();
        let ranges = merge_ranges(selected[index].iter().copied().chain([range]).collect());
        let added = ranges.iter().map(|(s, e)| e - s).sum::<usize>() - old;
        if added <= remaining {
            selected[index] = ranges;
            remaining -= added;
        } else {
            gaps.push(
                json!({"source_id":sources[index]["source_id"],"reason":"core_material_limit"}),
            );
        }
    }
    for (entry, index, (start, end), quote, complete) in quotes {
        let visible = selected[index]
            .iter()
            .any(|(s, e)| *s <= start && *e >= end);
        metadata[entry]["source_facts"]["complete"] = json!(visible && complete);
        if visible {
            metadata[entry]["source_facts"]["quote"] = json!(quote);
        }
    }
    for (source, ranges) in sources.iter_mut().zip(selected) {
        if !ranges.is_empty() {
            let body = source["body"].as_str().unwrap_or("");
            let parts: Vec<_> = ranges
                .into_iter()
                .map(|range| excerpt(body, range, body.len()))
                .collect();
            source["supporting_excerpts"] = json!(parts);
        }
    }
    metadata
}

fn source_coverage(sources: &[Value]) -> Vec<Value> {
    sources.iter().map(|source| {
        let ranges=merge_ranges(std::iter::once(&source["body_range"]).chain(source["supporting_excerpts"].as_array().into_iter().flatten())
            .filter_map(|part|Some((part["start_byte"].as_u64()? as usize,part["end_byte"].as_u64()? as usize))).collect());
        let ranges:Vec<_>=ranges.into_iter().map(|(start,end)|json!({"start":start,"end":end})).collect();
        json!({"source_id":source["source_id"],"version":source["version"],"total_bytes":source["body_range"]["total_bytes"],
            "visible_byte_ranges":ranges,"seen_byte_ranges":ranges})
    }).collect()
}

// 每来源最多再消费一轮正文预算；多留一个UTF-8字符以保持全文上的句末裁点。
fn freeze_review_source(source: &Value, body: &str, prefix_bytes: usize) -> Value {
    let mut end = body.len().min(prefix_bytes + MAX_BODY_BYTES + 4);
    while !body.is_char_boundary(end) {
        end -= 1;
    }
    json!({"source_id":source["source_id"],"version":source["version"],
        "body":&body[..end],"total_bytes":body.len(),"complete":source["complete"]})
}

// 兼容已排队的裁剪输入：首次调用前补齐原身份/修订的复核窗口，不重新发现来源。
pub async fn freeze_review_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    input: &Value,
) -> Result<Value> {
    let mut frozen = Vec::new();
    for source in input["sources"]
        .as_array()
        .ok_or(Error::new("invalid_input"))?
    {
        let prefix = source["body"].as_str().ok_or(Error::new("invalid_input"))?;
        if source["body_range"]["total_bytes"].as_u64().unwrap_or(0) > prefix.len() as u64
            || input["coverage"]["gaps"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|gap| gap["source_id"] == source["source_id"] && gap["reason"] == "body_limit")
        {
            let full = knowledge_sources::read_in_tx(
                tx,
                ctx,
                source["source_id"]
                    .as_str()
                    .ok_or(Error::new("invalid_input"))?,
                Some(epoch(source["version"].as_str().unwrap_or(""))?),
            )
            .await?;
            let body = full["body"].as_str().ok_or(Error::new("invalid_input"))?;
            if !body.starts_with(prefix)
                || source["body_range"]["total_bytes"]
                    .as_u64()
                    .is_some_and(|total| total != body.len() as u64)
            {
                return Err(Error::new("stale_knowledge"));
            }
            frozen.push(freeze_review_source(&full, body, prefix.len()));
        }
    }
    let mut input = input.clone();
    input["frozen_review_sources"] = json!(frozen);
    Ok(input)
}

// 按材料均分剩余额度，短材料释放余量；文档不会被排在前面的长SQL完全挤掉。
fn bound_bodies(sources: &mut [Value], gaps: &mut Vec<Value>) -> Vec<Value> {
    let mut frozen = Vec::new();
    let mut order: Vec<_> = (0..sources.len()).collect();
    order.sort_by_key(|i| sources[*i]["body"].as_str().unwrap_or("").len());
    let reserved: usize = sources
        .iter()
        .flat_map(|source| {
            source["supporting_excerpts"]
                .as_array()
                .into_iter()
                .flatten()
        })
        .map(|part| part["body"].as_str().unwrap_or("").len())
        .sum();
    let mut remaining = MAX_BODY_BYTES.saturating_sub(reserved);
    let count = order.len();
    for (position, index) in order.into_iter().enumerate() {
        let source = &mut sources[index];
        let body = source["body"].as_str().unwrap_or("");
        let total = body.len();
        let credit = source["supporting_excerpts"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|part| part["start_byte"] == 0)
            .filter_map(|part| part["end_byte"].as_u64())
            .max()
            .unwrap_or(0) as usize;
        let end = excerpt_end(body, 0, remaining / (count - position) + credit).max(credit);
        let excerpt = body[..end].to_owned();
        if end < total {
            frozen.push(freeze_review_source(source, body, end));
        }
        let mut supports = source["supporting_excerpts"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let mut refund = 0;
        supports.retain(|part| {
            if part["end_byte"]
                .as_u64()
                .is_some_and(|bound| bound <= end as u64)
            {
                refund += part["body"].as_str().unwrap_or("").len();
                false
            } else {
                true
            }
        });
        source["source_complete"] = source["complete"].clone();
        source["body_range"] =
            json!({"start_byte":0,"end_byte":end,"start_line":1,"total_bytes":total});
        source["body"] = json!(excerpt);
        if supports.is_empty() {
            source
                .as_object_mut()
                .expect("source")
                .remove("supporting_excerpts");
        } else {
            source["supporting_excerpts"] = json!(supports);
        }
        let visible = merge_ranges(
            std::iter::once((0, end))
                .chain(
                    source["supporting_excerpts"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|part| {
                            (
                                part["start_byte"].as_u64().unwrap_or(0) as usize,
                                part["end_byte"].as_u64().unwrap_or(0) as usize,
                            )
                        }),
                )
                .collect(),
        );
        let included = visible
            .iter()
            .map(|(start, end)| end - start)
            .sum::<usize>();
        source["complete"] = json!(source["source_complete"] == true && included == total);
        if included < total {
            gaps.push(json!({"source_id":source["source_id"],"reason":"body_limit","included_bytes":included,"total_bytes":total}));
        }
        remaining = remaining + refund - end;
    }
    frozen
}

// 尽量在临近的换行或句末结束；巨型单行仍可裁剪，但范围明确且不声称语句完整。
fn excerpt_end(body: &str, start: usize, allowance: usize) -> usize {
    let mut end = body.len().min(start.saturating_add(allowance));
    while !body.is_char_boundary(end) {
        end -= 1;
    }
    if end < body.len() {
        let floor = start.max(end.saturating_sub(512));
        if let Some((index, ch)) = body[start..end]
            .char_indices()
            .rev()
            .find(|(index, ch)| start + index >= floor && matches!(ch, '\n' | '。'))
        {
            end = start + index + ch.len_utf8();
        }
    }
    end
}

fn merge_ranges(mut ranges: Vec<(usize, usize)>) -> Vec<(usize, usize)> {
    ranges.retain(|(start, end)| start < end);
    ranges.sort_unstable();
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (start, end) in ranges {
        if let Some(last) = merged.last_mut()
            && start <= last.1
        {
            last.1 = last.1.max(end);
        } else {
            merged.push((start, end));
        }
    }
    merged
}

fn excerpt(body: &str, (start, end): (usize, usize), total: usize) -> Value {
    json!({"body":&body[start..end],"start_byte":start,"end_byte":end,
        "start_line":body[..start].bytes().filter(|b| *b == b'\n').count()+1,"total_bytes":total})
}

// 冻结材料可以是不连续窗口；按真实绝对位置取片段，不能把晚位置片段当作前缀切片。
fn source_excerpt(source: &Value, (start, end): (usize, usize), total: usize) -> Result<Value> {
    let body = source["body"].as_str().unwrap_or("");
    let base = source["body_range"]["start_byte"].as_u64().unwrap_or(0) as usize;
    let line = source["body_range"]["start_line"].as_u64().unwrap_or(1);
    let mut parts: Vec<_> = std::iter::once((body, base, line))
        .chain(
            source["supporting_excerpts"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|part| {
                    (
                        part["body"].as_str().unwrap_or(""),
                        part["start_byte"].as_u64().unwrap_or(0) as usize,
                        part["start_line"].as_u64().unwrap_or(1),
                    )
                }),
        )
        .collect();
    parts.sort_by_key(|(_, base, _)| *base);
    let mut position = start;
    let mut text = String::new();
    let mut start_line = line;
    for (body, base, line) in parts {
        if base <= position && position < base + body.len() {
            if position == start {
                start_line =
                    line + body[..start - base].bytes().filter(|b| *b == b'\n').count() as u64;
            }
            let next = end.min(base + body.len());
            text.push_str(
                body.get(position - base..next - base)
                    .ok_or(Error::new("invalid_input"))?,
            );
            position = next;
            if position == end {
                break;
            }
        }
    }
    if position != end {
        return Err(Error::new("invalid_input"));
    }
    Ok(
        json!({"body":text,"start_byte":start,"end_byte":end,"total_bytes":total,"start_line":start_line}),
    )
}

// 复核只消费首次调用前持久冻结的必要窗口；当前权限、修订和来源仍由check_in_tx核验。
pub fn review(input: &Value, draft: &Value) -> Result<Value> {
    let mut full = input["sources"]
        .as_array()
        .ok_or(Error::new("invalid_input"))?
        .clone();
    let frozen = input["frozen_review_sources"]
        .as_array()
        .ok_or(Error::new("invalid_input"))?;
    for source in &mut full {
        if let Some(window) = frozen.iter().find(|window| {
            window["source_id"] == source["source_id"] && window["version"] == source["version"]
        }) {
            source["body"] = window["body"].clone();
            source["body_range"]["total_bytes"] = window["total_bytes"].clone();
            source["source_complete"] = window["complete"].clone();
        }
    }
    let mut material = review_material(input, draft, &full)?;
    material
        .as_object_mut()
        .ok_or(Error::new("invalid_input"))?
        .remove("frozen_review_sources");
    Ok(material)
}

fn review_material(input: &Value, draft: &Value, full: &[Value]) -> Result<Value> {
    let original = input["sources"]
        .as_array()
        .ok_or(Error::new("invalid_input"))?;
    if full.len() != original.len() {
        return Err(Error::new("invalid_input"));
    }
    if full.iter().zip(original).all(|(full, old)| {
        full["body"] == old["body"]
            && full["version"] == old["version"]
            && full["source_id"] == old["source_id"]
    }) {
        return Ok(input.clone());
    }
    let mut ranges = Vec::new();
    let mut ends = Vec::new();
    let mut totals = Vec::new();
    let mut remaining = MAX_BODY_BYTES;
    for (source, original) in full.iter().zip(original) {
        let body = source["body"].as_str().ok_or(Error::new("invalid_input"))?;
        let total = source["body_range"]["total_bytes"]
            .as_u64()
            .unwrap_or(body.len() as u64) as usize;
        let old = original["body"]
            .as_str()
            .ok_or(Error::new("invalid_input"))?;
        if source["source_id"] != original["source_id"]
            || source["version"] != original["version"]
            || !body.starts_with(old)
        {
            return Err(Error::new("stale_knowledge"));
        }
        ends.push(old.len());
        totals.push(total);
        let mut retained: Vec<_> = original["supporting_excerpts"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|part| {
                Some((
                    part["start_byte"].as_u64()? as usize,
                    part["end_byte"].as_u64()? as usize,
                ))
            })
            .collect();
        if original["complete"] == true || total == old.len() {
            retained.push((0, old.len()));
        } else {
            for evidence in draft["entries"]
                .as_array()
                .into_iter()
                .flatten()
                .flat_map(|entry| entry["evidence"].as_array().into_iter().flatten())
                .filter(|e| {
                    e["source_id"] == source["source_id"] && e["version"] == source["version"]
                })
            {
                let quote = evidence["quote"]
                    .as_str()
                    .ok_or(Error::new("invalid_prefill"))?;
                let (text, base, start) = std::iter::once((old, 0usize))
                    .chain(
                        original["supporting_excerpts"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .map(|part| {
                                (
                                    part["body"].as_str().unwrap_or(""),
                                    part["start_byte"].as_u64().unwrap_or(0) as usize,
                                )
                            }),
                    )
                    .find_map(|(text, base)| text.find(quote).map(|start| (text, base, start)))
                    .ok_or(Error::new("invalid_prefill"))?;
                let end = start + quote.len();
                // 优先保留实际可见片段中的完整行，不跨未交付空洞扩大引用。
                let mut before = start.saturating_sub(256);
                while !text.is_char_boundary(before) {
                    before += 1;
                }
                let begin = text[before..start]
                    .rfind('\n')
                    .map_or(before, |n| before + n + 1);
                let mut after = text.len().min(end.saturating_add(256));
                while !text.is_char_boundary(after) {
                    after -= 1;
                }
                let finish = text[end..after].find('\n').map_or(after, |n| end + n + 1);
                retained.push((base + begin, base + finish));
            }
        }
        let retained = merge_ranges(retained);
        remaining = remaining
            .checked_sub(retained.iter().map(|(s, e)| e - s).sum::<usize>())
            .ok_or(Error::new("invalid_input"))?;
        ranges.push(retained);
    }
    let mut pending: Vec<_> = full
        .iter()
        .enumerate()
        .filter(|(i, _)| totals[*i] > ends[*i])
        .map(|(i, _)| i)
        .collect();
    pending.sort_by_key(|i| totals[*i] - ends[*i]);
    let count = pending.len();
    for (position, index) in pending.into_iter().enumerate() {
        let body = full[index]["body"].as_str().unwrap_or("");
        let start = ends[index];
        let end = excerpt_end(body, start, remaining / (count - position));
        remaining -= end - start;
        ranges[index].push((start, end));
    }
    let mut review = input.clone();
    let mut gaps: Vec<_> = input["coverage"]["gaps"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|gap| gap["reason"] != "body_limit")
        .cloned()
        .collect();
    let mut coverage = Vec::new();
    let mut sources = Vec::new();
    for (index, source) in full.iter().enumerate() {
        let total = totals[index];
        let visible = merge_ranges(ranges[index].clone());
        let seen = merge_ranges(visible.iter().copied().chain([(0, ends[index])]).collect());
        let included: usize = visible.iter().map(|(s, e)| e - s).sum();
        let mut projected = original[index].clone();
        // 主body为最长连续区间，其余独立呈现；引用不能跨越两个片段。
        let main = visible
            .iter()
            .max_by_key(|(s, e)| e - s)
            .copied()
            .unwrap_or((0, 0));
        let mut main_excerpt = source_excerpt(source, main, total)?;
        projected["body"] = main_excerpt["body"].take();
        main_excerpt
            .as_object_mut()
            .expect("excerpt")
            .remove("body");
        projected["body_range"] = main_excerpt;
        let supports: Vec<_> = visible
            .iter()
            .filter(|r| **r != main)
            .map(|r| source_excerpt(source, *r, total))
            .collect::<Result<_>>()?;
        if !supports.is_empty() {
            projected["supporting_excerpts"] = json!(supports);
        } else {
            projected
                .as_object_mut()
                .expect("source")
                .remove("supporting_excerpts");
        }
        let complete = source["source_complete"]
            .as_bool()
            .unwrap_or(source["complete"] == true);
        projected["complete"] = json!(complete && included == total);
        if included < total {
            gaps.push(json!({"source_id":source["source_id"],"reason":"body_limit","included_bytes":included,"total_bytes":total}));
        }
        if ends[index] < total && seen.iter().all(|(_, end)| *end <= ends[index]) {
            gaps.push(json!({"source_id":source["source_id"],"reason":"supplement_capacity"}));
        }
        if ends[index] < total {
            coverage.push(json!({"source_id":source["source_id"],"version":source["version"],"total_bytes":total,
            "visible_byte_ranges":visible.iter().map(|(s,e)|json!({"start":s,"end":e})).collect::<Vec<_>>(),
            "seen_byte_ranges":seen.iter().map(|(s,e)|json!({"start":s,"end":e})).collect::<Vec<_>>()}));
        }
        sources.push(projected);
    }
    review["sources"] = json!(sources);
    review["coverage"] = json!({"state":if gaps.is_empty(){"complete"}else{"incomplete"},"gaps":gaps,"source_ranges":coverage});
    Ok(review)
}

pub async fn check_in_tx(tx: &mut AppTx<'_>, ctx: &AccessContext, input: &Value) -> Result<()> {
    let mut raw = Vec::new();
    let mut refs = vec![(
        input["object"]["id"]
            .as_str()
            .ok_or(Error::new("invalid_input"))?
            .to_owned(),
        epoch(input["object"]["version"].as_str().unwrap_or(""))?,
    )];
    let mut pending = input["sources"]
        .as_array()
        .ok_or(Error::new("invalid_input"))?
        .clone();
    let mut seen = HashSet::new();
    while let Some(source) = pending.pop() {
        let source_id = source["source_id"]
            .as_str()
            .ok_or(Error::new("invalid_input"))?;
        let version = epoch(source["version"].as_str().unwrap_or(""))?;
        if !seen.insert((source_id.to_owned(), version)) {
            continue;
        }
        if let Some(id) = knowledge_sources::document_id(source_id) {
            refs.push((id.to_owned(), version));
            let document = knowledge::source_reference_objects_in_tx(tx, ctx, &[id.to_owned()])
                .await?
                .pop()
                .ok_or(Error::new("not_available"))?;
            if document["kind"] != "document" {
                return Err(Error::new("not_available"));
            }
            if document["version"].as_str() != Some(version.to_string().as_str()) {
                return Err(Error::new("stale_knowledge"));
            }
            for (id, version) in knowledge_sources::requirements(&document)? {
                pending.push(json!({"source_id":id,"version":version.to_string()}));
            }
        } else {
            raw.push(source);
        }
    }
    // 与来源同步相同的锁序：先来源空间，再按ID锁目标和文档，持有至正式建议落库。
    ingestion::check_prefill_sources_in_tx(tx, &ctx.space_id, &json!(raw)).await?;
    knowledge::lock_versions_in_tx(tx, ctx, &refs).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(body: String) -> Value {
        json!({"source_id":"guide","version":"1","body":body,"complete":true})
    }
    fn material(full: &[Value]) -> Value {
        let mut sources = full.to_vec();
        let mut gaps = Vec::new();
        bound_bodies(&mut sources, &mut gaps);
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
            ingestion::prefill::validate_result(&review, &result("尾部例外：撤销记录不计入。"))
                .is_ok()
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
}

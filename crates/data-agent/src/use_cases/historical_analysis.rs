use crate::{
    modules::queries,
    persistence::AppTx,
    types::{AccessContext, Error, Result, fingerprint},
};
use serde_json::{Value, json};

// 历史正文按保存时内容分页交付；出处登记只保存身份和指纹，
// 不重复存正文，也不因此取得当前口径或执行资格。
// 投影记入authority.historical_analyses，随运行授权与检查点传播；记录被改写或
// 删除时核验失败，按既有保守重建路径处理，不猜内容。
fn query_projection(query: &Value, created_at: &str, conditions: &Value) -> Value {
    let result_ref = if query["result_ref"].is_null() {
        json!([])
    } else {
        json!([{"query_id": query["id"], "result_ref": query["result_ref"]}])
    };
    json!({
        "kind": "query",
        "reference": {
            "query_id": query["id"],
            "conversation_id": query["conversation_id"],
            "task_id": query["task_id"],
            "condition_version": query["condition_version"],
            "draft_version": query["draft_version"],
        },
        "generated_at": created_at,
        "conditions": {"task_id": query["task_id"], "condition_version": query["condition_version"]},
        "content_fingerprint": fingerprint(&json!({
            "sql": query["sql"],
            "parameters": query["parameters"],
            "summary": query["summary"],
            "semantic_resolution": query["semantic_resolution"],
            "conditions": conditions,
            "knowledge_refs": query["knowledge_refs"],
            "result_ref": query["result_ref"],
        })),
        "actual_sources": {
            "result_dependencies": result_ref,
            "knowledge_refs": query["knowledge_refs"],
        },
    })
}

fn evidence_entries(report: &Value) -> Value {
    report["evidence"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|item| {
            json!({
                "reference": item["reference"],
                "conditions": item["conditions"],
                "content_fingerprint": fingerprint(&json!({
                    "data_range": item["data_range"],
                    "findings": item["findings"],
                    "validated_sources": item["validated_sources"],
                })),
            })
        })
        .collect::<Vec<_>>()
        .into()
}

fn report_projection(report: &Value) -> Value {
    let conditions = report["evidence"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|item| {
            json!({
                "task_id": item["reference"]["task_id"],
                "condition_version": item["reference"]["condition_version"],
            })
        })
        .collect::<Vec<_>>();
    let knowledge_refs = report["evidence"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|item| {
            item["validated_sources"]["knowledge_refs"]
                .as_array()
                .into_iter()
                .flatten()
                .cloned()
        })
        .collect::<Vec<_>>();
    json!({
        "kind": "report",
        "reference": report["reference"],
        "generated_at": report["created_at"],
        "conditions": conditions,
        "evidence": evidence_entries(report),
        "content_fingerprint": fingerprint(report),
        "actual_sources": {
            "result_dependencies": report["evidence"]
                .as_array()
                .into_iter()
                .flatten()
                .flat_map(|item| {
                    item["validated_sources"]["result_dependencies"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .cloned()
                })
                .collect::<Vec<_>>(),
            "knowledge_refs": knowledge_refs,
        },
    })
}

// 保存分析采用的直接出处，历史投影只抽取已登记的出处。
fn with_sources(mut entry: Value, authority: Value) -> Result<Value> {
    let authority =
        super::context_authority::historical_sources(&authority, &entry["actual_sources"])?;
    let mut results = entry["actual_sources"]["result_dependencies"]
        .as_array()
        .cloned()
        .ok_or(Error::new("invalid_evidence"))?;
    for kind in ["query_results", "source_query_results"] {
        for pair in authority[kind].as_array().into_iter().flatten() {
            let reference = json!({"query_id":pair[0],"result_ref":pair[1]});
            if !results.contains(&reference) {
                results.push(reference);
            }
        }
    }
    entry["actual_sources"]["result_dependencies"] = json!(results);
    entry["actual_sources"]["authority"] = authority;
    Ok(entry)
}

pub(super) async fn query_projection_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    query: &Value,
    conditions: &Value,
) -> Result<Value> {
    let qid = query["id"].as_str().ok_or(Error::new("stale_context"))?;
    let created_at = queries::created_at_in_tx(tx, ctx, qid).await?;
    let mut authority = super::context_authority::from_sources(query);
    super::context_authority::observe(&mut authority, &conditions["knowledge_refs"]);
    with_sources(query_projection(query, &created_at, conditions), authority)
}

pub(super) fn report_projection_with_sources(report: &Value) -> Result<Value> {
    let authority = super::analysis_reports::evidence_authority(&report["evidence"])?;
    with_sources(report_projection(report), authority)
}

/// 对已经核验的分析正文分页，封套与正文合计给工具回执留出空间。
pub(super) fn content_page(
    mut page: Value,
    content: &Value,
    offset: usize,
    limit: usize,
) -> Result<Value> {
    let body = serde_json::to_string(content).map_err(|_| Error::new("invalid_input"))?;
    let chars: Vec<_> = body.chars().collect();
    if offset > chars.len() {
        return Err(Error::new("invalid_input"));
    }
    let mut end = offset.saturating_add(limit).min(chars.len());
    loop {
        page["content_text"] = json!(chars[offset..end].iter().collect::<String>());
        page["content_page"] = json!({"offset":offset,"total_chars":chars.len(),
            "complete":end==chars.len(),"next_offset":if end<chars.len(){Some(end)}else{None}});
        if serde_json::to_vec(&page)
            .map_err(|_| Error::new("invalid_input"))?
            .len()
            <= 23 * 1024
        {
            return Ok(page);
        }
        if end == offset {
            return Err(Error::new("request_too_large"));
        }
        end = offset + (end - offset) / 2;
    }
}

// 携带历史投影的最小授权快照：只登记historical_analyses，不混入当前正文桶，
// 避免历史引用被当作已交付知识或结果。
pub(super) fn carrying(entry: &Value) -> Value {
    let mut snapshot = super::context_authority::empty();
    snapshot["historical_analyses"] = json!([entry]);
    snapshot
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derived_history_preserves_sources_without_recursive_copies() {
        let mut authority = super::super::context_authority::empty();
        authority["knowledge"] = json!([["voice-document", "1"]]);
        authority["memories"] = json!([["private-note", "2"]]);
        for index in 0..12 {
            let entry = with_sources(
                json!({
                    "kind":"query", "reference":{"query_id":format!("query-{index}")},
                    "generated_at":"2026-01-01T00:00:00Z", "content_fingerprint":"saved-content",
                    "actual_sources":{"result_dependencies":[], "knowledge_refs":[]},
                }),
                authority.clone(),
            )
            .unwrap();
            assert!(
                serde_json::to_vec(&entry).unwrap().len() < 4096,
                "重复使用同一组来源不能递归复制历史投影"
            );
            assert_eq!(
                entry["actual_sources"]["authority"]["knowledge"],
                json!([["voice-document", "1"]])
            );
            assert_eq!(
                entry["actual_sources"]["authority"]["memories"],
                json!([["private-note", "2"]])
            );
            super::super::context_authority::merge(&mut authority, &carrying(&entry)).unwrap();
        }
    }
}

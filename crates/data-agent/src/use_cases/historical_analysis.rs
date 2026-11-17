use crate::{
    modules::{analysis, queries},
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

// 保存全部实际出处，派生字段的个人来源与间接结果也不能只靠显式引用代表。
fn with_sources(mut entry: Value, authority: Value) -> Result<Value> {
    let mut authority = super::context_authority::historical_sources(&authority)?;
    super::context_authority::observe(&mut authority, &entry["actual_sources"]);
    let mut results = entry["actual_sources"]["result_dependencies"]
        .as_array()
        .cloned()
        .ok_or(Error::new("invalid_evidence"))?;
    let mut direct = super::context_authority::empty();
    direct["source_query_results"] = json!(
        results
            .iter()
            .map(|reference| json!([reference["query_id"], reference["result_ref"]]))
            .collect::<Vec<_>>()
    );
    super::context_authority::merge(&mut authority, &direct)?;
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
    let mut authority = queries::text_authority_in_tx(tx, ctx, qid).await?;
    let fields = analysis::condition_text_authorities_in_tx(
        tx,
        query["conversation_id"]
            .as_str()
            .ok_or(Error::new("stale_context"))?,
        query["task_id"]
            .as_str()
            .ok_or(Error::new("stale_context"))?,
        crate::types::epoch(query["condition_version"].as_str().unwrap_or(""))?,
    )
    .await?;
    for field in conditions
        .as_object()
        .ok_or(Error::new("stale_context"))?
        .keys()
    {
        super::context_authority::merge(&mut authority, &fields[field])?;
    }
    super::context_authority::observe(&mut authority, &conditions["knowledge_refs"]);
    with_sources(query_projection(query, &created_at, conditions), authority)
}

pub(super) async fn report_projection_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    report: &Value,
) -> Result<Value> {
    let cid = report["reference"]["conversation_id"]
        .as_str()
        .ok_or(Error::new("stale_context"))?;
    let mut authority = super::context_authority::empty();
    let mut sources =
        super::analysis_reports::evidence_authorities_in_tx(tx, ctx, cid, &report["evidence"])
            .await?;
    let titles = analysis::read_report_authorities_in_tx(tx, ctx, &report["reference"]).await?;
    sources.push(titles["title"].clone());
    sources.extend(titles["charts"].as_array().into_iter().flatten().cloned());
    for source in sources {
        super::context_authority::merge(&mut authority, &source)?;
    }
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

fn history_lookup_error(error: Error) -> Error {
    if error.code == "not_available" {
        Error::new("stale_context")
    } else {
        error
    }
}

/// 事务内重建同一记录的投影并逐字比对；记录缺失或可核内容被改写时按
/// stale_context保守失效。报告按引用的具体修订重建；查询重起草后不能
/// 再证明原投影，沿已有上下文重建处理。
pub(super) async fn assert_unchanged_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    entry: &Value,
) -> Result<()> {
    let reference = &entry["reference"];
    match entry["kind"].as_str() {
        Some("query") => {
            let qid = reference["query_id"]
                .as_str()
                .ok_or(Error::new("stale_context"))?;
            let query = queries::read_in_tx(tx, ctx, qid)
                .await
                .map_err(history_lookup_error)?;
            if query["draft_version"] != reference["draft_version"] {
                return Err(Error::new("stale_context"));
            }
            let conditions = analysis::read_evidence_conditions_in_tx(
                tx,
                ctx,
                query["conversation_id"]
                    .as_str()
                    .ok_or(Error::new("stale_context"))?,
                query["task_id"]
                    .as_str()
                    .ok_or(Error::new("stale_context"))?,
                crate::types::epoch(query["condition_version"].as_str().unwrap_or(""))?,
            )
            .await?;
            if query_projection_in_tx(tx, ctx, &query, &conditions).await? == *entry {
                Box::pin(super::context_authority::validate_history_in_tx(
                    tx,
                    ctx,
                    query["conversation_id"]
                        .as_str()
                        .ok_or(Error::new("stale_context"))?,
                    &entry["actual_sources"]["authority"],
                ))
                .await?;
                return Ok(());
            }
        }
        Some("report") => {
            let report = analysis::read_report_revision_in_tx(
                tx,
                ctx,
                reference["conversation_id"].as_str().unwrap_or(""),
                reference["report_id"].as_str().unwrap_or(""),
                crate::types::epoch(reference["version"].as_str().unwrap_or(""))?,
            )
            .await
            .map_err(history_lookup_error)?;
            if report_projection_in_tx(tx, ctx, &report).await? == *entry {
                Box::pin(super::analysis_reports::check_report_history_in_tx(
                    tx,
                    ctx,
                    reference["conversation_id"].as_str().unwrap_or(""),
                    &report,
                ))
                .await?;
                return Ok(());
            }
        }
        _ => return Err(Error::new("stale_context")),
    }
    Err(Error::new("stale_context"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_lookup_preserves_storage_failures_and_retryability() {
        let transient = history_lookup_error(Error::from(sqlx::Error::PoolTimedOut));
        assert_eq!(transient.code, "unavailable");
        assert!(transient.is_transient_storage());
        let permanent = history_lookup_error(Error::new("unavailable"));
        assert_eq!(permanent.code, "unavailable");
        assert!(!permanent.is_transient_storage());
        assert_eq!(
            history_lookup_error(Error::new("not_available")).code,
            "stale_context"
        );
    }

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

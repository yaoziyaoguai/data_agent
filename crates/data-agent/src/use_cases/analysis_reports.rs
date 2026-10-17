use crate::{
    contracts,
    modules::{analysis, conversations, queries},
    persistence::AppTx,
    types::{AccessContext, Error, Result, epoch, fingerprint},
};
use serde_json::{Value, json};
use sqlx::MySqlPool;
use std::collections::BTreeMap;

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key].as_str().ok_or(Error::new("invalid_input"))
}

fn unavailable_source(error: &Error) -> bool {
    matches!(
        error.code,
        "result_expired"
            | "result_unavailable"
            | "forbidden"
            | "not_available"
            | "stale_knowledge"
            | "invalid_evidence"
    )
}

pub fn sources(evidence: &Value) -> Result<Value> {
    let mut results = Vec::new();
    let mut knowledge = Vec::new();
    for item in evidence.as_array().ok_or(Error::new("invalid_evidence"))? {
        for (key, destination) in [
            ("result_dependencies", &mut results),
            ("knowledge_refs", &mut knowledge),
        ] {
            for reference in item["validated_sources"][key]
                .as_array()
                .ok_or(Error::new("invalid_evidence"))?
            {
                if !destination.contains(reference) {
                    destination.push(reference.clone());
                }
            }
        }
        // 条件中采用的定义也是正文来源，不能要求每条结论再次重复引用。
        for reference in item["conditions"]["knowledge_refs"]
            .as_array()
            .ok_or(Error::new("invalid_evidence"))?
        {
            if !knowledge.contains(reference) {
                knowledge.push(reference.clone());
            }
        }
    }
    Ok(json!({"result_dependencies":results,"knowledge_refs":knowledge}))
}

async fn check_evidence_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    input: &Value,
    evidence: &Value,
) -> Result<()> {
    for item in evidence.as_array().ok_or(Error::new("invalid_evidence"))? {
        let reference = &item["reference"];
        if reference["conversation_id"] != cid
            || reference["task_id"] != input["task_id"]
            || reference["condition_version"] != input["condition_version"]
        {
            return Err(Error::new("invalid_evidence"));
        }
        let current =
            analysis::read_evidence_in_tx(tx, ctx, text(reference, "evidence_id")?).await?;
        if current != *item {
            return Err(Error::new("invalid_evidence"));
        }
    }
    let adopted = sources(evidence)?;
    super::knowledge::check_refs_in_tx(tx, ctx, &adopted["knowledge_refs"]).await?;
    for reference in adopted["result_dependencies"].as_array().expect("checked") {
        let query = queries::read_in_tx(tx, ctx, text(reference, "query_id")?).await?;
        if query["conversation_id"] != cid
            || query["task_id"] != input["task_id"]
            || query["condition_version"] != input["condition_version"]
            || query["execution_state"] != "succeeded"
            || query["result_ref"] != reference["result_ref"]
        {
            return Err(Error::new("invalid_evidence"));
        }
        super::knowledge::check_refs_in_tx(tx, ctx, &query["knowledge_refs"]).await?;
    }
    Ok(())
}

async fn result_sources(
    pool: &MySqlPool,
    ctx: &AccessContext,
    evidence: &Value,
    charts: &Value,
) -> Result<Vec<Value>> {
    let adopted = sources(evidence)?;
    for reference in adopted["result_dependencies"].as_array().expect("checked") {
        super::query_workflow::result_authority(
            pool,
            ctx,
            text(reference, "query_id")?,
            text(reference, "result_ref")?,
        )
        .await?;
    }
    let mut results = BTreeMap::new();
    for chart in charts.as_array().ok_or(Error::new("invalid_input"))? {
        if !adopted["result_dependencies"]
            .as_array()
            .expect("checked")
            .iter()
            .any(|r| r["query_id"] == chart["query_id"] && r["result_ref"] == chart["result_ref"])
        {
            return Err(Error::new("invalid_evidence"));
        }
        let qid = text(chart, "query_id")?;
        if !results.contains_key(qid) {
            results.insert(
                qid.to_owned(),
                super::query_workflow::collect_saved_results(pool, ctx, qid).await?,
            );
        }
        let query = super::query_workflow::read(pool, ctx, qid).await?;
        queries::validate_report_chart(chart, &query, &results[qid])?;
    }
    Ok(results.into_values().collect())
}

/// 读取已有依据与结果不会创建查询；网络检查在事务外，正式保存前重新核对同一引用。
pub async fn validate_sources(
    pool: &MySqlPool,
    ctx: &AccessContext,
    cid: &str,
    input: &Value,
) -> Result<Value> {
    contracts::validate("SaveAnalysisReportInput", input)?;
    let mut tx = AppTx::begin(pool).await?;
    conversations::lock_conversation_in_tx(&mut tx, ctx, cid).await?;
    analysis::assert_current_in_tx(
        &mut tx,
        cid,
        text(input, "task_id")?,
        epoch(text(input, "condition_version")?)?,
    )
    .await?;
    let mut evidence = Vec::new();
    for id in input["evidence_ids"].as_array().expect("validated") {
        evidence.push(
            analysis::read_evidence_in_tx(&mut tx, ctx, id.as_str().expect("validated")).await?,
        );
    }
    let evidence = json!(evidence);
    check_evidence_in_tx(&mut tx, ctx, cid, input, &evidence).await?;
    tx.commit().await?;
    result_sources(pool, ctx, &evidence, &input["charts"]).await?;
    Ok(evidence)
}

pub async fn save_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    operation: &str,
    message: &str,
    input: &Value,
    evidence: &Value,
) -> Result<Value> {
    let tasks = analysis::lock_tasks_in_tx(tx, cid).await?;
    check_evidence_in_tx(tx, ctx, cid, input, evidence).await?;
    analysis::save_report_in_tx(
        tx,
        &tasks,
        ctx,
        operation,
        message,
        input,
        evidence.as_array().ok_or(Error::new("invalid_evidence"))?,
    )
    .await
}

pub async fn save(
    pool: &MySqlPool,
    ctx: &AccessContext,
    cid: &str,
    task: &str,
    mut input: Value,
) -> Result<Value> {
    contracts::validate("SaveAnalysisReport", &input)?;
    if input["task_id"] != task {
        return Err(Error::new("invalid_input"));
    }
    let operation = text(&input, "operation_id")?.to_owned();
    input
        .as_object_mut()
        .expect("validated")
        .remove("operation_id");
    let mut tx = AppTx::begin(pool).await?;
    conversations::lock_conversation_in_tx(&mut tx, ctx, cid).await?;
    if let Some(receipt) =
        analysis::report_receipt_in_tx(&mut tx, ctx, cid, &operation, &input).await?
    {
        tx.commit().await?;
        return Ok(receipt);
    }
    tx.commit().await?;
    let evidence = validate_sources(pool, ctx, cid, &input).await?;
    let message = text(&evidence[0], "source_message_id")?.to_owned();
    let mut tx = AppTx::begin(pool).await?;
    let conversation = conversations::lock_conversation_in_tx(&mut tx, ctx, cid).await?;
    let receipt = save_in_tx(&mut tx, ctx, cid, &operation, &message, &input, &evidence).await?;
    let event_id = fingerprint(&json!({"analysis_report":operation,"owner":ctx.user_id}));
    conversations::append_event_in_tx(
        &mut tx,
        &conversation,
        &event_id,
        "analysis_report_saved",
        receipt.clone(),
    )
    .await?;
    tx.commit().await?;
    Ok(receipt)
}

fn changed(task: &Value, report: &Value) -> bool {
    task["condition_version"] != report["reference"]["condition_version"]
        || task["lifecycle"] != "active"
}

async fn read_view(
    pool: &MySqlPool,
    ctx: &AccessContext,
    cid: &str,
    task_id: &str,
    with_chart_results: bool,
) -> Result<Value> {
    let mut tx = AppTx::begin(pool).await?;
    conversations::lock_conversation_in_tx(&mut tx, ctx, cid).await?;
    let task = analysis::read_task_in_tx(&mut tx, cid, task_id).await?;
    let report = analysis::read_report_in_tx(&mut tx, ctx, cid, task_id).await?;
    let reference = report["reference"].clone();
    if changed(&task, &report) {
        tx.commit().await?;
        return Ok(json!({"status":"condition_changed","reference":reference}));
    }
    let input = json!({"task_id":task_id,"condition_version":reference["condition_version"]});
    let local = check_evidence_in_tx(&mut tx, ctx, cid, &input, &report["evidence"]).await;
    tx.commit().await?;
    if let Err(error) = local {
        return if unavailable_source(&error) {
            Ok(json!({"status":"sources_unavailable","reference":reference}))
        } else {
            Err(error)
        };
    }
    let no_charts = json!([]);
    let charts = if with_chart_results {
        &report["charts"]
    } else {
        &no_charts
    };
    let chart_results = match result_sources(pool, ctx, &report["evidence"], charts).await {
        Ok(results) => results,
        Err(error) if unavailable_source(&error) => {
            return Ok(json!({"status":"sources_unavailable","reference":reference}));
        }
        Err(error) => return Err(error),
    };
    let mut tx = AppTx::begin(pool).await?;
    conversations::lock_conversation_in_tx(&mut tx, ctx, cid).await?;
    let latest = analysis::read_report_in_tx(&mut tx, ctx, cid, task_id).await?;
    if latest["reference"] != reference {
        return Err(Error::new("version_conflict"));
    }
    if changed(
        &analysis::read_task_in_tx(&mut tx, cid, task_id).await?,
        &latest,
    ) {
        tx.commit().await?;
        return Ok(json!({"status":"condition_changed","reference":reference}));
    }
    let local = check_evidence_in_tx(&mut tx, ctx, cid, &input, &report["evidence"]).await;
    tx.commit().await?;
    if let Err(error) = local {
        return if unavailable_source(&error) {
            Ok(json!({"status":"sources_unavailable","reference":reference}))
        } else {
            Err(error)
        };
    }
    let view = json!({"status":"available","reference":reference,"report":report,"chart_results":chart_results});
    contracts::validate("AnalysisReportView", &view)?;
    Ok(view)
}

pub async fn read(
    pool: &MySqlPool,
    ctx: &AccessContext,
    cid: &str,
    task_id: &str,
) -> Result<Value> {
    read_view(pool, ctx, cid, task_id, true).await
}

fn report_page(view: &Value, input: &Value) -> Result<Value> {
    if view["status"] != "available" {
        return Ok(json!({"page":view,"sources":null}));
    }
    if input.get("version").is_some() && input["version"] != view["reference"]["version"] {
        return Err(Error::new("version_conflict"));
    }
    let report = &view["report"];
    let body = serde_json::to_string(report).map_err(|_| Error::new("invalid_input"))?;
    let chars: Vec<_> = body.chars().collect();
    let offset = input["offset"].as_u64().unwrap_or(0) as usize;
    let limit = input["limit"].as_u64().unwrap_or(4096) as usize;
    if offset > chars.len() {
        return Err(Error::new("invalid_input"));
    }
    let mut end = offset.saturating_add(limit).min(chars.len());
    let mut page = json!({"status":"available","reference":view["reference"],"title":report["title"],
        "evidence_ids":report["evidence"].as_array().ok_or(Error::new("invalid_evidence"))?.iter().map(|item|item["reference"]["evidence_id"].clone()).collect::<Vec<_>>(),
        "charts":report["charts"],"content_text":"","content_page":{}});
    loop {
        page["content_text"] = json!(chars[offset..end].iter().collect::<String>());
        page["content_page"] = json!({"offset":offset,"total_chars":chars.len(),"complete":end==chars.len(),"next_offset":if end<chars.len(){Some(end)}else{None}});
        // 为运行回执封套留1KiB，不把合法报告全文一次塞进模型上下文。
        if serde_json::to_vec(&page)
            .map_err(|_| Error::new("invalid_input"))?
            .len()
            <= 23 * 1024
        {
            break;
        }
        if end == offset {
            return Err(Error::new("request_too_large"));
        }
        end = offset + (end - offset) / 2;
    }
    contracts::validate("AnalysisReportPage", &page)?;
    Ok(json!({"page":page,"sources":sources(&report["evidence"])?}))
}

pub async fn read_for_agent(
    pool: &MySqlPool,
    ctx: &AccessContext,
    cid: &str,
    input: &Value,
) -> Result<Value> {
    contracts::validate("ReadAnalysisReportInput", input)?;
    report_page(
        &read_view(pool, ctx, cid, text(input, "task_id")?, false).await?,
        input,
    )
}

pub async fn assert_page_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    input: &Value,
    checked: &Value,
) -> Result<()> {
    let page = &checked["page"];
    if page["status"] != "available" {
        return Ok(());
    }
    let report = analysis::read_report_in_tx(tx, ctx, cid, text(input, "task_id")?).await?;
    let task = analysis::read_task_in_tx(tx, cid, text(input, "task_id")?).await?;
    if report["reference"] != page["reference"] || changed(&task, &report) {
        return Err(Error::new("version_conflict"));
    }
    let input = json!({"task_id":input["task_id"],"condition_version":page["reference"]["condition_version"]});
    check_evidence_in_tx(tx, ctx, cid, &input, &report["evidence"]).await?;
    if sources(&report["evidence"])? != checked["sources"] {
        return Err(Error::new("invalid_evidence"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_text_pages_preserve_unicode_and_bind_the_revision_with_a_byte_limit() {
        let reference = json!({"report_id":"report","conversation_id":"conversation","task_id":"task","condition_version":"1","version":"2"});
        let knowledge = json!({"object_id":"definition","version":"1","path":"body"});
        let evidence = json!({"schema_version":1,"data_range":"合成范围","conditions":{"time_start":null,"time_end":null,"timezone":"UTC","metric":null,"channel":null,"group_by":[],"filters":[],"knowledge_refs":[knowledge],"notes":""},
            "findings":[{"text":"🙂".repeat(8000),"calculation":"","limitations":[],"query_refs":[],"knowledge_refs":[knowledge],"figures":[]}],
            "validated_sources":{"result_dependencies":[],"query_coverage":[],"knowledge_refs":[knowledge]},
            "reference":{"evidence_id":"evidence","conversation_id":"conversation","task_id":"task","condition_version":"1","result_dependencies":[]},"source_message_id":"message"});
        let report = json!({"schema_version":1,"reference":reference,"title":"保留准确原值","charts":[],"evidence":[evidence],"created_at":"2026-10-13T00:00:00Z"});
        contracts::validate("AnalysisReport", &report).unwrap();
        let view = json!({"status":"available","reference":reference,"report":report});
        let mut offset = 0;
        let mut combined = String::new();
        loop {
            let checked = report_page(
                &view,
                &json!({"task_id":"task","version":"2","offset":offset,"limit":8192}),
            )
            .unwrap();
            let page = &checked["page"];
            assert!(serde_json::to_vec(page).unwrap().len() <= 23 * 1024);
            assert_eq!(checked["sources"]["knowledge_refs"], json!([knowledge]));
            combined.push_str(page["content_text"].as_str().unwrap());
            if page["content_page"]["complete"] == true {
                break;
            }
            let next = page["content_page"]["next_offset"].as_u64().unwrap();
            assert!(next > offset);
            offset = next;
        }
        assert_eq!(combined, serde_json::to_string(&report).unwrap());
        assert_eq!(
            report_page(&view, &json!({"task_id":"task","version":"1"}))
                .unwrap_err()
                .code,
            "version_conflict"
        );
        let unavailable = report_page(
            &json!({"status":"sources_unavailable","reference":reference}),
            &json!({"task_id":"task"}),
        )
        .unwrap();
        assert!(unavailable["page"].get("title").is_none());
        assert!(unavailable["sources"].is_null());
    }
}

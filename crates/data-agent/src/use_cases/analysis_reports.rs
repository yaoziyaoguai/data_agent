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
            | "stale_context"
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

pub(super) async fn evidence_authorities_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    evidence: &Value,
) -> Result<Vec<Value>> {
    let mut authorities = Vec::new();
    for item in evidence.as_array().ok_or(Error::new("invalid_evidence"))? {
        let reference = &item["reference"];
        if reference["conversation_id"] != cid {
            return Err(Error::new("invalid_evidence"));
        }
        authorities.push(
            analysis::read_evidence_authority_in_tx(tx, ctx, text(reference, "evidence_id")?)
                .await?,
        );
        let conditions = analysis::condition_text_authorities_in_tx(
            tx,
            cid,
            text(reference, "task_id")?,
            epoch(text(reference, "condition_version")?)?,
        )
        .await?;
        authorities.extend(
            conditions
                .as_object()
                .into_iter()
                .flat_map(|fields| fields.values().cloned()),
        );
        for dependency in item["validated_sources"]["result_dependencies"]
            .as_array()
            .ok_or(Error::new("invalid_evidence"))?
        {
            authorities
                .push(queries::text_authority_in_tx(tx, ctx, text(dependency, "query_id")?).await?);
        }
    }
    Ok(authorities)
}

pub(super) async fn check_evidence_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    evidence: &Value,
    checked_text: &super::context_authority::CheckedTextResults,
) -> Result<Value> {
    let mut authority = super::context_authority::empty();
    for item in evidence.as_array().ok_or(Error::new("invalid_evidence"))? {
        let reference = &item["reference"];
        if reference["conversation_id"] != cid {
            return Err(Error::new("invalid_evidence"));
        }
        let current =
            analysis::read_evidence_in_tx(tx, ctx, text(reference, "evidence_id")?).await?;
        if current != *item {
            return Err(Error::new("invalid_evidence"));
        }
        let text_authority =
            analysis::read_evidence_authority_in_tx(tx, ctx, text(reference, "evidence_id")?)
                .await?;
        super::context_authority::validate_text_in_tx(tx, ctx, cid, &text_authority, checked_text)
            .await?;
        super::context_authority::merge(&mut authority, &text_authority)?;
        let conditions = analysis::read_evidence_conditions_in_tx(
            tx,
            ctx,
            cid,
            text(reference, "task_id")?,
            epoch(text(reference, "condition_version")?)?,
        )
        .await?;
        if conditions != item["conditions"] {
            return Err(Error::new("invalid_evidence"));
        }
        let condition_authority = super::context_authority::validate_condition_text_in_tx(
            tx,
            ctx,
            cid,
            text(reference, "task_id")?,
            epoch(text(reference, "condition_version")?)?,
            &conditions,
            checked_text,
        )
        .await?;
        super::context_authority::merge(&mut authority, &condition_authority)?;
        // 每份依据分别核对原归属；报告所在任务不能把另一版本的查询改标为当前结果。
        for dependency in item["validated_sources"]["result_dependencies"]
            .as_array()
            .ok_or(Error::new("invalid_evidence"))?
        {
            let query = queries::read_in_tx(tx, ctx, text(dependency, "query_id")?).await?;
            super::analysis_evidence::assert_query(&query, cid, reference, dependency)?;
            super::knowledge::check_refs_in_tx(tx, ctx, &query["knowledge_refs"]).await?;
            let query_authority = super::query_workflow::validate_text_in_tx(
                tx,
                ctx,
                cid,
                text(dependency, "query_id")?,
                checked_text,
            )
            .await?;
            super::context_authority::merge(&mut authority, &query_authority)?;
        }
    }
    let adopted = sources(evidence)?;
    super::knowledge::check_refs_in_tx(tx, ctx, &adopted["knowledge_refs"]).await?;
    Ok(authority)
}

fn title_authorities(
    input: &Value,
    previous: &Value,
    previous_authorities: &Value,
    generated: &Value,
) -> Value {
    let preserve = |values: Vec<Value>| {
        let mut authority = generated.clone();
        for value in values {
            if super::context_authority::merge(&mut authority, &value).is_err() {
                return Value::Null;
            }
        }
        authority
    };
    let title = preserve(if previous["title"] == input["title"] {
        vec![previous_authorities["title"].clone()]
    } else {
        vec![]
    });
    let charts = input["charts"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|chart| {
            // 图表重排或改配置不清除未改标题的来源；同文来自多个旧图时保守保留并集。
            preserve(
                previous["charts"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .enumerate()
                    .filter(|(_, old)| old["title"] == chart["title"])
                    .map(|(index, _)| previous_authorities["charts"][index].clone())
                    .collect(),
            )
        })
        .collect::<Vec<_>>();
    json!({"title":title,"charts":charts})
}

async fn candidate_title_authorities_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    input: &Value,
    generated: &Value,
) -> Result<Value> {
    let previous = match analysis::read_report_in_tx(tx, ctx, cid, text(input, "task_id")?).await {
        Ok(report) => report,
        Err(error) if error.code == "not_available" => Value::Null,
        Err(error) => return Err(error),
    };
    let authorities = if previous.is_null() {
        Value::Null
    } else {
        analysis::read_report_authorities_in_tx(tx, ctx, &previous["reference"]).await?
    };
    Ok(title_authorities(input, &previous, &authorities, generated))
}

fn report_authorities(report: &Value, authorities: &Value) -> Vec<Value> {
    let mut selected = vec![authorities["title"].clone()];
    selected.extend(
        report["charts"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
            .map(|(index, _)| authorities["charts"][index].clone()),
    );
    selected
}

async fn check_titles_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    report: &Value,
    authorities: &Value,
    checked_text: &super::context_authority::CheckedTextResults,
) -> Result<Value> {
    let mut adopted = super::context_authority::empty();
    for authority in report_authorities(report, authorities) {
        super::context_authority::validate_text_in_tx(tx, ctx, cid, &authority, checked_text)
            .await?;
        super::context_authority::merge(&mut adopted, &authority)?;
    }
    Ok(adopted)
}

async fn check_report_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    report: &Value,
    checked_text: &super::context_authority::CheckedTextResults,
) -> Result<Value> {
    let mut authority =
        check_evidence_in_tx(tx, ctx, cid, &report["evidence"], checked_text).await?;
    let titles = analysis::read_report_authorities_in_tx(tx, ctx, &report["reference"]).await?;
    let title_authority = check_titles_in_tx(tx, ctx, cid, report, &titles, checked_text).await?;
    super::context_authority::merge(&mut authority, &title_authority)?;
    Ok(authority)
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
    checked_text: &mut super::context_authority::CheckedTextResults,
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
    let mut authorities = evidence_authorities_in_tx(&mut tx, ctx, cid, &evidence).await?;
    let titles = candidate_title_authorities_in_tx(
        &mut tx,
        ctx,
        cid,
        input,
        &super::context_authority::empty(),
    )
    .await?;
    authorities.extend(report_authorities(input, &titles));
    tx.commit().await?;
    checked_text
        .include_authorities(pool, ctx, &authorities)
        .await?;
    let mut tx = AppTx::begin(pool).await?;
    conversations::lock_conversation_in_tx(&mut tx, ctx, cid).await?;
    check_evidence_in_tx(&mut tx, ctx, cid, &evidence, checked_text).await?;
    check_titles_in_tx(&mut tx, ctx, cid, input, &titles, checked_text).await?;
    tx.commit().await?;
    result_sources(pool, ctx, &evidence, &input["charts"]).await?;
    Ok(evidence)
}

pub struct ReportWrite<'a> {
    pub operation_id: &'a str,
    pub message_id: &'a str,
    pub model_run_id: Option<&'a str>,
}

pub async fn save_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    write: ReportWrite<'_>,
    input: &Value,
    evidence: &Value,
    checked_text: &super::context_authority::CheckedTextResults,
) -> Result<Value> {
    let ReportWrite {
        operation_id: operation,
        message_id: message,
        model_run_id,
    } = write;
    let tasks = analysis::lock_tasks_in_tx(tx, cid).await?;
    let evidence_authority = check_evidence_in_tx(tx, ctx, cid, evidence, checked_text).await?;
    let generated = if let Some(run) = model_run_id {
        super::context_authority::merge_run_in_tx(tx, run, &evidence_authority).await?;
        super::context_authority::generated_text_authority_in_tx(tx, run, &sources(evidence)?)
            .await?
    } else {
        super::context_authority::empty()
    };
    let titles = candidate_title_authorities_in_tx(tx, ctx, cid, input, &generated).await?;
    check_titles_in_tx(tx, ctx, cid, input, &titles, checked_text).await?;
    analysis::save_report_in_tx(
        tx,
        &tasks,
        ctx,
        operation,
        message,
        input,
        analysis::ReportSaveSources {
            evidence: evidence.as_array().ok_or(Error::new("invalid_evidence"))?,
            title_authorities: &titles,
        },
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
    let mut checked_text = super::context_authority::CheckedTextResults::default();
    let evidence = validate_sources(pool, ctx, cid, &input, &mut checked_text).await?;
    let message = text(&evidence[0], "source_message_id")?.to_owned();
    let mut tx = AppTx::begin(pool).await?;
    let conversation = conversations::lock_conversation_in_tx(&mut tx, ctx, cid).await?;
    let receipt = save_in_tx(
        &mut tx,
        ctx,
        cid,
        ReportWrite {
            operation_id: &operation,
            message_id: &message,
            model_run_id: None,
        },
        &input,
        &evidence,
        &checked_text,
    )
    .await?;
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
    checked_text: &mut super::context_authority::CheckedTextResults,
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
    let preflight = async {
        let mut authorities =
            evidence_authorities_in_tx(&mut tx, ctx, cid, &report["evidence"]).await?;
        let titles = analysis::read_report_authorities_in_tx(&mut tx, ctx, &reference).await?;
        authorities.extend(report_authorities(&report, &titles));
        Ok::<_, Error>(authorities)
    }
    .await;
    tx.commit().await?;
    let authorities = match preflight {
        Ok(authorities) => authorities,
        Err(error) if unavailable_source(&error) => {
            return Ok(json!({"status":"sources_unavailable","reference":reference}));
        }
        Err(error) => return Err(error),
    };
    checked_text
        .include_authorities(pool, ctx, &authorities)
        .await?;
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
    let local = check_report_in_tx(&mut tx, ctx, cid, &report, checked_text).await;
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
    let mut checked = super::context_authority::CheckedTextResults::default();
    read_view(pool, ctx, cid, task_id, true, &mut checked).await
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
    checked_text: &mut super::context_authority::CheckedTextResults,
) -> Result<Value> {
    contracts::validate("ReadAnalysisReportInput", input)?;
    report_page(
        &read_view(pool, ctx, cid, text(input, "task_id")?, false, checked_text).await?,
        input,
    )
}

pub async fn assert_page_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    input: &Value,
    checked: &Value,
    checked_text: &super::context_authority::CheckedTextResults,
) -> Result<Value> {
    let page = &checked["page"];
    if page["status"] != "available" {
        return Ok(super::context_authority::empty());
    }
    let report = analysis::read_report_in_tx(tx, ctx, cid, text(input, "task_id")?).await?;
    let task = analysis::read_task_in_tx(tx, cid, text(input, "task_id")?).await?;
    if report["reference"] != page["reference"] || changed(&task, &report) {
        return Err(Error::new("version_conflict"));
    }
    let authority = check_report_in_tx(tx, ctx, cid, &report, checked_text).await?;
    if sources(&report["evidence"])? != checked["sources"] {
        return Err(Error::new("invalid_evidence"));
    }
    Ok(authority)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unchanged_and_reordered_titles_preserve_their_sources() {
        let mut first = super::super::context_authority::empty();
        first["memories"] = json!([["private-memory", "1"]]);
        let mut second = super::super::context_authority::empty();
        second["knowledge"] = json!([["private-definition", "2"]]);
        let previous = json!({"title":"原报告标题","charts":[{"title":"图甲"},{"title":"图乙"}]});
        let sources = json!({"title":first,"charts":[first,second]});
        let input = json!({"title":"人工重写标题","charts":[{"title":"图乙"},{"title":"图甲"}]});
        let changed = title_authorities(
            &input,
            &previous,
            &sources,
            &super::super::context_authority::empty(),
        );
        assert_eq!(changed["title"], super::super::context_authority::empty());
        assert_eq!(changed["charts"], json!([second, first]));
        let mut legacy = sources;
        legacy["charts"][0] = Value::Null;
        let generated = title_authorities(&input, &previous, &legacy, &second);
        assert!(
            generated["charts"][1].is_null(),
            "相同标题不能用新的模型来源掩盖原来的未知来源"
        );
    }

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

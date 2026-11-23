use crate::{
    contracts::{self, generated::SaveAnalysisReport},
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

// 撤权/删除/停用/越权或来源记录被改写：实际派生内容不允许借读取复活，
// 整份报告只返回状态与引用。
fn revoked_source(error: &Error) -> bool {
    matches!(
        error.code,
        "forbidden" | "not_available" | "stale_knowledge" | "stale_context" | "invalid_evidence"
    )
}

// 原始结果过期或暂不可读：只影响依赖该结果重建的图表/明细，不隐藏报告正文。
fn expired_source(error: &Error) -> bool {
    matches!(error.code, "result_expired" | "result_unavailable")
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

pub(super) fn evidence_authority(evidence: &Value) -> Result<Value> {
    super::context_authority::from_sources(&sources(evidence)?)
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
    let selected = super::context_authority::from_sources(&adopted)?;
    if !checked_text.allows(&selected, false) {
        return Err(Error::new("stale_context"));
    }
    super::context_authority::merge(&mut authority, &selected)?;
    Ok(authority)
}

// 历史展示核验（04切片7）：已存报告在普通语义改版后仍完整展示。依据行必须
// 原样存在且归属不变；条件与结论引用的知识按记录版本存档读取，版本漂移不算
// 失效；查询依赖只核归属与形状。撤权、删除、停用仍按限制类失败整份隐藏。
pub(super) async fn check_report_history_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    report: &Value,
) -> Result<()> {
    async fn history_refs_in_tx(
        tx: &mut AppTx<'_>,
        ctx: &AccessContext,
        refs: &Value,
    ) -> Result<()> {
        // 存档版本读取容忍版本漂移；对象撤下或上游被撤仍按限制类拒绝。
        super::knowledge::history_check_refs_in_tx(tx, ctx, refs).await
    }
    for item in report["evidence"]
        .as_array()
        .ok_or(Error::new("invalid_evidence"))?
    {
        let reference = &item["reference"];
        if reference["conversation_id"] != cid {
            return Err(Error::new("invalid_evidence"));
        }
        let current =
            analysis::read_evidence_in_tx(tx, ctx, text(reference, "evidence_id")?).await?;
        if current != *item {
            return Err(Error::new("invalid_evidence"));
        }
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
        history_refs_in_tx(tx, ctx, &conditions["knowledge_refs"]).await?;
        history_refs_in_tx(tx, ctx, &item["validated_sources"]["knowledge_refs"]).await?;
        for finding in item["findings"]
            .as_array()
            .ok_or(Error::new("invalid_evidence"))?
        {
            history_refs_in_tx(tx, ctx, &finding["knowledge_refs"]).await?;
        }
        for dependency in item["validated_sources"]["result_dependencies"]
            .as_array()
            .ok_or(Error::new("invalid_evidence"))?
        {
            let query = queries::read_in_tx(tx, ctx, text(dependency, "query_id")?).await?;
            super::analysis_evidence::assert_query(&query, cid, reference, dependency)?;
        }
    }
    Ok(())
}

/// 保存路径（current_use）仍要求全部采纳结果当前有效：过期依据不能借新报告
/// 版本重新采用；旧数据只保留在已存展示里。
async fn result_sources(
    pool: &MySqlPool,
    ctx: &AccessContext,
    evidence: &Value,
    charts: &Value,
) -> Result<Vec<Value>> {
    let adopted = sources(evidence)?;
    for reference in adopted["result_dependencies"]
        .as_array()
        .ok_or(crate::types::Error::new("invalid_input"))?
    {
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
            .ok_or(crate::types::Error::new("invalid_input"))?
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

/// 展示路径（history_display）逐图表收集：依赖过期的图表数据不可用（省略该
/// 结果，界面按缺失呈现），报告正文保留；撤权类失败上抛整份限制。不自动重跑查询。
async fn partial_chart_results(
    pool: &MySqlPool,
    ctx: &AccessContext,
    evidence: &Value,
    charts: &Value,
) -> Result<Vec<Value>> {
    let adopted = sources(evidence)?;
    let mut results = BTreeMap::new();
    for chart in charts.as_array().ok_or(Error::new("invalid_input"))? {
        if !adopted["result_dependencies"]
            .as_array()
            .ok_or(crate::types::Error::new("invalid_input"))?
            .iter()
            .any(|r| r["query_id"] == chart["query_id"] && r["result_ref"] == chart["result_ref"])
        {
            return Err(Error::new("invalid_evidence"));
        }
        let qid = text(chart, "query_id")?;
        // 图表数据可用性按结果状态判定：只有原始结果过期（过期类）才省略该图；
        // 语义改版的版本漂移不隐藏已存结果数据（04切片7），撤权类上抛整份限制。
        let mut unavailable = false;
        if let Err(error) = super::query_workflow::result_state_authority(
            pool,
            ctx,
            qid,
            text(chart, "result_ref")?,
        )
        .await
        {
            if matches!(error.code, "forbidden" | "not_available") {
                return Err(error);
            }
            if expired_source(&error) {
                unavailable = true;
            } else if !matches!(
                error.code,
                "stale_context" | "stale_knowledge" | "invalid_input"
            ) {
                return Err(error);
            }
        }
        if !unavailable && !results.contains_key(qid) {
            match super::query_workflow::collect_saved_results_for_display(pool, ctx, qid).await {
                Ok(collected) => {
                    results.insert(qid.to_owned(), collected);
                }
                // 展示收集已按历史规则核验引用：漂移不报错，撤权类如实上抛，
                // 此处只有真实结果过期才按缺图处理。
                Err(error) if expired_source(&error) => {}
                Err(error) => return Err(error),
            }
        }
        if let Some(saved) = results.get(qid) {
            let query = super::query_workflow::read(pool, ctx, qid).await?;
            queries::validate_report_chart(chart, &query, saved)?;
        }
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
    for id in input["evidence_ids"]
        .as_array()
        .ok_or(crate::types::Error::new("invalid_input"))?
    {
        evidence.push(
            analysis::read_evidence_in_tx(
                &mut tx,
                ctx,
                id.as_str()
                    .ok_or(crate::types::Error::new("invalid_input"))?,
            )
            .await?,
        );
    }
    let evidence = json!(evidence);
    let authorities = [evidence_authority(&evidence)?];
    tx.commit().await?;
    checked_text.include(pool, ctx, &authorities, false).await?;
    let mut tx = AppTx::begin(pool).await?;
    conversations::lock_conversation_in_tx(&mut tx, ctx, cid).await?;
    check_evidence_in_tx(&mut tx, ctx, cid, &evidence, checked_text).await?;
    tx.commit().await?;
    result_sources(pool, ctx, &evidence, &input["charts"]).await?;
    Ok(evidence)
}

pub struct ReportWrite<'a> {
    pub operation_id: &'a str,
    pub message_id: &'a str,
}

pub async fn save_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    conv: &crate::modules::conversations::LockedConversation,
    write: ReportWrite<'_>,
    input: &Value,
    evidence: &Value,
    checked_text: &super::context_authority::CheckedTextResults,
) -> Result<Value> {
    let cid = conv.id.as_str();
    let ReportWrite {
        operation_id: operation,
        message_id: message,
    } = write;
    let tasks = analysis::lock_tasks_in_tx(tx, cid).await?;
    check_evidence_in_tx(tx, ctx, cid, evidence, checked_text).await?;
    analysis::save_report_in_tx(
        tx,
        &tasks,
        ctx,
        operation,
        message,
        input,
        analysis::ReportSaveSources {
            evidence: evidence.as_array().ok_or(Error::new("invalid_evidence"))?,
        },
    )
    .await
}

pub async fn save(
    pool: &MySqlPool,
    ctx: &AccessContext,
    cid: &str,
    task: &str,
    input: SaveAnalysisReport,
    mut raw: Value,
) -> Result<Value> {
    if input.task_id != task {
        return Err(Error::new("invalid_input"));
    }
    let operation = input.operation_id;
    raw.as_object_mut()
        .ok_or(crate::types::Error::new("invalid_input"))?
        .remove("operation_id");
    let input = raw;
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
        &conversation,
        ReportWrite {
            operation_id: &operation,
            message_id: &message,
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

fn unavailable_view(reference: &Value) -> Value {
    json!({"status":"sources_unavailable","reference":reference})
}

/// 报告读取按具体用例固定用途（04切片7）：Web/报告页是history_display——已存
/// 内容在语义改版后仍完整，结果过期只省略受影响图表，撤权类整份限制；条件
/// 已变化的报告保留正文并标记condition_changed，不自动重跑。
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
    let _task = analysis::read_task_in_tx(&mut tx, cid, task_id).await?;
    let report = analysis::read_report_in_tx(&mut tx, ctx, cid, task_id).await?;
    let reference = report["reference"].clone();
    let history = check_report_history_in_tx(&mut tx, ctx, cid, &report).await;
    let projection = super::historical_analysis::report_projection_with_sources(&report);
    tx.commit().await?;
    if let Err(error) = history {
        if revoked_source(&error) {
            return Ok(unavailable_view(&reference));
        }
        return Err(error);
    }
    // 全部实际来源包含标题、条件等间接来源，平台核验仍在事务外。
    let projection = projection?;
    let authority = &projection["actual_sources"]["authority"];
    checked_text
        .include(pool, ctx, std::slice::from_ref(authority), true)
        .await?;
    if !checked_text.allows(authority, true) {
        return Ok(unavailable_view(&reference));
    }
    let no_charts = json!([]);
    let charts = if with_chart_results {
        &report["charts"]
    } else {
        &no_charts
    };
    let chart_results = match partial_chart_results(pool, ctx, &report["evidence"], charts).await {
        Ok(results) => results,
        Err(error) if revoked_source(&error) => {
            return Ok(unavailable_view(&reference));
        }
        Err(error) => return Err(error),
    };
    let mut tx = AppTx::begin(pool).await?;
    conversations::lock_conversation_in_tx(&mut tx, ctx, cid).await?;
    let latest = analysis::read_report_in_tx(&mut tx, ctx, cid, task_id).await?;
    if latest["reference"] != reference {
        return Err(Error::new("version_conflict"));
    }
    let changed = changed(
        &analysis::read_task_in_tx(&mut tx, cid, task_id).await?,
        &latest,
    );
    if let Err(error) = check_report_history_in_tx(&mut tx, ctx, cid, &latest).await {
        tx.commit().await?;
        if revoked_source(&error) {
            return Ok(unavailable_view(&reference));
        }
        return Err(error);
    }
    let current_projection = super::historical_analysis::report_projection_with_sources(&latest)?;
    if current_projection != projection
        || !checked_text.allows(&current_projection["actual_sources"]["authority"], true)
    {
        return Err(Error::new("version_conflict"));
    }
    tx.commit().await?;
    let status = if changed {
        "condition_changed"
    } else {
        "available"
    };
    Ok(json!({"status":status,"reference":reference,"report":report,"chart_results":chart_results}))
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
    if view["status"] != "available" && view["status"] != "historical" {
        return Ok(json!({"page":view,"sources":null}));
    }
    if input.get("version").is_some() && input["version"] != view["reference"]["version"] {
        return Err(Error::new("version_conflict"));
    }
    let report = &view["report"];
    let page = if view["status"] == "historical" {
        json!({"status":"historical","reference":view["reference"],
            "historical_analysis":view["historical_analysis"]})
    } else {
        json!({"status":"available","reference":view["reference"],"title":report["title"],
            "evidence_ids":report["evidence"].as_array().ok_or(Error::new("invalid_evidence"))?.iter().map(|item|item["reference"]["evidence_id"].clone()).collect::<Vec<_>>(),
            "charts":report["charts"]})
    };
    let page = super::historical_analysis::content_page(
        page,
        report,
        input["offset"].as_u64().unwrap_or(0) as usize,
        input["limit"].as_u64().unwrap_or(4096) as usize,
    )?;
    contracts::validate("AnalysisReportPage", &page)?;
    Ok(
        json!({"page":page,"sources":if view["status"] == "historical" { Value::Null } else { sources(&report["evidence"])? }}),
    )
}

async fn historical_page(
    pool: &MySqlPool,
    ctx: &AccessContext,
    cid: &str,
    mut view: Value,
    input: &Value,
) -> Result<Value> {
    let mut tx = AppTx::begin(pool).await?;
    conversations::lock_conversation_in_tx(&mut tx, ctx, cid).await?;
    check_report_history_in_tx(&mut tx, ctx, cid, &view["report"]).await?;
    view["historical_analysis"] =
        super::historical_analysis::report_projection_with_sources(&view["report"])?;
    tx.commit().await?;
    view["status"] = json!("historical");
    report_page(&view, input)
}

/// 当前报告沿严格核验；旧报告按历史用途交付保存时正文及原条件。
/// 历史引用只用于复述，不获得当前采用或执行资格。
pub async fn read_for_agent(
    pool: &MySqlPool,
    ctx: &AccessContext,
    cid: &str,
    input: &Value,
    checked_text: &mut super::context_authority::CheckedTextResults,
) -> Result<Value> {
    let view = read_view(pool, ctx, cid, text(input, "task_id")?, false, checked_text).await?;
    if view["status"] == "condition_changed" {
        return historical_page(pool, ctx, cid, view, input).await;
    }
    if view["status"] != "available" {
        return Ok(json!({"page":view,"sources":null}));
    }
    let mut tx = AppTx::begin(pool).await?;
    conversations::lock_conversation_in_tx(&mut tx, ctx, cid).await?;
    let report = analysis::read_report_in_tx(&mut tx, ctx, cid, text(input, "task_id")?).await?;
    // 严格核验与交付正文保持同一修订：read_view提交后可能并发保存新修订（如
    // 仅改标题），及早按reference比对以version_conflict失败，不让核验与
    // include_authorities落在与拟交付正文不同的修订上（与库内既有竞态处理
    // 一致，04关闭审查修复）。
    if report["reference"] != view["reference"] {
        tx.commit().await?;
        return Err(Error::new("version_conflict"));
    }
    let authorities = evidence_authority(&report["evidence"]).map(|authority| [authority]);
    tx.commit().await?;
    let strict = match authorities {
        Ok(authorities) => {
            checked_text.include(pool, ctx, &authorities, false).await?;
            let mut tx = AppTx::begin(pool).await?;
            conversations::lock_conversation_in_tx(&mut tx, ctx, cid).await?;
            let strict =
                check_evidence_in_tx(&mut tx, ctx, cid, &report["evidence"], checked_text).await;
            tx.commit().await?;
            strict
        }
        Err(error) => Err(error),
    };
    match strict {
        Ok(_) => report_page(&view, input),
        Err(error) if matches!(error.code, "stale_context" | "stale_knowledge") => {
            historical_page(pool, ctx, cid, view, input).await
        }
        Err(error) if revoked_source(&error) => {
            Ok(json!({"page":unavailable_view(&view["reference"]),"sources":null}))
        }
        Err(error) => Err(error),
    }
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
    if page["status"] == "historical" {
        // 与事务外读取核对同一修订及实际页，防止分页期间换成另一份正文。
        let report = analysis::read_report_in_tx(tx, ctx, cid, text(input, "task_id")?).await?;
        let entry = &page["historical_analysis"];
        let projection = super::historical_analysis::report_projection_with_sources(&report)?;
        let expected = report_page(
            &json!({"status":"historical","historical_analysis":projection,
            "reference":report["reference"],"report":report}),
            input,
        )?;
        if expected != *checked {
            return Err(Error::new("version_conflict"));
        }
        check_report_history_in_tx(tx, ctx, cid, &report).await?;
        if !checked_text.allows(&entry["actual_sources"]["authority"], true) {
            return Err(Error::new("not_available"));
        }
        return Ok(super::historical_analysis::carrying(entry));
    }
    if page["status"] != "available" {
        return Ok(super::context_authority::empty());
    }
    let report = analysis::read_report_in_tx(tx, ctx, cid, text(input, "task_id")?).await?;
    let task = analysis::read_task_in_tx(tx, cid, text(input, "task_id")?).await?;
    if report["reference"] != page["reference"] || changed(&task, &report) {
        return Err(Error::new("version_conflict"));
    }
    let authority = check_evidence_in_tx(tx, ctx, cid, &report["evidence"], checked_text).await?;
    if sources(&report["evidence"])? != checked["sources"] {
        return Err(Error::new("invalid_evidence"));
    }
    Ok(authority)
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

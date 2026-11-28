use crate::{
    contracts,
    modules::{analysis, conversations, queries},
    persistence::AppTx,
    types::{AccessContext, Error, Result, epoch},
};
use serde_json::{Value, json};
use sqlx::MySqlPool;
use std::collections::BTreeMap;

/// 结果读取在事务外；保存前再次核对本地归属、条件与引用，避免网络占用业务锁。
pub async fn validate_sources(
    pool: &MySqlPool,
    ctx: &AccessContext,
    cid: &str,
    message_id: &str,
    input: &Value,
    checked_text: &mut super::context_authority::CheckedTextResults,
) -> Result<Value> {
    validate_sources_and_results(pool, ctx, cid, message_id, input, checked_text)
        .await
        .map(|(sources, _)| sources)
}

pub(super) async fn validate_sources_and_results(
    pool: &MySqlPool,
    ctx: &AccessContext,
    cid: &str,
    message_id: &str,
    input: &Value,
    checked_text: &mut super::context_authority::CheckedTextResults,
) -> Result<(Value, BTreeMap<String, Value>)> {
    contracts::validate("SaveAnalysisEvidenceInput", input)?;
    if serde_json::to_vec(input)
        .map_err(|_| Error::new("invalid_input"))?
        .len()
        > 128 * 1024
    {
        return Err(Error::new("request_too_large"));
    }
    let mut references = BTreeMap::<String, Value>::new();
    let mut tx = AppTx::begin(pool).await?;
    conversations::lock_conversation_in_tx(&mut tx, ctx, cid).await?;
    let conditions = analysis::read_evidence_conditions_in_tx(
        &mut tx,
        ctx,
        cid,
        input["task_id"]
            .as_str()
            .ok_or(crate::types::Error::new("invalid_input"))?,
        epoch(
            input["condition_version"]
                .as_str()
                .ok_or(crate::types::Error::new("invalid_input"))?,
        )?,
    )
    .await?;
    super::knowledge::check_adoptable_refs_in_tx(&mut tx, ctx, &conditions["knowledge_refs"])
        .await?;
    tx.commit().await?;
    let mut knowledge_refs = conditions["knowledge_refs"]
        .as_array()
        .ok_or(crate::types::Error::new("invalid_input"))?
        .clone();
    for finding in input["findings"]
        .as_array()
        .ok_or(crate::types::Error::new("invalid_input"))?
    {
        for reference in finding["query_refs"]
            .as_array()
            .ok_or(crate::types::Error::new("invalid_input"))?
        {
            let qid = reference["query_id"]
                .as_str()
                .ok_or(crate::types::Error::new("invalid_input"))?;
            if let Some(previous) = references.get(qid)
                && previous["result_ref"] != reference["result_ref"]
            {
                return Err(Error::new("invalid_evidence"));
            }
            references.insert(qid.to_owned(), reference.clone());
        }
        for reference in finding["knowledge_refs"]
            .as_array()
            .ok_or(crate::types::Error::new("invalid_input"))?
        {
            if !knowledge_refs.contains(reference) {
                knowledge_refs.push(reference.clone());
            }
        }
        if finding["query_refs"]
            .as_array()
            .ok_or(crate::types::Error::new("invalid_input"))?
            .is_empty()
            && finding["knowledge_refs"]
                .as_array()
                .ok_or(crate::types::Error::new("invalid_input"))?
                .is_empty()
        {
            return Err(Error::new("invalid_evidence"));
        }
    }
    // 保存范围与查询实际任务一致；空/部分结果仍可记录，但必须明确限制。
    let mut results = BTreeMap::new();
    let mut query_coverage = Vec::new();
    for (qid, reference) in &references {
        let query = super::query_workflow::read(pool, ctx, qid).await?;
        assert_query(&query, cid, input, reference)?;
        let mut tx = AppTx::begin(pool).await?;
        let just_submitted =
            queries::is_confirmation_message_in_tx(&mut tx, ctx, qid, message_id).await?;
        tx.commit().await?;
        if just_submitted {
            return Err(Error::new("invalid_evidence"));
        }
        let result = super::query_workflow::collect_saved_results(pool, ctx, qid).await?;
        if result["result_ref"] != reference["result_ref"] {
            return Err(Error::new("invalid_evidence"));
        }
        checked_text.record_result(
            qid,
            reference["result_ref"]
                .as_str()
                .ok_or(crate::types::Error::new("invalid_input"))?,
        );
        query_coverage.push(json!({"query_id":qid,"result_ref":result["result_ref"],
            "saved_row_count":result["saved_row_count"],"saved_result_complete":result["saved_result_complete"],
            "result_complete":result["result_complete"],"received_rows":result["rows"].as_array().ok_or(Error::new("result_unavailable"))?.len()}));
        results.insert(qid.clone(), result);
    }
    for finding in input["findings"]
        .as_array()
        .ok_or(crate::types::Error::new("invalid_input"))?
    {
        validate_finding(finding, &results)?;
    }
    let sources = json!({"result_dependencies":references.iter().map(|(qid,r)|json!({"query_id":qid,"result_ref":r["result_ref"]})).collect::<Vec<_>>(),
        "query_coverage":query_coverage,"knowledge_refs":knowledge_refs});
    contracts::validate("AnalysisEvidenceSources", &sources)?;
    Ok((sources, results))
}

pub(super) fn assert_query(
    query: &Value,
    cid: &str,
    input: &Value,
    reference: &Value,
) -> Result<()> {
    if query["conversation_id"] != cid
        || query["task_id"] != input["task_id"]
        || query["condition_version"] != input["condition_version"]
        || query["execution_state"] != "succeeded"
        || query["result_ref"] != reference["result_ref"]
    {
        return Err(Error::new("invalid_evidence"));
    }
    Ok(())
}

fn json_value_kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn evidence_hint_error(hint: impl Into<String>) -> Error {
    Error::new("invalid_evidence").with_details(json!({ "hint": hint.into() }))
}

fn validate_finding(finding: &Value, results: &BTreeMap<String, Value>) -> Result<()> {
    for reference in finding["query_refs"]
        .as_array()
        .ok_or(crate::types::Error::new("invalid_input"))?
    {
        let result = results
            .get(
                reference["query_id"]
                    .as_str()
                    .ok_or(crate::types::Error::new("invalid_input"))?,
            )
            .ok_or_else(|| {
                evidence_hint_error("本次save_analysis_evidence未生效：query_refs引用的query_id不在有效已核查询结果中。")
            })?;
        for column in reference["columns"]
            .as_array()
            .ok_or(crate::types::Error::new("invalid_input"))?
        {
            if result["columns"]
                .as_array()
                .ok_or(Error::new("result_unavailable"))?
                .iter()
                .filter(|c| c["name"] == *column)
                .count()
                != 1
            {
                return Err(evidence_hint_error(format!(
                    "本次save_analysis_evidence未生效：query_refs.columns中的列名 {} 在查询结果columns中不存在或存在重名。",
                    column
                )));
            }
        }
        if (result["result_complete"] != true
            || result["rows"].as_array().is_none_or(Vec::is_empty))
            && finding["limitations"]
                .as_array()
                .ok_or(crate::types::Error::new("invalid_input"))?
                .is_empty()
        {
            return Err(evidence_hint_error(
                "本次save_analysis_evidence未生效：查询结果为空行或部分结果（result_complete!=true）时，同条finding的limitations不能为空数组。",
            ));
        }
    }
    for figure in finding["figures"]
        .as_array()
        .ok_or(crate::types::Error::new("invalid_input"))?
    {
        let fig_qid = figure["query_id"].as_str().unwrap_or("");
        let fig_col = figure["column"].as_str().unwrap_or("");
        let reference = finding["query_refs"]
            .as_array()
            .ok_or(crate::types::Error::new("invalid_input"))?
            .iter()
            .find(|r| {
                r["query_id"] == figure["query_id"]
                    && r["columns"]
                        .as_array()
                        .is_some_and(|columns| columns.contains(&figure["column"]))
            })
            .ok_or_else(|| {
                evidence_hint_error(format!(
                    "本次save_analysis_evidence未生效：figures引用的列 '{}'（query_id={}）未包含在同一条finding对应query_id的query_refs.columns列表中；请把figures用到的全部列名补齐到本条finding的query_refs.columns后重试。",
                    fig_col, fig_qid
                ))
            })?;
        let result = &results[reference["query_id"]
            .as_str()
            .ok_or(crate::types::Error::new("invalid_input"))?];
        let column = result["columns"]
            .as_array()
            .ok_or(Error::new("result_unavailable"))?
            .iter()
            .position(|c| c["name"] == figure["column"])
            .ok_or_else(|| {
                evidence_hint_error(format!(
                    "本次save_analysis_evidence未生效：figures引用的列 '{}' 不在查询结果columns中。",
                    fig_col
                ))
            })?;
        let row_idx = figure["row_index"]
            .as_u64()
            .ok_or(crate::types::Error::new("invalid_input"))? as usize;
        let value = result["rows"]
            .as_array()
            .ok_or(Error::new("result_unavailable"))?
            .get(row_idx)
            .and_then(|row| row.as_array())
            .and_then(|row| row.get(column))
            .ok_or_else(|| {
                evidence_hint_error(format!(
                    "本次save_analysis_evidence未生效：figures引用的 row_index={} 超出查询已保存结果行数范围。",
                    row_idx
                ))
            })?;
        // 原始单元格JSON类型与内容严格逐字核对，不经浮点近似或字符串/数值强转。
        if value != &figure["value"] {
            return Err(evidence_hint_error(format!(
                "本次save_analysis_evidence未生效：figures中列 '{}'（row_index={}）的value与get_query返回的results.rows原始单元格不一致（结果原值JSON类型为{}，本次提交为{}）。请直接原样复制results.rows对应单元格的JSON值与类型（如decimal_string列保持原精确string，原生number/boolean/null保持原JSON类型），切勿做字符串与数值互转或舍入。",
                fig_col,
                row_idx,
                json_value_kind(value),
                json_value_kind(&figure["value"])
            )));
        }
    }
    Ok(())
}

pub struct EvidenceWrite<'a> {
    pub operation_id: &'a str,
    pub message_id: &'a str,
    pub run_id: &'a str,
}

pub async fn save_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    conv: &crate::modules::conversations::LockedConversation,
    write: EvidenceWrite<'_>,
    input: &Value,
    sources: &Value,
    checked_text: &super::context_authority::CheckedTextResults,
) -> Result<Value> {
    let cid = conv.id.as_str();
    let EvidenceWrite {
        operation_id: operation,
        message_id,
        run_id,
    } = write;
    let tasks = analysis::lock_tasks_in_tx(tx, cid).await?;
    let conditions = analysis::read_evidence_conditions_in_tx(
        tx,
        ctx,
        cid,
        input["task_id"]
            .as_str()
            .ok_or(Error::new("invalid_input"))?,
        epoch(
            input["condition_version"]
                .as_str()
                .ok_or(Error::new("invalid_input"))?,
        )?,
    )
    .await?;
    super::knowledge::check_adoptable_refs_in_tx(tx, ctx, &conditions["knowledge_refs"]).await?;
    for reference in sources["result_dependencies"]
        .as_array()
        .ok_or(Error::new("invalid_evidence"))?
    {
        let query = queries::read_in_tx(
            tx,
            ctx,
            reference["query_id"]
                .as_str()
                .ok_or(Error::new("invalid_evidence"))?,
        )
        .await?;
        assert_query(&query, cid, input, reference)?;
        if queries::is_confirmation_message_in_tx(
            tx,
            ctx,
            reference["query_id"]
                .as_str()
                .ok_or(Error::new("invalid_evidence"))?,
            message_id,
        )
        .await?
        {
            return Err(Error::new("invalid_evidence"));
        }
        let query_authority = super::query_workflow::validate_text_in_tx(
            tx,
            ctx,
            cid,
            reference["query_id"]
                .as_str()
                .ok_or(Error::new("invalid_evidence"))?,
            checked_text,
        )
        .await?;
        // 引用成功结果也继承生成该查询时的来源，不能只留下结果自身的可读权限。
        super::context_authority::merge_run_in_tx(tx, run_id, &query_authority).await?;
    }
    super::knowledge::check_adoptable_refs_in_tx(tx, ctx, &sources["knowledge_refs"]).await?;
    super::context_authority::merge_run_in_tx(
        tx,
        run_id,
        &super::context_authority::from_sources(sources)?,
    )
    .await?;
    analysis::save_evidence_in_tx(
        tx,
        &tasks,
        ctx,
        operation,
        message_id,
        input,
        analysis::EvidenceSaveSources {
            references: sources,
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn figures_preserve_exact_decimal_and_must_be_in_the_finding_references() {
        let result = json!({"columns":[{"name":"amount"}],"rows":[["9007199254740993.01"]],"result_complete":true});
        let results = BTreeMap::from([("q".into(), result)]);
        let mut finding = json!({"query_refs":[{"query_id":"q","columns":["amount"]}],"limitations":[],"figures":[{"query_id":"q","column":"amount","row_index":0,"value":"9007199254740993.01"}]});
        assert!(validate_finding(&finding, &results).is_ok());
        finding["figures"][0]["value"] = json!(9007199254740992.0);
        assert_eq!(
            validate_finding(&finding, &results).unwrap_err().code,
            "invalid_evidence"
        );
        finding["figures"][0]["value"] = json!("9007199254740993.01");
        finding["query_refs"] = json!([]);
        assert_eq!(
            validate_finding(&finding, &results).unwrap_err().code,
            "invalid_evidence"
        );
    }
    #[test]
    fn partial_or_empty_results_require_an_explicit_limitation() {
        for result in [
            json!({"columns":[{"name":"amount"}],"rows":[],"result_complete":true}),
            json!({"columns":[{"name":"amount"}],"rows":[["1"]],"result_complete":false}),
        ] {
            let results = BTreeMap::from([("q".into(), result)]);
            let mut finding = json!({"query_refs":[{"query_id":"q","columns":["amount"]}],"limitations":[],"figures":[]});
            assert_eq!(
                validate_finding(&finding, &results).unwrap_err().code,
                "invalid_evidence"
            );
            finding["limitations"] = json!(["只覆盖已返回范围"]);
            assert!(validate_finding(&finding, &results).is_ok());
        }
    }

    #[test]
    fn ambiguous_column_names_need_explicit_sql_aliases() {
        let result = json!({"columns":[{"name":"amount"},{"name":"amount"}],"rows":[["1","2"]],"result_complete":true});
        let results = BTreeMap::from([("q".into(), result)]);
        let finding = json!({"query_refs":[{"query_id":"q","columns":["amount"]}],"limitations":[],"figures":[]});
        assert_eq!(
            validate_finding(&finding, &results).unwrap_err().code,
            "invalid_evidence"
        );
    }

    #[test]
    fn native_sqlite_numeric_cells_reject_stringified_figures_and_missing_query_ref_columns() {
        let result = json!({
            "columns": [
                {"name": "build_id"},
                {"name": "observed_days"},
                {"name": "task_completion_rate"}
            ],
            "rows": [
                ["SB2", 30, 0.44221105527638194],
                ["SB3", 7, 0.4166666666666667],
                ["SB4", 0, null]
            ],
            "result_complete": true
        });
        let results = BTreeMap::from([("q_voice".into(), result)]);
        let missing_col_finding = json!({
            "query_refs": [{"query_id": "q_voice", "columns": ["build_id", "task_completion_rate"]}],
            "limitations": [],
            "figures": [
                {"query_id": "q_voice", "column": "observed_days", "row_index": 0, "value": 30}
            ]
        });
        let missing_err = validate_finding(&missing_col_finding, &results).unwrap_err();
        assert_eq!(missing_err.code, "invalid_evidence");
        assert!(
            missing_err.details.unwrap()["hint"]
                .as_str()
                .unwrap()
                .contains("observed_days")
        );

        let stringified_finding = json!({
            "query_refs": [{"query_id": "q_voice", "columns": ["build_id", "observed_days", "task_completion_rate"]}],
            "limitations": [],
            "figures": [
                {"query_id": "q_voice", "column": "observed_days", "row_index": 1, "value": "7"}
            ]
        });
        let type_err = validate_finding(&stringified_finding, &results).unwrap_err();
        assert_eq!(type_err.code, "invalid_evidence");
        let type_hint = type_err.details.unwrap()["hint"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(type_hint.contains("number") && type_hint.contains("string"));

        let native_finding = json!({
            "query_refs": [{"query_id": "q_voice", "columns": ["build_id", "observed_days", "task_completion_rate"]}],
            "limitations": [],
            "figures": [
                {"query_id": "q_voice", "column": "observed_days", "row_index": 1, "value": 7},
                {"query_id": "q_voice", "column": "task_completion_rate", "row_index": 1, "value": 0.4166666666666667},
                {"query_id": "q_voice", "column": "task_completion_rate", "row_index": 2, "value": null}
            ]
        });
        assert!(validate_finding(&native_finding, &results).is_ok());
    }
}

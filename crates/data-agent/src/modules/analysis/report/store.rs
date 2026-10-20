use super::super::evidence::read_evidence_in_tx;
use super::super::store::{LockedTasks, assert_current_in_tx};
use crate::{
    contracts,
    persistence::AppTx,
    types::{AccessContext, Error, Result, epoch, fingerprint, id},
};
use serde_json::{Value, json};
use sqlx::Row;

const MAX_REPORT_BYTES: usize = 768 * 1024;

fn command_fingerprint(ctx: &AccessContext, cid: &str, input: &Value) -> String {
    fingerprint(&json!({"input":input,"conversation_id":cid,"space_id":ctx.space_id}))
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

pub async fn report_receipt_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    operation: &str,
    input: &Value,
) -> Result<Option<Value>> {
    let row = sqlx::query("SELECT space_id,conversation_id,fingerprint,receipt FROM analysis_report_operations WHERE owner_id=? AND operation_id=?")
        .bind(&ctx.user_id).bind(operation).fetch_optional(tx.connection()).await?;
    let Some(row) = row else {
        return Ok(None);
    };
    if row.get::<String, _>("fingerprint") != command_fingerprint(ctx, cid, input)
        || row.get::<String, _>("space_id") != ctx.space_id
        || row.get::<String, _>("conversation_id") != cid
    {
        return Err(Error::new("idempotency_conflict"));
    }
    let receipt = row.get::<sqlx::types::Json<Value>, _>("receipt").0;
    Ok((!receipt.is_null()).then_some(receipt))
}

pub struct ReportSaveSources<'a> {
    pub evidence: &'a [Value],
    pub title_authorities: &'a Value,
}

fn report_body(
    input: &Value,
    reference: &Value,
    created_at: &str,
    validated_evidence: &[Value],
) -> Result<Value> {
    contracts::validate("SaveAnalysisReportInput", input)?;
    contracts::validate("AnalysisReportRef", reference)?;
    let requested = input["evidence_ids"]
        .as_array()
        .expect("validated evidence ids");
    if validated_evidence.len() != requested.len() {
        return Err(Error::new("invalid_evidence"));
    }
    let mut evidence = Vec::new();
    for evidence_id in requested {
        let matches = validated_evidence
            .iter()
            .filter(|item| item["reference"]["evidence_id"] == *evidence_id)
            .collect::<Vec<_>>();
        let [item] = matches.as_slice() else {
            return Err(Error::new("invalid_evidence"));
        };
        contracts::validate("AnalysisEvidence", item)?;
        if item["reference"]["conversation_id"] != reference["conversation_id"] {
            return Err(Error::new("invalid_evidence"));
        }
        evidence.push((*item).clone());
    }
    for chart in input["charts"].as_array().expect("validated charts") {
        let linked = evidence.iter().any(|item| {
            item["findings"]
                .as_array()
                .expect("validated findings")
                .iter()
                .any(|finding| {
                    finding["query_refs"]
                        .as_array()
                        .expect("validated query refs")
                        .iter()
                        .any(|query| {
                            query["query_id"] == chart["query_id"]
                                && query["result_ref"] == chart["result_ref"]
                                && query["columns"].as_array().is_some_and(|columns| {
                                    columns.contains(&chart["dimension_column"])
                                        && columns.contains(&chart["measure_column"])
                                })
                        })
                })
        });
        if !linked {
            return Err(Error::new("invalid_evidence"));
        }
    }
    // 正文只组装已有依据；保存结果行仍归M07，不能被报告副本绕过撤权。
    let body = json!({"schema_version":1,"reference":reference,"title":input["title"],
        "charts":input["charts"],"evidence":evidence,"created_at":created_at});
    contracts::validate("AnalysisReport", &body)?;
    if serde_json::to_vec(&body)
        .map_err(|_| Error::new("invalid_input"))?
        .len()
        > MAX_REPORT_BYTES
    {
        return Err(Error::new("payload_limit"));
    }
    Ok(body)
}

pub async fn save_report_in_tx(
    tx: &mut AppTx<'_>,
    tasks: &LockedTasks,
    ctx: &AccessContext,
    operation: &str,
    message_id: &str,
    input: &Value,
    sources: ReportSaveSources<'_>,
) -> Result<Value> {
    let ReportSaveSources {
        evidence: validated_evidence,
        title_authorities: text_authorities,
    } = sources;
    tasks.assert_transaction(tx)?;
    if !valid_id(operation) || !valid_id(message_id) {
        return Err(Error::new("invalid_input"));
    }
    contracts::validate("SaveAnalysisReportInput", input)?;
    let cid = tasks.conversation_id();
    let command_fingerprint = command_fingerprint(ctx, cid, input);
    // 回执先于当前版本检查；旧操作恢复只接回原引用，不重建失效正文。
    sqlx::query("INSERT INTO analysis_report_operations(owner_id,space_id,operation_id,conversation_id,fingerprint,receipt) VALUES(?,?,?,?,?,CAST('null' AS JSON)) ON DUPLICATE KEY UPDATE operation_id=VALUES(operation_id)")
        .bind(&ctx.user_id).bind(&ctx.space_id).bind(operation).bind(cid).bind(&command_fingerprint).execute(tx.connection()).await?;
    let saved = sqlx::query("SELECT space_id,conversation_id,fingerprint,receipt FROM analysis_report_operations WHERE owner_id=? AND operation_id=? FOR UPDATE")
        .bind(&ctx.user_id).bind(operation).fetch_one(tx.connection()).await?;
    if saved.get::<String, _>("fingerprint") != command_fingerprint
        || saved.get::<String, _>("space_id") != ctx.space_id
        || saved.get::<String, _>("conversation_id") != cid
    {
        return Err(Error::new("idempotency_conflict"));
    }
    let receipt = saved.get::<sqlx::types::Json<Value>, _>("receipt").0;
    if !receipt.is_null() {
        return Ok(receipt);
    }
    let task = input["task_id"].as_str().expect("validated task id");
    let condition_version = epoch(
        input["condition_version"]
            .as_str()
            .expect("validated version"),
    )?;
    let own = sqlx::query(
        "SELECT id FROM analysis_tasks WHERE id=? AND conversation_id=? AND owner_id=?",
    )
    .bind(task)
    .bind(cid)
    .bind(&ctx.user_id)
    .fetch_optional(tx.connection())
    .await?;
    if own.is_none() {
        return Err(Error::new("not_available"));
    }
    assert_current_in_tx(tx, cid, task, condition_version).await?;
    let previous = sqlx::query("SELECT id,version FROM analysis_reports WHERE task_id=? AND conversation_id=? AND owner_id=? AND space_id=? FOR UPDATE")
        .bind(task).bind(cid).bind(&ctx.user_id).bind(&ctx.space_id).fetch_optional(tx.connection()).await?;
    let (report_id, version, current_version) = match previous {
        Some(row) => {
            let current = row.get::<u64, _>("version");
            if input["expected_version"].as_str().map(epoch).transpose()? != Some(current) {
                return Err(Error::new("version_conflict"));
            }
            (
                row.get::<String, _>("id"),
                current
                    .checked_add(1)
                    .ok_or(Error::new("version_conflict"))?,
                Some(current),
            )
        }
        None => {
            if !input["expected_version"].is_null() {
                return Err(Error::new("version_conflict"));
            }
            (id(), 1, None)
        }
    };
    let reference = json!({"report_id":report_id,"conversation_id":cid,"task_id":task,
        "condition_version":condition_version.to_string(),"version":version.to_string()});
    let created_at = sqlx::query_scalar::<_, String>(
        "SELECT DATE_FORMAT(UTC_TIMESTAMP(3),'%Y-%m-%dT%H:%i:%s.%fZ')",
    )
    .fetch_one(tx.connection())
    .await?;
    let body = report_body(input, &reference, &created_at, validated_evidence)?;
    // M06回源比对不可变依据，薄组合层传入的校验结果不能替换已存正文。
    for evidence in body["evidence"].as_array().expect("validated evidence") {
        let saved = read_evidence_in_tx(
            tx,
            ctx,
            evidence["reference"]["evidence_id"]
                .as_str()
                .expect("validated evidence id"),
        )
        .await?;
        if saved != *evidence {
            return Err(Error::new("invalid_evidence"));
        }
    }
    sqlx::query("INSERT INTO analysis_report_revisions(report_id,version,condition_version,source_message_id,body,text_authorities) VALUES(?,?,?,?,?,?)")
        .bind(&report_id).bind(version).bind(condition_version).bind(message_id).bind(sqlx::types::Json(&body)).bind(sqlx::types::Json(text_authorities)).execute(tx.connection()).await?;
    if let Some(current) = current_version {
        let updated = sqlx::query("UPDATE analysis_reports SET version=?,reference=?,updated_at=UTC_TIMESTAMP(3) WHERE id=? AND version=?")
            .bind(version).bind(sqlx::types::Json(&reference)).bind(&report_id).bind(current).execute(tx.connection()).await?;
        if updated.rows_affected() != 1 {
            return Err(Error::new("version_conflict"));
        }
    } else {
        sqlx::query("INSERT INTO analysis_reports(id,owner_id,space_id,conversation_id,task_id,version,reference) VALUES(?,?,?,?,?,?,?)")
            .bind(&report_id).bind(&ctx.user_id).bind(&ctx.space_id).bind(cid).bind(task).bind(version).bind(sqlx::types::Json(&reference)).execute(tx.connection()).await?;
    }
    sqlx::query("UPDATE analysis_report_operations SET receipt=? WHERE owner_id=? AND operation_id=? AND fingerprint=?")
        .bind(sqlx::types::Json(&reference)).bind(&ctx.user_id).bind(operation).bind(&command_fingerprint).execute(tx.connection()).await?;
    Ok(reference)
}

pub async fn read_report_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    task: &str,
) -> Result<Value> {
    let body = sqlx::query_scalar::<_, sqlx::types::Json<Value>>("SELECT r.body FROM analysis_reports h JOIN analysis_report_revisions r ON r.report_id=h.id AND r.version=h.version WHERE h.owner_id=? AND h.space_id=? AND h.conversation_id=? AND h.task_id=?")
        .bind(&ctx.user_id).bind(&ctx.space_id).bind(cid).bind(task).fetch_optional(tx.connection()).await?.ok_or(Error::new("not_available"))?.0;
    contracts::validate("AnalysisReport", &body)?;
    Ok(body)
}

pub async fn report_ref_in_tx(tx: &mut AppTx<'_>, cid: &str, task: &str) -> Result<Option<Value>> {
    Ok(sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
        "SELECT reference FROM analysis_reports WHERE conversation_id=? AND task_id=?",
    )
    .bind(cid)
    .bind(task)
    .fetch_optional(tx.connection())
    .await?
    .map(|reference| reference.0))
}

pub async fn read_report_authorities_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    reference: &Value,
) -> Result<Value> {
    Ok(sqlx::query_scalar::<_, Option<sqlx::types::Json<Value>>>(
        "SELECT r.text_authorities FROM analysis_reports h JOIN analysis_report_revisions r ON r.report_id=h.id WHERE h.owner_id=? AND h.space_id=? AND h.conversation_id=? AND h.id=? AND r.version=?",
    )
    .bind(&ctx.user_id).bind(&ctx.space_id)
    .bind(reference["conversation_id"].as_str().ok_or(Error::new("invalid_input"))?)
    .bind(reference["report_id"].as_str().ok_or(Error::new("invalid_input"))?)
    .bind(epoch(reference["version"].as_str().ok_or(Error::new("invalid_input"))?)?)
    .fetch_optional(tx.connection()).await?.ok_or(Error::new("not_available"))?
    .map(|value| value.0).unwrap_or(Value::Null))
}

pub async fn delete_conversation_reports_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
) -> Result<()> {
    sqlx::query("DELETE r FROM analysis_report_revisions r JOIN analysis_reports h ON h.id=r.report_id WHERE h.owner_id=? AND h.space_id=? AND h.conversation_id=?")
        .bind(&ctx.user_id).bind(&ctx.space_id).bind(cid).execute(tx.connection()).await?;
    sqlx::query("DELETE FROM analysis_report_operations WHERE owner_id=? AND space_id=? AND conversation_id=?")
        .bind(&ctx.user_id).bind(&ctx.space_id).bind(cid).execute(tx.connection()).await?;
    sqlx::query(
        "DELETE FROM analysis_reports WHERE owner_id=? AND space_id=? AND conversation_id=?",
    )
    .bind(&ctx.user_id)
    .bind(&ctx.space_id)
    .bind(cid)
    .execute(tx.connection())
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn evidence() -> Value {
        json!({"schema_version":1,"data_range":"2026年合成付款订单",
            "conditions":{"time_start":null,"time_end":null,"timezone":"UTC","metric":null,"channel":null,"group_by":[],"filters":[],"knowledge_refs":[],"notes":""},
            "findings":[{"text":"合成收入为9007199254740993.01元","calculation":"读取已保存结果的amount列","limitations":["只能说明该合成范围"],
                "query_refs":[{"query_id":"query-one","result_ref":"result-one","columns":["month","amount"]}],"knowledge_refs":[],
                "figures":[{"label":"收入","query_id":"query-one","column":"amount","row_index":0,"value":"9007199254740993.01"}]}],
            "validated_sources":{"result_dependencies":[{"query_id":"query-one","result_ref":"result-one"}],"query_coverage":[],"knowledge_refs":[]},
            "reference":{"evidence_id":"evidence-one","conversation_id":"conversation-one","task_id":"task-one","condition_version":"1","result_dependencies":[{"query_id":"query-one","result_ref":"result-one"}]},
            "source_message_id":"message-one"})
    }

    fn input() -> Value {
        json!({"task_id":"task-one","condition_version":"1","expected_version":null,"title":"合成月度收入","evidence_ids":["evidence-one"],
            "charts":[{"kind":"line","title":"各月收入","query_id":"query-one","result_ref":"result-one","dimension_column":"month","measure_column":"amount"}]})
    }

    fn reference() -> Value {
        json!({"report_id":"report-one","conversation_id":"conversation-one","task_id":"task-one","condition_version":"1","version":"1"})
    }

    #[test]
    fn report_preserves_evidence_values_and_has_no_saved_result_rows() {
        let evidence = evidence();
        let report = report_body(
            &input(),
            &reference(),
            "2026-10-13T00:00:00Z",
            std::slice::from_ref(&evidence),
        )
        .unwrap();
        assert_eq!(report["evidence"][0], evidence);
        assert_eq!(
            report["evidence"][0]["findings"][0]["figures"][0]["value"],
            "9007199254740993.01"
        );
        let mut copied = report;
        copied["rows"] = json!([["private-row"]]);
        assert!(contracts::validate("AnalysisReport", &copied).is_err());
    }

    #[test]
    fn report_requires_selected_evidence_from_the_same_conversation() {
        for path in ["conversation_id", "evidence_id"] {
            let mut evidence = evidence();
            evidence["reference"][path] = json!("other");
            assert!(
                report_body(&input(), &reference(), "2026-10-13T00:00:00Z", &[evidence]).is_err()
            );
        }
        assert!(report_body(&input(), &reference(), "2026-10-13T00:00:00Z", &[]).is_err());
    }

    #[test]
    fn report_preserves_each_sources_task_conditions_and_exact_values() {
        let original = evidence();
        let mut other = evidence();
        other["reference"]["evidence_id"] = json!("other-evidence");
        other["reference"]["task_id"] = json!("other-task");
        other["reference"]["condition_version"] = json!("3");
        other["conditions"]["filters"] = json!(["is_test=0"]);
        let mut input = input();
        input["evidence_ids"] = json!(["evidence-one", "other-evidence"]);
        let report = report_body(
            &input,
            &reference(),
            "2026-10-19T00:00:00Z",
            &[original.clone(), other.clone()],
        )
        .unwrap();
        assert_eq!(report["evidence"], json!([original, other]));
        assert_eq!(report["reference"], reference());
    }

    #[test]
    fn report_charts_must_reference_columns_in_selected_findings() {
        for path in [
            "query_id",
            "result_ref",
            "dimension_column",
            "measure_column",
        ] {
            let mut input = input();
            input["charts"][0][path] = json!("not-selected");
            assert_eq!(
                report_body(&input, &reference(), "2026-10-13T00:00:00Z", &[evidence()])
                    .unwrap_err()
                    .code,
                "invalid_evidence"
            );
        }
    }
}

use super::super::store::LockedTasks;
use crate::{
    contracts,
    persistence::{
        AppTx,
        receipts::{self, Operation},
    },
    types::{AccessContext, Error, Result, epoch, id},
};
use serde_json::{Value, json};
use sqlx::Row;

const MAX_EVIDENCE_BYTES: usize = 128 * 1024;

pub struct EvidenceSaveSources<'a> {
    pub references: &'a Value,
}

/// 来源条件沿原任务版本读取；任务后来修订或取消不改写已经成功查询的含义。
/// 调用方先经会话模块校验当前空间与本人访问，再核对资料和结果的当前可用性。
pub async fn read_evidence_conditions_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    task: &str,
    version: u64,
) -> Result<Value> {
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
    let conditions = sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
        "SELECT body FROM condition_revisions WHERE task_id=? AND version=?",
    )
    .bind(task)
    .bind(version)
    .fetch_optional(tx.connection())
    .await?
    .ok_or(Error::new("invalid_evidence"))?
    .0;
    contracts::validate("Conditions", &conditions)?;
    Ok(conditions)
}

fn evidence_body(input: &Value, conditions: Value, sources: &Value) -> Result<Value> {
    contracts::validate("SaveAnalysisEvidenceInput", input)?;
    contracts::validate("AnalysisEvidenceSources", sources)?;
    contracts::validate("Conditions", &conditions)?;
    let body = json!({"schema_version":1,"data_range":input["data_range"],"findings":input["findings"],"conditions":conditions,"validated_sources":sources});
    if serde_json::to_vec(&body)
        .map_err(|_| Error::new("invalid_input"))?
        .len()
        > MAX_EVIDENCE_BYTES
    {
        return Err(Error::new("payload_limit"));
    }
    Ok(body)
}

pub async fn save_evidence_in_tx(
    tx: &mut AppTx<'_>,
    tasks: &LockedTasks,
    ctx: &AccessContext,
    operation: &str,
    message_id: &str,
    input: &Value,
    sources: EvidenceSaveSources<'_>,
) -> Result<Value> {
    let EvidenceSaveSources {
        references: validated_sources,
    } = sources;
    tasks.assert_transaction(tx)?;
    if operation.is_empty()
        || operation.len() > 64
        || message_id.is_empty()
        || message_id.len() > 64
    {
        return Err(Error::new("invalid_input"));
    }
    let cid = tasks.conversation_id();
    let command = json!({"input":input,"conversation_id":cid,"space_id":ctx.space_id});
    let receipt = Operation::new(ctx, "analysis_evidence", operation, &command);
    if let Some(saved) = receipt.begin(tx).await? {
        return Ok(saved);
    }
    contracts::validate("SaveAnalysisEvidenceInput", input)?;
    let task = input["task_id"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?;
    let version = epoch(input["condition_version"].as_str().unwrap_or(""))?;
    let conditions = read_evidence_conditions_in_tx(tx, ctx, cid, task, version).await?;
    let body = evidence_body(input, conditions, validated_sources)?;
    let evidence_id = id();
    let reference = json!({"evidence_id":evidence_id,"conversation_id":cid,"task_id":task,"condition_version":version.to_string(),"result_dependencies":validated_sources["result_dependencies"]});
    contracts::validate("AnalysisEvidenceRef", &reference)?;
    sqlx::query("INSERT INTO analysis_evidence(id,owner_id,space_id,conversation_id,task_id,condition_version,source_message_id,body,reference) VALUES(?,?,?,?,?,?,?,?,?)")
        .bind(&evidence_id).bind(&ctx.user_id).bind(&ctx.space_id).bind(cid).bind(task).bind(version).bind(message_id)
        .bind(sqlx::types::Json(&body)).bind(sqlx::types::Json(&reference)).execute(tx.connection()).await?;
    receipt.complete(tx, &reference).await?;
    Ok(reference)
}

pub async fn read_evidence_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    evidence: &str,
) -> Result<Value> {
    let row=sqlx::query("SELECT body,reference,source_message_id FROM analysis_evidence WHERE id=? AND owner_id=? AND space_id=?")
        .bind(evidence).bind(&ctx.user_id).bind(&ctx.space_id).fetch_optional(tx.connection()).await?.ok_or(Error::new("not_available"))?;
    let mut body = row.get::<sqlx::types::Json<Value>, _>("body").0;
    let reference = row.get::<sqlx::types::Json<Value>, _>("reference").0;
    body["reference"] = reference;
    body["source_message_id"] = json!(row.get::<String, _>("source_message_id"));
    Ok(body)
}

pub async fn evidence_result_refs_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    ids: &[String],
) -> Result<Vec<Value>> {
    let references: Vec<sqlx::types::Json<Vec<Value>>> = sqlx::query_scalar(
        "SELECT JSON_EXTRACT(reference,'$.result_dependencies') FROM analysis_evidence WHERE conversation_id=? AND owner_id=? AND space_id=? \
         AND id IN (SELECT selected.id FROM JSON_TABLE(?,'$[*]' COLUMNS(id VARCHAR(64) PATH '$')) selected)",
    ).bind(cid).bind(&ctx.user_id).bind(&ctx.space_id).bind(sqlx::types::Json(ids))
    .fetch_all(tx.connection()).await?;
    if references.len() != ids.len() {
        return Err(Error::new("stale_context"));
    }
    Ok(references.into_iter().flat_map(|value| value.0).collect())
}

pub(in crate::modules::analysis) async fn refs_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
    task: &str,
    version: u64,
) -> Result<Vec<Value>> {
    let references=sqlx::query_scalar::<_,sqlx::types::Json<Value>>("SELECT reference FROM analysis_evidence WHERE conversation_id=? AND task_id=? AND condition_version=? ORDER BY created_at DESC,id DESC LIMIT 5")
        .bind(cid).bind(task).bind(version).fetch_all(tx.connection()).await?;
    Ok(references.into_iter().map(|value| value.0).collect())
}

pub async fn delete_evidence_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    evidence: &str,
) -> Result<()> {
    let row = sqlx::query(
        "SELECT id FROM analysis_evidence WHERE id=? AND owner_id=? AND space_id=? FOR UPDATE",
    )
    .bind(evidence)
    .bind(&ctx.user_id)
    .bind(&ctx.space_id)
    .fetch_optional(tx.connection())
    .await?;
    if row.is_none() {
        return Err(Error::new("not_available"));
    }
    receipts::delete_subject(tx, ctx, "analysis_evidence", "$.evidence_id", evidence).await?;
    sqlx::query("DELETE FROM analysis_evidence WHERE id=? AND owner_id=? AND space_id=?")
        .bind(evidence)
        .bind(&ctx.user_id)
        .bind(&ctx.space_id)
        .execute(tx.connection())
        .await?;
    Ok(())
}

pub async fn delete_conversation_evidence_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
) -> Result<()> {
    receipts::delete_subject(tx, ctx, "analysis_evidence", "$.conversation_id", cid).await?;
    sqlx::query(
        "DELETE FROM analysis_evidence WHERE owner_id=? AND space_id=? AND conversation_id=?",
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
    fn input() -> Value {
        json!({"task_id":"task-one","condition_version":"2","data_range":"本月付款订单","findings":[{"text":"收入有所下降","calculation":"按两期净收入比较","limitations":["不证明业务因果"],"query_refs":[],"knowledge_refs":[],"figures":[]}]})
    }
    fn conditions() -> Value {
        json!({"time_start":null,"time_end":null,"timezone":"UTC","metric":null,"channel":null,"group_by":[],"filters":[],"knowledge_refs":[],"notes":""})
    }
    fn sources() -> Value {
        json!({"result_dependencies":[],"query_coverage":[],"knowledge_refs":[]})
    }
    #[test]
    fn evidence_keeps_conditions_and_validated_refs_without_complete_rows() {
        let body = evidence_body(&input(), conditions(), &sources()).unwrap();
        assert_eq!(body["conditions"], conditions());
        assert_eq!(
            body["findings"][0]["limitations"],
            json!(["不证明业务因果"])
        );
        let mut invalid = sources();
        invalid["rows"] = json!([["private-result"]]);
        assert!(evidence_body(&input(), conditions(), &invalid).is_err());
    }
    #[test]
    fn combined_evidence_body_has_an_explicit_size_bound() {
        let mut input = input();
        let mut finding = input["findings"][0].clone();
        finding["text"] = json!("结论".repeat(2000));
        finding["calculation"] = json!("计算".repeat(1500));
        input["findings"] = json!(vec![finding; 12]);
        assert!(contracts::validate("SaveAnalysisEvidenceInput", &input).is_ok());
        assert_eq!(
            evidence_body(&input, conditions(), &sources())
                .unwrap_err()
                .code,
            "payload_limit"
        );
    }
}

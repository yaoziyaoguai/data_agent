#[path = "checkpoints/store.rs"]
mod checkpoints;
pub(super) use checkpoints::{bind_legacy_delivery_checkpoint, save_checkpoint};

pub(crate) use checkpoints::{
    DELIVERY_HISTORY_SQL, decode_delivery_history, push_legacy_checkpoint_run,
};

#[path = "budget/store.rs"]
mod budget;
pub(crate) use budget::DELIVERY_BUDGET_SQL;
pub use budget::{budget_message_in_tx, read_budget_profile_in_tx};
pub(super) use budget::{issue_call, open_budget, settle_call};

use crate::{
    persistence::AppTx,
    types::{Error, Result, id},
};
use serde_json::{Value, json};
use sqlx::{MySqlPool, Row};

/// 持久工具身份由运行模块负责；其他业务模块不读取工具账本。
pub async fn recorded_tool_operations_in_tx(
    tx: &mut AppTx<'_>,
    operations: &[String],
) -> Result<Vec<String>> {
    let mut recorded = Vec::new();
    for chunk in operations.chunks(256) {
        let mut query = sqlx::QueryBuilder::<sqlx::MySql>::new(
            "SELECT operation_id FROM tool_calls WHERE operation_id IN (",
        );
        let mut separated = query.separated(",");
        for operation in chunk {
            separated.push_bind(operation);
        }
        separated.push_unseparated(")");
        recorded.extend(
            query
                .build_query_scalar::<String>()
                .fetch_all(tx.connection())
                .await?,
        );
    }
    Ok(recorded)
}

pub async fn assert_tools_settled_in_tx(tx: &mut AppTx<'_>, run: &LockedRun) -> Result<()> {
    let pending: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tool_calls t JOIN agent_runs r ON r.id=t.origin_run_id WHERE r.recovery_chain_id=? AND t.state='registered'")
        .bind(&run.recovery_chain_id).fetch_one(tx.connection()).await?;
    if pending != 0 {
        return Err(Error::new("outcome_unknown"));
    }
    Ok(())
}

pub async fn delivery_task_refs_in_tx(tx: &mut AppTx<'_>, run: &LockedRun) -> Result<Vec<Value>> {
    let receipts: Vec<sqlx::types::Json<Value>> = sqlx::query_scalar("SELECT t.receipt FROM tool_calls t JOIN agent_runs r ON r.id=t.origin_run_id WHERE r.recovery_chain_id=? AND t.state='succeeded' AND t.tool_name='update_analysis_task' AND t.receipt IS NOT NULL")
        .bind(&run.recovery_chain_id).fetch_all(tx.connection()).await?;
    Ok(receipts
        .into_iter()
        .map(|r| r.0["data"].clone())
        .filter(|v| v["task_id"].is_string() && v["condition_version"].is_string())
        .collect())
}

/// 只有本输入明确选用后的原生 Skill 文件精读才能成为衍生来源。
pub async fn read_skill_sources_in_tx(
    tx: &mut AppTx<'_>,
    conversation: &str,
    recovery_chain: &str,
) -> Result<Vec<Value>> {
    let refs: Vec<sqlx::types::Json<Value>> = sqlx::query_scalar(
        "SELECT DISTINCT JSON_ARRAY(JSON_EXTRACT(receipt,'$.data.id'), JSON_EXTRACT(receipt,'$.data.version')) \
         FROM tool_calls WHERE conversation_id=? AND recovery_chain_id=? AND tool_name='read' \
         AND state='succeeded' AND JSON_UNQUOTE(JSON_EXTRACT(receipt,'$.data.kind'))='skill'",
    )
    .bind(conversation)
    .bind(recovery_chain)
    .fetch_all(tx.connection())
    .await?;
    Ok(refs.into_iter().map(|reference| reference.0).collect())
}

// 原控制事实归运行账本所有：本恢复链各成功回执携带的控制投影，按运行创建时序返回。
// 只暴露控制投影本身，不把整份回执或通用SQL入口交给协调层。
pub async fn control_deliveries_in_tx(tx: &mut AppTx<'_>, run: &LockedRun) -> Result<Vec<Value>> {
    let receipts: Vec<sqlx::types::Json<Value>> = sqlx::query_scalar(
        "SELECT t.receipt FROM tool_calls t JOIN agent_runs r ON r.id=t.origin_run_id \
         WHERE r.recovery_chain_id=? AND t.state='succeeded' AND t.receipt IS NOT NULL \
         ORDER BY r.created_at,t.operation_id",
    )
    .bind(&run.recovery_chain_id)
    .fetch_all(tx.connection())
    .await?;
    Ok(receipts
        .into_iter()
        .filter_map(|receipt| {
            let delivery = receipt.0.get("control_delivery")?.clone();
            delivery
                .as_object()
                .is_some_and(|object| object.contains_key("fingerprint"))
                .then_some(delivery)
        })
        .collect())
}

pub struct LockedRun {
    pub id: String,
    pub conversation_id: String,
    pub message_id: String,
    pub recovery_chain_id: String,
    pub budget_scope_id: String,
    pub tool_contract_version: u8,
    pub lease_epoch: u64,
    pub state: String,
    pub output_id: String,
    pub attempt_id: String,
    pub commit_id: Option<String>,
    pub commit_fingerprint: Option<String>,
    pub job_id: String,
    pub job_lease_epoch: u64,
    pub(super) transaction_id: String,
}
pub struct LockedTool {
    pub operation_id: String,
    pub origin_run_id: String,
    pub tool_contract_version: u8,
    pub fingerprint: String,
    pub state: String,
    pub receipt: Option<Value>,
    pub answer_handoff: Option<Value>,
    pub task_id: Option<String>,
    pub task_condition_version: Option<u64>,
    pub execution_started: Option<bool>,
    pub(super) transaction_id: String,
}
pub struct RunStart<'a> {
    pub run_id: &'a str,
    pub conversation_id: &'a str,
    pub message_id: &'a str,
    pub recovery_chain_id: &'a str,
    pub budget_scope_id: &'a str,
    pub tool_contract_version: u8,
    pub lease_epoch: u64,
    pub job_id: &'a str,
    pub job_lease_epoch: u64,
}

pub async fn locate_run(pool: &MySqlPool, run_id: &str) -> Result<String> {
    sqlx::query_scalar("SELECT conversation_id FROM agent_runs WHERE id=?")
        .bind(run_id)
        .fetch_optional(pool)
        .await?
        .ok_or(Error::new("not_available"))
}
pub(super) async fn lock_run(tx: &mut AppTx<'_>, run_id: &str, cid: &str) -> Result<LockedRun> {
    tx.lock_rank(2)?;
    let row = sqlx::query("SELECT * FROM agent_runs WHERE id=? AND conversation_id=? FOR UPDATE")
        .bind(run_id)
        .bind(cid)
        .fetch_optional(tx.connection())
        .await?
        .ok_or(Error::new("not_available"))?;
    Ok(LockedRun {
        id: row.get("id"),
        conversation_id: row.get("conversation_id"),
        message_id: row.get("message_id"),
        recovery_chain_id: row.get("recovery_chain_id"),
        budget_scope_id: row.get("budget_scope_id"),
        tool_contract_version: row.get("tool_contract_version"),
        lease_epoch: row.get("lease_epoch"),
        state: row.get("state"),
        output_id: row.get("output_id"),
        attempt_id: row.get("attempt_id"),
        commit_id: row.get("commit_id"),
        commit_fingerprint: row.get("commit_fingerprint"),
        job_id: row.get("job_id"),
        job_lease_epoch: row.get("job_lease_epoch"),
        transaction_id: tx.id().into(),
    })
}
// 同会话先锁输入，再锁本恢复链的原运行，和原派发写入的锁序一致。
pub(crate) const DELIVERY_PREVIOUS_ATTEMPT_SQL: &str = "(SELECT JSON_ARRAY(output_id,attempt_id)
    FROM agent_runs WHERE recovery_chain_id=m.recovery_chain_id
    ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE) AS previous_attempt";

pub(super) async fn start_run(
    tx: &mut AppTx<'_>,
    input: RunStart<'_>,
    previous: Option<(String, String)>,
) -> Result<(LockedRun, Option<String>)> {
    tx.lock_rank(2)?;
    // 新运行使用当前合同，已登记工具仍使用各自的持久回执版本。
    let (output_id, replaces) =
        previous.map_or_else(|| (id(), None), |(output, attempt)| (output, Some(attempt)));
    let attempt_id = id();
    sqlx::query(
        "UPDATE agent_runs SET state='interrupted' WHERE conversation_id=? AND state='running'",
    )
    .bind(input.conversation_id)
    .execute(tx.connection())
    .await?;
    if let Some(ref old) = replaces {
        sqlx::query("UPDATE assistant_outputs SET state='superseded' WHERE attempt_id=? AND state!='committed'").bind(old).execute(tx.connection()).await?;
    }
    sqlx::query("INSERT INTO agent_runs(id,conversation_id,message_id,recovery_chain_id,budget_scope_id,tool_contract_version,lease_epoch,state,output_id,attempt_id,job_id,job_lease_epoch) VALUES(?,?,?,?,?,?,?,'running',?,?,?,?)")
 .bind(input.run_id).bind(input.conversation_id).bind(input.message_id).bind(input.recovery_chain_id).bind(input.budget_scope_id).bind(input.tool_contract_version).bind(input.lease_epoch).bind(&output_id).bind(&attempt_id).bind(input.job_id).bind(input.job_lease_epoch).execute(tx.connection()).await?;
    sqlx::query("INSERT INTO assistant_outputs(attempt_id,output_id,run_id,state,replaces_attempt_id) VALUES(?,?,?,'streaming',?)").bind(&attempt_id).bind(&output_id).bind(input.run_id).bind(&replaces).execute(tx.connection()).await?;
    Ok((
        LockedRun {
            id: input.run_id.into(),
            conversation_id: input.conversation_id.into(),
            message_id: input.message_id.into(),
            recovery_chain_id: input.recovery_chain_id.into(),
            budget_scope_id: input.budget_scope_id.into(),
            tool_contract_version: input.tool_contract_version,
            lease_epoch: input.lease_epoch,
            state: "running".into(),
            output_id,
            attempt_id,
            commit_id: None,
            commit_fingerprint: None,
            job_id: input.job_id.into(),
            job_lease_epoch: input.job_lease_epoch,
            transaction_id: tx.id().into(),
        },
        replaces,
    ))
}
pub(super) async fn lock_tool(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
    sdk_id: &str,
) -> Result<Option<LockedTool>> {
    tx.assert_snapshot(&run.transaction_id)?;
    tx.lock_rank(3)?;
    let row=sqlx::query("SELECT * FROM tool_calls WHERE conversation_id=? AND recovery_chain_id=? AND sdk_tool_call_id=? FOR UPDATE").bind(&run.conversation_id).bind(&run.recovery_chain_id).bind(sdk_id).fetch_optional(tx.connection()).await?;
    Ok(row.map(|row| locked_tool(row, tx.id())))
}

// 短续页引用只定位本会话内原成功的v2 evidence搜索回执，不绑定恢复链：
// 同会话下一条消息开新链也必须能续页；归属/删除由调用方同事务的会话锁校验，不跨表重复检查。
// 读取固定路径，不把引用当权限，也不解析任意工具回执或引用链。
pub(super) async fn read_search_cursor(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
    operation: &str,
) -> Result<String> {
    tx.assert_snapshot(&run.transaction_id)?;
    let row = sqlx::query(
        "SELECT JSON_UNQUOTE(JSON_EXTRACT(receipt,'$.data.search_coverage.next')) AS next \
         FROM tool_calls \
         WHERE operation_id=? AND conversation_id=? \
         AND tool_contract_version=2 AND tool_name='search_knowledge' AND state='succeeded' \
         AND JSON_UNQUOTE(JSON_EXTRACT(receipt,'$.data.memory_retrieval')) <> 'excluded_by_view' \
         AND JSON_TYPE(JSON_EXTRACT(receipt,'$.data.search_coverage.next'))='STRING'",
    )
    .bind(operation)
    .bind(&run.conversation_id)
    .fetch_optional(tx.connection())
    .await?;
    let next = row
        .and_then(|row| row.try_get::<Option<String>, _>("next").ok().flatten())
        .ok_or(Error::new("invalid_cursor"))?;
    // 游标语法、长度与解码由SearchSelection::restore统一校验；这里只负责定位。
    Ok(next)
}

// 调用方已持有会话锁；答案只读不在任务锁之后重新获取工具锁。
pub(super) async fn read_answer_tool(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
    sdk_id: &str,
) -> Result<Option<LockedTool>> {
    read_succeeded_tool(tx, run, sdk_id, "present_analysis_answer").await
}

// prepare与present的窄读取分开：不把prepare回执强转成带answer_text的旧答案。
pub(super) async fn read_prepare_tool(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
    sdk_id: &str,
) -> Result<Option<LockedTool>> {
    read_succeeded_tool(tx, run, sdk_id, "prepare_analysis_answer").await
}

async fn read_succeeded_tool(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
    sdk_id: &str,
    tool_name: &str,
) -> Result<Option<LockedTool>> {
    tx.assert_snapshot(&run.transaction_id)?;
    let row = sqlx::query(
        "SELECT * FROM tool_calls WHERE conversation_id=? AND recovery_chain_id=? AND sdk_tool_call_id=? AND tool_name=? AND state='succeeded'",
    )
    .bind(&run.conversation_id)
    .bind(&run.recovery_chain_id)
    .bind(sdk_id)
    .bind(tool_name)
    .fetch_optional(tx.connection()).await?;
    Ok(row.map(|row| locked_tool(row, tx.id())))
}

fn locked_tool(r: sqlx::mysql::MySqlRow, transaction_id: &str) -> LockedTool {
    LockedTool {
        operation_id: r.get("operation_id"),
        origin_run_id: r.get("origin_run_id"),
        tool_contract_version: r.get("tool_contract_version"),
        fingerprint: r.get("arguments_fingerprint"),
        state: r.get("state"),
        receipt: r
            .get::<Option<sqlx::types::Json<Value>>, _>("receipt")
            .map(|v| v.0),
        answer_handoff: r
            .get::<Option<sqlx::types::Json<Value>>, _>("answer_handoff")
            .map(|v| v.0),
        task_id: r.get("task_id"),
        task_condition_version: r.get("task_condition_version"),
        execution_started: r.get("execution_started"),
        transaction_id: transaction_id.into(),
    }
}
pub(super) async fn insert_tool(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
    sdk_id: &str,
    fp: &str,
    name: &str,
) -> Result<String> {
    tx.assert_snapshot(&run.transaction_id)?;
    let operation_id = id();
    sqlx::query("INSERT INTO tool_calls(operation_id,conversation_id,recovery_chain_id,sdk_tool_call_id,origin_run_id,tool_contract_version,tool_name,arguments_fingerprint,state,created_at) VALUES(?,?,?,?,?,?,?,?,'registered',UTC_TIMESTAMP(3))")
 .bind(&operation_id).bind(&run.conversation_id).bind(&run.recovery_chain_id).bind(sdk_id).bind(&run.id).bind(run.tool_contract_version).bind(name).bind(fp).execute(tx.connection()).await?;
    Ok(operation_id)
}
pub async fn bind_tool_task_in_tx(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
    operation: &str,
    task: Option<&(String, u64)>,
) -> Result<()> {
    tx.assert_snapshot(&run.transaction_id)?;
    sqlx::query("UPDATE tool_calls SET task_id=?,task_condition_version=?,execution_started=FALSE WHERE operation_id=? AND origin_run_id=? AND state='registered' AND execution_started IS NULL")
        .bind(task.map(|(id, _)| id.as_str()))
        .bind(task.map(|(_, version)| *version))
        .bind(operation).bind(&run.id)
        .execute(tx.connection()).await?;
    Ok(())
}

pub async fn start_tool_execution_in_tx(tx: &mut AppTx<'_>, tool: &LockedTool) -> Result<()> {
    tx.assert_snapshot(&tool.transaction_id)?;
    sqlx::query("UPDATE tool_calls SET execution_started=TRUE WHERE operation_id=? AND state='registered' AND execution_started=FALSE")
        .bind(&tool.operation_id).execute(tx.connection()).await?;
    Ok(())
}

pub async fn reject_unstarted_task_tools_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
    task: &str,
    version: u64,
) -> Result<()> {
    tx.lock_rank(3)?;
    let rows = sqlx::query("SELECT operation_id,tool_name,tool_contract_version FROM tool_calls WHERE conversation_id=? AND task_id=? AND task_condition_version=? AND state='registered' AND execution_started=FALSE ORDER BY operation_id FOR UPDATE")
        .bind(cid).bind(task).bind(version).fetch_all(tx.connection()).await?;
    for row in rows {
        let operation: String = row.get("operation_id");
        let receipt = json!({
            "operation_id":operation,
            "tool_name":row.get::<String, _>("tool_name"),
            "tool_contract_version":row.get::<u8, _>("tool_contract_version"),
            "data":{
                "error":"task_inactive",
                "outcome":"rejected",
                "hint":"原任务已取消，本操作尚未开始，未读取正文或执行业务；保留原调用身份。"
            }
        });
        sqlx::query("UPDATE tool_calls SET state='rejected',receipt=? WHERE operation_id=? AND state='registered' AND execution_started=FALSE")
            .bind(sqlx::types::Json(&receipt)).bind(&operation).execute(tx.connection()).await?;
    }
    Ok(())
}

pub(super) async fn bind_answer_handoff(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
    operation: &str,
    handoff: &Value,
) -> Result<()> {
    tx.assert_snapshot(&run.transaction_id)?;
    sqlx::query("UPDATE tool_calls SET answer_handoff=? WHERE operation_id=? AND origin_run_id=? AND state='registered' AND answer_handoff IS NULL")
        .bind(sqlx::types::Json(handoff)).bind(operation).bind(&run.id)
        .execute(tx.connection()).await?;
    Ok(())
}

pub async fn read_answer_handoffs_in_tx(tx: &mut AppTx<'_>, run: &LockedRun) -> Result<Vec<Value>> {
    tx.assert_snapshot(&run.transaction_id)?;
    let values: Vec<sqlx::types::Json<Value>> = sqlx::query_scalar(
        "SELECT answer_handoff FROM tool_calls WHERE conversation_id=? AND recovery_chain_id=? AND state='succeeded' AND answer_part_sequence IS NOT NULL ORDER BY answer_part_sequence",
    ).bind(&run.conversation_id).bind(&run.recovery_chain_id).fetch_all(tx.connection()).await?;
    Ok(values.into_iter().map(|v| v.0).collect())
}

pub async fn delivered_result_sources_in_tx(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
) -> Result<Vec<Value>> {
    tx.assert_snapshot(&run.transaction_id)?;
    Ok(sqlx::query("SELECT JSON_OBJECT('query_id',JSON_VALUE(receipt,'$.data.results.query_id'),'result_ref',JSON_VALUE(receipt,'$.data.results.result_ref'),'evidence_ids',JSON_EXTRACT(receipt,'$.data.evidence_ids'),'historical_results',JSON_EXTRACT(receipt,'$.data.historical_analysis.actual_sources.result_dependencies')) FROM tool_calls WHERE conversation_id=? AND recovery_chain_id=? AND tool_name IN ('get_query','read_analysis_report') AND state='succeeded'")
        .bind(&run.conversation_id).bind(&run.recovery_chain_id).map(|row: sqlx::mysql::MySqlRow| row.get::<sqlx::types::Json<Value>,_>(0).0).fetch_all(tx.connection()).await?)
}

pub async fn finalize_answer_handoff_in_tx(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
    tool: &LockedTool,
    handoff: &Value,
) -> Result<()> {
    tx.assert_snapshot(&run.transaction_id)?;
    tx.assert_snapshot(&tool.transaction_id)?;
    let pending: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tool_calls WHERE conversation_id=? AND recovery_chain_id=? AND state='registered' AND operation_id<>?")
        .bind(&run.conversation_id).bind(&run.recovery_chain_id).bind(&tool.operation_id)
        .fetch_one(tx.connection()).await?;
    if pending != 0 {
        return Err(Error::new("outcome_unknown"));
    }
    let next: u64 = sqlx::query_scalar("SELECT CAST(COALESCE(MAX(answer_part_sequence),0)+1 AS UNSIGNED) FROM tool_calls WHERE conversation_id=? AND recovery_chain_id=?")
        .bind(&run.conversation_id).bind(&run.recovery_chain_id).fetch_one(tx.connection()).await?;
    let saved = sqlx::query("UPDATE tool_calls SET answer_handoff=?,answer_part_sequence=? WHERE operation_id=? AND state='registered' AND answer_part_sequence IS NULL")
        .bind(sqlx::types::Json(handoff)).bind(next).bind(&tool.operation_id).execute(tx.connection()).await?;
    if saved.rows_affected() != 1 {
        return Err(Error::new("version_conflict"));
    }
    Ok(())
}

pub(super) async fn attempt_chunks(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
    attempt: &str,
) -> Result<Vec<(u64, String)>> {
    tx.assert_snapshot(&run.transaction_id)?;
    let owned: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM assistant_outputs o JOIN agent_runs r ON r.id=o.run_id WHERE o.attempt_id=? AND o.output_id=? AND r.conversation_id=? AND r.recovery_chain_id=?")
        .bind(attempt).bind(&run.output_id).bind(&run.conversation_id).bind(&run.recovery_chain_id)
        .fetch_one(tx.connection()).await?;
    if owned != 1 {
        return Err(Error::new("invalid_evidence"));
    }
    let rows = sqlx::query(
        "SELECT chunk_seq,body FROM output_chunks WHERE attempt_id=? ORDER BY chunk_seq",
    )
    .bind(attempt)
    .fetch_all(tx.connection())
    .await?;
    Ok(rows
        .iter()
        .map(|r| (r.get("chunk_seq"), r.get("body")))
        .collect())
}

pub(super) async fn record_receipt(
    tx: &mut AppTx<'_>,
    tool: &LockedTool,
    receipt: &Value,
) -> Result<()> {
    tx.assert_snapshot(&tool.transaction_id)?;
    sqlx::query("UPDATE tool_calls SET state='succeeded',receipt=?,completed_at=UTC_TIMESTAMP(3) WHERE operation_id=? AND state='registered'").bind(sqlx::types::Json(receipt)).bind(&tool.operation_id).execute(tx.connection()).await?;
    Ok(())
}
pub(super) async fn last_chunk_sequence(tx: &mut AppTx<'_>, run: &LockedRun) -> Result<u64> {
    tx.assert_snapshot(&run.transaction_id)?;
    Ok(sqlx::query_scalar::<_, u64>(
        "SELECT chunk_seq FROM output_chunks WHERE attempt_id=? ORDER BY chunk_seq DESC LIMIT 1",
    )
    .bind(&run.attempt_id)
    .fetch_optional(tx.connection())
    .await?
    .unwrap_or(0))
}
pub(super) async fn chunk_text(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
    seq: u64,
) -> Result<Option<String>> {
    tx.assert_snapshot(&run.transaction_id)?;
    Ok(
        sqlx::query_scalar("SELECT body FROM output_chunks WHERE attempt_id=? AND chunk_seq=?")
            .bind(&run.attempt_id)
            .bind(seq)
            .fetch_optional(tx.connection())
            .await?,
    )
}
pub(super) async fn chunks(tx: &mut AppTx<'_>, run: &LockedRun) -> Result<Vec<(u64, String)>> {
    tx.assert_snapshot(&run.transaction_id)?;
    let rows = sqlx::query(
        "SELECT chunk_seq,body FROM output_chunks WHERE attempt_id=? ORDER BY chunk_seq",
    )
    .bind(&run.attempt_id)
    .fetch_all(tx.connection())
    .await?;
    Ok(rows
        .iter()
        .map(|r| (r.get("chunk_seq"), r.get("body")))
        .collect())
}
pub(super) async fn insert_chunk(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
    seq: u64,
    body: &str,
) -> Result<()> {
    tx.assert_snapshot(&run.transaction_id)?;
    sqlx::query("INSERT INTO output_chunks(attempt_id,chunk_seq,body) VALUES(?,?,?)")
        .bind(&run.attempt_id)
        .bind(seq)
        .bind(body)
        .execute(tx.connection())
        .await?;
    Ok(())
}
pub async fn save_output_answer_parts_in_tx(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
    parts: &Value,
) -> Result<()> {
    tx.assert_snapshot(&run.transaction_id)?;
    sqlx::query(
        "UPDATE assistant_outputs SET answer_parts=? WHERE attempt_id=? AND state='streaming'",
    )
    .bind(sqlx::types::Json(parts))
    .bind(&run.attempt_id)
    .execute(tx.connection())
    .await?;
    Ok(())
}

pub(super) async fn commit_run(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
    commit_id: &str,
    fp: &str,
    output: &super::outputs::FinalOutput,
) -> Result<()> {
    tx.assert_snapshot(&run.transaction_id)?;
    let unresolved: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM tool_calls WHERE recovery_chain_id=? AND state NOT IN ('succeeded','rejected')",
    )
    .bind(&run.recovery_chain_id)
    .fetch_one(tx.connection())
    .await?;
    if unresolved != 0 {
        return Err(Error::new("version_conflict"));
    }
    sqlx::query("UPDATE assistant_outputs SET state='committed',final_text=?,read_binding=? WHERE attempt_id=?")
        .bind(&output.text)
        .bind(sqlx::types::Json(&output.read_binding))
        .bind(&run.attempt_id)
        .execute(tx.connection())
        .await?;
    sqlx::query(
        "UPDATE agent_runs SET state='finished',commit_id=?,commit_fingerprint=? WHERE id=?",
    )
    .bind(commit_id)
    .bind(fp)
    .bind(&run.id)
    .execute(tx.connection())
    .await?;
    Ok(())
}
pub async fn read_runs_in_tx(tx: &mut AppTx<'_>, cid: &str) -> Result<Vec<Value>> {
    let rows=sqlx::query("SELECT id,state,lease_epoch,message_id,attempt_id FROM agent_runs WHERE conversation_id=? ORDER BY created_at,id").bind(cid).fetch_all(tx.connection()).await?;
    Ok(rows.iter().map(|r|json!({"run_id":r.get::<String,_>("id"),"state":r.get::<String,_>("state"),"lease_epoch":r.get::<u64,_>("lease_epoch").to_string(),"message_id":r.get::<String,_>("message_id"),"attempt_id":r.get::<String,_>("attempt_id")})).collect())
}

pub struct ToolActivity {
    pub tool: String,
    pub completed: u64,
    pub steps: Vec<CompletedStep>,
}

pub struct CompletedStep {
    pub tool: String,
    pub target_id: Option<String>,
    pub duration_ms: Option<i64>,
}

/// 仅投影服务端认可的工具类别与对象 ID。正文、参数与原始工具回执不进入界面。
pub async fn tool_activity_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
    run_id: Option<&str>,
) -> Result<std::collections::HashMap<String, ToolActivity>> {
    let rows = sqlx::query(
        "SELECT r.id AS run_id,t.tool_name,t.state, \
         CASE WHEN t.completed_at>=t.created_at \
           THEN TIMESTAMPDIFF(MICROSECOND,t.created_at,t.completed_at) DIV 1000 \
         END AS duration_ms, \
         CASE \
           WHEN t.tool_name='read_knowledge' AND JSON_LENGTH(t.receipt,'$.data.items')=1 \
                AND JSON_VALUE(t.receipt,'$.data.items[0].state')='ok' \
             THEN JSON_VALUE(t.receipt,'$.data.items[0].ref.object_id') \
           WHEN t.tool_name='read_source' AND JSON_VALUE(t.receipt,'$.data.source.kind')='document' \
             THEN JSON_VALUE(t.receipt,'$.data.source.id') \
         END AS target_id \
         FROM agent_runs r JOIN tool_calls t ON t.conversation_id=r.conversation_id \
           AND t.recovery_chain_id=r.recovery_chain_id \
         LEFT JOIN pi_checkpoints p ON p.recovery_chain_id=r.recovery_chain_id \
         WHERE r.conversation_id=? AND ((r.id=? AND r.state='finished') OR (? IS NULL AND r.state='running')) \
           AND COALESCE(JSON_CONTAINS(p.checkpoint,JSON_QUOTE(t.sdk_tool_call_id),'$.branch_tool_call_ids'), \
                        r.state='running' OR r.id=t.origin_run_id) \
         ORDER BY t.created_at,t.operation_id",
    )
    .bind(cid)
    .bind(run_id)
    .bind(run_id)
    .fetch_all(tx.connection())
    .await?;
    let mut activity = std::collections::HashMap::<String, ToolActivity>::new();
    for row in rows {
        let entry = activity
            .entry(row.get("run_id"))
            .or_insert_with(|| ToolActivity {
                tool: String::new(),
                completed: 0,
                steps: Vec::new(),
            });
        entry.tool = row.get("tool_name");
        if row.get::<String, _>("state") == "succeeded" {
            entry.completed += 1;
            entry.steps.push(CompletedStep {
                tool: entry.tool.clone(),
                target_id: row.get("target_id"),
                duration_ms: row.get("duration_ms"),
            });
        }
    }
    Ok(activity)
}

pub async fn fail_message_runs_in_tx(tx: &mut AppTx<'_>, message_id: &str) -> Result<()> {
    tx.lock_rank(2)?;
    sqlx::query("UPDATE agent_runs SET state='failed' WHERE message_id=? AND state IN ('running','interrupted')")
        .bind(message_id).execute(tx.connection()).await?;
    Ok(())
}

pub async fn locate_run_message(pool: &MySqlPool, run_id: &str) -> Result<String> {
    sqlx::query_scalar("SELECT message_id FROM agent_runs WHERE id=?")
        .bind(run_id)
        .fetch_optional(pool)
        .await?
        .ok_or(Error::new("not_available"))
}

pub(super) async fn interrupt_run(tx: &mut AppTx<'_>, run: &LockedRun) -> Result<()> {
    tx.assert_snapshot(&run.transaction_id)?;
    if run.state != "running" {
        return Err(Error::new("lease_lost"));
    }
    sqlx::query("UPDATE agent_runs SET state='interrupted' WHERE id=?")
        .bind(&run.id)
        .execute(tx.connection())
        .await?;
    Ok(())
}

pub(super) async fn cancel_run(tx: &mut AppTx<'_>, run: &LockedRun) -> Result<()> {
    tx.assert_snapshot(&run.transaction_id)?;
    if run.state != "running" {
        return Err(Error::new("version_conflict"));
    }
    sqlx::query("UPDATE agent_runs SET state='cancelled' WHERE id=?")
        .bind(&run.id)
        .execute(tx.connection())
        .await?;
    sqlx::query(
        "UPDATE assistant_outputs SET state='cancelled' WHERE attempt_id=? AND state='streaming'",
    )
    .bind(&run.attempt_id)
    .execute(tx.connection())
    .await?;
    Ok(())
}

pub async fn reject_tool_in_tx(
    tx: &mut AppTx<'_>,
    tool: &LockedTool,
    receipt: &Value,
) -> Result<()> {
    tx.assert_snapshot(&tool.transaction_id)?;
    sqlx::query("UPDATE tool_calls SET state='rejected',receipt=? WHERE operation_id=? AND state='registered'")
        .bind(sqlx::types::Json(receipt)).bind(&tool.operation_id).execute(tx.connection()).await?;
    Ok(())
}

pub async fn save_authority_in_tx(tx: &mut AppTx<'_>, run: &str, snapshot: &Value) -> Result<()> {
    sqlx::query("UPDATE agent_runs SET authority_snapshot=? WHERE id=?")
        .bind(sqlx::types::Json(snapshot))
        .bind(run)
        .execute(tx.connection())
        .await?;
    sqlx::query("UPDATE pi_checkpoints p JOIN agent_runs r ON p.recovery_chain_id=r.recovery_chain_id SET p.checkpoint=JSON_SET(p.checkpoint,'$.authority_snapshot',CAST(? AS JSON),'$.authority_revision',?),p.version=p.version+1 WHERE r.id=?")
        .bind(sqlx::types::Json(snapshot)).bind(crate::types::fingerprint(snapshot)).bind(run).execute(tx.connection()).await?;
    Ok(())
}
pub async fn read_authority_in_tx(tx: &mut AppTx<'_>, run: &str) -> Result<Option<Value>> {
    let value: Option<sqlx::types::Json<Value>> =
        sqlx::query_scalar("SELECT authority_snapshot FROM agent_runs WHERE id=?")
            .bind(run)
            .fetch_one(tx.connection())
            .await?;
    Ok(value.map(|v| v.0))
}

pub struct TaskConditionUpdate {
    pub operation_id: String,
    pub origin_run_id: String,
    pub message_id: String,
    pub conditions: Value,
}

/// 仅接回指定任务/条件版本的成功修订出处；route和通用工具历史不作为回答证明。
pub async fn task_condition_update_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
    task: &str,
    version: u64,
) -> Result<Option<TaskConditionUpdate>> {
    let row = sqlx::query(
        "SELECT t.operation_id,t.origin_run_id,r.message_id,JSON_EXTRACT(t.receipt,'$.data.conditions') AS conditions \
         FROM tool_calls t JOIN agent_runs r ON r.id=t.origin_run_id AND r.conversation_id=t.conversation_id \
         AND r.recovery_chain_id=t.recovery_chain_id WHERE t.conversation_id=? AND t.tool_name='update_analysis_task' \
         AND t.state='succeeded' AND JSON_UNQUOTE(JSON_EXTRACT(t.receipt,'$.data.task_id'))=? \
         AND JSON_UNQUOTE(JSON_EXTRACT(t.receipt,'$.data.condition_version'))=? \
         AND JSON_CONTAINS_PATH(t.receipt,'one','$.data.conditions') \
         AND JSON_EXTRACT(t.receipt,'$.data.routed') IS NULL",
    ).bind(cid).bind(task).bind(version.to_string()).fetch_optional(tx.connection()).await?;
    Ok(row.map(|row| TaskConditionUpdate {
        operation_id: row.get("operation_id"),
        origin_run_id: row.get("origin_run_id"),
        message_id: row.get("message_id"),
        conditions: row.get::<sqlx::types::Json<Value>, _>("conditions").0,
    }))
}

pub async fn output_states_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
    attempts: &[String],
) -> Result<std::collections::HashMap<String, String>> {
    if attempts.is_empty() {
        return Ok(Default::default());
    }
    let mut sql = sqlx::QueryBuilder::<sqlx::MySql>::new(
        "SELECT o.attempt_id,o.state FROM assistant_outputs o JOIN agent_runs r ON r.id=o.run_id WHERE r.conversation_id=",
    );
    sql.push_bind(cid).push(" AND o.attempt_id IN (");
    let mut items = sql.separated(",");
    for attempt in attempts {
        items.push_bind(attempt);
    }
    sql.push(")");
    let rows = sql.build().fetch_all(tx.connection()).await?;
    Ok(rows
        .into_iter()
        .map(|row| (row.get("attempt_id"), row.get("state")))
        .collect())
}

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
pub(super) async fn start_run(
    tx: &mut AppTx<'_>,
    input: RunStart<'_>,
) -> Result<(String, String, Option<String>)> {
    tx.lock_rank(2)?;
    let previous=sqlx::query("SELECT output_id,attempt_id,tool_contract_version FROM agent_runs WHERE recovery_chain_id=? ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE").bind(input.recovery_chain_id).fetch_optional(tx.connection()).await?;
    // 恢复沿原账本版本；当前进程的选择只用于尚无运行的新chain。
    let tool_contract_version = previous
        .as_ref()
        .map(|r| r.get::<u8, _>("tool_contract_version"))
        .unwrap_or(input.tool_contract_version);
    if !matches!(tool_contract_version, 1 | 2) {
        return Err(Error::new("invalid_input"));
    }
    let output_id = previous
        .as_ref()
        .map(|r| r.get::<String, _>("output_id"))
        .unwrap_or_else(id);
    let replaces = previous.as_ref().map(|r| r.get::<String, _>("attempt_id"));
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
 .bind(input.run_id).bind(input.conversation_id).bind(input.message_id).bind(input.recovery_chain_id).bind(input.budget_scope_id).bind(tool_contract_version).bind(input.lease_epoch).bind(&output_id).bind(&attempt_id).bind(input.job_id).bind(input.job_lease_epoch).execute(tx.connection()).await?;
    sqlx::query("INSERT INTO assistant_outputs(attempt_id,output_id,run_id,state,replaces_attempt_id) VALUES(?,?,?,'streaming',?)").bind(&attempt_id).bind(&output_id).bind(input.run_id).bind(&replaces).execute(tx.connection()).await?;
    Ok((output_id, attempt_id, replaces))
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
    sqlx::query("INSERT INTO tool_calls(operation_id,conversation_id,recovery_chain_id,sdk_tool_call_id,origin_run_id,tool_contract_version,tool_name,arguments_fingerprint,state) VALUES(?,?,?,?,?,?,?,?,'registered')")
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
    answer_handoffs_in_chain(tx, &run.conversation_id, &run.recovery_chain_id).await
}

pub async fn read_frozen_answer_authorities_in_tx(
    tx: &mut AppTx<'_>,
    conversation_id: &str,
    recovery_chain_id: &str,
) -> Result<Vec<Value>> {
    Ok(
        answer_handoffs_in_chain(tx, conversation_id, recovery_chain_id)
            .await?
            .into_iter()
            .map(|handoff| handoff["authority"].clone())
            .collect(),
    )
}

async fn answer_handoffs_in_chain(
    tx: &mut AppTx<'_>,
    conversation_id: &str,
    recovery_chain_id: &str,
) -> Result<Vec<Value>> {
    let values: Vec<sqlx::types::Json<Value>> = sqlx::query_scalar(
        "SELECT answer_handoff FROM tool_calls WHERE conversation_id=? AND recovery_chain_id=? AND state='succeeded' AND answer_part_sequence IS NOT NULL ORDER BY answer_part_sequence",
    ).bind(conversation_id).bind(recovery_chain_id).fetch_all(tx.connection()).await?;
    Ok(values.into_iter().map(|v| v.0).collect())
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
    sqlx::query("UPDATE tool_calls SET state='succeeded',receipt=? WHERE operation_id=? AND state='registered'").bind(sqlx::types::Json(receipt)).bind(&tool.operation_id).execute(tx.connection()).await?;
    Ok(())
}
pub(super) async fn read_checkpoint(tx: &mut AppTx<'_>, chain: &str) -> Result<Option<Value>> {
    Ok(sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
        "SELECT checkpoint FROM pi_checkpoints WHERE recovery_chain_id=?",
    )
    .bind(chain)
    .fetch_optional(tx.connection())
    .await?
    .map(|v| v.0))
}
pub(super) async fn bind_legacy_delivery_checkpoint(
    tx: &mut AppTx<'_>,
    run_id: &str,
    checkpoint: &Value,
) -> Result<()> {
    sqlx::query("UPDATE agent_runs SET legacy_delivery_checkpoint=? WHERE id=? AND legacy_delivery_checkpoint IS NULL")
        .bind(sqlx::types::Json(checkpoint)).bind(run_id).execute(tx.connection()).await?;
    Ok(())
}
pub(super) async fn read_legacy_delivery_checkpoint(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
) -> Result<Value> {
    tx.assert_snapshot(&run.transaction_id)?;
    let value: Option<sqlx::types::Json<Value>> =
        sqlx::query_scalar("SELECT legacy_delivery_checkpoint FROM agent_runs WHERE id=?")
            .bind(&run.id)
            .fetch_one(tx.connection())
            .await?;
    value.map(|v| v.0).ok_or(Error::new("not_available"))
}
pub(super) async fn save_checkpoint(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
    value: &Value,
) -> Result<()> {
    tx.assert_snapshot(&run.transaction_id)?;
    let mut value = value.clone();
    if let Some(authority) = read_authority_in_tx(tx, &run.id).await? {
        value["authority_revision"] = json!(crate::types::fingerprint(&authority));
        value["authority_snapshot"] = authority;
    }
    sqlx::query("INSERT INTO pi_checkpoints(recovery_chain_id,checkpoint) VALUES(?,?) ON DUPLICATE KEY UPDATE checkpoint=VALUES(checkpoint),version=version+1").bind(&run.recovery_chain_id).bind(sqlx::types::Json(value)).execute(tx.connection()).await?;
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
pub(super) async fn open_budget(
    tx: &mut AppTx<'_>,
    scope: &str,
    message: &str,
    limit: Option<u32>,
    profile: Option<&crate::contracts::generated::ModelProfile>,
) -> Result<()> {
    tx.lock_rank(6)?;
    sqlx::query(
        "INSERT INTO budget_scopes(id,message_id,call_limit,model_profile) VALUES(?,?,?,?)",
    )
    .bind(scope)
    .bind(message)
    .bind(limit)
    .bind(profile.map(sqlx::types::Json))
    .execute(tx.connection())
    .await?;
    Ok(())
}
pub(super) async fn issue_call(tx: &mut AppTx<'_>, run: &LockedRun, attempt: &str) -> Result<()> {
    tx.assert_snapshot(&run.transaction_id)?;
    tx.lock_rank(3)?;
    if sqlx::query("SELECT id FROM model_call_attempts WHERE id=? FOR UPDATE")
        .bind(attempt)
        .fetch_optional(tx.connection())
        .await?
        .is_some()
    {
        return Err(Error::new("idempotency_conflict"));
    }
    tx.lock_rank(6)?;
    let budget = sqlx::query("SELECT * FROM budget_scopes WHERE id=? FOR UPDATE")
        .bind(&run.budget_scope_id)
        .fetch_one(tx.connection())
        .await?;
    if budget
        .get::<Option<sqlx::types::Json<Value>>, _>("model_profile")
        .is_some()
    {
        return Err(Error::new("not_available"));
    }
    if budget
        .get::<Option<u32>, _>("call_limit")
        .is_some_and(|limit| budget.get::<u32, _>("issued_calls") >= limit)
    {
        return Err(Error::new("budget_exhausted"));
    }
    sqlx::query(
        "INSERT INTO model_call_attempts(id,budget_scope_id,run_id,state) VALUES(?,?,?,'issued')",
    )
    .bind(attempt)
    .bind(&run.budget_scope_id)
    .bind(&run.id)
    .execute(tx.connection())
    .await?;
    sqlx::query("UPDATE budget_scopes SET issued_calls=issued_calls+1 WHERE id=?")
        .bind(&run.budget_scope_id)
        .execute(tx.connection())
        .await?;
    Ok(())
}
pub(super) async fn settle_call(tx: &mut AppTx<'_>, run: &LockedRun, attempt: &str) -> Result<()> {
    tx.assert_snapshot(&run.transaction_id)?;
    tx.lock_rank(3)?;
    let row =
        sqlx::query("SELECT state FROM model_call_attempts WHERE id=? AND run_id=? FOR UPDATE")
            .bind(attempt)
            .bind(&run.id)
            .fetch_optional(tx.connection())
            .await?
            .ok_or(Error::new("not_available"))?;
    let state: String = row.get("state");
    if state != "settled" {
        sqlx::query("UPDATE model_call_attempts SET state='settled' WHERE id=?")
            .bind(attempt)
            .execute(tx.connection())
            .await?;
    }
    Ok(())
}
pub async fn read_runs_in_tx(tx: &mut AppTx<'_>, cid: &str) -> Result<Vec<Value>> {
    let rows=sqlx::query("SELECT id,state,lease_epoch,message_id,attempt_id FROM agent_runs WHERE conversation_id=? ORDER BY created_at,id").bind(cid).fetch_all(tx.connection()).await?;
    Ok(rows.iter().map(|r|json!({"run_id":r.get::<String,_>("id"),"state":r.get::<String,_>("state"),"lease_epoch":r.get::<u64,_>("lease_epoch").to_string(),"message_id":r.get::<String,_>("message_id"),"attempt_id":r.get::<String,_>("attempt_id")})).collect())
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

pub async fn read_budget_profile_in_tx(
    tx: &mut AppTx<'_>,
    scope: &str,
) -> Result<Option<crate::contracts::generated::ModelProfile>> {
    let value = sqlx::query_scalar::<_, Option<sqlx::types::Json<Value>>>(
        "SELECT model_profile FROM budget_scopes WHERE id=?",
    )
    .bind(scope)
    .fetch_one(tx.connection())
    .await?;
    value
        .map(|value| crate::contracts::decode("ModelProfile", value.0))
        .transpose()
}

pub async fn budget_message_in_tx(tx: &mut AppTx<'_>, scope: &str) -> Result<String> {
    sqlx::query_scalar("SELECT message_id FROM budget_scopes WHERE id=?")
        .bind(scope)
        .fetch_optional(tx.connection())
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

// LIMIT 保留派生表边界：只排序恢复链 ID，选定后才读完整 SDK 历史。
const CONVERSATION_CHECKPOINT_SQL: &str = "SELECT p.checkpoint FROM (
    SELECT r.recovery_chain_id
    FROM agent_runs r JOIN pi_checkpoints c ON r.recovery_chain_id=c.recovery_chain_id
    WHERE r.conversation_id=? AND r.state='finished'
    ORDER BY r.lease_epoch DESC LIMIT 1
) latest JOIN pi_checkpoints p ON p.recovery_chain_id=latest.recovery_chain_id";

pub(super) async fn conversation_checkpoint(
    tx: &mut AppTx<'_>,
    cid: &str,
) -> Result<Option<Value>> {
    Ok(
        sqlx::query_scalar::<_, sqlx::types::Json<Value>>(CONVERSATION_CHECKPOINT_SQL)
            .bind(cid)
            .fetch_optional(tx.connection())
            .await?
            .map(|v| v.0),
    )
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

pub(super) struct OutputReadRecord {
    pub attempt_id: String,
    pub output_id: String,
    pub state: String,
    pub final_text: Option<String>,
    pub answer_parts: Option<Value>,
    pub read_binding: Option<Value>,
    pub recovery_chain_id: String,
    pub authority: Value,
}

pub(super) async fn output_read_records_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
    attempts: &[String],
) -> Result<Vec<OutputReadRecord>> {
    if attempts.is_empty() {
        return Ok(Vec::new());
    }
    let mut sql = sqlx::QueryBuilder::<sqlx::MySql>::new(
        "SELECT o.attempt_id,o.output_id,o.state,o.final_text,o.answer_parts,o.read_binding,r.recovery_chain_id,r.authority_snapshot \
         FROM assistant_outputs o JOIN agent_runs r ON r.id=o.run_id WHERE r.conversation_id=",
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
        .map(|row| OutputReadRecord {
            attempt_id: row.get("attempt_id"),
            output_id: row.get("output_id"),
            state: row.get("state"),
            final_text: row.get("final_text"),
            answer_parts: row
                .get::<Option<sqlx::types::Json<Value>>, _>("answer_parts")
                .map(|value| value.0),
            read_binding: row
                .get::<Option<sqlx::types::Json<Value>>, _>("read_binding")
                .map(|value| value.0),
            recovery_chain_id: row.get("recovery_chain_id"),
            authority: row
                .get::<Option<sqlx::types::Json<Value>>, _>("authority_snapshot")
                .map(|value| value.0)
                .unwrap_or(Value::Null),
        })
        .collect())
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

// 仅读取旧NULL格式或活跃输出恢复链的成功答案、定稿和控制投影。
pub(super) async fn output_read_sources_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
    chain: &str,
) -> Result<Vec<Value>> {
    let rows = sqlx::query(
        "SELECT t.sdk_tool_call_id,\
         CASE WHEN t.answer_part_sequence IS NOT NULL THEN t.answer_handoff END AS handoff,\
         CASE WHEN t.tool_name='present_analysis_answer' THEN JSON_EXTRACT(t.receipt,'$.data') END AS answer,\
         CASE WHEN t.tool_name='prepare_analysis_answer' THEN JSON_EXTRACT(t.receipt,'$.data') END AS prepared,\
         JSON_EXTRACT(t.receipt,'$.control_delivery') AS control_delivery \
         FROM tool_calls t JOIN agent_runs r ON r.id=t.origin_run_id \
         AND r.conversation_id=t.conversation_id AND r.recovery_chain_id=t.recovery_chain_id \
         WHERE t.conversation_id=? AND t.recovery_chain_id=? AND t.state='succeeded' \
         AND (t.answer_part_sequence IS NOT NULL OR t.tool_name='present_analysis_answer' \
         OR t.tool_name='prepare_analysis_answer' \
         OR JSON_CONTAINS_PATH(t.receipt,'one','$.control_delivery')) \
         ORDER BY t.answer_part_sequence,t.operation_id",
    )
    .bind(cid)
    .bind(chain)
    .fetch_all(tx.connection())
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            json!({
                "sdk_tool_call_id":row.get::<String, _>("sdk_tool_call_id"),
                "handoff":row.get::<Option<sqlx::types::Json<Value>>, _>("handoff").map(|value| value.0),
                "answer":row.get::<Option<sqlx::types::Json<Value>>, _>("answer").map(|value| value.0),
                "prepared":row.get::<Option<sqlx::types::Json<Value>>, _>("prepared").map(|value| value.0),
                "control_delivery":row.get::<Option<sqlx::types::Json<Value>>, _>("control_delivery").map(|value| value.0)
            })
        })
        .collect())
}

pub(super) async fn output_read_chunks_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
    output: &OutputReadRecord,
    attempt: &str,
) -> Result<Vec<(u64, String)>> {
    let rows = sqlx::query(
        "SELECT c.chunk_seq,c.body FROM output_chunks c \
         JOIN assistant_outputs o ON o.attempt_id=c.attempt_id JOIN agent_runs r ON r.id=o.run_id \
         WHERE r.conversation_id=? AND r.recovery_chain_id=? AND o.output_id=? AND c.attempt_id=? \
         ORDER BY c.chunk_seq",
    )
    .bind(cid)
    .bind(&output.recovery_chain_id)
    .bind(&output.output_id)
    .bind(attempt)
    .fetch_all(tx.connection())
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| (row.get("chunk_seq"), row.get("body")))
        .collect())
}

#[cfg(test)]
mod checkpoint_selection_tests {
    use super::*;

    #[tokio::test]
    async fn checkpoint_selection_preserves_large_history_and_latest_valid_run() {
        let url = std::env::var("DATA_AGENT_DATABASE_URL").expect("isolated MySQL fixture");
        let cid = std::env::var("DATA_AGENT_TEST_CONVERSATION_ID").expect("completed seed run");
        let pool = MySqlPool::connect(&url).await.unwrap();
        let mut tx = AppTx::begin(&pool).await.unwrap();
        sqlx::query("SET SESSION sort_buffer_size=262144")
            .execute(tx.connection())
            .await
            .unwrap();
        let buffer: u64 = sqlx::query_scalar("SELECT @@SESSION.sort_buffer_size")
            .fetch_one(tx.connection())
            .await
            .unwrap();
        assert_eq!(buffer, 262144);
        let seed: String = sqlx::query_scalar(
            "SELECT id FROM agent_runs WHERE conversation_id=? AND state='finished' LIMIT 1",
        )
        .bind(&cid)
        .fetch_one(tx.connection())
        .await
        .unwrap();
        let mut expected = None;
        for (epoch, state, has_checkpoint) in [
            (10, "finished", true),
            (20, "finished", true),
            (30, "finished", false),
            (40, "running", true),
            (50, "failed", true),
        ] {
            let run = id();
            let chain = id();
            sqlx::query("INSERT INTO agent_runs(id,conversation_id,message_id,recovery_chain_id,budget_scope_id,lease_epoch,state,job_id,job_lease_epoch,output_id,attempt_id,created_at) SELECT ?,conversation_id,message_id,?,budget_scope_id,?,?,job_id,job_lease_epoch,output_id,attempt_id,TIMESTAMPADD(SECOND,?,created_at) FROM agent_runs WHERE id=?")
                .bind(&run).bind(&chain).bind(epoch).bind(state).bind(-epoch).bind(&seed)
                .execute(tx.connection()).await.unwrap();
            if has_checkpoint {
                let value = json!({"epoch":epoch,"history":"合成历史".repeat(60000)});
                assert!(serde_json::to_vec(&value).unwrap().len() > 512 * 1024);
                sqlx::query("INSERT INTO pi_checkpoints(recovery_chain_id,checkpoint) VALUES(?,?)")
                    .bind(&chain)
                    .bind(sqlx::types::Json(&value))
                    .execute(tx.connection())
                    .await
                    .unwrap();
                if epoch == 20 {
                    expected = Some(value);
                }
            }
        }
        assert_eq!(
            conversation_checkpoint(&mut tx, &cid).await.unwrap(),
            expected
        );
        assert_eq!(conversation_checkpoint(&mut tx, &id()).await.unwrap(), None);
        // 优化器可能先读取检查点表；强制该合法连接顺序，稳定覆盖宽 JSON 排序的反例。
        let checkpoint_first = CONVERSATION_CHECKPOINT_SQL
            .replacen("SELECT", "SELECT /*+ JOIN_ORDER(p,r) */", 1)
            .replace(
                "SELECT r.recovery_chain_id",
                "SELECT /*+ JOIN_ORDER(c,r) */ r.recovery_chain_id",
            );
        let actual = sqlx::query_scalar::<_, sqlx::types::Json<Value>>(sqlx::AssertSqlSafe(
            checkpoint_first,
        ))
        .bind(&cid)
        .fetch_optional(tx.connection())
        .await
        .unwrap()
        .map(|v| v.0);
        assert_eq!(actual, expected);
        // 不提交夹具行，后续仍验证原始会话的迁移和续聊。
        drop(tx);
        pool.close().await;
    }
}

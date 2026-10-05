use crate::{
    persistence::AppTx,
    types::{Error, Result, id},
};
use serde_json::{Value, json};
use sqlx::{MySqlPool, Row};

pub async fn delivery_task_refs_in_tx(tx: &mut AppTx<'_>, run: &LockedRun) -> Result<Vec<Value>> {
    let receipts: Vec<sqlx::types::Json<Value>> = sqlx::query_scalar("SELECT t.receipt FROM tool_calls t JOIN agent_runs r ON r.id=t.origin_run_id WHERE r.recovery_chain_id=? AND t.state='succeeded' AND t.tool_name='update_analysis_task' AND t.receipt IS NOT NULL")
        .bind(&run.recovery_chain_id).fetch_all(tx.connection()).await?;
    Ok(receipts
        .into_iter()
        .map(|r| r.0["data"].clone())
        .filter(|v| v["task_id"].is_string() && v["condition_version"].is_string())
        .collect())
}

pub struct LockedRun {
    pub id: String,
    pub conversation_id: String,
    pub message_id: String,
    pub recovery_chain_id: String,
    pub budget_scope_id: String,
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
    pub fingerprint: String,
    pub state: String,
    pub receipt: Option<Value>,
    pub(super) transaction_id: String,
}
pub struct RunStart<'a> {
    pub run_id: &'a str,
    pub conversation_id: &'a str,
    pub message_id: &'a str,
    pub recovery_chain_id: &'a str,
    pub budget_scope_id: &'a str,
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
    let previous=sqlx::query("SELECT output_id,attempt_id FROM agent_runs WHERE recovery_chain_id=? ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE").bind(input.recovery_chain_id).fetch_optional(tx.connection()).await?;
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
    sqlx::query("INSERT INTO agent_runs(id,conversation_id,message_id,recovery_chain_id,budget_scope_id,lease_epoch,state,output_id,attempt_id,job_id,job_lease_epoch) VALUES(?,?,?,?,?,?,'running',?,?,?,?)")
 .bind(input.run_id).bind(input.conversation_id).bind(input.message_id).bind(input.recovery_chain_id).bind(input.budget_scope_id).bind(input.lease_epoch).bind(&output_id).bind(&attempt_id).bind(input.job_id).bind(input.job_lease_epoch).execute(tx.connection()).await?;
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
    Ok(row.map(|r| LockedTool {
        operation_id: r.get("operation_id"),
        origin_run_id: r.get("origin_run_id"),
        fingerprint: r.get("arguments_fingerprint"),
        state: r.get("state"),
        receipt: r
            .get::<Option<sqlx::types::Json<Value>>, _>("receipt")
            .map(|v| v.0),
        transaction_id: tx.id().into(),
    }))
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
    sqlx::query("INSERT INTO tool_calls(operation_id,conversation_id,recovery_chain_id,sdk_tool_call_id,origin_run_id,tool_name,arguments_fingerprint,state) VALUES(?,?,?,?,?,?,?,'registered')")
 .bind(&operation_id).bind(&run.conversation_id).bind(&run.recovery_chain_id).bind(sdk_id).bind(&run.id).bind(name).bind(fp).execute(tx.connection()).await?;
    Ok(operation_id)
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
pub(super) async fn commit_run(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
    commit_id: &str,
    fp: &str,
    text: &str,
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
    sqlx::query("UPDATE assistant_outputs SET state='committed',final_text=? WHERE attempt_id=?")
        .bind(text)
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
    limit: u32,
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
    if budget.get::<u32, _>("issued_calls") >= budget.get::<u32, _>("call_limit") {
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
    let rows=sqlx::query("SELECT id,state,lease_epoch FROM agent_runs WHERE conversation_id=? ORDER BY created_at,id").bind(cid).fetch_all(tx.connection()).await?;
    Ok(rows.iter().map(|r|json!({"run_id":r.get::<String,_>("id"),"state":r.get::<String,_>("state"),"lease_epoch":r.get::<u64,_>("lease_epoch").to_string()})).collect())
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

// 展示页只核对本页出现的尝试，避免把其他页已经提交或替代的片段当作活动输出。
pub async fn output_states_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
    attempts: &[String],
) -> Result<std::collections::HashMap<String, String>> {
    if attempts.is_empty() {
        return Ok(std::collections::HashMap::new());
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
        .iter()
        .map(|r| {
            (
                r.get::<String, _>("attempt_id"),
                r.get::<String, _>("state"),
            )
        })
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

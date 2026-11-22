use super::*;

// delivery_input 给出本轮的会话及恢复链；检查点只读取已选链的正文。
pub(crate) const DELIVERY_HISTORY_SQL: &str = "history_chain AS (
    SELECT COALESCE(
        (SELECT recovery_chain_id FROM pi_checkpoints WHERE recovery_chain_id=i.recovery_chain_id),
        (SELECT r.recovery_chain_id FROM agent_runs r JOIN pi_checkpoints c
           ON c.recovery_chain_id=r.recovery_chain_id
           WHERE r.conversation_id=i.conversation_id AND r.state='finished'
           ORDER BY r.lease_epoch DESC LIMIT 1)) AS recovery_chain_id,
        i.recovery_chain_id AS input_chain,i.conversation_id
    FROM delivery_input i
), delivery_history AS (
    SELECT p.checkpoint,h.recovery_chain_id AS checkpoint_chain,h.input_chain,
       (SELECT JSON_ARRAYAGG(JSON_OBJECT('sequence',answer_part_sequence,'handoff',answer_handoff))
        FROM tool_calls WHERE conversation_id=h.conversation_id AND recovery_chain_id=h.input_chain
          AND state='succeeded' AND answer_part_sequence IS NOT NULL) AS handoffs,
       (SELECT JSON_ARRAYAGG(JSON_EXTRACT(receipt,'$.context_reset'))
        FROM tool_calls WHERE conversation_id=h.conversation_id AND recovery_chain_id=h.input_chain
          AND state='succeeded' AND JSON_TYPE(JSON_EXTRACT(receipt,'$.context_reset'))='OBJECT') AS task_resets
    FROM history_chain h LEFT JOIN pi_checkpoints p ON p.recovery_chain_id=h.recovery_chain_id
)";

pub(crate) fn decode_delivery_history(
    row: &sqlx::mysql::MySqlRow,
) -> Result<super::super::DeliveryHistory> {
    #[derive(serde::Deserialize)]
    struct Handoff {
        sequence: u64,
        handoff: Value,
    }
    let mut handoffs = row
        .try_get::<Option<sqlx::types::Json<Vec<Handoff>>>, _>("handoffs")?
        .map_or_else(Vec::new, |value| value.0);
    handoffs.sort_by_key(|part| part.sequence);
    Ok(super::super::DeliveryHistory {
        checkpoint: row
            .get::<Option<sqlx::types::Json<Value>>, _>("checkpoint")
            .map(|v| v.0),
        same_input: row.get::<Option<String>, _>("checkpoint_chain").as_ref()
            == Some(&row.get::<String, _>("input_chain")),
        task_resets: row
            .get::<Option<sqlx::types::Json<Vec<Value>>>, _>("task_resets")
            .map_or_else(Vec::new, |v| v.0),
        answer_handoffs: handoffs.into_iter().map(|part| part.handoff).collect(),
    })
}
pub(in crate::modules::runtime) async fn bind_legacy_delivery_checkpoint(
    tx: &mut AppTx<'_>,
    run_id: &str,
    checkpoint: &Value,
) -> Result<()> {
    sqlx::query("UPDATE agent_runs SET legacy_delivery_checkpoint=? WHERE id=? AND legacy_delivery_checkpoint IS NULL")
        .bind(sqlx::types::Json(checkpoint)).bind(run_id).execute(tx.connection()).await?;
    Ok(())
}
pub(crate) fn push_legacy_checkpoint_run(sql: &mut sqlx::QueryBuilder<sqlx::MySql>, run: &str) {
    sql.push("WITH checkpoint_run AS (SELECT id,conversation_id,message_id,state,legacy_delivery_checkpoint
        FROM agent_runs WHERE id=")
        .push_bind(run)
        .push(") ");
}
pub(in crate::modules::runtime) async fn save_checkpoint(
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

#[cfg(test)]
mod tests {
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
        let mut own_chain = None;
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
                } else if epoch == 40 {
                    own_chain = Some((chain, value));
                }
            }
        }
        let history = test_delivery_history(&mut tx, &cid, "new-input", false).await;
        assert_eq!(history.checkpoint, expected);
        assert!(!history.same_input);
        let (chain, own) = own_chain.unwrap();
        let history = test_delivery_history(&mut tx, &cid, &chain, false).await;
        assert_eq!(history.checkpoint, Some(own));
        assert!(history.same_input);
        assert!(
            test_delivery_history(&mut tx, &id(), "new-input", false)
                .await
                .checkpoint
                .is_none()
        );
        // 优化器可能先读取检查点表；强制该合法连接顺序，稳定覆盖宽 JSON 排序的反例。
        let actual = test_delivery_history(&mut tx, &cid, "new-input", true).await;
        assert_eq!(actual.checkpoint, expected);
        // 不提交夹具行，后续仍验证原始会话的迁移和续聊。
        drop(tx);
        pool.close().await;
    }

    async fn test_delivery_history(
        tx: &mut AppTx<'_>,
        cid: &str,
        chain: &str,
        checkpoint_first: bool,
    ) -> super::super::super::DeliveryHistory {
        let history = if checkpoint_first {
            DELIVERY_HISTORY_SQL.replace(
                "SELECT r.recovery_chain_id",
                "SELECT /*+ JOIN_ORDER(c,r) */ r.recovery_chain_id",
            )
        } else {
            DELIVERY_HISTORY_SQL.to_owned()
        };
        let mut sql = sqlx::QueryBuilder::<sqlx::MySql>::new("WITH delivery_input AS (SELECT ");
        sql.push_bind(cid)
            .push(" AS conversation_id,")
            .push_bind(chain)
            .push(" AS recovery_chain_id),")
            .push(history)
            .push(" SELECT * FROM delivery_history");
        let row = sql.build().fetch_one(tx.connection()).await.unwrap();
        decode_delivery_history(&row).unwrap()
    }
}

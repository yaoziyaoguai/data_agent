use super::*;

pub(in crate::modules::runtime) async fn open_budget(
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
pub(in crate::modules::runtime) async fn issue_call(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
    attempt: &str,
) -> Result<()> {
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
pub(in crate::modules::runtime) async fn settle_call(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
    attempt: &str,
) -> Result<()> {
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
pub(crate) const DELIVERY_BUDGET_SQL: &str = "(SELECT JSON_OBJECT('model_profile',model_profile) FROM budget_scopes WHERE id=m.budget_scope_id) AS budget";

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

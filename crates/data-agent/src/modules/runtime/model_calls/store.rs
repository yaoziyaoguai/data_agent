use super::super::store::{LockedRun, read_budget_profile_in_tx};
use crate::{
    persistence::AppTx,
    types::{Error, Result},
};
use serde_json::{Value, json};
use sqlx::{MySqlPool, Row};

// 使用官方高峰、缓存未命中价作保守预留；金额以整数微美元保存。
fn model_cost(
    profile: &crate::contracts::generated::ModelProfile,
    input: u64,
    output: u64,
) -> Result<u64> {
    let (input_rate, output_rate) =
        match (profile.model_id.as_str(), profile.price_version.as_str()) {
            ("deepseek-flash", "2026-10-04-peak-usd") => (30, 120),
            ("deepseek-v4-pro", "2026-10-05-pro-peak-usd") => (132, 396),
            _ => return Err(Error::new("invalid_input")),
        };
    Ok((input * input_rate + output * output_rate).div_ceil(100))
}

pub(super) async fn reserve_maintenance_in_tx(
    tx: &mut AppTx<'_>,
    attempt: &str,
    profile: &crate::contracts::generated::ModelProfile,
) -> Result<()> {
    let trial = sqlx::query(
        "SELECT *,expires_at>UTC_TIMESTAMP(3) AS valid FROM model_trials WHERE id=? FOR UPDATE",
    )
    .bind(&profile.trial_id)
    .fetch_one(tx.connection())
    .await?;
    let reservation = model_cost(
        profile,
        profile.input_limit as u64,
        profile.output_limit as u64,
    )?;
    if trial.get::<i64, _>("valid") == 0
        || trial.get::<String, _>("state") != "active"
        || trial.get::<u32, _>("allocated_calls") >= trial.get::<u32, _>("call_limit")
        || trial.get::<u64, _>("spent_micros")
            + trial.get::<u64, _>("reserved_micros")
            + reservation
            > trial.get::<u64, _>("cost_limit_micros")
    {
        return Err(Error::new("budget_exhausted"));
    }
    sqlx::query("INSERT INTO maintenance_model_calls(id,trial_id,state,reserved_micros) VALUES(?,?,'issued',?)").bind(attempt).bind(&profile.trial_id).bind(reservation).execute(tx.connection()).await?;
    sqlx::query("UPDATE model_trials SET allocated_calls=allocated_calls+1,reserved_micros=reserved_micros+? WHERE id=?").bind(reservation).bind(&profile.trial_id).execute(tx.connection()).await?;
    Ok(())
}
pub(super) async fn settle_maintenance_in_tx(
    tx: &mut AppTx<'_>,
    attempt: &str,
    profile: &crate::contracts::generated::ModelProfile,
    usage: &Value,
) -> Result<()> {
    let call = sqlx::query("SELECT * FROM maintenance_model_calls WHERE id=? FOR UPDATE")
        .bind(attempt)
        .fetch_one(tx.connection())
        .await?;
    if call.get::<String, _>("state") != "issued" {
        return Err(Error::new("version_conflict"));
    }
    let Some(input) = usage["prompt_tokens"].as_u64() else {
        return Err(Error::new("model_usage_unknown"));
    };
    let Some(output) = usage["completion_tokens"].as_u64() else {
        return Err(Error::new("model_usage_unknown"));
    };
    if input > 100000000 || output > 100000000 {
        return Err(Error::new("model_usage_unknown"));
    };
    let cost = model_cost(profile, input, output)?;
    let breached = input > profile.input_limit as u64 || output > profile.output_limit as u64;
    sqlx::query("UPDATE model_trials SET spent_micros=spent_micros+?,reserved_micros=reserved_micros-?,state=IF(?,'breached',state) WHERE id=?").bind(cost).bind(call.get::<u64,_>("reserved_micros")).bind(breached).bind(&profile.trial_id).execute(tx.connection()).await?;
    sqlx::query("UPDATE maintenance_model_calls SET state='settled',usage_json=? WHERE id=?")
        .bind(sqlx::types::Json(usage))
        .bind(attempt)
        .execute(tx.connection())
        .await?;
    if breached {
        return Err(Error::new("budget_exhausted"));
    }
    Ok(())
}

pub(super) async fn configure_trial(
    pool: &MySqlPool,
    profile: &crate::contracts::generated::ModelProfile,
) -> Result<()> {
    let fp = crate::types::fingerprint(
        &serde_json::to_value(profile).map_err(|_| Error::new("invalid_input"))?,
    );
    let mut tx = AppTx::begin(pool).await?;
    sqlx::query("INSERT INTO model_trials(id,configuration_fingerprint,call_limit,cost_limit_micros,expires_at) VALUES(?,?,?,?,TIMESTAMPADD(SECOND,3600,UTC_TIMESTAMP(3))) ON DUPLICATE KEY UPDATE id=id")
        .bind(&profile.trial_id).bind(&fp).bind(profile.trial_call_limit).bind(crate::types::epoch(&profile.trial_cost_micros)?).execute(tx.connection()).await?;
    let current: String = sqlx::query_scalar(
        "SELECT configuration_fingerprint FROM model_trials WHERE id=? FOR UPDATE",
    )
    .bind(&profile.trial_id)
    .fetch_one(tx.connection())
    .await?;
    if current != fp {
        return Err(Error::new("idempotency_conflict"));
    }
    tx.commit().await
}
pub(super) async fn reserve_model_call(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
    input: &crate::contracts::generated::ReserveModelCall,
) -> Result<Value> {
    tx.assert_snapshot(&run.transaction_id)?;
    tx.lock_rank(3)?;
    // 先登记调用身份，取得原预算配置后在同一事务内填写预留金额。
    let reservation = 0_u64;
    // 先插入调用身份，避免对不存在的UUID加间隙锁后再等trial锁；预算失败会回滚整笔事务。
    let inserted = sqlx::query("INSERT INTO model_call_attempts(id,budget_scope_id,run_id,state,parameters_fingerprint,input_tokens_upper,output_tokens_max,reserved_micros,permit_expires_at) VALUES(?,?,?,'reserved',?,?,?,?,TIMESTAMPADD(SECOND,30,UTC_TIMESTAMP(3)))")
        .bind(&input.call_attempt_id).bind(&run.budget_scope_id).bind(&run.id).bind(&input.parameters_fingerprint).bind(input.input_tokens_upper).bind(input.output_tokens_max).bind(reservation).execute(tx.connection()).await;
    if let Err(error) = inserted {
        if !error.as_database_error().is_some_and(|e| {
            e.try_downcast_ref::<sqlx::mysql::MySqlDatabaseError>()
                .is_some_and(|e| e.number() == 1062)
        }) {
            return Err(error.into());
        }
        let row = sqlx::query("SELECT * FROM model_call_attempts WHERE id=? FOR UPDATE")
            .bind(&input.call_attempt_id)
            .fetch_one(tx.connection())
            .await?;
        if row.get::<String, _>("run_id") != run.id
            || row
                .get::<Option<String>, _>("parameters_fingerprint")
                .as_deref()
                != Some(&input.parameters_fingerprint)
            || row.get::<Option<u32>, _>("input_tokens_upper")
                != Some(input.input_tokens_upper as u32)
            || row.get::<Option<u32>, _>("output_tokens_max")
                != Some(input.output_tokens_max as u32)
        {
            return Err(Error::new("idempotency_conflict"));
        }
        return Ok(json!({"state":row.get::<String,_>("state"),"send_allowed":false}));
    }
    tx.lock_rank(6)?;
    let scope = sqlx::query("SELECT * FROM budget_scopes WHERE id=? FOR UPDATE")
        .bind(&run.budget_scope_id)
        .fetch_one(tx.connection())
        .await?;
    let value = scope
        .get::<Option<sqlx::types::Json<Value>>, _>("model_profile")
        .ok_or(Error::new("not_available"))?;
    let profile: crate::contracts::generated::ModelProfile =
        crate::contracts::decode("ModelProfile", value.0)?;
    if input.input_tokens_upper != profile.input_limit
        || input.output_tokens_max != profile.output_limit
    {
        return Err(Error::new("invalid_input"));
    }
    let reservation = model_cost(
        &profile,
        input.input_tokens_upper as u64,
        input.output_tokens_max as u64,
    )?;
    sqlx::query("UPDATE model_call_attempts SET reserved_micros=? WHERE id=?")
        .bind(reservation)
        .bind(&input.call_attempt_id)
        .execute(tx.connection())
        .await?;
    if scope.get::<u32, _>("issued_calls") >= scope.get::<u32, _>("call_limit") {
        return Err(Error::new("budget_exhausted"));
    }
    tx.lock_rank(7)?;
    let trial = sqlx::query(
        "SELECT *,expires_at>UTC_TIMESTAMP(3) AS valid FROM model_trials WHERE id=? FOR UPDATE",
    )
    .bind(&profile.trial_id)
    .fetch_one(tx.connection())
    .await?;
    if trial.get::<i64, _>("valid") == 0
        || trial.get::<String, _>("state") != "active"
        || trial.get::<u32, _>("allocated_calls") >= trial.get::<u32, _>("call_limit")
        || trial.get::<u64, _>("spent_micros")
            + trial.get::<u64, _>("reserved_micros")
            + reservation
            > trial.get::<u64, _>("cost_limit_micros")
    {
        return Err(Error::new("budget_exhausted"));
    }
    sqlx::query("UPDATE budget_scopes SET issued_calls=issued_calls+1 WHERE id=?")
        .bind(&run.budget_scope_id)
        .execute(tx.connection())
        .await?;
    sqlx::query("UPDATE model_trials SET allocated_calls=allocated_calls+1,reserved_micros=reserved_micros+? WHERE id=?").bind(reservation).bind(&profile.trial_id).execute(tx.connection()).await?;
    Ok(json!({"state":"reserved","send_allowed":false}))
}
pub(super) async fn send_model_call(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
    input: &crate::contracts::generated::SendModelCall,
) -> Result<Value> {
    tx.assert_snapshot(&run.transaction_id)?;
    tx.lock_rank(3)?;
    let row=sqlx::query("SELECT *,permit_expires_at>UTC_TIMESTAMP(3) AS valid FROM model_call_attempts WHERE id=? AND run_id=? FOR UPDATE")
        .bind(&input.call_attempt_id).bind(&run.id).fetch_optional(tx.connection()).await?.ok_or(Error::new("not_available"))?;
    if row
        .get::<Option<String>, _>("parameters_fingerprint")
        .as_deref()
        != Some(&input.parameters_fingerprint)
    {
        return Err(Error::new("idempotency_conflict"));
    }
    let state: String = row.get("state");
    if state != "reserved" {
        return Ok(json!({"state":state,"send_allowed":false}));
    }
    if row.get::<i64, _>("valid") == 0 {
        return Err(Error::new("budget_exhausted"));
    }
    tx.lock_rank(6)?;
    let profile = read_budget_profile_in_tx(tx, &run.budget_scope_id)
        .await?
        .ok_or(Error::new("not_available"))?;
    tx.lock_rank(7)?;
    let trial = sqlx::query(
        "SELECT state,expires_at>UTC_TIMESTAMP(3) AS valid FROM model_trials WHERE id=? FOR UPDATE",
    )
    .bind(&profile.trial_id)
    .fetch_one(tx.connection())
    .await?;
    if trial.get::<String, _>("state") != "active" || trial.get::<i64, _>("valid") == 0 {
        return Err(Error::new("budget_exhausted"));
    }
    sqlx::query("UPDATE model_call_attempts SET state='issued' WHERE id=? AND state='reserved'")
        .bind(&input.call_attempt_id)
        .execute(tx.connection())
        .await?;
    Ok(json!({"state":"issued","send_allowed":true}))
}
pub(super) async fn finalize_model_call(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
    input: &crate::contracts::generated::FinalizeModelCall,
) -> Result<Value> {
    tx.assert_snapshot(&run.transaction_id)?;
    tx.lock_rank(3)?;
    let row = sqlx::query("SELECT * FROM model_call_attempts WHERE id=? AND run_id=? FOR UPDATE")
        .bind(&input.call_attempt_id)
        .bind(&run.id)
        .fetch_optional(tx.connection())
        .await?
        .ok_or(Error::new("not_available"))?;
    if row
        .get::<Option<String>, _>("parameters_fingerprint")
        .as_deref()
        != Some(&input.parameters_fingerprint)
    {
        return Err(Error::new("idempotency_conflict"));
    }
    let state: String = row.get("state");
    let usage = input
        .usage
        .as_ref()
        .map(serde_json::to_value)
        .transpose()
        .map_err(|_| Error::new("invalid_input"))?;
    if state == "settled" {
        if row
            .get::<Option<sqlx::types::Json<Value>>, _>("usage_json")
            .map(|v| v.0)
            != usage
        {
            return Err(Error::new("idempotency_conflict"));
        }
        return Ok(json!({"state":"settled","send_allowed":false}));
    }
    if state != "issued" && state != "unknown" {
        return Err(Error::new("version_conflict"));
    }
    let Some(usage) = input.usage.as_ref() else {
        sqlx::query("UPDATE model_call_attempts SET state='unknown' WHERE id=?")
            .bind(&input.call_attempt_id)
            .execute(tx.connection())
            .await?;
        return Ok(json!({"state":"unknown","send_allowed":false}));
    };
    tx.lock_rank(6)?;
    let profile = read_budget_profile_in_tx(tx, &run.budget_scope_id)
        .await?
        .ok_or(Error::new("not_available"))?;
    tx.lock_rank(7)?;
    sqlx::query("SELECT id FROM model_trials WHERE id=? FOR UPDATE")
        .bind(&profile.trial_id)
        .fetch_one(tx.connection())
        .await?;
    let cost = model_cost(
        &profile,
        usage.input_tokens as u64,
        usage.output_tokens as u64,
    )?;
    let exceeds = i64::from(usage.input_tokens)
        > row.get::<Option<u32>, _>("input_tokens_upper").unwrap_or(0) as i64
        || i64::from(usage.output_tokens)
            > row.get::<Option<u32>, _>("output_tokens_max").unwrap_or(0) as i64;
    sqlx::query("UPDATE model_trials SET spent_micros=spent_micros+?,reserved_micros=reserved_micros-?,state=IF(?,'breached',state) WHERE id=?")
        .bind(cost).bind(row.get::<Option<u64>,_>("reserved_micros").ok_or(Error::new("invalid_input"))?).bind(exceeds).bind(&profile.trial_id).execute(tx.connection()).await?;
    sqlx::query(
        "UPDATE model_call_attempts SET state='settled',actual_micros=?,usage_json=? WHERE id=?",
    )
    .bind(cost)
    .bind(sqlx::types::Json(
        serde_json::to_value(usage).map_err(|_| Error::new("invalid_input"))?,
    ))
    .bind(&input.call_attempt_id)
    .execute(tx.connection())
    .await?;
    Ok(json!({"state":"settled","send_allowed":false}))
}

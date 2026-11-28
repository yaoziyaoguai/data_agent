use super::super::store::{LockedRun, read_budget_profile_in_tx};
use crate::{
    persistence::AppTx,
    types::{Error, Result},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{MySqlPool, Row};

const SEND_PERMIT_SECONDS: i32 = 30;
const ABANDONED_RESERVATION_SECONDS: i32 = 10 * 60;

pub async fn release_abandoned_reservations(pool: &MySqlPool, active: &[String]) -> Result<bool> {
    const BATCH: usize = 32;
    // 派发新租约会创建新 run。失效旧 run 无法用原 ID 续租。
    let mut pending = sqlx::QueryBuilder::<sqlx::MySql>::new(
        "SELECT id FROM model_call_attempts WHERE reservation_released_at IS NULL AND state IN ('reserved','issued','unknown') AND reserved_micros IS NOT NULL AND permit_expires_at<TIMESTAMPADD(SECOND,",
    );
    // 行上保存的是发送许可到期时间；十分钟从预占创建时起算。
    pending
        .push_bind(SEND_PERMIT_SECONDS - ABANDONED_RESERVATION_SECONDS)
        .push(",UTC_TIMESTAMP(3))");
    if !active.is_empty() {
        pending.push(" AND run_id NOT IN (");
        let mut params = pending.separated(",");
        for run in active {
            params.push_bind(run);
        }
        pending.push(")");
    }
    pending
        .push(" ORDER BY permit_expires_at LIMIT ")
        .push_bind(BATCH as u32);
    let ids = pending
        .build_query_scalar::<String>()
        .fetch_all(pool)
        .await?;
    for id in &ids {
        let mut tx = AppTx::begin(pool).await?;
        let row = sqlx::query("SELECT budget_scope_id,state,reserved_micros FROM model_call_attempts WHERE id=? AND reservation_released_at IS NULL AND state IN ('reserved','issued','unknown') FOR UPDATE")
            .bind(id).fetch_optional(tx.connection()).await?;
        if let Some(row) = row {
            let state: String = row.get("state");
            let scope: String = row.get("budget_scope_id");
            let reservation: u64 = row.get("reserved_micros");
            let profile = read_budget_profile_in_tx(&mut tx, &scope)
                .await?
                .ok_or(Error::new("not_available"))?;
            // 发送过的调用仍计入实际次数。只释放它的预留金额，迟到用量可沿原身份结算。
            sqlx::query("UPDATE model_trials SET reserved_micros=reserved_micros-?,allocated_calls=allocated_calls-? WHERE id=?")
                .bind(reservation).bind(u32::from(state == "reserved")).bind(&profile.trial_id)
                .execute(tx.connection()).await?;
            sqlx::query("UPDATE model_call_attempts SET reservation_released_at=UTC_TIMESTAMP(3),state=IF(state='issued','unknown',state) WHERE id=?")
                .bind(id).execute(tx.connection()).await?;
            tx.commit().await?;
            eprintln!(
                "model_reservation_released attempt={id} state={state} reserved_micros={reservation}"
            );
        } else {
            tx.commit().await?;
        }
    }
    Ok(ids.len() == BATCH)
}

#[derive(Deserialize, Serialize)]
struct MaintenanceBudget {
    format_version: u8,
    profile: crate::contracts::generated::ModelProfile,
    input_tokens_upper: u64,
    output_tokens_max: u64,
}

impl MaintenanceBudget {
    fn for_profile(profile: &crate::contracts::generated::ModelProfile) -> Result<Self> {
        // 官方/models与chat/completions合同：总窗口含输入/输出，输入保守取完整窗口，
        // 不把本地分片估计或“窗口减max_tokens”当作已证计费上界。
        // https://api-docs.deepseek.com/api/list-models/
        let (input_peak, output_peak) = match profile.model_id.as_str() {
            "deepseek-flash" => (300_000, 1_200_000),
            "deepseek-v4-pro" => (1_320_000, 3_960_000),
            _ => return Err(Error::new("budget_unavailable")),
        };
        if profile.provider_id != "deepseek" || !(1..=393_216).contains(&profile.output_limit) {
            return Err(Error::new("budget_unavailable"));
        }
        if let Some(configuration) = &profile.configured_model
            && (crate::types::epoch(&configuration.input_rate)? < input_peak
                || crate::types::epoch(&configuration.output_rate)? < output_peak)
        {
            return Err(Error::new("budget_unavailable"));
        }
        Ok(Self {
            format_version: 1,
            profile: profile.clone(),
            input_tokens_upper: 1_048_576,
            output_tokens_max: profile.output_limit as u64,
        })
    }
}

// 使用官方高峰、缓存未命中价作保守预留；金额以整数微美元保存。
fn model_cost(
    profile: &crate::contracts::generated::ModelProfile,
    input: u64,
    output: u64,
) -> Result<u64> {
    if let Some(configuration) = &profile.configured_model {
        let input_rate = crate::types::epoch(&configuration.input_rate)? as u128;
        let output_rate = crate::types::epoch(&configuration.output_rate)? as u128;
        let cost =
            ((input as u128) * input_rate + (output as u128) * output_rate).div_ceil(1_000_000);
        return u64::try_from(cost).map_err(|_| Error::new("invalid_input"));
    }
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
        "SELECT *,(expires_at IS NULL OR expires_at>UTC_TIMESTAMP(3)) AS valid FROM model_trials WHERE id=? FOR UPDATE",
    )
    .bind(&profile.trial_id)
    .fetch_one(tx.connection())
    .await?;
    let budget = MaintenanceBudget::for_profile(profile)?;
    let configuration = serde_json::to_value(profile).map_err(|_| Error::new("invalid_input"))?;
    if trial.get::<String, _>("configuration_fingerprint")
        != crate::types::fingerprint(&configuration)
    {
        return Err(Error::new("budget_unavailable"));
    }
    let reservation = model_cost(profile, budget.input_tokens_upper, budget.output_tokens_max)?;
    if trial.get::<i64, _>("valid") == 0
        || trial.get::<String, _>("state") != "active"
        || trial
            .get::<Option<u32>, _>("call_limit")
            .is_some_and(|limit| trial.get::<u32, _>("allocated_calls") >= limit)
        || trial
            .get::<Option<u64>, _>("cost_limit_micros")
            .is_some_and(|limit| {
                trial.get::<u64, _>("spent_micros")
                    + trial.get::<u64, _>("reserved_micros")
                    + reservation
                    > limit
            })
    {
        return Err(Error::new("budget_exhausted"));
    }
    sqlx::query("INSERT INTO maintenance_model_calls(id,trial_id,state,reserved_micros,budget_json) VALUES(?,?,'issued',?,?)")
        .bind(attempt).bind(&profile.trial_id).bind(reservation)
        .bind(sqlx::types::Json(budget)).execute(tx.connection()).await?;
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
    let trial_id: String = call.get("trial_id");
    let budget = if let Some(budget) =
        call.get::<Option<sqlx::types::Json<MaintenanceBudget>>, _>("budget_json")
    {
        if budget.format_version != 1 || budget.profile.trial_id != trial_id {
            return Err(Error::new("budget_unavailable"));
        }
        budget.0
    } else {
        // 旧issued只能用原trial不可变指纹匹配的原profile结算，保持旧输入限额；
        // 缺快照时不能借当前选择给旧调用补新上界、转trial或释放unknown。
        let fingerprint: String =
            sqlx::query_scalar("SELECT configuration_fingerprint FROM model_trials WHERE id=?")
                .bind(&trial_id)
                .fetch_one(tx.connection())
                .await?;
        let original = serde_json::to_value(profile).map_err(|_| Error::new("invalid_input"))?;
        if profile.trial_id != trial_id || crate::types::fingerprint(&original) != fingerprint {
            return Err(Error::new("budget_unavailable"));
        }
        MaintenanceBudget {
            format_version: 0,
            profile: profile.clone(),
            input_tokens_upper: profile.input_limit as u64,
            output_tokens_max: profile.output_limit as u64,
        }
    };
    let cost = model_cost(&budget.profile, input, output)?;
    let breached = input > budget.input_tokens_upper || output > budget.output_tokens_max;
    sqlx::query("UPDATE model_trials SET spent_micros=spent_micros+?,reserved_micros=reserved_micros-?,state=IF(?,'breached',state) WHERE id=?").bind(cost).bind(call.get::<u64,_>("reserved_micros")).bind(breached).bind(&trial_id).execute(tx.connection()).await?;
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

pub(super) async fn ensure_default_trial(
    pool: &MySqlPool,
    profile: &crate::contracts::generated::ModelProfile,
) -> Result<()> {
    let configuration = serde_json::to_value(profile).map_err(|_| Error::new("invalid_input"))?;
    // 默认引导仅补缺行；升级后的默认值不能重配既有账本或重置其状态。
    sqlx::query("INSERT INTO model_trials(id,configuration_fingerprint,call_limit,cost_limit_micros,expires_at) VALUES(?,?,NULL,NULL,NULL) ON DUPLICATE KEY UPDATE id=id")
        .bind(&profile.trial_id)
        .bind(crate::types::fingerprint(&configuration))
        .execute(pool)
        .await?;
    Ok(())
}

pub(super) async fn configure_trial(
    pool: &MySqlPool,
    profile: &crate::contracts::generated::ModelProfile,
) -> Result<()> {
    configure_budget(
        pool,
        &serde_json::to_value(profile).map_err(|_| Error::new("invalid_input"))?,
        &profile.trial_id,
        profile.trial_call_limit.map(|limit| limit as u32),
        profile.trial_cost_micros.as_deref(),
        (!matches!(
            profile.budget_mode,
            Some(crate::contracts::generated::BudgetMode::Request)
        ))
        .then_some(3600),
    )
    .await
}
pub(super) async fn configure_embedding_trial(
    pool: &MySqlPool,
    profile: &crate::contracts::generated::EmbeddingProfile,
) -> Result<()> {
    // 普通维护配置无累计限额与期限；仅显式限额的维护试用给一小时窗口。
    let explicit_limit = profile.call_limit.is_some() || profile.cost_limit_micros.is_some();
    configure_budget(
        pool,
        &serde_json::to_value(profile).map_err(|_| Error::new("invalid_input"))?,
        &profile.trial_id,
        profile.call_limit.map(|limit| limit as u32),
        profile.cost_limit_micros.as_deref(),
        explicit_limit.then_some(3600),
    )
    .await
}
async fn configure_budget(
    pool: &MySqlPool,
    configuration: &Value,
    trial_id: &str,
    call_limit: Option<u32>,
    cost_limit: Option<&str>,
    duration_seconds: Option<u32>,
) -> Result<()> {
    let fp = crate::types::fingerprint(configuration);
    let mut tx = AppTx::begin(pool).await?;
    sqlx::query("INSERT INTO model_trials(id,configuration_fingerprint,call_limit,cost_limit_micros,expires_at) VALUES(?,?,?,?,TIMESTAMPADD(SECOND,?,UTC_TIMESTAMP(3))) ON DUPLICATE KEY UPDATE id=id")
        .bind(trial_id).bind(&fp).bind(call_limit).bind(cost_limit.map(crate::types::epoch).transpose()?).bind(duration_seconds).execute(tx.connection()).await?;
    let current: String = sqlx::query_scalar(
        "SELECT configuration_fingerprint FROM model_trials WHERE id=? FOR UPDATE",
    )
    .bind(trial_id)
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
    let inserted = sqlx::query("INSERT INTO model_call_attempts(id,budget_scope_id,run_id,state,parameters_fingerprint,input_tokens_upper,output_tokens_max,reserved_micros,permit_expires_at) VALUES(?,?,?,'reserved',?,?,?,?,TIMESTAMPADD(SECOND,?,UTC_TIMESTAMP(3)))")
        .bind(&input.call_attempt_id).bind(&run.budget_scope_id).bind(&run.id).bind(&input.parameters_fingerprint).bind(input.input_tokens_upper).bind(input.output_tokens_max).bind(reservation).bind(SEND_PERMIT_SECONDS).execute(tx.connection()).await;
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
        || input.output_tokens_max == 0
        || input.output_tokens_max > profile.output_limit
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
    if scope
        .get::<Option<u32>, _>("call_limit")
        .is_some_and(|limit| scope.get::<u32, _>("issued_calls") >= limit)
    {
        return Err(Error::new("budget_exhausted"));
    }
    if scope.get::<u8, _>("model_failure_streak") >= 3 {
        return Err(Error::new("model_retry_exhausted"));
    }
    sqlx::query("UPDATE model_call_attempts SET scope_call_sequence=? WHERE id=?")
        .bind(scope.get::<u32, _>("issued_calls") + 1)
        .bind(&input.call_attempt_id)
        .execute(tx.connection())
        .await?;
    tx.lock_rank(7)?;
    let trial = sqlx::query(
        "SELECT *,(expires_at IS NULL OR expires_at>UTC_TIMESTAMP(3)) AS valid FROM model_trials WHERE id=? FOR UPDATE",
    )
    .bind(&profile.trial_id)
    .fetch_one(tx.connection())
    .await?;
    if trial.get::<i64, _>("valid") == 0
        || trial.get::<String, _>("state") != "active"
        || trial
            .get::<Option<u32>, _>("call_limit")
            .is_some_and(|limit| trial.get::<u32, _>("allocated_calls") >= limit)
        || trial
            .get::<Option<u64>, _>("cost_limit_micros")
            .is_some_and(|limit| {
                trial.get::<u64, _>("spent_micros")
                    + trial.get::<u64, _>("reserved_micros")
                    + reservation
                    > limit
            })
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
    let failures: u8 =
        sqlx::query_scalar("SELECT model_failure_streak FROM budget_scopes WHERE id=? FOR UPDATE")
            .bind(&run.budget_scope_id)
            .fetch_one(tx.connection())
            .await?;
    if failures >= 3 {
        return Err(Error::new("model_retry_exhausted"));
    }
    tx.lock_rank(7)?;
    let trial = sqlx::query(
        "SELECT state,(expires_at IS NULL OR expires_at>UTC_TIMESTAMP(3)) AS valid FROM model_trials WHERE id=? FOR UPDATE",
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
    let row = sqlx::query("SELECT *,reservation_released_at IS NOT NULL AS reservation_released FROM model_call_attempts WHERE id=? AND run_id=? FOR UPDATE")
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
    let recorded_outcome = row.get::<Option<String>, _>("outcome");
    let outcome = input.outcome.as_ref().map(|outcome| match outcome {
        crate::contracts::generated::Outcome::Success => "success",
        crate::contracts::generated::Outcome::TransientError => "transient_error",
        crate::contracts::generated::Outcome::PermanentError => "permanent_error",
    });
    if recorded_outcome.is_some() && recorded_outcome.as_deref() != outcome {
        return Err(Error::new("idempotency_conflict"));
    }
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
    // 依实际调用顺序重算最近结果；晚到失败不能漏计，晚到成功也不能清掉新失败。
    if recorded_outcome.is_none()
        && let Some(outcome) = outcome
    {
        sqlx::query("UPDATE model_call_attempts SET outcome=? WHERE id=?")
            .bind(outcome)
            .bind(&input.call_attempt_id)
            .execute(tx.connection())
            .await?;
        let recent = sqlx::query("SELECT outcome FROM model_call_attempts WHERE budget_scope_id=? AND scope_call_sequence IS NOT NULL AND outcome IS NOT NULL ORDER BY scope_call_sequence DESC LIMIT 3 FOR UPDATE")
            .bind(&run.budget_scope_id).fetch_all(tx.connection()).await?;
        let mut failures = 0_u8;
        for call in recent {
            match call.get::<Option<String>, _>("outcome").as_deref() {
                Some("transient_error") => failures += 1,
                Some("permanent_error") => {
                    failures = 3;
                    break;
                }
                _ => break,
            }
        }
        tx.lock_rank(6)?;
        sqlx::query("UPDATE budget_scopes SET model_failure_streak=? WHERE id=?")
            .bind(failures)
            .bind(&run.budget_scope_id)
            .execute(tx.connection())
            .await?;
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
    let trial = sqlx::query(
        "SELECT spent_micros,cost_limit_micros FROM model_trials WHERE id=? FOR UPDATE",
    )
    .bind(&profile.trial_id)
    .fetch_one(tx.connection())
    .await?;
    let cost = model_cost(
        &profile,
        usage.input_tokens as u64,
        usage.output_tokens as u64,
    )?;
    let next_spent = trial.get::<u64, _>("spent_micros").saturating_add(cost);
    let cost_exceeded = trial
        .get::<Option<u64>, _>("cost_limit_micros")
        .is_some_and(|limit| next_spent > limit);
    let exceeds = cost_exceeded
        || i64::from(usage.input_tokens)
            > row.get::<Option<u32>, _>("input_tokens_upper").unwrap_or(0) as i64
        || i64::from(usage.output_tokens)
            > row.get::<Option<u32>, _>("output_tokens_max").unwrap_or(0) as i64;
    let reservation = if row.get::<i64, _>("reservation_released") != 0 {
        0
    } else {
        row.get::<Option<u64>, _>("reserved_micros")
            .ok_or(Error::new("invalid_input"))?
    };
    sqlx::query("UPDATE model_trials SET spent_micros=spent_micros+?,reserved_micros=reserved_micros-?,state=IF(?,'breached',state) WHERE id=?")
        .bind(cost).bind(reservation).bind(exceeds).bind(&profile.trial_id).execute(tx.connection()).await?;
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

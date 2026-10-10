use crate::{
    contracts::generated::ModelProfile,
    persistence::AppTx,
    types::{Error, Result},
};
use serde_json::{Value, json};
use sqlx::Row;

pub struct ProviderBudget {
    pub scope_id: Option<String>,
    pub trial_id: String,
    pub input_limit: u64,
    pub output_limit: u64,
}
impl ProviderBudget {
    pub fn from_model_profile(scope_id: Option<String>, profile: ModelProfile) -> Result<Self> {
        if !matches!(
            profile.model_id.as_str(),
            "deepseek-flash" | "deepseek-v4-pro"
        ) {
            return Err(Error::new("invalid_input"));
        }
        Ok(Self {
            scope_id,
            trial_id: profile.trial_id,
            input_limit: profile.input_limit as u64,
            output_limit: profile.output_limit as u64,
        })
    }
}

fn cost(purpose: &str, input: u64, output: u64) -> u64 {
    if matches!(purpose, "memory_embedding" | "knowledge_embedding") {
        // 百炼0.5元/百万token；预算按0.10美元/百万token保守折算，报告仍列原币用量。
        input.div_ceil(10)
    } else {
        (input * 30 + output * 120).div_ceil(100)
    }
}

pub async fn issue_in_tx(
    tx: &mut AppTx<'_>,
    budget: &ProviderBudget,
    input: &Value,
) -> Result<Value> {
    let purpose = input["purpose"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?;
    let upper = input["input_tokens_upper"]
        .as_u64()
        .ok_or(Error::new("invalid_input"))?;
    let output = input["output_tokens_max"]
        .as_u64()
        .ok_or(Error::new("invalid_input"))?;
    if !matches!(
        purpose,
        "memory_embedding" | "memory_extraction" | "knowledge_embedding"
    ) || upper == 0
        || upper > budget.input_limit
        || (matches!(purpose, "memory_embedding" | "knowledge_embedding")
            && (upper > 8192 || output != 0))
        || (purpose == "memory_extraction" && (output != 4096 || output > budget.output_limit))
    {
        return Err(Error::new("invalid_input"));
    }
    let reserved = cost(purpose, upper, output);
    let inserted = sqlx::query("INSERT INTO model_call_attempts(id,budget_scope_id,run_id,state,parameters_fingerprint,input_tokens_upper,output_tokens_max,reserved_micros,purpose,trial_id,operation_id,price_version) VALUES(?,?,NULL,'issued',?,?,?,?,?,?,?,?)")
        .bind(input["call_attempt_id"].as_str()).bind(&budget.scope_id).bind(input["parameters_fingerprint"].as_str())
        .bind(upper).bind(output).bind(reserved).bind(purpose).bind(&budget.trial_id)
        .bind(input["budget"]["operation_id"].as_str()).bind(if matches!(purpose,"memory_embedding" | "knowledge_embedding"){"2026-10-05-qwen-cny-usd-ceiling"}else{"2026-10-04-peak-usd"}).execute(tx.connection()).await;
    if let Err(error) = inserted {
        if !error.as_database_error().is_some_and(|e| {
            e.try_downcast_ref::<sqlx::mysql::MySqlDatabaseError>()
                .is_some_and(|e| e.number() == 1062)
        }) {
            return Err(error.into());
        }
        let row = sqlx::query("SELECT * FROM model_call_attempts WHERE id=? FOR UPDATE")
            .bind(input["call_attempt_id"].as_str())
            .fetch_one(tx.connection())
            .await?;
        if row
            .get::<Option<String>, _>("parameters_fingerprint")
            .as_deref()
            != input["parameters_fingerprint"].as_str()
            || row.get::<Option<String>, _>("operation_id").as_deref()
                != input["budget"]["operation_id"].as_str()
            || row.get::<String, _>("purpose") != purpose
            || row.get::<Option<String>, _>("trial_id").as_deref() != Some(&budget.trial_id)
            || row.get::<Option<String>, _>("budget_scope_id") != budget.scope_id
            || row.get::<Option<u32>, _>("input_tokens_upper") != Some(upper as u32)
            || row.get::<Option<u32>, _>("output_tokens_max") != Some(output as u32)
        {
            return Err(Error::new("idempotency_conflict"));
        }
        return Ok(json!({"state":row.get::<String,_>("state"),"send_allowed":false}));
    }
    if let Some(scope) = &budget.scope_id {
        tx.lock_rank(6)?;
        let row = sqlx::query("SELECT * FROM budget_scopes WHERE id=? FOR UPDATE")
            .bind(scope)
            .fetch_one(tx.connection())
            .await?;
        let profile = row
            .get::<Option<sqlx::types::Json<Value>>, _>("model_profile")
            .ok_or(Error::new("not_available"))?
            .0;
        if profile["trial_id"] != budget.trial_id
            || row.get::<u32, _>("issued_calls") >= row.get::<u32, _>("call_limit")
        {
            return Err(Error::new("budget_exhausted"));
        }
        sqlx::query("UPDATE budget_scopes SET issued_calls=issued_calls+1 WHERE id=?")
            .bind(scope)
            .execute(tx.connection())
            .await?;
    }
    tx.lock_rank(7)?;
    let trial = sqlx::query(
        "SELECT *,expires_at>UTC_TIMESTAMP(3) AS valid FROM model_trials WHERE id=? FOR UPDATE",
    )
    .bind(&budget.trial_id)
    .fetch_one(tx.connection())
    .await?;
    if trial.get::<i64, _>("valid") == 0
        || trial.get::<String, _>("state") != "active"
        || trial.get::<u32, _>("allocated_calls") >= trial.get::<u32, _>("call_limit")
        || trial.get::<u64, _>("spent_micros") + trial.get::<u64, _>("reserved_micros") + reserved
            > trial.get::<u64, _>("cost_limit_micros")
    {
        return Err(Error::new("budget_exhausted"));
    }
    sqlx::query("UPDATE model_trials SET allocated_calls=allocated_calls+1,reserved_micros=reserved_micros+? WHERE id=?").bind(reserved).bind(&budget.trial_id).execute(tx.connection()).await?;
    Ok(json!({"state":"issued","send_allowed":true}))
}

pub async fn finish_in_tx(tx: &mut AppTx<'_>, input: &Value) -> Result<Value> {
    let row = sqlx::query("SELECT * FROM model_call_attempts WHERE id=? FOR UPDATE")
        .bind(input["call_attempt_id"].as_str())
        .fetch_optional(tx.connection())
        .await?
        .ok_or(Error::new("not_available"))?;
    if row
        .get::<Option<String>, _>("parameters_fingerprint")
        .as_deref()
        != input["parameters_fingerprint"].as_str()
        || row.get::<Option<String>, _>("operation_id").as_deref()
            != input["budget"]["operation_id"].as_str()
        || row.get::<String, _>("purpose") != input["purpose"].as_str().unwrap_or("")
    {
        return Err(Error::new("idempotency_conflict"));
    }
    let state: String = row.get("state");
    if state == "settled" {
        if row
            .get::<Option<sqlx::types::Json<Value>>, _>("usage_json")
            .map(|v| v.0)
            != Some(input["usage"].clone())
        {
            return Err(Error::new("idempotency_conflict"));
        }
        return Ok(json!({"state":"settled","send_allowed":false}));
    }
    if !matches!(state.as_str(), "issued" | "unknown") {
        return Err(Error::new("version_conflict"));
    }
    if input["usage"].is_null() {
        sqlx::query("UPDATE model_call_attempts SET state='unknown' WHERE id=?")
            .bind(input["call_attempt_id"].as_str())
            .execute(tx.connection())
            .await?;
        return Ok(json!({"state":"unknown","send_allowed":false}));
    }
    let usage = &input["usage"];
    let input_tokens = usage["input_tokens"]
        .as_u64()
        .ok_or(Error::new("invalid_input"))?;
    let output_tokens = usage["output_tokens"]
        .as_u64()
        .ok_or(Error::new("invalid_input"))?;
    let breached = input_tokens
        > u64::from(row.get::<Option<u32>, _>("input_tokens_upper").unwrap_or(0))
        || output_tokens > u64::from(row.get::<Option<u32>, _>("output_tokens_max").unwrap_or(0));
    let actual = cost(
        &row.get::<String, _>("purpose"),
        input_tokens,
        output_tokens,
    );
    let trial = row
        .get::<Option<String>, _>("trial_id")
        .ok_or(Error::new("not_available"))?;
    tx.lock_rank(7)?;
    sqlx::query("SELECT id FROM model_trials WHERE id=? FOR UPDATE")
        .bind(&trial)
        .fetch_one(tx.connection())
        .await?;
    sqlx::query("UPDATE model_trials SET spent_micros=spent_micros+?,reserved_micros=reserved_micros-?,state=IF(?,'breached',state) WHERE id=?")
        .bind(actual).bind(row.get::<Option<u64>,_>("reserved_micros").ok_or(Error::new("invalid_input"))?).bind(breached).bind(trial).execute(tx.connection()).await?;
    sqlx::query(
        "UPDATE model_call_attempts SET state='settled',actual_micros=?,usage_json=? WHERE id=?",
    )
    .bind(actual)
    .bind(sqlx::types::Json(usage))
    .bind(input["call_attempt_id"].as_str())
    .execute(tx.connection())
    .await?;
    Ok(json!({"state":"settled","send_allowed":false}))
}

// 只用于共享向量；同一操作的成功响应可重放，issued/unknown不能再次外发。
pub async fn cached_embedding_in_tx(tx: &mut AppTx<'_>, input: &Value) -> Result<Option<Value>> {
    let row=sqlx::query("SELECT state,operation_id,purpose,parameters_fingerprint,response_json FROM model_call_attempts WHERE id=?")
        .bind(input["call_attempt_id"].as_str()).fetch_optional(tx.connection()).await?;
    let Some(row) = row else {
        return Ok(None);
    };
    if row.get::<String, _>("purpose") != "knowledge_embedding"
        || row.get::<Option<String>, _>("operation_id").as_deref()
            != input["budget"]["operation_id"].as_str()
        || row
            .get::<Option<String>, _>("parameters_fingerprint")
            .as_deref()
            != input["parameters_fingerprint"].as_str()
    {
        return Err(Error::new("idempotency_conflict"));
    }
    if row.get::<String, _>("state") != "settled" {
        return Err(Error::new("embedding_unknown"));
    }
    row.get::<Option<sqlx::types::Json<Value>>, _>("response_json")
        .map(|v| Some(v.0))
        .ok_or(Error::new("embedding_unavailable"))
}

pub async fn finish_embedding_in_tx(
    tx: &mut AppTx<'_>,
    input: &Value,
    response: Option<&Value>,
) -> Result<()> {
    finish_in_tx(tx, input).await?;
    if let Some(response) = response {
        sqlx::query("UPDATE model_call_attempts SET response_json=? WHERE id=? AND state='settled' AND purpose='knowledge_embedding'")
            .bind(sqlx::types::Json(response)).bind(input["call_attempt_id"].as_str()).execute(tx.connection()).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auxiliary_calls_keep_the_request_budget_when_chat_uses_pro() {
        let profile = crate::contracts::decode("ModelProfile", json!({
            "provider_id":"deepseek", "model_id":"deepseek-v4-pro", "thinking_level":"max",
            "price_version":"2026-10-05-pro-peak-usd", "trial_id":"shared-request-trial",
            "input_limit":32768,"output_limit":4096,"trial_call_limit":24,"trial_cost_micros":"300000",
            "request_call_limit":12,"toolset":"data","payload_bytes_limit":65536
        })).unwrap();
        let budget =
            ProviderBudget::from_model_profile(Some("original-scope".into()), profile).unwrap();
        assert_eq!(budget.scope_id.as_deref(), Some("original-scope"));
        assert_eq!(budget.trial_id, "shared-request-trial");
        assert_eq!((budget.input_limit, budget.output_limit), (32768, 4096));
        // 辅助模型未改：记忆抽取仍按Flash，向量仍按原百炼配置预留。
        assert_eq!(cost("memory_extraction", 1000, 1000), 1500);
        assert_eq!(cost("memory_embedding", 1000, 0), 100);
        assert_eq!(cost("knowledge_embedding", 1000, 0), 100);
    }
}

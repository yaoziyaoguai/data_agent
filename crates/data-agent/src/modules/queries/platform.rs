use crate::types::{Error, Result};
use serde_json::{Value, json};
use std::time::Duration;
pub async fn call(path: &str, input: &Value) -> Result<Value> {
    let url = std::env::var("DATA_AGENT_PLATFORM_URL").map_err(|_| Error::new("unsupported"))?;
    let parsed = reqwest::Url::parse(&url).map_err(|_| Error::new("invalid_input"))?;
    if parsed.scheme() != "http" || parsed.host_str() != Some("127.0.0.1") {
        return Err(Error::new("invalid_input"));
    }
    let token =
        std::env::var("DATA_AGENT_INTERNAL_TOKEN").map_err(|_| Error::new("unauthenticated"))?;
    let response = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|_| Error::new("unavailable"))?
        .post(format!("{url}{path}"))
        .bearer_auth(token)
        .json(input)
        .send()
        .await
        .map_err(|_| Error::new("outcome_unknown"))?;
    let status = response.status();
    let value: Value = response
        .json()
        .await
        .map_err(|_| Error::new("outcome_unknown"))?;
    if !status.is_success() {
        return Err(Error::new(match value["code"].as_str() {
            Some("not_available") => "not_available",
            Some("result_expired") => "result_expired",
            Some("result_unavailable") => "result_unavailable",
            Some("sql_not_supported") => "sql_not_supported",
            Some("invalid_input") => "invalid_input",
            Some("forbidden") => "forbidden",
            Some("idempotency_conflict") => "idempotency_conflict",
            Some("outcome_unknown") => "outcome_unknown",
            _ => "upstream_failed",
        }));
    }
    Ok(value)
}
pub async fn check(sql: &str, parameters: &Value) -> Result<Value> {
    call("/validate", &json!({"sql":sql,"parameters":parameters})).await
}

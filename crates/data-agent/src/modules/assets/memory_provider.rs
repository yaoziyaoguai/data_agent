use crate::{
    contracts,
    types::{Error, Result},
};
use serde_json::Value;

pub fn enabled() -> bool {
    std::env::var("DATA_AGENT_MEMORY_URL").is_ok_and(|v| !v.is_empty())
}

pub fn index_target() -> String {
    std::env::var("DATA_AGENT_MEMORY_INDEX_TARGET").unwrap_or_else(|_| "default".to_owned())
}

pub async fn call(
    path: &str,
    request_schema: &str,
    response_schema: &str,
    input: &Value,
) -> Result<Value> {
    contracts::validate(request_schema, input)?;
    let url = reqwest::Url::parse(
        &std::env::var("DATA_AGENT_MEMORY_URL").map_err(|_| Error::new("memory_unavailable"))?,
    )
    .map_err(|_| Error::new("invalid_input"))?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(Error::new("invalid_input"));
    }
    let token =
        std::env::var("DATA_AGENT_INTERNAL_TOKEN").map_err(|_| Error::new("memory_unavailable"))?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(if path == "/extract" {
            360
        } else {
            45
        }))
        .build()
        .map_err(|_| Error::new("memory_unavailable"))?;
    let response = client
        .post(url.join(path).map_err(|_| Error::new("invalid_input"))?)
        .bearer_auth(token)
        .json(input)
        .send()
        .await
        .map_err(|_| Error::new("memory_unavailable"))?;
    let ok = response.status().is_success();
    let bytes = response
        .bytes()
        .await
        .map_err(|_| Error::new("memory_unavailable"))?;
    if bytes.len() > 100000 {
        return Err(Error::new("memory_unavailable"));
    }
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| Error::new("memory_unavailable"))?;
    if !ok {
        return Err(Error::new(match value["error"].as_str() {
            Some("budget_exhausted") => "budget_exhausted",
            Some("memory_extraction_empty") => "memory_extraction_empty",
            Some("memory_operation_unknown") => "memory_operation_unknown",
            Some("idempotency_conflict") => "idempotency_conflict",
            _ => "memory_unavailable",
        }));
    }
    contracts::validate(response_schema, &value)?;
    Ok(value)
}

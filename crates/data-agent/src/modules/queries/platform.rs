use crate::types::{Error, Result};
use serde::Deserialize;
use serde_json::{Value, json};
use std::time::Duration;
pub async fn call(path: &str, input: &Value) -> Result<Value> {
    call_limited(path, input, None).await
}

pub async fn saved_result_page(input: &Value) -> Result<Value> {
    call_limited("/results", input, Some(super::SAVED_RESULT_LIMIT)).await
}

async fn call_limited(path: &str, input: &Value, limit: Option<usize>) -> Result<Value> {
    let url = std::env::var("DATA_AGENT_PLATFORM_URL").map_err(|_| Error::new("unsupported"))?;
    let parsed = reqwest::Url::parse(&url).map_err(|_| Error::new("invalid_input"))?;
    if parsed.scheme() != "http" || parsed.host_str() != Some("127.0.0.1") {
        return Err(Error::new("invalid_input"));
    }
    let token =
        std::env::var("DATA_AGENT_INTERNAL_TOKEN").map_err(|_| Error::new("unauthenticated"))?;
    let mut response = reqwest::Client::builder()
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
    let value: Value = if let Some(limit) = limit {
        if response
            .content_length()
            .is_some_and(|length| length > limit as u64)
        {
            return Err(Error::new("request_too_large"));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| Error::new("outcome_unknown"))?
        {
            if bytes
                .len()
                .checked_add(chunk.len())
                .is_none_or(|length| length > limit)
            {
                return Err(Error::new("request_too_large"));
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| Error::new("outcome_unknown"))?
    } else {
        response
            .json()
            .await
            .map_err(|_| Error::new("outcome_unknown"))?
    };
    if !status.is_success() {
        return Err(Error::new(match value["code"].as_str() {
            Some("not_available") => "not_available",
            Some("result_expired") => "result_expired",
            Some("result_unavailable") => "result_unavailable",
            Some("sql_not_supported") => "sql_not_supported",
            Some("invalid_input") => "invalid_input",
            Some("forbidden") => "forbidden",
            Some("idempotency_conflict") => "idempotency_conflict",
            Some("version_conflict" | "source_version_conflict") => "version_conflict",
            Some("outcome_unknown") => "outcome_unknown",
            _ => "upstream_failed",
        }));
    }
    Ok(value)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResultAuthority {
    query_id: String,
    owner_id: String,
    result_ref: String,
    state: String,
    source: String,
    saved_row_count: usize,
    #[serde(rename = "saved_result_complete")]
    _saved_result_complete: bool,
}

fn check_result_authority(
    value: Value,
    query_id: &str,
    owner_id: &str,
    result_ref: &str,
) -> Result<()> {
    let response: ResultAuthority =
        serde_json::from_value(value).map_err(|_| Error::new("result_unavailable"))?;
    if response.query_id != query_id || response.owner_id != owner_id {
        return Err(Error::new("not_available"));
    }
    if response.result_ref != result_ref
        || response.state != "available"
        || response.source != "mock"
        || response.saved_row_count > 1000
    {
        return Err(Error::new("result_unavailable"));
    }
    Ok(())
}

pub async fn result_authority(query_id: &str, owner_id: &str, result_ref: &str) -> Result<()> {
    let value = call_limited(
        "/result-authority",
        &json!({"query_id":query_id,"owner_id":owner_id,"result_ref":result_ref}),
        Some(4096),
    )
    .await?;
    check_result_authority(value, query_id, owner_id, result_ref)
}

pub async fn check(sql: &str, parameters: &Value) -> Result<Value> {
    call("/validate", &json!({"sql":sql,"parameters":parameters})).await
}

#[cfg(test)]
mod authority_tests {
    use super::*;
    fn authority() -> Value {
        json!({"query_id":"saved","owner_id":"alice","result_ref":"saved","state":"available","source":"mock",
        "saved_row_count":205,"saved_result_complete":true})
    }
    #[test]
    fn result_authority_binds_owner_query_and_reference_without_rows() {
        check_result_authority(authority(), "saved", "alice", "saved").unwrap();
        assert_eq!(
            check_result_authority(authority(), "saved", "bob", "saved")
                .unwrap_err()
                .code,
            "not_available"
        );
        assert_eq!(
            check_result_authority(authority(), "other", "alice", "saved")
                .unwrap_err()
                .code,
            "not_available"
        );
        assert_eq!(
            check_result_authority(authority(), "saved", "alice", "other")
                .unwrap_err()
                .code,
            "result_unavailable"
        );
    }
    #[test]
    fn malformed_or_unavailable_authority_is_not_success() {
        for (key, value) in [
            ("state", json!("running")),
            ("saved_row_count", json!(1001)),
            ("rows", json!([])),
        ] {
            let mut response = authority();
            response[key] = value;
            assert_eq!(
                check_result_authority(response, "saved", "alice", "saved")
                    .unwrap_err()
                    .code,
                "result_unavailable"
            );
        }
        let mut truncated = authority();
        truncated["saved_row_count"] = json!(1000);
        truncated["saved_result_complete"] = json!(false);
        check_result_authority(truncated, "saved", "alice", "saved").unwrap();
    }
}

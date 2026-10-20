mod secrets;
mod store;
use crate::{
    contracts::{self, generated::ModelProfile},
    types::{Error, Result},
};
use serde_json::{Value, json};
use sqlx::MySqlPool;
pub use store::{
    assert_active_in_tx, connection_in_tx, default_model, save_model, save_service,
    selection_in_tx, snapshot,
};

pub async fn initialize(
    pool: &MySqlPool,
    space: &str,
    profile: Option<&ModelProfile>,
) -> Result<()> {
    if profile.is_none() {
        let base = contracts::decode("ModelProfile", store::base_profile(space))?;
        super::configure_trial(pool, &base).await?;
    }
    store::initialize(pool, space, profile).await
}

pub async fn catalog(pool: &MySqlPool, space: &str) -> Result<Value> {
    let snapshot = snapshot(pool, space).await?;
    let services = snapshot["services"].as_array().unwrap();
    let models = snapshot["models"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| {
            m["enabled"] == true
                && services
                    .iter()
                    .any(|s| s["id"] == m["service_id"] && s["enabled"] == true)
        })
        .collect::<Vec<_>>();
    let default = models
        .iter()
        .find(|m| m["id"] == snapshot["default_model_id"]);
    let options=models.iter().map(|m|json!({"id":m["id"],"label":m["label"],"thinking_options":m["thinking_levels"].as_array().unwrap().iter().map(|v|json!({"value":v,"label":match v.as_str().unwrap(){"off"=>"关闭","minimal"=>"最轻","low"=>"轻度","medium"=>"中等","high"=>"深度","xhigh"=>"更深",_=>"最高"}})).collect::<Vec<_>>()})).collect::<Vec<_>>();
    Ok(
        json!({"models":options,"default_selection":default.map(|m|json!({"model_id":m["id"],"thinking_level":m["default_thinking"]})),"requires_model":!snapshot["models"].as_array().unwrap().is_empty()}),
    )
}

pub fn validate_service(value: &Value) -> Result<()> {
    if value["name"].as_str().unwrap_or("").trim().is_empty() {
        return Err(Error::new("invalid_input"));
    }
    let url = reqwest::Url::parse(value["base_url"].as_str().unwrap_or(""))
        .map_err(|_| Error::new("invalid_model_endpoint"))?;
    let host = url.host_str().ok_or(Error::new("invalid_model_endpoint"))?;
    let test = std::env::var("DATA_AGENT_PROVIDER_TEST").as_deref() == Ok("1")
        && host == "127.0.0.1"
        && url.scheme() == "http";
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || (!test && url.scheme() != "https")
    {
        return Err(Error::new("invalid_model_endpoint"));
    }
    if !test
        && (host == "localhost"
            || host.ends_with(".localhost")
            || host.ends_with(".local")
            || host
                .trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok())
    {
        return Err(Error::new("invalid_model_endpoint"));
    }
    if value
        .get("api_key")
        .and_then(Value::as_str)
        .is_some_and(|key| key.trim().is_empty() || key.chars().any(char::is_control))
    {
        return Err(Error::new("invalid_input"));
    }
    if value["provider_id"] == "deepseek" && value["api"] != "openai-completions" {
        return Err(Error::new("invalid_input"));
    }
    Ok(())
}

pub fn validate_model(value: &Value) -> Result<()> {
    if ["model_id", "label"]
        .iter()
        .any(|field| value[*field].as_str().unwrap_or("").trim().is_empty())
    {
        return Err(Error::new("invalid_input"));
    }
    if !value["thinking_levels"]
        .as_array()
        .unwrap()
        .contains(&value["default_thinking"])
        || value["output_limit"].as_u64() > value["input_limit"].as_u64()
        || (value["reasoning_supported"] != true
            && value["thinking_levels"]
                .as_array()
                .unwrap()
                .iter()
                .any(|level| level != "off"))
    {
        return Err(Error::new("invalid_input"));
    }
    Ok(())
}

pub(super) fn validate_model_protocol(model: &Value, service: &Value) -> Result<()> {
    let output = model["output_limit"].as_u64().unwrap_or(0);
    if service["api"] == "openai-responses" && output < 16 {
        return Err(Error::new("invalid_input"));
    }
    if service["api"] == "anthropic-messages" {
        let levels = model["thinking_levels"].as_array().unwrap();
        let adaptive = model["anthropic_thinking_mode"] == "adaptive";
        if (!adaptive
            && levels
                .iter()
                .any(|level| level == "xhigh" || level == "max"))
            || (!adaptive && levels.iter().any(|level| level != "off") && output < 2048)
        {
            return Err(Error::new("invalid_input"));
        }
    } else if model.get("anthropic_thinking_mode").is_some() {
        return Err(Error::new("invalid_input"));
    }
    Ok(())
}

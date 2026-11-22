mod capacity;
mod secrets;
mod store;
use crate::{
    contracts::{self, generated::ModelProfile},
    types::{Error, Result},
};
pub use capacity::{CapacityPlan, plan};
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
        super::ensure_default_trial(pool, &base).await?;
    }
    store::initialize(pool, space, profile).await
}

pub async fn catalog(pool: &MySqlPool, space: &str) -> Result<Value> {
    let snapshot = snapshot(pool, space).await?;
    let services = snapshot["services"]
        .as_array()
        .ok_or(Error::new("unavailable"))?;
    let all_models = snapshot["models"]
        .as_array()
        .ok_or(Error::new("unavailable"))?;
    let mut options = Vec::new();
    let mut default = None;
    for model in all_models.iter().filter(|model| {
        model["enabled"] == true
            && services
                .iter()
                .any(|service| service["id"] == model["service_id"] && service["enabled"] == true)
    }) {
        if model["id"] == snapshot["default_model_id"] {
            default =
                Some(json!({"model_id":model["id"],"thinking_level":model["default_thinking"]}));
        }
        let mut thinking = Vec::new();
        for value in model["thinking_levels"]
            .as_array()
            .ok_or(Error::new("unavailable"))?
        {
            let label = match value.as_str() {
                Some("off") => "关闭",
                Some("minimal") => "最轻",
                Some("low") => "轻度",
                Some("medium") => "中等",
                Some("high") => "深度",
                Some("xhigh") => "更深",
                Some("max") => "最高",
                _ => return Err(Error::new("unavailable")),
            };
            thinking.push(json!({"value":value,"label":label}));
        }
        options.push(json!({"id":model["id"],"label":model["label"],"thinking_options":thinking}));
    }
    Ok(
        json!({"models":options,"default_selection":default,"requires_model":!all_models.is_empty()}),
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
        && crate::upstream::http_allowed(&url)?;
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
    // 新修订必须声明总窗口、请求超时和能力来源；缺字段按契约在解码层拒绝。
    let (context_window, input_limit, output_limit) = (
        value["context_window"].as_u64(),
        value["input_limit"].as_u64().unwrap_or(0),
        value["output_limit"].as_u64().unwrap_or(0),
    );
    if let (Some(context), input, output) = (context_window, input_limit, output_limit) {
        capacity::plan(context, input, output).map_err(|_| {
            Error::new("model_capacity_invalid")
                .with_message(capacity::range_message(context, input, output))
        })?;
    }
    let levels = value["thinking_levels"]
        .as_array()
        .ok_or(Error::new("invalid_input"))?;
    if !levels.contains(&value["default_thinking"])
        || value["output_limit"].as_u64() > value["input_limit"].as_u64()
        || (value["reasoning_supported"] != true && levels.iter().any(|level| level != "off"))
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
        let levels = model["thinking_levels"]
            .as_array()
            .ok_or(Error::new("invalid_input"))?;
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

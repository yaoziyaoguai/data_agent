use crate::{
    contracts::{
        self,
        generated::{ModelProfile, ModelSelection},
    },
    types::{Error, Result},
};
use serde_json::{Value, json};

pub fn model_catalog(profile: Option<&ModelProfile>) -> Value {
    let Some(profile) = profile else {
        return json!({"default_selection":null,"models":[]});
    };
    let value = serde_json::to_value(profile).expect("model profile serializes");
    if value["toolset"] != "data" {
        return json!({"default_selection":null,"models":[]});
    }
    let thinking = |levels: &[(&str, &str)]| {
        levels
            .iter()
            .map(|(value, label)| json!({"value":value,"label":label}))
            .collect::<Vec<_>>()
    };
    json!({
        "default_selection": {"model_id":profile.model_id,"thinking_level":value["thinking_level"].as_str().unwrap_or("off")},
        "models":[
            {"id":"deepseek-flash","label":"DeepSeek Flash","thinking_options":thinking(&[("off","关闭"),("low","轻度"),("high","深度"),("max","最高")])},
            {"id":"deepseek-v4-pro","label":"DeepSeek Pro","thinking_options":thinking(&[("off","关闭"),("high","深度"),("max","最高")])}
        ]
    })
}

pub fn selected_profile(
    profile: Option<&ModelProfile>,
    selection: Option<&ModelSelection>,
) -> Result<Option<ModelProfile>> {
    let Some(profile) = profile else {
        return if selection.is_some() {
            Err(Error::new("invalid_input"))
        } else {
            Ok(None)
        };
    };
    let mut value = serde_json::to_value(profile).map_err(|_| Error::new("invalid_input"))?;
    if let Some(selection) = selection {
        if value["toolset"] != "data" {
            return Err(Error::new("invalid_input"));
        }
        let choice = serde_json::to_value(selection).map_err(|_| Error::new("invalid_input"))?;
        contracts::validate("ModelSelection", &choice)?;
        value["model_id"] = choice["model_id"].clone();
        value["thinking_level"] = choice["thinking_level"].clone();
        value["price_version"] = json!(match selection.model_id.as_str() {
            "deepseek-flash" => "2026-10-04-peak-usd",
            "deepseek-v4-pro" => "2026-10-05-pro-peak-usd",
            _ => return Err(Error::new("invalid_input")),
        });
    }
    // 只替换受支持的模型和档位；原试验、请求限额及用量上界原样保留。
    Ok(Some(contracts::decode("ModelProfile", value)?))
}

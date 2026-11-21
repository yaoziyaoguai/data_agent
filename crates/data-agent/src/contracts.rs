use crate::types::{Error, Result};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{LazyLock, OnceLock},
};

#[allow(clippy::all)]
#[path = "../../../packages/contracts/generated/boundary.rs"]
pub mod generated;

static SCHEMA: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../packages/contracts/schema.json"))
        .expect("contract JSON")
});

pub fn schema_definition(name: &str) -> Result<&'static Value> {
    SCHEMA["$defs"]
        .get(name)
        .filter(|v| v.is_object())
        .ok_or(Error::new("invalid_input"))
}

static VALIDATORS: LazyLock<HashMap<String, OnceLock<jsonschema::Validator>>> =
    LazyLock::new(|| {
        SCHEMA["$defs"]
            .as_object()
            .expect("contract definitions")
            .keys()
            .map(|name| (name.clone(), OnceLock::new()))
            .collect()
    });

fn compile(name: &str) -> jsonschema::Validator {
    let schema = serde_json::json!({"$schema":SCHEMA["$schema"],"$defs":SCHEMA["$defs"],"$ref":format!("#/$defs/{name}")});
    jsonschema::options()
        .should_validate_formats(true)
        .build(&schema)
        .expect("valid contract")
}

// API 在监听前预热全部入口。Worker 只编译实际使用的契约。
pub fn initialize_validators() {
    for (name, slot) in VALIDATORS.iter() {
        slot.get_or_init(|| compile(name));
    }
}

pub fn validate(name: &str, value: &Value) -> Result<()> {
    if !VALIDATORS
        .get(name)
        .is_some_and(|slot| slot.get_or_init(|| compile(name)).is_valid(value))
    {
        return Err(Error::new("invalid_input"));
    }
    Ok(())
}

pub fn decode<T: DeserializeOwned>(name: &str, value: Value) -> Result<T> {
    validate(name, &value)?;
    serde_json::from_value(value).map_err(|_| Error::new("invalid_input"))
}

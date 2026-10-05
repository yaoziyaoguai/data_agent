use crate::types::{Error, Result};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::{collections::HashMap, sync::LazyLock};

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

static VALIDATORS: LazyLock<HashMap<String, jsonschema::Validator>> = LazyLock::new(|| {
    let source = &*SCHEMA;
    source["$defs"].as_object().expect("contract definitions").keys().map(|name| {
        let schema = serde_json::json!({"$schema":source["$schema"],"$defs":source["$defs"],"$ref":format!("#/$defs/{name}")});
        (name.clone(), jsonschema::validator_for(&schema).expect("valid contract"))
    }).collect()
});

pub fn validate(name: &str, value: &Value) -> Result<()> {
    if !VALIDATORS.get(name).is_some_and(|v| v.is_valid(value)) {
        return Err(Error::new("invalid_input"));
    }
    Ok(())
}

pub fn decode<T: DeserializeOwned>(name: &str, value: Value) -> Result<T> {
    validate(name, &value)?;
    serde_json::from_value(value).map_err(|_| Error::new("invalid_input"))
}

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

type Validator = std::result::Result<jsonschema::Validator, String>;

struct Contracts {
    schema: Value,
    validators: HashMap<String, OnceLock<Validator>>,
}

impl Contracts {
    fn load() -> std::result::Result<Self, String> {
        let schema: Value =
            serde_json::from_str(include_str!("../../../packages/contracts/schema.json"))
                .map_err(|error| error.to_string())?;
        let validators = schema["$defs"]
            .as_object()
            .ok_or_else(|| "Contract definitions must be an object".to_owned())?
            .keys()
            .map(|name| (name.clone(), OnceLock::new()))
            .collect();
        Ok(Self { schema, validators })
    }

    fn validator(&self, name: &str) -> Result<&jsonschema::Validator> {
        let slot = self
            .validators
            .get(name)
            .ok_or(Error::new("invalid_input"))?;
        slot.get_or_init(|| {
            let schema = serde_json::json!({
                "$schema": self.schema["$schema"],
                "$defs": self.schema["$defs"],
                "$ref": format!("#/$defs/{name}"),
            });
            jsonschema::options()
                .should_validate_formats(true)
                .build(&schema)
                .map_err(|error| error.to_string())
        })
        .as_ref()
        .map_err(|error| {
            Error::new("unavailable").with_message(format!("Invalid contract {name}: {error}"))
        })
    }
}

static CONTRACTS: LazyLock<std::result::Result<Contracts, String>> = LazyLock::new(Contracts::load);

fn contracts() -> Result<&'static Contracts> {
    CONTRACTS
        .as_ref()
        .map_err(|error| Error::new("unavailable").with_message(error.clone()))
}

pub fn schema_definition(name: &str) -> Result<&'static Value> {
    contracts()?.schema["$defs"]
        .get(name)
        .ok_or(Error::new("invalid_input"))
}

// API 在监听前预热全部入口。Worker 只编译实际使用的契约。
pub fn initialize_validators() -> Result<()> {
    let contracts = contracts()?;
    for name in contracts.validators.keys() {
        contracts.validator(name)?;
    }
    Ok(())
}

pub fn validate(name: &str, value: &Value) -> Result<()> {
    if !contracts()?.validator(name)?.is_valid(value) {
        return Err(Error::new("invalid_input"));
    }
    Ok(())
}

pub fn decode_ref<T: DeserializeOwned>(name: &str, value: &Value) -> Result<T> {
    validate(name, value)?;
    T::deserialize(value).map_err(|_| Error::new("invalid_input"))
}

pub fn decode<T: DeserializeOwned>(name: &str, value: Value) -> Result<T> {
    validate(name, &value)?;
    serde_json::from_value(value).map_err(|_| Error::new("invalid_input"))
}

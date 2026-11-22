use axum::{
    Json,
    extract::{FromRequest, FromRequestParts, Query, Request},
    http::request::Parts,
    response::{IntoResponse, Response},
};
use data_agent::contracts;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::collections::HashMap;

pub(crate) trait RequestContract: DeserializeOwned {
    const SCHEMA: &'static str;
}

pub(crate) struct ContractBody<T> {
    pub value: T,
}

impl<S, T> FromRequest<S> for ContractBody<T>
where
    S: Send + Sync,
    T: RequestContract,
{
    type Rejection = Response;

    async fn from_request(request: Request, state: &S) -> Result<Self, Self::Rejection> {
        let Json(input) = Json::<Value>::from_request(request, state)
            .await
            .map_err(IntoResponse::into_response)?;
        let value = contracts::decode(T::SCHEMA, input)
            .map_err(|error| crate::routes::failure(error).into_response())?;
        Ok(Self { value })
    }
}

/// 需要原始字段状态的命令沿用既有幂等指纹。
pub(crate) struct RawContractBody<T> {
    pub value: T,
    pub raw: Value,
}

impl<S, T> FromRequest<S> for RawContractBody<T>
where
    S: Send + Sync,
    T: RequestContract,
{
    type Rejection = Response;

    async fn from_request(request: Request, state: &S) -> Result<Self, Self::Rejection> {
        let Json(raw) = Json::<Value>::from_request(request, state)
            .await
            .map_err(IntoResponse::into_response)?;
        let value = contracts::decode_ref(T::SCHEMA, &raw)
            .map_err(|error| crate::routes::failure(error).into_response())?;
        Ok(Self { value, raw })
    }
}

pub(crate) struct ContractQuery<T>(pub T);

impl<S, T> FromRequestParts<S> for ContractQuery<T>
where
    S: Send + Sync,
    T: RequestContract,
{
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let Query(query) = Query::<HashMap<String, String>>::from_request_parts(parts, state)
            .await
            .map_err(IntoResponse::into_response)?;
        let raw = Value::Object(
            query
                .into_iter()
                .map(|(key, value)| (key, Value::String(value)))
                .collect(),
        );
        contracts::decode(T::SCHEMA, raw)
            .map(Self)
            .map_err(|error| crate::routes::failure(error).into_response())
    }
}

macro_rules! request_contracts {
    ($($name:ident),+ $(,)?) => {
        $(
            impl $crate::request::RequestContract for data_agent::contracts::generated::$name {
                const SCHEMA: &'static str = stringify!($name);
            }
        )+
    };
}

pub(crate) use request_contracts;

use crate::State;
use axum::{
    Json,
    extract::{FromRequest, FromRequestParts, Query, Request},
    http::{HeaderMap, request::Parts},
    response::{IntoResponse, Response},
};
use data_agent::{contracts, types::Error};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::collections::HashMap;

fn precheck_auth(state: &State, path: &str, headers: &HeaderMap) -> Result<(), Error> {
    if path.starts_with("/internal/") {
        if crate::routes::bearer(headers) != Some(state.internal_token.as_str()) {
            return Err(Error::new("unauthenticated"));
        }
        return Ok(());
    }
    if let Some(token) = crate::routes::bearer(headers) {
        state.identities.resolve(token).map(|_| ())
    } else if crate::routes::session_cookie(headers).is_some() {
        Ok(())
    } else {
        Err(Error::new("unauthenticated"))
    }
}

pub(crate) trait RequestContract: DeserializeOwned {
    const SCHEMA: &'static str;
}

pub(crate) struct ContractBody<T> {
    pub value: T,
}

impl<T> FromRequest<State> for ContractBody<T>
where
    T: RequestContract,
{
    type Rejection = Response;

    async fn from_request(request: Request, state: &State) -> Result<Self, Self::Rejection> {
        precheck_auth(state, request.uri().path(), request.headers())
            .map_err(|error| crate::routes::failure(error).into_response())?;
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

impl<T> FromRequest<State> for RawContractBody<T>
where
    T: RequestContract,
{
    type Rejection = Response;

    async fn from_request(request: Request, state: &State) -> Result<Self, Self::Rejection> {
        precheck_auth(state, request.uri().path(), request.headers())
            .map_err(|error| crate::routes::failure(error).into_response())?;
        let Json(raw) = Json::<Value>::from_request(request, state)
            .await
            .map_err(IntoResponse::into_response)?;
        let value = contracts::decode_ref(T::SCHEMA, &raw)
            .map_err(|error| crate::routes::failure(error).into_response())?;
        Ok(Self { value, raw })
    }
}

pub(crate) struct ContractQuery<T>(pub T);

impl<T> FromRequestParts<State> for ContractQuery<T>
where
    T: RequestContract,
{
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, state: &State) -> Result<Self, Self::Rejection> {
        precheck_auth(state, parts.uri.path(), &parts.headers)
            .map_err(|error| crate::routes::failure(error).into_response())?;
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

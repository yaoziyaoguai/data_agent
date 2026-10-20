use crate::{
    State,
    routes::{failure, success, user},
};
use axum::{
    Json,
    extract::{Path, State as AxumState},
    http::{HeaderMap, StatusCode},
};
use data_agent::{
    contracts,
    use_cases::{conversation_models, model_configuration},
};
use serde_json::Value;
type Response = Result<Json<Value>, (StatusCode, Json<Value>)>;

pub async fn catalog(AxumState(state): AxumState<State>, headers: HeaderMap) -> Response {
    let context = user(&state, &headers).map_err(failure)?;
    let value = model_configuration::catalog(&state.pool, &context, state.model_profile.as_ref())
        .await
        .map_err(failure)?;
    success("ModelCatalog", value)
}
pub async fn read(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(cid): Path<String>,
) -> Response {
    let context = user(&state, &headers).map_err(failure)?;
    let value = conversation_models::read(&state.pool, &context, &cid)
        .await
        .map_err(failure)?;
    success("ConversationModelSelection", value)
}
pub async fn save(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(cid): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let context = user(&state, &headers).map_err(failure)?;
    let input = contracts::decode("SaveModelSelection", body).map_err(failure)?;
    let value = conversation_models::save(
        &state.pool,
        &context,
        &cid,
        input,
        state.model_profile.as_ref(),
    )
    .await
    .map_err(failure)?;
    success("ConversationModelSelection", value)
}

pub async fn access(AxumState(state): AxumState<State>, headers: HeaderMap) -> Response {
    let context = user(&state, &headers).map_err(failure)?;
    success(
        "ModelConfigurationAccess",
        model_configuration::access(&context).map_err(failure)?,
    )
}
pub async fn configuration(AxumState(state): AxumState<State>, headers: HeaderMap) -> Response {
    let context = user(&state, &headers).map_err(failure)?;
    success(
        "ModelConfiguration",
        model_configuration::read(&state.pool, &context, state.model_profile.as_ref())
            .await
            .map_err(failure)?,
    )
}
async fn save_configuration(state: State, headers: HeaderMap, body: Value, kind: &str) -> Response {
    let context = user(&state, &headers).map_err(failure)?;
    success(
        "ModelConfiguration",
        model_configuration::save(
            &state.pool,
            &context,
            state.model_profile.as_ref(),
            kind,
            body,
        )
        .await
        .map_err(failure)?,
    )
}
pub async fn service(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    save_configuration(state, headers, body, "service").await
}
pub async fn definition(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    save_configuration(state, headers, body, "model").await
}
pub async fn default_model(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    save_configuration(state, headers, body, "default").await
}
pub async fn connection(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let context = crate::routes::internal(&state, &headers, &body)
        .await
        .map_err(failure)?;
    let input = contracts::decode::<data_agent::contracts::generated::ReadModelConnection>(
        "ReadModelConnection",
        body,
    )
    .map_err(failure)?;
    success(
        "ModelConnection",
        model_configuration::connection(&state.pool, &context, input)
            .await
            .map_err(failure)?,
    )
}

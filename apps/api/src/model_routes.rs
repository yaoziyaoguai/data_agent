use crate::{
    State,
    routes::{failure, success, user},
};
use axum::{
    Json,
    extract::{Path, State as AxumState},
    http::{HeaderMap, StatusCode},
};
use data_agent::{contracts, modules::runtime, use_cases::conversation_models};
use serde_json::Value;
type Response = Result<Json<Value>, (StatusCode, Json<Value>)>;

pub async fn catalog(AxumState(state): AxumState<State>, headers: HeaderMap) -> Response {
    user(&state, &headers).map_err(failure)?;
    success(
        "ModelCatalog",
        runtime::model_catalog(state.model_profile.as_ref()),
    )
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

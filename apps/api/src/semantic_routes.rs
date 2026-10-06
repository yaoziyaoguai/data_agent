use crate::{
    State,
    routes::{failure, success, user},
};
use axum::{
    Json,
    extract::{Path, Query, State as AxumState},
    http::HeaderMap,
};
use data_agent::{modules::access, use_cases::semantic_governance};
use serde_json::{Value, json};
use std::collections::HashMap;
type ResponseResult = Result<Json<Value>, (axum::http::StatusCode, Json<Value>)>;
pub async fn access(AxumState(state): AxumState<State>, headers: HeaderMap) -> ResponseResult {
    let ctx = user(&state, &headers).map_err(failure)?;
    success(
        "SemanticAccess",
        json!({"can_admin":access::is_super_maintainer(&ctx).map_err(failure)?}),
    )
}
pub async fn assign(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<Value>,
) -> ResponseResult {
    let ctx = user(&state, &headers).map_err(failure)?;
    success(
        "SemanticMaintenance",
        semantic_governance::assign(&state.pool, &ctx, &id, input)
            .await
            .map_err(failure)?,
    )
}
pub async fn draft(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> ResponseResult {
    let ctx = user(&state, &headers).map_err(failure)?;
    success(
        "Proposal",
        semantic_governance::draft(&state.pool, &ctx, input)
            .await
            .map_err(failure)?,
    )
}
pub async fn list(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> ResponseResult {
    let ctx = user(&state, &headers).map_err(failure)?;
    if query.keys().any(|k| k != "after_id") {
        return Err(failure(data_agent::types::Error::new("invalid_input")));
    }
    success(
        "SemanticCorrectionList",
        semantic_governance::list(&state.pool, &ctx, query.get("after_id").map(String::as_str))
            .await
            .map_err(failure)?,
    )
}
pub async fn read(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ResponseResult {
    let ctx = user(&state, &headers).map_err(failure)?;
    success(
        "SemanticCorrection",
        semantic_governance::read(&state.pool, &ctx, &id)
            .await
            .map_err(failure)?,
    )
}
pub async fn submit(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> ResponseResult {
    let ctx = user(&state, &headers).map_err(failure)?;
    success(
        "SemanticCorrection",
        semantic_governance::change(&state.pool, &ctx, None, "submit", input)
            .await
            .map_err(failure)?,
    )
}
pub async fn revise(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<Value>,
) -> ResponseResult {
    let ctx = user(&state, &headers).map_err(failure)?;
    success(
        "SemanticCorrection",
        semantic_governance::change(&state.pool, &ctx, Some(&id), "revise", input)
            .await
            .map_err(failure)?,
    )
}
pub async fn action(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path((id, action)): Path<(String, String)>,
    Json(input): Json<Value>,
) -> ResponseResult {
    let ctx = user(&state, &headers).map_err(failure)?;
    if !matches!(action.as_str(), "review" | "apply") {
        return Err(failure(data_agent::types::Error::new("invalid_input")));
    }
    success(
        "SemanticCorrection",
        semantic_governance::change(&state.pool, &ctx, Some(&id), &action, input)
            .await
            .map_err(failure)?,
    )
}

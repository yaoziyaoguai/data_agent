use crate::{
    State,
    routes::{failure, success, user},
};
use axum::{
    Json,
    extract::{Path, Query, State as AxumState},
    http::{HeaderMap, StatusCode},
};
use data_agent::use_cases;
use serde_json::{Value, json};
use std::collections::HashMap;
type ResponseResult = Result<Json<Value>, (StatusCode, Json<Value>)>;

pub async fn list(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> ResponseResult {
    let ctx = user(&state, &headers).map_err(failure)?;
    data_agent::contracts::validate("AssetPageQuery", &json!(query)).map_err(failure)?;
    let value = use_cases::skill_drafts::list(
        &state.pool,
        &ctx,
        query.get("after_id").map_or("", String::as_str),
    )
    .await
    .map_err(failure)?;
    success("SkillDraftList", value)
}

pub async fn read(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(draft): Path<String>,
) -> ResponseResult {
    let ctx = user(&state, &headers).map_err(failure)?;
    let value = use_cases::skill_drafts::read(&state.pool, &ctx, &draft)
        .await
        .map_err(failure)?;
    success("SkillDraft", value)
}

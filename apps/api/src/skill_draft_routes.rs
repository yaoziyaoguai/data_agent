use crate::routes::ResponseResult;
use crate::{
    State,
    routes::{failure, respond, semantic_user},
};
use axum::{
    extract::{Path, Query, State as AxumState},
    http::HeaderMap,
};
use data_agent::use_cases;
use serde_json::json;
use std::collections::HashMap;

pub async fn list(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> ResponseResult {
    data_agent::contracts::validate("AssetPageQuery", &json!(query)).map_err(failure)?;
    let ctx = semantic_user(&state, &headers).await.map_err(failure)?;
    let value = use_cases::skill_drafts::list(
        &state.pool,
        &ctx,
        query.get("after_id").map_or("", String::as_str),
    )
    .await
    .map_err(failure)?;
    respond!(SkillDraftList, value)
}

pub async fn read(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(draft): Path<String>,
) -> ResponseResult {
    let ctx = semantic_user(&state, &headers).await.map_err(failure)?;
    let value = use_cases::skill_drafts::read(&state.pool, &ctx, &draft)
        .await
        .map_err(failure)?;
    respond!(SkillDraft, value)
}

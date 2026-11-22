use crate::{
    State,
    routes::{ResponseResult, failure, respond, semantic_user},
};
use axum::{
    extract::{Path, Query, State as AxumState},
    http::HeaderMap,
};
use data_agent::use_cases::knowledge_impact;
use serde_json::{Value, json};
use std::collections::HashMap;

pub async fn read(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(object): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> ResponseResult {
    let ctx = semantic_user(&state, &headers).await.map_err(failure)?;
    let input = query
        .into_iter()
        .map(|(key, value)| (key, json!(value)))
        .collect();
    respond!(
        MaintenanceImpact,
        knowledge_impact::read(&state.pool, &ctx, &object, Value::Object(input))
            .await
            .map_err(failure)?,
    )
}

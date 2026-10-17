use crate::{
    State,
    routes::{failure, success, user},
};
use axum::{
    Json,
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
) -> Result<Json<Value>, (axum::http::StatusCode, Json<Value>)> {
    let ctx = user(&state, &headers).map_err(failure)?;
    let input = query
        .into_iter()
        .map(|(key, value)| (key, json!(value)))
        .collect();
    success(
        "MaintenanceImpact",
        knowledge_impact::read(&state.pool, &ctx, &object, Value::Object(input))
            .await
            .map_err(failure)?,
    )
}

use crate::{
    State,
    routes::{failure, internal, success, user},
};
use axum::{
    Json,
    extract::{Path, Query, State as AxumState},
    http::{HeaderMap, StatusCode, header},
    response::IntoResponse,
};
use data_agent::{
    types::{Error, epoch},
    use_cases,
};
use serde_json::{Value, json};
use std::collections::HashMap;
type ResponseResult = Result<Json<Value>, (StatusCode, Json<Value>)>;
pub async fn knowledge(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> ResponseResult {
    let ctx = user(&state, &headers).map_err(failure)?;
    data_agent::contracts::validate("KnowledgeListQuery", &json!(query)).map_err(failure)?;
    let v = use_cases::knowledge::list(
        &state.pool,
        &ctx,
        query.get("q").map(String::as_str),
        query.get("after_id").map(String::as_str),
        query.get("related_id").map(String::as_str),
        query.get("directory").map(String::as_str),
        query.get("state").map(String::as_str),
    )
    .await
    .map_err(failure)?;
    success("KnowledgeList", v)
}
pub async fn read_knowledge(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(object): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> ResponseResult {
    let ctx = user(&state, &headers).map_err(failure)?;
    let version = query
        .get("version")
        .map(|v| epoch(v))
        .transpose()
        .map_err(failure)?;
    success(
        "KnowledgeObject",
        use_cases::knowledge::read(&state.pool, &ctx, &object, version)
            .await
            .map_err(failure)?,
    )
}
pub async fn create_knowledge(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> ResponseResult {
    let ctx = user(&state, &headers).map_err(failure)?;
    success(
        "KnowledgeObject",
        use_cases::knowledge::edit(&state.pool, &ctx, None, "create", input)
            .await
            .map_err(failure)?,
    )
}
pub async fn edit_knowledge(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(object): Path<String>,
    Json(input): Json<Value>,
) -> ResponseResult {
    let ctx = user(&state, &headers).map_err(failure)?;
    success(
        "KnowledgeObject",
        use_cases::knowledge::edit(&state.pool, &ctx, Some(&object), "edit", input)
            .await
            .map_err(failure)?,
    )
}
pub async fn knowledge_action(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path((object, action)): Path<(String, String)>,
    Json(input): Json<Value>,
) -> ResponseResult {
    let ctx = user(&state, &headers).map_err(failure)?;
    let action = match action.as_str() {
        "disable" => "disabled",
        "enable" => "enabled",
        "delete" => "deleted",
        "reanalyze" => "reanalyze",
        _ => return Err(failure(Error::new("invalid_input"))),
    };
    success(
        "KnowledgeObject",
        use_cases::knowledge::edit(&state.pool, &ctx, Some(&object), action, input)
            .await
            .map_err(failure)?,
    )
}
pub async fn analysis_preference(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(table): Path<String>,
    Json(input): Json<Value>,
) -> ResponseResult {
    let ctx = user(&state, &headers).map_err(failure)?;
    success(
        "TableAnalysisPreference",
        use_cases::knowledge::set_table_analysis_preference(&state.pool, &ctx, &table, input)
            .await
            .map_err(failure)?,
    )
}
pub async fn source(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(source): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> ResponseResult {
    let ctx = user(&state, &headers).map_err(failure)?;
    let v = if let Some(v) = query.get("version") {
        use_cases::knowledge::source(&state.pool, &ctx, &source, epoch(v).map_err(failure)?).await
    } else {
        use_cases::knowledge::source_head(&state.pool, &ctx, &source).await
    }
    .map_err(failure)?;
    success("SourceDocument", v)
}
pub async fn sync(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> ResponseResult {
    let ctx = user(&state, &headers).map_err(failure)?;
    data_agent::contracts::validate("CreateConversation", &input).map_err(failure)?;
    success(
        "MutationReceipt",
        use_cases::knowledge::sync(
            &state.pool,
            &ctx,
            input["operation_id"].as_str().unwrap_or(""),
        )
        .await
        .map_err(failure)?,
    )
}
pub async fn rebuild_index(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> ResponseResult {
    let ctx = user(&state, &headers).map_err(failure)?;
    success(
        "MutationReceipt",
        use_cases::knowledge::rebuild_index(&state.pool, &ctx, &input)
            .await
            .map_err(failure)?,
    )
}
pub async fn assets(AxumState(state): AxumState<State>, headers: HeaderMap) -> ResponseResult {
    let ctx = user(&state, &headers).map_err(failure)?;
    success(
        "AssetList",
        use_cases::personal_assets::list(&state.pool, &ctx)
            .await
            .map_err(failure)?,
    )
}
pub async fn save_asset(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> ResponseResult {
    let ctx = user(&state, &headers).map_err(failure)?;
    success(
        "Asset",
        use_cases::personal_assets::save(&state.pool, &ctx, input)
            .await
            .map_err(failure)?,
    )
}
pub async fn asset_action(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path((asset, action)): Path<(String, String)>,
    Json(input): Json<Value>,
) -> ResponseResult {
    let ctx = user(&state, &headers).map_err(failure)?;
    let target = match action.as_str() {
        "disable" => "disabled",
        "enable" => "enabled",
        "delete" => "deleted",
        _ => return Err(failure(Error::new("invalid_input"))),
    };
    success(
        "Asset",
        use_cases::personal_assets::state(&state.pool, &ctx, &asset, input, target)
            .await
            .map_err(failure)?,
    )
}
pub async fn select_skill(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(cid): Path<String>,
    Json(input): Json<Value>,
) -> ResponseResult {
    let ctx = user(&state, &headers).map_err(failure)?;
    success(
        "Asset",
        use_cases::personal_assets::select(&state.pool, &ctx, &cid, input)
            .await
            .map_err(failure)?,
    )
}
pub async fn queries(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(cid): Path<String>,
) -> ResponseResult {
    let ctx = user(&state, &headers).map_err(failure)?;
    success(
        "QueryList",
        use_cases::query_workflow::list(&state.pool, &ctx, &cid)
            .await
            .map_err(failure)?,
    )
}
pub async fn query(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(qid): Path<String>,
) -> ResponseResult {
    let ctx = user(&state, &headers).map_err(failure)?;
    success(
        "QueryView",
        use_cases::query_workflow::read(&state.pool, &ctx, &qid)
            .await
            .map_err(failure)?,
    )
}
pub async fn confirm(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(qid): Path<String>,
    Json(input): Json<Value>,
) -> ResponseResult {
    let ctx = user(&state, &headers).map_err(failure)?;
    success(
        "QueryView",
        use_cases::query_workflow::confirm(&state.pool, &ctx, &qid, input)
            .await
            .map_err(failure)?,
    )
}
pub async fn cancel(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(qid): Path<String>,
    Json(input): Json<Value>,
) -> ResponseResult {
    let ctx = user(&state, &headers).map_err(failure)?;
    data_agent::contracts::validate("CreateConversation", &input).map_err(failure)?;
    success(
        "QueryView",
        use_cases::query_workflow::cancel(&state.pool, &ctx, &qid)
            .await
            .map_err(failure)?,
    )
}
pub async fn results(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(qid): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> ResponseResult {
    let ctx = user(&state, &headers).map_err(failure)?;
    success(
        "QueryResults",
        use_cases::query_workflow::results(
            &state.pool,
            &ctx,
            &qid,
            query.get("cursor").map(String::as_str),
        )
        .await
        .map_err(failure)?,
    )
}
pub async fn export(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(qid): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<Value>)> {
    let ctx = user(&state, &headers).map_err(failure)?;
    let mut cursor = None;
    let mut lines = Vec::new();
    let escaped = |value: &Value, numeric: bool| {
        let value = value.as_str().unwrap_or("");
        let value = if !numeric && value.starts_with(['=', '+', '-', '@', '\t', '\r']) {
            format!("'{value}")
        } else {
            value.into()
        };
        format!("\"{}\"", value.replace('"', "\"\""))
    };
    loop {
        let r = use_cases::query_workflow::results(&state.pool, &ctx, &qid, cursor.as_deref())
            .await
            .map_err(failure)?;
        if lines.is_empty() {
            lines.push(
                r["columns"]
                    .as_array()
                    .unwrap_or(&Vec::new())
                    .iter()
                    .map(|v| escaped(&v["name"], false))
                    .collect::<Vec<_>>()
                    .join(","),
            );
        }
        for row in r["rows"].as_array().unwrap_or(&Vec::new()) {
            lines.push(
                row.as_array()
                    .unwrap_or(&Vec::new())
                    .iter()
                    .enumerate()
                    .map(|(i, v)| {
                        escaped(
                            v,
                            matches!(r["columns"][i]["type"].as_str(), Some("integer" | "number")),
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(","),
            );
        }
        cursor = r["next_cursor"].as_str().map(str::to_string);
        if cursor.is_none() {
            break;
        }
    }
    Ok((
        [
            (header::CONTENT_TYPE, "text/csv; charset=utf-8".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"query-{qid}.csv\""),
            ),
        ],
        format!("\u{feff}{}\r\n", lines.join("\r\n")),
    ))
}
pub async fn register(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> ResponseResult {
    let ctx = internal(&state, &headers, &input).await.map_err(failure)?;
    success(
        "OperationReceipt",
        use_cases::data_tools::register(&state.pool, &ctx, input)
            .await
            .map_err(failure)?,
    )
}
pub async fn tool(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> ResponseResult {
    let ctx = internal(&state, &headers, &input).await.map_err(failure)?;
    success(
        "DataToolOutcome",
        use_cases::data_tools::invoke(&state.pool, &ctx, input)
            .await
            .map_err(failure)?,
    )
}
pub async fn tool_rejection(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> ResponseResult {
    let ctx = internal(&state, &headers, &input).await.map_err(failure)?;
    success(
        "DataToolOutcome",
        use_cases::data_tools::recorded_rejection(&state.pool, &ctx, input)
            .await
            .map_err(failure)?,
    )
}
pub async fn proposals(AxumState(state): AxumState<State>, headers: HeaderMap) -> ResponseResult {
    let ctx = user(&state, &headers).map_err(failure)?;
    success(
        "ProposalList",
        use_cases::knowledge::proposals(&state.pool, &ctx)
            .await
            .map_err(failure)?,
    )
}
pub async fn apply_proposal(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<Value>,
) -> ResponseResult {
    let ctx = user(&state, &headers).map_err(failure)?;
    success(
        "KnowledgeObject",
        use_cases::knowledge::edit(&state.pool, &ctx, Some(&id), "apply-proposal", input)
            .await
            .map_err(failure)?,
    )
}

pub async fn cancel_task(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path((cid, task)): Path<(String, String)>,
    Json(input): Json<Value>,
) -> ResponseResult {
    let ctx = user(&state, &headers).map_err(failure)?;
    success(
        "MutationReceipt",
        use_cases::conversation_lifecycle::cancel_task(&state.pool, &ctx, &cid, &task, input)
            .await
            .map_err(failure)?,
    )
}
pub async fn withdraw(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path((cid, message)): Path<(String, String)>,
    Json(input): Json<Value>,
) -> ResponseResult {
    let ctx = user(&state, &headers).map_err(failure)?;
    success(
        "MutationReceipt",
        use_cases::conversation_lifecycle::withdraw(&state.pool, &ctx, &cid, &message, input)
            .await
            .map_err(failure)?,
    )
}
pub async fn delete_conversation(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(cid): Path<String>,
    Json(input): Json<Value>,
) -> ResponseResult {
    let ctx = user(&state, &headers).map_err(failure)?;
    success(
        "MutationReceipt",
        use_cases::conversation_lifecycle::delete(&state.pool, &ctx, &cid, input)
            .await
            .map_err(failure)?,
    )
}

pub async fn memory_model_call(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> ResponseResult {
    if crate::routes::bearer(&headers) != Some(state.internal_token.as_str()) {
        return Err(failure(Error::new("unauthenticated")));
    }
    success(
        "ModelCallReceipt",
        use_cases::personal_memory::model_call(&state.pool, input)
            .await
            .map_err(failure)?,
    )
}

pub async fn publish_skill(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(asset): Path<String>,
    Json(input): Json<Value>,
) -> ResponseResult {
    let ctx = user(&state, &headers).map_err(failure)?;
    success(
        "Asset",
        use_cases::personal_assets::publish(&state.pool, &ctx, &asset, input)
            .await
            .map_err(failure)?,
    )
}
pub async fn skill_selections(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(cid): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> ResponseResult {
    let ctx = user(&state, &headers).map_err(failure)?;
    data_agent::contracts::validate("AssetPageQuery", &json!(query)).map_err(failure)?;
    success(
        "ConversationSkillSelections",
        use_cases::personal_assets::selections(
            &state.pool,
            &ctx,
            &cid,
            query.get("after_id").map(String::as_str).unwrap_or(""),
        )
        .await
        .map_err(failure)?,
    )
}
pub async fn skill_suggestions(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(asset): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> ResponseResult {
    let ctx = user(&state, &headers).map_err(failure)?;
    data_agent::contracts::validate("AssetPageQuery", &json!(query)).map_err(failure)?;
    success(
        "SkillSuggestionList",
        use_cases::personal_assets::suggestions(
            &state.pool,
            &ctx,
            &asset,
            query.get("after_id").map(String::as_str).unwrap_or(""),
        )
        .await
        .map_err(failure)?,
    )
}
pub async fn suggest_skill(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(asset): Path<String>,
    Json(input): Json<Value>,
) -> ResponseResult {
    let ctx = user(&state, &headers).map_err(failure)?;
    success(
        "SkillSuggestion",
        use_cases::personal_assets::suggest(&state.pool, &ctx, &asset, input)
            .await
            .map_err(failure)?,
    )
}
pub async fn review_skill_suggestion(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path((asset, suggestion)): Path<(String, String)>,
    Json(input): Json<Value>,
) -> ResponseResult {
    let ctx = user(&state, &headers).map_err(failure)?;
    success(
        "SkillSuggestion",
        use_cases::personal_assets::review_suggestion(
            &state.pool,
            &ctx,
            &asset,
            &suggestion,
            input,
        )
        .await
        .map_err(failure)?,
    )
}

use crate::State;
use axum::{
    Json,
    extract::{Path, Query, State as AxumState},
    http::{HeaderMap, StatusCode, header},
    response::IntoResponse,
};
use data_agent::{
    contracts::{self, generated::*},
    types::{AccessContext, Error, id},
    use_cases,
};
use serde_json::{Value, json};
use std::collections::HashMap;
type ResponseResult = Result<Json<Value>, (StatusCode, Json<Value>)>;
pub(crate) fn failure(error: Error) -> (StatusCode, Json<Value>) {
    let request_id = id();
    eprintln!(
        "request_rejected request_id={} code={}",
        request_id, error.code
    );
    let status = match error.code {
        "invalid_input" | "skill_line_too_long" => StatusCode::BAD_REQUEST,
        "forbidden" => StatusCode::FORBIDDEN,
        "unauthenticated" => StatusCode::UNAUTHORIZED,
        "not_available" => StatusCode::NOT_FOUND,
        "unavailable"
        | "source_unavailable"
        | "source_interrupted"
        | "vector_unconfigured"
        | "vector_unavailable"
        | "embedding_unavailable" => StatusCode::SERVICE_UNAVAILABLE,
        _ => StatusCode::CONFLICT,
    };
    (
        status,
        Json(
            json!({"code":error.code,"message":error.code,"request_id":request_id,"retryable":error.code=="unavailable"}),
        ),
    )
}
pub(crate) fn success(schema: &str, value: Value) -> ResponseResult {
    contracts::validate(schema, &value).map_err(failure)?;
    Ok(Json(value))
}
pub(crate) fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}
pub(crate) fn user(state: &State, headers: &HeaderMap) -> Result<AccessContext, Error> {
    let token = bearer(headers)
        .or_else(|| {
            headers
                .get(header::COOKIE)?
                .to_str()
                .ok()?
                .split(';')
                .find_map(|p| p.trim().strip_prefix("data_agent_session="))
        })
        .ok_or(Error::new("unauthenticated"))?;
    state.identities.resolve(token)
}
pub(crate) async fn internal(
    state: &State,
    headers: &HeaderMap,
    value: &Value,
) -> Result<AccessContext, Error> {
    if bearer(headers) != Some(state.internal_token.as_str()) {
        return Err(Error::new("unauthenticated"));
    }
    let run = value["run_id"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?;
    use_cases::deliver_run::context_for_run(&state.pool, run).await
}
pub async fn login(AxumState(state): AxumState<State>, headers: HeaderMap) -> impl IntoResponse {
    match bearer(&headers)
        .ok_or(Error::new("unauthenticated"))
        .and_then(|token| {
            state
                .identities
                .resolve(token)
                .map(|context| (token, context.user_id))
        }) {
        Ok((token, user_id)) => (
            StatusCode::OK,
            [(
                header::SET_COOKIE,
                format!("data_agent_session={token}; HttpOnly; SameSite=Strict; Path=/"),
            )],
            Json(json!({"state":"authenticated","user_id":user_id,"model_label":model_label(&state)})),
        )
            .into_response(),
        Err(e) => failure(e).into_response(),
    }
}
pub async fn create(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ResponseResult {
    let context = user(&state, &headers).map_err(failure)?;
    let input =
        contracts::decode::<CreateConversation>("CreateConversation", body).map_err(failure)?;
    use_cases::receive_message::create_conversation(&state.pool, &context, input)
        .await
        .map_err(failure)
        .and_then(|value| success("ConversationReceipt", value))
}
pub async fn message(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(cid): Path<String>,
    Json(body): Json<Value>,
) -> ResponseResult {
    let context = user(&state, &headers).map_err(failure)?;
    let input = contracts::decode::<MessageInput>("MessageInput", body).map_err(failure)?;
    use_cases::receive_message::receive_message(
        &state.pool,
        &context,
        &cid,
        input,
        state.model_profile.as_ref(),
    )
    .await
    .map_err(failure)
    .and_then(|value| success("MessageReceipt", value))
}
pub async fn history(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> ResponseResult {
    let context = user(&state, &headers).map_err(failure)?;
    contracts::validate("HistoryQuery", &json!(query)).map_err(failure)?;
    use_cases::read_conversation::list_history(
        &state.pool,
        &context,
        query.get("before_id").map(String::as_str),
        query.get("q").map_or("", String::as_str),
    )
    .await
    .map_err(failure)
    .and_then(|value| success("History", value))
}
pub async fn snapshot(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(cid): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> ResponseResult {
    let context = user(&state, &headers).map_err(failure)?;
    let before = query
        .get("before_seq")
        .map(|s| data_agent::types::epoch(s))
        .transpose()
        .map_err(failure)?;
    let after = query
        .get("after_seq")
        .map(|s| data_agent::types::epoch(s))
        .transpose()
        .map_err(failure)?;
    if before.is_some() && after.is_some() {
        return Err(failure(Error::new("invalid_input")));
    }
    let value = use_cases::read_conversation::read_page(&state.pool, &context, &cid, before, after)
        .await
        .map_err(failure)?;
    contracts::validate("Snapshot", &value).map_err(failure)?;
    Ok(Json(value))
}
pub async fn events(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(cid): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<impl IntoResponse, (StatusCode, Json<Value>)> {
    let context = user(&state, &headers).map_err(failure)?;
    let after = query
        .get("after_seq")
        .map(|v| v.parse())
        .transpose()
        .map_err(|_| failure(Error::new("invalid_input")))?
        .unwrap_or(0);
    let values = use_cases::read_conversation::read_events(&state.pool, &context, &cid, after)
        .await
        .map_err(failure)?;
    let stream = values
        .into_iter()
        .map(|event| {
            format!(
                "id: {}\nevent: {}\ndata: {}\n\n",
                event["event_seq"].as_str().unwrap_or("0"),
                event["type"].as_str().unwrap_or("unknown"),
                event
            )
        })
        .collect::<String>();
    Ok((
        [
            (header::CONTENT_TYPE, "text/event-stream"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        stream,
    ))
}
pub async fn register(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ResponseResult {
    let input =
        contracts::decode::<ToolInvocation>("ToolInvocation", body.clone()).map_err(failure)?;
    let context = internal(&state, &headers, &body).await.map_err(failure)?;
    use_cases::invoke_tool::register_tool(&state.pool, &context, &input)
        .await
        .map_err(failure)
        .and_then(|value| success("OperationReceipt", value))
}
pub async fn tool(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ResponseResult {
    let input =
        contracts::decode::<ToolInvocation>("ToolInvocation", body.clone()).map_err(failure)?;
    let context = internal(&state, &headers, &body).await.map_err(failure)?;
    use_cases::invoke_tool::invoke_tool(&state.pool, &context, input)
        .await
        .map_err(failure)
        .and_then(|value| success("ToolOutcome", value))
}
pub async fn output(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ResponseResult {
    let input = contracts::decode::<AppendOutput>("AppendOutput", body.clone()).map_err(failure)?;
    let context = internal(&state, &headers, &body).await.map_err(failure)?;
    use_cases::finish_run::append_output(&state.pool, &context, input)
        .await
        .map_err(failure)
        .and_then(|value| success("OutputReceipt", value))
}
pub async fn finish(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ResponseResult {
    let input = contracts::decode::<FinishRun>("FinishRun", body.clone()).map_err(failure)?;
    let context = internal(&state, &headers, &body).await.map_err(failure)?;
    use_cases::finish_run::finish_run(&state.pool, &context, input)
        .await
        .map_err(failure)
        .and_then(|value| success("FinishReceipt", value))
}
pub async fn read_checkpoint(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ResponseResult {
    let input = contracts::decode::<data_agent::contracts::generated::ReadCheckpoint>(
        "ReadCheckpoint",
        body.clone(),
    )
    .map_err(failure)?;
    let context = internal(&state, &headers, &body).await.map_err(failure)?;
    use_cases::deliver_run::read_delivery_checkpoint(
        &state.pool,
        &context,
        &input.run_id,
        &input.lease_epoch,
    )
    .await
    .map_err(failure)
    .and_then(|value| success("Checkpoint", value))
}
async fn model(state: State, headers: HeaderMap, body: Value, settle: bool) -> ResponseResult {
    let input = contracts::decode::<ModelAttempt>("ModelAttempt", body.clone()).map_err(failure)?;
    let context = internal(&state, &headers, &body).await.map_err(failure)?;
    use_cases::deliver_run::model_attempt(
        &state.pool,
        &context,
        &input.run_id,
        &input.lease_epoch,
        &input.call_attempt_id,
        settle,
    )
    .await
    .map_err(failure)
    .and_then(|value| success("ModelReceipt", value))
}
pub async fn issue(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ResponseResult {
    model(state, headers, body, false).await
}
pub async fn settle(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ResponseResult {
    model(state, headers, body, true).await
}

pub async fn identity(AxumState(state): AxumState<State>, headers: HeaderMap) -> ResponseResult {
    let context = user(&state, &headers).map_err(failure)?;
    success(
        "Identity",
        json!({"user_id":context.user_id,"model_label":model_label(&state)}),
    )
}
pub async fn logout() -> impl IntoResponse {
    (
        [(
            header::SET_COOKIE,
            "data_agent_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
        )],
        Json(json!({"state":"logged_out"})),
    )
}

fn model_label(state: &State) -> &'static str {
    match state
        .model_profile
        .as_ref()
        .map(|profile| profile.model_id.as_str())
    {
        Some("deepseek-v4-pro") => "DeepSeek V4 Pro",
        Some(_) => "DeepSeek Flash",
        None => "本地模拟模型",
    }
}

pub async fn reserve_model(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ResponseResult {
    let input =
        contracts::decode::<ReserveModelCall>("ReserveModelCall", body.clone()).map_err(failure)?;
    let context = internal(&state, &headers, &body).await.map_err(failure)?;
    use_cases::model_calls::reserve(&state.pool, &context, input)
        .await
        .map_err(failure)
        .and_then(|value| success("ModelCallReceipt", value))
}
pub async fn send_model(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ResponseResult {
    let input =
        contracts::decode::<SendModelCall>("SendModelCall", body.clone()).map_err(failure)?;
    let context = internal(&state, &headers, &body).await.map_err(failure)?;
    use_cases::model_calls::send(&state.pool, &context, input)
        .await
        .map_err(failure)
        .and_then(|value| success("ModelCallReceipt", value))
}
pub async fn finalize_model(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ResponseResult {
    let input = contracts::decode::<FinalizeModelCall>("FinalizeModelCall", body.clone())
        .map_err(failure)?;
    let context = internal(&state, &headers, &body).await.map_err(failure)?;
    use_cases::model_calls::finalize(&state.pool, &context, input)
        .await
        .map_err(failure)
        .and_then(|value| success("ModelCallReceipt", value))
}

pub async fn cancel_run(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(cid): Path<String>,
    Json(body): Json<Value>,
) -> ResponseResult {
    let context = user(&state, &headers).map_err(failure)?;
    let input = contracts::decode::<CancelRun>("CancelRun", body.clone()).map_err(failure)?;
    let receipt = use_cases::cancel_run::cancel(&state.pool, &context, &cid, &input)
        .await
        .map_err(failure)?;
    // 本地终态先提交，进程通知失败也不能恢复运行或释放未知模型预留。
    if receipt["state"] == "cancelled"
        && let Ok(url) = std::env::var("DATA_AGENT_BRIDGE_URL")
    {
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(std::time::Duration::from_secs(2))
            .build()
            .map_err(|_| failure(Error::new("unavailable")))?;
        let _ = client
            .post(format!("{url}/cancel-run"))
            .bearer_auth(state.internal_token.as_str())
            .json(&body)
            .send()
            .await;
    }
    success("CancelReceipt", receipt)
}

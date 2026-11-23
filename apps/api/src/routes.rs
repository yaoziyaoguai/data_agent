use crate::{
    State,
    request::{ContractBody, ContractQuery, RawContractBody, request_contracts},
};
use axum::{
    Json,
    extract::{Path, Query, State as AxumState},
    http::{HeaderMap, StatusCode, header},
    response::IntoResponse,
};
use data_agent::{
    contracts::generated::*,
    modules::access,
    persistence::AppTx,
    types::{AccessContext, Error, id},
    use_cases,
};
use serde_json::{Value, json};
use std::collections::HashMap;
request_contracts!(
    CreateConversation,
    HistoryQuery,
    MessageInput,
    SnapshotRequest,
    ToolInvocation,
    AppendOutput,
    FinishRun,
    RefreshRunContext,
    ReadCheckpoint,
    ModelAttempt,
    ReserveModelCall,
    SendModelCall,
    FinalizeModelCall,
    CancelRun,
);

pub(crate) type ResponseResult = Result<axum::response::Response, (StatusCode, Json<Value>)>;
pub(crate) fn failure(error: Error) -> (StatusCode, Json<Value>) {
    let request_id = id();
    eprintln!(
        "request_rejected request_id={} code={}",
        request_id, error.code
    );
    let status = match error.code {
        "invalid_input"
        | "invalid_cursor"
        | "skill_line_too_long"
        | "invalid_model_endpoint"
        | "model_capacity_invalid" => StatusCode::BAD_REQUEST,
        "forbidden" => StatusCode::FORBIDDEN,
        "unauthenticated" => StatusCode::UNAUTHORIZED,
        "not_available" => StatusCode::NOT_FOUND,
        "unavailable"
        | "upstream_failed"
        | "source_unavailable"
        | "source_interrupted"
        | "vector_unconfigured"
        | "vector_unavailable"
        | "memory_busy"
        | "embedding_unavailable" => StatusCode::SERVICE_UNAVAILABLE,
        _ => StatusCode::CONFLICT,
    };
    (
        status,
        Json(
            json!({"code":error.code,"message":error.message.as_deref().unwrap_or(error.code),"request_id":request_id,"retryable":matches!(error.code,"unavailable"|"memory_busy")}),
        ),
    )
}
pub(crate) fn success<T: serde::de::DeserializeOwned + serde::Serialize>(
    _schema: &str,
    value: Value,
) -> ResponseResult {
    #[cfg(debug_assertions)]
    data_agent::contracts::validate(_schema, &value).map_err(failure)?;
    wire_response::<T>(value)
}

pub(crate) fn wire_response<T: serde::de::DeserializeOwned + serde::Serialize>(
    value: Value,
) -> ResponseResult {
    let body = T::deserialize(value).map_err(|_| failure(Error::new("invalid_input")))?;
    Ok(Json(body).into_response())
}

macro_rules! respond {
    ($schema:ident, $body:expr $(,)?) => {
        $crate::routes::success::<data_agent::contracts::generated::$schema>(
            stringify!($schema),
            $body,
        )
    };
}
pub(crate) use respond;

pub(crate) fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}
pub(crate) fn session_cookie(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|part| part.trim().strip_prefix("data_agent_session="))
}
// Bearer仍是开发/CLI直连凭据；浏览器Cookie只承载随机会话令牌，吊销即失效。
pub(crate) async fn user(state: &State, headers: &HeaderMap) -> Result<AccessContext, Error> {
    if let Some(token) = bearer(headers) {
        return state.identities.resolve(token);
    }
    let token = session_cookie(headers).ok_or(Error::new("unauthenticated"))?;
    let hash = access::session_token_hash(token);
    let session = access::resolve_session(&state.pool, &hash)
        .await?
        .ok_or(Error::new("unauthenticated"))?;
    Ok(AccessContext {
        user_id: session.user_id,
        space_id: session.space_id,
        request_id: id(),
        table_access: None,
    })
}
pub(crate) async fn internal_for_run(
    state: &State,
    headers: &HeaderMap,
    run: &str,
) -> Result<AccessContext, Error> {
    if bearer(headers) != Some(state.internal_token.as_str()) {
        return Err(Error::new("unauthenticated"));
    }
    use_cases::deliver_run::context_for_run(&state.pool, run).await
}

pub(crate) async fn semantic_user(
    state: &State,
    headers: &HeaderMap,
) -> Result<AccessContext, Error> {
    use_cases::knowledge::catalog_context(&user(state, headers).await?).await
}

pub(crate) async fn catalog_user(
    state: &State,
    headers: &HeaderMap,
) -> Result<AccessContext, Error> {
    use_cases::knowledge::catalog_reader(&user(state, headers).await?).await
}

const SESSION_TTL_SECONDS: i64 = 7 * 24 * 3600;
// 登录凭据只走一次Bearer验证；成功后签发随机会话令牌，Cookie不再携带原始凭据。
pub async fn login(AxumState(state): AxumState<State>, headers: HeaderMap) -> impl IntoResponse {
    match login_session(&state, &headers).await {
        Ok((token, user_id, space_id)) => {
            let mut cookie = format!(
                "data_agent_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={SESSION_TTL_SECONDS}"
            );
            if state.cookie_secure {
                cookie.push_str("; Secure");
            }
            (
                StatusCode::OK,
                [(header::SET_COOKIE, cookie)],
                Json(json!({"state":"authenticated","user_id":user_id,"space_id":space_id,"space_name":access::space_name(),"model_label":model_label(&state)})),
            )
                .into_response()
        }
        Err(e) => failure(e).into_response(),
    }
}
async fn login_session(
    state: &State,
    headers: &HeaderMap,
) -> Result<(String, String, String), Error> {
    let context = state
        .identities
        .resolve(bearer(headers).ok_or(Error::new("unauthenticated"))?)?;
    let token = access::issue_session_token()?;
    let mut tx = AppTx::begin(&state.pool).await?;
    access::create_session_in_tx(
        &mut tx,
        &context,
        &access::session_token_hash(&token),
        SESSION_TTL_SECONDS,
    )
    .await?;
    tx.commit().await?;
    Ok((token, context.user_id, context.space_id))
}
pub async fn create(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    ContractBody { value: input, .. }: ContractBody<CreateConversation>,
) -> ResponseResult {
    let context = user(&state, &headers).await.map_err(failure)?;
    use_cases::receive_message::create_conversation(&state.pool, &context, input)
        .await
        .map_err(failure)
        .and_then(|value| respond!(ConversationReceipt, value))
}
pub async fn message(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(cid): Path<String>,
    ContractBody { value: input, .. }: ContractBody<MessageInput>,
) -> ResponseResult {
    let context = user(&state, &headers).await.map_err(failure)?;
    use_cases::receive_message::receive_message(
        &state.pool,
        &context,
        &cid,
        input,
        state.model_profile.as_ref(),
    )
    .await
    .map_err(failure)
    .and_then(|value| respond!(MessageReceipt, value))
}
pub async fn history(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    ContractQuery(query): ContractQuery<HistoryQuery>,
) -> ResponseResult {
    let context = user(&state, &headers).await.map_err(failure)?;
    use_cases::read_conversation::list_history(
        &state.pool,
        &context,
        query.before_id.as_deref(),
        query.q.as_deref().unwrap_or(""),
    )
    .await
    .map_err(failure)
    .map(|value| Json(value).into_response())
}
pub async fn snapshot(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(cid): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> ResponseResult {
    let context = semantic_user(&state, &headers).await.map_err(failure)?;
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
    let value =
        use_cases::read_conversation::read_page(&state.pool, &context, &cid, before, after, None)
            .await
            .map_err(failure)?;
    respond!(Snapshot, value)
}
pub async fn refresh_snapshot(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(cid): Path<String>,
    ContractBody { value: request, .. }: ContractBody<SnapshotRequest>,
) -> ResponseResult {
    let context = semantic_user(&state, &headers).await.map_err(failure)?;
    let before = request
        .before_seq
        .as_deref()
        .map(data_agent::types::epoch)
        .transpose()
        .map_err(failure)?;
    let after = request
        .after_seq
        .as_deref()
        .map(data_agent::types::epoch)
        .transpose()
        .map_err(failure)?;
    use_cases::read_conversation::read_page(
        &state.pool,
        &context,
        &cid,
        before,
        after,
        Some(&request.loaded_outputs),
    )
    .await
    .map_err(failure)
    .and_then(|value| respond!(SnapshotRefresh, value))
}

pub async fn run_steps(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path((cid, run_id)): Path<(String, String)>,
) -> ResponseResult {
    let context = semantic_user(&state, &headers).await.map_err(failure)?;
    use_cases::read_conversation::run_steps(&state.pool, &context, &cid, &run_id)
        .await
        .map_err(failure)
        .map(|steps| Json(steps).into_response())
}

pub async fn register(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    ContractBody { value: input, .. }: ContractBody<ToolInvocation>,
) -> ResponseResult {
    let context = internal_for_run(&state, &headers, &input.run_id)
        .await
        .map_err(failure)?;
    use_cases::invoke_tool::register_tool(&state.pool, &context, &input)
        .await
        .map_err(failure)
        .and_then(|value| respond!(OperationReceipt, value))
}
pub async fn tool(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    ContractBody { value: input, .. }: ContractBody<ToolInvocation>,
) -> ResponseResult {
    let context = internal_for_run(&state, &headers, &input.run_id)
        .await
        .map_err(failure)?;
    use_cases::invoke_tool::invoke_tool(&state.pool, &context, input)
        .await
        .map_err(failure)
        .and_then(|value| respond!(ToolOutcome, value))
}
pub async fn output(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    ContractBody { value: input, .. }: ContractBody<AppendOutput>,
) -> ResponseResult {
    let context = internal_for_run(&state, &headers, &input.run_id)
        .await
        .map_err(failure)?;
    use_cases::finish_run::append_output(&state.pool, &context, input)
        .await
        .map_err(failure)
        .and_then(|value| respond!(OutputReceipt, value))
}
pub async fn finish(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    ContractBody { value: input, .. }: ContractBody<FinishRun>,
) -> ResponseResult {
    let context = use_cases::knowledge::catalog_context(
        &internal_for_run(&state, &headers, &input.run_id)
            .await
            .map_err(failure)?,
    )
    .await
    .map_err(failure)?;
    use_cases::finish_run::finish_run(&state.pool, &context, input)
        .await
        .map_err(failure)
        .and_then(|value| respond!(FinishReceipt, value))
}
pub async fn refresh_context(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    ContractBody { value: input, .. }: ContractBody<RefreshRunContext>,
) -> ResponseResult {
    let context = internal_for_run(&state, &headers, &input.run_id)
        .await
        .map_err(failure)?;
    use_cases::deliver_run::refresh_context(&state.pool, &context, input)
        .await
        .map_err(failure)
        .and_then(|value| respond!(WorkspaceContext, value))
}
pub async fn read_checkpoint(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    ContractBody { value: input, .. }: ContractBody<ReadCheckpoint>,
) -> ResponseResult {
    if bearer(&headers) != Some(state.internal_token.as_str()) {
        return Err(failure(Error::new("unauthenticated")));
    }
    let checkpoint = use_cases::deliver_run::read_delivery_checkpoint(
        &state.pool,
        &input.run_id,
        &input.lease_epoch,
    )
    .await
    .map_err(failure)?;
    // 宿主签发的是持久 JSON 的字节指纹。保持相同序列化，供 Bridge 核对原检查点。
    #[cfg(debug_assertions)]
    data_agent::contracts::validate("Checkpoint", &checkpoint).map_err(failure)?;
    Ok(Json(checkpoint).into_response())
}
async fn model(
    state: State,
    headers: HeaderMap,
    input: ModelAttempt,
    settle: bool,
) -> ResponseResult {
    let context = internal_for_run(&state, &headers, &input.run_id)
        .await
        .map_err(failure)?;
    use_cases::model_calls::mock_attempt(
        &state.pool,
        &context,
        &input.run_id,
        &input.lease_epoch,
        &input.call_attempt_id,
        settle,
    )
    .await
    .map_err(failure)
    .and_then(|value| respond!(ModelReceipt, value))
}
pub async fn issue(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    ContractBody { value: input, .. }: ContractBody<ModelAttempt>,
) -> ResponseResult {
    model(state, headers, input, false).await
}
pub async fn settle(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    ContractBody { value: input, .. }: ContractBody<ModelAttempt>,
) -> ResponseResult {
    model(state, headers, input, true).await
}

pub async fn identity(AxumState(state): AxumState<State>, headers: HeaderMap) -> ResponseResult {
    let context = user(&state, &headers).await.map_err(failure)?;
    respond!(
        Identity,
        json!({"user_id":context.user_id,"space_id":context.space_id,"space_name":access::space_name(),"model_label":model_label(&state)}),
    )
}
// 登出先吊销服务端会话再清Cookie；已捕获旧Cookie的请求立即401。
pub async fn logout(AxumState(state): AxumState<State>, headers: HeaderMap) -> impl IntoResponse {
    if let Some(token) = session_cookie(&headers) {
        let hash = access::session_token_hash(token);
        let result = async {
            let mut tx = AppTx::begin(&state.pool).await?;
            access::revoke_session_in_tx(&mut tx, &hash).await?;
            tx.commit().await
        }
        .await;
        if let Err(e) = result {
            return failure(e).into_response();
        }
    }
    // 无会话Cookie的登出保持幂等：只回清Cookie响应。
    let mut cookie = "data_agent_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0".to_owned();
    if state.cookie_secure {
        cookie.push_str("; Secure");
    }
    (
        [(header::SET_COOKIE, cookie)],
        Json(json!({"state":"logged_out"})),
    )
        .into_response()
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
    ContractBody { value: input, .. }: ContractBody<ReserveModelCall>,
) -> ResponseResult {
    let context = internal_for_run(&state, &headers, &input.run_id)
        .await
        .map_err(failure)?;
    use_cases::model_calls::reserve(&state.pool, &context, input)
        .await
        .map_err(failure)
        .and_then(|value| respond!(ModelCallReceipt, value))
}
pub async fn send_model(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    ContractBody { value: input, .. }: ContractBody<SendModelCall>,
) -> ResponseResult {
    let context = internal_for_run(&state, &headers, &input.run_id)
        .await
        .map_err(failure)?;
    use_cases::model_calls::send(&state.pool, &context, input)
        .await
        .map_err(failure)
        .and_then(|value| respond!(ModelCallReceipt, value))
}
pub async fn finalize_model(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    ContractBody { value: input, .. }: ContractBody<FinalizeModelCall>,
) -> ResponseResult {
    let context = internal_for_run(&state, &headers, &input.run_id)
        .await
        .map_err(failure)?;
    use_cases::model_calls::finalize(&state.pool, &context, input)
        .await
        .map_err(failure)
        .and_then(|value| respond!(ModelCallReceipt, value))
}

pub async fn cancel_run(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(cid): Path<String>,
    RawContractBody {
        value: input,
        raw: body,
    }: RawContractBody<CancelRun>,
) -> ResponseResult {
    let context = user(&state, &headers).await.map_err(failure)?;
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
        let notification = client
            .post(format!("{url}/cancel-run"))
            .bearer_auth(state.internal_token.as_str())
            .json(&body)
            .send()
            .await;
        if !matches!(notification, Ok(response) if response.status().is_success()) {
            eprintln!("cancel_notification_unconfirmed run={}", input.run_id);
        }
    }
    respond!(CancelReceipt, receipt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use data_agent::contracts::generated::{ChatMessage, DataToolOutcome};

    #[tokio::test]
    async fn wire_responses_preserve_presence_and_filter_internal_fields() {
        let response = wire_response::<ChatMessage>(json!({
            "role":"user","text":"合成输入","attempt_id":null,"committed":true,
            "message_id":null,"output_id":null,"private":"internal",
        }))
        .unwrap();
        let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&bytes).unwrap(),
            json!({"role":"user","text":"合成输入","attempt_id":null,"committed":true}),
        );

        let task = json!({"id":"task","condition_version":"2","decision_state_version":2});
        let response = respond!(WorkspaceTask, task.clone()).unwrap();
        let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), task);
    }

    #[tokio::test]
    async fn tool_response_map_has_stable_wire_order() {
        let tool = json!({"operation_id":"tool","tool_name":"search_knowledge","data":{"c":3,"a":1,"b":2}});
        for _ in 0..16 {
            let response = wire_response::<DataToolOutcome>(tool.clone()).unwrap();
            let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
            assert!(
                std::str::from_utf8(&bytes)
                    .unwrap()
                    .contains(r#""data":{"a":1,"b":2,"c":3}"#)
            );
        }
    }
}

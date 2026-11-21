use crate::State;
use axum::{
    Json,
    extract::{Path, Query, State as AxumState},
    http::{HeaderMap, StatusCode, header},
    response::{
        IntoResponse,
        sse::{Event as SseEvent, KeepAlive, KeepAliveStream, Sse},
    },
};
use data_agent::{
    contracts::{self, generated::*},
    modules::access,
    persistence::AppTx,
    types::{AccessContext, Error, id},
    use_cases,
};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::{convert::Infallible, time::Duration};
type ResponseResult = Result<Json<Value>, (StatusCode, Json<Value>)>;
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
        | "embedding_unavailable" => StatusCode::SERVICE_UNAVAILABLE,
        _ => StatusCode::CONFLICT,
    };
    (
        status,
        Json(
            json!({"code":error.code,"message":error.message.as_deref().unwrap_or(error.code),"request_id":request_id,"retryable":error.code=="unavailable"}),
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
    let mut tx = AppTx::begin(&state.pool).await?;
    let (user_id, space_id) = access::resolve_session_in_tx(&mut tx, &hash)
        .await?
        .ok_or(Error::new("unauthenticated"))?;
    tx.commit().await?;
    Ok(AccessContext {
        user_id,
        space_id,
        request_id: id(),
    })
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
    Json(body): Json<Value>,
) -> ResponseResult {
    let context = user(&state, &headers).await.map_err(failure)?;
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
    let context = user(&state, &headers).await.map_err(failure)?;
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
    let context = user(&state, &headers).await.map_err(failure)?;
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
    let context = user(&state, &headers).await.map_err(failure)?;
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
    contracts::validate("Snapshot", &value).map_err(failure)?;
    Ok(Json(value))
}
pub async fn refresh_snapshot(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(cid): Path<String>,
    Json(value): Json<Value>,
) -> ResponseResult {
    let context = user(&state, &headers).await.map_err(failure)?;
    contracts::validate("SnapshotRequest", &value).map_err(failure)?;
    let request: SnapshotRequest =
        serde_json::from_value(value).map_err(|_| failure(Error::new("invalid_input")))?;
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
    .and_then(|value| success("SnapshotRefresh", value))
}

// 会话事件实时流：连接先校验可读并补发after_seq之后的增量，随后每秒做轻量尾部
// 扫描推送新事件；断线由浏览器自动重连，Last-Event-ID续传；15秒Keep-Alive防
// 中间层掐空闲连接。客户端断开时发送端失败即停，不再扫库。
pub async fn events(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(cid): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<
    Sse<KeepAliveStream<tokio_stream::wrappers::ReceiverStream<Result<SseEvent, Infallible>>>>,
    (StatusCode, Json<Value>),
> {
    let context = user(&state, &headers).await.map_err(failure)?;
    let after_seq = query
        .get("after_seq")
        .map(|v| v.parse::<u64>())
        .transpose()
        .map_err(|_| failure(Error::new("invalid_input")))?;
    let last_event = headers
        .get("Last-Event-ID")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    // EventSource 重连时沿用首次 URL，已收到的事件号才是最新位置。
    let start = after_seq.max(last_event).unwrap_or(0);
    let session_hash = if bearer(&headers).is_none() {
        session_cookie(&headers).map(access::session_token_hash)
    } else {
        None
    };
    // 先做一次读取校验会话存在且可读，失败直接返回HTTP状态而不是挂起SSE。
    let first = use_cases::read_conversation::read_events(&state.pool, &context, &cid, start, None)
        .await
        .map_err(failure)?;
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<SseEvent, Infallible>>(32);
    let pool = state.pool.clone();
    tokio::spawn(async move {
        let mut cursor = start;
        let mut opening = Some(first);
        loop {
            loop {
                let page = if let Some(page) = opening.take() {
                    page
                } else {
                    match use_cases::read_conversation::read_events(
                        &pool,
                        &context,
                        &cid,
                        cursor,
                        session_hash.as_deref(),
                    )
                    .await
                    {
                        Ok(page) => page,
                        Err(error)
                            if matches!(
                                error.code,
                                "not_available" | "forbidden" | "unauthenticated"
                            ) =>
                        {
                            // 会话删除或权限失效：通知前端停止重连后结束流。
                            let _ = tx
                                .send(Ok(SseEvent::default()
                                    .event("stream_closed")
                                    .data(json!({"code": error.code}).to_string())))
                                .await;
                            return;
                        }
                        Err(error) => {
                            eprintln!("events_poll_transient cid={cid} code={}", error.code);
                            break;
                        }
                    }
                };
                let drained = page.len();
                for event in page {
                    let seq = event["event_seq"]
                        .as_str()
                        .and_then(|value| value.parse::<u64>().ok());
                    // 事件不命名：前端onmessage统一作为唤醒信号接收，新增事件类型不漏。
                    // id仍带游标，浏览器自动重连时以Last-Event-ID续传。
                    let mut message = SseEvent::default();
                    if let Some(seq) = seq {
                        message = message.id(seq.to_string());
                        cursor = seq;
                    }
                    if tx.send(Ok(message.data(event.to_string()))).await.is_err() {
                        // 客户端已断开：停止扫描。
                        return;
                    }
                }
                if drained < 1000 {
                    break;
                }
            }
            tokio::select! {
                _ = tx.closed() => return,
                _ = tokio::time::sleep(Duration::from_secs(1)) => {}
            }
        }
    });
    Ok(
        Sse::new(tokio_stream::wrappers::ReceiverStream::new(rx)).keep_alive(
            KeepAlive::new()
                .interval(Duration::from_secs(15))
                .text("keep-alive"),
        ),
    )
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
pub async fn refresh_context(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ResponseResult {
    let input = contracts::decode::<data_agent::contracts::generated::RefreshRunContext>(
        "RefreshRunContext",
        body.clone(),
    )
    .map_err(failure)?;
    let context = internal(&state, &headers, &body).await.map_err(failure)?;
    use_cases::deliver_run::refresh_context(&state.pool, &context, input)
        .await
        .map_err(failure)
        .and_then(|value| success("WorkspaceContext", value))
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
    let context = user(&state, &headers).await.map_err(failure)?;
    success(
        "Identity",
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
    let context = user(&state, &headers).await.map_err(failure)?;
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

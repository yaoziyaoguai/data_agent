use crate::{
    State,
    routes::{bearer, failure, session_cookie},
};
use axum::{
    Json,
    extract::{Path, Query, State as AxumState},
    http::{HeaderMap, StatusCode},
    response::sse::{Event, KeepAlive, KeepAliveStream, Sse},
};
use data_agent::{
    live_changes::{self, Change, ConversationScope, Publisher},
    modules::{access, conversations},
    types::{AccessContext, Error, Result, epoch, id},
    use_cases::{query_workflow, read_conversation},
};
use serde_json::{Value, json};
use sqlx::MySqlPool;
use std::{
    collections::{HashMap, HashSet},
    convert::Infallible,
    future::pending,
    sync::{Arc, Weak},
    time::Duration,
};
use tokio::{
    sync::{Mutex, broadcast, mpsc},
    time::Instant,
};
use tokio_stream::wrappers::ReceiverStream;

#[derive(Clone, PartialEq, Eq, Hash)]
enum Topic {
    Conversation(String),
    Space(String),
    Session(String),
}

#[derive(Clone)]
enum Frame {
    Timeline {
        sequence: u64,
        json: Arc<str>,
    },
    State {
        read_started: Instant,
        json: Arc<str>,
    },
    Catalog,
    Corrections,
    Authority,
    Closed(&'static str),
    Lagged,
}

struct Subscription {
    _channel: Arc<broadcast::Sender<Frame>>,
    receiver: broadcast::Receiver<Frame>,
}
impl Subscription {
    async fn recv(&mut self) -> std::result::Result<Frame, broadcast::error::RecvError> {
        self.receiver.recv().await
    }
}

#[derive(Default)]
struct ConversationChanges {
    context: Option<ConversationScope>,
    events: Vec<Value>,
    runs: bool,
    tasks: bool,
    queries: bool,
}

#[derive(Clone)]
pub struct LiveEvents {
    topics: Arc<Mutex<HashMap<Topic, Weak<broadcast::Sender<Frame>>>>>,
    changes: mpsc::Sender<Vec<Change>>,
}

impl LiveEvents {
    pub fn start(pool: &MySqlPool) -> Result<Self> {
        let (changes, mut incoming) = mpsc::channel(128);
        live_changes::install(Publisher::Local(changes.clone()))?;
        let live = Self {
            topics: Arc::default(),
            changes,
        };
        let publisher = live.clone();
        let pool = pool.clone();
        tokio::spawn(async move {
            while let Some(changes) = incoming.recv().await {
                publisher.publish(&pool, changes).await;
            }
        });
        Ok(live)
    }

    async fn listen(&self, topic: Topic) -> Subscription {
        let mut topics = self.topics.lock().await;
        topics.retain(|_, channel| channel.strong_count() > 0);
        let channel = topics
            .get(&topic)
            .and_then(Weak::upgrade)
            .unwrap_or_else(|| {
                let channel = Arc::new(broadcast::channel(256).0);
                topics.insert(topic, Arc::downgrade(&channel));
                channel
            });
        Subscription {
            receiver: channel.subscribe(),
            _channel: channel,
        }
    }

    async fn channel(&self, topic: &Topic) -> Option<Arc<broadcast::Sender<Frame>>> {
        self.topics.lock().await.get(topic).and_then(Weak::upgrade)
    }

    async fn broadcast(&self, topic: Topic, frame: Frame) {
        if let Some(channel) = self.channel(&topic).await {
            // 最后一位订阅者刚退出时，该帧留给下次重连的历史重放。
            drop(channel.send(frame));
        }
    }

    async fn publish(&self, pool: &MySqlPool, changes: Vec<Change>) {
        let mut conversations = HashMap::<String, ConversationChanges>::new();
        let mut catalog = HashSet::new();
        for change in changes {
            match change {
                Change::Timeline { scope, event } => {
                    let update = conversations
                        .entry(scope.conversation_id.clone())
                        .or_default();
                    match event["type"].as_str() {
                        Some("assistant_delta") => {}
                        Some("tool_result") => update.runs = true,
                        Some(
                            "analysis_report_saved" | "analysis_evidence_saved" | "task_cancelled",
                        ) => {
                            update.tasks = true;
                            update.runs = true;
                        }
                        _ => {
                            update.tasks = true;
                            update.runs = true;
                            update.queries = true;
                        }
                    }
                    update.context = Some(scope);
                    update.events.push(event);
                }
                Change::Run { scope } => {
                    let update = conversations
                        .entry(scope.conversation_id.clone())
                        .or_default();
                    update.context = Some(scope);
                    update.runs = true;
                }
                Change::Activity { conversation_id } => {
                    conversations.entry(conversation_id).or_default().runs = true;
                }
                Change::Query { conversation_id } => {
                    conversations.entry(conversation_id).or_default().queries = true;
                }
                Change::ConversationDeleted { conversation_id } => {
                    self.broadcast(
                        Topic::Conversation(conversation_id),
                        Frame::Closed("not_available"),
                    )
                    .await;
                }
                Change::Catalog { space_id } => {
                    catalog.insert(space_id);
                }
                Change::Corrections { space_id } => {
                    self.broadcast(Topic::Space(space_id), Frame::Corrections)
                        .await;
                }
                Change::Authority { space_id } => {
                    self.broadcast(Topic::Space(space_id), Frame::Authority)
                        .await;
                }
                Change::SessionRevoked { session_hash } => {
                    self.broadcast(
                        Topic::Session(session_hash),
                        Frame::Closed("unauthenticated"),
                    )
                    .await;
                }
            }
        }
        for space_id in catalog {
            self.broadcast(Topic::Space(space_id), Frame::Catalog).await;
        }
        for (cid, updates) in conversations {
            let Some(channel) = self.channel(&Topic::Conversation(cid.clone())).await else {
                continue;
            };
            if let Err(error) = deliver(pool, &channel, &cid, updates).await {
                eprintln!("live_event_projection_failed code={}", error.code);
                drop(channel.send(Frame::Lagged));
            }
        }
    }
}

async fn deliver(
    pool: &MySqlPool,
    channel: &broadcast::Sender<Frame>,
    cid: &str,
    update: ConversationChanges,
) -> Result<()> {
    for event in update.events {
        drop(
            channel.send(Frame::Timeline {
                sequence: epoch(
                    event["event_seq"]
                        .as_str()
                        .ok_or(Error::new("invalid_input"))?,
                )?,
                json: event.to_string().into(),
            }),
        );
    }
    if update.runs || update.tasks || update.queries {
        let context = if let Some(scope) = update.context {
            AccessContext {
                user_id: scope.user_id,
                space_id: scope.space_id,
                request_id: id(),
                table_access: None,
            }
        } else {
            let scope = conversations::locate_conversation(pool, cid).await?;
            AccessContext {
                user_id: scope.owner_id,
                space_id: scope.space_id,
                request_id: id(),
                table_access: None,
            }
        };
        let read_started = Instant::now();
        let state = overview(
            pool,
            &context,
            cid,
            update.runs || update.tasks,
            update.tasks,
            update.queries,
        )
        .await?;
        drop(channel.send(Frame::State {
            read_started,
            json: state.to_string().into(),
        }));
    }
    Ok(())
}

async fn overview(
    pool: &MySqlPool,
    context: &AccessContext,
    cid: &str,
    runs: bool,
    tasks: bool,
    queries: bool,
) -> Result<Value> {
    let mut result = if runs {
        read_conversation::live_states(pool, context, cid, tasks).await?
    } else {
        json!({})
    };
    if queries {
        result["query_list"] = query_workflow::list(pool, context, cid).await?;
    }
    Ok(result)
}

pub async fn receive(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Json(changes): Json<Vec<Change>>,
) -> std::result::Result<StatusCode, (StatusCode, Json<Value>)> {
    if bearer(&headers) != Some(state.internal_token.as_str()) {
        return Err(failure(Error::new("unauthenticated")));
    }
    state
        .live
        .changes
        .send(changes)
        .await
        .map_err(|_| failure(Error::new("unavailable")))?;
    Ok(StatusCode::NO_CONTENT)
}

type Stream = Sse<KeepAliveStream<ReceiverStream<std::result::Result<Event, Infallible>>>>;
type HttpStream = std::result::Result<Stream, (StatusCode, Json<Value>)>;

pub async fn conversation(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(cid): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> HttpStream {
    let after = query
        .get("after_seq")
        .map(|value| value.parse::<u64>())
        .transpose()
        .map_err(|_| failure(Error::new("invalid_input")))?;
    let last = headers
        .get("Last-Event-ID")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    listen(
        state,
        headers,
        Some((cid, after.max(last).unwrap_or(0))),
        query.get("view").is_some_and(|v| v == "workbench"),
    )
    .await
}

pub async fn workspace(AxumState(state): AxumState<State>, headers: HeaderMap) -> HttpStream {
    listen(state, headers, None, false).await
}

async fn stream_identity(
    state: &State,
    headers: &HeaderMap,
) -> Result<(AccessContext, Option<(Subscription, Instant)>)> {
    if let Some(token) = bearer(headers) {
        return Ok((state.identities.resolve(token)?, None));
    }
    let hash =
        access::session_token_hash(session_cookie(headers).ok_or(Error::new("unauthenticated"))?);
    let revocation = state.live.listen(Topic::Session(hash.clone())).await;
    let before_lookup = Instant::now();
    let session = access::resolve_session(&state.pool, &hash)
        .await?
        .ok_or(Error::new("unauthenticated"))?;
    let context = AccessContext {
        user_id: session.user_id,
        space_id: session.space_id,
        request_id: id(),
        table_access: None,
    };
    Ok((
        context,
        Some((
            revocation,
            before_lookup + Duration::from_millis(session.remaining_ms),
        )),
    ))
}

async fn listen(
    state: State,
    headers: HeaderMap,
    conversation: Option<(String, u64)>,
    workbench: bool,
) -> HttpStream {
    let (context, session) = stream_identity(&state, &headers).await.map_err(failure)?;
    let mut space = state
        .live
        .listen(Topic::Space(context.space_id.clone()))
        .await;
    // 先订阅再补历史，提交落在两步之间也可按序号去重。
    let tail = if let Some((cid, after)) = conversation {
        let connection = state.live.listen(Topic::Conversation(cid.clone())).await;
        let first = read_conversation::read_events(&state.pool, &context, &cid, after)
            .await
            .map_err(failure)?;
        Some((connection, cid, after, first))
    } else {
        None
    };
    let (send, receive) = mpsc::channel(32);
    tokio::spawn(async move {
        let mut cursor = 0;
        let mut live = None;
        let mut initial_state_read = Instant::now();
        let mut session = session;
        let mut revoked = std::pin::pin!(async {
            if let Some((revoke, expires)) = &mut session {
                tokio::select! {
                    _ = revoke.recv() => {}
                    _ = tokio::time::sleep_until(*expires) => {}
                }
            } else {
                pending::<()>().await;
            }
        });
        if let Some((connection, cid, after, first)) = tail {
            let opening = async {
                cursor = after;
                replay(&state.pool, &context, &cid, &send, &mut cursor, first).await?;
                if workbench {
                    initial_state_read = Instant::now();
                    let initial = overview(&state.pool, &context, &cid, true, true, true).await?;
                    send.send(Ok(Event::default()
                        .event("workbench_state")
                        .id(cursor.to_string())
                        .data(initial.to_string())))
                        .await
                        .map_err(|_| Error::new("closed"))?;
                }
                Ok::<_, Error>(())
            };
            tokio::select! {
                biased;
                _ = send.closed() => return,
                _ = &mut revoked => { end_stream(&send, "unauthenticated").await; return; }
                result = opening => {
                    if let Err(error) = result {
                        if error.code != "closed" { eprintln!("live_replay_failed code={}", error.code); }
                        return;
                    }
                }
            }
            live = Some(connection);
        }
        loop {
            let received = tokio::select! {
                biased;
                _ = send.closed() => return,
                _ = &mut revoked => { end_stream(&send, "unauthenticated").await; return; }
                result = space.recv() => result,
                result = receive_frame(&mut live) => result,
            };
            let event = match received {
                Ok(Frame::Timeline { sequence, json }) => {
                    if sequence <= cursor {
                        continue;
                    }
                    if sequence != cursor + 1 {
                        drop(
                            send.send(Ok(Event::default().event("lagged").data("{}")))
                                .await,
                        );
                        return;
                    }
                    cursor = sequence;
                    Event::default()
                        .id(sequence.to_string())
                        .data(json.as_ref())
                }
                Ok(Frame::State { read_started, json })
                    if workbench && read_started >= initial_state_read =>
                {
                    Event::default()
                        .event("workbench_state")
                        .data(json.as_ref())
                }
                Ok(Frame::State { .. }) => continue,
                Ok(Frame::Catalog) => Event::default().event("catalog_changed").data("{}"),
                Ok(Frame::Corrections) => Event::default().event("corrections_changed").data("{}"),
                Ok(Frame::Authority) if workbench => Event::default()
                    .event("lagged")
                    .data(r#"{"reason":"authority_changed"}"#),
                Ok(Frame::Authority) => Event::default().event("authority_changed").data("{}"),
                Ok(Frame::Closed(code)) => {
                    end_stream(&send, code).await;
                    return;
                }
                Ok(Frame::Lagged) | Err(broadcast::error::RecvError::Lagged(_)) => {
                    drop(
                        send.send(Ok(Event::default().event("lagged").data("{}")))
                            .await,
                    );
                    return;
                }
                Err(broadcast::error::RecvError::Closed) => return,
            };
            if send.send(Ok(event)).await.is_err() {
                return;
            }
        }
    });
    Ok(Sse::new(ReceiverStream::new(receive)).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keep-alive"),
    ))
}

async fn receive_frame(
    live: &mut Option<Subscription>,
) -> std::result::Result<Frame, broadcast::error::RecvError> {
    match live {
        Some(live) => live.recv().await,
        None => pending().await,
    }
}

async fn replay(
    pool: &MySqlPool,
    context: &AccessContext,
    cid: &str,
    send: &mpsc::Sender<std::result::Result<Event, Infallible>>,
    cursor: &mut u64,
    mut page: Vec<Value>,
) -> Result<()> {
    loop {
        let len = page.len();
        for event in page {
            *cursor = epoch(
                event["event_seq"]
                    .as_str()
                    .ok_or(Error::new("invalid_input"))?,
            )?;
            send.send(Ok(Event::default()
                .id(cursor.to_string())
                .data(event.to_string())))
                .await
                .map_err(|_| Error::new("closed"))?;
        }
        if len < 1000 {
            return Ok(());
        }
        page = read_conversation::read_events(pool, context, cid, *cursor).await?;
    }
}

async fn end_stream(
    send: &mpsc::Sender<std::result::Result<Event, Infallible>>,
    code: &'static str,
) {
    drop(
        send.send(Ok(Event::default()
            .event("stream_closed")
            .data(json!({"code":code}).to_string())))
            .await,
    );
}

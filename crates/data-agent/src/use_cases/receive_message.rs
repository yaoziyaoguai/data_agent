use crate::{
    contracts::generated::{CreateConversation, MessageInput},
    modules::{conversations, jobs, runtime},
    persistence::AppTx,
    types::{AccessContext, Result, fingerprint, id},
};
use serde_json::{Value, json};
use sqlx::MySqlPool;

pub async fn create_conversation(
    pool: &MySqlPool,
    context: &AccessContext,
    input: CreateConversation,
) -> Result<Value> {
    let mut tx = AppTx::begin(pool).await?;
    let cid =
        conversations::create_conversation_in_tx(&mut tx, context, &input.operation_id).await?;
    tx.commit().await?;
    Ok(json!({"conversation_id":cid}))
}
pub async fn receive_message(
    pool: &MySqlPool,
    context: &AccessContext,
    cid: &str,
    input: MessageInput,
    profile: Option<&crate::contracts::generated::ModelProfile>,
) -> Result<Value> {
    let mut tx = AppTx::begin(pool).await?;
    let locked = conversations::lock_conversation_in_tx(&mut tx, context, cid).await?;
    let fp = fingerprint(&json!({"text":input.text}));
    if let Some(message) =
        conversations::find_message_in_tx(&mut tx, context, cid, &input.client_message_id, &fp)
            .await?
    {
        tx.commit().await?;
        return Ok(json!({"message_id":message.id,"request_id":message.request_id}));
    }
    let message = conversations::accept_message_in_tx(
        &mut tx,
        &locked,
        &input.client_message_id,
        &input.text,
        &fp,
        &context.request_id,
    )
    .await?;
    conversations::append_event_in_tx(
        &mut tx,
        &locked,
        &id(),
        "message",
        json!({"message_id":message.id,"text":input.text,"request_clock":message.request_clock}),
    )
    .await?;
    runtime::open_budget_scope_in_tx(&mut tx, &message.budget_scope_id, &message.id, profile)
        .await?;
    jobs::enqueue_in_tx(&mut tx, cid, &message.id).await?;
    tx.commit().await?;
    eprintln!(
        "message_saved request={} message={} conversation={}",
        message.request_id, message.id, cid
    );
    Ok(json!({"message_id":message.id,"request_id":message.request_id}))
}

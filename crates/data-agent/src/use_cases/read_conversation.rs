use crate::{
    modules::{analysis, conversations, runtime},
    persistence::AppTx,
    types::{AccessContext, Result},
};
use serde_json::{Value, json};
use sqlx::MySqlPool;
use std::collections::HashSet;
pub async fn list_history(
    pool: &MySqlPool,
    context: &AccessContext,
    before: Option<&str>,
    query: &str,
) -> Result<Value> {
    let mut tx = AppTx::begin(pool).await?;
    let result = conversations::list_conversations_in_tx(&mut tx, context, before, query).await?;
    tx.commit().await?;
    Ok(result)
}
pub async fn read_events(
    pool: &MySqlPool,
    context: &AccessContext,
    cid: &str,
    after: u64,
) -> Result<Vec<Value>> {
    let mut tx = AppTx::begin(pool).await?;
    let conversation = conversations::lock_conversation_in_tx(&mut tx, context, cid).await?;
    let events = conversations::read_events_in_tx(&mut tx, &conversation, after).await?;
    tx.commit().await?;
    Ok(events)
}
pub async fn read_conversation(
    pool: &MySqlPool,
    context: &AccessContext,
    cid: &str,
) -> Result<Value> {
    read_page(pool, context, cid, None, None).await
}
pub async fn read_page(
    pool: &MySqlPool,
    context: &AccessContext,
    cid: &str,
    before: Option<u64>,
    after: Option<u64>,
) -> Result<Value> {
    let mut tx = AppTx::begin(pool).await?;
    let conversation = conversations::lock_conversation_in_tx(&mut tx, context, cid).await?;
    let mut events = conversations::event_page_in_tx(&mut tx, &conversation, before, after).await?;
    let last = conversations::last_event_seq_in_tx(&mut tx, &conversation).await?;
    let tasks = analysis::read_tasks_in_tx(&mut tx, cid).await?;
    let runs = runtime::read_runs_in_tx(&mut tx, cid).await?;
    let attempts: Vec<String> = events
        .iter()
        .filter_map(|e| e["payload"]["attempt_id"].as_str().map(str::to_owned))
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let states = runtime::output_states_in_tx(&mut tx, cid, &attempts).await?;
    for event in &mut events {
        if let Some(state) = event["payload"]["attempt_id"]
            .as_str()
            .and_then(|id| states.get(id))
        {
            event["payload"]["projection_state"] = json!(state);
        }
    }
    let hidden: HashSet<String> = events
        .iter()
        .filter(|e| e["type"] == "assistant_replaced")
        .filter_map(|e| {
            e["payload"]["replaces_attempt_id"]
                .as_str()
                .map(str::to_owned)
        })
        .collect();
    let mut messages = Vec::new();
    for event in &events {
        let payload = &event["payload"];
        if event["type"] == "message" {
            messages.push(
                json!({"event_seq":event["event_seq"],"role":"user","message_id":payload["message_id"],"text":payload["text"],"attempt_id":null,"committed":true}),
            );
        }
        if event["type"] == "assistant_committed" {
            messages.push(json!({"event_seq":event["event_seq"],"output_id":payload["output_id"],"role":"assistant","text":payload["text"],"attempt_id":payload["attempt_id"],"committed":true}));
        }
    }
    let mut committed: HashSet<String> = messages
        .iter()
        .filter_map(|m| m["attempt_id"].as_str().map(str::to_owned))
        .collect();
    committed.extend(
        states
            .iter()
            .filter(|(_, state)| state.as_str() == "committed")
            .map(|(id, _)| id.clone()),
    );
    let mut partials = std::collections::BTreeMap::<String, String>::new();
    for event in &events {
        if event["type"] == "assistant_delta" {
            let p = &event["payload"];
            if let Some(attempt) = p["attempt_id"].as_str()
                && !hidden.contains(attempt)
                && states
                    .get(attempt)
                    .is_none_or(|state| state != "superseded")
                && !committed.contains(attempt)
            {
                partials
                    .entry(attempt.to_owned())
                    .or_default()
                    .push_str(p["text"].as_str().unwrap_or(""));
            }
        }
    }
    for (attempt, text) in partials {
        messages
            .push(json!({"role":"assistant","text":text,"attempt_id":attempt,"committed":false}));
    }
    tx.commit().await?;
    Ok(
        json!({"last_event_seq":events.last().map(|v|v["event_seq"].clone()).unwrap_or(json!(after.unwrap_or(0).to_string())),"has_newer":after.is_some() && events.last().and_then(|v|v["event_seq"].as_str()).and_then(|v|v.parse::<u64>().ok()).unwrap_or(after.unwrap_or(0))<last,"conversation_id":cid,"messages":messages,"tasks":tasks,"runs":runs,"events":events,"first_event_seq":events.first().map(|v|v["event_seq"].clone()).unwrap_or(json!("0")),"has_older":events.first().is_some_and(|v|v["event_seq"].as_str().and_then(|n|n.parse::<u64>().ok()).is_some_and(|n|n>1))}),
    )
}

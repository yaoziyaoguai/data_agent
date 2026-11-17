use crate::{
    contracts::generated::LoadedOutputRange,
    modules::{analysis, conversations, queries, runtime},
    persistence::AppTx,
    types::{AccessContext, Error, Result, epoch, fingerprint},
};
use serde_json::{Value, json};
use sqlx::MySqlPool;
use std::collections::{HashMap, HashSet};
async fn read_output_authorities_in_tx(
    tx: &mut AppTx<'_>,
    context: &AccessContext,
    outputs: &mut [runtime::OutputReadBinding],
) -> Result<()> {
    for output in outputs {
        for unit in &mut output.units {
            let authority: Result<Value> = async {
                let mut authority = super::context_authority::empty();
                for source in &unit.authorities {
                    super::context_authority::merge(&mut authority, source)?;
                }
                let mut results = super::context_authority::empty();
                results["query_results"] = json!(
                    unit.result_dependencies
                        .iter()
                        .map(|(qid, result_ref)| json!([qid, result_ref]))
                        .collect::<Vec<_>>()
                );
                super::context_authority::merge(&mut authority, &results)?;
                for (qid, _) in &unit.result_dependencies {
                    let source = queries::text_authority_in_tx(tx, context, qid).await?;
                    super::context_authority::merge(&mut authority, &source)?;
                }
                Ok(authority)
            }
            .await;
            unit.authorities = vec![match authority {
                Ok(authority) => authority,
                Err(error)
                    if matches!(
                        error.code,
                        "forbidden"
                            | "not_available"
                            | "stale_knowledge"
                            | "stale_context"
                            | "invalid_evidence"
                    ) =>
                {
                    Value::Null
                }
                Err(error) => return Err(error),
            }];
        }
    }
    Ok(())
}

async fn history_text_readable_in_tx(
    tx: &mut AppTx<'_>,
    context: &AccessContext,
    cid: &str,
    authority: &Value,
    checked: &super::context_authority::CheckedTextResults,
) -> Result<bool> {
    if !checked.allows_history(authority) {
        return Ok(false);
    }
    match super::context_authority::validate_history_in_tx(tx, context, cid, authority).await {
        Ok(()) => Ok(true),
        Err(error)
            if matches!(
                error.code,
                "forbidden"
                    | "not_available"
                    | "stale_knowledge"
                    | "stale_context"
                    | "invalid_evidence"
            ) =>
        {
            Ok(false)
        }
        Err(error) => Err(error),
    }
}

// snapshot消息和SSE重放共用来源投影；游标只选事件，不决定答案的来源边界。
async fn protect_output_events(
    pool: &MySqlPool,
    context: &AccessContext,
    cid: &str,
    events: &mut [Value],
    loaded_attempts: &[String],
) -> Result<HashMap<String, String>> {
    const RESTRICTED_TEXT: &str = "部分内容因来源不可读而隐藏。";
    let attempts: Vec<String> = events
        .iter()
        .filter_map(|event| event["payload"]["attempt_id"].as_str().map(str::to_owned))
        .chain(loaded_attempts.iter().cloned())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    if attempts.is_empty() {
        return Ok(HashMap::new());
    }
    let mut tx = AppTx::begin(pool).await?;
    conversations::lock_conversation_in_tx(&mut tx, context, cid).await?;
    let mut outputs = runtime::read_output_bindings_in_tx(&mut tx, cid, &attempts).await?;
    read_output_authorities_in_tx(&mut tx, context, &mut outputs).await?;
    tx.commit().await?;
    let authorities: Vec<Value> = outputs
        .iter()
        .flat_map(|output| {
            output
                .units
                .iter()
                .flat_map(|unit| unit.authorities.iter())
                .chain(std::iter::once(&output.delta_authority))
                .cloned()
        })
        .collect();
    let mut checked = super::context_authority::CheckedTextResults::default();
    checked.include_history(pool, context, &authorities).await?;

    // 平台返回后重核当前状态和来源；已提交绑定不可变，不再重建正文。
    let mut tx = AppTx::begin(pool).await?;
    conversations::lock_conversation_in_tx(&mut tx, context, cid).await?;
    let active_attempts = outputs
        .iter()
        .filter(|output| output.state != "committed")
        .map(|output| output.attempt_id.clone())
        .collect::<Vec<_>>();
    let mut active = runtime::read_output_bindings_in_tx(&mut tx, cid, &active_attempts).await?;
    for output in &mut outputs {
        if output.state != "committed" {
            let index = active
                .iter()
                .position(|current| current.attempt_id == output.attempt_id)
                .ok_or(Error::new("not_available"))?;
            *output = active.swap_remove(index);
        }
    }
    read_output_authorities_in_tx(&mut tx, context, &mut outputs).await?;
    let states = runtime::output_states_in_tx(&mut tx, cid, &attempts).await?;
    let mut projections = HashMap::new();
    for mut output in outputs {
        output.state = states
            .get(&output.attempt_id)
            .ok_or(Error::new("not_available"))?
            .clone();
        let mut readable = Vec::new();
        for unit in &output.units {
            let mut allowed = true;
            for authority in &unit.authorities {
                allowed &=
                    history_text_readable_in_tx(&mut tx, context, cid, authority, &checked).await?;
            }
            readable.push(allowed);
        }
        let delta_readable =
            history_text_readable_in_tx(&mut tx, context, cid, &output.delta_authority, &checked)
                .await?;
        projections.insert(
            output.attempt_id.clone(),
            (output, readable, delta_readable),
        );
    }
    tx.commit().await?;
    for event in events {
        let Some((output, readable, delta_readable)) = event["payload"]["attempt_id"]
            .as_str()
            .and_then(|attempt| projections.get(attempt))
        else {
            continue;
        };
        event["payload"]["projection_state"] = json!(output.state);
        if event["type"] == "assistant_committed" {
            event["payload"]["text"] = json!(
                output
                    .units
                    .iter()
                    .zip(readable)
                    .map(|(unit, allowed)| if *allowed {
                        unit.text.as_str()
                    } else {
                        RESTRICTED_TEXT
                    })
                    .collect::<Vec<_>>()
                    .join("\n\n---\n\n")
            );
        } else if event["type"] == "assistant_delta" {
            let chunk = event["payload"]["chunk_seq"]
                .as_str()
                .and_then(|seq| seq.parse::<u64>().ok());
            let bound = output.units.iter().position(|unit| {
                unit.chunk_range.as_ref().is_some_and(|range| {
                    range.attempt_id == output.attempt_id
                        && chunk.is_some_and(|chunk| range.first <= chunk && chunk <= range.last)
                })
            });
            let allowed = bound
                .map(|index| readable[index])
                .unwrap_or(*delta_readable && readable.iter().all(|allowed| *allowed));
            if !allowed {
                event["payload"]["text"] = json!(RESTRICTED_TEXT);
            }
        }
    }
    Ok(states)
}

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
    let mut events = conversations::read_events_in_tx(&mut tx, &conversation, after).await?;
    tx.commit().await?;
    protect_output_events(pool, context, cid, &mut events, &[]).await?;
    Ok(events)
}
pub async fn read_conversation(
    pool: &MySqlPool,
    context: &AccessContext,
    cid: &str,
) -> Result<Value> {
    read_page(pool, context, cid, None, None, None).await
}
pub async fn read_page(
    pool: &MySqlPool,
    context: &AccessContext,
    cid: &str,
    before: Option<u64>,
    after: Option<u64>,
    loaded: Option<&[LoadedOutputRange]>,
) -> Result<Value> {
    let checked =
        super::context_authority::check_task_text_results(pool, context, cid, None).await?;
    let mut tx = AppTx::begin(pool).await?;
    let conversation = conversations::lock_conversation_in_tx(&mut tx, context, cid).await?;
    let mut events = conversations::event_page_in_tx(&mut tx, &conversation, before, after).await?;
    let page_len = events.len();
    let mut loaded_counts = Vec::new();
    for range in loaded.into_iter().flatten() {
        let first = epoch(&range.first_event_seq)?;
        let last = epoch(&range.last_event_seq)?;
        if first > last {
            return Err(Error::new("invalid_input"));
        }
        let cached = conversations::output_event_range_in_tx(
            &mut tx,
            &conversation,
            &range.attempt_id,
            first,
            last,
        )
        .await?;
        loaded_counts.push((range, cached.len()));
        events.extend(cached);
    }
    let last = conversations::last_event_seq_in_tx(&mut tx, &conversation).await?;
    let mut tasks = analysis::read_tasks_in_tx(&mut tx, cid).await?;
    for task in &mut tasks {
        super::context_authority::protect_task_context_in_tx(
            &mut tx, context, cid, task, &checked, None,
        )
        .await?;
    }
    // §5：报告卡首次保存事件序号作为展示锚点；同一读取事务内组合，覆盖Snapshot与refresh同一路径。
    // 无保存事件的旧记录省略可选字段，不填0或null冒充锚点。
    let report_ids: Vec<String> = tasks
        .iter()
        .filter_map(|task| task["report_ref"]["report_id"].as_str().map(str::to_owned))
        .collect();
    if !report_ids.is_empty() {
        let anchors =
            conversations::report_first_saved_seq_in_tx(&mut tx, cid, &report_ids).await?;
        for task in &mut tasks {
            if let Some(report_id) = task["report_ref"]["report_id"].as_str()
                && let Some(seq) = anchors.get(report_id)
            {
                task["report_timeline_event_seq"] = json!(seq);
            }
        }
    }
    // run身份由runtime提供，结果通知关联由conversations可信记录组合；不跨模块私表SQL。
    let mut runs = runtime::read_runs_in_tx(&mut tx, cid).await?;
    let result_queries = conversations::result_query_map_in_tx(&mut tx, cid).await?;
    for run in &mut runs {
        let result_query_id = run["message_id"]
            .as_str()
            .and_then(|message| result_queries.get(message));
        run["purpose"] = if result_query_id.is_some() {
            json!("query_result")
        } else {
            json!("user_request")
        };
        run["result_query_id"] = result_query_id.map(|qid| json!(qid)).unwrap_or(Value::Null);
    }
    tx.commit().await?;
    let loaded_attempts = loaded_counts
        .iter()
        .map(|(range, _)| range.attempt_id.clone())
        .collect::<Vec<_>>();
    // 新页和全部已加载范围共用本次授权结果，不分别核权后混拼。
    let states = protect_output_events(pool, context, cid, &mut events, &loaded_attempts).await?;
    let mut cached_events = events.split_off(page_len).into_iter();
    let mut output_projections = Vec::new();
    for (range, count) in loaded_counts {
        let current_events = cached_events.by_ref().take(count).collect::<Vec<_>>();
        let state = states.get(&range.attempt_id);
        let current_fingerprint = fingerprint(&json!({
            "conversation_id":cid,"attempt_id":range.attempt_id,
            "first_event_seq":range.first_event_seq,"last_event_seq":range.last_event_seq,
            "output_state":state,"events":current_events,
        }));
        let outcome = if state.is_none() {
            "not_available"
        } else if range.projection_fingerprint.as_deref() == Some(current_fingerprint.as_str()) {
            "unchanged"
        } else {
            "replace"
        };
        let mut projection = json!({
            "attempt_id":range.attempt_id,"first_event_seq":range.first_event_seq,
            "last_event_seq":range.last_event_seq,"output_state":state,
            "projection_fingerprint":current_fingerprint,"projection_result":outcome,
        });
        if outcome == "replace" {
            projection["events"] = json!(current_events);
        }
        output_projections.push(projection);
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
    let mut snapshot = json!({"last_event_seq":events.last().map(|v|v["event_seq"].clone()).unwrap_or(json!(after.unwrap_or(0).to_string())),"has_newer":after.is_some() && events.last().and_then(|v|v["event_seq"].as_str()).and_then(|v|v.parse::<u64>().ok()).unwrap_or(after.unwrap_or(0))<last,"conversation_id":cid,"messages":messages,"tasks":tasks,"runs":runs,"events":events,"first_event_seq":events.first().map(|v|v["event_seq"].clone()).unwrap_or(json!("0")),"has_older":events.first().is_some_and(|v|v["event_seq"].as_str().and_then(|n|n.parse::<u64>().ok()).is_some_and(|n|n>1))});
    if loaded.is_some() {
        snapshot["output_projections"] = json!(output_projections);
    }
    Ok(snapshot)
}

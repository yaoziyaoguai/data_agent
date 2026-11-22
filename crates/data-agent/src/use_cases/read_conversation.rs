use crate::{
    contracts::generated::{LoadedOutputRange, RunStepList, RunStepSummary},
    modules::{analysis, conversations, knowledge, runtime},
    persistence::AppTx,
    types::{AccessContext, Error, Result, epoch, fingerprint},
};
use serde_json::{Value, json};
use sqlx::MySqlPool;
use std::collections::{HashMap, HashSet};

// 运行活动中文提示：与use_cases::data_tools收录的工具名一一映射；未知工具不猜文案。
fn activity_label(tool: &str) -> Option<&'static str> {
    Some(match tool {
        "search_knowledge" => "正在检索语义知识",
        "read_knowledge" => "正在阅读知识对象",
        "read_source" => "正在读取来源原文",
        "read" => "正在读取技能文件",
        "validate_sql" => "正在核验SQL",
        "request_query" => "正在起草数据查询",
        "execute_query" => "正在执行数据查询",
        "get_query" => "正在核对查询状态",
        "cancel_query" => "正在取消查询",
        "update_analysis_task" => "正在整理分析任务",
        "save_analysis_evidence" => "正在保存分析依据",
        "prepare_analysis_answer" => "正在准备回答",
        "present_analysis_answer" => "正在生成回答",
        "save_analysis_report" => "正在保存分析报告",
        "read_analysis_report" => "正在读取分析报告",
        "prepare_skill_draft" => "正在准备技能草稿",
        "manage_personal_asset" => "正在整理个人资产",
        "propose_semantic_change" => "正在提交语义修订",
        "read_conversation" => "正在读取会话记录",
        "read_analysis_task" => "正在读取分析任务",
        _ => return None,
    })
}

// 事件正文是会话所有者已保存的记录。状态投影只处理跨页的提交与替换。
async fn output_states(
    tx: &mut AppTx<'_>,
    cid: &str,
    events: &mut [Value],
) -> Result<HashMap<String, String>> {
    let attempts = events
        .iter()
        .filter_map(|event| event["payload"]["attempt_id"].as_str().map(str::to_owned))
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let states = runtime::output_states_in_tx(tx, cid, &attempts).await?;
    for event in events {
        if let Some(state) = event["payload"]["attempt_id"]
            .as_str()
            .and_then(|id| states.get(id))
        {
            event["payload"]["projection_state"] = json!(state);
        }
    }
    Ok(states)
}

pub async fn list_history(
    pool: &MySqlPool,
    context: &AccessContext,
    before: Option<&str>,
    query: &str,
) -> Result<crate::contracts::generated::History> {
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
    let mut events = conversations::read_events_in_tx(&mut tx, context, cid, after).await?;
    output_states(&mut tx, cid, &mut events).await?;
    tx.commit().await?;
    Ok(events)
}

pub async fn live_states(
    pool: &MySqlPool,
    context: &AccessContext,
    cid: &str,
    include_tasks: bool,
) -> Result<Value> {
    let mut tx = AppTx::begin(pool).await?;
    conversations::assert_readable_in_tx(&mut tx, context, cid).await?;
    let mut state = json!({"runs":run_states_in_tx(&mut tx, context, cid).await?});
    if include_tasks {
        state["tasks"] = json!(task_states_in_tx(&mut tx, cid).await?);
    }
    tx.commit().await?;
    Ok(state)
}

async fn task_states_in_tx(tx: &mut AppTx<'_>, cid: &str) -> Result<Vec<Value>> {
    let mut tasks = analysis::read_tasks_in_tx(tx, cid).await?;
    // §5：报告卡首次保存事件序号作为展示锚点；同一读取事务内组合，覆盖Snapshot与refresh同一路径。
    // 无保存事件的旧记录省略可选字段，不填0或null冒充锚点。
    let report_ids: Vec<String> = tasks
        .iter()
        .filter_map(|task| task["report_ref"]["report_id"].as_str().map(str::to_owned))
        .collect();
    if !report_ids.is_empty() {
        let anchors = conversations::report_first_saved_seq_in_tx(tx, cid, &report_ids).await?;
        for task in &mut tasks {
            if let Some(report_id) = task["report_ref"]["report_id"].as_str()
                && let Some(seq) = anchors.get(report_id)
            {
                task["report_timeline_event_seq"] = json!(seq);
            }
        }
    }
    Ok(tasks)
}

async fn run_states_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
) -> Result<Vec<Value>> {
    // run身份由runtime提供，结果通知关联由conversations可信记录组合；不跨模块私表SQL。
    let mut runs = runtime::read_runs_in_tx(tx, cid).await?;
    let result_queries = conversations::result_query_map_in_tx(tx, cid).await?;
    let activity = runtime::tool_activity_in_tx(tx, cid, None).await?;
    let names = step_names(tx, ctx, activity.values()).await?;

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
        // 运行中才提示活动；最近一次登记的工具名映射为中文动作，未知工具不编造文案。
        if run["state"] == "running"
            && let Some(activity) =
                activity.get(run["run_id"].as_str().ok_or(Error::new("invalid_input"))?)
        {
            if let Some(label) = activity_label(&activity.tool) {
                run["activity_label"] = json!(label);
            }
            run["completed_steps"] = json!(activity.completed);
            run["completed_step_summaries"] = json!(step_summaries(activity, &names));
        }
    }
    Ok(runs)
}

async fn step_names<'a>(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    activities: impl Iterator<Item = &'a runtime::ToolActivity>,
) -> Result<HashMap<String, String>> {
    let targets: HashSet<_> = activities
        .flat_map(|activity| {
            activity
                .steps
                .iter()
                .filter_map(|step| step.target_id.clone())
        })
        .collect();
    knowledge::candidate_meta_in_tx(tx, ctx, &targets.into_iter().collect::<Vec<_>>(), None)
        .await?
        .into_iter()
        .filter(|object| object["state"] == "enabled")
        .map(|object| {
            let id = object["id"].as_str().ok_or(Error::new("invalid_input"))?;
            let name = object["name"].as_str().ok_or(Error::new("invalid_input"))?;
            Ok((id.to_owned(), name.to_owned()))
        })
        .collect()
}

fn step_summaries(
    activity: &runtime::ToolActivity,
    names: &HashMap<String, String>,
) -> Vec<RunStepSummary> {
    activity
        .steps
        .iter()
        .filter_map(|step| {
            Some(RunStepSummary {
                category: activity_label(&step.tool)?
                    .trim_start_matches("正在")
                    .to_owned(),
                target_name: step
                    .target_id
                    .as_ref()
                    .and_then(|id| names.get(id))
                    .cloned(),
                duration_ms: step.duration_ms,
            })
        })
        .collect()
}

pub async fn run_steps(
    pool: &MySqlPool,
    ctx: &AccessContext,
    cid: &str,
    run_id: &str,
) -> Result<RunStepList> {
    let mut tx = AppTx::begin(pool).await?;
    conversations::assert_readable_in_tx(&mut tx, ctx, cid).await?;
    let activities = runtime::tool_activity_in_tx(&mut tx, cid, Some(run_id)).await?;
    let steps = if let Some(activity) = activities.get(run_id) {
        let names = step_names(&mut tx, ctx, std::iter::once(activity)).await?;
        step_summaries(activity, &names)
    } else {
        Vec::new()
    };
    tx.commit().await?;
    Ok(RunStepList { steps })
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
    let tasks = task_states_in_tx(&mut tx, cid).await?;
    let runs = run_states_in_tx(&mut tx, context, cid).await?;
    let states = output_states(&mut tx, cid, &mut events).await?;
    tx.commit().await?;
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

#[cfg(test)]
mod tests {
    use super::activity_label;

    #[test]
    fn known_tools_map_to_activity_labels_and_unknown_stays_silent() {
        for tool in [
            "search_knowledge",
            "read_knowledge",
            "read_source",
            "read",
            "validate_sql",
            "request_query",
            "execute_query",
            "get_query",
            "cancel_query",
            "update_analysis_task",
            "save_analysis_evidence",
            "prepare_analysis_answer",
            "present_analysis_answer",
            "save_analysis_report",
            "read_analysis_report",
            "prepare_skill_draft",
            "manage_personal_asset",
            "propose_semantic_change",
            "read_conversation",
            "read_analysis_task",
        ] {
            let label = activity_label(tool).unwrap_or_else(|| panic!("{tool}缺少活动提示"));
            assert!(label.starts_with("正在"), "{tool}提示不是动作式中文");
        }
        assert_eq!(activity_label("unknown_tool"), None);
    }
}

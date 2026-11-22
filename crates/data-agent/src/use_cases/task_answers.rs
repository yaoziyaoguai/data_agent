mod composition;
mod control;
use crate::{
    contracts::generated::{AnswerHandoff, AnswerPartReference, RenderedAnswerBinding, StopReason},
    modules::{analysis, conversations, queries, runtime},
    persistence::AppTx,
    types::{AccessContext, Error, Result, epoch, fingerprint},
};
pub(super) use composition::compose_in_tx;
pub(super) use control::{
    control_delivery_in_tx, reconnect_control_delivery_in_tx, stored_control_delivery_in_tx,
    validate_control_tasks_in_tx,
};
use serde_json::{Value, json};
use sqlx::MySqlPool;

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key].as_str().ok_or(Error::new("invalid_evidence"))
}

// 新字段只能复述首次登记事实；旧回执缺字段时保留原登记或冻结/通知证明。
pub(super) fn candidate_task_ref(
    tool: &runtime::LockedTool,
    receipt: &Value,
) -> Result<Option<Value>> {
    let registered = match (&tool.task_id, tool.task_condition_version) {
        (Some(task_id), Some(version)) => {
            Some(json!({"task_id":task_id,"condition_version":version.to_string()}))
        }
        (None, None) => None,
        _ => return Err(Error::new("invalid_evidence")),
    };
    if let Some(stored) = receipt.get("answer_task_ref")
        && registered.as_ref() != Some(stored)
    {
        return Err(Error::new("invalid_evidence"));
    }
    Ok(registered)
}

async fn scope_in_tx(tx: &mut AppTx<'_>, cid: &str, task: &Value) -> Result<Value> {
    let current = analysis::read_task_in_tx(tx, cid, text(task, "task_id")?).await?;
    if current["condition_version"] != task["condition_version"] {
        return Err(Error::new("version_conflict"));
    }
    if current["lifecycle"] != "active" {
        return Err(Error::new("task_inactive"));
    }
    // 澄清也可自然交付；是否允许查询仍由原任务/查询入口的严格阶段检查决定。
    analysis::declared_source_limits_in_tx(tx, cid, text(task, "task_id")?)
        .await?
        .ok_or(Error::new("task_context_required"))
}

pub(super) async fn validate_sources_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    _cid: &str,
    scope: &Value,
    authority: &Value,
    checked: &super::context_authority::CheckedTextResults,
) -> Result<()> {
    super::context_authority::validate_in_tx(
        tx,
        ctx,
        authority,
        super::context_authority::AuthorityUse::Text(checked),
    )
    .await?;
    if !scope.is_null() {
        let gate = super::source_limits::gate_from_contract(scope)?;
        if !super::source_limits::authority_within_in_tx(tx, ctx, &gate, authority).await? {
            return Err(Error::new("source_not_allowed"));
        }
    }
    Ok(())
}

async fn notification_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    conv: &conversations::LockedConversation,
    run: &runtime::LockedRun,
) -> Result<Option<Value>> {
    match conversations::result_query_for_message_in_tx(tx, &conv.id, &run.message_id).await? {
        Some(query_id) => Ok(Some(queries::read_in_tx(tx, ctx, &query_id).await?)),
        None => Ok(None),
    }
}

fn covers_notification(receipt: &Value, query: &Value) -> bool {
    receipt["data"]["sources"]
        .as_array()
        .is_some_and(|sources| {
            sources.iter().any(|source| {
                source["query_id"] == query["id"]
                    && source["task_id"] == query["task_id"]
                    && source["condition_version"] == query["condition_version"]
            })
        })
}

pub(super) async fn source_scope_at_version_in_tx(
    tx: &mut AppTx<'_>,
    conv: &conversations::LockedConversation,
    query: &Value,
) -> Result<Value> {
    let task_id = text(query, "task_id")?;
    let current = analysis::read_task_in_tx(tx, &conv.id, task_id).await?;
    if current["lifecycle"] != "active" {
        return Err(Error::new("task_inactive"));
    }
    analysis::source_limits_at_version_in_tx(
        tx,
        &conv.id,
        task_id,
        epoch(text(query, "condition_version")?)?,
    )
    .await?
    .ok_or(Error::new("task_context_required"))
}

// present与prepare的回执都携带已核sources/result_dependencies，复用同一来源核验；
// 只按调用方指定的工具种类接回执，不把prepare强转成带answer_text的旧答案。
async fn answer_sources_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    conv: &conversations::LockedConversation,
    answer: &runtime::LockedTool,
    expected_tool: &str,
    checked: &super::context_authority::CheckedTextResults,
) -> Result<(Option<Value>, Value)> {
    let receipt = answer
        .receipt
        .as_ref()
        .ok_or(Error::new("invalid_evidence"))?;
    if answer.state != "succeeded"
        || receipt["tool_name"] != expected_tool
        || receipt["data"]["sources"]
            .as_array()
            .is_none_or(Vec::is_empty)
    {
        return Err(Error::new("invalid_evidence"));
    }
    let owner = candidate_task_ref(answer, receipt)?;
    // 交付核验不等于当前模型采用，不能把冻结前项的查询并回活动任务来源。
    let sources =
        super::analysis_answers::check_sources_in_tx(tx, ctx, &conv.id, &receipt["data"], checked)
            .await?;
    Ok((owner, sources))
}

// 单答案和组合采用同一回执来源核验；通知目标独立于候选登记owner。
pub(super) async fn single_answer_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    conv: &conversations::LockedConversation,
    run: &runtime::LockedRun,
    sdk: &str,
    checked: &super::context_authority::CheckedTextResults,
) -> Result<(Value, runtime::OutputReadUnit)> {
    let answer = runtime::read_answer_tool_in_tx(tx, run, sdk)
        .await?
        .ok_or(Error::new("invalid_evidence"))?;
    let (owner, sources) =
        answer_sources_in_tx(tx, ctx, conv, &answer, "present_analysis_answer", checked).await?;
    let receipt = answer
        .receipt
        .as_ref()
        .ok_or(Error::new("invalid_evidence"))?;
    let notification = notification_in_tx(tx, ctx, conv, run).await?;
    let (task, scope) = if let Some(query) = &notification {
        if !covers_notification(receipt, query) {
            return Err(Error::new("invalid_evidence"));
        }
        (
            json!({"task_id":query["task_id"],"condition_version":query["condition_version"]}),
            source_scope_at_version_in_tx(tx, conv, query).await?,
        )
    } else {
        let task = owner.ok_or(Error::new("invalid_evidence"))?;
        let scope = scope_in_tx(tx, &conv.id, &task).await?;
        (task, scope)
    };
    validate_sources_in_tx(tx, ctx, &conv.id, &scope, &sources, checked).await?;
    let mut authority =
        super::context_authority::generated_text_authority_in_tx(tx, &run.id).await?;
    if notification.is_none() {
        validate_sources_in_tx(tx, ctx, &conv.id, &scope, &authority, checked).await?;
    }
    super::context_authority::merge(&mut authority, &sources)?;
    Ok((
        task,
        runtime::answer_read_unit(&receipt["data"], authority, sdk)?,
    ))
}

// 渲染单份答案与present单份采用同一回执来源核验与通知覆盖链，
// 只是正文按binding从source_text+bindings重算并核验原chunk范围。
pub(super) async fn rendered_answer_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    conv: &conversations::LockedConversation,
    run: &runtime::LockedRun,
    binding: &RenderedAnswerBinding,
    checked: &super::context_authority::CheckedTextResults,
) -> Result<(Value, runtime::OutputReadUnit)> {
    let prepared = runtime::read_prepare_tool_in_tx(tx, run, &binding.prepared_sdk_tool_call_id)
        .await?
        .ok_or(Error::new("invalid_evidence"))?;
    let (owner, sources) =
        answer_sources_in_tx(tx, ctx, conv, &prepared, "prepare_analysis_answer", checked).await?;
    let receipt = prepared
        .receipt
        .as_ref()
        .ok_or(Error::new("invalid_evidence"))?;
    let notification = notification_in_tx(tx, ctx, conv, run).await?;
    let (task, scope) = if let Some(query) = &notification {
        if !covers_notification(receipt, query) {
            return Err(Error::new("invalid_evidence"));
        }
        (
            json!({"task_id":query["task_id"],"condition_version":query["condition_version"]}),
            source_scope_at_version_in_tx(tx, conv, query).await?,
        )
    } else {
        let task = owner.ok_or(Error::new("invalid_evidence"))?;
        let scope = scope_in_tx(tx, &conv.id, &task).await?;
        (task, scope)
    };
    validate_sources_in_tx(tx, ctx, &conv.id, &scope, &sources, checked).await?;
    let mut authority =
        super::context_authority::generated_text_authority_in_tx(tx, &run.id).await?;
    if notification.is_none() {
        validate_sources_in_tx(tx, ctx, &conv.id, &scope, &authority, checked).await?;
    }
    super::context_authority::merge(&mut authority, &sources)?;
    let (text, chunk_range) = runtime::read_rendered_in_tx(tx, run, binding).await?;
    Ok((
        task,
        runtime::OutputReadUnit {
            text,
            authorities: vec![authority],
            result_dependencies: runtime::prepared_dependencies(&receipt["data"])?,
            chunk_range: Some(chunk_range),
            answer_sdk_tool_call_id: None,
            prepared_sdk_tool_call_id: Some(binding.prepared_sdk_tool_call_id.clone()),
        },
    ))
}

// 只消费正文实际采用的答案SDK：present与prepare按各自工具接回执，
// 返回原通知条件；引用的其他任务不是交付owner。
pub(super) async fn covered_notification_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    conv: &conversations::LockedConversation,
    run: &runtime::LockedRun,
    adopted: &[(String, &'static str)],
    checked: &super::context_authority::CheckedTextResults,
) -> Result<Option<Value>> {
    let Some(query) = notification_in_tx(tx, ctx, conv, run).await? else {
        return Ok(None);
    };
    for (sdk, expected_tool) in adopted {
        let tool = match *expected_tool {
            "prepare_analysis_answer" => runtime::read_prepare_tool_in_tx(tx, run, sdk).await?,
            _ => runtime::read_answer_tool_in_tx(tx, run, sdk).await?,
        }
        .ok_or(Error::new("invalid_evidence"))?;
        let receipt = tool
            .receipt
            .as_ref()
            .ok_or(Error::new("invalid_evidence"))?;
        if !covers_notification(receipt, &query) {
            continue;
        }
        let (_, sources) =
            answer_sources_in_tx(tx, ctx, conv, &tool, expected_tool, checked).await?;
        let scope = source_scope_at_version_in_tx(tx, conv, &query).await?;
        match validate_sources_in_tx(tx, ctx, &conv.id, &scope, &sources, checked).await {
            Ok(()) => {}
            Err(error) if error.code == "source_not_allowed" => continue,
            Err(error) => return Err(error),
        }
        return Ok(Some(
            json!({"task_id":query["task_id"],"condition_version":query["condition_version"]}),
        ));
    }
    Ok(None)
}

// 宿主位置只在首次登记时绑定；恢复直接读取原工具行，不接纳新attempt的替代位置。
pub(super) async fn register_in_tx(
    tx: &mut AppTx<'_>,
    conv: &conversations::LockedConversation,
    run: &runtime::LockedRun,
    input: &Value,
) -> Result<Option<Value>> {
    let finalize = input["tool_name"] == "update_analysis_task"
        && input["arguments"]["action"] == "route"
        && input["arguments"]["finalize_current_answer"] == true;
    if !finalize {
        if input.get("answer_handoff").is_some() {
            return Err(Error::new("invalid_input"));
        }
        return Ok(None);
    }
    let handoff: AnswerHandoff = serde_json::from_value(input["answer_handoff"].clone())
        .map_err(|_| Error::new("invalid_evidence"))?;
    let sdk = text(input, "sdk_tool_call_id")?;
    // rendered分支复用同一原Pi entry身份校验：route冻结时该entry允许以toolUse结束，
    // 但tool_call_ids只含本次route；schema oneOf已保证assistant与rendered互斥。
    let assistant = handoff
        .assistant
        .as_ref()
        .or_else(|| {
            handoff
                .rendered_answer_binding
                .as_ref()
                .map(|b| &b.assistant)
        })
        .ok_or(Error::new("invalid_evidence"))?;
    if assistant.attempt_id != run.attempt_id
        || !matches!(
            assistant.stop_reason,
            StopReason::Stop | StopReason::ToolUse
        )
        || assistant.tool_call_ids != [sdk]
    {
        return Err(Error::new("invalid_evidence"));
    }
    let (task, version) = conversations::active_task_ref_in_tx(tx, conv)
        .await?
        .ok_or(Error::new("task_context_required"))?;
    let tasks = conversations::message_task_ids_in_tx(tx, conv, &run.message_id).await?;
    if !tasks.contains(&task) {
        return Err(Error::new("message_pending"));
    }
    let task_ref = json!({"task_id":task,"condition_version":version.to_string()});
    let scope = scope_in_tx(tx, &conv.id, &task_ref).await?;
    let current = analysis::read_task_in_tx(tx, &conv.id, &task).await?;
    let authority = super::context_authority::generated_text_authority_in_tx(tx, &run.id).await?;
    Ok(Some(json!({
        "handoff":handoff,
        "reference":{"task_ref":task_ref,"finalized_by_sdk_tool_call_id":sdk,
            "scope_fingerprint":fingerprint(&json!({"task_ref":task_ref,"source_limits":scope}))},
        "source_limits":scope,"authority":authority,"title":current["goal"]
    })))
}

pub(super) async fn references_in_tx(
    tx: &mut AppTx<'_>,
    run: &runtime::LockedRun,
) -> Result<Vec<Value>> {
    Ok(runtime::read_answer_handoffs_in_tx(tx, run)
        .await?
        .into_iter()
        .map(|value| value["reference"].clone())
        .collect())
}

// 无parts自然提交只结清单一任务，或恢复链上将被结清任务的范围确实一致；
// 未声明范围不视为一致，显式null只与null一致，集合不同即拒绝。
pub(super) async fn assert_natural_scope_in_tx(
    tx: &mut AppTx<'_>,
    conv: &conversations::LockedConversation,
    run: &runtime::LockedRun,
) -> Result<()> {
    let refs = runtime::delivery_task_refs_in_tx(tx, run).await?;
    let mut settled: Vec<String> = Vec::new();
    for reference in &refs {
        let task_id = reference["task_id"]
            .as_str()
            .ok_or(Error::new("invalid_input"))?;
        if settled.iter().any(|settled| settled == task_id) {
            continue;
        }
        let current = analysis::read_task_in_tx(tx, &conv.id, task_id).await?;
        if current["condition_version"] == reference["condition_version"]
            && current["lifecycle"] != "cancelled"
            && current["phase"] != "waiting_clarification"
        {
            settled.push(task_id.to_owned());
        }
    }
    if settled.len() <= 1 {
        return Ok(());
    }
    let mut shared = None;
    for task_id in &settled {
        let scope = analysis::declared_source_limits_in_tx(tx, &conv.id, task_id)
            .await?
            .ok_or(Error::new("invalid_evidence"))?;
        let keys = if scope.is_null() {
            None
        } else {
            Some(super::source_limits::gate_from_contract(&scope)?.allowed_keys())
        };
        match &shared {
            None => shared = Some(keys),
            Some(expected) if expected == &keys => {}
            _ => return Err(Error::new("invalid_evidence")),
        }
    }
    Ok(())
}

pub(super) async fn check_results(
    pool: &MySqlPool,
    ctx: &AccessContext,
    run_id: &str,
) -> Result<super::context_authority::CheckedTextResults> {
    let cid = runtime::locate_run(pool, run_id).await?;
    let mut tx = AppTx::begin(pool).await?;
    conversations::lock_conversation_in_tx(&mut tx, ctx, &cid).await?;
    let run = runtime::lock_run_in_tx(&mut tx, run_id, &cid).await?;
    let mut authorities: Vec<Value> = runtime::read_answer_handoffs_in_tx(&mut tx, &run)
        .await?
        .into_iter()
        .map(|v| v["authority"].clone())
        .collect();
    authorities.push(
        runtime::read_authority_in_tx(&mut tx, run_id)
            .await?
            .ok_or(Error::new("stale_context"))?,
    );
    for control in runtime::control_deliveries_in_tx(&mut tx, &run).await? {
        if let Some(authority) = control.get("text_authority") {
            authorities.push(authority.clone());
        }
    }
    tx.commit().await?;
    let mut checked = super::context_authority::CheckedTextResults::default();
    checked.include(pool, ctx, &authorities, false).await?;
    Ok(checked)
}

async fn original_text_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    conv: &conversations::LockedConversation,
    run: &runtime::LockedRun,
    value: &Value,
    checked: &super::context_authority::CheckedTextResults,
) -> Result<runtime::OutputReadUnit> {
    let reference = &value["reference"];
    let task = &reference["task_ref"];
    let scope = scope_in_tx(tx, &conv.id, task).await?;
    if scope != value["source_limits"]
        || fingerprint(&json!({"task_ref":task,"source_limits":scope}))
            != text(reference, "scope_fingerprint")?
    {
        return Err(Error::new("stale_context"));
    }
    validate_sources_in_tx(tx, ctx, &conv.id, &scope, &value["authority"], checked).await?;
    let handoff: AnswerHandoff = serde_json::from_value(value["handoff"].clone())
        .map_err(|_| Error::new("invalid_evidence"))?;
    if let Some(sdk) = handoff.answer_sdk_tool_call_id {
        let answer = runtime::read_answer_tool_in_tx(tx, run, &sdk)
            .await?
            .ok_or(Error::new("invalid_evidence"))?;
        let (owner, sources) =
            answer_sources_in_tx(tx, ctx, conv, &answer, "present_analysis_answer", checked)
                .await?;
        if owner.as_ref().is_some_and(|owner| owner != task) {
            return Err(Error::new("invalid_evidence"));
        }
        validate_sources_in_tx(tx, ctx, &conv.id, &scope, &sources, checked).await?;
        let mut authority = value["authority"].clone();
        super::context_authority::merge(&mut authority, &sources)?;
        let receipt = answer
            .receipt
            .as_ref()
            .ok_or(Error::new("invalid_evidence"))?;
        runtime::answer_read_unit(&receipt["data"], authority, &sdk)
    } else if let Some(binding) = &handoff.rendered_answer_binding {
        // rendered冻结读回：prepare回执提供来源与owner，展示正文按binding从
        // source_text+bindings重算并核验原chunk范围，不回读任意文本猜范围。
        let prepared =
            runtime::read_prepare_tool_in_tx(tx, run, &binding.prepared_sdk_tool_call_id)
                .await?
                .ok_or(Error::new("invalid_evidence"))?;
        let (owner, sources) =
            answer_sources_in_tx(tx, ctx, conv, &prepared, "prepare_analysis_answer", checked)
                .await?;
        if owner.as_ref().is_some_and(|owner| owner != task) {
            return Err(Error::new("invalid_evidence"));
        }
        validate_sources_in_tx(tx, ctx, &conv.id, &scope, &sources, checked).await?;
        let mut authority = value["authority"].clone();
        super::context_authority::merge(&mut authority, &sources)?;
        let (text, chunk_range) = runtime::read_rendered_in_tx(tx, run, binding).await?;
        let receipt = prepared
            .receipt
            .as_ref()
            .ok_or(Error::new("invalid_evidence"))?;
        Ok(runtime::OutputReadUnit {
            text,
            authorities: vec![authority],
            result_dependencies: runtime::prepared_dependencies(&receipt["data"])?,
            chunk_range: Some(chunk_range),
            answer_sdk_tool_call_id: None,
            prepared_sdk_tool_call_id: Some(binding.prepared_sdk_tool_call_id.clone()),
        })
    } else {
        let assistant = handoff
            .assistant
            .as_ref()
            .ok_or(Error::new("invalid_evidence"))?;
        Ok(runtime::OutputReadUnit {
            text: runtime::read_bound_output_in_tx(tx, run, assistant).await?,
            authorities: vec![value["authority"].clone()],
            result_dependencies: Vec::new(),
            chunk_range: Some(runtime::OutputChunkRange::from_binding(assistant)?),
            answer_sdk_tool_call_id: None,
            prepared_sdk_tool_call_id: None,
        })
    }
}

pub(super) async fn finalize_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    conv: &conversations::LockedConversation,
    run: &runtime::LockedRun,
    tool: &runtime::LockedTool,
    checked: &super::context_authority::CheckedTextResults,
) -> Result<Value> {
    let value = tool
        .answer_handoff
        .as_ref()
        .ok_or(Error::new("invalid_evidence"))?;
    let task = &value["reference"]["task_ref"];
    let active = conversations::active_task_ref_in_tx(tx, conv).await?;
    if active
        != Some((
            text(task, "task_id")?.to_owned(),
            epoch(text(task, "condition_version")?)?,
        ))
    {
        return Err(Error::new("stale_context"));
    }
    let parts = runtime::read_answer_handoffs_in_tx(tx, run).await?;
    let tasks = conversations::message_task_ids_in_tx(tx, conv, &run.message_id).await?;
    if parts.len() >= tasks.len()
        || parts.len() >= 23
        || parts
            .iter()
            .any(|part| part["reference"]["task_ref"]["task_id"] == task["task_id"])
    {
        return Err(Error::new("invalid_evidence"));
    }
    let body = original_text_in_tx(tx, ctx, conv, run, value, checked).await?;
    if body.text.trim().is_empty() || body.text.chars().count() > 8000 {
        return Err(Error::new("invalid_evidence"));
    }
    // 定稿答案的实际来源查询随引用保存，后续结果通知据此判断是否已覆盖原查询；
    // present与prepare回执的result_dependencies同形，都参与该集合。
    let mut value = value.clone();
    if body.answer_sdk_tool_call_id.is_some() || body.prepared_sdk_tool_call_id.is_some() {
        let mut query_ids: Vec<String> = body
            .result_dependencies
            .iter()
            .map(|(query_id, _)| query_id.clone())
            .collect();
        query_ids.sort();
        query_ids.dedup();
        if !query_ids.is_empty() {
            value["reference"]["source_query_ids"] = json!(query_ids);
        }
    }
    runtime::finalize_answer_handoff_in_tx(tx, run, tool, &value).await?;
    Ok(value)
}

// 24份×(标题8000+正文8000+“## ”和空行5) + 23个分隔7 = 384281 Unicode字符。
// 这是既有单项/标题/数量上限的推导，不是新的模型生成额度。
const MAX_COMBINED_CHARS: usize = 24 * (8000 + 8000 + 5) + 23 * 7;

#[derive(Clone, Copy, PartialEq, Eq)]
enum DeliveryCoverage {
    Frozen,
    Clarification,
    Control,
    NeedsAnalysis,
}

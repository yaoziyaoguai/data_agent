use crate::{
    contracts::generated::{AnswerHandoff, AnswerPartReference, RenderedAnswerBinding, StopReason},
    modules::{analysis, conversations, queries, runtime},
    persistence::AppTx,
    types::{AccessContext, Error, Result, epoch, fingerprint},
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
    cid: &str,
    scope: &Value,
    authority: &Value,
    checked: &super::context_authority::CheckedTextResults,
) -> Result<()> {
    super::context_authority::validate_text_in_tx(tx, ctx, cid, authority, checked).await?;
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
        super::context_authority::generated_text_authority_in_tx(tx, &run.id, &json!({})).await?;
    if notification.is_none() {
        let fields =
            analysis::task_text_authorities_in_tx(tx, &conv.id, text(&task, "task_id")?).await?;
        super::context_authority::merge(&mut authority, &fields["goal"])?;
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
        super::context_authority::generated_text_authority_in_tx(tx, &run.id, &json!({})).await?;
    if notification.is_none() {
        let fields =
            analysis::task_text_authorities_in_tx(tx, &conv.id, text(&task, "task_id")?).await?;
        super::context_authority::merge(&mut authority, &fields["goal"])?;
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
    if run.tool_contract_version != 2 {
        return Err(Error::new("invalid_input"));
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
    let projection = super::source_limits::active_projection_in_tx(tx, conv).await?;
    let (task, version) = projection.task.ok_or(Error::new("task_context_required"))?;
    if !projection.scope_known {
        return Err(Error::new("invalid_evidence"));
    }
    let tasks = conversations::message_task_ids_in_tx(tx, conv, &run.message_id).await?;
    if !tasks.contains(&task) {
        return Err(Error::new("message_pending"));
    }
    let task_ref = json!({"task_id":task,"condition_version":version.to_string()});
    let scope = scope_in_tx(tx, &conv.id, &task_ref).await?;
    let current = analysis::read_task_in_tx(tx, &conv.id, &task).await?;
    let mut authority =
        super::context_authority::generated_text_authority_in_tx(tx, &run.id, &json!({})).await?;
    let fields = analysis::task_text_authorities_in_tx(tx, &conv.id, &task).await?;
    super::context_authority::merge(&mut authority, &fields["goal"])?;
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
    let mut shared: Option<Option<Vec<(String, String)>>> = None;
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
    let mut checked =
        super::context_authority::check_task_text_results(pool, ctx, &cid, None).await?;
    checked.include_authorities(pool, ctx, &authorities).await?;
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

struct TaskDelivery {
    task_id: String,
    version: u64,
    goal: String,
    coverage: DeliveryCoverage,
}

// 通知覆盖只由冻结答案证明，与当前是否可生成控制正文无关。
pub(super) struct ControlDeliveryState {
    pub(super) control_delivery: Option<Value>,
    pub(super) frozen_notification_covered: bool,
}

fn short_goal(goal: &str) -> String {
    const LIMIT: usize = 40;
    let mut text: String = goal.chars().take(LIMIT).collect();
    if goal.chars().count() > LIMIT {
        text.push('…');
    }
    if text.trim().is_empty() {
        "当前任务".to_owned()
    } else {
        text
    }
}

// 本轮最终交付的统一义务视图：冻结正文、任务卡已持久澄清、宿主控制事实各解释一部分；
// 其余任务仍需模型给出分析答案。natural/parts/控制路径共用这一判断。
async fn delivery_coverage_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    conv: &conversations::LockedConversation,
    run: &runtime::LockedRun,
    just_frozen: Option<&Value>,
    checked: &super::context_authority::CheckedTextResults,
) -> Result<(Vec<TaskDelivery>, bool)> {
    let mut task_ids = conversations::message_task_ids_in_tx(tx, conv, &run.message_id).await?;
    task_ids.sort();
    task_ids.dedup();
    let mut frozen = runtime::read_answer_handoffs_in_tx(tx, run).await?;
    // 定稿回执产生时本次handoff仍是registered，按工具行上的原引用一并计入。
    if let Some(handoff) = just_frozen {
        frozen.push(handoff.clone());
    }
    // 正文实际采用的present与prepare回执按工具种类识别，各自接原回执。
    let adopted: Vec<(String, &'static str)> = frozen
        .iter()
        .filter_map(|value| {
            value["handoff"]["answer_sdk_tool_call_id"]
                .as_str()
                .map(|sdk| (sdk.to_owned(), "present_analysis_answer"))
                .or_else(|| {
                    value["handoff"]["rendered_answer_binding"]["prepared_sdk_tool_call_id"]
                        .as_str()
                        .map(|sdk| (sdk.to_owned(), "prepare_analysis_answer"))
                })
        })
        .collect();
    let notification = covered_notification_in_tx(tx, ctx, conv, run, &adopted, checked).await?;
    let mut deliveries = Vec::new();
    for task_id in task_ids {
        let current = analysis::read_task_in_tx(tx, &conv.id, &task_id).await?;
        if current["lifecycle"] == "cancelled" {
            continue;
        }
        let version = epoch(text(&current, "condition_version")?)?;
        let frozen_here = frozen.iter().any(|value| {
            let reference = &value["reference"]["task_ref"];
            reference["task_id"] == current["id"]
                && reference["condition_version"] == current["condition_version"]
        }) || notification.as_ref().is_some_and(|reference| {
            // 旧通知解释原条件；当前新版本无需为本次旧事件另造正文，也不会被结清。
            reference["task_id"] == current["id"]
        });
        let coverage = if frozen_here {
            DeliveryCoverage::Frozen
        } else if current["phase"] == "waiting_clarification" {
            let (clarification, _) =
                analysis::clarification_preview_for_task_in_tx(tx, &task_id).await?;
            if clarification.is_some() {
                DeliveryCoverage::Clarification
            } else {
                DeliveryCoverage::NeedsAnalysis
            }
        } else if queries::task_waiting_phase_in_tx(tx, &task_id, version)
            .await?
            .is_some()
        {
            DeliveryCoverage::Control
        } else {
            DeliveryCoverage::NeedsAnalysis
        };
        deliveries.push(TaskDelivery {
            task_id,
            version,
            goal: current["goal"].as_str().unwrap_or("").to_owned(),
            coverage,
        });
    }
    Ok((deliveries, notification.is_some()))
}

// 新投影保存自身文字的实际来源；旧成功回执按原字段来源核验，不能借run并集放大依赖。
pub(super) async fn validate_control_text_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    conv: &conversations::LockedConversation,
    delivery: &Value,
    checked: &super::context_authority::CheckedTextResults,
) -> Result<()> {
    let mut authority = super::context_authority::empty();
    if let Some(stored) = delivery.get("text_authority") {
        super::context_authority::merge(&mut authority, stored)?;
    } else {
        for reference in delivery["task_refs"].as_array().into_iter().flatten() {
            let task_id = text(reference, "task_id")?;
            let current = analysis::read_task_in_tx(tx, &conv.id, task_id).await?;
            // 旧回执未冻结文字来源；版本推进后当前goal已可能改写，不能替旧正文作保。
            if current["condition_version"] != reference["condition_version"] {
                return Err(Error::new("stale_context"));
            }
            let fields = analysis::task_text_authorities_in_tx(tx, &conv.id, task_id).await?;
            super::context_authority::merge(&mut authority, &fields["goal"])?;
            for fact in delivery["facts"].as_array().into_iter().flatten() {
                if fact["task_id"] == reference["task_id"] && fact["question"].is_string() {
                    super::context_authority::merge(
                        &mut authority,
                        &fields["clarifications"][text(fact, "clarification_id")?],
                    )?;
                }
            }
        }
    }
    let projection = super::source_limits::active_projection_in_tx(tx, conv).await?;
    super::context_authority::validate_text_in_tx(tx, ctx, &conv.id, &authority, checked).await?;
    if (!projection.scope_known && !super::context_authority::has_no_sources(&authority))
        || match projection.gate.as_ref() {
            Some(gate) => {
                !super::source_limits::authority_within_in_tx(tx, ctx, gate, &authority).await?
            }
            None => false,
        }
    {
        return Err(Error::new("source_not_allowed"));
    }
    Ok(())
}

// 只有启动/恢复才接回已完成操作；新工具操作必须从当前事实生成自己的投影。
pub(super) async fn reconnect_control_delivery_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    conv: &conversations::LockedConversation,
    run: &runtime::LockedRun,
    checked: &super::context_authority::CheckedTextResults,
) -> Result<ControlDeliveryState> {
    let mut state = control_delivery_in_tx(tx, ctx, conv, run, checked, None).await?;
    let Some(current) = &state.control_delivery else {
        return Ok(state);
    };
    let fact_keys = current["facts"]
        .as_array()
        .expect("control facts")
        .iter()
        .map(|fact| {
            json!([
                fact["kind"],
                fact["task_id"],
                fact["condition_version"],
                fact["query_id"],
                fact["clarification_id"]
            ])
        })
        .collect::<Vec<_>>();
    let originals = runtime::control_deliveries_in_tx(tx, run).await?;
    let original = originals
        .iter()
        .rev()
        .find(|delivery| {
            delivery["task_refs"] == current["task_refs"]
                && delivery["facts"].as_array().is_some_and(|facts| {
                    let keys = facts
                        .iter()
                        .map(|fact| {
                            json!([
                                fact["kind"],
                                fact["task_id"],
                                fact["condition_version"],
                                fact["query_id"],
                                fact["clarification_id"]
                            ])
                        })
                        .collect::<Vec<_>>();
                    keys.len() == fact_keys.len() && keys.iter().all(|key| fact_keys.contains(key))
                })
        })
        .cloned();
    if let Some(original) = original {
        match validate_control_text_in_tx(tx, ctx, conv, &original, checked).await {
            Ok(()) => state.control_delivery = Some(original),
            Err(error)
                if matches!(
                    error.code,
                    "stale_context"
                        | "stale_knowledge"
                        | "not_available"
                        | "forbidden"
                        | "source_not_allowed"
                ) =>
            {
                state.control_delivery = None;
            }
            Err(error) => return Err(error),
        }
    }
    Ok(state)
}

pub(super) async fn control_delivery_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    conv: &conversations::LockedConversation,
    run: &runtime::LockedRun,
    checked: &super::context_authority::CheckedTextResults,
    just_frozen: Option<&Value>,
) -> Result<ControlDeliveryState> {
    let (deliveries, frozen_notification_covered) =
        delivery_coverage_in_tx(tx, ctx, conv, run, just_frozen, checked).await?;
    let mut state = ControlDeliveryState {
        control_delivery: None,
        frozen_notification_covered,
    };
    if deliveries
        .iter()
        .any(|delivery| delivery.coverage == DeliveryCoverage::NeedsAnalysis)
    {
        return Ok(state);
    }
    let covered: Vec<&TaskDelivery> = deliveries
        .iter()
        .filter(|delivery| {
            matches!(
                delivery.coverage,
                DeliveryCoverage::Control | DeliveryCoverage::Clarification
            )
        })
        .collect();
    if covered.is_empty() {
        return Ok(state);
    }
    let queries = queries::list_in_tx(tx, &conv.id).await?;
    let projection = super::source_limits::active_projection_in_tx(tx, conv).await?;
    let mut authority = super::context_authority::empty();
    let mut task_refs = Vec::new();
    let mut facts = Vec::new();
    let mut lines = Vec::new();
    for delivery in covered {
        let mut visible = json!({"task_id":delivery.task_id,"goal":delivery.goal});
        let mut clarification_has_more = false;
        if delivery.coverage == DeliveryCoverage::Clarification {
            let (clarification, has_more) =
                analysis::clarification_preview_for_task_in_tx(tx, &delivery.task_id).await?;
            visible["clarification"] = clarification.ok_or(Error::new("invalid_evidence"))?;
            clarification_has_more = has_more;
        }
        let clarification_id = visible["clarification"]["id"].clone();
        let text_sources = super::context_authority::protect_task_context_in_tx(
            tx,
            ctx,
            &conv.id,
            &mut visible,
            checked,
            Some(&projection),
        )
        .await?;
        super::context_authority::merge(&mut authority, &text_sources)?;
        let goal = short_goal(visible["goal"].as_str().unwrap_or(""));
        let version = delivery.version.to_string();
        task_refs.push(json!({
            "task_id": delivery.task_id,
            "condition_version": version,
        }));
        match delivery.coverage {
            DeliveryCoverage::Control => {
                let waiting: Vec<&Value> = queries
                    .iter()
                    .filter(|query| {
                        query["task_id"] == delivery.task_id
                            && query["condition_version"].as_str() == Some(version.as_str())
                            && match query["execution_state"].as_str() {
                                Some("not_submitted") => {
                                    query["confirmation_state"] == "awaiting_confirmation"
                                        && query["check_state"] == "passed"
                                }
                                Some(
                                    "queued" | "submitting" | "running" | "submission_unknown",
                                ) => true,
                                _ => false,
                            }
                    })
                    .collect();
                let count = |state: &str| {
                    waiting
                        .iter()
                        .filter(|query| query["execution_state"] == state)
                        .count()
                };
                let mut notes = Vec::new();
                if count("not_submitted") > 0 {
                    notes.push(format!(
                        "{} 条 SQL 已保存，尚未提交执行",
                        count("not_submitted")
                    ));
                }
                if count("queued") > 0 {
                    notes.push(format!("{} 条 SQL 已提交，已加入队列", count("queued")));
                }
                if count("submitting") > 0 {
                    notes.push(format!(
                        "{} 条 SQL 正在提交，尚未获得平台受理回执",
                        count("submitting")
                    ));
                }
                if count("running") > 0 {
                    notes.push(format!(
                        "{} 条 SQL 已提交，平台仍在运行（所引回执的观察）",
                        count("running")
                    ));
                }
                if count("submission_unknown") > 0 {
                    notes.push(format!(
                        "{} 条 SQL 提交回执未知，沿原查询身份查证",
                        count("submission_unknown")
                    ));
                }
                if notes.is_empty() {
                    notes.push("查询状态待确认".to_owned());
                }
                lines.push(format!("任务「{}」：{}。", goal, notes.join("；")));
                for query in waiting {
                    facts.push(json!({
                        "kind":"query",
                        "task_id":delivery.task_id,
                        "condition_version":delivery.version.to_string(),
                        "query_id":query["id"],
                        "execution_state":query["execution_state"],
                        "confirmation_state":query["confirmation_state"],
                    }));
                }
            }
            DeliveryCoverage::Clarification => {
                // 问题和选项须随正式正文交付，且只采用已按来源过滤的持久字段。
                if let Some(question) = visible["clarification"]["question"].as_str() {
                    lines.push(format!("任务「{}」：{}", goal, question));
                    for (index, option) in visible["clarification"]["options"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .enumerate()
                    {
                        lines.push(format!(
                            "{}. {}",
                            index + 1,
                            option.as_str().ok_or(Error::new("invalid_evidence"))?
                        ));
                    }
                    if clarification_has_more {
                        lines.push("本任务还有其他待补充问题，回答当前问题后继续。".to_owned());
                    }
                } else {
                    lines.push(format!("任务「{}」：仍在等待您补充已保存的问题。", goal));
                }
                let mut fact = json!({
                    "kind":"clarification",
                    "task_id":delivery.task_id,
                    "condition_version":delivery.version.to_string(),
                    "clarification_id":clarification_id,
                    "has_more":clarification_has_more,
                });
                if let Some(question) = visible["clarification"].get("question") {
                    fact["question"] = question.clone();
                }
                facts.push(fact);
            }
            DeliveryCoverage::Frozen | DeliveryCoverage::NeedsAnalysis => unreachable!(),
        }
    }
    let text = format!("本轮控制状态：\n{}", lines.join("\n"));
    if text.chars().count() > 8000 {
        return Ok(state);
    }
    let fingerprint = fingerprint(&json!({
        "text":text,
        "task_refs":task_refs,
        "facts":facts,
        "text_authority":authority,
    }));
    state.control_delivery = Some(json!({
        "text":text,
        "task_refs":task_refs,
        "facts":facts,
        "text_authority":authority,
        "fingerprint":fingerprint,
    }));
    Ok(state)
}

// 提交时按指纹接回宿主已经产生的投影；等待状态可能已推进，正文保持回执时的观察。
// 工具账本读取经runtime私有store窄接口，协调层不持SQL入口。
pub(super) async fn stored_control_delivery_in_tx(
    tx: &mut AppTx<'_>,
    run: &runtime::LockedRun,
    fingerprint: &str,
) -> Result<Option<Value>> {
    Ok(runtime::control_deliveries_in_tx(tx, run)
        .await?
        .into_iter()
        .find(|delivery| delivery["fingerprint"].as_str() == Some(fingerprint)))
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn compose_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    conv: &conversations::LockedConversation,
    run: &runtime::LockedRun,
    references: &[AnswerPartReference],
    final_text: Option<&str>,
    checked: &super::context_authority::CheckedTextResults,
    control: Option<&Value>,
) -> Result<runtime::FinalOutput> {
    let parts = runtime::read_answer_handoffs_in_tx(tx, run).await?;
    if run.tool_contract_version != 2
        || (parts.is_empty() && control.is_none())
        || references.len() > 24
        || (control.is_some() && (final_text.is_none() || !references.is_empty()))
    {
        return Err(Error::new("invalid_evidence"));
    }
    let (deliveries, _) = delivery_coverage_in_tx(tx, ctx, conv, run, None, checked).await?;
    let mut units = Vec::new();
    // 新末项仍由final_text单独核对；控制交付只采用已经持久化的冻结项。
    if control.is_none() && references.len() != parts.len() + usize::from(final_text.is_some()) {
        return Err(Error::new("invalid_evidence"));
    }
    for (index, part) in parts.iter().enumerate() {
        if control.is_none()
            && part["reference"]
                != serde_json::to_value(&references[index])
                    .map_err(|_| Error::new("invalid_input"))?
        {
            return Err(Error::new("invalid_evidence"));
        }
        let mut unit = original_text_in_tx(tx, ctx, conv, run, part, checked).await?;
        unit.text = format!("## {}\n\n{}", text(part, "title")?, unit.text);
        units.push(unit);
    }
    // 每个未取消任务都必须由原引用、冻结正文、已持久可见澄清或宿主控制事实解释。
    if let Some(control) = control {
        validate_control_text_in_tx(tx, ctx, conv, control, checked).await?;
        // 控制交付的覆盖由宿主投影task_refs证明；当前等待状态可能已推进。
        let refs = control["task_refs"]
            .as_array()
            .ok_or(Error::new("invalid_evidence"))?;
        for reference in refs {
            let task_id = text(reference, "task_id")?;
            let current = analysis::read_task_in_tx(tx, &conv.id, task_id).await?;
            if current["condition_version"] != reference["condition_version"]
                || current["lifecycle"] == "cancelled"
                || deliveries.iter().any(|delivery| {
                    delivery.task_id == task_id && delivery.coverage == DeliveryCoverage::Frozen
                })
            {
                return Err(Error::new("invalid_evidence"));
            }
        }
        for delivery in &deliveries {
            if delivery.coverage == DeliveryCoverage::Frozen {
                continue;
            }
            let version = delivery.version.to_string();
            if !refs.iter().any(|reference| {
                reference["task_id"] == delivery.task_id
                    && reference["condition_version"].as_str() == Some(version.as_str())
            }) {
                return Err(Error::new("invalid_evidence"));
            }
        }
    } else {
        for delivery in &deliveries {
            if delivery.coverage == DeliveryCoverage::Frozen
                || references
                    .iter()
                    .any(|reference| reference.task_ref.task_id == delivery.task_id)
            {
                continue;
            }
            let allowed = matches!(delivery.coverage, DeliveryCoverage::Clarification);
            if !allowed {
                return Err(Error::new("invalid_evidence"));
            }
        }
    }
    if let Some(control) = control {
        let control_text = control["text"]
            .as_str()
            .ok_or(Error::new("invalid_evidence"))?;
        if final_text != Some(control_text) {
            return Err(Error::new("invalid_evidence"));
        }
        units.push(runtime::OutputReadUnit {
            text: control_text.to_owned(),
            authorities: vec![control["text_authority"].clone()],
            result_dependencies: Vec::new(),
            chunk_range: None,
            answer_sdk_tool_call_id: None,
            prepared_sdk_tool_call_id: None,
        });
    } else if let Some(final_text) = final_text {
        let last = references.last().ok_or(Error::new("invalid_evidence"))?;
        let task = serde_json::to_value(&last.task_ref).map_err(|_| Error::new("invalid_input"))?;
        let last_ref = (
            last.task_ref.task_id.clone(),
            epoch(&last.task_ref.condition_version)?,
        );
        let active = conversations::active_task_ref_in_tx(tx, conv).await?;
        // 结果通知的末项沿原查询任务/条件交付，不把旧结果包装成route后的新版本。
        let notification =
            match conversations::result_query_for_message_in_tx(tx, &conv.id, &run.message_id)
                .await?
            {
                Some(qid) => {
                    let query = queries::read_in_tx(tx, ctx, &qid).await?;
                    Some((
                        qid,
                        text(&query, "task_id")?.to_owned(),
                        epoch(text(&query, "condition_version")?)?,
                    ))
                }
                None => None,
            };
        let notification_matches = notification
            .as_ref()
            .is_some_and(|(_, task_id, version)| *task_id == last_ref.0 && *version == last_ref.1);
        if active.as_ref() != Some(&last_ref) && !notification_matches {
            return Err(Error::new("invalid_evidence"));
        }
        // 一任务冻结后允许一个合法新尾项（如保存结果说明）：按原Pi entry或present
        // 回执身份判重，同一身份不得既冻结又作尾项重复交付；范围一致性仍由上方
        // 活动任务版本核验承担，不按同task一律丢弃，也不开放任意重复冻结。
        let tail_entry = last
            .output_binding
            .as_ref()
            .map(|binding| format!("{}:{}", binding.attempt_id, binding.entry_id))
            .or_else(|| {
                last.rendered_answer_binding.as_ref().map(|rendered| {
                    format!(
                        "{}:{}",
                        rendered.assistant.attempt_id, rendered.assistant.entry_id
                    )
                })
            })
            .or_else(|| last.answer_sdk_tool_call_id.clone())
            .ok_or(Error::new("invalid_evidence"))?;
        for part in parts
            .iter()
            .filter(|part| part["reference"]["task_ref"]["task_id"] == last.task_ref.task_id)
        {
            let handoff = &part["handoff"];
            let assistant = if handoff["assistant"].is_object() {
                Some(&handoff["assistant"])
            } else {
                handoff["rendered_answer_binding"]["assistant"]
                    .is_object()
                    .then(|| &handoff["rendered_answer_binding"]["assistant"])
            };
            if let Some(assistant) = assistant
                && let (Some(attempt), Some(entry)) = (
                    assistant["attempt_id"].as_str(),
                    assistant["entry_id"].as_str(),
                )
                && format!("{}:{}", attempt, entry) == tail_entry
            {
                return Err(Error::new("invalid_evidence"));
            }
            if handoff["answer_sdk_tool_call_id"].as_str() == Some(tail_entry.as_str()) {
                return Err(Error::new("invalid_evidence"));
            }
        }
        let current = analysis::read_task_in_tx(tx, &conv.id, &last.task_ref.task_id).await?;
        let scope = if notification_matches {
            if current["lifecycle"] != "active" {
                return Err(Error::new("task_inactive"));
            }
            analysis::source_limits_at_version_in_tx(
                tx,
                &conv.id,
                &last.task_ref.task_id,
                last_ref.1,
            )
            .await?
            .ok_or(Error::new("task_context_required"))?
        } else {
            scope_in_tx(tx, &conv.id, &task).await?
        };
        let historical =
            notification_matches && current["condition_version"] != task["condition_version"];
        let mut authority =
            super::context_authority::generated_text_authority_in_tx(tx, &run.id, &json!({}))
                .await?;
        if !notification_matches {
            let fields =
                analysis::task_text_authorities_in_tx(tx, &conv.id, &last.task_ref.task_id).await?;
            super::context_authority::merge(&mut authority, &fields["goal"])?;
            validate_sources_in_tx(tx, ctx, &conv.id, &scope, &authority, checked).await?;
        }
        let mut unit = if let Some(binding) = &last.output_binding {
            // 自然输出没有可核验的查询来源，不能证明覆盖结果通知的原查询。
            if notification_matches
                || !matches!(binding.stop_reason, StopReason::Stop)
                || !binding.tool_call_ids.is_empty()
            {
                return Err(Error::new("invalid_evidence"));
            }
            runtime::OutputReadUnit {
                text: runtime::read_bound_output_in_tx(tx, run, binding).await?,
                authorities: vec![authority],
                result_dependencies: Vec::new(),
                chunk_range: Some(runtime::OutputChunkRange::from_binding(binding)?),
                answer_sdk_tool_call_id: None,
                prepared_sdk_tool_call_id: None,
            }
        } else if let Some(binding) = &last.rendered_answer_binding {
            // 渲染末项经prepare回执核验来源与通知覆盖；展示正文按binding重算并核chunk范围。
            let prepared_tool =
                runtime::read_prepare_tool_in_tx(tx, run, &binding.prepared_sdk_tool_call_id)
                    .await?
                    .ok_or(Error::new("invalid_evidence"))?;
            let (owner, source) = answer_sources_in_tx(
                tx,
                ctx,
                conv,
                &prepared_tool,
                "prepare_analysis_answer",
                checked,
            )
            .await?;
            let receipt = prepared_tool
                .receipt
                .as_ref()
                .ok_or(Error::new("invalid_evidence"))?;
            if !notification_matches && owner.as_ref() != Some(&task) {
                return Err(Error::new("invalid_evidence"));
            }
            if notification_matches
                && !receipt["data"]["sources"]
                    .as_array()
                    .is_some_and(|sources| {
                        sources.iter().any(|source| {
                            source["query_id"].as_str()
                                == Some(notification.as_ref().expect("matched").0.as_str())
                                && source["task_id"] == task["task_id"]
                                && source["condition_version"] == task["condition_version"]
                        })
                    })
            {
                return Err(Error::new("invalid_evidence"));
            }
            super::context_authority::merge(&mut authority, &source)?;
            if !scope.is_null()
                && !super::source_limits::authority_within_in_tx(
                    tx,
                    ctx,
                    &super::source_limits::gate_from_contract(&scope)?,
                    &source,
                )
                .await?
            {
                return Err(Error::new("source_not_allowed"));
            }
            let (text, chunk_range) = runtime::read_rendered_in_tx(tx, run, binding).await?;
            runtime::OutputReadUnit {
                text,
                authorities: vec![authority],
                result_dependencies: runtime::prepared_dependencies(&receipt["data"])?,
                chunk_range: Some(chunk_range),
                answer_sdk_tool_call_id: None,
                prepared_sdk_tool_call_id: Some(binding.prepared_sdk_tool_call_id.clone()),
            }
        } else if let Some(sdk) = &last.answer_sdk_tool_call_id {
            let answer = runtime::read_answer_tool_in_tx(tx, run, sdk)
                .await?
                .ok_or(Error::new("invalid_evidence"))?;
            let (owner, source) =
                answer_sources_in_tx(tx, ctx, conv, &answer, "present_analysis_answer", checked)
                    .await?;
            let receipt = answer
                .receipt
                .as_ref()
                .ok_or(Error::new("invalid_evidence"))?;
            if !notification_matches && owner.as_ref() != Some(&task) {
                return Err(Error::new("invalid_evidence"));
            }
            if notification_matches
                && !receipt["data"]["sources"]
                    .as_array()
                    .is_some_and(|sources| {
                        sources.iter().any(|source| {
                            source["query_id"].as_str()
                                == Some(notification.as_ref().expect("matched").0.as_str())
                                && source["task_id"] == task["task_id"]
                                && source["condition_version"] == task["condition_version"]
                        })
                    })
            {
                return Err(Error::new("invalid_evidence"));
            }
            super::context_authority::merge(&mut authority, &source)?;
            if !scope.is_null()
                && !super::source_limits::authority_within_in_tx(
                    tx,
                    ctx,
                    &super::source_limits::gate_from_contract(&scope)?,
                    &source,
                )
                .await?
            {
                return Err(Error::new("source_not_allowed"));
            }
            runtime::answer_read_unit(&receipt["data"], authority, sdk)?
        } else {
            return Err(Error::new("invalid_evidence"));
        };
        if unit.text != final_text {
            return Err(Error::new("invalid_evidence"));
        }
        if notification_matches && !historical {
            let fields =
                analysis::task_text_authorities_in_tx(tx, &conv.id, &last.task_ref.task_id).await?;
            validate_sources_in_tx(tx, ctx, &conv.id, &scope, &fields["goal"], checked).await?;
            unit.authorities.push(fields["goal"].clone());
        }
        let title = if historical {
            "原条件查询结果"
        } else {
            text(&current, "goal")?
        };
        unit.text = format!("## {}\n\n{}", title, unit.text);
        units.push(unit);
    }
    let output = runtime::FinalOutput::compose(units);
    if output.text.chars().count() > MAX_COMBINED_CHARS {
        return Err(Error::new("invalid_input"));
    }
    Ok(output)
}

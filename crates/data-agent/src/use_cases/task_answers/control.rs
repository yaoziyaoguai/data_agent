use super::*;

pub(super) struct TaskDelivery {
    pub(super) task_id: String,
    pub(super) version: u64,
    pub(super) goal: String,
    pub(super) coverage: DeliveryCoverage,
}

// 通知覆盖只由冻结答案证明，与当前是否可生成控制正文无关。
pub(in crate::use_cases) struct ControlDeliveryState {
    pub(in crate::use_cases) control_delivery: Option<Value>,
    pub(in crate::use_cases) frozen_notification_covered: bool,
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
pub(super) async fn delivery_coverage_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    conv: &conversations::LockedConversation,
    run: &runtime::LockedRun,
    just_frozen: Option<&Value>,
    checked: &super::super::context_authority::CheckedTextResults,
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
pub(in crate::use_cases) async fn validate_control_tasks_in_tx(
    tx: &mut AppTx<'_>,
    conv: &conversations::LockedConversation,
    delivery: &Value,
) -> Result<()> {
    for reference in delivery["task_refs"].as_array().into_iter().flatten() {
        let current = analysis::read_task_in_tx(tx, &conv.id, text(reference, "task_id")?).await?;
        if current["condition_version"] != reference["condition_version"] {
            return Err(Error::new("stale_context"));
        }
    }
    Ok(())
}

// 只有启动/恢复才接回已完成操作；新工具操作必须从当前事实生成自己的投影。
pub(in crate::use_cases) async fn reconnect_control_delivery_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    conv: &conversations::LockedConversation,
    run: &runtime::LockedRun,
    checked: &super::super::context_authority::CheckedTextResults,
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
        match validate_control_tasks_in_tx(tx, conv, &original).await {
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

pub(in crate::use_cases) async fn control_delivery_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    conv: &conversations::LockedConversation,
    run: &runtime::LockedRun,
    checked: &super::super::context_authority::CheckedTextResults,
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
    let authority = super::super::context_authority::empty();
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
pub(in crate::use_cases) async fn stored_control_delivery_in_tx(
    tx: &mut AppTx<'_>,
    run: &runtime::LockedRun,
    fingerprint: &str,
) -> Result<Option<Value>> {
    Ok(runtime::control_deliveries_in_tx(tx, run)
        .await?
        .into_iter()
        .find(|delivery| delivery["fingerprint"].as_str() == Some(fingerprint)))
}

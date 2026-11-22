use super::control::delivery_coverage_in_tx;
use super::*;

#[allow(clippy::too_many_arguments)]
pub(in crate::use_cases) async fn compose_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    conv: &conversations::LockedConversation,
    run: &runtime::LockedRun,
    references: &[AnswerPartReference],
    final_text: Option<&str>,
    checked: &super::super::context_authority::CheckedTextResults,
    control: Option<&Value>,
) -> Result<runtime::FinalOutput> {
    let parts = runtime::read_answer_handoffs_in_tx(tx, run).await?;
    if (parts.is_empty() && control.is_none())
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
        validate_control_tasks_in_tx(tx, conv, control).await?;
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
            super::super::context_authority::generated_text_authority_in_tx(tx, &run.id).await?;
        if !notification_matches {
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
            super::super::context_authority::merge(&mut authority, &source)?;
            if !scope.is_null()
                && !super::super::source_limits::authority_within_in_tx(
                    tx,
                    ctx,
                    &super::super::source_limits::gate_from_contract(&scope)?,
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
            super::super::context_authority::merge(&mut authority, &source)?;
            if !scope.is_null()
                && !super::super::source_limits::authority_within_in_tx(
                    tx,
                    ctx,
                    &super::super::source_limits::gate_from_contract(&scope)?,
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

use crate::{
    contracts::generated::{AppendOutput, FinishRun, StopReason},
    modules::{analysis, conversations, jobs, queries, runtime},
    persistence::AppTx,
    types::{AccessContext, Error, Result, epoch, fingerprint, id},
};
use serde_json::{Value, json};
use sqlx::MySqlPool;
use std::collections::BTreeSet;

fn completed_receipt(
    run: &runtime::LockedRun,
    input: &FinishRun,
    fp: &str,
) -> Result<Option<Value>> {
    if let Some(commit) = &run.commit_id {
        if commit != &input.commit_id || run.commit_fingerprint.as_deref() != Some(fp) {
            return Err(Error::new("idempotency_conflict"));
        }
        return Ok(Some(json!({"state":"finished","output_id":run.output_id})));
    }
    Ok(None)
}

pub async fn append_output(
    pool: &MySqlPool,
    context: &AccessContext,
    input: AppendOutput,
) -> Result<Value> {
    let cid = runtime::locate_run(pool, &input.run_id).await?;
    let mut tx = AppTx::begin(pool).await?;
    let conversation = conversations::lock_conversation_in_tx(&mut tx, context, &cid).await?;
    conversations::assert_turn_in_tx(
        &tx,
        &conversation,
        &input.run_id,
        epoch(&input.lease_epoch)?,
    )?;
    let run = runtime::lock_run_in_tx(&mut tx, &input.run_id, &cid).await?;
    if run.state != "running" {
        return Err(Error::new("lease_lost"));
    }
    runtime::append_output_in_tx(&mut tx, &run, epoch(&input.chunk_seq)?, &input.text).await?;
    let event_id = format!("{}-{}", run.attempt_id, input.chunk_seq);
    conversations::append_event_in_tx(&mut tx,&conversation,&event_id,"assistant_delta",json!({"output_id":run.output_id,"attempt_id":run.attempt_id,"chunk_seq":input.chunk_seq,"text":input.text})).await?;
    tx.commit().await?;
    Ok(json!({"chunk_seq":input.chunk_seq}))
}

async fn delivered_result_authority_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    run: &runtime::LockedRun,
) -> Result<Option<Value>> {
    let receipts = runtime::delivered_result_sources_in_tx(tx, run).await?;
    let mut direct = Vec::new();
    let mut historical = Vec::new();
    let mut evidence_ids = BTreeSet::new();
    for receipt in receipts {
        if let Some(query_id) = receipt["query_id"].as_str() {
            direct.push(json!({"query_id":query_id,"result_ref":receipt["result_ref"]}));
        }
        if let Some(results) = receipt["historical_results"]
            .as_array()
            .filter(|v| !v.is_empty())
        {
            historical.push(json!({"actual_sources":{"result_dependencies":results}}));
        }
        evidence_ids.extend(
            super::context_authority::items(&receipt["evidence_ids"])
                .iter()
                .map(|id| {
                    id.as_str()
                        .map(str::to_owned)
                        .ok_or(Error::new("unavailable"))
                })
                .collect::<Result<Vec<_>>>()?,
        );
    }
    if !evidence_ids.is_empty() {
        let ids = evidence_ids.into_iter().collect::<Vec<_>>();
        direct.extend(
            analysis::evidence_result_refs_in_tx(tx, ctx, &run.conversation_id, &ids).await?,
        );
    }
    if direct.is_empty() && historical.is_empty() {
        return Ok(None);
    }
    let mut snapshot =
        super::context_authority::from_sources(&json!({"result_dependencies":direct}))?;
    snapshot["historical_analyses"] = json!(historical);
    Ok(Some(snapshot))
}

pub async fn finish_run(
    pool: &MySqlPool,
    context: &AccessContext,
    input: FinishRun,
) -> Result<Value> {
    let cid = runtime::locate_run(pool, &input.run_id).await?;
    let mut tx = AppTx::begin(pool).await?;
    let mut conversation = conversations::lock_conversation_in_tx(&mut tx, context, &cid).await?;
    let mut run = runtime::lock_run_in_tx(&mut tx, &input.run_id, &cid).await?;
    let fp = fingerprint(
        &serde_json::to_value(&input).map_err(|_| crate::types::Error::new("unavailable"))?,
    );
    if let Some(receipt) = completed_receipt(&run, &input, &fp)? {
        tx.commit().await?;
        return Ok(receipt);
    }
    let candidate_binding = input.output_binding.as_ref().or_else(|| {
        input.answer_parts.as_ref()?.last().and_then(|part| {
            part.finalized_by_sdk_tool_call_id
                .is_none()
                .then_some(part.output_binding.as_ref())
                .flatten()
        })
    });
    let candidate_sdk = input.answer_sdk_tool_call_id.as_deref().or_else(|| {
        let part = input.answer_parts.as_ref()?.last()?;
        part.finalized_by_sdk_tool_call_id
            .is_none()
            .then_some(part.answer_sdk_tool_call_id.as_deref())
            .flatten()
    });
    let candidate_rendered = input.rendered_answer_binding.as_ref().or_else(|| {
        input.answer_parts.as_ref()?.last().and_then(|part| {
            part.finalized_by_sdk_tool_call_id
                .is_none()
                .then_some(part.rendered_answer_binding.as_ref())
                .flatten()
        })
    });
    let checkpoint_prepared = if candidate_binding.is_some()
        || candidate_sdk.is_some()
        || candidate_rendered.is_some()
    {
        conversations::assert_turn_in_tx(
            &tx,
            &conversation,
            &input.run_id,
            epoch(&input.lease_epoch)?,
        )?;
        if let Some(binding) = candidate_binding {
            if !matches!(binding.stop_reason, StopReason::Stop) || !binding.tool_call_ids.is_empty()
            {
                return Err(Error::new("invalid_evidence"));
            }
            let original = runtime::read_bound_output_in_tx(&mut tx, &run, binding).await?;
            if input.final_text.as_deref() != Some(original.as_str()) {
                return Err(Error::new("chunk_gap"));
            }
        } else if let Some(sdk) = candidate_sdk {
            let tool = runtime::read_answer_tool_in_tx(&mut tx, &run, sdk)
                .await?
                .ok_or(Error::new("invalid_evidence"))?;
            if tool.state != "succeeded"
                || tool.receipt.as_ref().is_none_or(|receipt| {
                    receipt["tool_name"] != "present_analysis_answer"
                        || receipt["data"]["answer_text"].as_str() != input.final_text.as_deref()
                })
            {
                return Err(Error::new("invalid_evidence"));
            }
        } else if let Some(binding) = candidate_rendered {
            // 渲染候选按原prepare回执与chunk范围核验display；final_text即该份display。
            let (display, _) = runtime::read_rendered_in_tx(&mut tx, &run, binding).await?;
            if input.final_text.as_deref() != Some(display.as_str()) {
                return Err(Error::new("chunk_gap"));
            }
        }
        // 候选先进入宿主确认的恢复leaf；正式正文/来源/完成状态仍在最终事务原子提交。
        runtime::save_checkpoint_in_tx(
            &mut tx,
            &run,
            &serde_json::to_value(&input.checkpoint)
                .map_err(|_| crate::types::Error::new("unavailable"))?,
        )
        .await?;
        tx.commit().await?;
        if cfg!(debug_assertions)
            && std::env::var("DATA_AGENT_FAULT").as_deref() == Ok("after_output_checkpoint")
        {
            return Err(Error::new("unavailable"));
        }
        tx = AppTx::begin(pool).await?;
        conversation = conversations::lock_conversation_in_tx(&mut tx, context, &cid).await?;
        run = runtime::lock_run_in_tx(&mut tx, &input.run_id, &cid).await?;
        if let Some(receipt) = completed_receipt(&run, &input, &fp)? {
            tx.commit().await?;
            return Ok(receipt);
        }
        true
    } else {
        false
    };
    let bound_answer = input.answer_parts.is_some()
        || input.control_delivery_ref.is_some()
        || input.answer_sdk_tool_call_id.is_some()
        || input.rendered_answer_binding.is_some();
    let delivered_results = if bound_answer {
        None
    } else {
        delivered_result_authority_in_tx(&mut tx, context, &run).await?
    };
    let read_skills = if !bound_answer && input.final_text.is_some() {
        Some(
            super::personal_assets::read_skill_authority_in_tx(
                &mut tx,
                context,
                &cid,
                &run.recovery_chain_id,
                Some(&run.id),
            )
            .await?,
        )
        .filter(super::context_authority::has_sources)
    } else {
        None
    };
    let checked_answer = if bound_answer || delivered_results.is_some() || read_skills.is_some() {
        tx.commit().await?;
        let checked = if bound_answer {
            Some(super::task_answers::check_results(pool, context, &input.run_id).await?)
        } else {
            // 普通正文核对本输入真正采用的结果和 Skill。
            let mut results = super::context_authority::CheckedTextResults::default();
            for snapshot in delivered_results.iter().chain(&read_skills) {
                results
                    .include(pool, context, std::slice::from_ref(snapshot), false)
                    .await?;
                if !results.allows(snapshot, false) {
                    return Err(Error::new("stale_context"));
                }
            }
            Some(results)
        };
        tx = AppTx::begin(pool).await?;
        conversation = conversations::lock_conversation_in_tx(&mut tx, context, &cid).await?;
        run = runtime::lock_run_in_tx(&mut tx, &input.run_id, &cid).await?;
        if let Some(receipt) = completed_receipt(&run, &input, &fp)? {
            tx.commit().await?;
            return Ok(receipt);
        }
        if let (Some(authority), Some(results)) = (&read_skills, &checked) {
            super::personal_assets::assert_read_skill_authority_in_tx(
                &mut tx, context, authority, results,
            )
            .await?;
        }
        checked
    } else {
        None
    };
    conversations::assert_turn_in_tx(
        &tx,
        &conversation,
        &input.run_id,
        epoch(&input.lease_epoch)?,
    )?;
    if std::env::var("DATA_AGENT_TOOLSET").as_deref() == Ok("data") {
        conversations::assert_routed_in_tx(&mut tx, &conversation, &run.message_id).await?;
    }
    // 已冻结的前项不能借省略新字段落回单答案提交；宿主控制交付有独立引用。
    if input.answer_parts.is_none()
        && input.control_delivery_ref.is_none()
        && !runtime::read_answer_handoffs_in_tx(&mut tx, &run)
            .await?
            .is_empty()
    {
        return Err(Error::new("invalid_evidence"));
    }
    if input.answer_parts.is_some() && input.control_delivery_ref.is_some() {
        return Err(Error::new("invalid_input"));
    }
    // 控制交付只接回宿主已产生的成功回执投影，不信任客户端正文。
    let control_delivery = if let Some(reference) = &input.control_delivery_ref {
        Some(
            super::task_answers::stored_control_delivery_in_tx(
                &mut tx,
                &run,
                reference.fingerprint.as_str(),
            )
            .await?
            .ok_or(Error::new("invalid_evidence"))?,
        )
    } else {
        None
    };
    let final_start = input
        .final_start_chunk_seq
        .as_deref()
        .map(epoch)
        .transpose()?
        .unwrap_or(1);
    let output = if let Some(parts) = &input.answer_parts {
        if input.answer_sdk_tool_call_id.is_some() {
            return Err(Error::new("invalid_input"));
        }
        super::task_answers::compose_in_tx(
            &mut tx,
            context,
            &conversation,
            &run,
            parts,
            input.final_text.as_deref(),
            checked_answer
                .as_ref()
                .ok_or(crate::types::Error::new("invalid_input"))?,
            None,
        )
        .await?
    } else if control_delivery.is_some() {
        super::task_answers::compose_in_tx(
            &mut tx,
            context,
            &conversation,
            &run,
            &[],
            input.final_text.as_deref(),
            checked_answer
                .as_ref()
                .ok_or(crate::types::Error::new("invalid_input"))?,
            control_delivery.as_ref(),
        )
        .await?
    } else {
        let final_text = input
            .final_text
            .as_deref()
            .ok_or(Error::new("invalid_input"))?;
        let mut unit = if let Some(sdk_id) = &input.answer_sdk_tool_call_id {
            let (_, unit) = super::task_answers::single_answer_in_tx(
                &mut tx,
                context,
                &conversation,
                &run,
                sdk_id,
                checked_answer
                    .as_ref()
                    .ok_or(crate::types::Error::new("invalid_input"))?,
            )
            .await?;
            if unit.text != final_text {
                return Err(Error::new("invalid_evidence"));
            }
            // 来源核验、片段和正式正文同事务，不先广播未经最终核验的delta。
            runtime::append_output_in_tx(&mut tx, &run, final_start, final_text).await?;
            unit
        } else if let Some(binding) = &input.rendered_answer_binding {
            let (_, unit) = super::task_answers::rendered_answer_in_tx(
                &mut tx,
                context,
                &conversation,
                &run,
                binding,
                checked_answer
                    .as_ref()
                    .ok_or(crate::types::Error::new("invalid_input"))?,
            )
            .await?;
            if unit.text != final_text {
                return Err(Error::new("invalid_evidence"));
            }
            // 展示chunks在流式期间已按展示文本追加；此处不再重复写入，
            // chunk范围与正文一致性已由read_rendered_in_tx按原prepare回执核验。
            unit
        } else {
            runtime::OutputReadUnit {
                text: final_text.to_owned(),
                authorities: vec![
                    runtime::read_authority_in_tx(&mut tx, &run.id)
                        .await?
                        .unwrap_or(Value::Null),
                ],
                result_dependencies: Vec::new(),
                chunk_range: None,
                answer_sdk_tool_call_id: None,
                prepared_sdk_tool_call_id: None,
            }
        };
        if let Some(binding) = &input.output_binding {
            let persisted = runtime::read_bound_output_in_tx(&mut tx, &run, binding).await?;
            if persisted != final_text {
                return Err(Error::new("chunk_gap"));
            }
            unit.chunk_range = Some(runtime::OutputChunkRange::from_binding(binding)?);
        } else if input.rendered_answer_binding.is_none() {
            let (persisted, range) =
                runtime::read_output_text_in_tx(&mut tx, &run, final_start).await?;
            if persisted != final_text {
                return Err(Error::new("chunk_gap"));
            }
            unit.chunk_range = Some(range);
        }
        runtime::FinalOutput::compose(vec![unit])
    };
    if !checkpoint_prepared {
        runtime::save_checkpoint_in_tx(
            &mut tx,
            &run,
            &serde_json::to_value(&input.checkpoint)
                .map_err(|_| crate::types::Error::new("unavailable"))?,
        )
        .await?;
    }
    if let Some(parts) = &input.answer_parts {
        runtime::save_output_answer_parts_in_tx(
            &mut tx,
            &run,
            &serde_json::to_value(parts).map_err(|_| crate::types::Error::new("unavailable"))?,
        )
        .await?;
    }
    runtime::commit_run_in_tx(&mut tx, &run, &input.commit_id, &fp, &output).await?;
    if std::env::var("DATA_AGENT_TOOLSET").as_deref() == Ok("data") {
        // 无parts提交不能把范围不同的多个任务一起结清；范围确实一致才允许自然综合。
        // 宿主结果通知沿原query/condition推进，不要求它为历史任务补交parts。
        // 旧answer_sdk单份与rendered单份同属无parts提交，沿用同一范围门，不只豁免旧回执。
        if input.answer_parts.is_none()
            && input.control_delivery_ref.is_none()
            && conversations::result_query_for_message_in_tx(&mut tx, &cid, &run.message_id)
                .await?
                .is_none()
        {
            super::task_answers::assert_natural_scope_in_tx(&mut tx, &conversation, &run).await?;
        }
        let mut refs = if let Some(parts) = &input.answer_parts {
            parts
                .iter()
                .map(|part| {
                    serde_json::to_value(&part.task_ref).map_err(|_| Error::new("unavailable"))
                })
                .collect::<Result<_>>()?
        } else if let Some(query_id) =
            conversations::result_query_for_message_in_tx(&mut tx, &cid, &run.message_id).await?
        {
            // 宿主结果唤醒的交付只推进原查询版本；route到当前任务不能把旧结果升级为新答案。
            vec![queries::read_in_tx(&mut tx, context, &query_id).await?]
        } else {
            runtime::delivery_task_refs_in_tx(&mut tx, &run).await?
        };
        if let Some(checked) = &checked_answer
            && let Some(reference) = super::task_answers::covered_notification_in_tx(
                &mut tx,
                context,
                &conversation,
                &run,
                &output.adopted_answer_tools(),
                checked,
            )
            .await?
            && !refs.iter().any(|existing| {
                existing["task_id"] == reference["task_id"]
                    && existing["condition_version"] == reference["condition_version"]
            })
        {
            refs.push(reference);
        }
        analysis::lock_tasks_in_tx(&mut tx, &cid).await?;
        // 仅控制确认不结清分析：未被冻结正文解释的任务只推进等待相位，
        // 分析完成仍由真实交付的分析正文或结果通知推进。
        let frozen_refs: std::collections::BTreeSet<(String, String)> =
            if input.control_delivery_ref.is_some() {
                runtime::read_answer_handoffs_in_tx(&mut tx, &run)
                    .await?
                    .iter()
                    .filter_map(|handoff| {
                        let task_ref = &handoff["reference"]["task_ref"];
                        Some((
                            task_ref["task_id"].as_str()?.to_owned(),
                            task_ref["condition_version"].as_str()?.to_owned(),
                        ))
                    })
                    .collect()
            } else {
                Default::default()
            };
        for reference in refs {
            let task_id = reference["task_id"]
                .as_str()
                .ok_or(Error::new("invalid_input"))?;
            let version = epoch(
                reference["condition_version"]
                    .as_str()
                    .ok_or(Error::new("invalid_input"))?,
            )?;
            let task = analysis::read_task_in_tx(&mut tx, &cid, task_id).await?;
            // 回答只属于提交时的原条件版本；开放澄清和其他查询仍保留可操作阶段。
            if task["condition_version"] == reference["condition_version"]
                && task["phase"] != "waiting_clarification"
            {
                match queries::task_waiting_phase_in_tx(&mut tx, task_id, version).await? {
                    Some(phase) => {
                        analysis::set_phase_in_tx(&mut tx, task_id, version, phase).await?;
                    }
                    None if input.control_delivery_ref.is_none()
                        || frozen_refs.contains(&(
                            task_id.to_owned(),
                            reference["condition_version"]
                                .as_str()
                                .unwrap_or("")
                                .to_owned(),
                        )) =>
                    {
                        analysis::set_phase_in_tx(&mut tx, task_id, version, "answered").await?;
                    }
                    // 控制确认覆盖且无等待相位：分析义务未被解释，保持原相位等待结果通知。
                    None => {}
                }
            }
        }
    }
    conversations::commit_consumption_in_tx(&mut tx, &conversation, &run.message_id).await?;
    conversations::append_event_in_tx(
        &mut tx,
        &conversation,
        &id(),
        "assistant_committed",
        json!({"output_id":run.output_id,"attempt_id":run.attempt_id,"text":output.text}),
    )
    .await?;
    conversations::release_turn_in_tx(&mut tx, &conversation, &input.run_id, run.lease_epoch)
        .await?;
    jobs::settle_in_tx(&mut tx, &run.job_id, run.job_lease_epoch).await?;
    tx.commit().await?;
    Ok(json!({"state":"finished","output_id":run.output_id}))
}

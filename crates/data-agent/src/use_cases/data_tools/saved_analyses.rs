use super::*;

#[allow(clippy::too_many_arguments)]
pub(super) async fn query(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    conv: &conversations::LockedConversation,
    run: &runtime::LockedRun,
    args: &Value,
    external: Option<&Value>,
    source_gate: Option<&super::super::source_limits::SourceGate>,
    text_results: &super::super::context_authority::CheckedTextResults,
) -> Result<Value> {
    let qid = text(args, "query_id")?;
    let mut q = queries::read_in_tx(tx, ctx, qid).await?;
    if q["conversation_id"] != conv.id {
        return Err(Error::new("not_available"));
    }
    // 历史查询交付保存时正文和条件；撤权仍隐藏正文，历史读取不授予当前采用资格。
    let outcome = super::super::query_workflow::protect_text_outcome_in_tx(
        tx,
        ctx,
        &conv.id,
        &q,
        text_results,
    )
    .await?;
    if let Some(gate) = source_gate
        && !matches!(
            outcome,
            super::super::query_workflow::ProtectedText::Restricted
        )
    {
        let authority = match &outcome {
            super::super::query_workflow::ProtectedText::Current(authority) => {
                let mut authority = authority.clone();
                if let Some(result) = external.filter(|result| result["error"].is_null()) {
                    super::super::context_authority::observe(&mut authority, result);
                }
                authority
            }
            super::super::query_workflow::ProtectedText::Historical { entry, .. } => {
                entry["actual_sources"]["authority"].clone()
            }
            super::super::query_workflow::ProtectedText::Restricted => unreachable!(),
        };
        if !super::super::source_limits::authority_within_in_tx(tx, ctx, gate, &authority).await? {
            return Err(Error::new("source_not_allowed"));
        }
    }
    if let super::super::query_workflow::ProtectedText::Current(authority) = &outcome {
        super::super::context_authority::merge_run_in_tx(tx, &run.id, authority).await?;
    }
    Ok(match outcome {
        super::super::query_workflow::ProtectedText::Current(_) => {
            if q["execution_state"] == "succeeded"
                && queries::is_confirmation_message_in_tx(tx, ctx, qid, &run.message_id).await?
            {
                // 快查询也只在已有的结果交付轮解释，避免执行轮与结果通知重复作答。
                json!({"query":q,"results":null,"hint":"本消息刚提交的查询已完成。请结束本轮，系统会自动交付结果并续接解释；不要继续轮询或在本轮推断结果。"})
            } else {
                json!({"query":q,"results":external})
            }
        }
        super::super::query_workflow::ProtectedText::Historical { entry, conditions } => {
            super::super::context_authority::merge_run_in_tx(
                tx,
                &run.id,
                &super::super::historical_analysis::carrying(&entry),
            )
            .await?;
            let content = json!({"sql":q["sql"],"parameters":q["parameters"],
                        "summary":q["summary"],"semantic_resolution":q["semantic_resolution"],
                        "conditions":conditions});
            q = super::super::query_workflow::control_projection(q);
            super::super::historical_analysis::content_page(
                json!({"query":q,"results":null,"historical_analysis":entry,
                            "hint":"这是保存时的SQL、原条件和说明，只用于复述当时的分析。当前口径与新执行仍需重新核对。正文按content_page.next_offset用content_offset续读。"}),
                &content,
                args["content_offset"].as_u64().unwrap_or(0) as usize,
                8192,
            )?
        }
        super::super::query_workflow::ProtectedText::Restricted => {
            q = super::super::query_workflow::control_projection(q);
            json!({"query":q,"results":null,"hint":"查询正文来源已失效或缺少完整记录；只返回原状态，可停止查询，不能据此确认执行或恢复旧正文。"})
        }
    })
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn read_report(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    conv: &conversations::LockedConversation,
    run: &runtime::LockedRun,
    args: &Value,
    external: Option<&Value>,
    source_gate: Option<&super::super::source_limits::SourceGate>,
    text_results: &super::super::context_authority::CheckedTextResults,
) -> Result<Value> {
    let checked = external.ok_or(Error::new("invalid_evidence"))?;
    let text_authority = super::super::analysis_reports::assert_page_in_tx(
        tx,
        ctx,
        &conv.id,
        args,
        checked,
        text_results,
    )
    .await?;
    if let Some(gate) = source_gate
        && !super::super::source_limits::authority_within_in_tx(tx, ctx, gate, &text_authority)
            .await?
    {
        return Err(Error::new("source_not_allowed"));
    }
    super::super::context_authority::merge_run_in_tx(tx, &run.id, &text_authority).await?;
    if checked["page"]["status"] == "available" {
        super::super::context_authority::merge_run_in_tx(
            tx,
            &run.id,
            &super::super::context_authority::from_sources(&checked["sources"]),
        )
        .await?;
    }
    Ok(checked["page"].clone())
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn save_report(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    conv: &conversations::LockedConversation,
    run: &runtime::LockedRun,
    operation: &str,
    args: &Value,
    external: Option<&Value>,
    text_results: &super::super::context_authority::CheckedTextResults,
) -> Result<Value> {
    conversations::assert_routed_in_tx(tx, conv, &run.message_id).await?;
    if !conversations::message_task_ids_in_tx(tx, conv, &run.message_id)
        .await?
        .iter()
        .any(|task| args["task_id"] == *task)
    {
        return Err(Error::new("invalid_evidence"));
    }
    let evidence = external.ok_or(Error::new("invalid_evidence"))?;
    let receipt = super::super::analysis_reports::save_in_tx(
        tx,
        ctx,
        conv,
        super::super::analysis_reports::ReportWrite {
            operation_id: operation,
            message_id: &run.message_id,
        },
        args,
        evidence,
        text_results,
    )
    .await?;
    let adopted = super::super::analysis_reports::sources(evidence)?;
    super::super::context_authority::merge_run_in_tx(
        tx,
        &run.id,
        &super::super::context_authority::from_sources(&adopted),
    )
    .await?;
    conversations::append_event_in_tx(tx, conv, &id(), "analysis_report_saved", receipt.clone())
        .await?;
    Ok(receipt)
}

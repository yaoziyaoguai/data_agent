use super::*;

pub(super) async fn task(
    tx: &mut AppTx<'_>,
    conv: &conversations::LockedConversation,
    args: &Value,
) -> Result<Value> {
    let requested_version = args["condition_version"].as_str().map(epoch).transpose()?;
    let mut task = analysis::read_task_with_clarifications_in_tx(
        tx,
        &conv.id,
        text(args, "task_id")?,
        args["clarification_after"].as_str(),
        requested_version,
    )
    .await?;
    if let Some(version) = requested_version
        && task["decision_state_version"] == 1
        && task["conditions"].is_object()
        && let Some(update) =
            runtime::task_condition_update_in_tx(tx, &conv.id, text(args, "task_id")?, version)
                .await?
        && task["conditions"] == update.conditions
    {
        let original = conversations::read_message_in_tx(tx, conv, &update.message_id).await?;
        task["revision_origin"] = json!({
            "operation_id":update.operation_id,"origin_run_id":update.origin_run_id,
            "message_id":update.message_id,"user_supplied":original.user_supplied,
            "user_quote":original.user_supplied.then_some(original.body),
        });
    }
    Ok(task)
}

pub(super) async fn history(
    tx: &mut AppTx<'_>,
    conv: &conversations::LockedConversation,
    args: &Value,
) -> Result<Value> {
    Ok(if args["task_directory"] == true {
        analysis::task_directory_in_tx(tx, &conv.id, args["task_after"].as_str()).await?
    } else if let Some(message_id) = args["message_id"].as_str() {
        let message = conversations::read_message_in_tx(tx, conv, message_id).await?;
        if message.disposition == "withdrawn" {
            return Err(Error::new("not_available"));
        }
        let (body, page) = retrieval::text_page(
            &message.body,
            args["offset"].as_u64().unwrap_or(0) as usize,
            2048,
        );
        json!({"message_id":message.id,"text":body,"content_page":page})
    } else {
        let mut events =
            conversations::model_history_in_tx(tx, conv, epoch(text(args, "after_seq")?)?).await?;
        for event in &mut events {
            let (body, page) =
                retrieval::text_page(event["payload"]["text"].as_str().unwrap_or(""), 0, 800);
            event["payload"]["text"] = json!(body);
            event["payload"]["content_page"] = page;
        }
        let mut limited = false;
        while events.len() > 1
            && serde_json::to_vec(&events)
                .map_err(|_| crate::types::Error::new("unavailable"))?
                .len()
                > 12000
        {
            events.pop();
            limited = true;
        }
        let last = events.last().map(|v| v["event_seq"].clone());
        json!({"events":events,"next_after_seq":last,"page_limited":limited,"note":"仅返回未撤回用户输入的有界页。按next_after_seq继续翻页，正文片段不完整时用message_id及offset分块读取；旧助手和工具结论需重新调查；任务用read_analysis_task读取。"})
    })
}

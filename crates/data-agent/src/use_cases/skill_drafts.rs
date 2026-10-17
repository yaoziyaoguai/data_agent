use crate::{
    contracts,
    modules::{analysis, assets, conversations, queries, runtime},
    persistence::AppTx,
    types::{AccessContext, Error, Result, epoch},
};
use serde_json::{Value, json};
use sqlx::MySqlPool;

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key].as_str().ok_or(Error::new("invalid_input"))
}

fn unavailable_source(error: &Error) -> bool {
    matches!(
        error.code,
        "result_expired"
            | "result_unavailable"
            | "forbidden"
            | "not_available"
            | "stale_knowledge"
            | "invalid_evidence"
    )
}

async fn user_source_in_tx(
    tx: &mut AppTx<'_>,
    conversation: &conversations::LockedConversation,
    message_id: &str,
    quote: Option<&str>,
) -> Result<()> {
    let message = conversations::read_message_in_tx(tx, conversation, message_id).await?;
    if message.disposition == "withdrawn"
        || (quote.is_some()
            && (message.disposition != "pending"
                || quote.map(str::trim) != Some(message.body.trim())))
        || conversations::result_query_for_message_in_tx(tx, &conversation.id, &message.id)
            .await?
            .is_some()
    {
        return Err(Error::new("invalid_evidence"));
    }
    Ok(())
}

async fn evidence_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    cid: &str,
    task: &str,
    version: &Value,
    requested: &Value,
    saved_refs: bool,
) -> Result<Value> {
    let mut evidence = Vec::new();
    for requested in requested.as_array().ok_or(Error::new("invalid_evidence"))? {
        let evidence_id = if saved_refs {
            text(requested, "evidence_id")?
        } else {
            requested.as_str().ok_or(Error::new("invalid_evidence"))?
        };
        let current = analysis::read_evidence_in_tx(tx, ctx, evidence_id).await?;
        let reference = &current["reference"];
        if reference["conversation_id"] != cid
            || reference["task_id"] != task
            || reference["condition_version"] != *version
            || (saved_refs && reference != requested)
        {
            return Err(Error::new("invalid_evidence"));
        }
        evidence.push(current);
    }
    if evidence.is_empty() {
        return Err(Error::new("invalid_evidence"));
    }
    let evidence = json!(evidence);
    let sources = super::analysis_reports::sources(&evidence)?;
    // 原生Skill沿用正式资产的50条依赖上限，不能准备无法确认保存的草稿。
    if sources["knowledge_refs"]
        .as_array()
        .is_none_or(|refs| refs.len() > 50)
    {
        return Err(Error::new("payload_limit"));
    }
    super::knowledge::check_refs_in_tx(tx, ctx, &sources["knowledge_refs"]).await?;
    for reference in sources["result_dependencies"]
        .as_array()
        .expect("checked sources")
    {
        let query = queries::read_in_tx(tx, ctx, text(reference, "query_id")?).await?;
        if query["conversation_id"] != cid
            || query["task_id"] != task
            || query["condition_version"] != *version
            || query["execution_state"] != "succeeded"
            || query["result_ref"] != reference["result_ref"]
        {
            return Err(Error::new("invalid_evidence"));
        }
        super::knowledge::check_refs_in_tx(tx, ctx, &query["knowledge_refs"]).await?;
    }
    Ok(evidence)
}

async fn result_sources(pool: &MySqlPool, ctx: &AccessContext, evidence: &Value) -> Result<()> {
    let sources = super::analysis_reports::sources(evidence)?;
    for reference in sources["result_dependencies"]
        .as_array()
        .expect("checked sources")
    {
        super::query_workflow::result_authority(
            pool,
            ctx,
            text(reference, "query_id")?,
            text(reference, "result_ref")?,
        )
        .await?;
    }
    Ok(())
}

pub async fn validate_sources(
    pool: &MySqlPool,
    ctx: &AccessContext,
    cid: &str,
    message: &str,
    input: &Value,
) -> Result<Value> {
    contracts::validate("PrepareSkillDraftInput", input)?;
    let mut tx = AppTx::begin(pool).await?;
    let conversation = conversations::lock_conversation_in_tx(&mut tx, ctx, cid).await?;
    user_source_in_tx(
        &mut tx,
        &conversation,
        message,
        Some(text(input, "instruction_quote")?),
    )
    .await?;
    analysis::assert_current_in_tx(
        &mut tx,
        cid,
        text(input, "task_id")?,
        epoch(text(input, "condition_version")?)?,
    )
    .await?;
    let evidence = evidence_in_tx(
        &mut tx,
        ctx,
        cid,
        text(input, "task_id")?,
        &input["condition_version"],
        &input["evidence_ids"],
        false,
    )
    .await?;
    tx.commit().await?;
    result_sources(pool, ctx, &evidence).await?;
    Ok(evidence)
}

pub async fn prepare_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    conversation: &conversations::LockedConversation,
    run: &runtime::LockedRun,
    tool: &runtime::LockedTool,
    input: &Value,
    checked: &Value,
) -> Result<Value> {
    user_source_in_tx(
        tx,
        conversation,
        &run.message_id,
        Some(text(input, "instruction_quote")?),
    )
    .await?;
    conversations::assert_routed_in_tx(tx, conversation, &run.message_id).await?;
    if !conversations::message_task_ids_in_tx(tx, conversation, &run.message_id)
        .await?
        .iter()
        .any(|task| input["task_id"] == *task)
    {
        return Err(Error::new("invalid_evidence"));
    }
    analysis::lock_tasks_in_tx(tx, &conversation.id).await?;
    analysis::assert_current_in_tx(
        tx,
        &conversation.id,
        text(input, "task_id")?,
        epoch(text(input, "condition_version")?)?,
    )
    .await?;
    let evidence = evidence_in_tx(
        tx,
        ctx,
        &conversation.id,
        text(input, "task_id")?,
        &input["condition_version"],
        &input["evidence_ids"],
        false,
    )
    .await?;
    if evidence != *checked {
        return Err(Error::new("invalid_evidence"));
    }
    let sources = super::analysis_reports::sources(&evidence)?;
    let references = json!(
        evidence
            .as_array()
            .expect("checked evidence")
            .iter()
            .map(|item| item["reference"].clone())
            .collect::<Vec<_>>()
    );
    let reference = assets::skill_drafts::prepare_in_tx(
        tx,
        ctx,
        assets::skill_drafts::DraftOrigin {
            conversation_id: &conversation.id,
            operation_id: &tool.operation_id,
            source_message_id: &run.message_id,
            origin_run_id: &tool.origin_run_id,
        },
        input,
        &sources["knowledge_refs"],
        &references,
    )
    .await?;
    super::context_authority::extend_run_in_tx(tx, &run.id, &sources["knowledge_refs"]).await?;
    super::context_authority::extend_result_dependencies_in_tx(
        tx,
        &run.id,
        &sources["result_dependencies"],
    )
    .await?;
    Ok(reference)
}

async fn check_pending_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    conversation: &conversations::LockedConversation,
    draft: &assets::skill_drafts::StoredDraft,
) -> Result<Value> {
    if draft.state != "pending" || conversation.deleted {
        return Err(Error::new("not_available"));
    }
    let reference = &draft.reference;
    user_source_in_tx(
        tx,
        conversation,
        text(reference, "source_message_id")?,
        None,
    )
    .await?;
    let task = analysis::read_task_in_tx(tx, &conversation.id, text(reference, "task_id")?).await?;
    if task["condition_version"] != reference["condition_version"] || task["lifecycle"] != "active"
    {
        return Err(Error::new("version_conflict"));
    }
    let body = draft.body.as_ref().ok_or(Error::new("invalid_input"))?;
    let evidence = evidence_in_tx(
        tx,
        ctx,
        &conversation.id,
        text(reference, "task_id")?,
        &reference["condition_version"],
        &body["evidence_refs"],
        true,
    )
    .await?;
    if super::analysis_reports::sources(&evidence)?["knowledge_refs"] != body["dependencies"] {
        return Err(Error::new("invalid_evidence"));
    }
    Ok(evidence)
}

pub async fn read(pool: &MySqlPool, ctx: &AccessContext, draft_id: &str) -> Result<Value> {
    let mut tx = AppTx::begin(pool).await?;
    let reference = assets::skill_drafts::locate_in_tx(&mut tx, ctx, draft_id).await?;
    let conversation =
        conversations::lock_for_cleanup_in_tx(&mut tx, ctx, text(&reference, "conversation_id")?)
            .await?;
    let draft = assets::skill_drafts::read_in_tx(&mut tx, ctx, draft_id).await?;
    if draft.state != "pending" {
        let view = draft.view()?;
        tx.commit().await?;
        return Ok(view);
    }
    let local = check_pending_in_tx(&mut tx, ctx, &conversation, &draft).await;
    if let Err(error) = &local {
        let status = if error.code == "version_conflict" {
            "condition_changed"
        } else if unavailable_source(error) {
            "sources_unavailable"
        } else {
            return Err(Error::new(error.code));
        };
        assets::skill_drafts::invalidate_in_tx(&mut tx, ctx, draft_id, status).await?;
        tx.commit().await?;
        return Ok(json!({"status":status,"reference":reference}));
    }
    let evidence = local?;
    tx.commit().await?;
    if let Err(error) = result_sources(pool, ctx, &evidence).await {
        if !unavailable_source(&error) {
            return Err(error);
        }
        let mut tx = AppTx::begin(pool).await?;
        conversations::lock_for_cleanup_in_tx(&mut tx, ctx, text(&reference, "conversation_id")?)
            .await?;
        assets::skill_drafts::invalidate_in_tx(&mut tx, ctx, draft_id, "sources_unavailable")
            .await?;
        let view = assets::skill_drafts::read_in_tx(&mut tx, ctx, draft_id)
            .await?
            .view()?;
        tx.commit().await?;
        return Ok(view);
    }
    // 网络查证后重新锁来源；删除或条件修订不能让迟到读回旧正文。
    let mut tx = AppTx::begin(pool).await?;
    let conversation =
        conversations::lock_for_cleanup_in_tx(&mut tx, ctx, text(&reference, "conversation_id")?)
            .await?;
    let current = assets::skill_drafts::read_in_tx(&mut tx, ctx, draft_id).await?;
    if current.state == "pending"
        && let Err(error) = check_pending_in_tx(&mut tx, ctx, &conversation, &current).await
    {
        let status = if error.code == "version_conflict" {
            "condition_changed"
        } else if unavailable_source(&error) {
            "sources_unavailable"
        } else {
            return Err(error);
        };
        assets::skill_drafts::invalidate_in_tx(&mut tx, ctx, draft_id, status).await?;
        tx.commit().await?;
        return Ok(json!({"status":status,"reference":reference}));
    }
    let view = current.view()?;
    tx.commit().await?;
    Ok(view)
}

pub async fn list(pool: &MySqlPool, ctx: &AccessContext, after: &str) -> Result<Value> {
    let mut tx = AppTx::begin(pool).await?;
    let mut ids = assets::skill_drafts::page_in_tx(&mut tx, ctx, after).await?;
    let next = if ids.len() > 20 {
        ids.truncate(20);
        ids.last().cloned()
    } else {
        None
    };
    tx.commit().await?;
    let mut drafts = Vec::new();
    for id in ids {
        drafts.push(read(pool, ctx, &id).await?);
    }
    Ok(json!({"drafts":drafts,"next_after_id":next}))
}

pub async fn confirm(pool: &MySqlPool, ctx: &AccessContext, input: &Value) -> Result<Value> {
    let draft_id = text(input, "draft_id")?;
    if input["kind"] != "skill" || !input["id"].is_null() || !input["expected_version"].is_null() {
        return Err(Error::new("invalid_input"));
    }
    let mut tx = AppTx::begin(pool).await?;
    if let Some(receipt) = assets::begin_save_in_tx(&mut tx, ctx, input).await? {
        tx.commit().await?;
        return Ok(receipt);
    }
    tx.commit().await?;
    let checked = read(pool, ctx, draft_id).await?;
    if checked["status"] != "pending" {
        return Err(Error::new("not_available"));
    }
    let mut tx = AppTx::begin(pool).await?;
    let conversation = conversations::lock_for_cleanup_in_tx(
        &mut tx,
        ctx,
        text(&checked["reference"], "conversation_id")?,
    )
    .await?;
    if let Some(receipt) = assets::begin_save_in_tx(&mut tx, ctx, input).await? {
        tx.commit().await?;
        return Ok(receipt);
    }
    let draft = assets::skill_drafts::read_in_tx(&mut tx, ctx, draft_id).await?;
    check_pending_in_tx(&mut tx, ctx, &conversation, &draft).await?;
    let dependencies = draft.body.as_ref().ok_or(Error::new("not_available"))?["dependencies"]
        .as_array()
        .ok_or(Error::new("invalid_evidence"))?;
    let supplied = input["dependencies"]
        .as_array()
        .ok_or(Error::new("invalid_input"))?;
    if !dependencies
        .iter()
        .all(|reference| supplied.contains(reference))
    {
        return Err(Error::new("invalid_evidence"));
    }
    super::knowledge::check_refs_in_tx(&mut tx, ctx, &input["dependencies"]).await?;
    let asset = assets::save_authorized_in_tx(&mut tx, ctx, input, false).await?;
    assets::skill_drafts::confirm_in_tx(&mut tx, ctx, draft_id, text(&asset, "id")?).await?;
    super::personal_memory::queue_in_tx(&mut tx, ctx, &asset, None, None).await?;
    tx.commit().await?;
    Ok(asset)
}

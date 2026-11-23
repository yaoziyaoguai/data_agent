use crate::{
    modules::{analysis, assets, conversations, queries, runtime},
    persistence::AppTx,
    types::{AccessContext, Error, Result, epoch},
};
use serde_json::{Value, json};
use sqlx::MySqlPool;

use super::context_authority::{self, AuthorityUse};

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
            | "stale_context"
            | "invalid_evidence"
    )
}

async fn user_source_in_tx(
    tx: &mut AppTx<'_>,
    message: &conversations::Message,
    quote: Option<&str>,
) -> Result<()> {
    if !message.user_supplied
        || message.disposition == "withdrawn"
        || (quote.is_some()
            && (message.disposition != "pending"
                || quote.map(str::trim) != Some(message.body.trim())))
        || conversations::result_query_for_message_in_tx(tx, &message.conversation_id, &message.id)
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
        if reference["conversation_id"] != cid || (saved_refs && reference != requested) {
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
    // 草稿归属保持当前版本；历史依据及查询分别按自己的原归属核对，不能改标为草稿条件。
    for item in evidence
        .as_array()
        .ok_or(crate::types::Error::new("invalid_input"))?
    {
        for dependency in item["validated_sources"]["result_dependencies"]
            .as_array()
            .ok_or(Error::new("invalid_evidence"))?
        {
            let query = queries::read_in_tx(tx, ctx, text(dependency, "query_id")?).await?;
            super::analysis_evidence::assert_query(&query, cid, &item["reference"], dependency)?;
            super::knowledge::check_refs_in_tx(tx, ctx, &query["knowledge_refs"]).await?;
        }
    }
    Ok(evidence)
}

async fn result_sources(pool: &MySqlPool, ctx: &AccessContext, evidence: &Value) -> Result<()> {
    let sources = super::analysis_reports::sources(evidence)?;
    for reference in sources["result_dependencies"]
        .as_array()
        .ok_or(crate::types::Error::new("invalid_input"))?
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
    input_identity: (&str, &str, &str),
    input: &Value,
    checked: &mut super::context_authority::CheckedTextResults,
) -> Result<Value> {
    let (message, recovery_chain, run_id) = input_identity;
    let mut tx = AppTx::begin(pool).await?;
    let conversation = conversations::lock_conversation_in_tx(&mut tx, ctx, cid).await?;
    let message = conversations::read_message_in_tx(&mut tx, &conversation, message).await?;
    user_source_in_tx(&mut tx, &message, Some(text(input, "instruction_quote")?)).await?;
    analysis::assert_current_in_tx(
        &mut tx,
        cid,
        text(input, "task_id")?,
        epoch(text(input, "condition_version")?)?,
    )
    .await?;
    let evidence = evidence_in_tx(&mut tx, ctx, cid, &input["evidence_ids"], false).await?;
    let authorities = [
        super::analysis_reports::evidence_authority(&evidence)?,
        super::personal_assets::read_skill_authority_in_tx(
            &mut tx,
            ctx,
            cid,
            recovery_chain,
            Some(run_id),
        )
        .await?,
    ];
    tx.commit().await?;
    checked.include(pool, ctx, &authorities, false).await?;
    result_sources(pool, ctx, &evidence).await?;
    Ok(evidence)
}

pub struct CheckedDraftSources<'a> {
    pub evidence: &'a Value,
    pub text_results: &'a super::context_authority::CheckedTextResults,
}

pub async fn prepare_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    conversation: &conversations::LockedConversation,
    run: &runtime::LockedRun,
    tool: &runtime::LockedTool,
    input: &Value,
    checked: CheckedDraftSources<'_>,
) -> Result<Value> {
    let message = conversations::read_message_in_tx(tx, conversation, &run.message_id).await?;
    user_source_in_tx(tx, &message, Some(text(input, "instruction_quote")?)).await?;
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
    let evidence = evidence_in_tx(tx, ctx, &conversation.id, &input["evidence_ids"], false).await?;
    if evidence != *checked.evidence {
        return Err(Error::new("invalid_evidence"));
    }
    super::analysis_reports::check_evidence_in_tx(
        tx,
        ctx,
        &conversation.id,
        &evidence,
        checked.text_results,
    )
    .await?;
    let sources = super::analysis_reports::sources(&evidence)?;
    let mut authority = super::personal_assets::read_skill_authority_in_tx(
        tx,
        ctx,
        &conversation.id,
        &run.recovery_chain_id,
        Some(&run.id),
    )
    .await?;
    context_authority::validate_in_tx(
        tx,
        ctx,
        &authority,
        AuthorityUse::Text(checked.text_results),
    )
    .await?;
    let declared = context_authority::from_sources(&sources)?;
    for reference in context_authority::items(&declared["query_results"]) {
        if !context_authority::items(&authority["source_query_results"]).contains(reference) {
            authority["source_query_results"]
                .as_array_mut()
                .ok_or(crate::types::Error::new("unavailable"))?
                .push(reference.clone());
        }
    }
    let skill_sources = (!context_authority::items(&authority["source_skills"]).is_empty()
        || !context_authority::items(&authority["source_query_results"]).is_empty())
        .then(|| json!({"source_skills": authority["source_skills"], "source_query_results": authority["source_query_results"]}));
    let references = json!(
        evidence
            .as_array()
            .ok_or(crate::types::Error::new("invalid_input"))?
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
        skill_sources.as_ref(),
    )
    .await?;
    super::context_authority::merge_run_in_tx(
        tx,
        &run.id,
        &super::context_authority::from_sources(&sources)?,
    )
    .await?;
    Ok(reference)
}

async fn check_pending_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    draft: &assets::skill_drafts::StoredDraft,
    locked: Option<&conversations::LockedConversation>,
) -> Result<Value> {
    if draft.state != "pending" {
        return Err(Error::new("not_available"));
    }
    let reference = &draft.reference;
    let cid = text(reference, "conversation_id")?;
    let mid = text(reference, "source_message_id")?;
    let message = if let Some(conversation) = locked {
        if conversation.deleted {
            return Err(Error::new("not_available"));
        }
        conversations::read_message_in_tx(tx, conversation, mid).await?
    } else {
        conversations::read_message_snapshot_in_tx(tx, ctx, cid, mid).await?
    };
    user_source_in_tx(tx, &message, None).await?;
    let task = analysis::read_task_in_tx(tx, cid, text(reference, "task_id")?).await?;
    if task["condition_version"] != reference["condition_version"] || task["lifecycle"] != "active"
    {
        return Err(Error::new("version_conflict"));
    }
    let body = draft.body.as_ref().ok_or(Error::new("invalid_input"))?;
    let evidence = evidence_in_tx(tx, ctx, cid, &body["evidence_refs"], true).await?;
    if super::analysis_reports::sources(&evidence)?["knowledge_refs"] != body["dependencies"] {
        return Err(Error::new("invalid_evidence"));
    }
    Ok(evidence)
}

async fn check_text_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    draft: &assets::skill_drafts::StoredDraft,
    checked: &super::context_authority::CheckedTextResults,
) -> Result<()> {
    let evidence = check_pending_in_tx(tx, ctx, draft, None).await?;
    let body = draft
        .body
        .as_ref()
        .ok_or(crate::types::Error::new("unavailable"))?;
    if body.get("skill_sources").is_some() {
        super::personal_assets::validate_skill_in_tx(tx, ctx, body, checked).await?;
    }
    super::analysis_reports::check_evidence_in_tx(
        tx,
        ctx,
        text(&draft.reference, "conversation_id")?,
        &evidence,
        checked,
    )
    .await?;
    Ok(())
}

pub async fn read(pool: &MySqlPool, ctx: &AccessContext, draft_id: &str) -> Result<Value> {
    let mut tx = AppTx::begin(pool).await?;
    let draft = assets::skill_drafts::read_in_tx(&mut tx, ctx, draft_id, false).await?;
    let unavailable_view = |error: Error| {
        let status = if error.code == "version_conflict" {
            "condition_changed"
        } else if unavailable_source(&error) {
            "sources_unavailable"
        } else {
            return Err(error);
        };
        Ok(json!({"status":status,"reference":draft.reference}))
    };
    if draft.state != "pending" {
        let view = draft.view()?;
        tx.commit().await?;
        return Ok(view);
    }
    let evidence = match check_pending_in_tx(&mut tx, ctx, &draft, None).await {
        Ok(evidence) => evidence,
        Err(error) => {
            tx.commit().await?;
            return unavailable_view(error);
        }
    };
    let authorities = [
        super::analysis_reports::evidence_authority(&evidence)?,
        super::personal_assets::skill_authority(
            draft.body.as_ref().ok_or(Error::new("unavailable"))?,
        )?,
    ];
    tx.commit().await?;
    let mut checked = super::context_authority::CheckedTextResults::default();
    checked.include(pool, ctx, &authorities, false).await?;
    if let Err(error) = result_sources(pool, ctx, &evidence).await {
        return unavailable_view(error);
    }
    // 网络查证后读取最新快照，预览不占用会话、消息或草稿的写锁。
    let mut tx = AppTx::begin(pool).await?;
    let current = assets::skill_drafts::read_in_tx(&mut tx, ctx, draft_id, false).await?;
    if current.state == "pending"
        && let Err(error) = check_text_in_tx(&mut tx, ctx, &current, &checked).await
    {
        tx.commit().await?;
        return unavailable_view(error);
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
        return super::personal_assets::project_receipt(pool, ctx, receipt).await;
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
        return super::personal_assets::project_receipt(pool, ctx, receipt).await;
    }
    let draft = assets::skill_drafts::read_in_tx(&mut tx, ctx, draft_id, true).await?;
    check_pending_in_tx(&mut tx, ctx, &draft, Some(&conversation)).await?;
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
    let skill_sources = draft
        .body
        .as_ref()
        .ok_or(crate::types::Error::new("unavailable"))?
        .get("skill_sources")
        .cloned();
    let asset =
        assets::save_with_skill_sources_in_tx(&mut tx, ctx, input, false, skill_sources).await?;
    assets::skill_drafts::confirm_in_tx(&mut tx, ctx, draft_id, text(&asset, "id")?).await?;
    super::personal_memory::queue_in_tx(&mut tx, ctx, &asset, None, None).await?;
    tx.commit().await?;
    Ok(asset)
}

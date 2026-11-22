use crate::routes::ResponseResult;
use crate::{
    State,
    request::{ContractBody, ContractQuery, RawContractBody, request_contracts},
    routes::{catalog_user, failure, internal_for_run, respond, semantic_user, user},
};
use axum::{
    Json,
    extract::{Path, Query, State as AxumState},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
};
use data_agent::{
    contracts::generated::*,
    types::{Error, epoch},
    use_cases,
    use_cases::knowledge::{KnowledgeChange, KnowledgeVersionAction},
};
use serde_json::{Value, json};
use std::collections::HashMap;
request_contracts!(
    SaveAnalysisReport,
    KnowledgeDocumentEdit,
    KnowledgeCreate,
    KnowledgeEdit,
    KnowledgeEntryBatch,
    KnowledgeBatchEdit,
    VersionCommand,
    AnalysisPreferenceCommand,
    AssetSave,
    SkillSelection,
    SkillSelectionRemoval,
    ConfirmQuery,
    DataToolInvocation,
    MemoryModelCall,
    PublishSkill,
    SuggestSkill,
    ReviewSkillSuggestion,
    KnowledgeListQuery,
    QueryHistoryQuery,
    AssetPageQuery,
);

pub async fn analysis_report(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path((cid, task)): Path<(String, String)>,
) -> ResponseResult {
    let ctx = semantic_user(&state, &headers).await.map_err(failure)?;
    respond!(
        AnalysisReportView,
        use_cases::analysis_reports::read(&state.pool, &ctx, &cid, &task)
            .await
            .map_err(failure)?,
    )
}
pub async fn save_analysis_report(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path((cid, task)): Path<(String, String)>,
    RawContractBody { value: input, raw }: RawContractBody<SaveAnalysisReport>,
) -> ResponseResult {
    let ctx = semantic_user(&state, &headers).await.map_err(failure)?;
    respond!(
        AnalysisReportRef,
        use_cases::analysis_reports::save(&state.pool, &ctx, &cid, &task, input, raw)
            .await
            .map_err(failure)?,
    )
}
pub async fn knowledge(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    ContractQuery(query): ContractQuery<KnowledgeListQuery>,
) -> ResponseResult {
    let ctx = catalog_user(&state, &headers).await.map_err(failure)?;
    let v = use_cases::knowledge::list(&state.pool, &ctx, query)
        .await
        .map_err(failure)?;
    respond!(KnowledgeList, v)
}
pub async fn read_document(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(object): Path<String>,
) -> ResponseResult {
    let ctx = semantic_user(&state, &headers).await.map_err(failure)?;
    respond!(
        KnowledgeDocument,
        use_cases::knowledge_documents::read(&state.pool, &ctx, &object)
            .await
            .map_err(failure)?,
    )
}
pub async fn edit_document(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(object): Path<String>,
    RawContractBody { value: input, raw }: RawContractBody<KnowledgeDocumentEdit>,
) -> ResponseResult {
    let ctx = semantic_user(&state, &headers).await.map_err(failure)?;
    respond!(
        KnowledgeDocument,
        use_cases::knowledge_documents::edit(&state.pool, &ctx, &object, input, raw)
            .await
            .map_err(failure)?,
    )
}
pub async fn read_knowledge(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(object): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> ResponseResult {
    let ctx = catalog_user(&state, &headers).await.map_err(failure)?;
    let version = query
        .get("version")
        .map(|v| epoch(v))
        .transpose()
        .map_err(failure)?;
    respond!(
        KnowledgeObject,
        use_cases::knowledge::read(&state.pool, &ctx, &object, version)
            .await
            .map_err(failure)?,
    )
}
pub async fn create_knowledge(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    RawContractBody { value: input, raw }: RawContractBody<KnowledgeCreate>,
) -> ResponseResult {
    let ctx = semantic_user(&state, &headers).await.map_err(failure)?;
    let command = KnowledgeChange::Create {
        request: input,
        raw,
    };
    respond!(
        KnowledgeObject,
        use_cases::knowledge::write(&state.pool, &ctx, command)
            .await
            .map_err(failure)?,
    )
}
pub async fn edit_knowledge(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(object): Path<String>,
    RawContractBody { value: input, raw }: RawContractBody<KnowledgeEdit>,
) -> ResponseResult {
    let ctx = semantic_user(&state, &headers).await.map_err(failure)?;
    let command = KnowledgeChange::Edit {
        object: &object,
        request: input,
        raw,
    };
    respond!(
        KnowledgeObject,
        use_cases::knowledge::write(&state.pool, &ctx, command)
            .await
            .map_err(failure)?,
    )
}
pub async fn edit_knowledge_entries(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(object): Path<String>,
    RawContractBody { value: input, raw }: RawContractBody<KnowledgeEntryBatch>,
) -> ResponseResult {
    let ctx = semantic_user(&state, &headers).await.map_err(failure)?;
    respond!(
        KnowledgeObject,
        use_cases::knowledge::edit_entries(&state.pool, &ctx, &object, input, raw)
            .await
            .map_err(failure)?,
    )
}
pub async fn edit_knowledge_batch(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    ContractBody { value: input, .. }: ContractBody<KnowledgeBatchEdit>,
) -> ResponseResult {
    let ctx = semantic_user(&state, &headers).await.map_err(failure)?;
    respond!(
        KnowledgeBatchReceipt,
        use_cases::knowledge::edit_batch(&state.pool, &ctx, input)
            .await
            .map_err(failure)?,
    )
}
pub async fn knowledge_action(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path((object, action)): Path<(String, String)>,
    ContractBody { value: input, .. }: ContractBody<VersionCommand>,
) -> ResponseResult {
    let ctx = semantic_user(&state, &headers).await.map_err(failure)?;
    let action = match action.as_str() {
        "disable" => KnowledgeVersionAction::SetState(MemoryState::Disabled),
        "enable" => KnowledgeVersionAction::SetState(MemoryState::Enabled),
        "delete" => KnowledgeVersionAction::SetState(MemoryState::Deleted),
        "reanalyze" => KnowledgeVersionAction::Reanalyze,
        _ => return Err(failure(Error::new("invalid_input"))),
    };
    let command = KnowledgeChange::Version {
        object: &object,
        action,
        request: input,
    };
    respond!(
        KnowledgeObject,
        use_cases::knowledge::write(&state.pool, &ctx, command)
            .await
            .map_err(failure)?,
    )
}
pub async fn analysis_preference(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(table): Path<String>,
    ContractBody { value: input, .. }: ContractBody<AnalysisPreferenceCommand>,
) -> ResponseResult {
    let ctx = semantic_user(&state, &headers).await.map_err(failure)?;
    respond!(
        TableAnalysisPreference,
        use_cases::knowledge::set_table_analysis_preference(&state.pool, &ctx, &table, input)
            .await
            .map_err(failure)?,
    )
}
pub async fn source(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(source): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> ResponseResult {
    let ctx = catalog_user(&state, &headers).await.map_err(failure)?;
    if query.contains_key("offset") || query.contains_key("length") {
        let position = |name: &str| {
            query
                .get(name)
                .and_then(|value| value.parse::<u64>().ok())
                .ok_or_else(|| failure(Error::new("invalid_input")))
        };
        let revision = query
            .get("version")
            .ok_or_else(|| failure(Error::new("invalid_input")))?;
        let (kind, id) = source
            .strip_prefix("document-")
            .map(|id| ("document", id))
            .unwrap_or(("platform", &source));
        let citation = json!({"source":{"kind":kind,"id":id},"revision":revision,
            "locator":{"offset":position("offset")?,"length":position("length")?}});
        return respond!(
            SourceExcerpt,
            use_cases::knowledge::source_excerpt(&state.pool, &ctx, citation)
                .await
                .map_err(failure)?,
        );
    }
    let v = if let Some(v) = query.get("version") {
        use_cases::knowledge::source(&state.pool, &ctx, &source, epoch(v).map_err(failure)?).await
    } else {
        use_cases::knowledge::source_head(&state.pool, &ctx, &source).await
    }
    .map_err(failure)?;
    respond!(SourceDocument, v)
}
pub async fn sync(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    ContractBody { value: input, .. }: ContractBody<CreateConversation>,
) -> Result<axum::response::Response, (StatusCode, Json<Value>)> {
    let ctx = user(&state, &headers).await.map_err(failure)?;
    let result = use_cases::knowledge::sync(&state.pool, &ctx, &input.operation_id)
        .await
        .map_err(failure)?;
    if result.get("sync_id").is_some() {
        Ok((StatusCode::ACCEPTED, respond!(SourceSyncAccepted, result)?).into_response())
    } else {
        respond!(MutationReceipt, result)
    }
}
pub async fn sync_progress(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(sync): Path<String>,
) -> ResponseResult {
    let ctx = user(&state, &headers).await.map_err(failure)?;
    respond!(
        SourceSyncProgress,
        use_cases::catalog_import::progress(&state.pool, &ctx, &sync)
            .await
            .map_err(failure)?,
    )
}
pub async fn rebuild_index(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    ContractBody { value: input, .. }: ContractBody<CreateConversation>,
) -> ResponseResult {
    let ctx = user(&state, &headers).await.map_err(failure)?;
    respond!(
        MutationReceipt,
        use_cases::knowledge::rebuild_index_for_operation(&state.pool, &ctx, &input.operation_id)
            .await
            .map_err(failure)?,
    )
}
pub async fn assets(AxumState(state): AxumState<State>, headers: HeaderMap) -> ResponseResult {
    let ctx = semantic_user(&state, &headers).await.map_err(failure)?;
    respond!(
        AssetList,
        use_cases::personal_assets::list(&state.pool, &ctx)
            .await
            .map_err(failure)?,
    )
}
pub async fn asset(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ResponseResult {
    let context = semantic_user(&state, &headers).await.map_err(failure)?;
    respond!(
        Asset,
        use_cases::personal_assets::read(&state.pool, &context, &id)
            .await
            .map_err(failure)?,
    )
}
pub async fn save_asset(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    RawContractBody { value: input, raw }: RawContractBody<AssetSave>,
) -> ResponseResult {
    let ctx = semantic_user(&state, &headers).await.map_err(failure)?;
    respond!(
        Asset,
        use_cases::personal_assets::save(&state.pool, &ctx, input, raw)
            .await
            .map_err(failure)?,
    )
}
pub async fn asset_action(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path((asset, action)): Path<(String, String)>,
    ContractBody { value: input, .. }: ContractBody<VersionCommand>,
) -> ResponseResult {
    let ctx = semantic_user(&state, &headers).await.map_err(failure)?;
    let target = match action.as_str() {
        "disable" => AssetState::Disabled,
        "enable" => AssetState::Enabled,
        "delete" => AssetState::Deleted,
        _ => return Err(failure(Error::new("invalid_input"))),
    };
    respond!(
        Asset,
        use_cases::personal_assets::state(&state.pool, &ctx, &asset, input, target)
            .await
            .map_err(failure)?,
    )
}
pub async fn select_skill(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(cid): Path<String>,
    ContractBody { value: input, .. }: ContractBody<SkillSelection>,
) -> ResponseResult {
    let ctx = semantic_user(&state, &headers).await.map_err(failure)?;
    respond!(
        Asset,
        use_cases::personal_assets::select(&state.pool, &ctx, &cid, input)
            .await
            .map_err(failure)?,
    )
}
pub async fn remove_skill(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(cid): Path<String>,
    ContractBody { value: input, .. }: ContractBody<SkillSelectionRemoval>,
) -> ResponseResult {
    let ctx = user(&state, &headers).await.map_err(failure)?;
    respond!(
        SkillRemovalReceipt,
        use_cases::personal_assets::remove_selection(&state.pool, &ctx, &cid, input)
            .await
            .map_err(failure)?,
    )
}
pub async fn queries(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(cid): Path<String>,
) -> ResponseResult {
    let ctx = semantic_user(&state, &headers).await.map_err(failure)?;
    respond!(
        QueryList,
        use_cases::query_workflow::list(&state.pool, &ctx, &cid)
            .await
            .map_err(failure)?,
    )
}
pub async fn query_history(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    ContractQuery(query): ContractQuery<QueryHistoryQuery>,
) -> ResponseResult {
    let ctx = semantic_user(&state, &headers).await.map_err(failure)?;
    respond!(
        QueryHistory,
        use_cases::query_workflow::history(
            &state.pool,
            &ctx,
            query.before_id.as_deref(),
            query.q.as_deref().unwrap_or(""),
        )
        .await
        .map_err(failure)?,
    )
}
pub async fn query(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(qid): Path<String>,
) -> ResponseResult {
    let ctx = semantic_user(&state, &headers).await.map_err(failure)?;
    respond!(
        QueryView,
        use_cases::query_workflow::read(&state.pool, &ctx, &qid)
            .await
            .map_err(failure)?,
    )
}
pub async fn confirm(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(qid): Path<String>,
    ContractBody { value: input, .. }: ContractBody<ConfirmQuery>,
) -> ResponseResult {
    let ctx = semantic_user(&state, &headers).await.map_err(failure)?;
    respond!(
        QueryView,
        use_cases::query_workflow::confirm(&state.pool, &ctx, &qid, input)
            .await
            .map_err(failure)?,
    )
}
pub async fn cancel(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(qid): Path<String>,
    ContractBody { .. }: ContractBody<CreateConversation>,
) -> ResponseResult {
    let ctx = user(&state, &headers).await.map_err(failure)?;
    respond!(
        QueryView,
        use_cases::query_workflow::cancel(&state.pool, &ctx, &qid)
            .await
            .map_err(failure)?,
    )
}
pub async fn results(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(qid): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> ResponseResult {
    let ctx = semantic_user(&state, &headers).await.map_err(failure)?;
    Ok(Json(
        use_cases::query_workflow::results(
            &state.pool,
            &ctx,
            &qid,
            query.get("cursor").map(String::as_str),
        )
        .await
        .map_err(failure)?,
    )
    .into_response())
}

pub async fn register(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    RawContractBody { value: input, raw }: RawContractBody<DataToolInvocation>,
) -> ResponseResult {
    let ctx = internal_for_run(&state, &headers, &input.run_id)
        .await
        .map_err(failure)?;
    respond!(
        OperationReceipt,
        use_cases::data_tools::register_validated(&state.pool, &ctx, &input, raw)
            .await
            .map_err(failure)?,
    )
}
pub async fn tool(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    RawContractBody { value: input, raw }: RawContractBody<DataToolInvocation>,
) -> ResponseResult {
    let ctx = internal_for_run(&state, &headers, &input.run_id)
        .await
        .map_err(failure)?;
    let ctx = use_cases::knowledge::catalog_context(&ctx)
        .await
        .map_err(failure)?;
    respond!(
        DataToolOutcome,
        use_cases::data_tools::invoke_validated(&state.pool, &ctx, &input, raw)
            .await
            .map_err(failure)?,
    )
}
pub async fn tool_rejection(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    RawContractBody { value: input, raw }: RawContractBody<DataToolInvocation>,
) -> ResponseResult {
    let ctx = internal_for_run(&state, &headers, &input.run_id)
        .await
        .map_err(failure)?;
    let ctx = use_cases::knowledge::catalog_context(&ctx)
        .await
        .map_err(failure)?;
    respond!(
        DataToolOutcome,
        use_cases::data_tools::recorded_rejection_validated(&state.pool, &ctx, &input, raw)
            .await
            .map_err(failure)?,
    )
}
pub async fn proposals(AxumState(state): AxumState<State>, headers: HeaderMap) -> ResponseResult {
    let ctx = semantic_user(&state, &headers).await.map_err(failure)?;
    respond!(
        ProposalList,
        use_cases::knowledge::proposals(&state.pool, &ctx)
            .await
            .map_err(failure)?,
    )
}
pub async fn apply_proposal(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(id): Path<String>,
    ContractBody { value: input, .. }: ContractBody<VersionCommand>,
) -> ResponseResult {
    let ctx = semantic_user(&state, &headers).await.map_err(failure)?;
    let command = KnowledgeChange::Version {
        object: &id,
        action: KnowledgeVersionAction::ApplyProposal,
        request: input,
    };
    respond!(
        KnowledgeObject,
        use_cases::knowledge::write(&state.pool, &ctx, command)
            .await
            .map_err(failure)?,
    )
}

pub async fn cancel_task(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path((cid, task)): Path<(String, String)>,
    ContractBody { value: input, .. }: ContractBody<VersionCommand>,
) -> ResponseResult {
    let ctx = user(&state, &headers).await.map_err(failure)?;
    respond!(
        MutationReceipt,
        use_cases::conversation_lifecycle::cancel_task(&state.pool, &ctx, &cid, &task, input)
            .await
            .map_err(failure)?,
    )
}
pub async fn withdraw(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path((cid, message)): Path<(String, String)>,
    ContractBody { value: input, .. }: ContractBody<CreateConversation>,
) -> ResponseResult {
    let ctx = user(&state, &headers).await.map_err(failure)?;
    respond!(
        MutationReceipt,
        use_cases::conversation_lifecycle::withdraw(&state.pool, &ctx, &cid, &message, input)
            .await
            .map_err(failure)?,
    )
}
pub async fn delete_conversation(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(cid): Path<String>,
    ContractBody { value: input, .. }: ContractBody<CreateConversation>,
) -> ResponseResult {
    let ctx = user(&state, &headers).await.map_err(failure)?;
    respond!(
        MutationReceipt,
        use_cases::conversation_lifecycle::delete(&state.pool, &ctx, &cid, input)
            .await
            .map_err(failure)?,
    )
}

pub async fn memory_model_call(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    RawContractBody { value: input, raw }: RawContractBody<MemoryModelCall>,
) -> ResponseResult {
    if crate::routes::bearer(&headers) != Some(state.internal_token.as_str()) {
        return Err(failure(Error::new("unauthenticated")));
    }
    respond!(
        ModelCallReceipt,
        use_cases::personal_memory::model_call(&state.pool, input, raw)
            .await
            .map_err(failure)?,
    )
}

pub async fn publish_skill(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(asset): Path<String>,
    ContractBody { value: input, .. }: ContractBody<PublishSkill>,
) -> ResponseResult {
    let ctx = semantic_user(&state, &headers).await.map_err(failure)?;
    respond!(
        Asset,
        use_cases::personal_assets::publish(&state.pool, &ctx, &asset, input)
            .await
            .map_err(failure)?,
    )
}
pub async fn skill_selections(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(cid): Path<String>,
    ContractQuery(query): ContractQuery<AssetPageQuery>,
) -> ResponseResult {
    let ctx = semantic_user(&state, &headers).await.map_err(failure)?;
    respond!(
        ConversationSkillSelections,
        use_cases::personal_assets::selections(
            &state.pool,
            &ctx,
            &cid,
            query.after_id.as_deref().unwrap_or(""),
        )
        .await
        .map_err(failure)?,
    )
}
pub async fn skill_suggestions(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(asset): Path<String>,
    ContractQuery(query): ContractQuery<AssetPageQuery>,
) -> ResponseResult {
    let ctx = semantic_user(&state, &headers).await.map_err(failure)?;
    respond!(
        SkillSuggestionList,
        use_cases::personal_assets::suggestions(
            &state.pool,
            &ctx,
            &asset,
            query.after_id.as_deref().unwrap_or(""),
        )
        .await
        .map_err(failure)?,
    )
}
pub async fn suggest_skill(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(asset): Path<String>,
    ContractBody { value: input, .. }: ContractBody<SuggestSkill>,
) -> ResponseResult {
    let ctx = semantic_user(&state, &headers).await.map_err(failure)?;
    respond!(
        SkillSuggestion,
        use_cases::personal_assets::suggest(&state.pool, &ctx, &asset, input)
            .await
            .map_err(failure)?,
    )
}
pub async fn review_skill_suggestion(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path((asset, suggestion)): Path<(String, String)>,
    ContractBody { value: input, .. }: ContractBody<ReviewSkillSuggestion>,
) -> ResponseResult {
    let ctx = semantic_user(&state, &headers).await.map_err(failure)?;
    respond!(
        SkillSuggestion,
        use_cases::personal_assets::review_suggestion(
            &state.pool,
            &ctx,
            &asset,
            &suggestion,
            input,
        )
        .await
        .map_err(failure)?,
    )
}

use crate::routes::ResponseResult;
use crate::{
    State,
    request::{RawContractBody, request_contracts},
    routes::{failure, respond, semantic_user, user},
};
use axum::{
    extract::{Path, Query, State as AxumState},
    http::HeaderMap,
};
use data_agent::{contracts::generated::*, use_cases::semantic_governance};
use std::collections::HashMap;

request_contracts!(
    AssignSemanticMaintainer,
    ProposalDraftCommand,
    SubmitSemanticCorrection,
    ReviseSemanticCorrection,
    ReviewSemanticCorrection,
    ApplySemanticCorrection,
);
pub async fn access(AxumState(state): AxumState<State>, headers: HeaderMap) -> ResponseResult {
    let ctx = user(&state, &headers).await.map_err(failure)?;
    respond!(
        SemanticAccess,
        semantic_governance::read_access(&state.pool, &ctx)
            .await
            .map_err(failure)?,
    )
}
pub async fn members(AxumState(state): AxumState<State>, headers: HeaderMap) -> ResponseResult {
    let ctx = user(&state, &headers).await.map_err(failure)?;
    respond!(
        SemanticMemberList,
        semantic_governance::list_members(&ctx, &state.identities.members(&ctx))
            .map_err(failure)?,
    )
}
pub async fn assign(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(id): Path<String>,
    RawContractBody { raw: input, .. }: RawContractBody<AssignSemanticMaintainer>,
) -> ResponseResult {
    let ctx = semantic_user(&state, &headers).await.map_err(failure)?;
    respond!(
        SemanticMaintenance,
        semantic_governance::assign(
            &state.pool,
            &ctx,
            &id,
            input,
            &state.identities.members(&ctx),
        )
        .await
        .map_err(failure)?,
    )
}
pub async fn draft(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    RawContractBody { raw: input, .. }: RawContractBody<ProposalDraftCommand>,
) -> ResponseResult {
    let ctx = semantic_user(&state, &headers).await.map_err(failure)?;
    respond!(
        Proposal,
        semantic_governance::draft(&state.pool, &ctx, input)
            .await
            .map_err(failure)?,
    )
}
pub async fn list(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> ResponseResult {
    let ctx = semantic_user(&state, &headers).await.map_err(failure)?;
    if query.keys().any(|k| k != "after_id") {
        return Err(failure(data_agent::types::Error::new("invalid_input")));
    }
    respond!(
        SemanticCorrectionList,
        semantic_governance::list(&state.pool, &ctx, query.get("after_id").map(String::as_str))
            .await
            .map_err(failure)?,
    )
}
pub async fn read(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ResponseResult {
    let ctx = semantic_user(&state, &headers).await.map_err(failure)?;
    respond!(
        SemanticCorrection,
        semantic_governance::read(&state.pool, &ctx, &id)
            .await
            .map_err(failure)?,
    )
}
pub async fn submit(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    RawContractBody { raw: input, .. }: RawContractBody<SubmitSemanticCorrection>,
) -> ResponseResult {
    let ctx = semantic_user(&state, &headers).await.map_err(failure)?;
    respond!(
        SemanticCorrection,
        semantic_governance::change(&state.pool, &ctx, None, "submit", input)
            .await
            .map_err(failure)?,
    )
}
pub async fn revise(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(id): Path<String>,
    RawContractBody { raw: input, .. }: RawContractBody<ReviseSemanticCorrection>,
) -> ResponseResult {
    let ctx = semantic_user(&state, &headers).await.map_err(failure)?;
    respond!(
        SemanticCorrection,
        semantic_governance::change(&state.pool, &ctx, Some(&id), "revise", input)
            .await
            .map_err(failure)?,
    )
}
pub async fn review(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(id): Path<String>,
    RawContractBody { raw: input, .. }: RawContractBody<ReviewSemanticCorrection>,
) -> ResponseResult {
    let ctx = semantic_user(&state, &headers).await.map_err(failure)?;
    respond!(
        SemanticCorrection,
        semantic_governance::change(&state.pool, &ctx, Some(&id), "review", input)
            .await
            .map_err(failure)?,
    )
}

pub async fn apply(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(id): Path<String>,
    RawContractBody { raw: input, .. }: RawContractBody<ApplySemanticCorrection>,
) -> ResponseResult {
    let ctx = semantic_user(&state, &headers).await.map_err(failure)?;
    respond!(
        SemanticCorrection,
        semantic_governance::change(&state.pool, &ctx, Some(&id), "apply", input)
            .await
            .map_err(failure)?,
    )
}

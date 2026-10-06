use crate::{
    contracts::{self, generated::EmbeddingProfile},
    modules::{
        access, conversations, knowledge,
        retrieval::{embedding, vector},
        runtime,
    },
    persistence::AppTx,
    types::{AccessContext, Error, Result, epoch, fingerprint},
};
use serde_json::{Value, json};
use sqlx::MySqlPool;

pub enum Binding<'a> {
    Tool(&'a Value),
    Index(&'a Value, usize),
    Browse,
}

fn maintenance_profile() -> Result<Option<Value>> {
    let Some(raw) = std::env::var("DATA_AGENT_EMBEDDING_PROFILE").ok() else {
        return Ok(None);
    };
    let value: Value = serde_json::from_str(&raw).map_err(|_| Error::new("invalid_input"))?;
    contracts::validate("EmbeddingProfile", &value)?;
    Ok(Some(value))
}

async fn authorize_in_tx(
    tx: &mut AppTx<'_>,
    pool: &MySqlPool,
    ctx: &AccessContext,
    binding: &Binding<'_>,
) -> Result<(runtime::provider_calls::ProviderBudget, String)> {
    // 当前公开MVP只有合成demo空间；真实资料外发策略随平台接入另行验证。
    if ctx.space_id != "demo" {
        return Err(Error::new("not_available"));
    }
    access::authorize_model("bailian")?;
    match binding {
        Binding::Tool(input) => {
            let run_id = input["run_id"]
                .as_str()
                .ok_or(Error::new("invalid_input"))?;
            let cid = runtime::locate_run(pool, run_id).await?;
            let conv = conversations::lock_conversation_in_tx(tx, ctx, &cid).await?;
            conversations::assert_turn_in_tx(
                tx,
                &conv,
                run_id,
                epoch(input["lease_epoch"].as_str().unwrap_or("0"))?,
            )?;
            let run = runtime::lock_run_in_tx(tx, run_id, &cid).await?;
            if run.state != "running" {
                return Err(Error::new("lease_lost"));
            }
            super::context_authority::assert_run_in_tx(tx, ctx, &cid, run_id).await?;
            let tool = runtime::lock_tool_call_in_tx(
                tx,
                &run,
                input["sdk_tool_call_id"].as_str().unwrap_or(""),
            )
            .await?
            .ok_or(Error::new("not_available"))?;
            if tool.state == "rejected" {
                return Err(Error::new("not_available"));
            }
            if input["tool_name"] != "search_knowledge"
                || tool.fingerprint
                    != fingerprint(
                        &json!({"name":input["tool_name"],"arguments":input["arguments"]}),
                    )
            {
                return Err(Error::new("idempotency_conflict"));
            }
            let profile = runtime::read_budget_profile_in_tx(tx, &run.budget_scope_id)
                .await?
                .ok_or(Error::new("budget_unavailable"))?;
            Ok((
                runtime::provider_calls::ProviderBudget::from_model_profile(
                    Some(run.budget_scope_id),
                    profile,
                )?,
                tool.operation_id,
            ))
        }
        Binding::Index(job, batch) => {
            super::knowledge::assert_source_in_tx(tx, ctx, &job["object"]).await?;
            let raw = knowledge::bind_index_embedding_in_tx(
                tx,
                ctx,
                job,
                maintenance_profile()?.as_ref(),
            )
            .await?;
            let profile: EmbeddingProfile = contracts::decode("EmbeddingProfile", raw)?;
            let operation = fingerprint(&json!([
                "knowledge-index",
                ctx.space_id,
                job["object_id"],
                job["job_version"],
                embedding::SPEC.version,
                batch
            ]));
            Ok((
                runtime::provider_calls::ProviderBudget {
                    scope_id: None,
                    trial_id: profile.trial_id,
                    input_limit: embedding::SPEC.input_bytes_limit as u64,
                    output_limit: 0,
                },
                operation,
            ))
        }
        Binding::Browse => {
            let profile: EmbeddingProfile = contracts::decode(
                "EmbeddingProfile",
                maintenance_profile()?.ok_or(Error::new("budget_unavailable"))?,
            )?;
            Ok((
                runtime::provider_calls::ProviderBudget {
                    scope_id: None,
                    trial_id: profile.trial_id,
                    input_limit: embedding::SPEC.input_bytes_limit as u64,
                    output_limit: 0,
                },
                fingerprint(&json!([
                    "knowledge-search",
                    ctx.user_id,
                    ctx.space_id,
                    ctx.request_id
                ])),
            ))
        }
    }
}

pub async fn embed(
    pool: &MySqlPool,
    ctx: &AccessContext,
    binding: Binding<'_>,
    texts: Vec<String>,
) -> Result<Vec<Vec<f32>>> {
    let request = embedding::prepare(&texts)?;
    if !matches!(binding, Binding::Tool(_))
        && let Some(raw) = maintenance_profile()?
    {
        let profile = contracts::decode("EmbeddingProfile", raw)?;
        runtime::configure_embedding_trial(pool, &profile).await?;
    }
    let mut tx = AppTx::begin(pool).await?;
    let (_, operation) = authorize_in_tx(&mut tx, pool, ctx, &binding).await?;
    tx.commit().await?;

    let input = json!({"call_attempt_id":fingerprint(&json!(["shared-embedding",operation,request.fingerprint])),
        "purpose":"knowledge_embedding","budget":{"operation_id":operation},"parameters_fingerprint":request.fingerprint,
        "input_tokens_upper":request.input_upper,"output_tokens_max":0,"usage":null});
    let mut tx = AppTx::begin(pool).await?;
    let (budget, _) = authorize_in_tx(&mut tx, pool, ctx, &binding).await?;
    if let Some(cached) = runtime::provider_calls::cached_embedding_in_tx(&mut tx, &input).await? {
        tx.commit().await?;
        return serde_json::from_value(cached).map_err(|_| Error::new("embedding_unavailable"));
    }
    let permit = runtime::provider_calls::issue_in_tx(&mut tx, &budget, &input).await?;
    tx.commit().await?;
    if permit["send_allowed"] != true {
        return Err(Error::new("embedding_unknown"));
    }
    let started = std::time::Instant::now();
    let response = request.send().await;
    let usage = response
        .as_ref()
        .ok()
        .and_then(|v| embedding::usage(v, started.elapsed().as_millis() as u64));
    let result = match &response {
        Ok(value) => embedding::vectors(value, texts.len()),
        Err(_) => Err(Error::new("embedding_unknown")),
    };
    let within = usage.as_ref().is_some_and(|v| {
        v["input_tokens"]
            .as_u64()
            .is_some_and(|n| n <= request.input_upper)
    });
    let receipt = if within {
        result.as_ref().ok().map(|v| json!(v))
    } else {
        None
    };
    let mut settled = input;
    settled["usage"] = usage.clone().unwrap_or(Value::Null);
    let mut tx = AppTx::begin(pool).await?;
    runtime::provider_calls::finish_embedding_in_tx(&mut tx, &settled, receipt.as_ref()).await?;
    tx.commit().await?;
    if usage.is_none() {
        return Err(Error::new("embedding_unknown"));
    }
    if !within {
        return Err(Error::new("budget_exhausted"));
    }
    result
}

pub async fn search(
    pool: &MySqlPool,
    ctx: &AccessContext,
    query: &str,
    input: Option<&Value>,
) -> vector::Candidates {
    if !vector::enabled()
        || query == "*"
        || input.is_some_and(|i| i["arguments"]["asset_after"].is_string())
    {
        return vector::Candidates::lexical();
    }
    let binding = input.map_or(Binding::Browse, Binding::Tool);
    match embed(pool, ctx, binding, vec![query.chars().take(1600).collect()]).await {
        Ok(mut vectors) => vector::search(&ctx.space_id, query, vectors.remove(0)).await,
        Err(error) => {
            eprintln!("knowledge_embedding_failure code={}", error.code);
            vector::Candidates {
                values: vec![],
                state: "unavailable",
                bounded: true,
                target: None,
            }
        }
    }
}

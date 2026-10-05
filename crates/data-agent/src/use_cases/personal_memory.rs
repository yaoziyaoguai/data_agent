use crate::{
    contracts,
    modules::{assets, conversations, runtime},
    persistence::AppTx,
    types::{AccessContext, Error, Result, epoch, fingerprint},
};
use serde_json::{Value, json};
use sqlx::MySqlPool;

async fn checked_binding(
    pool: &MySqlPool,
    ctx: &AccessContext,
    input: &Value,
) -> Result<(Value, String)> {
    let run_id = input["run_id"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?;
    let cid = runtime::locate_run(pool, run_id).await?;
    let mut tx = AppTx::begin(pool).await?;
    let conv = conversations::lock_conversation_in_tx(&mut tx, ctx, &cid).await?;
    conversations::assert_turn_in_tx(
        &tx,
        &conv,
        run_id,
        epoch(input["lease_epoch"].as_str().unwrap_or("0"))?,
    )?;
    let run = runtime::lock_run_in_tx(&mut tx, run_id, &cid).await?;
    if run.state != "running" {
        return Err(Error::new("lease_lost"));
    }
    super::context_authority::assert_run_in_tx(&mut tx, ctx, &cid, run_id).await?;
    let tool = runtime::lock_tool_call_in_tx(
        &mut tx,
        &run,
        input["sdk_tool_call_id"].as_str().unwrap_or(""),
    )
    .await?
    .ok_or(Error::new("not_available"))?;
    if tool.fingerprint
        != fingerprint(&json!({"name":input["tool_name"],"arguments":input["arguments"]}))
    {
        return Err(Error::new("idempotency_conflict"));
    }
    let message = conversations::read_message_in_tx(&mut tx, &conv, &run.message_id).await?;
    if input["tool_name"] == "manage_personal_asset" {
        let args = &input["arguments"];
        assets::memory_source(
            &message.body,
            args["instruction_quote"].as_str().unwrap_or(""),
            args["scope"].as_str().unwrap_or(""),
        )?;
        super::knowledge::check_refs_in_tx(&mut tx, ctx, &args["dependencies"]).await?;
        if args["action"] == "update_memory" {
            let old =
                assets::read_in_tx(&mut tx, ctx, args["asset_id"].as_str().unwrap_or(""), false)
                    .await?;
            if old["kind"] != "memory" || old["version"] != args["expected_version"] {
                return Err(Error::new("version_conflict"));
            }
        }
    }
    tx.commit().await?;
    Ok((
        json!({"kind":"run","id":run_id,"epoch":input["lease_epoch"],"sdk_tool_call_id":input["sdk_tool_call_id"],"operation_id":tool.operation_id}),
        message.body,
    ))
}

pub async fn extract(
    pool: &MySqlPool,
    ctx: &AccessContext,
    input: &Value,
) -> Result<Option<String>> {
    if !assets::memory_provider::enabled()
        || input["tool_name"] != "manage_personal_asset"
        || input["arguments"]["action"] == "disable_memory"
    {
        return Ok(None);
    }
    let (budget, message) = checked_binding(pool, ctx, input).await?;
    let quote = assets::memory_source(
        &message,
        input["arguments"]["instruction_quote"]
            .as_str()
            .unwrap_or(""),
        input["arguments"]["scope"].as_str().unwrap_or(""),
    )?;
    let request = json!({"operation_id":budget["operation_id"],"owner_id":ctx.user_id,"space_id":ctx.space_id,"message":message,"quote":quote,"budget":budget});
    let first = assets::memory_provider::call(
        "/extract",
        "MemoryExtractionRequest",
        "MemoryExtractionReceipt",
        &request,
    )
    .await;
    let value = match first {
        Err(e) if e.code == "memory_unavailable" => {
            // 只接回同一操作的持久提取结果；侧车的unknown记录禁止重新调用模型。
            checked_binding(pool, ctx, input).await?;
            assets::memory_provider::call(
                "/extract",
                "MemoryExtractionRequest",
                "MemoryExtractionReceipt",
                &request,
            )
            .await?
        }
        value => value?,
    };
    if value["operation_id"] != budget["operation_id"] {
        return Err(Error::new("idempotency_conflict"));
    }
    Ok(Some(
        value["body"]
            .as_str()
            .ok_or(Error::new("memory_unavailable"))?
            .to_owned(),
    ))
}

pub async fn search(
    pool: &MySqlPool,
    ctx: &AccessContext,
    input: &Value,
) -> (Vec<Value>, &'static str) {
    if !assets::memory_provider::enabled() {
        return (vec![], "builtin");
    }
    let args = &input["arguments"];
    if input["tool_name"] != "search_knowledge"
        || args["query"] == "*"
        || args["asset_after"].is_string()
    {
        return (vec![], "directory");
    }
    let outcome=async {
        let (budget,_)=checked_binding(pool,ctx,input).await?;
        let mut tx=AppTx::begin(pool).await?;
        let memories=assets::list_in_tx(&mut tx,ctx,true).await?;
        tx.commit().await?;
        if !memories.iter().any(|m|m["kind"]=="memory"){return Ok(json!({"candidates":[]}));}
        assets::memory_provider::call("/search","MemorySearchRequest","MemorySearchReceipt",&json!({"operation_id":budget["operation_id"],"owner_id":ctx.user_id,"space_id":ctx.space_id,"query":args["query"],"budget":budget})).await
    }.await;
    match outcome {
        Ok(v) => (
            v["candidates"].as_array().cloned().unwrap_or_default(),
            "mem0_authoritative",
        ),
        Err(e) => {
            eprintln!("memory_search_failure code={}", e.code);
            (vec![], "directory_fallback")
        }
    }
}

pub async fn queue_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    asset: &Value,
    scope: Option<&str>,
    extraction: Option<&str>,
) -> Result<()> {
    if !assets::memory_provider::enabled() || asset["kind"] != "memory" {
        return Ok(());
    }
    let profile = if let Some(scope) = scope {
        runtime::read_budget_profile_in_tx(tx, scope)
            .await?
            .map(|p| serde_json::to_value(p).expect("profile"))
    } else {
        std::env::var("DATA_AGENT_MODEL_PROFILE")
            .ok()
            .map(|s| serde_json::from_str::<Value>(&s).map_err(|_| Error::new("invalid_input")))
            .transpose()?
    };
    if let Some(p) = &profile {
        contracts::validate("ModelProfile", p)?;
    }
    assets::memory_index::queue_in_tx(tx, ctx, asset, scope, profile.as_ref(), extraction).await
}

pub async fn process_index(pool: &MySqlPool) -> Result<()> {
    if !assets::memory_provider::enabled() {
        return Ok(());
    }
    if let Ok(value) = std::env::var("DATA_AGENT_MODEL_PROFILE") {
        let profile: Value =
            serde_json::from_str(&value).map_err(|_| Error::new("invalid_input"))?;
        contracts::validate("ModelProfile", &profile)?;
        assets::memory_index::queue_missing(pool, &profile).await?;
    }
    let Some(job) = assets::memory_index::claim(pool).await? else {
        return Ok(());
    };
    let budget = json!({"kind":"index","id":job["id"],"epoch":job["epoch"],"sdk_tool_call_id":null,"operation_id":job["id"]});
    let result=assets::memory_provider::call("/index","MemoryIndexRequest","MemoryIndexReceipt",&json!({"operation_id":job["id"],"owner_id":job["owner_id"],"space_id":job["space_id"],"asset":job["asset"],"extraction_operation_id":job["extraction_operation_id"],"budget":budget})).await;
    if let Err(error) = &result {
        eprintln!("memory_index_failure job={} code={}", job["id"], error.code);
    }
    assets::memory_index::complete(pool, &job, result.as_ref().err().map(|e| e.code)).await
}

// 侧车无预算决定权；宿主从活动run或持久作业恢复原预算，结算不重新授予发送权。
pub async fn model_call(pool: &MySqlPool, input: Value) -> Result<Value> {
    contracts::validate("MemoryModelCall", &input)?;
    let binding = &input["budget"];
    let mut tx = AppTx::begin(pool).await?;
    if input["action"] == "finalize" {
        let receipt = runtime::memory_calls::finish_in_tx(&mut tx, &input).await?;
        tx.commit().await?;
        return Ok(receipt);
    }
    let budget = if binding["kind"] == "run" {
        let run_id = binding["id"].as_str().unwrap_or("");
        let ctx = super::deliver_run::context_for_run(pool, run_id).await?;
        let cid = runtime::locate_run(pool, run_id).await?;
        let conv = conversations::lock_conversation_in_tx(&mut tx, &ctx, &cid).await?;
        conversations::assert_turn_in_tx(
            &tx,
            &conv,
            run_id,
            epoch(binding["epoch"].as_str().unwrap_or("0"))?,
        )?;
        let run = runtime::lock_run_in_tx(&mut tx, run_id, &cid).await?;
        if run.state != "running" {
            return Err(Error::new("lease_lost"));
        }
        super::context_authority::assert_run_in_tx(&mut tx, &ctx, &cid, run_id).await?;
        if let Some(sdk) = binding["sdk_tool_call_id"].as_str() {
            let tool = runtime::lock_tool_call_in_tx(&mut tx, &run, sdk)
                .await?
                .ok_or(Error::new("not_available"))?;
            if binding["operation_id"] != tool.operation_id || tool.state != "registered" {
                return Err(Error::new("not_available"));
            }
        } else if binding["operation_id"] != format!("context-{}", run.message_id)
            || input["purpose"] != "memory_embedding"
        {
            return Err(Error::new("not_available"));
        }
        let profile = runtime::read_budget_profile_in_tx(&mut tx, &run.budget_scope_id)
            .await?
            .ok_or(Error::new("not_available"))?;
        runtime::memory_calls::MemoryBudget {
            scope_id: Some(run.budget_scope_id),
            profile,
        }
    } else {
        let job =
            assets::memory_index::read_job_in_tx(&mut tx, binding["id"].as_str().unwrap_or(""))
                .await?;
        if job["state"] != "issued"
            || job["valid"] != true
            || binding["epoch"] != job["epoch"]
            || binding["operation_id"] != job["id"]
        {
            return Err(Error::new("lease_lost"));
        }
        let ctx = AccessContext {
            user_id: job["owner_id"].as_str().unwrap_or("").to_owned(),
            space_id: job["space_id"].as_str().unwrap_or("").to_owned(),
            request_id: binding["operation_id"].as_str().unwrap_or("").to_owned(),
        };
        let asset = assets::read_in_tx(
            &mut tx,
            &ctx,
            job["asset"]["id"].as_str().unwrap_or(""),
            true,
        )
        .await?;
        if asset["version"] != job["asset"]["version"]
            || asset["body"] != job["asset"]["body"]
            || input["purpose"] != "memory_embedding"
        {
            return Err(Error::new("version_conflict"));
        }
        super::knowledge::check_refs_in_tx(&mut tx, &ctx, &asset["dependencies"]).await?;
        let scope = job["budget_scope_id"].as_str().map(str::to_owned);
        let profile = if let Some(scope) = &scope {
            runtime::read_budget_profile_in_tx(&mut tx, scope)
                .await?
                .ok_or(Error::new("not_available"))?
        } else {
            contracts::decode("ModelProfile", job["model_profile"].clone())?
        };
        runtime::memory_calls::MemoryBudget {
            scope_id: scope,
            profile,
        }
    };
    let receipt = runtime::memory_calls::issue_in_tx(&mut tx, &budget, &input).await?;
    tx.commit().await?;
    Ok(receipt)
}

pub async fn prepare_workspace(
    pool: &MySqlPool,
    ctx: &AccessContext,
    envelope: &mut Value,
) -> Result<()> {
    if !assets::memory_provider::enabled()
        || !envelope["workspace_context"].is_object()
        || envelope["resume_same_input"] == true
    {
        return Ok(());
    }
    let mut tx = AppTx::begin(pool).await?;
    let items = assets::list_in_tx(&mut tx, ctx, true)
        .await?
        .into_iter()
        .filter(|v| v["kind"] == "memory")
        .collect();
    let items = super::knowledge::valid_assets_in_tx(&mut tx, ctx, items).await?;
    tx.commit().await?;
    if items.is_empty() {
        return Ok(());
    }
    let binding = json!({"kind":"run","id":envelope["run_id"],"epoch":envelope["lease_epoch"],"sdk_tool_call_id":null,"operation_id":format!("context-{}",envelope["message_id"].as_str().unwrap_or(""))});
    let result=assets::memory_provider::call("/search","MemorySearchRequest","MemorySearchReceipt",&json!({"operation_id":binding["operation_id"],"owner_id":ctx.user_id,"space_id":ctx.space_id,"query":envelope["text"].as_str().unwrap_or("").chars().take(1600).collect::<String>(),"budget":binding})).await;
    let Ok(result) = result else {
        envelope["workspace_context"]["memory_retrieval"] = json!("directory_fallback");
        return Ok(());
    };
    let mut tx = AppTx::begin(pool).await?;
    let cid = envelope["conversation_id"].as_str().unwrap_or("");
    let conv = conversations::lock_conversation_in_tx(&mut tx, ctx, cid).await?;
    let run_id = envelope["run_id"].as_str().unwrap_or("").to_owned();
    conversations::assert_turn_in_tx(
        &tx,
        &conv,
        &run_id,
        epoch(envelope["lease_epoch"].as_str().unwrap_or("0"))?,
    )?;
    super::context_authority::assert_run_in_tx(&mut tx, ctx, cid, &run_id).await?;
    let current = assets::list_in_tx(&mut tx, ctx, true)
        .await?
        .into_iter()
        .filter(|v| v["kind"] == "memory")
        .collect();
    let current = super::knowledge::valid_assets_in_tx(&mut tx, ctx, current).await?;
    let mut ranked = Vec::new();
    for candidate in result["candidates"].as_array().into_iter().flatten() {
        if let Some(asset) = current
            .iter()
            .find(|v| v["id"] == candidate["asset_id"] && v["version"] == candidate["version"])
        {
            ranked.push(asset.clone());
        }
    }
    // 尚未建好索引的记忆也可从正式目录找到，保留原有完整目录工具。
    for asset in &current {
        if !ranked.iter().any(|v| v["id"] == asset["id"]) {
            ranked.push(asset.clone());
        }
    }
    ranked.truncate(20);
    envelope["workspace_context"]["memories"] = json!(
        ranked
            .into_iter()
            .map(|v| crate::modules::retrieval::model_page(v, 0, 600, None))
            .collect::<Vec<_>>()
    );
    envelope["workspace_context"]["memory_retrieval"] = json!("mem0_authoritative");
    crate::modules::retrieval::bound_workspace(&mut envelope["workspace_context"]);
    let mut snapshot = envelope["workspace_context"]["authority_snapshot"].clone();
    super::context_authority::observe(&mut snapshot, &envelope["workspace_context"]);
    runtime::save_authority_in_tx(&mut tx, &run_id, &snapshot).await?;
    envelope["workspace_context"]["authority_revision"] = json!(fingerprint(&snapshot));
    envelope["workspace_context"]["authority_snapshot"] = snapshot;
    tx.commit().await
}

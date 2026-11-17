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
    RawIndex(&'a Value, &'a str, u64, String),
    Browse,
}

// 旧作业回执查询与新发送共用同一身份；配置变化不能改变已经发出的操作。
fn raw_index_operation(
    space: &str,
    source: &str,
    revision: u64,
    texts_fingerprint: &str,
) -> String {
    fingerprint(&json!([
        "raw-source-index",
        space,
        source,
        revision,
        embedding::SPEC.version,
        texts_fingerprint
    ]))
}

pub(crate) fn maintenance_profile() -> Result<Option<Value>> {
    let Some(raw) = std::env::var("DATA_AGENT_EMBEDDING_PROFILE").ok() else {
        return Ok(None);
    };
    let value: Value = serde_json::from_str(&raw).map_err(|_| Error::new("invalid_input"))?;
    contracts::validate("EmbeddingProfile", &value)?;
    Ok(Some(value))
}

// 配置不可用时的原文恢复资格判定：已冻结目标直接可续；未冻结的旧raw按
// 确定性切块重建每批操作身份，原账本存在任一回执行（settled或unknown）即可
// 回放或收敛；零回执且无配置的目标保持pending，不空耗索引次数。领取仍由
// claim按原租约纪律加锁复核，这里只给精确身份清单。
pub(crate) async fn recoverable_source_heads_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
) -> Result<Vec<(String, String, u64)>> {
    let heads = knowledge::source_index_heads_in_tx(tx, &ctx.space_id).await?;
    let mut recoverable = Vec::new();
    for (source_kind, object_id, version, frozen) in heads {
        if frozen.is_some() {
            recoverable.push((source_kind, object_id, version));
            continue;
        }
        let key = crate::contracts::generated::SourceKey {
            kind: if source_kind == "document" {
                crate::contracts::generated::SourceKeyKind::Document
            } else {
                crate::contracts::generated::SourceKeyKind::Platform
            },
            id: object_id.clone(),
        };
        let alias = super::knowledge::source_alias(&key);
        let Some((space, current)) =
            super::knowledge_sources::resolve_source_head_in_tx(tx, &alias).await?
        else {
            continue;
        };
        // 来源头已越过待办修订或正文不完整时交回正常路径收敛，不在此猜身份。
        if current > version {
            continue;
        }
        let body_ctx = AccessContext {
            user_id: "synthetic-raw-index".into(),
            space_id: space,
            request_id: ctx.request_id.clone(),
        };
        let value = match super::knowledge_sources::read_in_tx(tx, &body_ctx, &alias, Some(version))
            .await
        {
            Ok(value) => value,
            Err(error)
                if matches!(
                    error.code,
                    "not_available" | "stale_knowledge" | "stale_source"
                ) =>
            {
                continue;
            }
            Err(error) => return Err(error),
        };
        if value["version"].as_str() != Some(version.to_string().as_str())
            || value["complete"] != true
        {
            continue;
        }
        let revision_text = version.to_string();
        let source = crate::modules::retrieval::source_segments::SourceText {
            source: &key,
            revision: &revision_text,
            text: value["body"].as_str().unwrap_or(""),
            format: if matches!(
                key.kind,
                crate::contracts::generated::SourceKeyKind::Document
            ) {
                crate::modules::retrieval::source_segments::SourceFormat::Markdown
            } else {
                crate::modules::retrieval::source_segments::SourceFormat::Sql
            },
            background: &[],
        };
        // 与消费者同构的确定性切块与分批：先收集全部piece再按嵌入输入上限
        // 分组，每批身份与原发送一一对应。
        let batches: Vec<Vec<String>> = {
            let mut pieces = Vec::new();
            let mut cursor = None;
            loop {
                let batch = crate::modules::retrieval::source_segments::segment_source(
                    &source,
                    cursor.as_ref(),
                )?;
                if batch.segments.is_empty() {
                    break;
                }
                for segment in &batch.segments {
                    pieces.push(json!({"text": segment.text}));
                }
                match batch.next_cursor {
                    Some(next) => cursor = Some(next),
                    None => break,
                }
            }
            embedding::batches(&pieces)?
                .into_iter()
                .map(|chunk| {
                    chunk
                        .iter()
                        .map(|piece| piece["text"].as_str().unwrap_or("").to_owned())
                        .collect()
                })
                .collect()
        };
        let mut found = false;
        for texts in &batches {
            let operation =
                raw_index_operation(&ctx.space_id, &alias, version, &fingerprint(&json!(texts)));
            let request = embedding::prepare(texts)?;
            let attempt = fingerprint(&json!(["shared-embedding", operation, request.fingerprint]));
            if runtime::provider_calls::attempt_state_in_tx(tx, &attempt)
                .await?
                .is_some()
            {
                found = true;
                break;
            }
        }
        if found {
            recoverable.push((source_kind, object_id, version));
        }
    }
    Ok(recoverable)
}

// 返回（预算、操作身份、实际选中的索引配置）。冻结值不取决于当前环境；
// trial登记可以在冻结提交后接续，不把已有冻结值当作登记已完成的证明。
async fn authorize_in_tx(
    tx: &mut AppTx<'_>,
    pool: &MySqlPool,
    ctx: &AccessContext,
    binding: &Binding<'_>,
) -> Result<(
    runtime::provider_calls::ProviderBudget,
    String,
    Option<EmbeddingProfile>,
)> {
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
                None,
            ))
        }
        Binding::RawIndex(job, source, revision, texts_fingerprint) => {
            // 原文索引不依赖知识对象；预算与幂等身份按来源修订+批次文本指纹绑定：
            // 同修订同批重试指纹一致（回放共享缓存不重发计费），切块顺序变化或
            // 幂等跳批也不会让不同文本共用同一操作身份。首用冻结配置，重建重绑
            // 后补批沿用冻结trial，不换trial补额。
            let raw = match knowledge::bound_source_index_embedding_in_tx(tx, job).await? {
                Some(frozen) => frozen,
                None => {
                    let current = maintenance_profile()?.ok_or(Error::new("budget_unavailable"))?;
                    knowledge::freeze_source_index_embedding_in_tx(tx, job, &current).await?;
                    current
                }
            };
            let profile: EmbeddingProfile = contracts::decode("EmbeddingProfile", raw)?;
            Ok((
                embedding_budget(&profile),
                raw_index_operation(&ctx.space_id, source, *revision, texts_fingerprint),
                Some(profile),
            ))
        }
        Binding::Index(job, batch) => {
            super::knowledge::assert_source_in_tx(tx, ctx, &job["object"]).await?;
            let raw = match knowledge::bound_index_embedding_in_tx(tx, ctx, job).await? {
                Some(frozen) => frozen,
                None => {
                    let current = maintenance_profile()?.ok_or(Error::new("budget_unavailable"))?;
                    knowledge::freeze_index_embedding_in_tx(tx, job, &current).await?;
                    current
                }
            };
            let profile: EmbeddingProfile = contracts::decode("EmbeddingProfile", raw)?;
            Ok((
                embedding_budget(&profile),
                fingerprint(&json!([
                    "knowledge-index",
                    ctx.space_id,
                    job["object_id"],
                    job["job_version"],
                    embedding::SPEC.version,
                    batch
                ])),
                Some(profile),
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
                None,
            ))
        }
    }
}

fn embedding_budget(profile: &EmbeddingProfile) -> runtime::provider_calls::ProviderBudget {
    runtime::provider_calls::ProviderBudget {
        scope_id: None,
        trial_id: profile.trial_id.clone(),
        input_limit: embedding::SPEC.input_bytes_limit as u64,
        output_limit: 0,
    }
}

pub async fn embed(
    pool: &MySqlPool,
    ctx: &AccessContext,
    binding: Binding<'_>,
    texts: Vec<String>,
    deadline: Option<tokio::time::Instant>,
) -> Result<Vec<Vec<f32>>> {
    let request = embedding::prepare(&texts)?;
    // 当前公开MVP只有合成demo空间；静态接入范围在此入口检查一次。
    if ctx.space_id != "demo" {
        return Err(Error::new("not_available"));
    }
    access::authorize_model("bailian")?;
    if let Binding::RawIndex(job, source, revision, texts_fingerprint) = &binding {
        let operation = raw_index_operation(&ctx.space_id, source, *revision, texts_fingerprint);
        let input = json!({
            "call_attempt_id":fingerprint(&json!(["shared-embedding",operation,request.fingerprint])),
            "budget":{"operation_id":operation},"parameters_fingerprint":request.fingerprint,
        });
        let mut tx = AppTx::begin(pool).await?;
        knowledge::renew_source_index_lease_in_tx(&mut tx, job).await?;
        // 已发送批次由原账本裁定；只有不存在原调用时才读取当前首发配置。
        // unknown、参数冲突及不可用回执直接保留原错误，不换trial重发。
        let cached = runtime::provider_calls::cached_embedding_in_tx(&mut tx, &input).await?;
        tx.commit().await?;
        if let Some(cached) = cached {
            return serde_json::from_value(cached).map_err(|_| Error::new("embedding_unavailable"));
        }
    }
    // 登记实际选中的trial：索引沿原冻结配置幂等登记，覆盖冻结已提交但登记
    // 尚未完成的中断；当前环境的新trial不参与，原预算不会重置。
    if let Binding::Browse = binding
        && let Some(raw) = maintenance_profile()?
    {
        let profile = contracts::decode("EmbeddingProfile", raw)?;
        runtime::configure_embedding_trial(pool, &profile).await?;
    }
    if matches!(binding, Binding::Index(..) | Binding::RawIndex(..)) {
        // 首用配置先独立保存；之后许可因预算不足回滚，不能顺带抹掉原绑定。
        // 许可事务仍核当前租约，两个事务间的状态可能已发生变化。
        let mut tx = AppTx::begin(pool).await?;
        let (_, _, selected) = authorize_in_tx(&mut tx, pool, ctx, &binding).await?;
        tx.commit().await?;
        if let Some(profile) = selected {
            runtime::configure_embedding_trial(pool, &profile).await?;
        }
    }
    let mut tx = AppTx::begin(pool).await?;
    let (budget, operation, _) = authorize_in_tx(&mut tx, pool, ctx, &binding).await?;

    let input = json!({"call_attempt_id":fingerprint(&json!(["shared-embedding",operation,request.fingerprint])),
        "purpose":"knowledge_embedding","budget":{"operation_id":operation},"parameters_fingerprint":request.fingerprint,
        "input_tokens_upper":request.input_upper,"output_tokens_max":0,"usage":null});
    if let Some(cached) = runtime::provider_calls::cached_embedding_in_tx(&mut tx, &input).await? {
        tx.commit().await?;
        return serde_json::from_value(cached).map_err(|_| Error::new("embedding_unavailable"));
    }
    // 时点1（05接续）：领取发送许可前到期——不开始新调用，不领许可不付费。
    if deadline.is_some_and(|deadline| tokio::time::Instant::now() >= deadline) {
        drop(tx);
        return Err(Error::new("embedding_unavailable"));
    }
    let permit = runtime::provider_calls::issue_in_tx(&mut tx, &budget, &input).await?;
    tx.commit().await?;
    if permit["send_allowed"] != true {
        return Err(Error::new("embedding_unknown"));
    }
    // 时点2：许可已入账、尚未调用发送函数时到期——宿主确认本次没有发送，以
    // 已知零消耗沿finish_in_tx结算，保留原身份与已用调用次数，不写向量成功
    // 缓存，也不冒称取得供应商usage。
    if deadline.is_some_and(|deadline| tokio::time::Instant::now() >= deadline) {
        let mut settled = input;
        settled["usage"] = json!({"input_tokens":0,"output_tokens":0,"elapsed_ms":0});
        let mut tx = AppTx::begin(pool).await?;
        runtime::provider_calls::finish_embedding_in_tx(&mut tx, &settled, None).await?;
        tx.commit().await?;
        return Err(Error::new("embedding_unavailable"));
    }
    let started = std::time::Instant::now();
    // 时点3：发送与响应读取共用剩余期限；超时沿原实际/unknown路径收尾，上层不
    // 取消这段账本结算，也不换身份重试。
    let response = match deadline {
        Some(deadline) => match tokio::time::timeout_at(deadline, request.send()).await {
            Ok(response) => response,
            Err(_) => Err(Error::new("embedding_unknown")),
        },
        None => request.send().await,
    };
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
) -> Result<crate::use_cases::knowledge::KnowledgeSearch> {
    search_scoped(
        pool,
        ctx,
        query,
        input,
        &crate::search_scope::KnowledgeSearchScope::default(),
        None,
    )
    .await
}

// 仅拥有查询Embedding的授权、发送与原账本结算；检索页由knowledge组合入口推进。
pub struct SearchLaunch {
    pub embedding: tokio::task::JoinHandle<Result<Option<Vec<f32>>>>,
}

pub async fn launch_scoped(
    pool: &MySqlPool,
    ctx: &AccessContext,
    query: &str,
    input: Option<&Value>,
    include_raw: bool,
    allowed: Option<&vector::AllowedRecords>,
    deadline: tokio::time::Instant,
) -> Option<SearchLaunch> {
    if !vector::enabled()
        || query == "*"
        || (!include_raw && input.is_some_and(|i| i["arguments"]["asset_after"].is_string()))
    {
        return None;
    }
    // 可交付类型决定空集：v1只看知识，内部双类型还须检查原文来源。
    if let Some(records) = allowed
        && records.knowledge_ids.is_empty()
        && (!include_raw || records.sources.is_empty())
    {
        return None;
    }
    let binding_input = input.cloned();
    let query_text: String = query.chars().take(1600).collect();
    let embed_pool = pool.clone();
    let embed_ctx = ctx.clone();
    let embedding = tokio::spawn(async move {
        let binding = binding_input
            .as_ref()
            .map_or(Binding::Browse, Binding::Tool);
        match embed(
            &embed_pool,
            &embed_ctx,
            binding,
            vec![query_text],
            Some(deadline),
        )
        .await
        {
            Ok(mut vectors) => Ok((!vectors.is_empty()).then(|| vectors.remove(0))),
            Err(error)
                if matches!(
                    error.code,
                    "embedding_unavailable"
                        | "embedding_unknown"
                        | "budget_exhausted"
                        | "budget_unavailable"
                ) =>
            {
                eprintln!("knowledge_embedding_failure code={}", error.code);
                // 嵌入不可用不阻止能执行的范围（05切片5）：dense无查询向量按
                // 本路不可用计，词法通道照常召回，如实bounded。
                Ok(None)
            }
            Err(error) => Err(error),
        }
    });
    Some(SearchLaunch { embedding })
}

// 浏览等待式检索（05切片4起与工具路径共用组合推进）：词法就绪即核验并在期限内
// 预读，嵌入就绪即dense首轮并入共同排序；慢嵌入不再饿死词法路——期限前已读
// 正文照常交付。最终装配在自己的短读事务中复用预读内容。嵌入句柄不取消——
// 内部按三时点与剩余期限自行收尾账本。
pub async fn search_scoped(
    pool: &MySqlPool,
    ctx: &AccessContext,
    query: &str,
    input: Option<&Value>,
    scope: &crate::search_scope::KnowledgeSearchScope,
    allowed: Option<&vector::AllowedRecords>,
) -> Result<crate::use_cases::knowledge::KnowledgeSearch> {
    let deadline = vector::retrieval_deadline();
    let launch = launch_scoped(pool, ctx, query, input, false, allowed, deadline).await;
    let mut candidates = vector::Candidates::lexical();
    candidates.deadline = deadline;
    let checked = super::context_authority::CheckedTextResults::default();
    let stage = super::knowledge::search_stage_outside_lock(
        pool,
        ctx,
        &mut super::knowledge::ScopedSearchRequest {
            query,
            limit: 30,
            launch,
            vector: candidates,
            scope,
            allowed,
            asset_after: None,
            hints: None,
            cid: "",
            text_results: &checked,
            include_raw: false,
        },
    )
    .await?;
    Ok(stage.search)
}

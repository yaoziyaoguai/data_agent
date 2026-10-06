use crate::{
    contracts,
    modules::{access, assets, ingestion, knowledge, retrieval},
    persistence::AppTx,
    types::{AccessContext, Error, Result, epoch, id},
};
use serde_json::{Value, json};
use sqlx::MySqlPool;
pub async fn initialize(pool: &MySqlPool) -> Result<()> {
    let ctx = AccessContext {
        user_id: "synthetic-import".into(),
        space_id: "demo".into(),
        request_id: id(),
    };
    let mut tx = AppTx::begin(pool).await?;
    sync_catalog_in_tx(&mut tx, &ctx).await?;
    tx.commit().await
}
pub async fn list(
    pool: &MySqlPool,
    ctx: &AccessContext,
    query: Option<&str>,
    after: Option<&str>,
    related: Option<&str>,
) -> Result<Value> {
    if query.is_some() && related.is_some() {
        return Err(Error::new("invalid_input"));
    }
    let vector = if let Some(query) = query {
        super::knowledge_embeddings::search(pool, ctx, query, None).await
    } else {
        retrieval::vector::Candidates::lexical()
    };
    let mut tx = AppTx::begin(pool).await?;
    if let Some(object) = related {
        knowledge::read_in_tx(&mut tx, ctx, object, None, true).await?;
    }
    let (values, next, coverage) = if let Some(query) = query {
        let result = retrieve_in_tx(&mut tx, ctx, query, 30, &vector).await?;
        (result.objects, None, Some(result.coverage))
    } else {
        let (values, next) = knowledge::page_in_tx(&mut tx, ctx, after, related).await?;
        (values, next, None)
    };
    let mut values = values;
    for value in &mut values {
        value["prefill_status"] =
            ingestion::prefill_status_in_tx(&mut tx, ctx, value["id"].as_str().unwrap_or(""))
                .await?;
        if let Some(preference) =
            ingestion::read_analysis_preference_in_tx(&mut tx, ctx, value).await?
        {
            value["analysis_preference"] = preference;
        }
    }
    tx.commit().await?;
    Ok(
        json!({"objects":values,"next_after_id":next,"search_coverage":coverage,"retrieval_mode":if vector.state=="available"{"hybrid_authoritative"}else{"lexical_authoritative"}}),
    )
}
pub async fn read(
    pool: &MySqlPool,
    ctx: &AccessContext,
    object: &str,
    version: Option<u64>,
) -> Result<Value> {
    let mut tx = AppTx::begin(pool).await?;
    let mut v = knowledge::read_in_tx(&mut tx, ctx, object, version, true).await?;
    if version.is_none() {
        v["prefill_status"] = ingestion::prefill_status_in_tx(&mut tx, ctx, object).await?;
        if let Some(preference) =
            ingestion::read_analysis_preference_in_tx(&mut tx, ctx, &v).await?
        {
            v["analysis_preference"] = preference;
        }
    }
    tx.commit().await?;
    Ok(v)
}
pub async fn edit(
    pool: &MySqlPool,
    ctx: &AccessContext,
    object: Option<&str>,
    action: &str,
    input: Value,
) -> Result<Value> {
    access::authorize_maintainer(ctx)?;
    let mut tx = AppTx::begin(pool).await?;
    let v = match action {
        "create" => {
            contracts::validate("KnowledgeCreate", &input)?;
            knowledge::create_in_tx(&mut tx, ctx, &input).await?
        }
        "edit" => {
            contracts::validate("KnowledgeEdit", &input)?;
            let object = object.ok_or(Error::new("invalid_input"))?;
            if let Some(receipt) = knowledge::begin_edit_in_tx(&mut tx, ctx, object, &input).await?
            {
                receipt
            } else {
                let mut source_value = None;
                if input["clear_override"] == true {
                    let old = knowledge::read_in_tx(&mut tx, ctx, object, None, true).await?;
                    let entry = old["entries"].as_array().and_then(|entries| {
                        entries
                            .iter()
                            .find(|entry| entry["entry_id"] == input["entry_id"])
                    });
                    // 旧条目尚未保存来源基础值时，用同版本候选补齐，不能把quote当正文。
                    if entry.is_some_and(|entry| {
                        entry["suggestion"]["value"].as_str().is_none()
                            && entry["source_facts"]["value"].as_str().is_none()
                    }) && let Some(source) = old["source_id"].as_str()
                    {
                        assert_source_in_tx(&mut tx, ctx, &old).await?;
                        let candidate = if source.starts_with("catalog-") {
                            ingestion::catalog_candidate_in_tx(&mut tx, ctx, source, object).await?
                        } else {
                            let catalog = current_catalog_in_tx(&mut tx, ctx).await?;
                            catalog["objects"]
                                .as_array()
                                .and_then(|objects| {
                                    objects.iter().find(|candidate| candidate["id"] == object)
                                })
                                .ok_or(Error::new("unsupported"))?
                                .clone()
                        };
                        source_value = candidate["entries"]
                            .as_array()
                            .and_then(|entries| {
                                entries
                                    .iter()
                                    .find(|entry| entry["entry_id"] == input["entry_id"])
                            })
                            .and_then(|entry| entry["effective_value"].as_str())
                            .map(str::to_owned);
                    }
                }
                knowledge::save_edit_in_tx(&mut tx, ctx, object, &input, source_value.as_deref())
                    .await?
            }
        }
        "reanalyze" => {
            contracts::validate("VersionCommand", &input)?;
            let object = object.ok_or(Error::new("invalid_input"))?;
            if let Some(receipt) =
                knowledge::begin_reanalysis_in_tx(&mut tx, ctx, object, &input).await?
            {
                contracts::validate("KnowledgeObject", &receipt)?;
                tx.commit().await?;
                return Ok(receipt);
            }
            let old = knowledge::read_in_tx(&mut tx, ctx, object, None, true).await?;
            let source = old["source_id"].as_str().ok_or(Error::new("unsupported"))?;
            let version = ingestion::source_version_in_tx(&mut tx, &ctx.space_id, source).await?;
            let (candidate, sources) = if source.starts_with("catalog-") {
                let candidate =
                    ingestion::catalog_candidate_in_tx(&mut tx, ctx, source, object).await?;
                let sources =
                    vec![ingestion::read_source_in_tx(&mut tx, ctx, source, version).await?];
                (candidate, sources)
            } else {
                let catalog = current_catalog_in_tx(&mut tx, ctx).await?;
                let candidate = catalog["objects"]
                    .as_array()
                    .and_then(|a| a.iter().find(|v| v["id"] == object))
                    .ok_or(Error::new("unsupported"))?
                    .clone();
                (candidate, sources_in_tx(&mut tx, ctx).await?)
            };
            let updated =
                knowledge::reanalyze_in_tx(&mut tx, ctx, object, &input, version, &candidate)
                    .await?;
            super::prefill_materials::queue_in_tx(&mut tx, ctx, &updated, sources).await?;
            updated
        }
        "apply-proposal" => {
            contracts::validate("VersionCommand", &input)?;
            knowledge::apply_proposal_in_tx(
                &mut tx,
                ctx,
                object.ok_or(Error::new("invalid_input"))?,
                &input,
            )
            .await?
        }
        state @ ("enabled" | "disabled" | "deleted") => {
            contracts::validate("VersionCommand", &input)?;
            knowledge::change_state_in_tx(
                &mut tx,
                ctx,
                object.ok_or(Error::new("invalid_input"))?,
                &input,
                state,
            )
            .await?
        }
        _ => return Err(Error::new("invalid_input")),
    };
    contracts::validate("KnowledgeObject", &v)?;
    tx.commit().await?;
    Ok(v)
}
pub async fn source(
    pool: &MySqlPool,
    ctx: &AccessContext,
    source: &str,
    version: u64,
) -> Result<Value> {
    let mut tx = AppTx::begin(pool).await?;
    let v = super::knowledge_sources::read_in_tx(&mut tx, ctx, source, Some(version)).await?;
    tx.commit().await?;
    Ok(v)
}

pub async fn set_table_analysis_preference(
    pool: &MySqlPool,
    ctx: &AccessContext,
    table: &str,
    input: Value,
) -> Result<Value> {
    access::authorize_maintainer(ctx)?;
    contracts::validate("AnalysisPreferenceCommand", &input)?;
    let mut tx = AppTx::begin(pool).await?;
    let object = knowledge::read_in_tx(&mut tx, ctx, table, None, true).await?;
    if object["kind"] != "table" {
        return Err(Error::new("invalid_input"));
    }
    let (receipt, changed) =
        ingestion::save_analysis_preference_in_tx(&mut tx, ctx, table, &input).await?;
    if changed && receipt["preferred"] == true {
        for object in knowledge::table_objects_in_tx(&mut tx, ctx, table).await? {
            let Some(source) = object["source_id"].as_str() else {
                continue;
            };
            let sources = if source.starts_with("catalog-") {
                let version =
                    ingestion::source_version_in_tx(&mut tx, &ctx.space_id, source).await?;
                vec![ingestion::read_source_in_tx(&mut tx, ctx, source, version).await?]
            } else {
                sources_in_tx(&mut tx, ctx).await?
            };
            super::prefill_materials::queue_in_tx(&mut tx, ctx, &object, sources).await?;
        }
    }
    contracts::validate("TableAnalysisPreference", &receipt)?;
    tx.commit().await?;
    Ok(receipt)
}
pub async fn proposals(pool: &MySqlPool, ctx: &AccessContext) -> Result<Value> {
    let mut tx = AppTx::begin(pool).await?;
    let v = knowledge::proposals_in_tx(&mut tx, ctx).await?;
    tx.commit().await?;
    Ok(json!({"proposals":v}))
}
pub async fn sync(pool: &MySqlPool, ctx: &AccessContext, key: &str) -> Result<Value> {
    access::authorize_maintainer(ctx)?;
    let mut tx = AppTx::begin(pool).await?;
    sync_catalog_in_tx(&mut tx, ctx).await?;
    tx.commit().await?;
    super::catalog_import::sync(pool, ctx, key).await
}

async fn sync_catalog_in_tx(tx: &mut AppTx<'_>, ctx: &AccessContext) -> Result<Vec<(String, u64)>> {
    let changed = ingestion::sync_sources_in_tx(tx, &ctx.space_id).await?;
    let catalog = current_catalog_in_tx(tx, ctx).await?;
    let objects = knowledge::list_in_tx(tx, ctx, false).await?;
    knowledge::seed_in_tx(tx, ctx, &catalog).await?;
    for (source, source_version) in &changed {
        for object in objects.iter().filter(|o| depends_on_source(o, source)) {
            if let Some(candidate) = catalog["objects"]
                .as_array()
                .and_then(|a| a.iter().find(|c| c["id"] == object["id"]))
            {
                let latest =
                    knowledge::read_in_tx(tx, ctx, object["id"].as_str().unwrap_or(""), None, true)
                        .await?;
                let root_version = epoch(candidate["source_version"].as_str().unwrap_or("0"))?;
                let updated=knowledge::reanalyze_in_tx(tx,ctx,object["id"].as_str().unwrap_or(""),&json!({"operation_id":format!("sync-{}-{}-{}",object["id"].as_str().unwrap_or(""),source,source_version),"expected_version":latest["version"]}),root_version,candidate).await?;
                let sources = sources_in_tx(tx, ctx).await?;
                super::prefill_materials::queue_in_tx(tx, ctx, &updated, sources).await?;
            }
        }
    }
    Ok(changed)
}
pub async fn valid_assets_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    items: Vec<Value>,
) -> Result<Vec<Value>> {
    let mut valid = Vec::new();
    for item in items {
        if check_refs_in_tx(tx, ctx, &item["dependencies"])
            .await
            .is_ok()
        {
            valid.push(item);
        }
    }
    Ok(valid)
}
pub async fn read_asset(pool: &MySqlPool, ctx: &AccessContext, asset: &str) -> Result<Value> {
    let mut tx = AppTx::begin(pool).await?;
    let v = assets::read_in_tx(&mut tx, ctx, asset, false).await?;
    tx.commit().await?;
    Ok(v)
}
pub async fn source_head(pool: &MySqlPool, ctx: &AccessContext, source: &str) -> Result<Value> {
    let mut tx = AppTx::begin(pool).await?;
    let v = super::knowledge_sources::read_in_tx(&mut tx, ctx, source, None).await?;
    tx.commit().await?;
    Ok(v)
}

pub async fn check_refs_in_tx(tx: &mut AppTx<'_>, ctx: &AccessContext, refs: &Value) -> Result<()> {
    knowledge::check_refs_in_tx(tx, ctx, refs).await?;
    for r in refs.as_array().ok_or(Error::new("invalid_input"))? {
        let v = knowledge::read_in_tx(tx, ctx, r["object_id"].as_str().unwrap_or(""), None, false)
            .await?;
        assert_source_in_tx(tx, ctx, &v).await?;
    }
    Ok(())
}
pub async fn assert_source_in_tx(tx: &mut AppTx<'_>, ctx: &AccessContext, v: &Value) -> Result<()> {
    super::knowledge_sources::assert_in_tx(tx, ctx, v).await
}
pub async fn effective_in_tx(tx: &mut AppTx<'_>, ctx: &AccessContext) -> Result<Vec<Value>> {
    let all = knowledge::list_in_tx(tx, ctx, true).await?;
    let mut valid = Vec::new();
    for v in all {
        if assert_source_in_tx(tx, ctx, &v).await.is_ok() {
            valid.push(v);
        }
    }
    Ok(valid)
}

pub async fn process_index(pool: &MySqlPool) -> Result<bool> {
    let ctx = AccessContext {
        user_id: "synthetic-index".into(),
        space_id: "demo".into(),
        request_id: id(),
    };
    let vector = retrieval::vector::enabled();
    let target = if vector {
        retrieval::vector::index_target().await?
    } else {
        retrieval::vector::target()
    };
    let mut tx = AppTx::begin(pool).await?;
    let jobs = knowledge::claim_index_batch_in_tx(&mut tx, &ctx, vector, Some(&target)).await?;
    if jobs.is_empty() {
        tx.commit().await?;
        return Ok(false);
    }
    let mut valid = Vec::new();
    for job in &jobs {
        retrieval::index_in_tx(&mut tx, &ctx.space_id, &job["object"]).await?;
        if job["object"]["state"] != "enabled"
            || assert_source_in_tx(&mut tx, &ctx, &job["object"])
                .await
                .is_ok()
        {
            valid.push(job["object"].clone());
        }
    }
    tx.commit().await?;
    // Embedding、Milvus及查证均在领取事务外；查询Worker独立运行。
    let applied = if vector {
        Some(
            retrieval::vector::apply(&ctx.space_id, &valid, |object, batch, texts| {
                let jobs = &jobs;
                let ctx = &ctx;
                async move {
                    let job = jobs
                        .iter()
                        .find(|j| j["object_id"] == object["id"])
                        .ok_or(Error::new("not_available"))?;
                    super::knowledge_embeddings::embed(
                        pool,
                        ctx,
                        super::knowledge_embeddings::Binding::Index(job, batch),
                        texts,
                    )
                    .await
                }
            })
            .await,
        )
    } else {
        None
    };
    let mut tx = AppTx::begin(pool).await?;
    for job in &jobs {
        let (receipt, error) = match &applied {
            Some(Ok(reports)) => {
                let receipt = reports
                    .iter()
                    .find(|v| v["id"] == job["object_id"] && v["version"] == job["job_version"]);
                (
                    receipt,
                    if receipt.is_none() {
                        Some("stale_knowledge")
                    } else {
                        None
                    },
                )
            }
            Some(Err(error)) => (None, Some(error.code)),
            None => (None, None),
        };
        knowledge::finish_index_in_tx(&mut tx, job, receipt, error).await?;
    }
    tx.commit().await?;
    Ok(true)
}

pub async fn rebuild_index(pool: &MySqlPool, ctx: &AccessContext, input: &Value) -> Result<Value> {
    access::authorize_maintainer(ctx)?;
    contracts::validate("CreateConversation", input)?;
    if !retrieval::vector::enabled() {
        return Err(Error::new("vector_unconfigured"));
    }
    let target = retrieval::vector::index_target().await?;
    let mut tx = AppTx::begin(pool).await?;
    let receipt = knowledge::rebuild_index_in_tx(
        &mut tx,
        ctx,
        &target,
        input["operation_id"].as_str().unwrap_or(""),
    )
    .await?;
    tx.commit().await?;
    Ok(receipt)
}

fn depends_on_source(object: &Value, source: &str) -> bool {
    object["source_id"] == source
        || object["entries"].as_array().is_some_and(|items| {
            items.iter().any(|e| {
                e["source_facts"]["source_id"] == source
                    || e["suggestion"]["evidence"]
                        .as_array()
                        .is_some_and(|refs| refs.iter().any(|r| r["source_id"] == source))
            })
        })
}
async fn sources_in_tx(tx: &mut AppTx<'_>, ctx: &AccessContext) -> Result<Vec<Value>> {
    let mut sources = Vec::new();
    for name in ["schema", "etl", "business-guide"] {
        let version = ingestion::source_version_in_tx(tx, &ctx.space_id, name).await?;
        sources.push(ingestion::read_source_in_tx(tx, ctx, name, version).await?);
    }
    Ok(sources)
}
async fn current_catalog_in_tx(tx: &mut AppTx<'_>, ctx: &AccessContext) -> Result<Value> {
    let mut catalog = ingestion::synthetic_catalog()?;
    let sources = sources_in_tx(tx, ctx).await?;
    for object in catalog["objects"]
        .as_array_mut()
        .ok_or(Error::new("invalid_input"))?
    {
        if let Some(source) = sources
            .iter()
            .find(|s| s["source_id"] == object["source_id"])
        {
            object["source_version"] = source["version"].clone();
        }
        ingestion::prefill::refresh_facts(object, &sources);
    }
    Ok(catalog)
}

pub struct KnowledgeSearch {
    pub objects: Vec<Value>,
    pub coverage: Value,
}
pub async fn retrieve_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    query: &str,
    limit: usize,
    vector: &retrieval::vector::Candidates,
) -> Result<KnowledgeSearch> {
    let indexed = retrieval::candidates_in_tx(tx, &ctx.space_id, query).await?;
    let current = knowledge::matching_in_tx(tx, ctx, query, &retrieval::tokens(query)).await?;
    let mut candidates = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let limited = current.len() > 1000 || indexed.len() > 1000;
    let all = current
        .into_iter()
        .take(1000)
        .chain(indexed.into_iter().take(1000))
        .chain(vector.values.iter().cloned())
        .collect::<Vec<_>>();
    let ids = all
        .iter()
        .filter_map(|v| v["id"].as_str().map(str::to_owned))
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let values = knowledge::current_objects_in_tx(tx, ctx, &ids).await?;
    let mut sources = std::collections::HashSet::new();
    for value in &values {
        for (source, _) in super::knowledge_sources::requirements(value)? {
            sources.insert(source);
        }
    }
    let versions =
        super::knowledge_sources::versions_in_tx(tx, ctx, &sources.into_iter().collect::<Vec<_>>())
            .await?;
    let by_id = values
        .into_iter()
        .map(|v| (v["id"].as_str().unwrap_or("").to_owned(), v))
        .collect::<std::collections::HashMap<_, _>>();
    for candidate in all {
        let id = candidate["id"]
            .as_str()
            .ok_or(Error::new("invalid_input"))?;
        if seen.contains(id) {
            continue;
        }
        let Some(object) = by_id.get(id) else {
            continue;
        };
        if super::knowledge_sources::requirements(object)?
            .iter()
            .all(|(id, version)| versions.get(id) == Some(version))
            && candidate["version"]
                .as_str()
                .is_none_or(|version| object["version"] == version)
        {
            seen.insert(id.to_owned());
            candidates.push(object.clone());
        }
    }
    let mut objects = retrieval::rank_hybrid(candidates, query, limit, &vector.values);
    if limit >= 4 {
        let links = objects
            .iter()
            .take(3)
            .flat_map(|o| {
                o["related_ids"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|v| v.as_str().map(str::to_owned))
            })
            .take(8)
            .collect::<Vec<_>>();
        let mut additions = Vec::new();
        for linked in links {
            if objects.iter().any(|v| v["id"] == linked)
                || additions.iter().any(|v: &Value| v["id"] == linked)
            {
                continue;
            }
            if let Ok(object) = knowledge::read_in_tx(tx, ctx, &linked, None, false).await
                && assert_source_in_tx(tx, ctx, &object).await.is_ok()
            {
                additions.push(object);
            }
            if additions.len() == 2 {
                break;
            }
        }
        objects.truncate(limit.saturating_sub(additions.len()));
        objects.extend(additions);
    }
    let index_state = if vector.state == "unconfigured" {
        "unconfigured"
    } else {
        knowledge::index_coverage_in_tx(tx, ctx, vector.target.as_deref().unwrap_or("unavailable"))
            .await?
    };
    Ok(KnowledgeSearch {
        objects,
        coverage: json!({"state":if limited{"candidate_limit"}else if vector.bounded||index_state=="incomplete"{"bounded"}else{"complete"},"candidate_limit":2200,"vector_state":vector.state,"index_state":index_state}),
    })
}

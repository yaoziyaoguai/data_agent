use crate::{
    contracts,
    modules::{access, ingestion, knowledge, retrieval},
    persistence::AppTx,
    search_scope::KnowledgeSearchScope,
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
    sync_catalog(pool, &ctx).await?;
    let mut tx = AppTx::begin(pool).await?;
    for object in knowledge::list_in_tx(&mut tx, &ctx, false).await? {
        super::semantic_governance::register_object_in_tx(&mut tx, &ctx, &object).await?;
    }
    tx.commit().await
}
pub async fn list(pool: &MySqlPool, ctx: &AccessContext, input: &Value) -> Result<Value> {
    contracts::validate("KnowledgeListQuery", input)?;
    let query = input["q"].as_str();
    let after = input["after_id"].as_str();
    let related = input["related_id"].as_str();
    let directory = input["directory"].as_str();
    let state = input["state"].as_str();
    let vector = if let Some(query) = query.filter(|_| directory.is_none()) {
        super::knowledge_embeddings::search(pool, ctx, query, None).await
    } else {
        retrieval::vector::Candidates::lexical()
    };
    let mut tx = AppTx::begin(pool).await?;
    if let Some(object) = related {
        knowledge::read_in_tx(&mut tx, ctx, object, None, true).await?;
    }
    let (values, next, coverage) = if let Some(directory) = directory {
        let ids = if directory == "maintained" {
            Some(access::maintainable_ids_in_tx(&mut tx, ctx).await?)
        } else {
            None
        };
        let (values, next) = knowledge::directory_page_in_tx(
            &mut tx,
            ctx,
            after,
            query,
            state,
            ids.as_deref(),
            input["directory_view"] == "grouped",
        )
        .await?;
        (values, next, None)
    } else if let Some(query) = query {
        let result = retrieve_in_tx(&mut tx, ctx, query, 30, &vector).await?;
        (result.objects, None, Some(result.coverage))
    } else {
        let (values, next) = knowledge::page_in_tx(&mut tx, ctx, after, related).await?;
        (values, next, None)
    };
    let mut values = values;
    for value in &mut values {
        // 工具采用元信息由检索工具保留；维护HTTP沿用正式对象契约。
        if let Some(object) = value.as_object_mut() {
            object.remove("structure_dependencies");
            object.remove("structure_coverage");
        }
        for entry in value["entries"].as_array_mut().into_iter().flatten() {
            if let Some(entry) = entry.as_object_mut() {
                entry.remove("structure_gap");
            }
        }
        value["maintenance"] =
            access::maintenance_snapshot_in_tx(&mut tx, ctx, value["id"].as_str().unwrap_or(""))
                .await?;
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
    v["maintenance"] = access::maintenance_snapshot_in_tx(&mut tx, ctx, object).await?;
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
    let mut tx = AppTx::begin(pool).await?;
    if action == "create" {
        contracts::validate("KnowledgeCreate", &input)?;
        if input["kind"] == "table" || input["kind"] == "field" {
            access::authorize_maintainer(ctx)?;
        } else if !access::can_create_in_tx(&mut tx, ctx).await? {
            return Err(Error::new("forbidden"));
        }
    } else {
        let target = if action == "apply-proposal" {
            knowledge::proposal_in_tx(&mut tx, ctx, object.ok_or(Error::new("invalid_input"))?)
                .await?["object_id"]
                .as_str()
                .unwrap_or("")
                .to_owned()
        } else {
            object.ok_or(Error::new("invalid_input"))?.to_owned()
        };
        access::authorize_semantic_in_tx(&mut tx, ctx, &target).await?;
    }
    let mut v = match action {
        "create" => {
            let v =
                if let Some(receipt) = knowledge::begin_create_in_tx(&mut tx, ctx, &input).await? {
                    receipt
                } else {
                    check_input_structure_sources_in_tx(&mut tx, ctx, &input).await?;
                    knowledge::create_in_tx(&mut tx, ctx, &input).await?
                };
            if v["kind"] == "table" || v["kind"] == "field" {
                super::semantic_governance::register_object_in_tx(&mut tx, ctx, &v).await?;
            } else {
                access::register_creator_in_tx(&mut tx, ctx, v["id"].as_str().unwrap_or(""))
                    .await?;
            }
            v
        }
        "edit" => {
            contracts::validate("KnowledgeEdit", &input)?;
            let object = object.ok_or(Error::new("invalid_input"))?;
            if let Some(receipt) = knowledge::begin_edit_in_tx(&mut tx, ctx, object, &input).await?
            {
                receipt
            } else {
                if input["clear_override"] != true {
                    check_input_structure_sources_in_tx(&mut tx, ctx, &input).await?;
                }
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
            if let Some(mut receipt) =
                knowledge::begin_reanalysis_in_tx(&mut tx, ctx, object, &input).await?
            {
                super::semantic_governance::decorate_in_tx(&mut tx, ctx, &mut receipt).await?;
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
    super::semantic_governance::decorate_in_tx(&mut tx, ctx, &mut v).await?;
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
    contracts::validate("AnalysisPreferenceCommand", &input)?;
    let mut tx = AppTx::begin(pool).await?;
    access::authorize_semantic_in_tx(&mut tx, ctx, table).await?;
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
    sync_catalog(pool, ctx).await?;
    super::catalog_import::sync(pool, ctx, key).await
}

async fn sync_catalog(pool: &MySqlPool, ctx: &AccessContext) -> Result<()> {
    // 空授权登记不授予维护权；单独提交，避免提前固定随后来源同步的旧快照。
    let mut registration = AppTx::begin(pool).await?;
    super::semantic_governance::register_catalog_in_tx(
        &mut registration,
        ctx,
        &ingestion::synthetic_catalog()?,
    )
    .await?;
    registration.commit().await?;
    let mut transaction = AppTx::begin(pool).await?;
    let tx = &mut transaction;
    let changed = ingestion::sync_sources_in_tx(tx, &ctx.space_id).await?;
    let catalog = current_catalog_in_tx(tx, ctx).await?;
    let objects = knowledge::list_in_tx(tx, ctx, false).await?;
    knowledge::seed_in_tx(tx, ctx, &catalog).await?;
    for object in &objects {
        if changed
            .iter()
            .any(|(source, _)| source == "semantic-catalog" || depends_on_source(object, source))
            && let Some(candidate) = catalog["objects"]
                .as_array()
                .and_then(|a| a.iter().find(|c| c["id"] == object["id"]))
        {
            let latest =
                knowledge::read_in_tx(tx, ctx, object["id"].as_str().unwrap_or(""), None, true)
                    .await?;
            let root_version = epoch(candidate["source_version"].as_str().unwrap_or("0"))?;
            let operation = crate::types::fingerprint(&json!(["sync", object["id"], changed]));
            let updated = knowledge::reanalyze_in_tx(
                tx,
                ctx,
                object["id"].as_str().unwrap_or(""),
                &json!({"operation_id":operation,"expected_version":latest["version"]}),
                root_version,
                candidate,
            )
            .await?;
            let sources = sources_in_tx(tx, ctx).await?;
            super::prefill_materials::queue_in_tx(tx, ctx, &updated, sources).await?;
        }
    }
    transaction.commit().await
}
pub async fn valid_assets_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    items: Vec<Value>,
    cid: &str,
    checked: &super::context_authority::CheckedTextResults,
) -> Result<Vec<Value>> {
    let mut valid = Vec::new();
    for item in items {
        match super::personal_assets::text_authority_in_tx(tx, ctx, cid, &item, checked).await {
            Ok(_) => valid.push(item),
            Err(error) if super::personal_assets::unavailable_text(&error) => (),
            Err(error) => return Err(error),
        }
    }
    Ok(valid)
}
pub async fn read_asset(pool: &MySqlPool, ctx: &AccessContext, asset: &str) -> Result<Value> {
    super::personal_assets::read(pool, ctx, asset).await
}
pub async fn source_head(pool: &MySqlPool, ctx: &AccessContext, source: &str) -> Result<Value> {
    let mut tx = AppTx::begin(pool).await?;
    let v = super::knowledge_sources::read_in_tx(&mut tx, ctx, source, None).await?;
    tx.commit().await?;
    Ok(v)
}

pub async fn check_refs_in_tx(tx: &mut AppTx<'_>, ctx: &AccessContext, refs: &Value) -> Result<()> {
    checked_refs_in_tx(tx, ctx, refs).await.map(|_| ())
}

// 交付案例时保留实际核验过的传递依赖，后续上下文只校验这些明确引用。
async fn checked_refs_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    refs: &Value,
) -> Result<Vec<Value>> {
    let mut pending = refs.as_array().ok_or(Error::new("invalid_input"))?.clone();
    let mut checked = std::collections::HashSet::new();
    let mut references = Vec::new();
    let mut index = 0;
    while index < pending.len() {
        if pending.len() > 150 {
            return Err(Error::new("invalid_input"));
        }
        let r = pending[index].clone();
        index += 1;
        let key = crate::types::fingerprint(&r);
        if !checked.insert(key) {
            continue;
        }
        knowledge::check_refs_in_tx(tx, ctx, &json!([r.clone()])).await?;
        let v = knowledge::read_in_tx(tx, ctx, r["object_id"].as_str().unwrap_or(""), None, false)
            .await?;
        assert_source_in_tx(tx, ctx, &v).await?;
        pending.extend(knowledge::structure_dependencies(&v));
        references.push(r);
    }
    Ok(references)
}

async fn check_input_structure_sources_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    input: &Value,
) -> Result<()> {
    let object = json!({"entries":[{"effective_structure":input["structured_value"]}]});
    let dependencies = knowledge::structure_dependencies(&object);
    check_refs_in_tx(tx, ctx, &json!(dependencies)).await
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
    let version = ingestion::source_version_in_tx(tx, &ctx.space_id, "semantic-catalog").await?;
    let snapshot = ingestion::read_source_in_tx(tx, ctx, "semantic-catalog", version).await?;
    let catalog: Value = serde_json::from_str(snapshot["body"].as_str().unwrap_or(""))
        .map_err(|_| Error::new("invalid_input"))?;
    let mut ids = std::collections::BTreeSet::from(["schema", "etl", "business-guide"]);
    for source in catalog["source_bundle"].as_array().into_iter().flatten() {
        ids.insert(source["id"].as_str().ok_or(Error::new("invalid_input"))?);
    }
    for name in ids {
        let version = ingestion::source_version_in_tx(tx, &ctx.space_id, name).await?;
        sources.push(ingestion::read_source_in_tx(tx, ctx, name, version).await?);
    }
    Ok(sources)
}
async fn current_catalog_in_tx(tx: &mut AppTx<'_>, ctx: &AccessContext) -> Result<Value> {
    // 使用本次已落库的目录快照，避免同步中再次读取磁盘换成另一版候选。
    let catalog_version =
        ingestion::source_version_in_tx(tx, &ctx.space_id, "semantic-catalog").await?;
    let snapshot =
        ingestion::read_source_in_tx(tx, ctx, "semantic-catalog", catalog_version).await?;
    let mut catalog: Value = serde_json::from_str(snapshot["body"].as_str().unwrap_or(""))
        .map_err(|_| Error::new("invalid_input"))?;
    if catalog["synthetic"] != true {
        return Err(Error::new("invalid_input"));
    }
    let sources = sources_in_tx(tx, ctx).await?;
    // 沿同一已落库快照建立别名集合；逐文档重读磁盘会混版并重复解析整份目录。
    let table_aliases = catalog["objects"]
        .as_array()
        .ok_or(Error::new("invalid_input"))?
        .iter()
        .filter(|object| object["kind"] == "table")
        .filter_map(|object| object["id"].as_str().map(str::to_owned))
        .collect();
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
        ingestion::catalog::link_synthetic_documents(&ctx.space_id, object, &table_aliases);
    }
    Ok(catalog)
}

pub(super) async fn semantic_object_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    mut object: Value,
) -> Result<Value> {
    if object["kind"] == "query_example" {
        let dependencies = knowledge::structure_dependencies(&object);
        if dependencies.is_empty() {
            object["structure_dependencies"] = json!([]);
            object["structure_coverage"] = json!({"state":"missing_semantics","notes":["查询案例尚无有效结构与依赖，仅可读取说明，须重新核对后采用。"]});
            return Ok(object);
        }
        match checked_refs_in_tx(tx, ctx, &json!(dependencies)).await {
            Ok(checked_dependencies) => {
                object["structure_dependencies"] = json!(checked_dependencies);
                object["structure_coverage"] = json!({"state":"complete","notes":[]});
            }
            Err(error) if matches!(error.code, "stale_knowledge" | "not_available") => {
                for entry in object["entries"].as_array_mut().into_iter().flatten() {
                    entry["effective_structure"] = Value::Null;
                    entry["structure_gap"] =
                        json!("查询案例的依赖已变化或不可用，须由负责人重新核对。");
                }
                object["structure_dependencies"] = json!([]);
                object["structure_coverage"] = json!({"state":"missing_semantics","notes":["查询案例的依赖已变化或不可用，当前案例不能采用。"]});
            }
            Err(error) => return Err(error),
        }
        return Ok(object);
    }
    if !object["entries"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|entry| !entry["effective_structure"].is_null())
    {
        return Ok(object);
    }
    let path = object["entries"]
        .as_array()
        .and_then(|entries| entries.first())
        .and_then(|entry| entry["path"].as_str())
        .unwrap_or("");
    let snapshot = knowledge::semantic_snapshot_in_tx(
        tx,
        ctx,
        &json!([{
            "object_id":object["id"],"version":object["version"],"path":path
        }]),
    )
    .await?;
    let checked = snapshot["objects"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|value| value["id"] == object["id"]);
    let mut valid_tables = std::collections::HashSet::new();
    for table in snapshot["objects"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|value| value["kind"] == "table")
    {
        match assert_source_in_tx(tx, ctx, table).await {
            Ok(()) => {
                valid_tables.insert((table["id"].clone(), table["version"].clone()));
            }
            Err(error) if matches!(error.code, "stale_knowledge" | "not_available") => (),
            Err(error) => return Err(error),
        }
    }
    for entry in object["entries"].as_array_mut().into_iter().flatten() {
        let had_structure = !entry["effective_structure"].is_null();
        entry["effective_structure"] = checked
            .and_then(|value| value["entries"].as_array())
            .and_then(|entries| {
                entries
                    .iter()
                    .find(|candidate| candidate["entry_id"] == entry["entry_id"])
            })
            .map(|candidate| candidate["effective_structure"].clone())
            .unwrap_or(Value::Null);
        if had_structure && entry["effective_structure"].is_null() {
            entry["structure_gap"] = json!("部分计算规则缺少当前有效绑定，须核对后采用。");
        }
        let wrapper = json!({"entries":[entry.clone()]});
        if knowledge::structure_dependencies(&wrapper)
            .iter()
            .any(|reference| {
                !valid_tables
                    .contains(&(reference["object_id"].clone(), reference["version"].clone()))
            })
        {
            entry["effective_structure"] = Value::Null;
            entry["structure_gap"] = json!("引用的表资料已变化，须重新核对计算规则。");
        }
    }
    object["structure_dependencies"] = json!(knowledge::structure_dependencies(&object));
    object["structure_coverage"] = snapshot["coverage"].clone();
    Ok(object)
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
    retrieve_scoped_in_tx(
        tx,
        ctx,
        query,
        limit,
        vector,
        &KnowledgeSearchScope::default(),
    )
    .await
}

pub async fn retrieve_scoped_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    query: &str,
    limit: usize,
    vector: &retrieval::vector::Candidates,
    scope: &KnowledgeSearchScope,
) -> Result<KnowledgeSearch> {
    if let Some(anchor) = &scope.anchor {
        let object = knowledge::read_in_tx(tx, ctx, anchor, None, false).await?;
        assert_source_in_tx(tx, ctx, &object).await?;
    }
    let terms = retrieval::candidate_terms(query);
    let indexed =
        retrieval::candidates_scoped_in_tx(tx, &ctx.space_id, &terms.values, scope).await?;
    let current = knowledge::matching_scoped_in_tx(tx, ctx, query, &terms.values, scope).await?;
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
            let object = semantic_object_in_tx(tx, ctx, object.clone()).await?;
            if scope.matches(&object) {
                seen.insert(id.to_owned());
                candidates.push(object);
            }
        }
    }
    let mut objects = retrieval::rank_hybrid(candidates, query, limit, &vector.values);
    if limit >= 4 {
        // 关联仅使用前三之外的余位；直接命中不足三项时仍可补足原有两个关联。
        let addition_limit = 2.min(limit.saturating_sub(objects.len().min(3)));
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
                let object = semantic_object_in_tx(tx, ctx, object).await?;
                if scope.matches(&object) {
                    additions.push(object);
                }
            }
            if additions.len() == addition_limit {
                break;
            }
        }
        objects.truncate(limit.saturating_sub(additions.len()));
        objects.extend(additions);
    }
    let vector_matches: std::collections::HashMap<_, _> = vector
        .values
        .iter()
        .map(|hit| ((hit["id"].clone(), hit["version"].clone()), hit))
        .collect();
    for object in &mut objects {
        if let Some(candidate) =
            vector_matches.get(&(object["id"].clone(), object["version"].clone()))
        {
            retrieval::attach_matches(&ctx.space_id, object, candidate);
        }
        retrieval::attach_lexical_matches(object, query);
    }
    let index_state = if vector.state == "unconfigured" {
        "unconfigured"
    } else {
        knowledge::index_coverage_in_tx(tx, ctx, vector.target.as_deref().unwrap_or("unavailable"))
            .await?
    };
    Ok(KnowledgeSearch {
        objects,
        coverage: json!({"state":if limited{"candidate_limit"}else if !terms.complete||vector.bounded||index_state=="incomplete"{"bounded"}else{"complete"},"candidate_limit":2200,"query_terms_complete":terms.complete,"vector_state":vector.state,"index_state":index_state,"scope_applied":!scope.kinds.is_empty()||scope.anchor.is_some()||scope.domain.is_some()}),
    })
}

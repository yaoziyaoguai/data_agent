use crate::{
    contracts,
    contracts::generated::{SourceKey, SourceKeyKind},
    modules::{access, ingestion, jobs, knowledge, retrieval, retrieval::source_segments},
    persistence::AppTx,
    search_scope::KnowledgeSearchScope,
    types::{AccessContext, Error, Result, epoch, fingerprint, id},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use sqlx::MySqlPool;
pub async fn initialize(pool: &MySqlPool) -> Result<()> {
    let ctx = AccessContext {
        user_id: "synthetic-import".into(),
        space_id: "demo".into(),
        request_id: id(),
    };
    let mut tx = AppTx::begin(pool).await?;
    let initialized =
        ingestion::source_head_version_in_tx(&mut tx, &ctx.space_id, "semantic-catalog")
            .await?
            .is_some();
    tx.commit().await?;
    // 首次启动建样例；已有资料的更新只经手动同步，重启不替用户导入新版本。
    if !initialized {
        sync_catalog(pool, &ctx).await?;
    }
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
    // 浏览检索（05切片4）：与工具路径共用组合推进——词法就绪即期限内预读，慢嵌入
    // 不饿死词法路；返回的objects/coverage已含预读复用后的最终装配。
    let searched = if let Some(query) = query.filter(|_| directory.is_none()) {
        Some(super::knowledge_embeddings::search(pool, ctx, query, None).await?)
    } else {
        None
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
    } else if let Some(ref result) = searched {
        (result.objects.clone(), None, Some(result.coverage.clone()))
    } else {
        let (values, next) = knowledge::page_in_tx(&mut tx, ctx, after, related).await?;
        (values, next, None)
    };
    let mut values = values;
    for value in &mut values {
        // 工具采用元信息由检索工具保留；维护HTTP沿用正式对象契约。05切片2起
        // 检索命中对象为窄读装配，条目级瞬态键（窄读定位/必要来源）不进HTTP契约。
        if let Some(object) = value.as_object_mut() {
            object.remove("structure_dependencies");
            object.remove("structure_coverage");
            object.remove("entries_total");
            object.remove("required_sources");
            object.remove("statement_dependencies");
        }
        for entry in value["entries"].as_array_mut().into_iter().flatten() {
            if let Some(entry) = entry.as_object_mut() {
                entry.remove("structure_gap");
                entry.remove("content_page");
                entry.remove("statement_content");
                entry.remove("statement_dependencies");
            }
        }
        value["maintenance"] =
            access::maintenance_snapshot_in_tx(&mut tx, ctx, value["id"].as_str().unwrap_or(""))
                .await?;
        value["prefill_status"] =
            ingestion::prefill_status_in_tx(&mut tx, ctx, value["id"].as_str().unwrap_or(""))
                .await?;
        value["preparation_status"] = preparation_status_in_tx(&mut tx, ctx, value).await?;
        if let Some(preference) =
            ingestion::read_analysis_preference_in_tx(&mut tx, ctx, value).await?
        {
            value["analysis_preference"] = preference;
        }
    }
    tx.commit().await?;
    Ok(
        json!({"objects":values,"next_after_id":next,"search_coverage":coverage,"retrieval_mode":if searched.as_ref().is_some_and(|result| result.coverage["vector_state"]=="available"){"hybrid_authoritative"}else{"lexical_authoritative"}}),
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
        v["preparation_status"] = preparation_status_in_tx(&mut tx, ctx, &v).await?;
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

// 整理状态组合：先查对象来源的准备记录，尚无记录（刚排队）再查最近的prepare_source
// 作业状态；错误码只随实际准备进度出现，排队作业没有整理错误，两者皆无为null。
async fn preparation_status_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &Value,
) -> Result<Value> {
    let record = ingestion::preparation_record_status_in_tx(tx, ctx, object).await?;
    if !record.is_null() {
        return Ok(record);
    }
    let Some((source, revision)) = ingestion::preparation_source_of(object) else {
        return Ok(Value::Null);
    };
    Ok(
        jobs::latest_source_job_state_in_tx(tx, "prepare_source", &source, revision)
            .await?
            .map(|state| {
                json!({"source_id":source,"revision":revision.to_string(),"state":state,"error_code":null})
            })
            .unwrap_or(Value::Null),
    )
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
                    if let Some(statements) = input["statements"].as_array() {
                        let mut references = Vec::new();
                        let mut citations = Vec::new();
                        for statement in statements {
                            citations.extend(
                                statement["citations"]
                                    .as_array()
                                    .into_iter()
                                    .flatten()
                                    .cloned(),
                            );
                            for support in statement["supports"].as_array().into_iter().flatten() {
                                if support["reference"]["kind"] == "knowledge" {
                                    references.push(support["reference"]["ref"].clone());
                                } else {
                                    citations.push(support["reference"]["citation"].clone());
                                }
                            }
                        }
                        check_refs_in_tx(&mut tx, ctx, &json!(references)).await?;
                        let mut checked = std::collections::HashSet::new();
                        for citation in citations {
                            if checked.insert(crate::types::fingerprint(&citation)) {
                                let citation = serde_json::from_value(citation)
                                    .map_err(|_| Error::new("invalid_input"))?;
                                super::knowledge_sources::read_citation_in_tx(
                                    &mut tx, ctx, citation,
                                )
                                .await?;
                            }
                        }
                    }
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
    // 模块内保存不含跨模块登记：这里补依赖目标指纹并排队来源扇出（幂等，重放不破坏）。
    super::dependency_registration::after_content_saved_in_tx(&mut tx, ctx, &[v.clone()]).await?;
    // 保存文档原文（创建或改版）即原子登记raw索引与语义准备；两作业互不等待。
    super::knowledge_documents::register_document_preparation_in_tx(&mut tx, &ctx.space_id, &v)
        .await?;
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

pub async fn source_excerpt(
    pool: &MySqlPool,
    ctx: &AccessContext,
    citation: Value,
) -> Result<Value> {
    let citation = contracts::decode("SourceCitation", citation)?;
    let mut tx = AppTx::begin(pool).await?;
    let excerpt = super::knowledge_sources::read_citation_in_tx(&mut tx, ctx, citation).await?;
    tx.commit().await?;
    Ok(json!(excerpt))
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
    super::catalog_import::sync(pool, ctx, key).await
}

pub(crate) async fn sync_catalog(pool: &MySqlPool, ctx: &AccessContext) -> Result<()> {
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
    let changes = ingestion::sync_sources_in_tx(tx, ctx).await?;
    let changed = &changes.changed;
    let mut changed_catalog_objects = std::collections::HashSet::new();
    if changed
        .iter()
        .any(|(source, _)| source == "semantic-catalog")
    {
        let previous: Option<Value> = changes
            .previous_catalog
            .as_deref()
            .map(serde_json::from_str)
            .transpose()
            .map_err(|_| Error::new("invalid_input"))?;
        let current: Value =
            serde_json::from_str(&changes.catalog).map_err(|_| Error::new("invalid_input"))?;
        let previous_objects: std::collections::HashMap<_, _> = previous
            .as_ref()
            .and_then(|catalog| catalog["objects"].as_array())
            .into_iter()
            .flatten()
            .filter_map(|object| object["id"].as_str().map(|id| (id, object)))
            .collect();
        for object in current["objects"]
            .as_array()
            .ok_or(Error::new("invalid_input"))?
        {
            let id = object["id"].as_str().ok_or(Error::new("invalid_input"))?;
            if previous_objects.get(id).copied() != Some(object) {
                changed_catalog_objects.insert(id.to_owned());
            }
        }
    }
    let catalog = current_catalog_in_tx(tx, ctx).await?;
    let objects = knowledge::list_in_tx(tx, ctx, false).await?;
    let seeded = knowledge::seed_in_tx(tx, ctx, &catalog).await?;
    super::dependency_registration::after_content_saved_in_tx(tx, ctx, &seeded).await?;
    for object in &objects {
        if (changed_catalog_objects.contains(object["id"].as_str().unwrap_or(""))
            || changed.iter().any(|(source, _)| {
                source != "semantic-catalog" && depends_on_source(object, source)
            }))
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
            super::dependency_registration::after_content_saved_in_tx(
                tx,
                ctx,
                std::slice::from_ref(&updated),
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
    checked_refs_in_tx(tx, ctx, refs, None).await.map(|_| ())
}

pub(super) async fn check_refs_for_task_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    refs: &Value,
    gate: Option<&super::source_limits::SourceGate>,
) -> Result<()> {
    checked_refs_in_tx(tx, ctx, refs, gate).await.map(|_| ())
}

async fn current_structure_refs_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &Value,
) -> Result<Vec<Value>> {
    let mut bindings = knowledge::read_current_bindings_in_tx(tx, ctx, object).await?;
    for binding in &mut bindings {
        if !binding.fingerprint.is_empty() {
            continue;
        }
        let fact = binding
            .original_source
            .as_ref()
            .ok_or(Error::new("stale_knowledge"))?;
        let source = super::knowledge_sources::read_in_tx(
            tx,
            ctx,
            fact["source_id"]
                .as_str()
                .ok_or(Error::new("stale_knowledge"))?,
            Some(epoch(fact["version"].as_str().unwrap_or(""))?),
        )
        .await?;
        knowledge::prove_original_binding(binding, &source)?;
    }
    knowledge::validate_current_bindings_in_tx(tx, ctx, object, &bindings).await
}

// 历史分析核当前可访问身份与保存时来源关系，不需要旧资料全文。
// 普通修订不会撤销已保存分析；停用、删除或来源撤回仍拒绝。
pub async fn history_check_refs_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    refs: &Value,
) -> Result<()> {
    let mut roots = Vec::new();
    for reference in refs.as_array().ok_or(Error::new("invalid_input"))? {
        let id = reference["object_id"]
            .as_str()
            .ok_or(Error::new("invalid_input"))?;
        let version = crate::types::epoch(
            reference["version"]
                .as_str()
                .ok_or(Error::new("invalid_input"))?,
        )?;
        if knowledge::enabled_head_in_tx(tx, id)
            .await?
            .is_none_or(|(space, _)| space != ctx.space_id)
        {
            return Err(Error::new("not_available"));
        }
        let selection = knowledge::dependency_index::DependencySelection {
            object_id: id.to_owned(),
            version,
            path: reference["path"].as_str().unwrap_or("").to_owned(),
        };
        // 原修订无旧正文可解析时保守核整对象，不能把缺定位等同于来源撤回。
        roots.push(
            knowledge::dependency_index::resolve_selection_in_tx(tx, &selection)
                .await?
                .unwrap_or(knowledge::dependency_index::DependencySelection {
                    path: String::new(),
                    ..selection
                }),
        );
    }
    for root in knowledge::dependency_index::selected_contribution_roots_in_tx(tx, &roots).await? {
        if !root.unknown.is_empty() {
            // legacy回退（Fix N）：无索引行的存档按正文递归核验，与游走路径同
            // 口径——版本漂移容忍，撤下/删除/无头行拒绝。
            if !legacy_history_available_in_tx(tx, ctx, &root.unknown).await? {
                return Err(Error::new("not_available"));
            }
        }
        for (kind, id) in root.sources {
            if kind == "document" {
                if knowledge::enabled_head_in_tx(tx, &id)
                    .await?
                    .is_none_or(|(space, _)| space != ctx.space_id)
                {
                    return Err(Error::new("not_available"));
                }
            } else if !crate::modules::ingestion::source_versions_in_tx(
                tx,
                &ctx.space_id,
                std::slice::from_ref(&id),
            )
            .await?
            .contains_key(&id)
            {
                return Err(Error::new("not_available"));
            }
        }
    }
    Ok(())
}

// legacy历史回退：无依赖索引行的存档成员按其登记修订的存档正文分治核验——
// 文档目标核当前enabled头存在，平台目标核source头行，知识目标核当前enabled
// 存在后将其登记修订入队继续核验。visited上限150防环与失控链；重访视为已核。
// 只核存在与启停（版本漂移容忍），撤下（停用/删除/无头行）拒绝。
async fn legacy_history_available_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    members: &[(String, u64)],
) -> Result<bool> {
    let mut visited = std::collections::HashSet::new();
    let mut queue = std::collections::VecDeque::from(members.to_vec());
    while let Some((object, version)) = queue.pop_front() {
        if visited.len() >= 150 {
            return Ok(false);
        }
        if !visited.insert((object.clone(), version)) {
            continue;
        }
        let Some(body) = knowledge::archived_body_in_tx(tx, ctx, &object, version).await? else {
            return Ok(false);
        };
        let indexed = knowledge::dependency_index::rows_for_object(&body)?;
        for row in indexed.rows.iter().filter(|row| row.effective) {
            match row.target_kind.as_str() {
                "knowledge" => {
                    if knowledge::enabled_head_in_tx(tx, &row.target_id)
                        .await?
                        .is_none_or(|(space, _)| space != ctx.space_id)
                    {
                        return Ok(false);
                    }
                    queue.push_back((row.target_id.clone(), row.target_revision));
                }
                "document" => {
                    if knowledge::enabled_head_in_tx(tx, &row.target_id)
                        .await?
                        .is_none_or(|(space, _)| space != ctx.space_id)
                    {
                        return Ok(false);
                    }
                }
                _ => {
                    if !crate::modules::ingestion::source_versions_in_tx(
                        tx,
                        &ctx.space_id,
                        std::slice::from_ref(&row.target_id),
                    )
                    .await?
                    .contains_key(&row.target_id)
                    {
                        return Ok(false);
                    }
                }
            }
        }
    }
    Ok(true)
}

// 只标出本次引用身份和失败用途，不在拒绝中返回受限正文或新的对象身份。
fn knowledge_reference_error(error: Error, reference: &Value, usage: &str) -> Error {
    if error.code != "stale_knowledge" {
        return error;
    }
    error.with_message(format!(
        "{usage}失效：{}@{}#{}。",
        reference["object_id"].as_str().unwrap_or(""),
        reference["version"].as_str().unwrap_or(""),
        reference["path"].as_str().unwrap_or("整对象")
    ))
}

// 交付案例时保留实际核验过的传递依赖，后续上下文只校验这些明确引用。
async fn checked_refs_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    refs: &Value,
    gate: Option<&super::source_limits::SourceGate>,
) -> Result<Vec<Value>> {
    let mut pending = refs.as_array().ok_or(Error::new("invalid_input"))?.clone();
    let mut checked = std::collections::HashSet::new();
    let mut references = Vec::new();
    let mut index = 0;
    while index < pending.len() {
        if pending.len() > 150 {
            return Err(Error::new("invalid_input"));
        }
        let mut r = pending[index].clone();
        index += 1;
        let v = knowledge::read_selected_structure_in_tx(
            tx,
            ctx,
            r["object_id"].as_str().unwrap_or(""),
            epoch(r["version"].as_str().unwrap_or(""))?,
            r["path"].as_str(),
        )
        .await
        .map_err(|error| knowledge_reference_error(error, &r, "知识正文版本"))?;
        let path = if r["path"].as_str().is_some_and(|p| !p.is_empty()) {
            let path = v["entries"][0]["path"]
                .as_str()
                .ok_or(Error::new("invalid_evidence"))?
                .to_owned();
            r["path"] = json!(path);
            path
        } else {
            String::new()
        };
        let key = crate::types::fingerprint(&r);
        if !checked.insert(key) {
            continue;
        }
        pending.extend(
            current_structure_refs_in_tx(tx, ctx, &v)
                .await
                .map_err(|error| knowledge_reference_error(error, &r, "结构绑定"))?,
        );
        super::knowledge_sources::assert_selected_in_tx(tx, ctx, &v, &path)
            .await
            .map_err(|error| knowledge_reference_error(error, &r, "所选条目必要依据"))?;
        if let Some(gate) = gate {
            gate.assert_selection_in_tx(tx, &v, &path).await?;
        }
        pending.extend(knowledge::semantic_dependencies(&v));
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

// 统一公共索引消费者：knowledge拥有的公共待办同时承载知识对象与原文来源目标。
// 领取事务内按目标类型分派owner读接口；分段、Embedding与向量写入在锁外，
// 每批回短事务核租约代次、原修订与实际集合身份后记录投影进度。
pub async fn process_index(pool: &MySqlPool) -> Result<bool> {
    let vector = retrieval::vector::enabled();
    // 嵌入配置缺失或不合法时待办不整体停摆：已冻结配置或有原账本回执的目标
    // 继续恢复推进，无配置的新目标保持真实pending、不空耗次数（与整理消费
    // 者同口径）。集合不兼容或无向量服务时原文目标没有可写通道，同样不领取。
    let unconfigured = if vector {
        match super::knowledge_embeddings::maintenance_profile() {
            Ok(Some(_)) => false,
            Ok(None) => true,
            Err(error) if error.code == "invalid_input" => true,
            Err(error) => return Err(error),
        }
    } else {
        false
    };
    let ctx = AccessContext {
        user_id: "synthetic-index".into(),
        space_id: "demo".into(),
        request_id: id(),
    };
    let target = if vector {
        retrieval::vector::index_target().await?
    } else {
        retrieval::vector::target()
    };
    if vector {
        super::raw_index_handover::hand_over_due(pool, &ctx.space_id).await?;
    }
    let mut tx = AppTx::begin(pool).await?;
    let jobs =
        knowledge::claim_index_batch_in_tx(&mut tx, &ctx, vector, Some(&target), unconfigured)
            .await?;
    // 一次只领取即将处理的一类工作；长原文不能占用尚未开始的知识批次租约。
    let source_job = if vector && jobs.is_empty() {
        // 空知识轮询已建立一致性快照；原文锁定领取可见其后提交的新作业，
        // 须先结束旧事务，避免来源普通读仍用旧快照将合法新原文误退役。
        tx.commit().await?;
        tx = AppTx::begin(pool).await?;
        let eligible = if unconfigured {
            Some(super::knowledge_embeddings::recoverable_source_heads_in_tx(&mut tx, &ctx).await?)
        } else {
            None
        };
        knowledge::claim_source_index_in_tx(
            &mut tx,
            &ctx.space_id,
            true,
            Some(&target),
            eligible.as_deref(),
        )
        .await?
    } else {
        None
    };
    // 原文目标在领取事务内核头来修订并读正文；来源缺失或已有更新修订时不花
    // 嵌入预算，按superseded收尾，清旧由更新修订的作业负责。分页未完成的
    // 正文按明确unknown退回，不在半途正文上建立索引。
    let mut indexed_source: Option<(Value, SourceKey, String)> = None;
    if let Some(job) = &source_job {
        let key = SourceKey {
            kind: if job["source_kind"] == "document" {
                SourceKeyKind::Document
            } else {
                SourceKeyKind::Platform
            },
            id: job["object_id"].as_str().unwrap_or("").to_owned(),
        };
        let alias = source_alias(&key);
        let revision = epoch(job["job_version"].as_str().unwrap_or("0"))?;
        let head = super::knowledge_sources::resolve_source_head_in_tx(&mut tx, &alias).await?;
        let outcome = match head {
            Some((space, current)) if current <= revision => {
                super::knowledge_sources::read_in_tx(
                    &mut tx,
                    &AccessContext {
                        user_id: "synthetic-raw-index".into(),
                        space_id: space,
                        request_id: job["lease_epoch"].as_str().unwrap_or("").to_owned(),
                    },
                    &alias,
                    Some(revision),
                )
                .await
            }
            _ => Ok(json!({"version": Value::Null, "complete": false})),
        };
        match outcome {
            Ok(value)
                if value["version"].as_str() == Some(job["job_version"].as_str().unwrap_or(""))
                    && value["complete"] == true =>
            {
                indexed_source = Some((
                    job.clone(),
                    key,
                    value["body"].as_str().unwrap_or("").to_owned(),
                ));
            }
            Ok(value) if value["complete"] == false && value["version"] != Value::Null => {
                knowledge::finish_index_in_tx(&mut tx, job, None, Some("source_incomplete"))
                    .await?;
            }
            Ok(_) => {
                knowledge::finish_index_in_tx(
                    &mut tx,
                    job,
                    Some(&json!({"state":"superseded"})),
                    None,
                )
                .await?;
            }
            Err(error)
                if matches!(
                    error.code,
                    "not_available" | "stale_source" | "stale_knowledge"
                ) =>
            {
                knowledge::finish_index_in_tx(
                    &mut tx,
                    job,
                    Some(&json!({"state":"superseded"})),
                    None,
                )
                .await?;
            }
            Err(error) => return Err(error),
        }
    }
    let mut valid = Vec::new();
    for job in &jobs {
        retrieval::index_in_tx(&mut tx, &ctx.space_id, &job["object"]).await?;
        if job["object"]["state"] == "enabled" {
            match assert_source_in_tx(&mut tx, &ctx, &job["object"]).await {
                Ok(()) => {}
                Err(error)
                    if matches!(
                        error.code,
                        "not_available" | "stale_source" | "stale_knowledge"
                    ) =>
                {
                    continue;
                }
                Err(error) => return Err(error),
            }
        }
        valid.push(job["object"].clone());
    }
    tx.commit().await?;
    if jobs.is_empty() && indexed_source.is_none() && source_job.is_none() {
        return Ok(false);
    }
    let mut source_error: Option<String> = None;
    let mut source_superseded_midway = false;
    if let Some((job, key, body)) = &indexed_source {
        match index_source_target(pool, &ctx, &target, job, key, body).await {
            Ok(()) => {}
            Err(error) if error.code == "superseded" => source_superseded_midway = true,
            Err(error) => source_error = Some(error.code.to_owned()),
        }
    }
    // Embedding、Milvus及查证均在领取事务外；查询Worker独立运行。
    let applied = if vector && !valid.is_empty() {
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
                        // 后台索引嵌入不受检索期限约束（05接续）。
                        None,
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
            None if vector => (None, Some("stale_knowledge")),
            None => (None, None),
        };
        knowledge::finish_index_in_tx(&mut tx, job, receipt, error).await?;
    }
    if let Some((job, _, _)) = &indexed_source {
        let receipt = if source_superseded_midway {
            Some(&json!({"state":"superseded"}))
        } else if source_error.is_none() {
            Some(&json!({"state":"indexed","target":target}))
        } else {
            None
        };
        knowledge::finish_index_in_tx(&mut tx, job, receipt, source_error.as_deref()).await?;
    }
    tx.commit().await?;
    Ok(true)
}

// document来源以document-{id}别名调用owner读接口；嵌入操作身份沿该别名续用，
// 迁移后回执/预算不重发。SourceKey.kind/id仍是索引写入与清旧的完整身份。
pub(crate) fn source_alias(key: &SourceKey) -> String {
    match key.kind {
        SourceKeyKind::Document => format!("document-{}", key.id),
        SourceKeyKind::Platform => key.id.clone(),
    }
}

// 原文目标的锁外索引：确定性切块持续到结束，每批先短事务核租约与来源头修订，
// 写入后短事务记录投影进度，再继续下一批。当前修订完成后按SourceKey完整身份
// 清理更旧修订的摘录，晚到作业不能回退当前投影。
async fn index_source_target(
    pool: &MySqlPool,
    ctx: &AccessContext,
    target: &str,
    job: &Value,
    key: &SourceKey,
    body: &str,
) -> Result<()> {
    let revision = epoch(job["job_version"].as_str().unwrap_or("0"))?;
    let revision_text = job["job_version"].as_str().unwrap_or("0").to_owned();
    let alias = source_alias(key);
    let source = source_segments::SourceText {
        source: key,
        revision: &revision_text,
        text: body,
        format: if matches!(key.kind, SourceKeyKind::Document) {
            source_segments::SourceFormat::Markdown
        } else {
            source_segments::SourceFormat::Sql
        },
        background: &[],
    };
    let mut cursor: Option<source_segments::SegmentCursor> = None;
    let kind_label = || match key.kind {
        SourceKeyKind::Document => "document",
        SourceKeyKind::Platform => "platform",
    };
    loop {
        let batch = source_segments::segment_source(&source, cursor.as_ref())?;
        if batch.segments.is_empty() {
            break;
        }
        // 批前短事务：核代次与来源头修订。头已越过作业修订时按superseded收尾，
        // 不再花嵌入预算，清旧由更新修订的作业负责。
        {
            let mut tx = AppTx::begin(pool).await?;
            knowledge::renew_source_index_lease_in_tx(&mut tx, job).await?;
            let head = super::knowledge_sources::resolve_source_head_in_tx(&mut tx, &alias).await?;
            let stale = !matches!(head, Some((_, current)) if current <= revision);
            tx.commit().await?;
            if stale {
                return Err(Error::new("superseded"));
            }
        }
        let applied_position = batch
            .segments
            .last()
            .map(|segment| {
                segment.citation.locator.offset as u64 + segment.citation.locator.length as u64
            })
            .unwrap_or(0);
        retrieval::vector::apply_source_excerpts(&ctx.space_id, &batch.segments, |_, texts| {
            let ctx = ctx.clone();
            let alias = alias.clone();
            let job = job.clone();
            // 指纹随批次文本计算并由绑定持有：操作身份与具体文本一一对应，
            // 跳批/换序不会共用身份；共享嵌入缓存回放不重复计费。
            let fp = crate::types::fingerprint(&json!(&texts));
            async move {
                super::knowledge_embeddings::embed(
                    pool,
                    &ctx,
                    super::knowledge_embeddings::Binding::RawIndex(&job, &alias, revision, fp),
                    texts,
                    // 后台索引嵌入不受检索期限约束（05接续）。
                    None,
                )
                .await
            }
        })
        .await?;
        let projection = retrieval::SourceProjection {
            source_kind: kind_label().to_owned(),
            source_id: key.id.clone(),
            space_id: ctx.space_id.clone(),
            revision,
            collection_target: target.to_owned(),
            embedding_model: retrieval::embedding::SPEC.version.to_owned(),
            segmentation_version: source_segments::SEGMENTATION_VERSION_NUMBER,
            applied_position,
            complete: false,
        };
        let mut tx = AppTx::begin(pool).await?;
        knowledge::renew_source_index_lease_in_tx(&mut tx, job).await?;
        retrieval::record_source_projection_in_tx(&mut tx, &projection).await?;
        tx.commit().await?;
        match batch.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    // 当前修订已写入：按SourceKey完整身份删除更旧修订的摘录（平台与文档同ID
    // 不互删，document-调用别名不当裸object_id）。
    retrieval::vector::drop_source_excerpts(&ctx.space_id, kind_label(), &key.id, revision).await?;
    let mut tx = AppTx::begin(pool).await?;
    knowledge::renew_source_index_lease_in_tx(&mut tx, job).await?;
    retrieval::record_source_projection_in_tx(
        &mut tx,
        &retrieval::SourceProjection {
            source_kind: kind_label().to_owned(),
            source_id: key.id.clone(),
            space_id: ctx.space_id.clone(),
            revision,
            collection_target: target.to_owned(),
            embedding_model: retrieval::embedding::SPEC.version.to_owned(),
            segmentation_version: source_segments::SEGMENTATION_VERSION_NUMBER,
            applied_position: body.chars().count() as u64,
            complete: true,
        },
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

pub async fn rebuild_index(pool: &MySqlPool, ctx: &AccessContext, input: &Value) -> Result<Value> {
    access::authorize_maintainer(ctx)?;
    contracts::validate("CreateConversation", input)?;
    let operation = input["operation_id"].as_str().unwrap_or("");
    let mut recorded = AppTx::begin(pool).await?;
    let receipt = knowledge::index_rebuild_receipt_in_tx(&mut recorded, ctx, operation).await?;
    recorded.commit().await?;
    if let Some(receipt) = receipt {
        return Ok(receipt);
    }
    if !retrieval::vector::enabled() {
        return Err(Error::new("vector_unconfigured"));
    }
    let target = retrieval::vector::prepare_index_target().await?;
    let mut tx = AppTx::begin(pool).await?;
    let (receipt, created) =
        knowledge::rebuild_index_in_tx(&mut tx, ctx, &target, operation).await?;
    if created {
        super::raw_index_handover::rebuild_sources_in_tx(&mut tx, &ctx.space_id, &target).await?;
    }
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
    if object["kind"] != "query_example"
        && !object["entries"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|entry| !entry["effective_structure"].is_null())
    {
        return Ok(object);
    }
    let dependencies = match current_structure_refs_in_tx(tx, ctx, &object).await {
        Ok(mut references) => {
            references.extend(knowledge::semantic_dependencies(&object));
            Some(references)
        }
        Err(error)
            if matches!(
                error.code,
                "stale_knowledge" | "not_available" | "invalid_input" | "unsupported"
            ) =>
        {
            None
        }
        Err(error) => return Err(error),
    };
    let checked = if let Some(dependencies) = dependencies {
        if object["kind"] == "query_example" && dependencies.is_empty() {
            None
        } else {
            match checked_refs_in_tx(tx, ctx, &json!(dependencies), None).await {
                Ok(references) => Some(references),
                Err(error) if matches!(error.code, "stale_knowledge" | "not_available") => None,
                Err(error) => return Err(error),
            }
        }
    } else {
        None
    };
    if let Some(references) = checked {
        object["structure_dependencies"] = json!(references);
        object["structure_coverage"] = json!({"state":"complete","notes":[]});
    } else {
        for entry in object["entries"].as_array_mut().into_iter().flatten() {
            if !entry["effective_structure"].is_null() {
                entry["effective_structure"] = Value::Null;
                entry["structure_gap"] =
                    json!("计算规则的依赖已变化或不可用，须由负责人重新核对。");
            }
        }
        object["structure_dependencies"] = json!([]);
        object["structure_coverage"] = json!({"state":"missing_semantics","notes":["计算规则的依赖不完整或已变化，当前结构不能采用。"]});
    }
    Ok(object)
}

pub enum SearchHit {
    Knowledge {
        record: String,
        score: f64,
        content: Value,
    },
    SourceExcerpt {
        records: Vec<String>,
        score: f64,
        content: Value,
    },
}
impl SearchHit {
    /// 最终回执保留该 hit 时，必须一起确认其中所有原始规范成员。
    pub fn record_keys(&self) -> Vec<String> {
        match self {
            Self::Knowledge { record, .. } => vec![record.clone()],
            Self::SourceExcerpt { records, .. } => records.clone(),
        }
    }
}
pub struct KnowledgeSearch {
    pub objects: Vec<Value>,
    pub hits: Vec<SearchHit>,
    pub pending: Vec<Value>,
    pub coverage: Value,
    pub scan_progress: Value,
    pub continuation: Option<SearchContinuation>,
}
impl KnowledgeSearch {
    /// 仅在最终裁剪之后传入仍可见 hit 的 record_keys；整项裁掉不能确认其成员。
    pub fn snapshot(
        &self,
        delivered_records: &[String],
        max_bytes: usize,
    ) -> Result<Option<String>> {
        self.continuation.as_ref().map_or(Ok(None), |saved| {
            saved.snapshot(delivered_records, max_bytes)
        })
    }
}
const SEARCH_CURSOR_BYTES: usize = 65_536;

// 定位只投影白名单字段；名称、正文、filter、允许集和dense向量不进入快照。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct SavedLocation {
    #[serde(rename = "e")]
    entry_id: Option<String>,
    #[serde(rename = "p")]
    path: Option<String>,
    #[serde(rename = "s")]
    statement_id: Option<String>,
    #[serde(rename = "t")]
    statement_offset: Option<u64>,
    #[serde(rename = "o")]
    offset: Option<u64>,
    #[serde(rename = "l")]
    length: Option<u64>,
    #[serde(rename = "h")]
    content_hash: Option<String>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
enum SavedCandidate {
    #[serde(rename = "k")]
    Knowledge(String, String, String, Vec<SavedLocation>),
    #[serde(rename = "r")]
    Raw(String, String, u64, u64, u64, String),
}
impl SavedCandidate {
    fn capture(row: &Value, raw: bool) -> Result<Self> {
        let invalid = || Error::new("invalid_cursor");
        if raw {
            return Ok(Self::Raw(
                row["source_kind"]
                    .as_str()
                    .filter(|kind| matches!(*kind, "document" | "platform"))
                    .ok_or_else(invalid)?
                    .into(),
                row["source_id"].as_str().ok_or_else(invalid)?.into(),
                row["revision"].as_u64().ok_or_else(invalid)?,
                row["offset"].as_u64().ok_or_else(invalid)?,
                row["length"]
                    .as_u64()
                    .filter(|length| *length > 0 && *length <= 2400)
                    .ok_or_else(invalid)?,
                row["content_hash"].as_str().ok_or_else(invalid)?.into(),
            ));
        }
        let locations = row["matches"]
            .as_array()
            .ok_or_else(invalid)?
            .iter()
            .map(|location| {
                serde_json::from_value(json!({"e":location["entry_id"],"p":location["path"],
                "s":location["statement_id"],"t":location["statement_offset"],
                "o":location["offset"],"l":location["length"],"h":location["content_hash"]}))
                .map_err(|_| invalid())
            })
            .collect::<Result<Vec<SavedLocation>>>()?;
        if locations.is_empty() || locations.len() > 1000 {
            return Err(invalid());
        }
        Ok(Self::Knowledge(
            row["id"].as_str().ok_or_else(invalid)?.into(),
            row["version"].as_str().ok_or_else(invalid)?.into(),
            retrieval::knowledge_record(row).to_owned(),
            locations,
        ))
    }
    fn row(&self, score: f64) -> Value {
        match self {
            Self::Knowledge(id, version, record, locations) => {
                json!({"id":id,"version":version,"record_id":record,
                "matches":locations.iter().map(|location| json!({"fragment_id":record,"entry_id":location.entry_id,
                    "path":location.path,"statement_id":location.statement_id,"statement_offset":location.statement_offset,
                    "offset":location.offset,"length":location.length,"content_hash":location.content_hash,"score":score})).collect::<Vec<_>>()})
            }
            Self::Raw(kind, id, revision, offset, length, hash) => {
                json!({"source_kind":kind,"source_id":id,
                "revision":revision,"offset":offset,"length":length,"content_hash":hash,
                "segmentation_version":source_segments::SEGMENTATION_VERSION,"distance":score,"score":score})
            }
        }
    }
    fn key(&self) -> String {
        match self {
            Self::Knowledge(_, _, record, _) => format!("k:{record}"),
            Self::Raw(..) => format!(
                "raw:{}",
                retrieval::raw_record(&self.row(0.)).expect("saved raw identity")
            ),
        }
    }
}

/// 有界排序窗口与扫描位置。外层绑定查询/任务/权限；本值本身不能授权读取。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(try_from = "SearchContinuationWire", into = "SearchContinuationWire")]
pub struct SearchContinuation {
    #[serde(skip)]
    space: Option<String>,
    #[serde(rename = "v")]
    schema: u8,
    #[serde(rename = "s")]
    scan: retrieval::vector::ScanSnapshot,
    #[serde(rename = "r")]
    records: Vec<SavedCandidate>,
    // SQL两owner先合成一条有序词法输入，不另添RRF票。
    #[serde(rename = "c")]
    channels: [Vec<(usize, f64)>; 5],
    #[serde(rename = "q")]
    sql: [(usize, bool, bool); 2],
    #[serde(rename = "d")]
    retired: Vec<usize>,
    #[serde(rename = "a")]
    sql_active: bool,
}
// 仍由同一类型直接serde恢复；紧凑表示只去重定位常量并编码原摘要，不重扫窗口。
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchContinuationWire {
    v: u8,
    s: retrieval::vector::ScanSnapshot,
    #[serde(default)]
    r: Vec<SavedCandidate>,
    #[serde(default)]
    c: [Vec<(usize, f64)>; 5],
    q: [(usize, bool, bool); 2],
    d: SavedRetired,
    a: bool,
    h: SavedHistory,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    p: Option<CompactWindow>,
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(untagged)]
enum SavedHistory {
    Digests(Vec<String>),
    Packed(String),
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(untagged)]
enum SavedRetired {
    Indexes(Vec<usize>),
    Bitmap(String),
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct CompactWindow {
    s: String,
    n: usize,
    g: Vec<CompactGroup>,
    f: Vec<(usize, SavedCandidate)>,
    // 词法（含SQL替代）与dense共同原名次；原始分数只用于形成这些名次。
    c: [Vec<usize>; 2],
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct CompactGroup {
    r: SavedCandidate,
    b: Option<i64>,
    // 每项为原成员下标u16、原offset u64、原SHA-256 32字节，均为大端。
    d: String,
    // SQL owner未读取正文，未知hash只保存成员及位置，恢复时仍为null。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    u: Vec<(usize, u64)>,
}
impl From<SearchContinuation> for SearchContinuationWire {
    fn from(saved: SearchContinuation) -> Self {
        let compact = saved.space.as_deref().filter(|_| !saved.records.is_empty()).map(|space| {
            let mut compact = CompactWindow { s: space.to_owned(), n: saved.records.len(),
                g: vec![], f: vec![], c: std::array::from_fn(|_| vec![]) };
            let mut groups: Vec<(CompactGroup, Vec<u8>)> = Vec::new();
            for (index, record) in saved.records.iter().enumerate() {
                let fields = match record {
                    SavedCandidate::Knowledge(id, version, key, locations) if locations.len() == 1 => {
                        let location = &locations[0];
                        location.offset.and_then(|offset| {
                            let expected = crate::types::knowledge_record_id(space,
                                &json!({"id":id,"version":version}),
                                &json!({"entry_id":location.entry_id,"path":location.path,"statement_id":location.statement_id}),
                                usize::try_from(offset).ok()?);
                            if expected != *key { return None; }
                            let base = location.statement_offset.map(|local| i64::try_from(offset as i128 - local as i128)).transpose().ok()?;
                            let mut template = location.clone();
                            template.offset = None; template.statement_offset = None; template.content_hash = None;
                            Some((SavedCandidate::Knowledge(id.clone(), version.clone(), String::new(), vec![template]), base, offset, location.content_hash.as_ref()))
                        })
                    }
                    SavedCandidate::Raw(kind, id, revision, offset, length, hash) =>
                        Some((SavedCandidate::Raw(kind.clone(), id.clone(), *revision, 0, *length, String::new()), None, *offset, Some(hash))),
                    _ => None,
                };
                let Some((template, base, offset, hash)) = fields.filter(|(_, _, _, hash)| hash.is_none_or(|hash|
                    hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))) else {
                    compact.f.push((index, record.clone())); continue;
                };
                let (group, bytes) = if let Some(group) = groups.iter_mut().find(|(group, _)| group.r == template && group.b == base) {
                    group
                } else {
                    groups.push((CompactGroup { r: template, b: base, d: String::new(), u: vec![] }, vec![]));
                    groups.last_mut().expect("new location group")
                };
                if let Some(hash) = hash {
                    bytes.extend_from_slice(&(index as u16).to_be_bytes());
                    bytes.extend_from_slice(&offset.to_be_bytes());
                    for pair in hash.as_bytes().as_chunks::<2>().0.iter() {
                        bytes.push(u8::from_str_radix(std::str::from_utf8(pair).expect("hex pair"), 16).expect("validated SHA-256"));
                    }
                } else {
                    group.u.push((index, offset));
                }
            }
            compact.g = groups.into_iter().map(|(mut group, bytes)| { group.d = URL_SAFE_NO_PAD.encode(bytes); group }).collect();
            for (channel, indexes) in compact.c.iter_mut().enumerate() {
                let mut rows: Vec<_> = match channel {
                    0 => saved.channels[if saved.sql_active { 4 } else { 0 }].iter().chain(&saved.channels[2]).copied().collect(),
                    _ => saved.channels[1].iter().chain(&saved.channels[3]).copied().collect(),
                };
                rows.sort_by(|(left, a), (right, b)| b.total_cmp(a)
                    .then_with(|| saved.records[*left].key().cmp(&saved.records[*right].key())));
                indexes.extend(rows.into_iter().map(|(index, _)| index));
            }
            compact
        });
        let retired = if compact.is_some() && !saved.retired.is_empty() {
            // 原成员编号对应固定位；接近交齐也不因索引列表增长而丢失末项。
            let mut bytes = vec![0u8; saved.records.len().div_ceil(8)];
            for index in &saved.retired {
                bytes[index / 8] |= 1 << (index % 8);
            }
            SavedRetired::Bitmap(URL_SAFE_NO_PAD.encode(bytes))
        } else {
            SavedRetired::Indexes(saved.retired)
        };
        Self {
            v: saved.schema,
            s: saved.scan,
            r: if compact.is_some() {
                vec![]
            } else {
                saved.records
            },
            c: if compact.is_some() {
                std::array::from_fn(|_| vec![])
            } else {
                saved.channels
            },
            q: saved.sql,
            d: retired,
            a: saved.sql_active,
            // R07窗口生命周期：新cursor不携带跨窗去重记录；h仅保持旧格式兼容，
            // 解码时命中的本窗成员并入retired后释放（见absorb_legacy_history）。
            h: SavedHistory::Digests(vec![]),
            p: compact,
        }
    }
}
impl TryFrom<SearchContinuationWire> for SearchContinuation {
    type Error = String;
    fn try_from(wire: SearchContinuationWire) -> std::result::Result<Self, Self::Error> {
        let history = match wire.h {
            SavedHistory::Digests(values) => values,
            SavedHistory::Packed(value) => {
                if value.len() > 42_667 {
                    return Err("oversized identity history".into());
                }
                let bytes = URL_SAFE_NO_PAD
                    .decode(value)
                    .map_err(|_| "invalid identity history")?;
                if bytes.len() % 32 != 0 {
                    return Err("invalid identity history length".into());
                }
                bytes
                    .as_chunks::<32>()
                    .0
                    .iter()
                    .map(|digest| digest.iter().map(|byte| format!("{byte:02x}")).collect())
                    .collect()
            }
        };
        let retired = match wire.d {
            SavedRetired::Indexes(indexes) => indexes,
            SavedRetired::Bitmap(value) => {
                let count = wire.p.as_ref().ok_or("bitmap without compact window")?.n;
                if count == 0 || count > 1000 || value.len() > 167 {
                    return Err("invalid retired bitmap".into());
                }
                let bytes = URL_SAFE_NO_PAD
                    .decode(value)
                    .map_err(|_| "invalid retired bitmap")?;
                if bytes.len() != count.div_ceil(8)
                    || (count % 8 != 0 && bytes[bytes.len() - 1] >> (count % 8) != 0)
                {
                    return Err("invalid retired bitmap length".into());
                }
                (0..count)
                    .filter(|index| bytes[index / 8] & (1 << (index % 8)) != 0)
                    .collect()
            }
        };
        let mut saved = Self {
            schema: wire.v,
            scan: wire.s,
            records: wire.r,
            channels: wire.c,
            sql: wire.q,
            retired,
            sql_active: wire.a,
            space: None,
        };
        let Some(compact) = wire.p else {
            saved.absorb_legacy_history(&history);
            return Ok(saved);
        };
        if compact.n > 1000
            || compact.s.is_empty()
            || compact.s.len() > 64
            || !saved.records.is_empty()
            || saved.channels.iter().any(|channel| !channel.is_empty())
            || compact.g.len() > 1000
            || compact.f.len() > 1000
        {
            return Err("invalid compact search window".into());
        }
        let mut records = vec![None; compact.n];
        for (index, record) in compact.f {
            let slot = records
                .get_mut(index)
                .filter(|slot| slot.is_none())
                .ok_or("duplicate window member")?;
            *slot = Some(record);
        }
        for group in compact.g {
            if group.d.len() > 56_000 || group.u.len() > 1000 {
                return Err("oversized location group".into());
            }
            let bytes = URL_SAFE_NO_PAD
                .decode(&group.d)
                .map_err(|_| "invalid location encoding")?;
            if (bytes.is_empty() && group.u.is_empty()) || bytes.len() % 42 != 0 {
                return Err("invalid location group".into());
            }
            let hashed = bytes.as_chunks::<42>().0.iter().map(|item| {
                let index =
                    u16::from_be_bytes(item[..2].try_into().expect("fixed member index")) as usize;
                let offset = u64::from_be_bytes(item[2..10].try_into().expect("fixed offset"));
                let hash = item[10..]
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>();
                (index, offset, Some(hash))
            });
            for (index, offset, hash) in hashed.chain(
                group
                    .u
                    .into_iter()
                    .map(|(index, offset)| (index, offset, None)),
            ) {
                let record = match &group.r {
                    SavedCandidate::Knowledge(id, version, key, locations)
                        if key.is_empty() && locations.len() == 1 =>
                    {
                        let mut location = locations[0].clone();
                        if location.offset.is_some()
                            || location.statement_offset.is_some()
                            || location.content_hash.is_some()
                        {
                            return Err("invalid location template".into());
                        }
                        location.offset = Some(offset);
                        location.content_hash = hash;
                        location.statement_offset = group
                            .b
                            .map(|base| u64::try_from(offset as i128 - base as i128))
                            .transpose()
                            .map_err(|_| "invalid statement offset")?;
                        let key = crate::types::knowledge_record_id(
                            &compact.s,
                            &json!({"id":id,"version":version}),
                            &json!({"entry_id":location.entry_id,"path":location.path,"statement_id":location.statement_id}),
                            usize::try_from(offset).map_err(|_| "invalid offset")?,
                        );
                        SavedCandidate::Knowledge(id.clone(), version.clone(), key, vec![location])
                    }
                    SavedCandidate::Raw(kind, id, revision, 0, length, hash_template)
                        if hash_template.is_empty() && group.b.is_none() =>
                    {
                        SavedCandidate::Raw(
                            kind.clone(),
                            id.clone(),
                            *revision,
                            offset,
                            *length,
                            hash.ok_or("raw location requires content hash")?,
                        )
                    }
                    _ => return Err("invalid member template".into()),
                };
                let slot = records
                    .get_mut(index)
                    .filter(|slot| slot.is_none())
                    .ok_or("duplicate window member")?;
                *slot = Some(record);
            }
        }
        saved.records = records
            .into_iter()
            .collect::<Option<Vec<_>>>()
            .ok_or("missing window member")?;
        for (channel, order) in compact.c.into_iter().enumerate() {
            if order.len() > 1000 {
                return Err("oversized channel order".into());
            }
            let count = order.len();
            let mut seen = std::collections::HashSet::new();
            for (rank, index) in order.into_iter().enumerate() {
                let record = saved
                    .records
                    .get(index)
                    .filter(|_| seen.insert(index))
                    .ok_or("invalid channel member")?;
                let target = match (channel, record) {
                    (0, SavedCandidate::Knowledge(..)) => {
                        if saved.sql_active {
                            4
                        } else {
                            0
                        }
                    }
                    (0, SavedCandidate::Raw(..)) => 2,
                    (1, SavedCandidate::Knowledge(..)) => 1,
                    (1, SavedCandidate::Raw(..)) => 3,
                    _ => return Err("invalid channel member".into()),
                };
                saved.channels[target].push((index, (count - rank) as f64));
            }
        }
        saved.space = Some(compact.s);
        saved.absorb_legacy_history(&history);
        Ok(saved)
    }
}
impl SearchContinuation {
    pub fn index_facts(&self) -> &retrieval::vector::IndexFacts {
        &self.scan.facts
    }

    pub fn capture(
        vector: &retrieval::vector::Candidates,
        sql: &[Vec<Value>; 2],
        retired: &[String],
    ) -> Result<Self> {
        let mut saved = Self {
            space: vector.space.clone().or_else(|| {
                vector
                    .lexical
                    .iter()
                    .chain(&vector.values)
                    .find_map(|row| row["space_id"].as_str().map(str::to_owned))
            }),
            schema: 1,
            scan: vector.snapshot_scan()?,
            records: vec![],
            channels: std::array::from_fn(|_| vec![]),
            sql: [(0, false, false); 2],
            retired: vec![],
            sql_active: vector.sql_lexical_active() && vector.lexical.is_empty(),
        };
        let mut keys = std::collections::HashMap::new();
        let sql = retrieval::merge_sql_lexical(sql[0].clone(), sql[1].clone());
        for (channel, rows) in [
            &vector.lexical,
            &vector.values,
            &vector.raw.lexical,
            &vector.raw.dense,
            &sql,
        ]
        .into_iter()
        .enumerate()
        {
            for row in rows {
                let candidate = SavedCandidate::capture(row, channel == 2 || channel == 3)?;
                let key = candidate.key();
                let index = if let Some(index) = keys.get(&key) {
                    *index
                } else {
                    if saved.records.len() >= 1000 {
                        return Err(Error::new("tool_response_capacity"));
                    }
                    let index = saved.records.len();
                    keys.insert(key, index);
                    saved.records.push(candidate);
                    index
                };
                let score = if channel == 2 || channel == 3 {
                    row["distance"].as_f64().unwrap_or(0.)
                } else {
                    row["matches"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|location| location["score"].as_f64())
                        .max_by(f64::total_cmp)
                        .unwrap_or(0.)
                };
                if !saved.channels[channel]
                    .iter()
                    .any(|(seen, _)| *seen == index)
                {
                    saved.channels[channel].push((index, score));
                }
            }
        }
        saved.retired = retired
            .iter()
            .filter_map(|key| keys.get(key).copied())
            .collect();
        saved.retired.sort_unstable();
        saved.retired.dedup();
        Ok(saved)
    }
    fn rows(&self, channel: usize) -> Vec<Value> {
        self.channels[channel]
            .iter()
            .map(|(index, score)| self.records[*index].row(*score))
            .collect()
    }
    fn has_pending(&self) -> bool {
        self.retired.len() < self.records.len()
    }
    fn has_more(&self) -> bool {
        self.has_pending()
            || self.scan.has_more()
            || (self.sql_active && self.sql.iter().any(|(_, _, exhausted)| !exhausted))
    }
    /// 只核对本窗尚未交付的知识版本；当前元信息由owner核验后提供。
    pub fn assert_pending_knowledge(&self, current: &[Value]) -> Result<()> {
        for record in &self.records {
            if self.suppresses(&record.key()) {
                continue;
            }
            if let SavedCandidate::Knowledge(id, version, key, _) = record
                && !current.iter().any(|row| {
                    row["id"] == *id
                        && row["version"] == *version
                        && retrieval::knowledge_record(row) == key
                })
            {
                return Err(Error::new("stale_cursor"));
            }
        }
        Ok(())
    }
    pub fn snapshot(
        &self,
        delivered_records: &[String],
        max_bytes: usize,
    ) -> Result<Option<String>> {
        self.validate()?;
        let mut saved = self.clone();
        for key in delivered_records {
            let index = saved
                .records
                .iter()
                .position(|record| record.key() == *key)
                .ok_or(Error::new("invalid_cursor"))?;
            if !saved.retired.contains(&index) {
                saved.retired.push(index);
            }
        }
        saved.retired.sort_unstable();
        if !saved.has_more() {
            return Ok(None);
        }
        if !saved.has_pending() {
            // R07窗口生命周期：本窗全部消费完即释放成员与去重状态，游标只保
            // 通道/分片已消费位置、必要未交引用与原范围/修订事实；跨新窗允许
            // 同身份重现，不再把已结束窗口身份累计进全查询去重记录。
            saved.records.clear();
            saved.channels.iter_mut().for_each(Vec::clear);
            saved.retired.clear();
        }
        let encoded = serde_json::to_string(&saved).map_err(|_| Error::new("invalid_cursor"))?;
        if encoded.len() > max_bytes {
            return Err(Error::new("tool_response_capacity"));
        }
        Ok(Some(encoded))
    }
    pub fn decode(encoded: &str) -> Result<Self> {
        if encoded.len() > SEARCH_CURSOR_BYTES {
            return Err(Error::new("invalid_cursor"));
        }
        let saved: Self =
            serde_json::from_str(encoded).map_err(|_| Error::new("invalid_cursor"))?;
        saved.validate()?;
        Ok(saved)
    }
    /// 已由外层边界反序列化的值复用同一核验，不重做JSON解析。
    pub fn validate(&self) -> Result<()> {
        let saved = self;
        saved.scan.validate()?;
        if saved.schema != 1
            || saved.records.len() > 1000
            || saved.channels.iter().any(|channel| {
                channel.len() > 1000
                    || channel
                        .iter()
                        .any(|(index, score)| *index >= saved.records.len() || !score.is_finite())
            })
            || saved.retired.len() > saved.records.len()
            || saved
                .retired
                .iter()
                .any(|index| *index >= saved.records.len())
        {
            return Err(Error::new("invalid_cursor"));
        }
        let mut keys = std::collections::HashSet::new();
        let mut locations = 0;
        for record in &saved.records {
            if !keys.insert(record.key()) {
                return Err(Error::new("invalid_cursor"));
            }
            match record {
                SavedCandidate::Knowledge(id, version, key, matches) => {
                    locations += matches.len();
                    if id.is_empty()
                        || id.len() > 64
                        || key.is_empty()
                        || key.len() > 128
                        || version
                            .parse::<u64>()
                            .ok()
                            .filter(|version| *version > 0)
                            .is_none()
                        || matches.is_empty()
                        || matches.iter().any(|location| {
                            location.length.is_some_and(|length| {
                                length == 0 || length > crate::types::KNOWLEDGE_WINDOW as u64
                            }) || location.offset.zip(location.length).is_some_and(
                                |(offset, length)| offset.checked_add(length).is_none(),
                            ) || [
                                &location.entry_id,
                                &location.path,
                                &location.statement_id,
                                &location.content_hash,
                            ]
                            .into_iter()
                            .flatten()
                            .any(|value| value.len() > 200)
                        })
                    {
                        return Err(Error::new("invalid_cursor"));
                    }
                }
                SavedCandidate::Raw(kind, id, revision, offset, length, hash) => {
                    locations += 1;
                    if !matches!(kind.as_str(), "document" | "platform")
                        || id.is_empty()
                        || id.len() > 64
                        || *revision == 0
                        || *length == 0
                        || *length > 2400
                        || offset.checked_add(*length).is_none()
                        || hash.is_empty()
                        || hash.len() > 128
                    {
                        return Err(Error::new("invalid_cursor"));
                    }
                }
            }
        }
        if locations > 1000
            || saved.retired.windows(2).any(|pair| pair[0] >= pair[1])
            || saved.channels.iter().any(|channel| {
                let mut seen = std::collections::HashSet::new();
                channel.iter().any(|(index, _)| !seen.insert(index))
            })
        {
            return Err(Error::new("invalid_cursor"));
        }
        Ok(())
    }
    fn retire(&mut self, keys: impl Iterator<Item = String>) {
        for key in keys {
            if let Some(index) = self.records.iter().position(|record| record.key() == key)
                && !self.retired.contains(&index)
            {
                self.retired.push(index);
            }
        }
        self.retired.sort_unstable();
    }
    // R07窗口生命周期：抑制只覆盖本窗已交付/已否决成员；跨新窗同身份重现合法。
    fn suppresses(&self, key: &str) -> bool {
        self.retired
            .iter()
            .any(|index| self.records[*index].key() == key)
    }
    fn restore_window(&self, vector: &mut retrieval::vector::Candidates) -> Result<()> {
        // 同一窗口中已交付项仍影响通道原名次，也属于本次接回的候选输入。
        vector
            .budget
            .restore_candidates(self.records.iter().map(|record| {
                let key = record.key();
                key.strip_prefix("k:").unwrap_or(&key).to_owned()
            }))?;
        vector.lexical = self.rows(0);
        vector.values = self.rows(1);
        vector.raw.lexical = self.rows(2);
        vector.raw.dense = self.rows(3);
        Ok(())
    }
    // R07旧cursor薄转换：命中旧全查询去重记录的本窗成员并入本窗retired，随后
    // 释放全查询history；不能直接清空导致当前窗旧抑制成员重新交付。
    fn absorb_legacy_history(&mut self, history: &[String]) {
        if history.is_empty() {
            return;
        }
        for (index, record) in self.records.iter().enumerate() {
            if history.contains(&fingerprint(&json!(record.key())))
                && !self.retired.contains(&index)
            {
                self.retired.push(index);
            }
        }
        self.retired.sort_unstable();
        self.retired.dedup();
    }
    /// 先用完整窗口恢复原通道排名，再去掉已交付/已否决成员，避免局部rank归零。
    pub fn rank_window(&self, query: &str, objects: Vec<Value>) -> retrieval::CommonRank {
        let lexical = if self.sql_active {
            self.rows(4)
        } else {
            self.rows(0)
        };
        let dense = self.rows(1);
        let raw_lexical = self.rows(2);
        let raw_dense = self.rows(3);
        let mut rank = retrieval::rank_common(
            query,
            objects,
            &retrieval::Channels::all(&lexical, &dense, &raw_lexical, &raw_dense),
            1000,
            true,
        );
        rank.sequence.retain(|(_, key)| !self.suppresses(key));
        rank.objects
            .retain(|row| !self.suppresses(&format!("k:{}", retrieval::knowledge_record(row))));
        rank.raw.retain(|row| {
            !self.suppresses(&format!(
                "raw:{}",
                retrieval::raw_record(row).expect("saved raw identity")
            ))
        });
        rank
    }
}

// 锁外检索阶段：召回、语义对象与资产目录在自己的短读事务中完成，不持会话/运行锁。
// 慢读取期间宿主心跳可正常续租；提交前由 assert_search_fresh_in_tx 重核版本。
pub struct ScopedSearchStage {
    pub search: KnowledgeSearch,
    pub items: Vec<Value>,
    pub page: Value,
}

pub struct ScopedSearchRequest<'a> {
    pub query: &'a str,
    pub limit: usize,
    // 检索启动包（05切片4）：词法Milvus路与查询嵌入并行发出。锁外阶段在词法
    // 就绪后即开始核验与有界预读，嵌入就绪后执行dense首轮并入共同排序；None表
    // 示vector已是完整候选（等待路径组装或unconfigured占位）。
    pub launch: Option<super::knowledge_embeddings::SearchLaunch>,
    // 拥有向量候选（05切片3）：组合层在锁外按可交付候选驱动深度推进，游标与
    // 命中在推进中原位更新。
    pub vector: retrieval::vector::Candidates,
    pub scope: &'a KnowledgeSearchScope,
    pub allowed: Option<&'a retrieval::vector::AllowedRecords>,
    pub asset_after: Option<&'a str>,
    pub hints: Option<&'a crate::contracts::generated::Hints>,
    pub cid: &'a str,
    pub text_results: &'a super::context_authority::CheckedTextResults,
    pub include_raw: bool,
}

// 元信息核验的跨轮缓存（05切片3）：推进循环内每轮短事务只对新增候选查库，
// 同一对象同一边界不重复核验；最终装配复用同一份缓存。
#[derive(Default)]
pub struct VerdictCache {
    meta: std::collections::HashMap<String, Option<Value>>,
    complete: std::collections::HashSet<(String, u64)>,
    // 依赖索引游走判定结果（true=失效）：已判定对象跨轮不重复游走。
    stale: std::collections::HashMap<String, bool>,
}

// 主命中按规范内容身份占额；同对象的不同条目和窗口分别读取，同位置跨通道复用。
#[derive(Default)]
pub struct StageReads {
    objects: std::collections::HashMap<String, Value>,
    failed: std::collections::HashSet<String>,
    spent: usize,
    ranked: Vec<Value>,
    raw: std::collections::HashMap<String, Value>,
    sequence: Vec<(f64, String)>,
    unverified: Vec<Value>,
    deadline_capped: bool,
    exact_checked: bool,
    scan_progress: Value,
    continuation: Option<SearchContinuation>,
}

// 选中项的定点窄读、来源修订核验与语义装配（05切片4）：预读与最终装配共用同一
// 链路；候选级失效（对象换代/来源不可读）返回None按无效候选跳过并占名额，基础
// 设施错误整体传播。窄读按候选元信息版本钉住，范围已在候选SQL与allowed集上核过。
#[allow(clippy::too_many_arguments)]
async fn load_selected_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    candidate: &Value,
    scope: &KnowledgeSearchScope,
    cache: &VerdictCache,
) -> Result<Option<Value>> {
    let id = candidate["id"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?;
    let version = epoch(
        candidate["version"]
            .as_str()
            .ok_or(Error::new("invalid_input"))?,
    )?;
    let mut located = candidate.clone();
    let Some(location) = located["matches"]
        .as_array_mut()
        .and_then(|hits| hits.first_mut())
    else {
        return Ok(None);
    };
    let mut object = match knowledge::read_entries_in_tx(
        tx,
        ctx,
        id,
        version,
        retrieval::knowledge_record(candidate),
        location,
        scope,
    )
    .await
    {
        Ok(Some(object)) => object,
        Ok(None) => return Ok(None),
        Err(error)
            if matches!(
                error.code,
                "not_available" | "stale_knowledge" | "stale_source"
            ) =>
        {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    if !cache.complete.contains(&(id.to_owned(), version)) {
        // 窄读返回库内按整版本计算的必要来源（含未读条目的引用）；证据缺
        // source_id或版本不可解析与原requirements错误语义一致，整体报错。
        let required = super::knowledge_sources::requirements(&object)?;
        let sources: Vec<_> = required.iter().map(|(source, _)| source.clone()).collect();
        let versions = match super::knowledge_sources::versions_in_tx(tx, ctx, &sources).await {
            Ok(versions) => versions,
            Err(error)
                if matches!(
                    error.code,
                    "not_available" | "stale_knowledge" | "stale_source"
                ) =>
            {
                return Ok(None);
            }
            Err(error) => return Err(error),
        };
        let fresh = required
            .iter()
            .all(|(source, version)| versions.get(source) == Some(version));
        if !fresh {
            return Ok(None);
        }
    }
    if let Some(dependencies) = object.get("statement_dependencies") {
        match check_refs_in_tx(tx, ctx, dependencies).await {
            Ok(()) => (),
            Err(error)
                if matches!(
                    error.code,
                    "not_available" | "stale_knowledge" | "stale_source"
                ) =>
            {
                return Ok(None);
            }
            Err(error) => return Err(error),
        }
    }
    // SQL候选不传正文hash；owner已按同版位置读取，展示只使用这份核验后的正文。
    if located["matches"][0]["content_hash"].is_null() {
        located["matches"][0]["content_hash"] =
            json!(fingerprint(&object["entries"][0]["effective_value"]));
    }
    retrieval::attach_matches(&ctx.space_id, &mut object, &located);
    let mut object = semantic_object_in_tx(tx, ctx, object).await?;
    if let Some(anchor) = &scope.anchor
        && object["id"] != *anchor
        && !object["related_ids"]
            .as_array()
            .is_some_and(|ids| ids.iter().any(|id| id == anchor))
    {
        // 仅直接id/related_ids关联免检；结构关联（对象自带结构与登记引用同一
        // 来源）一律核当前性：matches_anchor的结构命中不带版本，不能作为准入。
        let anchor_scope = KnowledgeSearchScope {
            anchor: Some(anchor.clone()),
            ..Default::default()
        };
        let references = knowledge::read_structure_refs_in_tx(tx, ctx, id, version).await?;
        if !anchor_scope.matches(&references) {
            return Ok(None);
        }
        // 关联准入按登记版本即anchor当前版本：同DDL升版不恢复旧结构关联，
        // 须重新确认关联后才能再次进入范围（10-29 scope合同，非指纹语义）。
        // anchor已撤时关联无当前版本可依，按分支惯例丢弃候选而非报错。
        let anchor_head = match knowledge::read_meta_in_tx(tx, ctx, anchor, None).await {
            Ok(meta) => meta,
            Err(error) if matches!(error.code, "not_available") => return Ok(None),
            Err(error) => return Err(error),
        };
        let anchor_current = anchor_head["version"].as_str().unwrap_or_default();
        let registered_at_current = references["entries"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|entry| knowledge::table_dependencies(&entry["effective_structure"]))
            .any(|reference| {
                reference["object_id"].as_str() == Some(anchor.as_str())
                    && reference["version"].as_str() == Some(anchor_current)
            });
        if !registered_at_current {
            return Ok(None);
        }
        let mut dependencies = current_structure_refs_in_tx(tx, ctx, &references).await?;
        dependencies.extend(knowledge::semantic_dependencies(&references));
        let checked = match checked_refs_in_tx(tx, ctx, &json!(dependencies), None).await {
            Ok(references) => references,
            Err(error) if matches!(error.code, "stale_knowledge" | "not_available") => {
                return Ok(None);
            }
            Err(error) => return Err(error),
        };
        object["structure_dependencies"] = json!(checked);
    }
    Ok(Some(object))
}

// 通道输入序去重后的候选身份（05接续C）：SQL后备（BM25不可用时）与向量两路
// 按输入序合并去重；推进循环只看向量候选时传空SQL段。
fn ordered_candidates_with(
    sql_lexical: &[Value],
    vector: &retrieval::vector::Candidates,
) -> Vec<Value> {
    let all = sql_lexical
        .iter()
        .cloned()
        .chain(vector.values.iter().cloned())
        .chain(vector.lexical.iter().cloned())
        .collect::<Vec<_>>();
    let mut ordered: Vec<Value> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for candidate in &all {
        let record = retrieval::knowledge_record(candidate);
        if !record.is_empty() && seen.insert(record.to_owned()) {
            ordered.push(candidate.clone());
        }
    }
    ordered
}

// 元信息核验（05切片3）：≤50批读元信息（身份、名称、版本、启停、类型、来源头
// ——不含body），做版本绑定与依赖索引有效性判定，返回可交付候选（排名输入）。
// 缓存跨轮复用——同一对象同一边界只核验一次，推进循环每轮只对新增候选查库。
// 有效性走依赖索引：映射完备的对象按有效层游走判定失效——人工真正替换后的
// 废弃建议/事实引用不再误滤，整理派生陈述绑定的来源修订真正受检，知识支持
// 链上的改版即时可见。无索引状态的旧对象不在元数据阶段判定，作为候选进入
// 排名，选中后按legacy正文规则核验（05接续C：不为旧数据把全部候选退回全文
// 装配）；unknown链路成员按“报告不阻断”保留在候选中。
async fn ranked_candidates_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    ordered: &[Value],
    scope: &KnowledgeSearchScope,
    hints: Option<&crate::contracts::generated::Hints>,
    cache: &mut VerdictCache,
) -> Result<Vec<Value>> {
    let mut fresh: Vec<&str> = Vec::new();
    for candidate in ordered {
        let Some(id) = candidate["id"].as_str() else {
            continue;
        };
        if !cache.meta.contains_key(id) && !fresh.contains(&id) {
            fresh.push(id);
        }
    }
    for chunk in fresh.chunks(50) {
        let chunk: Vec<String> = chunk.iter().map(|id| (*id).to_owned()).collect();
        let values = knowledge::candidate_meta_in_tx(tx, ctx, &chunk, hints).await?;
        for id in chunk {
            cache.meta.insert((*id).to_owned(), None);
        }
        for value in values {
            cache.meta.insert(
                value["id"].as_str().unwrap_or_default().to_owned(),
                Some(value),
            );
        }
    }
    let mut owner_seen = std::collections::HashSet::new();
    let owners: Vec<(String, u64)> = ordered
        .iter()
        .filter_map(|candidate| {
            let id = candidate["id"].as_str()?;
            let value = cache.meta.get(id)?.as_ref()?;
            Some((
                id.to_owned(),
                value["version"].as_str()?.parse::<u64>().ok()?,
            ))
        })
        .filter(|owner| !cache.complete.contains(owner) && owner_seen.insert(owner.clone()))
        .collect();
    for chunk in owners.chunks(50) {
        cache
            .complete
            .extend(knowledge::dependency_index::complete_members_in_tx(tx, chunk).await?);
    }
    // 只对依赖索引完备且尚未判定过的owner游走；判定结果（含"未失效"）缓存，
    // 跨轮不重复游走。
    let mut pending: Vec<(String, u64)> = Vec::new();
    for owner in &owners {
        if cache.complete.contains(owner) && !cache.stale.contains_key(&owner.0) {
            pending.push(owner.clone());
        }
    }
    for chunk in pending.chunks(50) {
        let roots: Vec<_> = chunk.to_vec();
        let verdict =
            super::dependency_validation::walk_required_in_tx(tx, &ctx.space_id, &roots).await?;
        if verdict.stale.is_empty() {
            for root in &roots {
                cache.stale.insert(root.0.clone(), false);
            }
            continue;
        }
        // stale条目的owner可能是链路中间成员而非候选根；组内有stale时逐根
        // 定位归属，无stale的组无需逐根往返。
        for root in roots {
            let single = super::dependency_validation::walk_required_in_tx(
                tx,
                &ctx.space_id,
                std::slice::from_ref(&root),
            )
            .await?;
            cache.stale.insert(root.0, !single.stale.is_empty());
        }
    }
    // 元数据阶段的排名输入：enabled、通道版本绑定、范围类型与依赖索引有效性都
    // 通过的候选，携带排名所需的id/name/version。
    let mut ranked_candidates = Vec::new();
    for candidate in ordered {
        let Some(id) = candidate["id"].as_str() else {
            continue;
        };
        let Some(value) = cache.meta.get(id).and_then(|v| v.as_ref()) else {
            continue;
        };
        let Some(version) = value["version"]
            .as_str()
            .and_then(|v| v.parse::<u64>().ok())
        else {
            continue;
        };
        if value["state"] != "enabled" {
            continue;
        }
        if !scope.kinds.is_empty()
            && value["kind"]
                .as_str()
                .is_some_and(|kind| !scope.kinds.iter().any(|wanted| wanted == kind))
        {
            continue;
        }
        if cache.complete.contains(&(id.to_owned(), version))
            && cache.stale.get(id).copied().unwrap_or(false)
        {
            continue;
        }
        if candidate["version"]
            .as_str()
            .is_some_and(|hit_version| value["version"] != hit_version)
        {
            continue;
        }
        let mut content = candidate.clone();
        content["name"] = value["name"].clone();
        content["version"] = value["version"].clone();
        ranked_candidates.push(content);
    }
    Ok(ranked_candidates)
}

#[derive(Default)]
struct SqlCursor {
    consumed: usize,
    dispatched_round: usize,
    in_flight: bool,
    succeeded: bool,
    exhausted: bool,
    hits: Vec<Value>,
}
impl SqlCursor {
    fn accept(
        &mut self,
        budget: &mut retrieval::vector::CandidateBudget,
        reserved: usize,
        result: Result<Option<Vec<Value>>>,
    ) -> Result<bool> {
        self.in_flight = false;
        match result {
            Ok(Some(rows)) => {
                budget.record(
                    reserved,
                    rows.iter()
                        .map(|row| retrieval::knowledge_record(row).to_owned()),
                );
                self.succeeded = true;
                self.consumed += rows.len();
                self.exhausted = rows.len() < reserved;
                self.hits = retrieval::merge_sql_lexical(std::mem::take(&mut self.hits), rows);
                Ok(false)
            }
            Ok(None) => {
                budget.record(reserved, std::iter::empty());
                Ok(true)
            }
            Err(error) => {
                budget.record(reserved, std::iter::empty());
                Err(error)
            }
        }
    }
}
enum SearchEvent {
    Target(Result<String>),
    Page(retrieval::vector::CandidatePage),
    Sql {
        source: usize,
        reserved: usize,
        result: Result<Option<Vec<Value>>>,
    },
}

fn cursor_read_error(error: Error) -> Error {
    if matches!(
        error.code,
        "not_available" | "stale_knowledge" | "stale_source"
    ) {
        Error::new("stale_cursor")
    } else {
        error
    }
}

// 一次调用内的唯一推进：就绪通道、SQL替代词法和owner内容读取共享身份及期限。
#[allow(clippy::too_many_arguments)]
async fn drive_stage(
    pool: &MySqlPool,
    ctx: &AccessContext,
    query: &str,
    limit: usize,
    launch: Option<super::knowledge_embeddings::SearchLaunch>,
    vector: &mut retrieval::vector::Candidates,
    scope: &KnowledgeSearchScope,
    allowed: Option<&retrieval::vector::AllowedRecords>,
    include_raw: bool,
    hints: Option<&crate::contracts::generated::Hints>,
    resume: Option<SearchContinuation>,
) -> Result<(VerdictCache, StageReads)> {
    use retrieval::vector::ScanChannel;
    const CHANNELS: [ScanChannel; 4] = [
        ScanChannel::Lexical,
        ScanChannel::Dense,
        ScanChannel::RawLexical,
        ScanChannel::RawDense,
    ];
    let deadline = vector.deadline;
    // SQL后备同样以当前请求的space重建规范身份，不依赖向量配置或候选附带字段。
    vector.space = Some(ctx.space_id.clone());
    let mut embedding = launch.map(|launch| launch.embedding);
    let mut resume = resume;
    let restored_window = resume.as_ref().is_some_and(SearchContinuation::has_pending);
    let mut setup_error = None;
    let target_expected = resume
        .as_ref()
        .map(|saved| saved.index_facts().target.clone());
    let mut events = tokio::task::JoinSet::new();
    let mut target_ready = !retrieval::vector::enabled();
    if retrieval::vector::enabled() {
        let query_vector = vector.dense_vector.take();
        let budget = std::mem::take(&mut vector.budget);
        *vector = retrieval::vector::prepare_cursors(
            &ctx.space_id,
            scope,
            allowed,
            include_raw,
            deadline,
        );
        vector.budget = budget;
        vector.dense_vector = query_vector;
        if let Some(saved) = &resume
            && let Err(error) = vector.restore_scan(&saved.scan)
        {
            setup_error = Some(error);
        }
        if embedding.is_none() && vector.dense_vector.is_none() {
            vector.mark_embedding_unavailable();
        }
        events.spawn(async move {
            SearchEvent::Target(
                match tokio::time::timeout_at(deadline, retrieval::vector::index_target()).await {
                    Ok(value) => value,
                    Err(_) => Err(Error::new("unavailable")),
                },
            )
        });
    }
    if !retrieval::vector::enabled()
        && let Some(saved) = &resume
        && let Err(error) = vector.restore_scan(&saved.scan)
    {
        setup_error = Some(error);
    }
    if restored_window
        && let Err(error) = resume
            .as_ref()
            .expect("restored window")
            .restore_window(vector)
    {
        setup_error = Some(error);
    }
    let mut sql = [SqlCursor::default(), SqlCursor::default()];
    if let Some(saved) = &resume {
        for (cursor, (consumed, succeeded, exhausted)) in sql.iter_mut().zip(saved.sql) {
            cursor.consumed = consumed;
            cursor.succeeded = succeeded;
            cursor.exhausted = exhausted;
        }
    }
    let mut round = 1usize;
    let terms = retrieval::candidate_terms(query);
    // R12：SQL 24词截断只裁SQL后备候选。是否算覆盖受限取决于SQL是否实际参与
    // 当前候选窗：恢复窗沿用快照sql_active，不因续页未重新发SQL丢状态。
    let mut window_sql_active = resume.as_ref().is_some_and(|saved| saved.sql_active);
    let mut seen_terms = std::collections::HashSet::new();
    let scoring_terms: Vec<_> = retrieval::tokens(query)
        .into_iter()
        .filter(|term| seen_terms.insert(term.clone()))
        .collect();
    let mut cache = VerdictCache::default();
    let mut reads = StageReads::default();
    let mut evaluated = std::collections::HashSet::new();
    let mut embedding_error = None;
    let mut pending_events = std::collections::VecDeque::new();
    let outcome: Result<()> = async {
        if let Some(error) = setup_error { return Err(error); }
        loop {
            if tokio::time::Instant::now() >= deadline {
                reads.deadline_capped = true;
                vector.stop_scans("deadline");
                break;
            }
            // 所有已就绪事件先入共同排名，再分配下一笔主命中读取。
            loop {
                let event = if let Some(event) = pending_events.pop_front() { event }
                    else if let Some(event) = events.try_join_next() {
                        event.map_err(|error| Error::new("unavailable").with_message(format!("search task: {error}")))?
                    } else { break; };
                match event {
                    SearchEvent::Target(result) => {
                        target_ready = true;
                        match result {
                            Ok(target) => {
                                if resume.as_ref().is_some_and(|saved| saved.index_facts().target.as_ref() != Some(&target)) {
                                    return Err(Error::new("stale_cursor"));
                                }
                                vector.target = Some(target);
                            },
                            Err(error) => {
                                if resume.is_some() { return Err(error); }
                                vector.lexical_state = "unavailable";
                                vector.dense_state = "unavailable";
                                vector.bounded = true;
                                vector.fail_channels();
                            }
                        }
                    }
                    SearchEvent::Page(page) => vector.accept_page(page),
                    SearchEvent::Sql { source, reserved, result } => {
                        reads.deadline_capped |= sql[source].accept(&mut vector.budget, reserved, result)?;
                    }
                }
            }
            if embedding.as_ref().is_some_and(|handle| handle.is_finished()) {
                let result = embedding.take().expect("ready embedding").await
                    .map_err(|error| Error::new("unavailable").with_message(format!("embedding task: {error}")))?;
                match result {
                    Ok(query_vector) => {
                        vector.dense_vector = query_vector;
                        if vector.dense_vector.is_none() {
                            vector.mark_embedding_unavailable();
                        }
                    }
                    Err(error) => { embedding_error = Some(error); break; }
                }
            }
            // 只有整条BM25明确失败才替代词法；成功空、成功页及尚未执行的分片都阻止SQL加票。
            let sql_active = if restored_window { resume.as_ref().expect("restored window").sql_active }
                else { vector.sql_lexical_active() };
            window_sql_active |= sql_active;
            // 先让本轮各路开始，之后可在其I/O期间核验已收内容；临时零预留不封死游标。
            if target_ready && !restored_window {
                for channel in CHANNELS {
                    if let Some(page) = vector.next_page(channel, query, round, limit) {
                        events.spawn(async move { SearchEvent::Page(retrieval::vector::fetch_page(page).await) });
                    }
                }
                if sql_active {
                    for (source, cursor) in sql.iter_mut().enumerate() {
                        if cursor.exhausted || cursor.in_flight || cursor.dispatched_round >= round { continue; }
                        let wanted = if cursor.dispatched_round == 0 { 50usize.max(5 * limit).min(200) } else { 200 };
                        let reserved = vector.budget.allocate(round, wanted);
                        if reserved == 0 { continue; }
                        cursor.in_flight = true;
                        cursor.dispatched_round = round;
                        let consumed = cursor.consumed;
                        let pool = pool.clone();
                        let ctx = ctx.clone();
                        let scope = scope.clone();
                        let allowed = allowed.cloned();
                        let terms = terms.values.clone();
                        let scoring_terms = scoring_terms.clone();
                        let query = query.to_owned();
                        // 仅有原文通道时才用其替代未整理文档；纯词法仍须保留可补读的正文候选。
                        let raw_projection = include_raw && retrieval::vector::enabled();
                        events.spawn(async move {
                            let result = tokio::time::timeout_at(deadline, async {
                                let mut tx = AppTx::begin(&pool).await?;
                                let allowed = allowed.as_ref().map(|records| records.knowledge_ids.as_slice());
                                let rows = if source == 0 {
                                    knowledge::matching_content_in_tx(&mut tx, &ctx, &query, &terms, &scoring_terms, &scope, allowed, reserved, consumed, raw_projection).await?
                                } else {
                                    retrieval::content_candidates_scoped_in_tx(&mut tx, &ctx.space_id, &query, &terms, &scoring_terms, &scope, allowed, reserved, consumed, raw_projection).await?
                                };
                                tx.commit().await?;
                                Ok::<_, Error>(rows)
                            }).await;
                            SearchEvent::Sql { source, reserved, result: match result {
                                Ok(result) => result.map(Some), Err(_) => Ok(None),
                            }}
                        });
                    }
                }
            }
            if !target_ready && restored_window {
                if let Some(event) = events.join_next().await { pending_events.push_back(event.map_err(|error| Error::new("unavailable").with_message(format!("search task: {error}")))?); }
                continue;
            }
            let lexical = if restored_window && sql_active { resume.as_ref().expect("restored window").rows(4) }
                else if sql_active { retrieval::merge_sql_lexical(sql[0].hits.clone(), sql[1].hits.clone()) }
                else { vector.lexical.clone() };
            let mut enough = false;
            let ordered = ordered_candidates_with(&lexical, vector);
            if !ordered.is_empty() || (include_raw && (!vector.raw.lexical.is_empty() || !vector.raw.dense.is_empty())) {
                let mut tx = match tokio::time::timeout_at(deadline, AppTx::begin(pool)).await {
                    Ok(tx) => tx?, Err(_) => { reads.deadline_capped = true; break; }
                };
                let ranked = match tokio::time::timeout_at(deadline,
                    ranked_candidates_in_tx(&mut tx, ctx, &ordered, scope, hints, &mut cache)).await {
                    Ok(ranked) => ranked?, Err(_) => { reads.deadline_capped = true; break; }
                };
                if restored_window {
                    let checked = tokio::time::timeout_at(deadline, async {
                    let saved = resume.as_ref().expect("restored window");
                    // 先重核整批未交付引用；不存在/换版不能当作普通失效候选静默舍弃。
                    saved.assert_pending_knowledge(&ranked)?;
                    for record in &saved.records {
                        if saved.suppresses(&record.key()) { continue; }
                        if let SavedCandidate::Raw(kind, id, revision, ..) = record {
                            let source = if kind == "document" { format!("document-{id}") } else { id.clone() };
                            let meta = super::knowledge_sources::read_meta_in_tx(&mut tx, ctx, &source, None).await
                                .map_err(cursor_read_error)?;
                            if meta["version"].as_str() != Some(revision.to_string().as_str()) {
                                return Err(Error::new("stale_cursor"));
                            }
                        }
                    }
                    Ok::<_, Error>(())
                    }).await;
                    match checked {
                        Ok(result) => result?,
                        Err(_) => { reads.deadline_capped = true; break; }
                    }
                }
                reads.ranked = ranked.clone();
                let channels = retrieval::Channels::all(&lexical, &vector.values, &vector.raw.lexical, &vector.raw.dense);
                let mut rank = if restored_window { resume.as_ref().expect("restored window").rank_window(query, ranked) }
                    else { retrieval::rank_common(query, ranked, &channels, 1000, include_raw) };
                reads.exact_checked = true;
                if let Some(hints) = hints {
                    // 原文文档沿同一owner窄元信息匹配；不为软排序读取正文或收窄允许集。
                    let mut documents: Vec<String> = rank.raw.iter()
                        .filter(|candidate| candidate["source_kind"] == "document")
                        .filter_map(|candidate| candidate["source_id"].as_str())
                        .filter(|id| !cache.meta.contains_key(*id))
                        .map(str::to_owned).collect();
                    documents.sort(); documents.dedup();
                    for chunk in documents.chunks(50) {
                        let values = match tokio::time::timeout_at(deadline,
                            knowledge::candidate_meta_in_tx(&mut tx, ctx, chunk, Some(hints))).await {
                            Ok(values) => values?,
                            Err(_) => { reads.deadline_capped = true; break; }
                        };
                        for id in chunk { cache.meta.insert(id.clone(), None); }
                        for value in values {
                            cache.meta.insert(value["id"].as_str().unwrap_or_default().to_owned(), Some(value));
                        }
                    }
                    if reads.deadline_capped { break; }
                    let mut matches = rank.objects.iter().map(|candidate| {
                        let score = candidate["id"].as_str().and_then(|id| cache.meta.get(id))
                            .and_then(Option::as_ref).and_then(|meta| meta["hint_match"].as_i64()).unwrap_or(0);
                        (format!("k:{}", retrieval::knowledge_record(candidate)), score)
                    }).collect::<std::collections::HashMap<_, _>>();
                    for candidate in &rank.raw {
                        let id = candidate["source_id"].as_str().unwrap_or_default();
                        let score = if candidate["source_kind"] == "document" {
                            cache.meta.get(id).and_then(Option::as_ref)
                                .filter(|meta| meta["version"].as_str().and_then(|value| value.parse::<u64>().ok()) == candidate["revision"].as_u64())
                                .and_then(|meta| meta["hint_match"].as_i64()).unwrap_or(0)
                        } else {
                            i64::from(hints.related_object_ids.as_ref().is_some_and(|ids| ids.iter().any(|value| value == id)))
                        };
                        matches.insert(format!("raw:{}", retrieval::raw_record(candidate).expect("ranked raw identity")), score);
                    }
                    // 精确ID/名称优先级沿原score保留；同级才按提示稳定提升。
                    rank.sequence.sort_by_key(|(score, key)| std::cmp::Reverse((*score >= 100., matches.get(key).copied().unwrap_or(0))));
                }
                reads.sequence = rank.sequence.clone();
                evaluated.extend(ordered.iter().map(|candidate| format!("k:{}", retrieval::knowledge_record(candidate))));
                evaluated.extend(rank.sequence.iter().map(|(_, key)| key.clone()));
                let mut selected = 0usize;
                for (_, key) in &rank.sequence {
                    // I/O期间就绪的新通道先处理；不让慢后页独占整个循环。
                    if let Some(event) = events.try_join_next() {
                        pending_events.push_back(event.map_err(|error| Error::new("unavailable").with_message(format!("search task: {error}")))?);
                        break;
                    }
                    if embedding.as_ref().is_some_and(|handle| handle.is_finished()) { break; }
                    if selected >= limit { enough = true; break; }
                    if reads.objects.contains_key(key) || reads.raw.contains_key(key) { selected += 1; continue; }
                    if reads.failed.contains(key) || reads.spent >= 30 { continue; }
                    if tokio::time::Instant::now() >= deadline { reads.deadline_capped = true; break; }
                    reads.spent += 1;
                    let content = if let Some(record) = key.strip_prefix("k:") {
                        let candidate = rank.objects.iter().find(|value| retrieval::knowledge_record(value) == record).expect("ranked content");
                        tokio::time::timeout_at(deadline, load_selected_in_tx(&mut tx, ctx, candidate, scope, &cache)).await
                    } else {
                        let record = key.strip_prefix("raw:").expect("raw content");
                        let candidate = rank.raw.iter().find(|value| retrieval::raw_record(value).as_deref() == Some(record)).expect("ranked raw content");
                        tokio::time::timeout_at(deadline, async {
                            let reply = super::knowledge_sources::recall_excerpts_in_tx(&mut tx, ctx, None, std::slice::from_ref(candidate)).await?;
                            Ok::<_, Error>(reply["hits"].as_array().and_then(|hits| hits.first()).cloned())
                        }).await
                    };
                    match content {
                        Ok(Err(error)) => return Err(error),
                        Ok(Ok(Some(content))) if tokio::time::Instant::now() < deadline => {
                            if key.starts_with("k:") { reads.objects.insert(key.clone(), content); }
                            else { reads.raw.insert(key.clone(), content); }
                            selected += 1;
                        }
                        Ok(Ok(None)) => {
                            if restored_window { return Err(Error::new("stale_cursor")); }
                            reads.failed.insert(key.clone());
                        }
                        Ok(Ok(Some(_))) | Err(_) => { reads.deadline_capped = true; break; }
                    }
                }
                enough |= selected >= limit;
                tx.commit().await?;
            }
            if reads.deadline_capped { break; }
            if !pending_events.is_empty() || embedding.as_ref().is_some_and(|handle| handle.is_finished()) { continue; }
            if restored_window || enough || reads.spent >= 30 {
                if events.is_empty() && embedding.is_none() { break; }
            } else if events.is_empty() {
                let can_advance = CHANNELS.into_iter().any(|channel| vector.cursors.cursor(channel).is_some_and(|cursor| {
                    cursor.advanceable() && cursor.shards.iter().any(|shard| {
                        !shard.failed && shard.full_page && shard.dispatched_round == round
                    })
                })) || (sql_active && sql.iter().any(|cursor| {
                    !cursor.exhausted && cursor.dispatched_round == round
                }));
                if can_advance && vector.budget.remaining() > 0 && round < 5 {
                    round += 1;
                    continue;
                }
                if embedding.is_none() {
                    if can_advance { vector.stop_scans("candidate_limit"); }
                    break;
                }
            }
            // 等任一事件，不等完整通道/轮。接到的结果回填，下轮先吸收所有就绪结果。
            tokio::select! {
                event = events.join_next(), if !events.is_empty() => {
                    if let Some(event) = event {
                        let event = event.map_err(|error| Error::new("unavailable").with_message(format!("search task: {error}")))?;
                        pending_events.push_back(event);
                    }
                }
                result = async { embedding.as_mut().expect("pending embedding").await }, if embedding.is_some() => {
                    embedding = None;
                    match result.map_err(|error| Error::new("unavailable").with_message(format!("embedding task: {error}")))? {
                        Ok(query_vector) => {
                            vector.dense_vector = query_vector;
                            if vector.dense_vector.is_none() { vector.mark_embedding_unavailable(); }
                        }
                        Err(error) => { embedding_error = Some(error); break; }
                    }
                }
                _ = tokio::time::sleep_until(deadline) => { reads.deadline_capped = true; break; }
            }
        }
        Ok(())
    }.await;
    // 错误与期限出口仍等待已发Embedding的原结算；只读页亦接回释放预留。
    let mut completion_error = None;
    loop {
        let event = if let Some(event) = pending_events.pop_front() {
            Some(Ok(event))
        } else {
            events.join_next().await
        };
        let Some(event) = event else {
            break;
        };
        match event {
            Ok(SearchEvent::Page(page)) => vector.accept_page(page),
            Ok(SearchEvent::Sql {
                source,
                reserved,
                result,
            }) => match sql[source].accept(&mut vector.budget, reserved, result) {
                Ok(deadline_capped) => reads.deadline_capped |= deadline_capped,
                Err(error) => {
                    completion_error.get_or_insert(error);
                }
            },
            Ok(SearchEvent::Target(result)) => match result {
                Ok(target) => {
                    if target_expected
                        .as_ref()
                        .is_some_and(|expected| expected.as_ref() != Some(&target))
                    {
                        completion_error.get_or_insert_with(|| Error::new("stale_cursor"));
                    }
                    vector.target = Some(target);
                }
                Err(error) if target_expected.is_some() => {
                    completion_error.get_or_insert(error);
                }
                Err(_) => (),
            },
            Err(error) => {
                completion_error.get_or_insert_with(|| {
                    Error::new("unavailable").with_message(format!("search task: {error}"))
                });
            }
        }
    }
    let settlement = if let Some(handle) = embedding {
        handle.await.map_err(|error| {
            Error::new("unavailable").with_message(format!("embedding task: {error}"))
        })?
    } else {
        Ok(None)
    };
    settlement?;
    if let Some(error) = completion_error {
        return Err(error);
    }
    if let Some(error) = embedding_error {
        return Err(error);
    }
    outcome?;
    // 快速Embedding失败也可能使bookmark无路可派；不能空成功重传原游标。
    if resume.is_some()
        && reads.objects.is_empty()
        && reads.raw.is_empty()
        && (vector.budget.rounds() == 0 || (restored_window && reads.deadline_capped))
    {
        return Err(Error::new("unavailable"));
    }
    // 元信息跨期或出口才接回的候选只保留定位，后续正常重核前不能当作可交付命中。
    let sql_lexical = retrieval::merge_sql_lexical(sql[0].hits.clone(), sql[1].hits.clone());
    reads.unverified = ordered_candidates_with(&sql_lexical, vector)
        .into_iter()
        .filter(|candidate| {
            let key = format!("k:{}", retrieval::knowledge_record(candidate));
            !evaluated.contains(&key)
                && !resume
                    .as_ref()
                    .is_some_and(|saved| restored_window && saved.suppresses(&key))
        })
        .collect();
    for candidate in vector.raw.lexical.iter().chain(&vector.raw.dense) {
        let key = format!(
            "raw:{}",
            retrieval::raw_record(candidate).expect("validated raw candidate")
        );
        if !resume
            .as_ref()
            .is_some_and(|saved| restored_window && saved.suppresses(&key))
            && evaluated.insert(key)
        {
            reads.unverified.push(candidate.clone());
        }
    }
    if reads.deadline_capped {
        vector.stop_scans("deadline");
    }
    vector.bounded |= reads.deadline_capped || (!terms.complete && window_sql_active);
    vector.refresh_progress();
    if sql.iter().any(|cursor| cursor.dispatched_round > 0) {
        vector.lexical_progress = retrieval::vector::ChannelProgress {
            rounds: sql
                .iter()
                .map(|cursor| cursor.dispatched_round)
                .max()
                .unwrap_or(0),
            shards: sql.len(),
            completed: sql.iter().filter(|cursor| cursor.succeeded).count(),
            exhausted: sql.iter().all(|cursor| cursor.exhausted),
            uncovered: if reads.deadline_capped {
                Some("deadline")
            } else if sql.iter().any(|cursor| !cursor.exhausted) {
                Some("candidate_limit")
            } else {
                None
            },
        };
    }
    let milvus = CHANNELS.into_iter().filter_map(|channel| {
        let cursor = vector.cursors.cursor(channel)?;
        let name = match channel {
            ScanChannel::Lexical => "lexical",
            ScanChannel::Dense => "dense",
            ScanChannel::RawLexical => "raw_lexical",
            ScanChannel::RawDense => "raw_dense",
        };
        Some((name.to_owned(), json!({
            "rounds":cursor.rounds,"stopped":cursor.stopped,
            "shards":cursor.shards.iter().map(|shard| json!({
                "consumed":shard.consumed,"round":shard.dispatched_round,
                "requested":shard.requested,"succeeded":shard.succeeded,
                "failed":shard.failed,"in_flight":shard.in_flight,
                "exhausted":shard.succeeded && !shard.failed && !shard.in_flight && !shard.full_page
            })).collect::<Vec<_>>()
        })))
    }).collect::<serde_json::Map<_, _>>();
    reads.scan_progress = json!({
        "rounds":vector.budget.rounds(),"main_reads":reads.spent,"milvus":milvus,
        "sql":sql.iter().enumerate().map(|(source,cursor)| json!({
            "owner":if source==0{"knowledge"}else{"retrieval"},
            "consumed":cursor.consumed,"round":cursor.dispatched_round,
            "requested":cursor.dispatched_round>0,"succeeded":cursor.succeeded,
            "exhausted":cursor.exhausted,"in_flight":cursor.in_flight
        })).collect::<Vec<_>>()
    });
    if include_raw {
        let mut continuation = if restored_window {
            resume.take().expect("restored window")
        } else {
            SearchContinuation::capture(vector, &[sql[0].hits.clone(), sql[1].hits.clone()], &[])?
        };
        continuation.scan = vector.snapshot_scan()?;
        continuation.sql = std::array::from_fn(|index| {
            (
                sql[index].consumed,
                sql[index].succeeded,
                sql[index].exhausted,
            )
        });
        let mut retired: Vec<_> = reads.failed.iter().cloned().collect();
        // 已判定无效的首次候选可以退休；出口才接回、尚未核验的引用继续保留。
        let ranked_keys: std::collections::HashSet<_> = reads
            .ranked
            .iter()
            .map(|row| format!("k:{}", retrieval::knowledge_record(row)))
            .collect();
        retired.extend(
            continuation
                .records
                .iter()
                .map(SavedCandidate::key)
                .filter(|key| {
                    !restored_window
                        && key.starts_with("k:")
                        && evaluated.contains(key)
                        && !ranked_keys.contains(key)
                }),
        );
        continuation.retire(retired.into_iter());
        reads.continuation = Some(continuation);
    }
    Ok((cache, reads))
}

// 锁外检索阶段（工具路径）：共享组合推进后，最终装配与资产目录在自己的短读事务
// 中完成，不持会话/运行锁；慢读取期间宿主心跳可正常续租，提交前由
// assert_search_fresh_in_tx 重核版本。
pub async fn search_stage_outside_lock(
    pool: &MySqlPool,
    ctx: &AccessContext,
    request: &mut ScopedSearchRequest<'_>,
) -> Result<ScopedSearchStage> {
    run_search_stage(pool, ctx, request, None).await
}

/// 用当前 scope/AllowedRecords 和边界已建立的 deadline 续取；游标不能授予访问权。
/// v2 的 asset_after 只推进个人资产目录，公共 cursor 独立恢复。
pub async fn restore_search_stage_outside_lock(
    pool: &MySqlPool,
    ctx: &AccessContext,
    request: &mut ScopedSearchRequest<'_>,
    continuation: SearchContinuation,
) -> Result<ScopedSearchStage> {
    let mut validation = Ok(());
    if !request.include_raw || request.query == "*" {
        validation = Err(Error::new("invalid_cursor"));
    }
    // 权限变化由本次解析的允许集约束；不使用游标内的旧范围。
    if let Some(allowed) = request.allowed {
        for record in &continuation.records {
            if continuation.suppresses(&record.key()) {
                continue;
            }
            let permitted = match record {
                SavedCandidate::Knowledge(id, ..) => allowed.knowledge_ids.contains(id),
                SavedCandidate::Raw(kind, id, ..) => allowed
                    .sources
                    .iter()
                    .any(|source| source.0 == *kind && source.1 == *id),
            };
            if !permitted {
                validation = Err(Error::new("stale_cursor"));
                break;
            }
        }
    }
    if let Err(error) = validation {
        if let Some(launch) = request.launch.take() {
            launch
                .embedding
                .await
                .map_err(|_| Error::new("unavailable"))??;
        }
        return Err(error);
    }
    run_search_stage(pool, ctx, request, Some(continuation)).await
}

async fn run_search_stage(
    pool: &MySqlPool,
    ctx: &AccessContext,
    request: &mut ScopedSearchRequest<'_>,
    continuation: Option<SearchContinuation>,
) -> Result<ScopedSearchStage> {
    let mut reads =
        if request.query == "*" || (!request.include_raw && request.asset_after.is_some()) {
            StageReads {
                scan_progress: json!({"rounds":0,"main_reads":0,"milvus":{},"sql":[]}),
                ..StageReads::default()
            }
        } else {
            drive_stage(
                pool,
                ctx,
                request.query,
                request.limit,
                request.launch.take(),
                &mut request.vector,
                request.scope,
                request.allowed,
                request.include_raw,
                request.hints,
                continuation,
            )
            .await?
            .1
        };
    let search = assemble_search_in_tx(
        pool,
        ctx,
        request.query,
        request.limit,
        &request.vector,
        request.scope,
        request.allowed,
        &mut reads,
    )
    .await?;
    // 覆盖核验已自带一次性事务；资产/记忆读取在装配完成后另起短事务，
    // 不与装配前的任何查询共用连接。
    let mut tx = AppTx::begin(pool).await?;
    let memories = crate::modules::assets::list_in_tx(&mut tx, ctx, true)
        .await?
        .into_iter()
        .filter(|v| v["kind"] == "memory")
        .collect();
    let mut items =
        valid_assets_in_tx(&mut tx, ctx, memories, request.cid, request.text_results).await?;
    let selected = crate::modules::assets::selected_in_tx(&mut tx, ctx, request.cid).await?;
    items.extend(
        valid_assets_in_tx(&mut tx, ctx, selected, request.cid, request.text_results).await?,
    );
    let page = retrieval::asset_directory(
        items.clone(),
        request.query,
        request.asset_after,
        request.limit,
    );
    tx.commit().await?;
    Ok(ScopedSearchStage {
        search,
        items,
        page,
    })
}

// 提交前重核：检索命中的对象、其结构依赖和目录资产仍为当前有效版本且来源未变。
// 锁外期间发生更新或撤权时拒绝交付，不让一份回执混入两个时刻的正文。
pub async fn assert_search_fresh_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    stage: &ScopedSearchStage,
) -> Result<()> {
    let mut object_ids = Vec::new();
    for object in &stage.search.objects {
        object_ids.push(
            object["id"]
                .as_str()
                .ok_or(Error::new("invalid_input"))?
                .to_owned(),
        );
    }
    object_ids.sort();
    object_ids.dedup();
    let current = knowledge::current_versions_in_tx(tx, ctx, &object_ids).await?;
    for object in &stage.search.objects {
        let id = object["id"].as_str().ok_or(Error::new("invalid_input"))?;
        let version = object["version"].as_str().unwrap_or("");
        if !current
            .get(&(id.to_owned(), version.to_owned()))
            .copied()
            .unwrap_or(false)
        {
            return Err(Error::new("stale_knowledge"));
        }
        if let Some(dependencies) = object.get("structure_dependencies") {
            // 依赖对象版本未变时，其原文仍可能已更新；复用含传递来源的校验。
            check_refs_in_tx(tx, ctx, dependencies).await?;
        }
        if let Some(dependencies) = object.get("statement_dependencies") {
            check_refs_in_tx(tx, ctx, dependencies).await?;
        }
        assert_source_in_tx(tx, ctx, object).await?;
    }
    for hit in &stage.search.hits {
        if let SearchHit::SourceExcerpt { content, .. } = hit {
            let citation = &content["citation"];
            let id = citation["source"]["id"]
                .as_str()
                .ok_or(Error::new("invalid_input"))?;
            let source = if citation["source"]["kind"] == "document" {
                format!("document-{id}")
            } else {
                id.to_owned()
            };
            let current = super::knowledge_sources::read_meta_in_tx(tx, ctx, &source, None).await?;
            if current["version"] != citation["revision"] {
                return Err(Error::new("stale_source"));
            }
        }
    }
    let asset_ids = stage
        .items
        .iter()
        .filter_map(|asset| asset["id"].as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    let assets = crate::modules::assets::current_versions_in_tx(tx, ctx, &asset_ids).await?;
    for asset in &stage.items {
        let id = asset["id"].as_str().ok_or(Error::new("invalid_input"))?;
        let version = asset["version"].as_str().unwrap_or("");
        if !assets
            .get(&(id.to_owned(), version.to_owned()))
            .copied()
            .unwrap_or(false)
        {
            return Err(Error::new("stale_knowledge"));
        }
    }
    Ok(())
}

// v1只在末端按对象聚合；每个规范内容仍独立占候选/主读取名额并保留在hits中。
fn aggregate_search_objects(contents: Vec<Value>) -> Vec<Value> {
    let mut objects: Vec<Value> = Vec::new();
    for content in contents {
        let Some(object) = objects.iter_mut().find(|object| {
            object["id"] == content["id"] && object["version"] == content["version"]
        }) else {
            objects.push(content);
            continue;
        };
        for entry in content["entries"].as_array().into_iter().flatten() {
            let entries = object["entries"].as_array_mut().expect("knowledge entries");
            if !entries
                .iter()
                .any(|seen| seen["entry_id"] == entry["entry_id"])
            {
                entries.push(entry.clone());
            }
        }
        for key in [
            "required_sources",
            "structure_dependencies",
            "statement_dependencies",
        ] {
            for reference in content[key].as_array().into_iter().flatten() {
                if object[key].is_null() {
                    object[key] = json!([]);
                }
                let references = object[key].as_array_mut().expect("dependency references");
                if !references.contains(reference) {
                    references.push(reference.clone());
                }
            }
        }
        for excerpt in content["retrieval"]["excerpts"]
            .as_array()
            .into_iter()
            .flatten()
        {
            let excerpts = object["retrieval"]["excerpts"]
                .as_array_mut()
                .expect("located excerpts");
            if !excerpts.contains(excerpt) && excerpts.len() < 3 {
                excerpts.push(excerpt.clone());
            }
        }
    }
    objects
}

#[allow(clippy::too_many_arguments)]
async fn assemble_search_in_tx(
    pool: &MySqlPool,
    ctx: &AccessContext,
    query: &str,
    limit: usize,
    vector: &retrieval::vector::Candidates,
    scope: &KnowledgeSearchScope,
    allowed: Option<&retrieval::vector::AllowedRecords>,
    reads: &mut StageReads,
) -> Result<KnowledgeSearch> {
    let allowed_ids = allowed.map(|records| records.knowledge_ids.as_slice());
    let terms = retrieval::candidate_terms(query);
    // R12与推进侧同一事实源：SQL截词只在SQL实际参与当前候选窗时限制覆盖。
    // 装配侧取BM25词法失败/未配置置位的sql_lexical_active，或恢复窗快照的
    // sql_active（续页未重新发SQL也保持该限制）。
    let window_sql_active = vector.sql_lexical_active()
        || reads
            .continuation
            .as_ref()
            .is_some_and(|saved| saved.sql_active);
    let mut hits = Vec::new();
    let mut pending = Vec::new();
    for (score, key) in &reads.sequence {
        if hits.len() < limit {
            if let Some(content) = reads.objects.get(key) {
                hits.push(SearchHit::Knowledge {
                    record: key.clone(),
                    score: *score,
                    content: content.clone(),
                });
                continue;
            }
            if let Some(content) = reads.raw.get(key) {
                hits.push(SearchHit::SourceExcerpt {
                    records: vec![key.clone()],
                    score: *score,
                    content: content.clone(),
                });
                continue;
            }
        }
        if !reads.failed.contains(key) {
            if let Some(candidate) = reads
                .ranked
                .iter()
                .find(|candidate| format!("k:{}", retrieval::knowledge_record(candidate)) == *key)
            {
                pending.push(candidate.clone());
            } else if let Some(candidate) = vector
                .raw
                .lexical
                .iter()
                .chain(vector.raw.dense.iter())
                .find(|candidate| {
                    retrieval::raw_record(candidate)
                        .is_some_and(|record| format!("raw:{record}") == *key)
                })
            {
                pending.push(candidate.clone());
            }
        }
    }
    pending.append(&mut reads.unverified);
    // 只合并已经按共同名次选中且完成owner核验的窗口；成员身份与读取占额不退款。
    let mut merged: Vec<SearchHit> = Vec::new();
    for hit in hits {
        if let SearchHit::SourceExcerpt {
            records,
            score,
            content,
        } = hit
        {
            let start = content["citation"]["locator"]["offset"]
                .as_u64()
                .expect("verified raw offset");
            let end = start
                + content["citation"]["locator"]["length"]
                    .as_u64()
                    .expect("verified raw length");
            if let Some(SearchHit::SourceExcerpt {
                records: previous_records,
                score: previous_score,
                content: previous,
            }) = merged.iter_mut().find(|hit| {
                let SearchHit::SourceExcerpt {
                    content: previous, ..
                } = hit
                else {
                    return false;
                };
                let previous_start = previous["citation"]["locator"]["offset"]
                    .as_u64()
                    .expect("verified raw offset");
                let previous_end = previous_start
                    + previous["citation"]["locator"]["length"]
                        .as_u64()
                        .expect("verified raw length");
                previous["citation"]["source"] == content["citation"]["source"]
                    && previous["citation"]["revision"] == content["citation"]["revision"]
                    && start <= previous_end
                    && previous_start <= end
                    && end.max(previous_end) - start.min(previous_start) <= 2400
            }) {
                let previous_start = previous["citation"]["locator"]["offset"].as_u64().unwrap();
                let previous_end =
                    previous_start + previous["citation"]["locator"]["length"].as_u64().unwrap();
                let text = if start < previous_start {
                    content["text"]
                        .as_str()
                        .unwrap()
                        .chars()
                        .take((previous_start - start) as usize)
                        .chain(previous["text"].as_str().unwrap().chars())
                        .chain(
                            content["text"]
                                .as_str()
                                .unwrap()
                                .chars()
                                .skip((previous_end - start) as usize),
                        )
                        .collect::<String>()
                } else {
                    previous["text"]
                        .as_str()
                        .unwrap()
                        .chars()
                        .chain(
                            content["text"]
                                .as_str()
                                .unwrap()
                                .chars()
                                .skip((previous_end - start) as usize),
                        )
                        .collect::<String>()
                };
                previous["text"] = json!(text);
                previous["citation"]["locator"] = json!({"offset":start.min(previous_start),"length":end.max(previous_end) - start.min(previous_start)});
                *previous_score = previous_score.max(score);
                previous["score"] = json!(previous_score);
                previous_records.extend(records);
            } else {
                merged.push(SearchHit::SourceExcerpt {
                    records,
                    score,
                    content,
                });
            }
        } else {
            merged.push(hit);
        }
    }
    let hits = merged;
    let contents = hits
        .iter()
        .filter_map(|hit| match hit {
            SearchHit::Knowledge { content, .. } => Some(content.clone()),
            SearchHit::SourceExcerpt { .. } => None,
        })
        .collect();
    let objects = aggregate_search_objects(contents);
    let target = vector.target.as_deref().unwrap_or("unavailable");
    // R13：已证滞后与未核完分开记录。index_state 保持公开枚举；只有真实查到
    // 旧投影/漏索引才置index_lag，期限耗尽/读取超时只标记检查未完成并保留
    // deadline事实，不能反推滞后。
    let mut index_lag = false;
    let mut index_check_incomplete = false;
    let mut index_state = if vector.state == "unconfigured" {
        "unconfigured"
    } else if tokio::time::Instant::now() >= vector.deadline {
        reads.deadline_capped = true;
        index_check_incomplete = true;
        "incomplete"
    } else {
        // R13期限安全：覆盖核验用一次性短事务。查询在期限内未返回时整个事务
        // 被丢弃（连接按损坏由池回收重建）；若沿用调用方事务，被取消查询的
        // 未读响应会让该事务的后续操作无限期等待，请求超出整体期限。
        match tokio::time::timeout_at(vector.deadline, async {
            let mut coverage_tx = AppTx::begin(pool).await?;
            let state =
                knowledge::index_coverage_in_tx(&mut coverage_tx, ctx, target, scope, allowed_ids)
                    .await?;
            coverage_tx.commit().await?;
            Ok::<_, Error>(state)
        })
        .await
        {
            Ok(state) => {
                let state = state?;
                if state == "incomplete" {
                    index_lag = true;
                }
                state
            }
            Err(_) => {
                reads.deadline_capped = true;
                index_check_incomplete = true;
                "incomplete"
            }
        }
    };
    if index_state == "current" && tokio::time::Instant::now() >= vector.deadline {
        index_state = "incomplete";
        reads.deadline_capped = true;
        index_check_incomplete = true;
    }
    if index_state == "current" && vector.cursors.raw_lexical.is_some() {
        // 同上：raw覆盖核验也用一次性短事务，期限截断不污染任何外层事务。
        let raw_coverage = tokio::time::timeout_at(vector.deadline, async {
            let mut coverage_tx = AppTx::begin(pool).await?;
            let resolved;
            let records = if let Some(allowed) = allowed {
                allowed
            } else {
                resolved =
                    super::source_limits::allowed_records_in_tx(&mut coverage_tx, ctx, None, scope)
                        .await?;
                &resolved
            };
            let documents = records
                .sources
                .iter()
                .filter(|(kind, _)| kind == "document")
                .map(|(_, id)| id.clone())
                .collect::<Vec<_>>();
            let platform = records
                .sources
                .iter()
                .filter(|(kind, _)| kind == "platform")
                .map(|(_, id)| id.clone())
                .collect::<Vec<_>>();
            let mut sources = Vec::new();
            for chunk in documents.chunks(50) {
                for meta in
                    knowledge::candidate_meta_in_tx(&mut coverage_tx, ctx, chunk, None).await?
                {
                    if meta["kind"] == "document" && meta["state"] == "enabled" {
                        sources.push((
                            "document".to_owned(),
                            meta["id"].as_str().unwrap().to_owned(),
                            epoch(meta["version"].as_str().unwrap_or(""))?,
                        ));
                    }
                }
            }
            sources.extend(
                ingestion::source_versions_in_tx(&mut coverage_tx, &ctx.space_id, &platform)
                    .await?
                    .into_iter()
                    .map(|(id, version)| ("platform".to_owned(), id, version)),
            );
            if sources.len() != records.sources.len() {
                return Ok::<_, Error>(false);
            }
            let states = retrieval::source_projection_states_in_tx(
                &mut coverage_tx,
                &ctx.space_id,
                &sources,
                target,
            )
            .await?;
            coverage_tx.commit().await?;
            Ok(states.into_iter().all(|current| current))
        })
        .await;
        match raw_coverage {
            Ok(current) => {
                if !current? {
                    index_state = "incomplete";
                    index_lag = true;
                }
            }
            Err(_) => {
                index_state = "incomplete";
                reads.deadline_capped = true;
                index_check_incomplete = true;
            }
        }
    }
    let progress = |p: &retrieval::vector::ChannelProgress| json!({"rounds":p.rounds,"shards":p.shards,"completed":p.completed,"exhausted":p.exhausted,"uncovered":p.uncovered});
    let mut channels = json!({"lexical":progress(&vector.lexical_progress),"dense":progress(&vector.dense_progress)});
    if let Some(raw) = &vector.raw_progress {
        channels["raw"] = progress(raw);
    }
    let read_budget_hit = reads.spent >= 30 && (hits.len() < limit || !pending.is_empty());
    reads.scan_progress["deadline"] = json!(reads.deadline_capped);
    // exact是已核验候选的精确优先步骤；成功空集无需匹配，目录入口不做公共检索。
    reads.scan_progress["exact"] = json!(if query == "*" {
        "not_configured"
    } else if reads.exact_checked || (!reads.deadline_capped && vector.budget.count() == 0) {
        "available"
    } else {
        "unavailable"
    });
    Ok(KnowledgeSearch {
        objects,
        hits,
        pending,
        continuation: reads.continuation.take(),
        scan_progress: std::mem::take(&mut reads.scan_progress),
        coverage: json!({"state":if read_budget_hit{"bounded"}else if vector.quota_limited(){"candidate_limit"}else if (!terms.complete&&window_sql_active)||vector.bounded||index_lag||reads.deadline_capped||!reads.failed.is_empty(){"bounded"}else{"complete"},"candidate_limit":1000,"candidate_count":vector.budget.count(),"query_terms_complete":terms.complete,"vector_state":vector.state,"index_state":index_state,"index_lag":index_lag,"index_check_incomplete":index_check_incomplete,"channels":channels,"scope_applied":!scope.kinds.is_empty()||scope.anchor.is_some()||scope.domain.is_some()}),
    })
}

#[cfg(test)]
mod window_lifetime_tests {
    use super::*;

    fn scan_with_pending_shard() -> retrieval::vector::ScanSnapshot {
        serde_json::from_value(json!({
            "i": {"target": null, "projection": crate::types::KNOWLEDGE_PROJECTION,
                  "segmentation": source_segments::SEGMENTATION_VERSION},
            "c": [null, {"b": "0".repeat(64), "s": [[0, 0]]}, null, null]
        }))
        .expect("scan snapshot")
    }
    fn knowledge_candidate(sequence: usize) -> SavedCandidate {
        SavedCandidate::Knowledge(
            format!("obj-{sequence}"),
            "1".into(),
            format!("record-{sequence}"),
            vec![SavedLocation {
                entry_id: Some("body".into()),
                path: Some("body".into()),
                statement_id: None,
                statement_offset: None,
                offset: Some(0),
                length: Some(8),
                content_hash: None,
            }],
        )
    }
    fn continuation_with(records: Vec<SavedCandidate>, retired: Vec<usize>) -> SearchContinuation {
        SearchContinuation {
            space: None,
            schema: 1,
            scan: scan_with_pending_shard(),
            records,
            channels: std::array::from_fn(|_| vec![]),
            sql: [(0, false, true); 2],
            retired,
            sql_active: false,
        }
    }

    // R07纯类型层：跨窗累计退休身份超过1000且仍有后窗时，旧全查询history累加在
    // 固定终点报tool_response_capacity；窗口生命周期语义须释放去重记录并继续编码。
    #[test]
    fn window_exhaustion_releases_dedup_beyond_1000_retirees() {
        let first: Vec<_> = (0..1000).map(knowledge_candidate).collect();
        let saved = continuation_with(first, (0..1000).collect());
        let encoded = saved
            .snapshot(&[], SEARCH_CURSOR_BYTES)
            .expect("首窗1000项全交付后仍须可编码游标")
            .expect("扫描仍有后窗");
        let restored = SearchContinuation::decode(&encoded).expect("释放后的游标可恢复");
        assert!(
            restored.records.is_empty() && restored.retired.is_empty(),
            "窗口耗尽即释放成员状态"
        );
        assert!(restored.scan.has_more());
        // 后继窗再交1000项：跨窗累计退休2000越过旧全局1000门，游标仍可推进。
        let mut next = restored;
        next.records = (1000..2000).map(knowledge_candidate).collect();
        next.retired = (0..1000).collect();
        let again = next
            .snapshot(&[], SEARCH_CURSOR_BYTES)
            .expect("后继窗耗尽仍须可编码")
            .expect("仍有后窗");
        assert!(
            SearchContinuation::decode(&again)
                .unwrap()
                .records
                .is_empty()
        );
    }

    // 旧cursor薄转换：本窗成员命中旧全查询去重记录时并入本窗retired，随后释放
    // 全查询history；不能直接清空导致当前窗旧抑制成员重新交付。
    #[test]
    fn legacy_cursor_history_joins_window_retired_then_releases() {
        let key = "k:record-0";
        let wire = json!({
            "v": 1,
            "s": {"i": {"target": null, "projection": crate::types::KNOWLEDGE_PROJECTION,
                        "segmentation": source_segments::SEGMENTATION_VERSION},
                  "c": [null, {"b": "0".repeat(64), "s": [[0, 0]]}, null, null]},
            "r": [
                {"k": ["obj-0", "1", "record-0", [{"e": "body", "p": "body", "o": 0, "l": 8}]]},
                {"k": ["obj-1", "1", "record-1", [{"e": "body", "p": "body", "o": 0, "l": 8}]]}
            ],
            "c": [[], [], [], [], []],
            "q": [[0, false, true], [0, false, true]],
            "d": [],
            "a": false,
            "h": [fingerprint(&json!(key))]
        });
        let encoded = serde_json::to_string(&wire).expect("旧形状可编码");
        let restored = SearchContinuation::decode(&encoded).expect("旧cursor薄转换");
        assert!(
            restored.suppresses(key),
            "命中旧history的本窗成员并入retired"
        );
        assert!(!restored.suppresses("k:record-1"));
        let cursor = restored
            .snapshot(&["k:record-1".to_string()], SEARCH_CURSOR_BYTES)
            .expect("释放后游标继续推进")
            .expect("仍有后窗");
        assert!(
            SearchContinuation::decode(&cursor)
                .unwrap()
                .records
                .is_empty()
        );
    }

    // 跨新窗允许同身份重现：已结束窗口不再抑制后续窗口候选；同窗内不重不漏
    // 仍由retired成员状态保证。
    #[test]
    fn released_window_does_not_suppress_later_window_members() {
        let first = continuation_with(vec![knowledge_candidate(0)], vec![0]);
        let encoded = first
            .snapshot(&[], SEARCH_CURSOR_BYTES)
            .expect("窗口耗尽可编码")
            .expect("仍有后窗");
        let mut later = SearchContinuation::decode(&encoded).unwrap();
        later.records = vec![knowledge_candidate(0)];
        assert!(
            !later.suppresses(&knowledge_candidate(0).key()),
            "跨窗重现不再被全查询history抑制"
        );
    }
}

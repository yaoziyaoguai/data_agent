use super::*;

pub(crate) async fn sync_catalog(pool: &MySqlPool, ctx: &AccessContext) -> Result<()> {
    // 空授权登记不授予维护权；单独提交，避免提前固定随后来源同步的旧快照。
    let mut registration = AppTx::begin(pool).await?;
    crate::use_cases::semantic_governance::register_catalog_in_tx(
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
    crate::use_cases::dependency_registration::after_content_saved_in_tx(tx, ctx, &seeded).await?;
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
            crate::use_cases::dependency_registration::after_content_saved_in_tx(
                tx,
                ctx,
                std::slice::from_ref(&updated),
            )
            .await?;
            let sources = sources_in_tx(tx, ctx).await?;
            crate::use_cases::prefill_materials::queue_in_tx(tx, ctx, &updated, sources).await?;
        }
    }
    transaction.commit().await
}
pub(super) async fn sources_in_tx(tx: &mut AppTx<'_>, ctx: &AccessContext) -> Result<Vec<Value>> {
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
pub(super) async fn current_catalog_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
) -> Result<Value> {
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
        ingestion::prefill::refresh_facts(object, &sources)?;
        ingestion::catalog::link_synthetic_documents(&ctx.space_id, object, &table_aliases);
    }
    Ok(catalog)
}

pub(in crate::use_cases) async fn semantic_object_in_tx(
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
            match checked_refs_in_tx(tx, ctx, &json!(dependencies), None, false).await {
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

use super::*;

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
                crate::use_cases::semantic_governance::register_object_in_tx(&mut tx, ctx, &v)
                    .await?;
            } else {
                access::register_creator_in_tx(&mut tx, ctx, v["id"].as_str().unwrap_or(""))
                    .await?;
            }
            v
        }
        "edit" => {
            contracts::validate("KnowledgeEdit", &input)?;
            let object = object.ok_or(Error::new("invalid_input"))?;
            apply_entry_edit_in_tx(&mut tx, ctx, object, &input).await?
        }
        "reanalyze" => {
            contracts::validate("VersionCommand", &input)?;
            let object = object.ok_or(Error::new("invalid_input"))?;
            if let Some(mut receipt) =
                knowledge::begin_reanalysis_in_tx(&mut tx, ctx, object, &input).await?
            {
                crate::use_cases::semantic_governance::decorate_in_tx(&mut tx, ctx, &mut receipt)
                    .await?;
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
            crate::use_cases::prefill_materials::queue_in_tx(&mut tx, ctx, &updated, sources)
                .await?;
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
    crate::use_cases::dependency_registration::after_content_saved_in_tx(
        &mut tx,
        ctx,
        &[v.clone()],
    )
    .await?;
    // 保存文档原文（创建或改版）即原子登记raw索引与语义准备；两作业互不等待。
    crate::use_cases::knowledge_documents::register_document_preparation_in_tx(
        &mut tx,
        &ctx.space_id,
        &v,
    )
    .await?;
    crate::use_cases::semantic_governance::decorate_in_tx(&mut tx, ctx, &mut v).await?;
    contracts::validate("KnowledgeObject", &v)?;
    if matches!(action, "enabled" | "disabled" | "deleted") {
        tx.notify(crate::live_changes::Change::Authority {
            space_id: ctx.space_id.clone(),
        });
    }
    tx.commit().await?;
    Ok(v)
}
// 单条条目保存的核心路径：回执幂等、结构/引用校验、clear_override 的来源基础值
// 回填，最后落库。edit 与 edit_entries 共用；input 须携带 operation_id 与
// expected_version。
async fn apply_entry_edit_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
    input: &Value,
) -> Result<Value> {
    if let Some(receipt) = knowledge::begin_edit_in_tx(tx, ctx, object, input).await? {
        return Ok(receipt);
    }
    let source_value = checked_edit_source_in_tx(tx, ctx, object, input).await?;
    knowledge::save_edit_in_tx(tx, ctx, object, input, source_value.as_deref()).await
}

async fn checked_edit_source_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
    input: &Value,
) -> Result<Option<String>> {
    if input["clear_override"] != true {
        check_input_structure_sources_in_tx(tx, ctx, input).await?;
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
            check_refs_in_tx(tx, ctx, &json!(references)).await?;
            let mut checked = std::collections::HashSet::new();
            for citation in citations {
                if checked.insert(fingerprint(&citation)) {
                    let citation = serde_json::from_value(citation)
                        .map_err(|_| Error::new("invalid_input"))?;
                    crate::use_cases::knowledge_sources::read_citation_in_tx(tx, ctx, citation)
                        .await?;
                }
            }
        }
    }
    let mut source_value = None;
    if input["clear_override"] == true {
        let old = knowledge::read_in_tx(tx, ctx, object, None, true).await?;
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
            assert_source_in_tx(tx, ctx, &old).await?;
            let candidate = if source.starts_with("catalog-") {
                ingestion::catalog_candidate_in_tx(tx, ctx, source, object).await?
            } else {
                let catalog = current_catalog_in_tx(tx, ctx).await?;
                catalog["objects"]
                    .as_array()
                    .and_then(|objects| objects.iter().find(|candidate| candidate["id"] == object))
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
    Ok(source_value)
}
// 表级批量保存：同一对象、同一事务、同一条乐观锁链。逐条 operation_id 由批次
// operation_id 加“-{序号}”派生，expected_version 自基准依次 +1；整批重放时逐条
// 命中各自回执（单事务要么全落要么全无，不存在半批状态）。跨模块登记、文档
// 准备与治理装饰在批末只执行一次，返回最新对象。
pub async fn edit_entries(
    pool: &MySqlPool,
    ctx: &AccessContext,
    object: &str,
    input: Value,
) -> Result<Value> {
    contracts::validate("KnowledgeEntryBatch", &input)?;
    let edits = input["edits"]
        .as_array()
        .ok_or(Error::new("invalid_input"))?;
    let operation = input["operation_id"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?;
    let base = epoch(input["expected_version"].as_str().unwrap_or(""))?;
    let mut tx = AppTx::begin(pool).await?;
    access::authorize_semantic_in_tx(&mut tx, ctx, object).await?;
    let mut v = Value::Null;
    for (index, edit) in edits.iter().enumerate() {
        let mut entry = edit.clone();
        entry["operation_id"] = json!(format!("{operation}-{index}"));
        entry["expected_version"] = json!((base + index as u64).to_string());
        v = apply_entry_edit_in_tx(&mut tx, ctx, object, &entry).await?;
    }
    crate::use_cases::dependency_registration::after_content_saved_in_tx(
        &mut tx,
        ctx,
        &[v.clone()],
    )
    .await?;
    crate::use_cases::knowledge_documents::register_document_preparation_in_tx(
        &mut tx,
        &ctx.space_id,
        &v,
    )
    .await?;
    crate::use_cases::semantic_governance::decorate_in_tx(&mut tx, ctx, &mut v).await?;
    contracts::validate("KnowledgeObject", &v)?;
    tx.commit().await?;
    Ok(v)
}

pub async fn edit_batch(
    pool: &MySqlPool,
    ctx: &AccessContext,
    mut input: contracts::generated::KnowledgeBatchEdit,
) -> Result<Value> {
    input.objects.sort_by(|a, b| a.object_id.cmp(&b.object_id));
    if input
        .objects
        .windows(2)
        .any(|pair| pair[0].object_id == pair[1].object_id)
    {
        return Err(Error::new("invalid_input"));
    }
    let command = json!({"action":"edit_batch","input":input});
    let mut tx = AppTx::begin(pool).await?;
    for group in &input.objects {
        access::authorize_semantic_in_tx(&mut tx, ctx, &group.object_id).await?;
    }
    if let Some(receipt) =
        knowledge::begin_entry_batch_in_tx(&mut tx, ctx, &input.operation_id, &command).await?
    {
        tx.commit().await?;
        return Ok(receipt);
    }
    let mut objects = knowledge::lock_entry_batch_in_tx(&mut tx, ctx, &input.objects).await?;
    let mut changed_paths = Vec::with_capacity(objects.len());
    for (object, group) in objects.iter_mut().zip(&input.objects) {
        let mut paths = Vec::with_capacity(group.edits.len());
        for edit in &group.edits {
            let edit = serde_json::to_value(edit).map_err(|_| Error::new("invalid_input"))?;
            let source_value =
                checked_edit_source_in_tx(&mut tx, ctx, &group.object_id, &edit).await?;
            paths.push(
                knowledge::apply_entry_in_tx(
                    &mut tx,
                    ctx,
                    object,
                    &edit,
                    &input.operation_id,
                    source_value.as_deref(),
                )
                .await?,
            );
        }
        changed_paths.push(paths);
    }
    knowledge::persist_entry_batch_in_tx(&mut tx, ctx, &mut objects, &changed_paths).await?;
    crate::use_cases::dependency_registration::after_content_saved_in_tx(&mut tx, ctx, &objects)
        .await?;
    for object in &mut objects {
        crate::use_cases::knowledge_documents::register_document_preparation_in_tx(
            &mut tx,
            &ctx.space_id,
            object,
        )
        .await?;
        crate::use_cases::semantic_governance::decorate_in_tx(&mut tx, ctx, object).await?;
    }
    let receipt = json!({"objects":objects});
    knowledge::record_entry_batch_in_tx(&mut tx, ctx, &input.operation_id, &command, &receipt)
        .await?;
    tx.commit().await?;
    Ok(receipt)
}

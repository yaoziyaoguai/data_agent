use super::*;

pub async fn check_refs_in_tx(tx: &mut AppTx<'_>, ctx: &AccessContext, refs: &Value) -> Result<()> {
    checked_refs_in_tx(tx, ctx, refs, None).await.map(|_| ())
}

pub(in crate::use_cases) async fn check_refs_for_task_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    refs: &Value,
    gate: Option<&crate::use_cases::source_limits::SourceGate>,
) -> Result<()> {
    checked_refs_in_tx(tx, ctx, refs, gate).await.map(|_| ())
}

pub(super) async fn current_structure_refs_in_tx(
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
        let source = crate::use_cases::knowledge_sources::read_in_tx(
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
pub(super) async fn checked_refs_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    refs: &Value,
    gate: Option<&crate::use_cases::source_limits::SourceGate>,
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
        crate::use_cases::knowledge_sources::assert_selected_in_tx(tx, ctx, &v, &path)
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

pub(super) async fn check_input_structure_sources_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    input: &Value,
) -> Result<()> {
    let object = json!({"entries":[{"effective_structure":input["structured_value"]}]});
    let dependencies = knowledge::structure_dependencies(&object);
    check_refs_in_tx(tx, ctx, &json!(dependencies)).await
}
pub async fn assert_source_in_tx(tx: &mut AppTx<'_>, ctx: &AccessContext, v: &Value) -> Result<()> {
    crate::use_cases::knowledge_sources::assert_in_tx(tx, ctx, v).await
}

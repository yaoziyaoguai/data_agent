use super::*;

pub(in crate::use_cases) async fn search_selected_sources_outside_lock(
    pool: &MySqlPool,
    ctx: &AccessContext,
    request: &ScopedSearchRequest<'_>,
    selection: &[crate::contracts::generated::SourceObjectSelection],
    gate: Option<&crate::use_cases::source_limits::SourceGate>,
    resume: Option<SearchContinuation>,
) -> Result<ScopedSearchStage> {
    let mut tx = AppTx::begin(pool).await?;
    let (candidates, versions, mut unlocated) = tokio::time::timeout_at(
        request.vector.deadline,
        crate::use_cases::knowledge_sources::selected_excerpt_candidates_in_tx(
            &mut tx,
            ctx,
            selection,
            request.scope,
            gate,
        ),
    )
    .await
    .map_err(|_| Error::new("unavailable"))??;
    let mut vector = retrieval::vector::Candidates::lexical();
    vector.space = Some(ctx.space_id.clone());
    // 仅借既有raw位置快照编码保存引用，不声称执行过BM25或dense。
    vector.raw.lexical = candidates.clone();
    let mut saved = if let Some(saved) = resume {
        for record in &saved.records {
            if saved.suppresses(&record.key()) {
                continue;
            }
            if !candidates.iter().any(|candidate| {
                SavedCandidate::capture(candidate, true).as_ref().ok() == Some(record)
            }) {
                return Err(Error::new("stale_cursor"));
            }
        }
        saved
    } else {
        SearchContinuation::capture(&vector, &[vec![], vec![]], &[])?
    };
    saved.sql_active = false;
    let mut hits = Vec::new();
    let mut pending = Vec::new();
    let mut failed = Vec::new();
    for record in &saved.records {
        let key = record.key();
        if saved.suppresses(&key) {
            continue;
        }
        let candidate = record.row(1.0);
        if hits.len() >= request.limit {
            pending.push(candidate);
            continue;
        }
        let reply = tokio::time::timeout_at(
            request.vector.deadline,
            crate::use_cases::knowledge_sources::recall_excerpts_in_tx(
                &mut tx,
                ctx,
                None,
                &[candidate],
            ),
        )
        .await
        .map_err(|_| Error::new("unavailable"))??;
        if let Some(content) = reply["hits"].as_array().and_then(|hits| hits.first()) {
            hits.push(SearchHit::SourceExcerpt {
                records: vec![key],
                score: 1.0,
                content: content.clone(),
            });
        } else {
            unlocated = true;
            failed.push(key);
        }
    }
    saved.retire(failed.into_iter());
    tx.commit().await?;
    let search = KnowledgeSearch {
        objects: vec![],
        hits,
        pending,
        coverage: json!({"state":if unlocated {"bounded"}else{"complete"},"index_lag":false}),
        scan_progress: json!({"exact":"available","milvus":{},"sql":[]}),
        continuation: Some(saved),
    };
    finish_search_stage(pool, ctx, request, search, versions).await
}

// 提交前重核：检索命中的对象、其结构依赖和目录资产仍为当前有效版本且来源未变。
// 锁外期间发生更新或撤权时拒绝交付，不让一份回执混入两个时刻的正文。
pub async fn assert_search_fresh_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    stage: &ScopedSearchStage,
) -> Result<()> {
    if !stage.source_selection_versions.is_empty() {
        let ids = stage
            .source_selection_versions
            .iter()
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        let current = knowledge::current_versions_in_tx(tx, ctx, &ids).await?;
        if stage
            .source_selection_versions
            .iter()
            .any(|reference| !current.get(reference).copied().unwrap_or(false))
        {
            return Err(Error::new("stale_knowledge"));
        }
    }
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
            let current =
                crate::use_cases::knowledge_sources::read_meta_in_tx(tx, ctx, &source, None)
                    .await?;
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

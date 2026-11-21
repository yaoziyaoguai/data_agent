use super::*;

// 锁外检索阶段：召回、语义对象与资产目录在自己的短读事务中完成，不持会话/运行锁。
// 慢读取期间宿主心跳可正常续租；提交前由 assert_search_fresh_in_tx 重核版本。
pub struct ScopedSearchStage {
    pub search: KnowledgeSearch,
    pub items: Vec<Value>,
    pub page: Value,
    pub(super) source_selection_versions: Vec<(String, String)>,
}

pub struct ScopedSearchRequest<'a> {
    pub query: &'a str,
    pub limit: usize,
    // 检索启动包（05切片4）：词法Milvus路与查询嵌入并行发出。锁外阶段在词法
    // 就绪后即开始核验与有界预读，嵌入就绪后执行dense首轮并入共同排序；None表
    // 示vector已是完整候选（等待路径组装或unconfigured占位）。
    pub launch: Option<crate::use_cases::knowledge_embeddings::SearchLaunch>,
    // 拥有向量候选（05切片3）：组合层在锁外按可交付候选驱动深度推进，游标与
    // 命中在推进中原位更新。
    pub vector: retrieval::vector::Candidates,
    pub scope: &'a KnowledgeSearchScope,
    pub allowed: Option<&'a retrieval::vector::AllowedRecords>,
    pub asset_after: Option<&'a str>,
    pub hints: Option<&'a crate::contracts::generated::Hints>,
    pub cid: &'a str,
    pub text_results: &'a crate::use_cases::context_authority::CheckedTextResults,
    pub include_raw: bool,
}

// 元信息核验的跨轮缓存（05切片3）：推进循环内每轮短事务只对新增候选查库，
// 同一对象同一边界不重复核验；最终装配复用同一份缓存。
#[derive(Default)]
pub struct VerdictCache {
    pub(super) meta: std::collections::HashMap<String, Option<Value>>,
    pub(super) complete: std::collections::HashSet<(String, u64)>,
    // 依赖索引游走判定结果（true=失效）：已判定对象跨轮不重复游走。
    pub(super) stale: std::collections::HashMap<String, bool>,
}

// 主命中按规范内容身份占额；同对象的不同条目和窗口分别读取，同位置跨通道复用。
#[derive(Default)]
pub struct StageReads {
    pub(super) objects: std::collections::HashMap<String, Value>,
    pub(super) failed: std::collections::HashSet<String>,
    pub(super) spent: usize,
    pub(super) ranked: Vec<Value>,
    pub(super) raw: std::collections::HashMap<String, Value>,
    pub(super) sequence: Vec<(f64, String)>,
    pub(super) unverified: Vec<Value>,
    pub(super) deadline_capped: bool,
    pub(super) exact_checked: bool,
    pub(super) scan_progress: Value,
    pub(super) continuation: Option<SearchContinuation>,
}

// 选中项的定点窄读、来源修订核验与语义装配（05切片4）：预读与最终装配共用同一
// 链路；候选级失效（对象换代/来源不可读）返回None按无效候选跳过并占名额，基础
// 设施错误整体传播。窄读按候选元信息版本钉住，范围已在候选SQL与allowed集上核过。
#[allow(clippy::too_many_arguments)]
pub(super) async fn load_selected_in_tx(
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
        let required = crate::use_cases::knowledge_sources::requirements(&object)?;
        let sources: Vec<_> = required.iter().map(|(source, _)| source.clone()).collect();
        let versions =
            match crate::use_cases::knowledge_sources::versions_in_tx(tx, ctx, &sources).await {
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
pub(super) fn ordered_candidates_with(
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
pub(super) async fn ranked_candidates_in_tx(
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
            crate::use_cases::dependency_validation::walk_required_in_tx(tx, &ctx.space_id, &roots)
                .await?;
        if verdict.stale.is_empty() {
            for root in &roots {
                cache.stale.insert(root.0.clone(), false);
            }
            continue;
        }
        // stale条目的owner可能是链路中间成员而非候选根；组内有stale时逐根
        // 定位归属，无stale的组无需逐根往返。
        for root in roots {
            let single = crate::use_cases::dependency_validation::walk_required_in_tx(
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

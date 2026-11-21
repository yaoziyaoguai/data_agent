use crate::{
    contracts::generated::{
        ContentState, SourceCitation, SourceExcerpt, SourceKeyKind, SourceReadReply,
    },
    modules::{ingestion, knowledge},
    persistence::AppTx,
    types::{AccessContext, Error, Result, epoch},
};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

// document-是M02文档的来源引用别名；正文和版本仍由M02管理。
pub fn document_id(source: &str) -> Option<&str> {
    source.strip_prefix("document-")
}

// 解析来源资源身份的当前头：document-前缀来源的正文与版本由文档对象持有
// （enabled头），平台来源在source_heads。返回(所属空间,当前版本)，作业据此
// 定位空间并判断修订新旧；来源不存在或已退休为None。
pub(super) async fn resolve_source_head_in_tx(
    tx: &mut AppTx<'_>,
    source_id: &str,
) -> Result<Option<(String, u64)>> {
    if let Some(document) = document_id(source_id) {
        return knowledge::enabled_head_in_tx(tx, document).await;
    }
    ingestion::source_head_in_tx(tx, source_id).await
}
pub fn document_source(document: &Value) -> Value {
    let body = document["entries"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| entry["effective_value"].as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    json!({"source_id":format!("document-{}",document["id"].as_str().unwrap_or("")),
        "version":document["version"],"current_version":document["version"],"body":body,"complete":!body.trim().is_empty()})
}

pub fn requirements(v: &Value) -> Result<Vec<(String, u64)>> {
    // 窄投影携带完整来源清单；不能从已裁小的正文重新推导必要来源。
    if let Some(sources) = v["required_sources"].as_array() {
        return sources
            .iter()
            .map(|source| {
                Ok((
                    source[0]
                        .as_str()
                        .ok_or(Error::new("invalid_evidence"))?
                        .to_owned(),
                    epoch(source[1].as_str().unwrap_or(""))?,
                ))
            })
            .collect();
    }
    let mut refs = std::collections::HashSet::new();
    if let Some(source) = v["source_id"].as_str() {
        refs.insert((
            source.to_owned(),
            epoch(v["source_version"].as_str().unwrap_or(""))?,
        ));
    }
    for entry in v["entries"].as_array().into_iter().flatten() {
        if let Some(source) = entry["source_facts"]["source_id"].as_str() {
            refs.insert((
                source.to_owned(),
                epoch(entry["source_facts"]["version"].as_str().unwrap_or(""))?,
            ));
        }
    }
    for entry in v["entries"].as_array().into_iter().flatten() {
        for evidence in entry["suggestion"]["evidence"]
            .as_array()
            .into_iter()
            .flatten()
            .chain(
                entry["suggestion"]["material_refs"]
                    .as_array()
                    .into_iter()
                    .flatten(),
            )
            .chain(
                entry["source_facts"]["structured_evidence"]
                    .as_array()
                    .into_iter()
                    .flatten(),
            )
        {
            let source = evidence["source_id"]
                .as_str()
                .ok_or(Error::new("invalid_evidence"))?;
            refs.insert((
                source.to_owned(),
                epoch(evidence["version"].as_str().unwrap_or(""))?,
            ));
        }
    }
    Ok(refs.into_iter().collect())
}

// 批量回源；文档的原始依赖也要有效，循环引用不能自证有效。
pub async fn versions_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    ids: &[String],
) -> Result<HashMap<String, u64>> {
    let mut pending = ids.to_vec();
    let mut seen = HashSet::new();
    let mut raw = Vec::new();
    let mut documents = Vec::new();
    while !pending.is_empty() {
        let mut document_ids = Vec::new();
        for source in std::mem::take(&mut pending) {
            if !seen.insert(source.clone()) {
                continue;
            }
            if let Some(id) = document_id(&source) {
                document_ids.push(id.to_owned());
            } else {
                raw.push(source);
            }
        }
        for document in knowledge::source_reference_objects_in_tx(tx, ctx, &document_ids).await? {
            if document["kind"] != "document" {
                continue;
            }
            let refs = requirements(&document)?;
            pending.extend(refs.iter().map(|(id, _)| id.clone()));
            documents.push((
                format!("document-{}", document["id"].as_str().unwrap_or("")),
                epoch(document["version"].as_str().unwrap_or(""))?,
                refs,
            ));
        }
    }
    let mut versions = ingestion::source_versions_in_tx(tx, &ctx.space_id, &raw).await?;
    loop {
        let previous = versions.len();
        for (id, version, refs) in &documents {
            if refs.iter().all(|(id, v)| versions.get(id) == Some(v)) {
                versions.insert(id.clone(), *version);
            }
        }
        if previous == versions.len() {
            break;
        }
    }
    Ok(versions)
}
pub async fn assert_in_tx(tx: &mut AppTx<'_>, ctx: &AccessContext, object: &Value) -> Result<()> {
    assert_selected_in_tx(tx, ctx, object, "").await
}

pub async fn assert_selected_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &Value,
    path: &str,
) -> Result<()> {
    let owner = object["id"].as_str().ok_or(Error::new("invalid_input"))?;
    let version = object["version"]
        .as_str()
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or(Error::new("invalid_input"))?;
    // 映射完备的对象以依赖索引游走为唯一判定：只核有效层，人工真正替换后的旧建议
    // 引用不再阻断（反例：人工四种编辑方式后来源变化，真正替换的有效值不被废弃建议
    // 阻断）。迁移前成果没有索引状态，沿用legacy正文判定，旧数据保持可校验。
    if !knowledge::dependency_index::mapping_complete_in_tx(tx, &(owner.to_owned(), version))
        .await?
    {
        let refs = requirements(object)?;
        let versions = versions_in_tx(
            tx,
            ctx,
            &refs.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>(),
        )
        .await?;
        if refs.iter().any(|(id, v)| versions.get(id) != Some(v)) {
            return Err(Error::new("stale_knowledge"));
        }
    }
    // 依赖索引传递核验：有效层陈述的引用与知识支持按登记修订逐层比对，下游对象
    // 依据失效立即报stale_knowledge，不等扇出作业。旧成果没有索引状态时按unknown
    // 处理，不硬失败；实际贡献根与权限门走contribution_roots查询。
    let verdict = super::dependency_validation::walk_selected_required_in_tx(
        tx,
        &ctx.space_id,
        &[knowledge::dependency_index::DependencySelection {
            object_id: owner.to_owned(),
            version,
            path: path.to_owned(),
        }],
    )
    .await?;
    if !verdict.stale.is_empty() {
        return Err(Error::new("stale_knowledge"));
    }
    Ok(())
}
pub async fn read_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    source: &str,
    version: Option<u64>,
) -> Result<Value> {
    if let Some(id) = document_id(source) {
        let document = knowledge::read_in_tx(tx, ctx, id, version, false).await?;
        if document["kind"] != "document" {
            return Err(Error::new("not_available"));
        }
        assert_in_tx(tx, ctx, &document).await?;
        Ok(document_source(&document))
    } else {
        let version = match version {
            Some(v) => v,
            None => ingestion::source_version_in_tx(tx, &ctx.space_id, source).await?,
        };
        ingestion::read_source_in_tx(tx, ctx, source, version).await
    }
}

// 历史核验的元信息读取：身份、修订与完整性足够判定，不装配任何正文。
// 文档来源照常做依赖核验——映射完备走依赖索引游走（同assert_in_tx后半段）；
// 迁移前legacy对象没有索引状态，窄读来源引用后沿用requirements校验。
pub async fn read_meta_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    source: &str,
    version: Option<u64>,
) -> Result<Value> {
    if let Some(id) = document_id(source) {
        let version = match version {
            Some(v) => v,
            None => knowledge::enabled_head_in_tx(tx, id)
                .await?
                .map(|(_, v)| v)
                .ok_or(Error::new("not_available"))?,
        };
        let meta = knowledge::read_meta_in_tx(tx, ctx, id, Some(version)).await?;
        if meta["kind"] != "document" {
            return Err(Error::new("not_available"));
        }
        if knowledge::dependency_index::mapping_complete_in_tx(tx, &(id.to_owned(), version))
            .await?
        {
            let verdict = super::dependency_validation::walk_required_in_tx(
                tx,
                &ctx.space_id,
                &[(id.to_owned(), version)],
            )
            .await?;
            if !verdict.stale.is_empty() {
                return Err(Error::new("stale_knowledge"));
            }
        } else {
            let document = knowledge::source_reference_objects_in_tx(tx, ctx, &[id.to_owned()])
                .await?
                .pop()
                .ok_or(Error::new("not_available"))?;
            if document["kind"] != "document" {
                return Err(Error::new("not_available"));
            }
            assert_in_tx(tx, ctx, &document).await?;
        }
        Ok(
            json!({"source_id":source,"name":meta["name"],"version":meta["version"],"current_version":meta["version"],"complete":meta["complete"]}),
        )
    } else {
        let version = match version {
            Some(v) => v,
            None => ingestion::source_version_in_tx(tx, &ctx.space_id, source).await?,
        };
        ingestion::read_source_meta_in_tx(tx, ctx, source, version).await
    }
}

// 快照/历史核验的批量元信息：平台来源走ingestion批量读取（当前头/当前正文
// 各一条IN查询）；文档来源含依赖核验游走，保持逐条read_meta_in_tx语义。
pub async fn read_metas_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    refs: &[(String, Option<u64>)],
) -> Result<HashMap<String, Value>> {
    let mut metas: HashMap<String, Value> = HashMap::new();
    let mut platform: Vec<(String, Option<u64>)> = vec![];
    let mut seen = HashSet::new();
    for (source, version) in refs {
        if !seen.insert(source) {
            continue;
        }
        if document_id(source).is_some() {
            metas.insert(
                source.clone(),
                read_meta_in_tx(tx, ctx, source, *version).await?,
            );
        } else {
            platform.push((source.clone(), *version));
        }
    }
    metas.extend(ingestion::read_source_metas_in_tx(tx, ctx, &platform).await?);
    Ok(metas)
}

pub async fn read_citation_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    citation: SourceCitation,
) -> Result<SourceExcerpt> {
    let (content, _) = read_citation_window_in_tx(tx, ctx, &citation, None).await?;
    Ok(SourceExcerpt { citation, content })
}

pub(super) async fn read_citation_page_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    citation: SourceCitation,
    limit: usize,
) -> Result<SourceReadReply> {
    let (text, source_length) = read_citation_window_in_tx(tx, ctx, &citation, Some(limit)).await?;
    let mut locator = citation.locator;
    let requested_length = locator.length;
    locator.length = text.chars().count() as i64;
    let next_locator = if locator.length < requested_length {
        let mut next = locator.clone();
        next.offset += locator.length;
        next.length = requested_length - locator.length;
        Some(next)
    } else {
        None
    };
    Ok(SourceReadReply {
        source: citation.source,
        revision: citation.revision,
        locator,
        source_length: source_length as i64,
        text,
        content_state: if next_locator.is_some() {
            ContentState::Partial
        } else {
            ContentState::Complete
        },
        next_locator,
    })
}

async fn read_citation_window_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    citation: &SourceCitation,
    limit: Option<usize>,
) -> Result<(String, usize)> {
    let offset =
        usize::try_from(citation.locator.offset).map_err(|_| Error::new("invalid_input"))?;
    let requested_length =
        usize::try_from(citation.locator.length).map_err(|_| Error::new("invalid_input"))?;
    let length = limit.map_or(requested_length, |limit| requested_length.min(limit));
    let source = match citation.source.kind {
        SourceKeyKind::Platform => citation.source.id.clone(),
        SourceKeyKind::Document => format!("document-{}", citation.source.id),
    };
    let (text, total_length) = if matches!(citation.source.kind, SourceKeyKind::Document) {
        let meta = read_meta_in_tx(tx, ctx, &source, None).await?;
        if meta["version"].as_str() != Some(&citation.revision) {
            return Err(Error::new("stale_source"));
        }
        let mut windowed = knowledge::read_document_windows_in_tx(
            tx,
            ctx,
            &citation.source.id,
            epoch(&citation.revision)?,
            &[(offset, length)],
        )
        .await?;
        if !windowed.complete {
            return Err(Error::new("not_available"));
        }
        (
            windowed.texts.remove(&(offset, length)).unwrap_or_default(),
            windowed.total_length,
        )
    } else {
        let version = ingestion::source_version_in_tx(tx, &ctx.space_id, &source).await?;
        // 旧全文入口仍可读取保留的快照；定点读只解释所绑定的当前修订。
        if version.to_string() != citation.revision {
            return Err(Error::new("stale_source"));
        }
        let windowed =
            ingestion::read_source_window_in_tx(tx, ctx, &source, version, &[(offset, length)])
                .await?;
        if windowed["complete"] != true {
            return Err(Error::new("not_available"));
        }
        (
            windowed["texts"][0][2].as_str().unwrap_or("").to_owned(),
            windowed["total_length"].as_u64().unwrap_or(0) as usize,
        )
    };
    // limit只缩小下行正文，不能把原请求越界伪装成合法短页。
    if offset
        .checked_add(requested_length)
        .is_none_or(|end| end > total_length)
    {
        let available_length = total_length.saturating_sub(offset);
        let valid_locator = if offset <= total_length && available_length > 0 {
            json!({"offset": offset, "length": available_length})
        } else {
            Value::Null
        };
        let hint = if available_length > 0 {
            format!(
                "请求区间超出当前版本原文总长（source_length={total_length}，从 offset={offset} 起最多可读取 available_length={available_length} 字符）；请将 citation.locator 调整为有效区间（可用 valid_locator）后重试，分页限制请用 limit。"
            )
        } else if offset == total_length {
            format!(
                "请求起点已到达当前版本原文末尾（source_length={total_length}，offset={offset}，available_length=0）；当前位置没有更多剩余字符。如需重读尾页或指定段落，请将 citation.locator 调回 [0, {total_length}] 内的有效区间。"
            )
        } else {
            format!(
                "请求起点超出当前版本原文总长（source_length={total_length}，offset={offset}，available_length=0）；请将 citation.locator.offset 调回 0 到 {total_length} 之间后重试。"
            )
        };
        return Err(Error::new("invalid_input").with_details(json!({
            "source": citation.source,
            "revision": citation.revision,
            "requested_locator": {"offset": offset, "length": requested_length},
            "source_length": total_length,
            "available_length": available_length,
            "valid_locator": valid_locator,
            "hint": hint,
        })));
    }
    Ok((text, total_length))
}

// 对象选择只定位其正式来源事实。先核源级许可、当前修订和完整性，才取quote；
// 不读取对象有效定义，也不将缺DDL等贡献根的对象提升为可采用知识。
pub(super) async fn selected_excerpt_candidates_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    selection: &[crate::contracts::generated::SourceObjectSelection],
    scope: &crate::search_scope::KnowledgeSearchScope,
    gate: Option<&super::source_limits::SourceGate>,
) -> Result<(Vec<Value>, Vec<(String, String)>, bool)> {
    let mut candidates = Vec::new();
    let mut versions = Vec::new();
    let mut unlocated = false;
    let mut seen = HashSet::new();
    for reference in selection {
        let facts = match knowledge::source_fact_refs_in_tx(tx, ctx, reference, scope).await {
            Ok(facts) => facts,
            Err(error) if matches!(error.code, "not_available" | "stale_knowledge") => {
                unlocated = true;
                continue;
            }
            Err(error) => return Err(error),
        };
        let mut located = false;
        for fact in facts {
            let Some(source) = fact["source_id"].as_str() else {
                continue;
            };
            if gate.is_some_and(|gate| !gate.allows_source_arg(source)) {
                continue;
            }
            let revision = fact["revision"].as_str().unwrap_or("");
            if fact["complete"] != true || fact["quote_chars"].as_u64().unwrap_or(0) == 0 {
                unlocated = true;
                continue;
            }
            let current = match read_meta_in_tx(tx, ctx, source, None).await {
                Ok(current) => current,
                Err(error)
                    if matches!(
                        error.code,
                        "not_available" | "stale_source" | "stale_knowledge"
                    ) =>
                {
                    unlocated = true;
                    continue;
                }
                Err(error) => return Err(error),
            };
            if current["version"] != revision || current["complete"] != true {
                unlocated = true;
                continue;
            }
            let quote = knowledge::read_source_fact_quote_in_tx(
                tx,
                ctx,
                reference,
                fact["entry_id"]
                    .as_str()
                    .ok_or(Error::new("invalid_evidence"))?,
            )
            .await?;
            let offset = if let Some(document) = document_id(source) {
                knowledge::locate_document_quote_in_tx(tx, ctx, document, epoch(revision)?, &quote)
                    .await?
            } else {
                ingestion::locate_source_quote_in_tx(tx, ctx, source, epoch(revision)?, &quote)
                    .await?
            };
            let Some(offset) = offset else {
                unlocated = true;
                continue;
            };
            located = true;
            let (kind, id) =
                document_id(source).map_or(("platform", source), |id| ("document", id));
            let chars: Vec<_> = quote.chars().collect();
            for (page, part) in chars.chunks(2400).enumerate() {
                let text: String = part.iter().collect();
                let candidate = json!({"source_kind":kind,"source_id":id,"revision":epoch(revision)?,
                    "offset":offset+page*2400,"length":part.len(),"content_hash":crate::types::fingerprint(&json!(text)),
                    "segmentation_version":crate::modules::retrieval::source_segments::SEGMENTATION_VERSION,"score":1.0});
                let key = crate::modules::retrieval::raw_record(&candidate)
                    .ok_or(Error::new("invalid_evidence"))?;
                if seen.insert(key) {
                    candidates.push(candidate);
                }
                if candidates.len() > 1000 {
                    return Err(Error::new("tool_response_capacity"));
                }
            }
        }
        // 有定位的对象仍参与版本复核，即使它只贡献了已去重的原文。
        if located {
            versions.push((reference.object_id.clone(), reference.version.clone()));
        } else {
            unlocated = true;
        }
    }
    Ok((candidates, versions, unlocated))
}

// 正式stage选中raw后调用的owner回源；来源门在召回前进入共同允许集。
// 独立调用携带limits时再按稳定来源身份核门；这里只读≤30个已选窗口，
// 核修订/hash后合并≤2400字符的相交范围，失效命中如实计为index_lag。
pub async fn recall_excerpts_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    limits: Option<&Value>,
    hits: &[Value],
) -> Result<Value> {
    let gate = match limits {
        Some(value) => Some(super::source_limits::gate_from_contract(value)?),
        None => None,
    };
    let mut allowed: Vec<&Value> = Vec::new();
    let mut filtered = 0usize;
    for hit in hits.iter().take(30) {
        let permitted = match gate.as_ref() {
            Some(gate) => gate.allows_source_arg(&source_arg_of(hit)?),
            None => true,
        };
        if permitted {
            allowed.push(hit);
        } else {
            filtered += 1;
        }
    }
    // 每来源批量读取当前修订的选中窗口，再核验和合并；不读取未命中的正文。
    let mut by_source: HashMap<(String, String), Vec<&Value>> = HashMap::new();
    for hit in &allowed {
        by_source
            .entry((
                hit["source_kind"].as_str().unwrap_or("").to_owned(),
                hit["source_id"].as_str().unwrap_or("").to_owned(),
            ))
            .or_default()
            .push(hit);
    }
    let mut lagged = 0usize;
    let mut delivered = Vec::new();
    for ((kind, id), group) in by_source {
        let mut ranges: Vec<(usize, usize)> = group
            .iter()
            .filter_map(|hit| {
                Some((
                    hit["offset"].as_u64()? as usize,
                    hit["length"].as_u64().unwrap_or(0) as usize,
                ))
            })
            .collect();
        ranges.sort_unstable();
        ranges.dedup();
        let (mut windows, window_lagged, revision, name) = if kind == "document" {
            let meta = match read_meta_in_tx(tx, ctx, &format!("document-{id}"), None).await {
                Ok(current) => current,
                Err(error)
                    if matches!(
                        error.code,
                        "not_available" | "stale_source" | "stale_knowledge"
                    ) =>
                {
                    // 确定失效的索引命中可舍弃；数据库故障保留原分类，不能冒充无资料。
                    lagged += group.len();
                    continue;
                }
                Err(error) => return Err(error),
            };
            let revision = meta["version"].as_str().unwrap_or("");
            let windowed =
                knowledge::read_document_windows_in_tx(tx, ctx, &id, epoch(revision)?, &ranges)
                    .await?;
            let (windows, window_lagged) = if windowed.complete {
                verify_and_merge_windows(
                    &group,
                    &windowed.texts,
                    windowed.total_length,
                    revision,
                    &kind,
                    &id,
                )?
            } else {
                (Vec::new(), group.len())
            };
            (
                windows,
                window_lagged,
                revision.to_owned(),
                meta["name"].clone(),
            )
        } else {
            // 平台来源定点读取（05接续C）：先钉当前修订，再按命中的字符窗口读回
            // 文本（utf8mb4下SUBSTRING按字符定位），不把整篇正文读入进程后裁剪。
            let version = match ingestion::source_version_in_tx(tx, &ctx.space_id, &id).await {
                Ok(version) => version,
                Err(error) if matches!(error.code, "not_available") => {
                    lagged += group.len();
                    continue;
                }
                Err(error) => return Err(error),
            };
            let windowed =
                match ingestion::read_source_window_in_tx(tx, ctx, &id, version, &ranges).await {
                    Ok(windowed) => windowed,
                    Err(error) if matches!(error.code, "not_available") => {
                        lagged += group.len();
                        continue;
                    }
                    Err(error) => return Err(error),
                };
            let revision = windowed["version"].as_str().unwrap_or("").to_owned();
            let texts: HashMap<(usize, usize), String> = windowed["texts"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|entry| {
                    Some((
                        (entry[0].as_u64()? as usize, entry[1].as_u64()? as usize),
                        entry[2].as_str()?.to_owned(),
                    ))
                })
                .collect();
            let total_length = windowed["total_length"].as_u64().unwrap_or(0) as usize;
            let (windows, window_lagged) = if windowed["complete"] == true {
                verify_and_merge_windows(&group, &texts, total_length, &revision, &kind, &id)?
            } else {
                (Vec::new(), group.len())
            };
            (windows, window_lagged, revision, windowed["name"].clone())
        };
        lagged += window_lagged;
        if !windows.is_empty() {
            let owner = if kind == "document" {
                json!({"kind":"document","id":id,"version":revision})
            } else {
                json!({"source_id":id,"source_version":revision})
            };
            let preparation = ingestion::preparation_record_status_in_tx(tx, ctx, &owner).await?;
            // 原文可读不代表已整理；complete只表示本次定位窗口已交齐。
            let semantic_status = preparation["state"].as_str().unwrap_or("pending");
            for window in &mut windows {
                window["name"] = name.clone();
                window["semantic_status"] = json!(semantic_status);
                window["content_state"] = json!("complete");
                window["support_state"] = json!("unknown");
            }
        }
        delivered.extend(windows);
    }
    // 按来源批读只减少I/O；交付仍按每个位置的融合分数排序。
    delivered.sort_by(|a, b| {
        b["score"]
            .as_f64()
            .unwrap_or(0.)
            .total_cmp(&a["score"].as_f64().unwrap_or(0.))
            .then_with(|| {
                a["citation"]["source"]["kind"]
                    .as_str()
                    .cmp(&b["citation"]["source"]["kind"].as_str())
            })
            .then_with(|| {
                a["citation"]["source"]["id"]
                    .as_str()
                    .cmp(&b["citation"]["source"]["id"].as_str())
            })
            .then_with(|| {
                a["citation"]["locator"]["offset"]
                    .as_u64()
                    .cmp(&b["citation"]["locator"]["offset"].as_u64())
            })
    });
    let state = if delivered.is_empty() {
        "unlocated"
    } else if lagged > 0 {
        "index_lag"
    } else {
        "located"
    };
    Ok(json!({
        "hits":delivered,
        "lagged":lagged,
        "filtered":filtered,
        "state":state,
    }))
}

fn source_arg_of(hit: &Value) -> Result<String> {
    let id = hit["source_id"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?;
    Ok(match hit["source_kind"].as_str() {
        Some("document") => format!("document-{id}"),
        _ => id.to_owned(),
    })
}

// 定点窗口核验（05接续C）：命中窗口文本由read_source_window_in_tx按字符定位读回，
// 核验与合并不需要整篇正文。逐命中核：修订一致且窗口文本hash相符才可用；然后按
// 相交合并，合并后长度≤2400（与切块MAX_CHARS同界），超限的相交窗口保持独立；
// 相交窗口的合并文本按成员定位偏移去重叠拼接，不重复不丢字。
pub(crate) fn verify_and_merge_windows(
    hits: &[&Value],
    texts: &HashMap<(usize, usize), String>,
    total_length: usize,
    revision: &str,
    kind: &str,
    id: &str,
) -> Result<(Vec<Value>, usize)> {
    const MERGE_CAP: usize = 2400;
    let mut verified: Vec<(usize, usize, f64)> = Vec::new();
    let mut lagged = 0usize;
    for hit in hits {
        let offset = hit["offset"].as_u64().unwrap_or(u64::MAX) as usize;
        let length = hit["length"].as_u64().unwrap_or(0) as usize;
        // 向量层回传的修订是数值，回源侧是数字字符串：两种形状都按同一数值比较。
        let revision_ok = hit["revision"]
            .as_u64()
            .is_some_and(|value| value.to_string() == revision)
            || hit["revision"].as_str() == Some(revision);
        let hash_ok = texts.get(&(offset, length)).is_some_and(|text| {
            !text.is_empty()
                && hit["content_hash"]
                    .as_str()
                    .is_some_and(|hash| *hash == crate::types::fingerprint(&json!(text)))
        });
        if !revision_ok
            || !hash_ok
            || !offset
                .checked_add(length)
                .is_some_and(|end| end <= total_length)
        {
            // 未读回、越界或hash不符的窗口：如实计滞后，不编造可回源片段。
            lagged += 1;
            continue;
        }
        verified.push((offset, offset + length, hit["score"].as_f64().unwrap_or(0.)));
    }
    verified.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    let mut merged: Vec<Value> = Vec::new();
    let mut pending: Option<(usize, usize, f64, String)> = None;
    for window @ (start, end, _) in verified {
        let text = texts
            .get(&(start, end - start))
            .cloned()
            .unwrap_or_default();
        match pending.take() {
            Some((p_start, p_end, p_score, p_text))
                if start <= p_end && end - p_start <= MERGE_CAP =>
            {
                // 相交拼接：新窗口文本去掉与前窗重叠的字符段再接上。
                let overlap = p_end.saturating_sub(start).min(text.chars().count());
                let tail: String = text.chars().skip(overlap).collect();
                pending = Some((
                    p_start,
                    end.max(p_end),
                    p_score.max(window.2),
                    format!("{p_text}{tail}"),
                ));
            }
            Some(closed) => {
                merged.push(window_of_text(closed, total_length, revision, kind, id));
                pending = Some((start, end, window.2, text));
            }
            None => pending = Some((start, end, window.2, text)),
        }
    }
    if let Some(window) = pending {
        merged.push(window_of_text(window, total_length, revision, kind, id));
    }
    Ok((merged, lagged))
}

fn window_of_text(
    (start, end, score, text): (usize, usize, f64, String),
    total_length: usize,
    revision: &str,
    kind: &str,
    id: &str,
) -> Value {
    json!({
        "citation":{
            "source":{"kind":kind,"id":id},
            "revision":revision,
            "locator":{"offset":start,"length":end - start}
        },
        "source_length":total_length,
        "text":text,
        "score":score,
    })
}

#[cfg(test)]
mod raw_recall_tests {
    use super::*;
    use serde_json::json;

    fn hit(
        kind: &str,
        source: &str,
        revision: u64,
        offset: usize,
        text: &str,
        score: f64,
    ) -> Value {
        json!({"id":format!("{source}-{offset}"),"source_kind":kind,"source_id":source,
            "revision":revision,"offset":offset,"length":text.chars().count(),
            "content_hash":crate::types::fingerprint(&json!(text)),"score":score})
    }

    fn slice(body: &[char], offset: usize, length: usize) -> String {
        body[offset..offset + length].iter().collect()
    }

    #[test]
    fn windows_merge_by_overlap_keep_distinct_positions_and_report_lag() {
        // 分区字符保证不同窗口的切片文本互不相同，hash核验才有区分力。
        let mut body: Vec<char> = "甲".repeat(60).chars().collect();
        body.extend("乙".repeat(140).chars());
        let text = |offset: usize, length: usize| slice(&body, offset, length);
        let hits = [
            hit("platform", "src", 4, 0, &text(0, 40), 0.03),
            hit("platform", "src", 4, 20, &text(20, 40), 0.02),
            hit("platform", "src", 4, 120, &text(120, 40), 0.01),
            // 修订过期：计滞后，不参与窗口。
            hit("platform", "src", 3, 0, &text(0, 40), 0.5),
            // hash不符（旧offset切新原文失败）：计滞后。
            hit("platform", "src", 4, 60, &text(30, 40), 0.4),
        ];
        let refs = hits.iter().collect::<Vec<_>>();
        let texts = [(0, 40), (20, 40), (120, 40), (60, 40)]
            .into_iter()
            .map(|range @ (offset, length)| (range, text(offset, length)))
            .collect();
        let (merged, lagged) =
            verify_and_merge_windows(&refs, &texts, body.len(), "4", "platform", "src").unwrap();
        assert_eq!(lagged, 2);
        assert_eq!(merged.len(), 2, "相交窗口合并，远端位置保持独立");
        assert_eq!(merged[0]["citation"]["locator"]["offset"], 0);
        assert_eq!(merged[0]["citation"]["locator"]["length"], 60);
        assert_eq!(merged[0]["citation"]["revision"], "4");
        assert_eq!(merged[0]["citation"]["source"]["id"], "src");
        assert_eq!(merged[0]["text"], text(0, 60));
        assert_eq!(merged[1]["citation"]["locator"]["offset"], 120);
    }

    #[test]
    fn merge_cap_keeps_overlapping_windows_separate_beyond_2400() {
        let body: Vec<char> = "据".repeat(4200).chars().collect();
        let text = |offset: usize, length: usize| slice(&body, offset, length);
        // 合并后2400：允许合并。
        let within = [
            hit("platform", "s", 1, 0, &text(0, 2000), 0.02),
            hit("platform", "s", 1, 1600, &text(1600, 800), 0.01),
        ];
        let refs = within.iter().collect::<Vec<_>>();
        let texts = [(0, 2000), (1600, 800), (1900, 2000)]
            .into_iter()
            .map(|range @ (offset, length)| (range, text(offset, length)))
            .collect();
        let (merged, lagged) =
            verify_and_merge_windows(&refs, &texts, body.len(), "1", "platform", "s").unwrap();
        assert_eq!((merged.len(), lagged), (1, 0));
        assert_eq!(merged[0]["citation"]["locator"]["length"], 2400);
        // 相交但合并后超上限：保持独立，不链式合并成全文。
        let beyond = [
            hit("platform", "s", 1, 0, &text(0, 2000), 0.02),
            hit("platform", "s", 1, 1900, &text(1900, 2000), 0.01),
        ];
        let refs = beyond.iter().collect::<Vec<_>>();
        let (merged, _) =
            verify_and_merge_windows(&refs, &texts, body.len(), "1", "platform", "s").unwrap();
        assert_eq!(merged.len(), 2);
        assert!(merged[0]["citation"]["locator"]["length"].as_u64().unwrap() <= 2400);
        assert!(merged[1]["citation"]["locator"]["length"].as_u64().unwrap() <= 2400);
    }

    // 05接续C：平台来源定点窗口核验——text来自按字符定位的窗口读回（不依赖整篇
    // 正文），相交窗口去重叠拼接不重复不丢字；修订/hash不符与未读回窗口计滞后。
    #[test]
    fn windowed_verify_merges_read_texts_without_full_body() {
        let mut body: Vec<char> = "甲".repeat(60).chars().collect();
        body.extend("乙".repeat(140).chars());
        let text = |offset: usize, length: usize| slice(&body, offset, length);
        let hits = [
            hit("platform", "src", 4, 0, &text(0, 40), 0.03),
            hit("platform", "src", 4, 20, &text(20, 40), 0.02),
            hit("platform", "src", 4, 120, &text(120, 40), 0.01),
            // 修订过期：计滞后。
            hit("platform", "src", 3, 0, &text(0, 40), 0.5),
            // hash不符：计滞后。
            hit("platform", "src", 4, 60, &text(30, 40), 0.4),
        ];
        // 读回的窗口文本：只包含实际请求的(offset,length)。
        let texts: HashMap<(usize, usize), String> =
            [(0usize, 40usize), (20, 40), (120, 40), (0, 40), (60, 40)]
                .into_iter()
                .map(|(offset, length)| ((offset, length), text(offset, length)))
                .collect();
        let refs = hits.iter().collect::<Vec<_>>();
        let (merged, lagged) =
            verify_and_merge_windows(&refs, &texts, body.len(), "4", "platform", "src").unwrap();
        assert_eq!(lagged, 2);
        assert_eq!(merged.len(), 2, "相交窗口合并，远端位置保持独立");
        assert_eq!(merged[0]["citation"]["locator"]["offset"], 0);
        assert_eq!(merged[0]["citation"]["locator"]["length"], 60);
        assert_eq!(
            merged[0]["text"],
            text(0, 60),
            "相交段去重叠拼接：不重复不丢字"
        );
        assert_eq!(
            merged[0]["source_length"],
            body.len() as u64,
            "总长度来自读回的长度列"
        );
        assert_eq!(merged[1]["citation"]["locator"]["offset"], 120);
        // 未读回的窗口（读侧缺该定位文本）：hash无从核验，计滞后不编造。
        let missing: HashMap<(usize, usize), String> = HashMap::new();
        let (merged, lagged) =
            verify_and_merge_windows(&refs, &missing, body.len(), "4", "platform", "src").unwrap();
        assert_eq!(lagged, hits.len());
        assert!(merged.is_empty());
    }

    #[test]
    fn truncated_source_window_cannot_validate_an_out_of_range_locator() {
        let mut indexed = hit("document", "short", 1, 1, "乙", 1.);
        indexed["length"] = json!(9);
        // SUBSTRING会在末尾截短；即使剩余文字的hash相符，也不能交付越界定位。
        let texts = HashMap::from([((1, 9), "乙".to_owned())]);
        let (merged, lagged) =
            verify_and_merge_windows(&[&indexed], &texts, 2, "1", "document", "short").unwrap();
        assert!(merged.is_empty());
        assert_eq!(lagged, 1);
    }
}

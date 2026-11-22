mod excerpts;
pub use excerpts::recall_excerpts_in_tx;
pub(super) use excerpts::selected_excerpt_candidates_in_tx;

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
            windowed.texts.remove(&(offset, length)),
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
            windowed["texts"][0][2].as_str().map(str::to_owned),
            usize::try_from(
                windowed["total_length"]
                    .as_u64()
                    .ok_or(Error::new("invalid_evidence"))?,
            )
            .map_err(|_| Error::new("invalid_evidence"))?,
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
    Ok((text.ok_or(Error::new("invalid_evidence"))?, total_length))
}

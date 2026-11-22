use super::*;

// 对象选择只定位其正式来源事实。先核源级许可、当前修订和完整性，才取quote；
// 不读取对象有效定义，也不将缺DDL等贡献根的对象提升为可采用知识。
pub(in crate::use_cases) async fn selected_excerpt_candidates_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    selection: &[crate::contracts::generated::SourceObjectSelection],
    scope: &crate::search_scope::KnowledgeSearchScope,
    gate: Option<&super::super::source_limits::SourceGate>,
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
        Some(value) => Some(super::super::source_limits::gate_from_contract(value)?),
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
fn verify_and_merge_windows(
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
            .ok_or(Error::new("unavailable"))?;
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
                pending = Some((start, end, window.2, text.clone()));
            }
            None => pending = Some((start, end, window.2, text.clone())),
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
#[path = "excerpts/tests.rs"]
mod tests;

use crate::{
    contracts::generated::{SourceCitation, SourceExcerpt, SourceKeyKind},
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
        for document in knowledge::current_objects_in_tx(tx, ctx, &document_ids).await? {
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
    let verdict = knowledge::dependency_index::walk_required_in_tx(
        tx,
        &ctx.space_id,
        &[(owner.to_owned(), version)],
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

pub async fn read_citation_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    citation: SourceCitation,
) -> Result<SourceExcerpt> {
    let source = match citation.source.kind {
        SourceKeyKind::Platform => citation.source.id.clone(),
        SourceKeyKind::Document => format!("document-{}", citation.source.id),
    };
    let current = read_in_tx(tx, ctx, &source, None).await?;
    // 旧全文入口仍可读取保留的快照；定点读只解释所绑定的当前修订。
    if current["version"].as_str() != Some(&citation.revision) {
        return Err(Error::new("stale_source"));
    }
    if current["complete"] != true {
        return Err(Error::new("not_available"));
    }
    let content = citation
        .locator
        .slice(
            current["body"]
                .as_str()
                .ok_or(Error::new("not_available"))?,
        )?
        .to_owned();
    Ok(SourceExcerpt { citation, content })
}

// 05切片3/8：raw摘录候选的确认与回源（06接入公开v2 hits）。门控在回源前按
// 来源身份成员判定执行（不查库；receipt只报过滤计数，不泄露受限名称）；选中
// 命中≤30才读正文，每来源只读一次当前修订；相交窗口有界合并≤2400，超限的
// 相交窗口保持独立，不能链式合并成全文；修订过期或hash不符的命中按index_lag
// 舍弃计数，不冒充当前原文。limits为本题声明的SourceLimits合同值；05由门控
// 集成测试驱动局部链路（索引→候选→回源），06在交付层接线。
#[cfg_attr(not(test), allow(dead_code))]
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
    // 每来源一次回源：读当前修订，窗口核验与合并都在该正文上进行。
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
    let mut groups: Vec<(Vec<Value>, f64)> = Vec::new();
    for ((kind, id), group) in by_source {
        let current = match read_in_tx(tx, ctx, &source_arg(&kind, &id), None).await {
            Ok(current) => current,
            Err(_) => {
                // 来源读不出（已退休/未完成）：这些命中无法回源核验，按滞后舍弃。
                lagged += group.len();
                continue;
            }
        };
        let revision = current["version"].as_str().unwrap_or("").to_owned();
        let body = current["body"].as_str().unwrap_or("").to_owned();
        let (windows, window_lagged) = if current["complete"] == true {
            verify_and_merge(&body, &group, &revision, &kind, &id)?
        } else {
            (Vec::new(), group.len())
        };
        lagged += window_lagged;
        let best = windows
            .first()
            .and_then(|w| w["score"].as_f64())
            .unwrap_or(0.);
        if !windows.is_empty() {
            groups.push((windows, best));
        }
    }
    groups.sort_by(|a, b| b.1.total_cmp(&a.1));
    let delivered: Vec<Value> = groups.into_iter().flat_map(|(w, _)| w).collect();
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

fn source_arg(kind: &str, id: &str) -> String {
    if kind == "document" {
        format!("document-{id}")
    } else {
        id.to_owned()
    }
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

// 逐窗口核验：修订一致且当前正文切片hash相符才可用；然后按相交合并，合并后
// 长度≤2400（与切块MAX_CHARS同界），超限的相交窗口保持独立。
pub(crate) fn verify_and_merge(
    body: &str,
    hits: &[&Value],
    revision: &str,
    kind: &str,
    id: &str,
) -> Result<(Vec<Value>, usize)> {
    const MERGE_CAP: usize = 2400;
    let chars: Vec<char> = body.chars().collect();
    let mut verified: Vec<(usize, usize, f64)> = Vec::new();
    let mut lagged = 0usize;
    for hit in hits {
        let offset = hit["offset"].as_u64().unwrap_or(u64::MAX) as usize;
        let length = hit["length"].as_u64().unwrap_or(0) as usize;
        let text: String = if offset.saturating_add(length) <= chars.len() {
            chars[offset..offset + length].iter().collect()
        } else {
            String::new()
        };
        let hash_ok = !text.is_empty()
            && hit["content_hash"]
                .as_str()
                .is_some_and(|hash| *hash == crate::types::fingerprint(&json!(text)));
        // 向量层回传的修订是数值，回源侧是数字字符串：两种形状都按同一数值比较。
        let revision_ok = hit["revision"]
            .as_u64()
            .is_some_and(|value| value.to_string() == revision)
            || hit["revision"].as_str() == Some(revision);
        if !revision_ok || !hash_ok {
            // 旧offset切不出新原文：如实计滞后，不编造可回源片段。
            lagged += 1;
            continue;
        }
        verified.push((offset, offset + length, hit["score"].as_f64().unwrap_or(0.)));
    }
    verified.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    let mut merged: Vec<Value> = Vec::new();
    let mut pending: Option<(usize, usize, f64)> = None;
    for window @ (start, end, _) in verified {
        match pending.take() {
            Some((p_start, p_end, p_score)) if start <= p_end && end - p_start <= MERGE_CAP => {
                pending = Some((p_start, end.max(p_end), p_score.max(window.2)));
            }
            Some(closed) => {
                merged.push(window_of(&chars, closed, revision, kind, id));
                pending = Some(window);
            }
            None => pending = Some(window),
        }
    }
    if let Some(window) = pending {
        merged.push(window_of(&chars, window, revision, kind, id));
    }
    Ok((merged, lagged))
}

fn window_of(
    chars: &[char],
    (start, end, score): (usize, usize, f64),
    revision: &str,
    kind: &str,
    id: &str,
) -> Value {
    let text: String = chars[start..end].iter().collect();
    json!({
        "citation":{
            "source":{"kind":kind,"id":id},
            "revision":revision,
            "locator":{"offset":start,"length":end - start}
        },
        "source_length":chars.len(),
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
        let (merged, lagged) = verify_and_merge(
            &body.iter().collect::<String>(),
            &refs,
            "4",
            "platform",
            "src",
        )
        .unwrap();
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
        let body_text = body.iter().collect::<String>();
        let (merged, lagged) = verify_and_merge(&body_text, &refs, "1", "platform", "s").unwrap();
        assert_eq!((merged.len(), lagged), (1, 0));
        assert_eq!(merged[0]["citation"]["locator"]["length"], 2400);
        // 相交但合并后超上限：保持独立，不链式合并成全文。
        let beyond = [
            hit("platform", "s", 1, 0, &text(0, 2000), 0.02),
            hit("platform", "s", 1, 1900, &text(1900, 2000), 0.01),
        ];
        let refs = beyond.iter().collect::<Vec<_>>();
        let (merged, _) = verify_and_merge(&body_text, &refs, "1", "platform", "s").unwrap();
        assert_eq!(merged.len(), 2);
        assert!(merged[0]["citation"]["locator"]["length"].as_u64().unwrap() <= 2400);
        assert!(merged[1]["citation"]["locator"]["length"].as_u64().unwrap() <= 2400);
    }
}

// 门控集成：隔离库+专用测试集合（data_agent_test_前缀，防误写共享集合）才
// 执行；缺环境时跳过，不冒充通过。链路=确定性切块→摘录写入→双通道召回→
// 门控回源→升版滞后（05切片3的局部集成证明；嵌入协议由共享嵌入检查覆盖，
// 此处用替身向量）。
#[tokio::test]
async fn gated_raw_source_round_trip_recalls_revision_and_reports_lag() {
    let Ok(url) = std::env::var("DATA_AGENT_DATABASE_URL") else {
        return;
    };
    let dedicated = std::env::var("DATA_AGENT_VECTOR_COLLECTION")
        .unwrap_or_default()
        .starts_with("data_agent_test_")
        || std::env::var("DATA_AGENT_VECTOR_COLLECTION")
            .unwrap_or_default()
            .starts_with("da_app_");
    if std::env::var("DATA_AGENT_VECTOR_URL").is_err()
        || std::env::var("DATA_AGENT_VECTOR_TOKEN_FILE").is_err()
        || !dedicated
    {
        return;
    }
    let pool = crate::persistence::connect(&url).await.unwrap();
    let ctx = AccessContext {
        user_id: "raw-recall-check".into(),
        space_id: "demo".into(),
        request_id: "raw-recall-round-trip".into(),
    };
    let source_id = "raw-recall-it";
    let body = format!(
        "{}未付款订单不产生退款，首次申请免费处理。{}最终解释以协议为准，运费除外。{}",
        "背景说明。".repeat(240),
        "补充条款。".repeat(240),
        "尾部备注。".repeat(240)
    );
    let mut tx = AppTx::begin(&pool).await.unwrap();
    for statement in [
        "DELETE FROM source_current WHERE source_id='raw-recall-it'",
        "DELETE FROM source_heads WHERE id='raw-recall-it'",
    ] {
        sqlx::query(statement)
            .execute(tx.connection())
            .await
            .unwrap();
    }
    sqlx::query("INSERT INTO source_heads(id,space_id,version,fingerprint) VALUES(?,?,1,'fp')")
        .bind(source_id)
        .bind(&ctx.space_id)
        .execute(tx.connection())
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO source_current(source_id,space_id,adapter_id,source_kind,namespace,\
             external_id,revision,body,complete,metadata,content_fingerprint,\
             explanation_fingerprint,comparison_method,parsed,observed_metadata) \
             VALUES(?,?,?,?,?,?,1,?,TRUE,'{}','fp','fp','exact',TRUE,'{}')",
    )
    .bind(source_id)
    .bind(&ctx.space_id)
    .bind("adapter")
    .bind("platform")
    .bind("ns")
    .bind(source_id)
    .bind(&body)
    .execute(tx.connection())
    .await
    .unwrap();
    tx.commit().await.unwrap();
    crate::modules::retrieval::vector::drop_source_excerpts(&ctx.space_id, source_id, u64::MAX)
        .await
        .unwrap();

    let key = crate::contracts::generated::SourceKey {
        kind: crate::contracts::generated::SourceKeyKind::Platform,
        id: source_id.into(),
    };
    let revision_text = "1".to_string();
    let text_source = crate::modules::retrieval::source_segments::SourceText {
        source: &key,
        revision: &revision_text,
        text: &body,
        format: crate::modules::retrieval::source_segments::SourceFormat::Sql,
        background: &[],
    };
    let mut segments = Vec::new();
    let mut cursor = None;
    loop {
        let batch = crate::modules::retrieval::source_segments::segment_source(
            &text_source,
            cursor.as_ref(),
        )
        .unwrap();
        if batch.segments.is_empty() {
            break;
        }
        segments.extend(batch.segments.iter().cloned());
        cursor = batch.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    assert!(
        segments.len() >= 3,
        "长文应切出多段，实测{}",
        segments.len()
    );
    let dim = crate::modules::retrieval::embedding::SPEC.dimension;
    crate::modules::retrieval::vector::apply_source_excerpts(
        &ctx.space_id,
        &segments,
        |_, texts| async move {
            Ok::<_, crate::types::Error>(
                texts.iter().map(|_| vec![0.01f32; dim]).collect::<Vec<_>>(),
            )
        },
    )
    .await
    .unwrap();

    let candidates = crate::modules::retrieval::vector::search_scoped(
        &ctx.space_id,
        "未付款订单首次申请免费处理",
        vec![0.02f32; dim],
        &crate::search_scope::KnowledgeSearchScope::default(),
        10,
    )
    .await;
    assert_eq!(candidates.raw.state, "available");
    assert!(!candidates.raw.hits.is_empty(), "raw通道必须可召回");
    // 同集合可能混有其他来源的摘录（E2E里是数千条目录正文）：只认本测试来源
    // 的命中做回环断言；dense通道按伪向量近邻会召回无关来源，属预期。
    let mine: Vec<Value> = candidates
        .raw
        .hits
        .iter()
        .filter(|hit| hit["source_id"] == source_id)
        .cloned()
        .collect();
    assert!(
        !mine.is_empty(),
        "BM25通道必须召回本来源：{:?}",
        candidates.raw.hits
    );
    for hit in &mine {
        assert_eq!(hit["source_kind"], "platform");
        assert_eq!(hit["revision"].as_u64(), Some(1));
    }

    let mut tx = AppTx::begin(&pool).await.unwrap();
    let recall = recall_excerpts_in_tx(&mut tx, &ctx, None, &mine)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(recall["state"], "located", "recall={recall}");
    assert_eq!(recall["lagged"], 0);
    let total = body.chars().count();
    for hit in recall["hits"].as_array().unwrap() {
        let offset = hit["citation"]["locator"]["offset"].as_u64().unwrap() as usize;
        let length = hit["citation"]["locator"]["length"].as_u64().unwrap() as usize;
        assert!(length <= 2400, "合并窗口不得超过2400");
        assert!(offset + length <= total);
        assert_eq!(hit["citation"]["revision"], "1");
        let expect: String = body.chars().skip(offset).take(length).collect();
        assert_eq!(
            hit["text"].as_str().unwrap(),
            expect,
            "回读必须与当前正文切片一致"
        );
        assert_eq!(hit["source_length"].as_u64().unwrap() as usize, total);
    }

    // 门控：允许集不含该来源→只报过滤计数；不泄露受限名称，不读回源。
    let limits = json!({
        "allowed_sources":[{"kind":"platform","id":"other-source"}],
        "origin_message_ids":["m1"]
    });
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let gated = recall_excerpts_in_tx(&mut tx, &ctx, Some(&limits), &mine)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        gated["filtered"].as_u64().unwrap(),
        mine.len().min(30) as u64
    );
    assert_eq!(gated["hits"].as_array().unwrap().len(), 0);
    assert_eq!(gated["lagged"], 0);

    // 升版：旧修订命中不再回源成正文，按滞后如实报告。
    let body2 = format!(
        "{}已付款订单可以申请退款，运费除外。",
        "新版背景。".repeat(240)
    );
    let mut tx = AppTx::begin(&pool).await.unwrap();
    sqlx::query("UPDATE source_heads SET version=2 WHERE id=?")
        .bind(source_id)
        .execute(tx.connection())
        .await
        .unwrap();
    sqlx::query("UPDATE source_current SET revision=2, body=? WHERE source_id=?")
        .bind(&body2)
        .bind(source_id)
        .execute(tx.connection())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let mut tx = AppTx::begin(&pool).await.unwrap();
    let lagged_view = recall_excerpts_in_tx(&mut tx, &ctx, None, &mine)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(lagged_view["state"], "unlocated");
    assert_eq!(
        lagged_view["lagged"].as_u64().unwrap(),
        mine.len().min(30) as u64
    );

    // 清理：删行与摘录向量；专用集合本身由harness管理。
    let mut tx = AppTx::begin(&pool).await.unwrap();
    for statement in [
        "DELETE FROM source_current WHERE source_id='raw-recall-it'",
        "DELETE FROM source_heads WHERE id='raw-recall-it'",
    ] {
        sqlx::query(statement)
            .execute(tx.connection())
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();
    crate::modules::retrieval::vector::drop_source_excerpts(&ctx.space_id, source_id, u64::MAX)
        .await
        .unwrap();
}

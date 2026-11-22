use super::*;

fn aggregate_search_objects(contents: Vec<Value>) -> Result<Vec<Value>> {
    let mut objects: Vec<Value> = Vec::new();
    for content in contents {
        let Some(object) = objects.iter_mut().find(|object| {
            object["id"] == content["id"] && object["version"] == content["version"]
        }) else {
            objects.push(content);
            continue;
        };
        for entry in content["entries"].as_array().into_iter().flatten() {
            let entries = object["entries"]
                .as_array_mut()
                .ok_or(crate::types::Error::new("unavailable"))?;
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
                let references = object[key]
                    .as_array_mut()
                    .ok_or(crate::types::Error::new("unavailable"))?;
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
                .ok_or(crate::types::Error::new("unavailable"))?;
            if !excerpts.contains(excerpt) && excerpts.len() < 3 {
                excerpts.push(excerpt.clone());
            }
        }
    }
    Ok(objects)
}

#[allow(clippy::too_many_arguments)]
// 摘录窗口的受检解析：定位/长度/正文缺失或非数值按invalid_input拒收，不再panic。
fn excerpt_bounds(content: &Value) -> Result<(u64, u64)> {
    let start = content["citation"]["locator"]["offset"]
        .as_u64()
        .ok_or_else(|| Error::new("invalid_input"))?;
    let length = content["citation"]["locator"]["length"]
        .as_u64()
        .ok_or_else(|| Error::new("invalid_input"))?;
    Ok((start, start + length))
}
fn excerpt_text(content: &Value) -> Result<&str> {
    content["text"]
        .as_str()
        .ok_or_else(|| Error::new("invalid_input"))
}
// 一次装配同时接收通道候选、范围与允许集，参数不拆结构体以保持与推进侧同构。
#[allow(clippy::too_many_arguments)]
pub(super) async fn assemble_search_in_tx(
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
            let (start, end) = excerpt_bounds(&content)?;
            // 先按索引定位可合并窗口，闭包里已解析的边界直接复用到合并，避免二次解包。
            let merge_at = merged.iter().enumerate().find_map(|(index, hit)| {
                let SearchHit::SourceExcerpt {
                    content: previous, ..
                } = hit
                else {
                    return None;
                };
                let (previous_start, previous_end) = excerpt_bounds(previous).ok()?;
                (previous["citation"]["source"] == content["citation"]["source"]
                    && previous["citation"]["revision"] == content["citation"]["revision"]
                    && start <= previous_end
                    && previous_start <= end
                    && end.max(previous_end) - start.min(previous_start) <= 2400)
                    .then_some((index, previous_start, previous_end))
            });
            if let Some((index, previous_start, previous_end)) = merge_at {
                if let SearchHit::SourceExcerpt {
                    records: previous_records,
                    score: previous_score,
                    content: previous,
                } = &mut merged[index]
                {
                    let text = if start < previous_start {
                        excerpt_text(&content)?
                            .chars()
                            .take((previous_start - start) as usize)
                            .chain(excerpt_text(previous)?.chars())
                            .chain(
                                excerpt_text(&content)?
                                    .chars()
                                    .skip((previous_end - start) as usize),
                            )
                            .collect::<String>()
                    } else {
                        excerpt_text(previous)?
                            .chars()
                            .chain(
                                excerpt_text(&content)?
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
                }
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
    let objects = aggregate_search_objects(contents)?;
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
                resolved = crate::use_cases::source_limits::allowed_records_in_tx(
                    &mut coverage_tx,
                    ctx,
                    None,
                    scope,
                )
                .await?;
                &resolved
            };
            let platform = records
                .sources
                .iter()
                .map(|(_, id)| id.clone())
                .collect::<Vec<_>>();
            let sources =
                ingestion::source_versions_in_tx(&mut coverage_tx, &ctx.space_id, &platform)
                    .await?
                    .into_iter()
                    .map(|(id, version)| ("platform".to_owned(), id, version))
                    .collect::<Vec<_>>();
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

use super::*;
use crate::contracts;

pub async fn results(
    pool: &MySqlPool,
    ctx: &AccessContext,
    qid: &str,
    cursor: Option<&str>,
) -> Result<crate::contracts::generated::QueryResults> {
    serde_json::from_value(results_with(pool, ctx, qid, cursor, false).await?)
        .map_err(|_| Error::new("result_unavailable"))
}

/// 展示路径的结果读取（04切片7）：知识引用按历史规则核验——版本漂移不隐藏
/// 已存结果数据；对象撤下或上游被撤仍拒绝。保存/采用路径沿用results。
async fn results_for_display(
    pool: &MySqlPool,
    ctx: &AccessContext,
    qid: &str,
    cursor: Option<&str>,
) -> Result<Value> {
    results_with(pool, ctx, qid, cursor, true).await
}

async fn results_with(
    pool: &MySqlPool,
    ctx: &AccessContext,
    qid: &str,
    cursor: Option<&str>,
    history_refs: bool,
) -> Result<Value> {
    let v = read(pool, ctx, qid).await?;
    if v["text_unavailable"] == true {
        return Err(Error::new("stale_context"));
    }
    if v["execution_state"] != "succeeded" {
        return Err(Error::new("result_unavailable"));
    }
    if history_refs {
        history_knowledge_check(pool, ctx, &v["knowledge_refs"]).await?;
    } else {
        knowledge_check(pool, ctx, &v["knowledge_refs"]).await?;
    }
    let mut result = queries::platform::saved_result_page(
        &json!({"query_id":qid,"owner_id":ctx.user_id,"cursor":cursor}),
    )
    .await?;
    contracts::validate("QueryResults", &result)?;
    if result["query_id"] != qid || result["result_ref"] != v["result_ref"] {
        return Err(Error::new("result_unavailable"));
    }
    result["statistics"] = queries::page_statistics(&result)?;
    if let Some(refs) = v["knowledge_refs"]
        .as_array()
        .filter(|refs| !refs.is_empty())
    {
        let mut tx = AppTx::begin(pool).await?;
        let snapshot =
            knowledge::semantic_snapshot_in_tx(&mut tx, ctx, &v["knowledge_refs"]).await?;
        tx.commit().await?;
        if let (Some(sql), Some(columns)) = (v["sql"].as_str(), result["columns"].as_array_mut()) {
            queries::annotate_result_columns(sql, columns, &snapshot, refs);
        }
    }
    Ok(result)
}

/// Agent读取投影沿用完整结果页的鉴权、来源和版本检查。
pub async fn agent_results(
    pool: &MySqlPool,
    ctx: &AccessContext,
    qid: &str,
    input: &Value,
) -> Result<Value> {
    let cell_cursor = input["row_index"].as_u64().map(|row| row.to_string());
    let cursor = if input["view"] == "cell" {
        cell_cursor.as_deref()
    } else {
        input["cursor"].as_str()
    };
    let result = results_with(pool, ctx, qid, cursor, false).await?;
    queries::agent_result_page(&result, input)
}

pub async fn result_authority(
    pool: &MySqlPool,
    ctx: &AccessContext,
    qid: &str,
    result_ref: &str,
) -> Result<()> {
    let location = query_location(pool, qid).await?;
    let checked = check_text_results(pool, ctx, &location.conversation_id, Some(qid)).await?;
    let mut tx = AppTx::begin(pool).await?;
    validate_text_in_tx(&mut tx, ctx, &location.conversation_id, qid, &checked).await?;
    tx.commit().await?;
    check_result_authority(pool, ctx, qid, result_ref, false).await
}

/// 核对结果出处和现有平台访问。已保存的历史正文只免除结果 TTL。
pub(in crate::use_cases) async fn check_result_authority(
    pool: &MySqlPool,
    ctx: &AccessContext,
    qid: &str,
    result_ref: &str,
    historical: bool,
) -> Result<()> {
    let mut tx = AppTx::begin(pool).await?;
    let query = queries::read_in_tx(&mut tx, ctx, qid).await?;
    conversations::assert_readable_in_tx(
        &mut tx,
        ctx,
        query["conversation_id"]
            .as_str()
            .ok_or(Error::new("not_available"))?,
    )
    .await?;
    if query["execution_state"] != "succeeded" || query["result_ref"].as_str() != Some(result_ref) {
        return Err(Error::new(if historical {
            "invalid_evidence"
        } else {
            "result_unavailable"
        }));
    }
    if historical {
        super::super::knowledge::history_check_refs_in_tx(&mut tx, ctx, &query["knowledge_refs"])
            .await?;
    } else {
        super::super::knowledge::check_refs_in_tx(&mut tx, ctx, &query["knowledge_refs"]).await?;
    }
    tx.commit().await?;
    match queries::platform::result_authority(qid, &ctx.user_id, result_ref).await {
        Err(error) if historical && error.code == "result_expired" => Ok(()),
        result => result,
    }
}

pub(in crate::use_cases) async fn result_state_authority(
    pool: &MySqlPool,
    ctx: &AccessContext,
    qid: &str,
    reference: &str,
) -> Result<()> {
    check_result_authority(pool, ctx, qid, reference, false).await
}

/// 读取已保存页不会创建新查询；每一页复用正常结果读取的当前授权与依据检查。
pub async fn collect_saved_results(
    pool: &MySqlPool,
    ctx: &AccessContext,
    qid: &str,
) -> Result<Value> {
    collect_saved_results_with(pool, ctx, qid, true).await
}

/// 展示路径的已存结果收集（04切片7）：图表数据按结果状态授权交付，不做正文
/// 严格核验——查询正文曾依赖的其他结果过期只影响口径说明，不隐藏本结果数据；
/// 撤权类仍由结果状态授权拒绝。保存/采用路径继续用collect_saved_results。
pub async fn collect_saved_results_for_display(
    pool: &MySqlPool,
    ctx: &AccessContext,
    qid: &str,
) -> Result<Value> {
    collect_saved_results_with(pool, ctx, qid, false).await
}

async fn collect_saved_results_with(
    pool: &MySqlPool,
    ctx: &AccessContext,
    qid: &str,
    strict_text: bool,
) -> Result<Value> {
    let mut pages = Vec::new();
    let mut cursor = None;
    let mut received_bytes = 0_usize;
    for _ in 0..queries::SAVED_RESULT_MAX_PAGES {
        let page = if strict_text {
            results_with(pool, ctx, qid, cursor.as_deref(), false).await?
        } else {
            results_for_display(pool, ctx, qid, cursor.as_deref()).await?
        };
        if page["fetched_offset"].as_str() != Some(cursor.as_deref().unwrap_or("0"))
            || pages.first().is_some_and(|first: &Value| {
                [
                    "columns",
                    "result_ref",
                    "source",
                    "data_freshness",
                    "saved_row_count",
                    "saved_result_complete",
                    "truncated",
                ]
                .iter()
                .any(|key| page[*key] != first[*key])
            })
        {
            return Err(Error::new("result_unavailable"));
        }
        received_bytes = received_bytes
            .checked_add(
                serde_json::to_vec(&page)
                    .map_err(|_| Error::new("result_unavailable"))?
                    .len(),
            )
            .ok_or(Error::new("request_too_large"))?;
        if received_bytes > queries::SAVED_RESULT_LIMIT {
            return Err(Error::new("request_too_large"));
        }
        cursor = queries::saved_result_next_cursor(&page)?;
        pages.push(page);
        if cursor.is_none() {
            let result = queries::merge_saved_result_pages(qid, &pages)?;
            contracts::validate("QueryResults", &result)?;
            let reference = result["result_ref"]
                .as_str()
                .ok_or(Error::new("result_unavailable"))?;
            if strict_text {
                result_authority(pool, ctx, qid, reference).await?;
            } else if let Err(error) =
                check_result_authority(pool, ctx, qid, reference, false).await
            {
                // 展示路径的知识引用已在results_for_display按历史规则核验（撤权类
                // 在那层整份拒绝）；末次状态授权里的严格引用核验对版本漂移类失败
                // 不隐藏图表数据（04切片7），撤权与过期类照常上抛——与展示路径
                // 直接调用处的容忍清单一致。
                if !matches!(
                    error.code,
                    "stale_context" | "stale_knowledge" | "invalid_input"
                ) {
                    return Err(error);
                }
            }
            return Ok(result);
        }
    }
    Err(Error::new("request_too_large"))
}
async fn knowledge_check(pool: &MySqlPool, ctx: &AccessContext, refs: &Value) -> Result<()> {
    let mut tx = AppTx::begin(pool).await?;
    super::super::knowledge::check_refs_in_tx(&mut tx, ctx, refs).await?;
    tx.commit().await
}

async fn history_knowledge_check(
    pool: &MySqlPool,
    ctx: &AccessContext,
    refs: &Value,
) -> Result<()> {
    let mut tx = AppTx::begin(pool).await?;
    super::super::knowledge::history_check_refs_in_tx(&mut tx, ctx, refs).await?;
    tx.commit().await
}

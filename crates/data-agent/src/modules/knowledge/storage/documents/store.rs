use super::*;

pub async fn document_parts_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
) -> Result<Vec<Value>> {
    let selected = read_in_tx(tx, ctx, object, None, true).await?;
    if selected["kind"] != "document" {
        return Err(Error::new("invalid_input"));
    }
    let Some(source) = selected["source_id"].as_str() else {
        return Ok(vec![selected]);
    };
    let rows = sqlx::query("SELECT id FROM knowledge_objects WHERE space_id=? AND source_id=? AND kind='document' AND state<>'deleted' ORDER BY id LIMIT 201")
        .bind(&ctx.space_id).bind(source).fetch_all(tx.connection()).await?;
    if rows.len() > 200 {
        return Err(Error::new("payload_limit"));
    }
    let mut parts = Vec::new();
    for row in rows {
        parts.push(read_in_tx(tx, ctx, &row.get::<String, _>("id"), None, true).await?);
    }
    Ok(parts)
}

pub async fn save_document_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
    input: &Value,
    order: &[String],
) -> Result<Vec<Value>> {
    let key = input["operation_id"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?;
    let command = json!({"action":"edit-document","object_id":object,"input":input});
    if let Some(receipt) = begin_operation(tx, ctx, key, &command).await? {
        return serde_json::from_value(receipt).map_err(|_| Error::new("invalid_input"));
    }
    let text = input["body"].as_str().ok_or(Error::new("invalid_input"))?;
    let chunks = document_chunks(text, order.len());
    let mut versions = input["parts"]
        .as_array()
        .ok_or(Error::new("invalid_input"))?
        .clone();
    versions.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    let mut saved = Vec::new();
    // 按稳定身份锁定、校验全体版本。正文与排序同事务保存，空片段也保留人工值。
    for part in versions {
        let id = part["id"].as_str().ok_or(Error::new("invalid_input"))?;
        let position = order
            .iter()
            .position(|value| value == id)
            .ok_or(Error::new("version_conflict"))?;
        let mut value =
            locked(tx, ctx, id, part["expected_version"].as_str().unwrap_or("")).await?;
        let old = value.clone();
        let entry = value["entries"]
            .as_array_mut()
            .and_then(|entries| entries.iter_mut().find(|e| e["entry_id"] == "body"))
            .ok_or(Error::new("invalid_input"))?;
        let metadata_changed = order.len() == 1
            && (input
                .get("source_url")
                .is_some_and(|url| *url != entry["human_override"]["source_url"])
                || input
                    .get("related_ids")
                    .is_some_and(|ids| *ids != old["related_ids"]));
        if entry["effective_value"] == chunks[position]
            && old["document_order"] == position
            && !metadata_changed
        {
            saved.push(value);
            continue;
        }
        let url = if order.len() == 1 {
            input
                .get("source_url")
                .cloned()
                .unwrap_or_else(|| entry["human_override"]["source_url"].clone())
        } else {
            entry["human_override"]["source_url"].clone()
        };
        let related_override = if order.len() == 1 {
            input.get("related_ids").cloned()
        } else {
            None
        }
        .or_else(|| entry["human_override"].get("related_ids").cloned());
        entry["human_override"] = json!({"value":chunks[position],"edited_by":ctx.user_id,"operation_id":key,"source_url":url});
        if let Some(related) = related_override {
            entry["human_override"]["related_ids"] = related;
        }
        entry["effective_value"] = json!(chunks[position]);
        entry["review_state"] = json!("confirmed");
        if !chunks[position].trim().is_empty()
            && entry["source_facts"]["gap"] == "只有链接，正文尚未录入，不能据此解释业务"
        {
            entry["source_facts"]["gap"] = json!("人工录入，尚无平台来源");
        }
        value["document_order"] = json!(position);
        if order.len() == 1 && input.get("related_ids").is_some() {
            validate_document_metadata(tx, ctx, input).await?;
            value["related_ids"] = input["related_ids"].clone();
        } else if input.get("source_url").is_some() {
            validate_document_metadata(tx, ctx, input).await?;
        }
        next(&mut value, ctx);
        persist(tx, ctx, &value, &["*"]).await?;
        saved.push(value);
    }
    record(tx, ctx, key, &command, &json!(saved)).await?;
    Ok(saved)
}

// 只为兼容已存在的文档引用分配片段：完整 Markdown 无损往返，不增加对象或暴露分块。
fn document_chunks(text: &str, count: usize) -> Vec<&str> {
    let mut boundaries = vec![0];
    // 首节连同序言保存；超过现有片段数的章节继续留在末段。
    for (offset, _) in text
        .match_indices("\n## ")
        .skip(1)
        .take(count.saturating_sub(1))
    {
        boundaries.push(offset + 1);
    }
    boundaries.push(text.len());
    let mut chunks = boundaries
        .windows(2)
        .map(|pair| &text[pair[0]..pair[1]])
        .collect::<Vec<_>>();
    chunks.resize(count, "");
    chunks
}
pub(super) async fn validate_document_metadata(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    input: &Value,
) -> Result<()> {
    for r in input["related_ids"].as_array().into_iter().flatten() {
        read_in_tx(
            tx,
            ctx,
            r.as_str().ok_or(Error::new("invalid_input"))?,
            None,
            true,
        )
        .await?;
    }
    if let Some(url) = input["source_url"].as_str() {
        let parsed = reqwest::Url::parse(url).map_err(|_| Error::new("invalid_input"))?;
        if !matches!(parsed.scheme(), "https" | "http") {
            return Err(Error::new("invalid_input"));
        }
    }
    Ok(())
}

// 管理目录有界分页，不能把任意截断当成整个空间。

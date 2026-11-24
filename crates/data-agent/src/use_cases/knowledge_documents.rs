use crate::{
    contracts::{self, generated::KnowledgeDocumentEdit},
    modules::{access, jobs, knowledge},
    persistence::AppTx,
    types::{AccessContext, Error, Result, epoch},
};
use serde_json::{Value, json};
use sqlx::MySqlPool;

async fn present(tx: &mut AppTx<'_>, ctx: &AccessContext, mut parts: Vec<Value>) -> Result<Value> {
    let first = parts.first().ok_or(Error::new("not_available"))?;
    let grouped = first["source_id"].is_string();
    let mut title = first["name"].as_str().unwrap_or("业务文档").to_owned();
    let edited = parts.iter().all(|part| part["document_order"].is_u64());
    let body = if edited {
        parts.sort_by_key(|part| part["document_order"].as_u64());
        parts
            .iter()
            .filter_map(|part| {
                part["entries"]
                    .as_array()?
                    .iter()
                    .find(|e| e["entry_id"] == "body")?["effective_value"]
                    .as_str()
            })
            .collect::<String>()
    } else if let Some(source) = first["source_id"].as_str() {
        let document = super::knowledge_sources::read_in_tx(
            tx,
            ctx,
            source,
            Some(epoch(first["source_version"].as_str().unwrap_or("0"))?),
        )
        .await?;
        if document["complete"] != true {
            return Err(Error::new("not_available"));
        }
        let original = document["body"].as_str().unwrap_or("");
        let introduction = original
            .lines()
            .take_while(|line| !line.starts_with("## "))
            .collect::<Vec<_>>()
            .join("\n");
        parts.sort_by_key(|part| {
            original
                .find(&format!("## {}", part["name"].as_str().unwrap_or("")))
                .unwrap_or(usize::MAX)
        });
        let mut body = introduction.trim_end().to_owned();
        for part in &parts {
            body.push_str(&format!(
                "\n\n## {}\n\n{}",
                part["name"].as_str().unwrap_or(""),
                part["entries"]
                    .as_array()
                    .and_then(|entries| entries.iter().find(|e| e["entry_id"] == "body"))
                    .and_then(|entry| entry["effective_value"].as_str())
                    .unwrap_or("")
            ));
        }
        body
    } else {
        first["entries"]
            .as_array()
            .and_then(|entries| entries.iter().find(|entry| entry["entry_id"] == "body"))
            .and_then(|entry| entry["effective_value"].as_str())
            .unwrap_or("")
            .to_owned()
    };
    if grouped
        && let Some(heading) = body
            .lines()
            .next()
            .and_then(|line| line.strip_prefix("# "))
            .filter(|title| !title.trim().is_empty())
    {
        title = heading.trim().to_owned();
    }
    let mut can_edit = true;
    for part in &mut parts {
        super::semantic_governance::decorate_in_tx(tx, ctx, part).await?;
        can_edit &= part["maintenance"]["can_edit"] == true;
    }
    let result = json!({"title":title,"body":body,"parts":parts,"can_edit":can_edit});
    contracts::validate("KnowledgeDocument", &result)?;
    Ok(result)
}

pub async fn read(pool: &MySqlPool, ctx: &AccessContext, object: &str) -> Result<Value> {
    let mut tx = AppTx::begin(pool).await?;
    let parts = knowledge::document_parts_in_tx(&mut tx, ctx, object).await?;
    let result = present(&mut tx, ctx, parts).await?;
    tx.commit().await?;
    Ok(result)
}

pub async fn edit(
    pool: &MySqlPool,
    ctx: &AccessContext,
    object: &str,
    input: KnowledgeDocumentEdit,
    raw: Value,
) -> Result<Value> {
    let mut tx = AppTx::begin(pool).await?;
    let parts = knowledge::document_parts_in_tx(&mut tx, ctx, object).await?;
    if parts.len() > 1 && (raw.get("related_ids").is_some() || raw.get("source_url").is_some()) {
        return Err(Error::new("invalid_input"));
    }
    let mut submitted = input
        .parts
        .iter()
        .map(|part| part.id.as_str())
        .collect::<Vec<_>>();
    submitted.sort_unstable();
    let mut expected = parts
        .iter()
        .map(|part| part["id"].as_str().unwrap_or(""))
        .collect::<Vec<_>>();
    expected.sort_unstable();
    if submitted != expected {
        return Err(Error::new("version_conflict"));
    }
    for id in expected {
        access::authorize_semantic_in_tx(&mut tx, ctx, id).await?;
    }
    // 原有章节身份只用于内部引用。前台读写完整 Markdown，存储排序由服务端确定。
    let current = present(&mut tx, ctx, parts).await?;
    let order = current["parts"]
        .as_array()
        .ok_or(Error::new("invalid_input"))?
        .iter()
        .map(|part| part["id"].as_str().unwrap_or("").to_owned())
        .collect::<Vec<_>>();
    let saved = knowledge::save_document_in_tx(&mut tx, ctx, object, &raw, &order).await?;
    // 模块内保存不含跨模块登记：补依赖目标指纹并排队来源扇出（幂等）。
    super::dependency_registration::after_content_saved_in_tx(&mut tx, ctx, &saved).await?;
    // 保存推进了文档修订：原子排队该修订的语义准备。
    for part in &saved {
        let expected = input
            .parts
            .iter()
            .find(|submitted| part["id"] == submitted.id)
            .ok_or(Error::new("version_conflict"))?;
        if part["version"] != expected.expected_version {
            register_document_preparation_in_tx(&mut tx, part).await?;
        }
    }
    let result = present(&mut tx, ctx, saved).await?;
    tx.commit().await?;
    Ok(result)
}

// 保存当前原文即排队语义准备；空正文没有可整理内容，文档分册与停用对象
// 不属于单文档原文，不在此登记。独立文档以知识条目定位：原文向量通道只
// 保留给平台来源（scan只查platform摘录），文档保存不再登记原文向量目标。
pub async fn register_document_preparation_in_tx(
    tx: &mut AppTx<'_>,
    document: &Value,
) -> Result<()> {
    if document["kind"] != "document"
        || !document["source_id"].is_null()
        || document["state"] != "enabled"
    {
        return Ok(());
    }
    let body = document["entries"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|entry| entry["entry_id"] == "body")
        .and_then(|entry| entry["effective_value"].as_str())
        .unwrap_or("");
    if body.trim().is_empty() {
        return Ok(());
    }
    let id = document["id"].as_str().ok_or(Error::new("invalid_input"))?;
    let version = document["version"]
        .as_str()
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or(Error::new("invalid_input"))?;
    let source = format!("document-{id}");
    jobs::enqueue_source_in_tx(tx, "prepare_source", &source, version).await?;
    Ok(())
}

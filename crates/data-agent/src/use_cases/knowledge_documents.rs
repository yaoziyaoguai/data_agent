use crate::{
    contracts,
    modules::{access, knowledge},
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
    input: Value,
) -> Result<Value> {
    contracts::validate("KnowledgeDocumentEdit", &input)?;
    let mut tx = AppTx::begin(pool).await?;
    let parts = knowledge::document_parts_in_tx(&mut tx, ctx, object).await?;
    if parts.len() > 1 && (input.get("related_ids").is_some() || input.get("source_url").is_some())
    {
        return Err(Error::new("invalid_input"));
    }
    let mut submitted = input["parts"]
        .as_array()
        .ok_or(Error::new("invalid_input"))?
        .iter()
        .map(|part| part["id"].as_str().unwrap_or(""))
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
    let saved = knowledge::save_document_in_tx(&mut tx, ctx, object, &input, &order).await?;
    let result = present(&mut tx, ctx, saved).await?;
    tx.commit().await?;
    Ok(result)
}

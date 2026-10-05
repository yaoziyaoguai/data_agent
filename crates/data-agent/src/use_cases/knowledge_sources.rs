use crate::{
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

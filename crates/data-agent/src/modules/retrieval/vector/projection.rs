use super::{Milvus, embedding};
use crate::types::{Error, Result, fingerprint};
use serde_json::{Value, json};
use std::future::Future;

pub(super) fn fragments(space: &str, object: &Value) -> (Vec<Value>, bool) {
    if object["state"] != "enabled" {
        return (vec![], false);
    }
    let mut pieces = Vec::new();
    let bounded = false;
    for entry in object["entries"].as_array().into_iter().flatten() {
        if matches!(entry["path"].as_str(), Some("ddl" | "etl")) {
            continue;
        }
        let layer = if object["kind"] == "document" {
            "suggestion"
        } else if entry["human_override"].is_object() {
            "human_override"
        } else if entry["suggestion"]["value"].is_string() {
            "suggestion"
        } else {
            "source_facts"
        };
        let statements = entry[layer]["statements"].as_array();
        let mut units = Vec::new();
        if let Some(statements) = statements.filter(|items| !items.is_empty()) {
            let mut entry_offset = 0;
            for statement in statements {
                let text = statement["text"].as_str().unwrap_or("");
                let scope = statement["scope_text"].as_str().unwrap_or("");
                let body = if scope.is_empty() {
                    text.to_owned()
                } else {
                    format!("{text}\n{scope}")
                };
                units.push((
                    statement["statement_id"].clone(),
                    entry_offset,
                    body.clone(),
                ));
                entry_offset += body.chars().count() + 2;
            }
        }
        if object["kind"] != "document"
            && !units.is_empty()
            && units
                .iter()
                .map(|(_, _, text)| text.as_str())
                .collect::<Vec<_>>()
                .join("\n\n")
                != entry["effective_value"].as_str().unwrap_or("")
        {
            units.clear();
        }
        if (object["kind"] == "document" || units.is_empty())
            && let Some(text) = entry["effective_value"].as_str()
        {
            units.push((Value::Null, 0, text.to_owned()));
        }
        for (statement_id, entry_offset, text) in units {
            let chars = text.chars().collect::<Vec<_>>();
            for local_offset in (0..chars.len()).step_by(crate::types::KNOWLEDGE_STRIDE) {
                let body = chars
                    .iter()
                    .skip(local_offset)
                    .take(crate::types::KNOWLEDGE_WINDOW)
                    .collect::<String>();
                let offset = if object["kind"] == "document" && !statement_id.is_null() {
                    local_offset
                } else {
                    entry_offset + local_offset
                };
                let text = format!(
                    "{} {} {} {}：{}",
                    object["name"].as_str().unwrap_or(""),
                    object["kind"].as_str().unwrap_or(""),
                    super::super::query_example_index_text(entry),
                    entry["label"].as_str().unwrap_or(""),
                    body
                );
                let mut location = entry.clone();
                location["statement_id"] = statement_id.clone();
                let key = crate::types::knowledge_record_id(space, object, &location, offset);
                pieces.push(json!({"id":key,"space_id":space,"object_id":object["id"],"object_version":object["version"].as_str().unwrap_or("0").parse::<u64>().unwrap_or(0),"kind":object["kind"],"model":embedding::SPEC.version,"projection_version":crate::types::KNOWLEDGE_PROJECTION,"entry_id":entry["entry_id"],"entry_path":entry["path"],"statement_id":statement_id.as_str().unwrap_or(""),"statement_offset":local_offset,"char_offset":offset,"char_length":body.chars().count(),"content_hash":fingerprint(&json!(body)),"text":text}));
            }
        }
    }
    (pieces, bounded)
}

// 老索引仅保存片段键；复用同一生成器从当前授权正文还原位置，不触发向量化或写索引。
pub(in crate::modules::retrieval) fn fragment_locations(
    space: &str,
    object: &Value,
) -> Result<std::collections::HashMap<String, Value>> {
    let mut locations = std::collections::HashMap::new();
    for piece in fragments(space, object).0 {
        let location = json!({
            "entry_id":piece["entry_id"],"statement_id":piece["statement_id"],
            "statement_offset":piece["statement_offset"],"offset":piece["char_offset"],
            "length":piece["char_length"],"content_hash":piece["content_hash"]
        });
        let legacy = fingerprint(&json!([
            space,
            object["id"],
            object["version"],
            piece["entry_id"],
            piece["char_offset"],
            embedding::SPEC.version,
        ]));
        let id = piece["id"].as_str().ok_or(Error::new("unavailable"))?;
        locations.insert(id.to_owned(), location.clone());
        locations.insert(legacy, location);
    }
    Ok(locations)
}

// 不可变版本/片段键使重发可查证；旧任务只能删除比自己更旧的片段，不能覆盖新版。
pub async fn apply<F, Fut>(space: &str, objects: &[Value], mut embed: F) -> Result<Vec<Value>>
where
    F: FnMut(Value, usize, Vec<String>) -> Fut + Send,
    Fut: Future<Output = Result<Vec<Vec<f32>>>> + Send,
{
    let milvus = Milvus::shared()?;
    // 调用者领取前已核验集合；中途丢库由下一次领取重新核验，避免每对象重复describe。
    let mut reports = Vec::new();
    for object in objects {
        let (pieces, bounded) = fragments(space, object);
        for (batch, chunk) in embedding::batches(&pieces)?.into_iter().enumerate() {
            let ids = chunk.iter().map(|v| v["id"].clone()).collect::<Vec<_>>();
            let existing=milvus.call("entities/query",json!({"filter":format!("id in {}",json!(ids)),"outputFields":["id","entry_id","char_offset","char_length","content_hash"],"limit":512,"consistencyLevel":"Strong"})).await?;
            let present: std::collections::HashMap<_, _> = existing
                .as_array()
                .ok_or(Error::new("vector_unavailable"))?
                .iter()
                .filter_map(|v| v["id"].as_str().map(|id| (id, v)))
                .collect();
            if chunk.iter().all(|piece| {
                present
                    .get(piece["id"].as_str().unwrap_or(""))
                    .is_some_and(|stored| {
                        ["entry_id", "char_offset", "char_length", "content_hash"]
                            .iter()
                            .all(|key| stored[*key] == piece[*key])
                    })
            }) {
                continue;
            }
            let vectors = embed(
                object.clone(),
                batch,
                chunk
                    .iter()
                    .map(|v| v["text"].as_str().unwrap_or("").to_owned())
                    .collect(),
            )
            .await?;
            if vectors.len() != chunk.len() {
                return Err(Error::new("embedding_unavailable"));
            }
            let data = chunk
                .iter()
                .zip(vectors)
                .map(|(piece, vector)| {
                    // text随向量同写供BM25通道分词；sparse由集合的BM25函数生成。
                    // target标量区分索引目标：knowledge_entry/source_excerpt（05切片2）。
                    let mut piece = piece.clone();
                    if piece["target"].is_null() {
                        piece["target"] = json!("knowledge_entry");
                    }
                    piece["vector"] = json!(vector);
                    piece
                })
                .collect::<Vec<_>>();
            milvus.call("entities/upsert", json!({"data":data})).await?;
        }
        reports.push(json!({"id":object["id"],"version":object["version"],"projection_version":crate::types::KNOWLEDGE_PROJECTION,"state":if bounded{"bounded"}else{"indexed"}}));
    }
    for batch in objects.chunks(64) {
        let mut filters = Vec::new();
        for object in batch {
            let version = object["version"]
                .as_str()
                .unwrap_or("0")
                .parse::<u64>()
                .map_err(|_| Error::new("invalid_input"))?;
            let comparison = if object["state"] == "enabled" {
                "<"
            } else {
                "<="
            };
            filters.push(format!(
                "(object_id == {} && object_version {comparison} {version})",
                object["id"]
            ));
        }
        if !filters.is_empty() {
            milvus.call("entities/delete",json!({"filter":format!("space_id == {} && model == {} && ({})",json!(space),json!(embedding::SPEC.version),filters.join(" || "))})).await?;
        }
    }
    Ok(reports)
}

// 05切片2/3：原文摘录目标（source_excerpt）。raw键绑定SourceKey/revision/locator/
// 切块版本/嵌入规格；原文无需等待模型整理即可进入索引，整理pending/failed同样索引。
// 正文与结构背景合并为BM25文本（背景在前的结构词），content_hash只对正文。
pub async fn apply_source_excerpts<F, Fut>(
    space: &str,
    segments: &[super::super::source_segments::SourceSegment],
    mut embed: F,
) -> Result<()>
where
    F: FnMut(usize, Vec<String>) -> Fut + Send,
    Fut: Future<Output = Result<Vec<Vec<f32>>>> + Send,
{
    let milvus = Milvus::shared()?;
    let mut pieces = Vec::new();
    for segment in segments {
        let background = segment
            .background
            .iter()
            .map(|item| item.text.as_str())
            .collect::<Vec<_>>()
            .join("；");
        let body = segment.text.as_str();
        let text = if background.is_empty() {
            body.to_owned()
        } else {
            format!("{background}\n{body}")
        };
        pieces.push(json!({
            "id":fingerprint(&json!([
                space, segment.citation.source, segment.citation.revision,
                segment.citation.locator.offset, segment.citation.locator.length,
                super::super::source_segments::SEGMENTATION_VERSION, embedding::SPEC.version
            ])),
            "space_id":space,
            "object_id":segment.citation.source.id,
            // 与知识通道同纪律：修订按数值存储，升版清理的过滤才能做数值比较。
            "object_version":segment.citation.revision.parse::<u64>().unwrap_or(0),
            "kind":"source_excerpt",
            "target":"source_excerpt",
            "segmentation_version":super::super::source_segments::SEGMENTATION_VERSION,
            // 回源需要SourceKey种类（document-{id}还是平台source_id）；只随摘录
            // 存身份，不存业务引用。
            "source_kind":match segment.citation.source.kind {
                crate::contracts::generated::SourceKeyKind::Document => "document",
                crate::contracts::generated::SourceKeyKind::Platform => "platform",
            },
            "model":embedding::SPEC.version,
            "entry_id":Value::Null,
            "char_offset":segment.citation.locator.offset,
            "char_length":segment.citation.locator.length,
            "content_hash":segment.content_hash,
            "text":text,
        }));
    }
    if pieces.is_empty() {
        return Ok(());
    }
    for (batch, chunk) in embedding::batches(&pieces)?.into_iter().enumerate() {
        let ids = chunk.iter().map(|v| v["id"].clone()).collect::<Vec<_>>();
        let existing=milvus.call("entities/query",json!({"filter":format!("id in {}",json!(ids)),"outputFields":["id","char_offset","char_length","content_hash","segmentation_version"],"limit":512,"consistencyLevel":"Strong"})).await?;
        let present: std::collections::HashMap<_, _> = existing
            .as_array()
            .ok_or(Error::new("vector_unavailable"))?
            .iter()
            .filter_map(|v| v["id"].as_str().map(|id| (id, v)))
            .collect();
        if chunk.iter().all(|piece| {
            present
                .get(piece["id"].as_str().unwrap_or(""))
                .is_some_and(|stored| {
                    [
                        "char_offset",
                        "char_length",
                        "content_hash",
                        "segmentation_version",
                    ]
                    .iter()
                    .all(|key| stored[*key] == piece[*key])
                })
        }) {
            continue;
        }
        let vectors = embed(
            batch,
            chunk
                .iter()
                .map(|v| v["text"].as_str().unwrap_or("").to_owned())
                .collect(),
        )
        .await?;
        if vectors.len() != chunk.len() {
            return Err(Error::new("embedding_unavailable"));
        }
        let data = chunk
            .iter()
            .zip(vectors)
            .map(|(piece, vector)| {
                // 与知识片段同纪律：text保留供BM25通道，sparse由函数生成。
                let mut piece = piece.clone();
                piece["vector"] = json!(vector);
                piece
            })
            .collect::<Vec<_>>();
        milvus.call("entities/upsert", json!({"data":data})).await?;
    }
    Ok(())
}

// 原文来源修订升版：删除该来源旧修订的摘录向量。清旧身份与写入一致——
// SourceKey的kind与裸id共同定位，平台与文档同ID不互删，document-调用别名
// 不直接当Milvus的裸object_id。
pub async fn drop_source_excerpts(
    space: &str,
    source_kind: &str,
    source: &str,
    before: u64,
) -> Result<()> {
    let milvus = Milvus::shared()?;
    milvus
        .call(
            "entities/delete",
            json!({"filter":format!(
                "space_id == {} && model == {} && target == \"source_excerpt\" && source_kind == {} && object_id == {} && object_version < {}",
                json!(space), json!(embedding::SPEC.version), json!(source_kind), json!(source), before
            )}),
        )
        .await?;
    Ok(())
}

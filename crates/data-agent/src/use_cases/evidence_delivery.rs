mod search;
pub(super) use search::{SearchDelivery, search_reply};

use crate::{
    contracts::generated::{KnowledgeSearchInput, ResponseBudget},
    modules::{analysis, conversations, retrieval},
    persistence::AppTx,
    types::{AccessContext, Error, Result, epoch, fingerprint},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use flate2::{Compression, bufread::GzDecoder, write::GzEncoder};
use serde_json::{Value, json};
use std::io::{Read, Write};

// 只限制边界处的临时展开；外部游标仍限65536B，避免小压缩输入造成无界分配。
const SEARCH_SNAPSHOT_BYTES: usize = 8 * 1024 * 1024;

pub(super) async fn current_task_in_tx(
    tx: &mut AppTx<'_>,
    conv: &conversations::LockedConversation,
    reference: Option<&crate::contracts::generated::EvidenceTaskRef>,
) -> Result<Option<(String, u64)>> {
    let active = conversations::active_task_ref_in_tx(tx, conv).await?;
    if let Some(reference) = reference {
        let (task, version) = active.as_ref().ok_or(Error::new("task_context_required"))?;
        if task != &reference.task_id {
            return Err(Error::new("task_context_required"));
        }
        if *version != epoch(&reference.condition_version)? {
            return Err(Error::new("version_conflict"));
        }
        analysis::assert_read_context_in_tx(tx, &conv.id, task, *version).await?;
    }
    Ok(active)
}

// 重放只重核当前授权与依赖，不重读正文，也不按新容量改写首次成功回执。
pub(super) async fn assert_replay_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    conv: &conversations::LockedConversation,
    run_id: &str,
    args: &Value,
    receipt: &Value,
    checked: &super::context_authority::CheckedTextResults,
) -> Result<()> {
    let task = args
        .get("task_ref")
        .filter(|task| !task.is_null())
        .map(|task| serde_json::from_value(task.clone()).map_err(|_| Error::new("invalid_input")))
        .transpose()?;
    if task.is_some() {
        current_task_in_tx(tx, conv, task.as_ref()).await?;
    }
    let mut authority = super::context_authority::empty();
    let data = &receipt["data"];
    super::context_authority::observe(&mut authority, data)?;
    super::context_authority::observe_workspace_previews(&mut authority, data)?;
    let skill_refs = super::context_authority::items(&authority["skills"]);
    let has_skills = !skill_refs.is_empty();
    let mut skill_sources = super::context_authority::empty();
    if has_skills {
        let selected = crate::modules::assets::selected_in_tx(tx, ctx, &conv.id).await?;
        for reference in skill_refs {
            let asset = selected
                .iter()
                .find(|asset| asset["id"] == reference[0] && asset["version"] == reference[1])
                .ok_or(Error::new("not_available"))?;
            super::context_authority::merge(
                &mut skill_sources,
                &super::personal_assets::skill_authority(asset)?,
            )?;
        }
    }
    if has_skills {
        super::context_authority::merge_skill_preview_sources(&mut authority, &skill_sources)?;
    }
    let asset_refs = super::context_authority::validate_in_tx(
        tx,
        ctx,
        super::context_authority::including_skill_previews(&authority)?.as_ref(),
        super::context_authority::AuthorityUse::Text(checked),
    )
    .await?;
    let projection = super::source_limits::active_projection_in_tx(tx, conv).await?;
    if !projection.scope_known {
        return Err(Error::new("task_context_required"));
    }
    if let Some(gate) = &projection.gate {
        let mut delivered = super::context_authority::empty();
        super::context_authority::observe_delivery(&mut delivered, &receipt["data"], false)?;
        super::context_authority::observe(&mut delivered, &Value::Array(asset_refs))?;
        if has_skills {
            super::context_authority::merge(&mut delivered, &skill_sources)?;
        }
        if !super::source_limits::authority_within_in_tx(tx, ctx, gate, &delivered).await? {
            return Err(Error::new("source_not_allowed"));
        }
    }
    super::context_authority::merge_run_in_tx(tx, run_id, &authority).await
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchCursor {
    schema: u8,
    binding: String,
    scope: String,
    task: Option<(String, u64)>,
    window: super::knowledge::SearchContinuation,
}

const SELECTED_SCOPE_PREFIX: &str = "sg1:";

pub(super) enum SearchScope<'a> {
    Recall(&'a retrieval::vector::AllowedRecords),
    Selected(Option<&'a super::source_limits::SourceGate>),
}

pub(super) enum SearchCursorInput<'a> {
    Inline(&'a str),
    Receipt(String),
}

pub(super) struct SearchSelection {
    binding: String,
    scope: String,
    pub(super) task: Option<(String, u64)>,
}

impl SearchSelection {
    pub(super) fn new(
        ctx: &AccessContext,
        request: &KnowledgeSearchInput,
        task: Option<(String, u64)>,
        scope: SearchScope<'_>,
    ) -> Self {
        let mut binding = json!({"space_id":ctx.space_id,"user_id":ctx.user_id,
            "query":request.query,"limit":request.limit.unwrap_or(10),
            "kinds":request.kinds,"hints":request.hints});
        // 省略新选择字段时保留原绑定字节语义，既有游标和已登记调用继续可接回。
        if let Some(selection) = &request.source_selection {
            binding["source_selection"] = json!(selection);
        }
        let scope = match scope {
            SearchScope::Recall(records) => {
                fingerprint(&json!((&records.knowledge_ids, &records.sources)))
            }
            SearchScope::Selected(gate) => format!(
                "{SELECTED_SCOPE_PREFIX}{}",
                fingerprint(&json!(
                    gate.map(super::source_limits::SourceGate::allowed_keys)
                ))
            ),
        };
        Self {
            binding: fingerprint(&binding),
            scope,
            task,
        }
    }

    pub(super) fn restore(
        &self,
        cursor: SearchCursorInput<'_>,
    ) -> Result<super::knowledge::SearchContinuation> {
        let (cursor, from_receipt) = match &cursor {
            SearchCursorInput::Inline(cursor) => (*cursor, false),
            SearchCursorInput::Receipt(cursor) => (cursor.as_str(), true),
        };
        if cursor.len() > 65_536 {
            return Err(Error::new("invalid_cursor"));
        }
        let decoded;
        let text = if let Some(encoded) = cursor.strip_prefix("gz1:") {
            let bytes = URL_SAFE_NO_PAD
                .decode(encoded)
                .map_err(|_| Error::new("invalid_cursor"))?;
            let mut gzip = GzDecoder::new(bytes.as_slice());
            let mut output = Vec::new();
            gzip.by_ref()
                .take((SEARCH_SNAPSHOT_BYTES + 1) as u64)
                .read_to_end(&mut output)
                .map_err(|_| Error::new("invalid_cursor"))?;
            if output.len() > SEARCH_SNAPSHOT_BYTES || !gzip.get_ref().is_empty() {
                return Err(Error::new("invalid_cursor"));
            }
            decoded = output;
            std::str::from_utf8(&decoded).map_err(|_| Error::new("invalid_cursor"))?
        } else {
            cursor
        };
        let saved: SearchCursor =
            serde_json::from_str(text).map_err(|_| Error::new("invalid_cursor"))?;
        if saved.schema != 1 || saved.binding != self.binding {
            return Err(Error::new("invalid_cursor"));
        }
        // 旧精读摘要绑定的是完整允许集。持久成功回执可接回，剩余窗口由精读阶段按当前来源门重核。
        let legacy_selected = from_receipt
            && self.scope.starts_with(SELECTED_SCOPE_PREFIX)
            && saved.scope.len() == 64
            && saved
                .scope
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
        if saved.task != self.task || (saved.scope != self.scope && !legacy_selected) {
            return Err(Error::new("stale_cursor"));
        }
        saved.window.validate()?;
        Ok(saved.window)
    }

    pub(super) fn next(
        &self,
        search: &super::knowledge::KnowledgeSearch,
        delivered: &[String],
    ) -> Result<Value> {
        let Some(window) = search.snapshot(delivered, SEARCH_SNAPSHOT_BYTES)? else {
            return Ok(Value::Null);
        };
        let window: Value =
            serde_json::from_str(&window).map_err(|_| Error::new("invalid_cursor"))?;
        let mut encoded = serde_json::to_string(&json!({"schema":1,"binding":self.binding,
            "scope":self.scope,"task":self.task,"window":window}))
        .map_err(|_| Error::new("invalid_cursor"))?;
        if encoded.len() > SEARCH_SNAPSHOT_BYTES {
            return Err(Error::new("tool_response_capacity"));
        }
        if encoded.len() > 65_536 {
            let mut gzip = GzEncoder::new(Vec::new(), Compression::default());
            gzip.write_all(encoded.as_bytes())
                .map_err(|_| Error::new("invalid_cursor"))?;
            encoded = format!(
                "gz1:{}",
                URL_SAFE_NO_PAD.encode(gzip.finish().map_err(|_| Error::new("invalid_cursor"))?)
            );
        }
        if encoded.len() > 65_536 {
            return Err(Error::new("tool_response_capacity"));
        }
        Ok(json!(encoded))
    }
}

pub(super) struct ResponseCapacity {
    max_bytes: usize,
    tokens: usize,
}

impl ResponseCapacity {
    pub(super) fn new(budget: Option<&ResponseBudget>) -> Self {
        Self {
            max_bytes: budget
                .map_or(96 * 1024, |budget| budget.max_bytes as usize)
                .min(256 * 1024),
            tokens: budget.map_or(usize::MAX, |budget| budget.estimated_tokens as usize),
        }
    }

    pub(super) fn fits(&self, value: &Value) -> bool {
        let encoded = value.to_string();
        encoded.len() <= self.max_bytes && encoded.encode_utf16().count().div_ceil(4) <= self.tokens
    }
}

pub(super) fn source_reply(mut reply: Value, budget: Option<&ResponseBudget>) -> Result<Value> {
    let capacity = ResponseCapacity::new(budget);
    if capacity.fits(&reply) {
        return Ok(reply);
    }
    let text = reply["text"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?
        .chars()
        .collect::<Vec<_>>();
    let start = reply["locator"]["offset"]
        .as_u64()
        .ok_or(Error::new("invalid_input"))?;
    let end = reply["next_locator"]["offset"]
        .as_u64()
        .zip(reply["next_locator"]["length"].as_u64())
        .map_or(start + text.len() as u64, |(offset, length)| {
            offset + length
        });
    let mut low = 0;
    let mut high = text.len();
    while low < high {
        let keep = (low + high).div_ceil(2);
        reply["text"] = json!(text[..keep].iter().collect::<String>());
        reply["locator"]["length"] = json!(keep);
        reply["content_state"] = json!("partial");
        reply["next_locator"] = json!({"offset":start+keep as u64,"length":end-start-keep as u64});
        if capacity.fits(&reply) {
            low = keep;
        } else {
            high = keep - 1;
        }
    }
    if low == 0 {
        return Err(Error::new("tool_response_capacity"));
    }
    reply["text"] = json!(text[..low].iter().collect::<String>());
    reply["locator"]["length"] = json!(low);
    reply["content_state"] = json!("partial");
    reply["next_locator"] = json!({"offset":start+low as u64,"length":end-start-low as u64});
    Ok(reply)
}

pub(super) fn knowledge_reply(
    mut reply: Value,
    budget: Option<&ResponseBudget>,
    support_pages: &[Option<super::knowledge_supports::SupportPage>],
) -> Result<Value> {
    let capacity = ResponseCapacity::new(budget);
    let support_count: usize = reply["items"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|item| item["supports"].as_array().map_or(0, Vec::len))
        .sum();
    if support_count <= 50 && capacity.fits(&reply) {
        return Ok(reply);
    }
    let original = reply.clone();
    let items = original["items"]
        .as_array()
        .ok_or(Error::new("invalid_input"))?;
    // 完整短条件先占空间；清空正文时将本回执映射还原为完整支持内容。
    for (index, item) in items.iter().enumerate() {
        if item["kind"] == "knowledge" && item["state"] == "ok" {
            let mut minimal = knowledge_content(item, 0)?;
            for support in minimal["supports"].as_array_mut().into_iter().flatten() {
                if let Some(path) = support["delivered_in"]["path"].as_str() {
                    let text = original
                        .pointer(path)
                        .and_then(Value::as_str)
                        .ok_or(Error::new("invalid_input"))?;
                    let offset = support["delivered_in"]["locator"]["offset"]
                        .as_u64()
                        .ok_or(Error::new("invalid_input"))?
                        as usize;
                    let length = support["delivered_in"]["locator"]["length"]
                        .as_u64()
                        .ok_or(Error::new("invalid_input"))?
                        as usize;
                    if offset + length > text.chars().count() {
                        return Err(Error::new("invalid_input"));
                    }
                    support["content"] =
                        json!(text.chars().skip(offset).take(length).collect::<String>());
                    support
                        .as_object_mut()
                        .ok_or(crate::types::Error::new("unavailable"))?
                        .remove("delivered_in");
                }
            }
            reply["items"][index] = minimal;
        } else if item["kind"] == "skill" && item["state"] == "ok" {
            memory_content(
                &mut reply["items"][index]["asset"],
                &item["asset"],
                "scope",
                0,
            )?;
        } else if item["kind"] == "memory" && item["state"] == "ok" {
            for field in ["body", "scope", "source_text"] {
                memory_content(
                    &mut reply["items"][index]["asset"],
                    &item["asset"],
                    field,
                    0,
                )?;
            }
        }
    }
    let full_supports = reply["items"]
        .as_array()
        .ok_or(crate::types::Error::new("unavailable"))?
        .iter()
        .map(|item| item["supports"].as_array().cloned().unwrap_or_default())
        .collect::<Vec<_>>();
    for (index, item) in items.iter().enumerate() {
        if item["kind"] == "knowledge" && item["state"] == "ok" {
            let position = support_pages[index]
                .as_ref()
                .ok_or(Error::new("invalid_input"))?;
            knowledge_support_page(&mut reply["items"][index], Vec::new(), position)?;
        }
    }
    if !capacity.fits(&reply) {
        return Err(Error::new("tool_response_capacity"));
    }
    let mut support_count = 0;
    for (index, item) in items.iter().enumerate() {
        if item["kind"] != "knowledge" || item["state"] != "ok" {
            continue;
        }
        let position = support_pages[index]
            .as_ref()
            .ok_or(Error::new("invalid_input"))?;
        let mut selected = Vec::new();
        for saved in &full_supports[index] {
            if support_count == 50 {
                break;
            }
            selected.push(saved.clone());
            knowledge_support_page(&mut reply["items"][index], selected.clone(), position)?;
            if !capacity.fits(&reply) {
                // 余量只分片仍有剩余内容的长条件；完整短支持装不下就留到下页，
                // 不切半条冒充可分页。
                let mut low = 0;
                let mut high =
                    if support_count == 0 || saved["content_page"]["next_offset"].is_u64() {
                        saved["content"].as_str().unwrap_or("").chars().count()
                    } else {
                        0
                    };
                while low < high {
                    let keep = (low + high).div_ceil(2);
                    *selected
                        .last_mut()
                        .ok_or(crate::types::Error::new("unavailable"))? =
                        support_content(saved, keep)?;
                    knowledge_support_page(&mut reply["items"][index], selected.clone(), position)?;
                    if capacity.fits(&reply) {
                        low = keep;
                    } else {
                        high = keep - 1;
                    }
                }
                if low > 0 {
                    *selected
                        .last_mut()
                        .ok_or(crate::types::Error::new("unavailable"))? =
                        support_content(saved, low)?;
                    support_count += 1;
                } else {
                    selected.pop();
                }
                knowledge_support_page(&mut reply["items"][index], selected.clone(), position)?;
                break;
            }
            support_count += 1;
        }
    }
    for (index, item) in items.iter().enumerate() {
        if item["kind"] != "knowledge" || item["state"] != "ok" {
            continue;
        }
        let base = reply["items"][index].clone();
        let mut low = 0;
        let mut high = item["content"]
            .as_str()
            .ok_or(Error::new("invalid_input"))?
            .chars()
            .count();
        while low < high {
            let keep = (low + high).div_ceil(2);
            let mut candidate = knowledge_content(item, keep)?;
            candidate["supports"] = base["supports"].clone();
            candidate["support_state"] = base["support_state"].clone();
            candidate["continuation"]["supports_next_cursor"] =
                base["continuation"]["supports_next_cursor"].clone();
            reply["items"][index] = candidate;
            if capacity.fits(&reply) {
                low = keep;
            } else {
                high = keep - 1;
            }
        }
        let mut final_item = knowledge_content(item, low)?;
        final_item["supports"] = base["supports"].clone();
        final_item["support_state"] = base["support_state"].clone();
        final_item["continuation"]["supports_next_cursor"] =
            base["continuation"]["supports_next_cursor"].clone();
        reply["items"][index] = final_item;
    }
    // 身份先保留；记忆填所选部分，Skill范围可经原生路径补全。
    for (index, item) in items.iter().enumerate() {
        if !matches!(item["kind"].as_str(), Some("memory" | "skill")) || item["state"] != "ok" {
            continue;
        }
        let field = if item["kind"] == "skill" {
            "scope"
        } else {
            item["part"].as_str().ok_or(Error::new("invalid_input"))?
        };
        let mut low = 0;
        let mut high = item["asset"][field]
            .as_str()
            .ok_or(Error::new("invalid_input"))?
            .chars()
            .count();
        while low < high {
            let keep = (low + high).div_ceil(2);
            memory_content(
                &mut reply["items"][index]["asset"],
                &item["asset"],
                field,
                keep,
            )?;
            if capacity.fits(&reply) {
                low = keep;
            } else {
                high = keep - 1;
            }
        }
        memory_content(
            &mut reply["items"][index]["asset"],
            &item["asset"],
            field,
            low,
        )?;
    }
    let progressed = reply["items"]
        .as_array()
        .ok_or(crate::types::Error::new("unavailable"))?
        .iter()
        .any(|item| {
            item["state"] != "ok"
                || item["kind"] == "skill"
                || (item["kind"] == "memory"
                    && item["part"].as_str().is_some_and(|part| {
                        let page = match part {
                            "body" => "content_page",
                            "scope" => "scope_page",
                            "source_text" => "source_page",
                            _ => return false,
                        };
                        item["asset"][part]
                            .as_str()
                            .is_some_and(|text| !text.is_empty())
                            || item["asset"][page]["next_offset"].is_null()
                    }))
                || item["content"]
                    .as_str()
                    .is_some_and(|text| !text.is_empty())
                || item["supports"]
                    .as_array()
                    .is_some_and(|supports| !supports.is_empty())
                || item["content_page"]["total_chars"] == 0
        });
    if !progressed {
        return Err(Error::new("tool_response_capacity"));
    }
    Ok(reply)
}

fn memory_content(asset: &mut Value, original: &Value, field: &str, keep: usize) -> Result<()> {
    let page_key = match field {
        "body" => "content_page",
        "scope" => "scope_page",
        "source_text" => "source_page",
        _ => return Err(Error::new("invalid_input")),
    };
    let text = original[field]
        .as_str()
        .ok_or(Error::new("invalid_input"))?;
    asset[field] = json!(text.chars().take(keep).collect::<String>());
    asset[page_key] = original[page_key].clone();
    if keep < text.chars().count() {
        let offset = original[page_key]["offset"]
            .as_u64()
            .ok_or(Error::new("invalid_input"))?;
        asset[page_key]["complete"] = json!(false);
        asset[page_key]["next_offset"] = json!(offset + keep as u64);
    }
    Ok(())
}

fn support_content(support: &Value, keep: usize) -> Result<Value> {
    let text = support["content"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?;
    let mut item = support.clone();
    if keep < text.chars().count() {
        let offset = support["content_page"]["offset"].as_u64().unwrap_or(0);
        let total = support["content_page"]["total_chars"]
            .as_u64()
            .unwrap_or(text.chars().count() as u64);
        item["content"] = json!(text.chars().take(keep).collect::<String>());
        item["content_page"] = json!({"offset":offset,"total_chars":total,
            "complete":false,"next_offset":offset+keep as u64});
    }
    Ok(item)
}

fn knowledge_support_page(
    item: &mut Value,
    supports: Vec<Value>,
    page: &super::knowledge_supports::SupportPage,
) -> Result<()> {
    // 实交支持是read_in_tx输出的前缀；游标按原目录位置推进，不按输出下标。
    let positions = &page.positions[..supports.len().min(page.positions.len())];
    let next_cursor = page.selection.next_cursor(&supports, positions)?;
    let incomplete = supports.iter().any(super::knowledge_supports::incomplete);
    item["support_state"] = json!(if page.total.is_some_and(|total| supports.len() < total)
        || incomplete
    {
        "partial"
    } else if item["supports_complete"] == true {
        "delivered"
    } else {
        "unknown"
    });
    item["supports"] = json!(supports);
    item["continuation"]["supports_next_cursor"] = next_cursor;
    Ok(())
}

fn knowledge_content(item: &Value, keep: usize) -> Result<Value> {
    let text = item["content"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?;
    if keep == text.chars().count() {
        return Ok(item.clone());
    }
    let offset = item["content_page"]["offset"]
        .as_u64()
        .ok_or(Error::new("invalid_input"))?;
    let mut item = item.clone();
    item["content"] = json!(text.chars().take(keep).collect::<String>());
    item["content_page"]["complete"] = json!(false);
    item["content_page"]["next_offset"] = json!(offset + keep as u64);
    item["content_state"] = json!("partial");
    item["continuation"]["content_next_offset"] = json!(offset + keep as u64);
    if item["structure_text"].is_string() {
        item["structure_text"] = item["content"].clone();
        item["structure_page"] = item["content_page"].clone();
        item["effective_structure"] = Value::Null;
    }
    Ok(item)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::use_cases::knowledge::{KnowledgeSearch, SearchContinuation};

    #[test]
    fn wide_public_cursor_fits_and_restores_pending_records_after_partial_delivery() {
        let mut vector = retrieval::vector::Candidates::lexical();
        vector.space = Some("demo".into());
        vector.lexical = (0..1000)
            .map(|index| {
                let object = json!({"id":format!("field-{index:048x}"),"version":"1"});
                let entry = json!({"entry_id":"meaning","path":"meaning","statement_id":null});
                let record = crate::types::knowledge_record_id("demo", &object, &entry, 0);
                json!({"id":object["id"],"version":"1","space_id":"demo","record_id":record,
                "matches":[{"entry_id":"meaning","path":"meaning","offset":0,"length":360,
                    "content_hash":fingerprint(&json!(["wide-window",index])),"score":400-index}]})
            })
            .collect();
        let window = SearchContinuation::capture(&vector, &[vec![], vec![]], &[]).unwrap();
        let ranking = window
            .rank_window("unmatched", vector.lexical.clone())
            .unwrap()
            .sequence;
        let search = KnowledgeSearch {
            objects: vec![],
            hits: vec![],
            pending: vec![],
            coverage: json!({}),
            scan_progress: json!({}),
            continuation: Some(window),
        };
        for task in [
            None,
            Some(("00000000-0000-4000-8000-000000000001".into(), 1)),
        ] {
            let selection = SearchSelection {
                binding: "b".repeat(64),
                scope: "s".repeat(64),
                task,
            };
            for delivered in [0, 20, 999] {
                let retired: Vec<_> = ranking[..delivered]
                    .iter()
                    .map(|(_, key)| key.clone())
                    .collect();
                let next = selection
                    .next(&search, &retired)
                    .expect("完整公共游标必须能保留未交付宽窗");
                let cursor = next.as_str().unwrap();
                println!(
                    "wide_public_cursor_bytes={} delivered={delivered} task={}",
                    cursor.len(),
                    selection.task.is_some()
                );
                assert!(cursor.len() <= 65_536);
                assert!(ResponseCapacity::new(None).fits(&json!({"hits":[{"definition":"合成字段含义"}],"search_coverage":{"next":cursor}})),
                    "转义后的公共游标仍须给实际搜索回执留出容量");
                let restored = selection
                    .restore(SearchCursorInput::Inline(cursor))
                    .unwrap();
                restored.assert_pending_knowledge(&vector.lexical).unwrap();
                assert_eq!(
                    restored
                        .rank_window("unmatched", vector.lexical.clone())
                        .unwrap()
                        .sequence,
                    ranking[delivered..]
                );
            }
        }
    }

    #[test]
    fn legacy_cursor_remains_readable_and_compressed_input_is_bounded_and_checked() {
        let mut vector = retrieval::vector::Candidates::lexical();
        vector.lexical = vec![
            json!({"id":"synthetic-owner","version":"1","record_id":"synthetic-record",
            "matches":[{"entry_id":"body","path":"body","offset":0,"length":20,"score":1.0}]}),
        ];
        let window = SearchContinuation::capture(&vector, &[vec![], vec![]], &[]).unwrap();
        let search = KnowledgeSearch {
            objects: vec![],
            hits: vec![],
            pending: vec![],
            coverage: json!({}),
            scan_progress: json!({}),
            continuation: Some(window),
        };
        let selection = SearchSelection {
            binding: "b".repeat(64),
            scope: "s".repeat(64),
            task: None,
        };
        let next = selection.next(&search, &[]).unwrap();
        let legacy = next.as_str().unwrap();
        assert!(legacy.starts_with('{'));
        selection
            .restore(SearchCursorInput::Inline(legacy))
            .unwrap()
            .assert_pending_knowledge(&vector.lexical)
            .unwrap();

        let mut gzip = GzEncoder::new(Vec::new(), Compression::default());
        gzip.write_all(legacy.as_bytes()).unwrap();
        let bytes = gzip.finish().unwrap();
        let compressed = format!("gz1:{}", URL_SAFE_NO_PAD.encode(&bytes));
        selection
            .restore(SearchCursorInput::Inline(&compressed))
            .unwrap()
            .assert_pending_knowledge(&vector.lexical)
            .unwrap();
        let mut corrupt = bytes.clone();
        *corrupt.last_mut().unwrap() ^= 1;
        let mut trailing = bytes;
        trailing.push(0);
        for input in [
            "gz1:*".to_owned(),
            format!("gz1:{}", URL_SAFE_NO_PAD.encode(corrupt)),
            format!("gz1:{}", URL_SAFE_NO_PAD.encode(trailing)),
        ] {
            assert_eq!(
                selection
                    .restore(SearchCursorInput::Inline(&input))
                    .unwrap_err()
                    .code,
                "invalid_cursor"
            );
        }
        let mut gzip = GzEncoder::new(Vec::new(), Compression::default());
        std::io::copy(
            &mut std::io::repeat(b' ').take((SEARCH_SNAPSHOT_BYTES + 1) as u64),
            &mut gzip,
        )
        .unwrap();
        let oversized = format!("gz1:{}", URL_SAFE_NO_PAD.encode(gzip.finish().unwrap()));
        assert!(oversized.len() < 65_536);
        assert_eq!(
            selection
                .restore(SearchCursorInput::Inline(&oversized))
                .unwrap_err()
                .code,
            "invalid_cursor"
        );
    }
}

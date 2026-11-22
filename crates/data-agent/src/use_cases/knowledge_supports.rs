use crate::{
    contracts::generated::{EvidenceRef, SourceCitation},
    modules::knowledge,
    persistence::AppTx,
    types::{AccessContext, Error, Result},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

// v1游标只有next/content_offset；v2绑定有界当前页：原窗口边界、已无剩余内容的
// 成员位置、唯一续读成员与修订内容指纹。位置沿用目录1基序号；回执内先交短支持
// 的重排不改目录，续读仍指原成员。
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SupportCursor {
    schema: u8,
    binding: String,
    revision: String,
    condition_version: Option<u64>,
    #[serde(default)]
    next: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    content_offset: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    page_start: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    page_end: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    consumed: Vec<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    resume_position: Option<usize>,
}

// 游标解码后的读取状态：首读或v1薄转换从next起新窗并续读窗首成员；v2携带当前
// 窗与成员进度。
enum PageState {
    Fresh {
        next: usize,
        content_offset: Option<usize>,
    },
    Window {
        start: usize,
        end: usize,
        fingerprint: String,
        consumed: Vec<usize>,
        resume: Option<(usize, usize)>,
    },
}

// read_in_tx记录本次实际窗口边界与内容指纹；未读页时游标只能按v1原地重发。
struct PageContext {
    start: usize,
    end: usize,
    total: usize,
    fingerprint: String,
}

pub(super) struct SupportSelection {
    binding: String,
    revision: String,
    condition_version: Option<u64>,
    state: PageState,
    page: Option<PageContext>,
}

impl SupportSelection {
    pub fn new(
        binding: &Value,
        revision: &str,
        condition_version: Option<u64>,
        cursor: Option<&str>,
    ) -> Result<Self> {
        let binding = crate::types::fingerprint(binding);
        let state = if let Some(cursor) = cursor {
            let saved: SupportCursor =
                serde_json::from_str(cursor).map_err(|_| Error::new("invalid_cursor"))?;
            if (saved.schema != 1 && saved.schema != 2) || saved.binding != binding {
                return Err(Error::new("invalid_cursor"));
            }
            if saved.revision != revision || saved.condition_version != condition_version {
                return Err(Error::new("stale_cursor"));
            }
            match saved.schema {
                1 => PageState::Fresh {
                    next: saved.next,
                    content_offset: saved.content_offset,
                },
                _ => {
                    let (start, end) = (
                        saved.page_start.ok_or(Error::new("invalid_cursor"))?,
                        saved.page_end.ok_or(Error::new("invalid_cursor"))?,
                    );
                    // 游标是模型可回传的输入：窗口和成员位置须自洽，不能拿越界
                    // 位置套当前目录。
                    if start == 0 || end < start || end - start + 1 > 50 {
                        return Err(Error::new("invalid_cursor"));
                    }
                    let resume = saved
                        .resume_position
                        .map(|position| (position, saved.content_offset.unwrap_or(0)));
                    if saved
                        .consumed
                        .iter()
                        .any(|position| !(start..=end).contains(position))
                        || resume.is_some_and(|(position, _)| {
                            !(start..=end).contains(&position) || saved.consumed.contains(&position)
                        })
                    {
                        return Err(Error::new("invalid_cursor"));
                    }
                    PageState::Window {
                        start,
                        end,
                        fingerprint: saved.fingerprint.unwrap_or_default(),
                        consumed: saved.consumed,
                        resume,
                    }
                }
            }
        } else {
            PageState::Fresh {
                next: 0,
                content_offset: None,
            }
        };
        Ok(Self {
            binding,
            revision: revision.to_owned(),
            condition_version,
            state,
            page: None,
        })
    }

    // 按本回实交支持推进游标：位置必须是原目录位置，短支持完整交付即消费；分片
    // 长条件剩余内容记原位置+Unicode偏移。窗内成员全部无剩余内容才推进到页末并
    // 丢弃成员状态，此前页短支持不算本页交付依据。
    pub(super) fn next_cursor(&self, supports: &[Value], positions: &[usize]) -> Result<Value> {
        let Some(page) = &self.page else {
            // 本轮没有实际读页（如检索期限已到）：按v1原地重发位置，不虚构窗口。
            return self.legacy_cursor();
        };
        let (mut consumed, mut resume) = match &self.state {
            PageState::Fresh { content_offset, .. } => (
                Vec::new(),
                content_offset
                    .filter(|offset| *offset > 0)
                    .map(|offset| (page.start, offset)),
            ),
            PageState::Window {
                consumed, resume, ..
            } => (consumed.clone(), *resume),
        };
        for (support, position) in supports.iter().zip(positions) {
            if let Some(next_offset) = support["content_page"]["next_offset"].as_u64() {
                resume = Some((*position, next_offset as usize));
            } else {
                if resume.is_some_and(|(pending, _)| pending == *position) {
                    resume = None;
                }
                consumed.push(*position);
            }
        }
        consumed.sort_unstable();
        consumed.dedup();
        if resume.is_none() && (page.start..=page.end).all(|position| consumed.contains(&position))
        {
            if page.end >= page.total {
                return Ok(Value::Null);
            }
            return self.window_cursor(
                page.end + 1,
                (page.end + 50).min(page.total),
                Vec::new(),
                None,
                &page.fingerprint,
            );
        }
        self.window_cursor(page.start, page.end, consumed, resume, &page.fingerprint)
    }

    fn window_cursor(
        &self,
        start: usize,
        end: usize,
        consumed: Vec<usize>,
        resume: Option<(usize, usize)>,
        fingerprint: &str,
    ) -> Result<Value> {
        Ok(json!(
            serde_json::to_string(&SupportCursor {
                schema: 2,
                binding: self.binding.clone(),
                revision: self.revision.clone(),
                condition_version: self.condition_version,
                next: start.saturating_sub(1),
                content_offset: resume.map(|(_, offset)| offset),
                page_start: Some(start),
                page_end: Some(end),
                fingerprint: Some(fingerprint.to_owned()),
                consumed,
                resume_position: resume.map(|(position, _)| position),
            })
            .map_err(|_| Error::new("invalid_cursor"))?
        ))
    }

    fn legacy_cursor(&self) -> Result<Value> {
        let (next, content_offset) = match &self.state {
            PageState::Fresh {
                next,
                content_offset,
            } => (*next, *content_offset),
            PageState::Window { start, resume, .. } => {
                (start.saturating_sub(1), resume.map(|(_, offset)| offset))
            }
        };
        Ok(json!(
            serde_json::to_string(&SupportCursor {
                schema: 1,
                binding: self.binding.clone(),
                revision: self.revision.clone(),
                condition_version: self.condition_version,
                next,
                content_offset,
                page_start: None,
                page_end: None,
                fingerprint: None,
                consumed: Vec::new(),
                resume_position: None,
            })
            .map_err(|_| Error::new("invalid_cursor"))?
        ))
    }
}

pub(super) fn incomplete(support: &Value) -> bool {
    (support["content"].is_null() && support.get("delivered_in").is_none())
        || (support.get("content_page").is_some() && support["content_page"]["complete"] != true)
}

pub(super) struct SupportPage {
    pub selection: SupportSelection,
    pub total: Option<usize>,
    // 与read_in_tx本回输出平行的原目录位置；容量裁掉尾部时按前缀对齐。
    pub positions: Vec<usize>,
}

pub(super) struct VisibleSupportContent<'a> {
    pub field: Option<&'a str>,
    pub offset: u64,
    pub text: &'a str,
    pub path: &'a str,
}

pub(super) struct SupportRead<'a> {
    pub reference: &'a EvidenceRef,
    pub statement_id: Option<&'a str>,
    pub selection: &'a mut SupportSelection,
    pub visible: &'a [VisibleSupportContent<'a>],
}

// 只展开所选陈述已保存的必要支持；不沿普通关系或支持的支持递归搜索。
// 本页先完整交可容纳的短支持，最多用余量分片一条长条件（记原位置+偏移），
// 其余长条件留在窗内等后续回执，不预读整页长正文。
pub(super) async fn read_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    read: SupportRead<'_>,
    gate: Option<&super::source_limits::SourceGate>,
) -> Result<Value> {
    let SupportRead {
        reference,
        statement_id,
        selection,
        visible,
    } = read;
    let (offset, limit, consumed, resume) = match &selection.state {
        PageState::Fresh {
            next,
            content_offset,
        } => (
            *next,
            50,
            Vec::new(),
            content_offset
                .filter(|offset| *offset > 0)
                .map(|offset| (*next + 1, offset)),
        ),
        PageState::Window {
            start,
            end,
            consumed,
            resume,
            ..
        } => (*start - 1, end - start + 1, consumed.clone(), *resume),
    };
    let page =
        knowledge::read_supports_in_tx(tx, ctx, reference, statement_id, offset, limit).await?;
    let total = page["total"].as_u64().ok_or(Error::new("invalid_input"))? as usize;
    // 同版重整会推进knowledge_revisions.fingerprint；旧窗指纹不符时原位置不能
    // 套新目录成员。
    let fingerprint = knowledge::read_revision_fingerprint_in_tx(
        tx,
        &reference.object_id,
        crate::types::epoch(&reference.version)?,
    )
    .await?;
    if let PageState::Window {
        fingerprint: bound, ..
    } = &selection.state
        && bound != &fingerprint
    {
        return Err(Error::new("stale_cursor"));
    }
    let items = page["supports"]
        .as_array()
        .ok_or(Error::new("invalid_input"))?
        .clone();
    let start = offset + 1;
    let end = offset + items.len();
    selection.page = Some(PageContext {
        start,
        end,
        total,
        fingerprint,
    });
    let position_of = |saved: &Value| -> Result<usize> {
        Ok(saved["position"]
            .as_u64()
            .ok_or(Error::new("invalid_input"))? as usize)
    };
    // 唯一整读位：优先续读成员（含v1薄转换的中途偏移），否则首个未消费长条件。
    let mut long_index = None;
    for (index, saved) in items.iter().enumerate() {
        let position = position_of(saved)?;
        if consumed.contains(&position) {
            continue;
        }
        if resume.is_some_and(|(pending, _)| pending == position) {
            long_index = Some(index);
            break;
        }
        if saved["content"].is_null() && long_index.is_none() {
            long_index = Some(index);
        }
    }
    let mut supports: Vec<Value> = Vec::new();
    let mut positions: Vec<usize> = Vec::new();
    let deliver = |support: &mut Value, saved: &Value, content_offset: usize| {
        for content in visible {
            let embedded = if let Some(field) = content.field {
                if saved["embedded_in"]["field"] != field {
                    continue;
                }
                saved["embedded_in"]["locator"]["offset"].as_u64()
            } else {
                saved["embedded_offset"].as_u64()
            };
            if statement_id.is_some()
                && content_offset == 0
                && let (Some(embedded), Some(length), Some(expected)) = (
                    embedded,
                    saved["embedded_in"]["locator"]["length"].as_u64(),
                    saved["content"].as_str(),
                )
                && embedded >= content.offset
                && embedded + length <= content.offset + content.text.chars().count() as u64
                && content
                    .text
                    .chars()
                    .skip((embedded - content.offset) as usize)
                    .take(length as usize)
                    .eq(expected.chars())
            {
                support["content"] = Value::Null;
                support["delivered_in"] = json!({"path":content.path,
                    "locator":{"offset":embedded-content.offset,"length":length}});
                break;
            }
        }
    };
    // 支持引用按引用种类核验当前身份与来源；仅对本回实际交付的成员执行。
    async fn check_saved(
        tx: &mut AppTx<'_>,
        ctx: &AccessContext,
        gate: Option<&super::source_limits::SourceGate>,
        support_ref: &Value,
    ) -> Result<()> {
        match support_ref["kind"].as_str() {
            Some("knowledge") => {
                super::knowledge::check_refs_for_task_in_tx(
                    tx,
                    ctx,
                    &json!([support_ref["ref"]]),
                    gate,
                )
                .await?;
            }
            Some("source") => {
                let citation: SourceCitation =
                    serde_json::from_value(support_ref["citation"].clone())
                        .map_err(|_| Error::new("invalid_input"))?;
                let source = if matches!(
                    citation.source.kind,
                    crate::contracts::generated::SourceKeyKind::Document
                ) {
                    format!("document-{}", citation.source.id)
                } else {
                    citation.source.id.clone()
                };
                if let Some(gate) = gate {
                    gate.assert_source_arg(&source)?;
                }
                let meta =
                    super::knowledge_sources::read_meta_in_tx(tx, ctx, &source, None).await?;
                if meta["version"] != citation.revision || meta["complete"] != true {
                    return Err(Error::new("stale_source"));
                }
            }
            _ => return Err(Error::new("invalid_input")),
        }
        Ok(())
    }
    // 先交窗内未消费短支持，保持目录原顺序。
    for (index, saved) in items.iter().enumerate() {
        if Some(index) == long_index {
            continue;
        }
        let position = position_of(saved)?;
        if consumed.contains(&position) {
            continue;
        }
        let mut support = json!({"support_id":saved["support_id"],"role":saved["role"],
            "reference":saved["reference"],"content":saved["content"],"embedded_in":saved["embedded_in"]});
        deliver(&mut support, saved, 0);
        if support["content"].is_null() && support.get("delivered_in").is_none() {
            // 未中签整读位的其余长条件留在窗内，不虚构正文。
            continue;
        }
        check_saved(tx, ctx, gate, &saved["reference"]).await?;
        supports.push(support);
        positions.push(position);
    }
    // 唯一整读位：读一条长条件（或续读成员）的一页正文。
    if let Some(index) = long_index {
        let saved = &items[index];
        let position = position_of(saved)?;
        let content_offset = resume
            .filter(|(pending, _)| *pending == position)
            .map(|(_, offset)| offset)
            .unwrap_or(0);
        check_saved(tx, ctx, gate, &saved["reference"]).await?;
        let support_ref = &saved["reference"];
        let mut support = json!({"support_id":saved["support_id"],"role":saved["role"],
            "reference":support_ref,"content":saved["content"],"embedded_in":saved["embedded_in"]});
        if saved["content_chars"].is_number() && (saved["content"].is_null() || content_offset > 0)
        {
            let content = knowledge::read_support_content_in_tx(
                tx,
                ctx,
                reference,
                (
                    saved["statement_id"]
                        .as_str()
                        .ok_or(Error::new("invalid_input"))?,
                    saved["support_id"]
                        .as_str()
                        .ok_or(Error::new("invalid_input"))?,
                ),
                content_offset,
                8192,
            )
            .await?;
            support["content"] = content["content"].clone();
            support["content_page"] = content["content_page"].clone();
        }
        deliver(&mut support, saved, content_offset);
        if support["content"].is_null() && support.get("delivered_in").is_none() {
            match support_ref["kind"].as_str() {
                Some("source") => {
                    let mut citation: SourceCitation =
                        serde_json::from_value(support_ref["citation"].clone())
                            .map_err(|_| Error::new("invalid_input"))?;
                    let total = citation.locator.length as usize;
                    if content_offset > total {
                        return Err(Error::new("invalid_cursor"));
                    }
                    citation.locator.offset += content_offset as i64;
                    citation.locator.length -= content_offset as i64;
                    let excerpt =
                        super::knowledge_sources::read_citation_page_in_tx(tx, ctx, citation, 8192)
                            .await?;
                    let end = content_offset + excerpt.text.chars().count();
                    support["content"] = json!(excerpt.text);
                    if content_offset > 0 || end < total {
                        support["content_page"] = json!({"offset":content_offset,"total_chars":total,
                            "complete":content_offset==0 && end==total,
                            "next_offset":if end<total{Some(end)}else{None}});
                    }
                }
                Some("knowledge") => {
                    let reference: EvidenceRef = serde_json::from_value(support_ref["ref"].clone())
                        .map_err(|_| Error::new("invalid_input"))?;
                    let read = knowledge::read_entry_page_in_tx(
                        tx,
                        ctx,
                        &reference,
                        None,
                        false,
                        content_offset,
                        8192,
                    )
                    .await?;
                    support["content"] = read["content"].clone();
                    if content_offset > 0 || read["content_page"]["complete"] != true {
                        support["content_page"] = read["content_page"].clone();
                    }
                }
                _ => unreachable!(),
            }
        }
        supports.push(support);
        positions.push(position);
    }
    let next_cursor = selection.next_cursor(&supports, &positions)?;
    Ok(
        json!({"next_cursor":next_cursor,"supports":supports,"total":total,
        "positions":positions}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::generated::SourceKey;
    use crate::types::AccessContext;
    use serde_json::json;

    // 同版本重整支持经真实persist推进knowledge_revisions.fingerprint；携带旧指纹
    // 的v2游标不得把旧窗口位置套到重整后的目录成员上。
    #[tokio::test]
    async fn same_version_support_change_invalidates_window_cursor() {
        let Ok(url) = std::env::var("DATA_AGENT_DATABASE_URL") else {
            return;
        };
        assert!(url.contains("/data_agent_test_"));
        let pool = crate::persistence::connect(&url).await.unwrap();
        let ctx = AccessContext {
            user_id: "alice".into(),
            space_id: "support-cursor-fingerprint".into(),
            request_id: "support-cursor-fingerprint".into(),
            table_access: None,
        };
        let object_id = "support-fingerprint-doc";
        let source = SourceKey {
            id: object_id.to_string(),
            kind: crate::contracts::generated::SourceKeyKind::Document,
        };
        let citation = json!({"source": {"id": object_id, "kind": "document"},
            "revision": "1", "locator": {"offset": 0, "length": 6}});
        let preparation = |long_content: &str, short_content: &str| {
            json!({"statements": [{"key": "fingerprint-rule",
                "target": {"object_id": object_id, "version": "1", "path": "body"},
                "text": "合成规则。", "scope_text": "", "citations": [citation],
                "supports_complete": true,
                "supports": [
                    {"key": "long-condition", "role": "prerequisite",
                     "reference": {"kind": "source", "citation": citation},
                     "content": long_content, "embedded_in": null},
                    {"key": "short-exception", "role": "exception",
                     "reference": {"kind": "source", "citation": citation},
                     "content": short_content, "embedded_in": null},
                ]}],
                "relations": [], "unresolved": [], "semantic_status": "ready"})
        };
        let mut tx = AppTx::begin(&pool).await.unwrap();
        knowledge::seed_in_tx(
            &mut tx,
            &ctx,
            &json!({"objects":[
                {"id": object_id, "kind": "document", "name": "合成支持指纹文档",
                 "version": "1", "state": "enabled", "source_id": null, "source_version": "0",
                 "related_ids": [],
                 "entries": [{"entry_id": "body", "path": "body", "effective_value": "合成文档正文。"}]}
            ]}),
        )
        .await
        .unwrap();
        let long = "支持指纹🧪。".repeat(1400);
        let saved = knowledge::apply_preparation_in_tx(
            &mut tx,
            &ctx,
            "support-fingerprint-op-1",
            &source,
            "1",
            &preparation(&long, "例外一。"),
        )
        .await
        .unwrap();
        let statement_id = saved[0]["entries"][0]["suggestion"]["statements"][0]["statement_id"]
            .as_str()
            .unwrap()
            .to_string();
        async fn read_page(
            tx: &mut AppTx<'_>,
            ctx: &AccessContext,
            object_id: &str,
            statement_id: &str,
            cursor: Option<&str>,
        ) -> crate::types::Result<Value> {
            let reference: EvidenceRef = serde_json::from_value(json!({
                "object_id": object_id, "version": "1", "path": "body"}))
            .unwrap();
            let binding = json!({"space_id": ctx.space_id, "user_id": ctx.user_id,
                "object_id": object_id, "path": "body", "statement_id": statement_id,
                "structure_only": false, "task_id": null, "limits": null});
            let mut selection = SupportSelection::new(&binding, "1", None, cursor)?;
            read_in_tx(
                tx,
                ctx,
                SupportRead {
                    reference: &reference,
                    statement_id: Some(statement_id),
                    selection: &mut selection,
                    visible: &[],
                },
                None,
            )
            .await
        }
        let first = read_page(&mut tx, &ctx, object_id, &statement_id, None)
            .await
            .unwrap();
        let cursor = first["next_cursor"].as_str().unwrap().to_string();
        let decoded: Value = serde_json::from_str(&cursor).unwrap();
        assert_eq!(decoded["schema"], 2, "新读取必须发v2窗口游标");
        let fingerprint_before = knowledge::read_revision_fingerprint_in_tx(&mut tx, object_id, 1)
            .await
            .unwrap();
        assert_eq!(
            decoded["fingerprint"],
            json!(fingerprint_before),
            "游标绑定当前修订指纹"
        );
        // 同版本重整：短例外换内容、长条件换正文，目录成员内容改变而版本不变。
        knowledge::apply_preparation_in_tx(
            &mut tx,
            &ctx,
            "support-fingerprint-op-2",
            &source,
            "1",
            &preparation(&"支持指纹重整🧪。".repeat(1300), "例外一（重整）。"),
        )
        .await
        .unwrap();
        let fingerprint_after = knowledge::read_revision_fingerprint_in_tx(&mut tx, object_id, 1)
            .await
            .unwrap();
        assert_ne!(
            fingerprint_before, fingerprint_after,
            "同版本支持重整必须推进修订指纹，否则游标无法发现目录变化"
        );
        let error = read_page(&mut tx, &ctx, object_id, &statement_id, Some(&cursor))
            .await
            .unwrap_err();
        assert_eq!(
            error.code, "stale_cursor",
            "旧指纹游标续读须拒绝，不能把旧位置套到新成员"
        );
        tx.commit().await.unwrap();
        pool.close().await;
    }
}

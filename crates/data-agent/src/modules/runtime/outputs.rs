use super::store::{self, LockedRun};
use crate::{
    contracts::generated::{AssistantOutputBinding, RenderedAnswerBinding},
    persistence::AppTx,
    types::{Error, Result},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

fn advance_code_span(segment: &str, code_ticks: &mut usize, newlines: &mut usize) {
    let mut chars = segment.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '`' {
            *newlines = 0;
            let mut run = 1usize;
            while chars.peek() == Some(&'`') {
                chars.next();
                run += 1;
            }
            if *code_ticks == 0 {
                *code_ticks = run;
            } else if *code_ticks == run {
                *code_ticks = 0;
            }
        } else if c == '\n' {
            *newlines += 1;
            if *newlines >= 2 {
                *code_ticks = 0;
            }
        } else if c != '\r' {
            *newlines = 0;
        }
    }
}

// 正文外转义Markdown控制字符防止链接/表格注入；行内反引号代码段内保留原字面值（不注入反斜杠）。
fn format_bound(rendered: &str, in_code_span: bool) -> String {
    rendered.chars().fold(String::new(), |mut output, c| {
        if c == '\n' || c == '\r' {
            output.push(' ');
        } else if in_code_span {
            output.push(if c == '`' { '\'' } else { c });
        } else {
            if matches!(
                c,
                '\\' | '`' | '*' | '_' | '[' | ']' | '<' | '>' | '|' | '#'
            ) {
                output.push('\\');
            }
            output.push(c);
        }
        output
    })
}

// 单次字符串替换：替换值不再扫描、不递归解释；未闭合、未知或漏引必选比较标记拒绝。
// 展示等式属输出职责，use_cases向下调用这一份实现，不复制第二份。
pub fn substitute(template: &str, bindings: &BTreeMap<String, String>) -> Result<String> {
    substitute_required(template, bindings, &[])
}

pub fn substitute_required(
    template: &str,
    bindings: &BTreeMap<String, String>,
    required_markers: &[String],
) -> Result<String> {
    let mut output = String::new();
    let mut remaining = template;
    let mut code_ticks = 0usize;
    let mut newlines = 0usize;
    let mut used = BTreeSet::new();
    while let Some(start) = remaining.find("{{") {
        let prefix = &remaining[..start];
        advance_code_span(prefix, &mut code_ticks, &mut newlines);
        output.push_str(prefix);
        let after = &remaining[start + 2..];
        let end = after.find("}}").ok_or(Error::new("invalid_evidence"))?;
        let name = &after[..end];
        let raw = bindings.get(name).ok_or(Error::new("invalid_evidence"))?;
        used.insert(name);
        let formatted = format_bound(raw, code_ticks > 0);
        if !formatted.is_empty() {
            newlines = 0;
        }
        output.push_str(&formatted);
        remaining = &after[end + 2..];
    }
    if remaining.contains("}}")
        || required_markers
            .iter()
            .any(|marker| !used.contains(marker.as_str()))
    {
        return Err(Error::new("invalid_evidence"));
    }
    advance_code_span(remaining, &mut code_ticks, &mut newlines);
    output.push_str(remaining);
    Ok(output)
}

// 冻结/finish入口按同一等式重渲染：display = replace_once(source_text, bindings) + required_suffix。
pub fn display_from_preparation(source_text: &str, prepared: &Value) -> Result<String> {
    let mut bindings = BTreeMap::new();
    for (name, value) in prepared["bindings"]
        .as_object()
        .ok_or(Error::new("invalid_evidence"))?
    {
        bindings.insert(
            name.clone(),
            value
                .as_str()
                .ok_or(Error::new("invalid_evidence"))?
                .to_owned(),
        );
    }
    let mut required = Vec::new();
    if let Some(comparisons) = prepared.get("comparisons").and_then(Value::as_array) {
        for item in comparisons {
            let name = item["name"]
                .as_str()
                .ok_or(Error::new("invalid_evidence"))?;
            if !bindings.contains_key(name) {
                return Err(Error::new("invalid_evidence"));
            }
            required.push(name.to_owned());
        }
    }
    let mut display = substitute_required(source_text, &bindings, &required)?;
    display.push_str(
        prepared["required_suffix"]
            .as_str()
            .ok_or(Error::new("invalid_evidence"))?,
    );
    Ok(display)
}

pub async fn append_output_in_tx(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
    seq: u64,
    body: &str,
) -> Result<()> {
    let last = store::last_chunk_sequence(tx, run).await?;
    if seq <= last {
        let previous = store::chunk_text(tx, run, seq)
            .await?
            .ok_or(Error::new("chunk_gap"))?;
        if previous != body {
            return Err(Error::new("idempotency_conflict"));
        }
        return Ok(());
    }
    if seq != last + 1 {
        return Err(Error::new("chunk_gap"));
    }
    store::insert_chunk(tx, run, seq, body).await
}
pub async fn read_output_text_in_tx(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
    start_seq: u64,
) -> Result<(String, OutputChunkRange)> {
    let chunks = store::chunks(tx, run).await?;
    let last = chunks.last().map(|(seq, _)| *seq).unwrap_or(0);
    let text = assemble_output(chunks, start_seq)?;
    Ok((
        text,
        OutputChunkRange {
            attempt_id: run.attempt_id.clone(),
            first: start_seq,
            last,
        },
    ))
}

pub async fn read_bound_output_in_tx(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
    binding: &crate::contracts::generated::AssistantOutputBinding,
) -> Result<String> {
    let (first, last) = bound_output_range(binding)?;
    let chunks = store::attempt_chunks(tx, run, &binding.attempt_id).await?;
    bound_output_text(chunks, binding, first, last)
}

/// 冻结/finish入口核rendered分支：按run身份加载原prepare回执，重渲染display
/// 并核对展示chunk范围；返回(display, 范围, prepare回执data)供来源核验复用。
pub async fn read_rendered_in_tx(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
    binding: &RenderedAnswerBinding,
) -> Result<(String, OutputChunkRange)> {
    let tool = super::read_prepare_tool_in_tx(tx, run, &binding.prepared_sdk_tool_call_id)
        .await?
        .ok_or(Error::new("invalid_evidence"))?;
    let prepared = tool
        .receipt
        .as_ref()
        .ok_or(Error::new("invalid_evidence"))?["data"]
        .clone();
    let display = rendered_display(binding, &prepared)?;
    let chunks = store::attempt_chunks(tx, run, &binding.assistant.attempt_id).await?;
    rendered_output_text(chunks, binding, &display)?;
    Ok((
        display,
        OutputChunkRange {
            attempt_id: binding.assistant.attempt_id.clone(),
            first: crate::types::epoch(&binding.first_chunk_seq)?,
            last: crate::types::epoch(&binding.last_chunk_seq)?,
        },
    ))
}

fn bound_output_range(binding: &AssistantOutputBinding) -> Result<(u64, u64)> {
    let first = binding
        .first_chunk_seq
        .as_deref()
        .ok_or(Error::new("chunk_gap"))?;
    let last = binding
        .last_chunk_seq
        .as_deref()
        .ok_or(Error::new("chunk_gap"))?;
    Ok((crate::types::epoch(first)?, crate::types::epoch(last)?))
}

fn bound_output_text(
    chunks: Vec<(u64, String)>,
    binding: &AssistantOutputBinding,
    first: u64,
    last: u64,
) -> Result<String> {
    use sha2::{Digest, Sha256};
    // 选择局部范围仍核完整前缀，不能用后缀掩盖先前缺片段。
    let _ = assemble_output(chunks.clone(), first)?;
    if last < first || last > chunks.len() as u64 {
        return Err(Error::new("chunk_gap"));
    }
    let text: String = chunks
        .into_iter()
        .filter(|(seq, _)| *seq >= first && *seq <= last)
        .map(|(_, body)| body)
        .collect();
    if format!("{:x}", Sha256::digest(text.as_bytes())) != binding.text_sha256 {
        return Err(Error::new("chunk_gap"));
    }
    Ok(text)
}

pub struct OutputReadUnit {
    pub text: String,
    pub authorities: Vec<Value>,
    pub result_dependencies: Vec<(String, String)>,
    pub chunk_range: Option<OutputChunkRange>,
    pub answer_sdk_tool_call_id: Option<String>,
    /// 新rendered输出单元的原prepare身份；旧单元可缺省。
    pub prepared_sdk_tool_call_id: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OutputChunkRange {
    pub attempt_id: String,
    pub first: u64,
    pub last: u64,
}

impl OutputChunkRange {
    pub fn from_binding(binding: &AssistantOutputBinding) -> Result<Self> {
        let (first, last) = bound_output_range(binding)?;
        Ok(Self {
            attempt_id: binding.attempt_id.clone(),
            first,
            last,
        })
    }
}

pub(crate) const ANSWER_SEPARATOR: &str = "\n\n---\n\n";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PersistedOutputReadBinding {
    schema: u8,
    units: Vec<PersistedOutputReadUnit>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedOutputReadUnit {
    start_byte: usize,
    end_byte: usize,
    authorities: Vec<Value>,
    result_dependencies: Vec<(String, String)>,
    chunk_range: Option<OutputChunkRange>,
    answer_sdk_tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    prepared_sdk_tool_call_id: Option<String>,
}

pub(super) struct OutputHistoryRow {
    pub attempt_id: String,
    pub state: String,
    pub final_text: Option<String>,
    pub binding: Option<Value>,
    pub authority: Value,
    pub legacy_sources: Option<Value>,
}

pub struct OutputHistory {
    pub attempt_id: String,
    pub state: String,
    pub units: Result<Vec<OutputReadUnit>>,
    pub delta_authority: Value,
}

#[derive(Deserialize)]
struct LegacyAnswerSource {
    authority: Option<Value>,
    answer: Option<SourceAnswer>,
}

impl OutputHistoryRow {
    fn read_units(&mut self) -> Result<Vec<OutputReadUnit>> {
        if self.state != "committed" {
            return Ok(Vec::new());
        }
        let text = self
            .final_text
            .take()
            .ok_or(Error::new("invalid_evidence"))?;
        let Some(binding) = self.binding.take() else {
            // 旧行只整份展示，复用原运行、冻结项和按原文匹配的成功答案依据。
            let mut authorities = vec![self.authority.clone()];
            let mut results = Vec::new();
            if let Some(sources) = self.legacy_sources.take() {
                let sources: Vec<LegacyAnswerSource> =
                    serde_json::from_value(sources).map_err(|_| Error::new("invalid_evidence"))?;
                for source in sources {
                    authorities.extend(source.authority);
                    if let Some(answer) = source.answer {
                        results.extend(
                            answer
                                .sources
                                .into_iter()
                                .chain(answer.result_dependencies)
                                .map(|source| (source.query_id, source.result_ref)),
                        );
                    }
                }
            }
            return Ok(vec![OutputReadUnit {
                text,
                authorities,
                result_dependencies: results,
                chunk_range: None,
                answer_sdk_tool_call_id: None,
                prepared_sdk_tool_call_id: None,
            }]);
        };
        let binding: PersistedOutputReadBinding =
            serde_json::from_value(binding).map_err(|_| Error::new("invalid_evidence"))?;
        if binding.schema != 1 || binding.units.is_empty() {
            return Err(Error::new("invalid_evidence"));
        }
        let mut end = 0;
        let mut units = Vec::new();
        for unit in binding.units {
            let separator = if units.is_empty() {
                ""
            } else {
                ANSWER_SEPARATOR
            };
            if text.get(end..unit.start_byte) != Some(separator) || unit.authorities.is_empty() {
                return Err(Error::new("invalid_evidence"));
            }
            let body = text
                .get(unit.start_byte..unit.end_byte)
                .ok_or(Error::new("invalid_evidence"))?;
            end = unit.end_byte;
            units.push(OutputReadUnit {
                text: body.to_owned(),
                authorities: unit.authorities,
                result_dependencies: unit.result_dependencies,
                chunk_range: unit.chunk_range,
                answer_sdk_tool_call_id: unit.answer_sdk_tool_call_id,
                prepared_sdk_tool_call_id: unit.prepared_sdk_tool_call_id,
            });
        }
        if end != text.len() {
            return Err(Error::new("invalid_evidence"));
        }
        Ok(units)
    }
}

pub async fn read_output_history_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
    attempts: &[String],
) -> Result<Vec<OutputHistory>> {
    let rows = store::output_history_in_tx(tx, cid, attempts).await?;
    Ok(rows
        .into_iter()
        .map(|mut row| {
            let units = row.read_units();
            OutputHistory {
                attempt_id: row.attempt_id,
                state: row.state,
                units,
                delta_authority: row.authority,
            }
        })
        .collect())
}

/// 正文和来源边界在实际拼接时一起产生，读取不重新解释标题或Markdown。
pub struct FinalOutput {
    pub text: String,
    pub(super) read_binding: PersistedOutputReadBinding,
}

impl FinalOutput {
    pub fn answer_sdk_tool_call_ids(&self) -> Vec<String> {
        let mut ids = Vec::new();
        for unit in &self.read_binding.units {
            if let Some(sdk) = &unit.answer_sdk_tool_call_id
                && !ids.contains(sdk)
            {
                ids.push(sdk.clone());
            }
        }
        ids
    }

    /// 实际采用的prepare身份；与present SDK分列，回源/通知消费者按工具种类接原回执。
    pub fn prepared_sdk_tool_call_ids(&self) -> Vec<String> {
        let mut ids = Vec::new();
        for unit in &self.read_binding.units {
            if let Some(sdk) = &unit.prepared_sdk_tool_call_id
                && !ids.contains(sdk)
            {
                ids.push(sdk.clone());
            }
        }
        ids
    }

    /// 正文实际采用的回执清单（SDK+工具种类），供通知覆盖按原工具接回执。
    pub fn adopted_answer_tools(&self) -> Vec<(String, &'static str)> {
        self.answer_sdk_tool_call_ids()
            .into_iter()
            .map(|sdk| (sdk, "present_analysis_answer"))
            .chain(
                self.prepared_sdk_tool_call_ids()
                    .into_iter()
                    .map(|sdk| (sdk, "prepare_analysis_answer")),
            )
            .collect()
    }

    pub fn compose(units: Vec<OutputReadUnit>) -> Self {
        let mut text = String::new();
        let mut bindings = Vec::new();
        for unit in units {
            if !bindings.is_empty() {
                text.push_str(ANSWER_SEPARATOR);
            }
            let start_byte = text.len();
            text.push_str(&unit.text);
            bindings.push(PersistedOutputReadUnit {
                start_byte,
                end_byte: text.len(),
                authorities: unit.authorities,
                result_dependencies: unit.result_dependencies,
                chunk_range: unit.chunk_range,
                answer_sdk_tool_call_id: unit.answer_sdk_tool_call_id,
                prepared_sdk_tool_call_id: unit.prepared_sdk_tool_call_id,
            });
        }
        Self {
            text,
            read_binding: PersistedOutputReadBinding {
                schema: 1,
                units: bindings,
            },
        }
    }
}

#[derive(Deserialize)]
struct SourceAnswer {
    answer_text: String,
    sources: Vec<AnswerResultSource>,
    result_dependencies: Vec<AnswerResultSource>,
}

#[derive(Deserialize)]
struct AnswerResultSource {
    query_id: String,
    result_ref: String,
}

/// 调用方已经核定的成功答案回执，连同原SDK身份保存为一份读取来源。
pub fn answer_read_unit(answer: &Value, authority: Value, sdk: &str) -> Result<OutputReadUnit> {
    let answer: SourceAnswer =
        serde_json::from_value(answer.clone()).map_err(|_| Error::new("invalid_evidence"))?;
    let mut result_dependencies = Vec::new();
    for source in answer.sources.into_iter().chain(answer.result_dependencies) {
        let reference = (source.query_id, source.result_ref);
        if !result_dependencies.contains(&reference) {
            result_dependencies.push(reference);
        }
    }
    Ok(OutputReadUnit {
        text: answer.answer_text,
        authorities: vec![authority],
        result_dependencies,
        chunk_range: None,
        answer_sdk_tool_call_id: Some(sdk.to_owned()),
        prepared_sdk_tool_call_id: None,
    })
}

// rendered分支的展示等式核验：hash对原模板，chunk范围对渲染后display；旧bound_output_text
// 直接把chunks与原文SHA比较，不能原样用于新分支。
pub fn rendered_display(binding: &RenderedAnswerBinding, prepared: &Value) -> Result<String> {
    use sha2::{Digest, Sha256};
    if format!("{:x}", Sha256::digest(binding.source_text.as_bytes()))
        != binding.assistant.text_sha256
    {
        return Err(Error::new("invalid_evidence"));
    }
    let display = display_from_preparation(&binding.source_text, prepared)?;
    if display.trim().is_empty() || display.chars().count() > 8000 {
        return Err(Error::new("invalid_input"));
    }
    Ok(display)
}

fn rendered_output_text(
    chunks: Vec<(u64, String)>,
    binding: &RenderedAnswerBinding,
    display: &str,
) -> Result<()> {
    let first = crate::types::epoch(&binding.first_chunk_seq)?;
    let last = crate::types::epoch(&binding.last_chunk_seq)?;
    // 选择局部范围仍核完整前缀，不能用后缀掩盖先前缺片段。
    let _ = assemble_output(chunks.clone(), first)?;
    if last < first || last > chunks.len() as u64 {
        return Err(Error::new("chunk_gap"));
    }
    let text: String = chunks
        .into_iter()
        .filter(|(seq, _)| *seq >= first && *seq <= last)
        .map(|(_, body)| body)
        .collect();
    if text != display {
        return Err(Error::new("invalid_evidence"));
    }
    Ok(())
}

// prepare回执的来源依赖与present同形（query_id/result_ref对）。
pub fn prepared_dependencies(prepared: &Value) -> Result<Vec<(String, String)>> {
    let mut dependencies = Vec::new();
    for source in prepared["sources"].as_array().into_iter().flatten().chain(
        prepared["result_dependencies"]
            .as_array()
            .into_iter()
            .flatten(),
    ) {
        let reference = (
            source["query_id"]
                .as_str()
                .ok_or(Error::new("invalid_evidence"))?
                .to_owned(),
            source["result_ref"]
                .as_str()
                .ok_or(Error::new("invalid_evidence"))?
                .to_owned(),
        );
        if !dependencies.contains(&reference) {
            dependencies.push(reference);
        }
    }
    Ok(dependencies)
}

fn assemble_output(chunks: Vec<(u64, String)>, start_seq: u64) -> Result<String> {
    if start_seq == 0 || start_seq > chunks.len() as u64 {
        return Err(Error::new("chunk_gap"));
    }
    for (index, (seq, _)) in chunks.iter().enumerate() {
        if *seq != index as u64 + 1 {
            return Err(Error::new("chunk_gap"));
        }
    }
    Ok(chunks
        .into_iter()
        .filter(|(seq, _)| *seq >= start_seq)
        .map(|(_, text)| text)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn final_answer_can_follow_process_fragments() {
        let chunks = vec![
            (1, "调查过程".into()),
            (2, "正式".into()),
            (3, "回答".into()),
        ];
        assert_eq!(
            assemble_output(chunks.clone(), 1).unwrap(),
            "调查过程正式回答"
        );
        assert_eq!(assemble_output(chunks, 2).unwrap(), "正式回答");
    }

    #[test]
    fn selecting_the_final_answer_cannot_hide_gaps_or_invalid_bounds() {
        assert!(assemble_output(vec![(1, "过程".into()), (3, "回答".into())], 2).is_err());
        assert!(assemble_output(vec![(1, "过程".into()), (3, "回答".into())], 3).is_err());
        assert!(assemble_output(vec![(1, "回答".into())], 0).is_err());
        assert!(assemble_output(vec![(1, "回答".into())], 2).is_err());
    }
}

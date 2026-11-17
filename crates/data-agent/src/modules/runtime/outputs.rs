use super::store::{self, LockedRun, OutputReadRecord};
use crate::{
    contracts::generated::{
        AnswerHandoff, AnswerPartReference, AssistantOutputBinding, RenderedAnswerBinding,
    },
    persistence::AppTx,
    types::{Error, Result},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};

// 单次字符串替换：替换值不再扫描、不递归解释；未闭合或未知标记拒绝。
// 展示等式属输出职责，use_cases向下调用这一份实现，不复制第二份。
pub fn substitute(template: &str, bindings: &BTreeMap<String, String>) -> Result<String> {
    let mut output = String::new();
    let mut remaining = template;
    while let Some(start) = remaining.find("{{") {
        output.push_str(&remaining[..start]);
        let after = &remaining[start + 2..];
        let end = after.find("}}").ok_or(Error::new("invalid_evidence"))?;
        output.push_str(
            bindings
                .get(&after[..end])
                .ok_or(Error::new("invalid_evidence"))?,
        );
        remaining = &after[end + 2..];
    }
    if remaining.contains("}}") {
        return Err(Error::new("invalid_evidence"));
    }
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
    let mut display = substitute(source_text, &bindings)?;
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

pub struct OutputReadBinding {
    pub attempt_id: String,
    pub output_id: String,
    pub state: String,
    pub units: Vec<OutputReadUnit>,
    pub delta_authority: Value,
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

const ANSWER_SEPARATOR: &str = "\n\n---\n\n";

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

fn persisted_read_units(output: &OutputReadRecord, value: &Value) -> Result<Vec<OutputReadUnit>> {
    let binding: PersistedOutputReadBinding =
        serde_json::from_value(value.clone()).map_err(|_| Error::new("invalid_evidence"))?;
    let text = output
        .final_text
        .as_deref()
        .ok_or(Error::new("invalid_evidence"))?;
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

#[derive(Deserialize)]
struct OutputReadSource {
    sdk_tool_call_id: String,
    handoff: Option<FrozenOutputSource>,
    answer: Option<SourceAnswer>,
    #[serde(default)]
    prepared: Option<Value>,
    control_delivery: Option<ControlOutputSource>,
}

#[derive(Deserialize)]
struct FrozenOutputSource {
    reference: AnswerPartReference,
    handoff: AnswerHandoff,
    #[serde(default)]
    authority: Value,
    title: String,
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

#[derive(Deserialize)]
struct ControlOutputSource {
    text: String,
    #[serde(default)]
    text_authority: Value,
}

/// 历史读取只接回原输出身份与来源；不取得运行租约，也不重新执行交付规则。
pub async fn read_output_bindings_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
    attempts: &[String],
) -> Result<Vec<OutputReadBinding>> {
    let records = store::output_read_records_in_tx(tx, cid, attempts).await?;
    let mut chains = HashMap::<String, Vec<OutputReadSource>>::new();
    let mut bindings = Vec::new();
    for output in records {
        let units = if let Some(binding) = &output.read_binding {
            persisted_read_units(&output, binding)
        } else {
            // 只有旧NULL格式及活跃未提交输出才接回工具链；新提交直接使用原文边界。
            if !chains.contains_key(&output.recovery_chain_id) {
                let sources = store::output_read_sources_in_tx(tx, cid, &output.recovery_chain_id)
                    .await?
                    .into_iter()
                    .map(|value| {
                        serde_json::from_value(value).map_err(|_| Error::new("invalid_evidence"))
                    })
                    .collect::<Result<Vec<_>>>()?;
                chains.insert(output.recovery_chain_id.clone(), sources);
            }
            output_read_units_in_tx(tx, cid, &output, &chains[&output.recovery_chain_id]).await
        };
        let units = match units {
            Ok(units) => units,
            // 缺少原来源边界只限制本次输出，不能将末端run来源冒充整份历史。
            Err(error) if matches!(error.code, "invalid_evidence" | "chunk_gap") => {
                vec![OutputReadUnit {
                    text: output.final_text.clone().unwrap_or_default(),
                    authorities: vec![Value::Null],
                    result_dependencies: Vec::new(),
                    chunk_range: None,
                    answer_sdk_tool_call_id: None,
                    prepared_sdk_tool_call_id: None,
                }]
            }
            Err(error) => return Err(error),
        };
        bindings.push(OutputReadBinding {
            attempt_id: output.attempt_id,
            output_id: output.output_id,
            state: output.state,
            units,
            delta_authority: output.authority,
        });
    }
    Ok(bindings)
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

// 参数为同一定稿读取所需的记录上下文；沿仓库惯例整体传递，不再拆一层私有结构。
#[allow(clippy::too_many_arguments)]
async fn answer_read_unit_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
    output: &OutputReadRecord,
    sources: &[OutputReadSource],
    authority: &Value,
    sdk: Option<&str>,
    binding: Option<&AssistantOutputBinding>,
    rendered: Option<&RenderedAnswerBinding>,
) -> Result<OutputReadUnit> {
    let mut unit = OutputReadUnit {
        text: String::new(),
        authorities: vec![authority.clone()],
        result_dependencies: Vec::new(),
        chunk_range: None,
        answer_sdk_tool_call_id: sdk.map(str::to_owned),
        prepared_sdk_tool_call_id: None,
    };
    if let Some(sdk) = sdk {
        let answer = sources
            .iter()
            .find(|source| source.sdk_tool_call_id == sdk)
            .and_then(|source| source.answer.as_ref())
            .ok_or(Error::new("invalid_evidence"))?;
        unit.text.clone_from(&answer.answer_text);
        for source in answer.sources.iter().chain(&answer.result_dependencies) {
            let reference = (source.query_id.clone(), source.result_ref.clone());
            if !unit.result_dependencies.contains(&reference) {
                unit.result_dependencies.push(reference);
            }
        }
    } else if let Some(rendered) = rendered {
        let prepared = sources
            .iter()
            .find(|source| source.sdk_tool_call_id == rendered.prepared_sdk_tool_call_id)
            .and_then(|source| source.prepared.as_ref())
            .ok_or(Error::new("invalid_evidence"))?;
        let display = rendered_display(rendered, prepared)?;
        let chunks =
            store::output_read_chunks_in_tx(tx, cid, output, &rendered.assistant.attempt_id)
                .await?;
        rendered_output_text(chunks, rendered, &display)?;
        unit.text = display;
        unit.result_dependencies = prepared_dependencies(prepared)?;
        unit.chunk_range = Some(OutputChunkRange {
            attempt_id: rendered.assistant.attempt_id.clone(),
            first: crate::types::epoch(&rendered.first_chunk_seq)?,
            last: crate::types::epoch(&rendered.last_chunk_seq)?,
        });
        unit.prepared_sdk_tool_call_id = Some(rendered.prepared_sdk_tool_call_id.clone());
    } else {
        let binding = binding.ok_or(Error::new("invalid_evidence"))?;
        let (first, last) = bound_output_range(binding)?;
        let chunks = store::output_read_chunks_in_tx(tx, cid, output, &binding.attempt_id).await?;
        unit.text = bound_output_text(chunks, binding, first, last)?;
        unit.chunk_range = Some(OutputChunkRange {
            attempt_id: binding.attempt_id.clone(),
            first,
            last,
        });
    }
    Ok(unit)
}

async fn frozen_read_unit_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
    output: &OutputReadRecord,
    sources: &[OutputReadSource],
    frozen: &FrozenOutputSource,
) -> Result<OutputReadUnit> {
    let mut unit = answer_read_unit_in_tx(
        tx,
        cid,
        output,
        sources,
        &frozen.authority,
        frozen.handoff.answer_sdk_tool_call_id.as_deref(),
        frozen.handoff.assistant.as_ref(),
        frozen.handoff.rendered_answer_binding.as_ref(),
    )
    .await?;
    unit.text = format!("## {}\n\n{}", frozen.title, unit.text);
    Ok(unit)
}

async fn output_read_units_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
    output: &OutputReadRecord,
    sources: &[OutputReadSource],
) -> Result<Vec<OutputReadUnit>> {
    let frozen: Vec<_> = sources
        .iter()
        .filter_map(|source| source.handoff.as_ref())
        .collect();
    let Some(final_text) = &output.final_text else {
        let mut units = Vec::new();
        for part in frozen {
            let attempt = part
                .handoff
                .assistant
                .as_ref()
                .map(|assistant| &assistant.attempt_id)
                .or_else(|| {
                    part.handoff
                        .rendered_answer_binding
                        .as_ref()
                        .map(|rendered| &rendered.assistant.attempt_id)
                });
            if attempt == Some(&output.attempt_id) {
                units.push(frozen_read_unit_in_tx(tx, cid, output, sources, part).await?);
            }
        }
        return Ok(units);
    };
    if let Some(parts) = &output.answer_parts {
        let parts: Vec<AnswerPartReference> =
            serde_json::from_value(parts.clone()).map_err(|_| Error::new("invalid_evidence"))?;
        let mut units = Vec::<OutputReadUnit>::new();
        for reference in parts {
            if let Some(sdk) = &reference.finalized_by_sdk_tool_call_id {
                let part = frozen
                    .iter()
                    .find(|part| part.reference.finalized_by_sdk_tool_call_id.as_ref() == Some(sdk))
                    .ok_or(Error::new("invalid_evidence"))?;
                units.push(frozen_read_unit_in_tx(tx, cid, output, sources, part).await?);
            } else {
                let mut unit = answer_read_unit_in_tx(
                    tx,
                    cid,
                    output,
                    sources,
                    &output.authority,
                    reference.answer_sdk_tool_call_id.as_deref(),
                    reference.output_binding.as_ref(),
                    reference.rendered_answer_binding.as_ref(),
                )
                .await?;
                let mut prefix = units
                    .iter()
                    .map(|unit| unit.text.as_str())
                    .collect::<Vec<_>>()
                    .join("\n\n---\n\n");
                if !prefix.is_empty() {
                    prefix.push_str("\n\n---\n\n");
                }
                // 边界来自已核原文的完整前缀与末项，不按正文分隔符猜切片。
                let tail = final_text
                    .strip_prefix(&prefix)
                    .ok_or(Error::new("invalid_evidence"))?;
                if !tail
                    .strip_suffix(&format!("\n\n{}", unit.text))
                    .is_some_and(|title| title.starts_with("## "))
                {
                    return Err(Error::new("invalid_evidence"));
                }
                unit.text = tail.to_owned();
                units.push(unit);
            }
        }
        if units
            .iter()
            .map(|unit| unit.text.as_str())
            .collect::<Vec<_>>()
            .join("\n\n---\n\n")
            != *final_text
        {
            return Err(Error::new("invalid_evidence"));
        }
        return Ok(units);
    }

    // 单答案未另存SDK引用；同链成功回执与final_text严格相等是提交不变量。
    let mut answer_unit: Option<OutputReadUnit> = None;
    for source in sources.iter().filter(|source| {
        source
            .answer
            .as_ref()
            .is_some_and(|answer| answer.answer_text == *final_text)
    }) {
        let unit = answer_read_unit_in_tx(
            tx,
            cid,
            output,
            sources,
            &output.authority,
            Some(&source.sdk_tool_call_id),
            None,
            None,
        )
        .await?;
        if let Some(saved) = &mut answer_unit {
            for reference in unit.result_dependencies {
                if !saved.result_dependencies.contains(&reference) {
                    saved.result_dependencies.push(reference);
                }
            }
        } else {
            answer_unit = Some(unit);
        }
    }
    if let Some(unit) = answer_unit {
        return Ok(vec![unit]);
    }

    let mut units = Vec::new();
    for part in frozen {
        units.push(frozen_read_unit_in_tx(tx, cid, output, sources, part).await?);
    }
    let mut prefix = units
        .iter()
        .map(|unit| unit.text.as_str())
        .collect::<Vec<_>>()
        .join("\n\n---\n\n");
    if !prefix.is_empty() {
        prefix.push_str("\n\n---\n\n");
    }
    let controls: Vec<_> = sources
        .iter()
        .filter_map(|source| source.control_delivery.as_ref())
        .filter(|control| format!("{}{}", prefix, control.text) == *final_text)
        .collect();
    if let Some(control) = controls.first() {
        units.push(OutputReadUnit {
            text: control.text.clone(),
            authorities: controls
                .iter()
                .map(|control| control.text_authority.clone())
                .collect(),
            result_dependencies: Vec::new(),
            chunk_range: None,
            answer_sdk_tool_call_id: None,
            prepared_sdk_tool_call_id: None,
        });
    } else if units.is_empty() {
        units.push(OutputReadUnit {
            text: final_text.clone(),
            authorities: vec![output.authority.clone()],
            result_dependencies: Vec::new(),
            chunk_range: None,
            answer_sdk_tool_call_id: None,
            prepared_sdk_tool_call_id: None,
        });
    } else {
        return Err(Error::new("invalid_evidence"));
    }
    Ok(units)
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

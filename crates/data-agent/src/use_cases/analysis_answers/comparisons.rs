use super::{single_line, text};
use crate::types::{Error, Result};
use rust_decimal::Decimal;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    str::FromStr,
};

enum OperandOutcome {
    Numeric { decimal: Decimal, raw: String },
    InsufficientData,
}

struct ResolvedOperand {
    label: String,
    locator_identity: (String, Option<usize>, usize),
    row_strings: Option<BTreeSet<String>>,
    outcome: OperandOutcome,
}

fn unique_column_index(result: &Value, column: &str) -> Result<usize> {
    let columns = result["columns"]
        .as_array()
        .ok_or(Error::new("result_unavailable"))?;
    let matches: Vec<_> = columns
        .iter()
        .enumerate()
        .filter(|(_, item)| item["name"] == column)
        .collect();
    if matches.len() != 1 {
        return Err(Error::new("invalid_evidence"));
    }
    Ok(matches[0].0)
}

fn parse_decimal(value: &Value) -> Result<Decimal> {
    match value {
        Value::Number(number) => {
            Decimal::from_str(&number.to_string()).map_err(|_| Error::new("invalid_evidence"))
        }
        Value::String(text) => Decimal::from_str(text).map_err(|_| Error::new("invalid_evidence")),
        _ => Err(Error::new("invalid_evidence")),
    }
}

fn raw_scalar(value: &Value) -> Result<String> {
    match value {
        Value::String(text) => Ok(single_line(text)),
        Value::Number(number) => Ok(number.to_string()),
        _ => Err(Error::new("invalid_evidence")),
    }
}

fn cell_matches(cell: &Value, expected: &Value) -> bool {
    match (cell, expected) {
        (Value::Null, Value::Null) => true,
        (Value::Bool(a), Value::Bool(b)) => a == b,
        (Value::String(a), Value::String(b)) => a == b,
        (Value::Number(a), Value::Number(b)) => Decimal::from_str(&a.to_string())
            .ok()
            .zip(Decimal::from_str(&b.to_string()).ok())
            .is_some_and(|(x, y)| x == y),
        (Value::Number(a), Value::String(b)) | (Value::String(b), Value::Number(a)) => {
            Decimal::from_str(&a.to_string())
                .ok()
                .zip(Decimal::from_str(b).ok())
                .is_some_and(|(x, y)| x == y)
        }
        _ => false,
    }
}

fn resolve_operand(
    comparison_name: &str,
    default_qid: &str,
    default_column: &str,
    sample_column: Option<&str>,
    operand: &Value,
    sources: &BTreeMap<String, (Value, Value)>,
) -> Result<ResolvedOperand> {
    let raw_label = single_line(text(operand, "label")?);
    let label = raw_label.trim().to_owned();
    if label.is_empty() {
        return Err(Error::new("invalid_input"));
    }
    let qid = operand
        .get("query_id")
        .and_then(Value::as_str)
        .unwrap_or(default_qid);
    let (_, result) = sources.get(qid).ok_or(Error::new("invalid_evidence"))?;
    let metric_column = operand
        .get("column")
        .and_then(Value::as_str)
        .unwrap_or(default_column);
    let metric_idx = unique_column_index(result, metric_column)?;
    let sample_idx = sample_column
        .map(|col| unique_column_index(result, col))
        .transpose()?;
    let rows = result["rows"]
        .as_array()
        .ok_or(Error::new("result_unavailable"))?;

    let matched_row: Option<(usize, &Vec<Value>)> = match (
        operand.get("row_index"),
        operand.get("row_match"),
    ) {
        (Some(index_val), None) => {
            let idx = index_val.as_u64().ok_or(Error::new("invalid_input"))? as usize;
            let row = rows
                .get(idx)
                .and_then(Value::as_array)
                .ok_or(Error::new("invalid_evidence"))?;
            Some((idx, row))
        }
        (None, Some(conditions_val)) => {
            let conditions = conditions_val
                .as_array()
                .filter(|items| !items.is_empty())
                .ok_or(Error::new("invalid_input"))?;
            let mut seen_columns = BTreeSet::new();
            let mut predicates = Vec::with_capacity(conditions.len());
            for item in conditions {
                let col_name = text(item, "column")?;
                if !seen_columns.insert(col_name) {
                    return Err(Error::new("invalid_input"));
                }
                let col_idx = unique_column_index(result, col_name)?;
                let expected = item.get("value").ok_or(Error::new("invalid_input"))?;
                if expected.is_null() {
                    return Err(Error::new("invalid_input"));
                }
                predicates.push((col_idx, expected));
            }
            let mut hits = Vec::new();
            for (idx, row_val) in rows.iter().enumerate() {
                let row = row_val.as_array().ok_or(Error::new("result_unavailable"))?;
                if predicates.iter().all(|(col_idx, expected)| {
                    row.get(*col_idx)
                        .is_some_and(|cell| cell_matches(cell, expected))
                }) {
                    hits.push((idx, row));
                }
            }
            if hits.len() > 1 {
                return Err(Error::new("invalid_evidence").with_details(json!({
                    "hint": format!(
                        "比较项 {comparison_name} 的 row_match 命中多行（{}行），请补齐唯一分组键或改用明确的 row_index。",
                        hits.len()
                    )
                })));
            }
            if hits.is_empty() {
                if result["result_complete"] != true || result["saved_result_complete"] != true {
                    return Err(Error::new("invalid_evidence").with_details(json!({
                        "hint": format!(
                            "比较项 {comparison_name} 在未读齐的部分结果中未命中目标行，不能判为缺样本；请先补读完整结果或限定已返回行。"
                        )
                    })));
                }
                None
            } else {
                Some(hits[0])
            }
        }
        _ => return Err(Error::new("invalid_input")),
    };

    let Some((row_idx, row)) = matched_row else {
        return Ok(ResolvedOperand {
            label,
            locator_identity: (qid.to_owned(), None, metric_idx),
            row_strings: None,
            outcome: OperandOutcome::InsufficientData,
        });
    };

    let row_strings: BTreeSet<String> = row
        .iter()
        .filter_map(Value::as_str)
        .map(|cell| single_line(cell).trim().to_owned())
        .collect();

    if let Some(sample_idx) = sample_idx {
        let sample_cell = row.get(sample_idx).ok_or(Error::new("invalid_evidence"))?;
        if sample_cell.is_null() || parse_decimal(sample_cell)? <= Decimal::ZERO {
            return Ok(ResolvedOperand {
                label,
                locator_identity: (qid.to_owned(), Some(row_idx), metric_idx),
                row_strings: Some(row_strings),
                outcome: OperandOutcome::InsufficientData,
            });
        }
    }

    let metric_cell = row.get(metric_idx).ok_or(Error::new("invalid_evidence"))?;
    let outcome = if metric_cell.is_null() {
        OperandOutcome::InsufficientData
    } else {
        OperandOutcome::Numeric {
            decimal: parse_decimal(metric_cell)?,
            raw: raw_scalar(metric_cell)?,
        }
    };

    Ok(ResolvedOperand {
        label,
        locator_identity: (qid.to_owned(), Some(row_idx), metric_idx),
        row_strings: Some(row_strings),
        outcome,
    })
}

pub(super) fn resolve_all(
    input: &Value,
    sources: &BTreeMap<String, (Value, Value)>,
    bindings: &mut BTreeMap<String, String>,
) -> Result<Vec<Value>> {
    let Some(items) = input.get("comparisons").filter(|value| !value.is_null()) else {
        return Ok(Vec::new());
    };
    let items = items.as_array().ok_or(Error::new("invalid_input"))?;
    let mut resolved = Vec::with_capacity(items.len());
    for item in items {
        let name = text(item, "name")?;
        if bindings.contains_key(name) {
            return Err(Error::new("invalid_input"));
        }
        let default_qid = text(item, "query_id")?;
        let default_col = text(item, "column")?;
        let sample_col = item.get("sample_column").and_then(Value::as_str);
        let left = resolve_operand(
            name,
            default_qid,
            default_col,
            sample_col,
            &item["left"],
            sources,
        )?;
        let right = resolve_operand(
            name,
            default_qid,
            default_col,
            sample_col,
            &item["right"],
            sources,
        )?;
        if left.label == right.label
            || (left.locator_identity.1.is_some()
                && left.locator_identity == right.locator_identity)
        {
            return Err(Error::new("invalid_input"));
        }
        if let (Some(strings_l), Some(strings_r)) = (&left.row_strings, &right.row_strings)
            && ((strings_r.contains(&left.label) && !strings_l.contains(&left.label))
                || (strings_l.contains(&right.label) && !strings_r.contains(&right.label)))
        {
            return Err(Error::new("invalid_evidence").with_details(json!({
                "hint": format!(
                    "比较项 {name} 的 left/right 标签（{} vs {}）与所指行的维度值相反，请核对 row_index 或 row_match 后重新准备。",
                    left.label, right.label
                )
            })));
        }

        let (relation, rendered, left_val, right_val) = match (&left.outcome, &right.outcome) {
            (
                OperandOutcome::Numeric {
                    decimal: l_dec,
                    raw: l_raw,
                },
                OperandOutcome::Numeric {
                    decimal: r_dec,
                    raw: r_raw,
                },
            ) => {
                let (rel, phrase) = if l_dec > r_dec {
                    ("higher", format!("{} 高于 {}", left.label, right.label))
                } else if l_dec < r_dec {
                    ("lower", format!("{} 低于 {}", left.label, right.label))
                } else {
                    ("equal", format!("{} 与 {} 持平", left.label, right.label))
                };
                (rel, phrase, json!(l_raw), json!(r_raw))
            }
            (OperandOutcome::InsufficientData, OperandOutcome::Numeric { raw: r_raw, .. }) => (
                "insufficient_data",
                format!("{} 缺少有效样本，暂无法与 {} 比较", left.label, right.label),
                Value::Null,
                json!(r_raw),
            ),
            (OperandOutcome::Numeric { raw: l_raw, .. }, OperandOutcome::InsufficientData) => (
                "insufficient_data",
                format!("{} 缺少有效样本，暂无法与 {} 比较", right.label, left.label),
                json!(l_raw),
                Value::Null,
            ),
            (OperandOutcome::InsufficientData, OperandOutcome::InsufficientData) => (
                "insufficient_data",
                format!(
                    "{} 与 {} 均缺少有效样本，暂无法比较",
                    left.label, right.label
                ),
                Value::Null,
                Value::Null,
            ),
        };

        if let Some(expected) = item.get("expected_relation").and_then(Value::as_str)
            && expected != relation
        {
            return Err(Error::new("invalid_evidence").with_details(json!({
                "comparison_mismatch": {
                    "name": name,
                    "expected_relation": expected,
                    "actual_relation": relation,
                    "left_label": left.label,
                    "right_label": right.label,
                    "left_value": left_val,
                    "right_value": right_val,
                    "rendered": rendered,
                },
                "hint": format!(
                    "比较项 {name} 的预期关系（{expected}）与查询真实结果不符：实际为 {relation}（{rendered}）。请按真实结果修正或省略 expected_relation 后重新调用 prepare_analysis_answer。"
                )
            })));
        }

        let clean = single_line(&rendered);
        bindings.insert(name.to_owned(), clean.clone());
        resolved.push(json!({
            "name": name,
            "relation": relation,
            "left_label": left.label,
            "right_label": right.label,
            "left_value": left_val,
            "right_value": right_val,
            "rendered": clean,
        }));
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::super::render;
    use super::*;

    fn stage_sources(complete: bool) -> BTreeMap<String, (Value, Value)> {
        // 复用自留盲测 #1 真实 9 行查询结果（含高、低、精确持平、缺对侧分组及零样本/NULL扩展行）。
        BTreeMap::from([(
            "stage_q".into(),
            (
                json!({"parameters":{"start":"2026-08-01T00:00:00Z"}}),
                json!({
                    "columns": [
                        {"name": "stage"},
                        {"name": "endpoint_kind"},
                        {"name": "attempt_count"},
                        {"name": "stage_attempt_success_rate"},
                        {"name": "stage_mean_ms"}
                    ],
                    "rows": [
                        ["action", "cloud", 79, 0.6962025316455697, 698.8709677419355],
                        ["action", "edge", 213, 0.6854460093896714, 702.7683615819209],
                        ["asr", "cloud", 339, 0.7817109144542773, 1222.9498525073745],
                        ["asr", "edge", 176, 0.8863636363636364, 791.25],
                        ["nlu", "cloud", 277, 0.9566787003610109, 265.2707581227437],
                        ["nlu", "edge", 189, 0.8253968253968254, 264.92063492063494],
                        ["route", "cloud", 112, 0.6517857142857143, 70.0],
                        ["route", "edge", 264, 0.7765151515151515, 70.0],
                        ["tts", "edge", 472, 0.9703389830508474, 419.7457627118644],
                        ["wake", "cloud", 0, null, null]
                    ],
                    "statistics": {"row_count": 10, "columns": []},
                    "result_complete": complete,
                    "saved_result_complete": complete
                }),
            ),
        )])
    }

    #[test]
    fn resolves_higher_lower_equal_and_insufficient_data_from_real_failure_rows() {
        let sources = stage_sources(true);
        let input = json!({
            "template": "asr成功率：{{asr_rate_cmp}}；nlu成功率：{{nlu_rate_cmp}}；route成功率：{{route_rate_cmp}}；route耗时：{{route_ms_cmp}}；tts成功率：{{tts_rate_cmp}}；wake样本：{{wake_rate_cmp}}。",
            "values": [],
            "comparisons": [
                {
                    "name": "asr_rate_cmp",
                    "query_id": "stage_q",
                    "column": "stage_attempt_success_rate",
                    "expected_relation": "lower",
                    "left": {"label": "cloud", "row_index": 2},
                    "right": {"label": "edge", "row_index": 3}
                },
                {
                    "name": "nlu_rate_cmp",
                    "query_id": "stage_q",
                    "column": "stage_attempt_success_rate",
                    "expected_relation": "higher",
                    "left": {"label": "cloud", "row_match": [{"column": "stage", "value": "nlu"}, {"column": "endpoint_kind", "value": "cloud"}]},
                    "right": {"label": "edge", "row_match": [{"column": "stage", "value": "nlu"}, {"column": "endpoint_kind", "value": "edge"}]}
                },
                {
                    "name": "route_rate_cmp",
                    "query_id": "stage_q",
                    "column": "stage_attempt_success_rate",
                    "left": {"label": "cloud", "row_index": 6},
                    "right": {"label": "edge", "row_index": 7}
                },
                {
                    "name": "route_ms_cmp",
                    "query_id": "stage_q",
                    "column": "stage_mean_ms",
                    "expected_relation": "equal",
                    "left": {"label": "cloud", "row_index": 6},
                    "right": {"label": "edge", "row_index": 7}
                },
                {
                    "name": "tts_rate_cmp",
                    "query_id": "stage_q",
                    "column": "stage_attempt_success_rate",
                    "expected_relation": "insufficient_data",
                    "left": {"label": "cloud", "row_match": [{"column": "stage", "value": "tts"}, {"column": "endpoint_kind", "value": "cloud"}]},
                    "right": {"label": "edge", "row_match": [{"column": "stage", "value": "tts"}, {"column": "endpoint_kind", "value": "edge"}]}
                },
                {
                    "name": "wake_rate_cmp",
                    "query_id": "stage_q",
                    "column": "stage_attempt_success_rate",
                    "sample_column": "attempt_count",
                    "left": {"label": "wake/cloud", "row_index": 9},
                    "right": {"label": "tts/edge", "row_index": 8}
                }
            ]
        });
        assert_eq!(
            render(&input, &sources).unwrap(),
            "asr成功率：cloud 低于 edge；nlu成功率：cloud 高于 edge；route成功率：cloud 低于 edge；route耗时：cloud 与 edge 持平；tts成功率：cloud 缺少有效样本，暂无法与 edge 比较；wake样本：wake/cloud 缺少有效样本，暂无法与 tts/edge 比较。"
        );
    }

    #[test]
    fn flips_direction_when_operands_reverse_and_rejects_wrong_expected_or_swapped_labels() {
        let sources = stage_sources(true);
        // 反向比较（edge相对cloud）：asr变为higher，nlu变为lower。
        let flipped = json!({
            "template": "反方向核对：asr {{asr_flipped}}，nlu {{nlu_flipped}}。",
            "values": [],
            "comparisons": [
                {
                    "name": "asr_flipped",
                    "query_id": "stage_q",
                    "column": "stage_attempt_success_rate",
                    "left": {"label": "edge", "row_index": 3},
                    "right": {"label": "cloud", "row_index": 2}
                },
                {
                    "name": "nlu_flipped",
                    "query_id": "stage_q",
                    "column": "stage_attempt_success_rate",
                    "left": {"label": "edge", "row_index": 5},
                    "right": {"label": "cloud", "row_index": 4}
                }
            ]
        });
        assert_eq!(
            render(&flipped, &sources).unwrap(),
            "反方向核对：asr edge 高于 cloud，nlu edge 低于 cloud。"
        );

        // 错误方向断言（把asr cloud说成higher）：必须在prepare/render阶段拒绝并附真实关系说明。
        let wrong_direction = json!({
            "template": "{{asr_wrong}}",
            "values": [],
            "comparisons": [{
                "name": "asr_wrong",
                "query_id": "stage_q",
                "column": "stage_attempt_success_rate",
                "expected_relation": "higher",
                "left": {"label": "cloud", "row_index": 2},
                "right": {"label": "edge", "row_index": 3}
            }]
        });
        let err = render(&wrong_direction, &sources).unwrap_err();
        assert_eq!(err.code, "invalid_evidence");
        assert_eq!(
            err.details.as_ref().unwrap()["comparison_mismatch"]["actual_relation"],
            "lower"
        );

        // 行号与标签写反（row 2是cloud却标成edge）：必须拒绝。
        let swapped_labels = json!({
            "template": "{{swapped}}",
            "values": [],
            "comparisons": [{
                "name": "swapped",
                "query_id": "stage_q",
                "column": "stage_attempt_success_rate",
                "left": {"label": "edge", "row_index": 2},
                "right": {"label": "cloud", "row_index": 3}
            }]
        });
        assert_eq!(
            render(&swapped_labels, &sources).unwrap_err().code,
            "invalid_evidence"
        );

        // 已准备的比较标记未在正文中引用：禁止绕开已核比较短语自行手写散文。
        let omitted_marker = json!({
            "template": "自由手写 cloud 高于 edge 而未引用标记。",
            "values": [],
            "comparisons": [{
                "name": "asr_cmp",
                "query_id": "stage_q",
                "column": "stage_attempt_success_rate",
                "left": {"label": "cloud", "row_index": 2},
                "right": {"label": "edge", "row_index": 3}
            }]
        });
        assert_eq!(
            render(&omitted_marker, &sources).unwrap_err().code,
            "invalid_evidence"
        );

        // 部分结果（未读齐）中0行命中不能误判为insufficient_data。
        let incomplete_missing = json!({
            "template": "{{tts_cmp}}",
            "values": [],
            "comparisons": [{
                "name": "tts_cmp",
                "query_id": "stage_q",
                "column": "stage_attempt_success_rate",
                "left": {"label": "cloud", "row_match": [{"column": "stage", "value": "tts"}, {"column": "endpoint_kind", "value": "cloud"}]},
                "right": {"label": "edge", "row_index": 8}
            }]
        });
        assert_eq!(
            render(&incomplete_missing, &stage_sources(false))
                .unwrap_err()
                .code,
            "invalid_evidence"
        );
    }
}

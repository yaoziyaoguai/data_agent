use crate::types::{Error, Result};
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// 只统计实际交付的结果页；不重跑SQL，也不将分页或截断结果当成全量。
pub fn page_statistics(result: &Value) -> Result<Value> {
    let rows = result["rows"]
        .as_array()
        .ok_or(Error::new("invalid_input"))?;
    let columns = result["columns"]
        .as_array()
        .ok_or(Error::new("invalid_input"))?;
    if rows
        .iter()
        .any(|row| row.as_array().is_none_or(|r| r.len() != columns.len()))
    {
        return Err(Error::new("invalid_input"));
    }
    let mut statistics = Vec::with_capacity(columns.len());
    for (index, column) in columns.iter().enumerate() {
        let mut occurrences = BTreeMap::new();
        let mut nulls = 0;
        let mut counts = [0_usize; 3];
        let mut numeric = matches!(column["type"].as_str(), Some("integer" | "number"));
        for row in rows {
            let value = &row[index];
            if value.is_null() {
                nulls += 1;
            } else {
                let text = value.as_str().ok_or(Error::new("invalid_input"))?;
                *occurrences.entry(text).or_insert(0_usize) += 1;
                if numeric {
                    if let Some(sign) = decimal_sign(text) {
                        counts[(sign + 1) as usize] += 1;
                    } else {
                        numeric = false;
                    }
                }
            }
        }
        statistics.push(json!({
            "column_index":index,"column_name":column["name"],
            "non_null_count":rows.len()-nulls,"null_count":nulls,"distinct_count":occurrences.len(),
            "repeated_values":occurrences.iter().filter(|(_, count)| **count>1)
                .map(|(value,count)|json!({"value":value,"count":count})).collect::<Vec<_>>(),
            "numeric_counts":if numeric {json!({"negative":counts[0],"zero":counts[1],"positive":counts[2]})} else {Value::Null}
        }));
    }
    let complete = result["result_complete"] == true
        && result["truncated"] == false
        && result["next_cursor"].is_null()
        && result["fetched_offset"] == "0";
    Ok(
        json!({"scope":if complete {"complete_result"} else {"page"},
        "row_count":rows.len(),"distinct_comparison":"returned_text","columns":statistics}),
    )
}

// 以十进制文本判断正负和零，不转浮点，避免大整数或极小数失真。
fn decimal_sign(value: &str) -> Option<i8> {
    let (mantissa, exponent) = value
        .split_once(['e', 'E'])
        .map_or((value, None), |(m, e)| (m, Some(e)));
    if let Some(exponent) = exponent {
        let digits = exponent.strip_prefix(['+', '-']).unwrap_or(exponent);
        if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
    }
    let digits = mantissa.strip_prefix(['+', '-']).unwrap_or(mantissa);
    let mut points = 0;
    let mut digit_count = 0;
    let mut nonzero = false;
    for byte in digits.bytes() {
        if byte == b'.' {
            points += 1;
        } else if byte.is_ascii_digit() {
            digit_count += 1;
            nonzero |= byte != b'0';
        } else {
            return None;
        }
    }
    if digit_count == 0 || points > 1 {
        return None;
    }
    Some(if !nonzero {
        0
    } else if mantissa.starts_with('-') {
        -1
    } else {
        1
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn result(rows: Value) -> Value {
        json!({"columns":[{"name":"订单","type":"text"},{"name":"金额","type":"number"}],
            "rows":rows,"result_complete":true,"truncated":false,"next_cursor":null,"fetched_offset":"0"})
    }
    #[test]
    fn counts_duplicates_nulls_and_decimal_signs_without_rounding() {
        let stats = page_statistics(&result(json!([
            ["A", "9007199254740993"],
            ["A", "-0.00"],
            ["B", "1e-9999"],
            ["B", "-0.00001"],
            [null, null],
            [null, null]
        ])))
        .unwrap();
        assert_eq!(stats["row_count"], 6);
        assert_eq!(stats["columns"][0]["distinct_count"], 2);
        assert_eq!(
            stats["columns"][0]["repeated_values"],
            json!([{"value":"A","count":2},{"value":"B","count":2}])
        );
        assert_eq!(stats["columns"][0]["null_count"], 2);
        assert_eq!(
            stats["columns"][1]["numeric_counts"],
            json!({"negative":1,"zero":1,"positive":2})
        );
        assert_eq!(stats["scope"], "complete_result");
    }
    #[test]
    fn incomplete_pages_never_claim_full_result_statistics() {
        for (field, value) in [
            ("result_complete", json!(false)),
            ("truncated", json!(true)),
            ("next_cursor", json!("100")),
            ("fetched_offset", json!("100")),
        ] {
            let mut page = result(json!([["A", "1"]]));
            page[field] = value;
            assert_eq!(page_statistics(&page).unwrap()["scope"], "page");
        }
    }
    #[test]
    fn empty_invalid_and_text_values_are_not_silently_numeric() {
        assert_eq!(page_statistics(&result(json!([]))).unwrap()["row_count"], 0);
        let stats = page_statistics(&result(json!([["001", "NaN"], ["1", "3"]]))).unwrap();
        assert_eq!(stats["columns"][0]["distinct_count"], 2);
        assert!(stats["columns"][0]["numeric_counts"].is_null());
        assert!(stats["columns"][1]["numeric_counts"].is_null());
        assert!(page_statistics(&result(json!([["A"]]))).is_err());
    }
}

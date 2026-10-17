use crate::types::{Error, Result};
use serde_json::{Value, json};

pub const SAVED_RESULT_LIMIT: usize = 512 * 1024;
pub const SAVED_RESULT_MAX_PAGES: usize = 10;

fn unavailable() -> Error {
    Error::new("result_unavailable")
}

fn offset(value: &Value) -> Result<usize> {
    value
        .as_str()
        .filter(|text| {
            !text.is_empty()
                && text.bytes().all(|byte| byte.is_ascii_digit())
                && (text == &"0" || !text.starts_with('0'))
        })
        .and_then(|text| text.parse::<usize>().ok())
        .ok_or_else(unavailable)
}

/// 平台游标指向下一条已保存行；末页不能以空页或不前进的游标伪装完整。
pub fn saved_result_next_cursor(page: &Value) -> Result<Option<String>> {
    let rows = page["rows"].as_array().ok_or_else(unavailable)?;
    let saved_count = page["saved_row_count"].as_u64().ok_or_else(unavailable)?;
    let saved_count = usize::try_from(saved_count).map_err(|_| unavailable())?;
    let complete = page["saved_result_complete"]
        .as_bool()
        .ok_or_else(unavailable)?;
    if saved_count > 1000 {
        return Err(Error::new("request_too_large"));
    }
    if page["truncated"].as_bool() != Some(!complete) {
        return Err(unavailable());
    }
    let start = offset(&page["fetched_offset"])?;
    let end = start.checked_add(rows.len()).ok_or_else(unavailable)?;
    if end > saved_count {
        return Err(unavailable());
    }
    match page["next_cursor"].as_str() {
        Some(cursor) => {
            if rows.is_empty() || offset(&json!(cursor))? != end || end >= saved_count {
                return Err(unavailable());
            }
            Ok(Some(cursor.to_owned()))
        }
        None if page["next_cursor"].is_null() && end == saved_count => Ok(None),
        _ => Err(unavailable()),
    }
}

/// 只合并已经授权读取的连续保存页，完整性仍以平台保存覆盖为准。
pub fn merge_saved_result_pages(query_id: &str, pages: &[Value]) -> Result<Value> {
    if pages.is_empty() {
        return Err(unavailable());
    }
    if pages.len() > SAVED_RESULT_MAX_PAGES {
        return Err(Error::new("request_too_large"));
    }
    let mut result = pages[0].clone();
    let columns = result["columns"].as_array().ok_or_else(unavailable)?;
    let mut all_rows = Vec::new();
    let mut next = Some("0".to_owned());
    let mut received_bytes = 0_usize;
    for page in pages {
        received_bytes = received_bytes
            .checked_add(serde_json::to_vec(page).map_err(|_| unavailable())?.len())
            .ok_or(Error::new("request_too_large"))?;
        if received_bytes > SAVED_RESULT_LIMIT {
            return Err(Error::new("request_too_large"));
        }
        if page["query_id"] != query_id
            || page["result_ref"] != result["result_ref"]
            || page["columns"] != result["columns"]
            || page["source"] != result["source"]
            || page["data_freshness"] != result["data_freshness"]
            || page["saved_row_count"] != result["saved_row_count"]
            || page["saved_result_complete"] != result["saved_result_complete"]
            || page["truncated"] != result["truncated"]
            || next.as_deref() != page["fetched_offset"].as_str()
        {
            return Err(unavailable());
        }
        let rows = page["rows"].as_array().ok_or_else(unavailable)?;
        if rows.iter().any(|row| {
            row.as_array().is_none_or(|row| {
                row.len() != columns.len()
                    || row
                        .iter()
                        .any(|value| !(value.is_string() || value.is_null()))
            })
        }) {
            return Err(unavailable());
        }
        let end = all_rows
            .len()
            .checked_add(rows.len())
            .ok_or(Error::new("request_too_large"))?;
        if end > 1000 {
            return Err(Error::new("request_too_large"));
        }
        next = saved_result_next_cursor(page)?;
        let page_complete =
            page["saved_result_complete"] == true && all_rows.is_empty() && next.is_none();
        if page["result_complete"].as_bool() != Some(page_complete) {
            return Err(unavailable());
        }
        all_rows.extend(rows.iter().cloned());
    }
    if next.is_some() || result["saved_row_count"].as_u64() != Some(all_rows.len() as u64) {
        return Err(unavailable());
    }
    result["rows"] = json!(all_rows);
    result["fetched_offset"] = json!("0");
    result["next_cursor"] = Value::Null;
    result["result_complete"] = result["saved_result_complete"].clone();
    result["statistics"] = super::page_statistics(&result)?;
    if serde_json::to_vec(&result)
        .map_err(|_| unavailable())?
        .len()
        > SAVED_RESULT_LIMIT
    {
        return Err(Error::new("request_too_large"));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pages(count: usize, complete: bool) -> Vec<Value> {
        (0..count.max(1)).step_by(100).map(|start| {
            let end=(start+100).min(count);
            json!({"query_id":"saved-query","source":"mock","columns":[{"name":"group","type":"integer","encoding":"decimal_string"}],
                "rows":(start..end).map(|row|json!([(row%3).to_string()])).collect::<Vec<_>>(),
                "result_complete":complete && start==0 && end==count,"truncated":!complete,"data_freshness":"same-snapshot",
                "result_ref":"saved-query","next_cursor":if end<count{Some(end.to_string())}else{None},"fetched_offset":start.to_string(),
                "saved_row_count":count,"saved_result_complete":complete})
        }).collect()
    }

    #[test]
    fn two_hundred_five_rows_are_collected_once_and_distinct_is_recomputed() {
        let source = pages(205, true);
        assert_eq!(source.len(), 3);
        assert_eq!(source[2]["rows"].as_array().unwrap().len(), 5);
        let result = merge_saved_result_pages("saved-query", &source).unwrap();
        assert_eq!(result["rows"].as_array().unwrap().len(), 205);
        assert_eq!(result["result_complete"], true);
        assert_eq!(result["saved_result_complete"], true);
        assert_eq!(result["statistics"]["scope"], "complete_result");
        assert_eq!(result["statistics"]["columns"][0]["distinct_count"], 3);
        crate::contracts::validate("QueryResults", &result).unwrap();
    }

    #[test]
    fn empty_result_is_complete_but_a_thousand_saved_rows_from_more_source_rows_are_partial() {
        let empty = merge_saved_result_pages("saved-query", &pages(0, true)).unwrap();
        assert_eq!(empty["statistics"]["row_count"], 0);
        assert_eq!(empty["result_complete"], true);
        let clipped = merge_saved_result_pages("saved-query", &pages(1000, false)).unwrap();
        assert_eq!(clipped["saved_row_count"], 1000);
        assert_eq!(clipped["result_complete"], false);
        assert_eq!(clipped["statistics"]["scope"], "page");
        assert_eq!(clipped["truncated"], true);
    }

    #[test]
    fn mismatched_columns_identity_ref_or_saved_metadata_cannot_be_merged() {
        for mutation in 0..5 {
            let mut source = pages(205, true);
            match mutation {
                0 => source[1]["columns"][0]["name"] = json!("another-column"),
                1 => source[1]["query_id"] = json!("another-query"),
                2 => source[1]["result_ref"] = json!("another-result"),
                3 => source[1]["saved_row_count"] = json!(204),
                _ => source[1]["saved_result_complete"] = json!(false),
            }
            assert_eq!(
                merge_saved_result_pages("saved-query", &source)
                    .unwrap_err()
                    .code,
                "result_unavailable"
            );
        }
    }

    #[test]
    fn non_advancing_out_of_order_and_missing_final_cursors_are_rejected() {
        for mutation in 0..5 {
            let mut source = pages(205, true);
            match mutation {
                0 => source[0]["next_cursor"] = json!("0"),
                1 => source[0]["next_cursor"] = Value::Null,
                2 => source[1]["fetched_offset"] = json!("99"),
                3 => {
                    source.pop();
                }
                _ => source[2]["next_cursor"] = json!("205"),
            }
            assert_eq!(
                merge_saved_result_pages("saved-query", &source)
                    .unwrap_err()
                    .code,
                "result_unavailable"
            );
        }
    }

    #[test]
    fn page_claims_missing_metadata_and_row_shape_cannot_manufacture_fullness() {
        for mutation in 0..4 {
            let mut source = pages(205, true);
            match mutation {
                0 => source[2]["result_complete"] = json!(true),
                1 => {
                    source[0].as_object_mut().unwrap().remove("saved_row_count");
                }
                2 => source[0]["rows"][0] = json!(["first", "extra"]),
                _ => source[0]["rows"][0] = json!([1]),
            }
            assert_eq!(
                merge_saved_result_pages("saved-query", &source)
                    .unwrap_err()
                    .code,
                "result_unavailable"
            );
        }
    }

    #[test]
    fn reading_more_than_limits_is_explicit_failure_and_never_a_short_success() {
        assert_eq!(
            merge_saved_result_pages("saved-query", &pages(1001, true))
                .unwrap_err()
                .code,
            "request_too_large"
        );
        let mut source = pages(1, true);
        source[0]["rows"][0][0] = json!("界".repeat(SAVED_RESULT_LIMIT / 3 + 1));
        assert_eq!(
            merge_saved_result_pages("saved-query", &source)
                .unwrap_err()
                .code,
            "request_too_large"
        );
        let mut source = pages(205, true);
        source[1]["rows"] = json!([]);
        assert_eq!(
            merge_saved_result_pages("saved-query", &source)
                .unwrap_err()
                .code,
            "result_unavailable"
        );
    }
}

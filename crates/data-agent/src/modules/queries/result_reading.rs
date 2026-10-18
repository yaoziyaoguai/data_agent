use crate::{
    contracts,
    types::{Error, Result},
};
use serde_json::{Value, json};

// 与正文读取相同，为工具回执和查询状态保留空间；HTTP结果接口保持原有页大小。
pub const AGENT_RESULT_BYTES: usize = 23 * 1024;

fn bytes(value: &Value) -> Result<usize> {
    Ok(serde_json::to_vec(value)
        .map_err(|_| Error::new("invalid_input"))?
        .len())
}

/// 对已鉴权、固定result_ref的保存页做投影，不执行或修改SQL。
pub fn agent_result_page(result: &Value, input: &Value) -> Result<Value> {
    let view = input["view"].as_str().unwrap_or("rows");
    let expected = if view == "cell" {
        input["row_index"]
            .as_u64()
            .ok_or(Error::new("invalid_input"))?
            .to_string()
    } else {
        input["cursor"].as_str().unwrap_or("0").to_owned()
    };
    if result["fetched_offset"].as_str() != Some(expected.as_str()) {
        return Err(Error::new("result_unavailable"));
    }
    let next = super::saved_result_next_cursor(result)?;
    let complete = result["saved_result_complete"] == true && expected == "0" && next.is_none();
    if result["result_complete"].as_bool() != Some(complete) {
        return Err(Error::new("result_unavailable"));
    }
    let offset = input["content_offset"].as_u64().unwrap_or(0) as usize;
    let rows = result["rows"]
        .as_array()
        .ok_or(Error::new("result_unavailable"))?;
    let start = result["fetched_offset"]
        .as_str()
        .and_then(|v| v.parse::<usize>().ok())
        .ok_or(Error::new("result_unavailable"))?;
    let payload = match view {
        "cell" => {
            let row = input["row_index"]
                .as_u64()
                .ok_or(Error::new("invalid_input"))? as usize;
            let column = input["column_index"]
                .as_u64()
                .ok_or(Error::new("invalid_input"))? as usize;
            if start != row {
                return Err(Error::new("result_unavailable"));
            }
            let value = rows
                .first()
                .and_then(|r| r.as_array())
                .and_then(|r| r.get(column))
                .ok_or(Error::new("invalid_input"))?;
            let definition = result["columns"]
                .as_array()
                .and_then(|c| c.get(column))
                .ok_or(Error::new("invalid_input"))?;
            json!({"query_id":result["query_id"],"result_ref":result["result_ref"],"view":"cell","row_index":row,"column_index":column,"column":definition,"value":value})
        }
        "statistics" => {
            json!({"query_id":result["query_id"],"result_ref":result["result_ref"],"view":"statistics","fetched_offset":result["fetched_offset"],"next_cursor":result["next_cursor"],"saved_row_count":result["saved_row_count"],"saved_result_complete":result["saved_result_complete"],"truncated":result["truncated"],"statistics":result["statistics"]})
        }
        "rows" => {
            let mut page = result.clone();
            let mut count = rows.len();
            // 先按原行的序列化大小选取，再将本页统计一并纳入字节检查。
            let mut size = 0;
            for (index, row) in rows.iter().enumerate() {
                size += bytes(row)?;
                if size > AGENT_RESULT_BYTES / 2 {
                    count = index.max(1);
                    break;
                }
            }
            loop {
                page["rows"] = json!(&rows[..count]);
                page["next_cursor"] = if count < rows.len() {
                    json!((start + count).to_string())
                } else {
                    result["next_cursor"].clone()
                };
                page["result_complete"] =
                    json!(count == rows.len() && result["result_complete"] == true);
                page["statistics"] = super::page_statistics(&page)?;
                if bytes(&page)? <= AGENT_RESULT_BYTES || count <= 1 {
                    break;
                }
                count -= 1;
            }
            page
        }
        _ => return Err(Error::new("invalid_input")),
    };
    let page = content_page(&payload, view, offset)?;
    contracts::validate("AgentQueryResults", &page)?;
    Ok(page)
}

// 极宽单行、单元格或统计按原JSON的Unicode字符续读，不伪造NULL或拼成完整值。
fn content_page(payload: &Value, view: &str, offset: usize) -> Result<Value> {
    if bytes(payload)? <= AGENT_RESULT_BYTES {
        if offset != 0 {
            return Err(Error::new("invalid_input"));
        }
        return Ok(payload.clone());
    }
    let body = serde_json::to_string(payload).map_err(|_| Error::new("result_unavailable"))?;
    let chars: Vec<_> = body.chars().collect();
    if offset >= chars.len() {
        return Err(Error::new("invalid_input"));
    }
    let mut end = (offset + 8192).min(chars.len());
    let mut page = json!({"query_id":payload["query_id"],"result_ref":payload["result_ref"],"view":view,"content_format":"json","content_text":"","content_page":{}});
    loop {
        page["content_text"] = json!(chars[offset..end].iter().collect::<String>());
        page["content_page"] = json!({"offset":offset,"total_chars":chars.len(),"complete":end==chars.len(),"next_offset":if end<chars.len(){Some(end)}else{None}});
        if bytes(&page)? <= AGENT_RESULT_BYTES {
            return Ok(page);
        }
        if end - offset <= 1 {
            return Err(Error::new("request_too_large"));
        }
        end = offset + (end - offset) / 2;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn result(rows: Value) -> Value {
        let mut result = json!({"query_id":"q1","result_ref":"q1","source":"mock","columns":[{"name":"detail","type":"text","encoding":"text"}],"rows":rows,"result_complete":true,"truncated":false,"data_freshness":"synthetic","next_cursor":null,"fetched_offset":"0","saved_row_count":0,"saved_result_complete":true});
        result["saved_row_count"] = json!(result["rows"].as_array().unwrap().len());
        result["statistics"] = super::super::page_statistics(&result).unwrap();
        result
    }
    fn read_all(result: &Value, input: Value) -> Value {
        let mut text = String::new();
        let mut args = input;
        loop {
            let page = agent_result_page(result, &args).unwrap();
            assert!(bytes(&page).unwrap() <= AGENT_RESULT_BYTES);
            if page.get("content_text").is_none() {
                return page;
            }
            text.push_str(page["content_text"].as_str().unwrap());
            if page["content_page"]["complete"] == true {
                return serde_json::from_str(&text).unwrap();
            }
            args["content_offset"] = page["content_page"]["next_offset"].clone();
        }
    }
    #[test]
    fn wide_rows_keep_exact_values_and_page_statistics() {
        let original = result(json!(
            (0..100)
                .map(|i| vec![format!("{i}{}", "x".repeat(1500))])
                .collect::<Vec<_>>()
        ));
        let page = agent_result_page(&original, &json!({})).unwrap();
        let count = page["rows"].as_array().unwrap().len();
        assert!(count > 0 && count < 100);
        assert_eq!(page["next_cursor"], count.to_string());
        assert_eq!(
            page["rows"],
            json!(&original["rows"].as_array().unwrap()[..count])
        );
        assert_eq!(page["statistics"]["scope"], "page");
        assert_eq!(page["statistics"]["row_count"], count);
    }
    #[test]
    fn oversized_row_cell_and_statistics_roundtrip_unicode_and_escapes() {
        let value = "中文\"\\\n".repeat(10000);
        let original = result(json!([[value], [value]]));
        let row = read_all(&original, json!({}));
        assert_eq!(row["rows"], json!([[value]]));
        assert_eq!(row["next_cursor"], "1");
        let cell = read_all(
            &original,
            json!({"view":"cell","row_index":0,"column_index":0}),
        );
        assert_eq!(cell["value"], value);
        let stats = read_all(&original, json!({"view":"statistics"}));
        assert_eq!(stats["statistics"], original["statistics"]);
        assert_eq!(stats["statistics"]["scope"], "complete_result");
    }
    #[test]
    fn wrong_platform_offset_and_discontinuous_pages_are_rejected() {
        let original = result(json!([["one"], ["two"]]));
        for (field, value) in [
            ("fetched_offset", json!("1")),
            ("next_cursor", json!("1")),
            ("saved_row_count", json!(3)),
            ("result_complete", json!(false)),
        ] {
            let mut bad = original.clone();
            bad[field] = value;
            for view in ["rows", "statistics"] {
                assert!(agent_result_page(&bad, &json!({"view":view})).is_err());
            }
        }
        assert!(agent_result_page(&original, &json!({"cursor":"1"})).is_err());
    }
    #[test]
    fn empty_null_and_invalid_positions_remain_distinct() {
        let empty = result(json!([]));
        assert_eq!(
            agent_result_page(&empty, &json!({})).unwrap()["statistics"]["row_count"],
            0
        );
        let null = result(json!([[null]]));
        assert!(
            agent_result_page(
                &null,
                &json!({"view":"cell","row_index":0,"column_index":0})
            )
            .unwrap()["value"]
                .is_null()
        );
        for args in [
            json!({"view":"cell","row_index":1,"column_index":0}),
            json!({"view":"cell","row_index":0,"column_index":1}),
            json!({"content_offset":1}),
        ] {
            assert!(agent_result_page(&null, &args).is_err());
        }
    }
}

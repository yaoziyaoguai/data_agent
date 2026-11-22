use crate::{
    State,
    routes::{failure, semantic_user},
};
use axum::{
    Json,
    extract::{Path, State as AxumState},
    http::{HeaderMap, StatusCode, header},
    response::IntoResponse,
};
use data_agent::{modules::queries::is_decimal_cell, types::Error, use_cases};
use serde_json::Value;

const CSV_CHUNK_BYTES: usize = 64 * 1024;

fn append_csv_cell(output: &mut String, value: &str) {
    let escape_formula = match value.as_bytes().first() {
        Some(b'=' | b'@' | b'\t' | b'\r') => true,
        Some(b'+' | b'-') => {
            // 保留单独的符号、十进制数和带单位的数值区间，表达式仍加单引号前缀。
            value.len() > 1
                && !is_decimal_cell(value)
                && !value.split_once('~').is_some_and(|(start, end)| {
                    is_decimal_cell(start.trim_end())
                        && is_decimal_cell(end.trim_start().trim_end_matches(|c: char| {
                            c.is_alphabetic() || matches!(c, '%' | '°')
                        }))
                })
        }
        _ => false,
    };
    output.push('"');
    if escape_formula {
        output.push('\'');
    }
    for part in value.split_inclusive('"') {
        output.push_str(part);
        if part.ends_with('"') {
            output.push('"');
        }
    }
    output.push('"');
}

pub async fn export(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(qid): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<Value>)> {
    let ctx = semantic_user(&state, &headers).await.map_err(failure)?;
    // 首次鉴权和读取发生在响应头之前，撤权直接返回对应的 HTTP 状态。
    let mut page = use_cases::query_workflow::results(&state.pool, &ctx, &qid, None)
        .await
        .map_err(failure)?;
    let mut chunk = String::from("\u{feff}");
    for (index, column) in page.columns.iter().enumerate() {
        if index > 0 {
            chunk.push(',');
        }
        let label = column.display_label.as_deref().unwrap_or(&column.name);
        if let Some(unit) = &column.unit {
            append_csv_cell(&mut chunk, &format!("{label}（{unit}）"));
        } else {
            append_csv_cell(&mut chunk, label);
        }
    }
    chunk.push_str("\r\n");
    let file_name = format!("attachment; filename=\"query-{qid}.csv\"");
    let (sender, receiver) = tokio::sync::mpsc::channel::<Result<String, Error>>(1);
    tokio::spawn(async move {
        loop {
            for row in &page.rows {
                for (index, cell) in row.iter().enumerate() {
                    if index > 0 {
                        chunk.push(',');
                    }
                    append_csv_cell(&mut chunk, cell.as_deref().unwrap_or(""));
                }
                chunk.push_str("\r\n");
                if chunk.len() >= CSV_CHUNK_BYTES
                    && sender.send(Ok(std::mem::take(&mut chunk))).await.is_err()
                {
                    return;
                }
            }
            if !chunk.is_empty() && sender.send(Ok(std::mem::take(&mut chunk))).await.is_err() {
                return;
            }
            let Some(cursor) = page.next_cursor else {
                return;
            };
            match use_cases::query_workflow::results(&state.pool, &ctx, &qid, Some(&cursor)).await {
                Ok(next) => page = next,
                Err(error) => {
                    drop(sender.send(Err(error)).await);
                    return;
                }
            }
        }
    });
    Ok((
        [
            (header::CONTENT_TYPE, "text/csv; charset=utf-8".to_string()),
            (header::CONTENT_DISPOSITION, file_name),
        ],
        axum::body::Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(receiver)),
    ))
}

#[cfg(test)]
mod tests {
    use super::append_csv_cell;

    #[test]
    fn csv_keeps_signed_labels_and_quotes_formula_looking_text() {
        for (value, expected) in [
            ("-9007199254740993", "\"-9007199254740993\""),
            ("-", "\"-\""),
            ("+86123456", "\"+86123456\""),
            ("-20~-10dB", "\"-20~-10dB\""),
            ("=SUM(A1)", "\"'=SUM(A1)\""),
            ("+SUM(A1)", "\"'+SUM(A1)\""),
            ("一二\",三", "\"一二\"\",三\""),
        ] {
            let mut encoded = String::new();
            append_csv_cell(&mut encoded, value);
            assert_eq!(encoded, expected);
        }
    }
}

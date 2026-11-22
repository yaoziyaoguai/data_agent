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
use data_agent::{types::Error, use_cases};
use serde_json::Value;

fn csv_cell(value: &str, numeric: bool) -> String {
    let prefix = if value.starts_with(['=', '+', '-', '@', '\t', '\r'])
        && !(numeric && data_agent::modules::queries::is_decimal_cell(value))
    {
        "'"
    } else {
        ""
    };
    format!("\"{prefix}{}\"", value.replace('"', "\"\""))
}

pub async fn export(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Path(qid): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<Value>)> {
    let ctx = semantic_user(&state, &headers).await.map_err(failure)?;
    // 首次鉴权和读取发生在响应头之前，撤权直接返回对应的 HTTP 状态。
    let first = use_cases::query_workflow::results(&state.pool, &ctx, &qid, None)
        .await
        .map_err(failure)?;
    let head = first
        .columns
        .iter()
        .map(|column| {
            let label = column.display_label.as_deref().unwrap_or(&column.name);
            let label = match &column.unit {
                Some(unit) => format!("{label}（{unit}）"),
                None => label.to_owned(),
            };
            csv_cell(&label, false)
        })
        .collect::<Vec<_>>()
        .join(",");
    let file_name = format!("attachment; filename=\"query-{qid}.csv\"");
    let (sender, receiver) = tokio::sync::mpsc::channel::<Result<String, Error>>(1);
    tokio::spawn(async move {
        if sender
            .send(Ok(format!("\u{feff}{head}\r\n")))
            .await
            .is_err()
        {
            return;
        }
        let mut page = first;
        loop {
            for row in &page.rows {
                let line = row
                    .iter()
                    .zip(&page.columns)
                    .map(|(cell, column)| {
                        csv_cell(
                            cell.as_deref().unwrap_or(""),
                            matches!(column.result_column_type.as_str(), "integer" | "number"),
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(",");
                if sender.send(Ok(format!("{line}\r\n"))).await.is_err() {
                    return;
                }
            }
            let Some(cursor) = page.next_cursor else {
                return;
            };
            match use_cases::query_workflow::results(&state.pool, &ctx, &qid, Some(&cursor)).await {
                Ok(next) => page = next,
                Err(error) => {
                    if sender.send(Err(error)).await.is_err() {
                        return;
                    }
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
    use super::csv_cell;

    #[test]
    fn csv_keeps_signed_decimal_and_quotes_formula_looking_text() {
        assert_eq!(csv_cell("-9007199254740993", true), "\"-9007199254740993\"");
        assert_eq!(csv_cell("=SUM(A1)", false), "\"'=SUM(A1)\"");
        assert_eq!(csv_cell("=SUM(A1)", true), "\"'=SUM(A1)\"");
    }
}

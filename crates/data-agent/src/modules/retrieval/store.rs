use crate::{persistence::AppTx, types::Result};
use serde_json::Value;
pub async fn index_in_tx(tx: &mut AppTx<'_>, space: &str, object: &Value) -> Result<()> {
    sqlx::query("INSERT INTO retrieval_documents(object_id,space_id,version,body) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE body=IF(version<=VALUES(version),VALUES(body),body),version=GREATEST(version,VALUES(version)),indexed_at=UTC_TIMESTAMP(3)")
        .bind(object["id"].as_str()).bind(space).bind(crate::types::epoch(object["version"].as_str().unwrap_or("0"))?).bind(sqlx::types::Json(object)).execute(tx.connection()).await?;
    Ok(())
}

pub async fn candidates_in_tx(tx: &mut AppTx<'_>, space: &str, query: &str) -> Result<Vec<Value>> {
    let tokens = super::tokens(query);
    if tokens.is_empty() {
        return Ok(vec![]);
    }
    let mut sql = sqlx::QueryBuilder::<sqlx::MySql>::new(
        "SELECT object_id FROM retrieval_documents FORCE INDEX(PRIMARY) WHERE space_id=",
    );
    sql.push_bind(space).push(" AND (");
    let mut clauses = sql.separated(" OR ");
    for token in tokens.into_iter().take(24) {
        clauses
            .push("INSTR(LOWER(CAST(body AS CHAR)),")
            .push_bind_unseparated(token)
            .push_unseparated(")>0");
    }
    sql.push(") ORDER BY object_id LIMIT 1001");
    let rows: Vec<String> = sql.build_query_scalar().fetch_all(tx.connection()).await?;
    Ok(rows
        .into_iter()
        .map(|id| serde_json::json!({"id":id}))
        .collect())
}

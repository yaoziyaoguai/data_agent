use crate::{persistence::AppTx, types::Result};
use serde_json::Value;
pub async fn index_in_tx(tx: &mut AppTx<'_>, space: &str, object: &Value) -> Result<()> {
    sqlx::query("INSERT INTO retrieval_documents(object_id,space_id,version,body) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE body=IF(version<=VALUES(version),VALUES(body),body),version=GREATEST(version,VALUES(version)),indexed_at=UTC_TIMESTAMP(3)")
        .bind(object["id"].as_str()).bind(space).bind(crate::types::epoch(object["version"].as_str().unwrap_or("0"))?).bind(sqlx::types::Json(object)).execute(tx.connection()).await?;
    Ok(())
}

pub async fn candidates_in_tx(tx: &mut AppTx<'_>, space: &str, query: &str) -> Result<Vec<Value>> {
    let terms = super::candidate_terms(query);
    candidates_scoped_in_tx(
        tx,
        space,
        &terms.values,
        &crate::search_scope::KnowledgeSearchScope::default(),
    )
    .await
}

pub async fn candidates_scoped_in_tx(
    tx: &mut AppTx<'_>,
    space: &str,
    terms: &[String],
    scope: &crate::search_scope::KnowledgeSearchScope,
) -> Result<Vec<Value>> {
    if terms.is_empty() {
        return Ok(vec![]);
    }
    let mut sql = sqlx::QueryBuilder::<sqlx::MySql>::new(
        "SELECT r.object_id FROM retrieval_documents AS r FORCE INDEX(PRIMARY) WHERE r.space_id=",
    );
    sql.push_bind(space).push(" AND (");
    let mut clauses = sql.separated(" OR ");
    for token in terms.iter().take(24) {
        clauses
            .push("INSTR(LOWER(CAST(r.body AS CHAR)),")
            .push_bind_unseparated(token)
            .push_unseparated(")>0");
    }
    sql.push(")");
    scope.push_constraints(
        &mut sql,
        "r.object_id",
        "JSON_UNQUOTE(JSON_EXTRACT(r.body,'$.kind'))",
        "r.body",
    );
    sql.push(" ORDER BY r.object_id LIMIT 1001");
    let rows: Vec<String> = sql.build_query_scalar().fetch_all(tx.connection()).await?;
    Ok(rows
        .into_iter()
        .map(|id| serde_json::json!({"id":id}))
        .collect())
}

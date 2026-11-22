use crate::{persistence::AppTx, types::Result};
use serde_json::Value;
use sqlx::Row;
pub async fn index_in_tx(tx: &mut AppTx<'_>, space: &str, object: &Value) -> Result<()> {
    sqlx::query("INSERT INTO retrieval_documents(object_id,space_id,version,body) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE body=IF(version<=VALUES(version),VALUES(body),body),version=GREATEST(version,VALUES(version)),indexed_at=UTC_TIMESTAMP(3)")
        .bind(object["id"].as_str()).bind(space).bind(crate::types::epoch(object["version"].as_str().unwrap_or("0"))?).bind(sqlx::types::Json(object)).execute(tx.connection()).await?;
    Ok(())
}

// 仅从本 owner 的投影推导规范窗口，保留投影独有名称/别名；不跨读正式知识表。
// consumed 是本来源相关性结果中的原始位置，quota 在合并去重之前限制响应行数。
// entry_rows保持物化，避免MySQL合并多次引用时使业务域相关JSON_TABLE条件丢行。
#[allow(clippy::too_many_arguments)]
pub async fn content_candidates_scoped_in_tx(
    tx: &mut AppTx<'_>,
    space: &str,
    query: &str,
    terms: &[String],
    scoring_terms: &[String],
    scope: &crate::search_scope::KnowledgeSearchScope,
    allowed: Option<&[String]>,
    quota: usize,
    consumed: usize,
    include_document_statements: bool,
) -> Result<Vec<Value>> {
    if quota == 0 || terms.is_empty() || allowed.is_some_and(|ids| ids.is_empty()) {
        return Ok(vec![]);
    }
    let score_base = scoring_terms.len() as i64 + 1;
    let mut sql = sqlx::QueryBuilder::<sqlx::MySql>::new(
        "WITH query_terms AS (SELECT JSON_UNQUOTE(q.term) AS term FROM JSON_TABLE(",
    );
    sql.push_bind(sqlx::types::Json(
        terms.iter().take(24).collect::<Vec<_>>(),
    ))
    .push(",'$[*]' COLUMNS(term JSON PATH '$')) AS q), \
         scoring_terms AS (SELECT JSON_UNQUOTE(q.term) AS term FROM JSON_TABLE(")
    .push_bind(sqlx::types::Json(scoring_terms))
    .push(
        ",'$[*]' COLUMNS(term JSON PATH '$')) AS q), \
         entry_rows AS (SELECT r.object_id AS id,r.version, \
         CASE WHEN JSON_TYPE(JSON_EXTRACT(r.body,'$.name'))='STRING' \
              THEN JSON_UNQUOTE(JSON_EXTRACT(r.body,'$.name')) ELSE '' END AS name, \
         CASE WHEN JSON_TYPE(JSON_EXTRACT(r.body,'$.kind'))='STRING' \
              THEN JSON_UNQUOTE(JSON_EXTRACT(r.body,'$.kind')) ELSE '' END AS kind, \
         JSON_EXTRACT(j.e,'$.entry_id') AS entry_id, \
         JSON_EXTRACT(j.e,'$.path') AS path, \
         CASE WHEN JSON_UNQUOTE(JSON_EXTRACT(r.body,'$.kind'))='document' THEN JSON_EXTRACT(j.e,'$.suggestion.statements') \
              WHEN JSON_TYPE(JSON_EXTRACT(j.e,'$.human_override'))='OBJECT' THEN JSON_EXTRACT(j.e,'$.human_override.statements') \
              WHEN JSON_TYPE(JSON_EXTRACT(j.e,'$.suggestion.value'))='STRING' THEN JSON_EXTRACT(j.e,'$.suggestion.statements') \
              ELSE JSON_EXTRACT(j.e,'$.source_facts.statements') END AS statements, \
         CASE WHEN JSON_TYPE(JSON_EXTRACT(j.e,'$.label'))='STRING' \
              THEN JSON_UNQUOTE(JSON_EXTRACT(j.e,'$.label')) ELSE '' END AS label, \
         COALESCE(JSON_UNQUOTE(JSON_EXTRACT(j.e,'$.effective_structure.kind'))='query_example',FALSE) AS is_query_example, \
         CASE WHEN JSON_TYPE(JSON_EXTRACT(j.e,'$.effective_structure.applicable_question'))='STRING' \
              THEN JSON_UNQUOTE(JSON_EXTRACT(j.e,'$.effective_structure.applicable_question')) ELSE '' END AS question, \
         CASE WHEN JSON_TYPE(JSON_EXTRACT(j.e,'$.effective_structure.parameters'))='ARRAY' \
              THEN JSON_EXTRACT(j.e,'$.effective_structure.parameters') ELSE JSON_ARRAY() END AS parameters, \
         JSON_UNQUOTE(JSON_EXTRACT(j.e,'$.effective_value')) AS text \
         FROM retrieval_documents AS r FORCE INDEX(PRIMARY), \
         JSON_TABLE(r.body,'$.entries[*]' COLUMNS(e JSON PATH '$')) AS j \
         WHERE r.space_id=",
    )
    .push_bind(space)
    .push(" AND JSON_UNQUOTE(JSON_EXTRACT(r.body,'$.state'))='enabled'");
    if let Some(ids) = allowed {
        sql.push(" AND r.object_id IN (");
        let mut keys = sql.separated(",");
        for id in ids {
            keys.push_bind(id);
        }
        sql.push(")");
    }
    scope.push_constraints(
        &mut sql,
        "r.object_id",
        "JSON_UNQUOTE(JSON_EXTRACT(r.body,'$.kind'))",
        "r.body",
    );
    sql.push(
        " AND JSON_TYPE(JSON_EXTRACT(j.e,'$.effective_value'))='STRING' \
         AND BINARY COALESCE(JSON_UNQUOTE(JSON_EXTRACT(j.e,'$.path')),'') NOT IN ('ddl','etl')), \
         statement_rows AS (SELECT /*+ NO_MERGE(entry_rows) */ entry_rows.*,s.i,JSON_EXTRACT(s.value,'$.statement_id') AS statement_id, \
           CONCAT(JSON_UNQUOTE(JSON_EXTRACT(s.value,'$.text')), \
             IF(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(s.value,'$.scope_text')),'')='', '', \
               CONCAT(CHAR(10 USING utf8mb4),JSON_UNQUOTE(JSON_EXTRACT(s.value,'$.scope_text'))))) AS statement_text \
           FROM entry_rows,JSON_TABLE(CAST(COALESCE(statements,JSON_ARRAY()) AS JSON),'$[*]' \
             COLUMNS(i FOR ORDINALITY,value JSON PATH '$')) s), \
         mapped_statements AS (SELECT statement_rows.*, \
           COALESCE(SUM(CHAR_LENGTH(statement_text)+2) OVER \
             (PARTITION BY id,entry_id,path ORDER BY i ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS base, \
           SUM(CHAR_LENGTH(statement_text)) OVER (PARTITION BY id,entry_id,path) \
             +2*(COUNT(*) OVER (PARTITION BY id,entry_id,path)-1) AS rendered_chars FROM statement_rows), \
         mapping AS (SELECT id,entry_id,path,MIN(BINARY SUBSTRING(text,base+1,CHAR_LENGTH(statement_text))=BINARY statement_text \
           AND CHAR_LENGTH(text)=rendered_chars) AS aligned FROM mapped_statements GROUP BY id,entry_id,path), \
         entries AS (SELECT /*+ NO_MERGE(e) */ e.id,e.version,e.name,e.kind,e.entry_id,e.path,NULL AS statement_id,e.label,e.is_query_example,e.question,e.parameters, \
             CAST(e.text AS CHAR CHARACTER SET utf8mb4) AS text,0 AS entry_offset \
           FROM entry_rows e LEFT JOIN mapping m ON m.id=e.id AND m.entry_id=e.entry_id AND m.path=e.path \
           WHERE (e.kind='document' OR COALESCE(m.aligned,FALSE)=FALSE) \
           UNION ALL SELECT s.id,s.version,s.name,s.kind,s.entry_id,s.path,s.statement_id,s.label,s.is_query_example,s.question,s.parameters, \
             s.statement_text,IF(s.kind='document',0,s.base) AS entry_offset FROM mapped_statements s \
           JOIN mapping m ON m.id=s.id AND m.entry_id=s.entry_id AND m.path=s.path \
           WHERE s.kind='document' OR m.aligned=TRUE), \
         windows AS (SELECT id,version,name,kind,entry_id,path,statement_id,label,is_query_example,question,parameters, \
         CAST((n.i-1)*",
    )
    .push(crate::types::KNOWLEDGE_STRIDE)
    .push("+entry_offset AS UNSIGNED) AS char_offset,CAST((n.i-1)*")
    .push(crate::types::KNOWLEDGE_STRIDE)
    .push(" AS UNSIGNED) AS statement_offset,CAST(LEAST(")
    .push(crate::types::KNOWLEDGE_WINDOW)
    .push(",CHAR_LENGTH(text)-(n.i-1)*")
    .push(crate::types::KNOWLEDGE_STRIDE)
    .push(") AS UNSIGNED) AS char_length,SUBSTRING(text,(n.i-1)*")
    .push(crate::types::KNOWLEDGE_STRIDE)
    .push("+1,")
    .push(crate::types::KNOWLEDGE_WINDOW)
    .push(") AS snippet FROM entries,JSON_TABLE(CONCAT('[',REPEAT('0,',GREATEST(CEIL(CHAR_LENGTH(text)/")
    .push(crate::types::KNOWLEDGE_STRIDE)
    .push(")-1,0)),'0]'),'$[*]' COLUMNS(i FOR ORDINALITY)) AS n WHERE CHAR_LENGTH(text)>0), \
           scored AS (SELECT id,version,kind,entry_id,path,statement_id,char_offset,statement_offset,char_length, \
           CAST(INSTR(LOWER(name),")
    .push_bind(query.to_lowercase())
    .push(")>0 AS SIGNED) AS name_hit, \
           CAST((SELECT COUNT(*) FROM scoring_terms AS q WHERE INSTR(LOWER(name),q.term)>0) AS SIGNED) AS name_term_hits, \
           CAST((SELECT COUNT(*) FROM scoring_terms AS q WHERE \
             INSTR(LOWER(CONCAT(name,' ',kind,' ', \
               IF(is_query_example,CONCAT('适用问题：',question,'；参数：'),''),' ',label,'：',snippet)),q.term)>0 \
             OR (is_query_example AND (SELECT COUNT(*) FROM \
               JSON_TABLE(CAST(parameters AS JSON),'$[*]' COLUMNS(p JSON PATH '$')) AS params WHERE \
               INSTR(LOWER(CONCAT( \
                 CASE WHEN JSON_TYPE(JSON_EXTRACT(params.p,'$.name'))='STRING' THEN JSON_UNQUOTE(JSON_EXTRACT(params.p,'$.name')) ELSE '' END,' ', \
                 CASE WHEN JSON_TYPE(JSON_EXTRACT(params.p,'$.type'))='STRING' THEN JSON_UNQUOTE(JSON_EXTRACT(params.p,'$.type')) ELSE '' END,' ', \
                 CASE WHEN JSON_TYPE(JSON_EXTRACT(params.p,'$.description'))='STRING' THEN JSON_UNQUOTE(JSON_EXTRACT(params.p,'$.description')) ELSE '' END)),q.term)>0)>0)) \
             AS SIGNED) AS term_hits, \
           EXISTS(SELECT 1 FROM query_terms AS q WHERE \
             INSTR(LOWER(CONCAT(name,' ',kind,' ', \
               IF(is_query_example,CONCAT('适用问题：',question,'；参数：'),''),' ',label,'：',snippet)),q.term)>0 \
             OR (is_query_example AND EXISTS(SELECT 1 FROM \
               JSON_TABLE(CAST(parameters AS JSON),'$[*]' COLUMNS(p JSON PATH '$')) AS params WHERE \
               INSTR(LOWER(CONCAT( \
                 CASE WHEN JSON_TYPE(JSON_EXTRACT(params.p,'$.name'))='STRING' THEN JSON_UNQUOTE(JSON_EXTRACT(params.p,'$.name')) ELSE '' END,' ', \
                 CASE WHEN JSON_TYPE(JSON_EXTRACT(params.p,'$.type'))='STRING' THEN JSON_UNQUOTE(JSON_EXTRACT(params.p,'$.type')) ELSE '' END,' ', \
                 CASE WHEN JSON_TYPE(JSON_EXTRACT(params.p,'$.description'))='STRING' THEN JSON_UNQUOTE(JSON_EXTRACT(params.p,'$.description')) ELSE '' END)),q.term)>0))) \
             AS candidate_hit FROM windows) \
           SELECT id,version,kind,entry_id,path,statement_id,char_offset,statement_offset,char_length,name_hit,name_term_hits,term_hits \
           FROM scored WHERE (name_hit>0 OR candidate_hit) AND (kind<>'document' OR ")
    .push(if include_document_statements { "TRUE" } else { "statement_id IS NULL" })
    .push(") ORDER BY name_hit DESC,name_term_hits DESC,term_hits DESC,id,entry_id,path,statement_id,char_offset LIMIT ")
    .push_bind(quota as u64)
    .push(" OFFSET ")
    .push_bind(consumed as u64);
    let rows = sql.build().fetch_all(tx.connection()).await?;
    rows.into_iter()
        .map(|row| {
            let id: String = row.try_get("id")?;
            let version = row.try_get::<u64, _>("version")?.to_string();
            let entry = serde_json::json!({
                "entry_id":row.try_get::<Option<sqlx::types::Json<Value>>, _>("entry_id")?.map(|value|value.0),
                "path":row.try_get::<Option<sqlx::types::Json<Value>>, _>("path")?.map(|value|value.0),
                "statement_id":row.try_get::<Option<sqlx::types::Json<Value>>, _>("statement_id")?.map(|value|value.0),
            });
            let offset = row.try_get::<u64, _>("char_offset")? as usize;
            let record = crate::types::knowledge_record_id(
                space,
                &serde_json::json!({"id":id,"version":version}),
                &entry,
                offset,
            );
            let name_hit = row.try_get::<i64, _>("name_hit")? > 0;
            let name_term_hits: i64 = row.try_get("name_term_hits")?;
            let term_hits: i64 = row.try_get("term_hits")?;
            // 与另一SQL owner沿相同完整问句计分，跨来源只取最高值，不追加通道票。
            let score = i64::from(name_hit) * score_base * score_base
                + name_term_hits * score_base + term_hits;
            Ok(serde_json::json!({
                "id":id,"version":version,"kind":row.try_get::<String, _>("kind")?,"record_id":record,
                "projection_version":crate::types::KNOWLEDGE_PROJECTION,"channel":"lexical",
                "name_hit":name_hit,"name_term_hits":name_term_hits,"term_hits":term_hits,
                "matches":[{"fragment_id":record,"entry_id":entry["entry_id"],"path":entry["path"],
                    "statement_id":entry["statement_id"],"statement_offset":row.try_get::<u64, _>("statement_offset")?,"offset":offset,
                    "length":row.try_get::<u64, _>("char_length")?,"content_hash":null,"score":score}],
            }))
        })
        .collect()
}

// 原文来源在实际集合上的投影进度：按批推进applied_position，完成置complete。
// 集合身份含代次（collection_target为实际identity指纹），完成状态不只绑定配置名。
pub async fn record_source_projection_in_tx(
    tx: &mut AppTx<'_>,
    projection: &super::SourceProjection,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO retrieval_source_projections(source_kind,source_id,space_id,revision,collection_target,embedding_model,segmentation_version,applied_position,complete) \
         VALUES(?,?,?,?,?,?,?,?,?) \
         ON DUPLICATE KEY UPDATE revision=VALUES(revision),collection_target=VALUES(collection_target),embedding_model=VALUES(embedding_model),segmentation_version=VALUES(segmentation_version),applied_position=VALUES(applied_position),complete=VALUES(complete)",
    )
    .bind(&projection.source_kind)
    .bind(&projection.source_id)
    .bind(&projection.space_id)
    .bind(projection.revision)
    .bind(&projection.collection_target)
    .bind(&projection.embedding_model)
    .bind(projection.segmentation_version)
    .bind(projection.applied_position)
    .bind(u32::from(projection.complete))
    .execute(tx.connection())
    .await?;
    Ok(())
}

// 完成投影的 applied_position 是原文字符数；未完成投影只在已索引长正文后参与召回。
pub async fn long_platform_source_ids_in_tx(
    tx: &mut AppTx<'_>,
    space: &str,
) -> Result<std::collections::HashSet<String>> {
    let ids = sqlx::query_scalar(
        "SELECT source_id FROM retrieval_source_projections \
         WHERE space_id=? AND source_kind='platform' AND embedding_model=? \
           AND segmentation_version=? AND applied_position>100000",
    )
    .bind(space)
    .bind(&super::embedding::SPEC.version)
    .bind(super::source_segments::SEGMENTATION_VERSION_NUMBER)
    .fetch_all(tx.connection())
    .await?;
    Ok(ids.into_iter().collect())
}

// 指定来源集合的投影覆盖：用于检索覆盖/滞后判断，输入限定在本题允许范围内，
// 不做全库扫描。返回每个来源的当前修订投影是否完整覆盖到实际集合。
pub async fn source_projection_states_in_tx(
    tx: &mut AppTx<'_>,
    space: &str,
    sources: &[(String, String, u64)],
    target: &str,
) -> Result<Vec<bool>> {
    let mut states = Vec::with_capacity(sources.len());
    for chunk in sources.chunks(50) {
        let mut query = sqlx::QueryBuilder::<sqlx::MySql>::new(
            "SELECT source_kind,source_id,revision FROM retrieval_source_projections WHERE space_id=",
        );
        query
            .push_bind(space)
            .push(" AND collection_target=")
            .push_bind(target)
            .push(" AND embedding_model=")
            .push_bind(&super::embedding::SPEC.version)
            .push(" AND segmentation_version=")
            .push_bind(super::source_segments::SEGMENTATION_VERSION_NUMBER)
            .push(" AND complete=1 AND (source_kind,source_id,revision) IN (");
        for (index, (kind, id, revision)) in chunk.iter().enumerate() {
            if index > 0 {
                query.push(",");
            }
            query
                .push("(")
                .push_bind(kind)
                .push(",")
                .push_bind(id)
                .push(",")
                .push_bind(revision)
                .push(")");
        }
        query.push(")");
        let current: std::collections::HashSet<(String, String, u64)> = query
            .build_query_as()
            .fetch_all(tx.connection())
            .await?
            .into_iter()
            .collect();
        states.extend(chunk.iter().map(|source| current.contains(source)));
    }
    Ok(states)
}

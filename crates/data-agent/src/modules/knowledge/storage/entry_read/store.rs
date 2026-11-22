use super::*;

// 当前列绑定与依赖有效性仍由原use_cases核验，支持目录不代表支持正文已交付。
pub async fn read_entry_page_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    reference: &crate::contracts::generated::EvidenceRef,
    statement_id: Option<&str>,
    structure_only: bool,
    offset: usize,
    limit: usize,
) -> Result<Value> {
    check_read_access_in_tx(tx, ctx, &reference.object_id).await?;
    let version = epoch(&reference.version)?;
    if let Some(statement_id) = statement_id.filter(|_| !structure_only) {
        let row = sqlx::query(
            "WITH selected AS (SELECT k.id,k.kind,k.state,k.version,j.e,st.body AS statement \
               FROM knowledge_objects k \
               LEFT JOIN JSON_TABLE(k.body,'$.entries[*]' COLUMNS(e JSON PATH '$')) j \
                 ON k.version=? AND BINARY JSON_UNQUOTE(JSON_EXTRACT(j.e,'$.path'))=BINARY ? \
               LEFT JOIN knowledge_statements st ON st.object_id=k.id AND st.version=k.version \
                 AND st.space_id=k.space_id AND BINARY st.entry_path=BINARY ? \
                 AND BINARY st.statement_id=BINARY ? AND st.layer=CASE \
                   WHEN k.kind='document' THEN 'model_suggestion' \
                   WHEN JSON_TYPE(JSON_EXTRACT(j.e,'$.human_override'))='OBJECT' THEN 'human_override' \
                   WHEN JSON_TYPE(JSON_EXTRACT(j.e,'$.suggestion.value'))='STRING' THEN 'model_suggestion' \
                   ELSE 'source_fact' END \
               WHERE k.id=? AND k.space_id=?), \
             rendered AS (SELECT selected.*, \
               JSON_UNQUOTE(JSON_EXTRACT(statement,'$.text')) AS text, \
               JSON_UNQUOTE(JSON_EXTRACT(statement,'$.scope_text')) AS scope_text FROM selected), \
             content AS (SELECT rendered.*,CONCAT(text,IF(scope_text='', '',CONCAT(CHAR(10 USING utf8mb4),scope_text))) AS text_value \
               FROM rendered) \
             SELECT id,kind,state,version,JSON_EXTRACT(e,'$.entry_id') AS entry_id, \
               JSON_EXTRACT(e,'$.path') AS path,SUBSTRING(text_value,?+1,?) AS content, \
               CHAR_LENGTH(text_value) AS total_chars,CHAR_LENGTH(text) AS text_chars, \
               CHAR_LENGTH(scope_text) AS scope_chars, \
               JSON_EXTRACT(statement,'$.supports_complete') AS supports_complete, \
               JSON_EXTRACT(statement,'$.citations') AS citations, \
               JSON_LENGTH(JSON_EXTRACT(statement,'$.supports')) AS supports_total, \
               (SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT( \
                 'support_id',JSON_EXTRACT(p.item,'$.support_id'),'role',JSON_EXTRACT(p.item,'$.role'), \
                 'reference',JSON_EXTRACT(p.item,'$.reference'),'embedded_in',JSON_EXTRACT(p.item,'$.embedded_in'))),JSON_ARRAY()) \
                 FROM JSON_TABLE(CAST(statement AS JSON),'$.supports[*]' COLUMNS(n FOR ORDINALITY,item JSON PATH '$')) p \
                 WHERE p.n<=50) AS supports FROM content",
        )
        .bind(version)
        .bind(&reference.path)
        .bind(&reference.path)
        .bind(statement_id)
        .bind(&reference.object_id)
        .bind(&ctx.space_id)
        .bind(offset as i64)
        .bind(limit as i64)
        .fetch_optional(tx.connection())
        .await?
        .ok_or(Error::new("not_available"))?;
        if row.get::<String, _>("state") != "enabled" {
            return Err(Error::new("not_available"));
        }
        if row.get::<u64, _>("version") != version {
            return Err(Error::new("stale_knowledge"));
        }
        let content = row
            .get::<Option<String>, _>("content")
            .ok_or(Error::new("not_available"))?;
        let total = row.get::<i64, _>("total_chars") as usize;
        if offset > total {
            return Err(Error::new("invalid_input"));
        }
        let end = offset + content.chars().count();
        let text_chars = row.get::<i64, _>("text_chars") as usize;
        let scope_start = text_chars + 1;
        let text = content
            .chars()
            .take(text_chars.saturating_sub(offset))
            .collect::<String>();
        let scope_text = content
            .chars()
            .skip(scope_start.saturating_sub(offset))
            .collect::<String>();
        let supports_total = row.get::<i64, _>("supports_total") as usize;
        return Ok(
            json!({"id":reference.object_id,"kind":row.get::<String,_>("kind"),
            "version":reference.version,"entry_id":row.get::<sqlx::types::Json<Value>,_>("entry_id").0,
            "path":reference.path,"statement_id":statement_id,"statement_offset":offset,
            "content":content,"content_page":{"offset":offset,"total_chars":total,
                "complete":offset==0 && end>=total,"next_offset":if end<total{Some(end)}else{None}},
            "text":text,"text_chars":text_chars,"scope_text":scope_text,
            "scope_chars":row.get::<i64,_>("scope_chars"),
            "supports_complete":row.get::<Option<sqlx::types::Json<Value>>,_>("supports_complete").map(|v|v.0),
            "citations":row.get::<sqlx::types::Json<Value>,_>("citations").0,
            "supports":row.get::<sqlx::types::Json<Value>,_>("supports").0,
            "supports_total":supports_total,"supports_next_offset":if supports_total>50{Some(50)}else{None}}),
        );
    }
    if structure_only {
        let row = sqlx::query(
            "WITH selected AS (SELECT k.id,k.kind,k.state,k.version,JSON_EXTRACT(k.body,'$.related_ids') AS related_ids,j.e,CASE \
               WHEN k.kind='document' THEN 'model_suggestion' \
               WHEN JSON_TYPE(JSON_EXTRACT(j.e,'$.human_override'))='OBJECT' THEN 'human_override' \
               WHEN JSON_TYPE(JSON_EXTRACT(j.e,'$.suggestion.value'))='STRING' THEN 'model_suggestion' \
               ELSE 'source_fact' END AS layer, \
               CASE WHEN JSON_TYPE(JSON_EXTRACT(j.e,'$.human_override'))='OBJECT' \
                 THEN JSON_EXTRACT(j.e,'$.human_override.structured_value') \
                 WHEN JSON_TYPE(JSON_EXTRACT(j.e,'$.suggestion.value'))='STRING' \
                 THEN JSON_EXTRACT(j.e,'$.suggestion.structured_value') \
                 ELSE JSON_EXTRACT(j.e,'$.source_facts.structured_value') END AS structure \
               FROM knowledge_objects k \
               LEFT JOIN JSON_TABLE(k.body,'$.entries[*]' COLUMNS(e JSON PATH '$')) j \
                 ON k.version=? AND BINARY JSON_UNQUOTE(JSON_EXTRACT(j.e,'$.path'))=BINARY ? \
               WHERE k.id=? AND k.space_id=?), \
             statements AS (SELECT st.statement_id,st.body FROM selected JOIN knowledge_statements st \
               ON st.object_id=selected.id AND st.version=selected.version AND st.layer=selected.layer \
                 AND BINARY st.entry_path=BINARY JSON_UNQUOTE(JSON_EXTRACT(e,'$.path')) \
               WHERE (? IS NULL OR BINARY st.statement_id=BINARY ?)), \
             support_directory AS (SELECT JSON_OBJECT( \
               'support_id',JSON_EXTRACT(p.item,'$.support_id'),'role',JSON_EXTRACT(p.item,'$.role'), \
               'reference',JSON_EXTRACT(p.item,'$.reference'),'embedded_in',JSON_EXTRACT(p.item,'$.embedded_in')) AS item, \
               ROW_NUMBER() OVER (ORDER BY statement_id,p.n) AS position \
               FROM statements,JSON_TABLE(CAST(statements.body AS JSON),'$.supports[*]' COLUMNS(n FOR ORDINALITY,item JSON PATH '$')) p) \
             SELECT id,kind,state,version,related_ids,JSON_EXTRACT(e,'$.entry_id') AS entry_id, \
               structure AS binding_structure, \
               IF(JSON_TYPE(structure)='OBJECT',SUBSTRING(CAST(structure AS CHAR CHARACTER SET utf8mb4),?+1,?),NULL) AS content, \
               CHAR_LENGTH(CAST(structure AS CHAR CHARACTER SET utf8mb4)) AS total_chars, \
               JSON_OBJECT('kind',JSON_EXTRACT(structure,'$.kind'),'table',JSON_EXTRACT(structure,'$.table'), \
                 'left_table',JSON_EXTRACT(structure,'$.left_table'),'right_table',JSON_EXTRACT(structure,'$.right_table'), \
                 'dependencies',JSON_EXTRACT(structure,'$.dependencies'), \
                 'verification',JSON_OBJECT('evidence_refs',JSON_EXTRACT(structure,'$.verification.evidence_refs'))) AS structure_refs, \
               (? IS NULL OR EXISTS(SELECT 1 FROM statements)) AS statement_available, \
               IF(? IS NULL,NULL,(SELECT JSON_EXTRACT(body,'$.supports_complete') FROM statements)) AS supports_complete, \
               (SELECT COALESCE(JSON_ARRAYAGG(item),JSON_ARRAY()) FROM support_directory WHERE position<=50) AS supports, \
               (SELECT COUNT(*) FROM support_directory) AS supports_total, \
               (SELECT COALESCE(JSON_ARRAYAGG(c.item),JSON_ARRAY()) FROM statements, \
                 JSON_TABLE(CAST(statements.body AS JSON),'$.citations[*]' COLUMNS(item JSON PATH '$')) c) AS citations \
               FROM selected",
        )
        .bind(version)
        .bind(&reference.path)
        .bind(&reference.object_id)
        .bind(&ctx.space_id)
        .bind(statement_id)
        .bind(statement_id)
        .bind(offset as i64)
        .bind(limit as i64)
        .bind(statement_id)
        .bind(statement_id)
        .fetch_optional(tx.connection())
        .await?
        .ok_or(Error::new("not_available"))?;
        if row.get::<String, _>("state") != "enabled" {
            return Err(Error::new("not_available"));
        }
        if row.get::<u64, _>("version") != version {
            return Err(Error::new("stale_knowledge"));
        }
        if row.get::<i64, _>("statement_available") == 0 {
            return Err(Error::new("not_available"));
        }
        let content = row
            .get::<Option<String>, _>("content")
            .ok_or(Error::new("not_available"))?;
        let total = row.get::<i64, _>("total_chars") as usize;
        if offset > total {
            return Err(Error::new("invalid_input"));
        }
        let end = offset + content.chars().count();
        let complete = offset == 0 && end >= total;
        let structure = if complete {
            serde_json::from_str::<Value>(&content).map_err(|_| Error::new("invalid_input"))?
        } else {
            Value::Null
        };
        let page = json!({"offset":offset,"total_chars":total,"complete":complete,
            "next_offset":if end<total{Some(end)}else{None}});
        let supports_total = row.get::<i64, _>("supports_total") as usize;
        let mut value = json!({"id":reference.object_id,"kind":row.get::<String,_>("kind"),
            "version":reference.version,"entry_id":row.get::<sqlx::types::Json<Value>,_>("entry_id").0,
            "path":reference.path,"content":content,"content_page":page,
            "structure_text":content,"structure_page":page,"effective_structure":structure,
            "structure_refs":row.get::<sqlx::types::Json<Value>,_>("structure_refs").0,
            "binding_structure":row.get::<sqlx::types::Json<Value>,_>("binding_structure").0,
            "related_ids":row.get::<Option<sqlx::types::Json<Value>>,_>("related_ids").map(|v|v.0).unwrap_or(json!([])),
            "supports_complete":row.get::<Option<sqlx::types::Json<Value>>,_>("supports_complete").map(|v|v.0),
            "supports":row.get::<sqlx::types::Json<Value>,_>("supports").0,
            "supports_total":supports_total,"supports_next_offset":if supports_total>50{Some(50)}else{None},
            "citations":row.get::<sqlx::types::Json<Value>,_>("citations").0});
        if let Some(statement_id) = statement_id {
            value["statement_id"] = json!(statement_id);
        }
        return Ok(value);
    }
    let row = sqlx::query(
        "WITH selected AS (SELECT k.id,k.kind,k.state,k.version,j.e,CASE \
           WHEN k.kind='document' THEN 'model_suggestion' \
           WHEN JSON_TYPE(JSON_EXTRACT(j.e,'$.human_override'))='OBJECT' THEN 'human_override' \
           WHEN JSON_TYPE(JSON_EXTRACT(j.e,'$.suggestion.value'))='STRING' THEN 'model_suggestion' \
           ELSE 'source_fact' END AS layer \
           FROM knowledge_objects k \
           LEFT JOIN JSON_TABLE(k.body,'$.entries[*]' COLUMNS(e JSON PATH '$')) j \
             ON k.version=? AND BINARY JSON_UNQUOTE(JSON_EXTRACT(j.e,'$.path'))=BINARY ? \
             AND JSON_TYPE(JSON_EXTRACT(j.e,'$.effective_value'))='STRING' \
           WHERE k.id=? AND k.space_id=?), \
         statements AS (SELECT st.statement_id,st.body FROM selected JOIN knowledge_statements st \
           ON st.object_id=selected.id AND st.version=selected.version AND st.layer=selected.layer \
             AND BINARY st.entry_path=BINARY JSON_UNQUOTE(JSON_EXTRACT(e,'$.path'))), \
         support_directory AS (SELECT JSON_OBJECT( \
           'support_id',JSON_EXTRACT(p.item,'$.support_id'),'role',JSON_EXTRACT(p.item,'$.role'), \
           'reference',JSON_EXTRACT(p.item,'$.reference'),'embedded_in',JSON_EXTRACT(p.item,'$.embedded_in')) AS item, \
           ROW_NUMBER() OVER (ORDER BY statement_id,p.n) AS position \
           FROM statements,JSON_TABLE(CAST(statements.body AS JSON),'$.supports[*]' COLUMNS(n FOR ORDINALITY,item JSON PATH '$')) p) \
         SELECT id,kind,state,version,JSON_EXTRACT(e,'$.entry_id') AS entry_id, \
           SUBSTRING(JSON_UNQUOTE(JSON_EXTRACT(e,'$.effective_value')),?+1,?) AS content, \
           CHAR_LENGTH(JSON_UNQUOTE(JSON_EXTRACT(e,'$.effective_value'))) AS total_chars, \
           (SELECT COALESCE(JSON_ARRAYAGG(item),JSON_ARRAY()) FROM support_directory WHERE position<=50) AS supports, \
           (SELECT COUNT(*) FROM support_directory) AS supports_total, \
           (SELECT COALESCE(JSON_ARRAYAGG(c.item),JSON_ARRAY()) FROM statements, \
             JSON_TABLE(CAST(statements.body AS JSON),'$.citations[*]' COLUMNS(item JSON PATH '$')) c) AS citations \
           FROM selected",
    )
    .bind(version)
    .bind(&reference.path)
    .bind(&reference.object_id)
    .bind(&ctx.space_id)
    .bind(offset as i64)
    .bind(limit as i64)
    .fetch_optional(tx.connection())
    .await?
    .ok_or(Error::new("not_available"))?;
    if row.get::<String, _>("state") != "enabled" {
        return Err(Error::new("not_available"));
    }
    if row.get::<u64, _>("version") != version {
        return Err(Error::new("stale_knowledge"));
    }
    let content = row
        .get::<Option<String>, _>("content")
        .ok_or(Error::new("not_available"))?;
    let total = row.get::<i64, _>("total_chars") as usize;
    if offset > total {
        return Err(Error::new("invalid_input"));
    }
    let end = offset + content.chars().count();
    let supports_total = row.get::<i64, _>("supports_total") as usize;
    Ok(
        json!({"id":reference.object_id,"kind":row.get::<String,_>("kind"),
        "version":reference.version,"entry_id":row.get::<sqlx::types::Json<Value>,_>("entry_id").0,
        "path":reference.path,"content":content,"content_page":{"offset":offset,"total_chars":total,
            "complete":offset==0 && end>=total,"next_offset":if end<total{Some(end)}else{None}},
        "supports_complete":null,"supports":row.get::<sqlx::types::Json<Value>,_>("supports").0,
        "supports_total":supports_total,"supports_next_offset":if supports_total>50{Some(50)}else{None},
        "citations":row.get::<sqlx::types::Json<Value>,_>("citations").0}),
    )
}

// 支持内容与正文独立读取；每批最多50项，长支持只保留定位，不把大正文搬回应用。
pub async fn read_supports_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    reference: &crate::contracts::generated::EvidenceRef,
    statement_id: Option<&str>,
    offset: usize,
    limit: usize,
) -> Result<Value> {
    check_read_access_in_tx(tx, ctx, &reference.object_id).await?;
    if limit == 0 || limit > 50 {
        return Err(Error::new("invalid_input"));
    }
    let version = epoch(&reference.version)?;
    let mut rows = sqlx::query(
        "WITH selected AS (SELECT k.id,k.kind,k.state,k.version,j.e,CASE \
           WHEN k.kind='document' THEN 'model_suggestion' \
           WHEN JSON_TYPE(JSON_EXTRACT(j.e,'$.human_override'))='OBJECT' THEN 'human_override' \
           WHEN JSON_TYPE(JSON_EXTRACT(j.e,'$.suggestion.value'))='STRING' THEN 'model_suggestion' \
           ELSE 'source_fact' END AS layer FROM knowledge_objects k \
           LEFT JOIN JSON_TABLE(k.body,'$.entries[*]' COLUMNS(e JSON PATH '$')) j \
             ON k.version=? AND BINARY JSON_UNQUOTE(JSON_EXTRACT(j.e,'$.path'))=BINARY ? \
           WHERE k.id=? AND k.space_id=?), \
         statements AS (SELECT st.statement_id,st.body FROM selected JOIN knowledge_statements st \
           ON st.object_id=selected.id AND st.version=selected.version AND st.layer=selected.layer \
           AND BINARY st.entry_path=BINARY JSON_UNQUOTE(JSON_EXTRACT(e,'$.path')) \
           WHERE (? IS NULL OR BINARY st.statement_id=BINARY ?)), \
         expanded AS (SELECT st.statement_id,p.n,p.support_id, \
           ROW_NUMBER() OVER (PARTITION BY BINARY p.support_id ORDER BY BINARY st.statement_id,p.n) AS duplicate \
           FROM statements st,JSON_TABLE(CAST(st.body AS JSON),'$.supports[*]' \
             COLUMNS(n FOR ORDINALITY,support_id VARCHAR(64) PATH '$.support_id')) p), \
         directory AS (SELECT expanded.*,ROW_NUMBER() OVER (ORDER BY BINARY statement_id,n) AS position \
           FROM expanded WHERE duplicate=1), \
         chosen AS (SELECT directory.position,st.statement_id, \
           JSON_EXTRACT(st.body,CONCAT('$.supports[',directory.n-1,']')) AS item, \
           CHAR_LENGTH(JSON_UNQUOTE(JSON_EXTRACT(st.body,'$.text'))) AS text_chars \
           FROM directory JOIN statements st ON BINARY st.statement_id=BINARY directory.statement_id \
           WHERE directory.position>? AND directory.position<=?) \
         SELECT selected.state,selected.version,JSON_EXTRACT(e,'$.entry_id') AS entry_id,d.position, \
           (? IS NULL OR EXISTS(SELECT 1 FROM statements)) AS statement_available, \
           (SELECT COUNT(*) FROM directory) AS total, \
           IF(d.position IS NULL,NULL,JSON_OBJECT( \
             'support_id',JSON_EXTRACT(d.item,'$.support_id'),'role',JSON_EXTRACT(d.item,'$.role'), \
             'reference',JSON_EXTRACT(d.item,'$.reference'),'embedded_in',JSON_EXTRACT(d.item,'$.embedded_in'), \
             'statement_id',d.statement_id, \
             'content',IF(JSON_TYPE(JSON_EXTRACT(d.item,'$.content'))='STRING' \
               AND CHAR_LENGTH(JSON_UNQUOTE(JSON_EXTRACT(d.item,'$.content')))<=8192, \
               JSON_EXTRACT(d.item,'$.content'),NULL), \
             'content_chars',IF(JSON_TYPE(JSON_EXTRACT(d.item,'$.content'))='STRING', \
               CHAR_LENGTH(JSON_UNQUOTE(JSON_EXTRACT(d.item,'$.content'))),NULL), \
             'embedded_offset',IF(JSON_EXTRACT(d.item,'$.embedded_in.locator.offset') IS NULL,NULL, \
               CAST(JSON_UNQUOTE(JSON_EXTRACT(d.item,'$.embedded_in.locator.offset')) AS UNSIGNED) + \
               IF(JSON_UNQUOTE(JSON_EXTRACT(d.item,'$.embedded_in.field'))='scope_text', \
                 d.text_chars+1,0)), \
             'position',d.position)) AS support \
           FROM selected LEFT JOIN chosen d ON TRUE",
    )
    .bind(version)
    .bind(&reference.path)
    .bind(&reference.object_id)
    .bind(&ctx.space_id)
    .bind(statement_id)
    .bind(statement_id)
    .bind(offset as i64)
    .bind(offset.saturating_add(limit) as i64)
    .bind(statement_id)
    .fetch_all(tx.connection())
    .await?;
    let row = rows.first().ok_or(Error::new("not_available"))?;
    if row.get::<String, _>("state") != "enabled" {
        return Err(Error::new("not_available"));
    }
    if row.get::<u64, _>("version") != version {
        return Err(Error::new("stale_knowledge"));
    }
    if row
        .get::<Option<sqlx::types::Json<Value>>, _>("entry_id")
        .is_none()
        || row.get::<i64, _>("statement_available") == 0
    {
        return Err(Error::new("not_available"));
    }
    let total = row.get::<i64, _>("total") as usize;
    if offset > total {
        return Err(Error::new("invalid_cursor"));
    }
    rows.sort_by_key(|row| row.get::<Option<u64>, _>("position"));
    let supports = rows
        .iter()
        .filter_map(|row| {
            row.get::<Option<sqlx::types::Json<Value>>, _>("support")
                .map(|value| value.0)
        })
        .collect::<Vec<_>>();
    let end = offset + supports.len();
    Ok(json!({"supports":supports,"total":total,"next_offset":if end<total{Some(end)}else{None}}))
}

// 支持游标用当前修订指纹绑定目录内容：同版本重整支持时persist会推进该值。
// 只窄读本行现成指纹；旧行缺失时返回空串，游标以空值绑定，不猜目录未变。
// 先选最早匹配位置再读原支持正文，避免长JSON参与排序；不能用引用全文替代。
pub async fn read_support_content_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    reference: &crate::contracts::generated::EvidenceRef,
    support: (&str, &str),
    offset: usize,
    limit: usize,
) -> Result<Value> {
    check_read_access_in_tx(tx, ctx, &reference.object_id).await?;
    let (statement_id, support_id) = support;
    if limit == 0 || limit > 8192 {
        return Err(Error::new("invalid_input"));
    }
    let version = epoch(&reference.version)?;
    let row = sqlx::query(
        "WITH selected AS (SELECT k.id,k.kind,k.state,k.version,j.e,CASE \
           WHEN k.kind='document' THEN 'model_suggestion' \
           WHEN JSON_TYPE(JSON_EXTRACT(j.e,'$.human_override'))='OBJECT' THEN 'human_override' \
           WHEN JSON_TYPE(JSON_EXTRACT(j.e,'$.suggestion.value'))='STRING' THEN 'model_suggestion' \
           ELSE 'source_fact' END AS layer FROM knowledge_objects k \
           LEFT JOIN JSON_TABLE(k.body,'$.entries[*]' COLUMNS(e JSON PATH '$')) j \
             ON k.version=? AND BINARY JSON_UNQUOTE(JSON_EXTRACT(j.e,'$.path'))=BINARY ? \
           WHERE k.id=? AND k.space_id=?), \
         chosen_position AS (SELECT st.object_id,st.version,st.statement_id,MIN(p.n) AS n \
           FROM selected JOIN knowledge_statements st \
             ON st.object_id=selected.id AND st.version=selected.version AND st.layer=selected.layer \
             AND BINARY st.entry_path=BINARY JSON_UNQUOTE(JSON_EXTRACT(e,'$.path')) \
           JOIN JSON_TABLE(CAST(st.body AS JSON),'$.supports[*]' \
             COLUMNS(n FOR ORDINALITY,support_id VARCHAR(64) PATH '$.support_id')) p \
             ON BINARY p.support_id=BINARY ? WHERE BINARY st.statement_id=BINARY ? \
           GROUP BY st.object_id,st.version,st.statement_id), \
         chosen AS (SELECT JSON_EXTRACT(st.body,CONCAT('$.supports[',p.n-1,'].content')) AS content \
           FROM chosen_position p JOIN knowledge_statements st \
             ON st.object_id=p.object_id AND st.version=p.version AND st.statement_id=p.statement_id) \
         SELECT selected.state,selected.version,JSON_EXTRACT(e,'$.entry_id') AS entry_id, \
           SUBSTRING(JSON_UNQUOTE(chosen.content),?+1,?) AS content, \
           CHAR_LENGTH(JSON_UNQUOTE(chosen.content)) AS total_chars \
           FROM selected LEFT JOIN chosen ON JSON_TYPE(chosen.content)='STRING'",
    )
    .bind(version)
    .bind(&reference.path)
    .bind(&reference.object_id)
    .bind(&ctx.space_id)
    .bind(support_id)
    .bind(statement_id)
    .bind(offset as i64)
    .bind(limit as i64)
    .fetch_optional(tx.connection())
    .await?
    .ok_or(Error::new("not_available"))?;
    if row.get::<String, _>("state") != "enabled" {
        return Err(Error::new("not_available"));
    }
    if row.get::<u64, _>("version") != version {
        return Err(Error::new("stale_knowledge"));
    }
    let content = row
        .get::<Option<String>, _>("content")
        .ok_or(Error::new("not_available"))?;
    let total = row.get::<i64, _>("total_chars") as usize;
    if offset > total {
        return Err(Error::new("invalid_cursor"));
    }
    let end = offset + content.chars().count();
    Ok(
        json!({"content":content,"content_page":{"offset":offset,"total_chars":total,
        "complete":offset==0 && end>=total,"next_offset":if end<total{Some(end)}else{None}}}),
    )
}

pub async fn read_entries_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
    version: u64,
    record: &str,
    location: &mut Value,
    scope: &crate::search_scope::KnowledgeSearchScope,
) -> Result<Option<Value>> {
    let mut head_sql = sqlx::QueryBuilder::<sqlx::MySql>::new(
        "SELECT k.name,k.kind,k.source_id,k.updated_by,\
         JSON_UNQUOTE(JSON_EXTRACT(k.body,'$.source_version')) AS source_version,\
         JSON_EXTRACT(k.body,'$.related_ids') AS related_ids,\
         JSON_LENGTH(JSON_EXTRACT(k.body,'$.entries')) AS entry_count \
         FROM knowledge_objects AS k WHERE k.id=",
    );
    head_sql
        .push_bind(object)
        .push(" AND k.space_id=")
        .push_bind(&ctx.space_id)
        .push(" AND k.version=")
        .push_bind(version)
        .push(" AND k.state='enabled'");
    scope.push_constraints(&mut head_sql, "k.id", "k.kind", "k.body");
    push_table_access(&mut head_sql, ctx);
    let head = head_sql.build().fetch_optional(tx.connection()).await?;
    let Some(head) = head else {
        return Ok(None);
    };
    // 只取同版长度/映射元信息核原键；完整定位也须属于该规范窗口，不按query另选正文。
    let units = sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
            "WITH entries AS (SELECT JSON_EXTRACT(j.e,'$.entry_id') AS entry_id, \
               JSON_EXTRACT(j.e,'$.path') AS path,JSON_UNQUOTE(JSON_EXTRACT(j.e,'$.effective_value')) AS text, \
               CASE WHEN k.kind='document' THEN JSON_EXTRACT(j.e,'$.suggestion.statements') \
                 WHEN JSON_TYPE(JSON_EXTRACT(j.e,'$.human_override'))='OBJECT' THEN JSON_EXTRACT(j.e,'$.human_override.statements') \
                 WHEN JSON_TYPE(JSON_EXTRACT(j.e,'$.suggestion.value'))='STRING' THEN JSON_EXTRACT(j.e,'$.suggestion.statements') \
                 ELSE JSON_EXTRACT(j.e,'$.source_facts.statements') END AS statements,k.kind \
               FROM knowledge_objects k, \
                 JSON_TABLE(k.body,'$.entries[*]' COLUMNS(e JSON PATH '$')) j \
               WHERE k.id=? AND k.version=? AND JSON_TYPE(JSON_EXTRACT(j.e,'$.effective_value'))='STRING' \
                 AND BINARY COALESCE(JSON_UNQUOTE(JSON_EXTRACT(j.e,'$.path')),'') NOT IN ('ddl','etl')), \
             statements AS (SELECT /*+ NO_MERGE(entries) */ entries.*,s.i, \
               JSON_EXTRACT(s.value,'$.statement_id') AS statement_id, \
               CONCAT(JSON_UNQUOTE(JSON_EXTRACT(s.value,'$.text')), \
                 IF(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(s.value,'$.scope_text')),'')='', '', \
                   CONCAT(CHAR(10 USING utf8mb4),JSON_UNQUOTE(JSON_EXTRACT(s.value,'$.scope_text'))))) AS rendered \
               FROM entries,JSON_TABLE(CAST(COALESCE(statements,JSON_ARRAY()) AS JSON),'$[*]' \
                 COLUMNS(i FOR ORDINALITY,value JSON PATH '$')) s), \
             mapped AS (SELECT statements.*,COALESCE(SUM(CHAR_LENGTH(rendered)+2) OVER \
               (PARTITION BY entry_id,path ORDER BY i ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS base, \
               SUM(CHAR_LENGTH(rendered)) OVER (PARTITION BY entry_id,path) \
                 +2*(COUNT(*) OVER (PARTITION BY entry_id,path)-1) AS rendered_chars FROM statements), \
             mapping AS (SELECT entry_id,path,MIN(BINARY SUBSTRING(text,base+1,CHAR_LENGTH(rendered))=BINARY rendered \
               AND CHAR_LENGTH(text)=rendered_chars) AS aligned FROM mapped GROUP BY entry_id,path) \
             SELECT JSON_OBJECT('entry_id',e.entry_id,'path',e.path,'statement_id',NULL,'base',0,'chars',CHAR_LENGTH(e.text)) \
               FROM entries e LEFT JOIN mapping m ON m.entry_id=e.entry_id AND m.path=e.path \
               WHERE e.kind='document' OR COALESCE(m.aligned,FALSE)=FALSE \
             UNION ALL SELECT JSON_OBJECT('entry_id',s.entry_id,'path',s.path,'statement_id',s.statement_id, \
               'base',IF(s.kind='document',0,s.base),'chars',CHAR_LENGTH(s.rendered)) \
               FROM mapped s JOIN mapping m ON m.entry_id=s.entry_id AND m.path=s.path \
               WHERE s.kind='document' OR m.aligned=TRUE",
        )
        .bind(object)
        .bind(version)
        .fetch_all(tx.connection())
        .await?;
    let object_ref = json!({"id":object,"version":version.to_string()});
    let mut restored = None;
    for unit in units {
        let chars = unit.0["chars"].as_u64().unwrap_or(0) as usize;
        let base = unit.0["base"].as_u64().unwrap_or(0) as usize;
        for local in (0..chars).step_by(crate::types::KNOWLEDGE_STRIDE) {
            let offset = base + local;
            let end = offset + crate::types::KNOWLEDGE_WINDOW.min(chars - local);
            if location["offset"]
                .as_u64()
                .is_some_and(|value| value < offset as u64 || value >= end as u64)
                || crate::types::knowledge_record_id(&ctx.space_id, &object_ref, &unit.0, offset)
                    != record
            {
                continue;
            }
            let display_offset = if location["offset"].is_null() {
                offset as u64
            } else if let Some(value) = location["offset"].as_u64() {
                value
            } else {
                return Ok(None);
            };
            let display_length = if location["length"].is_null() {
                end as u64 - display_offset
            } else if let Some(value) = location["length"].as_u64() {
                value
            } else {
                return Ok(None);
            };
            if display_length == 0 || display_length > end as u64 - display_offset {
                return Ok(None);
            }
            // 展示可取规范窗口的子区间；缺失的陈述坐标按同一原位置恢复。
            let expected = json!({"entry_id":unit.0["entry_id"],"path":unit.0["path"],
                "statement_id":unit.0["statement_id"],"statement_offset":display_offset-base as u64,
                "offset":display_offset,"length":display_length});
            if ["entry_id", "path", "statement_id", "statement_offset"]
                .iter()
                .any(|field| !location[*field].is_null() && location[*field] != expected[*field])
            {
                return Ok(None);
            }
            let mut value = location.clone();
            for (field, expected) in expected.as_object().expect("location").iter() {
                if value[field].is_null() {
                    value[field] = expected.clone();
                }
            }
            restored = Some(value);
            break;
        }
        if restored.is_some() {
            break;
        }
    }
    let Some(restored) = restored else {
        return Ok(None);
    };
    *location = restored;
    let (Some(entry_id), Some(path), Some(offset), Some(length)) = (
        location["entry_id"].as_str(),
        location["path"].as_str(),
        location["offset"].as_u64(),
        location["length"].as_u64(),
    ) else {
        return Ok(None);
    };
    if length == 0 || length > crate::types::KNOWLEDGE_WINDOW as u64 {
        return Ok(None);
    }
    let statement_id = location["statement_id"]
        .as_str()
        .filter(|id| !id.is_empty());
    let rows = if let Some(statement_id) = statement_id {
        let Some(local) = location["statement_offset"].as_u64() else {
            return Ok(None);
        };
        sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
            "WITH selected AS (SELECT j.e,k.kind,CASE WHEN k.kind='document' THEN 'model_suggestion' \
               WHEN JSON_TYPE(JSON_EXTRACT(j.e,'$.human_override'))='OBJECT' THEN 'human_override' \
               WHEN JSON_TYPE(JSON_EXTRACT(j.e,'$.suggestion.value'))='STRING' THEN 'model_suggestion' ELSE 'source_fact' END AS layer, \
               CASE WHEN k.kind='document' THEN JSON_EXTRACT(j.e,'$.suggestion.statements') \
               WHEN JSON_TYPE(JSON_EXTRACT(j.e,'$.human_override'))='OBJECT' THEN JSON_EXTRACT(j.e,'$.human_override.statements') \
               WHEN JSON_TYPE(JSON_EXTRACT(j.e,'$.suggestion.value'))='STRING' THEN JSON_EXTRACT(j.e,'$.suggestion.statements') \
               ELSE JSON_EXTRACT(j.e,'$.source_facts.statements') END AS statements \
               FROM knowledge_objects k, \
               JSON_TABLE(k.body,'$.entries[*]' COLUMNS(e JSON PATH '$')) j \
               WHERE k.id=? AND k.version=? AND BINARY JSON_UNQUOTE(JSON_EXTRACT(j.e,'$.entry_id'))=BINARY ? \
               AND BINARY JSON_UNQUOTE(JSON_EXTRACT(j.e,'$.path'))=BINARY ?), \
             units AS (SELECT selected.*,s.i,s.value,JSON_UNQUOTE(JSON_EXTRACT(s.value,'$.statement_id')) AS sid, \
               JSON_UNQUOTE(JSON_EXTRACT(s.value,'$.text')) AS text, \
               COALESCE(JSON_UNQUOTE(JSON_EXTRACT(s.value,'$.scope_text')),'') AS scope_text, \
               CONCAT(JSON_UNQUOTE(JSON_EXTRACT(s.value,'$.text')), \
                 IF(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(s.value,'$.scope_text')),'')='', '', \
                   CONCAT(CHAR(10 USING utf8mb4),JSON_UNQUOTE(JSON_EXTRACT(s.value,'$.scope_text'))))) AS rendered \
               FROM selected,JSON_TABLE(CAST(statements AS JSON),'$[*]' COLUMNS(i FOR ORDINALITY,value JSON PATH '$')) s), \
             located AS (SELECT units.*,IF(kind='document',0,COALESCE(SUM(CHAR_LENGTH(rendered)+2) OVER \
               (ORDER BY i ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0)) AS base FROM units) \
             SELECT JSON_OBJECT('entry_id',JSON_EXTRACT(e,'$.entry_id'),'path',JSON_EXTRACT(e,'$.path'), \
               'label',JSON_EXTRACT(e,'$.label'),'review_state',JSON_EXTRACT(e,'$.review_state'), \
               'effective_value',SUBSTRING(rendered,?+1,?), \
               'content_page',JSON_OBJECT('offset',?,'total_chars',IF(kind='document',CHAR_LENGTH(rendered), \
                 CHAR_LENGTH(JSON_UNQUOTE(JSON_EXTRACT(e,'$.effective_value'))))), \
               'source_facts',JSON_OBJECT('source_id',JSON_EXTRACT(e,'$.source_facts.source_id'),'version',JSON_EXTRACT(e,'$.source_facts.version')), \
               'suggestion',JSON_OBJECT(),'human_override',IF(JSON_TYPE(JSON_EXTRACT(e,'$.human_override'))='OBJECT',JSON_OBJECT('has_override',TRUE),NULL), \
               'effective_structure',JSON_EXTRACT(e,'$.effective_structure'), \
               'statement_content',JSON_OBJECT('statement_id',sid,'statement_offset',?,'entry_offset',IF(kind='document',NULL,base), \
                 'text',SUBSTRING(text,?+1,?), 'text_chars',CHAR_LENGTH(text), \
                 'scope_text',SUBSTRING(scope_text,GREATEST(0,?-CHAR_LENGTH(text)-1)+1,GREATEST(0,?-GREATEST(0,CHAR_LENGTH(text)+1-?))), \
                 'scope_chars',CHAR_LENGTH(scope_text),'citations',JSON_EXTRACT(value,'$.citations'), \
                 'supports_complete',JSON_EXTRACT(value,'$.supports_complete'), \
                 'supports',(SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('support_id',JSON_EXTRACT(p.item,'$.support_id'), \
                   'role',JSON_EXTRACT(p.item,'$.role'),'reference',JSON_EXTRACT(p.item,'$.reference'), \
                   'embedded_in',JSON_EXTRACT(p.item,'$.embedded_in'))),JSON_ARRAY()) \
                   FROM JSON_TABLE(CAST(JSON_EXTRACT(value,'$.supports') AS JSON),'$[*]' COLUMNS(item JSON PATH '$')) p)), \
               'statement_dependencies',(SELECT COALESCE(JSON_ARRAYAGG(JSON_EXTRACT(p.item,'$.reference.ref')),JSON_ARRAY()) \
                 FROM JSON_TABLE(CAST(JSON_EXTRACT(value,'$.supports') AS JSON),'$[*]' COLUMNS(item JSON PATH '$')) p \
                 WHERE JSON_UNQUOTE(JSON_EXTRACT(p.item,'$.reference.kind'))='knowledge')) \
             FROM located JOIN knowledge_statements st ON st.object_id=? AND st.version=? AND st.entry_path=? \
               AND st.layer=located.layer AND BINARY st.statement_id=BINARY located.sid \
             WHERE BINARY sid=BINARY ? AND base+?=? AND (kind='document' OR \
               BINARY SUBSTRING(JSON_UNQUOTE(JSON_EXTRACT(e,'$.effective_value')),base+1,CHAR_LENGTH(rendered))=BINARY rendered)")
            .bind(object).bind(version).bind(entry_id).bind(path)
            .bind(local as i64).bind(length as i64).bind(offset).bind(local as i64).bind(local as i64).bind(length as i64)
            .bind(local as i64).bind(length as i64).bind(local as i64)
            .bind(object).bind(version).bind(path).bind(statement_id).bind(local).bind(offset)
            .fetch_all(tx.connection()).await?
    } else {
        sqlx::query_scalar::<_,sqlx::types::Json<Value>>(
            "SELECT JSON_OBJECT('entry_id',JSON_EXTRACT(j.e,'$.entry_id'),            'path',JSON_EXTRACT(j.e,'$.path'),'label',JSON_EXTRACT(j.e,'$.label'),            'review_state',JSON_EXTRACT(j.e,'$.review_state'),            'effective_value',SUBSTRING(JSON_UNQUOTE(JSON_EXTRACT(j.e,'$.effective_value')),?+1,?),            'content_page',JSON_OBJECT('offset',?,'total_chars',CHAR_LENGTH(JSON_UNQUOTE(JSON_EXTRACT(j.e,'$.effective_value')))),            'source_facts',JSON_OBJECT('source_id',JSON_EXTRACT(j.e,'$.source_facts.source_id'),                'version',JSON_EXTRACT(j.e,'$.source_facts.version')),            'suggestion',JSON_OBJECT(),'human_override',IF(JSON_TYPE(JSON_EXTRACT(j.e,'$.human_override'))='OBJECT',JSON_OBJECT('has_override',TRUE),NULL),            'effective_structure',JSON_EXTRACT(j.e,'$.effective_structure'))         FROM knowledge_objects v,JSON_TABLE(v.body,'$.entries[*]' COLUMNS(e JSON PATH '$')) j         WHERE v.id=? AND v.version=? AND BINARY JSON_UNQUOTE(JSON_EXTRACT(j.e,'$.entry_id'))=BINARY ? AND BINARY JSON_UNQUOTE(JSON_EXTRACT(j.e,'$.path'))=BINARY ? AND JSON_TYPE(JSON_EXTRACT(j.e,'$.effective_value'))='STRING'")
            .bind(offset).bind(length).bind(offset).bind(object).bind(version).bind(entry_id).bind(path)
            .fetch_all(tx.connection()).await?
    };
    let Some(entry) = rows.first() else {
        return Ok(None);
    };
    let text = entry.0["effective_value"].as_str().unwrap_or("");
    if text.chars().count() as u64 != length
        || location["content_hash"]
            .as_str()
            .is_some_and(|hash| hash != fingerprint(&json!(text)))
    {
        return Ok(None);
    }
    // 与knowledge_sources::requirements同一清单，但只在库内计算身份，不装配正文。
    // 各正常臂要求source_id为JSON字符串（JSON null/缺失/非串按原as_str()语义跳过
    // 或标记）；三类证据数组的source_id非字符串时产出(NULL,NULL)标记行，调用方
    // 按invalid_evidence报错，不静默丢引用。
    let required_rows = sqlx::query(
        "SELECT DISTINCT sid,sv FROM (\
           SELECT JSON_UNQUOTE(JSON_EXTRACT(v.body,'$.source_id')) AS sid,\
                  JSON_UNQUOTE(JSON_EXTRACT(v.body,'$.source_version')) AS sv \
             FROM knowledge_objects v WHERE v.id=? AND v.version=? \
             AND JSON_TYPE(JSON_EXTRACT(v.body,'$.source_id'))='STRING' \
           UNION \
           SELECT JSON_UNQUOTE(JSON_EXTRACT(j.e,'$.source_facts.source_id')),\
                  JSON_UNQUOTE(JSON_EXTRACT(j.e,'$.source_facts.version')) \
             FROM knowledge_objects v,JSON_TABLE(v.body,'$.entries[*]' COLUMNS(e JSON PATH '$')) j \
             WHERE v.id=? AND v.version=? \
             AND JSON_TYPE(JSON_EXTRACT(j.e,'$.source_facts.source_id'))='STRING' \
           UNION \
           SELECT JSON_UNQUOTE(JSON_EXTRACT(x.ev,'$.source_id')),JSON_UNQUOTE(JSON_EXTRACT(x.ev,'$.version')) \
             FROM knowledge_objects v,JSON_TABLE(v.body,'$.entries[*]' COLUMNS(e JSON PATH '$')) j,\
                  JSON_TABLE(j.e,'$.suggestion.evidence[*]' COLUMNS(ev JSON PATH '$')) x \
             WHERE v.id=? AND v.version=? \
             AND JSON_TYPE(JSON_EXTRACT(x.ev,'$.source_id'))='STRING' \
           UNION \
           SELECT JSON_UNQUOTE(JSON_EXTRACT(x.mr,'$.source_id')),JSON_UNQUOTE(JSON_EXTRACT(x.mr,'$.version')) \
             FROM knowledge_objects v,JSON_TABLE(v.body,'$.entries[*]' COLUMNS(e JSON PATH '$')) j,\
                  JSON_TABLE(j.e,'$.suggestion.material_refs[*]' COLUMNS(mr JSON PATH '$')) x \
             WHERE v.id=? AND v.version=? \
             AND JSON_TYPE(JSON_EXTRACT(x.mr,'$.source_id'))='STRING' \
           UNION \
           SELECT JSON_UNQUOTE(JSON_EXTRACT(x.se,'$.source_id')),JSON_UNQUOTE(JSON_EXTRACT(x.se,'$.version')) \
             FROM knowledge_objects v,JSON_TABLE(v.body,'$.entries[*]' COLUMNS(e JSON PATH '$')) j,\
                  JSON_TABLE(j.e,'$.source_facts.structured_evidence[*]' COLUMNS(se JSON PATH '$')) x \
             WHERE v.id=? AND v.version=? \
             AND JSON_TYPE(JSON_EXTRACT(x.se,'$.source_id'))='STRING' \
           UNION \
           SELECT NULL,NULL \
             FROM knowledge_objects v,JSON_TABLE(v.body,'$.entries[*]' COLUMNS(e JSON PATH '$')) j,\
                  JSON_TABLE(j.e,'$.suggestion.evidence[*]' COLUMNS(ev JSON PATH '$')) x \
             WHERE v.id=? AND v.version=? \
             AND (JSON_EXTRACT(x.ev,'$.source_id') IS NULL OR JSON_TYPE(JSON_EXTRACT(x.ev,'$.source_id'))<>'STRING') \
           UNION \
           SELECT NULL,NULL \
             FROM knowledge_objects v,JSON_TABLE(v.body,'$.entries[*]' COLUMNS(e JSON PATH '$')) j,\
                  JSON_TABLE(j.e,'$.suggestion.material_refs[*]' COLUMNS(mr JSON PATH '$')) x \
             WHERE v.id=? AND v.version=? \
             AND (JSON_EXTRACT(x.mr,'$.source_id') IS NULL OR JSON_TYPE(JSON_EXTRACT(x.mr,'$.source_id'))<>'STRING') \
           UNION \
           SELECT NULL,NULL \
             FROM knowledge_objects v,JSON_TABLE(v.body,'$.entries[*]' COLUMNS(e JSON PATH '$')) j,\
                  JSON_TABLE(j.e,'$.source_facts.structured_evidence[*]' COLUMNS(se JSON PATH '$')) x \
             WHERE v.id=? AND v.version=? \
             AND (JSON_EXTRACT(x.se,'$.source_id') IS NULL OR JSON_TYPE(JSON_EXTRACT(x.se,'$.source_id'))<>'STRING') \
         ) refs",
    )
    .bind(object)
    .bind(version)
    .bind(object)
    .bind(version)
    .bind(object)
    .bind(version)
    .bind(object)
    .bind(version)
    .bind(object)
    .bind(version)
    .bind(object)
    .bind(version)
    .bind(object)
    .bind(version)
    .bind(object)
    .bind(version)
    .fetch_all(tx.connection())
    .await?;
    let mut required: Vec<(Option<String>, Option<String>)> = required_rows
        .iter()
        .map(|row| (row.get("sid"), row.get("sv")))
        .collect();
    let statement_sources = sqlx::query(
        "WITH effective AS (SELECT CASE WHEN JSON_UNQUOTE(JSON_EXTRACT(v.body,'$.kind'))='document' \
           THEN JSON_EXTRACT(j.e,'$.suggestion.statements') \
           WHEN JSON_TYPE(JSON_EXTRACT(j.e,'$.human_override'))='OBJECT' THEN JSON_EXTRACT(j.e,'$.human_override.statements') \
           WHEN JSON_TYPE(JSON_EXTRACT(j.e,'$.suggestion.value'))='STRING' THEN JSON_EXTRACT(j.e,'$.suggestion.statements') \
           ELSE JSON_EXTRACT(j.e,'$.source_facts.statements') END AS statements \
           FROM knowledge_objects v,JSON_TABLE(v.body,'$.entries[*]' COLUMNS(e JSON PATH '$')) j \
           WHERE v.id=? AND v.version=?), \
         statements AS (SELECT s.value FROM effective,JSON_TABLE(CAST(COALESCE(statements,JSON_ARRAY()) AS JSON),'$[*]' COLUMNS(value JSON PATH '$')) s), \
         sources AS (SELECT JSON_EXTRACT(c.value,'$.source') AS source,JSON_UNQUOTE(JSON_EXTRACT(c.value,'$.revision')) AS revision \
           FROM statements,JSON_TABLE(CAST(statements.value AS JSON),'$.citations[*]' COLUMNS(value JSON PATH '$')) c \
           UNION ALL SELECT JSON_EXTRACT(p.value,'$.reference.citation.source'),JSON_UNQUOTE(JSON_EXTRACT(p.value,'$.reference.citation.revision')) \
           FROM statements,JSON_TABLE(CAST(statements.value AS JSON),'$.supports[*]' COLUMNS(value JSON PATH '$')) p \
           WHERE JSON_UNQUOTE(JSON_EXTRACT(p.value,'$.reference.kind'))='source') \
         SELECT DISTINCT IF(JSON_UNQUOTE(JSON_EXTRACT(source,'$.kind'))='document', \
           CONCAT('document-',JSON_UNQUOTE(JSON_EXTRACT(source,'$.id'))),JSON_UNQUOTE(JSON_EXTRACT(source,'$.id'))) AS sid,revision AS sv FROM sources")
        .bind(object).bind(version).fetch_all(tx.connection()).await?;
    required.extend(
        statement_sources
            .iter()
            .map(|row| (row.get("sid"), row.get("sv"))),
    );
    required.sort();
    required.dedup();
    let statement_dependencies: Vec<Value> = rows
        .iter()
        .flat_map(|entry| {
            entry.0["statement_dependencies"]
                .as_array()
                .cloned()
                .unwrap_or_default()
        })
        .collect();
    Ok(Some(json!({
        "id":object,
        "kind":head.get::<String,_>("kind"),
        "name":head.get::<String,_>("name"),
        "version":version.to_string(),
        "state":"enabled",
        "related_ids":head.get::<Option<sqlx::types::Json<Value>>,_>("related_ids").map(|v|v.0).unwrap_or(json!([])),
        "source_id":head.get::<Option<String>,_>("source_id"),
        "source_version":head.get::<Option<String>,_>("source_version"),
        "updated_by":head.get::<String,_>("updated_by"),
        "entries":rows.iter().map(|value|value.0.clone()).collect::<Vec<_>>(),
        "entries_total":head.get::<i64,_>("entry_count"),
        "required_sources":required,
        "statement_dependencies":statement_dependencies,
    })))
}

// 已保存结构的读取只核对当前绑定，不重传条目正文或表的加工 SQL。
// 来源引用沿用完整的窄投影；结构按有效层选取，不能借用已被人工覆盖的底层。

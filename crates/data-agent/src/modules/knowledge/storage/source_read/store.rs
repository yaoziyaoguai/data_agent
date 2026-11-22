use super::*;

pub struct DocumentWindows {
    pub total_length: usize,
    pub complete: bool,
    pub texts: std::collections::HashMap<(usize, usize), String>,
}

// 这里只提供正式来源事实的定位材料；对象身份不授予有效知识或结构的采用权。
pub async fn source_fact_refs_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    reference: &crate::contracts::generated::SourceObjectSelection,
    scope: &crate::search_scope::KnowledgeSearchScope,
) -> Result<Vec<Value>> {
    let meta = read_meta_in_tx(tx, ctx, &reference.object_id, None).await?;
    if meta["version"] != reference.version {
        return Err(Error::new("stale_knowledge"));
    }
    if !scope.matches(&meta) {
        return Ok(vec![]);
    }
    let rows = sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
        "SELECT JSON_OBJECT('entry_id',JSON_EXTRACT(j.e,'$.entry_id'), \
           'source_id',JSON_EXTRACT(j.e,'$.source_facts.source_id'), \
           'revision',JSON_EXTRACT(j.e,'$.source_facts.version'), \
           'complete',JSON_EXTRACT(j.e,'$.source_facts.complete'), \
           'quote_chars',CHAR_LENGTH(JSON_UNQUOTE(JSON_EXTRACT(j.e,'$.source_facts.quote')))) \
         FROM knowledge_objects o,JSON_TABLE(o.body,'$.entries[*]' \
           COLUMNS(n FOR ORDINALITY,e JSON PATH '$')) j \
         WHERE o.id=? AND o.space_id=? AND o.version=? AND o.state='enabled' \
           AND JSON_TYPE(JSON_EXTRACT(j.e,'$.source_facts.source_id'))='STRING' \
           AND JSON_TYPE(JSON_EXTRACT(j.e,'$.source_facts.quote'))='STRING' ORDER BY j.n",
    )
    .bind(&reference.object_id)
    .bind(&ctx.space_id)
    .bind(epoch(&reference.version)?)
    .fetch_all(tx.connection())
    .await?;
    Ok(rows.into_iter().map(|row| row.0).collect())
}

pub async fn read_source_fact_quote_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    reference: &crate::contracts::generated::SourceObjectSelection,
    entry: &str,
) -> Result<String> {
    sqlx::query_scalar::<_, String>(
        "SELECT JSON_UNQUOTE(JSON_EXTRACT(j.e,'$.source_facts.quote')) \
         FROM knowledge_objects o,JSON_TABLE(o.body,'$.entries[*]' COLUMNS(e JSON PATH '$')) j \
         WHERE o.id=? AND o.space_id=? AND o.version=? AND o.state='enabled' \
           AND BINARY JSON_UNQUOTE(JSON_EXTRACT(j.e,'$.entry_id'))=BINARY ? \
           AND JSON_TYPE(JSON_EXTRACT(j.e,'$.source_facts.quote'))='STRING'",
    )
    .bind(&reference.object_id)
    .bind(&ctx.space_id)
    .bind(epoch(&reference.version)?)
    .bind(entry)
    .fetch_optional(tx.connection())
    .await?
    .ok_or(Error::new("not_available"))
}

// 在单个已核文档内确定唯一位置；全文仅在owner的SQL表达式内拼接，不下行正文。
pub async fn locate_document_quote_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
    version: u64,
    quote: &str,
) -> Result<Option<usize>> {
    let row = sqlx::query_scalar::<_, i64>(
        "WITH parts AS (SELECT j.n,JSON_UNQUOTE(j.v) AS text \
           FROM knowledge_objects o,JSON_TABLE(o.body,'$.entries[*]' \
             COLUMNS(n FOR ORDINALITY,v JSON PATH '$.effective_value')) j \
           WHERE o.id=? AND o.space_id=? AND o.version=? AND o.kind='document' \
             AND o.state='enabled' AND JSON_TYPE(j.v)='STRING'), \
         assembled AS (SELECT GROUP_CONCAT(text ORDER BY n SEPARATOR '\\n\\n') AS body, \
           SUM(OCTET_LENGTH(text))+2*GREATEST(COUNT(*)-1,0) AS expected_bytes FROM parts), \
         located AS (SELECT body,expected_bytes,LOCATE(CAST(? AS BINARY),CAST(body AS BINARY)) AS p FROM assembled) \
         SELECT /*+ SET_VAR(group_concat_max_len=16777216) */ \
           CHAR_LENGTH(CONVERT(LEFT(CAST(body AS BINARY),p-1) USING utf8mb4)) \
         FROM located WHERE p>0 AND OCTET_LENGTH(body)=expected_bytes \
           AND LOCATE(CAST(? AS BINARY),CAST(body AS BINARY),p+1)=0",
    )
    .bind(object)
    .bind(&ctx.space_id)
    .bind(version)
    .bind(quote)
    .bind(quote)
    .fetch_optional(tx.connection())
    .await?;
    Ok(row.map(|offset| offset as usize))
}

// 文档位置以原数组内字符串effective_value用两个换行拼接为准。空串占分隔符，
// 非字符串不占位置；库内计算各条目的跨度，只返回与请求窗口相交的子串。
pub async fn read_document_windows_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
    version: u64,
    windows: &[(usize, usize)],
) -> Result<DocumentWindows> {
    let rows = sqlx::query(
        "WITH entry_values AS (\
           SELECT j.entry_no,j.value_json FROM knowledge_objects AS k \
           LEFT JOIN JSON_TABLE(k.body,'$.entries[*]' COLUMNS(\
             entry_no FOR ORDINALITY,value_json JSON PATH '$.effective_value')) AS j ON TRUE \
           WHERE k.id=? AND k.space_id=? AND k.version=? AND k.kind='document' AND k.state='enabled'\
         ), strings AS (\
           SELECT entry_no,JSON_UNQUOTE(value_json) AS value_text \
           FROM entry_values WHERE JSON_TYPE(value_json)='STRING'\
         ), parts AS (\
           SELECT entry_no,CONCAT(IF(ROW_NUMBER() OVER (ORDER BY entry_no)=1,'',CHAR(10,10 USING utf8mb4)),value_text) AS part_text \
           FROM strings\
         ), positioned AS (\
           SELECT entry_no,part_text,CHAR_LENGTH(part_text) AS part_length,\
             COALESCE(SUM(CHAR_LENGTH(part_text)) OVER (ORDER BY entry_no ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS part_offset \
           FROM parts\
         ), summary AS (\
           SELECT CAST(COALESCE(SUM(part_length),0) AS UNSIGNED) AS total_length,\
             COALESCE(MAX(REGEXP_LIKE(part_text,'[^[:space:]]')),0) AS complete FROM positioned\
         ), requested AS (\
           SELECT * FROM JSON_TABLE(?, '$[*]' COLUMNS(\
             window_no FOR ORDINALITY,window_offset BIGINT UNSIGNED PATH '$[0]',window_length BIGINT UNSIGNED PATH '$[1]')) AS w\
         ), slices AS (\
           SELECT window_no,entry_no,SUBSTRING(part_text,\
             GREATEST(window_offset,part_offset)-part_offset+1,\
             LEAST(window_offset+window_length,part_offset+part_length)-GREATEST(window_offset,part_offset)) AS fragment \
           FROM requested JOIN positioned \
             ON window_offset<part_offset+part_length AND window_offset+window_length>part_offset\
         ) \
         SELECT summary.total_length,summary.complete,slices.window_no,slices.fragment \
         FROM summary LEFT JOIN slices ON TRUE WHERE EXISTS(SELECT 1 FROM entry_values) \
         ORDER BY slices.window_no,slices.entry_no",
    )
    .bind(object)
    .bind(&ctx.space_id)
    .bind(version)
    .bind(sqlx::types::Json(windows))
    .fetch_all(tx.connection())
    .await?;
    let head = rows.first().ok_or(Error::new("not_available"))?;
    let mut texts: Vec<String> = vec![String::new(); windows.len()];
    for row in &rows {
        if let Some(window) = row.get::<Option<i64>, _>("window_no") {
            texts[window as usize - 1].push_str(&row.get::<String, _>("fragment"));
        }
    }
    Ok(DocumentWindows {
        total_length: head.get::<u64, _>("total_length") as usize,
        complete: head.get::<i64, _>("complete") != 0,
        texts: windows.iter().copied().zip(texts).collect(),
    })
}

// 旧依赖映射的兼容核验只需要来源ID与修订。保留原requirements输入形状，
// 但不把正文、建议解释或引用quote带出数据库；无效引用仍交给原规则报错。
pub async fn source_reference_objects_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    ids: &[String],
) -> Result<Vec<Value>> {
    let mut objects = std::collections::BTreeMap::new();
    for chunk in ids.chunks(50) {
        let mut sql = sqlx::QueryBuilder::<sqlx::MySql>::new(
            "SELECT k.id,k.kind,k.version,\
             JSON_TYPE(JSON_EXTRACT(k.body,'$.entries')) AS entries_type,\
             JSON_TYPE(JSON_EXTRACT(k.body,CONCAT('$.entries[',j.entry_no-1,'].suggestion.evidence'))) AS evidence_type,\
             JSON_TYPE(JSON_EXTRACT(k.body,CONCAT('$.entries[',j.entry_no-1,'].suggestion.material_refs'))) AS material_type,\
             JSON_TYPE(JSON_EXTRACT(k.body,CONCAT('$.entries[',j.entry_no-1,'].source_facts.structured_evidence'))) AS structured_type,\
             j.root_id,j.root_revision,j.fact_id,j.fact_revision,\
             j.evidence_no,j.evidence_id,j.evidence_revision,\
             j.material_no,j.material_id,j.material_revision,\
             j.structured_no,j.structured_id,j.structured_revision \
             FROM knowledge_objects AS k JOIN JSON_TABLE(k.body,'$' COLUMNS(\
               root_id JSON PATH '$.source_id',root_revision JSON PATH '$.source_version',\
               NESTED PATH '$.entries[*]' COLUMNS(\
                 entry_no FOR ORDINALITY,\
                 fact_id JSON PATH '$.source_facts.source_id',fact_revision JSON PATH '$.source_facts.version',\
                 NESTED PATH '$.suggestion.evidence[*]' COLUMNS(\
                   evidence_no FOR ORDINALITY,evidence_id JSON PATH '$.source_id',evidence_revision JSON PATH '$.version'),\
                 NESTED PATH '$.suggestion.material_refs[*]' COLUMNS(\
                   material_no FOR ORDINALITY,material_id JSON PATH '$.source_id',material_revision JSON PATH '$.version'),\
                 NESTED PATH '$.source_facts.structured_evidence[*]' COLUMNS(\
                   structured_no FOR ORDINALITY,structured_id JSON PATH '$.source_id',structured_revision JSON PATH '$.version')\
               ))) AS j WHERE k.space_id=",
        );
        sql.push_bind(&ctx.space_id)
            .push(" AND k.state='enabled' AND k.id IN (");
        let mut keys = sql.separated(",");
        for id in chunk {
            keys.push_bind(id);
        }
        sql.push(")");
        for row in sql.build().fetch_all(tx.connection()).await? {
            let object = objects
                .entry(row.get::<String, _>("id"))
                .or_insert_with(|| {
                    json!({"id":row.get::<String,_>("id"),"kind":row.get::<String,_>("kind"),
                        "version":row.get::<u64,_>("version").to_string(),
                        "entries":[{"suggestion":{"evidence":[]}}]})
                });
            let entries_array =
                row.get::<Option<String>, _>("entries_type").as_deref() == Some("ARRAY");
            for (prefix, in_array) in [
                ("root", false),
                ("fact", false),
                ("evidence", true),
                ("material", true),
                ("structured", true),
            ] {
                if prefix != "root" && !entries_array {
                    continue;
                }
                let source = row
                    .get::<Option<sqlx::types::Json<Value>>, _>(format!("{prefix}_id").as_str())
                    .map(|value| value.0);
                let reference_present = if in_array {
                    row.get::<Option<String>, _>(format!("{prefix}_type").as_str())
                        .as_deref()
                        == Some("ARRAY")
                        && row
                            .get::<Option<i64>, _>(format!("{prefix}_no").as_str())
                            .is_some()
                } else {
                    source.as_ref().is_some_and(Value::is_string)
                };
                if !reference_present {
                    continue;
                }
                let revision = row
                    .get::<Option<sqlx::types::Json<Value>>, _>(
                        format!("{prefix}_revision").as_str(),
                    )
                    .map(|value| value.0);
                object["entries"][0]["suggestion"]["evidence"]
                    .as_array_mut()
                    .ok_or(crate::types::Error::new("unavailable"))?
                    .push(json!({"source_id":source,"version":revision}));
            }
        }
    }
    Ok(objects.into_values().collect())
}

pub async fn source_tables_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    source: &str,
) -> Result<Vec<String>> {
    Ok(sqlx::query_scalar("SELECT id FROM knowledge_objects WHERE space_id=? AND kind='table' AND source_id=? ORDER BY id").bind(&ctx.space_id).bind(source).fetch_all(tx.connection()).await?)
}

// 来源整理的目标对象清单：仅启用对象，条目只取身份与路径，不携带正文。
pub async fn source_objects_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    source: &str,
) -> Result<Vec<Value>> {
    // 文档对象自身不带source_id，按document-别名定位，供来源整理瞄准其条目。
    let rows = if let Some(document) = source.strip_prefix("document-") {
        sqlx::query("SELECT id,kind,version,name,body FROM knowledge_objects WHERE space_id=? AND id=? AND state='enabled'")
            .bind(&ctx.space_id)
            .bind(document)
            .fetch_all(tx.connection())
            .await?
    } else {
        sqlx::query("SELECT id,kind,version,name,body FROM knowledge_objects WHERE space_id=? AND source_id=? AND state='enabled'")
            .bind(&ctx.space_id)
            .bind(source)
            .fetch_all(tx.connection())
            .await?
    };
    let mut objects: Vec<Value> = rows
        .iter()
        .map(|row| {
            let body = row.get::<sqlx::types::Json<Value>, _>("body").0;
            json!({
                "id": row.get::<String,_>("id"),
                "kind": row.get::<String,_>("kind"),
                "version": row.get::<u64,_>("version").to_string(),
                "name": row.get::<String,_>("name"),
                "entries": body["entries"].as_array().into_iter().flatten().map(|entry|
                    json!({"entry_id":entry["entry_id"],"path":entry["path"],"label":entry["label"]})).collect::<Vec<_>>(),
            })
        })
        .collect();
    // 先投影条目元数据再排序，避免MySQL filesort携带宽正文而耗尽sort_buffer。
    objects.sort_by(|a, b| {
        a["kind"]
            .as_str()
            .cmp(&b["kind"].as_str())
            .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
    });
    Ok(objects)
}

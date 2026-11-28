use super::*;

pub async fn directory_page_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    after: Option<&str>,
    name: Option<&str>,
    state: Option<&str>,
    maintained_ids: Option<&[String]>,
    grouped: bool,
) -> Result<(Vec<Value>, Option<String>)> {
    let ids = maintained_ids.map(|ids| json!(ids).to_string());
    let mut sql = sqlx::QueryBuilder::<sqlx::MySql>::new(
        "SELECT k.body FROM knowledge_objects k FORCE INDEX(PRIMARY) WHERE k.space_id=",
    );
    sql.push_bind(&ctx.space_id).push(" AND k.state<>'deleted'");
    if let Some(state) = state {
        sql.push(" AND k.state=").push_bind(state);
    }
    if let Some(after) = after {
        sql.push(" AND k.id>").push_bind(after);
    }
    if let Some(name) = name {
        sql.push(" AND INSTR(LOWER(k.name),LOWER(")
            .push_bind(name)
            .push("))>0");
    }
    if let Some(ids) = ids {
        sql.push(" AND JSON_CONTAINS(CAST(")
            .push_bind(ids)
            .push(" AS JSON),JSON_QUOTE(k.id))");
    }
    if grouped {
        sql.push(" AND k.kind NOT IN ('field','relationship')");
    }
    push_table_access(&mut sql, ctx);
    let rows = sql
        .push(" ORDER BY k.id LIMIT 101")
        .build()
        .fetch_all(tx.connection())
        .await?;
    let next = if rows.len() > 100 {
        rows.get(99)
            .and_then(|r| body(r)["id"].as_str().map(str::to_owned))
    } else {
        None
    };
    Ok((rows.iter().take(100).map(body).collect(), next))
}

pub async fn page_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    after: Option<&str>,
    related: Option<&str>,
) -> Result<(Vec<Value>, Option<String>)> {
    let mut sql = sqlx::QueryBuilder::<sqlx::MySql>::new(
        "SELECT k.body FROM knowledge_objects k FORCE INDEX(PRIMARY) WHERE k.space_id=",
    );
    sql.push_bind(&ctx.space_id).push(" AND k.state<>'deleted'");
    if let Some(after) = after {
        sql.push(" AND k.id>").push_bind(after);
    }
    if let Some(related) = related {
        sql.push(" AND JSON_CONTAINS(JSON_EXTRACT(k.body,'$.related_ids'),JSON_QUOTE(")
            .push_bind(related)
            .push("))");
    }
    push_table_access(&mut sql, ctx);
    let rows = sql
        .push(" ORDER BY k.id LIMIT 101")
        .build()
        .fetch_all(tx.connection())
        .await?;
    let next = if rows.len() > 100 {
        rows.get(99)
            .map(|r| body(r)["id"].as_str().unwrap_or("").to_owned())
    } else {
        None
    };
    Ok((rows.iter().take(100).map(body).collect(), next))
}
// 索引积压时从当前正式正文查候选，精确名称优先且每次回源有界。
pub async fn matching_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    query: &str,
    terms: &[String],
) -> Result<Vec<Value>> {
    matching_scoped_in_tx(
        tx,
        ctx,
        query,
        terms,
        &crate::search_scope::KnowledgeSearchScope::default(),
        None,
        1000,
    )
    .await
}

// allowed是来源门换算的可交付对象id集（05切片3）：Some空集即范围内无可召回记录，
// 直接零候选；None表示无门。quota是请求前从共享候选预算分配的上限，SQL按它
// 截断（05接续：不先接收超额响应再裁）。
pub async fn matching_scoped_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    query: &str,
    terms: &[String],
    scope: &crate::search_scope::KnowledgeSearchScope,
    allowed: Option<&[String]>,
    quota: usize,
) -> Result<Vec<Value>> {
    if terms.is_empty() {
        return Ok(vec![]);
    }
    if let Some(ids) = allowed
        && ids.is_empty()
    {
        return Ok(vec![]);
    }
    // 05接续：当前对象SQL候选先相关性（名称含整句、名称词命中、正文词命中）后
    // 稳定ID排序，最后按额度截断——禁止按ID先截断把末尾多词强项丢掉。评分含义
    // 与索引投影通道统一：词命中=查询词项在可检索文本（含JSON里的名称）出现，
    // 名称词命中单独一维（名称是比正文更强的相关信号），返回匹配信息与分数供
    // 组合层按记录身份合并成同一条后备词法路。
    let lowered = query.to_lowercase();
    let mut sql = sqlx::QueryBuilder::<sqlx::MySql>::new("SELECT k.id,CAST((INSTR(LOWER(k.name),");
    sql.push_bind(lowered.clone())
        .push(")>0) AS SIGNED) AS name_hit,CAST(SUM(");
    // 每个比较括号包裹：MySQL的+优先级高于>，裸写A>0+B>0会解析成链式比较。
    let mut name_scoring = sql.separated(" + ");
    for token in terms.iter().take(24) {
        name_scoring
            .push("(INSTR(LOWER(k.name),")
            .push_bind_unseparated(token)
            .push_unseparated(")>0)");
    }
    sql.push(") AS SIGNED) AS name_term_hits,CAST(SUM(");
    let mut scoring = sql.separated(" + ");
    for token in terms.iter().take(24) {
        scoring
            .push("(INSTR(LOWER(CAST(k.body AS CHAR)),")
            .push_bind_unseparated(token)
            .push_unseparated(")>0)");
    }
    sql.push(") AS SIGNED) AS term_hits FROM knowledge_objects AS k FORCE INDEX(PRIMARY) WHERE k.space_id=")
        .push_bind(&ctx.space_id)
        .push(" AND k.state='enabled' AND (INSTR(LOWER(k.name),")
        .push_bind(lowered)
        // separated首推不加分隔符，名称命中后显式接OR再进词项列表。
        .push(")>0 OR ");
    let mut parts = sql.separated(" OR ");
    // 组合层传入与索引通道相同的去重分布词项；此处仅保持SQL绑定数量上限。
    for token in terms.iter().take(24) {
        parts
            .push("INSTR(LOWER(CAST(k.body AS CHAR)),")
            .push_bind_unseparated(token)
            .push_unseparated(")>0");
    }
    sql.push(")");
    if let Some(ids) = allowed {
        sql.push(" AND k.id IN (");
        // 多id集必须以逗号分隔绑定；首个绑定前不加分隔符。
        let mut keys = sql.separated(",");
        for id in ids {
            keys.push_bind(id.clone());
        }
        sql.push(")");
    }
    scope.push_constraints(&mut sql, "k.id", "k.kind", "k.body");
    sql.push(
        " GROUP BY k.id ORDER BY name_hit DESC,name_term_hits DESC,term_hits DESC,k.id LIMIT ",
    );
    sql.push_bind(quota as i64);
    let rows: Vec<(String, i64, i64, i64)> = sql
        .build_query_as::<(String, i64, i64, i64)>()
        .fetch_all(tx.connection())
        .await?;
    Ok(rows
        .into_iter()
        .map(|(id, name_hit, name_term_hits, term_hits)| {
            json!({"id":id,"name_hit":name_hit!=0,"name_term_hits":name_term_hits,"term_hits":term_hits})
        })
        .collect())
}

// 在 owner 内展开与 KNOWLEDGE_PROJECTION 相同的窗口；query 只参与评分。
// consumed 是本来源排序结果中已消费的原始行数，不能用跨来源去重后的数量推进。
// entry_rows保持物化，避免MySQL合并多次引用时使业务域相关JSON_TABLE条件丢行。
#[allow(clippy::too_many_arguments)]
pub async fn matching_content_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
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
         entry_rows AS (SELECT k.id,k.version,k.name,k.kind, \
         JSON_EXTRACT(j.e,'$.entry_id') AS entry_id, \
         JSON_EXTRACT(j.e,'$.path') AS path, \
         CASE WHEN k.kind='document' THEN JSON_EXTRACT(j.e,'$.suggestion.statements') \
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
         FROM knowledge_objects AS k FORCE INDEX(PRIMARY), \
         JSON_TABLE(k.body,'$.entries[*]' COLUMNS(e JSON PATH '$')) AS j \
         WHERE k.space_id=",
    )
    .push_bind(&ctx.space_id)
    .push(" AND k.state='enabled'");
    if let Some(ids) = allowed {
        sql.push(" AND k.id IN (");
        let mut keys = sql.separated(",");
        for id in ids {
            keys.push_bind(id);
        }
        sql.push(")");
    }
    scope.push_constraints(&mut sql, "k.id", "k.kind", "k.body");
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
            let entry = json!({
                "entry_id":row.try_get::<Option<sqlx::types::Json<Value>>, _>("entry_id")?.map(|value|value.0),
                "path":row.try_get::<Option<sqlx::types::Json<Value>>, _>("path")?.map(|value|value.0),
                "statement_id":row.try_get::<Option<sqlx::types::Json<Value>>, _>("statement_id")?.map(|value|value.0),
            });
            let offset = row.try_get::<u64, _>("char_offset")? as usize;
            let record = crate::types::knowledge_record_id(
                &ctx.space_id,
                &json!({"id":id,"version":version}),
                &entry,
                offset,
            );
            let name_hit = row.try_get::<i64, _>("name_hit")? > 0;
            let name_term_hits: i64 = row.try_get("name_term_hits")?;
            let term_hits: i64 = row.try_get("term_hits")?;
            // 完整问句计分不随24候选词截断；进位基数保持三维相关性的字典序。
            let score = i64::from(name_hit) * score_base * score_base
                + name_term_hits * score_base + term_hits;
            Ok(json!({
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

// 空间内全部当前有效对象的(id,version)清单：来源门换算允许记录集用，只取元信息
// 不装配正文；贡献根闭包按当前代判定（05切片3）。
pub async fn current_enabled_heads_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
) -> Result<Vec<(String, u64)>> {
    let rows = sqlx::query(
        "SELECT id,version FROM knowledge_objects WHERE space_id=? AND state='enabled' ORDER BY id",
    )
    .bind(&ctx.space_id)
    .fetch_all(tx.connection())
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| (row.get("id"), row.get("version")))
        .collect())
}

// 原文索引仅补登独立非空文档；来源派生章节由平台来源保留正文，不能重复当独立文档。
pub async fn independent_document_heads_in_tx(
    tx: &mut AppTx<'_>,
    space: &str,
) -> Result<Vec<(String, u64)>> {
    Ok(sqlx::query_as::<_, (String, u64)>(
        "SELECT DISTINCT k.id,k.version FROM knowledge_objects k, \
         JSON_TABLE(k.body,'$.entries[*]' COLUMNS(e JSON PATH '$')) j WHERE k.space_id=? \
         AND k.kind='document' AND k.state='enabled' AND k.source_id IS NULL \
         AND JSON_UNQUOTE(JSON_EXTRACT(j.e,'$.entry_id'))='body' \
         AND JSON_TYPE(JSON_EXTRACT(j.e,'$.effective_value'))='STRING' \
         AND CHAR_LENGTH(TRIM(JSON_UNQUOTE(JSON_EXTRACT(j.e,'$.effective_value'))))>0 ORDER BY k.id",
    )
    .bind(space)
    .fetch_all(tx.connection())
    .await?)
}

// 旧作业接续只核指定候选，不为每轮生产轮询扫描空间内全部文档。
pub async fn independent_document_candidate_in_tx(
    tx: &mut AppTx<'_>,
    space: &str,
    document: &str,
    revision: u64,
) -> Result<bool> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM knowledge_objects k, \
         JSON_TABLE(k.body,'$.entries[*]' COLUMNS(e JSON PATH '$')) j \
         WHERE k.id=? AND k.space_id=? AND k.version=? AND k.kind='document' \
         AND k.state='enabled' AND k.source_id IS NULL \
         AND JSON_UNQUOTE(JSON_EXTRACT(j.e,'$.entry_id'))='body' \
         AND JSON_TYPE(JSON_EXTRACT(j.e,'$.effective_value'))='STRING' \
         AND CHAR_LENGTH(TRIM(JSON_UNQUOTE(JSON_EXTRACT(j.e,'$.effective_value'))))>0)",
    )
    .bind(document)
    .bind(space)
    .bind(revision)
    .fetch_one(tx.connection())
    .await?)
}

// 在同一查询中返回可检索的对象及其原文身份，不加载正文。
#[derive(sqlx::FromRow)]
pub struct SearchHead {
    pub id: String,
    pub version: u64,
    pub kind: String,
    pub source_id: Option<String>,
    pub table_id: Option<String>,
}
pub async fn scoped_enabled_heads_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    scope: &crate::search_scope::KnowledgeSearchScope,
) -> Result<Vec<SearchHead>> {
    let mut sql =
        sqlx::QueryBuilder::<sqlx::MySql>::new("SELECT k.id,k.version,k.kind,k.source_id,");
    sql.push(DIRECT_TABLE_ID)
        .push(" FROM knowledge_objects k WHERE k.space_id=");
    sql.push_bind(&ctx.space_id).push(" AND k.state='enabled'");
    scope.push_constraints(&mut sql, "k.id", "k.kind", "k.body");
    push_table_access(&mut sql, ctx);
    sql.push(" ORDER BY k.id");
    Ok(sql.build_query_as().fetch_all(tx.connection()).await?)
}

pub async fn enabled_tables_by_name_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    names: &[String],
) -> Result<Vec<(String, SearchHead)>> {
    if names.is_empty() {
        return Ok(Vec::new());
    }
    let mut tables = Vec::new();
    for chunk in names.chunks(100) {
        let mut sql = sqlx::QueryBuilder::<sqlx::MySql>::new(
            "SELECT LOWER(k.name) AS sql_name,k.id,k.version,k.kind,k.source_id,",
        );
        sql.push(DIRECT_TABLE_ID)
            .push(" FROM knowledge_objects k WHERE k.space_id=");
        sql.push_bind(&ctx.space_id)
            .push(" AND k.state='enabled' AND k.kind='table' AND LOWER(k.name) IN (");
        let mut items = sql.separated(",");
        for name in chunk {
            items.push_bind(name.to_ascii_lowercase());
        }
        sql.push(")");
        push_table_access(&mut sql, ctx);
        sql.push(" ORDER BY k.id");
        for row in sql.build().fetch_all(tx.connection()).await? {
            tables.push((
                row.get::<String, _>("sql_name"),
                SearchHead {
                    id: row.get("id"),
                    version: row.get("version"),
                    kind: row.get("kind"),
                    source_id: row.get("source_id"),
                    table_id: row.get("table_id"),
                },
            ));
        }
    }
    Ok(tables)
}

// 身份目录只按可读名称/标识选当前头；不检索正文，也不把hints当权限或硬过滤。
// 返回顺序与id keyset一致，调用方额外取一项判断续页并按实际交付位置推进。
pub async fn identity_candidate_ids_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    terms: &[&str],
    kinds: &[&str],
    after: Option<&str>,
    limit: usize,
) -> Result<Vec<String>> {
    let mut sql = sqlx::QueryBuilder::<sqlx::MySql>::new(
        "SELECT k.id FROM knowledge_objects k WHERE k.space_id=",
    );
    sql.push_bind(&ctx.space_id).push(" AND state='enabled'");
    if let Some(after) = after {
        sql.push(" AND id>").push_bind(after);
    }
    if !kinds.is_empty() {
        sql.push(" AND kind IN (");
        let mut values = sql.separated(",");
        for kind in kinds {
            values.push_bind(*kind);
        }
        sql.push(")");
    }
    if terms != ["*"] {
        sql.push(" AND (");
        for (index, term) in terms.iter().enumerate() {
            if index > 0 {
                sql.push(" OR ");
            }
            sql.push("(INSTR(LOWER(name),LOWER(")
                .push_bind(*term)
                .push("))>0 OR INSTR(LOWER(id),LOWER(")
                .push_bind(*term)
                .push("))>0 OR INSTR(LOWER(source_id),LOWER(")
                .push_bind(*term)
                .push("))>0 OR (kind='document' AND CONCAT('document-',id)=")
                .push_bind(*term)
                .push("))");
        }
        sql.push(")");
    }
    push_table_access(&mut sql, ctx);
    sql.push(" ORDER BY k.id LIMIT ")
        .push_bind(limit.min(31) as u32);
    Ok(sql.build_query_scalar().fetch_all(tx.connection()).await?)
}

// 候选按≤50分批只下行元信息与软排序匹配数；域/关联复用已发布范围规则，
// 在owner内计算布尔匹配，不为排序装配候选正文，也不把提示写进WHERE过滤候选。
pub(crate) fn push_workspace_dependency_heads(
    sql: &mut sqlx::QueryBuilder<sqlx::MySql>,
    ctx: &AccessContext,
    checkpoint_objects: &std::collections::HashSet<&str>,
    workspace: bool,
) {
    sql.push("workspace_dependency_ids AS (");
    if workspace {
        sql.push("SELECT /*+ NO_MERGE(w) */ ref.object_id FROM workspace_assets w,
        JSON_TABLE(CAST(w.body AS JSON),'$.dependencies[*]' COLUMNS(object_id VARCHAR(64) PATH '$.object_id')) ref UNION DISTINCT ");
    }
    sql.push("SELECT ref.object_id FROM checkpoint_asset_heads a,
        JSON_TABLE(CAST(a.dependencies AS JSON),'$[*]' COLUMNS(object_id VARCHAR(64) PATH '$.object_id')) ref
        UNION DISTINCT SELECT object_id FROM JSON_TABLE(CAST(")
        .push_bind(sqlx::types::Json(checkpoint_objects))
        .push(" AS JSON),'$[*]' COLUMNS(object_id VARCHAR(64) PATH '$')) checkpoint_ids
    ), workspace_dependency_heads AS (
        SELECT k.id,k.version,k.kind,k.source_id,").push(DIRECT_TABLE_ID)
        .push(" FROM workspace_dependency_ids d JOIN knowledge_objects k ON k.id=d.object_id WHERE k.space_id=")
        .push_bind(&ctx.space_id).push(" AND k.state='enabled'");
    push_table_access(sql, ctx);
    sql.push(")");
}

pub async fn candidate_meta_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    ids: &[String],
    hints: Option<&crate::contracts::generated::Hints>,
) -> Result<Vec<Value>> {
    let mut values = Vec::new();
    for chunk in ids.chunks(50) {
        let mut query = sqlx::QueryBuilder::<sqlx::MySql>::new(
            "SELECT k.id,k.name,k.version,k.state,k.kind,k.source_id,k.source_version,",
        );
        query.push(DIRECT_TABLE_ID).push(",(0");
        if let Some(hints) = hints {
            if let Some(domain) = &hints.business_domain {
                query.push("+EXISTS(SELECT 1 WHERE TRUE");
                crate::search_scope::KnowledgeSearchScope {
                    domain: Some(domain.clone()),
                    ..Default::default()
                }
                .push_constraints(&mut query, "k.id", "k.kind", "k.body");
                query.push(")");
            }
            if let Some(anchors) = hints
                .related_object_ids
                .as_ref()
                .filter(|ids| !ids.is_empty())
            {
                query.push("+(");
                for (index, anchor) in anchors.iter().enumerate() {
                    if index > 0 {
                        query.push(" OR ");
                    }
                    query.push("EXISTS(SELECT 1 WHERE TRUE");
                    crate::search_scope::KnowledgeSearchScope {
                        anchor: Some(anchor.clone()),
                        ..Default::default()
                    }
                    .push_constraints(&mut query, "k.id", "k.kind", "k.body");
                    query.push(")");
                }
                query.push(")");
            }
        }
        query.push(") AS hint_match FROM knowledge_objects k WHERE k.space_id=");
        query.push_bind(&ctx.space_id).push(" AND k.id IN (");
        let mut keys = query.separated(",");
        for id in chunk {
            keys.push_bind(id);
        }
        query.push(")");
        push_table_access(&mut query, ctx);
        for row in query.build().fetch_all(tx.connection()).await? {
            let source_id: Option<String> = row.get("source_id");
            values.push(json!({
                "id":row.get::<String,_>("id"),
                "name":row.get::<String,_>("name"),
                "version":row.get::<u64,_>("version").to_string(),
                "state":row.get::<String,_>("state"),
                "kind":row.get::<String,_>("kind"),
                "source_id":source_id,
                "table_id":row.get::<Option<String>,_>("table_id"),
                "source_version":row.get::<u64,_>("source_version"),
                "hint_match":row.get::<i64,_>("hint_match"),
            }));
        }
    }
    Ok(values)
}

// 只读已选 location 的单个 entry 窗口，entry_id/path、长度和可用 hash 必须吻合。
// 当前版本、启停和范围在头查询中核验；未命中或窗口失效返回 None。
// legacy 全对象必要来源仍在库内计算，不因裁小正文收窄，保持原 requirements 语义。

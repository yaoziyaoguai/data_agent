use crate::{
    persistence::AppTx,
    types::{AccessContext, Error, Result, epoch, fingerprint, id},
};
use serde_json::{Value, json};
use sqlx::Row;
fn body(row: &sqlx::mysql::MySqlRow) -> Value {
    let mut value = row.get::<sqlx::types::Json<Value>, _>("body").0;
    super::structure::project_object(&mut value);
    super::preparation::project_object(&mut value);
    value
}
pub(super) async fn begin_operation(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    key: &str,
    value: &Value,
) -> Result<Option<Value>> {
    // 预占与正式写同事务；失败回滚，不留下空回执或重复版本。
    sqlx::query("INSERT INTO knowledge_operations(owner_id,operation_id,fingerprint,receipt) VALUES(?,?,?,CAST('null' AS JSON)) ON DUPLICATE KEY UPDATE operation_id=VALUES(operation_id)")
        .bind(&ctx.user_id).bind(key).bind(fingerprint(value)).execute(tx.connection()).await?;
    let row = sqlx::query("SELECT fingerprint,receipt FROM knowledge_operations WHERE owner_id=? AND operation_id=? FOR UPDATE")
        .bind(&ctx.user_id).bind(key).fetch_one(tx.connection()).await?;
    let receipt = row.get::<sqlx::types::Json<Value>, _>("receipt").0;
    let stored = row.get::<String, _>("fingerprint");
    let legacy_reanalysis = value["action"] == "reanalyze"
        && !receipt.is_null()
        && stored
            == fingerprint(
                &json!({"object_id":value["object_id"],"input":value["input"],"source_version":receipt["source_version"]}),
            );
    if stored != fingerprint(value) && !legacy_reanalysis {
        return Err(Error::new("idempotency_conflict"));
    }
    if !receipt.is_null() {
        return Ok(Some(receipt));
    }
    Ok(None)
}
pub(super) async fn record(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    key: &str,
    input: &Value,
    value: &Value,
) -> Result<()> {
    sqlx::query("UPDATE knowledge_operations SET receipt=? WHERE owner_id=? AND operation_id=? AND fingerprint=?").bind(sqlx::types::Json(value)).bind(&ctx.user_id).bind(key).bind(fingerprint(input)).execute(tx.connection()).await?;
    Ok(())
}

pub async fn document_parts_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
) -> Result<Vec<Value>> {
    let selected = read_in_tx(tx, ctx, object, None, true).await?;
    if selected["kind"] != "document" {
        return Err(Error::new("invalid_input"));
    }
    let Some(source) = selected["source_id"].as_str() else {
        return Ok(vec![selected]);
    };
    let rows = sqlx::query("SELECT id FROM knowledge_objects WHERE space_id=? AND source_id=? AND kind='document' AND state<>'deleted' ORDER BY id LIMIT 201")
        .bind(&ctx.space_id).bind(source).fetch_all(tx.connection()).await?;
    if rows.len() > 200 {
        return Err(Error::new("payload_limit"));
    }
    let mut parts = Vec::new();
    for row in rows {
        parts.push(read_in_tx(tx, ctx, &row.get::<String, _>("id"), None, true).await?);
    }
    Ok(parts)
}

pub async fn save_document_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
    input: &Value,
    order: &[String],
) -> Result<Vec<Value>> {
    let key = input["operation_id"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?;
    let command = json!({"action":"edit-document","object_id":object,"input":input});
    if let Some(receipt) = begin_operation(tx, ctx, key, &command).await? {
        return serde_json::from_value(receipt).map_err(|_| Error::new("invalid_input"));
    }
    let text = input["body"].as_str().ok_or(Error::new("invalid_input"))?;
    let chunks = document_chunks(text, order.len());
    let mut versions = input["parts"]
        .as_array()
        .ok_or(Error::new("invalid_input"))?
        .clone();
    versions.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    let mut saved = Vec::new();
    // 按稳定身份锁定、校验全体版本。正文与排序同事务保存，空片段也保留人工值。
    for part in versions {
        let id = part["id"].as_str().ok_or(Error::new("invalid_input"))?;
        let position = order
            .iter()
            .position(|value| value == id)
            .ok_or(Error::new("version_conflict"))?;
        let mut value =
            locked(tx, ctx, id, part["expected_version"].as_str().unwrap_or("")).await?;
        let old = value.clone();
        let entry = value["entries"]
            .as_array_mut()
            .and_then(|entries| entries.iter_mut().find(|e| e["entry_id"] == "body"))
            .ok_or(Error::new("invalid_input"))?;
        let metadata_changed = order.len() == 1
            && (input
                .get("source_url")
                .is_some_and(|url| *url != entry["human_override"]["source_url"])
                || input
                    .get("related_ids")
                    .is_some_and(|ids| *ids != old["related_ids"]));
        if entry["effective_value"] == chunks[position]
            && old["document_order"] == position
            && !metadata_changed
        {
            saved.push(value);
            continue;
        }
        let url = if order.len() == 1 {
            input
                .get("source_url")
                .cloned()
                .unwrap_or_else(|| entry["human_override"]["source_url"].clone())
        } else {
            entry["human_override"]["source_url"].clone()
        };
        let related_override = if order.len() == 1 {
            input.get("related_ids").cloned()
        } else {
            None
        }
        .or_else(|| entry["human_override"].get("related_ids").cloned());
        entry["human_override"] = json!({"value":chunks[position],"edited_by":ctx.user_id,"operation_id":key,"source_url":url});
        if let Some(related) = related_override {
            entry["human_override"]["related_ids"] = related;
        }
        entry["effective_value"] = json!(chunks[position]);
        entry["review_state"] = json!("confirmed");
        if !chunks[position].trim().is_empty()
            && entry["source_facts"]["gap"] == "只有链接，正文尚未录入，不能据此解释业务"
        {
            entry["source_facts"]["gap"] = json!("人工录入，尚无平台来源");
        }
        value["document_order"] = json!(position);
        if order.len() == 1 && input.get("related_ids").is_some() {
            validate_document_metadata(tx, ctx, input).await?;
            value["related_ids"] = input["related_ids"].clone();
        } else if input.get("source_url").is_some() {
            validate_document_metadata(tx, ctx, input).await?;
        }
        next(&mut value, ctx);
        persist(tx, ctx, &value, &["*"]).await?;
        saved.push(value);
    }
    record(tx, ctx, key, &command, &json!(saved)).await?;
    Ok(saved)
}

// 只为兼容已存在的文档引用分配片段：完整 Markdown 无损往返，不增加对象或暴露分块。
fn document_chunks(text: &str, count: usize) -> Vec<&str> {
    let mut boundaries = vec![0];
    // 首节连同序言保存；超过现有片段数的章节继续留在末段。
    for (offset, _) in text
        .match_indices("\n## ")
        .skip(1)
        .take(count.saturating_sub(1))
    {
        boundaries.push(offset + 1);
    }
    boundaries.push(text.len());
    let mut chunks = boundaries
        .windows(2)
        .map(|pair| &text[pair[0]..pair[1]])
        .collect::<Vec<_>>();
    chunks.resize(count, "");
    chunks
}

pub(super) async fn persist(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    v: &Value,
    changed_paths: &[&str],
) -> Result<()> {
    let retain_archive = crate::types::retain_public_content_archives()?;
    let mut v = v.clone();
    super::structure::project_object(&mut v);
    super::preparation::project_object(&mut v);
    super::structure::validate_single_structure(&v)?;
    for entry in v["entries"].as_array().into_iter().flatten() {
        super::structure::validate_shape(&v, entry, &entry["effective_structure"])?;
    }
    if v.get("created_by").is_none() {
        v["created_by"] = v["updated_by"].clone();
    }
    let version = epoch(v["version"].as_str().ok_or(Error::new("invalid_input"))?)?;
    let previous = sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
        "SELECT body FROM knowledge_objects WHERE id=? AND space_id=?",
    )
    .bind(v["id"].as_str())
    .bind(&ctx.space_id)
    .fetch_optional(tx.connection())
    .await?
    .map(|value| value.0);
    let value_fingerprint = fingerprint(&v);
    let index_input_changed = previous
        .as_ref()
        .is_none_or(|old| fingerprint(old) != value_fingerprint);
    sqlx::query("INSERT INTO knowledge_objects(id,space_id,kind,name,version,state,body,source_id,source_version,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name),version=VALUES(version),state=VALUES(state),body=VALUES(body),source_version=VALUES(source_version),updated_by=VALUES(updated_by)")
 .bind(v["id"].as_str()).bind(&ctx.space_id).bind(v["kind"].as_str()).bind(v["name"].as_str()).bind(version).bind(v["state"].as_str()).bind(sqlx::types::Json(&v)).bind(v["source_id"].as_str()).bind(epoch(v["source_version"].as_str().unwrap_or("0"))?).bind(&ctx.user_id).execute(tx.connection()).await?;
    if index_input_changed {
        // 同版本重新整理沿原待办身份推进新内容：保留首次冻结的embedding_profile
        // 与付费账本，已发出且结果未知的调用不因重整重发，租约代次只增不减。
        sqlx::query(
            "INSERT INTO knowledge_index_jobs(target_kind,object_id,version) VALUES('knowledge_entry',?,?) \
             ON DUPLICATE KEY UPDATE \
             vector_attempts=IF(vector_state IN ('sending','unknown'),vector_attempts,0), \
             vector_error=IF(vector_state IN ('sending','unknown'),vector_error,NULL), \
             vector_receipt=IF(vector_state IN ('sending','unknown'),vector_receipt,NULL), \
             lease_until=IF(vector_state IN ('sending','unknown'),lease_until,NULL), \
             lease_epoch=lease_epoch+1,state='pending', \
             vector_state=IF(vector_state IN ('sending','unknown'),vector_state,'pending')",
        )
        .bind(v["id"].as_str())
        .bind(version)
        .execute(tx.connection())
        .await?;
    } else {
        // 内容未变的重存不重排、不清次数；只在待办缺失时补登记。
        sqlx::query(
            "INSERT INTO knowledge_index_jobs(target_kind,object_id,version) VALUES('knowledge_entry',?,?) \
             ON DUPLICATE KEY UPDATE object_id=VALUES(object_id)",
        )
        .bind(v["id"].as_str())
        .bind(version)
        .execute(tx.connection())
        .await?;
    }
    super::preparation::persist_in_tx(tx, ctx, &v).await?;
    super::dependency_index::persist_in_tx(tx, ctx, &v).await?;
    // 保存只落本模块数据；目标指纹补记与来源扇出排队（跨模块读取与作业写入）
    // 由use_cases组合层在保存后执行，见after_content_saved_in_tx。
    sqlx::query("INSERT INTO knowledge_revisions(object_id,version,updated_by,fingerprint,changed_paths) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE updated_by=VALUES(updated_by),fingerprint=VALUES(fingerprint),changed_paths=VALUES(changed_paths)")
        .bind(v["id"].as_str())
        .bind(version)
        .bind(&ctx.user_id)
        .bind(&value_fingerprint)
        .bind(sqlx::types::Json(changed_paths))
        .execute(tx.connection())
        .await?;
    if retain_archive {
        // 首次保存登记完整归档；已存在的同版归档原样保留，同修订整理只更新
        // current/派生视图，不覆盖精确历史。
        sqlx::query("INSERT INTO knowledge_versions(object_id,version,body) VALUES(?,?,?) ON DUPLICATE KEY UPDATE body=knowledge_versions.body")
            .bind(v["id"].as_str())
            .bind(version)
            .bind(sqlx::types::Json(&v))
            .execute(tx.connection())
            .await?;
    }
    Ok(())
}
// 返回实际新建的对象（已按保存路径投影）；调用方据此执行保存后组合（指纹补记/扇出）。
pub async fn seed_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    catalog: &Value,
) -> Result<Vec<Value>> {
    let mut created = Vec::new();
    for v in catalog["objects"]
        .as_array()
        .ok_or(Error::new("invalid_input"))?
    {
        if sqlx::query("SELECT id FROM knowledge_objects WHERE id=?")
            .bind(v["id"].as_str())
            .fetch_optional(tx.connection())
            .await?
            .is_none()
        {
            persist(tx, ctx, v, &["*"]).await?;
            let mut saved = v.clone();
            super::structure::project_object(&mut saved);
            super::preparation::project_object(&mut saved);
            created.push(saved);
        }
    }
    Ok(created)
}
pub async fn list_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    active_only: bool,
) -> Result<Vec<Value>> {
    let rows=sqlx::query("SELECT body FROM knowledge_objects FORCE INDEX(PRIMARY) WHERE space_id=? AND state<>'deleted' AND (?=0 OR state='enabled') ORDER BY id").bind(&ctx.space_id).bind(active_only).fetch_all(tx.connection()).await?;
    Ok(rows.iter().map(body).collect())
}
pub async fn table_objects_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    table: &str,
) -> Result<Vec<Value>> {
    let rows = sqlx::query("SELECT body FROM knowledge_objects WHERE space_id=? AND state='enabled' AND (id=? OR (kind='field' AND JSON_CONTAINS(JSON_EXTRACT(body,'$.related_ids'),JSON_QUOTE(?)))) ORDER BY id")
        .bind(&ctx.space_id).bind(table).bind(table).fetch_all(tx.connection()).await?;
    Ok(rows.iter().map(body).collect())
}

// 启动重放批量登记的field→table归属解析：候选id中当前空间仍为table且未删除的集合。
pub async fn live_table_ids_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    ids: &[String],
) -> Result<std::collections::HashSet<String>> {
    let mut tables = std::collections::HashSet::new();
    for chunk in ids.chunks(500) {
        let mut query = sqlx::QueryBuilder::<sqlx::MySql>::new(
            "SELECT id FROM knowledge_objects WHERE space_id=",
        );
        query
            .push_bind(&ctx.space_id)
            .push(" AND state<>'deleted' AND JSON_UNQUOTE(JSON_EXTRACT(body,'$.kind'))='table' AND id IN (");
        let mut keys = query.separated(",");
        for id in chunk {
            keys.push_bind(id);
        }
        query.push(")");
        for row in query.build().fetch_all(tx.connection()).await? {
            tables.insert(row.get::<String, _>("id"));
        }
    }
    Ok(tables)
}

pub async fn related_documents_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    ids: &[String],
) -> Result<Vec<Value>> {
    let keys = serde_json::to_string(ids).map_err(|_| Error::new("invalid_input"))?;
    let rows = sqlx::query("SELECT d.body FROM knowledge_objects d WHERE d.space_id=? AND d.state='enabled' AND d.kind='document' AND (JSON_CONTAINS(CAST(? AS JSON),JSON_QUOTE(d.id)) OR JSON_OVERLAPS(JSON_EXTRACT(d.body,'$.related_ids'),CAST(? AS JSON)) OR EXISTS(SELECT 1 FROM knowledge_objects f WHERE f.space_id=d.space_id AND f.state='enabled' AND f.kind='field' AND JSON_OVERLAPS(JSON_EXTRACT(f.body,'$.related_ids'),CAST(? AS JSON)) AND JSON_CONTAINS(JSON_EXTRACT(d.body,'$.related_ids'),JSON_QUOTE(f.id)))) ORDER BY d.id LIMIT 33")
        .bind(&ctx.space_id).bind(&keys).bind(&keys).bind(&keys).fetch_all(tx.connection()).await?;
    Ok(rows.iter().map(body).collect())
}

pub async fn lock_versions_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    refs: &[(String, u64)],
) -> Result<()> {
    let mut refs = refs.to_vec();
    refs.sort();
    refs.dedup();
    for (id, version) in refs {
        let row = sqlx::query(
            "SELECT version,state FROM knowledge_objects WHERE id=? AND space_id=? FOR UPDATE",
        )
        .bind(id)
        .bind(&ctx.space_id)
        .fetch_optional(tx.connection())
        .await?
        .ok_or(Error::new("not_available"))?;
        if row.get::<u64, _>("version") != version || row.get::<String, _>("state") != "enabled" {
            return Err(Error::new("stale_knowledge"));
        }
    }
    Ok(())
}
pub async fn read_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
    version: Option<u64>,
    manage: bool,
) -> Result<Value> {
    let row = sqlx::query("SELECT body,state FROM knowledge_objects WHERE id=? AND space_id=?")
        .bind(object)
        .bind(&ctx.space_id)
        .fetch_optional(tx.connection())
        .await?
        .ok_or(Error::new("not_available"))?;
    if row.get::<String, _>("state") == "deleted"
        || (!manage && row.get::<String, _>("state") != "enabled")
    {
        return Err(Error::new("not_available"));
    }
    let current = body(&row);
    if let Some(version) = version {
        if current["version"]
            .as_str()
            .and_then(|s| s.parse::<u64>().ok())
            == Some(version)
        {
            return Ok(current);
        }
        if !manage {
            return Err(Error::new("stale_knowledge"));
        }
        return sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
            "SELECT body FROM knowledge_versions WHERE object_id=? AND version=?",
        )
        .bind(object)
        .bind(version)
        .fetch_optional(tx.connection())
        .await?
        .map(|v| {
            let mut value = v.0;
            super::structure::project_object(&mut value);
            value
        })
        .ok_or(Error::new("not_available"));
    }
    Ok(current)
}

// 历史核验的元信息视图：状态、种类、钉住版本与有无有效值（判完整），正文与
// knowledge_versions全文都不装配；钉住语义与read_in_tx一致（请求版本≠当前
// 版本报stale_knowledge）。有效值计数与document_source的拼接判空一致。
// 存档版本正文读取（legacy历史回退）：任意历史修订，不要求是当前头版本、
// 不看启停状态——存在性由调用方按当前头另行核验；与保存路径同构的结构投影。
pub async fn archived_body_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
    version: u64,
) -> Result<Option<Value>> {
    let mut body = sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
        "SELECT body FROM knowledge_objects WHERE id=? AND version=? AND space_id=?",
    )
    .bind(object)
    .bind(version)
    .bind(&ctx.space_id)
    .fetch_optional(tx.connection())
    .await?;
    if body.is_none() {
        body = sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
            "SELECT v.body FROM knowledge_versions v \
             JOIN knowledge_objects k ON k.id=v.object_id \
             WHERE v.object_id=? AND v.version=? AND k.space_id=?",
        )
        .bind(object)
        .bind(version)
        .bind(&ctx.space_id)
        .fetch_optional(tx.connection())
        .await?;
    }
    Ok(body.map(|v| {
        let mut value = v.0;
        super::structure::project_object(&mut value);
        value
    }))
}

pub async fn read_meta_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
    version: Option<u64>,
) -> Result<Value> {
    let row = sqlx::query(
        "SELECT state, \
         JSON_UNQUOTE(JSON_EXTRACT(body,'$.name')) AS name, \
         JSON_UNQUOTE(JSON_EXTRACT(body,'$.kind')) AS kind, \
         JSON_UNQUOTE(JSON_EXTRACT(body,'$.version')) AS version, \
         JSON_LENGTH(JSON_EXTRACT(body,'$.entries[*].effective_value')) AS effective \
         FROM knowledge_objects WHERE id=? AND space_id=?",
    )
    .bind(object)
    .bind(&ctx.space_id)
    .fetch_optional(tx.connection())
    .await?
    .ok_or(Error::new("not_available"))?;
    if row.get::<String, _>("state") != "enabled" {
        return Err(Error::new("not_available"));
    }
    let current = row
        .get::<Option<String>, _>("version")
        .ok_or(Error::new("not_available"))?;
    if version.is_some_and(|requested| current.parse::<u64>().ok() != Some(requested)) {
        return Err(Error::new("stale_knowledge"));
    }
    Ok(
        json!({"id":object,"name":row.get::<Option<String>,_>("name"),"kind":row.get::<Option<String>,_>("kind"),"version":current,
        "complete":row.get::<Option<i64>,_>("effective").is_some_and(|n| n > 0)}),
    )
}

// 按当前有效层定点补读；权限/版本在同一次SQL核验，不重复调用read_meta。
// offset/limit按Unicode字符计；结构仅在offset0的完整JSON页提供可采用对象，
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
pub async fn read_revision_fingerprint_in_tx(
    tx: &mut AppTx<'_>,
    object: &str,
    version: u64,
) -> Result<String> {
    let row =
        sqlx::query("SELECT fingerprint FROM knowledge_revisions WHERE object_id=? AND version=?")
            .bind(object)
            .bind(version)
            .fetch_optional(tx.connection())
            .await?;
    Ok(row
        .map(|row| row.get::<String, _>("fingerprint"))
        .unwrap_or_default())
}

// 先选最早匹配位置再读原支持正文，避免长JSON参与排序；不能用引用全文替代。
pub async fn read_support_content_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    reference: &crate::contracts::generated::EvidenceRef,
    support: (&str, &str),
    offset: usize,
    limit: usize,
) -> Result<Value> {
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
                    .unwrap()
                    .push(json!({"source_id":source,"version":revision}));
            }
        }
    }
    Ok(objects.into_values().collect())
}

pub async fn is_deleted_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
) -> Result<bool> {
    Ok(sqlx::query_scalar::<_, String>(
        "SELECT state FROM knowledge_objects WHERE id=? AND space_id=?",
    )
    .bind(object)
    .bind(&ctx.space_id)
    .fetch_optional(tx.connection())
    .await?
    .is_some_and(|state| state == "deleted"))
}

// enabled对象的全局头：按全局id取(所属空间,当前版本)；组合层据此把作业资源
// 身份解析到空间。state!='enabled'或不存在为None。
pub async fn enabled_head_in_tx(tx: &mut AppTx<'_>, id: &str) -> Result<Option<(String, u64)>> {
    let row = sqlx::query(
        "SELECT space_id,version FROM knowledge_objects WHERE id=? AND state='enabled'",
    )
    .bind(id)
    .fetch_optional(tx.connection())
    .await?;
    Ok(row.map(|row| (row.get("space_id"), row.get("version"))))
}

// 依赖核验用的对象当前版本：按对象全局身份读取（与依赖行登记的目标身份一致），
// 不带空间过滤；state='enabled'才在结果内，缺失即当前不存在。
pub async fn enabled_versions_in_tx(
    tx: &mut AppTx<'_>,
    ids: &[String],
) -> Result<std::collections::HashMap<String, u64>> {
    let mut versions = std::collections::HashMap::new();
    for chunk in ids.chunks(200) {
        if chunk.is_empty() {
            continue;
        }
        let list = std::iter::repeat_n("?", chunk.len())
            .collect::<Vec<_>>()
            .join(",");
        let mut query = sqlx::query(sqlx::AssertSqlSafe(format!(
            "SELECT id,version FROM knowledge_objects WHERE state='enabled' AND id IN ({list})"
        )));
        for id in chunk {
            query = query.bind(id);
        }
        for row in query.fetch_all(tx.connection()).await? {
            versions.insert(row.get("id"), row.get("version"));
        }
    }
    Ok(versions)
}

// 依赖核验用的对象当前正文：原始body不做投影，与登记指纹的原文比较口径一致。
pub async fn enabled_body_in_tx(tx: &mut AppTx<'_>, id: &str) -> Result<Option<Value>> {
    let body = sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
        "SELECT body FROM knowledge_objects WHERE state='enabled' AND id=?",
    )
    .bind(id)
    .fetch_optional(tx.connection())
    .await?
    .map(|body| body.0);
    Ok(body)
}

// 指定空间内对象的当前有效版本：扇出分页按依赖者当前版本收敛用；非enabled或
// 不在该空间为None。
pub async fn enabled_version_in_space_in_tx(
    tx: &mut AppTx<'_>,
    space: &str,
    id: &str,
) -> Result<Option<u64>> {
    let version = sqlx::query_scalar::<_, u64>(
        "SELECT version FROM knowledge_objects WHERE id=? AND space_id=? AND state='enabled'",
    )
    .bind(id)
    .bind(space)
    .fetch_optional(tx.connection())
    .await?;
    Ok(version)
}
pub(super) async fn locked(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
    expected: &str,
) -> Result<Value> {
    let row=sqlx::query("SELECT body FROM knowledge_objects WHERE id=? AND space_id=? AND state<>'deleted' FOR UPDATE").bind(object).bind(&ctx.space_id).fetch_optional(tx.connection()).await?.ok_or(Error::new("not_available"))?;
    let v = body(&row);
    if v["version"] != expected {
        return Err(Error::new("version_conflict"));
    }
    Ok(v)
}
pub(super) fn next(v: &mut Value, ctx: &AccessContext) {
    v["version"] = json!(
        (epoch(v["version"].as_str().unwrap_or("0")).expect("saved version") + 1).to_string()
    );
    v["updated_by"] = json!(ctx.user_id);
}
pub async fn begin_edit_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
    input: &Value,
) -> Result<Option<Value>> {
    let key = input["operation_id"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?;
    begin_operation(tx, ctx, key, &json!({"object_id":object,"input":input})).await
}

pub async fn begin_create_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    input: &Value,
) -> Result<Option<Value>> {
    let key = input["operation_id"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?;
    let receipt = begin_operation(tx, ctx, key, input).await?;
    if let Some(value) = &receipt {
        read_in_tx(
            tx,
            ctx,
            value["id"].as_str().ok_or(Error::new("invalid_input"))?,
            None,
            false,
        )
        .await?;
    }
    Ok(receipt)
}

pub async fn begin_reanalysis_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
    input: &Value,
) -> Result<Option<Value>> {
    let key = input["operation_id"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?;
    begin_operation(
        tx,
        ctx,
        key,
        &json!({"action":"reanalyze","object_id":object,"input":input}),
    )
    .await
}

pub async fn save_edit_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
    input: &Value,
    source_value: Option<&str>,
) -> Result<Value> {
    let key = input["operation_id"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?;
    let command = json!({"object_id":object,"input":input});
    if let Some(v) = begin_operation(tx, ctx, key, &command).await? {
        return Ok(v);
    }
    let mut v = locked(
        tx,
        ctx,
        object,
        input["expected_version"].as_str().unwrap_or(""),
    )
    .await?;
    if input["entry_id"] == "business_domain"
        && !v["entries"].as_array().is_some_and(|entries| {
            entries
                .iter()
                .any(|entry| entry["entry_id"] == "business_domain")
        })
    {
        if input["clear_override"] == true
            || v["entries"].as_array().is_some_and(|entries| {
                entries.len() >= 200
                    || entries
                        .iter()
                        .any(|entry| entry["path"] == "business_domain")
            })
        {
            return Err(Error::new("invalid_input"));
        }
        v["entries"]
            .as_array_mut()
            .ok_or(Error::new("invalid_input"))?
            .push(business_domain_entry());
    }
    if v["entries"].as_array().is_some_and(|entries| {
        entries.iter().any(|entry| {
            entry["entry_id"] == input["entry_id"] && entry["path"] == "business_domain"
        })
    }) && input["clear_override"] != true
    {
        validate_business_domain(&input["value"])?;
    }
    if input["clear_override"] != true {
        if !input["structured_value"].is_null()
            && input["value"]
                .as_str()
                .is_none_or(|value| value.trim().is_empty())
        {
            return Err(Error::new("invalid_input"));
        }
        super::structure::validate_edit_in_tx(
            tx,
            ctx,
            &v,
            input["entry_id"].as_str().unwrap_or(""),
            &input["structured_value"],
        )
        .await?;
    }
    if input.get("source_url").is_some() || input.get("related_ids").is_some() {
        if v["kind"] != "document" || input["entry_id"] != "body" || input["clear_override"] == true
        {
            return Err(Error::new("invalid_input"));
        }
        validate_document_metadata(tx, ctx, input).await?;
        if let Some(related) = input.get("related_ids") {
            v["related_ids"] = related.clone();
        }
    }
    let human_statements = if let Some(drafts) = input["statements"].as_array() {
        if input["clear_override"] == true {
            return Err(Error::new("invalid_input"));
        }
        let entry = v["entries"]
            .as_array()
            .and_then(|entries| {
                entries
                    .iter()
                    .find(|entry| entry["entry_id"] == input["entry_id"])
            })
            .ok_or(Error::new("invalid_input"))?;
        let mut keys = std::collections::HashSet::new();
        let mut statements = Vec::new();
        let mut rendered = Vec::new();
        for draft in drafts {
            if draft["target"]["object_id"] != object
                || draft["target"]["version"] != v["version"]
                || draft["target"]["path"] != entry["path"]
                || !keys.insert(draft["key"].to_string())
            {
                return Err(Error::new("invalid_input"));
            }
            let statement_id = fingerprint(&json!([
                "human_statement",
                object,
                entry["path"],
                draft["key"]
            ]));
            let mut supports = Vec::new();
            let mut support_keys = std::collections::HashSet::new();
            for support in draft["supports"].as_array().into_iter().flatten() {
                if !support_keys.insert(support["key"].to_string()) {
                    return Err(Error::new("invalid_input"));
                }
                if !support["embedded_in"].is_null() {
                    let locator = crate::contracts::decode::<
                        crate::contracts::generated::SourceLocator,
                    >(
                        "SourceLocator", support["embedded_in"]["locator"].clone()
                    )?;
                    let field = support["embedded_in"]["field"]
                        .as_str()
                        .ok_or(Error::new("invalid_input"))?;
                    if support["content"].as_str()
                        != Some(locator.slice(draft[field].as_str().unwrap_or(""))?)
                    {
                        return Err(Error::new("invalid_input"));
                    }
                }
                supports.push(json!({"support_id":fingerprint(&json!([statement_id,support["key"]])),
                    "role":support["role"],"reference":support["reference"],"content":support["content"],
                    "embedded_in":support["embedded_in"]}));
            }
            let mut statement = json!({"statement_id":statement_id,
                "object_ref":{"object_id":object,"version":v["version"],"path":entry["path"]},
                "text":draft["text"],"scope_text":draft["scope_text"],"origin":"human",
                "citations":draft["citations"],"supports":supports});
            if let Some(declaration) = draft.get("supports_complete") {
                statement["supports_complete"] = declaration.clone();
            }
            let text = draft["text"].as_str().ok_or(Error::new("invalid_input"))?;
            let scope = draft["scope_text"]
                .as_str()
                .ok_or(Error::new("invalid_input"))?;
            rendered.push(if scope.is_empty() {
                text.to_owned()
            } else {
                format!("{text}\n{scope}")
            });
            statements.push(statement);
        }
        if !drafts.is_empty() && rendered.join("\n\n") != input["value"].as_str().unwrap_or("") {
            return Err(Error::new("invalid_input"));
        }
        Some(json!(statements))
    } else {
        None
    };
    let entry = v["entries"]
        .as_array_mut()
        .ok_or(Error::new("invalid_input"))?
        .iter_mut()
        .find(|e| e["entry_id"] == input["entry_id"])
        .ok_or(Error::new("invalid_input"))?;
    if input["clear_override"] == true {
        entry["human_override"] = Value::Null;
        entry["effective_value"] = json!(
            entry["suggestion"]["value"]
                .as_str()
                .or_else(|| entry["source_facts"]["value"].as_str())
                .or(source_value)
                .unwrap_or("")
        );
        entry["review_state"] = json!("unverified");
    } else {
        let source_url = input
            .get("source_url")
            .cloned()
            .unwrap_or_else(|| entry["human_override"]["source_url"].clone());
        let related_override = input
            .get("related_ids")
            .cloned()
            .or_else(|| entry["human_override"].get("related_ids").cloned());
        entry["human_override"] = json!({"value":input["value"],"edited_by":ctx.user_id,"operation_id":key,"source_url":source_url});
        entry["human_override"]["structured_value"] = input["structured_value"].clone();
        if let Some(statements) = human_statements {
            entry["human_override"]["statements"] = statements;
        }
        if let Some(related) = related_override {
            entry["human_override"]["related_ids"] = related;
        }
        entry["effective_value"] = input["value"].clone();
        entry["review_state"] = json!("confirmed");
        if entry["entry_id"] == "body"
            && entry["source_facts"]["gap"] == "只有链接，正文尚未录入，不能据此解释业务"
            && input["value"]
                .as_str()
                .is_some_and(|v| !v.trim().is_empty())
        {
            entry["source_facts"]["gap"] = json!("人工录入，尚无平台来源");
        }
    }
    super::structure::project_object(&mut v);
    super::structure::mark_other_rules_for_review(&mut v, input["entry_id"].as_str().unwrap_or(""));
    next(&mut v, ctx);
    super::preparation::project_object(&mut v);
    let changed_path = v["entries"]
        .as_array()
        .and_then(|entries| {
            entries
                .iter()
                .find(|entry| entry["entry_id"] == input["entry_id"])
        })
        .and_then(|entry| entry["path"].as_str())
        .ok_or(Error::new("invalid_input"))?;
    persist(tx, ctx, &v, &[changed_path]).await?;
    record(tx, ctx, key, &command, &v).await?;
    Ok(v)
}
pub async fn create_in_tx(tx: &mut AppTx<'_>, ctx: &AccessContext, input: &Value) -> Result<Value> {
    let key = input["operation_id"].as_str().unwrap_or("");
    if let Some(v) = begin_operation(tx, ctx, key, input).await? {
        read_in_tx(
            tx,
            ctx,
            v["id"].as_str().ok_or(Error::new("invalid_input"))?,
            None,
            false,
        )
        .await?;
        return Ok(v);
    }
    validate_document_metadata(tx, ctx, input).await?;
    let gap = if input["body"].as_str().is_none_or(|b| b.trim().is_empty()) {
        "只有链接，正文尚未录入，不能据此解释业务"
    } else {
        "人工录入，尚无平台来源"
    };
    let mut v = json!({"id":id(),"kind":input["kind"],"name":input["name"],"version":"1","state":"enabled","entries":[{"entry_id":"body","path":"body","label":"正文","source_facts":{"complete":false,"gap":gap},"suggestion":{},"human_override":{"value":input["body"],"structured_value":input["structured_value"],"edited_by":ctx.user_id,"source_url":input["source_url"]},"effective_value":input["body"],"review_state":"confirmed"}],"related_ids":input["related_ids"],"source_id":null,"source_version":"0","updated_by":ctx.user_id,"created_by":ctx.user_id});
    if let Some(domain) = input.get("business_domain") {
        validate_business_domain(domain)?;
        let mut entry = business_domain_entry();
        entry["human_override"] =
            json!({"value":domain,"edited_by":ctx.user_id,"operation_id":key});
        entry["effective_value"] = domain.clone();
        entry["review_state"] = json!("confirmed");
        v["entries"].as_array_mut().unwrap().push(entry);
    }
    if !input["structured_value"].is_null()
        && input["body"]
            .as_str()
            .is_none_or(|value| value.trim().is_empty())
    {
        return Err(Error::new("invalid_input"));
    }
    super::structure::validate_edit_in_tx(tx, ctx, &v, "body", &input["structured_value"]).await?;
    super::structure::project_object(&mut v);
    persist(tx, ctx, &v, &["*"]).await?;
    record(tx, ctx, key, input, &v).await?;
    Ok(v)
}

fn validate_business_domain(value: &Value) -> Result<()> {
    let domain = value.as_str().ok_or(Error::new("invalid_input"))?;
    if domain.chars().count() > 240 || domain.trim() != domain {
        return Err(Error::new("invalid_input"));
    }
    Ok(())
}

fn business_domain_entry() -> Value {
    // 只新增可人工维护的归属槽位，不从关联对象推断，也不伪造平台来源。
    json!({"entry_id":"business_domain","path":"business_domain","label":"业务域",
        "source_facts":{"complete":false,"value":"","gap":"尚未提供业务域来源"},
        "suggestion":{},"human_override":null,"effective_value":"","review_state":"unverified"})
}
pub async fn change_state_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
    input: &Value,
    state: &str,
) -> Result<Value> {
    let key = input["operation_id"].as_str().unwrap_or("");
    let command = json!({"object_id":object,"input":input,"state":state});
    if let Some(v) = begin_operation(tx, ctx, key, &command).await? {
        return Ok(v);
    }
    let mut v = locked(
        tx,
        ctx,
        object,
        input["expected_version"].as_str().unwrap_or(""),
    )
    .await?;
    v["state"] = json!(state);
    v["state_origin"] = json!("human");
    next(&mut v, ctx);
    persist(tx, ctx, &v, &["*"]).await?;
    record(tx, ctx, key, &command, &v).await?;
    Ok(v)
}
pub async fn reanalyze_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
    input: &Value,
    source_version: u64,
    candidate: &Value,
) -> Result<Value> {
    let key = input["operation_id"].as_str().unwrap_or("");
    let command = json!({"action":"reanalyze","object_id":object,"input":input});
    if let Some(v) = begin_operation(tx, ctx, key, &command).await? {
        return Ok(v);
    }
    let locked = locked(
        tx,
        ctx,
        object,
        input["expected_version"].as_str().unwrap_or(""),
    )
    .await;
    let mut v = match locked {
        Ok(value) => value,
        Err(error) => {
            // 预填会提交superseded回执；对象冲突不能顺带提交空操作占位。
            sqlx::query("DELETE FROM knowledge_operations WHERE owner_id=? AND operation_id=? AND fingerprint=? AND JSON_TYPE(receipt)='NULL'")
                .bind(&ctx.user_id).bind(key).bind(fingerprint(&command)).execute(tx.connection()).await?;
            return Err(error);
        }
    };
    // 来源撤下的条目不能继续当有效来源；人工内容保留并明确需要重新核对。
    let candidates = candidate["entries"]
        .as_array()
        .ok_or(Error::new("invalid_input"))?;
    v["entries"]
        .as_array_mut()
        .ok_or(Error::new("invalid_input"))?
        .retain(|entry| {
            !entry["human_override"].is_null()
                || candidates
                    .iter()
                    .any(|new| new["entry_id"] == entry["entry_id"])
        });
    let mut manual_relations = None;
    for entry in v["entries"]
        .as_array_mut()
        .ok_or(Error::new("invalid_input"))?
    {
        if let Some(new) = candidate["entries"]
            .as_array()
            .and_then(|a| a.iter().find(|e| e["entry_id"] == entry["entry_id"]))
        {
            entry["source_facts"] = new["source_facts"].clone();
            entry["suggestion"] = new["suggestion"].clone();
            if entry["human_override"].is_null() {
                entry["effective_value"] = new["effective_value"].clone();
                entry["review_state"] = json!("unverified");
            } else {
                entry["review_state"] = json!("needs_review");
            }
        } else {
            entry["source_facts"] = json!({"source_id":candidate["source_id"],"version":source_version.to_string(),"complete":false,"gap":"来源已撤下此条目，保留人工内容待复核"});
            entry["suggestion"] = json!({});
            entry["review_state"] = json!("needs_review");
        }
        if entry["human_override"]["related_ids"].is_array() {
            manual_relations = Some(entry["human_override"]["related_ids"].clone());
        }
    }
    for entry in candidate["entries"]
        .as_array()
        .ok_or(Error::new("invalid_input"))?
    {
        if !v["entries"]
            .as_array()
            .is_some_and(|items| items.iter().any(|old| old["entry_id"] == entry["entry_id"]))
        {
            v["entries"]
                .as_array_mut()
                .ok_or(Error::new("invalid_input"))?
                .push(entry.clone());
        }
    }
    if v["state"] == "disabled" && v["state_origin"] == "platform" {
        v["state"] = json!("enabled");
    }
    v["name"] = candidate["name"].clone();
    v["related_ids"] = manual_relations.unwrap_or_else(|| candidate["related_ids"].clone());
    v["source_version"] = json!(source_version.to_string());
    super::structure::project_object(&mut v);
    super::structure::validate_single_structure(&v)?;
    next(&mut v, ctx);
    persist(tx, ctx, &v, &["*"]).await?;
    record(tx, ctx, key, &command, &v).await?;
    Ok(v)
}
pub async fn check_refs_in_tx(tx: &mut AppTx<'_>, ctx: &AccessContext, refs: &Value) -> Result<()> {
    for r in refs.as_array().ok_or(Error::new("invalid_input"))? {
        let v = read_in_tx(tx, ctx, r["object_id"].as_str().unwrap_or(""), None, false).await?;
        if v["version"] != r["version"] {
            return Err(Error::new("stale_knowledge"));
        }
        if let Some(path) = r["path"].as_str()
            && !path.is_empty()
            && !v["entries"]
                .as_array()
                .is_some_and(|a| a.iter().any(|e| e["entry_id"] == path || e["path"] == path))
        {
            return Err(Error::new("invalid_evidence"));
        }
    }
    Ok(())
}
pub async fn propose_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    operation: &str,
    input: &Value,
) -> Result<Value> {
    check_refs_in_tx(tx, ctx, &input["evidence"]).await?;
    let current = read_in_tx(
        tx,
        ctx,
        input["object_id"].as_str().unwrap_or(""),
        None,
        false,
    )
    .await?;
    if current["version"] != input["base_version"] {
        return Err(Error::new("version_conflict"));
    }
    if input["evidence"].as_array().is_none_or(|a| a.is_empty()) {
        return Err(Error::new("invalid_evidence"));
    }
    if !current["entries"]
        .as_array()
        .is_some_and(|a| a.iter().any(|e| e["entry_id"] == input["entry_id"]))
    {
        return Err(Error::new("invalid_evidence"));
    }
    let v = json!({"id":operation,"object_id":input["object_id"],"base_version":input["base_version"],"entry_id":input["entry_id"],"value":input["value"],"reason":input["reason"],"evidence":input["evidence"],"state":"open"});
    sqlx::query("INSERT INTO semantic_change_proposals(id,owner_id,space_id,body) VALUES(?,?,?,?)")
        .bind(operation)
        .bind(&ctx.user_id)
        .bind(&ctx.space_id)
        .bind(sqlx::types::Json(&v))
        .execute(tx.connection())
        .await?;
    Ok(v)
}
pub async fn proposals_in_tx(tx: &mut AppTx<'_>, ctx: &AccessContext) -> Result<Vec<Value>> {
    let rows=sqlx::query("SELECT body FROM semantic_change_proposals WHERE owner_id=? AND space_id=? AND state='open'").bind(&ctx.user_id).bind(&ctx.space_id).fetch_all(tx.connection()).await?;
    Ok(rows.iter().map(body).collect())
}
pub async fn apply_proposal_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    proposal: &str,
    input: &Value,
) -> Result<Value> {
    let key = input["operation_id"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?;
    let command = json!({"proposal_id":proposal,"input":input});
    if let Some(v) = begin_operation(tx, ctx, key, &command).await? {
        return Ok(v);
    }
    let row=sqlx::query("SELECT body FROM semantic_change_proposals WHERE id=? AND owner_id=? AND space_id=? FOR UPDATE").bind(proposal).bind(&ctx.user_id).bind(&ctx.space_id).fetch_optional(tx.connection()).await?.ok_or(Error::new("not_available"))?;
    let p = body(&row);
    if input["expected_version"] != p["base_version"] {
        return Err(Error::new("version_conflict"));
    }
    check_refs_in_tx(tx, ctx, &p["evidence"]).await?;
    let edit = json!({"operation_id":fingerprint(&json!({"proposal_apply":key})),"expected_version":p["base_version"],"entry_id":p["entry_id"],"value":p["value"]});
    let v = save_edit_in_tx(tx, ctx, p["object_id"].as_str().unwrap_or(""), &edit, None).await?;
    sqlx::query("UPDATE semantic_change_proposals SET state='applied' WHERE id=?")
        .bind(proposal)
        .execute(tx.connection())
        .await?;
    record(tx, ctx, key, &command, &v).await?;
    Ok(v)
}

pub async fn claim_index_batch_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    vector: bool,
    target: Option<&str>,
    require_frozen: bool,
) -> Result<Vec<Value>> {
    // 候选不加锁；随后先锁对象、再按作业主键锁定，和语义保存使用同一顺序。
    // 不能在UPDATE JOIN中先扫描作业并取得间隙锁，再等待正在保存的对象。
    // 公共待办同时承载raw来源目标：此处只领取知识对象目标。当前无合法
    // Embedding配置时仅领取已冻结配置的目标：新目标保持pending不空耗次数。
    let candidates=sqlx::query_scalar::<_,String>("SELECT DISTINCT k.id FROM knowledge_objects k JOIN knowledge_index_jobs j ON j.object_id=k.id AND j.target_kind='knowledge_entry' AND j.source_kind='' WHERE k.space_id=? AND (?=0 OR j.embedding_profile IS NOT NULL) AND ((j.version<k.version AND j.vector_state NOT IN ('indexed','bounded','superseded')) OR (j.version=k.version AND ((?=1 AND (j.vector_target IS NULL OR j.vector_target<>?)) OR (?=1 AND j.vector_state IN ('sending','unknown') AND j.vector_attempts>=3 AND j.lease_until<UTC_TIMESTAMP(3)) OR ((j.state='pending' OR (?=1 AND j.vector_state IN ('pending','sending','unknown'))) AND (j.lease_until IS NULL OR j.lease_until<UTC_TIMESTAMP(3)) AND j.vector_attempts<3)))) ORDER BY k.id LIMIT ?")
        .bind(&ctx.space_id).bind(require_frozen).bind(vector).bind(target).bind(vector).bind(vector).bind(if vector { 1_u32 } else { 64_u32 }).fetch_all(tx.connection()).await?;
    let mut jobs = Vec::new();
    for object_id in candidates {
        let Some(current_version)=sqlx::query_scalar::<_,u64>("SELECT version FROM knowledge_objects WHERE id=? AND space_id=? FOR UPDATE SKIP LOCKED")
            .bind(&object_id).bind(&ctx.space_id).fetch_optional(tx.connection()).await? else {continue;};
        let mut versions=sqlx::query_scalar::<_,u64>("SELECT version FROM knowledge_index_jobs WHERE target_kind='knowledge_entry' AND source_kind='' AND object_id=? AND version<? AND vector_state NOT IN ('indexed','bounded','superseded') ORDER BY version LIMIT 64")
            .bind(&object_id).bind(current_version).fetch_all(tx.connection()).await?;
        versions.push(current_version);
        for version in versions {
            let Some(row)=sqlx::query("SELECT state,vector_state,vector_attempts,vector_target,lease_epoch,lease_until IS NULL OR lease_until<UTC_TIMESTAMP(3) AS available FROM knowledge_index_jobs WHERE target_kind='knowledge_entry' AND source_kind='' AND object_id=? AND version=? FOR UPDATE SKIP LOCKED")
                .bind(&object_id).bind(version).fetch_optional(tx.connection()).await? else {continue;};
            let mut vector_state: String = row.get("vector_state");
            if version < current_version {
                if !matches!(vector_state.as_str(), "indexed" | "bounded" | "superseded") {
                    sqlx::query("UPDATE knowledge_index_jobs SET state='indexed',vector_state='superseded' WHERE target_kind='knowledge_entry' AND source_kind='' AND object_id=? AND version=?")
                        .bind(&object_id).bind(version).execute(tx.connection()).await?;
                }
                continue;
            }
            let mut attempts: u32 = row.get("vector_attempts");
            let mut epoch: u64 = row.get("lease_epoch");
            let mut available: bool = row.get("available");
            let previous_target: Option<String> = row.get("vector_target");
            if vector && (previous_target.is_none() || previous_target.as_deref() != target) {
                sqlx::query("UPDATE knowledge_index_jobs SET vector_state='pending',vector_attempts=0,vector_error=NULL,vector_receipt=NULL,lease_until=NULL,lease_epoch=lease_epoch+1,vector_target=? WHERE target_kind='knowledge_entry' AND source_kind='' AND object_id=? AND version=?")
                    .bind(target).bind(&object_id).bind(version).execute(tx.connection()).await?;
                vector_state = "pending".into();
                attempts = 0;
                epoch += 1;
                available = true;
            }
            // 最后一次领取后进程退出，收敛为明确失败，保留受控重建入口。
            if vector
                && available
                && attempts >= 3
                && matches!(vector_state.as_str(), "sending" | "unknown")
            {
                sqlx::query("UPDATE knowledge_index_jobs SET vector_state='failed',vector_error='vector_receipt_unknown',lease_until=NULL,lease_epoch=lease_epoch+1 WHERE target_kind='knowledge_entry' AND source_kind='' AND object_id=? AND version=?")
                    .bind(&object_id).bind(version).execute(tx.connection()).await?;
                continue;
            }
            let pending = row.get::<String, _>("state") == "pending"
                || (vector && matches!(vector_state.as_str(), "pending" | "sending" | "unknown"));
            if !pending || !available || attempts >= 3 {
                continue;
            }
            epoch += 1;
            sqlx::query("UPDATE knowledge_index_jobs SET lease_epoch=?,lease_until=TIMESTAMPADD(SECOND,120,UTC_TIMESTAMP(3)),vector_state=IF(?=1,'sending',vector_state),vector_attempts=vector_attempts+? WHERE target_kind='knowledge_entry' AND source_kind='' AND object_id=? AND version=?")
                .bind(epoch).bind(vector).bind(u32::from(vector)).bind(&object_id).bind(version).execute(tx.connection()).await?;
            // 已持有对象行锁；按同修订读取current，不能沿用候选快照里的旧正文。
            let object = sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
                "SELECT body FROM knowledge_objects WHERE id=? AND version=? FOR SHARE",
            )
            .bind(&object_id)
            .bind(version)
            .fetch_one(tx.connection())
            .await?
            .0;
            jobs.push(json!({"object_id":object_id,"job_version":version.to_string(),"lease_epoch":epoch.to_string(),"object":object}));
        }
    }
    Ok(jobs)
}
// 公共索引待办的原文目标登记：SourceKey身份贯穿写入、查询与清旧，平台与文档
// 同ID不互删。同目标重复登记幂等，不回退已完成或进行中的状态；origin_job_id
// 只接续旧队列移交的原作业身份，不另发一份新作业。
pub async fn register_source_index_target_in_tx(
    tx: &mut AppTx<'_>,
    space: &str,
    source: &crate::contracts::generated::SourceKey,
    revision: u64,
    origin: Option<(&str, u32)>,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO knowledge_index_jobs(target_kind,source_kind,object_id,version,space_id,origin_job_id,vector_attempts) \
         VALUES('source_excerpt',?,?,?,?,?,?) \
         ON DUPLICATE KEY UPDATE origin_job_id=COALESCE(origin_job_id,VALUES(origin_job_id)), \
         vector_attempts=GREATEST(vector_attempts,VALUES(vector_attempts))",
    )
    .bind(source_kind_label(source))
    .bind(source.id.as_str())
    .bind(revision)
    .bind(space)
    .bind(origin.map(|(id, _)| id))
    .bind(origin.map_or(0, |(_, attempts)| attempts))
    .execute(tx.connection())
    .await?;
    Ok(())
}

pub(crate) fn source_kind_label(source: &crate::contracts::generated::SourceKey) -> &'static str {
    match source.kind {
        crate::contracts::generated::SourceKeyKind::Document => "document",
        crate::contracts::generated::SourceKeyKind::Platform => "platform",
    }
}

// 平台原文索引待办的进度展示：按来源当前修订读取公共待办状态，与旧队列统计
// 口径一致（pending/running/completed/failed）；只覆盖传入的明确来源清单。
pub async fn platform_source_index_progress_in_tx(
    tx: &mut AppTx<'_>,
    space: &str,
    sources: &[(String, u64)],
) -> Result<Value> {
    let (mut total, mut complete, mut failed, mut running) = (0u64, 0u64, 0u64, false);
    for (source, revision) in sources {
        let state = sqlx::query_scalar::<_, String>(
            "SELECT CONCAT(state,':',vector_state) FROM knowledge_index_jobs \
             WHERE target_kind='source_excerpt' AND source_kind='platform' AND space_id=? \
             AND object_id=? AND version=?",
        )
        .bind(space)
        .bind(source)
        .bind(revision)
        .fetch_optional(tx.connection())
        .await?;
        total += 1;
        if let Some(joined) = state.as_deref() {
            let vector = joined.rsplit(':').next().unwrap_or("");
            if matches!(vector, "indexed" | "superseded") {
                complete += 1;
            } else if vector == "failed" {
                failed += 1;
            } else if vector == "sending" {
                running = true;
            }
        }
    }
    let status = if total == 0 {
        "not_required"
    } else if failed > 0 {
        "failed"
    } else if complete == total {
        "completed"
    } else if running {
        "running"
    } else {
        "pending"
    };
    Ok(json!({"status":status,"total":total,"completed":complete,"failed":failed}))
}

// 恢复资格身份清单以行构造器IN接入：MySQL按(source_kind,object_id,version)
// 元组比较，全部走绑定，不拼接SQL文本。
fn push_identity_filter(
    builder: &mut sqlx::QueryBuilder<sqlx::MySql>,
    identities: &[(String, String, u64)],
) {
    builder.push(" AND (source_kind,object_id,version) IN (");
    let mut rows = builder.separated(",");
    for (source_kind, object_id, version) in identities {
        rows.push("(");
        rows.push_bind_unseparated(source_kind.clone());
        rows.push_unseparated(",");
        rows.push_bind_unseparated(object_id.clone());
        rows.push_unseparated(",");
        rows.push_bind_unseparated(*version);
        rows.push_unseparated(")");
    }
    builder.push(")");
}

// 原文目标领取：与知识目标同一租约纪律（120秒租约、代次递增、三次尝试上限、
// 目标代次重绑、晚到收敛）。候选经space_id直达，不经knowledge_objects联表；
// 已有更新修订目标的待办先行收敛为superseded，不消耗嵌入预算。当前无合法
// Embedding配置时，领取范围由调用方的恢复资格判定以精确身份清单给出，
// 未冻结且无原账本回执的目标保持pending，不空耗索引次数。
pub async fn claim_source_index_in_tx(
    tx: &mut AppTx<'_>,
    space: &str,
    vector: bool,
    target: Option<&str>,
    eligible: Option<&[(String, String, u64)]>,
) -> Result<Option<Value>> {
    // MySQL不允许UPDATE子查询直接自引用目标表；派生表物化后按目标身份比对。
    sqlx::query(
        "UPDATE knowledge_index_jobs j SET state='indexed',vector_state='superseded' \
         WHERE j.target_kind='source_excerpt' AND j.space_id=? \
         AND j.vector_state NOT IN ('indexed','bounded','superseded') \
         AND EXISTS (SELECT 1 FROM (SELECT newer.source_kind,newer.object_id FROM knowledge_index_jobs newer \
           WHERE newer.target_kind='source_excerpt' AND newer.space_id=j.space_id \
             AND newer.source_kind=j.source_kind AND newer.object_id=j.object_id \
             AND newer.version>j.version) stale_check)",
    )
    .bind(space)
    .execute(tx.connection())
    .await?;
    let mut convergence = sqlx::QueryBuilder::<sqlx::MySql>::new(
        "UPDATE knowledge_index_jobs SET vector_state='failed',vector_error='vector_receipt_unknown',lease_until=NULL,lease_epoch=lease_epoch+1 \
         WHERE target_kind='source_excerpt' AND space_id=",
    );
    convergence.push_bind(space).push(
        " AND vector_state IN ('pending','sending','unknown') \
         AND vector_attempts>=3 AND (lease_until IS NULL OR lease_until<UTC_TIMESTAMP(3))",
    );
    if vector {
        // 耗尽收敛不派发调用，不受发送资格或当前配置限制。
        convergence.build().execute(tx.connection()).await?;
    }
    let mut selection = sqlx::QueryBuilder::<sqlx::MySql>::new(
        "SELECT source_kind,object_id,version,state,vector_state,vector_attempts,vector_target,lease_epoch \
         FROM knowledge_index_jobs \
         WHERE target_kind='source_excerpt' AND space_id=",
    );
    selection.push_bind(space).push(
        " AND NOT EXISTS (SELECT 1 FROM knowledge_index_jobs newer \
           WHERE newer.target_kind='source_excerpt' AND newer.space_id=knowledge_index_jobs.space_id \
             AND newer.source_kind=knowledge_index_jobs.source_kind \
             AND newer.object_id=knowledge_index_jobs.object_id AND newer.version>knowledge_index_jobs.version) \
         AND (state='pending' OR vector_state IN ('pending','sending','unknown')) \
         AND (lease_until IS NULL OR lease_until<UTC_TIMESTAMP(3)) AND vector_attempts<3",
    );
    if let Some(identities) = eligible {
        // 全部候选都不具备恢复资格：无内容可领取，空IN不是合法SQL。
        if identities.is_empty() {
            return Ok(None);
        }
        push_identity_filter(&mut selection, identities);
    }
    selection.push(" ORDER BY source_kind,object_id LIMIT 1 FOR UPDATE SKIP LOCKED");
    let row = selection
        .build()
        .fetch_optional(tx.connection())
        .await
        .map_err(Error::from)?;
    let Some(row) = row else {
        return Ok(None);
    };
    let source_kind: String = row.get("source_kind");
    let object_id: String = row.get("object_id");
    let version: u64 = row.get("version");
    let mut epoch_value: u64 = row.get("lease_epoch");
    let previous_target: Option<String> = row.get("vector_target");
    if vector && (previous_target.is_none() || previous_target.as_deref() != target) {
        sqlx::query(
            "UPDATE knowledge_index_jobs SET vector_state='pending',vector_attempts=IF(vector_target IS NULL,vector_attempts,0),vector_error=NULL,vector_receipt=NULL,lease_until=NULL,lease_epoch=lease_epoch+1,vector_target=? \
             WHERE target_kind='source_excerpt' AND source_kind=? AND object_id=? AND version=?",
        )
        .bind(target)
        .bind(&source_kind)
        .bind(&object_id)
        .bind(version)
        .execute(tx.connection())
        .await?;
        epoch_value += 1;
    }
    epoch_value += 1;
    sqlx::query(
        "UPDATE knowledge_index_jobs SET lease_epoch=?,lease_until=TIMESTAMPADD(SECOND,120,UTC_TIMESTAMP(3)),vector_state=IF(?=1,'sending',vector_state),vector_attempts=vector_attempts+? \
         WHERE target_kind='source_excerpt' AND source_kind=? AND object_id=? AND version=?",
    )
    .bind(epoch_value)
    .bind(vector)
    .bind(u32::from(vector))
    .bind(&source_kind)
    .bind(&object_id)
    .bind(version)
    .execute(tx.connection())
    .await?;
    Ok(Some(json!({
        "target_kind":"source_excerpt",
        "source_kind":source_kind,
        "object_id":object_id,
        "job_version":version.to_string(),
        "lease_epoch":epoch_value.to_string(),
    })))
}

// 原文目标批次间续租：多批切块/嵌入在锁外进行，每批回短事务核代次。来源头
// 修订的复核由组合层在同事务内经各自owner接口完成，这里不跨模块读私表。
pub async fn renew_source_index_lease_in_tx(tx: &mut AppTx<'_>, job: &Value) -> Result<()> {
    let changed = sqlx::query(
        "UPDATE knowledge_index_jobs SET lease_until=TIMESTAMPADD(SECOND,120,UTC_TIMESTAMP(3)) \
         WHERE target_kind='source_excerpt' AND source_kind=? AND object_id=? AND version=? \
         AND lease_epoch=? AND vector_state='sending' AND lease_until>UTC_TIMESTAMP(3)",
    )
    .bind(job["source_kind"].as_str())
    .bind(job["object_id"].as_str())
    .bind(epoch(job["job_version"].as_str().unwrap_or("0"))?)
    .bind(epoch(job["lease_epoch"].as_str().unwrap_or("0"))?)
    .execute(tx.connection())
    .await?;
    if changed.rows_affected() != 1 {
        return Err(Error::new("lease_lost"));
    }
    Ok(())
}

// 原文目标批次嵌入前的续租与预算冻结：与知识目标同一纪律——首用冻结当前
// Embedding配置，其后各批（含重建重绑后补批）一律沿用冻结档，不换trial补额。
// 原文目标批次嵌入前的续租：锁行核当前代次与租约，只读回已冻结配置；首次
// 冻结由freeze_source_index_embedding_in_tx在同一事务内完成，许可失败回滚
// 不影响已提交的冻结值。
pub async fn bound_source_index_embedding_in_tx(
    tx: &mut AppTx<'_>,
    job: &Value,
) -> Result<Option<Value>> {
    let row = sqlx::query(
        "SELECT embedding_profile,lease_epoch,vector_state,lease_until>UTC_TIMESTAMP(3) AS valid \
         FROM knowledge_index_jobs WHERE target_kind='source_excerpt' AND source_kind=? \
         AND object_id=? AND version=? FOR UPDATE",
    )
    .bind(job["source_kind"].as_str().unwrap_or(""))
    .bind(job["object_id"].as_str().unwrap_or(""))
    .bind(epoch(job["job_version"].as_str().unwrap_or("0"))?)
    .fetch_one(tx.connection())
    .await?;
    if row.get::<String, _>("vector_state") != "sending"
        || row.get::<u64, _>("lease_epoch").to_string() != job["lease_epoch"].as_str().unwrap_or("")
        || row.get::<i64, _>("valid") != 1
    {
        return Err(Error::new("lease_lost"));
    }
    sqlx::query(
        "UPDATE knowledge_index_jobs SET lease_until=TIMESTAMPADD(SECOND,120,UTC_TIMESTAMP(3)) \
         WHERE target_kind='source_excerpt' AND source_kind=? AND object_id=? AND version=?",
    )
    .bind(job["source_kind"].as_str().unwrap_or(""))
    .bind(job["object_id"].as_str().unwrap_or(""))
    .bind(epoch(job["job_version"].as_str().unwrap_or("0"))?)
    .execute(tx.connection())
    .await?;
    Ok(row
        .get::<Option<sqlx::types::Json<Value>>, _>("embedding_profile")
        .map(|v| v.0))
}
// 首用冻结维护预算：仅对尚未冻结的目标执行；重试不能从新环境配置补额，
// 已冻结目标沿用首次档，不因当前环境改值而提前冲突。
pub async fn freeze_source_index_embedding_in_tx(
    tx: &mut AppTx<'_>,
    job: &Value,
    profile: &Value,
) -> Result<()> {
    sqlx::query(
        "UPDATE knowledge_index_jobs SET embedding_profile=? \
         WHERE target_kind='source_excerpt' AND source_kind=? AND object_id=? AND version=?",
    )
    .bind(sqlx::types::Json(profile))
    .bind(job["source_kind"].as_str().unwrap_or(""))
    .bind(job["object_id"].as_str().unwrap_or(""))
    .bind(epoch(job["job_version"].as_str().unwrap_or("0"))?)
    .execute(tx.connection())
    .await?;
    Ok(())
}

// 原文待办的可领取候选头：与claim_source_index_in_tx同一领取条件（最新修订、
// 可领取状态、租约可用、次数未耗尽），但不加锁不变更；供配置不可用时的
// 恢复资格判定在领取前核对冻结值与原账本，领取仍按原纪律加锁复核。
pub async fn source_index_heads_in_tx(
    tx: &mut AppTx<'_>,
    space: &str,
) -> Result<Vec<(String, String, u64, Option<Value>)>> {
    let rows = sqlx::query(
        "SELECT source_kind,object_id,version,embedding_profile \
         FROM knowledge_index_jobs \
         WHERE target_kind='source_excerpt' AND space_id=? \
         AND NOT EXISTS (SELECT 1 FROM knowledge_index_jobs newer \
           WHERE newer.target_kind='source_excerpt' AND newer.space_id=knowledge_index_jobs.space_id \
             AND newer.source_kind=knowledge_index_jobs.source_kind \
             AND newer.object_id=knowledge_index_jobs.object_id AND newer.version>knowledge_index_jobs.version) \
         AND (state='pending' OR vector_state IN ('pending','sending','unknown')) \
         AND (lease_until IS NULL OR lease_until<UTC_TIMESTAMP(3)) AND vector_attempts<3 \
         ORDER BY source_kind,object_id",
    )
    .bind(space)
    .fetch_all(tx.connection())
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            (
                row.get("source_kind"),
                row.get("object_id"),
                row.get("version"),
                row.get::<Option<sqlx::types::Json<Value>>, _>("embedding_profile")
                    .map(|v| v.0),
            )
        })
        .collect())
}

pub async fn finish_index_in_tx(
    tx: &mut AppTx<'_>,
    job: &Value,
    receipt: Option<&Value>,
    error: Option<&str>,
) -> Result<()> {
    // 目标判别是作业主键的一部分；知识目标缺省回填，与迁移后的旧行一致。
    let target_kind = job["target_kind"].as_str().unwrap_or("knowledge_entry");
    let source_kind = job["source_kind"].as_str().unwrap_or("");
    let changed=sqlx::query("UPDATE knowledge_index_jobs SET state='indexed',vector_state=IF(? IS NOT NULL,IF(vector_attempts>=3,'failed','unknown'),IF(? IS NULL,vector_state,?)),vector_error=?,vector_receipt=?,lease_until=IF(? IS NOT NULL,TIMESTAMPADD(SECOND,5,UTC_TIMESTAMP(3)),NULL) WHERE target_kind=? AND source_kind=? AND object_id=? AND version=? AND lease_epoch=?")
        .bind(error).bind(receipt.map(sqlx::types::Json)).bind(receipt.and_then(|v|v["state"].as_str())).bind(error).bind(receipt.map(sqlx::types::Json)).bind(error)
        .bind(target_kind).bind(source_kind).bind(job["object_id"].as_str()).bind(epoch(job["job_version"].as_str().unwrap_or("0"))?).bind(epoch(job["lease_epoch"].as_str().unwrap_or("0"))?)
        .execute(tx.connection()).await?;
    if changed.rows_affected() != 1 {
        return Err(Error::new("lease_lost"));
    }
    Ok(())
}
// 覆盖只按本次实际生效的空间、硬范围、明确来源限制和当前修订计核：允许集外
// 资料的pending不把本题报成未就绪，本题对象未索引时零命中也如实incomplete。
// 本接口只计算知识owner覆盖；内部双类型的raw投影由组合层按实际来源集另核，
// 未参与v1检索的raw待办不混入本结果。
pub async fn index_coverage_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    target: &str,
    scope: &crate::search_scope::KnowledgeSearchScope,
    allowed: Option<&[String]>,
) -> Result<&'static str> {
    if allowed.is_some_and(<[String]>::is_empty) {
        return Ok("current");
    }
    let mut sql = sqlx::QueryBuilder::<sqlx::MySql>::new(
        "SELECT COUNT(*) FROM knowledge_objects k \
         LEFT JOIN knowledge_index_jobs j \
           ON j.object_id=k.id AND j.target_kind='knowledge_entry' AND j.source_kind='' AND j.version=k.version \
         WHERE k.space_id=",
    );
    sql.push_bind(&ctx.space_id).push(" AND k.state='enabled'");
    scope.push_constraints(&mut sql, "k.id", "k.kind", "k.body");
    if let Some(ids) = allowed {
        sql.push(" AND k.id IN (");
        let mut keys = sql.separated(",");
        for id in ids {
            keys.push_bind(id);
        }
        sql.push(")");
    }
    sql.push(
        " AND (j.vector_state IS NULL OR j.vector_state<>'indexed' \
         OR j.vector_target IS NULL OR j.vector_target<>",
    );
    sql.push_bind(target)
        .push(" OR COALESCE(BINARY JSON_UNQUOTE(JSON_EXTRACT(j.vector_receipt,'$.projection_version'))=BINARY ")
        .push_bind(crate::types::KNOWLEDGE_PROJECTION)
        .push(",FALSE)=FALSE)");
    let incomplete: i64 = sql.build_query_scalar().fetch_one(tx.connection()).await?;
    Ok(if incomplete > 0 {
        "incomplete"
    } else {
        "current"
    })
}

pub async fn index_rebuild_receipt_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    operation: &str,
) -> Result<Option<Value>> {
    Ok(sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
        "SELECT receipt FROM knowledge_index_rebuilds WHERE space_id=? AND owner_id=? AND operation_id=?",
    )
    .bind(&ctx.space_id)
    .bind(&ctx.user_id)
    .bind(operation)
    .fetch_optional(tx.connection())
    .await?
    .map(|receipt| receipt.0))
}

pub async fn rebuild_index_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    target: &str,
    operation: &str,
) -> Result<(Value, bool)> {
    let receipt =
        json!({"operation_id":operation,"resource_id":target,"version":"1","state":"queued"});
    let created=sqlx::query("INSERT IGNORE INTO knowledge_index_rebuilds(space_id,owner_id,operation_id,target,receipt) VALUES(?,?,?,?,?)").bind(&ctx.space_id).bind(&ctx.user_id).bind(operation).bind(target).bind(sqlx::types::Json(&receipt)).execute(tx.connection()).await?;
    if created.rows_affected() == 0 {
        let row=sqlx::query("SELECT target,receipt FROM knowledge_index_rebuilds WHERE space_id=? AND owner_id=? AND operation_id=? FOR UPDATE").bind(&ctx.space_id).bind(&ctx.user_id).bind(operation).fetch_one(tx.connection()).await?;
        if row.get::<String, _>("target") != target {
            return Err(Error::new("idempotency_conflict"));
        }
        return Ok((row.get::<sqlx::types::Json<Value>, _>("receipt").0, false));
    }
    let objects = sqlx::query(
        "SELECT id,version FROM knowledge_objects WHERE space_id=? ORDER BY id FOR UPDATE",
    )
    .bind(&ctx.space_id)
    .fetch_all(tx.connection())
    .await?;
    if !objects.is_empty() {
        let mut query = sqlx::QueryBuilder::<sqlx::MySql>::new(
            "INSERT INTO knowledge_index_jobs(target_kind,object_id,version,state,vector_target) ",
        );
        query.push_values(&objects, |mut values, row| {
            values
                .push_bind("knowledge_entry")
                .push_bind(row.get::<String, _>("id"))
                .push_bind(row.get::<u64, _>("version"))
                .push_bind("pending")
                .push_bind(target);
        });
        query.push(" ON DUPLICATE KEY UPDATE state='pending',vector_state='pending',vector_target=VALUES(vector_target),vector_attempts=0,vector_error=NULL,vector_receipt=NULL,lease_until=NULL,lease_epoch=lease_epoch+1");
        query.build().execute(tx.connection()).await?;
    }
    Ok((receipt, true))
}

pub async fn rebuild_source_index_in_tx(
    tx: &mut AppTx<'_>,
    space: &str,
    source: &crate::contracts::generated::SourceKey,
    revision: u64,
    target: &str,
) -> Result<()> {
    // 仅重建owner确认的当前来源；首次移交不抹原次数，冻结配置不随集合改变。
    sqlx::query(
        "UPDATE knowledge_index_jobs SET state='pending',vector_state='pending',\
         vector_attempts=IF(vector_target IS NULL,vector_attempts,0),vector_target=?,\
         vector_error=NULL,vector_receipt=NULL,lease_until=NULL,lease_epoch=lease_epoch+1 \
         WHERE target_kind='source_excerpt' AND space_id=? AND source_kind=? AND object_id=? AND version=? \
         AND (lease_until IS NULL OR lease_until<=UTC_TIMESTAMP(3))",
    )
    .bind(target)
    .bind(space)
    .bind(source_kind_label(source))
    .bind(&source.id)
    .bind(revision)
    .execute(tx.connection())
    .await?;
    Ok(())
}

async fn validate_document_metadata(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    input: &Value,
) -> Result<()> {
    for r in input["related_ids"].as_array().into_iter().flatten() {
        read_in_tx(
            tx,
            ctx,
            r.as_str().ok_or(Error::new("invalid_input"))?,
            None,
            true,
        )
        .await?;
    }
    if let Some(url) = input["source_url"].as_str() {
        let parsed = reqwest::Url::parse(url).map_err(|_| Error::new("invalid_input"))?;
        if !matches!(parsed.scheme(), "https" | "http") {
            return Err(Error::new("invalid_input"));
        }
    }
    Ok(())
}

// 管理目录有界分页，不能把任意截断当成整个空间。
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
    let rows = sqlx::query("SELECT body FROM knowledge_objects FORCE INDEX(PRIMARY) WHERE space_id=? AND state<>'deleted' AND (? IS NULL OR state=?) AND (? IS NULL OR id>?) AND (? IS NULL OR INSTR(LOWER(name),LOWER(?))>0) AND (? IS NULL OR JSON_CONTAINS(CAST(? AS JSON),JSON_QUOTE(id))) AND (?=0 OR JSON_UNQUOTE(JSON_EXTRACT(body,'$.kind')) NOT IN ('field','relationship')) ORDER BY id LIMIT 101")
        .bind(&ctx.space_id).bind(state).bind(state).bind(after).bind(after)
        .bind(name).bind(name).bind(&ids).bind(&ids).bind(grouped).fetch_all(tx.connection()).await?;
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
    let rows=sqlx::query("SELECT body FROM knowledge_objects FORCE INDEX(PRIMARY) WHERE space_id=? AND state<>'deleted' AND (? IS NULL OR id>?) AND (? IS NULL OR JSON_CONTAINS(JSON_EXTRACT(body,'$.related_ids'),JSON_QUOTE(?))) ORDER BY id LIMIT 101")
        .bind(&ctx.space_id).bind(after).bind(after).bind(related).bind(related).fetch_all(tx.connection()).await?;
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
    include_raw: bool,
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
         entry_rows AS (SELECT k.id,k.version,k.name,k.kind,k.source_id, \
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
           WHERE (e.kind='document' OR COALESCE(m.aligned,FALSE)=FALSE)",
    )
    .push(if include_raw { " AND (e.kind<>'document' OR e.source_id IS NOT NULL) " } else { " " })
    .push(
        "UNION ALL SELECT s.id,s.version,s.name,s.kind,s.entry_id,s.path,s.statement_id,s.label,s.is_query_example,s.question,s.parameters, \
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
    .push(if include_raw { "TRUE" } else { "statement_id IS NULL" })
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

// 范围∩启停的头清单（05接续）：v1硬范围与对象启停在同一入口换算为允许记录集，
// 范围约束经JSON_TABLE在库内判定，不把body拉回应用。
pub async fn scoped_enabled_heads_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    scope: &crate::search_scope::KnowledgeSearchScope,
) -> Result<Vec<(String, u64)>> {
    let mut sql = sqlx::QueryBuilder::<sqlx::MySql>::new(
        "SELECT id,version FROM knowledge_objects WHERE space_id=",
    );
    sql.push_bind(&ctx.space_id).push(" AND state='enabled'");
    scope.push_constraints(&mut sql, "id", "kind", "body");
    sql.push(" ORDER BY id");
    let rows = sql
        .build_query_as::<(String, u64)>()
        .fetch_all(tx.connection())
        .await?;
    Ok(rows)
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
    let mut sql =
        sqlx::QueryBuilder::<sqlx::MySql>::new("SELECT id FROM knowledge_objects WHERE space_id=");
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
    sql.push(" ORDER BY id LIMIT ")
        .push_bind(limit.min(31) as u32);
    Ok(sql.build_query_scalar().fetch_all(tx.connection()).await?)
}

// 候选按≤50分批只下行元信息与软排序匹配数；域/关联复用已发布范围规则，
// 在owner内计算布尔匹配，不为排序装配候选正文，也不把提示写进WHERE过滤候选。
pub async fn candidate_meta_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    ids: &[String],
    hints: Option<&crate::contracts::generated::Hints>,
) -> Result<Vec<Value>> {
    let mut values = Vec::new();
    for chunk in ids.chunks(50) {
        let mut query = sqlx::QueryBuilder::<sqlx::MySql>::new(
            "SELECT k.id,k.name,k.version,k.state,k.kind,k.source_id,k.source_version,(0",
        );
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
        for row in query.build().fetch_all(tx.connection()).await? {
            let source_id: Option<String> = row.get("source_id");
            values.push(json!({
                "id":row.get::<String,_>("id"),
                "name":row.get::<String,_>("name"),
                "version":row.get::<u64,_>("version").to_string(),
                "state":row.get::<String,_>("state"),
                "kind":row.get::<String,_>("kind"),
                "source_id":source_id,
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
pub async fn read_structure_refs_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
    version: u64,
) -> Result<Value> {
    read_selected_structure_in_tx(tx, ctx, object, version, None).await
}

pub async fn read_selected_structure_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
    version: u64,
    path: Option<&str>,
) -> Result<Value> {
    let head = sqlx::query("SELECT kind,name,version,JSON_EXTRACT(body,'$.related_ids') AS related_ids FROM knowledge_objects WHERE id=? AND space_id=? AND state='enabled'")
        .bind(object).bind(&ctx.space_id).fetch_optional(tx.connection()).await?.ok_or(Error::new("not_available"))?;
    if head.get::<u64, _>("version") != version {
        return Err(Error::new("stale_knowledge"));
    }
    let path = path.filter(|path| !path.is_empty());
    let entries = sqlx::query_scalar::<_,sqlx::types::Json<Value>>(
        "SELECT JSON_OBJECT('entry_id',JSON_EXTRACT(e,'$.entry_id'),'path',JSON_EXTRACT(e,'$.path'),
          'source_facts',JSON_OBJECT('source_id',JSON_EXTRACT(e,'$.source_facts.source_id'),'version',JSON_EXTRACT(e,'$.source_facts.version'),
            'structured_evidence',JSON_EXTRACT(e,'$.source_facts.structured_evidence')),
          'suggestion',JSON_OBJECT('evidence',JSON_EXTRACT(e,'$.suggestion.evidence'),'material_refs',JSON_EXTRACT(e,'$.suggestion.material_refs')),
          'human_override',IF(JSON_TYPE(JSON_EXTRACT(e,'$.human_override'))='OBJECT',JSON_OBJECT('present',TRUE),NULL),
          'effective_structure',CASE WHEN JSON_TYPE(JSON_EXTRACT(e,'$.human_override'))='OBJECT' THEN JSON_EXTRACT(e,'$.human_override.structured_value')
            WHEN JSON_TYPE(JSON_EXTRACT(e,'$.suggestion.value'))='STRING' THEN JSON_EXTRACT(e,'$.suggestion.structured_value') ELSE JSON_EXTRACT(e,'$.source_facts.structured_value') END)
         FROM knowledge_objects v,JSON_TABLE(v.body,'$.entries[*]' COLUMNS(e JSON PATH '$')) j
         WHERE v.id=? AND v.version=? AND (? IS NULL OR BINARY JSON_UNQUOTE(JSON_EXTRACT(e,'$.entry_id'))=BINARY ? OR BINARY JSON_UNQUOTE(JSON_EXTRACT(e,'$.path'))=BINARY ?)")
        .bind(object).bind(version).bind(path).bind(path).bind(path).fetch_all(tx.connection()).await?;
    if path.is_some() && entries.len() != 1 {
        return Err(Error::new("invalid_evidence"));
    }
    Ok(
        json!({"id":object,"kind":head.get::<String,_>("kind"),"name":head.get::<String,_>("name"),
        "version":version.to_string(),"related_ids":head.get::<Option<sqlx::types::Json<Value>>,_>("related_ids").map(|v|v.0).unwrap_or(json!([])),
        "entries":entries.into_iter().map(|v|v.0).collect::<Vec<_>>()}),
    )
}

pub(super) async fn read_table_binding_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
    version: Option<u64>,
) -> Result<Value> {
    let row = sqlx::query(
        "SELECT o.id,o.kind,o.name,o.version,
           (SELECT JSON_UNQUOTE(JSON_EXTRACT(j.entry,'$.effective_value'))
            FROM JSON_TABLE(o.body,'$.entries[*]' COLUMNS(entry JSON PATH '$')) j
            WHERE JSON_UNQUOTE(JSON_EXTRACT(j.entry,'$.path'))='ddl' LIMIT 1) AS ddl
         FROM knowledge_objects o WHERE o.id=? AND o.space_id=? AND o.state='enabled'",
    )
    .bind(object)
    .bind(&ctx.space_id)
    .fetch_optional(tx.connection())
    .await?
    .ok_or(Error::new("not_available"))?;
    if version.is_some_and(|version| row.get::<u64, _>("version") != version) {
        return Err(Error::new("stale_knowledge"));
    }
    if row.get::<String, _>("kind") != "table" {
        return Err(Error::new("invalid_input"));
    }
    Ok(json!({
        "id":object,"kind":"table","name":row.get::<String,_>("name"),
        "version":row.get::<u64,_>("version").to_string(),
        "entries":[{"path":"ddl","effective_value":row.get::<Option<String>,_>("ddl")}],
    }))
}

pub(super) async fn original_table_ddl_in_tx(
    tx: &mut AppTx<'_>,
    object: &str,
    version: u64,
) -> Result<Option<String>> {
    Ok(sqlx::query_scalar::<_,Option<String>>("SELECT JSON_UNQUOTE(JSON_EXTRACT(e,'$.effective_value')) FROM (SELECT body FROM knowledge_objects WHERE id=? AND version=? UNION ALL SELECT body FROM knowledge_versions WHERE object_id=? AND version=?) o,JSON_TABLE(o.body,'$.entries[*]' COLUMNS(e JSON PATH '$')) j WHERE JSON_UNQUOTE(JSON_EXTRACT(e,'$.path'))='ddl' LIMIT 1")
        .bind(object).bind(version).bind(object).bind(version).fetch_optional(tx.connection()).await?.flatten())
}

pub(super) async fn field_binding_source_in_tx(
    tx: &mut AppTx<'_>,
    object: &str,
    version: u64,
) -> Result<Option<Value>> {
    Ok(sqlx::query_scalar::<_,Option<sqlx::types::Json<Value>>>("SELECT JSON_EXTRACT(j.e,'$.source_facts') FROM knowledge_objects o,JSON_TABLE(o.body,'$.entries[*]' COLUMNS(e JSON PATH '$')) j WHERE o.id=? AND o.version=? AND JSON_UNQUOTE(JSON_EXTRACT(j.e,'$.path'))='type'")
        .bind(object).bind(version).fetch_optional(tx.connection()).await?.flatten().map(|v|v.0))
}

pub async fn current_versions_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    ids: &[String],
) -> Result<std::collections::HashMap<(String, String), bool>> {
    // 检索在锁外读取后，提交前按(id,version)核对对象是否仍为当前有效版本。
    let mut result = std::collections::HashMap::new();
    for chunk in ids.chunks(500) {
        let mut query = sqlx::QueryBuilder::<sqlx::MySql>::new(
            "SELECT JSON_UNQUOTE(JSON_EXTRACT(body,'$.id')) AS object_id, JSON_UNQUOTE(JSON_EXTRACT(body,'$.version')) AS object_version, state FROM knowledge_objects WHERE space_id=",
        );
        query.push_bind(&ctx.space_id).push(" AND id IN (");
        let mut keys = query.separated(",");
        for id in chunk {
            keys.push_bind(id);
        }
        query.push(")");
        for row in query.build().fetch_all(tx.connection()).await? {
            result.insert(
                (
                    row.get::<String, _>("object_id"),
                    row.get::<String, _>("object_version"),
                ),
                row.get::<String, _>("state") == "enabled",
            );
        }
    }
    Ok(result)
}

// 返回本次实际置为disabled的对象（已按保存路径投影）；调用方据此执行保存后组合。
pub async fn retire_source_objects_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    source: &str,
    keep: &std::collections::HashSet<String>,
) -> Result<Vec<Value>> {
    // 来源头已由同步事务核对；先取候选，再按对象主键锁定，避免范围扫描锁住其他来源。
    let objects: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM knowledge_objects WHERE space_id=? AND source_id=? ORDER BY id",
    )
    .bind(&ctx.space_id)
    .bind(source)
    .fetch_all(tx.connection())
    .await?;
    let mut retired = Vec::new();
    for object_id in objects {
        if keep.contains(&object_id) {
            continue;
        }
        let Some(object) = sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
            "SELECT body FROM knowledge_objects WHERE id=? AND space_id=? AND source_id=? AND state='enabled' FOR UPDATE",
        )
        .bind(&object_id).bind(&ctx.space_id).bind(source).fetch_optional(tx.connection()).await? else {
            continue;
        };
        let mut object = object.0;
        object["state"] = json!("disabled");
        object["state_origin"] = json!("platform");
        for entry in object["entries"].as_array_mut().into_iter().flatten() {
            entry["review_state"] = json!("needs_review");
        }
        next(&mut object, ctx);
        persist(tx, ctx, &object, &["*"]).await?;
        super::structure::project_object(&mut object);
        super::preparation::project_object(&mut object);
        retired.push(object);
    }
    Ok(retired)
}

// 先核对当前知识与领取代次，再读回冻结维护预算；首次冻结由
// freeze_index_embedding_in_tx在同一事务内完成，重试不能从新环境配置补额。
pub async fn bound_index_embedding_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    job: &Value,
) -> Result<Option<Value>> {
    let object = read_in_tx(
        tx,
        ctx,
        job["object_id"].as_str().unwrap_or(""),
        None,
        false,
    )
    .await?;
    if object["version"] != job["job_version"] {
        return Err(Error::new("version_conflict"));
    }
    let row=sqlx::query("SELECT embedding_profile,lease_epoch,vector_state,lease_until>UTC_TIMESTAMP(3) AS valid FROM knowledge_index_jobs WHERE target_kind='knowledge_entry' AND source_kind='' AND object_id=? AND version=? FOR UPDATE")
        .bind(job["object_id"].as_str()).bind(epoch(job["job_version"].as_str().unwrap_or("0"))?).fetch_one(tx.connection()).await?;
    if row.get::<String, _>("vector_state") != "sending"
        || row.get::<u64, _>("lease_epoch").to_string() != job["lease_epoch"].as_str().unwrap_or("")
        || row.get::<i64, _>("valid") != 1
    {
        return Err(Error::new("lease_lost"));
    }
    // 云端长文分批处理：仅续接尚有效的同代租约，过期领取不能复活。
    // 目标判别进入条件：同表还承载原文目标，同ID不同目标不能互改租约或冻结档。
    sqlx::query("UPDATE knowledge_index_jobs SET lease_until=TIMESTAMPADD(SECOND,120,UTC_TIMESTAMP(3)) WHERE target_kind='knowledge_entry' AND source_kind='' AND object_id=? AND version=?")
        .bind(job["object_id"].as_str()).bind(epoch(job["job_version"].as_str().unwrap_or("0"))?).execute(tx.connection()).await?;
    Ok(row
        .get::<Option<sqlx::types::Json<Value>>, _>("embedding_profile")
        .map(|v| v.0))
}
pub async fn freeze_index_embedding_in_tx(
    tx: &mut AppTx<'_>,
    job: &Value,
    profile: &Value,
) -> Result<()> {
    sqlx::query(
        "UPDATE knowledge_index_jobs SET embedding_profile=? WHERE target_kind='knowledge_entry' AND source_kind='' AND object_id=? AND version=?",
    )
    .bind(sqlx::types::Json(profile))
    .bind(job["object_id"].as_str())
    .bind(epoch(job["job_version"].as_str().unwrap_or("0"))?)
    .execute(tx.connection())
    .await?;
    Ok(())
}

pub async fn proposal_in_tx(tx: &mut AppTx<'_>, ctx: &AccessContext, id: &str) -> Result<Value> {
    let row = sqlx::query(
        "SELECT body FROM semantic_change_proposals WHERE id=? AND owner_id=? AND space_id=?",
    )
    .bind(id)
    .bind(&ctx.user_id)
    .bind(&ctx.space_id)
    .fetch_optional(tx.connection())
    .await?
    .ok_or(Error::new("not_available"))?;
    Ok(body(&row))
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

pub async fn index_progress_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    objects: &[String],
) -> Result<Value> {
    let (mut total, mut complete, mut failed) = (0u64, 0u64, 0u64);
    for id in objects {
        let row=sqlx::query("SELECT j.state,j.vector_state FROM knowledge_objects k LEFT JOIN knowledge_index_jobs j ON j.object_id=k.id AND j.target_kind='knowledge_entry' AND j.source_kind='' AND j.version=k.version WHERE k.id=? AND k.space_id=? AND k.state='enabled'").bind(id).bind(&ctx.space_id).fetch_optional(tx.connection()).await?;
        let Some(row) = row else { continue };
        total += 1;
        let state = row.get::<Option<String>, _>("state");
        let vector = row.get::<Option<String>, _>("vector_state");
        if state.as_deref() == Some("indexed") && vector.as_deref() == Some("indexed") {
            complete += 1;
        }
        if vector.as_deref() == Some("failed") {
            failed += 1;
        }
    }
    Ok(
        json!({"status":if total==0{"not_required"}else if failed>0{"failed"}else if complete==total{"completed"}else{"pending"},"total":total,"completed":complete,"failed":failed}),
    )
}

#[cfg(test)]
mod identity_filter_tests {
    use sqlx::Execute;
    #[test]
    fn identity_filter_sql_shape() {
        let mut builder = sqlx::QueryBuilder::<sqlx::MySql>::new("SELECT 1");
        super::push_identity_filter(
            &mut builder,
            &[("a".into(), "b".into(), 1), ("c".into(), "d".into(), 2)],
        );
        let query = builder.build();
        assert_eq!(
            query.sql(),
            "SELECT 1 AND (source_kind,object_id,version) IN ((?,?,?),(?,?,?))",
            "生成的SQL文本"
        );
    }

    #[test]
    fn narrow_entry_selection_sql_shape() {
        // 05切片2：entry_id提示与词条INSTR的OR组合，绑定次序与文本一致。
        let mut selected = sqlx::QueryBuilder::<sqlx::MySql>::new(
            "SELECT j.entry FROM knowledge_versions v, JSON_TABLE(v.body,'$.entries[*]' COLUMNS(entry JSON PATH '$')) j WHERE v.object_id=",
        );
        selected
            .push_bind("probe")
            .push(" AND v.version=")
            .push_bind(1u64)
            .push(" AND (");
        selected.push("JSON_UNQUOTE(JSON_EXTRACT(j.entry,'$.entry_id')) IN (");
        let mut keys = selected.separated(",");
        keys.push_bind("a".to_owned());
        keys.push_bind("b".to_owned());
        selected.push(")");
        selected.push(" OR ");
        let mut terms = selected.separated(" OR ");
        terms
            .push("INSTR(LOWER(CAST(j.entry AS CHAR)),")
            .push_bind_unseparated("词".to_owned())
            .push_unseparated(")>0");
        selected.push(")");
        let query = selected.build();
        assert_eq!(
            query.sql(),
            "SELECT j.entry FROM knowledge_versions v, JSON_TABLE(v.body,'$.entries[*]' COLUMNS(entry JSON PATH '$')) j WHERE v.object_id=? AND v.version=? AND (JSON_UNQUOTE(JSON_EXTRACT(j.entry,'$.entry_id')) IN (?,?) OR INSTR(LOWER(CAST(j.entry AS CHAR)),?)>0)",
            "生成的SQL文本"
        );
    }
}

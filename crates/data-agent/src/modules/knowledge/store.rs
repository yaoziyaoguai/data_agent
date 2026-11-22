#[path = "storage/documents/store.rs"]
mod documents;
use documents::validate_document_metadata;
pub use documents::{document_parts_in_tx, save_document_in_tx};
#[path = "storage/entry_read/store.rs"]
mod entry_read;
pub use entry_read::{
    read_entries_in_tx, read_entry_page_in_tx, read_support_content_in_tx, read_supports_in_tx,
};
#[path = "storage/source_read/store.rs"]
mod source_read;
pub use source_read::{
    DocumentWindows, locate_document_quote_in_tx, read_document_windows_in_tx,
    read_source_fact_quote_in_tx, source_fact_refs_in_tx, source_objects_in_tx,
    source_reference_objects_in_tx, source_tables_in_tx,
};
#[path = "storage/entry_write/store.rs"]
mod entry_write;
pub use entry_write::{
    apply_entry_in_tx, begin_entry_batch_in_tx, lock_entry_batch_in_tx, persist_entry_batch_in_tx,
    record_entry_batch_in_tx,
};
pub use entry_write::{
    begin_create_in_tx, begin_edit_in_tx, begin_reanalysis_in_tx, change_state_in_tx, create_in_tx,
    reanalyze_in_tx, save_edit_in_tx,
};
#[path = "storage/proposals/store.rs"]
mod proposals;
pub use proposals::{apply_proposal_in_tx, proposal_in_tx, proposals_in_tx, propose_in_tx};
#[path = "storage/index_jobs/store.rs"]
mod index_jobs;
pub use index_jobs::{
    bound_index_embedding_in_tx, bound_source_index_embedding_in_tx, claim_index_batch_in_tx,
    claim_source_index_in_tx, finish_index_in_tx, freeze_index_embedding_in_tx,
    freeze_source_index_embedding_in_tx, index_coverage_in_tx, index_progress_in_tx,
    index_rebuild_receipt_in_tx, platform_source_index_progress_in_tx, rebuild_index_in_tx,
    rebuild_source_index_in_tx, register_source_index_target_in_tx, renew_source_index_lease_in_tx,
    source_index_heads_in_tx,
};
#[path = "storage/catalog_search/store.rs"]
mod catalog_search;
pub(crate) use catalog_search::push_workspace_dependency_heads;
pub use catalog_search::{
    candidate_meta_in_tx, current_enabled_heads_in_tx, directory_page_in_tx,
    identity_candidate_ids_in_tx, independent_document_candidate_in_tx,
    independent_document_heads_in_tx, matching_content_in_tx, matching_in_tx,
    matching_scoped_in_tx, page_in_tx, scoped_enabled_heads_in_tx,
};
#[path = "storage/catalog_bindings/store.rs"]
mod catalog_bindings;
pub use catalog_bindings::{
    current_versions_in_tx, read_selected_structure_in_tx, read_structure_refs_in_tx,
    retire_source_objects_in_tx,
};
pub(super) use catalog_bindings::{
    field_binding_source_in_tx, original_table_ddl_in_tx, read_table_binding_in_tx,
};

use crate::{
    persistence::{AppTx, receipts::Operation},
    types::{AccessContext, Error, Result, epoch, fingerprint, id},
};
use serde_json::{Value, json};
use sqlx::Row;

const DIRECT_TABLE_ID: &str = "JSON_UNQUOTE(JSON_EXTRACT(\
    JSON_EXTRACT(k.body,'$.entries[*].effective_structure.table.object_id'),'$[0]')) AS table_id";

// k 是具有 id、kind、source_id、space_id、body 的正式对象行。关联字段使用同一平台表集合。
pub(super) fn push_table_access(sql: &mut sqlx::QueryBuilder<sqlx::MySql>, ctx: &AccessContext) {
    let Some(access) = &ctx.table_access else {
        return;
    };
    let table_bindings = |alias| {
        format!(
            "\
        COALESCE(JSON_EXTRACT({alias}.body,'$.related_ids'),JSON_ARRAY()),\
        COALESCE(JSON_EXTRACT({alias}.body,'$.entries[*].effective_structure.table.object_id'),JSON_ARRAY()),\
        COALESCE(JSON_EXTRACT({alias}.body,'$.entries[*].effective_structure.left_table.object_id'),JSON_ARRAY()),\
        COALESCE(JSON_EXTRACT({alias}.body,'$.entries[*].effective_structure.right_table.object_id'),JSON_ARRAY())"
        )
    };
    sql.push(" AND (k.kind<>'table' OR JSON_CONTAINS(")
        .push_bind(sqlx::types::Json(&access.table_ids))
        .push(",JSON_QUOTE(k.id))) AND (k.source_id IS NULL OR k.source_id NOT LIKE 'catalog-%' OR JSON_CONTAINS(")
        .push_bind(sqlx::types::Json(&access.source_ids))
        .push(",JSON_QUOTE(k.source_id))) AND ((k.kind='document' AND k.source_id IS NULL) OR NOT EXISTS(SELECT 1 FROM JSON_TABLE(JSON_MERGE_PRESERVE(")
        .push(table_bindings("k"))
        .push(",\
            COALESCE(JSON_EXTRACT(k.body,'$.entries[*].effective_structure.dependencies[*].object_id'),JSON_ARRAY()),\
            COALESCE(JSON_EXTRACT(k.body,'$.entries[*].effective_structure.computed_metrics[*].metric_ref.object_id'),JSON_ARRAY()),\
            COALESCE(JSON_EXTRACT(k.body,'$.entries[*].effective_structure.verification.evidence_refs[*].object_id'),JSON_ARRAY())),\
            '$[*]' COLUMNS(object_id VARCHAR(64) PATH '$')) refs \
            JOIN knowledge_objects t ON t.id=refs.object_id AND t.space_id=k.space_id \
            WHERE (t.kind='table' AND NOT JSON_CONTAINS(")
        .push_bind(sqlx::types::Json(&access.table_ids))
        .push(",JSON_QUOTE(t.id))) OR (t.kind IN ('field','metric','relationship') AND (\
            (t.source_id LIKE 'catalog-%' AND NOT JSON_CONTAINS(")
        .push_bind(sqlx::types::Json(&access.source_ids))
        .push(",JSON_QUOTE(t.source_id))) OR EXISTS(SELECT 1 FROM JSON_TABLE(JSON_MERGE_PRESERVE(")
        .push(table_bindings("t"))
        .push("),'$[*]' COLUMNS(object_id VARCHAR(64) PATH '$')) bound \
            JOIN knowledge_objects p ON p.id=bound.object_id AND p.space_id=t.space_id \
            WHERE p.kind='table' AND NOT JSON_CONTAINS(")
        .push_bind(sqlx::types::Json(&access.table_ids))
        .push(",JSON_QUOTE(p.id)))))))");
}

pub async fn check_read_access_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
) -> Result<()> {
    if ctx.table_access.is_none() {
        return Ok(());
    }
    let mut sql = sqlx::QueryBuilder::<sqlx::MySql>::new(
        "SELECT 1 FROM knowledge_objects k WHERE k.space_id=",
    );
    sql.push_bind(&ctx.space_id)
        .push(" AND k.id=")
        .push_bind(object);
    push_table_access(&mut sql, ctx);
    sql.build_query_scalar::<i32>()
        .fetch_optional(tx.connection())
        .await?
        .ok_or(Error::new("not_available"))
        .map(|_| ())
}

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
    Operation::new(ctx, "knowledge", key, value)
        .begin_with(tx, |stored, receipt| {
            value["action"] == "reanalyze"
                && !receipt.is_null()
                && stored == fingerprint(
                    &json!({"object_id":value["object_id"],"input":value["input"],"source_version":receipt["source_version"]}),
                )
        })
        .await
}

pub(super) async fn record(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    key: &str,
    input: &Value,
    value: &Value,
) -> Result<()> {
    Operation::new(ctx, "knowledge", key, input)
        .complete(tx, value)
        .await
}

pub(super) async fn persist(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    v: &Value,
    changed_paths: &[&str],
) -> Result<()> {
    persist_object(tx, ctx, v, changed_paths, true).await
}

async fn persist_object(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    v: &Value,
    changed_paths: &[&str],
    queue_index: bool,
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
    let value_fingerprint = fingerprint(&v);
    let previous = if queue_index {
        sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
            "SELECT body FROM knowledge_objects WHERE id=? AND space_id=?",
        )
        .bind(v["id"].as_str())
        .bind(&ctx.space_id)
        .fetch_optional(tx.connection())
        .await?
        .map(|value| value.0)
    } else {
        None
    };
    sqlx::query("INSERT INTO knowledge_objects(id,space_id,kind,name,version,state,body,source_id,source_version,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name),version=VALUES(version),state=VALUES(state),body=VALUES(body),source_version=VALUES(source_version),updated_by=VALUES(updated_by)")
 .bind(v["id"].as_str()).bind(&ctx.space_id).bind(v["kind"].as_str()).bind(v["name"].as_str()).bind(version).bind(v["state"].as_str()).bind(sqlx::types::Json(&v)).bind(v["source_id"].as_str()).bind(epoch(v["source_version"].as_str().unwrap_or("0"))?).bind(&ctx.user_id).execute(tx.connection()).await?;
    if queue_index
        && previous
            .as_ref()
            .is_none_or(|old| fingerprint(old) != value_fingerprint)
    {
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
    } else if queue_index {
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
    sqlx::query("INSERT INTO knowledge_revisions(object_id,version,updated_by,fingerprint,changed_paths,archived_body) VALUES(?,?,?,?,?,?) ON DUPLICATE KEY UPDATE updated_by=VALUES(updated_by),fingerprint=VALUES(fingerprint),changed_paths=VALUES(changed_paths),archived_body=COALESCE(knowledge_revisions.archived_body,VALUES(archived_body))")
        .bind(v["id"].as_str())
        .bind(version)
        .bind(&ctx.user_id)
        .bind(&value_fingerprint)
        .bind(sqlx::types::Json(changed_paths))
        .bind(retain_archive.then_some(sqlx::types::Json(&v)))
        .execute(tx.connection())
        .await?;
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
    let mut sql =
        sqlx::QueryBuilder::new("SELECT k.body,k.state FROM knowledge_objects k WHERE k.id=");
    sql.push_bind(object)
        .push(" AND k.space_id=")
        .push_bind(&ctx.space_id);
    push_table_access(&mut sql, ctx);
    let row = sql
        .build()
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
        return archived_revision_in_tx(tx, ctx, object, version)
            .await?
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
    check_read_access_in_tx(tx, ctx, object).await?;
    let body = sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
        "SELECT body FROM knowledge_objects WHERE id=? AND version=? AND space_id=?",
    )
    .bind(object)
    .bind(version)
    .bind(&ctx.space_id)
    .fetch_optional(tx.connection())
    .await?;
    match body {
        Some(sqlx::types::Json(mut value)) => {
            super::structure::project_object(&mut value);
            Ok(Some(value))
        }
        None => archived_revision_in_tx(tx, ctx, object, version).await,
    }
}

async fn archived_revision_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
    version: u64,
) -> Result<Option<Value>> {
    // 同一个指标改版后可换底表，旧正文按旧绑定核当前用户的表集合。
    let mut sql = sqlx::QueryBuilder::new(
        "SELECT k.body FROM (SELECT o.id,o.space_id,o.kind,v.archived_body AS body, \
         NULLIF(JSON_UNQUOTE(JSON_EXTRACT(v.archived_body,'$.source_id')),'null') AS source_id \
         FROM knowledge_revisions v JOIN knowledge_objects o ON o.id=v.object_id \
         WHERE v.archived_body IS NOT NULL AND v.object_id=",
    );
    sql.push_bind(object)
        .push(" AND v.version=")
        .push_bind(version)
        .push(" AND o.space_id=")
        .push_bind(&ctx.space_id)
        .push(") k WHERE TRUE");
    push_table_access(&mut sql, ctx);
    let row = sql
        .build_query_scalar::<sqlx::types::Json<Value>>()
        .fetch_optional(tx.connection())
        .await?;
    Ok(row.map(|sqlx::types::Json(mut value)| {
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
    let mut sql = sqlx::QueryBuilder::new(
        "SELECT k.state, \
         JSON_UNQUOTE(JSON_EXTRACT(k.body,'$.name')) AS name, \
         JSON_UNQUOTE(JSON_EXTRACT(k.body,'$.kind')) AS kind, \
         JSON_UNQUOTE(JSON_EXTRACT(k.body,'$.version')) AS version, \
         JSON_LENGTH(JSON_EXTRACT(k.body,'$.entries[*].effective_value')) AS effective \
         FROM knowledge_objects k WHERE k.id=",
    );
    sql.push_bind(object)
        .push(" AND k.space_id=")
        .push_bind(&ctx.space_id);
    push_table_access(&mut sql, ctx);
    let row = sql
        .build()
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
pub async fn read_revision_fingerprint_in_tx(
    tx: &mut AppTx<'_>,
    object: &str,
    version: u64,
) -> Result<String> {
    let row =
        sqlx::query("SELECT fingerprint FROM knowledge_revisions WHERE object_id=? AND version=? AND fingerprint IS NOT NULL")
            .bind(object)
            .bind(version)
            .fetch_optional(tx.connection())
            .await?;
    Ok(row
        .map(|row| row.get::<String, _>("fingerprint"))
        .unwrap_or_default())
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
pub(super) fn next(v: &mut Value, ctx: &AccessContext) -> Result<()> {
    let version = v["version"].as_str().ok_or(Error::new("unavailable"))?;
    v["version"] = json!((epoch(version)? + 1).to_string());
    v["updated_by"] = json!(ctx.user_id);
    Ok(())
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

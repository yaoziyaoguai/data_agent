use crate::{
    persistence::AppTx,
    types::{AccessContext, Error, Result, fingerprint},
};
use serde_json::{Value, json};
use sqlx::Row;

fn catalog_read(row: &sqlx::mysql::MySqlRow) -> Value {
    json!({"id":row.get::<String,_>("id"),"space_id":row.get::<String,_>("space_id"),"owner_id":row.get::<String,_>("owner_id"),
        "operation_id":row.get::<String,_>("operation_id"),"baseline":row.get::<sqlx::types::Json<Value>,_>("baseline").0,
        "namespace_baseline":row.get::<Option<sqlx::types::Json<Value>>,_>("namespace_baseline").map(|v|v.0).unwrap_or(json!({})),
        "status":row.get::<String,_>("state"),"background":row.get::<bool,_>("background"),
        "receipt":row.get::<Option<sqlx::types::Json<Value>>,_>("receipt").map(|v|v.0),"error_code":row.get::<Option<String>,_>("error_code"),
        "error_message":row.get::<Option<String>,_>("error_message"),
        "cursor":row.get::<Option<String>,_>("cursor_value"),"snapshot_id":row.get::<Option<String>,_>("snapshot_id"),
        "namespace":row.get::<Option<String>,_>("source_namespace"),"authoritative":row.get::<Option<bool>,_>("authoritative"),
        "processed_sources":row.get::<u64,_>("processed_sources"),"pages_committed":row.get::<u64,_>("pages_committed"),
        "directory_complete":row.get::<bool,_>("directory_complete")})
}
pub async fn catalog_read_in_tx(tx: &mut AppTx<'_>, id: &str) -> Result<Value> {
    let row = sqlx::query("SELECT * FROM catalog_imports WHERE id=?")
        .bind(id)
        .fetch_optional(tx.connection())
        .await?
        .ok_or(Error::new("not_available"))?;
    Ok(catalog_read(&row))
}
pub async fn begin_catalog_read_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    operation: &str,
) -> Result<Value> {
    sqlx::query("INSERT INTO source_sync_locks(space_id) VALUES(?) ON DUPLICATE KEY UPDATE space_id=VALUES(space_id)").bind(&ctx.space_id).execute(tx.connection()).await?;
    // 旧前台采集没有可恢复游标；新批次只认M10租约，不受旧截止时间误伤。
    sqlx::query("UPDATE catalog_imports SET state='failed',error_code='source_interrupted' WHERE space_id=? AND background=0 AND state='fetching' AND lease_until<UTC_TIMESTAMP(3)").bind(&ctx.space_id).execute(tx.connection()).await?;
    if let Some(row) = sqlx::query("SELECT * FROM catalog_imports WHERE space_id=? AND owner_id=? AND operation_id=? FOR UPDATE")
        .bind(&ctx.space_id).bind(&ctx.user_id).bind(operation).fetch_optional(tx.connection()).await? { return Ok(catalog_read(&row)); }
    let rows =
        sqlx::query("SELECT id,version FROM source_heads WHERE space_id=? ORDER BY id FOR UPDATE")
            .bind(&ctx.space_id)
            .fetch_all(tx.connection())
            .await?;
    let baseline: serde_json::Map<String, Value> = rows
        .iter()
        .map(|r| (r.get::<String, _>("id"), json!(r.get::<u64, _>("version"))))
        .collect();
    let rows = sqlx::query(
        "SELECT namespace,generation FROM catalog_namespace_heads WHERE space_id=? FOR UPDATE",
    )
    .bind(&ctx.space_id)
    .fetch_all(tx.connection())
    .await?;
    let namespaces: serde_json::Map<String, Value> = rows
        .iter()
        .map(|r| {
            (
                r.get::<String, _>("namespace"),
                json!(r.get::<u64, _>("generation")),
            )
        })
        .collect();
    let id = crate::types::id();
    sqlx::query("INSERT INTO catalog_imports(id,space_id,owner_id,operation_id,baseline,namespace_baseline,state,background) VALUES(?,?,?,?,?,?,'queued',1)")
        .bind(&id).bind(&ctx.space_id).bind(&ctx.user_id).bind(operation).bind(sqlx::types::Json(baseline)).bind(sqlx::types::Json(namespaces)).execute(tx.connection()).await?;
    let mut read = catalog_read_in_tx(tx, &id).await?;
    read["created"] = json!(true);
    Ok(read)
}
pub async fn check_catalog_read_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    read: &Value,
    namespace: &str,
) -> Result<()> {
    sqlx::query("SELECT space_id FROM source_sync_locks WHERE space_id=? FOR UPDATE")
        .bind(&ctx.space_id)
        .fetch_one(tx.connection())
        .await?;
    let active:i64=sqlx::query_scalar("SELECT COUNT(*) FROM catalog_imports WHERE id=? AND space_id=? AND background=1 AND state IN ('queued','running')").bind(read["id"].as_str()).bind(&ctx.space_id).fetch_one(tx.connection()).await?;
    if active != 1 {
        return Err(Error::new("source_interrupted"));
    }
    let generation:Option<u64>=sqlx::query_scalar("SELECT generation FROM catalog_namespace_heads WHERE space_id=? AND namespace=? FOR UPDATE").bind(&ctx.space_id).bind(namespace).fetch_optional(tx.connection()).await?;
    if generation.unwrap_or(0) != read["namespace_baseline"][namespace].as_u64().unwrap_or(0) {
        return Err(Error::new("version_conflict"));
    }
    Ok(())
}
pub async fn complete_catalog_namespace_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    read: &Value,
    namespace: &str,
) -> Result<()> {
    check_catalog_read_in_tx(tx, ctx, read, namespace).await?;
    sqlx::query("INSERT INTO catalog_namespace_heads(space_id,namespace,generation) VALUES(?,?,1) ON DUPLICATE KEY UPDATE generation=generation+1").bind(&ctx.space_id).bind(namespace).execute(tx.connection()).await?;
    Ok(())
}

pub async fn save_catalog_table_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    read: &Value,
    namespace: &str,
    table: &Value,
) -> Result<(u64, bool)> {
    check_catalog_read_in_tx(tx, ctx, read, namespace).await?;
    let source = super::catalog::source_id(
        &ctx.space_id,
        namespace,
        table["id"].as_str().ok_or(Error::new("invalid_input"))?,
    );
    let old = sqlx::query(
        "SELECT version,fingerprint FROM source_heads WHERE id=? AND space_id=? FOR UPDATE",
    )
    .bind(&source)
    .bind(&ctx.space_id)
    .fetch_optional(tx.connection())
    .await?;
    let actual = old.as_ref().map_or(0, |r| r.get::<u64, _>("version"));
    if actual != read["baseline"][&source].as_u64().unwrap_or(0) {
        return Err(Error::new("version_conflict"));
    }
    let platform_version = crate::types::epoch(table["platform_version"].as_str().unwrap_or(""))?;
    let previous: Option<u64> = sqlx::query_scalar(
        "SELECT platform_version FROM catalog_platform_heads WHERE source_id=? FOR UPDATE",
    )
    .bind(&source)
    .fetch_optional(tx.connection())
    .await?;
    let body = super::catalog::source_text(table);
    let (fp, _) = super::catalog_content::comparison(table);
    if previous.is_some_and(|v| platform_version < v) {
        return Err(Error::new("stale_source"));
    }
    // 比较方法升级时也用同一方法计算两份内容，不拿新旧算法hash判业务变化。
    let retained: Option<sqlx::types::Json<Value>> = sqlx::query_scalar(
        "SELECT body FROM catalog_table_snapshots WHERE source_id=? AND version=?",
    )
    .bind(&source)
    .bind(actual)
    .fetch_optional(tx.connection())
    .await?;
    let retired: Option<bool> =
        sqlx::query_scalar("SELECT retired FROM catalog_platform_heads WHERE source_id=?")
            .bind(&source)
            .fetch_optional(tx.connection())
            .await?;
    if retired != Some(true)
        && retained
            .as_ref()
            .is_some_and(|value| super::catalog_content::fingerprint(&value.0) == fp)
    {
        sqlx::query("UPDATE catalog_platform_heads SET platform_version=? WHERE source_id=?")
            .bind(platform_version)
            .bind(&source)
            .execute(tx.connection())
            .await?;
        let stored: String =
            sqlx::query_scalar("SELECT body FROM source_snapshots WHERE source_id=? AND version=?")
                .bind(&source)
                .bind(actual)
                .fetch_one(tx.connection())
                .await?;
        write_current_in_tx(
            tx,
            &ctx.space_id,
            &source,
            namespace,
            (actual, &stored, &retained.unwrap().0),
            table,
        )
        .await?;
        return Ok((actual, false));
    }
    let version = actual + 1;
    sqlx::query("INSERT INTO source_snapshots(source_id,version,body) VALUES(?,?,?)")
        .bind(&source)
        .bind(version)
        .bind(&body)
        .execute(tx.connection())
        .await?;
    sqlx::query("INSERT INTO source_heads(id,space_id,version,fingerprint) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE version=VALUES(version),fingerprint=VALUES(fingerprint)")
        .bind(&source).bind(&ctx.space_id).bind(version).bind(fp).execute(tx.connection()).await?;
    sqlx::query("INSERT INTO catalog_platform_heads(source_id,platform_version,namespace,platform_table_id) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE platform_version=VALUES(platform_version),namespace=VALUES(namespace),platform_table_id=VALUES(platform_table_id),retired=0").bind(&source).bind(platform_version).bind(namespace).bind(table["id"].as_str()).execute(tx.connection()).await?;
    sqlx::query(
        "INSERT INTO catalog_table_snapshots(source_id,version,namespace,body) VALUES(?,?,?,?)",
    )
    .bind(&source)
    .bind(version)
    .bind(namespace)
    .bind(sqlx::types::Json(table))
    .execute(tx.connection())
    .await?;
    write_current_in_tx(
        tx,
        &ctx.space_id,
        &source,
        namespace,
        (version, &body, table),
        table,
    )
    .await?;
    Ok((version, true))
}

pub async fn catalog_candidate_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    source: &str,
    object_id: &str,
) -> Result<Value> {
    let version = source_version_in_tx(tx, &ctx.space_id, source).await?;
    let row = sqlx::query(
        "SELECT namespace,body FROM catalog_table_snapshots WHERE source_id=? AND version=?",
    )
    .bind(source)
    .bind(version)
    .fetch_one(tx.connection())
    .await?;
    let table = row.get::<sqlx::types::Json<Value>, _>("body").0;
    super::catalog::objects(ctx, &row.get::<String, _>("namespace"), &table, version)?
        .into_iter()
        .find(|v| v["id"] == object_id)
        .ok_or(Error::new("not_available"))
}

pub async fn catalog_upstream_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    source: &str,
) -> Result<Vec<(String, String)>> {
    let version = source_version_in_tx(tx, &ctx.space_id, source).await?;
    let row = sqlx::query(
        "SELECT namespace,body FROM catalog_table_snapshots WHERE source_id=? AND version=?",
    )
    .bind(source)
    .bind(version)
    .fetch_optional(tx.connection())
    .await?;
    let Some(row) = row else {
        return Ok(vec![]);
    };
    let table = row.get::<sqlx::types::Json<Value>, _>("body").0;
    let namespace = row.get::<String, _>("namespace");
    Ok(table["node"]["upstream_ids"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|id| id.as_str())
        .map(|id| {
            (
                super::catalog::source_id(&ctx.space_id, &namespace, id),
                super::catalog::table_object_id(&ctx.space_id, &namespace, id),
            )
        })
        .collect())
}

pub async fn finish_catalog_read_in_tx(
    tx: &mut AppTx<'_>,
    read: &Value,
    receipt: Option<&Value>,
    error: Option<&Error>,
) -> Result<()> {
    let updated = sqlx::query("UPDATE catalog_imports SET state=?,receipt=?,error_code=?,error_message=? WHERE id=? AND background=1 AND state IN ('queued','running')")
        .bind(if receipt.is_some() {"completed"} else {"failed"}).bind(receipt.map(sqlx::types::Json))
        .bind(error.map(|error|error.code)).bind(error.and_then(|error|error.message.as_deref()))
        .bind(read["id"].as_str()).execute(tx.connection()).await?;
    if updated.rows_affected() != 1 {
        return Err(Error::new("source_interrupted"));
    }
    Ok(())
}
pub async fn start_catalog_page_in_tx(tx: &mut AppTx<'_>, read: &Value) -> Result<()> {
    let updated = sqlx::query("UPDATE catalog_imports SET state='running' WHERE id=? AND background=1 AND state IN ('queued','running')")
        .bind(read["id"].as_str()).execute(tx.connection()).await?;
    if updated.rows_affected() != 1 {
        return Err(Error::new("source_interrupted"));
    }
    Ok(())
}
pub async fn catalog_members_in_tx(tx: &mut AppTx<'_>, sync: &str) -> Result<Vec<Value>> {
    let rows=sqlx::query("SELECT source_id,platform_table_id,accepted_revision,retained_objects,pending_maintainers FROM catalog_sync_members WHERE sync_id=? ORDER BY source_id")
        .bind(sync).fetch_all(tx.connection()).await?;
    Ok(rows.iter().map(|r|json!({"source_id":r.get::<String,_>("source_id"),"platform_table_id":r.get::<String,_>("platform_table_id"),"revision":r.get::<u64,_>("accepted_revision"),
        "objects":r.get::<sqlx::types::Json<Value>,_>("retained_objects").0,"maintainers":r.get::<sqlx::types::Json<Value>,_>("pending_maintainers").0})).collect())
}
pub async fn save_catalog_member_in_tx(
    tx: &mut AppTx<'_>,
    sync: &str,
    member: &Value,
) -> Result<()> {
    let exists: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM catalog_sync_members WHERE sync_id=? AND source_id=?",
    )
    .bind(sync)
    .bind(member["source_id"].as_str())
    .fetch_one(tx.connection())
    .await?;
    if exists > 0 {
        return Err(Error::new("source_incomplete"));
    }
    sqlx::query("INSERT INTO catalog_sync_members(sync_id,source_id,platform_table_id,accepted_revision,retained_objects,pending_maintainers) VALUES(?,?,?,?,?,?)")
        .bind(sync).bind(member["source_id"].as_str()).bind(member["platform_table_id"].as_str()).bind(member["revision"].as_u64())
        .bind(sqlx::types::Json(&member["objects"])).bind(sqlx::types::Json(&member["maintainers"])).execute(tx.connection()).await?;
    Ok(())
}
pub async fn commit_catalog_page_in_tx(
    tx: &mut AppTx<'_>,
    read: &Value,
    page: &Value,
) -> Result<()> {
    let cursor_key = fingerprint(&page["next_cursor"]);
    if !page["complete"].as_bool().unwrap_or(false) {
        let seen: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM catalog_sync_pages WHERE sync_id=? AND cursor_key=?",
        )
        .bind(read["id"].as_str())
        .bind(&cursor_key)
        .fetch_one(tx.connection())
        .await?;
        if seen > 0 {
            return Err(Error::new("source_incomplete"));
        }
        sqlx::query("INSERT INTO catalog_sync_pages(sync_id,cursor_key) VALUES(?,?)")
            .bind(read["id"].as_str())
            .bind(cursor_key)
            .execute(tx.connection())
            .await?;
    }
    let updated=sqlx::query("UPDATE catalog_imports SET cursor_value=?,snapshot_id=?,source_namespace=?,authoritative=?,processed_sources=processed_sources+?,pages_committed=pages_committed+1,directory_complete=? WHERE id=? AND state='running' AND pages_committed=?")
        .bind(page["next_cursor"].as_str()).bind(page["snapshot_id"].as_str()).bind(page["source_namespace"].as_str()).bind(page["authoritative"].as_bool())
        .bind(page["tables"].as_array().map_or(0,Vec::len) as u64).bind(page["complete"].as_bool()).bind(read["id"].as_str()).bind(read["pages_committed"].as_u64()).execute(tx.connection()).await?;
    if updated.rows_affected() != 1 {
        return Err(Error::new("version_conflict"));
    }
    Ok(())
}
pub async fn sync_sources_in_tx(tx: &mut AppTx<'_>, space: &str) -> Result<Vec<(String, u64)>> {
    // 连首次空目录导入也串行；后取得锁的同步读取当前头和当前来源，不能写回旧快照。
    sqlx::query("INSERT INTO source_sync_locks(space_id) VALUES(?) ON DUPLICATE KEY UPDATE space_id=VALUES(space_id)").bind(space).execute(tx.connection()).await?;
    let heads =
        sqlx::query("SELECT id,version FROM source_heads WHERE space_id=? ORDER BY id FOR UPDATE")
            .bind(space)
            .fetch_all(tx.connection())
            .await?;
    let expected: std::collections::HashMap<String, u64> = heads
        .iter()
        .map(|r| (r.get("id"), r.get("version")))
        .collect();
    let sources = super::synthetic_sources()?;
    let mut changed = Vec::new();
    for (source, body) in sources {
        let fp = fingerprint(&json!(body));
        let old = sqlx::query(
            "SELECT version,fingerprint FROM source_heads WHERE id=? AND space_id=? FOR UPDATE",
        )
        .bind(&source)
        .bind(space)
        .fetch_optional(tx.connection())
        .await?;
        let actual = old.as_ref().map_or(0, |r| r.get::<u64, _>("version"));
        if actual != expected.get(&source).copied().unwrap_or(0) {
            return Err(Error::new("version_conflict"));
        }
        if old
            .as_ref()
            .is_some_and(|r| r.get::<String, _>("fingerprint") == fp)
        {
            continue;
        }
        let version = old.map_or(1, |r| r.get::<u64, _>("version") + 1);
        sqlx::query("INSERT INTO source_snapshots(source_id,version,body) VALUES(?,?,?)")
            .bind(&source)
            .bind(version)
            .bind(&body)
            .execute(tx.connection())
            .await?;
        sqlx::query("INSERT INTO source_heads(id,space_id,version,fingerprint) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE version=VALUES(version),fingerprint=VALUES(fingerprint)").bind(&source).bind(space).bind(version).bind(fp).execute(tx.connection()).await?;
        changed.push((source, version));
    }
    Ok(changed)
}
pub async fn source_version_in_tx(tx: &mut AppTx<'_>, space: &str, id: &str) -> Result<u64> {
    sqlx::query_scalar("SELECT version FROM source_heads WHERE id=? AND space_id=?")
        .bind(id)
        .bind(space)
        .fetch_optional(tx.connection())
        .await?
        .ok_or(Error::new("not_available"))
}
pub async fn source_versions_in_tx(
    tx: &mut AppTx<'_>,
    space: &str,
    ids: &[String],
) -> Result<std::collections::HashMap<String, u64>> {
    let mut versions = std::collections::HashMap::new();
    for chunk in ids.chunks(500) {
        let mut query = sqlx::QueryBuilder::<sqlx::MySql>::new(
            "SELECT id,version FROM source_heads WHERE space_id=",
        );
        query.push_bind(space).push(" AND id IN (");
        let mut keys = query.separated(",");
        for id in chunk {
            keys.push_bind(id);
        }
        query.push(")");
        for row in query.build().fetch_all(tx.connection()).await? {
            versions.insert(row.get("id"), row.get("version"));
        }
    }
    Ok(versions)
}
pub async fn effective_versions_in_tx(tx: &mut AppTx<'_>, space: &str) -> Result<Value> {
    let rows = sqlx::query("SELECT h.id,h.version FROM source_heads h JOIN source_snapshots s ON s.source_id=h.id AND s.version=h.version WHERE h.space_id=? AND s.complete=1 ORDER BY h.id").bind(space).fetch_all(tx.connection()).await?;
    Ok(json!(
        rows.iter()
            .map(|r| json!([
                r.get::<String, _>("id"),
                r.get::<u64, _>("version").to_string()
            ]))
            .collect::<Vec<_>>()
    ))
}
pub async fn read_source_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    id: &str,
    version: u64,
) -> Result<Value> {
    let current = source_version_in_tx(tx, &ctx.space_id, id).await?;
    if let Some(row) = sqlx::query(
        "SELECT body,complete FROM source_current WHERE source_id=? AND space_id=? AND revision=?",
    )
    .bind(id)
    .bind(&ctx.space_id)
    .bind(version)
    .fetch_optional(tx.connection())
    .await?
    {
        return Ok(
            json!({"source_id":id,"version":version.to_string(),"current_version":current.to_string(),"body":row.get::<String,_>("body"),"complete":row.get::<bool,_>("complete")}),
        );
    }
    let row =
        sqlx::query("SELECT body,complete FROM source_snapshots WHERE source_id=? AND version=?")
            .bind(id)
            .bind(version)
            .fetch_optional(tx.connection())
            .await?
            .ok_or(Error::new("not_available"))?;
    Ok(
        json!({"source_id":id,"version":version.to_string(),"current_version":current.to_string(),"body":row.get::<String,_>("body"),"complete":row.get::<bool,_>("complete")}),
    )
}

pub async fn queue_prefill_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &Value,
    material: &Value,
) -> Result<()> {
    let table = analysis_table_id(object);
    // 与常用范围变更共享行锁，避免配置先更新而并发导入随后插入旧优先级。
    let priority = if let Some(table) = table {
        sqlx::query("INSERT INTO table_analysis_preferences(space_id,table_id) VALUES(?,?) ON DUPLICATE KEY UPDATE table_id=VALUES(table_id)")
            .bind(&ctx.space_id)
            .bind(table)
            .execute(tx.connection())
            .await?;
        let preferred: bool = sqlx::query_scalar("SELECT preferred FROM table_analysis_preferences WHERE space_id=? AND table_id=? FOR UPDATE")
            .bind(&ctx.space_id).bind(table).fetch_one(tx.connection()).await?;
        u8::from(preferred)
    } else {
        0
    };
    let mut input = material.clone();
    input["object"] = object.clone();
    sqlx::query("INSERT IGNORE INTO prefill_attempts(id,space_id,object_id,expected_version,input_fingerprint,input_json,table_id,priority) VALUES(?,?,?,?,?,?,?,?)")
        .bind(crate::types::id()).bind(&ctx.space_id).bind(object["id"].as_str()).bind(crate::types::epoch(object["version"].as_str().unwrap_or("0"))?).bind(fingerprint(&input)).bind(sqlx::types::Json(input)).bind(table).bind(priority).execute(tx.connection()).await?;
    Ok(())
}

fn analysis_table_id(object: &Value) -> Option<&str> {
    match object["kind"].as_str() {
        Some("table") => object["id"].as_str(),
        Some("field") => object["related_ids"]
            .as_array()?
            .iter()
            .find_map(|v| v.as_str().filter(|id| id.starts_with("table-"))),
        _ => None,
    }
}

pub async fn read_analysis_preference_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &Value,
) -> Result<Option<Value>> {
    let Some(table) = analysis_table_id(object) else {
        return Ok(None);
    };
    let row = sqlx::query(
        "SELECT version,preferred FROM table_analysis_preferences WHERE space_id=? AND table_id=?",
    )
    .bind(&ctx.space_id)
    .bind(table)
    .fetch_optional(tx.connection())
    .await?;
    Ok(Some(row.map(|r| json!({"table_id":table,"version":r.get::<u64,_>("version").to_string(),"preferred":r.get::<bool,_>("preferred")}))
        .unwrap_or_else(|| json!({"table_id":table,"version":"1","preferred":false}))))
}

pub async fn save_analysis_preference_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    table: &str,
    input: &Value,
) -> Result<(Value, bool)> {
    let operation = input["operation_id"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?;
    let command = json!({"table_id":table,"input":input});
    // 既有键直接取得排他锁，避免并发重传先共享锁再升级导致死锁。
    sqlx::query("INSERT INTO analysis_preference_operations(space_id,owner_id,operation_id,fingerprint,receipt) VALUES(?,?,?,?,JSON_OBJECT()) ON DUPLICATE KEY UPDATE operation_id=VALUES(operation_id)")
        .bind(&ctx.space_id).bind(&ctx.user_id).bind(operation).bind(fingerprint(&command)).execute(tx.connection()).await?;
    let previous = sqlx::query("SELECT fingerprint,receipt FROM analysis_preference_operations WHERE space_id=? AND owner_id=? AND operation_id=? FOR UPDATE")
        .bind(&ctx.space_id).bind(&ctx.user_id).bind(operation).fetch_one(tx.connection()).await?;
    if previous.get::<String, _>("fingerprint") != fingerprint(&command) {
        return Err(Error::new("idempotency_conflict"));
    }
    let previous_receipt = previous.get::<sqlx::types::Json<Value>, _>("receipt").0;
    if previous_receipt["table_id"].is_string() {
        return Ok((previous_receipt, false));
    }
    sqlx::query("INSERT INTO table_analysis_preferences(space_id,table_id) VALUES(?,?) ON DUPLICATE KEY UPDATE table_id=VALUES(table_id)")
        .bind(&ctx.space_id)
        .bind(table)
        .execute(tx.connection())
        .await?;
    let row = sqlx::query("SELECT version,preferred FROM table_analysis_preferences WHERE space_id=? AND table_id=? FOR UPDATE")
        .bind(&ctx.space_id).bind(table).fetch_one(tx.connection()).await?;
    let version = row.get::<u64, _>("version");
    if input["expected_version"].as_str() != Some(version.to_string().as_str()) {
        return Err(Error::new("version_conflict"));
    }
    let preferred = input["preferred"]
        .as_bool()
        .ok_or(Error::new("invalid_input"))?;
    let changed = preferred != row.get::<bool, _>("preferred");
    let version = if changed {
        version.checked_add(1).ok_or(Error::new("invalid_input"))?
    } else {
        version
    };
    if changed {
        sqlx::query("UPDATE table_analysis_preferences SET version=?,preferred=?,updated_by=? WHERE space_id=? AND table_id=?")
            .bind(version).bind(preferred).bind(&ctx.user_id).bind(&ctx.space_id).bind(table).execute(tx.connection()).await?;
        sqlx::query("UPDATE prefill_attempts SET priority=? WHERE space_id=? AND table_id=? AND state='queued'")
            .bind(u8::from(preferred)).bind(&ctx.space_id).bind(table).execute(tx.connection()).await?;
    }
    let receipt = json!({"table_id":table,"version":version.to_string(),"preferred":preferred});
    sqlx::query("UPDATE analysis_preference_operations SET receipt=? WHERE space_id=? AND owner_id=? AND operation_id=?")
        .bind(sqlx::types::Json(&receipt)).bind(&ctx.space_id).bind(&ctx.user_id).bind(operation).execute(tx.connection()).await?;
    Ok((receipt, changed))
}
pub async fn check_prefill_sources_in_tx(
    tx: &mut AppTx<'_>,
    space: &str,
    sources: &Value,
) -> Result<()> {
    sqlx::query("SELECT space_id FROM source_sync_locks WHERE space_id=? FOR UPDATE")
        .bind(space)
        .fetch_one(tx.connection())
        .await?;
    for source in sources.as_array().ok_or(Error::new("invalid_input"))? {
        let current: Option<u64> = sqlx::query_scalar(
            "SELECT version FROM source_heads WHERE id=? AND space_id=? FOR UPDATE",
        )
        .bind(source["source_id"].as_str().unwrap_or(""))
        .bind(space)
        .fetch_optional(tx.connection())
        .await?;
        if current.map(|v| v.to_string()).as_deref() != source["version"].as_str() {
            return Err(Error::new("stale_knowledge"));
        }
    }
    Ok(())
}
pub async fn prefill_status_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &str,
) -> Result<Value> {
    let row=sqlx::query("SELECT id,state,error_code FROM prefill_attempts WHERE space_id=? AND object_id=? ORDER BY created_at DESC,id DESC LIMIT 1").bind(&ctx.space_id).bind(object).fetch_optional(tx.connection()).await?;
    Ok(row.map(|r|json!({"attempt_id":r.get::<String,_>("id"),"state":r.get::<String,_>("state"),"error_code":r.get::<Option<String>,_>("error_code")})).unwrap_or(Value::Null))
}

// 对象当前来源的语义整理状态：与对象级预填分开表达，两作业互不冒充。
// 人工独立对象（无来源）返回null；有来源先取最新方法版本的实际进度，
// 尚无准备记录时回退到待办作业的真实排队状态，不猜进度。
pub async fn preparation_status_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    object: &Value,
) -> Result<Value> {
    let Some((source, revision)) = preparation_source_of(object) else {
        return Ok(Value::Null);
    };
    let row = sqlx::query("SELECT semantic_status,error_code FROM source_preparations WHERE source_id=? AND revision=? AND space_id=? ORDER BY method_version DESC LIMIT 1")
        .bind(&source)
        .bind(revision)
        .bind(&ctx.space_id)
        .fetch_optional(tx.connection())
        .await?;
    if let Some(record) = row {
        return Ok(json!({"source_id":source,"revision":revision.to_string(),
            "state":record.get::<String,_>("semantic_status"),
            "error_code":record.get::<Option<String>,_>("error_code")}));
    }
    let job = sqlx::query("SELECT state FROM background_jobs WHERE kind='prepare_source' AND resource_id=? AND resource_version=? ORDER BY dispatch_seq DESC LIMIT 1")
        .bind(&source)
        .bind(revision)
        .fetch_optional(tx.connection())
        .await?;
    // 排队作业还没有准备记录，也没有整理错误；错误码只随实际准备进度出现。
    Ok(job
        .map(|record| {
            json!({"source_id":source,"revision":revision.to_string(),
                "state":record.get::<String,_>("state"),"error_code":null})
        })
        .unwrap_or(Value::Null))
}

// 对象的整理来源身份：单文档以自身为来源，目录对象沿主来源；人工独立对象无来源。
fn preparation_source_of(object: &Value) -> Option<(String, u64)> {
    if object["kind"] == "document" && object["source_id"].is_null() {
        let id = object["id"].as_str()?;
        let revision = object["version"].as_str()?.parse::<u64>().ok()?;
        return Some((format!("document-{id}"), revision));
    }
    let source = object["source_id"].as_str()?;
    let revision = object["source_version"].as_str()?.parse::<u64>().ok()?;
    Some((source.to_owned(), revision))
}
pub async fn claim_prefill_in_tx(tx: &mut AppTx<'_>, space: &str) -> Result<Option<Value>> {
    sqlx::query("UPDATE prefill_attempts SET state='unknown',error_code='model_unknown' WHERE space_id=? AND state='issued' AND issued_until<UTC_TIMESTAMP(3)").bind(space).execute(tx.connection()).await?;
    // 同次目录的后续页可能才包含上游；采集终止前不开始模型分析。
    let row = sqlx::query("SELECT * FROM prefill_attempts p WHERE space_id=? AND state='queued' AND (JSON_EXTRACT(input_json,'$.catalog_import_id') IS NULL OR EXISTS(SELECT 1 FROM catalog_imports c WHERE c.id=JSON_UNQUOTE(JSON_EXTRACT(p.input_json,'$.catalog_import_id')) AND ((c.background=1 AND c.state IN ('completed','failed')) OR (c.background=0 AND (c.state<>'fetching' OR c.lease_until<UTC_TIMESTAMP(3)))))) ORDER BY priority DESC,created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED").bind(space).fetch_optional(tx.connection()).await?;
    let Some(row) = row else { return Ok(None) };
    let id: String = row.get("id");
    // 已开始的请求在重启后保持未知，不自动重发模型请求。
    sqlx::query("UPDATE prefill_attempts SET state='issued',issued_until=TIMESTAMPADD(SECOND,?,UTC_TIMESTAMP(3)) WHERE id=?")
        .bind(super::prefill::timing()?.1)
        .bind(&id)
        .execute(tx.connection())
        .await?;
    Ok(Some(
        json!({"id":id,"object_id":row.get::<String,_>("object_id"),"expected_version":row.get::<u64,_>("expected_version").to_string(),"input":row.get::<sqlx::types::Json<Value>,_>("input_json").0}),
    ))
}
pub async fn finish_prefill_in_tx(
    tx: &mut AppTx<'_>,
    id: &str,
    state: &str,
    result: &Value,
    code: Option<&str>,
) -> Result<()> {
    sqlx::query("UPDATE prefill_attempts SET state=?,result_json=?,error_code=? WHERE id=? AND state='issued'").bind(state).bind(sqlx::types::Json(result)).bind(code).bind(id).execute(tx.connection()).await?;
    Ok(())
}

pub async fn assert_prefill_active_in_tx(tx: &mut AppTx<'_>, attempt: &str) -> Result<()> {
    let active: i64=sqlx::query_scalar("SELECT state='issued' AND issued_until>UTC_TIMESTAMP(3) FROM prefill_attempts WHERE id=? FOR UPDATE").bind(attempt).fetch_one(tx.connection()).await?;
    if active == 0 {
        return Err(Error::new("model_unknown"));
    }
    Ok(())
}

pub async fn record_prefill_draft_in_tx(
    tx: &mut AppTx<'_>,
    attempt: &str,
    draft: &Value,
    review_input: &Value,
) -> Result<()> {
    assert_prefill_active_in_tx(tx, attempt).await?;
    // 复核仍属于同一次预填；保留分析草稿，更新当前领取的有效期，不重领或自动重发。
    sqlx::query("UPDATE prefill_attempts SET result_json=?,issued_until=TIMESTAMPADD(SECOND,?,UTC_TIMESTAMP(3)) WHERE id=?")
        .bind(sqlx::types::Json(serde_json::json!({"analysis":draft,"review_input":review_input})))
        .bind(super::prefill::timing()?.1)
        .bind(attempt).execute(tx.connection()).await?;
    Ok(())
}

pub async fn missing_catalog_sources_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    namespace: &str,
    seen: &std::collections::HashSet<String>,
    lock_current: bool,
) -> Result<Vec<String>> {
    let query = if lock_current {
        "SELECT c.source_id,c.platform_table_id FROM catalog_platform_heads c JOIN source_heads s ON s.id=c.source_id WHERE s.space_id=? AND c.namespace=? ORDER BY c.source_id FOR SHARE"
    } else {
        "SELECT c.source_id,c.platform_table_id FROM catalog_platform_heads c JOIN source_heads s ON s.id=c.source_id WHERE s.space_id=? AND c.namespace=? ORDER BY c.source_id"
    };
    let rows = sqlx::query(query)
        .bind(&ctx.space_id)
        .bind(namespace)
        .fetch_all(tx.connection())
        .await?;
    Ok(rows
        .iter()
        .filter(|r| !seen.contains(&r.get::<String, _>("platform_table_id")))
        .map(|r| r.get("source_id"))
        .collect())
}
pub async fn retire_catalog_source_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    read: &Value,
    source: &str,
) -> Result<()> {
    sqlx::query("SELECT space_id FROM source_sync_locks WHERE space_id=? FOR UPDATE")
        .bind(&ctx.space_id)
        .fetch_one(tx.connection())
        .await?;
    // 授权检查可能已建立快照；退休必须核对拿到来源锁之后的当前版本。
    let current = sqlx::query(
        "SELECT version,fingerprint FROM source_heads WHERE id=? AND space_id=? FOR UPDATE",
    )
    .bind(source)
    .bind(&ctx.space_id)
    .fetch_one(tx.connection())
    .await?;
    let version: u64 = current.get("version");
    if Some(version) != read["baseline"][source].as_u64() {
        return Err(Error::new("version_conflict"));
    }
    let body = "平台已在权威完整目录中移除此表；历史说明保留，但不能继续用于新分析。";
    let fp = fingerprint(&json!(body));
    let old: String = current.get("fingerprint");
    if old != fp {
        sqlx::query("INSERT INTO source_snapshots(source_id,version,body) VALUES(?,?,?)")
            .bind(source)
            .bind(version + 1)
            .bind(body)
            .execute(tx.connection())
            .await?;
        sqlx::query("UPDATE source_heads SET version=?,fingerprint=? WHERE id=? AND space_id=?")
            .bind(version + 1)
            .bind(fp)
            .bind(source)
            .bind(&ctx.space_id)
            .execute(tx.connection())
            .await?;
    }
    sqlx::query("UPDATE catalog_platform_heads SET retired=1 WHERE source_id=?")
        .bind(source)
        .execute(tx.connection())
        .await?;
    Ok(())
}

// 目录采集结束后冻结首阶段材料及来源版本；复核可在同版范围内补充原文。
pub async fn freeze_prefill_input_in_tx(
    tx: &mut AppTx<'_>,
    attempt: &str,
    input: &Value,
) -> Result<()> {
    assert_prefill_active_in_tx(tx, attempt).await?;
    sqlx::query("UPDATE prefill_attempts SET input_json=?,input_fingerprint=? WHERE id=? AND JSON_EXTRACT(input_json,'$.coverage') IS NULL")
        .bind(sqlx::types::Json(input)).bind(fingerprint(input)).bind(attempt).execute(tx.connection()).await?;
    Ok(())
}

async fn write_current_in_tx(
    tx: &mut AppTx<'_>,
    space: &str,
    source: &str,
    namespace: &str,
    content: (u64, &str, &Value),
    observed: &Value,
) -> Result<()> {
    let (version, body, retained) = content;
    let (fp, parsed) = super::catalog_content::comparison(retained);
    let identity: Option<String> = sqlx::query_scalar("SELECT source_id FROM source_current WHERE space_id=? AND adapter_id='datasight' AND source_kind='table' AND namespace=? AND external_id=? FOR UPDATE")
        .bind(space).bind(namespace).bind(retained["id"].as_str()).fetch_optional(tx.connection()).await?;
    if identity.as_deref().is_some_and(|id| id != source) {
        return Err(Error::new("version_conflict"));
    }
    sqlx::query("INSERT INTO source_current(source_id,space_id,adapter_id,source_kind,namespace,external_id,revision,body,metadata,content_fingerprint,explanation_fingerprint,comparison_method,parsed,observed_metadata) VALUES(?,?,'datasight','table',?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE revision=VALUES(revision),body=VALUES(body),metadata=VALUES(metadata),content_fingerprint=VALUES(content_fingerprint),explanation_fingerprint=VALUES(explanation_fingerprint),comparison_method=VALUES(comparison_method),parsed=VALUES(parsed),observed_metadata=VALUES(observed_metadata)")
        .bind(source).bind(space).bind(namespace).bind(retained["id"].as_str()).bind(version).bind(body).bind(sqlx::types::Json(retained))
        .bind(&fp).bind(&fp).bind(super::catalog_content::METHOD).bind(parsed)
        .bind(sqlx::types::Json(json!({"platform_version":observed["platform_version"],"maintainer_id":observed["maintainer_id"]}))).execute(tx.connection()).await?;
    Ok(())
}
// 每批在当前头的锁内回填；并发实时写先完成时只复制该头，不回写先前读到的旧正文。
pub async fn backfill_current_in_tx(tx: &mut AppTx<'_>) -> Result<usize> {
    let rows=sqlx::query("SELECT h.id,h.space_id,h.version,c.observed_metadata FROM source_heads h LEFT JOIN source_current c ON c.source_id=h.id WHERE c.source_id IS NULL OR c.revision<>h.version OR c.comparison_method NOT IN ('sql_tokens_v2','raw_v1') ORDER BY h.id LIMIT 16 FOR UPDATE SKIP LOCKED").fetch_all(tx.connection()).await?;
    for row in &rows {
        let source: String = row.get("id");
        let space: String = row.get("space_id");
        let version: u64 = row.get("version");
        let snapshot = sqlx::query(
            "SELECT body,complete FROM source_snapshots WHERE source_id=? AND version=?",
        )
        .bind(&source)
        .bind(version)
        .fetch_one(tx.connection())
        .await?;
        let body: String = snapshot.get("body");
        let catalog = sqlx::query(
            "SELECT namespace,body FROM catalog_table_snapshots WHERE source_id=? AND version=?",
        )
        .bind(&source)
        .bind(version)
        .fetch_optional(tx.connection())
        .await?;
        if let Some(catalog) = catalog {
            let retained = catalog.get::<sqlx::types::Json<Value>, _>("body").0;
            // 回填升级比较方法，不把保留原文里的旧观测覆盖到已经更新的观测值。
            let observed = row
                .get::<Option<sqlx::types::Json<Value>>, _>("observed_metadata")
                .map(|value| value.0)
                .unwrap_or_else(|| retained.clone());
            write_current_in_tx(
                tx,
                &space,
                &source,
                &catalog.get::<String, _>("namespace"),
                (version, &body, &retained),
                &observed,
            )
            .await?;
        } else {
            let fp = fingerprint(&json!(&body));
            // 旧合成来源沿原身份；退休来源仍沿已登记的平台外部键。
            let platform = sqlx::query(
                "SELECT namespace,platform_table_id FROM catalog_platform_heads WHERE source_id=?",
            )
            .bind(&source)
            .fetch_optional(tx.connection())
            .await?;
            let (adapter, namespace, external) = platform
                .map(|r| {
                    (
                        "datasight",
                        r.get::<String, _>("namespace"),
                        r.get::<String, _>("platform_table_id"),
                    )
                })
                .unwrap_or(("synthetic", "fixtures".into(), source.clone()));
            sqlx::query("INSERT INTO source_current(source_id,space_id,adapter_id,source_kind,namespace,external_id,revision,body,complete,metadata,content_fingerprint,explanation_fingerprint,comparison_method,parsed,observed_metadata) VALUES(?,?,?,'table',?,?,?,?,?,JSON_OBJECT(),?,?,'raw_v1',0,JSON_OBJECT()) ON DUPLICATE KEY UPDATE revision=VALUES(revision),body=VALUES(body),complete=VALUES(complete),metadata=VALUES(metadata),content_fingerprint=VALUES(content_fingerprint),explanation_fingerprint=VALUES(explanation_fingerprint),comparison_method=VALUES(comparison_method),parsed=VALUES(parsed)")
                .bind(&source).bind(space).bind(adapter).bind(namespace).bind(external).bind(version).bind(body).bind(snapshot.get::<bool,_>("complete")).bind(&fp).bind(&fp).execute(tx.connection()).await?;
        }
    }
    Ok(rows.len())
}

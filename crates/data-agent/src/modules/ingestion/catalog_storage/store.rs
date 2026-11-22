use super::store::{record_source_revision_in_tx, source_version_in_tx, write_current_in_tx};
use crate::{
    persistence::{AppTx, receipts::Operation},
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
    let current = sqlx::query(
        "SELECT body,complete,metadata FROM source_current WHERE source_id=? AND space_id=? AND revision=? FOR UPDATE",
    )
    .bind(&source)
    .bind(&ctx.space_id)
    .bind(actual)
    .fetch_optional(tx.connection())
    .await?;
    let retained = if let Some(row) = current.as_ref()
        && row.get::<sqlx::types::Json<Value>, _>("metadata").0["id"].is_string()
    {
        Some(row.get::<sqlx::types::Json<Value>, _>("metadata"))
    } else {
        sqlx::query_scalar::<_, sqlx::types::Json<Value>>(
            "SELECT body FROM catalog_table_snapshots WHERE source_id=? AND version=?",
        )
        .bind(&source)
        .bind(actual)
        .fetch_optional(tx.connection())
        .await?
    };
    let retired: Option<bool> =
        sqlx::query_scalar("SELECT retired FROM catalog_platform_heads WHERE source_id=?")
            .bind(&source)
            .fetch_optional(tx.connection())
            .await?;
    if actual > 0 && retired != Some(true) && retained.is_none() {
        return Err(Error::new("not_available"));
    }
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
        let (stored, complete) = if let Some(row) = current {
            (row.get::<String, _>("body"), row.get::<bool, _>("complete"))
        } else {
            sqlx::query_as::<_, (String, bool)>(
                "SELECT body,archive_complete AS complete FROM source_revisions WHERE source_id=? AND version=? AND body IS NOT NULL",
            )
            .bind(&source)
            .bind(actual)
            .fetch_optional(tx.connection())
            .await?
            .ok_or(Error::new("not_available"))?
        };
        write_current_in_tx(
            tx,
            &ctx.space_id,
            &source,
            namespace,
            (actual, &stored, complete, &retained.unwrap().0),
            table,
        )
        .await?;
        return Ok((actual, false));
    }
    let version = actual + 1;
    let retain_archive = crate::types::retain_public_content_archives()?;
    if retain_archive {
        sqlx::query("INSERT INTO source_revisions(source_id,version,body) VALUES(?,?,?) ON DUPLICATE KEY UPDATE body=COALESCE(source_revisions.body,VALUES(body))")
            .bind(&source)
            .bind(version)
            .bind(&body)
            .execute(tx.connection())
            .await?;
    }
    sqlx::query("INSERT INTO source_heads(id,space_id,version,fingerprint) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE version=VALUES(version),fingerprint=VALUES(fingerprint)")
        .bind(&source).bind(&ctx.space_id).bind(version).bind(fp).execute(tx.connection()).await?;
    sqlx::query("INSERT INTO catalog_platform_heads(source_id,platform_version,namespace,platform_table_id) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE platform_version=VALUES(platform_version),namespace=VALUES(namespace),platform_table_id=VALUES(platform_table_id),retired=0").bind(&source).bind(platform_version).bind(namespace).bind(table["id"].as_str()).execute(tx.connection()).await?;
    if retain_archive {
        sqlx::query(
            "INSERT INTO catalog_table_snapshots(source_id,version,namespace,body) VALUES(?,?,?,?)",
        )
        .bind(&source)
        .bind(version)
        .bind(namespace)
        .bind(sqlx::types::Json(table))
        .execute(tx.connection())
        .await?;
    }
    write_current_in_tx(
        tx,
        &ctx.space_id,
        &source,
        namespace,
        (version, &body, true, table),
        table,
    )
    .await?;
    record_source_revision_in_tx(tx, &source, version, &ctx.user_id).await?;
    Ok((version, true))
}

pub async fn catalog_candidate_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    source: &str,
    object_id: &str,
) -> Result<Value> {
    let version = source_version_in_tx(tx, &ctx.space_id, source).await?;
    let row = if let Some(row) = sqlx::query(
        "SELECT namespace,metadata AS body FROM source_current WHERE source_id=? AND space_id=? AND revision=? AND adapter_id='datasight' AND source_kind='table' AND JSON_TYPE(JSON_EXTRACT(metadata,'$.id'))='STRING'",
    )
    .bind(source)
    .bind(&ctx.space_id)
    .bind(version)
    .fetch_optional(tx.connection())
    .await?
    {
        row
    } else {
        sqlx::query(
            "SELECT namespace,body FROM catalog_table_snapshots WHERE source_id=? AND version=?",
        )
        .bind(source)
        .bind(version)
        .fetch_optional(tx.connection())
        .await?
        .ok_or(Error::new("not_available"))?
    };
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
    let row = if let Some(row) = sqlx::query(
        "SELECT namespace,metadata AS body FROM source_current WHERE source_id=? AND space_id=? AND revision=? AND adapter_id='datasight' AND source_kind='table' AND JSON_TYPE(JSON_EXTRACT(metadata,'$.id'))='STRING'",
    )
    .bind(source)
    .bind(&ctx.space_id)
    .bind(version)
    .fetch_optional(tx.connection())
    .await?
    {
        row
    } else {
        sqlx::query(
            "SELECT namespace,body FROM catalog_table_snapshots WHERE source_id=? AND version=?",
        )
        .bind(source)
        .bind(version)
        .fetch_optional(tx.connection())
        .await?
        .ok_or(Error::new("not_available"))?
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
    if page["complete"] != true {
        use sha2::{Digest, Sha256};
        let cursor = &page["next_cursor"];
        let cursor_key = fingerprint(cursor);
        let sync_id = read["id"].as_str().expect("catalog read id");
        let operation_id = format!("{:x}", Sha256::digest(format!("{sync_id}:{cursor_key}")));
        let scope = AccessContext {
            space_id: read["space_id"]
                .as_str()
                .expect("catalog read space")
                .to_owned(),
            user_id: read["owner_id"]
                .as_str()
                .expect("catalog read owner")
                .to_owned(),
            request_id: sync_id.to_owned(),
            table_access: None,
        };
        let operation = Operation::new(&scope, "catalog_page", &operation_id, cursor);
        if operation.begin(tx).await?.is_some() {
            return Err(Error::new("source_incomplete"));
        }
        operation
            .complete(tx, &json!({"sync_id":sync_id,"cursor_key":cursor_key}))
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

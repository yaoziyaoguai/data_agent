pub use super::catalog_storage::{
    begin_catalog_read_in_tx, catalog_candidate_in_tx, catalog_members_in_tx, catalog_read_in_tx,
    catalog_upstream_in_tx, check_catalog_read_in_tx, commit_catalog_page_in_tx,
    complete_catalog_namespace_in_tx, finish_catalog_read_in_tx, save_catalog_member_in_tx,
    save_catalog_table_in_tx, start_catalog_page_in_tx,
};
pub use super::prefill_storage::{
    assert_prefill_active_in_tx, check_prefill_sources_in_tx, claim_prefill_in_tx,
    finish_prefill_in_tx, prefill_status_in_tx, preparation_record_status_in_tx,
    preparation_source_of, queue_prefill_in_tx, read_analysis_preference_in_tx,
    record_prefill_draft_in_tx, save_analysis_preference_in_tx,
};
use crate::{
    persistence::AppTx,
    types::{AccessContext, Error, Result, fingerprint},
};
use serde_json::{Value, json};
use sqlx::Row;

pub struct SyntheticSourceChanges {
    pub changed: Vec<(String, u64)>,
    pub catalog: String,
    pub previous_catalog: Option<String>,
}

pub async fn sync_sources_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
) -> Result<SyntheticSourceChanges> {
    let space = &ctx.space_id;
    let retain_archive = crate::types::retain_public_content_archives()?;
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
    let mut changes = SyntheticSourceChanges {
        changed: Vec::new(),
        catalog: String::new(),
        previous_catalog: None,
    };
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
        let content_changed = old
            .as_ref()
            .is_none_or(|r| r.get::<String, _>("fingerprint") != fp);
        let version = actual + u64::from(content_changed);
        if source == "semantic-catalog" {
            changes.catalog = body.clone();
            if content_changed && actual > 0 {
                // 持同一来源锁取更新前正文；不能在同步前读出另一份旧快照。
                changes.previous_catalog = Some(
                    read_source_in_tx(tx, ctx, &source, actual).await?["body"]
                        .as_str()
                        .ok_or(Error::new("source_unavailable"))?
                        .to_owned(),
                );
            }
        }
        if content_changed {
            if retain_archive {
                sqlx::query("INSERT INTO source_revisions(source_id,version,body) VALUES(?,?,?) ON DUPLICATE KEY UPDATE body=COALESCE(source_revisions.body,VALUES(body))")
                    .bind(&source)
                    .bind(version)
                    .bind(&body)
                    .execute(tx.connection())
                    .await?;
            }
            sqlx::query("INSERT INTO source_heads(id,space_id,version,fingerprint) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE version=VALUES(version),fingerprint=VALUES(fingerprint)").bind(&source).bind(space).bind(version).bind(&fp).execute(tx.connection()).await?;
            changes.changed.push((source.clone(), version));
        }
        sqlx::query("INSERT INTO source_current(source_id,space_id,adapter_id,source_kind,namespace,external_id,revision,body,complete,metadata,content_fingerprint,explanation_fingerprint,comparison_method,parsed,observed_metadata) VALUES(?,?,'synthetic','table','fixtures',?,?,?,1,JSON_OBJECT(),?,?,'raw_v1',0,JSON_OBJECT()) ON DUPLICATE KEY UPDATE revision=VALUES(revision),body=VALUES(body),complete=VALUES(complete),metadata=VALUES(metadata),content_fingerprint=VALUES(content_fingerprint),explanation_fingerprint=VALUES(explanation_fingerprint),comparison_method=VALUES(comparison_method),parsed=VALUES(parsed)")
            .bind(&source).bind(space).bind(&source).bind(version).bind(&body).bind(&fp).bind(&fp).execute(tx.connection()).await?;
        if content_changed {
            record_source_revision_in_tx(tx, &source, version, &ctx.user_id).await?;
        }
    }
    Ok(changes)
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
// 来源当前头（按全局唯一id）：返回(所属空间,当前版本)；不存在为None。
// 组合层据此解析作业资源身份，不需要预先知道空间。
pub async fn source_head_in_tx(tx: &mut AppTx<'_>, id: &str) -> Result<Option<(String, u64)>> {
    let row = sqlx::query("SELECT space_id,version FROM source_heads WHERE id=?")
        .bind(id)
        .fetch_optional(tx.connection())
        .await?;
    Ok(row.map(|row| (row.get("space_id"), row.get("version"))))
}

// 指定空间内来源的当前版本：扇出重排队核对用；来源不在该空间或不存在为None。
pub async fn source_head_version_in_tx(
    tx: &mut AppTx<'_>,
    space: &str,
    id: &str,
) -> Result<Option<u64>> {
    let version =
        sqlx::query_scalar::<_, u64>("SELECT version FROM source_heads WHERE id=? AND space_id=?")
            .bind(id)
            .bind(space)
            .fetch_optional(tx.connection())
            .await?;
    Ok(version)
}

// 平台来源的当前正文：依赖核验与指纹比较按需读取；不存在或未落当前内容为None。
pub async fn current_source_body_in_tx(
    tx: &mut AppTx<'_>,
    space: &str,
    id: &str,
) -> Result<Option<String>> {
    let body = sqlx::query_scalar::<_, String>(
        "SELECT c.body FROM source_current c JOIN source_heads h ON h.id=c.source_id AND h.space_id=c.space_id AND h.version=c.revision WHERE c.space_id=? AND c.source_id=?",
    )
    .bind(space)
    .bind(id)
    .fetch_optional(tx.connection())
    .await?;
    Ok(body)
}

// 指定修订正文批量读取：同修订当前内容优先，其余精确回退旧档；缺失不进结果。
// 调用方按指纹缺失的保守语义处理；占位符只拼"?"，成员身份走绑定参数。
pub async fn snapshot_bodies_in_tx(
    tx: &mut AppTx<'_>,
    pairs: &[(String, u64)],
) -> Result<std::collections::HashMap<(String, u64), String>> {
    let mut bodies = std::collections::HashMap::new();
    for chunk in pairs.chunks(200) {
        if chunk.is_empty() {
            continue;
        }
        let tuple_list = std::iter::repeat_n("(?,?)", chunk.len())
            .collect::<Vec<_>>()
            .join(",");
        let mut query = sqlx::query(sqlx::AssertSqlSafe(format!(
            "SELECT c.source_id,c.revision AS version,c.body FROM source_current c \
             JOIN source_heads h ON h.id=c.source_id AND h.space_id=c.space_id AND h.version=c.revision \
             WHERE (c.source_id,c.revision) IN ({tuple_list}) \
             UNION ALL SELECT s.source_id,s.version,s.body FROM source_revisions s \
             WHERE (s.source_id,s.version) IN ({tuple_list}) AND s.body IS NOT NULL AND NOT EXISTS \
             (SELECT 1 FROM source_current c JOIN source_heads h ON h.id=c.source_id \
              AND h.space_id=c.space_id AND h.version=c.revision \
              WHERE c.source_id=s.source_id AND c.revision=s.version)"
        )));
        for _ in 0..2 {
            for (id, revision) in chunk {
                query = query.bind(id).bind(revision);
            }
        }
        for record in query.fetch_all(tx.connection()).await? {
            bodies.insert(
                (
                    record.get::<String, _>("source_id"),
                    record.get::<u64, _>("version"),
                ),
                record.get::<String, _>("body"),
            );
        }
    }
    Ok(bodies)
}

// raw召回和历史上下文使用同一可读头。当前同修订记录优先；缺行时只读legacy元信息。
const READABLE_SOURCE_HEADS: &str = "SELECT h.id,h.version FROM source_heads h \
     LEFT JOIN source_current c ON c.source_id=h.id AND c.space_id=h.space_id AND c.revision=h.version \
     LEFT JOIN source_revisions s ON s.source_id=h.id AND s.version=h.version AND c.source_id IS NULL AND s.body IS NOT NULL \
     LEFT JOIN catalog_platform_heads p ON p.source_id=h.id \
     WHERE COALESCE(p.retired,FALSE)=FALSE AND COALESCE(c.complete,s.archive_complete,FALSE)=TRUE";

pub async fn readable_source_heads_in_tx(
    tx: &mut AppTx<'_>,
    space: &str,
) -> Result<Vec<(String, u64)>> {
    let mut query = sqlx::QueryBuilder::<sqlx::MySql>::new(READABLE_SOURCE_HEADS);
    query
        .push(" AND h.space_id=")
        .push_bind(space)
        .push(" ORDER BY h.id");
    Ok(query.build_query_as().fetch_all(tx.connection()).await?)
}

pub(crate) fn push_checkpoint_platform_heads(
    sql: &mut sqlx::QueryBuilder<sqlx::MySql>,
    space: &str,
    ids: &[(&str, &str)],
) {
    sql.push("checkpoint_platform_heads AS (")
        .push(READABLE_SOURCE_HEADS)
        .push(" AND h.space_id=")
        .push_bind(space)
        .push(" AND h.id IN (SELECT id FROM JSON_TABLE(CAST(")
        .push_bind(sqlx::types::Json(ids))
        .push(" AS JSON),'$[*]' COLUMNS(id VARCHAR(64) PATH '$[0]')) refs))");
}

// 旧作业接续按有限候选核当前可索引头；退休、完整性与全空间清单保持同一口径。
pub async fn readable_source_candidate_in_tx(
    tx: &mut AppTx<'_>,
    space: &str,
    source: &str,
    revision: u64,
) -> Result<bool> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM source_heads h \
         LEFT JOIN source_current c ON c.source_id=h.id AND c.space_id=h.space_id AND c.revision=h.version \
         LEFT JOIN source_revisions s ON s.source_id=h.id AND s.version=h.version AND c.source_id IS NULL AND s.body IS NOT NULL \
         LEFT JOIN catalog_platform_heads p ON p.source_id=h.id \
         WHERE h.id=? AND h.space_id=? AND h.version=? AND COALESCE(p.retired,FALSE)=FALSE \
         AND COALESCE(c.complete,s.archive_complete,FALSE)=TRUE)",
    )
    .bind(source)
    .bind(space)
    .bind(revision)
    .fetch_one(tx.connection())
    .await?)
}

pub async fn effective_versions_in_tx(tx: &mut AppTx<'_>, space: &str) -> Result<Value> {
    Ok(json!(
        readable_source_heads_in_tx(tx, space)
            .await?
            .into_iter()
            .map(|(id, version)| json!([id, version.to_string()]))
            .collect::<Vec<_>>()
    ))
}
pub async fn read_source_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    id: &str,
    version: u64,
) -> Result<Value> {
    if id.starts_with("catalog-") && !ctx.can_read_platform_source(id) {
        return Err(Error::new("not_available"));
    }
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
        sqlx::query("SELECT body,archive_complete AS complete FROM source_revisions WHERE source_id=? AND version=? AND body IS NOT NULL")
            .bind(id)
            .bind(version)
            .fetch_optional(tx.connection())
            .await?
            .ok_or(Error::new("not_available"))?;
    Ok(
        json!({"source_id":id,"version":version.to_string(),"current_version":current.to_string(),"body":row.get::<String,_>("body"),"complete":row.get::<bool,_>("complete")}),
    )
}

// 历史核验只判身份、修订与完整性：与read_source_in_tx同一钉住/回退/缺失语义，
// 但body列不进结果集，大原文不被装配回应用。
pub async fn read_source_meta_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    id: &str,
    version: u64,
) -> Result<Value> {
    if !ctx.can_read_platform_source(id) {
        return Err(Error::new("not_available"));
    }
    let current = source_version_in_tx(tx, &ctx.space_id, id).await?;
    let row = if let Some(row) = sqlx::query(
        "SELECT complete FROM source_current WHERE source_id=? AND space_id=? AND revision=?",
    )
    .bind(id)
    .bind(&ctx.space_id)
    .bind(version)
    .fetch_optional(tx.connection())
    .await?
    {
        row
    } else {
        sqlx::query("SELECT archive_complete AS complete FROM source_revisions WHERE source_id=? AND version=? AND body IS NOT NULL")
            .bind(id)
            .bind(version)
            .fetch_optional(tx.connection())
            .await?
            .ok_or(Error::new("not_available"))?
    };
    Ok(
        json!({"source_id":id,"version":version.to_string(),"current_version":current.to_string(),"complete":row.get::<bool,_>("complete")}),
    )
}

// 历史核验批量元信息：与read_source_meta_in_tx同一钉住/回退/缺失语义；
// 当前头与当前正文各一条IN查询，仅钉住旧修订且不在current的项逐条回退快照。
pub async fn read_source_metas_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    refs: &[(String, Option<u64>)],
) -> Result<std::collections::HashMap<String, Value>> {
    if refs.iter().any(|(id, _)| !ctx.can_read_platform_source(id)) {
        return Err(Error::new("not_available"));
    }
    let mut ids: Vec<String> = refs.iter().map(|(id, _)| id.clone()).collect();
    ids.sort();
    ids.dedup();
    let heads = source_versions_in_tx(tx, &ctx.space_id, &ids).await?;
    let mut currents: std::collections::HashMap<String, (u64, bool)> = Default::default();
    for chunk in ids.chunks(500) {
        let mut query = sqlx::QueryBuilder::<sqlx::MySql>::new(
            "SELECT source_id,revision,complete FROM source_current WHERE space_id=",
        );
        query.push_bind(&ctx.space_id).push(" AND source_id IN (");
        let mut keys = query.separated(",");
        for id in chunk {
            keys.push_bind(id);
        }
        query.push(")");
        for row in query.build().fetch_all(tx.connection()).await? {
            currents.insert(
                row.get::<String, _>("source_id"),
                (
                    row.get::<u64, _>("revision"),
                    row.get::<bool, _>("complete"),
                ),
            );
        }
    }
    let mut metas = std::collections::HashMap::new();
    let mut seen = std::collections::HashSet::new();
    for (id, pinned) in refs {
        if !seen.insert(id) {
            continue;
        }
        let current = *heads.get(id).ok_or(Error::new("not_available"))?;
        let version = pinned.unwrap_or(current);
        let complete = match currents.get(id) {
            Some((revision, complete)) if *revision == version => *complete,
            _ => {
                sqlx::query("SELECT archive_complete AS complete FROM source_revisions WHERE source_id=? AND version=? AND body IS NOT NULL")
                    .bind(id)
                    .bind(version)
                    .fetch_optional(tx.connection())
                    .await?
                    .ok_or(Error::new("not_available"))?
                    .get::<bool, _>("complete")
            }
        };
        metas.insert(
            id.clone(),
            json!({"source_id":id,"version":version.to_string(),"current_version":current.to_string(),"complete":complete}),
        );
    }
    Ok(metas)
}

// BINARY查找先按字节验证唯一性，再把前缀换算为Unicode字符坐标；只查指定源。
pub async fn locate_source_quote_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    source: &str,
    version: u64,
    quote: &str,
) -> Result<Option<usize>> {
    let current = source_version_in_tx(tx, &ctx.space_id, source).await?;
    if current != version {
        return Err(Error::new("stale_source"));
    }
    let offset = sqlx::query_scalar::<_, i64>(
        "WITH source AS (SELECT body,complete FROM source_current \
           WHERE source_id=? AND space_id=? AND revision=? \
           UNION ALL SELECT body,archive_complete AS complete FROM source_revisions WHERE source_id=? AND version=? AND body IS NOT NULL \
             AND NOT EXISTS(SELECT 1 FROM source_current WHERE source_id=? AND space_id=? AND revision=?)), \
         located AS (SELECT body,complete,LOCATE(CAST(? AS BINARY),CAST(body AS BINARY)) AS p FROM source) \
         SELECT CHAR_LENGTH(CONVERT(LEFT(CAST(body AS BINARY),p-1) USING utf8mb4)) FROM located \
         WHERE complete=TRUE AND p>0 AND LOCATE(CAST(? AS BINARY),CAST(body AS BINARY),p+1)=0",
    )
    .bind(source).bind(&ctx.space_id).bind(version)
    .bind(source).bind(version)
    .bind(source).bind(&ctx.space_id).bind(version)
    .bind(quote).bind(quote)
    .fetch_optional(tx.connection()).await?;
    Ok(offset.map(|offset| offset as usize))
}

// 定点窗口读取（05接续C）：与read_source_in_tx同一钉住/回退/缺失语义，但只取
// 请求的字符窗口（utf8mb4下SUBSTRING按字符定位，Unicode语义与索引切块一致）、
// 总长度与修订头——不把整篇正文读入进程后再裁剪。窗口数与长度由调用方按
// ≤30命中/≤2400字符的有界集合传入。
pub async fn read_source_window_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    id: &str,
    version: u64,
    windows: &[(usize, usize)],
) -> Result<Value> {
    if !ctx.can_read_platform_source(id) {
        return Err(Error::new("not_available"));
    }
    let current = source_version_in_tx(tx, &ctx.space_id, id).await?;
    let in_current = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM source_current WHERE source_id=? AND space_id=? AND revision=?",
    )
    .bind(id)
    .bind(&ctx.space_id)
    .bind(version)
    .fetch_one(tx.connection())
    .await?;
    let mut sql = sqlx::QueryBuilder::<sqlx::MySql>::new(if in_current > 0 {
        "SELECT CHAR_LENGTH(body) AS total_length, complete"
    } else {
        "SELECT CHAR_LENGTH(body) AS total_length, archive_complete AS complete"
    });
    for (index, (offset, length)) in windows.iter().enumerate() {
        sql.push(", SUBSTRING(body, ")
            .push_bind(*offset as i64 + 1)
            .push(", ")
            .push_bind(*length as i64)
            .push(") AS w")
            .push(index.to_string());
    }
    sql.push(" FROM ");
    if in_current > 0 {
        sql.push("source_current WHERE source_id=")
            .push_bind(id)
            .push(" AND space_id=")
            .push_bind(&ctx.space_id)
            .push(" AND revision=")
            .push_bind(version);
    } else {
        sql.push("source_revisions WHERE body IS NOT NULL AND source_id=")
            .push_bind(id)
            .push(" AND version=")
            .push_bind(version);
    }
    let row = sql
        .build()
        .fetch_optional(tx.connection())
        .await?
        .ok_or(Error::new("not_available"))?;
    let name: Option<String> = sqlx::query_scalar("SELECT COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.name')),external_id) FROM source_current WHERE source_id=? AND space_id=?")
        .bind(id).bind(&ctx.space_id).fetch_optional(tx.connection()).await?.flatten();
    let texts = windows
        .iter()
        .enumerate()
        .map(|(index, (offset, length))| {
            json!([
                *offset,
                *length,
                row.get::<Option<String>, _>(format!("w{index}").as_str())
                    .unwrap_or_default()
            ])
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "source_id":id,"name":name.unwrap_or_else(||id.to_owned()),"version":version.to_string(),"current_version":current.to_string(),
        "complete":row.get::<bool,_>("complete"),
        "total_length":row.get::<i64,_>("total_length"),
        "texts":texts,
    }))
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
    let retired_version = version + u64::from(old != fp);
    if old != fp {
        if crate::types::retain_public_content_archives()? {
            sqlx::query("INSERT INTO source_revisions(source_id,version,body) VALUES(?,?,?) ON DUPLICATE KEY UPDATE body=COALESCE(source_revisions.body,VALUES(body))")
                .bind(source)
                .bind(version + 1)
                .bind(body)
                .execute(tx.connection())
                .await?;
        }
        sqlx::query("UPDATE source_heads SET version=?,fingerprint=? WHERE id=? AND space_id=?")
            .bind(version + 1)
            .bind(&fp)
            .bind(source)
            .bind(&ctx.space_id)
            .execute(tx.connection())
            .await?;
    }
    let platform = sqlx::query(
        "SELECT namespace,platform_table_id FROM catalog_platform_heads WHERE source_id=? FOR UPDATE",
    )
    .bind(source)
    .fetch_one(tx.connection())
    .await?;
    sqlx::query("INSERT INTO source_current(source_id,space_id,adapter_id,source_kind,namespace,external_id,revision,body,complete,metadata,content_fingerprint,explanation_fingerprint,comparison_method,parsed,observed_metadata) VALUES(?,?,'datasight','table',?,?,?,?,1,JSON_OBJECT(),?,?,'raw_v1',0,JSON_OBJECT()) ON DUPLICATE KEY UPDATE revision=VALUES(revision),body=VALUES(body),complete=VALUES(complete),metadata=VALUES(metadata),content_fingerprint=VALUES(content_fingerprint),explanation_fingerprint=VALUES(explanation_fingerprint),comparison_method=VALUES(comparison_method),parsed=VALUES(parsed)")
        .bind(source).bind(&ctx.space_id).bind(platform.get::<String,_>("namespace")).bind(platform.get::<String,_>("platform_table_id"))
        .bind(retired_version).bind(body).bind(&fp).bind(&fp).execute(tx.connection()).await?;
    if old != fp {
        record_source_revision_in_tx(tx, source, retired_version, &ctx.user_id).await?;
    }
    sqlx::query("UPDATE catalog_platform_heads SET retired=1 WHERE source_id=?")
        .bind(source)
        .execute(tx.connection())
        .await?;
    Ok(())
}

// 首次调用前冻结两阶段材料；兼容已排队但只有首阶段裁剪输入的旧作业。
pub async fn freeze_prefill_input_in_tx(
    tx: &mut AppTx<'_>,
    attempt: &str,
    input: &Value,
) -> Result<()> {
    assert_prefill_active_in_tx(tx, attempt).await?;
    sqlx::query("UPDATE prefill_attempts SET input_json=?,input_fingerprint=? WHERE id=? AND (JSON_EXTRACT(input_json,'$.coverage') IS NULL OR JSON_EXTRACT(input_json,'$.frozen_review_sources') IS NULL)")
        .bind(sqlx::types::Json(input)).bind(fingerprint(input)).bind(attempt).execute(tx.connection()).await?;
    Ok(())
}

// 只在实际修订提交时记录元信息；观测更新和回填不改写原修订的操作者或比较依据。
pub(super) async fn record_source_revision_in_tx(
    tx: &mut AppTx<'_>,
    source: &str,
    version: u64,
    updated_by: &str,
) -> Result<()> {
    sqlx::query("INSERT INTO source_revisions(source_id,version,updated_by,content_fingerprint,explanation_fingerprint,comparison_method,parsed,complete) SELECT source_id,revision,?,content_fingerprint,explanation_fingerprint,comparison_method,parsed,complete FROM source_current WHERE source_id=? AND revision=? ON DUPLICATE KEY UPDATE updated_by=VALUES(updated_by),content_fingerprint=VALUES(content_fingerprint),explanation_fingerprint=VALUES(explanation_fingerprint),comparison_method=VALUES(comparison_method),parsed=VALUES(parsed),complete=VALUES(complete)")
        .bind(updated_by).bind(source).bind(version).execute(tx.connection()).await?;
    Ok(())
}

pub(super) async fn write_current_in_tx(
    tx: &mut AppTx<'_>,
    space: &str,
    source: &str,
    namespace: &str,
    content: (u64, &str, bool, &Value),
    observed: &Value,
) -> Result<()> {
    let (version, body, complete, retained) = content;
    let (fp, parsed) = super::catalog_content::comparison(retained);
    let identity: Option<String> = sqlx::query_scalar("SELECT source_id FROM source_current WHERE space_id=? AND adapter_id='datasight' AND source_kind='table' AND namespace=? AND external_id=? FOR UPDATE")
        .bind(space).bind(namespace).bind(retained["id"].as_str()).fetch_optional(tx.connection()).await?;
    if identity.as_deref().is_some_and(|id| id != source) {
        return Err(Error::new("version_conflict"));
    }
    sqlx::query("INSERT INTO source_current(source_id,space_id,adapter_id,source_kind,namespace,external_id,revision,body,complete,metadata,content_fingerprint,explanation_fingerprint,comparison_method,parsed,observed_metadata) VALUES(?,?,'datasight','table',?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE revision=VALUES(revision),body=VALUES(body),complete=VALUES(complete),metadata=VALUES(metadata),content_fingerprint=VALUES(content_fingerprint),explanation_fingerprint=VALUES(explanation_fingerprint),comparison_method=VALUES(comparison_method),parsed=VALUES(parsed),observed_metadata=VALUES(observed_metadata)")
        .bind(source).bind(space).bind(namespace).bind(retained["id"].as_str()).bind(version).bind(body).bind(complete).bind(sqlx::types::Json(retained))
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
        let current = sqlx::query(
            "SELECT body,complete,metadata,namespace,adapter_id,source_kind FROM source_current WHERE source_id=? AND space_id=? AND revision=? FOR UPDATE",
        )
        .bind(&source)
        .bind(&space)
        .bind(version)
        .fetch_optional(tx.connection())
        .await?;
        let (body, complete) = if let Some(current) = current.as_ref() {
            (
                current.get::<String, _>("body"),
                current.get::<bool, _>("complete"),
            )
        } else {
            sqlx::query_as::<_, (String, bool)>(
                "SELECT body,archive_complete AS complete FROM source_revisions WHERE source_id=? AND version=? AND body IS NOT NULL",
            )
            .bind(&source)
            .bind(version)
            .fetch_optional(tx.connection())
            .await?
            .ok_or(Error::new("not_available"))?
        };
        let catalog = if let Some(current) = current.as_ref()
            && current.get::<String, _>("adapter_id") == "datasight"
            && current.get::<String, _>("source_kind") == "table"
            && current.get::<sqlx::types::Json<Value>, _>("metadata").0["id"].is_string()
        {
            Some((
                current.get::<String, _>("namespace"),
                current.get::<sqlx::types::Json<Value>, _>("metadata"),
            ))
        } else {
            sqlx::query_as::<_, (String, sqlx::types::Json<Value>)>(
                "SELECT namespace,body FROM catalog_table_snapshots WHERE source_id=? AND version=?",
            )
            .bind(&source)
            .bind(version)
            .fetch_optional(tx.connection())
            .await?
        };
        if let Some((namespace, catalog)) = catalog {
            let retained = catalog.0;
            // 回填升级比较方法，不把保留原文里的旧观测覆盖到已经更新的观测值。
            let observed = row
                .get::<Option<sqlx::types::Json<Value>>, _>("observed_metadata")
                .map(|value| value.0)
                .unwrap_or_else(|| retained.clone());
            write_current_in_tx(
                tx,
                &space,
                &source,
                &namespace,
                (version, &body, complete, &retained),
                &observed,
            )
            .await?;
        } else {
            let fp = fingerprint(&json!(&body));
            // 旧合成来源沿原身份；退休来源仍沿已登记的平台外部键。
            let platform = sqlx::query(
                "SELECT namespace,platform_table_id,retired FROM catalog_platform_heads WHERE source_id=?",
            )
            .bind(&source)
            .fetch_optional(tx.connection())
            .await?;
            if platform
                .as_ref()
                .is_some_and(|row| !row.get::<bool, _>("retired"))
            {
                return Err(Error::new("not_available"));
            }
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
                .bind(&source).bind(space).bind(adapter).bind(namespace).bind(external).bind(version).bind(body).bind(complete).bind(&fp).bind(&fp).execute(tx.connection()).await?;
        }
    }
    Ok(rows.len())
}

use super::*;

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

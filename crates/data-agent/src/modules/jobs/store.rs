use crate::{
    persistence::AppTx,
    types::{Error, Result, id},
};
use sqlx::{MySqlPool, Row};
#[derive(Clone)]
pub struct ClaimedJob {
    pub id: String,
    pub conversation_id: String,
    pub message_id: String,
    pub lease_epoch: u64,
    pub worker_id: String,
    pub attempts: u32,
}
pub async fn enqueue_in_tx(tx: &mut AppTx<'_>, cid: &str, message_id: &str) -> Result<()> {
    tx.lock_rank(8)?;
    sqlx::query("INSERT INTO background_jobs(id,conversation_id,message_id) VALUES(?,?,?)")
        .bind(id())
        .bind(cid)
        .bind(message_id)
        .execute(tx.connection())
        .await?;
    Ok(())
}
pub async fn claim_due(
    pool: &MySqlPool,
    worker_id: &str,
    ttl_ms: u32,
) -> Result<Option<ClaimedJob>> {
    let mut tx = AppTx::begin(pool).await?;
    tx.lock_rank(8)?;
    let row=sqlx::query("SELECT b.* FROM background_jobs b WHERE b.kind='message' AND b.schema_version=1 AND ((b.state='queued' AND (b.lease_until IS NULL OR b.lease_until<=UTC_TIMESTAMP(3))) OR (b.state='running' AND b.lease_until<=UTC_TIMESTAMP(3))) AND NOT EXISTS (SELECT 1 FROM background_jobs earlier WHERE earlier.conversation_id=b.conversation_id AND earlier.dispatch_seq<b.dispatch_seq AND earlier.state IN ('queued','running')) ORDER BY b.dispatch_seq LIMIT 1 FOR UPDATE SKIP LOCKED").fetch_optional(tx.connection()).await?;
    if let Some(row) = row {
        let job = ClaimedJob {
            id: row.get("id"),
            conversation_id: row.get("conversation_id"),
            message_id: row.get("message_id"),
            lease_epoch: row.get::<u64, _>("lease_epoch") + 1,
            worker_id: worker_id.into(),
            attempts: row.get("attempts"),
        };
        sqlx::query("UPDATE background_jobs SET state='running',lease_owner=?,lease_epoch=?,lease_until=TIMESTAMPADD(MICROSECOND,?,UTC_TIMESTAMP(3)) WHERE id=?").bind(worker_id).bind(job.lease_epoch).bind(ttl_ms*1000).bind(&job.id).execute(tx.connection()).await?;
        tx.commit().await?;
        return Ok(Some(job));
    }
    tx.commit().await?;
    Ok(None)
}
pub async fn assert_job_in_tx(tx: &mut AppTx<'_>, job_id: &str, epoch: u64) -> Result<()> {
    tx.lock_rank(8)?;
    let row=sqlx::query("SELECT lease_epoch,state,COALESCE(lease_until>UTC_TIMESTAMP(3),0) AS valid FROM background_jobs WHERE id=? FOR UPDATE").bind(job_id).fetch_optional(tx.connection()).await?.ok_or(Error::new("not_available"))?;
    if row.get::<u64, _>("lease_epoch") != epoch
        || row.get::<String, _>("state") != "running"
        || row.get::<i64, _>("valid") == 0
    {
        return Err(Error::new("lease_lost"));
    }
    Ok(())
}

// 运行尚未建立时只续领取身份，不锁会话；过期或已换代绝不能续活。
pub async fn renew_claim(pool: &MySqlPool, job: &ClaimedJob, ttl_ms: u32) -> Result<()> {
    let changed = sqlx::query("UPDATE background_jobs SET lease_until=TIMESTAMPADD(MICROSECOND,?,UTC_TIMESTAMP(3)) WHERE id=? AND lease_owner=? AND lease_epoch=? AND state='running' AND lease_until>UTC_TIMESTAMP(3)")
        .bind(ttl_ms * 1000).bind(&job.id).bind(&job.worker_id).bind(job.lease_epoch)
        .execute(pool).await?;
    if changed.rows_affected() != 1 {
        return Err(Error::new("lease_lost"));
    }
    Ok(())
}
pub async fn settle_in_tx(tx: &mut AppTx<'_>, job_id: &str, epoch: u64) -> Result<()> {
    assert_job_in_tx(tx, job_id, epoch).await?;
    sqlx::query(
        "UPDATE background_jobs SET state='finished',lease_owner=NULL,lease_until=NULL WHERE id=?",
    )
    .bind(job_id)
    .execute(tx.connection())
    .await?;
    Ok(())
}
pub async fn renew_lease_in_tx(
    tx: &mut AppTx<'_>,
    job_id: &str,
    epoch: u64,
    ttl_ms: u32,
) -> Result<()> {
    assert_job_in_tx(tx, job_id, epoch).await?;
    let changed = sqlx::query("UPDATE background_jobs SET lease_until=TIMESTAMPADD(MICROSECOND,?,UTC_TIMESTAMP(3)) WHERE id=? AND lease_epoch=? AND state='running' AND lease_until>UTC_TIMESTAMP(3)")
        .bind(ttl_ms*1000).bind(job_id).bind(epoch).execute(tx.connection()).await?;
    if changed.rows_affected() != 1 {
        return Err(Error::new("lease_lost"));
    }
    Ok(())
}

pub async fn begin_attempt_in_tx(tx: &mut AppTx<'_>, job: &ClaimedJob) -> Result<()> {
    assert_job_in_tx(tx, &job.id, job.lease_epoch).await?;
    sqlx::query("UPDATE background_jobs SET attempts=attempts+1 WHERE id=? AND attempts<4")
        .bind(&job.id)
        .execute(tx.connection())
        .await?;
    Ok(())
}
pub async fn defer(pool: &MySqlPool, job: &ClaimedJob) -> Result<()> {
    let mut tx = AppTx::begin(pool).await?;
    if let Err(error) = assert_job_in_tx(&mut tx, &job.id, job.lease_epoch).await {
        if error.code == "lease_lost" {
            return tx.commit().await;
        }
        return Err(error);
    }
    sqlx::query("UPDATE background_jobs SET state='queued',lease_owner=NULL,lease_until=TIMESTAMPADD(MICROSECOND,200000,UTC_TIMESTAMP(3)) WHERE id=?")
        .bind(&job.id).execute(tx.connection()).await?;
    tx.commit().await
}
pub async fn defer_unaccepted_in_tx(tx: &mut AppTx<'_>, job_id: &str, epoch: u64) -> Result<()> {
    assert_job_in_tx(tx, job_id, epoch).await?;
    // Bridge明确未接纳，只退回本次尝试；原有失败次数、消息和模型账本不变。
    sqlx::query("UPDATE background_jobs SET attempts=attempts-1,state='queued',lease_owner=NULL,lease_until=TIMESTAMPADD(MICROSECOND,200000,UTC_TIMESTAMP(3)) WHERE id=? AND attempts>0")
        .bind(job_id).execute(tx.connection()).await?;
    Ok(())
}
pub async fn fail_in_tx(tx: &mut AppTx<'_>, job: &ClaimedJob) -> Result<()> {
    assert_job_in_tx(tx, &job.id, job.lease_epoch).await?;
    sqlx::query(
        "UPDATE background_jobs SET state='failed',lease_owner=NULL,lease_until=NULL WHERE id=?",
    )
    .bind(&job.id)
    .execute(tx.connection())
    .await?;
    Ok(())
}

pub async fn cancel_message_job_in_tx(tx: &mut AppTx<'_>, message_id: &str) -> Result<()> {
    tx.lock_rank(8)?;
    sqlx::query("UPDATE background_jobs SET state='cancelled',lease_owner=NULL,lease_until=NULL WHERE message_id=? AND state IN ('queued','running')").bind(message_id).execute(tx.connection()).await?;
    Ok(())
}
pub async fn resume_message_job_in_tx(
    tx: &mut AppTx<'_>,
    message: &str,
    interrupted_epoch: Option<u64>,
) -> Result<()> {
    tx.lock_rank(8)?;
    // 用户中断只退回本次正在运行的尝试，保留此前失败次数和原模型账本。
    sqlx::query("UPDATE background_jobs SET attempts=IF(lease_epoch=? AND state='running' AND attempts>0,attempts-1,attempts),state='queued',lease_epoch=lease_epoch+1,lease_owner=NULL,lease_until=NULL WHERE message_id=? AND state IN ('queued','running','failed','cancelled')")
        .bind(interrupted_epoch).bind(message).execute(tx.connection()).await?;
    Ok(())
}

// 来源业务由M03保存；这里仍只负责原队列的调度身份与租约。
#[derive(Clone)]
pub struct SourceJob {
    pub lease: ClaimedJob,
    pub resource_id: String,
    pub resource_version: Option<u64>,
}
pub async fn enqueue_source_in_tx(
    tx: &mut AppTx<'_>,
    kind: &str,
    resource: &str,
    version: u64,
) -> Result<()> {
    tx.lock_rank(8)?;
    let schema = if kind == "source_sync" { 1 } else { 2 };
    sqlx::query("INSERT IGNORE INTO background_jobs(id,kind,schema_version,resource_id,resource_version) VALUES(?,?,?,?,?)")
        .bind(id()).bind(kind).bind(schema).bind(resource).bind(version).execute(tx.connection()).await?;
    Ok(())
}
// 重开终态来源作业：finished与failed都翻回queued并清租约重置尝试，在途
// （running/queued）作业保持原状，不允许同一作业被双份推进。failed只发生在
// 调用侧已确认失败（重试耗尽/成果不合法）的路径——unknown回执的预算预留
// 由调用方按准备行终态先判定，不靠本函数兜底。
pub async fn requeue_terminal_source_in_tx(
    tx: &mut AppTx<'_>,
    kind: &str,
    resource: &str,
    version: u64,
) -> Result<()> {
    tx.lock_rank(8)?;
    // MySQL的UPDATE赋值从左到右生效：state放最后，前面的条件才能读到原值。
    sqlx::query(
        "INSERT INTO background_jobs(id,kind,schema_version,resource_id,resource_version) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE attempts=IF(state IN ('finished','failed'),0,attempts),lease_owner=IF(state IN ('finished','failed'),NULL,lease_owner),lease_until=IF(state IN ('finished','failed'),NULL,lease_until),state=IF(state IN ('finished','failed'),'queued',state)",
    )
    .bind(id())
    .bind(kind)
    .bind(if kind == "source_sync" { 1 } else { 2 })
    .bind(resource)
    .bind(version)
    .execute(tx.connection())
    .await?;
    Ok(())
}
pub async fn claim_source_sync(
    pool: &MySqlPool,
    worker: &str,
    ttl: u32,
) -> Result<Option<SourceJob>> {
    let mut tx = AppTx::begin(pool).await?;
    let row = sqlx::query("SELECT * FROM background_jobs WHERE kind='source_sync' AND schema_version=1 AND state IN ('queued','running') AND (lease_until IS NULL OR lease_until<=UTC_TIMESTAMP(3)) ORDER BY dispatch_seq LIMIT 1 FOR UPDATE SKIP LOCKED")
        .fetch_optional(tx.connection()).await?;
    let Some(row) = row else {
        tx.commit().await?;
        return Ok(None);
    };
    let lease = ClaimedJob {
        id: row.get("id"),
        conversation_id: String::new(),
        message_id: String::new(),
        lease_epoch: row.get::<u64, _>("lease_epoch") + 1,
        worker_id: worker.into(),
        attempts: row.get("attempts"),
    };
    sqlx::query("UPDATE background_jobs SET state='running',lease_owner=?,lease_epoch=?,lease_until=TIMESTAMPADD(MICROSECOND,?,UTC_TIMESTAMP(3)) WHERE id=?")
        .bind(worker).bind(lease.lease_epoch).bind(ttl*1000).bind(&lease.id).execute(tx.connection()).await?;
    let job = SourceJob {
        lease,
        resource_id: row.get("resource_id"),
        resource_version: None,
    };
    tx.commit().await?;
    Ok(Some(job))
}

// 领取具名schema-2来源作业（如prepare_source）；只认识该kind的消费者才会领取。
pub async fn claim_source_work(
    pool: &MySqlPool,
    worker: &str,
    ttl: u32,
    kind: &str,
) -> Result<Option<SourceJob>> {
    let mut tx = AppTx::begin(pool).await?;
    tx.lock_rank(8)?;
    let row = sqlx::query("SELECT * FROM background_jobs WHERE kind=? AND schema_version=2 AND state IN ('queued','running') AND (lease_until IS NULL OR lease_until<=UTC_TIMESTAMP(3)) ORDER BY dispatch_seq LIMIT 1 FOR UPDATE SKIP LOCKED")
        .bind(kind).fetch_optional(tx.connection()).await?;
    let Some(row) = row else {
        tx.commit().await?;
        return Ok(None);
    };
    let lease = ClaimedJob {
        id: row.get("id"),
        conversation_id: String::new(),
        message_id: String::new(),
        lease_epoch: row.get::<u64, _>("lease_epoch") + 1,
        worker_id: worker.into(),
        attempts: row.get("attempts"),
    };
    sqlx::query("UPDATE background_jobs SET state='running',lease_owner=?,lease_epoch=?,lease_until=TIMESTAMPADD(MICROSECOND,?,UTC_TIMESTAMP(3)) WHERE id=?")
        .bind(worker).bind(lease.lease_epoch).bind(ttl*1000).bind(&lease.id).execute(tx.connection()).await?;
    let job = SourceJob {
        lease,
        resource_id: row.get("resource_id"),
        resource_version: row.get::<Option<u64>, _>("resource_version"),
    };
    tx.commit().await?;
    Ok(Some(job))
}
pub async fn release_source_page_in_tx(tx: &mut AppTx<'_>, job: &SourceJob) -> Result<()> {
    assert_job_in_tx(tx, &job.lease.id, job.lease.lease_epoch).await?;
    sqlx::query("UPDATE background_jobs SET state='queued',attempts=0,lease_owner=NULL,lease_until=NULL WHERE id=?")
        .bind(&job.lease.id).execute(tx.connection()).await?;
    Ok(())
}
pub async fn source_work_progress_in_tx(
    tx: &mut AppTx<'_>,
    kind: &str,
    sources: &[(String, u64)],
) -> Result<serde_json::Value> {
    let (mut total, mut complete, mut failed, mut running) = (0u64, 0u64, 0u64, false);
    for (source, revision) in sources {
        let state: Option<String> = sqlx::query_scalar("SELECT state FROM background_jobs WHERE kind=? AND resource_id=? AND resource_version=?")
            .bind(kind).bind(source).bind(revision).fetch_optional(tx.connection()).await?;
        total += 1;
        match state.as_deref() {
            Some("finished") => complete += 1,
            Some("failed") => failed += 1,
            Some("running") => running = true,
            _ => {}
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
    Ok(serde_json::json!({"status":status,"total":total,"completed":complete,"failed":failed}))
}

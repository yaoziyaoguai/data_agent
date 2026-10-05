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
    let row=sqlx::query("SELECT b.* FROM background_jobs b WHERE ((b.state='queued' AND (b.lease_until IS NULL OR b.lease_until<=UTC_TIMESTAMP(3))) OR (b.state='running' AND b.lease_until<=UTC_TIMESTAMP(3))) AND NOT EXISTS (SELECT 1 FROM background_jobs earlier WHERE earlier.conversation_id=b.conversation_id AND earlier.dispatch_seq<b.dispatch_seq AND earlier.state IN ('queued','running')) ORDER BY b.dispatch_seq LIMIT 1 FOR UPDATE SKIP LOCKED").fetch_optional(tx.connection()).await?;
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
    sqlx::query("UPDATE background_jobs SET lease_until=TIMESTAMPADD(MICROSECOND,?,UTC_TIMESTAMP(3)) WHERE id=?").bind(ttl_ms*1000).bind(job_id).execute(tx.connection()).await?;
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

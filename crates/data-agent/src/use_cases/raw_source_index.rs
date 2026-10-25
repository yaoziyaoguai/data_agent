use crate::{
    contracts::generated::{SourceKey, SourceKeyKind},
    modules::{
        ingestion, jobs,
        retrieval::{
            source_segments::{self, SegmentCursor, SourceFormat, SourceText},
            vector,
        },
    },
    persistence::AppTx,
    types::{AccessContext, Error, Result, fingerprint, id},
};
use serde_json::json;
use sqlx::{MySqlPool, Row};
use std::time::Duration;

// 05切片3：raw_source_index队列消费者。原文无需等待模型整理即可进入索引；
// 整理pending/failed的来源同样按输入修订索引。作业沿background_jobs的
// kind='raw_source_index'/schema_version=2判别，只有认识该目标的消费者领取，
// 知识索引消费者不会误领、误标完成或耗尽重试。
pub async fn process_due(pool: &MySqlPool) -> Result<bool> {
    if !vector::enabled() {
        return Ok(false);
    }
    // 嵌入预算缺失或不合法时作业保持真实pending，不伪失败（与整理消费者同口径）。
    match super::knowledge_embeddings::maintenance_profile() {
        Ok(Some(_)) => {}
        Ok(None) => return Ok(false),
        Err(error) if error.code == "invalid_input" => return Ok(false),
        Err(error) => return Err(error),
    }
    let worker = id();
    let (_, lease_seconds) = ingestion::prefill::timing()?;
    let ttl_ms = u32::try_from(lease_seconds * 1000).map_err(|_| Error::new("invalid_input"))?;
    let Some(job) = jobs::claim_source_work(pool, &worker, ttl_ms, "raw_source_index").await?
    else {
        return Ok(false);
    };
    // 嵌入与向量写入都在锁外且可能多批：持续续租，租约不由批数决定。
    let heartbeat = async {
        let mut interval = tokio::time::interval(Duration::from_millis(u64::from(ttl_ms / 3)));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            if let Err(error) = jobs::renew_claim(pool, &job.lease, ttl_ms).await
                && !error.is_transient_storage()
            {
                return error;
            }
        }
    };
    let result = tokio::select! {
        result = index_source(pool, &job) => result,
        error = heartbeat => Err(error),
    };
    if let Err(error) = result {
        if error.code == "lease_lost" {
            return Ok(true);
        }
        let transient = error.is_transient_storage();
        if transient && job.lease.attempts < 2 {
            let mut tx = AppTx::begin(pool).await?;
            jobs::begin_attempt_in_tx(&mut tx, &job.lease).await?;
            tx.commit().await?;
            jobs::defer(pool, &job.lease).await?;
        } else {
            let mut tx = AppTx::begin(pool).await?;
            jobs::fail_in_tx(&mut tx, &job.lease).await?;
            tx.commit().await?;
        }
        return Err(error);
    }
    Ok(true)
}

async fn index_source(pool: &MySqlPool, job: &jobs::SourceJob) -> Result<()> {
    let source_id = job.resource_id.clone();
    let revision = job
        .resource_version
        .ok_or_else(|| Error::new("invalid_input"))?;
    let revision_text = revision.to_string();
    let mut tx = AppTx::begin(pool).await?;
    // document-来源的正文与版本由文档对象持有，不在source_heads登记。
    let head = if let Some(document) = super::knowledge_sources::document_id(&source_id) {
        sqlx::query("SELECT space_id,version FROM knowledge_objects WHERE id=? AND state='enabled'")
            .bind(document)
            .fetch_optional(tx.connection())
            .await?
            .map(|row| {
                (
                    row.get::<String, _>("space_id"),
                    row.get::<u64, _>("version"),
                )
            })
    } else {
        sqlx::query("SELECT space_id,version FROM source_heads WHERE id=?")
            .bind(&source_id)
            .fetch_optional(tx.connection())
            .await?
            .map(|row| {
                (
                    row.get::<String, _>("space_id"),
                    row.get::<u64, _>("version"),
                )
            })
    };
    let Some((space, current)) = head else {
        // 来源已不存在或已退休：本修订没有可索引正文，直接结束作业。
        jobs::settle_in_tx(&mut tx, &job.lease.id, job.lease.lease_epoch).await?;
        tx.commit().await?;
        return Ok(());
    };
    let ctx = AccessContext {
        user_id: "synthetic-raw-index".into(),
        space_id: space,
        request_id: job.lease.id.clone(),
    };
    if current > revision {
        // 来源已有更新修订：新修订作业负责索引并在完成后清理旧摘录；旧修订不再
        // 花嵌入预算，也不把被取代的修订写成当前投影。
        jobs::settle_in_tx(&mut tx, &job.lease.id, job.lease.lease_epoch).await?;
        tx.commit().await?;
        return Ok(());
    }
    let value =
        super::knowledge_sources::read_in_tx(&mut tx, &ctx, &source_id, Some(revision)).await?;
    tx.commit().await?;
    if value["version"].as_str() != Some(revision_text.as_str()) {
        return Err(Error::new("stale_source"));
    }
    if value["complete"] != true {
        // 分页正文未完成：作业保持running让租约自然到期后重试，不在半途正文上
        // 建立索引，也不把等待页面的作业打成失败。
        return Ok(());
    }
    let document = super::knowledge_sources::document_id(&source_id);
    let key = match document {
        Some(id) => SourceKey {
            kind: SourceKeyKind::Document,
            id: id.to_owned(),
        },
        None => SourceKey {
            kind: SourceKeyKind::Platform,
            id: source_id.clone(),
        },
    };
    let body = value["body"].as_str().unwrap_or("").to_owned();
    let source = SourceText {
        source: &key,
        revision: &revision_text,
        text: &body,
        format: if document.is_some() {
            SourceFormat::Markdown
        } else {
            SourceFormat::Sql
        },
        background: &[],
    };
    // 确定性切块持续至结束；每批写入幂等（键绑定来源/修订/位置/切块版本），
    // 中断后重试经共享嵌入缓存回放，不重复计费。
    let mut cursor: Option<SegmentCursor> = None;
    loop {
        let batch = source_segments::segment_source(&source, cursor.as_ref())?;
        if batch.segments.is_empty() {
            break;
        }
        vector::apply_source_excerpts(&ctx.space_id, &batch.segments, |_, texts| {
            let ctx = &ctx;
            let source = source_id.as_str();
            // 指纹随批次文本计算并由绑定持有：回调返回的future不能借用闭包环境，
            // 操作身份也由此与具体文本一一对应，跳批/换序不会共用身份。
            let fp = fingerprint(&json!(&texts));
            async move {
                super::knowledge_embeddings::embed(
                    pool,
                    ctx,
                    super::knowledge_embeddings::Binding::RawIndex(source, revision, fp),
                    texts,
                )
                .await
            }
        })
        .await?;
        match batch.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    // 当前修订已写入：删除更旧修订的摘录，晚到作业不能回退当前投影。
    vector::drop_source_excerpts(&ctx.space_id, &source_id, revision).await?;
    let mut tx = AppTx::begin(pool).await?;
    jobs::settle_in_tx(&mut tx, &job.lease.id, job.lease.lease_epoch).await?;
    tx.commit().await?;
    Ok(())
}

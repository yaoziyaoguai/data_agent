use crate::{
    contracts::generated::{SourceKey, SourceKeyKind},
    modules::{
        ingestion, jobs, knowledge,
        retrieval::source_segments::{
            self, SegmentCursor, SourceFormat, SourceText, prefix_by_char_budget,
        },
        runtime,
    },
    persistence::AppTx,
    types::{AccessContext, Error, Result, fingerprint, id},
};
use serde_json::{Value, json};
use sqlx::MySqlPool;
use std::time::Duration;

// 后台来源整理：按修订分批消费prepare_source作业，分析/复核复用原维护预算与
// 稳定调用身份；unknown调用不换ID重发，覆盖未完成不宣称语义ready。
pub async fn process_due(pool: &MySqlPool) -> Result<bool> {
    // 维护模型配置缺失或不合法时整理无法执行：作业保持真实pending，不伪失败。
    if let Err(error) = ingestion::prefill::maintenance_profile() {
        if error.code == "budget_unavailable" || error.code == "invalid_input" {
            return Ok(false);
        }
        return Err(error);
    }
    let worker = id();
    let (_, lease_seconds) = ingestion::prefill::timing()?;
    let mut tx = AppTx::begin(pool).await?;
    ingestion::preparation::expire_issued_preparations_in_tx(&mut tx).await?;
    tx.commit().await?;
    let Some(job) =
        jobs::claim_source_work(pool, &worker, lease_seconds as u32 * 1000, "prepare_source")
            .await?
    else {
        return Ok(false);
    };
    // 分析/复核各一次模型调用且都在锁外；持续续租，租约不由请求时长决定。
    let renewal_ms =
        u32::try_from(lease_seconds * 1000).map_err(|_| Error::new("invalid_input"))?;
    let heartbeat = async {
        let mut interval = tokio::time::interval(Duration::from_millis(lease_seconds * 333));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            if let Err(error) = jobs::renew_claim(pool, &job.lease, renewal_ms).await
                && !error.is_transient_storage()
            {
                return error;
            }
        }
    };
    let result = tokio::select! {
        result = prepare_source(pool, &job) => result,
        error = heartbeat => Err(error),
    };
    if let Err(error) = result {
        if error.code == "lease_lost" || error.code == "busy" {
            return Ok(true);
        }
        // 终态会清掉冻结输入、草稿与阶段，先输出受控诊断，不保留模型正文。
        let context = error
            .message
            .as_deref()
            .filter(|message| message.starts_with("stage="))
            .unwrap_or("stage=preparation sequence=unknown call=unknown");
        eprintln!(
            "source_preparation_failure source={} revision={:?} method={} code={} {}",
            job.resource_id,
            job.resource_version,
            ingestion::preparation::PREPARATION_METHOD,
            error.code,
            context
        );
        let transient = error.is_transient_storage();
        if transient && job.lease.attempts < 2 {
            let mut tx = AppTx::begin(pool).await?;
            jobs::begin_attempt_in_tx(&mut tx, &job.lease).await?;
            tx.commit().await?;
            jobs::defer(pool, &job.lease).await?;
        } else {
            let mut tx = AppTx::begin(pool).await?;
            jobs::fail_in_tx(&mut tx, &job.lease).await?;
            if let Some(revision) = job.resource_version {
                ingestion::preparation::fail_preparation_in_tx(
                    &mut tx,
                    &job.resource_id,
                    revision,
                    error.code,
                )
                .await?;
                if let Some((space_id, _)) =
                    super::knowledge_sources::resolve_source_head_in_tx(&mut tx, &job.resource_id)
                        .await?
                {
                    tx.notify(crate::live_changes::Change::Catalog { space_id });
                }
            }
            tx.commit().await?;
        }
    }
    Ok(true)
}

// 只接回本整理校验器生成的reason；其他模块的任意错误正文不进入日志。
fn stage_failure(mut error: Error, stage: &str, sequence: u64, call: &str) -> Error {
    let reason = error
        .message
        .take()
        .filter(|message| message.starts_with("reason="))
        .unwrap_or_else(|| format!("reason={}", error.code));
    error.with_message(format!(
        "stage={stage} sequence={sequence} call={call} {reason}"
    ))
}

async fn prepare_source(pool: &MySqlPool, job: &jobs::SourceJob) -> Result<()> {
    let source_id = job.resource_id.clone();
    let Some(revision) = job.resource_version else {
        return Err(Error::new("invalid_input"));
    };
    let revision_text = revision.to_string();
    let (_, lease_seconds) = ingestion::prefill::timing()?;
    let mut budget = ingestion::preparation::BATCH_CHAR_BUDGET;
    loop {
        let mut tx = AppTx::begin(pool).await?;
        jobs::assert_job_in_tx(&mut tx, &job.lease.id, job.lease.lease_epoch).await?;
        // 来源当前头：document-来源由文档对象持有，平台来源在source_heads。
        let head = super::knowledge_sources::resolve_source_head_in_tx(&mut tx, &source_id).await?;
        let Some((space, current)) = head else {
            // 来源已失效：原准备与后台作业同事务结束，释放不再应用的冻结材料。
            ingestion::preparation::supersede_preparation_in_tx(&mut tx, &source_id, revision)
                .await?;
            jobs::settle_in_tx(&mut tx, &job.lease.id, job.lease.lease_epoch).await?;
            tx.commit().await?;
            return Ok(());
        };
        let ctx = AccessContext {
            user_id: "synthetic-preparation".into(),
            space_id: space,
            request_id: job.lease.id.clone(),
            table_access: None,
        };
        // 文档来源按Markdown分段，平台来源按SQL结构分段；引用身份随来源种类表达。
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
        if current > revision {
            // 来源已有更新修订，新作业随新修订入队；本修订不再重复整理，
            // 未完成的准备标记被取代，不留在pending冒充处理中。
            ingestion::preparation::supersede_preparation_in_tx(&mut tx, &source_id, revision)
                .await?;
            jobs::settle_in_tx(&mut tx, &job.lease.id, job.lease.lease_epoch).await?;
            tx.commit().await?;
            return Ok(());
        }
        let row = match ingestion::preparation::read_preparation_in_tx(
            &mut tx,
            &ctx.space_id,
            &source_id,
            revision,
        )
        .await?
        {
            Some(row) => row,
            None => {
                let body = source_body_in_tx(&mut tx, &ctx, &source_id, revision).await?;
                let objects = knowledge::source_objects_in_tx(&mut tx, &ctx, &source_id).await?;
                ingestion::preparation::ensure_preparation_in_tx(
                    &mut tx,
                    &ctx.space_id,
                    &source_id,
                    revision,
                    &input_fingerprint(&source_id, revision, &body),
                    &ingestion::preparation::dependency_fingerprint(&objects),
                )
                .await?;
                tx.commit().await?;
                continue;
            }
        };
        if row["semantic_status"] == "failed" || row["semantic_status"] == "ready" {
            jobs::settle_in_tx(&mut tx, &job.lease.id, job.lease.lease_epoch).await?;
            tx.commit().await?;
            return Ok(());
        }
        if row["call_state"] == "applying" {
            // 复核成果已持久化：前次应用事务回滚（死锁、瞬时断库）后重试从已提交
            // 输出恢复应用，不重发模型调用，账目不新增。
            let frozen = row["frozen_batch"].clone();
            let output = row["pending_draft"].clone();
            if frozen.is_null() || output.is_null() {
                // 成果残缺不可恢复：清批按新调用身份重整，不停摆在半途状态。
                tx.commit().await?;
                let mut retry = AppTx::begin(pool).await?;
                jobs::assert_job_in_tx(&mut retry, &job.lease.id, job.lease.lease_epoch).await?;
                ingestion::preparation::reset_batch_in_tx(&mut retry, &source_id, revision).await?;
                retry.commit().await?;
                continue;
            }
            let sequence = row["batch_sequence"].as_u64().unwrap_or(0);
            let call = ingestion::preparation::review_call_id(&source_id, revision, sequence);
            ingestion::preparation::validate_preparation_output(
                &serde_json::to_value(&key).map_err(|_| Error::new("invalid_input"))?,
                &revision_text,
                &frozen,
                &output,
            )
            .map_err(|error| stage_failure(error, "apply", sequence, &call))?;
            tx.commit().await?;
            let batch = PendingBatch {
                frozen,
                output,
                dependency: row["dependency_fingerprint"]
                    .as_str()
                    .unwrap_or("")
                    .to_owned(),
                unresolved_prior: row["unresolved"].clone(),
                // 应用身份沿产生该成果的持久批次序列，恢复不换身份。
                sequence,
            };
            if apply_and_advance(pool, job, &ctx, &source_id, revision, &key, &batch)
                .await
                .map_err(|error| stage_failure(error, "apply", sequence, &call))?
            {
                return Ok(());
            }
            continue;
        }
        if matches!(
            row["call_state"].as_str(),
            Some("analysis" | "review" | "unknown")
        ) && row["lease_valid"] == true
            && row["call_state"] != "unknown"
        {
            // 在途调用的结果尚未确定：不接手、不重发，等待租约到期按unknown处理。
            tx.commit().await?;
            jobs::defer(pool, &job.lease).await?;
            return Err(Error::new("busy"));
        }
        if matches!(row["call_state"].as_str(), Some("analysis" | "review"))
            && row["lease_valid"] != true
        {
            // 过期清扫与本次读取的边界竞态：行已越过issued窗口但尚未被清扫改写，
            // 与过期清扫同一语义按unknown终态处理，不把它误标成version_conflict。
            tx.commit().await?;
            let sequence = row["batch_sequence"].as_u64().unwrap_or(0);
            let stage = row["call_state"].as_str().unwrap_or("unknown");
            let call = if stage == "review" {
                ingestion::preparation::review_call_id(&source_id, revision, sequence)
            } else {
                ingestion::preparation::analysis_call_id(&source_id, revision, sequence)
            };
            return Err(stage_failure(
                Error::new("model_unknown"),
                stage,
                sequence,
                &call,
            ));
        }
        if row["call_state"] == "unknown" {
            // 过期清扫已丢失原阶段，不能把候选调用身份冒充已知analysis/review。
            tx.commit().await?;
            return Err(stage_failure(
                Error::new("model_unknown"),
                "unknown",
                row["batch_sequence"].as_u64().unwrap_or(0),
                "unknown",
            ));
        }
        let body = source_body_in_tx(&mut tx, &ctx, &source_id, revision).await?;
        if row["input_fingerprint"] != input_fingerprint(&source_id, revision, &body) {
            return Err(Error::new("invalid_input"));
        }
        let all_objects = knowledge::source_objects_in_tx(&mut tx, &ctx, &source_id).await?;
        // 依赖指纹覆盖该来源全部对象的当前有效依赖内容，与冻结清单是否截断无关。
        let dependency = ingestion::preparation::dependency_fingerprint(&all_objects);
        let objects = ingestion::preparation::truncate_objects(all_objects);
        tx.commit().await?;
        let profile = ingestion::prefill::maintenance_profile()?;
        crate::modules::access::authorize_model("deepseek")?;
        runtime::configure_trial(pool, &profile).await?;

        let cursor: Option<SegmentCursor> = if row["segment_cursor"].is_null() {
            None
        } else {
            serde_json::from_value(row["segment_cursor"].clone())
                .map_err(|_| Error::new("invalid_input"))?
        };
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
        let batch = source_segments::segment_source(&source, cursor.as_ref())?;
        let mut frozen = freeze_batch(&batch, budget, &key, &revision_text, &objects, &row)?;
        let analysis = loop {
            match ingestion::preparation::prepare_preparation_submission(&frozen, None) {
                Ok(prepared) => break prepared,
                Err(error) if error.code == "payload_limit" => {
                    let next = (budget / 2).max(ingestion::preparation::MIN_BATCH_CHARS);
                    if next == budget {
                        return Err(error);
                    }
                    budget = next;
                    frozen = freeze_batch(&batch, budget, &key, &revision_text, &objects, &row)?;
                }
                Err(error) => return Err(error),
            }
        };
        let sequence = row["batch_sequence"].as_u64().unwrap_or(0) + 1;
        let analysis_call =
            ingestion::preparation::analysis_call_id(&source_id, revision, sequence);
        let mut tx = AppTx::begin(pool).await?;
        jobs::assert_job_in_tx(&mut tx, &job.lease.id, job.lease.lease_epoch).await?;
        ingestion::preparation::begin_batch_in_tx(
            &mut tx,
            &source_id,
            revision,
            &frozen,
            &dependency,
            lease_seconds,
        )
        .await?;
        runtime::reserve_maintenance_in_tx(&mut tx, &analysis_call, &profile).await?;
        tx.commit().await?;

        let (draft, usage) = analysis
            .analyze()
            .await
            .map_err(|error| stage_failure(error, "analysis", sequence, &analysis_call))?;
        let mut tx = AppTx::begin(pool).await?;
        let settled =
            runtime::settle_maintenance_in_tx(&mut tx, &analysis_call, &profile, &usage).await;
        tx.commit().await?;
        settled.map_err(|error| stage_failure(error, "analysis", sequence, &analysis_call))?;
        ingestion::preparation::validate_preparation_output(
            &serde_json::to_value(&key).map_err(|_| Error::new("invalid_input"))?,
            &revision_text,
            &frozen,
            &draft,
        )
        .map_err(|error| stage_failure(error, "analysis", sequence, &analysis_call))?;

        let review_call = ingestion::preparation::review_call_id(&source_id, revision, sequence);
        let review = ingestion::preparation::prepare_preparation_submission(&frozen, Some(&draft))
            .map_err(|error| stage_failure(error, "review", sequence, &review_call))?;
        let mut tx = AppTx::begin(pool).await?;
        jobs::assert_job_in_tx(&mut tx, &job.lease.id, job.lease.lease_epoch).await?;
        ingestion::preparation::stage_draft_in_tx(
            &mut tx,
            &source_id,
            revision,
            &draft,
            lease_seconds,
        )
        .await?;
        runtime::reserve_maintenance_in_tx(&mut tx, &review_call, &profile).await?;
        tx.commit().await?;

        let (output, usage) = review
            .analyze()
            .await
            .map_err(|error| stage_failure(error, "review", sequence, &review_call))?;
        let mut tx = AppTx::begin(pool).await?;
        let settled =
            runtime::settle_maintenance_in_tx(&mut tx, &review_call, &profile, &usage).await;
        tx.commit().await?;
        settled.map_err(|error| stage_failure(error, "review", sequence, &review_call))?;
        ingestion::preparation::validate_preparation_output(
            &serde_json::to_value(&key).map_err(|_| Error::new("invalid_input"))?,
            &revision_text,
            &frozen,
            &output,
        )
        .map_err(|error| stage_failure(error, "review", sequence, &review_call))?;

        // 复核成果先落库再应用：应用事务此后回滚时重试从已提交输出恢复。
        let mut tx = AppTx::begin(pool).await?;
        jobs::assert_job_in_tx(&mut tx, &job.lease.id, job.lease.lease_epoch).await?;
        ingestion::preparation::stage_apply_in_tx(&mut tx, &source_id, revision, &output)
            .await
            .map_err(|error| stage_failure(error, "apply", sequence, &review_call))?;
        tx.commit().await?;
        let batch = PendingBatch {
            frozen,
            output,
            dependency,
            unresolved_prior: row["unresolved"].clone(),
            sequence,
        };
        if apply_and_advance(pool, job, &ctx, &source_id, revision, &key, &batch)
            .await
            .map_err(|error| stage_failure(error, "apply", sequence, &review_call))?
        {
            return Ok(());
        }
    }
}

// 一次待应用批次：冻结输入、复核成果、开批时依赖指纹、既有未决清单与
// 产生该成果的持久批次序列。
struct PendingBatch {
    frozen: Value,
    output: Value,
    dependency: String,
    unresolved_prior: Value,
    sequence: u64,
}

// 应用与推进同事务：核对领取代次、依赖指纹与对象预期版本。依赖漂移或版本
// 冲突时丢弃本批成果按新状态重开（返回false由调用方continue），应用成功则
// 推进游标并在末批结算作业（返回true表示作业已到终态）。
async fn apply_and_advance(
    pool: &MySqlPool,
    job: &jobs::SourceJob,
    ctx: &AccessContext,
    source_id: &str,
    revision: u64,
    key: &SourceKey,
    batch: &PendingBatch,
) -> Result<bool> {
    let revision_text = revision.to_string();
    let (frozen, output) = (&batch.frozen, &batch.output);
    let mut tx = AppTx::begin(pool).await?;
    jobs::assert_job_in_tx(&mut tx, &job.lease.id, job.lease.lease_epoch).await?;
    let current_objects = knowledge::source_objects_in_tx(&mut tx, ctx, source_id).await?;
    if ingestion::preparation::dependency_fingerprint(&current_objects) != batch.dependency.as_str()
    {
        // 批次期间对象依赖内容已变：丢弃本批成果，按新依赖重新开批。
        ingestion::preparation::reset_batch_in_tx(&mut tx, source_id, revision).await?;
        tx.commit().await?;
        return Ok(false);
    }
    // 应用与模型调用同属该批：序列在依赖重开后仍单调，不复用已结算旧批身份；
    // 不用可能重复的批次起点冒充批次身份。
    let operation = fingerprint(&json!([
        "prepare-apply",
        source_id,
        revision,
        ingestion::preparation::PREPARATION_METHOD,
        batch.sequence
    ]));
    let applied =
        knowledge::apply_preparation_in_tx(&mut tx, ctx, &operation, key, &revision_text, output)
            .await;
    if matches!(&applied, Err(error) if error.code == "version_conflict") {
        // 批次在途期间对象被并发推进（人工改版/预填落建议）：冻结的预期版本已
        // 过时而正文未变，按当前版本重开批重整，不把可追赶的竞态当永久失败。
        // 应用事务里已写的操作预占随回滚一并撤销。
        drop(tx);
        let mut retry = AppTx::begin(pool).await?;
        jobs::assert_job_in_tx(&mut retry, &job.lease.id, job.lease.lease_epoch).await?;
        ingestion::preparation::reset_batch_in_tx(&mut retry, source_id, revision).await?;
        retry.commit().await?;
        return Ok(false);
    }
    let applied = applied?;
    // 整理落库同属保存路径：补依赖目标指纹并按被依赖情况排队来源扇出（幂等）。
    super::dependency_registration::after_content_saved_in_tx(&mut tx, ctx, &applied).await?;
    let unresolved = merge_unresolved(&batch.unresolved_prior, &output["unresolved"]);
    let next_cursor = frozen["next_cursor"].clone();
    ingestion::preparation::complete_batch_in_tx(
        &mut tx,
        source_id,
        revision,
        (!next_cursor.is_null()).then_some(&next_cursor),
        frozen["coverage"]["batch_segments"].as_u64().unwrap_or(0),
        frozen["coverage"]["batch_chars"].as_u64().unwrap_or(0),
        &unresolved,
    )
    .await?;
    tx.notify(crate::live_changes::Change::Catalog {
        space_id: ctx.space_id.clone(),
    });
    tx.commit().await?;
    if next_cursor.is_null() {
        let mut tx = AppTx::begin(pool).await?;
        jobs::assert_job_in_tx(&mut tx, &job.lease.id, job.lease.lease_epoch).await?;
        jobs::settle_in_tx(&mut tx, &job.lease.id, job.lease.lease_epoch).await?;
        tx.commit().await?;
        return Ok(true);
    }
    Ok(false)
}

fn freeze_batch(
    batch: &source_segments::SegmentBatch,
    budget: usize,
    key: &SourceKey,
    revision: &str,
    objects: &[Value],
    row: &Value,
) -> Result<Value> {
    let (segments, next_cursor) = prefix_by_char_budget(batch, budget);
    let serialized: Vec<Value> = segments
        .iter()
        .map(|segment| serde_json::to_value(segment).map_err(|_| Error::new("invalid_input")))
        .collect::<Result<Vec<_>>>()?;
    let batch_chars: u64 = segments
        .iter()
        .map(|segment| segment.citation.locator.length.max(0) as u64)
        .sum();
    Ok(json!({
        "source": serde_json::to_value(key).map_err(|_| Error::new("invalid_input"))?,
        "revision": revision,
        "segments": serialized,
        "next_cursor": match &next_cursor {
            Some(cursor) => serde_json::to_value(cursor).map_err(|_| Error::new("invalid_input"))?,
            None => Value::Null,
        },
        "objects": objects,
        "coverage": {
            "segments_read": row["segments_read"],
            "covered_chars": row["covered_chars"],
            "batch_start": segments.first().map(|s| s.citation.locator.offset.max(0)).unwrap_or(0),
            "batch_segments": segments.len(),
            "batch_chars": batch_chars,
            "final_batch": next_cursor.is_none(),
        }
    }))
}

fn input_fingerprint(source: &str, revision: u64, body: &str) -> String {
    use sha2::{Digest, Sha256};
    fingerprint(&json!([
        "source-preparation-input",
        source,
        revision,
        format!("{:x}", Sha256::digest(body.as_bytes())),
        source_segments::SEGMENTATION_VERSION
    ]))
}

async fn source_body_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    source: &str,
    revision: u64,
) -> Result<String> {
    // 文档与平台来源共用同一读取口径，冻结正文始终来自被整理的修订。
    let value = super::knowledge_sources::read_in_tx(tx, ctx, source, Some(revision)).await?;
    if value["version"].as_str() != Some(revision.to_string().as_str()) {
        return Err(Error::new("stale_source"));
    }
    Ok(value["body"].as_str().unwrap_or("").to_owned())
}

fn merge_unresolved(previous: &Value, batch: &Value) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let merged: Vec<String> = previous
        .as_array()
        .into_iter()
        .flatten()
        .chain(batch.as_array().into_iter().flatten())
        .filter_map(|value| value.as_str().map(str::to_owned))
        .filter(|value| !value.trim().is_empty())
        .filter(|value| seen.insert(value.clone()))
        .collect();
    merged.into_iter().take(200).collect()
}

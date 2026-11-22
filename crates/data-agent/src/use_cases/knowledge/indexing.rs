use super::*;

pub async fn process_index(pool: &MySqlPool) -> Result<bool> {
    let vector = retrieval::vector::enabled();
    // 嵌入配置缺失或不合法时待办不整体停摆：已冻结配置或有原账本回执的目标
    // 继续恢复推进，无配置的新目标保持真实pending、不空耗次数（与整理消费
    // 者同口径）。集合不兼容或无向量服务时原文目标没有可写通道，同样不领取。
    let unconfigured = if vector {
        match crate::use_cases::knowledge_embeddings::maintenance_profile() {
            Ok(Some(_)) => false,
            Ok(None) => true,
            Err(error) if error.code == "invalid_input" => true,
            Err(error) => return Err(error),
        }
    } else {
        false
    };
    let scheduling = AccessContext {
        user_id: "synthetic-index".into(),
        space_id: crate::modules::access::default_space()?,
        request_id: id(),
        table_access: None,
    };
    let target = if vector {
        retrieval::vector::index_target().await?
    } else {
        retrieval::vector::target()
    };
    if vector {
        crate::use_cases::raw_index_handover::hand_over_due(pool, &scheduling.space_id).await?;
    }
    let mut tx = AppTx::begin(pool).await?;
    let jobs = knowledge::claim_index_batch_in_tx(
        &mut tx,
        &scheduling,
        vector,
        Some(&target),
        unconfigured,
    )
    .await?;
    // 一次只领取即将处理的一类工作；长原文不能占用尚未开始的知识批次租约。
    let source_job = if vector && jobs.is_empty() {
        // 空知识轮询已建立一致性快照；原文锁定领取可见其后提交的新作业，
        // 须先结束旧事务，避免来源普通读仍用旧快照将合法新原文误退役。
        tx.commit().await?;
        tx = AppTx::begin(pool).await?;
        let eligible = if unconfigured {
            Some(
                crate::use_cases::knowledge_embeddings::recoverable_source_heads_in_tx(
                    &mut tx,
                    &scheduling,
                )
                .await?,
            )
        } else {
            None
        };
        knowledge::claim_source_index_in_tx(
            &mut tx,
            &scheduling.space_id,
            true,
            Some(&target),
            eligible.as_deref(),
        )
        .await?
    } else {
        None
    };
    let Some(next) = jobs.first().or(source_job.as_ref()) else {
        tx.commit().await?;
        return Ok(false);
    };
    // 默认空间界定轮询范围。索引写入和账本绑定使用已领取记录的实际空间。
    let ctx = AccessContext {
        space_id: next["space_id"]
            .as_str()
            .ok_or_else(|| {
                Error::new("unavailable")
                    .with_message("Claimed index record missing space_id".into())
            })?
            .to_owned(),
        ..scheduling
    };
    // 原文目标在领取事务内核头来修订并读正文；来源缺失或已有更新修订时不花
    // 嵌入预算，按superseded收尾，清旧由更新修订的作业负责。分页未完成的
    // 正文按明确unknown退回，不在半途正文上建立索引。
    let mut indexed_source: Option<(Value, SourceKey, String)> = None;
    if let Some(job) = &source_job {
        let key = SourceKey {
            kind: if job["source_kind"] == "document" {
                SourceKeyKind::Document
            } else {
                SourceKeyKind::Platform
            },
            id: job["object_id"].as_str().unwrap_or("").to_owned(),
        };
        let alias = source_alias(&key);
        let revision = epoch(job["job_version"].as_str().unwrap_or("0"))?;
        let head =
            crate::use_cases::knowledge_sources::resolve_source_head_in_tx(&mut tx, &alias).await?;
        let outcome = match head {
            Some((space, current)) if space == ctx.space_id && current <= revision => {
                crate::use_cases::knowledge_sources::read_in_tx(
                    &mut tx,
                    &AccessContext {
                        user_id: "synthetic-raw-index".into(),
                        space_id: space,
                        request_id: job["lease_epoch"].as_str().unwrap_or("").to_owned(),
                        table_access: None,
                    },
                    &alias,
                    Some(revision),
                )
                .await
            }
            _ => Ok(json!({"version": Value::Null, "complete": false})),
        };
        match outcome {
            Ok(value)
                if value["version"].as_str() == Some(job["job_version"].as_str().unwrap_or(""))
                    && value["complete"] == true =>
            {
                indexed_source = Some((
                    job.clone(),
                    key,
                    value["body"].as_str().unwrap_or("").to_owned(),
                ));
            }
            Ok(value) if value["complete"] == false && value["version"] != Value::Null => {
                knowledge::finish_index_in_tx(&mut tx, job, None, Some("source_incomplete"))
                    .await?;
            }
            Ok(_) => {
                knowledge::finish_index_in_tx(
                    &mut tx,
                    job,
                    Some(&json!({"state":"superseded"})),
                    None,
                )
                .await?;
            }
            Err(error)
                if matches!(
                    error.code,
                    "not_available" | "stale_source" | "stale_knowledge"
                ) =>
            {
                knowledge::finish_index_in_tx(
                    &mut tx,
                    job,
                    Some(&json!({"state":"superseded"})),
                    None,
                )
                .await?;
            }
            Err(error) => return Err(error),
        }
    }
    let mut valid = Vec::new();
    for job in &jobs {
        retrieval::index_in_tx(&mut tx, &ctx.space_id, &job["object"]).await?;
        if job["object"]["state"] == "enabled" {
            match assert_source_in_tx(&mut tx, &ctx, &job["object"]).await {
                Ok(()) => {}
                Err(error)
                    if matches!(
                        error.code,
                        "not_available" | "stale_source" | "stale_knowledge"
                    ) =>
                {
                    continue;
                }
                Err(error) => return Err(error),
            }
        }
        valid.push(job["object"].clone());
    }
    tx.commit().await?;
    let mut source_error: Option<String> = None;
    let mut source_superseded_midway = false;
    if let Some((job, key, body)) = &indexed_source {
        match index_source_target(pool, &ctx, &target, job, key, body).await {
            Ok(()) => {}
            Err(error) if error.code == "superseded" => source_superseded_midway = true,
            Err(error) => source_error = Some(error.code.to_owned()),
        }
    }
    // Embedding、Milvus及查证均在领取事务外；查询Worker独立运行。
    let applied = if vector && !valid.is_empty() {
        Some(
            retrieval::vector::apply(&ctx.space_id, &valid, |object, batch, texts| {
                let jobs = &jobs;
                let ctx = &ctx;
                async move {
                    let job = jobs
                        .iter()
                        .find(|j| j["object_id"] == object["id"])
                        .ok_or(Error::new("not_available"))?;
                    crate::use_cases::knowledge_embeddings::embed(
                        pool,
                        ctx,
                        crate::use_cases::knowledge_embeddings::Binding::Index(job, batch),
                        texts,
                        // 后台索引嵌入不受检索期限约束（05接续）。
                        None,
                    )
                    .await
                }
            })
            .await,
        )
    } else {
        None
    };
    let mut tx = AppTx::begin(pool).await?;
    for job in &jobs {
        let (receipt, error) = match &applied {
            Some(Ok(reports)) => {
                let receipt = reports
                    .iter()
                    .find(|v| v["id"] == job["object_id"] && v["version"] == job["job_version"]);
                (
                    receipt,
                    if receipt.is_none() {
                        Some("stale_knowledge")
                    } else {
                        None
                    },
                )
            }
            Some(Err(error)) => (None, Some(error.code)),
            None if vector => (None, Some("stale_knowledge")),
            None => (None, None),
        };
        knowledge::finish_index_in_tx(&mut tx, job, receipt, error).await?;
    }
    if let Some((job, _, _)) = &indexed_source {
        let receipt = if source_superseded_midway {
            Some(&json!({"state":"superseded"}))
        } else if source_error.is_none() {
            Some(&json!({"state":"indexed","target":target}))
        } else {
            None
        };
        knowledge::finish_index_in_tx(&mut tx, job, receipt, source_error.as_deref()).await?;
    }
    tx.commit().await?;
    Ok(true)
}

// document来源以document-{id}别名调用owner读接口；嵌入操作身份沿该别名续用，
// 迁移后回执/预算不重发。SourceKey.kind/id仍是索引写入与清旧的完整身份。
pub(crate) fn source_alias(key: &SourceKey) -> String {
    match key.kind {
        SourceKeyKind::Document => format!("document-{}", key.id),
        SourceKeyKind::Platform => key.id.clone(),
    }
}

// 原文目标的锁外索引：确定性切块持续到结束，每批先短事务核租约与来源头修订，
// 写入后短事务记录投影进度，再继续下一批。当前修订完成后按SourceKey完整身份
// 清理更旧修订的摘录，晚到作业不能回退当前投影。
async fn index_source_target(
    pool: &MySqlPool,
    ctx: &AccessContext,
    target: &str,
    job: &Value,
    key: &SourceKey,
    body: &str,
) -> Result<()> {
    let revision = epoch(job["job_version"].as_str().unwrap_or("0"))?;
    let revision_text = job["job_version"].as_str().unwrap_or("0").to_owned();
    let alias = source_alias(key);
    let source = source_segments::SourceText {
        source: key,
        revision: &revision_text,
        text: body,
        format: if matches!(key.kind, SourceKeyKind::Document) {
            source_segments::SourceFormat::Markdown
        } else {
            source_segments::SourceFormat::Sql
        },
        background: &[],
    };
    let mut cursor: Option<source_segments::SegmentCursor> = None;
    let kind_label = || match key.kind {
        SourceKeyKind::Document => "document",
        SourceKeyKind::Platform => "platform",
    };
    loop {
        let batch = source_segments::segment_source(&source, cursor.as_ref())?;
        if batch.segments.is_empty() {
            break;
        }
        // 批前短事务：核代次与来源头修订。头已越过作业修订时按superseded收尾，
        // 不再花嵌入预算，清旧由更新修订的作业负责。
        {
            let mut tx = AppTx::begin(pool).await?;
            knowledge::renew_source_index_lease_in_tx(&mut tx, job).await?;
            let head =
                crate::use_cases::knowledge_sources::resolve_source_head_in_tx(&mut tx, &alias)
                    .await?;
            let stale = !matches!(head, Some((space, current)) if space == ctx.space_id && current <= revision);
            tx.commit().await?;
            if stale {
                return Err(Error::new("superseded"));
            }
        }
        let applied_position = batch
            .segments
            .last()
            .map(|segment| {
                segment.citation.locator.offset as u64 + segment.citation.locator.length as u64
            })
            .unwrap_or(0);
        retrieval::vector::apply_source_excerpts(&ctx.space_id, &batch.segments, |_, texts| {
            let ctx = ctx.clone();
            let alias = alias.clone();
            let job = job.clone();
            // 指纹随批次文本计算并由绑定持有：操作身份与具体文本一一对应，
            // 跳批/换序不会共用身份；共享嵌入缓存回放不重复计费。
            let fp = crate::types::fingerprint(&json!(&texts));
            async move {
                crate::use_cases::knowledge_embeddings::embed(
                    pool,
                    &ctx,
                    crate::use_cases::knowledge_embeddings::Binding::RawIndex(
                        &job, &alias, revision, fp,
                    ),
                    texts,
                    // 后台索引嵌入不受检索期限约束（05接续）。
                    None,
                )
                .await
            }
        })
        .await?;
        let projection = retrieval::SourceProjection {
            source_kind: kind_label().to_owned(),
            source_id: key.id.clone(),
            space_id: ctx.space_id.clone(),
            revision,
            collection_target: target.to_owned(),
            embedding_model: retrieval::embedding::SPEC.version.to_owned(),
            segmentation_version: source_segments::SEGMENTATION_VERSION_NUMBER,
            applied_position,
            complete: false,
        };
        let mut tx = AppTx::begin(pool).await?;
        knowledge::renew_source_index_lease_in_tx(&mut tx, job).await?;
        retrieval::record_source_projection_in_tx(&mut tx, &projection).await?;
        tx.commit().await?;
        match batch.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    // 当前修订已写入：按SourceKey完整身份删除更旧修订的摘录（平台与文档同ID
    // 不互删，document-调用别名不当裸object_id）。
    retrieval::vector::drop_source_excerpts(&ctx.space_id, kind_label(), &key.id, revision).await?;
    let mut tx = AppTx::begin(pool).await?;
    knowledge::renew_source_index_lease_in_tx(&mut tx, job).await?;
    retrieval::record_source_projection_in_tx(
        &mut tx,
        &retrieval::SourceProjection {
            source_kind: kind_label().to_owned(),
            source_id: key.id.clone(),
            space_id: ctx.space_id.clone(),
            revision,
            collection_target: target.to_owned(),
            embedding_model: retrieval::embedding::SPEC.version.to_owned(),
            segmentation_version: source_segments::SEGMENTATION_VERSION_NUMBER,
            applied_position: body.chars().count() as u64,
            complete: true,
        },
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

pub async fn rebuild_index(pool: &MySqlPool, ctx: &AccessContext, input: &Value) -> Result<Value> {
    access::authorize_maintainer(ctx)?;
    contracts::validate("CreateConversation", input)?;
    let operation = input["operation_id"]
        .as_str()
        .ok_or(Error::new("invalid_input"))?;
    rebuild_index_for_operation(pool, ctx, operation).await
}

pub async fn rebuild_index_for_operation(
    pool: &MySqlPool,
    ctx: &AccessContext,
    operation: &str,
) -> Result<Value> {
    access::authorize_maintainer(ctx)?;
    let mut recorded = AppTx::begin(pool).await?;
    let receipt = knowledge::index_rebuild_receipt_in_tx(&mut recorded, ctx, operation).await?;
    recorded.commit().await?;
    if let Some(receipt) = receipt {
        return Ok(receipt);
    }
    if !retrieval::vector::enabled() {
        return Err(Error::new("vector_unconfigured"));
    }
    let target = retrieval::vector::prepare_index_target().await?;
    let mut tx = AppTx::begin(pool).await?;
    let (receipt, created) =
        knowledge::rebuild_index_in_tx(&mut tx, ctx, &target, operation).await?;
    if created {
        crate::use_cases::raw_index_handover::rebuild_sources_in_tx(
            &mut tx,
            &ctx.space_id,
            &target,
        )
        .await?;
    }
    tx.commit().await?;
    Ok(receipt)
}

pub(super) fn depends_on_source(object: &Value, source: &str) -> bool {
    object["source_id"] == source
        || object["entries"].as_array().is_some_and(|items| {
            items.iter().any(|e| {
                e["source_facts"]["source_id"] == source
                    || e["suggestion"]["evidence"]
                        .as_array()
                        .is_some_and(|refs| refs.iter().any(|r| r["source_id"] == source))
            })
        })
}

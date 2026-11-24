use crate::{
    contracts::generated::{SourceKey, SourceKeyKind},
    modules::{ingestion, jobs, knowledge},
    persistence::AppTx,
    types::Result,
};
use sqlx::MySqlPool;

async fn platform_sources_in_tx(tx: &mut AppTx<'_>, space: &str) -> Result<Vec<(SourceKey, u64)>> {
    let mut sources = Vec::new();
    for (id, revision) in ingestion::readable_source_heads_in_tx(tx, space).await? {
        sources.push((
            SourceKey {
                kind: SourceKeyKind::Platform,
                id,
            },
            revision,
        ));
    }
    Ok(sources)
}

// 旧积压移交仍覆盖独立文档：封板前登记的文档旧作业要沿原身份收敛。
async fn current_sources_in_tx(tx: &mut AppTx<'_>, space: &str) -> Result<Vec<(SourceKey, u64)>> {
    let mut sources = platform_sources_in_tx(tx, space).await?;
    for (id, revision) in knowledge::independent_document_heads_in_tx(tx, space).await? {
        sources.push((
            SourceKey {
                kind: SourceKeyKind::Document,
                id,
            },
            revision,
        ));
    }
    Ok(sources)
}

async fn transfer_in_tx(
    tx: &mut AppTx<'_>,
    space: &str,
    source: &SourceKey,
    revision: u64,
    legacy: &jobs::LegacyRawJob,
) -> Result<()> {
    knowledge::register_source_index_target_in_tx(
        tx,
        space,
        source,
        revision,
        Some((&legacy.id, legacy.attempts)),
    )
    .await?;
    jobs::settle_handover_in_tx(tx, &legacy.id).await
}

// 每次最多移交64项，清单由来源owner限定空间；原作业收敛与新登记在同一事务。
// 有效旧租约不抢身份，原次数与冻结Embedding配置由原待办和调用账本继续持有。
pub async fn hand_over_in_tx(tx: &mut AppTx<'_>, space: &str) -> Result<u64> {
    let sources = current_sources_in_tx(tx, space).await?;
    let mut moved = 0;
    for chunk in sources.chunks(64) {
        let aliases: Vec<_> = chunk
            .iter()
            .map(|(source, revision)| (super::knowledge::source_alias(source), *revision))
            .collect();
        let legacy = jobs::legacy_raw_jobs_in_tx(tx, &aliases).await?;
        for ((source, revision), (alias, _)) in chunk.iter().zip(&aliases) {
            if let Some(job) = legacy.iter().find(|job| {
                job.available
                    && job.resource_id == *alias
                    && job.resource_version == Some(*revision)
            }) {
                transfer_in_tx(tx, space, source, *revision, job).await?;
                moved += 1;
                if moved == 64 {
                    return Ok(moved);
                }
            }
        }
    }
    Ok(moved)
}

// 显式重建只补登记当前可读平台来源：独立文档以知识条目定位，不再登记原文目标；
// 旧有效租约不能经新队列旁路领取。
pub(super) async fn rebuild_sources_in_tx(
    tx: &mut AppTx<'_>,
    space: &str,
    target: &str,
) -> Result<()> {
    let sources = platform_sources_in_tx(tx, space).await?;
    for chunk in sources.chunks(64) {
        let aliases: Vec<_> = chunk
            .iter()
            .map(|(source, revision)| (super::knowledge::source_alias(source), *revision))
            .collect();
        let legacy = jobs::legacy_raw_jobs_in_tx(tx, &aliases).await?;
        for ((source, revision), (alias, _)) in chunk.iter().zip(&aliases) {
            if let Some(job) = legacy
                .iter()
                .find(|job| job.resource_id == *alias && job.resource_version == Some(*revision))
            {
                if !job.available {
                    continue;
                }
                transfer_in_tx(tx, space, source, *revision, job).await?;
            } else {
                knowledge::register_source_index_target_in_tx(tx, space, source, *revision, None)
                    .await?;
            }
            knowledge::rebuild_source_index_in_tx(tx, space, source, *revision, target).await?;
        }
    }
    Ok(())
}

// 与索引领取分开提交，避免知识轮询的旧快照影响新移交来源；一次最多核64项。
// 未到期旧租约不进候选，资源别名仍须经owner证明实际空间和当前可索引修订。
pub(super) async fn hand_over_due(pool: &MySqlPool, space: &str) -> Result<u64> {
    let mut tx = AppTx::begin(pool).await?;
    let legacy = jobs::due_legacy_raw_jobs_in_tx(&mut tx).await?;
    let mut moved = 0;
    for job in legacy {
        let Some(revision) = job.resource_version else {
            continue;
        };
        let Some((owner_space, current)) =
            super::knowledge_sources::resolve_source_head_in_tx(&mut tx, &job.resource_id).await?
        else {
            continue;
        };
        if owner_space != space || current != revision {
            continue;
        }
        let source = if let Some(document) = super::knowledge_sources::document_id(&job.resource_id)
        {
            if !knowledge::independent_document_candidate_in_tx(&mut tx, space, document, revision)
                .await?
            {
                continue;
            }
            SourceKey {
                kind: SourceKeyKind::Document,
                id: document.to_owned(),
            }
        } else {
            if !ingestion::readable_source_candidate_in_tx(
                &mut tx,
                space,
                &job.resource_id,
                revision,
            )
            .await?
            {
                continue;
            }
            SourceKey {
                kind: SourceKeyKind::Platform,
                id: job.resource_id.clone(),
            }
        };
        transfer_in_tx(&mut tx, space, &source, revision, &job).await?;
        moved += 1;
    }
    tx.commit().await?;
    Ok(moved)
}

pub async fn hand_over_backlog(pool: &MySqlPool, space: &str) -> Result<u64> {
    let mut total = 0;
    loop {
        let mut tx = AppTx::begin(pool).await?;
        let moved = hand_over_in_tx(&mut tx, space).await?;
        tx.commit().await?;
        if moved == 0 {
            return Ok(total);
        }
        total += moved;
    }
}

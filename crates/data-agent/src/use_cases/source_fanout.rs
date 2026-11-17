use crate::{
    modules::{ingestion, jobs, knowledge},
    persistence::AppTx,
    types::{Result, id},
};
use sqlx::MySqlPool;
use std::collections::HashSet;

// 来源扇出消费：被依赖对象改版登记的轻量作业在此展开——按页发现依赖者，只对
// 传递游走判定真正失效的依赖者重开其来源整理（终态准备复位、已完成作业重新
// 排队），内容未变的链条与在途调用都不动。全程纯SQL不调模型，分页不拉长任何
// 保存事务；重整的实际执行由prepare_source消费者接续。
pub async fn process_due(pool: &MySqlPool) -> Result<bool> {
    let worker = id();
    // 扇出展开是纯SQL不调模型，不依赖预填/维护配置；固定短租约，崩溃后由
    // 到期重领接续。
    let lease_ms: u32 = 30_000;
    let Some(job) = jobs::claim_source_work(pool, &worker, lease_ms, "source_fanout").await? else {
        return Ok(false);
    };
    if let Err(error) = fanout(pool, &job).await {
        // 纯SQL展开失败按次退避：租约到期自动接续，不丢弃作业。
        let mut tx = AppTx::begin(pool).await?;
        if error.is_transient_storage() && job.lease.attempts < 2 {
            jobs::begin_attempt_in_tx(&mut tx, &job.lease).await?;
            tx.commit().await?;
            jobs::defer(pool, &job.lease).await?;
        } else {
            jobs::fail_in_tx(&mut tx, &job.lease).await?;
            tx.commit().await?;
        }
        eprintln!(
            "source_fanout_failure resource={} version={:?} code={}",
            job.resource_id, job.resource_version, error.code
        );
    } else {
        let mut tx = AppTx::begin(pool).await?;
        jobs::settle_in_tx(&mut tx, &job.lease.id, job.lease.lease_epoch).await?;
        tx.commit().await?;
    }
    Ok(true)
}

async fn fanout(pool: &MySqlPool, job: &jobs::SourceJob) -> Result<()> {
    let resource = job.resource_id.clone();
    // 文档对象以document-前缀登记扇出，与prepare_source资源身份一致；其余为知识对象。
    let (target_kind, target_id) = match resource.strip_prefix("document-") {
        Some(document) => ("document", document.to_owned()),
        None => ("knowledge", resource.clone()),
    };
    // 作业不携带space；依赖行自己登记了空间，目标被删除后仍能定位其依赖者。
    for space in target_spaces_in_tx(pool, target_kind, &target_id).await? {
        let mut after: Option<(String, u64)> = None;
        loop {
            let mut tx = AppTx::begin(pool).await?;
            jobs::assert_job_in_tx(&mut tx, &job.lease.id, job.lease.lease_epoch).await?;
            let page = knowledge::dependency_index::dependents_in_tx(
                &mut tx,
                &space,
                target_kind,
                &target_id,
                after
                    .as_ref()
                    .map(|(owner, version)| (owner.as_str(), *version)),
                100,
            )
            .await?;
            if page.is_empty() {
                tx.commit().await?;
                break;
            }
            let cursor = page
                .last()
                .map(|dependent| (dependent.owner_id.clone(), dependent.owner_version));
            // 反向索引按(owner,version)分页；修复只关心每个依赖者的当前版本，
            // 旧版本行已被其保存路径取代，同owner重复对在此收敛。
            let mut owners: Vec<(String, u64)> = Vec::new();
            for dependent in &page {
                if owners.iter().any(|(owner, _)| owner == &dependent.owner_id) {
                    continue;
                }
                if let Some(version) =
                    knowledge::enabled_version_in_space_in_tx(&mut tx, &space, &dependent.owner_id)
                        .await?
                {
                    owners.push((dependent.owner_id.clone(), version));
                }
            }
            // 组内一次传递游走，stale归属按owner区分；unknown链不触发重整。
            let verdict =
                super::dependency_validation::walk_required_in_tx(&mut tx, &space, &owners).await?;
            let stale: HashSet<&str> = verdict
                .stale
                .iter()
                .map(|stale| stale.owner_id.as_str())
                .collect();
            let stale_roots: Vec<(String, u64)> = owners
                .iter()
                .filter(|(owner, _)| stale.contains(owner.as_str()))
                .cloned()
                .collect();
            let mut reopens: Vec<(String, u64)> = Vec::new();
            for row in
                knowledge::dependency_index::effective_required_in_tx(&mut tx, &stale_roots).await?
            {
                if !matches!(row.target_kind.as_str(), "document" | "platform") {
                    continue;
                }
                let source = if row.target_kind == "document" {
                    format!("document-{}", row.target_id)
                } else {
                    row.target_id.clone()
                };
                if reopens.iter().any(|(existing, _)| existing == &source) {
                    continue;
                }
                if let Some(revision) = source_head_in_tx(&mut tx, &space, &source).await? {
                    reopens.push((source, revision));
                }
            }
            for (source, revision) in &reopens {
                // 只有实际复位（或尚无准备记录）的来源重排队；在途/进行中的准备
                // 不打断，其作业保持原状。
                if matches!(
                    ingestion::preparation::reopen_preparation_in_tx(
                        &mut tx, &space, source, *revision
                    )
                    .await?,
                    ingestion::preparation::ReopenOutcome::Busy
                ) {
                    continue;
                }
                jobs::requeue_terminal_source_in_tx(&mut tx, "prepare_source", source, *revision)
                    .await?;
            }
            tx.commit().await?;
            after = cursor;
        }
    }
    Ok(())
}

// 依赖反向索引按目标身份给出被依赖的全部空间（作业不携带空间）。
async fn target_spaces_in_tx(
    pool: &MySqlPool,
    target_kind: &str,
    target_id: &str,
) -> Result<Vec<String>> {
    let mut tx = AppTx::begin(pool).await?;
    let spaces =
        knowledge::dependency_index::dependent_spaces_in_tx(&mut tx, target_kind, target_id)
            .await?;
    tx.commit().await?;
    Ok(spaces)
}

async fn source_head_in_tx(tx: &mut AppTx<'_>, space: &str, source: &str) -> Result<Option<u64>> {
    if let Some(document) = source.strip_prefix("document-") {
        return knowledge::enabled_version_in_space_in_tx(tx, space, document).await;
    }
    ingestion::source_head_version_in_tx(tx, space, source).await
}

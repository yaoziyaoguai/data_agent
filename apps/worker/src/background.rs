use data_agent::{
    modules::access,
    persistence::{MySqlPool, receipts},
    types::{Result, id},
    use_cases::{
        catalog_import, knowledge, model_calls, personal_memory, query_workflow, semantic_prefill,
        source_fanout, source_preparation,
    },
};
use std::{future::Future, sync::Arc, time::Duration};
use tokio::{
    sync::{Notify, watch},
    task::JoinSet,
};

pub fn start(
    pool: &MySqlPool,
    ttl_ms: u32,
    source_sync_only: bool,
    shutdown: watch::Receiver<bool>,
    delivery_ready: Arc<Notify>,
    query_ready: Arc<Notify>,
) -> JoinSet<()> {
    let mut jobs = JoinSet::new();
    let source_worker = id();
    let query_worker = id();
    let idle = |count| tokio::time::sleep(super::backoff_delay(count));
    let sync_ready = delivery_ready.clone();
    loop_job(
        &mut jobs,
        pool,
        &shutdown,
        "source_sync",
        idle,
        move |pool| {
            let worker = source_worker.clone();
            let ready = sync_ready.clone();
            async move {
                wake_delivery(
                    catalog_import::process_due(&pool, &worker, ttl_ms).await,
                    &ready,
                )
            }
        },
    );
    if source_sync_only {
        return jobs;
    }
    loop_job(
        &mut jobs,
        pool,
        &shutdown,
        "prefill",
        idle,
        |pool| async move { semantic_prefill::process_due(&pool).await },
    );
    let preparation_ready = delivery_ready.clone();
    loop_job(
        &mut jobs,
        pool,
        &shutdown,
        "source_preparation",
        idle,
        move |pool| {
            let ready = preparation_ready.clone();
            async move { wake_delivery(source_preparation::process_due(&pool).await, &ready) }
        },
    );
    loop_job(
        &mut jobs,
        pool,
        &shutdown,
        "source_fanout",
        idle,
        |pool| async move { source_fanout::process_due(&pool).await },
    );
    loop_job(
        &mut jobs,
        pool,
        &shutdown,
        "knowledge_index",
        idle,
        |pool| async move { knowledge::process_index(&pool).await },
    );
    loop_job(
        &mut jobs,
        pool,
        &shutdown,
        "personal_memory",
        idle,
        |pool| async move { personal_memory::process_index(&pool).await },
    );
    loop_job(
        &mut jobs,
        pool,
        &shutdown,
        "query",
        move |count| {
            let ready = query_ready.clone();
            async move {
                tokio::select! {
                    _ = ready.notified() => {}
                    _ = tokio::time::sleep(super::interactive_delay(count)) => {}
                }
            }
        },
        move |pool| {
            let worker = query_worker.clone();
            let ready = delivery_ready.clone();
            async move { wake_delivery(query_workflow::process_due(&pool, &worker).await, &ready) }
        },
    );
    jobs
}

pub fn start_session_cleanup(
    pool: &MySqlPool,
    shutdown: &watch::Receiver<bool>,
    jobs: &mut JoinSet<()>,
) {
    loop_job(
        jobs,
        pool,
        shutdown,
        "session_cleanup",
        |_| tokio::time::sleep(Duration::from_secs(60)),
        |pool| async move {
            let sessions = access::prune_sessions(&pool).await?;
            let receipts = receipts::prune_expired(&pool).await?;
            let reservations = model_calls::release_abandoned_reservations(&pool).await?;
            Ok(sessions || receipts || reservations)
        },
    );
}

fn wake_delivery(result: Result<bool>, ready: &Notify) -> Result<bool> {
    let processed = result?;
    if processed {
        ready.notify_one();
    }
    Ok(processed)
}

fn loop_job<F, Fut, Wait>(
    jobs: &mut JoinSet<()>,
    pool: &MySqlPool,
    shutdown: &watch::Receiver<bool>,
    name: &'static str,
    wait: impl Fn(u32) -> Wait + Send + 'static,
    mut process: F,
) where
    F: FnMut(MySqlPool) -> Fut + Send + 'static,
    Fut: Future<Output = Result<bool>> + Send,
    Wait: Future<Output = ()> + Send,
{
    let pool = pool.clone();
    let mut shutdown = shutdown.clone();
    jobs.spawn(async move {
        let mut idle = 0u32;
        while !*shutdown.borrow() {
            // 只打断空闲等待。在途事务及平台调用完整收尾后退出。
            match process(pool.clone()).await {
                Ok(true) => {
                    idle = 0;
                    continue;
                }
                Ok(false) => {}
                Err(error) => eprintln!("{name}_worker_failure code={}", error.code),
            }
            tokio::select! {
                _ = shutdown.changed() => break,
                _ = wait(idle) => {}
            }
            idle = idle.saturating_add(1);
        }
        eprintln!("worker_background_stopped name={name}");
    });
}

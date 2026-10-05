use super::store::{self, LockedRun, RunStart};
use crate::{
    persistence::AppTx,
    types::{Error, Result},
};
pub async fn lock_run_in_tx(tx: &mut AppTx<'_>, run_id: &str, cid: &str) -> Result<LockedRun> {
    store::lock_run(tx, run_id, cid).await
}
pub async fn start_run_in_tx(
    tx: &mut AppTx<'_>,
    input: RunStart<'_>,
) -> Result<(String, String, Option<String>)> {
    store::start_run(tx, input).await
}
pub async fn commit_run_in_tx(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
    commit_id: &str,
    fp: &str,
    text: &str,
) -> Result<()> {
    if run.state != "running" {
        return Err(Error::new("lease_lost"));
    }
    store::commit_run(tx, run, commit_id, fp, text).await
}

pub async fn cancel_run_in_tx(tx: &mut AppTx<'_>, run: &LockedRun) -> Result<()> {
    store::cancel_run(tx, run).await
}
pub async fn interrupt_run_in_tx(tx: &mut AppTx<'_>, run: &LockedRun) -> Result<()> {
    store::interrupt_run(tx, run).await
}

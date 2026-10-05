use crate::{
    contracts::generated::CancelRun,
    modules::{conversations, jobs, runtime},
    persistence::AppTx,
    types::{AccessContext, Error, Result, epoch, id},
};
use serde_json::{Value, json};
use sqlx::MySqlPool;

pub async fn cancel(
    pool: &MySqlPool,
    context: &AccessContext,
    cid: &str,
    input: &CancelRun,
) -> Result<Value> {
    let mut tx = AppTx::begin(pool).await?;
    let conversation = conversations::lock_conversation_in_tx(&mut tx, context, cid).await?;
    let run = runtime::lock_run_in_tx(&mut tx, &input.run_id, cid).await?;
    if run.lease_epoch != epoch(&input.lease_epoch)? {
        return Err(Error::new("version_conflict"));
    }
    if run.state == "running" {
        runtime::cancel_run_in_tx(&mut tx, &run).await?;
        conversations::cancel_consumption_in_tx(
            &mut tx,
            &conversation,
            &run.message_id,
            &run.id,
            run.lease_epoch,
        )
        .await?;
        conversations::append_event_in_tx(
            &mut tx,
            &conversation,
            &id(),
            "run_cancelled",
            json!({"run_id":run.id,"attempt_id":run.attempt_id}),
        )
        .await?;
        jobs::cancel_message_job_in_tx(&mut tx, &run.message_id).await?;
    }
    let state = if run.state == "running" {
        "cancelled"
    } else {
        &run.state
    };
    tx.commit().await?;
    Ok(json!({"run_id":run.id,"state":state}))
}

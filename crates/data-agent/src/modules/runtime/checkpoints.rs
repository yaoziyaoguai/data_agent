use super::store::{self, LockedRun};
use crate::{
    contracts,
    persistence::AppTx,
    types::{Error, Result, fingerprint},
};
use serde_json::{Value, json};
pub async fn read_checkpoint_in_tx(tx: &mut AppTx<'_>, chain: &str) -> Result<Option<Value>> {
    store::read_checkpoint(tx, chain).await
}
pub async fn save_checkpoint_in_tx(
    tx: &mut AppTx<'_>,
    run: &LockedRun,
    value: &Value,
) -> Result<()> {
    contracts::validate("Checkpoint", value)?;
    if value["storage"]["kind"] == "host_checkpoint" {
        return Err(Error::new("invalid_input"));
    }
    store::save_checkpoint(tx, run, value).await
}
pub async fn bind_delivery_checkpoint_in_tx(
    tx: &mut AppTx<'_>,
    run_id: &str,
    checkpoint: &Value,
) -> Result<Value> {
    contracts::validate("Checkpoint", checkpoint)?;
    if checkpoint.get("storage").is_some() {
        return Ok(checkpoint.clone());
    }
    store::bind_legacy_delivery_checkpoint(tx, run_id, checkpoint).await?;
    let mut reference = checkpoint.clone();
    reference["entries"] = json!([]);
    reference["storage"] = json!({"kind":"host_checkpoint","fingerprint":fingerprint(checkpoint)});
    Ok(reference)
}
pub async fn read_delivery_checkpoint_in_tx(tx: &mut AppTx<'_>, run: &LockedRun) -> Result<Value> {
    store::read_legacy_delivery_checkpoint(tx, run).await
}
pub async fn read_conversation_checkpoint_in_tx(
    tx: &mut AppTx<'_>,
    cid: &str,
) -> Result<Option<serde_json::Value>> {
    store::conversation_checkpoint(tx, cid).await
}

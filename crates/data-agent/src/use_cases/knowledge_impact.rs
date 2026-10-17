use crate::{
    contracts,
    modules::{access, assets, knowledge},
    persistence::AppTx,
    types::{AccessContext, Error, Result},
};
use serde_json::{Value, json};
use sqlx::MySqlPool;

pub async fn read(
    pool: &MySqlPool,
    ctx: &AccessContext,
    object: &str,
    input: Value,
) -> Result<Value> {
    contracts::validate("MaintenanceImpactQuery", &input)?;
    let mut tx = AppTx::begin(pool).await?;
    let target = knowledge::read_in_tx(&mut tx, ctx, object, None, true).await?;
    if target["version"] != input["expected_version"] {
        return Err(Error::new("version_conflict"));
    }
    let after = input["after_id"].as_str();
    let (mut items, next) = if input["kind"] == "knowledge" {
        knowledge::find_dependents_in_tx(&mut tx, ctx, &target, after).await?
    } else {
        assets::find_skill_dependents_in_tx(
            &mut tx,
            ctx,
            &target,
            after,
            access::is_super_maintainer(ctx)?,
        )
        .await?
    };
    if input["kind"] == "knowledge" {
        for item in &mut items {
            item["can_edit"] =
                access::maintenance_snapshot_in_tx(&mut tx, ctx, item["id"].as_str().unwrap_or(""))
                    .await?["can_edit"]
                    .clone();
        }
    }
    tx.commit().await?;
    Ok(
        json!({"target":{"object_id":target["id"],"version":target["version"],"state":target["state"]},
        "kind":input["kind"],"scope":"direct_explicit_references","items":items,"next_after_id":next}),
    )
}

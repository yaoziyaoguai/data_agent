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
    if input["kind"] == "skill" {
        let mut tx = AppTx::begin(pool).await?;
        let ids = items
            .iter()
            .map(|item| item["id"].as_str().expect("saved Skill ID").to_owned())
            .collect::<Vec<_>>();
        let mut candidates =
            assets::read_assets_with_sources_in_tx(&mut tx, ctx, &ids, false).await?;
        tx.commit().await?;
        let checked =
            super::personal_assets::checked_skills(pool, ctx, candidates.values()).await?;
        let mut tx = AppTx::begin(pool).await?;
        for item in &mut items {
            if let Some(mut skill) = candidates.remove(item["id"].as_str().expect("saved Skill ID"))
            {
                super::personal_assets::project_skill_in_tx(&mut tx, ctx, &mut skill, &checked)
                    .await?;
                item["name"] = skill["name"].clone();
            } else {
                item["name"] = json!("来源不可用，正文已隐藏");
            }
        }
        tx.commit().await?;
    }
    Ok(
        json!({"target":{"object_id":target["id"],"version":target["version"],"state":target["state"]},
        "kind":input["kind"],"scope":"direct_explicit_references","items":items,"next_after_id":next}),
    )
}

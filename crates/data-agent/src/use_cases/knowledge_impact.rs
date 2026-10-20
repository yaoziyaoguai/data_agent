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
    // 依赖目录只展示资产名称，也必须按名称的持久出处检查；网络结果权限在事务外核验。
    let checked = if input["kind"] == "skill" {
        let mut tx = AppTx::begin(pool).await?;
        let target = knowledge::read_in_tx(&mut tx, ctx, object, None, true).await?;
        let (rows, _) = assets::find_skill_dependents_in_tx(
            &mut tx,
            ctx,
            &target,
            input["after_id"].as_str(),
            access::is_super_maintainer(ctx)?,
        )
        .await?;
        let mut candidates = Vec::new();
        for row in rows {
            candidates.push(
                assets::read_in_tx(
                    &mut tx,
                    ctx,
                    row["id"].as_str().ok_or(Error::new("invalid_input"))?,
                    false,
                )
                .await?,
            );
        }
        tx.commit().await?;
        super::personal_assets::checked_assets(pool, ctx, &candidates).await?
    } else {
        super::context_authority::CheckedTextResults::default()
    };
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
    if input["kind"] == "skill" {
        for item in &mut items {
            let asset = assets::read_in_tx(
                &mut tx,
                ctx,
                item["id"].as_str().ok_or(Error::new("invalid_input"))?,
                false,
            )
            .await?;
            item["name"] =
                super::personal_assets::name_in_tx(&mut tx, ctx, &asset, &checked).await?;
        }
    }
    tx.commit().await?;
    Ok(
        json!({"target":{"object_id":target["id"],"version":target["version"],"state":target["state"]},
        "kind":input["kind"],"scope":"direct_explicit_references","items":items,"next_after_id":next}),
    )
}

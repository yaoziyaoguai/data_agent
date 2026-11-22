use crate::{
    contracts,
    modules::{access, assets, ingestion, knowledge},
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
            .map(|item| {
                item["id"]
                    .as_str()
                    .map(str::to_owned)
                    .ok_or(Error::new("unavailable"))
            })
            .collect::<Result<Vec<_>>>()?;
        let mut candidates =
            assets::read_assets_with_sources_in_tx(&mut tx, ctx, &ids, false).await?;
        tx.commit().await?;
        let checked =
            super::personal_assets::checked_skills(pool, ctx, candidates.values()).await?;
        let mut tx = AppTx::begin(pool).await?;
        for item in &mut items {
            if let Some(mut skill) = candidates.remove(
                item["id"]
                    .as_str()
                    .ok_or(crate::types::Error::new("unavailable"))?,
            ) {
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

pub async fn lineage(
    pool: &MySqlPool,
    ctx: &AccessContext,
    id: &str,
) -> Result<contracts::generated::KnowledgeLineage> {
    let mut tx = AppTx::begin(pool).await?;
    let target = knowledge::read_in_tx(&mut tx, ctx, id, None, false).await?;
    let (dependents, next_dependents) =
        knowledge::find_dependents_in_tx(&mut tx, ctx, &target, None).await?;
    let mut ids = std::collections::BTreeSet::new();
    for reference in knowledge::structure_dependencies(&target) {
        if let Some(object) = reference["object_id"].as_str() {
            ids.insert(object.to_owned());
        }
    }
    ids.extend(
        target["related_ids"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned),
    );
    if target["kind"] == "table"
        && let Some(source) = target["source_id"]
            .as_str()
            .filter(|id| id.starts_with("catalog-"))
    {
        ids.extend(
            ingestion::catalog_upstream_in_tx(&mut tx, ctx, source)
                .await?
                .into_iter()
                .map(|(_, table)| table),
        );
    }
    let mut relations = Vec::new();
    for item in &dependents {
        if item["kind"] == "relationship" && item["state"] == "enabled" {
            let relation_id = item["id"].as_str().ok_or(Error::new("invalid_input"))?;
            let relation = knowledge::read_in_tx(&mut tx, ctx, relation_id, None, false).await?;
            for reference in knowledge::structure_dependencies(&relation) {
                if let Some(object) = reference["object_id"].as_str() {
                    ids.insert(object.to_owned());
                }
            }
            relations.push(relation);
        }
    }
    ids.remove(id);
    let sources =
        knowledge::candidate_meta_in_tx(&mut tx, ctx, &ids.into_iter().collect::<Vec<_>>(), None)
            .await?;
    tx.commit().await?;

    use contracts::generated::{DownstreamKind, KnowledgeLineage, Relationship};

    let table_sources: Vec<_> = sources
        .iter()
        .filter(|head| head["kind"] == "table" && head["state"] == "enabled")
        .collect();
    let visible: std::collections::BTreeSet<_> = table_sources
        .iter()
        .filter_map(|head| head["id"].as_str())
        .chain(std::iter::once(id))
        .collect();
    let mut join_keys =
        std::collections::BTreeMap::<&str, std::collections::BTreeSet<String>>::new();
    relations.push(target.clone());
    for entry in relations
        .iter()
        .flat_map(|relation| relation["entries"].as_array().into_iter().flatten())
    {
        let structure = &entry["effective_structure"];
        if structure["kind"] != "relationship" {
            continue;
        }
        let left = structure["left_table"]["object_id"]
            .as_str()
            .ok_or(Error::new("invalid_input"))?;
        let right = structure["right_table"]["object_id"]
            .as_str()
            .ok_or(Error::new("invalid_input"))?;
        if !visible.contains(left) || !visible.contains(right) {
            continue;
        }
        for key in structure["join_keys"].as_array().into_iter().flatten() {
            let lhs = key["left_column"]
                .as_str()
                .ok_or(Error::new("invalid_input"))?;
            let rhs = key["right_column"]
                .as_str()
                .ok_or(Error::new("invalid_input"))?;
            for table in [left, right] {
                join_keys
                    .entry(table)
                    .or_default()
                    .insert(format!("{lhs} = {rhs}"));
            }
        }
    }
    let mut upstream = Vec::new();
    for head in table_sources {
        let mut record = lineage_edge(
            head,
            match target["kind"].as_str() {
                Some("metric") => Relationship::MetricQuery,
                Some("field") => Relationship::FieldReference,
                _ => Relationship::TableRelation,
            },
            DownstreamKind::Table,
        )?;
        record.key_summary = join_keys
            .remove(record.object_id.as_str())
            .map(|keys| keys.into_iter().collect::<Vec<_>>().join(" · "));
        upstream.push(record);
    }

    let mut downstream = Vec::new();
    for item in dependents
        .iter()
        .filter(|item| item["state"] == "enabled" && item["id"] != id)
    {
        let (kind, relationship) = match item["kind"].as_str() {
            Some("table") => (DownstreamKind::Table, Relationship::TableRelation),
            Some("metric") => (DownstreamKind::Metric, Relationship::MetricQuery),
            Some("field") => (DownstreamKind::Field, Relationship::FieldReference),
            _ => continue,
        };
        downstream.push(lineage_edge(item, relationship, kind)?);
    }
    let skills = read(
        pool,
        ctx,
        id,
        json!({"kind":"skill","expected_version":target["version"]}),
    )
    .await?;
    let items = skills["items"]
        .as_array()
        .ok_or(Error::new("invalid_input"))?;
    for skill in items.iter().filter(|skill| skill["state"] == "enabled") {
        downstream.push(lineage_edge(
            skill,
            Relationship::SkillDependency,
            DownstreamKind::Skill,
        )?);
    }
    Ok(KnowledgeLineage {
        upstream,
        downstream,
        more_downstream: next_dependents.is_some() || !skills["next_after_id"].is_null(),
    })
}

fn lineage_edge(
    value: &Value,
    relationship: contracts::generated::Relationship,
    kind: contracts::generated::DownstreamKind,
) -> Result<contracts::generated::KnowledgeLineageEdge> {
    Ok(contracts::generated::KnowledgeLineageEdge {
        object_id: value["id"]
            .as_str()
            .ok_or(Error::new("invalid_input"))?
            .to_owned(),
        name: value["name"]
            .as_str()
            .ok_or(Error::new("invalid_input"))?
            .to_owned(),
        kind,
        relationship,
        key_summary: None,
    })
}

use crate::{
    persistence::AppTx,
    types::{AccessContext, Result},
};
use serde_json::{Value, json};
use sqlx::Row;
use std::collections::HashSet;

const PAGE_SIZE: usize = 50;

pub async fn find_dependents_in_tx(
    tx: &mut AppTx<'_>,
    ctx: &AccessContext,
    target: &Value,
    after: Option<&str>,
) -> Result<(Vec<Value>, Option<String>)> {
    let target_id = target["id"].as_str().unwrap_or("");
    let target_pattern = search_pattern(target_id);
    let source_pattern =
        (target["kind"] == "document").then(|| search_pattern(&format!("document-{target_id}")));
    let mut cursor = after.map(str::to_owned);
    let mut values = Vec::new();
    loop {
        let rows = sqlx::query("SELECT body FROM knowledge_objects WHERE space_id=? AND state<>'deleted' AND (? IS NULL OR id>?) AND (JSON_SEARCH(body,'one',?,NULL,'$.related_ids','$.entries') IS NOT NULL OR JSON_SEARCH(body,'one',?,NULL,'$.source_id','$.entries') IS NOT NULL) ORDER BY id LIMIT 101")
            .bind(&ctx.space_id).bind(&cursor).bind(&cursor)
            .bind(&target_pattern).bind(&source_pattern)
            .fetch_all(tx.connection()).await?;
        let finished = rows.len() < 101;
        for row in rows {
            let mut object = row.get::<sqlx::types::Json<Value>, _>("body").0;
            super::super::structure::project_object(&mut object);
            cursor = object["id"].as_str().map(str::to_owned);
            let mut references = direct_references(&object, target);
            if references.is_empty() {
                continue;
            }
            let complete = references.len() <= PAGE_SIZE;
            references.truncate(PAGE_SIZE);
            values.push(json!({
                "id":object["id"],"kind":object["kind"],"name":object["name"],
                "version":object["version"],"state":object["state"],
                "visibility":"space","can_edit":false,
                "references":references,"references_complete":complete,
            }));
            if values.len() > PAGE_SIZE {
                let next = values[PAGE_SIZE - 1]["id"].as_str().map(str::to_owned);
                values.truncate(PAGE_SIZE);
                return Ok((values, next));
            }
        }
        if finished {
            return Ok((values, None));
        }
    }
}

fn search_pattern(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('_', "\\_")
        .replace('%', "\\%")
}

fn direct_references(object: &Value, target: &Value) -> Vec<Value> {
    let mut values = Vec::new();
    let target_id = target["id"].as_str().unwrap_or("");
    let source = (target["kind"] == "document").then(|| format!("document-{target_id}"));
    let mut add = |dependent_path: &str, kind: &str, reference: &Value, material: bool| {
        let matches = if material {
            source
                .as_deref()
                .is_some_and(|source| reference["source_id"] == source)
        } else {
            reference["object_id"] == target_id
        };
        if matches {
            let path = reference["path"]
                .as_str()
                .or_else(|| reference["location"].as_str());
            let state = if target["state"] != "enabled" {
                "unavailable"
            } else if reference["version"] != target["version"] {
                "version_changed"
            } else {
                "current"
            };
            values.push(json!({"dependent_path":dependent_path,"relation_kind":kind,
                "referenced_version":reference["version"],"referenced_path":path,
                "reference_state":state}));
        }
    };
    if source
        .as_deref()
        .is_some_and(|source| object["source_id"] == source)
    {
        add(
            "source",
            "source_material",
            &json!({"source_id":object["source_id"],"version":object["source_version"]}),
            true,
        );
    }
    for entry in object["entries"].as_array().into_iter().flatten() {
        let path = entry["path"].as_str().unwrap_or("");
        let structure = &entry["effective_structure"];
        if matches!(
            structure["kind"].as_str(),
            Some("field" | "metric" | "relationship")
        ) {
            for reference in super::super::structure::table_dependencies(structure) {
                add(
                    path,
                    "structure",
                    &json!({"object_id":reference["object_id"],"version":reference["version"],"path":"ddl"}),
                    false,
                );
            }
        }
        if structure["kind"] == "query_example" {
            for reference in structure["dependencies"]
                .as_array()
                .into_iter()
                .flatten()
                .chain(
                    structure["verification"]["evidence_refs"]
                        .as_array()
                        .into_iter()
                        .flatten(),
                )
            {
                add(path, "query_example", reference, false);
            }
        }
        add(
            path,
            "source_material",
            &json!({"source_id":entry["source_facts"]["source_id"],"version":entry["source_facts"]["version"]}),
            true,
        );
        for reference in entry["suggestion"]["evidence"]
            .as_array()
            .into_iter()
            .flatten()
            .chain(
                entry["suggestion"]["material_refs"]
                    .as_array()
                    .into_iter()
                    .flatten(),
            )
            .chain(
                entry["source_facts"]["structured_evidence"]
                    .as_array()
                    .into_iter()
                    .flatten(),
            )
        {
            add(path, "source_material", reference, true);
        }
    }
    if object["related_ids"]
        .as_array()
        .is_some_and(|ids| ids.iter().any(|id| id == target_id))
    {
        values.push(
            json!({"dependent_path":"related_ids","relation_kind":"related",
            "referenced_version":null,"referenced_path":null,"reference_state":"related"}),
        );
    }
    let mut seen = HashSet::new();
    values.retain(|value| seen.insert(value.to_string()));
    values
}

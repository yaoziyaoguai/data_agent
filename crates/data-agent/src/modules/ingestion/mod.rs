pub mod catalog;
pub mod prefill;
pub use store::{
    begin_catalog_read_in_tx, catalog_candidate_in_tx, catalog_upstream_in_tx,
    check_catalog_read_in_tx, complete_catalog_namespace_in_tx, finish_catalog_read_in_tx,
    save_catalog_table_in_tx,
};
mod store;
pub use store::{
    assert_prefill_active_in_tx, check_prefill_sources_in_tx, claim_prefill_in_tx,
    effective_versions_in_tx, finish_prefill_in_tx, prefill_status_in_tx, queue_prefill_in_tx,
    read_source_in_tx, record_prefill_draft_in_tx, source_version_in_tx, source_versions_in_tx,
    sync_sources_in_tx,
};
pub use store::{read_analysis_preference_in_tx, save_analysis_preference_in_tx};
pub fn source_body(name: &str) -> crate::types::Result<String> {
    let builtin = match name {
        "schema.sql" => include_str!("../../../../../docs/sources/schema.sql"),
        "etl.sql" => include_str!("../../../../../docs/sources/etl.sql"),
        "business-guide.md" => include_str!("../../../../../docs/sources/business-guide.md"),
        "semantic-catalog.json" => {
            include_str!("../../../../../docs/sources/semantic-catalog.json")
        }
        _ => return Err(crate::types::Error::new("invalid_input")),
    };
    if let Ok(directory) = std::env::var("DATA_AGENT_SYNTHETIC_SOURCE_DIRECTORY") {
        return std::fs::read_to_string(std::path::Path::new(&directory).join(name))
            .map_err(|_| crate::types::Error::new("source_unavailable"));
    }
    Ok(builtin.to_owned())
}
pub fn synthetic_catalog() -> crate::types::Result<serde_json::Value> {
    let v: serde_json::Value = serde_json::from_str(&source_body("semantic-catalog.json")?)
        .map_err(|_| crate::types::Error::new("invalid_input"))?;
    if v["synthetic"] != true {
        return Err(crate::types::Error::new("invalid_input"));
    }
    Ok(v)
}

/// 只加载资料包已经声明并打包的来源，不按文档里的路径读取主机文件。
pub fn synthetic_sources() -> crate::types::Result<Vec<(String, String)>> {
    use sha2::{Digest, Sha256};
    let catalog_body = source_body("semantic-catalog.json")?;
    let catalog: serde_json::Value = serde_json::from_str(&catalog_body)
        .map_err(|_| crate::types::Error::new("invalid_input"))?;
    if catalog["synthetic"] != true {
        return Err(crate::types::Error::new("invalid_input"));
    }
    let mut sources = std::collections::BTreeMap::from([
        ("schema".to_owned(), source_body("schema.sql")?),
        ("etl".to_owned(), source_body("etl.sql")?),
        (
            "business-guide".to_owned(),
            source_body("business-guide.md")?,
        ),
    ]);
    for source in catalog["source_bundle"].as_array().into_iter().flatten() {
        let id = source["id"]
            .as_str()
            .ok_or(crate::types::Error::new("invalid_input"))?;
        let body = source["body"]
            .as_str()
            .ok_or(crate::types::Error::new("invalid_input"))?;
        if id.is_empty()
            || id.len() > 64
            || id == "semantic-catalog"
            || id.starts_with("document-")
            || !id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
            || source["sha256"] != format!("{:x}", Sha256::digest(body.as_bytes()))
            || sources.get(id).is_some_and(|existing| existing != body)
        {
            return Err(crate::types::Error::new("invalid_input"));
        }
        sources.insert(id.to_owned(), body.to_owned());
    }
    sources.insert("semantic-catalog".to_owned(), catalog_body);
    Ok(sources.into_iter().collect())
}

pub use store::{missing_catalog_sources_in_tx, retire_catalog_source_in_tx};

pub use store::freeze_prefill_input_in_tx;

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    #[test]
    fn cockpit_bundle_preserves_source_bytes_and_field_types() {
        let catalog: Value = serde_json::from_str(include_str!(
            "../../../../../docs/sources/cockpit/semantic-catalog.json"
        ))
        .unwrap();
        let bundle = catalog["source_bundle"].as_array().unwrap();
        for (id, body) in [
            (
                "schema",
                include_str!("../../../../../docs/sources/cockpit/schema.sql"),
            ),
            (
                "etl",
                include_str!("../../../../../docs/sources/cockpit/etl.sql"),
            ),
            (
                "business-guide",
                include_str!("../../../../../docs/sources/cockpit/business-guide.md"),
            ),
        ] {
            assert_eq!(bundle.iter().find(|s| s["id"] == id).unwrap()["body"], body);
        }
        let sources = bundle
            .iter()
            .map(|s| json!({"source_id":s["id"],"version":"1","body":s["body"]}))
            .collect::<Vec<_>>();
        for original in catalog["objects"].as_array().unwrap() {
            let mut object = original.clone();
            super::prefill::refresh_facts(&mut object, &sources);
            for entry in object["entries"].as_array().unwrap() {
                if original["kind"] == "field" && entry["path"] == "type" {
                    assert!(!entry["effective_value"].as_str().unwrap().is_empty());
                }
            }
        }
    }
}

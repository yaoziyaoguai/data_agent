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

pub use store::{missing_catalog_sources_in_tx, retire_catalog_source_in_tx};

pub use store::freeze_prefill_input_in_tx;

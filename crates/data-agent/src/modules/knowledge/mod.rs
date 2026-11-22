pub mod dependencies;
mod maintenance_impact;
mod store;
mod structure;
pub use maintenance_impact::find_dependents_in_tx;
pub use store::check_read_access_in_tx;
pub use store::live_table_ids_in_tx;
pub use store::table_objects_in_tx;
pub use store::{DocumentWindows, read_document_windows_in_tx, source_reference_objects_in_tx};
pub use store::{
    apply_proposal_in_tx, archived_body_in_tx, begin_create_in_tx, begin_edit_in_tx,
    begin_reanalysis_in_tx, change_state_in_tx, check_refs_in_tx, claim_index_batch_in_tx,
    create_in_tx, directory_page_in_tx, finish_index_in_tx, list_in_tx, matching_in_tx, page_in_tx,
    proposals_in_tx, propose_in_tx, read_entries_in_tx, read_entry_page_in_tx, read_in_tx,
    read_meta_in_tx, read_revision_fingerprint_in_tx, read_selected_structure_in_tx,
    read_structure_refs_in_tx, read_support_content_in_tx, read_supports_in_tx, reanalyze_in_tx,
    save_edit_in_tx, scoped_enabled_heads_in_tx, seed_in_tx,
};
pub use store::{
    bound_source_index_embedding_in_tx, claim_source_index_in_tx,
    freeze_source_index_embedding_in_tx, platform_source_index_progress_in_tx,
    register_source_index_target_in_tx, renew_source_index_lease_in_tx, source_index_heads_in_tx,
};
pub use store::{document_parts_in_tx, save_document_in_tx};
pub use store::{
    locate_document_quote_in_tx, read_source_fact_quote_in_tx, source_fact_refs_in_tx,
};
pub use store::{lock_versions_in_tx, related_documents_in_tx};
pub use store::{matching_content_in_tx, matching_scoped_in_tx};
pub use structure::{
    CurrentTableBinding, prove_original_binding, read_current_bindings_in_tx,
    semantic_dependencies, semantic_snapshot_in_tx, structure_dependencies, table_dependencies,
    validate_current_bindings_in_tx,
};

pub use store::is_deleted_in_tx;
pub use store::retire_source_objects_in_tx;
pub use store::{
    enabled_body_in_tx, enabled_head_in_tx, enabled_version_in_space_in_tx, enabled_versions_in_tx,
};

pub use store::{
    candidate_meta_in_tx, current_enabled_heads_in_tx, current_versions_in_tx,
    identity_candidate_ids_in_tx, independent_document_candidate_in_tx,
    independent_document_heads_in_tx, index_coverage_in_tx, index_rebuild_receipt_in_tx,
    rebuild_index_in_tx, rebuild_source_index_in_tx,
};

pub use store::{bound_index_embedding_in_tx, freeze_index_embedding_in_tx};

pub mod corrections;
pub use store::proposal_in_tx;

pub use store::source_objects_in_tx;
pub use store::source_tables_in_tx;

pub use store::index_progress_in_tx;

mod preparation;
pub use preparation::apply_preparation_in_tx;
pub mod dependency_index;

pub use store::{
    apply_entry_in_tx, begin_entry_batch_in_tx, lock_entry_batch_in_tx, persist_entry_batch_in_tx,
    record_entry_batch_in_tx,
};

pub(crate) use store::push_workspace_dependency_heads;

mod result_reading;
pub use result_reading::agent_result_page;
pub mod platform;
mod result_statistics;
pub use result_statistics::{is_decimal_cell, page_statistics};
mod saved_results;
pub use saved_results::{
    SAVED_RESULT_LIMIT, SAVED_RESULT_MAX_PAGES, merge_saved_result_pages, saved_result_next_cursor,
};
mod semantic_checks;
pub use semantic_checks::{annotate_result_columns, check_semantics, is_table_free_select};
mod grouping_validation;
pub use grouping_validation::check_grouping_ambiguity;
mod table_references;
pub use table_references::referenced_tables;
mod store;
pub use store::task_waiting_phase_in_tx;
pub(crate) use store::{DELIVERY_QUERY_SQL, push_delivery_result_heads};
pub use store::{
    DraftValidation, LEASE_SECONDS, MessageAuthorization, begin_revision_in_tx,
    begin_submission_in_tx, cancel_in_tx, claim_due, confirm_in_tx, created_at_in_tx,
    is_confirmation_message_in_tx, list_history_page_in_tx, list_in_tx, locate,
    mark_notified_in_tx, read_in_tx, read_map_in_tx, record_observation_in_tx, renew_claim,
    retry_missing_in_tx, save_draft_in_tx, supersede_in_tx,
};
mod chart_results;
pub use chart_results::validate_report_chart;

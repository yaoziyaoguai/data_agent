mod decisions;
mod evidence;
mod report;
mod store;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AnalysisUpdateDialect {
    Legacy,
    Current,
}

pub struct AnalysisUpdateRequest<'a> {
    pub arguments: &'a serde_json::Value,
    pub dialect: AnalysisUpdateDialect,
}

pub use decisions::{
    ConditionRevision, DecisionStateVersion, LegacyDecisionMigration, LegacyResolutionProof,
    legacy_resolution_pending, normalized_adoption, same_adoption,
};
pub use evidence::{
    EvidenceSaveSources, delete_conversation_evidence_in_tx, delete_evidence_in_tx,
    read_evidence_authority_in_tx, read_evidence_conditions_in_tx, read_evidence_in_tx,
    save_evidence_in_tx,
};
pub use report::{
    ReportSaveSources, delete_conversation_reports_in_tx, read_report_authorities_in_tx,
    read_report_in_tx, read_report_revision_in_tx, report_receipt_in_tx, report_ref_in_tx,
    save_report_in_tx,
};
pub use store::{LockedTasks, create_task_in_tx, lock_tasks_in_tx, read_tasks_in_tx};
pub use store::{
    TaskTextAuthority, apply_update_in_tx, assert_current_in_tx, assert_read_context_in_tx,
    cancel_task_in_tx, clarification_preview_for_task_in_tx, condition_text_authorities_in_tx,
    context_in_tx, declared_source_limits_in_tx, read_task_in_tx,
    read_task_with_clarifications_in_tx, recovery_state_in_tx, set_phase_in_tx,
    source_limits_at_version_in_tx, task_text_authorities_in_tx,
    task_text_result_dependencies_in_tx,
};
pub use store::{
    active_task_sources_unrestricted_in_tx, condition_revision_in_tx,
    current_condition_revision_in_tx,
};

pub use store::{lifecycle_receipt_in_tx, record_lifecycle_receipt_in_tx, task_directory_in_tx};

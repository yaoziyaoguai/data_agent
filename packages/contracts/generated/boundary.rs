// Generated from packages/contracts/schema.json; do not edit.
// Example code that deserializes and serializes the model.
// extern crate serde;
// #[macro_use]
// extern crate serde_derive;
// extern crate serde_json;
//
// use generated_module::Boundary;
//
// fn main() {
//     let json = r#"{"answer": 42}"#;
//     let model: Boundary = serde_json::from_str(&json).unwrap();
// }

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Boundary {
    #[serde(rename = "AnalysisPreferenceCommand")]
    pub analysis_preference_command: Option<AnalysisPreferenceCommand>,
    pub analysis_update: AnalysisUpdate,
    pub append_output: AppendOutput,
    pub app_error: AppError,
    #[serde(rename = "ApplySemanticCorrection")]
    pub apply_semantic_correction: Option<ApplySemanticCorrection>,
    pub asset: Asset,
    pub asset_list: AssetList,
    pub asset_save: AssetSave,
    pub asset_tool_input: AssetToolInput,
    #[serde(rename = "AssignSemanticMaintainer")]
    pub assign_semantic_maintainer: Option<AssignSemanticMaintainer>,
    pub cancel_receipt: CancelReceipt,
    pub cancel_run: CancelRun,
    #[serde(rename = "CatalogColumn")]
    pub catalog_column: Option<CatalogColumn>,
    #[serde(rename = "CatalogNode")]
    pub catalog_node: Option<CatalogNode>,
    #[serde(rename = "CatalogPage")]
    pub catalog_page: Option<CatalogPage>,
    #[serde(rename = "CatalogTable")]
    pub catalog_table: Option<CatalogTable>,
    pub chat_message: ChatMessage,
    pub checkpoint: Checkpoint,
    #[serde(rename = "checkpoint_reference")]
    pub checkpoint_reference: CheckpointReference,
    pub conditions: Conditions,
    pub confirm_query: ConfirmQuery,
    pub conversation_read_input: ConversationReadInput,
    pub conversation_receipt: ConversationReceipt,
    pub create_conversation: CreateConversation,
    pub data_tool_invocation: DataToolInvocation,
    pub data_tool_outcome: DataToolOutcome,
    pub embedding_profile: EmbeddingProfile,
    pub event: Event,
    pub evidence_ref: EvidenceRef,
    pub finalize_model_call: FinalizeModelCall,
    pub finish_receipt: FinishReceipt,
    pub finish_run: FinishRun,
    pub history: History,
    pub history_item: HistoryItem,
    pub history_query: HistoryQuery,
    #[serde(rename = "host_checkpoint_reference")]
    pub host_checkpoint_reference: HostCheckpointReference,
    pub identity: Identity,
    pub knowledge_create: KnowledgeCreate,
    pub knowledge_edit: KnowledgeEdit,
    pub knowledge_entry: KnowledgeEntry,
    pub knowledge_list: KnowledgeList,
    pub knowledge_list_query: KnowledgeListQuery,
    pub knowledge_object: KnowledgeObject,
    pub logout_receipt: LogoutReceipt,
    pub memory_budget_binding: Option<MemoryBudgetBinding>,
    pub memory_candidate: Option<MemoryCandidate>,
    pub memory_extraction_receipt: Option<MemoryExtractionReceipt>,
    pub memory_extraction_request: Option<MemoryExtractionRequest>,
    pub memory_index_receipt: Option<MemoryIndexReceipt>,
    pub memory_index_request: Option<MemoryIndexRequest>,
    pub memory_model_call: Option<MemoryModelCall>,
    pub memory_search_receipt: Option<MemorySearchReceipt>,
    pub memory_search_request: Option<MemorySearchRequest>,
    pub message_input: MessageInput,
    pub message_receipt: MessageReceipt,
    pub model_attempt: ModelAttempt,
    pub model_call_receipt: ModelCallReceipt,
    pub model_profile: ModelProfile,
    pub model_receipt: ModelReceipt,
    pub model_usage: ModelUsage,
    pub mutation_receipt: MutationReceipt,
    pub operation_receipt: OperationReceipt,
    pub output_receipt: OutputReceipt,
    #[serde(rename = "pi_session_reference")]
    pub pi_session_reference: PiSessionReference,
    pub prefill_result: PrefillResult,
    pub proposal: Proposal,
    #[serde(rename = "ProposalDraftCommand")]
    pub proposal_draft_command: Option<ProposalDraftCommand>,
    pub proposal_input: ProposalInput,
    pub proposal_list: ProposalList,
    pub query_cancellation: Option<QueryCancellation>,
    pub query_list: QueryList,
    pub query_results: QueryResults,
    pub query_view: QueryView,
    #[serde(rename = "read_checkpoint")]
    pub read_checkpoint: ReadCheckpoint,
    pub read_knowledge_input: ReadKnowledgeInput,
    pub read_query_input: ReadQueryInput,
    pub read_source_input: ReadSourceInput,
    pub read_task_input: Option<ReadTaskInput>,
    pub request_query_input: RequestQueryInput,
    pub reserve_model_call: ReserveModelCall,
    pub result_column: ResultColumn,
    #[serde(rename = "ReviewSemanticCorrection")]
    pub review_semantic_correction: Option<ReviewSemanticCorrection>,
    #[serde(rename = "ReviseSemanticCorrection")]
    pub revise_semantic_correction: Option<ReviseSemanticCorrection>,
    pub run_envelope: RunEnvelope,
    pub run_snapshot: RunSnapshot,
    pub search_input: SearchInput,
    #[serde(rename = "SemanticAccess")]
    pub semantic_access: Option<SemanticAccess>,
    #[serde(rename = "SemanticCorrection")]
    pub semantic_correction: Option<SemanticCorrection>,
    #[serde(rename = "SemanticCorrectionList")]
    pub semantic_correction_list: Option<SemanticCorrectionList>,
    #[serde(rename = "SemanticMaintenance")]
    pub semantic_maintenance: Option<SemanticMaintenance>,
    #[serde(rename = "SemanticMemberList")]
    pub semantic_member_list: Option<SemanticMemberList>,
    pub send_model_call: SendModelCall,
    pub session_receipt: SessionReceipt,
    pub skill_selection: SkillSelection,
    pub snapshot: Snapshot,
    pub source_document: SourceDocument,
    pub sql_input: SqlInput,
    #[serde(rename = "SubmitSemanticCorrection")]
    pub submit_semantic_correction: Option<SubmitSemanticCorrection>,
    #[serde(rename = "TableAnalysisPreference")]
    pub table_analysis_preference: Option<TableAnalysisPreference>,
    pub task_input: TaskInput,
    pub task_snapshot: TaskSnapshot,
    pub tool_invocation: ToolInvocation,
    pub tool_outcome: ToolOutcome,
    pub tool_receipt: ToolReceipt,
    pub version_command: VersionCommand,
    pub workspace_context: WorkspaceContext,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisPreferenceCommand {
    pub expected_version: String,
    pub operation_id: String,
    pub preferred: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisUpdate {
    pub action: AnalysisUpdateAction,
    ///
    /// 修改已存任务条件时必填，action用revise或clarify；set指定新值，unset必须提供（不清空时为[]）。route禁止携带condition_patch，因为route只登记归属。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub condition_patch: Option<ConditionPatch>,
    /// 新建任务必须完整给出；未指定的可空标量用JSON null，列表用[]，notes用空字符串，timezone按宿主业务时区。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conditions: Option<Conditions>,
    /// 新建任务省略此字段（也接受JSON null）；已有任务必须提供工具回执中的当前版本数字字符串。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_version: Option<String>,
    pub goal: String,
    /// 澄清问题的候选答案；question=null时传[]。
    pub options: Vec<String>,
    /// 需要用户补充的实际问题；无需澄清时省略（也接受JSON null），不能填字符串null、空文本或用户原问题。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replaces_query_id: Option<String>,
    /// 新建任务省略此字段（也接受JSON null）；已有任务用工具回执中的真实ID，不能填字符串null。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnalysisUpdateAction {
    Clarify,
    Create,
    Revise,
    Route,
}

///
/// 修改已存任务条件时必填，action用revise或clarify；set指定新值，unset必须提供（不清空时为[]）。route禁止携带condition_patch，因为route只登记归属。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConditionPatch {
    pub set: ConditionSet,
    pub unset: Vec<Unset>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConditionSet {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<Channel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filters: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_by: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub knowledge_refs: Option<Vec<EvidenceRef>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metric: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_end: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_start: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Channel {
    App,
    Store,
    Web,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvidenceRef {
    /// read_knowledge或search_knowledge返回的知识对象id；不是read_source返回的source_id。
    pub object_id: String,
    /// 该知识对象entries中的path，必须确实存在于对应version。
    pub path: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Unset {
    Channel,
    Filters,
    #[serde(rename = "group_by")]
    GroupBy,
    #[serde(rename = "knowledge_refs")]
    KnowledgeRefs,
    Metric,
    Notes,
    #[serde(rename = "time_end")]
    TimeEnd,
    #[serde(rename = "time_start")]
    TimeStart,
}

/// 新建任务必须完整给出；未指定的可空标量用JSON null，列表用[]，notes用空字符串，timezone按宿主业务时区。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conditions {
    pub channel: Option<Channel>,
    pub filters: Vec<String>,
    pub group_by: Vec<String>,
    pub knowledge_refs: Vec<EvidenceRef>,
    pub metric: Option<String>,
    pub notes: String,
    pub time_end: Option<String>,
    pub time_start: Option<String>,
    pub timezone: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppError {
    pub code: Code,
    pub message: String,
    pub request_id: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Code {
    #[serde(rename = "budget_exhausted")]
    BudgetExhausted,
    #[serde(rename = "chunk_gap")]
    ChunkGap,
    #[serde(rename = "embedding_unavailable")]
    EmbeddingUnavailable,
    Forbidden,
    #[serde(rename = "idempotency_conflict")]
    IdempotencyConflict,
    #[serde(rename = "input_already_applied")]
    InputAlreadyApplied,
    #[serde(rename = "invalid_evidence")]
    InvalidEvidence,
    #[serde(rename = "invalid_input")]
    InvalidInput,
    #[serde(rename = "lease_lost")]
    LeaseLost,
    #[serde(rename = "memory_extraction_empty")]
    MemoryExtractionEmpty,
    #[serde(rename = "memory_operation_unknown")]
    MemoryOperationUnknown,
    #[serde(rename = "memory_unavailable")]
    MemoryUnavailable,
    #[serde(rename = "message_pending")]
    MessagePending,
    #[serde(rename = "not_available")]
    NotAvailable,
    #[serde(rename = "outcome_unknown")]
    OutcomeUnknown,
    #[serde(rename = "result_unavailable")]
    ResultUnavailable,
    #[serde(rename = "scope_incomplete")]
    ScopeIncomplete,
    #[serde(rename = "selection_required")]
    SelectionRequired,
    #[serde(rename = "source_interrupted")]
    SourceInterrupted,
    #[serde(rename = "source_unavailable")]
    SourceUnavailable,
    #[serde(rename = "stale_context")]
    StaleContext,
    #[serde(rename = "stale_knowledge")]
    StaleKnowledge,
    Unauthenticated,
    Unavailable,
    Unsupported,
    #[serde(rename = "vector_unavailable")]
    VectorUnavailable,
    #[serde(rename = "vector_unconfigured")]
    VectorUnconfigured,
    #[serde(rename = "version_conflict")]
    VersionConflict,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppendOutput {
    pub chunk_seq: String,
    pub lease_epoch: String,
    pub run_id: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApplySemanticCorrection {
    pub expected_revision: String,
    pub expected_version: String,
    pub operation_id: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Asset {
    pub body: String,
    pub dependencies: Vec<EvidenceRef>,
    pub id: String,
    pub kind: AssetKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_index_state: Option<MemoryIndexState>,
    pub name: String,
    pub scope: String,
    pub selected: bool,
    pub source_text: String,
    pub state: AssetState,
    pub verified: bool,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssetKind {
    Memory,
    Skill,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryIndexState {
    Failed,
    Indexed,
    Issued,
    Queued,
    Superseded,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssetState {
    Deleted,
    Disabled,
    Enabled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetList {
    pub assets: Vec<Asset>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetSave {
    pub body: String,
    pub dependencies: Vec<EvidenceRef>,
    pub expected_version: Option<String>,
    pub id: Option<String>,
    pub kind: AssetKind,
    pub name: String,
    pub operation_id: String,
    pub scope: String,
    pub source_text: String,
    pub verified: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetToolInput {
    pub action: AssetToolInputAction,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dependencies: Option<Vec<EvidenceRef>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_version: Option<String>,
    ///
    /// 保存或修订记忆所依据的本条用户消息逐字原文；句子/分号边界或逗号后明确以另外/此外另起的指令可作起点。引用在逗号结束时，宿主补齐同句剩余原文至句末/分号，核对并保存source_text，避免裁掉尾部否定与限定；最终正文只保留可复用内容，scope完整沿用最终正文中的对象和限定；不能把当次请求写为长期默认。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instruction_quote: Option<String>,
    /// 候选显示名称；自动保存时宿主从最终正文截取前40个Unicode字符作为正式标签，避免另一次概括改变业务对象。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// 候选范围，参与临时限定预检查。自动保存时正式scope与最终body使用同一份完整提取文字，保留对象/限定；不能增加指标别名或扩大范围。以工具回执为准。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verified: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssetToolInputAction {
    #[serde(rename = "disable_memory")]
    DisableMemory,
    #[serde(rename = "save_memory")]
    SaveMemory,
    #[serde(rename = "update_memory")]
    UpdateMemory,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssignSemanticMaintainer {
    pub expected_version: String,
    /// 超级维护者调整独立对象负责人；null 撤销，不能调整 Datasight 表或字段。
    pub maintainer_id: Option<String>,
    pub operation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CancelReceipt {
    pub run_id: String,
    pub state: CancelReceiptState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CancelReceiptState {
    Cancelled,
    Failed,
    Finished,
    Interrupted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CancelRun {
    pub lease_epoch: String,
    pub run_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogColumn {
    pub comment: String,
    pub data_type: String,
    pub id: String,
    pub name: String,
    pub nullable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogNode {
    pub id: String,
    pub sql: String,
    pub upstream_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogPage {
    /// true表示该snapshot覆盖完整命名空间，可在全部分页成功后使缺席对象失效；false不允许推断删除。
    pub authoritative: bool,
    pub complete: bool,
    pub next_cursor: Option<String>,
    pub schema_version: f64,
    pub snapshot_id: String,
    pub source_namespace: String,
    pub tables: Vec<CatalogTable>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogTable {
    pub columns: Vec<CatalogColumn>,
    pub comment: String,
    pub ddl: String,
    pub id: String,
    /// Datasight 维护人；未提供或 null 表示暂无负责人，不继承录入者。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub maintainer_id: Option<String>,
    pub name: String,
    pub node: Option<CatalogNode>,
    pub platform_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub attempt_id: Option<String>,
    pub committed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_seq: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_clock: Option<RequestClock>,
    pub role: Role,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestClock {
    pub business_timezone: BusinessTimezone,
    pub reference_time_utc: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum BusinessTimezone {
    #[serde(rename = "Asia/Shanghai")]
    AsiaShanghai,
    #[serde(rename = "UTC")]
    Utc,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Assistant,
    User,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Checkpoint {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authority_revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authority_snapshot: Option<HashMap<String, Option<serde_json::Value>>>,
    pub entries: Vec<HashMap<String, Option<serde_json::Value>>>,
    pub leaf_id: Option<String>,
    pub sdk_version: SdkVersion,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub storage: Option<CheckpointReference>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SdkVersion {
    #[serde(rename = "1.0.0")]
    The100,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckpointReference {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    pub kind: CheckpointReferenceKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckpointReferenceKind {
    #[serde(rename = "host_checkpoint")]
    HostCheckpoint,
    #[serde(rename = "pi_session")]
    PiSession,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfirmQuery {
    pub condition_version: String,
    pub draft_version: String,
    pub operation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationReadInput {
    pub after_seq: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_after: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_directory: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationReceipt {
    pub conversation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateConversation {
    pub operation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataToolInvocation {
    pub arguments: HashMap<String, Option<serde_json::Value>>,
    pub checkpoint: Checkpoint,
    pub lease_epoch: String,
    pub run_id: String,
    pub sdk_tool_call_id: String,
    pub tool_name: ToolName,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolName {
    #[serde(rename = "cancel_query")]
    CancelQuery,
    #[serde(rename = "get_query")]
    GetQuery,
    #[serde(rename = "manage_personal_asset")]
    ManagePersonalAsset,
    #[serde(rename = "propose_semantic_change")]
    ProposeSemanticChange,
    #[serde(rename = "read_analysis_task")]
    ReadAnalysisTask,
    #[serde(rename = "read_conversation")]
    ReadConversation,
    #[serde(rename = "read_knowledge")]
    ReadKnowledge,
    #[serde(rename = "read_source")]
    ReadSource,
    #[serde(rename = "request_query")]
    RequestQuery,
    #[serde(rename = "search_knowledge")]
    SearchKnowledge,
    #[serde(rename = "update_analysis_task")]
    UpdateAnalysisTask,
    #[serde(rename = "validate_sql")]
    ValidateSql,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataToolOutcome {
    pub data: HashMap<String, Option<serde_json::Value>>,
    pub operation_id: String,
    pub tool_name: ToolName,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddingProfile {
    pub call_limit: i32,
    pub cost_limit_micros: String,
    pub trial_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    pub conversation_id: String,
    pub event_id: String,
    pub event_seq: String,
    pub payload: HashMap<String, Option<serde_json::Value>>,
    pub schema_version: i64,
    #[serde(rename = "type")]
    pub event_type: EventType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventType {
    #[serde(rename = "assistant_committed")]
    AssistantCommitted,
    #[serde(rename = "assistant_delta")]
    AssistantDelta,
    #[serde(rename = "assistant_replaced")]
    AssistantReplaced,
    #[serde(rename = "conversation_deleted")]
    ConversationDeleted,
    #[serde(rename = "memory_disabled")]
    MemoryDisabled,
    #[serde(rename = "memory_saved")]
    MemorySaved,
    Message,
    #[serde(rename = "message_withdrawn")]
    MessageWithdrawn,
    #[serde(rename = "query_changed")]
    QueryChanged,
    #[serde(rename = "query_result")]
    QueryResult,
    #[serde(rename = "run_cancelled")]
    RunCancelled,
    #[serde(rename = "run_failed")]
    RunFailed,
    #[serde(rename = "task_cancelled")]
    TaskCancelled,
    #[serde(rename = "task_changed")]
    TaskChanged,
    #[serde(rename = "tool_result")]
    ToolResult,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FinalizeModelCall {
    pub call_attempt_id: String,
    pub lease_epoch: String,
    pub parameters_fingerprint: String,
    pub run_id: String,
    pub usage: Option<ModelUsage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelUsage {
    pub elapsed_ms: i32,
    pub input_tokens: i32,
    pub output_tokens: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FinishReceipt {
    pub output_id: String,
    pub state: FinishReceiptState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FinishReceiptState {
    Finished,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FinishRun {
    pub checkpoint: Checkpoint,
    pub commit_id: String,
    /// Pi最后助手消息的首个已保存片段序号；省略时沿用从1起的完整文本校验。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub final_start_chunk_seq: Option<String>,
    pub final_text: String,
    pub lease_epoch: String,
    pub run_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct History {
    pub conversations: Vec<HistoryItem>,
    pub next_before_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryItem {
    pub id: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub q: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostCheckpointReference {
    pub fingerprint: String,
    pub kind: HostCheckpointReferenceKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostCheckpointReferenceKind {
    #[serde(rename = "host_checkpoint")]
    HostCheckpoint,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Identity {
    pub model_label: ModelLabel,
    pub user_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ModelLabel {
    #[serde(rename = "DeepSeek Flash")]
    DeepSeekFlash,
    #[serde(rename = "DeepSeek V4 Pro")]
    DeepSeekV4Pro,
    #[serde(rename = "本地模拟模型")]
    Empty,
}

/// 独立对象首次创建时自动归属可信登录者；请求不接受负责人字段，后续调整使用独立管理接口。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeCreate {
    pub body: String,
    pub kind: KnowledgeCreateKind,
    pub name: String,
    pub operation_id: String,
    pub related_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KnowledgeCreateKind {
    Document,
    Field,
    Metric,
    Relationship,
    Table,
    Term,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeEdit {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clear_override: Option<bool>,
    pub entry_id: String,
    pub expected_version: String,
    pub operation_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub related_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeEntry {
    pub effective_value: String,
    pub entry_id: String,
    pub human_override: Option<HashMap<String, Option<serde_json::Value>>>,
    pub label: String,
    pub path: String,
    pub review_state: ReviewState,
    pub source_facts: HashMap<String, Option<serde_json::Value>>,
    pub suggestion: HashMap<String, Option<serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewState {
    Confirmed,
    #[serde(rename = "needs_review")]
    NeedsReview,
    Unverified,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeList {
    pub next_after_id: Option<String>,
    pub objects: Vec<KnowledgeObject>,
    pub retrieval_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search_coverage: Option<SearchCoverage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeObject {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub analysis_preference: Option<TableAnalysisPreference>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_by: Option<String>,
    pub entries: Vec<KnowledgeEntry>,
    pub id: String,
    pub kind: KnowledgeCreateKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub maintenance: Option<SemanticMaintenance>,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prefill_status: Option<PrefillStatus>,
    pub related_ids: Vec<String>,
    pub source_id: Option<String>,
    pub source_version: String,
    pub state: AssetState,
    /// 平台移除与人工停用分开；重新出现只能恢复平台导致的停用。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_origin: Option<StateOrigin>,
    pub updated_by: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableAnalysisPreference {
    pub preferred: bool,
    pub table_id: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SemanticMaintenance {
    pub authority_id: String,
    pub can_assign: bool,
    pub can_edit: bool,
    /// 当前对象负责人：表来自 Datasight；独立人工对象默认创建者，超级维护者可调整。
    pub maintainer_id: Option<String>,
    pub source: SemanticMaintenanceSource,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SemanticMaintenanceSource {
    Creator,
    Datasight,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrefillStatus {
    pub attempt_id: String,
    pub error_code: Option<String>,
    pub state: String,
}

/// 平台移除与人工停用分开；重新出现只能恢复平台导致的停用。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StateOrigin {
    Human,
    Platform,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchCoverage {
    pub candidate_limit: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index_state: Option<IndexState>,
    pub state: SearchCoverageState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vector_state: Option<VectorState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IndexState {
    Current,
    Incomplete,
    Unconfigured,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SearchCoverageState {
    Bounded,
    #[serde(rename = "candidate_limit")]
    CandidateLimit,
    Complete,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VectorState {
    Available,
    Unavailable,
    Unconfigured,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeListQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after_id: Option<String>,
    /// 管理目录按名称和状态分页；maintained按当前负责人关系筛选，包含停用项。省略时保留现有语义检索。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub directory: Option<Directory>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub q: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub related_id: Option<String>,
    /// 仅用于管理目录；省略时包含启用及停用，始终排除已删除对象。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<KnowledgeListQueryState>,
}

/// 管理目录按名称和状态分页；maintained按当前负责人关系筛选，包含停用项。省略时保留现有语义检索。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Directory {
    All,
    Maintained,
}

/// 仅用于管理目录；省略时包含启用及停用，始终排除已删除对象。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KnowledgeListQueryState {
    Disabled,
    Enabled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogoutReceipt {
    pub state: LogoutReceiptState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LogoutReceiptState {
    #[serde(rename = "logged_out")]
    LoggedOut,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryBudgetBinding {
    pub epoch: String,
    pub id: String,
    pub kind: MemoryBudgetBindingKind,
    pub operation_id: String,
    pub sdk_tool_call_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryBudgetBindingKind {
    Index,
    Run,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryCandidate {
    pub asset_id: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryExtractionReceipt {
    pub body: String,
    pub operation_id: String,
    pub replayed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryExtractionRequest {
    pub budget: MemoryBudgetBinding,
    pub message: String,
    pub operation_id: String,
    pub owner_id: String,
    pub quote: String,
    pub space_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryIndexReceipt {
    pub operation_id: String,
    pub state: MemoryIndexReceiptState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryIndexReceiptState {
    Ready,
    Removed,
    Superseded,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryIndexRequest {
    pub asset: Asset,
    pub budget: MemoryBudgetBinding,
    pub extraction_operation_id: Option<String>,
    pub operation_id: String,
    pub owner_id: String,
    pub space_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryModelCall {
    pub action: MemoryModelCallAction,
    pub budget: MemoryBudgetBinding,
    pub call_attempt_id: String,
    pub input_tokens_upper: i32,
    pub output_tokens_max: i64,
    pub parameters_fingerprint: String,
    pub purpose: Purpose,
    pub usage: Option<ModelUsage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryModelCallAction {
    Finalize,
    Issue,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Purpose {
    #[serde(rename = "memory_embedding")]
    MemoryEmbedding,
    #[serde(rename = "memory_extraction")]
    MemoryExtraction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemorySearchReceipt {
    pub bounded: bool,
    pub candidates: Vec<MemoryCandidate>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemorySearchRequest {
    pub budget: MemoryBudgetBinding,
    pub operation_id: String,
    pub owner_id: String,
    pub query: String,
    pub space_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageInput {
    pub client_message_id: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageReceipt {
    pub message_id: String,
    pub request_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelAttempt {
    pub call_attempt_id: String,
    pub lease_epoch: String,
    pub run_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelCallReceipt {
    pub send_allowed: bool,
    pub state: ModelCallReceiptState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelCallReceiptState {
    Issued,
    Reserved,
    Settled,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelProfile {
    pub input_limit: i64,
    pub model_id: String,
    pub output_limit: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload_bytes_limit: Option<i32>,
    pub price_version: String,
    pub provider_id: ProviderId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_call_limit: Option<i32>,
    /// 通过Pi/DeepSeek原生思考模式；省略为off。思考tokens计入同一输出上限与用量。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<ThinkingLevel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub toolset: Option<Toolset>,
    pub trial_call_limit: i32,
    pub trial_cost_micros: String,
    pub trial_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderId {
    Deepseek,
}

/// 通过Pi/DeepSeek原生思考模式；省略为off。思考tokens计入同一输出上限与用量。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThinkingLevel {
    High,
    Low,
    Off,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Toolset {
    Data,
    Task,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelReceipt {
    pub state: ModelReceiptState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelReceiptState {
    Issued,
    Settled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MutationReceipt {
    pub operation_id: String,
    pub resource_id: String,
    pub state: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperationReceipt {
    pub operation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputReceipt {
    pub chunk_seq: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PiSessionReference {
    pub file: String,
    pub kind: PiSessionReferenceKind,
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PiSessionReferenceKind {
    #[serde(rename = "pi_session")]
    PiSession,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrefillResult {
    pub entries: Vec<Entry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    pub entry_id: String,
    pub evidence: Vec<Evidence>,
    pub gaps: Vec<String>,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Evidence {
    pub location: String,
    pub quote: String,
    pub source_id: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Proposal {
    pub base_version: String,
    pub entry_id: String,
    pub evidence: Vec<EvidenceRef>,
    pub id: String,
    pub object_id: String,
    pub reason: String,
    pub state: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProposalDraftCommand {
    pub base_version: String,
    pub entry_id: String,
    pub evidence: Vec<EvidenceRef>,
    pub object_id: String,
    pub operation_id: String,
    pub reason: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProposalInput {
    pub base_version: String,
    pub entry_id: String,
    pub evidence: Vec<EvidenceRef>,
    pub object_id: String,
    pub reason: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProposalList {
    pub proposals: Vec<Proposal>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryCancellation {
    pub cancel_state: String,
    pub condition_version: String,
    pub execution_state: String,
    pub id: String,
    pub task_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryList {
    pub confirmation_blocked: bool,
    pub queries: Vec<QueryView>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryView {
    pub cancel_state: String,
    pub check_state: String,
    pub condition_version: String,
    pub confirmation_state: String,
    pub conversation_id: String,
    pub draft_version: String,
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_details: Option<ErrorDetails>,
    pub execution_state: String,
    pub id: String,
    pub knowledge_refs: Vec<EvidenceRef>,
    pub parameters: HashMap<String, Option<serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replaces_query_id: Option<String>,
    pub result_ref: Option<String>,
    pub sql: String,
    pub summary: String,
    pub target_id: String,
    pub task_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorDetails {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResults {
    pub columns: Vec<ResultColumn>,
    pub data_freshness: String,
    pub fetched_offset: String,
    pub next_cursor: Option<String>,
    pub query_id: String,
    pub result_complete: bool,
    pub result_ref: String,
    pub rows: Vec<Vec<Option<String>>>,
    pub source: QueryResultsSource,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResultColumn {
    pub encoding: String,
    pub name: String,
    #[serde(rename = "type")]
    pub result_column_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QueryResultsSource {
    Mock,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadCheckpoint {
    pub lease_epoch: String,
    pub run_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadKnowledgeInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i32>,
    pub object_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadQueryInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    pub query_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadSourceInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<i32>,
    /// 原始来源ID或document-加知识文档ID的保留别名；文档仍按当前空间、状态和版本校验。
    pub source_id: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadTaskInput {
    pub task_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestQueryInput {
    pub condition_version: String,
    pub knowledge_refs: Vec<EvidenceRef>,
    pub parameters: HashMap<String, Option<serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replaces_query_id: Option<String>,
    pub sql: String,
    pub summary: String,
    pub target_id: TargetId,
    pub task_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TargetId {
    #[serde(rename = "synthetic-sqlite")]
    SyntheticSqlite,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReserveModelCall {
    pub call_attempt_id: String,
    pub input_tokens_upper: i64,
    pub lease_epoch: String,
    pub output_tokens_max: i64,
    pub parameters_fingerprint: String,
    pub run_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewSemanticCorrection {
    pub decision: Decision,
    pub expected_revision: String,
    pub operation_id: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    Accepted,
    Rejected,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviseSemanticCorrection {
    pub base_version: String,
    pub entry_id: String,
    pub evidence: Vec<EvidenceRef>,
    pub expected_revision: String,
    pub object_id: String,
    pub operation_id: String,
    pub reason: String,
    pub share_confirmed: bool,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunEnvelope {
    pub attempt_id: String,
    pub budget_scope_id: String,
    pub checkpoint: Option<Checkpoint>,
    pub conversation_id: String,
    pub lease_epoch: String,
    pub message_id: String,
    pub model_profile: Option<ModelProfile>,
    pub output_id: String,
    pub recovery_chain_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_clock: Option<RequestClock>,
    pub request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_same_input: Option<bool>,
    pub run_id: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_context: Option<WorkspaceContext>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceContext {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_counts: Option<AssetCounts>,
    pub authority_revision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authority_snapshot: Option<HashMap<String, Option<serde_json::Value>>>,
    /// 当前输入的持久全部任务归属；恢复时按当前lifecycle继续剩余目标。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_task_ids: Option<Vec<String>>,
    pub memories: Vec<ModelAssetPreview>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_retrieval: Option<MemoryRetrieval>,
    pub query_observations: Vec<HashMap<String, Option<serde_json::Value>>>,
    pub recent_messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_clock: Option<RequestClock>,
    pub selected_skills: Vec<ModelAssetPreview>,
    pub tasks: Vec<HashMap<String, Option<serde_json::Value>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetCounts {
    pub memories: i64,
    pub selected_skills: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelAssetPreview {
    pub body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_page: Option<ContentPage>,
    pub dependencies: Vec<EvidenceRef>,
    pub id: String,
    pub kind: AssetKind,
    pub name: String,
    pub scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope_page: Option<ContentPage>,
    pub selected: bool,
    pub source_text: String,
    pub state: AssetState,
    pub verified: bool,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContentPage {
    pub complete: bool,
    pub next_offset: Option<i64>,
    pub offset: i64,
    pub total_chars: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryRetrieval {
    #[serde(rename = "directory_fallback")]
    DirectoryFallback,
    #[serde(rename = "mem0_authoritative")]
    Mem0Authoritative,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunSnapshot {
    pub lease_epoch: String,
    pub run_id: String,
    pub state: RunSnapshotState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunSnapshotState {
    Cancelled,
    Failed,
    Finished,
    Interrupted,
    Running,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_after: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i32>,
    pub query: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SemanticAccess {
    pub can_admin: bool,
    /// 可创建独立指标、文档等；由当前空间已同步的 Datasight 表维护关系或超级维护者角色确定。
    pub can_create: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SemanticCorrection {
    /// Datasight 维护人；未提供或 null 表示暂无负责人，不继承录入者。
    pub applied_by: Option<String>,
    pub applied_value: Option<String>,
    pub applied_version: Option<String>,
    pub base_version: String,
    pub can_review: bool,
    pub can_revise: bool,
    pub entry_id: String,
    pub evidence: Vec<EvidenceRef>,
    pub id: String,
    pub object_id: String,
    pub original_value: String,
    pub reason: String,
    pub review_reason: Option<String>,
    /// Datasight 维护人；未提供或 null 表示暂无负责人，不继承录入者。
    pub reviewer_id: Option<String>,
    pub revision: String,
    pub state: SemanticCorrectionState,
    pub submitter_id: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SemanticCorrectionState {
    Accepted,
    Applied,
    Rejected,
    Submitted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SemanticCorrectionList {
    pub corrections: Vec<SemanticCorrection>,
    pub next_after_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SemanticMemberList {
    pub user_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendModelCall {
    pub call_attempt_id: String,
    pub lease_epoch: String,
    pub parameters_fingerprint: String,
    pub run_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionReceipt {
    pub model_label: ModelLabel,
    pub state: SessionReceiptState,
    pub user_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionReceiptState {
    Authenticated,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillSelection {
    pub asset_id: String,
    pub operation_id: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub conversation_id: String,
    pub events: Vec<Event>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_event_seq: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_newer: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_older: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_event_seq: Option<String>,
    pub messages: Vec<ChatMessage>,
    pub runs: Vec<RunSnapshot>,
    pub tasks: Vec<TaskSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskSnapshot {
    pub condition_version: String,
    pub goal: String,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lifecycle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceDocument {
    pub body: String,
    pub complete: bool,
    pub current_version: String,
    pub source_id: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SqlInput {
    pub parameters: HashMap<String, Option<serde_json::Value>>,
    pub sql: String,
    pub target_id: TargetId,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubmitSemanticCorrection {
    pub base_version: String,
    pub entry_id: String,
    pub evidence: Vec<EvidenceRef>,
    pub object_id: String,
    pub operation_id: String,
    pub reason: String,
    pub share_confirmed: bool,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskInput {
    pub action: TaskInputAction,
    pub goal: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskInputAction {
    #[serde(rename = "create_task")]
    CreateTask,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolInvocation {
    pub arguments: TaskInput,
    pub checkpoint: Checkpoint,
    pub lease_epoch: String,
    pub run_id: String,
    pub sdk_tool_call_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolOutcome {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receipt: Option<ToolReceipt>,
    #[serde(rename = "type")]
    pub tool_outcome_type: ToolOutcomeType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<AppError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolReceipt {
    pub condition_version: String,
    pub operation_id: String,
    pub state: ToolReceiptState,
    pub task_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolReceiptState {
    Active,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolOutcomeType {
    Failed,
    Succeeded,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionCommand {
    pub expected_version: String,
    pub operation_id: String,
}

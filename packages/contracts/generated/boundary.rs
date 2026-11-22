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

pub type AuthoritySnapshot = HashMap<String, Option<serde_json::Value>>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Boundary {
    pub adopted_semantic_resolution: AdoptedSemanticResolutionClass,
    #[serde(rename = "AgentQueryResults")]
    pub agent_query_results: Option<AgentQueryResultsClass>,
    #[serde(rename = "AnalysisAnswerSource")]
    pub analysis_answer_source: Option<AnalysisAnswerSourceElement>,
    #[serde(rename = "AnalysisAnswerValue")]
    pub analysis_answer_value: Option<AnalysisAnswerValueElement>,
    #[serde(rename = "AnalysisEvidence")]
    pub analysis_evidence: Option<AnalysisEvidenceElement>,
    #[serde(rename = "AnalysisEvidenceRef")]
    pub analysis_evidence_ref: Option<AnalysisEvidenceRefElement>,
    #[serde(rename = "AnalysisEvidenceSources")]
    pub analysis_evidence_sources: Option<AnalysisEvidenceSourcesClass>,
    #[serde(rename = "AnalysisFigure")]
    pub analysis_figure: Option<AnalysisFigureElement>,
    #[serde(rename = "AnalysisFinding")]
    pub analysis_finding: Option<AnalysisFindingElement>,
    #[serde(rename = "AnalysisPreferenceCommand")]
    pub analysis_preference_command: Option<AnalysisPreferenceCommandClass>,
    #[serde(rename = "AnalysisQueryCoverage")]
    pub analysis_query_coverage: Option<AnalysisQueryCoverageElement>,
    #[serde(rename = "AnalysisQueryReference")]
    pub analysis_query_reference: Option<AnalysisQueryReferenceElement>,
    #[serde(rename = "AnalysisReport")]
    pub analysis_report: Option<AnalysisReportClass>,
    #[serde(rename = "AnalysisReportChart")]
    pub analysis_report_chart: Option<AnalysisReportChartElement>,
    #[serde(rename = "AnalysisReportPage")]
    pub analysis_report_page: Option<AnalysisReportPageClass>,
    #[serde(rename = "AnalysisReportRef")]
    pub analysis_report_ref: Option<AnalysisReportRefClass>,
    #[serde(rename = "AnalysisReportView")]
    pub analysis_report_view: Option<AnalysisReportViewClass>,
    #[serde(rename = "AnalysisResultDependency")]
    pub analysis_result_dependency: Option<AnalysisResultDependencyElement>,
    pub analysis_update: AnalysisUpdateClass,
    pub append_output: AppendOutputClass,
    pub app_error: AppErrorClass,
    #[serde(rename = "ApplySemanticCorrection")]
    pub apply_semantic_correction: Option<ApplySemanticCorrectionClass>,
    pub asset: AssetElement,
    pub asset_list: AssetListClass,
    #[serde(rename = "AssetPageQuery")]
    pub asset_page_query: Option<AssetPageQueryClass>,
    pub asset_read_ref: Option<AssetReadRefClass>,
    pub asset_save: AssetSaveClass,
    pub asset_tool_input: AssetToolInputClass,
    #[serde(rename = "AssignSemanticMaintainer")]
    pub assign_semantic_maintainer: Option<AssignSemanticMaintainerClass>,
    pub cancel_receipt: CancelReceiptClass,
    pub cancel_run: CancelRunClass,
    #[serde(rename = "CatalogColumn")]
    pub catalog_column: Option<CatalogColumnElement>,
    #[serde(rename = "CatalogNode")]
    pub catalog_node: Option<CatalogNodeClass>,
    #[serde(rename = "CatalogPage")]
    pub catalog_page: Option<CatalogPageClass>,
    #[serde(rename = "CatalogTable")]
    pub catalog_table: Option<CatalogTableElement>,
    pub chat_message: ChatMessageElement,
    pub checkpoint: CheckpointClass,
    #[serde(rename = "checkpoint_reference")]
    pub checkpoint_reference: CheckpointReferenceClass,
    pub conditions: AnalysisEvidenceConditions,
    pub configured_model: ConfiguredModelClass,
    pub confirm_query: ConfirmQueryClass,
    pub content_page: Option<ContentPageClass>,
    pub conversation_model_selection: ConversationModelSelectionClass,
    pub conversation_read_input: ConversationReadInputClass,
    pub conversation_receipt: ConversationReceiptClass,
    #[serde(rename = "ConversationSkillSelection")]
    pub conversation_skill_selection: Option<ConversationSkillSelectionElement>,
    #[serde(rename = "ConversationSkillSelections")]
    pub conversation_skill_selections: Option<ConversationSkillSelectionsClass>,
    pub create_conversation: CreateConversationClass,
    pub current_analysis_update: CurrentAnalysisUpdateClass,
    pub current_request_query_input: CurrentRequestQueryInputClass,
    pub data_tool_invocation: DataToolInvocationClass,
    pub data_tool_outcome: DataToolOutcomeClass,
    pub delivered_support: Option<DeliveredSupportElement>,
    #[serde(rename = "EmbeddedSupportLocation")]
    pub embedded_support_location: Option<EmbeddedSupportLocationClass>,
    pub embedding_profile: EmbeddingProfileClass,
    pub event: EventElement,
    pub evidence_continuation: EvidenceContinuationClass,
    pub evidence_read_result: Option<EvidenceReadResultElement>,
    pub evidence_ref: EvidenceRefElement,
    pub evidence_task_ref: Option<EvidenceTaskRefElement>,
    pub execute_query_input: ExecuteQueryInputClass,
    pub finalize_model_call: FinalizeModelCallClass,
    pub finish_receipt: FinishReceiptClass,
    pub finish_run: FinishRunClass,
    #[serde(rename = "GetQueryInput")]
    pub get_query_input: Option<GetQueryInputClass>,
    pub history: HistoryClass,
    pub history_item: HistoryItemElement,
    pub history_query: HistoryQueryClass,
    #[serde(rename = "host_checkpoint_reference")]
    pub host_checkpoint_reference: HostCheckpointReferenceClass,
    pub human_statement_input: Option<HumanStatementInputElement>,
    pub identity: IdentityClass,
    pub knowledge_batch_edit: Option<KnowledgeBatchEditClass>,
    pub knowledge_batch_receipt: Option<KnowledgeBatchReceiptClass>,
    pub knowledge_create: KnowledgeCreateClass,
    pub knowledge_document: Option<KnowledgeDocumentClass>,
    pub knowledge_document_edit: Option<KnowledgeDocumentEditClass>,
    pub knowledge_edit: KnowledgeEditClass,
    pub knowledge_edit_group: Option<KnowledgeEditGroupElement>,
    pub knowledge_entry: KnowledgeEntryElement,
    pub knowledge_lineage: Option<KnowledgeLineageClass>,
    pub knowledge_list: KnowledgeListClass,
    pub knowledge_list_query: KnowledgeListQueryClass,
    pub knowledge_object: KnowledgeObjectElement,
    pub knowledge_read_input: Option<KnowledgeReadInputClass>,
    pub knowledge_read_item: Option<KnowledgeReadItemElement>,
    pub knowledge_read_reply: Option<KnowledgeReadReplyClass>,
    pub knowledge_read_result: Option<KnowledgeReadResultClass>,
    #[serde(rename = "KnowledgeRetrieval")]
    pub knowledge_retrieval: Option<KnowledgeRetrievalClass>,
    #[serde(rename = "KnowledgeRetrievalExcerpt")]
    pub knowledge_retrieval_excerpt: Option<KnowledgeRetrievalExcerptElement>,
    pub knowledge_search_coverage: KnowledgeSearchCoverageClass,
    pub knowledge_search_hit: KnowledgeSearchHitElement,
    pub knowledge_search_input: KnowledgeSearchInputClass,
    pub knowledge_search_reply: KnowledgeSearchReplyClass,
    pub legacy_pending: LegacyPendingClass,
    pub legacy_pending_item: LegacyPendingItemElement,
    pub legacy_resolution_link: LegacyResolutionLinkElement,
    pub legacy_resolution_migration: LegacyResolutionMigrationClass,
    pub loaded_output_range: LoadedOutputRangeElement,
    pub logout_receipt: LogoutReceiptClass,
    #[serde(rename = "MaintenanceDependent")]
    pub maintenance_dependent: Option<MaintenanceDependentElement>,
    #[serde(rename = "MaintenanceImpact")]
    pub maintenance_impact: Option<MaintenanceImpactClass>,
    #[serde(rename = "MaintenanceImpactQuery")]
    pub maintenance_impact_query: Option<MaintenanceImpactQueryClass>,
    #[serde(rename = "MaintenanceReference")]
    pub maintenance_reference: Option<MaintenanceReferenceElement>,
    pub memory_budget_binding: Option<MemoryBudgetBindingClass>,
    pub memory_candidate: Option<MemoryCandidateElement>,
    pub memory_extraction_receipt: Option<MemoryExtractionReceiptClass>,
    pub memory_extraction_request: Option<MemoryExtractionRequestClass>,
    pub memory_index_receipt: Option<MemoryIndexReceiptClass>,
    pub memory_index_request: Option<MemoryIndexRequestClass>,
    pub memory_model_call: Option<MemoryModelCallClass>,
    pub memory_read_result: Option<MemoryReadResultClass>,
    pub memory_search_receipt: Option<MemorySearchReceiptClass>,
    pub memory_search_request: Option<MemorySearchRequestClass>,
    pub message_input: MessageInputClass,
    pub message_receipt: MessageReceiptClass,
    pub model_attempt: ModelAttemptClass,
    pub model_call_receipt: ModelCallReceiptClass,
    pub model_catalog: ModelCatalogClass,
    pub model_configuration: ModelConfigurationClass,
    pub model_configuration_access: ModelConfigurationAccessClass,
    pub model_connection: ModelConnectionClass,
    pub model_definition: ModelDefinitionElement,
    pub model_option: ModelOptionElement,
    pub model_profile: ModelProfileClass,
    pub model_receipt: ModelReceiptClass,
    pub model_selection: ModelSelectionClass,
    pub model_service: ModelServiceElement,
    pub model_usage: ModelUsageClass,
    pub mutation_receipt: MutationReceiptClass,
    pub numeric_value_counts: Option<NumericValueCountsClass>,
    pub operation_receipt: OperationReceiptClass,
    pub output_projection: OutputProjectionElement,
    pub output_receipt: OutputReceiptClass,
    #[serde(rename = "pi_session_reference")]
    pub pi_session_reference: PiSessionReferenceClass,
    pub prefill_result: PrefillResultClass,
    #[serde(rename = "PreparedRelation")]
    pub prepared_relation: Option<PreparedRelationElement>,
    #[serde(rename = "PreparedStatement")]
    pub prepared_statement: Option<PreparedStatementElement>,
    #[serde(rename = "PreparedSupport")]
    pub prepared_support: Option<PreparedSupportElement>,
    #[serde(rename = "PrepareSkillDraftInput")]
    pub prepare_skill_draft_input: Option<PrepareSkillDraftInputClass>,
    #[serde(rename = "PresentAnalysisAnswerInput")]
    pub present_analysis_answer_input: Option<PresentAnalysisAnswerInputClass>,
    pub proposal: ProposalElement,
    #[serde(rename = "ProposalDraftCommand")]
    pub proposal_draft_command: Option<ProposalDraftCommandClass>,
    pub proposal_input: ProposalInputClass,
    pub proposal_list: ProposalListClass,
    #[serde(rename = "PublishSkill")]
    pub publish_skill: Option<PublishSkillClass>,
    pub query_cancellation: Option<QueryCancellationClass>,
    #[serde(rename = "QueryExampleParameter")]
    pub query_example_parameter: Option<QueryExampleParameterElement>,
    #[serde(rename = "QueryExampleVerification")]
    pub query_example_verification: Option<QueryExampleVerificationClass>,
    pub query_list: QueryListClass,
    #[serde(rename = "QueryResultCellRead")]
    pub query_result_cell_read: Option<QueryResultCellReadClass>,
    #[serde(rename = "QueryResultContent")]
    pub query_result_content: Option<QueryResultContentClass>,
    pub query_results: QueryResultsElement,
    #[serde(rename = "QueryResultStatisticsRead")]
    pub query_result_statistics_read: Option<QueryResultStatisticsReadClass>,
    pub query_view: QueryViewElement,
    #[serde(rename = "read_checkpoint")]
    pub read_checkpoint: ReadCheckpointClass,
    #[serde(rename = "ReadAnalysisReportInput")]
    pub read_analysis_report_input: Option<ReadAnalysisReportInputClass>,
    pub read_knowledge_input: ReadKnowledgeInputClass,
    pub read_model_connection: ReadModelConnectionClass,
    pub read_query_input: ReadQueryInputClass,
    pub read_source_input: ReadSourceInputClass,
    pub read_task_input: Option<ReadTaskInputClass>,
    pub refresh_run_context: RefreshRunContextClass,
    pub request_query_input: RequestQueryInputClass,
    pub reserve_model_call: ReserveModelCallClass,
    pub result_column: ResultColumnElement,
    pub result_column_statistics: Option<ResultColumnStatisticsElement>,
    pub result_statistics: Option<ResultStatisticsClass>,
    #[serde(rename = "ReviewSemanticCorrection")]
    pub review_semantic_correction: Option<ReviewSemanticCorrectionClass>,
    #[serde(rename = "ReviewSkillSuggestion")]
    pub review_skill_suggestion: Option<ReviewSkillSuggestionClass>,
    #[serde(rename = "ReviseSemanticCorrection")]
    pub revise_semantic_correction: Option<ReviseSemanticCorrectionClass>,
    pub run_envelope: RunEnvelopeClass,
    pub run_snapshot: RunSnapshotElement,
    #[serde(rename = "SaveAnalysisEvidenceInput")]
    pub save_analysis_evidence_input: Option<SaveAnalysisEvidenceInputClass>,
    #[serde(rename = "SaveAnalysisReport")]
    pub save_analysis_report: Option<SaveAnalysisReportClass>,
    #[serde(rename = "SaveAnalysisReportInput")]
    pub save_analysis_report_input: Option<SaveAnalysisReportInputClass>,
    pub save_default_model: SaveDefaultModelClass,
    pub save_model_definition: SaveModelDefinitionClass,
    pub save_model_selection: SaveModelSelectionClass,
    pub save_model_service: SaveModelServiceClass,
    pub search_input: SearchInputClass,
    #[serde(rename = "SemanticAccess")]
    pub semantic_access: Option<SemanticAccessClass>,
    #[serde(rename = "SemanticCheckReport")]
    pub semantic_check_report: Option<SemanticCheckReportClass>,
    #[serde(rename = "SemanticColumnRef")]
    pub semantic_column_ref: Option<SemanticColumnRefClass>,
    #[serde(rename = "SemanticCorrection")]
    pub semantic_correction: Option<SemanticCorrectionElement>,
    #[serde(rename = "SemanticCorrectionList")]
    pub semantic_correction_list: Option<SemanticCorrectionListClass>,
    #[serde(rename = "SemanticEvidenceRef")]
    pub semantic_evidence_ref: Option<SemanticEvidenceRefElement>,
    #[serde(rename = "SemanticMaintenance")]
    pub semantic_maintenance: Option<SemanticMaintenanceClass>,
    #[serde(rename = "SemanticMemberList")]
    pub semantic_member_list: Option<SemanticMemberListClass>,
    #[serde(rename = "SemanticReference")]
    pub semantic_reference: Option<SemanticReferenceClass>,
    #[serde(rename = "SemanticRelation")]
    pub semantic_relation: Option<SemanticRelationElement>,
    #[serde(rename = "SemanticStatement")]
    pub semantic_statement: Option<SemanticStatementElement>,
    #[serde(rename = "SemanticStructure")]
    pub semantic_structure: Option<SemanticStructureClass>,
    #[serde(rename = "SemanticSupport")]
    pub semantic_support: Option<SemanticSupportElement>,
    #[serde(rename = "SemanticTableRef")]
    pub semantic_table_ref: Option<SemanticTableRefClass>,
    pub send_model_call: SendModelCallClass,
    pub session_receipt: SessionReceiptClass,
    #[serde(rename = "SkillDraft")]
    pub skill_draft: Option<SkillDraftElement>,
    #[serde(rename = "SkillDraftList")]
    pub skill_draft_list: Option<SkillDraftListClass>,
    #[serde(rename = "SkillDraftRef")]
    pub skill_draft_ref: Option<SkillDraftRefClass>,
    #[serde(rename = "SkillFile")]
    pub skill_file: Option<SkillFileElement>,
    #[serde(rename = "SkillReadInput")]
    pub skill_read_input: Option<SkillReadInputClass>,
    pub skill_read_result: Option<SkillReadResultClass>,
    #[serde(rename = "SkillRemovalReceipt")]
    pub skill_removal_receipt: Option<SkillRemovalReceiptClass>,
    pub skill_selection: SkillSelectionClass,
    #[serde(rename = "SkillSelectionRemoval")]
    pub skill_selection_removal: Option<SkillSelectionRemovalClass>,
    #[serde(rename = "SkillSuggestion")]
    pub skill_suggestion: Option<SkillSuggestionElement>,
    #[serde(rename = "SkillSuggestionList")]
    pub skill_suggestion_list: Option<SkillSuggestionListClass>,
    pub snapshot: SnapshotClass,
    pub snapshot_refresh: SnapshotRefreshClass,
    pub snapshot_request: SnapshotRequestClass,
    pub source_citation: SourceCitationElement,
    pub source_document: SourceDocumentClass,
    #[serde(rename = "SourceExcerpt")]
    pub source_excerpt: Option<SourceExcerptClass>,
    pub source_key: SourceKeyElement,
    pub source_locator: SourceLocatorClass,
    #[serde(rename = "SourcePreparationResult")]
    pub source_preparation_result: Option<SourcePreparationResultClass>,
    pub source_read_input: Option<SourceReadInputClass>,
    pub source_read_reply: Option<SourceReadReplyClass>,
    #[serde(rename = "SourceSyncAccepted")]
    pub source_sync_accepted: Option<SourceSyncAcceptedClass>,
    #[serde(rename = "SourceSyncProgress")]
    pub source_sync_progress: Option<SourceSyncProgressClass>,
    #[serde(rename = "SourceWorkProgress")]
    pub source_work_progress: Option<SourceWorkProgressClass>,
    pub sql_input: SqlInputClass,
    #[serde(rename = "SubmitSemanticCorrection")]
    pub submit_semantic_correction: Option<SubmitSemanticCorrectionClass>,
    #[serde(rename = "SuggestSkill")]
    pub suggest_skill: Option<SuggestSkillClass>,
    #[serde(rename = "TableAnalysisPreference")]
    pub table_analysis_preference: Option<TableAnalysisPreferenceClass>,
    pub task_input: TaskInputClass,
    pub task_snapshot: TaskSnapshotElement,
    pub thinking_option: ThinkingOptionElement,
    pub tool_invocation: ToolInvocationClass,
    pub tool_outcome: ToolOutcomeClass,
    pub tool_receipt: ToolReceiptClass,
    pub version_command: VersionCommandClass,
    pub workbench_update: Option<WorkbenchUpdateClass>,
    pub workspace_context: WorkspaceContextClass,
    #[serde(rename = "WorkspaceTask")]
    pub workspace_task: Option<WorkspaceTaskElement>,
}

///
/// 新格式仅记录已经采用的解释。explicit_user引用本轮完整原话，null/省略采纳身份由宿主绑定；原已核对象可同文继承。未决只登记clarifications，无问题且条件充分时不要求本对象。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdoptedSemanticResolutionClass {
    pub adoption_message_id: Option<String>,
    pub basis: SemanticResolutionBasisEnum,
    pub evidence_refs: Option<Vec<EvidenceRefElement>>,
    pub interpretation: String,
    pub user_quote: Option<String>,
}

/// 真实用户明确选择、确无实质歧义、或仍需澄清；资料支持某公式不等于用户选择它。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SemanticResolutionBasisEnum {
    #[serde(rename = "explicit_user")]
    ExplicitUser,
    Unambiguous,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvidenceRefElement {
    /// read_knowledge或search_knowledge返回的知识对象id；不是read_source返回的source_id。
    pub object_id: String,
    /// 该知识对象entries中的path，必须确实存在于对应version。
    pub path: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentQueryResultsClass {
    pub columns: Option<Vec<ResultColumnElement>>,
    pub data_freshness: Option<String>,
    pub fetched_offset: Option<String>,
    pub next_cursor: Option<String>,
    pub query_id: String,
    pub result_complete: Option<bool>,
    pub result_ref: String,
    pub rows: Option<Vec<Vec<Option<String>>>>,
    pub saved_result_complete: Option<bool>,
    pub saved_row_count: Option<i64>,
    pub source: Option<String>,
    /// 应用对当前有权结果页计算的统计；历史客户端可省略。
    pub statistics: Option<ResultStatisticsClass>,
    pub truncated: Option<bool>,
    pub view: Option<AgentQueryResultsView>,
    pub column: Option<ResultColumnElement>,
    pub column_index: Option<i64>,
    pub row_index: Option<i64>,
    pub value: Option<String>,
    pub content_format: Option<ContentFormat>,
    pub content_page: Option<PurpleQueryResultContentRange>,
    pub content_text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResultColumnElement {
    /// 查询投影能唯一绑定已确认的字段或指标表达式时提供的列头说明。
    pub display_label: Option<String>,
    pub encoding: String,
    pub name: String,
    #[serde(rename = "type")]
    pub result_column_type: String,
    /// 从查询所选的已确认结构取得的业务单位，可独立于列头说明展示。
    pub unit: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContentFormat {
    Json,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PurpleQueryResultContentRange {
    pub complete: bool,
    pub next_offset: Option<i64>,
    pub offset: i64,
    pub total_chars: i64,
}

/// 应用对当前有权结果页计算的统计；历史客户端可省略。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResultStatisticsClass {
    pub columns: Vec<ResultColumnStatisticsElement>,
    pub distinct_comparison: DistinctComparison,
    pub row_count: i64,
    /// 只有从offset=0取得完整且未截断的结果才是complete_result；page不能外推为全部结果。
    pub scope: ResultStatisticsScope,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResultColumnStatisticsElement {
    pub column_index: i64,
    pub column_name: String,
    /// 不含NULL，按平台返回的原始文本去重；不模拟数据库排序规则。
    pub distinct_count: i64,
    /// 当前统计范围的最大非空值，保留原始表示。
    pub max: Option<String>,
    /// 当前统计范围的最小非空值，保留原始表示。
    pub min: Option<String>,
    pub non_null_count: i64,
    pub null_count: i64,
    pub numeric_counts: Option<NumericValueCountsClass>,
    /// 本统计范围中出现超过一次的非NULL原始文本及次数；与distinct_count使用相同比较规则，不能推断跨页重复。
    pub repeated_values: Vec<RepeatedValueElement>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NumericValueCountsClass {
    pub negative: i64,
    pub positive: i64,
    pub zero: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepeatedValueElement {
    pub count: i64,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DistinctComparison {
    #[serde(rename = "returned_text")]
    ReturnedText,
}

/// 只有从offset=0取得完整且未截断的结果才是complete_result；page不能外推为全部结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResultStatisticsScope {
    #[serde(rename = "complete_result")]
    CompleteResult,
    Page,
}

/// rows默认；statistics独立统计；cell按绝对行列读值。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentQueryResultsView {
    Cell,
    Rows,
    Statistics,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisAnswerSourceElement {
    pub columns: Vec<String>,
    pub query_id: String,
    pub result_ref: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisAnswerValueElement {
    pub column: Option<String>,
    /// observation_cutoff/data_batch在同名角色多条时按field_ref对齐声明；缺省要求该角色唯一。
    pub field_ref: Option<String>,
    ///
    /// 展示格式：缺省或raw为原值；decimal为固定小数位；percent只对单个ratio乘100加百分号。decimal/percent必须给precision，raw不接受precision。展示字符串不写回查询结果。
    pub format: Option<PurpleFormat>,
    /// observation_cutoff/data_batch绑定草稿时间基准中用户声明的角色值；未声明时不可绑定。
    pub kind: AnalysisAnswerValueKind,
    pub metadata: Option<Metadata>,
    pub name: String,
    pub parameter: Option<String>,
    pub query_id: String,
    pub row_index: Option<i32>,
    pub statistic: Option<Statistic>,
}

///
/// 展示格式：缺省或raw为原值；decimal为固定小数位；percent只对单个ratio乘100加百分号。decimal/percent必须给precision，raw不接受precision。展示字符串不写回查询结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PurpleFormat {
    pub precision: Option<i32>,
    pub style: Style,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Style {
    Decimal,
    Percent,
    Raw,
}

/// observation_cutoff/data_batch绑定草稿时间基准中用户声明的角色值；未声明时不可绑定。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnalysisAnswerValueKind {
    Cell,
    #[serde(rename = "data_batch")]
    DataBatch,
    Metadata,
    #[serde(rename = "observation_cutoff")]
    ObservationCutoff,
    Parameter,
    Statistic,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Metadata {
    #[serde(rename = "data_freshness")]
    DataFreshness,
    #[serde(rename = "saved_row_count")]
    SavedRowCount,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Statistic {
    #[serde(rename = "distinct_count")]
    DistinctCount,
    Negative,
    #[serde(rename = "non_null_count")]
    NonNullCount,
    #[serde(rename = "null_count")]
    NullCount,
    Positive,
    #[serde(rename = "row_count")]
    RowCount,
    Zero,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisEvidenceElement {
    pub conditions: AnalysisEvidenceConditions,
    pub data_range: String,
    pub findings: Vec<AnalysisFindingElement>,
    pub reference: AnalysisEvidenceRefElement,
    pub schema_version: i64,
    pub source_message_id: String,
    pub validated_sources: AnalysisEvidenceSourcesClass,
}

/// 新建任务必须完整给出；未指定的可空标量用JSON null，列表用[]，notes用空字符串，timezone按宿主业务时区。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisEvidenceConditions {
    pub channel: Option<ConditionsChannel>,
    pub filters: Vec<String>,
    pub group_by: Vec<String>,
    pub knowledge_refs: Vec<EvidenceRefElement>,
    pub metric: Option<String>,
    pub notes: String,
    /// 当前格式仅记录已采用解释及依据，未决由clarifications表达；省略继承，null只清说明，未要求所有任务填写。旧形状按宿主持久格式标记兼容，读取不迁移。
    pub semantic_resolution: Option<QueryViewQuerySemanticResolution>,
    /// null表示本题显式未声明额外来源限制；字段缺失表示旧条件版本未记录新式限制，不能证明用户从未限制。撤销必须显式unset并来自真实用户修改。
    #[serde(
        default,
        deserialize_with = "deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub source_limits: Option<Option<SourceLimitsClass>>,
    /// 时间区间的不包含终点。按明确的业务时区解析后转为UTC完整时间戳，以Z结尾；整月结束为下一月起点，不能写本月最后一天。未指定时为null。
    pub time_end: Option<String>,
    /// 时间口径角色；统计起止仍沿time_start/time_end，request_clock和平台data_freshness不冒充用户截点。字段缺失表示旧版本未记录。
    pub time_roles: Option<Vec<TimeRoleElement>>,
    /// 时间区间的包含起点。按明确的业务时区解析后转为UTC完整时间戳，以Z结尾；不能只写日期。未指定时为null。
    pub time_start: Option<String>,
    pub timezone: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConditionsChannel {
    App,
    Store,
    Web,
}

///
/// 新格式仅记录已经采用的解释。explicit_user引用本轮完整原话，null/省略采纳身份由宿主绑定；原已核对象可同文继承。未决只登记clarifications，无问题且条件充分时不要求本对象。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryViewQuerySemanticResolution {
    ///
    /// explicit_user：null=本轮新采纳，由宿主核对user_quote为本轮完整原话后绑定真实消息身份；非空=复制继承原已验证决策的消息身份，不接受模型自由填写。其余basis为null。
    pub adoption_message_id: Option<String>,
    /// 真实用户明确选择、确无实质歧义、或仍需澄清；资料支持某公式不等于用户选择它。
    pub basis: SemanticResolutionBasis,
    /// 支撑该口径决策的依据引用；旧调用缺失按空数组解码。
    pub evidence_refs: Option<Vec<EvidenceRefElement>>,
    /// 本稿采用的指标、分子/分母、时间等关键口径及选择依据；不能把自己刚写入任务的假设当作用户采用。
    pub interpretation: String,
    /// 仍会改变答案且未获选择的分子、分母、时间归属等差异；有差异必须先澄清，不能默认写稿。
    pub unresolved_differences: Option<Vec<String>>,
    /// explicit_user逐字填写本条真实用户完整原话，保留否定、前提、例外和换行，不截取子串；其余为null。
    pub user_quote: Option<String>,
}

/// 真实用户明确选择、确无实质歧义、或仍需澄清；资料支持某公式不等于用户选择它。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SemanticResolutionBasis {
    #[serde(rename = "explicit_user")]
    ExplicitUser,
    #[serde(rename = "needs_clarification")]
    NeedsClarification,
    Unambiguous,
}

/// 设置来源限制；撤销使用unset source_limits，不接受设为空集。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceLimitsClass {
    /// 非空允许集；限制跟稳定来源身份走，实际读取仍核对当前修订。
    pub allowed_sources: Vec<SourceKeyElement>,
    /// 由宿主绑定的真实消息身份；不接受模型自由填写。
    pub origin_message_ids: Vec<String>,
}

///
/// 来源的稳定身份。kind和id须成对原样使用source_identity回执的source_keys或已有citation.source；不按资料名称、object_id前缀或正文是文档来猜kind，不将document改成platform。不包含修订号，也不使用索引chunk
/// ID。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceKeyElement {
    pub id: String,
    pub kind: SourceKeyKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKeyKind {
    Document,
    Platform,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimeRoleElement {
    /// 业务含义说明。
    pub description: String,
    /// 支撑该时间口径的依据；可空数组。
    pub evidence_refs: Vec<EvidenceRefElement>,
    /// 采用的时间字段引用；可空。
    pub field_ref: Option<String>,
    /// 采用的时间字段含义、观察截点或数据批次；三者不混用。
    pub role: TimeRoleRole,
    /// observation_cutoff必须为带时区的时间值，data_batch必须为批次值；event_time可空（实际区间沿time_start/time_end）。
    pub value: Option<String>,
}

/// 采用的时间字段含义、观察截点或数据批次；三者不混用。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimeRoleRole {
    #[serde(rename = "data_batch")]
    DataBatch,
    #[serde(rename = "event_time")]
    EventTime,
    #[serde(rename = "observation_cutoff")]
    ObservationCutoff,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisFindingElement {
    pub calculation: String,
    pub figures: Vec<AnalysisFigureElement>,
    pub knowledge_refs: Vec<EvidenceRefElement>,
    pub limitations: Vec<String>,
    pub query_refs: Vec<AnalysisQueryReferenceElement>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisFigureElement {
    pub column: String,
    pub label: String,
    pub query_id: String,
    pub row_index: i32,
    pub value: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Value {
    Bool(bool),
    Double(f64),
    PurpleString(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisQueryReferenceElement {
    pub columns: Vec<String>,
    pub query_id: String,
    pub result_ref: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisEvidenceRefElement {
    pub condition_version: String,
    pub conversation_id: String,
    pub evidence_id: String,
    pub result_dependencies: Vec<AnalysisResultDependencyElement>,
    pub task_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisResultDependencyElement {
    pub query_id: String,
    pub result_ref: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisEvidenceSourcesClass {
    pub knowledge_refs: Vec<EvidenceRefElement>,
    pub query_coverage: Vec<AnalysisQueryCoverageElement>,
    pub result_dependencies: Vec<AnalysisResultDependencyElement>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisQueryCoverageElement {
    pub query_id: String,
    pub received_rows: i32,
    pub result_complete: bool,
    pub result_ref: String,
    pub saved_result_complete: bool,
    pub saved_row_count: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisPreferenceCommandClass {
    pub expected_version: String,
    pub operation_id: String,
    pub preferred: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisReportClass {
    pub charts: Vec<AnalysisReportChartElement>,
    pub created_at: String,
    pub evidence: Vec<AnalysisEvidenceElement>,
    pub reference: AnalysisReportRefClass,
    pub schema_version: i64,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisReportChartElement {
    pub dimension_column: String,
    pub kind: AnalysisReportChartKind,
    pub measure_column: String,
    pub query_id: String,
    pub result_ref: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnalysisReportChartKind {
    Bar,
    Line,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisReportRefClass {
    pub condition_version: String,
    pub conversation_id: String,
    pub report_id: String,
    pub task_id: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisReportPageClass {
    pub charts: Option<Vec<AnalysisReportChartElement>>,
    pub content_page: Option<ContentPageClass>,
    pub content_text: Option<String>,
    pub evidence_ids: Option<Vec<String>>,
    pub reference: Option<AnalysisReportRefClass>,
    pub status: AnalysisReportPageStatus,
    pub title: Option<String>,
    pub historical_analysis: Option<PurpleHistoricalAnalysis>,
}

/// 支持正文自己的Unicode字符页；游标仍沿supports_next_cursor继续。同一支持的尾页不代表本回执已包含整条支持。
///
/// 来源原话的独立字符分页。缺省source_text为空但保留总长和补读位置；以entry_id=source_text和同一资产版本读取。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContentPageClass {
    pub complete: bool,
    pub next_offset: Option<i64>,
    pub offset: i64,
    pub total_chars: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PurpleHistoricalAnalysis {
    pub actual_sources: HashMap<String, Option<serde_json::Value>>,
    pub conditions: Vec<HashMap<String, Option<serde_json::Value>>>,
    pub content_fingerprint: String,
    pub evidence: Vec<HashMap<String, Option<serde_json::Value>>>,
    pub generated_at: String,
    pub kind: HistoricalAnalysisKind,
    pub reference: Option<AnalysisReportRefClass>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HistoricalAnalysisKind {
    Report,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnalysisReportPageStatus {
    Available,
    #[serde(rename = "condition_changed")]
    ConditionChanged,
    Historical,
    #[serde(rename = "sources_unavailable")]
    SourcesUnavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisReportViewClass {
    pub chart_results: Option<Vec<QueryResultsElement>>,
    pub reference: Option<AnalysisReportRefClass>,
    pub report: Option<AnalysisReportClass>,
    pub status: AnalysisReportViewStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResultsElement {
    pub columns: Vec<ResultColumnElement>,
    pub data_freshness: String,
    pub fetched_offset: String,
    pub next_cursor: Option<String>,
    pub query_id: String,
    pub result_complete: bool,
    pub result_ref: String,
    pub rows: Vec<Vec<Option<String>>>,
    pub saved_result_complete: Option<bool>,
    pub saved_row_count: Option<i32>,
    pub source: String,
    /// 应用对当前有权结果页计算的统计；历史客户端可省略。
    pub statistics: Option<ResultStatisticsClass>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnalysisReportViewStatus {
    Available,
    #[serde(rename = "condition_changed")]
    ConditionChanged,
    #[serde(rename = "sources_unavailable")]
    SourcesUnavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisUpdateClass {
    pub action: AnalysisUpdateAction,
    /// 同一任务需分别回答的独立问题，各生成独立ID；与非空question互斥，不同目标分别建任务。
    pub clarifications: Option<Vec<ClarificationElement>>,
    ///
    /// 修改已存任务条件时必填，action用revise或clarify；set指定新值，unset可省略（省略即不清空任何字段，null非法）。route禁止携带condition_patch，因为route只登记归属。
    pub condition_patch: Option<AnalysisUpdateConditionPatch>,
    /// 新建任务必须完整给出；未指定的可空标量用JSON null，列表用[]，notes用空字符串，timezone按宿主业务时区。
    pub conditions: Option<AnalysisEvidenceConditions>,
    /// 新建任务省略此字段（也接受JSON null）；已有任务必须提供工具回执中的当前版本数字字符串。
    pub expected_version: Option<String>,
    ///
    /// 仅route可用：显式定稿当前任务已完成的说明或查询答案；可route到同一任务保留其SQL等待状态，也可切到其他目标。该助手消息只允许这个route；宿主绑定完整正文或原成功答案回执。普通route不定稿，不授执行权。
    pub finalize_current_answer: Option<bool>,
    pub goal: Option<String>,
    pub legacy_resolution_migration: Option<LegacyResolutionMigrationClass>,
    /// split迁移到新独立目标的原开放问题ID，保留问题正文与来源，其余原目标问题不动。
    pub moved_clarification_ids: Option<Vec<String>>,
    /// 澄清问题的候选答案；仅与实际question同用，开放回答可无候选（空数组或省略）。
    pub options: Vec<String>,
    /// 需要用户补充的实际问题；无需澄清时省略（也接受JSON null），不能填字符串null、空文本或用户原问题。
    pub question: Option<String>,
    pub replaces_query_id: Option<String>,
    ///
    /// 本消息中用户已真实回答，或当前有效且获准资料已唯一解决的事实问题ID；事实解决须在同次revise保存条件与依据，不能伪称用户选择。省略或[]保留其他问题，仅已有任务revise/clarify可用。
    pub resolved_clarification_ids: Option<Vec<String>>,
    /// 新建任务省略此字段（也接受JSON null）；已有任务用工具回执中的真实ID，不能填字符串null。
    pub task_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnalysisUpdateAction {
    Clarify,
    Create,
    Revise,
    Route,
    Split,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClarificationElement {
    /// 此独立问题的候选答案；允许自由回答。
    pub options: Vec<String>,
    /// 此独立问题的必填正文；无需新增问题时省略整个clarifications列表。
    pub question: String,
}

///
/// 修改已存任务条件时必填，action用revise或clarify；set指定新值，unset可省略（省略即不清空任何字段，null非法）。route禁止携带condition_patch，因为route只登记归属。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisUpdateConditionPatch {
    pub set: PurpleConditionSet,
    /// 清除指定条件字段。省略即空集合（不清空任何字段），null非法；显式数组仍清除列出的字段。
    pub unset: Option<Vec<Unset>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PurpleConditionSet {
    pub channel: Option<ConditionsChannel>,
    pub filters: Option<Vec<String>>,
    pub group_by: Option<Vec<String>>,
    pub knowledge_refs: Option<Vec<EvidenceRefElement>>,
    pub metric: Option<String>,
    pub notes: Option<String>,
    /// 只更新已采用解释及来源；null/unset只清说明，不解决开放问题。旧未决通过明确legacy_resolution_migration转换。
    pub semantic_resolution: Option<QueryViewQuerySemanticResolution>,
    /// 设置来源限制；撤销使用unset source_limits，不接受设为空集。
    #[serde(
        default,
        deserialize_with = "deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub source_limits: Option<Option<SourceLimitsClass>>,
    /// 修改区间的不包含终点，按业务时区解析后填写UTC完整时间戳，以Z结尾；整月结束为下一月起点。清空使用unset；未修改则省略。
    pub time_end: Option<String>,
    /// 整体替换时间口径角色；清空使用unset。
    pub time_roles: Option<Vec<TimeRoleElement>>,
    /// 修改区间的包含起点，按业务时区解析后填写UTC完整时间戳，以Z结尾。清空使用unset；未修改则省略。
    pub time_start: Option<String>,
    pub timezone: Option<String>,
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
    #[serde(rename = "semantic_resolution")]
    SemanticResolution,
    #[serde(rename = "source_limits")]
    SourceLimits,
    #[serde(rename = "time_end")]
    TimeEnd,
    #[serde(rename = "time_roles")]
    TimeRoles,
    #[serde(rename = "time_start")]
    TimeStart,
}

/// 仅revise显式转换旧未决。每项链接实际问题；已resolved项给原条件版本及所指顶层字段，宿主核实际回执/原消息及字段来源。无依据保持或恢复open，未关联旧项登记open。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LegacyResolutionMigrationClass {
    pub from_condition_version: String,
    pub links: Vec<LegacyResolutionLinkElement>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LegacyResolutionLinkElement {
    pub clarification_id: String,
    pub condition_fields: Option<Vec<ConditionField>>,
    pub pending_index: i64,
    pub resolution_condition_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConditionField {
    Channel,
    Filters,
    #[serde(rename = "group_by")]
    GroupBy,
    #[serde(rename = "knowledge_refs")]
    KnowledgeRefs,
    Metric,
    Notes,
    #[serde(rename = "semantic_resolution")]
    SemanticResolution,
    #[serde(rename = "source_limits")]
    SourceLimits,
    #[serde(rename = "time_end")]
    TimeEnd,
    #[serde(rename = "time_roles")]
    TimeRoles,
    #[serde(rename = "time_start")]
    TimeStart,
    Timezone,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppErrorClass {
    pub code: Code,
    pub message: String,
    pub request_id: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Code {
    #[serde(rename = "answer_sources_required")]
    AnswerSourcesRequired,
    #[serde(rename = "budget_exhausted")]
    BudgetExhausted,
    #[serde(rename = "checkpoint_conflict")]
    CheckpointConflict,
    #[serde(rename = "chunk_gap")]
    ChunkGap,
    #[serde(rename = "clarification_not_open")]
    ClarificationNotOpen,
    #[serde(rename = "clarification_required")]
    ClarificationRequired,
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
    #[serde(rename = "invalid_model_endpoint")]
    InvalidModelEndpoint,
    #[serde(rename = "invalid_skill_receipt")]
    InvalidSkillReceipt,
    #[serde(rename = "invalid_skill_resource")]
    InvalidSkillResource,
    #[serde(rename = "invalid_tool_arguments")]
    InvalidToolArguments,
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
    #[serde(rename = "model_auth_failed")]
    ModelAuthFailed,
    #[serde(rename = "model_budget_exhausted")]
    ModelBudgetExhausted,
    #[serde(rename = "model_capacity_invalid")]
    ModelCapacityInvalid,
    #[serde(rename = "model_credential_required")]
    ModelCredentialRequired,
    #[serde(rename = "model_finalize_unconfirmed")]
    ModelFinalizeUnconfirmed,
    #[serde(rename = "model_input_limit")]
    ModelInputLimit,
    #[serde(rename = "model_limits_exceeded")]
    ModelLimitsExceeded,
    #[serde(rename = "model_network_error")]
    ModelNetworkError,
    #[serde(rename = "model_output_limit")]
    ModelOutputLimit,
    #[serde(rename = "model_quota_exhausted")]
    ModelQuotaExhausted,
    #[serde(rename = "model_rate_limited")]
    ModelRateLimited,
    #[serde(rename = "model_receipt_unknown")]
    ModelReceiptUnknown,
    #[serde(rename = "model_request_failed")]
    ModelRequestFailed,
    #[serde(rename = "model_retry_exhausted")]
    ModelRetryExhausted,
    #[serde(rename = "model_run_failed")]
    ModelRunFailed,
    #[serde(rename = "model_secret_unavailable")]
    ModelSecretUnavailable,
    #[serde(rename = "model_service_unavailable")]
    ModelServiceUnavailable,
    #[serde(rename = "model_timeout")]
    ModelTimeout,
    #[serde(rename = "model_unavailable")]
    ModelUnavailable,
    #[serde(rename = "model_usage_invalid")]
    ModelUsageInvalid,
    #[serde(rename = "model_usage_unknown")]
    ModelUsageUnknown,
    #[serde(rename = "no_final_output")]
    NoFinalOutput,
    #[serde(rename = "not_available")]
    NotAvailable,
    #[serde(rename = "outcome_unknown")]
    OutcomeUnknown,
    #[serde(rename = "provider_configuration_invalid")]
    ProviderConfigurationInvalid,
    #[serde(rename = "provider_model_unavailable")]
    ProviderModelUnavailable,
    #[serde(rename = "provider_parameters_changed")]
    ProviderParametersChanged,
    #[serde(rename = "provider_payload_invalid")]
    ProviderPayloadInvalid,
    #[serde(rename = "provider_transport_rejected")]
    ProviderTransportRejected,
    #[serde(rename = "request_too_large: model_input_limit")]
    RequestTooLargeModelInputLimit,
    #[serde(rename = "result_expired")]
    ResultExpired,
    #[serde(rename = "result_unavailable")]
    ResultUnavailable,
    #[serde(rename = "run_cancelled")]
    RunCancelled,
    #[serde(rename = "scope_incomplete")]
    ScopeIncomplete,
    #[serde(rename = "selection_required")]
    SelectionRequired,
    #[serde(rename = "source_interrupted")]
    SourceInterrupted,
    #[serde(rename = "source_not_allowed")]
    SourceNotAllowed,
    #[serde(rename = "source_unavailable")]
    SourceUnavailable,
    #[serde(rename = "stale_context")]
    StaleContext,
    #[serde(rename = "stale_knowledge")]
    StaleKnowledge,
    #[serde(rename = "task_context_required")]
    TaskContextRequired,
    #[serde(rename = "task_inactive")]
    TaskInactive,
    Unauthenticated,
    Unavailable,
    Unsupported,
    #[serde(rename = "vector_unavailable")]
    VectorUnavailable,
    #[serde(rename = "vector_unconfigured")]
    VectorUnconfigured,
    #[serde(rename = "version_conflict")]
    VersionConflict,
    #[serde(rename = "waiting_clarification")]
    WaitingClarification,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppendOutputClass {
    pub chunk_seq: String,
    pub lease_epoch: String,
    pub run_id: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApplySemanticCorrectionClass {
    pub expected_revision: String,
    pub expected_version: String,
    pub operation_id: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetElement {
    pub body: String,
    pub can_edit: Option<bool>,
    pub dependencies: Vec<EvidenceRefElement>,
    pub files: Option<Vec<SkillFileElement>>,
    pub id: String,
    pub kind: AssetKind,
    pub memory_index_state: Option<MemoryIndexState>,
    pub name: String,
    pub owner_id: Option<String>,
    pub scope: String,
    pub selected: bool,
    pub source_text: String,
    pub state: AssetState,
    /// 来源失效或缺少可核验来源时仅供管理，正文、附件与引用已隐藏，不能选用或发布。
    pub text_unavailable: Option<bool>,
    pub verified: bool,
    pub version: String,
    pub visibility: Option<Visibility>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillFileElement {
    /// UTF-8 文本；每行最多 51200 字节，业务边界校验并返回 skill_line_too_long。
    pub content: String,
    pub path: String,
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
    Draft,
    Enabled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Visibility {
    Personal,
    Space,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetListClass {
    pub assets: Vec<AssetElement>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetPageQueryClass {
    pub after_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetReadRefClass {
    pub id: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetSaveClass {
    /// Skill 的正文及生成资源每行最多 51200 UTF-8 字节；超限须分行保存。记忆不受此行限制。
    pub body: String,
    pub dependencies: Vec<EvidenceRefElement>,
    pub draft_id: Option<String>,
    pub expected_version: Option<String>,
    pub files: Option<Vec<SkillFileElement>>,
    pub id: Option<String>,
    pub kind: AssetKind,
    pub name: String,
    pub operation_id: String,
    pub scope: String,
    pub source_text: String,
    pub verified: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetToolInputClass {
    pub action: AssetToolInputAction,
    pub asset_id: Option<String>,
    pub body: Option<String>,
    pub dependencies: Option<Vec<EvidenceRefElement>>,
    pub expected_version: Option<String>,
    ///
    /// 保存或修订记忆所依据的本条用户消息逐字原文；句子/分号边界或逗号后明确以另外/此外另起的指令可作起点。引用在逗号结束时，宿主补齐同句剩余原文至句末/分号，核对并保存source_text，避免裁掉尾部否定与限定；最终正文只保留可复用内容，scope完整沿用最终正文中的对象和限定；不能把当次请求写为长期默认。
    pub instruction_quote: Option<String>,
    /// 候选显示名称；自动保存时宿主从最终正文截取前40个Unicode字符作为正式标签，避免另一次概括改变业务对象。
    pub name: Option<String>,
    /// 候选范围，参与临时限定预检查。自动保存时正式scope与最终body使用同一份完整提取文字，保留对象/限定；不能增加指标别名或扩大范围。以工具回执为准。
    pub scope: Option<String>,
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
pub struct AssignSemanticMaintainerClass {
    pub expected_version: String,
    /// 超级维护者调整独立对象负责人；null 撤销，不能调整 Datasight 表或字段。
    pub maintainer_id: Option<String>,
    pub operation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CancelReceiptClass {
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
pub struct CancelRunClass {
    pub lease_epoch: String,
    pub run_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogColumnElement {
    pub comment: String,
    pub data_type: String,
    pub id: String,
    pub name: String,
    pub nullable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogNodeClass {
    pub id: String,
    pub sql: String,
    pub upstream_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogPageClass {
    /// true表示该snapshot覆盖完整命名空间，可在全部分页成功后使缺席对象失效；false不允许推断删除。
    pub authoritative: bool,
    pub complete: bool,
    pub next_cursor: Option<String>,
    pub schema_version: f64,
    pub snapshot_id: String,
    pub source_namespace: String,
    pub tables: Vec<CatalogTableElement>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogTableElement {
    pub columns: Vec<CatalogColumnElement>,
    pub comment: String,
    pub ddl: String,
    pub id: String,
    /// Datasight 维护人；未提供或 null 表示暂无负责人，不继承录入者。
    pub maintainer_id: Option<String>,
    pub name: String,
    pub node: Option<CatalogNodeClass>,
    pub platform_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessageElement {
    pub attempt_id: Option<String>,
    pub committed: bool,
    pub event_seq: Option<String>,
    pub message_id: Option<String>,
    pub output_id: Option<String>,
    pub request_clock: Option<RequestClockClass>,
    pub role: ChatMessageRole,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestClockClass {
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
pub enum ChatMessageRole {
    Assistant,
    User,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckpointClass {
    pub authority_revision: Option<String>,
    pub authority_snapshot: Option<HashMap<String, Option<serde_json::Value>>>,
    pub entries: Vec<HashMap<String, Option<serde_json::Value>>>,
    pub leaf_id: Option<String>,
    pub sdk_version: SdkVersion,
    pub storage: Option<CheckpointReferenceClass>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SdkVersion {
    #[serde(rename = "1.0.0")]
    The100,
    #[serde(rename = "1.3.0")]
    The130,
    #[serde(rename = "1.4.0")]
    The140,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckpointReferenceClass {
    pub file: Option<String>,
    pub kind: CheckpointReferenceKind,
    pub session_id: Option<String>,
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
pub struct ConfiguredModelClass {
    pub anthropic_thinking_mode: Option<AnthropicThinkingMode>,
    pub api: Api,
    pub id: String,
    pub input_rate: String,
    pub output_rate: String,
    pub reasoning_supported: bool,
    pub service_id: String,
    pub service_version: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnthropicThinkingMode {
    Adaptive,
    Budget,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Api {
    #[serde(rename = "anthropic-messages")]
    AnthropicMessages,
    #[serde(rename = "openai-completions")]
    OpenaiCompletions,
    #[serde(rename = "openai-responses")]
    OpenaiResponses,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfirmQueryClass {
    pub condition_version: String,
    pub draft_version: String,
    pub operation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationModelSelectionClass {
    pub selection: Option<ModelSelectionClass>,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelSelectionClass {
    pub model_id: String,
    pub thinking_level: ThinkingLevel,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThinkingLevel {
    High,
    Low,
    Max,
    Medium,
    Minimal,
    Off,
    Xhigh,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationReadInputClass {
    pub after_seq: String,
    pub message_id: Option<String>,
    pub offset: Option<i32>,
    pub task_after: Option<String>,
    pub task_directory: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationReceiptClass {
    pub conversation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationSkillSelectionElement {
    pub asset_id: String,
    pub availability: Availability,
    pub current_version: Option<String>,
    pub name: Option<String>,
    pub owner_id: Option<String>,
    pub selected_version: String,
    pub selection_id: String,
    pub visibility: Option<Visibility>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Availability {
    Available,
    #[serde(rename = "dependency_unavailable")]
    DependencyUnavailable,
    Disabled,
    Unavailable,
    #[serde(rename = "version_changed")]
    VersionChanged,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationSkillSelectionsClass {
    pub change_blocked: bool,
    pub conversation_id: String,
    pub next_after_id: Option<String>,
    pub selections: Vec<ConversationSkillSelectionElement>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateConversationClass {
    pub operation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CurrentAnalysisUpdateClass {
    pub action: AnalysisUpdateAction,
    /// 同一任务需分别回答的独立问题，各生成独立ID；与非空question互斥，不同目标分别建任务。
    pub clarifications: Option<Vec<ClarificationElement>>,
    ///
    /// 修改已存任务条件时必填，action用revise或clarify；set指定新值，unset可省略（省略即不清空任何字段，null非法）。route禁止携带condition_patch，因为route只登记归属。
    pub condition_patch: Option<PurpleConditionPatch>,
    /// 新建任务必须完整给出；未指定的可空标量用JSON null，列表用[]，notes用空字符串，timezone按宿主业务时区。
    pub conditions: Option<PurpleConditions>,
    /// 新建任务省略此字段（也接受JSON null）；已有任务必须提供工具回执中的当前版本数字字符串。
    pub expected_version: Option<String>,
    ///
    /// 仅route可用：显式定稿当前任务已完成的说明或查询答案；可route到同一任务保留其SQL等待状态，也可切到其他目标。该助手消息只允许这个route；宿主绑定完整正文或原成功答案回执。普通route不定稿，不授执行权。
    pub finalize_current_answer: Option<bool>,
    pub goal: Option<String>,
    pub legacy_resolution_migration: Option<LegacyResolutionMigrationClass>,
    /// split迁移到新独立目标的原开放问题ID，保留问题正文与来源，其余原目标问题不动。
    pub moved_clarification_ids: Option<Vec<String>>,
    /// 澄清问题的候选答案；仅与实际question同用，开放回答可无候选（空数组或省略）。
    pub options: Option<Vec<String>>,
    /// 需要用户补充的实际问题；无需澄清时省略（也接受JSON null），不能填字符串null、空文本或用户原问题。
    pub question: Option<String>,
    pub replaces_query_id: Option<String>,
    ///
    /// 本消息中用户已真实回答，或当前有效且获准资料已唯一解决的事实问题ID；事实解决须在同次revise保存条件与依据，不能伪称用户选择。省略或[]保留其他问题，仅已有任务revise/clarify可用。
    pub resolved_clarification_ids: Option<Vec<String>>,
    /// 新建任务省略此字段（也接受JSON null）；已有任务用工具回执中的真实ID，不能填字符串null。
    pub task_id: Option<String>,
}

///
/// 修改已存任务条件时必填，action用revise或clarify；set指定新值，unset可省略（省略即不清空任何字段，null非法）。route禁止携带condition_patch，因为route只登记归属。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PurpleConditionPatch {
    pub set: FluffyConditionSet,
    /// 清除指定条件字段。省略即空集合（不清空任何字段），null非法；显式数组仍清除列出的字段。
    pub unset: Option<Vec<Unset>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FluffyConditionSet {
    pub channel: Option<ConditionsChannel>,
    pub filters: Option<Vec<String>>,
    pub group_by: Option<Vec<String>>,
    pub knowledge_refs: Option<Vec<EvidenceRefElement>>,
    pub metric: Option<String>,
    pub notes: Option<String>,
    /// 只更新已采用解释及来源；null/unset只清说明，不解决开放问题。旧未决通过明确legacy_resolution_migration转换。
    pub semantic_resolution: Option<PurpleSemanticResolution>,
    /// 设置来源限制；撤销使用unset source_limits，不接受设为空集。
    #[serde(
        default,
        deserialize_with = "deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub source_limits: Option<Option<SourceLimitsClass>>,
    /// 修改区间的不包含终点，按业务时区解析后填写UTC完整时间戳，以Z结尾；整月结束为下一月起点。清空使用unset；未修改则省略。
    pub time_end: Option<String>,
    /// 整体替换时间口径角色；清空使用unset。
    pub time_roles: Option<Vec<TimeRoleElement>>,
    /// 修改区间的包含起点，按业务时区解析后填写UTC完整时间戳，以Z结尾。清空使用unset；未修改则省略。
    pub time_start: Option<String>,
    pub timezone: Option<String>,
}

///
/// 新格式仅记录已经采用的解释。explicit_user引用本轮完整原话，null/省略采纳身份由宿主绑定；原已核对象可同文继承。未决只登记clarifications，无问题且条件充分时不要求本对象。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PurpleSemanticResolution {
    ///
    /// explicit_user：null=本轮新采纳，由宿主核对user_quote为本轮完整原话后绑定真实消息身份；非空=复制继承原已验证决策的消息身份，不接受模型自由填写。其余basis为null。
    pub adoption_message_id: Option<String>,
    /// 真实用户明确选择、确无实质歧义、或仍需澄清；资料支持某公式不等于用户选择它。
    pub basis: SemanticResolutionBasisEnum,
    /// 支撑该口径决策的依据引用；旧调用缺失按空数组解码。
    pub evidence_refs: Option<Vec<EvidenceRefElement>>,
    /// 本稿采用的指标、分子/分母、时间等关键口径及选择依据；不能把自己刚写入任务的假设当作用户采用。
    pub interpretation: String,
    /// explicit_user逐字填写本条真实用户完整原话，保留否定、前提、例外和换行，不截取子串；其余为null。
    pub user_quote: Option<String>,
}

/// 新建任务必须完整给出；未指定的可空标量用JSON null，列表用[]，notes用空字符串，timezone按宿主业务时区。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PurpleConditions {
    pub channel: Option<ConditionsChannel>,
    pub filters: Vec<String>,
    pub group_by: Vec<String>,
    pub knowledge_refs: Vec<EvidenceRefElement>,
    pub metric: Option<String>,
    pub notes: String,
    /// 当前格式仅记录已采用解释及依据，未决由clarifications表达；省略继承，null只清说明，未要求所有任务填写。旧形状按宿主持久格式标记兼容，读取不迁移。
    pub semantic_resolution: Option<FluffySemanticResolution>,
    /// null表示本题显式未声明额外来源限制；字段缺失表示旧条件版本未记录新式限制，不能证明用户从未限制。撤销必须显式unset并来自真实用户修改。
    #[serde(
        default,
        deserialize_with = "deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub source_limits: Option<Option<SourceLimitsClass>>,
    /// 时间区间的不包含终点。按明确的业务时区解析后转为UTC完整时间戳，以Z结尾；整月结束为下一月起点，不能写本月最后一天。未指定时为null。
    pub time_end: Option<String>,
    /// 时间口径角色；统计起止仍沿time_start/time_end，request_clock和平台data_freshness不冒充用户截点。字段缺失表示旧版本未记录。
    pub time_roles: Option<Vec<TimeRoleElement>>,
    /// 时间区间的包含起点。按明确的业务时区解析后转为UTC完整时间戳，以Z结尾；不能只写日期。未指定时为null。
    pub time_start: Option<String>,
    pub timezone: String,
}

///
/// 新格式仅记录已经采用的解释。explicit_user引用本轮完整原话，null/省略采纳身份由宿主绑定；原已核对象可同文继承。未决只登记clarifications，无问题且条件充分时不要求本对象。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FluffySemanticResolution {
    ///
    /// explicit_user：null=本轮新采纳，由宿主核对user_quote为本轮完整原话后绑定真实消息身份；非空=复制继承原已验证决策的消息身份，不接受模型自由填写。其余basis为null。
    pub adoption_message_id: Option<String>,
    /// 真实用户明确选择、确无实质歧义、或仍需澄清；资料支持某公式不等于用户选择它。
    pub basis: SemanticResolutionBasisEnum,
    /// 支撑该口径决策的依据引用；旧调用缺失按空数组解码。
    pub evidence_refs: Option<Vec<EvidenceRefElement>>,
    /// 本稿采用的指标、分子/分母、时间等关键口径及选择依据；不能把自己刚写入任务的假设当作用户采用。
    pub interpretation: String,
    /// explicit_user逐字填写本条真实用户完整原话，保留否定、前提、例外和换行，不截取子串；其余为null。
    pub user_quote: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CurrentRequestQueryInputClass {
    pub condition_version: String,
    pub knowledge_refs: Vec<EvidenceRefElement>,
    pub parameters: HashMap<String, Option<serde_json::Value>>,
    pub replaces_query_id: Option<String>,
    /// 省略继承目标条件版本已有采纳说明；兼容携带只核同义声明，不能独立另作决定。新任务未决定时登记clarifications，改变解释先同次修订条件。旧形状仅沿旧格式兼容。
    pub semantic_resolution: Option<IndigoSemanticResolution>,
    pub sql: String,
    pub summary: String,
    pub target_id: TargetId,
    pub task_id: String,
}

/// 旧未决形状与新采纳说明仅在兼容边界解码；实际条件格式由宿主decision_state_version决定。
///
/// 省略继承目标条件版本已有采纳说明；兼容携带只核同义声明，不能独立另作决定。新任务未决定时登记clarifications，改变解释先同次修订条件。旧形状仅沿旧格式兼容。
///
///
/// 新格式仅记录已经采用的解释。explicit_user引用本轮完整原话，null/省略采纳身份由宿主绑定；原已核对象可同文继承。未决只登记clarifications，无问题且条件充分时不要求本对象。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndigoSemanticResolution {
    ///
    /// explicit_user：null=本轮新采纳，由宿主核对user_quote为本轮完整原话后绑定真实消息身份；非空=复制继承原已验证决策的消息身份，不接受模型自由填写。其余basis为null。
    pub adoption_message_id: Option<String>,
    /// 真实用户明确选择、确无实质歧义、或仍需澄清；资料支持某公式不等于用户选择它。
    pub basis: SemanticResolutionBasisEnum,
    /// 支撑该口径决策的依据引用；旧调用缺失按空数组解码。
    pub evidence_refs: Option<Vec<EvidenceRefElement>>,
    /// 本稿采用的指标、分子/分母、时间等关键口径及选择依据；不能把自己刚写入任务的假设当作用户采用。
    pub interpretation: String,
    /// explicit_user逐字填写本条真实用户完整原话，保留否定、前提、例外和换行，不截取子串；其余为null。
    pub user_quote: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TargetId {
    #[serde(rename = "synthetic-sqlite")]
    SyntheticSqlite,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataToolInvocationClass {
    pub answer_handoff: Option<AnswerHandoffClass>,
    pub arguments: HashMap<String, Option<serde_json::Value>>,
    pub checkpoint: CheckpointClass,
    pub lease_epoch: String,
    /// 宿主按实际Pi投影与同批工具共享余量分配；不参与业务身份，不属于模型工具参数。历史调用可缺省。
    pub response_budget: Option<ResponseBudgetClass>,
    pub run_id: String,
    pub sdk_tool_call_id: String,
    pub tool_name: ToolName,
}

/// 显式route登记时冻结的宿主事实；恢复先接原登记，不从新attempt重算。成功答案回执仍是候选，route事务提交后才成为part。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnswerHandoffClass {
    pub answer_sdk_tool_call_id: Option<String>,
    pub assistant: Option<OutputBindingClass>,
    /// 渲染正文交接分支；与顶层assistant互斥。当前冻结route所在原assistant允许toolUse，tool_call_ids只含本次route。
    pub rendered_answer_binding: Option<RenderedAnswerBindingClass>,
}

/// 宿主从Pi完整助手条目绑定，正文位置来自已确认输出队列；模型不能提供这些字段。
///
/// 原Pi entry/attempt/stop/tool
/// IDs与source_text的SHA256；本分支禁止携带first/last_chunk_seq，展示范围由外层字段表达。
///
///
/// 宿主确认的正常完整自然final原输出绑定；恢复时保原attempt/entry/片段。须有final_text，与answer_parts、answer_sdk_tool_call_id、control_delivery_ref及final_start_chunk_seq互斥。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputBindingClass {
    pub attempt_id: String,
    pub entry_id: String,
    pub first_chunk_seq: Option<String>,
    pub last_chunk_seq: Option<String>,
    pub stop_reason: StopReason,
    pub text_sha256: String,
    pub tool_call_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StopReason {
    Aborted,
    Error,
    Length,
    Stop,
    #[serde(rename = "toolUse")]
    ToolUse,
}

/// 渲染正文交接分支；与顶层assistant互斥。当前冻结route所在原assistant允许toolUse，tool_call_ids只含本次route。
///
/// 宿主生成的一次渲染绑定：原文、原prepare回执与展示片段范围；模型不能提供这些字段。
///
/// 未冻结末项的渲染正文分支；与output_binding、answer_sdk_tool_call_id互斥。
///
///
/// 单份渲染正文分支：final_text为该份display（非模板、非整轮组合全文），与answer_parts、answer_sdk_tool_call_id、control_delivery_ref、output_binding及final_start_chunk_seq互斥。组合时改用answer_parts末项的rendered分支，不传顶层rendered。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenderedAnswerBindingClass {
    /// 原Pi entry/attempt/stop/tool
    /// IDs与source_text的SHA256；本分支禁止携带first/last_chunk_seq，展示范围由外层字段表达。
    pub assistant: OutputBindingClass,
    /// 已持久化展示片段范围；display = replace_once(source_text, bindings) + required_suffix。
    pub first_chunk_seq: String,
    pub last_chunk_seq: String,
    /// 本条正文实际采用的原prepare_analysis_answer成功回执；不因分支上后来存在新prepare而改用最近一份。
    pub prepared_sdk_tool_call_id: String,
    /// 原Pi完整正文（含{{name}}标记），来自Node宿主SessionManager原assistant entry；不是展示替换后的文字。Rust边界核对其UTF-8
    /// SHA256。
    pub source_text: String,
}

/// 宿主按实际Pi投影与同批工具共享余量分配；不参与业务身份，不属于模型工具参数。历史调用可缺省。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResponseBudgetClass {
    pub estimated_tokens: i32,
    pub max_bytes: i32,
    pub projection_fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolName {
    #[serde(rename = "cancel_query")]
    CancelQuery,
    #[serde(rename = "execute_query")]
    ExecuteQuery,
    #[serde(rename = "get_query")]
    GetQuery,
    #[serde(rename = "manage_personal_asset")]
    ManagePersonalAsset,
    #[serde(rename = "prepare_analysis_answer")]
    PrepareAnalysisAnswer,
    #[serde(rename = "prepare_skill_draft")]
    PrepareSkillDraft,
    #[serde(rename = "present_analysis_answer")]
    PresentAnalysisAnswer,
    #[serde(rename = "propose_semantic_change")]
    ProposeSemanticChange,
    Read,
    #[serde(rename = "read_analysis_report")]
    ReadAnalysisReport,
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
    #[serde(rename = "save_analysis_evidence")]
    SaveAnalysisEvidence,
    #[serde(rename = "save_analysis_report")]
    SaveAnalysisReport,
    #[serde(rename = "search_knowledge")]
    SearchKnowledge,
    #[serde(rename = "update_analysis_task")]
    UpdateAnalysisTask,
    #[serde(rename = "validate_sql")]
    ValidateSql,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataToolOutcomeClass {
    pub answer_parts: Option<Vec<AnswerPartReferenceElement>>,
    /// 成功答案的原工具登记归属，来自宿主task_id/task_condition_version；与实际sources和通知交付目标分开，不改原回执存储字节。
    pub answer_task_ref: Option<EvidenceTaskRefElement>,
    /// 宿主成功回执声明需要Pi原生重投影的活动任务。省略表示无需调整。
    pub context_reset: Option<DataToolOutcomeContextReset>,
    pub control_delivery: Option<ControlDeliveryClass>,
    pub data: HashMap<String, Option<serde_json::Value>>,
    ///
    /// 宿主按本运行原通知query/task/condition及其原scope核验全部实际冻结答案后的覆盖事实；与control_delivery共同计算，不从source_query_ids推断。只随控制状态回执更新，不授来源或SQL权限。
    pub frozen_notification_covered: Option<bool>,
    pub operation_id: String,
    /// 未就绪原因，由原判定同次产出；就绪时省略。旧回执可缺省，不据缺省推断已就绪，恢复时采用当前宿主事实。
    pub source_context_blocker: Option<SourceContextBlocker>,
    /// 宿主核对本消息归属和来源声明后的正文准入状态；不由模型填写。若context_reset存在，Pi先完成既有重投影/刷新再采用新正文。
    pub source_context_ready: Option<bool>,
    /// 本次条件修订实际作废的未提交SQL草稿ID；宿主同事务生成，消费者撤下旧观察。缺省表示旧回执未提供该信息，不据此推定草稿有效。
    pub superseded_query_ids: Option<Vec<String>>,
    /// 生成该结果的原tool合同版本，成功与明确拒绝均沿原登记值；历史缺失按1，Node可由已校验的原OperationReceipt补足。
    pub tool_contract_version: Option<i64>,
    pub tool_name: ToolName,
}

///
/// 有序原内容引用。已定稿项只携宿主控制身份和实际source_query_ids，不凭ID命中判断通知scope覆盖；有新末项时引用原输出或成功答案回执。数量还须受实际消息任务集合约束，不增加模型额度。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnswerPartReferenceElement {
    pub answer_sdk_tool_call_id: Option<String>,
    pub finalized_by_sdk_tool_call_id: Option<String>,
    pub output_binding: Option<OutputBindingClass>,
    /// 未冻结末项的渲染正文分支；与output_binding、answer_sdk_tool_call_id互斥。
    pub rendered_answer_binding: Option<RenderedAnswerBindingClass>,
    pub scope_fingerprint: Option<String>,
    /// 定稿答案成功回执实际核验的query_id集合；只标识实际来源，不证明符合通知原scope，通知覆盖由宿主另行核验。
    pub source_query_ids: Option<Vec<String>>,
    pub task_ref: EvidenceTaskRefElement,
}

/// 成功答案的原工具登记归属，来自宿主task_id/task_condition_version；与实际sources和通知交付目标分开，不改原回执存储字节。
///
/// 原查询所属任务和条件版本，由宿主绑定；恢复已切任务时不依赖最近查询观察窗口。旧通知缺字段沿原兼容路径读取。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvidenceTaskRefElement {
    pub condition_version: String,
    pub task_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataToolOutcomeContextReset {
    pub condition_version: String,
    pub task_id: String,
}

///
/// 宿主按持久任务/查询事实生成的短控制交付；只覆盖已保存、已提交、等待结果和已持久澄清，不代表分析完成。text_authority只记录实际展示文字的来源；旧回执缺省时沿原任务字段来源核验，不能当作空来源。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControlDeliveryClass {
    pub facts: Vec<FactElement>,
    pub fingerprint: String,
    pub task_refs: Vec<EvidenceTaskRefElement>,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_authority: Option<HashMap<String, Option<serde_json::Value>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FactElement {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clarification_id: Option<String>,
    pub condition_version: String,
    #[serde(
        default,
        deserialize_with = "deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub confirmation_state: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_state: Option<FactExecutionState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_more: Option<bool>,
    pub kind: FactKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question: Option<String>,
    pub task_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FactExecutionState {
    Cancelled,
    Failed,
    #[serde(rename = "not_submitted")]
    NotSubmitted,
    Queued,
    Running,
    #[serde(rename = "submission_unknown")]
    SubmissionUnknown,
    Submitting,
    Succeeded,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FactKind {
    Clarification,
    Query,
}

/// 未就绪原因，由原判定同次产出；就绪时省略。旧回执可缺省，不据缺省推断已就绪，恢复时采用当前宿主事实。
///
/// 既有来源准入判定的阻断原因：本条输入未归属、有效来源声明未定、或等待原上下文刷新。仅用于恢复指导，不授予权限或改变来源范围。
///
/// 与本快照source_context_ready同次计算的未就绪原因；仅控制信息，不含来源正文。就绪时省略，旧快照缺省仍沿原准入行为。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceContextBlocker {
    #[serde(rename = "context_refresh_pending")]
    ContextRefreshPending,
    #[serde(rename = "input_not_routed")]
    InputNotRouted,
    #[serde(rename = "source_scope_unknown")]
    SourceScopeUnknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeliveredSupportElement {
    pub content: Option<String>,
    /// 支持正文自己的Unicode字符页；游标仍沿supports_next_cursor继续。同一支持的尾页不代表本回执已包含整条支持。
    pub content_page: Option<ContentPageClass>,
    pub delivered_in: Option<DeliveredSupportDeliveredIn>,
    pub embedded_in: Option<EmbeddedSupportLocationClass>,
    pub reference: SemanticReferenceClass,
    pub role: PreparedSupportRole,
    pub support_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeliveredSupportDeliveredIn {
    pub locator: SourceLocatorClass,
    pub path: String,
}

/// offset及length固定使用Unicode code point；heading_path仅作定位提示。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceLocatorClass {
    pub heading_path: Option<Vec<String>>,
    pub length: i64,
    pub offset: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddedSupportLocationClass {
    pub field: Field,
    pub locator: SourceLocatorClass,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Field {
    #[serde(rename = "scope_text")]
    ScopeText,
    Text,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SemanticReferenceClass {
    pub citation: Option<SourceCitationElement>,
    pub kind: SemanticReferenceKind,
    #[serde(rename = "ref")]
    pub semantic_reference_ref: Option<EvidenceRefElement>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceCitationElement {
    pub locator: SourceLocatorClass,
    pub revision: String,
    pub source: SourceKeyElement,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SemanticReferenceKind {
    Knowledge,
    Source,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreparedSupportRole {
    #[serde(rename = "calculation_dependency")]
    CalculationDependency,
    Exception,
    Prerequisite,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddingProfileClass {
    /// 可选：显式维护试用的累计调用帽；普通维护配置省略，无累计上限与期限。
    pub call_limit: Option<i32>,
    /// 可选：显式维护试用的累计费用帽；普通维护配置省略。
    pub cost_limit_micros: Option<String>,
    pub trial_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventElement {
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
    #[serde(rename = "analysis_evidence_saved")]
    AnalysisEvidenceSaved,
    #[serde(rename = "analysis_report_saved")]
    AnalysisReportSaved,
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
    #[serde(rename = "skill_draft_prepared")]
    SkillDraftPrepared,
    #[serde(rename = "task_cancelled")]
    TaskCancelled,
    #[serde(rename = "task_changed")]
    TaskChanged,
    #[serde(rename = "tool_result")]
    ToolResult,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvidenceContinuationClass {
    pub content_next_offset: Option<i64>,
    pub supports_next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvidenceReadResultElement {
    pub citations: Option<Vec<SourceCitationElement>>,
    pub content: Option<String>,
    pub content_page: Option<ContentPageClass>,
    pub content_state: Option<ContentState>,
    pub continuation: Option<EvidenceContinuationClass>,
    pub effective_structure: Option<KnowledgeEntryQueryExampleStructure>,
    pub kind: EvidenceReadResultKind,
    #[serde(rename = "ref")]
    pub evidence_read_result_ref: Option<EvidenceRefElement>,
    pub state: EvidenceReadResultState,
    pub statement_id: Option<String>,
    pub structure_coverage: Option<PurpleStructureCoverage>,
    /// 本次实际核定的当前结构表与显式语义依赖；原结构说明及原登记版本保持原值。
    pub structure_dependencies: Option<Vec<EvidenceRefElement>>,
    pub structure_page: Option<ContentPageClass>,
    pub structure_text: Option<String>,
    pub support_state: Option<SupportState>,
    pub supports: Option<Vec<DeliveredSupportElement>>,
    pub supports_complete: Option<bool>,
    pub supports_total: Option<i64>,
    pub asset: Option<MemoryElement>,
    pub asset_ref: Option<AssetReadRefClass>,
    pub part: Option<PartEnum>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryElement {
    pub body: String,
    pub content_page: Option<ContentPageClass>,
    pub dependencies: Vec<EvidenceRefElement>,
    pub id: String,
    pub kind: AssetKind,
    pub name: String,
    pub native_path: Option<String>,
    pub owner_id: Option<String>,
    pub scope: String,
    pub scope_page: Option<ContentPageClass>,
    pub selected: bool,
    /// 来源原话的独立字符分页。缺省source_text为空但保留总长和补读位置；以entry_id=source_text和同一资产版本读取。
    pub source_page: Option<ContentPageClass>,
    pub source_text: String,
    pub state: MemoryState,
    pub verified: bool,
    pub version: String,
    pub visibility: Option<Visibility>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryState {
    Deleted,
    Disabled,
    Enabled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContentState {
    Complete,
    Partial,
}

pub type KnowledgeEntryQueryExampleStructure = SemanticStructure;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Cardinality {
    #[serde(rename = "many_to_many")]
    ManyToMany,
    #[serde(rename = "many_to_one")]
    ManyToOne,
    #[serde(rename = "one_to_many")]
    OneToMany,
    #[serde(rename = "one_to_one")]
    OneToOne,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComputedMetricElement {
    /// 输出该口径的表达式或列计算说明。
    pub expression: String,
    pub metric_ref: EvidenceRefElement,
    /// 该SQL实际输出的口径名；与过滤中用到的指标分开表达。
    pub output_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PurpleJoinKey {
    pub left_column: String,
    pub right_column: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SemanticStructureKind {
    Field,
    Metric,
    #[serde(rename = "query_example")]
    QueryExample,
    Relationship,
    Table,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SemanticTableRefClass {
    pub object_id: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryExampleParameterElement {
    pub description: String,
    pub name: String,
    pub required: bool,
    #[serde(rename = "type")]
    pub query_example_parameter_type: QueryExampleParameterType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QueryExampleParameterType {
    Boolean,
    Integer,
    Number,
    #[serde(rename = "string")]
    TypeString,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PurpleTimeColumn {
    pub column: String,
    pub role: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryExampleVerificationClass {
    pub evidence_refs: Vec<EvidenceRefElement>,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceReadResultKind {
    Knowledge,
    Memory,
    Skill,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PartEnum {
    Body,
    Scope,
    #[serde(rename = "source_text")]
    SourceText,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceReadResultState {
    #[serde(rename = "not_available")]
    NotAvailable,
    Stale,
    #[serde(rename = "ok")]
    StateOk,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PurpleStructureCoverage {
    pub notes: Vec<String>,
    pub state: StructureCoverageState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StructureCoverageState {
    Complete,
    #[serde(rename = "missing_semantics")]
    MissingSemantics,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SupportState {
    Delivered,
    Partial,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecuteQueryInputClass {
    pub condition_version: Option<String>,
    pub draft_version: Option<String>,
    pub instruction_quote: String,
    /// 同一用户消息明确授权的完整查询集合，一次确认；不能与单条query_id/draft_version/condition_version同时传。
    pub queries: Option<Vec<PurpleQuery>>,
    pub query_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PurpleQuery {
    pub condition_version: String,
    pub draft_version: String,
    pub query_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FinalizeModelCallClass {
    pub call_attempt_id: String,
    pub lease_epoch: String,
    /// 受控provider给出的调用结果；与是否取得可靠用量分开。连续临时失败在原请求范围持久计数。
    pub outcome: Option<Outcome>,
    pub parameters_fingerprint: String,
    pub run_id: String,
    pub usage: Option<ModelUsageClass>,
}

/// 受控provider给出的调用结果；与是否取得可靠用量分开。连续临时失败在原请求范围持久计数。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    #[serde(rename = "permanent_error")]
    PermanentError,
    Success,
    #[serde(rename = "transient_error")]
    TransientError,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelUsageClass {
    pub elapsed_ms: i32,
    pub input_tokens: i32,
    pub output_tokens: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FinishReceiptClass {
    pub output_id: String,
    pub state: FinishReceiptState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FinishReceiptState {
    Finished,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FinishRunClass {
    ///
    /// 完整有序引用。存在新末项时final_text核对其原文；原消息其余任务均已取消或由可见任务卡/宿主控制交付解释且有效任务已冻结时，可只发冻结引用并省略final_text。单份正文仍限8000字符；多份组合由实际项数、标题和分隔格式推导，上限384281字符。Rust核当前任务集合与来源后取原内容组合。
    pub answer_parts: Option<Vec<AnswerPartReferenceElement>>,
    /// 使用present_analysis_answer成功回执交付时绑定该SDK调用，正文须与宿主生成值一致。
    pub answer_sdk_tool_call_id: Option<String>,
    pub checkpoint: CheckpointClass,
    pub commit_id: String,
    pub control_delivery_ref: Option<ControlDeliveryRefClass>,
    /// Pi最后助手消息的首个已保存片段序号；省略时沿用从1起的完整文本校验。
    pub final_start_chunk_seq: Option<String>,
    pub final_text: Option<String>,
    pub lease_epoch: String,
    ///
    /// 宿主确认的正常完整自然final原输出绑定；恢复时保原attempt/entry/片段。须有final_text，与answer_parts、answer_sdk_tool_call_id、control_delivery_ref及final_start_chunk_seq互斥。
    pub output_binding: Option<OutputBindingClass>,
    ///
    /// 单份渲染正文分支：final_text为该份display（非模板、非整轮组合全文），与answer_parts、answer_sdk_tool_call_id、control_delivery_ref、output_binding及final_start_chunk_seq互斥。组合时改用answer_parts末项的rendered分支，不传顶层rendered。
    pub rendered_answer_binding: Option<RenderedAnswerBindingClass>,
    pub run_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControlDeliveryRefClass {
    pub fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetQueryInputClass {
    pub column_index: Option<i64>,
    /// 超长JSON片段续读的Unicode字符偏移。
    pub content_offset: Option<i32>,
    pub cursor: Option<String>,
    pub query_id: String,
    pub row_index: Option<i32>,
    /// rows默认；statistics独立统计；cell按绝对行列读值。
    pub view: Option<AgentQueryResultsView>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryClass {
    pub conversations: Vec<HistoryItemElement>,
    pub next_before_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryItemElement {
    /// 会话创建时间（UTC）；用于区分同名会话，不改变分页顺序。
    pub created_at: Option<String>,
    pub id: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryQueryClass {
    pub before_id: Option<String>,
    pub q: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostCheckpointReferenceClass {
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
pub struct HumanStatementInputElement {
    pub citations: Vec<SourceCitationElement>,
    pub key: String,
    pub scope_text: String,
    pub supports: Vec<PreparedSupportElement>,
    pub supports_complete: Option<bool>,
    pub target: EvidenceRefElement,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreparedSupportElement {
    pub content: Option<String>,
    pub embedded_in: Option<EmbeddedSupportLocationClass>,
    pub key: String,
    pub reference: SemanticReferenceClass,
    pub role: PreparedSupportRole,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IdentityClass {
    pub model_label: ModelLabel,
    pub space_id: String,
    /// 空间显示名，由部署配置下发；与space_id分开，不参与授权判断。
    pub space_name: String,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeBatchEditClass {
    pub objects: Vec<KnowledgeEditGroupElement>,
    pub operation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeEditGroupElement {
    /// 同一对象内按序应用的条目修改；任一条目校验失败则整批回滚。
    pub edits: Vec<EditElement>,
    /// 暂存这些条目时读到的对象版本。
    pub expected_version: String,
    pub object_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditElement {
    pub clear_override: Option<bool>,
    pub entry_id: String,
    pub related_ids: Option<Vec<String>>,
    pub source_url: Option<String>,
    /// 本条目明确保存的人工陈述及支持提取声明；身份和origin由服务端生成。
    pub statements: Option<Vec<HumanStatementInputElement>>,
    pub structured_value: Option<KnowledgeEntryQueryExampleStructure>,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeBatchReceiptClass {
    pub objects: Vec<KnowledgeObjectElement>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeObjectElement {
    pub analysis_preference: Option<TableAnalysisPreferenceClass>,
    pub created_by: Option<String>,
    /// 整篇编辑后后台片段的拼接顺序；与正文同版本保存，不作为页面字段。
    pub document_order: Option<i32>,
    pub entries: Vec<KnowledgeEntryElement>,
    pub id: String,
    pub kind: KindElement,
    pub maintenance: Option<SemanticMaintenanceClass>,
    pub name: String,
    pub prefill_status: Option<KnowledgeObjectPrefillStatus>,
    /// 当前来源的语义整理状态；与对象级预填分开表达，两作业互不冒充。
    pub preparation_status: Option<KnowledgeObjectPreparationStatus>,
    pub related_ids: Vec<String>,
    pub retrieval: Option<KnowledgeRetrievalClass>,
    pub semantic_relations: Option<Vec<SemanticRelationElement>>,
    pub source_id: Option<String>,
    pub source_version: String,
    pub state: MemoryState,
    /// 平台移除与人工停用分开；重新出现只能恢复平台导致的停用。
    pub state_origin: Option<StateOrigin>,
    pub updated_by: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableAnalysisPreferenceClass {
    pub preferred: bool,
    pub table_id: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeEntryElement {
    pub effective_structure: Option<KnowledgeEntryQueryExampleStructure>,
    pub effective_value: String,
    pub entry_id: String,
    pub human_override: Option<KnowledgeEntryHumanOverride>,
    pub label: String,
    pub path: String,
    pub review_state: ReviewState,
    pub source_facts: KnowledgeEntrySourceFacts,
    pub statements: Option<Vec<SemanticStatementElement>>,
    pub suggestion: KnowledgeEntrySuggestion,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeEntryHumanOverride {
    #[serde(
        default,
        deserialize_with = "deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub structured_value: Option<Option<KnowledgeEntryQueryExampleStructure>>,
    #[serde(flatten)]
    pub extra: std::collections::BTreeMap<String, serde_json::Value>,
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
pub struct KnowledgeEntrySourceFacts {
    #[serde(
        default,
        deserialize_with = "deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub structured_value: Option<Option<KnowledgeEntryQueryExampleStructure>>,
    #[serde(flatten)]
    pub extra: std::collections::BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SemanticStatementElement {
    pub citations: Vec<SourceCitationElement>,
    pub object_ref: EvidenceRefElement,
    pub origin: Origin,
    pub scope_text: String,
    pub statement_id: String,
    pub supports: Vec<SemanticSupportElement>,
    /// 人工或整理成果对该陈述支持提取范围的明确完整性声明；历史缺字段或null为unknown，不从空supports或ready推导。
    pub supports_complete: Option<bool>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Origin {
    Human,
    #[serde(rename = "model_inference")]
    ModelInference,
    #[serde(rename = "source_fact")]
    SourceFact,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SemanticSupportElement {
    pub content: Option<String>,
    pub embedded_in: Option<EmbeddedSupportLocationClass>,
    pub reference: SemanticReferenceClass,
    pub role: PreparedSupportRole,
    pub support_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeEntrySuggestion {
    #[serde(
        default,
        deserialize_with = "deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub structured_value: Option<Option<KnowledgeEntryQueryExampleStructure>>,
    #[serde(flatten)]
    pub extra: std::collections::BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KindElement {
    Document,
    Field,
    Metric,
    #[serde(rename = "query_example")]
    QueryExample,
    Relationship,
    Table,
    Term,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SemanticMaintenanceClass {
    pub authority_id: String,
    pub can_assign: bool,
    pub can_edit: bool,
    /// 当前对象负责人：表来自 Datasight；独立人工对象默认创建者，超级维护者可调整。
    pub maintainer_id: Option<String>,
    pub source: Source,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    Creator,
    Datasight,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeObjectPrefillStatus {
    pub attempt_id: String,
    pub error_code: Option<String>,
    pub state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeObjectPreparationStatus {
    pub error_code: Option<String>,
    pub revision: String,
    pub source_id: String,
    pub state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeRetrievalClass {
    pub channel: Option<KnowledgeRetrievalChannel>,
    pub excerpts: Vec<KnowledgeRetrievalExcerptElement>,
    pub note: String,
    pub state: KnowledgeRetrievalState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KnowledgeRetrievalChannel {
    Lexical,
    Vector,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeRetrievalExcerptElement {
    pub entry_id: String,
    pub length: i32,
    pub offset: i64,
    pub path: String,
    pub text: String,
    pub total_chars: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KnowledgeRetrievalState {
    #[serde(rename = "index_lag")]
    IndexLag,
    Located,
    Unlocated,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SemanticRelationElement {
    pub citations: Vec<SourceCitationElement>,
    pub origin: Origin,
    pub predicate: Predicate,
    pub relation_id: String,
    pub scope_text: String,
    pub subject: EvidenceRefElement,
    pub target: SemanticReferenceClass,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Predicate {
    Computes,
    #[serde(rename = "derived_from")]
    DerivedFrom,
    Exception,
    Explains,
    Joins,
    Related,
    Requires,
}

/// 平台移除与人工停用分开；重新出现只能恢复平台导致的停用。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StateOrigin {
    Human,
    Platform,
}

/// 独立对象首次创建时自动归属可信登录者；请求不接受负责人字段，后续调整使用独立管理接口。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeCreateClass {
    pub body: String,
    /// 对象自身的显式业务域；省略或空值表示未分类，不从关联对象继承。
    pub business_domain: Option<String>,
    pub kind: KindElement,
    pub name: String,
    pub operation_id: String,
    pub related_ids: Vec<String>,
    pub source_url: Option<String>,
    pub structured_value: Option<KnowledgeEntryQueryExampleStructure>,
}

/// 将同一来源的业务文档按自然章节组合阅读；parts保留原引用身份，编辑时一次提交全部章节。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeDocumentClass {
    pub body: String,
    pub can_edit: bool,
    pub parts: Vec<KnowledgeObjectElement>,
    pub title: String,
}

/// 完整Markdown与完整片段版本集合；服务端逐一授权，正文与后台顺序同事务保存，重复操作返回原回执。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeDocumentEditClass {
    pub body: String,
    pub operation_id: String,
    pub parts: Vec<KnowledgeDocumentEditPart>,
    pub related_ids: Option<Vec<String>>,
    pub source_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeDocumentEditPart {
    pub expected_version: String,
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeEditClass {
    pub clear_override: Option<bool>,
    pub entry_id: String,
    pub expected_version: String,
    pub operation_id: String,
    pub related_ids: Option<Vec<String>>,
    pub source_url: Option<String>,
    /// 本次明确保存的人工陈述及支持提取声明；身份和origin由服务端生成，未提供时不编造完整性。
    pub statements: Option<Vec<HumanStatementInputElement>>,
    pub structured_value: Option<KnowledgeEntryQueryExampleStructure>,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeLineageClass {
    pub downstream: Vec<DownstreamElement>,
    pub more_downstream: bool,
    pub upstream: Vec<DownstreamElement>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownstreamElement {
    pub key_summary: Option<String>,
    pub kind: DownstreamKind,
    pub name: String,
    pub object_id: String,
    pub relationship: Relationship,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DownstreamKind {
    Field,
    Metric,
    Skill,
    Table,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Relationship {
    #[serde(rename = "field_reference")]
    FieldReference,
    #[serde(rename = "metric_query")]
    MetricQuery,
    #[serde(rename = "skill_dependency")]
    SkillDependency,
    #[serde(rename = "table_relation")]
    TableRelation,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeListClass {
    pub next_after_id: Option<String>,
    pub objects: Vec<KnowledgeObjectElement>,
    pub retrieval_mode: String,
    pub search_coverage: Option<SearchCoverageClass>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchCoverageClass {
    /// 本次实际接收的唯一候选记录身份数（有效性筛除与合并前，跨通道跨轮去重累计）；达到candidate_limit即如实报覆盖不足。
    pub candidate_count: Option<i64>,
    pub candidate_limit: i64,
    /// 逐通道有界进度；足够本页结果不表示穷举了该通道。
    pub channels: Option<PurpleChannels>,
    /// 覆盖检查因期限耗尽或读取超时未完成；此时没有已证滞后，不能报index_lag，未覆盖原因以deadline/通道事实表达。
    pub index_check_incomplete: Option<bool>,
    /// 是否实际查到旧投影或漏索引（覆盖检查已完成并确认滞后）。incomplete还可能是检查未完成，见index_check_incomplete；两者不能互相反推。
    pub index_lag: Option<bool>,
    pub index_state: Option<IndexState>,
    /// 候选谓词是否覆盖全部去重检索词项；false时应改写或拆分查询，不能据空结果断言没有资料。
    pub query_terms_complete: Option<bool>,
    pub scope_applied: Option<bool>,
    pub state: SearchCoverageState,
    pub vector_state: Option<VectorState>,
}

/// 逐通道有界进度；足够本页结果不表示穷举了该通道。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PurpleChannels {
    pub dense: DenseClass,
    pub lexical: DenseClass,
    pub raw: Option<DenseClass>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DenseClass {
    pub completed: i64,
    pub exhausted: bool,
    pub rounds: i64,
    pub shards: i64,
    /// 未覆盖原因：停在候选额度、共享期限，或dense因查询嵌入不可用停轮；null且exhausted=true表示该通道已穷举。
    pub uncovered: Option<Uncovered>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Uncovered {
    #[serde(rename = "candidate_limit")]
    CandidateLimit,
    Deadline,
    #[serde(rename = "embedding_unavailable")]
    EmbeddingUnavailable,
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
pub struct KnowledgeListQueryClass {
    pub after_id: Option<String>,
    /// 管理目录按名称和状态分页；maintained按当前负责人关系筛选，包含停用项。省略时保留现有语义检索。
    pub directory: Option<Directory>,
    /// 仅管理目录使用。grouped只分页列出表、指标、整篇文档、查询案例与术语；字段和关系从所属表打开。省略或flat保留全部对象列表。
    pub directory_view: Option<DirectoryView>,
    pub q: Option<String>,
    pub related_id: Option<String>,
    /// 仅用于管理目录；省略时包含启用及停用，始终排除已删除对象。
    pub state: Option<MaintenanceDependentState>,
}

/// 管理目录按名称和状态分页；maintained按当前负责人关系筛选，包含停用项。省略时保留现有语义检索。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Directory {
    All,
    Maintained,
}

/// 仅管理目录使用。grouped只分页列出表、指标、整篇文档、查询案例与术语；字段和关系从所属表打开。省略或flat保留全部对象列表。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DirectoryView {
    Flat,
    Grouped,
}

/// 仅用于管理目录；省略时包含启用及停用，始终排除已删除对象。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MaintenanceDependentState {
    Disabled,
    Enabled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeReadInputClass {
    pub items: Vec<KnowledgeReadItemElement>,
    pub task_ref: Option<EvidenceTaskRefElement>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeReadItemElement {
    pub kind: EvidenceReadResultKind,
    pub limit: Option<i32>,
    pub offset: Option<i32>,
    #[serde(rename = "ref")]
    pub knowledge_read_item_ref: Option<EvidenceRefElement>,
    pub statement_id: Option<String>,
    pub structure_only: Option<bool>,
    /// 独立续读所选条目或陈述的必要支持；limit=0不重传正文，保持原ref、statement_id及structure_only。
    pub supports_cursor: Option<String>,
    pub asset_ref: Option<AssetReadRefClass>,
    pub part: Option<PartEnum>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeReadReplyClass {
    pub items: Vec<EvidenceReadResultElement>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeReadResultClass {
    pub citations: Option<Vec<SourceCitationElement>>,
    pub content: Option<String>,
    pub content_page: Option<ContentPageClass>,
    pub content_state: Option<ContentState>,
    pub continuation: Option<EvidenceContinuationClass>,
    pub effective_structure: Option<KnowledgeEntryQueryExampleStructure>,
    pub kind: KnowledgeReadResultKind,
    #[serde(rename = "ref")]
    pub knowledge_read_result_ref: EvidenceRefElement,
    pub state: EvidenceReadResultState,
    pub statement_id: Option<String>,
    pub structure_coverage: Option<PurpleStructureCoverage>,
    /// 本次实际核定的当前结构表与显式语义依赖；原结构说明及原登记版本保持原值。
    pub structure_dependencies: Option<Vec<EvidenceRefElement>>,
    pub structure_page: Option<ContentPageClass>,
    pub structure_text: Option<String>,
    pub support_state: Option<SupportState>,
    pub supports: Option<Vec<DeliveredSupportElement>>,
    pub supports_complete: Option<bool>,
    pub supports_total: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KnowledgeReadResultKind {
    Knowledge,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeSearchCoverageClass {
    pub channels: Vec<KnowledgeSearchCoverageChannel>,
    /// evidence视图有后页时为宿主生成的短不透明回执引用rc1:<operation_id>，长度不超过96
    /// ASCII字节；宿主只在原成功工具回执持久化完整候选窗口后发布，同操作重放返回同一引用。无后页为null。source_identity视图沿用独立cursor。
    pub next: Option<String>,
    pub reasons: Vec<Reason>,
    pub state: KnowledgeSearchCoverageState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeSearchCoverageChannel {
    pub channel: ChannelChannel,
    pub state: ChannelState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChannelChannel {
    Bm25,
    Dense,
    Exact,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChannelState {
    Available,
    #[serde(rename = "not_configured")]
    NotConfigured,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    #[serde(rename = "candidate_limit")]
    CandidateLimit,
    #[serde(rename = "channel_unavailable")]
    ChannelUnavailable,
    Deadline,
    #[serde(rename = "index_lag")]
    IndexLag,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KnowledgeSearchCoverageState {
    Bounded,
    Searched,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeSearchHitElement {
    pub kind: Option<KindElement>,
    pub name: String,
    pub object_id: Option<String>,
    /// 若有知识对象，这是当前对象版本，不是已读正文引用。
    pub object_version: Option<String>,
    pub record_kind: RecordKind,
    /// 列出的直属对象、表和来源身份是否完整；完整不代表整源符合用户指定范围或已读正文。
    pub roots_complete: Option<bool>,
    pub source_keys: Option<Vec<SourceKeyElement>>,
    pub citations: Option<Vec<SourceCitationElement>>,
    pub content_state: Option<ContentState>,
    pub continuation: Option<EvidenceContinuationClass>,
    pub definition: Option<String>,
    pub example_refs: Option<Vec<EvidenceRefElement>>,
    #[serde(rename = "ref")]
    pub knowledge_search_hit_ref: Option<EvidenceRefElement>,
    pub scope_text: Option<String>,
    pub statement_id: Option<String>,
    pub support_state: Option<SupportState>,
    pub supports: Option<Vec<DeliveredSupportElement>>,
    pub supports_complete: Option<bool>,
    pub citation: Option<SourceCitationElement>,
    pub semantic_status: Option<KnowledgeSearchHitSemanticStatus>,
    pub source_length: Option<i64>,
    pub text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecordKind {
    #[serde(rename = "knowledge_entry")]
    KnowledgeEntry,
    #[serde(rename = "source_excerpt")]
    SourceExcerpt,
    #[serde(rename = "source_identity")]
    SourceIdentity,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KnowledgeSearchHitSemanticStatus {
    Failed,
    Partial,
    Pending,
    Ready,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeSearchInputClass {
    pub asset_after: Option<String>,
    ///
    /// 由evidence视图search_coverage.next返回的短不透明回执引用rc1:<operation_id>，或旧JSON/gzip续读状态；宿主按当前用户/空间/会话从原成功工具回执恢复完整候选窗口，短引用不是读取凭据。保持原查询、kinds、hints、source_selection和任务绑定，asset_after独立推进。source_identity视图沿用独立cursor。
    pub cursor: Option<String>,
    /// 仅用于相关性排序，不扩大或收窄当前权限、kinds及任务来源范围。
    pub hints: Option<HintsClass>,
    pub kinds: Option<Vec<KindElement>>,
    pub limit: Option<i32>,
    pub query: String,
    ///
    /// 仅evidence视图使用的精确原文选择。object_id取source_identity.object_id，version取其object_version；只定位这些当前对象的正式source_facts，不授予知识或结构采用权，也不将对象版本当作来源revision。原文仍核实际SourceKey、来源许可、当前修订、完整性与唯一定位；失败项不妨碍其他合法项。kinds仍筛选所选对象类型，hints仍只排序；不接受客户端quote/path/offset，不退到全文。省略时保持原搜索。
    pub source_selection: Option<Vec<SourceSelectionElement>>,
    pub task_ref: Option<EvidenceTaskRefElement>,
    ///
    /// 省略为evidence取证。source_identity的query按空白分隔名称/ID词，任一词在可读名称或标识中匹配即可返回；单独的*保留目录浏览。只匹配元信息，不解析自然语言、同义词或用户许可，不提供正文/定义/摘录/建议或个人资产，不调用付费语义检索，也不算已读证据或授予正文权限。两种视图的cursor不可互换，身份匹配语义更新后的旧绑定cursor无效。
    pub view: Option<KnowledgeSearchInputView>,
}

/// 仅用于相关性排序，不扩大或收窄当前权限、kinds及任务来源范围。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HintsClass {
    pub business_domain: Option<String>,
    pub related_object_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceSelectionElement {
    pub object_id: String,
    pub version: String,
}

///
/// 省略为evidence取证。source_identity的query按空白分隔名称/ID词，任一词在可读名称或标识中匹配即可返回；单独的*保留目录浏览。只匹配元信息，不解析自然语言、同义词或用户许可，不提供正文/定义/摘录/建议或个人资产，不调用付费语义检索，也不算已读证据或授予正文权限。两种视图的cursor不可互换，身份匹配语义更新后的旧绑定cursor无效。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KnowledgeSearchInputView {
    Evidence,
    #[serde(rename = "source_identity")]
    SourceIdentity,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeSearchReplyClass {
    pub asset_cursor_invalid: bool,
    pub asset_total: i64,
    pub hits: Vec<KnowledgeSearchHitElement>,
    /// 多指标检索中已核验命中的表唯一键和关系关联键摘要。缺项应读取对应表和关系的完整结构。
    pub key_hints: Option<Vec<String>>,
    ///
    /// 个人记忆检索通道：受限任务来源门生效时按资产真实来源过滤，仅无可证明同源记忆时标记excluded_by_source_limits；命中侧过滤事实见回执source_limits块。
    pub memory_retrieval: String,
    pub next_asset_after: Option<String>,
    pub personal_memories: Vec<HashMap<String, Option<serde_json::Value>>>,
    pub search_coverage: KnowledgeSearchCoverageClass,
    pub selected_skills: Vec<HashMap<String, Option<serde_json::Value>>>,
}

/// 旧条件未决的只读投影；索引来自原数组，basis-only旧项用索引0。不授采纳或执行权。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LegacyPendingClass {
    pub condition_version: String,
    pub items: Vec<LegacyPendingItemElement>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LegacyPendingItemElement {
    pub index: i64,
    pub text: Option<String>,
    pub text_unavailable: Option<bool>,
}

/// 客户端已读连续事件区间内的输出片段；指纹只标识缓存内容，不授读取权。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoadedOutputRangeElement {
    pub attempt_id: String,
    pub first_event_seq: String,
    pub last_event_seq: String,
    pub projection_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogoutReceiptClass {
    pub state: LogoutReceiptState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LogoutReceiptState {
    #[serde(rename = "logged_out")]
    LoggedOut,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MaintenanceDependentElement {
    pub can_edit: bool,
    pub id: String,
    pub kind: MaintenanceDependentKind,
    pub name: String,
    pub references: Vec<MaintenanceReferenceElement>,
    pub references_complete: bool,
    pub state: MaintenanceDependentState,
    pub version: String,
    pub visibility: Visibility,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MaintenanceDependentKind {
    Document,
    Field,
    Metric,
    #[serde(rename = "query_example")]
    QueryExample,
    Relationship,
    Skill,
    Table,
    Term,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MaintenanceReferenceElement {
    pub dependent_path: String,
    pub reference_state: ReferenceState,
    pub referenced_path: Option<String>,
    pub referenced_version: Option<String>,
    pub relation_kind: RelationKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReferenceState {
    Current,
    Related,
    Unavailable,
    #[serde(rename = "version_changed")]
    VersionChanged,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RelationKind {
    #[serde(rename = "query_example")]
    QueryExample,
    Related,
    Skill,
    #[serde(rename = "source_material")]
    SourceMaterial,
    Structure,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MaintenanceImpactClass {
    pub items: Vec<MaintenanceDependentElement>,
    pub kind: MaintenanceImpactKind,
    pub next_after_id: Option<String>,
    pub scope: MaintenanceImpactScope,
    pub target: PurpleMaintenanceTarget,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MaintenanceImpactKind {
    Knowledge,
    Skill,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MaintenanceImpactScope {
    #[serde(rename = "direct_explicit_references")]
    DirectExplicitReferences,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PurpleMaintenanceTarget {
    pub object_id: String,
    pub state: MaintenanceDependentState,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MaintenanceImpactQueryClass {
    pub after_id: Option<String>,
    pub expected_version: String,
    pub kind: MaintenanceImpactKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryBudgetBindingClass {
    pub epoch: String,
    pub id: String,
    pub kind: MemoryBudgetBindingKind,
    pub operation_id: String,
    /// run工具绑定真实SDK调用ID；run启动检索与index作业为null，其operation/租约/用途由宿主核对。
    pub sdk_tool_call_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryBudgetBindingKind {
    Index,
    Run,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryCandidateElement {
    pub asset_id: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryExtractionReceiptClass {
    pub body: String,
    pub operation_id: String,
    pub replayed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryExtractionRequestClass {
    pub budget: MemoryBudgetBindingClass,
    pub message: String,
    pub operation_id: String,
    pub owner_id: String,
    /// 修订时由宿主从本人可用的expected_version绑定的旧记忆；只作解析指代和保留未改限定的资料，当前真实指令优先。新建时省略或为null。
    pub previous_memory: Option<MemoryExtractionRequestPreviousMemory>,
    pub quote: String,
    pub space_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryExtractionRequestPreviousMemory {
    pub body: String,
    pub id: String,
    pub scope: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryIndexReceiptClass {
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
pub struct MemoryIndexRequestClass {
    pub asset: AssetElement,
    pub budget: MemoryBudgetBindingClass,
    pub extraction_operation_id: Option<String>,
    pub operation_id: String,
    pub owner_id: String,
    pub space_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryModelCallClass {
    pub action: MemoryModelCallAction,
    pub budget: MemoryBudgetBindingClass,
    pub call_attempt_id: String,
    pub input_tokens_upper: i32,
    pub output_tokens_max: i64,
    pub parameters_fingerprint: String,
    pub purpose: MemoryModelCallPurpose,
    pub usage: Option<ModelUsageClass>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryModelCallAction {
    Finalize,
    Issue,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryModelCallPurpose {
    #[serde(rename = "memory_embedding")]
    MemoryEmbedding,
    #[serde(rename = "memory_extraction")]
    MemoryExtraction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryReadResultClass {
    pub asset: Option<MemoryElement>,
    pub asset_ref: AssetReadRefClass,
    pub kind: MemoryReadResultKind,
    pub part: PartEnum,
    pub state: EvidenceReadResultState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryReadResultKind {
    Memory,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemorySearchReceiptClass {
    pub bounded: bool,
    pub candidates: Vec<MemoryCandidateElement>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemorySearchRequestClass {
    pub budget: MemoryBudgetBindingClass,
    pub operation_id: String,
    pub owner_id: String,
    pub query: String,
    pub space_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageInputClass {
    pub client_message_id: String,
    pub model_selection: Option<ModelSelectionClass>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageReceiptClass {
    pub message_id: String,
    pub request_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelAttemptClass {
    pub call_attempt_id: String,
    pub lease_epoch: String,
    pub run_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelCallReceiptClass {
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
pub struct ModelCatalogClass {
    pub default_selection: Option<ModelSelectionClass>,
    pub models: Vec<ModelOptionElement>,
    pub requires_model: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelOptionElement {
    pub id: String,
    pub label: String,
    pub thinking_options: Vec<ThinkingOptionElement>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThinkingOptionElement {
    pub label: String,
    pub value: ThinkingLevel,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelConfigurationClass {
    pub default_model_id: Option<String>,
    pub models: Vec<ModelDefinitionElement>,
    pub services: Vec<ModelServiceElement>,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelDefinitionElement {
    pub anthropic_thinking_mode: Option<AnthropicThinkingMode>,
    /// 窗口能力来源：SDK目录或管理员声明；目录外型号不猜窗口。
    pub capability_source: Option<CapabilitySource>,
    /// 总上下文tokens；与输入/输出策略分开表达。
    pub context_window: Option<i32>,
    pub default_thinking: ThinkingLevel,
    pub enabled: bool,
    pub id: String,
    pub input_limit: i32,
    pub input_rate: String,
    pub label: String,
    pub model_id: String,
    pub output_limit: i32,
    pub output_rate: String,
    pub payload_bytes_limit: i32,
    pub reasoning_supported: bool,
    /// 单次provider请求超时毫秒，随模型修订冻结；历史缺字段按90000处理。
    pub request_timeout_ms: Option<i32>,
    pub service_id: String,
    pub thinking_levels: Vec<ThinkingLevel>,
    pub version: String,
}

/// 窗口能力来源：SDK目录或管理员声明；目录外型号不猜窗口。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilitySource {
    #[serde(rename = "admin_declared")]
    AdminDeclared,
    #[serde(rename = "sdk_catalog")]
    SdkCatalog,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelServiceElement {
    pub api: Api,
    pub base_url: String,
    pub credential_configured: bool,
    pub enabled: bool,
    pub id: String,
    pub name: String,
    pub provider_id: ProviderId,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderId {
    Anthropic,
    Compatible,
    Deepseek,
    Openai,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelConfigurationAccessClass {
    pub can_manage_models: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelConnectionClass {
    pub api: Api,
    pub api_key: String,
    pub base_url: String,
    pub provider_id: String,
    pub runtime_provider: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelProfileClass {
    /// 省略沿用有限trial；request为正常持续使用，无每消息累计调用上限，累计费用/试用期限不默认拦截。
    pub budget_mode: Option<BudgetMode>,
    /// 窗口能力来源：SDK目录或管理员声明；目录外型号不猜窗口。
    pub capability_source: Option<CapabilitySource>,
    pub configured_model: Option<ConfiguredModelClass>,
    /// 总上下文tokens；与输入/输出策略分开表达。
    pub context_window: Option<i32>,
    pub input_limit: i32,
    pub model_id: String,
    pub output_limit: i32,
    pub payload_bytes_limit: Option<i32>,
    pub price_version: String,
    pub provider_id: String,
    /// 历史兼容字段：旧request scope按每消息24次封顶；正常配置省略，残留值仅保旧解码，不作运行上限。
    pub request_call_limit: Option<i32>,
    /// 单次provider请求超时毫秒，随模型修订冻结；历史缺字段按90000处理。
    pub request_timeout_ms: Option<i32>,
    pub thinking_level: Option<ThinkingLevel>,
    pub toolset: Option<Toolset>,
    pub trial_call_limit: Option<i32>,
    pub trial_cost_micros: Option<String>,
    pub trial_id: String,
}

/// 省略沿用有限trial；request为正常持续使用，无每消息累计调用上限，累计费用/试用期限不默认拦截。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BudgetMode {
    Request,
    Trial,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Toolset {
    Data,
    Task,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelReceiptClass {
    pub state: ModelReceiptState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelReceiptState {
    Issued,
    Settled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MutationReceiptClass {
    pub operation_id: String,
    pub resource_id: String,
    pub state: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperationReceiptClass {
    pub operation_id: String,
    /// 原登记tool行冻结的合同版本，不随当前run变化；历史缺失按1。
    pub tool_contract_version: Option<i64>,
}

/// 每个请求范围恰有一个结果；replace完整替换该范围的assistant事件，空数组仍表示替换。not_available不区分缺失和其他会话。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputProjectionElement {
    pub attempt_id: String,
    pub events: Option<Vec<EventElement>>,
    pub first_event_seq: String,
    pub last_event_seq: String,
    pub output_state: Option<OutputState>,
    pub projection_fingerprint: String,
    pub projection_result: ProjectionResult,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputState {
    Cancelled,
    Committed,
    Interrupted,
    Streaming,
    Superseded,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectionResult {
    #[serde(rename = "not_available")]
    NotAvailable,
    Replace,
    Unchanged,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputReceiptClass {
    pub chunk_seq: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PiSessionReferenceClass {
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
pub struct PrefillResultClass {
    pub entries: Vec<PrefillResultEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrefillResultEntry {
    pub entry_id: String,
    pub evidence: Vec<PurpleEvidence>,
    pub gaps: Vec<String>,
    pub structured_value: Option<KnowledgeEntryQueryExampleStructure>,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PurpleEvidence {
    pub location: String,
    pub quote: String,
    pub source_id: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrepareSkillDraftInputClass {
    /// Skill 的正文及生成资源每行最多 51200 UTF-8 字节；超限须分行保存。记忆不受此行限制。
    pub body: String,
    pub condition_version: String,
    pub evidence_ids: Vec<String>,
    pub files: Vec<SkillFileElement>,
    pub instruction_quote: String,
    pub name: String,
    pub scope: String,
    pub task_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreparedRelationElement {
    pub citations: Vec<SourceCitationElement>,
    pub key: String,
    pub predicate: Predicate,
    pub scope_text: String,
    pub subject: EvidenceRefElement,
    pub target: SemanticReferenceClass,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreparedStatementElement {
    pub citations: Vec<SourceCitationElement>,
    pub key: String,
    pub scope_text: String,
    pub supports: Vec<PreparedSupportElement>,
    /// 对该陈述已记录必要支持提取范围的明确声明；省略或null保留unknown，semantic_status不代替此字段。
    pub supports_complete: Option<bool>,
    pub target: EvidenceRefElement,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresentAnalysisAnswerInputClass {
    pub sources: Vec<AnalysisAnswerSourceElement>,
    /// 解释模板，定量结果用{{name}}引用values；正常语义数字（如零分母说明、年份、编号）可以直写，SQL代码块仍不放模板。定性解释必须有依据，不写未经证实的因果。
    pub template: String,
    pub values: Vec<AnalysisAnswerValueElement>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProposalElement {
    pub base_version: String,
    pub entry_id: String,
    pub evidence: Vec<EvidenceRefElement>,
    pub id: String,
    pub object_id: String,
    pub reason: String,
    pub state: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProposalDraftCommandClass {
    pub base_version: String,
    pub entry_id: String,
    pub evidence: Vec<EvidenceRefElement>,
    pub object_id: String,
    pub operation_id: String,
    pub reason: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProposalInputClass {
    pub base_version: String,
    pub entry_id: String,
    pub evidence: Vec<EvidenceRefElement>,
    pub object_id: String,
    pub reason: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProposalListClass {
    pub proposals: Vec<ProposalElement>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublishSkillClass {
    pub expected_version: String,
    pub operation_id: String,
    pub share_confirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryCancellationClass {
    pub cancel_state: String,
    pub condition_version: String,
    pub execution_state: String,
    pub id: String,
    pub task_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryListClass {
    pub confirmation_blocked: bool,
    pub queries: Vec<QueryViewElement>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryViewElement {
    pub cancel_state: String,
    pub check_state: String,
    pub condition_version: String,
    pub confirmation_state: String,
    pub conversation_id: String,
    pub draft_version: String,
    pub error: Option<String>,
    pub error_details: Option<QueryViewErrorDetails>,
    pub execution_state: String,
    pub id: String,
    pub knowledge_refs: Option<Vec<EvidenceRefElement>>,
    pub parameters: Option<HashMap<String, Option<serde_json::Value>>>,
    pub replaces_query_id: Option<String>,
    pub result_ref: Option<String>,
    /// 草稿工具回执的非阻断诊断；查询读取接口不承诺重现此报告。
    pub semantic_checks: Option<SemanticCheckReportClass>,
    /// 保存草稿时的口径决策及依据；旧记录返回null，不从自由文本或模型历史猜回填。
    pub semantic_resolution: Option<QueryViewQuerySemanticResolution>,
    pub sql: Option<String>,
    pub summary: Option<String>,
    pub target_id: String,
    pub task_id: String,
    /// 正文按历史记录展示：来源已改版或结果已漂移，但记录仍可核。SQL、参数与说明保留原样，不能作为当前口径或执行依据；需要当前数据须重新确认。
    pub text_historical: Option<bool>,
    /// 正文来源失效或无法核实时只返回查询身份和控制状态；SQL、参数、说明、依据及诊断正文均不可返回。
    pub text_unavailable: Option<bool>,
    /// 保存草稿时任务条件声明的时间基准；旧草稿返回null。观察截点与批次是用户声明，不得以request_clock或平台data_freshness冒充。
    pub time_basis: Option<TimeBasisClass>,
    /// 原查询首次query_changed事件的持久序号，作为对话时间线中查询卡的稳定锚点；旧记录无对应事件时为null，旧Schema解码兼容可缺省，前端已有值不被后续有限事件页覆盖。
    pub timeline_event_seq: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryViewErrorDetails {
    pub code: String,
    pub message: String,
}

/// 草稿工具回执的非阻断诊断；查询读取接口不承诺重现此报告。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SemanticCheckReportClass {
    pub checks: Vec<PurpleCheck>,
    pub coverage: PurpleCoverage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PurpleCheck {
    pub coverage_limit: String,
    pub evidence_refs: Vec<SemanticEvidenceRefElement>,
    pub finding: String,
    pub rule: String,
    pub state: CheckState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SemanticEvidenceRefElement {
    pub object_id: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckState {
    Checked,
    #[serde(rename = "not_checked")]
    NotChecked,
    Warning,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PurpleCoverage {
    pub missing_semantics: Vec<String>,
    pub sql_shape: SqlShape,
    pub supported_scope: Vec<String>,
    pub unsupported_constructs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SqlShape {
    Supported,
    Unsupported,
}

/// 草稿保存时从任务当前条件投影的时间基准；统计起止沿time_start/time_end，观察截点/批次只在time_roles中声明。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimeBasisClass {
    pub time_end: Option<String>,
    pub time_roles: Vec<TimeRoleElement>,
    pub time_start: Option<String>,
    pub timezone: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResultCellReadClass {
    pub column: ResultColumnElement,
    pub column_index: i64,
    pub query_id: String,
    pub result_ref: String,
    pub row_index: i64,
    pub value: Option<String>,
    pub view: QueryResultCellReadView,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QueryResultCellReadView {
    Cell,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResultContentClass {
    pub content_format: ContentFormat,
    pub content_page: PurpleQueryResultContentRange,
    pub content_text: String,
    pub query_id: String,
    pub result_ref: String,
    pub view: AgentQueryResultsView,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResultStatisticsReadClass {
    pub fetched_offset: String,
    pub next_cursor: Option<String>,
    pub query_id: String,
    pub result_ref: String,
    pub saved_result_complete: bool,
    pub saved_row_count: i64,
    pub statistics: ResultStatisticsClass,
    pub truncated: bool,
    pub view: QueryResultStatisticsReadView,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QueryResultStatisticsReadView {
    Statistics,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadAnalysisReportInputClass {
    pub limit: Option<i32>,
    pub offset: Option<i32>,
    pub task_id: String,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadCheckpointClass {
    pub lease_epoch: String,
    pub run_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadKnowledgeInputClass {
    ///
    /// 知识条目ID；个人记忆省略时读取正文，scope读取范围，source_text读取来源原话，分别检查content_page/scope_page/source_page并按同一version续读。
    pub entry_id: Option<String>,
    pub limit: Option<i32>,
    pub object_id: String,
    pub offset: Option<i32>,
    pub structure_only: Option<bool>,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadModelConnectionClass {
    pub lease_epoch: String,
    pub run_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadQueryInputClass {
    pub cursor: Option<String>,
    pub query_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadSourceInputClass {
    pub limit: Option<i32>,
    pub offset: Option<i32>,
    /// 原始来源ID或document-加知识文档ID的保留别名；文档仍按当前空间、状态和版本校验。
    pub source_id: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadTaskInputClass {
    /// 按回执next_clarification_after继续读取未决问题；省略从第一页开始。
    pub clarification_after: Option<String>,
    /// 省略读取当前条件；指定时读取该任务真实历史快照及其依据，不授予执行权。
    pub condition_version: Option<String>,
    pub task_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RefreshRunContextClass {
    pub checkpoint: CheckpointClass,
    pub lease_epoch: String,
    pub run_id: String,
    pub sdk_tool_call_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestQueryInputClass {
    pub condition_version: String,
    pub knowledge_refs: Vec<EvidenceRefElement>,
    pub parameters: HashMap<String, Option<serde_json::Value>>,
    pub replaces_query_id: Option<String>,
    /// 省略继承目标条件版本已有采纳说明；兼容携带只核同义声明，不能独立另作决定。新任务未决定时登记clarifications，改变解释先同次修订条件。旧形状仅沿旧格式兼容。
    pub semantic_resolution: Option<SemanticResolutionClass>,
    pub sql: String,
    pub summary: String,
    pub target_id: TargetId,
    pub task_id: String,
}

/// 旧未决形状与新采纳说明仅在兼容边界解码；实际条件格式由宿主decision_state_version决定。
///
/// 省略继承目标条件版本已有采纳说明；兼容携带只核同义声明，不能独立另作决定。新任务未决定时登记clarifications，改变解释先同次修订条件。旧形状仅沿旧格式兼容。
///
///
/// 新格式仅记录已经采用的解释。explicit_user引用本轮完整原话，null/省略采纳身份由宿主绑定；原已核对象可同文继承。未决只登记clarifications，无问题且条件充分时不要求本对象。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SemanticResolutionClass {
    ///
    /// explicit_user：null=本轮新采纳，由宿主核对user_quote为本轮完整原话后绑定真实消息身份；非空=复制继承原已验证决策的消息身份，不接受模型自由填写。其余basis为null。
    pub adoption_message_id: Option<String>,
    /// 真实用户明确选择、确无实质歧义、或仍需澄清；资料支持某公式不等于用户选择它。
    pub basis: SemanticResolutionBasis,
    /// 支撑该口径决策的依据引用；旧调用缺失按空数组解码。
    pub evidence_refs: Option<Vec<EvidenceRefElement>>,
    /// 本稿采用的指标、分子/分母、时间等关键口径及选择依据；不能把自己刚写入任务的假设当作用户采用。
    pub interpretation: String,
    /// 仍会改变答案且未获选择的分子、分母、时间归属等差异；有差异必须先澄清，不能默认写稿。
    pub unresolved_differences: Option<Vec<String>>,
    /// explicit_user逐字填写本条真实用户完整原话，保留否定、前提、例外和换行，不截取子串；其余为null。
    pub user_quote: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReserveModelCallClass {
    pub call_attempt_id: String,
    pub input_tokens_upper: i32,
    pub lease_epoch: String,
    pub output_tokens_max: i32,
    pub parameters_fingerprint: String,
    pub run_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewSemanticCorrectionClass {
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
pub struct ReviewSkillSuggestionClass {
    pub expected_revision: String,
    pub operation_id: String,
    pub response: String,
    pub state: ReviewSkillSuggestionState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewSkillSuggestionState {
    Handled,
    Rejected,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviseSemanticCorrectionClass {
    pub base_version: String,
    pub entry_id: String,
    pub evidence: Vec<EvidenceRefElement>,
    pub expected_revision: String,
    pub object_id: String,
    pub operation_id: String,
    pub reason: String,
    pub share_confirmed: bool,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunEnvelopeClass {
    pub answer_parts: Option<Vec<AnswerPartReferenceElement>>,
    pub attempt_id: String,
    pub budget_scope_id: String,
    pub checkpoint: Option<CheckpointClass>,
    pub conversation_id: String,
    pub lease_epoch: String,
    pub message_id: String,
    pub model_profile: Option<ModelProfileClass>,
    pub output_id: String,
    pub recovery_chain_id: String,
    pub request_clock: Option<RequestClockClass>,
    pub request_id: String,
    pub resume_same_input: Option<bool>,
    pub run_id: String,
    pub text: String,
    /// 宿主冻结的工具合同版本；历史缺失按1恢复。
    pub tool_contract_version: Option<i64>,
    pub workspace_context: Option<WorkspaceContextClass>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceContextClass {
    /// 会话持久活动取证任务：一次派发只绑定一个活动任务，受限读取与轮内重投影由此继承；null表示尚无活动任务。
    pub active_task_ref: Option<PurpleActiveTaskRef>,
    pub asset_counts: Option<PurpleAssetCounts>,
    pub authority_revision: String,
    pub authority_snapshot: Option<HashMap<String, Option<serde_json::Value>>>,
    pub control_delivery: Option<ControlDeliveryClass>,
    /// 启动/恢复/刷新时，宿主按原通知条件scope核验已冻结答案的覆盖事实。缺省不证明已覆盖，不能凭query_id命中扩大通知范围。
    pub frozen_notification_covered: Option<bool>,
    /// 当前输入的持久全部任务归属；恢复时按当前lifecycle继续剩余目标。
    pub input_task_ids: Option<Vec<String>>,
    pub memories: Vec<MemoryElement>,
    ///
    /// 个人记忆注入通道：mem0_authoritative按Mem0召回注入，directory_fallback为Mem0不可用退回目录。受限任务来源门生效时按资产真实来源过滤后仍注入同源记忆，仅无可证明同源资产或来源范围未知时不注入并标记excluded_by_source_limits；与search_knowledge回执中的同值口径一致。
    pub memory_retrieval: Option<MemoryRetrieval>,
    pub query_observations: Vec<HashMap<String, Option<serde_json::Value>>>,
    pub recent_messages: Vec<ChatMessageElement>,
    pub request_clock: Option<RequestClockClass>,
    /// 宿主查询终态通知身份；普通用户消息省略，不从文字前缀推断成功。
    pub result_notification: Option<PurpleResultNotification>,
    pub selected_skills: Vec<MemoryElement>,
    /// 与本快照source_context_ready同次计算的未就绪原因；仅控制信息，不含来源正文。就绪时省略，旧快照缺省仍沿原准入行为。
    pub source_context_blocker: Option<SourceContextBlocker>,
    ///
    /// 当前输入已归属且来源范围可确定，才可将证据正文交给模型。false时只提供用户原话及控制/来源身份元信息，保留同一Pi会话而暂不发送旧资料正文。v2派发和刷新由宿主计算；旧v1缺省不改变原行为。
    pub source_context_ready: Option<bool>,
    pub tasks: Vec<WorkspaceTaskElement>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PurpleActiveTaskRef {
    pub condition_version: String,
    pub task_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PurpleAssetCounts {
    pub memories: i64,
    pub selected_skills: i64,
}

///
/// 个人记忆注入通道：mem0_authoritative按Mem0召回注入，directory_fallback为Mem0不可用退回目录。受限任务来源门生效时按资产真实来源过滤后仍注入同源记忆，仅无可证明同源资产或来源范围未知时不注入并标记excluded_by_source_limits；与search_knowledge回执中的同值口径一致。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryRetrieval {
    #[serde(rename = "directory_fallback")]
    DirectoryFallback,
    #[serde(rename = "excluded_by_source_limits")]
    ExcludedBySourceLimits,
    #[serde(rename = "mem0_authoritative")]
    Mem0Authoritative,
}

/// 宿主查询终态通知身份；普通用户消息省略，不从文字前缀推断成功。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PurpleResultNotification {
    pub execution_state: ResultNotificationExecutionState,
    pub query_id: String,
    /// 原查询所属任务和条件版本，由宿主绑定；恢复已切任务时不依赖最近查询观察窗口。旧通知缺字段沿原兼容路径读取。
    pub task_ref: Option<EvidenceTaskRefElement>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResultNotificationExecutionState {
    Cancelled,
    Failed,
    Succeeded,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceTaskElement {
    pub decision_state_version: Option<i64>,
    pub evidence_refs: Option<Vec<AnalysisEvidenceRefElement>>,
    pub legacy_pending: Option<LegacyPendingClass>,
    pub report_ref: Option<AnalysisReportRefClass>,
    pub revision_origin: Option<RevisionOriginClass>,
}

/// 显式读取旧条件版本时接回的真实成功修订出处；原话只说明来源，不自动证明采纳或授执行权。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RevisionOriginClass {
    pub message_id: String,
    pub operation_id: String,
    pub origin_run_id: String,
    pub user_quote: Option<String>,
    pub user_supplied: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunSnapshotElement {
    /// 运行中run最近一次已登记工具调用的中文动作提示，由服务端映射工具名生成；无工具调用的旧记录缺省。
    pub activity_label: Option<String>,
    /// 本run当前生成尝试身份，用于识别正文增量归属；旧快照可缺省。
    pub attempt_id: Option<String>,
    /// 已完成的工具动作、当前可读对象名称与真实耗时。仅作界面进度提示。
    pub completed_step_summaries: Option<Vec<CompletedStepSummaryElement>>,
    /// 该run已成功回执的工具调用计数；旧记录缺省。仅作进度展示，不作为执行依据。
    pub completed_steps: Option<i32>,
    pub lease_epoch: String,
    /// 来自已有持久记录的触发消息身份；旧快照可缺省。
    pub message_id: Option<String>,
    /// user_request为用户消息触发；query_result为查询结果通知触发。旧快照可缺省，缺省时按中性处理提示展示。
    pub purpose: Option<RunSnapshotPurpose>,
    /// 结果通知run关联的原查询ID，来自conversations可信server:query-result消息关联；仅purpose=query_result时非null。
    pub result_query_id: Option<String>,
    pub run_id: String,
    pub state: RunSnapshotState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompletedStepSummaryElement {
    pub category: String,
    pub duration_ms: i64,
    pub target_name: Option<String>,
}

/// user_request为用户消息触发；query_result为查询结果通知触发。旧快照可缺省，缺省时按中性处理提示展示。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunSnapshotPurpose {
    #[serde(rename = "query_result")]
    QueryResult,
    #[serde(rename = "user_request")]
    UserRequest,
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
pub struct SaveAnalysisEvidenceInputClass {
    pub condition_version: String,
    pub data_range: String,
    pub findings: Vec<AnalysisFindingElement>,
    pub task_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveAnalysisReportClass {
    pub charts: Vec<AnalysisReportChartElement>,
    pub condition_version: String,
    pub evidence_ids: Vec<String>,
    pub expected_version: Option<String>,
    pub operation_id: String,
    pub task_id: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveAnalysisReportInputClass {
    pub charts: Vec<AnalysisReportChartElement>,
    pub condition_version: String,
    pub evidence_ids: Vec<String>,
    pub expected_version: Option<String>,
    pub task_id: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveDefaultModelClass {
    pub expected_version: String,
    pub model_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveModelDefinitionClass {
    pub anthropic_thinking_mode: Option<AnthropicThinkingMode>,
    /// 窗口能力来源：SDK目录或管理员声明；目录外型号不猜窗口。
    pub capability_source: CapabilitySource,
    /// 总上下文tokens；与输入/输出策略分开表达。
    pub context_window: i32,
    pub default_thinking: ThinkingLevel,
    pub enabled: bool,
    pub expected_version: String,
    pub id: String,
    pub input_limit: i32,
    pub input_rate: String,
    pub label: String,
    pub model_id: String,
    pub output_limit: i32,
    pub output_rate: String,
    pub payload_bytes_limit: i32,
    pub reasoning_supported: bool,
    /// 单次provider请求超时毫秒，随模型修订冻结；历史缺字段按90000处理。
    pub request_timeout_ms: i32,
    pub service_id: String,
    pub thinking_levels: Vec<ThinkingLevel>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveModelSelectionClass {
    pub expected_version: String,
    pub selection: ModelSelectionClass,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveModelServiceClass {
    pub api: Api,
    pub api_key: Option<String>,
    pub base_url: String,
    pub enabled: bool,
    pub expected_version: String,
    pub id: String,
    pub name: String,
    pub provider_id: ProviderId,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchInputClass {
    pub asset_after: Option<String>,
    pub business_domain: Option<String>,
    pub kinds: Option<Vec<KindElement>>,
    pub limit: Option<i32>,
    pub query: String,
    pub related_object_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SemanticAccessClass {
    pub can_admin: bool,
    /// 可创建独立指标、文档等；由当前空间已同步的 Datasight 表维护关系或超级维护者角色确定。
    pub can_create: bool,
    /// 当前空间用于展示的最高语义角色。超级维护者优先；负责表或独立语义对象则为维护者；其余为普通用户。该摘要不授予权限，独立对象负责人不一定有创建资格。
    pub highest_role: HighestRole,
}

/// 当前空间用于展示的最高语义角色。超级维护者优先；负责表或独立语义对象则为维护者；其余为普通用户。该摘要不授予权限，独立对象负责人不一定有创建资格。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HighestRole {
    Maintainer,
    #[serde(rename = "super_maintainer")]
    SuperMaintainer,
    User,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SemanticColumnRefClass {
    pub column: String,
    pub object_id: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SemanticCorrectionElement {
    /// Datasight 维护人；未提供或 null 表示暂无负责人，不继承录入者。
    pub applied_by: Option<String>,
    pub applied_value: Option<String>,
    pub applied_version: Option<String>,
    pub base_version: String,
    pub can_review: bool,
    pub can_revise: bool,
    pub entry_id: String,
    pub evidence: Vec<EvidenceRefElement>,
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
pub struct SemanticCorrectionListClass {
    pub corrections: Vec<SemanticCorrectionElement>,
    pub next_after_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SemanticMemberListClass {
    pub user_ids: Vec<String>,
}

pub type SemanticStructureClass = SemanticStructure;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendModelCallClass {
    pub call_attempt_id: String,
    pub lease_epoch: String,
    pub parameters_fingerprint: String,
    pub run_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionReceiptClass {
    pub model_label: ModelLabel,
    pub space_id: String,
    /// 空间显示名，由部署配置下发；与space_id分开，不参与授权判断。
    pub space_name: String,
    pub state: SessionReceiptState,
    pub user_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionReceiptState {
    Authenticated,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillDraftElement {
    /// Skill 的正文及生成资源每行最多 51200 UTF-8 字节；超限须分行保存。记忆不受此行限制。
    pub body: Option<String>,
    pub created_at: Option<String>,
    pub dependencies: Option<Vec<EvidenceRefElement>>,
    pub evidence_refs: Option<Vec<AnalysisEvidenceRefElement>>,
    pub files: Option<Vec<SkillFileElement>>,
    pub name: Option<String>,
    pub reference: SkillDraftRefClass,
    pub scope: Option<String>,
    pub status: SkillDraftStatus,
    pub asset_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillDraftRefClass {
    pub condition_version: String,
    pub conversation_id: String,
    pub draft_id: String,
    pub source_message_id: String,
    pub task_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillDraftStatus {
    #[serde(rename = "condition_changed")]
    ConditionChanged,
    Confirmed,
    Pending,
    #[serde(rename = "sources_unavailable")]
    SourcesUnavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillDraftListClass {
    pub drafts: Vec<SkillDraftElement>,
    pub next_after_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillReadInputClass {
    pub limit: Option<i32>,
    pub offset: Option<i32>,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillReadResultClass {
    pub asset: Option<MemoryElement>,
    pub asset_ref: AssetReadRefClass,
    pub kind: SkillReadResultKind,
    pub state: EvidenceReadResultState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillReadResultKind {
    Skill,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillRemovalReceiptClass {
    pub asset_id: String,
    pub conversation_id: String,
    pub operation_id: String,
    pub selection_id: String,
    pub state: SkillRemovalReceiptState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillRemovalReceiptState {
    Removed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillSelectionClass {
    pub asset_id: String,
    pub operation_id: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillSelectionRemovalClass {
    pub asset_id: String,
    pub operation_id: String,
    pub selection_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillSuggestionElement {
    pub asset_id: String,
    pub asset_version: String,
    pub author_id: String,
    pub content: String,
    pub id: String,
    pub response: String,
    pub reviewed_by: Option<String>,
    pub revision: String,
    pub state: SkillSuggestionState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillSuggestionState {
    Handled,
    Pending,
    Rejected,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillSuggestionListClass {
    pub next_after_id: Option<String>,
    pub suggestions: Vec<SkillSuggestionElement>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotClass {
    pub conversation_id: String,
    pub events: Vec<EventElement>,
    pub first_event_seq: Option<String>,
    pub has_newer: Option<bool>,
    pub has_older: Option<bool>,
    pub last_event_seq: Option<String>,
    pub messages: Vec<ChatMessageElement>,
    pub runs: Vec<RunSnapshotElement>,
    pub tasks: Vec<TaskSnapshotElement>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskSnapshotElement {
    pub condition_version: String,
    pub evidence_refs: Option<Vec<AnalysisEvidenceRefElement>>,
    pub goal: Option<String>,
    pub id: String,
    pub lifecycle: Option<String>,
    pub note: Option<String>,
    pub phase: Option<String>,
    pub report_ref: Option<AnalysisReportRefClass>,
    pub report_timeline_event_seq: Option<String>,
    pub text_unavailable: Option<bool>,
}

/// POST snapshot独立响应；普通分页游标与已加载输出的权限投影分开，旧GET Snapshot形状保持。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotRefreshClass {
    pub conversation_id: String,
    pub events: Vec<EventElement>,
    pub first_event_seq: Option<String>,
    pub has_newer: Option<bool>,
    pub has_older: Option<bool>,
    pub last_event_seq: Option<String>,
    pub messages: Vec<ChatMessageElement>,
    pub output_projections: Vec<OutputProjectionElement>,
    pub runs: Vec<RunSnapshotElement>,
    pub tasks: Vec<TaskSnapshotElement>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotRequestClass {
    pub after_seq: Option<String>,
    pub before_seq: Option<String>,
    pub loaded_outputs: Vec<LoadedOutputRangeElement>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceDocumentClass {
    pub body: String,
    pub complete: bool,
    pub current_version: String,
    pub source_id: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceExcerptClass {
    pub citation: SourceCitationElement,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourcePreparationResultClass {
    pub relations: Vec<PreparedRelationElement>,
    pub semantic_status: SourcePreparationResultSemanticStatus,
    pub statements: Vec<PreparedStatementElement>,
    pub unresolved: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourcePreparationResultSemanticStatus {
    Partial,
    Ready,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceReadInputClass {
    pub citation: SourceCitationElement,
    pub limit: Option<i32>,
    pub task_ref: Option<EvidenceTaskRefElement>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceReadReplyClass {
    pub content_state: ContentState,
    pub locator: SourceLocatorClass,
    pub next_locator: Option<SourceLocatorClass>,
    pub revision: String,
    pub source: SourceKeyElement,
    pub source_length: i64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceSyncAcceptedClass {
    pub status: SourceSyncAcceptedStatus,
    pub status_url: String,
    pub sync_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceSyncAcceptedStatus {
    Completed,
    Failed,
    Queued,
    Running,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceSyncProgressClass {
    pub error_code: Option<String>,
    /// 已持久化的可展示失败说明，例如来源的实际大小和上限；旧批次可缺省。
    pub error_message: Option<String>,
    pub knowledge_index: SourceWorkProgressClass,
    pub pages_committed: i64,
    pub preparation: SourceWorkProgressClass,
    pub processed_sources: i64,
    pub raw_index: SourceWorkProgressClass,
    pub status: SourceSyncAcceptedStatus,
    pub status_url: String,
    pub sync_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceWorkProgressClass {
    pub completed: i64,
    pub failed: i64,
    pub status: SourceWorkProgressStatus,
    pub total: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceWorkProgressStatus {
    Completed,
    Failed,
    #[serde(rename = "not_required")]
    NotRequired,
    Pending,
    Running,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SqlInputClass {
    pub knowledge_refs: Option<Vec<EvidenceRefElement>>,
    pub parameters: HashMap<String, Option<serde_json::Value>>,
    pub sql: String,
    pub target_id: TargetId,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubmitSemanticCorrectionClass {
    pub base_version: String,
    pub entry_id: String,
    pub evidence: Vec<EvidenceRefElement>,
    pub object_id: String,
    pub operation_id: String,
    pub reason: String,
    pub share_confirmed: bool,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SuggestSkillClass {
    pub content: String,
    pub expected_version: String,
    pub operation_id: String,
    pub share_confirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskInputClass {
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
pub struct ToolInvocationClass {
    pub arguments: TaskInputClass,
    pub checkpoint: CheckpointClass,
    pub lease_epoch: String,
    pub run_id: String,
    pub sdk_tool_call_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolOutcomeClass {
    pub receipt: Option<ToolReceiptClass>,
    #[serde(rename = "type")]
    pub tool_outcome_type: ToolOutcomeType,
    pub error: Option<AppErrorClass>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolReceiptClass {
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
pub struct VersionCommandClass {
    pub expected_version: String,
    pub operation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkbenchUpdateClass {
    pub query_list: Option<QueryListClass>,
    pub runs: Option<Vec<RunSnapshotElement>>,
    pub tasks: Option<Vec<TaskSnapshotElement>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunStepList {
    pub steps: Vec<RunStepSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunStepSummary {
    pub category: String,
    pub duration_ms: i64,
    pub target_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeLineage {
    pub downstream: Vec<KnowledgeLineageEdge>,
    pub more_downstream: bool,
    pub upstream: Vec<KnowledgeLineageEdge>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeLineageEdge {
    pub key_summary: Option<String>,
    pub kind: DownstreamKind,
    pub name: String,
    pub object_id: String,
    pub relationship: Relationship,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateConversation {
    pub operation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageInput {
    pub client_message_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_selection: Option<ModelSelection>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelSelection {
    pub model_id: String,
    pub thinking_level: ThinkingLevel,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunEnvelope {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answer_parts: Option<Vec<AnswerPartReference>>,
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
    /// 宿主冻结的工具合同版本；历史缺失按1恢复。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_contract_version: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_context: Option<WorkspaceContext>,
}

///
/// 有序原内容引用。已定稿项只携宿主控制身份和实际source_query_ids，不凭ID命中判断通知scope覆盖；有新末项时引用原输出或成功答案回执。数量还须受实际消息任务集合约束，不增加模型额度。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnswerPartReference {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answer_sdk_tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finalized_by_sdk_tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_binding: Option<AssistantOutputBinding>,
    /// 未冻结末项的渲染正文分支；与output_binding、answer_sdk_tool_call_id互斥。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rendered_answer_binding: Option<RenderedAnswerBinding>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope_fingerprint: Option<String>,
    /// 定稿答案成功回执实际核验的query_id集合；只标识实际来源，不证明符合通知原scope，通知覆盖由宿主另行核验。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_query_ids: Option<Vec<String>>,
    pub task_ref: EvidenceTaskRef,
}

/// 宿主从Pi完整助手条目绑定，正文位置来自已确认输出队列；模型不能提供这些字段。
///
/// 原Pi entry/attempt/stop/tool
/// IDs与source_text的SHA256；本分支禁止携带first/last_chunk_seq，展示范围由外层字段表达。
///
///
/// 宿主确认的正常完整自然final原输出绑定；恢复时保原attempt/entry/片段。须有final_text，与answer_parts、answer_sdk_tool_call_id、control_delivery_ref及final_start_chunk_seq互斥。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssistantOutputBinding {
    pub attempt_id: String,
    pub entry_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_chunk_seq: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_chunk_seq: Option<String>,
    pub stop_reason: StopReason,
    pub text_sha256: String,
    pub tool_call_ids: Vec<String>,
}

/// 宿主生成的一次渲染绑定：原文、原prepare回执与展示片段范围；模型不能提供这些字段。
///
/// 渲染正文交接分支；与顶层assistant互斥。当前冻结route所在原assistant允许toolUse，tool_call_ids只含本次route。
///
/// 未冻结末项的渲染正文分支；与output_binding、answer_sdk_tool_call_id互斥。
///
///
/// 单份渲染正文分支：final_text为该份display（非模板、非整轮组合全文），与answer_parts、answer_sdk_tool_call_id、control_delivery_ref、output_binding及final_start_chunk_seq互斥。组合时改用answer_parts末项的rendered分支，不传顶层rendered。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenderedAnswerBinding {
    /// 原Pi entry/attempt/stop/tool
    /// IDs与source_text的SHA256；本分支禁止携带first/last_chunk_seq，展示范围由外层字段表达。
    pub assistant: AssistantOutputBinding,
    /// 已持久化展示片段范围；display = replace_once(source_text, bindings) + required_suffix。
    pub first_chunk_seq: String,
    pub last_chunk_seq: String,
    /// 本条正文实际采用的原prepare_analysis_answer成功回执；不因分支上后来存在新prepare而改用最近一份。
    pub prepared_sdk_tool_call_id: String,
    /// 原Pi完整正文（含{{name}}标记），来自Node宿主SessionManager原assistant entry；不是展示替换后的文字。Rust边界核对其UTF-8
    /// SHA256。
    pub source_text: String,
}

/// 原查询所属任务和条件版本，由宿主绑定；恢复已切任务时不依赖最近查询观察窗口。旧通知缺字段沿原兼容路径读取。
///
/// 成功答案的原工具登记归属，来自宿主task_id/task_condition_version；与实际sources和通知交付目标分开，不改原回执存储字节。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvidenceTaskRef {
    pub condition_version: String,
    pub task_id: String,
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
pub struct ModelProfile {
    /// 省略沿用有限trial；request为正常持续使用，无每消息累计调用上限，累计费用/试用期限不默认拦截。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub budget_mode: Option<BudgetMode>,
    /// 窗口能力来源：SDK目录或管理员声明；目录外型号不猜窗口。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capability_source: Option<CapabilitySource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub configured_model: Option<ConfiguredModel>,
    /// 总上下文tokens；与输入/输出策略分开表达。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<i32>,
    pub input_limit: i32,
    pub model_id: String,
    pub output_limit: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload_bytes_limit: Option<i32>,
    pub price_version: String,
    pub provider_id: String,
    /// 历史兼容字段：旧request scope按每消息24次封顶；正常配置省略，残留值仅保旧解码，不作运行上限。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_call_limit: Option<i32>,
    /// 单次provider请求超时毫秒，随模型修订冻结；历史缺字段按90000处理。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_timeout_ms: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<ThinkingLevel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub toolset: Option<Toolset>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trial_call_limit: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trial_cost_micros: Option<String>,
    pub trial_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfiguredModel {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anthropic_thinking_mode: Option<AnthropicThinkingMode>,
    pub api: Api,
    pub id: String,
    pub input_rate: String,
    pub output_rate: String,
    pub reasoning_supported: bool,
    pub service_id: String,
    pub service_version: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestClock {
    pub business_timezone: BusinessTimezone,
    pub reference_time_utc: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceContext {
    /// 会话持久活动取证任务：一次派发只绑定一个活动任务，受限读取与轮内重投影由此继承；null表示尚无活动任务。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_task_ref: Option<FluffyActiveTaskRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_counts: Option<FluffyAssetCounts>,
    pub authority_revision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authority_snapshot: Option<HashMap<String, Option<serde_json::Value>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub control_delivery: Option<ControlDelivery>,
    /// 启动/恢复/刷新时，宿主按原通知条件scope核验已冻结答案的覆盖事实。缺省不证明已覆盖，不能凭query_id命中扩大通知范围。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frozen_notification_covered: Option<bool>,
    /// 当前输入的持久全部任务归属；恢复时按当前lifecycle继续剩余目标。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_task_ids: Option<Vec<String>>,
    pub memories: Vec<ModelAssetPreview>,
    ///
    /// 个人记忆注入通道：mem0_authoritative按Mem0召回注入，directory_fallback为Mem0不可用退回目录。受限任务来源门生效时按资产真实来源过滤后仍注入同源记忆，仅无可证明同源资产或来源范围未知时不注入并标记excluded_by_source_limits；与search_knowledge回执中的同值口径一致。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_retrieval: Option<MemoryRetrieval>,
    pub query_observations: Vec<HashMap<String, Option<serde_json::Value>>>,
    pub recent_messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_clock: Option<RequestClock>,
    /// 宿主查询终态通知身份；普通用户消息省略，不从文字前缀推断成功。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_notification: Option<FluffyResultNotification>,
    pub selected_skills: Vec<ModelAssetPreview>,
    /// 与本快照source_context_ready同次计算的未就绪原因；仅控制信息，不含来源正文。就绪时省略，旧快照缺省仍沿原准入行为。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_context_blocker: Option<SourceContextBlocker>,
    ///
    /// 当前输入已归属且来源范围可确定，才可将证据正文交给模型。false时只提供用户原话及控制/来源身份元信息，保留同一Pi会话而暂不发送旧资料正文。v2派发和刷新由宿主计算；旧v1缺省不改变原行为。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_context_ready: Option<bool>,
    pub tasks: Vec<WorkspaceTask>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FluffyActiveTaskRef {
    pub condition_version: String,
    pub task_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FluffyAssetCounts {
    pub memories: i64,
    pub selected_skills: i64,
}

///
/// 宿主按持久任务/查询事实生成的短控制交付；只覆盖已保存、已提交、等待结果和已持久澄清，不代表分析完成。text_authority只记录实际展示文字的来源；旧回执缺省时沿原任务字段来源核验，不能当作空来源。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControlDelivery {
    pub facts: Vec<ControlDeliveryFact>,
    pub fingerprint: String,
    pub task_refs: Vec<EvidenceTaskRef>,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_authority: Option<HashMap<String, Option<serde_json::Value>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControlDeliveryFact {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clarification_id: Option<String>,
    pub condition_version: String,
    #[serde(
        default,
        deserialize_with = "deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub confirmation_state: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_state: Option<FactExecutionState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_more: Option<bool>,
    pub kind: FactKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question: Option<String>,
    pub task_id: String,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_id: Option<String>,
    pub scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope_page: Option<ContentPage>,
    pub selected: bool,
    /// 来源原话的独立字符分页。缺省source_text为空但保留总长和补读位置；以entry_id=source_text和同一资产版本读取。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_page: Option<ContentPage>,
    pub source_text: String,
    pub state: MemoryState,
    pub verified: bool,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visibility: Option<Visibility>,
}

/// 来源原话的独立字符分页。缺省source_text为空但保留总长和补读位置；以entry_id=source_text和同一资产版本读取。
///
/// 支持正文自己的Unicode字符页；游标仍沿supports_next_cursor继续。同一支持的尾页不代表本回执已包含整条支持。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContentPage {
    pub complete: bool,
    pub next_offset: Option<i64>,
    pub offset: i64,
    pub total_chars: i64,
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
    pub role: ChatMessageRole,
    pub text: String,
}

/// 宿主查询终态通知身份；普通用户消息省略，不从文字前缀推断成功。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FluffyResultNotification {
    pub execution_state: ResultNotificationExecutionState,
    pub query_id: String,
    /// 原查询所属任务和条件版本，由宿主绑定；恢复已切任务时不依赖最近查询观察窗口。旧通知缺字段沿原兼容路径读取。
    pub task_ref: Option<EvidenceTaskRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceTask {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision_state_version: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence_refs: Option<Vec<AnalysisEvidenceRef>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub legacy_pending: Option<LegacyPending>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report_ref: Option<AnalysisReportRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision_origin: Option<LegacyRevisionOrigin>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisEvidenceRef {
    pub condition_version: String,
    pub conversation_id: String,
    pub evidence_id: String,
    pub result_dependencies: Vec<AnalysisResultDependency>,
    pub task_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisResultDependency {
    pub query_id: String,
    pub result_ref: String,
}

/// 旧条件未决的只读投影；索引来自原数组，basis-only旧项用索引0。不授采纳或执行权。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LegacyPending {
    pub condition_version: String,
    pub items: Vec<LegacyPendingItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LegacyPendingItem {
    pub index: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_unavailable: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisReportRef {
    pub condition_version: String,
    pub conversation_id: String,
    pub report_id: String,
    pub task_id: String,
    pub version: String,
}

/// 显式读取旧条件版本时接回的真实成功修订出处；原话只说明来源，不自动证明采纳或授执行权。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LegacyRevisionOrigin {
    pub message_id: String,
    pub operation_id: String,
    pub origin_run_id: String,
    pub user_quote: Option<String>,
    pub user_supplied: bool,
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
pub struct TaskInput {
    pub action: TaskInputAction,
    pub goal: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppendOutput {
    pub chunk_seq: String,
    pub lease_epoch: String,
    pub run_id: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FinishRun {
    ///
    /// 完整有序引用。存在新末项时final_text核对其原文；原消息其余任务均已取消或由可见任务卡/宿主控制交付解释且有效任务已冻结时，可只发冻结引用并省略final_text。单份正文仍限8000字符；多份组合由实际项数、标题和分隔格式推导，上限384281字符。Rust核当前任务集合与来源后取原内容组合。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answer_parts: Option<Vec<AnswerPartReference>>,
    /// 使用present_analysis_answer成功回执交付时绑定该SDK调用，正文须与宿主生成值一致。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answer_sdk_tool_call_id: Option<String>,
    pub checkpoint: Checkpoint,
    pub commit_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub control_delivery_ref: Option<ControlDeliveryRef>,
    /// Pi最后助手消息的首个已保存片段序号；省略时沿用从1起的完整文本校验。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub final_start_chunk_seq: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub final_text: Option<String>,
    pub lease_epoch: String,
    ///
    /// 宿主确认的正常完整自然final原输出绑定；恢复时保原attempt/entry/片段。须有final_text，与answer_parts、answer_sdk_tool_call_id、control_delivery_ref及final_start_chunk_seq互斥。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_binding: Option<AssistantOutputBinding>,
    ///
    /// 单份渲染正文分支：final_text为该份display（非模板、非整轮组合全文），与answer_parts、answer_sdk_tool_call_id、control_delivery_ref、output_binding及final_start_chunk_seq互斥。组合时改用answer_parts末项的rendered分支，不传顶层rendered。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rendered_answer_binding: Option<RenderedAnswerBinding>,
    pub run_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControlDeliveryRef {
    pub fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelAttempt {
    pub call_attempt_id: String,
    pub lease_epoch: String,
    pub run_id: String,
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
pub struct RunSnapshot {
    /// 运行中run最近一次已登记工具调用的中文动作提示，由服务端映射工具名生成；无工具调用的旧记录缺省。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity_label: Option<String>,
    /// 本run当前生成尝试身份，用于识别正文增量归属；旧快照可缺省。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempt_id: Option<String>,
    /// 已完成的工具动作、当前可读对象名称与真实耗时。仅作界面进度提示。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_step_summaries: Option<Vec<RunStepSummary>>,
    /// 该run已成功回执的工具调用计数；旧记录缺省。仅作进度展示，不作为执行依据。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_steps: Option<i32>,
    pub lease_epoch: String,
    /// 来自已有持久记录的触发消息身份；旧快照可缺省。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    /// user_request为用户消息触发；query_result为查询结果通知触发。旧快照可缺省，缺省时按中性处理提示展示。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub purpose: Option<RunSnapshotPurpose>,
    /// 结果通知run关联的原查询ID，来自conversations可信server:query-result消息关联；仅purpose=query_result时非null。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_query_id: Option<String>,
    pub run_id: String,
    pub state: RunSnapshotState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskSnapshot {
    pub condition_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence_refs: Option<Vec<AnalysisEvidenceRef>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub goal: Option<String>,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lifecycle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report_ref: Option<AnalysisReportRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report_timeline_event_seq: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_unavailable: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after_seq: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before_seq: Option<String>,
    pub loaded_outputs: Vec<LoadedOutputRange>,
}

/// 客户端已读连续事件区间内的输出片段；指纹只标识缓存内容，不授读取权。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoadedOutputRange {
    pub attempt_id: String,
    pub first_event_seq: String,
    pub last_event_seq: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub projection_fingerprint: Option<String>,
}

/// POST snapshot独立响应；普通分页游标与已加载输出的权限投影分开，旧GET Snapshot形状保持。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotRefresh {
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
    pub output_projections: Vec<OutputProjection>,
    pub runs: Vec<RunSnapshot>,
    pub tasks: Vec<TaskSnapshot>,
}

/// 每个请求范围恰有一个结果；replace完整替换该范围的assistant事件，空数组仍表示替换。not_available不区分缺失和其他会话。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputProjection {
    pub attempt_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub events: Option<Vec<Event>>,
    pub first_event_seq: String,
    pub last_event_seq: String,
    pub output_state: Option<OutputState>,
    pub projection_fingerprint: String,
    pub projection_result: ProjectionResult,
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
pub struct AppError {
    pub code: Code,
    pub message: String,
    pub request_id: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolReceipt {
    pub condition_version: String,
    pub operation_id: String,
    pub state: ToolReceiptState,
    pub task_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationReceipt {
    pub conversation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageReceipt {
    pub message_id: String,
    pub request_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct History {
    pub conversations: Vec<HistoryItem>,
    pub next_before_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryItem {
    /// 会话创建时间（UTC）；用于区分同名会话，不改变分页顺序。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    pub id: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Identity {
    pub model_label: ModelLabel,
    pub space_id: String,
    /// 空间显示名，由部署配置下发；与space_id分开，不参与授权判断。
    pub space_name: String,
    pub user_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionReceipt {
    pub model_label: ModelLabel,
    pub space_id: String,
    /// 空间显示名，由部署配置下发；与space_id分开，不参与授权判断。
    pub space_name: String,
    pub state: SessionReceiptState,
    pub user_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogoutReceipt {
    pub state: LogoutReceiptState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperationReceipt {
    pub operation_id: String,
    /// 原登记tool行冻结的合同版本，不随当前run变化；历史缺失按1。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_contract_version: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputReceipt {
    pub chunk_seq: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FinishReceipt {
    pub output_id: String,
    pub state: FinishReceiptState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelReceipt {
    pub state: ModelReceiptState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReserveModelCall {
    pub call_attempt_id: String,
    pub input_tokens_upper: i32,
    pub lease_epoch: String,
    pub output_tokens_max: i32,
    pub parameters_fingerprint: String,
    pub run_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendModelCall {
    pub call_attempt_id: String,
    pub lease_epoch: String,
    pub parameters_fingerprint: String,
    pub run_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FinalizeModelCall {
    pub call_attempt_id: String,
    pub lease_epoch: String,
    /// 受控provider给出的调用结果；与是否取得可靠用量分开。连续临时失败在原请求范围持久计数。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<Outcome>,
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
pub struct ModelCallReceipt {
    pub send_allowed: bool,
    pub state: ModelCallReceiptState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CancelRun {
    pub lease_epoch: String,
    pub run_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CancelReceipt {
    pub run_id: String,
    pub state: CancelReceiptState,
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
    /// 整篇编辑后后台片段的拼接顺序；与正文同版本保存，不作为页面字段。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_order: Option<i32>,
    pub entries: Vec<KnowledgeEntry>,
    pub id: String,
    pub kind: KindElement,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub maintenance: Option<SemanticMaintenance>,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prefill_status: Option<KnowledgeObjectPrefillStatusClass>,
    /// 当前来源的语义整理状态；与对象级预填分开表达，两作业互不冒充。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preparation_status: Option<KnowledgeObjectPreparationStatusClass>,
    pub related_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retrieval: Option<KnowledgeRetrieval>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub semantic_relations: Option<Vec<SemanticRelation>>,
    pub source_id: Option<String>,
    pub source_version: String,
    pub state: MemoryState,
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
pub struct KnowledgeEntry {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective_structure: Option<KnowledgeEntryQueryExampleStructureClass>,
    pub effective_value: String,
    pub entry_id: String,
    pub human_override: Option<KnowledgeEntryHumanOverrideClass>,
    pub label: String,
    pub path: String,
    pub review_state: ReviewState,
    pub source_facts: KnowledgeEntrySourceFactsClass,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub statements: Option<Vec<SemanticStatement>>,
    pub suggestion: KnowledgeEntrySuggestionClass,
}

pub type KnowledgeEntryQueryExampleStructureClass = SemanticStructure;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComputedMetric {
    /// 输出该口径的表达式或列计算说明。
    pub expression: String,
    pub metric_ref: EvidenceRef,
    /// 该SQL实际输出的口径名；与过滤中用到的指标分开表达。
    pub output_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FluffyJoinKey {
    pub left_column: String,
    pub right_column: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SemanticTableRef {
    pub object_id: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryExampleParameter {
    pub description: String,
    pub name: String,
    pub required: bool,
    #[serde(rename = "type")]
    pub query_example_parameter_type: QueryExampleParameterType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FluffyTimeColumn {
    pub column: String,
    pub role: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryExampleVerification {
    pub evidence_refs: Vec<EvidenceRef>,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeEntryHumanOverrideClass {
    #[serde(
        default,
        deserialize_with = "deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub structured_value: Option<Option<KnowledgeEntryQueryExampleStructureClass>>,
    #[serde(flatten)]
    pub extra: std::collections::BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeEntrySourceFactsClass {
    #[serde(
        default,
        deserialize_with = "deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub structured_value: Option<Option<KnowledgeEntryQueryExampleStructureClass>>,
    #[serde(flatten)]
    pub extra: std::collections::BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SemanticStatement {
    pub citations: Vec<SourceCitation>,
    pub object_ref: EvidenceRef,
    pub origin: Origin,
    pub scope_text: String,
    pub statement_id: String,
    pub supports: Vec<SemanticSupport>,
    /// 人工或整理成果对该陈述支持提取范围的明确完整性声明；历史缺字段或null为unknown，不从空supports或ready推导。
    #[serde(
        default,
        deserialize_with = "deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub supports_complete: Option<Option<bool>>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceCitation {
    pub locator: SourceLocator,
    pub revision: String,
    pub source: SourceKey,
}

/// offset及length固定使用Unicode code point；heading_path仅作定位提示。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceLocator {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heading_path: Option<Vec<String>>,
    pub length: i64,
    pub offset: i64,
}

///
/// 来源的稳定身份。kind和id须成对原样使用source_identity回执的source_keys或已有citation.source；不按资料名称、object_id前缀或正文是文档来猜kind，不将document改成platform。不包含修订号，也不使用索引chunk
/// ID。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceKey {
    pub id: String,
    pub kind: SourceKeyKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SemanticSupport {
    pub content: Option<String>,
    pub embedded_in: Option<EmbeddedSupportLocation>,
    pub reference: SemanticReference,
    pub role: PreparedSupportRole,
    pub support_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddedSupportLocation {
    pub field: Field,
    pub locator: SourceLocator,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SemanticReference {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub citation: Option<SourceCitation>,
    pub kind: SemanticReferenceKind,
    #[serde(rename = "ref")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub semantic_reference_ref: Option<EvidenceRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeEntrySuggestionClass {
    #[serde(
        default,
        deserialize_with = "deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub structured_value: Option<Option<KnowledgeEntryQueryExampleStructureClass>>,
    #[serde(flatten)]
    pub extra: std::collections::BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SemanticMaintenance {
    pub authority_id: String,
    pub can_assign: bool,
    pub can_edit: bool,
    /// 当前对象负责人：表来自 Datasight；独立人工对象默认创建者，超级维护者可调整。
    pub maintainer_id: Option<String>,
    pub source: Source,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeObjectPrefillStatusClass {
    pub attempt_id: String,
    pub error_code: Option<String>,
    pub state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeObjectPreparationStatusClass {
    pub error_code: Option<String>,
    pub revision: String,
    pub source_id: String,
    pub state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeRetrieval {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<KnowledgeRetrievalChannel>,
    pub excerpts: Vec<KnowledgeRetrievalExcerpt>,
    pub note: String,
    pub state: KnowledgeRetrievalState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeRetrievalExcerpt {
    pub entry_id: String,
    pub length: i32,
    pub offset: i64,
    pub path: String,
    pub text: String,
    pub total_chars: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SemanticRelation {
    pub citations: Vec<SourceCitation>,
    pub origin: Origin,
    pub predicate: Predicate,
    pub relation_id: String,
    pub scope_text: String,
    pub subject: EvidenceRef,
    pub target: SemanticReference,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchCoverage {
    /// 本次实际接收的唯一候选记录身份数（有效性筛除与合并前，跨通道跨轮去重累计）；达到candidate_limit即如实报覆盖不足。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate_count: Option<i64>,
    pub candidate_limit: i64,
    /// 逐通道有界进度；足够本页结果不表示穷举了该通道。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channels: Option<FluffyChannels>,
    /// 覆盖检查因期限耗尽或读取超时未完成；此时没有已证滞后，不能报index_lag，未覆盖原因以deadline/通道事实表达。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index_check_incomplete: Option<bool>,
    /// 是否实际查到旧投影或漏索引（覆盖检查已完成并确认滞后）。incomplete还可能是检查未完成，见index_check_incomplete；两者不能互相反推。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index_lag: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index_state: Option<IndexState>,
    /// 候选谓词是否覆盖全部去重检索词项；false时应改写或拆分查询，不能据空结果断言没有资料。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query_terms_complete: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope_applied: Option<bool>,
    pub state: SearchCoverageState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vector_state: Option<VectorState>,
}

/// 逐通道有界进度；足够本页结果不表示穷举了该通道。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FluffyChannels {
    pub dense: ChannelProgress,
    pub lexical: ChannelProgress,
    pub raw: Option<ChannelProgress>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelProgress {
    pub completed: i64,
    pub exhausted: bool,
    pub rounds: i64,
    pub shards: i64,
    /// 未覆盖原因：停在候选额度、共享期限，或dense因查询嵌入不可用停轮；null且exhausted=true表示该通道已穷举。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uncovered: Option<Uncovered>,
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
    /// 本次明确保存的人工陈述及支持提取声明；身份和origin由服务端生成，未提供时不编造完整性。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub statements: Option<Vec<HumanStatementInput>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub structured_value: Option<KnowledgeEntryQueryExampleStructureClass>,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HumanStatementInput {
    pub citations: Vec<SourceCitation>,
    pub key: String,
    pub scope_text: String,
    pub supports: Vec<PreparedSupport>,
    #[serde(
        default,
        deserialize_with = "deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub supports_complete: Option<Option<bool>>,
    pub target: EvidenceRef,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreparedSupport {
    pub content: Option<String>,
    pub embedded_in: Option<EmbeddedSupportLocation>,
    pub key: String,
    pub reference: SemanticReference,
    pub role: PreparedSupportRole,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeEntryBatch {
    /// 同一对象内按序应用的条目修改；任一条目校验失败则整批回滚。
    pub edits: Vec<KnowledgeEntryEdit>,
    /// 批量开始前的对象版本；同一事务内逐条保存，每条按既有语义递增，返回对象为最终版本。
    pub expected_version: String,
    pub operation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeEntryEdit {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clear_override: Option<bool>,
    pub entry_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub related_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    /// 本条目明确保存的人工陈述及支持提取声明；身份和origin由服务端生成。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub statements: Option<Vec<HumanStatementInput>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub structured_value: Option<KnowledgeEntryQueryExampleStructureClass>,
    pub value: String,
}

/// 独立对象首次创建时自动归属可信登录者；请求不接受负责人字段，后续调整使用独立管理接口。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeCreate {
    pub body: String,
    /// 对象自身的显式业务域；省略或空值表示未分类，不从关联对象继承。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub business_domain: Option<String>,
    pub kind: KindElement,
    pub name: String,
    pub operation_id: String,
    pub related_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub structured_value: Option<KnowledgeEntryQueryExampleStructureClass>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionCommand {
    pub expected_version: String,
    pub operation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetList {
    pub assets: Vec<Asset>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Asset {
    pub body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub can_edit: Option<bool>,
    pub dependencies: Vec<EvidenceRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<SkillFile>>,
    pub id: String,
    pub kind: AssetKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_index_state: Option<MemoryIndexState>,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_id: Option<String>,
    pub scope: String,
    pub selected: bool,
    pub source_text: String,
    pub state: AssetState,
    /// 来源失效或缺少可核验来源时仅供管理，正文、附件与引用已隐藏，不能选用或发布。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_unavailable: Option<bool>,
    pub verified: bool,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visibility: Option<Visibility>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillFile {
    /// UTF-8 文本；每行最多 51200 字节，业务边界校验并返回 skill_line_too_long。
    pub content: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetSave {
    /// Skill 的正文及生成资源每行最多 51200 UTF-8 字节；超限须分行保存。记忆不受此行限制。
    pub body: String,
    pub dependencies: Vec<EvidenceRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub draft_id: Option<String>,
    pub expected_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<SkillFile>>,
    pub id: Option<String>,
    pub kind: AssetKind,
    pub name: String,
    pub operation_id: String,
    pub scope: String,
    pub source_text: String,
    pub verified: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillSelection {
    pub asset_id: String,
    pub operation_id: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisUpdateFields {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<AnalysisUpdateAction>,
    /// 同一任务需分别回答的独立问题，各生成独立ID；与非空question互斥，不同目标分别建任务。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clarifications: Option<Vec<ClarificationRequest>>,
    ///
    /// 修改已存任务条件时必填，action用revise或clarify；set指定新值，unset可省略（省略即不清空任何字段，null非法）。route禁止携带condition_patch，因为route只登记归属。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub condition_patch: Option<ConditionPatch>,
    /// 新建任务必须完整给出；未指定的可空标量用JSON null，列表用[]，notes用空字符串，timezone按宿主业务时区。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conditions: Option<Conditions>,
    /// 新建任务省略此字段（也接受JSON null）；已有任务必须提供工具回执中的当前版本数字字符串。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_version: Option<String>,
    ///
    /// 仅route可用：显式定稿当前任务已完成的说明或查询答案；可route到同一任务保留其SQL等待状态，也可切到其他目标。该助手消息只允许这个route；宿主绑定完整正文或原成功答案回执。普通route不定稿，不授执行权。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finalize_current_answer: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub goal: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub legacy_resolution_migration: Option<LegacyResolutionMigration>,
    /// split迁移到新独立目标的原开放问题ID，保留问题正文与来源，其余原目标问题不动。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub moved_clarification_ids: Option<Vec<String>>,
    /// 澄清问题的候选答案；仅与实际question同用，开放回答可无候选（空数组或省略）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<String>>,
    /// 需要用户补充的实际问题；无需澄清时省略（也接受JSON null），不能填字符串null、空文本或用户原问题。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replaces_query_id: Option<String>,
    ///
    /// 本消息中用户已真实回答，或当前有效且获准资料已唯一解决的事实问题ID；事实解决须在同次revise保存条件与依据，不能伪称用户选择。省略或[]保留其他问题，仅已有任务revise/clarify可用。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_clarification_ids: Option<Vec<String>>,
    /// 新建任务省略此字段（也接受JSON null）；已有任务用工具回执中的真实ID，不能填字符串null。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClarificationRequest {
    /// 此独立问题的候选答案；允许自由回答。
    pub options: Vec<String>,
    /// 此独立问题的必填正文；无需新增问题时省略整个clarifications列表。
    pub question: String,
}

///
/// 修改已存任务条件时必填，action用revise或clarify；set指定新值，unset可省略（省略即不清空任何字段，null非法）。route禁止携带condition_patch，因为route只登记归属。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConditionPatch {
    pub set: ConditionSet,
    /// 清除指定条件字段。省略即空集合（不清空任何字段），null非法；显式数组仍清除列出的字段。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unset: Option<Vec<Unset>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConditionSet {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<ConditionsChannel>,
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
    /// 只更新已采用解释及来源；null/unset只清说明，不解决开放问题。旧未决通过明确legacy_resolution_migration转换。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub semantic_resolution: Option<ConditionsQuerySemanticResolution>,
    /// 设置来源限制；撤销使用unset source_limits，不接受设为空集。
    #[serde(
        default,
        deserialize_with = "deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub source_limits: Option<Option<SourceLimits>>,
    /// 修改区间的不包含终点，按业务时区解析后填写UTC完整时间戳，以Z结尾；整月结束为下一月起点。清空使用unset；未修改则省略。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_end: Option<String>,
    /// 整体替换时间口径角色；清空使用unset。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_roles: Option<Vec<TimeRole>>,
    /// 修改区间的包含起点，按业务时区解析后填写UTC完整时间戳，以Z结尾。清空使用unset；未修改则省略。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_start: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
}

///
/// 新格式仅记录已经采用的解释。explicit_user引用本轮完整原话，null/省略采纳身份由宿主绑定；原已核对象可同文继承。未决只登记clarifications，无问题且条件充分时不要求本对象。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConditionsQuerySemanticResolution {
    ///
    /// explicit_user：null=本轮新采纳，由宿主核对user_quote为本轮完整原话后绑定真实消息身份；非空=复制继承原已验证决策的消息身份，不接受模型自由填写。其余basis为null。
    pub adoption_message_id: Option<String>,
    /// 真实用户明确选择、确无实质歧义、或仍需澄清；资料支持某公式不等于用户选择它。
    pub basis: SemanticResolutionBasis,
    /// 支撑该口径决策的依据引用；旧调用缺失按空数组解码。
    pub evidence_refs: Option<Vec<EvidenceRef>>,
    /// 本稿采用的指标、分子/分母、时间等关键口径及选择依据；不能把自己刚写入任务的假设当作用户采用。
    pub interpretation: String,
    /// 仍会改变答案且未获选择的分子、分母、时间归属等差异；有差异必须先澄清，不能默认写稿。
    pub unresolved_differences: Option<Vec<String>>,
    /// explicit_user逐字填写本条真实用户完整原话，保留否定、前提、例外和换行，不截取子串；其余为null。
    pub user_quote: Option<String>,
}

/// 设置来源限制；撤销使用unset source_limits，不接受设为空集。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceLimits {
    /// 非空允许集；限制跟稳定来源身份走，实际读取仍核对当前修订。
    pub allowed_sources: Vec<SourceKey>,
    /// 由宿主绑定的真实消息身份；不接受模型自由填写。
    pub origin_message_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimeRole {
    /// 业务含义说明。
    pub description: String,
    /// 支撑该时间口径的依据；可空数组。
    pub evidence_refs: Vec<EvidenceRef>,
    /// 采用的时间字段引用；可空。
    pub field_ref: Option<String>,
    /// 采用的时间字段含义、观察截点或数据批次；三者不混用。
    pub role: TimeRoleRole,
    /// observation_cutoff必须为带时区的时间值，data_batch必须为批次值；event_time可空（实际区间沿time_start/time_end）。
    pub value: Option<String>,
}

/// 新建任务必须完整给出；未指定的可空标量用JSON null，列表用[]，notes用空字符串，timezone按宿主业务时区。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conditions {
    pub channel: Option<ConditionsChannel>,
    pub filters: Vec<String>,
    pub group_by: Vec<String>,
    pub knowledge_refs: Vec<EvidenceRef>,
    pub metric: Option<String>,
    pub notes: String,
    /// 当前格式仅记录已采用解释及依据，未决由clarifications表达；省略继承，null只清说明，未要求所有任务填写。旧形状按宿主持久格式标记兼容，读取不迁移。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub semantic_resolution: Option<ConditionsQuerySemanticResolution>,
    /// null表示本题显式未声明额外来源限制；字段缺失表示旧条件版本未记录新式限制，不能证明用户从未限制。撤销必须显式unset并来自真实用户修改。
    #[serde(
        default,
        deserialize_with = "deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub source_limits: Option<Option<SourceLimits>>,
    /// 时间区间的不包含终点。按明确的业务时区解析后转为UTC完整时间戳，以Z结尾；整月结束为下一月起点，不能写本月最后一天。未指定时为null。
    pub time_end: Option<String>,
    /// 时间口径角色；统计起止仍沿time_start/time_end，request_clock和平台data_freshness不冒充用户截点。字段缺失表示旧版本未记录。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_roles: Option<Vec<TimeRole>>,
    /// 时间区间的包含起点。按明确的业务时区解析后转为UTC完整时间戳，以Z结尾；不能只写日期。未指定时为null。
    pub time_start: Option<String>,
    pub timezone: String,
}

/// 仅revise显式转换旧未决。每项链接实际问题；已resolved项给原条件版本及所指顶层字段，宿主核实际回执/原消息及字段来源。无依据保持或恢复open，未关联旧项登记open。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LegacyResolutionMigration {
    pub from_condition_version: String,
    pub links: Vec<LegacyResolutionLink>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LegacyResolutionLink {
    pub clarification_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub condition_fields: Option<Vec<ConditionField>>,
    pub pending_index: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolution_condition_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisUpdate {
    pub action: AnalysisUpdateAction,
    /// 同一任务需分别回答的独立问题，各生成独立ID；与非空question互斥，不同目标分别建任务。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clarifications: Option<Vec<ClarificationRequest>>,
    ///
    /// 修改已存任务条件时必填，action用revise或clarify；set指定新值，unset可省略（省略即不清空任何字段，null非法）。route禁止携带condition_patch，因为route只登记归属。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub condition_patch: Option<ConditionPatch>,
    /// 新建任务必须完整给出；未指定的可空标量用JSON null，列表用[]，notes用空字符串，timezone按宿主业务时区。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conditions: Option<Conditions>,
    /// 新建任务省略此字段（也接受JSON null）；已有任务必须提供工具回执中的当前版本数字字符串。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_version: Option<String>,
    ///
    /// 仅route可用：显式定稿当前任务已完成的说明或查询答案；可route到同一任务保留其SQL等待状态，也可切到其他目标。该助手消息只允许这个route；宿主绑定完整正文或原成功答案回执。普通route不定稿，不授执行权。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finalize_current_answer: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub goal: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub legacy_resolution_migration: Option<LegacyResolutionMigration>,
    /// split迁移到新独立目标的原开放问题ID，保留问题正文与来源，其余原目标问题不动。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub moved_clarification_ids: Option<Vec<String>>,
    /// 澄清问题的候选答案；仅与实际question同用，开放回答可无候选（空数组或省略）。
    pub options: Vec<String>,
    /// 需要用户补充的实际问题；无需澄清时省略（也接受JSON null），不能填字符串null、空文本或用户原问题。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replaces_query_id: Option<String>,
    ///
    /// 本消息中用户已真实回答，或当前有效且获准资料已唯一解决的事实问题ID；事实解决须在同次revise保存条件与依据，不能伪称用户选择。省略或[]保留其他问题，仅已有任务revise/clarify可用。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_clarification_ids: Option<Vec<String>>,
    /// 新建任务省略此字段（也接受JSON null）；已有任务用工具回执中的真实ID，不能填字符串null。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillReadResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset: Option<ModelAssetPreview>,
    pub asset_ref: AssetReadRef,
    pub kind: SkillReadResultKind,
    pub state: EvidenceReadResultState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetReadRef {
    pub id: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryReadResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset: Option<ModelAssetPreview>,
    pub asset_ref: AssetReadRef,
    pub kind: MemoryReadResultKind,
    pub part: PartEnum,
    pub state: EvidenceReadResultState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeReadInput {
    pub items: Vec<KnowledgeReadItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_ref: Option<EvidenceTaskRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum KnowledgeReadItem {
    #[serde(rename = "knowledge")]
    Knowledge {
        #[serde(rename = "ref")]
        knowledge_read_item_ref: EvidenceRef,
        #[serde(skip_serializing_if = "Option::is_none")]
        statement_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        structure_only: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        supports_cursor: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        offset: Option<i32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        limit: Option<i32>,
    },
    #[serde(rename = "memory")]
    Memory {
        asset_ref: AssetReadRef,
        part: PartEnum,
        #[serde(skip_serializing_if = "Option::is_none")]
        offset: Option<i32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        limit: Option<i32>,
    },
    #[serde(rename = "skill")]
    Skill { asset_ref: AssetReadRef },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "state", deny_unknown_fields)]
pub enum KnowledgeReadResult {
    #[serde(rename = "ok")]
    Ok {
        kind: KnowledgeReadResultKind,
        #[serde(rename = "ref")]
        knowledge_read_result_ref: EvidenceRef,
        #[serde(skip_serializing_if = "Option::is_none")]
        statement_id: Option<String>,
        content: String,
        content_page: ContentPage,
        #[serde(skip_serializing_if = "Option::is_none")]
        structure_text: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        structure_page: Option<ContentPage>,
        #[serde(
            default,
            deserialize_with = "deserialize_present",
            skip_serializing_if = "Option::is_none"
        )]
        effective_structure: Option<Option<KnowledgeEntryQueryExampleStructureClass>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        structure_dependencies: Option<Vec<EvidenceRef>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        structure_coverage: Option<FluffyStructureCoverage>,
        supports: Vec<DeliveredSupport>,
        #[serde(skip_serializing_if = "Option::is_none")]
        supports_total: Option<i64>,
        supports_complete: Option<bool>,
        citations: Vec<SourceCitation>,
        content_state: ContentState,
        support_state: SupportState,
        continuation: EvidenceContinuation,
    },
    #[serde(rename = "stale")]
    Stale {
        kind: KnowledgeReadResultKind,
        #[serde(rename = "ref")]
        knowledge_read_result_ref: EvidenceRef,
    },
    #[serde(rename = "not_available")]
    NotAvailable {
        kind: KnowledgeReadResultKind,
        #[serde(rename = "ref")]
        knowledge_read_result_ref: EvidenceRef,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvidenceContinuation {
    pub content_next_offset: Option<i64>,
    pub supports_next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FluffyStructureCoverage {
    pub notes: Vec<String>,
    pub state: StructureCoverageState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeliveredSupport {
    pub content: Option<String>,
    /// 支持正文自己的Unicode字符页；游标仍沿supports_next_cursor继续。同一支持的尾页不代表本回执已包含整条支持。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_page: Option<ContentPage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivered_in: Option<DeliveredSupportDeliveredInClass>,
    pub embedded_in: Option<EmbeddedSupportLocation>,
    pub reference: SemanticReference,
    pub role: PreparedSupportRole,
    pub support_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeliveredSupportDeliveredInClass {
    pub locator: SourceLocator,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeReadReply {
    pub items: Vec<EvidenceReadResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum EvidenceReadResult {
    KnowledgeReadResult(KnowledgeReadResult),
    MemoryReadResult(MemoryReadResult),
    SkillReadResult(SkillReadResult),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceReadInput {
    pub citation: SourceCitation,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_ref: Option<EvidenceTaskRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceReadReply {
    pub content_state: ContentState,
    pub locator: SourceLocator,
    pub next_locator: Option<SourceLocator>,
    pub revision: String,
    pub source: SourceKey,
    pub source_length: i64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeSearchInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_after: Option<String>,
    ///
    /// 由evidence视图search_coverage.next返回的短不透明回执引用rc1:<operation_id>，或旧JSON/gzip续读状态；宿主按当前用户/空间/会话从原成功工具回执恢复完整候选窗口，短引用不是读取凭据。保持原查询、kinds、hints、source_selection和任务绑定，asset_after独立推进。source_identity视图沿用独立cursor。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    /// 仅用于相关性排序，不扩大或收窄当前权限、kinds及任务来源范围。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hints: Option<Hints>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kinds: Option<Vec<KindElement>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i32>,
    pub query: String,
    ///
    /// 仅evidence视图使用的精确原文选择。object_id取source_identity.object_id，version取其object_version；只定位这些当前对象的正式source_facts，不授予知识或结构采用权，也不将对象版本当作来源revision。原文仍核实际SourceKey、来源许可、当前修订、完整性与唯一定位；失败项不妨碍其他合法项。kinds仍筛选所选对象类型，hints仍只排序；不接受客户端quote/path/offset，不退到全文。省略时保持原搜索。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_selection: Option<Vec<SourceObjectSelection>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_ref: Option<EvidenceTaskRef>,
    ///
    /// 省略为evidence取证。source_identity的query按空白分隔名称/ID词，任一词在可读名称或标识中匹配即可返回；单独的*保留目录浏览。只匹配元信息，不解析自然语言、同义词或用户许可，不提供正文/定义/摘录/建议或个人资产，不调用付费语义检索，也不算已读证据或授予正文权限。两种视图的cursor不可互换，身份匹配语义更新后的旧绑定cursor无效。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view: Option<KnowledgeSearchInputView>,
}

/// 仅用于相关性排序，不扩大或收窄当前权限、kinds及任务来源范围。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hints {
    pub business_domain: Option<String>,
    pub related_object_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceObjectSelection {
    pub object_id: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeSearchReply {
    pub asset_cursor_invalid: bool,
    pub asset_total: i64,
    pub hits: Vec<KnowledgeSearchHit>,
    /// 多指标检索中已核验命中的表唯一键和关系关联键摘要。缺项应读取对应表和关系的完整结构。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_hints: Option<Vec<String>>,
    ///
    /// 个人记忆检索通道：受限任务来源门生效时按资产真实来源过滤，仅无可证明同源记忆时标记excluded_by_source_limits；命中侧过滤事实见回执source_limits块。
    pub memory_retrieval: String,
    pub next_asset_after: Option<String>,
    pub personal_memories: Vec<HashMap<String, Option<serde_json::Value>>>,
    pub search_coverage: KnowledgeSearchCoverage,
    pub selected_skills: Vec<HashMap<String, Option<serde_json::Value>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "record_kind", deny_unknown_fields)]
pub enum KnowledgeSearchHit {
    #[serde(rename = "source_identity")]
    SourceIdentity {
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        kind: Option<KindElement>,
        #[serde(skip_serializing_if = "Option::is_none")]
        object_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        object_version: Option<String>,
        source_keys: Vec<SourceKey>,
        roots_complete: bool,
    },
    #[serde(rename = "knowledge_entry")]
    KnowledgeEntry {
        #[serde(rename = "ref")]
        knowledge_search_hit_ref: EvidenceRef,
        #[serde(skip_serializing_if = "Option::is_none")]
        statement_id: Option<String>,
        name: String,
        kind: KindElement,
        definition: String,
        scope_text: String,
        supports: Vec<DeliveredSupport>,
        supports_complete: Option<bool>,
        example_refs: Vec<EvidenceRef>,
        citations: Vec<SourceCitation>,
        content_state: ContentState,
        support_state: SupportState,
        continuation: EvidenceContinuation,
    },
    #[serde(rename = "source_excerpt")]
    SourceExcerpt {
        citation: SourceCitation,
        source_length: i64,
        text: String,
        name: String,
        content_state: ContentState,
        support_state: SupportState,
        semantic_status: KnowledgeSearchHitSemanticStatus,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeSearchCoverage {
    pub channels: Vec<KnowledgeSearchCoverageChannelClass>,
    /// evidence视图有后页时为宿主生成的短不透明回执引用rc1:<operation_id>，长度不超过96
    /// ASCII字节；宿主只在原成功工具回执持久化完整候选窗口后发布，同操作重放返回同一引用。无后页为null。source_identity视图沿用独立cursor。
    pub next: Option<String>,
    pub reasons: Vec<Reason>,
    pub state: KnowledgeSearchCoverageState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeSearchCoverageChannelClass {
    pub channel: ChannelChannel,
    pub state: ChannelState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_after: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub business_domain: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kinds: Option<Vec<KindElement>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i32>,
    pub query: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub related_object_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadKnowledgeInput {
    ///
    /// 知识条目ID；个人记忆省略时读取正文，scope读取范围，source_text读取来源原话，分别检查content_page/scope_page/source_page并按同一version续读。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i32>,
    pub object_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub structure_only: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
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
pub struct RequestQueryInput {
    pub condition_version: String,
    pub knowledge_refs: Vec<EvidenceRef>,
    pub parameters: HashMap<String, Option<serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replaces_query_id: Option<String>,
    /// 省略继承目标条件版本已有采纳说明；兼容携带只核同义声明，不能独立另作决定。新任务未决定时登记clarifications，改变解释先同次修订条件。旧形状仅沿旧格式兼容。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub semantic_resolution: Option<SemanticResolution>,
    pub sql: String,
    pub summary: String,
    pub target_id: TargetId,
    pub task_id: String,
}

/// 旧未决形状与新采纳说明仅在兼容边界解码；实际条件格式由宿主decision_state_version决定。
///
/// 省略继承目标条件版本已有采纳说明；兼容携带只核同义声明，不能独立另作决定。新任务未决定时登记clarifications，改变解释先同次修订条件。旧形状仅沿旧格式兼容。
///
///
/// 新格式仅记录已经采用的解释。explicit_user引用本轮完整原话，null/省略采纳身份由宿主绑定；原已核对象可同文继承。未决只登记clarifications，无问题且条件充分时不要求本对象。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SemanticResolution {
    QuerySemanticResolution(QuerySemanticResolution),
    AdoptedSemanticResolution(AdoptedSemanticResolution),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadQueryInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    pub query_id: String,
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
pub struct ProposalInput {
    pub base_version: String,
    pub entry_id: String,
    pub evidence: Vec<EvidenceRef>,
    pub object_id: String,
    pub reason: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataToolInvocation {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answer_handoff: Option<AnswerHandoff>,
    pub arguments: HashMap<String, Option<serde_json::Value>>,
    pub checkpoint: Checkpoint,
    pub lease_epoch: String,
    /// 宿主按实际Pi投影与同批工具共享余量分配；不参与业务身份，不属于模型工具参数。历史调用可缺省。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_budget: Option<ResponseBudget>,
    pub run_id: String,
    pub sdk_tool_call_id: String,
    pub tool_name: ToolName,
}

/// 显式route登记时冻结的宿主事实；恢复先接原登记，不从新attempt重算。成功答案回执仍是候选，route事务提交后才成为part。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnswerHandoff {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answer_sdk_tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assistant: Option<AssistantOutputBinding>,
    /// 渲染正文交接分支；与顶层assistant互斥。当前冻结route所在原assistant允许toolUse，tool_call_ids只含本次route。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rendered_answer_binding: Option<RenderedAnswerBinding>,
}

/// 宿主按实际Pi投影与同批工具共享余量分配；不参与业务身份，不属于模型工具参数。历史调用可缺省。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResponseBudget {
    pub estimated_tokens: i32,
    pub max_bytes: i32,
    pub projection_fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataToolOutcome {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answer_parts: Option<Vec<AnswerPartReference>>,
    /// 成功答案的原工具登记归属，来自宿主task_id/task_condition_version；与实际sources和通知交付目标分开，不改原回执存储字节。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answer_task_ref: Option<EvidenceTaskRef>,
    /// 宿主成功回执声明需要Pi原生重投影的活动任务。省略表示无需调整。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_reset: Option<DataToolOutcomeContextResetClass>,
    #[serde(
        default,
        deserialize_with = "deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub control_delivery: Option<Option<ControlDelivery>>,
    pub data: HashMap<String, Option<serde_json::Value>>,
    ///
    /// 宿主按本运行原通知query/task/condition及其原scope核验全部实际冻结答案后的覆盖事实；与control_delivery共同计算，不从source_query_ids推断。只随控制状态回执更新，不授来源或SQL权限。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frozen_notification_covered: Option<bool>,
    pub operation_id: String,
    /// 未就绪原因，由原判定同次产出；就绪时省略。旧回执可缺省，不据缺省推断已就绪，恢复时采用当前宿主事实。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_context_blocker: Option<SourceContextBlocker>,
    /// 宿主核对本消息归属和来源声明后的正文准入状态；不由模型填写。若context_reset存在，Pi先完成既有重投影/刷新再采用新正文。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_context_ready: Option<bool>,
    /// 本次条件修订实际作废的未提交SQL草稿ID；宿主同事务生成，消费者撤下旧观察。缺省表示旧回执未提供该信息，不据此推定草稿有效。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub superseded_query_ids: Option<Vec<String>>,
    /// 生成该结果的原tool合同版本，成功与明确拒绝均沿原登记值；历史缺失按1，Node可由已校验的原OperationReceipt补足。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_contract_version: Option<i64>,
    pub tool_name: ToolName,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataToolOutcomeContextResetClass {
    pub condition_version: String,
    pub task_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryHistoryQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub q: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryHistory {
    pub next_before_id: Option<String>,
    pub queries: Vec<QueryHistoryItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryHistoryItem {
    pub condition_version: String,
    pub confirmation_state: String,
    pub conversation_id: String,
    /// 查询创建时间（UTC），用于区分同名查询，不改变分页顺序。
    pub created_at: String,
    pub draft_version: String,
    pub execution_state: String,
    pub id: String,
    /// 查询SQL原文；正文失效的查询缺省，不用于重新执行。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sql: Option<String>,
    /// 查询保存时的摘要原文；正文失效的查询仅返回控制字段，summary缺省。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    pub task_id: String,
    /// 正文按历史记录展示：来源已改版或结果已漂移但记录仍可核；不能作为当前口径或执行依据。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_historical: Option<bool>,
    /// 正文来源失效或无法核实时为true；此时仅保留身份与控制状态。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_unavailable: Option<bool>,
    /// 该查询首次query_changed事件序号；无事件的旧记录为null，跳转定位由前端回退处理。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeline_event_seq: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfirmQuery {
    pub condition_version: String,
    pub draft_version: String,
    pub operation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MutationReceipt {
    pub operation_id: String,
    pub resource_id: String,
    pub state: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProposalList {
    pub proposals: Vec<Proposal>,
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
pub struct SourceDocument {
    pub body: String,
    pub complete: bool,
    pub current_version: String,
    pub source_id: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SqlInput {
    pub knowledge_refs: Option<Vec<EvidenceRef>>,
    pub parameters: HashMap<String, Option<serde_json::Value>>,
    pub sql: String,
    pub target_id: TargetId,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadTaskInput {
    /// 按回执next_clarification_after继续读取未决问题；省略从第一页开始。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clarification_after: Option<String>,
    /// 省略读取当前条件；指定时读取该任务真实历史快照及其依据，不授予执行权。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub condition_version: Option<String>,
    pub task_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrefillResult {
    pub entries: Vec<PrefillResultEntryClass>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrefillResultEntryClass {
    pub entry_id: String,
    pub evidence: Vec<FluffyEvidence>,
    pub gaps: Vec<String>,
    pub structured_value: Option<KnowledgeEntryQueryExampleStructureClass>,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FluffyEvidence {
    pub location: String,
    pub quote: String,
    pub source_id: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub q: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeListQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after_id: Option<String>,
    /// 管理目录按名称和状态分页；maintained按当前负责人关系筛选，包含停用项。省略时保留现有语义检索。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub directory: Option<Directory>,
    /// 仅管理目录使用。grouped只分页列出表、指标、整篇文档、查询案例与术语；字段和关系从所属表打开。省略或flat保留全部对象列表。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub directory_view: Option<DirectoryView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub q: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub related_id: Option<String>,
    /// 仅用于管理目录；省略时包含启用及停用，始终排除已删除对象。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<MaintenanceDependentState>,
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
pub struct AnalysisPreferenceCommand {
    pub expected_version: String,
    pub operation_id: String,
    pub preferred: bool,
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
pub struct PiSessionReference {
    pub file: String,
    pub kind: PiSessionReferenceKind,
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostCheckpointReference {
    pub fingerprint: String,
    pub kind: HostCheckpointReferenceKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadCheckpoint {
    pub lease_epoch: String,
    pub run_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryExtractionRequest {
    pub budget: MemoryBudgetBinding,
    pub message: String,
    pub operation_id: String,
    pub owner_id: String,
    /// 修订时由宿主从本人可用的expected_version绑定的旧记忆；只作解析指代和保留未改限定的资料，当前真实指令优先。新建时省略或为null。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_memory: Option<MemoryExtractionRequestPreviousMemoryClass>,
    pub quote: String,
    pub space_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryBudgetBinding {
    pub epoch: String,
    pub id: String,
    pub kind: MemoryBudgetBindingKind,
    pub operation_id: String,
    /// run工具绑定真实SDK调用ID；run启动检索与index作业为null，其operation/租约/用途由宿主核对。
    pub sdk_tool_call_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryExtractionRequestPreviousMemoryClass {
    pub body: String,
    pub id: String,
    pub scope: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryExtractionReceipt {
    pub body: String,
    pub operation_id: String,
    pub replayed: bool,
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
pub struct MemoryIndexReceipt {
    pub operation_id: String,
    pub state: MemoryIndexReceiptState,
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
pub struct MemorySearchReceipt {
    pub bounded: bool,
    pub candidates: Vec<MemoryCandidate>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryCandidate {
    pub asset_id: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryModelCall {
    pub action: MemoryModelCallAction,
    pub budget: MemoryBudgetBinding,
    pub call_attempt_id: String,
    pub input_tokens_upper: i32,
    pub output_tokens_max: i64,
    pub parameters_fingerprint: String,
    pub purpose: MemoryModelCallPurpose,
    pub usage: Option<ModelUsage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddingProfile {
    /// 可选：显式维护试用的累计调用帽；普通维护配置省略，无累计上限与期限。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call_limit: Option<i32>,
    /// 可选：显式维护试用的累计费用帽；普通维护配置省略。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_limit_micros: Option<String>,
    pub trial_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SemanticAccess {
    pub can_admin: bool,
    /// 可创建独立指标、文档等；由当前空间已同步的 Datasight 表维护关系或超级维护者角色确定。
    pub can_create: bool,
    /// 当前空间用于展示的最高语义角色。超级维护者优先；负责表或独立语义对象则为维护者；其余为普通用户。该摘要不授予权限，独立对象负责人不一定有创建资格。
    pub highest_role: HighestRole,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssignSemanticMaintainer {
    pub expected_version: String,
    /// 超级维护者调整独立对象负责人；null 撤销，不能调整 Datasight 表或字段。
    pub maintainer_id: Option<String>,
    pub operation_id: String,
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
pub struct ReviewSemanticCorrection {
    pub decision: Decision,
    pub expected_revision: String,
    pub operation_id: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApplySemanticCorrection {
    pub expected_revision: String,
    pub expected_version: String,
    pub operation_id: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SemanticCorrectionList {
    pub corrections: Vec<SemanticCorrection>,
    pub next_after_id: Option<String>,
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
pub struct SemanticMemberList {
    pub user_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublishSkill {
    pub expected_version: String,
    pub operation_id: String,
    pub share_confirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SuggestSkill {
    pub content: String,
    pub expected_version: String,
    pub operation_id: String,
    pub share_confirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewSkillSuggestion {
    pub expected_revision: String,
    pub operation_id: String,
    pub response: String,
    pub state: ReviewSkillSuggestionState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillSuggestionList {
    pub next_after_id: Option<String>,
    pub suggestions: Vec<SkillSuggestion>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillSuggestion {
    pub asset_id: String,
    pub asset_version: String,
    pub author_id: String,
    pub content: String,
    pub id: String,
    pub response: String,
    pub reviewed_by: Option<String>,
    pub revision: String,
    pub state: SkillSuggestionState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationSkillSelections {
    pub change_blocked: bool,
    pub conversation_id: String,
    pub next_after_id: Option<String>,
    pub selections: Vec<ConversationSkillSelection>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationSkillSelection {
    pub asset_id: String,
    pub availability: Availability,
    pub current_version: Option<String>,
    pub name: Option<String>,
    pub owner_id: Option<String>,
    pub selected_version: String,
    pub selection_id: String,
    pub visibility: Option<Visibility>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetPageQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillReadInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<i32>,
    pub path: String,
}

/// 将同一来源的业务文档按自然章节组合阅读；parts保留原引用身份，编辑时一次提交全部章节。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeDocument {
    pub body: String,
    pub can_edit: bool,
    pub parts: Vec<KnowledgeObject>,
    pub title: String,
}

/// 完整Markdown与完整片段版本集合；服务端逐一授权，正文与后台顺序同事务保存，重复操作返回原回执。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeDocumentEdit {
    pub body: String,
    pub operation_id: String,
    pub parts: Vec<KnowledgeDocumentEditPartClass>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub related_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeDocumentEditPartClass {
    pub expected_version: String,
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecuteQueryInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub condition_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub draft_version: Option<String>,
    pub instruction_quote: String,
    /// 同一用户消息明确授权的完整查询集合，一次确认；不能与单条query_id/draft_version/condition_version同时传。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queries: Option<Vec<FluffyQuery>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FluffyQuery {
    pub condition_version: String,
    pub draft_version: String,
    pub query_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelCatalog {
    pub default_selection: Option<ModelSelection>,
    pub models: Vec<ModelOption>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requires_model: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelOption {
    pub id: String,
    pub label: String,
    pub thinking_options: Vec<ThinkingOption>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThinkingOption {
    pub label: String,
    pub value: ThinkingLevel,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationModelSelection {
    pub selection: Option<ModelSelection>,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveModelSelection {
    pub expected_version: String,
    pub selection: ModelSelection,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillSelectionRemoval {
    pub asset_id: String,
    pub operation_id: String,
    pub selection_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillRemovalReceipt {
    pub asset_id: String,
    pub conversation_id: String,
    pub operation_id: String,
    pub selection_id: String,
    pub state: SkillRemovalReceiptState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SemanticColumnRef {
    pub column: String,
    pub object_id: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum SemanticStructure {
    #[serde(rename = "table")]
    Table {
        grain: String,
        unique_keys: Vec<Vec<String>>,
        time_columns: Vec<FluffyTimeColumn>,
        default_filters: Vec<String>,
        constraints: Vec<String>,
    },
    #[serde(rename = "field")]
    Field {
        table: SemanticTableRef,
        column: String,
        unit: Option<String>,
    },
    #[serde(rename = "relationship")]
    Relationship {
        left_table: SemanticTableRef,
        right_table: SemanticTableRef,
        join_keys: Vec<FluffyJoinKey>,
        cardinality: Cardinality,
        scope: String,
    },
    #[serde(rename = "metric")]
    Metric {
        table: SemanticTableRef,
        expression: String,
        input_grain: String,
        time_column: Option<String>,
        unit: Option<String>,
        required_filters: Vec<String>,
        dimensions: Vec<String>,
    },
    #[serde(rename = "query_example")]
    QueryExample {
        applicable_question: String,
        parameters: Vec<QueryExampleParameter>,
        sql: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        computed_metrics: Option<Vec<ComputedMetric>>,
        grain: String,
        dependencies: Vec<EvidenceRef>,
        verification: Option<QueryExampleVerification>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveAnalysisEvidenceInput {
    pub condition_version: String,
    pub data_range: String,
    pub findings: Vec<AnalysisFinding>,
    pub task_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisFinding {
    pub calculation: String,
    pub figures: Vec<AnalysisFigure>,
    pub knowledge_refs: Vec<EvidenceRef>,
    pub limitations: Vec<String>,
    pub query_refs: Vec<AnalysisQueryReference>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisFigure {
    pub column: String,
    pub label: String,
    pub query_id: String,
    pub row_index: i32,
    pub value: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisQueryReference {
    pub columns: Vec<String>,
    pub query_id: String,
    pub result_ref: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetQueryInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column_index: Option<i64>,
    /// 超长JSON片段续读的Unicode字符偏移。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_offset: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    pub query_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row_index: Option<i32>,
    /// rows默认；statistics独立统计；cell按绝对行列读值。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view: Option<AgentQueryResultsView>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveAnalysisReportInput {
    pub charts: Vec<AnalysisReportChart>,
    pub condition_version: String,
    pub evidence_ids: Vec<String>,
    pub expected_version: Option<String>,
    pub task_id: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisReportChart {
    pub dimension_column: String,
    pub kind: AnalysisReportChartKind,
    pub measure_column: String,
    pub query_id: String,
    pub result_ref: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveAnalysisReport {
    pub charts: Vec<AnalysisReportChart>,
    pub condition_version: String,
    pub evidence_ids: Vec<String>,
    pub expected_version: Option<String>,
    pub operation_id: String,
    pub task_id: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", deny_unknown_fields)]
pub enum AnalysisReportView {
    #[serde(rename = "available")]
    Available {
        reference: AnalysisReportRef,
        report: AnalysisReport,
        chart_results: Vec<QueryResults>,
    },
    #[serde(rename = "condition_changed")]
    ConditionChanged {
        reference: AnalysisReportRef,
        report: AnalysisReport,
        chart_results: Vec<QueryResults>,
    },
    #[serde(rename = "sources_unavailable")]
    SourcesUnavailable {
        reference: Option<AnalysisReportRef>,
    },
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub saved_result_complete: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub saved_row_count: Option<i32>,
    pub source: String,
    /// 应用对当前有权结果页计算的统计；历史客户端可省略。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub statistics: Option<ResultStatistics>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResultColumn {
    /// 查询投影能唯一绑定已确认的字段或指标表达式时提供的列头说明。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_label: Option<String>,
    pub encoding: String,
    pub name: String,
    #[serde(rename = "type")]
    pub result_column_type: String,
    /// 从查询所选的已确认结构取得的业务单位，可独立于列头说明展示。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
}

/// 应用对当前有权结果页计算的统计；历史客户端可省略。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResultStatistics {
    pub columns: Vec<ResultColumnStatistics>,
    pub distinct_comparison: DistinctComparison,
    pub row_count: i64,
    /// 只有从offset=0取得完整且未截断的结果才是complete_result；page不能外推为全部结果。
    pub scope: ResultStatisticsScope,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResultColumnStatistics {
    pub column_index: i64,
    pub column_name: String,
    /// 不含NULL，按平台返回的原始文本去重；不模拟数据库排序规则。
    pub distinct_count: i64,
    /// 当前统计范围的最大非空值，保留原始表示。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max: Option<String>,
    /// 当前统计范围的最小非空值，保留原始表示。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<String>,
    pub non_null_count: i64,
    pub null_count: i64,
    pub numeric_counts: Option<NumericValueCounts>,
    /// 本统计范围中出现超过一次的非NULL原始文本及次数；与distinct_count使用相同比较规则，不能推断跨页重复。
    pub repeated_values: Vec<RepeatedResultValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NumericValueCounts {
    pub negative: i64,
    pub positive: i64,
    pub zero: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepeatedResultValue {
    pub count: i64,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisReport {
    pub charts: Vec<AnalysisReportChart>,
    pub created_at: String,
    pub evidence: Vec<AnalysisEvidence>,
    pub reference: AnalysisReportRef,
    pub schema_version: i64,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisEvidence {
    pub conditions: Conditions,
    pub data_range: String,
    pub findings: Vec<AnalysisFinding>,
    pub reference: AnalysisEvidenceRef,
    pub schema_version: i64,
    pub source_message_id: String,
    pub validated_sources: AnalysisEvidenceSources,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisEvidenceSources {
    pub knowledge_refs: Vec<EvidenceRef>,
    pub query_coverage: Vec<AnalysisQueryCoverage>,
    pub result_dependencies: Vec<AnalysisResultDependency>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisQueryCoverage {
    pub query_id: String,
    pub received_rows: i32,
    pub result_complete: bool,
    pub result_ref: String,
    pub saved_result_complete: bool,
    pub saved_row_count: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadAnalysisReportInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<i32>,
    pub task_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", deny_unknown_fields)]
pub enum AnalysisReportPage {
    #[serde(rename = "available")]
    Available {
        reference: AnalysisReportRef,
        title: String,
        evidence_ids: Vec<String>,
        charts: Vec<AnalysisReportChart>,
        content_text: String,
        content_page: ContentPage,
    },
    #[serde(rename = "condition_changed")]
    ConditionChanged {
        reference: Option<AnalysisReportRef>,
    },
    #[serde(rename = "sources_unavailable")]
    SourcesUnavailable {
        reference: Option<AnalysisReportRef>,
    },
    #[serde(rename = "historical")]
    Historical {
        historical_analysis: FluffyHistoricalAnalysis,
        reference: AnalysisReportRef,
        content_text: String,
        content_page: ContentPage,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FluffyHistoricalAnalysis {
    pub actual_sources: HashMap<String, Option<serde_json::Value>>,
    pub conditions: Vec<HashMap<String, Option<serde_json::Value>>>,
    pub content_fingerprint: String,
    pub evidence: Vec<HashMap<String, Option<serde_json::Value>>>,
    pub generated_at: String,
    pub kind: HistoricalAnalysisKind,
    pub reference: Option<AnalysisReportRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrepareSkillDraftInput {
    /// Skill 的正文及生成资源每行最多 51200 UTF-8 字节；超限须分行保存。记忆不受此行限制。
    pub body: String,
    pub condition_version: String,
    pub evidence_ids: Vec<String>,
    pub files: Vec<SkillFile>,
    pub instruction_quote: String,
    pub name: String,
    pub scope: String,
    pub task_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillDraftList {
    pub drafts: Vec<SkillDraft>,
    pub next_after_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", deny_unknown_fields)]
pub enum SkillDraft {
    #[serde(rename = "pending")]
    Pending {
        reference: SkillDraftRef,
        name: String,
        body: String,
        scope: String,
        files: Vec<SkillFile>,
        dependencies: Vec<EvidenceRef>,
        evidence_refs: Vec<AnalysisEvidenceRef>,
        created_at: String,
    },
    #[serde(rename = "confirmed")]
    Confirmed {
        reference: SkillDraftRef,
        asset_id: String,
    },
    #[serde(rename = "condition_changed")]
    ConditionChanged { reference: SkillDraftRef },
    #[serde(rename = "sources_unavailable")]
    SourcesUnavailable { reference: SkillDraftRef },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillDraftRef {
    pub condition_version: String,
    pub conversation_id: String,
    pub draft_id: String,
    pub source_message_id: String,
    pub task_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MaintenanceImpactQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after_id: Option<String>,
    pub expected_version: String,
    pub kind: MaintenanceImpactKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MaintenanceImpact {
    pub items: Vec<MaintenanceDependent>,
    pub kind: MaintenanceImpactKind,
    pub next_after_id: Option<String>,
    pub scope: MaintenanceImpactScope,
    pub target: FluffyMaintenanceTarget,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MaintenanceDependent {
    pub can_edit: bool,
    pub id: String,
    pub kind: MaintenanceDependentKind,
    pub name: String,
    pub references: Vec<MaintenanceReference>,
    pub references_complete: bool,
    pub state: MaintenanceDependentState,
    pub version: String,
    pub visibility: Visibility,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MaintenanceReference {
    pub dependent_path: String,
    pub reference_state: ReferenceState,
    pub referenced_path: Option<String>,
    pub referenced_version: Option<String>,
    pub relation_kind: RelationKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FluffyMaintenanceTarget {
    pub object_id: String,
    pub state: MaintenanceDependentState,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResultContent {
    pub content_format: ContentFormat,
    pub content_page: FluffyQueryResultContentRange,
    pub content_text: String,
    pub query_id: String,
    pub result_ref: String,
    pub view: AgentQueryResultsView,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FluffyQueryResultContentRange {
    pub complete: bool,
    pub next_offset: Option<i64>,
    pub offset: i64,
    pub total_chars: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResultStatisticsRead {
    pub fetched_offset: String,
    pub next_cursor: Option<String>,
    pub query_id: String,
    pub result_ref: String,
    pub saved_result_complete: bool,
    pub saved_row_count: i64,
    pub statistics: ResultStatistics,
    pub truncated: bool,
    pub view: QueryResultStatisticsReadView,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResultCellRead {
    pub column: ResultColumn,
    pub column_index: i64,
    pub query_id: String,
    pub result_ref: String,
    pub row_index: i64,
    pub value: Option<String>,
    pub view: QueryResultCellReadView,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentQueryResults {
    pub columns: Option<Vec<ResultColumn>>,
    pub data_freshness: Option<String>,
    pub fetched_offset: Option<String>,
    pub next_cursor: Option<String>,
    pub query_id: String,
    pub result_complete: Option<bool>,
    pub result_ref: String,
    pub rows: Option<Vec<Vec<Option<String>>>>,
    pub saved_result_complete: Option<bool>,
    pub saved_row_count: Option<i64>,
    pub source: Option<String>,
    /// 应用对当前有权结果页计算的统计；历史客户端可省略。
    pub statistics: Option<ResultStatistics>,
    pub truncated: Option<bool>,
    pub view: Option<AgentQueryResultsView>,
    pub column: Option<ResultColumn>,
    pub column_index: Option<i64>,
    pub row_index: Option<i64>,
    pub value: Option<String>,
    pub content_format: Option<ContentFormat>,
    pub content_page: Option<FluffyQueryResultContentRange>,
    pub content_text: Option<String>,
}

///
/// 新格式仅记录已经采用的解释。explicit_user引用本轮完整原话，null/省略采纳身份由宿主绑定；原已核对象可同文继承。未决只登记clarifications，无问题且条件充分时不要求本对象。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdoptedSemanticResolution {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adoption_message_id: Option<String>,
    pub basis: SemanticResolutionBasisEnum,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence_refs: Option<Vec<EvidenceRef>>,
    pub interpretation: String,
    pub user_quote: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CurrentAnalysisUpdate {
    pub action: AnalysisUpdateAction,
    /// 同一任务需分别回答的独立问题，各生成独立ID；与非空question互斥，不同目标分别建任务。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clarifications: Option<Vec<ClarificationRequest>>,
    ///
    /// 修改已存任务条件时必填，action用revise或clarify；set指定新值，unset可省略（省略即不清空任何字段，null非法）。route禁止携带condition_patch，因为route只登记归属。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub condition_patch: Option<FluffyConditionPatch>,
    /// 新建任务必须完整给出；未指定的可空标量用JSON null，列表用[]，notes用空字符串，timezone按宿主业务时区。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conditions: Option<FluffyConditions>,
    /// 新建任务省略此字段（也接受JSON null）；已有任务必须提供工具回执中的当前版本数字字符串。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_version: Option<String>,
    ///
    /// 仅route可用：显式定稿当前任务已完成的说明或查询答案；可route到同一任务保留其SQL等待状态，也可切到其他目标。该助手消息只允许这个route；宿主绑定完整正文或原成功答案回执。普通route不定稿，不授执行权。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finalize_current_answer: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub goal: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub legacy_resolution_migration: Option<LegacyResolutionMigration>,
    /// split迁移到新独立目标的原开放问题ID，保留问题正文与来源，其余原目标问题不动。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub moved_clarification_ids: Option<Vec<String>>,
    /// 澄清问题的候选答案；仅与实际question同用，开放回答可无候选（空数组或省略）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<String>>,
    /// 需要用户补充的实际问题；无需澄清时省略（也接受JSON null），不能填字符串null、空文本或用户原问题。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replaces_query_id: Option<String>,
    ///
    /// 本消息中用户已真实回答，或当前有效且获准资料已唯一解决的事实问题ID；事实解决须在同次revise保存条件与依据，不能伪称用户选择。省略或[]保留其他问题，仅已有任务revise/clarify可用。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_clarification_ids: Option<Vec<String>>,
    /// 新建任务省略此字段（也接受JSON null）；已有任务用工具回执中的真实ID，不能填字符串null。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
}

///
/// 修改已存任务条件时必填，action用revise或clarify；set指定新值，unset可省略（省略即不清空任何字段，null非法）。route禁止携带condition_patch，因为route只登记归属。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FluffyConditionPatch {
    pub set: TentacledConditionSet,
    /// 清除指定条件字段。省略即空集合（不清空任何字段），null非法；显式数组仍清除列出的字段。
    pub unset: Option<Vec<Unset>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TentacledConditionSet {
    pub channel: Option<ConditionsChannel>,
    pub filters: Option<Vec<String>>,
    pub group_by: Option<Vec<String>>,
    pub knowledge_refs: Option<Vec<EvidenceRef>>,
    pub metric: Option<String>,
    pub notes: Option<String>,
    /// 只更新已采用解释及来源；null/unset只清说明，不解决开放问题。旧未决通过明确legacy_resolution_migration转换。
    pub semantic_resolution: Option<TentacledSemanticResolution>,
    /// 设置来源限制；撤销使用unset source_limits，不接受设为空集。
    #[serde(
        default,
        deserialize_with = "deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub source_limits: Option<Option<SourceLimits>>,
    /// 修改区间的不包含终点，按业务时区解析后填写UTC完整时间戳，以Z结尾；整月结束为下一月起点。清空使用unset；未修改则省略。
    pub time_end: Option<String>,
    /// 整体替换时间口径角色；清空使用unset。
    pub time_roles: Option<Vec<TimeRole>>,
    /// 修改区间的包含起点，按业务时区解析后填写UTC完整时间戳，以Z结尾。清空使用unset；未修改则省略。
    pub time_start: Option<String>,
    pub timezone: Option<String>,
}

///
/// 新格式仅记录已经采用的解释。explicit_user引用本轮完整原话，null/省略采纳身份由宿主绑定；原已核对象可同文继承。未决只登记clarifications，无问题且条件充分时不要求本对象。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TentacledSemanticResolution {
    ///
    /// explicit_user：null=本轮新采纳，由宿主核对user_quote为本轮完整原话后绑定真实消息身份；非空=复制继承原已验证决策的消息身份，不接受模型自由填写。其余basis为null。
    pub adoption_message_id: Option<String>,
    /// 真实用户明确选择、确无实质歧义、或仍需澄清；资料支持某公式不等于用户选择它。
    pub basis: SemanticResolutionBasisEnum,
    /// 支撑该口径决策的依据引用；旧调用缺失按空数组解码。
    pub evidence_refs: Option<Vec<EvidenceRef>>,
    /// 本稿采用的指标、分子/分母、时间等关键口径及选择依据；不能把自己刚写入任务的假设当作用户采用。
    pub interpretation: String,
    /// explicit_user逐字填写本条真实用户完整原话，保留否定、前提、例外和换行，不截取子串；其余为null。
    pub user_quote: Option<String>,
}

/// 新建任务必须完整给出；未指定的可空标量用JSON null，列表用[]，notes用空字符串，timezone按宿主业务时区。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FluffyConditions {
    pub channel: Option<ConditionsChannel>,
    pub filters: Vec<String>,
    pub group_by: Vec<String>,
    pub knowledge_refs: Vec<EvidenceRef>,
    pub metric: Option<String>,
    pub notes: String,
    /// 当前格式仅记录已采用解释及依据，未决由clarifications表达；省略继承，null只清说明，未要求所有任务填写。旧形状按宿主持久格式标记兼容，读取不迁移。
    pub semantic_resolution: Option<StickySemanticResolution>,
    /// null表示本题显式未声明额外来源限制；字段缺失表示旧条件版本未记录新式限制，不能证明用户从未限制。撤销必须显式unset并来自真实用户修改。
    #[serde(
        default,
        deserialize_with = "deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub source_limits: Option<Option<SourceLimits>>,
    /// 时间区间的不包含终点。按明确的业务时区解析后转为UTC完整时间戳，以Z结尾；整月结束为下一月起点，不能写本月最后一天。未指定时为null。
    pub time_end: Option<String>,
    /// 时间口径角色；统计起止仍沿time_start/time_end，request_clock和平台data_freshness不冒充用户截点。字段缺失表示旧版本未记录。
    pub time_roles: Option<Vec<TimeRole>>,
    /// 时间区间的包含起点。按明确的业务时区解析后转为UTC完整时间戳，以Z结尾；不能只写日期。未指定时为null。
    pub time_start: Option<String>,
    pub timezone: String,
}

///
/// 新格式仅记录已经采用的解释。explicit_user引用本轮完整原话，null/省略采纳身份由宿主绑定；原已核对象可同文继承。未决只登记clarifications，无问题且条件充分时不要求本对象。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StickySemanticResolution {
    ///
    /// explicit_user：null=本轮新采纳，由宿主核对user_quote为本轮完整原话后绑定真实消息身份；非空=复制继承原已验证决策的消息身份，不接受模型自由填写。其余basis为null。
    pub adoption_message_id: Option<String>,
    /// 真实用户明确选择、确无实质歧义、或仍需澄清；资料支持某公式不等于用户选择它。
    pub basis: SemanticResolutionBasisEnum,
    /// 支撑该口径决策的依据引用；旧调用缺失按空数组解码。
    pub evidence_refs: Option<Vec<EvidenceRef>>,
    /// 本稿采用的指标、分子/分母、时间等关键口径及选择依据；不能把自己刚写入任务的假设当作用户采用。
    pub interpretation: String,
    /// explicit_user逐字填写本条真实用户完整原话，保留否定、前提、例外和换行，不截取子串；其余为null。
    pub user_quote: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CurrentRequestQueryInput {
    pub condition_version: String,
    pub knowledge_refs: Vec<EvidenceRef>,
    pub parameters: HashMap<String, Option<serde_json::Value>>,
    pub replaces_query_id: Option<String>,
    /// 省略继承目标条件版本已有采纳说明；兼容携带只核同义声明，不能独立另作决定。新任务未决定时登记clarifications，改变解释先同次修订条件。旧形状仅沿旧格式兼容。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub semantic_resolution: Option<IndecentSemanticResolution>,
    pub sql: String,
    pub summary: String,
    pub target_id: TargetId,
    pub task_id: String,
}

/// 旧未决形状与新采纳说明仅在兼容边界解码；实际条件格式由宿主decision_state_version决定。
///
/// 省略继承目标条件版本已有采纳说明；兼容携带只核同义声明，不能独立另作决定。新任务未决定时登记clarifications，改变解释先同次修订条件。旧形状仅沿旧格式兼容。
///
///
/// 新格式仅记录已经采用的解释。explicit_user引用本轮完整原话，null/省略采纳身份由宿主绑定；原已核对象可同文继承。未决只登记clarifications，无问题且条件充分时不要求本对象。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndecentSemanticResolution {
    ///
    /// explicit_user：null=本轮新采纳，由宿主核对user_quote为本轮完整原话后绑定真实消息身份；非空=复制继承原已验证决策的消息身份，不接受模型自由填写。其余basis为null。
    pub adoption_message_id: Option<String>,
    /// 真实用户明确选择、确无实质歧义、或仍需澄清；资料支持某公式不等于用户选择它。
    pub basis: SemanticResolutionBasisEnum,
    /// 支撑该口径决策的依据引用；旧调用缺失按空数组解码。
    pub evidence_refs: Option<Vec<EvidenceRef>>,
    /// 本稿采用的指标、分子/分母、时间等关键口径及选择依据；不能把自己刚写入任务的假设当作用户采用。
    pub interpretation: String,
    /// explicit_user逐字填写本条真实用户完整原话，保留否定、前提、例外和换行，不截取子串；其余为null。
    pub user_quote: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuerySemanticResolution {
    ///
    /// explicit_user：null=本轮新采纳，由宿主核对user_quote为本轮完整原话后绑定真实消息身份；非空=复制继承原已验证决策的消息身份，不接受模型自由填写。其余basis为null。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adoption_message_id: Option<String>,
    /// 真实用户明确选择、确无实质歧义、或仍需澄清；资料支持某公式不等于用户选择它。
    pub basis: SemanticResolutionBasis,
    /// 支撑该口径决策的依据引用；旧调用缺失按空数组解码。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence_refs: Option<Vec<EvidenceRef>>,
    /// 本稿采用的指标、分子/分母、时间等关键口径及选择依据；不能把自己刚写入任务的假设当作用户采用。
    pub interpretation: String,
    /// 仍会改变答案且未获选择的分子、分母、时间归属等差异；有差异必须先澄清，不能默认写稿。
    pub unresolved_differences: Vec<String>,
    /// explicit_user逐字填写本条真实用户完整原话，保留否定、前提、例外和换行，不截取子串；其余为null。
    pub user_quote: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveModelService {
    pub api: Api,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    pub base_url: String,
    pub enabled: bool,
    pub expected_version: String,
    pub id: String,
    pub name: String,
    pub provider_id: ProviderId,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveModelDefinition {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anthropic_thinking_mode: Option<AnthropicThinkingMode>,
    /// 窗口能力来源：SDK目录或管理员声明；目录外型号不猜窗口。
    pub capability_source: CapabilitySource,
    /// 总上下文tokens；与输入/输出策略分开表达。
    pub context_window: i32,
    pub default_thinking: ThinkingLevel,
    pub enabled: bool,
    pub expected_version: String,
    pub id: String,
    pub input_limit: i32,
    pub input_rate: String,
    pub label: String,
    pub model_id: String,
    pub output_limit: i32,
    pub output_rate: String,
    pub payload_bytes_limit: i32,
    pub reasoning_supported: bool,
    /// 单次provider请求超时毫秒，随模型修订冻结；历史缺字段按90000处理。
    pub request_timeout_ms: i32,
    pub service_id: String,
    pub thinking_levels: Vec<ThinkingLevel>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelConfigurationAccess {
    pub can_manage_models: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelConfiguration {
    pub default_model_id: Option<String>,
    pub models: Vec<ModelDefinition>,
    pub services: Vec<ModelService>,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelDefinition {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anthropic_thinking_mode: Option<AnthropicThinkingMode>,
    /// 窗口能力来源：SDK目录或管理员声明；目录外型号不猜窗口。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capability_source: Option<CapabilitySource>,
    /// 总上下文tokens；与输入/输出策略分开表达。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<i32>,
    pub default_thinking: ThinkingLevel,
    pub enabled: bool,
    pub id: String,
    pub input_limit: i32,
    pub input_rate: String,
    pub label: String,
    pub model_id: String,
    pub output_limit: i32,
    pub output_rate: String,
    pub payload_bytes_limit: i32,
    pub reasoning_supported: bool,
    /// 单次provider请求超时毫秒，随模型修订冻结；历史缺字段按90000处理。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_timeout_ms: Option<i32>,
    pub service_id: String,
    pub thinking_levels: Vec<ThinkingLevel>,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelService {
    pub api: Api,
    pub base_url: String,
    pub credential_configured: bool,
    pub enabled: bool,
    pub id: String,
    pub name: String,
    pub provider_id: ProviderId,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveDefaultModel {
    pub expected_version: String,
    pub model_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadModelConnection {
    pub lease_epoch: String,
    pub run_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelConnection {
    pub api: Api,
    pub api_key: String,
    pub base_url: String,
    pub provider_id: String,
    pub runtime_provider: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresentAnalysisAnswerInput {
    pub sources: Vec<AnalysisAnswerSource>,
    /// 解释模板，定量结果用{{name}}引用values；正常语义数字（如零分母说明、年份、编号）可以直写，SQL代码块仍不放模板。定性解释必须有依据，不写未经证实的因果。
    pub template: String,
    pub values: Vec<AnalysisAnswerValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisAnswerSource {
    pub columns: Vec<String>,
    pub query_id: String,
    pub result_ref: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisAnswerValue {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<String>,
    /// observation_cutoff/data_batch在同名角色多条时按field_ref对齐声明；缺省要求该角色唯一。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field_ref: Option<String>,
    ///
    /// 展示格式：缺省或raw为原值；decimal为固定小数位；percent只对单个ratio乘100加百分号。decimal/percent必须给precision，raw不接受precision。展示字符串不写回查询结果。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<FluffyFormat>,
    /// observation_cutoff/data_batch绑定草稿时间基准中用户声明的角色值；未声明时不可绑定。
    pub kind: AnalysisAnswerValueKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Metadata>,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameter: Option<String>,
    pub query_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row_index: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub statistic: Option<Statistic>,
}

///
/// 展示格式：缺省或raw为原值；decimal为固定小数位；percent只对单个ratio乘100加百分号。decimal/percent必须给precision，raw不接受precision。展示字符串不写回查询结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FluffyFormat {
    pub precision: Option<i32>,
    pub style: Style,
}

/// 准备数值绑定：不接收template、不返回完整answer_text；成功回执提供bindings与required_suffix，正文由Pi下一次自然生成。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrepareAnalysisAnswerInput {
    pub sources: Vec<AnalysisAnswerSource>,
    pub values: Vec<AnalysisAnswerValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceSyncAccepted {
    pub status: SourceSyncAcceptedStatus,
    pub status_url: String,
    pub sync_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceSyncProgress {
    pub error_code: Option<String>,
    /// 已持久化的可展示失败说明，例如来源的实际大小和上限；旧批次可缺省。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    pub knowledge_index: SourceWorkProgress,
    pub pages_committed: i64,
    pub preparation: SourceWorkProgress,
    pub processed_sources: i64,
    pub raw_index: SourceWorkProgress,
    pub status: SourceSyncAcceptedStatus,
    pub status_url: String,
    pub sync_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceWorkProgress {
    pub completed: i64,
    pub failed: i64,
    pub status: SourceWorkProgressStatus,
    pub total: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceExcerpt {
    pub citation: SourceCitation,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourcePreparationResult {
    pub relations: Vec<PreparedRelation>,
    pub semantic_status: SourcePreparationResultSemanticStatus,
    pub statements: Vec<PreparedStatement>,
    pub unresolved: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreparedRelation {
    pub citations: Vec<SourceCitation>,
    pub key: String,
    pub predicate: Predicate,
    pub scope_text: String,
    pub subject: EvidenceRef,
    pub target: SemanticReference,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreparedStatement {
    pub citations: Vec<SourceCitation>,
    pub key: String,
    pub scope_text: String,
    pub supports: Vec<PreparedSupport>,
    /// 对该陈述已记录必要支持提取范围的明确声明；省略或null保留unknown，semantic_status不代替此字段。
    #[serde(
        default,
        deserialize_with = "deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub supports_complete: Option<Option<bool>>,
    pub target: EvidenceRef,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RefreshRunContext {
    pub checkpoint: Checkpoint,
    pub lease_epoch: String,
    pub run_id: String,
    pub sdk_tool_call_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeBatchEdit {
    pub objects: Vec<KnowledgeEditGroup>,
    pub operation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeEditGroup {
    /// 同一对象内按序应用的条目修改；任一条目校验失败则整批回滚。
    pub edits: Vec<KnowledgeEntryEdit>,
    /// 暂存这些条目时读到的对象版本。
    pub expected_version: String,
    pub object_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeBatchReceipt {
    pub objects: Vec<KnowledgeObject>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkbenchUpdate {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query_list: Option<QueryList>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runs: Option<Vec<RunSnapshot>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tasks: Option<Vec<TaskSnapshot>>,
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
    pub error_details: Option<QueryViewErrorDetailsClass>,
    pub execution_state: String,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub knowledge_refs: Option<Vec<EvidenceRef>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameters: Option<HashMap<String, Option<serde_json::Value>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replaces_query_id: Option<String>,
    pub result_ref: Option<String>,
    /// 草稿工具回执的非阻断诊断；查询读取接口不承诺重现此报告。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub semantic_checks: Option<SemanticCheckReport>,
    /// 保存草稿时的口径决策及依据；旧记录返回null，不从自由文本或模型历史猜回填。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub semantic_resolution: Option<ConditionsQuerySemanticResolution>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sql: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    pub target_id: String,
    pub task_id: String,
    /// 正文按历史记录展示：来源已改版或结果已漂移，但记录仍可核。SQL、参数与说明保留原样，不能作为当前口径或执行依据；需要当前数据须重新确认。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_historical: Option<bool>,
    /// 正文来源失效或无法核实时只返回查询身份和控制状态；SQL、参数、说明、依据及诊断正文均不可返回。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_unavailable: Option<bool>,
    /// 保存草稿时任务条件声明的时间基准；旧草稿返回null。观察截点与批次是用户声明，不得以request_clock或平台data_freshness冒充。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_basis: Option<TimeBasis>,
    /// 原查询首次query_changed事件的持久序号，作为对话时间线中查询卡的稳定锚点；旧记录无对应事件时为null，旧Schema解码兼容可缺省，前端已有值不被后续有限事件页覆盖。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeline_event_seq: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryViewErrorDetailsClass {
    pub code: String,
    pub message: String,
}

/// 草稿工具回执的非阻断诊断；查询读取接口不承诺重现此报告。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SemanticCheckReport {
    pub checks: Vec<FluffyCheck>,
    pub coverage: FluffyCoverage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FluffyCheck {
    pub coverage_limit: String,
    pub evidence_refs: Vec<SemanticEvidenceRef>,
    pub finding: String,
    pub rule: String,
    pub state: CheckState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SemanticEvidenceRef {
    pub object_id: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FluffyCoverage {
    pub missing_semantics: Vec<String>,
    pub sql_shape: SqlShape,
    pub supported_scope: Vec<String>,
    pub unsupported_constructs: Vec<String>,
}

/// 草稿保存时从任务当前条件投影的时间基准；统计起止沿time_start/time_end，观察截点/批次只在time_roles中声明。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimeBasis {
    pub time_end: Option<String>,
    pub time_roles: Vec<TimeRole>,
    pub time_start: Option<String>,
    pub timezone: Option<String>,
}

fn deserialize_present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

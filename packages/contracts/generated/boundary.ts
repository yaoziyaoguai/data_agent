// Generated from packages/contracts/schema.json; do not edit.
export interface Boundary {
    AgentQueryResults?:           AgentQueryResults;
    AnalysisEvidence?:            AnalysisEvidence;
    AnalysisEvidenceRef?:         AnalysisEvidenceRef;
    AnalysisEvidenceSources?:     AnalysisEvidenceSources;
    AnalysisFigure?:              AnalysisFigure;
    AnalysisFinding?:             AnalysisFinding;
    AnalysisPreferenceCommand?:   AnalysisPreferenceCommand;
    AnalysisQueryCoverage?:       AnalysisQueryCoverage;
    AnalysisQueryReference?:      AnalysisQueryReference;
    AnalysisReport?:              AnalysisReport;
    AnalysisReportChart?:         AnalysisReportChart;
    AnalysisReportPage?:          AnalysisReportPage;
    AnalysisReportRef?:           AnalysisReportRef;
    AnalysisReportView?:          AnalysisReportView;
    AnalysisResultDependency?:    AnalysisResultDependency;
    analysisUpdate:               AnalysisUpdate;
    appendOutput:                 AppendOutput;
    appError:                     AppError;
    ApplySemanticCorrection?:     ApplySemanticCorrection;
    asset:                        Asset;
    assetList:                    AssetList;
    AssetPageQuery?:              AssetPageQuery;
    assetSave:                    AssetSave;
    assetToolInput:               AssetToolInput;
    AssignSemanticMaintainer?:    AssignSemanticMaintainer;
    cancelReceipt:                CancelReceipt;
    cancelRun:                    CancelRun;
    CatalogColumn?:               CatalogColumn;
    CatalogNode?:                 CatalogNode;
    CatalogPage?:                 CatalogPage;
    CatalogTable?:                CatalogTable;
    chatMessage:                  ChatMessage;
    checkpoint:                   Checkpoint;
    checkpoint_reference:         CheckpointReference;
    conditions:                   Conditions;
    confirmQuery:                 ConfirmQuery;
    conversationModelSelection:   ConversationModelSelection;
    conversationReadInput:        ConversationReadInput;
    conversationReceipt:          ConversationReceipt;
    ConversationSkillSelection?:  ConversationSkillSelection;
    ConversationSkillSelections?: ConversationSkillSelections;
    createConversation:           CreateConversation;
    dataToolInvocation:           DataToolInvocation;
    dataToolOutcome:              DataToolOutcome;
    embeddingProfile:             EmbeddingProfile;
    event:                        Event;
    evidenceRef:                  EvidenceRef;
    executeQueryInput:            ExecuteQueryInput;
    finalizeModelCall:            FinalizeModelCall;
    finishReceipt:                FinishReceipt;
    finishRun:                    FinishRun;
    GetQueryInput?:               GetQueryInput;
    history:                      History;
    historyItem:                  HistoryItem;
    historyQuery:                 HistoryQuery;
    host_checkpoint_reference:    HostCheckpointReference;
    identity:                     Identity;
    knowledgeCreate:              KnowledgeCreate;
    knowledgeDocument?:           KnowledgeDocument;
    knowledgeDocumentEdit?:       KnowledgeDocumentEdit;
    knowledgeEdit:                KnowledgeEdit;
    knowledgeEntry:               KnowledgeEntry;
    knowledgeList:                KnowledgeList;
    knowledgeListQuery:           KnowledgeListQuery;
    knowledgeObject:              KnowledgeObject;
    KnowledgeRetrieval?:          KnowledgeRetrieval;
    KnowledgeRetrievalExcerpt?:   KnowledgeRetrievalExcerpt;
    logoutReceipt:                LogoutReceipt;
    MaintenanceDependent?:        MaintenanceDependent;
    MaintenanceImpact?:           MaintenanceImpact;
    MaintenanceImpactQuery?:      MaintenanceImpactQuery;
    MaintenanceReference?:        MaintenanceReference;
    memoryBudgetBinding?:         MemoryBudgetBinding;
    memoryCandidate?:             MemoryCandidate;
    memoryExtractionReceipt?:     MemoryExtractionReceipt;
    memoryExtractionRequest?:     MemoryExtractionRequest;
    memoryIndexReceipt?:          MemoryIndexReceipt;
    memoryIndexRequest?:          MemoryIndexRequest;
    memoryModelCall?:             MemoryModelCall;
    memorySearchReceipt?:         MemorySearchReceipt;
    memorySearchRequest?:         MemorySearchRequest;
    messageInput:                 MessageInput;
    messageReceipt:               MessageReceipt;
    modelAttempt:                 ModelAttempt;
    modelCallReceipt:             ModelCallReceipt;
    modelCatalog:                 ModelCatalog;
    modelOption:                  ModelOption;
    modelProfile:                 ModelProfile;
    modelReceipt:                 ModelReceipt;
    modelSelection:               ModelSelection;
    modelUsage:                   ModelUsage;
    mutationReceipt:              MutationReceipt;
    numericValueCounts?:          NumericValueCounts;
    operationReceipt:             OperationReceipt;
    outputReceipt:                OutputReceipt;
    pi_session_reference:         PiSessionReference;
    prefillResult:                PrefillResult;
    PrepareSkillDraftInput?:      PrepareSkillDraftInput;
    proposal:                     Proposal;
    ProposalDraftCommand?:        ProposalDraftCommand;
    proposalInput:                ProposalInput;
    proposalList:                 ProposalList;
    PublishSkill?:                PublishSkill;
    queryCancellation?:           QueryCancellation;
    QueryExampleParameter?:       QueryExampleParameter;
    QueryExampleVerification?:    QueryExampleVerification;
    queryList:                    QueryList;
    QueryResultCellRead?:         QueryResultCellRead;
    QueryResultContent?:          QueryResultContent;
    queryResults:                 QueryResults;
    QueryResultStatisticsRead?:   QueryResultStatisticsRead;
    queryView:                    QueryView;
    read_checkpoint:              ReadCheckpoint;
    ReadAnalysisReportInput?:     ReadAnalysisReportInput;
    readKnowledgeInput:           ReadKnowledgeInput;
    readQueryInput:               ReadQueryInput;
    readSourceInput:              ReadSourceInput;
    readTaskInput?:               ReadTaskInput;
    requestQueryInput:            RequestQueryInput;
    reserveModelCall:             ReserveModelCall;
    resultColumn:                 ResultColumn;
    resultColumnStatistics?:      ResultColumnStatistics;
    resultStatistics?:            ResultStatistics;
    ReviewSemanticCorrection?:    ReviewSemanticCorrection;
    ReviewSkillSuggestion?:       ReviewSkillSuggestion;
    ReviseSemanticCorrection?:    ReviseSemanticCorrection;
    runEnvelope:                  RunEnvelope;
    runSnapshot:                  RunSnapshot;
    SaveAnalysisEvidenceInput?:   SaveAnalysisEvidenceInput;
    SaveAnalysisReport?:          SaveAnalysisReport;
    SaveAnalysisReportInput?:     SaveAnalysisReportInput;
    saveModelSelection:           SaveModelSelection;
    searchInput:                  SearchInput;
    SemanticAccess?:              SemanticAccess;
    SemanticCheckReport?:         SemanticCheckReport;
    SemanticColumnRef?:           SemanticColumnRef;
    SemanticCorrection?:          SemanticCorrection;
    SemanticCorrectionList?:      SemanticCorrectionList;
    SemanticEvidenceRef?:         SemanticEvidenceRef;
    SemanticMaintenance?:         SemanticMaintenance;
    SemanticMemberList?:          SemanticMemberList;
    SemanticStructure?:           SemanticStructure;
    SemanticTableRef?:            SemanticTableRef;
    sendModelCall:                SendModelCall;
    sessionReceipt:               SessionReceipt;
    SkillDraft?:                  SkillDraft;
    SkillDraftList?:              SkillDraftList;
    SkillDraftRef?:               SkillDraftRef;
    SkillFile?:                   SkillFile;
    SkillReadInput?:              SkillReadInput;
    SkillRemovalReceipt?:         SkillRemovalReceipt;
    skillSelection:               SkillSelection;
    SkillSelectionRemoval?:       SkillSelectionRemoval;
    SkillSuggestion?:             SkillSuggestion;
    SkillSuggestionList?:         SkillSuggestionList;
    snapshot:                     Snapshot;
    sourceDocument:               SourceDocument;
    sqlInput:                     SQLInput;
    SubmitSemanticCorrection?:    SubmitSemanticCorrection;
    SuggestSkill?:                SuggestSkill;
    TableAnalysisPreference?:     TableAnalysisPreference;
    taskInput:                    TaskInput;
    taskSnapshot:                 TaskSnapshot;
    thinkingOption:               ThinkingOption;
    toolInvocation:               ToolInvocation;
    toolOutcome:                  ToolOutcome;
    toolReceipt:                  ToolReceipt;
    versionCommand:               VersionCommand;
    workspaceContext:             WorkspaceContext;
    WorkspaceTask?:               WorkspaceTask;
}

export interface AgentQueryResults {
    columns?:               ResultColumn[];
    data_freshness?:        string;
    fetched_offset?:        string;
    next_cursor?:           null | string;
    query_id:               string;
    result_complete?:       boolean;
    result_ref:             string;
    rows?:                  Array<Array<null | string>>;
    saved_result_complete?: boolean;
    saved_row_count?:       number;
    source?:                AgentQueryResultsSource;
    /**
     * 应用对当前有权结果页计算的统计；历史客户端可省略。
     */
    statistics?:     ResultStatistics;
    truncated?:      boolean;
    view?:           AgentQueryResultsView;
    column?:         ResultColumn;
    column_index?:   number;
    row_index?:      number;
    value?:          null | string;
    content_format?: ContentFormat;
    content_page?:   QueryResultContentRange;
    content_text?:   string;
}

export interface ResultColumn {
    encoding: string;
    name:     string;
    type:     string;
}

export type ContentFormat = "json";

export interface QueryResultContentRange {
    complete:    boolean;
    next_offset: number | null;
    offset:      number;
    total_chars: number;
}

export type AgentQueryResultsSource = "mock";

/**
 * 应用对当前有权结果页计算的统计；历史客户端可省略。
 */
export interface ResultStatistics {
    columns:             ResultColumnStatistics[];
    distinct_comparison: DistinctComparison;
    row_count:           number;
    /**
     * 只有从offset=0取得完整且未截断的结果才是complete_result；page不能外推为全部结果。
     */
    scope: ResultStatisticsScope;
}

export interface ResultColumnStatistics {
    column_index: number;
    column_name:  string;
    /**
     * 不含NULL，按平台返回的原始文本去重；不模拟数据库排序规则。
     */
    distinct_count: number;
    non_null_count: number;
    null_count:     number;
    numeric_counts: NumericValueCounts | null;
    /**
     * 本统计范围中出现超过一次的非NULL原始文本及次数；与distinct_count使用相同比较规则，不能推断跨页重复。
     */
    repeated_values: RepeatedResultValue[];
}

export interface NumericValueCounts {
    negative: number;
    positive: number;
    zero:     number;
}

export interface RepeatedResultValue {
    count: number;
    value: string;
}

export type DistinctComparison = "returned_text";

/**
 * 只有从offset=0取得完整且未截断的结果才是complete_result；page不能外推为全部结果。
 */
export type ResultStatisticsScope = "page" | "complete_result";

/**
 * rows默认；statistics独立统计；cell按绝对行列读值。
 */
export type AgentQueryResultsView = "statistics" | "cell" | "rows";

export interface AnalysisEvidence {
    conditions:        Conditions;
    data_range:        string;
    findings:          [AnalysisFinding, ...AnalysisFinding[]];
    reference:         AnalysisEvidenceRef;
    schema_version:    number;
    source_message_id: string;
    validated_sources: AnalysisEvidenceSources;
}

/**
 * 新建任务必须完整给出；未指定的可空标量用JSON null，列表用[]，notes用空字符串，timezone按宿主业务时区。
 */
export interface Conditions {
    channel:        ConditionsChannel | null;
    filters:        string[];
    group_by:       string[];
    knowledge_refs: EvidenceRef[];
    metric:         null | string;
    notes:          string;
    /**
     * 时间区间的不包含终点。按明确的业务时区解析后转为UTC完整时间戳，以Z结尾；整月结束为下一月起点，不能写本月最后一天。未指定时为null。
     */
    time_end: null | string;
    /**
     * 时间区间的包含起点。按明确的业务时区解析后转为UTC完整时间戳，以Z结尾；不能只写日期。未指定时为null。
     */
    time_start: null | string;
    timezone:   string;
}

export type ConditionsChannel = "web" | "app" | "store";

export interface EvidenceRef {
    /**
     * read_knowledge或search_knowledge返回的知识对象id；不是read_source返回的source_id。
     */
    object_id: string;
    /**
     * 该知识对象entries中的path，必须确实存在于对应version。
     */
    path:    string;
    version: string;
}

export interface AnalysisFinding {
    calculation:    string;
    figures:        AnalysisFigure[];
    knowledge_refs: EvidenceRef[];
    limitations:    string[];
    query_refs:     AnalysisQueryReference[];
    text:           string;
}

export interface AnalysisFigure {
    column:    string;
    label:     string;
    query_id:  string;
    row_index: number;
    value:     boolean | number | null | string;
}

export interface AnalysisQueryReference {
    columns:    [string, ...string[]];
    query_id:   string;
    result_ref: string;
}

export interface AnalysisEvidenceRef {
    condition_version:   string;
    conversation_id:     string;
    evidence_id:         string;
    result_dependencies: AnalysisResultDependency[];
    task_id:             string;
}

export interface AnalysisResultDependency {
    query_id:   string;
    result_ref: string;
}

export interface AnalysisEvidenceSources {
    knowledge_refs:      EvidenceRef[];
    query_coverage:      AnalysisQueryCoverage[];
    result_dependencies: AnalysisResultDependency[];
}

export interface AnalysisQueryCoverage {
    query_id:              string;
    received_rows:         number;
    result_complete:       boolean;
    result_ref:            string;
    saved_result_complete: boolean;
    saved_row_count:       number;
}

export interface AnalysisPreferenceCommand {
    expected_version: string;
    operation_id:     string;
    preferred:        boolean;
}

export interface AnalysisReport {
    charts:         AnalysisReportChart[];
    created_at:     string;
    evidence:       [AnalysisEvidence, ...AnalysisEvidence[]];
    reference:      AnalysisReportRef;
    schema_version: number;
    title:          string;
}

export interface AnalysisReportChart {
    dimension_column: string;
    kind:             AnalysisReportChartKind;
    measure_column:   string;
    query_id:         string;
    result_ref:       string;
    title:            string;
}

export type AnalysisReportChartKind = "line" | "bar";

export interface AnalysisReportRef {
    condition_version: string;
    conversation_id:   string;
    report_id:         string;
    task_id:           string;
    version:           string;
}

export type AnalysisReportPage = {
    status: "available";
    reference: AnalysisReportRef;
    title: string;
    evidence_ids: [string, ...string[]];
    charts: AnalysisReportChart[];
    content_text: string;
    content_page: ContentPage;
} | {
    status: "condition_changed";
    reference: AnalysisReportRef | null;
} | {
    status: "sources_unavailable";
    reference: AnalysisReportRef | null;
};

/**
 * 来源原话的独立字符分页。缺省source_text为空但保留总长和补读位置；以entry_id=source_text和同一资产版本读取。
 */
export interface ContentPage {
    complete:    boolean;
    next_offset: number | null;
    offset:      number;
    total_chars: number;
}

export type AnalysisReportPageStatus = "available" | "condition_changed" | "sources_unavailable";

export type AnalysisReportView = {
    status: "available";
    reference: AnalysisReportRef;
    report: AnalysisReport;
    chart_results: QueryResults[];
} | {
    status: "condition_changed";
    reference: AnalysisReportRef | null;
} | {
    status: "sources_unavailable";
    reference: AnalysisReportRef | null;
};

export interface QueryResults {
    columns:                ResultColumn[];
    data_freshness:         string;
    fetched_offset:         string;
    next_cursor:            null | string;
    query_id:               string;
    result_complete:        boolean;
    result_ref:             string;
    rows:                   Array<Array<null | string>>;
    saved_result_complete?: boolean;
    saved_row_count?:       number;
    source:                 AgentQueryResultsSource;
    /**
     * 应用对当前有权结果页计算的统计；历史客户端可省略。
     */
    statistics?: ResultStatistics;
    truncated:   boolean;
}

export interface ApplySemanticCorrection {
    expected_revision: string;
    expected_version:  string;
    operation_id:      string;
    value:             string;
}

export interface AssetPageQuery {
    after_id?: string;
}

export interface AssignSemanticMaintainer {
    expected_version: string;
    /**
     * 超级维护者调整独立对象负责人；null 撤销，不能调整 Datasight 表或字段。
     */
    maintainer_id: null | string;
    operation_id:  string;
}

export interface CatalogColumn {
    comment:   string;
    data_type: string;
    id:        string;
    name:      string;
    nullable:  boolean;
}

export interface CatalogNode {
    id:           string;
    sql:          string;
    upstream_ids: string[];
}

export interface CatalogPage {
    /**
     * true表示该snapshot覆盖完整命名空间，可在全部分页成功后使缺席对象失效；false不允许推断删除。
     */
    authoritative:    boolean;
    complete:         boolean;
    next_cursor:      null | string;
    schema_version:   number;
    snapshot_id:      string;
    source_namespace: string;
    tables:           CatalogTable[];
}

export interface CatalogTable {
    columns: [CatalogColumn, ...CatalogColumn[]];
    comment: string;
    ddl:     string;
    id:      string;
    /**
     * Datasight 维护人；未提供或 null 表示暂无负责人，不继承录入者。
     */
    maintainer_id?:   null | string;
    name:             string;
    node:             CatalogNode | null;
    platform_version: string;
}

export interface ConversationSkillSelection {
    asset_id:         string;
    availability:     Availability;
    current_version:  null | string;
    name:             null | string;
    owner_id:         null | string;
    selected_version: string;
    selection_id:     string;
    visibility:       Visibility | null;
}

export type Availability = "available" | "version_changed" | "disabled" | "dependency_unavailable" | "unavailable";

export type Visibility = "personal" | "space";

export interface ConversationSkillSelections {
    change_blocked:  boolean;
    conversation_id: string;
    next_after_id:   null | string;
    selections:      ConversationSkillSelection[];
}

export interface GetQueryInput {
    column_index?: number;
    /**
     * 超长JSON片段续读的Unicode字符偏移。
     */
    content_offset?: number;
    cursor?:         null | string;
    query_id:        string;
    row_index?:      number;
    /**
     * rows默认；statistics独立统计；cell按绝对行列读值。
     */
    view?: AgentQueryResultsView;
}

export interface KnowledgeRetrieval {
    channel?: KnowledgeRetrievalChannel;
    excerpts: KnowledgeRetrievalExcerpt[];
    note:     string;
    state:    KnowledgeRetrievalState;
}

export type KnowledgeRetrievalChannel = "lexical" | "vector";

export interface KnowledgeRetrievalExcerpt {
    entry_id:    string;
    length:      number;
    offset:      number;
    path:        string;
    text:        string;
    total_chars: number;
}

export type KnowledgeRetrievalState = "located" | "unlocated";

export interface MaintenanceDependent {
    can_edit:            boolean;
    id:                  string;
    kind:                MaintenanceDependentKind;
    name:                string;
    references:          [MaintenanceReference, ...MaintenanceReference[]];
    references_complete: boolean;
    state:               MaintenanceDependentState;
    version:             string;
    visibility:          Visibility;
}

export type MaintenanceDependentKind = "table" | "field" | "metric" | "document" | "relationship" | "term" | "query_example" | "skill";

export interface MaintenanceReference {
    dependent_path:     string;
    reference_state:    ReferenceState;
    referenced_path:    null | string;
    referenced_version: null | string;
    relation_kind:      RelationKind;
}

export type ReferenceState = "current" | "version_changed" | "unavailable" | "related";

export type RelationKind = "structure" | "source_material" | "query_example" | "skill" | "related";

/**
 * 仅用于管理目录；省略时包含启用及停用，始终排除已删除对象。
 */
export type MaintenanceDependentState = "enabled" | "disabled";

export interface MaintenanceImpact {
    items:         MaintenanceDependent[];
    kind:          MaintenanceImpactKind;
    next_after_id: null | string;
    scope:         MaintenanceImpactScope;
    target:        MaintenanceTarget;
}

export type MaintenanceImpactKind = "knowledge" | "skill";

export type MaintenanceImpactScope = "direct_explicit_references";

export interface MaintenanceTarget {
    object_id: string;
    state:     MaintenanceDependentState;
    version:   string;
}

export interface MaintenanceImpactQuery {
    after_id?:        string;
    expected_version: string;
    kind:             MaintenanceImpactKind;
}

export interface PrepareSkillDraftInput {
    /**
     * Skill 的正文及生成资源每行最多 51200 UTF-8 字节；超限须分行保存。记忆不受此行限制。
     */
    body:              string;
    condition_version: string;
    evidence_ids:      [string, ...string[]];
    files:             SkillFile[];
    instruction_quote: string;
    name:              string;
    scope:             string;
    task_id:           string;
}

export interface SkillFile {
    /**
     * UTF-8 文本；每行最多 51200 字节，业务边界校验并返回 skill_line_too_long。
     */
    content: string;
    path:    string;
}

export interface ProposalDraftCommand {
    base_version: string;
    entry_id:     string;
    evidence:     [EvidenceRef, ...EvidenceRef[]];
    object_id:    string;
    operation_id: string;
    reason:       string;
    value:        string;
}

export interface PublishSkill {
    expected_version: string;
    operation_id:     string;
    share_confirmed:  boolean;
}

export interface QueryExampleParameter {
    description: string;
    name:        string;
    required:    boolean;
    type:        QueryExampleParameterType;
}

export type QueryExampleParameterType = "string" | "number" | "integer" | "boolean";

export interface QueryExampleVerification {
    evidence_refs: [EvidenceRef, ...EvidenceRef[]];
    note:          string;
}

export interface QueryResultCellRead {
    column:       ResultColumn;
    column_index: number;
    query_id:     string;
    result_ref:   string;
    row_index:    number;
    value:        null | string;
    view:         QueryResultCellReadView;
}

export type QueryResultCellReadView = "cell";

export interface QueryResultContent {
    content_format: ContentFormat;
    content_page:   QueryResultContentRange;
    content_text:   string;
    query_id:       string;
    result_ref:     string;
    view:           AgentQueryResultsView;
}

export interface QueryResultStatisticsRead {
    fetched_offset:        string;
    next_cursor:           null | string;
    query_id:              string;
    result_ref:            string;
    saved_result_complete: boolean;
    saved_row_count:       number;
    statistics:            ResultStatistics;
    truncated:             boolean;
    view:                  QueryResultStatisticsReadView;
}

export type QueryResultStatisticsReadView = "statistics";

export interface ReadAnalysisReportInput {
    limit?:   number;
    offset?:  number;
    task_id:  string;
    version?: string;
}

export interface ReviewSemanticCorrection {
    decision:          Decision;
    expected_revision: string;
    operation_id:      string;
    reason:            string;
}

export type Decision = "accepted" | "rejected";

export interface ReviewSkillSuggestion {
    expected_revision: string;
    operation_id:      string;
    response:          string;
    state:             ReviewSkillSuggestionState;
}

export type ReviewSkillSuggestionState = "handled" | "rejected";

export interface ReviseSemanticCorrection {
    base_version:      string;
    entry_id:          string;
    evidence:          [EvidenceRef, ...EvidenceRef[]];
    expected_revision: string;
    object_id:         string;
    operation_id:      string;
    reason:            string;
    share_confirmed:   boolean;
    value:             string;
}

export interface SaveAnalysisEvidenceInput {
    condition_version: string;
    data_range:        string;
    findings:          [AnalysisFinding, ...AnalysisFinding[]];
    task_id:           string;
}

export interface SaveAnalysisReport {
    charts:            AnalysisReportChart[];
    condition_version: string;
    evidence_ids:      [string, ...string[]];
    expected_version:  null | string;
    operation_id:      string;
    task_id:           string;
    title:             string;
}

export interface SaveAnalysisReportInput {
    charts:            AnalysisReportChart[];
    condition_version: string;
    evidence_ids:      [string, ...string[]];
    expected_version:  null | string;
    task_id:           string;
    title:             string;
}

export interface SemanticAccess {
    can_admin: boolean;
    /**
     * 可创建独立指标、文档等；由当前空间已同步的 Datasight 表维护关系或超级维护者角色确定。
     */
    can_create: boolean;
    /**
     * 当前空间用于展示的最高语义角色。超级维护者优先；负责表或独立语义对象则为维护者；其余为普通用户。该摘要不授予权限，独立对象负责人不一定有创建资格。
     */
    highest_role: HighestRole;
}

/**
 * 当前空间用于展示的最高语义角色。超级维护者优先；负责表或独立语义对象则为维护者；其余为普通用户。该摘要不授予权限，独立对象负责人不一定有创建资格。
 */
export type HighestRole = "user" | "maintainer" | "super_maintainer";

/**
 * 草稿工具回执的非阻断诊断；查询读取接口不承诺重现此报告。
 */
export interface SemanticCheckReport {
    checks:   Check[];
    coverage: Coverage;
}

export interface Check {
    coverage_limit: string;
    evidence_refs:  SemanticEvidenceRef[];
    finding:        string;
    rule:           string;
    state:          CheckState;
}

export interface SemanticEvidenceRef {
    object_id: string;
    version:   string;
}

export type CheckState = "checked" | "warning" | "not_checked";

export interface Coverage {
    missing_semantics:      string[];
    sql_shape:              SQLShape;
    supported_scope:        string[];
    unsupported_constructs: string[];
}

export type SQLShape = "supported" | "unsupported";

export interface SemanticColumnRef {
    column:    string;
    object_id: string;
    version:   string;
}

export interface SemanticCorrection {
    /**
     * Datasight 维护人；未提供或 null 表示暂无负责人，不继承录入者。
     */
    applied_by:      null | string;
    applied_value:   null | string;
    applied_version: null | string;
    base_version:    string;
    can_review:      boolean;
    can_revise:      boolean;
    entry_id:        string;
    evidence:        [EvidenceRef, ...EvidenceRef[]];
    id:              string;
    object_id:       string;
    original_value:  string;
    reason:          string;
    review_reason:   null | string;
    /**
     * Datasight 维护人；未提供或 null 表示暂无负责人，不继承录入者。
     */
    reviewer_id:  null | string;
    revision:     string;
    state:        SemanticCorrectionState;
    submitter_id: string;
    value:        string;
}

export type SemanticCorrectionState = "submitted" | "accepted" | "rejected" | "applied";

export interface SemanticCorrectionList {
    corrections:   SemanticCorrection[];
    next_after_id: null | string;
}

export interface SemanticMaintenance {
    authority_id: string;
    can_assign:   boolean;
    can_edit:     boolean;
    /**
     * 当前对象负责人：表来自 Datasight；独立人工对象默认创建者，超级维护者可调整。
     */
    maintainer_id: null | string;
    source:        SemanticMaintenanceSource;
    version:       string;
}

export type SemanticMaintenanceSource = "datasight" | "creator" | "system";

export interface SemanticMemberList {
    user_ids: string[];
}

export type SemanticStructure = {
    kind: "table";
    grain: string;
    unique_keys: Array<[string, ...string[]]>;
    time_columns: TimeColumn[];
    default_filters: string[];
    constraints: string[];
} | {
    kind: "field";
    table: SemanticTableRef;
    column: string;
    unit: null | string;
} | {
    kind: "relationship";
    left_table: SemanticTableRef;
    right_table: SemanticTableRef;
    join_keys: [JoinKey, ...JoinKey[]];
    cardinality: Cardinality;
    scope: string;
} | {
    kind: "metric";
    table: SemanticTableRef;
    expression: string;
    input_grain: string;
    time_column: null | string;
    unit: null | string;
    required_filters: string[];
    dimensions: string[];
} | {
    kind: "query_example";
    applicable_question: string;
    parameters: QueryExampleParameter[];
    sql: string;
    grain: string;
    dependencies: [EvidenceRef, ...EvidenceRef[]];
    verification: QueryExampleVerification | null;
};

export type Cardinality = "one_to_one" | "one_to_many" | "many_to_one" | "many_to_many";

export interface JoinKey {
    left_column:  string;
    right_column: string;
}

export type SemanticStructureKind = "table" | "field" | "relationship" | "metric" | "query_example";

export interface SemanticTableRef {
    object_id: string;
    version:   string;
}

export interface TimeColumn {
    column: string;
    role:   string;
}

export type SkillDraft = {
    status: "pending";
    reference: SkillDraftRef;
    name: string;
    body: string;
    scope: string;
    files: SkillFile[];
    dependencies: EvidenceRef[];
    evidence_refs: [AnalysisEvidenceRef, ...AnalysisEvidenceRef[]];
    created_at: string;
} | {
    status: "confirmed";
    reference: SkillDraftRef;
    asset_id: string;
} | {
    status: "condition_changed";
    reference: SkillDraftRef;
} | {
    status: "sources_unavailable";
    reference: SkillDraftRef;
};

export interface SkillDraftRef {
    condition_version: string;
    conversation_id:   string;
    draft_id:          string;
    source_message_id: string;
    task_id:           string;
}

export type SkillDraftStatus = "pending" | "confirmed" | "condition_changed" | "sources_unavailable";

export interface SkillDraftList {
    drafts:        SkillDraft[];
    next_after_id: null | string;
}

export interface SkillReadInput {
    limit?:  number;
    offset?: number;
    path:    string;
}

export interface SkillRemovalReceipt {
    asset_id:        string;
    conversation_id: string;
    operation_id:    string;
    selection_id:    string;
    state:           SkillRemovalReceiptState;
}

export type SkillRemovalReceiptState = "removed";

export interface SkillSelectionRemoval {
    asset_id:     string;
    operation_id: string;
    selection_id: string;
}

export interface SkillSuggestion {
    asset_id:      string;
    asset_version: string;
    author_id:     string;
    content:       string;
    id:            string;
    response:      string;
    reviewed_by:   null | string;
    revision:      string;
    state:         SkillSuggestionState;
}

export type SkillSuggestionState = "pending" | "handled" | "rejected";

export interface SkillSuggestionList {
    next_after_id: null | string;
    suggestions:   SkillSuggestion[];
}

export interface SubmitSemanticCorrection {
    base_version:    string;
    entry_id:        string;
    evidence:        [EvidenceRef, ...EvidenceRef[]];
    object_id:       string;
    operation_id:    string;
    reason:          string;
    share_confirmed: boolean;
    value:           string;
}

export interface SuggestSkill {
    content:          string;
    expected_version: string;
    operation_id:     string;
    share_confirmed:  boolean;
}

export interface TableAnalysisPreference {
    preferred: boolean;
    table_id:  string;
    version:   string;
}

export interface WorkspaceTask {
    evidence_refs?: AnalysisEvidenceRef[];
    report_ref?:    AnalysisReportRef;
    [property: string]: unknown;
}

export interface AnalysisUpdate {
    action: AnalysisUpdateAction;
    /**
     *
     * 修改已存任务条件时必填，action用revise或clarify；set指定新值，unset必须提供（不清空时为[]）。route禁止携带condition_patch，因为route只登记归属。
     */
    condition_patch?: ConditionPatch;
    /**
     * 新建任务必须完整给出；未指定的可空标量用JSON null，列表用[]，notes用空字符串，timezone按宿主业务时区。
     */
    conditions?: Conditions;
    /**
     * 新建任务省略此字段（也接受JSON null）；已有任务必须提供工具回执中的当前版本数字字符串。
     */
    expected_version?: null | string;
    goal:              string;
    /**
     * 澄清问题的候选答案；question=null时传[]。
     */
    options: string[];
    /**
     * 需要用户补充的实际问题；无需澄清时省略（也接受JSON null），不能填字符串null、空文本或用户原问题。
     */
    question?:          null | string;
    replaces_query_id?: null | string;
    /**
     * 本消息已回答的真实问题ID；省略或[]保留全部未答问题，仅已有任务revise/clarify可用。
     */
    resolved_clarification_ids?: string[];
    /**
     * 新建任务省略此字段（也接受JSON null）；已有任务用工具回执中的真实ID，不能填字符串null。
     */
    task_id?: null | string;
}

export type AnalysisUpdateAction = "create" | "revise" | "clarify" | "route";

/**
 *
 * 修改已存任务条件时必填，action用revise或clarify；set指定新值，unset必须提供（不清空时为[]）。route禁止携带condition_patch，因为route只登记归属。
 */
export interface ConditionPatch {
    set:   ConditionSet;
    unset: Unset[];
}

export interface ConditionSet {
    channel?:        ConditionsChannel;
    filters?:        string[];
    group_by?:       string[];
    knowledge_refs?: EvidenceRef[];
    metric?:         string;
    notes?:          string;
    /**
     * 修改区间的不包含终点，按业务时区解析后填写UTC完整时间戳，以Z结尾；整月结束为下一月起点。清空使用unset；未修改则省略。
     */
    time_end?: string;
    /**
     * 修改区间的包含起点，按业务时区解析后填写UTC完整时间戳，以Z结尾。清空使用unset；未修改则省略。
     */
    time_start?: string;
    timezone?:   string;
}

export type Unset = "time_start" | "time_end" | "metric" | "channel" | "group_by" | "filters" | "knowledge_refs" | "notes";

export interface AppError {
    code:       Code;
    message:    string;
    request_id: string;
    retryable:  boolean;
}

export type Code = "budget_exhausted" | "chunk_gap" | "forbidden" | "idempotency_conflict" | "input_already_applied" | "invalid_evidence" | "invalid_input" | "lease_lost" | "message_pending" | "not_available" | "outcome_unknown" | "result_unavailable" | "scope_incomplete" | "selection_required" | "source_unavailable" | "stale_context" | "stale_knowledge" | "unauthenticated" | "unavailable" | "unsupported" | "version_conflict" | "memory_unavailable" | "memory_extraction_empty" | "memory_operation_unknown" | "vector_unconfigured" | "vector_unavailable" | "embedding_unavailable" | "source_interrupted" | "result_expired" | "model_retry_exhausted";

export interface AppendOutput {
    chunk_seq:   string;
    lease_epoch: string;
    run_id:      string;
    text:        string;
}

export interface Asset {
    body:                string;
    can_edit?:           boolean;
    dependencies:        EvidenceRef[];
    files?:              SkillFile[];
    id:                  string;
    kind:                AssetKind;
    memory_index_state?: MemoryIndexState;
    name:                string;
    owner_id?:           string;
    scope:               string;
    selected:            boolean;
    source_text:         string;
    state:               AssetState;
    verified:            boolean;
    version:             string;
    visibility?:         Visibility;
}

export type AssetKind = "memory" | "skill";

export type MemoryIndexState = "queued" | "issued" | "indexed" | "failed" | "superseded";

export type AssetState = "enabled" | "disabled" | "deleted";

export interface AssetList {
    assets: Asset[];
}

export interface AssetSave {
    /**
     * Skill 的正文及生成资源每行最多 51200 UTF-8 字节；超限须分行保存。记忆不受此行限制。
     */
    body:             string;
    dependencies:     EvidenceRef[];
    draft_id?:        string;
    expected_version: null | string;
    files?:           SkillFile[];
    id:               null | string;
    kind:             AssetKind;
    name:             string;
    operation_id:     string;
    scope:            string;
    source_text:      string;
    verified:         boolean;
}

export interface AssetToolInput {
    action:            AssetToolInputAction;
    asset_id?:         string;
    body?:             string;
    dependencies?:     EvidenceRef[];
    expected_version?: string;
    /**
     *
     * 保存或修订记忆所依据的本条用户消息逐字原文；句子/分号边界或逗号后明确以另外/此外另起的指令可作起点。引用在逗号结束时，宿主补齐同句剩余原文至句末/分号，核对并保存source_text，避免裁掉尾部否定与限定；最终正文只保留可复用内容，scope完整沿用最终正文中的对象和限定；不能把当次请求写为长期默认。
     */
    instruction_quote?: string;
    /**
     * 候选显示名称；自动保存时宿主从最终正文截取前40个Unicode字符作为正式标签，避免另一次概括改变业务对象。
     */
    name?: string;
    /**
     * 候选范围，参与临时限定预检查。自动保存时正式scope与最终body使用同一份完整提取文字，保留对象/限定；不能增加指标别名或扩大范围。以工具回执为准。
     */
    scope?:    string;
    verified?: boolean;
}

export type AssetToolInputAction = "save_memory" | "update_memory" | "disable_memory";

export interface CancelReceipt {
    run_id: string;
    state:  CancelReceiptState;
}

export type CancelReceiptState = "cancelled" | "finished" | "interrupted" | "failed";

export interface CancelRun {
    lease_epoch: string;
    run_id:      string;
}

export interface ChatMessage {
    attempt_id:     null | string;
    committed:      boolean;
    event_seq?:     string;
    message_id?:    null | string;
    output_id?:     null | string;
    request_clock?: RequestClock;
    role:           Role;
    text:           string;
}

export interface RequestClock {
    business_timezone:  BusinessTimezone;
    reference_time_utc: string;
}

export type BusinessTimezone = "UTC" | "Asia/Shanghai";

export type Role = "user" | "assistant";

export interface Checkpoint {
    authority_revision?: null | string;
    authority_snapshot?: { [key: string]: unknown };
    entries:             { [key: string]: unknown }[];
    leaf_id:             null | string;
    sdk_version:         SDKVersion;
    storage?:            CheckpointReference;
}

export type SDKVersion = "1.0.0" | "1.3.0";

export interface CheckpointReference {
    file?:        string;
    kind:         CheckpointReferenceKind;
    session_id?:  string;
    fingerprint?: string;
}

export type CheckpointReferenceKind = "pi_session" | "host_checkpoint";

export interface ConfirmQuery {
    condition_version: string;
    draft_version:     string;
    operation_id:      string;
}

export interface ConversationModelSelection {
    selection: ModelSelection | null;
    version:   string;
}

export interface ModelSelection {
    model_id:       string;
    thinking_level: ThinkingLevel;
}

/**
 * 通过Pi/DeepSeek原生思考模式；省略为off。思考tokens计入同一输出上限与用量。
 */
export type ThinkingLevel = "off" | "low" | "high" | "max";

export interface ConversationReadInput {
    after_seq:       string;
    message_id?:     string;
    offset?:         number;
    task_after?:     string;
    task_directory?: boolean;
}

export interface ConversationReceipt {
    conversation_id: string;
}

export interface CreateConversation {
    operation_id: string;
}

export interface DataToolInvocation {
    arguments:        { [key: string]: unknown };
    checkpoint:       Checkpoint;
    lease_epoch:      string;
    run_id:           string;
    sdk_tool_call_id: string;
    tool_name:        ToolName;
}

export type ToolName = "search_knowledge" | "read_knowledge" | "read_source" | "validate_sql" | "request_query" | "execute_query" | "update_analysis_task" | "get_query" | "cancel_query" | "manage_personal_asset" | "propose_semantic_change" | "read_conversation" | "read_analysis_task" | "read" | "save_analysis_evidence" | "save_analysis_report" | "read_analysis_report" | "prepare_skill_draft";

export interface DataToolOutcome {
    data:         { [key: string]: unknown };
    operation_id: string;
    tool_name:    ToolName;
}

export interface EmbeddingProfile {
    call_limit:        number;
    cost_limit_micros: string;
    trial_id:          string;
}

export interface Event {
    conversation_id: string;
    event_id:        string;
    event_seq:       string;
    payload:         { [key: string]: unknown };
    schema_version:  number;
    type:            EventType;
}

export type EventType = "message" | "assistant_delta" | "assistant_committed" | "assistant_replaced" | "tool_result" | "run_failed" | "run_cancelled" | "query_changed" | "query_result" | "memory_saved" | "task_changed" | "conversation_deleted" | "message_withdrawn" | "task_cancelled" | "memory_disabled" | "analysis_evidence_saved" | "analysis_report_saved";

export interface ExecuteQueryInput {
    condition_version: string;
    draft_version:     string;
    instruction_quote: string;
    query_id:          string;
}

export interface FinalizeModelCall {
    call_attempt_id: string;
    lease_epoch:     string;
    /**
     * 受控provider给出的调用结果；与是否取得可靠用量分开。连续临时失败在原请求范围持久计数。
     */
    outcome?:               Outcome;
    parameters_fingerprint: string;
    run_id:                 string;
    usage:                  ModelUsage | null;
}

/**
 * 受控provider给出的调用结果；与是否取得可靠用量分开。连续临时失败在原请求范围持久计数。
 */
export type Outcome = "success" | "transient_error" | "permanent_error";

export interface ModelUsage {
    elapsed_ms:    number;
    input_tokens:  number;
    output_tokens: number;
}

export interface FinishReceipt {
    output_id: string;
    state:     FinishReceiptState;
}

export type FinishReceiptState = "finished";

export interface FinishRun {
    checkpoint: Checkpoint;
    commit_id:  string;
    /**
     * Pi最后助手消息的首个已保存片段序号；省略时沿用从1起的完整文本校验。
     */
    final_start_chunk_seq?: string;
    final_text:             string;
    lease_epoch:            string;
    run_id:                 string;
}

export interface History {
    conversations:  HistoryItem[];
    next_before_id: null | string;
}

export interface HistoryItem {
    /**
     * 会话创建时间（UTC）；用于区分同名会话，不改变分页顺序。
     */
    created_at?: string;
    id:          string;
    title:       string;
}

export interface HistoryQuery {
    before_id?: string;
    q?:         string;
}

export interface HostCheckpointReference {
    fingerprint: string;
    kind:        HostCheckpointReferenceKind;
}

export type HostCheckpointReferenceKind = "host_checkpoint";

export interface Identity {
    model_label: ModelLabel;
    space_id:    string;
    user_id:     string;
}

export type ModelLabel = "本地模拟模型" | "DeepSeek Flash" | "DeepSeek V4 Pro";

/**
 * 独立对象首次创建时自动归属可信登录者；请求不接受负责人字段，后续调整使用独立管理接口。
 */
export interface KnowledgeCreate {
    body:              string;
    kind:              KindElement;
    name:              string;
    operation_id:      string;
    related_ids:       string[];
    source_url?:       null | string;
    structured_value?: QueryExampleStructure | null;
}

export type KindElement = "table" | "field" | "metric" | "document" | "relationship" | "term" | "query_example";

export type QueryExampleStructure = SemanticStructure;

/**
 * 将同一来源的业务文档按自然章节组合阅读；parts保留原引用身份，编辑时一次提交全部章节。
 */
export interface KnowledgeDocument {
    body:     string;
    can_edit: boolean;
    parts:    [KnowledgeObject, ...KnowledgeObject[]];
    title:    string;
}

export interface KnowledgeObject {
    analysis_preference?: TableAnalysisPreference;
    created_by?:          string;
    /**
     * 整篇编辑后后台片段的拼接顺序；与正文同版本保存，不作为页面字段。
     */
    document_order?: number;
    entries:         KnowledgeEntry[];
    id:              string;
    kind:            KindElement;
    maintenance?:    SemanticMaintenance;
    name:            string;
    prefill_status?: PrefillStatus | null;
    related_ids:     string[];
    retrieval?:      KnowledgeRetrieval;
    source_id:       null | string;
    source_version:  string;
    state:           AssetState;
    /**
     * 平台移除与人工停用分开；重新出现只能恢复平台导致的停用。
     */
    state_origin?: StateOrigin;
    updated_by:    string;
    version:       string;
}

export interface KnowledgeEntry {
    effective_structure?: QueryExampleStructure | null;
    effective_value:      string;
    entry_id:             string;
    human_override:       null | HumanOverride;
    label:                string;
    path:                 string;
    review_state:         ReviewState;
    source_facts:         SourceFacts;
    suggestion:           Suggestion;
}

export interface HumanOverride {
    structured_value?: QueryExampleStructure | null;
    [property: string]: unknown;
}

export type ReviewState = "unverified" | "confirmed" | "needs_review";

export interface SourceFacts {
    structured_value?: QueryExampleStructure | null;
    [property: string]: unknown;
}

export interface Suggestion {
    structured_value?: QueryExampleStructure | null;
    [property: string]: unknown;
}

export interface PrefillStatus {
    attempt_id: string;
    error_code: null | string;
    state:      string;
}

/**
 * 平台移除与人工停用分开；重新出现只能恢复平台导致的停用。
 */
export type StateOrigin = "platform" | "human";

/**
 * 完整Markdown与完整片段版本集合；服务端逐一授权，正文与后台顺序同事务保存，重复操作返回原回执。
 */
export interface KnowledgeDocumentEdit {
    body:         string;
    operation_id: string;
    parts:        [Part, ...Part[]];
    related_ids?: string[];
    source_url?:  null | string;
}

export interface Part {
    expected_version: string;
    id:               string;
}

export interface KnowledgeEdit {
    clear_override?:   boolean;
    entry_id:          string;
    expected_version:  string;
    operation_id:      string;
    related_ids?:      string[];
    source_url?:       null | string;
    structured_value?: QueryExampleStructure | null;
    value:             string;
}

export interface KnowledgeList {
    next_after_id:    null | string;
    objects:          KnowledgeObject[];
    retrieval_mode:   string;
    search_coverage?: SearchCoverage | null;
}

export interface SearchCoverage {
    candidate_limit: number;
    index_state?:    IndexState;
    /**
     * 候选谓词是否覆盖全部去重检索词项；false时应改写或拆分查询，不能据空结果断言没有资料。
     */
    query_terms_complete?: boolean;
    scope_applied?:        boolean;
    state:                 SearchCoverageState;
    vector_state?:         VectorState;
}

export type IndexState = "current" | "incomplete" | "unconfigured";

export type SearchCoverageState = "complete" | "candidate_limit" | "bounded";

export type VectorState = "available" | "unconfigured" | "unavailable";

export interface KnowledgeListQuery {
    after_id?: string;
    /**
     * 管理目录按名称和状态分页；maintained按当前负责人关系筛选，包含停用项。省略时保留现有语义检索。
     */
    directory?: Directory;
    /**
     * 仅管理目录使用。grouped只分页列出表、指标、整篇文档、查询案例与术语；字段和关系从所属表打开。省略或flat保留全部对象列表。
     */
    directory_view?: DirectoryView;
    q?:              string;
    related_id?:     string;
    /**
     * 仅用于管理目录；省略时包含启用及停用，始终排除已删除对象。
     */
    state?: MaintenanceDependentState;
}

/**
 * 管理目录按名称和状态分页；maintained按当前负责人关系筛选，包含停用项。省略时保留现有语义检索。
 */
export type Directory = "all" | "maintained";

/**
 * 仅管理目录使用。grouped只分页列出表、指标、整篇文档、查询案例与术语；字段和关系从所属表打开。省略或flat保留全部对象列表。
 */
export type DirectoryView = "grouped" | "flat";

export interface LogoutReceipt {
    state: LogoutReceiptState;
}

export type LogoutReceiptState = "logged_out";

export interface MemoryBudgetBinding {
    epoch:            string;
    id:               string;
    kind:             MemoryBudgetBindingKind;
    operation_id:     string;
    sdk_tool_call_id: null | string;
}

export type MemoryBudgetBindingKind = "run" | "index";

export interface MemoryCandidate {
    asset_id: string;
    version:  string;
}

export interface MemoryExtractionReceipt {
    body:         string;
    operation_id: string;
    replayed:     boolean;
}

export interface MemoryExtractionRequest {
    budget:       MemoryBudgetBinding;
    message:      string;
    operation_id: string;
    owner_id:     string;
    quote:        string;
    space_id:     string;
}

export interface MemoryIndexReceipt {
    operation_id: string;
    state:        MemoryIndexReceiptState;
}

export type MemoryIndexReceiptState = "ready" | "removed" | "superseded";

export interface MemoryIndexRequest {
    asset:                   Asset;
    budget:                  MemoryBudgetBinding;
    extraction_operation_id: null | string;
    operation_id:            string;
    owner_id:                string;
    space_id:                string;
}

export interface MemoryModelCall {
    action:                 MemoryModelCallAction;
    budget:                 MemoryBudgetBinding;
    call_attempt_id:        string;
    input_tokens_upper:     number;
    output_tokens_max:      number;
    parameters_fingerprint: string;
    purpose:                Purpose;
    usage:                  ModelUsage | null;
}

export type MemoryModelCallAction = "issue" | "finalize";

export type Purpose = "memory_extraction" | "memory_embedding";

export interface MemorySearchReceipt {
    bounded:    boolean;
    candidates: MemoryCandidate[];
}

export interface MemorySearchRequest {
    budget:       MemoryBudgetBinding;
    operation_id: string;
    owner_id:     string;
    query:        string;
    space_id:     string;
}

export interface MessageInput {
    client_message_id: string;
    model_selection?:  ModelSelection;
    text:              string;
}

export interface MessageReceipt {
    message_id: string;
    request_id: string;
}

export interface ModelAttempt {
    call_attempt_id: string;
    lease_epoch:     string;
    run_id:          string;
}

export interface ModelCallReceipt {
    send_allowed: boolean;
    state:        ModelCallReceiptState;
}

export type ModelCallReceiptState = "reserved" | "issued" | "settled" | "unknown";

export interface ModelCatalog {
    default_selection: ModelSelection | null;
    models:            ModelOption[];
}

export interface ModelOption {
    id:               string;
    label:            string;
    thinking_options: ThinkingOption[];
}

export interface ThinkingOption {
    label: string;
    value: ThinkingLevel;
}

export interface ModelProfile {
    /**
     * 省略沿用有限trial；request为正常持续使用，每消息24次，累计费用/试用期限不默认拦截。
     */
    budget_mode?:         BudgetMode;
    input_limit:          number;
    model_id:             string;
    output_limit:         number;
    payload_bytes_limit?: number;
    price_version:        string;
    provider_id:          ProviderID;
    request_call_limit?:  number;
    /**
     * 通过Pi/DeepSeek原生思考模式；省略为off。思考tokens计入同一输出上限与用量。
     */
    thinking_level?:    ThinkingLevel;
    toolset?:           Toolset;
    trial_call_limit?:  number;
    trial_cost_micros?: string;
    trial_id:           string;
}

/**
 * 省略沿用有限trial；request为正常持续使用，每消息24次，累计费用/试用期限不默认拦截。
 */
export type BudgetMode = "trial" | "request";

export type ProviderID = "deepseek";

export type Toolset = "task" | "data";

export interface ModelReceipt {
    state: ModelReceiptState;
}

export type ModelReceiptState = "issued" | "settled";

export interface MutationReceipt {
    operation_id: string;
    resource_id:  string;
    state:        string;
    version:      string;
}

export interface OperationReceipt {
    operation_id: string;
}

export interface OutputReceipt {
    chunk_seq: string;
}

export interface PiSessionReference {
    file:       string;
    kind:       PiSessionReferenceKind;
    session_id: string;
}

export type PiSessionReferenceKind = "pi_session";

export interface PrefillResult {
    entries: [Entry, ...Entry[]];
}

export interface Entry {
    entry_id:          string;
    evidence:          [Evidence, ...Evidence[]];
    gaps:              string[];
    structured_value?: QueryExampleStructure | null;
    value:             string;
}

export interface Evidence {
    location:  string;
    quote:     string;
    source_id: string;
    version:   string;
}

export interface Proposal {
    base_version: string;
    entry_id:     string;
    evidence:     EvidenceRef[];
    id:           string;
    object_id:    string;
    reason:       string;
    state:        string;
    value:        string;
}

export interface ProposalInput {
    base_version: string;
    entry_id:     string;
    evidence:     [EvidenceRef, ...EvidenceRef[]];
    object_id:    string;
    reason:       string;
    value:        string;
}

export interface ProposalList {
    proposals: Proposal[];
}

export interface QueryCancellation {
    cancel_state:      string;
    condition_version: string;
    execution_state:   string;
    id:                string;
    task_id:           string;
}

export interface QueryList {
    confirmation_blocked: boolean;
    queries:              QueryView[];
}

export interface QueryView {
    cancel_state:       string;
    check_state:        string;
    condition_version:  string;
    confirmation_state: string;
    conversation_id:    string;
    draft_version:      string;
    error:              null | string;
    error_details?:     ErrorDetails | null;
    execution_state:    string;
    id:                 string;
    knowledge_refs:     EvidenceRef[];
    parameters:         { [key: string]: unknown };
    replaces_query_id?: null | string;
    result_ref:         null | string;
    /**
     * 草稿工具回执的非阻断诊断；查询读取接口不承诺重现此报告。
     */
    semantic_checks?: SemanticCheckReport;
    sql:              string;
    summary:          string;
    target_id:        string;
    task_id:          string;
}

export interface ErrorDetails {
    code:    string;
    message: string;
}

export interface ReadKnowledgeInput {
    /**
     *
     * 知识条目ID；个人记忆省略时读取正文，scope读取范围，source_text读取来源原话，分别检查content_page/scope_page/source_page并按同一version续读。
     */
    entry_id?:       string;
    limit?:          number;
    object_id:       string;
    offset?:         number;
    structure_only?: boolean;
    version?:        null | string;
}

export interface ReadQueryInput {
    cursor?:  null | string;
    query_id: string;
}

export interface ReadSourceInput {
    limit?:  number;
    offset?: number;
    /**
     * 原始来源ID或document-加知识文档ID的保留别名；文档仍按当前空间、状态和版本校验。
     */
    source_id: string;
    version:   string;
}

export interface ReadTaskInput {
    /**
     * 按回执next_clarification_after继续读取未决问题；省略从第一页开始。
     */
    clarification_after?: string;
    task_id:              string;
}

export interface ReadCheckpoint {
    lease_epoch: string;
    run_id:      string;
}

export interface RequestQueryInput {
    condition_version:  string;
    knowledge_refs:     EvidenceRef[];
    parameters:         { [key: string]: unknown };
    replaces_query_id?: null | string;
    sql:                string;
    summary:            string;
    target_id:          TargetID;
    task_id:            string;
}

export type TargetID = "synthetic-sqlite";

export interface ReserveModelCall {
    call_attempt_id:        string;
    input_tokens_upper:     number;
    lease_epoch:            string;
    output_tokens_max:      number;
    parameters_fingerprint: string;
    run_id:                 string;
}

export interface RunEnvelope {
    attempt_id:         string;
    budget_scope_id:    string;
    checkpoint:         Checkpoint | null;
    conversation_id:    string;
    lease_epoch:        string;
    message_id:         string;
    model_profile:      ModelProfile | null;
    output_id:          string;
    recovery_chain_id:  string;
    request_clock?:     RequestClock;
    request_id:         string;
    resume_same_input?: boolean;
    run_id:             string;
    text:               string;
    workspace_context?: WorkspaceContext | null;
}

export interface WorkspaceContext {
    asset_counts?:       AssetCounts;
    authority_revision:  string;
    authority_snapshot?: { [key: string]: unknown };
    /**
     * 当前输入的持久全部任务归属；恢复时按当前lifecycle继续剩余目标。
     */
    input_task_ids?:    string[];
    memories:           ModelAssetPreview[];
    memory_retrieval?:  MemoryRetrieval;
    query_observations: { [key: string]: unknown }[];
    recent_messages:    ChatMessage[];
    request_clock?:     RequestClock;
    selected_skills:    ModelAssetPreview[];
    tasks:              WorkspaceTask[];
}

export interface AssetCounts {
    memories:        number;
    selected_skills: number;
}

export interface ModelAssetPreview {
    body:          string;
    content_page?: ContentPage;
    dependencies:  EvidenceRef[];
    id:            string;
    kind:          AssetKind;
    name:          string;
    native_path?:  string;
    owner_id?:     string;
    scope:         string;
    scope_page?:   ContentPage;
    selected:      boolean;
    /**
     * 来源原话的独立字符分页。缺省source_text为空但保留总长和补读位置；以entry_id=source_text和同一资产版本读取。
     */
    source_page?: ContentPage;
    source_text:  string;
    state:        AssetState;
    verified:     boolean;
    version:      string;
    visibility?:  Visibility;
}

export type MemoryRetrieval = "mem0_authoritative" | "directory_fallback";

export interface RunSnapshot {
    lease_epoch: string;
    run_id:      string;
    state:       RunSnapshotState;
}

export type RunSnapshotState = "running" | "interrupted" | "finished" | "failed" | "cancelled";

export interface SaveModelSelection {
    expected_version: string;
    selection:        ModelSelection;
}

export interface SearchInput {
    asset_after?:       string;
    business_domain?:   string;
    kinds?:             [KindElement, ...KindElement[]];
    limit?:             number;
    query:              string;
    related_object_id?: string;
}

export interface SendModelCall {
    call_attempt_id:        string;
    lease_epoch:            string;
    parameters_fingerprint: string;
    run_id:                 string;
}

export interface SessionReceipt {
    model_label: ModelLabel;
    space_id:    string;
    state:       SessionReceiptState;
    user_id:     string;
}

export type SessionReceiptState = "authenticated";

export interface SkillSelection {
    asset_id:     string;
    operation_id: string;
    version:      string;
}

export interface Snapshot {
    conversation_id:  string;
    events:           Event[];
    first_event_seq?: string;
    has_newer?:       boolean;
    has_older?:       boolean;
    last_event_seq?:  string;
    messages:         ChatMessage[];
    runs:             RunSnapshot[];
    tasks:            TaskSnapshot[];
}

export interface TaskSnapshot {
    condition_version: string;
    evidence_refs?:    AnalysisEvidenceRef[];
    goal:              string;
    id:                string;
    lifecycle?:        string;
    phase?:            string;
    report_ref?:       AnalysisReportRef;
}

export interface SourceDocument {
    body:            string;
    complete:        boolean;
    current_version: string;
    source_id:       string;
    version:         string;
}

export interface SQLInput {
    knowledge_refs?: EvidenceRef[];
    parameters:      { [key: string]: unknown };
    sql:             string;
    target_id:       TargetID;
}

export interface TaskInput {
    action: TaskInputAction;
    goal:   string;
}

export type TaskInputAction = "create_task";

export interface ToolInvocation {
    arguments:        TaskInput;
    checkpoint:       Checkpoint;
    lease_epoch:      string;
    run_id:           string;
    sdk_tool_call_id: string;
}

export interface ToolOutcome {
    receipt?: ToolReceipt;
    type:     ToolOutcomeType;
    error?:   AppError;
}

export interface ToolReceipt {
    condition_version: string;
    operation_id:      string;
    state:             ToolReceiptState;
    task_id:           string;
}

export type ToolReceiptState = "active";

export type ToolOutcomeType = "succeeded" | "failed";

export interface VersionCommand {
    expected_version: string;
    operation_id:     string;
}


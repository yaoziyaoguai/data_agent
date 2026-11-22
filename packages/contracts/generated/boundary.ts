// Generated from packages/contracts/schema.json; do not edit.
export interface Boundary {
    adoptedSemanticResolution:    AdoptedSemanticResolutionClass;
    AgentQueryResults?:           AgentQueryResultsClass;
    AnalysisAnswerSource?:        AnalysisAnswerSourceElement;
    AnalysisAnswerValue?:         AnalysisAnswerValueElement;
    AnalysisEvidence?:            AnalysisEvidenceElement;
    AnalysisEvidenceRef?:         AnalysisEvidenceRefElement;
    AnalysisEvidenceSources?:     AnalysisEvidenceSourcesClass;
    AnalysisFigure?:              AnalysisFigureElement;
    AnalysisFinding?:             AnalysisFindingElement;
    AnalysisPreferenceCommand?:   AnalysisPreferenceCommandClass;
    AnalysisQueryCoverage?:       AnalysisQueryCoverageElement;
    AnalysisQueryReference?:      AnalysisQueryReferenceElement;
    AnalysisReport?:              AnalysisReportClass;
    AnalysisReportChart?:         AnalysisReportChartElement;
    AnalysisReportPage?:          AnalysisReportPageClass;
    AnalysisReportRef?:           AnalysisReportRefClass;
    AnalysisReportView?:          AnalysisReportViewClass;
    AnalysisResultDependency?:    AnalysisResultDependencyElement;
    analysisUpdate:               AnalysisUpdateClass;
    appendOutput:                 AppendOutputClass;
    appError:                     AppErrorClass;
    ApplySemanticCorrection?:     ApplySemanticCorrectionClass;
    asset:                        AssetElement;
    assetList:                    AssetListClass;
    AssetPageQuery?:              AssetPageQueryClass;
    assetReadRef?:                AssetReadRefClass;
    assetSave:                    AssetSaveClass;
    assetToolInput:               AssetToolInputClass;
    AssignSemanticMaintainer?:    AssignSemanticMaintainerClass;
    cancelReceipt:                CancelReceiptClass;
    cancelRun:                    CancelRunClass;
    CatalogColumn?:               CatalogColumnElement;
    CatalogNode?:                 CatalogNodeClass;
    CatalogPage?:                 CatalogPageClass;
    CatalogTable?:                CatalogTableElement;
    chatMessage:                  ChatMessageElement;
    checkpoint:                   CheckpointClass;
    checkpoint_reference:         CheckpointReferenceClass;
    conditions:                   AnalysisEvidenceConditions;
    configuredModel:              ConfiguredModelClass;
    confirmQuery:                 ConfirmQueryClass;
    contentPage?:                 ContentPageClass;
    conversationModelSelection:   ConversationModelSelectionClass;
    conversationReadInput:        ConversationReadInputClass;
    conversationReceipt:          ConversationReceiptClass;
    ConversationSkillSelection?:  ConversationSkillSelectionElement;
    ConversationSkillSelections?: ConversationSkillSelectionsClass;
    createConversation:           CreateConversationClass;
    currentAnalysisUpdate:        CurrentAnalysisUpdateClass;
    currentRequestQueryInput:     CurrentRequestQueryInputClass;
    dataToolInvocation:           DataToolInvocationClass;
    dataToolOutcome:              DataToolOutcomeClass;
    deliveredSupport?:            DeliveredSupportElement;
    EmbeddedSupportLocation?:     EmbeddedSupportLocationClass;
    embeddingProfile:             EmbeddingProfileClass;
    event:                        EventElement;
    evidenceContinuation:         EvidenceContinuationClass;
    evidenceReadResult?:          EvidenceReadResultElement;
    evidenceRef:                  EvidenceRefElement;
    evidenceTaskRef?:             EvidenceTaskRefElement;
    executeQueryInput:            ExecuteQueryInputClass;
    finalizeModelCall:            FinalizeModelCallClass;
    finishReceipt:                FinishReceiptClass;
    finishRun:                    FinishRunClass;
    GetQueryInput?:               GetQueryInputClass;
    history:                      HistoryClass;
    historyItem:                  HistoryItemElement;
    historyQuery:                 HistoryQueryClass;
    host_checkpoint_reference:    HostCheckpointReferenceClass;
    humanStatementInput?:         HumanStatementInputElement;
    identity:                     IdentityClass;
    knowledgeBatchEdit?:          KnowledgeBatchEditClass;
    knowledgeBatchReceipt?:       KnowledgeBatchReceiptClass;
    knowledgeCreate:              KnowledgeCreateClass;
    knowledgeDocument?:           KnowledgeDocumentClass;
    knowledgeDocumentEdit?:       KnowledgeDocumentEditClass;
    knowledgeEdit:                KnowledgeEditClass;
    knowledgeEditGroup?:          KnowledgeEditGroupElement;
    knowledgeEntry:               KnowledgeEntryElement;
    knowledgeLineage?:            KnowledgeLineageClass;
    knowledgeList:                KnowledgeListClass;
    knowledgeListQuery:           KnowledgeListQueryClass;
    knowledgeObject:              KnowledgeObjectElement;
    knowledgeReadInput?:          KnowledgeReadInputClass;
    knowledgeReadItem?:           KnowledgeReadItemElement;
    knowledgeReadReply?:          KnowledgeReadReplyClass;
    knowledgeReadResult?:         KnowledgeReadResultClass;
    KnowledgeRetrieval?:          KnowledgeRetrievalClass;
    KnowledgeRetrievalExcerpt?:   KnowledgeRetrievalExcerptElement;
    knowledgeSearchCoverage:      KnowledgeSearchCoverageClass;
    knowledgeSearchHit:           KnowledgeSearchHitElement;
    knowledgeSearchInput:         KnowledgeSearchInputClass;
    knowledgeSearchReply:         KnowledgeSearchReplyClass;
    legacyPending:                LegacyPendingClass;
    legacyPendingItem:            LegacyPendingItemElement;
    legacyResolutionLink:         LegacyResolutionLinkElement;
    legacyResolutionMigration:    LegacyResolutionMigrationClass;
    loadedOutputRange:            LoadedOutputRangeElement;
    logoutReceipt:                LogoutReceiptClass;
    MaintenanceDependent?:        MaintenanceDependentElement;
    MaintenanceImpact?:           MaintenanceImpactClass;
    MaintenanceImpactQuery?:      MaintenanceImpactQueryClass;
    MaintenanceReference?:        MaintenanceReferenceElement;
    memoryBudgetBinding?:         MemoryBudgetBindingClass;
    memoryCandidate?:             MemoryCandidateElement;
    memoryExtractionReceipt?:     MemoryExtractionReceiptClass;
    memoryExtractionRequest?:     MemoryExtractionRequestClass;
    memoryIndexReceipt?:          MemoryIndexReceiptClass;
    memoryIndexRequest?:          MemoryIndexRequestClass;
    memoryModelCall?:             MemoryModelCallClass;
    memoryReadResult?:            MemoryReadResultClass;
    memorySearchReceipt?:         MemorySearchReceiptClass;
    memorySearchRequest?:         MemorySearchRequestClass;
    messageInput:                 MessageInputClass;
    messageReceipt:               MessageReceiptClass;
    modelAttempt:                 ModelAttemptClass;
    modelCallReceipt:             ModelCallReceiptClass;
    modelCatalog:                 ModelCatalogClass;
    modelConfiguration:           ModelConfigurationClass;
    modelConfigurationAccess:     ModelConfigurationAccessClass;
    modelConnection:              ModelConnectionClass;
    modelDefinition:              ModelDefinitionElement;
    modelOption:                  ModelOptionElement;
    modelProfile:                 ModelProfileClass;
    modelReceipt:                 ModelReceiptClass;
    modelSelection:               ModelSelectionClass;
    modelService:                 ModelServiceElement;
    modelUsage:                   ModelUsageClass;
    mutationReceipt:              MutationReceiptClass;
    numericValueCounts?:          NumericValueCountsClass;
    operationReceipt:             OperationReceiptClass;
    outputProjection:             OutputProjectionElement;
    outputReceipt:                OutputReceiptClass;
    pi_session_reference:         PiSessionReferenceClass;
    prefillResult:                PrefillResultClass;
    PreparedRelation?:            PreparedRelationElement;
    PreparedStatement?:           PreparedStatementElement;
    PreparedSupport?:             PreparedSupportElement;
    PrepareSkillDraftInput?:      PrepareSkillDraftInputClass;
    PresentAnalysisAnswerInput?:  PresentAnalysisAnswerInputClass;
    proposal:                     ProposalElement;
    ProposalDraftCommand?:        ProposalDraftCommandClass;
    proposalInput:                ProposalInputClass;
    proposalList:                 ProposalListClass;
    PublishSkill?:                PublishSkillClass;
    queryCancellation?:           QueryCancellationClass;
    QueryExampleParameter?:       QueryExampleParameterElement;
    QueryExampleVerification?:    QueryExampleVerificationClass;
    queryList:                    QueryListClass;
    QueryResultCellRead?:         QueryResultCellReadClass;
    QueryResultContent?:          QueryResultContentClass;
    queryResults:                 QueryResultsElement;
    QueryResultStatisticsRead?:   QueryResultStatisticsReadClass;
    queryView:                    QueryViewElement;
    read_checkpoint:              ReadCheckpointClass;
    ReadAnalysisReportInput?:     ReadAnalysisReportInputClass;
    readKnowledgeInput:           ReadKnowledgeInputClass;
    readModelConnection:          ReadModelConnectionClass;
    readQueryInput:               ReadQueryInputClass;
    readSourceInput:              ReadSourceInputClass;
    readTaskInput?:               ReadTaskInputClass;
    refreshRunContext:            RefreshRunContextClass;
    requestQueryInput:            RequestQueryInputClass;
    reserveModelCall:             ReserveModelCallClass;
    resultColumn:                 ResultColumnElement;
    resultColumnStatistics?:      ResultColumnStatisticsElement;
    resultStatistics?:            ResultStatisticsClass;
    ReviewSemanticCorrection?:    ReviewSemanticCorrectionClass;
    ReviewSkillSuggestion?:       ReviewSkillSuggestionClass;
    ReviseSemanticCorrection?:    ReviseSemanticCorrectionClass;
    runEnvelope:                  RunEnvelopeClass;
    runSnapshot:                  RunSnapshotElement;
    SaveAnalysisEvidenceInput?:   SaveAnalysisEvidenceInputClass;
    SaveAnalysisReport?:          SaveAnalysisReportClass;
    SaveAnalysisReportInput?:     SaveAnalysisReportInputClass;
    saveDefaultModel:             SaveDefaultModelClass;
    saveModelDefinition:          SaveModelDefinitionClass;
    saveModelSelection:           SaveModelSelectionClass;
    saveModelService:             SaveModelServiceClass;
    searchInput:                  SearchInputClass;
    SemanticAccess?:              SemanticAccessClass;
    SemanticCheckReport?:         SemanticCheckReportClass;
    SemanticColumnRef?:           SemanticColumnRefClass;
    SemanticCorrection?:          SemanticCorrectionElement;
    SemanticCorrectionList?:      SemanticCorrectionListClass;
    SemanticEvidenceRef?:         SemanticEvidenceRefElement;
    SemanticMaintenance?:         SemanticMaintenanceClass;
    SemanticMemberList?:          SemanticMemberListClass;
    SemanticReference?:           SemanticReferenceClass;
    SemanticRelation?:            SemanticRelationElement;
    SemanticStatement?:           SemanticStatementElement;
    SemanticStructure?:           SemanticStructureClass;
    SemanticSupport?:             SemanticSupportElement;
    SemanticTableRef?:            SemanticTableRefClass;
    sendModelCall:                SendModelCallClass;
    sessionReceipt:               SessionReceiptClass;
    SkillDraft?:                  SkillDraftElement;
    SkillDraftList?:              SkillDraftListClass;
    SkillDraftRef?:               SkillDraftRefClass;
    SkillFile?:                   SkillFileElement;
    SkillReadInput?:              SkillReadInputClass;
    skillReadResult?:             SkillReadResultClass;
    SkillRemovalReceipt?:         SkillRemovalReceiptClass;
    skillSelection:               SkillSelectionClass;
    SkillSelectionRemoval?:       SkillSelectionRemovalClass;
    SkillSuggestion?:             SkillSuggestionElement;
    SkillSuggestionList?:         SkillSuggestionListClass;
    snapshot:                     SnapshotClass;
    snapshotRefresh:              SnapshotRefreshClass;
    snapshotRequest:              SnapshotRequestClass;
    sourceCitation:               SourceCitationElement;
    sourceDocument:               SourceDocumentClass;
    SourceExcerpt?:               SourceExcerptClass;
    sourceKey:                    SourceKeyElement;
    sourceLocator:                SourceLocatorClass;
    SourcePreparationResult?:     SourcePreparationResultClass;
    sourceReadInput?:             SourceReadInputClass;
    sourceReadReply?:             SourceReadReplyClass;
    SourceSyncAccepted?:          SourceSyncAcceptedClass;
    SourceSyncProgress?:          SourceSyncProgressClass;
    SourceWorkProgress?:          SourceWorkProgressClass;
    sqlInput:                     SQLInputClass;
    SubmitSemanticCorrection?:    SubmitSemanticCorrectionClass;
    SuggestSkill?:                SuggestSkillClass;
    TableAnalysisPreference?:     TableAnalysisPreferenceClass;
    taskInput:                    TaskInputClass;
    taskSnapshot:                 TaskSnapshotElement;
    thinkingOption:               ThinkingOptionElement;
    toolInvocation:               ToolInvocationClass;
    toolOutcome:                  ToolOutcomeClass;
    toolReceipt:                  ToolReceiptClass;
    versionCommand:               VersionCommandClass;
    workbenchUpdate?:             WorkbenchUpdateClass;
    workspaceContext:             WorkspaceContextClass;
    WorkspaceTask?:               WorkspaceTaskElement;
}

export interface AgentQueryResultsClass {
    columns?:               ResultColumnElement[];
    data_freshness?:        string;
    fetched_offset?:        string;
    next_cursor?:           null | string;
    query_id:               string;
    result_complete?:       boolean;
    result_ref:             string;
    rows?:                  Array<Array<null | string>>;
    saved_result_complete?: boolean;
    saved_row_count?:       number;
    source?:                string;
    /**
     * 应用对当前有权结果页计算的统计；历史客户端可省略。
     */
    statistics?:     ResultStatisticsClass;
    truncated?:      boolean;
    view?:           AgentQueryResultsView;
    column?:         ResultColumnElement;
    column_index?:   number;
    row_index?:      number;
    value?:          null | string;
    content_format?: ContentFormat;
    content_page?:   PurpleQueryResultContentRange;
    content_text?:   string;
}

export interface ResultColumnElement {
    /**
     * 查询投影能唯一绑定已确认的字段或指标表达式时提供的列头说明。
     */
    display_label?: string;
    encoding:       string;
    name:           string;
    type:           string;
    /**
     * 从查询所选的已确认结构取得的业务单位，可独立于列头说明展示。
     */
    unit?: string;
}

export type ContentFormat = "json";

export interface PurpleQueryResultContentRange {
    complete:    boolean;
    next_offset: number | null;
    offset:      number;
    total_chars: number;
}

/**
 * 应用对当前有权结果页计算的统计；历史客户端可省略。
 */
export interface ResultStatisticsClass {
    columns:             ResultColumnStatisticsElement[];
    distinct_comparison: DistinctComparison;
    row_count:           number;
    /**
     * 只有从offset=0取得完整且未截断的结果才是complete_result；page不能外推为全部结果。
     */
    scope: ResultStatisticsScope;
}

export interface ResultColumnStatisticsElement {
    column_index: number;
    column_name:  string;
    /**
     * 不含NULL，按平台返回的原始文本去重；不模拟数据库排序规则。
     */
    distinct_count: number;
    /**
     * 当前统计范围的最大非空值，保留原始表示。
     */
    max?: null | string;
    /**
     * 当前统计范围的最小非空值，保留原始表示。
     */
    min?:           null | string;
    non_null_count: number;
    null_count:     number;
    numeric_counts: NumericValueCountsClass | null;
    /**
     * 本统计范围中出现超过一次的非NULL原始文本及次数；与distinct_count使用相同比较规则，不能推断跨页重复。
     */
    repeated_values: RepeatedValueElement[];
}

export interface NumericValueCountsClass {
    negative: number;
    positive: number;
    zero:     number;
}

export interface RepeatedValueElement {
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

export interface AnalysisAnswerSourceElement {
    columns:    [string, ...string[]];
    query_id:   string;
    result_ref: string;
}

export interface AnalysisAnswerValueElement {
    column?: string;
    /**
     * observation_cutoff/data_batch在同名角色多条时按field_ref对齐声明；缺省要求该角色唯一。
     */
    field_ref?: string;
    /**
     *
     * 展示格式：缺省或raw为原值；decimal为固定小数位；percent只对单个ratio乘100加百分号。decimal/percent必须给precision，raw不接受precision。展示字符串不写回查询结果。
     */
    format?: PurpleFormat;
    /**
     * observation_cutoff/data_batch绑定草稿时间基准中用户声明的角色值；未声明时不可绑定。
     */
    kind:       AnalysisAnswerValueKind;
    metadata?:  Metadata;
    name:       string;
    parameter?: string;
    query_id:   string;
    row_index?: number;
    statistic?: Statistic;
}

/**
 *
 * 展示格式：缺省或raw为原值；decimal为固定小数位；percent只对单个ratio乘100加百分号。decimal/percent必须给precision，raw不接受precision。展示字符串不写回查询结果。
 */
export interface PurpleFormat {
    precision?: number;
    style:      Style;
}

export type Style = "raw" | "decimal" | "percent";

/**
 * observation_cutoff/data_batch绑定草稿时间基准中用户声明的角色值；未声明时不可绑定。
 */
export type AnalysisAnswerValueKind = "cell" | "statistic" | "parameter" | "metadata" | "observation_cutoff" | "data_batch";

export type Metadata = "data_freshness" | "saved_row_count";

export type Statistic = "row_count" | "non_null_count" | "null_count" | "distinct_count" | "positive" | "zero" | "negative";

export interface AnalysisEvidenceElement {
    conditions:        AnalysisEvidenceConditions;
    data_range:        string;
    findings:          [AnalysisFindingElement, ...AnalysisFindingElement[]];
    reference:         AnalysisEvidenceRefElement;
    schema_version:    number;
    source_message_id: string;
    validated_sources: AnalysisEvidenceSourcesClass;
}

/**
 * 新建任务必须完整给出；未指定的可空标量用JSON null，列表用[]，notes用空字符串，timezone按宿主业务时区。
 */
export interface AnalysisEvidenceConditions {
    channel:        ConditionsChannel | null;
    filters:        string[];
    group_by:       string[];
    knowledge_refs: EvidenceRefElement[];
    metric:         null | string;
    notes:          string;
    /**
     * 当前格式仅记录已采用解释及依据，未决由clarifications表达；省略继承，null只清说明，未要求所有任务填写。旧形状按宿主持久格式标记兼容，读取不迁移。
     */
    semantic_resolution?: QueryViewQuerySemanticResolution | null;
    /**
     * null表示本题显式未声明额外来源限制；字段缺失表示旧条件版本未记录新式限制，不能证明用户从未限制。撤销必须显式unset并来自真实用户修改。
     */
    source_limits?: SourceLimitsClass | null;
    /**
     * 时间区间的不包含终点。按明确的业务时区解析后转为UTC完整时间戳，以Z结尾；整月结束为下一月起点，不能写本月最后一天。未指定时为null。
     */
    time_end: null | string;
    /**
     * 时间口径角色；统计起止仍沿time_start/time_end，request_clock和平台data_freshness不冒充用户截点。字段缺失表示旧版本未记录。
     */
    time_roles?: TimeRoleElement[];
    /**
     * 时间区间的包含起点。按明确的业务时区解析后转为UTC完整时间戳，以Z结尾；不能只写日期。未指定时为null。
     */
    time_start: null | string;
    timezone:   string;
}

export type ConditionsChannel = "web" | "app" | "store";

export interface EvidenceRefElement {
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

/**
 *
 * 新格式仅记录已经采用的解释。explicit_user引用本轮完整原话，null/省略采纳身份由宿主绑定；原已核对象可同文继承。未决只登记clarifications，无问题且条件充分时不要求本对象。
 */
export interface QueryViewQuerySemanticResolution {
    /**
     *
     * explicit_user：null=本轮新采纳，由宿主核对user_quote为本轮完整原话后绑定真实消息身份；非空=复制继承原已验证决策的消息身份，不接受模型自由填写。其余basis为null。
     */
    adoption_message_id?: null | string;
    /**
     * 真实用户明确选择、确无实质歧义、或仍需澄清；资料支持某公式不等于用户选择它。
     */
    basis: SemanticResolutionBasis;
    /**
     * 支撑该口径决策的依据引用；旧调用缺失按空数组解码。
     */
    evidence_refs?: EvidenceRefElement[];
    /**
     * 本稿采用的指标、分子/分母、时间等关键口径及选择依据；不能把自己刚写入任务的假设当作用户采用。
     */
    interpretation: string;
    /**
     * 仍会改变答案且未获选择的分子、分母、时间归属等差异；有差异必须先澄清，不能默认写稿。
     */
    unresolved_differences?: string[];
    /**
     * explicit_user逐字填写本条真实用户完整原话，保留否定、前提、例外和换行，不截取子串；其余为null。
     */
    user_quote: null | string;
}

/**
 * 真实用户明确选择、确无实质歧义、或仍需澄清；资料支持某公式不等于用户选择它。
 */
export type SemanticResolutionBasis = "explicit_user" | "unambiguous" | "needs_clarification";

/**
 * 设置来源限制；撤销使用unset source_limits，不接受设为空集。
 */
export interface SourceLimitsClass {
    /**
     * 非空允许集；限制跟稳定来源身份走，实际读取仍核对当前修订。
     */
    allowed_sources: [SourceKeyElement, ...SourceKeyElement[]];
    /**
     * 由宿主绑定的真实消息身份；不接受模型自由填写。
     */
    origin_message_ids: string[];
}

/**
 *
 * 来源的稳定身份。kind和id须成对原样使用source_identity回执的source_keys或已有citation.source；不按资料名称、object_id前缀或正文是文档来猜kind，不将document改成platform。不包含修订号，也不使用索引chunk
 * ID。
 */
export interface SourceKeyElement {
    id:   string;
    kind: SourceKeyKind;
}

export type SourceKeyKind = "platform" | "document";

export interface TimeRoleElement {
    /**
     * 业务含义说明。
     */
    description: string;
    /**
     * 支撑该时间口径的依据；可空数组。
     */
    evidence_refs: EvidenceRefElement[];
    /**
     * 采用的时间字段引用；可空。
     */
    field_ref: null | string;
    /**
     * 采用的时间字段含义、观察截点或数据批次；三者不混用。
     */
    role: TimeRoleRole;
    /**
     * observation_cutoff必须为带时区的时间值，data_batch必须为批次值；event_time可空（实际区间沿time_start/time_end）。
     */
    value: null | string;
}

/**
 * 采用的时间字段含义、观察截点或数据批次；三者不混用。
 */
export type TimeRoleRole = "event_time" | "observation_cutoff" | "data_batch";

export interface AnalysisFindingElement {
    calculation:    string;
    figures:        AnalysisFigureElement[];
    knowledge_refs: EvidenceRefElement[];
    limitations:    string[];
    query_refs:     AnalysisQueryReferenceElement[];
    text:           string;
}

export interface AnalysisFigureElement {
    column:    string;
    label:     string;
    query_id:  string;
    row_index: number;
    value:     boolean | number | null | string;
}

export interface AnalysisQueryReferenceElement {
    columns:    [string, ...string[]];
    query_id:   string;
    result_ref: string;
}

export interface AnalysisEvidenceRefElement {
    condition_version:   string;
    conversation_id:     string;
    evidence_id:         string;
    result_dependencies: AnalysisResultDependencyElement[];
    task_id:             string;
}

export interface AnalysisResultDependencyElement {
    query_id:   string;
    result_ref: string;
}

export interface AnalysisEvidenceSourcesClass {
    knowledge_refs:      EvidenceRefElement[];
    query_coverage:      AnalysisQueryCoverageElement[];
    result_dependencies: AnalysisResultDependencyElement[];
}

export interface AnalysisQueryCoverageElement {
    query_id:              string;
    received_rows:         number;
    result_complete:       boolean;
    result_ref:            string;
    saved_result_complete: boolean;
    saved_row_count:       number;
}

export interface AnalysisPreferenceCommandClass {
    expected_version: string;
    operation_id:     string;
    preferred:        boolean;
}

export interface AnalysisReportClass {
    charts:         AnalysisReportChartElement[];
    created_at:     string;
    evidence:       [AnalysisEvidenceElement, ...AnalysisEvidenceElement[]];
    reference:      AnalysisReportRefClass;
    schema_version: number;
    title:          string;
}

export interface AnalysisReportChartElement {
    dimension_column: string;
    kind:             AnalysisReportChartKind;
    measure_column:   string;
    query_id:         string;
    result_ref:       string;
    title:            string;
}

export type AnalysisReportChartKind = "line" | "bar";

export interface AnalysisReportRefClass {
    condition_version: string;
    conversation_id:   string;
    report_id:         string;
    task_id:           string;
    version:           string;
}

export interface AnalysisReportPageClass {
    charts?:              AnalysisReportChartElement[];
    content_page?:        ContentPageClass;
    content_text?:        string;
    evidence_ids?:        [string, ...string[]];
    reference:            AnalysisReportRefClass | null;
    status:               AnalysisReportPageStatus;
    title?:               string;
    historical_analysis?: PurpleHistoricalAnalysis;
}

/**
 * 支持正文自己的Unicode字符页；游标仍沿supports_next_cursor继续。同一支持的尾页不代表本回执已包含整条支持。
 *
 * 来源原话的独立字符分页。缺省source_text为空但保留总长和补读位置；以entry_id=source_text和同一资产版本读取。
 */
export interface ContentPageClass {
    complete:    boolean;
    next_offset: number | null;
    offset:      number;
    total_chars: number;
}

export interface PurpleHistoricalAnalysis {
    actual_sources:      { [key: string]: unknown };
    conditions:          { [key: string]: unknown }[];
    content_fingerprint: string;
    evidence:            { [key: string]: unknown }[];
    generated_at:        string;
    kind:                HistoricalAnalysisKind;
    reference:           AnalysisReportRefClass | null;
}

export type HistoricalAnalysisKind = "report";

export type AnalysisReportPageStatus = "available" | "condition_changed" | "sources_unavailable" | "historical";

export interface AnalysisReportViewClass {
    chart_results?: QueryResultsElement[];
    reference:      AnalysisReportRefClass | null;
    report?:        AnalysisReportClass;
    status:         AnalysisReportViewStatus;
}

export interface QueryResultsElement {
    columns:                ResultColumnElement[];
    data_freshness:         string;
    fetched_offset:         string;
    next_cursor:            null | string;
    query_id:               string;
    result_complete:        boolean;
    result_ref:             string;
    rows:                   Array<Array<null | string>>;
    saved_result_complete?: boolean;
    saved_row_count?:       number;
    source:                 string;
    /**
     * 应用对当前有权结果页计算的统计；历史客户端可省略。
     */
    statistics?: ResultStatisticsClass;
    truncated:   boolean;
}

export type AnalysisReportViewStatus = "available" | "condition_changed" | "sources_unavailable";

export interface ApplySemanticCorrectionClass {
    expected_revision: string;
    expected_version:  string;
    operation_id:      string;
    value:             string;
}

export interface AssetPageQueryClass {
    after_id?: string;
}

export interface AssignSemanticMaintainerClass {
    expected_version: string;
    /**
     * 超级维护者调整独立对象负责人；null 撤销，不能调整 Datasight 表或字段。
     */
    maintainer_id: null | string;
    operation_id:  string;
}

export interface CatalogColumnElement {
    comment:   string;
    data_type: string;
    id:        string;
    name:      string;
    nullable:  boolean;
}

export interface CatalogNodeClass {
    id:           string;
    sql:          string;
    upstream_ids: string[];
}

export interface CatalogPageClass {
    /**
     * true表示该snapshot覆盖完整命名空间，可在全部分页成功后使缺席对象失效；false不允许推断删除。
     */
    authoritative:    boolean;
    complete:         boolean;
    next_cursor:      null | string;
    schema_version:   number;
    snapshot_id:      string;
    source_namespace: string;
    tables:           CatalogTableElement[];
}

export interface CatalogTableElement {
    columns: [CatalogColumnElement, ...CatalogColumnElement[]];
    comment: string;
    ddl:     string;
    id:      string;
    /**
     * Datasight 维护人；未提供或 null 表示暂无负责人，不继承录入者。
     */
    maintainer_id?:   null | string;
    name:             string;
    node:             CatalogNodeClass | null;
    platform_version: string;
}

export interface ConversationSkillSelectionElement {
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

export interface ConversationSkillSelectionsClass {
    change_blocked:  boolean;
    conversation_id: string;
    next_after_id:   null | string;
    selections:      ConversationSkillSelectionElement[];
}

export interface EmbeddedSupportLocationClass {
    field:   Field;
    locator: SourceLocatorClass;
}

export type Field = "text" | "scope_text";

/**
 * offset及length固定使用Unicode code point；heading_path仅作定位提示。
 */
export interface SourceLocatorClass {
    heading_path?: string[];
    length:        number;
    offset:        number;
}

export interface GetQueryInputClass {
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

export interface KnowledgeRetrievalClass {
    channel?: KnowledgeRetrievalChannel;
    excerpts: KnowledgeRetrievalExcerptElement[];
    note:     string;
    state:    KnowledgeRetrievalState;
}

export type KnowledgeRetrievalChannel = "lexical" | "vector";

export interface KnowledgeRetrievalExcerptElement {
    entry_id:    string;
    length:      number;
    offset:      number;
    path:        string;
    text:        string;
    total_chars: number;
}

export type KnowledgeRetrievalState = "located" | "unlocated" | "index_lag";

export interface MaintenanceDependentElement {
    can_edit:            boolean;
    id:                  string;
    kind:                MaintenanceDependentKind;
    name:                string;
    references:          [MaintenanceReferenceElement, ...MaintenanceReferenceElement[]];
    references_complete: boolean;
    state:               MaintenanceDependentState;
    version:             string;
    visibility:          Visibility;
}

export type MaintenanceDependentKind = "table" | "field" | "metric" | "document" | "relationship" | "term" | "query_example" | "skill";

export interface MaintenanceReferenceElement {
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

export interface MaintenanceImpactClass {
    items:         MaintenanceDependentElement[];
    kind:          MaintenanceImpactKind;
    next_after_id: null | string;
    scope:         MaintenanceImpactScope;
    target:        PurpleMaintenanceTarget;
}

export type MaintenanceImpactKind = "knowledge" | "skill";

export type MaintenanceImpactScope = "direct_explicit_references";

export interface PurpleMaintenanceTarget {
    object_id: string;
    state:     MaintenanceDependentState;
    version:   string;
}

export interface MaintenanceImpactQueryClass {
    after_id?:        string;
    expected_version: string;
    kind:             MaintenanceImpactKind;
}

export interface PrepareSkillDraftInputClass {
    /**
     * Skill 的正文及生成资源每行最多 51200 UTF-8 字节；超限须分行保存。记忆不受此行限制。
     */
    body:              string;
    condition_version: string;
    evidence_ids:      [string, ...string[]];
    files:             SkillFileElement[];
    instruction_quote: string;
    name:              string;
    scope:             string;
    task_id:           string;
}

export interface SkillFileElement {
    /**
     * UTF-8 文本；每行最多 51200 字节，业务边界校验并返回 skill_line_too_long。
     */
    content: string;
    path:    string;
}

export interface PreparedRelationElement {
    citations:  [SourceCitationElement, ...SourceCitationElement[]];
    key:        string;
    predicate:  Predicate;
    scope_text: string;
    subject:    EvidenceRefElement;
    target:     SemanticReferenceClass;
}

export interface SourceCitationElement {
    locator:  SourceLocatorClass;
    revision: string;
    source:   SourceKeyElement;
}

export type Predicate = "explains" | "requires" | "exception" | "computes" | "derived_from" | "joins" | "related";

export interface SemanticReferenceClass {
    citation?: SourceCitationElement;
    kind:      SemanticReferenceKind;
    ref?:      EvidenceRefElement;
}

export type SemanticReferenceKind = "source" | "knowledge";

export interface PreparedStatementElement {
    citations:  [SourceCitationElement, ...SourceCitationElement[]];
    key:        string;
    scope_text: string;
    supports:   PreparedSupportElement[];
    /**
     * 对该陈述已记录必要支持提取范围的明确声明；省略或null保留unknown，semantic_status不代替此字段。
     */
    supports_complete?: boolean | null;
    target:             EvidenceRefElement;
    text:               string;
}

export interface PreparedSupportElement {
    content:     null | string;
    embedded_in: EmbeddedSupportLocationClass | null;
    key:         string;
    reference:   SemanticReferenceClass;
    role:        PreparedSupportRole;
}

export type PreparedSupportRole = "prerequisite" | "exception" | "calculation_dependency";

export interface PresentAnalysisAnswerInputClass {
    sources: [AnalysisAnswerSourceElement, ...AnalysisAnswerSourceElement[]];
    /**
     * 解释模板，定量结果用{{name}}引用values；正常语义数字（如零分母说明、年份、编号）可以直写，SQL代码块仍不放模板。定性解释必须有依据，不写未经证实的因果。
     */
    template: string;
    values:   AnalysisAnswerValueElement[];
}

export interface ProposalDraftCommandClass {
    base_version: string;
    entry_id:     string;
    evidence:     [EvidenceRefElement, ...EvidenceRefElement[]];
    object_id:    string;
    operation_id: string;
    reason:       string;
    value:        string;
}

export interface PublishSkillClass {
    expected_version: string;
    operation_id:     string;
    share_confirmed:  boolean;
}

export interface QueryExampleParameterElement {
    description: string;
    name:        string;
    required:    boolean;
    type:        QueryExampleParameterType;
}

export type QueryExampleParameterType = "string" | "number" | "integer" | "boolean";

export interface QueryExampleVerificationClass {
    evidence_refs: [EvidenceRefElement, ...EvidenceRefElement[]];
    note:          string;
}

export interface QueryResultCellReadClass {
    column:       ResultColumnElement;
    column_index: number;
    query_id:     string;
    result_ref:   string;
    row_index:    number;
    value:        null | string;
    view:         QueryResultCellReadView;
}

export type QueryResultCellReadView = "cell";

export interface QueryResultContentClass {
    content_format: ContentFormat;
    content_page:   PurpleQueryResultContentRange;
    content_text:   string;
    query_id:       string;
    result_ref:     string;
    view:           AgentQueryResultsView;
}

export interface QueryResultStatisticsReadClass {
    fetched_offset:        string;
    next_cursor:           null | string;
    query_id:              string;
    result_ref:            string;
    saved_result_complete: boolean;
    saved_row_count:       number;
    statistics:            ResultStatisticsClass;
    truncated:             boolean;
    view:                  QueryResultStatisticsReadView;
}

export type QueryResultStatisticsReadView = "statistics";

export interface ReadAnalysisReportInputClass {
    limit?:   number;
    offset?:  number;
    task_id:  string;
    version?: string;
}

export interface ReviewSemanticCorrectionClass {
    decision:          Decision;
    expected_revision: string;
    operation_id:      string;
    reason:            string;
}

export type Decision = "accepted" | "rejected";

export interface ReviewSkillSuggestionClass {
    expected_revision: string;
    operation_id:      string;
    response:          string;
    state:             ReviewSkillSuggestionState;
}

export type ReviewSkillSuggestionState = "handled" | "rejected";

export interface ReviseSemanticCorrectionClass {
    base_version:      string;
    entry_id:          string;
    evidence:          [EvidenceRefElement, ...EvidenceRefElement[]];
    expected_revision: string;
    object_id:         string;
    operation_id:      string;
    reason:            string;
    share_confirmed:   boolean;
    value:             string;
}

export interface SaveAnalysisEvidenceInputClass {
    condition_version: string;
    data_range:        string;
    findings:          [AnalysisFindingElement, ...AnalysisFindingElement[]];
    task_id:           string;
}

export interface SaveAnalysisReportClass {
    charts:            AnalysisReportChartElement[];
    condition_version: string;
    evidence_ids:      [string, ...string[]];
    expected_version:  null | string;
    operation_id:      string;
    task_id:           string;
    title:             string;
}

export interface SaveAnalysisReportInputClass {
    charts:            AnalysisReportChartElement[];
    condition_version: string;
    evidence_ids:      [string, ...string[]];
    expected_version:  null | string;
    task_id:           string;
    title:             string;
}

export interface SemanticAccessClass {
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
export interface SemanticCheckReportClass {
    checks:   PurpleCheck[];
    coverage: PurpleCoverage;
}

export interface PurpleCheck {
    coverage_limit: string;
    evidence_refs:  SemanticEvidenceRefElement[];
    finding:        string;
    rule:           string;
    state:          CheckState;
}

export interface SemanticEvidenceRefElement {
    object_id: string;
    version:   string;
}

export type CheckState = "checked" | "warning" | "not_checked";

export interface PurpleCoverage {
    missing_semantics:      string[];
    sql_shape:              SQLShape;
    supported_scope:        string[];
    unsupported_constructs: string[];
}

export type SQLShape = "supported" | "unsupported";

export interface SemanticColumnRefClass {
    column:    string;
    object_id: string;
    version:   string;
}

export interface SemanticCorrectionElement {
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
    evidence:        [EvidenceRefElement, ...EvidenceRefElement[]];
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

export interface SemanticCorrectionListClass {
    corrections:   SemanticCorrectionElement[];
    next_after_id: null | string;
}

export interface SemanticMaintenanceClass {
    authority_id: string;
    can_assign:   boolean;
    can_edit:     boolean;
    /**
     * 当前对象负责人：表来自 Datasight；独立人工对象默认创建者，超级维护者可调整。
     */
    maintainer_id: null | string;
    source:        Source;
    version:       string;
}

export type Source = "datasight" | "creator" | "system";

export interface SemanticMemberListClass {
    user_ids: string[];
}

export interface SemanticRelationElement {
    citations:   SourceCitationElement[];
    origin:      Origin;
    predicate:   Predicate;
    relation_id: string;
    scope_text:  string;
    subject:     EvidenceRefElement;
    target:      SemanticReferenceClass;
}

export type Origin = "source_fact" | "model_inference" | "human";

export interface SemanticStatementElement {
    citations:    SourceCitationElement[];
    object_ref:   EvidenceRefElement;
    origin:       Origin;
    scope_text:   string;
    statement_id: string;
    supports:     SemanticSupportElement[];
    /**
     * 人工或整理成果对该陈述支持提取范围的明确完整性声明；历史缺字段或null为unknown，不从空supports或ready推导。
     */
    supports_complete?: boolean | null;
    text:               string;
}

export interface SemanticSupportElement {
    content:     null | string;
    embedded_in: EmbeddedSupportLocationClass | null;
    reference:   SemanticReferenceClass;
    role:        PreparedSupportRole;
    support_id:  string;
}

export type SemanticStructureClass = SemanticStructure;

export type Cardinality = "one_to_one" | "one_to_many" | "many_to_one" | "many_to_many";

export interface ComputedMetricElement {
    /**
     * 输出该口径的表达式或列计算说明。
     */
    expression: string;
    metric_ref: EvidenceRefElement;
    /**
     * 该SQL实际输出的口径名；与过滤中用到的指标分开表达。
     */
    output_name: string;
}

export interface PurpleJoinKey {
    left_column:  string;
    right_column: string;
}

export type SemanticStructureKind = "table" | "field" | "relationship" | "metric" | "query_example";

export interface SemanticTableRefClass {
    object_id: string;
    version:   string;
}

export interface PurpleTimeColumn {
    column: string;
    role:   string;
}

export interface SkillDraftElement {
    /**
     * Skill 的正文及生成资源每行最多 51200 UTF-8 字节；超限须分行保存。记忆不受此行限制。
     */
    body?:          string;
    created_at?:    string;
    dependencies?:  EvidenceRefElement[];
    evidence_refs?: [AnalysisEvidenceRefElement, ...AnalysisEvidenceRefElement[]];
    files?:         SkillFileElement[];
    name?:          string;
    reference:      SkillDraftRefClass;
    scope?:         string;
    status:         SkillDraftStatus;
    asset_id?:      string;
}

export interface SkillDraftRefClass {
    condition_version: string;
    conversation_id:   string;
    draft_id:          string;
    source_message_id: string;
    task_id:           string;
}

export type SkillDraftStatus = "pending" | "confirmed" | "condition_changed" | "sources_unavailable";

export interface SkillDraftListClass {
    drafts:        SkillDraftElement[];
    next_after_id: null | string;
}

export interface SkillReadInputClass {
    limit?:  number;
    offset?: number;
    path:    string;
}

export interface SkillRemovalReceiptClass {
    asset_id:        string;
    conversation_id: string;
    operation_id:    string;
    selection_id:    string;
    state:           SkillRemovalReceiptState;
}

export type SkillRemovalReceiptState = "removed";

export interface SkillSelectionRemovalClass {
    asset_id:     string;
    operation_id: string;
    selection_id: string;
}

export interface SkillSuggestionElement {
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

export interface SkillSuggestionListClass {
    next_after_id: null | string;
    suggestions:   SkillSuggestionElement[];
}

export interface SourceExcerptClass {
    citation: SourceCitationElement;
    content:  string;
}

export interface SourcePreparationResultClass {
    relations:       PreparedRelationElement[];
    semantic_status: SourcePreparationResultSemanticStatus;
    statements:      PreparedStatementElement[];
    unresolved:      string[];
}

export type SourcePreparationResultSemanticStatus = "partial" | "ready";

export interface SourceSyncAcceptedClass {
    status:     SourceSyncAcceptedStatus;
    status_url: string;
    sync_id:    string;
}

export type SourceSyncAcceptedStatus = "queued" | "running" | "completed" | "failed";

export interface SourceSyncProgressClass {
    error_code: null | string;
    /**
     * 已持久化的可展示失败说明，例如来源的实际大小和上限；旧批次可缺省。
     */
    error_message?:    null | string;
    knowledge_index:   SourceWorkProgressClass;
    pages_committed:   number;
    preparation:       SourceWorkProgressClass;
    processed_sources: number;
    raw_index:         SourceWorkProgressClass;
    status:            SourceSyncAcceptedStatus;
    status_url:        string;
    sync_id:           string;
}

export interface SourceWorkProgressClass {
    completed: number;
    failed:    number;
    status:    SourceWorkProgressStatus;
    total:     number;
}

export type SourceWorkProgressStatus = "pending" | "running" | "completed" | "failed" | "not_required";

export interface SubmitSemanticCorrectionClass {
    base_version:    string;
    entry_id:        string;
    evidence:        [EvidenceRefElement, ...EvidenceRefElement[]];
    object_id:       string;
    operation_id:    string;
    reason:          string;
    share_confirmed: boolean;
    value:           string;
}

export interface SuggestSkillClass {
    content:          string;
    expected_version: string;
    operation_id:     string;
    share_confirmed:  boolean;
}

export interface TableAnalysisPreferenceClass {
    preferred: boolean;
    table_id:  string;
    version:   string;
}

export interface WorkspaceTaskElement {
    decision_state_version?: number;
    evidence_refs?:          AnalysisEvidenceRefElement[];
    legacy_pending?:         LegacyPendingClass;
    report_ref?:             AnalysisReportRefClass;
    revision_origin?:        RevisionOriginClass;
    [property: string]: unknown;
}

/**
 * 旧条件未决的只读投影；索引来自原数组，basis-only旧项用索引0。不授采纳或执行权。
 */
export interface LegacyPendingClass {
    condition_version: string;
    items:             [LegacyPendingItemElement, ...LegacyPendingItemElement[]];
}

export interface LegacyPendingItemElement {
    index:             number;
    text?:             string;
    text_unavailable?: boolean;
}

/**
 * 显式读取旧条件版本时接回的真实成功修订出处；原话只说明来源，不自动证明采纳或授执行权。
 */
export interface RevisionOriginClass {
    message_id:    string;
    operation_id:  string;
    origin_run_id: string;
    user_quote:    null | string;
    user_supplied: boolean;
}

/**
 *
 * 新格式仅记录已经采用的解释。explicit_user引用本轮完整原话，null/省略采纳身份由宿主绑定；原已核对象可同文继承。未决只登记clarifications，无问题且条件充分时不要求本对象。
 */
export interface AdoptedSemanticResolutionClass {
    adoption_message_id?: null | string;
    basis:                SemanticResolutionBasisEnum;
    evidence_refs?:       EvidenceRefElement[];
    interpretation:       string;
    user_quote:           null | string;
}

/**
 * 真实用户明确选择、确无实质歧义、或仍需澄清；资料支持某公式不等于用户选择它。
 */
export type SemanticResolutionBasisEnum = "explicit_user" | "unambiguous";

export interface AnalysisUpdateClass {
    action: AnalysisUpdateAction;
    /**
     * 同一任务需分别回答的独立问题，各生成独立ID；与非空question互斥，不同目标分别建任务。
     */
    clarifications?: ClarificationElement[];
    /**
     *
     * 修改已存任务条件时必填，action用revise或clarify；set指定新值，unset可省略（省略即不清空任何字段，null非法）。route禁止携带condition_patch，因为route只登记归属。
     */
    condition_patch?: AnalysisUpdateConditionPatch;
    /**
     * 新建任务必须完整给出；未指定的可空标量用JSON null，列表用[]，notes用空字符串，timezone按宿主业务时区。
     */
    conditions?: AnalysisEvidenceConditions;
    /**
     * 新建任务省略此字段（也接受JSON null）；已有任务必须提供工具回执中的当前版本数字字符串。
     */
    expected_version?: null | string;
    /**
     *
     * 仅route可用：显式定稿当前任务已完成的说明或查询答案；可route到同一任务保留其SQL等待状态，也可切到其他目标。该助手消息只允许这个route；宿主绑定完整正文或原成功答案回执。普通route不定稿，不授执行权。
     */
    finalize_current_answer?:     boolean;
    goal?:                        string;
    legacy_resolution_migration?: LegacyResolutionMigrationClass;
    /**
     * split迁移到新独立目标的原开放问题ID，保留问题正文与来源，其余原目标问题不动。
     */
    moved_clarification_ids?: string[];
    /**
     * 澄清问题的候选答案；仅与实际question同用，开放回答可无候选（空数组或省略）。
     */
    options: string[];
    /**
     * 需要用户补充的实际问题；无需澄清时省略（也接受JSON null），不能填字符串null、空文本或用户原问题。
     */
    question?:          null | string;
    replaces_query_id?: null | string;
    /**
     *
     * 本消息中用户已真实回答，或当前有效且获准资料已唯一解决的事实问题ID；事实解决须在同次revise保存条件与依据，不能伪称用户选择。省略或[]保留其他问题，仅已有任务revise/clarify可用。
     */
    resolved_clarification_ids?: string[];
    /**
     * 新建任务省略此字段（也接受JSON null）；已有任务用工具回执中的真实ID，不能填字符串null。
     */
    task_id?: null | string;
}

export type AnalysisUpdateAction = "create" | "revise" | "clarify" | "route" | "split";

export interface ClarificationElement {
    /**
     * 此独立问题的候选答案；允许自由回答。
     */
    options: string[];
    /**
     * 此独立问题的必填正文；无需新增问题时省略整个clarifications列表。
     */
    question: string;
}

/**
 *
 * 修改已存任务条件时必填，action用revise或clarify；set指定新值，unset可省略（省略即不清空任何字段，null非法）。route禁止携带condition_patch，因为route只登记归属。
 */
export interface AnalysisUpdateConditionPatch {
    set: PurpleConditionSet;
    /**
     * 清除指定条件字段。省略即空集合（不清空任何字段），null非法；显式数组仍清除列出的字段。
     */
    unset?: Unset[];
}

export interface PurpleConditionSet {
    channel?:        ConditionsChannel;
    filters?:        string[];
    group_by?:       string[];
    knowledge_refs?: EvidenceRefElement[];
    metric?:         string;
    notes?:          string;
    /**
     * 只更新已采用解释及来源；null/unset只清说明，不解决开放问题。旧未决通过明确legacy_resolution_migration转换。
     */
    semantic_resolution?: QueryViewQuerySemanticResolution | null;
    /**
     * 设置来源限制；撤销使用unset source_limits，不接受设为空集。
     */
    source_limits?: SourceLimitsClass;
    /**
     * 修改区间的不包含终点，按业务时区解析后填写UTC完整时间戳，以Z结尾；整月结束为下一月起点。清空使用unset；未修改则省略。
     */
    time_end?: string;
    /**
     * 整体替换时间口径角色；清空使用unset。
     */
    time_roles?: [TimeRoleElement, ...TimeRoleElement[]];
    /**
     * 修改区间的包含起点，按业务时区解析后填写UTC完整时间戳，以Z结尾。清空使用unset；未修改则省略。
     */
    time_start?: string;
    timezone?:   string;
}

export type Unset = "time_start" | "time_end" | "metric" | "channel" | "group_by" | "filters" | "knowledge_refs" | "notes" | "source_limits" | "time_roles" | "semantic_resolution";

/**
 * 仅revise显式转换旧未决。每项链接实际问题；已resolved项给原条件版本及所指顶层字段，宿主核实际回执/原消息及字段来源。无依据保持或恢复open，未关联旧项登记open。
 */
export interface LegacyResolutionMigrationClass {
    from_condition_version: string;
    links:                  LegacyResolutionLinkElement[];
}

export interface LegacyResolutionLinkElement {
    clarification_id:              string;
    condition_fields?:             [ConditionField, ...ConditionField[]];
    pending_index:                 number;
    resolution_condition_version?: string;
}

export type ConditionField = "time_start" | "time_end" | "timezone" | "metric" | "channel" | "group_by" | "filters" | "knowledge_refs" | "notes" | "source_limits" | "time_roles" | "semantic_resolution";

export interface AppErrorClass {
    code:       Code;
    message:    string;
    request_id: string;
    retryable:  boolean;
}

export type Code = "budget_exhausted" | "chunk_gap" | "forbidden" | "idempotency_conflict" | "input_already_applied" | "invalid_evidence" | "invalid_input" | "lease_lost" | "message_pending" | "not_available" | "outcome_unknown" | "result_unavailable" | "scope_incomplete" | "selection_required" | "source_not_allowed" | "source_unavailable" | "stale_context" | "stale_knowledge" | "task_context_required" | "unauthenticated" | "unavailable" | "unsupported" | "version_conflict" | "memory_unavailable" | "memory_extraction_empty" | "memory_operation_unknown" | "vector_unconfigured" | "vector_unavailable" | "embedding_unavailable" | "source_interrupted" | "result_expired" | "model_retry_exhausted" | "model_unavailable" | "invalid_model_endpoint" | "model_credential_required" | "model_secret_unavailable" | "model_capacity_invalid" | "task_inactive" | "waiting_clarification" | "clarification_not_open" | "clarification_required" | "provider_configuration_invalid" | "provider_model_unavailable" | "invalid_skill_resource" | "invalid_skill_receipt" | "model_run_failed" | "model_request_failed" | "model_input_limit" | "model_output_limit" | "request_too_large: model_input_limit" | "model_budget_exhausted" | "model_timeout" | "model_auth_failed" | "model_rate_limited" | "model_quota_exhausted" | "model_service_unavailable" | "model_network_error" | "model_usage_unknown" | "model_usage_invalid" | "model_limits_exceeded" | "model_finalize_unconfirmed" | "model_receipt_unknown" | "provider_transport_rejected" | "provider_parameters_changed" | "provider_payload_invalid" | "run_cancelled" | "checkpoint_conflict" | "answer_sources_required" | "no_final_output" | "invalid_tool_arguments";

export interface AppendOutputClass {
    chunk_seq:   string;
    lease_epoch: string;
    run_id:      string;
    text:        string;
}

export interface AssetElement {
    body:                string;
    can_edit?:           boolean;
    dependencies:        EvidenceRefElement[];
    files?:              SkillFileElement[];
    id:                  string;
    kind:                AssetKind;
    memory_index_state?: MemoryIndexState;
    name:                string;
    owner_id?:           string;
    scope:               string;
    selected:            boolean;
    source_text:         string;
    state:               AssetState;
    /**
     * 来源失效或缺少可核验来源时仅供管理，正文、附件与引用已隐藏，不能选用或发布。
     */
    text_unavailable?: boolean;
    verified:          boolean;
    version:           string;
    visibility?:       Visibility;
}

export type AssetKind = "memory" | "skill";

export type MemoryIndexState = "queued" | "issued" | "indexed" | "failed" | "superseded";

export type AssetState = "enabled" | "disabled" | "deleted" | "draft";

export interface AssetListClass {
    assets: AssetElement[];
}

export interface AssetReadRefClass {
    id:      string;
    version: string;
}

export interface AssetSaveClass {
    /**
     * Skill 的正文及生成资源每行最多 51200 UTF-8 字节；超限须分行保存。记忆不受此行限制。
     */
    body:             string;
    dependencies:     EvidenceRefElement[];
    draft_id?:        string;
    expected_version: null | string;
    files?:           SkillFileElement[];
    id:               null | string;
    kind:             AssetKind;
    name:             string;
    operation_id:     string;
    scope:            string;
    source_text:      string;
    verified:         boolean;
}

export interface AssetToolInputClass {
    action:            AssetToolInputAction;
    asset_id?:         string;
    body?:             string;
    dependencies?:     EvidenceRefElement[];
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

export interface CancelReceiptClass {
    run_id: string;
    state:  CancelReceiptState;
}

export type CancelReceiptState = "cancelled" | "finished" | "interrupted" | "failed";

export interface CancelRunClass {
    lease_epoch: string;
    run_id:      string;
}

export interface ChatMessageElement {
    attempt_id:     null | string;
    committed:      boolean;
    event_seq?:     string;
    message_id?:    null | string;
    output_id?:     null | string;
    request_clock?: RequestClockClass;
    role:           ChatMessageRole;
    text:           string;
}

export interface RequestClockClass {
    business_timezone:  BusinessTimezone;
    reference_time_utc: string;
}

export type BusinessTimezone = "UTC" | "Asia/Shanghai";

export type ChatMessageRole = "user" | "assistant";

export interface CheckpointClass {
    authority_revision?: null | string;
    authority_snapshot?: { [key: string]: unknown };
    entries:             { [key: string]: unknown }[];
    leaf_id:             null | string;
    sdk_version:         SDKVersion;
    storage?:            CheckpointReferenceClass;
}

export type SDKVersion = "1.0.0" | "1.3.0" | "1.4.0";

export interface CheckpointReferenceClass {
    file?:        string;
    kind:         CheckpointReferenceKind;
    session_id?:  string;
    fingerprint?: string;
}

export type CheckpointReferenceKind = "pi_session" | "host_checkpoint";

export interface ConfiguredModelClass {
    anthropic_thinking_mode?: AnthropicThinkingMode;
    api:                      API;
    id:                       string;
    input_rate:               string;
    output_rate:              string;
    reasoning_supported:      boolean;
    service_id:               string;
    service_version:          string;
    version:                  string;
}

export type AnthropicThinkingMode = "budget" | "adaptive";

export type API = "openai-completions" | "openai-responses" | "anthropic-messages";

export interface ConfirmQueryClass {
    condition_version: string;
    draft_version:     string;
    operation_id:      string;
}

export interface ConversationModelSelectionClass {
    selection: ModelSelectionClass | null;
    version:   string;
}

export interface ModelSelectionClass {
    model_id:       string;
    thinking_level: ThinkingLevel;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ConversationReadInputClass {
    after_seq:       string;
    message_id?:     string;
    offset?:         number;
    task_after?:     string;
    task_directory?: boolean;
}

export interface ConversationReceiptClass {
    conversation_id: string;
}

export interface CreateConversationClass {
    operation_id: string;
}

export interface CurrentAnalysisUpdateClass {
    action: AnalysisUpdateAction;
    /**
     * 同一任务需分别回答的独立问题，各生成独立ID；与非空question互斥，不同目标分别建任务。
     */
    clarifications?: ClarificationElement[];
    /**
     *
     * 修改已存任务条件时必填，action用revise或clarify；set指定新值，unset可省略（省略即不清空任何字段，null非法）。route禁止携带condition_patch，因为route只登记归属。
     */
    condition_patch?: PurpleConditionPatch;
    /**
     * 新建任务必须完整给出；未指定的可空标量用JSON null，列表用[]，notes用空字符串，timezone按宿主业务时区。
     */
    conditions?: PurpleConditions;
    /**
     * 新建任务省略此字段（也接受JSON null）；已有任务必须提供工具回执中的当前版本数字字符串。
     */
    expected_version?: null | string;
    /**
     *
     * 仅route可用：显式定稿当前任务已完成的说明或查询答案；可route到同一任务保留其SQL等待状态，也可切到其他目标。该助手消息只允许这个route；宿主绑定完整正文或原成功答案回执。普通route不定稿，不授执行权。
     */
    finalize_current_answer?:     boolean;
    goal?:                        string;
    legacy_resolution_migration?: LegacyResolutionMigrationClass;
    /**
     * split迁移到新独立目标的原开放问题ID，保留问题正文与来源，其余原目标问题不动。
     */
    moved_clarification_ids?: string[];
    /**
     * 澄清问题的候选答案；仅与实际question同用，开放回答可无候选（空数组或省略）。
     */
    options?: string[];
    /**
     * 需要用户补充的实际问题；无需澄清时省略（也接受JSON null），不能填字符串null、空文本或用户原问题。
     */
    question?:          null | string;
    replaces_query_id?: null | string;
    /**
     *
     * 本消息中用户已真实回答，或当前有效且获准资料已唯一解决的事实问题ID；事实解决须在同次revise保存条件与依据，不能伪称用户选择。省略或[]保留其他问题，仅已有任务revise/clarify可用。
     */
    resolved_clarification_ids?: string[];
    /**
     * 新建任务省略此字段（也接受JSON null）；已有任务用工具回执中的真实ID，不能填字符串null。
     */
    task_id?: null | string;
}

/**
 *
 * 修改已存任务条件时必填，action用revise或clarify；set指定新值，unset可省略（省略即不清空任何字段，null非法）。route禁止携带condition_patch，因为route只登记归属。
 */
export interface PurpleConditionPatch {
    set: FluffyConditionSet;
    /**
     * 清除指定条件字段。省略即空集合（不清空任何字段），null非法；显式数组仍清除列出的字段。
     */
    unset?: Unset[];
}

export interface FluffyConditionSet {
    channel?:        ConditionsChannel;
    filters?:        string[];
    group_by?:       string[];
    knowledge_refs?: EvidenceRefElement[];
    metric?:         string;
    notes?:          string;
    /**
     * 只更新已采用解释及来源；null/unset只清说明，不解决开放问题。旧未决通过明确legacy_resolution_migration转换。
     */
    semantic_resolution?: PurpleSemanticResolution | null;
    /**
     * 设置来源限制；撤销使用unset source_limits，不接受设为空集。
     */
    source_limits?: SourceLimitsClass;
    /**
     * 修改区间的不包含终点，按业务时区解析后填写UTC完整时间戳，以Z结尾；整月结束为下一月起点。清空使用unset；未修改则省略。
     */
    time_end?: string;
    /**
     * 整体替换时间口径角色；清空使用unset。
     */
    time_roles?: [TimeRoleElement, ...TimeRoleElement[]];
    /**
     * 修改区间的包含起点，按业务时区解析后填写UTC完整时间戳，以Z结尾。清空使用unset；未修改则省略。
     */
    time_start?: string;
    timezone?:   string;
}

/**
 *
 * 新格式仅记录已经采用的解释。explicit_user引用本轮完整原话，null/省略采纳身份由宿主绑定；原已核对象可同文继承。未决只登记clarifications，无问题且条件充分时不要求本对象。
 */
export interface PurpleSemanticResolution {
    /**
     *
     * explicit_user：null=本轮新采纳，由宿主核对user_quote为本轮完整原话后绑定真实消息身份；非空=复制继承原已验证决策的消息身份，不接受模型自由填写。其余basis为null。
     */
    adoption_message_id?: null | string;
    /**
     * 真实用户明确选择、确无实质歧义、或仍需澄清；资料支持某公式不等于用户选择它。
     */
    basis: SemanticResolutionBasisEnum;
    /**
     * 支撑该口径决策的依据引用；旧调用缺失按空数组解码。
     */
    evidence_refs?: EvidenceRefElement[];
    /**
     * 本稿采用的指标、分子/分母、时间等关键口径及选择依据；不能把自己刚写入任务的假设当作用户采用。
     */
    interpretation: string;
    /**
     * explicit_user逐字填写本条真实用户完整原话，保留否定、前提、例外和换行，不截取子串；其余为null。
     */
    user_quote: null | string;
}

/**
 * 新建任务必须完整给出；未指定的可空标量用JSON null，列表用[]，notes用空字符串，timezone按宿主业务时区。
 */
export interface PurpleConditions {
    channel:        ConditionsChannel | null;
    filters:        string[];
    group_by:       string[];
    knowledge_refs: EvidenceRefElement[];
    metric:         null | string;
    notes:          string;
    /**
     * 当前格式仅记录已采用解释及依据，未决由clarifications表达；省略继承，null只清说明，未要求所有任务填写。旧形状按宿主持久格式标记兼容，读取不迁移。
     */
    semantic_resolution?: FluffySemanticResolution | null;
    /**
     * null表示本题显式未声明额外来源限制；字段缺失表示旧条件版本未记录新式限制，不能证明用户从未限制。撤销必须显式unset并来自真实用户修改。
     */
    source_limits?: SourceLimitsClass | null;
    /**
     * 时间区间的不包含终点。按明确的业务时区解析后转为UTC完整时间戳，以Z结尾；整月结束为下一月起点，不能写本月最后一天。未指定时为null。
     */
    time_end: null | string;
    /**
     * 时间口径角色；统计起止仍沿time_start/time_end，request_clock和平台data_freshness不冒充用户截点。字段缺失表示旧版本未记录。
     */
    time_roles?: TimeRoleElement[];
    /**
     * 时间区间的包含起点。按明确的业务时区解析后转为UTC完整时间戳，以Z结尾；不能只写日期。未指定时为null。
     */
    time_start: null | string;
    timezone:   string;
}

/**
 *
 * 新格式仅记录已经采用的解释。explicit_user引用本轮完整原话，null/省略采纳身份由宿主绑定；原已核对象可同文继承。未决只登记clarifications，无问题且条件充分时不要求本对象。
 */
export interface FluffySemanticResolution {
    /**
     *
     * explicit_user：null=本轮新采纳，由宿主核对user_quote为本轮完整原话后绑定真实消息身份；非空=复制继承原已验证决策的消息身份，不接受模型自由填写。其余basis为null。
     */
    adoption_message_id?: null | string;
    /**
     * 真实用户明确选择、确无实质歧义、或仍需澄清；资料支持某公式不等于用户选择它。
     */
    basis: SemanticResolutionBasisEnum;
    /**
     * 支撑该口径决策的依据引用；旧调用缺失按空数组解码。
     */
    evidence_refs?: EvidenceRefElement[];
    /**
     * 本稿采用的指标、分子/分母、时间等关键口径及选择依据；不能把自己刚写入任务的假设当作用户采用。
     */
    interpretation: string;
    /**
     * explicit_user逐字填写本条真实用户完整原话，保留否定、前提、例外和换行，不截取子串；其余为null。
     */
    user_quote: null | string;
}

export interface CurrentRequestQueryInputClass {
    condition_version:  string;
    knowledge_refs:     EvidenceRefElement[];
    parameters:         { [key: string]: unknown };
    replaces_query_id?: null | string;
    /**
     * 省略继承目标条件版本已有采纳说明；兼容携带只核同义声明，不能独立另作决定。新任务未决定时登记clarifications，改变解释先同次修订条件。旧形状仅沿旧格式兼容。
     */
    semantic_resolution?: IndigoSemanticResolution;
    sql:                  string;
    summary:              string;
    target_id:            TargetID;
    task_id:              string;
}

/**
 * 旧未决形状与新采纳说明仅在兼容边界解码；实际条件格式由宿主decision_state_version决定。
 *
 * 省略继承目标条件版本已有采纳说明；兼容携带只核同义声明，不能独立另作决定。新任务未决定时登记clarifications，改变解释先同次修订条件。旧形状仅沿旧格式兼容。
 *
 *
 * 新格式仅记录已经采用的解释。explicit_user引用本轮完整原话，null/省略采纳身份由宿主绑定；原已核对象可同文继承。未决只登记clarifications，无问题且条件充分时不要求本对象。
 */
export interface IndigoSemanticResolution {
    /**
     *
     * explicit_user：null=本轮新采纳，由宿主核对user_quote为本轮完整原话后绑定真实消息身份；非空=复制继承原已验证决策的消息身份，不接受模型自由填写。其余basis为null。
     */
    adoption_message_id?: null | string;
    /**
     * 真实用户明确选择、确无实质歧义、或仍需澄清；资料支持某公式不等于用户选择它。
     */
    basis: SemanticResolutionBasisEnum;
    /**
     * 支撑该口径决策的依据引用；旧调用缺失按空数组解码。
     */
    evidence_refs?: EvidenceRefElement[];
    /**
     * 本稿采用的指标、分子/分母、时间等关键口径及选择依据；不能把自己刚写入任务的假设当作用户采用。
     */
    interpretation: string;
    /**
     * explicit_user逐字填写本条真实用户完整原话，保留否定、前提、例外和换行，不截取子串；其余为null。
     */
    user_quote: null | string;
}

export type TargetID = "synthetic-sqlite";

export interface DataToolInvocationClass {
    answer_handoff?: AnswerHandoffClass;
    arguments:       { [key: string]: unknown };
    checkpoint:      CheckpointClass;
    lease_epoch:     string;
    /**
     * 宿主按实际Pi投影与同批工具共享余量分配；不参与业务身份，不属于模型工具参数。历史调用可缺省。
     */
    response_budget?: ResponseBudgetClass;
    run_id:           string;
    sdk_tool_call_id: string;
    tool_name:        ToolName;
}

/**
 * 显式route登记时冻结的宿主事实；恢复先接原登记，不从新attempt重算。成功答案回执仍是候选，route事务提交后才成为part。
 */
export interface AnswerHandoffClass {
    answer_sdk_tool_call_id?: string;
    assistant?:               OutputBindingClass;
    /**
     * 渲染正文交接分支；与顶层assistant互斥。当前冻结route所在原assistant允许toolUse，tool_call_ids只含本次route。
     */
    rendered_answer_binding?: RenderedAnswerBindingClass;
}

/**
 * 宿主从Pi完整助手条目绑定，正文位置来自已确认输出队列；模型不能提供这些字段。
 *
 * 原Pi entry/attempt/stop/tool
 * IDs与source_text的SHA256；本分支禁止携带first/last_chunk_seq，展示范围由外层字段表达。
 *
 *
 * 宿主确认的正常完整自然final原输出绑定；恢复时保原attempt/entry/片段。须有final_text，与answer_parts、answer_sdk_tool_call_id、control_delivery_ref及final_start_chunk_seq互斥。
 */
export interface OutputBindingClass {
    attempt_id:       string;
    entry_id:         string;
    first_chunk_seq?: string;
    last_chunk_seq?:  string;
    stop_reason:      StopReason;
    text_sha256:      string;
    tool_call_ids:    string[];
}

export type StopReason = "stop" | "toolUse" | "length" | "error" | "aborted";

/**
 * 渲染正文交接分支；与顶层assistant互斥。当前冻结route所在原assistant允许toolUse，tool_call_ids只含本次route。
 *
 * 宿主生成的一次渲染绑定：原文、原prepare回执与展示片段范围；模型不能提供这些字段。
 *
 * 未冻结末项的渲染正文分支；与output_binding、answer_sdk_tool_call_id互斥。
 *
 *
 * 单份渲染正文分支：final_text为该份display（非模板、非整轮组合全文），与answer_parts、answer_sdk_tool_call_id、control_delivery_ref、output_binding及final_start_chunk_seq互斥。组合时改用answer_parts末项的rendered分支，不传顶层rendered。
 */
export interface RenderedAnswerBindingClass {
    /**
     * 原Pi entry/attempt/stop/tool
     * IDs与source_text的SHA256；本分支禁止携带first/last_chunk_seq，展示范围由外层字段表达。
     */
    assistant: OutputBindingClass;
    /**
     * 已持久化展示片段范围；display = replace_once(source_text, bindings) + required_suffix。
     */
    first_chunk_seq: string;
    last_chunk_seq:  string;
    /**
     * 本条正文实际采用的原prepare_analysis_answer成功回执；不因分支上后来存在新prepare而改用最近一份。
     */
    prepared_sdk_tool_call_id: string;
    /**
     * 原Pi完整正文（含{{name}}标记），来自Node宿主SessionManager原assistant entry；不是展示替换后的文字。Rust边界核对其UTF-8
     * SHA256。
     */
    source_text: string;
}

/**
 * 宿主按实际Pi投影与同批工具共享余量分配；不参与业务身份，不属于模型工具参数。历史调用可缺省。
 */
export interface ResponseBudgetClass {
    estimated_tokens:       number;
    max_bytes:              number;
    projection_fingerprint: string;
}

export type ToolName = "search_knowledge" | "read_knowledge" | "read_source" | "validate_sql" | "request_query" | "execute_query" | "update_analysis_task" | "get_query" | "cancel_query" | "manage_personal_asset" | "propose_semantic_change" | "read_conversation" | "read_analysis_task" | "read" | "save_analysis_evidence" | "save_analysis_report" | "read_analysis_report" | "prepare_skill_draft" | "present_analysis_answer" | "prepare_analysis_answer";

export interface DataToolOutcomeClass {
    answer_parts?: AnswerPartReferenceElement[];
    /**
     * 成功答案的原工具登记归属，来自宿主task_id/task_condition_version；与实际sources和通知交付目标分开，不改原回执存储字节。
     */
    answer_task_ref?: EvidenceTaskRefElement;
    /**
     * 宿主成功回执声明需要Pi原生重投影的活动任务。省略表示无需调整。
     */
    context_reset?:    DataToolOutcomeContextReset | null;
    control_delivery?: ControlDeliveryClass | null;
    data:              { [key: string]: unknown };
    /**
     *
     * 宿主按本运行原通知query/task/condition及其原scope核验全部实际冻结答案后的覆盖事实；与control_delivery共同计算，不从source_query_ids推断。只随控制状态回执更新，不授来源或SQL权限。
     */
    frozen_notification_covered?: boolean;
    operation_id:                 string;
    /**
     * 未就绪原因，由原判定同次产出；就绪时省略。旧回执可缺省，不据缺省推断已就绪，恢复时采用当前宿主事实。
     */
    source_context_blocker?: SourceContextBlocker;
    /**
     * 宿主核对本消息归属和来源声明后的正文准入状态；不由模型填写。若context_reset存在，Pi先完成既有重投影/刷新再采用新正文。
     */
    source_context_ready?: boolean;
    /**
     * 本次条件修订实际作废的未提交SQL草稿ID；宿主同事务生成，消费者撤下旧观察。缺省表示旧回执未提供该信息，不据此推定草稿有效。
     */
    superseded_query_ids?: string[];
    /**
     * 生成该结果的原tool合同版本，成功与明确拒绝均沿原登记值；历史缺失按1，Node可由已校验的原OperationReceipt补足。
     */
    tool_contract_version?: number;
    tool_name:              ToolName;
}

/**
 *
 * 有序原内容引用。已定稿项只携宿主控制身份和实际source_query_ids，不凭ID命中判断通知scope覆盖；有新末项时引用原输出或成功答案回执。数量还须受实际消息任务集合约束，不增加模型额度。
 */
export interface AnswerPartReferenceElement {
    answer_sdk_tool_call_id?:       string;
    finalized_by_sdk_tool_call_id?: string;
    output_binding?:                OutputBindingClass;
    /**
     * 未冻结末项的渲染正文分支；与output_binding、answer_sdk_tool_call_id互斥。
     */
    rendered_answer_binding?: RenderedAnswerBindingClass;
    scope_fingerprint?:       string;
    /**
     * 定稿答案成功回执实际核验的query_id集合；只标识实际来源，不证明符合通知原scope，通知覆盖由宿主另行核验。
     */
    source_query_ids?: string[];
    task_ref:          EvidenceTaskRefElement;
}

/**
 * 成功答案的原工具登记归属，来自宿主task_id/task_condition_version；与实际sources和通知交付目标分开，不改原回执存储字节。
 *
 * 原查询所属任务和条件版本，由宿主绑定；恢复已切任务时不依赖最近查询观察窗口。旧通知缺字段沿原兼容路径读取。
 */
export interface EvidenceTaskRefElement {
    condition_version: string;
    task_id:           string;
}

export interface DataToolOutcomeContextReset {
    condition_version: string;
    task_id:           string;
}

/**
 *
 * 宿主按持久任务/查询事实生成的短控制交付；只覆盖已保存、已提交、等待结果和已持久澄清，不代表分析完成。text_authority只记录实际展示文字的来源；旧回执缺省时沿原任务字段来源核验，不能当作空来源。
 */
export interface ControlDeliveryClass {
    facts:           FactElement[];
    fingerprint:     string;
    task_refs:       [EvidenceTaskRefElement, ...EvidenceTaskRefElement[]];
    text:            string;
    text_authority?: { [key: string]: unknown };
}

export interface FactElement {
    clarification_id?:   string;
    condition_version:   string;
    confirmation_state?: null | string;
    execution_state?:    FactExecutionState;
    has_more?:           boolean;
    kind:                FactKind;
    query_id?:           string;
    question?:           string;
    task_id:             string;
}

export type FactExecutionState = "not_submitted" | "queued" | "submitting" | "running" | "submission_unknown" | "succeeded" | "failed" | "cancelled";

export type FactKind = "query" | "clarification";

/**
 * 未就绪原因，由原判定同次产出；就绪时省略。旧回执可缺省，不据缺省推断已就绪，恢复时采用当前宿主事实。
 *
 * 既有来源准入判定的阻断原因：本条输入未归属、有效来源声明未定、或等待原上下文刷新。仅用于恢复指导，不授予权限或改变来源范围。
 *
 * 与本快照source_context_ready同次计算的未就绪原因；仅控制信息，不含来源正文。就绪时省略，旧快照缺省仍沿原准入行为。
 */
export type SourceContextBlocker = "input_not_routed" | "source_scope_unknown" | "context_refresh_pending";

export interface DeliveredSupportElement {
    content: null | string;
    /**
     * 支持正文自己的Unicode字符页；游标仍沿supports_next_cursor继续。同一支持的尾页不代表本回执已包含整条支持。
     */
    content_page?: ContentPageClass;
    delivered_in?: DeliveredSupportDeliveredIn;
    embedded_in:   EmbeddedSupportLocationClass | null;
    reference:     SemanticReferenceClass;
    role:          PreparedSupportRole;
    support_id:    string;
}

export interface DeliveredSupportDeliveredIn {
    locator: SourceLocatorClass;
    path:    string;
}

export interface EmbeddingProfileClass {
    /**
     * 可选：显式维护试用的累计调用帽；普通维护配置省略，无累计上限与期限。
     */
    call_limit?: number;
    /**
     * 可选：显式维护试用的累计费用帽；普通维护配置省略。
     */
    cost_limit_micros?: string;
    trial_id:           string;
}

export interface EventElement {
    conversation_id: string;
    event_id:        string;
    event_seq:       string;
    payload:         { [key: string]: unknown };
    schema_version:  number;
    type:            EventType;
}

export type EventType = "message" | "assistant_delta" | "assistant_committed" | "assistant_replaced" | "tool_result" | "run_failed" | "run_cancelled" | "query_changed" | "query_result" | "memory_saved" | "task_changed" | "conversation_deleted" | "message_withdrawn" | "task_cancelled" | "memory_disabled" | "analysis_evidence_saved" | "analysis_report_saved" | "skill_draft_prepared";

export interface EvidenceContinuationClass {
    content_next_offset:  number | null;
    supports_next_cursor: null | string;
}

export interface EvidenceReadResultElement {
    citations?:           SourceCitationElement[];
    content?:             string;
    content_page?:        ContentPageClass;
    content_state?:       ContentState;
    continuation?:        EvidenceContinuationClass;
    effective_structure?: KnowledgeEntryQueryExampleStructure | null;
    kind:                 EvidenceReadResultKind;
    ref?:                 EvidenceRefElement;
    state:                EvidenceReadResultState;
    statement_id?:        string;
    structure_coverage?:  PurpleStructureCoverage;
    /**
     * 本次实际核定的当前结构表与显式语义依赖；原结构说明及原登记版本保持原值。
     */
    structure_dependencies?: EvidenceRefElement[];
    structure_page?:         ContentPageClass;
    structure_text?:         string;
    support_state?:          SupportState;
    supports?:               DeliveredSupportElement[];
    supports_complete?:      boolean | null;
    supports_total?:         number;
    asset?:                  MemoryElement;
    asset_ref?:              AssetReadRefClass;
    part?:                   PartEnum;
}

export interface MemoryElement {
    body:          string;
    content_page?: ContentPageClass;
    dependencies:  EvidenceRefElement[];
    id:            string;
    kind:          AssetKind;
    name:          string;
    native_path?:  string;
    owner_id?:     string;
    scope:         string;
    scope_page?:   ContentPageClass;
    selected:      boolean;
    /**
     * 来源原话的独立字符分页。缺省source_text为空但保留总长和补读位置；以entry_id=source_text和同一资产版本读取。
     */
    source_page?: ContentPageClass;
    source_text:  string;
    state:        MemoryState;
    verified:     boolean;
    version:      string;
    visibility?:  Visibility;
}

export type MemoryState = "enabled" | "disabled" | "deleted";

export type ContentState = "complete" | "partial";

export type KnowledgeEntryQueryExampleStructure = SemanticStructure;

export type EvidenceReadResultKind = "knowledge" | "memory" | "skill";

export type PartEnum = "body" | "scope" | "source_text";

export type EvidenceReadResultState = "ok" | "stale" | "not_available";

export interface PurpleStructureCoverage {
    notes: string[];
    state: StructureCoverageState;
}

export type StructureCoverageState = "complete" | "missing_semantics";

export type SupportState = "delivered" | "partial" | "unknown";

export interface ExecuteQueryInputClass {
    condition_version?: string;
    draft_version?:     string;
    instruction_quote:  string;
    /**
     * 同一用户消息明确授权的完整查询集合，一次确认；不能与单条query_id/draft_version/condition_version同时传。
     */
    queries?:  [PurpleQuery, ...PurpleQuery[]];
    query_id?: string;
}

export interface PurpleQuery {
    condition_version: string;
    draft_version:     string;
    query_id:          string;
}

export interface FinalizeModelCallClass {
    call_attempt_id: string;
    lease_epoch:     string;
    /**
     * 受控provider给出的调用结果；与是否取得可靠用量分开。连续临时失败在原请求范围持久计数。
     */
    outcome?:               Outcome;
    parameters_fingerprint: string;
    run_id:                 string;
    usage:                  ModelUsageClass | null;
}

/**
 * 受控provider给出的调用结果；与是否取得可靠用量分开。连续临时失败在原请求范围持久计数。
 */
export type Outcome = "success" | "transient_error" | "permanent_error";

export interface ModelUsageClass {
    elapsed_ms:    number;
    input_tokens:  number;
    output_tokens: number;
}

export interface FinishReceiptClass {
    output_id: string;
    state:     FinishReceiptState;
}

export type FinishReceiptState = "finished";

export interface FinishRunClass {
    /**
     *
     * 完整有序引用。存在新末项时final_text核对其原文；原消息其余任务均已取消或由可见任务卡/宿主控制交付解释且有效任务已冻结时，可只发冻结引用并省略final_text。单份正文仍限8000字符；多份组合由实际项数、标题和分隔格式推导，上限384281字符。Rust核当前任务集合与来源后取原内容组合。
     */
    answer_parts?: [AnswerPartReferenceElement, ...AnswerPartReferenceElement[]];
    /**
     * 使用present_analysis_answer成功回执交付时绑定该SDK调用，正文须与宿主生成值一致。
     */
    answer_sdk_tool_call_id?: string;
    checkpoint:               CheckpointClass;
    commit_id:                string;
    control_delivery_ref?:    ControlDeliveryRefClass;
    /**
     * Pi最后助手消息的首个已保存片段序号；省略时沿用从1起的完整文本校验。
     */
    final_start_chunk_seq?: string;
    final_text?:            string;
    lease_epoch:            string;
    /**
     *
     * 宿主确认的正常完整自然final原输出绑定；恢复时保原attempt/entry/片段。须有final_text，与answer_parts、answer_sdk_tool_call_id、control_delivery_ref及final_start_chunk_seq互斥。
     */
    output_binding?: OutputBindingClass;
    /**
     *
     * 单份渲染正文分支：final_text为该份display（非模板、非整轮组合全文），与answer_parts、answer_sdk_tool_call_id、control_delivery_ref、output_binding及final_start_chunk_seq互斥。组合时改用answer_parts末项的rendered分支，不传顶层rendered。
     */
    rendered_answer_binding?: RenderedAnswerBindingClass;
    run_id:                   string;
}

export interface ControlDeliveryRefClass {
    fingerprint: string;
}

export interface HistoryClass {
    conversations:  HistoryItemElement[];
    next_before_id: null | string;
}

export interface HistoryItemElement {
    /**
     * 会话创建时间（UTC）；用于区分同名会话，不改变分页顺序。
     */
    created_at?: string;
    id:          string;
    title:       string;
}

export interface HistoryQueryClass {
    before_id?: string;
    q?:         string;
}

export interface HostCheckpointReferenceClass {
    fingerprint: string;
    kind:        HostCheckpointReferenceKind;
}

export type HostCheckpointReferenceKind = "host_checkpoint";

export interface HumanStatementInputElement {
    citations:          SourceCitationElement[];
    key:                string;
    scope_text:         string;
    supports:           PreparedSupportElement[];
    supports_complete?: boolean | null;
    target:             EvidenceRefElement;
    text:               string;
}

export interface IdentityClass {
    model_label: ModelLabel;
    space_id:    string;
    /**
     * 空间显示名，由部署配置下发；与space_id分开，不参与授权判断。
     */
    space_name: string;
    user_id:    string;
}

export type ModelLabel = "本地模拟模型" | "DeepSeek Flash" | "DeepSeek V4 Pro";

export interface KnowledgeBatchEditClass {
    objects:      [KnowledgeEditGroupElement, ...KnowledgeEditGroupElement[]];
    operation_id: string;
}

export interface KnowledgeEditGroupElement {
    /**
     * 同一对象内按序应用的条目修改；任一条目校验失败则整批回滚。
     */
    edits: [EditElement, ...EditElement[]];
    /**
     * 暂存这些条目时读到的对象版本。
     */
    expected_version: string;
    object_id:        string;
}

export interface EditElement {
    clear_override?: boolean;
    entry_id:        string;
    related_ids?:    string[];
    source_url?:     null | string;
    /**
     * 本条目明确保存的人工陈述及支持提取声明；身份和origin由服务端生成。
     */
    statements?:       HumanStatementInputElement[];
    structured_value?: KnowledgeEntryQueryExampleStructure | null;
    value:             string;
}

export interface KnowledgeBatchReceiptClass {
    objects: KnowledgeObjectElement[];
}

export interface KnowledgeObjectElement {
    analysis_preference?: TableAnalysisPreferenceClass;
    created_by?:          string;
    /**
     * 整篇编辑后后台片段的拼接顺序；与正文同版本保存，不作为页面字段。
     */
    document_order?: number;
    entries:         KnowledgeEntryElement[];
    id:              string;
    kind:            KindElement;
    maintenance?:    SemanticMaintenanceClass;
    name:            string;
    prefill_status?: KnowledgeObjectPrefillStatus | null;
    /**
     * 当前来源的语义整理状态；与对象级预填分开表达，两作业互不冒充。
     */
    preparation_status?: KnowledgeObjectPreparationStatus | null;
    related_ids:         string[];
    retrieval?:          KnowledgeRetrievalClass;
    semantic_relations?: SemanticRelationElement[];
    source_id:           null | string;
    source_version:      string;
    state:               MemoryState;
    /**
     * 平台移除与人工停用分开；重新出现只能恢复平台导致的停用。
     */
    state_origin?: StateOrigin;
    updated_by:    string;
    version:       string;
}

export interface KnowledgeEntryElement {
    effective_structure?: KnowledgeEntryQueryExampleStructure | null;
    effective_value:      string;
    entry_id:             string;
    human_override:       null | KnowledgeEntryHumanOverride;
    label:                string;
    path:                 string;
    review_state:         ReviewState;
    source_facts:         KnowledgeEntrySourceFacts;
    statements?:          SemanticStatementElement[];
    suggestion:           KnowledgeEntrySuggestion;
}

export interface KnowledgeEntryHumanOverride {
    structured_value?: KnowledgeEntryQueryExampleStructure | null;
    [property: string]: unknown;
}

export type ReviewState = "unverified" | "confirmed" | "needs_review";

export interface KnowledgeEntrySourceFacts {
    structured_value?: KnowledgeEntryQueryExampleStructure | null;
    [property: string]: unknown;
}

export interface KnowledgeEntrySuggestion {
    structured_value?: KnowledgeEntryQueryExampleStructure | null;
    [property: string]: unknown;
}

export type KindElement = "table" | "field" | "metric" | "document" | "relationship" | "term" | "query_example";

export interface KnowledgeObjectPrefillStatus {
    attempt_id: string;
    error_code: null | string;
    state:      string;
}

export interface KnowledgeObjectPreparationStatus {
    error_code: null | string;
    revision:   string;
    source_id:  string;
    state:      string;
}

/**
 * 平台移除与人工停用分开；重新出现只能恢复平台导致的停用。
 */
export type StateOrigin = "platform" | "human";

/**
 * 独立对象首次创建时自动归属可信登录者；请求不接受负责人字段，后续调整使用独立管理接口。
 */
export interface KnowledgeCreateClass {
    body: string;
    /**
     * 对象自身的显式业务域；省略或空值表示未分类，不从关联对象继承。
     */
    business_domain?:  string;
    kind:              KindElement;
    name:              string;
    operation_id:      string;
    related_ids:       string[];
    source_url?:       null | string;
    structured_value?: KnowledgeEntryQueryExampleStructure | null;
}

/**
 * 将同一来源的业务文档按自然章节组合阅读；parts保留原引用身份，编辑时一次提交全部章节。
 */
export interface KnowledgeDocumentClass {
    body:     string;
    can_edit: boolean;
    parts:    [KnowledgeObjectElement, ...KnowledgeObjectElement[]];
    title:    string;
}

/**
 * 完整Markdown与完整片段版本集合；服务端逐一授权，正文与后台顺序同事务保存，重复操作返回原回执。
 */
export interface KnowledgeDocumentEditClass {
    body:         string;
    operation_id: string;
    parts:        [KnowledgeDocumentEditPart, ...KnowledgeDocumentEditPart[]];
    related_ids?: string[];
    source_url?:  null | string;
}

export interface KnowledgeDocumentEditPart {
    expected_version: string;
    id:               string;
}

export interface KnowledgeEditClass {
    clear_override?:  boolean;
    entry_id:         string;
    expected_version: string;
    operation_id:     string;
    related_ids?:     string[];
    source_url?:      null | string;
    /**
     * 本次明确保存的人工陈述及支持提取声明；身份和origin由服务端生成，未提供时不编造完整性。
     */
    statements?:       HumanStatementInputElement[];
    structured_value?: KnowledgeEntryQueryExampleStructure | null;
    value:             string;
}

export interface KnowledgeLineageClass {
    downstream:      DownstreamElement[];
    more_downstream: boolean;
    upstream:        DownstreamElement[];
}

export interface DownstreamElement {
    key_summary:  null | string;
    kind:         DownstreamKind;
    name:         string;
    object_id:    string;
    relationship: Relationship;
}

export type DownstreamKind = "table" | "metric" | "field" | "skill";

export type Relationship = "table_relation" | "metric_query" | "field_reference" | "skill_dependency";

export interface KnowledgeListClass {
    next_after_id:    null | string;
    objects:          KnowledgeObjectElement[];
    retrieval_mode:   string;
    search_coverage?: SearchCoverageClass | null;
}

export interface SearchCoverageClass {
    /**
     * 本次实际接收的唯一候选记录身份数（有效性筛除与合并前，跨通道跨轮去重累计）；达到candidate_limit即如实报覆盖不足。
     */
    candidate_count?: number;
    candidate_limit:  number;
    /**
     * 逐通道有界进度；足够本页结果不表示穷举了该通道。
     */
    channels?: PurpleChannels;
    /**
     * 覆盖检查因期限耗尽或读取超时未完成；此时没有已证滞后，不能报index_lag，未覆盖原因以deadline/通道事实表达。
     */
    index_check_incomplete?: boolean;
    /**
     * 是否实际查到旧投影或漏索引（覆盖检查已完成并确认滞后）。incomplete还可能是检查未完成，见index_check_incomplete；两者不能互相反推。
     */
    index_lag?:   boolean;
    index_state?: IndexState;
    /**
     * 候选谓词是否覆盖全部去重检索词项；false时应改写或拆分查询，不能据空结果断言没有资料。
     */
    query_terms_complete?: boolean;
    scope_applied?:        boolean;
    state:                 SearchCoverageState;
    vector_state?:         VectorState;
}

/**
 * 逐通道有界进度；足够本页结果不表示穷举了该通道。
 */
export interface PurpleChannels {
    dense:   DenseClass;
    lexical: DenseClass;
    raw?:    DenseClass;
}

export interface DenseClass {
    completed: number;
    exhausted: boolean;
    rounds:    number;
    shards:    number;
    /**
     * 未覆盖原因：停在候选额度、共享期限，或dense因查询嵌入不可用停轮；null且exhausted=true表示该通道已穷举。
     */
    uncovered?: Uncovered | null;
}

export type Uncovered = "candidate_limit" | "deadline" | "embedding_unavailable";

export type IndexState = "current" | "incomplete" | "unconfigured";

export type SearchCoverageState = "complete" | "candidate_limit" | "bounded";

export type VectorState = "available" | "unconfigured" | "unavailable";

export interface KnowledgeListQueryClass {
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

export interface KnowledgeReadInputClass {
    items:     [KnowledgeReadItemElement, ...KnowledgeReadItemElement[]];
    task_ref?: EvidenceTaskRefElement;
}

export interface KnowledgeReadItemElement {
    kind:            EvidenceReadResultKind;
    limit?:          number;
    offset?:         number;
    ref?:            EvidenceRefElement;
    statement_id?:   string;
    structure_only?: boolean;
    /**
     * 独立续读所选条目或陈述的必要支持；limit=0不重传正文，保持原ref、statement_id及structure_only。
     */
    supports_cursor?: string;
    asset_ref?:       AssetReadRefClass;
    part?:            PartEnum;
}

export interface KnowledgeReadReplyClass {
    items: [EvidenceReadResultElement, ...EvidenceReadResultElement[]];
}

export interface KnowledgeReadResultClass {
    citations?:           SourceCitationElement[];
    content?:             string;
    content_page?:        ContentPageClass;
    content_state?:       ContentState;
    continuation?:        EvidenceContinuationClass;
    effective_structure?: KnowledgeEntryQueryExampleStructure | null;
    kind:                 KnowledgeReadResultKind;
    ref:                  EvidenceRefElement;
    state:                EvidenceReadResultState;
    statement_id?:        string;
    structure_coverage?:  PurpleStructureCoverage;
    /**
     * 本次实际核定的当前结构表与显式语义依赖；原结构说明及原登记版本保持原值。
     */
    structure_dependencies?: EvidenceRefElement[];
    structure_page?:         ContentPageClass;
    structure_text?:         string;
    support_state?:          SupportState;
    supports?:               DeliveredSupportElement[];
    supports_complete?:      boolean | null;
    supports_total?:         number;
}

export type KnowledgeReadResultKind = "knowledge";

export interface KnowledgeSearchCoverageClass {
    channels: [KnowledgeSearchCoverageChannel, ...KnowledgeSearchCoverageChannel[]];
    /**
     * evidence视图有后页时为宿主生成的短不透明回执引用rc1:<operation_id>，长度不超过96
     * ASCII字节；宿主只在原成功工具回执持久化完整候选窗口后发布，同操作重放返回同一引用。无后页为null。source_identity视图沿用独立cursor。
     */
    next:    null | string;
    reasons: Reason[];
    state:   KnowledgeSearchCoverageState;
}

export interface KnowledgeSearchCoverageChannel {
    channel: ChannelChannel;
    state:   ChannelState;
}

export type ChannelChannel = "exact" | "bm25" | "dense";

export type ChannelState = "available" | "unavailable" | "not_configured";

export type Reason = "index_lag" | "candidate_limit" | "deadline" | "channel_unavailable";

export type KnowledgeSearchCoverageState = "searched" | "bounded";

export interface KnowledgeSearchHitElement {
    kind?:      KindElement;
    name:       string;
    object_id?: string;
    /**
     * 若有知识对象，这是当前对象版本，不是已读正文引用。
     */
    object_version?: string;
    record_kind:     RecordKind;
    /**
     * 列出的直属对象、表和来源身份是否完整；完整不代表整源符合用户指定范围或已读正文。
     */
    roots_complete?:    boolean;
    source_keys?:       SourceKeyElement[];
    citations?:         SourceCitationElement[];
    content_state?:     ContentState;
    continuation?:      EvidenceContinuationClass;
    definition?:        string;
    example_refs?:      EvidenceRefElement[];
    ref?:               EvidenceRefElement;
    scope_text?:        string;
    statement_id?:      string;
    support_state?:     SupportState;
    supports?:          DeliveredSupportElement[];
    supports_complete?: boolean | null;
    citation?:          SourceCitationElement;
    semantic_status?:   KnowledgeSearchHitSemanticStatus;
    source_length?:     number;
    text?:              string;
}

export type RecordKind = "source_identity" | "knowledge_entry" | "source_excerpt";

export type KnowledgeSearchHitSemanticStatus = "pending" | "partial" | "ready" | "failed";

export interface KnowledgeSearchInputClass {
    asset_after?: string;
    /**
     *
     * 由evidence视图search_coverage.next返回的短不透明回执引用rc1:<operation_id>，或旧JSON/gzip续读状态；宿主按当前用户/空间/会话从原成功工具回执恢复完整候选窗口，短引用不是读取凭据。保持原查询、kinds、hints、source_selection和任务绑定，asset_after独立推进。source_identity视图沿用独立cursor。
     */
    cursor?: string;
    /**
     * 仅用于相关性排序，不扩大或收窄当前权限、kinds及任务来源范围。
     */
    hints?: HintsClass;
    kinds?: [KindElement, ...KindElement[]];
    limit?: number;
    query:  string;
    /**
     *
     * 仅evidence视图使用的精确原文选择。object_id取source_identity.object_id，version取其object_version；只定位这些当前对象的正式source_facts，不授予知识或结构采用权，也不将对象版本当作来源revision。原文仍核实际SourceKey、来源许可、当前修订、完整性与唯一定位；失败项不妨碍其他合法项。kinds仍筛选所选对象类型，hints仍只排序；不接受客户端quote/path/offset，不退到全文。省略时保持原搜索。
     */
    source_selection?: [SourceSelectionElement, ...SourceSelectionElement[]];
    task_ref?:         EvidenceTaskRefElement;
    /**
     *
     * 省略为evidence取证。source_identity的query按空白分隔名称/ID词，任一词在可读名称或标识中匹配即可返回；单独的*保留目录浏览。只匹配元信息，不解析自然语言、同义词或用户许可，不提供正文/定义/摘录/建议或个人资产，不调用付费语义检索，也不算已读证据或授予正文权限。两种视图的cursor不可互换，身份匹配语义更新后的旧绑定cursor无效。
     */
    view?: KnowledgeSearchInputView;
}

/**
 * 仅用于相关性排序，不扩大或收窄当前权限、kinds及任务来源范围。
 */
export interface HintsClass {
    business_domain?:    string;
    related_object_ids?: string[];
}

export interface SourceSelectionElement {
    object_id: string;
    version:   string;
}

/**
 *
 * 省略为evidence取证。source_identity的query按空白分隔名称/ID词，任一词在可读名称或标识中匹配即可返回；单独的*保留目录浏览。只匹配元信息，不解析自然语言、同义词或用户许可，不提供正文/定义/摘录/建议或个人资产，不调用付费语义检索，也不算已读证据或授予正文权限。两种视图的cursor不可互换，身份匹配语义更新后的旧绑定cursor无效。
 */
export type KnowledgeSearchInputView = "evidence" | "source_identity";

export interface KnowledgeSearchReplyClass {
    asset_cursor_invalid: boolean;
    asset_total:          number;
    hits:                 KnowledgeSearchHitElement[];
    /**
     * 多指标检索中已核验命中的表唯一键和关系关联键摘要。缺项应读取对应表和关系的完整结构。
     */
    key_hints?: string[];
    /**
     *
     * 个人记忆检索通道：受限任务来源门生效时按资产真实来源过滤，仅无可证明同源记忆时标记excluded_by_source_limits；命中侧过滤事实见回执source_limits块。
     */
    memory_retrieval:  string;
    next_asset_after:  null | string;
    personal_memories: { [key: string]: unknown }[];
    search_coverage:   KnowledgeSearchCoverageClass;
    selected_skills:   { [key: string]: unknown }[];
}

/**
 * 客户端已读连续事件区间内的输出片段；指纹只标识缓存内容，不授读取权。
 */
export interface LoadedOutputRangeElement {
    attempt_id:              string;
    first_event_seq:         string;
    last_event_seq:          string;
    projection_fingerprint?: string;
}

export interface LogoutReceiptClass {
    state: LogoutReceiptState;
}

export type LogoutReceiptState = "logged_out";

export interface MemoryBudgetBindingClass {
    epoch:        string;
    id:           string;
    kind:         MemoryBudgetBindingKind;
    operation_id: string;
    /**
     * run工具绑定真实SDK调用ID；run启动检索与index作业为null，其operation/租约/用途由宿主核对。
     */
    sdk_tool_call_id: null | string;
}

export type MemoryBudgetBindingKind = "run" | "index";

export interface MemoryCandidateElement {
    asset_id: string;
    version:  string;
}

export interface MemoryExtractionReceiptClass {
    body:         string;
    operation_id: string;
    replayed:     boolean;
}

export interface MemoryExtractionRequestClass {
    budget:       MemoryBudgetBindingClass;
    message:      string;
    operation_id: string;
    owner_id:     string;
    /**
     * 修订时由宿主从本人可用的expected_version绑定的旧记忆；只作解析指代和保留未改限定的资料，当前真实指令优先。新建时省略或为null。
     */
    previous_memory?: MemoryExtractionRequestPreviousMemory | null;
    quote:            string;
    space_id:         string;
}

export interface MemoryExtractionRequestPreviousMemory {
    body:    string;
    id:      string;
    scope:   string;
    version: string;
}

export interface MemoryIndexReceiptClass {
    operation_id: string;
    state:        MemoryIndexReceiptState;
}

export type MemoryIndexReceiptState = "ready" | "removed" | "superseded";

export interface MemoryIndexRequestClass {
    asset:                   AssetElement;
    budget:                  MemoryBudgetBindingClass;
    extraction_operation_id: null | string;
    operation_id:            string;
    owner_id:                string;
    space_id:                string;
}

export interface MemoryModelCallClass {
    action:                 MemoryModelCallAction;
    budget:                 MemoryBudgetBindingClass;
    call_attempt_id:        string;
    input_tokens_upper:     number;
    output_tokens_max:      number;
    parameters_fingerprint: string;
    purpose:                MemoryModelCallPurpose;
    usage:                  ModelUsageClass | null;
}

export type MemoryModelCallAction = "issue" | "finalize";

export type MemoryModelCallPurpose = "memory_extraction" | "memory_embedding";

export interface MemoryReadResultClass {
    asset?:    MemoryElement;
    asset_ref: AssetReadRefClass;
    kind:      MemoryReadResultKind;
    part:      PartEnum;
    state:     EvidenceReadResultState;
}

export type MemoryReadResultKind = "memory";

export interface MemorySearchReceiptClass {
    bounded:    boolean;
    candidates: MemoryCandidateElement[];
}

export interface MemorySearchRequestClass {
    budget:       MemoryBudgetBindingClass;
    operation_id: string;
    owner_id:     string;
    query:        string;
    space_id:     string;
}

export interface MessageInputClass {
    client_message_id: string;
    model_selection?:  ModelSelectionClass;
    text:              string;
}

export interface MessageReceiptClass {
    message_id: string;
    request_id: string;
}

export interface ModelAttemptClass {
    call_attempt_id: string;
    lease_epoch:     string;
    run_id:          string;
}

export interface ModelCallReceiptClass {
    send_allowed: boolean;
    state:        ModelCallReceiptState;
}

export type ModelCallReceiptState = "reserved" | "issued" | "settled" | "unknown";

export interface ModelCatalogClass {
    default_selection: ModelSelectionClass | null;
    models:            ModelOptionElement[];
    requires_model?:   boolean;
}

export interface ModelOptionElement {
    id:               string;
    label:            string;
    thinking_options: ThinkingOptionElement[];
}

export interface ThinkingOptionElement {
    label: string;
    value: ThinkingLevel;
}

export interface ModelConfigurationClass {
    default_model_id: null | string;
    models:           ModelDefinitionElement[];
    services:         ModelServiceElement[];
    version:          string;
}

export interface ModelDefinitionElement {
    anthropic_thinking_mode?: AnthropicThinkingMode;
    /**
     * 窗口能力来源：SDK目录或管理员声明；目录外型号不猜窗口。
     */
    capability_source?: CapabilitySource;
    /**
     * 总上下文tokens；与输入/输出策略分开表达。
     */
    context_window?:     number;
    default_thinking:    ThinkingLevel;
    enabled:             boolean;
    id:                  string;
    input_limit:         number;
    input_rate:          string;
    label:               string;
    model_id:            string;
    output_limit:        number;
    output_rate:         string;
    payload_bytes_limit: number;
    reasoning_supported: boolean;
    /**
     * 单次provider请求超时毫秒，随模型修订冻结；历史缺字段按90000处理。
     */
    request_timeout_ms?: number;
    service_id:          string;
    thinking_levels:     [ThinkingLevel, ...ThinkingLevel[]];
    version:             string;
}

/**
 * 窗口能力来源：SDK目录或管理员声明；目录外型号不猜窗口。
 */
export type CapabilitySource = "sdk_catalog" | "admin_declared";

export interface ModelServiceElement {
    api:                   API;
    base_url:              string;
    credential_configured: boolean;
    enabled:               boolean;
    id:                    string;
    name:                  string;
    provider_id:           ProviderID;
    version:               string;
}

export type ProviderID = "deepseek" | "openai" | "anthropic" | "compatible";

export interface ModelConfigurationAccessClass {
    can_manage_models: boolean;
}

export interface ModelConnectionClass {
    api:              API;
    api_key:          string;
    base_url:         string;
    provider_id:      string;
    runtime_provider: string;
}

export interface ModelProfileClass {
    /**
     * 省略沿用有限trial；request为正常持续使用，无每消息累计调用上限，累计费用/试用期限不默认拦截。
     */
    budget_mode?: BudgetMode;
    /**
     * 窗口能力来源：SDK目录或管理员声明；目录外型号不猜窗口。
     */
    capability_source?: CapabilitySource;
    configured_model?:  ConfiguredModelClass;
    /**
     * 总上下文tokens；与输入/输出策略分开表达。
     */
    context_window?:      number;
    input_limit:          number;
    model_id:             string;
    output_limit:         number;
    payload_bytes_limit?: number;
    price_version:        string;
    provider_id:          string;
    /**
     * 历史兼容字段：旧request scope按每消息24次封顶；正常配置省略，残留值仅保旧解码，不作运行上限。
     */
    request_call_limit?: number;
    /**
     * 单次provider请求超时毫秒，随模型修订冻结；历史缺字段按90000处理。
     */
    request_timeout_ms?: number;
    thinking_level?:     ThinkingLevel;
    toolset?:            Toolset;
    trial_call_limit?:   number;
    trial_cost_micros?:  string;
    trial_id:            string;
}

/**
 * 省略沿用有限trial；request为正常持续使用，无每消息累计调用上限，累计费用/试用期限不默认拦截。
 */
export type BudgetMode = "trial" | "request";

export type Toolset = "task" | "data";

export interface ModelReceiptClass {
    state: ModelReceiptState;
}

export type ModelReceiptState = "issued" | "settled";

export interface MutationReceiptClass {
    operation_id: string;
    resource_id:  string;
    state:        string;
    version:      string;
}

export interface OperationReceiptClass {
    operation_id: string;
    /**
     * 原登记tool行冻结的合同版本，不随当前run变化；历史缺失按1。
     */
    tool_contract_version?: number;
}

/**
 * 每个请求范围恰有一个结果；replace完整替换该范围的assistant事件，空数组仍表示替换。not_available不区分缺失和其他会话。
 */
export interface OutputProjectionElement {
    attempt_id:             string;
    events?:                EventElement[];
    first_event_seq:        string;
    last_event_seq:         string;
    output_state:           OutputState | null;
    projection_fingerprint: string;
    projection_result:      ProjectionResult;
}

export type OutputState = "streaming" | "committed" | "cancelled" | "interrupted" | "superseded";

export type ProjectionResult = "unchanged" | "replace" | "not_available";

export interface OutputReceiptClass {
    chunk_seq: string;
}

export interface PiSessionReferenceClass {
    file:       string;
    kind:       PiSessionReferenceKind;
    session_id: string;
}

export type PiSessionReferenceKind = "pi_session";

export interface PrefillResultClass {
    entries: [PrefillResultEntry, ...PrefillResultEntry[]];
}

export interface PrefillResultEntry {
    entry_id:          string;
    evidence:          [PurpleEvidence, ...PurpleEvidence[]];
    gaps:              string[];
    structured_value?: KnowledgeEntryQueryExampleStructure | null;
    value:             string;
}

export interface PurpleEvidence {
    location:  string;
    quote:     string;
    source_id: string;
    version:   string;
}

export interface ProposalElement {
    base_version: string;
    entry_id:     string;
    evidence:     EvidenceRefElement[];
    id:           string;
    object_id:    string;
    reason:       string;
    state:        string;
    value:        string;
}

export interface ProposalInputClass {
    base_version: string;
    entry_id:     string;
    evidence:     [EvidenceRefElement, ...EvidenceRefElement[]];
    object_id:    string;
    reason:       string;
    value:        string;
}

export interface ProposalListClass {
    proposals: ProposalElement[];
}

export interface QueryCancellationClass {
    cancel_state:      string;
    condition_version: string;
    execution_state:   string;
    id:                string;
    task_id:           string;
}

export interface QueryListClass {
    confirmation_blocked: boolean;
    queries:              QueryViewElement[];
}

export interface QueryViewElement {
    cancel_state:       string;
    check_state:        string;
    condition_version:  string;
    confirmation_state: string;
    conversation_id:    string;
    draft_version:      string;
    error:              null | string;
    error_details?:     QueryViewErrorDetails | null;
    execution_state:    string;
    id:                 string;
    knowledge_refs?:    EvidenceRefElement[];
    parameters?:        { [key: string]: unknown };
    replaces_query_id?: null | string;
    result_ref:         null | string;
    /**
     * 草稿工具回执的非阻断诊断；查询读取接口不承诺重现此报告。
     */
    semantic_checks?: SemanticCheckReportClass;
    /**
     * 保存草稿时的口径决策及依据；旧记录返回null，不从自由文本或模型历史猜回填。
     */
    semantic_resolution?: QueryViewQuerySemanticResolution | null;
    sql?:                 string;
    summary?:             string;
    target_id:            string;
    task_id:              string;
    /**
     * 正文按历史记录展示：来源已改版或结果已漂移，但记录仍可核。SQL、参数与说明保留原样，不能作为当前口径或执行依据；需要当前数据须重新确认。
     */
    text_historical?: boolean;
    /**
     * 正文来源失效或无法核实时只返回查询身份和控制状态；SQL、参数、说明、依据及诊断正文均不可返回。
     */
    text_unavailable?: boolean;
    /**
     * 保存草稿时任务条件声明的时间基准；旧草稿返回null。观察截点与批次是用户声明，不得以request_clock或平台data_freshness冒充。
     */
    time_basis?: TimeBasisClass | null;
    /**
     * 原查询首次query_changed事件的持久序号，作为对话时间线中查询卡的稳定锚点；旧记录无对应事件时为null，旧Schema解码兼容可缺省，前端已有值不被后续有限事件页覆盖。
     */
    timeline_event_seq?: null | string;
}

export interface QueryViewErrorDetails {
    code:    string;
    message: string;
}

/**
 * 草稿保存时从任务当前条件投影的时间基准；统计起止沿time_start/time_end，观察截点/批次只在time_roles中声明。
 */
export interface TimeBasisClass {
    time_end:   null | string;
    time_roles: TimeRoleElement[];
    time_start: null | string;
    timezone:   null | string;
}

export interface ReadKnowledgeInputClass {
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

export interface ReadModelConnectionClass {
    lease_epoch: string;
    run_id:      string;
}

export interface ReadQueryInputClass {
    cursor?:  null | string;
    query_id: string;
}

export interface ReadSourceInputClass {
    limit?:  number;
    offset?: number;
    /**
     * 原始来源ID或document-加知识文档ID的保留别名；文档仍按当前空间、状态和版本校验。
     */
    source_id: string;
    version:   string;
}

export interface ReadTaskInputClass {
    /**
     * 按回执next_clarification_after继续读取未决问题；省略从第一页开始。
     */
    clarification_after?: string;
    /**
     * 省略读取当前条件；指定时读取该任务真实历史快照及其依据，不授予执行权。
     */
    condition_version?: string;
    task_id:            string;
}

export interface ReadCheckpointClass {
    lease_epoch: string;
    run_id:      string;
}

export interface RefreshRunContextClass {
    checkpoint:       CheckpointClass;
    lease_epoch:      string;
    run_id:           string;
    sdk_tool_call_id: string;
}

export interface RequestQueryInputClass {
    condition_version:  string;
    knowledge_refs:     EvidenceRefElement[];
    parameters:         { [key: string]: unknown };
    replaces_query_id?: null | string;
    /**
     * 省略继承目标条件版本已有采纳说明；兼容携带只核同义声明，不能独立另作决定。新任务未决定时登记clarifications，改变解释先同次修订条件。旧形状仅沿旧格式兼容。
     */
    semantic_resolution?: SemanticResolutionClass;
    sql:                  string;
    summary:              string;
    target_id:            TargetID;
    task_id:              string;
}

/**
 * 旧未决形状与新采纳说明仅在兼容边界解码；实际条件格式由宿主decision_state_version决定。
 *
 * 省略继承目标条件版本已有采纳说明；兼容携带只核同义声明，不能独立另作决定。新任务未决定时登记clarifications，改变解释先同次修订条件。旧形状仅沿旧格式兼容。
 *
 *
 * 新格式仅记录已经采用的解释。explicit_user引用本轮完整原话，null/省略采纳身份由宿主绑定；原已核对象可同文继承。未决只登记clarifications，无问题且条件充分时不要求本对象。
 */
export interface SemanticResolutionClass {
    /**
     *
     * explicit_user：null=本轮新采纳，由宿主核对user_quote为本轮完整原话后绑定真实消息身份；非空=复制继承原已验证决策的消息身份，不接受模型自由填写。其余basis为null。
     */
    adoption_message_id?: null | string;
    /**
     * 真实用户明确选择、确无实质歧义、或仍需澄清；资料支持某公式不等于用户选择它。
     */
    basis: SemanticResolutionBasis;
    /**
     * 支撑该口径决策的依据引用；旧调用缺失按空数组解码。
     */
    evidence_refs?: EvidenceRefElement[];
    /**
     * 本稿采用的指标、分子/分母、时间等关键口径及选择依据；不能把自己刚写入任务的假设当作用户采用。
     */
    interpretation: string;
    /**
     * 仍会改变答案且未获选择的分子、分母、时间归属等差异；有差异必须先澄清，不能默认写稿。
     */
    unresolved_differences?: string[];
    /**
     * explicit_user逐字填写本条真实用户完整原话，保留否定、前提、例外和换行，不截取子串；其余为null。
     */
    user_quote: null | string;
}

export interface ReserveModelCallClass {
    call_attempt_id:        string;
    input_tokens_upper:     number;
    lease_epoch:            string;
    output_tokens_max:      number;
    parameters_fingerprint: string;
    run_id:                 string;
}

export interface RunEnvelopeClass {
    answer_parts?:      AnswerPartReferenceElement[];
    attempt_id:         string;
    budget_scope_id:    string;
    checkpoint:         CheckpointClass | null;
    conversation_id:    string;
    lease_epoch:        string;
    message_id:         string;
    model_profile:      ModelProfileClass | null;
    output_id:          string;
    recovery_chain_id:  string;
    request_clock?:     RequestClockClass;
    request_id:         string;
    resume_same_input?: boolean;
    run_id:             string;
    text:               string;
    /**
     * 宿主冻结的工具合同版本；历史缺失按1恢复。
     */
    tool_contract_version?: number;
    workspace_context?:     WorkspaceContextClass | null;
}

export interface WorkspaceContextClass {
    /**
     * 会话持久活动取证任务：一次派发只绑定一个活动任务，受限读取与轮内重投影由此继承；null表示尚无活动任务。
     */
    active_task_ref?:    PurpleActiveTaskRef | null;
    asset_counts?:       PurpleAssetCounts;
    authority_revision:  string;
    authority_snapshot?: { [key: string]: unknown };
    control_delivery?:   ControlDeliveryClass | null;
    /**
     * 启动/恢复/刷新时，宿主按原通知条件scope核验已冻结答案的覆盖事实。缺省不证明已覆盖，不能凭query_id命中扩大通知范围。
     */
    frozen_notification_covered?: boolean;
    /**
     * 当前输入的持久全部任务归属；恢复时按当前lifecycle继续剩余目标。
     */
    input_task_ids?: string[];
    memories:        MemoryElement[];
    /**
     *
     * 个人记忆注入通道：mem0_authoritative按Mem0召回注入，directory_fallback为Mem0不可用退回目录。受限任务来源门生效时按资产真实来源过滤后仍注入同源记忆，仅无可证明同源资产或来源范围未知时不注入并标记excluded_by_source_limits；与search_knowledge回执中的同值口径一致。
     */
    memory_retrieval?:  MemoryRetrieval;
    query_observations: { [key: string]: unknown }[];
    recent_messages:    ChatMessageElement[];
    request_clock?:     RequestClockClass;
    /**
     * 宿主查询终态通知身份；普通用户消息省略，不从文字前缀推断成功。
     */
    result_notification?: PurpleResultNotification;
    selected_skills:      MemoryElement[];
    /**
     * 与本快照source_context_ready同次计算的未就绪原因；仅控制信息，不含来源正文。就绪时省略，旧快照缺省仍沿原准入行为。
     */
    source_context_blocker?: SourceContextBlocker;
    /**
     *
     * 当前输入已归属且来源范围可确定，才可将证据正文交给模型。false时只提供用户原话及控制/来源身份元信息，保留同一Pi会话而暂不发送旧资料正文。v2派发和刷新由宿主计算；旧v1缺省不改变原行为。
     */
    source_context_ready?: boolean;
    tasks:                 WorkspaceTaskElement[];
}

export interface PurpleActiveTaskRef {
    condition_version: string;
    task_id:           string;
}

export interface PurpleAssetCounts {
    memories:        number;
    selected_skills: number;
}

/**
 *
 * 个人记忆注入通道：mem0_authoritative按Mem0召回注入，directory_fallback为Mem0不可用退回目录。受限任务来源门生效时按资产真实来源过滤后仍注入同源记忆，仅无可证明同源资产或来源范围未知时不注入并标记excluded_by_source_limits；与search_knowledge回执中的同值口径一致。
 */
export type MemoryRetrieval = "mem0_authoritative" | "directory_fallback" | "excluded_by_source_limits";

/**
 * 宿主查询终态通知身份；普通用户消息省略，不从文字前缀推断成功。
 */
export interface PurpleResultNotification {
    execution_state: ResultNotificationExecutionState;
    query_id:        string;
    /**
     * 原查询所属任务和条件版本，由宿主绑定；恢复已切任务时不依赖最近查询观察窗口。旧通知缺字段沿原兼容路径读取。
     */
    task_ref?: EvidenceTaskRefElement;
}

export type ResultNotificationExecutionState = "succeeded" | "failed" | "cancelled";

export interface RunSnapshotElement {
    /**
     * 运行中run最近一次已登记工具调用的中文动作提示，由服务端映射工具名生成；无工具调用的旧记录缺省。
     */
    activity_label?: string;
    /**
     * 本run当前生成尝试身份，用于识别正文增量归属；旧快照可缺省。
     */
    attempt_id?: string;
    /**
     * 已完成的工具动作、当前可读对象名称与真实耗时。仅作界面进度提示。
     */
    completed_step_summaries?: CompletedStepSummaryElement[];
    /**
     * 该run已成功回执的工具调用计数；旧记录缺省。仅作进度展示，不作为执行依据。
     */
    completed_steps?: number;
    lease_epoch:      string;
    /**
     * 来自已有持久记录的触发消息身份；旧快照可缺省。
     */
    message_id?: string;
    /**
     * user_request为用户消息触发；query_result为查询结果通知触发。旧快照可缺省，缺省时按中性处理提示展示。
     */
    purpose?: RunSnapshotPurpose;
    /**
     * 结果通知run关联的原查询ID，来自conversations可信server:query-result消息关联；仅purpose=query_result时非null。
     */
    result_query_id?: null | string;
    run_id:           string;
    state:            RunSnapshotState;
}

export interface CompletedStepSummaryElement {
    category:    string;
    duration_ms: number;
    target_name: null | string;
}

/**
 * user_request为用户消息触发；query_result为查询结果通知触发。旧快照可缺省，缺省时按中性处理提示展示。
 */
export type RunSnapshotPurpose = "user_request" | "query_result";

export type RunSnapshotState = "running" | "interrupted" | "finished" | "failed" | "cancelled";

export interface SaveDefaultModelClass {
    expected_version: string;
    model_id:         string;
}

export interface SaveModelDefinitionClass {
    anthropic_thinking_mode?: AnthropicThinkingMode;
    /**
     * 窗口能力来源：SDK目录或管理员声明；目录外型号不猜窗口。
     */
    capability_source: CapabilitySource;
    /**
     * 总上下文tokens；与输入/输出策略分开表达。
     */
    context_window:      number;
    default_thinking:    ThinkingLevel;
    enabled:             boolean;
    expected_version:    string;
    id:                  string;
    input_limit:         number;
    input_rate:          string;
    label:               string;
    model_id:            string;
    output_limit:        number;
    output_rate:         string;
    payload_bytes_limit: number;
    reasoning_supported: boolean;
    /**
     * 单次provider请求超时毫秒，随模型修订冻结；历史缺字段按90000处理。
     */
    request_timeout_ms: number;
    service_id:         string;
    thinking_levels:    [ThinkingLevel, ...ThinkingLevel[]];
}

export interface SaveModelSelectionClass {
    expected_version: string;
    selection:        ModelSelectionClass;
}

export interface SaveModelServiceClass {
    api:              API;
    api_key?:         string;
    base_url:         string;
    enabled:          boolean;
    expected_version: string;
    id:               string;
    name:             string;
    provider_id:      ProviderID;
}

export interface SearchInputClass {
    asset_after?:       string;
    business_domain?:   string;
    kinds?:             [KindElement, ...KindElement[]];
    limit?:             number;
    query:              string;
    related_object_id?: string;
}

export interface SendModelCallClass {
    call_attempt_id:        string;
    lease_epoch:            string;
    parameters_fingerprint: string;
    run_id:                 string;
}

export interface SessionReceiptClass {
    model_label: ModelLabel;
    space_id:    string;
    /**
     * 空间显示名，由部署配置下发；与space_id分开，不参与授权判断。
     */
    space_name: string;
    state:      SessionReceiptState;
    user_id:    string;
}

export type SessionReceiptState = "authenticated";

export interface SkillReadResultClass {
    asset?:    MemoryElement;
    asset_ref: AssetReadRefClass;
    kind:      SkillReadResultKind;
    state:     EvidenceReadResultState;
}

export type SkillReadResultKind = "skill";

export interface SkillSelectionClass {
    asset_id:     string;
    operation_id: string;
    version:      string;
}

export interface SnapshotClass {
    conversation_id:  string;
    events:           EventElement[];
    first_event_seq?: string;
    has_newer?:       boolean;
    has_older?:       boolean;
    last_event_seq?:  string;
    messages:         ChatMessageElement[];
    runs:             RunSnapshotElement[];
    tasks:            TaskSnapshotElement[];
}

export interface TaskSnapshotElement {
    condition_version:          string;
    evidence_refs?:             AnalysisEvidenceRefElement[];
    goal?:                      string;
    id:                         string;
    lifecycle?:                 string;
    note?:                      string;
    phase?:                     string;
    report_ref?:                AnalysisReportRefClass;
    report_timeline_event_seq?: string;
    text_unavailable?:          boolean;
}

/**
 * POST snapshot独立响应；普通分页游标与已加载输出的权限投影分开，旧GET Snapshot形状保持。
 */
export interface SnapshotRefreshClass {
    conversation_id:    string;
    events:             EventElement[];
    first_event_seq?:   string;
    has_newer?:         boolean;
    has_older?:         boolean;
    last_event_seq?:    string;
    messages:           ChatMessageElement[];
    output_projections: OutputProjectionElement[];
    runs:               RunSnapshotElement[];
    tasks:              TaskSnapshotElement[];
}

export interface SnapshotRequestClass {
    after_seq?:     string;
    before_seq?:    string;
    loaded_outputs: LoadedOutputRangeElement[];
}

export interface SourceDocumentClass {
    body:            string;
    complete:        boolean;
    current_version: string;
    source_id:       string;
    version:         string;
}

export interface SourceReadInputClass {
    citation:  SourceCitationElement;
    limit?:    number;
    task_ref?: EvidenceTaskRefElement;
}

export interface SourceReadReplyClass {
    content_state: ContentState;
    locator:       SourceLocatorClass;
    next_locator:  SourceLocatorClass | null;
    revision:      string;
    source:        SourceKeyElement;
    source_length: number;
    text:          string;
}

export interface SQLInputClass {
    knowledge_refs?: EvidenceRefElement[];
    parameters:      { [key: string]: unknown };
    sql:             string;
    target_id:       TargetID;
}

export interface TaskInputClass {
    action: TaskInputAction;
    goal:   string;
}

export type TaskInputAction = "create_task";

export interface ToolInvocationClass {
    arguments:        TaskInputClass;
    checkpoint:       CheckpointClass;
    lease_epoch:      string;
    run_id:           string;
    sdk_tool_call_id: string;
}

export interface ToolOutcomeClass {
    receipt?: ToolReceiptClass;
    type:     ToolOutcomeType;
    error?:   AppErrorClass;
}

export interface ToolReceiptClass {
    condition_version: string;
    operation_id:      string;
    state:             ToolReceiptState;
    task_id:           string;
}

export type ToolReceiptState = "active";

export type ToolOutcomeType = "succeeded" | "failed";

export interface VersionCommandClass {
    expected_version: string;
    operation_id:     string;
}

export interface WorkbenchUpdateClass {
    query_list?: QueryListClass;
    runs?:       RunSnapshotElement[];
    tasks?:      TaskSnapshotElement[];
}

export interface KnowledgeLineage {
    downstream:      KnowledgeLineageEdge[];
    more_downstream: boolean;
    upstream:        KnowledgeLineageEdge[];
}

export interface KnowledgeLineageEdge {
    key_summary:  null | string;
    kind:         DownstreamKind;
    name:         string;
    object_id:    string;
    relationship: Relationship;
}

export interface CreateConversation {
    operation_id: string;
}

export interface MessageInput {
    client_message_id: string;
    model_selection?:  ModelSelection;
    text:              string;
}

export interface ModelSelection {
    model_id:       string;
    thinking_level: ThinkingLevel;
}

export interface RunEnvelope {
    answer_parts?:      AnswerPartReference[];
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
    /**
     * 宿主冻结的工具合同版本；历史缺失按1恢复。
     */
    tool_contract_version?: number;
    workspace_context?:     WorkspaceContext | null;
}

/**
 *
 * 有序原内容引用。已定稿项只携宿主控制身份和实际source_query_ids，不凭ID命中判断通知scope覆盖；有新末项时引用原输出或成功答案回执。数量还须受实际消息任务集合约束，不增加模型额度。
 */
export interface AnswerPartReference {
    answer_sdk_tool_call_id?:       string;
    finalized_by_sdk_tool_call_id?: string;
    output_binding?:                AssistantOutputBinding;
    /**
     * 未冻结末项的渲染正文分支；与output_binding、answer_sdk_tool_call_id互斥。
     */
    rendered_answer_binding?: RenderedAnswerBinding;
    scope_fingerprint?:       string;
    /**
     * 定稿答案成功回执实际核验的query_id集合；只标识实际来源，不证明符合通知原scope，通知覆盖由宿主另行核验。
     */
    source_query_ids?: string[];
    task_ref:          EvidenceTaskRef;
}

/**
 * 宿主从Pi完整助手条目绑定，正文位置来自已确认输出队列；模型不能提供这些字段。
 *
 * 原Pi entry/attempt/stop/tool
 * IDs与source_text的SHA256；本分支禁止携带first/last_chunk_seq，展示范围由外层字段表达。
 *
 *
 * 宿主确认的正常完整自然final原输出绑定；恢复时保原attempt/entry/片段。须有final_text，与answer_parts、answer_sdk_tool_call_id、control_delivery_ref及final_start_chunk_seq互斥。
 */
export interface AssistantOutputBinding {
    attempt_id:       string;
    entry_id:         string;
    first_chunk_seq?: string;
    last_chunk_seq?:  string;
    stop_reason:      StopReason;
    text_sha256:      string;
    tool_call_ids:    string[];
}

/**
 * 宿主生成的一次渲染绑定：原文、原prepare回执与展示片段范围；模型不能提供这些字段。
 *
 * 渲染正文交接分支；与顶层assistant互斥。当前冻结route所在原assistant允许toolUse，tool_call_ids只含本次route。
 *
 * 未冻结末项的渲染正文分支；与output_binding、answer_sdk_tool_call_id互斥。
 *
 *
 * 单份渲染正文分支：final_text为该份display（非模板、非整轮组合全文），与answer_parts、answer_sdk_tool_call_id、control_delivery_ref、output_binding及final_start_chunk_seq互斥。组合时改用answer_parts末项的rendered分支，不传顶层rendered。
 */
export interface RenderedAnswerBinding {
    /**
     * 原Pi entry/attempt/stop/tool
     * IDs与source_text的SHA256；本分支禁止携带first/last_chunk_seq，展示范围由外层字段表达。
     */
    assistant: AssistantOutputBinding;
    /**
     * 已持久化展示片段范围；display = replace_once(source_text, bindings) + required_suffix。
     */
    first_chunk_seq: string;
    last_chunk_seq:  string;
    /**
     * 本条正文实际采用的原prepare_analysis_answer成功回执；不因分支上后来存在新prepare而改用最近一份。
     */
    prepared_sdk_tool_call_id: string;
    /**
     * 原Pi完整正文（含{{name}}标记），来自Node宿主SessionManager原assistant entry；不是展示替换后的文字。Rust边界核对其UTF-8
     * SHA256。
     */
    source_text: string;
}

/**
 * 原查询所属任务和条件版本，由宿主绑定；恢复已切任务时不依赖最近查询观察窗口。旧通知缺字段沿原兼容路径读取。
 *
 * 成功答案的原工具登记归属，来自宿主task_id/task_condition_version；与实际sources和通知交付目标分开，不改原回执存储字节。
 */
export interface EvidenceTaskRef {
    condition_version: string;
    task_id:           string;
}

export interface Checkpoint {
    authority_revision?: null | string;
    authority_snapshot?: { [key: string]: unknown };
    entries:             { [key: string]: unknown }[];
    leaf_id:             null | string;
    sdk_version:         SDKVersion;
    storage?:            CheckpointReference;
}

export interface CheckpointReference {
    file?:        string;
    kind:         CheckpointReferenceKind;
    session_id?:  string;
    fingerprint?: string;
}

export interface ModelProfile {
    /**
     * 省略沿用有限trial；request为正常持续使用，无每消息累计调用上限，累计费用/试用期限不默认拦截。
     */
    budget_mode?: BudgetMode;
    /**
     * 窗口能力来源：SDK目录或管理员声明；目录外型号不猜窗口。
     */
    capability_source?: CapabilitySource;
    configured_model?:  ConfiguredModel;
    /**
     * 总上下文tokens；与输入/输出策略分开表达。
     */
    context_window?:      number;
    input_limit:          number;
    model_id:             string;
    output_limit:         number;
    payload_bytes_limit?: number;
    price_version:        string;
    provider_id:          string;
    /**
     * 历史兼容字段：旧request scope按每消息24次封顶；正常配置省略，残留值仅保旧解码，不作运行上限。
     */
    request_call_limit?: number;
    /**
     * 单次provider请求超时毫秒，随模型修订冻结；历史缺字段按90000处理。
     */
    request_timeout_ms?: number;
    thinking_level?:     ThinkingLevel;
    toolset?:            Toolset;
    trial_call_limit?:   number;
    trial_cost_micros?:  string;
    trial_id:            string;
}

export interface ConfiguredModel {
    anthropic_thinking_mode?: AnthropicThinkingMode;
    api:                      API;
    id:                       string;
    input_rate:               string;
    output_rate:              string;
    reasoning_supported:      boolean;
    service_id:               string;
    service_version:          string;
    version:                  string;
}

export interface RequestClock {
    business_timezone:  BusinessTimezone;
    reference_time_utc: string;
}

export interface WorkspaceContext {
    /**
     * 会话持久活动取证任务：一次派发只绑定一个活动任务，受限读取与轮内重投影由此继承；null表示尚无活动任务。
     */
    active_task_ref?:    FluffyActiveTaskRef | null;
    asset_counts?:       FluffyAssetCounts;
    authority_revision:  string;
    authority_snapshot?: { [key: string]: unknown };
    control_delivery?:   ControlDelivery | null;
    /**
     * 启动/恢复/刷新时，宿主按原通知条件scope核验已冻结答案的覆盖事实。缺省不证明已覆盖，不能凭query_id命中扩大通知范围。
     */
    frozen_notification_covered?: boolean;
    /**
     * 当前输入的持久全部任务归属；恢复时按当前lifecycle继续剩余目标。
     */
    input_task_ids?: string[];
    memories:        ModelAssetPreview[];
    /**
     *
     * 个人记忆注入通道：mem0_authoritative按Mem0召回注入，directory_fallback为Mem0不可用退回目录。受限任务来源门生效时按资产真实来源过滤后仍注入同源记忆，仅无可证明同源资产或来源范围未知时不注入并标记excluded_by_source_limits；与search_knowledge回执中的同值口径一致。
     */
    memory_retrieval?:  MemoryRetrieval;
    query_observations: { [key: string]: unknown }[];
    recent_messages:    ChatMessage[];
    request_clock?:     RequestClock;
    /**
     * 宿主查询终态通知身份；普通用户消息省略，不从文字前缀推断成功。
     */
    result_notification?: FluffyResultNotification;
    selected_skills:      ModelAssetPreview[];
    /**
     * 与本快照source_context_ready同次计算的未就绪原因；仅控制信息，不含来源正文。就绪时省略，旧快照缺省仍沿原准入行为。
     */
    source_context_blocker?: SourceContextBlocker;
    /**
     *
     * 当前输入已归属且来源范围可确定，才可将证据正文交给模型。false时只提供用户原话及控制/来源身份元信息，保留同一Pi会话而暂不发送旧资料正文。v2派发和刷新由宿主计算；旧v1缺省不改变原行为。
     */
    source_context_ready?: boolean;
    tasks:                 WorkspaceTask[];
}

export interface FluffyActiveTaskRef {
    condition_version: string;
    task_id:           string;
}

export interface FluffyAssetCounts {
    memories:        number;
    selected_skills: number;
}

/**
 *
 * 宿主按持久任务/查询事实生成的短控制交付；只覆盖已保存、已提交、等待结果和已持久澄清，不代表分析完成。text_authority只记录实际展示文字的来源；旧回执缺省时沿原任务字段来源核验，不能当作空来源。
 */
export interface ControlDelivery {
    facts:           ControlDeliveryFact[];
    fingerprint:     string;
    task_refs:       [EvidenceTaskRef, ...EvidenceTaskRef[]];
    text:            string;
    text_authority?: { [key: string]: unknown };
}

export interface ControlDeliveryFact {
    clarification_id?:   string;
    condition_version:   string;
    confirmation_state?: null | string;
    execution_state?:    FactExecutionState;
    has_more?:           boolean;
    kind:                FactKind;
    query_id?:           string;
    question?:           string;
    task_id:             string;
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
    state:        MemoryState;
    verified:     boolean;
    version:      string;
    visibility?:  Visibility;
}

/**
 * 来源原话的独立字符分页。缺省source_text为空但保留总长和补读位置；以entry_id=source_text和同一资产版本读取。
 *
 * 支持正文自己的Unicode字符页；游标仍沿supports_next_cursor继续。同一支持的尾页不代表本回执已包含整条支持。
 */
export interface ContentPage {
    complete:    boolean;
    next_offset: number | null;
    offset:      number;
    total_chars: number;
}

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

export interface ChatMessage {
    attempt_id:     null | string;
    committed:      boolean;
    event_seq?:     string;
    message_id?:    null | string;
    output_id?:     null | string;
    request_clock?: RequestClock;
    role:           ChatMessageRole;
    text:           string;
}

/**
 * 宿主查询终态通知身份；普通用户消息省略，不从文字前缀推断成功。
 */
export interface FluffyResultNotification {
    execution_state: ResultNotificationExecutionState;
    query_id:        string;
    /**
     * 原查询所属任务和条件版本，由宿主绑定；恢复已切任务时不依赖最近查询观察窗口。旧通知缺字段沿原兼容路径读取。
     */
    task_ref?: EvidenceTaskRef;
}

export interface WorkspaceTask {
    decision_state_version?: number;
    evidence_refs?:          AnalysisEvidenceRef[];
    legacy_pending?:         LegacyPending;
    report_ref?:             AnalysisReportRef;
    revision_origin?:        LegacyRevisionOrigin;
    [property: string]: unknown;
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

/**
 * 旧条件未决的只读投影；索引来自原数组，basis-only旧项用索引0。不授采纳或执行权。
 */
export interface LegacyPending {
    condition_version: string;
    items:             [LegacyPendingItem, ...LegacyPendingItem[]];
}

export interface LegacyPendingItem {
    index:             number;
    text?:             string;
    text_unavailable?: boolean;
}

export interface AnalysisReportRef {
    condition_version: string;
    conversation_id:   string;
    report_id:         string;
    task_id:           string;
    version:           string;
}

/**
 * 显式读取旧条件版本时接回的真实成功修订出处；原话只说明来源，不自动证明采纳或授执行权。
 */
export interface LegacyRevisionOrigin {
    message_id:    string;
    operation_id:  string;
    origin_run_id: string;
    user_quote:    null | string;
    user_supplied: boolean;
}

export interface ToolInvocation {
    arguments:        TaskInput;
    checkpoint:       Checkpoint;
    lease_epoch:      string;
    run_id:           string;
    sdk_tool_call_id: string;
}

export interface TaskInput {
    action: TaskInputAction;
    goal:   string;
}

export interface AppendOutput {
    chunk_seq:   string;
    lease_epoch: string;
    run_id:      string;
    text:        string;
}

export interface FinishRun {
    /**
     *
     * 完整有序引用。存在新末项时final_text核对其原文；原消息其余任务均已取消或由可见任务卡/宿主控制交付解释且有效任务已冻结时，可只发冻结引用并省略final_text。单份正文仍限8000字符；多份组合由实际项数、标题和分隔格式推导，上限384281字符。Rust核当前任务集合与来源后取原内容组合。
     */
    answer_parts?: [AnswerPartReference, ...AnswerPartReference[]];
    /**
     * 使用present_analysis_answer成功回执交付时绑定该SDK调用，正文须与宿主生成值一致。
     */
    answer_sdk_tool_call_id?: string;
    checkpoint:               Checkpoint;
    commit_id:                string;
    control_delivery_ref?:    ControlDeliveryRef;
    /**
     * Pi最后助手消息的首个已保存片段序号；省略时沿用从1起的完整文本校验。
     */
    final_start_chunk_seq?: string;
    final_text?:            string;
    lease_epoch:            string;
    /**
     *
     * 宿主确认的正常完整自然final原输出绑定；恢复时保原attempt/entry/片段。须有final_text，与answer_parts、answer_sdk_tool_call_id、control_delivery_ref及final_start_chunk_seq互斥。
     */
    output_binding?: AssistantOutputBinding;
    /**
     *
     * 单份渲染正文分支：final_text为该份display（非模板、非整轮组合全文），与answer_parts、answer_sdk_tool_call_id、control_delivery_ref、output_binding及final_start_chunk_seq互斥。组合时改用answer_parts末项的rendered分支，不传顶层rendered。
     */
    rendered_answer_binding?: RenderedAnswerBinding;
    run_id:                   string;
}

export interface ControlDeliveryRef {
    fingerprint: string;
}

export interface ModelAttempt {
    call_attempt_id: string;
    lease_epoch:     string;
    run_id:          string;
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

export interface Event {
    conversation_id: string;
    event_id:        string;
    event_seq:       string;
    payload:         { [key: string]: unknown };
    schema_version:  number;
    type:            EventType;
}

export interface RunSnapshot {
    /**
     * 运行中run最近一次已登记工具调用的中文动作提示，由服务端映射工具名生成；无工具调用的旧记录缺省。
     */
    activity_label?: string;
    /**
     * 本run当前生成尝试身份，用于识别正文增量归属；旧快照可缺省。
     */
    attempt_id?: string;
    /**
     * 已完成的工具动作、当前可读对象名称与真实耗时。仅作界面进度提示。
     */
    completed_step_summaries?: RunStepSummary[];
    /**
     * 该run已成功回执的工具调用计数；旧记录缺省。仅作进度展示，不作为执行依据。
     */
    completed_steps?: number;
    lease_epoch:      string;
    /**
     * 来自已有持久记录的触发消息身份；旧快照可缺省。
     */
    message_id?: string;
    /**
     * user_request为用户消息触发；query_result为查询结果通知触发。旧快照可缺省，缺省时按中性处理提示展示。
     */
    purpose?: RunSnapshotPurpose;
    /**
     * 结果通知run关联的原查询ID，来自conversations可信server:query-result消息关联；仅purpose=query_result时非null。
     */
    result_query_id?: null | string;
    run_id:           string;
    state:            RunSnapshotState;
}

export interface RunStepSummary {
    category:    string;
    duration_ms: number;
    target_name: null | string;
}

export interface TaskSnapshot {
    condition_version:          string;
    evidence_refs?:             AnalysisEvidenceRef[];
    goal?:                      string;
    id:                         string;
    lifecycle?:                 string;
    note?:                      string;
    phase?:                     string;
    report_ref?:                AnalysisReportRef;
    report_timeline_event_seq?: string;
    text_unavailable?:          boolean;
}

export interface SnapshotRequest {
    after_seq?:     string;
    before_seq?:    string;
    loaded_outputs: LoadedOutputRange[];
}

/**
 * 客户端已读连续事件区间内的输出片段；指纹只标识缓存内容，不授读取权。
 */
export interface LoadedOutputRange {
    attempt_id:              string;
    first_event_seq:         string;
    last_event_seq:          string;
    projection_fingerprint?: string;
}

/**
 * POST snapshot独立响应；普通分页游标与已加载输出的权限投影分开，旧GET Snapshot形状保持。
 */
export interface SnapshotRefresh {
    conversation_id:    string;
    events:             Event[];
    first_event_seq?:   string;
    has_newer?:         boolean;
    has_older?:         boolean;
    last_event_seq?:    string;
    messages:           ChatMessage[];
    output_projections: OutputProjection[];
    runs:               RunSnapshot[];
    tasks:              TaskSnapshot[];
}

/**
 * 每个请求范围恰有一个结果；replace完整替换该范围的assistant事件，空数组仍表示替换。not_available不区分缺失和其他会话。
 */
export interface OutputProjection {
    attempt_id:             string;
    events?:                Event[];
    first_event_seq:        string;
    last_event_seq:         string;
    output_state:           OutputState | null;
    projection_fingerprint: string;
    projection_result:      ProjectionResult;
}

export interface ToolOutcome {
    receipt?: ToolReceipt;
    type:     ToolOutcomeType;
    error?:   AppError;
}

export interface AppError {
    code:       Code;
    message:    string;
    request_id: string;
    retryable:  boolean;
}

export interface ToolReceipt {
    condition_version: string;
    operation_id:      string;
    state:             ToolReceiptState;
    task_id:           string;
}

export interface ConversationReceipt {
    conversation_id: string;
}

export interface MessageReceipt {
    message_id: string;
    request_id: string;
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

export interface Identity {
    model_label: ModelLabel;
    space_id:    string;
    /**
     * 空间显示名，由部署配置下发；与space_id分开，不参与授权判断。
     */
    space_name: string;
    user_id:    string;
}

export interface SessionReceipt {
    model_label: ModelLabel;
    space_id:    string;
    /**
     * 空间显示名，由部署配置下发；与space_id分开，不参与授权判断。
     */
    space_name: string;
    state:      SessionReceiptState;
    user_id:    string;
}

export interface LogoutReceipt {
    state: LogoutReceiptState;
}

export interface OperationReceipt {
    operation_id: string;
    /**
     * 原登记tool行冻结的合同版本，不随当前run变化；历史缺失按1。
     */
    tool_contract_version?: number;
}

export interface OutputReceipt {
    chunk_seq: string;
}

export interface FinishReceipt {
    output_id: string;
    state:     FinishReceiptState;
}

export interface ModelReceipt {
    state: ModelReceiptState;
}

export interface ReserveModelCall {
    call_attempt_id:        string;
    input_tokens_upper:     number;
    lease_epoch:            string;
    output_tokens_max:      number;
    parameters_fingerprint: string;
    run_id:                 string;
}

export interface SendModelCall {
    call_attempt_id:        string;
    lease_epoch:            string;
    parameters_fingerprint: string;
    run_id:                 string;
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

export interface ModelUsage {
    elapsed_ms:    number;
    input_tokens:  number;
    output_tokens: number;
}

export interface ModelCallReceipt {
    send_allowed: boolean;
    state:        ModelCallReceiptState;
}

export interface CancelRun {
    lease_epoch: string;
    run_id:      string;
}

export interface CancelReceipt {
    run_id: string;
    state:  CancelReceiptState;
}

export interface KnowledgeList {
    next_after_id:    null | string;
    objects:          KnowledgeObject[];
    retrieval_mode:   string;
    search_coverage?: SearchCoverage | null;
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
    prefill_status?: KnowledgeObjectPrefillStatusClass | null;
    /**
     * 当前来源的语义整理状态；与对象级预填分开表达，两作业互不冒充。
     */
    preparation_status?: KnowledgeObjectPreparationStatusClass | null;
    related_ids:         string[];
    retrieval?:          KnowledgeRetrieval;
    semantic_relations?: SemanticRelation[];
    source_id:           null | string;
    source_version:      string;
    state:               MemoryState;
    /**
     * 平台移除与人工停用分开；重新出现只能恢复平台导致的停用。
     */
    state_origin?: StateOrigin;
    updated_by:    string;
    version:       string;
}

export interface TableAnalysisPreference {
    preferred: boolean;
    table_id:  string;
    version:   string;
}

export interface KnowledgeEntry {
    effective_structure?: KnowledgeEntryQueryExampleStructureClass | null;
    effective_value:      string;
    entry_id:             string;
    human_override:       null | KnowledgeEntryHumanOverrideObject;
    label:                string;
    path:                 string;
    review_state:         ReviewState;
    source_facts:         KnowledgeEntrySourceFactsObject;
    statements?:          SemanticStatement[];
    suggestion:           KnowledgeEntrySuggestionObject;
}

export type KnowledgeEntryQueryExampleStructureClass = SemanticStructure;

export interface ComputedMetric {
    /**
     * 输出该口径的表达式或列计算说明。
     */
    expression: string;
    metric_ref: EvidenceRef;
    /**
     * 该SQL实际输出的口径名；与过滤中用到的指标分开表达。
     */
    output_name: string;
}

export interface FluffyJoinKey {
    left_column:  string;
    right_column: string;
}

export interface SemanticTableRef {
    object_id: string;
    version:   string;
}

export interface QueryExampleParameter {
    description: string;
    name:        string;
    required:    boolean;
    type:        QueryExampleParameterType;
}

export interface FluffyTimeColumn {
    column: string;
    role:   string;
}

export interface QueryExampleVerification {
    evidence_refs: [EvidenceRef, ...EvidenceRef[]];
    note:          string;
}

export interface KnowledgeEntryHumanOverrideObject {
    structured_value?: KnowledgeEntryQueryExampleStructureClass | null;
    [property: string]: unknown;
}

export interface KnowledgeEntrySourceFactsObject {
    structured_value?: KnowledgeEntryQueryExampleStructureClass | null;
    [property: string]: unknown;
}

export interface SemanticStatement {
    citations:    SourceCitation[];
    object_ref:   EvidenceRef;
    origin:       Origin;
    scope_text:   string;
    statement_id: string;
    supports:     SemanticSupport[];
    /**
     * 人工或整理成果对该陈述支持提取范围的明确完整性声明；历史缺字段或null为unknown，不从空supports或ready推导。
     */
    supports_complete?: boolean | null;
    text:               string;
}

export interface SourceCitation {
    locator:  SourceLocator;
    revision: string;
    source:   SourceKey;
}

/**
 * offset及length固定使用Unicode code point；heading_path仅作定位提示。
 */
export interface SourceLocator {
    heading_path?: string[];
    length:        number;
    offset:        number;
}

/**
 *
 * 来源的稳定身份。kind和id须成对原样使用source_identity回执的source_keys或已有citation.source；不按资料名称、object_id前缀或正文是文档来猜kind，不将document改成platform。不包含修订号，也不使用索引chunk
 * ID。
 */
export interface SourceKey {
    id:   string;
    kind: SourceKeyKind;
}

export interface SemanticSupport {
    content:     null | string;
    embedded_in: EmbeddedSupportLocation | null;
    reference:   SemanticReference;
    role:        PreparedSupportRole;
    support_id:  string;
}

export interface EmbeddedSupportLocation {
    field:   Field;
    locator: SourceLocator;
}

export interface SemanticReference {
    citation?: SourceCitation;
    kind:      SemanticReferenceKind;
    ref?:      EvidenceRef;
}

export interface KnowledgeEntrySuggestionObject {
    structured_value?: KnowledgeEntryQueryExampleStructureClass | null;
    [property: string]: unknown;
}

export interface SemanticMaintenance {
    authority_id: string;
    can_assign:   boolean;
    can_edit:     boolean;
    /**
     * 当前对象负责人：表来自 Datasight；独立人工对象默认创建者，超级维护者可调整。
     */
    maintainer_id: null | string;
    source:        Source;
    version:       string;
}

export interface KnowledgeObjectPrefillStatusClass {
    attempt_id: string;
    error_code: null | string;
    state:      string;
}

export interface KnowledgeObjectPreparationStatusClass {
    error_code: null | string;
    revision:   string;
    source_id:  string;
    state:      string;
}

export interface KnowledgeRetrieval {
    channel?: KnowledgeRetrievalChannel;
    excerpts: KnowledgeRetrievalExcerpt[];
    note:     string;
    state:    KnowledgeRetrievalState;
}

export interface KnowledgeRetrievalExcerpt {
    entry_id:    string;
    length:      number;
    offset:      number;
    path:        string;
    text:        string;
    total_chars: number;
}

export interface SemanticRelation {
    citations:   SourceCitation[];
    origin:      Origin;
    predicate:   Predicate;
    relation_id: string;
    scope_text:  string;
    subject:     EvidenceRef;
    target:      SemanticReference;
}

export interface SearchCoverage {
    /**
     * 本次实际接收的唯一候选记录身份数（有效性筛除与合并前，跨通道跨轮去重累计）；达到candidate_limit即如实报覆盖不足。
     */
    candidate_count?: number;
    candidate_limit:  number;
    /**
     * 逐通道有界进度；足够本页结果不表示穷举了该通道。
     */
    channels?: FluffyChannels;
    /**
     * 覆盖检查因期限耗尽或读取超时未完成；此时没有已证滞后，不能报index_lag，未覆盖原因以deadline/通道事实表达。
     */
    index_check_incomplete?: boolean;
    /**
     * 是否实际查到旧投影或漏索引（覆盖检查已完成并确认滞后）。incomplete还可能是检查未完成，见index_check_incomplete；两者不能互相反推。
     */
    index_lag?:   boolean;
    index_state?: IndexState;
    /**
     * 候选谓词是否覆盖全部去重检索词项；false时应改写或拆分查询，不能据空结果断言没有资料。
     */
    query_terms_complete?: boolean;
    scope_applied?:        boolean;
    state:                 SearchCoverageState;
    vector_state?:         VectorState;
}

/**
 * 逐通道有界进度；足够本页结果不表示穷举了该通道。
 */
export interface FluffyChannels {
    dense:   ChannelProgress;
    lexical: ChannelProgress;
    raw?:    ChannelProgress;
}

export interface ChannelProgress {
    completed: number;
    exhausted: boolean;
    rounds:    number;
    shards:    number;
    /**
     * 未覆盖原因：停在候选额度、共享期限，或dense因查询嵌入不可用停轮；null且exhausted=true表示该通道已穷举。
     */
    uncovered?: Uncovered | null;
}

export interface KnowledgeEdit {
    clear_override?:  boolean;
    entry_id:         string;
    expected_version: string;
    operation_id:     string;
    related_ids?:     string[];
    source_url?:      null | string;
    /**
     * 本次明确保存的人工陈述及支持提取声明；身份和origin由服务端生成，未提供时不编造完整性。
     */
    statements?:       HumanStatementInput[];
    structured_value?: KnowledgeEntryQueryExampleStructureClass | null;
    value:             string;
}

export interface HumanStatementInput {
    citations:          SourceCitation[];
    key:                string;
    scope_text:         string;
    supports:           PreparedSupport[];
    supports_complete?: boolean | null;
    target:             EvidenceRef;
    text:               string;
}

export interface PreparedSupport {
    content:     null | string;
    embedded_in: EmbeddedSupportLocation | null;
    key:         string;
    reference:   SemanticReference;
    role:        PreparedSupportRole;
}

export interface KnowledgeEntryBatch {
    /**
     * 同一对象内按序应用的条目修改；任一条目校验失败则整批回滚。
     */
    edits: [KnowledgeEntryEdit, ...KnowledgeEntryEdit[]];
    /**
     * 批量开始前的对象版本；同一事务内逐条保存，每条按既有语义递增，返回对象为最终版本。
     */
    expected_version: string;
    operation_id:     string;
}

export interface KnowledgeEntryEdit {
    clear_override?: boolean;
    entry_id:        string;
    related_ids?:    string[];
    source_url?:     null | string;
    /**
     * 本条目明确保存的人工陈述及支持提取声明；身份和origin由服务端生成。
     */
    statements?:       HumanStatementInput[];
    structured_value?: KnowledgeEntryQueryExampleStructureClass | null;
    value:             string;
}

/**
 * 独立对象首次创建时自动归属可信登录者；请求不接受负责人字段，后续调整使用独立管理接口。
 */
export interface KnowledgeCreate {
    body: string;
    /**
     * 对象自身的显式业务域；省略或空值表示未分类，不从关联对象继承。
     */
    business_domain?:  string;
    kind:              KindElement;
    name:              string;
    operation_id:      string;
    related_ids:       string[];
    source_url?:       null | string;
    structured_value?: KnowledgeEntryQueryExampleStructureClass | null;
}

export interface VersionCommand {
    expected_version: string;
    operation_id:     string;
}

export interface AssetList {
    assets: Asset[];
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
    /**
     * 来源失效或缺少可核验来源时仅供管理，正文、附件与引用已隐藏，不能选用或发布。
     */
    text_unavailable?: boolean;
    verified:          boolean;
    version:           string;
    visibility?:       Visibility;
}

export interface SkillFile {
    /**
     * UTF-8 文本；每行最多 51200 字节，业务边界校验并返回 skill_line_too_long。
     */
    content: string;
    path:    string;
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

export interface SkillSelection {
    asset_id:     string;
    operation_id: string;
    version:      string;
}

export interface AnalysisUpdateFields {
    action?: AnalysisUpdateAction;
    /**
     * 同一任务需分别回答的独立问题，各生成独立ID；与非空question互斥，不同目标分别建任务。
     */
    clarifications?: ClarificationRequest[];
    /**
     *
     * 修改已存任务条件时必填，action用revise或clarify；set指定新值，unset可省略（省略即不清空任何字段，null非法）。route禁止携带condition_patch，因为route只登记归属。
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
    /**
     *
     * 仅route可用：显式定稿当前任务已完成的说明或查询答案；可route到同一任务保留其SQL等待状态，也可切到其他目标。该助手消息只允许这个route；宿主绑定完整正文或原成功答案回执。普通route不定稿，不授执行权。
     */
    finalize_current_answer?:     boolean;
    goal?:                        string;
    legacy_resolution_migration?: LegacyResolutionMigration;
    /**
     * split迁移到新独立目标的原开放问题ID，保留问题正文与来源，其余原目标问题不动。
     */
    moved_clarification_ids?: string[];
    /**
     * 澄清问题的候选答案；仅与实际question同用，开放回答可无候选（空数组或省略）。
     */
    options?: string[];
    /**
     * 需要用户补充的实际问题；无需澄清时省略（也接受JSON null），不能填字符串null、空文本或用户原问题。
     */
    question?:          null | string;
    replaces_query_id?: null | string;
    /**
     *
     * 本消息中用户已真实回答，或当前有效且获准资料已唯一解决的事实问题ID；事实解决须在同次revise保存条件与依据，不能伪称用户选择。省略或[]保留其他问题，仅已有任务revise/clarify可用。
     */
    resolved_clarification_ids?: string[];
    /**
     * 新建任务省略此字段（也接受JSON null）；已有任务用工具回执中的真实ID，不能填字符串null。
     */
    task_id?: null | string;
}

export interface ClarificationRequest {
    /**
     * 此独立问题的候选答案；允许自由回答。
     */
    options: string[];
    /**
     * 此独立问题的必填正文；无需新增问题时省略整个clarifications列表。
     */
    question: string;
}

/**
 *
 * 修改已存任务条件时必填，action用revise或clarify；set指定新值，unset可省略（省略即不清空任何字段，null非法）。route禁止携带condition_patch，因为route只登记归属。
 */
export interface ConditionPatch {
    set: ConditionSet;
    /**
     * 清除指定条件字段。省略即空集合（不清空任何字段），null非法；显式数组仍清除列出的字段。
     */
    unset?: Unset[];
}

export interface ConditionSet {
    channel?:        ConditionsChannel;
    filters?:        string[];
    group_by?:       string[];
    knowledge_refs?: EvidenceRef[];
    metric?:         string;
    notes?:          string;
    /**
     * 只更新已采用解释及来源；null/unset只清说明，不解决开放问题。旧未决通过明确legacy_resolution_migration转换。
     */
    semantic_resolution?: ConditionsQuerySemanticResolution | null;
    /**
     * 设置来源限制；撤销使用unset source_limits，不接受设为空集。
     */
    source_limits?: SourceLimits;
    /**
     * 修改区间的不包含终点，按业务时区解析后填写UTC完整时间戳，以Z结尾；整月结束为下一月起点。清空使用unset；未修改则省略。
     */
    time_end?: string;
    /**
     * 整体替换时间口径角色；清空使用unset。
     */
    time_roles?: [TimeRole, ...TimeRole[]];
    /**
     * 修改区间的包含起点，按业务时区解析后填写UTC完整时间戳，以Z结尾。清空使用unset；未修改则省略。
     */
    time_start?: string;
    timezone?:   string;
}

/**
 *
 * 新格式仅记录已经采用的解释。explicit_user引用本轮完整原话，null/省略采纳身份由宿主绑定；原已核对象可同文继承。未决只登记clarifications，无问题且条件充分时不要求本对象。
 */
export interface ConditionsQuerySemanticResolution {
    /**
     *
     * explicit_user：null=本轮新采纳，由宿主核对user_quote为本轮完整原话后绑定真实消息身份；非空=复制继承原已验证决策的消息身份，不接受模型自由填写。其余basis为null。
     */
    adoption_message_id?: null | string;
    /**
     * 真实用户明确选择、确无实质歧义、或仍需澄清；资料支持某公式不等于用户选择它。
     */
    basis: SemanticResolutionBasis;
    /**
     * 支撑该口径决策的依据引用；旧调用缺失按空数组解码。
     */
    evidence_refs?: EvidenceRef[];
    /**
     * 本稿采用的指标、分子/分母、时间等关键口径及选择依据；不能把自己刚写入任务的假设当作用户采用。
     */
    interpretation: string;
    /**
     * 仍会改变答案且未获选择的分子、分母、时间归属等差异；有差异必须先澄清，不能默认写稿。
     */
    unresolved_differences?: string[];
    /**
     * explicit_user逐字填写本条真实用户完整原话，保留否定、前提、例外和换行，不截取子串；其余为null。
     */
    user_quote: null | string;
}

/**
 * 设置来源限制；撤销使用unset source_limits，不接受设为空集。
 */
export interface SourceLimits {
    /**
     * 非空允许集；限制跟稳定来源身份走，实际读取仍核对当前修订。
     */
    allowed_sources: [SourceKey, ...SourceKey[]];
    /**
     * 由宿主绑定的真实消息身份；不接受模型自由填写。
     */
    origin_message_ids: string[];
}

export interface TimeRole {
    /**
     * 业务含义说明。
     */
    description: string;
    /**
     * 支撑该时间口径的依据；可空数组。
     */
    evidence_refs: EvidenceRef[];
    /**
     * 采用的时间字段引用；可空。
     */
    field_ref: null | string;
    /**
     * 采用的时间字段含义、观察截点或数据批次；三者不混用。
     */
    role: TimeRoleRole;
    /**
     * observation_cutoff必须为带时区的时间值，data_batch必须为批次值；event_time可空（实际区间沿time_start/time_end）。
     */
    value: null | string;
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
     * 当前格式仅记录已采用解释及依据，未决由clarifications表达；省略继承，null只清说明，未要求所有任务填写。旧形状按宿主持久格式标记兼容，读取不迁移。
     */
    semantic_resolution?: ConditionsQuerySemanticResolution | null;
    /**
     * null表示本题显式未声明额外来源限制；字段缺失表示旧条件版本未记录新式限制，不能证明用户从未限制。撤销必须显式unset并来自真实用户修改。
     */
    source_limits?: SourceLimits | null;
    /**
     * 时间区间的不包含终点。按明确的业务时区解析后转为UTC完整时间戳，以Z结尾；整月结束为下一月起点，不能写本月最后一天。未指定时为null。
     */
    time_end: null | string;
    /**
     * 时间口径角色；统计起止仍沿time_start/time_end，request_clock和平台data_freshness不冒充用户截点。字段缺失表示旧版本未记录。
     */
    time_roles?: TimeRole[];
    /**
     * 时间区间的包含起点。按明确的业务时区解析后转为UTC完整时间戳，以Z结尾；不能只写日期。未指定时为null。
     */
    time_start: null | string;
    timezone:   string;
}

/**
 * 仅revise显式转换旧未决。每项链接实际问题；已resolved项给原条件版本及所指顶层字段，宿主核实际回执/原消息及字段来源。无依据保持或恢复open，未关联旧项登记open。
 */
export interface LegacyResolutionMigration {
    from_condition_version: string;
    links:                  LegacyResolutionLink[];
}

export interface LegacyResolutionLink {
    clarification_id:              string;
    condition_fields?:             [ConditionField, ...ConditionField[]];
    pending_index:                 number;
    resolution_condition_version?: string;
}

export interface AnalysisUpdate {
    action: AnalysisUpdateAction;
    /**
     * 同一任务需分别回答的独立问题，各生成独立ID；与非空question互斥，不同目标分别建任务。
     */
    clarifications?: ClarificationRequest[];
    /**
     *
     * 修改已存任务条件时必填，action用revise或clarify；set指定新值，unset可省略（省略即不清空任何字段，null非法）。route禁止携带condition_patch，因为route只登记归属。
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
    /**
     *
     * 仅route可用：显式定稿当前任务已完成的说明或查询答案；可route到同一任务保留其SQL等待状态，也可切到其他目标。该助手消息只允许这个route；宿主绑定完整正文或原成功答案回执。普通route不定稿，不授执行权。
     */
    finalize_current_answer?:     boolean;
    goal?:                        string;
    legacy_resolution_migration?: LegacyResolutionMigration;
    /**
     * split迁移到新独立目标的原开放问题ID，保留问题正文与来源，其余原目标问题不动。
     */
    moved_clarification_ids?: string[];
    /**
     * 澄清问题的候选答案；仅与实际question同用，开放回答可无候选（空数组或省略）。
     */
    options: string[];
    /**
     * 需要用户补充的实际问题；无需澄清时省略（也接受JSON null），不能填字符串null、空文本或用户原问题。
     */
    question?:          null | string;
    replaces_query_id?: null | string;
    /**
     *
     * 本消息中用户已真实回答，或当前有效且获准资料已唯一解决的事实问题ID；事实解决须在同次revise保存条件与依据，不能伪称用户选择。省略或[]保留其他问题，仅已有任务revise/clarify可用。
     */
    resolved_clarification_ids?: string[];
    /**
     * 新建任务省略此字段（也接受JSON null）；已有任务用工具回执中的真实ID，不能填字符串null。
     */
    task_id?: null | string;
}

export interface SkillReadResult {
    asset?:    ModelAssetPreview;
    asset_ref: AssetReadRef;
    kind:      SkillReadResultKind;
    state:     EvidenceReadResultState;
}

export interface AssetReadRef {
    id:      string;
    version: string;
}

export interface MemoryReadResult {
    asset?:    ModelAssetPreview;
    asset_ref: AssetReadRef;
    kind:      MemoryReadResultKind;
    part:      PartEnum;
    state:     EvidenceReadResultState;
}

export interface KnowledgeReadInput {
    items:     [KnowledgeReadItem, ...KnowledgeReadItem[]];
    task_ref?: EvidenceTaskRef;
}

export type KnowledgeReadItem = {
    kind: "knowledge";
    ref: EvidenceRef;
    statement_id?: string;
    structure_only?: boolean;
    supports_cursor?: string;
    offset?: number;
    limit?: number;
} | {
    kind: "memory";
    asset_ref: AssetReadRef;
    part: PartEnum;
    offset?: number;
    limit?: number;
} | {
    kind: "skill";
    asset_ref: AssetReadRef;
};

export type KnowledgeReadResult = {
    kind: KnowledgeReadResultKind;
    ref: EvidenceRef;
    state: "ok";
    statement_id?: string;
    content: string;
    content_page: ContentPage;
    structure_text?: string;
    structure_page?: ContentPage;
    effective_structure?: KnowledgeEntryQueryExampleStructureClass | null;
    structure_dependencies?: EvidenceRef[];
    structure_coverage?: FluffyStructureCoverage;
    supports: DeliveredSupport[];
    supports_total?: number;
    supports_complete: boolean | null;
    citations: SourceCitation[];
    content_state: ContentState;
    support_state: SupportState;
    continuation: EvidenceContinuation;
} | {
    kind: KnowledgeReadResultKind;
    ref: EvidenceRef;
    state: "stale";
} | {
    kind: KnowledgeReadResultKind;
    ref: EvidenceRef;
    state: "not_available";
};

export interface EvidenceContinuation {
    content_next_offset:  number | null;
    supports_next_cursor: null | string;
}

export interface FluffyStructureCoverage {
    notes: string[];
    state: StructureCoverageState;
}

export interface DeliveredSupport {
    content: null | string;
    /**
     * 支持正文自己的Unicode字符页；游标仍沿supports_next_cursor继续。同一支持的尾页不代表本回执已包含整条支持。
     */
    content_page?: ContentPage;
    delivered_in?: DeliveredSupportDeliveredInClass;
    embedded_in:   EmbeddedSupportLocation | null;
    reference:     SemanticReference;
    role:          PreparedSupportRole;
    support_id:    string;
}

export interface DeliveredSupportDeliveredInClass {
    locator: SourceLocator;
    path:    string;
}

export interface KnowledgeReadReply {
    items: [EvidenceReadResult, ...EvidenceReadResult[]];
}

export type EvidenceReadResult = KnowledgeReadResult | MemoryReadResult | SkillReadResult;

export interface SourceReadInput {
    citation:  SourceCitation;
    limit?:    number;
    task_ref?: EvidenceTaskRef;
}

export interface SourceReadReply {
    content_state: ContentState;
    locator:       SourceLocator;
    next_locator:  SourceLocator | null;
    revision:      string;
    source:        SourceKey;
    source_length: number;
    text:          string;
}

export interface KnowledgeSearchInput {
    asset_after?: string;
    /**
     *
     * 由evidence视图search_coverage.next返回的短不透明回执引用rc1:<operation_id>，或旧JSON/gzip续读状态；宿主按当前用户/空间/会话从原成功工具回执恢复完整候选窗口，短引用不是读取凭据。保持原查询、kinds、hints、source_selection和任务绑定，asset_after独立推进。source_identity视图沿用独立cursor。
     */
    cursor?: string;
    /**
     * 仅用于相关性排序，不扩大或收窄当前权限、kinds及任务来源范围。
     */
    hints?: Hints;
    kinds?: [KindElement, ...KindElement[]];
    limit?: number;
    query:  string;
    /**
     *
     * 仅evidence视图使用的精确原文选择。object_id取source_identity.object_id，version取其object_version；只定位这些当前对象的正式source_facts，不授予知识或结构采用权，也不将对象版本当作来源revision。原文仍核实际SourceKey、来源许可、当前修订、完整性与唯一定位；失败项不妨碍其他合法项。kinds仍筛选所选对象类型，hints仍只排序；不接受客户端quote/path/offset，不退到全文。省略时保持原搜索。
     */
    source_selection?: [SourceObjectSelection, ...SourceObjectSelection[]];
    task_ref?:         EvidenceTaskRef;
    /**
     *
     * 省略为evidence取证。source_identity的query按空白分隔名称/ID词，任一词在可读名称或标识中匹配即可返回；单独的*保留目录浏览。只匹配元信息，不解析自然语言、同义词或用户许可，不提供正文/定义/摘录/建议或个人资产，不调用付费语义检索，也不算已读证据或授予正文权限。两种视图的cursor不可互换，身份匹配语义更新后的旧绑定cursor无效。
     */
    view?: KnowledgeSearchInputView;
}

/**
 * 仅用于相关性排序，不扩大或收窄当前权限、kinds及任务来源范围。
 */
export interface Hints {
    business_domain?:    string;
    related_object_ids?: string[];
}

export interface SourceObjectSelection {
    object_id: string;
    version:   string;
}

export interface KnowledgeSearchReply {
    asset_cursor_invalid: boolean;
    asset_total:          number;
    hits:                 KnowledgeSearchHit[];
    /**
     * 多指标检索中已核验命中的表唯一键和关系关联键摘要。缺项应读取对应表和关系的完整结构。
     */
    key_hints?: string[];
    /**
     *
     * 个人记忆检索通道：受限任务来源门生效时按资产真实来源过滤，仅无可证明同源记忆时标记excluded_by_source_limits；命中侧过滤事实见回执source_limits块。
     */
    memory_retrieval:  string;
    next_asset_after:  null | string;
    personal_memories: { [key: string]: unknown }[];
    search_coverage:   KnowledgeSearchCoverage;
    selected_skills:   { [key: string]: unknown }[];
}

export type KnowledgeSearchHit = {
    record_kind: "source_identity";
    name: string;
    kind?: KindElement;
    object_id?: string;
    object_version?: string;
    source_keys: SourceKey[];
    roots_complete: boolean;
} | {
    record_kind: "knowledge_entry";
    ref: EvidenceRef;
    statement_id?: string;
    name: string;
    kind: KindElement;
    definition: string;
    scope_text: string;
    supports: DeliveredSupport[];
    supports_complete: boolean | null;
    example_refs: EvidenceRef[];
    citations: SourceCitation[];
    content_state: ContentState;
    support_state: SupportState;
    continuation: EvidenceContinuation;
} | {
    record_kind: "source_excerpt";
    citation: SourceCitation;
    source_length: number;
    text: string;
    name: string;
    content_state: ContentState;
    support_state: SupportState;
    semantic_status: KnowledgeSearchHitSemanticStatus;
};

export interface KnowledgeSearchCoverage {
    channels: [KnowledgeSearchCoverageChannelClass, ...KnowledgeSearchCoverageChannelClass[]];
    /**
     * evidence视图有后页时为宿主生成的短不透明回执引用rc1:<operation_id>，长度不超过96
     * ASCII字节；宿主只在原成功工具回执持久化完整候选窗口后发布，同操作重放返回同一引用。无后页为null。source_identity视图沿用独立cursor。
     */
    next:    null | string;
    reasons: Reason[];
    state:   KnowledgeSearchCoverageState;
}

export interface KnowledgeSearchCoverageChannelClass {
    channel: ChannelChannel;
    state:   ChannelState;
}

export interface SearchInput {
    asset_after?:       string;
    business_domain?:   string;
    kinds?:             [KindElement, ...KindElement[]];
    limit?:             number;
    query:              string;
    related_object_id?: string;
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

export interface ReadSourceInput {
    limit?:  number;
    offset?: number;
    /**
     * 原始来源ID或document-加知识文档ID的保留别名；文档仍按当前空间、状态和版本校验。
     */
    source_id: string;
    version:   string;
}

export interface RequestQueryInput {
    condition_version:  string;
    knowledge_refs:     EvidenceRef[];
    parameters:         { [key: string]: unknown };
    replaces_query_id?: null | string;
    /**
     * 省略继承目标条件版本已有采纳说明；兼容携带只核同义声明，不能独立另作决定。新任务未决定时登记clarifications，改变解释先同次修订条件。旧形状仅沿旧格式兼容。
     */
    semantic_resolution?: SemanticResolution;
    sql:                  string;
    summary:              string;
    target_id:            TargetID;
    task_id:              string;
}

/**
 * 旧未决形状与新采纳说明仅在兼容边界解码；实际条件格式由宿主decision_state_version决定。
 *
 * 省略继承目标条件版本已有采纳说明；兼容携带只核同义声明，不能独立另作决定。新任务未决定时登记clarifications，改变解释先同次修订条件。旧形状仅沿旧格式兼容。
 *
 *
 * 新格式仅记录已经采用的解释。explicit_user引用本轮完整原话，null/省略采纳身份由宿主绑定；原已核对象可同文继承。未决只登记clarifications，无问题且条件充分时不要求本对象。
 */
export type SemanticResolution = QuerySemanticResolution | AdoptedSemanticResolution;

export interface ReadQueryInput {
    cursor?:  null | string;
    query_id: string;
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

export interface ProposalInput {
    base_version: string;
    entry_id:     string;
    evidence:     [EvidenceRef, ...EvidenceRef[]];
    object_id:    string;
    reason:       string;
    value:        string;
}

export interface DataToolInvocation {
    answer_handoff?: AnswerHandoff;
    arguments:       { [key: string]: unknown };
    checkpoint:      Checkpoint;
    lease_epoch:     string;
    /**
     * 宿主按实际Pi投影与同批工具共享余量分配；不参与业务身份，不属于模型工具参数。历史调用可缺省。
     */
    response_budget?: ResponseBudget;
    run_id:           string;
    sdk_tool_call_id: string;
    tool_name:        ToolName;
}

/**
 * 显式route登记时冻结的宿主事实；恢复先接原登记，不从新attempt重算。成功答案回执仍是候选，route事务提交后才成为part。
 */
export interface AnswerHandoff {
    answer_sdk_tool_call_id?: string;
    assistant?:               AssistantOutputBinding;
    /**
     * 渲染正文交接分支；与顶层assistant互斥。当前冻结route所在原assistant允许toolUse，tool_call_ids只含本次route。
     */
    rendered_answer_binding?: RenderedAnswerBinding;
}

/**
 * 宿主按实际Pi投影与同批工具共享余量分配；不参与业务身份，不属于模型工具参数。历史调用可缺省。
 */
export interface ResponseBudget {
    estimated_tokens:       number;
    max_bytes:              number;
    projection_fingerprint: string;
}

export interface DataToolOutcome {
    answer_parts?: AnswerPartReference[];
    /**
     * 成功答案的原工具登记归属，来自宿主task_id/task_condition_version；与实际sources和通知交付目标分开，不改原回执存储字节。
     */
    answer_task_ref?: EvidenceTaskRef;
    /**
     * 宿主成功回执声明需要Pi原生重投影的活动任务。省略表示无需调整。
     */
    context_reset?:    DataToolOutcomeContextResetClass | null;
    control_delivery?: ControlDelivery | null;
    data:              { [key: string]: unknown };
    /**
     *
     * 宿主按本运行原通知query/task/condition及其原scope核验全部实际冻结答案后的覆盖事实；与control_delivery共同计算，不从source_query_ids推断。只随控制状态回执更新，不授来源或SQL权限。
     */
    frozen_notification_covered?: boolean;
    operation_id:                 string;
    /**
     * 未就绪原因，由原判定同次产出；就绪时省略。旧回执可缺省，不据缺省推断已就绪，恢复时采用当前宿主事实。
     */
    source_context_blocker?: SourceContextBlocker;
    /**
     * 宿主核对本消息归属和来源声明后的正文准入状态；不由模型填写。若context_reset存在，Pi先完成既有重投影/刷新再采用新正文。
     */
    source_context_ready?: boolean;
    /**
     * 本次条件修订实际作废的未提交SQL草稿ID；宿主同事务生成，消费者撤下旧观察。缺省表示旧回执未提供该信息，不据此推定草稿有效。
     */
    superseded_query_ids?: string[];
    /**
     * 生成该结果的原tool合同版本，成功与明确拒绝均沿原登记值；历史缺失按1，Node可由已校验的原OperationReceipt补足。
     */
    tool_contract_version?: number;
    tool_name:              ToolName;
}

export interface DataToolOutcomeContextResetClass {
    condition_version: string;
    task_id:           string;
}

export interface QueryHistoryQuery {
    before_id?: string;
    q?:         string;
}

export interface QueryHistory {
    next_before_id: null | string;
    queries:        QueryHistoryItem[];
}

export interface QueryHistoryItem {
    condition_version:  string;
    confirmation_state: string;
    conversation_id:    string;
    /**
     * 查询创建时间（UTC），用于区分同名查询，不改变分页顺序。
     */
    created_at:      string;
    draft_version:   string;
    execution_state: string;
    id:              string;
    /**
     * 查询SQL原文；正文失效的查询缺省，不用于重新执行。
     */
    sql?: string;
    /**
     * 查询保存时的摘要原文；正文失效的查询仅返回控制字段，summary缺省。
     */
    summary?: string;
    task_id:  string;
    /**
     * 正文按历史记录展示：来源已改版或结果已漂移但记录仍可核；不能作为当前口径或执行依据。
     */
    text_historical?: boolean;
    /**
     * 正文来源失效或无法核实时为true；此时仅保留身份与控制状态。
     */
    text_unavailable?: boolean;
    /**
     * 该查询首次query_changed事件序号；无事件的旧记录为null，跳转定位由前端回退处理。
     */
    timeline_event_seq?: null | string;
}

export interface ConfirmQuery {
    condition_version: string;
    draft_version:     string;
    operation_id:      string;
}

export interface MutationReceipt {
    operation_id: string;
    resource_id:  string;
    state:        string;
    version:      string;
}

export interface ProposalList {
    proposals: Proposal[];
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

export interface ConversationReadInput {
    after_seq:       string;
    message_id?:     string;
    offset?:         number;
    task_after?:     string;
    task_directory?: boolean;
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

export interface ReadTaskInput {
    /**
     * 按回执next_clarification_after继续读取未决问题；省略从第一页开始。
     */
    clarification_after?: string;
    /**
     * 省略读取当前条件；指定时读取该任务真实历史快照及其依据，不授予执行权。
     */
    condition_version?: string;
    task_id:            string;
}

export interface PrefillResult {
    entries: [PrefillResultEntryClass, ...PrefillResultEntryClass[]];
}

export interface PrefillResultEntryClass {
    entry_id:          string;
    evidence:          [FluffyEvidence, ...FluffyEvidence[]];
    gaps:              string[];
    structured_value?: KnowledgeEntryQueryExampleStructureClass | null;
    value:             string;
}

export interface FluffyEvidence {
    location:  string;
    quote:     string;
    source_id: string;
    version:   string;
}

export interface HistoryQuery {
    before_id?: string;
    q?:         string;
}

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

export interface AnalysisPreferenceCommand {
    expected_version: string;
    operation_id:     string;
    preferred:        boolean;
}

export interface QueryCancellation {
    cancel_state:      string;
    condition_version: string;
    execution_state:   string;
    id:                string;
    task_id:           string;
}

export interface PiSessionReference {
    file:       string;
    kind:       PiSessionReferenceKind;
    session_id: string;
}

export interface HostCheckpointReference {
    fingerprint: string;
    kind:        HostCheckpointReferenceKind;
}

export interface ReadCheckpoint {
    lease_epoch: string;
    run_id:      string;
}

export interface MemoryExtractionRequest {
    budget:       MemoryBudgetBinding;
    message:      string;
    operation_id: string;
    owner_id:     string;
    /**
     * 修订时由宿主从本人可用的expected_version绑定的旧记忆；只作解析指代和保留未改限定的资料，当前真实指令优先。新建时省略或为null。
     */
    previous_memory?: MemoryExtractionRequestPreviousMemoryClass | null;
    quote:            string;
    space_id:         string;
}

export interface MemoryBudgetBinding {
    epoch:        string;
    id:           string;
    kind:         MemoryBudgetBindingKind;
    operation_id: string;
    /**
     * run工具绑定真实SDK调用ID；run启动检索与index作业为null，其operation/租约/用途由宿主核对。
     */
    sdk_tool_call_id: null | string;
}

export interface MemoryExtractionRequestPreviousMemoryClass {
    body:    string;
    id:      string;
    scope:   string;
    version: string;
}

export interface MemoryExtractionReceipt {
    body:         string;
    operation_id: string;
    replayed:     boolean;
}

export interface MemoryIndexRequest {
    asset:                   Asset;
    budget:                  MemoryBudgetBinding;
    extraction_operation_id: null | string;
    operation_id:            string;
    owner_id:                string;
    space_id:                string;
}

export interface MemoryIndexReceipt {
    operation_id: string;
    state:        MemoryIndexReceiptState;
}

export interface MemorySearchRequest {
    budget:       MemoryBudgetBinding;
    operation_id: string;
    owner_id:     string;
    query:        string;
    space_id:     string;
}

export interface MemorySearchReceipt {
    bounded:    boolean;
    candidates: MemoryCandidate[];
}

export interface MemoryCandidate {
    asset_id: string;
    version:  string;
}

export interface MemoryModelCall {
    action:                 MemoryModelCallAction;
    budget:                 MemoryBudgetBinding;
    call_attempt_id:        string;
    input_tokens_upper:     number;
    output_tokens_max:      number;
    parameters_fingerprint: string;
    purpose:                MemoryModelCallPurpose;
    usage:                  ModelUsage | null;
}

export interface EmbeddingProfile {
    /**
     * 可选：显式维护试用的累计调用帽；普通维护配置省略，无累计上限与期限。
     */
    call_limit?: number;
    /**
     * 可选：显式维护试用的累计费用帽；普通维护配置省略。
     */
    cost_limit_micros?: string;
    trial_id:           string;
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

export interface AssignSemanticMaintainer {
    expected_version: string;
    /**
     * 超级维护者调整独立对象负责人；null 撤销，不能调整 Datasight 表或字段。
     */
    maintainer_id: null | string;
    operation_id:  string;
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

export interface ReviewSemanticCorrection {
    decision:          Decision;
    expected_revision: string;
    operation_id:      string;
    reason:            string;
}

export interface ApplySemanticCorrection {
    expected_revision: string;
    expected_version:  string;
    operation_id:      string;
    value:             string;
}

export interface SemanticCorrectionList {
    corrections:   SemanticCorrection[];
    next_after_id: null | string;
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

export interface SemanticMemberList {
    user_ids: string[];
}

export interface PublishSkill {
    expected_version: string;
    operation_id:     string;
    share_confirmed:  boolean;
}

export interface SuggestSkill {
    content:          string;
    expected_version: string;
    operation_id:     string;
    share_confirmed:  boolean;
}

export interface ReviewSkillSuggestion {
    expected_revision: string;
    operation_id:      string;
    response:          string;
    state:             ReviewSkillSuggestionState;
}

export interface SkillSuggestionList {
    next_after_id: null | string;
    suggestions:   SkillSuggestion[];
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

export interface ConversationSkillSelections {
    change_blocked:  boolean;
    conversation_id: string;
    next_after_id:   null | string;
    selections:      ConversationSkillSelection[];
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

export interface AssetPageQuery {
    after_id?: string;
}

export interface SkillReadInput {
    limit?:  number;
    offset?: number;
    path:    string;
}

/**
 * 将同一来源的业务文档按自然章节组合阅读；parts保留原引用身份，编辑时一次提交全部章节。
 */
export interface KnowledgeDocument {
    body:     string;
    can_edit: boolean;
    parts:    [KnowledgeObject, ...KnowledgeObject[]];
    title:    string;
}

/**
 * 完整Markdown与完整片段版本集合；服务端逐一授权，正文与后台顺序同事务保存，重复操作返回原回执。
 */
export interface KnowledgeDocumentEdit {
    body:         string;
    operation_id: string;
    parts:        [KnowledgeDocumentEditPartClass, ...KnowledgeDocumentEditPartClass[]];
    related_ids?: string[];
    source_url?:  null | string;
}

export interface KnowledgeDocumentEditPartClass {
    expected_version: string;
    id:               string;
}

export interface ExecuteQueryInput {
    condition_version?: string;
    draft_version?:     string;
    instruction_quote:  string;
    /**
     * 同一用户消息明确授权的完整查询集合，一次确认；不能与单条query_id/draft_version/condition_version同时传。
     */
    queries?:  [FluffyQuery, ...FluffyQuery[]];
    query_id?: string;
}

export interface FluffyQuery {
    condition_version: string;
    draft_version:     string;
    query_id:          string;
}

export interface ModelCatalog {
    default_selection: ModelSelection | null;
    models:            ModelOption[];
    requires_model?:   boolean;
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

export interface ConversationModelSelection {
    selection: ModelSelection | null;
    version:   string;
}

export interface SaveModelSelection {
    expected_version: string;
    selection:        ModelSelection;
}

export interface SkillSelectionRemoval {
    asset_id:     string;
    operation_id: string;
    selection_id: string;
}

export interface SkillRemovalReceipt {
    asset_id:        string;
    conversation_id: string;
    operation_id:    string;
    selection_id:    string;
    state:           SkillRemovalReceiptState;
}

export interface SemanticColumnRef {
    column:    string;
    object_id: string;
    version:   string;
}

export type SemanticStructure = {
    kind: "table";
    grain: string;
    unique_keys: Array<[string, ...string[]]>;
    time_columns: FluffyTimeColumn[];
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
    join_keys: [FluffyJoinKey, ...FluffyJoinKey[]];
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
    computed_metrics?: ComputedMetric[];
    grain: string;
    dependencies: [EvidenceRef, ...EvidenceRef[]];
    verification: QueryExampleVerification | null;
};

export interface SaveAnalysisEvidenceInput {
    condition_version: string;
    data_range:        string;
    findings:          [AnalysisFinding, ...AnalysisFinding[]];
    task_id:           string;
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

export interface SaveAnalysisReportInput {
    charts:            AnalysisReportChart[];
    condition_version: string;
    evidence_ids:      [string, ...string[]];
    expected_version:  null | string;
    task_id:           string;
    title:             string;
}

export interface AnalysisReportChart {
    dimension_column: string;
    kind:             AnalysisReportChartKind;
    measure_column:   string;
    query_id:         string;
    result_ref:       string;
    title:            string;
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

export type AnalysisReportView = {
    status: "available";
    reference: AnalysisReportRef;
    report: AnalysisReport;
    chart_results: QueryResults[];
} | {
    status: "condition_changed";
    reference: AnalysisReportRef;
    report: AnalysisReport;
    chart_results: QueryResults[];
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
    source:                 string;
    /**
     * 应用对当前有权结果页计算的统计；历史客户端可省略。
     */
    statistics?: ResultStatistics;
    truncated:   boolean;
}

export interface ResultColumn {
    /**
     * 查询投影能唯一绑定已确认的字段或指标表达式时提供的列头说明。
     */
    display_label?: string;
    encoding:       string;
    name:           string;
    type:           string;
    /**
     * 从查询所选的已确认结构取得的业务单位，可独立于列头说明展示。
     */
    unit?: string;
}

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
    /**
     * 当前统计范围的最大非空值，保留原始表示。
     */
    max?: null | string;
    /**
     * 当前统计范围的最小非空值，保留原始表示。
     */
    min?:           null | string;
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

export interface AnalysisReport {
    charts:         AnalysisReportChart[];
    created_at:     string;
    evidence:       [AnalysisEvidence, ...AnalysisEvidence[]];
    reference:      AnalysisReportRef;
    schema_version: number;
    title:          string;
}

export interface AnalysisEvidence {
    conditions:        Conditions;
    data_range:        string;
    findings:          [AnalysisFinding, ...AnalysisFinding[]];
    reference:         AnalysisEvidenceRef;
    schema_version:    number;
    source_message_id: string;
    validated_sources: AnalysisEvidenceSources;
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

export interface ReadAnalysisReportInput {
    limit?:   number;
    offset?:  number;
    task_id:  string;
    version?: string;
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
} | {
    status: "historical";
    historical_analysis: FluffyHistoricalAnalysis;
    reference: AnalysisReportRef;
    content_text: string;
    content_page: ContentPage;
};

export interface FluffyHistoricalAnalysis {
    actual_sources:      { [key: string]: unknown };
    conditions:          { [key: string]: unknown }[];
    content_fingerprint: string;
    evidence:            { [key: string]: unknown }[];
    generated_at:        string;
    kind:                HistoricalAnalysisKind;
    reference:           AnalysisReportRef | null;
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

export interface SkillDraftList {
    drafts:        SkillDraft[];
    next_after_id: null | string;
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

export interface MaintenanceImpactQuery {
    after_id?:        string;
    expected_version: string;
    kind:             MaintenanceImpactKind;
}

export interface MaintenanceImpact {
    items:         MaintenanceDependent[];
    kind:          MaintenanceImpactKind;
    next_after_id: null | string;
    scope:         MaintenanceImpactScope;
    target:        FluffyMaintenanceTarget;
}

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

export interface MaintenanceReference {
    dependent_path:     string;
    reference_state:    ReferenceState;
    referenced_path:    null | string;
    referenced_version: null | string;
    relation_kind:      RelationKind;
}

export interface FluffyMaintenanceTarget {
    object_id: string;
    state:     MaintenanceDependentState;
    version:   string;
}

export interface QueryResultContent {
    content_format: ContentFormat;
    content_page:   FluffyQueryResultContentRange;
    content_text:   string;
    query_id:       string;
    result_ref:     string;
    view:           AgentQueryResultsView;
}

export interface FluffyQueryResultContentRange {
    complete:    boolean;
    next_offset: number | null;
    offset:      number;
    total_chars: number;
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

export interface QueryResultCellRead {
    column:       ResultColumn;
    column_index: number;
    query_id:     string;
    result_ref:   string;
    row_index:    number;
    value:        null | string;
    view:         QueryResultCellReadView;
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
    source?:                string;
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
    content_page?:   FluffyQueryResultContentRange;
    content_text?:   string;
}

/**
 *
 * 新格式仅记录已经采用的解释。explicit_user引用本轮完整原话，null/省略采纳身份由宿主绑定；原已核对象可同文继承。未决只登记clarifications，无问题且条件充分时不要求本对象。
 */
export interface AdoptedSemanticResolution {
    adoption_message_id?: null | string;
    basis:                SemanticResolutionBasisEnum;
    evidence_refs?:       EvidenceRef[];
    interpretation:       string;
    user_quote:           null | string;
}

export interface CurrentAnalysisUpdate {
    action: AnalysisUpdateAction;
    /**
     * 同一任务需分别回答的独立问题，各生成独立ID；与非空question互斥，不同目标分别建任务。
     */
    clarifications?: ClarificationRequest[];
    /**
     *
     * 修改已存任务条件时必填，action用revise或clarify；set指定新值，unset可省略（省略即不清空任何字段，null非法）。route禁止携带condition_patch，因为route只登记归属。
     */
    condition_patch?: FluffyConditionPatch;
    /**
     * 新建任务必须完整给出；未指定的可空标量用JSON null，列表用[]，notes用空字符串，timezone按宿主业务时区。
     */
    conditions?: FluffyConditions;
    /**
     * 新建任务省略此字段（也接受JSON null）；已有任务必须提供工具回执中的当前版本数字字符串。
     */
    expected_version?: null | string;
    /**
     *
     * 仅route可用：显式定稿当前任务已完成的说明或查询答案；可route到同一任务保留其SQL等待状态，也可切到其他目标。该助手消息只允许这个route；宿主绑定完整正文或原成功答案回执。普通route不定稿，不授执行权。
     */
    finalize_current_answer?:     boolean;
    goal?:                        string;
    legacy_resolution_migration?: LegacyResolutionMigration;
    /**
     * split迁移到新独立目标的原开放问题ID，保留问题正文与来源，其余原目标问题不动。
     */
    moved_clarification_ids?: string[];
    /**
     * 澄清问题的候选答案；仅与实际question同用，开放回答可无候选（空数组或省略）。
     */
    options?: string[];
    /**
     * 需要用户补充的实际问题；无需澄清时省略（也接受JSON null），不能填字符串null、空文本或用户原问题。
     */
    question?:          null | string;
    replaces_query_id?: null | string;
    /**
     *
     * 本消息中用户已真实回答，或当前有效且获准资料已唯一解决的事实问题ID；事实解决须在同次revise保存条件与依据，不能伪称用户选择。省略或[]保留其他问题，仅已有任务revise/clarify可用。
     */
    resolved_clarification_ids?: string[];
    /**
     * 新建任务省略此字段（也接受JSON null）；已有任务用工具回执中的真实ID，不能填字符串null。
     */
    task_id?: null | string;
}

/**
 *
 * 修改已存任务条件时必填，action用revise或clarify；set指定新值，unset可省略（省略即不清空任何字段，null非法）。route禁止携带condition_patch，因为route只登记归属。
 */
export interface FluffyConditionPatch {
    set: TentacledConditionSet;
    /**
     * 清除指定条件字段。省略即空集合（不清空任何字段），null非法；显式数组仍清除列出的字段。
     */
    unset?: Unset[];
}

export interface TentacledConditionSet {
    channel?:        ConditionsChannel;
    filters?:        string[];
    group_by?:       string[];
    knowledge_refs?: EvidenceRef[];
    metric?:         string;
    notes?:          string;
    /**
     * 只更新已采用解释及来源；null/unset只清说明，不解决开放问题。旧未决通过明确legacy_resolution_migration转换。
     */
    semantic_resolution?: TentacledSemanticResolution | null;
    /**
     * 设置来源限制；撤销使用unset source_limits，不接受设为空集。
     */
    source_limits?: SourceLimits;
    /**
     * 修改区间的不包含终点，按业务时区解析后填写UTC完整时间戳，以Z结尾；整月结束为下一月起点。清空使用unset；未修改则省略。
     */
    time_end?: string;
    /**
     * 整体替换时间口径角色；清空使用unset。
     */
    time_roles?: [TimeRole, ...TimeRole[]];
    /**
     * 修改区间的包含起点，按业务时区解析后填写UTC完整时间戳，以Z结尾。清空使用unset；未修改则省略。
     */
    time_start?: string;
    timezone?:   string;
}

/**
 *
 * 新格式仅记录已经采用的解释。explicit_user引用本轮完整原话，null/省略采纳身份由宿主绑定；原已核对象可同文继承。未决只登记clarifications，无问题且条件充分时不要求本对象。
 */
export interface TentacledSemanticResolution {
    /**
     *
     * explicit_user：null=本轮新采纳，由宿主核对user_quote为本轮完整原话后绑定真实消息身份；非空=复制继承原已验证决策的消息身份，不接受模型自由填写。其余basis为null。
     */
    adoption_message_id?: null | string;
    /**
     * 真实用户明确选择、确无实质歧义、或仍需澄清；资料支持某公式不等于用户选择它。
     */
    basis: SemanticResolutionBasisEnum;
    /**
     * 支撑该口径决策的依据引用；旧调用缺失按空数组解码。
     */
    evidence_refs?: EvidenceRef[];
    /**
     * 本稿采用的指标、分子/分母、时间等关键口径及选择依据；不能把自己刚写入任务的假设当作用户采用。
     */
    interpretation: string;
    /**
     * explicit_user逐字填写本条真实用户完整原话，保留否定、前提、例外和换行，不截取子串；其余为null。
     */
    user_quote: null | string;
}

/**
 * 新建任务必须完整给出；未指定的可空标量用JSON null，列表用[]，notes用空字符串，timezone按宿主业务时区。
 */
export interface FluffyConditions {
    channel:        ConditionsChannel | null;
    filters:        string[];
    group_by:       string[];
    knowledge_refs: EvidenceRef[];
    metric:         null | string;
    notes:          string;
    /**
     * 当前格式仅记录已采用解释及依据，未决由clarifications表达；省略继承，null只清说明，未要求所有任务填写。旧形状按宿主持久格式标记兼容，读取不迁移。
     */
    semantic_resolution?: StickySemanticResolution | null;
    /**
     * null表示本题显式未声明额外来源限制；字段缺失表示旧条件版本未记录新式限制，不能证明用户从未限制。撤销必须显式unset并来自真实用户修改。
     */
    source_limits?: SourceLimits | null;
    /**
     * 时间区间的不包含终点。按明确的业务时区解析后转为UTC完整时间戳，以Z结尾；整月结束为下一月起点，不能写本月最后一天。未指定时为null。
     */
    time_end: null | string;
    /**
     * 时间口径角色；统计起止仍沿time_start/time_end，request_clock和平台data_freshness不冒充用户截点。字段缺失表示旧版本未记录。
     */
    time_roles?: TimeRole[];
    /**
     * 时间区间的包含起点。按明确的业务时区解析后转为UTC完整时间戳，以Z结尾；不能只写日期。未指定时为null。
     */
    time_start: null | string;
    timezone:   string;
}

/**
 *
 * 新格式仅记录已经采用的解释。explicit_user引用本轮完整原话，null/省略采纳身份由宿主绑定；原已核对象可同文继承。未决只登记clarifications，无问题且条件充分时不要求本对象。
 */
export interface StickySemanticResolution {
    /**
     *
     * explicit_user：null=本轮新采纳，由宿主核对user_quote为本轮完整原话后绑定真实消息身份；非空=复制继承原已验证决策的消息身份，不接受模型自由填写。其余basis为null。
     */
    adoption_message_id?: null | string;
    /**
     * 真实用户明确选择、确无实质歧义、或仍需澄清；资料支持某公式不等于用户选择它。
     */
    basis: SemanticResolutionBasisEnum;
    /**
     * 支撑该口径决策的依据引用；旧调用缺失按空数组解码。
     */
    evidence_refs?: EvidenceRef[];
    /**
     * 本稿采用的指标、分子/分母、时间等关键口径及选择依据；不能把自己刚写入任务的假设当作用户采用。
     */
    interpretation: string;
    /**
     * explicit_user逐字填写本条真实用户完整原话，保留否定、前提、例外和换行，不截取子串；其余为null。
     */
    user_quote: null | string;
}

export interface CurrentRequestQueryInput {
    condition_version:  string;
    knowledge_refs:     EvidenceRef[];
    parameters:         { [key: string]: unknown };
    replaces_query_id?: null | string;
    /**
     * 省略继承目标条件版本已有采纳说明；兼容携带只核同义声明，不能独立另作决定。新任务未决定时登记clarifications，改变解释先同次修订条件。旧形状仅沿旧格式兼容。
     */
    semantic_resolution?: IndecentSemanticResolution;
    sql:                  string;
    summary:              string;
    target_id:            TargetID;
    task_id:              string;
}

/**
 * 旧未决形状与新采纳说明仅在兼容边界解码；实际条件格式由宿主decision_state_version决定。
 *
 * 省略继承目标条件版本已有采纳说明；兼容携带只核同义声明，不能独立另作决定。新任务未决定时登记clarifications，改变解释先同次修订条件。旧形状仅沿旧格式兼容。
 *
 *
 * 新格式仅记录已经采用的解释。explicit_user引用本轮完整原话，null/省略采纳身份由宿主绑定；原已核对象可同文继承。未决只登记clarifications，无问题且条件充分时不要求本对象。
 */
export interface IndecentSemanticResolution {
    /**
     *
     * explicit_user：null=本轮新采纳，由宿主核对user_quote为本轮完整原话后绑定真实消息身份；非空=复制继承原已验证决策的消息身份，不接受模型自由填写。其余basis为null。
     */
    adoption_message_id?: null | string;
    /**
     * 真实用户明确选择、确无实质歧义、或仍需澄清；资料支持某公式不等于用户选择它。
     */
    basis: SemanticResolutionBasisEnum;
    /**
     * 支撑该口径决策的依据引用；旧调用缺失按空数组解码。
     */
    evidence_refs?: EvidenceRef[];
    /**
     * 本稿采用的指标、分子/分母、时间等关键口径及选择依据；不能把自己刚写入任务的假设当作用户采用。
     */
    interpretation: string;
    /**
     * explicit_user逐字填写本条真实用户完整原话，保留否定、前提、例外和换行，不截取子串；其余为null。
     */
    user_quote: null | string;
}

export interface QuerySemanticResolution {
    /**
     *
     * explicit_user：null=本轮新采纳，由宿主核对user_quote为本轮完整原话后绑定真实消息身份；非空=复制继承原已验证决策的消息身份，不接受模型自由填写。其余basis为null。
     */
    adoption_message_id?: null | string;
    /**
     * 真实用户明确选择、确无实质歧义、或仍需澄清；资料支持某公式不等于用户选择它。
     */
    basis: SemanticResolutionBasis;
    /**
     * 支撑该口径决策的依据引用；旧调用缺失按空数组解码。
     */
    evidence_refs?: EvidenceRef[];
    /**
     * 本稿采用的指标、分子/分母、时间等关键口径及选择依据；不能把自己刚写入任务的假设当作用户采用。
     */
    interpretation: string;
    /**
     * 仍会改变答案且未获选择的分子、分母、时间归属等差异；有差异必须先澄清，不能默认写稿。
     */
    unresolved_differences: string[];
    /**
     * explicit_user逐字填写本条真实用户完整原话，保留否定、前提、例外和换行，不截取子串；其余为null。
     */
    user_quote: null | string;
}

export interface SaveModelService {
    api:              API;
    api_key?:         string;
    base_url:         string;
    enabled:          boolean;
    expected_version: string;
    id:               string;
    name:             string;
    provider_id:      ProviderID;
}

export interface SaveModelDefinition {
    anthropic_thinking_mode?: AnthropicThinkingMode;
    /**
     * 窗口能力来源：SDK目录或管理员声明；目录外型号不猜窗口。
     */
    capability_source: CapabilitySource;
    /**
     * 总上下文tokens；与输入/输出策略分开表达。
     */
    context_window:      number;
    default_thinking:    ThinkingLevel;
    enabled:             boolean;
    expected_version:    string;
    id:                  string;
    input_limit:         number;
    input_rate:          string;
    label:               string;
    model_id:            string;
    output_limit:        number;
    output_rate:         string;
    payload_bytes_limit: number;
    reasoning_supported: boolean;
    /**
     * 单次provider请求超时毫秒，随模型修订冻结；历史缺字段按90000处理。
     */
    request_timeout_ms: number;
    service_id:         string;
    thinking_levels:    [ThinkingLevel, ...ThinkingLevel[]];
}

export interface ModelConfigurationAccess {
    can_manage_models: boolean;
}

export interface ModelConfiguration {
    default_model_id: null | string;
    models:           ModelDefinition[];
    services:         ModelService[];
    version:          string;
}

export interface ModelDefinition {
    anthropic_thinking_mode?: AnthropicThinkingMode;
    /**
     * 窗口能力来源：SDK目录或管理员声明；目录外型号不猜窗口。
     */
    capability_source?: CapabilitySource;
    /**
     * 总上下文tokens；与输入/输出策略分开表达。
     */
    context_window?:     number;
    default_thinking:    ThinkingLevel;
    enabled:             boolean;
    id:                  string;
    input_limit:         number;
    input_rate:          string;
    label:               string;
    model_id:            string;
    output_limit:        number;
    output_rate:         string;
    payload_bytes_limit: number;
    reasoning_supported: boolean;
    /**
     * 单次provider请求超时毫秒，随模型修订冻结；历史缺字段按90000处理。
     */
    request_timeout_ms?: number;
    service_id:          string;
    thinking_levels:     [ThinkingLevel, ...ThinkingLevel[]];
    version:             string;
}

export interface ModelService {
    api:                   API;
    base_url:              string;
    credential_configured: boolean;
    enabled:               boolean;
    id:                    string;
    name:                  string;
    provider_id:           ProviderID;
    version:               string;
}

export interface SaveDefaultModel {
    expected_version: string;
    model_id:         string;
}

export interface ReadModelConnection {
    lease_epoch: string;
    run_id:      string;
}

export interface ModelConnection {
    api:              API;
    api_key:          string;
    base_url:         string;
    provider_id:      string;
    runtime_provider: string;
}

export interface PresentAnalysisAnswerInput {
    sources: [AnalysisAnswerSource, ...AnalysisAnswerSource[]];
    /**
     * 解释模板，定量结果用{{name}}引用values；正常语义数字（如零分母说明、年份、编号）可以直写，SQL代码块仍不放模板。定性解释必须有依据，不写未经证实的因果。
     */
    template: string;
    values:   AnalysisAnswerValue[];
}

export interface AnalysisAnswerSource {
    columns:    [string, ...string[]];
    query_id:   string;
    result_ref: string;
}

export interface AnalysisAnswerValue {
    column?: string;
    /**
     * observation_cutoff/data_batch在同名角色多条时按field_ref对齐声明；缺省要求该角色唯一。
     */
    field_ref?: string;
    /**
     *
     * 展示格式：缺省或raw为原值；decimal为固定小数位；percent只对单个ratio乘100加百分号。decimal/percent必须给precision，raw不接受precision。展示字符串不写回查询结果。
     */
    format?: FluffyFormat;
    /**
     * observation_cutoff/data_batch绑定草稿时间基准中用户声明的角色值；未声明时不可绑定。
     */
    kind:       AnalysisAnswerValueKind;
    metadata?:  Metadata;
    name:       string;
    parameter?: string;
    query_id:   string;
    row_index?: number;
    statistic?: Statistic;
}

/**
 *
 * 展示格式：缺省或raw为原值；decimal为固定小数位；percent只对单个ratio乘100加百分号。decimal/percent必须给precision，raw不接受precision。展示字符串不写回查询结果。
 */
export interface FluffyFormat {
    precision?: number;
    style:      Style;
}

/**
 * 准备数值绑定：不接收template、不返回完整answer_text；成功回执提供bindings与required_suffix，正文由Pi下一次自然生成。
 */
export interface PrepareAnalysisAnswerInput {
    sources: [AnalysisAnswerSource, ...AnalysisAnswerSource[]];
    values:  AnalysisAnswerValue[];
}

export interface SourceSyncAccepted {
    status:     SourceSyncAcceptedStatus;
    status_url: string;
    sync_id:    string;
}

export interface SourceSyncProgress {
    error_code: null | string;
    /**
     * 已持久化的可展示失败说明，例如来源的实际大小和上限；旧批次可缺省。
     */
    error_message?:    null | string;
    knowledge_index:   SourceWorkProgress;
    pages_committed:   number;
    preparation:       SourceWorkProgress;
    processed_sources: number;
    raw_index:         SourceWorkProgress;
    status:            SourceSyncAcceptedStatus;
    status_url:        string;
    sync_id:           string;
}

export interface SourceWorkProgress {
    completed: number;
    failed:    number;
    status:    SourceWorkProgressStatus;
    total:     number;
}

export interface SourceExcerpt {
    citation: SourceCitation;
    content:  string;
}

export interface SourcePreparationResult {
    relations:       PreparedRelation[];
    semantic_status: SourcePreparationResultSemanticStatus;
    statements:      PreparedStatement[];
    unresolved:      string[];
}

export interface PreparedRelation {
    citations:  [SourceCitation, ...SourceCitation[]];
    key:        string;
    predicate:  Predicate;
    scope_text: string;
    subject:    EvidenceRef;
    target:     SemanticReference;
}

export interface PreparedStatement {
    citations:  [SourceCitation, ...SourceCitation[]];
    key:        string;
    scope_text: string;
    supports:   PreparedSupport[];
    /**
     * 对该陈述已记录必要支持提取范围的明确声明；省略或null保留unknown，semantic_status不代替此字段。
     */
    supports_complete?: boolean | null;
    target:             EvidenceRef;
    text:               string;
}

export interface RefreshRunContext {
    checkpoint:       Checkpoint;
    lease_epoch:      string;
    run_id:           string;
    sdk_tool_call_id: string;
}

export interface KnowledgeBatchEdit {
    objects:      [KnowledgeEditGroup, ...KnowledgeEditGroup[]];
    operation_id: string;
}

export interface KnowledgeEditGroup {
    /**
     * 同一对象内按序应用的条目修改；任一条目校验失败则整批回滚。
     */
    edits: [KnowledgeEntryEdit, ...KnowledgeEntryEdit[]];
    /**
     * 暂存这些条目时读到的对象版本。
     */
    expected_version: string;
    object_id:        string;
}

export interface KnowledgeBatchReceipt {
    objects: KnowledgeObject[];
}

export interface WorkbenchUpdate {
    query_list?: QueryList;
    runs?:       RunSnapshot[];
    tasks?:      TaskSnapshot[];
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
    error_details?:     QueryViewErrorDetailsClass | null;
    execution_state:    string;
    id:                 string;
    knowledge_refs?:    EvidenceRef[];
    parameters?:        { [key: string]: unknown };
    replaces_query_id?: null | string;
    result_ref:         null | string;
    /**
     * 草稿工具回执的非阻断诊断；查询读取接口不承诺重现此报告。
     */
    semantic_checks?: SemanticCheckReport;
    /**
     * 保存草稿时的口径决策及依据；旧记录返回null，不从自由文本或模型历史猜回填。
     */
    semantic_resolution?: ConditionsQuerySemanticResolution | null;
    sql?:                 string;
    summary?:             string;
    target_id:            string;
    task_id:              string;
    /**
     * 正文按历史记录展示：来源已改版或结果已漂移，但记录仍可核。SQL、参数与说明保留原样，不能作为当前口径或执行依据；需要当前数据须重新确认。
     */
    text_historical?: boolean;
    /**
     * 正文来源失效或无法核实时只返回查询身份和控制状态；SQL、参数、说明、依据及诊断正文均不可返回。
     */
    text_unavailable?: boolean;
    /**
     * 保存草稿时任务条件声明的时间基准；旧草稿返回null。观察截点与批次是用户声明，不得以request_clock或平台data_freshness冒充。
     */
    time_basis?: TimeBasis | null;
    /**
     * 原查询首次query_changed事件的持久序号，作为对话时间线中查询卡的稳定锚点；旧记录无对应事件时为null，旧Schema解码兼容可缺省，前端已有值不被后续有限事件页覆盖。
     */
    timeline_event_seq?: null | string;
}

export interface QueryViewErrorDetailsClass {
    code:    string;
    message: string;
}

/**
 * 草稿工具回执的非阻断诊断；查询读取接口不承诺重现此报告。
 */
export interface SemanticCheckReport {
    checks:   FluffyCheck[];
    coverage: FluffyCoverage;
}

export interface FluffyCheck {
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

export interface FluffyCoverage {
    missing_semantics:      string[];
    sql_shape:              SQLShape;
    supported_scope:        string[];
    unsupported_constructs: string[];
}

/**
 * 草稿保存时从任务当前条件投影的时间基准；统计起止沿time_start/time_end，观察截点/批次只在time_roles中声明。
 */
export interface TimeBasis {
    time_end:   null | string;
    time_roles: TimeRole[];
    time_start: null | string;
    timezone:   null | string;
}


export type AuthoritySnapshot = NonNullable<Checkpoint["authority_snapshot"]>;

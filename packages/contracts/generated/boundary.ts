// Generated from packages/contracts/schema.json; do not edit.
export interface Boundary {
    AnalysisPreferenceCommand?: AnalysisPreferenceCommand;
    analysisUpdate:             AnalysisUpdate;
    appendOutput:               AppendOutput;
    appError:                   AppError;
    asset:                      Asset;
    assetList:                  AssetList;
    assetSave:                  AssetSave;
    assetToolInput:             AssetToolInput;
    cancelReceipt:              CancelReceipt;
    cancelRun:                  CancelRun;
    CatalogColumn?:             CatalogColumn;
    CatalogNode?:               CatalogNode;
    CatalogPage?:               CatalogPage;
    CatalogTable?:              CatalogTable;
    chatMessage:                ChatMessage;
    checkpoint:                 Checkpoint;
    checkpoint_reference:       CheckpointReference;
    conditions:                 Conditions;
    confirmQuery:               ConfirmQuery;
    conversationReadInput:      ConversationReadInput;
    conversationReceipt:        ConversationReceipt;
    createConversation:         CreateConversation;
    dataToolInvocation:         DataToolInvocation;
    dataToolOutcome:            DataToolOutcome;
    embeddingProfile:           EmbeddingProfile;
    event:                      Event;
    evidenceRef:                EvidenceRef;
    finalizeModelCall:          FinalizeModelCall;
    finishReceipt:              FinishReceipt;
    finishRun:                  FinishRun;
    history:                    History;
    historyItem:                HistoryItem;
    historyQuery:               HistoryQuery;
    host_checkpoint_reference:  HostCheckpointReference;
    identity:                   Identity;
    knowledgeCreate:            KnowledgeCreate;
    knowledgeEdit:              KnowledgeEdit;
    knowledgeEntry:             KnowledgeEntry;
    knowledgeList:              KnowledgeList;
    knowledgeListQuery:         KnowledgeListQuery;
    knowledgeObject:            KnowledgeObject;
    logoutReceipt:              LogoutReceipt;
    memoryBudgetBinding?:       MemoryBudgetBinding;
    memoryCandidate?:           MemoryCandidate;
    memoryExtractionReceipt?:   MemoryExtractionReceipt;
    memoryExtractionRequest?:   MemoryExtractionRequest;
    memoryIndexReceipt?:        MemoryIndexReceipt;
    memoryIndexRequest?:        MemoryIndexRequest;
    memoryModelCall?:           MemoryModelCall;
    memorySearchReceipt?:       MemorySearchReceipt;
    memorySearchRequest?:       MemorySearchRequest;
    messageInput:               MessageInput;
    messageReceipt:             MessageReceipt;
    modelAttempt:               ModelAttempt;
    modelCallReceipt:           ModelCallReceipt;
    modelProfile:               ModelProfile;
    modelReceipt:               ModelReceipt;
    modelUsage:                 ModelUsage;
    mutationReceipt:            MutationReceipt;
    operationReceipt:           OperationReceipt;
    outputReceipt:              OutputReceipt;
    pi_session_reference:       PiSessionReference;
    prefillResult:              PrefillResult;
    proposal:                   Proposal;
    proposalInput:              ProposalInput;
    proposalList:               ProposalList;
    queryCancellation?:         QueryCancellation;
    queryList:                  QueryList;
    queryResults:               QueryResults;
    queryView:                  QueryView;
    read_checkpoint:            ReadCheckpoint;
    readKnowledgeInput:         ReadKnowledgeInput;
    readQueryInput:             ReadQueryInput;
    readSourceInput:            ReadSourceInput;
    readTaskInput?:             ReadTaskInput;
    requestQueryInput:          RequestQueryInput;
    reserveModelCall:           ReserveModelCall;
    resultColumn:               ResultColumn;
    runEnvelope:                RunEnvelope;
    runSnapshot:                RunSnapshot;
    searchInput:                SearchInput;
    sendModelCall:              SendModelCall;
    sessionReceipt:             SessionReceipt;
    skillSelection:             SkillSelection;
    snapshot:                   Snapshot;
    sourceDocument:             SourceDocument;
    sqlInput:                   SQLInput;
    TableAnalysisPreference?:   TableAnalysisPreference;
    taskInput:                  TaskInput;
    taskSnapshot:               TaskSnapshot;
    toolInvocation:             ToolInvocation;
    toolOutcome:                ToolOutcome;
    toolReceipt:                ToolReceipt;
    versionCommand:             VersionCommand;
    workspaceContext:           WorkspaceContext;
}

export interface AnalysisPreferenceCommand {
    expected_version: string;
    operation_id:     string;
    preferred:        boolean;
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
    columns:          [CatalogColumn, ...CatalogColumn[]];
    comment:          string;
    ddl:              string;
    id:               string;
    name:             string;
    node:             CatalogNode | null;
    platform_version: string;
}

export interface TableAnalysisPreference {
    preferred: boolean;
    table_id:  string;
    version:   string;
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
    channel?:        Channel;
    filters?:        string[];
    group_by?:       string[];
    knowledge_refs?: EvidenceRef[];
    metric?:         string;
    notes?:          string;
    time_end?:       string;
    time_start?:     string;
    timezone?:       string;
}

export type Channel = "web" | "app" | "store";

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

export type Unset = "time_start" | "time_end" | "metric" | "channel" | "group_by" | "filters" | "knowledge_refs" | "notes";

/**
 * 新建任务必须完整给出；未指定的可空标量用JSON null，列表用[]，notes用空字符串，timezone按宿主业务时区。
 */
export interface Conditions {
    channel:        Channel | null;
    filters:        string[];
    group_by:       string[];
    knowledge_refs: EvidenceRef[];
    metric:         null | string;
    notes:          string;
    time_end:       null | string;
    time_start:     null | string;
    timezone:       string;
}

export interface AppError {
    code:       Code;
    message:    string;
    request_id: string;
    retryable:  boolean;
}

export type Code = "budget_exhausted" | "chunk_gap" | "forbidden" | "idempotency_conflict" | "input_already_applied" | "invalid_evidence" | "invalid_input" | "lease_lost" | "message_pending" | "not_available" | "outcome_unknown" | "result_unavailable" | "scope_incomplete" | "selection_required" | "source_unavailable" | "stale_context" | "stale_knowledge" | "unauthenticated" | "unavailable" | "unsupported" | "version_conflict" | "memory_unavailable" | "memory_extraction_empty" | "memory_operation_unknown" | "vector_unconfigured" | "vector_unavailable" | "embedding_unavailable" | "source_interrupted";

export interface AppendOutput {
    chunk_seq:   string;
    lease_epoch: string;
    run_id:      string;
    text:        string;
}

export interface Asset {
    body:                string;
    dependencies:        EvidenceRef[];
    id:                  string;
    kind:                AssetKind;
    memory_index_state?: MemoryIndexState;
    name:                string;
    scope:               string;
    selected:            boolean;
    source_text:         string;
    state:               AssetState;
    verified:            boolean;
    version:             string;
}

export type AssetKind = "memory" | "skill";

export type MemoryIndexState = "queued" | "issued" | "indexed" | "failed" | "superseded";

export type AssetState = "enabled" | "disabled" | "deleted";

export interface AssetList {
    assets: Asset[];
}

export interface AssetSave {
    body:             string;
    dependencies:     EvidenceRef[];
    expected_version: null | string;
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

export type SDKVersion = "1.0.0";

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

export type ToolName = "search_knowledge" | "read_knowledge" | "read_source" | "validate_sql" | "request_query" | "update_analysis_task" | "get_query" | "cancel_query" | "manage_personal_asset" | "propose_semantic_change" | "read_conversation" | "read_analysis_task";

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

export type EventType = "message" | "assistant_delta" | "assistant_committed" | "assistant_replaced" | "tool_result" | "run_failed" | "run_cancelled" | "query_changed" | "query_result" | "memory_saved" | "task_changed" | "conversation_deleted" | "message_withdrawn" | "task_cancelled" | "memory_disabled";

export interface FinalizeModelCall {
    call_attempt_id:        string;
    lease_epoch:            string;
    parameters_fingerprint: string;
    run_id:                 string;
    usage:                  ModelUsage | null;
}

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
    id:    string;
    title: string;
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
    user_id:     string;
}

export type ModelLabel = "本地模拟模型" | "DeepSeek Flash" | "DeepSeek V4 Pro";

export interface KnowledgeCreate {
    body:         string;
    kind:         KnowledgeCreateKind;
    name:         string;
    operation_id: string;
    related_ids:  string[];
    source_url?:  null | string;
}

export type KnowledgeCreateKind = "table" | "field" | "metric" | "document" | "relationship" | "term";

export interface KnowledgeEdit {
    clear_override?:  boolean;
    entry_id:         string;
    expected_version: string;
    operation_id:     string;
    related_ids?:     string[];
    source_url?:      null | string;
    value:            string;
}

export interface KnowledgeEntry {
    effective_value: string;
    entry_id:        string;
    human_override:  { [key: string]: unknown } | null;
    label:           string;
    path:            string;
    review_state:    ReviewState;
    source_facts:    { [key: string]: unknown };
    suggestion:      { [key: string]: unknown };
}

export type ReviewState = "unverified" | "confirmed" | "needs_review";

export interface KnowledgeList {
    next_after_id:    null | string;
    objects:          KnowledgeObject[];
    retrieval_mode:   string;
    search_coverage?: SearchCoverage | null;
}

export interface KnowledgeObject {
    analysis_preference?: TableAnalysisPreference;
    entries:              KnowledgeEntry[];
    id:                   string;
    kind:                 KnowledgeCreateKind;
    name:                 string;
    prefill_status?:      PrefillStatus | null;
    related_ids:          string[];
    source_id:            null | string;
    source_version:       string;
    state:                AssetState;
    /**
     * 平台移除与人工停用分开；重新出现只能恢复平台导致的停用。
     */
    state_origin?: StateOrigin;
    updated_by:    string;
    version:       string;
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

export interface SearchCoverage {
    candidate_limit: number;
    index_state?:    IndexState;
    state:           SearchCoverageState;
    vector_state?:   VectorState;
}

export type IndexState = "current" | "incomplete" | "unconfigured";

export type SearchCoverageState = "complete" | "candidate_limit" | "bounded";

export type VectorState = "available" | "unconfigured" | "unavailable";

export interface KnowledgeListQuery {
    after_id?:   string;
    q?:          string;
    related_id?: string;
}

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

export interface ModelProfile {
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
    thinking_level?:   ThinkingLevel;
    toolset?:          Toolset;
    trial_call_limit:  number;
    trial_cost_micros: string;
    trial_id:          string;
}

export type ProviderID = "deepseek";

/**
 * 通过Pi/DeepSeek原生思考模式；省略为off。思考tokens计入同一输出上限与用量。
 */
export type ThinkingLevel = "off" | "low" | "high";

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
    entry_id: string;
    evidence: [Evidence, ...Evidence[]];
    gaps:     string[];
    value:    string;
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
    sql:                string;
    summary:            string;
    target_id:          string;
    task_id:            string;
}

export interface ErrorDetails {
    code:    string;
    message: string;
}

export interface QueryResults {
    columns:         ResultColumn[];
    data_freshness:  string;
    fetched_offset:  string;
    next_cursor:     null | string;
    query_id:        string;
    result_complete: boolean;
    result_ref:      string;
    rows:            Array<Array<null | string>>;
    source:          Source;
    truncated:       boolean;
}

export interface ResultColumn {
    encoding: string;
    name:     string;
    type:     string;
}

export type Source = "mock";

export interface ReadKnowledgeInput {
    entry_id?: string;
    limit?:    number;
    object_id: string;
    offset?:   number;
    version?:  null | string;
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
    task_id: string;
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
    tasks:              { [key: string]: unknown }[];
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
    scope:         string;
    scope_page?:   ContentPage;
    selected:      boolean;
    source_text:   string;
    state:         AssetState;
    verified:      boolean;
    version:       string;
}

export interface ContentPage {
    complete:    boolean;
    next_offset: number | null;
    offset:      number;
    total_chars: number;
}

export type MemoryRetrieval = "mem0_authoritative" | "directory_fallback";

export interface RunSnapshot {
    lease_epoch: string;
    run_id:      string;
    state:       RunSnapshotState;
}

export type RunSnapshotState = "running" | "interrupted" | "finished" | "failed" | "cancelled";

export interface SearchInput {
    asset_after?: string;
    limit?:       number;
    query:        string;
}

export interface SendModelCall {
    call_attempt_id:        string;
    lease_epoch:            string;
    parameters_fingerprint: string;
    run_id:                 string;
}

export interface SessionReceipt {
    model_label: ModelLabel;
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
    goal:              string;
    id:                string;
    lifecycle?:        string;
    phase?:            string;
}

export interface SourceDocument {
    body:            string;
    complete:        boolean;
    current_version: string;
    source_id:       string;
    version:         string;
}

export interface SQLInput {
    parameters: { [key: string]: unknown };
    sql:        string;
    target_id:  TargetID;
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


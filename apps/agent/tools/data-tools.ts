import { createHash } from "node:crypto";
import { nativeSkillRead, formatSkillRead } from "./read-skill.ts";
import { Type, type TSchema } from "typebox";
import type {
  ToolDefinition,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AnswerHandoff, AnswerPartReference, AssistantOutputBinding, DataToolOutcome, EvidenceTaskRef, OperationReceipt, RenderedAnswerBinding, SkillReadInput } from "../../../packages/contracts/generated/boundary.ts";
import schema from "../../../packages/contracts/schema.json" with { type: "json" };
import {
  validateContract,
  decodeContract,
} from "../../../packages/contracts/validate.ts";
import { exportCheckpoint } from "../session/checkpoint.ts";
import { RustTransport } from "../transport/client.ts";

const definitions = {
  read: ["SkillReadInput", "按需读本会话已选有效Skill及配套文本；path用目录的/skills完整路径，offset/limit按行，建议limit=200；不读主机文件。"],
  validate_sql: [
    "SQLInput",
    "检查完整SQL和参数是否符合只读SQLite目标；不执行查询。knowledge_refs传已读取的当前语义依据，semantic_checks分别列出业务风险和未检查范围；平台passed只表示语法/只读通过，不能当作口径正确。复杂SQL由你继续查证、修订或澄清，不把检查器当规划器。",
  ],
  execute_query: [
    "ExecuteQueryInput",
    "仅提交明确授权SQL，instruction_quote逐字保留当前完整原话（否定/限定/换行/粘贴）。按宿主完成来源准入，就绪后get_query核稿。单条给query_id/draft_version/condition_version，多条queries给本消息授权全集，不混形状/逐一route。整批同事务核验，拒绝不新增确认/关联/授权，既有route保持；已确认只接原状态，其他待处理消息可阻塞。版本/澄清/授权沿系统规则，重放不重执行/转预算，明确重跑先建新查询。",
  ],
  get_query: [
    "GetQueryInput",
    "只读SQL/状态/结果，不重跑。rows按字节分页、next_cursor续读，statistics只统计返回行；view=statistics读cursor起的平台页统计，cell以绝对row_index/column_index读单元格且不带cursor。historical_analysis的content_text仅保存时SQL/参数/条件，不授权执行。content_format=json或有content_page则正文仅片段，保持查询/view/行列/游标，以next_offset续content_offset读齐JSON，不当完整值/NULL；distinct_count按平台返回的原始文本去重，不含NULL，跨页计数不可相加。统计仅覆盖实际读取范围。本消息刚确认的查询只返状态，结束本轮等自动交付，不轮询。",
  ],
  cancel_query: [
    "ReadQueryInput",
    "请求取消指定查询，返回ID/任务/条件版本/执行和取消状态；请求非平台已取消。",
  ],
  save_analysis_evidence: [
    "SaveAnalysisEvidenceInput",
    "按真实task_id/condition_version存结论/依据，可用有效历史条件。findings含结论、计算、限制、资料/query_refs；figures绑query_id/列/整个保存结果从0起的row_index/精确value，金额用字符串。查询须属依据原任务/条件且成功，result_ref真实；get_query补页，空/部分结果标limitations/data_range。宿主只核引用/数值，不证因果；新查询逐条聊天授权。回执给evidence_id/已核依赖。",
  ],
  save_analysis_report: [
    "SaveAnalysisReportInput",
    "将本人同会话有效evidence_ids组装为当前任务/条件报告。来源可跨任务/条件，保原身份；任一失效则整份隐藏，改结论先存新依据。expected_version首次null、修订用report_ref.version。charts绑成功查询result_ref/唯一列名；measure_column非空值为保精度的规范十进制文本，空/全NULL示暂无数据。line按dimension_column经SQL排序且维度唯一非空，bar维度也唯一。用完整保存的聚合结果，超限注明，部分明细不当全量。标题简洁，不复制聊天/SQL/完整结果；只返引用，展示/执行沿系统边界。",
  ],
  read_analysis_report: [
    "ReadAnalysisReportInput",
    "读本人当前任务报告，用户要求更新已有报告时先读原版本。来源规则同HTTP。首次task_id即可；title/evidence_ids/charts为实际选择，局部修改保留其余，用reference.version作save_analysis_report.expected_version。content_text为精确报告JSON字符页，以content_page.next_offset、同reference.version读齐；修订后旧版续读拒绝，须offset=0重读。historical含保存时正文/原条件，只复述历史，不作当前口径/新执行依据；sources_unavailable不交正文。报告不授SQL执行权。",
  ],
  manage_personal_asset: [
    "AssetToolInput",
    "先检索本人记忆，save_memory新增、update_memory按asset_id/expected_version修原条、disable_memory按ID/版本停用；替代偏好不添冲突，成功告知。instruction_quote逐字引本消息相关指令，起点为句子/分号或逗号后明确“另外/此外”，逗号截断由宿主补同句限定进source_text。body仅存可复用内容，保范围/例外，不造别名/缩写/扩大指标。Mem0正文作正式body/scope，name仅截标签；name/scope是候选，以回执为准，答复/引用不扩写。临时与长期分别判断，本次不长期存，未验证纠错仅线索；Skill沿管理页保存/选择。",
  ],
  prepare_skill_draft: [
    "PrepareSkillDraftInput",
    "基于本人同会话有效evidence_ids准备待确认Skill草稿。来源可跨任务和历史条件，各自保留原身份；task_id/condition_version是本次草稿归属。不得为绕过错误删掉仍在正文使用的来源。instruction_quote逐字填写当前用户完整原话；name/body/scope/files描述可复用方法、范围与例外，依赖由依据推导。成功仅给草稿引用，告知到我的积累核对保存；正文、发布和选用边界遵循系统规则。",
  ],
  propose_semantic_change: [
    "ProposalInput",
    "保存私人纠错草稿与可共享依据；用户在语义管理页明确提交后负责人才可见，接受后编辑保存才生效。纠错不阻塞当前SQL调查；草稿未公开或生效。",
  ],
  read_analysis_task: [
    "ReadTaskInput",
    "读任务条件/依据，condition_version省略取当前、指定取历史；current_condition_version/lifecycle/phase总是现态。历史仅带current_open_clarification_ids，不带当前目标/问题正文或执行权。open_clarifications依next_clarification_after续clarification_after，不当全集。decision_state_version由宿主保存；legacy_pending按旧版本/稳定索引显式迁移，不删字符串假清。旧条件revision_origin给真实修订/原消息，原话仅证来源，是否采纳须核条件。text_unavailable/unavailable_clarification_ids标隐藏，不从历史补回。",
  ],
  read_conversation: [
    "ConversationReadInput",
    "事件游标读历史；task_directory=true列任务，next_task_after续task_after，read_analysis_task补条件。",
  ],
  prepare_analysis_answer: [
    "PrepareAnalysisAnswerInput",
    "准备有来源的定量说明数值，不执行SQL、不定稿、不冻结任务。sources给query_id/result_ref/真实columns；values以唯一小写name绑cell(列/绝对row_index)、statistic(行数/列计数)、parameter(原参数)、metadata(data_freshness/saved_row_count)、observation_cutoff/data_batch(草稿的用户截点/批次，同名角色用field_ref对齐)。format可选：style=raw直显原值，decimal/percent给precision(0-12)按十进制半值远离零舍入，展示舍入如实说明、不称无损；NULL沿空值展示；非数字不自算单位。回执给已核bindings与required_suffix；随后正常正文一次写完，用{{name}}原样引用绑定值，不在正文另写派生数字或SQL块。未返回的差值/环比/合计不补算，说明缺口另给草稿。概念/纯保存确认不用本工具，自然回答。",
  ] as const,
  update_analysis_task: ["CurrentAnalysisUpdate", "登记本条消息归属，返回task_id/condition_version；已有任务使用当前版本。create新目标，route追问或浏览，revise/clarify更新原目标，split分离独立目标。参数的默认、条件修订、澄清与显式旧格式迁移规则见Schema。source_limits省略继承；新任务无附加限制显式null，许可未知不能猜null或允许集。route只归属，不改条件；仅修订同目标SQL时给replaces_query_id。opened_clarifications为本次新问题，has_more_clarifications须read_analysis_task续读。普通说明在最后正文完成；中途定稿用route的finalize_current_answer，查询数字先prepare_analysis_answer绑定。"] as const,
  request_query: ["CurrentRequestQueryInput", "保存已核口径的SQL草稿，不执行。度量与诊断列的口径分离、保存前一致性核对按系统说明执行。草稿继承目标task_id/condition_version的条件与采纳说明；semantic_resolution省略即可，兼容携带只能与该版本已有说明相同，不能在此另作决定。需要改变解释先同次revise；真实未决登记clarifications，普通无歧义任务不强填采纳对象。修改旧SQL必给其replaces_query_id使旧待执行稿失效，独立查询给null。semantic_checks是非阻断诊断，不授执行权。"] as const,
  search_knowledge: [
  'KnowledgeSearchInput',
  'view=source_identity只列身份，未读正文，无语义召回。空白分词任一匹配，稳定ID分页。完整字段名、表名或文档名窄查。对象可筛kinds，无对象平台源按名/ID查并省略kinds。source_keys区分同名目录与正式定义，roots_complete只说明直属身份是否齐全。bounded带next且目标仍缺，窄查或续页，再按用户许可定conditions.source_limits，许可不明先问。限读原文用object_id/object_version填evidence的source_selection（version取object_version），取citation再read_source。不扩许可，不授派生知识/结构采用权。两视图cursor不互用。默认evidence遵来源门，kinds=document取文档条目摘录，普通平台原文只召回已索引的超长来源。hits按相关性返knowledge_entry/source_excerpt，用ref/citation补读，raw不可作知识ref。content_state指本项，support_state与supports_complete分别指支持交付、提取完整性，unknown仍可能有例外。search_coverage示覆盖，空结果不能判不存在。本人有效资产用query=*或asset_after单独翻页。',
] as const, read_knowledge: [
  'KnowledgeReadInput',
  '按items输入顺序批量补读1–20项当前知识、本人记忆或已选Skill。knowledge用ref绑定对象修订及条目path，可用statement_id读取指定有效陈述；structure_only=true独立分页读取structure_text/structure_page，只有完整JSON页且structure_coverage=complete才提供effective_structure，尾页片段不能采用；structure_dependencies给本次实际核定的当前结构依据，原结构内登记版本保持历史含义，显式引用仍须使用所读版本。memory用独立asset_ref和part=body/scope/source_text，保留content_page/scope_page/source_page各自分页，缺省不附全部原话。offset/limit按Unicode字符读取，默认从0取4096字符。逐项state为ok/stale/not_available，不可用项不影响其他合法项；服务失败整批明确拒绝。content_state表示指定内容，support_state与supports_complete分别表示本回执实际支持交付和提取完整性；unknown不能理解为没有例外。后页保持原ref与continuation.content_next_offset，记忆保持原asset_ref/part。skill仅给已选当前版本的descriptor和native_path，正文/附件仍用Pi原生read按行补读，不用SourceCitation读取Skill。task_ref省略继承当前活动任务，跨任务先route。',
] as const, read_source: [
  'SourceReadInput',
  '按citation绑定的来源修订和Unicode区间定点读取。citation.locator.length是精确请求区间长度（须满足offset+length<=source_length，不是最大字符上限）；单页限制请传limit，next_locator只继续原请求剩余区间。返回source_length是该版全文总长，不表示本次已读全文；若同版区间越界，按回执valid_locator、source_length或available_length修正；续读仅补齐问题所需且用户允许的区间，全文总长不表示必须通读。task_ref省略时继承当前活动任务，跨任务先route。',
] as const,
} as const;
function expand(value: unknown, seenRefs = new Set<string>(), includeDescriptions = true, currentDecisions = false): unknown {
  if (Array.isArray(value)) return value.map(item => expand(item, seenRefs, includeDescriptions, currentDecisions));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.$ref === "string" && record.$ref.startsWith("#/$defs/")) {
      const name = record.$ref.slice(8) as keyof typeof schema.$defs;
      const repeated = seenRefs.has(name);
      seenRefs.add(name);
      // 同一工具内省去重复注释，所有校验仍逐处展开。
      const expanded = expand(schema.$defs[name], seenRefs, includeDescriptions && !repeated, currentDecisions) as Record<string, unknown>;
      if (currentDecisions && (name === "Conditions" || name === "ConditionSet")) {
        // 旧channel只供持久记录和原调用解码；当前模型用filters表达业务渠道。
        const properties = expanded.properties as Record<string, unknown>;
        if (name === "Conditions") properties.channel = {type: "null"};
        else delete properties.channel;
      }
      // 引用处的说明描述当前参数用途，不能当成定义的重复注释省掉。
      return {
        ...expanded,
        ...(includeDescriptions && typeof record.description === "string" ? {description: record.description} : {}),
      };
    }
    return Object.fromEntries(
      Object.entries(record)
        .filter(([key, value]) => (key !== "title" || typeof value !== "string") && (key !== "description" || typeof value !== "string" || includeDescriptions))
        .map(([key, value]) => {
          // 兼容Schema保旧持久形状；当前模型参数只暴露已采用说明。
          const variants = currentDecisions && (key === "anyOf" || key === "oneOf") && Array.isArray(value)
            && value.some(branch => branch?.$ref === "#/$defs/AdoptedSemanticResolution")
            ? value.filter(branch => branch?.$ref !== "#/$defs/QuerySemanticResolution") : value;
          return [key, expand(variants, seenRefs, includeDescriptions, currentDecisions)];
        }),
    );
  }
  return value;
}
export type DataToolName = keyof typeof definitions;
export type AnswerCandidate = {
  text: string;
  sdkId: string;
  /** 原工具登记的交付归属；实际sources分别保持各查询的原任务/条件。 */
  taskRef?: EvidenceTaskRef;
  sources: {query_id: string; task_id: string; condition_version: string}[];
};
// 一次已核定的数值绑定：不是答案完成、不覆盖通知，仅侘认证正文渲染标记。
export type Preparation = {
  sdkId: string;
  taskRef?: EvidenceTaskRef;
  sources: AnswerCandidate["sources"];
  bindings: Record<string, string>;
  requiredSuffix: string;
};
export class UnregisteredToolCallError extends Error {
  constructor() { super("invalid_tool_arguments"); }
}
export function assistantOutputBinding(
  manager: SessionManager,
  attemptId: string,
  chunks?: {first: number; last: number},
  sdkId?: string,
): AssistantOutputBinding {
  const entry = manager.getBranch().findLast(entry => entry.type === "message"
    && entry.message.role === "assistant"
    && (sdkId === undefined || entry.message.content.some(part => part.type === "toolCall" && part.id === sdkId)));
  if (entry?.type !== "message" || entry.message.role !== "assistant")
    throw new Error("answer_message_required");
  const message = entry.message;
  if (message.stopReason === "deferred" || message.stopReason === "pending") throw new Error("answer_message_incomplete");
  const text = message.content.filter(part => part.type === "text").map(part => part.text).join("");
  return {
    entry_id: entry.id,
    attempt_id: attemptId,
    stop_reason: message.stopReason,
    tool_call_ids: message.content.filter(part => part.type === "toolCall").map(part => part.id),
    text_sha256: createHash("sha256").update(text, "utf8").digest("hex"),
    ...(chunks && chunks.last >= chunks.first ? {first_chunk_seq: String(chunks.first), last_chunk_seq: String(chunks.last)} : {}),
  };
}
export function dataTools(
  transport: RustTransport,
  manager: SessionManager,
  fault: string,
  acceptReceipt?: (receipt: DataToolOutcome, sdkId: string) => void,
  responseBudget?: (sdkId: string, usageTokens?: number | null) => import('../../../packages/contracts/generated/boundary.ts').ResponseBudget | undefined,
  answerOutput?: {start: () => number | undefined; drain: () => Promise<number>},
  renderedCandidate?: () => {binding: (lastChunk: number) => RenderedAnswerBinding} | undefined,
) {
  let answer: AnswerCandidate | undefined;
  let preparation: Preparation | undefined;
  let frozenParts = transport.run?.answer_parts ?? [];
  const invalidateAnswer = () => {
    answer = undefined;
  };
  // 任务、条件或来源上下文重置使准备失效；普通读取/保存不清空准备表。
  const invalidatePreparation = () => {
    preparation = undefined;
  };
  const currentTask = () => transport.run.workspace_context?.active_task_ref ?? undefined;
  const currentAnswer = () => {
    const task = currentTask();
    return answer?.taskRef && answer.taskRef.task_id === task?.task_id
      && answer.taskRef.condition_version === task?.condition_version ? answer : undefined;
  };
  const currentPreparation = () => {
    const task = currentTask();
    return preparation?.taskRef && preparation.taskRef.task_id === task?.task_id
      && preparation.taskRef.condition_version === task?.condition_version ? preparation : undefined;
  };
  // 结果通知按成功回执实际采用的query判定；不能用之后route的活动版本推断。
  const notificationAnswer = (queryId: string, taskRef?: EvidenceTaskRef) => answer
    && answer.sources.some(source => source.query_id === queryId
      && (!taskRef || (source.task_id === taskRef.task_id
        && source.condition_version === taskRef.condition_version))) ? answer : undefined;
  const adoptAnswer = (receipt: DataToolOutcome, sdkId: string) => {
    if (receipt.data.error || receipt.tool_name !== "present_analysis_answer" || typeof receipt.data.answer_text !== "string") return;
    const sources: AnswerCandidate["sources"] = [];
    for (const source of Array.isArray(receipt.data.sources) ? receipt.data.sources : []) {
      if (source && typeof source === "object" && typeof source.query_id === "string"
        && typeof source.task_id === "string" && typeof source.condition_version === "string")
        sources.push({query_id: source.query_id, task_id: source.task_id, condition_version: source.condition_version});
    }
    answer = {text: receipt.data.answer_text, sdkId, sources,
      ...(receipt.answer_task_ref ? {taskRef: receipt.answer_task_ref} : {})};
  };
  // 新prepare替代旧准备；只有回执形状完整才采用，不成功的准备不进入渲染。
  const adoptPreparation = (receipt: DataToolOutcome, sdkId: string) => {
    if (receipt.data.error || receipt.tool_name !== "prepare_analysis_answer") return;
    if (!receipt.data.bindings || typeof receipt.data.bindings !== "object"
      || Array.isArray(receipt.data.bindings) || typeof receipt.data.required_suffix !== "string") return;
    const sources: AnswerCandidate["sources"] = [];
    for (const source of Array.isArray(receipt.data.sources) ? receipt.data.sources : []) {
      if (source && typeof source === "object" && typeof source.query_id === "string"
        && typeof source.task_id === "string" && typeof source.condition_version === "string")
        sources.push({query_id: source.query_id, task_id: source.task_id, condition_version: source.condition_version});
    }
    preparation = {sdkId, sources, bindings: receipt.data.bindings as Record<string, string>,
      requiredSuffix: receipt.data.required_suffix,
      ...(receipt.answer_task_ref ? {taskRef: receipt.answer_task_ref} : {})};
  };
  const unavailableQueries = new Set<string>();
  const validateArguments = (name: string, args: unknown): void => {
    if (!Object.hasOwn(definitions, name)) throw new Error("tool_not_allowed");
    const [contract] = definitions[name as DataToolName];
    validateContract(contract, args);
  };
  const invokeRecorded = async (
    name: string,
    sdkId: string,
    args: unknown,
    usageTokens?: number | null,
    handoff?: AnswerHandoff,
  ): Promise<DataToolOutcome> => {
    invalidateAnswer();
    const input = {
      ...transport.binding(),
      sdk_tool_call_id: sdkId,
      tool_name: name,
      arguments: args,
      ...(handoff ? {answer_handoff: handoff} : {}),
      checkpoint: exportCheckpoint(
        manager,
        transport.run.workspace_context?.authority_revision,
        transport.run.workspace_context?.authority_snapshot,
      ),
    };
    // 这些形状从未允许登记；检查点或绑定错误不能被当作参数未执行。允许集同validateArguments按本运行目录。
    if ((!Object.hasOwn(definitions, name) && name !== "present_analysis_answer") || !args || typeof args !== "object" || Array.isArray(args))
      throw new UnregisteredToolCallError();
    // 旧参数只能凭Rust账本接回；新参数由登记入口严格检查。
    let operation: OperationReceipt;
    try {
      operation = await transport.post("/internal/data/tool-calls", "DataToolInvocation", input);
    } catch (error) {
      if (error instanceof Error && error.message === "invalid_input") {
        try { validateArguments(name, args); }
        catch { throw new UnregisteredToolCallError(); }
      }
      throw error;
    }
    if (fault === "before_business_commit") process.exit(73);
    // 原登记版本决定容量提示；当前run只提供授权绑定，不改原tool合同。
    const budget = operation.tool_contract_version === 2 && ['search_knowledge', 'read_knowledge', 'read_source'].includes(name)
      ? responseBudget?.(sdkId, usageTokens) : undefined;
    const invocation = budget ? {...input, response_budget: budget} : input;
    let receipt: DataToolOutcome;
    try {
      receipt = await transport.post("/internal/data/tools", "DataToolInvocation", invocation);
    } catch (error) {
      // 只读回源接回已持久的明确拒绝；没有回执或运行失权仍保留原失败。
      try {
        receipt = await transport.post("/internal/data/tool-rejections", "DataToolInvocation", invocation);
      } catch {
        throw error;
      }
    }
    if (fault === "after_business_commit") process.exit(74);
    // 历史结果缺版本时只补已校验的原登记值，正文和游标保持原回执。
    if (receipt.tool_contract_version === undefined && operation.tool_contract_version !== undefined)
      receipt = {...receipt, tool_contract_version: operation.tool_contract_version};
    if (!receipt.data.error) {
      const route = name === "update_analysis_task" && args && typeof args === "object" && "action" in args && args.action === "route";
      if (route && "finalize_current_answer" in args && args.finalize_current_answer === true && receipt.answer_parts !== undefined) {
        frozenParts = receipt.answer_parts;
        transport.run.answer_parts = frozenParts;
      }
      if (name === "update_analysis_task" && transport.run.workspace_context) {
        const next = receipt.context_reset ?? (typeof receipt.data.task_id === "string" && typeof receipt.data.condition_version === "string"
          ? {task_id: receipt.data.task_id, condition_version: receipt.data.condition_version} : undefined);
        if (next) {
          // 任务或条件版本切换使旧准备脱离当前上下文。
          const previous = transport.run.workspace_context.active_task_ref;
          if (!previous || previous.task_id !== next.task_id || previous.condition_version !== next.condition_version)
            invalidatePreparation();
          transport.run.workspace_context.active_task_ref = next;
        }
      }
    }
    acceptReceipt?.(receipt, sdkId);
    if (name === "get_query" && args && typeof args === "object" && "query_id" in args && typeof args.query_id === "string") {
      const results = receipt.data.results;
      const query = receipt.data.query;
      const failure = receipt.data.error ?? (results && typeof results === "object" && "error" in results ? results.error : undefined);
      const hidden = query && typeof query === "object" && "text_unavailable" in query && query.text_unavailable === true;
      if (["result_expired", "result_unavailable", "not_available", "forbidden", "stale_knowledge"].includes(String(failure)) || hidden)
        unavailableQueries.add(args.query_id);
      else if (results && !failure) unavailableQueries.delete(args.query_id);
    }
    adoptAnswer(receipt, sdkId);
    adoptPreparation(receipt, sdkId);
    return receipt;
  };
  const controlFacts = (receipt: DataToolOutcome): Record<string, unknown> | undefined => {
    if (receipt.context_reset) return {
      context_reset: receipt.context_reset,
      control_note: "任务或资料范围已更新，按当前版本复核依据、条件和 SQL。",
    };
  };
  const formatResult = async (name: string, args: unknown, receipt: DataToolOutcome, signal?: AbortSignal) => {
    if (receipt.data.error) return {content: [{type: "text" as const, text: JSON.stringify(receipt.data)}], details: receipt, isError: true};
    if (name === "read") {
      try {
        // read参数已在入口（执行或恢复）decode为SkillReadInput；正常路径不做第二次相同decode。
        const result = await formatSkillRead(receipt, args as SkillReadInput, signal);
        return {...result, isError: false};
      } catch (error) {
        return {content: [{type: "text" as const, text: error instanceof Error ? error.message : "skill_read_failed"}], details: undefined, isError: true};
      }
    }
    if (receipt.tool_contract_version === 2 && ['search_knowledge', 'read_knowledge', 'read_source'].includes(name)) {
      return {content: [{type: 'text' as const, text: JSON.stringify(receipt.data)}], details: receipt, isError: false};
    }
    const statusNotes: Record<string, string> = {
      not_submitted: "SQL未提交执行；保存草稿不等于执行。",
      queued: "已提交查询并进入队列；实时执行状态以查询卡片为准。",
      submitting: "已发出提交请求，回执时刻尚未收到平台受理确认；实时状态以查询卡片为准。",
      submission_unknown: "提交回执未知，沿原查询身份查证，不能另建查询重做。",
      running: "已提交查询，平台已受理（回执时刻观察）；实时进度以查询卡片为准。",
      succeeded: "平台确认查询成功；结论还须核对实际结果和原条件。",
      failed: "查询失败，不能当作空结果或执行成功。",
      cancelled: "查询已取消，不能当作完成结果。",
    };
    if (name === "execute_query" && Array.isArray(receipt.data.queries)) {
      return {content: [{type: "text" as const, text: JSON.stringify({
        ...receipt.data, status_note: "本批每项状态分别以queries回执为准；已确认项沿原消息和预算，不重复提交。",
      })}], details: receipt, isError: false};
    }
    const query = name === "get_query" ? receipt.data.query : receipt.data;
    const status = query && typeof query === "object" && !Array.isArray(query) && "execution_state" in query ? query.execution_state : undefined;
    const statusNote = typeof status === "string" ? statusNotes[status] : undefined;
    // 阶段感知提示：核对通过且待确认、尚未提交时，明确下一步就是提交，避免模型
    // 误把get_query当任务终点而stop（J01）。
    const executeHint = name === "get_query" && query && typeof query === "object" && !Array.isArray(query)
      && "confirmation_state" in query && query.confirmation_state === "awaiting_confirmation"
      && "check_state" in query && query.check_state === "passed"
      && "execution_state" in query && query.execution_state === "not_submitted"
      ? {phase_note: "草稿核对完成；若当前用户消息已明确要求执行该查询，请立即调用execute_query提交，无需再次询问。"}
      : undefined;
    const displayName = query && typeof query === "object" && "summary" in query && typeof query.summary === "string"
      ? query.summary : typeof receipt.data.goal === "string" ? receipt.data.goal
      : typeof receipt.data.name === "string" ? receipt.data.name
      : args && typeof args === "object" && "goal" in args && typeof args.goal === "string" ? args.goal : undefined;
    return {content: [{type: "text" as const, text: JSON.stringify({
      ...(statusNote ? {status_note: statusNote} : {}),
      ...(executeHint ?? {}),
      ...(displayName ? {display_name: displayName} : {}), ...receipt.data,
      ...(receipt.superseded_query_ids ? {superseded_query_ids: receipt.superseded_query_ids} : {}),
      ...(controlFacts(receipt) ?? {}),
      ...(name === "update_analysis_task" && receipt.answer_parts !== undefined ? {answer_parts: receipt.answer_parts} : {}),
    })}], details: receipt, isError: false};
  };
  const tools: ToolDefinition[] = Object.entries(definitions)
    .map(([name, [contract, description]]) => {
    const parameterContract = contract === "CurrentRequestQueryInput" ? "RequestQueryInput" : contract;
    const parameters = expand(schema.$defs[parameterContract], new Set<string>(), true, true) as Record<string, unknown>;
    if (name === 'update_analysis_task') {
      const [fields, , required] = parameters.allOf as Record<string, unknown>[];
      parameters.allOf = [fields, required];
    }
    return {
      ...(name === "read" ? {promptSnippet: nativeSkillRead.promptSnippet, promptGuidelines: nativeSkillRead.promptGuidelines} : {}),
      name, label: name,
      description,
      // 工具共享运行来源清单，按顺序核验并扩展，避免同批调用相互制造过期快照。
      executionMode: "sequential",
      ...(name === "update_analysis_task" ? {
        // Pi在schema校验前静默删除校验失败的可选null，非法set.source_limits:null
        // 会因此被当作空改成功执行；在参数进入该路径前就地拒绝并指明合法写法。
        prepareArguments: (args: unknown) => {
          const patch = args && typeof args === "object" && "condition_patch" in args
            && args.condition_patch && typeof args.condition_patch === "object"
            && "set" in args.condition_patch && args.condition_patch.set
            && typeof args.condition_patch.set === "object" ? args.condition_patch.set : undefined;
          if (patch && "source_limits" in patch && patch.source_limits === null)
            throw new Error("invalid_source_limits_null: set.source_limits不接受null；已有任务撤销来源限制用unset:[\"source_limits\"]，新任务无额外限制在create的conditions.source_limits显式null");
          return args;
        },
      } : {}),
      parameters: Type.Unsafe(parameters as TSchema),
      execute: async (id, args, signal, _onUpdate, context) => {
        const candidate = currentAnswer();
        invalidateAnswer();
        // read参数在入口decode一次，生成类型直传提交与格式化；其余工具沿用统一契约校验。
        const decoded = name === "read" ? decodeContract<SkillReadInput>("SkillReadInput", args) : undefined;
        if (decoded === undefined) validateArguments(name, args);
        let handoff: AnswerHandoff | undefined;
        if (name === "update_analysis_task" && args && typeof args === "object" && "action" in args && args.action === "route"
          && "finalize_current_answer" in args && args.finalize_current_answer === true) {
          if (!answerOutput) throw new Error("answer_output_unavailable");
          const rendered = renderedCandidate?.();
          const last = await answerOutput.drain();
          if (rendered) {
            // 本条正文经prepare渲染：冻结沿rendered分支交接原Pi entry，展示范围由外层字段表达。
            const binding = rendered.binding(last);
            const {assistant} = binding;
            if (assistant.stop_reason !== "toolUse" && assistant.stop_reason !== "stop") throw new Error("answer_message_incomplete");
            if (assistant.tool_call_ids.length !== 1 || assistant.tool_call_ids[0] !== id) throw new Error("answer_route_must_be_single_call");
            if (Number(binding.last_chunk_seq) < Number(binding.first_chunk_seq)) throw new Error("answer_output_incomplete");
            handoff = {rendered_answer_binding: binding};
          } else {
            const first = answerOutput.start();
            const assistant = assistantOutputBinding(manager, transport.run.attempt_id,
              first === undefined ? undefined : {first, last}, id);
            if (assistant.stop_reason !== "toolUse" && assistant.stop_reason !== "stop") throw new Error("answer_message_incomplete");
            if (assistant.tool_call_ids.length !== 1 || assistant.tool_call_ids[0] !== id) throw new Error("answer_route_must_be_single_call");
            if (!candidate && (!assistant.first_chunk_seq || !assistant.last_chunk_seq)) throw new Error("answer_output_incomplete");
            handoff = {assistant, ...(candidate ? {answer_sdk_tool_call_id: candidate.sdkId} : {})};
          }
        }
        const receipt = await invokeRecorded(name, id, decoded ?? args, context?.getContextUsage()?.tokens, handoff);
        // Pi原生isError保留回执details；转抛异常会丢失未归属投影所需的错误码。
        return formatResult(name, decoded ?? args, receipt, signal);
      },
    };
  });
  return { tools, invokeRecorded, validateArguments, formatResult, answer: currentAnswer, invalidateAnswer, notificationAnswer,
    preparation: currentPreparation,
    async restoreAnswer(sdkId: string, args: unknown, saved: DataToolOutcome) {
      invalidateAnswer();
      // 已消费成功回执只读原操作；缺归属字段时补返回副本，不再登记或执行新调用。
      const receipt = saved.answer_task_ref ? saved : await transport.post("/internal/data/tools", "DataToolInvocation", {
        ...transport.binding(), sdk_tool_call_id: sdkId, tool_name: "present_analysis_answer", arguments: args,
        checkpoint: exportCheckpoint(manager, transport.run.workspace_context?.authority_revision,
          transport.run.workspace_context?.authority_snapshot),
      });
      adoptAnswer(receipt, sdkId);
    },
    // 恢复只接回原已登记成功的prepare回执，不重新登记或执行；无效形状返回undefined。
    restorePreparation(saved: DataToolOutcome, sdkId: string): Preparation | undefined {
      invalidatePreparation();
      adoptPreparation(saved, sdkId);
      return preparation;
    },
    answerParts: (): readonly AnswerPartReference[] => frozenParts,
    resultUnavailable: (queryId: string) => unavailableQueries.has(queryId) };
}

import { createHash } from "node:crypto";
import {
  createAgentSession,
  ModelRuntime,
  SettingsManager,
  convertToLlm,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import {
  InMemoryModelsStore,
  getCurrentTools,
  type TranscriptContext,
  type Tool,
  type AssistantMessage,
  type CredentialStore,
} from "@earendil-works/pi-ai";
import type {
  RunEnvelope,
  TaskInput,
  DataToolOutcome,
  ToolReceipt,
  AnswerPartReference,
  AssistantOutputBinding,
  EvidenceTaskRef,
  RenderedAnswerBinding,
} from "../../../packages/contracts/generated/boundary.ts";
import { RustTransport } from "../transport/client.ts";
import { assistantOutputBinding, dataTools, UnregisteredToolCallError, type Preparation } from "../tools/data-tools.ts";
import { taskTool } from "../tools/update-analysis-task.ts";
import {
  guardedDeepSeekStream,
  connectionFromEnvironment,
} from "../provider/deepseek.ts";
import { configuredModel } from "../provider/configured.ts";
import { mockStream } from "../provider/mock.ts";
import { selectedSkillResources } from "./skills.ts";
import { resources } from "./resources.ts";
import { workspaceContext, applyDeliveryContext } from "./workspace-context.ts";
import { restoreCheckpoint, restoreAdoptedSteps, exportCheckpoint, RECOVERY_NOTICE } from "./checkpoint.ts";
import { decodeContract } from "../../../packages/contracts/validate.ts";
import { outputStream } from "./output-stream.ts";
import { renderedStream } from "./render.ts";
import { estimateFixedContextTokens, estimateRequestBytes } from "./request-size.ts";
import { sessionCapacity, toolResponseCapacity } from "./capacity.ts";
import { taskProjection } from "./task-projection.ts";
import {
  type CapacityPlan,
  planForProfile,
} from "../../../packages/contracts/capacity.ts";

export type DeliveryStage = 'checkpoint_restore' | 'context_setup' | 'model_runtime' | 'model_configuration'
  | 'session_create' | 'tool_recovery' | 'context_refresh' | 'native_compaction' | 'session_prompt' | 'answer_delivery';

export async function deliver(
  run: RunEnvelope,
  apiUrl: string,
  token: string,
  fault: string,
  signal: AbortSignal = new AbortController().signal,
  onStage?: (stage: DeliveryStage) => void,
) {
  onStage?.('checkpoint_restore');
  const transport = new RustTransport(run, apiUrl, token);
  let checkpoint=run.checkpoint;
  if(checkpoint?.storage?.kind==='host_checkpoint') {
    const saved=await transport.post('/internal/checkpoints/read','ReadCheckpoint',transport.binding(),checkpoint.storage.fingerprint);
    if(saved.leaf_id!==checkpoint.leaf_id||saved.storage)throw new Error('checkpoint_conflict');
    checkpoint=saved;
  }
  const manager = restoreCheckpoint("/synthetic/data-agent", checkpoint);
  onStage?.('context_setup');
  const frozen = run.answer_parts ?? [];
  const branch = manager.getBranch();
  if (run.resume_same_input && frozen.length) restoreAdoptedSteps(manager, branch, run.message_id, frozen);
  // §4.2：已恢复Pi分支中旧结构化search回执的长游标只在模型投影中短化为rc1引用。
  // 只按details.operation_id准确关联成功回执，只追加Pi原生context edit：原entry、持久回执与
  // 原调用参数不变；原生压缩沿buildSessionProjection输入同一短引用。不扫正文、不改用户文字、
  // 不重放原搜索；已经短化的游标和没有覆盖信息的旧回执直接跳过。
  const editedTargets = new Set(branch.flatMap(entry => entry.type === 'context_edit' ? [entry.targetId] : []));
  for (const entry of branch) {
    if (entry.type !== 'message' || entry.message.role !== 'toolResult' || entry.message.isError
      || entry.message.toolName !== 'search_knowledge' || editedTargets.has(entry.id)) continue;
    const text = entry.message.content.find(part => part.type === 'text')?.text;
    if (typeof text !== 'string') continue;
    let data: {error?: unknown; memory_retrieval?: unknown; search_coverage?: {next?: unknown}};
    try { data = JSON.parse(text); } catch { continue; }
    const operationId = (entry.message.details as {operation_id?: unknown} | undefined)?.operation_id;
    const next = data?.search_coverage?.next;
    if (typeof operationId !== 'string' || data?.error !== undefined || data?.memory_retrieval === 'excluded_by_view'
      || typeof next !== 'string' || !next || next.startsWith('rc1:')) continue;
    manager.appendContextEdit(entry.id, {content: [{type: 'text', text: JSON.stringify(
      {...data, search_coverage: {...data.search_coverage, next: 'rc1:' + operationId}})}]});
  }
  // 原输入恢复可从原生user条目或范围投影消息定位，不依赖压缩后的活动user仍可见。
  const roundStart = run.resume_same_input ? branch.findLastIndex(entry =>
    (entry.type === 'message' && entry.message.role === 'user'
      && (typeof entry.message.content === 'string' ? entry.message.content : entry.message.content.filter(part => part.type === 'text').map(part => part.text).join('')) === run.text)
    || (entry.type === 'custom_message' && entry.customType === 'data_agent_current_input'
      && (entry.details as {message_id?: string} | undefined)?.message_id === run.message_id)) : -1;
  const previousEntryIds = run.resume_same_input && roundStart < 0 ? null
    : new Set((run.resume_same_input ? branch.slice(0, roundStart) : branch).map(entry => entry.id));
  const messages = manager.buildSessionContext().messages;
  const assistantIndex = messages.findLastIndex(message => message.role === "assistant");
  const last = messages[assistantIndex];
  const completed = new Set(messages.slice(assistantIndex + 1).filter(message => message.role === "toolResult").map(message => message.toolCallId));
  const pendingCalls = run.resume_same_input && last?.role === "assistant"
    ? last.content.filter(part => part.type === "toolCall").filter(call => !completed.has(call.id)) : [];
  const tool = taskTool(transport, manager, fault);
  let finalStartChunk = 1;
  let messageOutputStart: number | undefined;
  let messageDeferred = false;
  let messageTask: EvidenceTaskRef | undefined;
  let completedTask: EvidenceTaskRef | undefined;
  let completedAssistant: AssistantMessage | undefined;
  let completedBinding: AssistantOutputBinding | undefined;
  // 本条正文在message_start绑定的prepare回执与流式渲染器；条内prepare只作用后续assistant。
  let messageRenderer: ReturnType<typeof renderedStream> | undefined;
  let messagePrepare: Preparation | undefined;
  let renderInvalid = false;
  // 已定稿的渲染正文：display为展示文本，sourceText为原Pi entry模板原文。
  let renderedFinal: {
    sdkId: string;
    display: string;
    sourceText: string;
    taskRef?: EvidenceTaskRef;
    sources: Preparation["sources"];
    first: number;
    recoveredBinding?: RenderedAnswerBinding;
  } | undefined;
  const output = outputStream((chunk_seq, text) => transport.post("/internal/outputs", "AppendOutput", {
    ...transport.binding(), chunk_seq, text,
  }));
  const notification = run.workspace_context?.result_notification;
  const notificationQuery = run.workspace_context?.query_observations.find(query => query.id === notification?.query_id);
  const notificationTask: EvidenceTaskRef | undefined = notification?.task_ref
    ?? (typeof notificationQuery?.task_id === "string" && typeof notificationQuery.condition_version === "string"
      ? {task_id: notificationQuery.task_id, condition_version: notificationQuery.condition_version}
      : run.workspace_context?.active_task_ref ?? undefined);
  const workspace: ReturnType<typeof workspaceContext> | null = run.workspace_context ? workspaceContext(run.workspace_context, {
    previousEntryIds, selectText: (): string | undefined => {
      const selected = selectDelivery();
      return selected?.grounded?.text ?? selected?.rendered?.display ?? selected?.natural ?? selected?.control?.text;
    },
  }) : null;
  let systemPrompt = "";
  let activeSession: AgentSession | undefined;
  const projection = workspace ? taskProjection(transport, manager, workspace.replace,
    () => activeSession?.refreshContext()) : null;
  const responseCapacity = toolResponseCapacity(run.model_profile, manager, () => ({
    systemPrompt: activeSession?.systemPrompt ?? systemPrompt, tools: activeTools(), references: workspace?.contents() ?? [], usageTokens: activeSession?.getContextUsage()?.tokens,
  }));
  const data = run.workspace_context
    ? dataTools(transport, manager, fault, (receipt, sdkId) => {
        workspace?.acceptReceipt(receipt);
        projection?.acceptReceipt(receipt, sdkId);
        if (['search_knowledge', 'read_knowledge', 'read_source'].includes(receipt.tool_name))
          responseCapacity?.accept(receipt.data, sdkId);
      }, (sdkId, usageTokens) => responseCapacity?.budget(sdkId, usageTokens), {start: () => messageOutputStart, drain: output.drain},
      () => {
        const final = renderedFinal;
        if (!final || final.recoveredBinding) return undefined;
        return {binding: (lastChunk: number): RenderedAnswerBinding => ({
          assistant: assistantOutputBinding(manager, run.attempt_id),
          source_text: final.sourceText,
          prepared_sdk_tool_call_id: final.sdkId,
          first_chunk_seq: String(final.first),
          last_chunk_seq: String(lastChunk),
        })};
      })
    : null;
  // 复用Pi公开loadout；未开放的工具不作为当前固定成本重复预留，发送硬门仍核实际协议。
  const activeTools = (): Tool[] => {
    const names = activeSession?.getActiveToolNames();
    return names ? (data?.tools ?? []).filter(tool => names.includes(tool.name)) : data?.tools ?? [];
  };
  // 通知答案按成功回执实际采用的query匹配，不看之后route的活动版本。
  const notificationAnswer = () => {
    if (!data || !notification) return undefined;
    return notificationTask
      ? data.notificationAnswer(notification.query_id, notificationTask)
      : data.notificationAnswer(notification.query_id);
  };
  // 渲染正文被实际采用后才覆盖通知解释义务；仅prepare成功不解除。
  const notificationRendered = () => Boolean(renderedFinal && notification && renderedFinal.sources.some(source =>
    source.query_id === notification.query_id
    && (!notificationTask || (source.task_id === notificationTask.task_id
      && source.condition_version === notificationTask.condition_version))));
  // 实际来源ID不能证明满足通知原scope；沿宿主与控制投影共算的覆盖事实。
  const notificationCoveredByFrozen = () => Boolean(notification && workspace?.notificationCoveredByFrozen());
  const needsResultAnswer = () => Boolean(data && notification?.execution_state === "succeeded"
    && !data.resultUnavailable(notification.query_id)
    && !notificationCoveredByFrozen()
    && !notificationAnswer()
    && !notificationRendered());
  const allTasksFrozen = () => {
    const parts = data?.answerParts() ?? frozen;
    const workspace = run.workspace_context;
    if (!parts.length || !workspace) return false;
    // 启动input_task_ids不包含轮内新建目标；当前活动任务仍须有自己的交付或原通知覆盖。
    const active = workspace.active_task_ref;
    if (active && !parts.some(part => part.task_ref.task_id === active.task_id
      && part.task_ref.condition_version === active.condition_version)
      && !(notificationCoveredByFrozen() && notificationTask?.task_id === active.task_id)
      && !workspace.tasks.some(task => task.id === active.task_id && task.lifecycle === "cancelled")) return false;
    if (!workspace.input_task_ids?.length) return notificationCoveredByFrozen();
    return workspace.input_task_ids.every(id => {
      const task = workspace.tasks.find(task => task.id === id);
      return task && (task.lifecycle === "cancelled"
        || parts.some(part => part.task_ref.task_id === id && part.task_ref.condition_version === task.condition_version)
        || (notificationCoveredByFrozen() && notificationTask?.task_id === id));
    });
  };
  // settle投影与正式提交使用同一合法候选选择，通知解释义务优先于旧控制状态。
  const selectDelivery = () => {
    if (needsResultAnswer()) return undefined;
    // 渲染正文是合法完整候选；冻结后新生成的一条按§5.4窄修复允许作为同任务新尾项。
    const rendered = renderedFinal && completedAssistant?.stopReason === "stop"
      && !completedAssistant.content.some(part => part.type === "toolCall") ? renderedFinal : undefined;
    const grounded = notificationAnswer() ?? data?.answer();
    const active = run.workspace_context?.active_task_ref;
    // 控制投影非空即仍有未覆盖的等待任务（如结果待解释）；grounded/rendered已是完整答案时不需要它。
    const control = grounded || rendered ? undefined : workspace?.control() ?? undefined;
    const alreadyFrozen = active && data?.answerParts().some(part =>
      part.task_ref.task_id === active.task_id && part.task_ref.condition_version === active.condition_version);
    // §5.4统一候选准入：最新完成entry（stop、无toolCall、同task/condition）是合法正文。
    // 活动任务未冻结时它是首个正文；已冻结时只有在没有待覆盖控制义务（control为空，即无未覆盖等待任务）
    // 才把它作为最后冻结entry之后的一个新尾项，否则仍按控制投影交付以覆盖未结清任务，
    // 不能交只覆盖冻结任务的尾项而漏掉其他任务。冻结entry必为toolUse，本stop entry必是其之后新生成的entry；
    // 同任务尾项的entry身份判重仍由Rust按tail_entry承担，Node不按字符串判重、不按同task一律丢弃。
    const natural = !grounded && !rendered && (!alreadyFrozen || !control)
      && completedAssistant?.stopReason === "stop"
      && !completedAssistant.content.some(part => part.type === "toolCall")
      && (!active || (completedTask?.task_id === active.task_id
        && completedTask.condition_version === active.condition_version))
      ? completedAssistant.content.filter(part => part.type === "text").map(part => part.text).join("") : undefined;
    if (allTasksFrozen() && !rendered && !natural?.trim()) return undefined;
    return {grounded, rendered, natural: natural?.trim() ? natural : undefined,
      control: natural?.trim() ? undefined : control};
  };
  const credentials: CredentialStore = {
    read: async () => undefined,
    list: async () => [],
    modify: async () => {
      throw new Error("credentials disabled");
    },
    delete: async () => {
      throw new Error("credentials disabled");
    },
  };
  onStage?.('model_runtime');
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    modelsStore: new InMemoryModelsStore(),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  onStage?.('model_configuration');
  // 新冻结profile按17.7公式推导；推导失败说明冻结配置未经保存校验，明确拒绝。
  const capacityPlan: CapacityPlan | null = (() => {
    const planned = run.model_profile ? planForProfile(run.model_profile) : null;
    if (planned === null) return null;
    if (typeof planned === "string") throw new Error("provider_configuration_invalid");
    return planned;
  })();
  const capacity = capacityPlan && data ? sessionCapacity(capacityPlan, manager, () =>
    estimateFixedContextTokens(activeSession?.systemPrompt ?? systemPrompt, activeTools(), workspace?.contents() ?? [], run.text),
  ) : null;
  let checkpointFailure: unknown;
  const checkContext = (context?: TranscriptContext) => {
    if (checkpointFailure) throw checkpointFailure;
    projection?.check(); capacity?.check();
    if (context) responseCapacity?.check(getCurrentTools(context.messages).length > 0);
  };
  let model;
  if (run.model_profile?.configured_model) {
    model = await configuredModel(runtime,transport,run.model_profile,signal,checkContext);
  } else if (run.model_profile) {
    const connection = connectionFromEnvironment();
    const catalog = runtime.getModel("deepseek", run.model_profile.model_id);
    if (!catalog) throw new Error("provider_model_unavailable");
    runtime.registerProvider("controlled_deepseek", {
      api: "openai-completions",
      apiKey: connection.apiKey,
      baseUrl: connection.baseUrl,
      streamSimple: guardedDeepSeekStream(
        transport,
        run.model_profile,
        connection,
        signal,
        checkContext,
      ),
      models: [
        {
          ...catalog,
          baseUrl: connection.baseUrl,
          input: ["text"],
          compat: { ...catalog.compat, supportsStrictMode: false },
          maxTokens: run.model_profile.output_limit,
          // 实际模型窗口保留；本地字节门槛通过Pi原生压缩衔接。
          contextWindow:
            run.model_profile.toolset === "data"
              ? (run.model_profile.context_window ?? run.model_profile.input_limit)
              : catalog.contextWindow,
        },
      ],
    });
    model = runtime.getModel("controlled_deepseek", run.model_profile.model_id);
  } else {
    const delayMs = Number(process.env.DATA_AGENT_MOCK_DELAY_MS ?? 0);
    if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 5000)
      throw new Error("invalid mock delay");
    runtime.registerProvider("local_mock", {
      api: "openai-completions",
      apiKey: "synthetic-local-unused",
      baseUrl: "http://127.0.0.1",
      streamSimple: mockStream(transport, delayMs, checkContext),
      models: [
        {
          id: "task_demo",
          name: "本地模拟模型",
          api: "openai-completions",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32000,
          maxTokens: 2000,
        },
      ],
    });
    model = runtime.getModel("local_mock", "task_demo");
  }
  if (!model) throw new Error("mock model unavailable");
  const history = convertToLlm(manager.buildSessionContext().messages).filter(message=>message.role!=="system");
  const historyBytes = Buffer.byteLength(JSON.stringify(history.map(message=>({role:message.role, content:message.content}))));
  const keepRecentTokens = history.length && historyBytes / history.length > 600 ? 2048 : 256;
  const settings = SettingsManager.inMemory({
    defaultTools: [],
    compaction: capacityPlan
      ? {
          enabled: !!data,
          reserveTokens: capacityPlan.historyReserve,
          keepRecentTokens: capacityPlan.keepRecent,
        }
      : {
          enabled: !!data,
          reserveTokens: 2048,
          keepRecentTokens: run.model_profile?.toolset === "data" ? keepRecentTokens : 4000,
        },
    // 连续失败三次 = 首次请求 + 两次Pi原生重试；HTTP SDK层保持零重试。
    retry: { enabled: run.model_profile?.toolset === "data", maxRetries: 2, baseDelayMs: 500, maxAgentDelayMs: 2000 },
  });
  onStage?.('session_create');
  const { session } = await createAgentSession({
    cwd: "/synthetic/data-agent",
    modelRuntime: runtime,
    model,
    thinkingLevel: run.model_profile?.thinking_level ?? "off",
    settingsManager: settings,
    sessionManager: manager,
    resourceLoader: resources(
      !!data,
      selectedSkillResources(run.workspace_context?.selected_skills ?? []),
      [projection?.extension, workspace?.extension, capacity?.extension, responseCapacity?.extension].filter((extension) => extension !== undefined),
    ),
    tools: data ? data.tools.map((t) => t.name) : ["update_analysis_task"],
    customTools: data ? data.tools : [tool.definition],
  });
  activeSession = session;
  systemPrompt = session.systemPrompt;
  session.subscribe((event) => {
    if (event.type === 'compaction_end' && !event.result) {
      // Pi会捕获压缩追加失败；仅失败事件核落盘，健康导出仍不重读历史。
      try { exportCheckpoint(manager, undefined, undefined, true); }
      catch (error) {
        checkpointFailure = error;
        void session.abort();
      }
    }
    if (event.type === 'tool_execution_end') {
      responseCapacity?.accept(event.result, event.toolCallId);
      // Pi参数校验和未知工具可在execute之前失败，同样使未冻结候选失效。
      if (event.isError) data?.invalidateAnswer();
    }
    if (event.type === "message_start" && event.message.role === "assistant") {
      finalStartChunk = output.startMessage();
      completedBinding = undefined;
      messageTask = run.workspace_context?.active_task_ref ?? undefined;
      messageDeferred = Boolean(notificationAnswer()) || Boolean(data?.answer());
      messageOutputStart = messageDeferred ? undefined : finalStartChunk;
      // 正文渲染只绑定本条开始时已成功的prepare；条内prepare的值不倒填此前正文。
      messagePrepare = messageDeferred ? undefined : data?.preparation();
      messageRenderer = messagePrepare ? renderedStream(messagePrepare.bindings) : undefined;
      renderedFinal = undefined;
      renderInvalid = false;
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      completedAssistant = event.message;
      completedTask = messageTask;
      responseCapacity?.begin(event.message, session.getContextUsage()?.tokens);
      if (messageRenderer && messagePrepare) {
        const sourceText = event.message.content.filter(part => part.type === "text").map(part => part.text).join("");
        const finished = messageRenderer.finish(messagePrepare.requiredSuffix);
        if (finished.ok && sourceText.trim()) {
          // 合法残留（尾"}"/单个"{"）与后缀只在此一次送出并计入展示chunks；原entry保持模板原文。
          output.append(finished.emit);
          renderedFinal = {sdkId: messagePrepare.sdkId, display: finished.display, sourceText,
            taskRef: messagePrepare.taskRef, sources: messagePrepare.sources, first: messageOutputStart!};
        } else if (!finished.ok) {
          // 未知/未闭合/超限标记不定稿；正文已按规则流出，提交层拒绝并纠正。
          renderInvalid = true;
        }
        messageRenderer = undefined;
        messagePrepare = undefined;
      }
    }
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      if (messageRenderer) output.append(messageRenderer.push(event.assistantMessageEvent.delta));
      else if (!messageDeferred) output.append(event.assistantMessageEvent.delta);
    }
  });
  const abort = () => {
    void session.abort();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    onStage?.('tool_recovery');
    // 先建立当前Pi系统/工具与usage基准，再接回半轮；只执行原登记调用，不重新规划。
    if (run.resume_same_input && last?.role === "assistant") {
      for (const call of pendingCalls) {
        let receipt: DataToolOutcome | ToolReceipt;
        try {
          if (data) receipt = await data.invokeRecorded(call.name, call.id, call.arguments, session.getContextUsage()?.tokens);
          else {
            let args: TaskInput;
            try {
              if (call.name !== "update_analysis_task") throw new Error("tool_not_allowed");
              args = decodeContract<TaskInput>("TaskInput", call.arguments);
            } catch { throw new UnregisteredToolCallError(); }
            receipt = await tool.invokeRecorded(call.id, args);
          }
        } catch (error) {
          if (!(error instanceof UnregisteredToolCallError)) throw error;
          manager.appendMessage({role: "toolResult", toolCallId: call.id, toolName: call.name,
            content: [{type: "text", text: JSON.stringify({error: "invalid_tool_arguments", message: "工具名或参数不符合当前契约；本次调用未执行，请使用允许的工具和完整参数修正。"})}],
            isError: true, timestamp: Date.now()});
          continue;
        }
        // 恢复入口自行校验冻结的read参数（跨进程不可信输入）；格式化逻辑只收生成类型。
        let formatArguments: unknown = call.arguments;
        if (data && call.name === "read") {
          try {
            formatArguments = decodeContract("SkillReadInput", call.arguments);
          } catch (error) {
            manager.appendMessage({role: "toolResult", toolCallId: call.id, toolName: call.name,
              content: [{type: "text", text: error instanceof Error ? error.message : "skill_read_failed"}],
              isError: true, timestamp: Date.now()});
            continue;
          }
        }
        const formatted = data && "data" in receipt
          ? await data.formatResult(call.name, formatArguments, receipt, signal)
          : {content: [{type: "text" as const, text: JSON.stringify(receipt)}], details: receipt, isError: false};
        responseCapacity?.accept(formatted, call.id);
        manager.appendMessage({role: "toolResult", toolCallId: call.id, toolName: call.name,
          content: formatted.content, details: formatted.details ? JSON.parse(JSON.stringify(formatted.details)) : undefined,
          isError: formatted.isError, timestamp: Date.now()});
      }
    }
    onStage?.('context_refresh');
    await projection?.apply();
    session.refreshContext();
    // 仅从宿主确认leaf的当前有效投影接回答案；waiting快照本身不能证明Pi已完成调查。
    let recoveredControlReady = false;
    if (run.resume_same_input && previousEntryIds && !pendingCalls.length) {
      const current = manager.buildSessionProjection().entries.filter(entry => !previousEntryIds.has(entry.sourceEntry.id));
      const assistant = current.findLast(entry => entry.messages.some(message => message.role === "assistant"));
      const message = assistant?.messages.find(message => message.role === "assistant");
      if (message?.role === "assistant" && message.stopReason === "stop"
        && !message.content.some(part => part.type === "toolCall")) {
        const saved = branch.findLast(entry => entry.type === "custom" && entry.customType === "data_agent_output_binding"
          && (entry.data as {message_id?: string; recovery_chain_id?: string; output_binding?: AssistantOutputBinding} | undefined)?.message_id === run.message_id
          && (entry.data as {recovery_chain_id?: string}).recovery_chain_id === run.recovery_chain_id
          && (entry.data as {output_binding?: AssistantOutputBinding}).output_binding?.entry_id === assistant?.sourceEntry.id);
        if (saved?.type === "custom") {
          const location = saved.data as {task_ref?: unknown; output_binding: unknown};
          const binding = decodeContract<AssistantOutputBinding>("AssistantOutputBinding", location.output_binding);
          const text = message.content.filter(part => part.type === "text").map(part => part.text).join("");
          if (createHash("sha256").update(text, "utf8").digest("hex") === binding.text_sha256) {
            completedAssistant = message;
            completedTask = location.task_ref === undefined ? undefined
              : decodeContract<EvidenceTaskRef>("EvidenceTaskRef", location.task_ref);
            completedBinding = binding;
          }
        }
        // 完整渲染候选：接原binding和其指定的prepare回执完成提交，不重叫模型、不用最近一份prepare。
        const savedRendered = branch.findLast(entry => entry.type === "custom" && entry.customType === "data_agent_output_binding"
          && (entry.data as {message_id?: string; recovery_chain_id?: string} | undefined)?.message_id === run.message_id
          && (entry.data as {recovery_chain_id?: string}).recovery_chain_id === run.recovery_chain_id
          && (entry.data as {rendered_binding?: {assistant?: {entry_id?: string}}}).rendered_binding?.assistant?.entry_id === assistant?.sourceEntry.id);
        if (data && savedRendered?.type === "custom" && assistant?.sourceEntry.type === "message"
          && assistant.sourceEntry.message.role === "assistant") {
          const location = savedRendered.data as {task_ref?: unknown; rendered_binding: unknown; display?: unknown};
          const binding = decodeContract<RenderedAnswerBinding>("RenderedAnswerBinding", location.rendered_binding);
          // 恢复只看原entry的source_text/hash；applyDeliveryContext的展示投影不是原始正文。
          const sourceText = assistant.sourceEntry.message.content.filter(part => part.type === "text").map(part => part.text).join("");
          if (typeof location.display === "string" && binding.source_text === sourceText
            && createHash("sha256").update(sourceText, "utf8").digest("hex") === binding.assistant.text_sha256) {
            const prepareTool = branch.flatMap(entry => entry.type === "message" && entry.message.role === "assistant"
              ? entry.message.content.filter(part => part.type === "toolCall") : []).find(call => call.id === binding.prepared_sdk_tool_call_id);
            const prepareResult = prepareTool && branch.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult"
              ? [entry.message] : []).findLast(result => result.toolCallId === prepareTool.id);
            const restored = prepareResult?.role === "toolResult" && !prepareResult.isError && prepareResult.details
              ? data.restorePreparation(decodeContract<DataToolOutcome>("DataToolOutcome", prepareResult.details), binding.prepared_sdk_tool_call_id)
              : undefined;
            completedAssistant = message;
            completedTask = location.task_ref === undefined ? undefined
              : decodeContract<EvidenceTaskRef>("EvidenceTaskRef", location.task_ref);
            renderedFinal = {sdkId: binding.prepared_sdk_tool_call_id, display: location.display, sourceText,
              taskRef: completedTask, sources: restored?.sources ?? [], first: Number(binding.first_chunk_seq),
              recoveredBinding: binding};
          }
        }
        recoveredControlReady = message.content.filter(part => part.type === "text").map(part => part.text).join("") === workspace?.control()?.text;
      }
      const lastTool = current.flatMap(entry => entry.messages).findLast(message => message.role === "toolResult");
      // 后续工具/错误使原候选失效；只恢复最后已消费的成功答案，pending调用仍走上面的原操作接回。
      if (data && lastTool?.role === "toolResult" && !lastTool.isError && lastTool.toolName === "present_analysis_answer"
        && (!message || (message.role === "assistant" && !["error", "aborted", "length"].includes(message.stopReason)))) {
        const call = branch.flatMap(entry => entry.type === "message" && entry.message.role === "assistant"
          ? entry.message.content.filter(part => part.type === "toolCall") : []).findLast(call => call.id === lastTool.toolCallId);
        if (call && lastTool.details) await data.restoreAnswer(call.id, call.arguments,
          decodeContract<DataToolOutcome>("DataToolOutcome", lastTool.details));
      }
      // 尚无完整正文时接回原已登记成功的prepare；普通读取/保存不清准备表，有效性由任务/条件核验承担。
      if (data && !renderedFinal) {
        const prepareTool = current.flatMap(entry => entry.messages).findLast(tool =>
          tool.role === "toolResult" && !tool.isError && tool.toolName === "prepare_analysis_answer");
        if (prepareTool?.role === "toolResult" && prepareTool.details)
          data.restorePreparation(decodeContract<DataToolOutcome>("DataToolOutcome", prepareTool.details), prepareTool.toolCallId);
      }
    }
    const resumedDelivery = selectDelivery();
    const recoveredReady = run.resume_same_input && (Boolean(resumedDelivery?.grounded)
      || Boolean(resumedDelivery?.rendered)
      || Boolean(resumedDelivery?.natural && completedBinding)
      || (recoveredControlReady && Boolean(resumedDelivery?.control)) || (!needsResultAnswer() && allTasksFrozen()));
    if (!recoveredReady) {
    if (data && run.model_profile?.toolset === "data") {
      const payloadLimit = run.model_profile.payload_bytes_limit ?? 65536;
      let legacyKeepRecentTokens: number | undefined;
      if (capacityPlan) {
        // 装不下固定部分的容量配置直接拒绝，不靠反复摘要解决。
        capacity?.check();
      } else {
        const availableBytes = payloadLimit -
          estimateRequestBytes(session.systemPrompt, [], activeTools(), workspace?.contents() ?? [], run.text);
        // Pi按字符/4估算token；结合JSON转义余量选择尾部目标，只是启发式，不是硬字节保证。
        const requestKeepRecentTokens = Math.min(keepRecentTokens, Math.max(128, Math.floor(availableBytes / 24)));
        legacyKeepRecentTokens = requestKeepRecentTokens;
        const requestCompaction = {compaction: {keepRecentTokens: requestKeepRecentTokens}};
        // 大历史先保留较多尾部，避免初始摘要请求自身超限；小历史从预检起就使用本轮目标。
        if (estimateRequestBytes("", history, [], [], "") <= payloadLimit - 4096)
          settings.applyOverrides(requestCompaction);
      }
      // 完整提示/资料/历史先作保守预检；实际载荷仍由provider在预留/发送前检查。
      if (history.length > 2 && estimateRequestBytes(session.systemPrompt, history, activeTools(), workspace?.contents() ?? [], run.text) > payloadLimit - 4096) {
        try {
          onStage?.('native_compaction');
          await session.compact();
        } catch (error) {
          capacity?.check();
          // Pi未公开canCompact；这两个无摘要可做的结果交给最终载荷检查，其余失败照常传播。
          if (!(error instanceof Error) || !["Already compacted", "Nothing to compact (session too small)"].includes(error.message))
            throw error;
        }
      }
      if (legacyKeepRecentTokens !== undefined)
        settings.applyOverrides({compaction: {keepRecentTokens: legacyKeepRecentTokens}});
    }
    onStage?.('session_prompt');
    if (run.resume_same_input && manager.buildSessionContext().messages.length)
      // prompt先刷新Pi当前资源；恢复通知不改变宿主输入、任务、操作或预算身份。
      await session.prompt(
        RECOVERY_NOTICE + " 继续处理原输入。已接回的工具结果保持有效，不重新建立任务或重做已成功操作。",
        { expandPromptTemplates: false },
      );
    else await session.prompt(run.text, { expandPromptTemplates: false });
    await output.drain();
    if (checkpointFailure) throw checkpointFailure;
    projection?.check();
    if (data && process.env.DATA_AGENT_TEST_COMPACT === "1")
      await session.compact();
    }
    const commitAnswer = async (): Promise<void> => {
      onStage?.('answer_delivery');
      await output.drain();
      if (checkpointFailure) throw checkpointFailure;
      // SDK可移除length等消息以整理上下文；交付必须检查实际最近完成的消息事件。
      const final = completedAssistant;
      if (
        final?.role === "assistant" &&
        (final.stopReason === "error" || final.stopReason === "aborted")
      ) {
        const safeCodes = new Set(["model_timeout", "model_auth_failed", "model_rate_limited", "model_service_unavailable", "model_network_error", "model_quota_exhausted", "model_retry_exhausted", "model_request_failed", "model_budget_exhausted", "model_usage_unknown", "model_usage_invalid", "model_input_limit", "model_output_limit", "model_limits_exceeded", "model_finalize_unconfirmed", "model_unavailable", "stale_context", "request_too_large: model_input_limit", "run_cancelled"]);
        const code = safeCodes.has(final.errorMessage ?? "") ? final.errorMessage : "model_run_failed";
        throw Object.assign(new Error("model_run_failed"), { code });
      }
      if (signal.aborted) throw new Error("run_cancelled");
      if (final?.role === "assistant" && final.stopReason === "length")
        throw new Error("model_output_limit");
      // 当前任务已显式定稿时只提交原绑定；冻结后新生成的一条合法渲染尾项除外。
      const finalizedParts = data?.answerParts() ?? [];
      const activeTask = run.workspace_context?.active_task_ref;
      const selectedDelivery = selectDelivery();
      if (!needsResultAnswer()
        && !selectedDelivery?.grounded && !selectedDelivery?.rendered && !selectedDelivery?.natural && !selectedDelivery?.control
        && (allTasksFrozen() || (activeTask && finalizedParts.some(part => part.task_ref.task_id === activeTask.task_id
          && part.task_ref.condition_version === activeTask.condition_version)))) {
        await transport.post("/internal/finish", "FinishRun", {
          ...transport.binding(), commit_id: run.output_id,
          answer_parts: [finalizedParts[0]!, ...finalizedParts.slice(1)],
          checkpoint: exportCheckpoint(manager, run.workspace_context?.authority_revision, run.workspace_context?.authority_snapshot),
        });
        return;
      }
      // 先处理真实模型失败/截断，再要求成功结果的来源正文；失败通知正常解释状态。
      if (data && needsResultAnswer()) {
        await session.sendCustomMessage({customType: "data_agent_answer_sources", display: false,
          content: "本轮是查询结果解释。请按原查询所属任务和条件核对get_query实际结果，先用prepare_analysis_answer绑定数值（数字、日期、行数通过values绑定，未返回的派生值不补算），再在下一条正文用{{name}}原样引用绑定值写出完整说明。其他任务已定稿的部分保留，需切任务时沿原route；不要重复执行查询。", details: {message_id: run.message_id}}, {triggerTurn: true});
        if (needsResultAnswer()) throw new Error("answer_sources_required");
        return commitAnswer();
      }
      // 正常完整说明独立于SQL等待状态；无可用正文时才采用合法宿主控制事实。
      const {grounded, rendered, natural, control} = selectedDelivery ?? {};
      // 只提交最后任务的原文；已经冻结的部分由Rust沿原引用读取和组合。
      if (!grounded && !rendered && !control && (final?.stopReason !== "stop" || final.content.some(part => part.type === "toolCall")))
        throw new Error("answer_message_incomplete");
      // v2正文已开始的{{标记必须全部对应已核bindings；未知/未闭合/超限沿Pi纠正语义交回一次。
      if (!grounded && !rendered && natural
        && (renderInvalid || natural.includes("{{")))
        throw new Error("answer_render_invalid");
      const finalText = grounded?.text ?? rendered?.display ?? natural ?? control?.text ?? "";
      if (!finalText) throw new Error("no final output");
      if (grounded || rendered || control) applyDeliveryContext(manager, finalText, previousEntryIds);
      if (control) {
        // 正文和引用由宿主投影与已冻结part组成；未核验的模型末条不进入正式交付。
        await output.drain();
        if (fault === "before_checkpoint_commit") process.exit(75);
        await transport.post("/internal/finish", "FinishRun", {
          ...transport.binding(),
          commit_id: run.output_id,
          final_text: control.text,
          control_delivery_ref: {fingerprint: control.fingerprint},
          checkpoint: exportCheckpoint(
            manager,
            run.workspace_context?.authority_revision,
            run.workspace_context?.authority_snapshot,
          ),
        });
        return;
      }
      let renderedBinding: RenderedAnswerBinding | undefined;
      if (grounded) {
        finalStartChunk = output.startMessage();
      } else if (rendered) {
        // 展示chunks已在流式期间按展示文本写入；此处只绑定范围并留恢复记录，不重复追加正文。
        if (rendered.recoveredBinding) renderedBinding = rendered.recoveredBinding;
        else {
          const lastChunk = await output.drain();
          renderedBinding = {assistant: assistantOutputBinding(manager, run.attempt_id),
            source_text: rendered.sourceText, prepared_sdk_tool_call_id: rendered.sdkId,
            first_chunk_seq: String(rendered.first), last_chunk_seq: String(lastChunk)};
          if (Number(renderedBinding.last_chunk_seq) < Number(renderedBinding.first_chunk_seq))
            throw new Error("answer_output_incomplete");
          // custom仅保存原位置与展示正文；恢复沿rendered_binding接原binding和指定prepare回执。
          const renderedTask = rendered.taskRef ?? completedTask;
          manager.appendCustomEntry("data_agent_output_binding", {
            message_id: run.message_id, recovery_chain_id: run.recovery_chain_id,
            ...(renderedTask ? {task_ref: renderedTask} : {}), rendered_binding: renderedBinding, display: rendered.display,
          });
        }
      } else if (!completedBinding) {
        if (messageDeferred) {
          finalStartChunk = output.startMessage();
          messageOutputStart = finalStartChunk;
          output.append(finalText);
        }
        const lastChunk = await output.drain();
        completedBinding = assistantOutputBinding(manager, run.attempt_id,
          messageOutputStart === undefined ? undefined : {first: messageOutputStart, last: lastChunk});
        if (completedBinding.stop_reason !== "stop" || completedBinding.tool_call_ids.length
          || !completedBinding.first_chunk_seq || !completedBinding.last_chunk_seq)
          throw new Error("answer_output_incomplete");
        // custom仅保存原位置；正文仍取Pi原助手条目和Rust已持久片段。
        manager.appendCustomEntry("data_agent_output_binding", {
          message_id: run.message_id, recovery_chain_id: run.recovery_chain_id,
          ...(completedTask ? {task_ref: completedTask} : {}), output_binding: completedBinding,
        });
      }
      await output.drain();
      const frozen = data?.answerParts() ?? [];
      let answerParts: [AnswerPartReference, ...AnswerPartReference[]] | undefined;
      if (frozen.length) {
        // 结果通知的答案沿原查询任务/条件作为末项，不包装成route后的新版本。
        const task = notificationAnswer()
          ? notificationTask ?? run.workspace_context?.active_task_ref
          : run.workspace_context?.active_task_ref;
        if (!task) throw new Error("task_context_required");
        const owner = rendered ? rendered.taskRef ?? completedTask : completedTask;
        if (!grounded && (owner?.task_id !== task.task_id || owner.condition_version !== task.condition_version))
          throw new Error("answer_task_mismatch");
        const last: AnswerPartReference = grounded
          ? {task_ref: task, answer_sdk_tool_call_id: grounded.sdkId}
          : rendered
            ? {task_ref: task, rendered_answer_binding: renderedBinding!}
            : {task_ref: task, output_binding: completedBinding};
        if (last.output_binding && (last.output_binding.stop_reason !== "stop" || last.output_binding.tool_call_ids.length
          || !last.output_binding.first_chunk_seq || !last.output_binding.last_chunk_seq))
          throw new Error("answer_output_incomplete");
        answerParts = [frozen[0]!, ...frozen.slice(1), last];
      }
      if (fault === "before_checkpoint_commit") process.exit(75);
      await transport.post("/internal/finish", "FinishRun", {
        ...transport.binding(),
        commit_id: run.output_id,
        final_text: finalText,
        ...(answerParts ? {answer_parts: answerParts}
          : grounded ? {answer_sdk_tool_call_id: grounded.sdkId, final_start_chunk_seq: String(finalStartChunk)}
          : rendered ? {rendered_answer_binding: renderedBinding!}
          : {output_binding: completedBinding}),
        checkpoint: exportCheckpoint(
          manager,
          run.workspace_context?.authority_revision,
          run.workspace_context?.authority_snapshot,
        ),
      });
    };
    try {
      const reportHint = !notification && completedAssistant?.stopReason === "stop" && workspace?.reportRevisionHint();
      if (reportHint && !signal.aborted && !allTasksFrozen()) {
        // 原生续轮一次，继续使用本条用户消息、原任务和现有工具账本。
        await session.sendCustomMessage({customType: "data_agent_report_revision", display: false,
          content: reportHint, details: {message_id: run.message_id}}, {triggerTurn: true});
      }
      await commitAnswer();
    } catch (error) {
      if (!data || !(error instanceof Error)
        || !["message_pending", "model_output_limit", "answer_render_invalid"].includes(error.message)) throw error;
      if (signal.aborted) throw new Error("run_cancelled");
      // 明确未提交的交付拒绝交回Pi一次；不替模型登记任务，也不重做未知提交。
      await session.sendCustomMessage({
        customType: "data_agent_delivery_rejected",
        content: error.message === "message_pending"
          ? "宿主拒绝本次交付：message_pending，当前原始用户消息尚未通过update_analysis_task登记归属。原回答尚未正式提交。请基于原消息及已取得资料，自主登记新任务或归属已有任务；如需要澄清，先持久保存question和options，再用中文回复用户。沿用已有任务和工具回执，不重建已成功操作。完成后重新给出完整回答。"
          : error.message === "answer_render_invalid"
          ? "宿主拒绝本次交付：answer_render_invalid，正文中的{{name}}标记未全部对应已核bindings或未正确闭合。原回答尚未正式提交。请仅引用prepare_analysis_answer回执中已核定的绑定名，在下一条消息重新写出完整中文正文；文字与数字来自绑定值，不自行改写或补算。沿用已有任务、工具回执与准备结果，不重复已成功操作。"
          : "宿主拒绝本次交付：model_output_limit，模型明确报告输出被长度上限截断，原回答尚未正式提交。请围绕原用户问题和已查资料，重新给出更简洁但完整的中文回答，不承接半句话。保留已成功的任务和工具回执，不重复已成功操作；沿原消息和预算继续。",
        display: false,
        details: { message_id: run.message_id, recovery_chain_id: run.recovery_chain_id },
      }, { triggerTurn: true });
      await commitAnswer();
    }
  } catch (error) {
    // 合成验收可保存本轮最后的SDK状态，包含执行前被拒绝的工具参数；普通服务日志不输出正文。
    if (error instanceof Error) {
      try {
        Object.assign(error, { checkpoint: exportCheckpoint(
          manager, run.workspace_context?.authority_revision, run.workspace_context?.authority_snapshot, true,
        ) });
      } catch (checkpointError) {
        // 落盘失败后不能发布内存leaf，也不能用诊断导出错误替换原失败。
        Object.assign(error, { checkpointError });
      }
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    session.dispose();
    await output.close();
  }
}

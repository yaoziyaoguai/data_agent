import {
  createAgentSession,
  ModelRuntime,
  SettingsManager,
  convertToLlm,
} from "@earendil-works/pi-coding-agent";
import {
  InMemoryModelsStore,
  type AssistantMessage,
  type CredentialStore,
} from "@earendil-works/pi-ai";
import type {
  RunEnvelope,
  TaskInput,
  Checkpoint,
} from "../../../packages/contracts/generated/boundary.ts";
import { RustTransport } from "../transport/client.ts";
import { dataTools } from "../tools/data-tools.ts";
import { taskTool } from "../tools/update-analysis-task.ts";
import {
  guardedDeepSeekStream,
  connectionFromEnvironment,
} from "../provider/deepseek.ts";
import { mockStream } from "../provider/mock.ts";
import { resources } from "./resources.ts";
import { restoreCheckpoint, exportCheckpoint, RECOVERY_NOTICE } from "./checkpoint.ts";
import { decodeContract } from "../../../packages/contracts/validate.ts";

export async function deliver(
  run: RunEnvelope,
  apiUrl: string,
  token: string,
  fault: string,
  signal: AbortSignal = new AbortController().signal,
) {
  const transport = new RustTransport(run, apiUrl, token);
  let checkpoint=run.checkpoint;
  if(checkpoint?.storage?.kind==='host_checkpoint') {
    const saved=decodeContract<Checkpoint>('Checkpoint',await transport.post('/internal/checkpoints/read','ReadCheckpoint',transport.binding(),checkpoint.storage.fingerprint));
    if(saved.leaf_id!==checkpoint.leaf_id||saved.storage)throw new Error('checkpoint_conflict');
    checkpoint=saved;
  }
  const manager = restoreCheckpoint("/synthetic/data-agent", checkpoint);
  const tool = taskTool(transport, manager, fault);
  const data = run.workspace_context
    ? dataTools(transport, manager, fault)
    : null;
  // SDK不能直接续接以assistant工具调用结尾的半轮；只接回已登记调用，不重新规划。
  const messages = manager.buildSessionContext().messages;
  const assistantIndex = messages.findLastIndex(message => message.role === "assistant");
  const last = messages[assistantIndex];
  if (run.resume_same_input && last?.role === "assistant") {
    const completed = new Set(messages.slice(assistantIndex + 1).filter(message => message.role === "toolResult").map(message => message.toolCallId));
    const calls = last.content.filter((c) => c.type === "toolCall").filter((c) => !completed.has(c.id));
    for (const call of calls) {
      // SDK正常工具循环会把参数/工具名拒绝作为结果交给模型；恢复也需保持这个行为。
      // 仅捕获执行前本地校验，登记或提交未知仍抛出并沿原身份恢复。
      let rejected = false;
      try {
        if (data) data.validateArguments(call.name, call.arguments);
        else {
          if (call.name !== "update_analysis_task") throw new Error("tool_not_allowed");
          decodeContract<TaskInput>("TaskInput", call.arguments);
        }
      } catch { rejected = true; }
      if (rejected) {
        manager.appendMessage({ role: "toolResult", toolCallId: call.id, toolName: call.name,
          content: [{ type: "text", text: JSON.stringify({error: "invalid_tool_arguments", message: "工具名或参数不符合当前契约；本次调用未执行，请使用允许的工具和完整参数修正。"}) }],
          isError: true, timestamp: Date.now(),
        });
        continue;
      }
      const receipt = data
        ? await data.invokeRecorded(call.name, call.id, call.arguments)
        : await tool.invokeRecorded(
            call.id,
            decodeContract<TaskInput>("TaskInput", call.arguments),
          );
      manager.appendMessage({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              data && "data" in receipt ? receipt.data : receipt,
            ),
          },
        ],
        details: JSON.parse(JSON.stringify(receipt)),
        isError: !!(data && "data" in receipt && receipt.data.error),
        timestamp: Date.now(),
      });
    }
  }
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
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    modelsStore: new InMemoryModelsStore(),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  let model;
  if (run.model_profile) {
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
              ? run.model_profile.input_limit
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
      streamSimple: mockStream(transport, delayMs),
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
    compaction: {
      enabled: !!data,
      reserveTokens: 2048,
      keepRecentTokens: run.model_profile?.toolset === "data" ? keepRecentTokens : 4000,
    },
    retry: { enabled: false },
  });
  const { session } = await createAgentSession({
    cwd: "/synthetic/data-agent",
    modelRuntime: runtime,
    model,
    thinkingLevel: run.model_profile?.thinking_level ?? "off",
    settingsManager: settings,
    sessionManager: manager,
    resourceLoader: resources(
      run.workspace_context
        ? JSON.stringify({
            ...run.workspace_context,
            authority_snapshot: undefined,
            authority_revision: undefined,
          })
        : undefined,
    ),
    tools: data ? data.tools.map((t) => t.name) : ["update_analysis_task"],
    customTools: data ? data.tools : [tool.definition],
  });
  let chunk = 0;
  let finalStartChunk = 1;
  let completedAssistant: AssistantMessage | undefined;
  let pending = Promise.resolve();
  session.subscribe((event) => {
    if (event.type === "message_start" && event.message.role === "assistant")
      finalStartChunk = chunk + 1;
    if (event.type === "message_end" && event.message.role === "assistant")
      completedAssistant = event.message;
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      const delta = event.assistantMessageEvent.delta;
      const chunk_seq = String(++chunk);
      pending = pending.then(async () => {
        await transport.post("/internal/outputs", "AppendOutput", {
          ...transport.binding(),
          chunk_seq,
          text: delta,
        });
      });
      void pending.catch(() => {}); // 先登记拒绝处理；运行结束仍会await并拒绝提交。
    }
  });
  const abort = () => {
    void session.abort();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const visibleContext = run.workspace_context ? JSON.stringify({...run.workspace_context,authority_snapshot:undefined,authority_revision:undefined}) : "";
    const estimatedBytes = historyBytes + Buffer.byteLength(visibleContext) + Buffer.byteLength(run.text) + Buffer.byteLength(JSON.stringify(data?.tools.map(({name,description,parameters})=>({name,description,parameters})) ?? [])) + 4096;
    // 空闲提交前调用SDK摘要；活动轮内由Pi的overflow compact-and-retry处理。
    if(data && run.model_profile?.toolset==="data" && history.length>2 && estimatedBytes>(run.model_profile.payload_bytes_limit??65536)-4096) await session.compact();
    if (run.resume_same_input && manager.buildSessionContext().messages.length)
      // prompt先刷新Pi当前资源；恢复通知不改变宿主输入、任务、操作或预算身份。
      await session.prompt(
        RECOVERY_NOTICE + " 继续处理原输入。已接回的工具结果保持有效，不重新建立任务或重做已成功操作。",
        { expandPromptTemplates: false },
      );
    else await session.prompt(run.text);
    await pending;
    if (data && process.env.DATA_AGENT_TEST_COMPACT === "1")
      await session.compact();
    const commitAnswer = async () => {
      await pending;
      // SDK可移除length等消息以整理上下文；交付必须检查实际最近完成的消息事件。
      const final = completedAssistant;
      if (
        final?.role === "assistant" &&
        (final.stopReason === "error" || final.stopReason === "aborted")
      ) {
        const safeCodes = new Set(["model_timeout", "model_auth_failed", "model_rate_limited", "model_request_failed", "model_budget_exhausted", "model_usage_unknown", "model_usage_invalid", "model_input_limit", "model_limits_exceeded", "model_finalize_unconfirmed", "request_too_large: model_input_limit", "run_cancelled"]);
        const code = safeCodes.has(final.errorMessage ?? "") ? final.errorMessage : "model_run_failed";
        throw Object.assign(new Error("model_run_failed"), { code });
      }
      if (signal.aborted) throw new Error("run_cancelled");
      if (final?.role === "assistant" && final.stopReason === "length")
        throw new Error("model_output_limit");
      // Pi工具调查可以有多条助手消息；正式回答只取本轮最后一条，过程仍留在事件中。
      const finalText = final?.role === "assistant"
        ? final.content.filter(part=>part.type==="text").map(part=>part.text).join("")
        : "";
      if (!finalText) throw new Error("no final output");
      if (fault === "before_checkpoint_commit") process.exit(75);
      await transport.post("/internal/finish", "FinishRun", {
        ...transport.binding(),
        commit_id: run.output_id,
        final_text: finalText,
        final_start_chunk_seq: String(finalStartChunk),
        checkpoint: exportCheckpoint(
          manager,
          run.workspace_context?.authority_revision,
          run.workspace_context?.authority_snapshot,
        ),
      });
    };
    try {
      await commitAnswer();
    } catch (error) {
      if (!data || !(error instanceof Error) || !["message_pending", "model_output_limit"].includes(error.message)) throw error;
      if (signal.aborted) throw new Error("run_cancelled");
      // 明确未提交的交付拒绝交回Pi一次；不替模型登记任务，也不重做未知提交。
      await session.sendCustomMessage({
        customType: "data_agent_delivery_rejected",
        content: error.message === "message_pending"
          ? "宿主拒绝本次交付：message_pending，当前原始用户消息尚未通过update_analysis_task登记归属。原回答尚未正式提交。请基于原消息及已取得资料，自主登记新任务或归属已有任务；如需要澄清，先持久保存question和options，再用中文回复用户。沿用已有任务和工具回执，不重建已成功操作。完成后重新给出完整回答。"
          : "宿主拒绝本次交付：model_output_limit，模型明确报告输出被长度上限截断，原回答尚未正式提交。请围绕原用户问题和已查资料，重新给出更简洁但完整的中文回答，不承接半句话。保留已成功的任务和工具回执，不重复已成功操作；沿原消息和预算继续。",
        display: false,
        details: { message_id: run.message_id, recovery_chain_id: run.recovery_chain_id },
      }, { triggerTurn: true });
      await commitAnswer();
    }
  } catch (error) {
    // 合成验收可保存本轮最后的SDK状态，包含执行前被拒绝的工具参数；普通服务日志不输出正文。
    if (error instanceof Error) Object.assign(error, { checkpoint: exportCheckpoint(
      manager, run.workspace_context?.authority_revision, run.workspace_context?.authority_snapshot,
    ) });
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    session.dispose();
  }
}

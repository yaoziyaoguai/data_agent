import { syntheticAction } from "./synthetic-analysis.ts";
import { randomUUID } from "node:crypto";
import {
  getCurrentTools,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type TranscriptContext,
  type Model,
  type Api,
} from "@earendil-works/pi-ai";
import { RustTransport } from "../transport/client.ts";
import { isRecoveryNotice } from "../session/checkpoint.ts";

// 模拟模型仅生成SDK消息；任务、回执、运行和输出都通过真实宿主入口保存。
export function mockStream(transport: RustTransport, delayMs = 0) {
  return (model: Model<Api>, context: TranscriptContext) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      const call_attempt_id = randomUUID();
      const binding = { ...transport.binding(), call_attempt_id };
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [],
        stopReason: "stop",
        timestamp: Date.now(),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      try {
        await transport.post("/internal/model/issue", "ModelAttempt", binding);
        if (delayMs)
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        stream.push({ type: "start", partial: message });
        // Pi恢复后可能追加system配置消息；模拟模型按最后一条业务消息继续。
        const last = context.messages.findLast(
          (message) => message.role !== "system" && !isRecoveryNotice(message),
        );
        if (!getCurrentTools(context.messages).length) {
          const text =
            "本地合成摘要：已完成若干任务；当前条件、SQL与查询身份以宿主工具为准，继续前按需要查证。";
          message.content.push({ type: "text", text });
          stream.push({
            type: "text_start",
            contentIndex: 0,
            partial: message,
          });
          stream.push({
            type: "text_delta",
            contentIndex: 0,
            delta: text,
            partial: message,
          });
          stream.push({
            type: "text_end",
            contentIndex: 0,
            content: text,
            partial: message,
          });
        } else if (transport.run.workspace_context) {
          const action = syntheticAction(transport.run, context);
          if ("tool" in action) {
            const call = {
              type: "toolCall" as const,
              id: randomUUID(),
              name: action.tool,
              arguments: action.args,
            };
            message.content.push(call);
            message.stopReason = "toolUse";
            stream.push({
              type: "toolcall_start",
              contentIndex: 0,
              partial: message,
            });
            stream.push({
              type: "toolcall_end",
              contentIndex: 0,
              toolCall: call,
              partial: message,
            });
          } else {
            message.content.push({ type: "text", text: action.text });
            stream.push({
              type: "text_start",
              contentIndex: 0,
              partial: message,
            });
            stream.push({
              type: "text_delta",
              contentIndex: 0,
              delta: action.text,
              partial: message,
            });
            stream.push({
              type: "text_end",
              contentIndex: 0,
              content: action.text,
              partial: message,
            });
          }
        } else if (last?.role === "toolResult") {
          if (last.isError) throw new Error("tool result failed");
          const content = last.content.find((c) => c.type === "text");
          if (!content || content.type !== "text")
            throw new Error("missing tool receipt");
          const receipt = JSON.parse(content.text);
          const text = `已建立分析任务：${receipt.task_id}。目标已保存，条件版本为 ${receipt.condition_version}。当前为本地模拟模型演示，尚未生成或执行 SQL。`;
          message.content.push({ type: "text", text: "" });
          stream.push({
            type: "text_start",
            contentIndex: 0,
            partial: message,
          });
          message.content[0] = { type: "text", text };
          stream.push({
            type: "text_delta",
            contentIndex: 0,
            delta: text,
            partial: message,
          });
          stream.push({
            type: "text_end",
            contentIndex: 0,
            content: text,
            partial: message,
          });
        } else {
          const user = [...context.messages]
            .reverse()
            .find((m) => m.role === "user");
          const goal =
            typeof user?.content === "string"
              ? user.content
              : user?.content.find((c) => c.type === "text")?.text;
          if (!goal) throw new Error("missing input");
          const call = {
            type: "toolCall" as const,
            id: randomUUID(),
            name: "update_analysis_task",
            arguments: { action: "create_task", goal },
          };
          message.content.push(call);
          message.stopReason = "toolUse";
          stream.push({
            type: "toolcall_start",
            contentIndex: 0,
            partial: message,
          });
          stream.push({
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: call,
            partial: message,
          });
        }
        await transport.post("/internal/model/settle", "ModelAttempt", binding);
        stream.push({
          type: "done",
          reason: message.stopReason as "stop" | "toolUse",
          message,
        });
      } catch (error) {
        message.stopReason = "error";
        message.errorMessage =
          error instanceof Error ? error.message : "provider failed";
        stream.push({ type: "error", reason: "error", error: message });
      }
    })();
    return stream;
  };
}

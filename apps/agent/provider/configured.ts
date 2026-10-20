import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
  ModelThinkingLevel,
  ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import type {
  ModelConnection,
  ModelProfile,
} from "../../../packages/contracts/generated/boundary.ts";
import { decodeContract } from "../../../packages/contracts/validate.ts";
import type { RustTransport } from "../transport/client.ts";
import { guardedModelStream } from "./controlled.ts";

export async function configuredModel(
  runtime: ModelRuntime,
  transport: RustTransport,
  profile: ModelProfile,
  signal: AbortSignal,
) {
  const connection = decodeContract<ModelConnection>(
    "ModelConnection",
    await transport.post(
      "/internal/model/connection",
      "ReadModelConnection",
      transport.binding(),
    ),
  );
  if (
    connection.api !== profile.configured_model?.api ||
    connection.provider_id !== profile.provider_id
  )
    throw new Error("provider_configuration_invalid");
  const candidate = runtime.getModel(connection.provider_id, profile.model_id);
  const known = candidate?.api === connection.api ? candidate : undefined;
  // 当前消息只有一个宿主冻结档位；SDK不得将它静默降为另一个档位。
  const level = profile.thinking_level ?? "off";
  if (
    known?.thinkingLevelMap?.[level] === null ||
    (known && !known.reasoning && level !== "off")
  )
    throw new Error("provider_configuration_invalid");
  const thinkingLevelMap: ThinkingLevelMap = Object.fromEntries(
    (
      [
        "off",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ] satisfies ModelThinkingLevel[]
    ).map((item) => [
      item,
      item === level
        ? (known?.thinkingLevelMap?.[item] ?? (item === "off" ? "none" : item))
        : null,
    ]),
  );
  const compat = known?.compat;
  if (
    connection.api === "anthropic-messages" &&
    level !== "off" &&
    profile.configured_model.anthropic_thinking_mode !== "adaptive" &&
    ((compat &&
      "forceAdaptiveThinking" in compat &&
      compat.forceAdaptiveThinking) ||
      level === "xhigh" ||
      level === "max")
  )
    throw new Error("provider_configuration_invalid");
  // Pi按provider/api/model判断签名是否可复用，连接修订可能更换账户或供应商。
  const provider = connection.runtime_provider;
  runtime.registerProvider(provider, {
    api: connection.api,
    apiKey: connection.api_key,
    baseUrl: connection.base_url,
    streamSimple: guardedModelStream(
      transport,
      profile,
      {
        api: connection.api,
        apiKey: connection.api_key,
        baseUrl: connection.base_url,
        protocolTest: process.env.DATA_AGENT_PROVIDER_TEST === "1",
      },
      signal,
    ),
    models: [
      {
        id: profile.model_id,
        name: profile.model_id,
        api: connection.api,
        input: ["text"],
        reasoning:
          known?.reasoning ?? profile.configured_model.reasoning_supported,
        thinkingLevelMap,
        contextWindow: profile.input_limit,
        maxTokens: profile.output_limit,
        cost: {
          input: Number(profile.configured_model.input_rate) / 1e6,
          output: Number(profile.configured_model.output_rate) / 1e6,
          cacheRead: Number(profile.configured_model.input_rate) / 1e6,
          cacheWrite: Number(profile.configured_model.input_rate) / 1e6,
        },
        ...(connection.api === "openai-completions"
          ? {
              compat: {
                ...compat,
                supportsStrictMode: false,
                ...(connection.provider_id === "deepseek"
                  ? ({
                      thinkingFormat: "deepseek",
                      maxTokensField: "max_tokens",
                      supportsReasoningEffort: true,
                    } as const)
                  : {}),
              },
            }
          : connection.api === "anthropic-messages"
            ? {
                compat: {
                  ...compat,
                  forceAdaptiveThinking:
                    profile.configured_model.anthropic_thinking_mode ===
                    "adaptive",
                  // 工具集合与模型身份由宿主固定，不能隐式增加SDK工具或回退供应商模型。
                  supportsMidConvoToolChanges: false,
                  supportsMidConvoEffort: false,
                  allowedFallbackModels: [],
                },
              }
            : compat
              ? { compat }
              : {}),
      },
    ],
  });
  return runtime.getModel(provider, profile.model_id);
}

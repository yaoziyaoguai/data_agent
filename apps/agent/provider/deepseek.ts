import type { ModelProfile } from "../../../packages/contracts/generated/boundary.ts";
import type { RustTransport } from "../transport/client.ts";
import { guardedModelStream } from "./controlled.ts";
export interface DeepSeekConnection {
  apiKey: string;
  baseUrl: string;
  protocolTest: boolean;
}

export function connectionFromEnvironment(): DeepSeekConnection {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const baseUrl = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
  const protocolTest = process.env.DATA_AGENT_PROVIDER_TEST === "1";
  const url = new URL(baseUrl);
  if (
    !apiKey ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (!protocolTest && baseUrl !== "https://api.deepseek.com") ||
    (protocolTest && (url.hostname !== "127.0.0.1" || url.protocol !== "http:"))
  ) {
    throw new Error("provider_configuration_invalid");
  }
  return { apiKey, baseUrl, protocolTest };
}

export function guardedDeepSeekStream(
  transport: RustTransport,
  profile: ModelProfile,
  connection: DeepSeekConnection,
  signal: AbortSignal,
) {
  return guardedModelStream(
    transport,
    profile,
    { ...connection, api: "openai-completions" },
    signal,
  );
}

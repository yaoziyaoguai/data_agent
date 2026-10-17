import { createHash, randomUUID } from 'node:crypto';
import { createAssistantMessageEventStream, type Api, type Model, type SimpleStreamOptions, type TranscriptContext } from '@earendil-works/pi-ai';
import { streamSimple as sdkStream } from '@earendil-works/pi-ai/api/openai-completions';
import { isRetryableAssistantError } from '@earendil-works/pi-ai/compat';
import type { FinalizeModelCall, ModelCallReceipt, ModelProfile } from '../../../packages/contracts/generated/boundary.ts';
import { decodeContract } from '../../../packages/contracts/validate.ts';
import { RustTransport } from '../transport/client.ts';
import contractSchema from '../../../packages/contracts/schema.json' with { type: 'json' };

const dataToolNames = new Set<string>(contractSchema.$defs.DataToolInvocation.properties.tool_name.enum);

export interface DeepSeekConnection {
  apiKey: string;
  baseUrl: string;
  protocolTest: boolean;
}

export function connectionFromEnvironment(): DeepSeekConnection {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const baseUrl = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';
  const protocolTest = process.env.DATA_AGENT_PROVIDER_TEST === '1';
  const url = new URL(baseUrl);
  if (!apiKey || url.username || url.password || url.search || url.hash ||
      (!protocolTest && baseUrl !== 'https://api.deepseek.com') ||
      (protocolTest && (url.hostname !== '127.0.0.1' || url.protocol !== 'http:'))) {
    throw new Error('provider_configuration_invalid');
  }
  return { apiKey, baseUrl, protocolTest };
}

// 使用SDK原生协议；HTTP层不重试，Pi会话每次重试重新领取宿主许可。
export function guardedDeepSeekStream(transport: RustTransport, profile: ModelProfile, connection: DeepSeekConnection, runSignal: AbortSignal) {
  const timeoutMs = connection.protocolTest ? Number(process.env.DATA_AGENT_MODEL_TIMEOUT_MS ?? 90000) : 90000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 90000) throw new Error('provider_configuration_invalid');
  return (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      const started = Date.now();
      const call_attempt_id = randomUUID();
      let parameters_fingerprint = '';
      let reserved = false;
      let sent = false;
      let status = 0;
      let finalized = false;
      let admissionError: string | undefined;
      let rawUsage: { input_tokens: number; output_tokens: number } | undefined;
      let settlement: FinalizeModelCall | undefined;
      let outcome: FinalizeModelCall['outcome'];
      const binding = () => ({ ...transport.binding(), call_attempt_id, parameters_fingerprint });
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = AbortSignal.any([runSignal, timeout, ...(options?.signal ? [options.signal] : [])]);
      const cancelled = () => runSignal.aborted || options?.signal?.aborted;
      const errorCode = () => admissionError ?? (cancelled() ? 'run_cancelled' : timeout.aborted ? 'model_timeout' :
        status === 401 || status === 403 ? 'model_auth_failed' : status === 429 ? 'model_rate_limited' :
        [500, 502, 503, 504].includes(status) ? 'model_service_unavailable' :
        sent && status === 0 ? 'model_network_error' : 'model_request_failed');
      const retryable = (code: string) => profile.toolset === 'data' &&
        ['model_timeout', 'model_rate_limited', 'model_service_unavailable', 'model_network_error'].includes(code);

      async function finalize(): Promise<boolean> {
        if (!reserved || !sent || finalized) return finalized;
        // 回执丢失重送原结算，不能因重算耗时改变幂等内容。
        settlement ??= { ...binding(), usage: rawUsage ? { ...rawUsage, elapsed_ms: Date.now() - started } : null,
          ...(outcome ? { outcome } : {}) };
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const receipt = decodeContract<ModelCallReceipt>('ModelCallReceipt',
              await transport.post('/internal/model/finalize', 'FinalizeModelCall', settlement));
            if (receipt.state !== (settlement.usage ? 'settled' : 'unknown')) throw new Error('model_finalize_invalid');
            finalized = true;
            return true;
          } catch { /* 只重送宿主幂等结算，不重发模型请求。 */ }
        }
        return false;
      }

      const fetchWithPermit: typeof fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const base = new URL(connection.baseUrl);
        if (url.origin !== base.origin || url.pathname !== '/chat/completions' || url.search || sent) throw new Error('provider_transport_rejected');
        const body = typeof init?.body === 'string' ? init.body : input instanceof Request ? await input.clone().text() : '';
        const actual = createHash('sha256').update(JSON.stringify(JSON.parse(body))).digest('hex');
        if (actual !== parameters_fingerprint) throw new Error('provider_parameters_changed');
        const permission = decodeContract<ModelCallReceipt>('ModelCallReceipt',
          await transport.post('/internal/model/send', 'SendModelCall', binding()));
        if (!permission.send_allowed) throw new Error('model_receipt_unknown');
        sent = true;
        const response = await fetch(input, { ...init, signal, redirect: 'error' });
        status = response.status;
        return response;
      };

      try {
        const upstream = sdkStream(model as Model<'openai-completions'>, context, {
          ...options, apiKey: connection.apiKey, maxTokens: profile.output_limit, reasoning: profile.thinking_level && profile.thinking_level !== "off" ? profile.thinking_level : undefined,
          maxRetries: 0, timeoutMs, signal, fetch: fetchWithPermit,
          onProviderStreamEvent: async chunk => {
            const usage = (chunk as { usage?: { prompt_tokens?: number; completion_tokens?: number } })?.usage;
            if (usage && Number.isSafeInteger(usage.prompt_tokens) && Number.isSafeInteger(usage.completion_tokens) &&
                usage.prompt_tokens! >= 0 && usage.completion_tokens! >= 0) {
              rawUsage = { input_tokens: usage.prompt_tokens!, output_tokens: usage.completion_tokens! };
            }
          },
          onPayload: async value => {
            if (!value || typeof value !== 'object') throw new Error('provider_payload_invalid');
            const payload = JSON.parse(JSON.stringify({ ...value, model: profile.model_id, max_tokens: profile.output_limit,
              thinking: { type: profile.thinking_level && profile.thinking_level !== 'off' ? 'enabled' : 'disabled' }, stream_options: { include_usage: true } }));
            // 用SDK实际序列化的完整载荷在预留/发送前检查；超限交回Pi原生有界压缩。
            if (!Array.isArray(payload.messages) || (profile.toolset!=='data' && payload.messages.length > 8) || (payload.tools!==undefined && !Array.isArray(payload.tools)) || (profile.toolset!=='data' && payload.tools?.length !== 1)) throw new Error('provider_payload_invalid');
            if (profile.toolset === 'data' && payload.tools !== undefined) {
              const names = payload.tools.map((tool: { function?: { name?: unknown } }) => tool?.function?.name);
              if (names.length > dataToolNames.size || new Set(names).size !== names.length || names.some((name: unknown) => typeof name !== 'string' || !dataToolNames.has(name))) throw new Error('provider_payload_invalid');
            }
            if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > (profile.payload_bytes_limit??2048)) throw new Error(profile.toolset==='data' ? 'request_too_large: model_input_limit' : 'model_input_limit');
            parameters_fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
            try {
              await transport.post('/internal/model/reserve', 'ReserveModelCall', {
                ...binding(), input_tokens_upper: profile.input_limit, output_tokens_max: profile.output_limit,
              });
            } catch (error) {
              if (error instanceof Error && error.message === 'budget_exhausted') admissionError = 'model_budget_exhausted';
              else if (error instanceof Error && error.message === 'model_retry_exhausted') admissionError = 'model_retry_exhausted';
              throw error;
            }
            reserved = true;
            return payload;
          },
        });
        for await (const event of upstream) {
          if (event.type === 'done') {
            if (!rawUsage) throw new Error('model_usage_unknown');
            const usage = event.message.usage;
            const input = usage.input + usage.cacheRead + usage.cacheWrite;
            if (input !== rawUsage.input_tokens || usage.output !== rawUsage.output_tokens) throw new Error('model_usage_invalid');
            outcome = input > profile.input_limit || usage.output > profile.output_limit ? 'permanent_error' : 'success';
            if (!(await finalize())) throw new Error('model_finalize_unconfirmed');
            if (input > profile.input_limit || usage.output > profile.output_limit) throw new Error('model_limits_exceeded');
            stream.push(event);
          } else if (event.type === 'error') {
            let code = event.error.errorMessage?.includes('request_too_large: model_input_limit') ? 'request_too_large: model_input_limit' : event.error.errorMessage === 'model_input_limit' ? 'model_input_limit' : errorCode();
            // 429中的账户额度/billing拒绝不能伪装成临时限流；原始错误仅用于SDK分类，不外传。
            if (status === 429 && !isRetryableAssistantError({ ...event.error, stopReason: 'error' })) code = 'model_quota_exhausted';
            if (code === 'model_request_failed' && sent && status === 200 && !rawUsage &&
                isRetryableAssistantError({ ...event.error, stopReason: 'error' })) code = 'model_network_error';
            if (retryable(code) && rawUsage) code = 'model_usage_unknown';
            const canRetry = retryable(code) && !rawUsage;
            // 取消也可能来自进程交接；只终止当前调用，不把原请求熔断。
            outcome = cancelled() ? undefined : canRetry ? 'transient_error' : 'permanent_error';
            if (reserved && sent && !(await finalize())) code = 'model_finalize_unconfirmed';
            // Pi用固定错误码识别临时故障；主动取消与未知结算不得触发原生重试。
            event.error.errorMessage = code;
            event.error.stopReason = cancelled() ? 'aborted' : 'error';
            event.reason = cancelled() ? 'aborted' : 'error';
            stream.push(event);
          } else {
            stream.push(event);
          }
        }
      } catch (error) {
        if (!cancelled()) outcome ??= 'permanent_error';
        await finalize();
        const reason = cancelled() ? 'aborted' as const : 'error' as const;
        const safeCodes = ['model_usage_unknown', 'model_usage_invalid', 'model_input_limit', 'model_limits_exceeded', 'model_finalize_unconfirmed', 'request_too_large: model_input_limit'];
        const message = { role: 'assistant' as const, content: [], api: model.api, provider: model.provider, model: model.id,
          stopReason: reason, timestamp: Date.now(),
          errorMessage: error instanceof Error && safeCodes.includes(error.message) ? error.message : errorCode(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: 'error', reason, error: message });
      } finally {
        await finalize();
        if (reserved && sent && !finalized) console.error('model_finalize_unconfirmed run=' + transport.run.run_id + ' attempt=' + call_attempt_id);
        stream.end();
      }
    })();
    return stream;
  };
}

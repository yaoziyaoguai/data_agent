import { createHash, randomUUID } from 'node:crypto';
import { createAssistantMessageEventStream, type Api, type Model, type SimpleStreamOptions, type TranscriptContext } from '@earendil-works/pi-ai';
import { streamSimple as sdkStream } from '@earendil-works/pi-ai/api/openai-completions';
import type { FinalizeModelCall, ModelCallReceipt, ModelProfile } from '../../../packages/contracts/generated/boundary.ts';
import { decodeContract } from '../../../packages/contracts/validate.ts';
import { RustTransport } from '../transport/client.ts';

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

// 使用SDK原生协议，每次实际fetch领取一次宿主许可，关闭SDK两层隐式重试。
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
      const binding = () => ({ ...transport.binding(), call_attempt_id, parameters_fingerprint });
      const signal = AbortSignal.any([runSignal, AbortSignal.timeout(timeoutMs), ...(options?.signal ? [options.signal] : [])]);
      const errorCode = () => admissionError ?? (runSignal.aborted ? 'run_cancelled' : signal.aborted ? 'model_timeout' :
        status === 401 || status === 403 ? 'model_auth_failed' : status === 429 ? 'model_rate_limited' : 'model_request_failed');

      async function finalize(): Promise<boolean> {
        if (!reserved || !sent || finalized) return finalized;
        // 回执丢失重送原结算，不能因重算耗时改变幂等内容。
        settlement ??= { ...binding(), usage: rawUsage ? { ...rawUsage, elapsed_ms: Date.now() - started } : null };
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
            // 保守预估门槛；服务端工具模板未公开，实际usage才是用量事实。
            if (!Array.isArray(payload.messages) || (profile.toolset!=='data' && payload.messages.length > 8) || (payload.tools!==undefined && !Array.isArray(payload.tools)) || (profile.toolset!=='data' && payload.tools?.length !== 1) || (profile.toolset==='data' && (payload.tools?.length??0)>13)) throw new Error('provider_payload_invalid');
            if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > (profile.payload_bytes_limit??2048)) throw new Error(profile.toolset==='data' ? 'request_too_large: model_input_limit' : 'model_input_limit');
            parameters_fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
            try {
              await transport.post('/internal/model/reserve', 'ReserveModelCall', {
                ...binding(), input_tokens_upper: profile.input_limit, output_tokens_max: profile.output_limit,
              });
            } catch (error) {
              if (error instanceof Error && error.message === 'budget_exhausted') admissionError = 'model_budget_exhausted';
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
            if (!(await finalize())) throw new Error('model_finalize_unconfirmed');
            if (input > profile.input_limit || usage.output > profile.output_limit) throw new Error('model_limits_exceeded');
            stream.push(event);
          } else if (event.type === 'error') {
            event.error.errorMessage = event.error.errorMessage?.includes('request_too_large: model_input_limit') ? 'request_too_large: model_input_limit' : event.error.errorMessage === 'model_input_limit' ? 'model_input_limit' : errorCode();
            await finalize();
            stream.push(event);
          } else {
            stream.push(event);
          }
        }
      } catch (error) {
        await finalize();
        const safeCodes = ['model_usage_unknown', 'model_usage_invalid', 'model_input_limit', 'model_limits_exceeded', 'model_finalize_unconfirmed', 'request_too_large: model_input_limit'];
        const message = { role: 'assistant' as const, content: [], api: model.api, provider: model.provider, model: model.id,
          stopReason: 'error' as const, timestamp: Date.now(),
          errorMessage: error instanceof Error && safeCodes.includes(error.message) ? error.message : errorCode(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: 'error', reason: 'error', error: message });
      } finally {
        await finalize();
        if (reserved && sent && !finalized) console.error('model_finalize_unconfirmed run=' + transport.run.run_id + ' attempt=' + call_attempt_id);
        stream.end();
      }
    })();
    return stream;
  };
}

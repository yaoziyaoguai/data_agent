import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {generateSummaryWithUsage} from '@earendil-works/pi-coding-agent';
import {isContextOverflow} from '@earendil-works/pi-ai/compat';
import {guardedModelStream} from '../../apps/agent/provider/controlled.ts';
import {providerEndpoint} from '../../apps/agent/provider/endpoint.ts';
import {decodeContract} from '../../packages/contracts/validate.ts';
import {deriveCapacityPlan} from '../../packages/contracts/capacity.ts';
import {modelProtocolFixture} from './model-protocol-fixture.mjs';

// 本地协议替身只提供供应商响应；摘要请求由真实Pi构造，计费/派发仍走实际受控provider。
const fixture = await modelProtocolFixture();
const checks = [], failures = [];
const originalTimeout = process.env.DATA_AGENT_MODEL_TIMEOUT_MS;
delete process.env.DATA_AGENT_MODEL_TIMEOUT_MS;

function profile(overrides = {}) {
  return {
    provider_id: 'compatible', model_id: 'synthetic/capacity', trial_id: 'synthetic',
    price_version: 'configured:model:1', context_window: 128000, input_limit: 100000,
    output_limit: 8000, payload_bytes_limit: 262144, request_timeout_ms: 1000,
    capability_source: 'admin_declared', request_call_limit: 24, budget_mode: 'request',
    toolset: 'data', thinking_level: 'off',
    configured_model: {id: 'model', version: '1', service_id: 'service', service_version: '1',
      api: 'openai-completions', input_rate: '0', output_rate: '0', reasoning_supported: false},
    ...overrides,
  };
}

function setup(value, overrides = {}) {
  const posts = [], events = [];
  const model = {
    id: value.model_id, name: 'Synthetic capacity', api: 'openai-completions',
    provider: value.provider_id, baseUrl: fixture.url + '/gateway/v1', input: ['text'],
    reasoning: value.thinking_level !== 'off', contextWindow: value.context_window ?? value.input_limit,
    maxTokens: value.output_limit, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
    compat: {thinkingFormat: 'deepseek', supportsReasoningEffort: true, maxTokensField: 'max_tokens'},
    ...overrides,
  };
  const transport = {
    run: {run_id: 'synthetic'}, binding: () => ({run_id: 'synthetic', lease_epoch: '1'}),
    async post(path, contract, input) {
      decodeContract(contract, input);
      posts.push({path, input});
      return {state: path.endsWith('/finalize') ? (input.usage ? 'settled' : 'unknown')
        : path.endsWith('/send') ? 'issued' : 'reserved', send_allowed: path.endsWith('/send')};
    },
  };
  const stream = guardedModelStream(transport, value, {
    api: model.api, apiKey: 'synthetic-only', baseUrl: model.baseUrl, protocolTest: true,
  }, new AbortController().signal);
  return {model, posts, events, stream,
    async call(context, options) {
      for await (const event of stream(model, context, options)) events.push(event);
      return events.at(-1);
    },
  };
}

async function check(name, run) {
  try { await run(); checks.push(name); }
  catch (error) { failures.push({name, error: error.message}); }
}

try {
  await check('旧profile的原生摘要采用较小输出cap和调用方思考档位，旧限额不被改写', async () => {
    const legacy = {
      provider_id: 'deepseek', model_id: 'deepseek-flash', trial_id: 'synthetic',
      price_version: '2026-10-04-peak-usd', input_limit: 65536, output_limit: 8192,
      payload_bytes_limit: 131072, request_call_limit: 24, budget_mode: 'request',
      toolset: 'data', thinking_level: 'high',
    };
    decodeContract('ModelProfile', legacy);
    const sample = setup(legacy);
    // Pi的旧reserveTokens=2048，原生历史摘要请求cap=floor(0.8*2048)=1638。
    const summary = await generateSummaryWithUsage(
      [{role: 'user', content: '合成的已完成分析，需要保留口径与下一步。', timestamp: 1}],
      sample.model, 2048, 'synthetic-only', undefined, undefined, undefined, undefined,
      'low', sample.stream,
    );
    assert.ok(summary.text.length > 0);
    const sent = fixture.requests.at(-1).body;
    assert.equal(sent.max_tokens, 1638);
    assert.equal(sent.reasoning_effort, 'low');
    assert.equal(sent.thinking.type, 'enabled');
    assert.equal(sample.posts.find(item => item.path.endsWith('/reserve')).input.output_tokens_max, 1638);
    assert.equal(legacy.output_limit, 8192);
    assert.equal(legacy.context_window, undefined);
    assert.equal(legacy.request_timeout_ms, undefined);
  });

  await check('可行的393216输出档能贯穿冻结profile、预留合同和实际payload', async () => {
    const large = profile({context_window: 2000000, input_limit: 1800000, output_limit: 393216});
    decodeContract('ModelProfile', large);
    assert.equal(typeof deriveCapacityPlan(large.context_window, large.input_limit, large.output_limit), 'object');
    const sample = setup(large);
    const result = await sample.call({messages: [{role: 'user', content: '合成容量请求', timestamp: 1}]});
    assert.equal(result.type, 'done', result.error?.errorMessage);
    assert.equal(sample.posts.find(item => item.path.endsWith('/reserve')).input.output_tokens_max, 393216);
    assert.equal(fixture.requests.at(-1).body.max_tokens, 393216);
  });

  await check('摘要自身输入超过冻结输入限额时不领取许可、不发送，错误由Pi识别为上下文超限', async () => {
    const small = profile({context_window: 16000, input_limit: 12000, output_limit: 1000});
    assert.equal(typeof deriveCapacityPlan(small.context_window, small.input_limit, small.output_limit), 'object');
    const sample = setup(small);
    const before = fixture.requests.length;
    // SDK文本估算已超过15000 tokens；摘要提示还会增加开销，不能只检查压缩结果的体积。
    const last = await sample.call({messages: [{role: 'user', content: 'synthetic '.repeat(6000), timestamp: 1}]}, {maxTokens: 500});
    assert.equal(last.type, 'error', '过大摘要请求必须在派发前被拒绝');
    assert.equal(isContextOverflow(last.error), true, last.error.errorMessage);
    assert.equal(sample.posts.length, 0, '不能为已知超限的输入领取模型许可');
    assert.equal(fixture.requests.length, before, '不能把已知超限摘要发到供应商');
    await assert.rejects(generateSummaryWithUsage(
      [{role: 'user', content: 'synthetic '.repeat(6000), timestamp: 1}],
      sample.model, 4000, 'synthetic-only', undefined, undefined, undefined, undefined,
      'off', sample.stream,
    ), /model_input_limit|context.*limit|context.*exceed|too.large/i);
    assert.equal(sample.posts.length, 0);
    assert.equal(fixture.requests.length, before);
  });

  await check('中文和JSON转义后的实际请求字节上限在许可之前检查，Pi可识别溢出', async () => {
    const sample = setup(profile({payload_bytes_limit: 65536}));
    const before = fixture.requests.length;
    const last = await sample.call({messages: [{role: 'user', content: '中文\\\"\n'.repeat(10000), timestamp: 1}]});
    assert.equal(last.type, 'error');
    assert.equal(isContextOverflow(last.error), true, last.error.errorMessage);
    assert.equal(sample.posts.length, 0);
    assert.equal(fixture.requests.length, before);
  });

  await check('供应商400/413上下文拒绝保留Pi溢出分类，原请求可继续原生压缩而非立即熔断', async () => {
    try {
      for (const [status, message] of [
        [400, "This model's maximum context length is 1000 tokens. However, your messages resulted in 2000 tokens."],
        [413, 'request_too_large: Request exceeds the maximum size'],
      ]) {
        fixture.setStatus(status, message);
        const sample = setup(profile());
        const before = fixture.requests.length;
        const result = await sample.call({messages: [{role: 'user', content: '合成短输入，由供应商报告溢出', timestamp: 1}]});
        assert.equal(result.type, 'error');
        assert.equal(result.error.errorMessage, 'request_too_large: model_input_limit');
        assert.equal(isContextOverflow(result.error), true);
        assert.equal(fixture.requests.length, before + 1, 'HTTP SDK不得自行重发');
        assert.equal(sample.posts.filter(item => item.path.endsWith('/send')).length, 1);
        const settlement = sample.posts.find(item => item.path.endsWith('/finalize')).input;
        assert.equal(settlement.outcome, 'transient_error', '不能用永久错误把原预算范围立即熔断');
        assert.equal(settlement.usage, null, '供应商无usage的拒绝保持未知结算，不伪造零费用');
      }
      fixture.setStatus(400, 'invalid_argument: unsupported synthetic parameter');
      const invalid = setup(profile());
      const error = await invalid.call({messages: [{role: 'user', content: '普通参数错误', timestamp: 1}]});
      assert.equal(error.type, 'error');
      assert.equal(isContextOverflow(error.error), false, '普通400不能伪装上下文溢出');
      assert.equal(invalid.posts.find(item => item.path.endsWith('/finalize')).input.outcome, 'permanent_error');
    } finally { fixture.setStatus(200); }
  });

  await check('实际Undici dispatcher允许等待首响应并响应请求AbortSignal', async () => {
    let arrivals = 0, releaseArrival;
    const arrival = () => new Promise(resolve => { releaseArrival = resolve; });
    const server = createServer(async (request, response) => {
      arrivals++;
      releaseArrival?.();
      if (request.url === '/wait') {
        await delay(150);
        if (!response.destroyed) response.writeHead(200).end('synthetic ready');
      } else if (request.url === '/body') {
        response.writeHead(200, {'content-type': 'text/plain'});
        response.write('synthetic prefix');
      }
      // /cancel不发headers，用实际连接证明取消可终止首响应等待。
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const endpoint = providerEndpoint('http://127.0.0.1:' + server.address().port, true);
    const baseUrl = 'http://127.0.0.1:' + server.address().port;
    try {
      const started = performance.now();
      const response = await endpoint.fetch(baseUrl + '/wait', {signal: AbortSignal.timeout(2000)});
      assert.equal(await response.text(), 'synthetic ready');
      assert.ok(performance.now() - started >= 140, '响应确实等待了本地合成首事件');
      const controller = new AbortController();
      const arrived = arrival();
      const pending = endpoint.fetch(baseUrl + '/cancel', {signal: controller.signal});
      // 立即装上拒绝处理，避免连接提前失败形成未处理的Promise拒绝。
      const cancelled = assert.rejects(pending, error => error.name === 'AbortError');
      await arrived;
      controller.abort();
      await cancelled;
      const bodyController = new AbortController();
      const bodyResponse = await endpoint.fetch(baseUrl + '/body', {signal: bodyController.signal});
      const bodyCancelled = assert.rejects(bodyResponse.text(), error => error.name === 'AbortError');
      bodyController.abort();
      await bodyCancelled;
      assert.equal(arrivals, 3);
    } finally {
      server.closeAllConnections();
      await endpoint.close();
      await new Promise(resolve => server.close(resolve));
    }
  });

  assert.deepEqual(fixture.errors, []);
  console.log(JSON.stringify({passed: failures.length === 0, checks, failures,
    requests: fixture.requests.length, officialRequests: 0,
    limits: ['等待和取消为本地比例测试，不代表真实供应商已验证600秒或8MiB接收能力。']}, null, 2));
  if (failures.length) process.exitCode = 1;
} finally {
  if (originalTimeout === undefined) delete process.env.DATA_AGENT_MODEL_TIMEOUT_MS;
  else process.env.DATA_AGENT_MODEL_TIMEOUT_MS = originalTimeout;
  await fixture.close();
}

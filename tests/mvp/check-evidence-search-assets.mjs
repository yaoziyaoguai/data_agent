import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {deliver} from '../../apps/agent/session/deliver.ts';
import {toolResponseCapacity} from '../../apps/agent/session/capacity.ts';
import {validateContract} from '../../packages/contracts/validate.ts';
import {harness, until} from './harness.mjs';
import {embeddingProvider} from './embedding-provider.mjs';
import {assetInput} from './skill-fixtures.mjs';

const query = 'syntheticindependentassets', memoryQuery = 'syntheticmem0capacity';
const collection = 'data_agent_test_' + randomUUID().replaceAll('-', '');
const vectorToken = (await readFile('.local/infra/milvus-root-password', 'utf8')).trim();
const embedding = await embeddingProvider();
const indexed = new Set(), upsertCounts = {}, searches = [], errors = [], checks = [];
let h, run, phase = 'setup', prepared = false, passed = false, recalledMemory, directoryMemory, modelCalls = 0;
let memoryMode = 'single';
const memoryPages = [], memoryRequests = [];
const ok = response => {assert.equal(response.status, 200, JSON.stringify(response.value)); return response.value;};
const proxy = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    const upstream = await fetch('http://127.0.0.1:19531' + request.url, {method: 'POST',
      headers: {'content-type': 'application/json', authorization: request.headers.authorization}, body: raw});
    const text = await upstream.text(), result = JSON.parse(text);
    if (request.url.endsWith('/upsert') && result.code === 0)
      for (const row of input.data ?? []) {indexed.add(row.object_id); upsertCounts[row.object_id] = (upsertCounts[row.object_id] ?? 0) + 1;}
    if (request.url.endsWith('/search')) searches.push({phase, channel: input.annsField, code: result.code});
    response.writeHead(upstream.status, {'content-type': 'application/json'}).end(text);
  } catch (error) {errors.push(error.message); response.writeHead(503).end('{"code":1}');}
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
// 本地Mem0协议仅提供候选；归属、版本和实际正文仍由正式存储回源核验。
const memory = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw); memoryRequests.push({path: request.url, query: input.query});
    const result = request.url === '/search' ? {candidates: input.query === memoryQuery && recalledMemory
      ? (memoryMode === 'both'
        ? [{asset_id: recalledMemory.id, version: recalledMemory.version},
          {asset_id: directoryMemory.id, version: directoryMemory.version}]
        : [{asset_id: recalledMemory.id, version: recalledMemory.version}]) : [], bounded: false}
      : request.url === '/index' ? {operation_id: input.operation_id, state: 'ready'} : null;
    assert.ok(result, '本用例不提取记忆、不派发外部模型');
    response.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify(result));
  } catch (error) {errors.push(error.message); response.writeHead(503).end('{"error":"memory_unavailable"}');}
});
await new Promise(resolve => memory.listen(0, '127.0.0.1', resolve));
const provider = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw); modelCalls++;
    // 两轮各两次调用（route+搜索、观察冻结回执后作答）：充足容量与预算裁剪各证明一条。
    assert.ok(modelCalls <= 4, '充足容量与预算裁剪两轮共四次本地协议调用');
    let delta;
    if (modelCalls % 2 === 1) {
      delta = {role: 'assistant', tool_calls: [
        {index: 0, id: 'memory-route', type: 'function', function: {name: 'update_analysis_task',
          arguments: JSON.stringify({action: 'route', task_id: null, expected_version: null, goal: '', options: []})}},
        {index: 1, id: 'memory-' + (modelCalls === 1 ? 'ample' : 'trim'), type: 'function', function: {name: 'search_knowledge',
          arguments: JSON.stringify({query: memoryQuery, kinds: ['term'], limit: 2})}},
      ]};
    } else {
      const sdkId = 'memory-' + (modelCalls === 2 ? 'ample' : 'trim');
      const message = input.messages.find(value => value.role === 'tool' && value.tool_call_id === sdkId);
      assert.ok(message); const reply = JSON.parse(message.content);
      validateContract('KnowledgeSearchReply', reply);
      const saved = h.sql(`SELECT receipt FROM tool_calls WHERE conversation_id='${run.conversation_id}' AND sdk_tool_call_id='${sdkId}'`)[0];
      if (typeof reply.search_coverage.next === 'string')
        assert.equal(reply.search_coverage.next, 'rc1:' + saved.operation_id, 'provider只见本操作短引用，完整窗口不出现在模型输入');
      assert.deepEqual(reply, {...saved.data, search_coverage: {...saved.data.search_coverage, next: reply.search_coverage.next}},
        '实际Pi/provider输入须逐字段等于Rust首次冻结回执的公开投影');
      const supportCount = reply.hits.reduce((sum, hit) => sum + hit.supports.length, 0);
      memoryPages.push({sdkId, ids: reply.personal_memories.map(asset => asset.id), supportCount,
        bytes: Buffer.byteLength(JSON.stringify(reply)), assetTotal: reply.asset_total, nextAsset: reply.next_asset_after});
      assert.equal(reply.memory_retrieval, 'mem0_authoritative');
      assert.equal(reply.asset_total, 1, '目录只有B；额外Mem0 A不进入目录总数或顺序');
      assert.deepEqual(reply.personal_memories.map(asset => [asset.id, asset.version]).sort(),
        [recalledMemory, directoryMemory].map(asset => [asset.id, asset.version]).sort(),
        '支持裁剪不得静默删除目录页之外的已核验Mem0命中');
      const delivered = asset => reply.personal_memories.find(item => item.id === asset.id);
      assert.equal(reply.next_asset_after, null, '额外Mem0项不能伪造目录后继位置');
      // 预算边界正落在回执大小附近（实测max_bytes约18KB，逐次轻微漂移）：
      // 逐条锁不变量——正文要么完整、要么带续读游标，不得静默丢失。
      for (const asset of [recalledMemory, directoryMemory]) {
        const item = delivered(asset);
        const complete = item.body === asset.body;
        const bounded = item.body.length < asset.body.length
          && item.content_page.complete === false
          && typeof item.content_page.next_offset === 'number';
        assert.ok(complete || bounded, '记忆正文须完整或带续读游标，不得静默丢失');
      }
      if (modelCalls === 2) {
        // 证明目的2：独立合成配置（短正文）下容量充足时50条支持与两条记忆全文一次装下，
        // 不调大产品默认容量或上限。
        assert.equal(reply.hits.length, 2);
        assert.equal(supportCount, 50, '充足容量下50条支持上限实际可达，不被误裁');
        assert.ok(reply.hits.every(hit => hit.support_state === 'delivered' && hit.supports.length <= 50), '支持全部交付且单命中不超50');
        assert.ok(reply.hits.every(hit => hit.continuation.supports_next_cursor === null), '全部支持已交付，无未交支持游标');
        for (const asset of [recalledMemory, directoryMemory]) {
          const item = delivered(asset);
          assert.equal(item.body, asset.body, '充足预算时记忆正文保原全文');
          assert.equal(item.content_page.complete, true);
          assert.equal(item.content_page.next_offset, null);
        }
      } else {
        assert.equal(reply.hits.length, 2);
        // 预算装不下50支持+全部正文；锁跨命中总数上限与续读游标，
        // 不锁随预算边界漂移的具体条数。
        assert.ok(supportCount <= 50 && supportCount > 0, '跨命中支持总数不得超50');
        assert.ok(reply.hits.some(hit => hit.continuation.supports_next_cursor));
        // 预算边界正落在回执大小附近（实测max_bytes约18KB，逐次轻微漂移）：
        // 逐条锁不变量——正文要么完整、要么带续读游标，不得静默丢失。
        for (const asset of [recalledMemory, directoryMemory]) {
          const item = delivered(asset);
          const complete = item.body === asset.body;
          const bounded = item.body.length < asset.body.length
            && item.content_page.complete === false
            && typeof item.content_page.next_offset === 'number';
          assert.ok(complete || bounded, '记忆正文须完整或带续读游标，不得静默丢失');
        }
      }
      delta = {role: 'assistant', content: '合成依据和两条个人线索均已交付。'};
    }
    response.writeHead(200, {'content-type': 'text/event-stream'});
    response.write('data: ' + JSON.stringify({id: 'synthetic-memory-capacity', choices: [{index: 0, delta,
      finish_reason: delta.tool_calls ? 'tool_calls' : 'stop'}]}) + '\n\n');
    response.write('data: ' + JSON.stringify({choices: [], usage: {prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100}}) + '\n\n');
    response.end('data: [DONE]\n\n');
  } catch (error) {errors.push(error.message); response.writeHead(400, {'content-type': 'application/json'}).end(JSON.stringify({error: {type: 'invalid_request_error', message: 'synthetic_memory_capacity_assertion_failed'}}));}
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const manager = SessionManager.inMemory('/synthetic/independent-assets');
const invoke = async (name, args) => {
  const input = {run_id: run.run_id, lease_epoch: run.lease_epoch, sdk_tool_call_id: randomUUID(),
    tool_name: name, arguments: args, checkpoint: exportCheckpoint(manager,
      run.workspace_context.authority_revision, run.workspace_context.authority_snapshot)};
  ok(await h.internal('/internal/data/tool-calls', input));
  const receipt = ok(await h.internal('/internal/data/tools', input));
  if (name === 'search_knowledge') validateContract('KnowledgeSearchReply', receipt.data);
  return receipt.data;
};
const previousTest = process.env.DATA_AGENT_PROVIDER_TEST;
process.env.DATA_AGENT_PROVIDER_TEST = '1';
try {
  const profile = {provider_id: 'deepseek', model_id: 'deepseek-flash', trial_id: randomUUID(),
    price_version: '2026-10-04-peak-usd', input_limit: 65536, output_limit: 4096,
    trial_call_limit: 24, trial_cost_micros: '300000', request_call_limit: 24, toolset: 'data', payload_bytes_limit: 131072};
  h = await harness({capture: true, startWorker: false, profile,
    protocolProviderUrl: 'http://127.0.0.1:' + provider.address().port,
    env: {...embedding.env, DATA_AGENT_LEASE_MS: '120000', DATA_AGENT_TOOL_CONTRACT_VERSION: '2',
      DATA_AGENT_PROVIDER_TEST: '1', DATA_AGENT_PREFILL_PROFILE: '',
      DATA_AGENT_MEMORY_URL: 'http://127.0.0.1:' + memory.address().port,
      DATA_AGENT_VECTOR_URL: 'http://127.0.0.1:' + proxy.address().port, DATA_AGENT_VECTOR_COLLECTION: collection,
      DATA_AGENT_VECTOR_TOKEN_FILE: process.cwd() + '/.local/infra/milvus-root-password'}});
  ok(await h.request('/knowledge-index/rebuilds', {operation_id: randomUUID()})); prepared = true;
  const object = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'term',
    name: '合成公共与资产独立条目', body: query + ' 合成定义：设备登记后才可借出。', related_ids: []}));
  const asset = ok(await h.request('/assets', assetInput({kind: 'memory', name: query + ' 合成资产', body: '合成资产正文。', scope: '合成适用范围。'})));
  await h.resumeWorker();
  await until(() => indexed.has(object.id), '正式消费者索引合成独立条目', 120000);
  run = await h.capture(await h.create(), '核对公共检索和资产目录独立推进。'); await h.pauseWorker();
  await invoke('update_analysis_task', {action: 'route', task_id: null, expected_version: null, goal: '', options: []});
  phase = 'baseline';
  const args = {query, kinds: ['term'], limit: 1};
  const baseline = await invoke('search_knowledge', args);
  assert.equal(baseline.hits[0].ref.object_id, object.id);
  assert.ok(searches.some(value => value.phase === phase && value.channel === 'vector' && value.code === 0));
  const before = embedding.requests.length;
  phase = 'asset-after';
  const after = await invoke('search_knowledge', {...args, asset_after: asset.id});
  assert.equal(after.hits[0].ref.object_id, object.id);
  assert.equal(after.personal_memories.length, 0);
  assert.equal(after.asset_cursor_invalid, false);
  assert.equal(embedding.requests.length, before + 1, '合同2的资产位置不能关闭公共查询Embedding');
  assert.ok(searches.some(value => value.phase === phase && value.channel === 'vector' && value.code === 0), 'asset_after不关闭公共dense通道');
  checks.push('合同2的asset_after只推进资产，公共BM25/dense与主命中照常返回');
  phase = 'directory';
  const directoryStart = searches.length, embeddingStart = embedding.requests.length;
  const directory = await invoke('search_knowledge', {query: '*', asset_after: asset.id});
  assert.deepEqual(directory.hits, []); assert.deepEqual(directory.personal_memories, []);
  assert.equal(searches.length, directoryStart); assert.equal(embedding.requests.length, embeddingStart);
  checks.push('query=*继续只走资产目录，不派公共检索');
  assert.deepEqual(errors, []); h.releaseRun(run.run_id);

  recalledMemory = ok(await h.request('/assets', assetInput({kind: 'memory', name: '合成个人偏好A',
    body: '说明合成数据的统计边界。', scope: '一般分析表述'})));
  directoryMemory = ok(await h.request('/assets', assetInput({kind: 'memory', name: memoryQuery + ' 目录B',
    body: '列明合成规则和例外。', scope: '一般分析表述'})));
  const source = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'document',
    name: '合成短支持', body: '需复核。', related_ids: []}));
  let supported = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'term',
    name: memoryQuery, body: '初始化', related_ids: []}));
  const statementsFor = (counts, content) => counts.map((count, index) => ({key: 'rule-' + index,
    target: {object_id: supported.id, version: supported.version, path: 'body'},
    text: memoryQuery + ' 合成定义' + index, scope_text: '', citations: [], supports_complete: true,
    supports: Array.from({length: count}, (_, number) => ({key: 'condition-' + number, role: 'prerequisite',
      reference: {kind: 'source', citation: {source: {kind: 'document', id: source.id}, revision: source.version,
        locator: {offset: 0, length: 4}}}, content, embedded_in: null}))}));
  const publish = async (counts, content) => ok(await h.request('/knowledge/' + supported.id,
    {operation_id: randomUUID(), expected_version: supported.version, entry_id: 'body',
      value: counts.map((count, index) => memoryQuery + ' 合成定义' + index).join('\n\n'),
      statements: statementsFor(counts, content)}, 'alice', 'PATCH'));
  supported = await publish([25, 25], '需复核。');
  await h.resumeWorker(); await until(() => indexed.has(supported.id), '正式消费者索引50个短支持的两个陈述', 120000);
  run = await h.capture(await h.create(), '核对充足容量下50条支持与两条个人记忆全文一次交付。'); await h.pauseWorker();
  try {await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, '');}
  catch (error) {assert.deepEqual(errors, [], JSON.stringify(errors)); throw error;}
  assert.deepEqual(errors, []); assert.equal(modelCalls, 2);
  h.releaseRun(run.run_id);
  checks.push('容量充足的合成配置中50条支持与目录B、额外Mem0 A一次装下：支持delivered、无未交游标、正文保原全文');
  // 第二轮把支持正文加长，使完整回执确定超出response_budget：
  // 预算裁剪重建路径（资产最小身份放回、Mem0额外项不得按目录序丢弃）才会真正走到。
  supported = await publish([26, 25], '合成支持正文依据，需按预算逐条截断。'.repeat(12));
  await h.resumeWorker(); await until(() => (upsertCounts[supported.id] ?? 0) >= 2, '正式消费者重新索引51支持版本', 120000);
  run = await h.capture(await h.create(), '核对检索裁剪后合成依据和个人线索都能到达模型。'); await h.pauseWorker();
  try {await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, '');}
  catch (error) {assert.deepEqual(errors, [], JSON.stringify(errors)); throw error;}
  assert.deepEqual(errors, []); assert.equal(modelCalls, 4);
  assert.ok(memoryRequests.some(request => request.path === '/search' && request.query === memoryQuery));
  checks.push('51支持触发预算裁剪时目录B与额外Mem0 A均保留且正文完整或带续读游标，provider输入与冻结回执一致且目录游标独立');
  h.releaseRun(run.run_id);

  // R06边界轮：实际宿主toolResponseCapacity分配。Mem0同轮召回目录B与额外A，
  // 覆盖同一资产双路去重；1200B正控两身份齐全，1000B边界要么最小身份保留、
  // 要么如实tool_response_capacity，不允许静默删除额外项后伪成功。
  phase = 'capacity-boundary';
  memoryMode = 'both';
  await h.resumeWorker();
  run = await h.capture(await h.create(), '核对小容量分配下额外Mem0命中的最小身份。'); await h.pauseWorker();
  const usage = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}};
  let boundaryManager = SessionManager.inMemory('/synthetic/independent-assets');
  const checkpointOf = manager => exportCheckpoint(manager,
    run.workspace_context.authority_revision, run.workspace_context.authority_snapshot);
  const direct = async (name, args, manager, budget) => {
    const input = {run_id: run.run_id, lease_epoch: run.lease_epoch, sdk_tool_call_id: randomUUID(),
      tool_name: name, arguments: args, checkpoint: checkpointOf(manager), ...(budget ? {response_budget: budget} : {})};
    ok(await h.internal('/internal/data/tool-calls', input));
    return {response: await h.internal('/internal/data/tools', input), input};
  };
  const routed = await direct('update_analysis_task', {action: 'route', task_id: null, expected_version: null, goal: '', options: []}, boundaryManager);
  assert.equal(routed.response.status, 200, JSON.stringify(routed.response.value));
  const boundary = [];
  for (const target of [1200, 1000]) {
    let filler = 115000, message, budget;
    for (let attempt = 0; attempt < 2; attempt++) {
      boundaryManager = SessionManager.inMemory('/synthetic/independent-assets');
      boundaryManager.appendMessage({role: 'user', content: 'x'.repeat(filler), timestamp: 0});
      message = {role: 'assistant', content: [{type: 'toolCall', id: 'memory-boundary', name: 'search_knowledge',
        arguments: {query: memoryQuery, limit: 2}}], api: 'openai-completions', provider: 'local_mock',
        model: 'audit', stopReason: 'toolUse', usage, timestamp: 1};
      boundaryManager.appendMessage(message);
      const capacity = toolResponseCapacity(profile, boundaryManager, () => ({systemPrompt: 'synthetic', tools: [], references: []}));
      capacity.begin(message);
      budget = capacity.budget('memory-boundary');
      filler = Math.max(0, filler + 2 * (budget.max_bytes - target));
    }
    const {response, input} = await direct('search_knowledge', {query: memoryQuery, kinds: ['term'], limit: 2}, boundaryManager, budget);
    const observation = {target, max_bytes: budget.max_bytes, status: response.status, code: response.value.code ?? null};
    if (response.status === 200) {
      const reply = response.value.data;
      validateContract('KnowledgeSearchReply', reply);
      const ids = reply.personal_memories.map(asset => asset.id);
      observation.identities = ids;
      observation.bytes = Buffer.byteLength(JSON.stringify(reply));
      assert.ok(ids.includes(recalledMemory.id) && ids.includes(directoryMemory.id),
        '小容量成功回执不得静默删除已核验额外Mem0命中：' + JSON.stringify({ids, max_bytes: budget.max_bytes}));
      assert.equal(new Set(ids).size, ids.length, '同一资产双路命中只出现一次');
      assert.equal(reply.asset_total, 1, '额外Mem0命中不进入目录总数');
      assert.equal(reply.next_asset_after, null, '额外Mem0项不能伪造目录后继位置');
      for (const asset of [recalledMemory, directoryMemory]) {
        const item = reply.personal_memories.find(entry => entry.id === asset.id);
        const complete = item.body === asset.body;
        const bounded = item.body.length < asset.body.length
          && item.content_page.complete === false
          && typeof item.content_page.next_offset === 'number';
        assert.ok(complete || bounded, '最小身份须保留正文或补读位置');
      }
      const frozen = h.sql(`SELECT receipt FROM tool_calls WHERE conversation_id='${run.conversation_id}' AND sdk_tool_call_id='${input.sdk_tool_call_id}'`)[0];
      if (typeof reply.search_coverage.next === 'string')
        assert.equal(reply.search_coverage.next, 'rc1:' + frozen.operation_id, '公开游标为本操作短引用');
      assert.deepEqual(reply, {...frozen.data, search_coverage: {...frozen.data.search_coverage, next: reply.search_coverage.next}},
        '成功持久回执与实际返回一致，仅next为公开短引用投影');
      // 同operation原成功回放不重裁：更小预算重放同输入须逐字段返回首次冻结回执。
      const searchCount = searches.length, memoryCount = memoryRequests.length;
      const replay = await h.internal('/internal/data/tools', {...input, response_budget: {...budget, max_bytes: 640}});
      assert.equal(replay.status, 200, JSON.stringify(replay.value));
      assert.deepEqual(replay.value.data, reply, '原成功回放不按新容量重裁');
      assert.equal(searches.length, searchCount, '回放不重发公共检索');
      assert.equal(memoryRequests.length, memoryCount, '回放不重查Mem0');
    } else {
      assert.equal(response.value.code, 'tool_response_capacity', '装不下最小集合沿既有容量错误如实失败');
      const row = h.sql(`SELECT JSON_OBJECT('state',state,'receipt',receipt) FROM tool_calls WHERE conversation_id='${run.conversation_id}' AND sdk_tool_call_id='${input.sdk_tool_call_id}'`)[0];
      assert.ok(!row || row.state !== 'succeeded' || row.receipt === null, '容量失败不得冻结为成功回执');
    }
    boundary.push(observation);
  }
  memoryPages.push(...boundary);
  checks.push('实际宿主容量分配边界：双路同资产去重、1200B两身份齐全、1000B最小身份保留或如实tool_response_capacity、失败不冻结伪成功、原成功回放不重裁');
  h.releaseRun(run.run_id);

  // 数量上限轮：51条短支持在真实充足预算下字节全部装得下，50条数量上限本身生效，
  // 第51条由正式read路径按续读位置补回。
  phase = 'count-limit';
  supported = await publish([26, 25], '需复核。');
  await h.resumeWorker(); await until(() => (upsertCounts[supported.id] ?? 0) >= 3, '正式消费者重新索引51短支持版本', 120000);
  run = await h.capture(await h.create(), '核对字节充足时支持数量上限本身截住第51条。'); await h.pauseWorker();
  const ampleManager = SessionManager.inMemory('/synthetic/independent-assets');
  const ampleProbe = {role: 'assistant', content: [{type: 'toolCall', id: 'count-cap', name: 'search_knowledge',
    arguments: {query: memoryQuery, limit: 2}}], api: 'openai-completions', provider: 'local_mock',
    model: 'audit', stopReason: 'toolUse', usage, timestamp: 1};
  ampleManager.appendMessage(ampleProbe);
  const ampleCapacity = toolResponseCapacity(profile, ampleManager, () => ({systemPrompt: 'synthetic', tools: [], references: []}));
  ampleCapacity.begin(ampleProbe);
  const ampleBudget = ampleCapacity.budget('count-cap');
  const ampleRouted = await direct('update_analysis_task', {action: 'route', task_id: null, expected_version: null, goal: '', options: []}, ampleManager);
  assert.equal(ampleRouted.response.status, 200, JSON.stringify(ampleRouted.response.value));
  const ampleSearch = await direct('search_knowledge', {query: memoryQuery, kinds: ['term'], limit: 2}, ampleManager, ampleBudget);
  assert.equal(ampleSearch.response.status, 200, JSON.stringify(ampleSearch.response.value));
  const countReply = ampleSearch.response.value.data;
  validateContract('KnowledgeSearchReply', countReply);
  const supportCount = countReply.hits.reduce((sum, hit) => sum + hit.supports.length, 0);
  const countBytes = Buffer.byteLength(JSON.stringify(countReply));
  memoryPages.push({phase, budgetBytes: ampleBudget.max_bytes, bytes: countBytes, supportCount,
    ids: countReply.personal_memories.map(asset => asset.id)});
  assert.equal(countReply.hits.length, 2);
  assert.ok(countBytes < ampleBudget.max_bytes, '50条短支持回执在充足预算内，字节不是截断原因');
  assert.equal(supportCount, 50, '字节充足时51条短支持仍只交50条，50上限本身生效');
  const partialHits = countReply.hits.filter(hit => hit.continuation.supports_next_cursor !== null);
  assert.equal(partialHits.length, 1, '恰一命中留下支持续读');
  const partialHit = partialHits[0];
  assert.equal(partialHit.support_state, 'partial');
  for (const hit of countReply.hits) {
    assert.equal(hit.content_state, 'complete', '字节充足：命中正文未被切片');
    if (hit === partialHit) continue;
    assert.equal(hit.support_state, 'delivered');
    assert.equal(hit.continuation.supports_next_cursor, null, '未截断命中的支持一次交齐');
  }
  for (const asset of [recalledMemory, directoryMemory]) {
    const item = countReply.personal_memories.find(entry => entry.id === asset.id);
    assert.ok(item, '已核验个人线索仍在回执中');
    assert.equal(item.body, asset.body, '字节充足：记忆正文保原全文');
  }
  const remaining = await direct('read_knowledge', {items: [{kind: 'knowledge', ref: partialHit.ref,
    statement_id: partialHit.statement_id, limit: 0, supports_cursor: partialHit.continuation.supports_next_cursor}]}, ampleManager);
  assert.equal(remaining.response.status, 200, JSON.stringify(remaining.response.value));
  const followup = remaining.response.value.data.items[0];
  assert.ok(countBytes + Buffer.byteLength(JSON.stringify(followup.supports[0])) < ampleBudget.max_bytes,
    '实测全部51条短支持原本能装进字节额度，截断只可能来自50条数量上限');
  assert.equal(followup.supports.length, 1, '续读恰好补回被50上限截住的那一条');
  assert.equal(followup.continuation.supports_next_cursor, null, '补读后该命中支持读尽');
  assert.equal(partialHit.supports.length + followup.supports.length, followup.supports_total, '该命中支持不重不漏');
  assert.ok(partialHit.supports.every(support => support.support_id !== followup.supports[0].support_id), '补读不得重复已交付支持');
  checks.push('51条短支持字节装得下仍只交50条：恰一命中留续读，正式read补读恰好补齐该命中剩余支持且不重复');
  h.releaseRun(run.run_id); passed = true;
  console.log(JSON.stringify({passed, checks, searches, memoryPages, modelCalls, officialRequests: 0}));
} finally {
  if (previousTest === undefined) delete process.env.DATA_AGENT_PROVIDER_TEST; else process.env.DATA_AGENT_PROVIDER_TEST = previousTest;
  if (h) {await writeFile(h.directory + '/evidence-search-assets.json', JSON.stringify({passed, checks, searches, errors, memoryPages, modelCalls, officialRequests: 0}, null, 2)); await h.close();}
  if (prepared) {
    const response = await fetch('http://127.0.0.1:19531/v2/vectordb/collections/drop', {method: 'POST',
      headers: {'content-type': 'application/json', authorization: 'Bearer root:' + vectorToken}, body: JSON.stringify({dbName: 'default', collectionName: collection})});
    assert.equal((await response.json()).code, 0);
  }
  await embedding.close();
  for (const server of [proxy, memory, provider]) {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}
}

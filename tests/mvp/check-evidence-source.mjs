import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash, randomUUID} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {deliver} from '../../apps/agent/session/deliver.ts';
import {validateContract} from '../../packages/contracts/validate.ts';
import {harness} from './harness.mjs';
import {embeddingProvider} from './embedding-provider.mjs';

const prefix = '合成导言。', selected = '甲🌏é乙丙丁。', suffix = '结尾不得交付。';
const body = prefix + selected + suffix;
const collection = 'data_agent_test_' + randomUUID().replaceAll('-', '');
const vectorToken = (await readFile('.local/infra/milvus-root-password', 'utf8')).trim();
const embedding = await embeddingProvider();
const errors = [], delivered = [];
let h, source, run, calls = 0, prepared = false, passed = false;
const checks = [];
const provider = createServer(async (request, response) => {
  try {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    calls++;
    const citation = {source: {kind: 'document', id: source.id}, revision: source.version,
      locator: {offset: 5, length: 8}};
    let delta;
    if (calls === 1) {
      // 4e1f2a6移除前端就绪隐藏门后读取工具始终在payload可见，未route前由Rust task_context_required硬门拦截（见下方第135行）。
      assert.ok(input.tools.some(tool => tool.function?.name === 'read_source'), '4e1f2a6起read_source始终可见，由Rust硬门拦截未归属调用');
      assert.ok(input.tools.some(tool => tool.function?.name === 'update_analysis_task'), '控制工具route始终可见');
      delta = {role: 'assistant', tool_calls: [
        {index: 0, id: 'source-route', type: 'function', function: {name: 'update_analysis_task', arguments: JSON.stringify({action: 'route', task_id: null, expected_version: null, goal: '', question: null, options: []})}},
      ]};
    } else if (calls === 2) {
      const tool = input.tools.find(tool => tool.function?.name === 'read_source');
      assert.ok(tool, 'route裁决并刷新后read_source恢复可见');
      assert.ok(tool.function.parameters.properties.citation);
      assert.equal(Object.hasOwn(tool.function.parameters.properties, 'source_id'), false);
      delta = {role: 'assistant', tool_calls: [
        {index: 0, id: 'source-first', type: 'function', function: {name: 'read_source', arguments: JSON.stringify({citation, limit: 3})}},
      ]};
    } else {
      assert.ok(calls <= 4, 'route、两页原文与一次续答，不添加摘要调用');
      const sdkId = calls === 3 ? 'source-first' : 'source-next';
      const message = input.messages.find(message => message.role === 'tool' && message.tool_call_id === sdkId);
      assert.ok(message);
      const result = JSON.parse(message.content);
      validateContract('SourceReadReply', result);
      assert.deepEqual(result.source, citation.source);
      assert.equal(result.revision, source.version);
      assert.equal(result.source_length, [...body].length);
      const stored = h.sql(`SELECT receipt FROM tool_calls WHERE conversation_id='${run.conversation_id}' AND recovery_chain_id='${run.recovery_chain_id}' AND sdk_tool_call_id='${sdkId}'`)[0];
      assert.deepEqual(result, stored.data, 'provider收到Rust冻结的原文回执');
      const authority = h.sql(`SELECT authority_snapshot FROM agent_runs WHERE id='${run.run_id}'`)[0];
      assert.ok(authority.sources.some(reference => reference[0] === 'document-' + source.id && reference[1] === source.version), '实际原文交付进入当前修订与活动范围依赖快照');
      delivered.push(result);
      if (calls === 3) {
        assert.equal(result.text, '甲🌏e');
        assert.deepEqual(result.locator, {offset: 5, length: 3});
        assert.equal(result.content_state, 'partial');
        assert.deepEqual(result.next_locator, {offset: 8, length: 5}, '续页只剩原请求五个Unicode字符');
        delta = {role: 'assistant', tool_calls: [{index: 0, id: 'source-next', type: 'function', function: {name: 'read_source',
          arguments: JSON.stringify({citation: {...citation, locator: result.next_locator}, limit: 100})}}]};
      } else {
        assert.equal(result.text, '́乙丙丁。');
        assert.deepEqual(result.locator, {offset: 8, length: 5});
        assert.equal(result.content_state, 'complete');
        assert.equal(result.next_locator, null, '原请求结束不能自动扩大到全文剩余位置');
        assert.equal(delivered.map(value => value.text).join(''), selected);
        assert.ok(delivered.every(value => !value.text.includes(suffix)));
        delta = {role: 'assistant', content: '已核对指定合成区间。'};
      }
    }
    response.writeHead(200, {'content-type': 'text/event-stream'});
    response.write('data: ' + JSON.stringify({id: 'evidence-source', choices: [{index: 0, delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop'}]}) + '\n\n');
    response.write('data: ' + JSON.stringify({choices: [], usage: {prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100}}) + '\n\n');
    response.end('data: [DONE]\n\n');
  } catch (error) {
    errors.push(error.message);
    response.writeHead(400, {'content-type': 'application/json'}).end(JSON.stringify({error: {message: 'synthetic_source_assertion_failed', type: 'invalid_request_error'}}));
  }
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const previousTest = process.env.DATA_AGENT_PROVIDER_TEST;
process.env.DATA_AGENT_PROVIDER_TEST = '1';
try {
  const profile = {provider_id: 'deepseek', model_id: 'deepseek-flash', trial_id: randomUUID(), price_version: '2026-10-04-peak-usd', input_limit: 65536, output_limit: 8192, trial_call_limit: 24, trial_cost_micros: '300000', request_call_limit: 24, toolset: 'data', payload_bytes_limit: 131072, thinking_level: 'off'};
  h = await harness({capture: true, startWorker: false, profile, protocolProviderUrl: 'http://127.0.0.1:' + provider.address().port,
    env: {...embedding.env, DATA_AGENT_LEASE_MS: '120000', DATA_AGENT_TOOL_CONTRACT_VERSION: '2', DATA_AGENT_PREFILL_PROFILE: '',
      DATA_AGENT_VECTOR_URL: 'http://127.0.0.1:19531', DATA_AGENT_VECTOR_COLLECTION: collection,
      DATA_AGENT_VECTOR_TOKEN_FILE: process.cwd() + '/.local/infra/milvus-root-password'}});
  const rebuild = await h.request('/knowledge-index/rebuilds', {operation_id: randomUUID()});
  assert.equal(rebuild.status, 200, JSON.stringify(rebuild.value)); prepared = true;
  const saved = await h.request('/knowledge', {operation_id: randomUUID(), kind: 'document', name: '合成区间文档', body, related_ids: []});
  assert.equal(saved.status, 200, JSON.stringify(saved.value)); source = saved.value;
  await h.resumeWorker(); run = await h.capture(await h.create(), '只核对合成文档中指定的八个字符。');
  await h.pauseWorker(); assert.equal(run.tool_contract_version, 2);
  try { await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, ''); }
  catch (error) { assert.deepEqual(errors, [], JSON.stringify(errors)); throw error; }
  h.releaseRun(run.run_id);
  assert.deepEqual(errors, []); assert.equal(calls, 4); assert.equal(delivered.length, 2);
  checks.push('原修订/Unicode定点读取', '实际provider两页仅交原请求范围', 'Rust最终回执与Pi包装逐字段一致');

  // 同一专用实例补边界；仅调用正式登记/读取入口，不构造理想成功回执。
  await h.resumeWorker();
  run = await h.capture(await h.create(), '只核对合成区间文档；其他文档不作为本题依据。');
  await h.pauseWorker();
  const manager = SessionManager.inMemory('/synthetic/evidence-source-boundaries');
  const invoke = async (name, args, expectedError, responseBudget) => {
    const input = {run_id: run.run_id, lease_epoch: run.lease_epoch, sdk_tool_call_id: randomUUID(), tool_name: name, arguments: args,
      ...(responseBudget ? {response_budget: responseBudget} : {}),
      checkpoint: exportCheckpoint(manager, run.workspace_context.authority_revision, run.workspace_context.authority_snapshot)};
    const registered = await h.internal('/internal/data/tool-calls', input);
    assert.equal(registered.status, 200, JSON.stringify(registered.value));
    const result = await h.internal('/internal/data/tools', input);
    if (!expectedError) { assert.equal(result.status, 200, JSON.stringify(result.value)); return result.value.data; }
    assert.notEqual(result.status, 200);
    assert.equal(result.value.code, expectedError, JSON.stringify(result.value));
    const rejected = await h.internal('/internal/data/tool-rejections', input);
    assert.equal(rejected.status, 200, JSON.stringify(rejected.value));
    assert.equal(rejected.value.data.error, expectedError);
    assert.equal(Object.hasOwn(rejected.value.data, 'text'), false);
    return rejected.value.data;
  };
  const citation = {source: {kind: 'document', id: source.id}, revision: source.version, locator: {offset: 5, length: 8}};
  const identityMarker = 'SOURCE_IDENTITY_BODY_ONLY_' + randomUUID();
  const identityDocument = await h.request('/knowledge', {operation_id: randomUUID(), kind: 'document',
    name: '合成身份目录文档', body: identityMarker, related_ids: []});
  assert.equal(identityDocument.status, 200, JSON.stringify(identityDocument.value));
  // 4e1f2a6起空会话无活动任务时按无限制处理；存在未声明source_limits的活动任务时，正文/取证读取触发task_context_required，而source_identity仍可发现身份。
  const undeclaredTask = await invoke('update_analysis_task', {action: 'create', goal: '来源范围待核实的任务',
    conditions: {time_start: null, time_end: null, timezone: 'UTC', metric: null, channel: null,
      group_by: [], filters: [], knowledge_refs: [], notes: ''}, options: []});
  const authorityBeforeIdentity = h.sql(`SELECT authority_snapshot FROM agent_runs WHERE id='${run.run_id}'`)[0];
  const embeddingBeforeIdentity = embedding.requests.length;
  await invoke('read_source', {citation}, 'task_context_required');
  await invoke('search_knowledge', {query: '合成身份目录文档'}, 'task_context_required');
  const identity = await invoke('search_knowledge', {view: 'source_identity', query: '合成身份目录文档', kinds: ['document']});
  validateContract('KnowledgeSearchReply', identity);
  assert.deepEqual(identity.hits, [{record_kind: 'source_identity', name: '合成身份目录文档', kind: 'document',
    object_id: identityDocument.value.id, object_version: identityDocument.value.version,
    source_keys: [{kind: 'document', id: identityDocument.value.id}], roots_complete: true}]);
  assert.deepEqual(identity.personal_memories, []); assert.deepEqual(identity.selected_skills, []);
  assert.equal(identity.asset_total, 0); assert.equal(identity.next_asset_after, null);
  assert.equal(JSON.stringify(identity).includes(identityMarker), false, '身份回执不能夹带独立正文marker');
  const bodyOnly = await invoke('search_knowledge', {view: 'source_identity', query: identityMarker});
  validateContract('KnowledgeSearchReply', bodyOnly);
  assert.deepEqual(bodyOnly.hits, [], '仅正文匹配不能充当名称目录命中');
  assert.equal(bodyOnly.search_coverage.state, 'searched'); assert.equal(bodyOnly.search_coverage.next, null);
  assert.equal(embedding.requests.length, embeddingBeforeIdentity, '身份视图不得调用embedding');
  assert.deepEqual(h.sql(`SELECT authority_snapshot FROM agent_runs WHERE id='${run.run_id}'`)[0], authorityBeforeIdentity,
    '元信息发现不能登记为已读正文、来源或EvidenceRef');
  await invoke('read_source', {citation}, 'task_context_required');
  checks.push('声明前身份发现、独立正文marker隔离、零embedding及不污染已读authority');

  const namesArgs = {view: 'source_identity', query: '合成区间文档\t 合成身份目录文档', kinds: ['document'], limit: 1};
  const namesFirst = await invoke('search_knowledge', namesArgs);
  validateContract('KnowledgeSearchReply', namesFirst);
  assert.equal(namesFirst.hits.length, 1, '空白分隔的两个独立名称必须按任一名称匹配，不能把整串当子串');
  assert.equal(namesFirst.search_coverage.state, 'bounded');
  assert.equal(typeof namesFirst.search_coverage.next, 'string');
  const namesLast = await invoke('search_knowledge', {...namesArgs, cursor: namesFirst.search_coverage.next});
  validateContract('KnowledgeSearchReply', namesLast);
  assert.equal(namesLast.hits.length, 1); assert.equal(namesLast.search_coverage.next, null);
  assert.equal(namesLast.search_coverage.state, 'searched');
  assert.deepEqual([...namesFirst.hits, ...namesLast.hits].map(hit => hit.object_id).sort(),
    [source.id, identityDocument.value.id].sort(), 'limit1真实续页必须准确返回两个独立文档ID');
  for (const page of [namesFirst, namesLast]) {
    assert.equal(JSON.stringify(page).includes(identityMarker), false);
    assert.deepEqual(page.personal_memories, []); assert.deepEqual(page.selected_skills, []);
  }
  const bodyOnlyTerms = await invoke('search_knowledge', {view: 'source_identity', query: identityMarker + ' ' + suffix});
  validateContract('KnowledgeSearchReply', bodyOnlyTerms);
  assert.deepEqual(bodyOnlyTerms.hits, [], '多个仅正文命中的词不能进入身份目录');
  // 协议负控：保留真实当前游标的位置，仅将绑定改回旧的整串匹配算法；不是历史回执。
  const identityCursorPrefix = 'source_identity:1:';
  assert.ok(namesFirst.search_coverage.next.startsWith(identityCursorPrefix));
  const legacyMatchCursor = JSON.parse(Buffer.from(namesFirst.search_coverage.next.slice(identityCursorPrefix.length), 'base64url').toString());
  legacyMatchCursor.binding = createHash('sha256').update(JSON.stringify({
    hints: null, kinds: namesArgs.kinds, limit: namesArgs.limit, query: namesArgs.query,
    space_id: 'demo', user_id: 'alice', view: 'source_identity',
  })).digest('hex');
  await invoke('search_knowledge', {...namesArgs,
    cursor: identityCursorPrefix + Buffer.from(JSON.stringify(legacyMatchCursor)).toString('base64url')}, 'invalid_cursor');
  assert.equal(embedding.requests.length, embeddingBeforeIdentity, '多名称身份匹配和续页不得调用embedding');
  assert.deepEqual(h.sql(`SELECT authority_snapshot FROM agent_runs WHERE id='${run.run_id}'`)[0], authorityBeforeIdentity);
  checks.push('空白多名称任一匹配、limit1真实续页、仅正文多词排除及旧匹配绑定协议拒绝');

  const identityById = await invoke('search_knowledge', {view: 'source_identity', query: identityDocument.value.id, kinds: ['document']});
  validateContract('KnowledgeSearchReply', identityById);
  assert.deepEqual(identityById.hits, identity.hits, '名称与稳定标识查到相同文档SourceKey及当前对象版本');
  const tableIdentity = await invoke('search_knowledge', {view: 'source_identity', query: 'table-demo_order_detail', kinds: ['table']});
  validateContract('KnowledgeSearchReply', tableIdentity); assert.equal(tableIdentity.hits.length, 1);
  assert.equal(tableIdentity.hits[0].object_id, 'table-demo_order_detail');
  assert.equal(tableIdentity.hits[0].object_version, '1');
  assert.equal(tableIdentity.hits[0].roots_complete, true);
  assert.deepEqual(tableIdentity.hits[0].source_keys, ['schema', 'table-demo_order_detail'].map(id => ({kind: 'platform', id})),
    '4e1f2a6起表身份返回单表稳定身份与可读直属source_id');
  // 规范与实现分歧记录：implementation-design.md L765 仍保留旧句“roots_complete仅证明贡献根映射完整”，
  // 而 4e1f2a6/a1d0cdb（L736/L742 及 schema.json:4857）已将 source_identity 改为直属身份比对且不读映射表。
  // 保留未知映射检验（一）：mapping_state='unknown' 时直属 source_keys 绝不退化为空（不能当无来源）。
  h.sql(`UPDATE knowledge_dependency_states SET mapping_state='unknown' WHERE owner_id='table-demo_order_detail' AND owner_version=1`);
  try {
    const unknownMappingIdentity = await invoke('search_knowledge', {view: 'source_identity', query: 'table-demo_order_detail', kinds: ['table']});
    validateContract('KnowledgeSearchReply', unknownMappingIdentity); assert.equal(unknownMappingIdentity.hits.length, 1);
    assert.deepEqual(unknownMappingIdentity.hits[0].source_keys, ['schema', 'table-demo_order_detail'].map(id => ({kind: 'platform', id})),
      'mapping_state=unknown下直属身份不退化为空数组');
    assert.equal(unknownMappingIdentity.hits[0].roots_complete, true);
  } finally {
    h.sql(`UPDATE knowledge_dependency_states SET mapping_state='complete' WHERE owner_id='table-demo_order_detail' AND owner_version=1`);
  }
  const platformIdentityArgs = {view: 'source_identity', query: 'synthetic-unmatched-source business-guide'};
  const platformIdentityCursors = new Set();
  const embeddingBeforePlatformIdentity = embedding.requests.length;
  let platformIdentityCursor, platformIdentityRaw;
  do {
    const platformIdentity = await invoke('search_knowledge', {...platformIdentityArgs,
      ...(platformIdentityCursor ? {cursor: platformIdentityCursor} : {})});
    validateContract('KnowledgeSearchReply', platformIdentity);
    assert.equal(JSON.stringify(platformIdentity).includes(identityMarker), false, '身份目录续页不能夹带正文marker');
    assert.deepEqual(platformIdentity.personal_memories, []); assert.deepEqual(platformIdentity.selected_skills, []);
    assert.equal(platformIdentity.asset_total, 0);
    platformIdentityRaw = platformIdentity.hits.find(hit => !Object.hasOwn(hit, 'object_id')
      && hit.name === 'business-guide');
    if (platformIdentityRaw) {
      assert.equal(platformIdentityRaw.roots_complete,true);
      assert.deepEqual(platformIdentityRaw.source_keys,[{kind:'platform',id:'business-guide'}],
        '源键按JSON结构核对，不依赖Rust/JavaScript对象键的序列化顺序');
      break;
    }
    platformIdentityCursor = platformIdentity.search_coverage.next;
    if (platformIdentityCursor !== null) {
      assert.ok(!platformIdentityCursors.has(platformIdentityCursor), '平台身份目录续读位置必须推进');
      platformIdentityCursors.add(platformIdentityCursor);
    }
  } while (platformIdentityCursor !== null);
  assert.ok(platformIdentityRaw, '完整推进名称目录后必须发现无object_id的真实平台原始来源身份');
  assert.equal(embedding.requests.length, embeddingBeforePlatformIdentity, '平台身份目录分页不得调用embedding');
  checks.push('名称/标识稳定身份、真实表贡献根、不完整映射与平台来源目录');

  const directoryName = '合成身份分页目录';
  const directoryDocuments = [];
  for (let index = 0; index < 5; index++) {
    const saved = await h.request('/knowledge', {operation_id: randomUUID(), kind: 'document',
      name: directoryName + index + '合成元信息'.repeat(30), body: identityMarker, related_ids: []});
    assert.equal(saved.status, 200, JSON.stringify(saved.value));
    directoryDocuments.push(saved.value);
  }
  const disabledIdentity = await h.request(`/knowledge/${directoryDocuments[3].id}/disable`,
    {operation_id: randomUUID(), expected_version: directoryDocuments[3].version});
  assert.equal(disabledIdentity.status, 200, JSON.stringify(disabledIdentity.value));
  h.sql(`UPDATE knowledge_objects SET space_id='synthetic-other-space' WHERE id='${directoryDocuments[4].id}'`);
  for (const user of ['alice', 'bob']) {
    const asset = await h.request('/assets', {operation_id: randomUUID(), id: null, expected_version: null,
      kind: 'memory', name: directoryName + user, body: identityMarker, scope: '合成个人范围',
      verified: false, source_text: '合成个人原话', dependencies: []}, user);
    assert.equal(asset.status, 200, JSON.stringify(asset.value));
  }
  const directoryArgs = {view: 'source_identity', query: directoryName, kinds: ['document'], limit: 1,
    hints: {business_domain: '合成非匹配提示'}};
  const firstIdentityPage = await invoke('search_knowledge', directoryArgs);
  validateContract('KnowledgeSearchReply', firstIdentityPage);
  assert.equal(firstIdentityPage.hits.length, 1);
  assert.equal(firstIdentityPage.search_coverage.state, 'bounded');
  assert.deepEqual(firstIdentityPage.search_coverage.channels, [{channel: 'exact', state: 'available'}]);
  assert.deepEqual(firstIdentityPage.search_coverage.reasons, ['candidate_limit']);
  assert.equal(typeof firstIdentityPage.search_coverage.next, 'string');
  const identityCursor = firstIdentityPage.search_coverage.next;
  const directoryHits = [...firstIdentityPage.hits];
  let directoryNext = identityCursor;
  for (let page = 0; directoryNext; page++) {
    assert.ok(page < 3, '身份目录必须有限终止');
    const result = await invoke('search_knowledge', {...directoryArgs, cursor: directoryNext});
    validateContract('KnowledgeSearchReply', result);
    assert.equal(result.hits.length, 1);
    assert.deepEqual(result.personal_memories, []); assert.deepEqual(result.selected_skills, []);
    assert.equal(result.asset_total, 0);
    directoryHits.push(...result.hits); directoryNext = result.search_coverage.next;
    assert.equal(result.search_coverage.state, directoryNext ? 'bounded' : 'searched');
  }
  assert.deepEqual(directoryHits.map(hit => hit.object_id).sort(), directoryDocuments.slice(0, 3).map(doc => doc.id).sort(),
    '目录分页不重复、不遗漏，过滤停用及其他空间对象，hints不能硬裁候选');
  assert.ok(directoryHits.every(hit => !Object.hasOwn(hit, 'version') && !Object.hasOwn(hit, 'ref')));
  await invoke('search_knowledge', {...directoryArgs, query: '不同名称', cursor: identityCursor}, 'invalid_cursor');
  await invoke('search_knowledge', {...directoryArgs, kinds: ['table'], cursor: identityCursor}, 'invalid_cursor');
  await invoke('search_knowledge', {...directoryArgs, hints: {business_domain: '不同提示'}, cursor: identityCursor}, 'invalid_cursor');

  const capacityArgs = {view: 'source_identity', query: directoryName, kinds: ['document'], limit: 3};
  const fullIdentities = await invoke('search_knowledge', capacityArgs);
  validateContract('KnowledgeSearchReply', fullIdentities); assert.equal(fullIdentities.hits.length, 3);
  const responseBudget = {max_bytes: Buffer.byteLength(JSON.stringify(fullIdentities)) - 1,
    estimated_tokens: 2000000, projection_fingerprint: '0'.repeat(64)};
  const boundedIdentities = await invoke('search_knowledge', capacityArgs, undefined, responseBudget);
  validateContract('KnowledgeSearchReply', boundedIdentities);
  assert.ok(boundedIdentities.hits.length > 0 && boundedIdentities.hits.length < 3);
  assert.ok(Buffer.byteLength(JSON.stringify(boundedIdentities)) <= responseBudget.max_bytes);
  assert.equal(boundedIdentities.search_coverage.state, 'bounded');
  assert.equal(typeof boundedIdentities.search_coverage.next, 'string', '容量裁页必须留真实续读位置');
  const capacityHits = [...boundedIdentities.hits];
  let capacityNext = boundedIdentities.search_coverage.next;
  for (let page = 0; capacityNext; page++) {
    assert.ok(page < 3, '容量裁页不能卡住游标');
    const result = await invoke('search_knowledge', {...capacityArgs, cursor: capacityNext}, undefined, responseBudget);
    validateContract('KnowledgeSearchReply', result);
    assert.ok(result.hits.length > 0); assert.ok(Buffer.byteLength(JSON.stringify(result)) <= responseBudget.max_bytes);
    capacityHits.push(...result.hits); capacityNext = result.search_coverage.next;
  }
  assert.deepEqual(capacityHits.map(hit => hit.object_id), fullIdentities.hits.map(hit => hit.object_id),
    '容量裁页保留被裁身份，不能把已取候选都算已交付');
  await invoke('search_knowledge', capacityArgs, 'tool_response_capacity', {...responseBudget, max_bytes: 0});
  await invoke('search_knowledge', capacityArgs, 'tool_response_capacity', {...responseBudget, max_bytes: 262144, estimated_tokens: 0});
  assert.equal(embedding.requests.length, embeddingBeforeIdentity, '身份分页及容量裁剪不调用embedding');
  assert.deepEqual(h.sql(`SELECT authority_snapshot FROM agent_runs WHERE id='${run.run_id}'`)[0], authorityBeforeIdentity);
  checks.push('元信息权限与个人资产隔离、keyset分页、查询/kinds/hints绑定及字节/token容量续读');

  await invoke('update_analysis_task', {action: 'revise', task_id: undeclaredTask.task_id,
    expected_version: undeclaredTask.condition_version, goal: '',
    condition_patch: {set: {}, unset: ['source_limits']}, options: []});
  // 保留未知映射检验（二）：等价覆盖“映射不完整不能当无来源”（references.rs:352 + knowledge_sources.rs:173）。
  // mapping_state='complete' 时窄读 description 只核本条目来源 business-guide@1；
  // mapping_state='unknown' 时窄读回退核验整卡全部必要来源，etl 换版即返回 stale，绝不当无额外来源放行。
  h.sql(`UPDATE source_heads SET version=2 WHERE id='etl'`);
  try {
    const completeNarrow = await invoke('read_knowledge', {items: [{kind: 'knowledge',
      ref: {object_id: 'table-demo_order_detail', version: '1', path: 'description'}}]});
    assert.equal(completeNarrow.items[0].state, 'ok', '映射完整时窄读仅核所选条目自身来源');
    h.sql(`UPDATE knowledge_dependency_states SET mapping_state='unknown' WHERE owner_id='table-demo_order_detail' AND owner_version=1`);
    try {
      const unknownNarrow = await invoke('read_knowledge', {items: [{kind: 'knowledge',
        ref: {object_id: 'table-demo_order_detail', version: '1', path: 'description'}}]});
      assert.equal(unknownNarrow.items[0].state, 'stale', 'mapping_state=unknown不能当无来源：窄读回退整卡必要来源核验');
    } finally {
      h.sql(`UPDATE knowledge_dependency_states SET mapping_state='complete' WHERE owner_id='table-demo_order_detail' AND owner_version=1`);
    }
  } finally {
    h.sql(`UPDATE source_heads SET version=1 WHERE id='etl'`);
  }
  await invoke('search_knowledge', {...directoryArgs, view: 'evidence', cursor: identityCursor}, 'invalid_cursor');
  await invoke('search_knowledge', {query: directoryArgs.query, kinds: directoryArgs.kinds, limit: directoryArgs.limit,
    hints: directoryArgs.hints, cursor: identityCursor}, 'invalid_cursor');
  const evidencePage = await invoke('search_knowledge', {query: '*', limit: 1});
  validateContract('KnowledgeSearchReply', evidencePage);
  assert.deepEqual(evidencePage.hits, [], 'query=*按原合约只翻本人资产目录，不伪称公共取证');
  assert.equal(evidencePage.asset_total,1);assert.equal(evidencePage.personal_memories.length,1);
  assert.equal(evidencePage.personal_memories[0].name,directoryName+'alice');
  assert.equal(evidencePage.personal_memories[0].body,identityMarker,'合法route后默认视图保留本人可读正文，不被身份视图永久裁空');
  checks.push('合法route保留默认资产目录及metadata游标错投取证拒绝；真实取证游标反向负控沿现有search-continuation夹具');
  const staleOverflow = await invoke('read_source', {citation: {...citation, revision: '2', locator: {offset: 0, length: [...body].length + 10}}, limit: 1}, 'stale_source');
  for (const hidden of ['source_length', 'available_length', 'valid_locator', 'requested_locator']) {
    assert.equal(Object.hasOwn(staleOverflow, hidden), false, `stale_source不能泄露${hidden}`);
  }
  const tailOverflow = await invoke('read_source', {citation: {...citation, locator: {offset: [...body].length - 1, length: 2}}, limit: 1}, 'invalid_input');
  assert.deepEqual(tailOverflow.source, citation.source);
  assert.equal(tailOverflow.revision, source.version);
  assert.deepEqual(tailOverflow.requested_locator, {offset: [...body].length - 1, length: 2});
  assert.equal(tailOverflow.source_length, [...body].length);
  assert.equal(tailOverflow.available_length, 1);
  assert.deepEqual(tailOverflow.valid_locator, {offset: [...body].length - 1, length: 1});
  assert.equal(tailOverflow.hint.includes(String([...body].length)), true);
  const correctedTail = await invoke('read_source', {citation: {...citation, locator: tailOverflow.valid_locator}, limit: 1});
  validateContract('SourceReadReply', correctedTail);
  assert.equal(correctedTail.text, [...body].slice(-1).join(''));
  assert.equal(correctedTail.content_state, 'complete');
  assert.equal(correctedTail.next_locator, null);
  const headOverflow = await invoke('read_source', {citation: {...citation, locator: {offset: 0, length: [...body].length + 50}}, limit: 1}, 'invalid_input');
  assert.equal(headOverflow.source_length, [...body].length);
  assert.equal(headOverflow.available_length, [...body].length);
  assert.deepEqual(headOverflow.valid_locator, {offset: 0, length: [...body].length});
  const atEndOverflow = await invoke('read_source', {citation: {...citation, locator: {offset: [...body].length, length: 1}}}, 'invalid_input');
  assert.equal(atEndOverflow.source_length, [...body].length);
  assert.equal(atEndOverflow.available_length, 0);
  assert.equal(atEndOverflow.valid_locator, null);
  const beyondEndOverflow = await invoke('read_source', {citation: {...citation, locator: {offset: [...body].length + 5, length: 2}}}, 'invalid_input');
  assert.equal(beyondEndOverflow.source_length, [...body].length);
  assert.equal(beyondEndOverflow.available_length, 0);
  assert.equal(beyondEndOverflow.valid_locator, null);
  const empty = await invoke('read_source', {citation: {...citation, locator: {offset: [...body].length, length: 0}}, limit: 1});
  assert.equal(empty.text, ''); assert.equal(empty.content_state, 'complete'); assert.equal(empty.next_locator, null);
  const platformCitation = {source: {kind: 'platform', id: 'business-guide'}, revision: '1', locator: {offset: 0, length: 10}};
  const platform = await invoke('read_source', {citation: platformCitation});
  validateContract('SourceReadReply', platform);
  assert.equal(platform.text, '# 虚构零售业务说明'); assert.equal(platform.source_length > 10, true);
  const platformOverflow = await invoke('read_source', {citation: {...platformCitation, locator: {offset: 0, length: platform.source_length + 100}}, limit: 10}, 'invalid_input');
  assert.deepEqual(platformOverflow.source, platformCitation.source);
  assert.equal(platformOverflow.revision, '1');
  assert.deepEqual(platformOverflow.requested_locator, {offset: 0, length: platform.source_length + 100});
  assert.equal(platformOverflow.source_length, platform.source_length);
  assert.equal(platformOverflow.available_length, platform.source_length);
  assert.deepEqual(platformOverflow.valid_locator, {offset: 0, length: platform.source_length});
  const platformPaged = await invoke('read_source', {citation: {...platformCitation, locator: platformOverflow.valid_locator}, limit: 10});
  validateContract('SourceReadReply', platformPaged);
  assert.equal(platformPaged.text, '# 虚构零售业务说明');
  assert.equal(platformPaged.content_state, 'partial');
  assert.deepEqual(platformPaged.next_locator, {offset: 10, length: platform.source_length - 10});
  const unavailableOverflow = await invoke('read_source', {citation: {...citation, source: {kind: 'document', id: 'synthetic-unavailable-document'}, locator: {offset: 0, length: 999}}, limit: 1}, 'not_available');
  for (const hidden of ['source_length', 'available_length', 'valid_locator', 'requested_locator']) {
    assert.equal(Object.hasOwn(unavailableOverflow, hidden), false, `not_available不能泄露${hidden}`);
  }
  checks.push('当前修订、原请求越界纠错回执、平台与document各自坐标/尾页/UTF8超界纠错及stale/unavailable零泄露');

  const conditions = {time_start: null, time_end: null, timezone: 'UTC', metric: null, channel: null,
    group_by: [], filters: [], knowledge_refs: [], notes: '', source_limits: {
      allowed_sources: [{kind: 'document', id: source.id}], origin_message_ids: [run.message_id]}};
  const task = await invoke('update_analysis_task', {action: 'create', goal: '核对合成区间', conditions, options: []});
  const taskRef = {task_id: task.task_id, condition_version: task.condition_version};
  const exact = await invoke('read_source', {citation, task_ref: taskRef});
  assert.equal(exact.text, selected); assert.equal(exact.content_state, 'complete');
  await invoke('read_source', {citation, task_ref: {...taskRef, task_id: 'different-task'}}, 'task_context_required');
  await invoke('read_source', {citation, task_ref: {...taskRef, condition_version: '999'}}, 'version_conflict');
  const outside = await h.request('/knowledge', {operation_id: randomUUID(), kind: 'document', name: '合成范围外文档', body: '范围外正文不得读取。', related_ids: []});
  assert.equal(outside.status, 200, JSON.stringify(outside.value));
  const authorityBeforeDiscovery = h.sql(`SELECT authority_snapshot FROM agent_runs WHERE id='${run.run_id}'`)[0];
  const embeddingBeforeDiscovery = embedding.requests.length;
  const outsideIdentity = await invoke('search_knowledge', {view: 'source_identity', query: '合成范围外文档', kinds: ['document']});
  validateContract('KnowledgeSearchReply', outsideIdentity);
  assert.deepEqual(outsideIdentity.hits, [{record_kind: 'source_identity', name: '合成范围外文档', kind: 'document',
    object_id: outside.value.id, object_version: outside.value.version,
    source_keys: [{kind: 'document', id: outside.value.id}], roots_complete: true}],
    '业务来源允许集不妨碍当前用户发现其他可读来源身份');
  assert.equal(embedding.requests.length, embeddingBeforeDiscovery);
  assert.deepEqual(h.sql(`SELECT authority_snapshot FROM agent_runs WHERE id='${run.run_id}'`)[0], authorityBeforeDiscovery);
  const outsideDenied = await invoke('read_source', {citation: {source: {kind: 'document', id: outside.value.id}, revision: outside.value.version, locator: {offset: 0, length: 999}}}, 'source_not_allowed');
  const platformDenied = await invoke('read_source', {citation: {source: {kind: 'platform', id: 'business-guide'}, revision: '1', locator: {offset: 0, length: 99999}}}, 'source_not_allowed');
  for (const denied of [outsideDenied, platformDenied]) {
    for (const hidden of ['source_length', 'available_length', 'valid_locator', 'requested_locator']) {
      assert.equal(Object.hasOwn(denied, hidden), false, `source_not_allowed不能泄露${hidden}`);
    }
  }
  assert.equal((await invoke('read_source', {citation})).text, selected, '省略任务引用继续继承实际活动范围');
  const authority = h.sql(`SELECT authority_snapshot FROM agent_runs WHERE id='${run.run_id}'`)[0];
  assert.ok(!authority.sources.some(reference => reference[0] === 'document-' + outside.value.id));
  checks.push('显式任务核对、不隐式切任务、缺省继承与范围外正文拒绝');
  h.releaseRun(run.run_id);
  passed = true;
  console.log(JSON.stringify({passed, checks, calls, officialRequests: 0}));
} finally {
  if (previousTest === undefined) delete process.env.DATA_AGENT_PROVIDER_TEST; else process.env.DATA_AGENT_PROVIDER_TEST = previousTest;
  if (h) { await writeFile(h.directory + '/evidence-source.json', JSON.stringify({passed, checks, errors, calls, officialRequests: 0}, null, 2)); await h.close(); }
  if (prepared) {
    const dropped = await fetch('http://127.0.0.1:19531/v2/vectordb/collections/drop', {method: 'POST', headers: {'content-type': 'application/json', authorization: 'Bearer root:' + vectorToken}, body: JSON.stringify({dbName: 'default', collectionName: collection})});
    assert.equal((await dropped.json()).code, 0);
  }
  await embedding.close();
  provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
}

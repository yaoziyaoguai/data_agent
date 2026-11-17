import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {deliver} from '../../apps/agent/session/deliver.ts';
import {validateContract} from '../../packages/contracts/validate.ts';
import {harness, until} from './harness.mjs';
import {embeddingProvider} from './embedding-provider.mjs';

const query = 'evidencemixedneedle';
const definition = query + ' 合成校准只统计经人工确认的条目。';
const rawText = query + ' 合成异常条目须在次日复核，未经复核不得计入。';
const collection = 'data_agent_test_' + randomUUID().replaceAll('-', '');
const vectorToken = (await readFile('.local/infra/milvus-root-password', 'utf8')).trim();
const embedding = await embeddingProvider();
const indexed = new Set(), searches = [], providerErrors = [], providerTools = [];
let modelCalls = 0, run, knowledge, source, h, passed = false, preparedCollection = false, savedSupports = false;
const scope = '未经复核不得计入。';
const longCondition = '必要条件🧪：合成登记必须确认。'.repeat(600);
const supportParts = [], invocations = [];
let longSupport = false, longCalls = 0, summaryCalls = 0, supportCalls = 0, searchHit, supportCursor;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (longSupport && String(input).endsWith('/internal/data/tools') && typeof init?.body === 'string') {
    const value = JSON.parse(init.body);
    if (['search_knowledge', 'read_knowledge'].includes(value.tool_name)) {
      assert.ok(value.response_budget);
      value.response_budget = {...value.response_budget,
        max_bytes: Math.min(5000, value.response_budget.max_bytes),
        estimated_tokens: Math.min(1250, value.response_budget.estimated_tokens)};
      invocations.push(value);
      init = {...init, body: JSON.stringify(value)};
    }
  }
  return originalFetch(input, init);
};
const proxy = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8'), input = JSON.parse(raw);
    const remote = await fetch('http://127.0.0.1:19531' + request.url, {
      method: 'POST', headers: {'content-type': 'application/json', authorization: request.headers.authorization}, body: raw,
    });
    const text = await remote.text();
    const payload = JSON.parse(text);
    if (request.url.endsWith('/upsert') && payload.code === 0) {
      for (const row of input.data ?? []) indexed.add(row.target + ':' + row.object_id);
    }
    if (request.url.endsWith('/search')) searches.push({collection: input.collectionName, channel: input.annsField, filter: input.filter, success: remote.ok && payload.code === 0});
    response.writeHead(remote.status, {'content-type': 'application/json'}).end(text);
  } catch (error) {
    providerErrors.push({boundary: 'vector', message: error.message});
    response.writeHead(503).end('{"code":1}');
  }
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const provider = createServer(async (request, response) => {
  try {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    modelCalls++;
    assert.ok(Buffer.byteLength(raw) <= 131072, '摘要与普通请求均沿原载荷上限');
    let delta;
    if (!input.tools?.length) {
      assert.ok(longSupport, '最小纵向链不需要历史摘要');
      summaryCalls++;
      delta = {role: 'assistant', content: '合成历史摘要：正在沿同一支持的游标补读必要条件。已取得'
        + supportParts.reduce((sum, part) => sum + [...part].length, 0) + '个Unicode字符；知识定位='
        + JSON.stringify({ref: searchHit.ref, statement_id: searchHit.statement_id})
        + '，下一支持位置=' + supportCursor + '。原工具保持原身份和冻结回执。'};
    } else if (longSupport) {
      longCalls++;
      assert.ok(longCalls <= 12, '搜索与长支持补读沿原24次预算有界推进');
      const message = input.messages.findLast(message => message.role === 'tool');
      if (!message) {
        delta = {role: 'assistant', tool_calls: [
          {index: 0, id: 'long-search-route', type: 'function', function: {name: 'update_analysis_task', arguments: JSON.stringify({action: 'route', task_id: null, expected_version: null, goal: '', options: []})}},
          {index: 1, id: 'long-search-first', type: 'function', function: {name: 'search_knowledge', arguments: JSON.stringify({query, kinds: ['term'], limit: 1})}},
        ]};
      } else {
        const result = JSON.parse(message.content);
        if (result.error === 'tool_response_capacity') {
          assert.ok(summaryCalls > 0, '容量拒绝须先经过Pi原生摘要再交回模型');
          const invocation = invocations.find(value => value.sdk_tool_call_id === message.tool_call_id);
          assert.ok(invocation.response_budget.max_bytes < 5000 || invocation.response_budget.estimated_tokens < 1250,
            '充分余量下的支持分页不能以容量拒绝代替');
          assert.equal(invocation.arguments.items[0].supports_cursor, supportCursor, '容量拒绝不推进原支持位置');
          const rejected = await h.internal('/internal/data/tool-rejections', invocation);
          assert.equal(rejected.status, 200); assert.deepEqual(result, rejected.value.data);
          const replay = await h.internal('/internal/data/tools', invocation);
          assert.equal(replay.status, 200); assert.deepEqual(replay.value, rejected.value, '同一原操作接回冻结拒绝');
          delta = {role: 'assistant', tool_calls: [{index: 0, id: 'long-search-support-' + (++supportCalls), type: 'function',
            function: {name: 'read_knowledge', arguments: JSON.stringify({items: [{kind: 'knowledge', ref: searchHit.ref,
              statement_id: searchHit.statement_id, limit: 0, supports_cursor: supportCursor}]})}}]};
        } else {
        assert.equal(result.error, undefined, message.content);
        const encoded = JSON.stringify(result);
        assert.ok(Buffer.byteLength(encoded) <= 5000); assert.ok(Math.ceil(encoded.length / 4) <= 1250);
        const stored = h.sql(`SELECT receipt FROM tool_calls WHERE conversation_id='${run.conversation_id}' AND sdk_tool_call_id='${message.tool_call_id}'`)[0];
        if (result.search_coverage) {
          if (typeof result.search_coverage.next === 'string')
            assert.equal(result.search_coverage.next, 'rc1:' + stored.operation_id, 'provider只见本操作短引用');
          assert.deepEqual(result, {...stored.data, search_coverage: {...stored.data.search_coverage, next: result.search_coverage.next}},
            '搜索续页的实际provider正文均等首次Rust回执的公开投影');
        } else {
          assert.deepEqual(result, stored.data, '支持续页的实际provider正文均等首次Rust回执');
        }
        let item;
        if (message.tool_call_id === 'long-search-first') {
          validateContract('KnowledgeSearchReply', result);
          assert.equal(result.hits.length, 1); item = result.hits[0]; searchHit = item;
          assert.equal(item.ref.object_id, knowledge.id); assert.equal(item.ref.version, knowledge.version);
          assert.ok([...item.definition].length <= [...definition].length);
          assert.equal(item.definition, [...definition].slice(0, [...item.definition].length).join(''));
          assert.equal(item.scope_text, [...longCondition].slice(0, [...item.scope_text].length).join(''));
          assert.equal(item.continuation.content_next_offset, [...item.definition].length < [...definition].length
            ? [...item.definition].length : [...definition].length + 1 + [...item.scope_text].length, '支持优先裁剪后正文位置仍以该陈述为原点');
          assert.equal(typeof result.search_coverage.next, 'string', '其余规范位置仍由独立公共游标保留');
          assert.equal(result.search_coverage.next.includes('必要条件'), false);
          assert.ok([...item.scope_text].length < [...longCondition].length, '巨大scope没有完整交付，不能据此标完整支持');
        } else {
          validateContract('KnowledgeReadReply', result);
          assert.equal(result.items.length, 1); item = result.items[0];
          assert.equal(item.state, 'ok'); assert.equal(item.content, '');
          assert.equal(item.continuation.content_next_offset, 0, '支持续读不冒充正文推进');
        }
        assert.equal(item.supports_complete, true); assert.equal(item.support_state, 'partial');
        let end = supportParts.reduce((sum, part) => sum + [...part].length, 0);
        if (item.supports.length === 0) {
          assert.equal(message.tool_call_id, 'long-search-first', 'limit=0支持续读必须交正文或明确容量拒绝，不能成功空转');
          assert.equal(typeof item.continuation.supports_next_cursor, 'string');
        } else {
          assert.equal(item.supports.length, 1);
          const support = item.supports[0], offset = end;
          assert.equal(support.support_id, knowledge.entries[0].human_override.statements[0].supports[0].support_id);
          assert.equal(Object.hasOwn(support, 'delivered_in'), false, '未交完整承载段不能指向裁掉的scope');
          assert.ok(support.content?.length > 0);
          end += [...support.content].length;
          assert.equal(support.content, [...longCondition].slice(offset, end).join(''));
          assert.deepEqual(support.content_page, {offset, total_chars: [...longCondition].length, complete: false,
            next_offset: end < [...longCondition].length ? end : null});
          supportParts.push(support.content);
        }
        if (end === [...longCondition].length) {
          assert.equal(item.continuation.supports_next_cursor, null);
          delta = {role: 'assistant', content: '已沿搜索支持位置取得合成必要条件，正文与公共位置可独立补读。'};
        } else {
          assert.equal(typeof item.continuation.supports_next_cursor, 'string');
          supportCursor = item.continuation.supports_next_cursor;
          delta = {role: 'assistant', tool_calls: [{index: 0, id: 'long-search-support-' + (++supportCalls), type: 'function',
            function: {name: 'read_knowledge', arguments: JSON.stringify({items: [{kind: 'knowledge', ref: searchHit.ref,
              statement_id: searchHit.statement_id, limit: 0, supports_cursor: item.continuation.supports_next_cursor}]})}}]};
        }
        }
      }
    } else if (modelCalls === 1 || modelCalls === 3) {
      const search = input.tools.find(tool => tool.function?.name === 'search_knowledge');
      assert.ok(search);
      assert.equal(search.function.parameters.additionalProperties, false);
      assert.equal(Object.hasOwn(search.function.parameters.properties, 'related_object_id'), false, '合同2不发布旧硬范围参数');
      delta = {role: 'assistant', tool_calls: [
        {index: 0, id: 'evidence-route', type: 'function', function: {name: 'update_analysis_task', arguments: JSON.stringify({action: 'route', task_id: null, expected_version: null, goal: '', question: null, options: []})}},
        {index: 1, id: 'evidence-search', type: 'function', function: {name: 'search_knowledge', arguments: JSON.stringify({query, limit: 2, kinds: ['term', 'document']})}},
      ]};
    } else {
      assert.ok(modelCalls === 2 || modelCalls === 4, '历史unknown与人工声明两例各一次调查、一次续答');
      const message = input.messages.find(message => message.role === 'tool' && message.tool_call_id === 'evidence-search');
      assert.ok(message, '实际provider请求必须含Pi配对的工具正文');
      const result = JSON.parse(message.content);
      validateContract('KnowledgeSearchReply', result);
      assert.equal(result.hits.length, 2);
      const semantic = result.hits.find(hit => hit.record_kind === 'knowledge_entry');
      const original = result.hits.find(hit => hit.record_kind === 'source_excerpt');
      assert.ok(semantic && original, '统一stage必须同时交付knowledge和raw，不设类型配额');
      assert.deepEqual(semantic.ref, {object_id: knowledge.id, version: knowledge.version, path: 'body'});
      assert.equal(semantic.definition, definition);
      assert.equal(semantic.supports_complete, savedSupports ? true : null, '搜索完整性必须来自保存声明，历史仍unknown');
      assert.equal(semantic.support_state, savedSupports ? 'delivered' : 'unknown');
      if (savedSupports) {
        assert.equal(semantic.scope_text, scope);
        assert.equal(semantic.supports.length, 1);
        const support = semantic.supports[0];
        assert.equal(support.content, null);
        assert.deepEqual(support.delivered_in, {path: `/hits/${result.hits.indexOf(semantic)}/scope_text`, locator: {offset: 0, length: [...scope].length}}, '搜索已保留完整例外字段才可用本回执映射');
        assert.deepEqual(support.reference.citation, {source: {kind: 'document', id: source.id}, revision: source.version, locator: {offset: [...rawText].length - [...scope].length, length: [...scope].length}});
        assert.equal(semantic.continuation.supports_next_cursor, null);
      }
      assert.equal(semantic.content_state, 'complete');
      assert.deepEqual(original.citation, {source: {kind: 'document', id: source.id}, revision: source.version, locator: {offset: 0, length: [...rawText].length}});
      assert.equal(original.source_length, [...rawText].length);
      assert.equal(original.name, source.name);
      assert.equal(original.text, rawText);
      assert.equal(original.content_state, 'complete');
      assert.equal(original.support_state, 'unknown');
      assert.equal(original.semantic_status, 'pending');
      assert.equal(Object.hasOwn(original, 'ref'), false);
      const stored = h.sql(`SELECT receipt FROM tool_calls WHERE conversation_id='${run.conversation_id}' AND recovery_chain_id='${run.recovery_chain_id}' AND sdk_tool_call_id='evidence-search'`)[0];
      assert.ok(stored);
      if (typeof result.search_coverage.next === 'string')
        assert.equal(result.search_coverage.next, 'rc1:' + stored.operation_id, 'provider只见本操作短引用');
      assert.deepEqual(result, {...stored.data, search_coverage: {...stored.data.search_coverage, next: result.search_coverage.next}},
        'provider正文须与Rust冻结回执逐字段一致（公开游标投影除外），Pi不得二次改写');
      const authority = h.sql(`SELECT authority_snapshot FROM agent_runs WHERE id='${run.run_id}'`)[0];
      assert.ok(authority.knowledge.some(reference => reference[0] === knowledge.id && reference[1] === knowledge.version));
      assert.ok(authority.sources.some(reference => reference[0] === 'document-' + source.id && reference[1] === source.version));
      providerTools.push(result);
      delta = {role: 'assistant', content: '已核对合成定义及异常复核条件。'};
    }
    response.writeHead(200, {'content-type': 'text/event-stream'});
    response.write('data: ' + JSON.stringify({id: 'evidence-delivery', choices: [{index: 0, delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop'}]}) + '\n\n');
    response.write('data: ' + JSON.stringify({choices: [], usage: {prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100}}) + '\n\n');
    response.end('data: [DONE]\n\n');
  } catch (error) {
    providerErrors.push({boundary: 'model', message: error.message});
    response.writeHead(400, {'content-type': 'application/json'}).end(JSON.stringify({error: {message: 'synthetic_contract_assertion_failed', type: 'invalid_request_error'}}));
  }
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const previousTest = process.env.DATA_AGENT_PROVIDER_TEST;
process.env.DATA_AGENT_PROVIDER_TEST = '1';
try {
  const profile = {provider_id: 'deepseek', model_id: 'deepseek-flash', trial_id: randomUUID(), price_version: '2026-10-04-peak-usd', input_limit: 65536, output_limit: 8192, trial_call_limit: 24, trial_cost_micros: '300000', request_call_limit: 24, toolset: 'data', payload_bytes_limit: 131072, thinking_level: 'off'};
  h = await harness({capture: true, startWorker: false, profile, protocolProviderUrl: 'http://127.0.0.1:' + provider.address().port, env: {
    ...embedding.env, DATA_AGENT_LEASE_MS: '120000', DATA_AGENT_TOOL_CONTRACT_VERSION: '2', DATA_AGENT_PREFILL_PROFILE: '',
    DATA_AGENT_VECTOR_URL: 'http://127.0.0.1:' + proxy.address().port, DATA_AGENT_VECTOR_COLLECTION: collection,
    DATA_AGENT_VECTOR_TOKEN_FILE: process.cwd() + '/.local/infra/milvus-root-password',
  }});
  const prepared = await h.request('/knowledge-index/rebuilds', {operation_id: randomUUID()});
  assert.equal(prepared.status, 200, JSON.stringify(prepared.value));
  preparedCollection = true;
  const term = await h.request('/knowledge', {operation_id: randomUUID(), kind: 'term', name: '合成校准口径', body: definition, related_ids: []});
  assert.equal(term.status, 200, JSON.stringify(term.value)); knowledge = term.value;
  const document = await h.request('/knowledge', {operation_id: randomUUID(), kind: 'document', name: '合成异常手册', body: rawText, related_ids: []});
  assert.equal(document.status, 200, JSON.stringify(document.value)); source = document.value;
  await h.resumeWorker();
  await until(() => indexed.has('knowledge_entry:' + knowledge.id) && indexed.has('source_excerpt:' + source.id), '正式消费者写入两类合成正文', 120000);
  const cid = await h.create(); run = await h.capture(cid, '核对合成校准定义和异常复核要求。');
  await h.pauseWorker();
  assert.equal(run.tool_contract_version, 2, '专用验收run必须冻结显式合同2');
  try { await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, ''); }
  catch (error) { assert.deepEqual(providerErrors, [], JSON.stringify(providerErrors)); throw error; }
  h.releaseRun(run.run_id);
  assert.deepEqual(providerErrors, []);
  assert.equal(modelCalls, 2);
  assert.equal(providerTools.length, 1);
  const supportCitation = {source: {kind: 'document', id: source.id}, revision: source.version, locator: {offset: [...rawText].length - [...scope].length, length: [...scope].length}};
  const edited = await h.request('/knowledge/' + knowledge.id, {operation_id: randomUUID(), expected_version: knowledge.version, entry_id: 'body', value: definition + '\n' + scope,
    statements: [{key: 'calibration-rule', target: {object_id: knowledge.id, version: knowledge.version, path: 'body'}, text: definition, scope_text: scope, citations: [], supports_complete: true,
      supports: [{key: 'review-exception', role: 'exception', reference: {kind: 'source', citation: supportCitation}, content: scope, embedded_in: {field: 'scope_text', locator: {offset: 0, length: [...scope].length}}}]}]}, 'alice', 'PATCH');
  assert.equal(edited.status, 200, JSON.stringify(edited.value)); knowledge = edited.value;
  indexed.delete('knowledge_entry:' + knowledge.id);
  savedSupports = true;
  await h.resumeWorker();
  await until(() => indexed.has('knowledge_entry:' + knowledge.id), '人工陈述及支持保存后重建正式候选', 120000);
  run = await h.capture(await h.create(), '核对已保存合成定义及其必要例外。'); await h.pauseWorker();
  try {await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, '');}
  catch (error) {assert.deepEqual(providerErrors, [], JSON.stringify(providerErrors)); throw error;}
  h.releaseRun(run.run_id);
  assert.deepEqual(providerErrors, []); assert.equal(modelCalls, 4); assert.equal(providerTools.length, 2);
  assert.ok(searches.some(search => search.success && search.collection === collection && search.filter.includes('kind == "source_excerpt"')), 'raw必须走正式公共Milvus通道');
  assert.ok(searches.some(search => search.success && search.collection === collection && search.filter.includes('kind in ["term","document"]')), 'knowledge必须按实际kinds走同一公共集合的知识通道');
  const snapshot = await h.snapshot(run.conversation_id);
  assert.equal(snapshot.runs.find(value => value.run_id === run.run_id).state, 'finished');
  const reference = await h.request('/knowledge', {operation_id: randomUUID(), kind: 'term', name: '合成长支持引用摘要', body: '合成简短引用，不能替代保存条件。', related_ids: []});
  assert.equal(reference.status, 200);
  const longEdited = await h.request('/knowledge/' + knowledge.id, {operation_id: randomUUID(), expected_version: knowledge.version,
    entry_id: 'body', value: definition + '\n' + longCondition,
    statements: [{key: 'search-long-rule', target: {object_id: knowledge.id, version: knowledge.version, path: 'body'},
      text: definition, scope_text: longCondition, citations: [], supports_complete: true,
      supports: [{key: 'long-required-condition', role: 'prerequisite', reference: {kind: 'knowledge', ref: {object_id: reference.value.id, version: reference.value.version, path: 'body'}},
        content: longCondition, embedded_in: {field: 'scope_text', locator: {offset: 0, length: [...longCondition].length}}}]}]}, 'alice', 'PATCH');
  assert.equal(longEdited.status, 200, JSON.stringify(longEdited.value)); knowledge = longEdited.value;
  indexed.delete('knowledge_entry:' + knowledge.id);
  await h.resumeWorker();
  await until(() => indexed.has('knowledge_entry:' + knowledge.id)
    && h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM knowledge_index_jobs WHERE target_kind='knowledge_entry' AND object_id='${knowledge.id}' AND version=${knowledge.version} AND vector_state<>'indexed'`)[0].n === 0,
    '正式消费者完成带长支持的当前修订', 120000);
  run = await h.capture(await h.create(), '从搜索小回执补齐原保存的合成长条件。'); await h.pauseWorker(); longSupport = true;
  try {await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, '');}
  catch (error) {assert.deepEqual(providerErrors, [], JSON.stringify(providerErrors)); throw error;}
  assert.equal(supportParts.join(''), longCondition); assert.ok(supportParts.length > 1);
  const attempts = h.sql(`SELECT JSON_OBJECT('state',state,'purpose',purpose) FROM model_call_attempts WHERE budget_scope_id='${run.budget_scope_id}'`);
  assert.ok(attempts.length <= 24, '摘要与补读共用原24次请求模型预算');
  assert.equal(attempts.filter(attempt => attempt.state === 'issued').length, 0, '原模型attempt全部收尾');
  h.releaseRun(run.run_id); assert.deepEqual(providerErrors, []);
  passed = true;
  console.log(JSON.stringify({passed, checks: ['显式合同2→统一stage→owner→Rust回执→Pi→实际provider逐字', '两类正文出处、历史unknown和当前authority保持', '人工保存的完整支持声明及实际承载例外逐字交付', '搜索5000B长支持沿原游标拼回，正文与公共位置独立且无悬空承载'], modelCalls, publicSearches: searches.length, officialRequests: 0}));
} finally {
  globalThis.fetch = originalFetch;
  if (previousTest === undefined) delete process.env.DATA_AGENT_PROVIDER_TEST; else process.env.DATA_AGENT_PROVIDER_TEST = previousTest;
  if (h) {
    await writeFile(h.directory + '/evidence-delivery.json', JSON.stringify({passed, modelCalls, providerErrors, searches,
      longSupport: {calls: longCalls, summaryCalls, pages: supportParts.length, characters: [...supportParts.join('')].length,
        expectedCharacters: [...longCondition].length}, officialRequests: 0}, null, 2));
    await h.close();
  }
  if (preparedCollection) {
    const dropped = await fetch('http://127.0.0.1:19531/v2/vectordb/collections/drop', {method: 'POST',
      headers: {'content-type': 'application/json', authorization: 'Bearer root:' + vectorToken},
      body: JSON.stringify({dbName: 'default', collectionName: collection})});
    assert.equal((await dropped.json()).code, 0, '只清理本次专用Milvus集合');
  }
  await embedding.close();
  for (const server of [provider, proxy]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

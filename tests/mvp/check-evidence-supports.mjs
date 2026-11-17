import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {deliver} from '../../apps/agent/session/deliver.ts';
import {validateContract} from '../../packages/contracts/validate.ts';
import {harness} from './harness.mjs';

const collection = 'data_agent_test_' + randomUUID().replaceAll('-', '');
const vectorToken = (await readFile('.local/infra/milvus-root-password', 'utf8')).trim();
const text = '合成设备只计入已确认记录。', scope = '例外：停用设备必须排除。';
const prerequisite = '必要条件：必须绑定当前合成设备标识。';
const errors = [], checks = [];
let h, object, source, run, calls = 0, prepared = false, passed = false;
const longText = '合成规则正文🧪。'.repeat(1000);
const longCondition = '必要条件🧪：合成设备必须登记。'.repeat(650);
const mixedLong = '分配次序🧪：先交完整短例外。'.repeat(600);
const shortExceptionA = '例外甲：停用设备必须排除。';
const shortExceptionB = '例外乙：未确认设备必须排除。';
let longSupport = false, longCalls = 0;
let allocation = null, allocationCalls = 0, allocationSlices = [], allocationSeen = [];
const supportParts = [];
const originalFetch = globalThis.fetch;
let bounded = false;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if ((bounded || allocation) && url.endsWith('/internal/data/tools') && typeof init?.body === 'string') {
    const value = JSON.parse(init.body);
    if (value.tool_name === 'read_knowledge') {
      assert.ok(value.response_budget, '实际Pi读取执行前必须分配宿主容量');
      value.response_budget = {...value.response_budget,
        max_bytes: allocation ? 8000 : longSupport ? 5000 : 2600,
        estimated_tokens: allocation ? 2000 : longSupport ? 1250 : 650};
      init = {...init, body: JSON.stringify(value)};
    }
  }
  return originalFetch(input, init);
};
const provider = createServer(async (request, response) => {
  try {
    let raw = '';
    // 多字节字符可能跨TCP分段：先收集Buffer再整体解码，逐块toString会把边界字符变U+FFFD。
    const buffers = [];
    for await (const chunk of request) buffers.push(chunk);
    raw = Buffer.concat(buffers).toString('utf8');
    const input = JSON.parse(raw);
    calls++;
    const reference = {object_id: object.id, version: object.version, path: 'body'};
    const sid = object.entries[0].human_override.statements[0].statement_id;
    let delta;
    if (allocation) {
      // R11：同命中长条件在前、短例外在后时，回执先完整交短例外，再用余量分片长条件；
      // 续页只续未完长条件，末片推进但不冒称整条delivered。
      allocationCalls++;
      assert.ok(allocationCalls <= 24, '长短混合分配须沿原每消息24次预算推进');
      if (!input.tools) {
        // Pi压缩重试的摘要请求不带工具：必须回正文摘要；回工具调用会使压缩中止、
        // 原上下文重试再次超过payload_bytes_limit而中断交付。
        delta = {role: 'assistant', content: '已按先短后长次序汇总：短例外完整交付，长条件沿原游标逐页续读，已交分片内容以本摘要为准。'};
      } else {
      const message = input.messages.findLast(message => message.role === 'tool');
      if (!message) {
        // §6.1：route回执裁决来源并刷新投影前，正文读取工具不可见，route单独成轮。
        delta = {role: 'assistant', tool_calls: [
          {index: 0, id: 'allocation-route', type: 'function', function: {name: 'update_analysis_task', arguments: JSON.stringify({action: 'route', task_id: null, expected_version: null, goal: '', question: null, options: []})}},
        ]};
      } else if (message.tool_call_id === 'allocation-route') {
        delta = {role: 'assistant', tool_calls: [
          {index: 0, id: 'allocation-first', type: 'function', function: {name: 'read_knowledge', arguments: JSON.stringify({items: [{kind: 'knowledge', ref: reference, statement_id: sid, limit: 0}]})}},
        ]};
      } else {
        const result = JSON.parse(message.content);
        validateContract('KnowledgeReadReply', result);
        assert.equal(result.error, undefined, message.content);
        const item = result.items[0];
        assert.equal(item.state, 'ok'); assert.equal(item.content, '', '只续支持，不重传陈述正文');
        const supports = item.supports;
        for (const support of supports) {
          if (support.content_page?.next_offset === null || support.content_page === undefined) {
            // 已完整交付的支持不得在任何后续回执重复出现。
            assert.equal(allocationSeen.includes(support.support_id), false, '完整交付的支持不得跨回执重复');
            allocationSeen.push(support.support_id);
          }
        }
        // 字节上限由Rust分配器在其自身序列化上强制；这里核宿主令牌估算约束。
        assert.ok(Math.ceil(JSON.stringify(result).length / 4) <= 2000, '混合回执仍受宿主令牌估算限制');
        if (allocationCalls === 3) {
          assert.equal(supports.length, allocation.shorts.length + 1,
            '首回执先交全部完整短例外，再用余量分片首条长条件');
          allocation.shorts.forEach((short, index) => {
            assert.equal(supports[index].content, short);
            assert.equal(supports[index].content_page, undefined, '短例外必须完整交付，不分片');
          });
          const sliced = supports[allocation.shorts.length];
          assert.equal(sliced.content, [...allocation.long].slice(0, [...sliced.content].length).join(''),
            '首条长条件用余量分片，不用短例外的位置冒充');
          assert.equal(sliced.content_page.offset, 0, '首条长条件从原位0开始分片');
          assert.ok(sliced.content.length < [...allocation.long].length, '装不下的长条件只能分片，不能丢短例外换整条');
          assert.equal(typeof item.continuation.supports_next_cursor, 'string', '长条件未完必须可续');
          allocationSlices.push(sliced.content);
          delta = {role: 'assistant', tool_calls: [{index: 0, id: 'allocation-next', type: 'function',
            function: {name: 'read_knowledge', arguments: JSON.stringify({items: [{kind: 'knowledge', ref: reference, statement_id: sid,
              limit: 0, supports_cursor: item.continuation.supports_next_cursor}]})}}]};
        } else {
          assert.equal(supports.length, 1, '短例外已完整交付后，续页只续未完长条件');
          const support = supports[0];
          if (allocation.pendingLongs.length > 0 && allocationSlices.join('') === allocation.long) {
            // 首条长条件已拼完：本回执开始下一条长条件，仍一次只分片一条。
            allocation.long = allocation.pendingLongs.shift();
            allocationSlices = [];
            assert.ok(allocationSeen.length >= 2, '轮到下一条长条件前，短例外与首条长条件须已完整交付');
          }
          const offset = [...allocationSlices.join('')].length;
          assert.equal(support.content, [...allocation.long].slice(offset, offset + [...support.content].length).join(''),
            '长条件续页必须沿原Unicode偏移接原文');
          allocationSlices.push(support.content);
          assert.equal(item.support_state, 'partial', '长条件续页不能冒称本回执交齐');
          if (allocationSlices.join('') === allocation.long && allocation.pendingLongs.length === 0) {
            assert.ok(support.content_page.offset > 0, '末片从中间偏移续完');
            assert.equal(support.content_page.next_offset, null, '末片无剩余内容');
            assert.equal(support.content_page.complete, false, '从中间续完的末片不能自称complete');
            assert.equal(item.continuation.supports_next_cursor, null, '目录全部消费完才结束续读');
            delta = {role: 'assistant', content: '已按先短后长完整核对混合必要支持。'};
          } else {
            assert.equal(typeof item.continuation.supports_next_cursor, 'string');
            delta = {role: 'assistant', tool_calls: [{index: 0, id: 'allocation-page-' + allocationCalls, type: 'function',
              function: {name: 'read_knowledge', arguments: JSON.stringify({items: [{kind: 'knowledge', ref: reference, statement_id: sid,
                limit: 0, supports_cursor: item.continuation.supports_next_cursor}]})}}]};
          }
        }
      }
      }
    } else if (longSupport) {
      longCalls++;
      assert.ok(longCalls <= 24, '长支持续读沿原每消息24次预算推进');
      const message = input.messages.findLast(message => message.role === 'tool');
      if (message && message.tool_call_id !== 'long-support-route') {
        const result = JSON.parse(message.content);
        validateContract('KnowledgeReadReply', result);
        assert.equal(result.error, undefined);
        const item = result.items[0], support = item.supports[0];
        assert.equal(item.state, 'ok'); assert.equal(item.content, '', '只续支持，不重传陈述正文');
        assert.equal(item.supports_complete, true); assert.equal(item.supports.length, 1);
        assert.notEqual(support.content, prerequisite, '保存的长条件不能被引用条目的短正文替换');
        const stored = h.sql(`SELECT receipt FROM tool_calls WHERE conversation_id='${run.conversation_id}' AND sdk_tool_call_id='${message.tool_call_id}'`)[0];
        assert.deepEqual(result, stored.data, '支持分页到实际provider仍等Rust首次最终回执');
        assert.ok(support.content?.length > 0, '支持续页必须交原正文并推进');
        const offset = supportParts.reduce((total, part) => total + [...part].length, 0);
        assert.equal(support.content, [...longCondition].slice(offset, offset + [...support.content].length).join(''));
        assert.deepEqual(support.content_page, {offset, total_chars: [...longCondition].length,
          complete: offset === 0 && [...support.content].length === [...longCondition].length,
          next_offset: offset + [...support.content].length < [...longCondition].length ? offset + [...support.content].length : null});
        assert.equal(item.support_state, 'partial', '支持正文尾页仍不能冒称本回执交齐整条支持');
        if (bounded) {
          assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 5000, '原支持正文、位置和目录共同满足最终5000B');
          assert.ok(Math.ceil(JSON.stringify(result).length / 4) <= 1250);
        }
        supportParts.push(support.content);
        if (supportParts.join('') === longCondition) {
          assert.equal(item.continuation.supports_next_cursor, null);
          delta = {role: 'assistant', content: '已逐页核对原保存的合成长必要条件。'};
        } else {
          assert.equal(item.support_state, 'partial', '半条条件不能冒称完整交付');
          assert.equal(typeof item.continuation.supports_next_cursor, 'string');
          delta = {role: 'assistant', tool_calls: [{index: 0, id: 'long-support-page-' + supportParts.length, type: 'function',
            function: {name: 'read_knowledge', arguments: JSON.stringify({items: [{kind: 'knowledge', ref: reference, statement_id: sid,
              limit: 0, supports_cursor: item.continuation.supports_next_cursor}]})}}]};
        }
      } else if (message) {
        // §6.1：route单独成轮后，读取工具恢复可见再发首页。
        delta = {role: 'assistant', tool_calls: [
          {index: 0, id: 'long-support-first', type: 'function', function: {name: 'read_knowledge', arguments: JSON.stringify({items: [{kind: 'knowledge', ref: reference, statement_id: sid, limit: 0}]})}},
        ]};
      } else {
        delta = {role: 'assistant', tool_calls: [
          {index: 0, id: 'long-support-route', type: 'function', function: {name: 'update_analysis_task', arguments: JSON.stringify({action: 'route', task_id: null, expected_version: null, goal: '', question: null, options: []})}},
        ]};
      }
    } else if (calls === 1) {
      // §6.1：route回执裁决来源并刷新投影前，正文读取工具不可见，route单独成轮。
      delta = {role: 'assistant', tool_calls: [
        {index: 0, id: 'support-route', type: 'function', function: {name: 'update_analysis_task', arguments: JSON.stringify({action: 'route', task_id: null, expected_version: null, goal: '', question: null, options: []})}},
      ]};
    } else if (calls === 2) {
      delta = {role: 'assistant', tool_calls: [
        {index: 0, id: 'support-batch', type: 'function', function: {name: 'read_knowledge', arguments: JSON.stringify({items: [
          {kind: 'knowledge', ref: reference, statement_id: sid},
          {kind: 'knowledge', ref: reference, statement_id: sid, offset: 0, limit: 4},
        ]})}},
      ]};
    } else if (calls === 4) {
      delta = {role: 'assistant', tool_calls: [
        {index: 0, id: 'bounded-support-route', type: 'function', function: {name: 'update_analysis_task', arguments: JSON.stringify({action: 'route', task_id: null, expected_version: null, goal: '', question: null, options: []})}},
      ]};
    } else if (calls === 5) {
      delta = {role: 'assistant', tool_calls: [
        {index: 0, id: 'bounded-support', type: 'function', function: {name: 'read_knowledge', arguments: JSON.stringify({items: [{kind: 'knowledge', ref: reference, statement_id: sid, limit: 65536}]})}},
      ]};
    } else if (calls === 6) {
      const message = input.messages.find(message => message.role === 'tool' && message.tool_call_id === 'bounded-support');
      assert.ok(message);
      const result = JSON.parse(message.content);
      validateContract('KnowledgeReadReply', result);
      assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 2600, '最终支持和正文共同受宿主回执字节预算限制');
      assert.ok(Math.ceil(JSON.stringify(result).length / 4) <= 650);
      const item = result.items[0];
      assert.equal(item.state, 'ok');
      assert.equal(item.content_state, 'partial');
      assert.ok(item.content.length > 0);
      assert.equal(item.content, [...longText].slice(0, [...item.content].length).join(''));
      assert.equal(item.continuation.content_next_offset, [...item.content].length);
      assert.equal(item.supports_complete, true);
      assert.equal(item.support_state, 'delivered', '短条件和例外完整优先保留，不以半句冒称完整');
      assert.equal(item.supports[0].content, prerequisite);
      assert.equal(item.supports[1].content, scope, '承载正文被裁掉时必须恢复完整例外content');
      assert.equal(Object.hasOwn(item.supports[1], 'delivered_in'), false, '不得留下指向已裁正文的承载映射');
      const stored = h.sql(`SELECT receipt FROM tool_calls WHERE conversation_id='${run.conversation_id}' AND sdk_tool_call_id='bounded-support'`)[0];
      assert.deepEqual(result, stored.data);
      checks.push('最终容量保留完整条件和例外，移除悬空delivered_in并推进正文');
      delta = {role: 'assistant', content: '已取得合成规则的有界正文和完整必要条件。'};
    } else {
      assert.equal(calls, 3);
      const message = input.messages.find(message => message.role === 'tool' && message.tool_call_id === 'support-batch');
      assert.ok(message);
      const result = JSON.parse(message.content);
      assert.equal(result.error, undefined, message.content);
      validateContract('KnowledgeReadReply', result);
      assert.equal(result.items.length, 2);
      const [whole, short] = result.items;
      for (const item of [whole, short]) {
        assert.equal(item.state, 'ok');
        assert.equal(item.supports_complete, true);
        assert.equal(item.support_state, 'delivered', '保存声明完整且本页实际可见必要支持才算delivered');
        assert.equal(item.supports.length, 2);
        assert.equal(item.supports[0].content, prerequisite, '支持ID和引用不代替实际正文');
        assert.deepEqual(item.supports[0].reference.citation, {source: {kind: 'document', id: source.id}, revision: source.version, locator: {offset: 0, length: [...prerequisite].length}});
      }
      assert.equal(whole.content, text + '\n' + scope);
      assert.equal(whole.supports[1].content, null);
      assert.deepEqual(whole.supports[1].delivered_in, {path: '/items/0/content', locator: {offset: [...text].length + 1, length: [...scope].length}}, '承载映射只指本回执完整可见的区间');
      assert.equal(short.content, '合成设备');
      assert.equal(short.content_state, 'partial');
      assert.equal(short.supports[1].content, scope, '正文未包含完整例外时补真实支持正文');
      assert.equal(Object.hasOwn(short.supports[1], 'delivered_in'), false);
      const stored = h.sql(`SELECT receipt FROM tool_calls WHERE conversation_id='${run.conversation_id}' AND recovery_chain_id='${run.recovery_chain_id}' AND sdk_tool_call_id='support-batch'`)[0];
      assert.deepEqual(result, stored.data);
      const authority = h.sql(`SELECT authority_snapshot FROM agent_runs WHERE id='${run.run_id}'`)[0];
      assert.ok(authority.sources.some(([id, revision]) => id === 'document-' + source.id && revision === source.version), '交付支持正文的来源进入当前authority');
      checks.push('保存的必要条件实际交付', '完整承载段与短正文分别使用delivered_in和content', '最终回执及provider一致');
      delta = {role: 'assistant', content: '已核对合成计数规则、必要条件和停用例外。'};
    }
    response.writeHead(200, {'content-type': 'text/event-stream'});
    response.write('data: ' + JSON.stringify({id: 'evidence-supports', choices: [{index: 0, delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop'}]}) + '\n\n');
    response.write('data: ' + JSON.stringify({choices: [], usage: {prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100}}) + '\n\n');
    response.end('data: [DONE]\n\n');
  } catch (error) {
    errors.push(error.message);
    response.writeHead(400, {'content-type': 'application/json'}).end(JSON.stringify({error: {message: 'synthetic_support_assertion_failed', type: 'invalid_request_error'}}));
  }
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const previousTest = process.env.DATA_AGENT_PROVIDER_TEST;
process.env.DATA_AGENT_PROVIDER_TEST = '1';
const ok = response => {assert.equal(response.status, 200, JSON.stringify(response.value)); return response.value;};
try {
  // 试用钱包按整文件累计；每消息24次上限不变（各场景内的调用数断言仍生效）。
  const profile = {provider_id: 'deepseek', model_id: 'deepseek-flash', trial_id: randomUUID(), price_version: '2026-10-04-peak-usd', input_limit: 65536, output_limit: 8192, trial_call_limit: 48, trial_cost_micros: '600000', request_call_limit: 24, toolset: 'data', payload_bytes_limit: 131072, thinking_level: 'off'};
  h = await harness({capture: true, startWorker: false, profile, protocolProviderUrl: 'http://127.0.0.1:' + provider.address().port,
    env: {DATA_AGENT_LEASE_MS: '120000', DATA_AGENT_TOOL_CONTRACT_VERSION: '2', DATA_AGENT_PREFILL_PROFILE: '',
      DATA_AGENT_VECTOR_URL: 'http://127.0.0.1:19531', DATA_AGENT_VECTOR_COLLECTION: collection,
      DATA_AGENT_VECTOR_TOKEN_FILE: process.cwd() + '/.local/infra/milvus-root-password'}});
  ok(await h.request('/knowledge-index/rebuilds', {operation_id: randomUUID()})); prepared = true;
  source = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'document', name: '合成支持来源', body: prerequisite + '\n' + scope, related_ids: []}));
  object = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'term', name: '合成依据交付', body: '初始化', related_ids: []}));
  const citation = (offset, length) => ({source: {kind: 'document', id: source.id}, revision: source.version, locator: {offset, length}});
  object = ok(await h.request('/knowledge/' + object.id, {operation_id: randomUUID(), expected_version: object.version, entry_id: 'body', value: text + '\n' + scope,
    statements: [{key: 'counting-rule', target: {object_id: object.id, version: object.version, path: 'body'}, text, scope_text: scope, citations: [], supports_complete: true,
      supports: [
        {key: 'identity-condition', role: 'prerequisite', reference: {kind: 'source', citation: citation(0, [...prerequisite].length)}, content: prerequisite, embedded_in: null},
        {key: 'disabled-exception', role: 'exception', reference: {kind: 'source', citation: citation([...prerequisite].length + 1, [...scope].length)}, content: scope, embedded_in: {field: 'scope_text', locator: {offset: 0, length: [...scope].length}}},
      ]}]}, 'alice', 'PATCH'));
  await h.resumeWorker(); run = await h.capture(await h.create(), '核对合成规则的必要条件和例外，分别读取整条与短页。');
  await h.pauseWorker(); assert.equal(run.tool_contract_version, 2);
  try {await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, '');}
  catch (error) {assert.deepEqual(errors, [], JSON.stringify(errors)); throw error;}
  h.releaseRun(run.run_id);
  assert.deepEqual(errors, []); assert.equal(calls, 3);
  object = ok(await h.request('/knowledge/' + object.id, {operation_id: randomUUID(), expected_version: object.version, entry_id: 'body', value: longText + '\n' + scope,
    statements: [{key: 'long-counting-rule', target: {object_id: object.id, version: object.version, path: 'body'}, text: longText, scope_text: scope, citations: [], supports_complete: true,
      supports: [
        {key: 'identity-condition', role: 'prerequisite', reference: {kind: 'source', citation: citation(0, [...prerequisite].length)}, content: prerequisite, embedded_in: null},
        {key: 'disabled-exception', role: 'exception', reference: {kind: 'source', citation: citation([...prerequisite].length + 1, [...scope].length)}, content: scope, embedded_in: {field: 'scope_text', locator: {offset: 0, length: [...scope].length}}},
      ]}]}, 'alice', 'PATCH'));
  await h.resumeWorker(); run = await h.capture(await h.create(), '按小回执预算核对合成规则，保留完整条件和例外。');
  await h.pauseWorker();
  bounded = true;
  try {await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, '');}
  catch (error) {assert.deepEqual(errors, [], JSON.stringify(errors)); throw error;}
  h.releaseRun(run.run_id);
  assert.deepEqual(errors, []); assert.equal(calls, 6);
  const shortReference = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'term', name: '合成支持引用摘要', body: prerequisite, related_ids: []}));
  object = ok(await h.request('/knowledge/' + object.id, {operation_id: randomUUID(), expected_version: object.version, entry_id: 'body', value: text + '\n' + longCondition,
    statements: [{key: 'saved-long-condition', target: {object_id: object.id, version: object.version, path: 'body'}, text, scope_text: longCondition, citations: [], supports_complete: true,
      supports: [{key: 'long-required-condition', role: 'prerequisite',
        reference: {kind: 'knowledge', ref: {object_id: shortReference.id, version: shortReference.version, path: 'body'}},
        content: longCondition, embedded_in: {field: 'scope_text', locator: {offset: 0, length: [...longCondition].length}}}]}]}, 'alice', 'PATCH'));
  await h.resumeWorker(); run = await h.capture(await h.create(), '只补读已保存的长必要条件，不能拿引用摘要替代。');
  await h.pauseWorker(); bounded = false; longSupport = true;
  try {await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, '');}
  catch (error) {assert.deepEqual(errors, [], JSON.stringify(errors)); throw error;}
  assert.equal(supportParts.join(''), longCondition); assert.ok(supportParts.length > 1);
  checks.push('省略的大支持沿原游标逐页交原文，不以短引用替换或半句冒称完整');
  h.releaseRun(run.run_id);
  supportParts.length = 0; longCalls = 0;
  object = ok(await h.request('/knowledge/' + object.id, {operation_id: randomUUID(), expected_version: object.version, entry_id: 'body', value: text,
    statements: [{key: 'saved-external-condition', target: {object_id: object.id, version: object.version, path: 'body'}, text, scope_text: '', citations: [], supports_complete: true,
      supports: [{key: 'source-referenced-condition', role: 'prerequisite', reference: {kind: 'source', citation: citation(0, [...prerequisite].length)},
        content: longCondition, embedded_in: null}]}]}, 'alice', 'PATCH'));
  await h.resumeWorker(); run = await h.capture(await h.create(), '按小回执逐页读取外置合成长条件，不能用短来源片段替换。');
  await h.pauseWorker(); bounded = true;
  try {await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, '');}
  catch (error) {assert.deepEqual(errors, [], JSON.stringify(errors)); throw error;}
  assert.equal(supportParts.join(''), longCondition); assert.ok(supportParts.length > 1);
  checks.push('非内嵌source支持保持已保存正文，5000B内逐页拼回且状态和位置同步');
  h.releaseRun(run.run_id);
  supportParts.length = 0; longCalls = 0;

  // R11正式反例一：同命中长条件在首、两条短例外在后，预算装得下短例外装不下长条。
  const allocationCitation = (offset, length) => ({source: {kind: 'document', id: source.id}, revision: source.version, locator: {offset, length}});
  object = ok(await h.request('/knowledge/' + object.id, {operation_id: randomUUID(), expected_version: object.version, entry_id: 'body', value: text,
    statements: [{key: 'mixed-allocation-rule', target: {object_id: object.id, version: object.version, path: 'body'}, text, scope_text: '', citations: [], supports_complete: true,
      supports: [
        {key: 'long-first-condition', role: 'prerequisite', reference: {kind: 'source', citation: allocationCitation(0, [...prerequisite].length)}, content: mixedLong, embedded_in: null},
        {key: 'short-exception-a', role: 'exception', reference: {kind: 'source', citation: allocationCitation(0, [...prerequisite].length)}, content: shortExceptionA, embedded_in: null},
        {key: 'short-exception-b', role: 'exception', reference: {kind: 'source', citation: allocationCitation(0, [...prerequisite].length)}, content: shortExceptionB, embedded_in: null},
      ]}]}, 'alice', 'PATCH'));
  allocation = {shorts: [shortExceptionA, shortExceptionB], long: mixedLong, pendingLongs: []};
  allocationCalls = 0; allocationSeen = []; allocationSlices = [];
  await h.resumeWorker(); run = await h.capture(await h.create(), '按小回执先核对两条短例外，再逐页核对首条长条件。');
  await h.pauseWorker(); bounded = true;
  try {await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, '');}
  catch (error) {assert.deepEqual(errors, [], JSON.stringify(errors)); throw error;}
  assert.equal(allocationSlices.join(''), mixedLong);
  assert.equal(allocationSeen.length, 3, '长条件与两条短例外最终都完整交付');
  checks.push('长条件在前不挡短例外：先完整交短例外再分片长条，末片推进不冒称delivered');
  h.releaseRun(run.run_id);

  // R11正式反例二：两条长条件加一条短例外，一次只分片一条长条件且首条不被越过。
  const mixedLongB = '第二条长条件🧪：登记后必须复核。'.repeat(600);
  object = ok(await h.request('/knowledge/' + object.id, {operation_id: randomUUID(), expected_version: object.version, entry_id: 'body', value: text,
    statements: [{key: 'two-long-allocation-rule', target: {object_id: object.id, version: object.version, path: 'body'}, text, scope_text: '', citations: [], supports_complete: true,
      supports: [
        {key: 'long-a-condition', role: 'prerequisite', reference: {kind: 'source', citation: allocationCitation(0, [...prerequisite].length)}, content: mixedLong, embedded_in: null},
        {key: 'long-b-condition', role: 'prerequisite', reference: {kind: 'source', citation: allocationCitation(0, [...prerequisite].length)}, content: mixedLongB, embedded_in: null},
        {key: 'short-exception-only', role: 'exception', reference: {kind: 'source', citation: allocationCitation(0, [...prerequisite].length)}, content: shortExceptionA, embedded_in: null},
      ]}]}, 'alice', 'PATCH'));
  allocation = {shorts: [shortExceptionA], long: mixedLong, pendingLongs: [mixedLongB]};
  allocationCalls = 0; allocationSeen = []; allocationSlices = [];
  await h.resumeWorker(); run = await h.capture(await h.create(), '按小回执核对一短两长条件，长条件逐条分片读完。');
  await h.pauseWorker();
  try {await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, '');}
  catch (error) {assert.deepEqual(errors, [], JSON.stringify(errors)); throw error;}
  assert.equal(allocationSeen.length, 3, '两条长条件与一条短例外最终都完整交付');
  checks.push('两条长条件不互相越过：先短后逐条分片，首条读完才轮到下一条');
  h.releaseRun(run.run_id);
  passed = true;
  console.log(JSON.stringify({passed, checks, calls, officialRequests: 0}));
} finally {
  globalThis.fetch = originalFetch;
  if (previousTest === undefined) delete process.env.DATA_AGENT_PROVIDER_TEST; else process.env.DATA_AGENT_PROVIDER_TEST = previousTest;
  if (h) {await writeFile(h.directory + '/evidence-supports.json', JSON.stringify({passed, errors, checks, calls, officialRequests: 0}, null, 2)); await h.close();}
  if (prepared) {
    const dropped = await fetch('http://127.0.0.1:19531/v2/vectordb/collections/drop', {method: 'POST', headers: {'content-type': 'application/json', authorization: 'Bearer root:' + vectorToken}, body: JSON.stringify({dbName: 'default', collectionName: collection})});
    assert.equal((await dropped.json()).code, 0);
  }
  provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
}

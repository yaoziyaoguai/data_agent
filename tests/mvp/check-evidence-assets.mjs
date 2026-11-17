import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {deliver} from '../../apps/agent/session/deliver.ts';
import {validateContract} from '../../packages/contracts/validate.ts';
import {harness} from './harness.mjs';
import {assetInput, select} from './skill-fixtures.mjs';

const collection = 'data_agent_test_' + randomUUID().replaceAll('-', '');
const vectorToken = (await readFile('.local/infra/milvus-root-password', 'utf8')).trim();
const errors = [];
const checks = ['记忆与知识混批保序', 'body/scope/source_text独立分页', '他人/停用/旧版本逐项状态与隔离', '最终回执与provider一致', '混批最终容量内三部分Unicode分页连续无丢失且Skill选择权保持'];
let h, memory, longMemory, other, disabled, knowledge, skill, unselectedSkill, otherSkill, disabledSkill, run, calls = 0, prepared = false, passed = false;
let bounded = false, boundedCalls = 0;
const longParts = {body: '合成正文🧪。'.repeat(300), scope: '合成范围🌏。'.repeat(300), source_text: '合成原话🧩。'.repeat(300)};
const offsets = {body: 0, scope: 0, source_text: 0}, collected = {body: '', scope: '', source_text: ''};
let requestedParts = [];
const originalFetch = globalThis.fetch;
const capacitySamples = [];
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if ((url.endsWith('/internal/data/tool-calls') || url.endsWith('/internal/data/tools')) && typeof init?.body === 'string') {
    const value = JSON.parse(init.body);
    if (value.tool_name === 'read_knowledge') {
      capacitySamples.push({bounded, response_budget: value.response_budget});
      if (bounded && url.endsWith('/internal/data/tools')) {
        assert.ok(value.response_budget, '实际Pi读取执行前必须分配宿主容量');
        value.response_budget = {...value.response_budget, max_bytes: Math.min(8500, value.response_budget.max_bytes), estimated_tokens: Math.min(2125, value.response_budget.estimated_tokens)};
        init = {...init, body: JSON.stringify(value)};
      }
    }
  }
  return originalFetch(input, init);
};
const provider = createServer(async (request, response) => {
  try {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    calls++;
    capacitySamples.push({providerCall: calls, bytes: Buffer.byteLength(raw), hasTools: Array.isArray(input.tools), toolIds: input.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id)});
    const assetRef = {id: memory.id, version: memory.version};
    let delta;
    if (bounded) {
      boundedCalls++;
      assert.ok(boundedCalls <= 20, '记忆三部分续页必须在原24次模型预算内推进');
      const next = () => {
        requestedParts = Object.keys(longParts).filter(part => collected[part] !== longParts[part]);
        return {index: 0, id: 'bounded-assets-' + (boundedCalls - 1), type: 'function', function: {name: 'read_knowledge', arguments: JSON.stringify({items: [
          ...requestedParts.map(part => ({kind: 'memory', asset_ref: {id: longMemory.id, version: longMemory.version}, part, offset: offsets[part], limit: 4096})),
          {kind: 'knowledge', ref: {object_id: knowledge.id, version: knowledge.version, path: 'body'}},
          {kind: 'skill', asset_ref: {id: skill.id, version: skill.version}},
          {kind: 'skill', asset_ref: {id: unselectedSkill.id, version: unselectedSkill.version}},
          {kind: 'memory', asset_ref: {id: other.id, version: other.version}, part: 'body'},
        ]})}};
      };
      if (boundedCalls === 1) {
        delta = {role: 'assistant', tool_calls: [
          {index: 0, id: 'bounded-assets-route', type: 'function', function: {name: 'update_analysis_task', arguments: JSON.stringify({action: 'route', task_id: null, expected_version: null, goal: '', question: null, options: []})}},
        ]};
      } else if (boundedCalls === 2) {
        delta = {role: 'assistant', tool_calls: [next()]};
      } else {
        const sdkId = 'bounded-assets-' + (boundedCalls - 2);
        const message = input.messages.find(message => message.role === 'tool' && message.tool_call_id === sdkId);
        assert.ok(message);
        const result = JSON.parse(message.content);
        assert.equal(result.error, undefined, '记忆可分页时不能以整批容量错误替代');
        validateContract('KnowledgeReadReply', result);
        assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8500, '整份混批回执须满足宿主字节额度');
        assert.ok(Math.ceil(JSON.stringify(result).length / 4) <= 2125);
        assert.deepEqual(result, h.sql(`SELECT receipt FROM tool_calls WHERE conversation_id='${run.conversation_id}' AND sdk_tool_call_id='${sdkId}'`)[0].data);
        let advanced = 0;
        for (const [index, part] of requestedParts.entries()) {
          const item = result.items[index];
          assert.equal(item.kind, 'memory'); assert.equal(item.state, 'ok'); assert.equal(item.part, part);
          const pageKey = {body: 'content_page', scope: 'scope_page', source_text: 'source_page'}[part];
          const page = item.asset[pageKey], text = item.asset[part];
          assert.equal(page.offset, offsets[part]);
          assert.equal(page.total_chars, [...longParts[part]].length);
          assert.equal(text, [...longParts[part]].slice(offsets[part], offsets[part] + [...text].length).join(''), 'Unicode页只交付原前缀，不重复或跳过');
          offsets[part] += [...text].length; collected[part] += text; advanced += [...text].length;
          assert.equal(page.next_offset, offsets[part] < page.total_chars ? offsets[part] : null);
          assert.equal(page.complete, page.offset === 0 && offsets[part] === page.total_chars);
          for (const otherPart of Object.keys(longParts).filter(value => value !== part)) {
            const otherPage = item.asset[{body: 'content_page', scope: 'scope_page', source_text: 'source_page'}[otherPart]];
            assert.equal(otherPage.offset, 0, '三部分offset不能互相推进');
          }
        }
        assert.ok(advanced > 0, '每次续页须实际交付记忆内容');
        const tail = result.items.slice(requestedParts.length);
        assert.deepEqual(tail.map(item => [item.kind, item.state]), [['knowledge', 'ok'], ['skill', 'ok'], ['skill', 'not_available'], ['memory', 'not_available']]);
        assert.equal(tail[0].content, '合成知识仍能读取。');
        assert.equal(tail[1].asset.native_path, `/skills/${skill.id}/${skill.version}/SKILL.md`);
        assert.equal(tail[1].asset.selected, true);
        assert.ok(!message.content.includes('其他用户私密合成原话'));
        if (Object.keys(longParts).every(part => collected[part] === longParts[part])) delta = {role: 'assistant', content: '合成记忆的正文、范围与原话已按独立位置完整补读。'};
        else delta = {role: 'assistant', tool_calls: [next()]};
      }
    } else if (calls === 1) {
      // §6.1：route回执裁决来源并刷新投影前，正文与执行工具不可见，route单独成轮。
      assert.ok(!input.tools.some(tool => tool.function?.name === 'read_knowledge'), '未route前read_knowledge不可见');
      assert.ok(!input.tools.some(tool => tool.function?.name === 'read'), '未route前原生read不可见');
      assert.ok(input.tools.some(tool => tool.function?.name === 'update_analysis_task'), '控制工具route始终可见');
      delta = {role: 'assistant', tool_calls: [
        {index: 0, id: 'assets-route', type: 'function', function: {name: 'update_analysis_task', arguments: JSON.stringify({action: 'route', task_id: null, expected_version: null, goal: '', question: null, options: []})}},
      ]};
    } else if (calls === 2) {
      const tool = input.tools.find(tool => tool.function?.name === 'read_knowledge');
      validateContract('KnowledgeReadInput', {items: [{kind: 'memory', asset_ref: assetRef, part: 'body'}]});
      assert.ok(tool, 'route裁决并刷新后read_knowledge恢复可见');
      assert.ok(JSON.stringify(tool.function.parameters).includes('asset_ref'));
      delta = {role: 'assistant', tool_calls: [
        {index: 0, id: 'assets-batch', type: 'function', function: {name: 'read_knowledge', arguments: JSON.stringify({items: [
          {kind: 'memory', asset_ref: {id: other.id, version: other.version}, part: 'source_text'},
          {kind: 'memory', asset_ref: assetRef, part: 'body', offset: 4, limit: 4},
          {kind: 'memory', asset_ref: {...assetRef, version: '0'}, part: 'body'},
          {kind: 'memory', asset_ref: assetRef, part: 'scope', offset: 5, limit: 3},
          {kind: 'knowledge', ref: {object_id: knowledge.id, version: knowledge.version, path: 'body'}},
          {kind: 'memory', asset_ref: {id: disabled.id, version: disabled.version}, part: 'body'},
          {kind: 'memory', asset_ref: assetRef, part: 'source_text', offset: 10, limit: 100},
          {kind: 'skill', asset_ref: {id: unselectedSkill.id, version: unselectedSkill.version}},
          {kind: 'skill', asset_ref: {id: skill.id, version: skill.version}},
          {kind: 'skill', asset_ref: {id: skill.id, version: '0'}},
          {kind: 'skill', asset_ref: {id: otherSkill.id, version: otherSkill.version}},
          {kind: 'skill', asset_ref: {id: disabledSkill.id, version: disabledSkill.version}},
        ]})}},
        {index: 1, id: 'assets-native-read', type: 'function', function: {name: 'read', arguments: JSON.stringify({path: `/skills/${skill.id}/${skill.version}/references/guide.md`, offset: 2, limit: 1})}},
      ]};
    } else {
      assert.equal(calls, 3);
      const message = input.messages.find(message => message.role === 'tool' && message.tool_call_id === 'assets-batch');
      assert.ok(message);
      assert.match(message.content, /^\s*\{/, '记忆批量读取必须取得结构化回执：' + message.content);
      const result = JSON.parse(message.content);
      assert.equal(result.error, undefined, '记忆批量读取被拒绝：' + message.content);
      validateContract('KnowledgeReadReply', result);
      assert.deepEqual(result.items.map(item => [item.kind, item.state]), [
        ['memory', 'not_available'], ['memory', 'ok'], ['memory', 'stale'], ['memory', 'ok'],
        ['knowledge', 'ok'], ['memory', 'not_available'], ['memory', 'ok'],
        ['skill', 'not_available'], ['skill', 'ok'], ['skill', 'stale'], ['skill', 'not_available'], ['skill', 'not_available'],
      ]);
      assert.equal(result.items[1].asset.body, '甲🌏é');
      assert.deepEqual(result.items[1].asset.content_page, {offset: 4, total_chars: 12, complete: false, next_offset: 8});
      assert.equal(result.items[1].asset.source_text, '', '缺省正文页不附来源原话');
      assert.equal(result.items[1].asset.source_page.next_offset, 0);
      assert.equal(result.items[3].asset.scope, '合成🌏');
      assert.deepEqual(result.items[3].asset.scope_page, {offset: 5, total_chars: 11, complete: false, next_offset: 8});
      assert.equal(result.items[3].asset.body, '');
      assert.equal(result.items[3].asset.source_text, '');
      assert.equal(result.items[4].content, '合成知识仍能读取。');
      assert.equal(result.items[6].asset.source_text, '例外必须核对。');
      assert.deepEqual(result.items[6].asset.source_page, {offset: 10, total_chars: 17, complete: false, next_offset: null});
      assert.equal(result.items[6].asset.body, '');
      for (const index of [0, 2, 5, 7, 9, 10, 11]) assert.equal(Object.hasOwn(result.items[index], 'asset'), false);
      assert.equal(result.items[8].asset.kind, 'skill');
      assert.equal(result.items[8].asset.body, '');
      assert.equal(result.items[8].asset.source_text, '');
      assert.equal(result.items[8].asset.selected, true);
      assert.equal(result.items[8].asset.native_path, `/skills/${skill.id}/${skill.version}/SKILL.md`);
      const native = input.messages.find(message => message.role === 'tool' && message.tool_call_id === 'assets-native-read');
      assert.ok(native?.content.includes('合成附件第二行'), 'Skill附件仍通过原生read按行读取');
      assert.ok(!native.content.includes('合成附件第一行'));
      const stored = h.sql(`SELECT receipt FROM tool_calls WHERE conversation_id='${run.conversation_id}' AND recovery_chain_id='${run.recovery_chain_id}' AND sdk_tool_call_id='assets-batch'`)[0];
      assert.deepEqual(result, stored.data, '记忆三分支最终回执到provider无损');
      assert.ok(!message.content.includes('其他用户私密合成原话'));
      assert.ok(!message.content.includes('停用的合成正文'));
      const authority = h.sql(`SELECT authority_snapshot FROM agent_runs WHERE id='${run.run_id}'`)[0];
      assert.ok(authority.memories.some(([id, version]) => id === memory.id && version === memory.version));
      assert.ok(!authority.memories.some(([id, version]) => id === other.id || id === disabled.id || version === '0'));
      assert.ok(authority.skills.some(([id, version]) => id === skill.id && version === skill.version));
      assert.ok(!authority.skills.some(([id, version]) => [unselectedSkill.id, otherSkill.id, disabledSkill.id].includes(id) || version === '0'));
      assert.ok(authority.evidence_reads.some(read => read.object_kind === 'asset' && read.id === memory.id));
      delta = {role: 'assistant', content: '已核对本人记忆的正文、范围与原话，以及合成知识条目。'};
    }
    response.writeHead(200, {'content-type': 'text/event-stream'});
    response.write('data: ' + JSON.stringify({id: 'evidence-assets', choices: [{index: 0, delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop'}]}) + '\n\n');
    response.write('data: ' + JSON.stringify({choices: [], usage: {prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100}}) + '\n\n');
    response.end('data: [DONE]\n\n');
  } catch (error) {
    errors.push(error.message);
    response.writeHead(400, {'content-type': 'application/json'}).end(JSON.stringify({error: {message: 'synthetic_asset_assertion_failed', type: 'invalid_request_error'}}));
  }
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const previousTest = process.env.DATA_AGENT_PROVIDER_TEST;
process.env.DATA_AGENT_PROVIDER_TEST = '1';
try {
  const profile = {provider_id: 'deepseek', model_id: 'deepseek-flash', trial_id: randomUUID(), price_version: '2026-10-04-peak-usd', input_limit: 65536, output_limit: 8192, trial_call_limit: 24, trial_cost_micros: '300000', request_call_limit: 24, toolset: 'data', payload_bytes_limit: 131072, thinking_level: 'off'};
  h = await harness({capture: true, startWorker: false, profile, protocolProviderUrl: 'http://127.0.0.1:' + provider.address().port,
    env: {DATA_AGENT_LEASE_MS: '120000', DATA_AGENT_TOOL_CONTRACT_VERSION: '2', DATA_AGENT_PREFILL_PROFILE: '',
      DATA_AGENT_VECTOR_URL: 'http://127.0.0.1:19531', DATA_AGENT_VECTOR_COLLECTION: collection,
      DATA_AGENT_VECTOR_TOKEN_FILE: process.cwd() + '/.local/infra/milvus-root-password'}});
  const rebuild = await h.request('/knowledge-index/rebuilds', {operation_id: randomUUID()});
  assert.equal(rebuild.status, 200, JSON.stringify(rebuild.value)); prepared = true;
  const save = async (input, user = 'alice') => {const result = await h.request('/assets', input, user); assert.equal(result.status, 200, JSON.stringify(result.value)); return result.value;};
  const ok = response => {assert.equal(response.status, 200, JSON.stringify(response.value)); return response.value;};
  memory = await save(assetInput({kind: 'memory', name: '合成补读记忆', body: '合成正文甲🌏é乙结束。', scope: '适用范围：合成🌏分析。', source_text: '本人原话：只限合成；例外必须核对。'}));
  other = await save(assetInput({kind: 'memory', body: '其他用户合成记忆', source_text: '其他用户私密合成原话'}), 'bob');
  disabled = await save(assetInput({kind: 'memory', body: '停用的合成正文'}));
  const stopped = await h.request('/assets/' + disabled.id + '/disable', {operation_id: randomUUID(), expected_version: disabled.version});
  assert.equal(stopped.status, 200, JSON.stringify(stopped.value)); disabled = stopped.value;
  const term = await h.request('/knowledge', {operation_id: randomUUID(), kind: 'term', name: '合成资产混批规则', body: '合成知识仍能读取。', related_ids: []});
  assert.equal(term.status, 200); knowledge = term.value;
  skill = await save(assetInput({name: '已选合成方法', body: '只按已核验合成资料分析。', files: [{path: 'references/guide.md', content: '合成附件第一行\n合成附件第二行\n合成附件第三行'}]}));
  unselectedSkill = await save(assetInput({name: '未选合成方法', body: '未选正文不应交付。'}));
  otherSkill = await save(assetInput({name: '其他用户方法', body: '其他用户方法正文不应交付。'}), 'bob');
  disabledSkill = await save(assetInput({name: '停用合成方法', body: '停用方法正文不应交付。'}));
  const stoppedSkill = await h.request('/assets/' + disabledSkill.id + '/disable', {operation_id: randomUUID(), expected_version: disabledSkill.version});
  assert.equal(stoppedSkill.status, 200); disabledSkill = stoppedSkill.value;
  const cid = await h.create();
  assert.equal((await select(h, cid, skill)).status, 200);
  await h.resumeWorker(); run = await h.capture(cid, '核对本人的合成记忆三部分及知识项，保持各自来源。');
  await h.pauseWorker(); assert.equal(run.tool_contract_version, 2);
  try { await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, ''); }
  catch (error) { assert.deepEqual(errors, [], JSON.stringify(errors)); throw error; }
  h.releaseRun(run.run_id);
  assert.deepEqual(errors, []); assert.equal(calls, 3);
  longMemory = await save(assetInput({kind: 'memory', name: '合成大记忆独立分页', ...longParts}));
  const boundedCid = await h.create();
  assert.equal((await select(h, boundedCid, skill)).status, 200);
  await h.resumeWorker(); run = await h.capture(boundedCid, '按小容量分别补读合成记忆的正文、范围与原话，保留知识与已选方法。');
  await h.pauseWorker(); bounded = true;
  try { await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, ''); }
  catch (error) { assert.deepEqual(errors, [], JSON.stringify(errors)); throw error; }
  h.releaseRun(run.run_id);
  assert.deepEqual(errors, []); assert.deepEqual(collected, longParts);

  // R08受限来源轮：只依赖允许文档D的已选Skill与同源记忆保持可用，混合依赖、
  // 人工无源与范围外资产如实排除；不再整类禁用，也不拖累合法检索整次409。
  bounded = false;
  const gateDoc = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'document',
    name: '合成受限允许文档', body: '受限轮允许的文档正文。', related_ids: []}));
  const outDoc = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'document',
    name: '合成受限范围外文档', body: '受限轮范围外的文档正文。', related_ids: []}));
  const dep = doc => [{object_id: doc.id, version: doc.version, path: 'body'}];
  const sameSourceSkill = await save(assetInput({name: '同源受限方法', body: '只按允许文档分析。',
    files: [{path: 'references/notes.md', content: '同源附件第一行\n同源附件第二行'}], dependencies: dep(gateDoc)}));
  const unselectedSameSkill = await save(assetInput({name: '未选同源方法', body: '未选同源正文。',
    dependencies: dep(gateDoc)}));
  const mixedSkill = await save(assetInput({name: '混合依赖受限方法', body: '混合依赖正文。',
    dependencies: [...dep(gateDoc), ...dep(outDoc)]}));
  const manualSkill = await save(assetInput({name: '人工无源受限方法', body: '人工无源正文。'}));
  const sameMemory = await save(assetInput({kind: 'memory', name: '同源受限记忆',
    body: '同源受限记忆正文。', dependencies: dep(gateDoc)}));
  const outMemory = await save(assetInput({kind: 'memory', name: '范围外受限记忆',
    body: '范围外受限记忆正文。', dependencies: dep(outDoc)}));
  const restrictedCid = await h.create();
  for (const asset of [sameSourceSkill, mixedSkill, manualSkill]) {
    assert.equal((await select(h, restrictedCid, asset)).status, 200);
  }
  let restrictedManager = SessionManager.inMemory('/synthetic/restricted-assets');
  const binding = () => ({run_id: run.run_id, lease_epoch: run.lease_epoch});
  const checkpointOf = manager => exportCheckpoint(manager,
    run.workspace_context.authority_revision, run.workspace_context.authority_snapshot);
  const invoke = async (name, args) => {
    const input = {...binding(), sdk_tool_call_id: randomUUID(), tool_name: name, arguments: args,
      checkpoint: checkpointOf(restrictedManager)};
    const register = await h.internal('/internal/data/tool-calls', input);
    assert.equal(register.status, 200, JSON.stringify(register.value));
    return {response: await h.internal('/internal/data/tools', input), input};
  };
  const finish = async text => {
    assert.equal((await h.internal('/internal/outputs', {...binding(), chunk_seq: '1', text})).status, 200);
    assert.equal((await h.internal('/internal/finish', {...binding(), commit_id: run.output_id,
      final_text: text, checkpoint: checkpointOf(restrictedManager)})).status, 200);
  };
  await h.resumeWorker();
  run = await h.capture(restrictedCid, '先建立只用允许文档的受限任务。'); await h.pauseWorker();
  // 读取工具受正文准入门约束：先按本消息route，再做无限制与受限对照。
  assert.equal((await invoke('update_analysis_task', {action: 'route', task_id: null,
    expected_version: null, goal: '', options: []})).response.status, 200);
  const unrestrictedBatch = await invoke('read_knowledge', {items: [
    {kind: 'skill', asset_ref: {id: sameSourceSkill.id, version: sameSourceSkill.version}},
  ]});
  assert.equal(unrestrictedBatch.response.status, 200, JSON.stringify(unrestrictedBatch.response.value));
  assert.equal(unrestrictedBatch.response.value.data.items[0].state, 'ok', '无限制时同源方法descriptor可用');
  const unrestrictedNative = await invoke('read', {path: `/skills/${sameSourceSkill.id}/${sameSourceSkill.version}/references/notes.md`, offset: 1, limit: 1});
  assert.equal(unrestrictedNative.response.status, 200, JSON.stringify(unrestrictedNative.response.value));
  assert.ok(unrestrictedNative.response.value.data.text.includes('同源附件第一行'), '无限制时分页读取可用');
  const created = await invoke('update_analysis_task', {action: 'create',
    goal: '只用允许文档核对方法与记忆', options: [], conditions: {
      time_start: null, time_end: null, timezone: 'UTC', metric: null, channel: null,
      group_by: [], filters: [], knowledge_refs: [], notes: '',
      source_limits: {allowed_sources: [{kind: 'document', id: gateDoc.id}], origin_message_ids: [run.message_id]}}});
  assert.equal(created.response.status, 200, JSON.stringify(created.response.value));
  await finish('受限任务已建立。');
  h.releaseRun(run.run_id);

  await h.resumeWorker();
  run = await h.capture(restrictedCid, '继续只用允许文档核对。'); await h.pauseWorker();
  const workspace = run.workspace_context;
  assert.ok(workspace.memories.some(asset => asset.id === sameMemory.id),
    '受限启动投影保留同源记忆');
  assert.ok(!workspace.memories.some(asset => [outMemory.id, memory.id, longMemory.id].includes(asset.id)),
    '受限启动投影排除范围外与无源记忆');
  assert.ok(workspace.selected_skills.some(asset => asset.id === sameSourceSkill.id),
    '受限启动投影保留同源已选Skill');
  assert.ok(!workspace.selected_skills.some(asset => [mixedSkill.id, manualSkill.id, unselectedSameSkill.id].includes(asset.id)),
    '受限启动投影排除混合依赖与人工无源Skill');
  // 新消息同样先route，读取工具才过正文准入门。
  assert.equal((await invoke('update_analysis_task', {action: 'route', task_id: null,
    expected_version: null, goal: '', options: []})).response.status, 200);
  const restrictedBatch = await invoke('read_knowledge', {items: [
    {kind: 'skill', asset_ref: {id: sameSourceSkill.id, version: sameSourceSkill.version}},
    {kind: 'skill', asset_ref: {id: mixedSkill.id, version: mixedSkill.version}},
    {kind: 'skill', asset_ref: {id: manualSkill.id, version: manualSkill.version}},
    {kind: 'skill', asset_ref: {id: unselectedSameSkill.id, version: unselectedSameSkill.version}},
    {kind: 'memory', asset_ref: {id: sameMemory.id, version: sameMemory.version}, part: 'body'},
    {kind: 'memory', asset_ref: {id: outMemory.id, version: outMemory.version}, part: 'body'},
  ]});
  assert.equal(restrictedBatch.response.status, 200, JSON.stringify(restrictedBatch.response.value));
  const restrictedItems = restrictedBatch.response.value.data.items;
  validateContract('KnowledgeReadReply', restrictedBatch.response.value.data);
  assert.deepEqual(restrictedItems.map(item => [item.kind, item.state]), [
    ['skill', 'ok'], ['skill', 'not_available'], ['skill', 'not_available'],
    ['skill', 'not_available'], ['memory', 'ok'], ['memory', 'not_available'],
  ], '仅D限制：同源可用，混合/人工/未选/范围外如实逐项拒绝');
  assert.equal(restrictedItems[0].asset.native_path, `/skills/${sameSourceSkill.id}/${sameSourceSkill.version}/SKILL.md`);
  assert.equal(restrictedItems[4].asset.body, '同源受限记忆正文。');
  for (const index of [1, 2, 3, 5]) assert.equal(Object.hasOwn(restrictedItems[index], 'asset'), false);
  const restrictedNative = await invoke('read', {path: `/skills/${sameSourceSkill.id}/${sameSourceSkill.version}/references/notes.md`, offset: 2, limit: 1});
  assert.equal(restrictedNative.response.status, 200, JSON.stringify(restrictedNative.response.value));
  assert.ok(restrictedNative.response.value.data.text.includes('同源附件第二行'), '受限下同源Skill分页读取仍可用');
  const mixedNative = await invoke('read', {path: `/skills/${mixedSkill.id}/${mixedSkill.version}/SKILL.md`});
  assert.equal(mixedNative.response.value.code, 'source_not_allowed', '混合依赖Skill原生读取拒绝');
  assert.equal((await h.internal('/internal/data/tool-rejections', mixedNative.input)).status, 200);
  const directory = await invoke('search_knowledge', {query: '*', limit: 20});
  assert.equal(directory.response.status, 200, '个人资产过滤不得拖累合法检索整次409');
  const directoryReply = directory.response.value.data;
  validateContract('KnowledgeSearchReply', directoryReply);
  assert.deepEqual(directoryReply.personal_memories.map(asset => asset.id), [sameMemory.id],
    '目录页按真实资产来源过滤：同源保留，范围外与无源排除');
  assert.ok(directoryReply.selected_skills.some(asset => asset.id === sameSourceSkill.id),
    '受限检索保留同源已选Skill预览');
  assert.ok(!directoryReply.selected_skills.some(asset => [mixedSkill.id, manualSkill.id, unselectedSameSkill.id].includes(asset.id)),
    '受限检索排除混合依赖与人工无源Skill预览');
  assert.notEqual(directoryReply.memory_retrieval, 'excluded_by_source_limits',
    '同源资产在场时不再笼统宣称全部排除');
  h.releaseRun(run.run_id);
  checks.push('受限来源按真实资产过滤：同源Skill/记忆descriptor、分页、目录与启动投影保留；混合/人工/未选/范围外逐项拒绝且检索不整次409');
  passed = true;
  console.log(JSON.stringify({passed, checks, calls, officialRequests: 0}));
} finally {
  globalThis.fetch = originalFetch;
  if (previousTest === undefined) delete process.env.DATA_AGENT_PROVIDER_TEST; else process.env.DATA_AGENT_PROVIDER_TEST = previousTest;
  if (h) { await writeFile(h.directory + '/evidence-assets.json', JSON.stringify({passed, errors, calls, capacitySamples, officialRequests: 0}, null, 2)); await h.close(); }
  if (prepared) {
    const dropped = await fetch('http://127.0.0.1:19531/v2/vectordb/collections/drop', {method: 'POST', headers: {'content-type': 'application/json', authorization: 'Bearer root:' + vectorToken}, body: JSON.stringify({dbName: 'default', collectionName: collection})});
    assert.equal((await dropped.json()).code, 0);
  }
  provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
}

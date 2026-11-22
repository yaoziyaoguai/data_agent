import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {isDeepStrictEqual} from 'node:util';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {validateContract} from '../../packages/contracts/validate.ts';
import {harness} from './harness.mjs';
import {assetInput, select} from './skill-fixtures.mjs';

// 依据evidence-delivery实施6/8/9/10及implementation-design 17.5：
// 冻结首次成功回执不能冻结授权。所有业务变化经正式入口提交；
// 较小response_budget的正向恢复沿check-evidence-response-budget，不在这里重复。
const collection = 'data_agent_test_' + randomUUID().replaceAll('-', '');
const checks = [], observations = [];
const providerEnvironment = new Map(Object.entries(process.env).filter(([key]) =>
  /^(DEEPSEEK_|OPENAI_|ANTHROPIC_|DATA_AGENT_(MODEL_|PROVIDER_|PREFILL_|EMBEDDING_|MEMORY_))/.test(key)));
let h, run, manager, vectorToken, prepared = false, passed = false, failure;
const ok = response => {assert.equal(response.status, 200, JSON.stringify(response.value)); return response.value;};
const checkpoint = () => exportCheckpoint(manager,
  run.workspace_context.authority_revision, run.workspace_context.authority_snapshot);
const begin = async (text, cid) => {
  await h.resumeWorker();
  run = await h.capture(cid ?? await h.create(), text);
  await h.pauseWorker();
  assert.equal(run.tool_contract_version, 2);
  manager = SessionManager.inMemory('/synthetic/evidence-replay-boundaries');
  // v2正文读取须先由当前消息建立来源上下文；重放负控不绕过这项准入。
  const task = await invoke('update_analysis_task', {action: 'create', goal: text, options: [],
    conditions: {time_start: null, time_end: null, timezone: 'UTC', metric: null,
      channel: null, group_by: [], filters: [], knowledge_refs: [], notes: '', source_limits: null}});
  const {task_id, condition_version} = task.receipt.data;
  assert.equal(typeof task_id, 'string');
  assert.equal(typeof condition_version, 'string');
  const [active] = h.sql(`SELECT JSON_OBJECT('task_id',c.active_task_id,
    'condition_version',CAST(r.version AS CHAR),'source_limit_type',JSON_TYPE(JSON_EXTRACT(r.body,'$.source_limits')))
    FROM conversations c JOIN condition_revisions r
      ON r.task_id=c.active_task_id AND r.version=c.active_task_condition_version
    WHERE c.id='${run.conversation_id}'`);
  assert.deepEqual(active, {task_id, condition_version, source_limit_type: 'NULL'},
    '精读运行绑定的是已落库的明确不限源任务版本');
};
const ledger = input => h.sql(`SELECT JSON_OBJECT(
  'operation_id',operation_id,'origin_run_id',origin_run_id,
  'conversation_id',conversation_id,'recovery_chain_id',recovery_chain_id,
  'sdk_tool_call_id',sdk_tool_call_id,'tool_name',tool_name,
  'tool_contract_version',tool_contract_version,'fingerprint',arguments_fingerprint,
  'state',state,'receipt',receipt) FROM tool_calls
  WHERE conversation_id='${run.conversation_id}' AND sdk_tool_call_id='${input.sdk_tool_call_id}'`);
const executeTool = async input => {
  const response = await fetch(h.env.DATA_AGENT_API_URL + '/internal/data/tools', {
    method: 'POST',
    headers: {authorization: 'Bearer ' + h.env.DATA_AGENT_INTERNAL_TOKEN, 'content-type': 'application/json'},
    body: JSON.stringify(input),
  });
  const wire = await response.text();
  return {status: response.status, value: JSON.parse(wire), wire};
};
const invoke = async (name, args) => {
  const input = {run_id: run.run_id, lease_epoch: run.lease_epoch,
    sdk_tool_call_id: randomUUID(), tool_name: name, arguments: args, checkpoint: checkpoint()};
  const registered = ok(await h.internal('/internal/data/tool-calls', input));
  const response = await executeTool(input);
  const receipt = ok(response);
  validateContract('DataToolOutcome', receipt);
  assert.equal(receipt.operation_id, registered.operation_id);
  assert.equal(receipt.tool_name, name);
  assert.equal(receipt.data.error, undefined, '负控必须先取得真实成功回执');
  if (name === 'read_knowledge') validateContract('KnowledgeReadReply', receipt.data);
  if (name === 'read_source') validateContract('SourceReadReply', receipt.data);
  const saved = ledger(input);
  assert.equal(saved.length, 1, '一个SDK调用只能有一条原成功账本');
  assert.equal(saved[0].state, 'succeeded');
  assert.equal(saved[0].origin_run_id, run.run_id);
  assert.equal(saved[0].recovery_chain_id, run.recovery_chain_id);
  assert.equal(saved[0].tool_contract_version, 2);
  assert.deepEqual(saved[0].receipt, receipt, '保留Rust首次成功的最终序列化回执');
  return {input, receipt, saved, wire: response.wire};
};
const rejectReplay = async (first, codes, label, forbidden) => {
  // 原封重传，不换sdk/operation，不修改ref、revision、task_ref或checkpoint。
  const registered = await h.internal('/internal/data/tool-calls', first.input);
  assert.deepEqual(ledger(first.input), first.saved, label + '：重新登记不能改写成功账本');
  assert.equal(ok(registered).operation_id, first.receipt.operation_id);
  const replay = await h.internal('/internal/data/tools', first.input);
  const after = ledger(first.input);
  observations.push({label, tool: first.input.tool_name, status: replay.status,
    code: replay.value.code ?? null, operation_id: first.receipt.operation_id,
    ledgerUnchanged: isDeepStrictEqual(after, first.saved)});
  assert.deepEqual(after, first.saved, label + '：拒绝不能换operation、覆盖首次data或改成rejected');
  assert.ok([404, 409].includes(replay.status), label + '：旧成功回执必须重新核验拒绝，实际为' + JSON.stringify(replay));
  assert.ok(codes.includes(replay.value.code), label + '：不能由租约、指纹、参数或服务错误代替边界拒绝：' + JSON.stringify(replay.value));
  for (const key of ['data', 'receipt', 'items', 'content', 'text', 'asset']) {
    assert.equal(Object.hasOwn(replay.value, key), false, label + '：拒绝响应不能夹带旧成功内容');
  }
  for (const text of forbidden) assert.equal(JSON.stringify(replay.value).includes(text), false,
    label + '：拒绝响应不能泄露旧正文或Skill描述');
  const rejection = await h.internal('/internal/data/tool-rejections', first.input);
  assert.equal(rejection.status, 404, label + '：当前拒绝不能伪造原调用的持久拒绝回执');
  assert.equal(rejection.value.code, 'not_available');
  assert.deepEqual(ledger(first.input), first.saved, label + '：查拒绝回执也不能改写首次成功');
  checks.push(label);
};
const saveKnowledge = async (kind, name, body) => ok(await h.request('/knowledge',
  {operation_id: randomUUID(), kind, name, body, related_ids: []}));
const reviseKnowledge = async (object, body) => {
  const entry = object.entries.find(value => value.path === 'body');
  assert.ok(entry);
  const revised = ok(await h.request('/knowledge/' + object.id, {operation_id: randomUUID(),
    expected_version: object.version, entry_id: entry.entry_id, value: body}, 'alice', 'PATCH'));
  assert.equal(revised.id, object.id);
  assert.notEqual(revised.version, object.version, '正式保存必须真实推进版本');
  const current = ok(await h.request('/knowledge/' + object.id));
  assert.equal(current.version, revised.version);
  assert.equal(current.entries.find(value => value.path === 'body').effective_value, body);
  return revised;
};
const knowledgeArguments = object => ({items: [{kind: 'knowledge',
  ref: {object_id: object.id, version: object.version, path: 'body'}, limit: 8}]});
const sourceArguments = (object, body) => ({citation: {source: {kind: 'document', id: object.id},
  revision: object.version, locator: {offset: 0, length: [...body].length}}, limit: 8});
const assertKnowledgePage = (first, body) => {
  assert.equal(first.receipt.data.items.length, 1);
  const item = first.receipt.data.items[0];
  assert.equal(item.kind, 'knowledge'); assert.equal(item.state, 'ok');
  assert.deepEqual(item.ref, first.input.arguments.items[0].ref);
  assert.equal(item.content, [...body].slice(0, 8).join(''));
  assert.equal(item.content_state, 'partial');
  assert.equal(item.continuation.content_next_offset, 8);
};
const assertSourcePage = (first, body) => {
  const page = first.receipt.data;
  assert.deepEqual(page.source, first.input.arguments.citation.source);
  assert.equal(page.revision, first.input.arguments.citation.revision);
  assert.equal(page.text, [...body].slice(0, 8).join(''));
  assert.equal(page.source_length, [...body].length);
  assert.deepEqual(page.locator, {offset: 0, length: 8});
  assert.equal(page.content_state, 'partial');
  assert.deepEqual(page.next_locator, {offset: 8, length: [...body].length - 8});
};
const retire = () => {
  // 捕获式运行不派发Pi。沿现有source-limits夹具终止失效运行，防止下一场景
  // 启动Worker时恢复它；这里只修改本次隔离库的调度状态，不动任何tool记录。
  h.sql(`UPDATE agent_runs SET state='failed' WHERE id='${run.run_id}';
    UPDATE conversations SET lease_owner=NULL,lease_until=NULL
      WHERE id='${run.conversation_id}' AND lease_owner='${run.run_id}';
    UPDATE background_jobs SET state='failed',lease_owner=NULL,lease_until=NULL WHERE message_id='${run.message_id}';
    UPDATE conversation_messages SET disposition='failed' WHERE id='${run.message_id}' AND disposition='pending';`);
  h.releaseRun(run.run_id);
  run = undefined;
};

try {
  // 清除继承的真实provider、Embedding、预填及记忆端点；本脚本不调用deliver。
  for (const key of providerEnvironment.keys()) delete process.env[key];
  vectorToken = (await readFile('.local/infra/milvus-root-password', 'utf8')).trim();
  h = await harness({capture: true, startWorker: false,
    env: {DATA_AGENT_LEASE_MS: '120000', DATA_AGENT_TOOL_CONTRACT_VERSION: '2',
      DATA_AGENT_PROVIDER_TEST: '1', DATA_AGENT_PREFILL_PROFILE: '',
      DATA_AGENT_VECTOR_URL: 'http://127.0.0.1:19531', DATA_AGENT_VECTOR_COLLECTION: collection,
      DATA_AGENT_VECTOR_TOKEN_FILE: process.cwd() + '/.local/infra/milvus-root-password'}});
  ok(await h.request('/knowledge-index/rebuilds', {operation_id: randomUUID()})); prepared = true;

  const ruleBody = '合成知识初版甲🌏é：旧定义只用于本次重放负控。';
  const rule = await saveKnowledge('term', '合成知识换版重放', ruleBody);
  await begin('核对合成知识初版，随后检查真实换版后的原回执。');
  const knowledgeRead = await invoke('read_knowledge', knowledgeArguments(rule));
  assertKnowledgePage(knowledgeRead, ruleBody);
  await reviseKnowledge(rule, '合成知识新版乙：本次正式维护已替换旧定义。');
  await rejectReplay(knowledgeRead, ['stale_context', 'stale_knowledge'],
    '知识真实换版后拒绝原read_knowledge成功回执，账本与首次正文/续读冻结',
    [knowledgeRead.receipt.data.items[0].content]);
  retire();

  const sourceBody = '合成来源初版甲🌏é：文档修订后旧原文不能重新交付。';
  const source = await saveKnowledge('document', '合成来源换版重放', sourceBody);
  await begin('定点核对合成文档初版，随后维护同一来源。');
  const sourceRead = await invoke('read_source', sourceArguments(source, sourceBody));
  assertSourcePage(sourceRead, sourceBody);
  await reviseKnowledge(source, '合成来源新版乙：当前正文已正式保存为新修订。');
  // current_use重核可从上下文、知识owner或来源owner报告修订失效。
  await rejectReplay(sourceRead, ['stale_context', 'stale_knowledge', 'stale_source'],
    '来源真实换版后拒绝原read_source成功回执，账本与首次正文/locator冻结',
    [sourceRead.receipt.data.text]);
  retire();

  await begin('读取本人的合成记忆三个部分，随后正式停用。');
  const memoryParts = {body: '合成记忆正文甲🌏é：停用后不能重放。',
    scope: '合成记忆范围甲：只用于本人的隔离验收。', source_text: '合成记忆原话甲：这是从零编造的材料。'};
  const memory = ok(await h.request('/assets', assetInput({kind: 'memory',
    name: '合成记忆停用重放', ...memoryParts})));
  const parts = Object.keys(memoryParts);
  const memoryRead = await invoke('read_knowledge', {items: parts.map(part => ({kind: 'memory',
    asset_ref: {id: memory.id, version: memory.version}, part, limit: 8}))});
  assert.equal(memoryRead.receipt.data.items.length, parts.length);
  for (const [index, part] of parts.entries()) {
    const item = memoryRead.receipt.data.items[index];
    assert.equal(item.kind, 'memory'); assert.equal(item.state, 'ok'); assert.equal(item.part, part);
    assert.deepEqual(item.asset_ref, {id: memory.id, version: memory.version});
    assert.equal(item.asset[part], [...memoryParts[part]].slice(0, 8).join(''));
    const page = item.asset[{body: 'content_page', scope: 'scope_page', source_text: 'source_page'}[part]];
    assert.equal(page.next_offset, 8);
  }
  const disabled = ok(await h.request('/assets/' + memory.id + '/disable',
    {operation_id: randomUUID(), expected_version: memory.version}));
  assert.equal(disabled.id, memory.id); assert.equal(disabled.state, 'disabled');
  assert.equal(ok(await h.request('/assets')).assets.find(value => value.id === memory.id).state, 'disabled');
  await rejectReplay(memoryRead, ['not_available', 'stale_context'],
    '本人记忆真实停用后拒绝三个分支的原成功回执，首次data与分页不改写',
    memoryRead.receipt.data.items.map(item => item.asset[item.part]));
  retire();

  const skill = ok(await h.request('/assets', assetInput({name: '合成撤回重放方法',
    body: '此合成方法仅在明确选用时可读。', scope: '合成重放边界验收', source_text: '合成用户明确保存'})));
  const cid = await h.create();
  ok(await select(h, cid, skill));
  const selection = ok(await h.request(`/conversations/${cid}/skill-selections`)).selections
    .find(value => value.asset_id === skill.id);
  assert.ok(selection); assert.equal(selection.availability, 'available');
  await begin('读取已选的合成Skill描述，随后撤回该选择。', cid);
  const skillRead = await invoke('read_knowledge', {items: [{kind: 'skill',
    asset_ref: {id: skill.id, version: skill.version}}]});
  assert.equal(skillRead.receipt.data.items.length, 1);
  const descriptor = skillRead.receipt.data.items[0];
  assert.equal(descriptor.kind, 'skill'); assert.equal(descriptor.state, 'ok');
  assert.deepEqual(descriptor.asset_ref, {id: skill.id, version: skill.version});
  assert.equal(descriptor.asset.selected, true);
  assert.equal(descriptor.asset.native_path, `/skills/${skill.id}/${skill.version}/SKILL.md`);
  const scheduling = () => h.sql(`SELECT JSON_OBJECT('lease_owner',c.lease_owner,
    'lease_epoch',CAST(c.lease_epoch AS CHAR),'lease_until',DATE_FORMAT(c.lease_until,'%Y-%m-%d %H:%i:%s.%f'),
    'disposition',m.disposition,'run_state',r.state,'job_state',j.state)
    FROM conversations c JOIN conversation_messages m ON m.conversation_id=c.id
    JOIN agent_runs r ON r.message_id=m.id JOIN background_jobs j ON j.id=r.job_id
    WHERE r.id='${run.run_id}'`)[0];
  const scheduled = scheduling();
  assert.equal(scheduled.lease_owner, run.run_id); assert.equal(scheduled.lease_epoch, run.lease_epoch);
  assert.equal(scheduled.disposition, 'pending'); assert.equal(scheduled.run_state, 'running');
  // 正式撤回拒绝pending输入；Worker已暂停，只暂存并释放调度门让正式DELETE生效，
  // 然后恢复原run/lease/message来隔离重放核验。不是用户可并发撤回的流程证明。
  h.sql(`UPDATE conversations SET lease_owner=NULL,lease_until=NULL WHERE id='${cid}';
    UPDATE conversation_messages SET disposition='consumed' WHERE id='${run.message_id}';`);
  try {
    assert.equal(ok(await h.request(`/conversations/${cid}/skill-selections`)).change_blocked, false);
    const removed = ok(await h.request(`/conversations/${cid}/skill-selections`,
      {operation_id: randomUUID(), asset_id: skill.id, selection_id: selection.selection_id}, 'alice', 'DELETE'));
    assert.equal(removed.state, 'removed');
    assert.ok(!ok(await h.request(`/conversations/${cid}/skill-selections`)).selections
      .some(value => value.asset_id === skill.id), '实际选择已撤回');
  } finally {
    h.sql(`UPDATE conversations SET lease_owner='${scheduled.lease_owner}',lease_until='${scheduled.lease_until}'
        WHERE id='${cid}' AND lease_epoch=${scheduled.lease_epoch};
      UPDATE conversation_messages SET disposition='${scheduled.disposition}' WHERE id='${run.message_id}';`);
  }
  assert.deepEqual(scheduling(), scheduled, '撤回后恢复原调度身份和租约，不换run绕过边界');
  const unselected = ok(await h.request('/assets')).assets.find(value => value.id === skill.id);
  assert.ok(unselected);
  assert.equal(unselected.version, skill.version); assert.equal(unselected.state, 'enabled');
  await rejectReplay(skillRead, ['not_available', 'stale_context'],
    'Skill真实撤回选用后拒绝原descriptor成功回执，资产仍启用且首次data不改写',
    [skill.name, descriptor.asset.native_path]);
  retire();

  const allowedBody = '合成范围初始允许甲🌏é：范围收紧后旧内容不可重放。';
  const allowed = await saveKnowledge('document', '合成范围被排除来源', allowedBody);
  const retained = await saveKnowledge('document', '合成范围保留来源', '收紧后仅允许这一份合成来源。');
  await begin('先用两份合成文档核对，再收紧为仅用保留来源。');
  const conditions = {time_start: null, time_end: null, timezone: 'UTC', metric: null,
    channel: null, group_by: [], filters: [], knowledge_refs: [], notes: '', source_limits: {
      allowed_sources: [allowed, retained].map(value => ({kind: 'document', id: value.id})),
      origin_message_ids: [run.message_id]}};
  const task = (await invoke('update_analysis_task', {action: 'create', goal: '合成范围收紧', conditions, options: []})).receipt.data;
  const scopedKnowledge = await invoke('read_knowledge', knowledgeArguments(allowed));
  const scopedSource = await invoke('read_source', sourceArguments(allowed, allowedBody));
  assertKnowledgePage(scopedKnowledge, allowedBody); assertSourcePage(scopedSource, allowedBody);
  assert.equal(Object.hasOwn(scopedKnowledge.input.arguments, 'task_ref'), false);
  assert.equal(Object.hasOwn(scopedSource.input.arguments, 'task_ref'), false);
  const tightened = (await invoke('update_analysis_task', {action: 'revise', task_id: task.task_id,
    expected_version: task.condition_version, goal: '', options: [], condition_patch: {set: {source_limits: {
      allowed_sources: [{kind: 'document', id: retained.id}], origin_message_ids: [run.message_id]}}, unset: []}})).receipt.data;
  assert.equal(tightened.task_id, task.task_id); assert.notEqual(tightened.condition_version, task.condition_version);
  const currentTask = (await h.snapshot(run.conversation_id)).tasks.find(value => value.id === task.task_id);
  assert.ok(currentTask); assert.equal(currentTask.condition_version, tightened.condition_version);
  const currentConditions = (await invoke('read_analysis_task', {task_id: task.task_id})).receipt.data.conditions;
  assert.deepEqual(currentConditions.source_limits.allowed_sources, [{kind: 'document', id: retained.id}]);
  const activeTask = h.sql(`SELECT JSON_OBJECT('task_id',active_task_id,
    'condition_version',CAST(active_task_condition_version AS CHAR)) FROM conversations WHERE id='${run.conversation_id}'`)[0];
  assert.deepEqual(activeTask, {task_id: task.task_id, condition_version: tightened.condition_version},
    '重放必须面对收紧后的实际活动任务，不能只改非活动任务条件');
  assert.equal(ok(await h.request('/knowledge/' + allowed.id)).version, allowed.version, '来源修订保持不变，只改变当前任务范围');
  for (const first of [scopedKnowledge, scopedSource]) {
    await rejectReplay(first, ['source_not_allowed', 'stale_context'],
      '当前活动任务范围真实收紧后拒绝原' + first.input.tool_name + '回执，省略task_ref仍重核且不改账本',
      [[...allowedBody].slice(0, 8).join('')]);
  }
  retire();

  const table = ok(await h.request('/knowledge/table-demo_order_detail'));
  const description = table.entries.find(entry => entry.path === 'description');
  const ddl = table.entries.find(entry => entry.path === 'ddl');
  assert.equal(table.source_id, 'schema');
  assert.equal(description.source_facts.source_id, 'business-guide');
  assert.equal(ddl.source_facts.source_id, 'schema');
  await begin('先核对业务指南中的表说明，再切换为只用表结构来源。');
  const platformScope = id => ({allowed_sources: [{kind: 'platform', id}],
    origin_message_ids: [run.message_id]});
  const sourceTask = (await invoke('update_analysis_task', {action: 'create', goal: '合成表的条目限源',
    conditions: {...conditions, source_limits: platformScope('business-guide')}, options: []})).receipt.data;
  const readTableEntry = entry => invoke('read_knowledge', {items: [{kind: 'knowledge',
    ref: {object_id: table.id, version: table.version, path: entry.path}, limit: 8}]});
  const descriptionRead = await readTableEntry(description);
  assertKnowledgePage(descriptionRead, description.effective_value);
  const registered = ok(await h.internal('/internal/data/tool-calls', descriptionRead.input));
  assert.equal(registered.operation_id, descriptionRead.receipt.operation_id);
  const replay = await executeTool(descriptionRead.input);
  ok(replay);
  assert.equal(replay.wire, descriptionRead.wire, '业务指南仍可用时返回同一操作的原始回执字节');
  assert.deepEqual(ledger(descriptionRead.input), descriptionRead.saved);
  checks.push('表说明沿直接来源业务指南交付，相同范围重放保持原回执字节及原操作');

  const schemaOnly = platformScope('schema');
  const changedSourceTask = (await invoke('update_analysis_task', {action: 'revise', task_id: sourceTask.task_id,
    expected_version: sourceTask.condition_version, goal: '', options: [],
    condition_patch: {set: {source_limits: schemaOnly}, unset: []}})).receipt.data;
  assert.equal(changedSourceTask.task_id, sourceTask.task_id);
  assert.notEqual(changedSourceTask.condition_version, sourceTask.condition_version);
  const changedSourceConditions = (await invoke('read_analysis_task', {task_id: sourceTask.task_id})).receipt.data.conditions;
  assert.deepEqual(changedSourceConditions.source_limits, schemaOnly);
  assertKnowledgePage(await readTableEntry(ddl), ddl.effective_value);
  await rejectReplay(descriptionRead, ['source_not_allowed', 'stale_context'],
    '仅允许表结构来源时新读DDL成功，表说明仍不得借用同一表头的来源重放',
    [descriptionRead.receipt.data.items[0].content]);
  retire();

  assert.equal(h.sql("SELECT JSON_OBJECT('n',COUNT(*)) FROM model_call_attempts")[0].n, 0,
    '仅调用正式工具边界，不产生模型调用');
  passed = true;
  console.log(JSON.stringify({passed, checks, observations, officialRequests: 0}));
} catch (error) {
  failure = error.message;
  throw error;
} finally {
  try {
    try {
      if (h) await writeFile(h.directory + '/evidence-replay-boundaries.json',
        JSON.stringify({passed, checks, observations, failure, officialRequests: 0}, null, 2));
    } finally {
      if (h) await h.close();
    }
  } finally {
    try {
      if (prepared) {
        const response = await fetch('http://127.0.0.1:19531/v2/vectordb/collections/drop', {method: 'POST',
          headers: {'content-type': 'application/json', authorization: 'Bearer root:' + vectorToken},
          body: JSON.stringify({dbName: 'default', collectionName: collection})});
        assert.equal((await response.json()).code, 0);
      }
    } finally {
      for (const [key, value] of providerEnvironment) process.env[key] = value;
    }
  }
}

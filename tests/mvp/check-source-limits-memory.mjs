import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {validateContract} from '../../packages/contracts/validate.ts';
import {harness,until} from './harness.mjs';

// 受限任务不注入个人记忆预览；已有任务正文仍继承完整出处。
// 合成资料、隔离MySQL与本地Mem0替身验证来源限制与正常派发兼容。
const indexes = new Map();
const server = createServer(async (req, res) => {
  let input;
  try {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    input = JSON.parse(raw);
    let result;
    if (req.url === '/search') {
      result = {
        candidates: [...indexes.values()]
          .filter(v => v.owner === input.owner_id && v.space === input.space_id && v.state === 'enabled')
          .map(v => ({asset_id: v.id, version: v.version})),
        bounded: false,
      };
    } else if (req.url === '/index') {
      const key = input.owner_id + '::' + input.space_id + '::' + input.asset.id;
      indexes.set(key, {...input.asset, owner: input.owner_id, space: input.space_id});
      result = {operation_id: input.operation_id, state: input.asset.state === 'enabled' ? 'ready' : 'removed'};
    } else {
      throw new Error('unexpected_path');
    }
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify(result));
  } catch (error) {
    res.writeHead(503, {'content-type': 'application/json'});
    res.end(JSON.stringify({error: 'memory_unavailable'}));
    console.error('sidecar_test_failure', error.message);
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

const h = await harness({capture: true, startWorker: false, env: {
  DATA_AGENT_MEMORY_URL: 'http://127.0.0.1:' + server.address().port,
  DATA_AGENT_LEASE_MS: '120000',
}});
let run, manager;
const checks = [];
let passed = false;
const ok = response => {assert.equal(response.status, 200, JSON.stringify(response.value)); return response.value;};
const checkpoint = () => exportCheckpoint(manager,
  run.workspace_context.authority_revision, run.workspace_context.authority_snapshot);
const begin = async (cid, text) => {
  await h.resumeWorker();
  run = await h.capture(cid, text);
  await h.pauseWorker();
  manager = SessionManager.inMemory('/synthetic/data-agent');
};
const invoke = async (name, args, expectedError) => {
  const input = {run_id: run.run_id, lease_epoch: run.lease_epoch,
    sdk_tool_call_id: randomUUID(), tool_name: name, arguments: args, checkpoint: checkpoint()};
  ok(await h.internal('/internal/data/tool-calls', input));
  const result = await h.internal('/internal/data/tools', input);
  if (expectedError) {
    assert.equal(result.value.code, expectedError, JSON.stringify(result.value));
    return ok(await h.internal('/internal/data/tool-rejections', input)).data;
  }
  return ok(result).data;
};
const finish = async () => {
  const binding = {run_id: run.run_id, lease_epoch: run.lease_epoch};
  const text = '本轮记忆来源限制检查完成。';
  ok(await h.internal('/internal/outputs', {...binding, chunk_seq: '1', text}));
  ok(await h.internal('/internal/finish', {...binding, commit_id: run.output_id,
    final_text: text, checkpoint: checkpoint()}));
  h.releaseRun(run.run_id);
};
const issue = () => h.internal('/internal/model/issue',
  {run_id: run.run_id, lease_epoch: run.lease_epoch, call_attempt_id: randomUUID()});

try {
  // 已索引的个人记忆：未受限启动照常预览并回源。索引作业由Worker处理，
  // 建资产阶段临时拉起，之后恢复暂停基线。
  const memory = ok(await h.request('/assets', {operation_id: randomUUID(), id: null,
    expected_version: null, kind: 'memory', name: '金额偏好', body: '金额按元展示',
    scope: '收入分析', verified: false, source_text: '本人录入', dependencies: []}));
  await h.resumeWorker();
  await until(async () => (await h.request('/assets')).value.assets
    .find(v => v.id === memory.id)?.memory_index_state === 'indexed', 'memory indexed');
  await h.pauseWorker();

  const demoRef = {object_id: 'table-demo_order_detail', version: '1', path: 'description'};
  const conditions = {time_start: null, time_end: null, timezone: 'UTC', metric: null,
    channel: null, group_by: [], filters: [], knowledge_refs: [demoRef], notes: ''};

  const cid = await h.create();
  await begin(cid, '请记住金额展示偏好，先不查数据。');
  assert.equal(run.workspace_context.memory_retrieval, 'mem0_authoritative',
    '未受限启动经Mem0权威检索');
  assert.ok(run.workspace_context.memories.some(v => v.id === memory.id),
    '未受限启动预览个人记忆');
  validateContract('WorkspaceContext', run.workspace_context);

  // 任务goal来自本轮模型输出：其goal_authority含创作期记忆出处。先在未受限轮
  // 保存并执行一条查询（其正文权威含起草轮记忆预览），读取结果后创建任务——
  // 任务出处同时携带记忆与查询引用，构成受限covers冲突的完整形态。
  const queryTask = await invoke('update_analysis_task',
    {action: 'create', goal: '按本人偏好统计金额', conditions, options: []});
  const draft = await invoke('request_query', {task_id: queryTask.task_id,
    condition_version: queryTask.condition_version,
    sql: 'SELECT 2 AS ok', parameters: {}, target_id: 'synthetic-sqlite',
    summary: '起草轮记忆预览下的查询', knowledge_refs: [demoRef], replaces_query_id: null});
  await finish();
  ok(await h.request(`/queries/${draft.id}/confirm`, {operation_id: randomUUID(),
    draft_version: draft.draft_version, condition_version: draft.condition_version}));
  await begin(cid, '读取查询结果并建任务。');
  await h.resumeWorker();
  await until(async () => (await ok(await h.request(`/queries/${draft.id}`))).execution_state
    === 'succeeded', 'query executed');
  await h.pauseWorker();
  const delivered = await invoke('get_query', {query_id: draft.id});
  assert.ok(delivered.query.sql.includes('2 AS ok'), '未受限轮读取查询正文');
  assert.ok(delivered.results, '未受限轮交付查询结果');
  const citingTask = await invoke('update_analysis_task',
    {action: 'create', goal: '结合查询结果与本人偏好出结论', conditions, options: []});
  await invoke('update_analysis_task', {action: 'revise', task_id: citingTask.task_id,
    expected_version: citingTask.condition_version, goal: '', options: [],
    condition_patch: {set: {source_limits: {allowed_sources: [
      {kind: 'platform', id: 'business-guide'},
    ], origin_message_ids: [run.message_id]}}, unset: []}});
  await finish();

  // 查询完成生成自己的结果输入投递（04切片5/Fix B）：它是比新输入更旧的待领任务，
  // 不完整收下就会先占住会话派发，后续轮次永远等不到捕获。通知轮交付事务内绑定
  // 查询所属任务；轮内显式route回受限任务，受限首派断言才落在正确任务上。
  const handled = new Set(h.captured.map(value => value.message_id));
  await h.resumeWorker();
  const notified = await until(async () => h.captured
    .find(value => value.conversation_id === cid && !handled.has(value.message_id)),
    'host result notification', 40000);
  assert.deepEqual(notified.workspace_context.result_notification,
    {query_id: draft.id, execution_state: 'succeeded',
      task_ref: {task_id: queryTask.task_id, condition_version: queryTask.condition_version}},
    '结果通知轮携带查询完成状态');
  assert.deepEqual(notified.workspace_context.active_task_ref,
    {task_id: queryTask.task_id, condition_version: queryTask.condition_version},
    '结果输入交付时绑定查询所属任务为活动任务');
  const mainRun = run;
  run = notified;
  const restrictedParent = await invoke('read_analysis_task', {task_id: citingTask.task_id});
  const child = await invoke('update_analysis_task', {action: 'split',
    task_id: citingTask.task_id, expected_version: restrictedParent.condition_version,
    goal: '拆分后的同范围任务', options: [], moved_clarification_ids: [],
    conditions: {...conditions, knowledge_refs: [], source_limits: null}});
  const childView = await invoke('read_analysis_task', {task_id: child.task_id});
  assert.deepEqual(childView.conditions.source_limits?.allowed_sources,
    [{kind: 'platform', id: 'business-guide'}],
    '结果通知不包含用户解除限制：拆分的完整条件null必须继承父任务范围');
  await invoke('read_knowledge', {object_id: 'table-demo_order_detail'}, 'source_not_allowed');
  checks.push('结果通知中的任务拆分不能用null解除来源限制，子任务继承原允许集');
  await invoke('update_analysis_task', {action: 'route', task_id: citingTask.task_id,
    expected_version: (await invoke('read_analysis_task', {task_id: citingTask.task_id}))
      .condition_version, goal: '', options: []});
  await finish();
  run = mainRun;

  // 受限派发只交付可用任务控制信息，不混入范围外派生正文。
  await begin(cid, '继续只用业务指南统计。');
  assert.equal(run.workspace_context.memory_retrieval, 'excluded_by_source_limits',
    '无可证明同源记忆时受限启动如实标记排除');
  assert.equal(run.workspace_context.memories.length, 0, '受限启动不注入无公共来源的个人记忆');
  validateContract('WorkspaceContext', run.workspace_context);
  const readBack = await invoke('read_analysis_task', {task_id: citingTask.task_id});
  assert.equal(readBack.goal, undefined, '独立私人记忆与范围外结果的派生目标不进入受限上下文');
  let probe = await issue();
  assert.equal(probe.status, 200, JSON.stringify(probe.value));
  await invoke('update_analysis_task', {action: 'route', task_id: citingTask.task_id,
    expected_version: (await invoke('read_analysis_task', {task_id: citingTask.task_id}))
      .condition_version, goal: '', options: []});
  await finish();

  // 跨轮仍保持实际来源限制。
  await begin(cid, '继续按业务指南核对。');
  assert.deepEqual(run.workspace_context.memories, []);
  const continued = await invoke('read_analysis_task', {task_id: citingTask.task_id});
  assert.equal(continued.goal, undefined, '跨轮不恢复范围外派生正文');
  probe = await issue();
  assert.equal(probe.status, 200, '隐藏范围外正文后仍能正常续轮');

  // 限制在内容交付前生效；拒读后可继续原消息，不靠人为置失败再发一条。
  await invoke('get_query', {query_id: draft.id}, 'source_not_allowed');
  assert.equal((await issue()).status, 200, '拒读没有污染当前上下文，原消息继续');
  await invoke('update_analysis_task', {action: 'route', task_id: null, expected_version: null,
    goal: '', question: null, options: []});
  await finish();
  // R08同源正控（Mem0侧车启用）：受限任务允许记忆所依赖的文档时，注入与检索
  // 按真实来源保留同源记忆并如实说明通道，无公共来源的人工记忆仍排除。
  const gateDoc = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'document',
    name: '合成记忆同源文档', body: '同源记忆依赖的文档正文。', related_ids: []}));
  const citedMemory = ok(await h.request('/assets', {operation_id: randomUUID(), id: null,
    expected_version: null, kind: 'memory', name: '同源文档口径', body: '按同源文档口径统计',
    scope: '收入分析', verified: false, source_text: '本人录入',
    dependencies: [{object_id: gateDoc.id, version: gateDoc.version, path: 'body'}]}));
  await h.resumeWorker();
  await until(async () => (await h.request('/assets')).value.assets
    .find(v => v.id === citedMemory.id)?.memory_index_state === 'indexed', 'cited memory indexed');
  await h.pauseWorker();
  await begin(cid, '建立只按同源文档核对的受限任务。');
  await invoke('update_analysis_task', {action: 'create', goal: '只按同源文档核对记忆',
    options: [], conditions: {...conditions, knowledge_refs: [],
      source_limits: {allowed_sources: [{kind: 'document', id: gateDoc.id}], origin_message_ids: [run.message_id]}}});
  await finish();
  await begin(cid, '继续只用同源文档核对。');
  assert.equal(run.workspace_context.memory_retrieval, 'mem0_authoritative',
    '同源记忆在场时受限注入走真实Mem0通道，不笼统标记排除');
  assert.ok(run.workspace_context.memories.some(v => v.id === citedMemory.id),
    '受限注入保留可证明同源的记忆');
  assert.ok(!run.workspace_context.memories.some(v => v.id === memory.id),
    '无公共来源的人工记忆仍排除');
  validateContract('WorkspaceContext', run.workspace_context);
  probe = await issue();
  assert.equal(probe.status, 200, '同源记忆注入后受限派发正常');
  const docSearch = await invoke('search_knowledge', {query: '口径', limit: 10});
  assert.ok(docSearch.personal_memories.some(v => v.id === citedMemory.id),
    '受限检索保留同源记忆候选');
  assert.ok(!docSearch.personal_memories.some(v => v.id === memory.id),
    '受限检索仍排除无公共来源的人工记忆');
  assert.notEqual(docSearch.memory_retrieval, 'excluded_by_source_limits',
    '同源记忆在场时检索不笼统标记全部排除');
  await invoke('update_analysis_task', {action: 'route', task_id: null, expected_version: null,
    goal: '', question: null, options: []});
  await finish();
  checks.push('记忆侧车启用时受限任务按真实资产来源过滤：无可证明同源记忆时如实标记excluded_by_source_limits，'
    + '同源记忆经Mem0注入与检索保留且受限派发正常，无公共来源的记忆与范围外结果不能经任务正文或检索进入，'
    + '范围外get_query在交付前拒绝且原消息可继续；未受限启动照常Mem0权威预览');
  passed = true;
  console.log(JSON.stringify({passed, checks, officialRequests: 0}));
} finally {
  await writeFile('.local/checks/source-limits-memory.json',
    JSON.stringify({passed, checks, officialRequests: 0}, null, 2));
  if (h) await h.close();
  await new Promise(resolve => server.close(resolve));
}

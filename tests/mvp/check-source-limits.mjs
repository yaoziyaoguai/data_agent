import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness} from './harness.mjs';

// 04切片2：source_limits消费侧硬门。来源身份跟任务条件走；只用合成资料与隔离MySQL。
const h = await harness({capture: true, startWorker: false, env: {DATA_AGENT_LEASE_MS: '120000'}});
let run, manager;
const checks = [];
const ok = response => {assert.equal(response.status, 200, JSON.stringify(response.value)); return response.value;};
const checkpoint = () => exportCheckpoint(manager,
  run.workspace_context.authority_revision, run.workspace_context.authority_snapshot);
const begin = async (cid, text) => {
  await h.resumeWorker(); run = await h.capture(cid, text); await h.pauseWorker();
  manager = SessionManager.inMemory('/synthetic/data-agent');
};
const invoke = async (name, args, error) => {
  const input = {run_id: run.run_id, lease_epoch: run.lease_epoch,
    sdk_tool_call_id: randomUUID(), tool_name: name, arguments: args, checkpoint: checkpoint()};
  ok(await h.internal('/internal/data/tool-calls', input));
  const response = await h.internal('/internal/data/tools', input);
  if (!error) return ok(response).data;
  assert.notEqual(response.status, 200);
  assert.equal(response.value.code, error, JSON.stringify(response.value));
  const receipt = ok(await h.internal('/internal/data/tool-rejections', input));
  assert.equal(receipt.data.error, error);
  return receipt.data;
};
const finish = async () => {
  const binding = {run_id: run.run_id, lease_epoch: run.lease_epoch};
  const text = '本轮来源限制检查完成。';
  ok(await h.internal('/internal/outputs', {...binding, chunk_seq: '1', text}));
  ok(await h.internal('/internal/finish', {...binding, commit_id: run.output_id,
    final_text: text, checkpoint: checkpoint()}));
  h.releaseRun(run.run_id);
};
const demoRef = {object_id: 'table-demo_order_detail', version: '1', path: 'description'};
const conditions = {time_start: null, time_end: null, timezone: 'UTC', metric: null,
  channel: null, group_by: [], filters: [], knowledge_refs: [demoRef], notes: ''};
const platform = id => ({kind: 'platform', id});
const createTask = async goal => (await invoke('update_analysis_task',
  {action: 'create', goal, conditions, options: []}));
const currentVersion = async task_id =>
  (await invoke('read_analysis_task', {task_id})).condition_version;
const declareLimits = async (task_id, allowed_sources) => {
  const version = await currentVersion(task_id);
  return invoke('update_analysis_task', {action: 'revise', task_id, expected_version: version,
    goal: '', condition_patch: {set: {source_limits:
      {allowed_sources, origin_message_ids: [run.message_id]}}, unset: []}, options: []});
};
const queriesOf = async cid => ok(await h.request(`/conversations/${cid}/queries`)).queries;

try {
  // 手写词条与个人记忆没有可核验贡献根；demo表的贡献根是三个平台来源。
  const handwritten = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'metric',
    name: '手写口径词条', body: '人工口径，无来源依赖', related_ids: []}));
  const memory = ok(await h.request('/assets', {operation_id: randomUUID(), id: null,
    expected_version: null, kind: 'memory', name: '个人偏好', body: '按本人习惯展示',
    scope: '仅本人展示', verified: false, source_text: '本人录入', dependencies: []}));

  // 一、允许集覆盖全部实际贡献根：正常读取；独立人工内容与个人记忆不放行。
  const full = await h.create();
  await begin(full, '只用业务指南、schema和etl做统计。');
  const fullTask = await createTask('全量允许的统计');
  await declareLimits(fullTask.task_id,
    [platform('business-guide'), platform('schema'), platform('etl')]);
  const guide = await invoke('read_source', {source_id: 'business-guide', version: '1'});
  assert.ok(typeof guide.body === 'string' && guide.body.length > 0, '允许的平台来源正文可读');
  assert.equal((await invoke('read_knowledge', {object_id: 'table-demo_order_detail'})).id,
    'table-demo_order_detail', '贡献根全部在允许集内的对象可读');
  await invoke('read_knowledge', {object_id: handwritten.id}, 'source_not_allowed');
  await invoke('read_knowledge', {object_id: `asset-${memory.id}`}, 'source_not_allowed');
  const search = await invoke('search_knowledge', {query: '订单'});
  assert.equal(search.source_limits.allowed_sources.length, 3, '受限检索回执携带允许集');
  assert.ok(Number.isInteger(search.source_limits.filtered_candidates),
    '回执携带整数过滤计数，与candidate_limit空结果可区分');
  assert.ok(search.objects.some(object => object.id === 'table-demo_order_detail'),
    '允许集覆盖全部贡献根时命中demo表（过滤正对照）');
  assert.equal(search.personal_memories.length, 0, '受限检索不交付个人记忆线索');
  assert.equal(search.memory_retrieval, 'excluded_by_source_limits');
  const within = await invoke('validate_sql', {sql: 'SELECT SUM(quantity) AS total FROM demo_order_detail',
    parameters: {}, target_id: 'synthetic-sqlite', knowledge_refs: [demoRef]});
  assert.ok(!JSON.stringify(within.semantic_checks.coverage.missing_semantics ?? [])
    .includes('来源允许范围'), '允许集内引用不产生范围缺口');
  const saved = await invoke('request_query', {task_id: fullTask.task_id,
    condition_version: await currentVersion(fullTask.task_id),
    sql: 'SELECT SUM(quantity) AS total FROM demo_order_detail', parameters: {},
    target_id: 'synthetic-sqlite', summary: '允许集内引用正常保存草稿',
    knowledge_refs: [demoRef], replaces_query_id: null});
  assert.equal(saved.execution_state, 'not_submitted', '受限下允许集内引用可保存正式草稿');
  // 闭包不完整fail-closed：映射状态改unknown后即使已知根全在允许集内也拒绝，恢复后可读。
  h.sql(`UPDATE knowledge_dependency_states SET mapping_state='unknown' WHERE owner_id='table-demo_order_detail'`);
  await invoke('read_knowledge', {object_id: 'table-demo_order_detail'}, 'source_not_allowed');
  h.sql(`UPDATE knowledge_dependency_states SET mapping_state='complete' WHERE owner_id='table-demo_order_detail'`);
  assert.equal((await invoke('read_knowledge', {object_id: 'table-demo_order_detail'})).id,
    'table-demo_order_detail', '映射恢复完整后重新可读');
  checks.push('允许集覆盖全部贡献根时正常读取并保存草稿；无根内容不放行；unknown闭包fail-closed');
  await finish();

  // 二、部分允许：传递根含schema/etl，不因主根在允许集而放行。
  const partial = await h.create();
  await begin(partial, '这次只用业务指南本身。');
  const partialTask = await createTask('只用业务指南的统计');
  await declareLimits(partialTask.task_id, [platform('business-guide')]);
  await invoke('read_source', {source_id: 'business-guide', version: '1'});
  await invoke('read_knowledge', {object_id: 'table-demo_order_detail'}, 'source_not_allowed');
  const diagnostic = await invoke('validate_sql', {sql: 'SELECT SUM(quantity) AS total FROM demo_order_detail',
    parameters: {}, target_id: 'synthetic-sqlite', knowledge_refs: [demoRef]});
  assert.ok(JSON.stringify(diagnostic.semantic_checks.coverage.missing_semantics ?? [])
    .includes('来源允许范围'), '只读诊断把范围外引用记为覆盖缺口');
  const before = await queriesOf(partial);
  await invoke('request_query', {task_id: partialTask.task_id,
    condition_version: await currentVersion(partialTask.task_id), sql: 'SELECT 2 AS ok',
    parameters: {}, target_id: 'synthetic-sqlite', summary: '范围外引用不应保存',
    knowledge_refs: [demoRef], replaces_query_id: null}, 'source_not_allowed');
  assert.deepEqual(await queriesOf(partial), before, '正式草稿对范围外引用硬拒绝，不创建草稿');
  checks.push('部分允许不放行传递根；诊断记缺口、草稿保存硬拒绝');
  await finish();

  // 三、文档限制与解除：允许文档自身可读，显式unset解除后恢复。
  const docA = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'document',
    name: '限制文档A', body: '文档A正文', related_ids: []}));
  const docB = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'document',
    name: '范围外文档B', body: '文档B正文', related_ids: []}));
  const docCid = await h.create();
  await begin(docCid, '只用文档A回答。');
  const docTask = await createTask('只用文档A的统计');
  await declareLimits(docTask.task_id, [{kind: 'document', id: docA.id}]);
  const own = await invoke('read_source', {source_id: `document-${docA.id}`, version: docA.version});
  assert.equal(own.body, '文档A正文', '允许文档自身原文可读');
  await invoke('read_source', {source_id: `document-${docB.id}`, version: docB.version},
    'source_not_allowed');
  assert.equal((await invoke('read_knowledge', {object_id: docA.id})).id, docA.id,
    '文档A作为允许来源整体可读');
  await invoke('read_knowledge', {object_id: 'table-demo_order_detail'}, 'source_not_allowed');
  const restricted = await invoke('search_knowledge', {query: '订单'});
  assert.ok(restricted.source_limits, '受限检索回执带source_limits块，与candidate_limit空结果可区分');
  assert.ok(!restricted.objects.some(object => object.id === 'table-demo_order_detail'));
  assert.ok(Number.isInteger(restricted.source_limits.filtered_candidates)
    && restricted.source_limits.filtered_candidates >= 1,
    '被过滤的demo表计入filtered_candidates，可区分于candidate_limit空结果');
  const liftVersion = await currentVersion(docTask.task_id);
  await invoke('update_analysis_task', {action: 'revise', task_id: docTask.task_id,
    expected_version: liftVersion, goal: '', condition_patch: {set: {}, unset: ['source_limits']},
    options: []});
  assert.equal((await invoke('read_knowledge', {object_id: 'table-demo_order_detail'})).id,
    'table-demo_order_detail', '显式unset后恢复读取');
  const open = await invoke('search_knowledge', {query: '订单'});
  assert.equal(open.source_limits, undefined, '解除限制后检索不再携带受限标记');
  assert.ok(open.objects.some(object => object.id === 'table-demo_order_detail'),
    '解除后同一检索重新命中demo表（过滤正对照）');
  checks.push('文档限制：允许文档自身可读、范围外拒读；显式unset解除后恢复');
  await finish();

  // 四、多任务歧义：一条消息绑定多个任务且任一声明限制时，受限读取要求先确定目标任务。
  const ambiguous = await h.create();
  await begin(ambiguous, '两个任务并行推进。');
  await createTask('无限制任务');
  const second = await createTask('受限任务');
  await declareLimits(second.task_id, [platform('business-guide')]);
  await invoke('read_knowledge', {object_id: 'table-demo_order_detail'}, 'task_context_required');
  checks.push('多任务限制归属未定时受限读取返回task_context_required，不取并集放行');
  await finish();

  // 五、无限制任务不设门：门只跟显式声明走。
  const free = await h.create();
  await begin(free, '自由调查，不限制来源。');
  await createTask('无限制的自由调查');
  assert.equal((await invoke('read_knowledge', {object_id: handwritten.id})).id, handwritten.id,
    '无限制任务手写内容照常可读');
  const assetPage = await invoke('read_knowledge', {object_id: `asset-${memory.id}`});
  assert.equal(String(assetPage.version), String(memory.version), '无限制任务个人记忆照常可读');
  const freeSearch = await invoke('search_knowledge', {query: '订单'});
  assert.equal(freeSearch.source_limits, undefined);
  assert.notEqual(freeSearch.memory_retrieval, 'excluded_by_source_limits');
  checks.push('未声明限制的任务不设门，共享知识、个人记忆与检索行为不变');
  await finish();

  // 六、草稿的门跟草稿所属任务走，不按消息绑定集：本消息只绑无限制任务时，
  // 为受限任务保存草稿仍按该任务限制硬拒/放行（不能借无限制消息绕过或误伤）。
  const cross = await h.create();
  await begin(cross, '建立全量允许的受限任务。');
  const limFull = await createTask('全量受限任务');
  await declareLimits(limFull.task_id,
    [platform('business-guide'), platform('schema'), platform('etl')]);
  await finish();
  await begin(cross, '建立部分允许的受限任务。');
  const limPartial = await createTask('部分受限任务');
  await declareLimits(limPartial.task_id, [platform('business-guide')]);
  await finish();
  await begin(cross, '本消息只做无限制的新调查。');
  const freeBound = await createTask('无限制绑定任务');
  const crossBefore = await queriesOf(cross);
  const crossSaved = await invoke('request_query', {task_id: limFull.task_id,
    condition_version: await currentVersion(limFull.task_id),
    sql: 'SELECT SUM(quantity) AS total FROM demo_order_detail', parameters: {},
    target_id: 'synthetic-sqlite', summary: '跨任务草稿按其所属任务的限制放行',
    knowledge_refs: [demoRef], replaces_query_id: null});
  assert.equal(crossSaved.execution_state, 'not_submitted', '消息未绑定受限任务不绕过其限制判定');
  await invoke('request_query', {task_id: limPartial.task_id,
    condition_version: await currentVersion(limPartial.task_id),
    sql: 'SELECT SUM(quantity) AS total FROM demo_order_detail', parameters: {},
    target_id: 'synthetic-sqlite', summary: '范围外引用不应保存', knowledge_refs: [demoRef],
    replaces_query_id: null}, 'source_not_allowed');
  const crossAfter = await queriesOf(cross);
  assert.equal(crossAfter.length, crossBefore.length + 1,
    '只保存了允许集内草稿，范围外草稿未创建');
  checks.push('request_query的门跟草稿所属任务的条件走：允许集内放行、范围外硬拒，不因消息绑定另一无限制任务而失效');

  const result = {passed: true, checks, officialRequests: 0};
  await writeFile('.local/checks/mvp-source-limits.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {await h.close();}

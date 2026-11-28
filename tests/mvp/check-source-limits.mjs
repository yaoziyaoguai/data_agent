import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {deliver} from '../../apps/agent/session/deliver.ts';
import {harness, until} from './harness.mjs';
import {assetInput, select as selectSkill} from './skill-fixtures.mjs';

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
const cancelRun = async cid => {
  ok(await h.request(`/conversations/${cid}/cancel-run`, {run_id:run.run_id, lease_epoch:run.lease_epoch}));
  h.releaseRun(run.run_id);
};
const demoRef = {object_id: 'table-demo_order_detail', version: '1', path: 'description'};
// 表说明原出处为业务指南；DDL原出处为schema，只允许业务指南时属范围外直属来源。
const ddlRef = {...demoRef, path: 'ddl'};
const conditions = {time_start: null, time_end: null, timezone: 'UTC', metric: null,
  channel: null, group_by: [], filters: [], knowledge_refs: [demoRef], notes: '', source_limits: null};
const platform = id => ({kind: 'platform', id});
const refOf = (object, path = 'body') => ({object_id: object.id, version: object.version, path});
const readItem = async (item, state = 'ok') => {
  const receipt = await invoke('read_knowledge', {items: [item]});
  const [value] = receipt.items;
  assert.equal(value.state, state, JSON.stringify(value));
  if (state !== 'ok') assert.deepEqual(value, {...item, state});
  return value;
};
const readTable = (state = 'ok') => readItem({kind: 'knowledge', ref: {...demoRef, path: 'ddl'}}, state);
const readMemory = (memory, state = 'ok') => readItem({
  kind: 'memory', asset_ref: {id: memory.id, version: memory.version}, part: 'body',
}, state);
const readSource = (source, revision, length, error) => invoke('read_source',
  {citation: {source, revision, locator: {offset: 0, length}}}, error);
const readGuide = () => readSource(platform('business-guide'), '1', 10);
const hasDemo = receipt => receipt.hits.some(hit =>
  hit.record_kind === 'knowledge_entry' && hit.ref.object_id === demoRef.object_id);

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
  const guide = await readGuide();
  assert.ok(typeof guide.text === 'string' && guide.text.length > 0, '允许的平台来源正文可读');
  assert.equal((await readTable()).ref.object_id,
    'table-demo_order_detail', '贡献根全部在允许集内的对象可读');
  await readItem({kind: 'knowledge', ref: refOf(handwritten)}, 'not_available');
  await readMemory(memory, 'not_available');
  // 用已知表名验证来源门，避免通用词的内容名额被其他对象多条目占用。
  const search = await invoke('search_knowledge', {query: 'demo_order_detail'});
  assert.deepEqual((await invoke('read_analysis_task', {task_id: fullTask.task_id})).conditions.source_limits.allowed_sources,
    [platform('business-guide'), platform('schema'), platform('etl')], '受限检索遵从宿主保存的允许集');
  assert.ok(hasDemo(search),
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
  // 旧映射状态不改变直接来源身份，原正文与实际底表仍通过正常读取。
  h.sql(`UPDATE knowledge_dependency_states SET mapping_state='unknown' WHERE owner_id='table-demo_order_detail'`);
  assert.equal((await readTable()).ref.object_id, demoRef.object_id);
  h.sql(`UPDATE knowledge_dependency_states SET mapping_state='complete' WHERE owner_id='table-demo_order_detail'`);
  assert.equal((await readTable()).ref.object_id,
    'table-demo_order_detail', '映射恢复完整后重新可读');
  checks.push('直接来源匹配允许读取和保存草稿；旧映射状态不会传染到范围判断');
  await finish();

  const directCid = await h.create();
  await begin(directCid, '只用数量字段本身的定义。');
  const directTask = await createTask('检查数量字段的正式结构');
  await declareLimits(directTask.task_id, [platform('field-quantity')]);
  const directInput = {run_id: run.run_id, lease_epoch: run.lease_epoch, sdk_tool_call_id: randomUUID(),
    tool_name: 'read_knowledge', checkpoint: checkpoint(), arguments: {items: [{kind: 'knowledge',
      ref: {object_id: 'field-quantity', version: '1', path: 'meaning'}, structure_only: true}]}};
  ok(await h.internal('/internal/data/tool-calls', directInput));
  const directReceipt = ok(await h.internal('/internal/data/tools', directInput));
  assert.equal(directReceipt.data.items[0].state, 'ok');
  assert.equal(directReceipt.data.items[0].structure_coverage.state, 'complete');
  assert.ok(directReceipt.data.items[0].structure_dependencies.some(ref => ref.object_id === demoRef.object_id));
  assert.deepEqual(ok(await h.internal('/internal/data/tools', directInput)).data, directReceipt.data);
  await readTable('not_available');
  checks.push('单个字段直接允许匹配，结构绑定可核并可按原回执重放，不能单独补读范围外底表');
  await finish();

  // 只允许业务指南时，表说明原出处即该指南可作草稿依据；DDL原出处为schema，才是范围外直属来源。
  const partial = await h.create();
  await begin(partial, '这次只用业务指南本身。');
  const partialTask = await createTask('只用业务指南的统计');
  await declareLimits(partialTask.task_id, [platform('business-guide')]);
  await readGuide();
  await readTable('not_available');
  const admitted = await invoke('request_query', {task_id: partialTask.task_id,
    condition_version: await currentVersion(partialTask.task_id), sql: 'SELECT 1 AS ok',
    parameters: {}, target_id: 'synthetic-sqlite', summary: '表说明引用属允许来源',
    knowledge_refs: [demoRef], replaces_query_id: null});
  assert.equal(admitted.execution_state, 'not_submitted', '表说明原出处为业务指南，允许集内引用可保存草稿');
  const diagnostic = await invoke('validate_sql', {sql: 'SELECT SUM(quantity) AS total FROM demo_order_detail',
    parameters: {}, target_id: 'synthetic-sqlite', knowledge_refs: [ddlRef]});
  assert.ok(JSON.stringify(diagnostic.semantic_checks.coverage.missing_semantics ?? [])
    .includes('来源允许范围'), '只读诊断把范围外引用记为覆盖缺口');
  const before = await queriesOf(partial);
  await invoke('request_query', {task_id: partialTask.task_id,
    condition_version: await currentVersion(partialTask.task_id), sql: 'SELECT 2 AS ok',
    parameters: {}, target_id: 'synthetic-sqlite', summary: '范围外引用不应保存',
    knowledge_refs: [ddlRef], replaces_query_id: null}, 'source_not_allowed');
  assert.deepEqual(await queriesOf(partial), before, '正式草稿对范围外引用硬拒绝，不创建草稿');
  checks.push('范围外直属来源不能交付；诊断记缺口、草稿保存拒绝');
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
  const own = await readSource({kind: 'document', id: docA.id}, docA.version, 5);
  assert.equal(own.text, '文档A正文', '允许文档自身原文可读');
  await readSource({kind: 'document', id: docB.id}, docB.version, 5, 'source_not_allowed');
  assert.equal((await readItem({kind: 'knowledge', ref: refOf(docA)})).ref.object_id, docA.id,
    '文档A作为允许来源整体可读');
  await readTable('not_available');
  const restricted = await invoke('search_knowledge', {query: '订单'});
  assert.ok(!hasDemo(restricted), '范围外表不进入可见检索候选');
  const liftVersion = await currentVersion(docTask.task_id);
  await invoke('update_analysis_task', {action: 'revise', task_id: docTask.task_id,
    expected_version: liftVersion, goal: '', condition_patch: {set: {}, unset: ['source_limits']},
    options: []});
  assert.equal((await readTable()).ref.object_id,
    'table-demo_order_detail', '显式unset后恢复读取');
  // 解除后用同一已知表名核对重新可召回；limit仍按内容计数。
  const open = await invoke('search_knowledge', {query: 'demo_order_detail'});
  assert.equal((await invoke('read_analysis_task', {task_id: docTask.task_id})).conditions.source_limits, null,
    '只有显式解除才清掉持久限制');
  assert.ok(hasDemo(open),
    '解除后检索重新命中demo表（过滤正对照）');
  checks.push('文档限制：允许文档自身可读、范围外拒读；显式unset解除后恢复');
  await finish();

  // 四、多任务一次派发只绑一个活动任务：创建/修订即显式指定工作目标，受限读取
  // 继承活动任务的限制（demo表根含schema/etl，不在指南允许集内），不取任务并集。
  // 迁移前无活动绑定的旧会话回退消息绑定集：归属未定仍拒绝，不并集放行。
  const ambiguous = await h.create();
  await begin(ambiguous, '两个任务并行推进。');
  await createTask('无限制任务');
  const second = await createTask('受限任务');
  await declareLimits(second.task_id, [platform('business-guide')]);
  await readTable('not_available');
  h.sql(`UPDATE conversations SET active_task_id=NULL,active_task_condition_version=NULL WHERE id='${ambiguous}'`);
  await invoke('read_knowledge', {items: [{kind: 'knowledge', ref: demoRef}]}, 'task_context_required');
  checks.push('多任务消息受限读取继承活动任务限制；旧会话无活动绑定时仍task_context_required，不并集放行');
  // 本反例停在两个任务均未交付的旧状态，不能以单段正文结清。
  await cancelRun(ambiguous);

  // 五、无限制任务不设门：门只跟显式声明走。
  const free = await h.create();
  await begin(free, '自由调查，不限制来源。');
  await createTask('无限制的自由调查');
  assert.equal((await readItem({kind: 'knowledge', ref: refOf(handwritten)})).ref.object_id, handwritten.id,
    '无限制任务手写内容照常可读');
  const assetPage = (await readMemory(memory)).asset;
  assert.equal(String(assetPage.version), String(memory.version), '无限制任务个人记忆照常可读');
  const freeSearch = await invoke('search_knowledge', {query: '订单'});
  assert.notEqual(freeSearch.memory_retrieval, 'excluded_by_source_limits');
  checks.push('未声明限制的任务不设门，共享知识、个人记忆与检索行为不变');
  await finish();

  // 六、草稿的门跟草稿所属任务走，不按消息绑定集：本消息只绑无限制任务时，
  // 为受限任务保存草稿仍按该任务限制硬拒/放行（不能借无限制消息绕过或误伤）。
  // 同一DDL引用在允许全部根的任务放行，在只允许业务指南的任务硬拒。
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
    knowledge_refs: [ddlRef], replaces_query_id: null});
  assert.equal(crossSaved.execution_state, 'not_submitted', '消息未绑定受限任务不绕过其限制判定');
  await invoke('request_query', {task_id: limPartial.task_id,
    condition_version: await currentVersion(limPartial.task_id),
    sql: 'SELECT SUM(quantity) AS total FROM demo_order_detail', parameters: {},
    target_id: 'synthetic-sqlite', summary: '范围外引用不应保存', knowledge_refs: [ddlRef],
    replaces_query_id: null}, 'source_not_allowed');
  const crossAfter = await queriesOf(cross);
  assert.equal(crossAfter.length, crossBefore.length + 1,
    '只保存了允许集内草稿，范围外草稿未创建');
  checks.push('request_query的门跟草稿所属任务的条件走：允许集内放行、范围外硬拒，不因消息绑定另一无限制任务而失效');
  await cancelRun(cross);

  // 七、缺task_ref继承真正活动任务：上一消息保存的活动限制跨消息生效，新输入
  // 不能绕过；新一轮工作区信封携带active_task_ref。
  const inheritCid = await h.create();
  await begin(inheritCid, '只用业务指南做统计。');
  const inheritTask = await createTask('受限统计');
  await declareLimits(inheritTask.task_id, [platform('business-guide')]);
  await finish();
  await begin(inheritCid, '继续刚才的统计。');
  await readTable('not_available');
  assert.ok((await readGuide()).text.length > 0,
    '继承活动任务后允许来源照常可读');
  assert.equal(run.workspace_context.active_task_ref.task_id, inheritTask.task_id,
    '工作区携带持久active_task_ref.task_id');
  assert.equal(run.workspace_context.active_task_ref.condition_version,
    await currentVersion(inheritTask.task_id), '工作区active_task_ref为当前条件版本');
  checks.push('缺task_ref的新消息继承真正活动任务，不绕过限制；工作区信封携带active_task_ref');
  await invoke('update_analysis_task', {action: 'route', task_id: null, expected_version: null,
    goal: '', question: null, options: []});
  await finish();

  // 八、同批跨任务读取不隐式切换或并集：显式route切换活动任务后按目标任务限制判定。
  const switchCid = await h.create();
  await begin(switchCid, '先全量调查，再切换到只允许业务指南的任务。');
  const guideTask = await createTask('只允许指南');
  await declareLimits(guideTask.task_id, [platform('business-guide')]);
  const switchFullTask = await createTask('允许全部根');
  await declareLimits(switchFullTask.task_id,
    [platform('business-guide'), platform('schema'), platform('etl')]);
  assert.equal((await readTable()).ref.object_id,
    'table-demo_order_detail', '活动任务=全量任务时demo表可读');
  await invoke('update_analysis_task', {action: 'route', task_id: guideTask.task_id,
    expected_version: await currentVersion(guideTask.task_id), goal: '', options: []});
  await readTable('not_available');
  assert.ok((await readGuide()).text.length > 0,
    '切换后新任务允许来源可读');
  checks.push('显式route切换活动任务后按目标任务限制判定，不隐式并集放行');
  await cancelRun(switchCid);

  // 九、取消单任务只清自身活动绑定，不改变其他任务条件与读取归属。
  const cancelCid = await h.create();
  await begin(cancelCid, '先建自由任务再建受限任务。');
  const freeTask = await createTask('自由任务');
  const limitedTask = await createTask('受限任务');
  await declareLimits(limitedTask.task_id, [platform('business-guide')]);
  await readTable('not_available');
  await cancelRun(cancelCid);
  const limitedState = (await h.snapshot(cancelCid)).tasks.find(t => t.id === limitedTask.task_id);
  assert.equal((await h.request(`/conversations/${cancelCid}/tasks/${limitedTask.task_id}/cancel`,
    {operation_id: randomUUID(), expected_version: limitedState.condition_version})).status, 200,
    '取消受限活动任务');
  await begin(cancelCid, '继续自由任务。');
  assert.equal(run.workspace_context.active_task_ref, null, '取消后活动绑定清除');
  assert.equal((await readTable()).ref.object_id,
    'table-demo_order_detail', '取消受限活动任务后不残留其读取范围');
  const freeState = (await h.snapshot(cancelCid)).tasks.find(t => t.id === freeTask.task_id);
  assert.equal(freeState.lifecycle, 'active', '其他任务不受取消影响');
  checks.push('取消单任务只清自身活动绑定，不改变其他任务条件与读取归属');
  await invoke('update_analysis_task', {action: 'route', task_id: null, expected_version: null,
    goal: '', question: null, options: []});
  await finish();

  // 捕获式夹具不执行Node/Pi重投影，故直接验证旧投影不得派发。
  // 同消息的普通/摘要安全续接与中断恢复由check-task-projection实际驱动Pi验证。
  const tightenCid = await h.create();
  await begin(tightenCid, '先全量调查再收紧到只用业务指南。');
  const tightenTask = await createTask('先全量调查');
  await declareLimits(tightenTask.task_id,
    [platform('business-guide'), platform('schema'), platform('etl')]);
  assert.equal((await readTable()).ref.object_id,
    'table-demo_order_detail', '收紧前全量可读');
  const issue = () => h.internal('/internal/model/issue',
    {run_id: run.run_id, lease_epoch: run.lease_epoch, call_attempt_id: randomUUID()});
  assert.equal((await issue()).status, 200, '许可登记与下一轮的上下文选择独立');
  const failCurrentRun = async cid => {
    h.releaseRun(run.run_id);
    await h.pauseWorker();
    h.sql(`UPDATE agent_runs SET state='failed' WHERE id='${run.run_id}'`);
    h.sql(`UPDATE conversations SET lease_owner=NULL,lease_until=NULL WHERE id='${cid}'`);
    h.sql(`UPDATE background_jobs SET state='failed' WHERE message_id='${run.message_id}' AND state<>'failed'`);
    h.sql(`UPDATE conversation_messages SET disposition='failed' WHERE id='${run.message_id}'`);
  };
  await failCurrentRun(tightenCid);
  await begin(tightenCid, '继续用业务指南、schema和etl。');
  assert.equal(run.checkpoint, null, '新输入按活动限制重投影，不复用越界检查点');
  assert.equal((await readTable()).ref.object_id,
    'table-demo_order_detail', '带限制启动的运行里允许集内对象可读');
  const probe = await issue();
  assert.equal(probe.status, 200,
    '启动时已带限制（预览清空）且读取都在允许集内时不拦截正常派发');
  await declareLimits(tightenTask.task_id, [platform('business-guide')]);
  await readTable('not_available');
  // 这里只释放未执行Pi刷新过程的捕获运行，不能据此要求正常用户消息终止。
  await failCurrentRun(tightenCid);
  await begin(tightenCid, '继续只用业务指南。');
  assert.equal((await issue()).status, 200, '重投影后的派发恢复');
  await invoke('update_analysis_task', {action: 'route', task_id: null, expected_version: null,
    goal: '', question: null, options: []});
  await finish();
  checks.push('收紧后从有效范围读取；新消息从新范围正常派发');

  // 旧草稿与个人预览退出收紧后的投影。
  const residualCid = await h.create();
  await begin(residualCid, '先读旧草稿正文再收紧到只用业务指南。');
  const residualTask = await createTask('先自由读取');
  const residualDraft = await invoke('request_query', {task_id: residualTask.task_id,
    condition_version: await currentVersion(residualTask.task_id),
    sql: 'SELECT 3 AS ok', parameters: {}, target_id: 'synthetic-sqlite',
    summary: '收紧前保存的说明草稿', knowledge_refs: [demoRef], replaces_query_id: null});
  const oldBody = await invoke('get_query', {query_id: residualDraft.id});
  assert.ok(oldBody.query.sql.includes('3 AS ok'), '收紧前旧草稿正文可读');
  const residualIssue = () => h.internal('/internal/model/issue',
    {run_id: run.run_id, lease_epoch: run.lease_epoch, call_attempt_id: randomUUID()});
  assert.equal((await residualIssue()).status, 200, '未收紧时旧正文不拦截派发');
  await declareLimits(residualTask.task_id, [platform('business-guide')]);
  assert.equal((await residualIssue()).status, 200);
  await failCurrentRun(residualCid);
  await begin(residualCid, '继续只用业务指南。');
  assert.equal((await residualIssue()).status, 200, '重投影后派发恢复');
  await invoke('update_analysis_task', {action: 'route', task_id: null, expected_version: null,
    goal: '', question: null, options: []});
  await finish();
  const previewCid = await h.create();
  await begin(previewCid, '不做任何受限读取，只收紧来源。');
  const previewTask = await createTask('只有启动预览');
  await declareLimits(previewTask.task_id, [platform('business-guide')]);
  await readMemory(memory, 'not_available');
  await failCurrentRun(previewCid);
  checks.push('范围变化不冻结后续派发；范围外个人记忆的读取正文不可用');

  // 十一b、（04关闭第三轮审查修复）read（Skill文件）读取门回归锁：受限任务下
  // 个人Skill贡献根不可核验（fail-closed），读取点按source_not_allowed硬拒，
  // 拒读不写入skills桶、派发照常——把read移出门解析列表本断言即红。
  const skillCid = await h.create();
  const skillAsset = ok(await h.request('/assets',
    assetInput({name: '合成统计口径', scope: '来源限制验收', body: '按指南口径统计。'})));
  ok(await selectSkill(h, skillCid, skillAsset));
  await begin(skillCid, '已选技能，先自由读取。');
  const skillTask = await createTask('带技能的统计');
  const freeRead = await invoke('read',
    {path: `/skills/${skillAsset.id}/${skillAsset.version}/SKILL.md`});
  assert.ok(String(freeRead.text).includes('按指南口径统计'), '未受限时Skill正文可读');
  await declareLimits(skillTask.task_id, [platform('business-guide')]);
  await failCurrentRun(skillCid);
  await begin(skillCid, '继续只用业务指南。');
  await invoke('read',
    {path: `/skills/${skillAsset.id}/${skillAsset.version}/SKILL.md`}, 'source_not_allowed');
  assert.equal((await h.internal('/internal/model/issue',
    {run_id: run.run_id, lease_epoch: run.lease_epoch, call_attempt_id: randomUUID()})).status,
    200, '受限拒读Skill不残留桶内容，派发照常');
  await invoke('update_analysis_task', {action: 'route', task_id: null, expected_version: null,
    goal: '', question: null, options: []});
  await finish();
  checks.push('read（Skill文件）纳入来源门：受限任务读取点source_not_allowed硬拒且不残留，未受限照常可读');

  // 十二、（04关闭审查修复）晚到查询完成不在后台改写会话活动任务：绑定发生在
  // 结果输入自己的交付事务，受限任务运行中的读取范围不被完成时刻切换。
  const lateCid = await h.create();
  await begin(lateCid, '先在自由任务确认一条查询。');
  const lateFreeTask = await createTask('自由查询任务');
  const lateDraft = await invoke('request_query', {task_id: lateFreeTask.task_id,
    condition_version: await currentVersion(lateFreeTask.task_id),
    sql: 'SELECT 4 AS ok', parameters: {}, target_id: 'synthetic-sqlite',
    summary: '晚到完成核验查询', knowledge_refs: [demoRef], replaces_query_id: null});
  await finish();
  ok(await h.request(`/queries/${lateDraft.id}/confirm`, {operation_id: randomUUID(),
    draft_version: lateDraft.draft_version, condition_version: lateDraft.condition_version}));
  await begin(lateCid, '受限任务进行中，等待旧查询完成。');
  const lateLimitedTask = await createTask('受限等待任务');
  await declareLimits(lateLimitedTask.task_id, [platform('business-guide')]);
  await readTable('not_available');
  // 执行旧查询：完成事务在受限运行之外提交（worker轮询），通知轮排在当前运行
  // 之后，此刻活动任务若被完成时刻改写，越界读取就会放行。
  await h.resumeWorker();
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    if ((await ok(await h.request(`/queries/${lateDraft.id}`))).execution_state === 'succeeded') break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.equal((await ok(await h.request(`/queries/${lateDraft.id}`))).execution_state,
    'succeeded', '晚到查询在受限运行之外完成');
  await h.pauseWorker();
  await readTable('not_available');
  checks.push('晚到查询完成不切换会话活动任务：受限运行中的读取范围保持，结果输入交付时才按其所属任务归属');
  await finish();

  // 十三、非法set.source_limits:null经真实Pi参数处理得到明确拒绝：Pi的
  // normalizeOptionalNulls会把它静默删成空改；拒绝不登记工具调用、不改
  // notes/condition_version，错误回执带回下一请求供模型纠正。
  const nullCall = 'illegal-null-source-limits';
  let piCalls = 0, rejectionSeen = '';
  let piTask;
  const piProvider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    let delta;
    if (!body.tools?.length) {
      delta = {content: '保持原任务范围继续。'};
    } else if (piCalls++ === 0) {
      delta = {tool_calls: [{index: 0, id: nullCall, type: 'function', function: {name: 'update_analysis_task',
        arguments: JSON.stringify({action: 'revise', task_id: piTask.task_id,
          expected_version: piTask.condition_version, goal: '', options: [],
          condition_patch: {set: {source_limits: null}, unset: []}})}}]};
    } else {
      rejectionSeen = raw;
      delta = {content: '收到明确拒绝，按原范围继续完成。'};
    }
    delta.role = 'assistant';
    res.writeHead(200, {'content-type': 'text/event-stream'});
    res.write('data: ' + JSON.stringify({id: 'synthetic', choices: [{index: 0, delta,
      finish_reason: delta.tool_calls ? 'tool_calls' : 'stop'}]}) + '\n\n');
    res.write('data: ' + JSON.stringify({id: 'synthetic', choices: [],
      usage: {prompt_tokens: 1000, completion_tokens: 50}}) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => piProvider.listen(0, '127.0.0.1', resolve));
  const piUrl = 'http://127.0.0.1:' + piProvider.address().port;
  const previousPi = Object.fromEntries(['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DATA_AGENT_PROVIDER_TEST']
    .map(key => [key, process.env[key]]));
  Object.assign(process.env, {DEEPSEEK_API_KEY: 'synthetic-protocol-key', DEEPSEEK_BASE_URL: piUrl,
    DATA_AGENT_PROVIDER_TEST: '1'});
  const piProfile = {provider_id: 'deepseek', model_id: 'deepseek-flash', trial_id: randomUUID(),
    price_version: '2026-10-04-peak-usd', input_limit: 65536, output_limit: 2048,
    trial_call_limit: 100, trial_cost_micros: '300000', request_call_limit: 24,
    toolset: 'data', payload_bytes_limit: 131072};
  const h2 = await harness({capture: true, profile: piProfile, protocolProviderUrl: piUrl,
    env: {DATA_AGENT_LEASE_MS: '120000', DATA_AGENT_TOOL_CONTRACT_VERSION: '2'}});
  try {
    const piCid = await h2.create();
    await h2.resumeWorker();
    const piRun = await h2.capture(piCid, '请继续核对来源限制。');
    await h2.pauseWorker();
    assert.equal(piRun.tool_contract_version, 2);
    const piManager = SessionManager.inMemory('/synthetic/data-agent');
    const piInvoke = async (name, args) => {
      const input = {run_id: piRun.run_id, lease_epoch: piRun.lease_epoch, sdk_tool_call_id: randomUUID(),
        tool_name: name, arguments: args, checkpoint: exportCheckpoint(piManager)};
      ok(await h2.internal('/internal/data/tool-calls', input));
      return ok(await h2.internal('/internal/data/tools', input)).data;
    };
    piTask = await piInvoke('update_analysis_task', {action: 'create', goal: '来源限制参数核验',
      options: [], conditions: {time_start: null, time_end: null, timezone: 'UTC', metric: null,
        channel: null, group_by: [], filters: [], knowledge_refs: [], notes: '', source_limits: null}});
    // v2下非归属工具需消息已route；对照直接读条件表，不经工具门。
    const taskState = () => h2.sql(`SELECT JSON_OBJECT('version',t.condition_version,
      'notes',JSON_UNQUOTE(JSON_EXTRACT(c.body,'$.notes'))) FROM analysis_tasks t
      LEFT JOIN condition_revisions c ON t.id=c.task_id AND t.condition_version=c.version
      WHERE t.id='${piTask.task_id}'`)[0];
    const before = taskState();
    try { await deliver(piRun, h2.env.DATA_AGENT_API_URL, h2.env.DATA_AGENT_INTERNAL_TOKEN, ''); }
    finally { h2.releaseRun(piRun.run_id); }
    assert.ok(rejectionSeen.includes(nullCall), '非法调用后必须还有一次携带其回执的请求');
    assert.match(rejectionSeen, /source_limits/, '非法null必须以提及source_limits的明确错误回执返回模型');
    assert.match(rejectionSeen, /unset/, '错误回执指引改用unset撤销来源限制');
    assert.equal(h2.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM tool_calls WHERE sdk_tool_call_id='${nullCall}'`)[0].n, 0,
      '参数处理阶段拒绝的工具调用不登记、不执行');
    const after = taskState();
    assert.equal(after.version, before.version, '非法null不改条件版本');
    assert.equal(after.notes, before.notes, '非法null不改notes');
    assert.equal(h2.sql(`SELECT JSON_OBJECT('state',state) FROM agent_runs WHERE id='${piRun.run_id}'`)[0].state,
      'finished', '拒绝后运行沿原消息正常完成');
    checks.push('非法set.source_limits:null经真实Pi参数处理明确拒绝：不登记不执行、notes/condition_version不变、错误回执指引unset');
  } finally {
    for (const [key, value] of Object.entries(previousPi)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await h2.close();
    await new Promise(resolve => piProvider.close(resolve));
  }

  // 十四、表级来源门贯通SQL草稿、执行结果与答案绑定；越界底表（含漏填knowledge_refs）
  // 在草稿与结果读取双端拦截，且未声明source_limits时recovery.task如实暴露source_limits_declared=false。
  const tableGateCid = await h.create();
  await begin(tableGateCid, '先建未声明来源范围的任务核对恢复信息，再切换表级限源核对SQL与结果。');
  const {source_limits: _omittedLimits, ...omittedConditions} = conditions;
  const omittedTask = await invoke('update_analysis_task',
    {action: 'create', goal: '未声明来源范围的任务', conditions: omittedConditions, options: []});
  const missingScopeRejection = await invoke('search_knowledge', {query: 'demo_order_detail'}, 'task_context_required');
  assert.equal(missingScopeRejection.recovery?.task?.task_id, omittedTask.task_id);
  assert.equal(missingScopeRejection.recovery?.task?.source_limits_declared, false,
    '未声明source_limits时recovery.task明确返回source_limits_declared=false');
  await invoke('update_analysis_task', {action: 'revise', task_id: omittedTask.task_id,
    expected_version: omittedTask.condition_version, goal: '',
    condition_patch: {set: {}, unset: ['source_limits']}, options: []});
  const outsideExecuted = await invoke('request_query', {task_id: omittedTask.task_id,
    condition_version: await currentVersion(omittedTask.task_id),
    sql: 'SELECT COUNT(*) AS customer_cnt FROM dim_customers', parameters: {},
    target_id: 'synthetic-sqlite', summary: '自由任务下查询客户维表',
    knowledge_refs: [], replaces_query_id: null});
  await finish();
  ok(await h.request(`/queries/${outsideExecuted.id}/confirm`, {operation_id: randomUUID(),
    draft_version: outsideExecuted.draft_version, condition_version: outsideExecuted.condition_version}));
  const seenNotifications = new Set(h.captured.map(value => value.message_id));
  await h.resumeWorker();
  const outsideNotified = await until(async () => h.captured
    .find(value => value.conversation_id === tableGateCid && !seenNotifications.has(value.message_id)),
    'outside query result notification', 40000);
  await h.pauseWorker();
  seenNotifications.add(outsideNotified.message_id);
  run = outsideNotified;
  manager = SessionManager.inMemory('/synthetic/data-agent');
  await finish();
  await begin(tableGateCid, '只允许使用demo_order_detail表查订单数量，不允许读dim_customers或其他表。');
  const tableOnlyTask = await invoke('update_analysis_task', {action: 'create',
    goal: '只查demo_order_detail表', options: [],
    conditions: {...conditions, knowledge_refs: [], source_limits: {
      allowed_sources: [platform('table-demo_order_detail')], origin_message_ids: []}}});
  const registeredTableGate = await invoke('read_analysis_task', {task_id: tableOnlyTask.task_id});
  assert.deepEqual(registeredTableGate.conditions?.source_limits, {
    allowed_sources: [platform('table-demo_order_detail')],
    origin_message_ids: [run.message_id],
  }, '任务条件明确持久化非空source_limits并由宿主绑定origin_message_ids');
  const blockedReadKnowledge = await invoke('read_knowledge', {
    items: [{kind: 'knowledge', ref: {object_id: 'table-dim_customers', path: 'ddl', version: '1'}}],
  });
  assert.equal(blockedReadKnowledge.items?.[0]?.state, 'not_available',
    '范围外表的知识条目在表级来源门下不可交付');
  await invoke('request_query', {task_id: tableOnlyTask.task_id,
    condition_version: tableOnlyTask.condition_version,
    sql: 'SELECT d.order_id FROM demo_order_detail d JOIN dim_customers c ON d.customer_id = c.customer_id',
    parameters: {}, target_id: 'synthetic-sqlite', summary: '漏填knowledge_refs但越界关联dim_customers',
    knowledge_refs: [], replaces_query_id: null}, 'source_not_allowed');
  await invoke('get_query', {query_id: outsideExecuted.id}, 'source_not_allowed');
  const allowedTableQuery = await invoke('request_query', {task_id: tableOnlyTask.task_id,
    condition_version: tableOnlyTask.condition_version,
    sql: 'SELECT SUM(quantity) AS total_qty FROM demo_order_detail',
    parameters: {}, target_id: 'synthetic-sqlite', summary: '仅查允许表demo_order_detail',
    knowledge_refs: [], replaces_query_id: null});
  seenNotifications.add(run.message_id);
  await finish();
  ok(await h.request(`/queries/${allowedTableQuery.id}/confirm`, {operation_id: randomUUID(),
    draft_version: allowedTableQuery.draft_version, condition_version: allowedTableQuery.condition_version}));
  await h.resumeWorker();
  const allowedNotified = await until(async () => h.captured
    .find(value => value.conversation_id === tableGateCid && !seenNotifications.has(value.message_id)),
    'allowed table query result notification', 40000);
  await h.pauseWorker();
  run = allowedNotified;
  manager = SessionManager.inMemory('/synthetic/data-agent');
  const allowedResult = await invoke('get_query', {query_id: allowedTableQuery.id, view: 'rows'});
  assert.ok(allowedResult.results, '表级允许集内查询结果无需synthetic-sqlite整库键即可在结果通知轮读取');
  const preparedUnderGate = await invoke('prepare_analysis_answer', {
    sources: [{query_id: allowedTableQuery.id, result_ref: allowedResult.query.result_ref,
      columns: ['total_qty']}],
    values: [{name: 'total_qty', query_id: allowedTableQuery.id, kind: 'cell',
      row_index: 0, column: 'total_qty'}],
  });
  assert.deepEqual(Object.keys(preparedUnderGate.bindings), ['total_qty']);
  await finish();
  checks.push('表级来源门贯通草稿、结果通知轮读取与答案绑定：越界SQL与结果硬拒，允许表查询结果与prepare_analysis_answer正常通过');

  const result = {passed: true, checks, officialRequests: 0};
  await writeFile('.local/checks/mvp-source-limits.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {await h.close();}

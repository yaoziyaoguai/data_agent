import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {homedir} from 'node:os';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness, until} from './harness.mjs';

const h = await harness({capture: true, env: {DATA_AGENT_LEASE_MS: '120000'}});
const measureHealthy = process.argv.includes('--measure-healthy-preparation');
const measurePreparation = measureHealthy || process.argv.includes('--measure-preparation');
const order = 'table-demo_order_detail';
const payment = 'table-raw_payments';
const request = (path, user) => h.request(path, undefined, user);
const ok = result => {
  assert.equal(result.status, 200, JSON.stringify(result.value));
  return result.value;
};
const platform = (path, body) => fetch(h.env.DATA_AGENT_PLATFORM_URL + path, {
  method: 'POST',
  headers: {authorization: 'Bearer ' + h.env.DATA_AGENT_INTERNAL_TOKEN, 'content-type': 'application/json'},
  body: JSON.stringify(body),
});
const setRights = async table_readers => {
  const result = await platform('/permissions', {space_id: 'demo', denied_query_users: [], table_readers});
  assert.equal(result.status, 200, await result.text());
};
try {
  const original = ok(await request('/knowledge/'+order, 'bob'));
  ok(await request('/knowledge/'+payment, 'alice'));
  const independent = ok(await h.request('/knowledge', {
    operation_id: randomUUID(), kind: 'document', name: '可共享的独立运维约定', body: '交班时登记告警复核情况。',
    related_ids: [order],
  }));
  const field = ok(await request('/knowledge/field-paid_at', 'alice'));
  const metric = ok(await request('/knowledge/metric-net_revenue', 'alice'));
  const ref = object => ({object_id: object.id, version: object.version, path: object.entries[0].path});
  const createExample = async (name, sql, dependencies, computed_metrics) => ok(await h.request('/knowledge', {
    operation_id: randomUUID(), kind: 'query_example', name, body: sql, related_ids: [],
    structured_value: {kind: 'query_example', applicable_question: name, sql, grain: '单条汇总行',
      parameters: [], dependencies, computed_metrics, verification: null},
  }));
  const fieldExample = await createExample('按已支付时间计数',
    'SELECT COUNT(paid_at) FROM demo_order_detail', [ref(field)], []);
  const metricExample = await createExample('汇总支付归属净收入',
    'SELECT SUM(paid_amount_cents - refunded_amount_cents) AS net_revenue FROM demo_order_detail WHERE is_test = 0 AND paid_amount_cents > 0',
    [ref(independent)], [{metric_ref: ref(metric), output_name: 'net_revenue', expression: 'SUM(paid_amount_cents - refunded_amount_cents)'}]);

  await setRights({alice: ['raw_payments'], bob: ['demo_order_detail']});
  ok(await request('/knowledge/'+order, 'bob'));
  ok(await request('/knowledge/'+payment, 'alice'));
  for (const example of [fieldExample, metricExample]) {
    ok(await request('/knowledge/'+example.id, 'bob'));
  }
  const restricted = [order, field.id, metric.id, 'relationship-tags', fieldExample.id, metricExample.id];
  for (const id of restricted) {
    assert.equal((await request('/knowledge/'+id, 'alice')).status, 404, id);
  }
  assert.equal((await request('/knowledge/'+payment, 'bob')).status, 404);
  const grouped = ok(await request('/knowledge?directory=all&directory_view=grouped', 'alice'));
  assert.ok(grouped.objects.some(object => object.id === payment));
  assert.ok(grouped.objects.every(object => object.id !== order));
  const filtered = ok(await request('/knowledge?q=demo_order_detail', 'alice'));
  assert.ok(filtered.objects.every(object => !restricted.includes(object.id)));
  ok(await request('/knowledge/'+independent.id, 'alice'));
  assert.equal((await request('/sources/schema', 'bob')).status, 404);
  const unknown = await platform('/catalog-access', {space_id: 'demo', user_id: 'other-space-user'});
  assert.equal((await unknown.json()).code, 'forbidden');

  let manager = SessionManager.inMemory('/synthetic/data-agent');
  let preparation;
  const start = async (text, cid, measure) => {
    cid ??= await h.create('bob');
    const message = await h.send(cid, text, 'bob');
    let run;
    if (measure) {
      // 同库同平台，用独占连接执行生产 start_delivery，排除无关 Worker 轮询。
      const result = spawnSync(homedir()+'/.cargo/bin/cargo', [
        'test','--offline','--locked','-p','data-agent','--test','delivery_reads',
        '--','--ignored','--nocapture',
      ], {env:{...h.env,DATA_AGENT_EXPECTED_MESSAGE:message.message_id,DATA_AGENT_EXPECTED_CHECKPOINT:measure},encoding:'utf8',timeout:180000});
      const proof = result.stdout?.split('\n').find(line=>line.startsWith('DELIVERY_READS='));
      if (proof) {
        ({envelope:run,...preparation}=JSON.parse(proof.slice('DELIVERY_READS='.length)));
        console.log(JSON.stringify({measure:'mysql-session-status',...preparation}));
      }
      assert.ifError(result.error);
      assert.equal(result.status,0,result.stderr+'\n'+result.stdout?.split('\n').filter(line=>!line.startsWith('DELIVERY_READS=')).join('\n'));
    } else {
      await h.resumeWorker();
      run = await until(() => h.captured.find(run => run.message_id === message.message_id), 'model run');
      await h.pauseWorker();
    }
    manager.appendMessage({role: 'user', content: text, timestamp: Date.now()});
    return run;
  };
  const identity = run => ({run_id: run.run_id, lease_epoch: run.lease_epoch});
  const checkpoint = run => exportCheckpoint(manager, run.workspace_context.authority_revision, run.workspace_context.authority_snapshot);
  let run = await start('统计订单明细行数。');
  const call = async (tool_name, args) => {
    const input = {...identity(run), sdk_tool_call_id: randomUUID(), tool_name, arguments: args,
      checkpoint: checkpoint(run)};
    ok(await h.internal('/internal/data/tool-calls', input));
    return {input, response: await h.internal('/internal/data/tools', input)};
  };
  const createTask = async goal => ok((await call('update_analysis_task', {
    action: 'create', task_id: null, expected_version: null, goal,
    conditions: {time_start: null, time_end: null, timezone: 'UTC', metric: null, channel: null,
      group_by: [], filters: [], knowledge_refs: [], notes: '', source_limits: null}, question: null, options: [],
  })).response).data;
  const draft = async (task, sql, summary, knowledge_refs = []) => ok((await call('request_query', {
    task_id: task.task_id, condition_version: task.condition_version, sql,
    target_id: 'synthetic-sqlite', replaces_query_id: null, summary, parameters: {}, knowledge_refs,
  })).response).data;
  const finish = async text => {
    ok(await h.internal('/internal/outputs', {...identity(run), chunk_seq: '1', text}));
    ok(await h.internal('/internal/finish', {...identity(run), commit_id: run.output_id,
      final_text: text, checkpoint: checkpoint(run)}));
    h.releaseRun(run.run_id);
  };
  const confirm = (draft, operation = randomUUID()) => h.request('/queries/'+draft.id+'/confirm', {
    operation_id: operation, draft_version: draft.draft_version, condition_version: draft.condition_version,
  }, 'bob');
  const task = await createTask('统计订单明细行数');
  const query = await draft(task, 'SELECT COUNT(*) AS total FROM demo_order_detail', '合成订单明细行数');
  const referenced = await draft(task, 'SELECT COUNT(*) AS total FROM demo_order_detail',
    '按已核表结构统计行数', [ref(original)]);
  await finish('查询草稿已保存。');
  const originalConfirmation = randomUUID();
  ok(await confirm(query, originalConfirmation));
  ok(await confirm(referenced));
  await h.resumeWorker();
  await until(async () => (await request('/queries/'+query.id, 'bob')).value.execution_state === 'succeeded', 'saved result');
  await until(async () => (await request('/queries/'+referenced.id, 'bob')).value.execution_state === 'succeeded', 'saved result with semantic references');
  const results = '/queries/'+query.id+'/results';
  assert.ok(ok(await request(results, 'bob')).rows.length > 0);
  assert.equal((await request(results, 'alice')).status, 404);
  const referencedPaths = ["results", "export.csv"].map(path => '/queries/'+referenced.id+'/'+path);
  for (const path of referencedPaths) {
    const allowed = await fetch(h.env.DATA_AGENT_API_URL + path, {
      headers: {authorization: "Bearer " + h.tokens.bob},
    });
    assert.equal(allowed.status, 200, path);
    assert.ok((await allowed.text()).length > 0);
    assert.equal((await request(path, 'alice')).status, 404, path);
  }

  manager = SessionManager.inMemory('/synthetic/data-agent');
  const conversation = await h.create('bob');
  const literal = value => "'"+String(value).replaceAll("'", "''")+"'";
  const extraMemoryIds = Array.from({length:10},(_, i)=>`delivery-extra-memory-${i}`);
  const seed = (ids, kind, dependency) => {
    const rows = ids.map((id, i) => {
      const body = {id,kind,name:'合成工作区资料 '+i,version:'1',state:'enabled',scope:'支付合成测试',
        body:'仅用于工作区准备测试。',files:[],source_text:'测试夹具',verified:true,selected:false,dependencies:[dependency]};
      return `(${literal(id)},'bob','demo',1,${literal(kind)},'enabled',CAST(${literal(JSON.stringify(body))} AS JSON))`;
    });
    h.sql('INSERT INTO personal_assets(id,owner_id,space_id,version,kind,state,body) VALUES '+rows.join(','));
  };
  if (measurePreparation) {
    await setRights({alice:['raw_payments'],bob:['demo_order_detail','raw_payments']});
    const dependency = ref(ok(await request('/knowledge/'+payment, 'bob')));
    const evidence = Array.from({length:10},(_, i)=>`delivery-memory-${i}`);
    const methods = Array.from({length:5},(_, i)=>`delivery-skill-${i}`);
    seed(evidence, 'memory', dependency);
    seed(methods, 'skill', dependency);
    h.sql(`INSERT INTO skill_selections(id,owner_id,conversation_id,asset_id,asset_version)
      SELECT id,owner_id,${literal(conversation)},id,version FROM personal_assets WHERE id IN (${methods.map(literal).join(',')})`);
  }
  run = await start('核对订单表的结构。', conversation);
  const orderTask = await createTask('核对订单表结构');
  const orderDraft = await draft(orderTask, 'SELECT COUNT(*) FROM demo_order_detail', '待确认的旧表查询');
  const selection = {items: [{kind: 'knowledge', ref: {object_id: order, version: original.version, path: 'ddl'}}]};
  const first = await call('read_knowledge', selection);
  assert.equal(ok(first.response).data.items[0].state, 'ok');
  await setRights({alice: ['raw_payments'], bob: ['raw_payments']});
  const replay = await h.internal('/internal/data/tools', first.input);
  const denied = replay.value.data?.items?.[0];
  assert.ok(replay.status >= 400 || denied?.state === 'not_available', JSON.stringify(replay.value));
  await setRights({alice: ['raw_payments'], bob: ['demo_order_detail']});
  // 写入含有旧来源正文的原生 Pi 历史，再验证下一条消息不会把它发给模型。
  manager.appendMessage({role: 'assistant', content: [{type: 'toolCall', id: first.input.sdk_tool_call_id,
    name: 'read_knowledge', arguments: selection}], api: 'openai-completions', provider: 'synthetic',
    model: 'catalog-access', stopReason: 'toolUse', timestamp: Date.now(),
    usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}});
  manager.appendMessage({role: 'toolResult', toolCallId: first.input.sdk_tool_call_id, toolName: 'read_knowledge',
    content: [{type: 'text', text: JSON.stringify(first.response.value.data)}], isError: false, timestamp: Date.now()});
  await finish('已核对订单表结构。');

  await setRights({alice: ['raw_payments'], bob: ['raw_payments']});
  assert.equal((await request(results, 'bob')).status, 403);
  for (const path of referencedPaths) {
    const denied = await request(path, 'bob');
    assert.equal(denied.status, 403, JSON.stringify(denied.value));
    assert.equal(denied.value.code, 'forbidden');
    assert.equal((await request(path, 'alice')).status, 404, path);
  }
  const rejected = await confirm(orderDraft);
  assert.equal(rejected.status, 403, JSON.stringify(rejected.value));
  assert.equal(rejected.value.code, 'forbidden');
  const confirmation = qid => h.sql(`SELECT JSON_OBJECT('state',confirmation_state,'execution',execution_state,
    'operation',confirmation_key) FROM query_requests WHERE id='${qid}'`)[0];
  assert.deepEqual(confirmation(orderDraft.id), {state:'awaiting_confirmation',execution:'not_submitted',operation:null});
  const replayedConfirmation = ok(await confirm(query, originalConfirmation));
  assert.equal(replayedConfirmation.execution_state, 'succeeded');
  assert.deepEqual(confirmation(query.id), {state:'confirmed',execution:'succeeded',operation:originalConfirmation});
  assert.equal((await request('/knowledge/'+order, 'bob')).status, 404);
  ok(await request('/knowledge/'+independent.id, 'bob'));

  if (measureHealthy) {
    await setRights({alice:['raw_payments'],bob:['demo_order_detail','raw_payments']});
    let baseline;
    for (const memories of [10,20]) {
      if (memories === 20) seed(extraMemoryIds, 'memory', ref(ok(await request('/knowledge/'+payment, 'bob'))));
      manager = SessionManager.inMemory('/synthetic/data-agent');
      run = await start('沿原检查点继续核对订单表。',conversation,'readable');
      assert.ok(run.checkpoint,'仍可读的旧知识必须继续复用原检查点');
      assert.equal(run.checkpoint.authority_snapshot.memories.length,10,'两次复用同一旧检查点');
      assert.equal(run.checkpoint.authority_snapshot.skills.length,5,'读取真实选用的历史 Skill');
      assert.equal(run.workspace_context.memories.length,memories);
      assert.equal(run.workspace_context.selected_skills.length,5);
      assert.ok(run.workspace_context.query_observations.some(query=>query.id===orderDraft.id));
      baseline ??= preparation.selects;
      assert.equal(preparation.selects,baseline,'记忆翻倍时派发 SELECT 数量相同');
      console.log(JSON.stringify({memories,skills:5,historicalQuery:orderDraft.id,readableCheckpoint:true,selects:preparation.selects}));
      ok(await h.request(`/conversations/${conversation}/messages/${run.message_id}/withdraw`,{operation_id:randomUUID()},'bob'));
      h.releaseRun(run.run_id);
    }
    h.sql(`DELETE FROM personal_assets WHERE id IN (${extraMemoryIds.map(literal).join(',')})`);
    await setRights({alice:['raw_payments'],bob:['raw_payments']});
  }
  manager = SessionManager.inMemory('/synthetic/data-agent');
  run = await start('那帮我统计我有权限的支付原始表。', conversation, measurePreparation ? 'revoked' : undefined);
  assert.equal(run.conversation_id, conversation);
  assert.equal(run.checkpoint, null);
  assert.ok(!JSON.stringify(run.workspace_context.authority_snapshot).includes(order));
  if (measurePreparation) {
    assert.equal(run.workspace_context.memories.length, 10);
    assert.equal(run.workspace_context.selected_skills.length, 5);
    assert.ok(run.workspace_context.query_observations.some(query => query.id === orderDraft.id));
    assert.ok(preparation.selects >= 3 && preparation.selects <= 4, JSON.stringify(preparation));
    console.log(JSON.stringify({memories:10,skills:5,historicalQuery:orderDraft.id,revokedCheckpoint:true}));
  }
  const attempt = {...identity(run), call_attempt_id: randomUUID()};
  ok(await h.internal('/internal/model/issue', attempt));
  ok(await h.internal('/internal/model/settle', attempt));
  const paymentTask = await createTask('统计支付原始表行数');
  const search = async query => (await call('search_knowledge', {query, limit: 10})).response;
  const revokedSearch = await search('demo_order_detail');
  if (revokedSearch.status === 200) {
    assert.ok(revokedSearch.value.data.hits.every(hit => !restricted.includes(hit.ref?.object_id)));
  } else {
    assert.equal(revokedSearch.status, 404, JSON.stringify(revokedSearch.value));
    assert.equal(revokedSearch.value.code, 'not_available');
  }
  assert.ok(ok(await search('raw_payments')).data.hits.some(hit => hit.ref?.object_id === payment));
  const paymentObject = ok(await request('/knowledge/'+payment, 'bob'));
  const paymentRead = await call('read_knowledge', {items: [{kind: 'knowledge', ref: ref(paymentObject)}]});
  assert.equal(ok(paymentRead.response).data.items[0].state, 'ok');
  const paymentDraft = await draft(paymentTask, 'SELECT COUNT(*) AS total FROM raw_payments', '合成支付记录行数');
  await finish('支付查询草稿已保存。');
  ok(await confirm(paymentDraft));
  await h.resumeWorker();
  await until(async () => (await request('/queries/'+paymentDraft.id, 'bob')).value.execution_state === 'succeeded', 'authorized second result');
  assert.ok(ok(await request('/queries/'+paymentDraft.id+'/results', 'bob')).rows.length > 0);

  await h.pauseWorker();
  await setRights({alice:['raw_payments'],bob:['demo_order_detail','raw_payments']});
  const marker = 'SYNTHETIC_REVOKED_MEMORY_PREVIEW';
  const memory = ok(await h.request('/assets',{
    operation_id:randomUUID(),id:null,expected_version:null,kind:'memory',
    name:'表权限关联的合成记忆',body:marker,scope:'合成试验',verified:false,source_text:'',
    dependencies:[{object_id:order,version:original.version,path:'ddl'}],
  },'bob'));
  manager = SessionManager.inMemory('/synthetic/data-agent');
  run = await start('直接用工作区已有记忆回答。');
  const previewConversation = run.conversation_id;
  assert.ok(run.workspace_context.memories.some(item=>item.id===memory.id && item.body===marker));
  ok((await call('update_analysis_task',{action:'route',task_id:null,expected_version:null,goal:'',options:[]})).response);
  await finish(marker);

  await setRights({alice:['raw_payments'],bob:['raw_payments']});
  manager = SessionManager.inMemory('/synthetic/data-agent');
  run = await start('继续分析我还有权限的另外一张表。',previewConversation);
  assert.equal(run.checkpoint,null,'仅从启动预览看过撤权资料的历史也不得回流');
  assert.ok(!JSON.stringify(run.workspace_context).includes(marker));
  ok((await call('update_analysis_task',{action:'route',task_id:null,expected_version:null,goal:'',options:[]})).response);
  await finish('使用当前获准资料继续。');

  await setRights({alice:['raw_payments'],bob:['demo_order_detail','raw_payments']});
  manager = SessionManager.inMemory('/synthetic/data-agent');
  run = await start('补读那条合成记忆。',previewConversation);
  const memoryRead = await call('read_knowledge',{items:[{kind:'memory',asset_ref:{id:memory.id,version:memory.version},part:'body'}]});
  assert.equal(ok(memoryRead.response).data.items[0].asset.body,marker);
  await setRights({alice:['raw_payments'],bob:['raw_payments']});
  const retiredMemory = await h.internal('/internal/data/tools',memoryRead.input);
  assert.ok(retiredMemory.status>=400,JSON.stringify(retiredMemory.value));
  assert.ok(!JSON.stringify(retiredMemory.value).includes(marker));
  ok((await call('update_analysis_task',{action:'route',task_id:null,expected_version:null,goal:'',options:[]})).response);
  await finish('关联来源已经撤权。');

  await h.pausePlatform();
  const unavailable = await request('/knowledge?directory=all', 'bob');
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.value.code, 'source_unavailable');
  console.log(JSON.stringify({passed: true, checks: ['不同用户表、字段、指标、关系和原始DDL授权', '查询案例的字段依赖和输出指标继承表权限', '独立共享文档保留可读', '跨用户结果404和撤权后本人结果403', '撤权后旧草稿、结果和回执受限，同一会话可正常查另一张获准表', '记忆预览历史和成功回执随表权限撤回','平台缺失明确失败'], officialRequests: 0}));
} finally {
  await h.close();
}

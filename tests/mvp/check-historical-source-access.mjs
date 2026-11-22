import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import net from 'node:net';
import {createServer} from 'node:http';
import {writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness, until} from './harness.mjs';

// 字节量证据代理：纯TCP透传不解析MySQL协议，只累计服务端送回应用方向的总字节。
// 大原文是否被读取以真实数据量作证，不用耗时快慢充当读取粒度证明。
const shipped = {bytes: 0};
const dbSockets = new Set();
const dbProxy = net.createServer(sock => {
  sock.on('error', () => {});
  const remote = net.connect(13306, '127.0.0.1');
  remote.on('error', () => {});
  dbSockets.add(sock);
  dbSockets.add(remote);
  sock.on('close', () => { remote.destroy(); dbSockets.delete(sock); });
  remote.on('close', () => { sock.destroy(); dbSockets.delete(remote); });
  sock.on('data', chunk => remote.write(chunk));
  remote.on('data', chunk => { shipped.bytes += chunk.length; sock.write(chunk); });
});
await new Promise(resolve => dbProxy.listen(0, '127.0.0.1', resolve));

let platformUrl;
const platformRequests = [];
const platformProxy = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const input = raw ? JSON.parse(raw) : {};
  platformRequests.push({path: req.url, queryId: input.query_id});
  const {host: _h, connection: _c, 'content-length': _cl, 'transfer-encoding': _te, ...headers} = req.headers;
  const upstream = await fetch(platformUrl + req.url, {method: req.method, headers,
    body: req.method === 'POST' ? raw : undefined});
  const bytes = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(upstream.status, {'content-type': upstream.headers.get('content-type')});
  res.end(bytes);
});
await new Promise(resolve => platformProxy.listen(0, '127.0.0.1', resolve));
const h = await harness({capture: true, startWorker: false,
  onDatabaseUrl: url => url.replace('@127.0.0.1:13306/', '@127.0.0.1:' + dbProxy.address().port + '/'),
  env: {DATA_AGENT_LEASE_MS: '120000'}});
platformUrl = h.env.DATA_AGENT_PLATFORM_URL;
h.env.DATA_AGENT_PLATFORM_URL = 'http://127.0.0.1:' + platformProxy.address().port;
await h.restartApi();
let run, manager, passed = false;
const checks = [];
const ok = response => {assert.equal(response.status, 200, JSON.stringify(response.value)); return response.value;};
const binding = () => ({run_id: run.run_id, lease_epoch: run.lease_epoch});
const checkpoint = () => exportCheckpoint(manager,
  run.workspace_context.authority_revision, run.workspace_context.authority_snapshot);
const begin = async (cid, text) => {
  await h.resumeWorker(); run = await h.capture(cid, text); await h.pauseWorker();
  manager = SessionManager.inMemory('/synthetic/data-agent');
};
const invoke = async (tool_name, args, expectedError) => {
  const input = {...binding(), sdk_tool_call_id: randomUUID(), tool_name, arguments: args,
    checkpoint: checkpoint()};
  ok(await h.internal('/internal/data/tool-calls', input));
  const response = await h.internal('/internal/data/tools', input);
  if (expectedError) {
    assert.equal(response.value.code, expectedError, JSON.stringify(response.value));
    ok(await h.internal('/internal/data/tool-rejections', input));
    return;
  }
  return ok(response).data;
};
const finish = async () => {
  const text = '已保存合成分析。';
  ok(await h.internal('/internal/outputs', {...binding(), chunk_seq: '1', text}));
  ok(await h.internal('/internal/finish', {...binding(), commit_id: run.output_id,
    final_text: text, checkpoint: checkpoint()}));
  h.releaseRun(run.run_id);
};
const issue = () => h.internal('/internal/model/issue', {...binding(), call_attempt_id: randomUUID()});
try {
  for (const kind of ['query', 'report']) {
    const doc = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'document',
      name: '语音会话说明', body: '一个会话可以包含多个语音轮次。', related_ids: []}));
    const cid = await h.create();
    await begin(cid, '依据文档准备分析，先不执行。');
    const ref = {object_id: doc.id, version: doc.version, path: 'body'};
    assert.equal((await invoke('read_knowledge',{items:[{kind:'knowledge',ref}]})).items[0].state,'ok');
    const timeRoles = kind === 'query' ? [{role:'observation_cutoff',value:'2026-10-04T00:00:00Z',
      description:'保存时采用的合成观察截点',field_ref:null,evidence_refs:[ref]}] : [];
    const task = await invoke('update_analysis_task', {action: 'create', goal: '语音轮次统计',
      conditions: {time_start: null, time_end: null, timezone: 'UTC', metric: null, channel: null,
        group_by: [], filters: [], knowledge_refs: [], notes: '', source_limits: null,
        time_roles:timeRoles}, options: []});
    let query;
    if (kind === 'query') {
      query = await invoke('request_query', {task_id: task.task_id, condition_version: task.condition_version,
        sql: 'SELECT 7 AS voice_turns', parameters: {}, target_id: 'synthetic-sqlite',
        summary: '按保存时的会话说明准备查询', knowledge_refs: [ref], replaces_query_id: null});
    } else {
      const evidence = await invoke('save_analysis_evidence', {task_id: task.task_id,
        condition_version: task.condition_version, data_range: '合成资料解释', findings: [{
          text: '会话允许多轮语音交互。', calculation: '按文档说明', limitations: [],
          query_refs: [], figures: [], knowledge_refs: [ref],
        }]});
      await invoke('save_analysis_report', {task_id: task.task_id, condition_version: task.condition_version,
        expected_version: null, title: '会话说明', evidence_ids: [evidence.evidence_id], charts: []});
    }
    await finish();
    const revised = ok(await h.request(`/knowledge/${doc.id}`, {operation_id: randomUUID(),
      expected_version: doc.version, entry_id: 'body', value: '一个会话允许多轮语音对话，统计时分开会话与轮次。',
      clear_override: false}, 'alice', 'PATCH'));
    await begin(cid, '复述保存时的分析。');
    await invoke('update_analysis_task', {action: 'route', task_id: task.task_id,
      expected_version: task.condition_version, goal: '', options: []});
    const old = kind === 'query' ? await invoke('get_query', {query_id: query.id})
      : await invoke('read_analysis_report', {task_id: task.task_id});
    assert.equal(old.historical_analysis.kind, kind);
    assert.equal(typeof old.content_text, 'string');
    if (kind === 'query') assert.deepEqual(JSON.parse(old.content_text).conditions.time_roles,timeRoles,
      '原时间依据仍随已核历史条件交付，不能从控制投影重新成为当前依据');
    assert.equal((await issue()).status, 200, '普通改版仍能复述历史正文');
    h.sql(`UPDATE knowledge_revisions SET archived_body=NULL WHERE object_id='${doc.id}' AND version=${doc.version}`);
    const withoutOriginal = kind === 'query' ? await invoke('get_query', {query_id: query.id})
      : await invoke('read_analysis_report', {task_id: task.task_id});
    assert.equal(typeof withoutOriginal.content_text, 'string', '旧资料全文清理不隐藏已保存分析');
    assert.equal((await issue()).status, 200, '历史访问只依赖当前访问权与保存时来源记录');
    ok(await h.request(`/knowledge/${doc.id}/disable`, {operation_id: randomUUID(),
      expected_version: revised.version}));
    const unavailable = kind === 'query' ? await invoke('get_query', {query_id: query.id})
      : await invoke('read_analysis_report', {task_id: task.task_id});
    assert.equal(unavailable.content_text, undefined, `${kind}停用后再次读取不能交付历史正文`);
    if (kind === 'query') assert.equal(unavailable.results, null);
    else assert.equal(unavailable.status, 'sources_unavailable');
    assert.equal((await issue()).status, 200, '后续派发保留当前运行许可');
    ok(await h.request(`/conversations/${cid}/messages/${run.message_id}/withdraw`,
      {operation_id: randomUUID()}));
    h.releaseRun(run.run_id);
    checks.push(`${kind}普通改版可读、停用后历史投影持续核验`);
  }
  const scopeDoc = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'document',
    name: '语音轮次示例', body: '合成轮次计数规则。', related_ids: []}));
  const scopeCid = await h.create();
  await begin(scopeCid, '执行这条合成查询。');
  const scopeTask = await invoke('update_analysis_task', {action: 'create', goal: '查询历史范围',
    conditions: {time_start: null, time_end: null, timezone: 'UTC', metric: null, channel: null,
      group_by: [], filters: [], knowledge_refs: [], notes: '', source_limits: null}, options: []});
  const scopeRef = {object_id: scopeDoc.id, version: scopeDoc.version, path: 'body'};
  assert.equal((await invoke('read_knowledge',{items:[{kind:'knowledge',ref:scopeRef}]})).items[0].state,'ok');
  const scopedQuery = await invoke('request_query', {task_id: scopeTask.task_id,
    condition_version: scopeTask.condition_version, sql: "SELECT 7 AS voice_turns,'合成会话' AS category", parameters: {},
    target_id: 'synthetic-sqlite', summary: '保留历史轮次查询',
    knowledge_refs: [scopeRef], replaces_query_id: null});
  await invoke('execute_query', {query_id: scopedQuery.id, draft_version: scopedQuery.draft_version,
    condition_version: scopedQuery.condition_version, instruction_quote: run.text});
  await finish();
  await h.resumeWorker();
  await until(() => h.sql(`SELECT JSON_OBJECT('state',execution_state) FROM query_requests WHERE id='${scopedQuery.id}'`)[0].state === 'succeeded', '合成查询完成');
  run = await until(() => h.captured.find(value => value.conversation_id === scopeCid && value.text.startsWith('[已确认查询结果事件]')), '查询结果通知');
  await h.pauseWorker();
  manager = SessionManager.inMemory('/synthetic/data-agent');
  await invoke('update_analysis_task', {action: 'route', task_id: scopeTask.task_id,
    expected_version: scopeTask.condition_version, goal: '', options: []});
  const result = (await invoke('get_query', {query_id: scopedQuery.id})).results;
  assert.deepEqual(result.rows, [['7', '合成会话']]);
  const resultEvidence = await invoke('save_analysis_evidence', {task_id: scopeTask.task_id,
    condition_version: scopeTask.condition_version, data_range: '独立合成单行查询', findings: [{
      text: '保存时语音轮次为7。', calculation: '原查询值，不重新计算', limitations: [],
      query_refs: [{query_id: scopedQuery.id, result_ref: result.result_ref, columns: ['voice_turns', 'category']}],
      figures: [{label: '语音轮次', query_id: scopedQuery.id, column: 'voice_turns', row_index: 0, value: '7'}],
      knowledge_refs: [],
    }]});
  const report = await invoke('save_analysis_report', {task_id: scopeTask.task_id,
    condition_version: scopeTask.condition_version, expected_version: null, title: '保存时的语音轮次',
    evidence_ids: [resultEvidence.evidence_id], charts: [{kind: 'bar', title: '语音轮次',
      query_id: scopedQuery.id, result_ref: result.result_ref,
      dimension_column: 'category', measure_column: 'voice_turns'}]});
  const reportPath = `/conversations/${scopeCid}/tasks/${scopeTask.task_id}/report`;
  const originalReport = ok(await h.request(reportPath));
  assert.deepEqual(originalReport.chart_results[0].rows, [['7', '合成会话']]);
  await finish();
  const queryState = () => h.sql(`SELECT JSON_OBJECT('id',q.id,'operation',q.operation_id,
    'budget',q.budget_scope_id,'task',q.task_id,'condition',q.condition_version,
    'draft',q.draft_version,'sql',q.sql_text,'parameters',q.parameters,'target',q.target_id,
    'targetVersion',q.target_version,'confirmation',q.confirmation_key,
    'confirmationMessage',q.confirmation_message_id,'attempts',q.submission_attempts,
    'state',q.execution_state,'result',q.result_ref) FROM query_requests q
    WHERE q.conversation_id='${scopeCid}' ORDER BY q.id`);
  const savedQuery = queryState();
  assert.equal(savedQuery.length, 1);
  assert.equal(savedQuery[0].attempts, 1);
  const submissions = platformRequests.filter(request => request.path === '/submit').length;
  assert.equal(submissions, 1, '合成查询只提交一次');
  const savedPlatform = JSON.parse(execFileSync('python3', ['-c',
    "import sqlite3,json,sys; d=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); print(json.dumps(d.execute('SELECT id,owner,fp,payload,state,result FROM submissions ORDER BY id').fetchall()))",
    h.directory + '/platform/submissions.sqlite'], {encoding: 'utf8'}));
  assert.equal(savedPlatform.length, 1);
  execFileSync('python3', ['-c',
    "import sqlite3,sys; d=sqlite3.connect(sys.argv[1]); d.execute('UPDATE submissions SET expires_at=0 WHERE id=?',(sys.argv[2],)); d.commit()",
    h.directory + '/platform/submissions.sqlite', scopedQuery.id]);
  const expiredResults = await h.request(`/queries/${scopedQuery.id}/results`);
  assert.ok(expiredResults.status >= 400);
  assert.equal(expiredResults.value.code, 'result_expired');
  const expiredReport = ok(await h.request(reportPath));
  assert.equal(expiredReport.status, 'available');
  assert.deepEqual(expiredReport.reference, report);
  assert.deepEqual(expiredReport.report, originalReport.report, '原报告正文和图表定义保留');
  assert.deepEqual(expiredReport.chart_results, [], '到期只隐藏需要回读的图表行列');
  ok(await h.request(`/knowledge/${scopeDoc.id}`, {operation_id: randomUUID(),
    expected_version: scopeDoc.version, entry_id: 'body', value: '更新合成轮次解释。',
    clear_override: false}, 'alice', 'PATCH'));
  await begin(scopeCid, '本次只用文档解释，先不读取平台查询历史。');
  const allowed = [{kind: 'document', id: scopeDoc.id}];
  const limited = await invoke('update_analysis_task', {action: 'revise', task_id: scopeTask.task_id,
    expected_version: scopeTask.condition_version, goal: '', options: [],
    condition_patch: {set: {source_limits: {allowed_sources: allowed, origin_message_ids: [run.message_id]}}, unset: []}});
  // 捕获式宿主测试不驱动Pi轮内刷新；先完成本轮，再由正常启动应用已声明范围。
  await finish();
  await begin(scopeCid, '按刚才限定的文档范围继续核对历史。');
  await invoke('update_analysis_task', {action: 'route', task_id: scopeTask.task_id,
    expected_version: limited.condition_version, goal: '', options: []});
  await invoke('get_query', {query_id: scopedQuery.id}, 'source_not_allowed');
  assert.equal((await issue()).status, 200, '范围外历史在交付前拒绝，不污染后续模型派发');
  const expanded = await invoke('update_analysis_task', {action: 'revise', task_id: scopeTask.task_id,
    expected_version: limited.condition_version, goal: '', options: [],
    condition_patch: {set: {source_limits: {allowed_sources: [...allowed, {kind: 'platform', id: 'synthetic-sqlite'}], origin_message_ids: [run.message_id]}}, unset: []}});
  const allowedHistory = await invoke('get_query', {query_id: scopedQuery.id});
  assert.equal(allowedHistory.historical_analysis.kind, 'query');
  assert.ok(allowedHistory.content_text.includes('SELECT 7 AS voice_turns'));
  assert.equal(allowedHistory.results, null, '过期明细不能伪作当前结果');
  const historicalReport = await invoke('read_analysis_report', {task_id: scopeTask.task_id});
  assert.equal(historicalReport.historical_analysis.kind, 'report');
  assert.ok(historicalReport.content_text.includes('保存时语音轮次为7。'));
  await finish();
  assert.deepEqual(queryState(), savedQuery, '历史SQL/报告读取不新增查询、提交尝试或更换原身份和预算');
  assert.equal(platformRequests.filter(request => request.path === '/submit').length, submissions,
    '结果过期后历史读取不能向平台重新提交查询');
  const currentPlatform = JSON.parse(execFileSync('python3', ['-c',
    "import sqlite3,json,sys; d=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); print(json.dumps(d.execute('SELECT id,owner,fp,payload,state,result FROM submissions ORDER BY id').fetchall()))",
    h.directory + '/platform/submissions.sqlite'], {encoding: 'utf8'}));
  assert.deepEqual(currentPlatform, savedPlatform, '平台保存的原查询、SQL和结果不重建');
  checks.push('结果到期的历史SQL/报告保原正文与范围核验；明细/图表单独到期，query/attempt/预算和平台一次submit保持');

  // 大原文下历史核验只读元信息的真实数据量证据：先服务端把全部平台来源正文撑到约11MB，
  // 本轮实际读一次etl来源——read_source结果事件进入本轮授权快照sources，随后每次派发
  // 都要重新核验该来源仍是当前修订且完整。派发核验窗口内经数据库代理送回应用的总字节
  // 必须远小于正文体积：按钉住修订读body列会把整段正文再拉回应用；元信息核验只涉及
  // 修订号与complete标志。以实际数据量作证，不用耗时快慢充当读取粒度证明。
  h.sql(`UPDATE source_current SET body=CONCAT(body,REPEAT('历史核验大原文填充段。',350000))`);
  h.sql(`UPDATE source_revisions SET body=CONCAT(body,REPEAT('历史核验大原文填充段。',350000))`);
  await begin(scopeCid, '本次还要继续核对etl平台来源的历史。');
  const widened = await invoke('update_analysis_task', {action: 'revise', task_id: scopeTask.task_id,
    expected_version: expanded.condition_version, goal: '', options: [],
    condition_patch: {set: {source_limits: {allowed_sources: [
      {kind: 'document', id: scopeDoc.id}, {kind: 'platform', id: 'synthetic-sqlite'}, {kind: 'platform', id: 'etl'}],
      origin_message_ids: [run.message_id]}}, unset: []}});
  await finish();
  await begin(scopeCid, '继续核对大原文平台来源的历史。');
  const etlVersion = String(h.sql(`SELECT JSON_OBJECT('v',version) FROM source_heads WHERE id='etl'`)[0].v);
  const etlWindow = await invoke('read_source',{citation:{source:{kind:'platform',id:'etl'},revision:etlVersion,locator:{offset:0,length:24}}});
  assert.equal([...etlWindow.text].length,24);
  const before = shipped.bytes;
  await invoke('update_analysis_task', {action: 'route', task_id: scopeTask.task_id,
    expected_version: widened.condition_version, goal: '', options: []});
  assert.equal((await issue()).status, 200, '大原文不改变历史核验结论');
  const windowBytes = shipped.bytes - before;
  assert.ok(windowBytes < 500_000, '历史核验不得把大原文body整段拉回应用：窗口下行' + windowBytes + 'B');
  h.releaseRun(run.run_id);
  checks.push('大原文下历史核验只读元信息：核验窗口下行' + windowBytes + 'B，远小于约11MB正文');

  const table = ok(await h.request('/knowledge/table-demo_order_detail'));
  const cid = await h.create();
  await begin(cid, '保存引用合成平台结构的分析。');
  const task = await invoke('update_analysis_task', {action:'create',goal:'合成平台说明',options:[],
    conditions:{time_start:null,time_end:null,timezone:'UTC',metric:null,channel:null,
      group_by:[],filters:[],knowledge_refs:[],notes:'',source_limits:null}});
  const query = await invoke('request_query', {task_id:task.task_id,condition_version:task.condition_version,
    sql:'SELECT 7 AS voice_turns',parameters:{},target_id:'synthetic-sqlite',summary:'保存时的平台资料',
    knowledge_refs:[{object_id:table.id,version:table.version,path:'description'}],replaces_query_id:null});
  await finish();
  // 迁移前缺映射的旧记录：不能把未知贡献根当成“独立人工内容，无来源”。
  h.sql(`DELETE FROM knowledge_dependency_states WHERE owner_id='${table.id}' AND owner_version=${table.version};DELETE FROM source_heads WHERE id='schema'`);
  await begin(cid, '读取保存时的分析。');
  await invoke('update_analysis_task', {action:'route',task_id:task.task_id,
    expected_version:task.condition_version,goal:'',options:[]});
  const unknown = await invoke('get_query', {query_id:query.id});
  assert.equal(unknown.content_text,undefined,'缺失来源闭包不能绕过已经撤回的上游资料');
  assert.equal(unknown.historical_analysis,undefined,'来源不明时不能建立历史正文许可');
  checks.push('旧来源映射不完整时拒绝派生正文，不以缺映射猜作无来源');
  passed = true;
  console.log(JSON.stringify({passed, checks, officialRequests: 0}));
} finally {
  await writeFile('.local/checks/historical-source-access.json', JSON.stringify({passed, checks, officialRequests: 0}, null, 2));
  if (run) h.releaseRun(run.run_id);
  await h.close();
  await new Promise(resolve => platformProxy.close(resolve));
  for (const socket of dbSockets) socket.destroy();
  await new Promise(resolve => dbProxy.close(resolve));
}

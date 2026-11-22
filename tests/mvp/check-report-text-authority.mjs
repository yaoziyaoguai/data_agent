import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { exportCheckpoint } from '../../apps/agent/session/checkpoint.ts';
import { harness, until } from './harness.mjs';

// 验证报告对条件、发现及查询结果所登记的业务来源实施撤权。
const h = await harness({ capture: true, startWorker: false, env: { DATA_AGENT_LEASE_MS: '120000', DATA_AGENT_QUERY_DELAY_SECONDS: '0.1' } });
const checks = [];
let run, manager, passed = false;
const ok = response => { assert.equal(response.status, 200, JSON.stringify(response)); return response.value; };
const binding = () => ({ run_id: run.run_id, lease_epoch: run.lease_epoch });
const checkpoint = () => exportCheckpoint(manager, run.workspace_context.authority_revision, run.workspace_context.authority_snapshot);
const begin = async (cid, text) => {
  await h.resumeWorker(); run = await h.capture(cid, text); await h.pauseWorker();
  manager = SessionManager.inMemory('/synthetic/data-agent');
};
const raw = async (name, args) => {
  const input = { ...binding(), sdk_tool_call_id: randomUUID(), tool_name:name, arguments:args, checkpoint:checkpoint() };
  const registered = await h.internal('/internal/data/tool-calls', input);
  return registered.status === 200 ? h.internal('/internal/data/tools',input) : registered;
};
const invoke = async (name,args) => ok(await raw(name,args)).data;
const route = task => invoke('update_analysis_task',{action:'route',task_id:task.task_id,expected_version:task.condition_version,goal:'',options:[]});
const finish = async () => {
  const text = '合成来源验证已记录。';
  ok(await h.internal('/internal/outputs',{...binding(),chunk_seq:'1',text}));
  ok(await h.internal('/internal/finish',{...binding(),commit_id:run.output_id,final_text:text,checkpoint:checkpoint()}));
  h.releaseRun(run.run_id);
};
const baseConditions = {time_start:null,time_end:null,timezone:'UTC',metric:null,channel:null,group_by:[],filters:[],knowledge_refs:[],notes:'',source_limits:null};
const document = async (name, body) => ok(await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name,body,related_ids:[]}));
const unavailable = (view,marker) => {
  assert.equal(view.status,'sources_unavailable',JSON.stringify(view));
  assert.deepEqual(Object.keys(view).sort(),['reference','status']);
  assert.equal(JSON.stringify(view).includes(marker),false);
};
const ref = document => ({object_id:document.id,version:document.version,path:'body'});
const adopt = async document => {
  const evidence = await invoke('read_knowledge',{items:[{kind:'knowledge',ref:ref(document)}]});
  assert.equal(evidence.items[0].state,'ok');
};
try {
  const benign = await document('可保留的合成观察依据','独立且持续有效的合成定义。');
  for (const mode of ['conditions','finding']) {
    const marker = `SYNTHETIC_PRIVATE_${mode.toUpperCase()}`;
    const cid = await h.create();
    const source = await document(`来源-${mode}`,marker);
    await begin(cid,'记录合成资料观察，不执行SQL。');
    await adopt(source);
    const conditions = mode === 'conditions'
      ? {...baseConditions,metric:marker,notes:marker,knowledge_refs:[ref(source)]} : baseConditions;
    const task = await invoke('update_analysis_task',{action:'create',goal:'独立资料观察',conditions,options:[]});
    const findingRefs = mode === 'finding' ? [ref(benign),ref(source)] : [ref(benign)];
    const evidenceInput = {task_id:task.task_id,condition_version:task.condition_version,data_range:mode==='finding'?marker:'合成资料范围',findings:[{text:mode==='finding'?marker:'独立合成观察',calculation:mode==='finding'?marker:'读取资料，不计算数字。',limitations:mode==='finding'?[marker]:[],query_refs:[],knowledge_refs:findingRefs,figures:[]}]};
    const evidence = await invoke('save_analysis_evidence',evidenceInput);
    const reportPath = `/conversations/${cid}/tasks/${task.task_id}/report`;
    const reportInput = {task_id:task.task_id,condition_version:task.condition_version,expected_version:null,title:'合成观察报告',evidence_ids:[evidence.evidence_id],charts:[]};
    await finish();
    const reference = ok(await h.request(reportPath,{operation_id:randomUUID(),...reportInput}));
    const report = ok(await h.request(reportPath));
    assert.equal(report.status,'available');
    assert.ok(JSON.stringify(report.report).includes(marker));
    assert.notEqual((await h.request(reportPath,undefined,'bob')).status,200);
    ok(await h.request(`/knowledge/${source.id}/disable`,{operation_id:randomUUID(),expected_version:source.version}));
    unavailable(ok(await h.request(reportPath)),marker);
    const unchanged = await h.request(reportPath,{operation_id:randomUUID(),...reportInput,expected_version:reference.version,title:'独立重写标题'});
    assert.ok(unchanged.status>=400,JSON.stringify(unchanged));
    assert.equal(h.sql(`SELECT JSON_OBJECT('version',version) FROM analysis_reports WHERE id='${reference.report_id}'`)[0].version,Number(reference.version));
    await begin(cid,'核对已保存报告是否仍然可用。');
    await route(task);
    unavailable(await invoke('read_analysis_report',{task_id:task.task_id}),marker);
    const rejected = await raw('save_analysis_evidence',evidenceInput);
    assert.equal(rejected.status,409,JSON.stringify(rejected));
    assert.ok(['stale_context','stale_knowledge'].includes(rejected.value.code));
    assert.equal(JSON.stringify(rejected.value).includes(marker),false);
    await finish();
    checks.push(`${mode}：已登记来源停用后HTTP和Agent均隐藏完整报告，重写标题或重存证据仍不能绕过来源核验`);
  }
  // 查询自身的来源必须传到证据。利用无关资料停用触发正常上下文重建，
  // 确保证据保存轮没有恰好从历史run继承查询生成时读过的来源。
  {
    const marker = 'SYNTHETIC_PRIVATE_OLD_QUERY';
    const source = await document('旧查询生成来源',marker);
    const resetSource = await document('只用于触发上下文重建的后读资料','独立合成临时资料。');
    const cid = await h.create();
    await begin(cid,'准备合成来源查询，暂不执行。');
    const task = await invoke('update_analysis_task',{action:'create',goal:'独立旧结果观察',conditions:baseConditions,options:[]});
    await adopt(source);
    const query = await invoke('request_query',{task_id:task.task_id,condition_version:task.condition_version,sql:`SELECT '${marker}' AS source_text FROM demo_order_detail LIMIT 1`,parameters:{},target_id:'synthetic-sqlite',summary:'合成文字查询',knowledge_refs:[ref(source)],replaces_query_id:null});
    assert.deepEqual(query.knowledge_refs,[ref(source)]);
    await adopt(resetSource);
    await finish();
    ok(await h.request(`/queries/${query.id}/confirm`,{operation_id:randomUUID(),draft_version:query.draft_version,condition_version:query.condition_version}));
    await h.resumeWorker();
    await until(async()=>ok(await h.request(`/queries/${query.id}`)).execution_state==='succeeded','old query succeeds',40000);
    run = await until(()=>h.captured.find(value=>value.conversation_id===cid && value.text.includes('query_id=')),'old query wake',40000);
    await h.pauseWorker();
    manager = SessionManager.inMemory('/synthetic/data-agent');
    await route(task);
    await finish();
    const result = ok(await h.request(`/queries/${query.id}/results`));
    ok(await h.request(`/knowledge/${resetSource.id}/disable`,{operation_id:randomUUID(),expected_version:resetSource.version}));
    await begin(cid,'根据已完成的旧查询保存观察，不重新读取查询。');
    assert.equal(run.workspace_context.authority_snapshot.knowledge.some(ref=>ref[0]===source.id),false,'正常重建后源资料A不能恰好还在本轮authority');
    await route(task);
    const evidence = await invoke('save_analysis_evidence',{task_id:task.task_id,condition_version:task.condition_version,data_range:'原查询范围',findings:[{text:marker,calculation:'直接引用已完成结果。',limitations:[],query_refs:[{query_id:query.id,result_ref:result.result_ref,columns:['source_text']}],knowledge_refs:[],figures:[]}]});
    const stored = h.sql(`SELECT body FROM analysis_evidence WHERE id='${evidence.evidence_id}'`)[0];
    assert.deepEqual(stored.validated_sources.knowledge_refs,[]);
    assert.deepEqual(stored.validated_sources.result_dependencies,[{query_id:query.id,result_ref:result.result_ref}]);
    await finish();
    const path = `/conversations/${cid}/tasks/${task.task_id}/report`;
    ok(await h.request(path,{operation_id:randomUUID(),task_id:task.task_id,condition_version:task.condition_version,expected_version:null,title:'旧结果来源观察',evidence_ids:[evidence.evidence_id],charts:[]}));
    assert.equal(ok(await h.request(path)).status,'available');

    // 只读报告，故意不在本轮调用 get_query，区分报告和直接查询的正式答复权限。
    await begin(cid,'给出这份已保存报告的结论。');
    await route(task);
    const read = await invoke('read_analysis_report',{task_id:task.task_id});
    assert.equal(read.status,'available');
    assert.ok(read.content_text.includes(marker));
    const setTables = async tables => {
      const response = await fetch(h.env.DATA_AGENT_PLATFORM_URL + '/permissions',{
        method:'POST',headers:{authorization:'Bearer '+h.env.DATA_AGENT_INTERNAL_TOKEN,'content-type':'application/json'},
        body:JSON.stringify({space_id:'demo',denied_query_users:[],table_readers:{alice:tables,bob:['demo_order_detail']}}),
      });
      assert.equal(response.status,200,await response.text());
    };
    const answer = `报告原结论为 ${marker}。`;
    ok(await h.internal('/internal/outputs',{...binding(),chunk_seq:'1',text:answer}));
    const final = {...binding(),commit_id:run.output_id,final_text:answer,checkpoint:checkpoint()};
    await setTables(['raw_payments']);
    assert.equal((await h.request(`/queries/${query.id}/results`)).status,403);
    unavailable(ok(await h.request(path)),marker);
    unavailable(await invoke('read_analysis_report',{task_id:task.task_id}),marker);
    const before = await h.snapshot(cid);
    const denied = await h.internal('/internal/finish',final);
    assert.equal(denied.status,409,JSON.stringify(denied));
    assert.equal(denied.value.code,'stale_context');
    assert.equal(JSON.stringify(denied.value).includes(marker),false);
    const after = await h.snapshot(cid);
    assert.deepEqual(after.messages,before.messages);
    assert.deepEqual(after.tasks,before.tasks);
    assert.equal(after.runs.find(record=>record.run_id===run.run_id).state,'running');
    assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM assistant_outputs WHERE attempt_id='${run.attempt_id}' AND state='committed'`)[0].n,0);
    assert.equal((await h.request(path,undefined,'bob')).status,404);

    await setTables(['demo_order_detail','raw_payments']);
    assert.ok(JSON.stringify(ok(await h.request(path)).report).includes(marker));
    ok(await h.internal('/internal/finish',final));
    h.releaseRun(run.run_id);
    checks.push('单独撤销报告所用表：HTTP和Agent报告均隐藏正文，读报告后自然答复无法提交；恢复后原报告和原答复可用');

    ok(await h.request(`/knowledge/${source.id}/disable`,{operation_id:randomUUID(),expected_version:source.version}));
    unavailable(ok(await h.request(path)),marker);
    checks.push('干净任务+正常重建后直接引用未读旧查询，证据仍继承查询完整来源；原来源失效时整份报告隐藏');
  }
  passed = true;
  console.log(JSON.stringify({passed,checks,officialRequests:0}));
} finally {
  await writeFile('.local/checks/report-text-authority.json',JSON.stringify({passed,checks,officialRequests:0},null,2));
  if(run)h.releaseRun(run.run_id);
  await h.close();
}

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { exportCheckpoint } from '../../apps/agent/session/checkpoint.ts';
import { harness, until } from './harness.mjs';

// 来源由真实受控读取进入宿主上下文；模型故意不把它列入knowledge_refs。
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
const baseConditions = {time_start:null,time_end:null,timezone:'UTC',metric:null,channel:null,group_by:[],filters:[],knowledge_refs:[],notes:''};
const document = async (name, body) => ok(await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name,body,related_ids:[]}));
const unavailable = (view,marker) => {
  assert.equal(view.status,'sources_unavailable',JSON.stringify(view));
  assert.deepEqual(Object.keys(view).sort(),['reference','status']);
  assert.equal(JSON.stringify(view).includes(marker),false);
};
try {
  const benign = await document('可保留的合成观察依据','独立且持续有效的合成定义。');
  for (const mode of ['conditions','finding','memory','title','legacy','legacy_title']) {
    const marker = `SYNTHETIC_PRIVATE_${mode.toUpperCase()}`;
    const cid = await h.create();
    const source = mode === 'memory' ? null : await document(`来源-${mode}`,marker);
    await begin(cid,'记录合成资料观察，不执行SQL。');
    if (mode === 'conditions') await invoke('read_knowledge',{object_id:source.id});
    const task = await invoke('update_analysis_task',{action:'create',goal:'独立资料观察',conditions:{...baseConditions,...(mode==='conditions'?{metric:marker,notes:marker}: {})},options:[]});
    let memory;
    if (mode === 'memory') {
      memory = ok(await h.request('/assets',{operation_id:randomUUID(),id:null,expected_version:null,kind:'memory',name:'合成说明偏好',body:marker,scope:'仅本人合成观察',verified:false,source_text:'本人独立录入的合成文字',dependencies:[]}));
      await invoke('read_knowledge',{object_id:`asset-${memory.id}`,version:memory.version});
    } else if (mode === 'finding') await invoke('read_knowledge',{object_id:source.id});
    const evidenceInput = {task_id:task.task_id,condition_version:task.condition_version,data_range:mode==='finding'?marker:'合成资料范围',findings:[{text:['finding','memory'].includes(mode)?marker:'独立合成观察',calculation:mode==='finding'?marker:'读取资料，不计算数字。',limitations:mode==='finding'?[marker]:[],query_refs:[],knowledge_refs:[{object_id:benign.id,version:benign.version,path:'body'}],figures:[]}]};
    const evidence = await invoke('save_analysis_evidence',evidenceInput);
    const reportPath = `/conversations/${cid}/tasks/${task.task_id}/report`;
    const reportInput = {task_id:task.task_id,condition_version:task.condition_version,expected_version:null,title:mode==='title'?marker:'合成观察报告',evidence_ids:[evidence.evidence_id],charts:[]};
    let reference;
    if (mode === 'title') {
      await invoke('read_knowledge',{object_id:source.id});
      reference = await invoke('save_analysis_report',reportInput);
    }
    await finish();
    if (mode !== 'title') reference = ok(await h.request(reportPath,{operation_id:randomUUID(),...reportInput}));
    assert.equal(ok(await h.request(reportPath)).status,'available');
    if (mode === 'legacy') {
      // 只在隔离库模拟升级前无完整来源的记录，保留原正文及显式引用。
      h.sql(`UPDATE analysis_evidence SET text_authority=NULL WHERE id='${evidence.evidence_id}'`);
    } else if (mode === 'legacy_title') {
      h.sql(`UPDATE analysis_report_revisions SET text_authorities=NULL WHERE report_id='${reference.report_id}'`);
    } else if (memory) ok(await h.request(`/assets/${memory.id}/disable`,{operation_id:randomUUID(),expected_version:memory.version}));
    else ok(await h.request(`/knowledge/${source.id}/disable`,{operation_id:randomUUID(),expected_version:source.version}));
    unavailable(ok(await h.request(reportPath)),marker);
    const unchanged = await h.request(reportPath,{operation_id:randomUUID(),...reportInput,expected_version:reference.version});
    assert.ok(unchanged.status>=400,JSON.stringify(unchanged));
    assert.equal(h.sql(`SELECT JSON_OBJECT('version',version) FROM analysis_reports WHERE id='${reference.report_id}'`)[0].version,Number(reference.version));
    if (['title','legacy_title'].includes(mode)) {
      // 人工确实重写标题可重建该字段来源，仍须核对原证据和条件。
      reference = ok(await h.request(reportPath,{operation_id:randomUUID(),...reportInput,expected_version:reference.version,title:'人工重新写出的独立标题'}));
      assert.equal(ok(await h.request(reportPath)).status,'available');
      assert.equal(ok(await h.request(reportPath)).report.title,'人工重新写出的独立标题');
      checks.push(`${mode}：Agent标题来源失效或旧NULL时同文HTTP重存不能洗来源，人工实际改写仅重建该字段`);
      continue;
    }
    await begin(cid,'核对已保存报告是否仍然可用。');
    await route(task);
    unavailable(await invoke('read_analysis_report',{task_id:task.task_id}),marker);
    if (mode === 'conditions') {
      const result = await raw('save_analysis_evidence',evidenceInput);
      assert.ok(result.status>=400,JSON.stringify(result));
      assert.equal(result.value.code,'stale_context');
      const historical = await invoke('read_analysis_task',{task_id:task.task_id,condition_version:task.condition_version});
      assert.equal(JSON.stringify(historical).includes(marker),false);
      checks.push('来源遗漏于refs时，条件metric/notes仍受宿主来源保护，报告和历史保存依据不能绕回原快照');
    } else checks.push(`${mode}：证据正文来源失效或未知时HTTP/Agent整份隐藏，修改报告标题不能清除来源`);
    await finish();
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
    await invoke('read_knowledge',{object_id:source.id});
    const query = await invoke('request_query',{task_id:task.task_id,condition_version:task.condition_version,sql:`SELECT '${marker}' AS source_text`,parameters:{},target_id:'synthetic-sqlite',summary:'合成文字查询',knowledge_refs:[],replaces_query_id:null});
    const querySources = h.sql(`SELECT text_authority FROM query_requests WHERE id='${query.id}'`)[0];
    assert.ok(querySources.knowledge.some(ref=>ref[0]===source.id));
    assert.equal(querySources.knowledge.some(ref=>ref[0]===resetSource.id),false);
    await invoke('read_knowledge',{object_id:resetSource.id});
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
    const stored = h.sql(`SELECT text_authority FROM analysis_evidence WHERE id='${evidence.evidence_id}'`)[0];
    assert.ok(stored.knowledge.some(ref=>ref[0]===source.id),'证据必须从查询继承未在本轮读取的完整来源');
    assert.deepEqual(stored.query_results,[]);
    assert.ok(stored.source_query_results.some(ref=>ref[0]===query.id));
    await finish();
    const path = `/conversations/${cid}/tasks/${task.task_id}/report`;
    ok(await h.request(path,{operation_id:randomUUID(),task_id:task.task_id,condition_version:task.condition_version,expected_version:null,title:'旧结果来源观察',evidence_ids:[evidence.evidence_id],charts:[]}));
    assert.equal(ok(await h.request(path)).status,'available');
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

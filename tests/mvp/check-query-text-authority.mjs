import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness,until} from './harness.mjs';

const h=await harness({capture:true,startWorker:false,env:{DATA_AGENT_LEASE_MS:'120000',DATA_AGENT_QUERY_DELAY_SECONDS:'0.1'}});
let run,manager,lastInput,passed=false;const checks=[];
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r));return r.value;};
const begin=async(cid,text)=>{await h.resumeWorker();run=await h.capture(cid,text);await h.pauseWorker();manager=SessionManager.inMemory('/synthetic/data-agent');};
const checkpoint=()=>exportCheckpoint(manager,run.workspace_context.authority_revision,run.workspace_context.authority_snapshot);
const invoke=async(name,args)=>{const input={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:randomUUID(),tool_name:name,arguments:args,checkpoint:checkpoint()};lastInput=input;ok(await h.internal('/internal/data/tool-calls',input));return h.internal('/internal/data/tools',input);};
const tool=async(name,args)=>ok(await invoke(name,args)).data;
const finish=async()=>{const text='合成来源检查已完成。';ok(await h.internal('/internal/outputs',{run_id:run.run_id,lease_epoch:run.lease_epoch,chunk_seq:'1',text}));ok(await h.internal('/internal/finish',{run_id:run.run_id,lease_epoch:run.lease_epoch,commit_id:run.output_id,final_text:text,checkpoint:checkpoint()}));h.releaseRun(run.run_id);};
const base={time_start:null,time_end:null,timezone:'UTC',metric:null,channel:null,group_by:[],filters:[],knowledge_refs:[],notes:''};
const task=()=>tool('update_analysis_task',{action:'create',goal:'独立查询目标',conditions:base,options:[]});
const source=marker=>h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'查询派生合成来源',body:marker,related_ids:[]}).then(ok);
const disable=doc=>h.request(`/knowledge/${doc.id}/disable`,{operation_id:randomUUID(),expected_version:doc.version}).then(ok);
const draft=(t,marker)=>tool('request_query',{task_id:t.task_id,condition_version:t.condition_version,sql:'SELECT :label AS label',parameters:{label:marker},target_id:'synthetic-sqlite',summary:marker,knowledge_refs:[],replaces_query_id:null});
const execute=q=>tool('execute_query',{query_id:q.id,draft_version:q.draft_version,condition_version:q.condition_version,instruction_quote:run.text});
const control=(query,marker)=>{assert.equal(query.text_unavailable,true);for(const key of ['sql','parameters','summary','knowledge_refs','error_details','semantic_checks'])assert.equal(query[key],undefined);assert.equal(JSON.stringify(query).includes(marker),false);};
const queryState=q=>h.sql(`SELECT JSON_OBJECT('state',execution_state,'error',error_code,'version',draft_version,'budget',budget_scope_id,'confirm',confirmation_key) FROM query_requests WHERE id='${q.id}'`)[0];
try {
 const marker='SYNTHETIC_QUERY_SOURCE';const doc=await source(marker);const cid=await h.create();await begin(cid,'生成草稿，不执行。');
 const t=await task();const syntax=await tool('validate_sql',{sql:'SELECT 1',parameters:{},target_id:'synthetic-sqlite'});assert.equal(syntax.state,'passed','validate_sql缺省knowledge_refs仍合法');await tool('read_knowledge',{object_id:doc.id});const q=await draft(t,marker);const original=lastInput;
 await disable(doc);control(ok(await h.internal('/internal/data/tools',original)).data,marker);await finish();
 await begin(cid,'核对已有草稿。');assert.equal(run.checkpoint,null);control((await tool('get_query',{query_id:q.id})).query,marker);
 control(ok(await h.request(`/queries/${q.id}`)),marker);control(ok(await h.request(`/conversations/${cid}/queries`)).queries.find(value=>value.id===q.id),marker);
 await tool('update_analysis_task',{action:'route',task_id:t.task_id,expected_version:t.condition_version,goal:'',options:[]});await finish();
 const confirmation=await h.request(`/queries/${q.id}/confirm`,{operation_id:randomUUID(),draft_version:q.draft_version,condition_version:q.condition_version});assert.equal(confirmation.value.code,'stale_context');assert.equal(queryState(q).state,'not_submitted');
 control(ok(await h.request(`/queries/${q.id}/cancel`,{operation_id:randomUUID()})),marker);assert.equal(queryState(q).state,'cancelled');
 checks.push('模型漏填refs时查询正文完整来源仍生效；Agent/HTTP/list/成功重放只回控制，首次确认拒绝且取消可用');

 const descendantMarker='SYNTHETIC_DERIVED_QUERY_RESULT';const ancestor=await source(descendantMarker);const derivedCid=await h.create();await begin(derivedCid,'执行第一个合成查询，再基于结果生成草稿。');
 const derivedTask=await task();await tool('read_knowledge',{object_id:ancestor.id});const first=await draft(derivedTask,descendantMarker);await execute(first);await finish();await h.resumeWorker();
 await until(()=>queryState(first).state==='succeeded','真实合成平台执行完成');run=await until(()=>h.captured.find(value=>value.conversation_id===derivedCid&&value.text.startsWith('[已确认查询结果事件]')),'接回结果通知');await h.pauseWorker();manager=SessionManager.inMemory('/synthetic/data-agent');
 await tool('update_analysis_task',{action:'route',task_id:derivedTask.task_id,expected_version:derivedTask.condition_version,goal:'',options:[]});
 const results=await tool('get_query',{query_id:first.id});assert.equal(results.query.summary,descendantMarker);assert.deepEqual(results.results.rows,[[descendantMarker]]);
 const second=await draft(derivedTask,descendantMarker+'派生');const saved=h.sql(`SELECT text_authority FROM query_requests WHERE id='${second.id}'`)[0];
 assert.ok(saved.knowledge.some(pair=>pair[0]===ancestor.id));assert.ok(saved.source_query_results.some(pair=>pair[0]===first.id));assert.deepEqual(saved.query_results,[]);
 h.sql(`UPDATE query_requests SET text_authority=JSON_SET(text_authority,'$.knowledge',JSON_ARRAY()) WHERE id='${second.id}'`);control(ok(await h.request(`/queries/${second.id}`)),descendantMarker);
 h.sql(`UPDATE query_requests SET text_authority=CONVERT(0x${Buffer.from(JSON.stringify(saved)).toString('hex')} USING utf8mb4) WHERE id='${second.id}'`);
 assert.equal(ok(await h.request(`/queries/${second.id}`)).summary,descendantMarker+'派生','完整来源恢复后正文可读');
 await finish();
 const crossCid=await h.create();await begin(crossCid,'验证跨会话持久来源的空间和删除边界。');const crossTask=await task();const crossQuery=await draft(crossTask,'合成来源载体');
 // 模拟已由资产采用传播的宿主来源快照，不让模型自行声明来源；目标会话保持合法。
 h.sql(`UPDATE query_requests SET text_authority=CONVERT(0x${Buffer.from(JSON.stringify(saved)).toString('hex')} USING utf8mb4) WHERE id='${crossQuery.id}'`);
 assert.equal(ok(await h.request(`/queries/${crossQuery.id}`)).text_unavailable,undefined,'同用户同空间的持久来源无需重新执行或同会话');
 h.sql(`UPDATE conversations SET space_id='synthetic-other-space' WHERE id='${derivedCid}'`);control(ok(await h.request(`/queries/${crossQuery.id}`)),'合成来源载体');
 h.sql(`UPDATE conversations SET space_id='demo',deleted=TRUE WHERE id='${derivedCid}'`);control(ok(await h.request(`/queries/${crossQuery.id}`)),'合成来源载体');
 h.sql(`UPDATE conversations SET deleted=FALSE WHERE id='${derivedCid}'`);assert.equal(ok(await h.request(`/queries/${crossQuery.id}`)).text_unavailable,undefined);await finish();
 checks.push('派生结果来源必须含完整上游闭包；同空间跨会话可读，但源会话移出空间或删除后立即隐藏');
 await disable(ancestor);await begin(derivedCid,'再核对派生草稿和旧结果。');control((await tool('get_query',{query_id:second.id})).query,descendantMarker);
 assert.equal((await h.request(`/queries/${first.id}/results`)).value.code,'stale_context');assert.equal((await h.request(`/queries/${first.id}/export.csv`)).status,409);
 await tool('update_analysis_task',{action:'route',task_id:derivedTask.task_id,expected_version:derivedTask.condition_version,goal:'',options:[]});await finish();
 checks.push('真实结果经get_query传递完整来源，新派生查询持久保留上游知识与结果引用；另轮撤源后正文/结果/导出均不回流且无递归');

 const queuedMarker='SYNTHETIC_QUEUED_SOURCE';const queuedSource=await source(queuedMarker);const queuedCid=await h.create();await begin(queuedCid,'明确执行这个合成查询。');const queuedTask=await task();await tool('read_knowledge',{object_id:queuedSource.id});const queued=await draft(queuedTask,queuedMarker);await execute(queued);const authorized=queryState(queued);await disable(queuedSource);await finish();await h.resumeWorker();
 await until(()=>queryState(queued).state==='failed','来源失效阻止首次平台提交');await h.pauseWorker();const rejected=queryState(queued);assert.equal(rejected.error,'stale_context');assert.equal(rejected.confirm,authorized.confirm);assert.equal(rejected.budget,authorized.budget);
 const lookup=await fetch(h.env.DATA_AGENT_PLATFORM_URL+'/lookup',{method:'POST',headers:{authorization:'Bearer '+h.env.DATA_AGENT_INTERNAL_TOKEN,'content-type':'application/json'},body:JSON.stringify({query_id:queued.id,owner_id:'alice'})});assert.equal(lookup.status,409);assert.equal((await lookup.json()).code,'not_available','未向平台创建已失效来源的查询');
 checks.push('确认后提交前来源失效持久准确终态，不调用平台submit、不改变原确认身份或预算');

 const unknownMarker='SYNTHETIC_UNKNOWN_QUERY_SOURCE';const unknownSource=await source(unknownMarker);const unknownCid=await h.create();await begin(unknownCid,'明确执行，再核对未知回执。');const unknownTask=await task();await tool('read_knowledge',{object_id:unknownSource.id});const unknown=await draft(unknownTask,unknownMarker);await execute(unknown);const unknownAuthorization=queryState(unknown);await finish();await h.pausePlatform();await h.resumeWorker();await until(()=>queryState(unknown).state==='submission_unknown','提交回执未知');await h.pauseWorker();await disable(unknownSource);
 control(ok(await h.request(`/queries/${unknown.id}/cancel`,{operation_id:randomUUID()})),unknownMarker);await h.resumePlatform();await h.resumeWorker();await until(()=>queryState(unknown).state==='cancelled','来源失效后仍查证平台取消');await h.pauseWorker();assert.equal(queryState(unknown).confirm,unknownAuthorization.confirm);assert.equal(queryState(unknown).budget,unknownAuthorization.budget);
 checks.push('未知回执来源失效仍可按原query身份查证并停止，不重授权或换预算');


 const preflightSource=await source('SYNTHETIC_PRECOMPILE_SOURCE');const preflightCid=await h.create();await begin(preflightCid,'先保存独立草稿，再调查资料。');const preflightTask=await task();const previous=await draft(preflightTask,'原合法草稿');await tool('read_knowledge',{object_id:preflightSource.id});await disable(preflightSource);await h.pausePlatform();
 const rejectedInput={task_id:preflightTask.task_id,condition_version:preflightTask.condition_version,sql:'SELECT :label AS label',parameters:{label:'不得发送失效来源'},target_id:'synthetic-sqlite',summary:'修订应先检查来源',knowledge_refs:[],replaces_query_id:previous.id};
 assert.equal((await invoke('request_query',rejectedInput)).value.code,'stale_context','失效run应在不可用平台检查之前拒绝');assert.equal((await invoke('validate_sql',{sql:'SELECT 1',parameters:{},target_id:'synthetic-sqlite'})).value.code,'stale_context');
 assert.equal(h.sql(`SELECT JSON_OBJECT('confirmation',confirmation_state,'n',(SELECT COUNT(*) FROM query_requests WHERE conversation_id='${preflightCid}')) FROM query_requests WHERE id='${previous.id}'`)[0].confirmation,'awaiting_confirmation');
 assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM query_requests WHERE conversation_id='${preflightCid}'`)[0].n,1);await h.resumePlatform();
 ok(await h.request(`/conversations/${preflightCid}`,{operation_id:randomUUID()},'alice','DELETE'));h.releaseRun(run.run_id);
 checks.push('撤源后先拒绝SQL外发及旧稿失效，未访问不可用平台、不新增草稿；validate_sql缺省引用保持兼容');

 const lines=ok(await h.request('/knowledge/table-raw_order_lines')),payments=ok(await h.request('/knowledge/table-raw_payments'));
 const relationSeed=ok(await h.request('/knowledge',{operation_id:randomUUID(),kind:'relationship',name:'SQL诊断的独立来源',body:'合成完整复合键关联',related_ids:[lines.id,payments.id]}));
 const relation=ok(await h.request(`/knowledge/${relationSeed.id}`,{operation_id:randomUUID(),expected_version:relationSeed.version,entry_id:'body',value:'合成一行对应多笔付款',structured_value:{kind:'relationship',left_table:{object_id:lines.id,version:lines.version},right_table:{object_id:payments.id,version:payments.version},join_keys:[{left_column:'order_id',right_column:'order_id'},{left_column:'line_id',right_column:'line_id'}],cardinality:'one_to_many',scope:'付款事件未预聚合'}},'alice','PATCH'));
 const diagnosticCid=await h.create();await begin(diagnosticCid,'仅检查SQL并显示业务诊断。');await tool('update_analysis_task',{action:'route',task_id:null,expected_version:null,goal:'',options:[]});await tool('read_knowledge',{object_id:relation.id});
 const diagnostic=await tool('validate_sql',{sql:'SELECT SUM(l.quantity) AS quantity FROM raw_order_lines l JOIN raw_payments p ON l.order_id=p.order_id AND l.line_id=p.line_id',parameters:{},target_id:'synthetic-sqlite',knowledge_refs:[{object_id:relation.id,version:relation.version,path:'body'},{object_id:lines.id,version:lines.version,path:'ddl'},{object_id:payments.id,version:payments.version,path:'ddl'}]});const diagnosticInput=lastInput;
 assert.equal(diagnostic.state,'passed');assert.ok(diagnostic.semantic_checks.checks.some(check=>check.evidence_refs.some(ref=>ref.object_id===relation.id)),'旧成功诊断确实采用来源');
 await disable(relation);await h.pausePlatform();const staleDiagnostic=await h.internal('/internal/data/tools',diagnosticInput);assert.equal(staleDiagnostic.value.code,'stale_context');assert.equal(staleDiagnostic.value.data,undefined,'原SDK成功重放不得返旧诊断');await h.resumePlatform();
 ok(await h.request(`/conversations/${diagnosticCid}`,{operation_id:randomUUID()},'alice','DELETE'));h.releaseRun(run.run_id);
 checks.push('validate_sql是只读检查，原SDK成功重放也先重核来源；撤源后不返旧诊断、不向平台重新发送旧SQL');

 const legacyCid=await h.create();await begin(legacyCid,'建立旧查询来源缺失夹具。');const legacyTask=await task();const legacy=await draft(legacyTask,'合成旧稿');h.sql(`UPDATE query_requests SET text_authority=NULL WHERE id='${legacy.id}'`);control((await tool('get_query',{query_id:legacy.id})).query,'合成旧稿');await finish();assert.equal((await h.request(`/queries/${legacy.id}/confirm`,{operation_id:randomUUID(),draft_version:legacy.draft_version,condition_version:legacy.condition_version})).value.code,'stale_context');
 checks.push('旧NULL来源查询不被假定为独立合法正文，状态可查而不能新确认');passed=true;
}finally {await writeFile('.local/checks/query-text-authority.json',JSON.stringify({passed,checks,officialRequests:0},null,2));await h.close();}
console.log(JSON.stringify({passed,checks,officialRequests:0}));

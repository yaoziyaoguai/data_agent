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
// 任务须显式声明来源范围（null为不限），草稿登记才视作范围已知。
const base={time_start:null,time_end:null,timezone:'UTC',metric:null,channel:null,group_by:[],filters:[],knowledge_refs:[],notes:'',source_limits:null};
// 口径决策记在任务条件版本上，草稿省略即继承；采纳说明随草稿持久化，撤源后仍属须隐藏的正文。
const task=marker=>tool('update_analysis_task',{action:'create',goal:'独立查询目标',conditions:{...base,semantic_resolution:{interpretation:marker,basis:'unambiguous',user_quote:null}},options:[]});
const source=marker=>h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'查询派生合成来源',body:marker,related_ids:[]}).then(ok);
const disable=doc=>h.request(`/knowledge/${doc.id}/disable`,{operation_id:randomUUID(),expected_version:doc.version}).then(ok);
const ref=(doc,path='body')=>({object_id:doc.id,version:doc.version,path});
const read=async(doc,path)=>{
 const reply=await tool('read_knowledge',{items:[{kind:'knowledge',ref:ref(doc,path)}]});
 assert.equal(reply.items[0].state,'ok');
};
const draft=(t,marker,knowledge_refs=[])=>tool('request_query',{task_id:t.task_id,condition_version:t.condition_version,sql:'SELECT :label AS label',parameters:{label:marker},target_id:'synthetic-sqlite',summary:marker,knowledge_refs,replaces_query_id:null});
const execute=q=>tool('execute_query',{query_id:q.id,draft_version:q.draft_version,condition_version:q.condition_version,instruction_quote:run.text});
const control=(query,marker)=>{assert.equal(query.text_unavailable,true);for(const key of ['sql','parameters','summary','knowledge_refs','error_details','semantic_checks','semantic_resolution'])assert.equal(query[key],undefined);assert.equal(JSON.stringify(query).includes(marker),false);};
const queryState=q=>h.sql(`SELECT JSON_OBJECT('state',execution_state,'error',error_code,'version',draft_version,'budget',budget_scope_id,'confirm',confirmation_key) FROM query_requests WHERE id='${q.id}'`)[0];
// 捕获替身必须实际收尾失败/取消通知；否则串行Worker会停在未回应的旧通知上。
const finishNotification=async(cid,q,t,state,marker)=>{
 run=await until(()=>h.captured.find(value=>value.conversation_id===cid&&value.workspace_context.result_notification?.query_id===q.id),'查询终态通知');
 await h.pauseWorker();manager=SessionManager.inMemory('/synthetic/data-agent');
 assert.deepEqual(run.workspace_context.result_notification,{query_id:q.id,execution_state:state,task_ref:{task_id:t.task_id,condition_version:t.condition_version}});
 assert.deepEqual(run.workspace_context.active_task_ref,{task_id:t.task_id,condition_version:t.condition_version});
 const reply=await tool('get_query',{query_id:q.id});control(reply.query,marker);assert.equal(reply.results,null);
 await finish();
};
try {
 const marker='SYNTHETIC_QUERY_SOURCE';const doc=await source(marker);const cid=await h.create();await begin(cid,'生成草稿，不执行。');
 const t=await task(marker);const syntax=await tool('validate_sql',{sql:'SELECT 1',parameters:{},target_id:'synthetic-sqlite'});assert.equal(syntax.state,'passed','validate_sql缺省knowledge_refs仍合法');await read(doc);const q=await draft(t,marker,[ref(doc)]);const original=lastInput;
 assert.equal(q.semantic_resolution.interpretation,marker,'草稿继承任务条件里的采纳说明');
 const searchHistory = async word => ok(await h.request('/queries?q='+encodeURIComponent(word)));
 assert.ok((await searchHistory(marker)).queries.some(row=>row.id===q.id));
 await disable(doc);control(ok(await h.internal('/internal/data/tools',original)).data,marker);await finish();
 await begin(cid,'核对已有草稿。');assert.equal(run.checkpoint,null);control((await tool('get_query',{query_id:q.id})).query,marker);
 control(ok(await h.request(`/queries/${q.id}`)),marker);control(ok(await h.request(`/conversations/${cid}/queries`)).queries.find(value=>value.id===q.id),marker);
 control(ok(await h.request('/queries')).queries.find(row=>row.id===q.id),marker);
 assert.deepEqual(await searchHistory(marker),{queries:[],next_before_id:null},'收回来源后不再通过搜索命中其正文');
 await tool('update_analysis_task',{action:'route',task_id:t.task_id,expected_version:t.condition_version,goal:'',options:[]});await finish();
 const confirmation=await h.request(`/queries/${q.id}/confirm`,{operation_id:randomUUID(),draft_version:q.draft_version,condition_version:q.condition_version});assert.equal(confirmation.value.code,'stale_context');assert.equal(queryState(q).state,'not_submitted');
 control(ok(await h.request(`/queries/${q.id}/cancel`,{operation_id:randomUUID()})),marker);assert.equal(queryState(q).state,'cancelled');
 checks.push('已采用来源停用后查询正文不可用；Agent/HTTP/list/成功重放只回控制，首次确认拒绝且取消可用');

 const descendantMarker='SYNTHETIC_DERIVED_QUERY_RESULT';const ancestor=await source(descendantMarker);const derivedCid=await h.create();await begin(derivedCid,'执行第一个合成查询，再基于结果生成草稿。');
 const derivedTask=await task(descendantMarker);await read(ancestor);const first=await draft(derivedTask,descendantMarker,[ref(ancestor)]);await execute(first);await finish();await h.resumeWorker();
 await until(()=>queryState(first).state==='succeeded','真实合成平台执行完成');run=await until(()=>h.captured.find(value=>value.conversation_id===derivedCid&&value.text.startsWith('[已确认查询结果事件]')),'接回结果通知');await h.pauseWorker();manager=SessionManager.inMemory('/synthetic/data-agent');
 await tool('update_analysis_task',{action:'route',task_id:derivedTask.task_id,expected_version:derivedTask.condition_version,goal:'',options:[]});
 const results=await tool('get_query',{query_id:first.id});assert.equal(results.query.summary,descendantMarker);assert.deepEqual(results.results.rows,[[descendantMarker]]);
 const second=await draft(derivedTask,descendantMarker+'派生',[ref(ancestor)]);
 assert.deepEqual(second.knowledge_refs,[ref(ancestor)]);
 assert.equal(ok(await h.request(`/queries/${second.id}`)).summary,descendantMarker+'派生');
 await finish();
 const crossCid=await h.create();await begin(crossCid,'验证跨会话来源的空间和删除边界。');
 await tool('update_analysis_task',{action:'route',task_id:null,expected_version:null,goal:'',options:[]});
 // 模型工具只处理当前会话的查询；跨会话读取已授权结果走HTTP，并核对原会话的空间与删除状态。
 assert.equal((await invoke('get_query',{query_id:first.id})).value.code,'not_available','模型工具不读取其他会话的查询');
 assert.deepEqual(ok(await h.request(`/queries/${first.id}/results`)).rows,[[descendantMarker]],
  '同用户同空间可读已授权的查询结果');
 assert.notEqual((await h.request(`/queries/${first.id}/results`,undefined,'bob')).status,200);
 h.sql(`UPDATE conversations SET space_id='synthetic-other-space' WHERE id='${derivedCid}'`);
 assert.notEqual((await h.request(`/queries/${first.id}/results`)).status,200);
 h.sql(`UPDATE conversations SET space_id='demo',deleted=TRUE WHERE id='${derivedCid}'`);
 assert.notEqual((await h.request(`/queries/${first.id}/results`)).status,200);
 h.sql(`UPDATE conversations SET deleted=FALSE WHERE id='${derivedCid}'`);
 assert.deepEqual(ok(await h.request(`/queries/${first.id}/results`)).rows,[[descendantMarker]]);
 await finish();
 checks.push('已授权结果经HTTP可跨同空间会话读取，模型工具只读当前会话的查询；其他用户、不同空间或已删除会话均不能读取');
 await disable(ancestor);await begin(derivedCid,'再核对派生草稿和旧结果。');control((await tool('get_query',{query_id:second.id})).query,descendantMarker);
 assert.equal((await h.request(`/queries/${first.id}/results`)).value.code,'stale_context');assert.equal((await h.request(`/queries/${first.id}/export.csv`)).status,409);
 await tool('update_analysis_task',{action:'route',task_id:derivedTask.task_id,expected_version:derivedTask.condition_version,goal:'',options:[]});await finish();
 checks.push('真实结果和新查询均按实际采用的正式知识来源核验；另轮撤源后正文/结果/导出均不回流且无递归');

 const queuedMarker='SYNTHETIC_QUEUED_SOURCE';const queuedSource=await source(queuedMarker);const queuedCid=await h.create();await begin(queuedCid,'明确执行这个合成查询。');const queuedTask=await task(queuedMarker);await read(queuedSource);const queued=await draft(queuedTask,queuedMarker,[ref(queuedSource)]);await execute(queued);const authorized=queryState(queued);await disable(queuedSource);await finish();await h.resumeWorker();
 await until(()=>queryState(queued).state==='failed','来源失效阻止首次平台提交');await finishNotification(queuedCid,queued,queuedTask,'failed',queuedMarker);const rejected=queryState(queued);assert.equal(rejected.error,'stale_context');assert.equal(rejected.confirm,authorized.confirm);assert.equal(rejected.budget,authorized.budget);
 const lookup=await fetch(h.env.DATA_AGENT_PLATFORM_URL+'/lookup',{method:'POST',headers:{authorization:'Bearer '+h.env.DATA_AGENT_INTERNAL_TOKEN,'content-type':'application/json'},body:JSON.stringify({query_id:queued.id,owner_id:'alice'})});assert.equal(lookup.status,409);assert.equal((await lookup.json()).code,'not_available','未向平台创建已失效来源的查询');
 checks.push('确认后提交前来源失效持久准确终态，不调用平台submit、不改变原确认身份或预算');

 const unknownMarker='SYNTHETIC_UNKNOWN_QUERY_SOURCE';const unknownSource=await source(unknownMarker);const unknownCid=await h.create();await begin(unknownCid,'明确执行，再核对未知回执。');const unknownTask=await task(unknownMarker);await read(unknownSource);const unknown=await draft(unknownTask,unknownMarker,[ref(unknownSource)]);await execute(unknown);const unknownAuthorization=queryState(unknown);await finish();await h.pausePlatform();await h.resumeWorker();await until(()=>queryState(unknown).state==='submission_unknown','提交回执未知');await h.pauseWorker();await disable(unknownSource);
 control(ok(await h.request(`/queries/${unknown.id}/cancel`,{operation_id:randomUUID()})),unknownMarker);await h.resumePlatform();await h.resumeWorker();await until(()=>queryState(unknown).state==='cancelled','来源失效后仍查证平台取消');await finishNotification(unknownCid,unknown,unknownTask,'cancelled',unknownMarker);assert.equal(queryState(unknown).confirm,unknownAuthorization.confirm);assert.equal(queryState(unknown).budget,unknownAuthorization.budget);
 checks.push('未知回执来源失效仍可按原query身份查证并停止，不重授权或换预算');


 const preflightSource=await source('SYNTHETIC_PRECOMPILE_SOURCE');const preflightCid=await h.create();await begin(preflightCid,'先保存独立草稿，再调查资料。');const preflightTask=await task('原合法草稿');const previous=await draft(preflightTask,'原合法草稿');await read(preflightSource);await disable(preflightSource);await h.pausePlatform();
 // 外发只按正式采用的来源拦截：修订显式采用已停用文档时须在平台预检之前拒绝；同轮读过但未采用不再让整轮失效。
 const rejectedInput={task_id:preflightTask.task_id,condition_version:preflightTask.condition_version,sql:'SELECT :label AS label',parameters:{label:'不得发送失效来源'},target_id:'synthetic-sqlite',summary:'修订应先检查来源',knowledge_refs:[ref(preflightSource)],replaces_query_id:previous.id};
 assert.equal((await invoke('request_query',rejectedInput)).value.code,'not_available','采用已停用来源的修订应在平台预检之前拒绝');
 assert.equal(h.sql(`SELECT JSON_OBJECT('confirmation',confirmation_state,'n',(SELECT COUNT(*) FROM query_requests WHERE conversation_id='${preflightCid}')) FROM query_requests WHERE id='${previous.id}'`)[0].confirmation,'awaiting_confirmation','被拒绝的修订不失效旧稿');
 assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM query_requests WHERE conversation_id='${preflightCid}'`)[0].n,1,'被拒绝的修订不新增草稿');await h.resumePlatform();
 const reread=await tool('read_knowledge',{items:[{kind:'knowledge',ref:ref(preflightSource)}]});
 assert.equal(reread.items[0].state,'not_available');assert.equal(reread.items[0].content,undefined,'同轮再读已停用文档无正文');
 assert.equal((await tool('validate_sql',{sql:'SELECT 1',parameters:{},target_id:'synthetic-sqlite'})).state,'passed','同轮读过已停用文档不阻断缺省引用的validate_sql');
 ok(await h.request(`/conversations/${preflightCid}`,{operation_id:randomUUID()},'alice','DELETE'));h.releaseRun(run.run_id);
 checks.push('撤源后采用该来源的修订在平台预检前拒绝，旧稿不失效、不新增草稿；同轮再读无正文，缺省引用的validate_sql保持兼容');

 const lines=ok(await h.request('/knowledge/table-raw_order_lines')),payments=ok(await h.request('/knowledge/table-raw_payments'));
 const relationSeed=ok(await h.request('/knowledge',{operation_id:randomUUID(),kind:'relationship',name:'SQL诊断的独立来源',body:'合成完整复合键关联',related_ids:[lines.id,payments.id]}));
 const relation=ok(await h.request(`/knowledge/${relationSeed.id}`,{operation_id:randomUUID(),expected_version:relationSeed.version,entry_id:'body',value:'合成一行对应多笔付款',structured_value:{kind:'relationship',left_table:{object_id:lines.id,version:lines.version},right_table:{object_id:payments.id,version:payments.version},join_keys:[{left_column:'order_id',right_column:'order_id'},{left_column:'line_id',right_column:'line_id'}],cardinality:'one_to_many',scope:'付款事件未预聚合'}},'alice','PATCH'));
 const diagnosticCid=await h.create();await begin(diagnosticCid,'仅检查SQL并显示业务诊断。');await tool('update_analysis_task',{action:'route',task_id:null,expected_version:null,goal:'',options:[]});await read(relation);
 const diagnostic=await tool('validate_sql',{sql:'SELECT SUM(l.quantity) AS quantity FROM raw_order_lines l JOIN raw_payments p ON l.order_id=p.order_id AND l.line_id=p.line_id',parameters:{},target_id:'synthetic-sqlite',knowledge_refs:[{object_id:relation.id,version:relation.version,path:'body'},{object_id:lines.id,version:lines.version,path:'ddl'},{object_id:payments.id,version:payments.version,path:'ddl'}]});const diagnosticInput=lastInput;
 assert.equal(diagnostic.state,'passed');assert.ok(diagnostic.semantic_checks.checks.some(check=>check.evidence_refs.some(ref=>ref.object_id===relation.id)),'旧成功诊断确实采用来源');
 // validate_sql与其他只读工具一样按当前来源重新核验：已停用的关系不再作为证据，依赖它的规则不报已检查并记为覆盖缺口。
 await disable(relation);const rechecked=ok(await h.internal('/internal/data/tools',diagnosticInput)).data;
 assert.ok(rechecked.semantic_checks.checks.every(check=>check.evidence_refs.every(ref=>ref.object_id!==relation.id)),'重新核验的诊断不再引用已停用关系');
 const dependent=new Set(diagnostic.semantic_checks.checks.filter(check=>check.evidence_refs.some(ref=>ref.object_id===relation.id)).map(check=>check.rule));
 assert.ok(rechecked.semantic_checks.checks.filter(check=>dependent.has(check.rule)).every(check=>check.state==='not_checked'),
  '依赖已停用关系的规则从报告中省略或记为未检查，不得报已检查或风险提示');
 assert.ok(rechecked.semantic_checks.coverage.missing_semantics.length>diagnostic.semantic_checks.coverage.missing_semantics.length,'失效来源记为覆盖缺口');
 assert.notDeepEqual(rechecked.semantic_checks,diagnostic.semantic_checks,'原SDK成功调用不返旧诊断');
 ok(await h.request(`/conversations/${diagnosticCid}`,{operation_id:randomUUID()},'alice','DELETE'));h.releaseRun(run.run_id);
 checks.push('validate_sql是只读检查，原SDK成功调用再次执行时按当前来源重新诊断；撤源后不返旧诊断，已停用关系不作证据、依赖它的规则不报已检查');

 const olderCid=await h.create();await begin(olderCid,'保留一份可搜索的独立历史草稿。');
 const olderDoc=await source('之后改版的合成说明');const olderTask=await task('分页时仍可见的历史');
 await read(olderDoc);
 const older=await draft(olderTask,'分页时仍可见的历史',[ref(olderDoc)]);await finish();
 const editedDoc=ok(await h.request('/knowledge/'+olderDoc.id,{operation_id:randomUUID(),expected_version:olderDoc.version,entry_id:'body',value:'新的合成说明'},'alice','PATCH'));
 assert.equal((await searchHistory('分页时仍可见的历史')).queries.find(row=>row.id===older.id).text_historical,true);
 const removedCid=await h.create();await begin(removedCid,'创建随后删除的独立会话。');
 const removed=await draft(await task('分页时仍可见的历史'),'分页时仍可见的历史');await finish();
 ok(await h.request('/conversations/'+removedCid,{operation_id:randomUUID()},'alice','DELETE'));
 // 从真实草稿复制合成候选，整页已删除会话不得遮住更老的可读记录。
 const fields='conversation_id,owner_id,task_id,condition_version,draft_version,sql_text,parameters,target_id,target_version,summary,knowledge_refs,check_state,budget_scope_id';
 const copyHistory=(id,count)=>h.sql(`INSERT INTO query_requests(id,operation_id,${fields})
   WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<${count})
   SELECT UUID(),UUID(),${fields} FROM query_requests CROSS JOIN seq WHERE id='${id}'`);
 copyHistory(removed.id,260);
 const visibleHistory=await searchHistory('分页时仍可见的历史');
 assert.deepEqual(visibleHistory.queries.map(row=>row.id),[older.id]);assert.equal(visibleHistory.next_before_id,null);
 copyHistory(older.id,50);
 const firstPage=await searchHistory('分页时仍可见的历史');
 assert.equal(firstPage.queries.length,50);
 assert.equal(firstPage.next_before_id,firstPage.queries.at(-1).id);
 const nextPage=ok(await h.request('/queries?'+new URLSearchParams({q:'分页时仍可见的历史',before_id:firstPage.next_before_id})));
 assert.deepEqual(nextPage.queries.map(row=>row.id),[older.id]);assert.equal(nextPage.next_before_id,null);
 await disable(editedDoc);
 assert.equal((await searchHistory('分页时仍可见的历史')).queries.length,0);
 checks.push('跨会话搜索只匹配可读正文，260条不可见候选之后的旧查询仍可找到');
 const field=ok(await h.request('/knowledge/field-quantity'));
 const meaning=field.entries.find(e=>e.path==='meaning');
 const confirmed=ok(await h.request('/knowledge/'+field.id,{operation_id:randomUUID(),expected_version:field.version,entry_id:meaning.entry_id,
   value:'商品件数',structured_value:meaning.effective_structure},'alice','PATCH'));
 const meaningRef={object_id:confirmed.id,version:confirmed.version,path:'meaning'};
 const columnCid=await h.create();await begin(columnCid,'执行这个数量查询。');const columnTask=await task('原数与换算列');
 await read(confirmed,'meaning');
 const annotated=await tool('request_query',{task_id:columnTask.task_id,condition_version:columnTask.condition_version,
   sql:'SELECT d.quantity AS item_count, d.quantity / 100.0 AS quantity FROM demo_order_detail d LIMIT 2',parameters:{},target_id:'synthetic-sqlite',
   summary:'原数与换算列',knowledge_refs:[meaningRef],replaces_query_id:null});
 await execute(annotated);await finish();await h.resumeWorker();
 await until(()=>queryState(annotated).state==='succeeded','合成平台交付结果');
 const result=ok(await h.request('/queries/'+annotated.id+'/results'));
 assert.equal(result.columns[0].display_label,'商品件数');assert.equal(result.columns[0].unit,'件');
 assert.equal(result.columns[1].unit,undefined);assert.equal(result.columns[1].display_label,undefined);
 checks.push('真实查询页按已确认字段给直接投影别名补单位，同名换算列保留原列头');
 passed=true;
}finally {await writeFile('.local/checks/query-text-authority.json',JSON.stringify({passed,checks,officialRequests:0},null,2));await h.close();}
console.log(JSON.stringify({passed,checks,officialRequests:0}));

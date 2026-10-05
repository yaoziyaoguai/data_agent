import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness} from './harness.mjs';
const h=await harness({capture:true,env:{DATA_AGENT_LEASE_MS:'120000'}}),manager=SessionManager.inMemory('/synthetic/data-agent');
let run,passed=false;const checks=[];
const invoke=async(name,args)=>{
 const input={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:randomUUID(),tool_name:name,arguments:args,checkpoint:exportCheckpoint(manager)};
 assert.equal((await h.internal('/internal/data/tool-calls',input)).status,200);const r=await h.internal('/internal/data/tools',input);assert.equal(r.status,200,JSON.stringify(r.value));return r.value.data;
};
const issue=()=>h.internal('/internal/model/issue',{run_id:run.run_id,lease_epoch:run.lease_epoch,call_attempt_id:randomUUID()});
const finish=async(text='已核对')=>{
 await invoke('update_analysis_task',{action:'route',task_id:null,expected_version:null,goal:'',question:null,options:[]});
 assert.equal((await h.internal('/internal/outputs',{run_id:run.run_id,lease_epoch:run.lease_epoch,chunk_seq:'1',text})).status,200);
 assert.equal((await h.internal('/internal/finish',{run_id:run.run_id,lease_epoch:run.lease_epoch,commit_id:run.output_id,final_text:text,checkpoint:exportCheckpoint(manager)})).status,200);h.releaseRun(run.run_id);
};
try{
 const assets=[];
 for(let i=0;i<24;i++)assets.push((await h.request('/assets',{operation_id:randomUUID(),id:null,expected_version:null,kind:'memory',name:'合成偏好'+i,body:'合成展示偏好'+i,scope:'仅本人展示',verified:false,source_text:'本人录入',dependencies:[]})).value);
 const cid=await h.create();run=await h.capture(cid,'读取相关表');await h.pauseWorker();
 const delivered=run.workspace_context.memories.map(v=>v.id),omitted=assets.find(v=>!delivered.includes(v.id));assert.ok(omitted);
 assert.deepEqual(new Set(run.workspace_context.authority_snapshot.memories.map(v=>v[0])),new Set(delivered));
 assert.equal((await h.request('/assets/'+omitted.id+'/disable',{operation_id:randomUUID(),expected_version:omitted.version})).status,200);
 assert.equal((await issue()).status,200);
 checks.push('启动材料裁剪后的实际记忆才登记依赖，被裁掉的记忆停用不影响会话');
 await invoke('read_knowledge',{object_id:'table-demo_order_detail'});await invoke('read_knowledge',{object_id:'table-raw_payments'});
 await finish('旧资料结论-A');
 const unused=(await h.request('/knowledge/table-customer_tags')).value;assert.equal((await h.request('/knowledge/'+unused.id+'/disable',{operation_id:randomUUID(),expected_version:unused.version})).status,200);
 await h.resumeWorker();run=await h.capture(cid,'继续聊另一个问题');await h.pauseWorker();
 assert.ok(run.checkpoint);const refs=run.workspace_context.authority_snapshot.knowledge;
 assert.ok(refs.some(v=>v[0]==='table-demo_order_detail'));assert.ok(refs.some(v=>v[0]==='table-raw_payments'));assert.ok(!refs.some(v=>v[0]===unused.id));assert.equal((await issue()).status,200);
 const consumed=(await h.request('/knowledge/table-demo_order_detail')).value;
 assert.equal((await h.request('/knowledge/'+consumed.id+'/disable',{operation_id:randomUUID(),expected_version:consumed.version})).status,200);
 assert.equal((await issue()).value.code,'stale_context');
 checks.push('跨轮保留Pi检查点的早期读取依赖；无关改版不重建，旧已读资料撤回仍阻止模型发送');
 assert.equal((await h.request('/conversations/'+cid+'/messages/'+run.message_id+'/withdraw',{operation_id:randomUUID()})).status,200);h.releaseRun(run.run_id);
 h.sql(`UPDATE pi_checkpoints SET checkpoint=JSON_REMOVE(checkpoint,'$.authority_snapshot.dependency_schema') WHERE recovery_chain_id IN (SELECT recovery_chain_id FROM conversation_messages WHERE conversation_id='${cid}')`);
 await h.resumeWorker();run=await h.capture(cid,'重新调查新问题');await h.pauseWorker();assert.equal(run.checkpoint,null);assert.equal(run.workspace_context.authority_snapshot.dependency_schema,1);assert.equal((await issue()).status,200);
 checks.push('旧检查点没有完整依赖清单时新输入重建，不把缺失清单当空依赖通过');
 await finish();await h.resumeWorker();run=await h.capture(cid,'重建后的下一轮继续');await h.pauseWorker();
 assert.ok(run.checkpoint);assert.ok(!JSON.stringify(run.workspace_context.recent_messages).includes('旧资料结论-A'));assert.ok(run.workspace_context.recent_messages.every(v=>v.role==='user'));assert.ok(!run.workspace_context.authority_snapshot.knowledge.some(v=>v[0]==='table-demo_order_detail'));
 checks.push('重建完成后的后续轮次也不会从短历史重新混入旧助手结论，助手历史沿用Pi检查点');
 passed=true;console.log(JSON.stringify({passed,checks,officialRequests:0}));
}finally{await writeFile('.local/checks/mvp-context-dependencies.json',JSON.stringify({passed,checks,officialRequests:0},null,2));await h.close();}

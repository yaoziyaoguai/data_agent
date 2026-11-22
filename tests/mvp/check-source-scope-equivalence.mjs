import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {harness} from './harness.mjs';
import {exportCheckpoint,restoreCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {RustTransport} from '../../apps/agent/transport/client.ts';
import {dataTools} from '../../apps/agent/tools/data-tools.ts';
import {taskProjection} from '../../apps/agent/session/task-projection.ts';
import {workspaceContext} from '../../apps/agent/session/workspace-context.ts';

// 比较的是当前真实许可集合；消息身份与数组排版不应清掉仍有效的资料。
const result={passed:false,officialRequests:0,steps:[]};
let h,run,manager,transport,projection,data;
const bind=()=>{
 const workspace=workspaceContext(run.workspace_context);
 transport=new RustTransport(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN);
 projection=taskProjection(transport,manager,workspace.replace);
 data=dataTools(transport,manager,'',(receipt,sdk)=>{workspace.acceptReceipt(receipt);projection.acceptReceipt(receipt,sdk);});
};
const invoke=async(name,args)=>{
 const sdk=randomUUID();manager.appendMessage({role:'assistant',content:[{type:'toolCall',id:sdk,name,arguments:args}],api:'openai-completions',provider:'synthetic',model:'synthetic',stopReason:'toolUse',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
 const receipt=await data.invokeRecorded(name,sdk,args);assert.ok(!receipt.data.error,JSON.stringify(receipt.data));
 manager.appendMessage({role:'toolResult',toolCallId:sdk,toolName:name,...await data.formatResult(name,args,receipt),timestamp:Date.now()});return receipt;
};
try{
 h=await harness({capture:true,startWorker:false,env:{DATA_AGENT_LEASE_MS:'120000',DATA_AGENT_TOOL_CONTRACT_VERSION:'2',DATA_AGENT_PREFILL_PROFILE:''}});
 const cid=await h.create();await h.resumeWorker();run=await h.capture(cid,'工程核对2024年九月，仅使用业务指南及schema。');await h.pauseWorker();
 manager=SessionManager.inMemory('/synthetic/source-scope-equivalence');manager.appendMessage({role:'user',content:run.text,timestamp:Date.now()});bind();
 const sessionId=manager.getHeader().id,firstMessage=run.message_id,key=id=>({kind:'platform',id}),sources=[key('business-guide'),key('schema')];
 const created=await invoke('update_analysis_task',{action:'create',goal:run.text,conditions:{time_start:'2024-09-01T00:00:00Z',time_end:'2024-10-01T00:00:00Z',timezone:'UTC',metric:null,channel:null,group_by:[],filters:[],knowledge_refs:[],notes:'',source_limits:{allowed_sources:sources,origin_message_ids:[]}},options:[]});
 await projection.apply();const task=created.data.task_id;let version=created.data.condition_version;
 const source=await invoke('read_source',{citation:{source:key('business-guide'),revision:'1',locator:{offset:0,length:10}}});assert.equal(source.data.text,'# 虚构零售业务说明');
 const revise=async(label,set)=>{
  const before=manager.getEntries().filter(e=>e.type==='compaction').length;
  const receipt=await invoke('update_analysis_task',{action:'revise',task_id:task,expected_version:version,goal:'',condition_patch:{set,unset:[]},options:[]});version=receipt.data.condition_version;
  const applied=await projection.apply(),after=manager.getEntries().filter(e=>e.type==='compaction').length;
  const step={label,context_reset:receipt.context_reset??null,projection_applied:applied,native_compactions_added:after-before};result.steps.push(step);return {step,receipt};
 };
 const month=await revise('同任务只改月份、来源省略继承',{time_start:'2024-08-01T00:00:00Z',time_end:'2024-09-01T00:00:00Z'});assert.equal(month.step.context_reset,null);assert.equal(month.step.native_compactions_added,0);
 const reordered=await revise('同一允许集只调顺序',{source_limits:{allowed_sources:[...sources].reverse(),origin_message_ids:[]}});
 assert.equal(reordered.step.context_reset,null,'同一允许集重排不能清除仍有效的上下文');assert.equal(reordered.step.native_compactions_added,0);
 const originalRun=run;const finalText='工程来源核对完成。';await transport.post('/internal/outputs','AppendOutput',{...transport.binding(),chunk_seq:'1',text:finalText});
 await transport.post('/internal/finish','FinishRun',{...transport.binding(),commit_id:run.output_id,final_text:finalText,checkpoint:exportCheckpoint(manager)});h.releaseRun(run.run_id);
 await h.resumeWorker();run=await h.capture(cid,'仍使用业务指南和schema，继续刚才任务。');await h.pauseWorker();assert.notEqual(run.message_id,firstMessage);
 transport=new RustTransport(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN);let checkpoint=run.checkpoint;
 if(checkpoint?.storage?.kind==='host_checkpoint'){
  const saved=await transport.post('/internal/checkpoints/read','ReadCheckpoint',transport.binding(),checkpoint.storage.fingerprint);
  assert.equal(saved.leaf_id,checkpoint.leaf_id);assert.equal(saved.storage,undefined);checkpoint=saved;
 }
 manager=restoreCheckpoint('/synthetic/source-scope-equivalence',checkpoint);assert.equal(manager.getHeader().id,sessionId);manager.appendMessage({role:'user',content:run.text,timestamp:Date.now()});bind();
 const repeated=await revise('跨消息重申相同允许集',{source_limits:{allowed_sources:sources,origin_message_ids:[]}});
 assert.equal(repeated.step.context_reset,null,'仅声明消息身份改变不能清除同一范围上下文');assert.equal(repeated.step.native_compactions_added,0);
 assert.deepEqual(repeated.receipt.data.conditions.source_limits.origin_message_ids,[run.message_id],'新声明仍绑定本轮真实消息，不复用旧许可来源身份');
 const narrowed=await revise('实际收紧到schema',{source_limits:{allowed_sources:[key('schema')],origin_message_ids:[]}});assert.ok(narrowed.step.context_reset);assert.equal(narrowed.step.native_compactions_added,0,'实际范围变化从原生分支接续');
 assert.equal(manager.getHeader().id,sessionId);
 assert.ok(JSON.stringify(manager.getEntries()).includes(source.data.text),'原始证据仍保存在同一会话树');
 assert.equal(JSON.stringify(manager.buildSessionContext().messages).includes(source.data.text),false,'真正收紧后旧来源正文仍须移出');
 result.model_calls=h.sql(`SELECT JSON_OBJECT('count',COUNT(*)) FROM model_call_attempts WHERE budget_scope_id IN ('${originalRun.budget_scope_id}','${run.budget_scope_id}')`)[0].count;assert.equal(result.model_calls,0);result.passed=true;
}catch(error){result.error=error.stack;throw error;}
finally{if(h){if(run)h.releaseRun(run.run_id);await h.close();}await mkdir('.local/checks',{recursive:true});await writeFile('.local/checks/source-scope-equivalence.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));}

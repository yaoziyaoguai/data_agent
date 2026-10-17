import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {ModelRuntime, SessionManager} from '@earendil-works/pi-coding-agent';
import {createAssistantMessageEventStream, getCurrentTools} from '@earendil-works/pi-ai';
import {getModel} from '@earendil-works/pi-ai/compat';
import {streamSimple} from '@earendil-works/pi-ai/api/openai-completions';
import {deliver} from '../../apps/agent/session/deliver.ts';
import {buildSystemPromptState} from '../../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js';
import {RustTransport} from '../../apps/agent/transport/client.ts';
import {exportCheckpoint, restoreCheckpoint} from '../../apps/agent/session/checkpoint.ts';

// 真实Pi循环、工具与检查点；宿主回执和模型输出均为确定性合成替身。
const originalPost=RustTransport.prototype.post, originalRegister=ModelRuntime.prototype.registerProvider;
const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const memory=(id,version,body)=>({id,version,body,kind:'memory',name:body,scope:'仅合成订单分析',state:'enabled',verified:false,source_text:'',dependencies:[],selected:false,content_page:{offset:0,total_chars:[...body].length,complete:true,next_offset:null}});
const first=memory('memory-channel','1','合成旧偏好：默认web'), second=memory('memory-unit','1','合成金额用元'), revised=memory('memory-channel','2','合成新偏好：默认app');
const envelope=(memories,checkpoint=null,resume=false)=>({text:'修改合成偏好后继续分析',checkpoint,resume_same_input:resume,attempt_id:randomUUID(),budget_scope_id:randomUUID(),conversation_id:'memory-context',lease_epoch:'2',message_id:randomUUID(),model_profile:null,output_id:randomUUID(),recovery_chain_id:randomUUID(),request_id:randomUUID(),run_id:randomUUID(),workspace_context:{tasks:[],memories,selected_skills:[],recent_messages:[],query_observations:[],authority_revision:'a',authority_snapshot:{knowledge:[],memories:memories.map(v=>[v.id,v.version]),skills:[]}}});
const args=(action,id,version)=>action==='disable_memory'?{action,asset_id:id,expected_version:version}:{action,asset_id:id,expected_version:version,name:'模型候选标签',body:'模型候选正文不能用于投影',scope:'合成范围',verified:false,dependencies:[],instruction_quote:'修改合成偏好后继续分析'};
const toolCall=(id,arguments_)=>({type:'toolCall',id,name:'manage_personal_asset',arguments:arguments_});
const plan=[toolCall('reject-change',args('update_memory',first.id,'0')),toolCall('accept-change',args('update_memory',first.id,'1')),toolCall('accept-disable',args('disable_memory',second.id,'1'))];
let step=0, final, contexts=[], replayIds=[], passed=false;
const checks=[];
const legacyWorkspaceMarker='旧系统提示含工作区标记-不应继续注入';
function text(message){return typeof message.content==='string'?message.content:(message.content??[]).filter(v=>v.type==='text').map(v=>v.text).join('\n');}
function reference(context){const matches=context.messages.filter(v=>text(v).startsWith('个人记忆参考：'));assert.equal(matches.length,1,'每次普通请求恰有一份当前记忆参考');assert.equal(matches[0].role,'user');return JSON.parse(text(matches[0]).split('\n').slice(1).join('\n')).memories;}
try {
 RustTransport.prototype.post=async function(path,_name,input){
  if(path==='/internal/finish')final=input;
  if(path!=='/internal/data/tools')return {};
  replayIds.push(input.sdk_tool_call_id);
  const data=input.tool_name==='update_analysis_task'&&input.arguments.action==='route'?{task_id:'task-current',condition_version:'1'}:input.tool_name==='update_analysis_task'?{task_id:'task-current',condition_version:'2',conditions:{notes:'新条件来自成功回执'}}:input.sdk_tool_call_id==='reject-change'?{error:'version_conflict'}:input.arguments.action==='disable_memory'?{...second,version:'2',state:'disabled'}:revised;
  return {operation_id:'op-'+input.sdk_tool_call_id,tool_name:input.tool_name,data};
 };
 ModelRuntime.prototype.registerProvider=function(name,config){return originalRegister.call(this,name,{...config,streamSimple(model,context){
  contexts.push(structuredClone(context));
  const call=plan[step++];const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,content:call?[call]:[{type:'text',text:'已按成功回执处理合成记忆。'}],stopReason:call?'toolUse':'stop',usage,timestamp:Date.now()};
  const stream=createAssistantMessageEventStream();stream.push({type:'start',partial:message});if(!call)stream.push({type:'text_delta',contentIndex:0,delta:message.content[0].text,partial:message});stream.push({type:'done',reason:message.stopReason,message});return stream;
 }});};
 const history=SessionManager.inMemory('/synthetic/data-agent');
 history.appendMessage({role:'system',...buildSystemPromptState({customPrompt:legacyWorkspaceMarker,selectedTools:[],cwd:'/synthetic/data-agent',skills:[],contextFiles:[]}),timestamp:0});
 history.appendMessage({role:'user',content:'历史问题原文',timestamp:1});
 history.appendMessage({role:'assistant',api:'openai-completions',provider:'local_mock',model:'task_demo',content:[{type:'text',text:'历史回答原文'}],stopReason:'stop',usage,timestamp:2});
 const run=envelope([first,second],exportCheckpoint(history));
 run.workspace_context.request_clock={reference_time_utc:'2026-10-17T01:00:00Z',business_timezone:'Asia/Shanghai'};
 run.workspace_context.recent_messages=[{role:'user',text:'不应重复注入的短副本',attempt_id:null,committed:true}];
 const original=structuredClone(run.workspace_context);
 await deliver(run,'http://127.0.0.1','synthetic','');
 assert.equal(contexts.length,4);
 for(const context of contexts){
  const system=context.messages.filter(v=>v.role==='system').map(v=>text(v)+'\n'+Object.values(v.sections??{}).join('\n')).join('\n');
  assert.ok(!system.includes(first.body)&&!system.includes(second.body),'个人记忆正文不进入system');
  assert.match(system,/本次明确条件优先/);
  assert.ok(!system.includes(run.workspace_context.request_clock.reference_time_utc));
  const workspaceIndex=context.messages.findIndex(v=>text(v).startsWith('当前宿主事实：'));
  assert.equal(context.messages.filter(v=>text(v).startsWith('当前宿主事实：')).length,1);
  assert.ok(workspaceIndex>context.messages.findIndex(v=>text(v)==='历史回答原文'),'当前工作区位于已恢复历史之后');
  assert.ok(workspaceIndex<context.messages.findLastIndex(v=>text(v)===run.text),'资料先于本轮输入及其工具回执');
  assert.ok(!JSON.stringify(context).includes('不应重复注入的短副本'));
  assert.ok(getCurrentTools(context.messages).some(v=>v.name==='manage_personal_asset'));
  // 旧system可保留在会话日志中；核对真实SDK最终请求，不能只检查新system或当前时钟。
  let captured=false, networkAttempts=0;
  const serialized=streamSimple(getModel('deepseek','deepseek-flash'),context,{
   apiKey:'synthetic-offline',maxRetries:0,
   fetch:async()=>{networkAttempts++;throw new Error('network_forbidden');},
   onPayload(payload){
    assert.ok(!JSON.stringify(payload).includes(legacyWorkspaceMarker),'旧检查点中的动态system内容不能重新进入实际模型请求');
    captured=true;throw new Error('offline_capture_complete');
   },
  });
  for await(const event of serialized)if(event.type==='error')assert.match(event.error.errorMessage,/offline_capture_complete/);
  assert.equal(captured,true);assert.equal(networkAttempts,0);
 }
 assert.deepEqual(contexts.map(v=>reference(v).map(m=>m.id)),[[first.id,second.id],[first.id,second.id],[second.id],[]]);
 assert.deepEqual(reference(contexts[0])[0],first);
 assert.deepEqual(run.workspace_context,original,'投影不改宿主快照或authority');
 assert.ok(contexts[2].messages.some(v=>v.role==='toolResult'&&text(v).includes(revised.body)),'新正文来自成功回执');
 assert.ok(!JSON.stringify(reference(contexts[2])).includes('模型候选正文'));
 const restored=restoreCheckpoint('/synthetic/data-agent',final.checkpoint);
 assert.ok(!/data_agent_(memories|workspace)/.test(JSON.stringify(restored.getEntries())),'临时参考消息不进入Pi日志');
 checks.push('旧检查点system动态正文不进入实际SDK请求；system与记忆参考分离，拒绝保留候选，成功修订/停用撤旧，新正文只取回执，投影不改宿主authority也不写日志');
 const checkpoint=final.checkpoint;
 for(const memories of [[revised],[]]){
  contexts=[];await deliver(envelope(memories,checkpoint),'http://127.0.0.1','synthetic','');
  assert.equal(contexts.length,1);assert.deepEqual(reference(contexts[0]),memories);
  assert.equal(contexts[0].messages.filter(v=>text(v)===run.text).length,2,'相同文字的两条真实消息仍各自保留，不能按文本去重');
  assert.equal(contexts[0].messages.filter(v=>text(v).startsWith('当前宿主事实：')).length,1);
  assert.equal(restoreCheckpoint('/synthetic/data-agent',final.checkpoint).getHeader().id,restored.getHeader().id);
 }
 checks.push('同一Pi会话的新运行替换快照，空记忆不继承旧参考');
 const taskRun=envelope([]);
 taskRun.workspace_context.tasks=[{id:'task-current',condition_version:'1',conditions:{notes:'旧条件候选'}}];
 taskRun.workspace_context.input_task_ids=['task-current'];
 plan.splice(0,plan.length,{type:'toolCall',id:'task-route',name:'update_analysis_task',arguments:{action:'route',goal:'',task_id:'task-current',expected_version:'1',options:[]}},{type:'toolCall',id:'task-revise',name:'update_analysis_task',arguments:{action:'revise',goal:'',task_id:'task-current',expected_version:'1',condition_patch:{set:{notes:'新条件来自成功回执'},unset:[]},options:[]}});step=0;contexts=[];
 await deliver(taskRun,'http://127.0.0.1','synthetic','');
 const facts=context=>JSON.parse(text(context.messages.find(v=>text(v).startsWith('当前宿主事实：'))).split('\n').slice(1).join('\n'));
 assert.equal(facts(contexts[0]).tasks[0].conditions.notes,'旧条件候选');
 assert.equal(facts(contexts[1]).tasks[0].conditions.notes,'旧条件候选','同版route回执不带正文，必须保留当前条件避免额外补读');
 assert.deepEqual(facts(contexts[2]).tasks,[],'成功修订后撤下旧任务候选');
 assert.ok(contexts[2].messages.some(v=>v.role==='toolResult'&&text(v).includes('新条件来自成功回执')));
 assert.equal(taskRun.workspace_context.tasks[0].condition_version,'1','临时投影不改宿主原快照');
 checks.push('当前工作区在历史之后、本轮输入之前且不持久化；真实同文消息保留，成功任务回执撤旧');
 const manager=SessionManager.inMemory('/synthetic/data-agent');
 manager.appendMessage({role:'user',content:'修改合成偏好后继续分析',timestamp:Date.now()});
 manager.appendMessage({role:'assistant',api:'openai-completions',provider:'local_mock',model:'task_demo',content:[toolCall('restore-change',args('update_memory',first.id,'1'))],stopReason:'toolUse',usage,timestamp:Date.now()});
 contexts=[];replayIds=[];
 await deliver(envelope([first,second],exportCheckpoint(manager),true),'http://127.0.0.1','synthetic','');
 assert.deepEqual(replayIds,['restore-change']);assert.deepEqual(reference(contexts[0]).map(v=>v.id),[second.id]);
 assert.ok(contexts[0].messages.some(v=>v.role==='toolResult'&&v.toolCallId==='restore-change'&&text(v).includes(revised.body)));
 checks.push('半轮恢复先接回原SDK调用成功回执，首次模型请求已撤下旧候选');
 passed=true;console.log(JSON.stringify({passed,checks,officialRequests:0}));
} finally {
 RustTransport.prototype.post=originalPost;ModelRuntime.prototype.registerProvider=originalRegister;
 await mkdir('.local/checks',{recursive:true});await writeFile('.local/checks/memory-context.json',JSON.stringify({passed,checks,officialRequests:0},null,2));
}

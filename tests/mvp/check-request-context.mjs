import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {getModel} from '@earendil-works/pi-ai/compat';
import {getSystemMessageText} from '@earendil-works/pi-ai';
import {streamSimple} from '@earendil-works/pi-ai/api/openai-completions';
import {convertToLlm} from '@earendil-works/pi-coding-agent';
import {buildSystemPromptState} from '../../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js';
import {resources} from '../../apps/agent/session/resources.ts';
import {workspaceContext} from '../../apps/agent/session/workspace-context.ts';
import {estimateRequestBytes} from '../../apps/agent/session/request-size.ts';
import {dataTools} from '../../apps/agent/tools/data-tools.ts';
import {guardedDeepSeekStream} from '../../apps/agent/provider/deepseek.ts';

// 固定Pi版本的真实序列化器；onPayload捕获后即停止，禁止网络与宿主预留。
let networkAttempts=0, hostCalls=0;
const catalog=getModel('deepseek','deepseek-flash');
const model={...catalog,provider:'controlled_deepseek',compat:{...catalog.compat,supportsStrictMode:false},maxTokens:2048,contextWindow:32768};
const tools=dataTools({},null,'').tools;
const system={role:'system',...buildSystemPromptState({customPrompt:resources(true).getSystemPrompt(),selectedTools:tools.map(t=>t.name),cwd:'/synthetic/data-agent',skills:[],contextFiles:[]}),toolsAdded:tools.map(({name,description,parameters})=>({name,description,parameters})),timestamp:1};
const systemPrompt=getSystemMessageText(system);
const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const assistant=content=>({role:'assistant',content,api:model.api,provider:model.provider,model:model.id,stopReason:'stop',timestamp:3,usage});
const input='继续核对合成条件中的否定与例外，不要执行SQL。';
const makeWorkspace=day=>({tasks:[{id:'synthetic-task',goal:'合成目标',condition_version:'1',conditions:{notes:'条件\\引号"与\n换行'}}],recent_messages:[],selected_skills:[],memories:[{id:'memory-a',version:'1',kind:'memory',body:'合成参考；本次明确条件优先'}],query_observations:[],input_task_ids:[],request_clock:{reference_time_utc:`2026-10-${day}T00:00:00Z`,business_timezone:'Asia/Shanghai'},authority_revision:'synthetic',authority_snapshot:{private:'不能进入模型'}});
const bytes=value=>Buffer.byteLength(JSON.stringify(value));
const makeHistory=repeat=>Array.from({length:4},(_,i)=>i%2===0?{role:'user',content:'合成'.repeat(repeat),timestamp:2+i}:assistant([{type:'text',text:'合成'.repeat(repeat)}]));
const legacyBytes=(history,workspace,projection)=>bytes(history.map(({role,content})=>({role,content})))+bytes({...workspace,memories:undefined,authority_revision:undefined,authority_snapshot:undefined})+Buffer.byteLength(projection.contents()[1])+Buffer.byteLength(input)+bytes(tools.map(({name,description,parameters})=>({name,description,parameters})))+4096;
// 用旧预检允许的边界构造历史；不依赖新估算器或SDK实际输出反写通过预期。
// 固定900/950次重复会随工具说明与Schema变大而越过旧阈值，漏掉原本存在的低估区间。
const boundaryWorkspace=makeWorkspace('16'),boundaryProjection=workspaceContext(boundaryWorkspace);
const oneRepeatBytes=legacyBytes(makeHistory(1),boundaryWorkspace,boundaryProjection);
const repeatBytes=legacyBytes(makeHistory(2),boundaryWorkspace,boundaryProjection)-oneRepeatBytes;
assert.ok(repeatBytes>0);
const boundaryRepeat=1+Math.floor((65536-4096-oneRepeatBytes)/repeatBytes);
assert.ok(boundaryRepeat>0,'完整工具集应留出可复现旧预检漏报的历史空间');
assert.ok(legacyBytes(makeHistory(boundaryRepeat),boundaryWorkspace,boundaryProjection)<=65536-4096);
assert.ok(legacyBytes(makeHistory(boundaryRepeat+1),boundaryWorkspace,boundaryProjection)>65536-4096);
const measurements=[];
let falseNegative, previousHead;
for(const repeat of new Set([0,100,900,950,boundaryRepeat])){
  const history=makeHistory(repeat);
  for(const day of ['16','17']){
    const workspace=makeWorkspace(day), projection=workspaceContext(workspace);
    const {messages}=await projection.extension.handlers.get('context')[0]({messages:[...history,{role:'user',content:input,timestamp:10}]});
    const context={messages:convertToLlm([system,...messages])};
    let payload;
    const stream=streamSimple(model,context,{apiKey:'synthetic-offline',maxRetries:0,maxTokens:2048,fetch:async()=>{networkAttempts++;throw new Error('network_forbidden');},onPayload(value){
      payload=JSON.parse(JSON.stringify({...value,model:model.id,max_tokens:2048,thinking:{type:'disabled'},stream_options:{include_usage:true}}));
      throw new Error('offline_capture_complete');
    }});
    for await(const event of stream)if(event.type==='error')assert.match(event.error.errorMessage,/offline_capture_complete/);
    assert.ok(payload);
    const head=payload.messages.filter(message=>message.role==='system');
    assert.equal(head.length,1);
    assert.ok(!JSON.stringify(head).includes(workspace.request_clock.reference_time_utc));
    assert.ok(!JSON.stringify(payload).includes('不能进入模型'));
    if(previousHead)assert.deepEqual(head,previousHead,'跨轮时钟变化不改变稳定系统提示');
    previousHead=head;
    assert.equal(payload.messages.filter(message=>(typeof message.content==='string'?message.content:(message.content??[]).map(part=>part.text??'').join('\n')).startsWith('当前宿主事实：')).length,1);
    const estimate=estimateRequestBytes(systemPrompt,convertToLlm(history),tools,projection.contents(),input);
    assert.ok(estimate>=bytes(payload),'保守预检必须覆盖实际SDK载荷、系统提示、工具与转义');
    const legacyEstimate=legacyBytes(history,workspace,projection);
    measurements.push({repeat,day,estimate,legacyEstimate,actual:bytes(payload)});
    if(legacyEstimate<=65536-4096&&bytes(payload)>65536){
      assert.ok(estimate>65536-4096,'旧预检漏报的真实载荷现在必须提前触发原生compact');
      falseNegative=context;
    }
  }
}
assert.ok(falseNegative,'夹具必须复现旧公式未提前压缩、实际SDK载荷却超64KiB');
const profile={toolset:'data',model_id:model.id,output_limit:2048,input_limit:32768,payload_bytes_limit:65536};
const guarded=guardedDeepSeekStream({run:{},binding:()=>({}),post:async()=>{hostCalls++;throw new Error('host_call_forbidden');}},profile,{apiKey:'synthetic-offline',baseUrl:'http://127.0.0.1:1',protocolTest:true},new AbortController().signal);
const events=[];for await(const event of guarded(model,falseNegative))events.push(event);
assert.equal(events.at(-1).type,'error');
assert.equal(events.at(-1).error.errorMessage,'request_too_large: model_input_limit');
assert.equal(hostCalls,0,'超限请求不能预留或发送');
assert.equal(networkAttempts,0);
// 新回执来自同一查询但read工具有嵌套边界；旧启动快照不得继续与真实回执冲突。
const formatting = dataTools({}, null, '');
const queryStates = ['not_submitted', 'queued', 'running', 'succeeded', 'submission_unknown'];
for (const state of queryStates) {
  for (const name of ['get_query', 'request_query']) {
    const initial = makeWorkspace('19');
    initial.query_observations = [{id: 'query-a', execution_state: 'not_submitted'}, {id: 'query-b', execution_state: 'running'}];
    const projection = workspaceContext(initial);
    const query = {id: 'query-a', execution_state: state};
    const receipt = {tool_name: name, data: name === 'get_query' ? {query} : query};
    projection.acceptReceipt(receipt);
    const projected = await projection.extension.handlers.get('context')[0]({messages: [{role: 'user', content: input, timestamp: 10}]});
    const facts = JSON.parse(projected.messages.find(m => m.customType === 'data_agent_workspace').content.split('\n').slice(1).join('\n'));
    assert.deepEqual(facts.query_observations.map(q => q.id), ['query-b'], '已读取查询撤下旧状态，其他查询保持');
    const formatted = JSON.parse((await formatting.formatResult(name, {}, receipt)).content[0].text);
    assert.ok(formatted.status_note);
    assert.deepEqual(name === 'get_query' ? formatted.query : {id: formatted.id, execution_state: formatted.execution_state}, query);
    if (state === 'not_submitted') assert.match(formatted.status_note, /未提交/);
    if (state === 'submission_unknown') assert.match(formatted.status_note, /未知/);
  }
}
const rejection = {tool_name: 'execute_query', data: {error: 'version_conflict', hint: '先读取当前状态', recovery: {reason: 'version_conflict', read_tool: 'get_query', new_execution_authorized: false}}};
const rejected = await formatting.formatResult('execute_query', {}, rejection);
assert.equal(rejected.isError, true);
assert.deepEqual(JSON.parse(rejected.content[0].text), rejection.data, '恢复字段实际进入模型文本，不只留在SDK details');
await mkdir('.local/checks',{recursive:true});
const result={passed:true,measurements,boundaryRepeat,repeatBytes,
  systemPromptBytes:Buffer.byteLength(systemPrompt),
  toolBytes:bytes(tools.map(({name,description,parameters})=>({name,description,parameters}))),
  networkAttempts,hostCalls,officialRequests:0};
await writeFile('.local/checks/request-context.json',JSON.stringify(result,null,2));
console.log(JSON.stringify(result));

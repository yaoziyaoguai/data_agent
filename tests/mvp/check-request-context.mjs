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
const measurements=[];
let falseNegative, previousHead;
for(const repeat of [0,100,900,950]){
  const history=Array.from({length:4},(_,i)=>i%2===0?{role:'user',content:'合成'.repeat(repeat),timestamp:2+i}:assistant([{type:'text',text:'合成'.repeat(repeat)}]));
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
    const legacyEstimate=bytes(history.map(({role,content})=>({role,content})))+bytes({...workspace,memories:undefined,authority_revision:undefined,authority_snapshot:undefined})+Buffer.byteLength(projection.contents()[1])+Buffer.byteLength(input)+bytes(tools.map(({name,description,parameters})=>({name,description,parameters})))+4096;
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
await mkdir('.local/checks',{recursive:true});
const result={passed:true,measurements,networkAttempts,hostCalls,officialRequests:0};
await writeFile('.local/checks/request-context.json',JSON.stringify(result,null,2));
console.log(JSON.stringify(result));

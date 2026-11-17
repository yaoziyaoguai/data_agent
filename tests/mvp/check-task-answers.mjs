import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {deliver} from '../../apps/agent/session/deliver.ts';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness} from './harness.mjs';

// 真实Pi、本地协议与持久输出核对任务交接；预期来自逐任务交付合同，不模拟模型理解。
const firstAnswer = '合成甲任务按原资料分别记录开始与完成。🪴\n'.repeat(110);
const secondAnswer = '合成乙任务使用自己的调查结果，已经完成解释。';
const expected = '## 合成甲目标\n\n' + firstAnswer + '\n\n---\n\n## 合成乙目标\n\n' + secondAnswer;
const profile = {provider_id:'deepseek',model_id:'deepseek-flash',trial_id:randomUUID(),
  price_version:'2026-10-04-peak-usd',input_limit:65536,output_limit:4096,trial_call_limit:24,
  trial_cost_micros:'300000',request_call_limit:24,toolset:'data',payload_bytes_limit:131072};
const conditions = {time_start:null,time_end:null,timezone:'UTC',metric:null,channel:null,
  group_by:[],filters:[],knowledge_refs:[],notes:'',source_limits:null};
const failedTool = process.argv.includes('--failed-tool');
const writeTask = process.argv.includes('--write-task');
let taskB, calls = 0, protocolFailure, passed = false, run;
const provider = createServer(async (request, response) => {
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8'), body = JSON.parse(raw);
    assert.ok(Buffer.byteLength(raw) <= profile.payload_bytes_limit);
    assert.ok(body.tools?.length, '此最小交接没有摘要或额外汇总请求');
    calls++; assert.ok(calls <= 3, '只允许原route、B调查和B自然final三次请求');
    let text = '', action;
    if (calls === 1) {
      text = firstAnswer;
      action = {id:'finalize-first-answer', name:'update_analysis_task', arguments:{action:'route',
        task_id:taskB.task_id,expected_version:taskB.condition_version,options:[],finalize_current_answer:true}};
    } else if (calls === 2) {
      action = writeTask
        ? {id:'update-second-task',name:'update_analysis_task',arguments:{action:'revise',task_id:taskB.task_id,
            expected_version:taskB.condition_version,condition_patch:{set:{notes:'合成乙补充调查记录。'},unset:[]},options:[]}}
        : {id:'read-second-task',name:'read_analysis_task',arguments:{task_id:failedTool?'synthetic-missing-task':taskB.task_id}};
    } else {
      const receipt = JSON.parse(body.messages.findLast(message => message.role === 'tool').content);
      if (failedTool) assert.equal(receipt.error,'not_available','B真实工具拒绝不清空已冻结A');
      if (writeTask) assert.equal(receipt.condition_version,'2','B条件写入须实际成功');
      text = secondAnswer;
    }
    response.writeHead(200, {'content-type':'text/event-stream'});
    const emit = (delta, finish_reason = null) => response.write('data: ' + JSON.stringify({id:'synthetic-task-answers',
      choices:[{index:0,delta,finish_reason}]}) + '\n\n');
    emit({role:'assistant'});
    for (let offset = 0; offset < text.length; offset += 71) emit({content:text.slice(offset,offset+71)});
    if (action) emit({tool_calls:[{index:0,id:action.id,type:'function',function:{name:action.name,
      arguments:JSON.stringify(action.arguments)}}]});
    emit({}, action ? 'tool_calls' : 'stop');
    response.write('data: ' + JSON.stringify({choices:[],usage:{prompt_tokens:100,completion_tokens:1500,total_tokens:1600}}) + '\n\n');
    response.end('data: [DONE]\n\n');
  } catch (error) {
    protocolFailure ??= error;
    if (!response.headersSent) response.writeHead(400, {'content-type':'application/json'});
    response.end(JSON.stringify({error:{message:'synthetic_task_answers_assertion'}}));
  }
});
await new Promise(resolve => provider.listen(0,'127.0.0.1',resolve));
const h = await harness({capture:true,profile,protocolProviderUrl:'http://127.0.0.1:'+provider.address().port,
  env:{DATA_AGENT_LEASE_MS:'120000'}});
const previousProviderTest = process.env.DATA_AGENT_PROVIDER_TEST;
process.env.DATA_AGENT_PROVIDER_TEST = '1';
const ok = response => {assert.equal(response.status,200,JSON.stringify(response.value));return response.value;};
try {
  const cid = await h.create();
  run = await h.capture(cid,'分别完成合成甲目标和合成乙目标。'); await h.pauseWorker();
  // 无向量调用的专用合成夹具，仅冻结本运行的v2；不扩产品开关或触及主库。
  h.sql(`UPDATE agent_runs SET tool_contract_version=2 WHERE id='${run.run_id}'`);
  run.tool_contract_version = 2;
  const manager = SessionManager.inMemory('/synthetic/data-agent');
  const usage = {input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
  const createTask = async goal => {
    const sdk = randomUUID(), args = {action:'create',goal,conditions,options:[]};
    manager.appendMessage({role:'assistant',content:[{type:'toolCall',id:sdk,name:'update_analysis_task',arguments:args}],
      api:'openai-completions',provider:'local_mock',model:'task_demo',stopReason:'toolUse',usage,timestamp:Date.now()});
    const input = {run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:sdk,tool_name:'update_analysis_task',
      arguments:args,checkpoint:exportCheckpoint(manager)};
    ok(await h.internal('/internal/data/tool-calls',input));
    const receipt = ok(await h.internal('/internal/data/tools',input));
    manager.appendMessage({role:'toolResult',toolCallId:sdk,toolName:'update_analysis_task',
      content:[{type:'text',text:JSON.stringify(receipt.data)}],details:receipt,isError:false,timestamp:Date.now()});
    return receipt.data;
  };
  taskB = await createTask('合成乙目标');
  const taskA = await createTask('合成甲目标');
  run.checkpoint = exportCheckpoint(manager,run.workspace_context.authority_revision,run.workspace_context.authority_snapshot);
  run.workspace_context.active_task_ref = {task_id:taskA.task_id,condition_version:taskA.condition_version};
  try { await deliver(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,''); }
  catch (error) { throw protocolFailure ?? error; }
  if (protocolFailure) throw protocolFailure;
  const snapshot = await h.snapshot(cid);
  assert.equal(snapshot.messages.findLast(message => message.role === 'assistant' && message.committed)?.text, expected,
    '显式route定稿的A不能被B后续工具清空；宿主只加任务标题和分隔');
  assert.equal(snapshot.events.filter(event => event.type === 'assistant_committed' && event.payload.output_id === run.output_id).length,1);
  assert.equal(snapshot.runs.find(value => value.run_id === run.run_id).state,'finished');
  assert.equal(calls,3,'不增加模型汇总请求');
  const chunks = h.sql(`SELECT JSON_OBJECT('seq',chunk_seq,'body',body) FROM output_chunks WHERE attempt_id='${run.attempt_id}' ORDER BY chunk_seq`);
  assert.ok(chunks.filter(chunk => chunk.body.includes('合成甲任务')).length >= 2,'A完整中文/emoji必须跨多个实际持久片段');
  assert.ok(chunks.map(chunk => chunk.body).join('').endsWith(secondAnswer),'A定稿不抑制B自然正文落库');
  assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM tool_calls WHERE sdk_tool_call_id='finalize-first-answer'`)[0].n,1);
  passed = true;
} finally {
  if (previousProviderTest === undefined) delete process.env.DATA_AGENT_PROVIDER_TEST;
  else process.env.DATA_AGENT_PROVIDER_TEST = previousProviderTest;
  if (run) h.releaseRun(run.run_id);
  await h.close(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
  const report = {passed,failedTool,writeTask,calls,officialRequests:0,checks:['中文/emoji完整消息跨持久片段、显式route冻结A、B工具和自然final、同output一次确定性组合']};
  await writeFile('.local/checks/task-answers'+(failedTool?'-failed-tool':writeTask?'-write-task':'')+'.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
}

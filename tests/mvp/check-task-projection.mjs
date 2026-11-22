import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint, restoreCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {deliver} from '../../apps/agent/session/deliver.ts';
import {harness, until} from './harness.mjs';
import {assetInput, select} from './skill-fixtures.mjs';

// 消费者反例沿真实Pi接缝运行，不启动API/Worker；整链模式仍使用下方Rust harness。
if (process.argv.includes('--consumer-only')) {
  await import('../runtime/check-request-context.mjs');
} else {
const profile = {provider_id:'deepseek',model_id:'deepseek-flash',trial_id:randomUUID(),
  price_version:'2026-10-04-peak-usd',input_limit:65536,output_limit:2048,
  trial_call_limit:100,trial_cost_micros:'300000',request_call_limit:24,
  toolset:'data',payload_bytes_limit:131072};
const outsideText = '范围外的合成语音规则只能用于前一任务';
let allowed, task, otherTask, run, calls = 0, summaries = 0, passed = false, providerFailure;
const receiptStored = process.argv.includes('--recover-receipt');
const recover = receiptStored || process.argv.includes('--recover');
const skillName = '合成语音核对方法';
const payloads = [];
const scopeCall = 'apply-source-limits';
const provider = createServer(async (req, res) => {
  try {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw); payloads.push(raw); calls++;
  let delta;
  if (!body.tools?.length) {
    summaries++;
    assert.ok(!raw.includes(outsideText), '摘要请求不能收到已移除的材料');
    delta = {content:'当前仅使用指定文档，任务与成功操作保持原身份。'};
  } else if (calls === 1 && !recover) {
    assert.ok(raw.includes(outsideText), '反例必须确实从含旧材料的会话开始');
    assert.ok(raw.includes(skillName), '已明确选用的Skill初始可见');
    delta = {tool_calls:[{index:0,id:scopeCall,type:'function',function:{name:'update_analysis_task',
      arguments:JSON.stringify({action:'revise',task_id:task.task_id,
        expected_version:task.condition_version,goal:'',options:[],condition_patch:{set:{source_limits:{
          allowed_sources:[{kind:'document',id:allowed.id}],origin_message_ids:[run.message_id]}},unset:[]}})}}]};
  } else if (calls === (recover ? 1 : 2)) {
    assert.ok(!raw.includes(outsideText), '轮内收紧后下一次普通请求不得携带旧材料/摘要');
    assert.ok(!raw.includes(skillName), '受限任务不预载范围外Skill目录');
    delta = {tool_calls:[{index:0,id:'read-allowed-document',type:'function',function:{
      name:'read_knowledge',arguments:JSON.stringify({items:[{kind:'knowledge',ref:{object_id:allowed.id,version:allowed.version,path:'body'},limit:6000}]})}}]};
  } else if (calls === (recover ? 2 : 3)) {
    assert.ok(!raw.includes(outsideText));
    assert.ok(raw.includes('每个语音轮次对应一次请求'));
    delta = {content:'按指定文档核对，每个语音轮次对应一次请求。',tool_calls:[{index:0,id:'switch-analysis-task',type:'function',function:{
      name:'update_analysis_task',arguments:JSON.stringify({action:'route',task_id:otherTask.task_id,
        expected_version:otherTask.condition_version,goal:'',options:[],finalize_current_answer:true})}}]};
  } else {
    assert.ok(!raw.includes('每个语音轮次对应一次请求'), '切换任务移出前一任务工具正文');
    assert.ok(raw.includes(skillName), '切到无限制任务须恢复仍有效的已选Skill');
    delta = {content:'已切换到另一个语音分析目标，继续使用已选方法。'.repeat(300)};
  }
  delta.role = 'assistant';
  res.writeHead(200, {'content-type':'text/event-stream'});
  res.write('data: '+JSON.stringify({id:'synthetic',choices:[{index:0,delta,
    finish_reason:delta.tool_calls?'tool_calls':'stop'}]})+'\n\n');
  res.write('data: '+JSON.stringify({id:'synthetic',choices:[],usage:{prompt_tokens:1000,completion_tokens:50}})+'\n\n');
  res.end('data: [DONE]\n\n');
  } catch (error) {
    providerFailure ??= error;
    res.writeHead(500, {'content-type':'application/json'});
    res.end(JSON.stringify({error:{message:'synthetic_provider_assertion'}}));
  }
});
await new Promise(resolve => provider.listen(0,'127.0.0.1',resolve));
const url = 'http://127.0.0.1:'+provider.address().port;
const h = await harness({capture:true,profile,protocolProviderUrl:url,
  env:{DATA_AGENT_LEASE_MS:'120000'}});
const previous = Object.fromEntries(['DEEPSEEK_API_KEY','DEEPSEEK_BASE_URL','DATA_AGENT_PROVIDER_TEST','DATA_AGENT_TEST_COMPACT']
  .map(key => [key,process.env[key]]));
Object.assign(process.env,{DEEPSEEK_API_KEY:'synthetic-protocol-key',DEEPSEEK_BASE_URL:url,
  DATA_AGENT_PROVIDER_TEST:'1',DATA_AGENT_TEST_COMPACT:'1'});
const ok = response => {assert.equal(response.status,200,JSON.stringify(response.value));return response.value;};
try {
  allowed = ok(await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'指定语音文档',
    body:'每个语音轮次对应一次请求。'+'语音请求按轮次记录，完成状态由结果标志表达。'.repeat(300),related_ids:[]}));
  const outside = ok(await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'旧资料',
    body:outsideText,related_ids:[]}));
  const cid = await h.create();
  const skill = ok(await h.request('/assets',assetInput({name:skillName,scope:'合成语音分析'})));
  ok(await select(h,cid,skill));
  run = await h.capture(cid,'请改为只使用指定语音文档回答。'); await h.pauseWorker();
  const manager = SessionManager.inMemory('/synthetic/data-agent');
  const sessionId = manager.getHeader().id;
  const usage = {input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
  const invoke = async (tool_name,args) => {
    const sdk = randomUUID();
    manager.appendMessage({role:'assistant',content:[{type:'toolCall',id:sdk,name:tool_name,arguments:args}],
      api:'openai-completions',provider:'local_mock',model:'task_demo',stopReason:'toolUse',usage,timestamp:Date.now()});
    const input = {run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:sdk,tool_name,
      arguments:args,checkpoint:exportCheckpoint(manager)};
    ok(await h.internal('/internal/data/tool-calls',input));
    const receipt = ok(await h.internal('/internal/data/tools',input));
    if (tool_name==='update_analysis_task' && args.action==='create')
      assert.equal(receipt.context_reset,undefined,'两侧均明确无限制时只更新活动归属');
    manager.appendMessage({role:'toolResult',toolCallId:sdk,toolName:tool_name,
      content:[{type:'text',text:JSON.stringify(receipt.data)}],isError:false,timestamp:Date.now()});
    if (receipt.context_reset) {
      manager.appendCompaction('初始任务已切换。',null,0,{},true);
      run.workspace_context = ok(await h.internal('/internal/context/refresh',{
        run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:sdk,checkpoint:exportCheckpoint(manager),
      }));
    }
    return receipt.data;
  };
  const conditions = {
    time_start:null,time_end:null,timezone:'UTC',metric:null,channel:null,group_by:[],filters:[],
    knowledge_refs:[],notes:'',source_limits:null};
  otherTask = await invoke('update_analysis_task',{action:'create',goal:'另一个语音分析目标',options:[],conditions});
  task = await invoke('update_analysis_task',{action:'create',goal:'说明语音轮次',options:[],conditions});
  await invoke('read_knowledge',{items:[{kind:'knowledge',ref:{object_id:outside.id,version:outside.version,path:'body'}}]});
  manager.appendCompaction('旧任务摘要：'+outsideText,null,100,{},true);
  // 独立理由：回执检查点的投影只有三条消息（均值约610字节），刚好压过deliver.ts
  // 自适应保留窗的600字节阈值，为大历史设计的2048窗使测试强制的Pi压缩在
  // 范围边界后只剩保留窗内尾部而被正确拒绝。补一条常规的用户备注把检查点
  // 组成恢复到真实会话的形态，均值回到256窗，强制压缩沿plain/--recover同一路径。
  if (receiptStored)
    manager.appendMessage({role:'user',content:'请按上述范围先核对一轮再继续。',timestamp:Date.now()});
  run.checkpoint = exportCheckpoint(manager);
  if (recover) {
    const args = {action:'revise',task_id:task.task_id,expected_version:task.condition_version,
      goal:'',options:[],condition_patch:{set:{source_limits:{allowed_sources:[{kind:'document',id:allowed.id}],
        origin_message_ids:[run.message_id]}},unset:[]}};
    const followup = {type:'toolCall',id:'pending-task-read',name:'read_analysis_task',arguments:{task_id:task.task_id}};
    manager.appendMessage({role:'assistant',content:[{type:'toolCall',id:scopeCall,name:'update_analysis_task',arguments:args},...(receiptStored?[followup]:[])],
      api:'openai-completions',provider:'local_mock',model:'task_demo',stopReason:'toolUse',usage,timestamp:Date.now()});
    const input = {run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:scopeCall,
      tool_name:'update_analysis_task',arguments:args,checkpoint:exportCheckpoint(manager)};
    ok(await h.internal('/internal/data/tool-calls',input));
    const receipt = ok(await h.internal('/internal/data/tools',input));
    if (receiptStored) {
      manager.appendMessage({role:'toolResult',toolCallId:scopeCall,toolName:'update_analysis_task',
        content:[{type:'text',text:JSON.stringify(receipt.data)}],details:receipt,isError:false,timestamp:Date.now()});
      ok(await h.internal('/internal/data/tool-calls',{...input,sdk_tool_call_id:followup.id,
        tool_name:followup.name,arguments:followup.arguments,checkpoint:exportCheckpoint(manager)}));
      const unsettled = await h.internal('/internal/context/refresh',{run_id:run.run_id,
        lease_epoch:run.lease_epoch,sdk_tool_call_id:scopeCall,checkpoint:exportCheckpoint(manager)});
      assert.equal(unsettled.value.code,'outcome_unknown','未知工具不能被重投影清掉');
    }
    // 与after_business_commit相同的中断窗口：业务已提交，Pi还未取得toolResult。
    const prior = run, captured = h.captured.length;
    h.releaseRun(run.run_id);
    h.sql(`UPDATE agent_runs SET state='interrupted' WHERE id='${run.run_id}';UPDATE conversations SET lease_owner=NULL,lease_until=NULL WHERE id='${cid}';UPDATE background_jobs SET state='queued',lease_owner=NULL,lease_until=NULL WHERE message_id='${run.message_id}';`);
    await h.resumeWorker();
    run = await until(async () => {
      const failure = (await h.snapshot(cid)).events.find(event => event.type==='run_failed');
      assert.ok(!failure, '成功改范围后必须沿原输入恢复：'+JSON.stringify(failure));
      return h.captured.slice(captured).find(value => value.message_id===prior.message_id);
    },'范围变更后的原输入恢复');
    await h.pauseWorker();
    assert.equal(run.resume_same_input,true);
    assert.equal(run.budget_scope_id,prior.budget_scope_id);
    assert.equal(run.recovery_chain_id,prior.recovery_chain_id);
    assert.notEqual(run.run_id,prior.run_id);
    assert.equal(h.sql(`SELECT JSON_OBJECT('origin',origin_run_id) FROM tool_calls WHERE sdk_tool_call_id='${scopeCall}'`)[0].origin,prior.run_id);
  }
  try { await deliver(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,''); }
  catch (error) { throw providerFailure ?? error; }
  if (providerFailure) throw providerFailure;
  const checkpoint = h.sql(`SELECT checkpoint FROM pi_checkpoints WHERE recovery_chain_id='${run.recovery_chain_id}'`)[0];
  const restored = restoreCheckpoint('/synthetic/data-agent',checkpoint);
  assert.equal(restored.getHeader().id,sessionId);
  const resultIds = restored.getEntries().flatMap(entry =>
    entry.type==='message' && entry.message.role==='toolResult' ? [entry.message.toolCallId] : []);
  for (const id of [scopeCall, 'switch-analysis-task']) {
    assert.equal(resultIds.filter(result => result===id).length, 1,
      '原调用回执继续留在旧分支，切换范围不复制正文');
  }
  assert.ok(!JSON.stringify(restored.buildSessionContext().messages).includes(outsideText));
  assert.ok(summaries>=1, '实际经过Pi原生摘要');
  assert.equal(h.sql(`SELECT JSON_OBJECT('count',COUNT(*)) FROM tool_calls WHERE sdk_tool_call_id='${scopeCall}'`)[0].count,1);
  const budgets = h.sql(`SELECT JSON_OBJECT('issued',issued_calls,'limit',call_limit) FROM budget_scopes WHERE id='${run.budget_scope_id}'`)[0];
  assert.equal(budgets.issued,calls); assert.equal(budgets.limit,24);
  passed = true;
  console.log(JSON.stringify({passed,recover,receiptStored,calls,summaries,officialRequests:0}));
} finally {
  for (const [key,value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key]=value;
  }
  if (run) h.releaseRun(run.run_id);
  await h.close(); await new Promise(resolve => provider.close(resolve));
  await writeFile(`.local/checks/task-projection${receiptStored?'-receipt-recovery':recover?'-recovery':''}.json`,JSON.stringify({passed,recover,receiptStored,calls,summaries,officialRequests:0},null,2));
}
}

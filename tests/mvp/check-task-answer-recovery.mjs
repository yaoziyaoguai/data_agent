import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash, randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {deliver} from '../../apps/agent/session/deliver.ts';
import {exportCheckpoint, restoreCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {RustTransport} from '../../apps/agent/transport/client.ts';
import {harness, until} from './harness.mjs';

// 在原登记和原提交两个窗口中断真实Pi；恢复必须读取原attempt，不能重发A正文。
// 冻结正文取旧正控尺寸7998字符（中文+非BMP）：既有7998字冻结项必须原样恢复成功。
const firstAnswer = '甲'.repeat(4098) + '🌿'.repeat(3900);
const secondAnswer = '合成乙沿原任务完成，没有重新调查甲。';
const profile = {provider_id:'deepseek',model_id:'deepseek-flash',trial_id:randomUUID(),
  price_version:'2026-10-04-peak-usd',input_limit:65536,output_limit:4096,trial_call_limit:100,
  trial_cost_micros:'1000000',request_call_limit:24,toolset:'data',payload_bytes_limit:131072};
const conditions = {time_start:null,time_end:null,timezone:'UTC',metric:null,channel:null,
  group_by:[],filters:[],knowledge_refs:[],notes:'',source_limits:null};
const usage = {input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,
  cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
let h, run, taskA, taskB, mode, controller, providerFailure, passed = false;
let calls = 0, inScenario = 0, interrupted = false, recovering = false;
const checks = [], invocations = [];
const originalPost = RustTransport.prototype.post;
RustTransport.prototype.post = async function(path, name, input, ...rest) {
  const result = await originalPost.call(this,path,name,input,...rest);
  if (input.sdk_tool_call_id === 'finalize-recovery-answer') {
    invocations.push({path, recovering, input, result});
    if (!recovering && !interrupted && path === (mode === 'registered' ? '/internal/data/tool-calls' : '/internal/data/tools')) {
      interrupted = true; controller.abort();
      throw new Error('synthetic_answer_handoff_interrupted');
    }
  }
  return result;
};
const provider = createServer(async (request,response) => {
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8'), body = JSON.parse(raw);
    assert.ok(Buffer.byteLength(raw) <= profile.payload_bytes_limit);
    assert.ok(body.tools?.length,'本样例不需要摘要或汇总调用');
    calls++; inScenario++; assert.ok(inScenario <= 3);
    let text = '', action;
    if (inScenario === 1) {
      assert.equal(recovering,false);
      text = firstAnswer;
      action = {id:'finalize-recovery-answer',name:'update_analysis_task',arguments:{action:'route',
        task_id:taskB.task_id,expected_version:taskB.condition_version,options:[],finalize_current_answer:true}};
    } else if (inScenario === 2) {
      assert.equal(recovering,true);
      assert.ok(body.messages.some(message => message.role === 'tool' && message.tool_call_id === 'finalize-recovery-answer'),
        '普通续答之前已接回原route回执');
      action = {id:'read-recovered-task',name:'read_analysis_task',arguments:{task_id:taskB.task_id}};
    } else text = secondAnswer;
    response.writeHead(200,{'content-type':'text/event-stream'});
    const emit = (delta,finish_reason=null) => response.write('data: '+JSON.stringify({id:'synthetic-answer-recovery',
      choices:[{index:0,delta,finish_reason}]})+'\n\n');
    emit({role:'assistant'});
    for (let index=0;index<text.length;index+=71) emit({content:text.slice(index,index+71)});
    if (action) emit({tool_calls:[{index:0,id:action.id,type:'function',function:{name:action.name,arguments:JSON.stringify(action.arguments)}}]});
    emit({},action?'tool_calls':'stop');
    response.write('data: '+JSON.stringify({choices:[],usage:{prompt_tokens:100,completion_tokens:1500,total_tokens:1600}})+'\n\n');
    response.end('data: [DONE]\n\n');
  } catch (error) {
    providerFailure ??= error;
    if (!response.headersSent) response.writeHead(400,{'content-type':'application/json'});
    response.end(JSON.stringify({error:{message:'synthetic_answer_recovery_assertion'}}));
  }
});
await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
const ok = response => {assert.equal(response.status,200,JSON.stringify(response.value));return response.value;};
const previousTest = process.env.DATA_AGENT_PROVIDER_TEST;
process.env.DATA_AGENT_PROVIDER_TEST='1';
try {
  h = await harness({capture:true,profile,protocolProviderUrl:'http://127.0.0.1:'+provider.address().port,
    env:{DATA_AGENT_LEASE_MS:'120000'}});
  for (mode of ['registered','committed']) {
    inScenario=0; interrupted=false; recovering=false; providerFailure=undefined;
    const cid = await h.create(); await h.resumeWorker();
    run = await h.capture(cid,'完成合成甲，再完成合成乙；中断后接回原答案。'); await h.pauseWorker();
    h.sql(`UPDATE agent_runs SET tool_contract_version=2 WHERE id='${run.run_id}'`); run.tool_contract_version=2;
    const manager = SessionManager.inMemory('/synthetic/data-agent'), sessionId=manager.getSessionId();
    const create = async goal => {
      const sdk=randomUUID(),args={action:'create',goal,conditions,options:[]};
      manager.appendMessage({role:'assistant',content:[{type:'toolCall',id:sdk,name:'update_analysis_task',arguments:args}],
        api:'openai-completions',provider:'local_mock',model:'task_demo',stopReason:'toolUse',usage,timestamp:Date.now()});
      const input={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:sdk,tool_name:'update_analysis_task',
        arguments:args,checkpoint:exportCheckpoint(manager)};
      ok(await h.internal('/internal/data/tool-calls',input)); const receipt=ok(await h.internal('/internal/data/tools',input));
      manager.appendMessage({role:'toolResult',toolCallId:sdk,toolName:'update_analysis_task',content:[{type:'text',text:JSON.stringify(receipt.data)}],
        details:receipt,isError:false,timestamp:Date.now()});
      return receipt.data;
    };
    taskB=await create('合成乙目标'); taskA=await create('合成甲目标');
    run.workspace_context.active_task_ref={task_id:taskA.task_id,condition_version:taskA.condition_version};
    run.checkpoint=exportCheckpoint(manager,run.workspace_context.authority_revision,run.workspace_context.authority_snapshot);
    controller=new AbortController();
    await assert.rejects(deliver(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,'',controller.signal),/run_cancelled|model_run_failed/);
    if(providerFailure) throw providerFailure;
    assert.equal(interrupted,true); assert.equal(inScenario,1);
    const row=()=>h.sql(`SELECT JSON_OBJECT('operation',operation_id,'origin',origin_run_id,'state',state,'handoff',answer_handoff,'sequence',answer_part_sequence,'receipt',receipt) FROM tool_calls WHERE sdk_tool_call_id='finalize-recovery-answer' AND conversation_id='${cid}'`)[0];
    const before=row(),prior=run;
    assert.equal(before.state,mode==='registered'?'registered':'succeeded');
    assert.equal(before.sequence,mode==='registered'?null:1);
    assert.equal(before.handoff.handoff.assistant.attempt_id,prior.attempt_id);
    assert.equal(before.handoff.handoff.assistant.text_sha256,createHash('sha256').update(firstAnswer).digest('hex'));
    const saved=h.sql(`SELECT checkpoint FROM pi_checkpoints WHERE recovery_chain_id='${prior.recovery_chain_id}'`)[0];
    assert.equal(restoreCheckpoint('/synthetic/data-agent',saved).getSessionId(),sessionId);
    const captured=h.captured.length; h.releaseRun(prior.run_id);
    h.sql(`UPDATE agent_runs SET state='interrupted' WHERE id='${prior.run_id}';UPDATE conversations SET lease_owner=NULL,lease_until=NULL WHERE id='${cid}';UPDATE background_jobs SET state='queued',lease_owner=NULL,lease_until=NULL WHERE message_id='${prior.message_id}';`);
    await h.resumeWorker(); run=await until(()=>h.captured.slice(captured).find(value=>value.message_id===prior.message_id),'接回原答案交接 '+mode);
    await h.pauseWorker();
    assert.equal(run.resume_same_input,true);
    assert.notEqual(run.attempt_id,prior.attempt_id);
    for(const key of ['conversation_id','recovery_chain_id','budget_scope_id','output_id','message_id']) assert.equal(run[key],prior[key]);
    assert.equal(run.tool_contract_version,2);
    recovering=true;
    try {await deliver(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,'');} catch(error){throw providerFailure??error;}
    if(providerFailure) throw providerFailure;
    const expected='## 合成甲目标\n\n'+firstAnswer+'\n\n---\n\n## 合成乙目标\n\n'+secondAnswer;
    const snapshot=await h.snapshot(cid);
    assert.equal(snapshot.messages.findLast(message=>message.role==='assistant'&&message.committed)?.text,expected);
    assert.equal(snapshot.events.filter(event=>event.type==='assistant_committed'&&event.payload.output_id===prior.output_id).length,1);
    assert.equal(snapshot.events.filter(event=>event.type==='task_changed'&&event.payload.routed===true&&event.payload.task_id===taskB.task_id).length,1);
    const after=row(); assert.equal(after.operation,before.operation); assert.equal(after.origin,prior.run_id); assert.equal(after.sequence,1);
    assert.deepEqual(after.handoff,before.handoff);
    assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM tool_calls WHERE sdk_tool_call_id='finalize-recovery-answer' AND conversation_id='${cid}'`)[0].n,1);
    assert.ok(invocations.filter(item=>item.recovering&&item.input.run_id===run.run_id).every(item=>item.input.answer_handoff===undefined));
    const original=h.sql(`SELECT JSON_OBJECT('text',body) FROM output_chunks WHERE attempt_id='${prior.attempt_id}' ORDER BY chunk_seq`);
    assert.equal(original.map(chunk=>chunk.text).join(''),firstAnswer);
    const budget=h.sql(`SELECT JSON_OBJECT('calls',issued_calls,'limit',call_limit) FROM budget_scopes WHERE id='${run.budget_scope_id}'`)[0];
    assert.deepEqual(budget,{calls:3,limit:24});
    assert.equal(inScenario,3);
    checks.push({window:mode,passed:true,calls:inScenario,original_attempt:before.handoff.handoff.assistant.attempt_id===prior.attempt_id});
    h.releaseRun(run.run_id);
  }
  passed=true;
} finally {
  RustTransport.prototype.post=originalPost;
  if(previousTest===undefined) delete process.env.DATA_AGENT_PROVIDER_TEST; else process.env.DATA_AGENT_PROVIDER_TEST=previousTest;
  if(h) {if(run)h.releaseRun(run.run_id);await h.close();}
  provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));
  const report={passed,checks,calls,officialRequests:0};
  await writeFile('.local/checks/task-answer-recovery.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}

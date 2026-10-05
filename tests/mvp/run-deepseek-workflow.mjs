// --run仅在用户批准新完整工作流额度后执行；配置/数据库/试验ID持续保留，不补额。
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { syntheticAction } from '../../apps/agent/provider/synthetic-analysis.ts';
import { deliver } from '../../apps/agent/session/deliver.ts';
import { harness, until } from './harness.mjs';
const directory='.local/model-workflow';const configPath=directory+'/configuration.json';const reportPath=directory+'/result.json';
const inputs=['apps/agent/provider/deepseek.ts','apps/agent/session/deliver.ts','apps/agent/session/resources.ts','apps/agent/tools/data-tools.ts','packages/contracts/schema.json','crates/data-agent/src/use_cases/data_tools.rs','crates/data-agent/src/use_cases/context_authority.rs','crates/data-agent/src/use_cases/query_workflow.rs','crates/data-agent/src/use_cases/semantic_prefill.rs','crates/data-agent/src/modules/ingestion/prefill.rs','docs/sources/schema.sql','docs/sources/etl.sql','docs/sources/business-guide.md','package-lock.json'];
const hashes=async()=>Object.fromEntries(await Promise.all(inputs.map(async p=>[p,createHash('sha256').update(await readFile(p)).digest('hex')])));
const profile=id=>({provider_id:'deepseek',model_id:'deepseek-flash',trial_id:id,price_version:'2026-10-04-peak-usd',input_limit:32768,output_limit:2048,trial_call_limit:24,trial_cost_micros:'300000',request_call_limit:12,toolset:'data',payload_bytes_limit:65536});
const audit=process.argv.includes('--audit');const protocolCheck=process.argv.includes('--check');assert.ok(audit||protocolCheck||process.argv.includes('--run'),'选择--run或--audit');
let config;
// 回环需覆盖聊天/原生摘要和五字段初次、再次的两阶段维护；历史官方24次账本不改。
if(protocolCheck) config={database:'data_agent_test_'+randomBytes(8).toString('hex'),profile:{...profile(randomUUID()),trial_call_limit:48}};
else try{config=JSON.parse(await readFile(configPath,'utf8'));}catch(e){if(e.code!=='ENOENT'||audit)throw e;await mkdir(directory,{recursive:true,mode:0o700});config={database:'data_agent_trial_'+randomBytes(8).toString('hex'),profile:profile(randomUUID()),authorization:'最多24请求/64KB请求体/2048输出/US$0.30/一小时，仅合成材料；固定账本，不补额'};await writeFile(configPath,JSON.stringify(config,null,2)+'\n',{mode:0o600,flag:'wx'});}
const h=await harness({capture:true,profile:config.profile,database:config.database,keep:!protocolCheck,env:{DATA_AGENT_LEASE_MS:'120000'}});
let currentRun;let provider;const payloadBytes=[];const protocolActions=[];
if(protocolCheck){
 provider=createServer(async(req,res)=>{
  let raw='';req.setEncoding('utf8');for await(const part of req)raw+=part;payloadBytes.push(Buffer.byteLength(raw));assert.ok(Buffer.byteLength(raw)<=65536);const body=JSON.parse(raw);
  if(body.stream===false){
    const input=JSON.parse(body.messages[1].content);
    assert.ok(input.object.entries.every(e=>!('effective_value' in e)&&!('suggestion' in e)&&!('human_override' in e)));
    const source=input.sources.find(s=>s.source_id==='business-guide');
    const output={entries:[{entry_id:'meaning',value:'仅用于验证预填协议的合成说明',gaps:['业务含义需要独立评价'],evidence:[{source_id:source.source_id,version:source.version,location:'开头',quote:source.body.slice(0,80)}]}]};
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{type:'function',function:{name:'submit_semantic_prefill',arguments:JSON.stringify(output)}}]}}],usage:{prompt_tokens:100,completion_tokens:80}}));return;
  }
  const names=new Map(body.messages.flatMap(m=>(m.tool_calls??[]).map(t=>[t.id,t.function.name])));
  const messages=body.messages.filter(m=>m.role!=='system').map(m=>m.role==='tool'?{role:'toolResult',toolName:names.get(m.tool_call_id),content:[{type:'text',text:m.content}]}:{role:m.role,content:m.content??''});
  const summary=!body.tools?.length;
  const user=messages.findLast(m=>m.role==='user');
  const userText=typeof user?.content==='string'?user.content:user?.content?.find(c=>c.type==='text')?.text??'';
  const requests=[...userText.matchAll(/\[User\]: ([^\n]+)/g)].map(m=>m[1]);
  // 回环演示策略读取宿主本轮输入；不评估模拟摘要的语言理解，真实压缩仍由Pi执行。
  if(!summary && userText.startsWith('The conversation history before this point was compacted')) user.content=currentRun.text;
  const action=summary?{text:'合成历史摘要。原文用户请求：'+(requests.at(-1)??'继续订单分析')+'。既有任务与条件以当前宿主上下文为准；可通过受控工具回读。'}:syntheticAction(currentRun,{messages});const tool='tool' in action;
  protocolActions.push({action:summary?'sdk_summary':tool?action.tool:'answer',hasTools:!summary,lastToolName:messages.findLast(m=>m.role==='toolResult')?.toolName??null});
  const delta=tool?{role:'assistant',tool_calls:[{index:0,id:randomUUID(),type:'function',function:{name:action.tool,arguments:JSON.stringify(action.args)}}]}:{role:'assistant',content:action.text};
  res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify({id:'local-check',choices:[{index:0,delta,finish_reason:tool?'tool_calls':'stop'}]})+'\n\n');res.write('data: '+JSON.stringify({id:'local-check',choices:[],usage:{prompt_tokens:100,completion_tokens:25,total_tokens:125}})+'\n\n');res.end('data: [DONE]\n\n');
 });await new Promise(r=>provider.listen(0,'127.0.0.1',r));
}
let report={passed:false,provider:protocolCheck?'loopback protocol':'https://api.deepseek.com',evidenceKind:protocolCheck?'protocol':'official',model:'deepseek-flash',material:'synthetic only',sourceHashes:await hashes(),checks:[]};
const ledger=()=>h.sql(`SELECT JSON_OBJECT('calls',allocated_calls,'spent_micros',spent_micros,'reserved_micros',reserved_micros,'state',state) FROM model_trials WHERE id='${config.profile.trial_id}'`)[0];
try{
 if(audit){
  const old=JSON.parse(await readFile(reportPath,'utf8'));assert.equal(old.passed,true,'原模型流程未通过');assert.deepEqual(ledger(),old.ledger);const now=await hashes();console.log(JSON.stringify({passed:old.passed,additionalModelRequests:0,ledger:old.ledger,currentSourceMatches:JSON.stringify(now)===JSON.stringify(old.sourceHashes),evidence:reportPath}));
 }else{
  assert.equal(ledger().calls,0,'试验已占用额度，拒绝重新运行；先--audit，不改ID或删除数据库补额');
  if(!protocolCheck) assert.equal((await stat('.env')).mode&0o077,0,'.env必须为0600');
  const entries=protocolCheck?{DEEPSEEK_API_KEY:'synthetic-protocol-key',DEEPSEEK_BASE_URL:'http://127.0.0.1:'+provider.address().port,DEEPSEEK_MODEL:'deepseek-flash'}:Object.fromEntries((await readFile('.env','utf8')).split(/\r?\n/).filter(l=>/^(DEEPSEEK_API_KEY|DEEPSEEK_BASE_URL|DEEPSEEK_MODEL)=/.test(l)).map(l=>{const i=l.indexOf('=');return[l.slice(0,i),l.slice(i+1).trim()];}));
  assert.ok(entries.DEEPSEEK_API_KEY);if(!protocolCheck) assert.equal(entries.DEEPSEEK_BASE_URL,'https://api.deepseek.com');assert.equal(entries.DEEPSEEK_MODEL,'deepseek-flash');if(protocolCheck)process.env.DATA_AGENT_PROVIDER_TEST='1';else delete process.env.DATA_AGENT_PROVIDER_TEST;Object.assign(process.env,entries);
  const cid=await h.create();report.conversation_id=cid;
  const execute=async run=>{currentRun=run;await h.pauseWorker();await deliver(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,'');h.releaseRun(run.run_id);};
  let run=await h.capture(cid,'查2026年1月净收入。请调查当前有效口径，给出SQL，等待我在页面确认。');await execute(run);
  let list=(await h.request(`/conversations/${cid}/queries`)).value.queries;assert.equal(list.length,1);const original=list[0];assert.equal(original.check_state,'passed');assert.equal(original.execution_state,'not_submitted');
  report.checks.push({name:'Pi调查口径、保存完整只读SQL，未确认不执行',passed:true});
  await h.resumeWorker();run=await h.capture(cid,`[task:${original.task_id}] 只看app渠道，月份和其他条件保持原样；给出修订SQL，等待按钮确认。`);await execute(run);
  list=(await h.request(`/conversations/${cid}/queries`)).value.queries;const revised=list.find(q=>q.id!==original.id);assert.ok(revised);assert.equal(revised.check_state,'passed');assert.equal((await h.request(`/queries/${original.id}/confirm`,{operation_id:randomUUID(),draft_version:original.draft_version,condition_version:original.condition_version})).status,409);
  const task=(await h.snapshot(cid)).tasks.find(t=>t.id===original.task_id);assert.equal(task.condition_version,revised.condition_version);
  report.checks.push({name:'Pi用条件补丁修订原任务，旧SQL不能确认',passed:true});
  assert.equal((await h.request(`/queries/${revised.id}/confirm`,{operation_id:randomUUID(),draft_version:revised.draft_version,condition_version:revised.condition_version})).status,200);
  await h.resumeWorker();await until(async()=>(await h.request(`/queries/${revised.id}`)).value.execution_state==='succeeded','official sample platform result');
  const result=(await h.request(`/queries/${revised.id}/results`)).value;assert.deepEqual(result.rows,[['1600']]);
  run=await until(()=>h.captured.find(r=>r.text.startsWith('[已确认查询结果事件]')),'official result wake');await execute(run);
  const snapshot=await h.snapshot(cid);assert.equal(snapshot.runs.filter(r=>r.state==='finished').length,3);assert.ok(snapshot.messages.some(m=>m.role==='assistant'&&m.committed&&/1600|16(?:\.00)?/.test(m.text)));
  report.checks.push({name:'用户确认后合成平台得到独立参考1600分，Pi解释原任务结果',passed:true});
  // 所有维护调用复用同一trial；独立评估资料只由验收方读取，模型输入仅原始合成来源。
  h.env.DATA_AGENT_PREFILL_PROFILE=JSON.stringify(config.profile);
  h.env.DATA_AGENT_PREFILL_URL=protocolCheck?'http://127.0.0.1:'+provider.address().port:'https://api.deepseek.com/chat/completions';
  if(protocolCheck) h.env.DATA_AGENT_PREFILL_TEST='1';
  else h.env.DEEPSEEK_API_KEY=entries.DEEPSEEK_API_KEY;
  await h.resumeWorker();
  const cases=JSON.parse(await readFile('docs/sources/evaluation/prefill-cases.json','utf8')).cases;
  report.prefill=[];
  for(const sample of cases){
    const objectId='field-'+sample.field;
    const runPrefill=async()=>{
      const before=(await h.request('/knowledge/'+objectId)).value;
      const response=await h.request('/knowledge/'+objectId+'/reanalyze',{operation_id:randomUUID(),expected_version:before.version});
      assert.equal(response.status,200);
      const result=await until(async()=>{
        const value=(await h.request('/knowledge/'+objectId)).value;
        if(value.prefill_status&& !['queued','issued'].includes(value.prefill_status.state))return value;
        return false;
      },'prefill '+sample.id,40000);
      assert.equal(result.prefill_status.state,'succeeded',sample.id+': '+result.prefill_status.error_code);
      return result;
    };
    const initial=await runPrefill();
    const entry=initial.entries.find(e=>e.path==='meaning');
    assert.ok(entry.suggestion.value.trim());assert.ok(entry.suggestion.evidence.length>0);
    const edited=await h.request('/knowledge/'+objectId,{operation_id:randomUUID(),expected_version:initial.version,entry_id:'meaning',value:sample.manual_override.value,clear_override:false},'alice','PATCH');
    assert.equal(edited.status,200);
    const repeated=await runPrefill();const preserved=repeated.entries.find(e=>e.path==='meaning');
    assert.equal(preserved.effective_value,sample.manual_override.value);assert.ok(preserved.human_override);assert.equal(preserved.review_state,'needs_review');assert.ok(preserved.suggestion.evidence.length>0);
    report.prefill.push({case_id:sample.id,field:sample.field,initial,edited:edited.value,repeated,quality:protocolCheck?'protocol_only':'pending_independent_evaluation'});
  }
  await h.pauseWorker();
  report.checks.push({name:'P01–P05从原始来源分析及再次预填，人工有效值/标记保护；共用模型账本',passed:true});
  report.maintenanceAttempts=h.sql(`SELECT JSON_OBJECT('state',state,'usage',usage_json) FROM maintenance_model_calls WHERE trial_id='${config.profile.trial_id}'`);
  report.attempts=h.sql(`SELECT JSON_OBJECT('state',a.state,'usage',a.usage_json) FROM model_call_attempts a JOIN budget_scopes b ON a.budget_scope_id=b.id WHERE JSON_UNQUOTE(JSON_EXTRACT(b.model_profile,'$.trial_id'))='${config.profile.trial_id}'`);report.ledger=ledger();
  assert.ok(report.ledger.calls<=config.profile.trial_call_limit);assert.ok(report.ledger.spent_micros+report.ledger.reserved_micros<=300000);assert.equal(report.ledger.reserved_micros,0);assert.ok(report.attempts.every(a=>a.state==='settled'&&a.usage.input_tokens<=32768&&a.usage.output_tokens<=2048));
  assert.equal(report.maintenanceAttempts.length,cases.length*2*2);assert.ok(report.maintenanceAttempts.every(a=>a.state==='settled'&&a.usage.prompt_tokens<=32768&&a.usage.completion_tokens<=2048));
  assert.equal(report.attempts.length+report.maintenanceAttempts.length,report.ledger.calls);
  report.passed=true;assert.ok(!JSON.stringify(report).includes(entries.DEEPSEEK_API_KEY));assert.ok(!JSON.stringify(h.logs).includes(entries.DEEPSEEK_API_KEY));
 }
}finally{
 let finalLedger,ledgerFailure;
 try{finalLedger=ledger();}catch(error){ledgerFailure=error;finalLedger=report.ledger??null;report.passed=false;report.ledgerError='ledger_unavailable';}
 let cleanupFailure;
 try{await h.close();}catch(error){cleanupFailure=error;report.passed=false;report.cleanupError='test_database_cleanup_failed';}
 if(!audit){report.ledger=finalLedger;report.verifiedAt=new Date().toISOString();report.payloadBytes=payloadBytes;if(protocolCheck)report.protocolActions=protocolActions;report.officialRequests=protocolCheck?0:report.ledger?.calls??null;const evidence=protocolCheck?'.local/checks/mvp-deepseek-workflow.json':reportPath;await writeFile(evidence,JSON.stringify(report,null,2)+'\n',{mode:0o600});delete process.env.DEEPSEEK_API_KEY;console.log(JSON.stringify({passed:report.passed,ledger:report.ledger,evidence}));}
 if(provider)await new Promise(r=>provider.close(r));delete process.env.DATA_AGENT_PROVIDER_TEST;
 if(cleanupFailure)throw cleanupFailure;
 if(ledgerFailure)throw ledgerFailure;
}

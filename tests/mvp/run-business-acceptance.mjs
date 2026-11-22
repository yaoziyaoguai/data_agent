// 本地回环只验证工具与业务链路；--run必须先获模型额度授权，不能凭此脚本授予授权。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {readFile, writeFile, mkdir, stat, realpath} from 'node:fs/promises';
import {resolve, relative, dirname, join} from 'node:path';
import {randomBytes, randomUUID, createHash} from 'node:crypto';
import {subscribe, unsubscribe} from 'node:diagnostics_channel';

const argv=process.argv.slice(2);
const protocol=argv.includes('--check'), official=argv.includes('--run'), audit=argv.includes('--audit');
assert.equal([protocol,official,audit].filter(Boolean).length,1,'选择--check、--run或--audit');
const option=name=>{const i=argv.indexOf(name);return i<0?undefined:argv[i+1];};
for(const name of ['--interaction','--output']){
  const value=option(name);
  if(argv.includes(name))assert.ok(value&&!value.startsWith('--'),'missing_option_value:'+name);
}
const groups={analysis:['S01','S02','S03','S04','S05','B04','B06','B07','B08'],memory:['B05','B05-failure'],prefill:['P01','P02','P03','P04','P05']};
const group=option('--group');if(group)assert.ok(protocol&&group in groups,'分组只用于独立回环fixture');
const interaction=option('--interaction')??'confirmation';
assert.ok(['confirmation','conversation'].includes(interaction),'invalid_interaction');
const conversation=interaction==='conversation';
if(conversation){
  assert.equal(option('--cases'),'S02','conversation_requires_s02');
  assert.ok(option('--output'),'conversation_requires_output');
  assert.ok(!group&&!audit,'conversation_requires_run_or_check');
}
const evidence=option('--output')??(protocol?'.local/checks/mvp-business-acceptance'+(group?'-'+group:'')+'.json':'.local/model-workflow/business-result.json');
if(option('--output')){
  assert.ok(!audit,'audit_uses_evidence');
  const local=resolve('.local'),output=resolve(evidence);
  assert.ok(output.startsWith(local+'/')&&output.endsWith('.json'),'output_requires_local_json');
  await mkdir(dirname(output),{recursive:true,mode:0o700});
  const parent=await realpath(dirname(output)),localRoot=await realpath(local);
  assert.ok(parent===localRoot||parent.startsWith(localRoot+'/'),'output_requires_local_json');
  await writeFile(output,JSON.stringify({completion:'preparing',interaction})+'\n',{flag:'wx',mode:0o600});
}
// 参数和输出身份先校验，随后才加载Pi与运行服务所需模块。
const [{syntheticAction},{deliver},{harness,until},{planForProfile},{RustTransport}]=await Promise.all([
  import('../../apps/agent/provider/synthetic-analysis.ts'),import('../../apps/agent/session/deliver.ts'),
  import('./harness.mjs'),import('../../packages/contracts/capacity.ts'),import('../../apps/agent/transport/client.ts'),
]);
const inputs=['apps','crates/data-agent','packages/contracts','migrations','tests/mvp/run-business-acceptance.mjs','tests/mvp/harness.mjs','scripts/evaluate_business_sql.py','docs/sources','infra/embedding-model.json','.cargo','Cargo.toml','Cargo.lock','package.json','package-lock.json','rust-toolchain.toml','tsconfig.json'];
// 哈希只读公开工程材料；不遍历凭据或运行日志。
const sourceHashes=()=>JSON.parse(execFileSync('python3',['-c',
  "import pathlib,hashlib,json,sys; files=[]\nfor n in sys.argv[1:]:\n p=pathlib.Path(n);files.extend([p] if p.is_file() else [f for f in p.rglob('*') if f.is_file() and '__pycache__' not in f.parts])\nprint(json.dumps({str(f):hashlib.sha256(f.read_bytes()).hexdigest() for f in sorted(set(files))}))",...inputs],{encoding:'utf8'}));
if(protocol&&!group&&!option('--cases')){
  // 各组独立合成fixture用各自有限账本；官方验收始终沿用传入的同一profile和账本。
  const reports=[];let passed=false;
  try{
    for(const name of Object.keys(groups)){
      execFileSync('node',['tests/mvp/run-business-acceptance.mjs','--check','--group',name],{stdio:['ignore','inherit','inherit']});
      reports.push(JSON.parse(await readFile('.local/checks/mvp-business-acceptance-'+name+'.json','utf8')));
    }
    passed=reports.every(v=>v.machinePassed);
  }finally{
    const report={machinePassed:passed,completion:passed?'protocol_passed_quality_unverified':'incomplete',evidenceKind:'protocol_fixture',sourceHashes:sourceHashes(),checks:reports.flatMap(v=>v.checks),ledgers:reports.map(v=>v.ledger),officialRequests:0,languageReview:'固定演示策略验证宿主链路，不评价真实模型质量',verifiedAt:new Date().toISOString()};
    await writeFile(evidence,JSON.stringify(report,null,2)+'\n',{mode:0o600});
    console.log(JSON.stringify({machinePassed:passed,cases:report.checks.map(v=>({id:v.id,passed:v.machinePassed})),officialRequests:0,evidence}));
  }
  process.exit(passed?0:1);
}
if(audit){
  const savedPath=option('--evidence')??evidence;
  const raw=await readFile(savedPath,'utf8');
  const saved=JSON.parse(raw);
  const currentHashes=sourceHashes();
  const sourceChanges=[...new Set([...Object.keys(saved.sourceHashes),...Object.keys(currentHashes)])].sort()
    .filter(path=>saved.sourceHashes[path]!==currentHashes[path])
    .map(path=>({path,before:saved.sourceHashes[path]??null,after:currentHashes[path]??null}));
  if(option('--source-review')){
    const review=JSON.parse(await readFile(option('--source-review'),'utf8'));
    assert.equal(review.conclusion,'passed');assert.ok(review.reviewer?.trim());
    assert.equal(review.measurement_decision,'retain_original_measurement');
    assert.equal(review.measurement_evidence_sha256,createHash('sha256').update(raw).digest('hex'));
    assert.ok(sourceChanges.length>0,'没有源码变化时应直接核对原指纹');
    assert.deepEqual(review.source_changes.map(({path,before,after})=>({path,before,after})),sourceChanges,'未审查或审查过期的源码变化');
    assert.ok(review.source_changes.every(change=>change.reason?.trim()));
  }else{
    assert.deepEqual(saved.sourceHashes,currentHashes,'验收输入已变化，需要重新审查');
  }
  if(option('--quality-review')){
    const review=JSON.parse(await readFile(option('--quality-review'),'utf8'));
    const expected=Object.values(groups).flat().sort();
    assert.equal(saved.evidenceKind,'official');assert.equal(saved.machinePassed,true);
    assert.deepEqual(saved.checks.map(v=>v.id).sort(),expected,'官方业务证据缺题或重复');
    assert.ok(saved.checks.every(v=>v.machinePassed===true));
    assert.equal(saved.profile.model_id,'deepseek-flash');assert.equal(saved.profile.thinking_level,'high');
    assert.deepEqual(saved.selectedCases.slice().sort(),expected);assert.deepEqual(saved.pending,[]);
    assert.equal(review.conclusion,'measurement_complete');assert.ok(review.reviewer?.trim());
    assert.equal(review.evidence_sha256,createHash('sha256').update(raw).digest('hex'),'独立语义审查与实际产物不一致');
    assert.deepEqual(review.checks.map(v=>v.id).sort(),expected,'独立语义审查缺题或重复');
    assert.ok(review.checks.every(v=>typeof v.passed==='boolean'&&v.summary?.trim()));
    const passed=review.checks.filter(v=>v.passed).length;
    assert.deepEqual(review.summary,{total:expected.length,passed,failed:expected.length-passed,accuracy:passed/expected.length},'质量统计必须保留所有失败');
    assert.equal(saved.ledger.reserved_micros,0,'仍有未知调用预留');
    assert.equal(saved.ledger.calls,saved.officialRequests);
    assert.equal(saved.callReceipts.length,saved.officialRequests);
    assert.equal(new Set(saved.callReceipts.map(v=>v.id)).size,saved.officialRequests);
    for(const call of saved.callReceipts){
      assert.equal(call.state,'settled');
      const input=call.kind==='chat'?call.usage?.input_tokens:call.usage?.prompt_tokens;
      const output=call.kind==='chat'?call.usage?.output_tokens:call.usage?.completion_tokens;
      assert.ok(Number.isSafeInteger(input)&&input>=0&&input<=saved.profile.input_limit);
      assert.ok(Number.isSafeInteger(output)&&output>=0&&output<=saved.profile.output_limit);
    }
  }
  console.log(JSON.stringify({machinePassed:saved.machinePassed,completion:option('--quality-review')?'independently_measured':saved.completion,officialRequestsAdded:0,evidence:savedPath,measuredSourcesMatchCurrent:sourceChanges.length===0,sourceChangeReview:option('--source-review')??null}));
  process.exit(0);
}
const config=protocol?{
  database:'data_agent_test_'+randomBytes(8).toString('hex'),
  // 复用09已确认的能力组合；回环只验证接线，不评价供应商或引入累计付费额度。
  profile:{provider_id:'deepseek',model_id:'deepseek-flash',trial_id:randomUUID(),price_version:'configured:deepseek-flash:2',budget_mode:'request',
    context_window:1000000,input_limit:900000,output_limit:65536,request_call_limit:24,toolset:'data',payload_bytes_limit:8388608,
    request_timeout_ms:600000,capability_source:'admin_declared',thinking_level:'high',
    configured_model:{id:'deepseek-flash',version:'2',service_id:'deployment-deepseek',service_version:'1',api:'openai-completions',input_rate:'300000',output_rate:'1200000',reasoning_supported:true}},
}:JSON.parse(await readFile(option('--model-profile')??'.local/model-workflow/configuration.json','utf8'));
if(official)assert.match(config.database,/^data_agent_trial_[a-f0-9]+$/);
assert.equal(config.profile.toolset,'data');assert.equal(config.profile.request_call_limit,24);
assert.ok(config.profile.configured_model&&config.profile.context_window,'真实代表需要已确认的configured_model完整配置，不能退回legacy');
const reuseConfiguration=conversation&&official;
if(reuseConfiguration){
  assert.ok(config.platformDirectory&&config.modelKeyFile,'conversation_requires_original_platform_and_key');
  assert.ok((await stat(config.platformDirectory)).isDirectory());
  assert.ok((await stat(config.modelKeyFile)).isFile());
}
const platformDirectory=conversation?(reuseConfiguration?config.platformDirectory:join(dirname(evidence),'platform-'+config.database)):undefined;
const h=await harness({capture:true,web:conversation,startWorker:conversation?false:undefined,
  platformDirectory,profile:config.profile,database:config.database,keep:official,
  env:{DATA_AGENT_LEASE_MS:'120000',DATA_AGENT_QUERY_DELAY_SECONDS:'5',DATA_AGENT_TOOL_CONTRACT_VERSION:'2',DATA_AGENT_PROVIDER_TEST:protocol?'1':'0',
    ...(conversation?{DATA_AGENT_PUBLIC_CONTENT_RETENTION:'latest_only'}:{}),
    ...(conversation&&protocol?{DATA_AGENT_MEMORY_URL:'',DATA_AGENT_VECTOR_URL:''}:{}),
    ...(reuseConfiguration?{DATA_AGENT_MODEL_KEY_FILE:resolve(config.modelKeyFile)}:{})}});
let currentRun,provider,effectiveModel,effectiveService,platformProxy,conversationSample;const payloadBytes=[];
const report={machinePassed:false,completion:'incomplete',interaction,provider:protocol?'loopback protocol':'https://api.deepseek.com',evidenceKind:protocol?'protocol_fixture':'official',sourceHashes:sourceHashes(),profile:config.profile,database:config.database,checks:[],pending:[],languageReview:protocol?'模拟文本不评价真实模型质量':'需独立审查解释、引用与缺口；机器断言不能代替',officialRequests:0};
const originalPost=RustTransport.prototype.post;
const observeRequest=({request})=>{
  if(conversation&&official&&String(request.origin)==='https://api.deepseek.com'&&request.path==='/chat/completions')report.modelDispatches++;
};
if(conversation){
  report.modelDispatches=0;report.conversationRuns=[];report.toolObservations=[];report.platformRequests=[];
  report.runtime={directory:relative(process.cwd(),h.directory),database:config.database,trial_id:config.profile.trial_id,
    platform_directory:platformDirectory,
    model_key_file:relative(process.cwd(),h.env.DATA_AGENT_MODEL_KEY_FILE),pi_session_root:'.local/pi-sessions',
    api_url:h.env.DATA_AGENT_API_URL,page_url:h.url,tool_contract_version:2,public_content_retention:'latest_only',
    retrieval_mode:h.env.DATA_AGENT_VECTOR_URL?'hybrid':'lexical',memory_mode:h.env.DATA_AGENT_MEMORY_URL?'mem0':'builtin',started_at:new Date().toISOString()};
  report.binaries={};
  for(const path of ['target/debug/data-agent-api','target/debug/data-agent-worker']){
    const info=await stat(path);
    report.binaries[path]={sha256:createHash('sha256').update(await readFile(path)).digest('hex'),mtime:info.mtime.toISOString()};
  }
  subscribe('undici:request:create',observeRequest);
  RustTransport.prototype.post=async function(path,name,input,...rest){
    const value=await originalPost.call(this,path,name,input,...rest);
    const entry=report.conversationRuns.find(r=>r.run_id===this.run.run_id);
    if(entry&&path==='/internal/outputs')entry.chunks.push({sequence:Number(input.chunk_seq),text:input.text});
    if(entry&&path==='/internal/finish'){const {checkpoint,...finish}=input;entry.finish=finish;entry.piSession=checkpoint.storage??null;}
    if(path==='/internal/data/tools')report.toolObservations.push({run_id:this.run.run_id,tool_name:input.tool_name,arguments:input.arguments,outcome:value});
    return value;
  };
}
const ledger=()=>h.sql(`SELECT JSON_OBJECT('calls',allocated_calls,'spent_micros',spent_micros,'reserved_micros',reserved_micros,'state',state) FROM model_trials WHERE id='${config.profile.trial_id}'`)[0];
const callReceipts=()=>[
  ...h.sql(`SELECT JSON_OBJECT('id',m.id,'kind','chat','state',m.state,'usage',m.usage_json) FROM model_call_attempts m JOIN budget_scopes b ON b.id=m.budget_scope_id WHERE b.model_profile->>'$.trial_id'='${config.profile.trial_id}' ORDER BY m.id`),
  ...h.sql(`SELECT JSON_OBJECT('id',id,'kind','prefill','state',state,'usage',usage_json) FROM maintenance_model_calls WHERE trial_id='${config.profile.trial_id}' ORDER BY id`),
];
const previous=Object.fromEntries(['DEEPSEEK_API_KEY','DEEPSEEK_BASE_URL','DEEPSEEK_MODEL','DATA_AGENT_PROVIDER_TEST'].map(k=>[k,process.env[k]]));
if(protocol){
  provider=createServer(async(req,res)=>{
    try{
      let raw='';req.setEncoding('utf8');for await(const part of req)raw+=part;
      payloadBytes.push(Buffer.byteLength(raw));if(conversation)report.modelDispatches++;assert.ok(Buffer.byteLength(raw)<=config.profile.payload_bytes_limit);
      // 模型输入不得包含独立答案文件的内容或字段。
      assert.ok(!raw.includes('expected_rows')&&!raw.includes('sql_file'));
      const body=JSON.parse(raw);
      if(body.stream===false){
        const input=JSON.parse(body.messages[1].content);
        assert.ok(input.object.entries.every(e=>!('effective_value' in e)&&!('suggestion' in e)&&!('human_override' in e)));
        const source=input.sources.find(s=>s.source_id==='business-guide');
        const output={entries:[{entry_id:'meaning',value:'回环预填说明，只验证来源和人工保护',gaps:['真实语义质量待审查'],evidence:[{source_id:source.source_id,version:source.version,location:'开头',quote:source.body.slice(0,80)}]}]};
        res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{type:'function',function:{name:'submit_semantic_prefill',arguments:JSON.stringify(output)}}]}}],usage:{prompt_tokens:100,completion_tokens:80}}));return;
      }
      const names=new Map(body.messages.flatMap(m=>(m.tool_calls??[]).map(t=>[t.id,t.function.name])));
      const messages=body.messages.filter(m=>m.role!=='system').map(m=>m.role==='tool'?{role:'toolResult',toolName:names.get(m.tool_call_id),content:[{type:'text',text:m.content}]}:{role:m.role,content:m.content??''});
      const user=messages.findLast(m=>m.role==='user');
      const userText=typeof user?.content==='string'?user.content:user?.content?.find(c=>c.type==='text')?.text??'';
      if(body.tools?.length && userText.startsWith('The conversation history before this point was compacted')) user.content=currentRun.text;
      const action=body.tools?.length?syntheticAction(currentRun,{messages}):{text:'合成历史摘要；当前任务和条件请回读宿主工具。'};
      const tool='tool' in action;
      const delta=tool?{role:'assistant',tool_calls:[{index:0,id:randomUUID(),type:'function',function:{name:action.tool,arguments:JSON.stringify(action.args)}}]}:{role:'assistant',content:action.text};
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.write('data: '+JSON.stringify({id:'business-loopback',choices:[{index:0,delta,finish_reason:tool?'tool_calls':'stop'}]})+'\n\n');
      res.write('data: '+JSON.stringify({choices:[],usage:{prompt_tokens:100,completion_tokens:25,total_tokens:125}})+'\n\n');res.end('data: [DONE]\n\n');
    }catch{res.writeHead(500);res.end('protocol_fixture_failed');}
  });await new Promise(r=>provider.listen(0,'127.0.0.1',r));
}
const execute=async run=>{
  currentRun=run;if(protocol&&!conversation)await h.pauseWorker();
  const entry=conversation?{run_id:run.run_id,message_id:run.message_id,conversation_id:run.conversation_id,
    budget_scope_id:run.budget_scope_id,attempt_id:run.attempt_id,output_id:run.output_id,chunks:[]}:undefined;
  if(entry)report.conversationRuns.push(entry);
  assert.equal(run.tool_contract_version,2,'代表流程必须验证工具合同2');
  for(const field of ['provider_id','model_id','thinking_level','context_window','input_limit','output_limit','payload_bytes_limit','request_timeout_ms','capability_source','request_call_limit','trial_id','budget_mode'])
    assert.deepEqual(run.model_profile[field],config.profile[field],'运行实际配置不符：'+field);
  assert.equal(run.model_profile.price_version,'configured:'+config.profile.configured_model.id+':'+run.model_profile.configured_model.version,'API启动的legacy seed不能替代已保存模型定义');
  assert.deepEqual(run.model_profile.configured_model,{id:effectiveModel.id,version:effectiveModel.version,
    service_id:effectiveService.id,service_version:effectiveService.version,api:effectiveService.api,
    input_rate:effectiveModel.input_rate,output_rate:effectiveModel.output_rate,reasoning_supported:effectiveModel.reasoning_supported},'运行必须绑定实际保存的模型和服务修订');
  const capacity=planForProfile(run.model_profile);assert.ok(capacity&&typeof capacity!=='string','Pi原生压缩容量组合不可行');
  (report.effectiveRuns??=[]).push({run_id:run.run_id,budget_scope_id:run.budget_scope_id,tool_contract_version:run.tool_contract_version,profile:run.model_profile,capacity});
  try{await deliver(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,'');}
  finally{h.releaseRun(run.run_id);}
  const snapshot=await h.snapshot(run.conversation_id);
  assert.ok(snapshot.runs.some(r=>r.run_id===run.run_id&&r.state==='finished'));
  if(entry){
    const formal=snapshot.messages.find(m=>m.role==='assistant'&&m.output_id===run.output_id&&m.committed);
    assert.ok(formal,'本轮正式输出必须保存');
    const refreshed=await h.snapshot(run.conversation_id);
    assert.equal(refreshed.messages.find(m=>m.output_id===run.output_id)?.text,formal.text);
    const finish=entry.finish;assert.ok(finish,'本轮必须沿正式finish交付');
    const binding=finish.rendered_answer_binding??finish.output_binding??finish.answer_parts?.at(-1)?.rendered_answer_binding??finish.answer_parts?.at(-1)?.output_binding;
    const first=Number(binding?.first_chunk_seq??finish.final_start_chunk_seq??1);
    const last=Number(binding?.last_chunk_seq??entry.chunks.at(-1)?.sequence);
    assert.equal(entry.chunks.filter(c=>c.sequence>=first&&c.sequence<=last).map(c=>c.text).join(''),finish.final_text);
    assert.ok(formal.text.endsWith(finish.final_text));
    entry.finalOutput={output_id:run.output_id,text:formal.text,streamMatches:true,refreshMatches:true};
    if(entry.piSession){
      assert.ok((await stat(join('.local/pi-sessions',entry.piSession.file))).isFile());
      const previous=report.conversationRuns.find(r=>r!==entry&&r.conversation_id===run.conversation_id&&r.piSession);
      if(previous)assert.equal(entry.piSession.session_id,previous.piSession.session_id,'同一对话沿用Pi原生会话');
    }
  }
  return snapshot;
};
const ask=async(cid,text)=>{await h.pauseWorker();await h.resumeWorker();const run=await h.capture(cid,text);return execute(run);};
const fresh=async text=>{const cid=await h.create();await ask(cid,text);return cid;};
const queries=async cid=>(await h.request('/conversations/'+cid+'/queries')).value.queries;
const answer=async cid=>(await h.snapshot(cid)).messages.filter(v=>v.role==='assistant'&&v.committed).at(-1)?.text??'';
const verifySql=async(cid,caseId)=>{
  const query=(await queries(cid)).at(-1);
  if(conversationSample){conversationSample.stage='sql_validation';conversationSample.query=query;}
  assert.ok(query,'未形成SQL');assert.equal(query.check_state,'passed');assert.equal(query.execution_state,'not_submitted');
  const result=JSON.parse(execFileSync('python3',['scripts/evaluate_business_sql.py'],{input:JSON.stringify({case_id:caseId,sql:query.sql,parameters:query.parameters}),encoding:'utf8'}));
  if(conversationSample)conversationSample.independent=result;
  assert.equal(result.passed,true,caseId+'独立结果不一致：'+JSON.stringify(result));
  return {query,independent:result};
};
const verifyNetScope=async(cid,channel)=>{
  const query=(await queries(cid)).at(-1);assert.ok(query,'未形成净收入SQL');
  const stored=h.sql(`SELECT body FROM condition_revisions WHERE task_id='${query.task_id}' AND version=${query.condition_version}`)[0];
  assert.equal(stored.channel,null,'新条件通过通用 filters 保存渠道');
  const savedChannels=stored.filters.flatMap(filter=>{
    const match=filter.match(/^\s*(?:[a-z_][a-z0-9_]*\s*\.\s*)?channel\s*=\s*(['"]?)(web|app|store)\1\s*$/i);
    return match?[match[2].toLowerCase()]:[];
  });
  assert.deepEqual(savedChannels,channel===null?[]:[channel]);
  const independent=JSON.parse(execFileSync('python3',['scripts/evaluate_business_sql.py'],{input:JSON.stringify({case_id:'net_revenue_scope',channel,sql:query.sql,parameters:query.parameters}),encoding:'utf8'}));
  assert.equal(independent.passed,true,'渠道范围与独立参考不符：'+JSON.stringify(independent));
  return {query,independent};
};
const confirm=async(cid,query)=>{
  assert.equal((await h.request('/queries/'+query.id+'/confirm',{operation_id:randomUUID(),draft_version:query.draft_version,condition_version:query.condition_version})).status,200);
  await h.resumeWorker();await until(async()=>(await h.request('/queries/'+query.id)).value.execution_state==='succeeded','平台结果');
  assert.notEqual((await h.snapshot(cid)).tasks.find(t=>t.id===query.task_id)?.phase,'answered','平台完成而未提交解释不能标已回答');
  const wake=await until(()=>h.captured.find(r=>r.conversation_id===cid&&r.text.includes('query_id='+query.id)),'结果唤醒');
  const snapshot=await execute(wake);
  assert.ok(snapshot.events.some(e=>e.type==='query_result'&&e.payload.task_id===query.task_id&&e.payload.condition_version===query.condition_version));
  assert.equal(snapshot.tasks.find(t=>t.id===query.task_id)?.phase,'answered');
  return {result:(await h.request('/queries/'+query.id+'/results')).value,explanation:await answer(cid)};
};
const scenarios=[
  {id:'S01',requirements:['零支付金额解释','引用加工依据'],run:async()=>{
    const cid=await fresh('paid_amount_cents为什么可能为0？这是否一定是零元成交？请说明加工来源和不知道的地方。');
    assert.equal((await queries(cid)).length,0);const text=await answer(cid);
    assert.match(text,/COALESCE|缺失|填.?0/);assert.match(text,/成功.*(付款|支付|charge)/);assert.match(text,/不能|不一定|无法/);
    assert.ok((await h.snapshot(cid)).tasks.every(t=>t.phase==='answered'));
    return {cid,explanation:text};
  }},
  {id:'S02',requirements:['Q02','整月客户去重','B03确认'],run:async()=>{
    if(!conversation){
      const cid=await fresh('查2026年1月整月支付客户数，保留未知客户边界，给出SQL后等待按钮确认。');
      const sample=await verifySql(cid,'Q02');return {cid,...sample,...await confirm(cid,sample.query)};
    }
    const originalQuestion='查2026年1月整月支付客户数，保留未知客户边界。请先给出SQL草稿，等待我明确要求执行；此时不要提交查询。';
    let previousHistory;
    if(protocol){
      // 复现原库保留旧S02时的同名历史；仅造历史夹具，不派发额外消息或模型调用。
      const previousCid=await h.create();
      const title='查2026年1月整月支付客户数，保留未知客户边界，给出SQL后等待按钮确认。';
      h.sql(`UPDATE conversations SET title='${title}' WHERE id='${previousCid}'`);
      previousHistory={conversation_id:previousCid,title};
    }
    const cid=await h.create();
    const sample=conversationSample={cid,originalQuestion,stage:'draft_generation',semanticReview:'pending_independent_review',...(previousHistory?{previousHistory}:{})};
    await ask(cid,originalQuestion);
    Object.assign(sample,await verifySql(cid,'Q02'));
    const q=sample.query;
    assert.equal((await queries(cid)).length,1,'本attempt只形成一份有效草稿');
    sample.draftSubmits=report.platformRequests.filter(r=>r.path==='/submit').length;
    assert.equal(sample.draftSubmits,0,'未授权草稿不能提交到平台');
    const draftRun=report.conversationRuns.at(-1);
    sample.executionMessage=`[task:${q.task_id}] 请执行刚才的SQL，时间及其他条件保持不变；完成后直接解释这次查询的原始结果。`;
    sample.stage='chat_authorization';
    await ask(cid,sample.executionMessage);
    sample.execution=report.conversationRuns.at(-1);
    assert.notEqual(sample.execution.budget_scope_id,draftRun.budget_scope_id);
    sample.stage='platform_execution';
    await until(async()=>(await h.request('/queries/'+q.id)).value.execution_state==='succeeded','聊天授权平台结果');
    const wake=await until(()=>h.captured.find(r=>r.conversation_id===cid&&r.workspace_context?.result_notification?.query_id===q.id),'聊天原结果唤醒');
    assert.equal(wake.budget_scope_id,sample.execution.budget_scope_id);
    sample.wake={run_id:wake.run_id,message_id:wake.message_id,budget_scope_id:wake.budget_scope_id};
    sample.stage='result_explanation';
    const snapshot=await execute(wake);
    sample.finalOutput=report.conversationRuns.at(-1).finalOutput;
    sample.explanation=sample.finalOutput.text;
    sample.result=(await h.request('/queries/'+q.id+'/results')).value;
    assert.deepEqual(sample.result.columns.map(c=>c.name),sample.independent.columns);
    const numeric=sample.independent.columns.map((_,i)=>sample.independent.rows.some(row=>typeof row[i]==='number'));
    const rows=sample.result.rows.map(row=>row.map((value,i)=>value===null?null:numeric[i]?Number(value):value));
    const sorted=values=>values.slice().sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
    assert.deepEqual(sorted(rows),sorted(sample.independent.expected_rows));
    const executed=(await h.request('/queries/'+q.id)).value;
    for(const key of ['sql','parameters','task_id','condition_version','draft_version'])assert.deepEqual(executed[key],q[key]);
    sample.authorization=h.sql(`SELECT JSON_OBJECT('message',confirmation_message_id,'budget',budget_scope_id,'attempts',submission_attempts) FROM query_requests WHERE id='${q.id}'`)[0];
    assert.equal(sample.authorization.message,sample.execution.message_id);
    assert.equal(sample.authorization.budget,sample.execution.budget_scope_id);
    assert.equal(sample.authorization.attempts,1);
    sample.platformSubmits=report.platformRequests.filter(r=>r.path==='/submit');
    assert.equal(sample.platformSubmits.length,1);
    assert.equal(sample.platformSubmits[0].payload.query_id,q.id);
    assert.equal(sample.platformSubmits[0].status,200);
    assert.ok(report.toolObservations.some(t=>t.run_id===wake.run_id&&t.tool_name==='get_query'&&t.arguments.query_id===q.id
      &&JSON.stringify(t.outcome.data.results?.rows)===JSON.stringify(sample.result.rows)),'Pi必须实际读到本次原结果');
    assert.equal(snapshot.tasks.find(t=>t.id===q.task_id).phase,'answered');
    const roles=JSON.parse(execFileSync('python3',['-c','import json,sys; from scripts.evaluate_business_sql import customer_roles; print(json.dumps(customer_roles(json.load(sys.stdin))))'],
      {input:JSON.stringify(sample.result.columns.map(c=>c.name)),encoding:'utf8'}));
    const groupIndex=roles?.indexOf('customer_group');
    const eligible=groupIndex>=0&&roles.includes('known_customers')&&['known','anonymous'].every(label=>sample.independent.expected_rows.some(row=>row[groupIndex]===label));
    sample.continuation={eligible,status:'not_run_precondition_not_met'};
    if(eligible){
      await ask(cid,`[task:${q.task_id}] 沿用刚才同一任务和原查询结果，用原结果中的已知与匿名客户数，补充解释匿名客户为何不能计入去重支付客户数；不重新查询、不改SQL、不提交查询。`);
      assert.equal((await queries(cid)).length,1);
      assert.equal(report.platformRequests.filter(r=>r.path==='/submit').length,1);
      sample.continuation={eligible,status:'completed_semantic_review_pending',finalOutput:report.conversationRuns.at(-1).finalOutput};
    }
    assert.equal((await queries(cid)).length,1,'聊天代表不得顺带创建或执行其他查询');
    sample.stage='machine_completed_semantic_pending';
    return sample;
  }},
  {id:'S03',requirements:['B02','B03','条件补丁','旧版拒绝'],run:async()=>{
    const cid=await fresh('查2026年1月净收入，先给SQL等待确认');const old=(await queries(cid))[0];assert.ok(old);assert.equal(old.execution_state,'not_submitted');
    await ask(cid,`[task:${old.task_id}] 只看app渠道，其他条件保持原样，给修订SQL`);
    const current=(await queries(cid)).at(-1);assert.equal(current.task_id,old.task_id);assert.notEqual(current.condition_version,old.condition_version);assert.equal(current.parameters.start,old.parameters.start);assert.equal(current.parameters.end,old.parameters.end);
    const readConditions=q=>h.sql(`SELECT body FROM condition_revisions WHERE task_id='${q.task_id}' AND version=${q.condition_version}`)[0];
    const original=readConditions(old),stored=readConditions(current);
    assert.equal(original.time_start,'2026-01-01T00:00:00Z');assert.equal(original.time_end,'2026-02-01T00:00:00Z');assert.equal(original.timezone,'UTC');
    for(const key of ['time_start','time_end','timezone'])assert.equal(stored[key],original[key]);
    assert.equal((await h.request('/queries/'+old.id+'/confirm',{operation_id:randomUUID(),draft_version:old.draft_version,condition_version:old.condition_version})).status,409);
    const sample=await verifyNetScope(cid,'app');
    const completed=await confirm(cid,current);
    assert.deepEqual(completed.result.columns.map(c=>c.name),sample.independent.columns);
    assert.deepEqual(completed.result.rows.map(row=>row.map(value=>value===null?null:Number(value))),sample.independent.expected_rows);
    return {cid,old,current,independent:sample.independent,...completed,reference:'独立Q08的app渠道子结果1600分；明确金额列按单位逐列核算'};
  }},
  {id:'S04',requirements:['B01','Q04','Q05','Q10'],run:async()=>{
    const cid=await fresh('2026年1月退款率是多少？');assert.equal((await queries(cid)).length,0);
    const before=await h.snapshot(cid);const task=before.tasks.find(t=>t.phase==='waiting_clarification');assert.ok(task);const clarification=await answer(cid);assert.match(clarification,/分母|订单|金额/);
    await ask(cid,'按订单计算，时间和其他条件保持不变');const order=await verifySql(cid,'Q04');assert.equal(order.query.task_id,task.id);
    const moneyId=await fresh('2026年1月按金额计算退款比例，给出SQL等待按钮确认');const money=await verifySql(moneyId,'Q05');
    const emptyId=await fresh('2026年3月按订单计算退款率；分母为0时返回NULL，给SQL等待按钮确认');const empty=await verifySql(emptyId,'Q10');
    return {cid,clarification,order,money,empty};
  }},
  {id:'S05',requirements:['Q06','标签一对多','粒度选择'],run:async()=>{
    const cid=await fresh('有vip或newsletter标签的客户在2026年1月贡献多少净收入？请避免标签一对多重复计入，给SQL等待确认');
    const sample=await verifySql(cid,'Q06');assert.match(sample.query.sql,/EXISTS|DISTINCT|GROUP BY/i);
    return {cid,...sample,...await confirm(cid,sample.query),pending:'相似目录E15属于I3，本题不能冒充扩大目录验收'};
  }},
  {id:'B04',requirements:['支付时间归属','不猜某笔订单'],run:async()=>{
    const cid=await fresh('月底下单为什么不算进1月收入？没有订单号和订单明细，先解释一般口径。');const text=await answer(cid);assert.match(text,/paid_at/);assert.match(text,/order_date/);assert.match(text,/不能|需要|无法/);assert.equal((await queries(cid)).length,0);return {cid,explanation:text};
  }},
  {id:'B05',requirements:['个人记忆','明确条件优先','跨会话','修订停用'],run:async()=>{
    const cid=await fresh('以后我的分析默认只看web，但这次查2026年1月全部渠道净收入');const first=await verifyNetScope(cid,null);
    const memory=(await h.request('/assets')).value.assets.find(v=>v.kind==='memory'&&v.state==='enabled');assert.ok(memory);assert.match(memory.body,/web/);assert.match(await answer(cid),/保存|记住|记为(?:你|您)的长期偏好/u);
    const other=await fresh('查2026年1月净收入');const defaultWeb=await verifyNetScope(other,'web');
    await ask(cid,'以后默认改成app，忘掉旧web偏好，这次仍查2026年1月全部渠道净收入');const changed=(await h.request('/assets')).value.assets.find(v=>v.id===memory.id);assert.match(changed.body,/app/);assert.ok(BigInt(changed.version)>BigInt(memory.version));
    const explicitlyAll=await verifyNetScope(cid,null);
    const otherApp=await fresh('查2026年1月净收入');const defaultApp=await verifyNetScope(otherApp,'app');
    await ask(cid,'忘掉默认渠道记忆');const disabled=(await h.request('/assets')).value.assets.find(v=>v.id===memory.id);assert.equal(disabled.state,'disabled');
    const last=await fresh('查2026年1月净收入');const afterDisabled=await verifyNetScope(last,null);return {cid,memory,changed,disabled,other,otherApp,last,first,defaultWeb,defaultApp,explicitlyAll,afterDisabled};
  }},
  {id:'B05-failure',requirements:['保存失败不宣称成功','不复用失败记忆'],run:async()=>{
    h.sql("CREATE TRIGGER reject_memory BEFORE INSERT ON personal_assets FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic_memory_failure'");
    let cid;try{cid=await fresh('以后我的分析默认只看web，但这次查2026年1月全部渠道净收入');}finally{h.sql('DROP TRIGGER reject_memory');}
    const text=await answer(cid);assert.match(text,/未保存|保存失败|未.*成功|没.*保存|无法.*保存/);const failedSaveScope=await verifyNetScope(cid,null);
    assert.equal((await h.request('/assets')).value.assets.filter(v=>v.state==='enabled'&&v.kind==='memory').length,0);
    const next=await fresh('查2026年1月净收入');const noFailedPreference=await verifyNetScope(next,null);return {cid,next,failedSaveScope,noFailedPreference,explanation:text};
  }},
  {id:'B06',requirements:['缺退货件数','不伪造字段'],run:async()=>{
    const cid=await fresh('净售出件数是多少？');assert.equal((await queries(cid)).length,0);const text=await answer(cid);assert.match(text,/退货.*(件数|数量)/);assert.match(text,/没有|缺少|无法|不能/);return {cid,explanation:text};
  }},
  {id:'B07',requirements:['历史地区缺失','澄清当前快照'],run:async()=>{
    const cid=await fresh('按购买时的客户地区分析2026年1月收入');assert.equal((await queries(cid)).length,0);const snapshot=await h.snapshot(cid);assert.ok(snapshot.tasks.some(t=>t.phase==='waiting_clarification'));const text=await answer(cid);assert.match(text,/当前/);assert.match(text,/历史|购买时/);return {cid,explanation:text};
  }},
  {id:'B08',requirements:['长查询继续提问','旧结果归原任务'],run:async()=>{
    const cid=await fresh('查2026年1月净收入');const original=(await queries(cid))[0];assert.ok(original);
    assert.equal((await h.request('/queries/'+original.id+'/confirm',{operation_id:randomUUID(),draft_version:original.draft_version,condition_version:original.condition_version})).status,200);
    await h.resumeWorker();await until(async()=>['submitted','running'].includes((await h.request('/queries/'+original.id)).value.execution_state),'查询处理中');
    await ask(cid,'查2026年1月支付客户数，这是另一道独立问题');const newer=(await queries(cid)).at(-1);assert.notEqual(newer.task_id,original.task_id);const sample=await verifySql(cid,'Q02');
    await h.resumeWorker();const wake=await until(()=>h.captured.find(r=>r.conversation_id===cid&&r.text.includes('query_id='+original.id)),'旧查询结果回归');await execute(wake);
    assert.equal((await queries(cid)).find(q=>q.id===newer.id).execution_state,'not_submitted');return {cid,original,newer,...sample,explanation:await answer(cid)};
  }},
];
const prefillCases=JSON.parse(await readFile('docs/sources/evaluation/prefill-cases.json','utf8')).cases;
for(const sample of prefillCases)scenarios.push({id:sample.id,requirements:['有依据的建议','未知保留','再次预填保护人工'],run:async()=>{
  await h.pauseWorker();await h.resumeWorker();
  const objectId='field-'+sample.field;
  const analyze=async()=>{
    const old=(await h.request('/knowledge/'+objectId)).value;
    assert.equal((await h.request('/knowledge/'+objectId+'/reanalyze',{operation_id:randomUUID(),expected_version:old.version})).status,200);
    const value=await until(async()=>{const v=(await h.request('/knowledge/'+objectId)).value;return v.prefill_status&&!['queued','issued'].includes(v.prefill_status.state)?v:false;},sample.id+'预填完成',protocol?40000:750000);
    if(value.prefill_status.state!=='succeeded'){
      const error=new Error('prefill_failed');
      Object.defineProperty(error,'prefillFailure',{value:{object:value,attempt:h.sql(`SELECT JSON_OBJECT('state',state,'error_code',error_code,'result',result_json) FROM prefill_attempts WHERE id='${value.prefill_status.attempt_id}'`)[0]}});
      throw error;
    }
    return value;
  };
  const stages={objectId};
  try{
    const initial=await analyze();stages.initial=initial;const meaning=initial.entries.find(e=>e.path==='meaning');assert.ok(meaning.suggestion.value.trim());assert.ok(meaning.suggestion.evidence.length);
    const edited=await h.request('/knowledge/'+objectId,{operation_id:randomUUID(),expected_version:initial.version,entry_id:'meaning',value:sample.manual_override.value,clear_override:false},'alice','PATCH');assert.equal(edited.status,200);stages.edited=edited.value;
    const repeated=await analyze();const entry=repeated.entries.find(e=>e.path==='meaning');assert.equal(entry.effective_value,sample.manual_override.value);assert.ok(entry.human_override);assert.equal(entry.review_state,'needs_review');assert.ok(entry.suggestion.evidence.length);
    return {objectId,initial,edited:edited.value,repeated,semanticReview:protocol?'protocol_only':'pending_independent_evaluation'};
  }catch(error){
    // 再次分析失败时仍保留已采用的初次结果与人工版本，供独立核对。
    Object.defineProperty(error,'prefillStages',{value:stages});
    throw error;
  }finally{await h.pauseWorker();}
}});
try{
  await h.pauseWorker();
  report.ledgerBefore=ledger();
  if(conversation)report.priorCallReceipts=callReceipts();
  else assert.equal(report.ledgerBefore.calls,0,'账本已使用，拒绝重跑补额；使用--audit查看证据');
  if(reuseConfiguration){
    const trial=h.sql(`SELECT JSON_OBJECT('valid',expires_at IS NULL OR expires_at>UTC_TIMESTAMP(3),'state',state) FROM model_trials WHERE id='${config.profile.trial_id}'`)[0];
    assert.ok(trial.valid,'trial_expired_authorization_required');
    assert.equal(trial.state,'active');
    const configuration=(await h.request('/model-configuration')).value;
    effectiveService=configuration.services.find(s=>s.id===config.profile.configured_model.service_id);
    effectiveModel=configuration.models.find(m=>m.id===config.profile.configured_model.id);
    assert.ok(effectiveService&&effectiveModel,'original_model_configuration_required');
  }else{
  let credentials;
  if(protocol)credentials={DEEPSEEK_API_KEY:'synthetic-protocol-key',DEEPSEEK_BASE_URL:'http://127.0.0.1:'+provider.address().port,DEEPSEEK_MODEL:'deepseek-flash'};
  else{
    assert.equal((await stat('.env')).mode&0o077,0);
    credentials=Object.fromEntries((await readFile('.env','utf8')).split(/\r?\n/).filter(l=>/^(DEEPSEEK_API_KEY|DEEPSEEK_BASE_URL|DEEPSEEK_MODEL)=/.test(l)).map(l=>{const i=l.indexOf('=');return[l.slice(0,i),l.slice(i+1).trim()];}));
    assert.equal(credentials.DEEPSEEK_BASE_URL,'https://api.deepseek.com');assert.ok(['deepseek-flash','deepseek-v4-pro'].includes(credentials.DEEPSEEK_MODEL));assert.ok(credentials.DEEPSEEK_API_KEY);
  }
  credentials.DEEPSEEK_MODEL=config.profile.model_id;
  Object.assign(process.env,credentials);if(protocol)process.env.DATA_AGENT_PROVIDER_TEST='1';else delete process.env.DATA_AGENT_PROVIDER_TEST;
  h.env.DATA_AGENT_PREFILL_PROFILE=JSON.stringify(config.profile);
  h.env.DATA_AGENT_PREFILL_URL=credentials.DEEPSEEK_BASE_URL+'/chat/completions';
  h.env.DEEPSEEK_API_KEY=credentials.DEEPSEEK_API_KEY;
  if(protocol)h.env.DATA_AGENT_PREFILL_TEST='1';else delete h.env.DATA_AGENT_PREFILL_TEST;
  // API seed只提供legacy兼容定义；首条消息前经现有管理接口恢复输入配置。
  // 回环与官方共用接线，凭据只入加密存储，报告只保留公开的连接和模型能力。
  const requested=config.profile.configured_model;
  const configuration=(await h.request('/model-configuration')).value;
  const service=configuration.services.find(s=>s.id===requested.service_id);
  const model=configuration.models.find(m=>m.id===requested.id);
  assert.ok(service&&model,'启动配置缺少目标模型或服务');
  const savedService=await h.request('/model-services',{id:service.id,name:service.name,
    provider_id:config.profile.provider_id,api:requested.api,base_url:credentials.DEEPSEEK_BASE_URL,
    enabled:true,expected_version:service.version,api_key:credentials.DEEPSEEK_API_KEY});
  assert.equal(savedService.status,200,'模型凭据配置失败: '+JSON.stringify(savedService.value));
  effectiveService=savedService.value.services.find(s=>s.id===service.id);
  const definition={id:requested.id,service_id:requested.service_id,model_id:config.profile.model_id,
    label:model.label,thinking_levels:model.thinking_levels,reasoning_supported:requested.reasoning_supported,
    default_thinking:config.profile.thinking_level,enabled:true,expected_version:model.version,
    input_rate:requested.input_rate,output_rate:requested.output_rate};
  for(const field of ['context_window','input_limit','output_limit','payload_bytes_limit','request_timeout_ms','capability_source'])
    definition[field]=config.profile[field];
  const savedModel=await h.request('/model-definitions',definition);
  assert.equal(savedModel.status,200,'模型定义配置失败: '+JSON.stringify(savedModel.value));
  effectiveModel=savedModel.value.models.find(m=>m.id===requested.id);
  if(savedModel.value.default_model_id!==requested.id)
    assert.equal((await h.request('/model-configuration/default',{model_id:requested.id,expected_version:savedModel.value.version})).status,200);
  }
  if(conversation){
    const platformUrl=h.env.DATA_AGENT_PLATFORM_URL;
    platformProxy=createServer(async(request,response)=>{
      try{
        const chunks=[];for await(const chunk of request)chunks.push(chunk);
        const raw=Buffer.concat(chunks),payload=JSON.parse(raw.toString('utf8'));
        const observation={path:request.url,at:new Date().toISOString(),...(request.url==='/submit'?{payload}:{query_id:payload.query_id})};
        report.platformRequests.push(observation);
        const upstream=await fetch(platformUrl+request.url,{method:request.method,headers:{authorization:request.headers.authorization,'content-type':'application/json'},body:raw,signal:AbortSignal.timeout(10000)});
        observation.status=upstream.status;
        response.writeHead(upstream.status,{'content-type':'application/json'});response.end(Buffer.from(await upstream.arrayBuffer()));
      }catch(error){report.platformFailure=error.code??error.name;response.destroy();}
    });
    await new Promise((resolve,reject)=>{platformProxy.once('error',reject);platformProxy.listen(0,'127.0.0.1',resolve);});
    h.env.DATA_AGENT_PLATFORM_URL='http://127.0.0.1:'+platformProxy.address().port;
  }
  report.modelConfiguration={source:protocol?'synthetic_protocol_profile':option('--model-profile')??'.local/model-workflow/configuration.json',
    service:{id:effectiveService.id,version:effectiveService.version,provider_id:effectiveService.provider_id,api:effectiveService.api,base_url:effectiveService.base_url},
    model:effectiveModel};
  const selection=option('--cases')?.split(',')??(group?groups[group]:scenarios.map(v=>v.id));
  assert.ok(selection.every(id=>scenarios.some(v=>v.id===id)),'存在未知业务题');
  report.selectedCases=selection;report.pending=scenarios.filter(v=>!selection.includes(v.id)).map(v=>v.id);
  for(const scenario of scenarios.filter(v=>selection.includes(v.id))){
    currentRun=undefined;
    const start=ledger();
    console.log(JSON.stringify({case:scenario.id,state:'running',calls:start.calls}));
    try{
      const artifacts=await scenario.run();
      const cids=[];const collect=value=>{if(!value||typeof value!=='object')return;for(const[key,entry]of Object.entries(value)){if(['cid','conversation_id','other','otherApp','last','next'].includes(key)&&typeof entry==='string'&&/^[a-f0-9-]{36}$/.test(entry)&&!cids.includes(entry))cids.push(entry);else if(entry&&typeof entry==='object')collect(entry);}};collect(artifacts);
      const traces=cids.map(cid=>({cid,tools:h.sql(`SELECT JSON_OBJECT('tool_name',tool_name,'state',state,'operation_id',operation_id,'receipt',receipt) FROM tool_calls WHERE origin_run_id IN (SELECT id FROM agent_runs WHERE conversation_id='${cid}')`),snapshot:null}));
      for(const trace of traces)trace.snapshot=await h.snapshot(trace.cid);
      report.checks.push({id:scenario.id,requirements:scenario.requirements,machinePassed:true,calls:ledger().calls-start.calls,artifacts,traces});
      console.log(JSON.stringify({case:scenario.id,state:'machine_passed',calls:ledger().calls-start.calls}));
    }catch(error){
      // 官方错误只保留稳定错误码；原始上游错误和凭据不进入验收报告。
      const safeError=error.code??(/^[a-z][a-z0-9_]*$/.test(error.message??'')?error.message:error.name);
      const failedCheckpoint=error.checkpoint??(currentRun?h.sql(`SELECT checkpoint FROM pi_checkpoints WHERE recovery_chain_id='${currentRun.recovery_chain_id}'`)[0]:null);
      report.checks.push({id:scenario.id,machinePassed:false,error:protocol?String(error):safeError,
        ...(conversation?{failureStage:conversationSample?.stage??'startup',artifacts:conversationSample}:{}),failedSnapshot:currentRun?await h.snapshot(currentRun.conversation_id):null,failedCheckpoint,...(error.prefillFailure?{prefillFailure:error.prefillFailure}:{}),...(error.prefillStages?{prefillStages:error.prefillStages}:{})});
      report.pending.push(...selection.filter(id=>!report.checks.some(v=>v.id===id)));
      throw error;
    }
  }
  report.machinePassed=true;report.completion=protocol?'protocol_passed_quality_unverified':'awaiting_independent_semantic_review';
}finally{
  let cleanupError;
  try{
    report.ledger=ledger();
    report.callReceipts=callReceipts();
    if(conversation){
      const previousIds=new Set(report.priorCallReceipts.map(call=>call.id));
      assert.deepEqual(report.callReceipts.filter(call=>previousIds.has(call.id)),report.priorCallReceipts,'旧调用费用与回执不得改写');
      report.callReceipts=report.callReceipts.filter(call=>!previousIds.has(call.id));
      report.ledgerDelta=Object.fromEntries(['calls','spent_micros','reserved_micros'].map(key=>[key,report.ledger[key]-report.ledgerBefore[key]]));
      assert.equal(report.callReceipts.length,report.ledgerDelta.calls);
    }
  }catch(error){cleanupError=error;report.ledgerError='ledger_unavailable';}
  report.officialRequests=protocol?0:conversation?report.ledgerDelta?.calls??null:report.ledger?.calls??null;
  report.payloadBytes=payloadBytes;report.verifiedAt=new Date().toISOString();
  if(conversation&&conversationSample?.query){
    // 同一harness仍存活时核本次对话，刷新只读，不追加模型消息。
    const sample=conversationSample;
    report.browser={passed:false,conversation_id:sample.cid,query_id:sample.query.id,page_url:h.url,
      api_url:h.env.DATA_AGENT_API_URL,database:config.database,sourceHashes:report.sourceHashes,observed_at:new Date().toISOString()};
    let browser;
    try{
      await h.pauseWorker();
      const [{chromium},{conversationStorageKey}]=await Promise.all([
        import('playwright'),import('../../apps/web/src/features/workbench/conversation-storage.ts'),
      ]);browser=await chromium.launch();
      const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(30000);
      const snapshots=[],errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      page.on('response',async response=>{if(new URL(response.url()).pathname==='/api/conversations/'+sample.cid+'/snapshot'&&response.ok())snapshots.push(await response.json());});
      report.browser.stage='login';
      await page.goto(h.url);
      await page.getByLabel('演示登录凭据').fill(h.tokens.alice);
      await page.getByRole('button',{name:'进入工作台 →',exact:true}).click();
      report.browser.stage='conversation_read';
      const matchingHistory=page.getByRole('navigation',{name:'会话历史'}).getByRole('button',{name:/查2026年1月整月支付客户数/});
      await until(async()=>await matchingHistory.count()>=(sample.previousHistory?2:1),'S02历史目录加载');
      report.browser.same_title_history_count=await matchingHistory.count();
      // 沿现有历史浏览器接缝绑定真实cid，同名旧题不参与本次选择。
      await page.evaluate(({key,cid})=>localStorage.setItem(key,cid),{key:conversationStorageKey('demo','alice'),cid:sample.cid});
      await page.reload();
      const card=page.locator('#query-'+sample.query.id);
      await card.waitFor();
      if(sample.result)await card.locator('tbody tr').first().waitFor();
      const body=page.locator('.messages article.message.assistant .assistant-markdown').last();
      await body.waitFor();
      const before={text:await body.innerText(),rows:await card.locator('tbody tr').allTextContents()};
      assert.ok(before.text.trim());
      const formal=sample.continuation?.finalOutput??sample.finalOutput??report.conversationRuns.at(-1).finalOutput;
      await until(()=>snapshots.some(s=>s.messages.some(m=>m.output_id===formal.output_id&&m.text===formal.text)),'浏览器收到正式正文');
      report.browser.stage='refresh';
      await page.reload();await card.waitFor();await body.waitFor();
      if(sample.result)await card.locator('tbody tr').first().waitFor();
      const after={text:await body.innerText(),rows:await card.locator('tbody tr').allTextContents()};
      assert.deepEqual(after,before,'同一对话刷新后正文与查询卡一致');
      assert.deepEqual(errors,[]);
      if(sample.previousHistory){
        const previous=h.sql(`SELECT JSON_OBJECT('conversation_id',id,'title',title) FROM conversations WHERE id='${sample.previousHistory.conversation_id}'`)[0];
        assert.deepEqual(previous,sample.previousHistory,'同名旧历史保持原记录');
        report.browser.previous_history_retained=true;
      }
      const screenshot=join(dirname(evidence),'conversation-'+sample.cid+'.png');
      await page.screenshot({path:screenshot,fullPage:true});
      Object.assign(report.browser,{passed:true,stage:'completed',refreshMatches:true,before,after,screenshot});
    }catch(error){report.browser.error=error.code??error.name;report.machinePassed=false;report.completion='incomplete';process.exitCode=1;}
    finally{if(browser)await browser.close();}
  }
  if(conversation){RustTransport.prototype.post=originalPost;unsubscribe('undici:request:create',observeRequest);}
  try{await h.close();}catch(error){cleanupError=error;report.cleanupError='test_database_cleanup_failed';}
  if(platformProxy){platformProxy.closeAllConnections();await new Promise(r=>platformProxy.close(r));}
  if(provider)await new Promise(r=>provider.close(r));
  for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  if(cleanupError){report.machinePassed=false;report.completion='incomplete';}
  report.verifiedAt=new Date().toISOString();
  if(conversation){report.runtime.closed_at=report.verifiedAt;report.runtime.closed=!cleanupError;}
  await mkdir('.local/checks',{recursive:true});await mkdir('.local/model-workflow',{recursive:true,mode:0o700});
  await writeFile(evidence,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({machinePassed:report.machinePassed,completion:report.completion,cases:report.checks.map(v=>({id:v.id,passed:v.machinePassed})),officialRequests:report.officialRequests,evidence}));
  if(cleanupError)throw cleanupError;
}

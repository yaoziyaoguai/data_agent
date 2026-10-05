// 独立成对实验复用正式Pi交付和Rust规则；不实现另一套Agent循环。
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {readFile, writeFile, mkdir, stat} from 'node:fs/promises';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import {resolve} from 'node:path';
import {AsyncLocalStorage} from 'node:async_hooks';
import {harness, until} from '../../tests/mvp/harness.mjs';
import {deliver} from '../../apps/agent/session/deliver.ts';
import {RustTransport} from '../../apps/agent/transport/client.ts';
import {validateContract} from '../../packages/contracts/validate.ts';

const root = process.cwd();
const argv = process.argv.slice(2);
const resumeIndex = argv.indexOf('--resume');
const resume = resumeIndex >= 0;
const sample = argv.includes('--sample');
const repetitions = 2;
assert.equal(sample || argv.includes('--run') || resume, true, '使用--sample、--run或--resume目录');
assert.ok(!resume || (!sample && argv[resumeIndex+1]));
const runId = new Date().toISOString().replaceAll(/[-:.]/g,'') + '_' + randomBytes(4).toString('hex');
const directory = resume ? resolve(argv[resumeIndex+1]) : root + '/.local/mem0-agent-comparison/' + runId;
assert.ok(directory.startsWith(root+'/.local/mem0-agent-comparison/'));
await mkdir(directory, {recursive:true, mode:0o700});
const sha = text => createHash('sha256').update(text).digest('hex');
const sourceHashes = () => JSON.parse(execFileSync('python3', ['-c',
  "import pathlib,hashlib,json,sys;files=[]\nfor n in sys.argv[1:]:\n p=pathlib.Path(n);files.extend([p] if p.is_file() else [f for f in p.rglob('*') if f.is_file() and '__pycache__' not in f.parts])\nprint(json.dumps({str(f):hashlib.sha256(f.read_bytes()).hexdigest() for f in sorted(set(files))}))",
  'apps','crates','packages/contracts','docs/sources','tests/mvp/harness.mjs','scripts/evaluate_business_sql.py',
  'experiments/mem0-comparison','Cargo.toml','Cargo.lock','package.json','package-lock.json'], {encoding:'utf8'}));
const embedding = JSON.parse(await readFile(resume ? directory+'/embedding-config.json' : '.local/mem0-comparison/20261005T090450Z_17d3a6d5/embedding-config.json','utf8'));
embedding.request_limit = 1000;
embedding.maximum_charge_cny = 2;
if(!resume)await writeFile(directory+'/embedding-config.json', JSON.stringify(embedding), {mode:0o600});
assert.equal((await stat('.env')).mode & 0o077, 0);
const credentials = Object.fromEntries((await readFile('.env','utf8')).split(/\r?\n/)
  .filter(line => /^(DEEPSEEK_API_KEY|DEEPSEEK_BASE_URL)=/.test(line)).map(line => {
    const index = line.indexOf('='); return [line.slice(0,index),line.slice(index+1).trim()];
  }));
assert.equal(credentials.DEEPSEEK_BASE_URL,'https://api.deepseek.com');
assert.ok(credentials.DEEPSEEK_API_KEY);
Object.assign(process.env,credentials,{DEEPSEEK_MODEL:'deepseek-flash'});
delete process.env.DATA_AGENT_PROVIDER_TEST;

const pending = new Map();
const rpcProcess = spawn('.local/mem0-comparison/20261005T090450Z_17d3a6d5/venv/bin/python',
  ['experiments/mem0-comparison/agent-memory-service.py',directory], {cwd:root,stdio:['pipe','pipe','pipe']});
let serviceLog = resume ? await readFile(directory+'/service-stderr.log','utf8') : '';
rpcProcess.stderr.on('data',chunk=>serviceLog+=chunk);
createInterface({input:rpcProcess.stdout}).on('line',line=>{
  let value;
  try {value=JSON.parse(line);} catch {serviceLog+='rpc_non_json_output\n';return;}
  const entry = pending.get(value.id);
  if(!entry)return;
  pending.delete(value.id);clearTimeout(entry.timer);
  if(value.ok)entry.resolve(value.value);else entry.reject(new Error(value.error));
});
rpcProcess.on('exit',()=>{for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(new Error('memory_process_ended'));}pending.clear();});
const rpc = body => new Promise((resolve,reject)=>{
  const id = randomUUID();
  const timer = setTimeout(()=>{pending.delete(id);reject(new Error('memory_rpc_timeout'));},240000);
  pending.set(id,{resolve,reject,timer});
  rpcProcess.stdin.write(JSON.stringify({id,...body})+'\n');
});
const inputs = sample ? {scenarios:[{id:'sample',steps:[
  {conversation:'learn',text:'请记住：以后我的分析默认只看store渠道。现在只保存偏好，不查数据。'},
  {conversation:'probe',text:'查2026年1月净收入，给SQL等待确认。'}
]}]} : JSON.parse(await readFile('experiments/mem0-comparison/agent-inputs.json','utf8'));
const before = sourceHashes();
const report = resume ? JSON.parse(await readFile(directory+'/result.json','utf8')) : {schema:2,runId,sample,repetitions,sourceHashes:before,groups:['original','mem0'],scenarios:[],
  configuration:{agent_model:'deepseek-flash',thinking:'high',mem0:'2.2.1',infer:true,
    extraction_thinking:'disabled',embedding:embedding.model,dimensions:embedding.dimensions,
    agent_call_limit:sample?96:1100,agent_cost_limit_micros:sample?2000000:20000000},startedAt:new Date().toISOString()};
if(!resume)await writeFile(directory+'/manifest.json',JSON.stringify(report,null,2),{mode:0o600});
if(resume){
  assert.equal(report.sample,false);assert.equal(report.schema,2);assert.equal(report.repetitions,repetitions);
  assert.equal(report.configuration.agent_model,'deepseek-flash');assert.equal(report.configuration.thinking,'high');
  assert.deepEqual(before,report.sourceHashes,'恢复不能改变冻结文件集合或内容');
  assert.ok(report.scenarios.every(value=>value.finishedAt&&value.ledger),'先查证未保存完整账本的场景');
  const checkpoint=JSON.stringify(report,null,2);
  const segment={number:(report.resumeSegments?.length??0)+1,startedAt:new Date().toISOString(),
    previousResultSha256:sha(checkpoint),previousFinishedAt:report.finishedAt,sourceHashes:before,
    skipped:report.scenarios.map(value=>[value.id,value.group])};
  await writeFile(directory+`/result-before-resume-${segment.number}.json`,checkpoint,{mode:0o600,flag:'wx'});
  (report.resumeSegments??=[]).push(segment);
  delete report.finishedAt;
}
let completedCalls=resume?report.scenarios.reduce((n,s)=>n+s.ledger.calls,0):0,
    completedCost=resume?report.scenarios.reduce((n,s)=>n+Number(s.ledger.spent_micros)+Number(s.ledger.reserved_micros),0):0;
const contexts=new AsyncLocalStorage();
const activeContexts=new Set();
let reserveTail=Promise.resolve(), writeTail=Promise.resolve();
function saveReport() {
  writeTail=writeTail.then(()=>writeFile(directory+'/result.json',JSON.stringify(report,null,2),{mode:0o600}));
  return writeTail;
}
const attempted=new Set(report.scenarios.map(value=>value.id+'::'+value.group+'::'+value.repetition));
const ledger = h => h.sql("SELECT JSON_OBJECT('calls',allocated_calls,'spent_micros',spent_micros,'reserved_micros',reserved_micros,'state',state) FROM model_trials LIMIT 1")[0];
const assets = async h => {
  const response=await h.request('/assets');assert.equal(response.status,200);return response.value.assets;
};
const principal = {user_id:'alice',space_id:'demo'};
const stableId = value => {const hex=sha(value).slice(0,32);return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;};
const nativePost = RustTransport.prototype.post;
async function searchMemories(context, query) {
  const found = await rpc({action:'search',case:context.caseName,principal,query});
  context.memoryTrace.push({action:'search',query,receipt:found});
  const formal = await assets(context.h);
  const seen = new Set(), result = [];
  for(const hit of found.results){
    const meta=hit.metadata;
    assert.equal(meta.owner_id,principal.user_id);assert.equal(meta.space_id,principal.space_id);
    const asset=formal.find(asset=>asset.id===meta.runtime_id&&asset.version===meta.asset_version&&asset.state==='enabled'&&asset.kind==='memory');
    if(!asset||seen.has(asset.id))continue;
    seen.add(asset.id);result.push({asset,hit});
  }
  return result;
}
RustTransport.prototype.post = async function(path,name,input,...rest) {
  const context=contexts.getStore();
  assert.ok(context);
  if(path==='/internal/model/reserve'){
    const previous=reserveTail;
    let release;
    reserveTail=new Promise(resolve=>{release=resolve;});
    await previous;
    try {
      const running=[...activeContexts].map(value=>ledger(value.h));
      const calls=completedCalls+running.reduce((sum,value)=>sum+(value?.calls??0),0);
      const cost=completedCost+running.reduce((sum,value)=>sum+Number(value?.spent_micros??0)+Number(value?.reserved_micros??0),0);
      const reserve=Math.ceil((32768*30+32768*120)/100);
      if(calls>=report.configuration.agent_call_limit || cost+reserve>report.configuration.agent_cost_limit_micros)
        throw new Error('budget_exhausted');
      return await nativePost.call(this,path,name,input,...rest);
    } finally {release();}
  }
  let operation;
  if(context.group==='mem0' && ['/internal/data/tool-calls','/internal/data/tools','/internal/data/tool-rejections'].includes(path)
     && input.tool_name==='manage_personal_asset' && input.arguments.action!=='disable_memory') {
    const args=input.arguments;
    operation=sha(JSON.stringify([this.run.run_id,input.sdk_tool_call_id]));
    // 持久prepare回执在三条路径重放同一正文；Pi原始检查点参数保留，不触发二次收费提取。
    const prepared=await rpc({action:'prepare',case:context.caseName,principal,operation,
      message:this.run.text,quote:args.instruction_quote,
      ...(context.fault==='extraction_unavailable'?{fault:context.fault}:{})}).catch(error=>{
        context.memoryTrace.push({action:'prepare_failed',operation,path,error:error.message});throw error;
      });
    const original=structuredClone(args);
    input={...input,arguments:{...args,body:prepared.body}};
    context.memoryTrace.push({action:'prepare',operation,path,original_arguments:original,
      sent_arguments:input.arguments,receipt:prepared});
  }
  const result=await nativePost.call(this,path,name,input,...rest);
  if(context.group!=='mem0'||path!=='/internal/data/tools')return result;
  if(input.tool_name==='manage_personal_asset'&&!result.data.error){
    const asset=(await assets(context.h)).find(asset=>asset.id===result.data.id);
    assert.ok(asset);assert.equal(asset.version,result.data.version);
    try {
      const receipt=await rpc({action:'commit',case:context.caseName,principal,asset,operation,
        ...(context.fault==='index_commit_unavailable'?{fault:context.fault}:{})});
      context.memoryTrace.push({action:'commit',operation,asset_id:asset.id,version:asset.version,receipt});
      if(['failed','pending'].includes(receipt.index_state))throw new Error('memory_index_failed');
    }catch(error){
      context.indexFailed=true;
      context.memoryTrace.push({action:'commit_failed',operation,asset_id:asset.id,version:asset.version,error:error.message});
      result.data.memory_index={state:'failed',note:'正式个人记忆已经保存；Mem0索引提交失败，当前使用正式个人资产目录。'};
    }
  }
  if(input.tool_name==='search_knowledge'&&!result.data.error&&input.arguments.query!=='*'&&!input.arguments.asset_after&&!context.indexFailed){
    const found=await searchMemories(context,input.arguments.query);
    const memories=[];
    for(const {asset} of found.slice(0,input.arguments.limit??10)){
      // 通过正式受控读取补登记依据；不能只在Node回执中新增个人资产。
      const reading={...input,sdk_tool_call_id:stableId(this.run.run_id+':mem0-validation:'+asset.id+':'+asset.version),
        tool_name:'read_knowledge',arguments:{object_id:'asset-'+asset.id,version:asset.version,limit:160}};
      await nativePost.call(this,'/internal/data/tool-calls','DataToolInvocation',reading);
      const validated=await nativePost.call(this,'/internal/data/tools','DataToolInvocation',reading);
      context.memoryTrace.push({action:'authority_read',asset_id:asset.id,version:asset.version,receipt:validated});
      if(validated.data.error)continue;
      memories.push({...validated.data,object_id:'asset-'+asset.id});
    }
    result.data.personal_memories=memories;
    result.data.next_asset_after=null;
    result.data.memory_search_coverage={state:'bounded',candidate_limit:20,source:'mem0_index_authoritative_read'};
  }
  validateContract('DataToolOutcome',result);
  return result;
};

async function runScenario(scenario,group,repetition) {
  const profile={provider_id:'deepseek',model_id:'deepseek-flash',trial_id:randomUUID(),price_version:'2026-10-04-peak-usd',
    input_limit:32768,output_limit:32768,trial_call_limit:48,trial_cost_micros:'1000000',request_call_limit:24,
    toolset:'data',payload_bytes_limit:131072,thinking_level:'high'};
  const database='data_agent_trial_'+randomBytes(8).toString('hex');
  const h=await harness({capture:true,profile,database,keep:true,env:{DATA_AGENT_LEASE_MS:'120000'}});
  const caseName=scenario.id+'_r'+repetition;
  const context={h,group,caseName,memoryTrace:[],indexFailed:false,fault:scenario.fault};
  activeContexts.add(context);
  return contexts.run(context,async()=>{
  const saved={id:scenario.id,group,repetition,fault:scenario.fault??null,profile,database,steps:[],memoryTrace:context.memoryTrace,harness_directory:h.directory};
  report.scenarios.push(saved);
  const conversations=new Map();
  try {
    await h.pauseWorker();
    if(group==='mem0')saved.index=await rpc({action:'case',name:caseName});
    for(const [index,step]of scenario.steps.entries()){
      let cid=conversations.get(step.conversation);
      if(!cid){cid=await h.create();conversations.set(step.conversation,cid);}
      if(scenario.fault==='reject_memory_insert'&&index===0)
        h.sql("CREATE TRIGGER reject_memory BEFORE INSERT ON personal_assets FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic_memory_failure'");
      const result={index,conversation_id:cid,text:step.text,startedAt:new Date().toISOString()};
      saved.steps.push(result);
      let run;
      try {
        await h.resumeWorker();run=await h.capture(cid,step.text);
        // 小池启动候选已由Rust登记全部版本，只在该集合内筛选/重排。
        const dispatch=structuredClone(run);
        if(group==='mem0'&&!context.indexFailed){
          assert.ok((run.workspace_context.asset_counts?.memories??0)<=20,'本轮不冒称大记忆目录覆盖');
          const found=await searchMemories(context,run.text);
          const native=run.workspace_context.memories;
          dispatch.workspace_context.memories=found.map(({asset})=>native.find(value=>value.id===asset.id&&value.version===asset.version)).filter(Boolean);
          result.native_startup_ids=native.map(value=>[value.id,value.version]);
          result.mem0_startup_ids=dispatch.workspace_context.memories.map(value=>[value.id,value.version]);
        }
        await deliver(dispatch,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,'');
        result.snapshot=await h.snapshot(cid);
        assert.ok(result.snapshot.runs.some(value=>value.run_id===run.run_id&&value.state==='finished'));
        result.answer=result.snapshot.messages.filter(value=>value.role==='assistant'&&value.committed).at(-1)?.text??'';
        result.queries=(await h.request('/conversations/'+cid+'/queries')).value.queries;
        result.conditions=h.sql("SELECT JSON_OBJECT('task_id',task_id,'version',CAST(version AS CHAR),'body',body) FROM condition_revisions");
        result.assets=await assets(h);
        result.machine_complete=true;
      }catch(error){
        result.error=/^[a-z][a-z0-9_: ]+$/.test(error.code??error.message??'')?(error.code??error.message):error.name;
        result.snapshot=await h.snapshot(cid);
        result.assets=await assets(h);
        saved.incomplete=true;
        break;
      }finally{
        if(run)h.releaseRun(run.run_id);
        if(scenario.fault==='reject_memory_insert'&&index===0)h.sql('DROP TRIGGER reject_memory');
        await h.pauseWorker();
        result.elapsed_ms=Date.now()-Date.parse(result.startedAt);
        console.log(JSON.stringify({id:scenario.id,group,repetition,step:index,complete:result.machine_complete??false,calls:ledger(h)?.calls??0}));
        await saveReport();
      }
    }
  }catch(error){saved.error=error.name;saved.incomplete=true;}
  finally {
    saved.ledger=ledger(h);
    activeContexts.delete(context);
    completedCalls+=saved.ledger?.calls??0;
    completedCost+=Number(saved.ledger?.spent_micros??0)+Number(saved.ledger?.reserved_micros??0);
    saved.callReceipts=h.sql("SELECT JSON_OBJECT('id',id,'state',state,'usage',usage_json) FROM model_call_attempts ORDER BY id");
    saved.tools=h.sql("SELECT JSON_OBJECT('name',tool_name,'state',state,'origin_run_id',origin_run_id,'operation_id',operation_id,'receipt',receipt) FROM tool_calls ORDER BY operation_id");
    saved.authority=h.sql("SELECT JSON_OBJECT('id',id,'state',state,'authority',authority_snapshot) FROM agent_runs ORDER BY id");
    await h.close();
    if(scenario.fault==='reject_memory_insert') {
      const logs=JSON.parse(await readFile(h.directory+'/service-logs.json','utf8'));
      saved.database_failure_observed=logs.some(value=>value.output.includes('synthetic_memory_failure') || /\bstorage_failure kind=database code=45000\b/.test(value.output));
    }
    saved.finishedAt=new Date().toISOString();
    await saveReport();
  }
  });
}
try {
  await Promise.all(Array.from({length:repetitions},(_,i)=>i+1).map(async repetition=>{
    for(const [index,scenario]of inputs.scenarios.entries()){
      for(const group of (index+repetition)%2?['original','mem0']:['mem0','original']){
        if(attempted.has(scenario.id+'::'+group+'::'+repetition))continue;
        await runScenario(scenario,group,repetition);
      }
    }
  }));
  report.memoryTotals=await rpc({action:'totals'});
  report.finalSourceHashes=sourceHashes();assert.deepEqual(report.finalSourceHashes,before);
  report.completed=report.scenarios.every(value=>!value.incomplete);
  report.allScenariosAttempted=report.scenarios.length===inputs.scenarios.length*2*repetitions;
  if(resume)report.resumeSegments.at(-1).finishedAt=new Date().toISOString();
}finally {
  RustTransport.prototype.post=nativePost;
  report.finishedAt=new Date().toISOString();
  report.agentTotals={calls:completedCalls,cost_micros:completedCost};
  try{report.memoryTotals=await rpc({action:'close'});}catch{report.memoryServiceCloseFailed=true;rpcProcess.kill('SIGTERM');}
  await writeFile(directory+'/service-stderr.log',serviceLog,{mode:0o600});
  await saveReport();
  console.log(JSON.stringify({runId,directory,completed:report.completed??false,calls:completedCalls}));
}

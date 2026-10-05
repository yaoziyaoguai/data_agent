import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {modelHarness,trialProfile} from './model-harness.mjs';
import {deliver} from '../../apps/agent/session/deliver.ts';

const directory='.local/model-trial';const configPath=directory+'/configuration.json';const reportPath=directory+'/result.json';
const sourcePaths=['apps/agent/provider/deepseek.ts','apps/agent/session/deliver.ts','apps/agent/session/resources.ts','apps/agent/tools/update-analysis-task.ts','apps/agent/transport/client.ts','apps/agent/transport/server.ts','packages/contracts/schema.json','crates/data-agent/src/modules/runtime/model_calls/store.rs','crates/data-agent/src/use_cases/model_calls.rs','migrations/202610040001_model_calls.sql','package-lock.json'];
const hashes=async()=>Object.fromEntries(await Promise.all(sourcePaths.map(async p=>[p,createHash('sha256').update(await readFile(p)).digest('hex')])));
async function audit(){
 const report=JSON.parse(await readFile(reportPath,'utf8'));assert.deepEqual(report,JSON.parse(await readFile('docs/sources/evaluation/deepseek-trial.json','utf8')),'公开小样证据与原记录不同');assert.equal(report.passed,true,'官方小样尚未通过');const currentHashes=await hashes();const changedFiles=Object.keys(report.sourceHashes).filter(p=>report.sourceHashes[p]!==currentHashes[p]);
 const config=JSON.parse(await readFile(configPath,'utf8'));const h=await modelHarness(config.profile,{database:config.database,keep:true});
 try{
  const ledger=h.query(`SELECT JSON_OBJECT('allocated_calls',allocated_calls,'reserved_micros',reserved_micros,'spent_micros',spent_micros,'state',state) FROM model_trials WHERE id='${config.profile.trial_id}'`)[0];assert.deepEqual(ledger,report.ledger);assert.ok(ledger.allocated_calls<=6);assert.ok(ledger.spent_micros+ledger.reserved_micros<=50000);
  const snapshot=await h.snapshot(report.conversation_id);assert.equal(snapshot.tasks.length,1);assert.equal(snapshot.runs.filter(r=>r.state==='finished').length,1);assert.ok(snapshot.messages.some(m=>m.role==='assistant'&&m.committed));
  console.log(JSON.stringify({passed:true,evidence:'official DeepSeek Flash persisted usage and tool outcome',calls:ledger.allocated_calls,costUpperMicros:ledger.spent_micros,additionalModelRequests:0,evidenceScope:'historical I0-02 sample',currentSourceMatches:changedFiles.length===0,changedFiles}));
 }finally{await h.close();}
}
if(process.argv.includes('--audit')){await audit();}
else if(process.argv.includes('--run')){
 await mkdir(directory,{recursive:true,mode:0o700});
 let config;try{config=JSON.parse(await readFile(configPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;config={database:'data_agent_trial_'+randomBytes(8).toString('hex'),profile:trialProfile(randomUUID())};await writeFile(configPath,JSON.stringify(config,null,2)+'\n',{mode:0o600,flag:'wx'});}
 assert.equal((await stat('.env')).mode&0o077,0,'模型凭据文件权限必须是0600');
 const entries=Object.fromEntries((await readFile('.env','utf8')).split(/\r?\n/).filter(l=>/^(DEEPSEEK_API_KEY|DEEPSEEK_BASE_URL|DEEPSEEK_MODEL)=/.test(l)).map(l=>{const i=l.indexOf('=');return[l.slice(0,i),l.slice(i+1).trim()];}));
 assert.ok(entries.DEEPSEEK_API_KEY);assert.equal(entries.DEEPSEEK_BASE_URL,'https://api.deepseek.com');assert.equal(entries.DEEPSEEK_MODEL,'deepseek-flash');
 for(const k of ['DATA_AGENT_PROVIDER_TEST','DATA_AGENT_MODEL_TIMEOUT_MS'])delete process.env[k];Object.assign(process.env,entries);
 const h=await modelHarness(config.profile,{database:config.database,keep:true});
 try{
  const count=h.query(`SELECT JSON_OBJECT('calls',allocated_calls) FROM model_trials WHERE id='${config.profile.trial_id}'`)[0].calls;
  assert.equal(count,0,'试验已经发送或预留调用；本命令拒绝重做或重置额度，请先审计现有账本');
  const result=await h.run('请为虚构商店建立一个订单退款分析任务，时间范围为近七天。调用工具保存目标后，简短说明保存结果。',deliver);
  const outcome=await result.result;const snapshot=await h.snapshot(result.cid);
  const attempts=h.query(`SELECT JSON_OBJECT('id',id,'state',state,'input_tokens_upper',input_tokens_upper,'output_tokens_max',output_tokens_max,'actual_micros',actual_micros,'usage',usage_json) FROM model_call_attempts WHERE run_id='${result.run.run_id}' ORDER BY id`);
  const ledger=h.query(`SELECT JSON_OBJECT('allocated_calls',allocated_calls,'reserved_micros',reserved_micros,'spent_micros',spent_micros,'state',state) FROM model_trials WHERE id='${config.profile.trial_id}'`)[0];
  let passed=outcome.ok&&snapshot.tasks.length===1&&snapshot.runs[0].state==='finished'&&attempts.length>=2&&attempts.every(a=>a.state==='settled'&&a.usage.input_tokens<=4096&&a.usage.output_tokens<=1024)&&ledger.allocated_calls<=6&&ledger.reserved_micros===0&&ledger.spent_micros<=50000;
  const report={passed,provider:'https://api.deepseek.com',model:'deepseek-flash',thinking:'disabled',piSdk:'1.0.0',material:'synthetic only',requestBodyByteLimit:2048,inputBudgetEstimate:4096,inputLimitMethod:'conservative estimate plus actual usage verification',outputLimit:1024,callLimit:6,costLimitMicros:50000,priceVersion:config.profile.price_version,conversation_id:result.cid,attempts,ledger,tasks:snapshot.tasks,answer:snapshot.messages.filter(m=>m.role==='assistant'&&m.committed).map(m=>m.text),sourceHashes:await hashes(),verifiedAt:new Date().toISOString()};
  assert.ok(!JSON.stringify(report).includes(entries.DEEPSEEK_API_KEY));assert.ok(!h.getLogs().includes(entries.DEEPSEEK_API_KEY));await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  if(!passed){await h.request('/conversations/'+result.cid+'/cancel-run',{run_id:result.run.run_id,lease_epoch:result.run.lease_epoch});throw new Error('official_trial_incomplete: saved private usage and outcome; no automatic retry');}
  console.log(JSON.stringify({passed,calls:ledger.allocated_calls,costUpperMicros:ledger.spent_micros,usage:attempts.map(a=>a.usage),toolTasks:snapshot.tasks.length,evidence:reportPath}));
 }finally{await h.close();delete process.env.DEEPSEEK_API_KEY;}
}else{throw new Error('Use --run for the approved sample, or --audit to verify stored evidence without additional model requests');}

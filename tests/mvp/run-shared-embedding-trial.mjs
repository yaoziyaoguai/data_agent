import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {harness,until} from './harness.mjs';
import {targets,topics,table} from './shared-retrieval-fixture.mjs';

const directory='.local/shared-embedding-trial';
const publicReport='docs/sources/evaluation/qwen-shared-trial.json';
const sourcePaths=[
 'crates/data-agent/src/modules/retrieval/embedding.rs','crates/data-agent/src/modules/retrieval/vector.rs',
 'crates/data-agent/src/modules/runtime/provider_calls/store.rs','crates/data-agent/src/modules/runtime/model_calls/store.rs',
 'crates/data-agent/src/modules/knowledge/store.rs','crates/data-agent/src/use_cases/knowledge_embeddings.rs',
 'crates/data-agent/src/use_cases/knowledge.rs','crates/data-agent/src/use_cases/data_tools.rs',
 'apps/worker/src/main.rs','infra/embedding-model.json','migrations/202610060004_shared_embedding_receipts.sql',
 'packages/contracts/schema.json','tests/mvp/shared-retrieval-fixture.mjs','tests/mvp/run-shared-embedding-trial.mjs',
];
const hashes=async()=>Object.fromEntries(await Promise.all(sourcePaths.map(async path=>[path,createHash('sha256').update(await readFile(path)).digest('hex')])));
const ledger=(h,profile)=>h.sql(`SELECT JSON_OBJECT('calls',allocated_calls,'spent_micros',spent_micros,'reserved_micros',reserved_micros,'state',state) FROM model_trials WHERE id='${profile.trial_id}'`)[0];
const attempts=(h,profile)=>h.sql(`SELECT JSON_OBJECT('id',id,'state',state,'usage',usage_json,'actual_micros',actual_micros,'dimension',JSON_LENGTH(response_json,'$[0]'),'vectors',JSON_LENGTH(response_json)) FROM model_call_attempts WHERE trial_id='${profile.trial_id}' ORDER BY id`);

if(process.argv.includes('--audit')){
 const config=JSON.parse(await readFile(directory+'/configuration.json','utf8'));
 const report=JSON.parse(await readFile(directory+'/result.json','utf8'));
 assert.deepEqual(report,JSON.parse(await readFile(publicReport,'utf8')));
 assert.equal(report.passed,true);assert.deepEqual(report.sourceHashes,await hashes(),'real sample source changed');
 const h=await harness({database:config.database,keep:true,startWorker:false});
 try{
  assert.deepEqual(ledger(h,config.profile),report.ledger);assert.deepEqual(attempts(h,config.profile),report.attempts);
  assert.equal(report.results.length,4);assert.ok(report.results.every(r=>r.rank>=1&&r.rank<=6));
  console.log(JSON.stringify({passed:true,model:report.model,dimension:report.dimension,semanticHits:'4/4',calls:report.ledger.calls,additionalModelRequests:0,evidence:publicReport}));
 }finally{await h.close();}
}else if(process.argv.includes('--run')){
 await mkdir(directory,{recursive:true,mode:0o700});
 let config;
 try{config=JSON.parse(await readFile(directory+'/configuration.json','utf8'));}
 catch(error){
  if(error.code!=='ENOENT')throw error;
  config={database:'data_agent_trial_'+randomBytes(8).toString('hex'),collection:'data_agent_shared_sample_'+randomBytes(8).toString('hex'),profile:{trial_id:'shared_sample_'+randomUUID(),call_limit:160,cost_limit_micros:'100000'}};
  await writeFile(directory+'/configuration.json',JSON.stringify(config,null,2)+'\n',{mode:0o600,flag:'wx'});
 }
 const spec=JSON.parse(await readFile('infra/embedding-model.json','utf8'));
 const credentials=JSON.parse(await readFile('.local/memory/configuration.json','utf8'));
 assert.equal(credentials.embedding_url,spec.endpoint);
 const keyFile=resolve(credentials.embedding_key_file);assert.equal((await stat(keyFile)).mode&0o077,0);
 const h=await harness({database:config.database,keep:true,startWorker:false,env:{DATA_AGENT_EMBEDDING_URL:spec.endpoint,DATA_AGENT_EMBEDDING_KEY_FILE:keyFile,DATA_AGENT_EMBEDDING_TEST:'0',DATA_AGENT_EMBEDDING_PROFILE:JSON.stringify(config.profile),DATA_AGENT_VECTOR_URL:'http://127.0.0.1:19531',DATA_AGENT_VECTOR_COLLECTION:config.collection,DATA_AGENT_VECTOR_TOKEN_FILE:resolve('.local/infra/milvus-root-password')}});
 const report={passed:false,provider:spec.endpoint,model:spec.model_id,dimension:spec.dimension,material:'synthetic only',limits:config.profile,results:[],sourceHashes:await hashes(),verifiedAt:new Date().toISOString(),scope:'10 synthetic catalog tables plus built-in demo knowledge; not a thousand-table model accuracy claim'};
 let started=false;
 try{
  assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM model_call_attempts WHERE trial_id='${config.profile.trial_id}'`)[0].n,0,'sample already sent; audit original evidence, do not reset budget');
  started=true;
  // 先核对一条真实响应和usage，再批量建立小样索引。
  const first=await h.request('/knowledge?q='+encodeURIComponent('净收入'));
  assert.equal(first.status,200);const representative=attempts(h,config.profile);
  assert.equal(representative.length,1);assert.equal(representative[0].state,'settled');assert.equal(representative[0].dimension,1024);assert.ok(representative[0].usage.input_tokens>Buffer.byteLength('净收入'));assert.equal(ledger(h,config.profile).state,'active');
  report.representative=representative[0];
  const tables=[...targets.map(([id,text])=>table(id,text)),...topics.map((text,i)=>table('synthetic_distractor_'+i,text))];
  await writeFile(h.directory+'/platform/catalog.json',JSON.stringify({source_namespace:'synthetic-shared-sample',authoritative:true,tables}));
  assert.equal((await h.request('/source-syncs',{operation_id:randomUUID()})).status,200);
  await h.resumeWorker();
  await until(async()=>{
   const rows=h.sql("SELECT JSON_OBJECT('state',vector_state,'error',vector_error) FROM knowledge_index_jobs WHERE vector_state<>'indexed'");
   assert.ok(rows.every(r=>r.state!=='failed'),JSON.stringify(rows));if(rows.length)await new Promise(r=>setTimeout(r,500));return rows.length===0;
  },'official Qwen sample index',240000);
  await h.pauseWorker();
  for(const [id,_text,question] of targets){
   const result=await h.request('/knowledge?q='+encodeURIComponent(question));assert.equal(result.status,200);
   const value=result.value;assert.equal(value.retrieval_mode,'hybrid_authoritative');assert.equal(value.search_coverage.index_state,'current');
   const rank=value.objects.findIndex(o=>o.name===id)+1;
   report.results.push({question,expected:id,rank,candidates:value.objects.map(o=>o.name),coverage:value.search_coverage});
   assert.ok(rank>=1&&rank<=6,JSON.stringify(report.results.at(-1)));
  }
  report.ledger=ledger(h,config.profile);report.attempts=attempts(h,config.profile);
  assert.ok(report.ledger.calls<=config.profile.call_limit);assert.equal(report.ledger.reserved_micros,0);
  assert.ok(report.attempts.every(a=>a.state==='settled'&&a.dimension===1024&&a.usage.input_tokens>0));
  assert.ok(report.ledger.spent_micros<=Number(config.profile.cost_limit_micros));
  report.totalInputTokens=report.attempts.reduce((sum,a)=>sum+a.usage.input_tokens,0);
  report.estimatedCny=report.totalInputTokens*0.5/1_000_000;report.passed=true;
 }finally{
  if(started){
   report.ledger??=ledger(h,config.profile);report.attempts??=attempts(h,config.profile);
   await writeFile(directory+'/result.json',JSON.stringify(report,null,2)+'\n',{mode:0o600});
   if(report.passed)await writeFile(publicReport,JSON.stringify(report,null,2)+'\n');
  }
  await h.close();
 }
 console.log(JSON.stringify({passed:report.passed,semanticHits:'4/4',calls:report.ledger.calls,totalInputTokens:report.totalInputTokens,estimatedCny:report.estimatedCny,evidence:publicReport}));
}else{throw new Error('Use --run for the authorized synthetic sample, or --audit without new model calls');}

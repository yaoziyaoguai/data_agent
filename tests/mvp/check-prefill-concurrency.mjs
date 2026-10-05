import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {harness,until} from './harness.mjs';

const profile={provider_id:'deepseek',model_id:'deepseek-flash',trial_id:randomUUID(),price_version:'2026-10-04-peak-usd',input_limit:32768,output_limit:2048,trial_call_limit:8,trial_cost_micros:'300000',request_call_limit:8,toolset:'data',payload_bytes_limit:65536};
let firstResponse,calls=0,worker,blocker,h,passed=false;
const provider=createServer(async(req,res)=>{
 let raw='';req.setEncoding('utf8');for await(const chunk of req)raw+=chunk;
 const input=JSON.parse(JSON.parse(raw).messages[1].content),source=input.sources[0];calls++;
 const respond=()=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{type:'function',function:{name:'submit_semantic_prefill',arguments:JSON.stringify({entries:[{entry_id:'meaning',value:'并发预填合成说明',gaps:[],evidence:[{source_id:source.source_id,version:source.version,location:'L1',quote:source.body.split('\n')[0]}]}]})}}]}}],usage:{prompt_tokens:100,completion_tokens:80}}));};
 if(calls===1)firstResponse=respond;else respond();
});await new Promise(r=>provider.listen(0,'127.0.0.1',r));
try{
 h=await harness({env:{DATA_AGENT_PREFILL_PROFILE:JSON.stringify(profile),DATA_AGENT_PREFILL_TEST:'1',DATA_AGENT_PREFILL_URL:'http://127.0.0.1:'+provider.address().port}});await h.pauseWorker();
 for(const field of ['paid_amount_cents','paid_at']){
  const old=(await h.request('/knowledge/field-'+field)).value;
  assert.equal((await h.request('/knowledge/field-'+field+'/reanalyze',{operation_id:randomUUID(),expected_version:old.version})).status,200);
 }
 await h.resumeWorker();await until(()=>firstResponse,'首个Worker发起HTTP');
 const container=execFileSync('docker',['--context','colima-data-agent','ps','--filter','label=com.docker.compose.project=data-agent','--filter','label=com.docker.compose.service=mysql','--format','{{.ID}}'],{encoding:'utf8'}).trim();
 const database=new URL(h.env.DATA_AGENT_DATABASE_URL).pathname.slice(1);assert.match(database,/^data_agent_test_[a-f0-9]+$/);
 blocker=spawn('docker',['--context','colima-data-agent','exec','-i',container,'mysql','--defaults-extra-file=/run/secrets/mysql_root_client','--default-character-set=utf8mb4','--batch','--raw','--skip-column-names','--unbuffered'],{stdio:['pipe','pipe','pipe']});
 let stdout='';blocker.stdout.on('data',v=>stdout+=v.toString());
 blocker.stdin.write(`USE ${database}; START TRANSACTION; SELECT id FROM model_trials WHERE id='${profile.trial_id}' FOR UPDATE; SELECT 'locked';\n`);
 await until(()=>stdout.includes('locked'),'固定trial竞争窗口');
 firstResponse();
 await until(()=>h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks l ON w.REQUESTING_ENGINE_LOCK_ID=l.ENGINE_LOCK_ID WHERE l.OBJECT_SCHEMA='${database}' AND l.OBJECT_NAME='model_trials'`)[0].n>=1,'结算等待trial');
 worker=spawn(process.cwd()+'/target/debug/data-agent-worker',{env:h.env,stdio:['ignore','pipe','pipe']});
 let errors='';worker.stderr.on('data',v=>errors+=v.toString());
 await until(()=>h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks l ON w.REQUESTING_ENGINE_LOCK_ID=l.ENGINE_LOCK_ID WHERE l.OBJECT_SCHEMA='${database}' AND l.OBJECT_NAME='model_trials'`)[0].n>=2,'另一Worker准入也等待trial');
 // 此时旧实现是响应事务持trial再等source，另Worker持source等trial；释放后会死锁。
 blocker.stdin.end('COMMIT;\n');
 await until(()=>h.sql("SELECT JSON_OBJECT('n',COUNT(*)) FROM prefill_attempts WHERE state='succeeded'")[0].n===2,'两个Worker完成分析与复核');
 const ledger=h.sql(`SELECT JSON_OBJECT('calls',allocated_calls,'reserved',reserved_micros) FROM model_trials WHERE id='${profile.trial_id}'`)[0];
 assert.deepEqual(ledger,{calls:4,reserved:0});assert.equal(calls,4);
 assert.equal(h.sql("SELECT JSON_OBJECT('n',COUNT(*)) FROM maintenance_model_calls WHERE state='settled'")[0].n,4);
 assert.ok(!errors.includes('storage_failure')&&!errors.includes('prefill_failure'));
 passed=true;
 console.log(JSON.stringify({passed,calls,officialRequests:0,concurrency:'两个Worker同trial，结算与下一次准入真实同时等待，释放后全部结算且没有重发'}));
}finally{
 blocker?.stdin.end('ROLLBACK;\n');worker?.kill('SIGTERM');
 if(worker)await new Promise(r=>worker.once('exit',r));if(h)await h.close();
 await new Promise(r=>provider.close(r));
 await writeFile('.local/checks/mvp-prefill-concurrency.json',JSON.stringify({passed,calls,officialRequests:0},null,2));
}

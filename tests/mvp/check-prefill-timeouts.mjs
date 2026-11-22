import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {harness,until} from './harness.mjs';

for(const name of ['DEEPSEEK_API_KEY','DEEPSEEK_BASE_URL','DEEPSEEK_MODEL','DATA_AGENT_MODEL_PROFILE','DATA_AGENT_MODEL_FAULT','DATABASE_URL','DATA_AGENT_DATABASE_URL'])delete process.env[name];
const modes=['normal_lease','delayed_success','analysis_timeout','review_timeout','expired_usage','worker_exit','late_version_conflict'];
const selected=process.argv.find(value=>value.startsWith('--mode='))?.slice(7);if(selected)assert.ok(modes.includes(selected));
const checks=[];let passed=false;
for(const mode of modes.filter(mode=>!selected||mode===selected)){
  let calls=0,release,arrived,blocker;
  const provider=createServer(async(req,res)=>{
    const parts=[];for await(const part of req)parts.push(part);
    const raw=Buffer.concat(parts).toString('utf8');
    const material=JSON.parse(JSON.parse(raw).messages[1].content),source=material.sources[0];calls++;
    const respond=()=>{
      if(res.destroyed)return;
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{type:'function',function:{name:'submit_semantic_prefill',arguments:JSON.stringify({entries:[{entry_id:'meaning',value:'完整两阶段合成说明',gaps:[],evidence:[{source_id:source.source_id,version:source.version,location:'开头',quote:source.body.split('\n')[0]}]}]})}}]}}],usage:{prompt_tokens:100,completion_tokens:80}}));
    };
    if(mode==='analysis_timeout' || mode==='review_timeout'&&material.draft)return;
    if(mode==='normal_lease'||mode==='expired_usage'||mode==='worker_exit'||mode==='late_version_conflict'&&material.draft){
      release=respond;arrived?.();return;
    }
    if(mode==='delayed_success')await new Promise(resolve=>setTimeout(resolve,350));
    respond();
  });await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
  const profile={provider_id:'deepseek',model_id:'deepseek-flash',trial_id:randomUUID(),price_version:'2026-10-04-peak-usd',input_limit:32768,output_limit:32768,trial_call_limit:4,trial_cost_micros:'300000',request_call_limit:4,toolset:'data',payload_bytes_limit:131072,thinking_level:'high'};
  const env={DATA_AGENT_PREFILL_PROFILE:JSON.stringify(profile),DATA_AGENT_PREFILL_TEST:'1',DATA_AGENT_PREFILL_URL:'http://127.0.0.1:'+provider.address().port,
    DATA_AGENT_PUBLIC_CONTENT_RETENTION:'archive'};
  if(mode!=='normal_lease')env.DATA_AGENT_PREFILL_TIMEOUT_MS=mode==='late_version_conflict'?'5000':mode==='delayed_success'?'2000':'500';
  const h=await harness({env,startWorker:false});
  h.env.DATA_AGENT_PUBLIC_CONTENT_RETENTION='latest_only';await h.restartApi();
  const wait=state=>until(async()=>{const value=(await h.request('/knowledge/field-paid_at')).value;return value.prefill_status?.state===state?value:false;},mode+': '+state);
  try{
    const old=(await h.request('/knowledge/field-paid_at')).value;
    const archives=h.sql(`SELECT JSON_OBJECT('version',version,'body',body) FROM (SELECT object_id,version,archived_body AS body FROM knowledge_revisions WHERE archived_body IS NOT NULL) archive_rows WHERE object_id='${old.id}' ORDER BY version`);
    const revisions=h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM knowledge_revisions WHERE object_id='${old.id}'`)[0].n;
    const response=await h.request('/knowledge/field-paid_at/reanalyze',{operation_id:randomUUID(),expected_version:old.version});assert.equal(response.status,200);
    const expected=response.value.version;assert.equal(expected,String(Number(old.version)+1));
    let gate=new Promise(resolve=>arrived=resolve);await h.resumeWorker();
    if(mode==='normal_lease'){
      for(const stage of ['analysis','review']){
        await gate;
        const seconds=h.sql("SELECT JSON_OBJECT('seconds',TIMESTAMPDIFF(SECOND,UTC_TIMESTAMP(3),issued_until)) FROM prefill_attempts WHERE state='issued'")[0].seconds;
        assert.ok(seconds>=350&&seconds<=360,stage+': '+seconds);
        const next=new Promise(resolve=>arrived=resolve);release();gate=next;
      }
    }else if(mode==='late_version_conflict'){
      await gate;
      const current=(await h.request('/knowledge/field-paid_at')).value,attempt=current.prefill_status.attempt_id;
      const container=execFileSync('docker',['--context','colima-data-agent','ps','--filter','label=com.docker.compose.project=data-agent','--filter','label=com.docker.compose.service=mysql','--format','{{.ID}}'],{encoding:'utf8'}).trim();assert.match(container,/^[a-f0-9]+$/);
      const database=new URL(h.env.DATA_AGENT_DATABASE_URL).pathname.slice(1);assert.match(database,/^data_agent_test_[a-f0-9]+$/);
      blocker=spawn('docker',['--context','colima-data-agent','exec','-i',container,'mysql','--defaults-extra-file=/run/secrets/mysql_root_client','--batch','--raw','--unbuffered','--skip-column-names'],{stdio:['pipe','pipe','pipe']});
      let output='';blocker.stdout.on('data',chunk=>output+=chunk);
      // 资料核对现在锁住目标直到提交；在目标锁之前挂起，允许人工版本先提交。
      blocker.stdin.write(`USE ${database}; START TRANSACTION; SELECT space_id FROM source_sync_locks FOR UPDATE; SELECT 'held';\n`);
      await until(()=>output.includes('held'),'来源核对入口由独立事务持有');release();
      await until(()=>h.sql(`SELECT JSON_OBJECT('n',COUNT(DISTINCT w.REQUESTING_THREAD_ID)) FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID WHERE l.OBJECT_SCHEMA='${database}' AND l.OBJECT_NAME='source_sync_locks'`)[0].n===1,'模型已返回，预填等待提交前的资料锁');
      const edit=await h.request('/knowledge/'+current.id,{operation_id:randomUUID(),expected_version:expected,entry_id:'meaning',value:'复核应用前人工改版'},'alice','PATCH');assert.equal(edit.status,200);
      const child=blocker;blocker=undefined;const closed=new Promise(resolve=>child.once('exit',resolve));child.stdin.end('ROLLBACK;\n');assert.equal(await closed,0);
    }else if(mode==='expired_usage'||mode==='worker_exit'){
      await gate;
      const seconds=h.sql("SELECT JSON_OBJECT('seconds',TIMESTAMPDIFF(SECOND,UTC_TIMESTAMP(3),issued_until)) FROM prefill_attempts WHERE state='issued'")[0].seconds;
      assert.ok(seconds>=0&&seconds<=2);
      if(mode==='worker_exit')await h.pauseWorker();
      h.sql("UPDATE prefill_attempts SET issued_until=TIMESTAMPADD(SECOND,-1,UTC_TIMESTAMP(3)) WHERE state='issued'");
      release();if(mode==='worker_exit')await h.resumeWorker();
    }
    const success=['normal_lease','delayed_success'].includes(mode),value=await wait(success?'succeeded':mode==='late_version_conflict'?'superseded':'unknown');
    if(success){assert.equal(value.entries.find(e=>e.entry_id==='meaning').effective_value,'完整两阶段合成说明');assert.equal(value.version,String(Number(expected)+1));assert.equal(calls,2);}
    else if(mode==='late_version_conflict'){
      assert.equal(value.version,String(Number(expected)+1));assert.equal(value.entries.find(e=>e.entry_id==='meaning').effective_value,'复核应用前人工改版');assert.equal(value.prefill_status.error_code,'stale_knowledge');
      assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM idempotency_receipts WHERE domain='knowledge' AND actor_id='synthetic-prefill' AND operation_id='prefill-${value.prefill_status.attempt_id}'`)[0].n,0,'superseded事务不能提交空操作占位');
      assert.equal(calls,2);
    }else{assert.equal(value.version,expected);assert.notEqual(value.entries.find(e=>e.entry_id==='meaning').effective_value,'完整两阶段合成说明');assert.equal(value.prefill_status.error_code,'model_unknown');}
    assert.deepEqual(h.sql(`SELECT JSON_OBJECT('version',version,'body',body) FROM (SELECT object_id,version,archived_body AS body FROM knowledge_revisions WHERE archived_body IS NOT NULL) archive_rows WHERE object_id='${value.id}' ORDER BY version`),archives,'latest_only保留旧档基线且不新增全文');
    const committed=success||mode==='late_version_conflict'?2:1;
    const metadata=h.sql(`SELECT JSON_OBJECT('version',version,'by',updated_by,'paths',changed_paths,'fingerprint',fingerprint) FROM knowledge_revisions WHERE object_id='${value.id}' AND version>${Number(old.version)} ORDER BY version`);
    assert.deepEqual(metadata.map(row=>row.version),Array.from({length:committed},(_,index)=>Number(old.version)+index+1),'只为实际提交的current修订保存元信息');
    assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM knowledge_revisions WHERE object_id='${value.id}'`)[0].n,revisions+committed);
    assert.equal(metadata[0].by,'alice');
    if(committed===2)assert.equal(metadata[1].by,success?'synthetic-prefill':'alice');
    assert.ok(metadata.every(row=>row.paths.length>0&&typeof row.fingerprint==='string'&&row.fingerprint.length>0));
    const attempt=value.prefill_status.attempt_id,receipts=h.sql(`SELECT JSON_OBJECT('id',id,'state',state,'usage',usage_json) FROM maintenance_model_calls WHERE id='${attempt}' OR id='${attempt}:review' ORDER BY id`);
    const ledger=h.sql(`SELECT JSON_OBJECT('calls',allocated_calls,'reserved',reserved_micros) FROM model_trials WHERE id='${profile.trial_id}'`)[0];
    assert.equal(ledger.calls,calls);
    if(success||mode==='expired_usage'||mode==='late_version_conflict'){assert.equal(ledger.reserved,0);assert.ok(receipts.every(r=>r.state==='settled'&&r.usage.prompt_tokens===100));}
    else{assert.ok(ledger.reserved>0,JSON.stringify({mode,calls,ledger,receipts,prefill:value.prefill_status}));const last=receipts.find(r=>r.id===(mode==='review_timeout'?attempt+':review':attempt));assert.equal(last.state,'issued');assert.equal(last.usage,null);}
    if(mode==='review_timeout'){
      assert.equal(calls,2);assert.equal(receipts.find(r=>r.id===attempt).state,'settled');
      assert.ok(h.sql(`SELECT result_json FROM prefill_attempts WHERE id='${attempt}'`)[0].analysis.entries.length);
    }
    if(['analysis_timeout','expired_usage','worker_exit'].includes(mode))assert.equal(calls,1);
    await new Promise(resolve=>setTimeout(resolve,500));assert.equal(calls,ledger.calls,'未知或过期attempt不能自动重发');
    checks.push({mode,calls,reserved:ledger.reserved,passed:true});console.log(JSON.stringify(checks.at(-1)));
  }finally{
    if(blocker){const closed=new Promise(resolve=>blocker.once('exit',resolve));blocker.stdin.end('ROLLBACK;\n');await closed;}
    release?.();await h.close();provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));
  }
}
passed=true;await writeFile('.local/checks/mvp-prefill-timeouts'+(selected?'-'+selected:'')+'.json',JSON.stringify({passed,checks,selected:selected??null,officialRequests:0},null,2));
console.log(JSON.stringify({passed,checks,selected:selected??null,officialRequests:0}));

import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {harness} from './harness.mjs';

export async function checkMaintenanceBilling({representative=false}={}) {
 const cases=representative?['above_estimate']:['above_estimate','input_exceeded','output_exceeded','usage_missing','late_usage'];
 const reports=[];
 for(const sample of cases){
  const profile={provider_id:'deepseek',model_id:'deepseek-flash',trial_id:randomUUID(),price_version:'2026-10-04-peak-usd',
   input_limit:32768,output_limit:4096,trial_call_limit:20,trial_cost_micros:'5000000',request_call_limit:12,toolset:'data',payload_bytes_limit:65536};
  const calls=[];let h,providerFailure,output='',passed=false;
  const usage={above_estimate:{prompt_tokens:65536,completion_tokens:20},input_exceeded:{prompt_tokens:1048577,completion_tokens:20},
   output_exceeded:{prompt_tokens:100,completion_tokens:4097},usage_missing:null}[sample];
  const provider=createServer(async(req,res)=>{
   try{
    let raw='';for await(const chunk of req)raw+=chunk;
    const request=JSON.parse(raw),material=JSON.parse(request.messages[1].content);
    assert.equal(request.model,profile.model_id);assert.equal(request.max_tokens,profile.output_limit);
    assert.equal(request.tools[0].function.name,'submit_semantic_prefill');
    const source=material.sources.find(source=>source.body?.trim());assert.ok(source);
    const quote=source.body.split('\n').find(line=>line.trim()).slice(0,60);
    const entries=material.object.entries.map(entry=>({entry_id:entry.entry_id,value:'合成计量说明：'+entry.path,gaps:[],
     evidence:[{source_id:source.source_id,version:source.version,location:'合成原文',quote}]}));
    const attempt=h.sql("SELECT JSON_OBJECT('id',id) FROM prefill_attempts WHERE state='issued'")[0];assert.ok(attempt);
    const callId=attempt.id+(material.draft?':review':'');
    const reserved=h.sql(`SELECT JSON_OBJECT('id',id,'trial',trial_id,'state',state,'reserved',reserved_micros) FROM maintenance_model_calls WHERE id='${callId}'`)[0];
    assert.equal(reserved.state,'issued');assert.equal(reserved.trial,profile.trial_id);
    calls.push({callId,stage:material.draft?'review':'analysis',maxTokens:request.max_tokens,reserved,usage});
    res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({choices:[{finish_reason:'tool_calls',
     message:{tool_calls:[{type:'function',function:{name:'submit_semantic_prefill',arguments:JSON.stringify({entries})}}]}}],...(usage?{usage}:{})}));
   }catch(error){providerFailure=error;res.writeHead(500).end();}
  });
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
  try{
   h=await harness({capture:true,startWorker:false,env:{DATA_AGENT_PREFILL_PROFILE:JSON.stringify(profile),DATA_AGENT_PREFILL_TEST:'1',
    DATA_AGENT_PREFILL_URL:'http://127.0.0.1:'+provider.address().port,DATA_AGENT_TEST_MAINTENANCE_OUTCOME:sample}});
   if(sample!=='late_usage'){
    const field=await h.request('/knowledge/field-paid_amount_cents');assert.equal(field.status,200);
    const queued=await h.request('/knowledge/field-paid_amount_cents/reanalyze',{operation_id:randomUUID(),expected_version:field.value.version});assert.equal(queued.status,200);
   }
   const test=sample==='late_usage'?'late_usage_uses_original_budget_and_legacy_calls_keep_original_limits':'prefill_owner_commits_known_usage_and_releases_only_its_call_reservation';
   const code=await new Promise((resolve,reject)=>{
    const child=spawn(homedir()+'/.cargo/bin/cargo',['test','--offline','--locked','-p','data-agent','--test','maintenance_billing',test,'--','--exact','--nocapture'],{env:h.env,stdio:['ignore','pipe','pipe']});
    for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output+=chunk;process.stdout.write(chunk);});
    child.once('error',reject);child.once('close',resolve);
   });
   if(providerFailure)throw providerFailure;
   assert.equal(code,0,'实际维护owner及已提交账本检查必须通过');
   assert.match(output,/test result: ok\. 1 passed; 0 failed;/,'过滤检查必须实际运行一项，零项不能冒充通过');
   for(const call of calls)assert.equal(call.reserved.reserved,319488,'官方总窗口1048576与本次输出4096按峰值预留319488微美元');
   passed=true;
  }finally{
   if(h){await writeFile(h.directory+'/maintenance-billing.log',output);await h.close();}
   provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));
   const report={sample,passed,calls,officialRequests:0,directory:h?.directory,providerFailure:providerFailure?.message};reports.push(report);
   await mkdir('.local/checks',{recursive:true});
   await writeFile('.local/checks/maintenance-billing-'+sample+'-'+Date.now()+'.json',JSON.stringify(report,null,2)+'\n');
  }
 }
 console.log(JSON.stringify({passed:true,checks:reports.map(report=>report.sample),officialRequests:0}));
 return reports;
}
if(process.argv[1]===fileURLToPath(import.meta.url))await checkMaintenanceBilling({representative:process.argv.includes('--representative')});

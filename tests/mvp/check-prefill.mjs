import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdir,copyFile,readFile,writeFile} from 'node:fs/promises';
import {harness,until} from './harness.mjs';
const checks=[];let passed=false,calls=0,mode='valid',release,arrived,expectedThinking='off',expectedOutput=2048;
const resultSchema=JSON.parse(await readFile('packages/contracts/schema.json','utf8')).$defs.PrefillResult;
const provider=createServer(async(req,res)=>{
 let raw='';req.setEncoding('utf8');for await(const chunk of req)raw+=chunk;
 calls++;assert.ok(Buffer.byteLength(raw)<=65536);
 const request=JSON.parse(raw);assert.equal(request.model,'deepseek-flash');assert.deepEqual(request.thinking,{type:expectedThinking==='off'?'disabled':'enabled'});assert.equal(request.max_tokens,expectedOutput);
 if(expectedThinking==='off')assert.ok(!('reasoning_effort' in request));else assert.equal(request.reasoning_effort,expectedThinking);
 assert.equal(request.tools.length,1);assert.equal(request.tools[0].function.name,'submit_semantic_prefill');assert.deepEqual(request.tools[0].function.parameters,resultSchema);
 assert.deepEqual(request.tool_choice,expectedThinking==='off'?{type:'function',function:{name:'submit_semantic_prefill'}}:'auto');
 const input=JSON.parse(request.messages[1].content);const guide=input.sources.find(s=>s.source_id==='etl');
 assert.ok(input.sources.every(s=>s.complete));assert.ok(!raw.includes('required_facts'));
 assert.ok(input.object.entries.every(e=>!['ddl','etl','type'].includes(e.path)));
 assert.deepEqual(input.object.related_ids,['table-demo_order_detail']);
 assert.ok(input.object.metadata.some(e=>e.path==='type'&&e.source_facts.quote.includes('paid_amount_cents TEXT NOT NULL')));
 assert.ok(input.object.metadata.every(e=>!('effective_value' in e)&&!('suggestion' in e)&&!('human_override' in e)));
 if(mode==='review_blocked' && input.draft || mode==='blocked'){arrived?.();await new Promise(r=>release=r);}
 const output={entries:[{entry_id:'meaning',value:'新版合成语义建议',gaps:['税费拆分没有资料'],evidence:[{source_id:guide.source_id,version:guide.version,location:'字段说明',quote:mode==='invalid' || mode==='review_invalid' && input.draft?'来源中绝不存在的原文':guide.body.slice(0,50)}]}]};
 if(mode==='empty')output.entries=[];
 if(mode==='facts_only')output.entries[0].entry_id='type';
 if(mode==='blank'){output.entries[0].value='';output.entries[0].gaps=[];}
 res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{type:'function',function:{name:'submit_semantic_prefill',arguments:(mode==='review_malformed'&&input.draft?'{{invalid':JSON.stringify(output))}}]}}],...(mode==='usage_missing' || mode==='review_usage_missing' && input.draft?{}:{usage:{prompt_tokens:100,completion_tokens:80}})}));
});await new Promise(r=>provider.listen(0,'127.0.0.1',r));
const directory='.local/checks/prefill-sources-'+randomUUID();await mkdir(directory,{recursive:true});for(const name of ['schema.sql','etl.sql','business-guide.md','semantic-catalog.json'])await copyFile('docs/sources/'+name,directory+'/'+name);
const profile={provider_id:'deepseek',model_id:'deepseek-flash',trial_id:randomUUID(),price_version:'2026-10-04-peak-usd',input_limit:32768,output_limit:2048,trial_call_limit:22,trial_cost_micros:'300000',request_call_limit:9,toolset:'data',payload_bytes_limit:65536};
let h;
try{
 h=await harness({env:{DATA_AGENT_SYNTHETIC_SOURCE_DIRECTORY:process.cwd()+'/'+directory}});await h.pauseWorker();
 let schema=await readFile(directory+'/schema.sql','utf8');schema=schema.replace('paid_amount_cents INTEGER NOT NULL','paid_amount_cents TEXT NOT NULL');await writeFile(directory+'/schema.sql',schema);
 assert.equal((await h.request('/source-syncs',{operation_id:randomUUID()})).status,200);
 const table=(await h.request('/knowledge/table-demo_order_detail')).value;const field=(await h.request('/knowledge/field-paid_amount_cents')).value;
 assert.ok(table.entries.find(e=>e.path==='ddl').effective_value.includes('paid_amount_cents TEXT NOT NULL'));
 assert.equal(field.entries.find(e=>e.path==='type').effective_value,'TEXT');assert.ok(field.entries.find(e=>e.path==='type').source_facts.quote.includes('paid_amount_cents TEXT NOT NULL'));
 await h.resumeWorker();await until(async()=>(await h.request('/knowledge/field-paid_amount_cents')).value.prefill_status?.state==='budget_unavailable','unconfigured maintenance');assert.equal(calls,0);
 checks.push({name:'只改DDL而不改catalog，当前DDL/字段类型自动刷新；无维护预算时明确待补充且0HTTP',passed:true});await h.close();h=null;
 for(const invalidEnv of [
  {DATA_AGENT_PREFILL_PROFILE:'{invalid'},
  {DATA_AGENT_PREFILL_PROFILE:JSON.stringify(profile),DATA_AGENT_PREFILL_URL:'https://example.invalid/chat/completions'},
  {DATA_AGENT_PREFILL_PROFILE:JSON.stringify({...profile,payload_bytes_limit:1024}),DATA_AGENT_PREFILL_TEST:'1',DATA_AGENT_PREFILL_URL:'http://127.0.0.1:'+provider.address().port},
 ]){
  h=await harness({env:{DATA_AGENT_SYNTHETIC_SOURCE_DIRECTORY:process.cwd()+'/'+directory,...invalidEnv}});
  const old=(await h.request('/knowledge/field-paid_amount_cents')).value;
  assert.equal((await h.request('/knowledge/field-paid_amount_cents/reanalyze',{operation_id:randomUUID(),expected_version:old.version})).status,200);
  await until(async()=>(await h.request('/knowledge/field-paid_amount_cents')).value.prefill_status?.state==='invalid_prefill','prefill preflight rejected');
  assert.equal(h.sql("SELECT JSON_OBJECT('count',COUNT(*)) FROM maintenance_model_calls")[0].count,0);
  assert.equal(calls,0);
  await h.close();h=null;
 }
 checks.push({name:'错误profile、URL、过大payload在发送前明确失败，不占预算且0HTTP',passed:true});
 h=await harness({env:{DATA_AGENT_SYNTHETIC_SOURCE_DIRECTORY:process.cwd()+'/'+directory,DATA_AGENT_PREFILL_PROFILE:JSON.stringify(profile),DATA_AGENT_PREFILL_TEST:'1',DATA_AGENT_PREFILL_URL:'http://127.0.0.1:'+provider.address().port}});
 const object='field-paid_amount_cents';
 const reanalyze=async()=>{const old=(await h.request('/knowledge/'+object)).value;const command={operation_id:randomUUID(),expected_version:old.version};const r=await h.request('/knowledge/'+object+'/reanalyze',command);assert.equal(r.status,200);const replay=await h.request('/knowledge/'+object+'/reanalyze',command);assert.equal(replay.status,200);assert.equal(replay.value.version,r.value.version);return r.value;};
 const wait=async(state)=>until(async()=>{const v=(await h.request('/knowledge/'+object)).value;return v.prefill_status?.state===state?v:false;},'prefill '+state);
 await reanalyze();let v=await wait('succeeded');assert.equal(v.entries.find(e=>e.path==='meaning').effective_value,'新版合成语义建议');assert.equal(v.entries.find(e=>e.path==='meaning').suggestion.analysis_state,'validated');
 checks.push({name:'固定分析与复核收到同版原始来源，分别结算后更新语义建议并保留缺口',passed:true});
 mode='invalid';const prior=await reanalyze();v=await wait('invalid_prefill');assert.equal(v.version,prior.version);assert.notEqual(v.entries.find(e=>e.path==='meaning').effective_value,'新版合成语义建议');
 checks.push({name:'不存在的原文引用拒绝，正式建议未被应用',passed:true});
 for(mode of ['empty','facts_only','blank']){
  const before=await reanalyze();v=await wait('invalid_prefill');assert.equal(v.version,before.version);
  checks.push({name:'不完整预填明确失败且不应用建议：'+mode,passed:true});
 }
 mode='blocked';const started=new Promise(r=>arrived=r);await reanalyze();await started;v=(await h.request('/knowledge/'+object)).value;
 const edit=await h.request('/knowledge/'+object,{operation_id:randomUUID(),expected_version:v.version,entry_id:'meaning',value:'分析期间人工纠正',clear_override:false},'alice','PATCH');assert.equal(edit.status,200);release();v=await wait('superseded');assert.equal(v.entries.find(e=>e.path==='meaning').effective_value,'分析期间人工纠正');
 checks.push({name:'模型进行期间人工编辑，新人工版本保留，迟到分析不覆盖',passed:true});
 mode='valid';await reanalyze();v=await wait('succeeded');assert.equal(v.entries.find(e=>e.path==='meaning').effective_value,'分析期间人工纠正');assert.equal(v.entries.find(e=>e.path==='meaning').suggestion.value,'新版合成语义建议');
 checks.push({name:'重新分析保留人工有效值，独立保存新模型建议和引用供复核',passed:true});
 await h.pauseWorker();const etl=await readFile(directory+'/etl.sql','utf8');await writeFile(directory+'/etl.sql',etl+'\n-- 单独变化的合成加工依据\n');const oldVersion=v.version;assert.equal((await h.request('/source-syncs',{operation_id:randomUUID()})).status,200);v=(await h.request('/knowledge/'+object)).value;assert.ok(BigInt(v.version)>BigInt(oldVersion));assert.equal(v.prefill_status.state,'queued');assert.ok(!v.entries.find(e=>e.path==='meaning').suggestion.evidence?.some(e=>e.source_id==='etl'&&e.version==='1'));
 checks.push({name:'模型新增ETL依据进入依赖；只改ETL后字段自动重分析，旧依据不继续有效',passed:true});
 // 隔离接下来的故障注入，其他已覆盖对象的queued job不启动模型。
 h.sql("DELETE FROM prefill_attempts WHERE state='queued'");await h.resumeWorker();
 mode='usage_missing';const before=await reanalyze();v=await wait('unknown');assert.equal(v.version,before.version);const ledger=h.sql(`SELECT JSON_OBJECT('calls',allocated_calls,'reserved',reserved_micros) FROM model_trials WHERE id='${profile.trial_id}'`)[0];assert.equal(ledger.calls,10);assert.ok(ledger.reserved>0);await new Promise(r=>setTimeout(r,400));assert.equal(calls,10);
 checks.push({name:'建议合法但usage缺失：不应用、回执未知、保留预算且不自动重试',passed:true});
 mode='blocked';const sent=new Promise(r=>arrived=r);await reanalyze();await sent;
 await h.pauseWorker();h.sql("UPDATE prefill_attempts SET issued_until=TIMESTAMPADD(SECOND,-1,UTC_TIMESTAMP(3)) WHERE state='issued'");release();await h.resumeWorker();await wait('unknown');await new Promise(r=>setTimeout(r,400));assert.equal(calls,11);
 checks.push({name:'每个重传命令最多两次维护调用；发送后进程退出，过期标记unknown且不自动重发',passed:true});

 for(const reviewMode of ['review_invalid','review_usage_missing','review_malformed']){
  mode=reviewMode;const before=await reanalyze();v=await wait(reviewMode==='review_usage_missing'?'unknown':'invalid_prefill');
  assert.equal(v.version,before.version);
  const attempt=v.prefill_status.attempt_id;
  const result=h.sql(`SELECT result_json FROM prefill_attempts WHERE id='${attempt}'`)[0];
  assert.ok(result.analysis.entries.length);if(reviewMode==='review_malformed')assert.equal(result.review.invalid_response.reason,'malformed_json');else assert.ok(result.review.entries.length);
  const receipt=h.sql(`SELECT JSON_OBJECT('state',state) FROM maintenance_model_calls WHERE id='${attempt}:review'`)[0];
  assert.equal(receipt.state,reviewMode==='review_usage_missing'?'issued':'settled');
  checks.push({name:'复核失败保留分析/复核产物，正式版本不应用第一轮：'+reviewMode,passed:true});
 }
 mode='review_blocked';const reviewing=new Promise(r=>arrived=r);await reanalyze();await reviewing;
 const reviewOld=(await h.request('/knowledge/'+object)).value;
 assert.equal((await h.request('/knowledge/'+object,{operation_id:randomUUID(),expected_version:reviewOld.version,entry_id:'meaning',value:'复核期间人工纠正',clear_override:false},'alice','PATCH')).status,200);
 release();await wait('superseded');assert.equal((await h.request('/knowledge/'+object)).value.entries.find(e=>e.path==='meaning').effective_value,'复核期间人工纠正');
 checks.push({name:'第二次网络复核期间人工编辑，迟到复核不覆盖新人工值',passed:true});

 mode='valid';await reanalyze();await wait('succeeded');
 const limited=await reanalyze();v=await wait('budget_unavailable');assert.equal(v.version,limited.version);
 assert.equal(calls,22);const finalLedger=h.sql(`SELECT JSON_OBJECT('calls',allocated_calls) FROM model_trials WHERE id='${profile.trial_id}'`)[0];assert.equal(finalLedger.calls,22);
 assert.ok(h.sql(`SELECT result_json FROM prefill_attempts WHERE id='${v.prefill_status.attempt_id}'`)[0].analysis.entries.length);
 checks.push({name:'仅余一次许可时第一轮结算，复核预算拒绝且零额外HTTP；保留草稿但不应用',passed:true});
 await h.close();h=null;
 for(const [level,output] of [['low',8192],['high',8192],['low',16384],['high',32768]]){
  expectedThinking=level;expectedOutput=output;
  const nativeProfile={...profile,trial_id:randomUUID(),thinking_level:level,output_limit:output,trial_call_limit:2};
  h=await harness({env:{DATA_AGENT_SYNTHETIC_SOURCE_DIRECTORY:process.cwd()+'/'+directory,DATA_AGENT_PREFILL_PROFILE:JSON.stringify(nativeProfile),DATA_AGENT_PREFILL_TEST:'1',DATA_AGENT_PREFILL_URL:'http://127.0.0.1:'+provider.address().port}});
  const beforeCalls=calls;
  const old=(await h.request('/knowledge/'+object)).value;
  assert.equal((await h.request('/knowledge/'+object+'/reanalyze',{operation_id:randomUUID(),expected_version:old.version})).status,200);
  await wait('succeeded');
  assert.equal(calls-beforeCalls,2);
  const nativeLedger=h.sql(`SELECT JSON_OBJECT('calls',allocated_calls,'reserved',reserved_micros) FROM model_trials WHERE id='${nativeProfile.trial_id}'`)[0];
  assert.equal(nativeLedger.calls,2);assert.equal(nativeLedger.reserved,0);
  assert.equal(h.sql("SELECT JSON_OBJECT('n',COUNT(*)) FROM maintenance_model_calls WHERE state='settled'")[0].n,2);
  checks.push({name:`预填分析及复核实际请求沿用${level}思考深度与${output}输出上限，两次usage全部结算`,passed:true});
  await h.close();h=null;
 }
 passed=true;console.log(JSON.stringify({passed,checks,officialRequests:0,calls}));
}finally{release?.();if(h)await h.close();await new Promise(r=>provider.close(r));await writeFile('.local/checks/mvp-prefill.json',JSON.stringify({passed,checks,officialRequests:0,calls},null,2));}

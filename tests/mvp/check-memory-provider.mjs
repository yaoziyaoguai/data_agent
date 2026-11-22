import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID,createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness,until} from './harness.mjs';

// 这里只替换Mem0服务，验证真实Rust/MySQL/Worker和持久预算；质量另用官方模型试用。
let h, failCommit=false, failExtract=false, prepareCount=0, calls=0, loseExtractReply=true, preferredCandidate;
let extractedBody='用户以后默认用元展示金额。';
const prepared=new Map(), indexes=new Map(), requests=[];
const server=createServer(async(req,res)=>{
 let input;
 try {
  let raw='';for await(const b of req)raw+=b;input=JSON.parse(raw);requests.push({path:req.url,input});
  const pay=async(purpose)=>{
   const data={action:'issue',budget:input.budget,call_attempt_id:randomUUID(),purpose,parameters_fingerprint:createHash('sha256').update(JSON.stringify(input)).digest('hex'),input_tokens_upper:purpose==='memory_embedding'?100:40000,output_tokens_max:purpose==='memory_embedding'?0:4096,usage:null};
   const issued=await h.internal('/internal/memory/model-calls',data);assert.equal(issued.status,200,JSON.stringify(issued.value));assert.equal(issued.value.send_allowed,true);
   assert.equal((await h.internal('/internal/memory/model-calls',data)).value.send_allowed,false);
   const finish={...data,action:'finalize',usage:{input_tokens:50,output_tokens:purpose==='memory_embedding'?0:12,elapsed_ms:20}};
   assert.equal((await h.internal('/internal/memory/model-calls',finish)).status,200);assert.equal((await h.internal('/internal/memory/model-calls',finish)).status,200);calls++;
  };
  let result;
  if(req.url==='/extract'){
   if(failExtract){res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:'memory_operation_unknown'}));return;}
   if(!prepared.has(input.operation_id)){await pay('memory_extraction');await pay('memory_embedding');prepared.set(input.operation_id,{body:extractedBody,owner:input.owner_id});prepareCount++;}
   if(loseExtractReply){loseExtractReply=false;res.destroy();return;}
   result={operation_id:input.operation_id,body:prepared.get(input.operation_id).body,replayed:false};
  }else if(req.url==='/index'){
   if(failCommit){failCommit=false;res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:'memory_unavailable'}));return;}
   const key=input.owner_id+'::'+input.space_id+'::'+input.asset.id, old=indexes.get(key);
   if(!old||Number(old.version)<=Number(input.asset.version)){
    if(!input.extraction_operation_id&&input.asset.state==='enabled'&&(!old||old.version!==input.asset.version))await pay('memory_embedding');
    indexes.set(key,{...input.asset,owner:input.owner_id,space:input.space_id});
   }
   result={operation_id:input.operation_id,state:input.asset.state==='enabled'?'ready':'removed'};
  }else if(req.url==='/search'){
   await pay('memory_embedding');
   result={candidates:[...indexes.values()].sort((a,b)=>Number(b.id===preferredCandidate)-Number(a.id===preferredCandidate)).filter(v=>v.owner===input.owner_id&&v.space===input.space_id&&v.state==='enabled').map(v=>({asset_id:v.id,version:v.version})),bounded:false};
  }else throw new Error('unexpected_path');
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
 }catch(e){res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:'memory_unavailable'}));console.error('sidecar_test_failure',e.message);}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const profile={provider_id:'deepseek',model_id:'deepseek-flash',trial_id:'memory_'+randomUUID(),price_version:'2026-10-04-peak-usd',input_limit:65536,output_limit:4096,trial_call_limit:200,trial_cost_micros:'5000000',request_call_limit:24,toolset:'data',payload_bytes_limit:131072,thinking_level:'high'};
const manager=SessionManager.inMemory('/synthetic/data-agent');const checks=[];let passed=false,run;
const invoke=async(name,args,sdk=randomUUID())=>{
 const input={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:sdk,tool_name:name,arguments:args,checkpoint:exportCheckpoint(manager)};
 assert.equal((await h.internal('/internal/data/tool-calls',input)).status,200);
 return {input,result:await h.internal('/internal/data/tools',input)};
};
const details={name:'金额展示偏好',body:'这是Pi生成的正文，不应成为正式记忆',scope:'未指定单位的收入分析',verified:false,dependencies:[]};
const stopCapturedInput=async()=>{
 // 捕获器没有真正的Pi完成回调；显式撤回测试输入，避免旧待处理消息重领后占住Worker。
 const result=await h.request(`/conversations/${run.conversation_id}/messages/${run.message_id}/withdraw`,{operation_id:randomUUID()});
 assert.equal(result.status,200,JSON.stringify(result.value));
 h.releaseRun(run.run_id);
};
try{
 h=await harness({capture:true,profile,env:{DATA_AGENT_MEMORY_URL:'http://127.0.0.1:'+server.address().port}});
 const cid=await h.create();run=await h.capture(cid,'请记住：以后金额用元展示。现在不查数据。');
 const contextBinding={kind:'run',id:run.run_id,epoch:run.lease_epoch,sdk_tool_call_id:null,operation_id:'context-'+run.message_id};
 const contextCall={action:'issue',budget:contextBinding,call_attempt_id:randomUUID(),purpose:'memory_embedding',parameters_fingerprint:'a'.repeat(64),input_tokens_upper:100,output_tokens_max:0,usage:null};
 for(const input of [
  {...contextCall,call_attempt_id:randomUUID(),budget:{...contextBinding,operation_id:'context-other-message'}},
  {...contextCall,call_attempt_id:randomUUID(),purpose:'memory_extraction',output_tokens_max:4096},
  {...contextCall,call_attempt_id:randomUUID(),budget:{...contextBinding,sdk_tool_call_id:'unregistered-tool'}},
 ]){
  const refused=await h.internal('/internal/memory/model-calls',input);
  assert.equal(refused.status,404,JSON.stringify(refused.value));
  assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM model_call_attempts WHERE id='${input.call_attempt_id}'`)[0].n,0);
 }
 const invalidIndex=await h.internal('/internal/memory/model-calls',{...contextCall,budget:{kind:'index',id:randomUUID(),epoch:'1',sdk_tool_call_id:'invented-sdk-id',operation_id:randomUUID()}});
 assert.equal(invalidIndex.status,400);assert.equal(invalidIndex.value.code,'invalid_input');
 checks.push('无SDK的启动检索只接受当前消息的context身份及embedding用途；未注册工具和伪造索引SDK身份拒绝且不发许可');
 const invalid=await invoke('manage_personal_asset',{action:'save_memory',...details,instruction_quote:'以后金额用元展示。'});
 assert.equal(invalid.result.value.code,'scope_incomplete');assert.equal(prepareCount,0);
 const rejected=await h.internal('/internal/data/tool-rejections',invalid.input);assert.match(rejected.value.data.hint,/instruction_quote/);
 failCommit=true;
 const saved=await invoke('manage_personal_asset',{action:'save_memory',...details,instruction_quote:'请记住：以后金额用元展示。'});
 assert.equal(saved.result.status,200,JSON.stringify(saved.result.value));assert.equal(saved.result.value.data.body,'用户以后默认用元展示金额。');
 const asset=saved.result.value.data;
 assert.equal(requests.find(v=>v.path==='/extract').input.message,run.text);
 assert.equal(requests.find(v=>v.path==='/extract').input.previous_memory,undefined);
 assert.equal((await h.internal('/internal/data/tools',saved.input)).value.data.id,asset.id);assert.equal(prepareCount,1);
 await until(async()=>(await h.request('/assets')).value.assets.find(v=>v.id===asset.id)?.memory_index_state==='indexed','index retry reaches ready');
 const indexRequest=requests.find(v=>v.path==='/index'&&v.input.asset.id===asset.id).input;
 assert.equal(indexRequest.budget.kind,'index');assert.equal(indexRequest.budget.sdk_tool_call_id,null);
 assert.equal(indexRequest.budget.id,indexRequest.operation_id);assert.equal(indexRequest.budget.operation_id,indexRequest.operation_id);
 const indexJob=h.sql(`SELECT JSON_OBJECT('id',id,'scope',budget_scope_id,'extraction',extraction_operation_id) FROM personal_memory_index_jobs WHERE id='${indexRequest.operation_id}'`)[0];
 assert.equal(indexJob.scope,run.budget_scope_id);assert.equal(indexJob.extraction,requests.find(v=>v.path==='/extract').input.operation_id);
 assert.equal(calls,2);assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM personal_asset_versions WHERE asset_id='${asset.id}'`)[0].n,1);
 checks.push('原文预检查先于提取，Mem0正文正式保存，首提取响应丢失接回原结果，重复工具不重复提取/资产；索引暂时失败可重试');
 const found=await invoke('search_knowledge',{query:'金额习惯',limit:10});
 assert.equal(found.result.status,200,JSON.stringify(found.result.value));assert.equal(found.result.value.data.memory_retrieval,'mem0_authoritative');assert.ok(found.result.value.data.personal_memories.some(v=>v.id===asset.id));
 const toolSearch=requests.find(v=>v.path==='/search'&&v.input.query==='金额习惯').input;
 assert.equal(toolSearch.budget.sdk_tool_call_id,found.input.sdk_tool_call_id);assert.equal(toolSearch.budget.id,run.run_id);
 assert.ok(h.sql(`SELECT JSON_OBJECT('scope',budget_scope_id,'state',state,'purpose',purpose) FROM model_call_attempts WHERE purpose LIKE 'memory_%'`).every(v=>v.state==='settled'&&v.scope===run.budget_scope_id));
 checks.push('Mem0检索命中回源；提取与embedding每次许可/结算归原请求，重复许可禁止发送');
 const manual={operation_id:randomUUID(),id:asset.id,expected_version:asset.version,kind:'memory',...details,body:'以后收入按万元展示',source_text:'用户在页面修改'};
 const edited=await h.request('/assets',manual);assert.equal(edited.status,200);
 await until(async()=>(await h.request('/assets')).value.assets.find(v=>v.id===asset.id)?.memory_index_state==='indexed','manual edit index');
 assert.equal(indexes.get('alice::demo::'+asset.id).body,manual.body);
 const version=edited.value.version;
 assert.equal((await h.request('/assets/'+asset.id+'/disable',{operation_id:randomUUID(),expected_version:version},'bob')).status,404);
 const disabled=await h.request('/assets/'+asset.id+'/disable',{operation_id:randomUUID(),expected_version:version});assert.equal(disabled.status,200);
 await until(()=>indexes.get('alice::demo::'+asset.id).state==='disabled','disable index');
 const enabled=await h.request('/assets/'+asset.id+'/enable',{operation_id:randomUUID(),expected_version:disabled.value.version});assert.equal(enabled.status,200);
 await until(()=>indexes.get('alice::demo::'+asset.id).state==='enabled','enable index');
 const deleted=await h.request('/assets/'+asset.id+'/delete',{operation_id:randomUUID(),expected_version:enabled.value.version});assert.equal(deleted.status,200);
 await until(()=>indexes.get('alice::demo::'+asset.id).state==='deleted','delete index');
 assert.equal((await h.request('/assets')).value.assets.length,0);
 const maintenance=h.sql(`SELECT JSON_OBJECT('scope',budget_scope_id,'trial',trial_id,'purpose',purpose) FROM model_call_attempts WHERE purpose='memory_embedding' AND budget_scope_id IS NULL`);
 assert.equal(maintenance.length,2);assert.ok(maintenance.every(v=>v.trial===profile.trial_id));
 checks.push('页面编辑/停用/启用/删除同步，跨用户拒绝；人工正文不重新推理，索引调用使用明确维护额度');
 // 模拟既有库切到空索引；只更换测试旧任务的目标，不改正式资产或预算。
 const stored=await h.request('/assets',{operation_id:randomUUID(),id:null,expected_version:null,kind:'memory',...details,body:'按元显示收入',source_text:'合成存量资产'});assert.equal(stored.status,200);
 await until(async()=>(await h.request('/assets')).value.assets.find(v=>v.id===stored.value.id)?.memory_index_state==='indexed','initial manual index');
 await h.pauseWorker();
 h.sql(`UPDATE personal_memory_index_jobs SET index_target='retired_test_collection' WHERE asset_id='${stored.value.id}'`);
 indexes.clear();await h.resumeWorker();
 await until(async()=>(await h.request('/assets')).value.assets.find(v=>v.id===stored.value.id)?.memory_index_state==='indexed','missing current target backfill');
 assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM personal_memory_index_jobs WHERE asset_id='${stored.value.id}'`)[0].n,2);
 assert.equal(indexes.get('alice::demo::'+stored.value.id).body,'按元显示收入');
 await h.request('/assets/'+stored.value.id+'/delete',{operation_id:randomUUID(),expected_version:stored.value.version});
 await until(async()=>(await h.request('/assets')).value.assets.length===0,'remove backfill fixture');
 checks.push('存量记忆在新目标自动回填，正式版本不变；旧目标作业保留、不重置旧预算');
 // 超过启动上下文的20条上限，候选排序必须先于截断。
 await stopCapturedInput();await h.pauseWorker();const many=[];
 for(let n=0;n<25;n++){const v=await h.request('/assets',{operation_id:randomUUID(),id:null,expected_version:null,kind:'memory',...details,name:'合成检查'+n,body:'合成月度检查提醒'+n,source_text:'独立目录验证'});assert.equal(v.status,200);many.push(v.value);}
 preferredCandidate=many.map(v=>v.id).sort().at(-1);await h.resumeWorker();
 await until(async()=>(await h.request('/assets')).value.assets.every(v=>v.memory_index_state==='indexed'),'25条索引完成',40000);
 run=await h.capture(await h.create(),'位于目录第25条的月度检查');
 assert.ok(run.workspace_context.memories.length>0&&run.workspace_context.memories.length<=20);assert.equal(run.workspace_context.memories[0].id,preferredCandidate);
 assert.equal(run.workspace_context.memory_retrieval,'mem0_authoritative');
 const contextSearch=requests.find(v=>v.path==='/search'&&v.input.operation_id==='context-'+run.message_id).input;
 assert.equal(contextSearch.budget.sdk_tool_call_id,null);assert.equal(contextSearch.budget.kind,'run');assert.equal(contextSearch.budget.id,run.run_id);
 const contextCalls=h.sql(`SELECT JSON_OBJECT('scope',budget_scope_id,'purpose',purpose,'state',state) FROM model_call_attempts WHERE operation_id='${contextSearch.operation_id}'`);
 assert.equal(contextCalls.length,1);assert.deepEqual(contextCalls[0],{scope:run.budget_scope_id,purpose:'memory_embedding',state:'settled'});
 await h.restartApi();assert.equal((await h.request('/assets')).value.assets.length,25);
 for(const asset of many)await h.request('/assets/'+asset.id+'/delete',{operation_id:randomUUID(),expected_version:asset.version});
 checks.push('25条记忆先检索再截断，目录末项可成为启动首项；实际RunEnvelope契约和API重启通过');
 await h.pauseWorker();
 const protectedAsset=await h.request('/assets',{operation_id:randomUUID(),id:null,expected_version:null,kind:'memory',...details,body:'等待索引的合成正文',source_text:'竞争验证'});
 const assetId=protectedAsset.value.id;
 const job=h.sql(`SELECT JSON_OBJECT('id',id) FROM personal_memory_index_jobs WHERE asset_id='${assetId}'`)[0];
 h.sql(`UPDATE personal_memory_index_jobs SET state='issued',lease_epoch=1,lease_until=TIMESTAMPADD(SECOND,180,UTC_TIMESTAMP(3)) WHERE id='${job.id}'`);
 await h.request('/assets/'+assetId+'/disable',{operation_id:randomUUID(),expected_version:'1'});
 const denied=await h.internal('/internal/memory/model-calls',{action:'issue',budget:{kind:'index',id:job.id,epoch:'1',sdk_tool_call_id:null,operation_id:job.id},call_attempt_id:randomUUID(),purpose:'memory_embedding',parameters_fingerprint:'a'.repeat(64),input_tokens_upper:100,output_tokens_max:0,usage:null});
 assert.equal(denied.status,404);assert.equal(denied.value.code,'not_available');
 assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM model_call_attempts WHERE operation_id='${job.id}'`)[0].n,0);
 await h.request('/assets/'+assetId+'/delete',{operation_id:randomUUID(),expected_version:'2'});await h.resumeWorker();
 checks.push('领取后停用阻止新的embedding许可，没有外发或预留；旧作业不得复活资产');
 // 正式表中造一条属于测试的故障；候选虽已提取，事务失败不排索引。
 await stopCapturedInput();
 const otherCid=await h.create();run=await h.capture(otherCid,'请记住：以后金额用元展示。');
 h.sql("CREATE TRIGGER memory_save_failure BEFORE INSERT ON personal_assets FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic_failure'");
 const before=indexes.size;
 const failed=await invoke('manage_personal_asset',{action:'save_memory',...details,instruction_quote:run.text});assert.equal(failed.result.value.code,'unavailable');
 assert.equal((await h.request('/assets')).value.assets.length,0);assert.equal(indexes.size,before);
 h.sql('DROP TRIGGER memory_save_failure');failExtract=true;
 const unknown=await invoke('manage_personal_asset',{action:'save_memory',...details,instruction_quote:run.text});assert.equal(unknown.result.value.code,'memory_operation_unknown');
 assert.equal((await h.request('/assets')).value.assets.length,0);
 checks.push('正式保存失败不排索引、不伪装成功；提取未知明确返回并保持无正式资产');
 const unauth=await fetch(h.env.DATA_AGENT_API_URL+'/internal/memory/model-calls',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(unauth.status,401);
 checks.push('新增内部模型接口拒绝无内部凭据请求');
 // 重现正式试用中的范围扩写：提取正文正确，主Agent的名称、正文和scope故意带错指标。
 failExtract=false;await stopCapturedInput();
 run=await h.capture(await h.create(),'请记住：检查月支付客户数时按整月客户去重，不能累加每日去重人数；具体口径仍查正式文档。');
 extractedBody='检查月支付客户数时，按整月客户去重，不能累加每日去重人数；具体口径仍查正式文档。';
 const expanded={...details,name:'月活（MAU）检查',body:'检查所有月活用户',scope:'月支付客户数（MAU口径的支付客户去重月活人数）检查与取数'};
 const correction=await invoke('manage_personal_asset',{action:'save_memory',...expanded,instruction_quote:run.text});
 assert.equal(correction.result.status,200,JSON.stringify(correction.result.value));
 const corrected=correction.result.value.data;
 const checkContent=value=>{
  assert.equal(value.body,extractedBody);assert.equal(value.scope,extractedBody);
  assert.equal(value.name,[...extractedBody].slice(0,40).join(''));
  assert.doesNotMatch(value.name+value.body+value.scope,/月活|MAU/);
 };
 checkContent(corrected);
 assert.deepEqual((await h.internal('/internal/data/tools',correction.input)).value,correction.result.value);
 await until(async()=>(await h.request('/assets')).value.assets.find(v=>v.id===corrected.id)?.memory_index_state==='indexed','correction indexed');
 await h.restartApi();checkContent((await h.request('/assets')).value.assets.find(v=>v.id===corrected.id));
 await stopCapturedInput();
 run=await h.capture(await h.create(),'修订我的月支付客户数检查提醒：整月去重，并核对客户标识为空的处理；只作为个人检查提醒，具体口径仍以正式文档为准。');
 checkContent(run.workspace_context.memories.find(v=>v.id===corrected.id));
 extractedBody='检查月支付客户数时按整月客户去重，并核对客户标识为空的处理；仅为个人检查提醒，具体口径以正式文档为准。';
 const beforeRevision=requests.filter(v=>v.path==='/extract').length;
 const stale=await invoke('manage_personal_asset',{action:'update_memory',asset_id:corrected.id,expected_version:'0',...expanded,instruction_quote:run.text});
 assert.equal(stale.result.value.code,'version_conflict');assert.equal(requests.filter(v=>v.path==='/extract').length,beforeRevision);
 const revised=await invoke('manage_personal_asset',{action:'update_memory',asset_id:corrected.id,expected_version:corrected.version,...expanded,instruction_quote:run.text});
 assert.equal(revised.result.status,200,JSON.stringify(revised.result.value));checkContent(revised.result.value.data);
 const revisionRequest=requests.filter(v=>v.path==='/extract').at(-1).input;
 assert.equal(revisionRequest.message,run.text);assert.equal(revisionRequest.quote,run.text);
 assert.deepEqual(revisionRequest.previous_memory,{id:corrected.id,version:corrected.version,body:corrected.body,scope:corrected.scope});
 assert.equal(revised.result.value.data.version,'2');
 assert.deepEqual((await h.internal('/internal/data/tools',revised.input)).value,revised.result.value);
 await until(async()=>(await h.request('/assets')).value.assets.find(v=>v.id===corrected.id)?.memory_index_state==='indexed','revision indexed');
 await stopCapturedInput();run=await h.capture(await h.create(),'按我的提醒核查月支付客户数');
 checkContent(run.workspace_context.memories.find(v=>v.id===corrected.id));
 const human={operation_id:randomUUID(),id:corrected.id,expected_version:'2',kind:'memory',...details,name:'人工维护的支付客户检查',body:extractedBody,scope:'仅检查月支付客户数，具体口径查正式文档',source_text:'用户明确维护'};
 const humanSaved=await h.request('/assets',human);assert.equal(humanSaved.status,200);
 assert.equal(humanSaved.value.scope,human.scope);assert.equal(humanSaved.value.name,human.name);
 checks.push('自动记忆新建/修订忽略主Agent扩写的名称和范围，完整保留提取限定；重放、重启和跨会话回源一致，人工名称与范围保留');
 await stopCapturedInput();
 const source=await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'合成个人提醒依据',body:'仅依此文档检查单位。',related_ids:[]});assert.equal(source.status,200,JSON.stringify(source.value));
 h.env.DATA_AGENT_MEMORY_URL='';await h.restartApi();
 run=await h.capture(await h.create(),'请记住：以后金额使用元。');
 const sourceRef={object_id:source.value.id,version:source.value.version,path:'body'};
 const sourceRead=await invoke('read_knowledge',{items:[{kind:'knowledge',ref:sourceRef}]});
 assert.equal(sourceRead.result.status,200);assert.equal(sourceRead.result.value.data.items[0].state,'ok');
 const generated=await invoke('manage_personal_asset',{action:'save_memory',...details,body:'仅按合成文档检查金额单位。',instruction_quote:run.text,dependencies:[sourceRef]});assert.equal(generated.result.status,200,JSON.stringify(generated.result.value));
 await stopCapturedInput();h.env.DATA_AGENT_MEMORY_URL='http://127.0.0.1:'+server.address().port;await h.restartApi();
 // 先建立独立字段来源夹具，避免它把下一条待修订记忆的旧版本也作为依据。
 const dependent=await h.request('/assets',{operation_id:randomUUID(),id:null,expected_version:null,kind:'memory',...details,body:'仅按合成文档检查金额单位。',source_text:'用户维护的合成提醒',dependencies:[{object_id:source.value.id,version:source.value.version,path:'body'}]});assert.equal(dependent.status,200,JSON.stringify(dependent.value));
 run=await h.capture(await h.create(),'修改我的合成检查提醒：改用秒展示。');
 const retained=await invoke('manage_personal_asset',{action:'update_memory',asset_id:dependent.value.id,expected_version:dependent.value.version,...details,instruction_quote:run.text});assert.equal(retained.result.status,200,JSON.stringify(retained.result.value));
 assert.deepEqual(retained.result.value.data.dependencies,dependent.value.dependencies,'提取用了旧正文，保存后保留旧显式依赖');
 const generatedRevision=await invoke('manage_personal_asset',{action:'update_memory',asset_id:generated.result.value.data.id,expected_version:'1',...details,instruction_quote:run.text});assert.equal(generatedRevision.result.status,200,JSON.stringify(generatedRevision.result.value));
 assert.deepEqual(generatedRevision.result.value.data.dependencies,[sourceRef]);
 await stopCapturedInput();
 assert.equal((await h.request('/knowledge/'+source.value.id+'/disable',{operation_id:randomUUID(),expected_version:source.value.version})).status,200);
 run=await h.capture(await h.create(),'修改我的合成检查提醒：改用秒展示。');
 const generatedAsset=generatedRevision.result.value.data;
 const blockedMemory={kind:'memory',asset_ref:{id:generatedAsset.id,version:generatedAsset.version},part:'body'};
 const blockedRead=await invoke('read_knowledge',{items:[blockedMemory]});
 assert.equal(blockedRead.result.status,200,JSON.stringify(blockedRead.result.value));
 assert.deepEqual(blockedRead.result.value.data.items,[{...blockedMemory,state:'not_available'}]);
 const beforeUnavailable=requests.filter(v=>v.path==='/extract').length;
 const unavailable=await invoke('manage_personal_asset',{action:'update_memory',asset_id:dependent.value.id,expected_version:retained.result.value.data.version,...details,instruction_quote:run.text});
 assert.equal(requests.filter(v=>v.path==='/extract').length,beforeUnavailable,'旧依赖撤下时禁止向侧车发送旧正文，即使新参数省略该依赖');
 assert.equal(unavailable.result.status,404,JSON.stringify(unavailable.result.value));
 assert.equal((await h.request('/assets')).value.assets.find(v=>v.id===dependent.value.id).version,retained.result.value.data.version);
 checks.push('修订提取校验旧依赖；新版继承显式依赖，后续撤下禁止Agent读取及再次提取，旧正文零外发、资产不再升版');
 const bindExtraction=async()=>{
  const input={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:randomUUID(),tool_name:'manage_personal_asset',arguments:{action:'save_memory',...details,instruction_quote:run.text},checkpoint:exportCheckpoint(manager)};
  const registered=await h.internal('/internal/data/tool-calls',input);assert.equal(registered.status,200,JSON.stringify(registered.value));
  return {kind:'run',id:run.run_id,epoch:run.lease_epoch,sdk_tool_call_id:input.sdk_tool_call_id,operation_id:registered.value.operation_id};
 };
 const unknownCall={action:'issue',budget:await bindExtraction(),call_attempt_id:randomUUID(),purpose:'memory_extraction',parameters_fingerprint:'e'.repeat(64),input_tokens_upper:1000,output_tokens_max:4096,usage:null};
 assert.equal((await h.internal('/internal/memory/model-calls',unknownCall)).value.send_allowed,true);
 assert.equal((await h.internal('/internal/memory/model-calls',{...unknownCall,action:'finalize'})).value.state,'unknown');
 const retainedBudget=h.sql(`SELECT JSON_OBJECT('issued',issued_calls) FROM budget_scopes WHERE id='${run.budget_scope_id}'`)[0];
 const retainedTrial=h.sql(`SELECT JSON_OBJECT('allocated',allocated_calls,'reserved',reserved_micros,'spent',spent_micros) FROM model_trials WHERE id='${profile.trial_id}'`)[0];
 const changedId={...unknownCall,budget:await bindExtraction(),call_attempt_id:randomUUID()};
 const unknownDenied=await h.internal('/internal/memory/model-calls',changedId);assert.equal(unknownDenied.status,409,JSON.stringify(unknownDenied.value));assert.equal(unknownDenied.value.code,'memory_operation_unknown');
 assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM model_call_attempts WHERE id='${changedId.call_attempt_id}'`)[0].n,0);
 assert.deepEqual(h.sql(`SELECT JSON_OBJECT('issued',issued_calls) FROM budget_scopes WHERE id='${run.budget_scope_id}'`)[0],retainedBudget);
 assert.deepEqual(h.sql(`SELECT JSON_OBJECT('allocated',allocated_calls,'reserved',reserved_micros,'spent',spent_micros) FROM model_trials WHERE id='${profile.trial_id}'`)[0],retainedTrial);
 assert.deepEqual((await h.internal('/internal/memory/model-calls',unknownCall)).value,{state:'unknown',send_allowed:false});
 const independent={...changedId,budget:await bindExtraction(),call_attempt_id:randomUUID(),parameters_fingerprint:'f'.repeat(64)};
 assert.equal((await h.internal('/internal/memory/model-calls',independent)).value.send_allowed,true);
 assert.equal((await h.internal('/internal/memory/model-calls',{...independent,action:'finalize',usage:{input_tokens:50,output_tokens:12,elapsed_ms:20}})).value.state,'settled');
 checks.push('同请求Mem0提取unknown后换call/operation但同载荷拒绝，零新记录/计数/预留；原ID只回unknown，不同载荷仍可许可及结算');
 passed=true;console.log(JSON.stringify({passed,checks,officialRequests:0,calls}));
}finally{
 await writeFile('.local/checks/memory-provider.json',JSON.stringify({passed,checks,officialRequests:0,calls},null,2));
 if(h)await h.close();await new Promise(r=>server.close(r));
}

import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {validateContract} from '../../packages/contracts/validate.ts';
import {harness} from './harness.mjs';
const h=await harness({capture:true,env:{DATA_AGENT_LEASE_MS:'120000'}});
let manager=SessionManager.inMemory('/synthetic/data-agent');
const checks=[];let passed=false,run;
const invoke=async(name,args)=>{const input={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:randomUUID(),tool_name:name,arguments:args,checkpoint:exportCheckpoint(manager)};const registered=await h.internal('/internal/data/tool-calls',input);assert.equal(registered.status,200,JSON.stringify(registered.value));const result=await h.internal('/internal/data/tools',input);assert.equal(result.status,200,JSON.stringify(result.value));return result.value.data;};
try{
 const cid=await h.create();const memories=[],skills=[];
 for(let i=0;i<28;i++){
  const r=await h.request('/assets',{operation_id:randomUUID(),id:null,expected_version:null,kind:i<24?'memory':'skill',name:'合成方法'+i,body:'长文语义说明'.repeat(1800)+'专用尾部术语'+i,scope:'适用于合成订单分析'.repeat(100),verified:false,source_text:'本人录入：以后默认按渠道展示。'+'合成范围说明🙂'.repeat(160)+'例外：退款分析按本次明确要求。',dependencies:[]});assert.equal(r.status,200);(i<24?memories:skills).push(r.value);
 }
 for(const s of skills.slice(0,3)) assert.equal((await h.request('/conversations/'+cid+'/skill-selections',{operation_id:randomUUID(),asset_id:s.id,version:s.version})).status,200);
 run=await h.capture(cid,'请调查已保存的合成方法');await h.pauseWorker();
 validateContract('RunEnvelope',run);
 const visible=structuredClone(run.workspace_context);delete visible.authority_snapshot;
 assert.ok(Buffer.byteLength(JSON.stringify(visible))<=16000);assert.deepEqual(visible.asset_counts,{memories:24,selected_skills:3});
 checks.push({name:'多份长memory/已选Skill使用真实RunEnvelope，启动可见上下文不超过16KB且声明总数',passed:true});
 const ids=[];let after;
 do{const page=await invoke('search_knowledge',{query:'*',limit:7,...(after?{asset_after:after}:{})});const entries=[...page.personal_memories,...page.selected_skills];ids.push(...entries.map(a=>a.id));assert.ok(Buffer.byteLength(JSON.stringify(entries))<=12000);after=page.next_asset_after;}while(after);
 assert.equal(ids.length,27);assert.equal(new Set(ids).size,27);assert.ok(!ids.includes(skills[3].id));
 const omitted=memories.find(m=>!run.workspace_context.memories.some(v=>v.id===m.id));assert.ok(omitted);
 const hit=await invoke('search_knowledge',{query:omitted.name,limit:30});assert.ok(hit.personal_memories.some(v=>v.id===omitted.id));
 const skillHit=await invoke('search_knowledge',{query:skills[2].name,limit:30});assert.ok(skillHit.selected_skills.some(v=>v.id===skills[2].id));
 checks.push({name:'完整资产目录分页无重复；启动候选外的memory和已选Skill可搜索，未选Skill不返回',passed:true});
 let body='',offset=0;
 do{const page=await invoke('read_knowledge',{object_id:'asset-'+omitted.id,version:omitted.version,offset,limit:2048});body+=page.body;offset=page.content_page.next_offset;}while(offset!==null);
 assert.equal(body,omitted.body);
 let source='',sourceOffset=0;
 do{const page=await invoke('read_knowledge',{object_id:'asset-'+omitted.id,version:omitted.version,entry_id:'source_text',offset:sourceOffset,limit:173});assert.equal(page.body,'');source+=page.source_text;sourceOffset=page.source_page.next_offset;}while(sourceOffset!==null);
 assert.equal(source,omitted.source_text);assert.match(source,/退款分析按本次明确要求/);
 const inaccessible=await h.request('/assets',{operation_id:randomUUID(),id:null,expected_version:null,kind:'memory',name:'另一个用户的范围',body:'合成正文',scope:'本人',verified:false,source_text:'不得跨用户读取',dependencies:[]},'bob');assert.equal(inaccessible.status,200);
 const deniedRead=async(id,version,page)=>{const input={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:randomUUID(),tool_name:'read_knowledge',arguments:{object_id:'asset-'+id,version,...page},checkpoint:exportCheckpoint(manager)};assert.equal((await h.internal('/internal/data/tool-calls',input)).status,200);return h.internal('/internal/data/tools',input);};
 const foreign=await deniedRead(inaccessible.value.id,inaccessible.value.version,{entry_id:'source_text'});assert.equal(foreign.status,404);assert.equal(foreign.value.code,'not_available');
 // 目录返回的资产已被记录为依赖；另建从未交付的对象，单独验证停用对象的404。
 const unseen=await h.request('/assets',{operation_id:randomUUID(),id:null,expected_version:null,kind:'memory',name:'未进入上下文的合成记忆',body:'独立停用场景',scope:'本人',verified:false,source_text:'未交付的合成来源',dependencies:[]});assert.equal(unseen.status,200);
 const authority=h.sql(`SELECT authority_snapshot FROM agent_runs WHERE id='${run.run_id}'`)[0];
 assert.ok(!ids.includes(unseen.value.id));assert.ok(!authority.memories.some(([id])=>id===unseen.value.id));
 assert.ok(authority.memories.some(([id,version])=>id===omitted.id&&version===omitted.version),'目录及全文交付的记忆必须进入依赖');
 const disabled=await h.request('/assets/'+unseen.value.id+'/disable',{operation_id:randomUUID(),expected_version:unseen.value.version});assert.equal(disabled.status,200);
 const unavailable=await deniedRead(unseen.value.id,disabled.value.version,{entry_id:'source_text'});assert.equal(unavailable.status,404);assert.equal(unavailable.value.code,'not_available');
 checks.push({name:'来源原话按固定版本及Unicode字符分页重建尾部例外，跨用户及停用记忆来源拒绝',passed:true});
 const updated=await h.request('/assets',{operation_id:randomUUID(),id:omitted.id,expected_version:omitted.version,kind:'memory',name:omitted.name,body:'已修订',scope:omitted.scope,verified:false,source_text:'本人修订',dependencies:[]});assert.equal(updated.status,200);
 for(const page of [{offset:2048},{entry_id:'source_text'}]){const stale=await deniedRead(omitted.id,omitted.version,page);assert.equal(stale.status,409);assert.equal(stale.value.code,'stale_context','已观察资料改版先拒绝整个旧运行上下文');}
 assert.equal((await h.request('/conversations/'+cid+'/messages/'+run.message_id+'/withdraw',{operation_id:randomUUID()})).status,200);h.releaseRun(run.run_id);await h.resumeWorker();
 const freshCid=await h.create();run=await h.capture(freshCid,'检查旧资产版本的分段读取');await h.pauseWorker();manager=SessionManager.inMemory('/synthetic/data-agent');
 assert.equal(run.checkpoint,null);assert.notEqual(run.conversation_id,cid);assert.ok(!run.workspace_context.authority_snapshot.memories.some(([id,version])=>id===omitted.id&&version===omitted.version));
 for(const page of [{offset:2048},{entry_id:'source_text'}]){const stale=await deniedRead(omitted.id,omitted.version,page);assert.equal(stale.status,409);assert.equal(stale.value.code,'stale_knowledge','有效新上下文中旧版本正文和来源都必须拒绝');}
 checks.push({name:'连续分段拼接长memory与原文一致，改版后旧版本正文和来源后续页被拒绝',passed:true});passed=true;console.log(JSON.stringify({passed,checks,officialRequests:0}));
}finally{await writeFile('.local/checks/mvp-asset-directory.json',JSON.stringify({passed,checks},null,2));await h.close();}

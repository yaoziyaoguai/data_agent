import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {validateContract} from '../../packages/contracts/validate.ts';
import {harness} from './harness.mjs';
const h=await harness({capture:true,env:{DATA_AGENT_LEASE_MS:'120000'}});
const manager=SessionManager.inMemory('/synthetic/data-agent');
const checks=[];let passed=false,run;
const invoke=async(name,args)=>{const input={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:randomUUID(),tool_name:name,arguments:args,checkpoint:exportCheckpoint(manager)};const registered=await h.internal('/internal/data/tool-calls',input);assert.equal(registered.status,200,JSON.stringify(registered.value));const result=await h.internal('/internal/data/tools',input);assert.equal(result.status,200,JSON.stringify(result.value));return result.value.data;};
try{
 const cid=await h.create();const memories=[],skills=[];
 for(let i=0;i<28;i++){
  const r=await h.request('/assets',{operation_id:randomUUID(),id:null,expected_version:null,kind:i<24?'memory':'skill',name:'合成方法'+i,body:'长文语义说明'.repeat(1800)+'专用尾部术语'+i,scope:'适用于合成订单分析'.repeat(100),verified:false,source_text:'本人录入',dependencies:[]});assert.equal(r.status,200);(i<24?memories:skills).push(r.value);
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
 const updated=await h.request('/assets',{operation_id:randomUUID(),id:omitted.id,expected_version:omitted.version,kind:'memory',name:omitted.name,body:'已修订',scope:omitted.scope,verified:false,source_text:'本人修订',dependencies:[]});assert.equal(updated.status,200);
 const input={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:randomUUID(),tool_name:'read_knowledge',arguments:{object_id:'asset-'+omitted.id,version:omitted.version,offset:2048},checkpoint:exportCheckpoint(manager)};assert.equal((await h.internal('/internal/data/tool-calls',input)).status,200);assert.equal((await h.internal('/internal/data/tools',input)).value.code,'stale_knowledge');
 checks.push({name:'连续分段拼接长memory与原文一致，改版后旧版本后续页被拒绝',passed:true});passed=true;console.log(JSON.stringify({passed,checks,officialRequests:0}));
}finally{await writeFile('.local/checks/mvp-asset-directory.json',JSON.stringify({passed,checks},null,2));await h.close();}

import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness,until} from './harness.mjs';
const h=await harness({capture:true,env:{DATA_AGENT_LEASE_MS:'120000'}});const manager=SessionManager.inMemory('/synthetic/data-agent');let passed=false,run;const checks=[];
const invoke=async(args,sdk=randomUUID())=>{
 const input={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:sdk,tool_name:'manage_personal_asset',arguments:args.action==='disable_memory'?args:{instruction_quote:run.text,...args},checkpoint:exportCheckpoint(manager)};
 assert.equal((await h.internal('/internal/data/tool-calls',input)).status,200);return {input,result:await h.internal('/internal/data/tools',input)};
};
const details={name:'本人渠道偏好',body:'默认渠道=app',scope:'未指定渠道的订单分析，明确输入优先',verified:false,dependencies:[]};
try{
 const cid=await h.create();run=await h.capture(cid,'把我的默认渠道改为app，之后再忘掉这条记忆');await h.pauseWorker();
 const old=(await h.request('/assets',{operation_id:randomUUID(),id:null,expected_version:null,kind:'memory',...details,body:'默认渠道=web',source_text:'本人明确保存'})).value;
 const other=(await h.request('/assets',{operation_id:randomUUID(),id:null,expected_version:null,kind:'memory',...details,source_text:'本人明确保存'},'bob')).value;
 const skill=(await h.request('/assets',{operation_id:randomUUID(),id:null,expected_version:null,kind:'skill',...details,source_text:'本人明确保存'})).value;
 assert.equal((await invoke({action:'update_memory',asset_id:other.id,expected_version:other.version,...details})).result.status,404);
 assert.equal((await invoke({action:'disable_memory',asset_id:skill.id,expected_version:skill.version})).result.value.code,'selection_required');
 assert.equal((await invoke({action:'update_memory',asset_id:old.id,expected_version:'0',...details})).result.value.code,'version_conflict');
 const sdk=randomUUID();const saved=await invoke({action:'update_memory',asset_id:old.id,expected_version:old.version,...details},sdk);assert.equal(saved.result.status,200);assert.equal(saved.result.value.data.version,'2');
 assert.deepEqual((await h.internal('/internal/data/tools',saved.input)).value,saved.result.value);
 assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM personal_asset_versions WHERE asset_id='${old.id}'`)[0].n,2);
 assert.equal((await h.internal('/internal/model/issue',{run_id:run.run_id,lease_epoch:run.lease_epoch,call_attempt_id:randomUUID()})).status,200);
 const disabled=await invoke({action:'disable_memory',asset_id:old.id,expected_version:'2'});assert.equal(disabled.result.status,200);assert.equal(disabled.result.value.data.state,'disabled');
 assert.deepEqual((await h.internal('/internal/data/tools',disabled.input)).value,disabled.result.value);
 const authority=h.sql(`SELECT authority_snapshot FROM agent_runs WHERE id='${run.run_id}'`)[0];assert.ok(authority.checkpoint_reset_required);assert.ok(!authority.memories.some(v=>v[0]===old.id));
 checks.push({name:'纠错工具校验本人记忆/版本，不能修改Skill或他人资产；修订和停用重放只有一次副作用，本轮可确认成功',passed:true});
 h.releaseRun(run.run_id);h.sql(`UPDATE agent_runs SET state='interrupted' WHERE id='${run.run_id}';UPDATE conversations SET lease_owner=NULL,lease_until=NULL WHERE id='${cid}';UPDATE background_jobs SET state='queued',lease_owner=NULL,lease_until=NULL WHERE message_id='${run.message_id}';`);await h.resumeWorker();
 await until(async()=>(await h.snapshot(cid)).events.some(e=>e.type==='run_failed'&&e.payload.message_id===run.message_id),'obsolete checkpoint blocked');
 assert.equal(h.captured.filter(v=>v.message_id===run.message_id).length,1);assert.equal((await h.request('/assets')).value.assets.find(v=>v.id===old.id).state,'disabled');
 checks.push({name:'记忆改变后的旧SDK检查点不能在中断恢复中复活；保留已提交资产变更，失效输入明确终止',passed:true});
 const mixed=await h.create();run=await h.capture(mixed,'仅本次按 web 渠道分析；另外请记住以后金额用元展示。');await h.pauseWorker();
 for(const instruction_quote of ['仅本次按 web 渠道分析','记住以后金额用元展示','另外请记住以后金额用美元展示']) {
  const rejected=await invoke({action:'save_memory',...details,body:'默认金额展示单位=元',scope:'金额展示偏好',instruction_quote});assert.equal(rejected.result.value.code,'scope_incomplete');
 }
 const money=await invoke({action:'save_memory',...details,body:'默认金额展示单位=元',scope:'金额展示偏好',instruction_quote:'另外请记住以后金额用元展示'});
 assert.equal(money.result.status,200,JSON.stringify(money.result.value));
 assert.deepEqual((await h.internal('/internal/data/tools',money.input)).value,money.result.value);
 const stored=(await h.request('/assets')).value.assets.find(v=>v.id===money.result.value.data.id);
 assert.equal(stored.body,'默认金额展示单位=元');assert.equal(stored.source_text,'另外请记住以后金额用元展示');
 checks.push({name:'同消息临时渠道与长期展示偏好分别处理，拒绝临时/裁掉限定/伪造原文，只保存可复用分句且重放幂等',passed:true});
 for(const [text,quote,allowed] of [
  ['以后我的分析默认只看web，但这次查2026年1月全部渠道净收入','以后我的分析默认只看web',true],
  ['以后我的分析默认只看web，但这次查2026年1月全部渠道净收入','以后我的分析默认只看web，',true],
  ['仅本次按 web 渠道分析，另外请记住以后金额用元展示。','另外请记住以后金额用元展示',true],
  ['不要记住，金额用元展示。','金额用元展示',false],
  ['金额用元展示，仅本次。','金额用元展示',false],
  ['金额用元展示，仅本次。','金额用元展示，',false],
  ['仅本次按 web 分析，另外金额用元展示，不要保存。','另外金额用元展示',false],
  ['仅本次按 web 分析，另外金额用元展示，不要保存。','另外金额用元展示，不要保存',false],
 ]) {
  await h.resumeWorker();run=await h.capture(await h.create(),text);await h.pauseWorker();
  const channelPreference=text.startsWith('以后我的分析');
  const result=(await invoke({action:'save_memory',...details,body:channelPreference?'默认渠道=web':'默认金额展示单位=元',scope:channelPreference?'默认渠道偏好':'金额展示偏好',instruction_quote:quote})).result;
  if(allowed){
   assert.equal(result.status,200,JSON.stringify(result.value));
   if(text.startsWith('以后我的分析'))assert.equal((await h.request('/assets')).value.assets.find(v=>v.id===result.value.data.id).source_text,text);
  }
  else assert.equal(result.value.code,'scope_incomplete');
 }
 checks.push({name:'逗号后的明确独立指令可保存；同一指令前后否定和临时限定不能被裁掉',passed:true});
 passed=true;console.log(JSON.stringify({passed,checks,officialRequests:0}));
}finally{await writeFile('.local/checks/mvp-memory-revisions.json',JSON.stringify({passed,checks},null,2));await h.close();}

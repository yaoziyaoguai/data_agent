import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness} from './harness.mjs';
import {assetInput,editInput,ok} from './skill-fixtures.mjs';

// 宿主真实事务与 Pi 检查点，工具选择由脚本控制；所有内容从零合成。
const h=await harness({capture:true,startWorker:false,env:{DATA_AGENT_LEASE_MS:'120000'}});
const checks=[];let passed=false,run,manager,lastInput;
const marker='SYNTHETIC_ASSET_WITHDRAWABLE_SOURCE';
const command=()=>({operation_id:randomUUID()});
const document=async(name,body)=>ok(await h.request('/knowledge',{...command(),kind:'document',name,body,related_ids:[]}));
const begin=async(cid,text)=>{await h.resumeWorker();run=await h.capture(cid,text);await h.pauseWorker();manager=SessionManager.inMemory('/synthetic/data-agent');return run;};
const checkpoint=()=>exportCheckpoint(manager,run.workspace_context.authority_revision,run.workspace_context.authority_snapshot);
const binding=()=>({run_id:run.run_id,lease_epoch:run.lease_epoch});
const invoke=async(name,args)=>{const input={...binding(),sdk_tool_call_id:randomUUID(),tool_name:name,arguments:args,checkpoint:checkpoint()};ok(await h.internal('/internal/data/tool-calls',input));lastInput=input;return ok(await h.internal('/internal/data/tools',input)).data;};
const finish=async()=>{const text='本轮合成资料处理完毕。';ok(await h.internal('/internal/outputs',{...binding(),chunk_seq:'1',text}));ok(await h.internal('/internal/finish',{...binding(),commit_id:run.output_id,final_text:text,checkpoint:checkpoint()}));h.releaseRun(run.run_id);};
const route=()=>invoke('update_analysis_task',{action:'route',task_id:null,expected_version:null,goal:'',options:[]});
const readAsset=async id=>ok(await h.request('/assets')).assets.find(asset=>asset.id===id);
const absent=value=>assert.equal(JSON.stringify(value).includes(marker),false);
try {
 const doc=await document('可撤回的合成资料',marker);
 const cid=await h.create();await begin(cid,'请记住以后金额以元显示。');
 await invoke('read_knowledge',{object_id:doc.id});
 const memory=await invoke('manage_personal_asset',{action:'save_memory',verified:false,name:'合成显示偏好',body:'金额用元；附资料'+marker,scope:'本人显示偏好',instruction_quote:run.text,dependencies:[]});
 await route();await finish();
 assert.ok(JSON.stringify((await readAsset(memory.id))).includes(marker));
 ok(await h.request(`/knowledge/${doc.id}/disable`,{...command(),expected_version:doc.version}));
 const hidden=(await readAsset(memory.id));assert.equal(hidden.text_unavailable,true);absent(hidden);
 absent(ok(await h.request('/assets')));
 const onlyName=ok(await h.request('/assets',editInput(memory,{name:'仅改显示名称'})));assert.equal(onlyName.text_unavailable,true);absent(onlyName);
 await begin(await h.create(),'列出可用的个人偏好。');absent(run.workspace_context);
 const directory=await invoke('search_knowledge',{query:'*',limit:30});absent(directory);
 await route();await finish();
 const rewritten=ok(await h.request('/assets',editInput(memory,{expected_version:onlyName.version,name:'独立人工偏好',body:'仅显示人民币元',scope:'显示设置',source_text:'',dependencies:[],files:[]})));
 assert.notEqual(rewritten.text_unavailable,true);assert.equal(rewritten.body,'仅显示人民币元');
 checks.push('遗漏refs的模型记忆在来源停用后HTTP/目录/跨会话隐藏；无关改名保留来源，完整人工重写恢复');
 const reviseDoc=await document('记忆修订上游来源','SYNTHETIC_MEMORY_REVISION_SOURCE');
 const reviseCid=await h.create();await begin(reviseCid,'请记住以后使用合成显示说明。');await route();
 await invoke('read_knowledge',{object_id:reviseDoc.id});
 const initial=await invoke('manage_personal_asset',{action:'save_memory',verified:false,name:'待修订记忆',body:'显示说明 SYNTHETIC_MEMORY_REVISION_SOURCE',scope:'显示偏好',instruction_quote:run.text,dependencies:[]});await finish();
 await begin(reviseCid,'请把我的合成显示说明改为新版。');await route();
 await invoke('read_knowledge',{object_id:`asset-${initial.id}`,version:initial.version});
 const revised=await invoke('manage_personal_asset',{action:'update_memory',asset_id:initial.id,expected_version:initial.version,verified:false,name:'已修订记忆',body:'新版显示说明 SYNTHETIC_MEMORY_REVISION_SOURCE',scope:'显示偏好',instruction_quote:run.text,dependencies:[]});
 assert.equal(revised.version,'2');assert.notEqual((await readAsset(initial.id)).text_unavailable,true);
 assert.equal((await readAsset(initial.id)).body,'新版显示说明 SYNTHETIC_MEMORY_REVISION_SOURCE');await finish();
 const fields=h.sql(`SELECT field_authorities FROM personal_asset_versions WHERE asset_id='${initial.id}' AND version=2`)[0];
 for(const field of Object.values(fields)){if(field?.origin==='generated'){assert.ok(field.authority.knowledge.some(ref=>ref[0]===reviseDoc.id));assert.ok(!field.authority.memories.some(ref=>ref[0]===initial.id));}}
 ok(await h.request(`/knowledge/${reviseDoc.id}/disable`,{...command(),expected_version:reviseDoc.version}));
 const revisedHidden=await readAsset(initial.id);assert.equal(revisedHidden.text_unavailable,true);assert.equal(JSON.stringify(revisedHidden).includes('SYNTHETIC_MEMORY_REVISION_SOURCE'),false);
 checks.push('读取记忆v1后模型修订v2不形成自引用；保留底层真实资料来源，撤下上游仍隐藏新正文');
 // 旧 NULL 资产必须依操作链区分人工与模型，而不能一律放行或一律封禁。
 const manual=ok(await h.request('/assets',assetInput({name:'旧人工方法',body:'人工独立正文'})));
 h.sql(`UPDATE personal_assets SET field_authorities=NULL WHERE id='${manual.id}';UPDATE personal_asset_versions SET field_authorities=NULL WHERE asset_id='${manual.id}';`);
 assert.equal((await readAsset(manual.id)).body,'人工独立正文');
 const legacyCid=await h.create();await begin(legacyCid,'请记住以后默认用合成标签。');
 const legacy=await invoke('manage_personal_asset',{action:'save_memory',verified:false,name:'旧模型记忆',body:'模型生成合成偏好',scope:'偏好',instruction_quote:run.text,dependencies:[]});await route();await finish();
 h.sql(`UPDATE personal_assets SET field_authorities=NULL WHERE id='${legacy.id}';UPDATE personal_asset_versions SET field_authorities=NULL WHERE asset_id='${legacy.id}';`);
 assert.equal((await readAsset(legacy.id)).text_unavailable,true);
 checks.push('旧NULL按持久HTTP/tool操作证据区分；旧人工可用，缺完整来源的旧模型正文隐藏');
 // 用户管理人工资料可修正依赖，采用边界仍拒绝失效引用。
 const ownDoc=await document('人工引用资料','独立合成定义');
 const explicit=ok(await h.request('/assets',assetInput({name:'人工依赖调整',body:'本人原文',dependencies:[{object_id:ownDoc.id,version:ownDoc.version,path:'body'}]})));
 ok(await h.request(`/knowledge/${ownDoc.id}/disable`,{...command(),expected_version:ownDoc.version}));
 assert.equal((await readAsset(explicit.id)).body,'本人原文');
 const adjusted=ok(await h.request('/assets',editInput(explicit,{dependencies:[]})));assert.equal(adjusted.body,'本人原文');
 checks.push('人工正文仍可管理并修正失效显式引用，不被模型来源保护误伤');
 const httpSaveInput=assetInput({name:'HTTP旧成功回执',body:'人工保存后删除的合成正文'});
 const httpSaved=ok(await h.request('/assets',httpSaveInput));
 const httpEditInput=editInput(httpSaved,{body:'人工修改后的合成正文'});
 const httpEdited=ok(await h.request('/assets',httpEditInput));
 const httpDeleteInput={...command(),expected_version:httpEdited.version};
 const httpDeleted=ok(await h.request(`/assets/${httpSaved.id}/delete`,httpDeleteInput));
 assert.deepEqual(ok(await h.request(`/assets/${httpSaved.id}/delete`,httpDeleteInput)),httpDeleted);
 assert.deepEqual(ok(await h.request('/assets',httpSaveInput)),httpSaved);
 assert.deepEqual(ok(await h.request('/assets',httpEditInput)),httpEdited);
 assert.equal(await readAsset(httpSaved.id),undefined);
 const unknownDelete=await h.request(`/assets/${httpSaved.id}/delete`,{...command(),expected_version:httpEdited.version});assert.equal(unknownDelete.value.code,'not_available');
 checks.push('HTTP保存/更新/删除成功操作在资产删除后仍取回原回执，未知操作不能复活资产');
 const replayDoc=await document('回执额外来源','SYNTHETIC_RECEIPT_SOURCE');
 const replayCid=await h.create();await begin(replayCid,'请记住以后使用测试单位。');await route();
 await invoke('read_knowledge',{object_id:replayDoc.id});
 const replayAsset=await invoke('manage_personal_asset',{action:'save_memory',verified:false,name:'回执偏好',body:'测试单位 SYNTHETIC_RECEIPT_SOURCE',scope:'测试显示',instruction_quote:run.text,dependencies:[]});
 const savedInput=lastInput;
 assert.deepEqual(ok(await h.internal('/internal/data/tools',savedInput)).data,replayAsset);
 ok(await h.request(`/knowledge/${replayDoc.id}/disable`,{...command(),expected_version:replayDoc.version}));
 let replayed=ok(await h.internal('/internal/data/tools',savedInput)).data;assert.equal(replayed.text_unavailable,true);assert.equal(JSON.stringify(replayed).includes('SYNTHETIC_RECEIPT_SOURCE'),false);
 ok(await h.request(`/assets/${replayAsset.id}/delete`,{...command(),expected_version:replayAsset.version}));
 replayed=ok(await h.internal('/internal/data/tools',savedInput)).data;assert.equal(replayed.text_unavailable,true);assert.equal(replayed.id,replayAsset.id);
 ok(await h.request(`/conversations/${replayCid}/messages/${run.message_id}/withdraw`,command()));h.releaseRun(run.run_id);
 checks.push('同运行有效记忆回执保留正常正文，撤源及删除后的同SDK重放只返回控制身份且不重建资产');
 const systemCid=await h.create();await begin(systemCid,'合成系统通知不得保存或停用长期偏好');
 h.sql(`UPDATE conversation_messages SET client_key='server:synthetic-notice:${run.message_id}' WHERE id='${run.message_id}'`);
 for(const args of [
  {action:'save_memory',verified:false,name:'系统伪偏好',body:'系统不得成为用户授权',scope:'系统通知',instruction_quote:run.text,dependencies:[]},
  {action:'disable_memory',asset_id:rewritten.id,expected_version:rewritten.version}
 ]){
  const input={...binding(),sdk_tool_call_id:randomUUID(),tool_name:'manage_personal_asset',arguments:args,checkpoint:checkpoint()};
  ok(await h.internal('/internal/data/tool-calls',input));const denied=await h.internal('/internal/data/tools',input);assert.equal(denied.value.code,'scope_incomplete');
 }
 assert.equal((await readAsset(rewritten.id)).state,'enabled');
 ok(await h.request(`/conversations/${systemCid}/messages/${run.message_id}/withdraw`,command()));h.releaseRun(run.run_id);
 checks.push('持久system来源消息不能借完整原文获得记忆保存或停用权');
 passed=true;
} finally {if(run)h.releaseRun(run.run_id);await h.close();await writeFile('.local/checks/asset-text-authority.json',JSON.stringify({passed,checks,officialRequests:0},null,2));console.log(JSON.stringify({passed,checks,officialRequests:0}));}

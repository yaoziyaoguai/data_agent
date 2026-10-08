import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {harness} from './harness.mjs';
import {assetInput, editInput, ok, select} from './skill-fixtures.mjs';
const h=await harness({capture:true,startWorker:false}); const checks=[];let passed=false;
try {
 const cid=await h.create();const list=()=>h.request(`/conversations/${cid}/skill-selections`);
 assert.deepEqual(ok(await list()).selections,[]);
 const skills=[];
 for(let i=0;i<53;i++){const asset=ok(await h.request('/assets',assetInput({name:'合成分页方法'+i})));skills.push(asset);ok(await select(h,cid,asset));}
 const first=ok(await list());assert.equal(first.selections.length,50);assert.ok(first.next_after_id);
 const second=ok(await h.request(`/conversations/${cid}/skill-selections?after_id=${first.next_after_id}`));assert.equal(second.selections.length,3);assert.equal(second.next_after_id,null);
 assert.equal(new Set([...first.selections,...second.selections].map(v=>v.asset_id)).size,53);
 const initial=first.selections.find(v=>v.asset_id===skills[0].id)??second.selections.find(v=>v.asset_id===skills[0].id);assert.equal(initial.availability,'available');
 const changed=ok(await h.request('/assets',editInput(skills[0],{body:'修改分析方法'})));
 const disabled=ok(await h.request('/assets/'+skills[1].id+'/disable',{operation_id:randomUUID(),expected_version:'1'}));
 ok(await h.request('/assets/'+skills[2].id+'/delete',{operation_id:randomUUID(),expected_version:'1'}));
 const all=async()=>{const a=ok(await list());return [...a.selections,...(a.next_after_id?ok(await h.request(`/conversations/${cid}/skill-selections?after_id=${a.next_after_id}`)).selections:[])];};
 let items=await all();assert.equal(items.find(v=>v.asset_id===changed.id).availability,'version_changed');assert.equal(items.find(v=>v.asset_id===changed.id).selected_version,'1');
 assert.equal(items.find(v=>v.asset_id===disabled.id).availability,'disabled');
 const deleted=items.find(v=>v.asset_id===skills[2].id);assert.equal(deleted.availability,'unavailable');assert.equal(deleted.name,null);assert.equal(deleted.current_version,null);
 ok(await h.request('/assets/'+disabled.id+'/enable',{operation_id:randomUUID(),expected_version:disabled.version}));
 assert.equal((await all()).find(v=>v.asset_id===disabled.id).availability,'version_changed');
 ok(await select(h,cid,changed));assert.equal((await all()).find(v=>v.asset_id===changed.id).availability,'available');
 checks.push('选择列表分页完整；改版、停用、删除、启用及明确重选各自展示，旧版不自动升级');
 const doc=ok(await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'合成方法引用文档',body:'当前规则',related_ids:[]}));
 const dependent=ok(await h.request('/assets',assetInput({dependencies:[{object_id:doc.id,version:doc.version,path:'body'}]})));ok(await select(h,cid,dependent));
 ok(await h.request('/knowledge/'+doc.id+'/disable',{operation_id:randomUUID(),expected_version:doc.version}));
 assert.equal((await all()).find(v=>v.asset_id===dependent.id).availability,'dependency_unavailable');
 const other=await h.create('bob');assert.equal((await h.request(`/conversations/${cid}/skill-selections`,undefined,'bob')).status,404);assert.deepEqual(ok(await h.request(`/conversations/${other}/skill-selections`,undefined,'bob')).selections,[]);
 h.sql(`UPDATE personal_assets SET space_id='different-space' WHERE id='${changed.id}'`);
 const hidden=(await all()).find(v=>v.asset_id===changed.id);assert.equal(hidden.availability,'unavailable');assert.equal(hidden.name,null);
 checks.push('知识依赖失效清楚标注；会话归属和空间边界拒绝泄漏，其他会话保持空选择');
 const table=ok(await h.request('/knowledge/table-demo_order_detail'));
 const linked=ok(await h.request('/assets',assetInput({dependencies:[{object_id:table.id,version:table.version,path:table.entries[0].entry_id}]})));const platformCid=await h.create();ok(await select(h,platformCid,linked));
 h.sql('RENAME TABLE source_heads TO temporarily_unavailable_source_heads');
 try { assert.notEqual((await h.request(`/conversations/${platformCid}/skill-selections`)).status,200); }
 finally { h.sql('RENAME TABLE temporarily_unavailable_source_heads TO source_heads'); }
 checks.push('依赖存储故障返回失败，不冒充空列表或业务失效');
 ok(await h.request('/conversations/'+cid,{operation_id:randomUUID()},'alice','DELETE'));
 assert.equal((await list()).status,404);
 passed=true;console.log(JSON.stringify({passed,checks,officialRequests:0}));
} finally {await writeFile('.local/checks/conversation-skill-selections.json',JSON.stringify({passed,checks},null,2));await h.close();}

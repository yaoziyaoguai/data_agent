import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {harness} from './harness.mjs';
import {synchronizeSources} from './source-sync.mjs';

// 平台仅交付合成目录文本；同步、知识合并与当前来源均经过真实 API/MySQL。
const h = await harness({capture:true});
const checks = [];
let passed = false;
const table = {
  id:'voice_events', name:'voice_events', platform_version:'1', maintainer_id:'alice',
  comment:'完全虚构的座舱语音事件，event_id唯一标识一次事件。',
  ddl:'CREATE TABLE voice_events (event_id INTEGER, status TEXT);',
  columns:[
    {id:'event_id',name:'event_id',data_type:'INTEGER',nullable:false,comment:'合成事件标识'},
    {id:'status',name:'status',data_type:'TEXT',nullable:false,comment:'语音处理状态'},
  ],
  node:{id:'build_voice_events',sql:"INSERT INTO voice_events SELECT event_id, '未 完成' AS status FROM synthetic_voice;",upstream_ids:['synthetic_voice']},
};
const ok = response => {assert.equal(response.status,200,JSON.stringify(response.value)); return response.value;};
const sync = async value => {
  await writeFile(h.directory+'/platform/catalog.json',JSON.stringify({source_namespace:'synthetic-voice-content',authoritative:true,tables:[value]}));
  const result = ok(await synchronizeSources(h));
  assert.equal(result.status,'completed',JSON.stringify(result));
  return result;
};
try {
  await sync(table);
  const objects = h.sql("SELECT body FROM knowledge_objects WHERE source_id LIKE 'catalog-%' AND kind='table'");
  assert.equal(objects.length,1);
  const before = ok(await h.request('/sources/'+objects[0].source_id));
  const stored = h.sql("SELECT JSON_OBJECT('source_id',source_id,'revision',revision,'body',body,'namespace',namespace,'external_id',external_id) FROM source_current WHERE source_id='"+objects[0].source_id+"'");
  assert.equal(stored.length,1,'完整来源保存当前正文');
  assert.equal(stored[0].revision,1);
  assert.equal(stored[0].body,before.body);
  assert.equal(stored[0].namespace,'synthetic-voice-content');
  assert.equal(stored[0].external_id,'voice_events');
  const offset=Array.from(before.body.slice(0,before.body.indexOf('未 完成'))).length;
  const excerpt=ok(await h.request(`/sources/${objects[0].source_id}?version=1&offset=${offset}&length=4`));
  assert.equal(excerpt.content,'未 完成');
  assert.deepEqual(excerpt.citation,{source:{kind:'platform',id:objects[0].source_id},revision:'1',locator:{offset,length:4}});
  for (const query of ['offset=0&length=1','version=1&offset=0','version=1&offset=-1&length=1','version=1&offset=0&length=9007199254740992']) {
    const invalid=await h.request(`/sources/${objects[0].source_id}?${query}`);
    assert.equal(invalid.status,400);
    assert.equal(invalid.value.code,'invalid_input');
  }
  await sync({...table,platform_version:'2',node:{...table.node,sql:"INSERT  INTO voice_events\nSELECT event_id,  '未 完成' AS status\nFROM synthetic_voice;"}});
  const after = ok(await h.request('/sources/'+objects[0].source_id));
  assert.equal(after.version,before.version,'纯词间排版不推进内容修订');
  assert.equal(after.body,before.body,'保留原正文与原位置，不追随上游排版重写');
  assert.equal(ok(await h.request('/knowledge/'+objects[0].id)).version,objects[0].version);
  checks.push('生产SQL仅词间排版变化时正文、来源修订和知识修订不变');
  await sync({...table,platform_version:'3',maintainer_id:'bob'});
  assert.deepEqual(ok(await h.request('/sources/'+objects[0].source_id)),before);
  assert.equal(h.sql("SELECT JSON_OBJECT('version',platform_version) FROM catalog_platform_heads")[0].version,3);
  checks.push('平台观测版本及负责人独立更新，不改原文或语义修订');
  let current = table;
  let revision = 1;
  for (const sql of [
    table.node.sql.replace('未 完成','未  完成'),
    table.node.sql+' -- 仅首次命中计入',
    table.node.sql+' -- 最终命中计入',
    table.node.sql.replace('SELECT','SELECT /*+ BROADCAST(synthetic_voice) */'),
    table.node.sql.replace('SELECT','select'),
  ]) {
    current = {...current,platform_version:String(Number(current.platform_version)+3),node:{...current.node,sql}};
    await sync(current);
    const changed = ok(await h.request('/sources/'+objects[0].source_id));
    assert.equal(changed.version,String(++revision));
    assert.ok(changed.body.includes(sql));
  }
  checks.push('字符串空白、解释性注释、hint与SQL大小写变化仍推进来源修订');
  const stale=await h.request(`/sources/${objects[0].source_id}?version=1&offset=${offset}&length=4`);
  assert.equal(stale.status,409);assert.equal(stale.value.code,'stale_source');
  checks.push('定点读取使用Unicode code point及修订绑定，旧位置不切新正文');
  passed = true;
} finally {
  await h.close();
  await writeFile('.local/checks/source-content.json',JSON.stringify({passed,checks,officialRequests:0},null,2));
}
console.log(JSON.stringify({passed,checks,officialRequests:0}));

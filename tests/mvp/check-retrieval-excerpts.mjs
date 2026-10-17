import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness, until} from './harness.mjs';
import {embeddingProvider} from './embedding-provider.mjs';

execFileSync(homedir()+'/.cargo/bin/cargo', ['test','--offline','--locked','-p','data-agent','--lib','modules::retrieval'], {stdio:'inherit'});
const provider = await embeddingProvider();
const collection = 'da_excerpt_'+randomUUID().replaceAll('-','');
const token = (await readFile('.local/infra/milvus-root-password','utf8')).trim();
const profile = {provider_id:'deepseek',model_id:'deepseek-flash',trial_id:'excerpts_'+randomUUID(),price_version:'2026-10-04-peak-usd',input_limit:65536,output_limit:4096,trial_call_limit:200,trial_cost_micros:'1000000',request_call_limit:24,toolset:'data',payload_bytes_limit:131072};
const manager = SessionManager.inMemory('/synthetic/data-agent');
let h, run, passed=false;
const checks=[];
const ok = response => {assert.equal(response.status,200,JSON.stringify(response.value));return response.value;};
const milvus = async (action, input={}) => {
  const response=await fetch('http://127.0.0.1:19531/v2/vectordb/'+action, {method:'POST',headers:{authorization:'Bearer root:'+token,'content-type':'application/json'},body:JSON.stringify({collectionName:collection,dbName:'default',...input})});
  const value=await response.json();assert.equal(value.code,0,JSON.stringify(value));return value.data;
};
const invoke = async (name,args) => {
  const input={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:randomUUID(),tool_name:name,arguments:args,checkpoint:exportCheckpoint(manager,run.workspace_context.authority_revision,run.workspace_context.authority_snapshot)};
  ok(await h.internal('/internal/data/tool-calls',input));return ok(await h.internal('/internal/data/tools',input)).data;
};
const search = async query => ok(await h.request('/knowledge?q='+encodeURIComponent(query)));
const create = async (name,body) => ok(await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name,body,source_url:null,related_ids:[]}));
const records = async id => milvus('entities/query',{filter:`object_id == "${id}"`,outputFields:['id','object_id','object_version','kind','space_id','model','vector','entry_id','char_offset','char_length','content_hash'],limit:512,consistencyLevel:'Strong'});
const waitIndexed = async ids => {
  await until(() => h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM knowledge_index_jobs WHERE object_id IN (${ids.map(id=>`'${id}'`).join(',')}) AND vector_state<>'indexed'`)[0].n===0,'isolated excerpt documents indexed',60000);
};
const assertExcerpt = (result,object,rule,entry='body') => {
  const actual=result.objects.find(value=>value.id===object.id);assert.ok(actual,JSON.stringify(result.search_coverage));
  assert.equal(actual.version,object.version);assert.equal(actual.retrieval.state,'located');
  const excerpt=actual.retrieval.excerpts.find(value=>value.entry_id===entry && value.text.includes(rule));
  assert.ok(excerpt,JSON.stringify(actual.retrieval));
  const source=object.entries.find(value=>value.entry_id===entry).effective_value;
  assert.equal(excerpt.text,[...source].slice(excerpt.offset,excerpt.offset+excerpt.length).join(''));
  assert.equal(excerpt.total_chars,[...source].length);assert.ok(excerpt.offset>600);
  assert.match(actual.retrieval.note,/read_knowledge/);
  return {actual,excerpt};
};

try {
  h=await harness({capture:true,profile,startWorker:false,env:{...provider.env,DATA_AGENT_LEASE_MS:'120000',DATA_AGENT_VECTOR_URL:'http://127.0.0.1:19531',DATA_AGENT_VECTOR_COLLECTION:collection,DATA_AGENT_VECTOR_TOKEN_FILE:process.cwd()+'/.local/infra/milvus-root-password'}});
  const labRule='校准有效期结束后，设备必须封存，完成重新校准前禁止出具检测结果。';
  const libraryRule='珍本借阅必须由两名馆员共同登记，外借期限最长三天，不允许续借。';
  const filler='本章节记录机构设立背景、例行会议安排与资料保管。🌏'.repeat(90);
  const laboratory=await create('运行规则',filler+'\n'+labRule);
  const library=await create('运行规则',filler+'\n'+libraryRule);
  const distractor=await create('运行规则','馆内普通书刊可借阅三十天，续借一次。不得据此解释珍本外借。');
  const weatherRule='采样风速超过十二米每秒时停止高空作业。';
  const weatherSource=await create('气象作业原始资料',weatherRule);
  const weather=await create('高空采样作业说明',filler+'\n'+weatherRule);
  weather.entries[0].source_facts={source_id:'document-'+weatherSource.id,version:weatherSource.version,location:'body',complete:true};
  const secondaryRule='低温探测器的校准记录必须保留七年，销毁前由质量负责人签字。';
  laboratory.entries.push({...laboratory.entries[0],entry_id:'retention',path:'retention',label:'留存规则',effective_value:filler+'\n'+secondaryRule});
  // 独立多条目资料夹具，在首次索引之前写入；不改现有业务样例或模型答案。
  for(const fixture of [laboratory,weather]) {
    const encoded=Buffer.from(JSON.stringify(fixture)).toString('hex');
    h.sql(`UPDATE knowledge_objects SET body=CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON) WHERE id='${fixture.id}';UPDATE knowledge_versions SET body=CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON) WHERE object_id='${fixture.id}' AND version=1`);
  }
  await h.resumeWorker();await waitIndexed([laboratory.id,library.id,distractor.id,weather.id,weatherSource.id]);
  assertExcerpt(await search(weatherRule),weather,weatherRule);
  run=await h.capture(await h.create(),'核对检测设备和珍本借阅的业务限制');await h.pauseWorker();
  for (const [object,rule,entry] of [[laboratory,labRule,'body'],[library,libraryRule,'body'],[laboratory,secondaryRule,'retention']]) {
    const result=await invoke('search_knowledge',{query:rule,limit:10});
    const {actual,excerpt}=assertExcerpt(result,object,rule,entry);
    assert.ok(!actual.entries.find(value=>value.entry_id===entry).effective_value.includes(rule),'directory prefix remains distinct from the actual hit');
    const page=await invoke('read_knowledge',{object_id:actual.id,version:actual.version,entry_id:excerpt.entry_id,offset:excerpt.offset,limit:excerpt.length});
    assert.equal(page.entries[0].effective_value,excerpt.text);
  }
  checks.push('检测设备与图书馆两个独立领域：同名干扰下交付600字之后的真实命中，Unicode位置与正式全文入口逐字一致');
  const multiple=await invoke('search_knowledge',{query:labRule+secondaryRule,limit:10});
  const labHits=multiple.objects.find(value=>value.id===laboratory.id).retrieval.excerpts;
  assert.ok(labHits.some(value=>value.entry_id==='body'));assert.ok(labHits.some(value=>value.entry_id==='retention'));
  assert.ok(labHits.length<=3);
  checks.push('同一对象的不同条目保留独立位置，最多三个片段，不以重叠窗口挤掉另一项规则');

  const original=await records(library.id);assert.ok(original.length>1);
  const legacy=original.map(record=>Object.fromEntries(Object.entries(record).filter(([key])=>!['entry_id','char_offset','char_length','content_hash'].includes(key))));
  await milvus('entities/upsert',{data:legacy});
  const old=await invoke('search_knowledge',{query:libraryRule,limit:10});
  assertExcerpt(old,library,libraryRule);
  assert.ok((await records(library.id)).every(value=>value.entry_id===undefined));
  assert.equal(ok(await h.request('/knowledge/'+library.id)).version,library.version);
  checks.push('旧索引复用原片段键从当前授权正文还原真实命中；不重建、不写入索引，正式对象版本保持');
  const unknown=legacy.map(record=>({...record,id:'unknown-'+randomUUID()}));
  await milvus('entities/upsert',{data:unknown});
  await milvus('entities/delete',{filter:'id in '+JSON.stringify(original.map(value=>value.id))});
  const unknownResult=await invoke('search_knowledge',{query:libraryRule,limit:10});
  const {actual:unknownObject}=assertExcerpt(unknownResult,library,libraryRule);
  assert.equal(unknownObject.retrieval.channel,'lexical');
  await milvus('entities/delete',{filter:'id in '+JSON.stringify(unknown.map(value=>value.id))});
  await milvus('entities/upsert',{data:original.map(record=>({...record,char_offset:999999}))});
  const malformed=await invoke('search_knowledge',{query:libraryRule,limit:10});
  const {actual:malformedObject}=assertExcerpt(malformed,library,libraryRule);
  assert.equal(malformedObject.retrieval.channel,'lexical');
  // 查询词不存在于正式正文。独立设置本地协议向量命中，不依靠hash向量的语义质量。
  const noLexicalQuery='nonlexicalneedle';
  const forcedVector=await fetch(provider.env.DATA_AGENT_EMBEDDING_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'qwen3.7-text-embedding',dimensions:1024,input:[noLexicalQuery]})});
  assert.equal(forcedVector.status,200);
  const noLexicalEmbedding=(await forcedVector.json()).data[0].embedding;
  await milvus('entities/upsert',{data:[{...original[0],char_offset:999999,vector:noLexicalEmbedding}]});
  const noLexical=await invoke('search_knowledge',{query:noLexicalQuery,limit:10});
  const noLexicalObject=noLexical.objects.find(value=>value.id===library.id);
  assert.ok(noLexicalObject);
  assert.equal(noLexicalObject.retrieval.state,'unlocated');assert.deepEqual(noLexicalObject.retrieval.excerpts,[]);
  await milvus('entities/upsert',{data:legacy});
  const embeddingsBefore=provider.requests.length;
  ok(await h.request('/knowledge-index/rebuilds',{operation_id:randomUUID()}));
  await h.resumeWorker();await waitIndexed([laboratory.id,library.id,distractor.id]);await h.pauseWorker();
  assert.equal(provider.requests.length,embeddingsBefore,'metadata repair reuses original embedding receipts');
  assert.ok((await records(library.id)).every(value=>value.entry_id==='body'));
  assertExcerpt(await search(libraryRule),library,libraryRule);
  checks.push('未知旧键与越界位置仅由当前正文真实词法匹配补定位，并明确lexical渠道；正文无查询词时保持unlocated；受控重建补齐元数据并复用原向量回执');

  const currentBody='珍本资料已更换规则，需要重新核对正式条款。';
  const current=ok(await h.request('/knowledge/'+library.id,{operation_id:randomUUID(),expected_version:library.version,entry_id:'body',value:currentBody},'alice','PATCH'));
  const stale=await search(libraryRule);
  assert.ok(!JSON.stringify(stale).includes(libraryRule));
  const currentResult=stale.objects.find(value=>value.id===library.id);
  if(currentResult){
    assert.equal(currentResult.version,current.version);
    // 新正文仍含查询中的“珍本”；新词法命中必须指向当前正文，而非旧向量位置。
    assert.equal(currentResult.retrieval.channel,'lexical');
    for(const excerpt of currentResult.retrieval.excerpts)assert.equal(excerpt.text,[...currentBody].slice(excerpt.offset,excerpt.offset+excerpt.length).join(''));
  }
  ok(await h.request('/knowledge/'+laboratory.id+'/disable',{operation_id:randomUUID(),expected_version:laboratory.version}));
  assert.ok(!(await search(labRule)).objects.some(value=>value.id===laboratory.id));
  ok(await h.request('/knowledge/'+weatherSource.id+'/disable',{operation_id:randomUUID(),expected_version:weatherSource.version}));
  const withdrawnSource=await search(weatherRule);
  assert.ok(!withdrawnSource.objects.some(value=>[weather.id,weatherSource.id].includes(value.id)));
  assert.ok(!JSON.stringify(withdrawnSource).includes(weatherRule));
  const foreign=await create('隔离资料','跨空间隔离标记只能由原空间读取。');
  h.sql(`UPDATE knowledge_objects SET space_id='isolated-space' WHERE id='${foreign.id}'`);
  await milvus('entities/upsert',{data:[{...original[0],id:'foreign-'+randomUUID(),object_id:foreign.id,object_version:1}]});
  const denied=await search('跨空间隔离标记只能由原空间读取。');
  assert.ok(!JSON.stringify(denied).includes(foreign.id));assert.ok(!JSON.stringify(denied).includes('跨空间隔离标记'));
  assert.equal((await h.request('/knowledge/'+foreign.id)).status,404);
  checks.push('晚到旧版本、停用对象、依赖来源撤回和伪造同空间索引中的跨空间对象均不能交付正文或存在性；未冒称真实平台ACL已验证');
  passed=true;console.log(JSON.stringify({passed,checks,officialRequests:0}));
} finally {
  await h?.close();
  if((await milvus('collections/has')).has)await milvus('collections/drop');
  await provider.close();
  await writeFile('.local/checks/retrieval-excerpts.json',JSON.stringify({passed,checks,officialRequests:0},null,2));
}

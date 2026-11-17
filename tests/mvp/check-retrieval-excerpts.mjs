import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {homedir} from 'node:os';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness, until} from './harness.mjs';
import {embeddingProvider} from './embedding-provider.mjs';
import {synchronizeSources} from './source-sync.mjs';

execFileSync(homedir()+'/.cargo/bin/cargo', ['test','--offline','--locked','-p','data-agent','--lib','modules::retrieval'], {stdio:'inherit'});
const provider = await embeddingProvider();
const collection = 'da_excerpt_'+randomUUID().replaceAll('-','');
const token = (await readFile('.local/infra/milvus-root-password','utf8')).trim();
let failSearch=false;
const searchRequests=[];
const proxy=createServer(async(req,res)=>{
  try{
    let body='';for await(const part of req)body+=part;
    const search=req.url.endsWith('/search')?JSON.parse(body):null;
    if(search){
      searchRequests.push({channel:search.annsField,injected:failSearch});
      if(failSearch){res.writeHead(503,{'content-type':'application/json'}).end('{"code":1}');return;}
    }
    const remote=await fetch('http://127.0.0.1:19531'+req.url,{method:'POST',
      headers:{authorization:req.headers.authorization,'content-type':'application/json'},body});
    res.writeHead(remote.status,{'content-type':'application/json'}).end(await remote.text());
  }catch(error){res.writeHead(502,{'content-type':'application/json'}).end(JSON.stringify({error:error.message}));}
});
await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
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
  ok(await h.internal('/internal/data/tool-calls',input));
  const reply=ok(await h.internal('/internal/data/tools',input));
  assert.ok(Buffer.byteLength(JSON.stringify(reply))<=24576,'完整工具回执保持24KiB上限');
  return reply.data;
};
const search = async query => ok(await h.request('/knowledge?q='+encodeURIComponent(query)));
const create = async (name,body) => ok(await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name,body,source_url:null,related_ids:[]}));
// 同一文档的knowledge_entry与source_excerpt两目标共用object_id（05切片1/2起同库
// 共存）：按target区分行。此处断言的是知识片段的定位元数据，原文摘录行entry_id
// 合法为空，不参与该断言。
const records = async (id,target='knowledge_entry') => milvus('entities/query',{filter:`object_id == "${id}" && target == "${target}"`,outputFields:['id','object_id','object_version','kind','space_id','model','vector','text','target','projection_version','entry_id','entry_path','statement_id','statement_offset','char_offset','char_length','content_hash'],limit:512,consistencyLevel:'Strong'});
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
  h=await harness({capture:true,profile,startWorker:false,env:{...provider.env,DATA_AGENT_LEASE_MS:'120000',DATA_AGENT_VECTOR_URL:'http://127.0.0.1:'+proxy.address().port,DATA_AGENT_VECTOR_COLLECTION:collection,DATA_AGENT_VECTOR_TOKEN_FILE:process.cwd()+'/.local/infra/milvus-root-password'}});
  ok(await h.request('/knowledge-index/rebuilds',{operation_id:randomUUID()}));
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
  // 裸SQL正文只落对象本体；真实保存路径会同步登记依赖索引（source_facts→
  // required/origin行）。此处补齐同等依赖行，撤回来源场景才落在真实判定路径上。
  h.sql(`INSERT IGNORE INTO knowledge_dependencies(owner_id,owner_version,space_id,entry_path,layer,purpose,role,effective,target_kind,target_id,target_revision,target_path,target_fingerprint) VALUES('${weather.id}',1,'demo','body','source_fact','required','origin',1,'document','${weatherSource.id}',${Number(weatherSource.version)},'','')`);
  await h.resumeWorker();await waitIndexed([laboratory.id,library.id,distractor.id,weather.id,weatherSource.id]);
  assertExcerpt(await search(weatherRule),weather,weatherRule);
  run=await h.capture(await h.create(),'核对检测设备和珍本借阅的业务限制');await h.pauseWorker();
  for (const [object,rule,entry] of [[laboratory,labRule,'body'],[library,libraryRule,'body'],[laboratory,secondaryRule,'retention']]) {
    const result=await invoke('search_knowledge',{query:rule,limit:10});
    const {actual,excerpt}=assertExcerpt(result,object,rule,entry);
    const delivered=actual.entries.find(value=>value.entry_id===entry);
    const source=[...object.entries.find(value=>value.entry_id===entry).effective_value];
    const offset=delivered.content_page.offset;
    const length=[...delivered.effective_value].length;
    assert.ok(Number.isInteger(offset) && offset>600,'交付正文保留命中窗口的原位置，不能冒称目录开头');
    assert.ok(length>0 && length<source.length && offset+length<=source.length);
    assert.equal(delivered.path,object.entries.find(value=>value.entry_id===entry).path);
    assert.equal(delivered.effective_value,source.slice(offset,offset+length).join(''));
    assert.equal(delivered.content_page.total_chars,source.length);
    assert.equal(delivered.content_page.next_offset,offset+length<source.length?offset+length:null);
    assert.equal(delivered.content_page.complete,false);
    assert.equal(actual.entries_complete,false);
    assert.equal(result.reply_coverage.state,'bounded');
    const page=await invoke('read_knowledge',{object_id:actual.id,version:actual.version,entry_id:excerpt.entry_id,offset:excerpt.offset,limit:excerpt.length});
    assert.equal(page.entries[0].effective_value,excerpt.text);
    const prefix=await invoke('read_knowledge',{object_id:actual.id,version:actual.version,entry_id:entry,offset:0,limit:160});
    assert.equal(prefix.entries[0].effective_value,source.slice(0,160).join(''));
    assert.ok(!prefix.entries[0].effective_value.includes(rule),'显式补读的目录前缀与实际命中保持区分');
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
  const ordered=original.toSorted((a,b)=>a.char_offset-b.char_offset);
  const shifted=ordered.map((record,index)=>{
    const other=ordered[(index+3)%ordered.length];
    assert.ok(Math.abs(other.char_offset-record.char_offset)>360);
    return {...record,char_offset:other.char_offset,char_length:other.char_length,content_hash:other.content_hash};
  });
  await milvus('entities/upsert',{data:shifted});
  const mismatched=await invoke('search_knowledge',{query:libraryRule,limit:10,related_object_id:library.id});
  assert.deepEqual(mismatched.objects,[],'同版另一合法窗口和正确hash不能冒用原record');
  assert.equal(mismatched.search_coverage.candidate_count,9);
  assert.equal(mismatched.search_coverage.state,'bounded');
  assert.equal(mismatched.search_coverage.channels.lexical.shards,1);
  assert.equal(mismatched.search_coverage.channels.lexical.completed,1);
  const unknown=legacy.map(record=>({...record,id:'unknown-'+randomUUID()}));
  await milvus('entities/upsert',{data:unknown});
  await milvus('entities/delete',{filter:'id in '+JSON.stringify(original.map(value=>value.id))});
  const rejectedUnknown=await invoke('search_knowledge',{query:libraryRule,limit:10});
  assert.ok(!rejectedUnknown.objects.some(value=>value.id===library.id),'未知键无合法定位时不能制造正文');
  assert.equal(rejectedUnknown.search_coverage.channels.lexical.shards,1,'成功BM25不能追加SQL搜索票');
  assert.equal(rejectedUnknown.search_coverage.channels.lexical.completed,1);
  failSearch=true;searchRequests.length=0;
  const unknownResult=await invoke('search_knowledge',{query:libraryRule,limit:10});
  failSearch=false;
  const {actual:unknownObject}=assertExcerpt(unknownResult,library,libraryRule);
  assert.equal(unknownObject.retrieval.channel,'lexical');
  assert.equal(unknownResult.search_coverage.channels.lexical.shards,2,'全败后的两个SQL owner替代词法');
  assert.equal(unknownResult.search_coverage.channels.lexical.completed,2);
  assert.ok(searchRequests.some(value=>value.channel==='sparse')&&searchRequests.every(value=>value.injected));
  await milvus('entities/delete',{filter:'id in '+JSON.stringify(unknown.map(value=>value.id))});
  await milvus('entities/upsert',{data:original.map(record=>({...record,char_offset:999999}))});
  const rejectedMalformed=await invoke('search_knowledge',{query:libraryRule,limit:10});
  assert.ok(!rejectedMalformed.objects.some(value=>value.id===library.id),'显式越界位置不能被恢复成另一个命中');
  assert.equal(rejectedMalformed.search_coverage.channels.lexical.shards,1);
  assert.equal(rejectedMalformed.search_coverage.channels.lexical.completed,1);
  failSearch=true;searchRequests.length=0;
  const malformed=await invoke('search_knowledge',{query:libraryRule,limit:10});
  failSearch=false;
  const {actual:malformedObject}=assertExcerpt(malformed,library,libraryRule);
  assert.equal(malformedObject.retrieval.channel,'lexical');
  assert.equal(malformed.search_coverage.channels.lexical.shards,2);
  assert.equal(malformed.search_coverage.channels.lexical.completed,2);
  assert.ok(searchRequests.some(value=>value.channel==='sparse')&&searchRequests.every(value=>value.injected));
  // 同一无字面词query分别验证合法dense、缺冗余定位恢复和全部位置损坏。
  const noLexicalQuery='nonlexicalneedle';
  const forcedVector=await fetch(provider.env.DATA_AGENT_EMBEDDING_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'qwen3.7-text-embedding',dimensions:1024,input:[noLexicalQuery]})});
  assert.equal(forcedVector.status,200);
  const noLexicalEmbedding=(await forcedVector.json()).data[0].embedding;
  const tail=original.find(record=>{
    const source=[...library.entries[0].effective_value];
    return source.slice(record.char_offset,record.char_offset+record.char_length).join('').includes(libraryRule);
  });
  assert.ok(tail);
  assert.ok(!JSON.stringify(library).includes(noLexicalQuery));
  assert.deepEqual(original.map(record=>record.char_offset).sort((a,b)=>a-b),[0,280,560,840,1120,1400,1680,1960,2240],
    '合成原文有九个规范窗口；反向向量只降低排名，不从候选中删除窗口');
  const denseRecords=original.map(record=>({...record,vector:noLexicalEmbedding.map(value=>-value)}));
  await milvus('entities/upsert',{data:denseRecords.map(record=>record.id===tail.id?{...record,vector:noLexicalEmbedding}:record)});
  const canonicalDense=await invoke('search_knowledge',{query:noLexicalQuery,limit:1,related_object_id:library.id});
  const {actual:canonicalObject,excerpt:canonicalExcerpt}=assertExcerpt(canonicalDense,library,libraryRule);
  assert.equal(canonicalObject.retrieval.channel,'vector');
  assert.equal(canonicalDense.search_coverage.candidate_count,9);
  assert.equal(canonicalDense.search_coverage.channels.lexical.completed,1);
  assert.equal(canonicalDense.search_coverage.channels.lexical.shards,1);
  assert.equal(canonicalDense.search_coverage.channels.lexical.exhausted,true);
  const missingDense={...legacy.find(record=>record.id===tail.id),vector:noLexicalEmbedding};
  await milvus('entities/upsert',{data:[missingDense]});
  const restoredDense=await invoke('search_knowledge',{query:noLexicalQuery,limit:1,related_object_id:library.id});
  const {actual:restoredObject,excerpt:restoredExcerpt}=assertExcerpt(restoredDense,library,libraryRule);
  assert.equal(restoredObject.retrieval.channel,'vector','健康空BM25不能借SQL掩盖稳定键恢复');
  assert.equal(restoredDense.search_coverage.candidate_count,9);
  assert.equal(restoredDense.search_coverage.channels.lexical.completed,1);
  assert.equal(restoredDense.search_coverage.channels.lexical.shards,1);
  assert.equal(restoredDense.search_coverage.channels.lexical.exhausted,true);
  assert.deepEqual(restoredExcerpt,canonicalExcerpt);
  assert.equal((await records(library.id)).find(record=>record.id===tail.id).entry_id,undefined,'查询不修写索引');
  await milvus('entities/upsert',{data:denseRecords.map(record=>({...record,char_offset:999999,
    vector:record.id===tail.id?noLexicalEmbedding:record.vector}))});
  const noLexical=await invoke('search_knowledge',{query:noLexicalQuery,limit:1,related_object_id:library.id});
  assert.deepEqual(noLexical.objects,[],'目标所有位置均非法时不能伪造目录正文或摘录');
  assert.equal(noLexical.search_coverage.candidate_count,9);
  assert.equal(noLexical.search_coverage.state,'bounded');
  assert.equal(noLexical.search_coverage.channels.lexical.completed,1);
  assert.equal(noLexical.search_coverage.channels.lexical.shards,1);
  assert.equal(noLexical.search_coverage.channels.lexical.exhausted,true);
  const knownReread=await invoke('read_knowledge',{object_id:library.id,version:library.version,
    entry_id:'body',offset:canonicalExcerpt.offset,limit:canonicalExcerpt.length});
  assert.equal(knownReread.entries[0].effective_value,canonicalExcerpt.text);
  await milvus('entities/upsert',{data:legacy});
  const embeddingsBefore=provider.requests.length;
  ok(await h.request('/knowledge-index/rebuilds',{operation_id:randomUUID()}));
  await h.resumeWorker();await waitIndexed([laboratory.id,library.id,distractor.id]);await h.pauseWorker();
  assert.equal(provider.requests.length,embeddingsBefore,'metadata repair reuses original embedding receipts');
  assert.ok((await records(library.id)).every(value=>value.entry_id==='body'));
  assertExcerpt(await search(libraryRule),library,libraryRule);
  checks.push('未知键与显式越界不制造正文且成功BM25不加SQL票；整路故障时原SQL词法独立回源；无字面词dense合法/缺定位/坏位置正反控及同版补读，受控重建复用原向量回执');

  const statementFixture=ok(await h.request('/knowledge',{operation_id:randomUUID(),kind:'metric',
    name:'陈述定位合成资料',body:'初始化',source_url:null,related_ids:[]}));
  const statementSupport=ok(await h.request('/knowledge',{operation_id:randomUUID(),kind:'term',
    name:'陈述合成前提',body:'设备须完成双人复核。',source_url:null,related_ids:[]}));
  const statementEarlier='背景🌏。'.repeat(175),statementCondition=statementSupport.entries[0].effective_value;
  const statementText='停用后的合成设备不得继续计入有效设备数。'+statementCondition;
  const statementScope='仅适用已完成复检的设备。',statementBody=statementText+'\n'+statementScope;
  const statementRendered=statementEarlier+'\n\n'+statementBody,statementBase=[...statementEarlier].length+2;
  const statementReference={object_id:statementSupport.id,version:statementSupport.version,path:statementSupport.entries[0].path};
  const statementUnits=[
    {statement_id:'earlier-rule',object_ref:{object_id:statementFixture.id,version:'1',path:'rules'},
      text:statementEarlier,scope_text:'',origin:'model_inference',citations:[],supports:[]},
    {statement_id:'selected-rule',object_ref:{object_id:statementFixture.id,version:'1',path:'rules'},
      text:statementText,scope_text:statementScope,origin:'model_inference',citations:[],
      supports:[{support_id:'selected-prerequisite',role:'prerequisite',reference:{kind:'knowledge',ref:statementReference},
        content:statementCondition,embedded_in:{field:'text',locator:{offset:[...statementText].length-[...statementCondition].length,
          length:[...statementCondition].length}}}]}
  ];
  statementFixture.entries=[{entry_id:'rules',path:'rules',label:'规则',effective_value:statementRendered,
    source_facts:{complete:false,gap:'独立合成陈述映射'},suggestion:{value:statementRendered,statements:statementUnits},
    human_override:null,review_state:'unverified'}];
  const statementHex=Buffer.from(JSON.stringify(statementFixture)).toString('hex');
  h.sql(`UPDATE knowledge_objects SET body=CAST(CONVERT(0x${statementHex} USING utf8mb4) AS JSON) WHERE id='${statementFixture.id}';
    UPDATE knowledge_versions SET body=CAST(CONVERT(0x${statementHex} USING utf8mb4) AS JSON) WHERE object_id='${statementFixture.id}' AND version=1;
    UPDATE knowledge_dependency_states SET mapping_state='unknown' WHERE owner_id='${statementFixture.id}' AND owner_version=1;
    INSERT INTO knowledge_statements(object_id,version,statement_id,space_id,entry_path,layer,body)
      SELECT '${statementFixture.id}',1,JSON_UNQUOTE(JSON_EXTRACT(s.value,'$.statement_id')),'demo','rules','model_suggestion',s.value
      FROM JSON_TABLE(CAST(CONVERT(0x${statementHex} USING utf8mb4) AS JSON),'$.entries[0].suggestion.statements[*]' COLUMNS(value JSON PATH '$')) s`);
  await h.resumeWorker();await waitIndexed([statementFixture.id,statementSupport.id]);await h.pauseWorker();
  const statementRecords=await records(statementFixture.id),statementRow=statementRecords.find(row=>row.statement_id==='selected-rule');
  assert.equal(statementRecords.length,4,'700字符背景占三个规范窗口，短目标陈述独占一个窗口');
  assert.ok(statementRow);assert.equal(statementRow.char_offset,statementBase);assert.equal(statementRow.statement_offset,0);
  assert.equal(statementRow.char_length,[...statementBody].length);
  const statementQuery='statementnonlexicalprobe';assert.ok(!JSON.stringify(statementFixture).includes(statementQuery));
  const statementEmbeddingResponse=await fetch(provider.env.DATA_AGENT_EMBEDDING_URL,{method:'POST',
    headers:{'content-type':'application/json'},body:JSON.stringify({model:'qwen3.7-text-embedding',dimensions:1024,input:[statementQuery]})});
  assert.equal(statementEmbeddingResponse.status,200);
  const statementEmbedding=(await statementEmbeddingResponse.json()).data[0].embedding;
  const statementDenseRows=statementRecords.map(row=>({...row,vector:row.id===statementRow.id?statementEmbedding:statementEmbedding.map(value=>-value)}));
  await milvus('entities/upsert',{data:statementDenseRows});
  const statementArgs={query:statementQuery,limit:1,related_object_id:statementFixture.id};
  const assertStatement=result=>{
    const {actual,excerpt}=assertExcerpt(result,statementFixture,statementText,'rules');
    assert.equal(actual.retrieval.channel,'vector');assert.equal(excerpt.text,statementBody);
    assert.equal(excerpt.offset,statementBase);assert.equal(excerpt.total_chars,[...statementRendered].length);
    assert.equal(result.search_coverage.candidate_count,4);
    assert.equal(result.search_coverage.channels.lexical.completed,1);
    assert.equal(result.search_coverage.channels.lexical.shards,1);
    assert.equal(result.search_coverage.channels.lexical.exhausted,true,'真实BM25成功空且未追加SQL票');
    const authority=h.sql(`SELECT authority_snapshot FROM agent_runs WHERE id='${run.run_id}'`)[0];
    assert.deepEqual(authority.knowledge.filter(reference=>reference[0]===statementSupport.id),
      [[statementSupport.id,statementSupport.version]],'实际可见陈述的内嵌支持保留登记');
    return excerpt;
  };
  const statementCanonical=assertStatement(await invoke('search_knowledge',statementArgs));
  for(const fields of [['statement_offset'],['statement_id'],['statement_id','statement_offset']]){
    const missing=Object.fromEntries(Object.entries(statementDenseRows.find(row=>row.id===statementRow.id))
      .filter(([key])=>!fields.includes(key)));
    await milvus('entities/upsert',{data:[missing]});
    assert.deepEqual(assertStatement(await invoke('search_knowledge',statementArgs)),statementCanonical);
    const stored=(await records(statementFixture.id)).find(row=>row.id===statementRow.id);
    for(const field of fields)assert.equal(stored[field],undefined,'搜索只恢复本次定位，不修写索引');
  }
  const statementConflict=Object.fromEntries(Object.entries(statementDenseRows.find(row=>row.id===statementRow.id))
    .filter(([key])=>key!=='statement_id'));
  statementConflict.statement_offset=1;
  await milvus('entities/upsert',{data:[statementConflict]});
  const statementRejected=await invoke('search_knowledge',statementArgs);
  assert.ok(statementRejected.objects.every(object=>
    object.entries.every(entry=>!entry.effective_value.includes(statementBody))
    &&object.retrieval.excerpts.every(excerpt=>!excerpt.text.includes(statementBody))),
    '缺statement_id不能掩盖显式冲突的statement_offset，原record不得交付该陈述');
  assert.equal(statementRejected.search_coverage.candidate_count,4);
  assert.equal(statementRejected.search_coverage.state,'bounded');
  assert.equal(statementRejected.search_coverage.channels.lexical.completed,1);
  assert.equal(statementRejected.search_coverage.channels.lexical.shards,1);
  assert.equal(statementRejected.search_coverage.channels.lexical.exhausted,true);
  assert.ok(statementRejected.objects.every(object=>object.retrieval.excerpts.every(excerpt=>
    excerpt.entry_id!=='rules'||excerpt.offset<statementBase)),'拒绝的陈述不能由坏索引窗口旁路交付');
  const statementReread=await invoke('read_knowledge',{object_id:statementFixture.id,version:statementFixture.version,
    entry_id:'rules',offset:statementBase,limit:[...statementBody].length});
  assert.equal(statementReread.entries[0].effective_value,statementBody);
  await milvus('entities/upsert',{data:statementRecords});
  checks.push('真实dense陈述缺冗余定位保原窗口及支持；缺身份不丢显式冲突坐标，健康空BM25不加SQL，原ref仍可补读');

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

  // 真实>129段：知识对象body上限10万字符（约80段）不足以覆盖129段之后，
  // 改用平台来源——其正文由catalog的comment/ddl/columns组装，不受该上限约束。
  // 切块目标1200字符/段，约34万字符正文产生280+段、跨多个BATCH_SIZE批次；
  // 末段独有标记必须进入索引并可按定位读回。
  const manySegmentsTail='超长资料末段专有标记：分段批次推进校准词。';
  const manySegmentsComment=Array.from({length:12000},(_,i)=>`第${i}节常规业务说明，用于把正文推到数百段规模。`).join('\n')+'\n'+manySegmentsTail;
  await writeFile(h.directory+'/platform/catalog.json',JSON.stringify({source_namespace:'synthetic-segments',authoritative:true,tables:[
    {id:'many_segments_source',name:'many_segments_source',platform_version:'1',comment:manySegmentsComment,ddl:'CREATE TABLE many_segments_source (record_id INTEGER);',columns:[{id:'record_id',name:'record_id',data_type:'INTEGER',nullable:false,comment:'记录技术编号'}],node:{id:'load-many-segments',sql:'INSERT INTO many_segments_source SELECT record_id FROM synthetic_source;',upstream_ids:['synthetic_source']}},
  ]}));
  const sync=await synchronizeSources(h);
  assert.equal(sync.value.status,'completed',JSON.stringify(sync.value));
  // 来源同步只落source_current；原文摘录目标由主worker的统一消费者建立并推进。
  await h.resumeWorker();
  // catalog导入把表登记为知识对象catalog-{sha}，原文目标跟随该来源id；按
  // source_current里该表的实际来源身份定位，不假定等于表名。
  const sourceKey=(()=>{const rows=h.sql(`SELECT JSON_OBJECT('id',source_id) FROM knowledge_objects WHERE source_id LIKE 'catalog-%' AND JSON_UNQUOTE(JSON_EXTRACT(body,'$.name'))='many_segments_source'`);return rows[0]?.id;})();
  assert.ok(sourceKey,'catalog导入必须把超长表登记为知识对象');
  await until(()=>{
    const row=h.sql(`SELECT JSON_OBJECT('total',COUNT(*),'open',SUM(vector_state<>'indexed')) FROM knowledge_index_jobs WHERE target_kind='source_excerpt' AND source_kind='platform' AND object_id='${sourceKey}'`)[0];
    return Number(row.total)>0&&Number(row.open)===0;
  },'超长平台来源完成索引',300000);
  await h.pauseWorker();
  const segmentRows=await milvus('entities/query',{filter:`kind == "source_excerpt" && source_kind == "platform" && object_id == "${sourceKey}"`,outputFields:['id','object_id','object_version','char_offset','char_length','text','content_hash'],limit:1024,consistencyLevel:'Strong'});
  assert.ok(segmentRows.length>129,'真实分段数必须超过129：'+segmentRows.length);
  const tailRow=segmentRows.find(row=>(row.text||'').includes('分段批次推进校准词'));
  assert.ok(tailRow,'末段标记必须进入摘录索引：'+JSON.stringify(segmentRows.slice(-2).map(r=>[r.char_offset,r.char_length])));
  const sourceLength=h.sql(`SELECT JSON_OBJECT('len',CHAR_LENGTH(body)) FROM source_current WHERE source_id='${sourceKey}'`)[0]?.len;
  assert.ok(sourceLength>300000,'平台来源正文规模须远超10万知识对象上限：'+sourceLength);
  const tailCovered=Math.max(...segmentRows.map(row=>Number(row.char_offset)+Number(row.char_length)));
  assert.ok(tailCovered>=sourceLength-64,'末段覆盖推进到正文终点：'+tailCovered+'/'+sourceLength);
  // 投影进度同样推进到正文终点（complete=true且applied_position为全长）。
  const projection=h.sql(`SELECT JSON_OBJECT('complete',complete,'position',applied_position) FROM retrieval_source_projections WHERE source_kind='platform' AND source_id='${sourceKey}' ORDER BY revision DESC LIMIT 1`)[0];
  assert.equal(projection.complete,1,JSON.stringify(projection));
  assert.ok(Number(projection.position)>=sourceLength-64,'投影进度到正文终点：'+JSON.stringify(projection));
  // v1检索不交付raw摘录（可交付类型前置），因此这里只断言索引事实，不冒称
  // 该平台来源已经可被search_knowledge召回——raw公开分支归06。
  // 超长来源索引耗时超过运行租约，工具调用身份已过期；改走同一条v1浏览检索
  // 路径（include_raw同样为false），断言交付面而非依赖旧run。
  const rawGuardMany=await search('分段批次推进校准词');
  assert.ok(rawGuardMany.objects.every(value=>value.id!==sourceKey),'v1不交付raw摘录来源');
  checks.push('真实280+段平台来源：末段独有标记入索引、摘录覆盖与投影进度都推进到正文终点，v1不交付raw');
  passed=true;console.log(JSON.stringify({passed,checks,officialRequests:0}));
} finally {
  await h?.close();
  proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));
  if((await milvus('collections/has')).has)await milvus('collections/drop');
  await provider.close();
  await writeFile('.local/checks/retrieval-excerpts.json',JSON.stringify({passed,checks,officialRequests:0},null,2));
}

import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness,until} from './harness.mjs';

const requests=[],checks=[],payloadBytes=[];
let release,block=false,passed=false,h;
const provider=createServer(async(req,res)=>{
 let raw='';req.setEncoding('utf8');for await(const chunk of req)raw+=chunk;
 const material=JSON.parse(JSON.parse(raw).messages[1].content);requests.push(material);payloadBytes.push(Buffer.byteLength(raw));assert.ok(Buffer.byteLength(raw)<=65536);
 if(block){block=false;await new Promise(r=>release=r);}
 const evidence=material.sources.filter(s=>s.body).map(s=>({source_id:s.source_id,version:s.version,location:'L1',quote:s.body.split('\n')[0].slice(0,60)}));
 const entries=material.object.entries.map(e=>({entry_id:e.entry_id,value:`合成解释：${e.path}`,gaps:['税费规则尚未提供'],evidence:evidence.slice(0,20)}));
 res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{type:'function',function:{name:'submit_semantic_prefill',arguments:JSON.stringify({entries})}}]}}],usage:{prompt_tokens:100,completion_tokens:200}}));
});await new Promise(r=>provider.listen(0,'127.0.0.1',r));
const profile={provider_id:'deepseek',model_id:'deepseek-flash',trial_id:randomUUID(),price_version:'2026-10-04-peak-usd',input_limit:32768,output_limit:4096,trial_call_limit:40,trial_cost_micros:'500000',request_call_limit:12,toolset:'data',payload_bytes_limit:65536};
const column={id:'amount',name:'amount',data_type:'INTEGER',nullable:false,comment:''};
const table=(id,version='1',upstream=[])=>({id,name:id,platform_version:version,comment:'',columns:[column],ddl:`CREATE TABLE ${id}(amount INTEGER NOT NULL);`,node:{id:'load-'+id,sql:`INSERT INTO ${id} SELECT amount FROM raw_value; -- generation ${version}`,upstream_ids:upstream}});
try{
 h=await harness({capture:true,env:{DATA_AGENT_LEASE_MS:'120000',DATA_AGENT_PREFILL_PROFILE:JSON.stringify(profile),DATA_AGENT_PREFILL_TEST:'1',DATA_AGENT_PREFILL_URL:'http://127.0.0.1:'+provider.address().port}});
 await h.pauseWorker();
 // 下游位于首个目录页，上游在末页；其余表只是分页填充。
 const rows=[table('derived_values','1',['raw_values']),...Array.from({length:49},(_,i)=>table('filler_'+i)),table('raw_values')];
 const sync=async()=>{await writeFile(h.directory+'/platform/catalog.json',JSON.stringify({source_namespace:'prefill-materials',authoritative:true,tables:rows}));const r=await h.request('/source-syncs',{operation_id:randomUUID()});assert.equal(r.status,200,JSON.stringify(r.value));};
 await sync();
 const objects=h.sql("SELECT body FROM knowledge_objects WHERE source_id LIKE 'catalog-%'");
 const target=objects.find(o=>o.name==='derived_values'),upstream=objects.find(o=>o.name==='raw_values');
 const doc=(await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'合成金额单位说明',body:'amount 以元保存；业务日按 Asia/Shanghai 划分。',related_ids:[target.id,upstream.id],source_url:null})).value;
 const fieldDoc=(await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'上游字段解释',body:'上游 amount 是原始金额，未进行币种换算。',related_ids:[objects.find(o=>o.name==='raw_values.amount').id],source_url:null})).value;
 const read=async id=>(await h.request('/knowledge/'+id)).value;
 const reanalyze=async()=>{const v=await read(target.id);const r=await h.request('/knowledge/'+target.id+'/reanalyze',{operation_id:randomUUID(),expected_version:v.version});assert.equal(r.status,200);return r.value;};
 const wait=async(state)=>until(async()=>{const v=await read(target.id);return v.prefill_status?.state===state?v:false;},'资料预填 '+state,45000);
 await reanalyze();await h.resumeWorker();let current=await wait('succeeded');
 const input=requests.find(r=>r.object.id===target.id&&!r.draft);
 assert.ok(input.sources.some(s=>s.source_id===upstream.source_id&&s.body.includes('CREATE TABLE raw_values')));
 assert.ok(input.sources.some(s=>s.source_id==='document-'+doc.id&&s.version===doc.version&&s.body.includes('以元保存')));
 assert.ok(input.sources.some(s=>s.source_id==='document-'+fieldDoc.id&&s.body.includes('未进行币种换算')));
 assert.equal(input.coverage.state,'complete');assert.ok(input.object.entries.length>3);
 assert.ok(current.entries.filter(e=>!['ddl','etl','lineage','type'].includes(e.path)).every(e=>e.suggestion.gaps.includes('税费规则尚未提供')));
 assert.deepEqual(requests[1].sources,requests[0].sources);
 checks.push('普通目录多条目分析带齐同批上游及关联文档；两阶段固定同版资料并保存缺口');

 const cid=await h.create(),run=await h.capture(cid,'解释这张合成表');
 const manager=SessionManager.inMemory('/synthetic/data-agent');
 const invoke=async(name,args)=>{
  const input={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:randomUUID(),tool_name:name,arguments:args,checkpoint:exportCheckpoint(manager,run.workspace_context.authority_revision,run.workspace_context.authority_snapshot)};
  assert.equal((await h.internal('/internal/data/tool-calls',input)).status,200);
  return h.internal('/internal/data/tools',input);
 };
 let r=await invoke('search_knowledge',{query:'derived_values',limit:10});assert.equal(r.status,200);assert.ok(JSON.stringify(r.value).includes(target.id));
 r=await invoke('read_knowledge',{object_id:target.id,version:current.version,entry_id:'description'});assert.equal(r.status,200);
 let details=JSON.parse(r.value.data.entries[0].suggestion.details);assert.ok(details.gaps.includes('税费规则尚未提供'));assert.ok(details.evidence.some(e=>e.source_id==='document-'+doc.id));
 r=await invoke('read_source',{source_id:'document-'+doc.id,version:doc.version});assert.equal(r.status,200);assert.equal(r.value.data.body,'amount 以元保存；业务日按 Asia/Shanghai 划分。');
 checks.push('文档引用在搜索、知识工具正文和来源工具三条路径均可读');

 await h.pauseWorker();
 const human=await h.request('/knowledge/'+target.id,{operation_id:randomUUID(),expected_version:current.version,entry_id:'description',value:'人工有效定义'},'alice','PATCH');assert.equal(human.status,200);
 await reanalyze();await h.resumeWorker();current=await wait('succeeded');
 assert.equal(current.entries[0].effective_value,'人工有效定义');
 r=await invoke('read_knowledge',{object_id:target.id,version:current.version,entry_id:'description'});assert.equal(r.status,200);
 details=JSON.parse(r.value.data.entries[0].suggestion.details);assert.equal(details.value,'合成解释：description');assert.equal(r.value.data.entries[0].suggestion.application,'pending_review');
 checks.push('人工有效值保留，候选解释、候选缺口与依据一起回传并标记未采用');

 block=true;await reanalyze();await until(()=>release,'预填等待文档改版');
 const changed=await h.request('/knowledge/'+doc.id,{operation_id:randomUUID(),expected_version:doc.version,entry_id:'body',value:'amount 以元保存；新版只适用于已支付记录。'},'alice','PATCH');assert.equal(changed.status,200);
 release();release=undefined;await wait('superseded');
 assert.equal((await invoke('read_source',{source_id:'document-'+doc.id,version:doc.version})).value.code,'stale_knowledge');
 checks.push('模型进行期间文档改版，旧建议不采用，旧来源版本不可继续读');

 await reanalyze();current=await wait('succeeded');
 assert.equal((await h.request('/knowledge/'+doc.id+'/disable',{operation_id:randomUUID(),expected_version:changed.value.version})).status,200);
 r=await invoke('read_knowledge',{object_id:target.id,version:current.version});assert.equal(r.value.code,'stale_knowledge');
 const search=(await h.request('/knowledge?q=derived_values')).value;assert.ok(!search.objects.some(o=>o.id===target.id));
 checks.push('文档停用后引用它的知识无法继续用于读取或检索');

 // 自动重分析的下游先入库，上游在第二页更新；冻结时必须使用第二页新版本。
 await h.pauseWorker();rows[0]=table('derived_values','2',['raw_values']);rows[50]=table('raw_values','2');await sync();await h.resumeWorker();current=await wait('succeeded');
 const auto=requests.filter(r=>r.object.id===target.id&&!r.draft).at(-1);
 assert.ok(auto.sources.some(s=>s.source_id===upstream.source_id&&s.version==='2'&&s.body.includes('generation 2')));
 checks.push('同批目录后续页上游改版进入自动预填，不使用首个页面时的旧版本');

 await h.pauseWorker();
 const sourceDocument=h.sql("SELECT body FROM knowledge_objects WHERE kind='document' AND source_id IS NOT NULL ORDER BY id LIMIT 1")[0];
 assert.ok(sourceDocument);
 const queuedDoc=await h.request('/knowledge/'+sourceDocument.id+'/reanalyze',{operation_id:randomUUID(),expected_version:sourceDocument.version});assert.equal(queuedDoc.status,200);
 const material=h.sql(`SELECT input_json FROM prefill_attempts WHERE object_id='${sourceDocument.id}' ORDER BY created_at DESC LIMIT 1`)[0];assert.ok(!material.sources.some(s=>s.source_id==='document-'+sourceDocument.id));
 await h.resumeWorker();await until(async()=>{const v=await read(sourceDocument.id);return v.prefill_status?.state==='succeeded';},'文档重分析完成',45000);
 assert.ok((await h.request('/knowledge?q='+encodeURIComponent(sourceDocument.name))).value.objects.some(o=>o.id===sourceDocument.id));
 checks.push('重分析有来源文档后仍可检索，不将其自身旧正文作为依据');
 await h.pauseWorker();
 const long=(await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'长合成业务文档',body:'未知税费。'.repeat(6000),related_ids:[target.id],source_url:null})).value;
 await reanalyze();const queued=h.sql(`SELECT input_json FROM prefill_attempts WHERE object_id='${target.id}' ORDER BY created_at DESC LIMIT 1`)[0];
 assert.equal(queued.coverage.state,'incomplete');const longSource=queued.sources.find(s=>s.source_id==='document-'+long.id);assert.equal(longSource.complete,false);assert.ok(longSource.body.length>0);assert.ok(queued.coverage.gaps.some(g=>g.reason==='body_limit'));
 assert.ok(queued.sources.reduce((n,s)=>n+Buffer.byteLength(s.body),0)<=24576);
 checks.push('资料超限保留明确缺口和非空文档片段，未将截断当全文');
 rows[0]=table('derived_values','3',['raw_values']);rows[0].ddl+='\n-- '+ '长DDL说明'.repeat(6000);await sync();await h.resumeWorker();await wait('succeeded');
 const large=requests.filter(r=>r.object.id===target.id&&!r.draft).at(-1);
 assert.equal(large.coverage.state,'incomplete');assert.ok(large.object.metadata.filter(e=>['ddl','etl'].includes(e.path)).every(e=>!('quote' in e.source_facts)&&!('value' in e.source_facts)));
 assert.ok(payloadBytes.every(n=>n<=65536));
 checks.push('长DDL与长文档的重复正文不藏在metadata，分析/复核请求均受完整请求体上限约束');
 passed=true;console.log(JSON.stringify({passed,checks,calls:requests.length,officialRequests:0}));
}finally{release?.();if(h)await h.close();await new Promise(r=>provider.close(r));await writeFile('.local/checks/mvp-prefill-materials.json',JSON.stringify({passed,checks,calls:requests.length,officialRequests:0},null,2));}

import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness} from './harness.mjs';

const h=await harness({capture:true,env:{DATA_AGENT_LEASE_MS:'120000'}});
const checks=[];let passed=false;
try {
  await h.pauseWorker();
  const query='coverageonlyneedle';
  const text='覆盖边界：合成设备只有复核通过后才可借出。';
  // 规范候选来自实际正文；过期依赖在元信息阶段排除，避免先耗尽30次正文读取。
  const staleEntry={entry_id:'body',path:'body',label:'正文',effective_value:text,source_facts:{value:text,source_id:'business-guide',version:'0',complete:true},suggestion:{},human_override:null,review_state:'unverified'};
  h.sql(`SET SESSION cte_max_recursion_depth=1200;INSERT INTO knowledge_objects(id,space_id,kind,name,version,state,body,source_id,source_version,updated_by) WITH RECURSIVE n AS (SELECT 1 AS i UNION ALL SELECT i+1 FROM n WHERE i<1000) SELECT CONCAT('coverage-',LPAD(i,4,'0')),'demo','metric','${query}',1,'enabled',JSON_OBJECT('id',CONCAT('coverage-',LPAD(i,4,'0')),'kind','metric','name','${query}','version','1','state','enabled','entries',JSON_ARRAY(CAST('${JSON.stringify(staleEntry)}' AS JSON)),'related_ids',JSON_ARRAY(),'source_id','business-guide','source_version','0','updated_by','test'),'business-guide',0,'test' FROM n`);
  const last={id:'zz-coverage-valid',kind:'metric',name:query+' 后方有效项',version:'1',state:'enabled',entries:[{...staleEntry,source_facts:{complete:false,gap:'独立合成人工内容'},human_override:{value:text,edited_by:'test'},review_state:'confirmed'}],related_ids:[],source_id:null,source_version:'0',updated_by:'test'};
  h.sql(`INSERT INTO knowledge_objects(id,space_id,kind,name,version,state,body,source_id,source_version,updated_by) VALUES('${last.id}','demo','metric','${last.name}',1,'enabled','${JSON.stringify(last)}',NULL,0,'test');INSERT INTO retrieval_documents(object_id,space_id,version,body) SELECT id,space_id,version,body FROM knowledge_objects WHERE id LIKE 'coverage-%' OR id='zz-coverage-valid';INSERT INTO knowledge_versions(object_id,version,body) SELECT id,version,body FROM knowledge_objects WHERE id LIKE 'coverage-%' OR id='zz-coverage-valid';INSERT INTO knowledge_dependency_states(owner_id,owner_version,space_id,mapping_state) SELECT id,version,space_id,'complete' FROM knowledge_objects WHERE id LIKE 'coverage-%' OR id='zz-coverage-valid';INSERT INTO knowledge_dependencies(owner_id,owner_version,space_id,entry_path,layer,purpose,role,effective,target_kind,target_id,target_revision,target_path,target_fingerprint) SELECT id,version,space_id,'body','source_fact','required','origin',TRUE,'platform','business-guide',0,'','' FROM knowledge_objects WHERE id LIKE 'coverage-%'`);
  h.sql("INSERT INTO semantic_ownership(space_id,object_id,authority_id,source,updated_by) SELECT space_id,id,id,'system','test' FROM knowledge_objects WHERE id LIKE 'coverage-%' OR id='zz-coverage-valid'");
  const limited=await h.request('/knowledge?q='+encodeURIComponent(query));
  assert.equal(limited.status,200);assert.equal(limited.value.search_coverage.state,'candidate_limit');assert.equal(limited.value.search_coverage.examined,undefined);assert.equal(limited.value.search_coverage.rejected,undefined);assert.deepEqual(limited.value.objects,[]);
  assert.ok(limited.value.search_coverage.candidate_count>0&&limited.value.search_coverage.candidate_count<=1000);
  assert.equal(limited.value.search_coverage.channels.lexical.rounds,5);
  const precise=await h.request('/knowledge?q='+encodeURIComponent(last.name));assert.equal(precise.status,200);assert.equal(precise.value.objects[0].id,last.id);
  assert.ok(precise.value.objects[0].entries.some(entry=>entry.effective_value===text));
  checks.push({name:'首1000项来源过期时明确返回候选上限；更具体名称仍能找到后方有效项，不把空候选当成不存在',passed:true});
  const cid=await h.create();await h.resumeWorker();const run=await h.capture(cid,'核对覆盖边界');await h.pauseWorker();
  const input={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:randomUUID(),tool_name:'search_knowledge',arguments:{query,limit:10},checkpoint:exportCheckpoint(SessionManager.inMemory('/synthetic/data-agent'))};
  assert.equal((await h.internal('/internal/data/tool-calls',input)).status,200);
  const tool=await h.internal('/internal/data/tools',input);assert.equal(tool.status,200);assert.equal(tool.value.data.search_coverage.state,'candidate_limit');assert.match(tool.value.data.note,/空结果不能证明不存在/);h.releaseRun(run.run_id);
  checks.push({name:'同一覆盖状态送到Pi检索工具，模型可缩小查询或按ID补读',passed:true});
  passed=true;console.log(JSON.stringify({passed,checks,officialRequests:0}));
} finally {await writeFile('.local/checks/mvp-retrieval-coverage.json',JSON.stringify({passed,checks},null,2));await h.close();}

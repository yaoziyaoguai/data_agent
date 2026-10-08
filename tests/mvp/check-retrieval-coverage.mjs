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
  h.sql("SET SESSION cte_max_recursion_depth=1200;INSERT INTO knowledge_objects(id,space_id,kind,name,version,state,body,source_id,source_version,updated_by) WITH RECURSIVE n AS (SELECT 1 AS i UNION ALL SELECT i+1 FROM n WHERE i<1000) SELECT CONCAT('coverage-',LPAD(i,4,'0')),'demo','metric','覆盖边界',1,'enabled',JSON_OBJECT('id',CONCAT('coverage-',LPAD(i,4,'0')),'kind','metric','name','覆盖边界','version','1','state','enabled','entries',JSON_ARRAY(),'related_ids',JSON_ARRAY(),'source_id','business-guide','source_version','0','updated_by','test'),'business-guide',0,'test' FROM n");
  const last={id:'zz-coverage-valid',kind:'metric',name:'覆盖边界 后方有效项',version:'1',state:'enabled',entries:[],related_ids:[],source_id:null,source_version:'0',updated_by:'test'};
  h.sql(`INSERT INTO knowledge_objects(id,space_id,kind,name,version,state,body,source_id,source_version,updated_by) VALUES('${last.id}','demo','metric','${last.name}',1,'enabled','${JSON.stringify(last)}',NULL,0,'test');INSERT INTO retrieval_documents(object_id,space_id,version,body) SELECT id,space_id,version,body FROM knowledge_objects WHERE id LIKE 'coverage-%' OR id='zz-coverage-valid'`);
  h.sql("INSERT INTO semantic_ownership(space_id,object_id,authority_id,source,updated_by) SELECT space_id,id,id,'system','test' FROM knowledge_objects WHERE id LIKE 'coverage-%' OR id='zz-coverage-valid'");
  const limited=await h.request('/knowledge?q='+encodeURIComponent('覆盖边界'));
  assert.equal(limited.status,200);assert.equal(limited.value.search_coverage.state,'candidate_limit');assert.equal(limited.value.search_coverage.examined,undefined);assert.equal(limited.value.search_coverage.rejected,undefined);assert.deepEqual(limited.value.objects,[]);
  const precise=await h.request('/knowledge?q='+encodeURIComponent(last.name));assert.equal(precise.status,200);assert.equal(precise.value.objects[0].id,last.id);
  checks.push({name:'首1000项来源过期时明确返回候选上限；更具体名称仍能找到后方有效项，不把空候选当成不存在',passed:true});
  const cid=await h.create();await h.resumeWorker();const run=await h.capture(cid,'核对覆盖边界');await h.pauseWorker();
  const input={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:randomUUID(),tool_name:'search_knowledge',arguments:{query:'覆盖边界',limit:10},checkpoint:exportCheckpoint(SessionManager.inMemory('/synthetic/data-agent'))};
  assert.equal((await h.internal('/internal/data/tool-calls',input)).status,200);
  const tool=await h.internal('/internal/data/tools',input);assert.equal(tool.status,200);assert.equal(tool.value.data.search_coverage.state,'candidate_limit');assert.match(tool.value.data.note,/空结果不能证明不存在/);h.releaseRun(run.run_id);
  checks.push({name:'同一覆盖状态送到Pi检索工具，模型可缩小查询或按ID补读',passed:true});
  passed=true;console.log(JSON.stringify({passed,checks,officialRequests:0}));
} finally {await writeFile('.local/checks/mvp-retrieval-coverage.json',JSON.stringify({passed,checks},null,2));await h.close();}

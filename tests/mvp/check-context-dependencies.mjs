import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness} from './harness.mjs';
const h=await harness({capture:true,env:{DATA_AGENT_LEASE_MS:'120000'}}),manager=SessionManager.inMemory('/synthetic/data-agent');
let run,passed=false;const checks=[];
const invoke=async(name,args,max_bytes,expectedStatus=200)=>{
 const input={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:randomUUID(),tool_name:name,arguments:args,checkpoint:exportCheckpoint(manager)};
 const registered=await h.internal('/internal/data/tool-calls',input);
 assert.equal(registered.status,200,JSON.stringify(registered.value));const r=await h.internal('/internal/data/tools',max_bytes===undefined?input:{...input,response_budget:{max_bytes,estimated_tokens:max_bytes,projection_fingerprint:'0'.repeat(64)}});assert.equal(r.status,expectedStatus,JSON.stringify(r.value));return expectedStatus===200?r.value.data:r.value;
};
const issue=()=>h.internal('/internal/model/issue',{run_id:run.run_id,lease_epoch:run.lease_epoch,call_attempt_id:randomUUID()});
const finish=async(text='已核对')=>{
 await invoke('update_analysis_task',{action:'route',task_id:null,expected_version:null,goal:'',question:null,options:[]});
 assert.equal((await h.internal('/internal/outputs',{run_id:run.run_id,lease_epoch:run.lease_epoch,chunk_seq:'1',text})).status,200);
 assert.equal((await h.internal('/internal/finish',{run_id:run.run_id,lease_epoch:run.lease_epoch,commit_id:run.output_id,final_text:text,checkpoint:exportCheckpoint(manager)})).status,200);h.releaseRun(run.run_id);
};
try{
 const assets=[];
 for(let i=0;i<24;i++)assets.push((await h.request('/assets',{operation_id:randomUUID(),id:null,expected_version:null,kind:'memory',name:'合成偏好'+i,body:'合成展示偏好'+i,scope:'仅本人展示',verified:false,source_text:'本人录入',dependencies:[]})).value);
 const cid=await h.create();run=await h.capture(cid,'读取相关表');await h.pauseWorker();
 const delivered=run.workspace_context.memories.map(v=>v.id),omitted=assets.find(v=>!delivered.includes(v.id));assert.ok(omitted);
 assert.ok(delivered.length>0,'拥有者能看到当前已交付的记忆');
 assert.deepEqual(new Set(run.workspace_context.authority_snapshot.memories.map(v=>v[0])),new Set(delivered));
 assert.equal((await h.request('/assets/'+omitted.id+'/disable',{operation_id:randomUUID(),expected_version:omitted.version})).status,200);
 assert.equal((await issue()).status,200);
 checks.push('工作区只登记实际交付的记忆，被裁掉的记忆停用不影响会话');
 const adopted = await invoke('read_knowledge',{items:['table-demo_order_detail','table-raw_payments'].map(object_id=>({kind:'knowledge',ref:{object_id,version:'1',path:'ddl'}}))});
 assert.deepEqual(adopted.items.map(item=>item.state),['ok','ok']);
 await finish('旧资料结论-A');
 const unused=(await h.request('/knowledge/table-customer_tags')).value;assert.equal((await h.request('/knowledge/'+unused.id+'/disable',{operation_id:randomUUID(),expected_version:unused.version})).status,200);
 await h.resumeWorker();run=await h.capture(cid,'继续聊另一个问题');await h.pauseWorker();
 assert.ok(run.checkpoint);const refs=run.workspace_context.authority_snapshot.knowledge;
 assert.ok(refs.some(v=>v[0]==='table-demo_order_detail'));assert.ok(refs.some(v=>v[0]==='table-raw_payments'));assert.ok(!refs.some(v=>v[0]===unused.id));assert.equal((await issue()).status,200);
 const consumed=(await h.request('/knowledge/table-demo_order_detail')).value;
 assert.equal((await h.request('/knowledge/'+consumed.id+'/disable',{operation_id:randomUUID(),expected_version:consumed.version})).status,200);
 const withdrawn=await invoke('read_knowledge',{items:[{kind:'knowledge',ref:{object_id:consumed.id,version:consumed.version,path:'ddl'}}]});
 assert.equal(withdrawn.items[0].state,'not_available');
 assert.equal((await issue()).status,200);
 checks.push('跨轮保留Pi检查点的早期读取依赖；无关改版不重建，资料撤回后读取不可用');
 assert.equal((await h.request('/conversations/'+cid+'/messages/'+run.message_id+'/withdraw',{operation_id:randomUUID()})).status,200);h.releaseRun(run.run_id);
 h.sql(`UPDATE pi_checkpoints SET checkpoint=JSON_REMOVE(checkpoint,'$.authority_snapshot.dependency_schema') WHERE recovery_chain_id IN (SELECT recovery_chain_id FROM conversation_messages WHERE conversation_id='${cid}')`);
 await h.resumeWorker();run=await h.capture(cid,'重新调查新问题');await h.pauseWorker();assert.equal(run.checkpoint,null);assert.equal(run.workspace_context.authority_snapshot.dependency_schema,6);assert.equal((await issue()).status,200);
 checks.push('旧检查点没有完整依赖清单时新输入重建，不把缺失清单当空依赖通过');
 await finish();await h.resumeWorker();run=await h.capture(cid,'重建后的下一轮继续');await h.pauseWorker();
 assert.ok(run.checkpoint);assert.ok(!JSON.stringify(run.workspace_context.recent_messages).includes('旧资料结论-A'));assert.ok(run.workspace_context.recent_messages.every(v=>v.role==='user'));assert.ok(!run.workspace_context.authority_snapshot.knowledge.some(v=>v[0]==='table-demo_order_detail'));
 checks.push('重建完成后的后续轮次也不会从短历史重新混入旧助手结论，助手历史沿用Pi检查点');
 await finish();
 // 格式5旧检查点（带完整桶、无历史桶）按旧形状解码保留，不强制重建（04切片8）
 h.sql(`UPDATE pi_checkpoints SET checkpoint=JSON_REMOVE(checkpoint,'$.authority_snapshot.historical_analyses') WHERE recovery_chain_id='${run.recovery_chain_id}'`);
 h.sql(`UPDATE pi_checkpoints SET checkpoint=JSON_SET(checkpoint,'$.authority_snapshot.dependency_schema',5) WHERE recovery_chain_id='${run.recovery_chain_id}'`);
 await h.resumeWorker();run=await h.capture(cid,'旧格式五检查点继续');await h.pauseWorker();
 assert.ok(run.checkpoint);const resumedSchema=run.workspace_context.authority_snapshot;
 assert.ok(resumedSchema.dependency_schema===5||(resumedSchema.dependency_schema===6&&Array.isArray(resumedSchema.historical_analyses)&&resumedSchema.historical_analyses.length===0),`格式5解码后只允许原样保留或带空历史桶升级到6，实际schema=${resumedSchema.dependency_schema} hist=${JSON.stringify(resumedSchema.historical_analyses)}`);assert.equal((await issue()).status,200);await finish();
 checks.push('dependency_schema=5旧快照保留解码且恢复不重建：后续写入按需升级到6并携带空历史桶，不给旧记录追加required');
 // 新写入快照未使用历史投影也带空数组；格式6缺历史桶按不完整保守重建
 const fresh=await h.create();await h.resumeWorker();run=await h.capture(fresh,'新格式空历史桶');await h.pauseWorker();await finish();
 await h.resumeWorker();run=await h.capture(fresh,'新格式空历史桶下一轮');await h.pauseWorker();
 assert.ok(run.checkpoint);assert.equal(run.workspace_context.authority_snapshot.dependency_schema,6);assert.deepEqual(run.workspace_context.authority_snapshot.historical_analyses,[]);
 await finish();
 h.sql(`UPDATE pi_checkpoints SET checkpoint=JSON_REMOVE(checkpoint,'$.authority_snapshot.historical_analyses') WHERE recovery_chain_id='${run.recovery_chain_id}'`);
 await h.resumeWorker();run=await h.capture(fresh,'缺历史桶的格式六重建');await h.pauseWorker();
 assert.equal(run.checkpoint,null);assert.equal(run.workspace_context.authority_snapshot.dependency_schema,6);assert.equal((await issue()).status,200);await finish();
 checks.push('格式6显式携带historical_analyses：未使用为空数组，缺桶视为不完整并按新输入重建');
 for(const version of [3,4]){
  const legacy=await h.create();await h.resumeWorker();run=await h.capture(legacy,'保存当前有效的上下文');await h.pauseWorker();await finish();
  h.sql(`UPDATE pi_checkpoints SET checkpoint=JSON_SET(checkpoint,'$.authority_snapshot.dependency_schema',${version}) WHERE recovery_chain_id IN (SELECT recovery_chain_id FROM conversation_messages WHERE conversation_id='${legacy}')`);
  await h.resumeWorker();run=await h.capture(legacy,'格式迁移后继续调查');await h.pauseWorker();
  assert.equal(run.checkpoint,null);assert.equal(run.workspace_context.authority_snapshot.dependency_schema,6);assert.equal((await issue()).status,200);await finish();
 }
 checks.push('旧格式3可能遗漏案例依赖、格式4可能遗漏任务独立正文依赖；新输入均按SDK重建为格式6');
 // 四条陈述通过当前 evidence 游标分两页交付，依赖只跟随已交付的命中。
 const trimmedCid=await h.create();await h.resumeWorker();run=await h.capture(trimmedCid,'核对合成陈述的当前边界');await h.pauseWorker();
 const sourceDocs=[],supportObjects=[];
 for(const label of ['甲','乙','丙','丁']){
  const source=await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'裁剪出处'+label,
   body:'独立合成出处：设备'+label+'必须在校准后使用。',related_ids:[]});
  assert.equal(source.status,200,JSON.stringify(source.value));sourceDocs.push(source.value);
  const support=await h.request('/knowledge',{operation_id:randomUUID(),kind:'term',name:'裁剪条件'+label,
   body:'条件'+label+'：设备仅在校准后使用。',related_ids:[]});
  assert.equal(support.status,200,JSON.stringify(support.value));supportObjects.push(support.value);
 }
 const created=await h.request('/knowledge',{operation_id:randomUUID(),kind:'metric',name:'裁剪陈述合成资料',body:'初始化',related_ids:[]});
 assert.equal(created.status,200,JSON.stringify(created.value));
 const statementObject=created.value;
 statementObject.entries=['a','b','c','d'].map((letter,index)=>{
  const entryId='rule-'+letter,support=supportObjects[index],source=sourceDocs[index];
  const condition=support.entries[0].effective_value,text='authtrimneedle 合成陈述'+letter+'。'+condition;
  const statement={statement_id:'statement-'+letter,object_ref:{object_id:statementObject.id,version:'1',path:entryId},
   text,scope_text:'',origin:'model_inference',citations:[{source:{kind:'document',id:source.id},revision:source.version,
    locator:{offset:0,length:[...source.entries[0].effective_value].length}}],
   supports:[{support_id:'support-'+letter,role:'prerequisite',reference:{kind:'knowledge',ref:{object_id:support.id,version:support.version,path:'body'}},
    content:condition,embedded_in:{field:'text',locator:{offset:[...text].length-[...condition].length,length:[...condition].length}}}]};
  return {entry_id:entryId,path:entryId,label:'边界'+letter,effective_value:text,source_facts:{complete:false,gap:'独立合成映射'},
   suggestion:{value:text,statements:[statement]},human_override:null,review_state:'unverified'};
 });
 const encoded=Buffer.from(JSON.stringify(statementObject)).toString('hex');
 h.sql(`UPDATE knowledge_objects SET body=CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON) WHERE id='${statementObject.id}';
  UPDATE knowledge_revisions SET archived_body=CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON) WHERE object_id='${statementObject.id}';
  UPDATE retrieval_documents SET body=CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON) WHERE object_id='${statementObject.id}';
  UPDATE knowledge_dependency_states SET mapping_state='unknown' WHERE owner_id='${statementObject.id}' AND owner_version=1;
  INSERT INTO knowledge_statements(object_id,version,statement_id,space_id,entry_path,layer,body)
   SELECT '${statementObject.id}',1,JSON_UNQUOTE(JSON_EXTRACT(s.value,'$.statement_id')),'demo',
    JSON_UNQUOTE(JSON_EXTRACT(e.value,'$.path')),'model_suggestion',s.value
   FROM JSON_TABLE(CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON),'$.entries[*]' COLUMNS(value JSON PATH '$')) e,
    JSON_TABLE(CAST(JSON_EXTRACT(e.value,'$.suggestion.statements') AS JSON),'$[*]' COLUMNS(value JSON PATH '$')) s`);
 const beforeSearch=h.sql(`SELECT authority_snapshot FROM agent_runs WHERE id='${run.run_id}'`)[0];
 assert.ok(!beforeSearch.knowledge.some(reference=>supportObjects.some(object=>object.id===reference[0])),'夹具支持未在搜索前交付');
 assert.ok(!beforeSearch.sources.some(reference=>sourceDocs.some(object=>'document-'+object.id===reference[0])),'夹具出处未在搜索前交付');
 const trimArgs={query:'authtrimneedle',limit:3};
 const trimmed=await invoke('search_knowledge',trimArgs);
 assert.deepEqual(trimmed.hits.map(hit=>hit.ref.object_id),Array(3).fill(statementObject.id));
 const retained=trimmed.hits.map(hit=>statementObject.entries.findIndex(entry=>entry.path===hit.ref.path));
 assert.equal(new Set(retained).size,3);
 assert.ok(retained.every(index=>index>=0));
 const omittedRule=statementObject.entries.find((_,index)=>!retained.includes(index));
 assert.equal(JSON.stringify(trimmed).includes(omittedRule.effective_value),false,
  '第四条陈述的正文不得经其他字段旁路交付');
 for(const [index,hit] of trimmed.hits.entries())assert.equal(hit.definition,statementObject.entries[retained[index]].effective_value);
 const afterSearch=h.sql(`SELECT authority_snapshot FROM agent_runs WHERE id='${run.run_id}'`)[0];
 const expectedSupports=retained.map(index=>[supportObjects[index].id,supportObjects[index].version]).sort();
 assert.deepEqual(afterSearch.knowledge.filter(reference=>supportObjects.some(object=>object.id===reference[0])).sort(),expectedSupports,
  '内嵌且最终可见的支持须登记；被裁掉的第四条支持不能登记');
 assert.deepEqual(afterSearch.sources.filter(reference=>sourceDocs.some(object=>'document-'+object.id===reference[0])).sort(),
  retained.map(index=>['document-'+sourceDocs[index].id,sourceDocs[index].version]).sort(),'陈述出处按实际保留内容登记，不把全对象核验清单当交付清单');
 assert.equal((await issue()).status,200,'已交付映射的当前依赖应允许正常模型派发');
 assert.match(trimmed.search_coverage.next,/^rc1:/);
 const fourth=await invoke('search_knowledge',{...trimArgs,cursor:trimmed.search_coverage.next});
 assert.deepEqual(fourth.hits.map(hit=>hit.ref.path),[omittedRule.path],'第四条独立陈述实际进入共同候选且能续读');
 await finish();
 checks.push('搜索四条陈述末端保留三条：内嵌可见支持和出处登记完整，第四条裁掉的支持与出处不进入authority');
 // legacy 没有陈述映射：只显示首条仍携带对象完整的必要来源。
 const legacyCid=await h.create();await h.resumeWorker();run=await h.capture(legacyCid,'核对旧格式合成资料');await h.pauseWorker();
 const legacySources=[];
 for(const label of ['首条','后条']){
  const source=await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'旧格式出处'+label,
   body:'独立合成旧资料：'+label+'适用各自设备的例行检查。',related_ids:[]});
  assert.equal(source.status,200,JSON.stringify(source.value));legacySources.push(source.value);
 }
 const legacyCreated=await h.request('/knowledge',{operation_id:randomUUID(),kind:'metric',name:'旧格式合成资料',body:'初始化',related_ids:[]});
 assert.equal(legacyCreated.status,200,JSON.stringify(legacyCreated.value));
 const legacyObject=legacyCreated.value;
 legacyObject.entries=['selected','omitted'].map((entryId,index)=>{
  const text=index===0?'authlegacyneedle 首条设备检查。':'另一设备检查，未进入当前显示。';
  return {entry_id:entryId,path:entryId,label:'旧资料'+entryId,effective_value:text,
   source_facts:{value:text,complete:true,source_id:'document-'+legacySources[index].id,version:legacySources[index].version},
   suggestion:{},human_override:null,review_state:'unverified'};
 });
 const legacyEncoded=Buffer.from(JSON.stringify(legacyObject)).toString('hex');
 h.sql(`UPDATE knowledge_objects SET body=CAST(CONVERT(0x${legacyEncoded} USING utf8mb4) AS JSON) WHERE id='${legacyObject.id}';
  UPDATE knowledge_revisions SET archived_body=CAST(CONVERT(0x${legacyEncoded} USING utf8mb4) AS JSON) WHERE object_id='${legacyObject.id}';
  UPDATE retrieval_documents SET body=CAST(CONVERT(0x${legacyEncoded} USING utf8mb4) AS JSON) WHERE object_id='${legacyObject.id}';
  UPDATE knowledge_dependency_states SET mapping_state='unknown' WHERE owner_id='${legacyObject.id}' AND owner_version=1`);
 const beforeLegacy=h.sql(`SELECT authority_snapshot FROM agent_runs WHERE id='${run.run_id}'`)[0];
 assert.ok(!beforeLegacy.sources.some(reference=>legacySources.some(object=>'document-'+object.id===reference[0])),
  '旧格式出处未在搜索前交付');
 const legacyReply=await invoke('search_knowledge',{query:'authlegacyneedle',limit:4});
 assert.deepEqual(legacyReply.hits.map(hit=>hit.ref),[{object_id:legacyObject.id,version:legacyObject.version,path:'selected'}]);
 assert.equal((await issue()).status,200,'旧格式完整必要来源当前有效时允许正常模型派发');
 const legacyRequired=legacySources[1];
 assert.equal((await h.request('/knowledge/'+legacyRequired.id+'/disable',{operation_id:randomUUID(),expected_version:legacyRequired.version})).status,200);
 const legacyRead=await invoke('read_knowledge',{items:[{kind:'knowledge',ref:legacyReply.hits[0].ref}]});
 assert.ok(['stale','not_available'].includes(legacyRead.items[0].state),'旧格式的必要来源撤回后不得再交付正文');
 assert.equal(legacyRead.items[0].content,undefined);
 assert.equal((await h.request(`/conversations/${legacyCid}/messages/${run.message_id}/withdraw`,{operation_id:randomUUID()})).status,200);
 h.releaseRun(run.run_id);
 checks.push('旧格式只交付一个条目仍核对两个必要来源，未显示的必要来源撤回后拒绝再次交付');
 // 同 entry 的陈述按 statement_id 提供独立坐标及续读。
 const sameEntryCid=await h.create();await h.resumeWorker();run=await h.capture(sameEntryCid,'核对同条目合成陈述');await h.pauseWorker();
 const sameEntrySources=[],sameEntrySupports=[];
 for(const label of ['甲','乙','丙','丁']){
  const source=await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'同条目出处'+label,
   body:'独立合成同条目出处：设备'+label+'仅在例行复检后使用。',related_ids:[]});
  assert.equal(source.status,200,JSON.stringify(source.value));sameEntrySources.push(source.value);
  const support=await h.request('/knowledge',{operation_id:randomUUID(),kind:'term',name:'同条目条件'+label,
   body:'条件'+label+'：设备仅在例行复检后使用。',related_ids:[]});
  assert.equal(support.status,200,JSON.stringify(support.value));sameEntrySupports.push(support.value);
 }
 const sameEntryCreated=await h.request('/knowledge',{operation_id:randomUUID(),kind:'metric',name:'同条目陈述合成资料',body:'初始化',related_ids:[]});
 assert.equal(sameEntryCreated.status,200,JSON.stringify(sameEntryCreated.value));
 const sameEntryObject=sameEntryCreated.value;
 const commonPrefix='authsameentryneedle '+'设备背景🌏。'.repeat(27);
 assert.ok([...commonPrefix].length>160,'相同前缀必须完整覆盖目录正文');
 const sameEntryStatements=['a','b','c','d'].map((letter,index)=>{
  const condition=sameEntrySupports[index].entries[0].effective_value,text=commonPrefix+'规则'+letter+'。'+condition;
  assert.ok([...text].length<=280,'每条合成陈述只占一个规范窗口');
  return {statement_id:'same-entry-'+letter,object_ref:{object_id:sameEntryObject.id,version:'1',path:'rules'},
   text,scope_text:'',origin:'model_inference',citations:[{source:{kind:'document',id:sameEntrySources[index].id},revision:sameEntrySources[index].version,
    locator:{offset:0,length:[...sameEntrySources[index].entries[0].effective_value].length}}],
   supports:[{support_id:'same-support-'+letter,role:'prerequisite',reference:{kind:'knowledge',ref:{object_id:sameEntrySupports[index].id,version:sameEntrySupports[index].version,path:'body'}},
    content:condition,embedded_in:{field:'text',locator:{offset:[...text].length-[...condition].length,length:[...condition].length}}}]};
 });
 const sameEntryText=sameEntryStatements.map(statement=>statement.text).join('\n\n');
 sameEntryObject.entries=[{entry_id:'rules',path:'rules',label:'设备复检规则',effective_value:sameEntryText,
  source_facts:{complete:false,gap:'独立合成同条目映射'},suggestion:{value:sameEntryText,statements:sameEntryStatements},
  human_override:null,review_state:'unverified'}];
 const sameEntryEncoded=Buffer.from(JSON.stringify(sameEntryObject)).toString('hex');
 h.sql(`UPDATE knowledge_objects SET body=CAST(CONVERT(0x${sameEntryEncoded} USING utf8mb4) AS JSON) WHERE id='${sameEntryObject.id}';
  UPDATE knowledge_revisions SET archived_body=CAST(CONVERT(0x${sameEntryEncoded} USING utf8mb4) AS JSON) WHERE object_id='${sameEntryObject.id}';
  UPDATE retrieval_documents SET body=CAST(CONVERT(0x${sameEntryEncoded} USING utf8mb4) AS JSON) WHERE object_id='${sameEntryObject.id}';
  UPDATE knowledge_dependency_states SET mapping_state='unknown' WHERE owner_id='${sameEntryObject.id}' AND owner_version=1;
  INSERT INTO knowledge_statements(object_id,version,statement_id,space_id,entry_path,layer,body)
   SELECT '${sameEntryObject.id}',1,JSON_UNQUOTE(JSON_EXTRACT(s.value,'$.statement_id')),'demo','rules','model_suggestion',s.value
   FROM JSON_TABLE(CAST(CONVERT(0x${sameEntryEncoded} USING utf8mb4) AS JSON),'$.entries[0].suggestion.statements[*]' COLUMNS(value JSON PATH '$')) s`);
 const beforeSameEntry=h.sql(`SELECT authority_snapshot FROM agent_runs WHERE id='${run.run_id}'`)[0];
 assert.ok(!beforeSameEntry.knowledge.some(reference=>sameEntrySupports.some(object=>object.id===reference[0])),
  '同条目支持未在搜索前交付');
 assert.ok(!beforeSameEntry.sources.some(reference=>sameEntrySources.some(object=>'document-'+object.id===reference[0])),
  '同条目出处未在搜索前交付');
 const sameArgs={query:'authsameentryneedle',limit:3};
 const sameEntryReply=await invoke('search_knowledge',sameArgs);
 assert.deepEqual(sameEntryReply.hits.map(hit=>hit.ref),Array(3).fill({object_id:sameEntryObject.id,version:'1',path:'rules'}));
 const retainedStatements=sameEntryReply.hits.map(hit=>sameEntryStatements.findIndex(statement=>statement.statement_id===hit.statement_id));
 assert.equal(new Set(retainedStatements).size,3);
 assert.ok(retainedStatements.every(index=>index>=0));
 const actualStatements=retainedStatements.map(index=>sameEntryStatements[index]);
 const omittedStatement=sameEntryStatements.find((_,index)=>!retainedStatements.includes(index));
 assert.deepEqual(sameEntryReply.hits.map(hit=>hit.definition),actualStatements.map(statement=>statement.text));
 assert.equal(JSON.stringify(sameEntryReply).includes(omittedStatement.text),false);
 const afterSameEntry=h.sql(`SELECT authority_snapshot FROM agent_runs WHERE id='${run.run_id}'`)[0];
 assert.deepEqual(afterSameEntry.knowledge.filter(reference=>sameEntrySupports.some(object=>object.id===reference[0])).sort(),
  retainedStatements.map(index=>[sameEntrySupports[index].id,sameEntrySupports[index].version]).sort(),
  '同entry不能只登记首条，也不能因前缀相同多登记被裁掉的第四条支持');
 assert.deepEqual(afterSameEntry.sources.filter(reference=>sameEntrySources.some(object=>'document-'+object.id===reference[0])).sort(),
  retainedStatements.map(index=>['document-'+sameEntrySources[index].id,sameEntrySources[index].version]).sort(),
  '同entry的出处按实际可见陈述登记');
 assert.equal((await issue()).status,200,'同entry可见陈述及其当前依赖允许正常模型派发');
 const firstPage=await invoke('read_knowledge',{items:sameEntryReply.hits.map(({ref,statement_id})=>({kind:'knowledge',ref,statement_id,limit:168}))});
 assert.deepEqual(firstPage.items.map(item=>item.content),actualStatements.map(statement=>[...statement.text].slice(0,168).join('')));
 const restPage=await invoke('read_knowledge',{items:firstPage.items.map(({ref,statement_id,continuation})=>({kind:'knowledge',ref,statement_id,offset:continuation.content_next_offset}))});
 assert.deepEqual(restPage.items.map((item,index)=>firstPage.items[index].content+item.content),actualStatements.map(statement=>statement.text),
  '有相同Unicode前缀的不同陈述从各自坐标续读');
 assert.match(sameEntryReply.search_coverage.next,/^rc1:/);
 const rest=await invoke('search_knowledge',{...sameArgs,cursor:sameEntryReply.search_coverage.next});
 assert.deepEqual(rest.hits.map(hit=>hit.statement_id),[omittedStatement.statement_id],'四条同entry陈述独立进入候选');
 await finish();
 checks.push('同entry四条陈述共享前缀，按前三个实际命中登记支持与出处，原Unicode坐标各自续读');
 // 三类合成资料在同一公开上限内用请求余量触发身份投影和整项省略。
 const storeCapacityObjects=objects=>{
  const statements=[];
  for(const object of objects){
   const encoded=Buffer.from(JSON.stringify(object)).toString('hex'),value=`CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON)`;
   statements.push(`INSERT INTO knowledge_objects(id,space_id,kind,name,version,state,body,source_id,source_version,updated_by)
    VALUES('${object.id}','demo','${object.kind}','${object.name}',1,'enabled',${value},NULL,0,'synthetic-test')`,
    `INSERT INTO knowledge_revisions(object_id,version,archived_body) VALUES('${object.id}',1,${value})`,
    `INSERT INTO retrieval_documents(object_id,space_id,version,body) VALUES('${object.id}','demo',1,${value})`,
    `INSERT INTO semantic_ownership(space_id,object_id,authority_id,maintainer_id,source,updated_by)
     VALUES('demo','${object.id}','${object.id}','alice','creator','alice')`);
   for(const entry of object.entries)for(const statement of entry.suggestion.statements??[]){
    const body=Buffer.from(JSON.stringify(statement)).toString('hex');
    statements.push(`INSERT INTO knowledge_statements(object_id,version,statement_id,space_id,entry_path,layer,body)
     VALUES('${object.id}',1,'${statement.statement_id}','demo','${entry.path}','model_suggestion',CAST(CONVERT(0x${body} USING utf8mb4) AS JSON))`);
   }
  }
  h.sql(statements.join(';'));
 };
 const capacityEntry=text=>({entry_id:'body',path:'body',label:'合成规则',effective_value:text,
  source_facts:{complete:false,gap:'从零构造的容量反例'},suggestion:{},human_override:null,review_state:'unverified'});
 const capacityObject=(id,kind,text)=>({id,kind,name:'容量合成资料'+id,version:'1',state:'enabled',entries:[capacityEntry(text)],
  related_ids:[],source_id:null,source_version:'0',updated_by:'synthetic-test'});
 for(const variant of ['mapped','legacy','structure']){
  const query='capacity'+variant+'needle',prefix='cap-'+variant+'-',objects=[],supports=[],sources=[],tables=[],records=[];
  for(let index=0;index<30;index++){
   const suffix=String(index).padStart(2,'0'),id=prefix+suffix;
   const condition='条件'+suffix+'：必须校准后使用。',text=query+' '+'🌏'.repeat(240)+condition;
   assert.ok([...text].length<=280,'每对象固定一个规范窗口，不用多窗口提前消耗名额');
   const object=capacityObject(id,'metric',text);
   if(variant==='mapped'){
    const source=capacityObject(prefix+'source-'+suffix,'document','独立合成出处'+suffix+'：'+condition);
    const support=capacityObject(prefix+'support-'+suffix,'term',condition);
    const statement={statement_id:'statement-'+suffix,object_ref:{object_id:id,version:'1',path:'body'},text,scope_text:'',origin:'model_inference',
     citations:[{source:{kind:'document',id:source.id},revision:'1',locator:{offset:0,length:[...source.entries[0].effective_value].length}}],
     supports:[{support_id:'support-'+suffix,role:'prerequisite',reference:{kind:'knowledge',ref:{object_id:support.id,version:'1',path:'body'}},
      content:condition,embedded_in:{field:'text',locator:{offset:[...text].length-[...condition].length,length:[...condition].length}}}]};
    object.entries[0].suggestion={value:text,statements:[statement]};
    sources.push(source);supports.push(support);records.push(source,support);
   }else if(variant==='legacy'){
    const pair=[0,1].map(part=>capacityObject(prefix+'source-'+suffix+'-'+part,'document','独立合成旧出处'+suffix+'-'+part));
    object.entries[0].source_facts={value:text,complete:true,source_id:'document-'+pair[0].id,version:'1'};
    object.entries.push({...capacityEntry('未显示的独立合成依据'),entry_id:'other',path:'other',
     source_facts:{value:'未显示的独立合成依据',complete:true,source_id:'document-'+pair[1].id,version:'1'}});
    sources.push(...pair);records.push(...pair);
   }else{
    const table=capacityObject(prefix+'table-'+suffix,'table','CREATE TABLE cap_table_'+suffix+' (amount BIGINT, paid_at DATETIME);');
    table.name='cap_table_'+suffix;table.entries[0].entry_id='ddl';table.entries[0].path='ddl';
    const rule={kind:'metric',table:{object_id:table.id,version:'1'},expression:'SUM(amount)',input_grain:'合成行',
     time_column:'paid_at',unit:'分',required_filters:[],dimensions:[]};
    object.entries[0].human_override={value:text,structured_value:rule};object.entries[0].effective_structure=rule;
    tables.push(table);records.push(table);
   }
   objects.push(object);records.push(object);
  }
  storeCapacityObjects(records);
  const capacityCid=await h.create();await h.resumeWorker();run=await h.capture(capacityCid,'核对'+variant+'容量裁剪的实际采用范围');await h.pauseWorker();
  const before=h.sql(`SELECT authority_snapshot FROM agent_runs WHERE id='${run.run_id}'`)[0];
  assert.ok(!JSON.stringify(before).includes(prefix),'容量夹具未在搜索前交付');
  const args={query,limit:30}, maxBytes=4800;
  const result=await invoke('search_knowledge',args,maxBytes);
  assert.ok(Buffer.byteLength(JSON.stringify(result))<=maxBytes,'正式回执须遵守当次收窄后的内容容量');
  assert.match(result.search_coverage.next,/^rc1:/);
  const minimal=result.hits.filter(hit=>hit.definition===''&&hit.scope_text==='');
  assert.ok(minimal.length>0,'必须真实触发最小目录');
  assert.ok(result.hits.length<objects.length,'必须真实触发整项省略');
  for(const hit of minimal) {
   assert.equal(hit.content_state,'partial');
   assert.equal(hit.continuation.content_next_offset,0);
  }
  const after=h.sql(`SELECT authority_snapshot FROM agent_runs WHERE id='${run.run_id}'`)[0];
  const visible=new Set(result.hits.map(hit=>hit.ref.object_id));
  assert.deepEqual(after.knowledge.filter(reference=>objects.some(object=>object.id===reference[0])).map(reference=>reference[0]).sort(),[...visible].sort(),
   '仅最终交付对象登记自身版本；omitted目录不能变成已采用对象');
  if(variant==='mapped'){
   const emittedSupports=result.hits.flatMap(hit=>hit.supports)
    .filter(support=>support.content?.length>0||support.delivered_in).map(support=>support.reference.ref.object_id).sort();
   const emittedSources=result.hits.flatMap(hit=>hit.citations).map(citation=>'document-'+citation.source.id).sort();
   assert.deepEqual(after.knowledge.filter(reference=>supports.some(object=>object.id===reference[0])).map(reference=>reference[0]).sort(),
    emittedSupports,'只登记实际交付的映射支持');
   assert.deepEqual(after.sources.filter(reference=>sources.some(object=>'document-'+object.id===reference[0])).map(reference=>reference[0]).sort(),
    emittedSources,'只登记实际交付命中携带的出处');
  }else if(variant==='legacy'){
   const emittedSources=result.hits.flatMap(hit=>hit.citations).map(citation=>'document-'+citation.source.id).sort();
   assert.deepEqual(after.sources.filter(([id])=>sources.some(source=>'document-'+source.id===id)).map(([id])=>id).sort(),
    emittedSources,'旧卡必要来源通过条目回源核验，只把交付出处登记为原文读取');
  }else{
   assert.deepEqual(after.knowledge_entries.filter(([id])=>tables.some(table=>table.id===id)).sort(),
    tables.filter((_,index)=>visible.has(objects[index].id)).map(table=>[table.id,table.version,'ddl']).sort(),
    '结构绑定按实际保留命中登记底表、版本及DDL路径');
  }
  assert.equal((await issue()).status,200,'裁剪后登记的当前依赖须允许正常模型派发');
  const reached=new Set(visible);
  let cursor=result.search_coverage.next;
  while(cursor!==null){
   const page=await invoke('search_knowledge',{...args,cursor},24064);
   assert.ok(Buffer.byteLength(JSON.stringify(page))<=24064);
   assert.ok(page.hits.length>0,'游标必须推进，不能在容量裁剪后原地返回');
   for(const hit of page.hits){
    assert.equal(reached.has(hit.ref.object_id),false,'游标续页不得重复交付');
    reached.add(hit.ref.object_id);
   }
   assert.ok(reached.size<=objects.length);
   cursor=page.search_coverage.next;
  }
  assert.deepEqual([...reached].sort(),objects.map(object=>object.id).sort(),'三十个规范内容最终均按原游标交付');
  if(variant==='mapped') await finish();
  else {
   const index=objects.findIndex(object=>object.id===minimal[0].ref.object_id);
   const required=variant==='legacy'?sources[index*2+1]:tables[index];
   const disabled=await h.request('/knowledge/'+required.id+'/disable',{operation_id:randomUUID(),expected_version:required.version});
   assert.equal(disabled.status,200,JSON.stringify(disabled.value));
   const args={items:[{kind:'knowledge',ref:minimal[0].ref}]};
   if(variant==='legacy'){
    const denied=await invoke('read_knowledge',args);
    assert.ok(['stale','not_available'].includes(denied.items[0].state),'旧来源停用后拒绝交付条目');
    assert.equal(denied.items[0].content,undefined);
   }else{
    const denied=await invoke('read_knowledge',args,undefined,409);
    assert.equal(denied.code,'stale_knowledge');
    assert.equal(denied.data,undefined,'结构绑定失效后拒绝整份正文回执');
   }
   assert.equal((await h.request(`/conversations/${capacityCid}/messages/${run.message_id}/withdraw`,{operation_id:randomUUID()})).status,200);
   h.releaseRun(run.run_id);
  }
  checks.push(variant+'容量裁剪：'+minimal.length+'条最小命中，整项省略可按原游标续回，继续核验必要依赖');
 }
 const changing = await h.request('/knowledge/table-raw_payments');
 assert.equal(changing.status,200,JSON.stringify(changing.value));
 const table = changing.value;
 const beforeRef = {object_id:table.id,version:table.version,path:'ddl'};
 const revisionCid=await h.create();await h.resumeWorker();
 run=await h.capture(revisionCid,'核对支付表当前的结构。');await h.pauseWorker();
 assert.equal((await invoke('read_knowledge',{items:[{kind:'knowledge',ref:beforeRef}]})).items[0].state,'ok');
 await finish();
 const description=table.entries.find(entry=>entry.path==='description');
 assert.ok(description);
 const revised=await h.request('/knowledge/'+table.id,{operation_id:randomUUID(),expected_version:table.version,
  entry_id:description.entry_id,value:description.effective_value+' 结构说明经复核。',structured_value:description.effective_structure},'alice','PATCH');
 assert.equal(revised.status,200,JSON.stringify(revised.value));assert.notEqual(revised.value.version,table.version);
 await h.resumeWorker();run=await h.capture(revisionCid,'沿旧会话续聊，并重读当前表结构。');await h.pauseWorker();
 assert.ok(run.checkpoint,'表仍启用可读，结构对象的普通改版不作废检查点');
 const inline=await h.internal('/internal/checkpoints/read',{run_id:run.run_id,lease_epoch:run.lease_epoch});
 assert.equal(inline.status,200,JSON.stringify(inline.value));
 assert.deepEqual(inline.value.authority_snapshot.knowledge.find(([id])=>id===table.id),[table.id,table.version]);
 const stale=await invoke('read_knowledge',{items:[{kind:'knowledge',ref:beforeRef}]});
 assert.equal(stale.items[0].state,'stale','工具仍拒绝用旧精读版本冒充当前表结构');
 assert.equal(stale.items[0].content,undefined);
 assert.equal((await h.request(`/conversations/${revisionCid}/messages/${run.message_id}/withdraw`,{operation_id:randomUUID()})).status,200);
 h.releaseRun(run.run_id);
 checks.push('仍可读的结构对象改版保留旧Pi检查点与实际内联续接，精读仍拒绝过时版本');
 passed=true;console.log(JSON.stringify({passed,checks,officialRequests:0}));
}finally{await writeFile('.local/checks/mvp-context-dependencies.json',JSON.stringify({passed,checks,officialRequests:0},null,2));await h.close();}

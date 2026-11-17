import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness} from './harness.mjs';
const h=await harness({capture:true,env:{DATA_AGENT_LEASE_MS:'120000'}}),manager=SessionManager.inMemory('/synthetic/data-agent');
let run,passed=false;const checks=[];
const invoke=async(name,args)=>{
 const input={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:randomUUID(),tool_name:name,arguments:args,checkpoint:exportCheckpoint(manager)};
 assert.equal((await h.internal('/internal/data/tool-calls',input)).status,200);const r=await h.internal('/internal/data/tools',input);assert.equal(r.status,200,JSON.stringify(r.value));return r.value.data;
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
 assert.deepEqual(new Set(run.workspace_context.authority_snapshot.memories.map(v=>v[0])),new Set(delivered));
 assert.equal((await h.request('/assets/'+omitted.id+'/disable',{operation_id:randomUUID(),expected_version:omitted.version})).status,200);
 assert.equal((await issue()).status,200);
 checks.push('启动材料裁剪后的实际记忆才登记依赖，被裁掉的记忆停用不影响会话');
 await invoke('read_knowledge',{object_id:'table-demo_order_detail'});await invoke('read_knowledge',{object_id:'table-raw_payments'});
 await finish('旧资料结论-A');
 const unused=(await h.request('/knowledge/table-customer_tags')).value;assert.equal((await h.request('/knowledge/'+unused.id+'/disable',{operation_id:randomUUID(),expected_version:unused.version})).status,200);
 await h.resumeWorker();run=await h.capture(cid,'继续聊另一个问题');await h.pauseWorker();
 assert.ok(run.checkpoint);const refs=run.workspace_context.authority_snapshot.knowledge;
 assert.ok(refs.some(v=>v[0]==='table-demo_order_detail'));assert.ok(refs.some(v=>v[0]==='table-raw_payments'));assert.ok(!refs.some(v=>v[0]===unused.id));assert.equal((await issue()).status,200);
 const consumed=(await h.request('/knowledge/table-demo_order_detail')).value;
 assert.equal((await h.request('/knowledge/'+consumed.id+'/disable',{operation_id:randomUUID(),expected_version:consumed.version})).status,200);
 assert.equal((await issue()).value.code,'stale_context');
 checks.push('跨轮保留Pi检查点的早期读取依赖；无关改版不重建，旧已读资料撤回仍阻止模型发送');
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
 // 搜索实际读回4条陈述，v1末端只交3条；依赖按保留的内容映射登记。
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
  UPDATE knowledge_versions SET body=CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON) WHERE object_id='${statementObject.id}';
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
 const trimmed=await invoke('search_knowledge',{query:'authtrimneedle',limit:4});
 assert.equal(trimmed.search_coverage.candidate_count,4,'四条独立陈述必须都实际进入共同候选');
 assert.deepEqual(trimmed.objects.map(object=>object.id),[statementObject.id]);
 assert.deepEqual(trimmed.objects[0].entries.map(entry=>entry.entry_id),['rule-a','rule-b','rule-c']);
 assert.deepEqual(trimmed.objects[0].retrieval.excerpts.map(excerpt=>excerpt.entry_id),['rule-a','rule-b','rule-c'],
  '第四条陈述的正文也不能经retrieval.excerpts旁路保留');
 for(const [index,entry] of trimmed.objects[0].entries.entries())assert.ok(entry.effective_value.includes(supportObjects[index].entries[0].effective_value));
 const afterSearch=h.sql(`SELECT authority_snapshot FROM agent_runs WHERE id='${run.run_id}'`)[0];
 const expectedSupports=supportObjects.slice(0,3).map(object=>[object.id,object.version]);
 assert.deepEqual(afterSearch.knowledge.filter(reference=>supportObjects.some(object=>object.id===reference[0])),expectedSupports,
  '内嵌且最终可见的支持须登记；被裁掉的第四条支持不能登记');
 assert.deepEqual(afterSearch.sources.filter(reference=>sourceDocs.some(object=>'document-'+object.id===reference[0])),
  sourceDocs.slice(0,3).map(object=>['document-'+object.id,object.version]),'陈述出处按实际保留内容登记，不把全对象核验清单当交付清单');
 assert.equal((await issue()).status,200,'已交付映射的当前依赖应允许正常模型派发');
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
  UPDATE knowledge_versions SET body=CAST(CONVERT(0x${legacyEncoded} USING utf8mb4) AS JSON) WHERE object_id='${legacyObject.id}';
  UPDATE retrieval_documents SET body=CAST(CONVERT(0x${legacyEncoded} USING utf8mb4) AS JSON) WHERE object_id='${legacyObject.id}';
  UPDATE knowledge_dependency_states SET mapping_state='unknown' WHERE owner_id='${legacyObject.id}' AND owner_version=1`);
 const beforeLegacy=h.sql(`SELECT authority_snapshot FROM agent_runs WHERE id='${run.run_id}'`)[0];
 assert.ok(!beforeLegacy.sources.some(reference=>legacySources.some(object=>'document-'+object.id===reference[0])),
  '旧格式出处未在搜索前交付');
 const legacyReply=await invoke('search_knowledge',{query:'authlegacyneedle',limit:4});
 assert.equal(legacyReply.search_coverage.candidate_count,1,'旧格式只召回命中的一个规范内容项');
 assert.deepEqual(legacyReply.objects.map(object=>object.id),[legacyObject.id]);
 assert.deepEqual(legacyReply.objects[0].entries.map(entry=>entry.entry_id),['selected']);
 assert.deepEqual(legacyReply.objects[0].retrieval.excerpts.map(excerpt=>excerpt.entry_id),['selected']);
 const afterLegacy=h.sql(`SELECT authority_snapshot FROM agent_runs WHERE id='${run.run_id}'`)[0];
 assert.deepEqual(afterLegacy.sources.filter(reference=>legacySources.some(object=>'document-'+object.id===reference[0]))
  .map(reference=>reference.join(':')).sort(),legacySources.map(object=>'document-'+object.id+':'+object.version).sort(),
  '保留的旧格式内容须登记完整必要来源，不能按可见条目推窄');
 assert.equal((await issue()).status,200,'旧格式完整必要来源当前有效时允许正常模型派发');
 await finish();
 checks.push('旧格式只交付一个条目仍登记两个必要来源，不因窄读和末端裁剪收窄legacy依据');
 // 同 entry 的陈述共用目录前缀，实际可见内容仍按原坐标与 excerpts 区分。
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
  UPDATE knowledge_versions SET body=CAST(CONVERT(0x${sameEntryEncoded} USING utf8mb4) AS JSON) WHERE object_id='${sameEntryObject.id}';
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
 const sameEntryReply=await invoke('search_knowledge',{query:'authsameentryneedle',limit:4});
 assert.equal(sameEntryReply.search_coverage.candidate_count,4,'同entry的四条陈述仍分别计入规范候选');
 assert.deepEqual(sameEntryReply.objects.map(object=>object.id),[sameEntryObject.id]);
 const sameEntryDelivered=sameEntryReply.objects[0];
 assert.deepEqual(sameEntryDelivered.entries.map(entry=>entry.entry_id),['rules']);
 assert.equal(sameEntryDelivered.entries[0].effective_value,[...commonPrefix].slice(0,160).join(''),
  '目录只显示共同前缀，不能据此把四条陈述都视为已交付');
 assert.equal(sameEntryDelivered.retrieval.excerpts.length,3,'第四条陈述不能经excerpt旁路交付');
 let sameEntryOffset=0;
 for(const [index,excerpt] of sameEntryDelivered.retrieval.excerpts.entries()){
  assert.equal(excerpt.entry_id,'rules');assert.equal(excerpt.path,'rules');
  assert.equal(excerpt.offset,sameEntryOffset,'相同前缀的不同陈述必须保留不同的原Unicode坐标');
  assert.equal(excerpt.text,sameEntryStatements[index].text);
  assert.equal(excerpt.length,[...sameEntryStatements[index].text].length);
  assert.equal(excerpt.total_chars,[...sameEntryText].length);
  sameEntryOffset+=[...sameEntryStatements[index].text].length+2;
 }
 const afterSameEntry=h.sql(`SELECT authority_snapshot FROM agent_runs WHERE id='${run.run_id}'`)[0];
 assert.deepEqual(afterSameEntry.knowledge.filter(reference=>sameEntrySupports.some(object=>object.id===reference[0])),
  sameEntrySupports.slice(0,3).map(object=>[object.id,object.version]),
  '同entry不能只登记首条，也不能因前缀相同多登记被裁掉的第四条支持');
 assert.deepEqual(afterSameEntry.sources.filter(reference=>sameEntrySources.some(object=>'document-'+object.id===reference[0])),
  sameEntrySources.slice(0,3).map(object=>['document-'+object.id,object.version]),
  '同entry的出处按实际可见陈述登记');
 assert.equal((await issue()).status,200,'同entry可见陈述及其当前依赖允许正常模型派发');
 await finish();
 checks.push('同entry四条陈述共享目录前缀，按前三个excerpt的原坐标登记支持与出处，第四条不新增登记');
 // 三类合成资料分别填满真实24KiB回执，独立检查最小目录与整项省略后的登记。
 const storeCapacityObjects=objects=>{
  const statements=[];
  for(const object of objects){
   const encoded=Buffer.from(JSON.stringify(object)).toString('hex'),value=`CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON)`;
   statements.push(`INSERT INTO knowledge_objects(id,space_id,kind,name,version,state,body,source_id,source_version,updated_by)
    VALUES('${object.id}','demo','${object.kind}','${object.name}',1,'enabled',${value},NULL,0,'synthetic-test')`,
    `INSERT INTO knowledge_versions(object_id,version,body) VALUES('${object.id}',1,${value})`,
    `INSERT INTO retrieval_documents(object_id,space_id,version,body) VALUES('${object.id}','demo',1,${value})`);
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
  const result=await invoke('search_knowledge',{query,limit:30});
  assert.equal(result.search_coverage.candidate_count,30,'三十个规范内容必须实际进入搜索');
  assert.equal(result.reply_coverage.state,'bounded');
  assert.ok(Buffer.byteLength(JSON.stringify(result))<=24064,'正式回执须遵守既有内容容量');
  const minimal=result.objects.filter(object=>object.entries.every(entry=>entry.effective_value==='')&&object.retrieval.excerpts.length===0);
  const omitted=result.reply_coverage.omitted_objects;
  assert.ok(minimal.length>0,'必须真实触发最小目录，不能只测三entry上限');
  assert.ok(omitted.length>0,'必须真实触发整项省略');
  assert.equal(result.objects.length+omitted.length,30,'被省略项须保留全部同版补读引用');
  const after=h.sql(`SELECT authority_snapshot FROM agent_runs WHERE id='${run.run_id}'`)[0];
  const visible=new Set(result.objects.map(object=>object.id)),withText=new Set(result.objects.filter(object=>object.entries.some(entry=>entry.effective_value!=='')||object.retrieval.excerpts.length>0).map(object=>object.id));
  assert.deepEqual(after.knowledge.filter(reference=>objects.some(object=>object.id===reference[0])).map(reference=>reference[0]).sort(),[...visible].sort(),
   '仅最终交付对象登记自身版本；omitted目录不能变成已采用对象');
  const expected=variant==='mapped'?withText:visible;
  if(variant==='mapped'){
   assert.deepEqual(after.knowledge.filter(reference=>supports.some(object=>object.id===reference[0])).map(reference=>reference[0]).sort(),
    supports.filter((_,index)=>expected.has(objects[index].id)).map(object=>object.id).sort(),'最小目录零正文不能登记映射支持');
   assert.deepEqual(after.sources.filter(reference=>sources.some(object=>'document-'+object.id===reference[0])).map(reference=>reference[0]).sort(),
    sources.filter((_,index)=>expected.has(objects[index].id)).map(object=>'document-'+object.id).sort(),'最小目录与整项省略均不登记未交付陈述出处');
  }else if(variant==='legacy'){
   assert.deepEqual(after.sources.filter(reference=>sources.some(object=>'document-'+object.id===reference[0])).map(reference=>reference[0]).sort(),
    sources.filter((_,index)=>expected.has(objects[Math.floor(index/2)].id)).map(object=>'document-'+object.id).sort(),
    '最小legacy目录仍登记两份完整必要来源，整项省略才不登记');
  }else{
   for(const object of minimal){
    const index=objects.findIndex(value=>value.id===object.id);
    assert.deepEqual(object.structure_dependencies,[{object_id:tables[index].id,version:'1',path:'ddl'}],
     '最小目录保留已核验的结构绑定及补读位置');
    assert.equal(object.entries[0].effective_structure,null);
    assert.equal(object.entries[0].structure_page.next_offset,0);
   }
   assert.deepEqual(after.knowledge.filter(reference=>tables.some(object=>object.id===reference[0])).map(reference=>reference[0]).sort(),
    tables.filter((_,index)=>expected.has(objects[index].id)).map(object=>object.id).sort(),'结构依赖按最终保留目录登记，整项省略不登记');
  }
  assert.equal((await issue()).status,200,'裁剪后登记的当前依赖须允许正常模型派发');
  await finish();
  checks.push(variant+'容量裁剪：最小目录'+minimal.length+'项、整项省略'+omitted.length+'项，正文/legacy完整来源/结构绑定按最终可见内容登记');
 }
 passed=true;console.log(JSON.stringify({passed,checks,officialRequests:0}));
}finally{await writeFile('.local/checks/mvp-context-dependencies.json',JSON.stringify({passed,checks,officialRequests:0},null,2));await h.close();}

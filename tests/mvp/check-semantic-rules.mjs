import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness} from './harness.mjs';

// 真API/知识版本/平台SQLite；手动工具输入只证明宿主行为，不冒称模型推断效果。
const h = await harness({capture:true,startWorker:false});
const checks = [];
const manager = SessionManager.inMemory('/synthetic/data-agent');
let run, passed = false;
const read = async id => {
  const response = await h.request('/knowledge/'+id);
  assert.equal(response.status,200,JSON.stringify(response.value));
  return response.value;
};
const entry = (object,id='description') => object.entries.find(entry=>entry.entry_id===id);
const patch = (object,value,structure,id='description',extra={}) => h.request('/knowledge/'+object.id,{
  operation_id:randomUUID(),expected_version:object.version,entry_id:id,value,
  ...(structure===undefined?{}:{structured_value:structure}),...extra,
},'alice','PATCH');
const ref = (object,path) => ({object_id:object.id,version:object.version,path});
const tool = async (name,args,error) => {
  const input={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:randomUUID(),tool_name:name,arguments:args,
    checkpoint:exportCheckpoint(manager,run.workspace_context.authority_revision,run.workspace_context.authority_snapshot)};
  const registration=await h.internal('/internal/data/tool-calls',input);
  assert.equal(registration.status,200,JSON.stringify(registration.value));
  const response=await h.internal('/internal/data/tools',input);
  if(error)assert.equal(response.value.code,error,JSON.stringify(response.value));
  else assert.equal(response.status,200,JSON.stringify(response.value));
  return response.value.data;
};
try {
  let table=await read('table-demo_order_detail');
  assert.equal(entry(table).effective_structure.kind,'table');
  assert.deepEqual(entry(table).effective_structure.unique_keys,[['order_id','line_id']]);
  const structure={kind:'table',grain:'一行一个订单商品行，使用完整订单行键',unique_keys:[['order_id','line_id']],
    time_columns:[{column:'paid_at',role:'payment'},{column:'order_date',role:'order'}],default_filters:[],constraints:[]};
  const command={operation_id:randomUUID(),expected_version:table.version,entry_id:'description',
    value:'维护者同时核对的说明与计算规则',structured_value:structure};
  const saved=await h.request('/knowledge/'+table.id,command,'alice','PATCH');
  assert.equal(saved.status,200,JSON.stringify(saved.value));
  assert.deepEqual(entry(saved.value).effective_structure,structure);
  assert.deepEqual(entry(saved.value).human_override.structured_value,structure);
  assert.deepEqual((await h.request('/knowledge/'+table.id,command,'alice','PATCH')).value,saved.value);
  assert.equal((await h.request('/knowledge/'+table.id,{...command,operation_id:randomUUID()},'alice','PATCH')).value.code,'version_conflict');
  assert.equal((await h.request('/knowledge/'+table.id,{...command,expected_version:saved.value.version,operation_id:randomUUID()},'bob','PATCH')).status,403);
  const old=(await h.request('/knowledge/'+table.id+'?version='+table.version)).value;
  assert.equal(entry(old).human_override,null);
  checks.push('文字和结构原子保存、不可变历史、幂等及负责人/旧版校验');
  table=saved.value;
  const beforeInvalid=await read(table.id);
  const invalid=await patch(table,'错误列不应保存',{...structure,unique_keys:[['missing_column']]});
  assert.equal(invalid.status,400,JSON.stringify(invalid.value));
  assert.deepEqual(await read(table.id),beforeInvalid);
  checks.push('不存在的列在业务边界拒绝，失败不推进知识版本');
  const reanalysis=await h.request('/knowledge/'+table.id+'/reanalyze',{operation_id:randomUUID(),expected_version:table.version});
  assert.equal(reanalysis.status,200,JSON.stringify(reanalysis.value));
  table=reanalysis.value;
  assert.deepEqual(entry(table).effective_structure,structure);
  assert.equal(entry(table).effective_value,command.value);
  assert.equal(entry(table).review_state,'needs_review');
  assert.equal(entry(table).source_facts.structured_value.kind,'table');
  checks.push('重预填同时保留人工说明和结构，来源候选并存且标明待复核');

  table=(await patch(table,'旧客户端只修改说明',undefined)).value;
  assert.equal(entry(table).effective_structure,null);
  assert.equal(entry(table).effective_value,'旧客户端只修改说明');
  table=(await patch(table,'',undefined,'description',{clear_override:true})).value;
  assert.equal(entry(table).human_override,null);
  assert.equal(entry(table).effective_structure.kind,'table');
  checks.push('旧客户端只改文字时不借用旧结构，清除人工层时文字和结构一起恢复');

  let metric=await read('metric-net_revenue');
  const metricRule={...entry(metric,'definition').effective_structure,table:{object_id:table.id,version:table.version}};
  metric=(await patch(metric,'维护者核对的净收入定义',metricRule,'definition')).value;
  assert.equal(entry(metric,'definition').review_state,'confirmed');
  metric=(await patch(metric,'SELECT SUM(paid_amount_cents) FROM demo_order_detail',undefined,'sql')).value;
  assert.deepEqual(entry(metric,'definition').effective_structure,metricRule);
  assert.equal(entry(metric,'definition').review_state,'needs_review');
  checks.push('同一指标的另一SQL条目变动后保留结构并要求重新核对，不沿用已确认标签');

  const lines=await read('table-raw_order_lines'), payments=await read('table-raw_payments');
  const created=await h.request('/knowledge',{operation_id:randomUUID(),kind:'relationship',name:'订单商品行到付款事件',body:'按订单和行关联，付款事件可能多条',source_url:null,related_ids:[lines.id,payments.id]});
  assert.equal(created.status,200,JSON.stringify(created.value));
  const relationStructure={kind:'relationship',left_table:{object_id:lines.id,version:lines.version},right_table:{object_id:payments.id,version:payments.version},
    join_keys:[{left_column:'order_id',right_column:'order_id'},{left_column:'line_id',right_column:'line_id'}],cardinality:'one_to_many',scope:'未预聚合的付款事件'};
  const relation=(await patch(created.value,'按完整复合键关联；一行可以有多笔付款',relationStructure,'body')).value;
  assert.equal(entry(relation,'body').effective_structure.kind,'relationship',JSON.stringify(relation));
  const badRef=await patch(relation,'错误依赖不允许保存',{...relationStructure,right_table:{object_id:payments.id,version:'9999'}},'body');
  assert.equal(badRef.value.code,'stale_knowledge');
  checks.push('关系引用真实列和当前版本，过期依赖不能保存');

  await h.resumeWorker();
  const cid=await h.create(); run=await h.capture(cid,'先检查并展示SQL，不执行。'); await h.pauseWorker();
  const fullStructure=entry(table).effective_structure;
  const first=await tool('read_knowledge',{object_id:table.id,version:table.version,entry_id:'description',structure_only:true,limit:32});
  assert.equal(first.entries[0].effective_structure,null);
  assert.equal(first.entries[0].structure_page.complete,false);
  let text=first.entries[0].structure_text, next=first.entries[0].structure_page.next_offset;
  while(next!==null){
    const page=await tool('read_knowledge',{object_id:table.id,version:table.version,entry_id:'description',structure_only:true,offset:next,limit:32});
    text+=page.entries[0].structure_text;next=page.entries[0].structure_page.next_offset;
  }
  assert.deepEqual(JSON.parse(text),fullStructure);
  const beforeRelation=h.sql(`SELECT authority_snapshot FROM agent_runs WHERE id='${run.run_id}'`)[0];
  assert.ok(!beforeRelation.knowledge.some(reference=>reference[0]===lines.id));
  const normal=await tool('read_knowledge',{object_id:relation.id,version:relation.version,entry_id:'body'});
  assert.deepEqual(normal.entries[0].effective_structure,relationStructure);
  assert.ok(normal.structure_dependencies.some(reference=>reference.object_id===lines.id&&reference.version===lines.version&&reference.path==='ddl'));
  const afterRelation=h.sql(`SELECT authority_snapshot FROM agent_runs WHERE id='${run.run_id}'`)[0];
  assert.ok(afterRelation.knowledge.some(reference=>reference[0]===lines.id&&reference[1]===lines.version));
  assert.ok(afterRelation.knowledge.some(reference=>reference[0]===payments.id&&reference[1]===payments.version));
  checks.push('实际受控工具可读取有效结构，大结构逐页复原而非截坏JSON');

  const refs=[ref(relation,'body'),ref(lines,'ddl'),ref(payments,'ddl')];
  const sql='SELECT SUM(l.quantity) AS quantity FROM raw_order_lines l JOIN raw_payments p ON l.order_id=p.order_id AND l.line_id=p.line_id';
  const validation=await tool('validate_sql',{sql,parameters:{},target_id:'synthetic-sqlite',knowledge_refs:refs});
  assert.equal(validation.state,'passed');
  assert.ok(validation.semantic_checks.checks.some(check=>check.rule==='aggregate_cardinality'&&check.state==='warning'),JSON.stringify(validation));
  const missingKey=await tool('validate_sql',{sql:sql.replace(' AND l.line_id=p.line_id',''),parameters:{},target_id:'synthetic-sqlite',knowledge_refs:refs});
  assert.ok(missingKey.semantic_checks.checks.some(check=>check.rule==='join_keys'&&check.state==='warning'));
  const stale=await tool('validate_sql',{sql,parameters:{},target_id:'synthetic-sqlite',knowledge_refs:[{...refs[0],version:'9999'}]});
  assert.ok(stale.semantic_checks.coverage.missing_semantics.length>0);
  const unsupported=await tool('validate_sql',{sql:'WITH rows AS (SELECT * FROM raw_order_lines) SELECT SUM(quantity) FROM rows',parameters:{},target_id:'synthetic-sqlite',knowledge_refs:refs});
  assert.equal(unsupported.state,'passed');
  assert.equal(unsupported.semantic_checks.coverage.sql_shape,'unsupported');
  checks.push('真平台语法通过与有界业务诊断分开；漏键/放大风险、过期结构和复杂SQL覆盖缺口可见');

  const conditions={time_start:null,time_end:null,timezone:'UTC',metric:null,channel:null,group_by:[],filters:[],knowledge_refs:[],notes:''};
  const task=await tool('update_analysis_task',{action:'create',goal:'核对关联数量',conditions,options:[]});
  const query=await tool('request_query',{task_id:task.task_id,condition_version:task.condition_version,sql,parameters:{},target_id:'synthetic-sqlite',summary:'等待用户授权的关联检查',knowledge_refs:refs,replaces_query_id:null});
  assert.equal(query.execution_state,'not_submitted');
  assert.ok(query.semantic_checks.checks.some(check=>check.state==='warning'));
  await tool('request_query',{task_id:task.task_id,condition_version:task.condition_version,sql,parameters:{},target_id:'synthetic-sqlite',summary:'旧依赖不能生成正式草稿',knowledge_refs:[{...refs[0],version:'9999'}],replaces_query_id:null},'stale_knowledge');
  assert.equal(h.sql('SELECT JSON_OBJECT("n",COUNT(*)) FROM query_requests WHERE confirmation_message_id IS NOT NULL')[0].n,0);
  checks.push('非阻断诊断进入草稿工具回执；没有用户执行意图即无提交，正式草稿仍拒绝旧引用');

  const authority=h.sql(`SELECT authority_snapshot FROM agent_runs WHERE id='${run.run_id}'`)[0];
  assert.equal(authority.dependency_schema,5);
  assert.ok(authority.knowledge.some(reference=>reference[0]===lines.id&&reference[1]===lines.version));
  const beforeChange=await h.internal('/internal/model/issue',{run_id:run.run_id,lease_epoch:run.lease_epoch,call_attempt_id:randomUUID()});
  assert.equal(beforeChange.status,200,JSON.stringify(beforeChange.value));
  const changed=(await patch(lines,'订单商品行资料已变化，原关联应重新核对',undefined)).value;
  assert.notEqual(changed.version,lines.version);
  const issued=await h.internal('/internal/model/issue',{run_id:run.run_id,lease_epoch:run.lease_epoch,call_attempt_id:randomUUID()});
  assert.equal(issued.value.code,'stale_context',JSON.stringify(issued.value));
  checks.push('只读关系规则也登记嵌套表版本；依赖变化阻止旧上下文继续发送模型');
  passed=true;
}finally{
  await mkdir('.local/checks',{recursive:true});
  await writeFile('.local/checks/semantic-rules.json',JSON.stringify({passed,checks,official_model_calls:0,scope:'实际API/MySQL/平台，受控工具宿主验证；不证明真实模型语义判断'},null,2)+'\n');
  await h.close();
}
console.log(JSON.stringify({passed,checks:checks.length,official_model_calls:0}));

import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness, until} from './harness.mjs';
import {ok} from './skill-fixtures.mjs';

execFileSync(homedir()+'/.cargo/bin/cargo',['test','--offline','--locked','-p','data-agent','--lib','modules::queries::result_statistics'],{stdio:'inherit'});
const h=await harness({capture:true,env:{DATA_AGENT_LEASE_MS:'120000',DATA_AGENT_QUERY_DELAY_SECONDS:'0.1'}});
const manager=SessionManager.inMemory('/synthetic/data-agent');
const checks=[];let passed=false,run;
const checkpoint=()=>exportCheckpoint(manager,run.workspace_context.authority_revision,run.workspace_context.authority_snapshot);
const invoke=async(name,args)=>{
  const input={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:randomUUID(),tool_name:name,arguments:args,checkpoint:checkpoint()};
  ok(await h.internal('/internal/data/tool-calls',input));
  return ok(await h.internal('/internal/data/tools',input)).data;
};
try {
  const cid=await h.create();run=await h.capture(cid,'给我合成订单明细及边界样例SQL，暂不执行');await h.pauseWorker();
  const task=await invoke('update_analysis_task',{action:'create',goal:'核对已有结果的确定性统计',conditions:{time_start:null,time_end:null,timezone:'UTC',metric:null,channel:null,group_by:[],filters:[],knowledge_refs:[],notes:''},options:[]});
  const sqls=[
    'SELECT order_id,paid_amount_cents,refunded_amount_cents FROM demo_order_detail WHERE is_test=0 ORDER BY order_id,line_id',
    'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<205) SELECT x FROM n',
    'SELECT 1 AS value WHERE 0',
    'SELECT 9007199254740993 AS amount UNION ALL SELECT -5 UNION ALL SELECT 0 UNION ALL SELECT NULL',
    'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1005) SELECT x FROM n',
  ];
  const queries=[];
  for(const sql of sqls)queries.push(await invoke('request_query',{task_id:task.task_id,condition_version:task.condition_version,sql,parameters:{},target_id:'synthetic-sqlite',replaces_query_id:null,summary:'合成结果统计验证',knowledge_refs:[]}));
  await invoke('update_analysis_task',{action:'route',task_id:task.task_id,expected_version:task.condition_version,goal:'',options:[]});
  const text='SQL已准备好。';
  ok(await h.internal('/internal/outputs',{run_id:run.run_id,lease_epoch:run.lease_epoch,chunk_seq:'1',text}));
  ok(await h.internal('/internal/finish',{run_id:run.run_id,lease_epoch:run.lease_epoch,commit_id:run.output_id,final_text:text,checkpoint:checkpoint()}));h.releaseRun(run.run_id);
  for(const q of queries)ok(await h.request('/queries/'+q.id+'/confirm',{operation_id:randomUUID(),draft_version:q.draft_version,condition_version:q.condition_version}));
  await h.resumeWorker();
  for(const q of queries)await until(async()=>ok(await h.request('/queries/'+q.id)).execution_state==='succeeded','query finished');
  const result=async(q,cursor='')=>ok(await h.request('/queries/'+q.id+'/results'+(cursor?'?cursor='+cursor:'')));
  const orders=await result(queries[0]);
  assert.equal(orders.statistics.scope,'complete_result');assert.equal(orders.statistics.row_count,14);
  assert.equal(orders.statistics.columns[0].distinct_count,12);
  assert.deepEqual(orders.statistics.columns[0].repeated_values,[{value:'O1001',count:2},{value:'O1013',count:2}]);
  assert.deepEqual(orders.statistics.columns[1].numeric_counts,{negative:0,zero:2,positive:12});
  assert.equal(orders.rows.length,14);checks.push('独立合成参考：14行、12单，O1001/O1013各2行；12行有支付、2行零支付，不混入净额口径');
  const first=await result(queries[1]),last=await result(queries[1],'200');
  assert.equal(first.statistics.row_count,100);assert.equal(last.statistics.row_count,5);
  assert.equal(first.statistics.scope,'page');assert.equal(last.statistics.scope,'page');
  assert.equal(last.fetched_offset,'200');assert.equal(last.next_cursor,null);
  const truncated=await result(queries[4]);assert.equal(truncated.truncated,true);assert.equal(truncated.statistics.scope,'page');
  checks.push('首尾页与1000行截断都标记当前页；最后一页没有冒充全量');
  assert.equal((await result(queries[2])).statistics.row_count,0);
  const exact=await result(queries[3]);assert.equal(exact.rows[0][0],'9007199254740993');
  assert.deepEqual(exact.statistics.columns[0],{column_index:0,column_name:'amount',non_null_count:3,null_count:1,distinct_count:3,repeated_values:[],numeric_counts:{negative:1,zero:1,positive:1}});
  assert.notEqual((await h.request('/queries/'+queries[0].id+'/results',undefined,'bob')).status,200);
  checks.push('空结果、NULL、大整数和负数统计正确，其他用户不能读取统计');
  run=await until(()=>h.captured.find(r=>r.run_id!==run.run_id&&r.conversation_id===cid),'result delivery');
  const toolResult=await invoke('get_query',{query_id:queries[0].id});
  assert.deepEqual(toolResult.results.statistics,orders.statistics);
  assert.equal(ok(await h.request('/conversations/'+cid+'/queries')).queries.length,sqls.length);
  checks.push('现有get_query将同一统计交给Pi，读取未新增查询或修改SQL');
  passed=true;console.log(JSON.stringify({passed,checks,officialRequests:0}));
} finally {
  await mkdir('.local/dogfood-repairs',{recursive:true});
  await writeFile('.local/dogfood-repairs/result-statistics.json',JSON.stringify({passed,checks},null,2));
  await h.close();
}

import assert from 'node:assert/strict';
import {writeFile,mkdir,readFile} from 'node:fs/promises';
import {deriveCapacityPlan,planForProfile,assertRuntimeOverhead,effectiveOutputCap,capacityRanges} from '../../packages/contracts/capacity.ts';
import {estimateFixedContextTokens,estimateRequestBytes} from '../../apps/agent/session/request-size.ts';
import {SessionManager,estimateTokens} from '@earendil-works/pi-coding-agent';
import {sessionCapacity} from '../../apps/agent/session/capacity.ts';
import {taskProjection} from '../../apps/agent/session/task-projection.ts';

const checks=[];let passed=false;
try {
  const vectors=JSON.parse(await readFile('tests/contracts/capacity-vectors.json','utf8'));
  for(const v of vectors){
    const plan=deriveCapacityPlan(v.context,v.input,v.output);
    assert.deepEqual(typeof plan==='string'?plan:[plan.historyReserve,plan.toolReserve,plan.keepRecent,plan.trigger,plan.summaryCap,plan.splitSummaryCap],v.failure??v.plan);
    if(v.ranges)assert.deepEqual(capacityRanges(v.context,v.input,v.output),v.ranges);
  }
  checks.push('Rust/TS共用独立容量向量；不可行组合返回固定其他字段时的输入/输出数值范围');
  const latin=estimateFixedContextTokens('a'.repeat(12000),[],[],'测试');
  const chinese=estimateFixedContextTokens('中'.repeat(12000),[],[],'测试');
  assert.equal(chinese,latin,'Pi字符启发式不把中文UTF-8字节当token');
  assert.ok(chinese>=3000&&chinese<4200);
  assert.ok(estimateRequestBytes('中'.repeat(12000),[],[],[],'测试')>estimateRequestBytes('a'.repeat(12000),[],[],[],'测试')+23000,'字节门槛仍区分实际UTF-8大小');
  checks.push('固定开销沿Pi字符估算；中文不再按UTF-8三倍膨胀，独立字节预检仍保留');
  // 与Rust model_configuration::capacity同向量的初值反例；两侧公式必须同时成立。
  const initial=deriveCapacityPlan(1000000,900000,65536);
  assert.equal(typeof initial,'object');
  assert.deepEqual(
    [initial.historyReserve,initial.trigger,initial.keepRecent,initial.toolReserve,initial.summaryCap,initial.splitSummaryCap],
    [120000,880000,65536,20000,65536,65536],
  );
  checks.push('DeepSeek初值C=1M/I=900000/O=65536：R=120000、T=880000、K=65536、H=20000、Pi1.4 S1=S2=65536');

  const longOutput=deriveCapacityPlan(1000000,900000,131072);
  assert.equal(longOutput.trigger,848928);
  assert.equal(longOutput.historyReserve,151072);
  checks.push('长输出档O=131072：触发线848928、reserve=151072');

  assert.equal(deriveCapacityPlan(131072,65536,65536),'summary_space_insufficient');
  assert.equal(deriveCapacityPlan(65536,65536,65536),'reserve_exceeds_history');
  assert.equal(deriveCapacityPlan(512,4096,2048),'invalid_field');
  // O吞掉全部窗口（O>C）同样以正文不足拒绝，两侧推导一致，不允许负触发线进入运行时。
  assert.equal(deriveCapacityPlan(1024,1024,2048),'reserve_exceeds_history');
  checks.push('反例C=131072/I=O=65536摘要空间不足被拒；C=65536/I=O=65536预留超正文被拒；窗口<1024拒绝；O>C正文不足拒绝');

  const plan=deriveCapacityPlan(1000000,900000,65536);
  const slack=plan.trigger-plan.summaryCap-plan.splitSummaryCap-plan.keepRecent;
  assert.equal(assertRuntimeOverhead(plan,slack-1),null);
  assert.equal(assertRuntimeOverhead(plan,slack),'fixed_overhead_insufficient');
  checks.push('运行时固定开销F严格小于触发线余量；K不因平均消息长度缩小');

  // legacy profile（缺context_window）不进入新公式；输出cap=min(SDK当次,冻结上限,端点上限)。
  assert.equal(planForProfile({input_limit:65536,output_limit:8192}),null);
  assert.deepEqual(
    [effectiveOutputCap(16000,undefined,undefined),effectiveOutputCap(16000,5000,undefined),effectiveOutputCap(16000,undefined,8000),effectiveOutputCap(16000,9000,7000)],
    [16000,5000,8000,7000],
  );
  checks.push('缺context_window走legacy；实际输出cap=min(SDK当次maxTokens,冻结输出,已知端点上限)');

  // 1.4分段时可能直接沿用旧摘要；2O+K不包含它的真实长度或SDK文件附记。
  const manager=SessionManager.inMemory('/synthetic/capacity');
  const firstKeptEntryId=manager.appendMessage({role:'user',content:'保留的当前合成输入',timestamp:1});
  const preparation={firstKeptEntryId,messagesToSummarize:[],turnPrefixMessages:[{role:'user',content:'分段前缀',timestamp:1}],isSplitTurn:true,tokensBefore:100,previousSummary:'短旧摘要',fileOps:{read:new Set(),written:new Set(),edited:new Set()},settings:{enabled:true,reserveTokens:plan.historyReserve,keepRecentTokens:plan.keepRecent}};
  for(const kind of ['reused_previous_summary','file_operations']){
    const capacity=sessionCapacity(plan,manager,()=>slack-256);
    assert.equal(capacity.failure(),null);
    const event=structuredClone(preparation);
    if(kind==='reused_previous_summary')event.previousSummary='x'.repeat((plan.summaryCap+1024)*4);
    else event.fileOps.read.add('/skills/'+('synthetic/'.repeat(500))+'SKILL.md');
    await capacity.extension.handlers.get('session_before_compact')[0]({preparation:event});
    assert.equal(capacity.failure(),'fixed_overhead_insufficient',kind+'必须计入压缩后空间');
  }
  checks.push('实际沿用的长旧摘要与原生文件附记突破静态2O+K预算时，摘要发送前拒绝，不降低冻结输出帽');

  // 真实范围替换后沿同一检查器派发；新宿主事实/活动工具增加固定开销时也不能带上已撤下的保留组。
  const scopedPlan=deriveCapacityPlan(65536,50000,8192);
  const scopedManager=SessionManager.inMemory('/synthetic/scoped-capacity');
  const retained={role:'user',content:'x'.repeat((scopedPlan.keepRecent+1500)*4),timestamp:1};
  const retainedId=scopedManager.appendMessage(retained);
  const retainedOverhead=estimateTokens(retained)-scopedPlan.keepRecent;
  const scopedSlack=scopedPlan.trigger-scopedPlan.summaryCap-scopedPlan.splitSummaryCap-scopedPlan.keepRecent;
  let fixed=scopedSlack-retainedOverhead-500;
  const scopedCapacity=sessionCapacity(scopedPlan,scopedManager,()=>fixed);
  await scopedCapacity.extension.handlers.get('session_before_compact')[0]({preparation:{
    firstKeptEntryId:retainedId,messagesToSummarize:[{role:'user',content:'旧范围',timestamp:0}],
    turnPrefixMessages:[],isSplitTurn:false,fileOps:{read:new Set(),written:new Set(),edited:new Set()},
  }});
  scopedCapacity.check();
  const workspace={tasks:[],recent_messages:[],selected_skills:[],memories:[],query_observations:[],
    authority_revision:'1',source_context_ready:true};
  const transport={run:{run_id:'synthetic-run',message_id:'synthetic-message',text:'切换合成范围',workspace_context:workspace},
    binding:()=>({run_id:'synthetic-run',lease_epoch:'1'}),post:async path=>{
      assert.equal(path,'/internal/context/refresh');return workspace;
    }};
  fixed+=1000;
  scopedManager.appendMessage({role:'user',content:'普通追加不替换已有范围',timestamp:2});
  assert.throws(()=>scopedCapacity.check(),/model_input_limit/,'普通leaf追加仍必须计入长保留组');
  fixed-=1000;
  const oldLeaf=scopedManager.getLeafId();
  const projection=taskProjection(transport,scopedManager,()=>{fixed+=1000;});
  projection.acceptReceipt({data:{},context_reset:{task_id:'synthetic-task',condition_version:'2'},source_context_ready:true},'synthetic-route');
  assert.equal((await projection.extension.handlers.get('turn_end')[0]()).continue,true);
  projection.check();
  assert.ok(scopedManager.getEntries().some(entry=>entry.id===retainedId),'原条目仍持久保留');
  assert.ok(!scopedManager.buildSessionProjection().entries.some(entry=>entry.sourceEntry.id===retainedId),'旧保留组已由Pi撤下');
  assert.doesNotThrow(()=>scopedCapacity.check(),'同一范围切换后的首个请求不能被已撤下的旧开销误拒');
  checks.push('真实Pi范围替换后，同一容量检查器按新投影接受动态固定开销；普通追加仍核长保留组，原历史未删除');
  scopedManager.branch(oldLeaf);
  const rollback=taskProjection({...transport,post:async()=>{throw new Error('synthetic_refresh_failed');}},scopedManager,()=>assert.fail('失败刷新不能替换宿主事实'));
  rollback.acceptReceipt({data:{},context_reset:{task_id:'synthetic-task',condition_version:'3'},source_context_ready:true},'synthetic-failed-route');
  await assert.rejects(()=>rollback.apply(),/synthetic_refresh_failed/);
  assert.equal(scopedManager.getLeafId(),oldLeaf);
  assert.throws(()=>scopedCapacity.check(),/model_input_limit/,'刷新回滚恢复原分支时必须重新计入原保留边界');
  checks.push('真实范围刷新失败回到原leaf，原长保留组仍拒绝；不因临时新分支清空开销');

  passed=true;
  console.log(JSON.stringify({passed,checks,officialRequests:0}));
} finally {
  await mkdir('.local/checks',{recursive:true});
  await writeFile('.local/checks/capacity-derivation.json',JSON.stringify({passed,checks,officialRequests:0},null,2));
}

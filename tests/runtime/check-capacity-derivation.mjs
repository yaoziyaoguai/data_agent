import assert from 'node:assert/strict';
import {writeFile,mkdir,readFile} from 'node:fs/promises';
import {deriveCapacityPlan,planForProfile,assertRuntimeOverhead,effectiveOutputCap,capacityRanges} from '../../packages/contracts/capacity.ts';
import {estimateFixedContextTokens,estimateRequestBytes} from '../../apps/agent/session/request-size.ts';

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
    [120000,880000,65536,20000,65536,60000],
  );
  checks.push('DeepSeek初值C=1M/I=900000/O=65536：R=120000、T=880000、K=65536、H=20000、S1=65536、S2=60000');

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

  passed=true;
  console.log(JSON.stringify({passed,checks,officialRequests:0}));
} finally {
  await mkdir('.local/checks',{recursive:true});
  await writeFile('.local/checks/capacity-derivation.json',JSON.stringify({passed,checks,officialRequests:0},null,2));
}

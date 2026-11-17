import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness} from './harness.mjs';

const checks = [];
let h, run, passed = false;
const ok = response => {assert.equal(response.status, 200, JSON.stringify(response.value)); return response.value;};
const manager = SessionManager.inMemory('/synthetic/tool-version-boundary');
const input = (name, args) => ({run_id: run.run_id, lease_epoch: run.lease_epoch, sdk_tool_call_id: randomUUID(),
  tool_name: name, arguments: args, checkpoint: exportCheckpoint(manager,
    run.workspace_context.authority_revision, run.workspace_context.authority_snapshot)});
try {
  h = await harness({capture: true, startWorker: false, env: {DATA_AGENT_LEASE_MS: '120000',
    DATA_AGENT_TOOL_CONTRACT_VERSION: '2', DATA_AGENT_PROVIDER_TEST: '1', DATA_AGENT_PREFILL_PROFILE: '',
    DATA_AGENT_VECTOR_URL: 'http://127.0.0.1:19531', DATA_AGENT_VECTOR_COLLECTION: 'data_agent_test_tool_version_boundary'}});
  await h.resumeWorker(); run = await h.capture(await h.create(), '核对合成工具原合同版本。'); await h.pauseWorker();
  assert.equal(run.tool_contract_version, 2);
  const route = input('update_analysis_task', {action: 'route', task_id: null, expected_version: null, goal: '', options: []});
  const registered = ok(await h.internal('/internal/data/tool-calls', route));
  assert.equal(registered.tool_contract_version, 2, '正式登记必须携带原工具版本，不能让Node按历史1推断');
  const routed = ok(await h.internal('/internal/data/tools', route));
  assert.equal(routed.tool_contract_version, 2);
  const current = input('search_knowledge', {query: '*'});
  assert.equal(ok(await h.internal('/internal/data/tool-calls', current)).tool_contract_version, 2);
  const currentReceipt = ok(await h.internal('/internal/data/tools', current));
  assert.equal(currentReceipt.tool_contract_version, 2); assert.ok(Array.isArray(currentReceipt.data.hits));
  checks.push('新登记与首次成功携带原行合同2');

  const rejected = input('search_knowledge', {query: '*', task_ref: {task_id: 'synthetic-absent', condition_version: '1'}});
  const rejectedRegistration = ok(await h.internal('/internal/data/tool-calls', rejected));
  assert.equal(rejectedRegistration.tool_contract_version, 2);
  assert.equal((await h.internal('/internal/data/tools', rejected)).value.code, 'task_context_required');
  const rejection = ok(await h.internal('/internal/data/tool-rejections', rejected));
  assert.equal(rejection.tool_contract_version, 2);
  assert.equal(rejection.data.error, 'task_context_required');
  assert.deepEqual(ok(await h.internal('/internal/data/tools', rejected)), rejection);
  checks.push('首次明确拒绝携带原版本并冻结重放');

  const legacy = input('search_knowledge', {query: '*'});
  const legacyOperation = ok(await h.internal('/internal/data/tool-calls', legacy)).operation_id;
  // 在隔离合成库装入旧writer默认版本1的登记；当前run仍为2。
  h.sql(`UPDATE tool_calls SET tool_contract_version=1 WHERE operation_id='${legacyOperation}'`);
  assert.equal(ok(await h.internal('/internal/data/tool-calls', legacy)).tool_contract_version, 1);
  const oldReceipt = ok(await h.internal('/internal/data/tools', legacy));
  assert.equal(oldReceipt.tool_contract_version, 1);
  assert.ok(Array.isArray(oldReceipt.data.objects)); assert.equal(Object.hasOwn(oldReceipt.data, 'hits'), false);
  checks.push('原工具1在当前run2仍按1执行和登记');

  // 已保存v2正文与拒绝在旧run1接回时，不依据当前run降级或重做。
  h.sql(`UPDATE agent_runs SET tool_contract_version=1 WHERE id='${run.run_id}'`);
  assert.equal(ok(await h.internal('/internal/data/tool-calls', current)).tool_contract_version, 2);
  assert.deepEqual(ok(await h.internal('/internal/data/tools', current)), currentReceipt);
  assert.equal(ok(await h.internal('/internal/data/tool-calls', rejected)).tool_contract_version, 2);
  assert.deepEqual(ok(await h.internal('/internal/data/tool-rejections', rejected)), rejection);
  checks.push('原工具2在当前run1接回原成功及拒绝，版本和正文不变');

  h.sql(`UPDATE tool_calls SET receipt=JSON_REMOVE(receipt,'$.tool_contract_version') WHERE operation_id='${legacyOperation}'`);
  const historical = {...oldReceipt}; delete historical.tool_contract_version;
  assert.equal(ok(await h.internal('/internal/data/tool-calls', legacy)).tool_contract_version, 1);
  assert.deepEqual(ok(await h.internal('/internal/data/tools', legacy)), historical, '历史已存正文不为补元信息改写');
  const saved = h.sql(`SELECT receipt FROM tool_calls WHERE operation_id='${legacyOperation}'`)[0];
  assert.deepEqual(saved, historical);
  assert.equal(h.sql('SELECT JSON_OBJECT(\'n\',COUNT(*)) FROM model_call_attempts')[0].n, 0);
  checks.push('历史缺版本回执保持原保存值，登记提供原版本1');
  h.releaseRun(run.run_id); passed = true;
  console.log(JSON.stringify({passed, checks, officialRequests: 0}));
} finally {
  if (h) {await writeFile(h.directory + '/evidence-tool-versions.json', JSON.stringify({passed, checks, officialRequests: 0}, null, 2)); await h.close();}
}

import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {validateContract} from '../../packages/contracts/validate.ts';
import {harness} from './harness.mjs';
import {assetInput, select} from './skill-fixtures.mjs';

let manager = SessionManager.inMemory('/synthetic/evidence-read-capacity');
const checks = [], observations = [];
let h, run, passed = false;
const ok = response => {assert.equal(response.status, 200, JSON.stringify(response.value)); return response.value;};
const budget = max_bytes => ({max_bytes, estimated_tokens: max_bytes, projection_fingerprint: '0'.repeat(64)});
const invoke = async (name, args, maxBytes, expectedError) => {
  const input = {run_id: run.run_id, lease_epoch: run.lease_epoch, sdk_tool_call_id: randomUUID(),
    tool_name: name, arguments: args, checkpoint: exportCheckpoint(manager,
      run.workspace_context.authority_revision, run.workspace_context.authority_snapshot),
    ...(maxBytes === undefined ? {} : {response_budget: budget(maxBytes)})};
  const registered = ok(await h.internal('/internal/data/tool-calls', input));
  const response = await h.internal('/internal/data/tools', input);
  if (expectedError) {
    assert.notEqual(response.status, 200, '无内容推进的容量不足不能返回成功空页：' + JSON.stringify(response.value));
    assert.equal(response.value.code, expectedError);
    const rejection = ok(await h.internal('/internal/data/tool-rejections', input));
    assert.equal(rejection.operation_id, registered.operation_id);
    assert.equal(rejection.data.error, expectedError);
    assert.equal(Object.hasOwn(rejection.data, 'items'), false);
    assert.deepEqual(ok(await h.internal('/internal/data/tools', input)), rejection);
    observations.push({tool: name, maxBytes, error: expectedError});
    return;
  }
  const receipt = ok(response);
  if (name === 'read_knowledge') validateContract('KnowledgeReadReply', receipt.data);
  const bytes = Buffer.byteLength(JSON.stringify(receipt.data));
  if (maxBytes !== undefined) assert.ok(bytes <= maxBytes, '最终完整JSON受共同容量限制');
  assert.deepEqual(receipt, h.sql(`SELECT receipt FROM tool_calls WHERE operation_id='${registered.operation_id}'`)[0]);
  observations.push({tool: name, maxBytes, bytes});
  return receipt.data;
};
try {
  h = await harness({capture: true, startWorker: false, env: {DATA_AGENT_LEASE_MS: '120000',
    DATA_AGENT_TOOL_CONTRACT_VERSION: '2', DATA_AGENT_PROVIDER_TEST: '1', DATA_AGENT_PREFILL_PROFILE: '',
    DATA_AGENT_VECTOR_URL: 'http://127.0.0.1:19531', DATA_AGENT_VECTOR_COLLECTION: 'data_agent_test_read_capacity'}});
  const memory = ok(await h.request('/assets', assetInput({kind: 'memory', name: '合成最小记忆页',
    body: '甲'.repeat(2000), scope: '仅合成容量核验。', source_text: ''})));
  const skillScope = '合成方法范围须核对原生正文。'.repeat(100);
  const skill = ok(await h.request('/assets', assetInput({name: '合成最小方法描述', scope: skillScope})));
  const cid = await h.create(); ok(await select(h, cid, skill));
  await h.resumeWorker(); run = await h.capture(cid, '核对合成资产与当前结构的小容量补读。'); await h.pauseWorker();
  await invoke('update_analysis_task', {action: 'route', task_id: null, expected_version: null, goal: '', options: []});
  const memoryItem = {kind: 'memory', asset_ref: {id: memory.id, version: memory.version}, part: 'body'};
  const one = await invoke('read_knowledge', {items: [{...memoryItem, limit: 1}]});
  assert.equal(one.items[0].asset.body, '甲');
  const empty = structuredClone(one);
  empty.items[0].asset.body = '';
  empty.items[0].asset.content_page.next_offset = 0;
  empty.items[0].asset.scope = '';
  empty.items[0].asset.scope_page = {offset: 0, total_chars: [...memory.scope].length, complete: false, next_offset: 0};
  validateContract('KnowledgeReadReply', empty);
  const metadataBytes = Buffer.byteLength(JSON.stringify(empty));
  await invoke('read_knowledge', {items: [{...memoryItem, limit: 4096}]}, metadataBytes, 'tool_response_capacity');
  const next = await invoke('read_knowledge', {items: [{...memoryItem, limit: 4096}]}, metadataBytes + 60);
  assert.ok(next.items[0].asset.body.length > 0);
  assert.equal(next.items[0].asset.body, memory.body.slice(0, next.items[0].asset.body.length));
  assert.equal(next.items[0].asset.content_page.next_offset, [...next.items[0].asset.body].length);
  checks.push('记忆只有空身份页放得下时明确容量错误，稍大余量交付实际正文并推进');

  const skillItem = {kind: 'skill', asset_ref: {id: skill.id, version: skill.version}};
  const descriptor = (await invoke('read_knowledge', {items: [skillItem]}, 700)).items[0];
  assert.equal(descriptor.state, 'ok');
  assert.equal(descriptor.asset.id, skill.id); assert.equal(descriptor.asset.version, skill.version);
  assert.equal(descriptor.asset.native_path, `/skills/${skill.id}/${skill.version}/SKILL.md`);
  assert.equal(descriptor.asset.selected, true);
  assert.equal(descriptor.asset.body, ''); assert.equal(descriptor.asset.source_text, '');
  assert.equal(descriptor.asset.scope_page.complete, false);
  assert.equal(descriptor.asset.scope_page.total_chars, [...skillScope].length);
  assert.equal(descriptor.asset.scope_page.next_offset, [...descriptor.asset.scope].length);
  assert.equal(descriptor.asset.scope, [...skillScope].slice(0, [...descriptor.asset.scope].length).join(''));
  await invoke('read_knowledge', {items: [skillItem]}, 1, 'tool_response_capacity');
  checks.push('长Skill范围保当前已选descriptor与原生路径，最小身份也放不下时明确拒绝');

  let table = ok(await h.request('/knowledge/table-demo_order_detail'));
  const structure = {kind: 'table', grain: '每行一条合成设备登记', unique_keys: [['order_id', 'line_id']],
    time_columns: [{column: 'paid_at', role: '支付时间'}], default_filters: [], constraints: ['合成结构约束。'.repeat(150)]};
  table = ok(await h.request('/knowledge/' + table.id, {operation_id: randomUUID(), expected_version: table.version,
    entry_id: 'description', value: '合成设备明细规则', structured_value: structure}, 'alice', 'PATCH'));
  const structureItem = {kind: 'knowledge', ref: {object_id: table.id, version: table.version, path: 'description'}, structure_only: true, limit: 65536};
  let offset = 0, combined = '';
  for (let page = 0; page < 12; page++) {
    const item = (await invoke('read_knowledge', {items: [{...structureItem, offset}]}, 2000)).items[0];
    assert.equal(item.state, 'ok'); assert.equal(item.structure_coverage.state, 'complete');
    assert.equal(item.structure_page.offset, offset);
    assert.equal(item.effective_structure, null, '容量裁过或非零起点的JSON片段不能作为完整结构采用');
    assert.ok(item.structure_text.length > 0);
    assert.equal(item.structure_text, item.content);
    combined += item.structure_text;
    const nextOffset = item.structure_page.next_offset;
    assert.equal(item.continuation.content_next_offset, nextOffset);
    if (nextOffset === null) break;
    assert.equal(nextOffset, [...combined].length); assert.ok(nextOffset > offset); offset = nextOffset;
    assert.ok(page < 11, '结构续页必须有界推进');
  }
  assert.deepEqual(JSON.parse(combined), structure);
  const whole = (await invoke('read_knowledge', {items: [structureItem]})).items[0];
  assert.deepEqual(whole.effective_structure, structure);
  checks.push('结构按最终容量保独立Unicode页，裁剪页和尾页不发布effective_structure');

  // 只修改隔离合成来源，仍由正式重分析与工具采用入口核当前列绑定。
  const source = h.sql("SELECT JSON_OBJECT('version',h.version,'body',s.body) FROM source_heads h JOIN source_snapshots s ON s.source_id=h.id AND s.version=h.version WHERE h.id='schema'")[0];
  const schema = source.body.replace(/CREATE TABLE demo_order_detail \([\s\S]*?\);/, ddl => ddl
    .replace('    line_id INTEGER NOT NULL,\n', '').replace('PRIMARY KEY (order_id, line_id)', 'PRIMARY KEY (order_id)'));
  assert.notEqual(schema, source.body);
  const revision = Number(source.version) + 1, encoded = Buffer.from(schema).toString('hex');
  const fingerprint = createHash('sha256').update(schema).digest('hex');
  h.sql(`INSERT INTO source_snapshots(source_id,version,body,complete) VALUES('schema',${revision},CONVERT(0x${encoded} USING utf8mb4),TRUE);
    UPDATE source_heads SET version=${revision},fingerprint='${fingerprint}' WHERE id='schema';
    UPDATE source_current SET revision=${revision},body=CONVERT(0x${encoded} USING utf8mb4) WHERE source_id='schema'`);
  table = ok(await h.request('/knowledge/' + table.id + '/reanalyze', {operation_id: randomUUID(), expected_version: table.version}));
  // 已读旧结构的运行会被原authority拒绝；新运行再核当前结构采用状态。
  h.releaseRun(run.run_id);
  await h.resumeWorker(); run = await h.capture(await h.create(), '核对来源删列后的当前结构，不沿用旧依据。'); await h.pauseWorker();
  manager = SessionManager.inMemory('/synthetic/evidence-read-capacity-current');
  await invoke('update_analysis_task', {action: 'route', task_id: null, expected_version: null, goal: '', options: []});
  const invalid = (await invoke('read_knowledge', {items: [{...structureItem, ref: {...structureItem.ref, version: table.version}}]}, 2000)).items[0];
  assert.equal(invalid.state, 'ok'); assert.equal(invalid.effective_structure, null);
  assert.equal(invalid.structure_coverage.state, 'missing_semantics');
  assert.equal(invalid.structure_text, ''); assert.equal(invalid.structure_page.next_offset, null);
  assert.deepEqual(table.entries.find(entry => entry.entry_id === 'description').human_override.structured_value, structure);
  checks.push('当前DDL删列后v2小容量读取拒绝采用旧结构，原人工值仍保留');
  h.releaseRun(run.run_id); passed = true;
  console.log(JSON.stringify({passed, checks, observations, officialRequests: 0}));
} finally {
  if (h) {await writeFile(h.directory + '/evidence-read-capacity.json', JSON.stringify({passed, checks, observations, officialRequests: 0}, null, 2)); await h.close();}
}

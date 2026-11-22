import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {harness} from './harness.mjs';
import {assetInput, editInput, ok} from './skill-fixtures.mjs';

const h = await harness({capture: true, startWorker: false});
const checks = [];
let passed = false;

try {
  const marker = '合成测试：技能适用条件随原资料停用。';
  const source = ok(await h.request('/knowledge', {operation_id: randomUUID(),
    kind: 'document', name: '合成技能适用规则', body: marker, related_ids: []}));
  const asset = ok(await h.request('/assets', assetInput({body: marker,
    dependencies: [{object_id: source.id, version: source.version, path: 'body'}]})));
  const input = {operation_id: randomUUID(), asset_id: asset.id, version: asset.version};
  const choose = (cid, selection = input) => h.request(`/conversations/${cid}/skill-selections`, selection);
  const selectedCount = cid =>
    h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM skill_selections WHERE conversation_id='${cid}'`)[0].n;

  const cid = await h.create();
  const choices = await Promise.all([choose(cid), choose(cid)]);
  const original = ok(choices[0]);
  assert.deepEqual(ok(choices[1]), original);
  assert.equal(original.body, marker);
  assert.equal(selectedCount(cid), 1);
  checks.push('并发同参选择只保存一次，返回同一成功回执');

  const busyCid = await h.create();
  await h.send(busyCid, '新的待处理用户消息');
  assert.equal((await choose(busyCid, {...input, operation_id: randomUUID()})).value.code, 'message_pending');
  assert.equal(selectedCount(busyCid), 0);
  checks.push('有待处理用户消息时拒绝修改技能选择，原会话状态不变');

  const changedCid = await h.create();
  ok(await h.request('/assets', editInput(asset, {body: '完全人工重写的新正文'})));
  assert.equal((await choose(changedCid, {...input, operation_id: randomUUID()})).value.code, 'version_conflict');
  assert.deepEqual(ok(await choose(cid)), original);
  assert.equal(selectedCount(changedCid), 0);
  assert.equal(selectedCount(cid), 1);
  checks.push('当前版本变更后拒绝新的旧版选择，成功操作重放保持原身份');

  ok(await h.request(`/knowledge/${source.id}/disable`, {operation_id: randomUUID(), expected_version: source.version}));
  const hidden = ok(await choose(cid));
  assert.equal(hidden.text_unavailable, true, '成功重放也不得再次交付撤权来源正文');
  assert.equal(hidden.body, '');
  assert.deepEqual(hidden.files, []);
  assert.equal(hidden.id, original.id);
  assert.equal(selectedCount(cid), 1);
  checks.push('依赖停用后原选择仍接回控制身份，隐藏正文且选择不重做');
  passed = true;
} finally {
  await h.close();
  await writeFile('.local/checks/skill-selection-locks.json', JSON.stringify({passed, checks, officialRequests:0}, null, 2));
}
console.log(JSON.stringify({passed, checks, officialRequests: 0}));

import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export const assetInput = (changes = {}) => ({operation_id: randomUUID(), id: null, expected_version: null, kind: 'skill', name: '合成月度分析方法', body: '读取业务口径，展示 SQL 后等待用户确认。', scope: '仅合成订单分析', verified: false, source_text: '仅本人可读的来源备注', dependencies: [], files: [], ...changes});
export const editInput = (asset, changes = {}) => assetInput({id: asset.id, expected_version: asset.version, kind: asset.kind, name: asset.name, body: asset.body, scope: asset.scope, verified: asset.verified, source_text: asset.source_text, dependencies: asset.dependencies, files: asset.files ?? [], ...changes});
export const ok = result => {assert.equal(result.status, 200, JSON.stringify(result.value)); return result.value;};
export const select = (h, cid, asset, user = 'alice') => h.request(`/conversations/${cid}/skill-selections`, {operation_id: randomUUID(), asset_id: asset.id, version: asset.version}, user);

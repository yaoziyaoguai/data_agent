import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {until} from './harness.mjs';

// 生产HTTP保留202/进度两个观察点，测试调用者显式等待终态。
export async function synchronizeSources(h, operation_id=randomUUID(), user='alice') {
  await h.resumeSourceSyncWorker();
  const accepted = await h.request('/source-syncs', {operation_id}, user);
  if (accepted.status !== 202) return accepted;
  const progress = await until(async () => {
    const result = await h.request(accepted.value.status_url, undefined, user);
    assert.equal(result.status, 200, JSON.stringify(result.value));
    return ['completed','failed'].includes(result.value.status) && result;
  }, '来源同步终态', 120000);
  return {...progress, accepted:accepted.value};
}

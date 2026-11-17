import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {until} from './harness.mjs';

// 生产HTTP保留202/进度两个观察点，测试调用者显式等待终态。
export async function synchronizeSources(h, operation_id=randomUUID(), user='alice') {
  await h.resumeSourceSyncWorker();
  const accepted = await h.request('/source-syncs', {operation_id}, user);
  if (accepted.status !== 202) return accepted;
  // 终态等待界按实测导入吞吐重校准：千表目录经每对象依赖登记（快照+指纹+扇出）
  // 实测约10源/秒，1204源≈135秒，原120秒窗口在语义源增量后结构性装不下。
  // 上限只延长等待，不改变completed/failed终态判定，保持有界失败。
  const progress = await until(async () => {
    const result = await h.request(accepted.value.status_url, undefined, user);
    assert.equal(result.status, 200, JSON.stringify(result.value));
    return ['completed','failed'].includes(result.value.status) && result;
  }, '来源同步终态', 240000);
  return {...progress, accepted:accepted.value};
}

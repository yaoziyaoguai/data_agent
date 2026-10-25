import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {harness, until} from './harness.mjs';

// 真实Web/API/Worker/MySQL，平台资料完全合成；capture模式不调用正式模型。
const directory = '.local/checks/source-sync-browser-integration';
await mkdir(directory, {recursive: true});
const h = await harness({web: true, capture: true, startWorker: false});
let browser, page, accepted, completed, passed = false;
const checks = [], errors = [];
try {
  browser = await chromium.launch();
  page = await browser.newPage({viewport: {width: 1280, height: 900}});
  page.on('pageerror', error => errors.push(error.message));
  const login = async user => {
    await page.goto(h.url);
    await page.getByLabel('演示登录凭据').fill(h.tokens[user]);
    await page.getByRole('button', {name: '进入工作台 →', exact: true}).click();
    await page.getByRole('navigation', {name: '主导航'}).getByRole('button', {name: /语义管理/}).click();
    await page.getByRole('heading', {name: '语义管理', exact: true}).waitFor();
    await page.getByText('维护操作', {exact: true}).click();
  };
  await login('alice');
  const received = page.waitForResponse(response => new URL(response.url()).pathname === '/api/source-syncs' && response.request().method() === 'POST');
  await page.getByRole('button', {name: '同步来源', exact: true}).click();
  const response = await received;
  assert.equal(response.status(), 202);
  accepted = await response.json();
  assert.equal(accepted.status, 'queued');
  const progress = page.getByRole('region', {name: '来源同步进度'});
  await progress.getByText('资料同步：等待处理', {exact: true}).waitFor();
  assert.equal(await page.getByRole('button', {name: '同步中…', exact: true}).isDisabled(), true);
  assert.equal((await h.request(accepted.status_url)).value.status, 'queued');
  checks.push('真实按钮收到202批次并展示排队，未启动Worker不假报同步完成');

  await h.resumeWorker();
  completed = await until(async () => {
    const result = await h.request(accepted.status_url);
    assert.equal(result.status, 200);
    assert.notEqual(result.value.status, 'failed', JSON.stringify(result.value));
    return result.value.status === 'completed' && result.value;
  }, 'Worker完成合成平台目录同步', 60000);
  assert.ok(completed.processed_sources > 0);
  assert.equal(completed.raw_index.status, 'pending');
  assert.equal(completed.raw_index.completed, 0);
  assert.ok(completed.raw_index.total > 0);
  await progress.getByText('资料同步：已完成', {exact: true}).waitFor();
  await progress.getByText(`原文索引：等待处理 · 0 / ${completed.raw_index.total}`, {exact: true}).waitFor();
  assert.match(await progress.innerText(), /资料已保存；整理和索引进度分别如下/);
  assert.doesNotMatch(await progress.innerText(), /原文索引：已完成/);
  assert.equal(await page.getByRole('button', {name: '重新同步', exact: true}).isEnabled(), true);
  checks.push('真实Worker保存完成后原文索引仍pending，界面分开展示而不冒称索引可用');
  await page.screenshot({path: directory + '/completed-with-pending-index.png', fullPage: true});

  const deniedRead = await h.request(accepted.status_url, undefined, 'bob');
  const deniedWrite = await h.request('/source-syncs', {operation_id: randomUUID()}, 'bob');
  assert.equal(deniedRead.status, 403); assert.equal(deniedRead.value.code, 'forbidden');
  assert.equal(deniedWrite.status, 403); assert.equal(deniedWrite.value.code, 'forbidden');

  // 另一个空间的持久批次不能通过已知ID读取；管理员权限仍局限于当前空间。
  assert.match(accepted.sync_id, /^[A-Za-z0-9_-]+$/);
  h.sql(`UPDATE catalog_imports SET space_id='synthetic-other-space' WHERE id='${accepted.sync_id}'`);
  const foreignProgress = await h.request(accepted.status_url);
  assert.equal(foreignProgress.status, 404);
  assert.equal(foreignProgress.value.code, 'not_available');
  assert.equal(foreignProgress.value.processed_sources, undefined);
  assert.equal(foreignProgress.value.raw_index, undefined);
  checks.push('当前空间管理员不能读取另一空间批次，错误不附带处理数量或索引进度');

  await page.getByRole('button', {name: '退出', exact: true}).click();
  await page.getByLabel('演示登录凭据').waitFor();
  await login('bob');
  assert.equal(await page.getByRole('button', {name: '同步来源', exact: true}).isDisabled(), true);
  assert.equal(await progress.count(), 0);
  assert.deepEqual(errors, []);
  checks.push('普通用户入口禁用，真实API拒绝提交及读取管理员同步进度；换用户不保留前一进度');
  passed = true;
} finally {
  if (!passed && page) await page.screenshot({path: directory + '/failure.png', fullPage: true}).catch(() => {});
  await browser?.close();
  await h.close();
  await writeFile(directory + '/report.json', JSON.stringify({passed, checks, errors, accepted, completed,
    evidence: {browser: 'Chromium', api: 'real', worker: 'real', storage: 'MySQL', platform: 'synthetic', model: 'capture'}, officialRequests: 0}, null, 2));
  console.log(JSON.stringify({passed, checks, errors, officialRequests: 0}));
}

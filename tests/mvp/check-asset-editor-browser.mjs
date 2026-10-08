import assert from 'node:assert/strict';
import {harness, until} from './harness.mjs';
import {chromium} from 'playwright';
import {mkdir, writeFile} from 'node:fs/promises';
const h = await harness({web: true, capture: true, startWorker: false, startupTimeout: 60000});
const browser = await chromium.launch();
const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
const directory = '.local/checks/asset-editor';
await mkdir(directory, {recursive: true});
const checks = [], errors = [];
page.on('pageerror', e => errors.push(e.message));
let passed = false, release;
const list = async () => (await h.request('/assets')).value.assets;
const open = async name => {
  await page.getByRole('button', {name: '新增个人 Skill', exact: true}).click();
  const form = page.getByRole('dialog');
  await form.getByLabel('名称', {exact: true}).fill(name);
  await form.getByLabel('内容', {exact: true}).fill('合成方法：核对口径，查询由用户确认。');
  await form.getByLabel('适用范围与例外').fill('仅合成订单分析');
  return form;
};
try {
  await page.goto(h.url);
  await page.getByLabel('演示登录凭据').fill(h.tokens.alice);
  await page.getByRole('button', {name: '进入工作台 →'}).click();
  await page.getByRole('navigation', {name: '主导航'}).getByRole('button', {name: /我的积累/}).click();
  await page.getByRole('tab', {name: /^空间公共 Skill/}).click();
  let form = await open('公共入口的私人方法');
  await form.getByRole('button', {name: '保存', exact: true}).click();
  await form.waitFor({state: 'detached'});
  await page.locator('.asset-card').filter({hasText: '公共入口的私人方法'}).waitFor();
  assert.match(await page.getByRole('tab', {selected: true}).innerText(), /^我的 Skill/);
  const created = (await list()).find(v => v.name === '公共入口的私人方法');
  assert.equal(created.visibility, 'personal');
  assert.equal((await h.request('/assets', undefined, 'bob')).value.assets.some(v => v.id === created.id), false);
  checks.push('公共入口新建后显示私人分类中的新条目，未自动公开给其他成员');

  let intercepted = false;
  const delayed = new Promise(resolve => { release = resolve; });
  await page.route('**/api/assets', async route => {
    if (route.request().method() === 'POST' && route.request().postDataJSON().name === '第一份慢保存') {
      const response = await route.fetch(); intercepted = true; await delayed; await route.fulfill({response});
    } else await route.continue();
  });
  form = await open('第一份慢保存');
  await form.getByRole('button', {name: '保存', exact: true}).click();
  await until(() => intercepted, '保存已经提交但响应被延迟');
  assert.equal(await form.getByLabel('名称', {exact: true}).isDisabled(), true);
  assert.equal(await form.getByRole('button', {name: '添加文本附件'}).isDisabled(), true);
  await page.keyboard.press('Escape');
  form = await open('第二份未保存草稿');
  const oldResponse = page.waitForResponse(r => r.request().method() === 'POST' && r.request().postDataJSON()?.name === '第一份慢保存');
  release(); await oldResponse;
  await page.waitForTimeout(250);
  assert.equal(await form.isVisible(), true);
  assert.equal(await form.getByLabel('名称', {exact: true}).inputValue(), '第二份未保存草稿');
  assert.equal(await form.getByRole('button', {name: '保存', exact: true}).isEnabled(), true);
  await form.getByRole('button', {name: '保存', exact: true}).click();
  await form.waitFor({state: 'detached'});
  assert.equal((await list()).filter(v => ['第一份慢保存', '第二份未保存草稿'].includes(v.name)).length, 2);
  await page.unroute('**/api/assets');
  checks.push('旧保存回执不关闭后续编辑，不改变新草稿或保存状态；两次明确保存各保留一份资产');

  let failureArrived = false;
  const delayedFailure = new Promise(resolve => { release = resolve; });
  await page.route('**/api/assets', async route => {
    if (route.request().method() === 'POST' && route.request().postDataJSON().name === '旧编辑的失败回执') {
      failureArrived = true; await delayedFailure;
      await route.fulfill({status: 503, contentType: 'application/json', body: JSON.stringify({code: 'unavailable', message: '合成暂时不可用', request_id: 'synthetic-late-failure', retryable: true})});
    } else await route.continue();
  });
  form = await open('旧编辑的失败回执');
  await form.getByRole('button', {name: '保存', exact: true}).click();
  await until(() => failureArrived, '旧编辑失败响应被延迟');
  await page.keyboard.press('Escape');
  form = await open('不受旧失败影响的草稿');
  const oldFailure = page.waitForResponse(r => r.request().method() === 'POST' && r.request().postDataJSON()?.name === '旧编辑的失败回执');
  release(); await oldFailure; await page.waitForTimeout(250);
  assert.equal(await form.getByLabel('名称', {exact: true}).inputValue(), '不受旧失败影响的草稿');
  assert.equal(await form.getByRole('alert').count(), 0);
  assert.equal(await form.getByRole('button', {name: '保存', exact: true}).isEnabled(), true);
  await page.keyboard.press('Escape'); await page.unroute('**/api/assets');
  checks.push('旧编辑的失败回执不把错误或忙碌状态带到新的草稿');

  const operations = [];
  let loseReceipt = true;
  await page.route('**/api/assets', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    operations.push(route.request().postDataJSON().operation_id);
    if (loseReceipt) { loseReceipt = false; await route.fetch(); await route.abort('failed'); }
    else await route.continue();
  });
  form = await open('保存回执丢失后的重试');
  await form.getByRole('button', {name: '保存', exact: true}).click();
  await form.getByRole('alert').waitFor();
  assert.equal(await form.getByLabel('名称', {exact: true}).inputValue(), '保存回执丢失后的重试');
  await until(async () => await form.getByRole('button', {name: '保存', exact: true}).isEnabled(), '失败后可重试');
  await form.getByRole('button', {name: '保存', exact: true}).click();
  await form.waitFor({state: 'detached'});
  assert.equal(operations.length, 2); assert.equal(operations[0], operations[1]);
  assert.equal((await list()).filter(v => v.name === '保存回执丢失后的重试').length, 1);
  checks.push('服务端已保存但回执丢失时保留输入，相同内容重试沿用操作身份且不重复创建');
  assert.deepEqual(errors, []);
  await page.screenshot({path: directory + '/desktop.png', fullPage: true});
  passed = true;
} finally {
  release?.();
  await writeFile(directory + '/report.json', JSON.stringify({passed, checks, errors, officialRequests: 0}, null, 2));
  if (!passed) await page.screenshot({path: directory + '/failure.png', fullPage: true});
  await browser.close(); await h.close();
  console.log(JSON.stringify({passed, checks, errors, officialRequests: 0}));
}

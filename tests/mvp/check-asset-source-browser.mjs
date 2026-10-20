import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {createReuseFixture} from './check-knowledge-reuse.mjs';
import {assetInput, ok} from './skill-fixtures.mjs';
import {expandAsset} from './experience-navigation.mjs';

const directory = '.local/checks/asset-source-browser';
await mkdir(directory, {recursive: true});
const fixture = await createReuseFixture({web: true});
const {h, source, draft, draftInput} = fixture;
const browser = await chromium.launch();
const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
page.setDefaultTimeout(10000);
const checks = [], errors = [];
let passed = false;
page.on('pageerror', error => errors.push(error.message));
try {
  const detail = ok(await h.request('/assets/skill-drafts/' + draft.draft_id));
  // 用户确认未改正文的模型草稿，不能把确认动作当成来源已经解除。
  const saved = ok(await h.request('/assets', assetInput({draft_id: draft.draft_id,
    name: draftInput.name, body: draftInput.body, scope: draftInput.scope,
    files: draftInput.files, dependencies: detail.dependencies})));
  ok(await h.request('/knowledge/' + source.id + '/disable', {
    operation_id: randomUUID(), expected_version: source.version,
  }));
  const current = async () => ok(await h.request('/assets')).assets.find(asset => asset.id === saved.id);
  assert.equal((await current()).text_unavailable, true);
  await page.goto(h.url);
  await page.getByLabel('演示登录凭据').fill(h.tokens.alice);
  await page.getByRole('button', {name: '进入工作台 →'}).click();
  await page.getByRole('navigation', {name: '主导航'}).getByRole('button', {name: /我的积累/}).click();
  await page.getByRole('tab', {name: /^我的 Skill/}).click();
  const card = page.locator('.asset-card').filter({has: page.getByRole('heading', {
    name: '来源不可用，正文已隐藏', exact: true,
  })});
  await card.getByText('暂不可用', {exact: true}).waitFor();
  assert.equal((await card.textContent()).includes(draftInput.body), false);
  assert.equal(await card.getByRole('button', {name: '在当前对话选用', exact: true}).count(), 0);
  await card.getByText('管理这条记录', {exact: true}).click();
  assert.equal(await card.getByRole('button', {name: '发布到空间', exact: true}).count(), 0);
  assert.equal(await card.getByRole('button', {name: '删除', exact: true}).count(), 1);
  const [disabledResponse] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/assets/' + saved.id + '/disable')),
    card.getByRole('button', {name: '停用', exact: true}).click(),
  ]);
  assert.equal(disabledResponse.status(), 200);
  await card.getByText('已停用', {exact: true}).waitFor();
  assert.equal((await current()).state, 'disabled');
  checks.push('已确认模型草稿的来源失效后正文隐藏，禁止选用/发布，仍可停用和管理记录');

  await card.getByRole('button', {name: '重写内容', exact: true}).click();
  const form = page.getByRole('dialog');
  await form.getByText(/保存会用本次填写的内容替换旧版本/).waitFor();
  for (const label of ['名称', '内容', '适用范围与例外']) {
    assert.equal(await form.getByLabel(label, {exact: true}).inputValue(), '');
  }
  assert.equal(await form.getByRole('button', {name: '保存', exact: true}).isDisabled(), true);
  assert.equal((await form.textContent()).includes(draftInput.body), false);
  checks.push('重写表单从空内容开始，不能把占位名称或隐藏正文重新保存');

  const rewritten = {name: '独立编写的合成方法', body: '只解释调用者本次提供的资料，缺失信息明确列出。', scope: '仅用于解释本次提供的文字'};
  await form.getByLabel('名称', {exact: true}).fill(rewritten.name);
  await form.getByLabel('内容', {exact: true}).fill(rewritten.body);
  await form.getByLabel('适用范围与例外', {exact: true}).fill(rewritten.scope);
  await page.setViewportSize({width: 390, height: 844});
  assert.ok(await form.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
  const [response] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/assets') && response.request().method() === 'POST'),
    form.getByRole('button', {name: '保存', exact: true}).click(),
  ]);
  assert.equal(response.status(), 200, await response.text());
  await form.waitFor({state: 'detached'});
  const restored = await current();
  assert.notEqual(restored.text_unavailable, true);
  assert.notEqual(restored.version, saved.version);
  assert.equal(restored.state, 'disabled');
  for (const field of ['name', 'body', 'scope']) assert.equal(restored[field], rewritten[field]);
  assert.deepEqual(restored.dependencies, []);
  assert.deepEqual(restored.files, []);
  const restoredCard = page.locator('.asset-card').filter({has: page.getByRole('heading', {name: rewritten.name, exact: true})});
  await expandAsset(restoredCard);
  const [enableResponse] = await Promise.all([
    page.waitForResponse(result => result.url().endsWith('/assets/' + saved.id + '/enable')),
    restoredCard.getByRole('button', {name: '启用', exact: true}).click(),
  ]);
  assert.equal(enableResponse.status(), 200);
  await restoredCard.getByRole('button', {name: '在当前对话选用', exact: true}).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({path: directory + '/rewritten-mobile.png', fullPage: true});
  await page.reload();
  await restoredCard.getByRole('heading', {name: rewritten.name, exact: true}).waitFor();
  assert.equal((await restoredCard.textContent()).includes(draftInput.body), false);
  checks.push('完整人工重写创建可用新版本、清除旧附件/依赖，启用与刷新后恢复采用且窄屏可操作');
  assert.deepEqual(errors, []);
  passed = true;
} finally {
  if (!passed) await page.screenshot({path: directory + '/failure.png', fullPage: true}).catch(() => {});
  await writeFile(directory + '/report.json', JSON.stringify({passed, checks, errors, officialRequests: 0}, null, 2));
  await browser.close();
  await fixture.close();
}
console.log(JSON.stringify({passed, checks, officialRequests: 0}));

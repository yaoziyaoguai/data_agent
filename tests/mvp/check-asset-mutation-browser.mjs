import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {harness, until} from './harness.mjs';
import {assetInput, ok} from './skill-fixtures.mjs';

const h = await harness({web: true, capture: true, startWorker: false});
const browser = await chromium.launch();
const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
page.setDefaultTimeout(10000);
const directory = '.local/checks/asset-mutation';
await mkdir(directory, {recursive: true});
const checks = [], errors = [];
page.on('pageerror', e => errors.push(e.message));
let passed = false, release;
const card = name => page.locator('.asset-card').filter({has: page.getByRole('heading', {name, exact: true})});
const list = async () => ok(await h.request('/assets')).assets;
const openAssets = async () => {
  await page.getByRole('navigation', {name: '主导航'}).getByRole('button', {name: /我的积累/}).click();
  await page.getByRole('tab', {name: /^我的 Skill/}).click();
};
const fill = async name => {
  const form = page.getByRole('dialog');
  await form.getByLabel('名称', {exact: true}).fill(name);
  await form.getByLabel('内容', {exact: true}).fill('合成分析规则：核对资料后展示 SQL。');
  await form.getByLabel('适用范围与例外').fill('仅合成订单');
  return form;
};
const holdPublication = async asset => {
  let held = false;
  const gate = new Promise(resolve => { release = resolve; });
  const pattern = `**/api/assets/${asset.id}/publish`;
  await page.route(pattern, async route => {
    const response = await route.fetch(); held = true;
    await gate; await route.fulfill({response});
  });
  await card(asset.name).getByRole('button', {name: '发布到空间', exact: true}).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('我已核对以上公开内容').check();
  await dialog.getByRole('button', {name: '确认发布独立副本'}).click();
  await until(() => held, '发布已提交，回执延迟');
  await page.keyboard.press('Escape');
  return async () => {
    const response = page.waitForResponse(r => r.url().endsWith(`/assets/${asset.id}/publish`));
    const refreshed = page.waitForResponse(r => r.url().endsWith('/api/assets') && r.request().method() === 'GET');
    release(); await response; await refreshed;
    await page.unroute(pattern);
  };
};
try {
  const first = ok(await h.request('/assets', assetInput({name: '合成迟到发布甲'})));
  const second = ok(await h.request('/assets', assetInput({name: '合成核对发布乙'})));
  const third = ok(await h.request('/assets', assetInput({name: '合成迟到发布丙'})));
  const fourth = ok(await h.request('/assets', assetInput({name: '合成离页发布丁'})));
  const refreshSkill = ok(await h.request('/assets', assetInput({name: '合成发布刷新故障'})));
  await page.goto(h.url);
  await page.getByLabel('演示登录凭据').fill(h.tokens.alice);
  await page.getByRole('button', {name: '进入工作台 →'}).click();
  let initialHeld = false;
  const initialGate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/assets', async route => {
    if (route.request().method() === 'GET') {
      const response = await route.fetch(); initialHeld = true;
      await initialGate; await route.fulfill({response});
    } else await route.fulfill({status: 503, contentType: 'application/json', body: JSON.stringify({code: 'unavailable', message: '合成保存失败', request_id: 'synthetic-failed-write', retryable: true})});
  });
  await openAssets();
  await until(() => initialHeld, '初始列表回执延迟');
  await page.getByRole('button', {name: '新增个人 Skill', exact: true}).click();
  let initialForm = await fill('合成列表在途时保存失败');
  await initialForm.getByRole('button', {name: '保存', exact: true}).click();
  await initialForm.getByRole('alert').waitFor();
  release(); await card(first.name).waitFor({state: 'attached'});
  assert.equal(await initialForm.isVisible(), true);
  assert.equal((await list()).some(a => a.name === '合成列表在途时保存失败'), false);
  await page.keyboard.press('Escape'); await page.unroute('**/api/assets');
  checks.push('一次失败写入不作废仍有效的初始列表，原有记录可见，失败草稿保留');

  let finish = await holdPublication(first);
  await card(second.name).getByRole('button', {name: '发布到空间', exact: true}).click();
  let dialog = page.getByRole('dialog');
  assert.equal(await dialog.getByLabel('我已核对以上公开内容').isChecked(), false);
  await finish();
  assert.equal(await dialog.isVisible(), true);
  assert.match(await dialog.innerText(), new RegExp(second.name));
  assert.equal(await dialog.getByLabel('我已核对以上公开内容').isChecked(), false);
  assert.equal(await dialog.getByRole('button', {name: '确认发布独立副本'}).isDisabled(), true);
  assert.match(await page.getByRole('tab', {selected: true}).innerText(), /^我的 Skill/);
  assert.equal((await list()).some(a => a.name === second.name && a.visibility === 'space'), false);
  await page.keyboard.press('Escape');
  checks.push('甲的迟到发布不关闭乙预览，不继承确认，不改变当前分类或发布乙');

  await page.getByRole('tab', {name: /^我的 Skill/}).click();
  let held = false;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/assets', async route => {
    if (route.request().method() === 'POST' && route.request().postDataJSON().name === '合成关闭后保存') {
      const response = await route.fetch(); held = true; await gate; await route.fulfill({response});
    } else await route.continue();
  });
  await page.getByRole('button', {name: '新增个人 Skill', exact: true}).click();
  dialog = await fill('合成关闭后保存');
  await dialog.getByRole('button', {name: '保存', exact: true}).click();
  await until(() => held, '保存已经提交');
  await page.keyboard.press('Escape');
  await page.getByRole('button', {name: '新增个人 Skill', exact: true}).click();
  dialog = await fill('合成尚未保存的另一草稿');
  release(); await card('合成关闭后保存').waitFor({state: 'attached'});
  assert.equal(await dialog.isVisible(), true);
  assert.equal(await dialog.getByLabel('名称', {exact: true}).inputValue(), '合成尚未保存的另一草稿');
  assert.equal(await dialog.getByRole('button', {name: '保存', exact: true}).isEnabled(), true);
  assert.equal((await list()).filter(a => a.name === '合成关闭后保存').length, 1);
  await page.keyboard.press('Escape'); await page.unroute('**/api/assets');
  checks.push('关闭编辑后的成功保存仍同步列表，不结束另一草稿或重复创建');

  finish = await holdPublication(third);
  await page.getByRole('tab', {name: /^记忆与纠错/}).click();
  await page.getByRole('button', {name: '新增记忆', exact: true}).click();
  dialog = await fill('合成新记忆草稿');
  await finish();
  assert.equal(await dialog.getByRole('heading').innerText(), '新增个人记忆');
  assert.equal(await dialog.getByLabel('名称', {exact: true}).inputValue(), '合成新记忆草稿');
  await dialog.getByRole('button', {name: '保存', exact: true}).click();
  await dialog.waitFor({state: 'detached'});
  await card('合成新记忆草稿').waitFor();
  const memory = (await list()).find(a => a.name === '合成新记忆草稿');
  assert.equal(memory.kind, 'memory'); assert.equal(memory.visibility, 'personal');
  checks.push('迟到发布不改变新记忆标题、内容及持久化种类');

  await page.getByRole('tab', {name: /^我的 Skill/}).click();

  // 已离开的页面不能在另一登录身份下重新发起列表同步。
  finish = await holdPublication(fourth);
  await page.getByRole('button', {name: '退出', exact: true}).click();
  await page.getByLabel('演示登录凭据').fill(h.tokens.bob);
  await page.getByRole('button', {name: '进入工作台 →'}).click();
  await openAssets();
  let lateLists = 0;
  page.on('request', request => { if (request.method() === 'GET' && request.url().endsWith('/api/assets')) lateLists++; });
  const oldResponse = page.waitForResponse(r => r.url().endsWith(`/assets/${fourth.id}/publish`));
  release(); await oldResponse; await page.waitForTimeout(250);
  assert.equal(lateLists, 0);
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await card('合成关闭后保存').count(), 0);
  await page.unrouteAll({behavior: 'wait'});
  await page.getByRole('button', {name: '退出', exact: true}).click();
  await page.getByLabel('演示登录凭据').fill(h.tokens.alice);
  await page.getByRole('button', {name: '进入工作台 →'}).click();
  await openAssets();
  checks.push('退出后旧发布回执不在新身份下发起刷新或污染页面');

  for (const [action, label] of [['disable', '停用'], ['enable', '启用'], ['delete', '删除']]) {
    let stateHeld = false;
    const stateGate = new Promise(resolve => { release = resolve; });
    const pattern = `**/api/assets/${second.id}/${action}`;
    await page.route(pattern, async route => {
      const response = await route.fetch(); assert.equal(response.status(), 200);
      stateHeld = true; await stateGate; await route.fulfill({response});
    });
    await card(second.name).getByRole('button', {name: label, exact: true}).click();
    await until(() => stateHeld, label + '已提交，回执延迟');
    await page.getByRole('button', {name: '退出', exact: true}).click();
    await page.getByLabel('演示登录凭据').fill(h.tokens.bob);
    await page.getByRole('button', {name: '进入工作台 →'}).click();
    await openAssets(); lateLists = 0;
    const stateResponse = page.waitForResponse(r => r.url().endsWith(`/assets/${second.id}/${action}`));
    release(); await stateResponse; await page.waitForTimeout(250);
    assert.equal(lateLists, 0, label + '的旧回执不得以新身份读取');
    assert.equal(await card(second.name).count(), 0);
    await page.unroute(pattern);
    await page.getByRole('button', {name: '退出', exact: true}).click();
    await page.getByLabel('演示登录凭据').fill(h.tokens.alice);
    await page.getByRole('button', {name: '进入工作台 →'}).click();
    await openAssets();
  }
  let failureHeld = false;
  const failureGate = new Promise(resolve => { release = resolve; });
  const failurePattern = `**/api/assets/${refreshSkill.id}/disable`;
  await page.route(failurePattern, async route => {
    failureHeld = true; await failureGate;
    await route.fulfill({status: 503, contentType: 'application/json', body: JSON.stringify({code: 'unavailable', message: '合成状态操作故障', request_id: 'synthetic-state-failure', retryable: true})});
  });
  await card(refreshSkill.name).getByRole('button', {name: '停用', exact: true}).click();
  await until(() => failureHeld, '状态操作失败回执延迟');
  await page.getByRole('button', {name: '新增个人 Skill', exact: true}).click();
  dialog = await fill('合成不受旧状态错误影响的草稿');
  const failureResponse = page.waitForResponse(r => r.url().endsWith(`/assets/${refreshSkill.id}/disable`));
  release(); await failureResponse; await page.waitForTimeout(250);
  assert.equal(await dialog.getByRole('alert').count(), 0);
  assert.equal(await dialog.getByLabel('名称', {exact: true}).inputValue(), '合成不受旧状态错误影响的草稿');
  await page.keyboard.press('Escape'); await page.unroute(failurePattern);
  checks.push('启用、停用和删除的旧回执不越过页面身份；旧状态失败不污染新编辑');

  for (const action of ['save', 'publish']) {
    let outcomeHeld = false;
    const outcomeGate = new Promise(resolve => { release = resolve; });
    const pattern = action === 'save' ? '**/api/assets' : `**/api/assets/${refreshSkill.id}/publish`;
    await page.route(pattern, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      outcomeHeld = true; await outcomeGate;
      await route.fulfill({status: 503, contentType: 'application/json', body: JSON.stringify({code: 'unavailable', message: '合成迟到失败', request_id: 'synthetic-closed-outcome', retryable: true})});
    });
    if (action === 'save') {
      await page.getByRole('button', {name: '新增个人 Skill', exact: true}).click();
      dialog = await fill('合成关闭后失败的保存');
      await dialog.getByRole('button', {name: '保存', exact: true}).click();
    } else {
      await card(refreshSkill.name).getByRole('button', {name: '发布到空间', exact: true}).click();
      dialog = page.getByRole('dialog');
      await dialog.getByLabel('我已核对以上公开内容').check();
      await dialog.getByRole('button', {name: '确认发布独立副本'}).click();
    }
    await until(() => outcomeHeld, '关闭前请求已发出'); await page.keyboard.press('Escape');
    await page.getByRole('button', {name: '新增个人 Skill', exact: true}).click();
    dialog = await fill('合成后来打开的草稿'); release();
    await page.locator('.asset-operation-note').waitFor({state: 'attached'});
    assert.match(await page.locator('.asset-operation-note').innerText(), /未收到成功回执/);
    assert.match(await page.locator('.asset-operation-note').innerText(), new RegExp(action === 'save' ? '合成关闭后失败的保存' : refreshSkill.name));
    assert.equal(await dialog.getByRole('alert').count(), 0);
    assert.equal(await dialog.getByLabel('名称', {exact: true}).inputValue(), '合成后来打开的草稿');
    await page.keyboard.press('Escape'); await page.unroute(pattern);
    let posts = 0;
    const countPosts = request => { if (request.method() === 'POST' && request.url().includes('/api/assets')) posts++; };
    page.on('request', countPosts);
    const refreshed = page.waitForResponse(r => r.url().endsWith('/api/assets') && r.request().method() === 'GET');
    await page.getByRole('button', {name: '核对已提交记录'}).click(); await refreshed;
    assert.equal(posts, 0); page.off('request', countPosts);
  }
  checks.push('关闭后保存/发布失败有具名页面反馈，不污染新草稿，核对按钮只读取列表');

  let failList = false;
  await page.route('**/api/assets', async route => {
    if (failList && route.request().method() === 'GET') {
      await route.fulfill({status: 503, contentType: 'application/json', body: JSON.stringify({code: 'unavailable', message: '合成列表暂时不可用', request_id: 'synthetic-refresh-failure', retryable: true})});
    } else await route.continue();
  });
  await page.getByRole('button', {name: '新增个人 Skill', exact: true}).click();
  dialog = await fill('合成保存成功但列表故障'); failList = true;
  await dialog.getByRole('button', {name: '保存', exact: true}).click();
  await dialog.waitFor({state: 'detached'});
  await page.getByRole('button', {name: '重新加载列表'}).waitFor();
  assert.match(await page.locator('.notice').innerText(), /已保存/);
  assert.match(await page.getByRole('alert').innerText(), /列表.*未能更新/);
  assert.equal((await list()).filter(a => a.name === '合成保存成功但列表故障').length, 1);
  failList = false; await page.getByRole('button', {name: '重新加载列表'}).click();
  await card('合成保存成功但列表故障').waitFor();
  await until(async () => await page.getByRole('alert').count() === 0, '刷新错误已恢复');

  await card(refreshSkill.name).getByRole('button', {name: '发布到空间', exact: true}).click();
  dialog = page.getByRole('dialog'); await dialog.getByLabel('我已核对以上公开内容').check();
  failList = true; await dialog.getByRole('button', {name: '确认发布独立副本'}).click();
  await dialog.waitFor({state: 'detached'}); await page.getByRole('button', {name: '重新加载列表'}).waitFor();
  assert.match(await page.locator('.notice').innerText(), /已发布/);
  assert.match(await page.getByRole('alert').innerText(), /列表.*未能更新/);
  failList = false; await page.getByRole('button', {name: '重新加载列表'}).click();
  await card(refreshSkill.name).waitFor();
  assert.equal((await list()).filter(a => a.name === refreshSkill.name && a.visibility === 'space').length, 1);
  checks.push('保存和发布成功独立反馈；列表失败可单独重载，无须重复提交');
  assert.deepEqual(errors, []);
  await page.screenshot({path: directory + '/desktop.png', fullPage: true});
  passed = true;
} finally {
  release?.(); await page.unrouteAll({behavior: 'wait'}).catch(() => {});
  await writeFile(directory + '/report.json', JSON.stringify({passed, checks, errors, officialRequests: 0}, null, 2));
  if (!passed) await page.screenshot({path: directory + '/failure.png', fullPage: true});
  await browser.close(); await h.close();
  console.log(JSON.stringify({passed, checks, errors, officialRequests: 0}));
}

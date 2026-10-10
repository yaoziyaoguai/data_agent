import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {harness, until} from './harness.mjs';
import {navigateWorkspace, discardEditor} from './experience-navigation.mjs';

const directory='.local/experience-optimization'; await mkdir(directory,{recursive:true});
const h=await harness({web:true,capture:true,startWorker:false,startupTimeout:60000});
const browser=await chromium.launch(); const page=await browser.newPage({viewport:{width:1280,height:720}});
const errors=[],checks=[]; let passed=false, release;
page.on('pageerror',error=>errors.push(error.message));
const nav=name=>navigateWorkspace(page,name);
const confirm=()=>page.getByRole('dialog',{name:'保留刚才的修改吗？',exact:true});
const field=()=>page.locator('.semantic-entry').first();
const savedMemory=await h.request('/assets',{operation_id:randomUUID(),id:null,expected_version:null,kind:'memory',name:'周报金额展示',body:'收入以元展示，退款单独核对。',scope:'合成零售周报',source_text:'合成验收材料',verified:false,dependencies:[],files:[]});
assert.equal(savedMemory.status,200);
await h.create();
try {
  await page.goto(h.url); await page.getByLabel('演示登录凭据').fill(h.tokens.alice); await page.getByRole('button',{name:'进入工作台 →'}).click();
  await page.locator('.history-nav time').first().waitFor();
  const history=(await h.request('/conversations')).value.conversations; assert.match(history[0].created_at,/^\d{4}-\d{2}-\d{2}T.*Z$/);
  const account=await page.locator('.sidebar .identity').boundingBox(); assert.ok(account.y+account.height<=720);
  await page.getByLabel('你的数据问题').fill('这个草稿稍后继续');
  await page.screenshot({path:directory+'/workbench-desktop.png'});
  checks.push('720px桌面账户可见、历史显示服务端创建时间；输入草稿保留');

  await nav('我的积累'); await page.getByRole('heading',{name:'周报金额展示',exact:true}).waitFor();
  await page.getByLabel('搜索资产').fill('无此内容'); await page.getByText('没有符合当前条件的内容。',{exact:true}).waitFor();
  await page.getByLabel('搜索资产').fill('周报'); assert.equal(await page.locator('.asset-card').count(),1);
  await page.getByLabel('资产状态').selectOption('disabled'); assert.equal(await page.locator('.asset-card').count(),0);
  await page.getByLabel('资产状态').selectOption('');
  await page.locator('.asset-card').getByRole('button',{name:'编辑',exact:true}).click();
  let editor=page.getByRole('dialog',{name:'编辑个人积累',exact:true});
  // 编辑窗口的名称可能随资产类别变化，以可访问正文定位。
  editor=page.getByRole('dialog').filter({has:page.getByLabel('内容',{exact:true})});
  await editor.getByLabel('内容',{exact:true}).fill('未保存的个人规则');
  await page.keyboard.press('Escape'); await confirm().waitFor(); await confirm().getByRole('button',{name:'继续编辑',exact:true}).click();
  assert.equal(await editor.getByLabel('内容',{exact:true}).inputValue(),'未保存的个人规则');
  const original=page.url(); await page.goBack(); await confirm().waitFor(); await confirm().getByRole('button',{name:'继续编辑',exact:true}).click(); await until(()=>page.url()===original,'后退取消恢复地址');
  assert.equal(await editor.getByLabel('内容',{exact:true}).inputValue(),'未保存的个人规则');
  await page.goBack(); await confirm().waitFor(); await confirm().getByRole('button',{name:'放弃修改',exact:true}).click(); await page.getByLabel('你的数据问题').waitFor();
  assert.equal(await page.getByLabel('你的数据问题').inputValue(),'这个草稿稍后继续');
  checks.push('个人资产搜索/状态筛选正常；Esc和浏览器后退可继续编辑或明确放弃，地址与页面一致');

  await nav('我的积累'); await page.getByRole('tab',{name:/^个人记忆/}).press('ArrowRight'); await page.getByRole('button',{name:'新增个人 Skill',exact:true}).waitFor(); assert.match(page.url(),/tab=skill/);
  await page.getByRole('tab',{name:/^我的 Skill/}).press('End'); await page.getByRole('button',{name:'从我的 Skill 发布',exact:true}).click();
  await page.getByRole('button',{name:'新增个人 Skill',exact:true}).click(); editor=page.getByRole('dialog').filter({has:page.getByLabel('内容',{exact:true})});
  await editor.getByRole('button',{name:/使用.*示例|采用|使用此/}).first().click(); assert.ok((await editor.getByLabel('内容',{exact:true}).inputValue()).length>30);
  await page.goBack(); await confirm().getByRole('button',{name:'放弃修改',exact:true}).click(); await until(async()=>await page.getByRole('dialog').count()===0,'同页后退放弃后关闭旧编辑');
  await page.getByRole('button',{name:'从我的 Skill 发布',exact:true}).click(); await page.reload(); await page.getByRole('tab',{name:/^我的 Skill/,selected:true}).waitFor();
  checks.push('资产tab支持方向键和Home/End；公共Skill引导到个人创建、模板可采用，刷新恢复分类');

  await nav('语义管理'); await field().getByRole('button',{name:'编辑',exact:true}).waitFor();
  await page.getByLabel('语义目录范围').selectOption('all');
  await page.getByLabel('管理目录名称').fill('demo_order_detail');
  await page.locator('.object-list button').filter({hasText:'demo_order_detail'}).first().click();
  const target=page.url(); await page.reload(); await until(()=>page.url()===target,'对象地址恢复');
  await page.getByLabel('管理目录名称').fill('demo_order_detail');
  await field().getByRole('button',{name:'编辑',exact:true}).waitFor();
  await page.locator('.object-list button').filter({hasText:'demo_order_detail'}).first().click();
  await field().getByRole('button',{name:'编辑',exact:true}).click(); await field().locator('textarea').fill('不能被筛选丢掉的语义');
  await page.getByLabel('管理目录名称').fill('不匹配'); await confirm().waitFor(); await confirm().getByRole('button',{name:'继续编辑',exact:true}).click();
  assert.equal(await field().locator('textarea').inputValue(),'不能被筛选丢掉的语义');
  assert.notEqual(await page.getByLabel('管理目录名称').inputValue(),'不匹配');
  let waiting=false; const gate=new Promise(resolve=>release=resolve);
  await page.route('**/api/knowledge/*',async route=>{
    if(route.request().method()!=='PATCH') return route.continue();
    waiting=true; await gate; await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({code:'unavailable',message:'合成保存失败',request_id:'unsaved-dogfood',retryable:true})});
  });
  await field().getByRole('button',{name:/保存/,exact:false}).first().click(); await until(()=>waiting,'保存中');
  assert.equal(await field().getByRole('button',{name:'放弃本次编辑',exact:true}).isDisabled(),true); assert.equal(await field().locator('textarea').isDisabled(),true);
  await nav('我的积累'); await confirm().waitFor(); await confirm().getByRole('button',{name:'继续编辑',exact:true}).click(); release();
  await field().getByRole('alert').waitFor(); assert.equal(await field().locator('textarea').inputValue(),'不能被筛选丢掉的语义');
  await page.unroute('**/api/knowledge/*');
  await nav('我的积累'); await confirm().getByRole('button',{name:'放弃修改',exact:true}).click(); await page.getByRole('heading',{name:'我的积累',exact:true}).waitFor();
  checks.push('语义目录筛选和保存中离页均保护草稿；失败回执不丢输入，明确放弃后可离页');

  await nav('语义管理'); await page.getByLabel('语义目录范围').selectOption('tables');
  await page.locator('.object-list button').filter({hasText:'demo_order_detail'}).first().click();
  await page.getByRole('tab',{name:'业务文档',exact:true}).click();
  await page.getByRole('button',{name:'录入业务文档',exact:true}).click();
  await page.getByLabel('文档名称',{exact:true}).fill('尚未提交的整篇文档'); await page.goBack();
  await confirm().getByRole('button',{name:'放弃修改',exact:true}).click(); await until(async()=>await page.getByRole('dialog').count()===0,'同页后退关闭新建语义');
  await page.getByRole('tab',{name:'业务文档',exact:true}).click();
  await page.locator('.document-reader').getByRole('button',{name:'打开文档详情',exact:true}).click();
  await page.locator('.document-reader').getByRole('button',{name:'编辑文档',exact:true}).click();
  editor=page.getByRole('dialog',{name:'编辑文档 · 虚构零售业务说明',exact:true});
  const documentBody=await editor.getByLabel('文档正文',{exact:true}).inputValue();
  await editor.getByLabel('文档正文',{exact:true}).fill(documentBody+'\n\n已提交的合成补充。');
  let documentSaved=false;
  const documentGate=new Promise(resolve=>release=resolve);
  await page.route('**/api/knowledge/*/document',async route=>{
    if(route.request().method()!=='PATCH') return route.continue();
    const response=await route.fetch(); assert.equal(response.status(),200); documentSaved=true;
    await documentGate; await route.fulfill({response});
  });
  await editor.getByRole('button',{name:'保存文档',exact:true}).click(); await until(()=>documentSaved,'文档已保存，回执尚未到达');
  await page.goBack(); await confirm().getByRole('button',{name:'放弃修改',exact:true}).click();
  await until(async()=>await page.getByRole('dialog').count()===0,'同页后退放弃保存中的文档');
  await page.locator('.document-reader').getByRole('button',{name:'编辑文档',exact:true}).click();
  await editor.getByLabel('文档正文',{exact:true}).fill('# 试用文档\n\n## 口径\n\n这是尚未保存的正文。');
  const oldReply=page.waitForResponse(response=>response.url().includes('/document')&&response.request().method()==='PATCH'); release(); await oldReply;
  await page.waitForTimeout(150); assert.match(await editor.getByLabel('文档正文',{exact:true}).inputValue(),/尚未保存/);
  await page.unroute('**/api/knowledge/*/document');
  checks.push('保存中文档可明确离开；重新编辑后旧成功回执不关闭窗口、不覆盖新草稿');
  await editor.getByRole('tab',{name:'阅读预览',exact:true}).click(); await editor.getByRole('heading',{name:'口径',exact:true}).waitFor();
  await page.keyboard.press('Escape'); await confirm().getByRole('button',{name:'继续编辑',exact:true}).click();
  await editor.getByRole('tab',{name:'编辑',exact:true}).click(); assert.match(await editor.getByLabel('文档正文',{exact:true}).inputValue(),/尚未保存/);
  await page.setViewportSize({width:390,height:720}); const save=await editor.getByRole('button',{name:'保存文档',exact:true}).boundingBox(); assert.ok(save.y+save.height<=720);
  await page.screenshot({path:directory+'/document-editor-mobile.png'}); await discardEditor(page);
  await page.getByRole('navigation',{name:'文档章节'}).waitFor();
  await page.screenshot({path:directory+'/semantics-mobile.png'});
  checks.push('文档整篇阅读与目录、编辑预览、未保存保护可用；手机保存操作固定可达');

  await nav('我的积累'); await page.screenshot({path:directory+'/assets-mobile.png'});
  await nav('工作台');
  for(const viewport of [{width:390,height:720},{width:390,height:320},{width:320,height:568}]) {
    await page.setViewportSize(viewport); await page.getByLabel('你的数据问题').fill('手机里继续聊');
    const send=await page.getByRole('button',{name:'发送 ↑',exact:true}).boundingBox(); assert.ok(send.x>=0&&send.x+send.width<=viewport.width&&send.y+send.height<=viewport.height);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await page.screenshot({path:`${directory}/workbench-${viewport.width}-${viewport.height}.png`});
  }
  await page.setViewportSize({width:1280,height:720}); await nav('我的积累'); await page.getByRole('tab',{name:/^个人记忆/}).click(); await page.getByRole('heading',{name:'周报金额展示',exact:true}).waitFor(); await page.screenshot({path:directory+'/assets-desktop.png',animations:'disabled'}); await nav('语义管理'); await page.locator('.object-list button').filter({hasText:'demo_order_detail'}).first().click(); await page.getByRole('tab',{name:'字段语义',exact:true}).click(); await page.locator('.field-object').first().waitFor(); assert.equal(await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'语义管理',exact:true}).getAttribute('aria-current'),'page'); await page.screenshot({path:directory+'/semantics-desktop.png',animations:'disabled'});
  checks.push('390/320px手机与320px短屏输入/发送可达、无全页横向溢出、抽屉导航可返回对话');
  assert.deepEqual(errors,[]); passed=true;
} finally {
  release?.(); if(!passed) await page.screenshot({path:directory+'/failure.png'}).catch(()=>{});
  await writeFile(directory+'/report.json',JSON.stringify({passed,checks,errors,officialRequests:0,environment:'isolated MySQL + actual React/API + synthetic fixtures'},null,2));
  await browser.close(); await h.close(); console.log(JSON.stringify({passed,checks,errors,officialRequests:0}));
}

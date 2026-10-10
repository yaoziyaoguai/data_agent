import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {harness, until} from './harness.mjs';

const directory='.local/checks/query-stop';
await mkdir(directory,{recursive:true});
const h=await harness({web:true,env:{DATA_AGENT_QUERY_DELAY_SECONDS:'3600'}});
const browser=await chromium.launch();
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const checks=[],errors=[];let passed=false;
page.on('pageerror',e=>errors.push(e.message));
const readQuery=async q=>(await h.request('/queries/'+q.id)).value;
const list=async cid=>(await h.request('/conversations/'+cid+'/queries')).value.queries;
const card=q=>page.locator('#query-'+q.id);
const send=async text=>{
  await page.getByLabel('你的数据问题').fill(text);
  assert.equal(await page.getByRole('button',{name:'发送 ↑',exact:true}).isEnabled(),true);
  await page.getByRole('button',{name:'发送 ↑',exact:true}).click();
};
const waitForState=(q,state)=>until(async()=>(await readQuery(q)).execution_state===state,'查询状态 '+state);
try {
  await page.goto(h.url);
  await page.getByLabel('演示登录凭据').fill(h.tokens.alice);
  await page.getByRole('button',{name:'进入工作台 →',exact:true}).click();
  await send('查2026年1月净收入');
  const cid=await until(()=>page.evaluate(()=>localStorage.getItem('data-agent.conversation.alice')),'会话建立');
  await h.finished(cid);
  const a=(await list(cid))[0];
  await send('执行这条');await h.finished(cid,2);await waitForState(a,'running');
  await card(a).getByRole('button',{name:'停止',exact:true}).waitFor();
  await send('查2026年1月支付客户数');await h.finished(cid,3);
  const b=(await list(cid)).find(q=>q.id!==a.id);assert.ok(b);
  await send('执行这条');await h.finished(cid,4);await waitForState(b,'running');
  assert.equal((await readQuery(a)).execution_state,'running');
  await card(b).getByRole('button',{name:'停止',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'停止',exact:true}).count(),2);
  await page.getByLabel('你的数据问题').fill('保留这条未发送的补充');
  await card(a).getByRole('button',{name:'停止',exact:true}).click();
  await waitForState(a,'cancelled');await h.finished(cid,5);
  await card(a).getByRole('heading',{name:'已取消',exact:true}).waitFor();
  assert.equal((await readQuery(b)).execution_state,'running');
  assert.equal(await card(b).getByRole('button',{name:'停止',exact:true}).isEnabled(),true);
  assert.equal(await page.getByLabel('你的数据问题').inputValue(),'保留这条未发送的补充');
  await send('谢谢');await h.finished(cid,6);
  await page.getByText('可以继续在这个对话提问、修改已有任务，或开始新的分析。',{exact:true}).waitFor();
  checks.push('两条查询运行时可手动停止单条，另一条保持运行；草稿保留且同一对话可继续聊天');

  // 暂停本测试的合成平台，真实制造未知回执，不伪造API查询状态。
  await h.pausePlatform();
  await page.setViewportSize({width:390,height:844});
  await page.getByLabel('你的数据问题').fill('等待停止时仍可输入');
  await card(b).getByRole('button',{name:'停止',exact:true}).click();
  await until(async()=>{
    const q=await readQuery(b);
    return q.cancel_state==='requested'&&q.error==='outcome_unknown';
  },'停止请求等待平台确认');
  const stopping=card(b).getByRole('button',{name:'正在停止…',exact:true});
  await stopping.waitFor();
  await card(b).getByRole('heading',{name:'正在停止查询',exact:true}).waitFor();
  await card(b).getByText('暂时无法确认是否已停止，系统会继续核对。',{exact:true}).waitFor();
  assert.equal(await stopping.isEnabled(),false,'等待真实确认时不可重复点击');
  assert.equal(await card(b).getByRole('heading',{name:'已取消',exact:true}).count(),0);
  assert.equal(await card(b).getByText(/outcome_unknown|提交结果待查证|提交标识/).count(),0,'用户不需要内部错误码或提交状态');
  assert.equal(await page.getByRole('button',{name:'发送 ↑',exact:true}).isEnabled(),true);
  assert.equal(await page.getByLabel('你的数据问题').inputValue(),'等待停止时仍可输入');
  await card(b).scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.screenshot({path:directory+'/pending-mobile.png',fullPage:true});
  await page.reload();
  await card(b).getByRole('heading',{name:'正在停止查询',exact:true}).waitFor();
  assert.equal(await stopping.isEnabled(),false);
  assert.equal(await page.getByLabel('你的数据问题').inputValue(),'等待停止时仍可输入');
  checks.push('平台暂时不可用时明确显示正在停止和等待确认，隐藏技术错误码；窄屏与刷新后仍保留状态和草稿');

  await h.resumePlatform();
  await waitForState(b,'cancelled');await h.finished(cid,7);
  await card(b).getByRole('heading',{name:'已取消',exact:true}).waitFor();
  assert.equal(await stopping.count(),0);
  assert.equal(await card(b).locator('.error').count(),0,'平台恢复后清除旧的未知提示');
  assert.equal(await page.getByLabel('你的数据问题').inputValue(),'等待停止时仍可输入');
  for(const q of [a,b]) {
    assert.equal((await readQuery(q)).cancel_state,'completed');
    const notices=(await h.snapshot(cid)).events.filter(e=>e.type==='query_result'&&e.payload.query_id===q.id);
    assert.equal(notices.length,1);assert.equal(notices[0].payload.state,'cancelled');
    assert.equal(await card(q).getByRole('button',{name:'停止',exact:true}).count(),0);
    await page.locator('.query-notice').filter({hasText:q.summary}).getByText(/查询已停止/).waitFor();
  }
  assert.equal(await page.locator('.query-notice').filter({hasText:'查询已停止'}).count(),2);
  await send('谢谢');await h.finished(cid,8);
  assert.equal((await list(cid)).length,2,'恢复和续聊不重建SQL');
  await page.setViewportSize({width:1440,height:1000});
  await page.screenshot({path:directory+'/stopped-desktop.png',fullPage:true});
  checks.push('平台恢复后按真实回执停止，两条查询各有唯一通知；旧错误消失，停止后仍可续聊且不重建SQL');
  assert.deepEqual(errors,[]);passed=true;
} finally {
  if(!passed)await page.screenshot({path:directory+'/failure.png',fullPage:true}).catch(()=>{});
  await writeFile(directory+'/report.json',JSON.stringify({passed,checks,errors,officialRequests:0,environment:'Pi SDK + synthetic model + isolated MySQL + executable synthetic SQLite'},null,2));
  await browser.close();await h.close();console.log(JSON.stringify({passed,checks,errors,officialRequests:0}));
}

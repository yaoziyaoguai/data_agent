import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {harness, until} from './harness.mjs';

const references=JSON.parse(await readFile('docs/sources/evaluation/cases.json','utf8')).cases;
const customers=String(references.find(c=>c.id==='Q02').expected_rows[0][0]);
const revenue=String(references.find(c=>c.id==='Q01').expected_rows[0][2]);
const directory='.local/checks/background-queries';
await mkdir(directory,{recursive:true});
const h=await harness({web:true,env:{DATA_AGENT_QUERY_DELAY_SECONDS:'3600'}});
const browser=await chromium.launch();
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const checks=[],errors=[];let passed=false;
page.on('pageerror',e=>errors.push(e.message));
const query=async id=>(await h.request('/queries/'+id)).value;
const list=async cid=>(await h.request('/conversations/'+cid+'/queries')).value.queries;
const card=q=>page.locator('#query-'+q.id);
const notice=q=>page.locator('.query-notice').filter({hasText:q.summary});
const send=async(text,initialLoad=false)=>{
  await page.getByLabel('你的数据问题').fill(text);
  if(initialLoad)await until(async()=>await page.getByRole('button',{name:'发送 ↑',exact:true}).isEnabled(),'首次模型设置读取完成');
  assert.equal(await page.getByRole('button',{name:'发送 ↑',exact:true}).isEnabled(),true);
  await page.getByRole('button',{name:'发送 ↑',exact:true}).click();
};
// 仅推进本测试平台的完成时钟，查询仍经过正式提交、执行SQL、读取和通知。
const ready=q=>execFileSync('python3',['-c',
  'import sqlite3,sys\nwith sqlite3.connect(sys.argv[1]) as db: db.execute("UPDATE submissions SET ready_at=0 WHERE id=?",(sys.argv[2],))',
  h.directory+'/platform/submissions.sqlite',q.id]);
const running=async q=>until(async()=>(await query(q.id)).execution_state==='running','查询独立运行');
const done=async(q,state='succeeded')=>until(async()=>(await query(q.id)).execution_state===state,'查询结束 '+state);
try {
  await page.goto(h.url);
  await page.getByLabel('演示登录凭据').fill(h.tokens.alice);
  await page.getByRole('button',{name:'进入工作台 →'}).click();
  await send('查2026年1月净收入',true);
  const cid=await until(()=>page.evaluate(()=>localStorage.getItem('data-agent.conversation.alice')),'新对话保存');
  await h.finished(cid);
  const a=(await list(cid))[0];
  await send('执行这条');await h.finished(cid,2);await running(a);
  await card(a).getByRole('button',{name:'停止',exact:true}).waitFor();
  assert.equal(await card(a).locator('pre').isVisible(),false);
  await send('谢谢');await h.finished(cid,3);
  assert.equal((await query(a.id)).execution_state,'running');
  await page.getByText('可以继续在这个对话提问、修改已有任务，或开始新的分析。',{exact:true}).waitFor();
  checks.push('A运行时输入与发送可用，新消息由同一Pi会话完成，不等待查询结束');

  await send('查2026年1月支付客户数');await h.finished(cid,4);
  const b=(await list(cid)).find(q=>q.id!==a.id);
  assert.ok(b);assert.notEqual(b.task_id,a.task_id);
  await send('执行这条');await h.finished(cid,5);await running(b);
  assert.equal((await query(a.id)).execution_state,'running');
  await until(async()=>await page.getByRole('button',{name:'停止',exact:true}).count()===2,'两个独立运行组件');
  assert.equal(await card(b).locator('pre').isVisible(),false);
  await send('查2026年2月净收入');await h.finished(cid,6);
  const c=(await list(cid)).find(q=>q.id!==a.id&&q.id!==b.id);assert.ok(c);
  await send('执行这条');await h.finished(cid,7);await running(c);
  assert.equal((await query(a.id)).execution_state,'running');assert.equal((await query(b.id)).execution_state,'running');
  await until(async()=>await page.getByRole('button',{name:'停止',exact:true}).count()===3,'三个独立运行组件');
  await until(()=>page.locator('.conversation-scroll').evaluate(el=>el.scrollHeight-el.scrollTop-el.clientHeight<3),'最新消息自动跟随');
  const expected=[a,b].map(q=>({id:q.id,sql:q.sql,parameters:q.parameters,task_id:q.task_id,condition_version:q.condition_version}));
  const originalOrder=await page.locator('.query-card').evaluateAll(nodes=>nodes.map(n=>n.id));
  await page.getByLabel('你的数据问题').fill('这个草稿不能被查询完成清掉');
  await page.screenshot({path:directory+'/running-desktop.png',fullPage:true});
  await page.reload();
  await until(async()=>await page.getByRole('button',{name:'停止',exact:true}).count()===3,'刷新接回三项运行');
  assert.equal(await page.getByLabel('你的数据问题').inputValue(),'这个草稿不能被查询完成清掉');
  await page.getByRole('navigation',{name:'会话历史',exact:true}).getByRole('button').first().waitFor();
  await h.pauseWorker();await h.restartApi();await h.resumeWorker();
  await running(a);await running(b);await running(c);
  assert.equal((await list(cid)).length,3);
  checks.push('同会话A/B/C同时处于运行中；刷新、API与Worker重启保持原查询身份及草稿，不重新提交SQL');

  await page.getByLabel('你的数据问题').focus();
  const before=await page.getByLabel('你的数据问题').boundingBox();
  ready(b);await done(b);await h.finished(cid,8);
  await card(b).getByRole('cell',{name:customers,exact:true}).waitFor();
  await notice(b).getByRole('button',{name:'查看结果',exact:true}).waitFor();
  assert.equal(await notice(b).count(),1);
  assert.equal((await query(a.id)).execution_state,'running');
  assert.equal(await page.getByLabel('你的数据问题').inputValue(),'这个草稿不能被查询完成清掉');
  assert.equal(await page.getByLabel('你的数据问题').evaluate(el=>el===document.activeElement),true);
  const after=await page.getByLabel('你的数据问题').boundingBox();
  assert.ok(Math.abs(after.y-before.y)<3,'查询完成不能把正在输入的框挤出原位置');
  assert.deepEqual(await page.locator('.query-card').evaluateAll(nodes=>nodes.map(n=>n.id)),originalOrder);
  checks.push('后提交的B先完成，独立参考支付客户数5正确；A仍运行，通知唯一，组件顺序/草稿/输入焦点及视口位置保持');

  await card(c).getByRole('button',{name:'停止',exact:true}).click();await done(c,'cancelled');await h.finished(cid,9);
  assert.equal((await query(a.id)).execution_state,'running');assert.equal((await query(b.id)).execution_state,'succeeded');
  await notice(c).getByText(/查询已停止/).waitFor();
  checks.push('单独停止C只取消C，A继续运行，B结果保留；取消通知与成功通知区分');

  await page.locator('.conversation-scroll').evaluate(el=>{el.scrollTop=0;});
  await until(()=>page.locator('.conversation-scroll').evaluate(el=>el.scrollTop===0),'回看早期消息');
  const reading=await page.locator('.messages > .message').first().boundingBox();
  ready(a);await done(a);await h.finished(cid,10);
  // 读取DOM不调用click/scrollIntoView，避免观察器自身改变阅读位置。
  await until(async()=>await card(a).locator('tbody').innerText().catch(()=>'')===revenue,'A的原始结果显示');
  const stillReading=await page.locator('.messages > .message').first().boundingBox();
  assert.ok(Math.abs(stillReading.y-reading.y)<3,'查阅历史时结果到达不滚动到末尾');
  await notice(a).getByRole('button',{name:'查看结果',exact:true}).waitFor();
  assert.equal(await page.locator('.query-notice').count(),3);
  for(const q of [a,b]) {
    const current=await query(q.id);
    assert.deepEqual({id:current.id,sql:current.sql,parameters:current.parameters,task_id:current.task_id,condition_version:current.condition_version},expected.find(x=>x.id===q.id));
    assert.equal(await card(q).locator('pre').innerText(),q.sql);
    assert.equal((await h.snapshot(cid)).events.filter(e=>e.type==='query_result'&&e.payload.query_id===q.id).length,1);
    const platform=JSON.parse(execFileSync('python3',['-c','import sqlite3,sys,json\nwith sqlite3.connect(sys.argv[1]) as db: print(json.dumps(db.execute("SELECT count(*) FROM submissions WHERE id=?",(sys.argv[2],)).fetchone()[0]))',h.directory+'/platform/submissions.sqlite',q.id],{encoding:'utf8'}));
    assert.equal(platform,1);
  }
  const checkpointSessions=h.sql(`SELECT COALESCE(JSON_EXTRACT(checkpoint,'$.storage.session_id'),JSON_EXTRACT(checkpoint,'$.entries[0].id')) FROM pi_checkpoints WHERE recovery_chain_id IN (SELECT recovery_chain_id FROM agent_runs WHERE conversation_id='${cid}')`);
  assert.ok(checkpointSessions.length>=10);assert.ok(checkpointSessions.every(Boolean));
  assert.equal(new Set(checkpointSessions).size,1,'所有轮次沿用同一个Pi会话');
  assert.equal((await h.request('/queries/'+a.id,undefined,'bob')).status,404);
  await notice(a).getByRole('button',{name:'查看结果',exact:true}).click();
  assert.equal(await card(a).evaluate(el=>el===document.activeElement),true);
  await page.getByLabel('你的数据问题').fill('下一条分析草稿');await page.reload();
  await until(async()=>await page.locator('.query-notice').count()===3,'刷新恢复终态通知');
  assert.equal(await page.getByLabel('你的数据问题').inputValue(),'下一条分析草稿');
  await until(async()=>await page.locator('.result-panel table').count()===2,'刷新后异步读取两份结果');
  await notice(a).getByRole('button',{name:'查看结果',exact:true}).click();
  await page.screenshot({path:directory+'/sql-result-desktop.png',fullPage:true});
  checks.push('A晚到仍为原SQL的12400分；通知只一次，结果可定位、刷新可恢复，SQL/参数/任务不串，其他用户不可读');
  for(const width of [1440,390]) {
    await page.setViewportSize({width,height:1000});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await page.screenshot({path:directory+'/completed-'+width+'.png',fullPage:true});
  }
  for(const height of [420,320]) {
    await page.setViewportSize({width:390,height});
    await send('谢谢');await h.finished(cid,height===420?11:12);
    const button=await page.getByRole('button',{name:'发送 ↑',exact:true}).boundingBox();
    assert.ok(button.y>=0 && button.y+button.height<=height,'短视口可滚动到发送按钮');
    assert.ok(await page.locator('.conversation-scroll').evaluate(el=>el.clientHeight>=120));
    await page.screenshot({path:directory+'/short-'+height+'.png',fullPage:true});
  }
  checks.push('390×420和390×320短视口保留可滚动消息区与可达的输入/发送按钮');
  await page.route('**/snapshot*',route=>route.fulfill({status:502,contentType:'application/json',body:'{'}));
  await page.locator('.conversation-sync').waitFor();
  await page.route('**/messages',route=>route.abort('failed'));
  await send('保留这条尚未发送成功的补充');
  const operationError=page.locator('.conversation > .error');await operationError.waitFor();
  const failureText=await operationError.innerText();
  await page.unroute('**/snapshot*');
  await page.locator('.conversation-sync').waitFor({state:'detached'});
  assert.equal(await operationError.innerText(),failureText,'读取恢复不能清掉发送失败提示');
  assert.equal(await page.getByLabel('你的数据问题').inputValue(),'保留这条尚未发送成功的补充');
  await page.unroute('**/messages');
  checks.push('临时读取失败恢复后提示消失，发送失败提示及未发送草稿仍保留');
  assert.deepEqual(errors,[]);passed=true;
} finally {
  if(!passed)await page.screenshot({path:directory+'/failure.png',fullPage:true}).catch(()=>{});
  await writeFile(directory+'/report.json',JSON.stringify({passed,checks,errors,officialRequests:0,environment:'Pi SDK + synthetic model + MySQL + executable synthetic SQLite'},null,2));
  await browser.close();await h.close();console.log(JSON.stringify({passed,checks,errors,officialRequests:0}));
}

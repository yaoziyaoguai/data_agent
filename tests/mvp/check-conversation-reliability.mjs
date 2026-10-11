import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {mergeSnapshot} from '../../apps/web/src/features/workbench/conversation-timeline.ts';
import {harness, until} from './harness.mjs';
import {ok} from './skill-fixtures.mjs';

const profile={provider_id:'deepseek',model_id:'deepseek-flash',trial_id:randomUUID(),price_version:'2026-10-04-peak-usd',input_limit:65536,output_limit:4096,trial_call_limit:100,trial_cost_micros:'9999999',request_call_limit:12,toolset:'data',payload_bytes_limit:131072,thinking_level:'off'};
const h=await harness({web:true,capture:true,startWorker:false,profile,env:{DATA_AGENT_LEASE_MS:'120000',DATA_AGENT_QUERY_DELAY_SECONDS:'3600'}});
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const directory='.local/product-repairs/conversation';await mkdir(directory,{recursive:true});
const checks=[],errors=[],measurements={};let passed=false;
page.on('pageerror',error=>errors.push(error.message));
const conversationKey=(space='demo',user='alice')=>'data-agent.conversation.'+JSON.stringify([space,user]);
const draftKey=(cid,space='demo',user='alice')=>'data-agent.draft.'+JSON.stringify([space,user,cid??'new']);
const pendingKey=(space='demo',user='alice')=>'data-agent.pending-message.'+JSON.stringify([space,user]);
const composer=()=>page.getByRole('textbox',{name:'你的数据问题'});
const send=()=>page.getByRole('button',{name:'发送 ↑',exact:true});
const retry=()=>page.getByRole('button',{name:'重试原消息',exact:true});
const login=async user=>{await page.goto(h.url);await page.getByLabel('演示登录凭据').fill(h.tokens[user]);await page.getByRole('button',{name:'进入工作台 →'}).click();await composer().waitFor();};
const readPending=()=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)),pendingKey());
const counts=cid=>h.sql(`SELECT JSON_OBJECT('messages',(SELECT COUNT(*) FROM conversation_messages WHERE conversation_id='${cid}'),'budgets',(SELECT COUNT(*) FROM budget_scopes b JOIN conversation_messages m ON b.message_id=m.id WHERE m.conversation_id='${cid}'),'jobs',(SELECT COUNT(*) FROM background_jobs WHERE conversation_id='${cid}'))`)[0];
const storedCid=()=>page.evaluate(key=>localStorage.getItem(key),conversationKey());
const openConversation=async cid=>{await page.evaluate(({key,cid})=>localStorage.setItem(key,cid),{key:conversationKey(),cid});await page.reload();await composer().waitFor();await until(async()=>await storedCid()===cid,'active conversation');};
const visibility=hidden=>page.evaluate(hidden=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>hidden});Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>hidden?'hidden':'visible'});document.dispatchEvent(new Event('visibilitychange'));},hidden);
function droppedResponse(pattern,method='POST') {
  const calls=[];let release,submitted;
  const gate=new Promise(resolve=>release=resolve);
  const accepted=new Promise(resolve=>submitted=resolve);
  const handler=async route=>{
    if(route.request().method()!==method)return route.continue();
    calls.push(route.request().postDataJSON());
    const response=await route.fetch();assert.equal(response.status(),200);
    const value=await response.json();
    if(calls.length===1){submitted(value);await gate;await route.abort('failed');}
    else await route.fulfill({response});
  };
  return {calls,accepted,release:()=>release(),install:()=>page.route(pattern,handler),remove:()=>page.unroute(pattern,handler)};
}
try {
  await login('alice');
  const createDrop=droppedResponse('**/api/conversations');await createDrop.install();
  const first='核对合成物流批次的到货时间分布';const second='期间新写的设备检查草稿';
  await composer().fill(first);await send().click();
  const created=await createDrop.accepted;await composer().fill(second);createDrop.release();await retry().waitFor();
  const frozenCreation=await readPending();assert.equal(frozenCreation.input.text,first);assert.ok(frozenCreation.input.model_selection);
  await page.reload();await retry().waitFor();assert.equal(await composer().inputValue(),second);
  await retry().click();await until(async()=>await storedCid()===created.conversation_id&&await retry().count()===0,'first message recovered');
  assert.deepEqual(createDrop.calls,[createDrop.calls[0],createDrop.calls[0]]);
  assert.equal(await composer().inputValue(),second);assert.equal(await readPending(),null);
  assert.equal(h.sql(`SELECT COUNT(*) FROM conversations WHERE creation_key='${frozenCreation.creation_operation_id}'`)[0],1);
  assert.deepEqual(counts(created.conversation_id),{messages:1,budgets:1,jobs:1});
  assert.equal((await h.snapshot(created.conversation_id)).messages.filter(item=>item.role==='user')[0].text,first);
  await createDrop.remove();checks.push('首问创建真实提交后回执丢失，刷新重试沿用创建ID和冻结载荷，仅一个会话/消息/预算/任务，后来草稿保留');

  for(const reload of [false,true]) {
    const messageDrop=droppedResponse(`**/api/conversations/${created.conversation_id}/messages`);await messageDrop.install();
    const before=counts(created.conversation_id);const body=reload?'核对合成能源传感器的缺失区间':'核对合成运输设备的维护记录';
    const later=reload?'刷新后仍需保留的下一问':'同页等待时写下的下一问';
    await composer().fill(body);await send().click();await messageDrop.accepted;await composer().fill(later);messageDrop.release();await retry().waitFor();
    const frozen=await readPending();assert.equal(frozen.input.text,body);
    await page.getByLabel('模型',{exact:true}).selectOption('deepseek-v4-pro');
    await until(async()=>!await page.getByLabel('模型',{exact:true}).isDisabled(),'new model choice saved');
    if(reload){await page.reload();await retry().waitFor();}
    assert.equal(await composer().inputValue(),later);await retry().click();await until(async()=>await readPending()===null,'message receipt recovered');
    assert.deepEqual(messageDrop.calls,[frozen.input,frozen.input]);assert.equal(await composer().inputValue(),later);
    assert.deepEqual(counts(created.conversation_id),{messages:before.messages+1,budgets:before.budgets+1,jobs:before.jobs+1});
    await messageDrop.remove();
  }
  const beforeFresh=counts(created.conversation_id);const nextText=await composer().inputValue();await send().click();await until(async()=>counts(created.conversation_id).messages===beforeFresh.messages+1,'next draft sent');await until(async()=>await composer().inputValue()==='','new draft settled');
  const persisted=h.sql(`SELECT JSON_OBJECT('key',client_key,'text',body) FROM conversation_messages WHERE conversation_id='${created.conversation_id}'`);
  assert.equal(new Set(persisted.map(item=>item.key)).size,persisted.length);assert.equal(persisted.filter(item=>item.text===nextText).length,1);
  checks.push('已有会话同页及刷新后重试均保留完整client_message_id/正文/模型载荷，真实保存只发生一次；下一问获得独立身份');

  await composer().fill('超过边界的草稿');await composer().evaluate(input=>{input.maxLength=40000;});await composer().fill('合'.repeat(32001));await send().click();
  await page.getByRole('alert').filter({hasText:'消息内容或模型设置不符合要求'}).waitFor();assert.equal(await readPending(),null);assert.equal((await composer().inputValue()).length,32001);
  const beforeReject=counts(created.conversation_id);delete h.env.DATA_AGENT_MODEL_PROFILE;await h.restartApi();
  await composer().fill('当前模型配置撤下时保留这份草稿');await send().click();await page.getByRole('alert').filter({hasText:'消息内容或当前模型设置未被接受'}).waitFor();
  assert.equal(await readPending(),null);assert.equal(await composer().inputValue(),'当前模型配置撤下时保留这份草稿');assert.deepEqual(counts(created.conversation_id),beforeReject);assert.equal(await send().isDisabled(),false);
  h.env.DATA_AGENT_MODEL_PROFILE=JSON.stringify(profile);await h.restartApi();await send().click();await until(async()=>counts(created.conversation_id).messages===beforeReject.messages+1,'rejected input can be sent after correction');await until(async()=>await composer().inputValue()==='','accepted retry clears original draft');
  checks.push('超长载荷在冻结前拒绝且保留草稿；服务端模型配置撤下导致真实invalid_input时无消息/预算/任务，恢复配置后可重新发送');

  const isolated=droppedResponse(`**/api/conversations/${created.conversation_id}/messages`);await isolated.install();
  await composer().fill('Alice 合成设备故障记录');await send().click();await isolated.accepted;await composer().fill('Alice 私人待写草稿');isolated.release();await retry().waitFor();const alicePending=await readPending();
  await page.getByRole('button',{name:'退出',exact:true}).click();await login('bob');
  assert.equal(await retry().count(),0);assert.equal(await composer().inputValue(),'');
  await composer().fill('Bob 独立草稿');await page.getByRole('button',{name:'退出',exact:true}).click();await login('alice');await retry().waitFor();
  assert.equal(await composer().inputValue(),'Alice 私人待写草稿');assert.deepEqual((await readPending()).input,alicePending.input);
  const spaceRoute=async route=>{const response=await route.fetch();const identity=await response.json();await route.fulfill({response,json:{...identity,space_id:'synthetic-other-space'}});};
  await page.route('**/api/session',spaceRoute);await page.reload();await composer().waitFor();assert.equal(await retry().count(),0);assert.equal(await composer().inputValue(),'');
  await composer().fill('另一个空间的独立草稿');await page.unroute('**/api/session',spaceRoute);await page.reload();await retry().waitFor();assert.equal(await composer().inputValue(),'Alice 私人待写草稿');
  await retry().click();await until(async()=>await readPending()===null,'original identity retry');await isolated.remove();
  checks.push('真实Alice/Bob切换隔离待确认消息与草稿；只读身份响应夹具验证同用户不同空间的前端隔离，返回原身份后可接回');

  for(const item of (await h.snapshot(created.conversation_id)).messages.filter(item=>item.role==='user'))ok(await h.request(`/conversations/${created.conversation_id}/messages/${item.message_id}/withdraw`,{operation_id:randomUUID()}));
  for(const removal of ['ui','external']) {
    const target=await h.create();const title='删除可靠性测试会话 '+removal;
    const seed=await h.send(target,title);ok(await h.request(`/conversations/${target}/messages/${seed.message_id}/withdraw`,{operation_id:randomUUID()}));await openConversation(target);
    const lost=droppedResponse(`**/api/conversations/${target}/messages`);await lost.install();
    const original='执行合成设备检查查询 '+removal;const later='原会话后来写下的草稿 '+removal;const freshDraft='新会话原有独立草稿 '+removal;
    await composer().fill(original);await send().click();await lost.accepted;await composer().fill(later);lost.release();await retry().waitFor();const frozen=await readPending();await lost.remove();
    await page.evaluate(({key,text})=>localStorage.setItem(key,text),{key:draftKey(null),text:freshDraft});const before=counts(target);
    if(removal==='ui') {
      await page.getByRole('button',{name:'查看全部会话 ↗',exact:true}).click();await page.getByRole('button',{name:'删除会话 '+title,exact:true}).click();
      await page.getByRole('dialog',{name:'删除这个会话？'}).getByRole('button',{name:'删除此会话',exact:true}).click();await page.getByRole('dialog',{name:'删除这个会话？'}).waitFor({state:'detached'});
      await page.getByRole('dialog',{name:'全部会话'}).getByRole('button',{name:'关闭',exact:true}).click();await until(async()=>await storedCid()===null,'deleted current conversation released');assert.equal(await composer().inputValue(),freshDraft);
    } else ok(await h.request('/conversations/'+target,{operation_id:randomUUID()},'alice','DELETE'));
    await retry().click();await until(async()=>await readPending()===null,'unavailable target releases pending');
    await page.getByText('原对话已删除或不可访问，无法继续核对原消息是否已保存。已结束这次重试；请新建对话继续。',{exact:true}).waitFor();
    assert.equal(await page.evaluate(key=>localStorage.getItem(key),draftKey(target)),later);assert.deepEqual(counts(target),before);
    assert.equal(h.sql(`SELECT COUNT(*) FROM conversation_messages WHERE client_key='${frozen.input.client_message_id}'`)[0],1);assert.equal(h.sql('SELECT COUNT(*) FROM query_requests')[0],0);
    if(removal==='external'){assert.equal(await composer().inputValue(),later);await page.getByRole('button',{name:'新对话',exact:true}).click();}
    assert.equal(await composer().inputValue(),freshDraft);await page.getByText('查看原对话保留的草稿',{exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'原对话保留的草稿'}).inputValue(),later);
    await page.getByRole('button',{name:'收起此提示',exact:true}).click();const total=h.sql('SELECT COUNT(*) FROM conversation_messages')[0];await page.waitForTimeout(400);assert.equal(h.sql('SELECT COUNT(*) FROM conversation_messages')[0],total);
    const newText='仅讨论合成保养安排的新问题 '+removal;await composer().fill(newText);await send().click();await until(async()=>await readPending()===null&&await storedCid()!==null,'explicit new message saved');const next=await storedCid();assert.notEqual(next,target);
    assert.deepEqual(counts(next),{messages:1,budgets:1,jobs:1});const message=(await h.snapshot(next)).messages.find(item=>item.role==='user');assert.equal(message.text,newText);assert.deepEqual(counts(target),before);assert.equal(h.sql('SELECT COUNT(*) FROM query_requests')[0],0);
    ok(await h.request(`/conversations/${next}/messages/${message.message_id}/withdraw`,{operation_id:randomUUID()}));
  }
  checks.push('真实消息已保存后丢回执，当前页删除及后台删除目标都可结束无法核对的pending；原/新草稿各自保留，无自动重投或查询，显式新消息才创建独立记录');

  const legacy=await h.create();
  await page.evaluate(({key,legacy})=>{localStorage.removeItem(key);localStorage.setItem('data-agent.conversation.alice',legacy);localStorage.setItem('data-agent.draft.alice.'+legacy,'可读旧会话的草稿');localStorage.setItem('data-agent.draft.alice.new','无法判定空间的新草稿');},{key:conversationKey(),legacy});
  await page.reload();await until(async()=>await storedCid()===legacy,'legacy readable conversation migrated');await until(async()=>await composer().inputValue()==='可读旧会话的草稿','legacy draft migrated');
  assert.equal(await page.evaluate(()=>localStorage.getItem('data-agent.draft.alice.new')),'无法判定空间的新草稿');assert.equal(await page.evaluate(()=>localStorage.getItem('data-agent.conversation.alice')),null);
  await page.getByRole('button',{name:'退出',exact:true}).click();await login('bob');await page.evaluate(({legacy,key})=>{localStorage.removeItem(key);localStorage.setItem('data-agent.conversation.bob',legacy);localStorage.setItem('data-agent.draft.bob.'+legacy,'不可读旧会话草稿');},{legacy,key:conversationKey('demo','bob')});await page.reload();await composer().waitFor();await page.waitForTimeout(800);assert.notEqual(await composer().inputValue(),'不可读旧会话草稿');assert.equal(await page.evaluate(key=>localStorage.getItem(key),conversationKey('demo','bob')),null);
  await page.getByRole('button',{name:'退出',exact:true}).click();await login('alice');await openConversation(legacy);
  checks.push('旧会话经服务端授权后迁移关联草稿；不可读会话不迁移，无会话旧草稿留存且不归入任意空间');

  const firstSnapshot=await h.snapshot(legacy);const merged=mergeSnapshot(null,firstSnapshot);const empty=(await h.request(`/conversations/${legacy}/snapshot?after_seq=${firstSnapshot.last_event_seq}`)).value;
  assert.equal(mergeSnapshot(merged,empty),merged);
  const requestTimes=[];const countRequest=request=>{if(request.method()==='GET'&&new URL(request.url()).pathname.startsWith('/api/'))requestTimes.push({time:Date.now(),path:new URL(request.url()).pathname});};page.on('request',countRequest);
  await page.waitForTimeout(8000);requestTimes.length=0;const idleStart=Date.now();await page.waitForTimeout(30000);await page.waitForTimeout(30000);const idle=requestTimes.splice(0);measurements.idleWindowMs=Date.now()-idleStart;measurements.idleRequests=idle.length;measurements.idlePaths=idle.map(item=>item.path);
  assert.ok(idle.length<=15,`idle requests ${idle.length}/60s exceeds 15`);
  await visibility(true);await page.waitForTimeout(300);requestTimes.length=0;await page.waitForTimeout(5000);assert.equal(requestTimes.length,0);const resumed=Date.now();await visibility(false);await until(()=>requestTimes.some(item=>item.path.endsWith('/snapshot')),'visible refresh',2000);measurements.visibilityRefreshMs=Date.now()-resumed;
  page.off('request',countRequest);checks.push('完整60秒空闲窗口API GET不超过15次，空增量复用历史引用；可见性事件夹具隐藏期间零请求，恢复立即读取');

  const manager=SessionManager.inMemory('/synthetic/data-agent');const active=await h.create();await openConversation(active);await h.resumeWorker();
  const run=await h.capture(active,'检查合成设备状态，仅准备查询');await h.pauseWorker();
  const checkpoint=()=>exportCheckpoint(manager,run.workspace_context.authority_revision,run.workspace_context.authority_snapshot);
  const invoke=async(name,args)=>{const input={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:randomUUID(),tool_name:name,arguments:args,checkpoint:checkpoint()};ok(await h.internal('/internal/data/tool-calls',input));return ok(await h.internal('/internal/data/tools',input)).data;};
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.getByRole('button',{name:'停止生成',exact:true}).waitFor({timeout:2500});
  const task=await invoke('update_analysis_task',{action:'create',goal:'核对合成设备区域与检查次数',conditions:{time_start:null,time_end:null,timezone:'UTC',metric:null,channel:null,group_by:[],filters:[],knowledge_refs:[],notes:''},options:[]});
  const queries=[];for(const region of ['north','south'])queries.push(await invoke('request_query',{task_id:task.task_id,condition_version:task.condition_version,sql:`SELECT '${region}' AS region, 7 AS inspections`,parameters:{},target_id:'synthetic-sqlite',replaces_query_id:null,summary:`合成设备${region}检查`,knowledge_refs:[]}));
  await invoke('update_analysis_task',{action:'route',task_id:task.task_id,expected_version:task.condition_version,goal:'',options:[]});
  const final='SQL已准备好。';ok(await h.internal('/internal/outputs',{run_id:run.run_id,lease_epoch:run.lease_epoch,chunk_seq:'1',text:final}));ok(await h.internal('/internal/finish',{run_id:run.run_id,lease_epoch:run.lease_epoch,commit_id:run.output_id,final_text:final,checkpoint:checkpoint()}));h.releaseRun(run.run_id);
  for(const query of queries)ok(await h.request(`/queries/${query.id}/confirm`,{operation_id:randomUUID(),draft_version:query.draft_version,condition_version:query.condition_version}));await h.resumeWorker();
  for(const query of queries)await until(async()=>ok(await h.request('/queries/'+query.id)).execution_state==='running','query started');
  await until(async()=>await page.getByRole('heading',{name:'查询运行中',exact:true}).count()===2,'running queries visible',2500);
  await composer().fill('两条查询运行期间保留的新草稿');await visibility(true);ok(await h.request(`/queries/${queries[1].id}/cancel`,{operation_id:randomUUID()}));await until(async()=>ok(await h.request('/queries/'+queries[1].id)).execution_state==='cancelled','hidden query cancelled');const cancelStart=Date.now();await visibility(false);await page.locator('#query-'+queries[1].id).getByRole('heading',{name:'已取消',exact:true}).waitFor({timeout:2500});measurements.cancelVisibilityMs=Date.now()-cancelStart;
  const activeTimes=[];const activeRequests=request=>{if(new URL(request.url()).pathname===`/api/conversations/${active}/snapshot`)activeTimes.push(Date.now());};page.on('request',activeRequests);await page.waitForTimeout(3000);page.off('request',activeRequests);assert.ok(activeTimes.length>=3);measurements.activeSnapshotIntervalsMs=activeTimes.slice(1).map((time,index)=>time-activeTimes[index]);assert.ok(measurements.activeSnapshotIntervalsMs.every(time=>time<1500));
  execFileSync('python3',['-c','import sqlite3,sys\nwith sqlite3.connect(sys.argv[1]) as db: db.execute("UPDATE submissions SET ready_at=0 WHERE id=?",(sys.argv[2],))',h.directory+'/platform/submissions.sqlite',queries[0].id]);await until(async()=>ok(await h.request('/queries/'+queries[0].id)).execution_state==='succeeded','synthetic query completed');const resultStart=Date.now();await page.locator('#query-'+queries[0].id).getByRole('cell',{name:'north',exact:true}).waitFor({timeout:2500});measurements.resultRenderMs=Date.now()-resultStart;assert.equal(await composer().inputValue(),'两条查询运行期间保留的新草稿');assert.equal(await page.locator('#query-'+queries[1].id).getByRole('heading',{name:'已取消',exact:true}).count(),1);
  checks.push('实际活动运行快速显示停止入口，两条独立合成查询持续快速刷新；隐藏时取消、可见时接回，另一条结果归原查询且草稿保留');
  assert.deepEqual(errors,[]);passed=true;console.log(JSON.stringify({passed,checks,measurements,officialRequests:0}));
} finally {
  await page.screenshot({path:directory+'/last-state.png',fullPage:true}).catch(()=>{});
  await writeFile(directory+'/report.json',JSON.stringify({passed,checks,measurements,errors,officialRequests:0},null,2));
  await browser.close();await h.close();
}

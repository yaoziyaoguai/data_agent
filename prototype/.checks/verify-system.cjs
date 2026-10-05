/* 合成原型的浏览器集成检查。运行：NODE_PATH=<已有依赖目录> node prototype/.checks/verify-system.cjs */
const {chromium} = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const inputs = ['index.html','app.js','personal.js','knowledge.js','shell.js','shell.css','workbench.js','workbench.css','workbench-fixture.js','demo-source.js','demo-analysis.js','style.css','knowledge.css'];
const hashes = () => Object.fromEntries(inputs.map(file => [file,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')]));
const base = process.env.PROTOTYPE_URL || 'http://127.0.0.1:8765/';
const report = {startedAt:new Date().toISOString(),scope:'隔离浏览器中的前端合成流程；不验证模型、账号权限、数仓查询或生产恢复。',inputHashes:hashes(),scenarios:[],pageErrors:[],screenshots:[]};
let browser;
const wb = action => `[data-wb-action="${action}"]`;
const privateKey = user => 'data-agent-retail-synthetic-v1-personal-'+user;
const skillKey = user => 'data-agent-system-prototype-v1-skills-'+user;
const dbKey = user => 'data-agent-system-prototype-v1-workbench-'+user;
const read = (page,key) => page.evaluate(k=>JSON.parse(localStorage.getItem(k)||'null'),key);
const queries = page => page.evaluate(()=>workbenchDemo.getQueries());
const conversations = page => page.evaluate(()=>workbenchDemo.getConversations());
const send = async (page,message) => {await page.locator('[data-wb-input]').fill(message);await page.locator('[data-wb-send]').click();};
const nav = (page,route) => page.locator(`.shell-nav [data-page="${route}"]`).click();
const showPane = async (page,pane) => {const button=page.locator(wb(`show-${pane}`));if(await button.isVisible())await button.click();};
const startNew = async page => {if(!await page.locator('[data-shell-new]:visible').count())await page.locator('[data-shell-history]:visible').first().click();await page.locator('[data-shell-new]:visible').first().click();};
const openConversation = async (page,id) => {await page.locator('[data-shell-history]:visible').first().click();await page.locator('[data-history-kind="conversations"]').click();await page.locator(`#history-dialog [data-shell-conversation="${id}"]`).click();};
const completed = async (page,id) => {await page.waitForFunction(id=>workbenchDemo.getQueries().some(q=>q.id===id&&q.status==='completed'),id);return (await queries(page)).find(q=>q.id===id);};
const confirm = async page => {await page.locator(wb('confirm')).click();return (await queries(page))[0];};
const activeDb = async page => {const db=await read(page,dbKey('analyst-a'));return {db,c:db.conversations.find(c=>c.id===db.activeConversationId)};};
const screenshot = async (page,name) => {const file=`system-flow-${name}.png`;await page.screenshot({path:path.join(__dirname,file),fullPage:true,animations:'disabled'});report.screenshots.push(file);};
function cleanError(error){return String(error.message||error).replace(/https?:\/\/127\.0\.0\.1:\d+[^\s]*/g,'<local-preview>').replace(/\/Users\/[^\s]+/g,'<local-path>').slice(0,3000);}
async function scenario(name,fn,viewport={width:1440,height:960}){
 const result={name,checks:[],passed:false};report.scenarios.push(result);
 const context=await browser.newContext({viewport,acceptDownloads:true});
 const page=await context.newPage();page.setDefaultTimeout(4500);
 page.on('pageerror',error=>report.pageErrors.push({scenario:name,message:cleanError(error)}));
 const check=(label,value,details)=>{assert.ok(value,label);result.checks.push({name:label,passed:true,...(details?{details}:{})});};
 try {await page.goto(base);await page.locator('[data-wb-input]').waitFor();await fn(page,check);result.passed=true;}
 catch(error){result.error=cleanError(error);await screenshot(page,`failure-${report.scenarios.length}`).catch(()=>{});}
 finally {await context.close();}
}
(async()=>{
 browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||'chrome'});
 await scenario('default-entry-and-widths',async(page,check)=>{
  check('默认工作台',await page.locator('body').getAttribute('data-page')==='workbench');
  check('首页无可见空详情',!await page.locator('.wb-detail-empty').isVisible());
  const columns=await page.locator('[data-wb-root]').evaluate(el=>getComputedStyle(el).gridTemplateColumns);
  check('首页为单列网格',columns.trim().split(/\s+/).length===1,{columns});
  await page.locator(wb('example')).first().click();
  check('示例只填写输入',!!await page.locator('[data-wb-input]').inputValue()&&await page.locator('[data-wb-message]').count()===0&&(await queries(page)).length===0);
  check('桌面首页无水平溢出',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await screenshot(page,'desktop-home');
  await page.setViewportSize({width:390,height:844});
  check('移动首页无水平溢出',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  const history=page.locator('[data-shell-history]:visible').first();check('移动历史入口可见',await history.isVisible());await history.click();
  check('移动历史弹层可达',await page.locator('#history-dialog').isVisible());
  check('移动历史无水平溢出',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.locator('[data-history-close]').first().click();await screenshot(page,'mobile-home');
 });
 for(const [size,viewport] of Object.entries({desktop:{width:1440,height:960},mobile:{width:390,height:844}}))await scenario(`conversation-entry-scope-and-drafts-${size}`,async(page,check)=>{
  check('首次首页没有历史会话',(await conversations(page)).length===0);
  check('新对话位于工作台会话区',await page.locator('#shell-conversations').isVisible()&&await page.locator('#shell-conversations [data-shell-new]').isVisible());
  await send(page,'2026 年 1 月净收入是多少？');
  const firstId=await page.locator('[data-wb-conversation]').getAttribute('data-wb-conversation');
  const firstTask=await page.locator('.wb-detail[data-wb-detail-task]').getAttribute('data-wb-detail-task');
  check('无需新建即可提问并生成SQL',(await conversations(page)).length===1&&!!await page.locator('[data-wb-sql]').textContent()&&(await queries(page)).length===0);
  check('单任务不显示任务切换',!await page.locator('[data-wb-task-select]').isVisible());
  await send(page,'月份改为 2 月，其他条件不变');await send(page,'2026 年 1 月支付客户数是多少？');
  await showPane(page,'task');await page.locator('[data-wb-task-select]').selectOption(firstTask);await page.locator('[data-wb-version-select]').selectOption('1');
  const selectedSql=await page.locator('[data-wb-sql]').innerText();await showPane(page,'chat');
  const firstDraft='第一条对话未发送：按渠道拆分净收入';await page.locator('[data-wb-input]').fill(firstDraft);
  const messageCount=await page.locator('[data-wb-message]').count();
  for(const route of ['assets','semantic']){
   await nav(page,route);
   check(`${route}:不显示新对话与会话入口`,await page.locator('[data-shell-new]:visible').count()===0&&await page.locator('[data-shell-history]:visible').count()===0&&await page.locator('[data-shell-conversation]:visible').count()===0&&!await page.locator('#shell-conversations').isVisible());
   await nav(page,'workbench');
   check(`${route}:返回原对话并保留未发送输入`,await page.locator('[data-wb-conversation]').getAttribute('data-wb-conversation')===firstId&&await page.locator('[data-wb-input]').inputValue()===firstDraft&&await page.locator('[data-wb-message]').count()===messageCount);
   check(`${route}:保留当前任务和SQL查看版本`,await page.locator('[data-wb-task-select]').inputValue()===firstTask&&await page.locator('[data-wb-version-select]').inputValue()==='1'&&await page.locator('[data-wb-sql]').innerText()===selectedSql);
  }
  await screenshot(page,`${size}-conversation-restored`);
  if(!await page.locator('[data-shell-new]:visible').count())await page.locator('[data-shell-history]:visible').first().click();
  check('新会话入口命名为新对话',await page.getByRole('button',{name:'新对话',exact:true}).isVisible());
  await page.locator('[data-shell-new]:visible').first().click();
  const blankId=await page.locator('[data-wb-conversation]').getAttribute('data-wb-conversation');
  const blankState=await read(page,dbKey('analyst-a'));
  check('新对话清空当前输入且保留旧历史',blankId!==firstId&&await page.locator('[data-wb-input]').inputValue()===''&&await page.locator('[data-wb-message]').count()===0&&(await conversations(page)).some(c=>c.id===firstId));
  await startNew(page);await startNew(page);
  const repeatedState=await read(page,dbKey('analyst-a'));
  check('空白重复点击不生成额外空会话',await page.locator('[data-wb-conversation]').getAttribute('data-wb-conversation')===blankId&&repeatedState.conversations.length===blankState.conversations.length&&(await conversations(page)).length===1);
  await send(page,'2026 年 2 月支付客户数是多少？');
  const secondId=await page.locator('[data-wb-conversation]').getAttribute('data-wb-conversation');
  const secondDraft='第二条对话未发送：仅查看 web 渠道';await page.locator('[data-wb-input]').fill(secondDraft);
  await openConversation(page,firstId);
  check('返回第一旧会话恢复其独立草稿',await page.locator('[data-wb-input]').inputValue()===firstDraft&&await page.locator('[data-wb-conversation]').getAttribute('data-wb-conversation')===firstId);
  await openConversation(page,secondId);
  check('返回第二旧会话恢复其独立草稿',await page.locator('[data-wb-input]').inputValue()===secondDraft&&await page.locator('[data-wb-conversation]').getAttribute('data-wb-conversation')===secondId);
  check('草稿切换不发送消息或执行查询',(await queries(page)).length===0&&(await conversations(page)).length===2&&!((await read(page,dbKey('analyst-a'))).conversations.flatMap(c=>c.messages).some(m=>m.text===firstDraft||m.text===secondDraft)));
  check('会话区和页面无水平溢出',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await screenshot(page,`${size}-conversation-history`);
 },viewport);
 await scenario('legacy-composer-migration',async(page,check)=>{
  await send(page,'2026 年 1 月净收入是多少？');const firstId=await page.locator('[data-wb-conversation]').getAttribute('data-wb-conversation');
  await startNew(page);await send(page,'2026 年 2 月支付客户数是多少？');const secondId=await page.locator('[data-wb-conversation]').getAttribute('data-wb-conversation');
  const oldState=await read(page,dbKey('analyst-a'));const legacyDraft='旧版未发送草稿：按渠道核对客户数';
  for(const conversation of oldState.conversations)delete conversation.composer;
  oldState.composer=legacyDraft;
  await page.addInitScript(({key,value})=>{const marker='system-check-legacy-composer-loaded';if(!sessionStorage.getItem(marker)){localStorage.setItem(key,JSON.stringify(value));sessionStorage.setItem(marker,'1');}},{key:dbKey('analyst-a'),value:oldState});await page.reload();
  check('旧版全局草稿恢复到原活动会话',await page.locator('[data-wb-conversation]').getAttribute('data-wb-conversation')===secondId&&await page.locator('[data-wb-input]').inputValue()===legacyDraft);
  await openConversation(page,firstId);check('旧版草稿不串到其他会话',await page.locator('[data-wb-input]').inputValue()==='');
  await openConversation(page,secondId);check('迁移草稿在会话切换后仍保留',await page.locator('[data-wb-input]').inputValue()===legacyDraft);
  check('迁移不发送草稿或执行查询',(await conversations(page)).length===2&&(await queries(page)).length===0&&!((await read(page,dbKey('analyst-a'))).conversations.flatMap(c=>c.messages).some(m=>m.text===legacyDraft)));
 });
 await scenario('unsent-first-message-in-history',async(page,check)=>{
  const originalId=await page.locator('[data-wb-conversation]').getAttribute('data-wb-conversation');const draft='尚未发送：2026 年 1 月净收入是多少？';
  await page.locator('[data-wb-input]').fill(draft);await startNew(page);
  const newId=await page.locator('[data-wb-conversation]').getAttribute('data-wb-conversation');
  check('首条未发送草稿成为可恢复记录',newId!==originalId&&(await conversations(page)).some(c=>c.id===originalId)&&await page.locator('[data-wb-input]').inputValue()==='');
  await openConversation(page,originalId);
  check('从历史恢复首条未发送草稿',await page.locator('[data-wb-input]').inputValue()===draft&&await page.locator('[data-wb-conversation]').getAttribute('data-wb-conversation')===originalId);
  check('恢复草稿仍没有消息与SQL',await page.locator('[data-wb-message]').count()===0&&await page.locator('[data-wb-sql]').count()===0&&(await queries(page)).length===0);
 });
 await scenario('refund-clarification-and-version-guard',async(page,check)=>{
  for(const denominator of ['order','amount','customer']){
   if(denominator!=='order')await startNew(page);
   await send(page,'2026 年 1 月退款率是多少？');
   check(`${denominator}:提供三种退款分母`,await page.locator(wb('clarify')).count()===3);
   check(`${denominator}:澄清前没有可确认SQL`,!await page.locator(wb('confirm')).count());
   await page.locator(`${wb('clarify')}[data-wb-denominator="${denominator}"]`).click();
   const sql=await page.locator('[data-wb-sql]').innerText();
   const expected={order:'COUNT(DISTINCT order_id)',amount:'SUM(paid_amount_cents)',customer:'COUNT(DISTINCT customer_id)'}[denominator];
   check(`${denominator}:SQL采用选择的分母`,sql.includes(expected));
   check(`${denominator}:未确认不执行`,(await queries(page)).length===0);
  }
  const before=+(await page.locator('[data-wb-version-select]').inputValue());await send(page,'月份改为 2 月，其他条件不变');
  const after=+(await page.locator('[data-wb-version-select]').inputValue());check('修订增加版本',after===before+1);
  await page.locator('[data-wb-version-select]').selectOption(String(before));check('旧版本没有确认入口',await page.locator(wb('confirm')).count()===0);
  await page.locator('[data-wb-version-select]').selectOption(String(after));check('当前版本可以确认',await page.locator(wb('confirm')).isVisible());
  await screenshot(page,'sql-revision');
 });
 await scenario('query-task-attribution-result-and-csv',async(page,check)=>{
  await send(page,'2026 年 1 月净收入是多少？');check('SQL展示且未提交',await page.locator('[data-wb-sql]').isVisible()&&(await queries(page)).length===0);
  await page.locator(wb('confirm')).dblclick();let list=await queries(page);check('重复确认只创建一次查询',list.length===1);
  const first=list[0];check('确认后进入运行状态',first.status==='running');
  await send(page,'2026 年 1 月有多少支付客户？');const secondTask=await page.locator('[data-wb-task-select]').inputValue();
  check('运行时可以新建第二任务',await page.locator('[data-wb-task-select] option').count()===2&&secondTask!==first.taskId);
  const result=await completed(page,first.id);check('完成结果仍归原任务',result.taskId===first.taskId&&result.conversationId===first.conversationId&&await page.locator('[data-wb-task-select]').inputValue()===secondTask);
  check('净收入为12400分',result.rows[0].net_revenue_cents===12400);
  await page.locator(`${wb('query')}[data-wb-query-id="${first.id}"]`).last().click();
  check('结果对应原查询',await page.locator(`[data-wb-result="${first.id}"]`).isVisible());
  check('结果表显示12400分',(await page.locator('.wb-table').innerText()).includes('12400'));
  check('已执行SQL在结果下方且默认折叠',await page.locator('.wb-detail').evaluate(el=>{const r=el.querySelector('.wb-result'),s=el.querySelector('.wb-sql');return !s.open&&Boolean(r.compareDocumentPosition(s)&Node.DOCUMENT_POSITION_FOLLOWING)&&s.querySelector('summary').textContent.includes('已执行');}));
  const downloadPromise=page.waitForEvent('download');await page.locator(`${wb('csv')}[data-wb-query-id="${first.id}"]`).click();const download=await downloadPromise;
  const stream=await download.createReadStream();const chunks=[];for await(const c of stream)chunks.push(c);const csv=Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/,'');
  check('CSV与结果表一致',csv==='"净收入（分）"\r\n"12400"');
  await screenshot(page,'result');
  await page.locator('[data-shell-history]:visible').first().click();await page.locator('[data-history-kind="queries"]').click();await page.locator('#history-search').fill('净收入');
  check('历史搜索定位原查询',await page.locator(`[data-shell-query="${first.id}"]`).count()===1);
  await page.locator(`[data-shell-query="${first.id}"]`).click();check('历史打开原查询',(await page.locator(`[data-wb-result="${first.id}"]`).count())===1&&!await page.locator('#history-dialog').isVisible());
  await page.setViewportSize({width:390,height:844});await page.locator(wb('show-task')).click();check('移动结果页无水平溢出',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await screenshot(page,'mobile-result');
 });
 await scenario('evidence-navigation-and-unsaved-semantic',async(page,check)=>{
  await send(page,'2026 年 1 月净收入是多少？');const messageCount=await page.locator('[data-wb-message]').count();
  await page.locator(wb('field-evidence')).click();
  const field=page.locator('[data-field="col.paid_at.description"]');await field.waitFor({state:'visible'});
  check('依据定位paid_at字段',await page.locator('body').getAttribute('data-page')==='semantic'&&await field.isVisible());
  const edited='支付时间说明（跨页未保存验证）';await field.fill(edited);await page.locator('[data-shell-return]:visible').click();
  check('返回分析对话不丢',await page.locator('[data-wb-message]').count()===messageCount);
  await page.locator(wb('field-evidence')).click();check('未保存语义跨页保留',await field.inputValue()===edited);
  await page.locator('[data-shell-return]:visible').click();await page.locator(wb('metric-evidence')).click();
  check('依据定位净收入指标',await page.locator('[data-metric="net_revenue"]').evaluate(el=>el.classList.contains('selected')));
  await page.locator('[data-shell-return]:visible').click();await page.locator('.wb-evidence '+wb('evidence')).click();
  check('依据定位业务文档章节',await page.locator('#knowledge-dialog').isVisible()&&await page.locator('#doc-section-refund-scope.section-highlight').count()===1);
  await page.locator('[data-knowledge-close]').click();await page.locator('[data-shell-return]:visible').click();check('文档返回对话不丢',await page.locator('[data-wb-message]').count()===messageCount);
 });
 await scenario('correction-memory-and-one-off-conditions',async(page,check)=>{
  await send(page,'2026 年 1 月支付客户数是多少？');
  const original=await read(page,privateKey('analyst-a'));const count=original?.memories.length??2;
  await send(page,'仅本次将月份改为 2 月，不要记住');
  check('一次性月份修改不生成长期记忆',(await read(page,privateKey('analyst-a')))?.memories.length===original?.memories.length&&await page.locator(wb('memory')).count()===0);
  await send(page,'月客户 UV 不能累加日 UV，应该在整个月重新去重');
  const saved=await read(page,privateKey('analyst-a'));const memory=saved.memories.find(m=>m.content.includes('月客户 UV 不能累加日 UV'));
  check('明确UV纠错自动记住',!!memory&&saved.memories.length===count+1&&memory.kind==='correction'&&memory.status==='pending'&&memory.target==='paid_customer_uv'&&!!memory.scope);
  check('自动记忆通知含查看和撤销',await page.locator(wb('memory')).count()===1&&await page.locator(wb('undo-memory')).count()===1);
  await page.locator(wb('memory')).click();check('查看定位个人记忆卡片',await page.locator(`[data-memory-card="${memory.id}"]`).isVisible());
  await page.locator('[data-shell-return]:visible').click();await page.locator(wb('undo-memory')).click();
  check('撤销自动记忆保留对话',!(await read(page,privateKey('analyst-a'))).memories.some(m=>m.id===memory.id)&&await page.locator(wb('memory')).count()===1);
  await send(page,'月客户 UV 不能累加日 UV，应该在整个月重新去重');await send(page,'月客户 UV 不能累加日 UV，应该在整个月重新去重');
  const latest=await read(page,privateKey('analyst-a'));check('重复纠错不重复保存',latest.memories.filter(m=>m.content.includes('月客户 UV 不能累加日 UV')).length===1);
  check('已有纠错通知不重复提供新建撤销',await page.locator(wb('undo-memory')).count()===1);
  await screenshot(page,'correction');
 });
 await scenario('skills-lifecycle-and-user-assets',async(page,check)=>{
  await send(page,'2026 年 1 月净收入是多少？');const q=await confirm(page);await completed(page,q.id);
  await page.locator(wb('save-skill')).click();await page.locator('#shell-skill-form [name="name"]').fill('集成验证净收入方法');await page.locator('#shell-skill-form button[type="submit"]').click();
  let skills=await read(page,skillKey('analyst-a'));const custom=skills.find(s=>s.name==='集成验证净收入方法');check('分析保存Skill且v1',!!custom&&custom.version===1);
  let state=await activeDb(page);check('保存不会自动采用',state.c.selectedSkill===null);
  await page.locator(`[data-skill-edit="${custom.id}"]`).click();await page.locator('#shell-skill-form [name="description"]').fill('编辑后的净收入分析方法');await page.locator('#shell-skill-form button[type="submit"]').click();
  skills=await read(page,skillKey('analyst-a'));const edited=skills.find(s=>s.id===custom.id);check('Skill编辑产生v2并保留旧版',edited.version===2&&edited.history.length===1&&edited.history[0].version===1);
  await page.locator(`[data-skill-use="${custom.id}"]`).click();state=await activeDb(page);check('显式选用Skill版本',state.c.selectedSkill?.id===custom.id&&state.c.selectedSkill.version===2);
  await send(page,'2026 年 2 月净收入是多少？');state=await activeDb(page);check('后续任务采用已选Skill',state.c.tasks.at(-1).skill?.version===2);
  await nav(page,'assets');await page.locator('[data-asset-section="skills"]').first().click();await page.locator(`[data-skill-toggle="${custom.id}"]`).click();
  check('停用后不可选用',await page.locator(`[data-skill-use="${custom.id}"]`).isDisabled());state=await activeDb(page);check('停用清除后续采用',state.c.selectedSkill===null&&state.c.tasks.at(-1).skill===null);
  await page.locator(`[data-skill-toggle="${custom.id}"]`).click();await page.locator(`[data-skill-use="${custom.id}"]`).click();await nav(page,'assets');await page.locator('[data-asset-section="skills"]').first().click();await page.locator(`[data-skill-delete="${custom.id}"]`).click();
  state=await activeDb(page);check('删除清除后续采用',!(await read(page,skillKey('analyst-a'))).some(s=>s.id===custom.id)&&state.c.selectedSkill===null&&state.c.tasks.at(-1).skill===null);
  await page.locator('[data-skill-new]').first().click();for(const [key,value] of Object.entries({name:'用户A专属方法',scope:'用户A范围',description:'独立测试',steps:'检查用户范围\n确认SQL'}))await page.locator(`#shell-skill-form [name="${key}"]`).fill(value);await page.locator('#shell-skill-form button[type="submit"]').click();
  await nav(page,'workbench');const correction='月客户 UV 不要累加每日 UV（用户A专属纠错）';await send(page,correction);
  const personalA=await read(page,privateKey('analyst-a'));const privateMemory=personalA.memories.find(m=>m.content===correction);check('工作台生成A的专属纠错',!!privateMemory&&privateMemory.kind==='correction');
  await nav(page,'assets');await page.locator('[data-asset-section="skills"]').first().click();
  await page.locator('#shell-profile').selectOption('developer-b');check('用户B无A的Skill',!(await page.locator('#skills-workspace').innerText()).includes('用户A专属方法')&&await page.locator('[data-skill-use]').count()===0);
  await nav(page,'workbench');check('用户B无A会话',(await conversations(page)).length===0&&(await queries(page)).length===0);
  await nav(page,'assets');await page.locator('[data-asset-section="memory"]').click();check('用户B只显示自身记忆',await page.locator('[data-memory-card="correction-b"]').count()===1&&await page.locator('[data-memory-card="correction-a"]').count()===0);
  const personalB=await read(page,privateKey('developer-b'));check('新纠错不进入B的界面或存储',await page.locator(`[data-memory-card="${privateMemory.id}"]`).count()===0&&!(personalB?.memories||[]).some(m=>m.id===privateMemory.id||m.content===correction));
  await page.locator('#shell-profile').selectOption('analyst-a');check('切回A恢复新纠错',await page.locator(`[data-memory-card="${privateMemory.id}"]`).isVisible()&&(await read(page,privateKey('analyst-a'))).memories.some(m=>m.id===privateMemory.id));
  await page.locator('[data-asset-section="skills"]').first().click();check('切回A恢复专属Skill',(await page.locator('#skills-workspace').innerText()).includes('用户A专属方法'));
  await screenshot(page,'skills');
 });
 await scenario('assets-and-semantic-widths',async(page,check)=>{
  for(const [size,viewport] of Object.entries({desktop:{width:1440,height:960},mobile:{width:390,height:844}})){
   await page.setViewportSize(viewport);await nav(page,'assets');
   for(const section of ['memory','skills']){
    await page.locator(`[data-asset-section="${section}"]`).first().click();
    const visible=await page.locator(section==='memory'?'#personal-workspace':'#skills-workspace').isVisible();
    check(`${size}:${section}资产可见且无水平溢出`,visible&&await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    if(size==='mobile')await screenshot(page,`mobile-assets-${section}`);
   }
   await nav(page,'semantic');
   for(const tab of ['overview','fields','lineage','metrics','documents','history']){
    await page.locator(`[data-tab="${tab}"]`).click();
    check(`${size}:${tab}语义页无水平溢出`,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   }
   if(size==='mobile'){await page.locator('[data-tab="fields"]').click();await screenshot(page,'mobile-semantic');}
  }
 });
 await scenario('mobile-chat-and-task-navigation',async(page,check)=>{
  await send(page,'2026 年 1 月净收入是多少？');
  check('移动对话可继续输入',await page.locator('[data-wb-input]').isVisible());
  check('移动对话不重复展示执行确认',!await page.locator(wb('confirm')).isVisible());
  const messageCount=await page.locator('[data-wb-message]').count();
  await page.locator(wb('show-task')).click();
  check('移动任务显示SQL并收起输入框',await page.locator('[data-wb-sql]').isVisible()&&!await page.locator('[data-wb-input]').isVisible());
  const query=await confirm(page);await completed(page,query.id);
  check('移动任务显示所属结果',await page.locator(`[data-wb-result="${query.id}"]`).isVisible());
  const resultTop=await page.locator(`[data-wb-result="${query.id}"]`).evaluate(el=>el.getBoundingClientRect().top);
  check('移动结果在首屏内开始展示',resultTop>=0&&resultTop<844,{resultTop});
  check('移动任务页无水平溢出',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await screenshot(page,'mobile-focused-result');
  await page.locator(wb('show-chat')).click();
  check('返回对话保留消息与输入',await page.locator('[data-wb-input]').isVisible()&&await page.locator('[data-wb-message]').count()>messageCount);
  await send(page,'2026 年 2 月支付客户数是多少？');
  check('移动返回后可以开始新任务',await page.locator('[data-wb-task-select] option').count()===2&&(await queries(page)).length===1);
  await page.locator(wb('show-task')).click();
  check('移动第二任务仍需确认',await page.locator(wb('confirm')).isVisible()&&await page.locator('[data-wb-sql]').isVisible());
 },{width:390,height:844});
 await scenario('keyboard-focus-dialogs-and-icon-name',async(page,check)=>{
  for(const [size,viewport] of Object.entries({desktop:{width:1440,height:960},mobile:{width:390,height:844}})){
   await page.setViewportSize(viewport);await nav(page,'workbench');
   await page.locator('.shell-brand').focus();
   for(let index=0;index<20;index++){await page.keyboard.press('Tab');if(await page.locator('.shell-nav [data-page="workbench"]').evaluate(el=>el===document.activeElement))break;}
   const focused=await page.locator('.shell-nav [data-page="workbench"]').evaluate(el=>{const style=getComputedStyle(el),rect=el.getBoundingClientRect();return {isActive:el===document.activeElement,focusVisible:el.matches(':focus-visible'),outlineStyle:style.outlineStyle,outlineWidth:parseFloat(style.outlineWidth),onscreen:rect.top>=0&&rect.bottom<=innerHeight};});
   check(`${size}:Tab可到工作台导航且焦点可见`,focused.isActive&&focused.focusVisible&&focused.outlineStyle!=='none'&&focused.outlineWidth>=2&&focused.onscreen,focused);
   check(`${size}:工作台导航具备可访问名称`,await page.getByRole('button',{name:'工作台',exact:true}).isVisible());
   if(size==='desktop')await screenshot(page,'keyboard-focus');
   const history=page.locator('[data-shell-history]:visible').first();await history.focus();await page.keyboard.press('Enter');await page.locator('#history-dialog').waitFor({state:'visible'});
   check(`${size}:历史弹层获得内部焦点`,await page.locator('#history-dialog').evaluate(el=>el.contains(document.activeElement)));
   await page.keyboard.press('Escape');await page.locator('#history-dialog').waitFor({state:'hidden'});
   check(`${size}:Esc关闭历史并返回触发按钮`,await history.evaluate(el=>el===document.activeElement));
   await nav(page,'assets');await page.locator('[data-asset-section="skills"]').first().click();
   const create=page.locator('[data-skill-new]').first();await create.focus();await page.keyboard.press('Enter');await page.locator('#skill-dialog').waitFor({state:'visible'});
   check(`${size}:Skill弹层获得内部焦点`,await page.locator('#skill-dialog').evaluate(el=>el.contains(document.activeElement)));
   await page.keyboard.press('Escape');await page.locator('#skill-dialog').waitFor({state:'hidden'});
   check(`${size}:Esc关闭Skill并返回触发按钮`,await create.evaluate(el=>el===document.activeElement));
  }
 });
 await scenario('running-user-switch-reload-and-cancel',async(page,check)=>{
  await send(page,'2026 年 1 月净收入是多少？');const first=await confirm(page);check('切用户前查询运行中',first.status==='running');
  await page.locator('#shell-profile').selectOption('developer-b');check('在B中不可见A的查询',(await queries(page)).length===0);
  await page.waitForFunction(k=>JSON.parse(localStorage.getItem(k)).conversations.some(c=>c.tasks.some(t=>t.queries.some(q=>q.status==='completed'))),dbKey('analyst-a'));
  check('A后台完成不写入B',(await queries(page)).length===0);
  await page.locator('#shell-profile').selectOption('analyst-a');const done=(await queries(page)).find(q=>q.id===first.id);check('切回原用户看到原查询完成',done?.status==='completed'&&done.rows[0].net_revenue_cents===12400);
  await startNew(page);await send(page,'2026 年 2 月净收入是多少？');const restored=await confirm(page);
  const db=await read(page,dbKey('analyst-a'));const persistedQuery=db.conversations.flatMap(c=>c.tasks.flatMap(t=>t.queries)).find(q=>q.id===restored.id);check('运行任务持久化dueAt',persistedQuery.status==='running'&&Number.isFinite(persistedQuery.dueAt));
  await page.reload();const result=await completed(page,restored.id);check('刷新恢复同一查询并完成',result.rows[0].net_revenue_cents===4000&&(await queries(page)).filter(q=>q.id===restored.id).length===1);
  await startNew(page);await send(page,'2026 年 1 月客户数是多少？');const cancelled=await confirm(page);await page.locator(wb('cancel')).click();
  check('取消状态可见',(await queries(page)).find(q=>q.id===cancelled.id).status==='cancelled');
  await page.reload();await page.waitForTimeout(1600);const cancelledAfter=(await queries(page)).find(q=>q.id===cancelled.id);check('取消在刷新和到期后不变完成',cancelledAfter.status==='cancelled'&&cancelledAfter.rows===null);
 });
 await browser.close();report.completedAt=new Date().toISOString();report.finalInputHashes=hashes();report.inputsChangedDuringRun=JSON.stringify(report.inputHashes)!==JSON.stringify(report.finalInputHashes);report.passed=report.scenarios.every(s=>s.passed)&&report.pageErrors.length===0&&!report.inputsChangedDuringRun;report.checkCount=report.scenarios.reduce((n,s)=>n+s.checks.length,0);
 fs.writeFileSync(path.join(__dirname,'system-browser-checks.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({passed:report.passed,checkCount:report.checkCount,inputsChangedDuringRun:report.inputsChangedDuringRun,failures:report.scenarios.filter(s=>!s.passed).map(s=>({name:s.name,error:s.error})),pageErrors:report.pageErrors}));if(!report.passed)process.exitCode=1;
})().catch(async error=>{report.fatal=cleanError(error);fs.writeFileSync(path.join(__dirname,'system-browser-checks.json'),JSON.stringify(report,null,2)+'\n');await browser?.close();console.error(cleanError(error));process.exitCode=1;});

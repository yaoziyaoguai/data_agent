import {navigateWorkspace} from './experience-navigation.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {harness,until} from './harness.mjs';
const h=await harness({web:true,capture:true,startWorker:false,startupTimeout:60000});
const browser=await chromium.launch();const page=await browser.newPage({viewport:{width:1440,height:1000}});
const directory='.local/checks/asset-experience';await mkdir(directory,{recursive:true});const checks=[],errors=[];let passed=false;page.on('pageerror',e=>errors.push(e.message));
try {
 await page.goto(h.url);await page.getByLabel('演示登录凭据').fill(h.tokens.alice);await page.getByRole('button',{name:'进入工作台 →'}).click();
 const origin=await h.create();await page.evaluate(cid=>localStorage.setItem('data-agent.conversation.alice',cid),origin);await page.reload();
 await page.getByLabel('你的数据问题').fill('尚未发送的分析问题');
 await page.getByRole('button',{name:'＋ 选用分析方法',exact:true}).click();
 assert.match(await page.getByRole('tab',{selected:true}).innerText(),/^我的 Skill/);
 await page.getByRole('tab',{name:/^空间公共 Skill/}).click();assert.match(await page.getByRole('tab',{selected:true}).innerText(),/^空间公共 Skill/);
 await page.getByRole('tab',{name:/^我的 Skill/}).click();
 await page.getByRole('button',{name:'新增个人 Skill',exact:true}).click();let dialog=page.getByRole('dialog');
 for(const width of [1440,390]){await page.setViewportSize({width,height:1000});await page.screenshot({path:directory+'/examples-'+width+'.png',animations:'disabled'});}
 await page.setViewportSize({width:1440,height:1000});
 assert.equal(await dialog.locator('.skill-examples article').count(),3);await dialog.getByRole('button',{name:'使用收入概览示例',exact:true}).click();
 assert.equal(await dialog.getByLabel('名称',{exact:true}).inputValue(),'收入概览');assert.match(await dialog.getByLabel('内容',{exact:true}).inputValue(),/用户在聊天中明确要求执行/);
 await dialog.getByLabel('我已核对这条个人定义').check();await dialog.getByLabel('内容',{exact:true}).fill((await dialog.getByLabel('内容',{exact:true}).inputValue())+'\n每次先说明数据覆盖期间。');assert.equal(await dialog.getByLabel('我已核对这条个人定义').isChecked(),false);
 await dialog.getByText('补充说明与报告模板（可选）',{exact:true}).click();await dialog.getByRole('button',{name:'添加文本附件',exact:true}).click();
 await dialog.getByLabel('附件名称',{exact:true}).fill('report.md');await dialog.getByLabel('文件内容',{exact:true}).fill('结论\n数据\n口径与限制');
 for(const width of [1440,390]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:directory+'/skill-'+width+'.png',fullPage:true});}
 await dialog.getByRole('button',{name:'保存',exact:true}).click();await dialog.waitFor({state:'detached'});
 const card=page.locator('.asset-card').filter({hasText:'收入概览'});await card.waitFor();assert.ok(!(await card.innerText()).includes('references/'));assert.ok(!(await card.innerText()).includes('版本 1'));
 const saved=(await h.request('/assets')).value.assets.find(asset=>asset.name==='收入概览');assert.equal(saved.visibility,'personal');assert.equal(saved.verified,false);assert.equal(saved.files[0].path,'references/report.md');assert.match(saved.body,/每次先说明/);
 await card.getByRole('button',{name:'在当前对话选用',exact:true}).click();await page.locator('.skill-selections').waitFor();
 await page.locator('.skill-selections').getByText('收入概览',{exact:true}).waitFor();
 const cid=await page.evaluate(()=>localStorage.getItem('data-agent.conversation.alice'));const selections=(await h.request('/conversations/'+cid+'/skill-selections')).value;assert.ok(JSON.stringify(selections).includes(saved.id));
 assert.equal(cid,origin);assert.equal(await page.getByLabel('你的数据问题').inputValue(),'尚未发送的分析问题');
 checks.push('三个模板可修改；内容改变撤销旧核对；自然附件名保存为Pi原生路径；私人保存后明确选用并进入当前对话');
 const published=await h.request('/assets/'+saved.id+'/publish',{operation_id:crypto.randomUUID(),expected_version:saved.version,share_confirmed:true});assert.equal(published.status,200);
 await page.getByRole('button',{name:'管理与选用',exact:true}).click();assert.match(await page.getByRole('tab',{selected:true}).innerText(),/^我的 Skill/);
 await page.getByRole('tab',{name:/^空间公共 Skill/}).click();
 await page.locator('.asset-card').filter({hasText:'收入概览'}).getByRole('button',{name:'在当前对话选用',exact:true}).click();
 await page.locator('.skill-selections').getByText(/空间公共.*已选用/).waitFor();
 const shared=(await h.request('/conversations/'+cid+'/skill-selections')).value.selections.find(item=>item.asset_id===published.value.id);assert.equal(shared.availability,'available');assert.equal(shared.visibility,'space');
 assert.equal(await page.evaluate(()=>localStorage.getItem('data-agent.conversation.alice')),origin);assert.equal(await page.getByLabel('你的数据问题').inputValue(),'尚未发送的分析问题');
 await navigateWorkspace(page,'我的积累');assert.match(await page.getByRole('tab',{selected:true}).innerText(),/^个人记忆/);
 checks.push('选用分析方法与管理入口直达我的Skill，可切换并选用公共Skill，返回原对话且保留草稿；我的积累普通入口仍可管理记忆');
 assert.deepEqual(errors,[]);passed=true;
} finally {if(!passed)await page.screenshot({path:directory+'/failure.png',fullPage:true}).catch(()=>{});await writeFile(directory+'/report.json',JSON.stringify({passed,checks,errors,officialRequests:0},null,2));await browser.close();await h.close();console.log(JSON.stringify({passed,checks,errors,officialRequests:0}));}

import {synchronizeSources} from './source-sync.mjs';
import {navigateWorkspace, discardEditor, logoutWorkspace} from './experience-navigation.mjs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {harness, until} from './harness.mjs';
const h = await harness({web:true,capture:true,startWorker:false,startupTimeout:60000});
const browser = await chromium.launch();
const page = await browser.newPage({viewport:{width:1440,height:1000}});
const directory='.local/checks/knowledge-experience'; await mkdir(directory,{recursive:true});
const checks=[], errors=[]; let passed=false;
page.on('pageerror',error=>errors.push(error.message));
const documentPath='/knowledge/document-guide-1/document';
const ok=result=>{assert.equal(result.status,200,JSON.stringify(result.value));return result.value;};
const read=async()=>ok(await h.request(documentPath));
const editBody=(document, update)=>({operation_id:randomUUID(),body:update(document.body),parts:document.parts.map(part=>({id:part.id,expected_version:part.version}))});
const nav=name=>navigateWorkspace(page,name);
const login=async (user, expectedNav='语义管理')=>{await page.goto(h.url);await page.getByLabel('演示登录凭据').fill(h.tokens[user]);await page.getByRole('button',{name:'进入工作台 →'}).click();await nav('^'+expectedNav+'$');await page.goto(h.url+'/#knowledge?object=table-demo_order_detail');await page.getByRole('heading',{name:'demo_order_detail',exact:true}).waitFor();};
try {
  // 普通用户没有“我负责的对象”，空目录视图改用全部对象加无结果筛选；两处首批读取由本项放行，保证切换先于返回。
  let releaseInitial, heldInitial=0, activeInitial=0;
  const initialHeld=new Promise(resolve=>releaseInitial=resolve);
  const initialDirectoryPattern=url=>url.pathname==='/api/knowledge'&&url.search==='?directory=all&directory_view=grouped';
  await page.route(initialDirectoryPattern,async route=>{
    heldInitial++;activeInitial++;
    try{const response=await route.fetch();await initialHeld;await route.fulfill({response});}
    finally{activeInitial--;}
  });
  try{
    await login('bob', '数据字典');
    await page.getByLabel('语义目录范围',{exact:true}).selectOption('all');
    await until(()=>heldInitial>=2,'directory of all objects in flight');
    await page.getByLabel('管理目录名称').fill('不存在的名字');
    await page.getByText('没有符合当前条件的内容。',{exact:true}).waitFor();
    releaseInitial();
    await until(()=>activeInitial===0,'held directory results delivered');
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.object-heading').count(),0,'late initial list must not restore a table after switching to an empty directory view');
    assert.equal(await page.locator('.directory-group').count(),0,'late unfiltered directory must not refill the filtered empty view');
    checks.push('首批慢目录返回时保留用户已切换的空目录视图');
  }finally{releaseInitial();await page.unroute(initialDirectoryPattern);}
  await logoutWorkspace(page);
  await login('alice');
  const tableEntry=page.locator('.semantic-entry').first();
  await tableEntry.getByRole('button',{name:'编辑',exact:true}).click();
  await tableEntry.locator('textarea').fill('慢刷新期间保留的合成草稿。');
  let refreshReads=0,activeRefreshes=0,maxActiveRefreshes=0,releaseSavedRefresh;
  const savedRefreshHeld=new Promise(resolve=>releaseSavedRefresh=resolve);
  let firstFinished=false,secondStarted=false,leavingRefreshStarted=false;
  const refreshPattern=url=>url.pathname==='/api/knowledge'&&url.search==='?directory=all&directory_view=grouped';
  await page.route(refreshPattern,async route=>{
    const index=++refreshReads;activeRefreshes++;maxActiveRefreshes=Math.max(maxActiveRefreshes,activeRefreshes);
    try{
      const response=await route.fetch();
      if(index===1)await new Promise(resolve=>setTimeout(resolve,2600));
      if(index===2){secondStarted=true;await savedRefreshHeld;}
      if(index===4){leavingRefreshStarted=true;await new Promise(resolve=>setTimeout(resolve,2600));}
      await route.fulfill({response});
    }finally{activeRefreshes--;if(index===1)firstFinished=true;}
  });
  let proposalFailed=false;
  await page.route('**/api/knowledge-proposals',route=>{
    if(proposalFailed)return route.continue();proposalFailed=true;
    return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({code:'unavailable',message:'合成建议读取故障',request_id:'slow-refresh-failure',retryable:true})});
  });
  // 语义页不定时刷新目录，只随空间目录变更信号刷新；信号经Worker与合成平台共用的通知接口发出。
  const catalogChanged=async()=>{
    const response=await fetch(h.env.DATA_AGENT_API_URL+'/internal/live-changes',{method:'POST',headers:{authorization:'Bearer '+h.env.DATA_AGENT_INTERNAL_TOKEN,'content-type':'application/json'},body:JSON.stringify([{kind:'catalog',space_id:'demo'}])});
    assert.equal(response.status,204,'catalog change signal accepted');
  };
  try{
    await catalogChanged();
    await until(()=>firstFinished,'slow refresh completed',15000);
    assert.equal(maxActiveRefreshes,1,'a failed child must not release a refresh batch while its slow sibling is pending');
    assert.equal(await tableEntry.locator('textarea').inputValue(),'慢刷新期间保留的合成草稿。','refresh on a change signal preserves an open draft');
    await page.getByRole('alert').filter({hasText:'unavailable'}).waitFor();
    await page.unroute('**/api/knowledge-proposals');
    await catalogChanged();
    await until(()=>secondStarted,'next change signal starts a refresh only after completion');
    await tableEntry.getByRole('button',{name:'保存修改',exact:true}).click();
    await tableEntry.locator('.entry-value').filter({hasText:/^慢刷新期间保留的合成草稿。$/}).waitFor();
    releaseSavedRefresh();
    await until(()=>refreshReads>=3&&activeRefreshes===0,'saved refresh is eventually drained');
    assert.equal(maxActiveRefreshes,1,'saving during a refresh must coalesce without overlapping batches');
    assert.equal(await tableEntry.locator('.entry-value').innerText(),'慢刷新期间保留的合成草稿。','late list data cannot overwrite the saved object version');
    await catalogChanged();
    await until(()=>leavingRefreshStarted,'refresh on an ordinary change signal remains enabled');
    await nav('工作台');
    const readsAfterLeaving=refreshReads;
    await catalogChanged();await page.waitForTimeout(2900);
    assert.equal(refreshReads,readsAfterLeaving,'leaving the page stops further refresh batches');
    checks.push('超过2秒的目录读取与子请求失败不叠加刷新；草稿保留，在途保存最终补刷新且旧版本不覆盖，离开停止调度');
  }finally{releaseSavedRefresh();await page.unroute(refreshPattern);await page.unroute('**/api/knowledge-proposals');}
  if(!process.argv.includes('--refresh-only')){
  await logoutWorkspace(page);
  let original=await read(); assert.equal(original.parts.length,8); assert.equal(original.title,'虚构零售业务说明');
  for (const part of original.parts.slice(0,2)) ok(await h.request('/knowledge/'+part.id,{operation_id:randomUUID(),expected_version:part.version,entry_id:'body',value:'合成长文。'.repeat(12000)},'alice','PATCH'));
  const longDocument=await read();assert.ok(longDocument.body.length>100000,'legal chapters can exceed the single edit limit in aggregate');
  assert.equal((longDocument.body.match(/合成长文。/g)||[]).length,24000,'whole-document read does not truncate existing chapters');
  assert.equal((await h.request(documentPath,editBody(longDocument,v=>v),'alice','PATCH')).value.code,'invalid_input');assert.deepEqual((await read()).parts,longDocument.parts);
  for (const part of original.parts.slice(0,2)) ok(await h.request('/knowledge/'+part.id,{operation_id:randomUUID(),expected_version:longDocument.parts.find(p=>p.id===part.id).version,entry_id:'body',value:part.entries.find(e=>e.entry_id==='body').effective_value},'alice','PATCH'));
  original=await read();checks.push('合法长章节合并后可完整读取；超出单次保存上限拒绝且不写入部分内容');
  const denied=await h.request(documentPath,editBody(original,v=>v+'\n未授权修改'),'bob','PATCH');assert.equal(denied.status,403);
  const incomplete=editBody(original,v=>v);incomplete.parts.pop();assert.equal((await h.request(documentPath,incomplete,'alice','PATCH')).value.code,'version_conflict');
  const duplicate=editBody(original,v=>v);duplicate.parts[7]=duplicate.parts[0];assert.equal((await h.request(documentPath,duplicate,'alice','PATCH')).value.code,'version_conflict');
  const stale=editBody(original,v=>v+'\n合成修改');stale.parts[7].expected_version='0';assert.equal((await h.request(documentPath,stale,'alice','PATCH')).value.code,'version_conflict');assert.deepEqual((await read()).parts,original.parts,'late conflict must roll back all earlier writes');
  const command=editBody(original,v=>v+'\n整篇保存验证。');
  const first=ok(await h.request(documentPath,command,'alice','PATCH'));
  assert.deepEqual(ok(await h.request(documentPath,command,'alice','PATCH')),first,'identical retry returns original receipt');
  assert.equal(BigInt(first.parts[0].version),BigInt(original.parts[0].version)+1n);
  assert.ok(first.parts.every((part,index)=>BigInt(part.version)===BigInt(original.parts[index].version)+1n),'initial whole-document format must version all parts including order');
  assert.equal(first.body,command.body,'full document round trip');
  assert.deepEqual(ok(await h.request(documentPath,editBody(first,v=>v),'alice','PATCH')).parts,first.parts,'subsequent no-op keeps versions');
  const changedRetry={...command,body:'different'};assert.equal((await h.request(documentPath,changedRetry,'alice','PATCH')).value.code,'idempotency_conflict');
  checks.push('整篇接口完整读取8节；逐一授权、缺失/重复条目拒绝、末节冲突全事务回滚、相同重试不重复版本，全文格式首次保存整体改版，后续无修改不新增版本');

  const complexText='# 可修改的完整标题\n\n新的序言。\n\n## 调整后的章节\n\n| 日期 | 金额 |\n| --- | --- |\n| 周一 | 10 |\n\n```sql\nSELECT 1;\n\nSELECT 2;\n```\n\n## 新增章节\n\n正文末尾保留两个换行。\n\n';
  let changed=ok(await h.request(documentPath,editBody(first,()=>complexText),'alice','PATCH'));assert.equal(changed.body,complexText);
  assert.ok(changed.parts.every(part=>part.entries[0].human_override!==null));
  for(const part of changed.parts) ok(await h.request('/knowledge/'+part.id+'/reanalyze',{operation_id:randomUUID(),expected_version:part.version}));
  assert.equal((await read()).body,complexText,'reanalysis keeps full edited text and empty fragments');
  changed=await read();ok(await h.request(documentPath,editBody(changed,()=>original.body),'alice','PATCH'));
  checks.push('序言、标题、增删章节、表格、代码块和尾部空行可全文保存并逐字还原；来源重分析不复活已删章节');

  await login('bob', '数据字典');
  let releaseSearch, intercepted=false; const heldSearch=new Promise(resolve=>releaseSearch=resolve);
  await page.route('**/api/knowledge?q=*',async route=>{const response=await route.fetch();intercepted=true;await heldSearch;await route.fulfill({response});});
  await page.getByLabel('搜索语义对象').fill('demo');await until(()=>intercepted,'old search in flight');
  await page.getByLabel('语义目录范围',{exact:true}).selectOption('all');
  await page.getByLabel('管理目录名称').fill('不存在的名字');await page.getByText('没有符合当前条件的内容。',{exact:true}).waitFor();
  assert.equal(await page.locator('.object-heading').count(),0,'empty directory view must not retain someone else’s table');
  const searchResponse=page.waitForResponse(response=>response.url().includes('/knowledge?q='));releaseSearch();await searchResponse;await page.waitForTimeout(200);assert.equal(await page.locator('.object-heading').count(),0,'late search must not restore a table from another directory');await page.unroute('**/api/knowledge?q=*');
  checks.push('Bob空目录视图不保留Alice表详情，迟到的搜索结果也不恢复');
  const catalog=await fetch(h.env.DATA_AGENT_PLATFORM_URL+'/catalog',{method:'POST',headers:{authorization:'Bearer '+h.env.DATA_AGENT_INTERNAL_TOKEN,'content-type':'application/json'},body:JSON.stringify({limit:50})}).then(r=>r.json());
  await writeFile(h.directory+'/platform/catalog.json',JSON.stringify({source_namespace:catalog.source_namespace,tables:catalog.tables.map(table=>({...table,maintainer_id:'bob'}))}));
  assert.equal((await synchronizeSources(h)).value.status, 'completed');
  // 维护身份随目录变更事件重新读取后，“我负责的对象”才对Bob出现。
  await page.getByRole('option',{name:'我负责的对象'}).waitFor({state:'attached'});
  await page.getByLabel('语义目录范围',{exact:true}).selectOption('maintained');
  await page.getByLabel('管理目录名称').fill('demo_order_detail');await page.getByRole('button',{name:'刷新目录',exact:true}).click();
  const list=page.getByRole('navigation',{name:'语义对象'});await list.getByRole('button').filter({has:page.getByText('demo_order_detail',{exact:true})}).first().click();
  const entry=page.locator('.semantic-entry').first();await entry.getByRole('button',{name:'编辑',exact:true}).click();await entry.locator('textarea').fill('Bob负责的合成表说明。');await entry.getByRole('button',{name:'保存修改',exact:true}).click();await entry.locator('.entry-value').filter({hasText:/^Bob负责的合成表说明。$/}).waitFor();
  checks.push('mock Datasight维护人改为Bob后，Bob成为维护者，可从负责目录编辑并持久保存表语义');
  for(const width of [1440,390]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:directory+'/semantics-'+width+'.png',animations:'disabled'});}
  await page.setViewportSize({width:1440,height:1000});

  await logoutWorkspace(page);await login('alice');
  await page.getByRole('tab',{name:'业务文档',exact:true}).click();
  const reader=page.locator('.document-reader');await reader.getByRole('heading',{name:'虚构零售业务说明',exact:true}).waitFor();assert.equal(await reader.count(),1);
  assert.equal(await reader.getByRole('heading',{level:2}).count(),9,'one document title and eight natural headings');
  assert.ok(!(await reader.innerText()).includes('document-guide-'));
  await reader.getByRole('button',{name:'编辑文档',exact:true}).click();let dialog=page.getByRole('dialog');
  const firstInput=dialog.getByLabel('文档正文',{exact:true});const value=await firstInput.inputValue();await firstInput.fill(value+'\n用户整篇编辑的补充。');
  await dialog.getByRole('button',{name:'保存文档',exact:true}).click();await dialog.waitFor({state:'detached'});await reader.getByText(/用户整篇编辑的补充/).waitFor();
  assert.match((await read()).body,/用户整篇编辑的补充/);
  await reader.getByRole('button',{name:'编辑文档',exact:true}).click();dialog=page.getByRole('dialog');await dialog.getByLabel('文档正文',{exact:true}).fill('未保存的草稿，必须保留。');
  await page.route('**/knowledge/document-guide-1/document', route => route.request().method() === 'GET' ? route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({code:'unavailable',message:'合成读取故障',request_id:'document-read-failure',retryable:true})}) : route.continue());
  // 文档只在进入页面和回到窗口时重读，不按固定间隔轮询：这次失败的刷新由窗口唤醒触发。
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await reader.getByRole('alert').waitFor();assert.equal(await dialog.getByLabel('文档正文',{exact:true}).inputValue(),'未保存的草稿，必须保留。');await page.unroute('**/knowledge/document-guide-1/document');
  original=await read();ok(await h.request(documentPath,editBody(original,v=>v+'\n并发修改。'),'alice','PATCH'));
  await reader.getByText(/并发修改。/).waitFor();assert.equal(await dialog.getByLabel('文档正文',{exact:true}).inputValue(),'未保存的草稿，必须保留。');
  await dialog.getByRole('button',{name:'保存文档',exact:true}).click();await dialog.getByRole('alert').waitFor();assert.equal(await dialog.getByLabel('文档正文',{exact:true}).inputValue(),'未保存的草稿，必须保留。');assert.notEqual((await read()).body,'未保存的草稿，必须保留。');await discardEditor(page);
  checks.push('用户看到一篇完整文档；统一入口/保存，刷新可重读；并发冲突保留草稿且不写入部分正文');
  for(const width of [1440,390]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:directory+'/document-'+width+'.png',fullPage:true,animations:'disabled'});await page.screenshot({path:directory+'/document-viewport-'+width+'.png',animations:'disabled'});}
  await page.getByRole('button',{name:'录入业务文档',exact:true}).click();dialog=page.getByRole('dialog');await dialog.getByLabel('文档名称',{exact:true}).fill('合成完整文档');await dialog.getByLabel('正文（支持 Markdown 章节）',{exact:true}).fill('# 完整正文\n\n可以自然地阅读与修改。');await dialog.getByRole('button',{name:'保存文档',exact:true}).click();await dialog.waitFor({state:'detached'});await page.getByRole('heading',{name:'合成完整文档',exact:true}).waitFor();
  await page.getByRole('button',{name:'编辑文档',exact:true}).click();dialog=page.getByRole('dialog');await dialog.getByLabel('文档正文',{exact:true}).fill('# 新标题\n\n整篇正文已修改。');await dialog.getByRole('button',{name:'保存文档',exact:true}).click();await dialog.waitFor({state:'detached'});await page.getByText('整篇正文已修改。',{exact:true}).waitFor();
  checks.push('手工录入的完整Markdown文档可直接整篇编辑，无需填写对象ID');
  await page.getByRole('button',{name:'编辑文档',exact:true}).click();dialog=page.getByRole('dialog');await dialog.getByLabel('文档正文',{exact:true}).fill('');await dialog.getByText('关联资料与来源链接',{exact:true}).click();
  await dialog.getByLabel('来源链接（可选）',{exact:true}).fill('https://example.invalid/retail-guide');while(await dialog.getByRole('button',{name:'移除关联资料'}).count()) await dialog.getByRole('button',{name:'移除关联资料'}).first().click();
  const linkSave=page.waitForResponse(response=>response.url().endsWith('/document')&&response.request().method()==='PATCH');
  await dialog.getByRole('button',{name:'保存文档',exact:true}).click();const linked=await (await linkSave).json();assert.equal(linked.parts[0].entries.find(entry=>entry.entry_id==='body').human_override.source_url,'https://example.invalid/retail-guide');assert.deepEqual(linked.parts[0].related_ids,[]);await dialog.waitFor({state:'detached'});await reader.getByText('尚未录入正文',{exact:true}).waitFor();
  await logoutWorkspace(page);await login('bob');await page.goto(h.url+'/#knowledge?object='+linked.parts[0].id);await reader.getByRole('heading',{name:'合成完整文档',exact:true}).waitFor();
  const linkedRead=(await h.request('/knowledge/'+linked.parts[0].id+'/document',undefined,'bob')).value;assert.equal(linkedRead.parts[0].entries.find(entry=>entry.entry_id==='body').human_override.source_url,'https://example.invalid/retail-guide');
  const sourceLink=reader.getByRole('link',{name:'打开来源链接 ↗',exact:true});assert.equal(await sourceLink.getAttribute('href'),'https://example.invalid/retail-guide');assert.equal(await sourceLink.getAttribute('rel'),'noopener noreferrer');assert.equal(await reader.getByRole('button',{name:'编辑文档',exact:true}).count(),0);
  checks.push('来源链接可整篇编辑并由普通读者打开；仅链接文档保留正文缺口，文档编辑权限仍属于创建者');
  }
  assert.deepEqual(errors,[]);passed=true;
} finally {if(!passed)await page.screenshot({path:directory+'/failure.png',fullPage:true}).catch(()=>{});await writeFile(directory+'/report.json',JSON.stringify({passed,checks,errors,officialRequests:0},null,2));await browser.close();await h.close();console.log(JSON.stringify({passed,checks,errors,officialRequests:0}));}

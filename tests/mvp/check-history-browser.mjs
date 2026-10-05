import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {harness,until} from './harness.mjs';
const h=await harness({web:true});const browser=await chromium.launch();const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(/same key|unique.*key/.test(m.text()))errors.push(m.text());});let passed=false;const checks=[];
const q=s=>"'"+s.replaceAll("'","''")+"'";
const append=(cid,from,to)=>{
 const rows=[];for(let n=from;n<=to;n++){
  const type=n===199||n===200?'assistant_delta':n===201?'assistant_committed':'message';
  const payload=type==='message'?{message_id:'history-'+n,text:'历史消息 '+n}:{output_id:'history-output',attempt_id:'history-attempt',text:n===201?'跨页完整回答':'跨页局部片段'};
  rows.push(`(${q(randomUUID())},${q(cid)},${n},${q(type)},${q(JSON.stringify(payload))})`);
 }
 h.sql('INSERT INTO conversation_events(event_id,conversation_id,event_seq,event_type,payload) VALUES'+rows.join(',')+`;UPDATE conversations SET event_seq=${to} WHERE id=${q(cid)};`);
};
try{
 await h.pauseWorker();const cid=await h.create();append(cid,1,1200);
 const old=await h.create();await h.send(old,'早期退款分析标题');h.sql(`UPDATE conversations SET created_at='2026-01-01 00:00:00' WHERE id=${q(old)}`);
 const rows=Array.from({length:110},(_,i)=>`(${q(randomUUID())},'alice','demo',${q(randomUUID())},${q('较新分析 '+i)})`);h.sql('INSERT INTO conversations(id,owner_id,space_id,creation_key,title) VALUES'+rows.join(','));
 await page.goto(h.url);await page.getByLabel('演示登录凭据').fill(h.tokens.alice);await page.getByRole('button',{name:'进入工作台 →',exact:true}).click();
 await page.evaluate(id=>localStorage.setItem('data-agent.conversation.alice',id),cid);await page.reload();await page.getByText('历史消息 1200',{exact:true}).waitFor();
 await page.getByRole('button',{name:'加载更早的消息',exact:true}).click();await page.getByText('历史消息 1',{exact:true}).waitFor();assert.equal(await page.getByText('跨页完整回答',{exact:true}).count(),1);assert.equal(await page.getByText('跨页局部片段',{exact:true}).count(),0);
 append(cid,1201,1250);await page.getByText('历史消息 1250',{exact:true}).waitFor();
 for(const n of [1,198,202,250,1200,1201,1250])assert.equal(await page.getByText('历史消息 '+n,{exact:true}).count(),1);
 assert.equal(await page.locator('.message.user').count(),1247);assert.equal(await page.getByRole('button',{name:'加载更早的消息',exact:true}).count(),0);
 checks.push({name:'正式工作台1200事件加载旧页后再增50事件，连续保留历史，无重复key；跨页回答只显示最终文本',passed:true});
 await page.getByRole('button',{name:'查看全部会话 ↗',exact:true}).click();await page.getByRole('button',{name:'加载更多会话',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:/^早期退款分析标题/}).waitFor();
 await page.getByLabel('搜索会话').fill('早期退款');await until(async()=>await page.getByRole('dialog').locator('.history-dialog button').count()===1,'history search');await page.getByRole('dialog').locator('.history-dialog button').first().click();await page.getByText('早期退款分析标题',{exact:true}).first().waitFor();
 checks.push({name:'正式全部会话弹窗翻页找到100条以外的会话，服务端标题搜索后可打开',passed:true});
 const doc=(await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'文档维护浏览器样例',body:'说明'.repeat(30000),source_url:'https://example.org/old',related_ids:['table-demo_order_detail']})).value;
 const tableRows=Array.from({length:230},(_,i)=>{
  const id=doc.id.slice(0,9)+'-page-table-'+String(i+1).padStart(3,'0');
  const value={id,kind:'table',name:'分页表'+(i+1),version:'1',state:'enabled',entries:[],related_ids:[],source_id:null,source_version:'0',updated_by:'test'};
  return `(${q(id)},'demo','table',${q(value.name)},1,'enabled',${q(JSON.stringify(value))},NULL,0,'test')`;
 });
 h.sql('INSERT INTO knowledge_objects(id,space_id,kind,name,version,state,body,source_id,source_version,updated_by) VALUES'+tableRows.join(','));
 await page.getByRole('button',{name:/语义管理/}).click();
 const directory=page.getByRole('navigation',{name:'语义对象'});
 await directory.getByRole('button',{name:'加载更多语义对象',exact:true}).click();await directory.getByRole('button',{name:/^分页表150/}).waitFor();
 await page.waitForResponse(r=>new URL(r.url()).pathname==='/api/knowledge'&&!new URL(r.url()).search&&r.status()===200);
 await directory.getByRole('button',{name:'加载更多语义对象',exact:true}).click();await directory.getByRole('button',{name:/^分页表230/}).waitFor();
 checks.push({name:'语义目录超过200对象，加载第二页后经过轮询仍可继续第三页；后台刷新不重置游标',passed:true});
 await page.getByLabel('搜索语义对象').fill(doc.name);await directory.getByRole('button',{name:new RegExp(doc.name)}).click();
 const entry=page.locator('.semantic-entry').first();await entry.getByRole('button',{name:'编辑',exact:true}).click();assert.equal((await entry.locator('textarea').inputValue()).length,60000);
 await page.getByLabel('编辑来源链接').fill('https://example.org/revised');await page.getByLabel('编辑关联对象').fill('table-raw_payments, table-demo_order_detail');await entry.locator('textarea').fill('说明'.repeat(30000)+'修订');await entry.getByRole('button',{name:'保存修改',exact:true}).click();await until(async()=>await entry.getByRole('link',{name:'打开来源链接 ↗'}).getAttribute('href')==='https://example.org/revised','saved document metadata');assert.equal(await entry.getByRole('link',{name:'打开来源链接 ↗'}).getAttribute('href'),'https://example.org/revised');
 const saved=(await h.request('/knowledge/'+doc.id)).value;assert.equal(saved.entries[0].effective_value.length,60002);assert.equal(saved.version,'2');assert.deepEqual(saved.related_ids,['table-raw_payments','table-demo_order_detail']);
 const external=await h.request('/knowledge/'+doc.id,{operation_id:randomUUID(),expected_version:saved.version,entry_id:'body',value:'其他维护者的新版本',clear_override:false},'alice','PATCH');assert.equal(external.status,200);
 await entry.getByText('其他维护者的新版本',{exact:true}).waitFor();
 checks.push({name:'首页以外的当前文档由周期直读刷新，其他维护者新版本可见',passed:true});
 checks.push({name:'正式语义页编辑60000字文档、来源链接和多表关联，人工标记与版本保存',passed:true});
 assert.deepEqual(errors,[]);passed=true;console.log(JSON.stringify({passed,checks,officialRequests:0}));
}finally{await browser.close();await writeFile('.local/checks/mvp-history-browser.json',JSON.stringify({passed,checks,errors},null,2));await h.close();}

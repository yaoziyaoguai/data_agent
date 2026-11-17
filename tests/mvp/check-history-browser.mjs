import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness,until} from './harness.mjs';
const h=await harness({web:true,capture:true});const browser=await chromium.launch();const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(/same key|unique.*key/.test(m.text()))errors.push(m.text());});let passed=false;const checks=[];
const q=s=>"'"+s.replaceAll("'","''")+"'";
let historyOutput,historyAttempt;
const append=(cid,from,to)=>{
 const rows=[];for(let n=from;n<=to;n++){
  const type=n===199||n===200?'assistant_delta':n===201?'assistant_committed':'message';
  const payload=type==='message'?{message_id:'history-'+n,text:'历史消息 '+n}:{output_id:historyOutput,attempt_id:historyAttempt,text:n===201?'跨页完整回答':'跨页局部片段'};
  rows.push(`(${q(randomUUID())},${q(cid)},${n},${q(type)},${q(JSON.stringify(payload))})`);
 }
 h.sql('INSERT INTO conversation_events(event_id,conversation_id,event_seq,event_type,payload) VALUES'+rows.join(',')+`;UPDATE conversations SET event_seq=${to} WHERE id=${q(cid)};`);
};
try{
 const cid=await h.create(),seed=await h.capture(cid,'合成分页历史');await h.pauseWorker();
 const checkpoint=exportCheckpoint(SessionManager.inMemory('/synthetic/data-agent'),seed.workspace_context.authority_revision,seed.workspace_context.authority_snapshot);
 const input={run_id:seed.run_id,lease_epoch:seed.lease_epoch,sdk_tool_call_id:randomUUID(),tool_name:'update_analysis_task',arguments:{action:'create',goal:'合成分页历史',conditions:{time_start:null,time_end:null,timezone:'UTC',metric:null,channel:null,group_by:[],filters:[],knowledge_refs:[],notes:'',source_limits:null},options:[]},checkpoint};
 for(const path of ['/internal/data/tool-calls','/internal/data/tools']){const result=await h.internal(path,input);assert.equal(result.status,200,JSON.stringify(result.value));}
 const output={run_id:seed.run_id,lease_epoch:seed.lease_epoch,chunk_seq:'1',text:'跨页完整回答'};
 assert.equal((await h.internal('/internal/outputs',output)).status,200);
 const committed=await h.internal('/internal/finish',{run_id:seed.run_id,lease_epoch:seed.lease_epoch,commit_id:seed.output_id,final_text:output.text,checkpoint});
 assert.equal(committed.status,200,JSON.stringify(committed.value));h.releaseRun(seed.run_id);
 historyOutput=seed.output_id;historyAttempt=seed.attempt_id;
 // 分页夹具仍固定1200事件；输出使用正式提交来源，不能伪造不存在的attempt绕过投影。
 assert.ok(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM conversation_events WHERE conversation_id=${q(cid)}`)[0].n>0);
 h.sql(`DELETE FROM conversation_events WHERE conversation_id=${q(cid)};UPDATE conversations SET event_seq=0 WHERE id=${q(cid)}`);
 append(cid,1,1200);
 const old=await h.create();await h.send(old,'早期退款分析标题');h.sql(`UPDATE conversations SET created_at='2026-01-01 00:00:00' WHERE id=${q(old)}`);
 const rows=Array.from({length:110},(_,i)=>`(${q(randomUUID())},'alice','demo',${q(randomUUID())},${q('较新分析 '+i)})`);h.sql('INSERT INTO conversations(id,owner_id,space_id,creation_key,title) VALUES'+rows.join(','));
 await page.goto(h.url);await page.getByLabel('演示登录凭据').fill(h.tokens.alice);await page.getByRole('button',{name:'进入工作台 →',exact:true}).click();
 await page.evaluate(id=>localStorage.setItem('data-agent.conversation.["demo","alice"]',id),cid);await page.reload();await page.getByText('历史消息 1200',{exact:true}).waitFor();
 await page.getByRole('button',{name:'加载更早的消息',exact:true}).click();await page.getByText('历史消息 1',{exact:true}).waitFor();assert.equal(await page.getByText('跨页完整回答',{exact:true}).count(),1);assert.equal(await page.getByText('跨页局部片段',{exact:true}).count(),0);
 append(cid,1201,1250);await page.getByText('历史消息 1250',{exact:true}).waitFor();
 for(const n of [1,198,202,250,1200,1201,1250])assert.equal(await page.getByText('历史消息 '+n,{exact:true}).count(),1);
 assert.equal(await page.locator('.message.user').count(),1247);assert.equal(await page.getByRole('button',{name:'加载更早的消息',exact:true}).count(),0);
 checks.push({name:'正式工作台1200事件加载旧页后再增50事件，连续保留历史，无重复key；跨页回答只显示最终文本',passed:true});
 await page.getByRole('button',{name:'查看全部会话 ↗',exact:true}).click();await page.getByRole('button',{name:'加载更多会话',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:/^早期退款分析标题/}).waitFor();
 await page.getByLabel('搜索会话').fill('早期退款');await until(async()=>await page.getByRole('dialog').locator('.history-row').count()===1,'history search');await page.getByRole('dialog').locator('.history-row > button').first().click();await page.getByText('早期退款分析标题',{exact:true}).first().waitFor();
 checks.push({name:'正式全部会话弹窗翻页找到100条以外的会话，服务端标题搜索后可打开',passed:true});
 const doc=(await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',name:'文档维护浏览器样例',body:'说明'.repeat(30000),source_url:'https://example.org/old',related_ids:['table-demo_order_detail']})).value;
 const tableRows=Array.from({length:230},(_,i)=>{
  const id=doc.id.slice(0,9)+'-page-table-'+String(i+1).padStart(3,'0');
  const value={id,kind:'table',name:'分页表'+(i+1),version:'1',state:'enabled',entries:[],related_ids:[],source_id:null,source_version:'0',updated_by:'test'};
  return `(${q(id)},'demo','table',${q(value.name)},1,'enabled',${q(JSON.stringify(value))},NULL,0,'test')`;
 });
 h.sql('INSERT INTO knowledge_objects(id,space_id,kind,name,version,state,body,source_id,source_version,updated_by) VALUES'+tableRows.join(','));
 // 批量合成表与正式导入一样登记Datasight归属，保持目录读取的正式权限前提。
 h.sql(`INSERT INTO semantic_ownership(space_id,object_id,authority_id,source,updated_by) SELECT space_id,id,id,'datasight','test' FROM knowledge_objects WHERE id LIKE ${q(doc.id.slice(0,9)+'-page-table-%')}`);
 const seededDirectory=await h.request('/knowledge');assert.equal(seededDirectory.status,200,JSON.stringify(seededDirectory.value));
 await page.getByRole('button',{name:/语义管理/}).click();
 const directory=page.getByRole('navigation',{name:'语义对象'});
 await directory.getByRole('button',{name:'加载更多语义对象',exact:true}).click();await directory.getByRole('button',{name:/^分页表150/}).waitFor();
 // 后台刷新现为目录参数化的首页拉取（不带after_id游标）；等它发生后再翻第三页，验证游标不被重置。
 await page.waitForResponse(r=>{const u=new URL(r.url());return u.pathname==='/api/knowledge'&&u.searchParams.get('directory')==='all'&&!u.searchParams.has('after_id')&&!u.searchParams.has('q')&&r.status()===200;});
 await directory.getByRole('button',{name:'加载更多语义对象',exact:true}).click();await directory.getByRole('button',{name:/^分页表230/}).waitFor();
 checks.push({name:'语义目录超过200对象，加载第二页后经过轮询仍可继续第三页；后台刷新不重置游标',passed:true});
 await page.getByLabel('搜索语义对象').fill(doc.name);await directory.getByRole('button',{name:new RegExp(doc.name)}).click();
 const entry=page.getByRole('article',{name:doc.name,exact:true});await entry.getByRole('button',{name:'编辑文档',exact:true}).click();
 const editor=page.getByRole('dialog');assert.equal((await editor.getByLabel('文档正文',{exact:true}).inputValue()).length,60000);
 await editor.getByText('关联资料与来源链接',{exact:true}).click();
 await editor.getByLabel('来源链接（可选）').fill('https://example.org/revised');
 await editor.getByRole('button',{name:'移除关联资料',exact:true}).click();
 for(const name of ['raw_payments','demo_order_detail']){
  await editor.getByLabel('查找表、字段或业务资料').fill(name);
  await editor.locator('.knowledge-picker-results').getByRole('button',{name:new RegExp('^'+name)}).click();
 }
 await editor.getByLabel('文档正文',{exact:true}).fill('说明'.repeat(30000)+'修订');
 await editor.getByRole('button',{name:'保存文档',exact:true}).click();await editor.waitFor({state:'detached'});
 await until(async()=>await entry.getByRole('link',{name:'打开来源链接 ↗'}).getAttribute('href')==='https://example.org/revised','saved document metadata');
 assert.equal(await entry.getByRole('link',{name:'打开来源链接 ↗'}).getAttribute('href'),'https://example.org/revised');
 const saved=(await h.request('/knowledge/'+doc.id)).value;assert.equal(saved.entries[0].effective_value.length,60002);assert.equal(saved.version,'2');assert.deepEqual(saved.related_ids,['table-raw_payments','table-demo_order_detail']);
 const external=await h.request('/knowledge/'+doc.id,{operation_id:randomUUID(),expected_version:saved.version,entry_id:'body',value:'其他维护者的新版本',clear_override:false},'alice','PATCH');assert.equal(external.status,200);
 await entry.getByText('其他维护者的新版本',{exact:true}).waitFor();
 checks.push({name:'首页以外的当前文档由周期直读刷新，其他维护者新版本可见',passed:true});
 checks.push({name:'正式语义页编辑60000字文档、来源链接和多表关联，人工标记与版本保存',passed:true});
 assert.deepEqual(errors,[]);passed=true;console.log(JSON.stringify({passed,checks,officialRequests:0}));
}finally{await browser.close();await writeFile('.local/checks/mvp-history-browser.json',JSON.stringify({passed,checks,errors},null,2));await h.close();}

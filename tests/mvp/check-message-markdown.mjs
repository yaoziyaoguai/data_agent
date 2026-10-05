import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {harness,until} from './harness.mjs';

const h=await harness({web:true});
const browser=await chromium.launch();
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const errors=[],externalRequests=[],checks=[];let passed=false;
page.on('pageerror',e=>errors.push(e.message));
page.on('request',r=>{if(!new URL(r.url()).hostname.match(/^(127\.0\.0\.1|localhost)$/))externalRequests.push(r.url());});
const q=value=>"'"+value.replaceAll('\\','\\\\').replaceAll("'","''")+"'";
const user='**用户原话保持纯文本**\n```sql\nSELECT 1;\n```';
const text=[
 '## 检查结论','', '**月支付客户数**按整月去重。','',
 '- 排除测试交易','- 同一客户跨天出现只计一次','',
 '1. 先核对正式口径','2. 确认 SQL 后再执行','',
 '> 个人提醒需要结合正式文档核对。','',
 '```sql','SELECT COUNT(DISTINCT customer_id) AS paying_customers','FROM demo_order_detail WHERE paid_amount_cents > 0 AND is_test = 0;','```','',
 '| 指标 | 日期范围 | 检查 |','| --- | --- | --- |','| 月支付客户数 | 2026年1月 | 整月去重 |','',
 '[查看说明](https://example.com/reference)','',
 '[危险链接](javascript:alert(1))','![外部图片](https://example.com/tracking.png)',
 '<img src=x onerror="window.markdownUnsafe=true">','<script>window.markdownUnsafe=true</script>',
].join('\n');
try{
 const cid=await h.create();
 h.sql(`UPDATE conversations SET title='Markdown回答展示' WHERE id=${q(cid)};`);
 const append=(seq,type,payload)=>h.sql(`INSERT INTO conversation_events(event_id,conversation_id,event_seq,event_type,payload) VALUES(${q(randomUUID())},${q(cid)},${seq},${q(type)},${q(JSON.stringify(payload))});UPDATE conversations SET event_seq=${seq} WHERE id=${q(cid)};`);
 append(1,'message',{message_id:'markdown-question',text:user});
 append(2,'assistant_delta',{output_id:'markdown-answer',attempt_id:'markdown-attempt',text:'**正在核对**\n\n```sql\nSELECT COUNT('});
 await page.goto(h.url);await page.getByLabel('演示登录凭据').fill(h.tokens.alice);
 await page.getByRole('button',{name:'进入工作台 →',exact:true}).click();
 await page.getByRole('button',{name:'查看全部会话 ↗'}).click();
 await page.getByRole('dialog').getByRole('button',{name:/^Markdown回答展示/}).click();
 await page.locator('.assistant-markdown strong').waitFor();
 assert.equal(await page.locator('.assistant-markdown strong').innerText(),'正在核对');
 assert.match(await page.locator('.assistant-markdown pre code').innerText(),/SELECT COUNT\(/);
 checks.push('未闭合的流式Markdown也能显示，不要求等回答结束');
 append(3,'assistant_committed',{output_id:'markdown-answer',attempt_id:'markdown-attempt',text});
 await page.getByRole('heading',{name:'检查结论',exact:true}).waitFor();
 const message=page.locator('.assistant-markdown');
 assert.equal(await message.count(),1);assert.equal(await message.locator('strong').innerText(),'月支付客户数');
 assert.equal(await message.locator('ul > li').count(),2);assert.equal(await message.locator('ol > li').count(),2);
 assert.match(await message.locator('pre code.language-sql').innerText(),/COUNT\(DISTINCT customer_id\)/);
 assert.equal(await message.getByRole('cell',{name:'整月去重',exact:true}).count(),1);
 assert.equal(await page.locator('.message.user > p').innerText(),user);
 assert.equal(await page.locator('.message.user strong,.message.user pre').count(),0);
 assert.equal(await message.locator('img,script').count(),0);
 assert.equal(await message.getByRole('link',{name:'查看说明'}).getAttribute('rel'),'noopener noreferrer');
 assert.ok(!(await message.getByText('危险链接',{exact:true}).getAttribute('href'))?.toLowerCase().startsWith('javascript:'));
 assert.equal(await page.evaluate(()=>window.markdownUnsafe),undefined);assert.deepEqual(externalRequests,[]);
 checks.push('加粗/列表/引用/SQL/表格完成渲染，用户原话不解析；HTML、危险协议和外部图片请求被阻止');
 // 超宽数据只能在代码/表格内部滚动，不能撑出工作台。
 append(4,'assistant_committed',{output_id:'wide-answer',attempt_id:'wide-attempt',text:'```sql\nSELECT '+Array.from({length:30},(_,n)=>'column_'+n).join(', ')+' FROM demo_order_detail;\n```\n\n|'+Array.from({length:12},(_,n)=>'列'+n).join('|')+'|\n|'+Array.from({length:12},()=> '---').join('|')+'|\n|'+Array.from({length:12},()=> '合成字段值').join('|')+'|'});
 await until(async()=>await page.locator('.assistant-markdown').count()===2,'second markdown answer');
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:1000});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'page overflows at '+width);
  const box=await page.locator('.assistant-markdown').last().boundingBox();assert.ok(box&&box.width<=width);
  await page.screenshot({path:'.local/checks/message-markdown-'+width+'.png',fullPage:true,animations:'disabled'});
 }
 await page.reload();await page.getByRole('heading',{name:'检查结论',exact:true}).waitFor();
 assert.equal(await page.locator('.assistant-markdown').count(),2);assert.deepEqual(errors,[]);
 checks.push('超宽代码和表格在桌面/390px中局部滚动，刷新恢复完整回答且无脚本错误');
 passed=true;console.log(JSON.stringify({passed,checks,officialRequests:0}));
}finally{
 await writeFile('.local/checks/message-markdown.json',JSON.stringify({passed,checks,errors,externalRequests},null,2));
 await browser.close();await h.close();
}

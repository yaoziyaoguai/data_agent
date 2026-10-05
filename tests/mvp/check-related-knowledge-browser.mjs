import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {harness} from './harness.mjs';

const h=await harness({web:true}),browser=await chromium.launch(),page=await browser.newPage();
const q=value=>"'"+value.replaceAll("'","''")+"'";
const checks=[];let passed=false;
try{
 await h.pauseWorker();
 const objects=[...Array.from({length:120},(_,i)=>({id:'a-unrelated-'+String(i).padStart(3,'0'),kind:'table',name:'合成其他表 '+i,related_ids:[]})),
  ...Array.from({length:105},(_,i)=>({id:'z-related-field-'+String(i).padStart(3,'0'),kind:'field',name:'合成字段 '+i,related_ids:['table-demo_order_detail']})),
  ...['metric','document','relationship'].map(kind=>({id:'zz-related-'+kind,kind,name:'合成关联 '+kind,related_ids:['table-demo_order_detail']}))];
 const rows=objects.map(o=>{const v={...o,version:'1',state:'enabled',entries:[],source_id:null,source_version:'0',updated_by:'test'};return `(${q(o.id)},'demo',${q(o.kind)},${q(o.name)},1,'enabled',${q(JSON.stringify(v))},NULL,0,'test')`;});
 h.sql('INSERT INTO knowledge_objects(id,space_id,kind,name,version,state,body,source_id,source_version,updated_by) VALUES'+rows.join(','));
 await page.goto(h.url);await page.getByLabel('演示登录凭据').fill(h.tokens.alice);await page.getByRole('button',{name:'进入工作台 →',exact:true}).click();
 await page.getByRole('button',{name:/语义管理/}).click();await page.getByRole('heading',{name:'demo_order_detail',exact:true}).waitFor();
 await page.getByRole('tab',{name:'字段语义',exact:true}).click();
 await page.getByRole('heading',{name:/^合成字段 0 v1$/}).waitFor({timeout:6000});
 checks.push('目录首页无关联字段时，表详情单独读取关联对象');
 await page.getByRole('button',{name:'加载更多关联内容',exact:true}).click();await page.getByRole('heading',{name:/^合成字段 104 v1$/}).waitFor();
 for(const [tab,kind] of [['指标 SQL','metric'],['业务文档','document'],['关联与血缘','relationship']]){
  await page.getByRole('tab',{name:tab,exact:true}).click();await page.getByRole('heading',{name:new RegExp('^合成关联 '+kind+' v1$')}).waitFor();
 }
 checks.push('关联对象独立翻页，字段/指标/文档/关系四页签均可见');
 assert.equal((await h.request('/knowledge?related_id=missing')).status,404);
 assert.equal((await h.request('/knowledge?related_id=table-demo_order_detail&q=收入')).status,400);
 checks.push('不可见关联目标返回not_available；关联过滤与关键词检索不可混用');
 await page.screenshot({path:'.local/checks/related-knowledge.png',fullPage:true});passed=true;
}finally{
 if(!passed)await page.screenshot({path:'.local/checks/related-knowledge-failure.png',fullPage:true});
 await writeFile('.local/checks/related-knowledge-browser.json',JSON.stringify({passed,checks,officialRequests:0},null,2));
 await browser.close();await h.close();console.log(JSON.stringify({passed,checks}));
}

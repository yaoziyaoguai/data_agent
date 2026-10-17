import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {harness,until} from './harness.mjs';

// 使用真实API、MySQL、Worker和平台；本地协议替身只替代预填模型，不证明模型解释正确。
const output='.local/checks/semantic-source-browser';
await mkdir(output,{recursive:true});
const materials=[],checks=[],browserDiagnostics=[];
let providerError,h,browser,page,passed=false;
const provider=createServer(async(req,res)=>{
 try{
  let raw='';req.setEncoding('utf8');for await(const chunk of req)raw+=chunk;
  const material=JSON.parse(JSON.parse(raw).messages[1].content);materials.push(material);
  const evidence=material.sources.filter(source=>source.body).map(source=>({source_id:source.source_id,version:source.version,location:'L1',quote:source.body.split('\n')[0].slice(0,60)}));
  const entries=material.object.entries.map(entry=>({entry_id:entry.entry_id,value:'协议替身候选：'+entry.path,gaps:['协议测试未验证业务解释'],evidence:evidence.slice(0,20)}));
  res.writeHead(200,{'content-type':'application/json'});
  res.end(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{type:'function',function:{name:'submit_semantic_prefill',arguments:JSON.stringify({entries})}}]}}],usage:{prompt_tokens:100,completion_tokens:200}}));
 }catch(error){providerError=error;res.writeHead(500);res.end('{}');}
});
await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
const profile={provider_id:'deepseek',model_id:'deepseek-flash',trial_id:randomUUID(),price_version:'2026-10-04-peak-usd',input_limit:32768,output_limit:4096,trial_call_limit:6,trial_cost_micros:'500000',request_call_limit:6,toolset:'data',payload_bytes_limit:65536};
try{
 h=await harness({capture:true,web:true,startWorker:false,env:{DATA_AGENT_PREFILL_PROFILE:JSON.stringify(profile),DATA_AGENT_PREFILL_TEST:'1',DATA_AGENT_PREFILL_URL:'http://127.0.0.1:'+provider.address().port}});
 const synced=await h.request('/source-syncs',{operation_id:randomUUID()});assert.equal(synced.status,200,JSON.stringify(synced.value));
 const objects=h.sql("SELECT body FROM knowledge_objects WHERE source_id LIKE 'catalog-%'");
 const target=objects.find(object=>object.kind==='table'&&object.name==='demo_order_detail');assert.ok(target);assert.notEqual(target.id,'table-demo_order_detail');
 const read=async()=>{const response=await h.request('/knowledge/'+target.id);assert.equal(response.status,200,JSON.stringify(response.value));return response.value;};
 const initial=await read();assert.equal(initial.maintenance.can_edit,true);
 browser=await chromium.launch();page=await browser.newPage({viewport:{width:1440,height:1000}});
 page.on('pageerror',error=>browserDiagnostics.push({type:'pageerror',message:error.message}));
 page.on('response',response=>{const path=new URL(response.url()).pathname;if(path.includes('/sources/'))browserDiagnostics.push({type:'source_response',path,status:response.status()});});
 await page.goto(h.url);await page.getByLabel('演示登录凭据').fill(h.tokens.alice);await page.getByRole('button',{name:'进入工作台 →',exact:true}).click();await page.getByLabel('你的数据问题').waitFor();
 await page.goto(h.url+'/#knowledge?'+new URLSearchParams({object:target.id,scope:'tables',tab:'概览'}));await page.reload();
 await page.getByRole('heading',{name:'demo_order_detail',exact:true}).waitFor();
 const entry=page.locator('.semantic-entry').filter({has:page.locator('.entry-head strong',{hasText:'表说明'})});
 await entry.getByRole('button',{name:'编辑',exact:true}).click();
 const humanValue='人工核对：每行代表一个订单商品行；金额以整数分保存。';
 await entry.getByRole('textbox',{name:'表说明',exact:true}).fill(humanValue);
 const saving=page.waitForResponse(response=>response.request().method()==='PATCH'&&new URL(response.url()).pathname.endsWith('/knowledge/'+target.id));
 await entry.getByRole('button',{name:'保存修改',exact:true}).click();assert.equal((await saving).status(),200);
 await entry.getByRole('textbox',{name:'表说明',exact:true}).waitFor({state:'detached'});
 await entry.getByText(humanValue,{exact:true}).waitFor();
 const edited=await read();
 assert.equal(edited.entries.find(value=>value.entry_id==='description').effective_value,humanValue);
 assert.equal(edited.entries.find(value=>value.entry_id==='description').human_override.edited_by,'alice');
 checks.push('维护者通过浏览器实际保存表说明，服务端有效值与人工记录一致');

 const reanalyze=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith('/knowledge/'+target.id+'/reanalyze'));
 await page.getByRole('button',{name:'重新预填',exact:true}).click();assert.equal((await reanalyze).status(),200);
 const queued=await read();assert.equal(queued.prefill_status.state,'queued');
 const frozen=h.sql(`SELECT input_json FROM prefill_attempts WHERE object_id='${target.id}' ORDER BY created_at DESC LIMIT 1`)[0];
 for(const name of ['raw_order_lines','raw_payments','dim_customers']){
  const upstream=objects.find(value=>value.kind==='table'&&value.name===name);assert.ok(upstream);
  assert.ok(frozen.sources.some(source=>source.source_id===upstream.source_id&&source.body.includes('CREATE TABLE '+name)),name+'上游DDL缺失');
 }
 const guide=h.sql("SELECT body FROM knowledge_objects WHERE kind='document' AND source_id='business-guide'");
 assert.ok(guide.some(document=>document.related_ids.includes(target.id)&&frozen.sources.some(source=>source.source_id==='document-'+document.id&&source.version===document.version&&source.body.trim())));
 await h.resumeWorker();
 const completed=await until(async()=>{if(providerError)throw providerError;const value=await read();if(value.prefill_status.state==='invalid_prefill')throw new Error(JSON.stringify(value.prefill_status));return value.prefill_status.state==='succeeded'?value:false;},'浏览器预填成功',45000);
 assert.equal(completed.entries.find(value=>value.entry_id==='description').effective_value,humanValue);
 assert.equal(completed.entries.find(value=>value.entry_id==='description').suggestion.value,'协议替身候选：description');
 const sent=materials.filter(material=>material.object.id===target.id);
 assert.equal(sent.length,2);
 // 模型输入额外含从同版正文派生的逐行引用目录；原来源字段仍须全部一致。
 assert.deepEqual(sent[0].sources.map(({quote_catalog,...source})=>source),frozen.sources);
 for(const source of sent[0].sources)for(const quote of source.quote_catalog){
  assert.match(quote.location,/^L[1-9][0-9]*$/);
  assert.equal(source.body.split('\n')[Number(quote.location.slice(1))-1],quote.quote);
 }
 assert.deepEqual(sent[1].sources,sent[0].sources);
 checks.push('浏览器重预填实际调用Worker；同版输入包含业务文档和三个上游，分析与复核使用同一份材料，人工有效值保留');

 await page.reload();await entry.getByText(humanValue,{exact:true}).waitFor();
 await entry.locator('.provenance-detail > summary').click();
 await entry.getByText('协议替身候选：description',{exact:true}).waitFor();
 await entry.getByText('由 alice 修改',{exact:true}).waitFor();
 const source=(await h.request('/sources/'+completed.source_id)).value;assert.equal(source.version,completed.source_version);
 await page.screenshot({path:output+'/before-source.png'});
 await entry.getByRole('button',{name:'查看来源正文 ↗',exact:true}).click({timeout:10000});
 const dialog=page.getByRole('dialog');await dialog.getByRole('heading',{name:'来源资料',exact:true}).waitFor();
 assert.equal(await dialog.locator('.source-body').textContent(),source.body);
 assert.ok(source.body.includes('CREATE TABLE demo_order_detail'));
 await page.screenshot({path:output+'/source-provenance.png'});
 assert.equal(await page.getByText('已验证正确',{exact:true}).count(),0);
 checks.push('浏览器展开候选与人工记录，并从实际API读取与对象当前版本一致的来源正文；界面未宣称业务验证正确');
 passed=true;console.log(JSON.stringify({passed,checks,calls:materials.length,officialRequests:0}));
}finally{
 if(page&&!passed)await page.screenshot({path:output+'/failure.png',timeout:5000}).catch(error=>browserDiagnostics.push({type:'screenshot_failure',message:error.message}));
 await writeFile(output+'/browser-diagnostics.json',JSON.stringify(browserDiagnostics,null,2));
 await writeFile(output+'/result.json',JSON.stringify({passed,checks,calls:materials.length,officialRequests:0},null,2));
 if(browser)await browser.close();if(h)await h.close();await new Promise(resolve=>provider.close(resolve));
}

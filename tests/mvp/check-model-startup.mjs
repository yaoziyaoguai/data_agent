import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID,randomBytes} from 'node:crypto';
import {chromium} from 'playwright';
import {harness,until} from './harness.mjs';
const database='data_agent_trial_'+randomBytes(8).toString('hex');
const profile={provider_id:'deepseek',model_id:'deepseek-flash',trial_id:randomUUID(),price_version:'2026-10-04-peak-usd',input_limit:32768,output_limit:2048,trial_call_limit:6,trial_cost_micros:'300000',request_call_limit:6,toolset:'data',payload_bytes_limit:65536};
if(process.argv.includes('--pro')) Object.assign(profile,{model_id:'deepseek-v4-pro',price_version:'2026-10-05-pro-peak-usd',thinking_level:'high'});
const path='.local/checks/model-startup-'+randomUUID()+'.json';await writeFile(path,JSON.stringify({database,profile}),{mode:0o600});
const portOffset=process.argv.includes('--pro')?18100:18000;const runtimeDir='.local/checks/startup-'+randomUUID();const webUrl='http://127.0.0.1:'+(5173+portOffset);
const calls=[];let launcher,browser,page,h,passed=false,output='';const checks=[],mutations=[];
const provider=createServer(async(req,res)=>{
 let raw='';req.setEncoding('utf8');for await(const part of req)raw+=part;const body=JSON.parse(raw);assert.equal(body.model,profile.model_id);assert.deepEqual(body.thinking,{type:profile.thinking_level&&profile.thinking_level!=='off'?'enabled':'disabled'});if(profile.thinking_level)assert.equal(body.reasoning_effort,profile.thinking_level);assert.ok(Buffer.byteLength(raw)<=65536);
 if(body.stream===false){
  const material=JSON.parse(body.messages[1].content);const source=material.sources.find(s=>s.source_id==='business-guide');const entry=material.object.entries.find(e=>!['ddl','etl','type'].includes(e.path));assert.ok(entry);
  calls.push('prefill');res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{type:'function',function:{name:'submit_semantic_prefill',arguments:JSON.stringify({entries:[{entry_id:entry.entry_id,value:'正式启动回环建议，仅验证配置接线',gaps:['语言质量待真实验收'],evidence:[{source_id:source.source_id,version:source.version,quote:source.body.slice(0,60),location:'开头'}]}]})}}]}}],usage:{prompt_tokens:100,completion_tokens:80}}));return;
 }
 calls.push('chat');assert.ok(raw.includes('request_clock'));
 const routed=body.messages.some(m=>m.role==='tool');const args={action:'route',task_id:null,expected_version:null,goal:'启动验证',question:null,options:[]};
 const delta=routed?{role:'assistant',content:'正式启动聊天回环已完成。'}:{role:'assistant',tool_calls:[{index:0,id:randomUUID(),type:'function',function:{name:'update_analysis_task',arguments:JSON.stringify(args)}}]};
 res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify({id:'loopback',choices:[{index:0,delta,finish_reason:routed?'stop':'tool_calls'}]})+'\n\n');res.write('data: '+JSON.stringify({choices:[],usage:{prompt_tokens:100,completion_tokens:25,total_tokens:125}})+'\n\n');res.end('data: [DONE]\n\n');
});await new Promise(r=>provider.listen(0,'127.0.0.1',r));
try{
 h=await harness({database,profile,keep:true});await h.close();
 launcher=spawn('python3',['scripts/development.py','--model','protocol-test','--model-profile',path,'--model-url','http://127.0.0.1:'+provider.address().port,'--port-offset',String(portOffset),'--runtime-dir',runtimeDir],{cwd:process.cwd(),env:{...process.env,DATA_AGENT_PREFILL_PROFILE:JSON.stringify({...profile,trial_id:'old-trial-id'}),DATA_AGENT_PREFILL_URL:'http://127.0.0.1:1/wrong',DATA_AGENT_PREFILL_TEST:'0'},stdio:['ignore','pipe','pipe']});launcher.stdout.on('data',d=>output+=d);launcher.stderr.on('data',d=>output+=d);
 await until(async()=>{if(launcher.exitCode!==null)throw new Error('formal_launcher_exited');try{return(await fetch(webUrl)).ok;}catch{return false;}},'formal startup');
 const tokens=JSON.parse(await readFile(runtimeDir+'/identities.json','utf8'));
 browser=await chromium.launch();page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 page.on('response',async response=>{
  const request=response.request(),path=new URL(response.url()).pathname;
  if(!path.includes('/knowledge/')||!['PATCH','POST'].includes(request.method()))return;
  const item={path,method:request.method(),status:response.status(),expected_version:request.postDataJSON()?.expected_version};mutations.push(item);
  try{const result=await response.json();Object.assign(item,{version:result.version,error:result.error,prefill_status:result.prefill_status});}catch{}
 });
 // 固定保存响应稍晚返回，防止把编辑框文字误当成已保存的新版本。
 await page.route('**/api/knowledge/table-demo_order_detail',async route=>{
  if(route.request().method()!=='PATCH'){await route.continue();return;}
  const response=await route.fetch();await new Promise(r=>setTimeout(r,500));await route.fulfill({response});
 });
 await page.goto(webUrl);await page.getByLabel('演示登录凭据').fill(tokens.alice);await page.getByRole('button',{name:'进入工作台 →',exact:true}).click();
 await page.locator('.badge').getByText(profile.model_id==='deepseek-v4-pro'?'DeepSeek V4 Pro':'DeepSeek Flash',{exact:true}).waitFor();
 await page.getByLabel('你的数据问题').fill('验证正式启动聊天接线');await page.getByRole('button',{name:'发送 ↑',exact:true}).click();await page.getByText('正式启动聊天回环已完成。',{exact:true}).waitFor();
 const reanalyze=async()=>{
  const responsePromise=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/knowledge/table-demo_order_detail/reanalyze'&&r.request().method()==='POST');
  await page.getByRole('button',{name:'重新预填',exact:true}).click();
  const response=await responsePromise;assert.equal(response.status(),200);const accepted=await response.json();
  await until(async()=>{
   const heading=await page.locator('.object-heading .eyebrow').innerText();const version=heading.match(/VERSION (\d+)/)?.[1];
   return version&&BigInt(version)>BigInt(accepted.version)&&await page.getByText(/本次模型建议已保存/).isVisible();
  },'current prefill applied');
 };
 await page.getByRole('button',{name:/语义管理/}).click();await reanalyze();
 const firstEntry=page.locator('.semantic-entry').first();await firstEntry.getByRole('button',{name:'编辑',exact:true}).click();await firstEntry.locator('textarea').fill('正式启动下人工保护值');await firstEntry.getByRole('button',{name:'保存修改',exact:true}).click();await firstEntry.locator('.entry-value').getByText('正式启动下人工保护值',{exact:true}).waitFor();assert.equal(await firstEntry.locator('textarea').count(),0);assert.ok(await firstEntry.getByText('人工修改',{exact:true}).isVisible());
 await reanalyze();assert.equal(await firstEntry.locator('.entry-value').innerText(),'正式启动下人工保护值');assert.ok(await firstEntry.getByText('人工修改',{exact:true}).isVisible());
 const ledger=h.sql(`SELECT JSON_OBJECT('calls',allocated_calls,'spent',spent_micros,'reserved',reserved_micros) FROM model_trials WHERE id='${profile.trial_id}'`)[0];assert.equal(ledger.calls,calls.length);assert.deepEqual(calls,['chat','chat','prefill','prefill','prefill','prefill']);assert.equal(ledger.reserved,0);assert.equal(ledger.spent,profile.model_id==='deepseek-v4-pro'?2258:624);assert.equal(errors.length,0);assert.equal(h.sql("SELECT JSON_OBJECT('n',COUNT(*)) FROM model_trials WHERE id='old-trial-id'")[0].n,0);
 checks.push({name:'正式development.py启动方式与页面完成聊天/初次/再次模型预填，人工值保护；Pi和Worker共用原trial账本，0官方调用',passed:true});passed=true;
 console.log(JSON.stringify({passed,checks,calls,ledger,officialRequests:0}));
}catch(error){
 await writeFile('.local/checks/mvp-model-startup-launcher-error.log',output,{mode:0o600});
 if(page){
  const entries=await page.locator('.semantic-entry').evaluateAll(nodes=>nodes.map(node=>({heading:node.querySelector('.entry-head')?.textContent,paragraphs:[...node.querySelectorAll(':scope > p')].map(p=>({className:p.className,text:p.textContent})),editing:!!node.querySelector('textarea')})));
  await writeFile('.local/checks/mvp-model-startup-failure-view.json',JSON.stringify({entries,selected:await page.locator('.object-heading h2').innerText(),calls,mutations,alerts:await page.getByRole('alert').allTextContents(),maintenance:await page.getByRole('status').allTextContents()},null,2),{mode:0o600});
  await page.screenshot({path:'.local/checks/mvp-model-startup-failure-view.png',fullPage:true});
 }
 throw error;
}finally{
 await browser?.close();if(launcher&&launcher.exitCode===null){launcher.kill('SIGTERM');await new Promise(r=>launcher.once('exit',r));}
 if(h)h.sql('DROP DATABASE '+database);await new Promise(r=>provider.close(r));await writeFile('.local/checks/mvp-model-startup'+(process.argv.includes('--pro')?'-pro':'')+'.json',JSON.stringify({passed,checks,calls,officialRequests:0},null,2));
}

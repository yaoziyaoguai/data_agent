import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,stat,rename} from 'node:fs/promises';
import {writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {validateContract} from '../../packages/contracts/validate.ts';
import {harness,until} from './harness.mjs';
import {modelProtocolFixture} from '../runtime/model-protocol-fixture.mjs';
import {checkConfiguredRecovery} from './model-configuration-recovery.mjs';
const directory='.local/checks/model-configuration';await mkdir(directory,{recursive:true});
const keyFile=process.cwd()+'/'+directory+'/master-'+randomUUID()+'.key';
const provider=await modelProtocolFixture();
const h=await harness({web:true,startWorker:false,protocolProviderUrl:provider.url,env:{DATA_AGENT_MODEL_KEY_FILE:keyFile,DATA_AGENT_SEMANTIC_SUPER_MAINTAINERS:JSON.stringify({demo:['alice'],'model-scope-a':['alice'],'model-scope-b':['alice'],'model-scope-seeded':['alice']})}});
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.value));return r.value;};
const rejected=(response,status,code)=>{assert.equal(response.status,status);assert.equal(response.value.code,code);validateContract('AppError',response.value);};
const config=async()=>ok(await h.request('/model-configuration'));
const service=id=>({id,name:'合成服务 '+id,provider_id:'compatible',api:id,base_url:provider.url+'/gateway/v1',enabled:true,expected_version:'0',api_key:'synthetic-key-'+id});
const model=id=>({id,service_id:id,model_id:'synthetic/'+id,label:'合成模型 '+id,thinking_levels:['off','high'],reasoning_supported:true,default_thinking:'off',input_limit:128000,output_limit:16000,payload_bytes_limit:262144,input_rate:'1000000',output_rate:'4000000',enabled:true,expected_version:'0'});
const edit=(value)=>{const {version,credential_configured,...body}=value;return {...body,expected_version:version};};
const send=(cid,text,id)=>h.request('/conversations/'+cid+'/messages',{client_message_id:randomUUID(),text,...(id?{model_selection:{model_id:id,thinking_level:'off'}}:{})});
const checks=[],errors=[];let passed=false,browser,page,closed=false;
try {
 const scopeLog=execFileSync(process.env.HOME+'/.cargo/bin/cargo',['test','--offline','--locked','-p','data-agent','--test','model_configuration','--','--test-threads=1'],{env:h.env,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:180000});await writeFile(directory+'/scope-test.log',scopeLog);
 checks.push('直接用例验证跨空间配置/密钥隔离、原模型改绑后仍按原服务状态检查、版本上溢拒绝');
 assert.deepEqual(ok(await h.request('/model-configuration/access')),{can_manage_models:true});
 assert.deepEqual(ok(await h.request('/model-configuration/access',undefined,'bob')),{can_manage_models:false});
 for(const [path,body] of [['/model-configuration',undefined],['/model-services',service('openai-completions')],['/model-definitions',model('openai-completions')],['/model-configuration/default',{model_id:'unknown',expected_version:'1'}]])assert.equal((await h.request(path,body,'bob')).status,403);
 assert.deepEqual((await config()).services,[]);
 for(const api of ['openai-completions','openai-responses','anthropic-messages']){
   const input=service(api);if(api==='anthropic-messages')input.base_url=provider.url+'/gateway';
   const saved=ok(await h.request('/model-services',input));assert.ok(!JSON.stringify(saved).includes(input.api_key));
   assert.deepEqual(ok(await h.request('/model-services',input)),saved);
   ok(await h.request('/model-definitions',model(api)));
 }
 let current=await config();ok(await h.request('/model-configuration/default',{expected_version:current.version,model_id:'openai-completions'}));
 const catalog=ok(await h.request('/models',undefined,'bob'));assert.equal(catalog.models.length,3);assert.ok(!JSON.stringify(catalog).includes(provider.url));assert.ok(!JSON.stringify(catalog).includes('api_key'));
 const persisted=h.sql("SELECT JSON_OBJECT('payload',payload,'encrypted_length',LENGTH(encrypted_key)) FROM model_service_versions");assert.ok(persisted.every(r=>r.encrypted_length>28&&!JSON.stringify(r.payload).includes('synthetic-key-')));
 assert.equal((await stat(keyFile)).mode&0o777,0o600);assert.equal((await readFile(keyFile)).length,32);
 checks.push('超级管理员服务与模型配置、普通用户读写拒绝、公开目录不含端点、密钥加密与0600文件、精确重放');
 const old=(await config()).services.find(s=>s.id==='openai-completions');
 const competing=await Promise.all(['A','B'].map(name=>h.request('/model-services',{...edit(old),name})));assert.deepEqual(competing.map(r=>r.status).sort(),[200,409]);
 assert.equal((await h.request('/model-services',{...edit(old),name:'stale'})).status,409);
 rejected(await h.request('/model-services',{...service('openai-completions'),id:'private',base_url:'http://169.254.169.254/latest'}),400,'invalid_model_endpoint');
 rejected(await h.request('/model-services',{...service('openai-completions'),id:'missing-key',api_key:undefined}),409,'model_credential_required');
 assert.equal((await h.request('/model-services',{...service('openai-completions'),id:'url-secret',base_url:'https://user:password@example.com/v1'})).status,400);
 assert.equal((await h.request('/model-definitions',{...model('invalid'),service_id:'openai-completions',default_thinking:'max'})).status,400);
 assert.equal((await h.request('/model-definitions',{...model('missing'),service_id:'other-space-service'})).status,404);
 assert.equal((await h.request('/model-definitions',{...model('tiny'),service_id:'openai-responses',output_limit:1})).status,400);
 assert.equal((await h.request('/model-definitions',{...model('budget-max'),service_id:'anthropic-messages',thinking_levels:['high','max']})).status,400);
 assert.equal((await h.request('/model-definitions',{...model('budget-small'),service_id:'anthropic-messages',output_limit:1024})).status,400);
 checks.push('并发编辑只有一个成功、旧版本拒绝；非法端点、缺失服务和档位不一致拒绝');
 // 接收消息后修订服务密钥和模型标识，原消息仍使用历史版本。
 const cid=await h.create();const first=ok(await send(cid,'原版本消息','openai-completions'));
 const snapshot=h.sql(`SELECT JSON_OBJECT('profile',model_profile) FROM budget_scopes WHERE message_id='${first.message_id}'`)[0].profile;
 const before=await config();const oldService=before.services.find(s=>s.id==='openai-completions'),oldModel=before.models.find(m=>m.id==='openai-completions');
 ok(await h.request('/model-services',{...edit(oldService),api_key:'synthetic-key-rotated'}));
 ok(await h.request('/model-definitions',{...edit(oldModel),model_id:'synthetic/revised-model'}));
 await h.restartApi();await h.resumeWorker();await h.finished(cid);
 const firstCalls=provider.requests.slice();assert.equal(firstCalls.length,2);assert.ok(firstCalls.every(r=>r.body.model===snapshot.model_id&&r.key==='Bearer synthetic-key-openai-completions'));
 ok(await send(cid,'新版本消息'));await h.finished(cid,2);assert.ok(provider.requests.slice(2).every(r=>r.body.model==='synthetic/revised-model'&&r.key==='Bearer synthetic-key-rotated'));
 for(const id of ['openai-responses','anthropic-messages']){ok(await send(cid,'切换协议 '+id,id));await h.finished(cid,id==='openai-responses'?3:4);}
 assert.equal(provider.requests.length,8);assert.deepEqual(provider.errors,[]);
 assert.ok(provider.requests.some(r=>r.path==='/gateway/v1/responses'));
 const anthropic=provider.requests.filter(r=>r.path==='/gateway/v1/messages?beta=true');assert.equal(anthropic.length,2);assert.ok(anthropic.every(r=>r.key==='synthetic-key-anthropic-messages'&&r.body.stream_options===undefined));
 const attempts=h.sql(`SELECT JSON_OBJECT('state',state,'usage',usage_json) FROM model_call_attempts WHERE run_id IN (SELECT id FROM agent_runs WHERE conversation_id='${cid}')`);assert.equal(attempts.length,8);assert.ok(attempts.every(r=>r.state==='settled'&&r.usage.input_tokens===100&&r.usage.output_tokens===25));
 const budget=h.sql(`SELECT JSON_OBJECT('calls',issued_calls,'limit',call_limit,'profile',model_profile) FROM budget_scopes WHERE message_id='${first.message_id}'`)[0];assert.equal(budget.limit,24);assert.equal(budget.calls,2);
 assert.ok(!JSON.stringify(await h.snapshot(cid)).includes('synthetic-key-'));
 checks.push('非内置Model ID通过真实Pi的三协议工具回合，跨协议会话续接；历史密钥/模型冻结、改动对新消息生效，重启可解密；缓存用量对齐与原24次预算');
 const nativeService={...service('anthropic-messages'),id:'native-claude-service',provider_id:'anthropic',base_url:provider.url+'/gateway'};
 ok(await h.request('/model-services',nativeService));
 ok(await h.request('/model-definitions',{...model('native-claude'),service_id:nativeService.id,model_id:'claude-opus-5-5',thinking_levels:['high'],default_thinking:'high',anthropic_thinking_mode:'adaptive'}));
 const nativeCid=await h.create();ok(await h.request('/conversations/'+nativeCid+'/messages',{client_message_id:randomUUID(),text:'内置Claude工具回合',model_selection:{model_id:'native-claude',thinking_level:'high'}}));await h.finished(nativeCid);
 const nativeCalls=provider.requests.slice(8);assert.equal(nativeCalls.length,2);assert.ok(nativeCalls.every(r=>!r.body.fallbacks?.length&&r.body.tools.every(t=>!t.name.startsWith('__pi_'))));
 checks.push('真实SDK目录Claude的完整工具回合保留宿主工具集合、思考参数和冻结模型，不注入隐藏工具或供应商fallback');
 // 停用不换模型；旧接收消息也在真正发送之前拒绝。
 await h.pauseWorker();const waiting=ok(await send(cid,'等待停用的消息','openai-completions'));
 const active=(await config()).models.find(m=>m.id==='openai-completions');ok(await h.request('/model-definitions',{...edit(active),enabled:false}));
 rejected(await send(cid,'不能自动换模型'),409,'model_unavailable');
 const n=provider.requests.length;await h.resumeWorker();await until(()=>h.sql(`SELECT JSON_OBJECT('state',disposition) FROM conversation_messages WHERE id='${waiting.message_id}'`)[0]?.state==='failed','停用后原消息明确失败',30000);assert.equal(provider.requests.length,n);
 checks.push('停用后已有会话不自动换模型，排队消息在发送前被阻断');
 // 密钥文件丢失不能生成新文件覆盖已有加密内容。
 await rename(keyFile,keyFile+'.saved');
 try {
   const cs=(await config()).services.find(s=>s.id==='openai-responses');rejected(await h.request('/model-services',{...edit(cs),name:'missing master'}),409,'model_secret_unavailable');
 } finally {await rename(keyFile+'.saved',keyFile);}
 checks.push('缺失主密钥失败关闭，不自动替换或丢失已有凭据');
 browser=await chromium.launch();page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));
 await page.goto(h.url);await page.getByLabel('演示登录凭据').fill(h.tokens.alice);await page.getByRole('button',{name:'进入工作台 →',exact:true}).click();await page.getByRole('button',{name:'模型配置',exact:true}).click();
 await page.getByRole('button',{name:'添加服务',exact:true}).click();await page.getByLabel('服务名称',{exact:true}).fill('浏览器合成服务');await page.getByLabel('服务地址',{exact:true}).fill('http://169.254.169.254/latest');await page.getByLabel('API Key',{exact:true}).fill('synthetic-browser-key');await page.getByRole('button',{name:'保存配置',exact:true}).click();await page.getByRole('alert').filter({hasText:'服务地址需要 HTTPS'}).waitFor();assert.equal(await page.getByLabel('服务名称',{exact:true}).inputValue(),'浏览器合成服务');
 await page.getByLabel('服务地址',{exact:true}).fill(provider.url+'/browser/v1');await page.getByRole('button',{name:'保存配置',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
 await page.getByRole('button',{name:'编辑服务 浏览器合成服务',exact:true}).click();assert.equal(await page.getByLabel('API Key',{exact:true}).inputValue(),'');await page.getByLabel('服务地址',{exact:true}).fill(provider.url+'/browser-revised/v1');await page.getByRole('button',{name:'保存配置',exact:true}).click();await page.getByRole('alert').filter({hasText:'需要重新提供 API Key'}).waitFor();assert.equal(await page.getByLabel('服务地址',{exact:true}).inputValue(),provider.url+'/browser-revised/v1');
 await page.getByLabel('API Key',{exact:true}).fill('synthetic-browser-key');await page.getByRole('button',{name:'保存配置',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
 await page.getByRole('button',{name:'添加模型',exact:true}).click();await page.getByLabel('所属服务',{exact:true}).selectOption({label:'浏览器合成服务'});await page.getByLabel('Model ID',{exact:true}).fill('synthetic/browser-model');await page.getByLabel('展示名称',{exact:true}).fill('浏览器合成模型');await page.getByLabel('输入价格',{exact:true}).fill('1.25');await page.getByLabel('输出价格',{exact:true}).fill('5');await page.getByRole('button',{name:'保存配置',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
 const browserModel=(await config()).models.find(m=>m.label==='浏览器合成模型');assert.equal(browserModel.input_rate,'1250000');assert.equal(browserModel.output_rate,'5000000');
 await page.locator('article').filter({has:page.getByRole('heading',{name:'浏览器合成模型',exact:false})}).getByRole('button',{name:'设为默认',exact:true}).click();
 await until(async()=>{const c=await config();return c.models.find(m=>m.id===c.default_model_id)?.label==='浏览器合成模型';},'浏览器设为默认');
 await page.getByRole('button',{name:'编辑服务 浏览器合成服务',exact:true}).click();assert.equal(await page.getByLabel('API Key',{exact:true}).inputValue(),'');
 await page.getByLabel('服务名称',{exact:true}).fill('保留的编辑草稿');const serverService=(await config()).services.find(s=>s.name==='浏览器合成服务');ok(await h.request('/model-services',{...edit(serverService),name:'其他管理员的修改'}));
 await page.getByRole('button',{name:'保存配置',exact:true}).click();await page.getByText('其他管理员已更新配置。',{exact:false}).waitFor();assert.equal(await page.getByLabel('服务名称',{exact:true}).inputValue(),'保留的编辑草稿');
 await page.getByRole('button',{name:'取消',exact:true}).click();await page.getByRole('button',{name:'放弃修改',exact:true}).click();await page.getByRole('button',{name:'重新读取',exact:true}).click();
 await page.screenshot({path:directory+'/desktop.png',fullPage:true});await page.setViewportSize({width:390,height:844});await page.screenshot({path:directory+'/mobile.png',fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 const heading=await page.locator('.configuration-heading').boundingBox(),servicesTitle=await page.getByRole('heading',{name:'服务连接',exact:true}).boundingBox();assert.ok(heading.y+heading.height<=servicesTitle.y,'窄屏标题和正文不重叠');
 await page.getByRole('button',{name:'编辑模型 浏览器合成模型',exact:true}).click();await page.screenshot({path:directory+'/mobile-editor.png',fullPage:false,animations:'disabled'});await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:directory+'/desktop-editor.png',fullPage:false,animations:'disabled'});await page.getByRole('button',{name:'取消',exact:true}).click();
 const ordinary=await browser.newPage();await ordinary.goto(h.url+'/#models');await ordinary.getByLabel('演示登录凭据').fill(h.tokens.bob);await ordinary.getByRole('button',{name:'进入工作台 →',exact:true}).click();await ordinary.getByText('当前账号没有模型配置权限。',{exact:true}).waitFor();assert.equal(await ordinary.getByRole('button',{name:'模型配置',exact:true}).count(),0);assert.equal(await ordinary.getByRole('button',{name:'添加服务',exact:true}).count(),0);
 checks.push('管理拒绝符合AppError契约；浏览器显示地址/缺密钥具体提示并保留草稿，创建服务/模型/默认及价格转换、密钥不回填、版本冲突保留草稿、窄屏无溢出；普通用户直接导航也被拒绝');
 assert.deepEqual(errors,[]);await h.close();closed=true;
 checks.push(await checkConfiguredRecovery(provider));passed=true;
} finally {
 if(!passed&&page){await page.screenshot({path:directory+'/failure.png',fullPage:true}).catch(()=>{});await writeFile(directory+'/failure-dom.txt',await page.locator('body').innerText().catch(()=>''));}
 await writeFile(directory+'/protocol-trace.json',JSON.stringify(provider.requests.map(({path,body})=>({path,body})),null,2));
 if(browser)await browser.close();if(!closed)await h.close();await provider.close();
 await writeFile(directory+'/report.json',JSON.stringify({passed,checks,errors,providerErrors:provider.errors,requests:provider.requests.length,officialRequests:0},null,2));
 console.log(JSON.stringify({passed,checks,errors,requests:provider.requests.length,officialRequests:0}));
}

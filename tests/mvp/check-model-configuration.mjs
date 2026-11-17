import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,stat,rename} from 'node:fs/promises';
import {writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {validateContract} from '../../packages/contracts/validate.ts';
import {harness,until} from './harness.mjs';
import {modelProtocolFixture} from '../runtime/model-protocol-fixture.mjs';
import {checkConfiguredRecovery} from './model-configuration-recovery.mjs';
import {restoreCheckpoint} from '../../apps/agent/session/checkpoint.ts';
const directory='.local/checks/model-configuration';await mkdir(directory,{recursive:true});
const keyFile=process.cwd()+'/'+directory+'/master-'+randomUUID()+'.key';
const provider=await modelProtocolFixture();
const h=await harness({web:true,startWorker:false,protocolProviderUrl:provider.url,env:{DATA_AGENT_MODEL_KEY_FILE:keyFile,DATA_AGENT_SEMANTIC_SUPER_MAINTAINERS:JSON.stringify({demo:['alice'],'model-scope-a':['alice'],'model-scope-b':['alice'],'model-scope-seeded':['alice']})}});
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.value));return r.value;};
const rejected=(response,status,code)=>{assert.equal(response.status,status);assert.equal(response.value.code,code);validateContract('AppError',response.value);};
const config=async()=>ok(await h.request('/model-configuration'));
const service=id=>({id,name:'合成服务 '+id,provider_id:'compatible',api:id,base_url:provider.url+'/gateway/v1',enabled:true,expected_version:'0',api_key:'synthetic-key-'+id});
const model=id=>({id,service_id:id,model_id:'synthetic/'+id,label:'合成模型 '+id,thinking_levels:['off','high'],reasoning_supported:true,default_thinking:'off',context_window:160000,input_limit:128000,output_limit:16000,payload_bytes_limit:262144,request_timeout_ms:90000,capability_source:'admin_declared',input_rate:'1000000',output_rate:'4000000',enabled:true,expected_version:'0'});
const edit=(value)=>{const {version,credential_configured,...body}=value;return {...body,expected_version:version};};
const send=(cid,text,id)=>h.request('/conversations/'+cid+'/messages',{client_message_id:randomUUID(),text,...(id?{model_selection:{model_id:id,thinking_level:'off'}}:{})});
const checks=[],errors=[];let passed=false,browser,page,closed=false;
try {
 const upgrades=[];
 for(const lifecycle of ['legacy-default','current-default','fresh-space','persisted-without-default']){
  const defaultTrial='models-'+createHash('sha256').update(JSON.stringify('demo')).digest('hex').slice(0,24);
  const base={provider_id:'deepseek',model_id:'deepseek-flash',trial_id:defaultTrial,price_version:'2026-10-04-peak-usd',input_limit:65536,output_limit:8192,toolset:'data',payload_bytes_limit:131072,thinking_level:'off',budget_mode:'request'};
  const profile=lifecycle==='fresh-space'?undefined:{...base,...(lifecycle==='legacy-default'?{request_call_limit:24}:{}),...(lifecycle==='persisted-without-default'?{trial_id:randomUUID()}:{})};
  const upgrade=await harness({startWorker:false,profile,protocolProviderUrl:provider.url});
  const observation={lifecycle};upgrades.push(observation);
  try {
   const trial=profile?.trial_id??defaultTrial;
   const ledger=()=>upgrade.sql(`SELECT JSON_OBJECT('id',id,'fingerprint',configuration_fingerprint,'call_limit',call_limit,'cost_limit_micros',CAST(cost_limit_micros AS CHAR),'allocated_calls',allocated_calls,'spent_micros',CAST(spent_micros AS CHAR),'reserved_micros',CAST(reserved_micros AS CHAR),'state',state,'expires_at',expires_at) FROM model_trials WHERE id='${trial}'`);
   let oldMessage,oldScope;
   if(profile){
    ok(await upgrade.request('/model-configuration'));
    const oldCid=await upgrade.create();oldMessage=ok(await upgrade.request('/conversations/'+oldCid+'/messages',{client_message_id:randomUUID(),text:'合成历史已接收消息'}));
    // 历史记账值独立于配置指纹；登记仍由API启动时的configure_trial完成。
    upgrade.sql(`UPDATE model_trials SET allocated_calls=7,spent_micros=123,reserved_micros=17,call_limit=1000,cost_limit_micros=1000000,expires_at='2030-01-01 00:00:00' WHERE id='${trial}'`);
    upgrade.sql(`UPDATE budget_scopes SET call_limit=24,issued_calls=7 WHERE message_id='${oldMessage.message_id}'`);
    oldScope=upgrade.sql(`SELECT JSON_OBJECT('id',id,'message_id',message_id,'call_limit',call_limit,'issued_calls',issued_calls,'profile',model_profile) FROM budget_scopes WHERE message_id='${oldMessage.message_id}'`);
    if(lifecycle==='persisted-without-default')assert.deepEqual(upgrade.sql(`SELECT JSON_OBJECT('id',id) FROM model_trials WHERE id='${defaultTrial}'`),[],'托管模型存在但尚无默认trial');
   }else{
    assert.deepEqual(ledger(),[]);
    assert.deepEqual(upgrade.sql("SELECT JSON_OBJECT('space',space_id) FROM model_space_settings WHERE space_id='demo'"),[]);
   }
   observation.before=ledger();observation.oldScope=oldScope;
   delete upgrade.env.DATA_AGENT_MODEL_PROFILE;
   await upgrade.restartApi();
   for(let restart=0;restart<2;restart++){
    if(restart)await upgrade.restartApi();
    const cid=await upgrade.create();let configuration,message;
    if(['fresh-space','persisted-without-default'].includes(lifecycle)){
     message=await upgrade.request('/conversations/'+cid+'/messages',{client_message_id:randomUUID(),text:'合成默认配置升级后消息'});
     configuration=await upgrade.request('/model-configuration');
    }else{
     configuration=await upgrade.request('/model-configuration');
     message=await upgrade.request('/conversations/'+cid+'/messages',{client_message_id:randomUUID(),text:'合成默认配置升级后消息'});
    }
    observation['restart'+restart]={configuration,message,ledger:ledger()};
    await writeFile(directory+'/default-upgrade.json',JSON.stringify({upgrades,officialRequests:0},null,2));
    assert.deepEqual([configuration.status,message.status],[200,200],lifecycle+' GET和POST均可用：'+JSON.stringify(observation['restart'+restart]));
    if(lifecycle==='fresh-space'&&restart===0){
     assert.equal(configuration.value.models.length,0);
     ok(await upgrade.request('/model-services',{id:'synthetic-default',name:'合成默认服务',provider_id:'compatible',api:'openai-completions',base_url:provider.url+'/gateway/v1',enabled:true,expected_version:'0',api_key:'synthetic-default-key'}));
     ok(await upgrade.request('/model-definitions',{...model('synthetic-default'),service_id:'synthetic-default'}));
     const setting=ok(await upgrade.request('/model-configuration'));
     ok(await upgrade.request('/model-configuration/default',{expected_version:setting.version,model_id:'synthetic-default'}));
     message=await upgrade.request('/conversations/'+cid+'/messages',{client_message_id:randomUUID(),text:'合成默认模型已配置消息'});ok(message);
    }
    const scope=upgrade.sql(`SELECT JSON_OBJECT('call_limit',call_limit,'profile',model_profile) FROM budget_scopes WHERE message_id='${message.value.message_id}'`)[0];
    assert.equal(scope.call_limit,null,lifecycle+'新正常scope无累计调用上限');
    assert.equal(scope.profile.trial_id,defaultTrial,lifecycle+'不换默认trial补额');
    assert.equal(scope.profile.configured_model.service_id,lifecycle==='fresh-space'?'synthetic-default':'deployment-deepseek');
    if(profile){
     assert.deepEqual(ledger(),observation.before,lifecycle+'旧trial整行及记账保留');
     assert.deepEqual(upgrade.sql(`SELECT JSON_OBJECT('id',id,'message_id',message_id,'call_limit',call_limit,'issued_calls',issued_calls,'profile',model_profile) FROM budget_scopes WHERE message_id='${oldMessage.message_id}'`),oldScope,lifecycle+'旧数字scope冻结');
    }
    const defaultLedger=upgrade.sql(`SELECT JSON_OBJECT('id',id,'call_limit',call_limit,'cost_limit_micros',cost_limit_micros,'expires_at',expires_at) FROM model_trials WHERE id='${defaultTrial}'`);
    assert.equal(defaultLedger.length,1);
    if(lifecycle==='fresh-space'||lifecycle==='persisted-without-default')assert.deepEqual(defaultLedger,[{id:defaultTrial,call_limit:null,cost_limit_micros:null,expires_at:null}]);
    observation['restart'+restart].scope=scope;
   }
   observation.after=ledger();assert.equal(provider.requests.length,0,'兼容检查不发送模型请求');
  }finally{
   await writeFile(directory+'/default-upgrade.json',JSON.stringify({upgrades,officialRequests:0},null,2));await upgrade.close();
  }
 }
 checks.push('旧含24字段/当前缺字段/全新空间/已托管撤环境且无默认trial四种生命周期，GET及POST和两次API重启均成功；新scope无累计门、旧数字scope及账本整行不变，零模型请求');
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
 // 容量反例：I=O=65536时两段摘要与近期保留放不进触发线，明确按容量错误拒绝。
 const infeasible=await h.request('/model-definitions',{...model('capacity-infeasible'),service_id:'openai-completions',context_window:131072,input_limit:65536,output_limit:65536});
 rejected(infeasible,400,'model_capacity_invalid');
 assert.match(infeasible.value.message,/输入范围 无可行值/);
 assert.match(infeasible.value.message,/输出范围 1–21503 tokens/);
 // 新字段缺失（SaveModelDefinition契约必填）与输出超出393216拒绝。
 assert.equal((await h.request('/model-definitions',(({context_window,...rest})=>rest)(model('capacity-missing')))).status,400);
 assert.equal((await h.request('/model-definitions',{...model('capacity-oversized'),service_id:'openai-completions',output_limit:393217})).status,400);
 // 已核对DeepSeek初值（1M窗口、600秒、8MiB）与长输出档通过同一容量校验并冻结进profile。
 for(const [id,output] of [['capacity-deepseek',65536],['capacity-deepseek-long',131072]]){
  const saved=ok(await h.request('/model-definitions',{...model(id),service_id:'openai-completions',context_window:1000000,input_limit:900000,output_limit:output,payload_bytes_limit:8388608,request_timeout_ms:600000,capability_source:'admin_declared'}));
  const stored=saved.models.find(m=>m.id===id);assert.equal(stored.context_window,1000000);assert.equal(stored.request_timeout_ms,600000);assert.equal(stored.capability_source,'admin_declared');
 }
 checks.push('并发编辑只有一个成功、旧版本拒绝；非法端点、缺失服务和档位不一致拒绝；容量反例/缺字段/超上限拒绝，DeepSeek初值与长输出档保存并冻结新字段');
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
 const budget=h.sql(`SELECT JSON_OBJECT('calls',issued_calls,'limit',call_limit,'profile',model_profile) FROM budget_scopes WHERE message_id='${first.message_id}'`)[0];assert.equal(budget.limit,null);assert.equal(budget.calls,2);
 assert.ok(!JSON.stringify(await h.snapshot(cid)).includes('synthetic-key-'));
 checks.push('非内置Model ID通过真实Pi的三协议工具回合，跨协议会话续接；历史密钥/模型冻结、改动对新消息生效，重启可解密；缓存用量对齐与无累计调用上限');
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
 ok(await h.request('/model-services',{...service('deepseek-capacity'),provider_id:'deepseek',api:'openai-completions',name:'容量核对服务'}));
 // 先暂停Worker验证官方地址保存；工具回合显式改成本地端点后再恢复。
 await h.pauseWorker();const browserRequestCount=provider.requests.length;
 browser=await chromium.launch();page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));
 await page.goto(h.url);await page.getByLabel('演示登录凭据').fill(h.tokens.alice);await page.getByRole('button',{name:'进入工作台 →',exact:true}).click();await page.getByRole('button',{name:'模型配置',exact:true}).click();
 await page.getByRole('button',{name:'添加服务',exact:true}).click();
 const providerField=page.getByLabel('供应商',{exact:true}),protocolField=page.getByLabel('接口协议',{exact:true}),addressField=page.getByLabel('服务地址',{exact:true});
 await providerField.selectOption('openai');
 assert.equal(await protocolField.inputValue(),'openai-responses','新建服务明确选择OpenAI时默认使用Responses');
 assert.equal(await addressField.getAttribute('placeholder'),'https://api.openai.com/v1');
 assert.equal(await addressField.inputValue(),'','官方地址只作示例，不替管理员填写');
 await page.screenshot({path:directory+'/openai-default.png',fullPage:false,animations:'disabled'});
 await addressField.fill('https://synthetic-gateway.example.com/custom/v1');
 await providerField.selectOption('anthropic');assert.equal(await protocolField.inputValue(),'anthropic-messages');
 await providerField.selectOption('openai');assert.equal(await protocolField.inputValue(),'openai-responses','从Anthropic切换OpenAI时重置协议初值');
 assert.equal(await addressField.inputValue(),'https://synthetic-gateway.example.com/custom/v1','切换供应商保留已填写地址');
 await protocolField.selectOption('openai-completions');await page.getByLabel('服务名称',{exact:true}).fill('协议可编辑');
 assert.equal(await protocolField.inputValue(),'openai-completions','OpenAI默认协议仍允许管理员编辑');
 await protocolField.selectOption('openai-responses');await addressField.fill('https://api.openai.com/v1');
 await page.getByLabel('服务名称',{exact:true}).fill('OpenAI 合成服务');await page.getByLabel('API Key',{exact:true}).fill('synthetic-openai-browser-key');
 assert.equal(await page.getByLabel('API Key',{exact:true}).getAttribute('type'),'password');
 await page.getByRole('button',{name:'保存配置',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
 const openaiService=(await config()).services.find(s=>s.name==='OpenAI 合成服务');
 for(const [field,value] of Object.entries({provider_id:'openai',api:'openai-responses',base_url:'https://api.openai.com/v1',credential_configured:true}))assert.equal(openaiService[field],value);
 assert.equal(Object.hasOwn(openaiService,'api_key'),false);assert.ok(!JSON.stringify(await config()).includes('synthetic-openai-browser-key'));
 await page.reload();await page.getByRole('button',{name:'编辑服务 OpenAI 合成服务',exact:true}).click();
 assert.equal(await protocolField.inputValue(),'openai-responses');assert.equal(await addressField.inputValue(),'https://api.openai.com/v1');assert.equal(await page.getByLabel('API Key',{exact:true}).inputValue(),'');
 await protocolField.selectOption('openai-completions');await providerField.selectOption('anthropic');await providerField.selectOption('openai');
 assert.equal(await protocolField.inputValue(),'openai-responses','编辑已有服务时显式选择OpenAI也使用Responses');assert.equal(await addressField.inputValue(),'https://api.openai.com/v1');
 await page.screenshot({path:directory+'/openai-service.png',fullPage:false,animations:'disabled'});
 await page.getByRole('button',{name:'取消',exact:true}).click();
 checks.push('OpenAI新建和编辑时显式选择默认Responses并展示官方地址示例，Anthropic切换保留已填地址，协议可编辑；合成密钥保存后仅显示配置状态');
 const defaultBeforeOpenai=(await config()).default_model_id;
 await page.getByRole('button',{name:'添加模型',exact:true}).click();await page.getByLabel('所属服务',{exact:true}).selectOption(openaiService.id);
 await page.getByLabel('Model ID',{exact:true}).fill('gpt-6.1-sol');await page.getByLabel('展示名称',{exact:true}).fill('OpenAI GPT-6.1 Sol');
 await page.getByLabel('模型支持思考',{exact:false}).check();
 const thinkingOptions=page.getByRole('group',{name:'支持的思考档位',exact:true});
 for(const label of ['轻度','中等','深度','更深','最高'])await thinkingOptions.getByLabel(label,{exact:true}).check();
 await thinkingOptions.getByLabel('关闭',{exact:true}).uncheck();await page.getByLabel('默认思考档位',{exact:true}).selectOption('high');
 const openaiFields=[['总上下文 tokens','1050000'],['最大输入 tokens','900000'],['最大输出 tokens','128000'],['请求体 MiB','8'],['请求超时秒','600'],['输入价格','5'],['输出价格','15']];
 for(const [label,value] of openaiFields)await page.getByLabel(label,{exact:true}).fill(value);
 await page.getByLabel('能力来源',{exact:true}).selectOption('admin_declared');
 await page.getByRole('button',{name:'保存配置',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
 const openaiConfiguration=await config(),openaiModel=openaiConfiguration.models.find(m=>m.model_id==='gpt-6.1-sol');
 const expectedOpenai={service_id:openaiService.id,model_id:'gpt-6.1-sol',label:'OpenAI GPT-6.1 Sol',reasoning_supported:true,thinking_levels:['low','medium','high','xhigh','max'],default_thinking:'high',context_window:1050000,input_limit:900000,output_limit:128000,payload_bytes_limit:8388608,request_timeout_ms:600000,capability_source:'admin_declared',input_rate:'5000000',output_rate:'15000000',enabled:true};
 for(const [field,value] of Object.entries(expectedOpenai))assert.deepEqual(openaiModel[field],value,'OpenAI模型保存字段 '+field);
 assert.equal(openaiConfiguration.default_model_id,defaultBeforeOpenai,'新增可选OpenAI模型保留管理员原默认选择');
 await page.reload();await page.getByRole('button',{name:'编辑模型 OpenAI GPT-6.1 Sol',exact:true}).click();
 assert.equal(await page.getByLabel('默认思考档位',{exact:true}).inputValue(),'high');
 for(const [label,value] of openaiFields)assert.equal(await page.getByLabel(label,{exact:true}).inputValue(),value,'刷新后模型字段 '+label);
 await page.screenshot({path:directory+'/openai-model.png',fullPage:false,animations:'disabled'});await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
 checks.push('原管理页保存gpt-6.1-sol的五档/high、1050000/900000/128000 tokens、8MiB/600秒及5/15美元费率；刷新后字段一致，未自动替换默认模型');
 await page.getByRole('button',{name:'添加服务',exact:true}).click();await page.getByLabel('服务名称',{exact:true}).fill('浏览器合成服务');await page.getByLabel('服务地址',{exact:true}).fill('http://169.254.169.254/latest');await page.getByLabel('API Key',{exact:true}).fill('synthetic-browser-key');await page.getByRole('button',{name:'保存配置',exact:true}).click();await page.getByRole('alert').filter({hasText:'服务地址需要 HTTPS'}).waitFor();assert.equal(await page.getByLabel('服务名称',{exact:true}).inputValue(),'浏览器合成服务');
 await page.getByLabel('服务地址',{exact:true}).fill(provider.url+'/browser/v1');await page.getByRole('button',{name:'保存配置',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
 await page.getByRole('button',{name:'编辑服务 浏览器合成服务',exact:true}).click();assert.equal(await page.getByLabel('API Key',{exact:true}).inputValue(),'');await page.getByLabel('服务地址',{exact:true}).fill(provider.url+'/browser-revised/v1');await page.getByRole('button',{name:'保存配置',exact:true}).click();await page.getByRole('alert').filter({hasText:'需要重新提供 API Key'}).waitFor();assert.equal(await page.getByLabel('服务地址',{exact:true}).inputValue(),provider.url+'/browser-revised/v1');
 await page.getByLabel('API Key',{exact:true}).fill('synthetic-browser-key');await page.getByRole('button',{name:'保存配置',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
 await page.getByRole('button',{name:'添加模型',exact:true}).click();
 assert.equal(await page.getByLabel('总上下文 tokens',{exact:true}).inputValue(),'');
 await page.getByLabel('所属服务',{exact:true}).selectOption({label:'容量核对服务'});
 await page.getByLabel('Model ID',{exact:true}).fill('deepseek-unknown');
 assert.equal(await page.getByRole('button',{name:'填入 DeepSeek Flash 已核对初值（1M 窗口）',exact:true}).count(),0);
 assert.equal(await page.getByLabel('总上下文 tokens',{exact:true}).inputValue(),'');
 await page.getByLabel('Model ID',{exact:true}).fill('deepseek-flash');
 await page.getByRole('button',{name:'填入 DeepSeek Flash 已核对初值（1M 窗口）',exact:true}).click();
 assert.equal(await page.getByLabel('总上下文 tokens',{exact:true}).inputValue(),'1000000');
 await page.getByLabel('展示名称',{exact:true}).fill('容量范围合成反例');
 await page.getByLabel('最大输入 tokens',{exact:true}).fill('65536');
 await page.getByRole('button',{name:'保存配置',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'194763–934464 tokens'}).waitFor();
 assert.ok((await page.getByRole('alert').allTextContents()).some(text=>text.includes('1–21503 tokens')));
 await page.screenshot({path:directory+'/capacity-ranges.png',fullPage:true});
 await page.getByRole('button',{name:'取消',exact:true}).click();await page.getByRole('button',{name:'放弃修改',exact:true}).click();
 await page.getByRole('button',{name:'添加模型',exact:true}).click();
 assert.equal(await page.getByLabel('总上下文 tokens',{exact:true}).inputValue(),'');
 await page.getByLabel('所属服务',{exact:true}).selectOption({label:'浏览器合成服务'});await page.getByLabel('Model ID',{exact:true}).fill('synthetic/browser-model');await page.getByLabel('展示名称',{exact:true}).fill('浏览器合成模型');await page.getByLabel('输入价格',{exact:true}).fill('1.25');await page.getByLabel('输出价格',{exact:true}).fill('5');await page.getByRole('button',{name:'保存配置',exact:true}).click();assert.ok(await page.getByLabel('总上下文 tokens',{exact:true}).evaluate(input=>input.validity.valueMissing));assert.equal((await config()).models.some(m=>m.model_id==='synthetic/browser-model'),false);await page.getByLabel('总上下文 tokens',{exact:true}).fill('160000');await page.getByRole('button',{name:'保存配置',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
 checks.push('未知型号不猜总窗口且缺失时禁止保存；仅已核实的DeepSeek Flash可显式预填1M');
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
 await page.getByRole('button',{name:'编辑服务 OpenAI 合成服务',exact:true}).click();
 await addressField.fill(provider.url+'/openai/v1');await page.getByLabel('API Key',{exact:true}).fill('synthetic-openai-local-key');
 await page.getByRole('button',{name:'保存配置',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
 const localOpenaiService=(await config()).services.find(s=>s.id===openaiService.id);
 assert.equal(localOpenaiService.base_url,provider.url+'/openai/v1');assert.equal(localOpenaiService.api,'openai-responses');assert.notEqual(localOpenaiService.version,openaiService.version);
 const publicOpenaiCatalog=ok(await h.request('/models',undefined,'bob'));validateContract('ModelCatalog',publicOpenaiCatalog);
 assert.deepEqual(publicOpenaiCatalog.models.find(m=>m.id===openaiModel.id).thinking_options.map(option=>option.value),['low','medium','high','xhigh','max']);
 assert.ok(!JSON.stringify(publicOpenaiCatalog).includes('api_key'));assert.ok(!JSON.stringify(publicOpenaiCatalog).includes('api.openai.com'));assert.ok(!JSON.stringify(publicOpenaiCatalog).includes(provider.url));
 ordinary.on('pageerror',e=>errors.push(e.message));await ordinary.goto(h.url);
 await ordinary.getByLabel('模型',{exact:true}).selectOption(openaiModel.id);await ordinary.getByLabel('思考强度',{exact:true}).selectOption('high');
 const openaiNativeStart=provider.requests.length,reasoningStart=provider.reasoningItems.length,openaiMessages=[],nativeSessions=[];let openaiCid;
 assert.equal(openaiNativeStart,browserRequestCount,'官方地址的管理操作未发送任何模型请求');
 provider.setReasoning(true);
 try {
  await h.resumeWorker();
  for(const [index,text] of ['合成OpenAI模型管理验收，请调用工具后续答。','继续刚才的合成对话，再调用工具后续答。'].entries()){
   const response=ordinary.waitForResponse(r=>/\/conversations\/[^/]+\/messages$/.test(new URL(r.url()).pathname)&&r.request().method()==='POST');
   await ordinary.getByLabel('你的数据问题').fill(text);await ordinary.getByRole('button',{name:'发送 ↑',exact:true}).click();
   const accepted=await response,receipt=ok({status:accepted.status(),value:await accepted.json()});
   assert.deepEqual(accepted.request().postDataJSON().model_selection,{model_id:openaiModel.id,thinking_level:'high'});
   const selectedCid=new URL(accepted.url()).pathname.match(/\/conversations\/([^/]+)\/messages$/)[1];if(openaiCid)assert.equal(selectedCid,openaiCid);else openaiCid=selectedCid;
   await h.finished(openaiCid,index+1,'bob');
   const selection=ok(await h.request('/conversations/'+openaiCid+'/model-selection',undefined,'bob'));validateContract('ConversationModelSelection',selection);assert.deepEqual(selection.selection,{model_id:openaiModel.id,thinking_level:'high'});
   const frozen=h.sql(`SELECT JSON_OBJECT('profile',model_profile,'calls',issued_calls,'limit',call_limit) FROM budget_scopes WHERE message_id='${receipt.message_id}'`)[0];
   for(const [field,value] of Object.entries({provider_id:'openai',model_id:'gpt-6.1-sol',thinking_level:'high',context_window:1050000,input_limit:900000,output_limit:128000,payload_bytes_limit:8388608,request_timeout_ms:600000,capability_source:'admin_declared'}))assert.equal(frozen.profile[field],value,'新消息冻结字段 '+field);
   assert.deepEqual(frozen.profile.configured_model,{id:openaiModel.id,version:openaiModel.version,service_id:openaiService.id,service_version:localOpenaiService.version,api:'openai-responses',input_rate:'5000000',output_rate:'15000000',reasoning_supported:true});assert.equal(frozen.calls,2);assert.equal(frozen.limit,null);
   const checkpoints=h.sql(`SELECT JSON_OBJECT('checkpoint',checkpoint) FROM pi_checkpoints WHERE recovery_chain_id IN (SELECT recovery_chain_id FROM agent_runs WHERE message_id='${receipt.message_id}')`);assert.equal(checkpoints.length,1);nativeSessions.push(restoreCheckpoint('/synthetic/data-agent',checkpoints[0].checkpoint));
   openaiMessages.push({message_id:receipt.message_id,selection:selection.selection,frozen});
  }
 } finally {await h.pauseWorker();provider.setReasoning(false);}
 const openaiCalls=provider.requests.slice(openaiNativeStart),reasoningItems=provider.reasoningItems.slice(reasoningStart);
 assert.equal(openaiCalls.length,4);assert.equal(reasoningItems.length,4);assert.ok(openaiCalls.every(call=>call.path==='/openai/v1/responses'&&call.key==='Bearer synthetic-openai-local-key'));
 for(const {body} of openaiCalls){
  assert.equal(body.model,'gpt-6.1-sol');assert.equal(body.max_output_tokens,128000);assert.equal(body.store,false);assert.equal(body.reasoning.effort,'medium');
  assert.equal(body.input.filter(item=>item.type==='configuration_update').at(-1).reasoning.effort,'high','有效high沿原生configuration_update传递');
  const declaredTools=[...(body.tools??[]),...body.input.flatMap(item=>item.type==='additional_tools'?item.tools:[])];
  assert.ok(declaredTools.length>0,'真实工具声明不能因协议投影位置变化丢失');
  assert.ok(declaredTools.every(tool=>tool.strict===false&&!tool.name.startsWith('__pi_')));
 }
 for(const [requestIndex,reasoningIndex] of [[1,0],[2,0],[3,2]])assert.deepEqual(openaiCalls[requestIndex].body.input.find(item=>item.type==='reasoning'&&item.id===reasoningItems[reasoningIndex].id),reasoningItems[reasoningIndex],'工具续答和同服务下一条消息保留原生reasoning关联');
 const openaiTools=h.sql(`SELECT JSON_OBJECT('sdk',sdk_tool_call_id,'state',state) FROM tool_calls WHERE conversation_id='${openaiCid}'`);assert.equal(openaiTools.length,2);assert.ok(openaiTools.every(tool=>tool.state==='succeeded'));
 for(const tool of openaiTools)assert.ok(openaiCalls.some(call=>call.body.input.some(item=>item.type==='function_call_output'&&item.call_id===tool.sdk.split('|')[0])),'真实工具回执使用原call_id');
 assert.equal(new Set(nativeSessions.map(session=>session.getSessionId())).size,1,'后续消息沿同一Pi会话');
 const nativeMessages=nativeSessions.at(-1).getBranch().filter(entry=>entry.type==='message'&&entry.message.role==='assistant'&&entry.message.model==='gpt-6.1-sol').map(entry=>entry.message);
 assert.equal(nativeMessages.length,4);assert.ok(nativeMessages.every(message=>message.providerThinkingLevel==='high'&&message.api==='openai-responses'));
 for(const message of nativeMessages)assert.deepEqual({input:message.usage.input,cacheRead:message.usage.cacheRead,output:message.usage.output,total:message.usage.totalTokens},{input:80,cacheRead:20,output:25,total:125},'缓存包含在100输入内，10推理tokens包含在25输出内');
 const openaiAttempts=h.sql(`SELECT JSON_OBJECT('state',state,'usage',usage_json,'actual',CAST(actual_micros AS CHAR)) FROM model_call_attempts WHERE run_id IN (SELECT id FROM agent_runs WHERE conversation_id='${openaiCid}')`);assert.equal(openaiAttempts.length,4);assert.ok(openaiAttempts.every(attempt=>attempt.state==='settled'&&attempt.usage.input_tokens===100&&attempt.usage.output_tokens===25&&attempt.actual==='875'));
 assert.equal((await config()).default_model_id,browserModel.id);assert.ok(!JSON.stringify(await h.snapshot(openaiCid,'bob')).includes('synthetic-openai-'));
 await ordinary.reload();await until(async()=>!await ordinary.getByLabel('模型',{exact:true}).isDisabled()&&await ordinary.getByLabel('模型',{exact:true}).inputValue()===openaiModel.id,'普通对话刷新后保留OpenAI选择');assert.equal(await ordinary.getByLabel('思考强度',{exact:true}).inputValue(),'high');
 await ordinary.screenshot({path:directory+'/openai-selection.png',fullPage:true,animations:'disabled'});
 await writeFile(directory+'/openai-configuration.json',JSON.stringify({officialService:openaiService,localService:localOpenaiService,model:openaiModel,messages:openaiMessages,reasoningItems,tools:openaiTools,nativeUsage:nativeMessages.map(message=>({providerThinkingLevel:message.providerThinkingLevel,usage:message.usage})),attempts:openaiAttempts,officialRequests:0},null,2));
 checks.push('普通用户显式选用gpt-6.1-sol/high并刷新保留；同一已保存服务修订到合成端点后，真实Pi完成两次原生工具往返并保留call_id、reasoning/会话/high；100输入含缓存20、25输出含推理10按原费率结算，无累计调用上限和空间默认保持，官方请求0');
 assert.deepEqual(errors,[]);await h.close();closed=true;
 checks.push(await checkConfiguredRecovery(provider));passed=true;
} finally {
 if(!passed&&page){await page.screenshot({path:directory+'/failure.png',fullPage:true}).catch(()=>{});await writeFile(directory+'/failure-dom.txt',await page.locator('body').innerText().catch(()=>''));}
 await writeFile(directory+'/protocol-trace.json',JSON.stringify(provider.requests.map(({path,body})=>({path,body})),null,2));
 if(browser)await browser.close();if(!closed)await h.close();await provider.close();
 await writeFile(directory+'/report.json',JSON.stringify({passed,checks,errors,providerErrors:provider.errors,requests:provider.requests.length,officialRequests:0},null,2));
 console.log(JSON.stringify({passed,checks,errors,requests:provider.requests.length,officialRequests:0}));
}

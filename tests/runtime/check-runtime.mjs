import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import net from 'node:net';
import {chromium} from 'playwright';
import {validateContract} from '../../packages/contracts/validate.ts';

const root=process.cwd();const sandbox=root+'/.local/checks';await mkdir(sandbox,{recursive:true});
const container=execFileSync('docker',['--context','colima-data-agent','ps','--filter','label=com.docker.compose.project=data-agent','--filter','label=com.docker.compose.service=mysql','--format','{{.ID}}'],{encoding:'utf8'}).trim();
assert.ok(/^[a-f0-9]+$/.test(container),'专用MySQL未运行');
const database='data_agent_test_'+randomBytes(8).toString('hex');
function sql(query){return execFileSync('docker',['--context','colima-data-agent','exec','-i',container,'mysql','--defaults-extra-file=/run/secrets/mysql_root_client','--batch','--skip-column-names'],{input:query,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();}
function data(query){const value=sql('USE '+database+'; '+query);return value?value.split('\n').map(v=>JSON.parse(v)):[];}
const port=()=>new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>resolve(p));});});
const apiPort=await port(),bridgePort=await port(),webPort=await port();
const alice=randomBytes(32).toString('hex'),bob=randomBytes(32).toString('hex'),internal=randomBytes(32).toString('hex');
const password=(await readFile(root+'/.local/infra/mysql-app-password','utf8')).trim();
const env={...process.env,PI_OFFLINE:'1',DATA_AGENT_MODE:'development',DATA_AGENT_DATABASE_URL:'mysql://data_agent:'+encodeURIComponent(password)+'@127.0.0.1:13306/'+database,DATA_AGENT_DEV_IDENTITIES:JSON.stringify({[alice]:'alice',[bob]:'bob'}),DATA_AGENT_INTERNAL_TOKEN:internal,DATA_AGENT_API_PORT:String(apiPort),DATA_AGENT_API_URL:'http://127.0.0.1:'+apiPort,DATA_AGENT_BRIDGE_URL:'http://127.0.0.1:'+bridgePort,DATA_AGENT_BRIDGE_PORT:String(bridgePort),DATA_AGENT_LEASE_MS:'1500'};
const processes=[];const logs=[];const checks=[];
function start(name,command,args=[],extra={}){
 const child=spawn(command,args,{cwd:root,env:{...env,...extra},stdio:['ignore','pipe','pipe']});processes.push(child);const record={name,code:null,output:''};logs.push(record);
 child.stdout.on('data',v=>{record.output+=v;});child.stderr.on('data',v=>{record.output+=v;});
 child.on('exit',code=>{record.code=code;});return child;
}
async function stop(child){if(!child||child.exitCode!==null||child.signalCode!==null)return;child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,2000))]);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await new Promise(resolve=>child.once('exit',resolve));}}
async function until(action,label,timeout=10000){const end=Date.now()+timeout;while(Date.now()<end){const value=await action();if(value)return value;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('timeout: '+label);}
async function healthy(p){await until(async()=>{try{return(await fetch('http://127.0.0.1:'+p+'/health')).ok;}catch{return false;}},'health '+p,20000);}
async function request(path,body,token=alice,method=body?'POST':'GET'){
 const response=await fetch(env.DATA_AGENT_API_URL+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 const text=await response.text();return {status:response.status,value:text?JSON.parse(text):null};
}
async function create(){const result=await request('/conversations',{operation_id:randomUUID()});assert.equal(result.status,200);return result.value.conversation_id;}
async function snapshot(cid){const result=await request('/conversations/'+cid+'/snapshot');assert.equal(result.status,200);validateContract('Snapshot',result.value);return result.value;}
async function finished(cid){return until(async()=>{const s=await snapshot(cid);return s.runs.some(r=>r.state==='finished')?s:false;},'finished '+cid,15000);}
function counts(cid){return data(`SELECT JSON_OBJECT('tasks',(SELECT COUNT(*) FROM analysis_tasks WHERE conversation_id='${cid}'),'tools',(SELECT COUNT(*) FROM tool_calls WHERE conversation_id='${cid}'),'outputs',(SELECT COUNT(*) FROM agent_runs WHERE conversation_id='${cid}' AND state='finished'))`)[0];}
let browser;
try{
 sql('CREATE DATABASE '+database+'; GRANT ALL ON '+database+'.* TO data_agent;');
 if(process.argv.includes('--locking')){execFileSync(process.env.HOME+'/.cargo/bin/cargo',['test','--locked','-p','data-agent','locking_','--','--nocapture'],{env,cwd:root,stdio:['ignore','pipe','pipe']});checks.push({name:'锁内当前读取、事务快照归属、锁序及并发领取',passed:true});await writeFile(sandbox+'/runtime-locking.json',JSON.stringify({passed:true,checks},null,2)+'\n');console.log(JSON.stringify({passed:true,checks}));}else{
 const api=start('api','target/debug/data-agent-api');await healthy(apiPort);
 let bridge,worker;
 if(!process.argv.includes('--recovery')){
 bridge=start('bridge','node',['apps/agent/server.ts']);await healthy(bridgePort);
 worker=start('worker','target/debug/data-agent-worker');
 const cid=await create();const message={client_message_id:randomUUID(),text:'分析合成订单近七天的退款情况'};
 const accepted=await request('/conversations/'+cid+'/messages',message);assert.equal(accepted.status,200);
 const complete=await finished(cid);validateContract('MessageReceipt',accepted.value);
 assert.ok(logs.find(l=>l.name==='api').output.includes('tool_committed request='+accepted.value.request_id));
 assert.ok(logs.find(l=>l.name==='worker').output.includes('run_started request='+accepted.value.request_id));
 assert.deepEqual(counts(cid),{tasks:1,tools:1,outputs:1});assert.equal(complete.tasks[0].goal,message.text);
 assert.equal(complete.messages.filter(m=>m.role==='assistant'&&m.committed).length,1);
 const repeated=await request('/conversations/'+cid+'/messages',message);assert.deepEqual(repeated.value,accepted.value);
 assert.equal((await request('/conversations/'+cid+'/messages',{...message,text:'不同内容'})).status,409);
 assert.equal((await request('/conversations/'+cid+'/snapshot',undefined,bob)).status,404);
 assert.equal((await request('/conversations/'+cid+'/messages',{client_message_id:randomUUID(),text:'冒用'},bob)).status,404);
 assert.equal((await request('/conversations/'+cid+'/messages',{client_message_id:randomUUID(),text:'冒用',user_id:'bob'})).status,400);
 assert.equal((await request('/conversations',undefined,bob)).value.conversations.length,0);
 assert.equal((await request('/internal/outputs',{run_id:complete.runs[0].run_id,lease_epoch:complete.runs[0].lease_epoch,chunk_seq:'2',text:'late'},alice)).status,401);
 const stream=await fetch(env.DATA_AGENT_API_URL+'/conversations/'+cid+'/events?after_seq=0',{headers:{authorization:'Bearer '+alice}});assert.equal(stream.headers.get('content-type'),'text/event-stream');const events=await stream.text();assert.match(events,/assistant_committed/);
 checks.push({name:'真实Pi工具链、持久结果、重复消息、身份隔离和SSE',passed:true});
 const web=start('web','node',['node_modules/vite/bin/vite.js','apps/web','--config','apps/web/vite.config.ts','--port',String(webPort)]);await until(async()=>{try{return(await fetch('http://127.0.0.1:'+webPort)).ok;}catch{return false;}},'web');
 browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:'+webPort);await page.getByLabel('演示登录凭据').fill(alice);await page.getByRole('button',{name:'进入工作台 →'}).click();await page.getByRole('navigation',{name:'会话历史'}).getByRole('button',{name:message.text,exact:false}).click();await page.getByText(message.text,{exact:true}).first().waitFor();
 const browserMessage='比较合成订单本月和上月的退款率';
 await page.getByLabel('你的数据问题').fill(browserMessage);await page.getByRole('button',{name:'发送 ↑'}).click();
 const browserResult=await until(async()=>{const result=await snapshot(cid);return result.tasks.length===2&&result.runs.filter(r=>r.state==='finished').length===2?result:false;},'React提交到持久结果',15000);
 assert.equal(browserResult.tasks[1].goal===browserMessage||browserResult.tasks[0].goal===browserMessage,true);assert.deepEqual(counts(cid),{tasks:2,tools:2,outputs:2});
 await page.getByText(browserMessage,{exact:true}).last().waitFor();await page.reload();await page.getByRole('region',{name:'已保存的任务'}).waitFor();
 assert.equal(await page.getByText(complete.tasks[0].id,{exact:false}).count(),2);
 await page.getByRole('button',{name:'新对话',exact:true}).click();
 const newQuestion='建立一个合成客户复购分析目标';await page.getByLabel('你的数据问题').fill(newQuestion);await page.getByRole('button',{name:'发送 ↑'}).click();
 const newCid=await until(()=>page.evaluate(()=>localStorage.getItem('data-agent.conversation.alice')) .then(value=>value&&value!==cid?value:false),'React创建会话');
 const newResult=await finished(newCid);assert.equal(newResult.tasks[0].goal,newQuestion);assert.deepEqual(counts(newCid),{tasks:1,tools:1,outputs:1});
 await page.getByText(newResult.tasks[0].id,{exact:false}).first().waitFor();await page.reload();await page.getByText(newQuestion,{exact:true}).last().waitFor();
 await page.screenshot({path:sandbox+'/workbench-desktop.png',fullPage:true});await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:sandbox+'/workbench-mobile.png',fullPage:true});assert.deepEqual(errors,[]);
 await context.close();await browser.close();browser=undefined;await stop(web);checks.push({name:'React实际提交、Pi工具执行、持久结果、刷新回看和390px布局',passed:true});
 await stop(worker);await stop(bridge);
 }
 if(!process.argv.includes('--flow')){
 for(const [fault,expectedCode,preTasks] of [['before_business_commit',73,0],['after_business_commit',74,1],['before_checkpoint_commit',75,1]]){
  bridge=start('fault_'+fault,'node',['apps/agent/server.ts'],{DATA_AGENT_FAULT:fault});await healthy(bridgePort);worker=start('worker_fault','target/debug/data-agent-worker');
  const conversation=await create();const submitted=await request('/conversations/'+conversation+'/messages',{client_message_id:randomUUID(),text:'分析虚构订单的销售情况'});assert.equal(submitted.status,200);
  await until(()=>bridge.exitCode!==null,'actual process exit');assert.equal(bridge.exitCode,expectedCode);await stop(worker);
  assert.deepEqual(counts(conversation),{tasks:preTasks,tools:1,outputs:0});
  const before=data(`SELECT JSON_OBJECT('operation_id',operation_id,'origin_run_id',origin_run_id,'sdk_tool_call_id',sdk_tool_call_id) FROM tool_calls WHERE conversation_id='${conversation}'`)[0];
  const old=(await snapshot(conversation)).runs[0];
  bridge=start('recovery_bridge','node',['apps/agent/server.ts']);await healthy(bridgePort);worker=start('recovery_worker','target/debug/data-agent-worker');
  const recovered=await finished(conversation);assert.equal(recovered.runs.length,2);assert.notEqual(recovered.runs[1].run_id,old.run_id);assert.deepEqual(counts(conversation),{tasks:1,tools:1,outputs:1});
  const after=data(`SELECT JSON_OBJECT('operation_id',operation_id,'origin_run_id',origin_run_id,'sdk_tool_call_id',sdk_tool_call_id) FROM tool_calls WHERE conversation_id='${conversation}'`)[0];assert.deepEqual(after,before);
  assert.equal((await request('/internal/outputs',{run_id:old.run_id,lease_epoch:old.lease_epoch,chunk_seq:'1',text:'旧运行晚到'},internal)).status,409);
  assert.ok(logs.find(l=>l.name==='api').output.includes('tool_committed request='+submitted.value.request_id));
  assert.equal(recovered.messages.filter(m=>m.role==='assistant'&&m.committed).length,1);
  assert.equal(new Set(recovered.runs.map(r=>r.lease_epoch)).size,2);
  assert.equal(data(`SELECT JSON_OBJECT('scopes',COUNT(DISTINCT budget_scope_id),'chains',COUNT(DISTINCT recovery_chain_id)) FROM agent_runs WHERE conversation_id='${conversation}'`)[0].scopes,1);
  checks.push({name:fault,passed:true,actualProcessExit:expectedCode,stableOperation:true});await stop(worker);await stop(bridge);
 }
 }
 if(!process.argv.includes('--recovery')){
 bridge=start('slow_bridge','node',['apps/agent/server.ts'],{DATA_AGENT_MOCK_DELAY_MS:'2200'});await healthy(bridgePort);
 worker=start('serial_worker','target/debug/data-agent-worker');const otherWorker=start('second_worker','target/debug/data-agent-worker');
 const busyCid=await create();const busyFirst=await request('/conversations/'+busyCid+'/messages',{client_message_id:randomUUID(),text:'先分析合成订单'});
 await until(async()=>(await snapshot(busyCid)).runs.length===1,'first turn acquired');
 const busySecond=await request('/conversations/'+busyCid+'/messages',{client_message_id:randomUUID(),text:'再分析合成退款'});
 const queued=data(`SELECT JSON_OBJECT('state',state,'attempts',attempts) FROM background_jobs WHERE message_id='${busySecond.value.message_id}'`)[0];assert.equal(queued.state,'queued','前一条未结束时，后续输入留在队列');
 assert.equal(data(`SELECT JSON_OBJECT('attempts',attempts) FROM background_jobs WHERE message_id='${busySecond.value.message_id}'`)[0].attempts,0);
 await until(async()=>{const s=await snapshot(busyCid);return s.runs.filter(r=>r.state==='finished').length===2;},'two serial turns',20000);
 assert.deepEqual(counts(busyCid),{tasks:2,tools:2,outputs:2});assert.equal(data(`SELECT JSON_OBJECT('attempts',attempts) FROM background_jobs WHERE message_id='${busyFirst.value.message_id}'`)[0].attempts,1);
 await stop(worker);await stop(otherWorker);await stop(bridge);checks.push({name:'两个Worker串行推进同会话，会话忙不消耗交付次数',passed:true});
 bridge=start('failure_recovery_bridge','node',['apps/agent/server.ts']);await healthy(bridgePort);await stop(bridge);
 worker=start('exhausted_worker','target/debug/data-agent-worker');
 const failedCid=await create();await request('/conversations/'+failedCid+'/messages',{client_message_id:randomUUID(),text:'验证交付失败可见状态'});
 const failed=await until(async()=>{const s=await snapshot(failedCid);return s.runs.length===4&&s.runs.every(r=>r.state==='failed')?s:false;},'bounded retry exhaustion',15000);
 assert.ok(failed.events.some(e=>e.type==='run_failed'));assert.deepEqual(counts(failedCid),{tasks:0,tools:0,outputs:0});
 assert.equal(data(`SELECT JSON_OBJECT('state',state,'attempts',attempts) FROM background_jobs WHERE conversation_id='${failedCid}'`)[0].state,'failed');
 await stop(worker);checks.push({name:'真实交付连续失败后明确终止，页面可读失败状态',passed:true});
 }
 const mode=process.argv.includes('--flow')?'flow':process.argv.includes('--recovery')?'recovery':'all';
 const report={passed:true,checks,provider:'local_mock',piSdk:'1.0.0',mysql:'real local MySQL',limits:'不证明DeepSeek或真实平台能力',logs};await writeFile(sandbox+'/runtime-'+mode+'.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({passed:true,checks}));
}
}catch(error){await writeFile(sandbox+'/runtime-failure.json',JSON.stringify({error:String(error),checks,logs},null,2));throw error;}
finally{if(browser)await browser.close();for(const child of processes.reverse())await stop(child);sql('DROP DATABASE IF EXISTS '+database+';');}

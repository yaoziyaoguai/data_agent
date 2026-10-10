// 真实启动器上的固定合成试用；失败保留，不为分数补跑。独立答案只在验收端读取。
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {until} from './harness.mjs';

const directory=process.argv[process.argv.indexOf('--directory')+1];
assert.ok(directory?.startsWith('.local/'));
const stage=process.argv.includes('--pilot')?'pilot':process.argv.includes('--collect-pilot')?'collect-pilot':'cases';
const config=JSON.parse(await readFile(directory+'/configuration.json','utf8'));
const tokens=JSON.parse(await readFile(directory+'/runtime/identities.json','utf8'));
const apiUrl='http://127.0.0.1:29780',webUrl='http://127.0.0.1:26173';
const reportName=process.argv.includes('--report')?process.argv[process.argv.indexOf('--report')+1]:'result.json';
assert.match(reportName,/^[a-z0-9-]+\.json$/);
const reportPath=directory+'/'+reportName;
const sourceHashes=()=>JSON.parse(execFileSync('python3',['-c',"import pathlib,hashlib,json; names=['apps','crates/data-agent','packages/contracts','migrations','scripts/evaluate_business_sql.py','docs/sources']; files=[f for n in names for f in ([pathlib.Path(n)] if pathlib.Path(n).is_file() else pathlib.Path(n).rglob('*')) if f.is_file() and '__pycache__' not in f.parts];print(json.dumps({str(f):hashlib.sha256(f.read_bytes()).hexdigest() for f in sorted(files)}))"],{encoding:'utf8'}));
const definitions=[
 ['remember','混合默认偏好：原始消息提取与正式保存'],
 ['reuse_execute','跨会话复用；临时渠道修订；确认执行与结果解释'],
 ['replace','修订已有默认；跨会话采用新版本'],
 ['disable','停用后沿用公共范围，多轮继续另一指标'],
 ['other_user','另一用户不采用Alice偏好'],
 ['correction','可复用纠错；下次按整月去重生成SQL'],
];
let report;
try{report=JSON.parse(await readFile(reportPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;report={evidenceKind:'official_flash_mem0',definitions,checks:[],startedAt:new Date().toISOString(),qualityReview:'pending',profile:config.profile,sourceHashes:sourceHashes()};}
const save=async()=>writeFile(reportPath,JSON.stringify(report,null,2),{mode:0o600});
const request=async(path,body,user='alice')=>{const r=await fetch(apiUrl+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+tokens[user],'content-type':'application/json'},body:body?JSON.stringify(body):undefined});const value=await r.json();assert.equal(r.status,200,path+': '+JSON.stringify(value));return value;};
const snapshot=cid=>request('/conversations/'+cid+'/snapshot');
const create=async(user='alice')=>(await request('/conversations',{operation_id:randomUUID()},user)).conversation_id;
let active;
const ask=async(cid,text,user='alice')=>{
 const row={text,conversation_id:cid,user,startedAt:new Date().toISOString()};active.messages.push(row);await save();
 row.before_run_ids=(await request('/conversations/'+cid+'/snapshot',undefined,user)).runs.map(v=>v.run_id);
 const message=await request('/conversations/'+cid+'/messages',{client_message_id:randomUUID(),text},user);row.message_id=message.message_id;await save();
 const result=await until(async()=>{
  const state=await request('/conversations/'+cid+'/snapshot',undefined,user);
  const runs=state.runs.filter(r=>!row.before_run_ids.includes(r.run_id));
  if(runs.length&&runs.every(r=>['failed','cancelled','finished'].includes(r.state)))return state;
  return false;
 },'official message '+message.message_id,600000);
 row.snapshot=result;row.queries=(await request('/conversations/'+cid+'/queries',undefined,user)).queries;row.assets=(await request('/assets',undefined,user)).assets;row.completedAt=new Date().toISOString();await save();return row;
};
const sqlCheck=(row,caseId,channel=null)=>{
 const query=row.queries.at(-1);assert.ok(query,'未产生SQL草稿');
 const input={case_id:caseId,channel,sql:query.sql,parameters:query.parameters};
 const result=JSON.parse(execFileSync('python3',['scripts/evaluate_business_sql.py'],{input:JSON.stringify(input),encoding:'utf8'}));
 active.sqlChecks.push({query_id:query.id,...result});return query;
};
const attempt=async(id,fn)=>{
 assert.ok(!report.checks.some(v=>v.id===id),'拒绝重做已开始场景');
 active={id,title:definitions.find(v=>v[0]===id)[1],messages:[],sqlChecks:[],state:'started'};report.checks.push(active);await save();
 try{await fn();active.state='completed';}catch(e){active.state='failed';active.error=e.message;}
 active.endedAt=new Date().toISOString();await save();console.log(JSON.stringify({id,state:active.state,error:active.error,sql:active.sqlChecks.map(v=>v.passed)}));
};

if(stage==='collect-pilot'){
 active=report.checks.find(v=>v.id==='remember');assert.equal(active?.state,'started');
 const row=active.messages[0];assert.ok(row.message_id);
 row.snapshot=await snapshot(row.conversation_id);assert.ok(row.snapshot.runs.length&&row.snapshot.runs.every(v=>['finished','failed','cancelled'].includes(v.state)));
 row.queries=(await request('/conversations/'+row.conversation_id+'/queries')).queries;row.assets=(await request('/assets')).assets;row.completedAt=new Date().toISOString();
 active.assets=row.assets;active.state=row.assets.some(v=>v.memory_index_state==='indexed')?'completed':'failed';
 active.collectorRepair='采集器原先读取了Snapshot.runs不存在的message_id；只采集已完成的同一条消息，没有重发或补跑。';
 await save();
}else if(stage==='pilot'){
 await attempt('remember',async()=>{
  const cid=await create();report.memoryConversation=cid;
  const row=await ask(cid,'请记住：以后我的订单收入分析默认只看web渠道，金额以元展示；这只是我个人的默认习惯，临时要求优先，不修改公共口径。现在先不用查数据。');
  assert.ok(row.assets.length>0,'未保存正式记忆');
  await until(async()=>{const items=(await request('/assets')).assets;return items.length>0&&items.every(v=>v.memory_index_state==='indexed')},'真实Mem0索引提交',120000);
  active.assets=(await request('/assets')).assets;
 });
}else{
 assert.equal(report.checks.find(v=>v.id==='remember')?.state,'completed','先完成代表性接入小样');
 await attempt('reuse_execute',async()=>{
  const cid=await create();report.queryConversation=cid;
  const first=await ask(cid,'请算2026年1月净收入，沿用我的默认习惯，先给SQL。');sqlCheck(first,'net_revenue_scope','web');
  const revised=await ask(cid,'这次改成app渠道，其他条件不变，记忆里的默认不要改。请修改刚才的SQL。');
  const query=sqlCheck(revised,'net_revenue_scope','app');
  const browser=await chromium.launch();
  try{
   const page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});
   await page.goto(webUrl);await page.getByLabel('演示登录凭据').fill(tokens.alice);await page.getByRole('button',{name:'进入工作台 →',exact:true}).click();
   await page.getByRole('button',{name:/查看全部会话/}).click();
   await page.getByRole('dialog').getByRole('button',{name:/请算2026年1月净收入/}).first().click();
   await page.getByLabel('你的数据问题').fill('执行上面这条');
   await page.getByRole('button',{name:'发送 ↑',exact:true}).click();
   await page.getByRole('table').waitFor();
   await page.screenshot({path:directory+'/real-query.png',fullPage:true});
   active.result=await request('/queries/'+query.id+'/results');
   await until(async()=>{const s=await snapshot(cid);return s.runs.length>revised.snapshot.runs.length&&s.runs.every(v=>['finished','failed','cancelled'].includes(v.state))},'真实结果解释',240000);
   active.afterExecution=await snapshot(cid);
  }finally{await browser.close();}
 });
 await attempt('replace',async()=>{
  const cid=await create();
  await ask(cid,'把我以前的收入默认渠道改为store，替换原web默认，金额仍然用元。请记住这个修改，临时请求仍优先。这次不取数。');
  const next=await create();const row=await ask(next,'继续按我的默认习惯，给出2026年1月净收入SQL。');sqlCheck(row,'net_revenue_scope','store');
 });
 await attempt('disable',async()=>{
  active.before=(await request('/assets')).assets;
  for(const asset of active.before.filter(v=>v.kind==='memory'&&v.state==='enabled'))await request('/assets/'+asset.id+'/disable',{operation_id:randomUUID(),expected_version:asset.version});
  const cid=await create();const row=await ask(cid,'按当前有效口径给2026年1月净收入SQL。已有默认请沿用；没有默认则取所有渠道，以分计价。');sqlCheck(row,'net_revenue_scope');
  const follow=await ask(cid,'同一个月支付客户有多少？这是另一个指标，查整个月的所有渠道，不要把每日客户数直接相加。先给SQL。');sqlCheck(follow,'Q02');
 });
 await attempt('other_user',async()=>{
  const cid=await create('bob');const row=await ask(cid,'我以前设置过哪些渠道或金额单位偏好？没有就不要猜。请给2026年1月净收入SQL，按文档基础口径，以分展示。','bob');sqlCheck(row,'net_revenue_scope');assert.deepEqual(row.assets,[]);
 });
 await attempt('correction',async()=>{
  const cid=await create();await ask(cid,'请记住：我检查月支付客户数时，需要按整个月的客户去重，不能直接累加每日去重人数。这是我的可复用检查提醒，具体业务口径仍然查正式文档；现在不取数。');
  const next=await create();const row=await ask(next,'请按正式定义给出2026年1月支付客户数的SQL，注意我的检查提醒。');sqlCheck(row,'Q02');
 });
}
const container=execFileSync('docker',['--context','colima-data-agent','ps','--filter','label=com.docker.compose.project=data-agent','--filter','label=com.docker.compose.service=mysql','--format','{{.ID}}'],{encoding:'utf8'}).trim();
assert.match(container,/^[a-f0-9]+$/);assert.match(config.database,/^data_agent_trial_[a-f0-9]+$/);assert.match(config.profile.trial_id,/^[a-f0-9-]+$/);
const sql=`USE ${config.database};SELECT JSON_OBJECT('calls',allocated_calls,'spent_micros',spent_micros,'reserved_micros',reserved_micros,'state',state) FROM model_trials WHERE id='${config.profile.trial_id}';SELECT JSON_OBJECT('id',id,'purpose',purpose,'state',state,'operation_id',operation_id,'usage',usage_json,'price_version',price_version) FROM model_call_attempts;`;
const rows=execFileSync('docker',['--context','colima-data-agent','exec','-i',container,'mysql','--defaults-extra-file=/run/secrets/mysql_root_client','--batch','--raw','--skip-column-names'],{input:sql,encoding:'utf8'}).trim().split('\n').map(v=>JSON.parse(v));
report.ledger=rows.shift();report.calls=rows;report.lastUpdatedAt=new Date().toISOString();report.runnerHash=createHash('sha256').update(await readFile(import.meta.filename)).digest('hex');await save();
console.log(JSON.stringify({ledger:report.ledger,evidence:reportPath}));

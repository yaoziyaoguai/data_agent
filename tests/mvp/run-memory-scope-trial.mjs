// 固定真实回归单列证据；--audit只离线核对，不重发已开始的消息。
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {until} from './harness.mjs';

const directory='.local/mvp-closeout/trial';
const resultPath=directory+'/result.json';
const hash=value=>createHash('sha256').update(value).digest('hex');
const inputs=['apps/agent','apps/memory','crates/data-agent/src','packages/contracts','docs/sources','scripts/evaluate_business_sql.py','tests/mvp/run-memory-scope-trial.mjs'];
async function sourceHashes(){
 const out={};
 const walk=async p=>{
  let children;try{children=await readdir(p,{withFileTypes:true});}catch(e){if(e.code!=='ENOTDIR')throw e;out[p]=hash(await readFile(p));return;}
  for(const item of children.sort((a,b)=>a.name.localeCompare(b.name))){if(item.name==='__pycache__'||item.name==='node_modules')continue;assert.ok(!item.isSymbolicLink());await walk(p+'/'+item.name);}
 };
 for(const p of inputs)await walk(p);return out;
}
const messages=[
 {id:'save',text:'请记住：我检查月支付客户数时，需要按整个月的客户去重，不能直接累加每日去重人数。这是我的可复用检查提醒，具体业务口径仍然查正式文档；现在不取数。'},
 {id:'reuse',text:'请按正式定义给出2026年1月支付客户数的SQL，注意我的检查提醒。',sql:true},
 {id:'revise',text:'请修改之前保存的月支付客户数检查提醒：除了整月去重，再提醒我核对customer_id为空的处理；仍不能把每日去重人数相加。这只是个人检查事项，具体定义查正式文档，不新增其他指标。本次不查询。'},
 {id:'reuse_revised',text:'请按正式定义给出2026年1月支付客户数的SQL，注意我更新后的检查提醒。',sql:true},
];
function checkRow(row){
 assert.equal(row.state,'completed',row.id+': '+row.error);
 assert.ok(row.snapshot.runs.every(r=>r.state==='finished'),row.id+': unfinished run');
 const asset=row.assets.find(a=>a.state==='enabled'&&a.kind==='memory');assert.ok(asset);
 assert.equal(row.assets.filter(a=>a.state==='enabled'&&a.kind==='memory').length,1);
 assert.equal(asset.scope,asset.body);assert.equal(asset.name,[...asset.body].slice(0,40).join(''));
 assert.match(asset.body,/月支付客户数/);assert.doesNotMatch(asset.name+asset.body+asset.scope,/月活|\bMAU\b/i);
 const answers=row.snapshot.events.filter(e=>e.type==='assistant_committed').map(e=>e.payload.text).join('\n');
 assert.ok(answers.length);assert.doesNotMatch(answers,/月活|\bMAU\b/i);
 if(row.sqlCheck)assert.equal(row.sqlCheck.passed,true);
}
if(process.argv.includes('--audit')){
 const bytes=await readFile(resultPath),report=JSON.parse(bytes);
 assert.deepEqual(report.rows.map(r=>r.id),messages.map(r=>r.id));
 report.rows.forEach(checkRow);
 assert.equal(report.rows[2].assets[0].id,report.rows[0].assets[0].id);
 assert.ok(BigInt(report.rows[2].assets[0].version)>BigInt(report.rows[0].assets[0].version));
 assert.deepEqual(await sourceHashes(),report.sourceHashes);
 assert.equal(report.profile.model_id,'deepseek-flash');assert.equal(report.ledger.reserved_micros,0);
 assert.equal(report.calls.length,report.ledger.calls);assert.ok(report.calls.every(c=>c.state==='settled'&&c.usage));
 assert.ok(report.ledger.calls<=report.profile.trial_call_limit);assert.ok(BigInt(report.ledger.spent_micros)<=BigInt(report.profile.trial_cost_micros));
 const review=JSON.parse(await readFile(directory+'/quality-review.json'));
 assert.equal(review.evidence_sha256,hash(bytes));assert.equal(review.conclusion,'passed');
 assert.equal(hash(await readFile('.local/memory-adoption/trial/verified-result.json')),'c5a9309a5a8bdeb642cb9610341bafd7db22f77a672cc2e33c1752d21f7aab65');
 const result={passed:true,messages:4,sql:2,ledger:report.ledger,officialRequestsAdded:0,independentReview:directory+'/quality-review.json'};
 await writeFile('.local/checks/memory-scope-evidence.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}else{
 assert.ok(process.argv.includes('--run'),'显式--run才调用真实模型');
 const config=JSON.parse(await readFile(directory+'/configuration.json'));
 const tokens=JSON.parse(await readFile(directory+'/runtime/identities.json'));
 const request=async(path,body)=>{
  const response=await fetch('http://127.0.0.1:30780'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+tokens.alice,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
  const value=await response.json();assert.equal(response.status,200,path+': '+JSON.stringify(value));return value;
 };
 let report;try{report=JSON.parse(await readFile(resultPath));}catch(e){if(e.code!=='ENOENT')throw e;report={startedAt:new Date().toISOString(),profile:config.profile,sourceHashes:await sourceHashes(),rows:[]};}
 assert.deepEqual(await sourceHashes(),report.sourceHashes,'试用前后不改记忆实现或题目');
 const save=()=>writeFile(resultPath,JSON.stringify(report,null,2),{mode:0o600});
 const pending=process.argv.includes('--pilot')?messages.slice(0,1):messages.slice(1);
 if(!process.argv.includes('--pilot')){assert.equal(report.rows.length,1);checkRow(report.rows[0]);}
 for(const item of pending){
  assert.ok(!report.rows.some(r=>r.id===item.id),'拒绝重发已开始场景');
  const row={...item,state:'started',startedAt:new Date().toISOString()};report.rows.push(row);await save();
  try{
   row.conversation_id=item.id==='revise'?report.rows[0].conversation_id:(await request('/conversations',{operation_id:randomUUID()})).conversation_id;
   row.before_run_ids=(await request('/conversations/'+row.conversation_id+'/snapshot')).runs.map(r=>r.run_id);
   row.message_id=(await request('/conversations/'+row.conversation_id+'/messages',{client_message_id:randomUUID(),text:item.text})).message_id;await save();
   row.snapshot=await until(async()=>{const s=await request('/conversations/'+row.conversation_id+'/snapshot');const runs=s.runs.filter(r=>!row.before_run_ids.includes(r.run_id));return runs.length&&runs.every(r=>['finished','failed','cancelled'].includes(r.state))?s:false;},item.id,300000);
   row.assets=(await request('/assets')).assets;
   row.queries=(await request('/conversations/'+row.conversation_id+'/queries')).queries;
   if(item.sql){const query=row.queries.at(-1);assert.ok(query);row.sqlCheck=JSON.parse(execFileSync('python3',['scripts/evaluate_business_sql.py'],{input:JSON.stringify({case_id:'Q02',sql:query.sql,parameters:query.parameters}),encoding:'utf8'}));}
   await until(async()=>{const assets=(await request('/assets')).assets;return assets.length&&assets.every(a=>a.memory_index_state==='indexed')},'memory index',90000);
   row.assets=(await request('/assets')).assets;row.state='completed';checkRow(row);
  }catch(e){row.state='failed';row.error=e.message;}
  row.endedAt=new Date().toISOString();await save();console.log(JSON.stringify({id:row.id,state:row.state,error:row.error}));
  if(row.state!=='completed')break;
 }
 assert.match(config.database,/^data_agent_trial_[a-f0-9]+$/);
 const container=execFileSync('docker',['--context','colima-data-agent','ps','--filter','label=com.docker.compose.project=data-agent','--filter','label=com.docker.compose.service=mysql','--format','{{.ID}}'],{encoding:'utf8'}).trim();assert.match(container,/^[a-f0-9]+$/);
 const sql=`USE ${config.database};SELECT JSON_OBJECT('calls',allocated_calls,'spent_micros',spent_micros,'reserved_micros',reserved_micros,'state',state) FROM model_trials;SELECT JSON_OBJECT('id',id,'purpose',purpose,'state',state,'usage',usage_json) FROM model_call_attempts;`;
 const rows=execFileSync('docker',['--context','colima-data-agent','exec','-i',container,'mysql','--defaults-extra-file=/run/secrets/mysql_root_client','--batch','--raw','--skip-column-names'],{input:sql,encoding:'utf8'}).trim().split('\n').map(s=>JSON.parse(s));
 report.ledger=rows.shift();report.calls=rows;await save();
 if(report.rows.some(r=>r.state==='failed'))process.exitCode=1;
}

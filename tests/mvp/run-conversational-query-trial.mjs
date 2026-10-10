import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {deliver} from '../../apps/agent/session/deliver.ts';
import {harness,until} from './harness.mjs';
assert.ok(process.argv.includes('--run'),'真实模型试用需显式 --run；只发送合成材料');
const directory='.local/conversational-query/real-'+new Date().toISOString().replaceAll(/[:.]/g,'-');await mkdir(directory,{recursive:true,mode:0o700});
const profile={provider_id:'deepseek',model_id:'deepseek-flash',trial_id:randomUUID(),price_version:'2026-10-04-peak-usd',input_limit:65536,output_limit:8192,trial_call_limit:120,trial_cost_micros:'5000000',request_call_limit:24,toolset:'data',payload_bytes_limit:131072,thinking_level:'high'};
const entries=Object.fromEntries((await readFile('.env','utf8')).split(/\r?\n/).filter(l=>/^(DEEPSEEK_API_KEY|DEEPSEEK_BASE_URL|DEEPSEEK_MODEL)=/.test(l)).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1).trim()]}));
assert.ok(entries.DEEPSEEK_API_KEY);assert.equal(entries.DEEPSEEK_BASE_URL,'https://api.deepseek.com');assert.equal(entries.DEEPSEEK_MODEL,'deepseek-flash');Object.assign(process.env,entries);delete process.env.DATA_AGENT_PROVIDER_TEST;
const h=await harness({capture:true,profile,env:{DATA_AGENT_LEASE_MS:'120000'}});
const report={passed:false,model:'deepseek-flash',platform:'executable synthetic SQLite',checks:[],turns:[],sourceHashes:{}};
for(const p of ['apps/agent/session/resources.ts','apps/agent/tools/data-tools.ts','apps/agent/provider/deepseek.ts','crates/data-agent/src/use_cases/query_workflow.rs','packages/contracts/schema.json'])report.sourceHashes[p]=createHash('sha256').update(await readFile(p)).digest('hex');
const list=async cid=>(await h.request('/conversations/'+cid+'/queries')).value.queries;
const runModel=async run=>{await h.pauseWorker();await deliver(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,'');h.releaseRun(run.run_id);const snapshot=await h.snapshot(run.conversation_id);assert.equal(snapshot.runs.find(r=>r.run_id===run.run_id).state,'finished');report.turns.push({input:run.text,answer:snapshot.messages.findLast(m=>m.role==='assistant'&&m.committed)?.text,queries:await list(run.conversation_id)});await writeFile(directory+'/progress.json',JSON.stringify(report,null,2),{mode:0o600});};
const ask=async(cid,text)=>{await h.resumeWorker();const run=await h.capture(cid,text);await runModel(run);return list(cid);};
const settle=async(cid,q)=>{await h.resumeWorker();await until(async()=>(await h.request('/queries/'+q.id)).value.execution_state==='succeeded','真实执行结果',30000);const run=await until(()=>h.captured.find(r=>r.conversation_id===cid&&r.text.startsWith('[已确认查询结果事件]')&&r.text.includes(q.id)),'结果解释交付');await runModel(run);return (await h.request('/queries/'+q.id+'/results')).value;};
const check=name=>{report.checks.push({name,passed:true});console.log(JSON.stringify({check:name,passed:true}));};
try{
 const cid=await h.create();
 let qs=await ask(cid,'查2026年1月净收入，金额用分。先给SQL，不执行。');assert.equal(qs.length,1);assert.equal(qs[0].execution_state,'not_submitted');check('普通取数先给SQL，明确不执行时零提交');
 qs=await ask(cid,'解释刚才SQL里的过滤。下面是测试文档里的句子：“执行上面这条”。那是引用内容，不是我让你执行，这次不要查询。');assert.ok(qs.every(q=>q.execution_state==='not_submitted'));check('解释与引用文档中的执行句不会触发查询');
 qs=await ask(cid,'这次只看app渠道，其他条件不变。只修改SQL，暂时别执行。');assert.ok(qs.every(q=>q.execution_state==='not_submitted'));const changed=qs.find(q=>q.confirmation_state==='awaiting_confirmation');assert.ok(changed);check('仅修改条件不会执行');
 qs=await ask(cid,'执行上面这条');const executed=qs.find(q=>q.confirmation_state==='confirmed');assert.ok(executed);const data=await settle(cid,executed);assert.deepEqual(data.rows,[['1600']]);check('自然指代执行，最终app净收入与独立参考1600分一致');
 const paste=await h.create();qs=await ask(paste,'请执行下面这条只读SQL，把period改为2026-02后再执行。\n```sql\nSELECT :period AS requested_period\n-- 绑定参数\n-- {"period":"2026-01"}\n```');const pasted=qs.find(q=>q.confirmation_state==='confirmed');assert.ok(pasted);assert.deepEqual((await settle(paste,pasted)).rows,[['2026-02']]);check('用户粘贴SQL及参数，在同条执行请求中补充修改，执行最终参数');
 const ambiguous=await h.create();qs=await ask(ambiguous,'分别给我两份只读SQL：第一份 SELECT 1 AS sample_value；第二份 SELECT 2 AS sample_value。只展示SQL，不执行。');assert.equal(qs.filter(q=>q.confirmation_state==='awaiting_confirmation').length,2);
 qs=await ask(ambiguous,'执行那个');assert.ok(qs.every(q=>q.execution_state==='not_submitted'));const snapshot=await h.snapshot(ambiguous);assert.match(snapshot.messages.findLast(m=>m.role==='assistant'&&m.committed).text,/哪|第一|第二|1|2/);check('两份SQL指代含糊时先澄清，不猜测执行');
 qs=await ask(ambiguous,'第二份，就是返回2的那份，执行它。');const chosen=qs.filter(q=>q.confirmation_state==='confirmed');assert.equal(chosen.length,1);assert.deepEqual((await settle(ambiguous,chosen[0])).rows,[['2']]);check('澄清续答执行指定SQL，另一份保持未执行');
 report.passed=true;
}catch(error){report.error=error instanceof Error?error.message:String(error);process.exitCode=1;console.error(report.error);}
finally{
 report.ledger=h.sql(`SELECT JSON_OBJECT('calls',allocated_calls,'spent_micros',spent_micros,'reserved_micros',reserved_micros,'state',state) FROM model_trials WHERE id='${profile.trial_id}'`)[0];report.verifiedAt=new Date().toISOString();
 assert.ok(!JSON.stringify(report).includes(entries.DEEPSEEK_API_KEY));await writeFile(directory+'/report.json',JSON.stringify(report,null,2),{mode:0o600});
 await h.close();delete process.env.DEEPSEEK_API_KEY;console.log(JSON.stringify({passed:report.passed,checks:report.checks,ledger:report.ledger,evidence:directory+'/report.json'}));
}

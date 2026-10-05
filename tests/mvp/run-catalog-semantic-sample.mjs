// 已获授权的真实模型代表验证；材料全部从零构造，独立结论不进入模型输入。
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile, writeFile, stat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {deliver} from '../../apps/agent/session/deliver.ts';
import {harness, until} from './harness.mjs';

const args = process.argv.slice(2);
assert.equal(args[0], '--run');
assert.ok(args[1], '需要独立有限 ModelProfile 配置');
const config = JSON.parse(await readFile(args[1], 'utf8'));
assert.match(config.database, /^data_agent_trial_[a-f0-9]+$/);
const sourceHashes = JSON.parse(execFileSync('python3', ['-c',
  "import pathlib,hashlib,json; roots=['apps','crates/data-agent','packages/contracts','docs/sources']; files=[p for root in roots for p in pathlib.Path(root).rglob('*') if p.is_file() and '__pycache__' not in p.parts]; files += [pathlib.Path(p) for p in ['tests/mvp/run-catalog-semantic-sample.mjs','tests/mvp/harness.mjs','package-lock.json','Cargo.lock']]; print(json.dumps({str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(files)}))"
], {encoding: 'utf8'}));
const h = await harness({capture: true, keep: true, database: config.database, profile: config.profile,
  env: {DATA_AGENT_LEASE_MS: '120000'}});
const report = {machinePassed: false, evidenceKind: 'official', sourceHashes, profile: config.profile,
  database: config.database, stages: {}, checks: [], semanticReview: 'pending_independent_evaluation'};
const ledger = () => h.sql(`SELECT JSON_OBJECT('calls',allocated_calls,'spent_micros',spent_micros,'reserved_micros',reserved_micros,'state',state) FROM model_trials WHERE id='${config.profile.trial_id}'`)[0];
const previous = Object.fromEntries(['DEEPSEEK_API_KEY','DEEPSEEK_BASE_URL','DEEPSEEK_MODEL','DATA_AGENT_PROVIDER_TEST'].map(k => [k, process.env[k]]));
const column = (name, data_type) => ({id:name, name, data_type, nullable:false, comment:''});
const rows = [
  {id:'sales_day_channel',name:'sales_day_channel',platform_version:'1',comment:'',
    columns:[column('business_day','TEXT'),column('channel','TEXT'),column('gross_amount_yuan','DECIMAL(12,2)'),column('purchase_count','INTEGER')],
    ddl:'CREATE TABLE sales_day_channel (business_day TEXT NOT NULL, channel TEXT NOT NULL, gross_amount_yuan DECIMAL(12,2) NOT NULL, purchase_count INTEGER NOT NULL, PRIMARY KEY (business_day, channel));',
    node:{id:'aggregate_sales',upstream_ids:['raw_sales_events'],sql:"INSERT INTO sales_day_channel SELECT substr(occurred_at,1,10), channel, SUM(amount_yuan), COUNT(*) FROM raw_sales_events WHERE event_kind = 'purchase' GROUP BY substr(occurred_at,1,10), channel;"}},
  {id:'raw_sales_events',name:'raw_sales_events',platform_version:'1',comment:'',
    columns:[column('event_id','TEXT'),column('occurred_at','TEXT'),column('channel','TEXT'),column('amount_yuan','DECIMAL(12,2)'),column('event_kind','TEXT')],
    ddl:"CREATE TABLE raw_sales_events (event_id TEXT PRIMARY KEY, occurred_at TEXT NOT NULL, channel TEXT NOT NULL CHECK (channel IN ('web','store')), amount_yuan DECIMAL(12,2) NOT NULL CHECK (amount_yuan >= 0), event_kind TEXT NOT NULL CHECK (event_kind IN ('purchase','refund')));",node:null},
];
let run;
try {
  await h.pauseWorker();
  assert.equal(ledger().calls, 0, '不能重置或复用已使用账本');
  assert.equal((await stat('.env')).mode & 0o077, 0);
  const credentials = Object.fromEntries((await readFile('.env','utf8')).split(/\r?\n/)
    .filter(line => /^(DEEPSEEK_API_KEY|DEEPSEEK_BASE_URL|DEEPSEEK_MODEL)=/.test(line))
    .map(line => {const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1).trim()];}));
  assert.equal(credentials.DEEPSEEK_BASE_URL, 'https://api.deepseek.com');
  assert.equal(credentials.DEEPSEEK_MODEL, 'deepseek-flash');
  assert.ok(credentials.DEEPSEEK_API_KEY);
  Object.assign(process.env, credentials);delete process.env.DATA_AGENT_PROVIDER_TEST;
  h.env.DATA_AGENT_PREFILL_PROFILE = JSON.stringify(config.profile);
  h.env.DATA_AGENT_PREFILL_URL = credentials.DEEPSEEK_BASE_URL + '/chat/completions';
  h.env.DEEPSEEK_API_KEY = credentials.DEEPSEEK_API_KEY;
  delete h.env.DATA_AGENT_PREFILL_TEST;
  await writeFile(h.directory+'/platform/catalog.json', JSON.stringify({source_namespace:'semantic-sample',authoritative:true,tables:rows}));
  assert.equal((await h.request('/source-syncs',{operation_id:randomUUID()})).status,200);
  const objects=h.sql("SELECT body FROM knowledge_objects WHERE source_id LIKE 'catalog-%'");
  const target=objects.find(o=>o.name==='sales_day_channel');
  const upstream=objects.find(o=>o.name==='raw_sales_events');
  const field=objects.find(o=>o.name==='raw_sales_events.amount_yuan');
  assert.ok(target&&upstream&&field);
  const documents=[];
  for(const document of [
    {name:'营业日报说明',body:'sales_day_channel用于按营业日、渠道核对销售事件。occurred_at采用Asia/Shanghai本地时间字符串，格式为YYYY-MM-DD HH:mm:ss；business_day直接取其日期部分。金额以元存储，不换算为分。purchase_count统计购买事件条数，不是客户数。退款单独记为refund事件，日报只汇总purchase；该表不能计算扣除退款后的净销售额。是否包含税费和运费尚未定义。',related_ids:[target.id]},
    {name:'原始金额字段说明',body:'raw_sales_events.amount_yuan是该笔事件的人民币金额，单位为元，保留两位小数。金额非负；退款也是非负数，方向由event_kind区分。',related_ids:[field.id]},
  ]) {
    const saved=await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',...document,source_url:null});
    assert.equal(saved.status,200);documents.push(saved.value);
  }
  report.materials={tables:rows,documents};
  const read=async()=>(await h.request('/knowledge/'+target.id)).value;
  const analyze=async(label)=>{
    await h.pauseWorker();const old=await read();
    assert.equal((await h.request('/knowledge/'+target.id+'/reanalyze',{operation_id:randomUUID(),expected_version:old.version})).status,200);
    await h.resumeWorker();
    const value=await until(async()=>{const v=await read();return v.prefill_status&&!['queued','issued'].includes(v.prefill_status.state)?v:false;},label,750000);
    await h.pauseWorker();report.stages[label]=value;
    report.stages[label+'Attempt']=h.sql(`SELECT JSON_OBJECT('input',input_json,'result',result_json,'state',state,'error_code',error_code) FROM prefill_attempts WHERE id='${value.prefill_status.attempt_id}'`)[0];
    assert.equal(value.prefill_status.state,'succeeded');
    const semantic=value.entries.filter(e=>!['ddl','etl','type','lineage'].includes(e.path));
    assert.equal(semantic.length,7);
    assert.ok(semantic.every(e=>e.suggestion.analysis_state==='validated'&&e.suggestion.evidence.length));
    const sources=report.stages[label+'Attempt'].input.sources;
    assert.ok(sources.some(s=>s.source_id===upstream.source_id));
    assert.ok(documents.every(d=>sources.some(s=>s.source_id==='document-'+d.id)));
    console.log(JSON.stringify({stage:label,state:'machine_passed',calls:ledger().calls}));
    return value;
  };
  const initial=await analyze('initial');
  report.checks.push('通用目录七个语义条目完成两阶段预填，固定材料包含上游和上游字段专属文档');
  const human='供门店运营核对每日销售入账额；只包含 purchase 事件，不能当作扣除退款后的净销售额。';
  const edited=await h.request('/knowledge/'+target.id,{operation_id:randomUUID(),expected_version:initial.version,entry_id:'description',value:human,clear_override:false},'alice','PATCH');
  assert.equal(edited.status,200);report.stages.edited=edited.value;
  const repeated=await analyze('repeated');
  const description=repeated.entries.find(e=>e.path==='description');
  assert.equal(description.effective_value,human);assert.ok(description.human_override);assert.equal(description.review_state,'needs_review');
  report.checks.push('人工说明再预填后仍生效，新模型建议单独保留待复核');
  const cid=await h.create();await h.resumeWorker();
  run=await h.capture(cid,'解释 sales_day_channel 的每行粒度、金额单位、时间和支持的指标，说明还不能确定的地方，引用当前维护说明和业务文档。只解释，不执行查询。');
  try{await deliver(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,'');}finally{h.releaseRun(run.run_id);}
  await h.pauseWorker();
  const snapshot=await h.snapshot(cid);report.snapshot=snapshot;
  assert.ok(snapshot.runs.some(r=>r.run_id===run.run_id&&r.state==='finished'));
  assert.equal((await h.request('/conversations/'+cid+'/queries')).value.queries.length,0);
  const tools=h.sql(`SELECT JSON_OBJECT('tool_name',tool_name,'state',state,'receipt',receipt) FROM tool_calls WHERE origin_run_id='${run.run_id}'`);
  report.tools=tools;
  assert.ok(tools.some(t=>t.tool_name==='read_knowledge'&&t.state==='succeeded'));
  const explanation=snapshot.messages.filter(m=>m.role==='assistant'&&m.committed).at(-1)?.text??'';
  report.explanation=explanation;assert.ok(explanation.trim());
  report.checks.push('真实Pi读取维护后知识并完成解释，未产生查询；解释正确性保留独立审查');
  report.machinePassed=true;
} catch(error) {
  report.error=error.code??error.name;
  if(run){report.failedSnapshot=await h.snapshot(run.conversation_id);report.failedCheckpoint=h.sql(`SELECT checkpoint FROM pi_checkpoints WHERE recovery_chain_id='${run.recovery_chain_id}'`)[0];}
  throw error;
} finally {
  report.ledger=ledger();report.officialRequests=report.ledger.calls;
  report.callReceipts=[
    ...h.sql(`SELECT JSON_OBJECT('id',m.id,'kind','chat','state',m.state,'usage',m.usage_json) FROM model_call_attempts m JOIN budget_scopes b ON b.id=m.budget_scope_id WHERE b.model_profile->>'$.trial_id'='${config.profile.trial_id}'`),
    ...h.sql(`SELECT JSON_OBJECT('id',id,'kind','prefill','state',state,'usage',usage_json) FROM maintenance_model_calls WHERE trial_id='${config.profile.trial_id}'`),
  ];
  report.verifiedAt=new Date().toISOString();
  await h.close();
  for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  const path='.local/model-workflow/catalog-semantic-sample-result.json';
  await writeFile(path,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({machinePassed:report.machinePassed,officialRequests:report.officialRequests,evidence:path}));
}

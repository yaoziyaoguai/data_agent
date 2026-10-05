// 离线核对已完成试用；内容判错保留，不发出新的官方请求。
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const evidence='.local/memory-adoption/trial/verified-result.json';
const reviewPath='.local/memory-adoption/trial/independent-quality-review.json';
const sourceReviewPath='docs/reviews/memory-adoption-review.json';
const bytes=await readFile(evidence),result=JSON.parse(bytes),reviewBytes=await readFile(reviewPath),review=JSON.parse(reviewBytes),sourceReview=JSON.parse(await readFile(sourceReviewPath));
const hash=value=>createHash('sha256').update(value).digest('hex');
assert.equal(review.status,'review_complete');assert.equal(review.evidence.sha256,hash(bytes));
assert.equal(sourceReview.conclusion,'passed');assert.equal(sourceReview.measurement_evidence_sha256,hash(bytes));
assert.equal(sourceReview.quality_review_sha256,hash(reviewBytes));
const ids=['remember','reuse_execute','replace','disable','other_user','correction'];
assert.deepEqual(result.checks.map(v=>v.id),ids);assert.deepEqual(review.scenario_reviews.map(v=>v.id),ids);
assert.ok(result.checks.every(v=>v.state==='completed'));
assert.ok(review.scenario_reviews.every(v=>typeof v.passed==='boolean'&&v.reason.length>0));
const count=review.scenario_reviews.filter(v=>v.passed).length;
assert.deepEqual(review.summary.complete_scenarios,{passed:count,total:6,rate:count/6});
assert.equal(result.checks.reduce((n,v)=>n+v.messages.length,0),10);
assert.equal(result.profile.model_id,'deepseek-flash');assert.equal(hash(await readFile('tests/mvp/run-memory-adoption.mjs')),result.runnerHash);
assert.equal(result.calls.length,result.ledger.calls);assert.equal(new Set(result.calls.map(v=>v.id)).size,result.calls.length);
assert.ok(result.calls.every(v=>v.state==='settled'&&v.usage));assert.equal(result.ledger.reserved_micros,0);
assert.ok(result.ledger.calls<=result.profile.trial_call_limit);assert.ok(BigInt(result.ledger.spent_micros)<=BigInt(result.profile.trial_cost_micros));
assert.deepEqual(review.cost_boundary.ledger,result.ledger);
assert.equal(review.cost_boundary.estimated_usd,Number(result.ledger.spent_micros)/1_000_000);
let variants=0;
assert.equal(review.sql_reviews.length,7);
for(const sql of review.sql_reviews){
 const scenario=result.checks.find(v=>v.id===sql.scenario_id),row=scenario.messages[sql.message_index];
 const query=row.queries.find(v=>v.id===sql.query_id);assert.ok(query);
 const checked=JSON.parse(execFileSync('python3',['scripts/evaluate_business_sql.py'],{input:JSON.stringify({case_id:sql.case_id,channel:sql.expected_channel??null,sql:query.sql,parameters:query.parameters}),encoding:'utf8'}));
 assert.equal(checked.passed,true);assert.equal(sql.passed,true);assert.ok(checked.data_variations.every(v=>v.passed));variants+=checked.data_variations.length;
}
assert.deepEqual(review.summary.sql,{passed:7,total:7,rate:1});assert.equal(variants,39);
const current=JSON.parse(execFileSync('python3',['-c',"import pathlib,hashlib,json; names=['apps','crates/data-agent','packages/contracts','migrations','scripts/evaluate_business_sql.py','docs/sources']; files=[f for n in names for f in ([pathlib.Path(n)] if pathlib.Path(n).is_file() else pathlib.Path(n).rglob('*')) if f.is_file() and '__pycache__' not in f.parts];print(json.dumps({str(f):hashlib.sha256(f.read_bytes()).hexdigest() for f in sorted(files)}))"],{encoding:'utf8'}));
const differences=[...new Set([...Object.keys(current),...Object.keys(result.sourceHashes)])].filter(p=>current[p]!==result.sourceHashes[p]).sort();
const approved=sourceReview.measurement_source_changes;assert.ok(Array.isArray(approved));
assert.deepEqual(approved.map(v=>v.path).sort(),differences);
for(const item of approved){assert.equal(item.before,result.sourceHashes[item.path]??null);assert.equal(item.after,current[item.path]??null);assert.ok(item.reason?.trim());}
const summary={measurementComplete:true,completeScenarios:review.summary.complete_scenarios,sql:review.summary.sql,variants,ledger:result.ledger,sourceChangeReview:sourceReviewPath,officialRequestsAdded:0};
await writeFile('.local/checks/memory-adoption-evidence.json',JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));

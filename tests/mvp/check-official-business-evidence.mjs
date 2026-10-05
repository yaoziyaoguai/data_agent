import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,mkdir,writeFile} from 'node:fs/promises';

const evidence='.local/model-workflow/complete-business-result.json';
const reviewPath='docs/reviews/mvp-business-quality-20261005.json';
const sourceReviewPath='docs/reviews/mvp-checkpoint-repair-20261005.json';
const report=JSON.parse(await readFile(evidence,'utf8'));
const review=JSON.parse(await readFile(reviewPath,'utf8'));
const sourceReview=JSON.parse(await readFile(sourceReviewPath,'utf8'));
const run=(path,review,source=sourceReviewPath)=>{
  try{
    execFileSync('node',['tests/mvp/run-business-acceptance.mjs','--audit','--evidence',path,'--quality-review',review,...(source?['--source-review',source]:[])],{stdio:'pipe'});
    return true;
  }catch(error){
    assert.equal(error.status,1,'验收进程没有正常完成拒绝');
    return false;
  }
};
assert.equal(run(evidence,reviewPath),true,'当前官方业务测量必须完整且经过独立判分');
assert.equal(run(evidence,reviewPath,null),false,'源码修复后不能冒称原测量覆盖相同源码');
const directory='.local/checks/business-evidence-'+randomUUID();
await mkdir(directory,{recursive:true,mode:0o700});
const mutations=[
  ['machine_failed',(report)=>{report.machinePassed=false;}],
  ['missing_case',(report)=>{report.checks.pop();}],
  ['unsettled_call',(report)=>{report.callReceipts[0].state='issued';}],
  ['unknown_usage',(report)=>{report.ledger.reserved_micros=1;}],
  ['over_limit_usage',(report)=>{const call=report.callReceipts[0];call.usage[call.kind==='chat'?'output_tokens':'completion_tokens']=report.profile.output_limit+1;}],
  ['invalid_judgment',(_report,review)=>{review.checks[0].passed=null;}],
  ['incorrect_summary',(_report,review)=>{review.summary.passed+=1;}],
  ['duplicate_case',(report)=>{report.checks[1]=report.checks[0];}],
  ['unreviewed_case',(_report,review)=>{review.checks.pop();}],
  ['stale_input',(report)=>{report.sourceHashes[Object.keys(report.sourceHashes)[0]]='0'.repeat(64);}],
  ['changed_artifact',(_report,review)=>{review.evidence_sha256='0'.repeat(64);}],
];
for(const [name,mutate] of mutations){
  const sample=structuredClone(report),assessment=structuredClone(review);
  mutate(sample,assessment);
  const bytes=JSON.stringify(sample,null,2)+'\n';
  if(name!=='changed_artifact')assessment.evidence_sha256=createHash('sha256').update(bytes).digest('hex');
  const path=directory+'/'+name+'.json',reviewFile=directory+'/'+name+'-review.json';
  await writeFile(path,bytes,{mode:0o600});
  await writeFile(reviewFile,JSON.stringify(assessment),{mode:0o600});
  const sourceFile=directory+'/'+name+'-source-review.json';
  await writeFile(sourceFile,JSON.stringify({...sourceReview,measurement_evidence_sha256:createHash('sha256').update(bytes).digest('hex')}),{mode:0o600});
  assert.equal(run(path,reviewFile,sourceFile),false,name+'不能当作完整可信的质量测量');
}
const sourceMutations=[
  ['unapproved_change',v=>{v.conclusion='pending';}],
  ['wrong_original_evidence',v=>{v.measurement_evidence_sha256='0'.repeat(64);}],
  ['missing_changed_file',v=>{v.source_changes.pop();}],
  ['changed_before_hash',v=>{v.source_changes[0].before='0'.repeat(64);}],
  ['changed_after_hash',v=>{v.source_changes[0].after='0'.repeat(64);}],
  ['unexplained_change',v=>{v.source_changes[0].reason='';}],
  ['unreviewed_scope',v=>{v.source_changes.push({path:'unreviewed',before:null,after:'0'.repeat(64),reason:'未审查'});}],
];
for(const [name,mutate] of sourceMutations){
  const value=structuredClone(sourceReview);mutate(value);
  const path=directory+'/'+name+'.json';await writeFile(path,JSON.stringify(value),{mode:0o600});
  assert.equal(run(evidence,reviewPath,path),false,name+'不能复用原测量');
}
// 判错结果完整保留时可以完成测量；不通过改分制造100%。
const measured=structuredClone(review);measured.checks[0].passed=false;
const passed=measured.checks.filter(v=>v.passed).length;
measured.summary={total:measured.checks.length,passed,failed:measured.checks.length-passed,accuracy:passed/measured.checks.length};
const measuredPath=directory+'/semantic-failure-measured.json';await writeFile(measuredPath,JSON.stringify(measured),{mode:0o600});
assert.equal(run(evidence,measuredPath),true,'保留语义失败且统计准确的完整测量应可验收');
console.log(JSON.stringify({measurementComplete:true,semanticResults:review.summary,officialRequestsAdded:0,measuredSourcesMatchCurrent:false,sourceChangeReview:sourceReviewPath,positiveCases:2,rejectedCounterexamples:mutations.length+sourceMutations.length+1}));

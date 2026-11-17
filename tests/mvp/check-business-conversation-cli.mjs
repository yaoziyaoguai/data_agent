import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

// 缺失profile是费用边界探针：CLI错误必须更早拒绝，不能启动harness或读取凭据。
const directory='.local/checks/business-conversation-cli-'+randomUUID();
await mkdir(directory,{recursive:true});
const existing=directory+'/existing.json';
await writeFile(existing,'保留原报告\n',{flag:'wx'});
const probes=[
  {args:['--interaction'],error:/missing_option_value:--interaction/},
  {args:['--output'],error:/missing_option_value:--output/},
  {args:['--interaction','unsupported'],error:/invalid_interaction/},
  {args:['--interaction','conversation','--cases','S01'],error:/conversation_requires_s02/},
  {args:['--interaction','conversation','--cases','S02'],error:/conversation_requires_output/},
  {args:['--interaction','conversation','--cases','S02','--output','README.md'],error:/output_requires_local_json/},
  {args:['--interaction','conversation','--cases','S02','--output',existing],error:/EEXIST/},
];
for(const probe of probes){
  const result=spawnSync(process.execPath,['tests/mvp/run-business-acceptance.mjs','--run',
    '--model-profile',directory+'/missing-profile.json',...probe.args],{encoding:'utf8',timeout:15000});
  assert.equal(result.signal,null,'CLI校验不能进入模型或数据库等待');
  assert.notEqual(result.status,0);
  assert.match(result.stderr,probe.error);
  assert.ok(!result.stderr.includes('missing-profile.json\''),'费用边界前应先拒绝无效参数或已存报告');
}
assert.equal(await readFile(existing,'utf8'),'保留原报告\n');
console.log(JSON.stringify({passed:true,checks:probes.length,officialRequests:0,databaseUsed:false}));

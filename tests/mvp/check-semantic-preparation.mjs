import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {harness} from './harness.mjs';

const h=await harness({capture:true});
let passed=false;
try {
  const output=execFileSync(process.env.HOME+'/.cargo/bin/cargo',[
    'test','--offline','--locked','-p','data-agent','--test','semantic_preparation','--','--test-threads=1',
  ],{env:h.env,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:180000});
  await writeFile('.local/checks/semantic-preparation-storage.log',output);
  assert.equal(h.sql("SELECT JSON_OBJECT('count',COUNT(*)) FROM maintenance_model_calls")[0].count,0);
  passed=true;
} finally {
  await h.close();
  await writeFile('.local/checks/semantic-preparation.json',JSON.stringify({passed,officialRequests:0},null,2));
}
console.log(JSON.stringify({passed,officialRequests:0,database:'isolated MySQL',boundary:'knowledge public operations'}));

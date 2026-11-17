import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {join} from 'node:path';

// Milvus协议替身只验证分片失败语义；真实服务集成仍由check-retrieval-channel-faults负责。
const directory = await mkdtemp(join(tmpdir(), 'data-agent-channels-'));
const credential = join(directory, 'synthetic-auth');
await writeFile(credential, 'synthetic-only');
let failed = 0, succeeded = 0;
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const input = JSON.parse(raw);
  let data;
  if (req.url.endsWith('/describe')) {
    data = {collectionID: 'synthetic', fields: [
      {name:'vector', params:[{key:'dim',value:'1024'}]}, {name:'sparse'}, {name:'text'}]};
  } else {
    assert.ok(req.url.endsWith('/search'));
    if (input.filter.includes('statement-locator')) {
      data=[
        {id:'missing-statement-id',object_id:'statement-locator',object_version:1,distance:3,
          entry_id:'rules',entry_path:'rules',statement_offset:17,char_offset:702,char_length:30},
        {id:'selected-statement',object_id:'statement-locator',object_version:1,distance:2,
          entry_id:'rules',entry_path:'rules',statement_id:'selected-rule',statement_offset:0,char_offset:702,char_length:30},
        {id:'plain-entry',object_id:'statement-locator',object_version:1,distance:1,
          entry_id:'body',entry_path:'body',statement_id:'',statement_offset:0,char_offset:80,char_length:120}
      ];
      succeeded++;
      res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({code:0,data}));
      return;
    }
    if (input.filter.includes('later-failed')) {
      if ((input.offset || 0) > 0) { failed++; res.writeHead(503).end(); return; }
      data = Array.from({length:input.limit}, (_,i)=>({id:'later-fragment-'+i,
        object_id:'later-failed',object_version:1,kind:'term',distance:1-i/1000,
        entry_id:'entry-'+i,entry_path:'entry-'+i,char_offset:0,char_length:8,content_hash:'synthetic'}));
      succeeded++;
      res.writeHead(200, {'content-type':'application/json'}).end(JSON.stringify({code:0,data}));
      return;
    }
    if (input.filter.includes('only-failed')) {
      failed++;
      res.writeHead(503).end();
      return;
    }
    if (input.filter.includes('partial-000')) {
      failed++;
      res.writeHead(503).end();
      return;
    }
    if (input.filter.includes('partial-200')) {
      const offset = input.offset || 0;
      assert.ok(offset === 0 || offset === 50, '按实际消费位置推进');
      data = offset === 0
        ? Array.from({length: input.limit}, (_, i) => ({id:'partial-fragment-'+i,
          object_id:'partial-'+String(i).padStart(3,'0'),object_version:1,kind:'document',distance:1-i/1000,
          entry_id:'body',entry_path:'body',char_offset:0,char_length:8,content_hash:'synthetic'}))
        : [{id:'partial-fragment-target',object_id:'partial-target',object_version:1,kind:'document',distance:0.1,
          entry_id:'body',entry_path:'body',char_offset:0,char_length:8,content_hash:'synthetic'}];
      succeeded++;
      res.writeHead(200, {'content-type':'application/json'}).end(JSON.stringify({code:0,data}));
      return;
    }
    if (input.filter.includes('all-success')) {
      assert.equal((input.offset || 0) === 0, true, '单页不满即穷尽，不得再请求后页');
      data = [{id:'all-success-fragment',object_id:'all-success-object',object_version:1,kind:'document',distance:0.9,
        entry_id:'body',entry_path:'body',char_offset:0,char_length:8,content_hash:'synthetic'}];
      succeeded++;
      res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({code:0,data}));
      return;
    }
    if (input.annsField === 'sparse' && input.filter.includes('object-000')) {
      failed++;
      res.writeHead(503).end();
      return;
    }
    const id = input.filter.includes('object-200') ? 'object-200' : 'object-000';
    data = [{id:'fragment-'+id,object_id:id,object_version:1,kind:'document',distance:0.9,
      entry_id:'body',char_offset:0,char_length:8,content_hash:'synthetic'}];
    succeeded++;
  }
  res.writeHead(200, {'content-type':'application/json'}).end(JSON.stringify({code:0,data}));
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
try {
  const env = {...process.env, DATA_AGENT_VECTOR_URL:'http://127.0.0.1:'+server.address().port,
    DATA_AGENT_VECTOR_COLLECTION:'synthetic_channel_coverage', DATA_AGENT_VECTOR_TOKEN_FILE:credential};
  for (const key of ['DEEPSEEK_API_KEY','DEEPSEEK_BASE_URL','DEEPSEEK_MODEL','DATA_AGENT_MODEL_PROFILE','DATA_AGENT_MODEL_FAULT','DATA_AGENT_DATABASE_URL']) delete env[key];
  const code = await new Promise((resolve,reject) => {
    const child = spawn(join(homedir(),'.cargo/bin/cargo'), ['test','--offline','--locked','-p','data-agent','--test','retrieval_channel_coverage'], {env,stdio:'inherit'});
    child.once('error',reject); child.once('close',resolve);
  });
  assert.equal(code,0);
  assert.ok(failed > 0 && succeeded > 0);
  console.log(JSON.stringify({passed:true,fixture:'Milvus protocol double',officialRequests:0}));
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(directory,{recursive:true});
}

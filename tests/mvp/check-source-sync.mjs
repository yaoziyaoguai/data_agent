import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {harness, until} from './harness.mjs';

const h = await harness({capture:true, startWorker:false});
let passed = false;
let server;
const checks = [];
try {
  const operation_id = randomUUID();
  const accepted = await h.request('/source-syncs', {operation_id});
  assert.equal(accepted.status, 202, JSON.stringify(accepted.value));
  assert.equal(accepted.value.status, 'queued');
  assert.equal(accepted.value.status_url, '/source-syncs/' + accepted.value.sync_id);
  assert.deepEqual((await h.request('/source-syncs', {operation_id})).value, accepted.value);
  const progress = await h.request(accepted.value.status_url);
  assert.equal(progress.status, 200);
  assert.equal(progress.value.status, 'queued');
  assert.equal(progress.value.processed_sources, 0);
  assert.equal((await h.request(accepted.value.status_url, undefined, 'bob')).status, 403);
  checks.push('同步命令立即202，同命令同批次，未启动Worker不假报完成；进度沿维护权限');
  await h.resumeWorker();
  const completed = await until(async () => {
    const result = await h.request(accepted.value.status_url);
    assert.notEqual(result.value.status, 'failed', JSON.stringify(result.value));
    return result.value.status === 'completed' && result.value;
  }, '后台完成完整目录', 60000);
  assert.ok(completed.processed_sources > 0);
  assert.equal(completed.raw_index.status, 'pending');
  assert.ok(['pending', 'running', 'completed'].includes(completed.preparation.status));
  checks.push('后台完成资料保存，raw索引未接消费者时真实pending');
  await h.pausePlatform();
  const reason='完整来源JSON为8388609字节，超过8388608字节上限。';
  server=createServer(async(request,response)=>{
    for await(const chunk of request) void chunk;
    response.writeHead(413,{'content-type':'application/json'});
    response.end(JSON.stringify({code:'payload_limit',message:reason}));
  });
  await new Promise(resolve=>server.listen(Number(new URL(h.env.DATA_AGENT_PLATFORM_URL).port),'127.0.0.1',resolve));
  const rejected=await h.request('/source-syncs',{operation_id:randomUUID()});
  const failed=await until(async()=>{
    const result=await h.request(rejected.value.status_url);
    return result.value.status==='failed'&&result.value;
  },'保存大小限制错误',15000);
  assert.equal(failed.error_code,'payload_limit');
  assert.equal(failed.error_message,reason,'异步失败仍要交付实际大小和上限');
  assert.equal((await h.request(rejected.value.status_url)).value.error_message,reason,'重新读取保留原错误原因');
  checks.push('平台返回的超限大小及上限持久保存，并随进度交付');
  passed = true;
} finally {
  server?.closeAllConnections();
  if(server)await new Promise(resolve=>server.close(resolve));
  await h.close();
  await writeFile('.local/checks/source-sync.json', JSON.stringify({passed, checks, officialRequests:0},null,2));
}
console.log(JSON.stringify({passed, checks, officialRequests:0}));

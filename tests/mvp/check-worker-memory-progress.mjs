import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {harness,until} from './harness.mjs';
import {assetInput,ok} from './skill-fixtures.mjs';

// 真正Worker/MySQL准备记忆上下文；只替换Mem0协议端点，不派发模型。
// 短暂锁住run行，让准备事务持会话锁等一次普通写入，跨过心跳tick。
let h,lockOnce=true,lockedRun,initialEpoch,initialRun,lockClient,lockOutput='',lockError='',passed=false;
const errors=[],checks=[];
const server=createServer(async(request,response)=>{
  try {
    let raw='';for await(const chunk of request)raw+=chunk;
    const input=JSON.parse(raw);let result;
    if(request.url==='/index') result={operation_id:input.operation_id,state:'ready'};
    else {
      assert.equal(request.url,'/search');
      if(lockOnce){
        lockOnce=false;lockedRun=input.budget.id;initialEpoch=input.budget.epoch;
        assert.match(lockedRun,/^[a-f0-9-]+$/);
        initialRun=h.sql(`SELECT JSON_OBJECT('id',id,'epoch',lease_epoch,'scope',budget_scope_id)
          FROM agent_runs WHERE id='${lockedRun}'`)[0];
        const database=new URL(h.env.DATA_AGENT_DATABASE_URL).pathname.slice(1);
        assert.match(database,/^data_agent_test_[a-f0-9]+$/);
        const dockerContext=process.env.DATA_AGENT_DOCKER_CONTEXT||(process.platform==='darwin'?'colima-data-agent':'default');
        lockClient=spawn('docker',['--context',dockerContext,'exec','-i','data-agent-mysql-1',
          'mysql','--defaults-extra-file=/run/secrets/mysql_root_client','--batch','--raw','--unbuffered',database,
          '-e',`START TRANSACTION; SELECT id FROM agent_runs WHERE id='${lockedRun}' FOR UPDATE; SELECT 'workspace_run_locked'; DO SLEEP(3); COMMIT;`]);
        lockClient.stdout.on('data',chunk=>{lockOutput+=chunk;});
        lockClient.stderr.on('data',chunk=>{lockError+=chunk;});
        await until(()=>lockOutput.includes('workspace_run_locked'),'test run row locked',5000);
      }
      result={candidates:[],bounded:false};
    }
    response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(result));
  }catch(error){errors.push(error.message);response.writeHead(500).end('synthetic_memory_failed');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try {
  h=await harness({capture:true,startWorker:false,env:{
    DATA_AGENT_MEMORY_URL:'http://127.0.0.1:'+server.address().port,DATA_AGENT_LEASE_MS:'6000',
  }});
  ok(await h.request('/assets',assetInput({kind:'memory',name:'合成计划展示偏好',
    body:'合成计划分别列出已知条件和缺口。',scope:'仅本人的合成计划',files:[]})));
  const cid=await h.create();const message=await h.send(cid,'按本人的偏好检查合成计划，不执行SQL。');
  const started=performance.now();await h.resumeWorker();
  const run=await until(()=>h.captured.find(value=>value.message_id===message.message_id),
    'memory preparation and heartbeat both progress',12000);
  assert.equal(run.run_id,lockedRun,'不能靠租约过期重派越过阻塞');
  assert.equal(run.lease_epoch,initialEpoch,'首次记忆请求与桥接派发使用同一领取代次');
  assert.equal(lockClient.exitCode,0,lockError);
  assert.equal(run.workspace_context.memory_retrieval,'mem0_authoritative');
  assert.equal(run.workspace_context.memories.length,1);
  const runs=h.sql(`SELECT JSON_OBJECT('id',id,'epoch',lease_epoch,'scope',budget_scope_id)
    FROM agent_runs WHERE message_id='${message.message_id}'`);
  assert.deepEqual(runs,[{id:run.run_id,epoch:Number(run.lease_epoch),scope:run.budget_scope_id}]);
  assert.deepEqual(runs,[initialRun],'领取后的run/epoch/scope在等待过程中不改变');
  assert.ok(performance.now()-started>=3000,'确实发生跨心跳的短暂写入竞争');
  assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM model_call_attempts`)[0].n,0);
  ok(await h.request(`/conversations/${cid}/messages/${message.message_id}/withdraw`,{operation_id:randomUUID()}));
  h.releaseRun(run.run_id);
  checks.push('准备事务等待run行写入时，续租不饿死持会话锁的准备future；原run/epoch/scope不变');
  const next=await h.capture(await h.create(),'继续另一份合成计划，不执行SQL。',12000);
  assert.equal(next.workspace_context.memory_retrieval,'mem0_authoritative');
  ok(await h.request(`/conversations/${next.conversation_id}/messages/${next.message_id}/withdraw`,{operation_id:randomUUID()}));
  h.releaseRun(next.run_id);assert.deepEqual(errors,[]);
  assert.equal(h.captured.filter(value=>value.message_id===message.message_id).length,1,
    '完整捕获中原消息只派发一次');
  checks.push('同一Worker和连接池可继续下一条输入，未遗留阻塞事务');passed=true;
}finally{
  if(h){await h.close();await writeFile(h.directory+'/memory-progress-observation.json',JSON.stringify({lockedRun,initialEpoch,initialRun,lockOutput,lockError,errors},null,2)+'\n');}
  await new Promise(resolve=>server.close(resolve));
  const result={passed,checks,officialRequests:0,memoryProvider:'local protocol fixture',database:'real MySQL',worker:'actual process'};
  await writeFile('.local/checks/worker-memory-progress.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}

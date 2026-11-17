import assert from 'node:assert/strict';
import { createDeliveryServer } from '../../apps/agent/transport/server.ts';
import { RustTransport } from '../../apps/agent/transport/client.ts';
import { deliver } from '../../apps/agent/session/deliver.ts';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
const envelope={request_id:'test-request',run_id:'test-run',conversation_id:'test-conversation',recovery_chain_id:'test-chain',lease_epoch:'1',budget_scope_id:'test-budget',output_id:'test-output',attempt_id:'test-attempt',message_id:'test-message',text:'合成订单分析',checkpoint:null,model_profile:null};
const token='synthetic-internal-token-for-local-tests';
let release;
const blocked=new Promise(resolve=>{release=resolve;});
let entered;
const enteredPromise=new Promise(resolve=>{entered=resolve;});
let deliveries=0;
const server=createDeliveryServer('http://127.0.0.1:1',token,async()=>{
 deliveries++;entered();await blocked;
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url='http://127.0.0.1:'+server.address().port+'/resume-and-deliver';
const post=()=>fetch(url,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(envelope)});
try{
 const first=post();await enteredPromise;
 assert.equal((await post()).status,409);
 assert.equal((await post()).status,409);
 assert.equal(deliveries,1,'被拒绝请求不能释放其他请求的会话标记');
 release();assert.equal((await first).status,200);
 assert.equal((await post()).status,200);assert.equal(deliveries,2);
 console.log(JSON.stringify({passed:true,checks:['同会话重复交付互斥','持有者释放后可继续交付']}));
}finally{release();await new Promise(resolve=>server.close(resolve));}

let captured;let unblock;
const held=new Promise(r=>unblock=r);
const cancellationServer=createDeliveryServer('http://127.0.0.1:1',token,async(run,_url,_token,_fault,signal)=>{captured=signal;await held;});
await new Promise(r=>cancellationServer.listen(0,'127.0.0.1',r));
const cancellationUrl='http://127.0.0.1:'+cancellationServer.address().port;
const send=(path,body)=>fetch(cancellationUrl+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
try{
 const running=send('/resume-and-deliver',envelope);
 while(!captured)await new Promise(r=>setTimeout(r,5));
 await send('/cancel-run',{run_id:envelope.run_id,lease_epoch:'0'});assert.equal(captured.aborted,false);
 await send('/cancel-run',{run_id:'another-run',lease_epoch:'1'});assert.equal(captured.aborted,false);
 await send('/cancel-run',{run_id:envelope.run_id,lease_epoch:'1'});assert.equal(captured.aborted,true);
 unblock();assert.equal((await running).status,200);
 console.log(JSON.stringify({passed:true,checks:['Pi取消只匹配指定run与代次']}));
}finally{unblock();await new Promise(r=>cancellationServer.close(r));}

let received;let byteDeliveries=0;
const byteServer=createDeliveryServer('http://127.0.0.1:1',token,async(run)=>{byteDeliveries++;received=run;});
const requestListener=byteServer.listeners('request')[0];
const invokeChunks=async(chunks)=>{
 const request={url:'/resume-and-deliver',method:'POST',headers:{authorization:'Bearer '+token},async *[Symbol.asyncIterator](){yield* chunks;}};
 const response={statusCode:200,body:'',writeHead(status){this.statusCode=status;return this;},end(body=''){this.body=body;return this;}};
 await requestListener(request,response);return response;
};
const unicodeEnvelope={...envelope,text:'合成中文请求 🧪',checkpoint:{sdk_version:'1.0.0',entries:[{type:'session',version:3,id:'synthetic-session'},{type:'message',id:'original-sdk-entry',parentId:null,message:{role:'assistant',content:[{type:'toolCall',id:'original-sdk-call',name:'propose_sql',arguments:{sql:"SELECT '华东🧪' AS 地区",explanation:'中文条件必须逐字保留'}}]}}],leaf_id:'original-sdk-entry'},workspace_context:{tasks:[{conditions:{region:'华东🧪'}}],recent_messages:[],selected_skills:[],memories:[],query_observations:[{explanation:'原任务的结果🧪'}],authority_revision:'原授权版本'}};
const body=Buffer.from(JSON.stringify(unicodeEnvelope));
const split=body.indexOf(Buffer.from('中'))+1;
assert.equal((await invokeChunks([body.subarray(0,split),body.subarray(split)])).statusCode,200);
assert.deepEqual(received,unicodeEnvelope,'跨TCP块的中文、检查点参数和上下文不能损坏');
assert.equal((await invokeChunks([...body].map(byte=>Buffer.from([byte])))).statusCode,200);
assert.deepEqual(received,unicodeEnvelope,'三字节中文和四字节字符可跨任意网络块');
const limit=512*1024;
const atLimit=Buffer.concat([body,Buffer.alloc(limit-body.length,0x20)]);
assert.equal((await invokeChunks([atLimit.subarray(0,split),atLimit.subarray(split)])).statusCode,200);
assert.deepEqual(received,unicodeEnvelope,'512KiB边界按原始UTF-8字节判断');
const beforeRejected=byteDeliveries;
assert.equal((await invokeChunks([atLimit,Buffer.from(' ')])).statusCode,500);
assert.equal(byteDeliveries,beforeRejected,'超出字节上限不能进入dispatch');
assert.equal((await invokeChunks([body])).statusCode,200,'拒绝超限请求不能留下会话锁');
console.log(JSON.stringify({passed:true,checks:['UTF-8跨块逐字保留','原SDK调用与上下文保留','512KiB准确字节准入及超限拒绝','拒绝后继续交付'],wireBytes:body.length,byteDeliveries}));

// 交付异常仍走原响应码，宿主finish失败保留路径/类别，不能把正文或异常原文写入日志。
const privateText='SYNTHETIC_PRIVATE_FINISH_CONTENT';
const diagnosticEnvelope={...envelope};
const diagnosticServer=createDeliveryServer('http://127.0.0.1:1',token,async(run,apiUrl,secret)=>{
 await new RustTransport(run,apiUrl,secret).post('/internal/finish','FinishRun',{
  run_id:run.run_id,lease_epoch:run.lease_epoch,commit_id:run.output_id,final_text:privateText,
  checkpoint:{sdk_version:'1.3.0',entries:[],leaf_id:null},
 });
});
const diagnosticListener=diagnosticServer.listeners('request')[0];
const oldFetch=globalThis.fetch,oldError=console.error,oldDiagnostics=process.env.DATA_AGENT_DIAGNOSTICS,diagnostics=[],logged=[];
try{
 process.env.DATA_AGENT_DIAGNOSTICS='1';
 globalThis.fetch=async()=>{throw new DOMException(privateText,'TimeoutError');};
 console.error=line=>{logged.push(line);if(line.startsWith('{'))diagnostics.push(JSON.parse(line));};
 const response={statusCode:200,body:'',writeHead(status){this.statusCode=status;return this;},end(body=''){this.body=body;return this;}};
 await diagnosticListener({url:'/resume-and-deliver',method:'POST',headers:{authorization:'Bearer '+token},async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify(diagnosticEnvelope));}},response);
 assert.equal(response.statusCode,500);assert.deepEqual(JSON.parse(response.body),{code:'unexpected_error'});
 assert.equal(diagnostics.length,1,'原bridge失败日志应包含一份受控诊断');
 assert.equal(diagnostics[0].event,'bridge_failed');assert.equal(diagnostics[0].run_id,envelope.run_id);
 assert.equal(diagnostics[0].stage,'finish');assert.equal(diagnostics[0].path,'/internal/finish');
 assert.equal(diagnostics[0].reason,'timeout');assert.equal(diagnostics[0].error_kind,'TimeoutError');
 assert.equal(diagnostics[0].http_status,null);assert.ok(diagnostics[0].elapsed_ms>=0);
 assert.ok(!logged.join('\n').includes(privateText));assert.ok(!logged.join('\n').includes(token));
}finally{globalThis.fetch=oldFetch;console.error=oldError;if(oldDiagnostics===undefined)delete process.env.DATA_AGENT_DIAGNOSTICS;else process.env.DATA_AGENT_DIAGNOSTICS=oldDiagnostics;}
console.log(JSON.stringify({passed:true,checks:['finish宿主错误经Bridge保留固定路径、阶段、类型和受控原因，原响应码与敏感信息边界保持'],officialRequests:0,databaseUsed:false}));

// 经真实deliver的恢复与SDK运行时入口抛出，验证阶段来自实际调用点而非Error正文。
const runtimeCreate = ModelRuntime.create;
for (const sample of [
 {stage:'checkpoint_restore',checkpoint:{sdk_version:'1.3.0',entries:[{private:privateText}],leaf_id:null}},
 {stage:'model_runtime',failure:new Error(privateText)},
 {stage:'model_runtime',failure:new TypeError(privateText)},
 {stage:'model_runtime',failure:new Error('model_timeout'),code:'model_timeout'},
]) {
 const failures=[],originalError=console.error,originalFetch=globalThis.fetch;
 let networkAttempts=0;
 const target=createDeliveryServer('http://127.0.0.1:1',token,deliver);
 try {
  if(sample.failure)ModelRuntime.create=async()=>{throw sample.failure;};
  console.error=line=>failures.push(JSON.parse(line));
  globalThis.fetch=async()=>{networkAttempts++;throw new Error(privateText);};
  const response={statusCode:200,body:'',writeHead(status){this.statusCode=status;return this;},end(body=''){this.body=body;return this;}};
  await target.listeners('request')[0]({url:'/resume-and-deliver',method:'POST',headers:{authorization:'Bearer '+token},
   async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify({...envelope,checkpoint:sample.checkpoint??null}));}},response);
  assert.equal(response.statusCode,500,'异常不得提交为finished');
  assert.deepEqual(JSON.parse(response.body),{code:sample.code??'unexpected_error'});
  assert.equal(failures.length,1);
  assert.equal(failures[0].stage,sample.stage,'普通Error须能定位真实交付阶段');
  assert.equal(failures[0].call_site,'deliver.'+sample.stage,'稳定调用点不含异常自由文本');
  assert.equal(failures[0].error_kind,sample.failure?.name??'Error');
  assert.equal(failures[0].run_id,envelope.run_id);
  assert.ok(!JSON.stringify(failures).includes(privateText));
  assert.ok(!JSON.stringify(failures).includes(token));
  assert.ok(!response.body.includes(privateText));
  assert.equal(networkAttempts,0);
 } finally {ModelRuntime.create=runtimeCreate;console.error=originalError;globalThis.fetch=originalFetch;}
}
console.log(JSON.stringify({passed:true,checks:['真实deliver恢复/SDK运行时普通异常定位、受控码保真、秘密/资料零泄漏且不伪造finished'],officialRequests:0,databaseUsed:false}));

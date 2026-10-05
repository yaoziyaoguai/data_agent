import assert from 'node:assert/strict';
import { createDeliveryServer } from '../../apps/agent/transport/server.ts';
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

import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';

// 通用字符hash向量只验证协议/索引行为，不作为模型召回质量证据。
export async function embeddingProvider(){
 const requests=[];let mode='ok', delay=0, onRequest=()=>{};
 const server=createServer(async(req,res)=>{
  let raw='';for await(const p of req)raw+=p;const body=JSON.parse(raw);
  requests.push(body);await onRequest(body);assert.equal(body.model,'qwen3.7-text-embedding');assert.equal(body.dimensions,1024);
  assert.ok(body.input.length>0&&body.input.length<=20);
  const bytes=body.input.reduce((s,t)=>s+Buffer.byteLength(t),0);assert.ok(bytes<=8192);
  assert.ok(body.input.every(t=>!/^query: |^passage: /.test(t)));
  if(delay)await new Promise(r=>setTimeout(r,delay));
  if(mode==='lost'){res.destroy();return;}
  const data=body.input.map((text,index)=>{
   const embedding=Array(1024).fill(0);const chars=[...text];
   for(let i=0;i<chars.length;i++){
    const key=chars.slice(i,i+2).join('');const hash=createHash('sha256').update(key).digest();
    embedding[hash.readUInt16LE(0)%1024]+=1;
   }
   if(mode==='dimension')embedding.pop();
   return {index,embedding};
  }).reverse();
  const usage=mode==='usage'?{}:{total_tokens:Math.max(1,Math.floor(bytes/3)+15*body.input.length)};
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data,usage}));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return {requests,onRequest(fn){onRequest=fn;},setMode(value){mode=value;},setDelay(value){delay=value;},
  env:{DATA_AGENT_EMBEDDING_URL:'http://127.0.0.1:'+server.address().port+'/embeddings',DATA_AGENT_EMBEDDING_TEST:'1',DATA_AGENT_EMBEDDING_PROFILE:JSON.stringify({trial_id:'embedding_'+randomUUID(),call_limit:10000,cost_limit_micros:'1000000'})},
  async close(){server.closeAllConnections();await new Promise(r=>server.close(r));}
 };
}

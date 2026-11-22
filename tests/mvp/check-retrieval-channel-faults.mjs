import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import net from 'node:net';
import {readFile, writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {validateContract} from '../../packages/contracts/validate.ts';
import {harness, until} from './harness.mjs';
import {embeddingProvider} from './embedding-provider.mjs';

// 05切片5「回源与故障」的通道故障与调用期限反例：
// ①BM25/dense单路失败不抹另一路（通道空≠不可用，单路不可用≠整体unavailable）；
// ②嵌入不可用不阻止已能执行的BM25/exact（词法通道照常召回）；
// ③一次调用统一10秒截止：单路拖过期限按本路不可用计，另一路照常交付，
//   不保留旧2秒总超时；
// ④候选上限按正式合同合计1000如实报告；
// ⑤允许集两片中仅健康片可交付正文时，正式工具保存partial且不启SQL；
// ⑥真实BM25后页等待期间，就绪dense必须经owner读取并进入正式保存回执；
// ⑦同owner后到entry补读、SQL及时替代词法、SQL/dense同规范record复用均走正式回执；
// ⑧切片4 v2覆盖原因：SQL截词只在SQL实际参与时bounded（含恢复窗）、成功空不启
//   SQL、部分分片失败available+channel_unavailable并存、整路失败unavailable、
//   已证滞后index_lag、期限未核完只报deadline不虚构lag。
const provider = await embeddingProvider();
const collection = 'da_faults_'+randomUUID().replaceAll('-','');
const token = (await readFile('.local/infra/milvus-root-password','utf8')).trim();
const profile = {provider_id:'deepseek',model_id:'deepseek-flash',trial_id:'faults_'+randomUUID(),price_version:'2026-10-04-peak-usd',input_limit:65536,output_limit:4096,trial_call_limit:200,trial_cost_micros:'1000000',request_call_limit:24,toolset:'data',payload_bytes_limit:131072};
let h, run, passed=false;
const checks=[];
const observations={};
const ok = response => {assert.equal(response.status,200,JSON.stringify(response.value));return response.value;};
const milvus = async (action, input={}) => {
  const response=await fetch('http://127.0.0.1:19531/v2/vectordb/'+action, {method:'POST',headers:{authorization:'Bearer root:'+token,'content-type':'application/json'},body:JSON.stringify({collectionName:collection,dbName:'default',...input})});
  const value=await response.json();assert.equal(value.code,0,JSON.stringify(value));return value.data;
};

// 新反例只向真实Milvus注入HTTP故障/延迟，不制造查询结果；原成功空断言保留。
let mode=null, phase='existing', partialTargetId=null, delayedPage=null, scenario=null;
let eventOrder=0;
const gate=()=>{
 let release;
 const ready=new Promise(resolve=>{release=resolve;});
 return {release,openedBy:null,timedOut:false,
  open(event){if(!this.openedBy)this.openedBy=event;release();},
  async wait(){
   let timer;
   try{await Promise.race([ready,new Promise(resolve=>{
    timer=setTimeout(()=>{this.timedOut=true;resolve();},6500);
   })]);}finally{clearTimeout(timer);}
  }};
};
const searchLog=[];
// 覆盖核验持有：扣住真实请求帧直到释放；释放时必须向持有连接回放被扣帧
// （lease脚本同一模式），只扣不放会毒化该连接并悬挂后续请求。
const coverageHold={released:true,armed:false,frames:[],upstream:null};
const armCoverageHold=()=>{coverageHold.released=false;coverageHold.armed=false;coverageHold.frames.length=0;coverageHold.upstream=null;};
const releaseCoverageHold=()=>{
  coverageHold.released=true;coverageHold.armed=false;
  const upstream=coverageHold.upstream;coverageHold.upstream=null;
  const frames=coverageHold.frames;coverageHold.frames=[];
  if(upstream)for(const frame of frames)upstream.write(frame);
};
const pageQuery='laterpageprobe';
const pageBody='ownerreadtarget：合成设备必须完成校准复核后才能投入使用。';
const allowedIds=filter=>JSON.parse(/object_id in (\[[^\]]*\])/.exec(filter)?.[1]||'[]');
const proxy=createServer(async(req,res)=>{
 let event;
 try{
  const requestMode=mode, requestPhase=phase, page=delayedPage, fixture=scenario;
  let body='';req.setEncoding('utf8');for await(const part of req)body+=part;
  if(req.url.endsWith('/search')){
   const parsed=JSON.parse(body);
   const target=parsed.annsField==='sparse'?'sparse':parsed.annsField==='vector'?'dense':null;
   if(target){
    event={phase:requestPhase,channel:target,filter:parsed.filter,offset:parsed.offset||0,
      limit:parsed.limit,collection:parsed.collectionName,consistency:parsed.consistencyLevel,
      ids:[],objectIds:[],startedAt:Date.now(),injected:false};
    searchLog.push(event);
   }
   const failedShard=target==='sparse'&&requestPhase==='partial-shard'
     &&!allowedIds(parsed.filter).includes(partialTargetId);
   if(failedShard||(target&&requestMode===target+'-fail')){
    if(fixture?.phase===requestPhase&&target==='sparse'&&fixture.beforeSparseFailure){
     await fixture.beforeSparseFailure.wait();
     event.waitTimedOut=fixture.beforeSparseFailure.timedOut;
    }
    Object.assign(event,{status:503,injected:true,respondedAt:Date.now(),respondedOrder:++eventOrder});
    res.writeHead(503,{'content-type':'application/json'}).end('{"code":1}');return;
   }
   if(target&&requestMode===target+'-empty'){
    Object.assign(event,{status:200,code:0,injected:true,respondedAt:Date.now()});
    res.writeHead(200,{'content-type':'application/json'}).end('{"code":0,"data":[]}');return;
   }
   if(target&&requestMode===target+'-delay')await new Promise(r=>setTimeout(r,11000));
  }
  const remote=await fetch('http://127.0.0.1:19531'+req.url,{method:'POST',headers:{'content-type':'application/json',authorization:req.headers.authorization},body});
  const result=await remote.text();
  if(event){
   const output=JSON.parse(result);
   Object.assign(event,{status:remote.status,code:output.code,upstreamAt:Date.now(),
     ids:(output.data||[]).map(row=>row.id),objectIds:(output.data||[]).map(row=>row.object_id),
     rows:(output.data||[]).map(row=>({id:row.id,object_id:row.object_id,version:row.object_version,
       entry_id:row.entry_id,path:row.entry_path,offset:row.char_offset,length:row.char_length,
       content_hash:row.content_hash,distance:row.distance}))});
   if(fixture?.phase===requestPhase&&event.channel==='dense'&&fixture.beforeDense){
    await fixture.beforeDense.wait();
    event.waitTimedOut=fixture.beforeDense.timedOut;
   }
   if(requestPhase==='slow-later-page'&&event.channel==='sparse'&&event.offset>0){
    // 后页已真实请求并取得Milvus响应，再延迟传回；此事件才放行查询Embedding。
    page.startedAt=Date.now();page.releaseEmbedding();
    event.delayedMs=5000;
    await new Promise(r=>setTimeout(r,event.delayedMs));
   }
   event.respondedAt=Date.now();event.respondedOrder=++eventOrder;
  }
  res.writeHead(remote.status,{'content-type':'application/json'}).end(result);
 }catch(error){
  if(event)Object.assign(event,{status:503,error:error.message,respondedAt:Date.now()});
  res.writeHead(503,{'content-type':'application/json'}).end('{"code":1}');
 }
});
await new Promise(r=>proxy.listen(0,'127.0.0.1',r));

// 仅观察透明MySQL协议：识别SQL后备查询及含独占正文的owner返回，不记录SQL/凭据。
const databaseEvents=[], sockets=new Set();
const packets=observe=>{
 let pending=Buffer.alloc(0);
 return chunk=>{
  pending=Buffer.concat([pending,chunk]);
  while(pending.length>=4){
   const length=pending.readUIntLE(0,3);
   if(pending.length<length+4)break;
   observe(pending.subarray(4,length+4),pending[3]);pending=pending.subarray(length+4);
  }
 };
};
const sqlProxy=net.createServer(socket=>{
 const upstream=net.connect(13306,'127.0.0.1');
 for(const connection of [socket,upstream]){
  sockets.add(connection);connection.on('error',()=>{});
  connection.on('close',()=>sockets.delete(connection));
 }
 socket.on('close',()=>upstream.destroy());upstream.on('close',()=>socket.destroy());
 // prepare→execute与结果终止帧沿真实连接关联，不把“发了SQL”当“首批已就绪”。
 const statements=new Map();
 let preparing, current, authenticated=false, clientHello=false, deprecateEof=false;
 const lenenc=(buffer,state)=>{
  const first=buffer[state.offset++];
  if(first<0xfb)return first;
  const bytes=first===0xfc?2:first===0xfd?3:first===0xfe?8:0;
  assert.ok(bytes,'观察字段必须使用有效长度编码');
  const length=bytes===8?Number(buffer.readBigUInt64LE(state.offset)):buffer.readUIntLE(state.offset,bytes);
  state.offset+=bytes;return length;
 };
 const stringAt=(buffer,state)=>{
  const length=lenenc(buffer,state), value=buffer.subarray(state.offset,state.offset+length).toString('utf8');
  state.offset+=length;return value;
 };
 const column=payload=>{
  const state={offset:0};let name;
  for(let i=0;i<6;i++){const value=stringAt(payload,state);if(i===4)name=value;}
  lenenc(payload,state);
  return {name,type:payload[state.offset+6],unsigned:!!(payload.readUInt16LE(state.offset+7)&0x20)};
 };
 const sqlRow=(payload,columns,binary)=>{
  const state={offset:binary?1+Math.ceil((columns.length+2)/8):0}, row={};
  for(const [index,field] of columns.entries()){
   if(binary?!!(payload[1+Math.floor((index+2)/8)]&(1<<((index+2)%8))):payload[state.offset]===0xfb){
    row[field.name]=null;if(!binary)state.offset++;continue;
   }
   const bytes=binary?({1:1,2:2,3:4,8:8,9:4}[field.type]):0;
   if(bytes){
    row[field.name]=bytes===8?Number(field.unsigned?payload.readBigUInt64LE(state.offset):payload.readBigInt64LE(state.offset))
      :field.unsigned?payload.readUIntLE(state.offset,bytes):payload.readIntLE(state.offset,bytes);
    state.offset+=bytes;
   }else{
    assert.ok(!binary||[0x0f,0xf5,0xfc,0xfd,0xfe].includes(field.type),'SQL观察只接受当前候选查询的整数/字符串列');
    row[field.name]=stringAt(payload,state);
   }
  }
  assert.equal(state.offset,payload.length,'候选行必须完整解码，不能把列定义或EOF当数据');
  return row;
 };
 // owner正文读取现从knowledge_objects当前版直接定位（陈述路径经located JOIN），
 // 不再以FROM knowledge_versions v,JSON_TABLE开头；以正文页列content_page锚定，
 // 排除同前缀的陈述坐标映射查询（只回entry_id/base/chars，无正文）。
 const classify=sql=>({coverage:/FROM knowledge_objects k LEFT JOIN knowledge_index_jobs/.test(sql),
  fallback:/\bWITH\s+query_terms\s+AS\b/i.test(sql),
  source:sql.includes('FROM knowledge_objects AS k FORCE INDEX')?'knowledge':'retrieval',
  owner:sql.startsWith("SELECT JSON_OBJECT('entry_id'")&&sql.includes("'content_page'")});
 const clientPackets=packets(payload=>{
  if(!authenticated){
   if(!clientHello&&payload.length>=4){clientHello=true;deprecateEof=!!(payload.readUInt32LE(0)&0x01000000);}
   return;
  }
  if(payload[0]===0x16){preparing=classify(payload.subarray(1).toString('utf8'));return;}
  if(payload[0]===0x19&&payload.length>=5){statements.delete(payload.readUInt32LE(1));return;}
  if(payload[0]!==0x03&&payload[0]!==0x17)return;
  const statement=payload[0]===0x03?classify(payload.subarray(1).toString('utf8')):statements.get(payload.readUInt32LE(1));
  current=null;
  // R13期限反例：覆盖核验COUNT在持有期间不发往MySQL，由调用自身期限截断。
  if(statement?.coverage&&phase==='r13-coverage-hold'&&!coverageHold.released)coverageHold.armed=true;
  const fixture=scenario?.phase===phase?scenario:null;
  if(statement?.fallback){
   const event={phase,kind:'sql-fallback',source:statement.source,at:Date.now(),order:++eventOrder,rows:0,fixtureRows:[]};
   databaseEvents.push(event);current={event,fixture,binary:payload[0]===0x17};
  }else if(statement?.owner&&fixture&&payload.includes(Buffer.from(fixture.object.id))){
   const event={phase,kind:'owner-content',objectId:fixture.object.id,
    entryIds:fixture.object.entries.filter(entry=>payload.includes(Buffer.from(entry.entry_id))).map(entry=>entry.entry_id),
    contents:[],at:Date.now(),order:++eventOrder,rows:0};
   databaseEvents.push(event);current={event,fixture,binary:payload[0]===0x17};
  }
 });
 const serverPackets=packets((payload,sequence)=>{
  if(!authenticated){if(clientHello&&payload[0]===0)authenticated=true;return;}
  if(preparing&&sequence===1){
   if(payload[0]===0&&payload.length>=5)statements.set(payload.readUInt32LE(1),preparing);
   preparing=null;
  }
  if(phase==='slow-later-page'&&/"effective_value"\s*:\s*"ownerreadtarget：/.test(payload.toString('utf8')))
   databaseEvents.push({phase,kind:'owner-content',at:Date.now()});
  if(!current)return;
  const {event,fixture}=current;
  let terminal=payload[0]===0xff;
  if(!current.response){
   terminal ||= payload[0]===0;
   if(!terminal){
    assert.ok(payload[0]<0xfb,'被观察查询的列数须使用单字节编码');
    current.response={columns:payload[0],fields:[],afterColumns:true};
   }
  }else if(current.response.columns>0){
   if(fixture&&event.kind==='sql-fallback')current.response.fields.push(column(payload));
   current.response.columns-=1;
  }
  else if(payload[0]===0xfe&&payload.length<9){
   if(!deprecateEof&&current.response.afterColumns)current.response.afterColumns=false;
   else terminal=true;
  }else if(!terminal){
   event.rows+=1;
   if(fixture&&event.kind==='sql-fallback'){
    const row=sqlRow(payload,current.response.fields,current.binary);
    if(row.id===fixture.object.id)event.fixtureRows.push({objectId:row.id,version:String(row.version),
     entryId:JSON.parse(row.entry_id),path:JSON.parse(row.path),statementId:row.statement_id===null?null:JSON.parse(row.statement_id),
     offset:Number(row.char_offset),length:Number(row.char_length),nameHit:Number(row.name_hit),
     nameTermHits:Number(row.name_term_hits),termHits:Number(row.term_hits)});
   }else if(fixture&&event.kind==='owner-content'){
    for(const entry of fixture.object.entries){
     const expected=fixture.content?.[entry.entry_id]??entry.effective_value;
     if(payload.includes(Buffer.from(JSON.stringify(expected))))event.contents.push(entry.entry_id);
    }
   }
  }
  if(terminal){
   Object.assign(event,{failed:payload[0]===0xff,completedAt:Date.now(),completedOrder:++eventOrder});
   current=null;
   // 回调排到本chunk透传后，门闩只由已收到的真实结果放行；超时放行会令前提失败。
   queueMicrotask(()=>{if(!event.failed){
    if(event.kind==='sql-fallback')fixture?.onSqlReady?.(event);
    else fixture?.onOwnerContent?.(event);
   }});
  }
 });
 socket.on('data',chunk=>{clientPackets(chunk);
  if(coverageHold.armed&&!coverageHold.released){coverageHold.armed=false;coverageHold.frames.push(chunk);coverageHold.upstream=upstream;return;}
  upstream.write(chunk);});
 upstream.on('data',chunk=>{serverPackets(chunk);socket.write(chunk);});
});
await new Promise(r=>sqlProxy.listen(0,'127.0.0.1',r));

const create = async (name,body,related_ids=[],kind='document') => ok(await h.request('/knowledge',{operation_id:randomUUID(),kind,name,body,source_url:null,related_ids}));
const waitIndexed = async ids => {
  await until(() => h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM knowledge_index_jobs WHERE object_id IN (${ids.map(id=>`'${id}'`).join(',')}) AND vector_state<>'indexed'`)[0].n===0,'channel-faults documents indexed',60000);
};
const rows = async id => milvus('entities/query',{filter:`object_id == "${id}" && target == "knowledge_entry"`,outputFields:['id','object_id','object_version','target','kind','space_id','model','projection_version','vector','text','entry_id','entry_path','statement_id','statement_offset','char_offset','char_length','content_hash'],limit:512,consistencyLevel:'Strong'});
const query = async text => ok(await h.request('/knowledge?q='+encodeURIComponent(text)));
const needle='稠密专用非词法标记';
const manager=SessionManager.inMemory('/synthetic/data-agent');
const formalSearch=async(query,limit,scope={})=>{
 const input={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:randomUUID(),
  tool_name:'search_knowledge',arguments:{query,limit,...scope},
  checkpoint:exportCheckpoint(manager,run.workspace_context.authority_revision,run.workspace_context.authority_snapshot)};
 const registration=ok(await h.internal('/internal/data/tool-calls',input));
 const startedAt=Date.now();
 const receipt=ok(await h.internal('/internal/data/tools',input));
 const returnedAt=Date.now();
 const saved=h.sql(`SELECT JSON_OBJECT('state',state,'receipt',receipt) FROM tool_calls
   WHERE sdk_tool_call_id='${input.sdk_tool_call_id}' AND origin_run_id='${run.run_id}'`);
 assert.equal(saved.length,1,'正式登记只对应一份工具回执');
 assert.equal(saved[0].state,'succeeded');
 assert.equal(receipt.operation_id,registration.operation_id);
 assert.deepEqual(saved[0].receipt,receipt,'HTTP结果须等于正式裁剪保存的回执');
 assert.equal(receipt.data.reply_coverage.returned_object_count,receipt.data.objects.length);
 return {data:receipt.data,operationId:receipt.operation_id,startedAt,returnedAt};
};
const embedOf=async text=>{
 const response=await fetch(provider.env.DATA_AGENT_EMBEDDING_URL,{method:'POST',
  headers:{'content-type':'application/json'},
  body:JSON.stringify({model:'qwen3.7-text-embedding',dimensions:1024,input:[text]})});
 assert.equal(response.status,200);
 return (await response.json()).data.find(value=>value.index===0).embedding;
};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const projection='knowledge-statement-window-3';
const recordId=(object,entry,offset=0)=>digest([projection,'demo',object.id,object.version,
 entry.entry_id,entry.path,null,offset]);
const createMetricEntries=async(name,entries,kind='metric')=>{
 const object=await create(name,'合成初始内容',[],kind);
 object.entries=entries.map(({entry_id,effective_value})=>({entry_id,path:entry_id,label:'规则',effective_value,
  source_facts:{complete:false,gap:'从零合成的通道正式反例'},suggestion:{},human_override:null,review_state:'unverified'}));
 const encoded=Buffer.from(JSON.stringify(object)).toString('hex');
 const body=`CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON)`;
 h.sql(`UPDATE knowledge_objects SET body=${body} WHERE id='${object.id}';
  UPDATE knowledge_revisions SET archived_body=${body} WHERE object_id='${object.id}' AND version=1;
  INSERT INTO retrieval_documents(object_id,space_id,version,body) VALUES('${object.id}','demo',1,${body})
   ON DUPLICATE KEY UPDATE version=VALUES(version),body=VALUES(body)`);
 return object;
};
const indexedEntries=async object=>{
 await h.resumeWorker();await waitIndexed([object.id]);await h.pauseWorker();
 const indexed=await rows(object.id);
 assert.equal(indexed.length,object.entries.length,'每个合成entry小于280字符，恰好一个真实规范record');
 for(const entry of object.entries){
  assert.ok([...entry.effective_value].length>0&&[...entry.effective_value].length<280);
  const found=indexed.filter(row=>row.entry_id===entry.entry_id);
  assert.equal(found.length,1,'各entry只有独立的一个实际索引record');
  assert.equal(found[0].id,recordId(object,entry),'规范身份按已确认投影/owner/修订/entry/path/原offset独立计算');
  assert.equal(found[0].object_id,object.id);assert.equal(String(found[0].object_version),object.version);
  assert.equal(found[0].projection_version,projection);assert.equal(found[0].entry_path,entry.path);
  assert.ok(!found[0].statement_id);assert.equal(found[0].char_offset,0);
  assert.equal(found[0].char_length,[...entry.effective_value].length);
  assert.equal(found[0].content_hash,digest(entry.effective_value));
 }
 return indexed;
};
const formalRead=async args=>{
 const input={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:randomUUID(),
  tool_name:'read_knowledge',arguments:args,
  checkpoint:exportCheckpoint(manager,run.workspace_context.authority_revision,run.workspace_context.authority_snapshot)};
 const registration=ok(await h.internal('/internal/data/tool-calls',input));
 const receipt=ok(await h.internal('/internal/data/tools',input));
 const saved=h.sql(`SELECT JSON_OBJECT('state',state,'receipt',receipt) FROM tool_calls
  WHERE sdk_tool_call_id='${input.sdk_tool_call_id}' AND origin_run_id='${run.run_id}'`);
 assert.equal(saved.length,1);assert.equal(saved[0].state,'succeeded');
 assert.equal(receipt.operation_id,registration.operation_id);
 assert.deepEqual(saved[0].receipt,receipt,'补读也核对正式裁剪保存的回执');
 return {data:receipt.data,operationId:receipt.operation_id};
};

try {
  h=await harness({capture:true,profile,startWorker:false,
    onDatabaseUrl:value=>{
      const url=new URL(value.replace('@127.0.0.1:13306/','@127.0.0.1:'+sqlProxy.address().port+'/'));
      url.searchParams.set('ssl-mode','DISABLED');return url.toString();
    },
    env:{...provider.env,DATA_AGENT_LEASE_MS:'120000',DATA_AGENT_VECTOR_URL:'http://127.0.0.1:'+proxy.address().port,DATA_AGENT_VECTOR_COLLECTION:collection,DATA_AGENT_VECTOR_TOKEN_FILE:process.cwd()+'/.local/infra/milvus-root-password'}});
  ok(await h.request('/knowledge-index/rebuilds',{operation_id:randomUUID()}));
  const lexRule='珍本外借必须由两名馆员共同登记，外借期限最长三天。';
  const lexDoc=await create('稀疏通道命中资料',lexRule);
  const denseDoc=await create('稠密专用资料','常规说明正文，不含查询标记词，仅用于稠密通道验证。');
  const embedDoc=await create('嵌入故障词法资料','常规说明正文，词法标记仅存在于索引行。');
  await h.resumeWorker();await waitIndexed([lexDoc.id,denseDoc.id,embedDoc.id]);await h.pauseWorker();
  // 稠密专用：行向量替换为查询词的协议向量（确定性替身），正文不含查询词，
  // 词法两路（SQL与Milvus稀疏）都不命中——只有dense通道能召回。
  const forced=await fetch(provider.env.DATA_AGENT_EMBEDDING_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'qwen3.7-text-embedding',dimensions:1024,input:[needle]})});
  assert.equal(forced.status,200);
  const needleVector=(await forced.json()).data.find(v=>v.index===0).embedding;
  const denseRows=await rows(denseDoc.id);assert.ok(denseRows.length>0);
  await milvus('entities/upsert',{data:denseRows.map(row=>({...row,vector:needleVector}))});
  // lexDoc行向量替换为lexRule查询的协议向量：同一entry身份在词法与dense两通道
  // 都命中，供预算跨通道去重断言。
  const ruleForced=await fetch(provider.env.DATA_AGENT_EMBEDDING_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'qwen3.7-text-embedding',dimensions:1024,input:[lexRule]})});
  assert.equal(ruleForced.status,200);
  const ruleVector=(await ruleForced.json()).data.find(v=>v.index===0).embedding;
  const lexRows=await rows(lexDoc.id);assert.ok(lexRows.length>0);
  await milvus('entities/upsert',{data:lexRows.map(row=>({...row,vector:ruleVector}))});
  // 嵌入故障：索引行text换成正文没有的稀疏标记——嵌入失败时若词法通道照常
  // 执行，只有Milvus稀疏路能按标记召回该对象。
  const embedMarker='嵌入故障稀疏独占标记';
  const embedRows=await rows(embedDoc.id);assert.ok(embedRows.length>0);
  await milvus('entities/upsert',{data:embedRows.map(row=>({...row,text:embedMarker}))});

  const base=await query(lexRule);
  assert.ok(base.objects.some(o=>o.id===lexDoc.id));
  assert.equal(base.search_coverage.vector_state,'available');
  assert.equal(base.search_coverage.candidate_limit,1000,'候选上限按合同合计1000如实报告');
  assert.equal(base.retrieval_mode,'hybrid_authoritative');

  mode='sparse-fail';
  const denseOnly=await query(needle);
  assert.ok(denseOnly.objects.some(o=>o.id===denseDoc.id),'BM25失败不得抹掉dense成功结果');
  assert.equal(denseOnly.search_coverage.vector_state,'available','单路失败按部分可用如实报告');
  assert.equal(denseOnly.search_coverage.state,'bounded','未覆盖通道必须bounded');
  const lexSurvives=await query(lexRule);
  assert.ok(lexSurvives.objects.some(o=>o.id===lexDoc.id));
  assert.equal(lexSurvives.search_coverage.vector_state,'available');
  checks.push('BM25稀疏路失败：dense命中照常交付，词法SQL候选不受牵连，整体如实部分可用');

  mode='dense-fail';
  const lexHit=await query(lexRule);
  assert.ok(lexHit.objects.some(o=>o.id===lexDoc.id),'dense失败不得抹掉BM25成功结果');
  assert.equal(lexHit.search_coverage.vector_state,'available');
  assert.equal(lexHit.search_coverage.state,'bounded');
  mode=null;
  checks.push('dense失败：BM25命中与SQL词法候选照常交付，整体如实部分可用');

  // 05接续：成功空与不可用分开。索引滞后对象（worker暂停下创建，正文含独占词，
  // 不在Milvus）在稀疏路成功空时不经SQL补扫交付；稀疏路真失败（不可用）时同一
  // 对象必须经SQL后备词法路召回——后备路按通道状态启用，不再有第二条内存重排链。
  const lagMarker='滞后补扫专用标记词';
  const lagDoc=await create('索引滞后资料','正文包含'+lagMarker+'的说明，用于区分成功空与不可用。');
  mode='sparse-empty';
  const lagEmpty=await query(lagMarker);
  assert.ok(!lagEmpty.objects.some(o=>o.id===lagDoc.id),'BM25成功空不得经SQL补扫交付滞后对象');
  assert.equal(lagEmpty.search_coverage.vector_state,'available','成功空按可用如实报告');
  mode='sparse-fail';
  const sqlRequestsBefore=databaseEvents.filter(event=>event.kind==='sql-fallback').length;
  const lagFallback=await query(lagMarker);
  assert.ok(lagFallback.objects.some(o=>o.id===lagDoc.id),'BM25不可用时SQL后备词法路召回滞后对象');
  assert.equal(lagFallback.search_coverage.vector_state,'available');
  assert.ok(databaseEvents.filter(event=>event.kind==='sql-fallback').length>sqlRequestsBefore,
    'MySQL观察正控须捕获真实SQL后备，随后零请求断言才有效');
  mode=null;
  checks.push('成功空与不可用分开：BM25成功空不触发SQL补扫，真失败时后备词法路召回滞后对象');

  // 05接续：共同候选预算的可观测证据。请求前按剩余额度分配（每条请求limit不
  // 超过剩余额度，首批max(50,5*limit)）；唯一记录身份跨通道/跨轮去重计入
  // candidate_count（lexDoc两通道同身份命中不重复计）；轮次含首轮≤5。本夹具
  // 两通道返回数都少于各自额度，说明该深度已见底：不再空转扩轮，如实报穷举。
  // 此夹具不证明满页后的深度推进；ranking的1200行例只证明SQL先排再截。
  searchLog.length=0;
  const budgeted=await query(lexRule);
  const requests=searchLog.slice();
  assert.ok(requests.length>=2,'词法与dense各执行首轮：'+requests.length);
  assert.ok(requests.every(r=>r.limit<=1000),'请求额度不得超过共享上限1000');
  assert.ok(requests.some(r=>r.limit===150),'浏览查询limit=30时首批max(50,5*limit)=150');
  const lexicalIds=new Set(requests.filter(r=>r.channel==='sparse').flatMap(r=>r.ids));
  const denseIds=new Set(requests.filter(r=>r.channel==='dense').flatMap(r=>r.ids));
  assert.ok(lexicalIds.size>0&&denseIds.size>0,'两通道都必须有实际命中');
  const overlapIds=[...lexicalIds].filter(id=>denseIds.has(id));
  assert.ok(overlapIds.length>0,'夹具须在两通道产生同一entry身份命中');
  const uniqueIds=new Set([...lexicalIds,...denseIds]);
  const totalRows=requests.reduce((sum,r)=>sum+r.ids.length,0);
  assert.equal(budgeted.search_coverage.candidate_count,uniqueIds.size,'candidate_count按唯一身份跨通道去重');
  assert.ok(budgeted.search_coverage.candidate_count<totalRows,'重复身份不重复计入预算');
  const lex=budgeted.search_coverage.channels.lexical;
  const den=budgeted.search_coverage.channels.dense;
  assert.equal(lex.rounds,1,'未满页的通道已见底，不空转扩轮');
  assert.equal(den.rounds,1);
  assert.ok(lex.rounds<=5&&den.rounds<=5,'轮次含首轮最多5轮');
  assert.equal(lex.exhausted,true,'末轮未满页（7命中<150额度）即该通道穷举');
  assert.equal(lex.uncovered,null,'穷举通道不得报未覆盖');
  assert.equal(den.exhausted,true);
  assert.equal(den.uncovered,null);
  assert.equal(lex.shards,1);assert.equal(lex.completed,1);
  checks.push('共同候选预算：请求前分配额度、唯一身份跨通道去重、轮次≤5、见底不空转且穷举/未覆盖分开');

  provider.setMode('lost');
  const embedDown=await query(embedMarker);
  provider.setMode('ok');
  assert.ok(embedDown.objects.some(o=>o.id===embedDoc.id),'嵌入不可用必须保留能执行的BM25通道');
  assert.equal(embedDown.search_coverage.vector_state,'available');
  assert.equal(embedDown.search_coverage.state,'bounded');
  checks.push('嵌入不可用：BM25/exact照常执行并召回仅词法可达对象，不再整路清空');

  mode='sparse-delay';
  const started=performance.now();
  const delayed=await query(needle);
  const elapsed=performance.now()-started;
  mode=null;
  assert.ok(delayed.objects.some(o=>o.id===denseDoc.id),'期限到按本路不可用计，另一路照常交付');
  assert.equal(delayed.search_coverage.vector_state,'available');
  assert.ok(elapsed<=11500,'一次调用统一截止约10秒：'+Math.round(elapsed)+'ms');
  checks.push('统一调用期限：单路拖过10秒按该路不可用收尾，dense结果交付，无逐批重置期限');

  // 05接续：慢嵌入不饿死词法路。嵌入替身延迟11秒（拖过10秒共享期限）：嵌入沿
  // 原身份按unknown收尾且不重复发送；词法路与嵌入并行，最终交付BM25正文；
  // dense无查询向量按本路不可用计，整体如实bounded。查询文本取全新组合避开
  // 共享嵌入缓存，保证本次真实发送。本例尚未证明正文在期限内读到，
  // 元信息/owner读取的期限与时序须由接续包补充独立反例。
  const slowQuery=lexRule+'（慢嵌入限定）';
  const unknownBefore=h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM model_call_attempts WHERE purpose='knowledge_embedding' AND state='unknown'`)[0].n;
  const issuedBefore=h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM model_call_attempts WHERE purpose='knowledge_embedding' AND state='issued'`)[0].n;
  const sendsBefore=provider.requests.length;
  provider.setDelay(11000);
  const slowStarted=performance.now();
  const slow=await query(slowQuery);
  const slowElapsed=performance.now()-slowStarted;
  provider.setDelay(0);
  assert.ok(slow.objects.some(o=>o.id===lexDoc.id),'慢嵌入不得饿死词法路：BM25正文必须交付');
  assert.equal(slow.search_coverage.vector_state,'available');
  assert.equal(slow.search_coverage.state,'bounded','dense无查询向量按本路不可用计');
  assert.ok(slowElapsed>=9500&&slowElapsed<=10800,'嵌入共享期限截断：'+Math.round(slowElapsed)+'ms');
  assert.equal(provider.requests.length,sendsBefore+1,'不得换身份重复发送嵌入');
  assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM model_call_attempts WHERE purpose='knowledge_embedding' AND state='unknown'`)[0].n,unknownBefore+1,'原账本按unknown收尾');
  // 本场景查询嵌入的结算相对搜索回执异步落库（期限截断后数毫秒内commit），按
  // 有界等待核销且只约束不新增issued——worker被SIGTERM暂停时在途的entry嵌入
  // 会留孤儿issued行，属确定性回执行收敛范围，不是搜索路径丢结算。
  await until(()=>h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM model_call_attempts WHERE purpose='knowledge_embedding' AND state='issued'`)[0].n<=issuedBefore,
    '本场景嵌入账本不得新增残留issued',8000);
  checks.push('慢嵌入：账本按unknown收尾不重复发送，词法正文仍交付，dense按本路不可用计');

  // 第3节：失败片只结束自己；健康BM25成功后不能启动SQL或给其再投一票。
  // 目标的查询词只在真实索引text中，SQL哨兵只在正式正文/SQL投影中。
  const shardQuery='shardonlyprobe';
  const shardBody='healthyshardbody：合成馆藏只能在双人登记完成后外借。';
  const shardTarget=await create('分片健康正文',shardBody,[],'metric');
  await h.resumeWorker();await waitIndexed([shardTarget.id]);await h.pauseWorker();
  const shardRows=(await rows(shardTarget.id)).filter(row=>!row.statement_id);
  assert.equal(shardRows.length,1,'短正文只有一个真实规范索引片段');
  await milvus('entities/upsert',{data:shardRows.map(row=>({...row,text:shardQuery}))});
  const ghost=await create('后页旧版资料','初始化',[],'metric');
  ghost.entries=Array.from({length:51},(_,i)=>({entry_id:'old-'+i,path:'old-'+i,label:'正文',
    effective_value:pageQuery+' 合成旧版片段 '+i+'。',
    source_facts:{complete:false,gap:'独立合成后页夹具'},suggestion:{},human_override:null,review_state:'unverified'}));
  const ghostEncoded=Buffer.from(JSON.stringify(ghost)).toString('hex');
  h.sql(`UPDATE knowledge_objects SET body=CAST(CONVERT(0x${ghostEncoded} USING utf8mb4) AS JSON) WHERE id='${ghost.id}';
    UPDATE knowledge_revisions SET archived_body=CAST(CONVERT(0x${ghostEncoded} USING utf8mb4) AS JSON) WHERE object_id='${ghost.id}' AND version=1;
    UPDATE retrieval_documents SET body=CAST(CONVERT(0x${ghostEncoded} USING utf8mb4) AS JSON) WHERE object_id='${ghost.id}'`);
  const pageTarget=await create('后页期间的合法正文',pageBody,[ghost.id],'metric');
  await h.resumeWorker();await waitIndexed([ghost.id,pageTarget.id]);
  run=await h.capture(await h.create(),'核对独立合成检索资料');await h.pauseWorker();
  const ghostRows=await rows(ghost.id), targetRows=await rows(pageTarget.id);
  assert.equal(ghostRows.length,51,'真实索引须有51个独立规范entry，才能形成limit=1的BM25后页');
  assert.equal(targetRows.length,1);
  const pageVector=await embedOf(pageQuery);
  await milvus('entities/upsert',{data:[
    ...ghostRows.map(row=>({...row,vector:pageVector.map(value=>-value)})),
    ...targetRows.map(row=>({...row,vector:pageVector})),
  ]});
  h.sql(`UPDATE knowledge_objects SET version=2,body=JSON_SET(body,'$.version','2') WHERE id='${ghost.id}';
    INSERT INTO knowledge_revisions(object_id,version,archived_body) SELECT id,version,body FROM knowledge_objects WHERE id='${ghost.id}'`);
  const fillers=Array.from({length:200},(_,i)=>({...structuredClone(shardTarget),
    id:'channel-shard-filler-'+String(i).padStart(3,'0'),name:'分片范围填充'+i,
    related_ids:[shardTarget.id],entries:[{entry_id:'body',path:'body',label:'正文',
      effective_value:'合成范围填充材料'+i+'。',source_facts:{complete:false,gap:'独立合成分片夹具'},
      suggestion:{},human_override:null,review_state:'unverified'}]}));
  // 填充对象只形成允许集，没有Milvus行；不为单个分片反例增加200个Embedding任务。
  h.sql(fillers.map(value=>{
    const encoded=Buffer.from(JSON.stringify(value)).toString('hex');
    const body=`CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON)`;
    return `INSERT INTO knowledge_objects(id,space_id,kind,name,version,state,body,source_id,source_version,updated_by)
      VALUES('${value.id}','demo','metric','${value.name}',1,'enabled',${body},NULL,0,'synthetic-test');
      INSERT INTO knowledge_revisions(object_id,version,archived_body) VALUES('${value.id}',1,${body});
      INSERT INTO retrieval_documents(object_id,space_id,version,body) VALUES('${value.id}','demo',1,${body});`;
  }).join('\n'));
  const sqlSentinel=await create('仅SQL可达的分片哨兵',shardQuery+' sqlonlysentinel：不应被SQL补票交付。',[shardTarget.id],'metric');
  const sentinelHex=Buffer.from(JSON.stringify(sqlSentinel)).toString('hex');
  h.sql(`INSERT INTO retrieval_documents(object_id,space_id,version,body)
    VALUES('${sqlSentinel.id}','demo',1,CAST(CONVERT(0x${sentinelHex} USING utf8mb4) AS JSON))`);
  assert.deepEqual(await rows(sqlSentinel.id),[],'SQL哨兵未进入真实Milvus');
  assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM retrieval_documents WHERE object_id='${sqlSentinel.id}'`)[0].n,1,
    'SQL哨兵须实际存在于后备投影');
  partialTargetId=shardTarget.id;phase='partial-shard';
  searchLog.length=0;databaseEvents.length=0;provider.setMode('lost');
  const partial=await formalSearch(shardQuery,2,{related_object_id:shardTarget.id});
  provider.setMode('ok');
  const partialRequests=searchLog.filter(event=>event.phase===phase);
  const sparse=partialRequests.filter(event=>event.channel==='sparse');
  const shards=sparse.map(event=>allowedIds(event.filter));
  const expectedAllowed=[shardTarget.id,sqlSentinel.id,...fillers.map(value=>value.id)];
  observations.partialShard={operationId:partial.operationId,objects:partial.data.objects.map(value=>value.id),
    coverage:partial.data.search_coverage,requests:partialRequests,databaseEvents:databaseEvents.slice()};
  assert.equal(sparse.length,2,'允许集>200须实际派发两个BM25分片');
  assert.deepEqual(shards.map(ids=>ids.length).sort((a,b)=>a-b),[2,200]);
  assert.deepEqual(new Set(shards.flat()),new Set(expectedAllowed),'两分片恰好覆盖同一硬范围允许集');
  const failed=sparse.filter(event=>event.injected&&event.status===503);
  const healthy=sparse.filter(event=>!event.injected&&event.status===200&&event.code===0);
  assert.equal(failed.length,1,'一个实际请求须收到注入的HTTP 503');
  assert.equal(healthy.length,1,'另一片须真实透传Milvus成功');
  assert.ok(!allowedIds(failed[0].filter).includes(shardTarget.id));
  assert.deepEqual(healthy[0].ids,[shardRows[0].id],'合法目标由健康片独占召回');
  assert.equal(partialRequests.filter(event=>event.channel==='dense').length,0,'Embedding不可用隔离dense救回');
  assert.deepEqual(partial.data.objects.map(value=>value.id),[shardTarget.id]);
  assert.ok(partial.data.objects[0].entries.some(value=>value.effective_value===shardBody),
    '健康片正文须经正式登记/执行/回源/最终核验/裁剪保存交付');
  assert.ok(!partial.data.objects.some(value=>value.id===sqlSentinel.id),'BM25局部成功禁止SQL哨兵入选');
  assert.equal(databaseEvents.filter(event=>event.kind==='sql-fallback').length,0,'局部BM25成功不启动任何SQL后备请求');
  assert.equal(partial.data.search_coverage.candidate_count,1,'仅接收健康片唯一内容，不加SQL候选票');
  assert.equal(partial.data.search_coverage.vector_state,'available');
  assert.equal(partial.data.search_coverage.state,'bounded','partial沿现有v1可用但未完整覆盖的状态表达');
  assert.equal(partial.data.search_coverage.channels.lexical.shards,2);
  assert.equal(partial.data.search_coverage.channels.lexical.completed,1);
  assert.equal(partial.data.search_coverage.channels.lexical.exhausted,false,'503分片不能当穷尽');
  checks.push('允许集202分两片：一片HTTP503，真实健康BM25独占正文经正式工具保存，partial且SQL哨兵/后备请求均为零');

  // 所有BM25首批候选在元信息即失效，主读取额度未花；目标只在dense可达。
  // 查询Embedding等真实后页到达代理后才释放，固定后页在途→dense就绪的事件顺序。
  let releaseEmbedding, embeddingGateTimedOut=false;
  const pageStarted=new Promise(resolve=>{releaseEmbedding=resolve;});
  delayedPage={releaseEmbedding,startedAt:null};
  provider.onRequest(async input=>{
    if(phase!=='slow-later-page'||!input.input.includes(pageQuery))return;
    let timer;
    try{
      await Promise.race([pageStarted,new Promise(resolve=>{
        timer=setTimeout(()=>{embeddingGateTimedOut=true;resolve();},7000);
      })]);
    }finally{clearTimeout(timer);}
  });
  phase='slow-later-page';searchLog.length=0;databaseEvents.length=0;
  let duringPage;
  try{duringPage=await formalSearch(pageQuery,1,{related_object_id:ghost.id});}
  finally{releaseEmbedding();provider.onRequest(()=>{});}
  const pageRequests=searchLog.filter(event=>event.phase===phase);
  const firstPage=pageRequests.find(event=>event.channel==='sparse'&&event.offset===0);
  const laterPage=pageRequests.find(event=>event.channel==='sparse'&&event.offset>0);
  const densePage=pageRequests.find(event=>event.channel==='dense'&&event.ids.includes(targetRows[0].id));
  const ownerRead=databaseEvents.find(event=>event.kind==='owner-content');
  observations.slowLaterPage={operationId:duringPage.operationId,startedAt:duringPage.startedAt,
    returnedAt:duringPage.returnedAt,objects:duringPage.data.objects.map(value=>value.id),
    coverage:duringPage.data.search_coverage,requests:pageRequests,databaseEvents:databaseEvents.slice()};
  assert.equal(embeddingGateTimedOut,false,'查询Embedding只能由真实BM25后页事件放行，超时释放不算满足前提');
  assert.ok(firstPage&&firstPage.status===200&&firstPage.code===0&&!firstPage.injected);
  assert.equal(firstPage.ids.length,firstPage.limit,'真实BM25首批必须满页');
  assert.equal(firstPage.limit,50);
  assert.ok(laterPage&&laterPage.status===200&&laterPage.code===0&&!laterPage.injected,'后页须真实透传Milvus成功');
  assert.equal(laterPage.offset,firstPage.ids.length,'后页按真实消费位置前进');
  assert.equal(laterPage.delayedMs,5000,'只延迟后页，首批不拖慢');
  const ghostRecordIds=new Set(ghostRows.map(row=>row.id));
  assert.ok(pageRequests.filter(event=>event.channel==='sparse').every(event=>event.ids.every(id=>ghostRecordIds.has(id))),
    'BM25只命中元信息失效旧版entry，合法正文不能由词法救回');
  assert.ok(densePage&&densePage.status===200&&densePage.code===0&&!densePage.injected,'真实dense响应须包含目标规范身份');
  assert.equal(densePage.ids[0],targetRows[0].id,'合成查询向量使合法目标居dense首位');
  assert.ok(laterPage.upstreamAt<=densePage.respondedAt&&densePage.respondedAt<laterPage.respondedAt,
    '固定后页已在等待期间，dense才实际就绪');
  assert.ok(ownerRead&&ownerRead.at>=densePage.respondedAt&&ownerRead.at<laterPage.respondedAt,
    'dense就绪须在慢后页返回前实际回源读取目标正文，不能等整轮后再读');
  assert.ok(ownerRead.at<duringPage.startedAt+10000,'目标正文须在同一10秒工作期限内读到');
  assert.deepEqual(duringPage.data.objects.map(value=>value.id),[pageTarget.id]);
  assert.ok(duringPage.data.objects[0].entries.some(value=>value.effective_value===pageBody),
    '目标正文须在正式工具裁剪保存后仍可见，数组有候选不算交付');
  assert.equal(databaseEvents.filter(event=>event.kind==='sql-fallback').length,0,'BM25成功页不能加SQL后备票');
  checks.push('真实BM25首批50条失效→offset50后页延迟5秒：dense首项就绪即在后页返回前/共同期限内回源，正文经正式工具裁剪保存交付');
  assert.equal(checks.length,9,'原有9组及其全部断言完成后再进入新增正式反例');

  // 同owner两条独立内容：E1先由真实BM25回源，才把真实dense响应交给driver。
  const entryQuery='sameownerentryprobe';
  const entryObject=await createMetricEntries('同对象分批内容',[
    {entry_id:'early-rule',effective_value:entryQuery+' earlybodyproof：合成巡检必须登记双人确认。'},
    {entry_id:'later-rule',effective_value:'laterbodyproof：遇到校准失效的设备应立即停止使用。'},
  ]);
  const entryRows=await indexedEntries(entryObject), entryVector=await embedOf(entryQuery);
  const earlyRow=entryRows.find(row=>row.entry_id==='early-rule');
  const lateRow=entryRows.find(row=>row.entry_id==='later-rule');
  assert.notEqual(earlyRow.id,lateRow.id,'同owner不同entry具有不同规范身份');
  assert.ok(!JSON.stringify(entryObject.entries[1]).toLowerCase().includes(entryQuery),
    'E2正文、label、path及支持元信息均无字面查询词');
  await milvus('entities/upsert',{data:entryRows.map(row=>({...row,
    vector:row.entry_id==='later-rule'?entryVector:entryVector.map(value=>-value)}))});
  const earlyReadGate=gate();
  phase='same-owner-late-entry';mode=null;
  scenario={phase,object:entryObject,beforeDense:earlyReadGate,
    onOwnerContent(event){if(event.contents.includes('early-rule'))earlyReadGate.open(event);}};
  searchLog.length=0;databaseEvents.length=0;
  let lateEntry;
  try{lateEntry=await formalSearch(entryQuery,2,{related_object_id:entryObject.id});}
  finally{earlyReadGate.release();scenario=null;}
  const entryRequests=searchLog.filter(event=>event.phase===phase);
  const entrySparse=entryRequests.filter(event=>event.channel==='sparse');
  const entryDense=entryRequests.filter(event=>event.channel==='dense');
  const entryReads=databaseEvents.filter(event=>event.kind==='owner-content');
  observations.sameOwnerLateEntry={operationId:lateEntry.operationId,
    recordIds:{early:earlyRow.id,later:lateRow.id},coverage:lateEntry.data.search_coverage,
    objects:lateEntry.data.objects,requests:entryRequests,databaseEvents:databaseEvents.slice()};
  assert.equal(earlyReadGate.timedOut,false,'dense只能由E1真实正文读取放行，超时不满足夹具');
  assert.equal(entrySparse.length,1);assert.equal(entryDense.length,1);
  assert.deepEqual(allowedIds(entrySparse[0].filter),[entryObject.id]);
  assert.deepEqual(allowedIds(entryDense[0].filter),[entryObject.id]);
  assert.ok(entryRequests.every(event=>event.collection===collection&&event.consistency==='Strong'));
  assert.ok(entryRequests.every(event=>event.status===200&&event.code===0&&!event.injected));
  assert.deepEqual(entrySparse[0].ids,[earlyRow.id],'BM25只能召回E1，不能提前读到E2');
  assert.deepEqual(entryDense[0].ids,[lateRow.id,earlyRow.id],'真实dense把无字面查询词E2排在首位');
  assert.equal(entryReads.length,2,'主命中按两个规范身份各读一次，不能按owner复用而漏E2');
  const earlyRead=entryReads.find(event=>event.entryIds.includes('early-rule'));
  const lateRead=entryReads.find(event=>event.entryIds.includes('later-rule'));
  assert.deepEqual(earlyRead?.contents,['early-rule'],'E1窄读不能顺带返回E2正文');
  assert.deepEqual(lateRead?.contents,['later-rule'],'E2必须有自己的真实owner正文响应');
  assert.ok(earlyRead.completedOrder<entryDense[0].respondedOrder
    &&entryDense[0].respondedOrder<lateRead.order,'真实事件固定为E1读<dense就绪<E2读');
  assert.ok(earlyRead.completedAt<=entryDense[0].respondedAt&&entryDense[0].respondedAt<=lateRead.at);
  assert.ok(lateRead.completedAt<lateEntry.startedAt+10000,'两个entry都在共同工作期限内完成回源');
  assert.deepEqual(lateEntry.data.objects.map(object=>object.id),[entryObject.id]);
  assert.deepEqual(lateEntry.data.objects[0].entries.map(entry=>[entry.entry_id,entry.effective_value]).sort(),
    entryObject.entries.map(entry=>[entry.entry_id,entry.effective_value]).sort(),
    'limit=2经末端对象聚合/正式保存后，两entry正文必须独立可见');
  assert.deepEqual(new Set(lateEntry.data.objects[0].retrieval.excerpts.map(excerpt=>excerpt.entry_id)),
    new Set(['early-rule','later-rule']));
  assert.equal(lateEntry.data.search_coverage.candidate_count,2,'E1重复跨通道不多计，E2新位置独立计入');
  assert.equal(databaseEvents.filter(event=>event.kind==='sql-fallback').length,0,'健康BM25禁止SQL第三票');
  checks.push('同owner E1先由BM25独立窄读，真实dense就绪后补读无字面词E2；两规范身份/两次主读，limit2正式保存两份正文');

  // SQL强项与34个仅dense相关项共用30次主读；只在两份SQL首批真实完成后放行dense。
  // 强项在dense末位但SQL首位，一次RRF使其高于每个dense单路项，预期独立于产品输出。
  const sqlQuery='sqltimelyprobe calibrationpermit';
  const sqlStrong={entry_id:'sql-strong-rule',effective_value:sqlQuery+' sqlbodyproof：合成校准许可须由两名复核员确认。'};
  const sqlObject=await createMetricEntries('及时后备合成资料',[sqlStrong,
    ...Array.from({length:34},(_,i)=>({entry_id:'dense-rule-'+String(i).padStart(2,'0'),
      effective_value:'densebodyproof'+String(i).padStart(2,'0')+'：合成仪器常规检查资料。'})),
  ]);
  assert.ok(sqlObject.entries.slice(1).every(entry=>!entry.effective_value.includes('sqltimelyprobe')
    &&!entry.effective_value.includes('calibrationpermit')),'其余34个entry不能被SQL词法召回');
  assert.ok(!sqlObject.name.includes('sqltimelyprobe')&&!sqlObject.name.includes('calibrationpermit'));
  const sqlRows=await indexedEntries(sqlObject), sqlVector=await embedOf(sqlQuery);
  const sqlStrongRow=sqlRows.find(row=>row.entry_id===sqlStrong.entry_id);
  const norm=Math.hypot(...sqlVector), perpendicular=sqlVector.findIndex(value=>value===0);
  assert.ok(norm>0&&perpendicular>=0,'查询向量须可构造独立正交分量以固定真实dense次序');
  const denseEntries=sqlObject.entries.slice(1);
  await milvus('entities/upsert',{data:sqlRows.map(row=>{
    const rank=denseEntries.findIndex(entry=>entry.entry_id===row.entry_id), cosine=1-rank/50;
    return {...row,vector:rank<0?sqlVector.map(value=>-value):sqlVector.map((value,index)=>
      cosine*value/norm+(index===perpendicular?Math.sqrt(1-cosine*cosine):0))};
  })});
  const sqlReadyGate=gate(), readySources=new Set();
  phase='sql-ready-before-read-limit';mode='sparse-fail';
  scenario={phase,object:sqlObject,beforeDense:sqlReadyGate,
    onSqlReady(event){
      if(event.fixtureRows.some(row=>row.entryId===sqlStrong.entry_id))readySources.add(event.source);
      if(readySources.size===2)sqlReadyGate.open(event);
    }};
  searchLog.length=0;databaseEvents.length=0;
  let sqlTimely;
  try{sqlTimely=await formalSearch(sqlQuery,30,{related_object_id:sqlObject.id});}
  finally{sqlReadyGate.release();scenario=null;mode=null;}
  const sqlRequests=searchLog.filter(event=>event.phase===phase);
  const sqlFailed=sqlRequests.filter(event=>event.channel==='sparse');
  const sqlDense=sqlRequests.filter(event=>event.channel==='dense');
  const sqlBatches=databaseEvents.filter(event=>event.kind==='sql-fallback');
  const sqlReads=databaseEvents.filter(event=>event.kind==='owner-content');
  observations.sqlReadyBeforeReadLimit={operationId:sqlTimely.operationId,
    expectedStrongScore:1/60+1/(60+34),expectedDenseOnlyMaximum:1/60,
    coverage:sqlTimely.data.search_coverage,objects:sqlTimely.data.objects,
    requests:sqlRequests,databaseEvents:databaseEvents.slice()};
  assert.equal(sqlReadyGate.timedOut,false,'dense只能由SQL两来源真实首批放行，不能靠超时制造顺序');
  assert.equal(sqlFailed.length,1);assert.equal(sqlDense.length,1);
  assert.ok(sqlFailed.every(event=>event.injected&&event.status===503),'整条BM25明确全败才准SQL替代词法');
  assert.ok(sqlRequests.every(event=>event.collection===collection
    &&JSON.stringify(allowedIds(event.filter))===JSON.stringify([sqlObject.id])));
  assert.equal(sqlDense[0].status,200);assert.equal(sqlDense[0].code,0);assert.equal(sqlDense[0].injected,false);
  assert.deepEqual(sqlDense[0].ids,[...denseEntries.map(entry=>recordId(sqlObject,entry)),sqlStrongRow.id],
    '真实dense的34个单路项领先SQL强项，不能把强项误称dense首项救回');
  assert.equal(sqlBatches.length,2,'两个真实SQL来源各执行一次首批，不能末尾另加后备轮');
  assert.deepEqual(new Set(sqlBatches.map(event=>event.source)),new Set(['knowledge','retrieval']));
  for(const batch of sqlBatches){
    assert.equal(batch.failed,false);assert.equal(batch.rows,1);
    assert.deepEqual(batch.fixtureRows.map(row=>[row.objectId,row.version,row.entryId,row.path,row.statementId,row.offset,row.length]),
      [[sqlObject.id,sqlObject.version,sqlStrong.entry_id,sqlStrong.entry_id,null,0,[...sqlStrong.effective_value].length]]);
    assert.equal(batch.fixtureRows[0].nameHit,0);assert.equal(batch.fixtureRows[0].nameTermHits,0);
    assert.equal(batch.fixtureRows[0].termHits,2,'SQL强项完整命中两词，其他entry零词匹配');
    assert.equal(recordId(sqlObject,{entry_id:batch.fixtureRows[0].entryId,path:batch.fixtureRows[0].path},batch.fixtureRows[0].offset),
      sqlStrongRow.id,'实际SQL定位与实际dense行使用同一个规范身份');
    assert.ok(sqlFailed[0].respondedOrder<batch.order,'SQL必须在BM25明确不可用后启动');
    assert.ok(batch.completedOrder<sqlDense[0].respondedOrder,'SQL首批真实完整返回先于dense就绪');
  }
  assert.equal(sqlReads.length,30,'超过30个候选实际耗尽共同主读额度，不另给SQL或dense名额');
  assert.ok(sqlReads.every(event=>event.failed===false&&event.contents.length===1&&event.completedAt<sqlTimely.startedAt+10000));
  const sqlRead=sqlReads.find(event=>event.entryIds.includes(sqlStrong.entry_id));
  assert.equal(sqlReads.filter(event=>event.entryIds.includes(sqlStrong.entry_id)).length,1);
  assert.deepEqual(sqlRead?.contents,[sqlStrong.entry_id]);
  assert.ok(sqlBatches.every(batch=>batch.completedOrder<sqlRead.order&&batch.completedOrder<sqlReads[29].order),
    'SQL强项在共享30次读取耗尽前真实就绪且实际回源，不能只看到SQL数组');
  assert.ok(1/60+1/(60+34)>1/60,'SQL首位与dense末位共同RRF仍高于任何dense单票');
  assert.deepEqual(sqlTimely.data.objects.map(object=>object.id),[sqlObject.id]);
  assert.equal(sqlTimely.data.objects[0].entries[0].entry_id,sqlStrong.entry_id,
    '共同RRF应把SQL强项选为首项，不能按dense读取顺序装配');
  assert.equal(sqlTimely.data.objects[0].entries[0].effective_value,sqlStrong.effective_value,
    'SQL强项正文必须在正式裁剪保存的回执中可见');
  assert.equal(sqlTimely.data.search_coverage.candidate_count,35,'两个SQL来源与dense共享规范身份，只计35项');
  assert.equal(sqlTimely.data.search_coverage.state,'bounded','主读取30耗尽保留有界事实');
  checks.push('BM25明确全败后SQL两来源首批先于dense及30次主读耗尽就绪；SQL首位/dense末位共同RRF，正式保存仍有SQL强项正文');

  // 同一规范record，dense展示原entry内的合法子窗口，SQL仍推导原规范窗口。
  // 修改真实专用索引行的展示定位/hash而保留独立算出的规范id，代理不改任何search响应。
  const sharedQuery='sharedrecordprobe';
  const sharedPrefix='未展示背景🌏。'.repeat(12), sharedText=sharedQuery+' sharedbodyproof：合成巡检结果须保留双人确认记录。';
  const sharedBody=sharedPrefix+sharedText+'未展示附注🌏。'.repeat(10);
  const sharedObject=await createMetricEntries('规范身份合成资料',[
    {entry_id:'canonical-rule',effective_value:sharedBody},
  ]);
  const sharedRows=await indexedEntries(sharedObject), sharedRow=sharedRows[0];
  const sharedVector=await embedOf(sharedQuery), sharedOffset=[...sharedPrefix].length, sharedLength=[...sharedText].length;
  assert.ok(sharedOffset>0&&sharedOffset+sharedLength<[...sharedBody].length,'展示窗口确实小于规范窗口');
  assert.equal([...sharedBody].slice(sharedOffset,sharedOffset+sharedLength).join(''),sharedText);
  assert.equal(sharedRow.id,recordId(sharedObject,sharedObject.entries[0]));
  assert.equal(sharedRow.char_offset,0);assert.equal(sharedRow.char_length,[...sharedBody].length);
  await milvus('entities/upsert',{data:[{...sharedRow,vector:sharedVector,
    char_offset:sharedOffset,char_length:sharedLength,content_hash:digest(sharedText)}]});
  const storedShared=await rows(sharedObject.id);
  assert.equal(storedShared.length,1);assert.equal(storedShared[0].id,sharedRow.id,'真实索引子窗口不得另造身份');
  assert.equal(storedShared[0].entry_path,sharedObject.entries[0].path);
  assert.equal(storedShared[0].char_offset,sharedOffset);assert.equal(storedShared[0].char_length,sharedLength);
  const sharedReadGate=gate();
  phase='sql-dense-shared-record';mode='sparse-fail';
  scenario={phase,object:sharedObject,content:{'canonical-rule':sharedText},beforeSparseFailure:sharedReadGate,
    onOwnerContent(event){if(event.contents.includes('canonical-rule'))sharedReadGate.open(event);}};
  searchLog.length=0;databaseEvents.length=0;
  let shared;
  try{shared=await formalSearch(sharedQuery,1,{related_object_id:sharedObject.id});}
  finally{sharedReadGate.release();scenario=null;mode=null;}
  const sharedRequests=searchLog.filter(event=>event.phase===phase);
  const sharedDense=sharedRequests.filter(event=>event.channel==='dense');
  const sharedFailed=sharedRequests.filter(event=>event.channel==='sparse');
  const sharedBatches=databaseEvents.filter(event=>event.kind==='sql-fallback');
  const sharedReads=databaseEvents.filter(event=>event.kind==='owner-content');
  observations.sqlDenseSharedRecord={operationId:shared.operationId,recordId:sharedRow.id,
    canonical:{offset:0,length:[...sharedBody].length},display:{offset:sharedOffset,length:sharedLength},
    coverage:shared.data.search_coverage,objects:shared.data.objects,requests:sharedRequests,databaseEvents:databaseEvents.slice()};
  assert.equal(sharedReadGate.timedOut,false,'BM25故障只由真实dense子窗口回源放行，不能靠超时');
  assert.equal(sharedDense.length,1);assert.equal(sharedFailed.length,1);
  assert.ok(sharedFailed[0].injected&&sharedFailed[0].status===503,'SQL只能在BM25整路明确失败后启动');
  assert.equal(sharedDense[0].status,200);assert.equal(sharedDense[0].code,0);assert.equal(sharedDense[0].injected,false);
  assert.deepEqual(sharedDense[0].ids,[sharedRow.id]);
  assert.deepEqual(sharedDense[0].rows.map(row=>[row.entry_id,row.path,row.offset,row.length,row.content_hash]),
    [['canonical-rule','canonical-rule',sharedOffset,sharedLength,digest(sharedText)]],
    'dense子窗口须来自实际Milvus响应，仍映射到原entry/path规范record');
  assert.equal(sharedBatches.length,2);assert.deepEqual(new Set(sharedBatches.map(event=>event.source)),new Set(['knowledge','retrieval']));
  for(const batch of sharedBatches){
    assert.equal(batch.failed,false);assert.equal(batch.rows,1);
    assert.deepEqual(batch.fixtureRows.map(row=>[row.objectId,row.version,row.entryId,row.path,row.statementId,row.offset,row.length]),
      [[sharedObject.id,sharedObject.version,'canonical-rule','canonical-rule',null,0,[...sharedBody].length]],
      '真实SQL返回原规范窗口，不能从dense子窗口或产品输出倒写预期');
    const sqlRecord=recordId(sharedObject,{entry_id:batch.fixtureRows[0].entryId,path:batch.fixtureRows[0].path},batch.fixtureRows[0].offset);
    assert.equal(sqlRecord,sharedRow.id,'SQL原定位与dense子窗口映射到同一个独立推导的规范record');
    assert.ok(sharedFailed[0].respondedOrder<batch.order,'SQL不得在BM25仍在途时先加词法票');
  }
  assert.equal(sharedReads.length,1,'SQL与dense的不同展示窗口只占同规范record一次主命中读取');
  assert.deepEqual(sharedReads[0].entryIds,['canonical-rule']);assert.deepEqual(sharedReads[0].contents,['canonical-rule']);
  assert.ok(sharedDense[0].respondedOrder<sharedReads[0].order
    &&sharedReads[0].completedOrder<sharedFailed[0].respondedOrder,'固定dense回源完成后SQL才启动，才能查出跨轮重复读取');
  assert.equal(shared.data.search_coverage.candidate_count,1,'SQL两来源和dense总共只计一个规范record');
  assert.deepEqual(shared.data.objects.map(object=>object.id),[sharedObject.id]);
  assert.deepEqual(shared.data.objects[0].entries.map(entry=>[entry.entry_id,entry.effective_value]),[['canonical-rule',sharedText]],
    '迟到SQL规范窗口不能把已读展示窗口变成另一身份或丢掉已保存正文');
  assert.deepEqual(shared.data.objects[0].retrieval.excerpts.map(excerpt=>[excerpt.entry_id,excerpt.path,excerpt.offset,excerpt.length,excerpt.total_chars,excerpt.text]),
    [['canonical-rule','canonical-rule',sharedOffset,sharedLength,[...sharedBody].length,sharedText]],
    '正式保存保留原entry的Unicode定位和总长度，不能把子窗口坐标重置为零');
  const sharedReread=await formalRead({object_id:sharedObject.id,version:sharedObject.version,
    entry_id:'canonical-rule',offset:sharedOffset,limit:sharedLength});
  assert.equal(sharedReread.data.entries[0].effective_value,sharedText,'同版read_knowledge从原entry坐标补读子窗口');
  observations.sqlDenseSharedRecord.rereadOperationId=sharedReread.operationId;
  const canonicalReread=await formalRead({object_id:sharedObject.id,version:sharedObject.version,
    entry_id:'canonical-rule',offset:0,limit:[...sharedBody].length});
  assert.equal(canonicalReread.data.entries[0].effective_value,sharedBody,'同一原ref也能补读完整规范窗口');
  observations.sqlDenseSharedRecord.canonicalRereadOperationId=canonicalReread.operationId;
  checks.push('SQL规范窗口与真实dense子窗口共用原record：两SQL来源+dense只计一个候选/一次主读，正式保存原ref/Unicode坐标并同版补读一致');

  // ── 切片4新增：R12/R13/R14覆盖原因的v2正式反例（沿用真实Milvus、SQL观察与
  // 故障注入；v1九组完成后进入）。v2合同已删related_object_id锚定，范围改用
  // kinds（retail种子只有field/table/document/metric/relationship）：term族
  // （r12Object）与query_example族（emptyObject/r13Object）各自隔离允许集，
  // 避免种子对象混入候选、空间级未索引对象误报覆盖滞后。R14分片场景放到最后：
  // 200个term填充对象只为切出第二分片，不索引，其覆盖滞后不影响此前的场景。
  h.releaseRun(run.run_id);
  // capture等待交付桥收到派发：worker须运行中处理本次输入（裸SQL抬合同版本
  // 不产生索引作业，短暂恢复安全）。
  await h.resumeWorker();
  run=await h.capture(await h.create(),'核对v2覆盖原因只陈述已证事实。');await h.pauseWorker();
  h.sql(`UPDATE agent_runs SET tool_contract_version=2 WHERE id='${run.run_id}'`);
  assert.equal(h.sql(`SELECT JSON_OBJECT('v',tool_contract_version) FROM agent_runs WHERE id='${run.run_id}'`)[0].v,2,
    '新run必须固定工具合同2');
  // 直调检索受正文准入门约束：先按本消息route，再进入覆盖场景矩阵。
  const routeInput={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:randomUUID(),
    tool_name:'update_analysis_task',arguments:{action:'route',task_id:null,expected_version:null,goal:'',options:[]},
    checkpoint:exportCheckpoint(manager,run.workspace_context.authority_revision,run.workspace_context.authority_snapshot)};
  ok(await h.internal('/internal/data/tool-calls',routeInput));
  ok(await h.internal('/internal/data/tools',routeInput));
  const formalSearchV2=async(query,limit,scope={})=>{
    const input={run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:randomUUID(),
      tool_name:'search_knowledge',arguments:{query,limit,...scope},
      checkpoint:exportCheckpoint(manager,run.workspace_context.authority_revision,run.workspace_context.authority_snapshot)};
    const registration=ok(await h.internal('/internal/data/tool-calls',input));
    const receipt=ok(await h.internal('/internal/data/tools',input));
    const saved=h.sql(`SELECT JSON_OBJECT('state',state,'receipt',receipt) FROM tool_calls
      WHERE sdk_tool_call_id='${input.sdk_tool_call_id}' AND origin_run_id='${run.run_id}'`);
    assert.equal(saved.length,1);assert.equal(saved[0].state,'succeeded');
    assert.equal(receipt.operation_id,registration.operation_id);
    const publicNext=receipt.data.search_coverage.next;
    if(typeof publicNext==='string')
      assert.equal(publicNext,'rc1:'+receipt.operation_id,'公共游标是本操作短引用，完整窗口只在存储回执');
    assert.deepEqual(publicNext==null?saved[0].receipt
      :{...saved[0].receipt,data:{...saved[0].receipt.data,
        search_coverage:{...saved[0].receipt.data.search_coverage,next:publicNext}}},receipt,
      'v2同样核对HTTP结果等于正式裁剪保存回执的公开投影');
    validateContract('KnowledgeSearchReply',receipt.data);
    return receipt.data;
  };
  const channelState=(data,name)=>data.search_coverage.channels.find(entry=>entry.channel===name)?.state;
  const sqlFallbacks=()=>databaseEvents.filter(event=>event.kind==='sql-fallback').length;

  // 夹具（全部kind=term：retail种子只有field/table/document/metric/relationship，
  // query_example创建需结构值不适合当夹具——term是唯一种子不占的可创建kind）。
  // 场景按允许集净度排序：真实成功空最先（term允许集内只有空集对象），
  // 多词对象随后；已证滞后（pending作业）必须晚于期限耗尽场景（其断言不得
  // 混入真实index_lag）；分片填充对象只形成允许集、不索引，放最后。
  const terms=Array.from({length:26},(_,i)=>'r12k'+String(i).padStart(2,'0'));
  const r12Query=terms.join(' ');

  // R12成功空：26词在允许集内真实执行且零命中（BM25与dense都真实成功空），
  // 不启动SQL；成功空不是未覆盖。作业仍indexed、覆盖核验current。
  const emptyObject=await createMetricEntries('成功空零行资料',
    [{entry_id:'body',effective_value:'R12成功空基准正文，不含任何空词标记。'}],'term');
  await indexedEntries(emptyObject);
  await milvus('entities/delete',{filter:`object_id == "${emptyObject.id}"`});
  assert.deepEqual(await rows(emptyObject.id),[],'成功空夹具须真实删除全部Milvus行');
  const emptyTerms=Array.from({length:26},(_,i)=>'zq'+String(i).padStart(2,'0')+'x');
  phase='r12-success-empty';searchLog.length=0;databaseEvents.length=0;
  const empty=await formalSearchV2(emptyTerms.join(' '),30,{kinds:['term']});
  phase='existing';
  assert.deepEqual(empty.hits,[],'真实零行允许集不得交付命中');
  assert.equal(empty.search_coverage.state,'searched','成功空按真实穷尽报告，不冒充bounded：'+JSON.stringify(empty.search_coverage));
  assert.deepEqual(empty.search_coverage.reasons,[],'零命中不等于通道不可用：'+JSON.stringify(empty.search_coverage));
  assert.equal(channelState(empty,'bm25'),'available');
  assert.equal(channelState(empty,'dense'),'available');
  assert.equal(sqlFallbacks(),0,'成功空不得启动SQL补扫');
  checks.push('R12成功空26词：BM25与dense真实穷尽，零命中不触发SQL或channel_unavailable');

  // 26个去重词项超过SQL 24词截断阈值；6个entry供跨页窗口。
  const r12Object=await createMetricEntries('多词覆盖合成资料',[
    {entry_id:'body',effective_value:'R12健康多词正文：'+r12Query+' 设备完成校准登记后才能投用🌏。'},
    ...Array.from({length:5},(_,i)=>({entry_id:'fill-'+i,effective_value:'R12多词同窗填充'+i+'：常规巡检说明，不含查询词项。'})),
  ],'term');
  await indexedEntries(r12Object);

  // R12健康正例+R14全成功对照：BM25/dense真实参与，SQL截词不算覆盖限制。
  phase='r12-healthyV2';searchLog.length=0;databaseEvents.length=0;
  const healthyV2=await formalSearchV2(r12Query,30,{kinds:['term']});
  assert.equal(healthyV2.search_coverage.state,'searched',
    'SQL 24词截断只在SQL实际参与当前候选窗时限制覆盖：'+JSON.stringify(healthyV2.search_coverage));
  assert.deepEqual(healthyV2.search_coverage.reasons,[],'健康全通道不得虚构覆盖原因');
  assert.equal(healthyV2.search_coverage.next,null,'窗口耗尽后无续页游标');
  assert.equal(channelState(healthyV2,'exact'),'available');
  assert.equal(channelState(healthyV2,'bm25'),'available');
  assert.equal(channelState(healthyV2,'dense'),'available');
  assert.ok(healthyV2.hits.some(hit=>hit.ref.object_id===r12Object.id),'健康多词查询照常交付命中');
  assert.equal(sqlFallbacks(),0,'BM25健康不启动SQL');
  checks.push('R12健康26词全成功：SQL截词未参与，覆盖如实searched、无虚构原因、无SQL请求');

  // R12截词反例：BM25整路失败→SQL替代词法，截词如实bounded；SQL成功使词法
  // 能力仍可用（bm25=available）而失败分片以channel_unavailable并列（R14语义）；
  // 恢复窗沿sql_active保持限制，不因未重发SQL丢状态。
  mode='sparse-fail';phase='r12-sql-truncation';searchLog.length=0;databaseEvents.length=0;
  const truncated=await formalSearchV2(r12Query,5,{kinds:['term']});
  mode=null;phase='existing';
  assert.equal(truncated.search_coverage.state,'bounded','SQL实际参与且截词未核完：覆盖如实bounded：'+JSON.stringify(truncated.search_coverage));
  assert.equal(channelState(truncated,'bm25'),'available','SQL替代供词法正文，通道不因BM25整路失败而虚报不可用：'+JSON.stringify(truncated.search_coverage));
  assert.ok(truncated.search_coverage.reasons.includes('channel_unavailable'),'BM25失败分片仍以原因并列说明');
  assert.ok(sqlFallbacks()>=1,'BM25明确全败后SQL两来源真实参与');
  assert.ok(truncated.hits.some(hit=>hit.ref.object_id===r12Object.id),'截词后SQL仍按前24词召回并交付命中');
  assert.ok(truncated.search_coverage.next,'limit=5留有续页：6候选须返回窗口游标');
  const resumed=await formalSearchV2(r12Query,5,{kinds:['term'],cursor:truncated.search_coverage.next});
  assert.equal(resumed.search_coverage.state,'bounded','恢复窗沿sql_active保持SQL截词限制，不因未重发SQL丢状态');
  checks.push('R12 BM25整路失败：SQL截词参与如实bounded（含恢复窗续页），SQL替代下bm25保持available+channel_unavailable并列');

  // R14全失败对照：dense整路503按unavailable计；BM25照常交付，整体bounded。
  mode='dense-fail';phase='r14-dense-all-fail';searchLog.length=0;databaseEvents.length=0;
  const denseFailed=await formalSearchV2(r12Query,5,{kinds:['term']});
  mode=null;phase='existing';
  assert.equal(channelState(denseFailed,'dense'),'unavailable','整路明确失败按不可用计：'+JSON.stringify(denseFailed.search_coverage));
  assert.equal(channelState(denseFailed,'bm25'),'available','BM25照常可用：'+JSON.stringify(denseFailed.search_coverage));
  assert.ok(denseFailed.search_coverage.reasons.includes('channel_unavailable'),'须并列说明：'+JSON.stringify(denseFailed.search_coverage));
  assert.equal(denseFailed.search_coverage.state,'bounded','整体bounded：'+JSON.stringify(denseFailed.search_coverage));
  assert.ok(denseFailed.hits.some(hit=>hit.ref.object_id===r12Object.id),'失败路不得抹掉健康BM25结果');
  checks.push('R14全失败对照：dense整路失败unavailable+channel_unavailable，BM25命中照常交付');

  // R13期限耗尽反例：覆盖核验COUNT在期限内未返回只表示未核完——deadline事实
  // 保留，不得反推index_lag；期限前已读正文照常交付（持有的是真实请求帧，
  // 超时由调用自身10秒期限触发，与lease脚本candidate SQL同一持有模式）。
  // 必须先于已证滞后场景：pending作业会向后续term搜索混入真实index_lag。
  phase='r13-coverage-hold';searchLog.length=0;databaseEvents.length=0;
  armCoverageHold();
  const cappedStarted=performance.now();
  const capped=await formalSearchV2(r12Query,5,{kinds:['term']});
  const cappedElapsed=performance.now()-cappedStarted;
  releaseCoverageHold();phase='existing';
  assert.ok(cappedElapsed>=9500&&cappedElapsed<=11500,'覆盖核验持有须由原期限截断：'+Math.round(cappedElapsed)+'ms');
  assert.ok(capped.search_coverage.reasons.includes('deadline'),'期限耗尽保留deadline事实');
  assert.ok(!capped.search_coverage.reasons.includes('index_lag'),
    '未核完不得反推已证滞后：'+JSON.stringify(capped.search_coverage.reasons));
  assert.equal(capped.search_coverage.state,'bounded');
  assert.ok(capped.hits.some(hit=>hit.ref.object_id===r12Object.id),'期限前已读正文照常交付');
  checks.push('R13期限耗尽：覆盖核验未完只报deadline不虚构index_lag，已读命中保留');

  // R13已证滞后正例：worker暂停下新增资料（作业pending），允许集覆盖核验真实
  // 查到未完成作业→index_lag如实上报；未索引对象不得经SQL补票交付（允许集内
  // 其他term对象的dense命中属正常召回，不由本场景约束）。
  const r13Marker='r13lag'+randomUUID().replaceAll('-','').slice(0,8);
  const r13Object=await createMetricEntries('已证覆盖滞后资料',
    [{entry_id:'body',effective_value:r13Marker+' R13合成覆盖滞后正文，作业保持pending。'}],'term');
  phase='r13-proven-lag';searchLog.length=0;databaseEvents.length=0;
  const lagged=await formalSearchV2(r13Marker,5,{kinds:['term']});
  phase='existing';
  assert.ok(lagged.hits.every(hit=>hit.ref.object_id!==r13Object.id),'未索引资料不得经SQL补票交付');
  assert.ok(lagged.search_coverage.reasons.includes('index_lag'),'真实查到pending作业：已证滞后必须上报index_lag');
  assert.equal(lagged.search_coverage.state,'bounded','已证滞后不得冒充searched');
  assert.equal(sqlFallbacks(),0,'BM25成功空不因滞后启动SQL');
  checks.push('R13已证滞后：允许集内pending作业→index_lag如实上报bounded，不SQL补票');

  // R14部分分片失败（放最后：专用term夹具形成>200允许集切出两片）。健康片正文
  // 照常交付，bm25保持available并与channel_unavailable并存（分别表示可用正文与
  // 未覆盖失败片）；SQL第三票仍不启动。填充对象只形成允许集、不索引，其覆盖
  // 滞后只影响本场景的reasons并列，不影响前面场景。
  const shardQueryV2='v2shardonlyprobe';
  const shardBodyV2='v2healthyshardbody：合成馆藏须双人复核登记后外借🌏。';
  const shardTargetV2=await createMetricEntries('v2分片健康正文',
    [{entry_id:'body',effective_value:shardBodyV2}],'term');
  const shardRowsV2=await indexedEntries(shardTargetV2);
  await milvus('entities/upsert',{data:shardRowsV2.map(row=>({...row,text:shardQueryV2}))});
  const shardFillers=Array.from({length:200},(_,i)=>({id:'v2-shard-filler-'+String(i).padStart(3,'0'),
    kind:'term',name:'v2分片范围填充'+i,version:'1',state:'enabled',
    related_ids:[],source_id:null,source_version:'0',updated_by:'synthetic-test',
    entries:[{entry_id:'body',path:'body',label:'正文',effective_value:'v2合成范围填充材料'+i+'。',
      source_facts:{complete:false,gap:'独立合成分片夹具'},suggestion:{},human_override:null,review_state:'unverified'}]}));
  h.sql(shardFillers.map(value=>{
    const encoded=Buffer.from(JSON.stringify(value)).toString('hex');
    const body=`CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON)`;
    return `INSERT INTO knowledge_objects(id,space_id,kind,name,version,state,body,source_id,source_version,updated_by)
      VALUES('${value.id}','demo','term','${value.name}',1,'enabled',${body},NULL,0,'synthetic-test');
      INSERT INTO knowledge_revisions(object_id,version,archived_body) VALUES('${value.id}',1,${body});
      INSERT INTO retrieval_documents(object_id,space_id,version,body) VALUES('${value.id}','demo',1,${body});`;
  }).join('\n'));
  // term允许集≥202个对象切成两片：代理只对过滤器不含目标的片注入503，
  // 目标所在片（无论排序落在哪片）必然真实成功并供正文。
  partialTargetId=shardTargetV2.id;phase='partial-shard';provider.setMode('lost');
  searchLog.length=0;databaseEvents.length=0;
  const partialV2=await formalSearchV2(shardQueryV2,2,{kinds:['term']});
  provider.setMode('ok');phase='existing';
  assert.equal(channelState(partialV2,'bm25'),'available','R14部分失败：健康片仍供正文，通道不整路降级：'+JSON.stringify(partialV2.search_coverage));
  assert.ok(partialV2.search_coverage.reasons.includes('channel_unavailable'),'失败片以channel_unavailable并列说明未覆盖：'+JSON.stringify(partialV2.search_coverage));
  assert.equal(partialV2.search_coverage.state,'bounded','整体bounded：'+JSON.stringify(partialV2.search_coverage));
  assert.ok(partialV2.hits.some(hit=>hit.ref.object_id===shardTargetV2.id&&hit.definition===shardBodyV2),'健康片正文照常交付');
  assert.equal(sqlFallbacks(),0,'部分失败不启动SQL第三票');
  checks.push('R14一片成功一片明确失败：bm25=available与channel_unavailable并存，健康片正文交付，SQL零票');
  phase='existing';
  passed=true;console.log(JSON.stringify({passed,checks,observations,officialRequests:0}));
} finally {
  if(run)h.releaseRun(run.run_id);
  await h?.close();
  for(const socket of sockets)socket.destroy();
  await new Promise(r=>sqlProxy.close(r));
  proxy.closeAllConnections();
  await new Promise(r=>proxy.close(r));
  if((await milvus('collections/has')).has)await milvus('collections/drop');
  await provider.close();
  await writeFile('.local/checks/retrieval-channel-faults.json',JSON.stringify({passed,checks,observations,officialRequests:0},null,2));
}

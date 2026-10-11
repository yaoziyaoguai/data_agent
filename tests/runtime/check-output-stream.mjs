import assert from 'node:assert/strict';
import {writeFile,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {outputStream} from '../../apps/agent/session/output-stream.ts';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness} from '../mvp/harness.mjs';

const checks=[],measurements=[];
for(const count of [100,1000]) {
  const writes=[];const stream=outputStream(async(seq,text)=>writes.push({seq,text}));
  assert.equal(stream.startMessage(),1);
  for(let i=0;i<count;i++)stream.append('文');
  await stream.drain();await stream.close();
  assert.equal(writes.map(x=>x.text).join(''),'文'.repeat(count));assert.equal(writes.length,1);
  measurements.push({deltaCount:count,outputRequests:writes.length});
}
const writes=[];const stream=outputStream(async(seq,text)=>{await new Promise(r=>setTimeout(r,2));writes.push({seq,text});});
stream.startMessage();stream.append('调查过程');const finalStart=stream.startMessage();stream.append('正式回答🪴'.repeat(1000));await stream.drain();await stream.close();
assert.equal(finalStart,2);assert.equal(writes.slice(finalStart-1).map(x=>x.text).join(''),'正式回答🪴'.repeat(1000));
assert.ok(writes.every((x,i)=>x.seq===String(i+1)&&[...x.text].length<=8000));
const timed=[];const live=outputStream(async(seq,text)=>timed.push({seq,text}));live.append('首段');await new Promise(r=>setTimeout(r,80));assert.equal(timed.length,1);live.append('丢弃缓冲');await live.close();await new Promise(r=>setTimeout(r,70));assert.equal(timed.length,1);
const failed=outputStream(async()=>{throw new Error('receipt_lost');});failed.append('未知');await assert.rejects(failed.drain(),/receipt_lost/);await failed.close();
checks.push('100/1000个同步delta各合并为1次写入；50ms持续展示；消息边界、Unicode、写入顺序、取消与失败传播保持');

const h=await harness({capture:true,env:{DATA_AGENT_LEASE_MS:'120000'}});let passed=false;
try {
  const cid=await h.create(),run=await h.capture(cid,'说明合成设备的测量单位');await h.pauseWorker();
  const binding={run_id:run.run_id,lease_epoch:run.lease_epoch};
  const checkpoint=exportCheckpoint(SessionManager.inMemory('/synthetic/data-agent'),run.workspace_context.authority_revision,run.workspace_context.authority_snapshot);
  const input={...binding,sdk_tool_call_id:randomUUID(),tool_name:'update_analysis_task',arguments:{action:'create',goal:'解释测量单位',conditions:{time_start:null,time_end:null,timezone:'UTC',metric:null,channel:null,group_by:[],filters:[],knowledge_refs:[],notes:''},options:[]},checkpoint};
  assert.equal((await h.internal('/internal/data/tool-calls',input)).status,200);
  assert.equal((await h.internal('/internal/data/tools',input)).status,200);
  const append=(seq,text)=>h.internal('/internal/outputs',{...binding,chunk_seq:String(seq),text});
  assert.equal((await append(0,'无效')).value.code,'chunk_gap');
  let started=performance.now();
  for(let i=1;i<=1000;i++) {
    assert.equal((await append(i,'片段'+i+'。')).status,200);
    if(i===100)measurements.push({persistedChunks:100,elapsedMs:Math.round(performance.now()-started)});
  }
  measurements.push({persistedChunks:1000,elapsedMs:Math.round(performance.now()-started)});
  assert.equal((await append(21,'片段21。')).status,200);
  assert.equal((await append(21,'不相同')).value.code,'idempotency_conflict');
  assert.equal((await append(1002,'跳过')).value.code,'chunk_gap');
  assert.equal(h.sql(`SELECT JSON_OBJECT('count',COUNT(*)) FROM output_chunks WHERE attempt_id='${run.attempt_id}'`)[0].count,1000);
  const final=Array.from({length:1000},(_,i)=>'片段'+(i+1)+'。').join('');
  const finish=await h.internal('/internal/finish',{...binding,commit_id:randomUUID(),final_text:final,checkpoint});
  assert.equal(finish.status,200,JSON.stringify(finish.value));
  const snapshot=await h.snapshot(cid);assert.equal(h.sql(`SELECT JSON_OBJECT('count',COUNT(*)) FROM conversation_events WHERE conversation_id='${cid}' AND event_type='assistant_delta'`)[0].count,1000);
  assert.equal(snapshot.events.find(e=>e.type==='assistant_committed').payload.text,final);
  checks.push('实际MySQL写1000片段；旧序号同文幂等、异文冲突、跳号拒绝；最终正文及事件完整');
  passed=true;console.log(JSON.stringify({passed,checks,measurements,officialRequests:0}));
} finally {await mkdir('.local/product-repairs',{recursive:true});await writeFile('.local/product-repairs/output-stream.json',JSON.stringify({passed,checks,measurements,officialRequests:0},null,2));await h.close();}

import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {harness,until} from './harness.mjs';

let calls=0,h,passed=false,summaryCalls=0,toolCalls=0,answerCalls=0;
const provider=createServer(async(req,res)=>{
 let raw='';req.setEncoding('utf8');for await(const part of req)raw+=part;
 const body=JSON.parse(raw);
 // 输出cap=min(SDK本轮预算, 冻结输出上限)；read_conversation逐轮回读使上下文增长，Pi会收缩每轮输出预算。
 assert.ok(Number.isInteger(body.max_tokens)&&body.max_tokens>=1&&body.max_tokens<=8192);
 assert.deepEqual(body.thinking,{type:'enabled'});assert.equal(body.reasoning_effort,'low');
 const summary=!body.tools?.length;
 let delta;
 if(summary){
  summaryCalls++;
  delta={role:'assistant',content:'已按用户要求回看合成历史；继续当前调查，沿用原任务与工具身份。'};
 }else if(toolCalls<12){
  toolCalls++;
  const action=toolCalls===1?{name:'update_analysis_task',arguments:JSON.stringify({action:'route',goal:'',options:[]})}:{name:'read_conversation',arguments:JSON.stringify({after_seq:'0'})};
  delta={role:'assistant',tool_calls:[{index:0,id:randomUUID(),type:'function',function:action}]};
 }else{
  answerCalls++;
  delta={role:'assistant',content:'已通过受控工具回看合成历史，本轮调查完成。'};
 }
 calls++;await new Promise(r=>setTimeout(r,5200));
 res.writeHead(200,{'content-type':'text/event-stream'});
 res.write('data: '+JSON.stringify({id:'synthetic-long-run',choices:[{index:0,delta,finish_reason:delta.tool_calls?'tool_calls':'stop'}]})+'\n\n');
 res.write('data: '+JSON.stringify({id:'synthetic-long-run',choices:[],usage:{prompt_tokens:100,completion_tokens:30,total_tokens:130}})+'\n\n');res.end('data: [DONE]\n\n');
});await new Promise(r=>provider.listen(0,'127.0.0.1',r));
try{
 const profile={provider_id:'deepseek',model_id:'deepseek-flash',trial_id:randomUUID(),price_version:'2026-10-04-peak-usd',input_limit:32768,output_limit:8192,trial_call_limit:20,trial_cost_micros:'300000',request_call_limit:16,toolset:'data',payload_bytes_limit:65536,thinking_level:'low'};
 h=await harness({profile,protocolProviderUrl:'http://127.0.0.1:'+provider.address().port});
 const cid=await h.create(),started=performance.now();await h.send(cid,'回看这段合成会话的历史资料。');
 const snapshot=await until(async()=>{const s=await h.snapshot(cid);assert.ok(!s.events.some(e=>e.type==='run_failed'),JSON.stringify(s.events));return s.runs.some(r=>r.state==='finished')?s:false;},'完整Worker→Bridge长调查',130000);
 const seconds=(performance.now()-started)/1000;assert.ok(seconds>60);
 // 12轮受控工具+1次最终回答固定；上下文增长触发的Pi原生压缩摘要沿原预算额外记账且有界。
 assert.equal(toolCalls,12);assert.equal(answerCalls,1);assert.ok(summaryCalls<=2);
 assert.equal(snapshot.runs.length,1);
 const tools=h.sql("SELECT JSON_OBJECT('name',tool_name,'state',state) FROM tool_calls");
 assert.equal(tools.length,12);assert.ok(tools.every(t=>t.state==='succeeded'));
 assert.equal(tools.filter(t=>t.name==='update_analysis_task').length,1);
 assert.equal(tools.filter(t=>t.name==='read_conversation').length,11);
 const settled=h.sql("SELECT JSON_OBJECT('state',state) FROM model_call_attempts");assert.equal(settled.length,calls);assert.ok(settled.every(v=>v.state==='settled'));
 passed=true;console.log(JSON.stringify({passed,calls,toolCalls,answerCalls,summaryCalls,seconds,checks:['超过60秒、12轮工具+1次回答(+有界压缩摘要)，经真实Worker和Bridge完成同一run，账本全结算'],officialRequests:0}));
}finally{if(h)await h.close();await new Promise(r=>provider.close(r));await writeFile('.local/checks/mvp-worker-run-deadline.json',JSON.stringify({passed,calls,toolCalls,answerCalls,summaryCalls,officialRequests:0},null,2));}

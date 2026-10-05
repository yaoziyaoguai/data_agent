import assert from 'node:assert/strict';
import {mergeSnapshot} from '../../apps/web/src/features/workbench/conversation-timeline.ts';
const event=(n,type='message',payload={message_id:'m'+n,text:'消息'+n})=>({schema_version:1,conversation_id:'test',event_id:'e'+n,event_seq:String(n),type,payload});
const page=(events)=>({conversation_id:'test',messages:[],tasks:[],runs:[],events,first_event_seq:events[0]?.event_seq??'0',last_event_seq:events.at(-1)?.event_seq??'0',has_older:events[0]&&Number(events[0].event_seq)>1});
const all=Array.from({length:1250},(_,i)=>event(i+1));
let view=mergeSnapshot(null,page(all.slice(200,1200)));view=mergeSnapshot(view,page(all.slice(0,200)),true);view=mergeSnapshot(view,page(all.slice(1200)));
assert.equal(view.messages.length,1250);assert.equal(new Set(view.messages.map(m=>m.message_id)).size,1250);assert.equal(view.has_older,false);
// 重复轮询、提交跨页、恢复跨页不能产生重复key或追加一份局部回答。
view=mergeSnapshot(view,page(all.slice(1200)));assert.equal(view.messages.length,1250);
view=mergeSnapshot(view,page([event(1251,'assistant_delta',{output_id:'o',attempt_id:'a',text:'局部'})]));
view=mergeSnapshot(view,page([event(1252,'assistant_committed',{output_id:'o',attempt_id:'a',text:'完整回答'})]));
assert.equal(view.messages.filter(m=>m.attempt_id==='a').length,1);assert.equal(view.messages.at(-1).text,'完整回答');
view=mergeSnapshot(view,page([event(1253,'assistant_replaced',{output_id:'o',attempt_id:'b',replaces_attempt_id:'a'}),event(1254,'assistant_committed',{output_id:'o',attempt_id:'b',text:'恢复后回答'})]));
assert.ok(!view.messages.some(m=>m.attempt_id==='a'));assert.equal(view.messages.at(-1).text,'恢复后回答');
console.log(JSON.stringify({passed:true,checks:['1250事件连续合并','重叠轮询去重','完整回答跨页替代片段','恢复隐藏旧尝试'],officialRequests:0}));

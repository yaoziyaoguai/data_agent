import assert from 'node:assert/strict';
import {conversationItems,mergeSnapshot} from '../../apps/web/src/features/workbench/conversation-timeline.ts';
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
// A先发起，B先完成。终态到达不能把A/B组件移到后来问题之后。
const timeline=[event(1),event(2,'query_changed',{query_id:'a'}),event(3),event(4,'query_changed',{query_id:'a'}),event(5),event(6,'query_changed',{query_id:'b'}),event(7),event(8,'query_changed',{query_id:'b'}),event(9),event(10,'query_result',{query_id:'b',state:'succeeded'}),event(11,'query_result',{query_id:'a',state:'succeeded'})];
let concurrent=mergeSnapshot(null,page(timeline.slice(0,9)));
const queries=[{id:'a'},{id:'b'}];
const positions=s=>conversationItems(s,queries).filter(i=>i.kind==='query').map(i=>[i.key,String(i.sequence)]);
assert.deepEqual(positions(concurrent),[['query:a','4'],['query:b','8']]);
concurrent=mergeSnapshot(concurrent,page(timeline.slice(9)));
concurrent=mergeSnapshot(concurrent,page(timeline.slice(9)));
assert.deepEqual(positions(concurrent),[['query:a','4'],['query:b','8']]);
const notices=conversationItems(concurrent,queries).filter(i=>i.kind==='query_notice');
assert.deepEqual(notices.map(i=>[i.query.id,String(i.sequence),i.text]),[['b','10','查询完成'],['a','11','查询完成']]);
assert.equal(new Set(conversationItems(concurrent,queries).map(i=>i.key)).size,conversationItems(concurrent,queries).length);
assert.deepEqual(conversationItems(mergeSnapshot(null,page(timeline)),queries),conversationItems(concurrent,queries));
for(const [state,text] of [['failed','查询失败'],['cancelled','查询已停止']]) {
 const terminal=mergeSnapshot(null,page([event(1,'query_result',{query_id:'a',state})]));
 assert.equal(conversationItems(terminal,queries).find(i=>i.kind==='query_notice').text,text);
}
// 查询确认事件在更早页时先提供可访问卡片，补页后恢复历史归属，通知始终唯一。
let gap=mergeSnapshot(null,page([event(1001),event(1002,'query_result',{query_id:'a',state:'succeeded'})]));
assert.deepEqual(positions(gap),[['query:a','0'],['query:b','0']]);
gap=mergeSnapshot(gap,page([event(1),event(2,'query_changed',{query_id:'a'})]),true);
assert.equal(conversationItems(gap,queries).find(i=>i.key==='query:a').sequence,2n);
assert.equal(conversationItems(gap,queries).filter(i=>i.kind==='query_notice').length,1);
console.log(JSON.stringify({passed:true,checks:['1250事件连续合并','重叠轮询去重','完整回答跨页替代片段','恢复隐藏旧尝试','乱序终态保留查询位置且通知不重复','刷新恢复相同对话顺序','失败和取消分别通知'],officialRequests:0}));

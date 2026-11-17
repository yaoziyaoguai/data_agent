import assert from 'node:assert/strict';
import {conversationItems,loadedOutputRanges,mergeSnapshot} from '../../apps/web/src/features/workbench/conversation-timeline.ts';
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
assert.deepEqual(positions(concurrent),[['query:a','2'],['query:b','6']]);
concurrent=mergeSnapshot(concurrent,page(timeline.slice(9)));
concurrent=mergeSnapshot(concurrent,page(timeline.slice(9)));
assert.deepEqual(positions(concurrent),[['query:a','2'],['query:b','6']]);
// §6.3：timeline_event_seq持久首次锚点优先；有限页缺首次事件时不漂移，后续事件页不覆盖已有锚点。
const anchoredQueries=[{id:'a',timeline_event_seq:'2'},{id:'b',timeline_event_seq:'6'}];
const anchoredPositions=s=>conversationItems(s,anchoredQueries).filter(i=>i.kind==='query').map(i=>[i.key,String(i.sequence)]);
let late=mergeSnapshot(null,page([event(4,'query_changed',{query_id:'a'}),event(5),event(8,'query_changed',{query_id:'b'}),event(9)]));
assert.deepEqual(anchoredPositions(late),[['query:a','2'],['query:b','6']],'加载页缺首次事件时按持久锚点定位，不取页内后值');
late=mergeSnapshot(late,page(timeline.slice(9)));
assert.deepEqual(anchoredPositions(late),[['query:a','2'],['query:b','6']],'后续有限事件页不能覆盖已有持久锚点');
// §5：报告卡片持久首次保存锚点。最新页缺保存事件时不落0；补旧页、重复refresh、同一报告新修订不换锚。
const reportReference={report_id:'r1',conversation_id:'test',task_id:'t1',condition_version:'1',version:'1'};
const reportSaved=event(25,'analysis_report_saved',reportReference);
const reportTask=(anchor,reference=reportReference)=>({id:'t1',condition_version:'1',goal:'合成目标',report_ref:reference,...(anchor===undefined?{}:{report_timeline_event_seq:anchor})});
const reportPage=(events,tasks)=>({...page(events),tasks});
const reportCards=view=>conversationItems(view,[]).filter(i=>i.kind==='report').map(i=>[i.key,String(i.sequence),i.conditionChanged]);
let anchoredReports=mergeSnapshot(null,reportPage([event(1001),event(1002)],[reportTask('25')]));
assert.deepEqual(reportCards(anchoredReports),[['report:r1','25',false]],'最新页缺保存事件时按任务持久锚点定位，不落0');
anchoredReports=mergeSnapshot(anchoredReports,reportPage([event(24),reportSaved,event(26)],[reportTask('25')]),true);
assert.deepEqual(reportCards(anchoredReports),[['report:r1','25',false]],'补含保存事件的旧页不改变首次锚点');
anchoredReports=mergeSnapshot(anchoredReports,reportPage([event(27),event(40,'analysis_report_saved',{...reportReference,condition_version:'2',version:'2'})],[{...reportTask('25'),report_ref:{...reportReference,condition_version:'2',version:'2'}}]));
assert.deepEqual(reportCards(anchoredReports),[['report:r1','25',true]],'同一报告新修订更新内容与条件标记，首次位置不换');
let legacyReport=mergeSnapshot(null,reportPage([event(1001)],[reportTask(undefined)]));
assert.deepEqual(reportCards(legacyReport),[['report:r1','0',false]],'旧记录缺锚点字段保持原0兼容，不编造锚点');
legacyReport=mergeSnapshot(legacyReport,reportPage([event(24),reportSaved,event(26)],[reportTask(undefined)]),true);
assert.deepEqual(reportCards(legacyReport),[['report:r1','25',false]],'缺锚点旧记录补旧页回退已加载事件，只前移一次');
const foreignAnchor=mergeSnapshot(null,reportPage([event(1001)],[reportTask(undefined),{id:'t2',condition_version:'1',goal:'合成目标二',report_ref:{...reportReference,report_id:'r2'},report_timeline_event_seq:'99'}]));
assert.deepEqual(reportCards(foreignAnchor).sort(),[['report:r1','0',false],['report:r2','99',false]],'锚点只随report_id匹配的任务生效，不能仅凭task_id套用');
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
// 无新增事件的权限变化须替换全部已加载页的events，不能只覆盖messages。
const originalA=[event(2,'assistant_delta',{output_id:'oa',attempt_id:'aa',text:'甲原片段'}),event(3,'assistant_committed',{output_id:'oa',attempt_id:'aa',text:'甲原答案'})];
const originalB=[event(5,'assistant_delta',{output_id:'ob',attempt_id:'bb',text:'乙合法片段'}),event(6,'assistant_committed',{output_id:'ob',attempt_id:'bb',text:'乙合法答案'})];
let loaded=mergeSnapshot(null,page([event(4),...originalB]));
loaded=mergeSnapshot(loaded,page([event(1),...originalA]),true);
const loadedBefore=loaded;
const restrictedA=originalA.map(item=>({...item,payload:{...item.payload,text:'部分内容因来源不可读而隐藏。',projection_state:'committed'}}));
const rangeA={attempt_id:'aa',first_event_seq:'2',last_event_seq:'3',output_state:'committed'};
const projection=(range,outcome,fingerprint,events)=>({...range,projection_result:outcome,projection_fingerprint:fingerprint.repeat(64),...(events===undefined?{}:{events})});
loaded=mergeSnapshot(loaded,{...page([]),has_newer:false,output_projections:[projection(rangeA,'replace','a',restrictedA)]});
assert.equal(loaded.messages.find(message=>message.attempt_id==='aa')?.text,'部分内容因来源不可读而隐藏。','空增量也须替换旧页答案');
assert.ok(!JSON.stringify(loaded.events).includes('甲原'),'events缓存不能保留可复活的旧正文');
assert.equal(loaded.messages.find(message=>message.attempt_id==='bb')?.text,'乙合法答案');
assert.deepEqual([loaded.first_event_seq,loaded.last_event_seq],['1','6'],'展示替换不能推进或回退分页游标');
loaded=mergeSnapshot(loaded,{...page([]),has_newer:false,output_projections:[projection(rangeA,'unchanged','a')]});
assert.equal(loaded.messages.find(message=>message.attempt_id==='aa')?.text,'部分内容因来源不可读而隐藏。','unchanged不清空正文');
loaded=mergeSnapshot(loaded,{...page([]),has_newer:false,output_projections:[projection(rangeA,'replace','b',originalA)]});
assert.deepEqual(loaded.messages,loadedBefore.messages,'恢复权限后原事件正文逐字恢复');
loaded=mergeSnapshot(loaded,{...page([]),has_newer:false,output_projections:[projection({...rangeA,output_state:null},'not_available','c')]});
assert.ok(!loaded.messages.some(message=>message.attempt_id==='aa'));
assert.equal(loaded.messages.filter(message=>message.role==='user').length,2,'移除指定范围不动用户消息');
assert.equal(loaded.messages.find(message=>message.attempt_id==='bb')?.text,'乙合法答案');
assert.deepEqual([loaded.first_event_seq,loaded.last_event_seq],['1','6']);
loaded=mergeSnapshot(loaded,page([event(7)]));
assert.ok(!loaded.messages.some(message=>message.attempt_id==='aa'),'后续分页合并不能从旧delta复活已移除输出');
assert.deepEqual(loadedOutputRanges(loadedBefore),[
 {attempt_id:'aa',first_event_seq:'2',last_event_seq:'3'},
 {attempt_id:'bb',first_event_seq:'5',last_event_seq:'6'},
]);
let fragments=mergeSnapshot(null,page([event(1002,'assistant_delta',{attempt_id:'aa',output_id:'oa',text:'后页片段'})]));
fragments=mergeSnapshot(fragments,page(originalA),true);
assert.deepEqual(loadedOutputRanges(fragments),[
 {attempt_id:'aa',first_event_seq:'2',last_event_seq:'3'},
 {attempt_id:'aa',first_event_seq:'1002',last_event_seq:'1002'},
],'同attempt跨未加载区间不能合并为min/max');
console.log(JSON.stringify({passed:true,checks:['1250事件连续合并','重叠轮询去重','完整回答跨页替代片段','恢复隐藏旧尝试','乱序终态保留查询位置且通知不重复','查询卡按首次持久锚点定位且跨页不漂移','报告卡按任务持久锚点定位且补页/新修订不换锚','刷新恢复相同对话顺序','失败和取消分别通知','空增量逐范围刷新旧页并恢复原文','unchanged及not_available分开处理且保游标'],officialRequests:0}));

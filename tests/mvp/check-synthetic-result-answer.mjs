import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {harness} from './harness.mjs';

// 默认固定演示也经过实际Pi/Rust/SQLite来源答案交付，不能仅检查页面查询卡片。
const h=await harness();let passed=false;
try {
 const cid=await h.create();await h.send(cid,'查2026年1月净收入');await h.finished(cid);
 const draft=(await h.request('/conversations/'+cid+'/queries')).value.queries[0];
 assert.equal(draft.execution_state,'not_submitted');
 await h.send(cid,'执行这条');const snapshot=await h.finished(cid,3);
 const answer=snapshot.messages.filter(m=>m.role==='assistant'&&m.committed).at(-1).text;
 assert.match(answer,/12400/);assert.match(answer,/固定合成演示/);
 const calls=h.sql(`SELECT JSON_OBJECT('state',state,'count',COUNT(*)) FROM tool_calls WHERE conversation_id='${cid}' AND tool_name='present_analysis_answer' GROUP BY state`);
 assert.deepEqual(calls,[{state:'succeeded',count:1}]);
 assert.equal(snapshot.runs.filter(r=>r.state==='failed').length,0);
 passed=true;await writeFile('.local/checks/synthetic-result-answer.json',JSON.stringify({passed,checks:2,officialRequests:0,answer},null,2));
 console.log(JSON.stringify({passed,checks:2,officialRequests:0}));
} finally {if(!passed)await writeFile('.local/checks/synthetic-result-answer-failure.json',JSON.stringify(h.logs,null,2));await h.close();}

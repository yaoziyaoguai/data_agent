import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {harness} from './harness.mjs';

// v2渲染交付窄检查：结果事件先prepare绑定数值，正文以{{name}}引用，
// 宿主流式替换后定稿——正式正文不得残留标记，数值须来自已核binding，
// prepare回执唯一且present不再出现。
const h = await harness({env: {DATA_AGENT_TOOL_CONTRACT_VERSION: '2'}});
let passed = false;
try {
  const cid = await h.create(); await h.send(cid, '查2026年1月净收入'); await h.finished(cid);
  const draft = (await h.request('/conversations/' + cid + '/queries')).value.queries[0];
  assert.equal(draft.execution_state, 'not_submitted');
  await h.send(cid, '执行这条'); const snapshot = await h.finished(cid, 3);
  const answer = snapshot.messages.filter(m => m.role === 'assistant' && m.committed).at(-1).text;
  assert.match(answer, /12400/);
  assert.doesNotMatch(answer, /\{\{/);
  const prepare = h.sql(`SELECT JSON_OBJECT('state',state,'count',COUNT(*)) FROM tool_calls WHERE conversation_id='${cid}' AND tool_name='prepare_analysis_answer' GROUP BY state`);
  assert.deepEqual(prepare, [{state: 'succeeded', count: 1}]);
  const present = h.sql(`SELECT COUNT(*) FROM tool_calls WHERE conversation_id='${cid}' AND tool_name='present_analysis_answer'`);
  assert.deepEqual(present, [0]);
  assert.equal(snapshot.runs.filter(r => r.state === 'failed').length, 0);
  passed = true; await writeFile('.local/checks/interaction-delivery-20261107/rendered-answer-delivery.json', JSON.stringify({passed, checks: 4, officialRequests: 0, answer}, null, 2));
  console.log(JSON.stringify({passed, checks: 4, officialRequests: 0}));
} finally {
  if (!passed) await writeFile('.local/checks/interaction-delivery-20261107/rendered-answer-delivery-failure.json', JSON.stringify(h.logs, null, 2));
  await h.close();
}

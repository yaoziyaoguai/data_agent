import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {syntheticAction} from '../../apps/agent/provider/synthetic-analysis.ts';
import {cockpitAction} from '../../apps/agent/provider/synthetic-cockpit.ts';

// 仅验证合成provider遵守工具分页合同；不代表真实模型的检索或SQL质量。
const conditions = {
  metric: 'refund_ambiguous', time_start: '2026-01-01T00:00:00Z',
  time_end: '2026-02-01T00:00:00Z', timezone: 'UTC', channel: null,
  filters: ['is_test = 0', 'paid_amount_cents > 0'], group_by: [], knowledge_refs: [], notes: '',
};
const run = {
  text: '按订单计算', workspace_context: {
    tasks: [{id: 'refund-task', goal: '2026年1月退款率是多少', condition_version: '1',
      lifecycle: 'active', phase: 'waiting_clarification', conditions,
      clarification: {id: 'denominator-question', question: '退款率希望按什么分母计算？'}}],
    query_observations: [], memories: [],
  },
};
const search = {objects: [
  {id: 'metric-refund_rate', version: '7', entries_complete: false,
    entries: [{path: 'definition', entry_id: 'definition', effective_value: '已确认的合成指标'}]},
  {id: 'table-demo_order_detail', version: '3', entries: []},
]};
const update = {task_id: 'refund-task', condition_version: '2', phase: 'investigating'};
const receipt = (toolName, data) => ({role: 'toolResult', toolName,
  content: [{type: 'text', text: JSON.stringify(data)}]});
const action = (knowledge = search, reads = []) => syntheticAction(run, {messages: [
  {role: 'user', content: run.text}, receipt('search_knowledge', knowledge),
  receipt('update_analysis_task', update), ...reads.map(data => receipt('read_knowledge', data)),
]});
const page = (body, offset, nextOffset, totalChars, version = '7') => ({
  id: 'metric-refund_rate', version,
  entries: [{path: 'sql', entry_id: 'sql', effective_value: body,
    content_page: {offset, next_offset: nextOffset, total_chars: totalChars,
      complete: offset === 0 && nextOffset === null}}],
});
const expression = 'COUNT(DISTINCT CASE WHEN refunded_amount_cents > 0 THEN order_id END)'
  + ' * 1.0 / NULLIF(COUNT(DISTINCT order_id), 0) AS refund_rate';
const sql = `SELECT ${expression}\nFROM demo_order_detail\nWHERE is_test = 0`;
const expectGap = result => {
  assert.equal('tool' in result, false, '补读不完整时不能继续工具调用或生成查询');
  assert.match(result.text, /缺口.*没有生成查询/);
};
const checks = [];
let passed = false;
const previousDemoProfile = process.env.DATA_AGENT_DEMO_PROFILE;
process.env.DATA_AGENT_DEMO_PROFILE = 'retail';
try {
  assert.deepEqual(action(), {tool: 'read_knowledge', args: {
    object_id: 'metric-refund_rate', version: '7', entry_id: 'sql', offset: 0, limit: 4096,
  }});
  checks.push('搜索省略SQL条目时按已命中的对象和版本补读');

  const preview = structuredClone(search);
  preview.objects[0].entries.push({path: 'sql', entry_id: 'sql', effective_value: sql.slice(0, 80),
    content_page: {offset: 0, next_offset: 80, total_chars: sql.length, complete: false}});
  assert.equal(action(preview).tool, 'read_knowledge');
  // 即使已看到FROM，分页标记仍可能说明后面的规则没有读全。
  preview.objects[0].entries.at(-1).effective_value = sql;
  assert.equal(action(preview).tool, 'read_knowledge');
  checks.push('预览缺FROM或仍有未读正文时不能直接生成SQL');

  const longExpression = '/*语音🙂*/'.repeat(700) + expression;
  const longSql = `SELECT ${longExpression}\nFROM demo_order_detail\nWHERE is_test = 0`;
  const chars = [...longSql];
  const offset = 4096;
  const firstPage = page(chars.slice(0, offset).join(''), 0, offset, chars.length);
  assert.deepEqual(action(search, [firstPage]), {tool: 'read_knowledge', args: {
    object_id: 'metric-refund_rate', version: '7', entry_id: 'sql', offset, limit: 4096,
  }});
  checks.push('多页以Unicode字符位置和原版本继续读取');

  const lastPage = page(chars.slice(offset).join(''), offset, null, chars.length);
  assert.equal(lastPage.entries[0].content_page.complete, false);
  const complete = action(search, [firstPage, lastPage]);
  assert.equal(complete.tool, 'request_query');
  assert.equal(complete.args.sql, `SELECT ${longExpression}\nFROM demo_order_detail`
    + '\nWHERE is_test = 0 AND paid_amount_cents > 0\n AND paid_at >= :start AND paid_at < :end');
  checks.push('连续页读完才生成查询，完整保留来源SQL表达式');

  expectGap(action(search, [{error: 'not_available'}]));
  checks.push('补读失败明确保留缺口');

  expectGap(action(search, [page(sql, 0, null, sql.length, '8')]));
  checks.push('不同版本的正文不与命中对象拼接');

  expectGap(action(search, [firstPage, page(chars.slice(offset + 1).join(''), offset + 1, null, chars.length)]));
  checks.push('分页存在缺口时不生成查询');
  run.tool_contract_version = 2;
  const reference = {object_id: 'metric-refund_rate', version: '7', path: 'sql'};
  const hit = {record_kind: 'knowledge_entry', ref: reference, name: '合成退款率', kind: 'metric', definition: sql.slice(0, 80), content_state: 'partial'};
  const currentSearch = {hits: [hit], personal_memories: []};
  const currentPage = legacy => ({items: [{kind: 'knowledge', ref: {...reference, version: legacy.version}, state: 'ok',
    content: legacy.entries[0].effective_value, content_page: legacy.entries[0].content_page}]});
  assert.deepEqual(action(currentSearch), {tool: 'read_knowledge', args: {items: [{kind: 'knowledge', ref: reference, offset: 0, limit: 4096}]}});
  const currentFirst = currentPage(firstPage), currentLast = currentPage(lastPage);
  assert.deepEqual(action(currentSearch, [currentFirst]), {tool: 'read_knowledge', args: {items: [{kind: 'knowledge', ref: reference, offset, limit: 4096}]}});
  const currentComplete = action(currentSearch, [currentFirst, currentLast]);
  assert.equal(currentComplete.tool, 'request_query');
  assert.equal(currentComplete.args.sql, complete.args.sql);
  expectGap(action(currentSearch, [{items: [{kind: 'knowledge', ref: reference, state: 'not_available'}]}]));
  expectGap(action(currentSearch, [{items: [{kind: 'knowledge', ref: reference, state: 'stale'}]}]));
  checks.push('v2沿命中ref及逐项状态消费同版连续SQL页，旧版与不可用不生成查询');
  const rawCitation = {source: {kind: 'document', id: 'document-cockpit-asr-candidates'}, revision: '7', locator: {offset: 10, length: 20}};
  const cockpitRun = {text: 'ASR耗时怎样统计', tool_contract_version: 2, workspace_context: {tasks: [], query_observations: [], memories: []}};
  const rawAction = cockpitAction(cockpitRun, {messages: [{role: 'user', content: cockpitRun.text}, receipt('search_knowledge', {
    hits: [{record_kind: 'source_excerpt', name: '端云识别与候选选择', citation: rawCitation, source_length: 60, text: '已找到的原文窗口', content_state: 'complete'}],
  })]});
  assert.equal(rawAction.tool, 'read_source');
  assert.deepEqual(rawAction.args.citation.source, rawCitation.source);
  assert.equal(rawAction.args.citation.revision, '7');
  const citation = {source: {kind: 'platform', id: 'business-guide'}, revision: '9', locator: {offset: 0, length: 120}};
  const explanationRun = {text: '月底下单为什么不在收入里', tool_contract_version: 2, workspace_context: {tasks: [], query_observations: [], memories: []}};
  const explain = syntheticAction(explanationRun, {messages: [{role: 'user', content: explanationRun.text}, receipt('search_knowledge', {
    hits: [{record_kind: 'knowledge_entry', ref: {object_id: 'document-guide-3', version: '9', path: 'body'}, name: '上游与加工', kind: 'document', definition: '正文预览', citations: [citation]}],
  })]});
  assert.equal(explain.tool, 'read_source');
  assert.deepEqual(explain.args.citation, citation);
  checks.push('v2座舱raw摘录与零售知识citation均按实际来源/修订读取');
  const legacyZeroRun = {text: 'paid_amount_cents为0是什么意思', tool_contract_version: 1, workspace_context: {tasks: [], query_observations: [], memories: []}};
  const legacyZero = syntheticAction(legacyZeroRun, {messages: [{role: 'user', content: legacyZeroRun.text},
    receipt('search_knowledge', {objects: []}), receipt('read_source', {source_id: 'etl', version: '1', body: 'COALESCE(p.paid, 0)'}),
    receipt('update_analysis_task', {task_id: null, condition_version: null})]});
  assert.match(legacyZero.text, /COALESCE|缺失|填.?0/);
  checks.push('v1已读ETL的零付款解释保留原合同');
  passed = true;
  console.log(JSON.stringify({passed, checks, officialRequests: 0}));
} finally {
  if (previousDemoProfile === undefined) delete process.env.DATA_AGENT_DEMO_PROFILE;
  else process.env.DATA_AGENT_DEMO_PROFILE = previousDemoProfile;
  await mkdir('.local/checks', {recursive: true});
  await writeFile('.local/checks/synthetic-knowledge-reading.json',
    JSON.stringify({passed, checks, officialRequests: 0}, null, 2));
}

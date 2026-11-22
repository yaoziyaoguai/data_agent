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
const reference = {object_id: 'metric-refund_rate', version: '7', path: 'sql'};
const hit = (ref, definition, content_state) => ({record_kind: 'knowledge_entry', ref,
  name: '合成退款率', kind: 'metric', definition, content_state});
const search = {hits: [hit({...reference, path: 'definition'}, '已确认的合成指标', 'complete')]};
const update = {task_id: 'refund-task', condition_version: '2', phase: 'investigating', conditions: {...conditions, metric: 'refund_rate'}};
const receipt = (toolName, data) => ({role: 'toolResult', toolName,
  content: [{type: 'text', text: JSON.stringify(data)}]});
const action = (knowledge = search, reads = []) => syntheticAction(run, {messages: [
  {role: 'user', content: run.text}, receipt('search_knowledge', knowledge),
  receipt('update_analysis_task', update), ...reads.map(data => receipt('read_knowledge', data)),
]});
const page = (body, offset, nextOffset, totalChars, version = '7') => ({
  items: [{kind: 'knowledge', ref: {...reference, version}, state: 'ok', content: body,
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
  assert.deepEqual(action(), {tool: 'search_knowledge', args: {query: '合成退款率 sql', kinds: ['metric'], limit: 10}});
  checks.push('搜索省略SQL条目时补查同一指标的引用，未编造未取得的条目');

  const preview = {hits: [...search.hits, hit(reference, sql.slice(0, 80), 'partial')]};
  const read = offset => ({tool: 'read_knowledge', args: {items: [{kind: 'knowledge', ref: reference, offset, limit: 4096}]}});
  assert.deepEqual(action(preview), read(0));
  // 即使已看到FROM，分页标记仍可能说明后面的规则没有读全。
  preview.hits.at(-1).definition = sql;
  assert.equal(action(preview).tool, 'read_knowledge');
  checks.push('预览缺FROM或仍有未读正文时不能直接生成SQL');

  const longExpression = '/*语音🙂*/'.repeat(700) + expression;
  const longSql = `SELECT ${longExpression}\nFROM demo_order_detail\nWHERE is_test = 0`;
  const chars = [...longSql];
  const offset = 4096;
  const firstPage = page(chars.slice(0, offset).join(''), 0, offset, chars.length);
  assert.deepEqual(action(preview, [firstPage]), read(offset));
  checks.push('多页以Unicode字符位置和原版本继续读取');

  const lastPage = page(chars.slice(offset).join(''), offset, null, chars.length);
  assert.equal(lastPage.items[0].content_page.complete, false);
  const complete = action(preview, [firstPage, lastPage]);
  assert.equal(complete.tool, 'request_query');
  assert.equal(complete.args.sql, `SELECT ${longExpression}\nFROM demo_order_detail`
    + '\nWHERE is_test = 0 AND paid_amount_cents > 0\n AND paid_at >= :start AND paid_at < :end');
  checks.push('连续页读完才生成查询，完整保留来源SQL表达式');

  for (const state of ['not_available', 'stale'])
    expectGap(action(preview, [{items: [{kind: 'knowledge', ref: reference, state}]}]));
  checks.push('补读失败明确保留缺口');

  expectGap(action(preview, [page(sql, 0, null, sql.length, '8')]));
  checks.push('不同版本的正文不与命中对象拼接');

  expectGap(action(preview, [firstPage, page(chars.slice(offset + 1).join(''), offset + 1, null, chars.length)]));
  checks.push('分页存在缺口时不生成查询');
  const rawCitation = {source: {kind: 'document', id: 'document-cockpit-asr-candidates'}, revision: '7', locator: {offset: 10, length: 20}};
  const cockpitRun = {text: 'ASR耗时怎样统计', tool_contract_version: 2, workspace_context: {tasks: [], query_observations: [], memories: []}};
  const rawAction = cockpitAction(cockpitRun, {messages: [{role: 'user', content: cockpitRun.text},
    receipt('update_analysis_task', {routed: true, task_id: null}), receipt('search_knowledge', {
    hits: [{record_kind: 'source_excerpt', name: '端云识别与候选选择', citation: rawCitation, source_length: 60, text: '已找到的原文窗口', content_state: 'complete'}],
  })]});
  assert.equal(rawAction.tool, 'read_source');
  assert.deepEqual(rawAction.args.citation.source, rawCitation.source);
  assert.equal(rawAction.args.citation.revision, '7');
  const citation = {source: {kind: 'platform', id: 'business-guide'}, revision: '9', locator: {offset: 0, length: 120}};
  const explanationRun = {text: '月底下单为什么不在收入里', tool_contract_version: 2, workspace_context: {tasks: [], query_observations: [], memories: []}};
  const explain = syntheticAction(explanationRun, {messages: [{role: 'user', content: explanationRun.text},
    receipt('update_analysis_task', {routed: true, task_id: null}), receipt('search_knowledge', {
    hits: [{record_kind: 'knowledge_entry', ref: {object_id: 'document-guide-3', version: '9', path: 'body'}, name: '上游与加工', kind: 'document', definition: '正文预览', citations: [citation]}],
  })]});
  assert.equal(explain.tool, 'read_source');
  assert.deepEqual(explain.args.citation, citation);
  checks.push('v2座舱raw摘录与零售知识citation均按实际来源/修订读取');
  const zeroRun = {text: 'paid_amount_cents为0是什么意思', workspace_context: {tasks: [], query_observations: [], memories: []}};
  const etl = {source: {kind: 'platform', id: 'etl'}, revision: '1', locator: {offset: 0, length: 19}};
  const zero = syntheticAction(zeroRun, {messages: [{role: 'user', content: zeroRun.text},
    receipt('search_knowledge', {hits: [{record_kind: 'source_excerpt', citation: etl, source_length: 19}]}),
    receipt('read_source', {source: etl.source, revision: etl.revision, text: 'COALESCE(p.paid, 0)', next_locator: null}),
    receipt('update_analysis_task', {task_id: null, condition_version: null})]});
  assert.match(zero.text, /COALESCE|缺失|填.?0/);
  checks.push('按当前原文合同解释零付款，区分付款记录缺失');
  passed = true;
  console.log(JSON.stringify({passed, checks, officialRequests: 0}));
} finally {
  if (previousDemoProfile === undefined) delete process.env.DATA_AGENT_DEMO_PROFILE;
  else process.env.DATA_AGENT_DEMO_PROFILE = previousDemoProfile;
  await mkdir('.local/checks', {recursive: true});
  await writeFile('.local/checks/synthetic-knowledge-reading.json',
    JSON.stringify({passed, checks, officialRequests: 0}, null, 2));
}

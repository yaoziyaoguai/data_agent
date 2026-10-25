import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {syntheticAction} from '../../apps/agent/provider/synthetic-analysis.ts';

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
  passed = true;
  console.log(JSON.stringify({passed, checks, officialRequests: 0}));
} finally {
  if (previousDemoProfile === undefined) delete process.env.DATA_AGENT_DEMO_PROFILE;
  else process.env.DATA_AGENT_DEMO_PROFILE = previousDemoProfile;
  await mkdir('.local/checks', {recursive: true});
  await writeFile('.local/checks/synthetic-knowledge-reading.json',
    JSON.stringify({passed, checks, officialRequests: 0}, null, 2));
}

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { modelProtocolFixture } from '../runtime/model-protocol-fixture.mjs';
import { harness } from './harness.mjs';

const marker = 'syntheticalignmentprobe';
const profile = { provider_id: 'deepseek', model_id: 'deepseek-flash', trial_id: randomUUID(),
  price_version: '2026-10-04-peak-usd', input_limit: 65536, output_limit: 2048,
  trial_call_limit: 50, trial_cost_micros: '300000', request_call_limit: 24,
  toolset: 'data', payload_bytes_limit: 131072 };
const ok = response => {
  assert.equal(response.status, 200, JSON.stringify(response.value));
  return response.value;
};
const ref = (object, path) => ({ object_id: object.id, version: object.version, path });
const receipt = body => {
  const item = body.messages.findLast(message => message.role === 'tool');
  return JSON.parse(Array.isArray(item.content) ? item.content.map(part => part.text).join('') : item.content);
};

let h;
const steps = [];
const provider = await modelProtocolFixture({ completionsReply: body => steps.shift()(body) });
try {
  h = await harness({ profile, protocolProviderUrl: provider.url,
    env: { DATA_AGENT_LEASE_MS: '120000', DATA_AGENT_TOOL_CONTRACT_VERSION: '2' } });
  const updateTable = async id => {
    const table = ok(await h.request('/knowledge/' + id));
    const description = table.entries.find(entry => entry.entry_id === 'description');
    return ok(await h.request('/knowledge/' + id, { operation_id: randomUUID(),
      expected_version: table.version, entry_id: description.entry_id,
      value: `${description.effective_value}\n${marker}`, structured_value: description.effective_structure },
    'alice', 'PATCH'));
  };
  const lines = await updateTable('table-raw_order_lines');
  const payments = await updateTable('table-raw_payments');
  const create = async (kind, name, body, related_ids, structured_value) => ok(await h.request('/knowledge', {
    operation_id: randomUUID(), kind, name, body: `${marker} ${body}`, related_ids, structured_value,
  }));
  const quantity = await create('metric', '商品数量', '按商品行统计数量。', [lines.id], {
    kind: 'metric', table: ref(lines), expression: 'SUM(quantity)', input_grain: '一行一条订单商品',
    required_filters: ['is_test=0'], dimensions: [], unit: '件', time_column: 'ordered_at',
  });
  const paid = await create('metric', '已付款金额', '按成功付款事件累计金额。', [payments.id], {
    kind: 'metric', table: ref(payments), expression: 'SUM(amount_cents)', input_grain: '一行一条付款事件',
    required_filters: ["event_type='charge'", "event_status='success'"], dimensions: [], unit: '分', time_column: 'event_at',
  });
  const join = await create('relationship', '订单商品与付款事件', '付款明细按订单与商品行关联。', [lines.id, payments.id], {
    kind: 'relationship', left_table: ref(lines), right_table: ref(payments),
    join_keys: [{ left_column: 'order_id', right_column: 'order_id' }, { left_column: 'line_id', right_column: 'line_id' }],
    cardinality: 'one_to_many', scope: '未聚合的付款事件',
  });
  const refs = [ref(lines, 'ddl'), ref(payments, 'ddl'), ref(quantity, 'body'), ref(paid, 'body'), ref(join, 'body')];
  const sql = 'SELECT SUM(l.quantity), SUM(p.amount_cents) FROM raw_order_lines l '
    + 'LEFT JOIN raw_payments p ON l.order_id=p.order_id AND l.line_id=p.line_id';
  const validate = text => ({ name: 'validate_sql', args: {
    sql: text, parameters: {}, target_id: 'synthetic-sqlite', knowledge_refs: refs,
  } });

  steps.push(
    () => ({ name: 'update_analysis_task', args: { action: 'route', task_id: null, expected_version: null, goal: '', options: [] } }),
    () => ({ name: 'search_knowledge', args: { query: marker, limit: 10, kinds: ['table', 'metric', 'relationship'] } }),
    body => {
      const result = receipt(body);
      assert.ok(Array.isArray(result.key_hints), JSON.stringify(result));
      const hints = result.key_hints.join('\n');
      assert.match(hints, /raw_order_lines 唯一键.*order_id.*line_id/);
      assert.match(hints, /raw_payments 唯一键.*payment_event_id/);
      assert.match(hints, /关联键.*order_id.*line_id/);
      return validate(sql);
    },
    body => {
      const result = receipt(body);
      assert.equal(result.state, 'passed');
      const cte = result.semantic_checks.checks.find(check => check.rule === 'multi_grain_cte');
      assert.equal(cte.state, 'warning');
      for (const part of ['WITH metric_1 AS', 'metric_2 AS', 'SUM(quantity)', 'SUM(amount_cents)',
        'is_test=0', "event_type='charge'", "event_status='success'", 'GROUP BY "order_id", "line_id"',
        'LEFT JOIN metric_2', 'metric_1.join_key_2 = metric_2.join_key_2']) {
        assert.ok(cte.finding.includes(part), `${part}: ${cte.finding}`);
      }
      return validate(sql.replace(' AND l.line_id=p.line_id', ''));
    },
    body => {
      const checks = receipt(body).semantic_checks.checks;
      assert.ok(checks.some(check => check.rule === 'join_keys' && check.state === 'warning'));
      assert.ok(checks.every(check => check.rule !== 'multi_grain_cte'));
      return { text: '两项指标已按各自粒度准备 CTE，待核对筛选，未执行。' };
    },
  );

  const cid = await h.create();
  await h.send(cid, '对照订单商品数量和已付款金额，先验证 SQL，暂不执行。');
  const snapshot = await h.finished(cid);
  assert.deepEqual(provider.errors, []);
  assert.equal(provider.requests.length, 5);
  assert.equal(steps.length, 0);
  assert.match(snapshot.messages.findLast(message => message.role === 'assistant' && message.committed).text,
    /CTE，待核对筛选，未执行/);
  console.log(JSON.stringify({ passed: true, requests: provider.requests.length,
    primaryAndJoinKeys: true, cteAndMissingKeyControl: true, officialRequests: 0 }));
} finally {
  if (provider.errors.length) console.error(provider.errors);
  await h?.close();
  await provider.close();
}

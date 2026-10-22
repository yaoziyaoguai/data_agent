import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {harness} from './harness.mjs';
import {navigateWorkspace} from './experience-navigation.mjs';

// 核对资料接入和固定演示，不把它计为真实模型Dogfood。
const sourceDirectory = resolve('docs/sources/cockpit');
const catalog = JSON.parse(await readFile(sourceDirectory + '/semantic-catalog.json', 'utf8'));
const manifest = JSON.parse(await readFile(sourceDirectory + '/knowledge-manifest.json', 'utf8'));
const h = await harness({sourceDirectory, web: true, startupTimeout: 120000});
const checks = [];
let passed = false;
let browser;
const ok = response => {
  assert.equal(response.status, 200, JSON.stringify(response.value));
  return response.value;
};
const assertAuthoredDefinitions = object => {
  const expected = catalog.objects.find(value => value.id === object.id);
  assert.ok(expected, object.id);
  for (const entry of expected.entries) {
    if (entry.source_facts.classification !== 'authored_definition') continue;
    const actual = object.entries.find(value => value.entry_id === entry.entry_id);
    assert.equal(actual.effective_value, entry.effective_value, object.id + '/' + entry.path);
    if (entry.source_facts.structured_value)
      assert.deepEqual(actual.effective_structure, entry.source_facts.structured_value, object.id + '/' + entry.path);
  }
};
const platform = async (path, input) => {
  const response = await fetch(h.env.DATA_AGENT_PLATFORM_URL + path, {
    method: 'POST', headers: {'content-type': 'application/json', authorization: 'Bearer ' + h.env.DATA_AGENT_INTERNAL_TOKEN},
    body: JSON.stringify(input),
  });
  assert.equal(response.status, 200);
  return response.json();
};
try {
  ok(await h.request('/source-syncs', {operation_id: randomUUID()}));
  await h.pauseWorker();
  const objects = h.sql("SELECT JSON_OBJECT('id',id,'kind',kind,'name',name) FROM knowledge_objects WHERE state='enabled' AND source_id NOT LIKE 'catalog-%'");
  for (const [kind, count] of Object.entries({table: 28, field: 421, metric: 26, document: 14, relationship: 54}))
    assert.equal(objects.filter(object => object.kind === kind).length, count, kind);
  assert.ok(objects.every(object => !object.id.includes('demo_order')));
  for (const source of catalog.source_bundle) {
    const loaded = ok(await h.request('/sources/' + source.id));
    assert.equal(loaded.body, source.body, source.id);
  }
  checks.push('全部543语义对象及17份原始来源实际落库，正文逐份一致');

  const platformCatalog = await platform('/catalog', {limit: 50});
  assert.equal(platformCatalog.tables.length, 28);
  assert.equal(platformCatalog.complete, true);
  for (const table of platformCatalog.tables) {
    assert.equal((await platform('/validate', {sql: `SELECT COUNT(*) FROM ${table.name}`, parameters: {}})).state, 'passed');
    const fields = h.sql(`SELECT body FROM knowledge_objects WHERE kind='field' AND source_id NOT LIKE 'catalog-%' AND JSON_CONTAINS(JSON_EXTRACT(body,'$.related_ids'), JSON_QUOTE('table-${table.name}'))`);
    for (const column of table.columns) {
      const field = fields.find(object => object.name === table.name + '.' + column.name);
      assert.ok(field, table.name + '.' + column.name);
      const type = field.entries.find(entry => entry.path === 'type');
      assert.equal(type.effective_value, column.data_type + (column.nullable ? '，可空' : ''), field.name);
      assert.ok(type.source_facts.quote.includes(column.name), field.name);
      assertAuthoredDefinitions(field);
    }
    const loaded = ok(await h.request('/knowledge/table-' + table.name));
    assertAuthoredDefinitions(loaded);
    const expectedNode = manifest.etl_nodes.find(node => node.target_table === table.name);
    if (expectedNode) {
      assert.equal(table.node.sql, expectedNode.sql);
      assert.deepEqual(table.node.upstream_ids, expectedNode.upstream_tables);
      assert.equal(loaded.entries.find(entry => entry.path === 'etl').effective_value.trim(), expectedNode.sql.trim());
    } else assert.equal(table.node, null);
  }
  for (const object of objects.filter(value => !['table', 'field'].includes(value.kind)))
    assertAuthoredDefinitions(ok(await h.request('/knowledge/' + object.id)));
  assert.equal((await platform('/validate', {sql: 'SELECT * FROM demo_order_detail', parameters: {}})).state, 'rejected');
  checks.push('28张真实平台表均可编译读取；421字段类型按所属表刷新；三个mart分别携带真实ETL及上游');
  checks.push('全部人工定义的表/字段/指标/文档/关联正文与结构经实际导入和来源刷新后完整保留');

  await h.resumeWorker();
  const cid = await h.create();
  await h.send(cid, '查2026年9月语音任务达成率');
  await h.finished(cid);
  const draft = ok(await h.request('/conversations/' + cid + '/queries')).queries[0];
  assert.ok(draft, '固定演示应生成草稿');
  assert.equal(draft.execution_state, 'not_submitted');
  assert.match(draft.sql, /syn_daily_voice_experience/);
  assert.match(draft.sql, /NULLIF/);
  await h.send(cid, '执行这条');
  const snapshot = await h.finished(cid, 3);
  const query = ok(await h.request('/queries/' + draft.id));
  assert.equal(query.execution_state, 'succeeded');
  const answers = snapshot.messages.filter(message => message.role === 'assistant' && message.committed);
  assert.match(answers.at(-1).text, /固定合成演示/);
  assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM tool_calls WHERE conversation_id='${cid}' AND tool_name='present_analysis_answer' AND state='succeeded'`)[0].n, 1);
  assert.equal(snapshot.runs.filter(run => run.state === 'failed').length, 0);
  checks.push('实际Pi查定义→草稿→用户授权→SQLite执行→来源绑定答案；草稿未获授权前保持未提交');

  for (const question of ['ASR耗时怎样统计', '语音交互链路有哪些表']) {
    const explanation = await h.create();
    await h.send(explanation, question);
    const output = await h.finished(explanation);
    assert.equal(ok(await h.request('/conversations/' + explanation + '/queries')).queries.length, 0);
    assert.ok(output.messages.some(message => message.role === 'assistant' && message.committed && /真实模型/.test(message.text)));
    assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM tool_calls WHERE conversation_id='${explanation}' AND tool_name='read_knowledge' AND state='succeeded'`)[0].n, 1);
  }
  checks.push('两个说明入口读取真实文档，不生成或执行额外查询');

  browser = await chromium.launch();
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(h.url);
  await page.getByLabel('演示登录凭据').fill(h.tokens.alice);
  await page.getByRole('button', {name: '进入工作台 →', exact: true}).click();
  await navigateWorkspace(page, '语义管理');
  await page.locator('.object-heading h2').filter({hasText: /^syn_/}).waitFor();
  const listedTables = await page.getByRole('navigation', {name: '语义对象', exact: true}).innerText();
  assert.match(listedTables, /syn_voice_turn/);
  assert.ok(!listedTables.includes('demo_order_detail'));
  assert.deepEqual(errors, []);
  checks.push('语义管理首屏直接列出语音表并选中有效对象，字段数量不挤掉表目录，无旧零售默认对象');
  passed = true;
  console.log(JSON.stringify({passed, checks, officialRequests: 0}));
} finally {
  if (browser) await browser.close();
  await writeFile('.local/checks/cockpit-runtime.json', JSON.stringify({passed, checks, officialRequests: 0, runtime: h.directory}, null, 2));
  await h.close();
}

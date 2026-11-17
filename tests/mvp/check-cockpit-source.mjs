import {synchronizeSources} from './source-sync.mjs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {harness} from './harness.mjs';
import {navigateWorkspace} from './experience-navigation.mjs';

// 核对资料接入和固定演示，不把它计为真实模型Dogfood。
const retail = process.argv.includes('--retail');
const sourceDirectory = resolve(retail ? 'docs/sources' : 'docs/sources/cockpit');
const catalog = JSON.parse(await readFile(sourceDirectory + '/semantic-catalog.json', 'utf8'));
const manifest = JSON.parse(await readFile(sourceDirectory + '/knowledge-manifest.json', 'utf8'));
const version = process.argv.includes('--v2') ? '2' : '1';
const h = await harness({sourceDirectory, web: true, startupTimeout: 120000,
  env: {DATA_AGENT_TOOL_CONTRACT_VERSION: version, DATA_AGENT_PUBLIC_CONTENT_RETENTION: 'latest_only'}});
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
  assert.equal((await synchronizeSources(h)).value.status, 'completed');
  if (retail) {
    for (const question of ['月底下单为什么不在收入里', 'paid_amount_cents为0是什么意思']) {
      const cid = await h.create(); await h.send(cid, question); const output = await h.finished(cid);
      const text = output.messages.filter(message => message.role === 'assistant' && message.committed).map(message => message.text).join('\n');
      assert.match(text, question.includes('paid_amount') ? /没有成功付款.*NULL/ : /paid_at/);
      assert.doesNotMatch(text, /不可读取|未完成口径核对/);
      assert.equal(ok(await h.request('/conversations/' + cid + '/queries')).queries.length, 0);
      assert.ok(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM tool_calls WHERE conversation_id='${cid}' AND tool_name IN ('read_source','read_knowledge') AND state='succeeded'`)[0].n > 0);
    }
    checks.push('旧零售月底/零付款解释按实际v2来源取证，缺citation的词法回执可用且无查询执行');
    passed = true; console.log(JSON.stringify({passed, checks, officialRequests: 0}));
  } else {
  await h.pauseWorker();
  const objects = h.sql("SELECT JSON_OBJECT('id',id,'kind',kind,'name',name) FROM knowledge_objects WHERE state='enabled' AND source_id NOT LIKE 'catalog-%'");
  for (const [kind, count] of Object.entries({table: 28, field: 421, metric: 30, document: 14, relationship: 54}))
    assert.equal(objects.filter(object => object.kind === kind).length, count, kind);
  assert.ok(objects.every(object => !object.id.includes('demo_order')));
  for (const source of catalog.source_bundle) {
    const loaded = ok(await h.request('/sources/' + source.id));
    assert.equal(loaded.body, source.body, source.id);
  }
  checks.push('全部547语义对象及17份原始来源实际落库，正文逐份一致');

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

  const metric = ok(await h.request('/knowledge/metric-task_completion_rate'));
  const definition = metric.entries.find(entry => entry.path === 'definition');
  const revised = ok(await h.request('/knowledge/' + metric.id, {operation_id: randomUUID(),
    expected_version: metric.version, entry_id: definition.entry_id,
    value: definition.effective_value + '\n合成修订核对：分子与分母保持原口径。'}, 'alice', 'PATCH'));
  assert.notEqual(revised.version, '1');
  await h.resumeWorker();
  const cid = await h.create();
  await h.send(cid, '查2026年9月语音任务达成率');
  await h.finished(cid);
  const draft = ok(await h.request('/conversations/' + cid + '/queries')).queries[0];
  assert.ok(draft, '固定演示应生成草稿');
  assert.equal(draft.execution_state, 'not_submitted');
  assert.ok(draft.knowledge_refs.some(ref => ref.object_id === metric.id && ref.version === revised.version),
    '草稿必须引用实际补读修订，不能回退到版本1');
  const ledger = h.sql(`SELECT JSON_OBJECT('version',tool_contract_version) FROM agent_runs WHERE conversation_id='${cid}'`);
  assert.ok(ledger.length && ledger.every(run => run.version === Number(version)));
  assert.match(draft.sql, /syn_daily_voice_experience/);
  assert.match(draft.sql, /NULLIF/);
  await h.send(cid, '执行这条');
  const snapshot = await h.finished(cid, 3);
  const query = ok(await h.request('/queries/' + draft.id));
  assert.equal(query.execution_state, 'succeeded');
  const answers = snapshot.messages.filter(message => message.role === 'assistant' && message.committed);
  assert.match(answers.at(-1).text, /固定合成演示/);
  // v2合同移除日常present选择，结果解释经prepare_analysis_answer绑定交付；v1固定演示走present。
  const answerTool = version === '2' ? 'prepare_analysis_answer' : 'present_analysis_answer';
  const otherTool = version === '2' ? 'present_analysis_answer' : 'prepare_analysis_answer';
  assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM tool_calls WHERE conversation_id='${cid}' AND tool_name='${answerTool}' AND state='succeeded'`)[0].n, 1);
  assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM tool_calls WHERE conversation_id='${cid}' AND tool_name='${otherTool}'`)[0].n, 0);
  assert.equal(snapshot.runs.filter(run => run.state === 'failed').length, 0);
  checks.push('实际Pi查定义→草稿→用户授权→SQLite执行→来源绑定答案；草稿未获授权前保持未提交');

  for (const question of ['ASR耗时怎样统计', '语音交互链路有哪些表']) {
    const explanation = await h.create();
    await h.send(explanation, question);
    const output = await h.finished(explanation);
    assert.equal(ok(await h.request('/conversations/' + explanation + '/queries')).queries.length, 0);
    assert.ok(output.messages.some(message => message.role === 'assistant' && message.committed && /真实模型/.test(message.text)),
      JSON.stringify({question, messages: output.messages.filter(message => message.role === 'assistant').map(message => message.text)}));
    const reads = h.sql(`SELECT receipt FROM tool_calls WHERE conversation_id='${explanation}' AND tool_name='read_knowledge' AND state='succeeded'`);
    assert.ok(reads.length > 0);
    if (version === '1') assert.equal(reads.length, 1);
    else {
      const pages = reads.map(receipt => receipt.data.items[0]).sort((a, b) => a.content_page.offset - b.content_page.offset);
      let offset = 0;
      for (const item of pages) {
        assert.equal(item.state, 'ok');
        assert.equal(item.content_page.offset, offset);
        offset += [...item.content].length;
      }
      assert.equal(offset, pages.at(-1).content_page.total_chars);
      assert.equal(pages.at(-1).continuation.content_next_offset, null);
    }
  }
  checks.push('两个说明入口读取真实文档，不生成或执行额外查询');

  const document = ok(await h.request('/knowledge/document-cockpit-asr-candidates'));
  ok(await h.request('/knowledge/' + document.id + '/disable', {operation_id: randomUUID(), expected_version: document.version}));
  const unavailable = await h.create();
  await h.send(unavailable, 'ASR耗时怎样统计');
  const missing = await h.finished(unavailable);
  const missingText = missing.messages.filter(message => message.role === 'assistant' && message.committed).map(message => message.text).join('\n');
  assert.match(missingText, /未能完整读取/);
  assert.doesNotMatch(missingText, /ASR尝试用wall_ms/);
  assert.equal(ok(await h.request('/conversations/' + unavailable + '/queries')).queries.length, 0);
  checks.push('停用资料明确报告缺口，不输出仿佛已完成取证的固定解释；非1修订及实际run合同保持');

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
  }
} finally {
  if (browser) await browser.close();
  await writeFile('.local/checks/cockpit-runtime.json', JSON.stringify({passed, checks, officialRequests: 0, runtime: h.directory}, null, 2));
  await h.close();
}

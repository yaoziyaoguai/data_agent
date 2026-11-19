import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {copyFile, mkdir, readFile, writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {deliver} from '../../apps/agent/session/deliver.ts';
import {harness, until} from './harness.mjs';
import {embeddingProvider} from './embedding-provider.mjs';

const directory = process.env.DATA_AGENT_SOURCE_CHECK_DIRECTORY;
const scenario = process.argv[2] ?? 'all';
assert.ok(['all', 'platform-roots', 'incomplete-upstream', 'document', 'explicit-dependencies', 'formal-statement-search', 'source-selection'].includes(scenario));
if (directory) await mkdir(directory, {recursive: true});
const evidence = {passed: false, scenario, officialRequests: 0, checks: [], responses: []};
const precise = {
  source: 'synthetic-precise-source',
  prefix: '合成导言🌏é。\n',
  first: 'syntheticprecisefirst：甲字段取 A/B；校验未完成时不计入🧪。',
  unrelated: 'UNRELATED_SOURCE_SELECTION_FIELD：无关字段及其业务含义不得交付。',
  second: 'syntheticprecisesecond：乙字段取 X/Y；撤销后的记录必须排除。',
  repeated: 'syntheticpreciserepeated：重复定位不能猜第一处。',
  caseSensitive: 'syntheticprecisecase：É 与 é 保持原字节。',
  caseVariant: 'SYNTHETICPRECISECASE：É 与 é 保持原字节。',
};
const settlement = {
  source: 'synthetic-settlement-month-rules',
  unrelated: 'UNRELATED_SETTLEMENT_FIELD 复核批次号供审计检索。',
  fields: [
    {column: 'paid_at', text: 'demo_order_detail.paid_at 取首次付款的 UTC 时间。空值不归入任何月份。'},
    {column: 'order_status', text: 'demo_order_detail.order_status 为 paid 或 refunded 时计入已结算行数。全额退款也保留一行。'},
  ].map(field => ({...field, name: 'demo_order_detail.' + field.column,
    directoryId: 'field-a-settlement-' + field.column, definitionId: 'field-z-settlement-' + field.column})),
};
let sourceDirectory;
if (scenario === 'source-selection') {
  sourceDirectory = (directory ?? process.cwd() + '/.local/checks/source-selection-' + randomUUID()) + '/fixtures';
  await mkdir(sourceDirectory, {recursive: true});
  for (const file of ['schema.sql', 'etl.sql', 'business-guide.md', 'seed.sql', 'knowledge-manifest.json'])
    await copyFile('docs/sources/' + file, sourceDirectory + '/' + file);
  const catalog = JSON.parse(await readFile('docs/sources/semantic-catalog.json', 'utf8'));
  precise.body = precise.prefix + precise.first + '\n' + precise.unrelated + '\n' + precise.second + '\n'
    + precise.repeated + '\n' + precise.repeated + '\n' + precise.caseSensitive + '\n' + precise.caseVariant + '\n';
  catalog.source_bundle = [{id: precise.source, body: precise.body,
    sha256: createHash('sha256').update(precise.body).digest('hex')}];
  precise.objects = [precise.first, precise.second, precise.repeated, precise.caseSensitive].map((text, index) => {
    const structure = {kind: 'field', table: {object_id: 'table-demo_order_detail', version: '1'},
      column: index === 1 ? 'refunded_amount_cents' : 'paid_amount_cents', unit: null};
    return {id: 'field-source-selection-' + index, name: 'demo_order_detail.' + structure.column,
      kind: 'field', version: '1', state: 'enabled', source_id: precise.source, source_version: '1',
      related_ids: ['table-demo_order_detail'], updated_by: 'synthetic-import',
      entries: [{entry_id: 'meaning', path: 'meaning', label: '字段含义', effective_value: text,
        source_facts: {value: text, quote: text, source_id: precise.source, version: '1', location: '字段含义',
          classification: 'authored_definition', complete: true, structured_value: structure,
          structured_evidence: [{source_id: precise.source, version: '1', location: '字段定义', quote: text}]},
        effective_structure: structure, suggestion: {}, human_override: null, review_state: 'unverified'}]};
  });
  for (const object of precise.objects) {
    const column = object.entries[0].effective_structure.column;
    const original = catalog.objects.find(value => value.id === 'field-' + column);
    object.entries.push(structuredClone(original.entries.find(entry => entry.path === 'type')));
  }
  catalog.objects.push(...precise.objects);
  settlement.body = ['合成结算规则 📋', settlement.fields[0].text, settlement.unrelated, settlement.fields[1].text, ''].join('\n');
  catalog.source_bundle.push({id: settlement.source, body: settlement.body,
    sha256: createHash('sha256').update(settlement.body).digest('hex')});
  for (const field of settlement.fields) {
    const original = catalog.objects.find(object => object.id === 'field-' + field.column);
    const type = original.entries.find(entry => entry.path === 'type');
    const directory = {...original, id: field.directoryId, name: field.name, source_id: 'schema', entries: [type]};
    field.version = directory.version;
    const structure = {kind: 'field', table: {object_id: 'table-demo_order_detail', version: '1'}, column: field.column, unit: null};
    catalog.objects.push(directory, {...directory, id: field.definitionId, source_id: settlement.source, entries: [
      {entry_id: 'meaning', path: 'meaning', label: '字段含义', effective_value: field.text, effective_structure: structure,
        source_facts: {value: field.text, quote: field.text, source_id: settlement.source, version: '1', location: '结算定义',
          classification: 'authored_definition', complete: true, structured_value: structure,
          structured_evidence: [{source_id: settlement.source, version: '1', location: '结算定义', quote: field.text}]},
        suggestion: {}, human_override: null, review_state: 'unverified'}, type,
    ]});
  }
  await writeFile(sourceDirectory + '/semantic-catalog.json', JSON.stringify(catalog));
}
const embedding = sourceDirectory ? await embeddingProvider() : null;
const collection = 'data_agent_test_' + randomUUID().replaceAll('-', '');
const payloadBytesLimit = 131072;
const providerRequests = [], providerErrors = [], receivedPayloads = [];
const previousProviderTest = process.env.DATA_AGENT_PROVIDER_TEST;
let protocolProvider, providerSelection, providerSource, activeSettlement, providerCalls = 0;
let run;
if (sourceDirectory) {
  process.env.DATA_AGENT_PROVIDER_TEST = '1';
  protocolProvider = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      const input = JSON.parse(raw.toString('utf8'));
      providerRequests.push(input);
      providerCalls++;
      const canReadSource = input.tools.some(tool => tool.function.name === 'read_source'
        && tool.function.parameters.properties.citation);
      receivedPayloads.push({request: providerCalls, stage: activeSettlement?.stage ?? 'source-selection',
        tool_contract_version: run.tool_contract_version, read_source_visible: canReadSource, bytes: raw.length});
      assert.equal(run.tool_contract_version, 2);
      assert.equal(run.model_profile.payload_bytes_limit, payloadBytesLimit);
      assert.ok(raw.length <= payloadBytesLimit, 'v2 实际 HTTP 正文须在原 128 KiB 门内');
      const messages = JSON.stringify(input.messages);
      assert.ok(!messages.includes('UNRELATED_SOURCE_SELECTION_FIELD') && !messages.includes(settlement.unrelated),
        '每次Pi出站请求都只携带所选的获准原文');
      const search = input.tools.find(tool => tool.function.name === 'search_knowledge')?.function;
      assert.ok(search?.parameters.properties.cursor && search.parameters.properties.source_selection);
      assert.match(search.description, /完整字段名、表名或文档名窄查.*目标仍缺.*窄查或续页/);
      if (!activeSettlement) assert.equal(canReadSource, providerCalls >= 3);
      const result = id => {
        const direct = input.messages.find(message => message.role === 'tool' && message.tool_call_id === id);
        if (direct) return JSON.parse(direct.content);
        // 来源未就绪时，身份回执沿既有宿主控制投影以user文本交付。
        for (const message of input.messages) for (const part of Array.isArray(message.content) ? message.content : []) {
          if (!part.text?.startsWith('{"sdk_tool_call_id":')) continue;
          const projected = JSON.parse(part.text);
          if (projected.sdk_tool_call_id === id) return projected.data;
        }
        assert.fail('缺少真实工具回执 ' + id);
      };
      const tool = (id, name, args, index = 0) => ({index, id, type: 'function', function: {name, arguments: JSON.stringify(args)}});
      let delta;
      if (activeSettlement) {
        delta = {role: 'assistant', ...activeSettlement.reply({messages, canReadSource, result, tool})};
      } else if (providerCalls === 1) {
        delta = {role: 'assistant', tool_calls: [tool('selection-discover', 'search_knowledge', {
          view: 'source_identity', query: 'field-source-selection-0 field-source-selection-1', kinds: ['field']})]};
      } else if (providerCalls === 2) {
        const identity = result('selection-discover');
        providerSelection = identity.hits.map(hit => ({object_id: hit.object_id, version: hit.object_version}));
        assert.equal(providerSelection.length, 2);
        providerSource = identity.hits[0].source_keys.find(source => source.id === precise.source);
        assert.ok(providerSource);
        delta = {role: 'assistant', tool_calls: [tool('selection-task', 'update_analysis_task', {action: 'create',
          goal: '只精读合成甲乙字段的含义与例外。', options: [], conditions: {
            time_start: null, time_end: null, timezone: 'UTC', metric: null, channel: null,
            group_by: [], filters: [], knowledge_refs: [], notes: '',
            source_limits: {allowed_sources: [providerSource], origin_message_ids: [run.message_id]}}})]};
      } else if (providerCalls === 3) {
        delta = {role: 'assistant', tool_calls: [tool('selection-search', 'search_knowledge', {
          query: 'syntheticprecisefirst syntheticprecisesecond', source_selection: providerSelection})]};
      } else if (providerCalls === 4) {
        const found = result('selection-search');
        assert.deepEqual(found.hits.map(hit => hit.text), [precise.first, precise.second]);
        assert.ok(found.hits.every(hit => hit.record_kind === 'source_excerpt'));
        delta = {role: 'assistant', tool_calls: found.hits.map((hit, index) =>
          tool('selection-read-' + index, 'read_source', {citation: hit.citation}, index))};
      } else {
        assert.equal(providerCalls, 5, '仅身份、任务、搜索、原生补读与续答，无额外模型调查或摘要');
        assert.equal(result('selection-read-0').text, precise.first);
        assert.equal(result('selection-read-1').text, precise.second);
        delta = {role: 'assistant', content: '已核对甲乙字段的原文定义与例外。'};
      }
      response.writeHead(200, {'content-type': 'text/event-stream'});
      response.write('data: ' + JSON.stringify({id: 'source-selection', choices: [{index: 0, delta,
        finish_reason: delta.tool_calls ? 'tool_calls' : 'stop'}]}) + '\n\n');
      response.write('data: ' + JSON.stringify({choices: [], usage: {prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100}}) + '\n\n');
      response.end('data: [DONE]\n\n');
    } catch (error) {
      providerErrors.push(error.message);
      response.writeHead(400, {'content-type': 'application/json'}).end(JSON.stringify({error: {
        message: 'synthetic_source_selection_failed', type: 'invalid_request_error'}}));
    }
  });
  await new Promise(resolve => protocolProvider.listen(0, '127.0.0.1', resolve));
}
const h = await harness({capture: true, startWorker: false,
  ...(sourceDirectory ? {sourceDirectory, platformSourceDirectory: sourceDirectory,
    protocolProviderUrl: 'http://127.0.0.1:' + protocolProvider.address().port,
    profile: {provider_id: 'deepseek', model_id: 'deepseek-flash', trial_id: randomUUID(),
      price_version: '2026-10-04-peak-usd', input_limit: 65536, output_limit: 8192,
      trial_call_limit: 24, trial_cost_micros: '300000', request_call_limit: 24,
      toolset: 'data', payload_bytes_limit: payloadBytesLimit, thinking_level: 'off'}} : {}),
  env: {DATA_AGENT_TOOL_CONTRACT_VERSION: '2', DATA_AGENT_PREFILL_PROFILE: '', DATA_AGENT_LEASE_MS: '120000',
    ...(embedding ? {...embedding.env, DATA_AGENT_VECTOR_URL: 'http://127.0.0.1:19531',
      DATA_AGENT_VECTOR_COLLECTION: collection,
      DATA_AGENT_VECTOR_TOKEN_FILE: process.cwd() + '/.local/infra/milvus-root-password'} : {})}});
const quote = value => "'" + String(value).replaceAll('\\', '\\\\').replaceAll("'", "''") + "'";
const ok = response => {assert.equal(response.status, 200, JSON.stringify(response.value)); return response.value;};
function assertExactCoverage(reply, state, message) {
  const coverage = reply.search_coverage;
  assert.equal(coverage.channels.find(channel => channel.channel === 'exact')?.state, 'available', message);
  assert.equal(coverage.state, state, message);
  assert.ok(!coverage.reasons.includes('channel_unavailable'), message);
}
const manager = SessionManager.inMemory('/synthetic/source-search-admission');
const invoke = async (name, args, expectedError, responseBudget, sdkToolCallId = randomUUID()) => {
  const input = {run_id: run.run_id, lease_epoch: run.lease_epoch,
    sdk_tool_call_id: sdkToolCallId, tool_name: name, arguments: args,
    ...(responseBudget ? {response_budget: responseBudget} : {}),
    checkpoint: exportCheckpoint(manager, run.workspace_context.authority_revision, run.workspace_context.authority_snapshot)};
  const registered = await h.internal('/internal/data/tool-calls', input);
  if (registered.status !== 200) evidence.responses.push({name, arguments: args, registration: registered});
  ok(registered);
  const response = await h.internal('/internal/data/tools', input);
  evidence.responses.push({name, arguments: args, ...response});
  if (!expectedError) return ok(response).data;
  assert.notEqual(response.status, 200);
  assert.equal(response.value.code, expectedError, JSON.stringify(response.value));
  const rejection = ok(await h.internal('/internal/data/tool-rejections', input));
  assert.equal(rejection.data.error, expectedError);
  return rejection.data;
};
const start = async (allowed_sources, goal) => {
  await h.resumeWorker();
  run = await h.capture(await h.create(), goal);
  await h.pauseWorker();
  const task = await invoke('update_analysis_task', {action: 'create', goal, options: [],
    conditions: {time_start: null, time_end: null, timezone: 'UTC', metric: null, channel: null,
      group_by: [], filters: [], knowledge_refs: [], notes: '',
      source_limits: {allowed_sources, origin_message_ids: [run.message_id]}}});
  assert.ok(task.task_id);
};

async function checkSettlementContinuation() {
  const cid = await h.create();
  const fields = settlement.fields;
  const fieldsById = new Map(fields.map(field => [field.definitionId, field]));
  const expectedSource = {kind: 'platform', id: settlement.source};
  const expectedRoots = new Set([{kind: 'platform', id: 'schema'}, expectedSource]);
  const excerpts = fields.map(field => field.text).sort();
  const may = {time_start: '2026-05-01T00:00:00Z', time_end: '2026-06-01T00:00:00Z'};
  const june = {time_start: '2026-06-01T00:00:00Z', time_end: '2026-07-01T00:00:00Z'};
  const cutoff = '2026-07-03T00:00:00Z';
  const sql = "SELECT COUNT(*) AS settled_rows FROM demo_order_detail " +
    "WHERE paid_at >= :time_start AND paid_at < :time_end AND paid_at < :cutoff AND order_status IN ('paid', 'refunded')";
  const names = fields.map(field => field.name).join(' ');
  const discovery = {view: 'source_identity'};
  const details = evidence.settlement = {conversation: cid, modelChoices: 'scripted', firstRequest: providerCalls + 1};
  let selection, source, found, initial, revised, firstDraft, nextDraft;
  const draft = (task, bounds, replaces_query_id) => ({task_id: task.task_id,
    condition_version: task.condition_version, sql, parameters: {...bounds, cutoff}, target_id: 'synthetic-sqlite',
    summary: '合成结算行数草稿，尚未执行。', knowledge_refs: [], replaces_query_id});
  const runSteps = async (stage, text, readyAt, steps) => {
    await h.resumeWorker();
    run = await h.capture(cid, text);
    await h.pauseWorker();
    let index = 0;
    activeSettlement = {stage, reply: ({messages, canReadSource, result, tool}) => {
      assert.ok(index < steps.length, 'Pi 发起了未预期的额外调用');
      assert.equal(canReadSource, index >= readyAt, 'read_source 须随实际范围就绪状态投影');
      assert.ok(messages.includes(JSON.stringify(text)), '每次实际请求带本轮完整用户输入');
      return steps[index++](result, (...args) => ({tool_calls: [tool(...args)]}), tool);
    }};
    try {
      await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, '');
      assert.deepEqual(providerErrors, []);
      assert.equal(index, steps.length);
      assert.equal((await h.snapshot(cid)).runs.find(item => item.run_id === run.run_id).state, 'finished');
    } finally {
      h.releaseRun(run.run_id);
      activeSettlement = undefined;
    }
  };
  await runSteps('settlement-may', `按 ${settlement.source} 的 ${names} 定义和例外，用 UTC 统计五月已结算行数。观察截点 ${cutoff}。只保存草稿。`, 4, [
    (_result, call) => call('settlement-broad', 'search_knowledge', {...discovery, query: 'demo_order_detail raw_payments', limit: 3}),
    (result, call) => {
      const broad = details.broad = result('settlement-broad');
      assert.equal(broad.hits.length, 3);
      const ids = broad.hits.map(hit => hit.object_id);
      assert.deepEqual(ids, [...ids].sort());
      for (const field of fields) {
        const directory = broad.hits.find(hit => hit.object_id === field.directoryId);
        assert.equal(directory?.name, field.name);
        assert.deepEqual(directory.source_keys, [{kind: 'platform', id: 'schema'}]);
      }
      assert.ok(!broad.hits.some(hit => hit.source_keys.some(key => key.id === settlement.source)));
      const coverage = broad.search_coverage;
      assertExactCoverage(broad, 'bounded', '实际出站首批目录保留候选截断');
      assert.deepEqual(coverage.reasons, ['candidate_limit']);
      assert.match(coverage.next, /^source_identity:1:/);
      return call('settlement-narrow', 'search_knowledge', {...discovery, query: names, kinds: ['field']});
    },
    (result, call) => {
      const narrow = details.narrow = result('settlement-narrow');
      selection = fields.map(field => {
        const sameName = narrow.hits.filter(hit => hit.name === field.name);
        assert.deepEqual(sameName.map(hit => hit.object_id), [field.directoryId, field.definitionId]);
        const formal = sameName.find(hit => hit.source_keys.some(key => key.id === settlement.source));
        assert.equal(formal?.object_id, field.definitionId);
        assert.equal(formal.object_version, field.version);
        assert.equal(formal.roots_complete, true);
        return {object_id: formal.object_id, version: formal.object_version};
      });
      return call('settlement-rules-identity', 'search_knowledge', {...discovery, query: settlement.source});
    },
    (result, call) => {
      const rules = details.rules = result('settlement-rules-identity');
      assert.ok(rules.hits.every(hit => hit.record_kind === 'source_identity' && hit.roots_complete === true));
      const objects = rules.hits.filter(hit => Object.hasOwn(hit, 'object_id'));
      assert.deepEqual(objects.map(hit => hit.object_id).sort(), [...fieldsById.keys()].sort());
      for (const hit of objects) {
        const field = fieldsById.get(hit.object_id);
        assert.equal(hit.kind, 'field');
        assert.equal(hit.name, field.name);
        assert.equal(hit.object_version, field.version);
        assert.deepEqual(new Set(hit.source_keys), expectedRoots);
      }
      const platform = rules.hits.filter(hit => !Object.hasOwn(hit, 'object_id'));
      assert.equal(platform.length, 1);
      const [hit] = platform;
      assert.ok(!Object.hasOwn(hit, 'object_version'));
      assert.equal(hit.name, settlement.source);
      assert.deepEqual(hit.source_keys, [expectedSource]);
      assertExactCoverage(rules, 'searched', '两字段及独立平台身份已完整交付');
      assert.equal(rules.search_coverage.next, null);
      [source] = hit.source_keys;
      return call('settlement-task', 'update_analysis_task', {action: 'create', goal: '按正式定义保存已结算行数草稿。', options: [],
        conditions: {...may, timezone: 'UTC', metric: '已结算行数', channel: null, group_by: [],
          filters: ['已付款或已退款', '全额退款保留一行'], knowledge_refs: [], notes: '',
          source_limits: {allowed_sources: [source], origin_message_ids: [run.message_id]},
          time_roles: [{role: 'event_time', description: '付款时间归月', field_ref: fields[0].name, value: null, evidence_refs: []},
            {role: 'observation_cutoff', description: '观察截点', field_ref: null, value: cutoff, evidence_refs: []}]}});
    },
    (result, call) => {
      initial = result('settlement-task');
      assert.deepEqual(initial.conditions.source_limits, {allowed_sources: [source], origin_message_ids: [run.message_id]});
      return call('settlement-search', 'search_knowledge', {query: names, source_selection: selection});
    },
    (result, _call, tool) => {
      found = details.search = result('settlement-search');
      assertExactCoverage(found, 'searched', '实际首份取证精确覆盖获准的两条定义');
      assert.deepEqual(found.hits.map(hit => hit.text).sort(), excerpts);
      return {tool_calls: found.hits.map((hit, index) => {
        assert.equal(hit.record_kind, 'source_excerpt');
        assert.deepEqual(hit.citation.source, source);
        assert.equal(hit.citation.revision, '1');
        const {offset, length} = hit.citation.locator;
        assert.equal([...settlement.body].slice(offset, offset + length).join(''), hit.text);
        return tool('settlement-read-' + index, 'read_source', {citation: hit.citation}, index);
      })};
    },
    (result, call) => {
      details.reads = found.hits.map((hit, index) => {
        const read = result('settlement-read-' + index);
        assert.deepEqual(read.source, hit.citation.source);
        assert.equal(read.revision, hit.citation.revision);
        assert.equal(read.text, hit.text);
        assert.deepEqual(read.locator, hit.citation.locator);
        assert.equal(read.next_locator, null);
        return read;
      });
      return call('settlement-may-draft', 'request_query', draft(initial, may, null));
    },
    result => {
      firstDraft = result('settlement-may-draft');
      assert.equal(firstDraft.confirmation_state, 'awaiting_confirmation');
      return {content: '五月草稿已保存。'};
    },
  ]);
  await runSteps('settlement-june', '只把统计月份改为六月，沿用 UTC、观察截点和原资料范围。保存替代草稿。', 1, [
    (_result, call) => call('settlement-revise', 'update_analysis_task', {action: 'revise', task_id: initial.task_id,
      expected_version: initial.condition_version, goal: '', options: [], condition_patch: {set: june, unset: []}}),
    (result, call) => {
      revised = result('settlement-revise');
      assert.deepEqual(revised.conditions, {...initial.conditions, ...june});
      assert.equal(revised.task_id, initial.task_id);
      assert.notEqual(revised.condition_version, initial.condition_version);
      assert.ok(revised.superseded_query_ids.includes(firstDraft.id));
      return call('settlement-june-draft', 'request_query', draft(revised, june, firstDraft.id));
    },
    result => {
      nextDraft = result('settlement-june-draft');
      assert.equal(nextDraft.confirmation_state, 'awaiting_confirmation');
      return {content: '六月替代草稿已保存。'};
    },
  ]);
  const old = ok(await h.request('/queries/' + firstDraft.id));
  const replacement = ok(await h.request('/queries/' + nextDraft.id));
  assert.equal(old.confirmation_state, 'superseded');
  assert.equal(replacement.confirmation_state, 'awaiting_confirmation');
  assert.equal(replacement.replaces_query_id, old.id);
  for (const [saved, task, bounds] of [[old, initial, may], [replacement, revised, june]]) {
    assert.equal(saved.task_id, task.task_id);
    assert.equal(saved.condition_version, task.condition_version);
    assert.equal(saved.sql, sql);
    assert.deepEqual(saved.parameters, {...bounds, cutoff});
    assert.deepEqual(saved.time_basis, {...bounds, timezone: 'UTC', time_roles: initial.conditions.time_roles});
    assert.equal(saved.check_state, 'passed');
    assert.equal(saved.execution_state, 'not_submitted');
  }
  details.drafts = [old, replacement];
  details.platformSubmissions = Number(execFileSync('python3', ['-I', '-c',
    'import sqlite3,sys; d=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); print(d.execute("SELECT COUNT(*) FROM submissions").fetchone()[0])',
    h.directory + '/platform/submissions.sqlite'], {encoding: 'utf8'}).trim());
  assert.equal(details.platformSubmissions, 0);
  details.lastRequest = providerCalls;
  evidence.checks.push('合成宽查首批遗漏正式定义，窄查和文档身份查明贡献根，按范围逐字补读并保存两版草稿，平台零提交');
}

try {
  if (scenario === 'source-selection') {
    ok(await h.request('/knowledge-index/rebuilds', {operation_id: randomUUID()}));
    await h.resumeWorker();
    await until(() => h.sql(`SELECT JSON_OBJECT('state',state) FROM knowledge_index_jobs
      WHERE target_kind='knowledge_entry' AND object_id IN ('field-source-selection-0','field-source-selection-1')
        AND version=1`).filter(row => row.state === 'indexed').length === 2
      && h.sql(`SELECT JSON_OBJECT('state',state,'vector_state',vector_state) FROM knowledge_index_jobs
        WHERE target_kind='source_excerpt' AND object_id=${quote(precise.source)} AND version=1`)
        .some(row => row.state === 'indexed' && row.vector_state === 'indexed'),
    '正式导入的两个字段完成异步词法索引', 120000);
    await h.pauseWorker();
    await start([{kind: 'platform', id: precise.source}], '只精读合成甲乙字段的原文含义与例外，不读取其他字段或结构。');
    const identity = await invoke('search_knowledge', {view: 'source_identity',
      query: 'field-source-selection-0 field-source-selection-1', kinds: ['field']});
    const targets = identity.hits.filter(hit => precise.objects.some(object => hit.object_id === object.id));
    assert.equal(targets.length, 2, '精确选择输入必须来自正式身份回执');
    assert.ok(targets.every(hit => hit.source_keys.some(source => source.id === precise.source)
      && hit.source_keys.some(source => source.id === 'schema')), '字段整对象贡献根同时含获准原文和未准DDL');
    const args = {query: 'syntheticprecisefirst syntheticprecisesecond', limit: 10};
    const baseline = await invoke('search_knowledge', args);
    evidence.source_selection = {identity, baseline, fixture: precise};
    assert.ok(!baseline.hits.some(hit => hit.definition?.includes(precise.first)
      || hit.definition?.includes(precise.second)), '整对象知识门不能因定位原文而放宽');
    assert.ok(baseline.hits.some(hit => hit.record_kind === 'source_excerpt'
      && hit.text.includes(precise.first) && hit.text.includes(precise.unrelated)),
    '旧正式搜索实际命中的是含无关字段的广raw块，不能把预置偏移当成精确可达');
    const selectedIdsOnly = await invoke('search_knowledge', {query: targets.map(hit => hit.object_id).join(' '), limit: 10,
      hints: {related_object_ids: targets.map(hit => hit.object_id)}});
    evidence.source_selection.ids_only = selectedIdsOnly;
    assert.ok(!selectedIdsOnly.hits.some(hit => hit.text === precise.first || hit.text === precise.second),
      '已返回ID加软提示没有稳定窄原文选择语义');
    const selection = targets.map(hit => ({object_id: hit.object_id, version: hit.object_version}));
    const searchSdkId = randomUUID();
    const search = await invoke('search_knowledge', {...args, source_selection: selection}, undefined, undefined, searchSdkId);
    const replay = await invoke('search_knowledge', {...args, source_selection: selection}, undefined,
      {max_bytes: 0, estimated_tokens: 0, projection_fingerprint: '0'.repeat(64)}, searchSdkId);
    assert.deepEqual(replay, search, '已登记成功回执按原身份接回，不因新容量重新执行业务或改写citation');
    assert.equal(search.hits.length, 2, '精确选择必须取得两个正式字段的原文，不能空集通过');
    for (const text of [precise.first, precise.second]) {
      const hit = search.hits.find(hit => hit.text === text);
      assert.ok(hit, '第一份搜索正文须只交目标含义和例外');
      assert.equal(hit.record_kind, 'source_excerpt');
      assert.deepEqual(hit.citation.source, {kind: 'platform', id: precise.source});
      assert.equal(hit.citation.revision, '1');
      assert.equal(hit.support_state, 'unknown');
      assert.equal(hit.source_length, [...precise.body].length);
      const read = await invoke('read_source', {citation: hit.citation});
      assert.equal(read.text, text, 'read_source直接使用产品返回的citation，不预填offset或quote');
      assert.deepEqual(read.locator, hit.citation.locator);
      assert.equal(read.next_locator, null);
    }
    assert.equal(JSON.stringify(search).includes(precise.unrelated), false);
    assertExactCoverage(search, 'searched', '两个获准定义均定位，范围排除的DDL不降低覆盖');
    evidence.checks.push('正式保存/索引与身份选择到精确SourceCitation及原生read_source可达，保留DDL来源拒绝');
    for (const structure_only of [false, true]) {
      const denied = await invoke('read_knowledge', {items: [{kind: 'knowledge',
        ref: {...selection[0], path: 'meaning'}, structure_only}]});
      assert.equal(denied.items[0].state, 'not_available');
      assert.equal(denied.items[0].content, undefined, '精确原文定位不能解锁字段定义或DDL结构');
    }
    const repeatedIdentity = await invoke('search_knowledge', {view: 'source_identity', query: 'field-source-selection-2', kinds: ['field']});
    const repeated = repeatedIdentity.hits.find(hit => hit.object_id === 'field-source-selection-2');
    assert.ok(repeated);
    const ambiguous = await invoke('search_knowledge', {...args, source_selection: [
      {object_id: repeated.object_id, version: repeated.object_version}, selection[1]]});
    assert.deepEqual(ambiguous.hits.map(hit => hit.text), [precise.second]);
    assertExactCoverage(ambiguous, 'bounded', '重复quote不能猜首处或冒称已完整定位');
    const caseIdentity = await invoke('search_knowledge', {view: 'source_identity', query: 'field-source-selection-3', kinds: ['field']});
    const caseTarget = caseIdentity.hits.find(hit => hit.object_id === 'field-source-selection-3');
    const sensitive = await invoke('search_knowledge', {...args, source_selection: [
      {object_id: caseTarget.object_id, version: caseTarget.object_version}, selection[1]]});
    assert.deepEqual(sensitive.hits.map(hit => hit.text), [precise.caseSensitive, precise.second],
      '大小写和组合/预组Unicode不同的相邻原文不能按ai_ci合并或误判成重复quote');
    const staleObject = await invoke('search_knowledge', {...args, source_selection: [
      {...selection[0], version: '999'}, selection[1]]});
    assert.deepEqual(staleObject.hits.map(hit => hit.text), [precise.second]);
    assertExactCoverage(staleObject, 'bounded', '对象换版保留同批有效项及覆盖缺口');
    const cursorArgs = {...args, limit: 1, source_selection: selection};
    const firstPage = await invoke('search_knowledge', cursorArgs);
    assert.equal(firstPage.hits.length, 1); assert.ok(firstPage.search_coverage.next);
    await invoke('search_knowledge', {...cursorArgs, source_selection: [selection[1]],
      cursor: firstPage.search_coverage.next}, 'invalid_cursor');
    const lastPage = await invoke('search_knowledge', {...cursorArgs, cursor: firstPage.search_coverage.next});
    assert.equal(lastPage.hits.length, 1); assert.equal(lastPage.search_coverage.next, null);
    assert.deepEqual([...firstPage.hits, ...lastPage.hits].map(hit => hit.text), [precise.first, precise.second]);
    const budget = {max_bytes: Buffer.byteLength(JSON.stringify(search)) - 1,
      estimated_tokens: 2000000, projection_fingerprint: '0'.repeat(64)};
    const bounded = await invoke('search_knowledge', {...args, source_selection: selection}, undefined, budget);
    assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= budget.max_bytes);
    assert.ok(bounded.hits.length > 0); assert.equal(JSON.stringify(bounded).includes(precise.unrelated), false);
    const selectedCitation = search.hits.find(hit => hit.text === precise.first).citation;
    const page = await invoke('read_source', {citation: selectedCitation, limit: [...precise.first].length - 2});
    assert.equal(page.content_state, 'partial');
    const tail = await invoke('read_source', {citation: {...selectedCitation, locator: page.next_locator}});
    assert.equal(tail.text, '🧪。'); assert.equal(page.text + tail.text, precise.first);
    await invoke('read_source', {citation: {...selectedCitation, revision: '999'}}, 'stale_source');
    evidence.checks.push('派生定义/结构仍拒绝，重复quote和旧对象不拖累合法并行项，selector游标绑定及容量/Unicode补读通过');
    const maintenanceRead = await h.request('/knowledge/' + selection[0].object_id);
    if (maintenanceRead.status !== 200) evidence.source_selection.maintenance_read_failure = {
      response: maintenanceRead, stored: h.sql(`SELECT body FROM knowledge_objects WHERE id=${quote(selection[0].object_id)}`)[0]};
    const currentObject = ok(maintenanceRead);
    const revisedObject = ok(await h.request('/knowledge/' + selection[0].object_id, {operation_id: randomUUID(),
      expected_version: currentObject.version, entry_id: 'meaning', value: precise.first,
      structured_value: currentObject.entries.find(entry => entry.path === 'meaning').effective_structure}, 'alice', 'PATCH'));
    const revisedIdentity = await invoke('search_knowledge', {view: 'source_identity', query: selection[0].object_id, kinds: ['field']});
    const revisedTarget = revisedIdentity.hits.find(hit => hit.object_id === selection[0].object_id);
    assert.equal(revisedTarget.object_version, revisedObject.version); assert.notEqual(revisedTarget.object_version, '1');
    const sourceRevision = await invoke('search_knowledge', {...args, source_selection: [
      {object_id: revisedTarget.object_id, version: revisedTarget.object_version}]});
    assert.equal(sourceRevision.hits[0].citation.revision, '1', '对象修订不能被误用为实际来源修订');
    assert.equal(sourceRevision.hits[0].text, precise.first);
    evidence.checks.push('正式对象升版后按身份回执选择，citation仍绑定真实来源修订');
    h.releaseRun(run.run_id);
    await start([{kind: 'platform', id: 'business-guide'}], '只允许另一份资料，不能读取合成精确来源。');
    const outside = await invoke('search_knowledge', {...args, source_selection: selection});
    assert.deepEqual(outside.hits, []);
    assertExactCoverage(outside, 'bounded', '全越权仍有定位缺口');
    assert.ok(!JSON.stringify(outside).includes(precise.source), '精读回执不得暴露未获准的来源');
    await invoke('read_source', {citation: selectedCitation}, 'source_not_allowed');
    const legalIdentity = await invoke('search_knowledge', {view: 'source_identity', query: 'field-paid_amount_cents', kinds: ['field']});
    const legal = legalIdentity.hits.find(hit => hit.object_id === 'field-paid_amount_cents');
    precise.legalSelection = {object_id: legal.object_id, version: legal.object_version};
    const parallel = await invoke('search_knowledge', {...args, source_selection: [selection[1], precise.legalSelection]});
    assert.ok(parallel.hits.some(hit => hit.citation.source.id === 'business-guide' && hit.text.includes('paid_amount_cents')));
    assert.ok(parallel.hits.every(hit => hit.citation.source.id !== precise.source), '越界选择不能整批自拒合法并行来源');
    assert.ok(!JSON.stringify(parallel).includes(precise.source));
    assertExactCoverage(parallel, 'bounded', '同批合法项可交付，越权选中项仍有覆盖缺口');
    evidence.checks.push('精确对象选择不扩大来源许可，原生补读同样拒绝范围外来源，保留另一许可源并行命中');
    h.releaseRun(run.run_id);
  }
  const upstream = 'synthetic-source-search-upstream';
  const needle = 'syntheticsourcesearchadmission';
  const body = needle + '：合成复核完成后才可计入有效设备数。';
  const documentBody = scenario === 'source-selection'
    ? precise.prefix + body + '\n' + precise.unrelated + '\n' + body.toUpperCase() : body;
  const document = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'document',
    name: '合成同步文档', body: documentBody, related_ids: []}));
  // 在本次隔离库构造同步文档的旧格式形状；上游是版本依赖，当前读取身份仍是文档。
  const saved = h.sql(`SELECT body FROM knowledge_objects WHERE id=${quote(document.id)}`)[0];
  saved.source_id = upstream;
  saved.source_version = '1';
  saved.entries[0] = {...saved.entries[0], effective_value: documentBody, suggestion: {}, human_override: null,
    source_facts: {source_id: upstream, version: '1', value: documentBody, complete: true, location: 'body', quote: documentBody}};
  const serialized = quote(JSON.stringify(saved));
  h.sql(`INSERT INTO source_heads(id,space_id,version,fingerprint) VALUES(${quote(upstream)},'demo',1,'synthetic');
    INSERT INTO source_snapshots(source_id,version,body,complete) VALUES(${quote(upstream)},1,${quote(documentBody)},TRUE);
    UPDATE knowledge_objects SET source_id=${quote(upstream)},source_version=1,body=${serialized} WHERE id=${quote(document.id)};
    UPDATE knowledge_versions SET body=${serialized} WHERE object_id=${quote(document.id)} AND version=1;
    DELETE FROM knowledge_dependencies WHERE owner_id=${quote(document.id)};
    INSERT INTO knowledge_dependencies(owner_id,owner_version,space_id,entry_path,layer,purpose,role,effective,target_kind,target_id,target_revision,target_path,target_fingerprint)
    VALUES(${quote(document.id)},1,'demo','body','source_fact','required','origin',1,'platform',${quote(upstream)},1,'','');`);
  evidence.fixture = {document: {id: document.id, version: document.version}, upstream,
    dependencies: h.sql(`SELECT JSON_OBJECT('path',entry_path,'kind',target_kind,'id',target_id,'version',target_revision)
      FROM knowledge_dependencies WHERE owner_id=${quote(document.id)}`)};
  const allowed = [{kind: 'document', id: document.id}];
  evidence.allowed_sources = allowed;
  const citation = {source: allowed[0], revision: document.version, locator: {offset: 0, length: [...body].length}};
  if (scenario === 'source-selection') {
    let nested = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'term',
      name: '合成文档来源定位条目', body, related_ids: []}));
    // 仅模拟既有source_facts文档引用的迁移形状，随后经正式PATCH保存并登记依赖。
    const legacy = h.sql(`SELECT body FROM knowledge_objects WHERE id=${quote(nested.id)}`)[0];
    legacy.entries[0].source_facts = {source_id: 'document-' + document.id, version: document.version,
      quote: body, value: body, complete: true, location: '正文'};
    h.sql(`UPDATE knowledge_objects SET body=${quote(JSON.stringify(legacy))} WHERE id=${quote(nested.id)}`);
    nested = ok(await h.request('/knowledge/' + nested.id, {operation_id: randomUUID(),
      expected_version: nested.version, entry_id: 'body', value: body}, 'alice', 'PATCH'));
    const nestedIdentityArgs = {view: 'source_identity', query: nested.id, kinds: ['term']};
    await start([...allowed, {kind: 'platform', id: precise.source}], '精确读取指定文档原文，同时保留合法并行资料。');
    const nestedIdentity = await invoke('search_knowledge', nestedIdentityArgs);
    const nestedTarget = nestedIdentity.hits.find(hit => hit.object_id === nested.id);
    const nestedSelection = {object_id: nestedTarget.object_id, version: nestedTarget.object_version};
    const nestedSearch = await invoke('search_knowledge', {query: needle, source_selection: [nestedSelection]});
    assert.equal(nestedSearch.hits.length, 1); assert.equal(nestedSearch.hits[0].text, body);
    assert.deepEqual(nestedSearch.hits[0].citation.source, allowed[0]);
    const documentRead = await invoke('read_source', {citation: nestedSearch.hits[0].citation});
    assert.equal(documentRead.text, body);
    assert.equal(documentRead.locator.offset, [...precise.prefix].length);
    assert.equal(documentRead.source_length, [...documentBody].length);
    assert.ok(!JSON.stringify(nestedSearch).includes('UNRELATED_SOURCE_SELECTION_FIELD'));
    const container = execFileSync('docker', ['--context', 'colima-data-agent', 'ps',
      '--filter', 'label=com.docker.compose.project=data-agent', '--filter', 'label=com.docker.compose.service=mysql',
      '--format', '{{.ID}}'], {encoding: 'utf8'}).trim();
    const explain = query => JSON.parse(execFileSync('docker', ['--context', 'colima-data-agent', 'exec', '-i',
      container, 'mysql', '--defaults-extra-file=/run/secrets/mysql_root_client', '--batch', '--raw',
      '--default-character-set=utf8mb4', '--skip-column-names'], {encoding: 'utf8',
      input: 'USE ' + new URL(h.env.DATA_AGENT_DATABASE_URL).pathname.slice(1) + ';EXPLAIN FORMAT=JSON ' + query}));
    const platformPlan = `WITH source AS (SELECT body,complete FROM source_current WHERE source_id=${quote(precise.source)} AND space_id='demo' AND revision=1
      UNION ALL SELECT body,complete FROM source_snapshots WHERE source_id=${quote(precise.source)} AND version=1
      AND NOT EXISTS(SELECT 1 FROM source_current WHERE source_id=${quote(precise.source)} AND space_id='demo' AND revision=1)),
      located AS (SELECT body,complete,LOCATE(CAST(${quote(precise.first)} AS BINARY),CAST(body AS BINARY)) AS p FROM source)
      SELECT CHAR_LENGTH(CONVERT(LEFT(CAST(body AS BINARY),p-1) USING utf8mb4)) FROM located
      WHERE complete=TRUE AND p>0 AND LOCATE(CAST(${quote(precise.first)} AS BINARY),CAST(body AS BINARY),p+1)=0`;
    const documentPlan = `WITH parts AS (SELECT j.n,JSON_UNQUOTE(j.v) AS text FROM knowledge_objects o,
      JSON_TABLE(o.body,'$.entries[*]' COLUMNS(n FOR ORDINALITY,v JSON PATH '$.effective_value')) j
      WHERE o.id=${quote(document.id)} AND o.space_id='demo' AND o.version=1 AND o.kind='document' AND o.state='enabled' AND JSON_TYPE(j.v)='STRING'),
      assembled AS (SELECT GROUP_CONCAT(text ORDER BY n SEPARATOR '\\n\\n') AS body,SUM(OCTET_LENGTH(text))+2*GREATEST(COUNT(*)-1,0) AS expected_bytes FROM parts),
      located AS (SELECT body,expected_bytes,LOCATE(CAST(${quote(body)} AS BINARY),CAST(body AS BINARY)) AS p FROM assembled)
      SELECT /*+ SET_VAR(group_concat_max_len=16777216) */ CHAR_LENGTH(CONVERT(LEFT(CAST(body AS BINARY),p-1) USING utf8mb4)) FROM located
      WHERE p>0 AND OCTET_LENGTH(body)=expected_bytes AND LOCATE(CAST(${quote(body)} AS BINARY),CAST(body AS BINARY),p+1)=0`;
    evidence.mysql = {version: h.sql("SELECT JSON_OBJECT('version',VERSION(),'charset',@@character_set_database)")[0],
      platform: {query: platformPlan, plan: explain(platformPlan)}, document: {query: documentPlan, plan: explain(documentPlan)}};
    h.releaseRun(run.run_id);
    const repeatedDocument = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'document',
      name: '合成重复引文文档', body: body + '\n' + body, related_ids: []}));
    let repeatedTerm = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'term',
      name: '合成重复文档定位条目', body, related_ids: []}));
    const repeatedLegacy = h.sql(`SELECT body FROM knowledge_objects WHERE id=${quote(repeatedTerm.id)}`)[0];
    repeatedLegacy.entries[0].source_facts = {source_id: 'document-' + repeatedDocument.id,
      version: repeatedDocument.version, quote: body, value: body, complete: true, location: '正文'};
    h.sql(`UPDATE knowledge_objects SET body=${quote(JSON.stringify(repeatedLegacy))} WHERE id=${quote(repeatedTerm.id)}`);
    repeatedTerm = ok(await h.request('/knowledge/' + repeatedTerm.id, {operation_id: randomUUID(),
      expected_version: repeatedTerm.version, entry_id: 'body', value: body}, 'alice', 'PATCH'));
    await start([{kind: 'document', id: repeatedDocument.id}, {kind: 'platform', id: precise.source}], '重复文档引文不能猜位置，保留其他合法来源。');
    const repeatedTermIdentity = await invoke('search_knowledge', {view: 'source_identity', query: repeatedTerm.id, kinds: ['term']});
    const repeatedTermTarget = repeatedTermIdentity.hits.find(hit => hit.object_id === repeatedTerm.id);
    const repeatedDocumentSearch = await invoke('search_knowledge', {query: needle, source_selection: [
      {object_id: repeatedTermTarget.object_id, version: repeatedTermTarget.object_version},
      {object_id: 'field-source-selection-1', version: '1'}]});
    assert.deepEqual(repeatedDocumentSearch.hits.map(hit => hit.text), [precise.second]);
    assert.equal(repeatedDocumentSearch.search_coverage.state, 'bounded');
    h.releaseRun(run.run_id);
    h.sql(`UPDATE source_heads SET version=2 WHERE id=${quote(upstream)};
      INSERT INTO source_snapshots(source_id,version,body,complete) VALUES(${quote(upstream)},2,'合成已变化的整对象依赖。',TRUE);`);
    await start([...allowed, {kind: 'platform', id: precise.source}], '文档整对象上游已换版，仍须保留其他合法来源。');
    const staleDocument = await invoke('search_knowledge', {query: needle, source_selection: [nestedSelection,
      {object_id: 'field-source-selection-1', version: '1'}]});
    assert.deepEqual(staleDocument.hits.map(hit => hit.text), [precise.second]);
    assert.equal(staleDocument.search_coverage.state, 'bounded');
    await invoke('read_source', {citation: nestedSearch.hits[0].citation}, 'stale_knowledge');
    h.releaseRun(run.run_id);
    h.sql(`UPDATE source_current SET complete=FALSE WHERE source_id=${quote(precise.source)} AND revision=1;
      UPDATE source_snapshots SET complete=FALSE WHERE source_id=${quote(precise.source)} AND version=1;`);
    await start([{kind: 'platform', id: precise.source}, {kind: 'platform', id: 'business-guide'}], '不完整原文不可交付，其他许可来源仍可读。');
    const incomplete = await invoke('search_knowledge', {query: needle, source_selection: [
      {object_id: 'field-source-selection-1', version: '1'}, precise.legalSelection]});
    assert.ok(incomplete.hits.length > 0); assert.ok(incomplete.hits.every(hit => hit.citation.source.id === 'business-guide'));
    assertExactCoverage(incomplete, 'bounded', '缺必要完整原文时保留同批有效项及覆盖缺口');
    h.releaseRun(run.run_id);
    h.sql(`UPDATE source_current SET complete=TRUE WHERE source_id=${quote(precise.source)} AND revision=1;
      UPDATE source_snapshots SET complete=TRUE WHERE source_id=${quote(precise.source)} AND version=1;
      UPDATE source_heads SET version=2 WHERE id=${quote(precise.source)};
      INSERT INTO source_snapshots(source_id,version,body,complete) VALUES(${quote(precise.source)},2,'合成新修订原文。',TRUE);`);
    await start([{kind: 'platform', id: precise.source}, {kind: 'platform', id: 'business-guide'}], '旧来源修订不能在新原文上套定位。');
    const oldSource = await invoke('search_knowledge', {query: needle, source_selection: [
      {object_id: 'field-source-selection-1', version: '1'}, precise.legalSelection]});
    assert.ok(oldSource.hits.length > 0); assert.ok(oldSource.hits.every(hit => hit.citation.source.id === 'business-guide'));
    assertExactCoverage(oldSource, 'bounded', '旧来源修订保留同批有效项及覆盖缺口');
    h.releaseRun(run.run_id);
    h.sql(`UPDATE source_heads SET version=1 WHERE id=${quote(precise.source)}`);
    evidence.checks.push('document精确定位及原生补读、整对象上游换版拒绝、不完整/旧来源不拖累合法并行项');
    await h.resumeWorker();
    run = await h.capture(await h.create(), '只依据 synthetic-precise-source，精读 field-source-selection-0 和 field-source-selection-1 的原文定义及例外，不读其他字段，不执行查询。');
    await h.pauseWorker();
    await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, '');
    h.releaseRun(run.run_id);
    assert.deepEqual(providerErrors, []); assert.equal(providerCalls, 5);
    evidence.provider = {calls: providerCalls, errors: providerErrors,
      receipts: h.sql(`SELECT JSON_OBJECT('sdk_tool_call_id',sdk_tool_call_id,'receipt',receipt) FROM tool_calls
        WHERE conversation_id=${quote(run.conversation_id)} AND sdk_tool_call_id LIKE 'selection-%' ORDER BY sdk_tool_call_id`)};
    evidence.checks.push('真实Pi身份→受限任务→source_selection→原生并行read_source，全部五次本地provider请求均无无关字段');
    await checkSettlementContinuation();
  }
  if (scenario === 'all' || scenario === 'platform-roots') {
    const platformOnly = [{kind: 'platform', id: upstream}];
    evidence.platform_roots_allowed_sources = platformOnly;
    await start(platformOnly, '只依据合成平台来源贡献的知识窗口核对，不读取独立文档原文。');
    await invoke('read_source', {citation}, 'source_not_allowed');
    const search = await invoke('search_knowledge', {query: needle, limit: 10});
    assert.ok(search.hits.some(hit => hit.record_kind === 'knowledge_entry'
      && hit.ref.object_id === document.id && hit.definition.includes(body)),
    '完整贡献根已获准时必须交付知识窗口，不能另要求document许可或只返回空集');
    const authority = h.sql(`SELECT authority_snapshot FROM agent_runs WHERE id=${quote(run.run_id)}`)[0];
    assert.ok(!authority.sources.some(pair => pair[0] === 'document-' + document.id));
    assert.ok(authority.knowledge_entries.some(reference => reference[0] === document.id && reference[2] === 'body'));
    evidence.platform_roots_authority = authority;
    evidence.checks.push('仅platform贡献根许可可搜索知识窗口，document原文仍拒绝，不互授权');
    h.releaseRun(run.run_id);
  }
  if (scenario === 'all' || scenario === 'explicit-dependencies') {
    for (const dependencyKind of ['citation', 'support']) {
      const marker = 'syntheticexternal' + dependencyKind;
      const text = marker + '：合成规则必须保留明确的外部依据。';
      // 整理陈述与原文不同，正控必须取得指定陈述，不能用原文替代。
      const rawBody = '合成原始背景，整理陈述另行保存。';
      const cited = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'document',
        name: '合成显式外部依据' + dependencyKind, body: rawBody, related_ids: []}));
      const content = h.sql(`SELECT body FROM knowledge_objects WHERE id=${quote(cited.id)}`)[0];
      const statement = {statement_id: 'synthetic-external-' + dependencyKind, text, scope_text: '',
        citations: dependencyKind === 'citation' ? [{...citation, source: {kind: 'platform', id: upstream}}] : [],
        supports_complete: true, supports: dependencyKind === 'support' ? [{support_id: 'synthetic-outside-support',
          role: 'prerequisite', reference: {kind: 'source', citation: {...citation, source: {kind: 'platform', id: upstream}}},
          content: body, embedded_in: null}] : []};
      content.entries[0] = {...content.entries[0], effective_value: rawBody, human_override: null,
        suggestion: {statements: [statement]}};
      h.sql(`UPDATE knowledge_objects SET body=${quote(JSON.stringify(content))} WHERE id=${quote(cited.id)};
        UPDATE knowledge_versions SET body=${quote(JSON.stringify(content))} WHERE object_id=${quote(cited.id)} AND version=1;
        INSERT INTO knowledge_statements(object_id,version,statement_id,space_id,entry_path,layer,body)
          VALUES(${quote(cited.id)},1,${quote(statement.statement_id)},'demo','body','model_suggestion',${quote(JSON.stringify(statement))});`);
      const read = {items: [{kind: 'knowledge', ref: {object_id: cited.id, version: cited.version, path: 'body'},
        statement_id: statement.statement_id}]};
      await start([{kind: 'document', id: cited.id}], '只准合成文档自身，不授权其显式外部' + dependencyKind + '。');
      if (dependencyKind === 'citation') {
        await invoke('read_knowledge', read, 'source_not_allowed');
      } else {
        const rejected = await invoke('read_knowledge', read);
        assert.equal(rejected.items[0].state, 'not_available');
        assert.equal(rejected.items[0].content, undefined, '支持越界时不能交付主陈述正文');
        assert.equal(rejected.items[0].supports, undefined, '支持越界时不能交付支持正文');
      }
      evidence.checks.push('document直许不放行显式范围外' + dependencyKind);
      h.releaseRun(run.run_id);
      await start([{kind: 'document', id: cited.id}, {kind: 'platform', id: upstream}], '文档和明确引用来源均获准，定点读取同一条整理陈述。');
      const readable = (await invoke('read_knowledge', read)).items[0];
      assert.equal(readable.state, 'ok');
      assert.equal(readable.content, text, '双许可正控必须取得指定陈述，不能把空回执当拒绝证明');
      if (dependencyKind === 'citation') assert.ok(readable.citations.some(value => value.source.id === upstream));
      else assert.ok(readable.supports.some(value => value.reference.citation.source.id === upstream && value.content === body));
      evidence.checks.push(dependencyKind + '来源获准后同一陈述及实际引用可读');
      h.releaseRun(run.run_id);
    }
  }
  if (scenario === 'all' || scenario === 'formal-statement-search') {
    for (const dependencyKind of ['citation', 'support']) {
      const marker = 'syntheticformal' + dependencyKind;
      const text = marker + '：合成陈述须保留明确的复核依据。';
      const premise = '合成前提：完成双人核验后才可采用该结论。';
      const source = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'document',
        name: '合成正式陈述依据' + dependencyKind, body: premise, related_ids: []}));
      const sourceCitation = {source: {kind: 'document', id: source.id}, revision: source.version,
        locator: {offset: 0, length: [...premise].length}};
      let derived = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'term',
        name: '合成正式陈述' + dependencyKind, body: '独立初始化正文，不含目标检索词。', related_ids: []}));
      derived = ok(await h.request('/knowledge/' + derived.id, {operation_id: randomUUID(),
        expected_version: derived.version, entry_id: 'body', value: text,
        statements: [{key: 'source-admission-' + dependencyKind,
          target: {object_id: derived.id, version: derived.version, path: 'body'},
          text, scope_text: '', citations: dependencyKind === 'citation' ? [sourceCitation] : [],
          supports_complete: true, supports: dependencyKind === 'support' ? [{key: 'required-review',
            role: 'prerequisite', reference: {kind: 'source', citation: sourceCitation}, content: premise,
            embedded_in: null}] : []}]}, 'alice', 'PATCH'));
      const statement = derived.entries[0].human_override.statements[0];
      const siblingText = marker + '：另一条已获准的独立资料。';
      const sibling = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'document',
        name: '合成并行合法命中' + dependencyKind, body: siblingText, related_ids: []}));
      await h.resumeWorker();
      await until(() => h.sql(`SELECT JSON_OBJECT('state',state) FROM knowledge_index_jobs
        WHERE target_kind='knowledge_entry' AND object_id IN (${quote(derived.id)},${quote(sibling.id)})
          AND version=IF(object_id=${quote(derived.id)},${quote(derived.version)},${quote(sibling.version)})`).filter(row => row.state === 'indexed').length === 2,
      '正式保存陈述及合法并行候选完成词法索引', 120000);
      await h.pauseWorker();
      evidence.formal_statements ??= [];
      evidence.formal_statements.push({dependencyKind, object_id: derived.id, version: derived.version,
        statement_id: statement.statement_id, text, source: sourceCitation,
        index: h.sql(`SELECT JSON_OBJECT('target_kind',target_kind,'id',object_id,'version',version,'state',state,'vector_state',vector_state)
          FROM knowledge_index_jobs WHERE object_id IN (${quote(derived.id)},${quote(sibling.id)})`)});
      const onlySibling = [{kind: 'document', id: sibling.id}];
      await start(onlySibling, '只允许并行合法资料，不允许该整理陈述的外部依据。');
      const rejected = await invoke('search_knowledge', {query: marker, kinds: ['term', 'document'], limit: 10});
      assert.ok(!rejected.hits.some(hit => hit.statement_id === statement.statement_id
        || hit.definition?.includes(text)), '缺必要' + dependencyKind + '来源时搜索不得交付陈述正文');
      assert.ok(rejected.hits.some(hit => hit.ref?.object_id === sibling.id && hit.definition.includes(siblingText)),
        '越界候选不得使并行合法内容整批自拒绝');
      h.releaseRun(run.run_id);
      await start([...onlySibling, {kind: 'document', id: source.id}], '全部必要来源均允许，检索正式保存并索引的同一陈述。');
      const accepted = await invoke('search_knowledge', {query: marker, kinds: ['term', 'document'], limit: 10});
      const hit = accepted.hits.find(hit => hit.statement_id === statement.statement_id);
      assert.ok(hit, '搜索正控必须命中正式保存的同一statement_id，不能用空集或原文替代');
      assert.equal(hit.ref.object_id, derived.id);
      assert.equal(hit.ref.version, derived.version);
      assert.equal(hit.definition, text);
      if (dependencyKind === 'citation') assert.deepEqual(hit.citations, [sourceCitation]);
      else assert.ok(hit.supports.some(support => support.reference.citation.source.id === source.id
        && support.content === premise));
      const read = (await invoke('read_knowledge', {items: [{kind: 'knowledge', ref: hit.ref,
        statement_id: hit.statement_id}]})).items[0];
      assert.equal(read.state, 'ok'); assert.equal(read.content, text);
      evidence.checks.push('正式保存/索引的' + dependencyKind + '陈述搜索正控与同ID补读、来源缺失负控及并行合法命中通过');
      h.releaseRun(run.run_id);
    }
  }
  if (scenario === 'all' || scenario === 'incomplete-upstream') {
    const completenessAllowed = [...allowed, {kind: 'platform', id: upstream}];
    evidence.completeness_allowed_sources = completenessAllowed;
    h.sql(`UPDATE source_snapshots SET complete=FALSE WHERE source_id=${quote(upstream)} AND version=1;
      UPDATE source_current SET complete=FALSE WHERE source_id=${quote(upstream)} AND revision=1;`);
    evidence.incomplete_source_state = h.sql(`SELECT JSON_OBJECT('head_version',h.version,'revision',s.version,'complete',s.complete)
      FROM source_heads h JOIN source_snapshots s ON s.source_id=h.id AND s.version=h.version WHERE h.id=${quote(upstream)}`)[0];
    assert.equal(evidence.incomplete_source_state.head_version, 1);
    assert.equal(Boolean(evidence.incomplete_source_state.complete), false);
    await start(completenessAllowed, '文档和上游均获准，但同修订上游不完整时不得交付正文。');
    await invoke('search_knowledge', {query: needle, limit: 10}, 'stale_knowledge');
    evidence.checks.push('同修订上游complete=false仍拒绝文档知识正文，不以版本头匹配代替完整性');
    h.releaseRun(run.run_id);
    // Worker会把legacy快照落到current，恢复时须同时恢复真正优先读取的当前记录。
    h.sql(`UPDATE source_snapshots SET complete=TRUE WHERE source_id=${quote(upstream)} AND version=1;
      UPDATE source_current SET complete=TRUE WHERE source_id=${quote(upstream)} AND revision=1;`);
    evidence.recovered_source_state = h.sql(`SELECT JSON_OBJECT('store','snapshot','revision',version,'complete',complete)
      FROM source_snapshots WHERE source_id=${quote(upstream)} AND version=1;
      SELECT JSON_OBJECT('store','current','revision',revision,'complete',complete)
      FROM source_current WHERE source_id=${quote(upstream)}`);
    assert.ok(evidence.recovered_source_state.every(state => state.revision === 1 && Boolean(state.complete)));
    await start(completenessAllowed, '上游完整性恢复后重新读取同一获准文档。');
    const recovered = await invoke('search_knowledge', {query: needle, limit: 10});
    assert.ok(recovered.hits.some(hit => hit.ref?.object_id === document.id && hit.definition.includes(body)));
    evidence.checks.push('完整性恢复后同一文档知识窗口重新可读');
    h.releaseRun(run.run_id);

    // 未选条目的不完整来源不能污染当前body窗口的有效依赖。
    const unused = 'synthetic-unselected-incomplete-source';
    const withOtherEntry = structuredClone(saved);
    withOtherEntry.entries.push({entry_id: 'other', path: 'other', label: '未选附录',
      effective_value: '无关附录正文，不含目标检索词。', suggestion: {}, human_override: null,
      source_facts: {source_id: unused, version: '1', value: '无关附录正文，不含目标检索词。', complete: true}});
    h.sql(`INSERT INTO source_heads(id,space_id,version,fingerprint) VALUES(${quote(unused)},'demo',1,'synthetic');
      INSERT INTO source_snapshots(source_id,version,body,complete) VALUES(${quote(unused)},1,'不完整的未选来源。',FALSE);
      UPDATE knowledge_objects SET body=${quote(JSON.stringify(withOtherEntry))} WHERE id=${quote(document.id)};
      UPDATE knowledge_versions SET body=${quote(JSON.stringify(withOtherEntry))} WHERE object_id=${quote(document.id)} AND version=1;
      INSERT INTO knowledge_dependencies(owner_id,owner_version,space_id,entry_path,layer,purpose,role,effective,target_kind,target_id,target_revision,target_path,target_fingerprint)
        VALUES(${quote(document.id)},1,'demo','other','source_fact','required','origin',1,'platform',${quote(unused)},1,'','');`);
    await start(completenessAllowed, '只读取body窗口，不读取另一个来源尚不完整的附录。');
    const selected = await invoke('search_knowledge', {query: needle, limit: 10});
    assert.ok(selected.hits.some(hit => hit.ref?.object_id === document.id && hit.definition.includes(body)));
    evidence.checks.push('完整性核验按已交付path：未选条目不完整来源不阻断合法body');
    h.releaseRun(run.run_id);
    h.sql(`UPDATE knowledge_objects SET body=${serialized} WHERE id=${quote(document.id)};
      UPDATE knowledge_versions SET body=${serialized} WHERE object_id=${quote(document.id)} AND version=1;
      DELETE FROM knowledge_dependencies WHERE owner_id=${quote(document.id)} AND entry_path='other';`);
  }
  if (scenario === 'all' || scenario === 'document') {
    await start(allowed, '只依据合成同步文档核对有效设备数，不开放其上游平台正文。');
    const direct = await invoke('read_source', {citation});
    assert.equal(direct.text, body);
    assert.deepEqual(direct.source, allowed[0]);
    evidence.checks.push('允许文档的已有正文可用正式SourceKey/修订/locator直接读取');
    await invoke('read_source', {citation: {...citation, source: {kind: 'platform', id: upstream}}}, 'source_not_allowed');
    evidence.checks.push('允许文档不扩大为上游平台来源许可');
    const search = await invoke('search_knowledge', {query: needle, limit: 10});
    const hits = search.hits.filter(hit => hit.record_kind === 'knowledge_entry' && hit.ref.object_id === document.id);
    assert.ok(hits.length > 0, '普通检索必须交付合法文档正文，不能仅返回空集');
    assert.ok(hits.some(hit => hit.definition.includes(body)));
    const authority = h.sql(`SELECT authority_snapshot FROM agent_runs WHERE id=${quote(run.run_id)}`)[0];
    evidence.authority = authority;
    assert.ok(authority.sources.some(pair => pair[0] === 'document-' + document.id && pair[1] === document.version));
    assert.ok(!authority.sources.some(pair => pair[0] === upstream), '当前读取来源不能被解释为上游平台正文许可');
    assert.ok(authority.knowledge_entries.some(reference => reference[0] === document.id && reference[2] === 'body'),
      '文档版本与选中条目仍用于原依赖有效性复核');
    evidence.checks.push('同一合法文档可由普通检索交付；交付authority与直接读取身份一致且保留知识依赖');
    h.releaseRun(run.run_id);

    // 上游换版仍使依赖它的文档失效；身份修正不能放过过期内容。
    h.sql(`UPDATE source_heads SET version=2 WHERE id=${quote(upstream)};
      INSERT INTO source_snapshots(source_id,version,body,complete) VALUES(${quote(upstream)},2,'合成更新后的来源正文。',TRUE);`);
    await start(allowed, '检查上游换版后旧文档不能继续交付。');
    await invoke('read_source', {citation}, 'stale_knowledge');
    const staleSearch = await invoke('search_knowledge', {query: needle, limit: 10});
    assert.ok(!staleSearch.hits.some(hit => hit.ref?.object_id === document.id), '上游换版后的旧正文不得搜索交付');
    evidence.checks.push('上游版本有效性检查保留：直接读取拒绝，检索不交付过期文档');
    h.releaseRun(run.run_id);
  }
  evidence.passed = true;
  console.log(JSON.stringify(evidence));
} finally {
  evidence.storage_at_close = h.sql(`SELECT JSON_OBJECT('store','head','version',version) FROM source_heads WHERE id='synthetic-source-search-upstream';
    SELECT JSON_OBJECT('store','snapshot','version',version,'complete',complete) FROM source_snapshots WHERE source_id='synthetic-source-search-upstream';
    SELECT JSON_OBJECT('store','current','version',revision,'complete',complete) FROM source_current WHERE source_id='synthetic-source-search-upstream';
    SELECT JSON_OBJECT('store','object','id',id,'version',version,'state',state) FROM knowledge_objects WHERE source_id='synthetic-source-search-upstream';
    SELECT JSON_OBJECT('store','dependency','owner',owner_id,'version',owner_version,'path',entry_path,'effective',effective,'target',target_id,'target_revision',target_revision)
      FROM knowledge_dependencies WHERE target_id='synthetic-source-search-upstream';
    SELECT JSON_OBJECT('store','explicit_object','id',id,'version',version,'state',state,
      'statements',JSON_EXTRACT(body,'$.entries[0].suggestion.statements'),'raw',JSON_EXTRACT(body,'$.entries[0].effective_value'))
      FROM knowledge_objects WHERE name LIKE '合成显式外部依据%';
    SELECT JSON_OBJECT('store','explicit_statement','id',object_id,'version',version,'layer',layer,'body',body)
      FROM knowledge_statements WHERE statement_id LIKE 'synthetic-external-%'`);
  await writeFile(h.directory + '/source-search-admission.json', JSON.stringify(evidence, null, 2));
  if (directory) await writeFile(directory + '/source-search-admission.json', JSON.stringify(evidence, null, 2));
  if (sourceDirectory) {
    const capacity = {payload_bytes_limit: payloadBytesLimit,
      peak_payload_bytes: Math.max(0, ...receivedPayloads.map(payload => payload.bytes)), requests: receivedPayloads};
    const providerEvidence = JSON.stringify({calls: providerCalls, errors: providerErrors, requests: providerRequests, capacity}, null, 2);
    await writeFile(h.directory + '/source-selection-provider.json', providerEvidence);
    if (directory) await writeFile(directory + '/source-selection-provider.json', providerEvidence);
    protocolProvider.closeAllConnections(); await new Promise(resolve => protocolProvider.close(resolve));
    if (previousProviderTest === undefined) delete process.env.DATA_AGENT_PROVIDER_TEST;
    else process.env.DATA_AGENT_PROVIDER_TEST = previousProviderTest;
  }
  await h.close();
  if (embedding) {
    const token = (await readFile('.local/infra/milvus-root-password', 'utf8')).trim();
    const dropped = await fetch('http://127.0.0.1:19531/v2/vectordb/collections/drop', {method: 'POST',
      headers: {'content-type': 'application/json', authorization: 'Bearer root:' + token},
      body: JSON.stringify({dbName: 'default', collectionName: collection})});
    assert.equal((await dropped.json()).code, 0);
    await embedding.close();
  }
}

import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {harness} from './harness.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = new URL('../../.local/checks/', import.meta.url);
await mkdir(directory, {recursive: true});
const labelArgument = process.argv.slice(2).find(value => value.startsWith('--label='));
const label = labelArgument?.slice('--label='.length) ?? 'run';
assert.match(label, /^[a-z0-9-]+$/);
const name = `frozen-job-inputs-${label}-${Date.now()}`;
const logFile = new URL(`${name}.log`, directory);
const reportFile = new URL(`${name}.json`, directory);
const filters = process.argv.slice(2).filter(value => value !== labelArgument);
assert.ok(filters.length <= 1 && filters.every(value => /^[a-z0-9_]+$/.test(value)));
const cargoArguments = ['test', '--offline', '--locked', '-p', 'data-agent', '--test',
  'frozen_job_inputs', ...filters, '--', '--test-threads=1', '--nocapture'];

// 只继承隔离库和本地协议配置，不继承真实模型端点或凭据。
for (const name of ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL',
  'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'DATA_AGENT_MODEL_PROFILE', 'DATA_AGENT_MODEL_FAULT',
  'DATA_AGENT_PREFILL_PROFILE', 'DATA_AGENT_PREFILL_URL', 'DATA_AGENT_PREFILL_TEST',
  'DATA_AGENT_PREFILL_TIMEOUT_MS', 'DATA_AGENT_PREFILL_LEASE_SECONDS', 'DATABASE_URL']) delete process.env[name];

let h;
let output = '';
let passed = false;
let exitCode = null;
let signal = null;
let providerFailure;
let restoredDocument;
const requests = [];
const tail = '原文尾部例外：退款拒收不计入。';
const provider = createServer(async (req, res) => {
  try {
    let raw = '';
    req.setEncoding('utf8');
    for await (const chunk of req) raw += chunk;
    const material = JSON.parse(JSON.parse(raw).messages[1].content);
    const legacy = material.object.id === 'frozen-review-legacy-target';
    const documentId = legacy ? 'frozen-review-legacy-document' : 'frozen-review-document';
    const source = material.sources.find(source => source.source_id === 'document-' + documentId);
    assert.ok(source);
    assert.ok(!('frozen_review_sources' in material), '宿主冻结字段不进入模型material');
    assert.ok(!raw.includes('frozen_review_sources'));
    assert.ok(Buffer.byteLength(raw) <= 65536);
    assert.ok(material.sources.reduce((n, source) => n + Buffer.byteLength(source.body) +
      (source.supporting_excerpts ?? []).reduce((sum, part) => sum + Buffer.byteLength(part.body), 0), 0) <= 24576);
    requests.push(material);
    const pair = requests.filter(request => request.object.id === material.object.id);
    let quote;
    if (!material.draft) {
      assert.equal(pair.length, 1);
      assert.ok(source.body.includes('首部规则'));
      assert.ok(!source.body.includes(tail));
      quote = '首部规则：金额以元保存。';
      restoredDocument = h.sql(`SELECT body FROM knowledge_objects WHERE id='${documentId}'`)[0];
      const frozenInput = h.sql(`SELECT input_json FROM prefill_attempts WHERE object_id='${material.object.id}' AND state='issued'`)[0];
      const frozen = frozenInput.frozen_review_sources.find(item => item.source_id === source.source_id);
      assert.ok(frozen, '首次HTTP前必要复核窗口已在原作业持久冻结');
      assert.equal(frozen.total_bytes, Buffer.byteLength(restoredDocument.entries[0].effective_value));
      assert.ok(Buffer.byteLength(frozen.body) <= Buffer.byteLength(source.body) + 24576 + 4);
      if (legacy) assert.ok(Buffer.byteLength(frozen.body) < frozen.total_bytes, '超长来源只冻结必要窗口');
      else assert.ok(restoredDocument.entries[0].effective_value.includes(tail));
      // 仅在本次隔离库移走正文，保持当前头/权限；复核到达后原样恢复供结果依赖登记。
      h.sql(`UPDATE knowledge_objects SET body=JSON_SET(body,'$.entries[0].effective_value','') WHERE id='${documentId}'`);
      h.sql(`DELETE FROM knowledge_versions WHERE object_id='${documentId}'`);
    } else {
      assert.equal(pair.length, 2, '冻结尾部仍只用原分析与复核两次调用');
      const parts = [{...source.body_range, body: source.body}, ...(source.supporting_excerpts ?? [])];
      const newQuote = legacy ? '边界合成🧪é。' : tail;
      assert.ok(parts.some(part => part.body.includes(newQuote)), '复核从冻结输入读到后续原文');
      assert.ok(parts.some(part => part.body.includes('首部规则')), '保留草稿原引文上下文');
      const body = restoredDocument.entries[0].effective_value;
      for (const part of parts) {
        assert.equal(Buffer.from(body).subarray(part.start_byte, part.end_byte).toString('utf8'), part.body);
        assert.equal(part.total_bytes, Buffer.byteLength(body));
      }
      const ranges = material.coverage.source_ranges.find(item => item.source_id === source.source_id);
      assert.equal(ranges.total_bytes, Buffer.byteLength(body));
      if (legacy) {
        assert.ok(ranges.seen_byte_ranges.at(-1).end < Buffer.byteLength(body));
        assert.ok(parts.every(part => !part.body.includes('未读最终例外')));
        assert.ok(material.coverage.gaps.some(gap => gap.source_id === source.source_id && gap.reason === 'body_limit'));
        assert.equal(source.complete, false);
      } else assert.deepEqual(ranges.seen_byte_ranges, [{start: 0, end: Buffer.byteLength(body)}]);
      const literal = "'" + JSON.stringify(restoredDocument).replaceAll('\\', '\\\\').replaceAll("'", "''") + "'";
      h.sql(`UPDATE knowledge_objects SET body=CAST(${literal} AS JSON) WHERE id='${documentId}'`);
      restoredDocument = undefined;
      quote = newQuote;
    }
    const output = {entries: material.object.entries.map(entry => ({entry_id: entry.entry_id,
      value: '合成定义：金额以元保存，退款拒收不计入。', gaps: [],
      evidence: [{source_id: source.source_id, version: source.version, location: '合成原文', quote}]}))};
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({choices: [{finish_reason: 'tool_calls', message: {tool_calls: [{type: 'function',
      function: {name: 'submit_semantic_prefill', arguments: JSON.stringify(output)}}]}}],
      usage: {prompt_tokens: 100, completion_tokens: 20}}));
  } catch (error) {
    providerFailure = error;
    res.writeHead(500); res.end();
  }
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const profile = {provider_id: 'deepseek', model_id: 'deepseek-flash', trial_id: randomUUID(),
  price_version: '2026-10-04-peak-usd', input_limit: 32768, output_limit: 2048,
  trial_call_limit: 12, trial_cost_micros: '5000000', request_call_limit: 12, toolset: 'data', payload_bytes_limit: 65536};
try {
  h = await harness({capture: true, startWorker: false, env: {DATA_AGENT_PREFILL_PROFILE: JSON.stringify(profile),
    DATA_AGENT_PREFILL_TEST: '1', DATA_AGENT_PREFILL_URL: 'http://127.0.0.1:' + provider.address().port}});
  const result = await new Promise((resolve, reject) => {
    const child = spawn(homedir()+'/.cargo/bin/cargo', cargoArguments,
      {cwd: root, env: h.env, stdio: ['ignore', 'pipe', 'pipe']});
    child.stdout.on('data', chunk => {output += chunk; process.stdout.write(chunk);});
    child.stderr.on('data', chunk => {output += chunk; process.stderr.write(chunk);});
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({code, signal}));
  });
  exitCode = result.code;
  signal = result.signal;
  if (providerFailure) throw providerFailure;
  assert.equal(exitCode, 0, '准备/预填冻结输入与终态释放必须完整通过');
  assert.equal(signal, null);
  if (!filters.length) assert.equal(requests.length, 4, '两个冻结场景各分析/复核一次');
  else if (filters[0].startsWith('prefill_')) assert.equal(requests.length, 2, '原分析/复核两次协议调用必须完整到达');
  else assert.equal(requests.length, 0, '已保存成果恢复和终态清理不派发模型调用');
  assert.match(output, /test result: ok\. [1-9]\d* passed; 0 failed/);
  assert.doesNotMatch(output, /running 0 tests/);
  passed = true;
} finally {
  try {
    if (h) await h.close();
  } finally {
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
    await writeFile(logFile, output, {flag: 'wx'});
    const report = {passed, exitCode, signal, officialRequests: 0, localProtocolCalls: requests.length,
      command: ['cargo', ...cargoArguments],
      harnessDirectory: h ? relative(root, h.directory) : null,
      log: relative(root, fileURLToPath(logFile)),
      scope: '公开 preparation/ingestion owner及semantic_prefill用例；真实隔离MySQL与本地模型协议'};
    await writeFile(reportFile, JSON.stringify(report, null, 2)+'\n', {flag: 'wx'});
    console.log(JSON.stringify(report));
  }
}

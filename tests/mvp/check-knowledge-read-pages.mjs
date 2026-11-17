import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
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
const name = `knowledge-read-pages-${label}-${Date.now()}`;
const logFile = new URL(`${name}.log`, directory);
const reportFile = new URL(`${name}.json`, directory);
const filters = process.argv.slice(2).filter(value => value !== labelArgument);
const cargoArguments = ['test', '--offline', '--locked', '-p', 'data-agent', '--test',
  'knowledge_read_pages', ...filters, '--', '--test-threads=1', '--nocapture'];

// 本 runner 只用合成隔离库；harness 和 Cargo 都不继承真实模型或通用数据库配置。
for (const name of ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL',
  'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'DATA_AGENT_MODEL_PROFILE', 'DATA_AGENT_MODEL_FAULT',
  'DATABASE_URL']) delete process.env[name];

let h;
let output = '';
let passed = false;
let exitCode = null;
let signal = null;
try {
  h = await harness({capture: true, startWorker: false});
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
  assert.equal(exitCode, 0, '真实隔离 MySQL 的知识 owner 窄分页必须完整通过');
  assert.equal(signal, null);
  assert.match(output, /test result: ok\. [1-9]\d* passed; 0 failed/);
  assert.doesNotMatch(output, /running 0 tests/);
  passed = true;
} finally {
  try {
    if (h) await h.close();
  } finally {
    await writeFile(logFile, output, {flag: 'wx'});
    const report = {passed, exitCode, signal, officialRequests: 0,
      command: ['cargo', ...cargoArguments],
      harnessDirectory: h ? relative(root, h.directory) : null,
      log: relative(root, fileURLToPath(logFile)),
      scope: '公开 knowledge owner seam；公开 seed/apply_preparation 和依赖登记；合成真实隔离 MySQL'};
    await writeFile(reportFile, JSON.stringify(report, null, 2)+'\n', {flag: 'wx'});
    console.log(JSON.stringify(report));
  }
}

import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {harness} from './harness.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = new URL('../../.local/checks/', import.meta.url);
await mkdir(directory, {recursive: true});
const logFile = new URL('support-completeness.log', directory);
const reportFile = new URL('support-completeness.json', directory);
const checks = [];
let h;
let output = '';
let passed = false;
let exitCode = null;
try {
  h = await harness({capture: true, startWorker: false});
  const env = {...h.env};
  for (const name of ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL',
    'DATA_AGENT_MODEL_PROFILE', 'DATA_AGENT_MODEL_FAULT', 'DATABASE_URL']) delete env[name];
  exitCode = await new Promise((resolve, reject) => {
    const child = spawn(homedir()+'/.cargo/bin/cargo', ['test', '--offline', '--locked',
      '-p', 'data-agent', '--test', 'support_completeness', ...process.argv.slice(2),
      '--', '--test-threads=1', '--nocapture'], {cwd: root, env, stdio: ['ignore', 'pipe', 'pipe']});
    child.stdout.on('data', chunk => {output += chunk; process.stdout.write(chunk);});
    child.stderr.on('data', chunk => {output += chunk; process.stderr.write(chunk);});
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(exitCode, 0, '真实隔离 MySQL 的支持完整性测试必须完整通过');
  assert.match(output, /test result: ok\. [1-9]\d* passed; 0 failed/);
  assert.doesNotMatch(output, /running 0 tests/);
  checks.push('公开 knowledge 保存/读取接口与 owner 定点读取保留明确三态，历史缺省 unknown');
  passed = true;
} finally {
  try {
    if (h) await h.close();
  } finally {
    await writeFile(logFile, output);
    const report = {passed, checks, exitCode, officialRequests: 0,
      harnessDirectory: h?.directory ?? null, log: fileURLToPath(logFile)};
    await writeFile(reportFile, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  }
}

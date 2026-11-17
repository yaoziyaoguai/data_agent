import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {homedir} from 'node:os';
import {harness} from './harness.mjs';

// 内部stage同时保留实际扫描位置与未交付内容；公开v1回执不增加进度字段。
const h = await harness({startWorker: false});
try {
  const env = {...h.env};
  for (const name of ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL',
    'DATA_AGENT_MODEL_PROFILE', 'DATA_AGENT_MODEL_FAULT', 'DATABASE_URL']) delete env[name];
  let output = '';
  const code = await new Promise((resolve, reject) => {
    const child = spawn(homedir()+'/.cargo/bin/cargo', ['test', '--offline', '--locked', '-p', 'data-agent',
      '--test', 'knowledge_dependencies', 'search_stage_keeps_',
      '--', '--test-threads=1'], {env, stdio: ['ignore', 'pipe', 'pipe']});
    child.stdout.on('data', chunk => {output += chunk; process.stdout.write(chunk);});
    child.stderr.on('data', chunk => process.stderr.write(chunk));
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(code, 0);
  assert.match(output, /test result: ok\. 4 passed; 0 failed/);
  console.log(JSON.stringify({passed: true, officialRequests: 0,
    checks: ['SQL扫描位置按两个owner各自消费行数保留，去重计数、共同轮、主读取及未交付定位分别核对',
      '元信息核验跨共同期限，已消费的两份规范身份与原定位保留为待核验pending，无正文读取',
      '人工确认中文与emoji业务域在允许集、两个SQL owner及正式stage均保留，规范位置跨owner去重',
      '两个SQL owner保留24词候选筛选，完整问句仍计分；同规范身份仅计一候选和一次主读']}));
} finally {
  await h.close();
}

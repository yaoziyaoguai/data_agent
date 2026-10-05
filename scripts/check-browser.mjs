import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const prototype = await realpath(path.join(root, 'prototype'));
const expectedNode = (await readFile(path.join(root, '.node-version'), 'utf8')).trim();
assert.equal(process.versions.node, expectedNode, '请使用 .node-version 固定的 Node 版本');
const executable = chromium.executablePath();
await stat(executable).catch(() => {
  throw new Error('未找到锁定版本的 Chromium，请先运行 npm run browser:install');
});

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = await realpath(path.join(prototype, pathname === '/' ? 'index.html' : pathname));
    if (!file.startsWith(prototype + path.sep)) {
      response.writeHead(403).end();
      return;
    }
    const bytes = await readFile(file);
    response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(bytes);
  } catch (error) {
    response.writeHead(error.code === 'ENOENT' ? 404 : 400).end();
  }
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const port = server.address().port;
let child;
const stop = () => child?.kill('SIGTERM');
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  // 使用现有完整断言；只将默认本机 Chrome 换成锁定的 Playwright Chromium。
  child = spawn(process.execPath, ['prototype/.checks/verify-system.cjs'], {
    cwd: root,
    env: { ...process.env, PROTOTYPE_URL: `http://127.0.0.1:${port}/`, PLAYWRIGHT_CHANNEL: 'chromium' },
    stdio: 'inherit',
    timeout: 180_000,
  });
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const report = JSON.parse(await readFile(path.join(prototype, '.checks/system-browser-checks.json'), 'utf8'));
  const hash = async file => createHash('sha256').update(await readFile(path.join(root, file))).digest('hex');
  const evidence = {
    node: process.versions.node,
    playwright: JSON.parse(await readFile(path.join(root, 'node_modules/playwright/package.json'), 'utf8')).version,
    browser: JSON.parse(await readFile(path.join(root, 'node_modules/playwright-core/browsers.json'), 'utf8')).browsers.find(item => item.name === 'chromium'),
    inputHashes: { 'package-lock.json': await hash('package-lock.json'), 'scripts/check-browser.mjs': await hash('scripts/check-browser.mjs'), 'prototype/.checks/verify-system.cjs': await hash('prototype/.checks/verify-system.cjs') },
    report: 'prototype/.checks/system-browser-checks.json',
    reportSha256: await hash('prototype/.checks/system-browser-checks.json'),
    passed: result.code === 0 && report.passed === true,
    checkCount: report.checkCount,
    process: result,
  };
  await mkdir(path.join(root, '.local/checks'), { recursive: true });
  await writeFile(path.join(root, '.local/checks/browser-environment.json'), JSON.stringify(evidence, null, 2) + '\n');
  assert.equal(result.code, 0, `浏览器检查未正常通过（signal=${result.signal}）`);
  assert.equal(report.passed, true, '浏览器报告未通过');
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

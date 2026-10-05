import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const expectedNode = (await readFile(path.join(root, '.node-version'), 'utf8')).trim();
assert.equal(process.versions.node, expectedNode, '请使用 .node-version 固定的 Node 版本');
const sandbox = path.join(root, '.local/node-smoke');
await mkdir(sandbox, { recursive: true });

const rendered = renderToStaticMarkup(React.createElement('p', null, 'Data Agent smoke'));
assert.equal(rendered, '<p>Data Agent smoke</p>');
await writeFile(path.join(sandbox, 'index.html'), '<!doctype html><html><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>\n');
await writeFile(path.join(sandbox, 'main.js'), 'import React from "react";\nimport { createRoot } from "react-dom/client";\ncreateRoot(document.getElementById("root")).render(React.createElement("p", null, "Data Agent smoke"));\n');
await build({
  root: sandbox,
  configFile: false,
  envFile: false,
  logLevel: 'error',
  build: { outDir: 'dist', emptyOutDir: true },
});
const html = await readFile(path.join(sandbox, 'dist/index.html'), 'utf8');
assert.match(html, /assets\/index-.*\.js/);
assert.ok((await readdir(path.join(sandbox, 'dist/assets'))).some(file => file.endsWith('.js')));

// 只检验 SDK 导出及明确无文件 I/O 的内存管理器；不启动默认资源发现或模型循环。
const pi = await import('@earendil-works/pi-coding-agent');
for (const name of ['createAgentSession', 'SessionManager', 'SettingsManager', 'ModelRuntime']) {
  assert.equal(typeof pi[name], 'function', `Pi 缺少 SDK 导出：${name}`);
}
const sessions = pi.SessionManager.inMemory(sandbox);
assert.equal(sessions.isPersisted(), false);
assert.deepEqual(sessions.buildSessionContext().messages, []);
const settings = pi.SettingsManager.inMemory({ defaultTools: [] });
assert.deepEqual(settings.getDefaultTools(), []);

const packageVersion = async name => JSON.parse(await readFile(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version;
const report = {
  checkedAt: new Date().toISOString(),
  node: process.versions.node,
  versions: Object.fromEntries(await Promise.all(['react', 'react-dom', 'vite', 'playwright', '@earendil-works/pi-coding-agent'].map(async name => [name, await packageVersion(name)]))),
  checks: { reactStaticRender: true, viteProductionBuild: true, piSdkExports: true, piInMemoryManagers: true },
  agentSessionStarted: false,
  modelCalled: false,
  limitations: '未调用 createAgentSession、默认资源发现或真实模型；不证明 Pi 工具调用、恢复协议、DeepSeek 接入或正式应用已经实现。',
  buildOutput: '.local/node-smoke/dist',
};
await mkdir(path.join(root, '.local/checks'), { recursive: true });
await writeFile(path.join(root, '.local/checks/node-smoke.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));

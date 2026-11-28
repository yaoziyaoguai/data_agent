import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {validateContract} from '../../packages/contracts/validate.ts';

// 真实浏览器与生产组件，HTTP边界使用独立合成回执；不代表后台同步或权限服务已通过。
const directory = '.local/checks/source-sync-browser';
await mkdir(directory, {recursive: true});
const server = await createServer({
  configFile: false, root: process.cwd(),
  server: {host: '127.0.0.1', port: 0},
  cacheDir: '.local/source-sync-vite-cache',
  optimizeDeps: {entries: ['apps/web/index.html']},
  plugins: [{name: 'source-sync-browser-fixture', configureServer(vite) {
    vite.middlewares.use('/source-sync-browser', async (_request, response) => {
      const html = await vite.transformIndexHtml('/source-sync-browser', `<!doctype html>
        <html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
        <body><div id="root"></div><script type="module">
        import React from 'react';
        import {createRoot} from 'react-dom/client';
        import {KnowledgePage} from '/apps/web/src/features/knowledge/KnowledgePage.tsx';
        import {UnsavedChangesProvider} from '/apps/web/src/shared/UnsavedChanges.tsx';
        import '/apps/web/src/style.css';
        function Fixture() {
          const [visible, setVisible] = React.useState(true);
          return React.createElement(UnsavedChangesProvider, null,
            React.createElement('button', {onClick: () => setVisible(!visible)}, visible ? '离开语义管理' : '打开语义管理'),
            visible && React.createElement(KnowledgePage, {user: 'synthetic-maintainer'}));
        }
        createRoot(document.getElementById('root')).render(React.createElement(Fixture));
        </script></body></html>`);
      response.setHeader('content-type', 'text/html'); response.end(html);
    });
  }}],
});
await server.listen();
const browser = await chromium.launch();
const page = await browser.newPage({viewport: {width: 1280, height: 900}});
page.setDefaultTimeout(5000);
const errors = [], checks = [], commands = [], progressRequests = [];
page.on('pageerror', error => errors.push(error.message));
const work = (status, total = 0, completed = 0, failed = 0) => ({status, total, completed, failed});
let status = {sync_id: 'synthetic-sync', status_url: '/source-syncs/synthetic-sync', status: 'queued',
  processed_sources: 0, pages_committed: 0, error_code: null,
  preparation: work('pending'), raw_index: work('pending'), knowledge_index: work('pending')};
let canAdmin = true;
let submissionFailure = null;
let progressFailure = null;
let holdProgress = null;
const reply = (route, schema, value, code = 200) => {
  validateContract(schema, value);
  return route.fulfill({status: code, contentType: 'application/json', body: JSON.stringify(value)});
};
await page.route('**/api/**', async route => {
  const request = route.request(), path = new URL(request.url()).pathname;
  if (path === '/api/workspace/events') return route.fulfill({status: 200, contentType: 'text/event-stream', body: 'event: stream_closed\ndata: {"code":"closed"}\n\n'});
  if (path === '/api/knowledge') return reply(route, 'KnowledgeList', {objects: [], retrieval_mode: 'lexical', next_after_id: null});
  if (path === '/api/knowledge-proposals') return reply(route, 'ProposalList', {proposals: []});
  if (path === '/api/semantic-corrections') return reply(route, 'SemanticCorrectionList', {corrections: [], next_after_id: null});
  if (path === '/api/semantic-access') return reply(route, 'SemanticAccess', {
    can_admin: canAdmin, can_create: false, highest_role: canAdmin ? 'super_maintainer' : 'maintainer',
  });
  if (path === '/api/source-syncs' && request.method() === 'POST') {
    commands.push(request.postDataJSON());
    if (submissionFailure === 'lost_response') { submissionFailure = null; return route.abort('failed'); }
    if (submissionFailure) return reply(route, 'AppError', {code: submissionFailure, message: '合成同步拒绝', request_id: 'synthetic-submit-denied', retryable: false}, 403);
    return reply(route, 'SourceSyncAccepted', {sync_id: status.sync_id, status_url: status.status_url, status: status.status}, 202);
  }
  if (path.startsWith('/api/source-syncs/')) {
    progressRequests.push(path);
    if (progressFailure) return reply(route, 'AppError', {code: progressFailure, message: '合成读取故障', request_id: 'synthetic-read-failure', retryable: true}, 503);
    const snapshot = structuredClone(status);
    if (holdProgress) { const wait = holdProgress; holdProgress = null; await wait; }
    return reply(route, 'SourceSyncProgress', snapshot);
  }
  throw new Error('Unexpected synthetic API: ' + path);
});
let passed = false;
try {
  const address = server.httpServer.address();
  await page.goto(`http://127.0.0.1:${address.port}/source-sync-browser`, {timeout: 20000});
  await page.getByText('维护操作', {exact: true}).click();
  await page.getByRole('button', {name: '同步来源', exact: true}).click();
  const progress = page.getByRole('region', {name: '来源同步进度'});
  await progress.getByText('资料同步：等待处理', {exact: true}).waitFor();
  assert.equal(commands.length, 1);
  assert.equal(await page.getByRole('button', {name: '同步中…', exact: true}).isDisabled(), true);
  status = {...status, status: 'completed', processed_sources: 23, pages_committed: 2,
    preparation: work('running', 23, 3), raw_index: work('pending', 23), knowledge_index: work('not_required')};
  await progress.getByText('资料同步：已完成', {exact: true}).waitFor();
  await progress.getByText('语义整理：处理中 · 3 / 23', {exact: true}).waitFor();
  await progress.getByText('原文索引：等待处理 · 0 / 23', {exact: true}).waitFor();
  await progress.getByText('知识索引：无需处理', {exact: true}).waitFor();
  assert.match(await progress.innerText(), /资料已保存；整理和索引进度分别如下/);
  checks.push('202进入后台进度，资料完成不冒称整理或索引完成');
  status = {...status, preparation: work('completed', 23, 23), raw_index: work('completed', 23, 23)};
  await progress.getByText('语义整理：已完成 · 23 / 23', {exact: true}).waitFor();
  const settledReads = progressRequests.length;
  await page.waitForTimeout(2200);
  assert.equal(progressRequests.length, settledReads, '各项终态后不继续轮询');
  checks.push('全部后台工作进入终态后停止轮询');

  status = {...status, sync_id: 'failed-sync', status_url: '/source-syncs/failed-sync', status: 'failed',
    processed_sources: 4, pages_committed: 1, error_code: 'catalog_unavailable',
    preparation: work('failed', 4, 2, 2), raw_index: work('completed', 4, 4)};
  await page.getByRole('button', {name: '重新同步', exact: true}).click();
  await progress.getByRole('alert').filter({hasText: 'catalog_unavailable'}).waitFor();
  await progress.getByText('语义整理：处理失败 · 2 / 4 · 失败 2', {exact: true}).waitFor();
  assert.notEqual(commands[0].operation_id, commands[1].operation_id);
  const failedCommands = commands.length;
  await page.waitForTimeout(2200);
  assert.equal(commands.length, failedCommands, '终态失败不自动发起另一次同步');
  checks.push('失败保留已保存数量及各项状态，明确重新同步才发新命令');

  const limitMessage = '完整来源JSON为8388609字节，超过8388608字节上限。';
  status = {...status, sync_id: 'size-limit-sync', status_url: '/source-syncs/size-limit-sync',
    error_code: 'payload_limit', error_message: limitMessage};
  await page.getByRole('button', {name: '重新同步', exact: true}).click();
  await progress.getByRole('alert').filter({hasText: limitMessage}).waitFor();
  checks.push('异步超限错误展示实际大小及上限，缺少message的旧回执仍用错误码');

  status = {...status, sync_id: 'retry-sync', status_url: '/source-syncs/retry-sync', status: 'queued',
    processed_sources: 0, pages_committed: 0, error_code: null, error_message: null,
    preparation: work('pending'), raw_index: work('pending'), knowledge_index: work('pending')};
  submissionFailure = 'lost_response';
  await page.getByRole('button', {name: '重新同步', exact: true}).click();
  await page.getByRole('button', {name: '重试提交同步', exact: true}).waitFor();
  assert.equal(await page.getByRole('button', {name: '重试读取进度', exact: true}).count(), 0,
    '提交回执未知时不能将旧批次读取重试作为该错误的恢复操作');
  progressFailure = 'unavailable';
  await page.getByRole('button', {name: '重试提交同步', exact: true}).click();
  await progress.getByRole('button', {name: '重试读取进度', exact: true}).waitFor();
  assert.equal(commands.at(-1).operation_id, commands.at(-2).operation_id, '丢回执后重传同命令');
  const beforeProgressRetry = commands.length;
  progressFailure = null;
  status = {...status, status: 'running', processed_sources: 7, pages_committed: 1};
  await progress.getByRole('button', {name: '重试读取进度', exact: true}).click();
  await progress.getByText('资料同步：处理中', {exact: true}).waitFor();
  assert.equal(commands.length, beforeProgressRetry, '进度重试不创建新批次');
  checks.push('提交丢回执重用命令，读取失败单独重试同批进度');

  let releaseOldProgress;
  holdProgress = new Promise(resolve => { releaseOldProgress = resolve; });
  await page.waitForRequest(request => request.url().endsWith('/source-syncs/retry-sync'));
  const abortedOld = page.waitForEvent('requestfailed', request => request.url().endsWith('/source-syncs/retry-sync'));
  await page.getByRole('button', {name: '离开语义管理', exact: true}).click();
  await abortedOld;
  status = {...status, sync_id: 'current-sync', status_url: '/source-syncs/current-sync', status: 'completed',
    processed_sources: 99, pages_committed: 5,
    preparation: work('not_required'), raw_index: work('not_required'), knowledge_index: work('not_required')};
  await page.getByRole('button', {name: '打开语义管理', exact: true}).click();
  await page.getByText('维护操作', {exact: true}).click();
  await page.getByRole('button', {name: '同步来源', exact: true}).click();
  await progress.getByText('已处理 99 份来源，已保存 5 批资料。', {exact: true}).waitFor();
  const oldReads = progressRequests.filter(path => path.endsWith('/retry-sync')).length;
  releaseOldProgress();
  await page.waitForTimeout(2200);
  assert.equal(progressRequests.filter(path => path.endsWith('/retry-sync')).length, oldReads);
  assert.match(await progress.innerText(), /已处理 99 份来源/);
  assert.doesNotMatch(await progress.innerText(), /已处理 7 份来源/);
  checks.push('离开页面停止轮询；迟到回执不覆盖重新打开后的新批次');
  for (const width of [1280, 390]) {
    await page.setViewportSize({width, height: 900});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.screenshot({path: `${directory}/progress-${width}.png`, fullPage: true});
  }

  await page.getByRole('button', {name: '离开语义管理', exact: true}).click();
  canAdmin = false;
  const deniedAccess = page.waitForResponse(response => response.url().endsWith('/semantic-access'));
  await page.getByRole('button', {name: '打开语义管理', exact: true}).click();
  await deniedAccess;
  await page.getByText('维护操作', {exact: true}).click();
  assert.equal(await page.getByRole('button', {name: '同步来源', exact: true}).isDisabled(), true);
  assert.equal(await progress.count(), 0);
  await page.getByRole('button', {name: '离开语义管理', exact: true}).click();
  canAdmin = true; submissionFailure = 'forbidden';
  await page.getByRole('button', {name: '打开语义管理', exact: true}).click();
  await page.getByText('维护操作', {exact: true}).click();
  await page.getByRole('button', {name: '同步来源', exact: true}).click();
  await progress.getByRole('alert').filter({hasText: '当前账号无权同步或查看来源同步进度'}).waitFor();
  assert.equal(await progress.getByText('资料同步：已完成', {exact: true}).count(), 0);
  checks.push('无维护权限禁用入口，服务端拒绝明确显示且不伪造成功');
  assert.deepEqual(errors, []);
  passed = true;
} finally {
  await page.screenshot({path: directory + (passed ? '/desktop.png' : '/failure.png'), fullPage: true}).catch(() => {});
  await writeFile(directory + '/report.json', JSON.stringify({passed, checks, errors, commands, progressRequests, officialRequests: 0, database: 'not_used'}, null, 2));
  await browser.close(); await server.close();
  console.log(JSON.stringify({passed, checks, errors, officialRequests: 0, database: 'not_used'}));
}

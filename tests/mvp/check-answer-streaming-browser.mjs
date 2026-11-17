import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { harness, until } from './harness.mjs';

// §7.2浏览器屏障（本包唯一一条整体浏览器流程）：受控provider还未结束时，DOM已有正文前缀并随后增长，
// 生成中的状态提示准确，最终与刷新后的正式正文一致；不足一次刷新周期的短句只显示一次不判失败。
// 完成流沿v2工具合同已验证的两步形态：先在收窄态建任务，再纯文本消息自然收尾提交（同check-waiting-task-delivery
// 的ordinary形态）；纯文本无任务或不带finish_reason都不构成合法完成流，流式标记渲染细节已由check-rendered-*覆盖。
const profile = { provider_id: 'deepseek', model_id: 'deepseek-flash', trial_id: 'streaming_' + randomUUID(),
  price_version: '2026-10-04-peak-usd', input_limit: 65536, output_limit: 2048, trial_call_limit: 48,
  trial_cost_micros: '1000000', request_call_limit: 24, toolset: 'data', payload_bytes_limit: 131072 };
const conditions = { time_start: null, time_end: null, timezone: 'UTC', metric: null, channel: null,
  group_by: [], filters: [], knowledge_refs: [], notes: '', source_limits: null };
const sentences = [
  '净收入先按付款日期把原始金额归集到各渠道。',
  '退款不直接改订单，而是作为负向金额进入同一口径。',
  '因此一月的净收入等于当月原始金额减去当月确认的退款。',
  '如果退款跨月确认，当月净收入可能低于账面流水。',
  '渠道维度上，web与app的退款率通常不同，需要分开观察。',
  '退款率是退款金额占原始金额的比例，不是占净收入的比例。',
  '把退款率算到净收入上会放大波动，不适合做同比。',
  '观察退款率时还应排除测试订单与零元单。',
  '净收入对时间范围敏感，退款率对确认口径敏感。',
  '两者结合才能解释某渠道净收入为什么下降。',
  '例如渠道净收入下降可能只是退款集中确认所致。',
  '综上，净收入与退款率应同口径、同范围、同过滤条件对照阅读。',
];
const longAnswer = sentences.join('\n\n');
const longQuestion = '分段说明净收入与退款率的关系';
const shortQuestion = '这条很短';
const shortAnswer = '已收到，这条很短，不需要展开。';

let providerCalls = 0;
let generationFinished = false;
const providerBodies = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const provider = createServer(async (request, response) => {
  try {
    assert.equal(request.headers.authorization, 'Bearer synthetic-protocol-key');
    let raw = ''; request.setEncoding('utf8');
    for await (const part of request) raw += part;
    const body = JSON.parse(raw);
    providerBodies.push({ bytes: Buffer.byteLength(raw), tools: (body.tools ?? []).map(t => t.function?.name) });
    const lastUser = [...body.messages].reverse().find(m => m.role === 'user');
    const userText = typeof lastUser.content === 'string' ? lastUser.content
      : (lastUser.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('');
    const chunk = (value, reason = null) => ({ id: 'synthetic-streaming', object: 'chat.completion.chunk',
      created: 1, model: 'deepseek-flash', choices: [{ index: 0, delta: value, finish_reason: reason }] });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    providerCalls++;
    const send = (value, reason = null) => response.write('data: ' + JSON.stringify(chunk(value, reason)) + '\n\n');
    const toolCall = (id, args) => [{ index: 0, id, type: 'function',
      function: { name: 'update_analysis_task', arguments: JSON.stringify(args) } }];
    const last = body.messages[body.messages.length - 1];
    if (last.role !== 'tool') {
      // 每条消息第一步：未建任务时工具集处于收窄态，任务控制工具仍可见；create给出合法完成前提。
      send({ role: 'assistant', content: '', tool_calls: toolCall(randomUUID(),
        { action: 'create', goal: userText, conditions, options: [] }) }, 'tool_calls');
    } else {
      // 第二步：慢速流式正文，纯文本消息自然收尾提交（无工具调用，run按合同完成）。
      const receipt = JSON.parse(last.content);
      assert.ok(receipt.task_id && receipt.condition_version, 'create回执必须给出任务身份: ' + last.content);
      if (userText.includes('分段说明')) {
        send({ role: 'assistant', content: '' });
        for (const sentence of sentences) { await delay(650); send({ content: sentence + '\n\n' }); }
        send({}, 'stop');
        generationFinished = true;
      } else {
        send({ role: 'assistant', content: shortAnswer }, 'stop');
      }
    }
    response.write('data: ' + JSON.stringify({ id: 'synthetic-streaming', choices: [],
      usage: { prompt_tokens: 100, completion_tokens: 25, total_tokens: 125 } }) + '\n\n');
    response.end('data: [DONE]\n\n');
  } catch (error) {
    if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'synthetic_streaming_assertion_failed' } }));
  }
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const h = await harness({ web: true, profile, protocolProviderUrl: 'http://127.0.0.1:' + provider.address().port,
  env: { DATA_AGENT_LEASE_MS: '120000', DATA_AGENT_TOOL_CONTRACT_VERSION: '2' } });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const directory = '.local/browser-artifacts/answer-streaming';
await mkdir(directory, { recursive: true });
const checks = [], errors = [];
let passed = false;
page.on('pageerror', e => errors.push(e.message));
const answerBody = () => page.locator('.messages .message.assistant:not(.query-message) .assistant-markdown').last();
const answerLabel = () => page.locator('.messages .message.assistant:not(.query-message) .message-label').last();
const normalize = text => text.replace(/\s+/g, '');
const send = async text => { await page.getByLabel('你的数据问题').fill(text); await page.getByRole('button', { name: '发送 ↑', exact: true }).click(); };
let cid;
try {
  await page.goto(h.url);
  await page.getByLabel('演示登录凭据').fill(h.tokens.alice);
  await page.getByRole('button', { name: '进入工作台 →', exact: true }).click();
  await send(longQuestion);
  // 全新页面首次发送会自建会话并写入localStorage；从页面取得真实会话id再做后台断言。
  cid = await until(() => page.evaluate(() => localStorage.getItem('data-agent.conversation.["demo","alice"]')), '页面会话建立', 10000);
  // 生成未结束期间持续采样：正文前缀已出现、逐次增长、状态提示为生成中、早先消息不动。
  const samples = [];
  let prefixShot = false, userStable = true;
  const started = Date.now();
  while (Date.now() - started < 30000) {
    if (generationFinished && await answerBody().count() && !(await answerLabel().innerText()).includes('生成中')) break;
    if (await answerBody().count()) {
      const text = await answerBody().innerText();
      const label = await answerLabel().innerText();
      const userText = await page.locator('.messages .message.user p').first().innerText();
      if (userText !== longQuestion) userStable = false;
      if (text) samples.push({ len: text.length, generating: label.includes('生成中'), finished: generationFinished, head: text.slice(0, 40) });
      if (text && !prefixShot && normalize(text) !== normalize(longAnswer)) {
        await page.screenshot({ path: directory + '/streaming-prefix.png', fullPage: true, animations: 'disabled' });
        prefixShot = true;
      }
    }
    await page.waitForTimeout(350);
  }
  await writeFile(directory + '/samples.json', JSON.stringify({ samples, generationFinished }, null, 2));
  const beforeFinish = samples.filter(s => !s.finished);
  assert.ok(beforeFinish.some(s => s.len > 0 && s.generating), '受控provider未结束时DOM必须已有正文前缀且状态为生成中');
  const growing = beforeFinish.map(s => s.len);
  let growths = 0, peak = 0;
  for (const len of growing) { if (len > peak) { if (peak > 0) growths++; peak = len; } }
  assert.ok(growths >= 2, '生成期间正文必须持续增长（至少两次变长），实际样本: ' + JSON.stringify(growing));
  assert.ok(beforeFinish.some(s => s.len > 0 && s.len < longAnswer.length), '生成期间必须观察到严格短于全文的正文前缀');
  assert.equal(userStable, true, '流式增长期间早先用户消息不得移动或改写');
  await h.finished(cid);
  await until(async () => !(await answerLabel().innerText()).includes('生成中'), '生成中提示清除', 10000);
  assert.equal(normalize(await answerBody().innerText()), normalize(longAnswer), '定稿正文与流式拼接一致');
  await page.screenshot({ path: directory + '/streaming-final.png', fullPage: true, animations: 'disabled' });
  checks.push('受控provider未结束时DOM先出现正文前缀并持续增长（' + growths + '次变长），定稿与流式内容一致，早先消息不动');
  await page.reload();
  await until(async () => await answerBody().count() && (await answerBody().innerText()).length > 0, '刷新后正文恢复', 10000);
  assert.equal(normalize(await answerBody().innerText()), normalize(longAnswer), '刷新后与正式正文一致');
  assert.equal(await page.locator('.messages .message.assistant:not(.query-message)').count(), 1, '长回答只显示一份');
  await page.screenshot({ path: directory + '/after-reload.png', fullPage: true, animations: 'disabled' });
  checks.push('刷新后读回同一正式正文，正文不重复不丢失');
  // 生成不足一次刷新周期的短句只显示一次，不判失败。
  await send(shortQuestion);
  await h.finished(cid, 2);
  await until(async () => (await page.getByText(shortAnswer).count()) === 1, '短句显示', 10000);
  assert.equal(await page.locator('.messages .message.assistant:not(.query-message)').count(), 2, '短回答只显示一次');
  assert.equal((await answerLabel().innerText()).includes('生成中'), false, '短回答不残留生成中状态');
  checks.push('不足一次刷新周期的短句只显示一次，无重复、无失败提示');
  assert.equal(providerCalls, 4, '每条消息恰好两次模型调用（建任务+定稿正文）');
  assert.deepEqual(errors, []);
  passed = true;
} finally {
  if (!passed) {
    // 失败诊断：转储运行/事件/工具调用状态，区分卡住与失败。
    try {
      const diag = await h.snapshot(cid);
      await writeFile(directory + '/failure-diagnostics.json', JSON.stringify({
        runs: diag.runs.map(r => ({ id: r.id, state: r.state })),
        runRows: diag.runs.map(r => h.sql(`SELECT JSON_OBJECT('state',state,'lease_owner',lease_owner,'lease_until',lease_until,'attempt_id',attempt_id,'commit_id',commit_id) AS v FROM agent_runs WHERE id='${r.id}'`)),
        jobs: h.sql(`SELECT JSON_OBJECT('state',state,'lease_owner',lease_owner) AS v FROM background_jobs`),
        events: diag.events.slice(-12).map(e => ({ type: e.type, payload: String(JSON.stringify(e.payload)).slice(0, 120) })),
        lastMessage: diag.messages.slice(-2).map(m => ({ role: m.role, committed: m.committed, len: m.text?.length })),
      }, null, 2));
    } catch { /* 收尾诊断失败不影响原失败 */ }
    await page.screenshot({ path: directory + '/failure.png', fullPage: true }).catch(() => {});
  }
  await writeFile(directory + '/report.json', JSON.stringify({ passed, checks, errors, providerCalls,
    providerBodies: providerBodies.map(b => ({ bytes: b.bytes, tools: b.tools.length })), officialRequests: 0 }, null, 2));
  await browser.close();
  await h.close();
  provider.closeAllConnections();
  await new Promise(resolve => provider.close(resolve));
  console.log(JSON.stringify({ passed, checks, errors, providerCalls, officialRequests: 0 }));
}

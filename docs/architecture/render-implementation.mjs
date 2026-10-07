import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// Markdown 是接口与图的唯一源。渲染器只在本地构建时使用，图册离线打开。
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const vendor = path.join(root, '.local/diagram-renderer/mermaid-10.9.3.min.js');
const vendorHash = '5a8ec91820bd55afef049068489369910e5d6ce70c8103952f27e29d3e76e8bc';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
assert.equal(hash(await fs.readFile(vendor)), vendorHash, '本地 Mermaid 版本或内容改变');
const files = ['implementation-views.md', 'knowledge-modules.md', 'runtime-modules.md'];
const sources = {};
const diagrams = [];
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const inline = value => escape(value).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
function describeSection(text) {
  const lines = text.split('\n');
  const result = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```') || /^### [FS]\d+/.test(line)) break;
    if (line.startsWith('|') && lines[i + 1]?.match(/^\|[\s:|-]+\|$/)) {
      const cells = value => value.trim().slice(1, -1).split('|').map(x => inline(x.trim()));
      const head = cells(line); i += 2;
      const rows = [];
      while (lines[i]?.startsWith('|')) { rows.push(cells(lines[i])); i++; }
      i--;
      result.push(`<div class="table-wrap"><table><thead><tr>${head.map(x => `<th>${x}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(x => `<td>${x}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
    } else if (/^### /.test(line)) result.push(`<h3>${inline(line.slice(4))}</h3>`);
    else if (line.trim()) result.push(`<p>${inline(line.replace(/^- /, '• '))}</p>`);
  }
  return result.join('\n');
}
for (const filename of files) {
  const text = await fs.readFile(path.join(here, filename), 'utf8');
  sources[filename] = hash(text);
  for (const match of text.matchAll(/```mermaid\n([\s\S]*?)```/g)) {
    const before = text.slice(0, match.index);
    const heading = [...before.matchAll(/^#{2,3} (.+)$/gm)].at(-1)?.[1];
    const id = heading?.match(/^([VFS]\d{2})\b/)?.[1];
    assert(id, `${filename} 的图缺 Vxx/Fxx 标题`);
    const module = !id.startsWith('V') && Number(id.slice(1)) <= 12 ? `M${id.slice(1)}` : null;
    const moduleHeading = module ? [...before.matchAll(new RegExp(`^## .*?${module}\\b.*$`, 'gm'))].at(-1) : null;
    const section = moduleHeading ? before.slice(moduleHeading.index) : '';
    const name = moduleHeading ? moduleHeading[0].replace(/^## (?:\d+\. )?/, '').replaceAll('`', '') : heading;
    diagrams.push({ id, module, name, heading, filename, source: match[1].trim(), context: describeSection(section) });
  }
}
assert.equal(new Set(diagrams.map(d => d.id)).size, diagrams.length);
for (let i = 1; i <= 12; i++) assert(diagrams.some(d => d.module === `M${String(i).padStart(2, '0')}`));
diagrams.sort((a, b) => (a.id.startsWith('V') ? '0' : '1').localeCompare(b.id.startsWith('V') ? '0' : '1') || a.id.localeCompare(b.id));
await fs.mkdir(path.join(here, 'module-diagrams'), { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith('http') ? route.abort() : route.continue());
  await page.setContent('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body></body></html>');
  await page.addScriptTag({ path: vendor });
  await page.evaluate(() => mermaid.initialize({
    startOnLoad: false, securityLevel: 'strict', theme: 'base',
    fontFamily: 'PingFang SC, Microsoft YaHei, Arial, sans-serif',
    themeVariables: { fontSize: '17px', primaryColor: '#eef4fb', primaryBorderColor: '#607c99', primaryTextColor: '#172c40', lineColor: '#617387', secondaryColor: '#f5f8fb', tertiaryColor: '#ffffff', clusterBkg: '#f7f9fc', clusterBorder: '#bccbd9', actorBkg: '#edf3fa', actorBorder: '#607c99', actorTextColor: '#172c40', signalTextColor: '#172c40', signalColor: '#607c99', noteBkgColor: '#fff7e3', noteBorderColor: '#c6a56e' },
    flowchart: { htmlLabels: false, useMaxWidth: false, curve: 'linear', padding: 22, nodeSpacing: 35, rankSpacing: 60 },
    sequence: { useMaxWidth: false, diagramMarginX: 30, diagramMarginY: 25, actorMargin: 45, messageMargin: 38, wrap: true },
  }));
  for (const d of diagrams) {
    d.svg = await page.evaluate(async ({ id, source }) => (await mermaid.render(`diagram${id}`, source)).svg, d);
    assert(d.svg.includes('<svg'), d.id);
    assert(!d.svg.includes('Syntax error'), d.id);
    await fs.writeFile(path.join(here, 'module-diagrams', `${d.id}.svg`), d.svg);
  }
  const data = JSON.stringify(diagrams).replaceAll('<', '\\u003c');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Data Agent · 实现设计图册</title><style>
  :root{color-scheme:light;--ink:#172c40;--muted:#627386;--border:#dce4ed;--blue:#185cac}*{box-sizing:border-box}body{margin:0;color:var(--ink);background:#f4f6f8;font:15px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}button,a{touch-action:manipulation}button{font:inherit;cursor:pointer}a{color:var(--blue)}.layout{display:grid;grid-template-columns:285px minmax(0,1fr);min-height:100vh}aside{height:100vh;overflow:auto;position:sticky;top:0;background:#11263a;color:#e8eef5;padding:27px 18px}aside h1{font-size:20px;line-height:1.35;margin:0 10px 6px}aside .sub{font-size:12px;color:#a8bbcc;margin:0 10px 25px}aside h2{font-size:11px;letter-spacing:.1em;color:#a8bbcc;margin:24px 10px 7px}nav button{display:block;text-align:left;color:#dce7f1;border:0;background:transparent;width:100%;border-radius:5px;padding:10px;margin:3px 0;font-size:13px;line-height:1.5}nav button[aria-current=true]{background:#294961;color:white;box-shadow:inset 3px 0 #91bdf0}nav button:hover{background:#233e54}main{min-width:0;padding:35px 40px 65px;max-width:1800px}.eyebrow{font-size:12px;letter-spacing:.1em;color:var(--muted);margin:0 0 8px}main h1{font-size:27px;line-height:1.35;margin:0 0 10px;font-weight:650}.lede{max-width:960px;color:var(--muted);margin:0 0 22px}.bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0 0 12px}.bar button,.bar a{padding:6px 12px;border:1px solid var(--border);border-radius:4px;background:white;color:var(--ink);text-decoration:none;font-size:13px}.bar button[aria-pressed=true]{background:#e9f2fc;border-color:#769fc7;color:#114f91}.bar span{font-size:12px;color:var(--muted);margin-right:auto}.canvas{background:white;border:1px solid var(--border);border-radius:7px;overflow:auto;padding:24px;max-height:75vh;min-height:240px}.drawing{width:100%;min-width:560px;display:block}.drawing svg{display:block;width:100%;height:auto;max-width:none!important}.legend{font-size:12px;color:var(--muted);margin:9px 0 25px}.details{background:white;border:1px solid var(--border);border-radius:7px;padding:22px 26px;margin:18px 0}.details h2{font-size:19px;margin:0 0 14px}.details h3{font-size:16px;margin:20px 0 10px}.details p{font-size:14px;line-height:1.8}.table-wrap{overflow:auto;margin:18px 0}table{border-collapse:collapse;font-size:13px;width:100%;min-width:770px}th,td{text-align:left;vertical-align:top;border-bottom:1px solid var(--border);padding:11px 13px}th{background:#f2f6fa;font-weight:600}td:first-child{min-width:170px}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em;overflow-wrap:anywhere}pre{overflow:auto;padding:16px;background:#f4f6f8;font-size:12px;line-height:1.7}summary{cursor:pointer;font-size:14px}.note{border-left:3px solid #ba9854;padding-left:12px;font-size:13px;color:#675a3f}.footer{font-size:12px;color:var(--muted);margin-top:25px}:focus-visible{outline:3px solid #448bdd;outline-offset:3px}@media(max-width:800px){.layout{display:block}aside{position:relative;height:auto;padding:20px 16px}aside .sub{margin-bottom:14px}nav{display:flex;overflow:auto;gap:5px}nav h2{display:none}nav button{min-width:180px;max-width:230px;margin:0}.layout aside h1{font-size:18px}main{padding:24px 16px}main h1{font-size:23px}.canvas{padding:12px;max-height:65vh}.details{padding:17px 14px}}
  </style></head><body><div class="layout"><aside><h1>Data Agent<br>实现设计图册</h1><p class="sub">模块 · 接口 · 状态 · 流程</p><nav aria-label="设计图导航" id="nav"></nav></aside><main><p class="eyebrow">IMPLEMENTATION DESIGN / 2026-10-07</p><h1 id="title"></h1><p class="lede" id="lede"></p><div class="bar"><span id="scope"></span><button id="structure">内部框架</button><button id="flow">处理流程</button><button id="minus" aria-label="缩小图形">−</button><button id="reset">适合宽度</button><button id="plus" aria-label="放大图形">＋</button><a id="svg-link" target="_blank">打开完整 SVG ↗</a></div><div class="canvas" id="canvas"><div class="drawing" id="drawing"></div></div><p class="legend" id="legend"></p><section class="details" id="contract"><h2>模块职责与公开操作</h2><div id="context"></div></section><section class="details"><h2>设计依据</h2><p><a id="source-link">查看本图对应的模块设计源文件</a> · <a href="implementation-design.md">完整实现设计与接口总表</a></p><details><summary>查看 Mermaid 源码</summary><pre id="mermaid-source"></pre></details><p class="note">本页保存设计与实施契约。正式接入、真实模型和平台验证分别以CURRENT及其证据为准。</p></section><p class="footer">本页由同目录 Markdown 生成，可离线阅读。当前项目状态统一记录在 docs/CURRENT.md。</p></main></div><script>
  const diagrams=${data};let scale=1;const byId=id=>document.getElementById(id);const nav=byId('nav');
  const blurbs={V01:'从进程进入内部业务模块：API 与 Worker 复用同一 Rust 业务库，Pi 负责唯一的 Agent 循环。',V02:'箭头表示代码依赖。各业务模块通过公开接口由具名用例组合，存储实现保持私有。',V03:'逐步追踪从提问到查询、解释和纠错的调用；本地事务与外部调用的边界分别标明。',F13:'资料变更怎样进入正式语义、保留人工修改并更新检索索引。'};
  for(const d of diagrams.filter(x=>!x.id.startsWith('S'))){if(d.id==='V01'||d.id==='F01'||d.id==='F13'){const h=document.createElement('h2');h.textContent=d.id==='V01'?'框架与调用':d.id==='F01'?'各模块流程与接口':'跨模块协作';nav.append(h)}const b=document.createElement('button');b.textContent=d.module?d.name:d.heading;b.dataset.id=d.id;b.onclick=()=>{location.hash=d.id};nav.append(b)}
  function zoom(){byId('drawing').style.width=(scale*100)+'%'}
  function show(){const id=location.hash.slice(1);const d=diagrams.find(x=>x.id===id)||diagrams[0];scale=1;zoom();byId('title').textContent=d.module?d.name:d.heading;byId('lede').textContent=blurbs[d.id]||'先看职责与内部流程，再核对下方公开操作、输入输出与错误处理。跨模块事务由具名用例协调。';byId('scope').textContent=d.module?'代码模块 · 统一交付':'架构视图 · '+d.id;byId('drawing').innerHTML=d.svg;byId('canvas').scrollTo(0,0);byId('context').innerHTML=d.context;byId('contract').hidden=!d.context;byId('source-link').href=d.filename;byId('svg-link').href='module-diagrams/'+d.id+'.svg';byId('mermaid-source').textContent=d.source;byId('legend').textContent=d.id==='V02'?'图例：箭头表示导入/编译依赖，不是运行时回调。':d.id==='V01'?'图例：框表示进程或职责组，箭头表示运行时交互；代码模块不等于独立微服务。':'图例：分支说明处理条件；事务内仅进行本地记录变更，模型和平台网络调用在事务外。';for(const b of nav.querySelectorAll('button'))b.setAttribute('aria-current',String(b.dataset.id===d.id.replace(/^S/,'F')));document.body.dataset.view=d.id;for(const [button,prefix] of [['structure','S'],['flow','F']]){byId(button).hidden=!d.module;byId(button).setAttribute('aria-pressed',String(d.id.startsWith(prefix)));byId(button).onclick=()=>{location.hash=prefix+d.id.slice(1)}}document.title=(d.module||d.id)+' · Data Agent 实现设计'}
  byId('minus').onclick=()=>{scale=Math.max(.5,scale-.25);zoom()};byId('plus').onclick=()=>{scale=Math.min(3,scale+.25);zoom()};byId('reset').onclick=()=>{scale=1;zoom()};window.addEventListener('hashchange',show);show();
  </script></body></html>`;
  const atlas = path.join(here, 'implementation-atlas.html');
  await fs.writeFile(atlas, html);
  await page.goto(`file://${atlas}`);
  const views = [];
  for (const d of diagrams) {
    await page.evaluate(id => { location.hash = id; }, d.id);
    await page.waitForFunction(id => document.body.dataset.view === id, d.id);
    assert.equal(await page.locator('#drawing svg').count(), 1);
    if (d.module) assert(await page.locator('#context table').count() > 0, d.id);
    const geometry = await page.locator('#drawing svg').evaluate(svg => {
      const vb = svg.viewBox.baseVal;
      const labels = [...svg.querySelectorAll('text')];
      const invalid = labels.filter(t => { const box = t.getBoundingClientRect(); const parent = svg.getBoundingClientRect(); return box.width > 0 && (box.left < parent.left - 3 || box.right > parent.right + 3 || box.top < parent.top - 3 || box.bottom > parent.bottom + 3); });
      return { width: vb.width, height: vb.height, textCount: labels.length, outsideLabels: invalid.map(t => t.textContent) };
    });
    assert(geometry.width > 0 && geometry.height > 0, d.id);
    assert.equal(geometry.outsideLabels.length, 0, `${d.id}: 图中文字超出SVG边界`);
    views.push({ id: d.id, ...geometry });
  }
  await page.locator('button[data-id="F07"]').click();
  await page.locator('#structure').click();
  await page.waitForFunction(() => document.body.dataset.view === 'S07');
  await page.locator('#flow').click();
  await page.waitForFunction(() => document.body.dataset.view === 'F07');
  await page.locator('button[data-id="V02"]').click();
  await page.waitForFunction(() => document.title.startsWith('V02'));
  await page.locator('#plus').click();
  assert.equal(await page.locator('#drawing').evaluate(el => el.style.width), '125%');
  await page.locator('#reset').click();
  assert.equal(await page.locator('#drawing').evaluate(el => el.style.width), '100%');
  await page.screenshot({ path: path.join(here, 'module-diagrams/desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflow, false, '手机页面水平溢出');
  await page.screenshot({ path: path.join(here, 'module-diagrams/mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  for (const [filename, digest] of Object.entries(sources)) assert.equal(hash(await fs.readFile(path.join(here, filename))), digest, '渲染过程中设计源发生变化');
  const report = { status: 'passed', scope: '图册与Mermaid渲染、模块操作表、导航/缩放、手机文档溢出检查；不证明业务实现', renderer: { mermaid: '10.9.3', sha256: vendorHash, browser: browser.version() }, sources, diagrams: views, pageErrors: errors, mobileOverflow: overflow };
  await fs.writeFile(path.join(here, 'implementation-diagram-checks.json'), JSON.stringify(report, null, 2)+'\n');
  console.log(JSON.stringify({ status: report.status, diagrams: views.length, modules: 12, pageErrors: errors.length, mobileOverflow: overflow }));
} finally { await browser.close(); }

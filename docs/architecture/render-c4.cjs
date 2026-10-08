const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

// 总览与三张详图共用 11 个组件和 19 条关系，职责与当前合成平台实现一致。
const nodes = {
  users: { name: '业务用户', type: 'Person', tech: '产品 · 算法 · 分析', lines: ['授权维护者编辑语义'], kind: 'person' },
  web: { name: 'Web 应用', type: 'Container', tech: 'React / TypeScript', lines: ['提问、SQL、结果与历史', '语义管理 · 我的积累'], kind: 'app' },
  api: { name: '业务 API 服务', type: 'Container', tech: 'Rust / Axum', lines: ['系统维护授权、版本与调用预算', '会话、语义与共享方法规则', '查询前另核平台权限与用户确认'], kind: 'app' },
  pi: { name: 'Agent 运行进程', type: 'Container', tech: 'Node.js / Pi SDK 1.0.0', lines: ['唯一模型与工具循环', '原生 Skill、会话续接与压缩'], kind: 'app' },
  journal: { name: 'Pi 原生会话', type: 'Data Store', tech: '私有 JSONL / 同一宿主', lines: ['完整 SDK 会话树与工具历史', '精确 leaf / 授权引用保存在 MySQL'], kind: 'store' },
  worker: { name: '后台任务进程', type: 'Container', tech: 'Rust Worker', lines: ['来源同步、预填与索引更新', '查询跟踪、作业租约与重试'], kind: 'app' },
  mysql: { name: '正式业务记录', type: 'Data Store', tech: 'MySQL 8.4', lines: ['知识、版本、会话与查询状态', '私人记忆、公共方法与预算'], kind: 'store' },
  vector: { name: '检索索引', type: 'Data Store', tech: 'Milvus 3.0 / 可接 Zilliz', lines: ['共享知识与个人记忆分别索引', '携带归属和版本，可从正式记录重建'], kind: 'store' },
  memory: { name: 'Mem0 个人记忆', type: 'Container', tech: 'Python / Mem0 OSS 2.2.1', lines: ['从原始消息提取候选、检索记忆', 'SQLite 保存 SDK 历史与技术回执'], kind: 'app' },
  models: { name: '模型能力', type: 'Model APIs', tech: 'DeepSeek Flash · 百炼 Qwen', lines: ['理解、生成与提取：DeepSeek Flash', '向量：qwen3.7-text-embedding', '共享知识与个人记忆分开建索引'], kind: 'integration' },
  platform: { name: '数据平台 / 查询引擎', type: 'External Software System', tech: '当前：可执行合成平台 / SQLite', lines: ['元数据、血缘、节点与加工 SQL', '独立数据权限、执行与结果', 'Datasight 后续经适配器接入'], kind: 'integration' },
};

const relations = {
  use: ['users', 'web', '使用', '浏览器'],
  'web-api': ['web', 'api', '请求 / 事件', 'HTTP · SSE'],
  run: ['api', 'pi', '启动 / 恢复 / 取消', '内部 HTTP · 事件流'],
  tools: ['pi', 'api', '受控工具', 'HTTP / JSON'],
  'session-store': ['pi', 'journal', '持久保存 / 恢复', 'Pi 原生文件 · fsync'],
  records: ['api', 'mysql', '正式记录 / 登记任务', 'SQL / TCP'],
  search: ['api', 'vector', '共享知识混合检索', 'Milvus REST API'],
  remember: ['api', 'memory', '原始消息提取 / 记忆检索', '内部 HTTP'],
  execute: ['api', 'platform', '用户确认后查询 / 权限与结果', '平台适配接口'],
  generate: ['pi', 'models', '模型推理', 'HTTPS / JSON'],
  'embed-query': ['api', 'models', '问题向量化', '百炼 Embedding'],
  'memory-model': ['memory', 'models', '提取 / 向量化', '取得逐调用预算许可后发送'],
  claim: ['worker', 'mysql', '领取任务 / 保存状态', 'SQL / TCP'],
  index: ['worker', 'vector', '共享知识索引更新', 'Milvus REST API'],
  sync: ['worker', 'platform', '读取元数据、血缘、节点 SQL / 跟踪查询', '平台适配接口'],
  prefill: ['worker', 'models', '语义预填 / 内容向量化', '模型与 Embedding 接口'],
  'memory-index': ['memory', 'vector', '个人记忆索引写入 / 候选读取', 'Milvus SDK'],
  'commit-memory': ['worker', 'memory', '正式资产提交后的索引待办', '内部 HTTP'],
  'memory-budget': ['memory', 'api', '每次模型调用的许可与结算', 'M08 原请求预算'],
};

const views = [
  {
    id: 'overview', title: 'Data Agent · 定稿架构总览', subtitle: 'Pi SDK 负责 Agent；Mem0 负责个人记忆；Rust 负责业务约束与正式状态。', height: 1490,
    boundaryPath: 'M275 175 H1200 V570 H1870 V1350 H460 V960 H275 Z',
    boundaryBoxes: [[275, 175, 925, 785], [460, 570, 1410, 780]],
    places: { users: [35, 265, 215, 170], web: [330, 250, 300, 200], api: [780, 235, 350, 230], models: [1480, 235, 370, 230], worker: [330, 665, 330, 200], pi: [780, 665, 350, 200], memory: [1350, 665, 390, 230], platform: [35, 1080, 370, 230], mysql: [510, 1110, 350, 190], journal: [985, 1110, 350, 190], vector: [1460, 1110, 390, 200] },
    edges: [
      ['use', [[250, 345], [330, 345]], [290, 311], ['使用']],
      ['web-api', [[630, 345], [780, 345]], [705, 309], ['请求 / 事件']],
      ['run', [[935, 465], [935, 665]], [925, 539], ['启动 / 恢复 / 取消']],
      ['tools', [[1100, 665], [1100, 465]], [1100, 582], ['受控工具']],
      ['generate', [[1130, 725], [1250, 725], [1250, 330], [1480, 330]], [1360, 308], ['模型推理']],
      ['remember', [[1130, 435], [1340, 435], [1340, 580], [1530, 580], [1530, 665]], [1480, 551], ['提取 / 检索个人记忆']],
      ['memory-model', [[1720, 665], [1720, 465]], [1740, 541], ['提取 / 向量化']],
      ['records', [[780, 435], [730, 435], [730, 995], [685, 995], [685, 1110]], [705, 1054], ['保存正式记录']],
      ['execute', [[780, 390], [710, 390], [710, 515], [120, 515], [120, 1080]], [455, 500], ['用户确认后查询 / 权限与结果']],
      ['claim', [[495, 865], [495, 1020], [585, 1020], [585, 1110]], [514, 990], ['任务 / 状态']],
      ['sync', [[330, 775], [200, 775], [200, 1080]], [200, 952], ['资料 / 查询状态']],
      ['commit-memory', [[660, 805], [710, 805], [710, 940], [1395, 940], [1395, 895]], [1055, 920], ['正式资产提交后的索引待办']],
      ['session-store', [[955, 865], [955, 1020], [1160, 1020], [1160, 1110]], [1160, 1060], ['Pi 原生会话']],
      ['memory-index', [[1740, 825], [1880, 825], [1880, 1010], [1660, 1010], [1660, 1110]], [1680, 986], ['个人记忆索引']],
      ['search', [[1130, 450], [1220, 450], [1220, 960], [1420, 960], [1420, 1220], [1460, 1220]], [1430, 1060], ['共享语义检索']],
    ],
    footer: '当前视图显示全部组件与主要关系；完整 19 条关系见后续详图。共享语义与个人记忆均使用 Qwen 1024 维独立索引。',
  },
  {
    id: 'runtime', title: '工作台与 Agent', subtitle: '同一对话持续多轮；Pi 负责调查，Rust 保存可核对的业务状态。', height: 900,
    boundary: [275, 130, 1200, 665],
    places: { users: [35, 275, 215, 170], web: [310, 250, 260, 200], api: [670, 235, 330, 230], pi: [1110, 250, 320, 200], models: [1545, 250, 340, 230], mysql: [670, 585, 330, 185], journal: [1110, 585, 345, 185] },
    edges: [
      ['use', [[250, 355], [310, 355]], [280, 315]],
      ['web-api', [[570, 355], [670, 355]], [620, 311]],
      ['run', [[900, 235], [900, 180], [1190, 180], [1190, 250]], [1060, 158]],
      ['tools', [[1110, 395], [1000, 395]], [1055, 346]],
      ['generate', [[1430, 355], [1545, 355]], [1487, 311]],
      ['records', [[835, 465], [835, 585]], [835, 515]],
      ['session-store', [[1280, 450], [1280, 585]], [1280, 515]],
    ],
    note: ['SQL 先展示，确认后执行。', '执行前可补充或纠正条件。', '数据库与 Pi 会话文件一同保留。'],
    noteAt: [310, 605],
  },
  {
    id: 'knowledge', title: '共享语义、检索与查询', subtitle: '系统语义维护与 Datasight 查询权限独立；事实、建议、人工值分开保存，检索命中回源核对。', height: 1050,
    boundary: [35, 225, 1125, 720],
    places: { api: [80, 265, 330, 230], vector: [750, 265, 360, 200], models: [1470, 265, 370, 230], worker: [80, 690, 330, 200], mysql: [750, 690, 360, 200], platform: [1470, 690, 370, 230] },
    edges: [
      ['search', [[410, 355], [750, 355]], [580, 320]],
      ['embed-query', [[270, 265], [270, 175], [1655, 175], [1655, 265]], [965, 154]],
      ['execute', [[410, 475], [1250, 475], [1250, 755], [1470, 755]], [1270, 646]],
      ['claim', [[410, 800], [750, 800]], [580, 760]],
      ['index', [[410, 715], [560, 715], [560, 425], [750, 425]], [560, 619]],
      ['sync', [[245, 890], [245, 975], [1655, 975], [1655, 920]], [950, 959]],
      ['prefill', [[245, 690], [245, 550], [1370, 550], [1370, 420], [1470, 420]], [942, 527]],
    ],
    footer: '表负责人同步自平台；指标与文档由创建者负责。建议接受后编辑保存，详见 F02；语义角色不授予查询权。',
  },
  {
    id: 'memory', title: '个人记忆的提取与采用', subtitle: 'Mem0 先提取候选；Rust 校验并正式保存后，Worker 提交可检索版本。', height: 1030,
    boundaryPath: 'M35 225 H1165 V620 H1870 V935 H35 Z',
    places: { api: [80, 265, 330, 230], memory: [750, 265, 360, 230], models: [1470, 265, 370, 230], worker: [80, 700, 330, 200], mysql: [750, 700, 360, 200], vector: [1470, 700, 370, 200] },
    edges: [
      ['remember', [[410, 345], [750, 345]], [580, 308]],
      ['memory-budget', [[750, 445], [410, 445]], [580, 408]],
      ['memory-model', [[1110, 365], [1470, 365]], [1290, 328]],
      ['memory-index', [[1010, 495], [1010, 570], [1655, 570], [1655, 700]], [1350, 548]],
      ['commit-memory', [[410, 740], [555, 740], [555, 565], [840, 565], [840, 495]], [688, 542]],
      ['records', [[245, 495], [245, 650], [930, 650], [930, 700]], [816, 628]],
      ['claim', [[410, 825], [750, 825]], [580, 783]],
    ],
    footer: '正式正文、归属、启停与版本以 MySQL 为准；个人纠错不自动变为公共口径，采用前再次回源核对。',
  },
];

const W = 1920;
const palette = {
  app: ['#f1f6ff', '#3866ac', '#172e50'], store: ['#eef7f3', '#438471', '#173e34'],
  integration: ['#f7f5f0', '#9a8050', '#4b402c'], person: ['#203a5d', '#203a5d', '#ffffff'],
};
const esc = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll('\n', '&#xa;');
const text = (x, y, value, size = 18, weight = 400, color = '#33475e', anchor = 'start', extra = '') => `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}" ${extra}>${esc(value)}</text>`;
const pathFor = (points) => points.map((p, i) => `${i ? 'L' : 'M'}${p.join(' ')}`).join(' ');

function node(id, box) {
  const n = nodes[id], [x, y, w, h] = box, [fill, border, ink] = palette[n.kind];
  const muted = n.kind === 'person' ? '#d4e2f3' : '#53677d';
  return `<g class="node" data-node="${id}">
    <rect class="node-box" x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${fill}" stroke="${border}" stroke-width="1.4"/>
    <path d="M${x + 18} ${y} H${x + w - 18}" stroke="${border}" stroke-width="4"/>
    ${text(x + 22, y + 28, n.type, 14, 500, muted)}
    ${text(x + 22, y + 62, n.name, 25, 650, ink)}
    ${text(x + 22, y + 90, n.tech, n.kind === 'person' ? 12 : 16, 500, muted)}
    ${n.lines.map((line, i) => text(x + 22, y + 128 + i * 28, line, 18, 400, ink)).join('')}
  </g>`;
}

function edge([id, points], viewId) {
  const [from, to] = relations[id], d = pathFor(points);
  // 连线交叉处用白色底线留出间隙，避免被读成分支连接。
  return `<g class="relationship" data-edge="${id}" data-source="${from}" data-target="${to}"><path d="${d}" fill="none" stroke="white" stroke-width="8"/><path d="${d}" fill="none" stroke="#718297" stroke-width="2" stroke-linejoin="round" marker-end="url(#arrow-${viewId})"/></g>`;
}

function label([id, , at, shortLines]) {
  return `<g class="edge-label" data-edge="${id}">${(shortLines ?? relations[id].slice(2)).map((line, i) => text(at[0], at[1] + i * 22, line, i ? 15 : 17, i ? 400 : 500, i ? '#607086' : '#33475e', 'middle', 'paint-order="stroke" stroke="white" stroke-width="8" stroke-linejoin="round"')).join('')}</g>`;
}

function content(v, index) {
  const boundary = v.boundary ? `<rect x="${v.boundary[0]}" y="${v.boundary[1]}" width="${v.boundary[2]}" height="${v.boundary[3]}" rx="16"/>` : `<path d="${v.boundaryPath}"/>`;
  const bx = v.boundary?.[0] ?? v.boundaryBoxes?.[0][0] ?? 35, by = v.boundary?.[1] ?? v.boundaryBoxes?.[0][1] ?? 225;
  return `<g class="view" data-view="${v.id}" font-family="Arial, PingFang SC, Microsoft YaHei, sans-serif">
    <defs><marker id="arrow-${v.id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10Z" fill="#718297"/></marker></defs>
    <rect width="${W}" height="${v.height}" fill="white"/>
    ${text(35, 38, `DATA AGENT  /  C4 CONTAINER  /  ${String(index + 1).padStart(2, '0')}`, 14, 600, '#577395')}
    ${text(35, 82, v.title, 34, 650, '#172e50')}
    ${text(35, 112, v.subtitle, 19, 400, '#607086')}
    ${text(1885, 38, '2026-10-07 · 当前实现 / 合成平台', 15, 500, '#607086', 'end')}
    <g class="boundary" fill="none" stroke="#c0cddd" stroke-width="1.5" stroke-dasharray="7 6">${boundary}</g>
    ${text(bx + 20, by + 23, 'Data Agent · 系统边界（仅显示本视图相关组件）', 14, 500, '#718297')}
    ${v.edges.map(e => edge(e, v.id)).join('')}
    ${Object.entries(v.places).map(([id, box]) => node(id, box)).join('')}
    ${v.edges.map(label).join('')}
    ${v.note ? v.note.map((line, i) => text(v.noteAt[0], v.noteAt[1] + i * 36, line, 17)).join('') : ''}
    <line x1="35" y1="${v.height - 58}" x2="1885" y2="${v.height - 58}" stroke="#dde5ee"/>
    ${text(35, v.height - 29, v.footer ?? '箭头表示调用方向，返回值省略。蓝色：应用进程；绿色：存储；米色：模型或平台能力。Container 不等同于微服务。', 17, 400, '#607086')}
  </g>`;
}

function svg(selected) {
  const height = selected.reduce((sum, v) => sum + v.height, 0);
  let offset = 0;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" role="img" aria-labelledby="title description"><title id="title">Data Agent 软件架构 · ${selected.length === 1 ? selected[0].title : 'C4 容器视图'}</title><desc id="description">定稿架构由总览和工作台与 Agent、共享语义与查询、个人记忆三张详图呈现；共享语义与个人记忆使用百炼 Qwen 1024 维独立索引。组件、调用方向与职责不随视图变化。MySQL 保存正式状态，Pi 是唯一 Agent 循环，Mem0 处理个人记忆，Milvus 是可重建索引。</desc>${selected.map(v => { const group = `<g transform="translate(0 ${offset})">${content(v, views.indexOf(v))}</g>`; offset += v.height; return group; }).join('')}</svg>\n`;
}

function drawio() {
  return `<?xml version="1.0" encoding="UTF-8"?><mxfile host="app.diagrams.net">${views.map((v, index) => {
    const cells = ['<mxCell id="0"/><mxCell id="1" parent="0"/>'];
    const add = (id, value, style, box) => cells.push(`<mxCell id="${id}" value="${esc(value)}" style="${style}" vertex="1" parent="1"><mxGeometry x="${box[0]}" y="${box[1]}" width="${box[2]}" height="${box[3]}" as="geometry"/></mxCell>`);
    add('heading', `${index + 1}. ${v.title}\n${v.subtitle}`, 'text;html=0;align=left;fontSize=24;fontFamily=PingFang SC;', [35, 40, 1750, 70]);
    const boundaryStyle = 'rounded=1;dashed=1;fillColor=none;strokeColor=#c0cddd;verticalAlign=top;align=left;spacing=14;fontSize=14;';
    if (v.boundaryBoxes) v.boundaryBoxes.forEach((box, i) => add(`boundary-${i}`, 'Data Agent · 同一系统边界', boundaryStyle, box));
    else if (v.boundary) add('boundary', 'Data Agent · 系统边界', boundaryStyle, v.boundary);
    else {
      add('boundary', 'Data Agent · 系统边界', boundaryStyle, [35, 225, 1130, 710]);
      add('storage-boundary', 'Data Agent · 同系统索引', boundaryStyle, [1435, 635, 435, 300]);
    }
    for (const [id, box] of Object.entries(v.places)) {
      const n = nodes[id], [fill, border, ink] = palette[n.kind];
      add(id, [n.name, `[${n.type}]`, n.tech, '', ...n.lines].join('\n'), `rounded=1;arcSize=6;whiteSpace=wrap;html=0;fillColor=${fill};strokeColor=${border};fontColor=${ink};fontSize=18;fontFamily=PingFang SC;align=left;spacing=20;`, box);
    }
    for (const [id, points, at, shortLines] of v.edges) {
      const [from, to] = relations[id], lines = shortLines ?? relations[id].slice(2), a = v.places[from], b = v.places[to], start = points[0], end = points.at(-1);
      const ports = `exitX=${(start[0] - a[0]) / a[2]};exitY=${(start[1] - a[1]) / a[3]};entryX=${(end[0] - b[0]) / b[2]};entryY=${(end[1] - b[1]) / b[3]};`;
      cells.push(`<mxCell id="rel-${id}" style="edgeStyle=segmentEdgeStyle;rounded=0;jumpStyle=arc;endArrow=block;strokeColor=#718297;strokeWidth=2;${ports}" edge="1" parent="1" source="${from}" target="${to}"><mxGeometry relative="1" as="geometry"><Array as="points">${points.slice(1, -1).map(p => `<mxPoint x="${p[0]}" y="${p[1]}"/>`).join('')}</Array></mxGeometry></mxCell>`);
      const labelWidth = Math.max(...lines.map(line => [...line].reduce((sum, char) => sum + (char.charCodeAt(0) > 255 ? 16 : 8.5), 0))) + 12;
      add(`label-${id}`, lines.join('\n'), 'text;html=0;align=center;fontSize=16;fontColor=#33475e;fillColor=#ffffff;fontFamily=PingFang SC;', [at[0] - labelWidth / 2, at[1] - 18, labelWidth, 44]);
    }
    add('footer', v.footer ?? '统一交付。Pi 负责 Agent 循环，Rust 负责业务约束；MySQL 与原生 JSONL 共同保留。', 'text;html=0;align=left;fontSize=17;fontColor=#607086;fontFamily=PingFang SC;', [35, v.height - 52, 1830, 42]);
    return `<diagram id="${v.id}" name="${esc(v.title)}"><mxGraphModel grid="1" gridSize="10" page="1" pageScale="1" pageWidth="${W}" pageHeight="${v.height}"><root>${cells.join('')}</root></mxGraphModel></diagram>`;
  }).join('')}</mxfile>\n`;
}

async function main() {
  const ids = new Set(views.flatMap(v => v.edges.map(e => e[0])));
  if (Object.keys(relations).some(id => !ids.has(id))) throw new Error('架构关系未完整覆盖');
  for (const v of views) for (const [id] of v.edges) {
    if (!relations[id] || relations[id].slice(0, 2).some(nodeId => !v.places[nodeId])) throw new Error(`无效关系：${v.id}/${id}`);
  }
  await fs.writeFile(path.join(__dirname, 'data-agent-c4-container.drawio'), drawio());
  const browser = await chromium.launch({ headless: true });
  const report = { nodes: Object.keys(nodes).length, edges: ids.size, views: [], issues: [] };
  try {
    const exports = [...views.map(v => ({ name: `data-agent-${v.id}`, selected: [v] })), { name: 'data-agent-c4-container', selected: views }];
    for (const item of exports) {
      const base = path.join(__dirname, item.name), height = item.selected.reduce((sum, v) => sum + v.height, 0);
      await fs.writeFile(base + '.svg', svg(item.selected).replace(/^[\t ]+$/gm, ''));
      const page = await browser.newPage({ viewport: { width: W, height }, deviceScaleFactor: 1 });
      await page.route(/^https?:/, route => route.abort());
      await page.goto(pathToFileURL(base + '.svg').href);
      await page.evaluate(() => document.fonts.ready);
      const issues = await page.locator('svg').evaluate(root => {
        const issues = [];
        const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
        for (const view of root.querySelectorAll('.view')) {
          const box = view.querySelector('rect').getBBox();
          for (const t of view.querySelectorAll('text')) {
            const b = t.getBBox();
            if (b.x < 0 || b.y < 0 || b.x + b.width > box.width || b.y + b.height > box.height) issues.push({ view: view.dataset.view, type: 'canvas-overflow', text: t.textContent });
          }
          const labels = [...view.querySelectorAll('.edge-label')];
          for (const n of view.querySelectorAll('.node')) {
            const r = n.querySelector('.node-box').getBBox();
            for (const t of n.querySelectorAll('text')) {
              const b = t.getBBox();
              if (b.x < r.x + 6 || b.x + b.width > r.x + r.width - 6 || b.y < r.y || b.y + b.height > r.y + r.height - 6) issues.push({ view: view.dataset.view, type: 'node-overflow', node: n.dataset.node, text: t.textContent });
            }
            for (const l of labels) if (overlaps(l.getBBox(), r)) issues.push({ view: view.dataset.view, type: 'label-on-node', edge: l.dataset.edge, node: n.dataset.node });
          }
          for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) if (overlaps(labels[i].getBBox(), labels[j].getBBox())) issues.push({ view: view.dataset.view, type: 'label-overlap', edges: [labels[i].dataset.edge, labels[j].dataset.edge] });
        }
        return issues;
      });
      await page.locator('svg').screenshot({ path: base + '.png' });
      report.views.push({ file: item.name, width: W, height, issues });
      report.issues.push(...issues);
      await page.close();
    }
    await fs.writeFile(path.join(__dirname, 'diagram-checks.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    if (report.issues.length) process.exitCode = 1;
  } finally { await browser.close(); }
}

module.exports = { nodes, relations, views };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });

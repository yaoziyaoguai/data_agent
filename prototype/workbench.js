/* 全虚构前端演示。查询使用固定样例计算，不执行 SQL、不调用模型。 */
(() => {
  'use strict';
  const PREFIX = 'data-agent-system-prototype-v1-workbench-';
  const fixture = window.workbenchFixture;
  const users = new Map();
  const timers = new Map();
  const metricNames = {net: '净收入', customer: '支付客户数', refund: '退款率'};
  const channelNames = {all: '全部渠道', web: '网页 web', app: '应用 app', store: '门店 store'};
  const statusNames = {clarifying: '待补充', draft: '待确认 SQL', running: '查询中', completed: '已完成', cancelled: '已取消'};
  let host, callbacks = {}, userId = 'analyst-a', state, warning = '', mobilePane = 'chat';
  const threadPositions = new Map();
  const clone = value => JSON.parse(JSON.stringify(value));
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const id = prefix => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  const now = () => new Date().toISOString();
  const conversation = () => state.conversations.find(c => c.id === state.activeConversationId);
  const task = () => conversation()?.tasks.find(t => t.id === state.activeTaskId);
  const allQueries = db => db.conversations.flatMap(c => c.tasks.flatMap(t => t.queries));

  function load(uid) {
    if (users.has(uid)) return users.get(uid);
    let saved;
    try { saved = JSON.parse(localStorage.getItem(PREFIX + uid) || 'null'); } catch (_) { warning = '本机对话记录未能读取，本次从新对话开始。'; }
    const db = saved?.version === 1 && Array.isArray(saved.conversations) ? saved : {version: 1, conversations: [], activeConversationId: null, activeTaskId: null, viewVersion: null, viewQueryId: null};
    // 旧版只有一个输入草稿，将它归还给当时的活动对话。
    const active = db.conversations.find(c => c.id === db.activeConversationId);
    if (active && typeof active.composer !== 'string') active.composer = db.composer || '';
    delete db.composer;
    users.set(uid, db);
    return db;
  }
  function persist(db = state, uid = userId) {
    try { localStorage.setItem(PREFIX + uid, JSON.stringify(db)); }
    catch (_) { warning = '浏览器未能保存记录；刷新后可能丢失本次修改。'; }
  }
  function changed(scroll = false) {
    persist(); render(scroll); callbacks.onChange?.();
  }
  function addMessage(c, role, text, extra = {}) {
    c.messages.push({id: id('message'), role, text, createdAt: now(), ...extra});
    c.updatedAt = now();
  }
  function newConversation() {
    mobilePane = 'chat';
    const current = conversation();
    const empty = state.conversations.find(c => !c.messages.length && !c.composer?.trim());
    const c = current && !current.messages.length && !current.composer?.trim() ? current : empty || {id: id('conversation'), title: '新对话', createdAt: now(), updatedAt: now(), messages: [], tasks: [], selectedSkill: null, composer: ''};
    if (!state.conversations.includes(c)) state.conversations.push(c);
    Object.assign(state, {activeConversationId: c.id, activeTaskId: null, viewVersion: null, viewQueryId: null});
    changed(true);
    return c.id;
  }
  function conditionsText(c) {
    return `${c.month} · ${channelNames[c.channel]} · ${c.groupBy === 'channel' ? '按渠道分组' : '总体'} · ${c.testMode === 'only' ? '仅测试交易' : c.testMode === 'include' ? '包含测试交易' : '排除测试交易'}${c.metric === 'refund' ? ` · ${c.denominator ? {order: '订单分母', amount: '金额分母', customer: '客户分母'}[c.denominator] : '退款分母待明确'}` : ''}`;
  }
  function titleFor(c) {
    return `${c.month} ${c.metric === 'refund' && c.denominator ? {order: '订单退款率', amount: '金额退款比例', customer: '客户退款率'}[c.denominator] : metricNames[c.metric]}`;
  }
  function bounds(c) {
    const [year, month] = c.month.split('-').map(Number);
    const end = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
    return [`${c.month}-01T00:00:00Z`, `${end}-01T00:00:00Z`];
  }
  function expression(c) {
    if (c.metric === 'net') return ['SUM(paid_amount_cents - refunded_amount_cents)', 'net_revenue_cents', '净收入（分）'];
    if (c.metric === 'customer') return ['COUNT(DISTINCT customer_id)', 'paid_customer_uv', '已知支付客户数'];
    if (c.denominator === 'amount') return ['1.0 * SUM(refunded_amount_cents) / NULLIF(SUM(paid_amount_cents), 0)', 'refund_rate', '金额退款比例（0–1）'];
    const key = c.denominator === 'customer' ? 'customer_id' : 'order_id';
    return [`1.0 * COUNT(DISTINCT CASE WHEN refunded_amount_cents > 0 THEN ${key} END) / NULLIF(COUNT(DISTINCT ${key}), 0)`, 'refund_rate', c.denominator === 'customer' ? '客户退款率（0–1）' : '订单退款率（0–1）'];
  }
  function sqlFor(c) {
    if (c.metric === 'refund' && !c.denominator) return '';
    const [start, end] = bounds(c), [expr, key] = expression(c);
    const group = c.groupBy === 'channel';
    return `SELECT\n  ${group ? 'channel,\n  ' : ''}${expr} AS ${key}\nFROM demo_order_detail\nWHERE paid_at >= '${start}'\n  AND paid_at < '${end}'${c.testMode === 'include' ? '' : `\n  AND is_test = ${c.testMode === 'only' ? 1 : 0}`}${c.channel === 'all' ? '' : `\n  AND channel = '${c.channel}'`}${group ? '\nGROUP BY channel\nORDER BY channel' : ''};`;
  }
  function calculate(c) {
    const [start, end] = bounds(c);
    const data = fixture.rows.filter(r => r.paid_at && r.paid_at >= start && r.paid_at < end && (c.testMode === 'include' || r.is_test === (c.testMode === 'only' ? 1 : 0)) && (c.channel === 'all' || r.channel === c.channel));
    const [unused, key, label] = expression(c);
    const groups = c.groupBy === 'channel' ? [...new Set(data.map(r => r.channel))].sort().map(channel => [channel, data.filter(r => r.channel === channel)]) : [[null, data]];
    const unique = (rs, field) => new Set(rs.map(r => r[field]).filter(v => v !== null && v !== undefined)).size;
    const sum = (rs, field) => rs.reduce((n, r) => n + r[field], 0);
    const rows = groups.map(([channel, rs]) => {
      let value;
      if (c.metric === 'net') value = rs.length ? sum(rs, 'paid_amount_cents') - sum(rs, 'refunded_amount_cents') : null;
      else if (c.metric === 'customer') value = unique(rs, 'customer_id');
      else if (c.denominator === 'amount') { const denom = sum(rs, 'paid_amount_cents'); value = denom ? sum(rs, 'refunded_amount_cents') / denom : null; }
      else { const field = c.denominator === 'customer' ? 'customer_id' : 'order_id', denom = unique(rs, field); value = denom ? unique(rs.filter(r => r.refunded_amount_cents > 0), field) / denom : null; }
      return {...(c.groupBy === 'channel' ? {channel} : {}), [key]: value};
    });
    return {columns: [...(c.groupBy === 'channel' ? [{key: 'channel', label: '渠道'}] : []), {key, label}], rows, matchedRows: data.length};
  }
  function resultSummary(q) {
    const c = q.conditions, key = q.columns.at(-1).key;
    const format = value => value === null ? '无可计算值' : c.metric === 'net'
      ? `${(value / 100).toLocaleString('zh-CN', {minimumFractionDigits: 2, maximumFractionDigits: 2})} 元`
      : c.metric === 'customer' ? `${value} 位` : `${(value * 100).toFixed(1)}%`;
    if (!q.rows.length) return '当前条件没有匹配记录，无法据此判断业务增长或下降。';
    const values = q.rows.map(r => `${c.groupBy ? `${r.channel}：` : `${titleFor(c)}为 `}${format(r[key])}`).join('；');
    const rule = c.metric === 'net' ? '已扣除截至快照的退款，退款计回原支付月份。'
      : c.metric === 'customer' ? `已在整个区间按客户去重，匿名订单不计入。${c.groupBy ? '同一客户可能出现在多个渠道，渠道客户数不能直接相加。' : ''}`
      : `采用${{order: '发生退款的订单数 / 支付订单数', amount: '累计退款金额 / 支付金额', customer: '发生退款的已知客户数 / 已知支付客户数'}[c.denominator]}。${c.groupBy ? '总体比例需重算分子和分母，不能直接平均渠道比例。' : ''}`;
    return `${values}。${rule}${c.month === '2026-02' ? '2 月数据只到 4 日零点，未覆盖整月。' : ''}`;
  }
  function draft(t) {
    t.sql = sqlFor(t.conditions);
    t.status = t.sql ? 'draft' : 'clarifying';
    t.title = titleFor(t.conditions);
    t.drafts.push({version: t.version, sql: t.sql, conditions: clone(t.conditions), skill: clone(t.skill), createdAt: now()});
    state.viewVersion = t.version; state.viewQueryId = null;
  }
  function makeTask(c, conditions) {
    const t = {id: id('task'), title: '', conditions, version: 1, drafts: [], queries: [], status: 'draft', skill: clone(c.selectedSkill)};
    c.tasks.push(t); state.activeTaskId = t.id; draft(t);
    return t;
  }
  function draftMessage(c, t, revised = false) {
    if (t.status === 'clarifying') addMessage(c, 'assistant', '“退款率”有几种常见算法。你希望用什么作分母？月份、渠道和测试交易范围已保留。', {kind: 'clarify', taskId: t.id, version: t.version});
    else addMessage(c, 'assistant', `${revised ? '已更新条件，生成新的 SQL。' : '我会按支付时间统计，并使用表中的业务口径。'}${t.conditions.metric === 'net' ? '退款按截至快照的累计值扣回原支付月份。' : t.conditions.metric === 'customer' ? '客户在整个区间重新去重，匿名客户不计 UV。' : '分子与分母已写入 SQL。'}请查看 SQL v${t.version}，确认后再查询。`, {kind: 'draft', taskId: t.id, version: t.version});
  }
  function parse(text, current) {
    if (/按地区|分地区|按商品|利润|毛利|成本|税费|现金流|退款流水|退货件数|净售出|上月|下月|去年|今年|今天|昨天|最近|近\d|标签|\bvip\b|大于|小于/i.test(text)) return {unsupported: true};
    const hasRefund = /退款率|退款比例|退款金额.*支付金额/.test(text);
    let metric = hasRefund ? 'refund' : /支付客户|客户数|客户\s*uv|\buv\b|去重客户/i.test(text) ? 'customer' : /净收入|净额|收入/.test(text) ? 'net' : null;
    const patch = {};
    const date = text.match(/(?:(20\d{2})\s*年\s*)?(\d{1,2})\s*月/) || text.match(/(20\d{2})-(\d{2})(?!\d)/);
    if (date) {
      if (+date[2] < 1 || +date[2] > 12) return {unsupported: true};
      patch.month = `${date[1] || current?.month?.slice(0, 4) || '2026'}-${String(+date[2]).padStart(2, '0')}`;
    }
    if (/全部渠道|所有渠道|不限渠道|取消渠道|全渠道/.test(text)) patch.channel = 'all';
    else if (/\bweb\b|网页/i.test(text)) patch.channel = 'web';
    else if (/\bapp\b|应用/i.test(text)) patch.channel = 'app';
    else if (/\bstore\b|门店/i.test(text)) patch.channel = 'store';
    if (/按渠道|分渠道/.test(text)) patch.groupBy = 'channel';
    if (/不分组|取消分组|看总体|看合计/.test(text)) patch.groupBy = null;
    if (/排除测试|不含测试|不包含测试|去掉测试|非测试/.test(text)) patch.testMode = 'exclude';
    else if (/只看测试|仅测试|仅看测试|只统计测试/.test(text)) patch.testMode = 'only';
    else if (/包含测试|含测试|保留测试|全部交易/.test(text)) patch.testMode = 'include';
    if (/按订单|订单退款率|订单数.*分母|分母.*订单|订单口径/.test(text)) patch.denominator = 'order';
    else if (/按金额|金额退款|退款金额.*支付金额|金额.*分母|分母.*金额|金额口径/.test(text)) patch.denominator = 'amount';
    else if (/按客户|客户退款|客户数.*分母|分母.*客户|客户口径/.test(text)) patch.denominator = 'customer';
    if (current?.metric === 'refund' && patch.denominator && !hasRefund && !/净收入|净额|收入/.test(text)) metric = null;
    return {metric, patch, recognized: !!metric || Object.keys(patch).length > 0};
  }
  function memoryCorrection(c, text, original, target) {
    if (!callbacks.saveMemory) { addMessage(c, 'assistant', '已保留在当前对话中。个人记忆入口尚未连接。'); return; }
    try {
      const memoryId = callbacks.saveMemory({content: text, original, scope: /以后|默认|总是/.test(text) ? '当前用户的个人偏好；以本次明确要求为准' : '当前用户 · 零售支付分析；仅在相同口径适用', source: `会话 ${c.id}`, target});
      if (!memoryId || memoryId === false) { addMessage(c, 'assistant', '这条纠错已保留在对话中，尚未保存为个人记忆。'); return; }
      addMessage(c, 'assistant', memoryId.created === false ? '你的个人记忆中已有这条纠错，会在相同分析范围内参考。' : '已记为你的个人纠错，只在相同分析范围内参考；公共语义保持原定义。', {kind: 'memory', memoryId: typeof memoryId === 'object' ? memoryId.id : memoryId, memoryCreated: memoryId.created === true});
    } catch (_) { addMessage(c, 'assistant', '这条纠错已保留在对话中，个人记忆暂时未能保存。'); }
  }
  function submit(text) {
    text = String(text || '').trim();
    if (!text) return;
    const c = conversation() || (newConversation(), conversation());
    const previous = task();
    c.composer = '';
    addMessage(c, 'user', text);
    if (c.title === '新对话') c.title = text.length > 24 ? text.slice(0, 24) + '…' : text;
    if (/\buv\b|客户数|客户数去重/i.test(text) && /不能|不要|应当|应该/.test(text) && /相加|累加|去重/.test(text)) {
      addMessage(c, 'assistant', '对，月支付客户数应在整个月对 customer_id 重新去重，不能累加每日 UV。匿名客户不计入已知客户数。', {kind: 'evidence', target: 'customer'});
      if (!/仅本次|只在这次|只用于这次|不要记/.test(text)) memoryCorrection(c, text, '将每日支付客户 UV 相加作为整月支付客户 UV。', {tab: 'metrics', metric: 'paid_customer_uv'});
      changed(true); return;
    }
    const parsed = parse(text, previous?.conditions);
    if (parsed.unsupported || !parsed.recognized) {
      addMessage(c, 'assistant', '这版演示能处理净收入、支付客户数和退款率，也能修改明确月份、渠道、按渠道分组及测试交易范围。这个问题还不在支持范围内，我没有为它生成或执行 SQL。可以试试“2 月净收入，按渠道分组”。', {kind: 'unsupported'});
      changed(true); return;
    }
    const revise = previous && (!parsed.metric || /改成|改为|修改|纠正|更正|补充|不对|还是/.test(text));
    if (!previous && !parsed.metric) {
      addMessage(c, 'assistant', '范围已说明，还需要选择指标：净收入、支付客户数，或退款率。'); changed(true); return;
    }
    const defaults = {metric: 'net', month: '2026-01', channel: 'all', groupBy: null, testMode: 'exclude', denominator: null};
    const base = previous ? clone(previous.conditions) : defaults;
    const next = {...base, ...parsed.patch, metric: parsed.metric || base.metric};
    if (parsed.metric && parsed.metric !== base.metric && !parsed.patch.denominator) next.denominator = null;
    const original = previous ? conditionsText(previous.conditions) : '';
    let t;
    if (revise) { t = previous; t.version += 1; t.conditions = next; t.skill = clone(c.selectedSkill); draft(t); }
    else t = makeTask(c, next);
    draftMessage(c, t, revise);
    if (/记住|以后.*默认|默认.*以后/.test(text) && !/不要记|仅本次|只用于这次/.test(text)) memoryCorrection(c, text, original, {tab: 'metrics', metric: t.conditions.metric === 'net' ? 'net_revenue' : t.conditions.metric === 'customer' ? 'paid_customer_uv' : 'order_refund_rate'});
    changed(true);
  }
  function clarify(denominator, taskId) {
    const t = conversation()?.tasks.find(x => x.id === taskId);
    if (!t || t.status !== 'clarifying') return;
    state.activeTaskId = t.id;
    submit({order: '按订单数作分母', amount: '按金额作分母', customer: '按客户数作分母'}[denominator]);
  }
  function schedule(q, db, uid) {
    if (q.status !== 'running') return;
    const key = `${uid}:${q.id}`;
    if (timers.has(key)) return;
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      if (q.status !== 'running') return;
      const c = db.conversations.find(x => x.id === q.conversationId), t = c?.tasks.find(x => x.id === q.taskId);
      if (!t) return;
      q.result = calculate(q.conditions); q.rows = q.result.rows; q.columns = q.result.columns;
      q.status = 'completed'; q.completedAt = now();
      if (t.version === q.sqlVersion) t.status = 'completed';
      addMessage(c, 'assistant', `${resultSummary(q)}\n使用已确认的 SQL v${q.sqlVersion}，范围：${q.conditionSummary}。`, {kind: 'result', taskId: t.id, queryId: q.id, version: q.sqlVersion});
      persist(db, uid);
      if (uid === userId) { render(true); callbacks.onChange?.(); }
    }, Math.max(0, q.dueAt - Date.now())));
  }
  function confirm(taskId, version) {
    const c = conversation(), t = c?.tasks.find(x => x.id === taskId);
    if (!t || t.version !== +version || t.status !== 'draft' || !t.sql || t.queries.some(q => q.sqlVersion === +version)) return;
    const q = {id: id('query'), conversationId: c.id, taskId: t.id, title: t.title, status: 'running', sqlVersion: t.version, sql: t.sql, conditions: clone(t.conditions), conditionSummary: conditionsText(t.conditions), createdAt: now(), dueAt: Date.now() + 1500, skill: clone(t.skill), rows: null};
    t.queries.push(q); t.status = 'running';
    state.viewQueryId = q.id; state.viewVersion = q.sqlVersion;
    addMessage(c, 'assistant', `已按你确认的 SQL v${q.sqlVersion} 开始查询。可以继续问其他问题，结果会回到这项任务。`, {kind: 'running', taskId: t.id, queryId: q.id, version: q.sqlVersion});
    changed(true); schedule(q, state, userId);
  }
  function cancel(queryId) {
    const q = allQueries(state).find(x => x.id === queryId);
    if (!q || q.status !== 'running') return;
    q.status = 'cancelled'; q.cancelledAt = now();
    clearTimeout(timers.get(`${userId}:${q.id}`)); timers.delete(`${userId}:${q.id}`);
    const c = state.conversations.find(x => x.id === q.conversationId), t = c.tasks.find(x => x.id === q.taskId);
    if (t.version === q.sqlVersion) t.status = 'cancelled';
    addMessage(c, 'assistant', `${q.title} 的查询已取消，SQL v${q.sqlVersion} 仍保留。重新查询需要生成新版本并再次确认。`, {kind: 'cancelled', taskId: t.id, queryId: q.id});
    changed(true);
  }
  function selected() {
    const t = task();
    if (!t) return {};
    const q = allQueries(state).find(x => x.id === state.viewQueryId && x.taskId === t.id);
    const version = q?.sqlVersion || state.viewVersion || t.version;
    const d = t.drafts.find(x => x.version === version) || t.drafts[t.drafts.length - 1];
    return {t, d, q: q || t.queries.find(x => x.sqlVersion === version)};
  }
  function openConversation(conversationId) {
    const c = state.conversations.find(x => x.id === conversationId);
    if (!c) return false;
    mobilePane = 'chat';
    Object.assign(state, {activeConversationId: c.id, activeTaskId: c.tasks.at(-1)?.id || null, viewVersion: null, viewQueryId: null});
    changed(true); return true;
  }
  function openQuery(queryId) {
    const q = allQueries(state).find(x => x.id === queryId);
    if (!q) return false;
    mobilePane = 'task';
    Object.assign(state, {activeConversationId: q.conversationId, activeTaskId: q.taskId, viewVersion: q.sqlVersion, viewQueryId: q.id});
    changed(true); return true;
  }
  function selectSkill(skill) {
    if (!skill?.id) return;
    const c = conversation() || (newConversation(), conversation());
    c.selectedSkill = clone({id: skill.id, name: skill.name, version: skill.version, steps: skill.steps});
    const t = task();
    if (t && ['draft', 'clarifying'].includes(t.status)) {
      t.skill = clone(c.selectedSkill);
      t.drafts[t.drafts.length - 1].skill = clone(t.skill);
    }
    addMessage(c, 'assistant', `已选用「${skill.name}」v${skill.version || 1}。本演示会展示步骤与使用记录；查询仍按你确认的条件和 SQL 执行。`, {kind: 'skill'});
    changed(true);
  }
  function invalidateSkill(skillId) {
    for (const c of state.conversations) {
      if (c.selectedSkill?.id === skillId) c.selectedSkill = null;
      for (const t of c.tasks) if (t.skill?.id === skillId && ['draft', 'clarifying'].includes(t.status)) { t.skill = null; t.drafts[t.drafts.length - 1].skill = null; }
    }
    changed();
  }
  function exportCSV(queryId) {
    const q = allQueries(state).find(x => x.id === queryId && x.status === 'completed');
    if (!q) return;
    const cell = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const text = [q.columns.map(c => cell(c.label)).join(','), ...q.rows.map(row => q.columns.map(c => cell(row[c.key])).join(','))].join('\r\n');
    const url = URL.createObjectURL(new Blob(['\uFEFF' + text], {type: 'text/csv;charset=utf-8'}));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `retail-${q.conditions.month}-${q.id}.csv`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  function evidence(metric) {
    const target = metric === 'customer' ? {tab: 'documents', document: 'customer-guide', section: 'dedup'} : metric === 'refund' ? {tab: 'documents', document: 'refund-rate-guide', section: 'order-rate'} : {tab: 'documents', document: 'money-guide', section: 'refund-scope'};
    callbacks.openKnowledge?.(target);
  }
  function button(action, text, attrs = '', extraClass = '') { return `<button class="wb-button ${extraClass}" data-wb-action="${action}" ${attrs}>${text}</button>`; }
  function messagesHTML(c) {
    return c.messages.map(m => {
      const t = c.tasks.find(x => x.id === m.taskId), old = t && m.version && t.version !== m.version;
      let actions = '';
      if (m.kind === 'clarify' && t?.status === 'clarifying' && !old) actions = `<div class="wb-options">${['order', 'amount', 'customer'].map(d => button('clarify', {order: '订单数（推荐）', amount: '支付金额', customer: '支付客户数'}[d], `data-wb-denominator="${d}" data-wb-task-id="${esc(t.id)}"`)).join('')}</div>`;
      if (m.kind === 'draft') actions = button('inspect', old ? `查看旧 SQL v${m.version}` : `查看 SQL v${m.version}`, `data-wb-task-id="${esc(m.taskId)}" data-wb-version="${m.version}"`) + (old ? '<span class="wb-muted">已被后续版本替代</span>' : '');
      if (['running', 'result', 'cancelled'].includes(m.kind)) actions = button('query', m.kind === 'result' ? '查看结果' : '查看查询', `data-wb-query-id="${esc(m.queryId)}"`);
      if (m.kind === 'evidence') actions = button('evidence', '查看计算依据', `data-wb-metric-kind="${esc(m.target)}"`);
      if (m.kind === 'memory' && m.memoryId) actions = button('memory', '查看个人记忆', `data-wb-memory-id="${esc(m.memoryId)}"`) + (m.memoryCreated && !m.undone ? button('undo-memory', '撤销本次记忆', `data-wb-memory-id="${esc(m.memoryId)}" data-wb-message-id="${esc(m.id)}"`) : (m.undone ? '<span class="wb-muted">已撤销记忆，对话仍保留</span>' : ''));
      return `<article class="wb-message wb-message-${m.role}" data-wb-message="${esc(m.id)}"><div class="wb-speaker">${m.role === 'user' ? '你' : 'Data Agent'}</div><p>${esc(m.text)}</p>${actions ? `<div class="wb-message-actions">${actions}</div>` : ''}</article>`;
    }).join('');
  }
  function resultHTML(q) {
    const valueColumn = q.columns.at(-1), values = q.rows.map(r => r[valueColumn.key]).filter(v => v !== null), max = Math.max(...values.map(Math.abs), 0);
    const value = v => v === null ? 'NULL' : typeof v === 'number' && !Number.isInteger(v) ? String(Math.round(v * 10000) / 10000) : String(v);
    const one = q.rows.length === 1 && !q.conditions.groupBy;
    const raw = one ? q.rows[0][valueColumn.key] : null;
    const big = raw === null ? '暂无可计算值' : q.conditions.metric === 'net' ? (raw / 100).toLocaleString('zh-CN', {minimumFractionDigits:2,maximumFractionDigits:2}) : q.conditions.metric === 'refund' ? `${(raw * 100).toFixed(1)}` : String(raw);
    const unit = raw === null ? '' : q.conditions.metric === 'net' ? '元' : q.conditions.metric === 'refund' ? '%' : '位';
    return `<section class="wb-result" data-wb-result="${esc(q.id)}"><div class="wb-section-top"><h3>查询结果</h3><span class="wb-complete-mark">已完成 · v${q.sqlVersion}</span></div>${one ? `<div class="wb-number"><strong>${esc(big)}</strong><span>${unit}</span></div><p class="wb-result-label">${esc(metricNames[q.conditions.metric])}${q.conditions.metric === 'refund' ? ' · ' + {order:'按订单',amount:'按金额',customer:'按客户'}[q.conditions.denominator] : ''}</p>` : ''}<div class="wb-table-wrap"><table class="wb-table"><thead><tr>${q.columns.map(c => `<th>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${q.rows.length ? q.rows.map(r => `<tr>${q.columns.map(c => `<td>${esc(value(r[c.key]))}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${q.columns.length}">此范围没有符合条件的记录</td></tr>`}</tbody></table></div>${!one && q.rows.length ? `<div class="wb-chart" aria-label="${esc(valueColumn.label)}的柱形图">${q.rows.map(r => `<div class="wb-bar-row"><span>${esc(r.channel || '总体')}</span><div class="wb-bar-track"><i style="width:${r[valueColumn.key] === null || !max ? 0 : Math.abs(r[valueColumn.key]) / max * 100}%"></i></div><strong>${esc(value(r[valueColumn.key]))}</strong></div>`).join('')}</div>` : ''}<div class="wb-result-footer"><span>合成结果 · 完整 ${q.rows.length} 行</span>${button('csv', '导出 CSV', `data-wb-query-id="${esc(q.id)}"`)}</div><p class="wb-caption">${esc(q.conditionSummary)}。表格与导出单位一致${q.conditions.metric==='net'?'，原始金额为整数分':''}。</p><p class="wb-caption">数据截至 2026-02-04 00:00 UTC；2 月数据未覆盖整月。NULL 表示无可计算值。</p></section>`;
  }
  function sqlHTML(sql) {
    const tokens = /('(?:''|[^'])*'|\b(?:SELECT|FROM|WHERE|AND|AS|GROUP|BY|ORDER|CASE|WHEN|THEN|ELSE|END|SUM|COUNT|DISTINCT|NULLIF|NULL|IS|NOT|IN)\b|\b\d+(?:\.\d+)?\b)/gi;
    return sql.split(tokens).map(part => {
      if (/^'/.test(part)) return `<span class="wb-sql-string">${esc(part)}</span>`;
      if (/^\d/.test(part)) return `<span class="wb-sql-number">${esc(part)}</span>`;
      if (/^(SELECT|FROM|WHERE|AND|AS|GROUP|BY|ORDER|CASE|WHEN|THEN|ELSE|END|SUM|COUNT|DISTINCT|NULLIF|NULL|IS|NOT|IN)$/i.test(part)) return `<span class="wb-sql-keyword">${esc(part)}</span>`;
      return esc(part);
    }).join('');
  }
  function detailHTML() {
    const {t, d, q} = selected();
    if (!t) return `<aside class="wb-detail wb-detail-empty"><span class="wb-detail-mark">SQL</span><h2>每一步都可以查看</h2><p>提问后，这里展示条件、SQL、计算依据和结果。执行前可以随时补充或纠正。</p><div class="wb-empty-steps"><span>01 理解问题</span><span>02 确认 SQL</span><span>03 查看结果</span></div></aside>`;
    const old = d.version !== t.version, status = q?.status || (old ? '旧草稿' : statusNames[t.status]);
    const s = q?.skill || d.skill;
    let controls;
    if (old) controls = '<p class="wb-notice">这是历史版本。当前条件已更新，旧 SQL 不能再次确认执行。</p>' + (q?.status === 'running' ? button('cancel', '取消此版本查询', `data-wb-query-id="${esc(q.id)}"`) : '');
    else if (q?.status === 'running') controls = `<div class="wb-query-status"><span class="wb-running-dot"></span>查询中${button('cancel', '取消查询', `data-wb-query-id="${esc(q.id)}"`)}</div>`;
    else if (q?.status === 'cancelled') controls = `<p class="wb-notice">查询已取消。</p>${button('redraft', '生成新版本再确认', '', 'wb-primary')}`;
    else if (q?.status === 'completed') controls = '<p class="wb-success-note">已按这个版本完成查询。修改条件后需要重新确认。</p>';
    else if (!d.sql) controls = '<p class="wb-notice">先在对话里明确退款率分母，再生成 SQL。</p>';
    else controls = `${button('confirm', `确认并查询 · v${d.version}`, `data-wb-task-id="${esc(t.id)}" data-wb-version="${d.version}"`, 'wb-primary')}<p class="wb-caption">确认的是当前 SQL 与条件；任何修订都会生成新版本。</p>`;
    return `<aside class="wb-detail" data-wb-detail-task="${esc(t.id)}"><div class="wb-detail-heading"><div><span class="wb-eyebrow">当前分析任务</span><h2>${esc(titleFor(d.conditions))}</h2></div><span class="wb-status">${esc(statusNames[status] || status)}</span></div><label class="wb-select-label" ${conversation().tasks.length < 2 ? 'hidden' : ''}>切换任务<select data-wb-task-select>${conversation().tasks.map(x => `<option value="${esc(x.id)}" ${x.id === t.id ? 'selected' : ''}>${esc(x.title)} · ${esc(statusNames[x.status])}</option>`).join('')}</select></label>${conversation().tasks.length > 1 ? `<div class="wb-task-queue" aria-label="其他分析任务">${conversation().tasks.filter(x => x.id !== t.id).map(x => button('task', `${esc(x.title)} <span>${esc(statusNames[x.status])}</span>`, `data-wb-task-id="${esc(x.id)}"`)).join('')}</div>` : ''}<section class="wb-conditions"><div class="wb-section-top"><h3>分析条件</h3><span class="wb-muted">UTC · 支付时间</span></div><p>${esc(conditionsText(d.conditions))}</p><p class="wb-caption">${d.conditions.metric === 'net' ? '整数分；截至快照的退款归回原支付月。' : d.conditions.metric === 'customer' ? '整个区间去重；匿名客户不计 UV；全退客户仍属曾支付客户。' : '退款累计截至快照；订单、客户均去重，零分母返回 NULL。'}</p></section>${s ? `<section class="wb-skill"><div class="wb-section-top"><h3>已选 Skill</h3><span class="wb-muted">v${esc(s.version || 1)}</span></div><strong>${esc(s.name)}</strong><ol>${(Array.isArray(s.steps) ? s.steps : String(s.steps || '').split('\n')).filter(Boolean).map(step => `<li>${esc(typeof step === 'object' ? step.text || step.title || JSON.stringify(step) : step)}</li>`).join('')}</ol><p class="wb-caption">由你明确选用。本演示展示方法与记录，不执行自定义代码。</p></section>` : ''}${q?.status === 'completed' ? resultHTML(q) : ''}<details class="wb-sql" ${q?.status==='completed'?'':'open'}><summary>${q?.status==='completed'?'已执行 SQL':'SQL 预览'}<span>v${d.version}</span></summary><div class="wb-section-top"><h3>SQLite · 只读查询</h3><select aria-label="SQL 版本" data-wb-version-select>${t.drafts.map(x => `<option value="${x.version}" ${x.version === d.version ? 'selected' : ''}>v${x.version}${x.version === t.version ? ' · 当前' : ' · 历史'}</option>`).join('')}</select></div>${d.sql ? `<pre data-wb-sql><code>${sqlHTML(d.sql)}</code></pre>` : '<div class="wb-sql-placeholder">等待你补充一个计算条件</div>'}<div class="wb-query-controls">${controls}</div></details><section class="wb-evidence"><div class="wb-section-top"><h3>依据</h3><span class="wb-muted">3 项</span></div>${button('field-evidence', '支付时间 · paid_at')}${button('metric-evidence', `${esc(metricNames[d.conditions.metric])} · 计算定义`, `data-wb-metric-kind="${d.conditions.metric}"`)}${button('evidence', '业务说明 · 口径与适用范围', `data-wb-metric-kind="${d.conditions.metric}"`)}<p class="wb-caption">公开合成资料 · retail-synthetic-v1</p></section><div class="wb-bottom-actions">${button('choose-skill', '选用个人 Skill')}${button('save-skill', '保存为我的 Skill')}</div></aside>`;
  }
  function render(scroll = false) {
    if (!host || !state) return;
    const c = conversation(); if (!c) return;
    const previousThread = host.querySelector('.wb-thread');
    const previousId = host.querySelector('[data-wb-conversation]')?.dataset.wbConversation;
    if (previousThread?.offsetHeight && previousId) threadPositions.set(previousId, previousThread.scrollTop);
    const previousScroll = threadPositions.get(c.id) || 0;
    const previousDetail = host.querySelector('[data-wb-detail-task]');
    const detailScroll = previousDetail?.scrollTop || 0;
    const previousTaskId = previousDetail?.dataset.wbDetailTask;
    const inputHadFocus = document.activeElement?.matches?.('[data-wb-input]');
    const selection = inputHadFocus ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
    const running = allQueries(state).filter(q => q.status === 'running').length;
    host.innerHTML = `<div class="wb-layout ${c.messages.length ? 'wb-active' : 'wb-start'}" data-wb-root data-wb-conversation="${esc(c.id)}" data-mobile-pane="${mobilePane}">${c.tasks.length ? `<nav class="wb-mobile-views" aria-label="工作台视图">${button('show-chat', '对话', `aria-pressed="${mobilePane === 'chat'}"`)}${button('show-task', `当前任务 <span>${esc(statusNames[task()?.status] || '')}</span>`, `aria-pressed="${mobilePane === 'task'}"`)}</nav>` : ''}<section class="wb-chat"><header class="wb-chat-heading"><div><span class="wb-eyebrow">当前会话</span><h1>${esc(c.title)}</h1></div><span class="wb-demo-label" ${c.tasks.length < 2 ? 'hidden' : ''}>${c.tasks.length} 个分析任务</span></header>${warning ? `<div class="wb-notice">${esc(warning)}</div>` : ''}${running ? `<div class="wb-running-banner"><span class="wb-running-dot"></span>${running} 个演示查询正在运行，可继续提问</div>` : ''}<div class="wb-thread" data-wb-thread>${c.messages.length ? messagesHTML(c) : `<div class="wb-welcome"><span class="wb-welcome-icon">ANALYSIS WORKSPACE</span><h2>今天想分析什么？</h2><p>查数据、写 SQL，也把每个计算口径讲清楚。</p><div class="wb-examples">${[['2026 年 1 月净收入是多少？','净收入','查看支付与退款后的收入'],['2026 年 1 月有多少支付客户？','支付客户','整个区间去重，理解统计对象'],['2026 年 1 月退款率是多少？','退款率','先明确分母，再生成 SQL']].map(([prompt,title,sub])=>`<button data-wb-action="example" data-wb-prompt="${esc(prompt)}"><span class="wb-example-label">${title}</span><strong>${prompt}</strong><svg class="icon"><use href="#i-arrow"/></svg></button>`).join('')}</div><p class="wb-welcome-hint">合成零售样例 · 2026 年 1–2 月 · 2 月数据截至 4 日</p></div>`}</div><form class="wb-composer" data-wb-form><div class="wb-composer-meta"><span>${c.selectedSkill ? `Skill：${esc(c.selectedSkill.name)}` : c.messages.length ? '继续提问，或补充本次条件' : '用一句话描述你想了解的数据'}</span><button type="button" data-wb-action="choose-skill">${c.selectedSkill ? '更换 Skill' : '＋ 选用 Skill'}</button></div><textarea data-wb-input aria-label="数据问题" placeholder="${c.messages.length ? '例如：按渠道拆分，其他条件不变' : '例如：2026 年 1 月的净收入是多少？'}" rows="2">${esc(c.composer || '')}</textarea><div class="wb-composer-bottom"><span>Enter 发送 · Shift + Enter 换行</span><button class="wb-send" type="submit" data-wb-send>发送 <span>↑</span></button></div></form><p class="wb-local-note">合成资料演示 · 生成 SQL 后，由你确认再查询</p></section>${detailHTML()}</div>`;
    const thread = host.querySelector('.wb-thread');
    if (thread) {
      thread.scrollTop = scroll ? thread.scrollHeight : previousScroll;
      if (thread.offsetHeight) threadPositions.set(c.id, thread.scrollTop);
    }
    const detail = host.querySelector('[data-wb-detail-task]');
    if (detail && detail.dataset.wbDetailTask === previousTaskId) detail.scrollTop = detailScroll;
    if (inputHadFocus) { const input = host.querySelector('[data-wb-input]'); input?.focus(); if (selection) input?.setSelectionRange(...selection); }
  }
  function onClick(event) {
    const el = event.target.closest('[data-wb-action]');
    if (!el || !host.contains(el)) return;
    event.preventDefault();
    const action = el.dataset.wbAction;
    if (action === 'example') { conversation().composer=el.dataset.wbPrompt; render(); host.querySelector('[data-wb-input]')?.focus(); }
    else if (action === 'show-chat' || action === 'show-task') { mobilePane = action === 'show-task' ? 'task' : 'chat'; render(); }
    else if (action === 'task') { state.activeTaskId = el.dataset.wbTaskId; state.viewVersion = null; state.viewQueryId = null; changed(); }
    else if (action === 'clarify') clarify(el.dataset.wbDenominator, el.dataset.wbTaskId);
    else if (action === 'confirm') confirm(el.dataset.wbTaskId, el.dataset.wbVersion);
    else if (action === 'cancel') cancel(el.dataset.wbQueryId);
    else if (action === 'query') openQuery(el.dataset.wbQueryId);
    else if (action === 'inspect') { mobilePane = 'task'; state.activeTaskId = el.dataset.wbTaskId; state.viewVersion = +el.dataset.wbVersion; state.viewQueryId = null; changed(); }
    else if (action === 'redraft') { const t = task(); if (t) { t.version += 1; draft(t); draftMessage(conversation(), t, true); changed(true); } }
    else if (action === 'csv') exportCSV(el.dataset.wbQueryId);
    else if (action === 'choose-skill') callbacks.chooseSkill?.();
    else if (action === 'save-skill') { const t = task(); if (t) callbacks.saveSkill?.({name: `${metricNames[t.conditions.metric]}分析`, description: '先明确条件，核对口径与 SQL，再查看结果。', steps: ['确认统计月份、渠道及测试交易范围', `核对${metricNames[t.conditions.metric]}的时间、统计对象和计算口径`, '展示 SQL，由用户确认具体版本后执行', '解释结果及数据范围，保留本次纠错']}); }
    else if (action === 'evidence') evidence(el.dataset.wbMetricKind);
    else if (action === 'field-evidence') callbacks.openKnowledge?.({tab: 'fields', field: 'paid_at'});
    else if (action === 'metric-evidence') callbacks.openKnowledge?.({tab: 'metrics', metric: {net: 'net_revenue', customer: 'paid_customer_uv', refund: 'order_refund_rate'}[el.dataset.wbMetricKind]});
    else if (action === 'memory') callbacks.openMemories?.(el.dataset.wbMemoryId);
    else if (action === 'undo-memory') { const result = callbacks.undoMemory?.(el.dataset.wbMemoryId); if (result !== false && callbacks.undoMemory) { const m = conversation().messages.find(x => x.id === el.dataset.wbMessageId); if (m) m.undone = true; changed(); } }
  }
  function init(element, options = {}) {
    if (host) return;
    host = typeof element === 'string' ? document.querySelector(element) : element;
    if (!host) throw new Error('workbenchDemo.init requires a host element');
    callbacks = options;
    host.addEventListener('click', onClick);
    host.addEventListener('submit', e => { if (e.target.matches('[data-wb-form]')) { e.preventDefault(); submit(conversation()?.composer || host.querySelector('[data-wb-input]')?.value); } });
    host.addEventListener('input', e => { if (e.target.matches('[data-wb-input]')) conversation().composer = e.target.value; });
    host.addEventListener('focusout', e => { if (e.target.matches('[data-wb-input]')) persist(); });
    window.addEventListener('pagehide', () => { if (state) persist(); });
    host.addEventListener('keydown', e => { if (e.target.matches('[data-wb-input]') && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(e.target.value); } });
    host.addEventListener('change', e => {
      if (e.target.matches('[data-wb-task-select]')) { state.activeTaskId = e.target.value; state.viewVersion = null; state.viewQueryId = null; changed(); }
      if (e.target.matches('[data-wb-version-select]')) { state.viewVersion = +e.target.value; state.viewQueryId = null; changed(); }
    });
    setUser(userId);
  }
  function setUser(uid) {
    if (!['analyst-a', 'developer-b'].includes(uid)) return false;
    if (state) persist();
    mobilePane = 'chat';
    userId = uid; state = load(uid);
    if (!conversation()) newConversation(); else render(true);
    allQueries(state).forEach(q => schedule(q, state, userId));
    callbacks.onChange?.(); return true;
  }
  window.workbenchDemo = {
    init, setUser, newConversation, openConversation, openQuery, selectSkill, invalidateSkill,
    getConversations: () => state ? state.conversations.filter(c => c.messages.length || c.composer?.trim()).map(c => ({id: c.id, active: c.id === state.activeConversationId, title: c.messages.length ? c.title : '未发送的对话', updatedAt: c.updatedAt, status: !c.messages.length ? 'unsent' : c.tasks.some(t => t.queries.some(q => q.status === 'running')) ? 'running' : c.tasks.at(-1)?.status || 'draft', taskCount: c.tasks.length})).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)) : [],
    getQueries: () => state ? allQueries(state).map(q => clone({id: q.id, conversationId: q.conversationId, taskId: q.taskId, title: q.title, status: q.status, sqlVersion: q.sqlVersion, createdAt: q.createdAt, conditionSummary: q.conditionSummary, rows: q.rows, columns: q.columns, sql: q.sql, skill: q.skill})).sort((a,b) => b.createdAt.localeCompare(a.createdAt)) : []
  };
})();

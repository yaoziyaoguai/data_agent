/* 两个完全虚构的模拟身份；localStorage 演示不构成真实用户权限隔离。 */
const personalWorkspace = (() => {
  const keyPrefix = 'data-agent-retail-synthetic-v1-personal-';
  const profiles = [{id:'analyst-a',name:'演示分析员 A'},{id:'developer-b',name:'演示开发者 B'}];
  const kinds = {preference:'个人偏好',context:'常用背景',correction:'可复用纠错'};
  let profileId=profiles[0].id;
  let state=null;
  let memoryEditorId=null;
  let undo=null;
  const e=value=>escapeHTML(value);
  function seed(id){
    return id==='analyst-a'?{
      memories:[
        {id:'preference-a',kind:'preference',content:'通常先展示 SQL 和统计范围，再给图表。',scope:'retail_demo · 输出方式',original:'',source:'模拟用户明确设置',status:'enabled',updatedAt:'2026-10-03 · 演示',evidence:'只影响呈现；本次明确要求优先。'},
        {id:'correction-a',kind:'correction',original:'将每日支付客户 UV 相加作为整月客户 UV。',content:'月支付客户 UV 应在整月符合条件的订单中，对非空 customer_id 重新去重。',scope:'retail_demo · 支付客户 · 跨日统计',source:'会话：一月支付客户分析（虚构）',status:'enabled',updatedAt:'2026-10-03 · 演示',evidence:'paid_customer_uv 候选定义与《客户 UV、匿名订单与跨日去重》',target:'paid_customer_uv'}
      ],
      conversations:[{id:'customer-month',title:'一月支付客户分析',time:'2026-10-03 · 虚构记录',question:'2026 年一月有多少支付客户？',followup:'再按渠道拆分，保留 UTC 时间和排除测试订单的条件。',correction:'月客户 UV 不能累加每日 UV；同一客户跨天购买要重新去重。',conditions:[['统计对象','已知支付客户'],['时间','2026-01-01 至 2026-02-01（左闭右开，UTC）'],['过滤','is_test=0；paid_at 非空；customer_id 非空'],['来源','demo_order_detail'],['维度','channel'],['状态','未执行 · 页面演示']]}]
    }:{
      memories:[{id:'preference-b',kind:'preference',content:'解释关联时，先说明每张表一行代表什么，并展示可能放大行数的位置。',scope:'retail_demo · 多表查询解释',original:'',source:'模拟用户明确设置',status:'enabled',updatedAt:'2026-10-03 · 演示',evidence:'个人呈现偏好，不改变 JOIN 规则。'},
        {id:'correction-b',kind:'correction',content:'用标签筛选客户时优先检查 EXISTS；直接 JOIN 多个标签后求和会重复订单金额。',scope:'retail_demo · customer_tags 关联',original:'将客户标签直接关联订单行后累计全部金额。',source:'会话：会员标签收入分析（虚构）',status:'pending',updatedAt:'2026-10-03 · 演示',evidence:'《加工血缘和查询关联的边界》的客户标签章节'}],
      conversations:[{id:'tag-revenue',title:'会员标签收入分析',time:'2026-10-03 · 虚构记录',question:'一月拥有 vip 标签的客户贡献了多少净收入？',followup:'先解释标签与订单的关系，不执行。',correction:'',conditions:[['统计对象','具有 vip 标签的客户订单'],['时间','2026 年一月支付（UTC）'],['过滤','排除测试订单；标签用 EXISTS 筛选'],['状态','等待确认候选 SQL · 演示']]}]
    };
  }
  function load() {
    undo = null;
    try {
      const saved = JSON.parse(localStorage.getItem(keyPrefix + profileId) || 'null');
      if (saved && (!Array.isArray(saved.memories) || !Array.isArray(saved.conversations))) throw new Error('Invalid personal draft');
      state = saved || seed(profileId);
    } catch { state = seed(profileId); toast('个人草稿未能读取，显示该模拟用户的初始演示；未覆盖本机记录。'); }
  }
  function persist(next) {
    try { localStorage.setItem(keyPrefix + profileId, JSON.stringify(next)); state = next; return true; }
    catch { toast('个人草稿保存失败，当前编辑仍在窗口中。'); return false; }
  }
  function getCurrentUser() { return {...profiles.find(p => p.id === profileId)}; }
  function setUser(id) {
    if (!profiles.some(p => p.id === id)) return false;
    if (profileId !== id) {
      profileId = id;
      memoryEditorId = null;
      $('#memory-dialog')?.close();
      load();
    } else if (!state) load();
    render();
    return true;
  }
  function initialize() { if (!state) load(); render(); }
  function addCorrection({content, original, scope, source, target = ''} = {}) {
    const values = {content, original, scope, source};
    if (Object.values(values).some(value => typeof value !== 'string' || !value.trim()) || typeof target !== 'string') return null;
    if (!state) load();
    const clean = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.trim()]));
    const duplicate = state.memories.find(m => m.kind === 'correction' && m.content.trim() === clean.content && m.scope.trim() === clean.scope && (m.target || '') === target.trim());
    if (duplicate) return {id: duplicate.id, created: false};
    const memory = {...clean, id: `memory-${crypto.randomUUID()}`, kind: 'correction', target: target.trim(),
      evidence: target.trim() ? `关联指标：${target.trim()}；来自用户明确纠错，业务规则待核对。` : '来自用户明确纠错；后续使用前核对适用范围和业务依据。',
      status: 'pending', revision: 1, history: [], updatedAt: new Date().toLocaleString('zh-CN')};
    if (!persist({...state, memories: [...state.memories, memory]})) return null;
    render();
    return {id: memory.id, created: true};
  }
  function removeCorrection(id) {
    if (!state) load();
    const removed = state.memories.find(m => m.id === id && m.kind === 'correction');
    if (!removed || !persist({...state, memories: state.memories.filter(m => m.id !== id)})) return false;
    undo = removed;
    render();
    return true;
  }
  let linkingShell = false;
  function show(view) {
    if (!['semantic', 'personal'].includes(view)) return;
    if (window.systemShell?.navigate && !linkingShell) {
      linkingShell = true;
      try { window.systemShell.navigate(view === 'personal' ? 'assets' : 'semantic', view === 'personal' ? {section: 'memory'} : {}); }
      finally { linkingShell = false; }
      if (view === 'personal') initialize();
      return;
    }
    $('#semantic-workspace').hidden = view !== 'semantic';
    $('#personal-workspace').hidden = view !== 'personal';
    $$('.workspace-nav button[data-view]').forEach(b => { const selected = b.dataset.view === view; b.classList.toggle('active', selected); b.setAttribute('aria-current', selected ? 'page' : 'false'); });
    if (view === 'personal') initialize();
    else renderHeader();
  }
  function render() {
    if (!state) load();
    const profile = getCurrentUser();
    $('#personal-workspace').innerHTML = `<div class="breadcrumbs">我的积累 <span>/</span> <strong>记忆</strong></div>
      <header class="personal-heading"><div><h1>我的记忆</h1><p>${e(profile.name)} 的偏好和纠错经验，按用户分别管理。</p></div><label class="profile-switch">切换模拟身份<select id="demo-profile" class="form-input">${profiles.map(p => `<option value="${p.id}" ${profileId === p.id ? 'selected' : ''}>${p.name}（演示）</option>`).join('')}</select><span>仅演示分用户展示，尚未接入账号与权限</span></label></header>
      <div class="personal-grid"><div><section class="panel">${sectionHeader('', '我的长期记忆', `${state.memories.length} 条 · 可编辑、停用或删除`, '<button class="button primary" data-new-memory>新增记忆</button>')}
        ${undo ? '<div class="memory-feedback">已删除这条记忆。<button class="quiet-link" data-undo-memory>撤销删除</button></div>' : ''}
        ${state.memories.map(m => memoryCard(m)).join('') || '<div class="empty-state">尚未保存长期记忆。可从自己的纠错或稳定偏好开始。</div>'}</section>
        <section class="panel memory-examples"><details><summary>纠错来源示例 <span>${state.conversations.length} 条 · 展开查看</span></summary><p class="small-note">下列是预置的虚构素材。工作台会话可从左侧最近会话或“查看全部”进入。</p>${state.conversations.map(c => `<article class="history-card"><h4>${e(c.title)}</h4><p>${e(c.question)}</p><div class="document-meta"><span>${e(c.time)}</span><span class="badge inferred">未执行 · 示例素材</span></div><button class="quiet-link" data-view-conversation="${c.id}">查看来源与本次条件 ${icon('arrow')}</button></article>`).join('')}</details></section></div>
      <aside class="memory-guide"><div class="memory-guide-heading">${icon('info')}<h2>让记忆用在合适的地方</h2></div><p>保留你的偏好和纠错经验，每次使用前都要核对当前问题与适用范围。</p><dl class="memory-stats"><div><dt>已启用</dt><dd>${state.memories.filter(m => m.status === 'enabled').length}</dd></div><div><dt>待核对</dt><dd>${state.memories.filter(m => m.status === 'pending').length}</dd></div><div><dt>已停用</dt><dd>${state.memories.filter(m => m.status === 'disabled').length}</dd></div></dl>
        <details class="memory-help"><summary>哪些纠错值得记住？ ${icon('chevron')}</summary><p>例如“月 UV 应在整月重新去重”，可以用于后续相同口径的问题。记录原理解、纠正内容、来源和适用范围。</p><p>“这次只看 app 渠道”属于本次条件。有长期复用价值的明确纠错才会保存，并提供撤销入口。</p></details>
        <details class="memory-help"><summary>与业务口径冲突时怎么办？ ${icon('chevron')}</summary><p>个人纠错先作为待核对线索。本次明确要求优先于个人偏好；统计规则要核对当前有效的公共语义。需要更改公共口径时，进入语义管理保留修订依据。</p></details>
        <div class="memory-skill-note"><strong>一套分析步骤？保存为 Skill</strong><p>在“我的 Skill”整理方法，下次分析时主动选用。</p><button class="quiet-link" data-asset-section="skills">管理我的 Skill ${icon('arrow')}</button></div>
        <p class="personal-note">仅保存于当前浏览器 · 模拟用户数据</p></aside></div>`;
  }
  function memoryCard(m) {
    return `<article class="memory-card ${m.status === 'disabled' ? 'disabled' : ''}" data-memory-card="${e(m.id)}"><div class="memory-card-head"><span>${e(kinds[m.kind] || '记忆')} · ${e(m.scope)}</span><span class="badge ${m.status === 'pending' ? 'attention' : 'synced'}">${m.status === 'enabled' ? (m.kind === 'correction' ? '复用线索' : '已启用') : m.status === 'pending' ? '待核对' : '已停用'}</span></div>${m.kind === 'correction' ? `<p class="small-note">原理解：${e(m.original)}</p>` : ''}<p>${e(m.content)}</p><div class="memory-source">来源：${e(m.source)}<br>依据：${e(m.evidence)}<br>版本：v${m.revision || 1} · 更新：${e(m.updatedAt)}</div>${m.target ? `<button class="quiet-link memory-promotion" data-correction-metric="${e(m.target)}">定位共享指标，核对是否需要修订 ${icon('arrow')}</button>` : ''}<div class="memory-actions"><button class="quiet-link" data-edit-memory="${e(m.id)}">编辑</button><button class="quiet-link" data-toggle-memory="${e(m.id)}">${m.status === 'enabled' ? '停用' : m.status === 'pending' ? '设为复用线索' : '启用'}</button><button class="quiet-link" data-delete-memory="${e(m.id)}">删除</button></div></article>`;
  }
  function dialog(title, html) {
    $('#memory-title').textContent = title; $('#memory-detail').innerHTML = html;
    if (!$('#memory-dialog').open) $('#memory-dialog').showModal();
    $('#memory-dialog').scrollTop = 0;
  }
  function editMemory(id, correction = null) {
    if (!state) load();
    const m = id ? state.memories.find(x => x.id === id) : correction || {kind: 'preference', content: '', scope: 'retail_demo · 输出方式', original: '', evidence: '用户明确设置', source: '个人手动录入'};
    if (!m) return;
    memoryEditorId = id;
    dialog(id ? '编辑个人记忆' : '保存可复用的记忆', `<form id="memory-form" class="memory-form"><label>记忆类型<select name="kind" id="memory-kind" class="form-input">${Object.entries(kinds).map(([k, label]) => `<option value="${k}" ${k === m.kind ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label id="memory-original-label" ${m.kind !== 'correction' ? 'hidden' : ''}>原来的错误理解<textarea name="original" class="form-input">${e(m.original)}</textarea></label><label>要记住什么<textarea required name="content" class="form-input document-textarea">${e(m.content)}</textarea></label><label>适用范围<input required name="scope" class="form-input" value="${e(m.scope)}"></label><label>来源<input required name="source" class="form-input" value="${e(m.source)}"></label><label>依据或关联对象<textarea required name="evidence" class="form-input">${e(m.evidence)}</textarea></label><p class="small-note">纠错先保存为待核对线索。仅调整这次查询的要求应留在会话中；共享口径通过语义维护更新。</p><div class="dialog-actions"><button type="button" class="button" data-memory-close>取消</button><button type="submit" class="button primary">保存到我的记忆</button></div></form>`);
  }
  function conversation(id) {
    const c = state.conversations.find(x => x.id === id);
    if (!c) return;
    dialog(c.title, `<p class="small-note">${e(c.time)} · ${e(profiles.find(p => p.id === profileId).name)} 的私有记录</p><div class="history-message"><strong>最初问题</strong>${e(c.question)}</div><div class="history-message"><strong>连续追问</strong>${e(c.followup)}</div><dl class="context-values">${c.conditions.map(([k, v]) => `<dt>${e(k)}</dt><dd>${e(v)}</dd>`).join('')}</dl>${c.correction ? `<div class="history-message"><strong>用户纠错</strong>${e(c.correction)}</div><button class="button primary" data-remember-correction="${c.id}">将这次纠错整理为记忆</button>` : ''}<p class="personal-note">生产记录还需保存回答、SQL、任务标识、采用的语义 / 文档 / 记忆版本和执行状态。旧结果是否仍可查看，要核对权限和保留期限。</p>`);
  }
  document.addEventListener('click', event => {
    const b = event.target.closest('button'); if (!b) return;
    if (['personal', 'semantic'].includes(b.dataset.view)) show(b.dataset.view);
    if (b.hasAttribute('data-memory-close')) $('#memory-dialog').close();
    if (b.hasAttribute('data-new-memory')) editMemory(null);
    if (b.dataset.editMemory) {
      if (window.systemShell?.navigate) show('personal');
      editMemory(b.dataset.editMemory);
    }
    if (b.dataset.viewConversation) conversation(b.dataset.viewConversation);
    if (b.dataset.rememberCorrection) {
      const c = state.conversations.find(x => x.id === b.dataset.rememberCorrection);
      editMemory(null, {kind: 'correction', original: '将每日支付客户 UV 相加作为整月支付客户 UV。', content: c.correction, scope: 'retail_demo · 零售订单 · 支付客户 UV · 跨日总体统计', source: `会话：${c.title}（演示）`, evidence: 'paid_customer_uv 候选定义及说明；统计规则待核对'});
    }
    if (b.dataset.toggleMemory) {
      const next = {...state, memories: state.memories.map(m => m.id === b.dataset.toggleMemory ? {...m, status: m.status === 'enabled' ? 'disabled' : 'enabled', updatedAt: new Date().toLocaleString('zh-CN')} : m)};
      if (persist(next)) { render(); toast('已更新个人记忆状态；实际回答仍需检查适用范围与依据。'); }
    }
    if (b.dataset.deleteMemory) {
      const removed = state.memories.find(m => m.id === b.dataset.deleteMemory);
      if (!removed) return;
      if (persist({...state, memories: state.memories.filter(m => m.id !== removed.id)})) { undo = removed; render(); }
    }
    if (b.hasAttribute('data-undo-memory') && undo) {
      if (persist({...state, memories: [...state.memories, undo]})) { undo = null; render(); }
    }
  });
  document.addEventListener('change', event => {
    if (event.target.id === 'demo-profile') {
      const id = event.target.value;
      if (setUser(id)) window.systemShell?.setUser?.(id);
    }
    if (event.target.id === 'memory-kind') $('#memory-original-label').hidden = event.target.value !== 'correction';
  });
  document.addEventListener('submit', event => {
    if (event.target.id !== 'memory-form') return;
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.target));
    if (Object.entries(values).some(([k, v]) => k !== 'original' && !v.trim()) || (values.kind === 'correction' && !values.original.trim())) { toast('请填写内容、适用范围和依据；纠错还需保留原来的错误理解。'); return; }
    const duplicate = state.memories.find(m => m.id !== memoryEditorId && m.kind === values.kind && m.scope.trim() === values.scope.trim() && m.content.trim() === values.content.trim());
    if (duplicate) { toast('相同范围内已保存这条记忆，可直接编辑已有记录。'); return; }
    const previous = state.memories.find(x => x.id === memoryEditorId);
    const {history = [], ...snapshot} = previous || {};
    const m = {...values, id: memoryEditorId || `memory-${crypto.randomUUID()}`, status: values.kind === 'correction' ? 'pending' : 'enabled', updatedAt: new Date().toLocaleString('zh-CN'), target: previous?.target || '', revision: previous ? (previous.revision || 1) + 1 : 1, history: previous ? [...history, snapshot] : []};
    const memories = memoryEditorId ? state.memories.map(x => x.id === memoryEditorId ? m : x) : [...state.memories, m];
    if (persist({...state, memories})) { $('#memory-dialog').close(); render(); toast('已保存到当前模拟用户的本机记忆。'); }
  });
  return {show, initialize, init: initialize, render, setUser, getCurrentUser, addCorrection, removeCorrection};
})();

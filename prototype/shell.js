/* 整体产品交互原型：只使用合成资料和浏览器本地记录。 */
window.systemShell = (() => {
  const q = (selector) => document.querySelector(selector);
  const e = (value) => escapeHTML(String(value ?? ''));
  const profiles = {'analyst-a': '分析员 A', 'developer-b': '开发者 B'};
  const pageTitles = {workbench: '工作台', assets: '我的积累', semantic: '语义管理'};
  const skillKey = 'data-agent-system-prototype-v1-skills-';
  let user = 'analyst-a';
  let page = 'workbench';
  let assetSection = 'memory';
  let skills = [];
  let historyKind = 'conversations';
  let historySearch = '';
  let returnToAnalysis = false;
  let selectingSkill = false;
  let skillDraft = null;
  try { const savedUser=localStorage.getItem('data-agent-system-prototype-v1-profile'); if(Object.hasOwn(profiles,savedUser))user=savedUser; } catch {}

  function readSkills() {
    const seed = user === 'analyst-a' ? [{id:'monthly-review',name:'月度支付复盘',description:'先核对支付范围，再比较收入与客户变化。',scope:'零售演示 · 月度分析',steps:'确认月份、UTC 时间与测试订单过滤。\n按支付时间统计净收入与月支付客户数。\n需要时按渠道拆分，并检查客户重复。\n每条 SQL 展示确认后查询，再解释结果。',version:1,enabled:true,updatedAt:'2026-10-03',history:[]}] : [];
    try {
      const saved = JSON.parse(localStorage.getItem(skillKey + user) || 'null');
      skills = Array.isArray(saved) ? saved : seed;
    } catch { skills = seed; toast('Skill 记录无法读取，暂时显示初始样例。'); }
  }
  function writeSkills(next) {
    try { localStorage.setItem(skillKey + user, JSON.stringify(next)); skills = next; return true; }
    catch { toast('本机保存失败，请保留当前编辑内容。'); return false; }
  }
  function updateChrome() {
    document.body.dataset.page = page;
    q('#shell-page-title').textContent = pageTitles[page];
    document.title = `${pageTitles[page]} · Data Agent 原型`;
    document.querySelectorAll('.shell-nav [data-page]').forEach(button => {
      button.setAttribute('aria-current', button.dataset.page === page ? 'page' : 'false');
    });
    q('[data-shell-return]').hidden = page === 'workbench' || !returnToAnalysis;
    q('#shell-conversations').hidden = page !== 'workbench';
    q('.shell-mobile-history').hidden = page !== 'workbench';
    q('#shell-profile').value = user;
    q('#shell-avatar').textContent = user === 'analyst-a' ? 'A' : 'B';
    q('#shell-asset-owner').textContent = `仅${profiles[user]}可见 · 演示`;
  }
  function navigate(next, options = {}) {
    page = Object.hasOwn(pageTitles, next) ? next : 'workbench';
    if (options.section) assetSection = options.section === 'skills' ? 'skills' : 'memory';
    q('#workbench-workspace').hidden = page !== 'workbench';
    q('#assets-workspace').hidden = page !== 'assets';
    q('#semantic-workspace').hidden = page !== 'semantic';
    if (page === 'assets') renderAssets();
    if (page === 'workbench') refreshRecents();
    updateChrome();
    const params = new URLSearchParams(location.search);
    params.set('page', page);
    if (page === 'assets') params.set('section', assetSection); else params.delete('section');
    if (page !== 'semantic') params.delete('tab');
    history.replaceState(null, '', `?${params.toString()}`);
  }
  function setUser(id) {
    if (!Object.hasOwn(profiles, id)) return;
    document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
    user = id;
    try { localStorage.setItem('data-agent-system-prototype-v1-profile',id); } catch { toast('模拟身份无法保存到本机，本次切换仍有效。'); }
    selectingSkill = false;
    returnToAnalysis = false;
    readSkills();
    personalWorkspace.setUser(id);
    workbenchDemo.setUser(id);
    refreshRecents();
    if (page === 'assets') renderAssets();
    updateChrome();
  }
  function formatTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value || '') : date.toLocaleString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
  }
  function statusLabel(value) {
    return ({unsent:'待发送',draft:'草稿',clarifying:'待补充',awaiting_confirmation:'待确认',awaiting_clarification:'待补充',running:'查询中',succeeded:'已完成',completed:'已完成',cancelled:'已取消',cancelling:'取消中',failed:'失败',expired:'结果过期',idle:'进行中'})[value] || value || '进行中';
  }
  function refreshRecents() {
    const conversations = workbenchDemo.getConversations();
    q('#shell-recents').innerHTML = conversations.length ? conversations.slice(0,8).map(c => `<button data-shell-conversation="${e(c.id)}" aria-current="${c.active?'true':'false'}" title="${e(c.title)}"><span class="shell-session-dot ${c.status==='running'?'is-running':''}"></span><span>${e(c.title)}</span></button>`).join('') : '<p class="shell-empty-recent">直接在右侧提问，对话会自动保留。</p>';
    if (q('#history-dialog').open) renderHistory();
  }
  function openConversation(id) {
    q('#history-dialog').close();
    workbenchDemo.openConversation(id);
    navigate('workbench');
  }
  function renderHistory() {
    const records = historyKind === 'conversations' ? workbenchDemo.getConversations() : workbenchDemo.getQueries();
    const filtered = records.filter(r => `${r.title} ${r.conditionSummary || ''}`.toLowerCase().includes(historySearch.toLowerCase()));
    q('#history-workspace').innerHTML = `<p class="shell-help">${e(profiles[user])}的分析记录。打开后回到原会话，继续查看 SQL 和结果。</p><div class="shell-history-tools"><nav class="shell-subtabs"><button data-history-kind="conversations" aria-current="${historyKind==='conversations'?'page':'false'}">会话</button><button data-history-kind="queries" aria-current="${historyKind==='queries'?'page':'false'}">查询任务</button></nav><label class="search"><svg class="icon"><use href="#i-search"/></svg><input id="history-search" placeholder="搜索分析记录" value="${e(historySearch)}" aria-label="搜索分析记录"></label></div><div class="shell-records">${filtered.map(r => `<button class="shell-record" ${historyKind==='conversations'?'data-shell-conversation':'data-shell-query'}="${e(r.id)}"><span class="shell-record-icon"><svg class="icon"><use href="#i-${historyKind==='conversations'?'code':'table'}"/></svg></span><span class="shell-record-main"><strong>${e(r.title)}</strong><small>${e(r.conditionSummary || `${r.taskCount || 0} 个分析任务`)} · ${e(formatTime(r.updatedAt || r.createdAt))}${r.sqlVersion?` · SQL v${e(r.sqlVersion)}`:''}</small></span><span class="shell-status ${r.status==='running'?'is-running':''}">${e(statusLabel(r.status))}</span><svg class="icon"><use href="#i-chevron"/></svg></button>`).join('') || `<div class="shell-empty"><svg class="icon"><use href="#i-clock"/></svg><h3>${historySearch?'没有匹配的记录':'还没有'+(historyKind==='conversations'?'会话':'查询任务')}</h3><p>${historySearch?'换一个关键词试试。':'从工作台发起一次分析，相关记录会自动保留。'}</p><button class="button" data-history-close>返回工作台</button></div>`}</div>`;
  }
  function showHistory() {
    navigate('workbench');
    renderHistory();
    if (!q('#history-dialog').open) q('#history-dialog').showModal();
  }
  function renderAssets() {
    q('#personal-workspace').hidden = assetSection !== 'memory';
    q('#skills-workspace').hidden = assetSection !== 'skills';
    document.querySelectorAll('[data-asset-section]').forEach(b => b.setAttribute('aria-current',b.dataset.assetSection===assetSection?'page':'false'));
    if (assetSection === 'memory') personalWorkspace.render(); else renderSkills();
  }
  function renderSkills() {
    q('#skills-workspace').innerHTML = `<div class="shell-skill-intro"><div><h2>把做得好的分析，存成自己的方法</h2><p>记录适用场景和分析步骤。在工作台明确选用后才采用，每条查询仍需你确认。</p></div><button class="button primary" data-skill-new>${icon('plus')}新建 Skill</button></div>${selectingSkill?'<div class="shell-selection-note">选择一种方法带回当前会话。<button class="quiet-link" data-shell-return>暂不选用，返回分析</button></div>':''}<div class="shell-skill-grid">${skills.map(skill => `<article class="shell-skill-card ${skill.enabled?'':'is-disabled'}"><div class="shell-skill-top"><span class="shell-method-icon">${icon('flow')}</span><span class="shell-status">${skill.enabled?'已启用':'已停用'} · v${e(skill.version)}</span></div><h3>${e(skill.name)}</h3><p>${e(skill.description)}</p><span class="shell-skill-scope">${e(skill.scope)}</span><ol>${String(skill.steps).split('\n').filter(Boolean).slice(0,4).map(step=>`<li>${e(step.replace(/^\d+[.、]\s*/,''))}</li>`).join('')}</ol><div class="shell-skill-actions"><button class="button primary" data-skill-use="${e(skill.id)}" ${skill.enabled?'':'disabled'}>在工作台选用</button><button class="quiet-link" data-skill-edit="${e(skill.id)}">编辑</button><button class="quiet-link" data-skill-toggle="${e(skill.id)}">${skill.enabled?'停用':'启用'}</button><button class="quiet-link" data-skill-delete="${e(skill.id)}">删除</button></div></article>`).join('') || '<div class="shell-empty"><h3>还没有自己的 Skill</h3><p>可以手动新建，也可以在工作台完成分析后保存方法。</p><button class="button" data-skill-new>创建第一个 Skill</button></div>'}</div><p class="shell-help">本页演示方法的保存、版本和显式选用；当前不会执行 Skill 中的代码，也未调用模型理解自定义步骤。</p>`;
  }
  function editSkill(id, draft = {}) {
    skillDraft = id ? skills.find(s=>s.id===id) : null;
    const value = skillDraft || {name:draft.name || draft.title || '',description:draft.description || '',scope:draft.scope || '零售演示 · 分析方法',steps:Array.isArray(draft.steps)?draft.steps.join('\n'):draft.steps || ''};
    q('#skill-dialog-title').textContent = skillDraft ? `编辑 ${skillDraft.name}` : '保存分析方法';
    q('#skill-dialog-content').innerHTML = `<form id="shell-skill-form"><label>方法名称<input class="form-input" name="name" required maxlength="80" value="${e(value.name)}" placeholder="例如：月度支付复盘"></label><label>用在什么场景<input class="form-input" name="scope" required maxlength="160" value="${e(value.scope)}"></label><label>简短说明<textarea class="form-input" name="description" required rows="2">${e(value.description)}</textarea></label><label>分析步骤（每行一步）<textarea class="form-input shell-skill-steps" name="steps" required rows="7">${e(value.steps)}</textarea></label><p class="shell-help">保存后属于${e(profiles[user])}。${skillDraft?`本次保存为 v${skillDraft.version+1}；已有会话保留当时选用版本。`:'先检查范围和步骤，再保存。'}方法不能替代当前条件和 SQL 执行确认。</p>${skillDraft?.history?.length?`<details class="shell-skill-versions"><summary>查看 ${skillDraft.history.length} 个旧版本</summary>${skillDraft.history.map(v=>`<article><strong>v${e(v.version)} · ${e(v.name)}</strong><pre>${e(v.steps)}</pre></article>`).join('')}</details>`:''}<div class="dialog-actions"><button type="button" class="button" data-skill-close>取消</button><button type="submit" class="button primary">保存 Skill</button></div></form>`;
    if (!q('#skill-dialog').open) q('#skill-dialog').showModal();
  }
  function openKnowledge(target) {
    returnToAnalysis = true;
    navigate('semantic');
    semanticWorkspace.activate(target);
  }
  function openMemories(id) {
    returnToAnalysis = true;
    navigate('assets',{section:'memory'});
    if (id) q(`[data-memory-card="${CSS.escape(id)}"]`)?.scrollIntoView({block:'center'});
  }
  document.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.page) navigate(button.dataset.page);
    if (button.hasAttribute('data-shell-new')) { workbenchDemo.newConversation(); navigate('workbench'); q('[data-wb-input]')?.focus(); }
    if (button.hasAttribute('data-shell-history')) showHistory();
    if (button.hasAttribute('data-shell-return')) { selectingSkill=false; navigate('workbench'); }
    if (button.dataset.shellConversation) openConversation(button.dataset.shellConversation);
    if (button.dataset.shellQuery) { q('#history-dialog').close(); workbenchDemo.openQuery(button.dataset.shellQuery); navigate('workbench'); }
    if (button.hasAttribute('data-history-close')) q('#history-dialog').close();
    if (button.dataset.historyKind) { historyKind=button.dataset.historyKind; renderHistory(); }
    if (button.dataset.assetSection) navigate('assets',{section:button.dataset.assetSection});
    if (button.hasAttribute('data-skill-new')) editSkill(null);
    if (button.dataset.skillEdit) editSkill(button.dataset.skillEdit);
    if (button.hasAttribute('data-skill-close')) q('#skill-dialog').close();
    if (button.dataset.skillUse) {
      const skill = skills.find(s=>s.id===button.dataset.skillUse && s.enabled);
      if (!skill) return;
      workbenchDemo.selectSkill({...skill}); selectingSkill=false; navigate('workbench');
      toast(`已选用“${skill.name}” v${skill.version}；查询仍需确认。`);
    }
    if (button.dataset.skillToggle) {
      const skill = skills.find(s=>s.id===button.dataset.skillToggle);
      if (!skill) return;
      const next=skills.map(s=>s.id===skill.id?{...s,enabled:!s.enabled}:s);
      if (writeSkills(next)) { if(skill.enabled) workbenchDemo.invalidateSkill(skill.id); renderSkills(); }
    }
    if (button.dataset.skillDelete) {
      const id=button.dataset.skillDelete;
      if (writeSkills(skills.filter(s=>s.id!==id))) { workbenchDemo.invalidateSkill(id); renderSkills(); toast('已删除此 Skill；历史会话仍保留当时的采用记录。'); }
    }
  });
  document.addEventListener('change',event=>{ if(event.target.id==='shell-profile')setUser(event.target.value); });
  document.addEventListener('input',event=>{
    if(event.target.id==='history-search'){
      historySearch=event.target.value; const cursor=event.target.selectionStart;
      renderHistory(); q('#history-search').focus(); q('#history-search').setSelectionRange(cursor,cursor);
    }
  });
  document.addEventListener('submit',event=>{
    if(event.target.id!=='shell-skill-form')return;
    event.preventDefault();
    const values=Object.fromEntries(new FormData(event.target));
    if(Object.values(values).some(value=>!value.trim())){toast('请填写名称、适用场景、说明和步骤。');return;}
    const {history:versions=[],...previous}=skillDraft || {};
    const record={...values,id:skillDraft?.id || `skill-${crypto.randomUUID()}`,version:(skillDraft?.version || 0)+1,enabled:skillDraft?.enabled ?? true,updatedAt:new Date().toISOString(),history:skillDraft?[...versions,previous]:[]};
    if(writeSkills(skillDraft?skills.map(s=>s.id===record.id?record:s):[record,...skills])){q('#skill-dialog').close();navigate('assets',{section:'skills'});toast(`已保存“${record.name}” v${record.version}。`);}
  });
  document.addEventListener('keydown',event=>{
    if(page==='workbench'&&(event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'&&!document.querySelector('dialog[open]')){event.preventDefault();workbenchDemo.newConversation();navigate('workbench');q('[data-wb-input]')?.focus();}
  });
  function start() {
    readSkills();
    personalWorkspace.setUser(user);
    workbenchDemo.init(q('#workbench-workspace'),{
      onChange:refreshRecents,
      openKnowledge,
      saveMemory:correction=>personalWorkspace.addCorrection({...correction,target:typeof correction.target==='string'?correction.target:correction.target?.metric || ''}),
      openMemories,
      undoMemory:id=>personalWorkspace.removeCorrection(id),
      chooseSkill:()=>{selectingSkill=true;returnToAnalysis=true;navigate('assets',{section:'skills'});},
      saveSkill:draft=>{returnToAnalysis=true;editSkill(null,draft);}
    });
    workbenchDemo.setUser(user);
    const params=new URLSearchParams(location.search);
    navigate(params.get('page') || (params.has('tab')?'semantic':'workbench'),{section:params.get('section') || 'memory'});
    refreshRecents();
  }
  // 先公开路由对象，再执行会触发组件回调的初始化。
  queueMicrotask(start);
  return {navigate,setUser,openKnowledge,openMemories};
})();

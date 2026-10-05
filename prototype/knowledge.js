/* 文档与章节使用全虚构零售业务内容；多个对象复用同一文档版本。 */
const semanticKnowledge = (() => {
  const storageKey = 'data-agent-retail-synthetic-v1-documents';
  const clone = value => JSON.parse(JSON.stringify(value));
  const tableTarget = 'table:orders';
  const section = (id, title, body) => ({id, title, body});
  const link = (target, sectionId = '') => ({target, sectionId});
  const seeds = [
    {id:'money-guide',title:'支付、退款与净收入怎么计算',summary:'金额统一以分保存；退款归属、测试过滤和时间选择必须写清楚。',scope:'retail_demo · 订单支付与退款分析',source:'从零编写的合成业务说明、schema.sql 与 etl.sql',owner:'演示零售分析组',evidenceField:'col.paid_amount_cents.description',
      sections:[
        section('money-unit','金额单位与行粒度','paid_amount_cents 和 refunded_amount_cents 都以整数分保存。每行是一个订单中的一条商品行。净收入先在分的单位下计算支付金额减去退款金额，再按需要除以 100 显示为元。订单行金额已经是该行全部商品的金额，不应再次乘 quantity。'),
        section('payment-time','按支付时间统计','本样例将 paid_at 作为支付统计时间，统一使用 UTC。日期范围采用左闭右开，例如 2026-01-01 至 2026-02-01。order_date 是下单日期：月末下单、次月付款的订单应归入次月支付统计。未付款记录没有 paid_at，不能混进支付指标。'),
        section('refund-scope','退款归属与未明确的问题','本样例的订单行表汇总来源中可见的退款，按订单原支付时间选择订单。它回答的是所选支付订单截至样例快照的退款和净额；若要分析“本月发生的退款”，应读取 raw_payments 的退款事件时间，不能直接套用这张表的 paid_at。笼统的退款率需要先确认按订单、金额还是客户计算。'),
        section('test-orders','测试订单处理','默认收入分析使用 is_test=0。测试记录有意包含较大金额，用于检验是否遗漏过滤。is_test=1 不属于真实零售业绩；这里的全部订单本身又都是从零构造的演示记录。')],
      links:[link(tableTarget),link('field:orders:paid_amount_cents','money-unit'),link('field:orders:refunded_amount_cents','refund-scope'),link('field:orders:paid_at','payment-time'),link('metric:orders:net_revenue','money-unit'),link('topic:retail_analysis')]},
    {id:'customer-guide',title:'客户 UV、匿名订单与跨日去重',summary:'统计已知客户，不把每天的去重人数直接相加。',scope:'retail_demo · 支付客户分析',source:'合成业务说明与订单行样例',owner:'演示数据开发',evidenceField:'col.customer_id.description',
      sections:[
        section('dedup','整段时间重新去重','月支付客户 UV 在整月符合条件的订单中对 customer_id 去重。一个客户可能跨天购买；将每天的 UV 累加会重复计算。跨日、跨渠道的 UV 不能直接相加。当前快照中一个已知客户只对应一个地区；地区分组包含未知地区组时，可与总体核对。'),
        section('anonymous','匿名客户与分母','customer_id 为 NULL 表示匿名购买，没有可用的客户标识。匿名订单的支付金额仍计入收入，但已知客户 UV 不计入 NULL。不能把所有 NULL 当成同一个真实客户，也不能据此推断人数或设备数。'),
        section('zero-empty','零值与资料缺失','筛选后没有符合条件的已知客户时，COUNT(DISTINCT customer_id) 为 0。查询失败、结果尚未取全、样例未载入不代表客户数为 0。页面的候选 SQL 本身不执行查询。')],
      links:[link(tableTarget),link('field:orders:customer_id','anonymous'),link('metric:orders:paid_customer_uv','dedup'),link('topic:retail_analysis')]},
    {id:'join-guide',title:'加工血缘和查询关联的边界',summary:'支付先聚合；客户标签一对多，需要防止重复计算。',scope:'retail_demo · 多表分析',source:'合成 schema.sql、etl.sql 与业务约定',owner:'演示数据开发',evidenceField:'grain',
      sections:[
        section('upstream','三张加工上游的分工','raw_order_lines 提供订单行、数量、下单日期、渠道与测试标记。raw_payments 提供支付和退款事件，先按 order_id 与 line_id 聚合。dim_customers 提供客户地区，按 customer_id 关联。主表的组合唯一键是 order_id 与 line_id。'),
        section('tags','客户标签不是主表加工上游','customer_tags 是查询时可用的标签素材，一个客户可以有多个标签。直接把它 JOIN 到订单行后再 SUM 金额，会让同一笔金额随着标签重复。只需筛选具有某标签的客户时使用 EXISTS；需要展示所有标签时应先定义结果粒度。'),
        section('missing','缺失维度仍然保留订单','客户未匹配时，region 保持 NULL，不把它猜成任何地区。LEFT JOIN 保留订单行。若用户要求只看已知地区，需要显式增加条件并解释被排除的范围。共享业务主题并不意味着任意两张表都可以无条件连接。')],
      links:[link(tableTarget),link('field:orders:region','missing'),link('table:raw_order_lines','upstream'),link('table:payments','upstream'),link('table:customers','upstream'),link('table:customer_tags','tags'),link('topic:retail_analysis')]},
    {id:'refund-rate-guide',title:'订单退款率的分子与分母',summary:'退款订单要按订单去重，部分退款也属于发生过退款。',scope:'retail_demo · 已支付订单',source:'完全虚构的样例口径',owner:'演示零售分析组',evidenceField:'col.order_status.description',
      sections:[
        section('order-rate','订单口径','分母是时间范围内已支付、非测试的去重订单数。分子是这些订单中有任意退款金额的去重订单数。先在订单行内识别 refunded_amount_cents>0，再对 order_id 去重；同一订单两行退款不能计为两个退款订单。'),
        section('status','订单状态不足以计算退款订单数','order_status=refunded 表示整单全额退完。整单部分退款的订单仍可为 paid，包括其中一条商品行全额退完而另一条保留的情况。因此只数 refunded 状态会漏掉部分退款订单。'),
        section('clarify','什么时候需要澄清','“退款率”还可能指退款金额除以支付金额，或退款客户数除以支付客户数。三种定义的分子与分母不同。用户没有指定时先澄清；没有分母时不能凭字段名补出一个比例。')],
      links:[link(tableTarget),link('field:orders:order_status','status'),link('metric:orders:order_refund_rate','order-rate'),link('topic:retail_analysis')]}
  ];
  let documents = seeds.map(d => ({...d,revision:1,manual:false,status:'合成分析草稿',sourceRevision:demoSource.revision,updatedAt:'2026-10-03 · 合成初始版',versions:[]}));
  let topic={id:'retail_analysis',title:'零售支付与客户分析',description:'围绕虚构订单回答收入、客户和退款问题。订单行、支付事件和客户地区共同组成分析依据；客户标签用于解释查询关联的重复匹配风险。',manual:false,tables:[demoSource.table,...demoAnalysis.relations.map(r=>r[0]),'customer_tags'],revision:1};
  let allDocuments = false;
  let search = '';
  let editing = null;
  let linkedTarget = '';
  const e = value => escapeHTML(value);

  function initialize() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
      if (!saved) return;
      if (!Array.isArray(saved.documents) || !saved.documents.every(d => typeof d.id === 'string' && Array.isArray(d.sections) && Array.isArray(d.links) && Array.isArray(d.versions)) || !Array.isArray(saved.topic?.tables)) throw new Error('Invalid knowledge draft');
      documents = saved.documents; topic = saved.topic;
    } catch { toast('业务文档草稿未能读取，显示合成初始内容；未覆盖原有本机记录。'); }
  }
  function persist(nextDocuments, nextTopic = topic) {
    try {
      localStorage.setItem(storageKey, JSON.stringify({documents: nextDocuments, topic: nextTopic}));
      documents = nextDocuments; topic = nextTopic;
      return true;
    } catch { toast('本机保存失败，编辑内容仍保留在窗口中。'); return false; }
  }
  function targets() {
    return [
      {id: 'topic:retail_analysis', label: `业务主题 · ${topic.title}`},
      ...models.flatMap(m => [
        {id: `table:${m.id}`, label: `表 · ${m.fields.alias.value}`},
        ...m.columns.map(c => ({id: `field:${m.id}:${c.id}`, label: `字段 · ${c.fields.name.value}（${m.fields.alias.value}）`})),
        ...m.metrics.map(x => ({id: `metric:${m.id}:${x.id}`, label: `指标 · ${x.fields.name.value}（${m.fields.alias.value}）`}))
      ]),
      ...demoAnalysis.relations.filter(r => !models.some(m => m.fullName === r[0])).map(r => ({id: `table:${r[0]}`, label: `加工上游 · ${r[0]}`})),
      {id:'table:customer_tags',label:'查询关系 · customer_tags（一对多）'}
    ];
  }
  function targetName(id) { return targets().find(t => t.id === id)?.label || id; }
  function relevant(doc, modelId) { return doc.links.some(l => l.target === `table:${modelId}` || l.target.startsWith(`field:${modelId}:`) || l.target.startsWith(`metric:${modelId}:`)); }
  function count(modelId) { return documents.filter(d => relevant(d, modelId)).length; }
  function sourceChanged(doc) { return Boolean(doc.sourceRevision && (doc.sourceRevision !== demoSource.revision || models.find(m => m.id === 'orders').lineage.sql.manual)); }
  function card(doc, sectionId = '') {
    const s = doc.sections.find(x => x.id === sectionId);
    return `<button class="document-card" data-open-doc="${e(doc.id)}" data-doc-section="${e(sectionId)}"><div class="document-card-heading"><span class="doc-glyph">文</span><strong>${e(doc.title)}</strong>${icon('chevron')}</div><p>${e(s ? `引用章节：${s.title}` : doc.summary)}</p><div class="document-meta"><span class="badge ${doc.manual ? 'manual' : 'inferred'}">${doc.manual ? '人工修改' : '分析草稿'}</span><span>v${doc.revision}</span><span>${doc.links.length} 处关联</span>${sourceChanged(doc) ? '<span class="badge attention">来源变化 · 待复核</span>' : ''}</div></button>`;
  }
  function renderLinks(kind, id) {
    const target = `${kind}:${model.id}${kind === 'table' ? '' : `:${id}`}`;
    const matches = documents.flatMap(d => d.links.filter(l => l.target === target).map(l => ({doc: d, sectionId: l.sectionId})));
    return `<section class="linked-documents"><div class="section-header"><div><h3>详细说明文档 <span class="count-soft">${matches.length}</span></h3><p>可引用完整文档或具体章节，补充背景、边界和例外。</p></div><button class="button" data-link-doc="${e(target)}">${icon('plus')}关联文档</button></div>${matches.length ? `<div class="linked-document-list">${matches.map(x => card(x.doc, x.sectionId)).join('')}</div>` : '<p class="small-note">暂无关联。可以引用已有文档，或新建一份详细说明。</p>'}</section>`;
  }
  function render() {
    const list = documents.filter(d => (allDocuments || relevant(d, model.id)) && `${d.title} ${d.summary} ${d.sections.map(s => s.title + s.body).join(' ')}`.toLowerCase().includes(search.toLowerCase()));
    return `<div class="panel document-intro"><div><span class="eyebrow">长说明也属于语义知识</span><h3>把业务背景、边界和例外写清楚</h3><p>字段或指标保留简明定义；详细说明可以单独维护，再被多个对象引用。Agent 检索时需要一起读取相关章节和计算规则。</p></div><div class="doc-boundary"><strong>本页维护共享业务知识</strong><p>个人历史和偏好在右上角“我的记录与记忆”中管理。</p></div></div>
      <div class="panel"><div class="section-header"><div><h3>说明文档</h3><p>已预填文档全部从零构造；页面用于演示详细说明、章节和多对象引用。</p></div><button class="button primary" data-new-doc="table:${e(model.id)}">${icon('plus')}新建文档</button></div><div class="document-toolbar"><div class="segmented" aria-label="文档范围"><button data-doc-scope="table" class="${allDocuments ? '' : 'selected'}" aria-pressed="${!allDocuments}">当前表相关 ${count(model.id)}</button><button data-doc-scope="all" class="${allDocuments ? 'selected' : ''}" aria-pressed="${allDocuments}">空间文档 ${documents.length}</button></div><label class="search">${icon('search')}<input id="document-search" aria-label="搜索业务文档" placeholder="搜索标题、说明或正文" value="${e(search)}"></label></div><div class="document-grid">${list.map(d => card(d)).join('') || '<p class="empty-state">没有匹配的文档。可切换到空间文档或新建说明。</p>'}</div></div>
      <div class="panel"><div class="section-header"><div><h3>业务主题 · ${e(topic.title)}</h3><p>把多张表、指标和说明组织到同一个业务背景下。</p></div><button class="button" data-edit-topic>编辑主题</button></div><p class="topic-description">${e(topic.description)}</p><div class="document-meta"><span class="badge ${topic.manual ? 'manual' : 'inferred'}">${topic.manual ? '人工修改' : '分析预填'}</span><span>主题 v${topic.revision}</span><span>${topic.tables.length} 张表</span><span>${documents.filter(d => d.links.some(l => l.target === 'topic:retail_analysis')).length} 份关联文档</span></div><details class="topic-tables"><summary>查看涉及的表与分工 ${icon('chevron')}</summary>${topic.tables.map(t => `<div><code>${e(t)}</code><span>${e(t === demoSource.table ? '订单行分析明细' : demoAnalysis.relations.find(r => r[0] === t)?.[1] || (t === 'customer_tags' ? '查询时提供客户标签（1:N）' : '业务角色待补充'))}</span></div>`).join('')}</details><p class="small-note">共享业务背景不等于可以直接关联查询；查询仍使用经过核对的关联条件。</p></div>`;
  }
  function showDialog(title, content) {
    $('#knowledge-title').textContent = title;
    $('#knowledge-detail').innerHTML = content;
    const dialog = $('#knowledge-dialog');
    if (!dialog.open) dialog.showModal();
    dialog.scrollTop = 0;
  }
  function openDoc(id, sectionId = '') {
    const doc = documents.find(d => d.id === id); if (!doc) return;
    editing = null;
    showDialog(doc.title, `<div class="document-meta"><span class="badge ${doc.manual ? 'manual' : 'inferred'}">${doc.manual ? '人工修改' : '分析草稿'}</span><span>v${doc.revision} · ${e(doc.status)}</span><span>${e(doc.updatedAt)}</span></div><p class="doc-lead">${e(doc.summary)}</p><div class="doc-facts"><p><strong>适用范围</strong>${e(doc.scope)}</p><p><strong>维护者</strong>${e(doc.owner)}</p><p><strong>初始依据</strong>${e(doc.source)}</p><p><strong>当前来源版本</strong>${e(doc.sourceRevision || '人工录入')}</p></div>${doc.evidenceField && model.id === 'orders' ? `<button class="quiet-link" data-source="${e(doc.evidenceField)}">查看 DDL / SQL 原文依据 ${icon('arrow')}</button>` : ''}<nav class="document-outline" aria-label="文档章节">${doc.sections.map(s => `<button data-scroll-section="${e(s.id)}">${e(s.title)}</button>`).join('')}</nav><div class="document-body">${doc.sections.map(s => `<section id="doc-section-${e(s.id)}" class="${s.id === sectionId ? 'section-highlight' : ''}"><h3>${e(s.title)}</h3><div class="document-prose">${e(s.body)}</div></section>`).join('')}</div><details class="document-references"><summary>这份文档被 ${doc.links.length} 处引用</summary>${doc.links.map(l => `<p>${e(targetName(l.target))}<span>${l.sectionId ? ` → ${e(doc.sections.find(s => s.id === l.sectionId)?.title || '章节已变化，待核对')}` : ' → 整篇文档'}</span></p>`).join('')}</details><div class="dialog-actions"><button class="button" data-doc-versions="${e(doc.id)}">版本与来源</button><button class="button primary" data-edit-doc="${e(doc.id)}">编辑文档与关联</button></div>`);
    if (sectionId) requestAnimationFrame(() => document.getElementById(`doc-section-${sectionId}`)?.scrollIntoView({block: 'center'}));
  }
  function editor(doc) {
    editing = clone(doc);
    showDialog(doc.revision ? `编辑 · ${doc.title}` : '新建业务文档', `<form id="document-form"><div class="form-grid"><label class="field full">文档标题<input required name="title" class="form-input" value="${e(doc.title)}"></label><label class="field full">简要说明<textarea name="summary" class="form-input">${e(doc.summary)}</textarea></label><label class="field full">适用范围与边界<textarea required name="scope" class="form-input">${e(doc.scope)}</textarea></label><label class="field full">维护者<input required name="owner" class="form-input" value="${e(doc.owner)}"></label></div><div id="document-sections">${doc.sections.map(s => sectionEditor(s)).join('')}</div><button type="button" class="button" data-add-section>${icon('plus')}增加章节</button><section class="document-link-editor"><h3>关联到哪些对象</h3><p class="small-note">每处关联可定位一个章节。编辑的是同一份文档，保存后所有引用都读取新版本。</p><div id="editing-links"></div><div class="link-controls"><label>对象<select id="link-target" class="form-input">${targets().map(t => `<option value="${e(t.id)}">${e(t.label)}</option>`).join('')}</select></label><label>章节<select id="link-section" class="form-input"><option value="">整篇文档</option>${doc.sections.map(s => `<option value="${e(s.id)}">${e(s.title)}</option>`).join('')}</select></label><button type="button" class="button" data-add-link>添加关联</button></div></section><p class="small-note">保存会生成新版本并标记人工修改。更改算法或过滤时，还需核对对应指标规则。</p><div class="dialog-actions"><button type="button" class="button" data-knowledge-close>取消编辑</button><button type="submit" class="button primary">保存文档到本机</button></div></form>`);
    renderEditingLinks();
  }
  function sectionEditor(s) { return `<section class="section-editor" data-edit-section="${e(s.id)}"><label>章节标题<input required class="form-input" data-section-title value="${e(s.title)}"></label><label>正文<textarea required class="form-input document-textarea" data-section-body>${e(s.body)}</textarea></label></section>`; }
  function renderEditingLinks() {
    $('#editing-links').innerHTML = editing.links.map((l, i) => `<div class="editing-link"><span>${e(targetName(l.target))}<small>${e(l.sectionId ? editing.sections.find(s => s.id === l.sectionId)?.title || '新章节' : '整篇文档')}</small></span><button type="button" class="quiet-link" data-remove-link="${i}">移除关联</button></div>`).join('') || '<p class="small-note">暂未关联。仍可从空间文档检索这份说明。</p>';
  }
  function saveDocument(next) {
    const current = documents.find(d => d.id === next.id);
    const {versions = [], ...snapshot} = current || {};
    const updated = {...next, manual: true, revision: (current?.revision || 0) + 1, status: '待核对', updatedAt: new Date().toLocaleString('zh-CN'), versions: current ? [...versions, snapshot] : []};
    const list = current ? documents.map(d => d.id === updated.id ? updated : d) : [...documents, updated];
    if (!persist(list)) return false;
    renderPage();
    openDoc(updated.id);
    toast(`文档 v${updated.revision} 已存本机，${updated.links.length} 处引用共用这一版内容。`);
    return true;
  }
  function renderPage() { window.renderSemanticPage(); }
  function openLink(target) {
    linkedTarget = target;
    showDialog('关联详细说明', `<p class="doc-lead">${e(targetName(target))}</p><form id="associate-form"><label class="field">选择文档<select class="form-input" id="associate-doc">${documents.map(d => `<option value="${e(d.id)}">${e(d.title)}</option>`).join('')}</select></label><label class="field">定位章节<select class="form-input" id="associate-section"></select></label><p class="small-note">关联已有内容会复用同一份说明，原文不会复制到字段里。</p><div class="dialog-actions"><button type="button" class="button" data-new-doc="${e(target)}">新建并关联</button><button type="submit" class="button primary">保存关联到本机</button></div></form>`);
    populateSections();
  }
  function populateSections() {
    const d = documents.find(x => x.id === $('#associate-doc').value);
    $('#associate-section').innerHTML = '<option value="">整篇文档</option>' + (d?.sections || []).map(s => `<option value="${e(s.id)}">${e(s.title)}</option>`).join('');
  }
  function versions(id) {
    const doc = documents.find(d => d.id === id);
    const {versions: history, ...current} = doc;
    showDialog(`${doc.title} · 版本与来源`, `<p class="doc-lead">原始分析和每次保存的内容都保留。本机原型没有多人编辑与服务端版本控制。</p>${[...history, current].reverse().map((v, i) => `<details class="version-entry" ${i === 0 ? 'open' : ''}><summary>v${v.revision} · ${v.manual ? '人工修改' : '分析草稿'} · ${e(v.updatedAt)}</summary><p class="small-note">${e(v.source)} · ${e(v.scope)}</p>${v.sections.map(s => `<h4>${e(s.title)}</h4><div class="document-prose">${e(s.body)}</div>`).join('')}</details>`).join('')}<div class="dialog-actions"><button class="button" data-open-doc="${e(id)}">返回当前文档</button></div>`);
  }

  document.addEventListener('click', event => {
    const b = event.target.closest('button'); if (!b) return;
    if (b.hasAttribute('data-knowledge-close')) { editing = null; $('#knowledge-dialog').close(); }
    if (b.dataset.openDoc) openDoc(b.dataset.openDoc, b.dataset.docSection);
    if (b.dataset.editDoc) editor(documents.find(d => d.id === b.dataset.editDoc));
    if (b.dataset.docVersions) versions(b.dataset.docVersions);
    if (b.dataset.scrollSection) document.getElementById(`doc-section-${b.dataset.scrollSection}`)?.scrollIntoView({block: 'start', behavior: 'smooth'});
    if (b.dataset.docScope) { allDocuments = b.dataset.docScope === 'all'; window.renderSemanticPage(); }
    if (b.dataset.linkDoc) openLink(b.dataset.linkDoc);
    if (b.dataset.newDoc) editor({id: `doc-${crypto.randomUUID()}`, title: '', summary: '', scope: '', owner: '数据开发（本机演示）', source: '人工录入', sourceRevision: '', revision: 0, links: [link(b.dataset.newDoc)], sections: [section('introduction', '业务说明', '')], versions: []});
    if (b.hasAttribute('data-add-section')) {
      const s = section(`section-${crypto.randomUUID()}`, '新章节', ''); editing.sections.push(s);
      $('#document-sections').insertAdjacentHTML('beforeend', sectionEditor(s));
      $('#link-section').insertAdjacentHTML('beforeend', `<option value="${s.id}">新章节</option>`);
      $('#document-sections').lastElementChild.querySelector('input').focus();
    }
    if (b.hasAttribute('data-add-link')) {
      const next = link($('#link-target').value, $('#link-section').value);
      if (!editing.links.some(l => l.target === next.target && l.sectionId === next.sectionId)) editing.links.push(next);
      renderEditingLinks();
    }
    if (b.hasAttribute('data-remove-link')) { editing.links.splice(Number(b.dataset.removeLink), 1); renderEditingLinks(); }
    if (b.hasAttribute('data-edit-topic')) {
      showDialog('编辑业务主题', `<form id="topic-form"><label class="field">主题名称<input required name="title" class="form-input" value="${e(topic.title)}"></label><label class="field">业务说明<textarea required name="description" class="form-input document-textarea">${e(topic.description)}</textarea></label><label class="field">涉及的表（每行一张）<textarea required name="tables" class="form-input document-textarea">${e(topic.tables.join('\n'))}</textarea></label><p class="small-note">这里组织业务背景；字段规则、指标和文档通过各自关联复用。</p><div class="dialog-actions"><button type="submit" class="button primary">保存主题到本机</button></div></form>`);
    }
  });
  document.addEventListener('input', event => {
    if (event.target.id === 'document-search') {
      search = event.target.value;
      const start = event.target.selectionStart; window.renderSemanticPage(); $('#document-search').focus(); $('#document-search').setSelectionRange(start, start);
    }
    if (event.target.hasAttribute('data-section-title') && editing) {
      const id = event.target.closest('[data-edit-section]').dataset.editSection;
      editing.sections.find(s => s.id === id).title = event.target.value;
      const option = [...$('#link-section').options].find(o => o.value === id); if (option) option.textContent = event.target.value;
      renderEditingLinks();
    }
  });
  document.addEventListener('change', event => { if (event.target.id === 'associate-doc') populateSections(); });
  document.addEventListener('submit', event => {
    if (event.target.id === 'document-form') {
      event.preventDefault();
      const data = new FormData(event.target);
      const next = {...editing, ...Object.fromEntries(data), sections: $$('[data-edit-section]').map(el => ({id: el.dataset.editSection, title: $('[data-section-title]', el).value.trim(), body: $('[data-section-body]', el).value.trim()}))};
      if (!next.title.trim() || !next.scope.trim() || !next.owner.trim() || next.sections.some(s => !s.title || !s.body)) { toast('请填写标题、适用范围、维护者和章节正文。'); return; }
      saveDocument(next);
    }
    if (event.target.id === 'associate-form') {
      event.preventDefault(); const d = documents.find(x => x.id === $('#associate-doc').value);
      const next = link(linkedTarget, $('#associate-section').value);
      if (d.links.some(l => l.target === next.target && l.sectionId === next.sectionId)) { toast('已存在相同的文档与章节关联。'); return; }
      saveDocument({...d, links: [...d.links, next]});
    }
    if (event.target.id === 'topic-form') {
      event.preventDefault(); const f = new FormData(event.target);
      const next = {...topic, title: f.get('title').trim(), description: f.get('description').trim(), tables: [...new Set(f.get('tables').split('\n').map(x => x.trim()).filter(Boolean))], manual: true, revision: topic.revision + 1};
      if (!next.title || !next.description || !next.tables.length) { toast('请填写主题名称、说明和涉及的表。'); return; }
      if (persist(documents, next)) { $('#knowledge-dialog').close(); renderPage(); toast('业务主题已保存到本机。'); }
    }
  });
  return {initialize, render, renderLinks, count, openDoc};
})();

/* 全虚构零售样例：仅在浏览器中演示维护流程，不连接账号、模型或数据平台。 */
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const labels = {synced:'样例原文', inferred:'分析补充', manual:'人工修改'};
const sourceNames = {synced:'全虚构样例原文', inferred:'基于合成 DDL / SQL 整理的分析草稿', manual:'人工新增'};
function item(key,label,value,source='synced',origin='',options={}) {
  return {key,label,value:String(value),prefill:String(value),source,origin,manual:false,refs:[],...options};
}
function createMetric(id,name,description,expression,entity,time,table){
  const f=(key,label,value,options={})=>item(`${id}.${key}`,label,value,'inferred','合成业务规则草稿；本页面不执行 SQL',options);
  return {id,status:'待确认',fields:{
    name:f('name','指标名称',name),identifier:f('identifier','指标标识',id,{mono:true}),
    description:f('description','指标含义',description,{textarea:true}),expression:f('expression','计算表达式',expression,{mono:true}),
    entity:f('entity','统计对象 / 去重键',entity,{mono:true}),time:f('time','业务时间字段',time,{mono:true}),
    dimension:f('dimension','可分析维度','channel、region（需要时重新计算分组）'),
    filter:f('filter','计算条件',"paid_at >= '2026-01-01' AND paid_at < '2026-02-01' AND is_test = 0",{textarea:true}),
    notes:f('notes','适用说明','SQL 使用 SQLite 样例方言；正式应用持久库的 MySQL 选型不受影响。',{textarea:true}),
    sql:f('sql','计算 SQL',`SELECT ${expression || 'COUNT(*)'} AS ${id} FROM ${table};`)
  }};
}
function createModel(config){
  const main=config.id==='orders';
  const field=(key,label,value,options={})=>item(key,label,value,'synced','全虚构零售样例元数据',options);
  const m={...config,real:true,saved:false,confirmations:{},relations:[],issues:[],fields:{
    alias:field('alias','中文名称',config.title),maintainer:field('maintainer','维护者','演示数据开发'),
    full_name:field('full_name','表名',config.fullName,{mono:true}),workspace:field('workspace','数据空间','retail_demo'),
    dw_layer:field('dw_layer','数据分层',main?'分析明细':'合成来源'),business_owner:field('business_owner','业务负责人','演示零售分析组'),
    description:field('description','业务说明',config.description,{textarea:true}),grain:field('grain','一行代表什么',config.grain,{textarea:true}),
    unique_key:field('unique_key','唯一键',config.key),time_field:field('time_field','业务时间',config.time),
    partition:field('partition','分区 / 日期列',main?'无物理分区；order_date 是下单日期':'SQLite 样例未分区'),
    update_frequency:field('update_frequency','更新频率','本地重建样例；无真实调度'),update_method:field('update_method','更新方式','读取合成来源构建演示数据'),
    lifecycle:field('lifecycle','保留约定','仅演示数据，可由样例脚本重建'),usage:field('usage','适用问题',config.usage,{textarea:true}),
    caveats:field('caveats','使用提醒',config.caveats,{textarea:true})},columns:[],metrics:[]};
  if(main) for(const [key,a] of Object.entries(demoAnalysis.overview)) {
    if(m.fields[key]) Object.assign(m.fields[key],{value:a[0],prefill:a[0],source:'inferred',origin:a[1],refs:a[2]||[]});
  }
  m.columns=demoSource.columns[config.fullName].map(c=>{
    const a=main?demoAnalysis.columns[c.name]||{}:{};
    const cf=(key,label,value,options={})=>item(`col.${c.name}.${key}`,label,value,['name','type'].includes(key)?'synced':'inferred',a.origin||'合成 schema.sql / etl.sql 与样例业务说明',{rawValue:key==='description'?demoSource.ddl.split('\n')[c.line-1].trim():undefined,refs:a.refs||[{file:'ddl',start:c.line,end:c.line}],...options});
    return {id:c.name,a,fields:{name:cf('name','字段名',c.name),type:cf('type','类型',c.type),description:cf('description','业务含义',a.description||c.description,{textarea:true}),role:cf('role','语义角色',a.role||'业务属性'),rule:cf('rule','取值与使用规则',a.rule||c.description,{textarea:true}),calculation:cf('calculation','计算与来源',a.calculation||'样例脚本直接写入',{textarea:true}),caution:cf('caution','使用提醒',a.caution||'仅用于虚构样例分析。',{textarea:true})},children:[]};
  });
  const lf=(key,label,value,options={})=>item(key,label,value,'synced','本地合成加工脚本；调度信息为演示值',options);
  m.lineage={upstream:lf('upstream','上游来源',main?'raw_order_lines、raw_payments、dim_customers':'seed.sql 合成记录'),downstream:lf('downstream','目标表',config.fullName),node_id:lf('node_id','节点标识',main?'demo_build_order_detail':'demo_seed'),process_id:lf('process_id','流程标识','demo_retail_load'),node_name:lf('node_name','节点名称',main?'组装订单行与支付汇总':'载入合成来源'),process_name:lf('process_name','流程名称','虚构零售样例构建'),relation_source:lf('relation_source','血缘来源','合成 SQL'),is_relation_valid:lf('is_relation_valid','关系状态','示例'),join_rule:lf('join_rule','关联说明',main?'支付事件先按订单与行汇总，再关联订单行；客户维度按 customer_id 关联。customer_tags 仅在查询时按需使用。':'此表由合成 seed.sql 直接载入。',{textarea:true}),sql:lf('node_sql','加工 SQL',main?demoSource.sql:`-- 此表由 docs/sources/seed.sql 载入合成记录。\nSELECT * FROM ${config.fullName};`)};
  if(main){
    m.relations=demoAnalysis.relations.map((r,index)=>({id:`relation-${index}`,fields:{table:lf(`relation.${index}.table`,'上游表',r[0]),purpose:lf(`relation.${index}.purpose`,'提供什么',r[1]),condition:lf(`relation.${index}.condition`,'关联条件',r[2]),caution:lf(`relation.${index}.caution`,'使用提醒',r[3])}}));
    m.issues=demoAnalysis.issues;
    m.metrics=demoAnalysis.metrics.map(a=>{const metric=createMetric(a.id,a.name,a.description,a.expression,a.entity,'paid_at',config.fullName);for(const key of ['sql','filter','notes','dimension'])if(a[key])Object.assign(metric.fields[key],{value:a[key],prefill:a[key]});return metric;});
  } else {
    const metric=createMetric(`${config.id}_rows`,'样例记录数','当前合成来源表的行数。','COUNT(*)','行','不限定日期',config.fullName);
    for(const [key,value] of Object.entries({filter:'所有合成记录；不套用主表的支付过滤。',dimension:'当前表整体',notes:'行数属于演示数据检查，不代表订单数或客户数。'}))Object.assign(metric.fields[key],{value,prefill:value});
    m.metrics=[metric];
  }
  return m;
}
const models=[
  {id:'orders',name:'demo_order_detail',fullName:'demo_order_detail',title:'零售订单行明细',subtitle:'全虚构 · 13 个字段',description:'订单行、支付事件与客户维度组装成的分析样例。',grain:'一个订单中的一条商品行。',key:'order_id + line_id',time:'paid_at（UTC 支付时间）',usage:'净收入、支付客户 UV、订单退款率。',caveats:'测试订单需排除；金额以分保存；客户标签关联可能放大行数。'},
  {id:'payments',name:'raw_payments',fullName:'raw_payments',title:'支付与退款事件',subtitle:'全虚构 · 来源表',description:'记录订单行的支付与退款事件。',grain:'一次支付或退款事件。',key:'payment_event_id',time:'event_at（UTC）',usage:'核对支付和退款如何汇总到订单行。',caveats:'一条订单行可对应多条事件；先汇总再关联。'},
  {id:'customers',name:'dim_customers',fullName:'dim_customers',title:'客户地区维度',subtitle:'全虚构 · 来源表',description:'提供合成客户的地区。',grain:'一个已知客户。',key:'customer_id',time:'无事件时间',usage:'补充订单的客户地区。',caveats:'未匹配客户保持 NULL；客户标签在另一个一对多表中。'}
].map(createModel);
let model=models[0];
const requestedTab=new URLSearchParams(window.location.search).get('tab');
let activeTab=['overview','fields','lineage','metrics','documents','history'].includes(requestedTab)?requestedTab:'overview';
let metricId='paid_customer_uv';
let focusedField='description';
let currentSourceKey=null;
let toastTimer;
let fieldSearch='';
let onlyManualFields=false;
let onlyPendingFields=false;
let expandedColumns=new Set();
const draftKey='data-agent-retail-synthetic-v1-semantic';
function modelFields(m){return [...Object.values(m.fields),...m.columns.flatMap(c=>[...Object.values(c.fields),...(c.children||[]).flatMap(ch=>Object.values(ch.fields))]),...Object.values(m.lineage),...(m.relations||[]).flatMap(r=>Object.values(r.fields)),...m.metrics.flatMap(metric=>Object.values(metric.fields))];}
function allFields(){return modelFields(model);}
function getField(key){return allFields().find(f=>f.key===key);}
function manualFields(){return allFields().filter(f=>f.manual);}
function fieldTitle(field){
  const column=model.columns.find(c=>[...Object.values(c.fields),...(c.children||[]).flatMap(ch=>Object.values(ch.fields))].includes(field));
  return column?`${column.fields.name.value} · ${field.label}`:field.label;
}
function scopeForField(field){
  const column=model.columns.find(c=>[...Object.values(c.fields),...(c.children||[]).flatMap(ch=>Object.values(ch.fields))].includes(field));
  if(column)return `column:${column.id}`;
  const metric=model.metrics.find(m=>Object.values(m.fields).includes(field));
  return metric?`metric:${metric.id}`:`field:${['grain','unique_key'].includes(field.key)?'grain':field.key}`;
}
function scopeConfirmed(scope){return Boolean(model.confirmations[scope]);}
function confirmControl(scope){return `<button class="button ${scopeConfirmed(scope)?'':'primary'}" data-confirm-scope="${escapeHTML(scope)}">${scopeConfirmed(scope)?'撤销确认':'确认本项说明'}</button>`;}
function columnState(c){return scopeConfirmed(`column:${c.id}`)?'已确认':c.a?.issue|| (c.fields.description.source==='inferred'?'分析草稿':'原始说明');}
function refreshSummary(){
  const issues=model.issues||[];
  const pending=issues.filter(i=>!scopeConfirmed(i.scope));
  const box=$('#review-summary');
  box.hidden=!issues.length;
  if(!issues.length)return;
  box.innerHTML=`<summary><span class="review-title">${icon('info')}<strong>${pending.length?`${pending.length} 项待核实`:'本轮问题均已确认'}</strong><span>优先检查说明冲突和缺失依据</span></span><span class="review-toggle">展开查看 ${icon('chevron')}</span></summary><div class="review-items">${issues.map(i=>`<button class="review-item ${scopeConfirmed(i.scope)?'is-resolved':''}" data-issue="${i.id}"><span class="issue-dot"></span><span><strong>${escapeHTML(i.title)}</strong><small>${escapeHTML(i.detail)}</small></span><span class="review-action">${scopeConfirmed(i.scope)?'已确认':'去核实'} ${icon('chevron')}</span></button>`).join('')}</div>`;
}
function badge(field,clickable=false){
  const kind=field.manual?'manual':field.source;
  const b=`<span class="badge ${kind}">${field.manual?icon('edit'):''}${labels[kind]}</span>`;
  return clickable?`<button class="source-button" data-source="${escapeHTML(field.key)}" title="查看${escapeHTML(field.label)}的来源与预填值" aria-label="查看${escapeHTML(field.label)}的来源">${b}</button>`:b;
}
function renderField(field,options={}){
  const multiline=options.textarea??field.textarea;
  const cls=`form-input${field.mono?' mono':''}${field.manual?' is-manual':''}`;
  const control=multiline
    ? `<textarea id="f-${escapeHTML(field.key)}" data-field="${escapeHTML(field.key)}" class="${cls}" rows="${options.rows||2}">${escapeHTML(field.value)}</textarea>`
    : `<input id="f-${escapeHTML(field.key)}" data-field="${escapeHTML(field.key)}" class="${cls}" value="${escapeHTML(field.value)}" autocomplete="off">`;
  return `<div class="field${options.full?' full':''}"><div class="field-label"><label class="label-text" for="f-${escapeHTML(field.key)}">${escapeHTML(field.label)}</label><span data-badge="${escapeHTML(field.key)}">${badge(field,true)}</span></div>${control}${options.hint?`<div class="field-hint">${escapeHTML(options.hint)}</div>`:''}</div>`;
}
function sectionHeader(index,title,subtitle,action=''){
  return `<div class="section-header"><div><h3>${index?`<span class="section-index">${index}</span>`:''}${title}</h3>${subtitle?`<p>${subtitle}</p>`:''}</div>${action}</div>`;
}
function renderCatalog(){
  const query=$('#table-search').value.trim().toLowerCase();
  const shown=models.filter(t=>(t.name+t.fields.alias.value+t.fullName).toLowerCase().includes(query));
  $('#table-count').textContent=shown.length;
  $('#table-list').innerHTML=shown.map(t=>`<button class="table-item${model.id===t.id?' active':''}" data-table="${t.id}" aria-current="${model.id===t.id?'page':'false'}">${icon('table')}<div><strong>${escapeHTML(t.fields.alias.value)}</strong><code>${escapeHTML(t.fullName)}</code><span class="item-state">${escapeHTML(t.subtitle)}</span></div></button>`).join('')||'<div class="empty-state">没有匹配的示例表</div>';
}
function renderHeader(){
  $('#table-title').textContent=model.fields.alias.value||'未命名数据表';
  $('#table-full-name').textContent=model.fields.full_name.value;
  $('#table-layer').textContent=model.fields.dw_layer.value;
  $('#changes-count').textContent=manualFields().length;
  $('#fields-count').textContent=model.columns.length;
  $('#metrics-count').textContent=model.metrics.length;
  $('#documents-count').textContent=semanticKnowledge.count(model.id);
  $('#draft-status').textContent=model.saved?'已存本机':'草稿';
  $('#material-label').textContent='全虚构零售样例 · 分析草稿';
  $('#material-note').textContent='依据：从零编写的合成 DDL、加工 SQL 和业务说明；本页面未接入平台或执行查询。';
  if(model.real&&model.lineage.sql.manual)$('#material-note').textContent='加工 SQL 草稿已被修改。当前分析依据仍对应合成资料初始版本，需要重新分析后核对。';
  $('#save-status').textContent=model.saved?'已保存到当前浏览器':'未保存的修改仅保留在当前页面';
  refreshSummary();
  $$('.tab').forEach(el=>{const active=el.dataset.tab===activeTab;el.classList.toggle('active',active);el.setAttribute('aria-selected',String(active));el.tabIndex=active?0:-1;});
}
function sourceBlock(ref,compact=false){
  if(!model.real)return '';
  const lines=(ref.file==='ddl'?demoSource.ddl:demoSource.sql).split('\n');
  const end=Math.min(ref.end,compact?ref.start+6:ref.end,lines.length);
  const excerpt=lines.slice(ref.start-1,end);
  const indents=excerpt.filter(line=>line.trim()).map(line=>line.search(/\S/));
  const indent=indents.length?Math.min(...indents):0;
  return `<div class="code-evidence"><div>${ref.file==='ddl'?'原始 DDL':'加工 SQL'} · 第 ${ref.start}${end===ref.start?'':`–${end}`} 行${end<ref.end?'（节选）':''}</div><ol start="${ref.start}">${excerpt.map(line=>`<li><code>${escapeHTML(line.slice(indent))}</code></li>`).join('')}</ol></div>`;
}
function renderEvidence(){
  const focus=getField(focusedField);
  if(model.real){
    $('#evidence').innerHTML=`<div class="evidence-heading"><h3>为什么这样预填</h3>${icon('flow')}</div><p class="evidence-subtitle">选择一项内容，查看它的原始资料与分析依据。</p><div class="focused-evidence"><strong>${escapeHTML(focus?fieldTitle(focus):'表说明')}</strong><p>${escapeHTML(focus?.origin||'合成 DDL 和加工 SQL')}</p></div>${focus?.refs?.length?sourceBlock(focus.refs.find(r=>r.file==='sql')||focus.refs[0],true):'<p class="small-note evidence-missing">当前材料未提供直接依据；此项保留待补充或待确认。</p>'}${focus?`<button class="button evidence-open" data-source="${escapeHTML(focus.key)}">查看原文与完整依据 ${icon('chevron')}</button>`:''}<div class="evidence-hint"><strong>修改来源与确认状态分别记录</strong>人工修改保留标识；修改已确认的说明后，会重新变为待确认。保存草稿后可在本机继续编辑。</div>`;
    return;
  }
  $('#evidence').innerHTML='<p>选择字段查看合成依据。</p>';
}
function renderOverview(){
  const f=model.fields;
  return `<div class="panel">${sectionHeader('01','表的基本信息','复用已有元数据，可在此补充或修正。')}
    <div class="form-grid">${renderField(f.alias)}${renderField(f.maintainer)}${renderField(f.full_name,{full:true})}</div>
    <div class="basic-details">${renderField(f.workspace)}${renderField(f.dw_layer)}${renderField(f.business_owner)}</div>
    </div>
    <div class="panel">${sectionHeader('02','业务语义','说明这张表能解决什么问题，以及一行数据代表什么。')}
    <div class="form-grid">${renderField(f.description,{full:true})}${renderField(f.grain,{full:true})}${renderField(f.unique_key)}${renderField(f.time_field)}</div>${model.real?`<div class="confirmation-row"><span>确认说明表示已核对当前表述；数据唯一性仍需实际检查。</span>${confirmControl('field:grain')}</div>`:''}</div>
    <div class="panel">${sectionHeader('03','更新与使用约定','让查询范围与数据更新方式保持一致。')}
    <div class="form-grid">${renderField(f.partition)}${renderField(f.update_frequency)}${renderField(f.update_method)}${renderField(f.lifecycle)}${renderField(f.usage,{full:true})}${renderField(f.caveats,{full:true})}</div></div><div class="panel">${semanticKnowledge.renderLinks('table')}</div>`;
}
function renderColumns(){
  return `<div class="panel columns-panel">${sectionHeader('','字段说明',model.real?`${model.columns.length} 个字段。展开可修改说明、查看计算依据与使用提醒。`:'合成字段示例；展开可编辑。')}
    <div class="field-toolbar"><label class="search">${icon('search')}<input id="field-search" aria-label="搜索字段" placeholder="搜索字段、含义或扩展子项" value="${escapeHTML(fieldSearch)}"></label><label class="check-label"><input type="checkbox" id="manual-filter" ${onlyManualFields?'checked':''}>人工修改</label><label class="check-label"><input type="checkbox" id="pending-filter" ${onlyPendingFields?'checked':''}>待核实</label><span id="visible-fields-count" class="small-note"></span></div>
    <div class="column-list" id="field-rows">${renderColumnRows()}</div><div id="field-empty" class="empty-state" hidden>没有匹配的字段</div></div>`;
}
function renderColumnRows(){
  return model.columns.map(c=>`<details class="column-card" data-column="${c.id}" ${expandedColumns.has(c.id)?'open':''}><summary><span class="column-toggle">${icon('chevron')}</span><span class="column-name"><code>${escapeHTML(c.fields.name.value)}</code><span class="column-type" title="${escapeHTML(c.fields.type.value)}">${escapeHTML(c.fields.type.value)}</span></span><span class="column-description">${escapeHTML(c.fields.description.value)}</span><span class="column-status"><span class="badge ${scopeConfirmed(`column:${c.id}`)?'confirmed':c.a?.issue?'attention':'synced'}">${escapeHTML(columnState(c))}</span>${Object.values(c.fields).some(f=>f.manual)||(c.children||[]).some(ch=>Object.values(ch.fields).some(f=>f.manual))?'<span class="badge manual">人工修改</span>':''}</span></summary><div class="column-detail">
    <div class="column-detail-heading"><div><strong>字段说明与使用规则</strong><p>内容均可修改；原始资料和分析草稿保留在依据中。</p></div><button class="button" data-source="${c.fields.description.key}">查看依据</button></div>
    ${c.a?.issue?`<div class="inline-question"><strong>${escapeHTML(c.a.issue)}</strong><span>${escapeHTML(c.a.caution||'需要补充上游资料或业务解释。')}</span></div>`:''}
    <div class="form-grid">${renderField(c.fields.name)}${renderField(c.fields.type)}${renderField(c.fields.description,{full:true})}${renderField(c.fields.role)}${c.fields.rule?renderField(c.fields.rule,{full:true}):''}${c.fields.calculation?renderField(c.fields.calculation,{full:true}):''}${c.fields.caution?renderField(c.fields.caution,{full:true}):''}</div>
    ${c.children?.length?`<section class="map-children"><h4>本节点新增的 ${c.children.length} 个子项</h4><p>每个子项都可补充说明；上游可能还有其他内容。</p>${c.children.map(ch=>`<details class="map-child"><summary><code>${escapeHTML(ch.name)}</code>${icon('chevron')}</summary><div class="form-grid">${Object.values(ch.fields).map(f=>renderField(f,{full:true})).join('')}</div></details>`).join('')}</section>`:''}
    ${semanticKnowledge.renderLinks('field',c.id)}<div class="confirmation-row"><span class="confirmation-status">${scopeConfirmed(`column:${c.id}`)?'当前说明已人工确认':'核对说明与依据后，可以确认本项。'}</span>${confirmControl(`column:${c.id}`)}</div></div></details>`).join('');
}
function filterColumns(){
  let count=0;
  const visible=[];
  $$('[data-column]').forEach(row=>{
    const c=model.columns.find(c=>c.id===row.dataset.column);
    const values=[...Object.values(c.fields),...(c.children||[]).flatMap(ch=>Object.values(ch.fields))];
    const matches=[...values.map(f=>f.value),...(c.children||[]).map(ch=>ch.name)].some(v=>v.toLowerCase().includes(fieldSearch.toLowerCase()))&&(!onlyManualFields||values.some(f=>f.manual))&&(!onlyPendingFields||(c.a?.issue&&!scopeConfirmed(`column:${c.id}`)));
    row.hidden=!matches;if(matches){count++;visible.push(c);}
  });
  if($('#field-empty'))$('#field-empty').hidden=count>0;
  if($('#visible-fields-count'))$('#visible-fields-count').textContent=`${count} / ${model.columns.length} 项`;
  if(visible.length&&!visible.some(c=>[...Object.values(c.fields),...(c.children||[]).flatMap(ch=>Object.values(ch.fields))].some(f=>f.key===focusedField))){focusedField=visible[0].fields.description.key;renderEvidence();}
}
function sqlEditor(field,caption){
  return `<div class="sql-block"><div class="sql-toolbar"><div>${icon('code')}<label for="sql-${escapeHTML(field.key)}">${caption}</label><span data-badge="${escapeHTML(field.key)}">${badge(field,true)}</span></div><button class="quiet-link" data-copy="${escapeHTML(field.key)}">${icon('copy')}复制</button></div><textarea id="sql-${escapeHTML(field.key)}" aria-label="${caption}" spellcheck="false" class="sql-editor" data-field="${escapeHTML(field.key)}">${escapeHTML(field.value)}</textarea><div class="sql-footer"><span>${field.key==='node_sql'&&model.real?'来源：合成加工 SQL':'候选 SQL · 口径待核对'}</span><span>尚未执行验证</span></div></div>`;
}
function renderMetrics(){
  const metric=model.metrics.find(m=>m.id===metricId)||model.metrics[0];
  metricId=metric.id;const f=metric.fields;
  return `<div class="metric-workspace"><aside class="metric-list"><div class="metric-list-title"><span>这张表支持的指标</span><span>${model.metrics.length}</span></div>${model.metrics.map(m=>`<button class="metric-item${m.id===metric.id?' selected':''}" data-metric="${m.id}"><strong>${escapeHTML(m.fields.name.value||'新指标')}</strong><code>${escapeHTML(m.fields.identifier.value)}</code><span class="metric-status">${m.status==='已人工确认'?'已人工确认':'待确认'}${Object.values(m.fields).some(f=>f.manual)?' · 人工修改':''}</span></button>`).join('')}<button class="button metric-add" id="add-metric">${icon('plus')}新增指标</button></aside>
    <div class="metric-editor">${sectionHeader('','指标定义与计算 SQL','口径与 SQL 并排维护，修改后核对两者是否一致。',`<select class="metric-state-select" id="metric-state" aria-label="指标口径确认状态"><option ${metric.status==='待确认'?'selected':''}>待确认</option><option ${metric.status==='已人工确认'?'selected':''}>已人工确认</option></select>`)}
    <div class="metric-body"><div class="form-grid">${renderField(f.name)}${renderField(f.identifier)}${renderField(f.description,{full:true})}${renderField(f.expression,{full:true})}${renderField(f.entity)}${renderField(f.time)}${renderField(f.dimension,{full:true})}${renderField(f.filter,{full:true})}</div>
    <div class="metric-code-column">${sqlEditor(f.sql,'计算 SQL')}
    <div style="margin-top:19px">${renderField(f.notes,{full:true})}</div>
    <p class="metric-footnote">“人工修改”记录内容来源；“已人工确认”记录维护者的口径确认，两者分别保留。</p></div></div>${semanticKnowledge.renderLinks('metric',metric.id)}</div></div>`;
}
function renderLineage(){
  const f=model.lineage;
  if(model.id==='orders')return `<div class="panel">${sectionHeader('','上游来源与加工关系',`${model.relations.length} 张合成加工上游；客户标签是查询关联，不属于加工血缘。`)}<div class="lineage-intro">${icon('flow')}<span>订单行 + 支付事件汇总 + 客户地区 → 订单行分析明细</span></div>${model.relations.map(r=>`<details class="relation-card"><summary><code>${escapeHTML(r.fields.table.value)}</code><span>${escapeHTML(r.fields.purpose.value)}</span>${icon('chevron')}</summary><div class="form-grid">${Object.values(r.fields).map(f=>renderField(f,{full:true})).join('')}</div></details>`).join('')}<p class="lineage-caption">这里记录当前加工的事实。跨表取数时仍需检查重复匹配、关联方向和日期条件。</p></div><div class="panel">${sectionHeader('','节点信息','以下为合成节点记录；真实调度接口尚未接入。')}<div class="form-grid">${renderField(f.node_id)}${renderField(f.process_id)}${renderField(f.node_name)}${renderField(f.process_name)}${renderField(f.join_rule,{full:true})}</div></div><div class="panel">${sectionHeader('','完整加工 SQL','保留合成初始版本作为依据；在页面编辑仅修改本机草稿。')}${sqlEditor(f.sql,'节点加工 SQL')}</div>`;
  return `<div class="panel">${sectionHeader('','生产血缘','用已有上下游关系和调度节点理解数据如何产生。')}
    <div class="lineage-canvas"><div class="lineage-node"><strong>${escapeHTML(f.upstream.value)}</strong><code>上游资产</code><span>预填来源：表血缘</span></div><span class="lineage-arrow">${icon('arrow')}</span><div class="lineage-node"><strong>${escapeHTML(f.node_name.value)}</strong><code>${escapeHTML(f.node_id.value)}</code><span>调度节点 · 加工 SQL</span></div><span class="lineage-arrow">${icon('arrow')}</span><div class="lineage-node current"><strong>${escapeHTML(model.fields.alias.value)}</strong><code>${escapeHTML(f.downstream.value)}</code><span>当前表</span></div></div>
    <p class="lineage-caption">本图为记录结构示例；节点与边不是实际查询到的生产血缘。</p></div>
    <div class="panel">${sectionHeader('01','血缘关系与节点信息','所有值可修改，并保留与预填值的对照。')}<div class="form-grid">${renderField(f.upstream,{full:true})}${renderField(f.downstream,{full:true})}${renderField(f.process_name)}${renderField(f.node_name)}${renderField(f.process_id)}${renderField(f.node_id)}${renderField(f.relation_source)}${renderField(f.is_relation_valid)}${renderField(f.join_rule,{full:true})}</div></div>
    <div class="panel">${sectionHeader('02','节点加工 SQL','作为解释字段、关系和指标的依据。')}${sqlEditor(f.sql,'节点加工 SQL')}</div>`;
}
function renderHistory(){
  const changed=manualFields();
  return `<div class="panel">${sectionHeader('','人工修改记录',`当前有 ${changed.length} 项人工修改。预设记录用于演示，新增编辑也会出现在这里。`)}${changed.length?changed.map(f=>`<article class="history-row"><div class="history-heading"><strong>${escapeHTML(fieldTitle(f))}</strong><span class="badge manual">${icon('edit')}人工修改</span></div><div class="history-values"><div class="history-value"><span>原始预填</span>${escapeHTML(f.prefill)}</div><div class="history-arrow">${icon('arrow')}</div><div class="history-value new"><span>当前值</span>${escapeHTML(f.value)}</div></div><div class="history-meta"><span>${escapeHTML(f.editor||'数据开发')} · ${escapeHTML(f.editedAt||'本次会话')}</span><button class="quiet-link" data-source="${escapeHTML(f.key)}">查看来源 / 恢复预填</button></div></article>`).join(''):'<div class="empty-state">还没有人工修改。编辑任意内容后，可在这里对照预填值。</div>'}</div>`;
}
function render(){
  renderHeader();renderCatalog();
  $('.editor-layout').classList.toggle('metrics-layout',activeTab==='metrics');
  $('.editor-layout').classList.toggle('documents-layout',activeTab==='documents');
  const views={overview:renderOverview,fields:renderColumns,lineage:renderLineage,metrics:renderMetrics,documents:semanticKnowledge.render,history:renderHistory};
  $('#content').innerHTML=views[activeTab]();
  $('#content').setAttribute('aria-label',$(`[data-tab="${activeTab}"]`).textContent.trim());
  renderEvidence();
  if(activeTab==='fields')filterColumns();
}
function switchTab(tab){activeTab=tab;render();}
function toast(message){clearTimeout(toastTimer);$('#toast').textContent=message;$('#toast').classList.add('visible');toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),3400);}
function markChanged(field,value){
  field.value=value;
  field.manual=value!==field.prefill;
  field.editedAt=new Date().toLocaleTimeString('zh-CN',{hour12:false});
  field.editor='数据开发（本次会话）';
  model.saved=false;
  const scope=scopeForField(field);
  delete model.confirmations[scope];
  if(scope.startsWith('metric:')){
    const metric=model.metrics.find(m=>`metric:${m.id}`===scope);metric.status='待确认';
    if($('#metric-state'))$('#metric-state').value='待确认';
    const entry=$(`[data-metric="${metric.id}"] .metric-status`);if(entry)entry.textContent='待确认 · 人工修改';
  }
  if(field.key==='node_sql'){model.confirmations={};model.metrics.forEach(m=>m.status='待确认');}
  focusedField=field.key;
  $$('[data-badge]').filter(el=>el.dataset.badge===field.key).forEach(el=>el.innerHTML=badge(field,true));
  $$('[data-field]').filter(el=>el.dataset.field===field.key).forEach(el=>el.classList.toggle('is-manual',field.manual));
  renderHeader();
  const column=model.columns.find(c=>`column:${c.id}`===scope);
  if(column){
    const row=$(`[data-column="${column.id}"]`);
    if(row){
      row.querySelector('.column-description').textContent=column.fields.description.value;
      row.querySelector('.column-name code').textContent=column.fields.name.value;
      row.querySelector('.column-type').textContent=column.fields.type.value;
      row.querySelector('.column-status').innerHTML=`<span class="badge ${column.a?.issue?'attention':'synced'}">${escapeHTML(columnState(column))}</span>${[...Object.values(column.fields),...(column.children||[]).flatMap(ch=>Object.values(ch.fields))].some(f=>f.manual)?'<span class="badge manual">人工修改</span>':''}`;
      row.querySelector('.confirmation-status').textContent='内容已编辑，请重新核对后确认。';
    }
  }
  const confirmButton=$(`[data-confirm-scope="${scope}"]`);
  if(confirmButton){confirmButton.textContent='确认本项说明';confirmButton.classList.add('primary');}
  $('#save-status').textContent='有未保存的修改';
}

function saveDraft(){
  try{
    const previous=localStorage.getItem(draftKey);
    const drafts=previous?JSON.parse(previous):{};
    if(!drafts||typeof drafts!=='object'||Array.isArray(drafts))throw new Error('Invalid draft');
    drafts[model.id]={revision:model.real?demoSource.revision:'demo-v1',values:Object.fromEntries(allFields().map(f=>[f.key,{value:f.value,editedAt:f.editedAt||'',editor:f.editor||''}])),confirmations:model.confirmations,metrics:model.metrics.map(m=>({id:m.id,status:m.status,isNew:m.id.startsWith('new_metric_')}))};
    localStorage.setItem(draftKey,JSON.stringify(drafts));
    model.saved=true;renderHeader();toast('这张表的草稿已保存到当前浏览器，刷新后可继续编辑。');
  }catch{toast('本机草稿保存失败，请先保留页面；当前修改仍在页面中。');}
}
function loadDrafts(){
  try{
    const drafts=JSON.parse(localStorage.getItem(draftKey)||'{}');
    if(!drafts||typeof drafts!=='object')return;
    for(const m of models){
      const saved=drafts[m.id];
      if(!saved?.values||saved.revision!==(m.real?demoSource.revision:'demo-v1'))continue;
      for(const record of saved.metrics||[]){
        if(record.isNew&&/^new_metric_\d+$/.test(record.id)&&!m.metrics.some(x=>x.id===record.id)){
          const metric=createMetric(record.id,'新指标','','','','',m.fullName);
          Object.values(metric.fields).forEach(f=>{f.source='manual';f.origin='人工新增指标';f.prefill='';});
          m.metrics.push(metric);
        }
      }
      for(const f of modelFields(m)){
        const data=saved.values[f.key];if(typeof data?.value!=='string')continue;
        f.value=data.value;f.manual=f.value!==f.prefill;
        f.editedAt=typeof data.editedAt==='string'?data.editedAt:'';
        f.editor=typeof data.editor==='string'?data.editor:'';
      }
      if(saved.confirmations&&typeof saved.confirmations==='object'&&!Array.isArray(saved.confirmations))m.confirmations=saved.confirmations;
      for(const metric of m.metrics)metric.status=m.confirmations[`metric:${metric.id}`]?'已人工确认':'待确认';
      m.saved=true;
    }
  }catch{toast('本机草稿未能读取，当前显示原始分析草稿。');}
}
function showSource(key){
  const f=getField(key);if(!f)return;
  currentSourceKey=key;
  $('#source-title').textContent=`${fieldTitle(f)} · 预填对照`;
  $('#source-detail').innerHTML=`<p class="source-caption">${escapeHTML(sourceNames[f.source])}<br>${escapeHTML(f.origin)}</p><div class="source-compare"><strong>原始资料 / 原注释</strong><pre>${escapeHTML(f.rawValue??(f.source==='synced'?f.prefill:'原始资料未直接提供这一项，以下为分析补充。'))}</pre></div><div class="source-compare"><strong>${f.source==='inferred'?'分析生成的预填草稿':'最初预填内容'}</strong><pre>${escapeHTML(f.prefill)}</pre></div><div class="source-compare current"><strong>当前内容 ${f.manual?'· 人工修改':''}</strong><pre>${escapeHTML(f.value)}</pre></div>${f.refs?.length?`<h3 class="source-section-title">对应的原文依据</h3>${f.refs.map(ref=>sourceBlock(ref)).join('')}`:'<p class="small-note">暂无可直接定位的 SQL 依据。</p>'}<p class="small-note">原文与预填草稿保留用于对照；当前内容可以在页面中修改。</p>`;
  $('#restore-value').disabled=!f.manual;
  $('#source-dialog').showModal();
}

document.addEventListener('click',async event=>{
  const summary=event.target.closest('details[data-column] > summary');
  if(summary){focusedField=model.columns.find(c=>c.id===summary.parentElement.dataset.column).fields.description.key;renderEvidence();}
  const button=event.target.closest('button');if(!button)return;
  if(button.dataset.correctionMetric){
    model=models.find(m=>m.id==='orders');metricId=button.dataset.correctionMetric;focusedField=`${metricId}.notes`;activeTab='metrics';
    personalWorkspace.show('semantic');render();toast('已定位共享指标；可对照纠错核对口径，并在维护页保存修订。');return;
  }
  if(button.dataset.tab){switchTab(button.dataset.tab);return;}
  if(button.dataset.table){
    model=models.find(m=>m.id===button.dataset.table);metricId=model.metrics[0].id;focusedField='description';fieldSearch='';onlyManualFields=false;onlyPendingFields=false;expandedColumns.clear();render();return;
  }
  if(button.dataset.issue){
    const issue=model.issues.find(i=>i.id===button.dataset.issue);
    activeTab=issue.tab;onlyManualFields=false;onlyPendingFields=false;
    if(issue.column){fieldSearch=issue.column;expandedColumns.add(issue.column);focusedField=model.columns.find(c=>c.id===issue.column).fields.description.key;}
    if(issue.metric){metricId=issue.metric;focusedField=`${issue.metric}.filter`;}
    if(issue.field)focusedField=issue.field;
    render();const target=issue.field?$(`[data-field="${issue.field}"]`):$('#content');target?.scrollIntoView({block:'start',behavior:'instant'});return;
  }
  if(button.dataset.confirmScope){
    const scope=button.dataset.confirmScope;
    if(scopeConfirmed(scope))delete model.confirmations[scope];else model.confirmations[scope]=new Date().toLocaleString('zh-CN');
    model.saved=false;render();toast(scopeConfirmed(scope)?'本项说明已人工确认；数据和 SQL 仍未执行验证。':'已撤销本项确认。');return;
  }
  if(button.dataset.metric){metricId=button.dataset.metric;render();return;}
  if(button.dataset.source){showSource(button.dataset.source);return;}
  if(button.dataset.copy){
    try{await navigator.clipboard.writeText(getField(button.dataset.copy).value);toast('SQL 已复制。示例 SQL 尚未执行验证。');}
    catch{toast('浏览器未允许复制，请在 SQL 编辑框中手动选择并复制。');}
    return;
  }
  if(button.id==='changes-button'){switchTab('history');return;}
  if(button.id==='save-button'){saveDraft();return;}
  if(button.id==='refresh-button'){$('#protected-count').textContent=`（${manualFields().length} 项）`;$('#refresh-dialog').showModal();return;}
  if(button.id==='cancel-refresh'){$('#refresh-dialog').close();return;}
  if(button.id==='confirm-refresh'){
    const protectedCount=manualFields().length;
    allFields().forEach(f=>{if(!f.manual)f.value=f.prefill;});
    model.saved=false;$('#refresh-dialog').close();render();toast(`已重新载入本版预填；${protectedCount} 项人工修改均已保留。未调用模型或平台接口。`);return;
  }
  if(['close-source','finish-source'].includes(button.id)){$('#source-dialog').close();return;}
  if(button.id==='restore-value'){
    const f=getField(currentSourceKey);markChanged(f,f.prefill);$('#source-dialog').close();render();toast('已恢复预填内容；请重新核对确认状态。');return;
  }
  if(button.id==='add-metric'){
    const id=`new_metric_${model.metrics.length+1}`;
    const metric=createMetric(id,'新指标','','','','',model.fields.full_name.value);
    metric.fields.sql.value='-- 在此填写指标的计算 SQL';
    metric.fields.notes.value='';
    metric.fields.filter.value='';
    metric.fields.dimension.value='';
    Object.values(metric.fields).forEach(f=>{f.source='manual';f.origin='人工新增指标';f.prefill='';f.manual=f.value!=='';});
    model.metrics.push(metric);metricId=id;model.saved=false;render();$(`[data-field="${id}.name"]`).focus();toast('已新增指标草稿，可以填写口径和 SQL。');
  }
});
document.addEventListener('input',event=>{
  const control=event.target;
  if(control.dataset.field){const f=getField(control.dataset.field);if(f)markChanged(f,control.value);return;}
  if(control.id==='table-search'){renderCatalog();return;}
  if(control.id==='field-search'){fieldSearch=control.value;filterColumns();}
});
document.addEventListener('change',event=>{
  if(event.target.id==='manual-filter'){onlyManualFields=event.target.checked;filterColumns();}
  if(event.target.id==='pending-filter'){onlyPendingFields=event.target.checked;filterColumns();}
  if(event.target.id==='metric-state'){
    const metric=model.metrics.find(m=>m.id===metricId);metric.status=event.target.value;
    if(metric.status==='已人工确认')model.confirmations[`metric:${metric.id}`]=new Date().toLocaleString('zh-CN');else delete model.confirmations[`metric:${metric.id}`];
    model.saved=false;render();toast('口径确认状态已更新；SQL 仍未执行验证。');
  }
  if(event.target.dataset.field){renderCatalog();renderEvidence();}
});
document.addEventListener('focusin',event=>{if(event.target.dataset.field){focusedField=event.target.dataset.field;renderEvidence();}});
document.addEventListener('toggle',event=>{
  const column=event.target.dataset?.column;
  if(!column||!event.target.isConnected)return;
  if(event.target.open)expandedColumns.add(column);
  else expandedColumns.delete(column);
},true);
$('#tabs').addEventListener('keydown',event=>{
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  const tabs=$$('.tab');let index=tabs.findIndex(t=>t.dataset.tab===activeTab);
  index=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
  event.preventDefault();switchTab(tabs[index].dataset.tab);tabs[index].focus();
});
window.renderSemanticPage=render;
loadDrafts();
semanticKnowledge.initialize();
render();

// 全局工作台只通过此入口定位语义，不重建已有草稿和维护状态。
window.semanticWorkspace = {
  activate(target = {}) {
    const next = models.find(m => m.id === (target.tableId || 'orders'));
    if (next) model = next;
    activeTab = ['overview','fields','lineage','metrics','documents','history'].includes(target.tab) ? target.tab : 'overview';
    if (target.metric && model.metrics.some(m => m.id === target.metric)) { metricId = target.metric; focusedField = `${metricId}.notes`; }
    if (!model.metrics.some(m => m.id === metricId)) metricId = model.metrics[0].id;
    if (target.field && model.columns.some(c => c.id === target.field)) {
      activeTab = 'fields'; fieldSearch = target.field; expandedColumns.add(target.field);
      onlyManualFields = false; onlyPendingFields = false;
      focusedField = model.columns.find(c => c.id === target.field).fields.description.key;
    }
    render();
    if (target.document) semanticKnowledge.openDoc(target.document, target.section || '');
  }
};

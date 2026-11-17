import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness} from './harness.mjs';

const directory = process.env.DATA_AGENT_SOURCE_CHECK_DIRECTORY;
const scenario = process.argv[2] ?? 'all';
assert.ok(['all', 'platform-roots', 'incomplete-upstream', 'document', 'explicit-dependencies'].includes(scenario));
const evidence = {passed: false, scenario, officialRequests: 0, checks: [], responses: []};
const h = await harness({capture: true, startWorker: false,
  env: {DATA_AGENT_TOOL_CONTRACT_VERSION: '2', DATA_AGENT_PREFILL_PROFILE: '', DATA_AGENT_LEASE_MS: '120000'}});
const quote = value => "'" + String(value).replaceAll('\\', '\\\\').replaceAll("'", "''") + "'";
const ok = response => {assert.equal(response.status, 200, JSON.stringify(response.value)); return response.value;};
let run;
const manager = SessionManager.inMemory('/synthetic/source-search-admission');
const invoke = async (name, args, expectedError) => {
  const input = {run_id: run.run_id, lease_epoch: run.lease_epoch,
    sdk_tool_call_id: randomUUID(), tool_name: name, arguments: args,
    checkpoint: exportCheckpoint(manager, run.workspace_context.authority_revision, run.workspace_context.authority_snapshot)};
  ok(await h.internal('/internal/data/tool-calls', input));
  const response = await h.internal('/internal/data/tools', input);
  evidence.responses.push({name, arguments: args, ...response});
  if (!expectedError) return ok(response).data;
  assert.notEqual(response.status, 200);
  assert.equal(response.value.code, expectedError, JSON.stringify(response.value));
  const rejection = ok(await h.internal('/internal/data/tool-rejections', input));
  assert.equal(rejection.data.error, expectedError);
  return rejection.data;
};
const start = async (allowed_sources, goal) => {
  await h.resumeWorker();
  run = await h.capture(await h.create(), goal);
  await h.pauseWorker();
  const task = await invoke('update_analysis_task', {action: 'create', goal, options: [],
    conditions: {time_start: null, time_end: null, timezone: 'UTC', metric: null, channel: null,
      group_by: [], filters: [], knowledge_refs: [], notes: '',
      source_limits: {allowed_sources, origin_message_ids: [run.message_id]}}});
  assert.ok(task.task_id);
};
try {
  const upstream = 'synthetic-source-search-upstream';
  const needle = 'syntheticsourcesearchadmission';
  const body = needle + '：合成复核完成后才可计入有效设备数。';
  const document = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'document',
    name: '合成同步文档', body, related_ids: []}));
  // 在本次隔离库构造同步文档的旧格式形状；上游是版本依赖，当前读取身份仍是文档。
  const saved = h.sql(`SELECT body FROM knowledge_objects WHERE id=${quote(document.id)}`)[0];
  saved.source_id = upstream;
  saved.source_version = '1';
  saved.entries[0] = {...saved.entries[0], effective_value: body, suggestion: {}, human_override: null,
    source_facts: {source_id: upstream, version: '1', value: body, complete: true, location: 'body', quote: body}};
  const serialized = quote(JSON.stringify(saved));
  h.sql(`INSERT INTO source_heads(id,space_id,version,fingerprint) VALUES(${quote(upstream)},'demo',1,'synthetic');
    INSERT INTO source_snapshots(source_id,version,body,complete) VALUES(${quote(upstream)},1,${quote(body)},TRUE);
    UPDATE knowledge_objects SET source_id=${quote(upstream)},source_version=1,body=${serialized} WHERE id=${quote(document.id)};
    UPDATE knowledge_versions SET body=${serialized} WHERE object_id=${quote(document.id)} AND version=1;
    DELETE FROM knowledge_dependencies WHERE owner_id=${quote(document.id)};
    INSERT INTO knowledge_dependencies(owner_id,owner_version,space_id,entry_path,layer,purpose,role,effective,target_kind,target_id,target_revision,target_path,target_fingerprint)
    VALUES(${quote(document.id)},1,'demo','body','source_fact','required','origin',1,'platform',${quote(upstream)},1,'','');`);
  evidence.fixture = {document: {id: document.id, version: document.version}, upstream,
    dependencies: h.sql(`SELECT JSON_OBJECT('path',entry_path,'kind',target_kind,'id',target_id,'version',target_revision)
      FROM knowledge_dependencies WHERE owner_id=${quote(document.id)}`)};
  const allowed = [{kind: 'document', id: document.id}];
  evidence.allowed_sources = allowed;
  const citation = {source: allowed[0], revision: document.version, locator: {offset: 0, length: [...body].length}};
  if (scenario === 'all' || scenario === 'platform-roots') {
    const platformOnly = [{kind: 'platform', id: upstream}];
    evidence.platform_roots_allowed_sources = platformOnly;
    await start(platformOnly, '只依据合成平台来源贡献的知识窗口核对，不读取独立文档原文。');
    await invoke('read_source', {citation}, 'source_not_allowed');
    const search = await invoke('search_knowledge', {query: needle, limit: 10});
    assert.ok(search.hits.some(hit => hit.record_kind === 'knowledge_entry'
      && hit.ref.object_id === document.id && hit.definition.includes(body)),
    '完整贡献根已获准时必须交付知识窗口，不能另要求document许可或只返回空集');
    const authority = h.sql(`SELECT authority_snapshot FROM agent_runs WHERE id=${quote(run.run_id)}`)[0];
    assert.ok(!authority.sources.some(pair => pair[0] === 'document-' + document.id));
    assert.ok(authority.knowledge_entries.some(reference => reference[0] === document.id && reference[2] === 'body'));
    evidence.platform_roots_authority = authority;
    evidence.checks.push('仅platform贡献根许可可搜索知识窗口，document原文仍拒绝，不互授权');
    h.releaseRun(run.run_id);
  }
  if (scenario === 'all' || scenario === 'explicit-dependencies') {
    for (const dependencyKind of ['citation', 'support']) {
      const marker = 'syntheticexternal' + dependencyKind;
      const text = marker + '：合成规则必须保留明确的外部依据。';
      // 整理陈述与原文不同，正控必须取得指定陈述，不能用原文替代。
      const rawBody = '合成原始背景，整理陈述另行保存。';
      const cited = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'document',
        name: '合成显式外部依据' + dependencyKind, body: rawBody, related_ids: []}));
      const content = h.sql(`SELECT body FROM knowledge_objects WHERE id=${quote(cited.id)}`)[0];
      const statement = {statement_id: 'synthetic-external-' + dependencyKind, text, scope_text: '',
        citations: dependencyKind === 'citation' ? [{...citation, source: {kind: 'platform', id: upstream}}] : [],
        supports_complete: true, supports: dependencyKind === 'support' ? [{support_id: 'synthetic-outside-support',
          role: 'prerequisite', reference: {kind: 'source', citation: {...citation, source: {kind: 'platform', id: upstream}}},
          content: body, embedded_in: null}] : []};
      content.entries[0] = {...content.entries[0], effective_value: rawBody, human_override: null,
        suggestion: {statements: [statement]}};
      h.sql(`UPDATE knowledge_objects SET body=${quote(JSON.stringify(content))} WHERE id=${quote(cited.id)};
        UPDATE knowledge_versions SET body=${quote(JSON.stringify(content))} WHERE object_id=${quote(cited.id)} AND version=1;
        INSERT INTO knowledge_statements(object_id,version,statement_id,space_id,entry_path,layer,body)
          VALUES(${quote(cited.id)},1,${quote(statement.statement_id)},'demo','body','model_suggestion',${quote(JSON.stringify(statement))});`);
      const read = {items: [{kind: 'knowledge', ref: {object_id: cited.id, version: cited.version, path: 'body'},
        statement_id: statement.statement_id}]};
      await start([{kind: 'document', id: cited.id}], '只准合成文档自身，不授权其显式外部' + dependencyKind + '。');
      if (dependencyKind === 'citation') {
        await invoke('read_knowledge', read, 'source_not_allowed');
      } else {
        const rejected = await invoke('read_knowledge', read);
        assert.equal(rejected.items[0].state, 'not_available');
        assert.equal(rejected.items[0].content, undefined, '支持越界时不能交付主陈述正文');
        assert.equal(rejected.items[0].supports, undefined, '支持越界时不能交付支持正文');
      }
      evidence.checks.push('document直许不放行显式范围外' + dependencyKind);
      h.releaseRun(run.run_id);
      await start([{kind: 'document', id: cited.id}, {kind: 'platform', id: upstream}], '文档和明确引用来源均获准，定点读取同一条整理陈述。');
      const readable = (await invoke('read_knowledge', read)).items[0];
      assert.equal(readable.state, 'ok');
      assert.equal(readable.content, text, '双许可正控必须取得指定陈述，不能把空回执当拒绝证明');
      if (dependencyKind === 'citation') assert.ok(readable.citations.some(value => value.source.id === upstream));
      else assert.ok(readable.supports.some(value => value.reference.citation.source.id === upstream && value.content === body));
      evidence.checks.push(dependencyKind + '来源获准后同一陈述及实际引用可读');
      h.releaseRun(run.run_id);
    }
  }
  if (scenario === 'all' || scenario === 'incomplete-upstream') {
    const completenessAllowed = [...allowed, {kind: 'platform', id: upstream}];
    evidence.completeness_allowed_sources = completenessAllowed;
    h.sql(`UPDATE source_snapshots SET complete=FALSE WHERE source_id=${quote(upstream)} AND version=1;
      UPDATE source_current SET complete=FALSE WHERE source_id=${quote(upstream)} AND revision=1;`);
    evidence.incomplete_source_state = h.sql(`SELECT JSON_OBJECT('head_version',h.version,'revision',s.version,'complete',s.complete)
      FROM source_heads h JOIN source_snapshots s ON s.source_id=h.id AND s.version=h.version WHERE h.id=${quote(upstream)}`)[0];
    assert.equal(evidence.incomplete_source_state.head_version, 1);
    assert.equal(Boolean(evidence.incomplete_source_state.complete), false);
    await start(completenessAllowed, '文档和上游均获准，但同修订上游不完整时不得交付正文。');
    await invoke('search_knowledge', {query: needle, limit: 10}, 'stale_knowledge');
    evidence.checks.push('同修订上游complete=false仍拒绝文档知识正文，不以版本头匹配代替完整性');
    h.releaseRun(run.run_id);
    // Worker会把legacy快照落到current，恢复时须同时恢复真正优先读取的当前记录。
    h.sql(`UPDATE source_snapshots SET complete=TRUE WHERE source_id=${quote(upstream)} AND version=1;
      UPDATE source_current SET complete=TRUE WHERE source_id=${quote(upstream)} AND revision=1;`);
    evidence.recovered_source_state = h.sql(`SELECT JSON_OBJECT('store','snapshot','revision',version,'complete',complete)
      FROM source_snapshots WHERE source_id=${quote(upstream)} AND version=1;
      SELECT JSON_OBJECT('store','current','revision',revision,'complete',complete)
      FROM source_current WHERE source_id=${quote(upstream)}`);
    assert.ok(evidence.recovered_source_state.every(state => state.revision === 1 && Boolean(state.complete)));
    await start(completenessAllowed, '上游完整性恢复后重新读取同一获准文档。');
    const recovered = await invoke('search_knowledge', {query: needle, limit: 10});
    assert.ok(recovered.hits.some(hit => hit.ref?.object_id === document.id && hit.definition.includes(body)));
    evidence.checks.push('完整性恢复后同一文档知识窗口重新可读');
    h.releaseRun(run.run_id);

    // 未选条目的不完整来源不能污染当前body窗口的有效依赖。
    const unused = 'synthetic-unselected-incomplete-source';
    const withOtherEntry = structuredClone(saved);
    withOtherEntry.entries.push({entry_id: 'other', path: 'other', label: '未选附录',
      effective_value: '无关附录正文，不含目标检索词。', suggestion: {}, human_override: null,
      source_facts: {source_id: unused, version: '1', value: '无关附录正文，不含目标检索词。', complete: true}});
    h.sql(`INSERT INTO source_heads(id,space_id,version,fingerprint) VALUES(${quote(unused)},'demo',1,'synthetic');
      INSERT INTO source_snapshots(source_id,version,body,complete) VALUES(${quote(unused)},1,'不完整的未选来源。',FALSE);
      UPDATE knowledge_objects SET body=${quote(JSON.stringify(withOtherEntry))} WHERE id=${quote(document.id)};
      UPDATE knowledge_versions SET body=${quote(JSON.stringify(withOtherEntry))} WHERE object_id=${quote(document.id)} AND version=1;
      INSERT INTO knowledge_dependencies(owner_id,owner_version,space_id,entry_path,layer,purpose,role,effective,target_kind,target_id,target_revision,target_path,target_fingerprint)
        VALUES(${quote(document.id)},1,'demo','other','source_fact','required','origin',1,'platform',${quote(unused)},1,'','');`);
    await start(completenessAllowed, '只读取body窗口，不读取另一个来源尚不完整的附录。');
    const selected = await invoke('search_knowledge', {query: needle, limit: 10});
    assert.ok(selected.hits.some(hit => hit.ref?.object_id === document.id && hit.definition.includes(body)));
    evidence.checks.push('完整性核验按已交付path：未选条目不完整来源不阻断合法body');
    h.releaseRun(run.run_id);
    h.sql(`UPDATE knowledge_objects SET body=${serialized} WHERE id=${quote(document.id)};
      UPDATE knowledge_versions SET body=${serialized} WHERE object_id=${quote(document.id)} AND version=1;
      DELETE FROM knowledge_dependencies WHERE owner_id=${quote(document.id)} AND entry_path='other';`);
  }
  if (scenario === 'all' || scenario === 'document') {
    await start(allowed, '只依据合成同步文档核对有效设备数，不开放其上游平台正文。');
    const direct = await invoke('read_source', {citation});
    assert.equal(direct.text, body);
    assert.deepEqual(direct.source, allowed[0]);
    evidence.checks.push('允许文档的已有正文可用正式SourceKey/修订/locator直接读取');
    await invoke('read_source', {citation: {...citation, source: {kind: 'platform', id: upstream}}}, 'source_not_allowed');
    evidence.checks.push('允许文档不扩大为上游平台来源许可');
    const search = await invoke('search_knowledge', {query: needle, limit: 10});
    const hits = search.hits.filter(hit => hit.record_kind === 'knowledge_entry' && hit.ref.object_id === document.id);
    assert.ok(hits.length > 0, '普通检索必须交付合法文档正文，不能仅返回空集');
    assert.ok(hits.some(hit => hit.definition.includes(body)));
    const authority = h.sql(`SELECT authority_snapshot FROM agent_runs WHERE id=${quote(run.run_id)}`)[0];
    evidence.authority = authority;
    assert.ok(authority.sources.some(pair => pair[0] === 'document-' + document.id && pair[1] === document.version));
    assert.ok(!authority.sources.some(pair => pair[0] === upstream), '当前读取来源不能被解释为上游平台正文许可');
    assert.ok(authority.knowledge_entries.some(reference => reference[0] === document.id && reference[2] === 'body'),
      '文档版本与选中条目仍用于原依赖有效性复核');
    evidence.checks.push('同一合法文档可由普通检索交付；交付authority与直接读取身份一致且保留知识依赖');
    h.releaseRun(run.run_id);

    // 上游换版仍使依赖它的文档失效；身份修正不能放过过期内容。
    h.sql(`UPDATE source_heads SET version=2 WHERE id=${quote(upstream)};
      INSERT INTO source_snapshots(source_id,version,body,complete) VALUES(${quote(upstream)},2,'合成更新后的来源正文。',TRUE);`);
    await start(allowed, '检查上游换版后旧文档不能继续交付。');
    await invoke('read_source', {citation}, 'stale_knowledge');
    const staleSearch = await invoke('search_knowledge', {query: needle, limit: 10});
    assert.ok(!staleSearch.hits.some(hit => hit.ref?.object_id === document.id), '上游换版后的旧正文不得搜索交付');
    evidence.checks.push('上游版本有效性检查保留：直接读取拒绝，检索不交付过期文档');
    h.releaseRun(run.run_id);
  }
  evidence.passed = true;
  console.log(JSON.stringify(evidence));
} finally {
  evidence.storage_at_close = h.sql(`SELECT JSON_OBJECT('store','head','version',version) FROM source_heads WHERE id='synthetic-source-search-upstream';
    SELECT JSON_OBJECT('store','snapshot','version',version,'complete',complete) FROM source_snapshots WHERE source_id='synthetic-source-search-upstream';
    SELECT JSON_OBJECT('store','current','version',revision,'complete',complete) FROM source_current WHERE source_id='synthetic-source-search-upstream';
    SELECT JSON_OBJECT('store','object','id',id,'version',version,'state',state) FROM knowledge_objects WHERE source_id='synthetic-source-search-upstream';
    SELECT JSON_OBJECT('store','dependency','owner',owner_id,'version',owner_version,'path',entry_path,'effective',effective,'target',target_id,'target_revision',target_revision)
      FROM knowledge_dependencies WHERE target_id='synthetic-source-search-upstream';
    SELECT JSON_OBJECT('store','explicit_object','id',id,'version',version,'state',state,
      'statements',JSON_EXTRACT(body,'$.entries[0].suggestion.statements'),'raw',JSON_EXTRACT(body,'$.entries[0].effective_value'))
      FROM knowledge_objects WHERE name LIKE '合成显式外部依据%';
    SELECT JSON_OBJECT('store','explicit_statement','id',object_id,'version',version,'layer',layer,'body',body)
      FROM knowledge_statements WHERE statement_id LIKE 'synthetic-external-%'`);
  await writeFile(h.directory + '/source-search-admission.json', JSON.stringify(evidence, null, 2));
  if (directory) await writeFile(directory + '/source-search-admission.json', JSON.stringify(evidence, null, 2));
  await h.close();
}

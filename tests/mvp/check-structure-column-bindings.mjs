import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {homedir} from 'node:os';
import {mkdir, writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness, until} from './harness.mjs';

// 来源更新和预填都走真实维护入口；仅来源资料与回环模型响应为合成内容。
const onlyPrefill = process.argv.includes('--prefill-only');
const adoptionOnly = process.argv.includes('--adoption-only');
const dependencyOnly = process.argv.includes('--dependency-only');
const checks = [];
let passed = false, calls = 0;
const ok = response => {
  assert.equal(response.status, 200, JSON.stringify(response.value));
  return response.value;
};
const entry = (object, id) => object.entries.find(value => value.entry_id === id);
// 开一段暂停 worker 的运行，返回在该运行内发起工具调用的函数；任务的创建与修订须同一运行。
const openRun = async h => {
  await h.resumeWorker();
  const run = await h.capture(await h.create(), '读取当前语义依据，不执行查询。');
  await h.pauseWorker();
  const manager = SessionManager.inMemory('/synthetic/data-agent');
  return async (name, args) => {
    const input = {run_id:run.run_id, lease_epoch:run.lease_epoch,
      sdk_tool_call_id:randomUUID(), tool_name:name, arguments:args,
      checkpoint:exportCheckpoint(manager,run.workspace_context.authority_revision,run.workspace_context.authority_snapshot)};
    ok(await h.internal('/internal/data/tool-calls',input));
    return h.internal('/internal/data/tools',input);
  };
};
const invoke = async (h, name, args) => (await openRun(h))(name, args);
const readStructure = async (h, object, entryId) => ok(await invoke(h,'read_knowledge',
  {items:[{kind:'knowledge',ref:{object_id:object.id, version:object.version, path:entryId},structure_only:true}]})).data.items[0];

try {
  if (!onlyPrefill) {
    const h = await harness({capture:true, startWorker:false,
      env:{DATA_AGENT_LEASE_MS:'120000', DATA_AGENT_TOOL_CONTRACT_VERSION:'2', DATA_AGENT_PREFILL_PROFILE:''}});
    try {
      if (!dependencyOnly) {
      let table = ok(await h.request('/knowledge/table-demo_order_detail'));
      const field = ok(await h.request('/knowledge/field-paid_amount_cents'));
      const reference = {object_id:field.id, version:field.version, path:'meaning'};
      const manager = SessionManager.inMemory('/synthetic/data-agent');
      await h.resumeWorker();
      let run = await h.capture(await h.create(), '采用当前金额字段，准备只读核对SQL，不执行。');
      await h.pauseWorker();
      const invoke = async (name,args,error) => {
        const input = {run_id:run.run_id,lease_epoch:run.lease_epoch,sdk_tool_call_id:randomUUID(),tool_name:name,
          arguments:args,checkpoint:exportCheckpoint(manager,run.workspace_context.authority_revision,run.workspace_context.authority_snapshot)};
        ok(await h.internal('/internal/data/tool-calls',input));
        const response = await h.internal('/internal/data/tools',input);
        if (!error) return ok(response).data;
        assert.equal(response.value.code,error,JSON.stringify(response.value));
        const rejection=ok(await h.internal('/internal/data/tool-rejections',input));
        if(error==='stale_knowledge'){
          assert.match(rejection.data.hint,/search_knowledge/);assert.match(rejection.data.hint,/read_knowledge/);
          const refs=args.knowledge_refs??args.condition_patch?.set?.knowledge_refs??[];
          assert.ok(refs.some(ref=>rejection.data.hint.includes(ref.object_id)),'失效回执标明本次知识引用身份及可执行恢复方向');
        }
      };
      const task = await invoke('update_analysis_task',{action:'create',goal:'采用当前字段的金额核对',options:[],
        conditions:{time_start:null,time_end:null,timezone:'UTC',metric:'synthetic_completed_amount',channel:null,
          group_by:[],filters:[],knowledge_refs:[],source_limits:null,notes:'只准备草稿。'}});
      const read = await invoke('read_knowledge',{items:[{kind:'knowledge',ref:reference}]});
      assert.equal(read.items[0].state,'ok');
      assert.ok(read.items[0].content.length>0);
      table = ok(await h.request('/knowledge/'+table.id,{operation_id:randomUUID(),expected_version:table.version,
        entry_id:'description',value:'仅修订订单行说明，DDL、列和键保持原值。',
        structured_value:entry(table,'description').effective_structure},'alice','PATCH'));
      // 模拟原09已触及的latest-only条目：没有结构边或旧表全文，只保真实同版字段原文。
      h.sql(`DELETE FROM knowledge_dependencies WHERE owner_id='${field.id}' AND role='table_binding';
        UPDATE knowledge_revisions SET archived_body=NULL WHERE object_id='${table.id}' AND version<${table.version}`);
      await writeFile(h.directory+'/structure-proof-before.json',JSON.stringify({
        type:ok(await h.request('/knowledge/'+field.id)).entries.find(e=>e.path==='type').source_facts,
        table:ok(await h.request('/knowledge/'+table.id)).entries.find(e=>e.path==='ddl'),
        states:h.sql(`SELECT JSON_OBJECT('id',owner_id,'version',owner_version,'state',mapping_state) FROM knowledge_dependency_states WHERE owner_id IN ('${field.id}','${table.id}')`),
        rows:h.sql(`SELECT JSON_OBJECT('owner',owner_id,'version',owner_version,'entry',entry_path,'target',target_id,'revision',target_revision,'path',target_path,'fingerprint',target_fingerprint) FROM knowledge_dependencies WHERE owner_id IN ('${field.id}','${table.id}') AND effective=1`)
      },null,2));
      const boundRead = await invoke('read_knowledge',{items:[{kind:'knowledge',ref:reference,structure_only:true}]});
      assert.equal(boundRead.items[0].state,'ok');
      assert.ok(boundRead.items[0].structure_dependencies.some(ref=>ref.object_id===table.id && ref.version===table.version && ref.path==='ddl'));
      assert.equal(boundRead.items[0].effective_structure.table.version,'1','原结构说明保留登记版本；实际采用引用单独返回');
      const revised = await invoke('update_analysis_task',{action:'revise',task_id:task.task_id,
        expected_version:task.condition_version,goal:'',condition_patch:{set:{knowledge_refs:[reference]},unset:[]},options:[]});
      const draft = await invoke('request_query',{task_id:task.task_id,condition_version:revised.condition_version,
        sql:'SELECT SUM(paid_amount_cents) AS paid_amount_cents FROM demo_order_detail',parameters:{},
        target_id:'synthetic-sqlite',summary:'字段仍有效的金额核对',knowledge_refs:[reference],replaces_query_id:null});
      assert.equal(draft.execution_state,'not_submitted');
      assert.equal(draft.confirmation_state,'awaiting_confirmation');
      await invoke('update_analysis_task',{action:'revise',task_id:task.task_id,expected_version:revised.condition_version,
        goal:'',condition_patch:{set:{knowledge_refs:[{object_id:table.id,version:field.entries.find(e=>e.entry_id==='meaning').effective_structure.table.version,path:'ddl'}]},unset:[]},options:[]},'stale_knowledge');
      checks.push('表仅说明改版后，旧无指纹字段从同版原文补证，可修订条件并保存未执行草稿；显式旧table@version#ddl仍拒绝');
      h.sql(`DELETE FROM knowledge_dependencies WHERE owner_id='${field.id}' AND role='table_binding';
        UPDATE knowledge_objects SET body=JSON_REMOVE(body,'$.entries[1].source_facts') WHERE id='${field.id}'`);
      await invoke('update_analysis_task',{action:'revise',task_id:task.task_id,expected_version:revised.condition_version,
        goal:'',condition_patch:{set:{knowledge_refs:[reference]},unset:[]},options:[]},'stale_knowledge');
      checks.push('旧指纹和原文都不可取得时保留结构缺口，不能凭当前DDL哈希补证');
      ok(await h.request(`/conversations/${run.conversation_id}/cancel-run`,{run_id:run.run_id,lease_epoch:run.lease_epoch}));
      h.releaseRun(run.run_id);

      const docs = [];
      for (const label of ['甲','乙']) docs.push(ok(await h.request('/knowledge',{operation_id:randomUUID(),kind:'document',
        name:'合成条目来源'+label,body:'设备'+label+'按各自校准规范统计。',related_ids:[]})));
      let selected = ok(await h.request('/knowledge',{operation_id:randomUUID(),kind:'term',name:'多条目合成口径',body:'初始化',related_ids:[]}));
      // 封板后草稿来源门比较所选条目的来源身份，每条规则登记各自文档。
      selected.entries = docs.map((doc,index) => ({entry_id:'entry-'+index,path:'rules.'+index,label:'口径'+index,
        effective_value:doc.entries[0].effective_value,source_facts:{complete:false,gap:'合成夹具',source_id:'document-'+doc.id,version:doc.version},
        suggestion:{value:doc.entries[0].effective_value,evidence:[{source_id:'document-'+doc.id,version:doc.version,
          location:'正文',quote:doc.entries[0].effective_value}]},human_override:null,review_state:'unverified'}));
      const encoded = Buffer.from(JSON.stringify(selected)).toString('hex');
      h.sql(`UPDATE knowledge_objects SET body=CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON) WHERE id='${selected.id}'`);
      selected = ok(await h.request('/knowledge/'+selected.id,{operation_id:randomUUID(),expected_version:selected.version,
        entry_id:'entry-0',value:selected.entries[0].effective_value,structured_value:null},'alice','PATCH'));
      const refs = selected.entries.map(e=>({object_id:selected.id,version:selected.version,path:e.entry_id}));
      const example = ok(await h.request('/knowledge',{operation_id:randomUUID(),kind:'query_example',name:'同对象双条目案例',
        body:'两条规则各自提供依据。',related_ids:[],structured_value:{kind:'query_example',applicable_question:'分别核对两类设备',
          sql:'SELECT 1 AS samples',parameters:[],grain:'设备',computed_metrics:[],dependencies:refs,verification:null}}));
      const edges = h.sql(`SELECT JSON_OBJECT('path',target_path) FROM knowledge_dependencies WHERE owner_id='${example.id}' AND role='structure' ORDER BY target_path`);
      assert.deepEqual(edges.map(e=>e.path),refs.map(e=>e.path),'同对象不同条目的依赖登记不能去重吞掉第二条');
      await h.resumeWorker();
      run = await h.capture(await h.create(),'只用甲文档核对第一条规则，不执行。');
      await h.pauseWorker();
      const scoped = await invoke('update_analysis_task',{action:'create',goal:'选中条目范围核对',options:[],conditions:{
        time_start:null,time_end:null,timezone:'UTC',metric:'synthetic_rule',channel:null,group_by:[],filters:[],knowledge_refs:[],
        source_limits:{allowed_sources:[{kind:'document',id:docs[0].id}],origin_message_ids:[run.message_id]},notes:''}});
      const scopedRev = await invoke('update_analysis_task',{action:'revise',task_id:scoped.task_id,expected_version:scoped.condition_version,
        goal:'',condition_patch:{set:{knowledge_refs:[refs[0]]},unset:[]},options:[]});
      const scopedDraft = await invoke('request_query',{task_id:scoped.task_id,condition_version:scopedRev.condition_version,
        sql:'SELECT 1 AS samples',parameters:{},target_id:'synthetic-sqlite',summary:'选中条目',knowledge_refs:[refs[0]],replaces_query_id:null});
      assert.equal(scopedDraft.execution_state,'not_submitted');
      await invoke('request_query',{task_id:scoped.task_id,condition_version:scopedRev.condition_version,sql:'SELECT 2 AS samples',
        parameters:{},target_id:'synthetic-sqlite',summary:'两条目',knowledge_refs:refs,replaces_query_id:null},'source_not_allowed');
      const evidence = await invoke('save_analysis_evidence',{task_id:scoped.task_id,condition_version:scopedRev.condition_version,
        data_range:'甲设备口径',findings:[{text:'甲设备按甲文档的校准规范统计。',calculation:'采用已读条目，不计算数字。',
          limitations:[],query_refs:[],knowledge_refs:[refs[0]],figures:[]}]});
      const report = await invoke('save_analysis_report',{task_id:scoped.task_id,condition_version:scopedRev.condition_version,
        expected_version:null,title:'甲设备口径核对',evidence_ids:[evidence.evidence_id],charts:[]});
      const reportPath = `/conversations/${run.conversation_id}/tasks/${scoped.task_id}/report`;
      assert.equal(ok(await h.request(reportPath)).status,'available');
      ok(await h.request('/knowledge/'+docs[1].id+'/disable',{operation_id:randomUUID(),expected_version:docs[1].version}));
      const reread = await invoke('read_knowledge',{items:[{kind:'knowledge',ref:refs[0]}]});
      assert.equal(reread.items[0].state,'ok','未选条目撤权不阻断选中条目的正式窄读');
      const unaffected = await invoke('request_query',{task_id:scoped.task_id,condition_version:scopedRev.condition_version,sql:'SELECT 4 AS samples',
        parameters:{},target_id:'synthetic-sqlite',summary:'未选条目失效',knowledge_refs:[refs[0]],replaces_query_id:null});
      assert.equal(unaffected.execution_state,'not_submitted');
      const issue=await h.internal('/internal/model/issue',{run_id:run.run_id,lease_epoch:run.lease_epoch,call_attempt_id:randomUUID()});
      ok(issue); // 只核宿主下一次派发准入，不向供应商发请求。
      await invoke('request_query',{task_id:scoped.task_id,condition_version:scopedRev.condition_version,sql:'SELECT 5 AS samples',
        parameters:{},target_id:'synthetic-sqlite',summary:'选中已失效条目',knowledge_refs:refs,replaces_query_id:null},'stale_knowledge');
      checks.push('entry_id规范为path后贯穿采用与草稿来源门：未选失效不阻断，越界条目及含越界条目的引用受核验');
      const finalText = '甲设备按甲文档的校准规范统计。';
      ok(await h.internal('/internal/outputs',{run_id:run.run_id,lease_epoch:run.lease_epoch,chunk_seq:'1',text:finalText}));
      ok(await h.internal('/internal/finish',{run_id:run.run_id,lease_epoch:run.lease_epoch,commit_id:run.output_id,
        final_text:finalText,checkpoint:exportCheckpoint(manager,run.workspace_context.authority_revision,run.workspace_context.authority_snapshot)}));
      h.releaseRun(run.run_id);
      const history = await h.snapshot(run.conversation_id);
      assert.ok(history.messages.some(message=>message.role==='assistant' && message.text===finalText),
        '未选乙文档撤回后，仅采用甲条目的正式历史答案仍应可读');
      const visibleReport = ok(await h.request(reportPath));
      assert.equal(visibleReport.status,'available','未选乙文档撤回不隐藏甲条目的已保存报告');
      assert.equal(visibleReport.reference.report_id,report.report_id,'历史读取仍是原报告');
      // 只模拟升级前没有范围的原绑定；旧记录仍按整对象限制，不能被新窄读收紧。
      const savedBinding = h.sql(`SELECT JSON_OBJECT('binding',read_binding) FROM assistant_outputs WHERE attempt_id='${run.attempt_id}'`)[0].binding;
      const legacyBinding = structuredClone(savedBinding);
      for (const unit of legacyBinding.units) for (const authority of unit.authorities) delete authority.knowledge_entries;
      const legacyHex = Buffer.from(JSON.stringify(legacyBinding)).toString('hex');
      h.sql(`UPDATE assistant_outputs SET read_binding=CAST(CONVERT(0x${legacyHex} USING utf8mb4) AS JSON) WHERE attempt_id='${run.attempt_id}'`);
      assert.equal((await h.snapshot(run.conversation_id)).messages.some(message=>message.role==='assistant' && message.text===finalText),false,
        '缺条目范围的旧authority仍按整对象核验');
      const bindingHex = Buffer.from(JSON.stringify(savedBinding)).toString('hex');
      h.sql(`UPDATE assistant_outputs SET read_binding=CAST(CONVERT(0x${bindingHex} USING utf8mb4) AS JSON) WHERE attempt_id='${run.attempt_id}'`);
      docs[0] = ok(await h.request('/knowledge/'+docs[0].id,{operation_id:randomUUID(),expected_version:docs[0].version,
        entry_id:'body',value:'甲设备的新口径另有修订；已保存记录保留原含义。',structured_value:null},'alice','PATCH'));
      assert.ok((await h.snapshot(run.conversation_id)).messages.some(message=>message.role==='assistant' && message.text===finalText),
        '历史读取容忍来源普通改版，仍读原提交正文');
      assert.equal(ok(await h.request(reportPath)).status,'available');
      ok(await h.request('/knowledge/'+docs[0].id+'/disable',{operation_id:randomUUID(),expected_version:docs[0].version}));
      assert.equal((await h.snapshot(run.conversation_id)).messages.some(message=>message.role==='assistant' && message.text===finalText),false);
      const hiddenReport = ok(await h.request(reportPath));
      assert.equal(hiddenReport.status,'sources_unavailable','选中甲来源撤回仍隐藏整份报告');
      assert.equal(JSON.stringify(hiddenReport).includes(finalText),false);
      checks.push('条目范围贯通正式答案snapshot与已保存报告：未选来源撤回仍可读，选中来源撤回仍限制且不泄漏正文');
      }
      let output = '';
      const code = await new Promise((resolve,reject) => {
        const child = spawn(homedir()+'/.cargo/bin/cargo',['test','--offline','--locked','-p','data-agent','--test',
          'knowledge_dependencies','transitive_walk_finds_source_change_immediately_and_stops_cycles','--','--test-threads=1','--nocapture'],
          {env:h.env,stdio:['ignore','pipe','pipe']});
        for (const stream of [child.stdout,child.stderr]) stream.on('data',chunk=>{output+=chunk;process.stdout.write(chunk);});
        child.once('error',reject);child.once('close',resolve);
      });
      await writeFile(h.directory+'/dependency-walk.log',output);
      assert.equal(code,0);assert.match(output,/test result: ok\. 1 passed; 0 failed/);
      checks.push('中间知识仅同文改版后仍沿原登记版本检查下游来源，来源变化即时失效并保原防环/unknown断言');
    } finally { await h.close(); }
  }
  if (!onlyPrefill && !adoptionOnly && !dependencyOnly) {
    const h = await harness({capture:true, startWorker:false});
    try {
      let table = ok(await h.request('/knowledge/table-demo_order_detail'));
      let field = ok(await h.request('/knowledge/field-paid_amount_cents'));
      field = ok(await h.request('/knowledge/'+field.id, {
        operation_id:randomUUID(), expected_version:field.version, entry_id:'meaning',
        value:'维护者保留的实付金额口径', structured_value:entry(field,'meaning').effective_structure,
      },'alice','PATCH'));
      const fieldReference = {object_id:field.id, version:field.version, path:'meaning'};
      assert.equal((await readStructure(h,field,'meaning')).structure_coverage.state,'complete');
      const structure = entry(table,'description').effective_structure;
      assert.ok(structure.unique_keys[0].includes('line_id'));
      table = ok(await h.request('/knowledge/'+table.id, {
        operation_id:randomUUID(), expected_version:table.version, entry_id:'description',
        value:'维护者保留的订单行规则', structured_value:structure,
      },'alice','PATCH'));
      table = ok(await h.request('/knowledge/'+table.id+'/reanalyze', {
        operation_id:randomUUID(), expected_version:table.version,
      }));
      assert.equal(entry(table,'description').review_state,'needs_review');
      const valid = await readStructure(h,table,'description');
      assert.deepEqual(valid.effective_structure,structure);
      assert.equal(valid.structure_coverage.state,'complete');
      checks.push('合法的待复核人工规则仍可读取，不按 needs_review 一刀切拒绝');

      // 只推进输入来源的修订，知识对象必须由下面的 reanalyze 自己更新。
      const source = h.sql("SELECT JSON_OBJECT('version',h.version,'body',s.body) FROM source_heads h JOIN (SELECT source_id,version,body,archive_complete AS complete FROM source_revisions WHERE body IS NOT NULL) s ON s.source_id=h.id AND s.version=h.version WHERE h.id='schema'")[0];
      const newSchema = source.body.replace(/CREATE TABLE demo_order_detail \([\s\S]*?\);/, ddl => ddl
        .replace('    line_id INTEGER NOT NULL,\n','')
        .replace('PRIMARY KEY (order_id, line_id)','PRIMARY KEY (order_id)'));
      assert.notEqual(newSchema,source.body);
      const version = Number(source.version)+1, body = Buffer.from(newSchema).toString('hex');
      const fingerprint = createHash('sha256').update(newSchema).digest('hex');
      h.sql(`INSERT INTO source_revisions(source_id,version,body,archive_complete) VALUES('schema',${version},CONVERT(0x${body} USING utf8mb4),TRUE);
        UPDATE source_heads SET version=${version},fingerprint='${fingerprint}' WHERE id='schema';
        UPDATE source_current SET revision=${version},body=CONVERT(0x${body} USING utf8mb4) WHERE source_id='schema'`);
      table = ok(await h.request('/knowledge/'+table.id+'/reanalyze', {
        operation_id:randomUUID(), expected_version:table.version,
      }));
      assert.ok(!entry(table,'ddl').effective_value.includes('line_id'));
      assert.equal(entry(table,'description').review_state,'needs_review');
      assert.deepEqual(entry(table,'description').human_override.structured_value,structure);
      const delivered = await readStructure(h,table,'description');
      assert.equal(delivered.effective_structure,null,
        '来源 DDL 已删除 line_id，保留的人工规则不能作为当前有效计算结构交付');
      assert.equal(delivered.structure_coverage.state,'missing_semantics');
      assert.ok(delivered.structure_coverage.notes.length && delivered.structure_text==='');
      assert.deepEqual(entry(ok(await h.request('/knowledge/'+table.id)),'description').human_override.structured_value,structure,
        '读取失败只影响采用状态，不删除维护者原值');
      checks.push('来源 DDL 删列后，正常重分析保留人工规则但工具不交付失效列结构');

      // 与首个夹具同法：去掉结构边，只剩条目登记时的旧表版本，没有已登记指纹。
      h.sql(`DELETE FROM knowledge_dependencies WHERE owner_id='${field.id}' AND role='table_binding'`);
      const legacy = await readStructure(h,field,'meaning');
      assert.equal(legacy.effective_structure,null,'依赖表 DDL 已改版，登记旧表版本的字段结构不能作为当前有效结构交付');
      assert.equal(legacy.structure_coverage.state,'missing_semantics');
      assert.ok(legacy.structure_coverage.notes.length && legacy.structure_text==='');
      const text = ok(await invoke(h,'read_knowledge',{items:[{kind:'knowledge',ref:fieldReference}]})).data.items[0];
      assert.equal(text.state,'ok','结构留缺口不拒绝条目文字');
      assert.ok(text.content.includes('维护者保留的实付金额口径'));
      const call = await openRun(h);
      const task = ok(await call('update_analysis_task',{action:'create',goal:'采用实付金额字段',options:[],
        conditions:{time_start:null,time_end:null,timezone:'UTC',metric:'synthetic_completed_amount',channel:null,
          group_by:[],filters:[],knowledge_refs:[],source_limits:null,notes:''}})).data;
      const adopted = await call('update_analysis_task',{action:'revise',task_id:task.task_id,
        expected_version:task.condition_version,goal:'',condition_patch:{set:{knowledge_refs:[fieldReference]},unset:[]},options:[]});
      assert.equal(adopted.status,409);assert.equal(adopted.value.code,'stale_knowledge','正式采用仍拒绝对不上当前 DDL 的结构');
      ok(await h.request('/knowledge/'+table.id+'/disable',{operation_id:randomUUID(),expected_version:table.version}));
      const denied = await call('read_knowledge',{items:[{kind:'knowledge',ref:fieldReference}]});
      assert.equal(denied.status,409);assert.equal(denied.value.code,'stale_knowledge','依赖表停用后整份正文仍拒绝');
      checks.push('依赖表 DDL 改版后，没有结构边的旧条目文字照常交付、结构留缺口；正式采用和停用后的读取仍拒绝');
    } finally { await h.close(); }
  }

  if (!adoptionOnly && !dependencyOnly) {
  let tableReference;
  const provider = createServer(async (req,res) => {
    let raw=''; req.setEncoding('utf8'); for await (const part of req) raw+=part;
    const request=JSON.parse(raw), input=JSON.parse(request.messages[1].content);
    assert.equal(input.object.id,'field-paid_amount_cents');
    calls++;
    const source=input.sources.find(source=>source.body.length>20);
    const output={entries:[{entry_id:'meaning',value:'合成自动建议：金额列规则',gaps:[],
      evidence:[{source_id:source.source_id,version:source.version,location:'合成证据',quote:source.body.slice(0,20)}],
      structured_value:{kind:'field',table:tableReference,column:'missing_column',unit:'分'}}]};
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{type:'function',
      function:{name:'submit_semantic_prefill',arguments:JSON.stringify(output)}}]}}],
      usage:{prompt_tokens:100,completion_tokens:80}}));
  });
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
  let h;
  try {
    // 维护单次保守预留317031微美元；合成费用须容纳它及首轮实际126，保持两调用和64KiB门。
    const profile={provider_id:'deepseek',model_id:'deepseek-flash',trial_id:randomUUID(),
      price_version:'2026-10-04-peak-usd',input_limit:32768,output_limit:2048,
      trial_call_limit:2,trial_cost_micros:'400000',request_call_limit:2,toolset:'data',payload_bytes_limit:65536};
    h=await harness({capture:true,startWorker:false,env:{DATA_AGENT_PREFILL_PROFILE:JSON.stringify(profile),
      DATA_AGENT_PREFILL_TEST:'1',DATA_AGENT_PREFILL_URL:'http://127.0.0.1:'+provider.address().port}});
    const table=ok(await h.request('/knowledge/table-demo_order_detail'));
    tableReference={object_id:table.id,version:table.version};
    const old=ok(await h.request('/knowledge/field-paid_amount_cents'));
    ok(await h.request('/knowledge/'+old.id+'/reanalyze',{operation_id:randomUUID(),expected_version:old.version}));
    await h.resumeWorker();
    const field=await until(async()=>{
      const value=ok(await h.request('/knowledge/'+old.id));
      return value.prefill_status?.state==='succeeded' && value;
    },'回环预填分析及复核完成');
    await h.pauseWorker();
    assert.equal(calls,2);
    assert.equal(entry(field,'meaning').human_override,null);
    assert.equal(entry(field,'meaning').suggestion.structured_value.column,'missing_column');
    const delivered=await readStructure(h,field,'meaning');
    assert.equal(delivered.effective_structure,null,
      '预填格式与引用校验通过，仍不能把不存在的列作为当前有效结构交付');
    assert.equal(delivered.structure_coverage.state,'missing_semantics');
    assert.ok(delivered.structure_coverage.notes.length && delivered.structure_text==='');
    checks.push('正式预填保存的错误列建议在当前读取时留缺口，不误标 complete');
  } finally {
    if(h) await h.close();
    await new Promise(resolve=>provider.close(resolve));
  }
  }
  passed=true;
} finally {
  await mkdir('.local/checks',{recursive:true});
  await writeFile('.local/checks/structure-column-bindings.json',JSON.stringify({passed,checks,
    local_provider_calls:calls,official_model_calls:0,scope:'真实 API/MySQL/维护保存与受控工具；合成来源和回环预填模型'},null,2)+'\n');
}
console.log(JSON.stringify({passed,checks,local_provider_calls:calls,official_model_calls:0}));

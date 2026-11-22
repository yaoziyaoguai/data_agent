import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {deliver} from '../../apps/agent/session/deliver.ts';
import {RustTransport} from '../../apps/agent/transport/client.ts';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {validateContract} from '../../packages/contracts/validate.ts';
import {harness, until} from './harness.mjs';

// 预期来自task-answers.md步骤1–5及交付验收；只走真实Rust HTTP和隔离合成MySQL。
// 写失败用真实deliver/本地协议，其他场景直接构造宿主条目；不验证模型理解。
// 本文件须由持有数据库harness窗口的主线串行运行。
const profile = {provider_id:'deepseek',model_id:'deepseek-flash',trial_id:randomUUID(),
  price_version:'2026-10-04-peak-usd',input_limit:65536,output_limit:4096,trial_call_limit:24,
  trial_cost_micros:'300000',request_call_limit:24,toolset:'data',payload_bytes_limit:131072};
const conditions = {time_start:null,time_end:null,timezone:'UTC',metric:null,channel:null,
  group_by:[],filters:[],knowledge_refs:[],notes:'',source_limits:null};
const usage = {input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,
  cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const firstChunks = ['合成甲已核对资料范围。🌿\n','开始状态与完成状态分别记录。\n','甲任务的说明到此结束。'];
const firstAnswer = firstChunks.join('');
const secondAnswer = '合成乙按自己的条件完成解释。';
const expected = '## 合成甲目标\n\n' + firstAnswer + '\n\n---\n\n## 合成乙目标\n\n' + secondAnswer;
const checks = [], observations = [];
let h, run, manager, taskA, taskB, sequence = 0, calls = 0, passed = false, failure, provider, providerFailure;
let faultSdk, faultCalls = 0;
const previousProvider = new Map(['DATA_AGENT_PROVIDER_TEST','DEEPSEEK_API_KEY','DEEPSEEK_BASE_URL']
  .map(key => [key,process.env[key]]));
const ok = response => {assert.equal(response.status,200,JSON.stringify(response.value));return response.value;};
const binding = () => ({run_id:run.run_id,lease_epoch:run.lease_epoch});
const checkpoint = () => exportCheckpoint(manager,
  run.workspace_context.authority_revision,run.workspace_context.authority_snapshot);
const assistant = (text, calls = [], stopReason = 'toolUse') => manager.appendMessage({role:'assistant',
  content:[...(text ? [{type:'text',text}] : []),...calls],api:'openai-completions',provider:'local_mock',
  model:'task_boundary_fixture',stopReason,usage,timestamp:Date.now()});
const invocation = (call, extra = {}) => {
  const input = {...binding(),sdk_tool_call_id:call.id,tool_name:call.name,arguments:call.arguments,
    checkpoint:checkpoint(),...extra};
  validateContract('DataToolInvocation',input);
  return input;
};
const toolResult = (input, receipt) => manager.appendMessage({role:'toolResult',
  toolCallId:input.sdk_tool_call_id,toolName:input.tool_name,
  content:[{type:'text',text:JSON.stringify(receipt.data)}],details:receipt,isError:false,timestamp:Date.now()});
const ledger = input => h.sql(`SELECT JSON_OBJECT('operation_id',operation_id,'origin_run_id',origin_run_id,
  'version',tool_contract_version,'sdk',sdk_tool_call_id,'state',state,'sequence',CAST(answer_part_sequence AS CHAR),
  'handoff',answer_handoff,'receipt',receipt) FROM tool_calls
  WHERE conversation_id='${run.conversation_id}' AND recovery_chain_id='${run.recovery_chain_id}'
    AND sdk_tool_call_id='${input.sdk_tool_call_id}'`);
const pending = () => h.sql(`SELECT JSON_OBJECT('sdk',sdk_tool_call_id) FROM tool_calls
  WHERE conversation_id='${run.conversation_id}' AND recovery_chain_id='${run.recovery_chain_id}'
    AND state='registered' ORDER BY sdk_tool_call_id`).map(row => row.sdk);
const chunks = () => h.sql(`SELECT JSON_OBJECT('seq',CAST(chunk_seq AS CHAR),'body',body) FROM output_chunks
  WHERE attempt_id='${run.attempt_id}' ORDER BY chunk_seq`);
const budget = () => h.sql(`SELECT JSON_OBJECT('message_id',message_id,'calls',issued_calls,'limit',call_limit)
  FROM budget_scopes WHERE id='${run.budget_scope_id}'`)[0];
const observe = async () => {
  const snapshot = await h.snapshot(run.conversation_id);
  return {
    active:h.sql(`SELECT JSON_OBJECT('task_id',active_task_id,'condition_version',CAST(active_task_condition_version AS CHAR))
      FROM conversations WHERE id='${run.conversation_id}'`)[0],
    message:h.sql(`SELECT JSON_OBJECT('routed_task_id',routed_task_id,'routing_state',routing_state,'disposition',disposition)
      FROM conversation_messages WHERE id='${run.message_id}'`)[0],
    frozen:h.sql(`SELECT JSON_OBJECT('sdk',sdk_tool_call_id,'sequence',CAST(answer_part_sequence AS CHAR),'handoff',answer_handoff)
      FROM tool_calls WHERE conversation_id='${run.conversation_id}' AND recovery_chain_id='${run.recovery_chain_id}'
        AND answer_part_sequence IS NOT NULL ORDER BY answer_part_sequence`),
    output:h.sql(`SELECT JSON_OBJECT('output_id',output_id,'state',state,'text',final_text,'parts',answer_parts)
      FROM assistant_outputs WHERE attempt_id='${run.attempt_id}'`)[0],
    tasks:snapshot.tasks.map(task => ({id:task.id,version:task.condition_version,phase:task.phase}))
      .sort((left,right) => left.id.localeCompare(right.id)),
    state:snapshot.runs.find(value => value.run_id === run.run_id)?.state,
    routes:snapshot.events.filter(event => event.type === 'task_changed' && event.payload.routed === true),
    commits:snapshot.events.filter(event => event.type === 'assistant_committed' && event.payload.output_id === run.output_id),
    chunks:chunks(),budget:budget(),
  };
};
const assertActive = (state, task) => {
  assert.deepEqual(state.active,{task_id:task.task_id,condition_version:task.condition_version});
  assert.equal(state.message.routed_task_id,task.task_id);
  assert.equal(state.message.disposition,'pending');
};
const append = async texts => {
  const first = sequence + 1;
  for (const text of texts) {
    const seq = String(++sequence);
    assert.equal(ok(await h.internal('/internal/outputs',{...binding(),chunk_seq:seq,text})).chunk_seq,seq);
  }
  return {first,last:sequence};
};
const outputBinding = (entryId, range) => {
  const entry = manager.getEntry(entryId);
  assert.equal(entry?.type,'message'); assert.equal(entry.message.role,'assistant');
  const text = entry.message.content.filter(part => part.type === 'text').map(part => part.text).join('');
  return {entry_id:entry.id,attempt_id:run.attempt_id,stop_reason:entry.message.stopReason,
    tool_call_ids:entry.message.content.filter(part => part.type === 'toolCall').map(part => part.id),
    text_sha256:createHash('sha256').update(text,'utf8').digest('hex'),
    ...(range ? {first_chunk_seq:String(range.first),last_chunk_seq:String(range.last)} : {})};
};
const route = (range, options = {}) => {
  const {stop = 'toolUse',mixed = false,target = taskB,text = firstAnswer} = options;
  const finalize = Object.hasOwn(options,'finalize') ? options.finalize : true;
  const call = {type:'toolCall',id:randomUUID(),name:'update_analysis_task',arguments:{action:'route',
    task_id:target.task_id,expected_version:target.condition_version,options:[],
    ...(finalize === undefined ? {} : {finalize_current_answer:finalize})}};
  const calls = [call,...(mixed ? [{type:'toolCall',id:randomUUID(),name:'read_analysis_task',
    arguments:{task_id:taskA.task_id}}] : [])];
  const entry = assistant(text,calls,stop);
  const input = invocation(call,finalize === true ? {answer_handoff:{assistant:outputBinding(entry,range)}} : {});
  validateContract('AnalysisUpdate',input.arguments);
  assert.equal(input.checkpoint.leaf_id,entry,'交接引用必须来自刚写入真实Pi的完整助手条目');
  return input;
};
const register = async input => {
  const receipt = ok(await h.internal('/internal/data/tool-calls',input));
  assert.equal(receipt.tool_contract_version,run.tool_contract_version);
  const saved = ledger(input);
  assert.equal(saved.length,1); assert.equal(saved[0].operation_id,receipt.operation_id);
  assert.equal(saved[0].origin_run_id,run.run_id); assert.equal(saved[0].version,run.tool_contract_version);
  assert.equal(saved[0].state,'registered'); assert.equal(saved[0].sequence,null);
  assert.equal(saved[0].receipt,null);
  return receipt;
};
const createTask = async (goal, allowedSources) => {
  const taskConditions = allowedSources === undefined ? conditions : {...conditions,
    source_limits:{allowed_sources:allowedSources,origin_message_ids:[run.message_id]}};
  const call = {type:'toolCall',id:randomUUID(),name:'update_analysis_task',
    arguments:{action:'create',goal,conditions:taskConditions,options:[]}};
  assistant('',[call]); const input = invocation(call);
  const registered = await register(input), receipt = ok(await h.internal('/internal/data/tools',input));
  assert.equal(receipt.operation_id,registered.operation_id); assert.equal(receipt.data.error,undefined);
  assert.equal(receipt.tool_contract_version,run.tool_contract_version);
  const snapshot = await h.request('/conversations/'+run.conversation_id+'/snapshot');
  assert.equal(snapshot.status,200,snapshot.value.code);
  assert.equal(snapshot.value.tasks.find(task => task.id === receipt.data.task_id)?.goal,goal);
  assert.equal(ledger(input)[0].state,'succeeded');
  toolResult(input,receipt);
  if (allowedSources !== undefined && receipt.context_reset) {
    manager.appendCompaction('按当前任务的来源范围继续。',null,0,{},true);
    run.workspace_context = ok(await h.internal('/internal/context/refresh',
      {...binding(),sdk_tool_call_id:input.sdk_tool_call_id,checkpoint:checkpoint()}));
  }
  return receipt.data;
};
const begin = async (label, version = 2, single = false, includeThird = false, sources = {}) => {
  await h.resumeWorker();
  run = await h.capture(await h.create(),'分别说明合成目标，核对' + label + '。');
  await h.pauseWorker();
  assert.equal(run.tool_contract_version,2,'新消息使用当前工具合同');
  assert.deepEqual(budget(),{message_id:run.message_id,calls:0,limit:24});
  manager = SessionManager.inMemory('/synthetic/task-answer-boundaries'); sequence = 0;
  manager.appendMessage({role:'user',content:run.text,timestamp:Date.now()});
  const taskC = includeThird ? await createTask('合成丙目标') : undefined;
  taskB = single ? undefined : await createTask('合成乙目标',sources.b);
  taskA = await createTask('合成甲目标',sources.a);
  const state = await observe();
  assertActive(state,taskA); assert.deepEqual(state.frozen,[]); assert.deepEqual(pending(),[]);
  assert.equal(state.output.state,'streaming'); assert.equal(state.state,'running');
  const attached = h.sql(`SELECT JSON_OBJECT('task_id',task_id) FROM conversation_message_tasks
    WHERE message_id='${run.message_id}' ORDER BY task_id`).map(row => row.task_id);
  assert.deepEqual(attached,[taskA.task_id,...(taskB ? [taskB.task_id] : []),...(taskC ? [taskC.task_id] : [])].sort(),
    '反例开始前全部真实任务均已登记本消息归属，不能由缺任务掩盖边界');
  // 旧运行继承已持久任务；退役合同本身不执行新的创建动作。
  if (version === 1) {
    h.sql(`UPDATE agent_runs SET tool_contract_version=1 WHERE id='${run.run_id}'`);
    run.tool_contract_version = 1;
  }
  return taskC;
};
const retire = () => {
  // 捕获式负控没有finish；只收尾隔离库调度，避免下个场景恢复它。保留工具/输出事实。
  // 按会话清理全部未完成job：查询结果通知也会产生恢复调度，不能只看本消息。
  h.sql(`UPDATE agent_runs SET state='failed' WHERE id='${run.run_id}' AND state='running';
    UPDATE conversations SET lease_owner=NULL,lease_until=NULL
      WHERE id='${run.conversation_id}' AND lease_owner='${run.run_id}';
    UPDATE background_jobs SET state='failed',lease_owner=NULL,lease_until=NULL
      WHERE conversation_id='${run.conversation_id}' AND state<>'finished';
    UPDATE conversation_messages SET disposition='failed'
      WHERE id='${run.message_id}' AND disposition='pending';`);
  h.releaseRun(run.run_id); run = undefined;
};
const rejectRegistration = async (label, input, code, status = 409) => {
  const before = await observe(), response = await h.internal('/internal/data/tool-calls',input), after = await observe();
  observations.push({label,stage:'register',status:response.status,code:response.value.code ?? null,before,after,ledger:ledger(input)});
  assert.deepEqual(after,before,label + '：拒绝不能冻结、切任务或提交正文');
  assert.equal(response.status,status,JSON.stringify(response.value)); assert.equal(response.value.code,code);
  assert.deepEqual(ledger(input),[],'拒绝的首次登记不能留下成功或未结算工具行');
  checks.push(label);
};
const rejectExecution = async (label, input, code) => {
  await register(input);
  const before = await observe(), response = await h.internal('/internal/data/tools',input), after = await observe();
  observations.push({label,stage:'execute',status:response.status,code:response.value.code ?? null,before,after,ledger:ledger(input)});
  assert.deepEqual(after,before,label + '：拒绝不能冻结、切任务或提交正文');
  assert.equal(response.status,409,JSON.stringify(response.value)); assert.equal(response.value.code,code);
  const saved = ledger(input)[0];
  assert.equal(saved.sequence,null); assert.notEqual(saved.state,'succeeded');
  assert.deepEqual(saved.handoff.handoff,input.answer_handoff,'拒绝不篡改原登记的条目/attempt/片段');
  checks.push(label);
};
const rejectFinish = async (label, input) => {
  validateContract('FinishRun',input);
  const before = await observe(), response = await h.internal('/internal/finish',input), after = await observe();
  observations.push({label,stage:'finish',status:response.status,code:response.value.code ?? null,before,after});
  assert.equal(before.frozen.length,1); assertActive(before,taskB);
  assert.equal(response.status,409,label + '：不能仅提交B或跳过原冻结顺序：' + JSON.stringify(response.value));
  assert.equal(response.value.code,'invalid_evidence');
  assert.deepEqual(after,before,label + '：拒绝不能提交正文、消耗消息或丢掉A');
  checks.push(label);
};
const freezeFirst = async () => {
  const range = await append(firstChunks), input = route(range);
  assert.deepEqual(chunks(),firstChunks.map((body,index) => ({seq:String(index+1),body})));
  const registered = await register(input);
  assert.deepEqual(pending(),[input.sdk_tool_call_id],'成功正控中只有route自身处于registered');
  assert.deepEqual(ledger(input)[0].handoff.handoff,input.answer_handoff);
  const receipt = ok(await h.internal('/internal/data/tools',input));
  assert.equal(receipt.operation_id,registered.operation_id); assert.equal(receipt.data.error,undefined);
  assert.equal(receipt.answer_parts.length,1); assert.deepEqual(receipt.answer_parts[0].task_ref,
    {task_id:taskA.task_id,condition_version:taskA.condition_version});
  assert.equal(receipt.answer_parts[0].finalized_by_sdk_tool_call_id,input.sdk_tool_call_id);
  const saved = ledger(input)[0], state = await observe();
  assert.equal(saved.sequence,'1'); assert.equal(saved.state,'succeeded');
  assertActive(state,taskB); assert.equal(state.frozen.length,1); assert.deepEqual(state.commits,[]);
  assert.equal(state.routes.filter(event => event.payload.task_id === taskB.task_id).length,1);
  toolResult(input,receipt);
  return {input,receipt,saved};
};
const finalInput = async (text, parts, task = taskB) => {
  const entry = assistant(text,[],'stop'), range = await append([text]);
  const reference = {task_ref:{task_id:task.task_id,condition_version:task.condition_version},
    output_binding:outputBinding(entry,range)};
  return {...binding(),commit_id:randomUUID(),final_text:text,final_start_chunk_seq:String(range.first),
    checkpoint:checkpoint(),...(parts ? {answer_parts:[...parts,reference]} : {})};
};
// 链上依次冻结当前活动任务正文并切到下一目标；返回最后一次route回执（含累计parts）。
const freezeChain = async (order, finalTask, bodyFor) => {
  let receipt;
  for (let index = 0; index < order.length; index++) {
    const current = order[index];
    assertActive(await observe(), current);
    const body = bodyFor(current);
    const input = route(await append([body]), {target: order[index+1] ?? finalTask, text: body});
    const registered = await register(input);
    receipt = ok(await h.internal('/internal/data/tools', input));
    assert.equal(receipt.operation_id, registered.operation_id);
    assert.equal(receipt.data.error, undefined);
    assert.equal(receipt.answer_parts.length, index+1);
    toolResult(input, receipt);
  }
  return receipt;
};

try {
  provider = createServer(async (request,response) => {
    try {
      const buffers = []; for await (const buffer of request) buffers.push(buffer);
      const raw = Buffer.concat(buffers).toString('utf8'), body = JSON.parse(raw);
      assert.ok(Buffer.byteLength(raw) <= profile.payload_bytes_limit);
      assert.equal(request.headers.authorization,'Bearer synthetic-protocol-key');
      assert.ok(faultSdk,'只有输出写失败场景允许请求本地provider');
      assert.ok(body.tools?.length,'不增加摘要或汇总调用');
      calls++; faultCalls++; assert.ok(faultCalls <= 2,'只允许原route消息及失败后的自然末条');
      if (faultCalls === 2) {
        const receipt = body.messages.findLast(message => message.role === 'tool' && message.tool_call_id === faultSdk);
        assert.ok(receipt,'Pi须先观察原route的写入拒绝');
        assert.match(JSON.stringify(receipt.content),/chunk_gap/);
      }
      response.writeHead(200,{'content-type':'text/event-stream'});
      const emit = (delta,finish_reason=null) => response.write('data: ' + JSON.stringify({id:'synthetic-output-boundary',
        choices:[{index:0,delta,finish_reason}]}) + '\n\n');
      emit({role:'assistant',content:faultCalls === 1 ? firstAnswer : '合成写入失败，不能声称甲已完成。'});
      if (faultCalls === 1) emit({tool_calls:[{index:0,id:faultSdk,type:'function',function:{name:'update_analysis_task',
        arguments:JSON.stringify({action:'route',task_id:taskB.task_id,expected_version:taskB.condition_version,
          options:[],finalize_current_answer:true})}}]});
      emit({},faultCalls === 1 ? 'tool_calls' : 'stop');
      response.write('data: ' + JSON.stringify({choices:[],usage:{prompt_tokens:100,completion_tokens:100,total_tokens:200}}) + '\n\n');
      response.end('data: [DONE]\n\n');
    } catch (error) {
      providerFailure ??= error;
      if (!response.headersSent) response.writeHead(400,{'content-type':'application/json'});
      response.end(JSON.stringify({error:{message:'synthetic_boundary_provider_assertion'}}));
    }
  });
  await new Promise(resolve => provider.listen(0,'127.0.0.1',resolve));
  h = await harness({capture:true,startWorker:false,web:true,profile,
    protocolProviderUrl:'http://127.0.0.1:' + provider.address().port,env:{DATA_AGENT_LEASE_MS:'120000',
      DATA_AGENT_QUERY_DELAY_SECONDS:'0.1',DATA_AGENT_TOOL_CONTRACT_VERSION:'1',DATA_AGENT_PREFILL_PROFILE:'',DATA_AGENT_VECTOR_URL:'',DATA_AGENT_VECTOR_COLLECTION:''}});
  Object.assign(process.env,{DATA_AGENT_PROVIDER_TEST:'1',DEEPSEEK_API_KEY:'synthetic-protocol-key',
    DEEPSEEK_BASE_URL:'http://127.0.0.1:' + provider.address().port});

  // 原单任务直接自然final；不能为新组合合同强迫v1/v2多一次route或答案工具。
  for (const version of [1,2]) {
    await begin('单任务自然回答v' + version,version,true);
    if (version === 2) {
      h.sql(`UPDATE tool_calls SET completed_at=TIMESTAMPADD(MICROSECOND,-5000,created_at)
        WHERE origin_run_id='${run.run_id}' AND state='succeeded'`);
      const {runs} = await h.snapshot(run.conversation_id);
      const active = runs.find(item => item.run_id === run.run_id);
      assert.equal(active.completed_steps,1);
      assert.deepEqual(active.completed_step_summaries,[]);
      checks.push('逆序的耗时记录不造耗时，已完成计数与会话快照仍可读取');
    }
    assistant(firstAnswer,[],'stop'); await append(firstChunks);
    const input = {...binding(),commit_id:randomUUID(),final_text:firstAnswer,checkpoint:checkpoint()};
    const receipt = ok(await h.internal('/internal/finish',input)); assert.equal(receipt.output_id,run.output_id);
    const snapshot = await h.snapshot(run.conversation_id), state = await observe();
    assert.equal(snapshot.messages.findLast(message => message.role === 'assistant' && message.committed)?.text,firstAnswer);
    assert.equal(state.commits.length,1); assert.deepEqual(state.frozen,[]);
    assert.equal(state.state,'finished'); assert.equal(state.output.text,firstAnswer);
    assert.deepEqual(state.budget,{message_id:run.message_id,calls:0,limit:24});
    checks.push('原单任务v' + version + '无额外route/答案工具的自然final保持'); retire();
  }

  for (const finalize of [undefined,false]) {
    await begin(finalize === undefined ? '普通route省略定稿' : '普通route显式false');
    const range = await append(firstChunks);
    // 用完整助手正文及实际持久chunk做前提，message_end本身不能产生part。
    const input = route(range,{finalize}), before = await observe();
    assert.deepEqual(before.frozen,[]); assert.equal(input.answer_handoff,undefined);
    const registered = await register(input), receipt = ok(await h.internal('/internal/data/tools',input));
    assert.equal(receipt.operation_id,registered.operation_id);
    const after = await observe(), saved = ledger(input)[0];
    assertActive(after,taskB); assert.deepEqual(after.frozen,[]); assert.deepEqual(after.commits,[]);
    assert.deepEqual(after.chunks,before.chunks); assert.equal(saved.handoff,null); assert.equal(saved.sequence,null);
    assert.equal(saved.state,'succeeded'); assert.deepEqual(receipt.answer_parts ?? [],[]);
    checks.push('普通route ' + (finalize === undefined ? '省略标志' : 'false') + '只切任务、不冻结'); retire();
  }

  const schemaSource = {kind:'platform',id:'schema'}, etlSource = {kind:'platform',id:'etl'};
  for (const scenario of [
    {label:'不同来源任务不能用最后任务正文结清全部任务',sources:{a:[schemaSource],b:[etlSource]},allowed:false},
    {label:'旧任务来源未知不能当作相同来源综合交付',sources:{},unknown:true,allowed:false},
    {label:'两任务明确无限制可沿原自然回答综合交付',sources:{},allowed:true},
    {label:'相同允许集合顺序不同仍可自然综合交付',sources:{a:[schemaSource,etlSource],b:[etlSource,schemaSource]},allowed:true},
    {label:'相同来源重复项按集合等价仍可自然综合交付',sources:{a:[schemaSource,schemaSource],b:[schemaSource]},allowed:true},
  ]) {
    await begin(scenario.label,2,false,false,scenario.sources);
    if (scenario.unknown) {
      // 模拟旧条件缺少来源声明；缺字段不能被当成已明确的null。
      h.sql(`UPDATE condition_revisions SET body=JSON_REMOVE(body,'$.source_limits')
        WHERE task_id='${taskA.task_id}'`);
    }
    const input = route(undefined,{finalize:false,text:'继续核对乙任务。'});
    await register(input);
    const receipt = ok(await h.internal('/internal/data/tools',input));
    toolResult(input,receipt);
    if (receipt.context_reset) {
      manager.appendCompaction('已按当前任务来源继续。',null,0,{},true);
      run.workspace_context = ok(await h.internal('/internal/context/refresh',
        {...binding(),sdk_tool_call_id:input.sdk_tool_call_id,checkpoint:checkpoint()}));
    }
    const answer = scenario.allowed ? firstAnswer + '\n' + secondAnswer : secondAnswer;
    const completion = await finalInput(answer), before = await observe();
    assert.deepEqual(before.frozen,[]); assert.equal(completion.answer_parts,undefined);
    const response = await h.internal('/internal/finish',completion), after = await observe();
    observations.push({label:scenario.label,stage:'finish',status:response.status,
      code:response.value.code ?? null,before,after});
    if (scenario.allowed) {
      assert.equal(ok(response).output_id,run.output_id);
      assert.equal(after.output.text,answer); assert.equal(after.commits.length,1);
      assert.deepEqual(after.tasks.map(task => task.phase),['answered','answered']);
      assert.deepEqual(after.tasks.map(({id,version}) => ({id,version})),
        before.tasks.map(({id,version}) => ({id,version})), '自然综合保留原任务和条件身份');
      assert.deepEqual(after.budget,before.budget,'交付不能补加模型额度');
    } else {
      assert.equal(response.status,409,scenario.label + '：' + JSON.stringify(response.value));
      assert.equal(response.value.code,'invalid_evidence');
      assert.deepEqual(after,before,'拒绝不能消费原消息或把遗漏任务标为answered');
    }
    checks.push(scenario.label); retire();
  }

  // 成功答案工具引用同样不能绕过无parts覆盖核验；单任务合法回执保持直接提交。
  const invokeTool = async (name, args) => {
    const call = {type:'toolCall',id:randomUUID(),name,arguments:args};
    assistant('',[call]); const input = invocation(call);
    const registered = await register(input);
    const receipt = ok(await h.internal('/internal/data/tools',input));
    assert.equal(receipt.operation_id,registered.operation_id); assert.ok(!receipt.data.error,JSON.stringify(receipt.data));
    toolResult(input,receipt);
    return {input,receipt};
  };
  const renderAnswer = async task => {
    const query = (await invokeTool('request_query',{task_id:task.task_id,condition_version:task.condition_version,
      sql:'SELECT 42 AS amount',parameters:{},target_id:'synthetic-sqlite',
      summary:'合成答案金额',knowledge_refs:[],replaces_query_id:null})).receipt.data;
    ok(await h.request('/queries/'+query.id+'/confirm',{operation_id:randomUUID(),
      draft_version:query.draft_version,condition_version:query.condition_version}));
    await h.resumeWorker();
    await until(async () => ok(await h.request('/queries/'+query.id)).execution_state==='succeeded','合成答案查询完成',40000);
    await h.pauseWorker();
    const detail = (await invokeTool('get_query',{query_id:query.id})).receipt.data;
    assert.equal(detail.query.execution_state,'succeeded','合成答案查询先真实执行');
    const {input,receipt} = await invokeTool('prepare_analysis_answer',{
      sources:[{query_id:query.id,result_ref:detail.results.result_ref,columns:['amount']}],
      values:[{name:'amount',kind:'cell',query_id:query.id,column:'amount',row_index:0}]});
    const template = '合成答案金额{{amount}}分。';
    const entry = assistant(template,[],'stop');
    const display = template.replace('{{amount}}',receipt.data.bindings.amount) + receipt.data.required_suffix;
    const range = await append([display]);
    return {display,binding:{assistant:outputBinding(entry),source_text:template,
      prepared_sdk_tool_call_id:input.sdk_tool_call_id,
      first_chunk_seq:String(range.first),last_chunk_seq:String(range.last)}};
  };
  {
    await begin('grounded跨范围结清',2,false,false,{});
    // 甲未声明来源、乙明确无限制：范围不一致不能由乙的成功答案回执一起结清。
    h.sql(`UPDATE condition_revisions SET body=JSON_REMOVE(body,'$.source_limits')
      WHERE task_id='${taskA.task_id}'`);
    const switching = route(undefined,{finalize:false,text:'继续核对乙任务。'});
    await register(switching);
    const switched = ok(await h.internal('/internal/data/tools',switching));
    toolResult(switching,switched);
    if (switched.context_reset) {
      manager.appendCompaction('已按当前任务来源继续。',null,0,{},true);
      run.workspace_context = ok(await h.internal('/internal/context/refresh',
        {...binding(),sdk_tool_call_id:switching.sdk_tool_call_id,checkpoint:checkpoint()}));
    }
    const rendered = await renderAnswer(taskB);
    const completion = {...binding(),commit_id:randomUUID(),final_text:rendered.display,
      rendered_answer_binding:rendered.binding,
      checkpoint:checkpoint()}, before = await observe();
    assert.deepEqual(before.frozen,[]);
    const response = await h.internal('/internal/finish',completion), after = await observe();
    observations.push({label:'范围不一致任务的grounded答案引用不能结清全部任务',stage:'finish',
      status:response.status,code:response.value.code ?? null,before,after});
    assert.equal(response.status,409,'grounded提交不能绕过跨范围覆盖：' + JSON.stringify(response.value));
    assert.equal(response.value.code,'invalid_evidence');
    assert.deepEqual(after,before,'拒绝不能消费原消息或把甲标为answered');
    checks.push('范围不一致任务的grounded答案引用不能结清全部任务'); retire();
  }
  {
    await begin('单任务grounded直接提交',2,true);
    const rendered = await renderAnswer(taskA);
    const completion = {...binding(),commit_id:randomUUID(),final_text:rendered.display,
      rendered_answer_binding:rendered.binding,
      checkpoint:checkpoint()};
    const finished = ok(await h.internal('/internal/finish',completion)), state = await observe();
    assert.equal(finished.output_id,run.output_id);
    assert.equal(state.output.text,rendered.display);
    assert.equal(state.commits.length,1); assert.equal(state.state,'finished');
    checks.push('单任务成功答案回执的直接提交保持'); retire();
  }

  await begin('旧v1拒绝新定稿参数',1);
  await rejectRegistration('v1不能登记v2定稿',route(await append(firstChunks)),'invalid_input',400); retire();

  await begin('单条助手混工具');
  const mixed = route(await append(firstChunks),{mixed:true});
  assert.equal(mixed.answer_handoff.assistant.tool_call_ids.length,2);
  await rejectRegistration('单条route混read_analysis_task拒绝且不冻结/不切任务',mixed,'invalid_evidence'); retire();

  for (const stop of ['length','error','aborted']) {
    await begin('完整持久正文但终止原因为' + stop);
    const input = route(await append(firstChunks),{stop});
    assert.equal(input.answer_handoff.assistant.stop_reason,stop);
    await rejectRegistration(stop + '完整助手条目拒绝定稿且不切任务',input,'invalid_evidence'); retire();
  }

  await begin('没有已持久片段');
  const missing = route(); assert.deepEqual(chunks(),[]);
  assert.equal(missing.answer_handoff.assistant.first_chunk_seq,undefined);
  await rejectExecution('完整助手正文但无持久chunk拒绝且不冻结/不切任务',missing,'chunk_gap'); retire();

  await begin('已确认输出缺尾片段');
  const tailRange = await append(firstChunks), tail = route(tailRange);
  // 故障仅注入本次attempt：先真实HTTP确认全部chunk，再移除末片，宿主绑定保持原值。
  h.sql(`DELETE FROM output_chunks WHERE attempt_id='${run.attempt_id}' AND chunk_seq=3`);
  assert.deepEqual(chunks().map(chunk => chunk.seq),['1','2']);
  await rejectExecution('已确认范围缺末chunk拒绝且不冻结/不切任务',tail,'chunk_gap'); retire();

  await begin('已确认输出不连续');
  const gapRange = await append(firstChunks), gap = route(gapRange);
  h.sql(`DELETE FROM output_chunks WHERE attempt_id='${run.attempt_id}' AND chunk_seq=2`);
  assert.deepEqual(chunks().map(chunk => chunk.seq),['1','3']);
  await rejectExecution('已确认范围内部chunk不连续拒绝且不冻结/不切任务',gap,'chunk_gap'); retire();

  await begin('前序工具仍registered');
  const earlierCall = {type:'toolCall',id:randomUUID(),name:'read_analysis_task',arguments:{task_id:taskA.task_id}};
  assistant('',[earlierCall]); const earlier = invocation(earlierCall); await register(earlier);
  const earlierSaved = ledger(earlier);
  const blocked = route(await append(firstChunks));
  assert.deepEqual(pending(),[earlier.sdk_tool_call_id],'只有真实登记而未执行的前序工具构成阻塞');
  await rejectExecution('前序registered未结算拒绝定稿且不冻结/不切任务',blocked,'outcome_unknown');
  assert.deepEqual(ledger(earlier),earlierSaved,'不能为了定稿擅自结算或清除前序操作'); retire();

  // 正控：排除route自身后应可冻结；最后任务沿原自然final一次确定性提交。
  await begin('只有原route未结算的成功正控');
  const frozen = await freezeFirst(), frozenState = await observe();
  assert.equal(ok(await h.internal('/internal/data/tool-calls',frozen.input)).operation_id,frozen.saved.operation_id);
  assert.deepEqual(ok(await h.internal('/internal/data/tools',frozen.input)).answer_parts,frozen.receipt.answer_parts);
  assert.deepEqual(ledger(frozen.input)[0],frozen.saved,'原route重放不换operation/引用、不重复冻结');
  assert.deepEqual(await observe(),frozenState,'原route重放不再次切任务');
  const completed = await finalInput(secondAnswer,frozen.receipt.answer_parts);
  await rejectFinish('乙尚未取消时，不能只提交已冻结甲后静默结束原消息',
    {...binding(),commit_id:randomUUID(),answer_parts:frozen.receipt.answer_parts,checkpoint:checkpoint()});
  await rejectFinish('已有新末项正文时，不能把冻结甲伪装为末项',
    {...completed,commit_id:randomUUID(),answer_parts:frozen.receipt.answer_parts});
  await rejectFinish('finish只发最后B引用不能静默遗漏已冻结A',
    {...completed,commit_id:randomUUID(),answer_parts:[completed.answer_parts[1]]});
  await rejectFinish('finish引用乱序不能跳过已冻结A的顺序',
    {...completed,commit_id:randomUUID(),answer_parts:[completed.answer_parts[1],completed.answer_parts[0]]});
  assert.equal(ok(await h.internal('/internal/finish',completed)).output_id,run.output_id);
  ok(await h.internal('/internal/finish',completed));
  const delivered = await observe(), deliveredSnapshot = await h.snapshot(run.conversation_id);
  assert.equal(delivered.state,'finished'); assert.equal(delivered.output.text,expected);
  assert.equal(deliveredSnapshot.messages.findLast(message => message.role === 'assistant' && message.committed)?.text,expected);
  assert.deepEqual(delivered.output.parts,completed.answer_parts); assert.equal(delivered.commits.length,1);
  assert.equal(delivered.frozen.length,1); assert.equal(delivered.frozen[0].sequence,'1');
  assert.equal(delivered.chunks.map(chunk => chunk.body).join(''),firstAnswer + secondAnswer);
  assert.deepEqual(delivered.budget,{message_id:run.message_id,calls:0,limit:24});
  checks.push('成功正控：route自身不算前序未结算，重放只冻结一次，自然B按原引用组合并一次提交'); retire();

  await begin('有新末项时不能遗漏第三个有效任务',2,false,true);
  const firstOfThree = await freezeFirst();
  await rejectFinish('三任务只提交甲乙，不能静默遗漏仍有效的丙',
    await finalInput(secondAnswer,firstOfThree.receipt.answer_parts));
  retire();

  const taskC = await begin('三个有效任务分别交付',2,false,true);
  await freezeFirst();
  const handoffToThird = route(await append([secondAnswer]),{target:taskC,text:secondAnswer});
  await register(handoffToThird);
  const secondFrozen = ok(await h.internal('/internal/data/tools',handoffToThird));
  toolResult(handoffToThird,secondFrozen);
  assert.deepEqual(secondFrozen.answer_parts.map(part => part.task_ref.task_id),[taskA.task_id,taskB.task_id]);
  const thirdAnswer = '合成丙按自己的目标完成解释。';
  const allThree = await finalInput(thirdAnswer,secondFrozen.answer_parts,taskC);
  assert.equal(ok(await h.internal('/internal/finish',allThree)).output_id,run.output_id);
  const allDelivered = await observe(), allSnapshot = await h.snapshot(run.conversation_id);
  const combinedThree = expected + '\n\n---\n\n## 合成丙目标\n\n' + thirdAnswer;
  assert.equal(allSnapshot.messages.findLast(message => message.role === 'assistant' && message.committed)?.text,combinedThree);
  assert.equal(allDelivered.output.text,combinedThree); assert.equal(allDelivered.commits.length,1);
  assert.deepEqual(allDelivered.output.parts,allThree.answer_parts);
  assert.deepEqual(allDelivered.tasks.map(task => task.phase),['answered','answered','answered']);
  assert.deepEqual(allDelivered.budget,{message_id:run.message_id,calls:0,limit:24});
  checks.push('三个有效任务分别沿原引用一次交付，不遗漏、不增加模型调用'); retire();

  // R02：单份仍限8000；已核验多份正文按实际项数原样合并，不再共同挤占单份槽。
  {
    await begin('长正文合并容量');
    const longA = '甲'.repeat(4098) + '🌿'.repeat(3900);
    assert.equal([...longA].length, 7998, '按Unicode字符计7998，UTF-8字节更多');
    const longRoute = route(await append([longA]), {text: longA});
    await register(longRoute);
    const longFrozen = ok(await h.internal('/internal/data/tools', longRoute));
    assert.equal(longFrozen.answer_parts.length, 1);
    toolResult(longRoute, longFrozen);
    const longB = '乙'.repeat(4098) + '🌿'.repeat(3900);
    const finishLong = await finalInput(longB, longFrozen.answer_parts);
    assert.equal(ok(await h.internal('/internal/finish', finishLong)).output_id, run.output_id);
    const longState = await observe();
    const longExpected = '## 合成甲目标\n\n' + longA + '\n\n---\n\n## 合成乙目标\n\n' + longB;
    assert.ok(longExpected.length > 8000, '合并正文必须超过单份8000');
    assert.equal(longState.output.text, longExpected, '旧冻结7998项与末项都按原字符原样出现');
    const longSnapshot = await h.snapshot(run.conversation_id);
    assert.equal(longSnapshot.messages.findLast(message => message.role === 'assistant' && message.committed)?.text, longExpected);
    assert.equal((await h.snapshot(run.conversation_id)).messages
      .findLast(message => message.role === 'assistant' && message.committed)?.text, longExpected, '历史重读保持合并正文');
    assert.equal(longState.commits.length, 1);
    checks.push('R02：两份7998字符（含非BMP）已核验正文原样合并，超过单份8000且历史重读一致'); retire();
  }
  {
    await begin('单份正文超限拒绝');
    const over = await h.internal('/internal/finish', {...binding(), commit_id: randomUUID(),
      final_text: '超'.repeat(8001), checkpoint: checkpoint()});
    assert.equal(over.status, 400, JSON.stringify(over.value));
    assert.equal(over.value.code, 'invalid_input');
    const overState = await observe();
    assert.equal(overState.state, 'running'); assert.deepEqual(overState.commits, []);
    checks.push('R02：单份8001正文在FinishRun合同边界拒绝，不推进提交'); retire();
  }
  {
    await begin('引用数量超限拒绝');
    const frozen = await freezeFirst();
    const over = await h.internal('/internal/finish', {...binding(), commit_id: randomUUID(),
      answer_parts: Array.from({length:25}, () => frozen.receipt.answer_parts[0]),
      checkpoint: checkpoint()});
    assert.equal(over.status, 400, JSON.stringify(over.value));
    assert.equal(over.value.code, 'invalid_input');
    checks.push('R02：25项answer_parts在FinishRun合同边界拒绝，不提交'); retire();
  }

  // R02补验收①：五份7998字符合法合并实际跨越旧ChatMessage 32000字符与旧TEXT 65535字节；
  // 旧冻结7998项经真实中断/恢复后按原引用交付，事件/历史/浏览器刷新核对原文。
  {
    const label = '五份跨旧门槛合并容量';
    const taskC = await begin(label,2,false,true);
    const extraD = await createTask('合成丁目标'), extraE = await createTask('合成戊目标');
    const goals = new Map([[taskA.task_id,'合成甲目标'],[taskB.task_id,'合成乙目标'],
      [taskC.task_id,'合成丙目标'],[extraD.task_id,'合成丁目标'],[extraE.task_id,'合成戊目标']]);
    const bodyFor = task => goals.get(task.task_id).slice(2,3).repeat(4098) + '🌿'.repeat(3900);
    const chain = [extraE, extraD, taskC, taskB];
    const lastFrozen = await freezeChain(chain, taskA, bodyFor);
    assert.equal(lastFrozen.answer_parts.length,4);
    assert.deepEqual((await observe()).frozen.map(frozen => frozen.sequence),['1','2','3','4']);
    // 与after_business_commit相同的中断窗口：四份旧冻结7998项已入账，恢复必须沿原链交付。
    const prior = run, captured = h.captured.length;
    h.releaseRun(prior.run_id);
    h.sql(`UPDATE agent_runs SET state='interrupted' WHERE id='${prior.run_id}';UPDATE conversations SET lease_owner=NULL,lease_until=NULL WHERE id='${prior.conversation_id}';UPDATE background_jobs SET state='queued',lease_owner=NULL,lease_until=NULL WHERE message_id='${prior.message_id}';`);
    await h.resumeWorker();
    run = await until(async () => {
      const failure = (await h.snapshot(prior.conversation_id)).events.find(event => event.type==='run_failed');
      assert.ok(!failure,'四份旧冻结项恢复必须沿原输入继续：'+JSON.stringify(failure));
      return h.captured.slice(captured).find(value => value.message_id===prior.message_id);
    },'旧冻结7998项的原输入恢复');
    await h.pauseWorker();
    assert.equal(run.resume_same_input,true);
    assert.equal(run.recovery_chain_id,prior.recovery_chain_id);
    // 新attempt的输出片段从1起；本地计数器跟随恢复后的运行重新计。
    sequence = 0;
    assert.deepEqual((await observe()).frozen.map(frozen => frozen.sequence),['1','2','3','4'],
      '恢复不重复冻结也不丢原引用');
    const finalBody = bodyFor(taskA);
    const completion = await finalInput(finalBody, lastFrozen.answer_parts, taskA);
    assert.equal(ok(await h.internal('/internal/finish',completion)).output_id,run.output_id);
    const sections = [...chain, taskA].map(task =>
      '## ' + goals.get(task.task_id) + '\n\n' + bodyFor(task));
    const merged = sections.join('\n\n---\n\n');
    assert.ok([...merged].length > 32000,
      '合并Unicode字符必须超过旧ChatMessage 32000上限：' + [...merged].length);
    assert.ok(Buffer.byteLength(merged,'utf8') > 65535,
      '合并UTF-8字节必须超过旧TEXT 65535上限：' + Buffer.byteLength(merged,'utf8'));
    const bigState = await observe();
    assert.equal(bigState.output.text,merged,'五份原字符原样合并交付');
    assert.equal(bigState.commits.length,1);
    assert.equal(bigState.commits[0].payload.text,merged,'assistant_committed事件携带完整合并正文');
    assert.deepEqual(bigState.output.parts,completion.answer_parts);
    assert.equal(bigState.tasks.length,5);
    assert.deepEqual(bigState.tasks.map(task => task.phase),['answered','answered','answered','answered','answered']);
    assert.deepEqual(bigState.budget,{message_id:run.message_id,calls:0,limit:24});
    const bigSnapshot = await h.snapshot(run.conversation_id);
    assert.equal(bigSnapshot.messages.findLast(message => message.role==='assistant' && message.committed)?.text,merged);
    assert.equal((await h.snapshot(run.conversation_id)).messages
      .findLast(message => message.role==='assistant' && message.committed)?.text,merged,'历史重读保持合并正文');
    // 浏览器刷新仍读同一持久合并正文。
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({viewport:{width:1440,height:1000}});
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(h.url);
      await page.getByLabel('演示登录凭据').fill(h.tokens.alice);
      await page.getByRole('button',{name:'进入工作台 →'}).click();
      await page.getByRole('navigation',{name:'会话历史'})
        .getByRole('button',{name:'五份跨旧门槛合并容量'}).click();
      const feed = page.locator('.conversation');
      await feed.getByText('戊'.repeat(40),{exact:false}).first().waitFor();
      const before = await feed.innerText();
      assert.ok(before.includes('戊'.repeat(40)) && before.includes('甲'.repeat(40)),
        '工作台完整渲染合并正文首末段');
      await page.reload();
      await feed.getByText('戊'.repeat(40),{exact:false}).first().waitFor();
      const after = await feed.innerText();
      assert.ok(after.includes('戊'.repeat(40)) && after.includes('甲'.repeat(40)),'刷新后仍读同一持久正文');
      assert.deepEqual(errors,[]);
      checks.push('R02：五份7998字符（中文/非BMP）合并跨旧32000字符/65535字节，旧冻结项中断恢复后事件/历史/浏览器刷新一致');
    } finally {
      await browser.close();
    }
    retire();
  }

  // R02补验收②：最多24项合法组合一次交付，输出/事件/历史合同与项数上限吻合。
  {
    const label = '二十四项合法合并容量';
    const taskC = await begin(label,2,false,true);
    const extras = [];
    for (let index = 4; index <= 24; index++) {
      const goal = '合成第' + index + '项目标';
      extras.push({task: await createTask(goal), goal});
    }
    const named = [
      {task: taskC, goal: '合成丙目标'},
      {task: taskB, goal: '合成乙目标'},
      ...extras,
    ];
    const goals = new Map([[taskA.task_id,'合成甲目标'],
      ...named.map(({task,goal}) => [task.task_id,goal])]);
    const bodyFor = task => goals.get(task.task_id) + '已核对🌿。';
    const order = [...named].reverse().map(({task}) => task);
    const lastFrozen = await freezeChain(order, taskA, bodyFor);
    assert.equal(lastFrozen.answer_parts.length,23);
    const finalBody = bodyFor(taskA);
    const completion = await finalInput(finalBody, lastFrozen.answer_parts, taskA);
    assert.equal(ok(await h.internal('/internal/finish',completion)).output_id,run.output_id);
    const merged = [...order, taskA].map(task =>
      '## ' + goals.get(task.task_id) + '\n\n' + bodyFor(task)).join('\n\n---\n\n');
    const manyState = await observe();
    assert.equal(manyState.output.parts.length,24,'正好24项合法引用一次交付');
    assert.deepEqual(manyState.output.parts,completion.answer_parts);
    assert.equal(manyState.output.text,merged);
    assert.equal(manyState.commits.length,1);
    assert.equal(manyState.commits[0].payload.text,merged);
    assert.equal(manyState.tasks.length,24);
    assert.deepEqual(manyState.tasks.map(task => task.phase),Array.from({length:24},() => 'answered'));
    assert.deepEqual(manyState.budget,{message_id:run.message_id,calls:0,limit:24});
    const manySnapshot = await h.snapshot(run.conversation_id);
    assert.equal(manySnapshot.messages.findLast(message => message.role==='assistant' && message.committed)?.text,merged);
    checks.push('R02：24项（23冻结+新末项）合法合并一次交付，输出/事件/历史合同一致'); retire();
  }

  await begin('真实Pi输出写入拒绝');
  run.checkpoint = checkpoint();
  run.workspace_context.active_task_ref = {task_id:taskA.task_id,condition_version:taskA.condition_version};
  faultSdk = randomUUID(); faultCalls = 0;
  const beforeWrite = await observe(), transportRequests = [], writes = [];
  const originalPost = RustTransport.prototype.post;
  RustTransport.prototype.post = async function(path, name, input, ...rest) {
    if (input.run_id !== run.run_id) return originalPost.call(this,path,name,input,...rest);
    transportRequests.push({path,sdk:input.sdk_tool_call_id ?? null});
    if (path !== '/internal/outputs') return originalPost.call(this,path,name,input,...rest);
    assert.equal(writes.length,0,'原输出队列失败后不能补写或跳过拒绝');
    assert.equal(input.chunk_seq,'1');
    const changed = {...input,chunk_seq:'2'}, write = {original:input,forwarded:changed};
    writes.push(write);
    // 只改真实请求的序号；RustTransport仍发送HTTP、解码Rust拒绝并原样抛出。
    try {return await originalPost.call(this,path,name,changed,...rest);}
    catch (error) {write.error = error.message;throw error;}
  };
  let writeFailure;
  try {await deliver(run,h.env.DATA_AGENT_API_URL,h.env.DATA_AGENT_INTERNAL_TOKEN,'');}
  catch (error) {writeFailure = error;}
  finally {RustTransport.prototype.post = originalPost;}
  if (providerFailure) throw providerFailure;
  assert.equal(writeFailure?.message,'chunk_gap','必须由真实Rust输出边界拒绝，经output.drain传回');
  assert.equal(writes.length,1); assert.equal(writes[0].error,'chunk_gap');
  assert.equal(writes[0].forwarded.text,firstAnswer); assert.equal(writes[0].forwarded.chunk_seq,'2');
  const afterWrite = await observe();
  observations.push({label:'真实输出写入拒绝阻止route/finish',stage:'output',error:writeFailure.message,
    requests:transportRequests,writes,before:beforeWrite,after:afterWrite});
  assert.deepEqual(afterWrite,{...beforeWrite,budget:{...beforeWrite.budget,calls}},
    '只有实际本地模型调用可计费，写入拒绝不能冻结/切任务/提交正文');
  assert.deepEqual(ledger({sdk_tool_call_id:faultSdk}),[]);
  assert.ok(transportRequests.every(request => !['/internal/data/tool-calls','/internal/data/tools','/internal/finish'].includes(request.path)),
    'output.drain失败前不能登记或执行route，也不能finish');
  assert.equal(faultCalls,2); assert.equal(calls,2);
  assert.equal(h.sql(`SELECT JSON_OBJECT('n',COUNT(*)) FROM model_call_attempts
    WHERE run_id='${run.run_id}' AND state<>'settled'`)[0].n,0,'真实本地调用仍沿原预算结算');
  checks.push('真实deliver首chunk序号跳跃由Rust拒绝，无route登记/冻结/切任务/finish');
  faultSdk = undefined; retire();

  // 步骤5要求不能静默删掉已完成part；旧单任务省略字段的合法性已在前面单独核验。
  await begin('已冻结A后finish遗漏answer_parts');
  await freezeFirst(); const omitted = await finalInput(secondAnswer);
  assert.equal(omitted.answer_parts,undefined);
  await rejectFinish('已冻结A后省略answer_parts明确拒绝，不能仅提交B',omitted); retire();

  assert.equal(h.sql("SELECT JSON_OBJECT('n',COUNT(*)) FROM model_call_attempts")[0].n,calls);
  passed = true;
} catch (error) {
  failure = error.message; throw error;
} finally {
  const report = {passed,checks,observations,failure,calls,officialRequests:0,
    limitations:['真实Rust HTTP/隔离合成MySQL与写失败的真实Pi/本地协议，不验证模型选择定稿时机；查询A→自然B由主线覆盖。']};
  try {
    if (h) {
      try {await writeFile('.local/checks/task-answer-boundaries.json',JSON.stringify(report,null,2)+'\n');}
      finally {if (run) h.releaseRun(run.run_id);await h.close();}
    }
  } finally {
    for (const [key,value] of previousProvider) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    if (provider?.listening) {provider.closeAllConnections();await new Promise(resolve => provider.close(resolve));}
  }
  console.log(JSON.stringify(report));
}

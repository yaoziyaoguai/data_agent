import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash, randomUUID} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {deliver} from '../../apps/agent/session/deliver.ts';
import {exportCheckpoint, restoreCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {RustTransport} from '../../apps/agent/transport/client.ts';
import {validateContract} from '../../packages/contracts/validate.ts';
import {harness, until} from './harness.mjs';

const collection = 'data_agent_test_' + randomUUID().replaceAll('-', '');
const vectorToken = (await readFile('.local/infra/milvus-root-password', 'utf8')).trim();
const body = '合成容量🧪。'.repeat(12000);
const invocations = [], received = [], errors = [], checks = [];
let h, source, run, calls = 0, originalCalls = 0, prepared = false, passed = false;
let narrowedRequests = 0;
let recovering = false, loseResult = false;
let interruptedDelivery, combined;
const combinations = [];
const originalPost = RustTransport.prototype.post;
const originalFetch = globalThis.fetch;
const originalAppendCompaction = SessionManager.prototype.appendCompaction;
SessionManager.prototype.appendCompaction = function(...args) {
  const entryId = originalAppendCompaction.apply(this, args);
  if (combined) combined.compactions.push({entryId, summary: args[0], firstKeptEntryId: args[1], sessionId: this.getSessionId()});
  return entryId;
};
RustTransport.prototype.post = async function(path, name, input, ...rest) {
  const result = await originalPost.call(this, path, name, input, ...rest);
  if (loseResult && path === '/internal/data/tools' && input.sdk_tool_call_id === 'recovery-source') {
    loseResult = false;
    interruptedDelivery.abort();
    throw new Error('synthetic_result_lost_after_commit');
  }
  if (combined && path.startsWith('/internal/model/'))
    combined.modelPosts.push({path, runId: input.run_id, attemptId: input.call_attempt_id, state: result.state});
  if (combined && path === '/internal/data/tools') {
    if (input.sdk_tool_call_id === combined.firstId) {
      if (combined.phase === 'initial') {
        combined.frozen = structuredClone(result);
        combined.phase = 'interrupted';
        interruptedDelivery.abort();
        throw new Error('synthetic_result_lost_after_commit');
      }
      if (combined.phase === 'recovering') combined.replayed.push(structuredClone(result));
    }
    if (input.sdk_tool_call_id === combined.capacityId) combined.capacityReceipts.push(structuredClone(result));
  }
  if (combined && path === '/internal/data/tool-rejections' && input.sdk_tool_call_id === combined.capacityId)
    combined.capacityReceipts.push(structuredClone(result));
  return result;
};
// 只观察本地工具信封的容量提示；不记录HTTP头、凭据或模型原提示。
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if ((url.endsWith('/internal/data/tools') || url.endsWith('/internal/data/tool-calls')) && typeof init?.body === 'string') {
    const value = JSON.parse(init.body);
    const execution = url.endsWith('/internal/data/tools');
    const shrink = execution && ((recovering && value.sdk_tool_call_id === 'recovery-source') ||
      (combined?.phase === 'recovering' && [combined.firstId, combined.capacityId].includes(value.sdk_tool_call_id)));
    if (shrink) {
      assert.ok(value.response_budget, '原tool v2登记后才在实际执行入口裁小已有hint');
      assert.match(value.response_budget.projection_fingerprint, /^[0-9a-f]{64}$/);
      const originalBudget = {...value.response_budget};
      value.response_budget = {...originalBudget, max_bytes: 1, estimated_tokens: 1};
      validateContract('DataToolInvocation', value);
      if (combined?.phase === 'recovering') combined.hints.push({sdkId: value.sdk_tool_call_id,
        runId: value.run_id, before: originalBudget, after: value.response_budget});
      init = {...init, body: JSON.stringify(value)};
    }
    if (combined && !execution && [combined.firstId, combined.capacityId].includes(value.sdk_tool_call_id))
      assert.equal(Object.hasOwn(value, 'response_budget'), false, '登记不得凭当前run伪造容量提示');
    if (execution) invocations.push(value);
  }
  return originalFetch(input, init);
};
const provider = createServer(async (request, response) => {
  try {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    calls++;
    // §6.1：来源未裁决（投影注入宿主事实标记）的首请求只保留归属/目录/取消等控制工具，
    // Rust来源门必拒的纯受限工具同样收窄；route成功回执确认范围后，后续请求恢复正文读取工具。
    if (input.tools?.length) {
      const narrowed = input.messages.some(message =>
        typeof message.content === 'string' ? message.content.includes('来源尚未确定')
          : Array.isArray(message.content) && message.content.some(part => part.type === 'text' && part.text.includes('来源尚未确定')));
      if (narrowed) {
        narrowedRequests++;
        const visible = input.tools.map(tool => tool.function.name);
        for (const name of ['read', 'read_knowledge', 'read_source', 'request_query', 'execute_query', 'get_query',
          'prepare_analysis_answer', 'present_analysis_answer', 'save_analysis_evidence', 'save_analysis_report',
          'read_analysis_report', 'read_analysis_task', 'validate_sql', 'prepare_skill_draft', 'propose_semantic_change'])
          assert.ok(!visible.includes(name), '来源未裁决时不得可见正文读取或执行工具：' + name);
        for (const name of ['update_analysis_task', 'read_conversation', 'search_knowledge',
          'cancel_query', 'manage_personal_asset'])
          assert.ok(visible.includes(name), '来源未裁决时任务目录/取消等合法工具必须可见：' + name);
      }
    }
    if (combined) {
      const summary = !input.tools?.length;
      const event = {kind: summary ? 'summary' : 'normal', phase: combined.phase,
        requestBytes: Buffer.byteLength(raw), payloadHash: createHash('sha256').update(raw).digest('hex')};
      combined.requests.push(event);
      assert.equal(request.url, '/chat/completions');
      assert.ok(event.requestBytes <= run.model_profile.payload_bytes_limit);
      let delta;
      if (combined.phase === 'initial') {
        assert.equal(summary, false, '合成短历史尚未触及容量门槛，首次应为普通工具请求');
        if (combined.requests.length === 1) {
          // §6.1：首请求收窄，先正式归属本轮输入；读取在范围确认后的下一请求。
          delta = {role: 'assistant', tool_calls: [
            {index: 0, id: combined.routeId, type: 'function', function: {name: 'update_analysis_task', arguments: JSON.stringify({action: 'route', task_id: null, expected_version: null, goal: '', question: null, options: []})}},
          ]};
        } else {
          const citation = {source: {kind: 'document', id: source.id}, revision: source.version,
            locator: {offset: 0, length: [...body].length}};
          delta = {role: 'assistant', tool_calls: [
            ...[combined.firstId, combined.capacityId].map((id, index) => ({index, id, type: 'function',
              function: {name: 'read_source', arguments: JSON.stringify({citation, limit: 65536})}})),
          ]};
        }
      } else {
        assert.equal(combined.phase, 'recovering');
        assert.equal(combined.replayed.length, 1, '先接回原成功回执，再进入同次恢复的模型边界');
        assert.deepEqual(combined.replayed[0], combined.frozen, '摘要与续答之前原大回执已经无损接回');
        assert.ok(combined.capacityReceipts.some(receipt => receipt.data.error === 'tool_response_capacity'),
          '剩余补读必须由真实Rust容量拒绝触发，不能合成toolResult标记');
        if (summary) {
          assert.equal(combined.requests.some(value => value.phase === 'recovering' && value.kind === 'normal'), false,
            '较小余量恢复必须先走原生summary，不能先发送普通续答');
          if (combined.failSummary) {
            event.status = 503;
            response.writeHead(503, {'content-type': 'application/json'}).end(JSON.stringify({error: {
              message: 'synthetic_capacity_recovery_summary_failed', type: 'server_error'}}));
            return;
          }
          delta = {role: 'assistant', content: combined.summaryText};
        } else {
          const recovery = combined.requests.filter(value => value.phase === 'recovering');
          assert.ok(recovery.slice(0, -1).some(value => value.kind === 'summary' && value.status === 200),
            '同一次真实Worker恢复的summary成功后才可发普通续答');
          assert.ok(combined.compactions.length > 0, '真实Pi须已追加原生compaction条目');
          assert.equal(recovery.filter(value => value.kind === 'normal').length, 1, '不增加模型循环或重做工具');
          const messages = input.messages.filter(message => message.role === 'tool');
          const frozen = messages.find(message => message.tool_call_id === combined.firstId);
          assert.ok(frozen, '冻结大回执必须保留在压缩后的实际provider输入中');
          assert.deepEqual(JSON.parse(frozen.content), combined.frozen.data, '压缩续答不重剪首次成功正文和游标');
          const capacity = messages.find(message => message.tool_call_id === combined.capacityId);
          assert.ok(capacity);
          assert.equal(JSON.parse(capacity.content).error, 'tool_response_capacity');
          assert.ok(input.messages.some(message => JSON.stringify(message.content).includes(combined.summaryText)),
            '原生summary确实进入同一次普通续答');
          delta = {role: 'assistant', content: '已沿原会话接回冻结正文，容量不足部分保留补读位置。'};
        }
      }
      event.status = 200;
      response.writeHead(200, {'content-type': 'text/event-stream'});
      response.write('data: ' + JSON.stringify({id: 'capacity-recovery', choices: [{index: 0, delta,
        finish_reason: delta.tool_calls ? 'tool_calls' : 'stop'}]}) + '\n\n');
      response.write('data: ' + JSON.stringify({choices: [], usage: {prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100}}) + '\n\n');
      response.end('data: [DONE]\n\n');
      return;
    }
    let delta;
    if (calls === 1) {
      // §6.1：来源未裁决首请求先route；收窄集合中读取工具不可见。
      delta = {role: 'assistant', tool_calls: [
        {index: 0, id: 'budget-route', type: 'function', function: {name: 'update_analysis_task', arguments: JSON.stringify({action: 'route', task_id: null, expected_version: null, goal: '', question: null, options: []})}},
      ]};
    } else if (calls === 2) {
      const tool = input.tools.find(tool => tool.function?.name === 'read_source');
      assert.ok(tool, '范围确认后读取工具必须恢复可见');
      assert.equal(Object.hasOwn(tool.function.parameters.properties, 'response_budget'), false, '容量由宿主生成，不交给模型填写');
      const citation = {source: {kind: 'document', id: source.id}, revision: source.version, locator: {offset: 0, length: [...body].length}};
      delta = {role: 'assistant', tool_calls: [0, 1].map((index) => ({index, id: 'budget-source-' + index, type: 'function', function: {name: 'read_source', arguments: JSON.stringify({citation, limit: 65536})}}))};
    } else if (calls === 4) {
      // 恢复场景同样先route收窄首请求，读取随后一请求发出。
      delta = {role: 'assistant', tool_calls: [
        {index: 0, id: 'recovery-route', type: 'function', function: {name: 'update_analysis_task', arguments: JSON.stringify({action: 'route', task_id: null, expected_version: null, goal: '', question: null, options: []})}},
      ]};
    } else if (calls === 5) {
      const citation = {source: {kind: 'document', id: source.id}, revision: source.version, locator: {offset: 0, length: [...body].length}};
      delta = {role: 'assistant', tool_calls: [
        {index: 0, id: 'recovery-source', type: 'function', function: {name: 'read_source', arguments: JSON.stringify({citation, limit: 65536})}},
      ]};
    } else if (calls === 6) {
      const message = input.messages.find(message => message.role === 'tool' && message.tool_call_id === 'recovery-source');
      assert.ok(message, '半轮恢复接回已提交而SDK丢失的toolResult');
      const saved = h.sql(`SELECT receipt FROM tool_calls WHERE conversation_id='${run.conversation_id}' AND sdk_tool_call_id='recovery-source'`)[0];
      assert.deepEqual(JSON.parse(message.content), saved.data, '真实新run即使余量变小也无损交付原成功正文和游标');
      delta = {role: 'assistant', content: '已接回原合成正文及续读位置。'};
    } else {
      assert.equal(calls, 3, '归属、两项补读与一次续答，不因预算重复分配触发额外摘要');
      const reads = invocations.filter(value => value.tool_name === 'read_source');
      assert.equal(reads.length, 2);
      for (const invocation of reads) {
        assert.ok(invocation.response_budget, '实际Pi同批调用必须携带宿主response_budget');
        assert.match(invocation.response_budget.projection_fingerprint, /^[0-9a-f]{64}$/);
      }
      assert.equal(reads[0].response_budget.projection_fingerprint, reads[1].response_budget.projection_fingerprint, '同一工具组复用同一派发基准');
      assert.ok(reads.reduce((sum, value) => sum + value.response_budget.max_bytes, 0) < 131072, '同批工具共享剩余字节，不各取整个请求容量');
      for (let index = 0; index < 2; index++) {
        const sdkId = 'budget-source-' + index;
        const message = input.messages.find(message => message.role === 'tool' && message.tool_call_id === sdkId);
        assert.ok(message);
        const result = JSON.parse(message.content);
        validateContract('SourceReadReply', result);
        assert.equal(result.content_state, 'partial');
        assert.ok(result.text.length > 0);
        assert.equal(result.text, [...body].slice(0, result.locator.length).join(''));
        assert.deepEqual(result.next_locator, {offset: result.locator.length, length: [...body].length - result.locator.length});
        const bytes = Buffer.byteLength(JSON.stringify(result));
        assert.ok(bytes <= reads[index].response_budget.max_bytes, 'Rust最终JSON不得超过该项分配');
        assert.ok(Math.ceil(JSON.stringify(result).length / 4) <= reads[index].response_budget.estimated_tokens);
        const saved = h.sql(`SELECT receipt FROM tool_calls WHERE conversation_id='${run.conversation_id}' AND recovery_chain_id='${run.recovery_chain_id}' AND sdk_tool_call_id='${sdkId}'`)[0];
        assert.deepEqual(saved.data, result, 'Pi/provider无损接回Rust最终正文和游标');
        received.push(result);
      }
      checks.push('真实Pi投影与同批共享容量', 'Rust在预算内分页并保存最终回执', 'provider等原正文及游标');
      const invocation = reads[0];
      const saved = h.sql(`SELECT receipt FROM tool_calls WHERE conversation_id='${run.conversation_id}' AND recovery_chain_id='${run.recovery_chain_id}' AND sdk_tool_call_id='budget-source-0'`)[0];
      const smaller = {...invocation, response_budget: {...invocation.response_budget, max_bytes: 1, estimated_tokens: 1}};
      const registered = ok(await h.internal('/internal/data/tool-calls', smaller));
      assert.equal(registered.operation_id, saved.operation_id);
      const replayed = ok(await h.internal('/internal/data/tools', smaller));
      assert.equal(replayed.operation_id, saved.operation_id);
      assert.deepEqual(replayed.data, received[0], '恢复余量更小仍返回原首次成功正文和游标，容量不改变业务身份');
      checks.push('较小恢复预算不重剪或更换原operation');
      delta = {role: 'assistant', content: '已取得两项合成来源的有界正文及原范围续读位置。'};
    }
    response.writeHead(200, {'content-type': 'text/event-stream'});
    response.write('data: ' + JSON.stringify({id: 'response-budget', choices: [{index: 0, delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop'}]}) + '\n\n');
    response.write('data: ' + JSON.stringify({choices: [], usage: {prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100}}) + '\n\n');
    response.end('data: [DONE]\n\n');
  } catch (error) {
    errors.push(error.message);
    response.writeHead(400, {'content-type': 'application/json'}).end(JSON.stringify({error: {message: 'synthetic_response_budget_assertion_failed', type: 'invalid_request_error'}}));
  }
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const previousTest = process.env.DATA_AGENT_PROVIDER_TEST;
process.env.DATA_AGENT_PROVIDER_TEST = '1';
const ok = response => {assert.equal(response.status, 200, JSON.stringify(response.value)); return response.value;};
async function capacityRecovery(failSummary) {
  const name = failSummary ? 'summary-failed' : 'summary-succeeded';
  combined = {name, phase: 'initial', failSummary, routeId: name + '-route', firstId: name + '-frozen-source',
    capacityId: name + '-capacity-source', summaryText: '合成容量恢复摘要：早期背景已压缩，原任务和已完成读取身份保持。',
    requests: [], modelPosts: [], compactions: [], hints: [], replayed: [], capacityReceipts: []};
  const state = combined;
  try {
    await h.resumeWorker();
    run = await h.capture(await h.create(), '接回原已提交来源，再处理同批剩余补读；空间不足沿原会话整理。');
    await h.pauseWorker();
    const manager = restoreCheckpoint('/synthetic/data-agent', run.checkpoint);
    const usage = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}};
    // 早期合成背景供Pi压缩；§6.1顺序后route单独成轮。初始阶段须给首次读取留出真实预算
    // （冻结回执>4096B）；恢复阶段由真实Rust容量拒绝（缩小hint→tool_response_capacity）
    // 在请求边界触发Pi原生溢出压缩，不依赖分支本身字节越限。
    for (let index = 0; index < 7; index++) {
      manager.appendMessage({role: 'user', content: 'earlier synthetic background ' + index + ': ' + 'synthetic capacity background '.repeat(120), timestamp: Date.now()});
      manager.appendMessage({role: 'assistant', content: [{type: 'text', text: '已记录合成背景。'}],
        api: 'openai-completions', provider: 'controlled_deepseek', model: 'deepseek-flash', usage,
        stopReason: 'stop', timestamp: Date.now()});
    }
    const sessionId = manager.getSessionId();
    run = {...run, checkpoint: exportCheckpoint(manager,
      run.workspace_context.authority_revision, run.workspace_context.authority_snapshot)};
    interruptedDelivery = new AbortController();
    await assert.rejects(deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, '', interruptedDelivery.signal), /run_cancelled|model_run_failed/);
    assert.deepEqual(errors, [], '本地provider前提失败不能当作容量恢复RED');
    assert.deepEqual(state.requests.map(value => value.kind), ['normal', 'normal'], '原生abort在首次业务提交后结束本轮');
    assert.equal(state.compactions.length, 0, '本组合的压缩必须发生在真实Worker恢复之后');
    assert.ok(state.frozen);
    validateContract('SourceReadReply', state.frozen.data);
    const frozenBytes = Buffer.byteLength(JSON.stringify(state.frozen.data));
    assert.ok(frozenBytes > 4096, '先真实冻结大回执，不能用最小身份假装大正文');
    assert.equal(state.frozen.data.content_state, 'partial');
    assert.ok(state.frozen.data.next_locator);
    const prior = run;
    const ledger = () => h.sql(`SELECT JSON_OBJECT('sdk',sdk_tool_call_id,'operation',operation_id,'origin',origin_run_id,'fingerprint',arguments_fingerprint,'state',state,'receipt',receipt) FROM tool_calls WHERE conversation_id='${prior.conversation_id}' ORDER BY sdk_tool_call_id`);
    const before = ledger();
    const routingEvents = () => h.sql(`SELECT JSON_OBJECT('id',event_id,'payload',payload) FROM conversation_events WHERE conversation_id='${prior.conversation_id}' AND event_type='task_changed' ORDER BY event_seq`);
    const routed = routingEvents();
    assert.equal(routed.length, 1, '原归属只产生一次业务事件');
    assert.equal(before.find(value => value.sdk === state.firstId).state, 'succeeded');
    assert.equal(before.some(value => value.sdk === state.capacityId), false, '同批第二项尚未登记，恢复才首次执行');
    assert.equal(before.length, 2, 'route和第一项读取各一次');
    const stored = h.sql(`SELECT checkpoint FROM pi_checkpoints WHERE recovery_chain_id='${prior.recovery_chain_id}'`)[0];
    const interrupted = restoreCheckpoint('/synthetic/data-agent', stored);
    assert.equal(interrupted.getSessionId(), sessionId);
    assert.equal(interrupted.buildSessionContext().messages.some(message => message.role === 'toolResult' && message.toolCallId === state.firstId), false);
    const captureCount = h.captured.length;
    h.releaseRun(prior.run_id);
    // 只重排隔离库中的原作业；新run/租约及冻结配置仍由真实Worker生成。
    h.sql(`UPDATE agent_runs SET state='interrupted' WHERE id='${prior.run_id}';UPDATE conversations SET lease_owner=NULL,lease_until=NULL WHERE id='${prior.conversation_id}';UPDATE background_jobs SET state='queued',lease_owner=NULL,lease_until=NULL WHERE message_id='${prior.message_id}';`);
    await h.resumeWorker();
    run = await until(() => h.captured.slice(captureCount).find(value => value.message_id === prior.message_id), 'Worker接回组合容量输入 ' + name);
    await h.pauseWorker();
    assert.equal(run.resume_same_input, true);
    assert.notEqual(run.run_id, prior.run_id);
    assert.notEqual(run.lease_epoch, prior.lease_epoch);
    for (const key of ['conversation_id', 'recovery_chain_id', 'budget_scope_id', 'output_id', 'message_id']) assert.equal(run[key], prior[key]);
    assert.deepEqual(run.model_profile, prior.model_profile, '恢复不能改模型profile、每消息24次或试验预算');
    state.phase = 'recovering';
    let failure;
    try {await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, '');}
    catch (error) {failure = error;}
    assert.deepEqual(errors, [], '真实provider的组合断言必须完整执行');
    if (failSummary) {
      assert.ok(failure, '真实摘要503须保持失败，不能冒充续答完成');
      assert.ok(failure.checkpoint, '失败出口应保可严格恢复的原会话引用');
      const failedManager = restoreCheckpoint('/synthetic/data-agent', failure.checkpoint);
      assert.equal(failedManager.getSessionId(), sessionId);
      const messages = failedManager.buildSessionContext().messages;
      const capacity = messages.find(message => message.role === 'toolResult' && message.toolCallId === state.capacityId);
      assert.ok(capacity?.isError, '摘要失败后原容量标记保持可见');
      assert.equal(JSON.parse(capacity.content[0].text).error, 'tool_response_capacity');
      const frozen = messages.find(message => message.role === 'toolResult' && message.toolCallId === state.firstId);
      assert.deepEqual(JSON.parse(frozen.content[0].text), state.frozen.data);
      assert.equal(state.compactions.length, 0, '失败摘要不能追加成功compaction或清掉容量状态');
      assert.equal(state.requests.filter(value => value.phase === 'recovering' && value.kind === 'normal').length, 0,
        '摘要失败不发普通请求');
      assert.equal(state.requests.filter(value => value.kind === 'summary').length, 3, '首次摘要加两次Pi重试，连续三次临时失败停止');
      assert.equal((await h.snapshot(run.conversation_id)).runs.some(value => value.state === 'finished'), false);
    } else {
      if (failure) throw failure;
      const saved = h.sql(`SELECT checkpoint FROM pi_checkpoints WHERE recovery_chain_id='${run.recovery_chain_id}'`)[0];
      const restored = restoreCheckpoint('/synthetic/data-agent', saved);
      assert.equal(restored.getSessionId(), sessionId);
      assert.ok(restored.getBranch().some(entry => entry.type === 'compaction' && entry.summary.includes(state.summaryText)),
        '同次恢复必须正式保存Pi原生compaction引用');
      const messages = restored.buildSessionContext().messages;
      const frozen = messages.find(message => message.role === 'toolResult' && message.toolCallId === state.firstId);
      assert.ok(frozen, '已冻结正文保留在原生compaction后的可见工具组');
      assert.deepEqual(JSON.parse(frozen.content[0].text), state.frozen.data);
      const finished = (await h.snapshot(run.conversation_id)).runs.filter(value => value.state === 'finished');
      assert.equal(finished.length, 1);
      assert.equal(finished[0].run_id, run.run_id);
      assert.ok(state.requests.some(value => value.phase === 'recovering' && value.kind === 'summary'));
      assert.equal(state.requests.filter(value => value.phase === 'recovering' && value.kind === 'normal').length, 1);
    }
    assert.equal(state.replayed.length, 1);
    assert.deepEqual(state.replayed[0], state.frozen, '较小hint接回原大正文、分页与原operation');
    assert.equal(state.hints.length, 2);
    for (const hint of state.hints) {
      assert.equal(hint.runId, run.run_id);
      assert.equal(hint.after.max_bytes, 1);
      assert.equal(hint.after.estimated_tokens, 1);
      assert.equal(hint.after.projection_fingerprint, hint.before.projection_fingerprint);
    }
    const firstHint = invocations.find(value => value.run_id === prior.run_id && value.sdk_tool_call_id === state.firstId).response_budget;
    assert.ok(firstHint.max_bytes > 1 && firstHint.estimated_tokens > 1);
    assert.ok(frozenBytes > state.hints[0].after.max_bytes);
    const after = ledger();
    assert.deepEqual(after.filter(value => before.some(old => old.operation === value.operation)), before,
      '原route和成功读取账本不改身份、指纹、origin或首次回执');
    assert.deepEqual(routingEvents(), routed, '跨run恢复、压缩与续答不重复原归属副作用');
    assert.ok(state.compactions.every(value => value.sessionId === sessionId));
    assert.equal(after.length, 3, '只允许原同批剩余项新增一次明确拒绝，不重复业务调用');
    assert.equal(after.find(value => value.sdk === state.capacityId).state, 'rejected');
    assert.equal(after.find(value => value.sdk === state.capacityId).receipt.data.error, 'tool_response_capacity');
    const reads = invocations.filter(value => value.sdk_tool_call_id === state.firstId);
    assert.equal(reads.length, 2, '首次执行一次，跨run仅回放一次');
    assert.equal(invocations.filter(value => value.sdk_tool_call_id === state.capacityId).length, 1);
    const scope = h.sql(`SELECT JSON_OBJECT('calls',issued_calls,'limit',call_limit,'failures',model_failure_streak) FROM budget_scopes WHERE id='${prior.budget_scope_id}'`)[0];
    assert.equal(scope.limit, 24);
    assert.equal(scope.calls, state.requests.length, '初次、summary、重试与续答都计原budget_scope');
    assert.ok(scope.calls <= 24);
    assert.equal(scope.failures, failSummary ? 3 : 0);
    assert.equal(state.modelPosts.filter(value => value.path === '/internal/model/send').length, state.requests.length,
      '被容量挡下的普通请求不能领取模型发送许可');
    assert.ok(state.modelPosts.every(value => [prior.run_id, run.run_id].includes(value.runId)));
    state.evidence = {priorRun: prior.run_id, recoveredRun: run.run_id, sessionId, operation: state.frozen.operation_id,
      recoveryChain: run.recovery_chain_id, budgetScope: run.budget_scope_id, outputId: run.output_id, frozenBytes,
      frozenHash: createHash('sha256').update(JSON.stringify(state.frozen)).digest('hex'), scope,
      failure: failure ? {message: failure.message, code: failure.code} : null};
    checks.push(failSummary ? '同次跨run恢复摘要503连续三次停止；无普通续答、原容量标记和冻结正文保持'
      : '同次真实Worker跨run恢复接回大回执与极小余量；Pi原生summary先于普通续答、原身份及副作用不变');
    if (failSummary) ok(await h.request(`/conversations/${run.conversation_id}/messages/${run.message_id}/withdraw`, {operation_id: randomUUID()}));
    h.releaseRun(run.run_id);
  } finally {
    const {frozen, replayed, capacityReceipts, ...evidence} = state;
    combinations.push({...evidence, frozenOperation: frozen?.operation_id, replayed: replayed.length,
      capacityErrors: capacityReceipts.map(receipt => receipt.data.error), calls: state.requests.length,
      summaryCalls: state.requests.filter(value => value.kind === 'summary').length,
      continuationCalls: state.requests.filter(value => value.phase === 'recovering' && value.kind === 'normal').length});
    combined = undefined;
  }
}
try {
  const profile = {provider_id: 'deepseek', model_id: 'deepseek-flash', trial_id: randomUUID(), price_version: '2026-10-04-peak-usd', context_window: 131072, input_limit: 65536, output_limit: 8192, trial_call_limit: 24, trial_cost_micros: '300000', request_call_limit: 24, toolset: 'data', payload_bytes_limit: 131072, thinking_level: 'off'};
  h = await harness({capture: true, startWorker: false, profile, protocolProviderUrl: 'http://127.0.0.1:' + provider.address().port,
    env: {DATA_AGENT_LEASE_MS: '120000', DATA_AGENT_TOOL_CONTRACT_VERSION: '2', DATA_AGENT_PREFILL_PROFILE: '',
      DATA_AGENT_VECTOR_URL: 'http://127.0.0.1:19531', DATA_AGENT_VECTOR_COLLECTION: collection,
      DATA_AGENT_VECTOR_TOKEN_FILE: process.cwd() + '/.local/infra/milvus-root-password'}});
  ok(await h.request('/knowledge-index/rebuilds', {operation_id: randomUUID()})); prepared = true;
  source = ok(await h.request('/knowledge', {operation_id: randomUUID(), kind: 'document', name: '合成共享容量来源', body, related_ids: []}));
  await h.resumeWorker(); run = await h.capture(await h.create(), '同时定点读取两份合成正文，保留各自原范围续读。');
  await h.pauseWorker();
  try {await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, '');}
  catch (error) {assert.deepEqual(errors, [], JSON.stringify(errors)); throw error;}
  assert.deepEqual(errors, []); assert.equal(calls, 3); assert.equal(received.length, 2);
  h.releaseRun(run.run_id);

  await h.resumeWorker();
  run = await h.capture(await h.create(), '读取合成容量来源，随后沿原输入恢复。');
  await h.pauseWorker();
  loseResult = true;
  interruptedDelivery = new AbortController();
  await assert.rejects(deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, '', interruptedDelivery.signal), /run_cancelled|model_run_failed/);
  assert.deepEqual(errors, []);
  assert.equal(calls, 5, '丢回执后停止本次派发');
  const prior = run;
  const identity = h.sql(`SELECT JSON_OBJECT('operation',operation_id,'origin',origin_run_id,'fingerprint',arguments_fingerprint,'state',state,'receipt',receipt) FROM tool_calls WHERE conversation_id='${prior.conversation_id}' AND sdk_tool_call_id='recovery-source'`)[0];
  assert.equal(identity.state, 'succeeded');
  const checkpoint = h.sql(`SELECT checkpoint FROM pi_checkpoints WHERE recovery_chain_id='${prior.recovery_chain_id}'`)[0];
  assert.equal(restoreCheckpoint('/synthetic/data-agent', checkpoint).buildSessionContext().messages.some(message => message.role === 'toolResult' && message.toolCallId === 'recovery-source'), false);
  const captureCount = h.captured.length;
  h.releaseRun(prior.run_id);
  h.sql(`UPDATE agent_runs SET state='interrupted' WHERE id='${prior.run_id}';UPDATE conversations SET lease_owner=NULL,lease_until=NULL WHERE id='${prior.conversation_id}';UPDATE background_jobs SET state='queued',lease_owner=NULL,lease_until=NULL WHERE message_id='${prior.message_id}';`);
  await h.resumeWorker();
  run = await until(() => h.captured.slice(captureCount).find(value => value.message_id === prior.message_id), 'Worker接续原容量输入');
  await h.pauseWorker();
  assert.equal(run.resume_same_input, true);
  assert.notEqual(run.run_id, prior.run_id);
  for (const key of ['recovery_chain_id', 'budget_scope_id', 'output_id', 'message_id']) assert.equal(run[key], prior[key]);
  recovering = true;
  try {await deliver(run, h.env.DATA_AGENT_API_URL, h.env.DATA_AGENT_INTERNAL_TOKEN, '');}
  catch (error) {assert.deepEqual(errors, [], JSON.stringify(errors)); throw error;}
  assert.deepEqual(h.sql(`SELECT JSON_OBJECT('operation',operation_id,'origin',origin_run_id,'fingerprint',arguments_fingerprint,'state',state,'receipt',receipt) FROM tool_calls WHERE conversation_id='${prior.conversation_id}' AND sdk_tool_call_id='recovery-source'`)[0], identity);
  const resumedInvocation = invocations.findLast(value => value.sdk_tool_call_id === 'recovery-source');
  assert.equal(resumedInvocation.run_id, run.run_id);
  assert.equal(resumedInvocation.response_budget.max_bytes, 1);
  assert.equal(calls, 6);
  checks.push('提交后丢toolResult，真实Worker新run沿原session/operation/budget恢复');
  h.releaseRun(run.run_id);
  originalCalls = calls;
  recovering = false;
  await capacityRecovery(false);
  await capacityRecovery(true);
  assert.equal(calls, originalCalls + combinations.reduce((sum, value) => sum + value.calls, 0));
  // 4e1f2a6移除v2来源就绪收窄门后，每轮完整工具集始终可见；宿主边界仍由Rust按当前范围核验。
  assert.equal(narrowedRequests, 0, '移除就绪工具收窄门后，新输入首请求保持完整工具集，实际 ' + narrowedRequests);
  passed = true;
  console.log(JSON.stringify({passed, checks, calls, originalCalls, narrowedRequests, combinations, officialRequests: 0}));
} finally {
  RustTransport.prototype.post = originalPost;
  globalThis.fetch = originalFetch;
  SessionManager.prototype.appendCompaction = originalAppendCompaction;
  if (previousTest === undefined) delete process.env.DATA_AGENT_PROVIDER_TEST; else process.env.DATA_AGENT_PROVIDER_TEST = previousTest;
  if (h) {await writeFile(h.directory + '/evidence-response-budget.json', JSON.stringify({passed, errors, checks, calls, originalCalls, narrowedRequests, combinations, officialRequests: 0}, null, 2)); await h.close();}
  if (prepared) {
    const dropped = await fetch('http://127.0.0.1:19531/v2/vectordb/collections/drop', {method: 'POST', headers: {'content-type': 'application/json', authorization: 'Bearer root:' + vectorToken}, body: JSON.stringify({dbName: 'default', collectionName: collection})});
    assert.equal((await dropped.json()).code, 0);
  }
  provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
}

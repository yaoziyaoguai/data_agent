import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { dataTools, assistantOutputBinding } from "../../apps/agent/tools/data-tools.ts";
import { outputStream } from "../../apps/agent/session/output-stream.ts";
import { exportCheckpoint } from "../../apps/agent/session/checkpoint.ts";
import { deliver } from "../../apps/agent/session/deliver.ts";
import { renderedStream } from "../../apps/agent/session/render.ts";
import { decodeContract } from "../../packages/contracts/validate.ts";

// 调用正式工具封装，仅替换Rust传输边界；失败后旧答案不能继续充当本轮交付。
const checks = [];
let networkAttempts = 0;
let localOrigin;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (localOrigin && url.origin === localOrigin) return originalFetch(input, init);
  networkAttempts++;
  throw new Error("network forbidden in answer state check");
};
const input = {
  template: "净收入{{amount}}分。",
  sources: [{ query_id: "query", result_ref: "result", columns: ["amount"] }],
  values: [{ name: "amount", kind: "cell", query_id: "query", column: "amount", row_index: 0 }],
};
// v2候选输入：prepare不带template，数值经回执bindings进入下一条正文的{{name}}渲染。
const prepareInput = { sources: input.sources, values: input.values };
function fixture() {
  let mode = "success";
  let text = "净收入41分。";
  const transport = {
    run: { run_id: "run", lease_epoch: "1", workspace_context: { active_task_ref: taskA } },
    binding: () => ({ run_id: "run", lease_epoch: "1" }),
    async post(path, _schema, invocation) {
      const operation = "operation-" + invocation.sdk_tool_call_id;
      if (path === "/internal/data/tool-calls") return decodeContract("OperationReceipt", { operation_id: operation });
      if (mode === "transport_failure") throw new Error("unavailable");
      assert.equal(path, "/internal/data/tools");
      let data;
      if (mode === "result_expired") {
        data = { error: "result_expired", outcome: "rejected" };
      } else if (mode === "result_available") {
        data = {
          query: { id: invocation.arguments.query_id, execution_state: "succeeded" },
          results: { query_id: invocation.arguments.query_id, result_ref: "result", columns: [{ name: "amount", type: "integer", encoding: "decimal_string" }], rows: [["41"]] },
        };
      } else if (mode === "rejection") {
        data = { error: "invalid_evidence", outcome: "rejected" };
      } else if (invocation.tool_name === "present_analysis_answer") {
        data = { answer_text: text, sources: [{ query_id: "query", result_ref: "result", ...taskA }], result_dependencies: [] };
      } else {
        data = { query: { id: "query", execution_state: "succeeded" }, results: null };
      }
      return decodeContract("DataToolOutcome", { operation_id: operation, tool_name: invocation.tool_name, data,
        ...(!data.error && invocation.tool_name === "present_analysis_answer" ? {answer_task_ref: taskA} : {}) });
    },
  };
  const state = dataTools(transport, SessionManager.inMemory("/synthetic/answer-state"), "");
  const execute = (name, sdk, args) => state.tools.find(tool => tool.name === name).execute(sdk, args);
  const prepare = async (sdk = "answer") => {
    mode = "success";
    await execute("present_analysis_answer", sdk, input);
    assert.deepEqual(state.answer(), { text, sdkId: sdk, sources: [{query_id: "query", ...taskA}], taskRef: taskA });
  };
  return { state, execute, prepare, setMode: value => { mode = value; }, setText: value => { text = value; } };
}
const taskA = {task_id: "task-a", condition_version: "1"};
const taskB = {task_id: "task-b", condition_version: "1"};
const frozenA = {task_ref: taskA, finalized_by_sdk_tool_call_id: "finalize-a", scope_fingerprint: "a".repeat(64)};
const firstAnswer = '合成甲任务按原资料分别记录开始与完成。🪴\n'.repeat(110);
const lastAnswer = "合成乙任务使用自己的调查结果，已经完成解释。";
const routeArgs = {action: "route", task_id: taskB.task_id, expected_version: taskB.condition_version,
  options: [], finalize_current_answer: true};
const usage = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}};
const assistant = (content, stopReason = "stop") => ({role: "assistant", content, stopReason,
  api: "openai-completions", provider: "local_mock", model: "task_demo", usage, timestamp: Date.now()});
function handoffFixture({writeGate, writeFailure = false, legacyReceipt = false, parts = []} = {}) {
  const manager = SessionManager.inMemory("/synthetic/answer-handoff"), requests = [], chunks = [];
  const run = {attempt_id: "original-attempt", tool_contract_version: 2, answer_parts: parts,
    workspace_context: {active_task_ref: taskA}};
  let start, rejected = false;
  const output = outputStream(async (seq, text) => {
    await writeGate;
    if (writeFailure) throw new Error("synthetic_output_failed");
    chunks.push({seq, text});
  });
  const transport = {run, binding: () => ({run_id: "run", lease_epoch: "1"}),
    async post(path, _schema, invocation) {
      requests.push({path, invocation});
      const operation_id = "operation-" + invocation.sdk_tool_call_id;
      if (path === "/internal/data/tool-calls") return decodeContract("OperationReceipt", {operation_id, tool_contract_version: 2});
      assert.equal(path, "/internal/data/tools");
      const data = rejected ? {error: "invalid_evidence", outcome: "rejected"}
        : invocation.tool_name === "prepare_analysis_answer" ? {bindings: {amount: "41"}, required_suffix: "",
            sources: [{query_id: "query", result_ref: "result", ...taskA}]}
        : invocation.tool_name === "update_analysis_task" ? taskB : {};
      return decodeContract("DataToolOutcome", {operation_id, tool_name: invocation.tool_name, tool_contract_version: 2, data,
        ...(!rejected && invocation.tool_name === "prepare_analysis_answer" ? {answer_task_ref: taskA} : {}),
        ...(!rejected && !legacyReceipt && invocation.arguments.finalize_current_answer === true ? {answer_parts: [frozenA]} : {})});
    }};
  // 与deliver.ts同源：renderedFinal在message_end定稿，route执行时经renderedCandidate交接渲染绑定。
  let renderedFinal;
  const state = dataTools(transport, manager, "", undefined, undefined, {start: () => start, drain: output.drain},
    () => renderedFinal ? {binding: lastChunk => ({
      assistant: assistantOutputBinding(manager, run.attempt_id),
      source_text: renderedFinal.sourceText, prepared_sdk_tool_call_id: renderedFinal.sdkId,
      first_chunk_seq: String(renderedFinal.first), last_chunk_seq: String(lastChunk)})} : undefined);
  const message = ({text = firstAnswer, calls = [{type: "toolCall", id: "finalize-a", name: "update_analysis_task", arguments: routeArgs}], stop = "toolUse", persist = true, render = false} = {}) => {
    start = output.startMessage();
    renderedFinal = undefined;
    if (persist && render) {
      // 本条开始时已成功的prepare渲染正文一次写完；原assistant entry保持模板原文。
      const preparation = state.preparation();
      const renderer = renderedStream(preparation.bindings);
      output.append(renderer.push(text));
      const finished = renderer.finish(preparation.requiredSuffix);
      if (finished.ok && text.trim()) {
        output.append(finished.emit);
        renderedFinal = {sdkId: preparation.sdkId, display: finished.display, sourceText: text, first: start};
      }
    } else if (persist) output.append(text);
    return manager.appendMessage(assistant([...text ? [{type: "text", text}] : [], ...calls], stop));
  };
  return {state, run, manager, output, chunks, requests, message, reject: () => {rejected = true;},
    execute: (name, id, args) => state.tools.find(tool => tool.name === name).execute(id, args)};
}

async function deliverProtocol({grounded = false, recovery, failOutput = false, rejectedCall, retiredPresent = false} = {}) {
  const chunks = [], invocations = [], finishes = [], providerInputs = [], hostErrors = [];
  const rejectionWithFrozen = rejectedCall?.startsWith("frozen-");
  const unknownCall = rejectedCall === "unknown" || rejectedCall === "frozen-unknown";
  const manager = SessionManager.inMemory("/synthetic/answer-delivery");
  const finalizedA = grounded ? {...frozenA, source_query_ids: ["query"]} : frozenA;
  let frozen = recovery === "frozen" ? [frozenA] : [], routeCommits = recovery === "frozen" ? 1 : 0;
  if (recovery) {
    // 真实恢复检查点含原输入边界；渲染交付的提交路径沿它定位本轮条目。
    manager.appendMessage({role: "user", content: "分别解释合成甲乙目标。", timestamp: Date.now()});
    manager.appendMessage(assistant([{type: "text", text: firstAnswer},
      {type: "toolCall", id: "finalize-a", name: "update_analysis_task", arguments: routeArgs}], "toolUse"));
    if (recovery === "frozen") manager.appendMessage({role: "toolResult", toolCallId: "finalize-a", toolName: "update_analysis_task",
      content: [{type: "text", text: JSON.stringify(taskB)}], details: {operation_id: "operation-finalize-a", tool_name: "update_analysis_task",
        tool_contract_version: 2, data: taskB, answer_parts: frozen}, isError: false, timestamp: Date.now()});
  }
  const server = createServer(async (request, response) => {
    const send = (status, value) => response.writeHead(status, {"content-type": "application/json"}).end(JSON.stringify(value));
    try {
      const buffers = []; for await (const buffer of request) buffers.push(buffer);
      const value = JSON.parse(Buffer.concat(buffers).toString("utf8"));
      if (request.url === "/chat/completions") {
        providerInputs.push(value);
        assert.ok(value.tools?.length, "不得新增摘要或汇总调用");
        const turn = providerInputs.length;
        assert.ok(turn <= (retiredPresent ? 2 : rejectedCall ? rejectedCall === "route" ? 4 : 3 : recovery ? 2 : grounded ? 4 : 3), "不得额外调用模型");
        const toolNames = (value.tools ?? []).map(tool => tool.function?.name).filter(Boolean);
        assert.ok(!toolNames.includes("present_analysis_answer"), "v2模型目录不得重新开放退休present调用");
        assert.ok(toolNames.includes("prepare_analysis_answer"), "v2模型目录必须提供prepare");
        const calls = [];
        let text = "";
        if (retiredPresent) {
          if (turn === 1) calls.push({id: "retired-present", name: "present_analysis_answer", arguments: input});
          else {
            const result = value.messages.findLast(message => message.role === "tool");
            assert.ok(result, "Pi必须提供退休工具的执行前拒绝回执");
            assert.match(result.content, /not found/);
            text = lastAnswer;
          }
        } else if (rejectedCall) {
          if (turn === 1) calls.push({id: "prepare-a", name: "prepare_analysis_answer", arguments: prepareInput});
          else if (turn === 2) calls.push({id: "rejected-before-execute", name: unknownCall ? "synthetic_unknown_tool" : "get_query", arguments: {}});
          else if (turn === 3) {
            const result = value.messages.findLast(message => message.role === "tool");
            assert.ok(result, "Pi必须提供执行前拒绝回执");
            assert.match(result.content, unknownCall ? /not found/ : /query_id/);
            if (rejectedCall === "route") {
              text = firstAnswer;
              calls.push({id: "finalize-a", name: "update_analysis_task", arguments: routeArgs});
            } else text = lastAnswer;
          } else text = lastAnswer;
        } else if (!recovery && grounded && turn === 1) calls.push({id: "prepare-a", name: "prepare_analysis_answer", arguments: prepareInput});
        else if (!recovery && turn === (grounded ? 2 : 1)) {
          text = grounded ? "净收入{{amount}}分。" : firstAnswer;
          calls.push({id: "finalize-a", name: "update_analysis_task", arguments: routeArgs});
        } else if (turn === (recovery ? 1 : grounded ? 3 : 2)) calls.push({id: "read-b", name: "read_analysis_task", arguments: {task_id: taskB.task_id}});
        else text = lastAnswer;
        response.writeHead(200, {"content-type": "text/event-stream"});
        const emit = (delta, finish_reason = null) => response.write("data: " + JSON.stringify({id: "synthetic-answer-state",
          choices: [{index: 0, delta, finish_reason}]}) + "\n\n");
        emit({role: "assistant"});
        for (let offset = 0; offset < text.length; offset += 71) emit({content: text.slice(offset, offset + 71)});
        if (calls.length) emit({tool_calls: calls.map((call, index) => ({index, id: call.id, type: "function",
          function: {name: call.name, arguments: JSON.stringify(call.arguments)}}))});
        emit({}, calls.length ? "tool_calls" : "stop");
        response.write("data: " + JSON.stringify({choices: [], usage: {prompt_tokens: 100, completion_tokens: 1500, total_tokens: 1600}}) + "\n\n");
        response.end("data: [DONE]\n\n"); return;
      }
      if (request.url === "/internal/model/reserve") return send(200, {state: "reserved", send_allowed: false});
      if (request.url === "/internal/model/send") return send(200, {state: "issued", send_allowed: true});
      if (request.url === "/internal/model/finalize") return send(200, {state: value.usage ? "settled" : "unknown", send_allowed: false});
      if (request.url === "/internal/outputs") {
        if (failOutput) return send(503, {code: "unavailable", message: "合成输出失败", request_id: "request", retryable: false});
        assert.equal(Number(value.chunk_seq), chunks.length + 1);
        chunks.push({seq: value.chunk_seq, text: value.text});
        return send(200, {chunk_seq: value.chunk_seq});
      }
      if (["/internal/data/tool-calls", "/internal/data/tools"].includes(request.url)) {
        decodeContract("DataToolInvocation", value);
        invocations.push({path: request.url, value});
        const operation_id = "operation-" + value.sdk_tool_call_id;
        if (value.arguments.finalize_current_answer === true) {
          if (rejectedCall === "route") assert.equal(value.answer_handoff?.answer_sdk_tool_call_id, undefined,
            "Pi执行前拒绝后，后续route不能定稿旧查询候选");
          if (recovery) assert.equal(value.answer_handoff, undefined, "恢复必须沿原登记，不能绑定新attempt空片段");
          else if (rejectedCall || grounded) {
            // 候选经prepare渲染：route沿rendered分支交接原Pi entry与原prepare回执。
            const binding = value.answer_handoff.rendered_answer_binding;
            const body = grounded ? "净收入{{amount}}分。" : firstAnswer;
            assert.equal(binding.prepared_sdk_tool_call_id, "prepare-a", "冻结正文必须绑定原prepare成功回执");
            assert.equal(binding.source_text, body);
            assert.equal(binding.assistant.attempt_id, "attempt");
            assert.equal(binding.assistant.text_sha256, createHash("sha256").update(body, "utf8").digest("hex"));
            assert.deepEqual(binding.assistant.tool_call_ids, ["finalize-a"]);
            assert.equal(binding.assistant.first_chunk_seq, undefined);
            assert.equal(binding.assistant.last_chunk_seq, undefined);
            assert.equal(chunks.filter(chunk => Number(chunk.seq) >= Number(binding.first_chunk_seq)
              && Number(chunk.seq) <= Number(binding.last_chunk_seq)).map(chunk => chunk.text).join(""),
              grounded ? "净收入41分。" : firstAnswer, "route冻结的展示片段必须是本轮重新给出的完整正文");
          } else {
            const binding = value.answer_handoff.assistant;
            assert.equal(binding.attempt_id, "attempt");
            assert.equal(binding.text_sha256, createHash("sha256").update(firstAnswer).digest("hex"));
            assert.deepEqual(binding.tool_call_ids, ["finalize-a"]);
            assert.equal(value.answer_handoff.answer_sdk_tool_call_id, undefined);
            assert.equal(chunks.filter(chunk => Number(chunk.seq) >= Number(binding.first_chunk_seq)
              && Number(chunk.seq) <= Number(binding.last_chunk_seq)).map(chunk => chunk.text).join(""), firstAnswer);
          }
        }
        if (request.url === "/internal/data/tool-calls") return send(200, {operation_id, tool_contract_version: 2});
        if (value.tool_name === "prepare_analysis_answer") return send(200, {operation_id, tool_name: value.tool_name,
          answer_task_ref: recovery === "frozen" ? taskB : taskA, tool_contract_version: 2,
          data: {bindings: {amount: "41"}, required_suffix: "",
            sources: [{query_id: "query", result_ref: "result", ...(recovery === "frozen" ? taskB : taskA)}]}});
        if (value.tool_name === "update_analysis_task") {
          routeCommits++; frozen = [finalizedA];
          return send(200, {operation_id, tool_name: value.tool_name, tool_contract_version: 2, data: taskB,
            answer_parts: frozen, frozen_notification_covered: grounded});
        }
        assert.equal(value.tool_name, "read_analysis_task");
        return send(200, {operation_id, tool_name: value.tool_name, tool_contract_version: 2, data: {id: taskB.task_id, condition_version: "1"}});
      }
      if (request.url === "/internal/finish") {
        decodeContract("FinishRun", value); finishes.push(value);
        return send(200, {state: "finished", output_id: "output"});
      }
      throw new Error("unexpected local request: " + request.url);
    } catch (error) {
      hostErrors.push(error.stack);
      if (!response.headersSent) send(500, {code: "unavailable", message: "合成宿主失败", request_id: "request", retryable: false});
      else response.destroy(error);
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  localOrigin = "http://127.0.0.1:" + server.address().port;
  const previous = new Map(["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "DATA_AGENT_PROVIDER_TEST"].map(name => [name, process.env[name]]));
  const run = {request_id: "request", run_id: "run", conversation_id: "conversation", recovery_chain_id: "chain",
    lease_epoch: "1", budget_scope_id: "budget", output_id: "output", attempt_id: "attempt", message_id: "message",
    text: "分别解释合成甲乙目标。", checkpoint: recovery ? exportCheckpoint(manager) : null,
    tool_contract_version: 2, ...(recovery ? {resume_same_input: true} : {}), answer_parts: frozen,
    model_profile: {provider_id: "deepseek", model_id: "deepseek-flash", trial_id: "synthetic-trial", price_version: "2026-10-04-peak-usd",
      input_limit: 65536, output_limit: 4096, payload_bytes_limit: 131072, request_call_limit: 24, toolset: "data", thinking_level: "off"},
    workspace_context: {active_task_ref: recovery === "frozen" ? taskB : taskA, tasks: [], recent_messages: [], selected_skills: [], memories: [],
      query_observations: [{id: "query", ...(recovery === "frozen" ? taskB : taskA), execution_state: "succeeded"}], authority_revision: "synthetic-authority",
      ...(grounded ? {result_notification: {query_id: "query", execution_state: "succeeded"}} : {})}};
  let failure;
  try {
    process.env.DEEPSEEK_API_KEY = "synthetic-only";
    process.env.DEEPSEEK_BASE_URL = localOrigin;
    process.env.DATA_AGENT_PROVIDER_TEST = "1";
    try { await deliver(run, localOrigin, "synthetic-token", ""); } catch (error) {failure = error;}
    assert.deepEqual(hostErrors, []);
    if (failOutput) {
      assert.equal(failure?.message, "unavailable");
      assert.equal(finishes.length, 0);
      assert.equal(routeCommits, 0, "输出失败不得登记定稿或切任务");
      return;
    }
    assert.equal(failure, undefined, failure?.stack);
    assert.equal(finishes.length, 1);
    const finish = finishes[0];
    if (retiredPresent) {
      assert.equal(finish.final_text, lastAnswer);
      assert.equal(finish.answer_sdk_tool_call_id, undefined);
      assert.equal(finish.rendered_answer_binding, undefined);
      assert.ok(finish.output_binding, "退休工具被拒后仍按自然正文交付");
      assert.equal(invocations.filter(call => call.value.tool_name === "present_analysis_answer").length, 0,
        "退休present不得经Rust登记或执行");
      assert.equal(invocations.filter(call => call.value.tool_name === "prepare_analysis_answer").length, 0);
      assert.equal(providerInputs.length, 2);
      return;
    }
    if (rejectedCall && rejectedCall !== "route" && !rejectionWithFrozen) {
      assert.equal(finish.answer_sdk_tool_call_id, undefined, "Pi执行前拒绝必须使未冻结候选失效");
      assert.equal(finish.final_text, lastAnswer, "执行前拒绝后应交付本轮重新给出的正文");
      assert.ok(finish.rendered_answer_binding, "v2重给正文须绑定渲染结果");
      assert.equal(finish.rendered_answer_binding.prepared_sdk_tool_call_id, "prepare-a");
      assert.equal(finish.rendered_answer_binding.assistant.text_sha256, createHash("sha256").update(lastAnswer, "utf8").digest("hex"),
        "finish只采用拒绝后重新给出的正文，不得复用拒绝前的候选正文");
      assert.equal(routeCommits, 0);
      assert.equal(providerInputs.length, 3);
      assert.equal(invocations.filter(call => call.value.sdk_tool_call_id === "rejected-before-execute").length, 0,
        "反例必须由Pi在execute前拒绝，不能调用Rust或直接执行工具代替");
      return;
    }
    assert.equal(finish.final_text, lastAnswer, "组合正文不能回填Pi或作为final_text发送");
    assert.deepEqual(finish.answer_parts[0], finalizedA);
    assert.equal(finish.answer_parts.length, 2);
    const last = finish.answer_parts[1];
    assert.deepEqual(last.task_ref, taskB);
    const finalBinding = last.rendered_answer_binding?.assistant ?? last.output_binding;
    assert.equal(finalBinding.attempt_id, "attempt");
    assert.equal(finalBinding.stop_reason, "stop");
    assert.deepEqual(finalBinding.tool_call_ids, []);
    const checkpoint = finish.checkpoint;
    const branch = checkpoint.storage
      ? (await import("../../apps/agent/session/checkpoint.ts")).restoreCheckpoint("/synthetic/data-agent", checkpoint).getBranch()
      : checkpoint.entries;
    assert.equal(branch.findLast(entry => entry.type === "message" && entry.message.role === "assistant").id, finalBinding.entry_id);
    assert.equal(finalBinding.text_sha256, createHash("sha256").update(lastAnswer).digest("hex"));
    const delivered = last.rendered_answer_binding ?? last.output_binding;
    assert.equal(chunks.filter(chunk => Number(chunk.seq) >= Number(delivered.first_chunk_seq)
      && Number(chunk.seq) <= Number(delivered.last_chunk_seq)).map(chunk => chunk.text).join(""), lastAnswer,
    "A定稿或A成功查询通知不得抑制B自然输出");
    assert.equal(routeCommits, 1);
    if (rejectionWithFrozen) {
      assert.equal(finish.answer_sdk_tool_call_id, undefined);
      assert.ok(last.rendered_answer_binding, "乙重新给出的正文经乙自己的prepare渲染交付");
      assert.equal(last.rendered_answer_binding.prepared_sdk_tool_call_id, "prepare-a");
      assert.equal(last.answer_sdk_tool_call_id, undefined, "乙执行前拒绝后不能沿用乙的旧候选");
      assert.equal(invocations.filter(call => call.value.sdk_tool_call_id === "rejected-before-execute").length, 0);
    }
    assert.equal(providerInputs.length, rejectedCall ? rejectedCall === "route" ? 4 : 3 : recovery ? 2 : grounded ? 4 : 3);
    assert.equal(invocations.filter(call => call.path === "/internal/data/tools" && call.value.tool_name === "prepare_analysis_answer").length, grounded || rejectedCall ? 1 : 0);
    assert.ok(providerInputs.every(payload => !JSON.stringify(payload).includes('## 合成甲目标')), "不得向下轮注入组合正文");
  } finally {
    for (const [name, value] of previous) {if (value === undefined) delete process.env[name]; else process.env[name] = value;}
    localOrigin = undefined;
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}

async function check(name, test) {
  const entry = { name, passed: false };
  try { await test(); entry.passed = true; }
  catch (error) { entry.error = error.message; }
  checks.push(entry);
}

try {
  await check("成功答案后其他工具明确失败，不能继续提交旧答案", async () => {
    const f = fixture();
    await f.prepare();
    f.setMode("rejection");
    const rejected = await f.execute("get_query", "rejected-read", { query_id: "query" });
    assert.equal(rejected.isError, true);
    assert.equal(rejected.details.data.error, "invalid_evidence");
    assert.equal(f.state.answer(), undefined);
  });
  await check("第二次答案生成失败清除旧答案，重新成功后只保留新回执", async () => {
    const f = fixture();
    await f.prepare();
    f.setMode("rejection");
    const rejected = await f.execute("present_analysis_answer", "rejected-answer", input);
    assert.equal(rejected.isError, true);
    assert.equal(rejected.details.data.error, "invalid_evidence");
    assert.equal(f.state.answer(), undefined);
    f.setText("净收入43分。");
    await f.prepare("repaired-answer");
    assert.deepEqual(f.state.answer(), { text: "净收入43分。", sdkId: "repaired-answer", sources: [{query_id: "query", ...taskA}], taskRef: taskA });
  });
  await check("传输未知或调用参数在发送前失败，也不能沿用前一次成功答案", async () => {
    const f = fixture();
    await f.prepare();
    f.setMode("transport_failure");
    await assert.rejects(() => f.execute("get_query", "unavailable-read", { query_id: "query" }), /unavailable/);
    assert.equal(f.state.answer(), undefined);
    await f.prepare("fresh-answer");
    await assert.rejects(() => f.execute("get_query", "invalid-read", {}));
    assert.equal(f.state.answer(), undefined);
  });
  await check("检查点接回调用的拒绝回执与正常execute保持相同答案失效语义", async () => {
    const f = fixture();
    await f.prepare();
    f.setMode("rejection");
    const receipt = await f.state.invokeRecorded("present_analysis_answer", "recovered-rejection", input);
    assert.equal(receipt.data.error, "invalid_evidence");
    assert.equal(f.state.answer(), undefined);
  });
  await check("旧查询过期只影响自身，未定位来源的答案失败不能豁免当前查询来源", async () => {
    const f = fixture();
    f.setMode("result_expired");
    const expired = await f.execute("get_query", "old-expired", { query_id: "old-query" });
    assert.equal(expired.isError, true);
    assert.equal(expired.details.data.error, "result_expired");
    assert.equal(f.state.resultUnavailable("old-query"), true);
    assert.equal(f.state.resultUnavailable("current-query"), false);
    const multipleSources = {
      template: "核对两项已有结果。",
      sources: ["old-query", "current-query"].map(query_id => ({ query_id, result_ref: "result", columns: ["amount"] })),
      values: [],
    };
    const unlocated = await f.execute("present_analysis_answer", "unlocated-expiry", multipleSources);
    assert.equal(unlocated.isError, true);
    assert.equal(unlocated.details.data.error, "result_expired");
    assert.equal(f.state.resultUnavailable("old-query"), true);
    assert.equal(f.state.resultUnavailable("current-query"), false, "答案工具未指出哪份来源过期，不能把每个来源标为不可读");
  });
  await check("同一查询重新取得结果后清除不可读状态，仅取得状态时不假称恢复", async () => {
    const f = fixture();
    f.setMode("result_expired");
    const expired = await f.execute("get_query", "expired-result", { query_id: "query" });
    assert.equal(expired.isError, true);
    assert.equal(expired.details.data.error, "result_expired");
    assert.equal(f.state.resultUnavailable("query"), true);
    f.setMode("success");
    await f.execute("get_query", "status-only", { query_id: "query" });
    assert.equal(f.state.resultUnavailable("query"), true);
    f.setMode("result_available");
    await f.execute("get_query", "result-restored", { query_id: "query" });
    assert.equal(f.state.resultUnavailable("query"), false, "已有有效结果必须重新要求来源答案，不能沿用旧不可读状态绕过交付");
  });
  await check("显式route等待输出确认，绑定原中文emoji原文哈希和SDK条目后才登记", async () => {
    const gate = Promise.withResolvers(), f = handoffFixture({writeGate: gate.promise});
    try {
      const entry = f.message();
      const pending = f.execute("update_analysis_task", "finalize-a", routeArgs);
      await Promise.resolve(); await Promise.resolve();
      assert.equal(f.requests.length, 0, "drain完成前不登记或切任务");
      gate.resolve();
      const result = await pending;
      const binding = f.requests[0].invocation.answer_handoff.assistant;
      assert.equal(binding.entry_id, entry);
      assert.equal(binding.attempt_id, "original-attempt");
      assert.equal(binding.text_sha256, createHash("sha256").update(firstAnswer, "utf8").digest("hex"));
      assert.equal(binding.first_chunk_seq, "1");
      assert.equal(binding.last_chunk_seq, String(f.chunks.length));
      assert.ok(f.chunks.length >= 2);
      assert.equal(f.chunks.map(chunk => chunk.text).join(""), firstAnswer);
      assert.deepEqual(f.state.answerParts(), [frozenA]);
      assert.deepEqual(f.run.workspace_context.active_task_ref, taskB);
      assert.deepEqual(JSON.parse(result.content[0].text).answer_parts, [frozenA]);
    } finally {gate.resolve(); await f.output.close();}
  });
  await check("查询候选在route清空前绑定，冻结A不被B失败清除，旧回执不猜冻结", async () => {
    const f = handoffFixture();
    try {
      await f.execute("prepare_analysis_answer", "prepare-a", prepareInput);
      assert.deepEqual(f.state.preparation(), {sdkId: "prepare-a", taskRef: taskA,
        sources: [{query_id: "query", task_id: taskA.task_id, condition_version: taskA.condition_version}],
        bindings: {amount: "41"}, requiredSuffix: ""});
      f.message({text: "净收入{{amount}}分。", render: true});
      await f.execute("update_analysis_task", "finalize-a", routeArgs);
      const handoff = f.requests.find(request => request.invocation.sdk_tool_call_id === "finalize-a").invocation.answer_handoff;
      const binding = handoff.rendered_answer_binding;
      assert.equal(binding.prepared_sdk_tool_call_id, "prepare-a");
      assert.equal(binding.source_text, "净收入{{amount}}分。");
      assert.equal(binding.assistant.attempt_id, "original-attempt");
      assert.equal(binding.assistant.text_sha256, createHash("sha256").update("净收入{{amount}}分。", "utf8").digest("hex"));
      assert.deepEqual(binding.assistant.tool_call_ids, ["finalize-a"]);
      assert.equal(binding.assistant.first_chunk_seq, undefined);
      assert.equal(binding.assistant.last_chunk_seq, undefined);
      assert.equal(f.chunks.filter(chunk => Number(chunk.seq) >= Number(binding.first_chunk_seq)
        && Number(chunk.seq) <= Number(binding.last_chunk_seq)).map(chunk => chunk.text).join(""), "净收入41分。",
        "冻结范围必须是替换后的展示正文");
      assert.equal(f.state.answer(), undefined);
      assert.equal(f.state.preparation(), undefined, "route清空准备后不能跨任务沿用绑定");
      f.reject();
      const rejected = await f.execute("get_query", "failed-b", {query_id: "query"});
      assert.equal(rejected.isError, true);
      assert.equal(rejected.details.data.error, "invalid_evidence");
      assert.deepEqual(f.state.answerParts(), [frozenA]);
    } finally {await f.output.close();}
    const legacy = handoffFixture({legacyReceipt: true});
    try {
      legacy.message();
      await legacy.execute("update_analysis_task", "finalize-a", routeArgs);
      assert.deepEqual(legacy.state.answerParts(), []);
    } finally {await legacy.output.close();}
  });
  await check("普通route不携handoff、不冻结；v2退役present只留重放，v1定义隐藏定稿参数", async () => {
    const f = handoffFixture();
    try {
      await f.execute("prepare_analysis_answer", "prepare-a", prepareInput);
      assert.equal(f.state.tools.some(tool => tool.name === "present_analysis_answer"), false, "v2模型目录不得重新开放退休present");
      assert.ok(f.state.tools.some(tool => tool.name === "prepare_analysis_answer"));
      f.state.validateArguments("present_analysis_answer", input);
      const savedPresent = decodeContract("DataToolOutcome", {operation_id: "operation-historic-present", tool_name: "present_analysis_answer",
        tool_contract_version: 1, answer_task_ref: taskA,
        data: {answer_text: "净收入41分。", sources: [{query_id: "query", result_ref: "result", ...taskA}], result_dependencies: []}});
      await f.state.restoreAnswer("historic-present", input, savedPresent);
      assert.deepEqual(f.state.answer(), {text: "净收入41分。", sdkId: "historic-present",
        sources: [{query_id: "query", ...taskA}], taskRef: taskA});
      await f.execute("update_analysis_task", "ordinary-route", {...routeArgs, finalize_current_answer: false});
      assert.ok(f.requests.every(request => request.invocation.answer_handoff === undefined));
      assert.equal(f.state.answer(), undefined);
      assert.equal(f.state.preparation(), undefined, "普通route切任务使准备失效");
      assert.deepEqual(f.state.answerParts(), []);
      const v1 = fixture().state.tools.find(tool => tool.name === "update_analysis_task");
      assert.equal(JSON.stringify(v1.parameters).includes("finalize_current_answer"), false);
      assert.equal(v1.description.includes("finalize_current_answer"), false);
    } finally {await f.output.close();}
  });
  await check("缺片段、length/aborted/error和同条混工具不得登记定稿；输出失败原样传播", async () => {
    for (const options of [{persist: false}, {stop: "length"}, {stop: "aborted"}, {stop: "error"},
      {calls: [{type: "toolCall", id: "finalize-a", name: "update_analysis_task", arguments: routeArgs},
        {type: "toolCall", id: "read-a", name: "read_analysis_task", arguments: {task_id: taskA.task_id}}]}]) {
      const f = handoffFixture();
      try {
        f.message(options);
        await assert.rejects(f.execute("update_analysis_task", "finalize-a", routeArgs), /answer_(output_incomplete|message_incomplete|route_must_be_single_call)/);
        assert.deepEqual(f.requests, []);
        assert.deepEqual(f.run.workspace_context.active_task_ref, taskA);
      } finally {await f.output.close();}
    }
    const f = handoffFixture({writeFailure: true});
    try {
      f.message();
      await assert.rejects(f.execute("update_analysis_task", "finalize-a", routeArgs), /synthetic_output_failed/);
      assert.deepEqual(f.requests, []);
    } finally {await f.output.close();}
  });
  await check("恢复沿原登记无需重算新attempt输出；RunEnvelope已冻结引用独立保留", async () => {
    const f = handoffFixture({parts: [frozenA], writeFailure: true});
    try {
      f.run.attempt_id = "new-attempt";
      f.message();
      await f.state.invokeRecorded("update_analysis_task", "finalize-a", routeArgs);
      assert.ok(f.requests.every(request => request.invocation.answer_handoff === undefined));
      assert.deepEqual(f.state.answerParts(), [frozenA]);
    } finally {await f.output.close();}
  });
  await check("真实Pi参数校验在execute前拒绝后，finish只交付重新给出并渲染的正文", () => deliverProtocol({rejectedCall: "arguments"}));
  await check("真实Pi未知工具在execute前拒绝后，finish只交付重新给出并渲染的正文", () => deliverProtocol({rejectedCall: "unknown"}));
  await check("真实Pi执行前拒绝后，后续route只能冻结重新给出的完整正文", () => deliverProtocol({rejectedCall: "route"}));
  await check("甲已冻结后乙候选遇Pi参数前置拒绝，甲保留且乙重新自然回答", () => deliverProtocol({recovery: "frozen", rejectedCall: "frozen-arguments"}));
  await check("甲已冻结后乙候选遇Pi未知工具拒绝，甲保留且乙重新自然回答", () => deliverProtocol({recovery: "frozen", rejectedCall: "frozen-unknown"}));
  await check("真实Pi经过deliver：A中文emoji跨片段定稿，B工具与自然final组成完整引用", () => deliverProtocol());
  await check("A成功查询通知经prepare渲染和route定稿后，不抑制B自然输出或再要求A来源", () => deliverProtocol({grounded: true}));
  await check("登记后未冻结恢复沿原SDK调用不重算handoff，再完成B自然final", () => deliverProtocol({recovery: "registered"}));
  await check("RunEnvelope恢复已冻结A，B自然final不重复route或原操作", () => deliverProtocol({recovery: "frozen"}));
  await check("真实deliver输出写入失败，不登记route、不切任务且不提交finish", () => deliverProtocol({failOutput: true}));
  await check("v2真实Pi在execute前拒绝退休present调用，不经Rust登记或执行", () => deliverProtocol({retiredPresent: true}));
} finally {
  globalThis.fetch = originalFetch;
}
const passed = checks.every(check => check.passed) && networkAttempts === 0;
const report = { passed, checks, node: process.versions.node, networkAttempts, officialRequests: 0, databaseUsed: false,
  boundary: "real dataTools and deliver/Pi 1.3.0; controlled Rust transport and loopback protocol" };
await mkdir(".local/checks/answer-state-contract", { recursive: true });
await writeFile(".local/checks/answer-state-contract/answer-state.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
assert.ok(passed, "答案失效状态检查未全部通过");

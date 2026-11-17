import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {Ajv2020} from 'ajv/dist/2020.js';
import {fullFormats} from 'ajv-formats/dist/formats.js';
import schema from '../../packages/contracts/schema.json' with {type: 'json'};

const diagnose = process.argv.includes('--diagnose-validation');
const validations = new Map();
// 计数只用于本次窄诊断；HTTP端点用独立验证器，避免把Rust侧独立边界算作Node重复。
const hostAjv = new Ajv2020({strict: false, allErrors: true});
hostAjv.addFormat('date-time', fullFormats['date-time']);
const hostValidators = Object.fromEntries(['DataToolInvocation', 'ReadQueryInput'].map(name => [name,
  hostAjv.compile({...schema, $id: undefined, properties: undefined, required: undefined,
    type: undefined, additionalProperties: undefined, $ref: '#/$defs/' + name}),
]));
const compile = Ajv2020.prototype.compile;
if (diagnose) Ajv2020.prototype.compile = function(value, ...args) {
  const validator = Reflect.apply(compile, this, [value, ...args]);
  const name = value.$ref?.replace('#/$defs/', '');
  return new Proxy(validator, {apply(target, receiver, parameters) {
    validations.set(name, (validations.get(name) ?? 0) + 1);
    return Reflect.apply(target, receiver, parameters);
  }});
};
let dataTools, RustTransport, SessionManager, exportCheckpoint;
try {
  ({dataTools} = await import('../../apps/agent/tools/data-tools.ts'));
  ({RustTransport} = await import('../../apps/agent/transport/client.ts'));
  ({SessionManager} = await import('@earendil-works/pi-coding-agent'));
  ({exportCheckpoint} = await import('../../apps/agent/session/checkpoint.ts'));
} finally { Ajv2020.prototype.compile = compile; }

const token = 'synthetic-data-tool-transport-token';
const run = {request_id: 'request', run_id: 'run', lease_epoch: '1', conversation_id: 'conversation',
  recovery_chain_id: 'chain', budget_scope_id: 'budget', output_id: 'output', attempt_id: 'attempt',
  message_id: 'message', text: '取消合成查询。', checkpoint: null, model_profile: null};
const args = {query_id: 'query'};
const data = {query_id: 'query', execution_state: 'cancelled', cancellation_state: 'confirmed'};
const receipt = {operation_id: 'operation-current', tool_name: 'cancel_query', data};
const legacyArgs = {query_id: 'query', legacy_reason: '旧版本合成参数'};
const legacyReceipt = {...receipt, operation_id: 'operation-legacy'};
const appError = code => ({code, message: '合成协议错误：' + code, request_id: 'request', retryable: false});
const signature = input => JSON.stringify({name: input.tool_name, arguments: input.arguments});
const checks = [];

async function withHost(test, options = {}) {
  const requests = [], received = [], hostErrors = [], accepted = [];
  const ledger = new Map((options.recorded ?? []).map(entry => [entry.id, {...entry}]));
  let businessCommits = 0;
  const server = createServer(async (request, response) => {
    const send = (status, value) => response.writeHead(status, {'content-type': 'application/json'}).end(JSON.stringify(value));
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.authorization, 'Bearer ' + token);
      assert.equal(request.headers['content-type'], 'application/json');
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(request.url); received.push(input);
      if (!hostValidators.DataToolInvocation(input)) return send(400, appError('invalid_input'));
      if (options.registrationError) return send(409, appError(options.registrationError));
      if (input.run_id !== run.run_id || input.lease_epoch !== run.lease_epoch) return send(409, appError('lease_lost'));
      const recorded = ledger.get(input.sdk_tool_call_id);
      if (recorded && recorded.signature !== signature(input)) return send(409, appError('idempotency_conflict'));
      if (request.url === '/internal/data/tool-calls') {
        if (recorded) {
          if (!hostValidators.ReadQueryInput(input.arguments) && !recorded.receipt)
            return send(409, appError('outcome_unknown'));
          return send(200, options.operationReceipt ?? {operation_id: recorded.operation_id});
        }
        if (!hostValidators.ReadQueryInput(input.arguments)) return send(400, appError('invalid_input'));
        ledger.set(input.sdk_tool_call_id, {signature: signature(input), operation_id: 'operation-current'});
        return send(200, options.operationReceipt ?? {operation_id: 'operation-current'});
      }
      if (request.url === '/internal/data/tool-rejections') {
        if (recorded?.state !== 'rejected' || !recorded.receipt) return send(404, appError('not_available'));
        return send(200, recorded.receipt);
      }
      assert.equal(request.url, '/internal/data/tools');
      if (!recorded) return send(409, appError('version_conflict'));
      if (recorded.receipt) return send(200, recorded.receipt);
      if (options.invalidError) return send(503, {message: '缺少AppError必填字段'});
      if (options.executionError) return send(409, appError(options.executionError));
      if (options.rejection) {
        recorded.state = 'rejected';
        recorded.receipt = {...receipt, data: {error: options.rejection, outcome: 'rejected', query_id: 'query'}};
        return send(403, appError(options.rejection));
      }
      recorded.state = 'succeeded'; recorded.receipt = receipt; businessCommits++;
      if (options.invalidJson) return response.writeHead(200, {'content-type': 'application/json'}).end('{"data":');
      return send(200, Object.hasOwn(options, 'outcome') ? options.outcome : recorded.receipt);
    } catch (error) {
      hostErrors.push(error.stack);
      if (!response.headersSent) send(500, appError('unavailable'));
      else response.destroy(error);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const transport = new RustTransport({...run}, 'http://127.0.0.1:' + server.address().port, token);
  const manager = SessionManager.inMemory('/synthetic/data-tool-transport');
  const state = dataTools(transport, manager, '', (value, sdkId) => accepted.push({receipt: value, sdkId}));
  const input = (id = 'current', parameters = args) => ({...transport.binding(), sdk_tool_call_id: id,
    tool_name: 'cancel_query', arguments: parameters, checkpoint: exportCheckpoint(manager)});
  const execute = (id = 'current', parameters = args) => state.tools.find(tool => tool.name === 'cancel_query').execute(id, parameters);
  try {
    await test({state, transport, execute, input, requests, received, accepted, ledger, commits: () => businessCommits});
    assert.deepEqual(hostErrors, [], '本地协议端点必须完整执行，不能靠替身异常通过');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

async function check(name, test) {
  const evidence = {name, passed: false};
  try { await test(evidence); evidence.passed = true; }
  catch (error) { evidence.error = error.stack; }
  checks.push(evidence);
}

await check('实际HTTP新调用完整交付原回执，重复调用不重复提交业务', async evidence => {
  await withHost(async f => {
    validations.clear();
    const result = await f.execute();
    const counts = Object.fromEntries(validations);
    assert.deepEqual(result, {content: [{type: 'text', text: JSON.stringify({
      status_note: '查询已取消，不能当作完成结果。', ...data,
    })}], details: receipt, isError: false});
    assert.deepEqual(f.accepted, [{receipt, sdkId: 'current'}]);
    assert.deepEqual(f.requests, ['/internal/data/tool-calls', '/internal/data/tools']);
    assert.deepEqual(f.received[0], f.received[1], '同一SDK调用保持参数、检查点和身份');
    assert.deepEqual(f.received[0].arguments, args);
    assert.equal(f.received[0].run_id, 'run');
    assert.equal(f.received[0].lease_epoch, '1');
    assert.equal(f.received[0].sdk_tool_call_id, 'current');
    assert.equal(f.commits(), 1);
    assert.deepEqual(await f.state.invokeRecorded('cancel_query', 'current', args), receipt);
    assert.equal(f.commits(), 1);
    assert.deepEqual(f.accepted, [{receipt, sdkId: 'current'}, {receipt, sdkId: 'current'}]);
    assert.deepEqual(f.requests, ['/internal/data/tool-calls', '/internal/data/tools',
      '/internal/data/tool-calls', '/internal/data/tools']);
    if (diagnose) {
      evidence.validationDiagnostic = {beforeReplay: counts,
        expected: {DataToolInvocation: 2, OperationReceipt: 1, DataToolOutcome: 1, ReadQueryInput: 1}};
      assert.equal(counts.DataToolInvocation, 2, '每次实际HTTP发送各校验信封一次');
      assert.equal(counts.OperationReceipt, 1, '原登记回执及版本仅在transport接收边界校验一次');
      assert.equal(counts.DataToolOutcome, 1, '实际HTTP响应仅在transport接收边界校验一次');
      assert.equal(counts.ReadQueryInput, 1, '新调用仍独立校验工具参数');
    }
  });
});

await check('传输边界拒绝错误信封，当前坏新参数不能进入业务', async () => {
  await withHost(async f => {
    await assert.rejects(() => f.transport.post('/internal/data/tool-calls', 'DataToolInvocation',
      {...f.input(), lease_epoch: 'invalid'}), {message: 'invalid_input: DataToolInvocation'});
    await assert.rejects(() => f.execute('bad-new', {}), {message: 'invalid_input: ReadQueryInput'});
    assert.deepEqual(f.requests, []);
    assert.equal(f.commits(), 0);
    assert.equal(f.ledger.size, 0);
    assert.deepEqual(f.accepted, []);
  });
});

await check('未登记坏参数先查原账本，Rust拒绝后不能登记或执行新调用', async () => {
  await withHost(async f => {
    await assert.rejects(() => f.state.invokeRecorded('cancel_query', 'new-invalid', legacyArgs), {message: 'invalid_tool_arguments'});
    assert.deepEqual(f.requests, ['/internal/data/tool-calls']);
    assert.deepEqual(f.received[0].arguments, legacyArgs);
    assert.equal(f.ledger.size, 0);
    assert.equal(f.commits(), 0);
    assert.deepEqual(f.accepted, []);
  });
});

await check('旧成功回执先接原账本，不受当前参数Schema阻断且不重复提交', async () => {
  const entry = {id: 'legacy', signature: signature({tool_name: 'cancel_query', arguments: legacyArgs}),
    operation_id: 'operation-legacy', state: 'succeeded', receipt: legacyReceipt};
  await withHost(async f => {
    assert.throws(() => f.state.validateArguments('cancel_query', legacyArgs), {message: 'invalid_input: ReadQueryInput'});
    for (let i = 0; i < 2; i++) assert.deepEqual(await f.state.invokeRecorded('cancel_query', 'legacy', legacyArgs), legacyReceipt);
    assert.deepEqual(f.requests, ['/internal/data/tool-calls', '/internal/data/tools',
      '/internal/data/tool-calls', '/internal/data/tools']);
    assert.ok(f.received.every(input => input.sdk_tool_call_id === 'legacy' && JSON.stringify(input.arguments) === JSON.stringify(legacyArgs)));
    assert.deepEqual(f.accepted, [{receipt: legacyReceipt, sdkId: 'legacy'}, {receipt: legacyReceipt, sdkId: 'legacy'}]);
    assert.equal(f.commits(), 0);
    assert.equal(f.ledger.size, 1);
  }, {recorded: [entry]});
});

await check('旧登记没有回执或参数指纹冲突时保留明确错误，不换ID重做', async () => {
  const entry = {id: 'legacy', signature: signature({tool_name: 'cancel_query', arguments: legacyArgs}), operation_id: 'operation-legacy'};
  await withHost(async f => {
    await assert.rejects(() => f.state.invokeRecorded('cancel_query', 'legacy', legacyArgs), {message: 'outcome_unknown'});
    await assert.rejects(() => f.state.invokeRecorded('cancel_query', 'legacy', {...legacyArgs, query_id: 'different'}), {message: 'idempotency_conflict'});
    assert.deepEqual(f.requests, ['/internal/data/tool-calls', '/internal/data/tool-calls']);
    assert.equal(f.commits(), 0);
    assert.equal(f.ledger.size, 1);
    assert.deepEqual(f.accepted, []);
  }, {recorded: [entry]});
});

await check('明确拒绝从原回执接回且工具仍报错，恢复重试不新增业务提交', async () => {
  const rejected = {...receipt, data: {error: 'forbidden', outcome: 'rejected', query_id: 'query'}};
  await withHost(async f => {
    assert.deepEqual(await f.execute(), {
      content: [{type: 'text', text: JSON.stringify(rejected.data)}], details: rejected, isError: true,
    });
    assert.deepEqual(f.accepted, [{receipt: rejected, sdkId: 'current'}]);
    assert.deepEqual(f.requests, ['/internal/data/tool-calls', '/internal/data/tools', '/internal/data/tool-rejections']);
    assert.deepEqual(await f.state.invokeRecorded('cancel_query', 'current', args), rejected);
    assert.deepEqual(await f.state.formatResult('cancel_query', args, rejected), {
      content: [{type: 'text', text: JSON.stringify(rejected.data)}], details: rejected, isError: true,
    });
    assert.deepEqual(f.accepted, [{receipt: rejected, sdkId: 'current'}, {receipt: rejected, sdkId: 'current'}]);
    assert.equal(f.commits(), 0);
    assert.equal(f.ledger.size, 1);
  }, {rejection: 'forbidden'});
});

await check('旧拒绝回执同样先查账本，当前坏新参数不破坏既有拒绝事实', async () => {
  const rejected = {...legacyReceipt, data: {error: 'invalid_evidence', outcome: 'rejected', query_id: 'query'}};
  const entry = {id: 'legacy-rejected', signature: signature({tool_name: 'cancel_query', arguments: legacyArgs}),
    operation_id: 'operation-legacy', state: 'rejected', receipt: rejected};
  await withHost(async f => {
    assert.deepEqual(await f.state.invokeRecorded('cancel_query', 'legacy-rejected', legacyArgs), rejected);
    assert.equal((await f.state.formatResult('cancel_query', legacyArgs, rejected)).isError, true);
    assert.deepEqual(f.requests, ['/internal/data/tool-calls', '/internal/data/tools']);
    assert.deepEqual(f.accepted, [{receipt: rejected, sdkId: 'legacy-rejected'}]);
    assert.equal(f.commits(), 0);
  }, {recorded: [entry]});
});

await check('错误响应形状和截断JSON在接收边界拒绝，不交付伪成功', async () => {
  for (const [options, error] of [
    [{outcome: {...receipt, data: []}}, {message: 'invalid_input: DataToolOutcome'}],
    [{outcome: {operation_id: 'operation-current'}}, {message: 'invalid_input: DataToolOutcome'}],
    [{invalidError: true}, {message: 'invalid_input: AppError'}],
    [{invalidJson: true}, SyntaxError],
  ]) await withHost(async f => {
    await assert.rejects(() => f.execute(), error);
    assert.deepEqual(f.requests, ['/internal/data/tool-calls', '/internal/data/tools', '/internal/data/tool-rejections']);
    assert.deepEqual(f.accepted, []);
  }, options);
});

await check('原tool版本在实际HTTP接收边界只校验一次，历史结果补足不再校验Schema', async evidence => {
  const operation = {operation_id: 'operation-current', tool_contract_version: 2};
  await withHost(async f => {
    validations.clear();
    const result = await f.execute();
    const expected = {...receipt, tool_contract_version: 2};
    assert.deepEqual(result.details, expected);
    assert.deepEqual(f.accepted, [{receipt: expected, sdkId: 'current'}]);
    assert.equal(f.commits(), 1);
    assert.deepEqual(f.requests, ['/internal/data/tool-calls', '/internal/data/tools']);
    if (diagnose) {
      evidence.validationDiagnostic = Object.fromEntries(validations);
      assert.equal(validations.get('OperationReceipt'), 1);
      assert.equal(validations.get('DataToolOutcome'), 1);
      assert.equal(validations.get('DataToolInvocation'), 2);
      assert.equal(validations.get('ReadQueryInput'), 1);
    }
  }, {operationReceipt: operation});
});

await check('登记回执非法版本在接收边界拒绝，业务工具不能执行', async () => {
  for (const version of [0, 3, '2', null]) await withHost(async f => {
    await assert.rejects(() => f.execute(), {message: 'invalid_input: OperationReceipt'});
    assert.deepEqual(f.requests, ['/internal/data/tool-calls']);
    assert.equal(f.commits(), 0);
    assert.deepEqual(f.accepted, []);
  }, {operationReceipt: {operation_id: 'operation-current', tool_contract_version: version}});
});

await check('成功结果非法版本在接收边界拒绝，不交付伪成功', async () => {
  for (const version of [0, 3, '2', null]) await withHost(async f => {
    await assert.rejects(() => f.execute(), {message: 'invalid_input: DataToolOutcome'});
    assert.deepEqual(f.requests, ['/internal/data/tool-calls', '/internal/data/tools', '/internal/data/tool-rejections']);
    assert.deepEqual(f.accepted, []);
  }, {outcome: {...receipt, tool_contract_version: version}});
});

await check('没有持久拒绝时保留原未知错误，失权不能接回旧成功回执', async () => {
  await withHost(async f => {
    await assert.rejects(() => f.execute(), {message: 'outcome_unknown'});
    assert.deepEqual(f.requests, ['/internal/data/tool-calls', '/internal/data/tools', '/internal/data/tool-rejections']);
    assert.deepEqual(f.accepted, []);
    assert.equal(f.commits(), 0);
  }, {executionError: 'outcome_unknown'});
  await withHost(async f => {
    await assert.rejects(() => f.state.invokeRecorded('cancel_query', 'legacy', legacyArgs), {message: 'lease_lost'});
    assert.deepEqual(f.requests, ['/internal/data/tool-calls']);
    assert.deepEqual(f.accepted, []);
    assert.equal(f.commits(), 0);
  }, {registrationError: 'lease_lost', recorded: [{id: 'legacy',
    signature: signature({tool_name: 'cancel_query', arguments: legacyArgs}),
    operation_id: 'operation-legacy', state: 'succeeded', receipt: legacyReceipt}]});
});

const sourceHashes = {};
for (const path of ['apps/agent/transport/client.ts', 'apps/agent/tools/data-tools.ts',
  'tests/runtime/check-data-tool-transport.mjs', 'packages/contracts/schema.json', 'packages/contracts/generated/boundary.ts'])
  sourceHashes[path] = createHash('sha256').update(await readFile(new URL('../../' + path, import.meta.url))).digest('hex');
const passed = checks.every(check => check.passed);
const report = {passed, node: process.versions.node, boundary: 'real RustTransport/dataTools and local HTTP protocol endpoint',
  diagnoseValidation: diagnose, officialRequests: 0, databaseUsed: false, sourceHashes, checks};
await mkdir('.local/checks', {recursive: true});
await writeFile('.local/checks/data-tool-transport.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
assert.ok(passed, 'Node数据工具传输边界检查未全部通过');

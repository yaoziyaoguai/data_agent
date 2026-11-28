import assert from 'node:assert/strict';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {exportCheckpoint} from '../../apps/agent/session/checkpoint.ts';
import {harness, until} from './harness.mjs';
import {embeddingProvider} from './embedding-provider.mjs';

// 05切片4反例：10秒期限覆盖取得正文的全过程，通道次序沿现有harness代理的时间戳
// 记录，不加产品遥测。
// - 慢嵌入：词法正文在嵌入完成前已读（MySQL字节时间戳早于嵌入完成时刻），最终
//   共同排名交付；dense请求晚于嵌入完成（嵌入就绪后才执行dense）。
// - 嵌入超期：词法已读内容照常交付，如实bounded（dense按期限停轮），账本按三时点
//   unknown收尾、无issued残留、无重复发送。
// - BM25慢、dense快：dense请求完成早于词法完成（互不阻塞）。
// - 词法预读消耗30内容名额，dense随后带来更高排名新项：共用上限不绕过，有界已读
//   子集如实bounded，已读项复用交付。
const auditOnly = process.argv.includes('--audit-only');
const SLOW_MS = 4000;
const OVER_MS = 15000;
const NEEDLE = 'deadlineneedle';
const P1_TERM = '期限次序探针';
const SHARED = '珍稀凭据校准令牌锚点备注字节特征';
const Q_TERM = '独家';
const WORK_MS = 10000;
const SCOPE_MS = 8000;
const CLEANUP_MS = 3000;
const CROSS_MS = WORK_MS + 2000;
const PAIR_TERM = '时限双读合成校验';
const PAIR_A = 'deadline-pair-a';
const PAIR_B = 'deadline-pair-b';
const PAIR_MARKERS = {[PAIR_A]: 'deadlinebodyalpha', [PAIR_B]: 'deadlinebodybravo'};
const pairScope = {kinds: ['document'], related_object_id: PAIR_A};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const entry = (entryId, text) => ({
  entry_id: entryId, path: entryId, label: '正文', effective_value: text,
  source_facts: {complete: false, gap: '独立合成期限夹具'}, suggestion: {},
  human_override: null, review_state: 'unverified',
});
const body = (id, kind, name, entries) => ({
  id, kind, name, version: '1', state: 'enabled', entries, related_ids: [],
  source_id: null, source_version: '0', updated_by: 'synthetic-test',
});
const insert = (h, value) => {
  const encoded = Buffer.from(JSON.stringify(value)).toString('hex');
  h.sql(`INSERT INTO knowledge_objects(id,space_id,kind,name,version,state,body,source_id,source_version,updated_by)
    VALUES('${value.id}','demo','${value.kind}','${value.name}',1,'enabled',CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON),NULL,0,'synthetic-test');
    INSERT INTO knowledge_revisions(object_id,version,archived_body) VALUES('${value.id}',1,CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON));
    INSERT INTO retrieval_documents(object_id,space_id,version,body) VALUES('${value.id}','demo',1,CAST(CONVERT(0x${encoded} USING utf8mb4) AS JSON));
    INSERT IGNORE INTO semantic_ownership(space_id,object_id,authority_id,source,updated_by) VALUES('demo','${value.id}','${value.id}','system','synthetic-test')`);
};

// 次序证据代理：Milvus保持真实透传，只记录通道及合成夹具身份，不记录认证头。
const milvusEvents = [];
const vectorStarts = [];
let lexicalDelayMs = 0;
let phase = 'setup';
const vectorProxy = createServer(async (req, res) => {
  try {
    const requestPhase = phase;
    const started = Date.now();
    let raw = '';
    req.setEncoding('utf8');
    for await (const part of req) raw += part;
    const kind = raw.includes('"annsField":"sparse"')
      ? 'lexical'
      : raw.includes('"annsField":"vector"')
        ? 'dense'
        : 'other';
    vectorStarts.push({phase: requestPhase, kind, action: req.url.endsWith('/collections/describe') ? 'index-target' : kind, started});
    if (kind === 'lexical' && lexicalDelayMs) await new Promise(r => setTimeout(r, lexicalDelayMs));
    const remote = await fetch('http://127.0.0.1:19531' + req.url, {
      method: 'POST', headers: {'content-type': 'application/json', authorization: req.headers.authorization}, body: raw});
    const result = await remote.text();
    const parsed = JSON.parse(result);
    const rows = Array.isArray(parsed.data) ? parsed.data.flat() : [];
    milvusEvents.push({phase: requestPhase, kind, started, done: Date.now(), status: remote.status,
      code: parsed.code, fixtureIds: [...new Set(rows.map(row => row.object_id).filter(id => id === PAIR_A || id === PAIR_B))]});
    res.writeHead(remote.status, {'content-type': 'application/json'}); res.end(result);
  } catch {
    res.writeHead(503, {'content-type': 'application/json'}); res.end('{"code":1}');
  }
});
await new Promise(resolve => vectorProxy.listen(0, '127.0.0.1', resolve));

const mysqlChunks = [];
const sqlEvents = [];
const proxyErrors = [];
const sockets = new Set();
const pendingDelays = new Set();
let activeCall;
let scopeDelayMs = 0;
let anchorDelayMs = 0;
let metaDelayMs = 0;
let bodyDelayMs = 0;
let bodyError = false;
let permitCommitDelayMs = 0;
let coverageDelayMs = 0;
let connectionId = 0;
const sqlBoundary = query => {
  const sql = query.replace(/\s+/g, ' ').trim();
  if (sql.startsWith('SELECT id,version FROM knowledge_objects WHERE space_id=')) return 'scope';
  if (sql.startsWith('UPDATE model_trials SET allocated_calls=allocated_calls+1,reserved_micros=reserved_micros+')) return 'permit';
  if (sql.startsWith('SELECT * FROM model_call_attempts WHERE id=') && sql.endsWith('FOR UPDATE')) return 'settlement';
  if (sql.startsWith('SELECT state,') && sql.includes('JSON_LENGTH(JSON_EXTRACT(body,\'$.entries[*].effective_value\')) AS effective')) return 'anchor';
  // 候选元信息SQL带别名k.与hints存在性计分（related_object_ids仅排序）；
  // 旧无别名前缀已不匹配。
  if (sql.startsWith('SELECT k.id,k.name,k.version,k.state,k.kind,k.source_id,k.source_version')) return 'meta';
  if (sql.startsWith('SELECT COUNT(*) FROM knowledge_objects k LEFT JOIN knowledge_index_jobs j')) return 'coverage';
  // owner正文读取SQL随同修订current改造演进（knowledge_versions JOIN →
  // knowledge_objects当前body）；以content_page标记识别，排除仅entry/base/chars的映射查询。
  if (sql.startsWith("SELECT JSON_OBJECT('entry_id'") && sql.includes("'content_page'")) return 'body';
  if (sql.startsWith("SELECT JSON_UNQUOTE(JSON_EXTRACT(body,'$.id')) AS object_id,")
      && sql.includes(' AS object_version, state FROM knowledge_objects')) return 'fresh';
};
// 只拆MySQL帧和prepare→execute身份；参数仍原样透传，证据仅保留已知合成对象ID。
const frames = consume => {
  let pending = Buffer.alloc(0);
  return chunk => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4) {
      const bytes = pending.readUIntLE(0, 3) + 4;
      if (pending.length < bytes) break;
      const frame = pending.subarray(0, bytes);
      pending = pending.subarray(bytes);
      consume(frame, frame.subarray(4));
    }
  };
};
const sqlProxy = net.createServer(sock => {
  const connection = ++connectionId;
  const remote = net.connect(13306, '127.0.0.1');
  sock.on('error', () => {});
  remote.on('error', () => {});
  sockets.add(sock); sockets.add(remote);
  let authenticated = false;
  let clientHello = false;
  let deprecateEof = false;
  let preparing;
  let current;
  let response;
  let permitOperation;
  let heldUntil = 0;
  let delivery = Promise.resolve();
  const statements = new Map();
  const deliver = frame => {
    mysqlChunks.push({t: Date.now(), bytes: frame.length});
    sock.write(frame);
  };
  sock.on('close', () => { remote.destroy(); sockets.delete(sock); });
  remote.on('close', () => { sock.destroy(); sockets.delete(remote); });
  const clientFrames = frames((frame, payload) => {
    if (!authenticated) {
      if (!clientHello && payload.length >= 4) {
        clientHello = true;
        const flags = payload.readUInt32LE(0);
        deprecateEof = !!(flags & 0x01000000);
        if (flags & 0x0800) proxyErrors.push('协议观测连接意外启用TLS');
      }
      remote.write(frame);
      return;
    }
    if (payload[0] === 0x16) {
      // COM_STMT_PREPARE没有参数；不把完整SQL写入观测文件。
      preparing = {boundary: sqlBoundary(payload.subarray(1).toString())};
      current = undefined;
    } else if (payload[0] === 0x19) {
      statements.delete(payload.readUInt32LE(1));
    } else if (payload[0] === 0x17 || payload[0] === 0x03) {
      let boundary = payload[0] === 0x17
        ? statements.get(payload.readUInt32LE(1))?.boundary
        : sqlBoundary(payload.subarray(1).toString());
      const committing = payload[0] === 0x03 && /^\s*COMMIT\s*$/i.test(payload.subarray(1).toString());
      if (boundary === 'permit') permitOperation = activeCall?.operation;
      if (committing && permitOperation === activeCall?.operation && permitOperation) {
        boundary = 'permit-commit';
        permitOperation = undefined;
      }
      current = undefined;
      response = undefined;
      const call = activeCall;
      if (boundary && call) {
        const ids = [PAIR_A, PAIR_B].filter(id => payload.includes(Buffer.from(id)));
        current = {connection, phase: call.phase, operation: call.operation, boundary, ids, started: Date.now()};
        sqlEvents.push(current);
        if (boundary === 'settlement' && call.phase === 'settlement-storage-fails' && call.issued?.[0]
            && payload.includes(Buffer.from(call.issued[0].i)) && !call.settlementFailed) {
          call.settlementFailed = true;
          current.attempt = call.issued[0].i;
          current.error = 'connection_closed';
          current.errorAt = Date.now();
          sock.destroy(); remote.destroy();
          return;
        }
        const candidatesReady = milvusEvents.some(event => event.phase === call.phase && event.done >= call.started
          && event.fixtureIds.length > 0 && event.status === 200 && event.code === 0);
        let wait = 0;
        if (boundary === 'scope' && scopeDelayMs && !call.scopeHeld) {
          call.scopeHeld = true;
          wait = scopeDelayMs;
        } else if (boundary === 'permit-commit' && permitCommitDelayMs && !call.permitHeld) {
          call.permitHeld = true;
          wait = permitCommitDelayMs;
        } else if (boundary === 'anchor' && anchorDelayMs && !call.anchorHeld) {
          call.anchorHeld = true;
          wait = anchorDelayMs;
        } else if (boundary === 'coverage' && coverageDelayMs && !call.coverageHeld) {
          call.coverageHeld = true;
          wait = coverageDelayMs;
        } else if (boundary === 'meta' && metaDelayMs && candidatesReady && !call.metaHeld) {
          call.metaHeld = true;
          wait = metaDelayMs;
        } else if (boundary === 'body' && ids.includes(PAIR_B) && bodyDelayMs && !call.bodyHeld) {
          call.bodyHeld = true;
          wait = bodyDelayMs;
        }
        if (wait) {
          current.delayMs = wait;
          current.releaseAt = current.started + wait;
          heldUntil = current.releaseAt;
          if (boundary === 'body' && bodyError) {
            // 仅断开本次读取连接；其他连接仍可结算原Embedding和保存拒绝回执。
            const event = current;
            event.error = 'connection_closed';
            const timer = setTimeout(() => {
              pendingDelays.delete(timer);
              event.errorAt = Date.now();
              sock.destroy(); remote.destroy();
            }, wait);
            pendingDelays.add(timer);
            return;
          }
        }
      }
    }
    remote.write(frame);
  });
  const serverFrames = frames((frame, payload) => {
    if (!authenticated) {
      if (clientHello && payload[0] === 0x00) authenticated = true;
      deliver(frame);
      return;
    }
    if (preparing && frame[3] === 1) {
      if (payload[0] === 0x00) statements.set(payload.readUInt32LE(1), preparing);
      preparing = undefined;
    }
    let completed;
    if (current) {
      let terminal = payload[0] === 0xff;
      if (!response) {
        terminal ||= payload[0] === 0x00;
        if (!terminal) {
          assert.ok(payload[0] < 0xfb, '观测查询的列数必须是单字节');
          response = {columns: payload[0], afterColumns: true};
        }
      } else if (response.columns > 0) {
        response.columns -= 1;
      } else if (payload[0] === 0xfe) {
        if (!deprecateEof && response.afterColumns) response.afterColumns = false;
        else terminal = true;
      }
      if (terminal) {
        completed = current;
        completed.upstreamDone = Date.now();
        current = undefined;
        response = undefined;
      }
    }
    const releaseAt = heldUntil;
    heldUntil = 0;
    // 每连接串行交付，跨包延迟不能让后续EOF或ROLLBACK响应抢在被延迟正文前面。
    delivery = delivery.then(async () => {
      if (releaseAt > Date.now()) await new Promise(resolve => {
        const timer = setTimeout(() => { pendingDelays.delete(timer); resolve(); }, releaseAt - Date.now());
        pendingDelays.add(timer);
      });
      if (!sock.destroyed) {
        deliver(frame);
        if (completed) completed.delivered = Date.now();
      }
    }).catch(error => { proxyErrors.push(error.message); sock.destroy(); remote.destroy(); });
  });
  sock.on('data', chunk => {
    try { clientFrames(chunk); } catch (error) { proxyErrors.push(error.message); sock.destroy(); remote.destroy(); }
  });
  remote.on('data', chunk => {
    try { serverFrames(chunk); } catch (error) { proxyErrors.push(error.message); sock.destroy(); remote.destroy(); }
  });
});
await new Promise(resolve => sqlProxy.listen(0, '127.0.0.1', resolve));
const bytesUntil = t => mysqlChunks.filter(c => c.t <= t).reduce((sum, c) => sum + c.bytes, 0);

const provider = await embeddingProvider();
const embedArrivals = [];
let settlementLock;
let settlementReleasedAt;
provider.onRequest(async requestBody => {
  const call = activeCall;
  if (call) {
    call.issued = attemptsFor(call.operation);
    assert.equal(call.issued.length, 1, '发送时须已登记本次原attempt');
    assert.equal(call.issued[0].s, 'issued');
    assert.equal(call.issued[0].scope, run.budget_scope_id);
  }
  embedArrivals.push({t: Date.now(), phase, operation: call?.operation, attempt: call?.issued[0].i,
    input: requestBody.input});
  if (!['settlement-held', 'read-error-settlement-held'].includes(phase)) return;
  assert.ok(call?.issued[0], '结算锁必须绑定本次实际已发attempt');
  settlementReleasedAt = undefined;
  call.settlement = {attempt: call.issued[0].i};
  const database = new URL(h.env.DATA_AGENT_DATABASE_URL).pathname.slice(1);
  assert.match(database, /^data_agent_test_[a-f0-9]+$/);
  const dockerContext = process.env.DATA_AGENT_DOCKER_CONTEXT || (process.platform === 'darwin' ? 'colima-data-agent' : 'default');
  const child = spawn('docker', ['--context', dockerContext, 'exec', 'data-agent-mysql-1',
    'mysql', '--defaults-extra-file=/run/secrets/mysql_root_client', '--batch', '--unbuffered',
    '--skip-column-names', '-e', `USE ${database}; SET SESSION innodb_lock_wait_timeout=5; START TRANSACTION;
    SELECT id FROM model_call_attempts WHERE id='${call.issued[0].i}' AND operation_id='${call.operation}'
      AND purpose='knowledge_embedding' AND state='issued' FOR UPDATE;
    SELECT 'settlement-held'; DO SLEEP(12); COMMIT;`], {stdio: ['ignore', 'pipe', 'pipe']});
  settlementLock = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => {
      settlementReleasedAt = Date.now();
      call.settlement.released = settlementReleasedAt;
      if (code === 0) resolve(); else reject(new Error('隔离库结算锁子进程失败：' + code));
    });
  });
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('取得本次结算锁超时')), 5000);
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (output.includes('settlement-held')) {
        clearTimeout(timer);
        call.settlement.held = Date.now();
        resolve();
      }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (!output.includes('settlement-held')) reject(new Error('未取得结算锁：' + code));
    });
  });
});

const checks = [];
const observations = {calls: []};
let passed = false;
let h;
let run;
const manager = SessionManager.inMemory('/synthetic/data-agent');
const attemptsFor = operation => h.sql(`SELECT JSON_OBJECT('i',id,'s',state,'operation',operation_id,
  'scope',budget_scope_id,'usage',usage_json,'cached',response_json IS NOT NULL) AS v
  FROM model_call_attempts WHERE purpose='knowledge_embedding' AND operation_id='${operation}'`);
const invoke = async (query, limit, scope = {}) => {
  const input = {run_id: run.run_id, lease_epoch: run.lease_epoch, sdk_tool_call_id: randomUUID(),
    tool_name: 'search_knowledge', arguments: {query, limit, ...scope},
    checkpoint: exportCheckpoint(manager, run.workspace_context.authority_revision, run.workspace_context.authority_snapshot)};
  const registration = await h.internal('/internal/data/tool-calls', input);
  assert.equal(registration.status, 200, JSON.stringify(registration.value));
  assert.equal(typeof registration.value.operation_id, 'string');
  const operation = registration.value.operation_id;
  assert.match(operation, /^[a-f0-9-]+$/);
  const call = {phase, operation, started: Date.now(), sendsBefore: provider.requests.length};
  activeCall = call;
  observations.calls.push(call);
  const response = await h.internal('/internal/data/tools', input);
  call.returned = Date.now();
  call.status = response.status;
  activeCall = undefined;
  // 响应后的第一次读取就是断言边界，不轮询、不等待后台状态改善。
  const tools = h.sql(`SELECT JSON_OBJECT('operation',t.operation_id,'sdk',t.sdk_tool_call_id,'origin',t.origin_run_id,
    'state',t.state,'receipt',t.receipt,'attempts',(SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(
      'i',a.id,'s',a.state,'operation',a.operation_id,'scope',a.budget_scope_id,'usage',a.usage_json,
      'cached',a.response_json IS NOT NULL)),JSON_ARRAY()) FROM model_call_attempts a
      WHERE a.purpose='knowledge_embedding' AND a.operation_id=t.operation_id))
    FROM tool_calls t WHERE t.operation_id='${operation}'`);
  assert.equal(tools.length, 1);
  const {attempts, ...tool} = tools[0];
  call.attempts = attempts;
  call.tool = tool;
  call.sent = provider.requests.length - call.sendsBefore;
  assert.equal(call.tool.operation, operation);
  assert.equal(call.tool.sdk, input.sdk_tool_call_id);
  assert.equal(call.tool.origin, run.run_id);
  if (call.issued) {
    assert.equal(call.sent, 1, '本次原查询Embedding只发送一次');
    assert.equal(call.attempts.length, 1, '响应时必须保留唯一原attempt');
    assert.equal(call.attempts[0].i, call.issued[0].i, '不能换attempt收尾');
    assert.equal(call.attempts[0].operation, operation, '不能换operation收尾');
    assert.equal(call.attempts[0].scope, run.budget_scope_id);
    if (call.settlementFailed) {
      assert.equal(call.phase, 'settlement-storage-fails');
      assert.equal(response.status, 503, '结算存储失败必须明确报错');
      assert.deepEqual(call.attempts, call.issued, '无法写结算时保留原issued与未知用量，不猜零消耗');
    } else {
      assert.notEqual(call.attempts[0].s, 'issued', '响应时原attempt已收尾');
    }
  } else {
    assert.equal(call.sent, 0, '没有实际发送时不能误记本次Embedding');
  }
  if (response.status === 200) {
    assert.equal(response.value.operation_id, operation);
    assert.equal(call.tool.state, 'succeeded');
    assert.deepEqual(call.tool.receipt, response.value, '正式最终核验后的持久回执须与响应相同');
  }
  assert.deepEqual(proxyErrors, [], '协议观测必须完整：' + JSON.stringify(proxyErrors));
  return {call, response, input};
};
const search = async (query, limit, scope = {}) => {
  const {response} = await invoke(query, limit, scope);
  assert.equal(response.status, 200, JSON.stringify(response.value));
  return response.value.data;
};
const embeddingAttempts = () =>
  h.sql("SELECT JSON_OBJECT('i',id,'s',state,'operation',operation_id,'scope',budget_scope_id) AS v FROM model_call_attempts WHERE purpose='knowledge_embedding'");
const knownAttempts = () => new Set(embeddingAttempts().map(row => row.i));
// 工具返回本身就是收尾边界，不能在响应后轮询掩盖后台结算。
const settledAtReturn = known => {
  const fresh = embeddingAttempts().filter(row => !known.has(row.i));
  assert.ok(fresh.length && fresh.every(row => row.s !== 'issued'),
    '调用返回前必须等待账本收尾：' + JSON.stringify(fresh));
  return fresh;
};
const callSql = (call, boundary) => sqlEvents.filter(event => event.operation === call.operation
  && (!boundary || event.boundary === boundary));
const heldSql = (call, boundary) => {
  const events = callSql(call, boundary).filter(event => event.delayMs);
  assert.equal(events.length, 1, '必须恰好延迟本次独立' + boundary + '边界：' + JSON.stringify(events));
  return events[0];
};
const assertDelivered = (call, event) => {
  assert.ok(event.upstreamDone && event.delivered, '须观测到真实SQL结果完整返回：' + JSON.stringify(event));
  assert.ok(event.delivered >= event.started + event.delayMs, '实际延迟不能短于设置值');
  assert.ok(event.delivered <= call.returned, '响应前须接回本次读取及sqlx清理');
};
const assertDeadlineExit = (call, scope) => {
  assert.ok(scope?.delivered, '必须先观测到本次范围准备');
  const deadline = scope.started + WORK_MS;
  // SQL开始晚于工具内期限建立，因此这是对原期限的宽松上界，清理另留3秒。
  assert.ok(call.returned >= deadline - 500, '必须实际触及原10秒期限');
  assert.ok(call.returned <= deadline + CLEANUP_MS, '期限出口须有界完成：' + JSON.stringify(call));
  return deadline;
};
const assertOriginalDeadline = (call, scope) => {
  assert.equal(scope.delayMs, SCOPE_MS);
  assertDelivered(call, scope);
  assert.ok(scope.delivered - scope.started >= 7800 && scope.delivered - scope.started < 9000,
    '范围准备必须实际消耗约8秒：' + JSON.stringify(scope));
  const deadline = assertDeadlineExit(call, scope);
  assert.ok(call.returned - scope.delivered < 4500, '范围准备8秒后只余约2秒及有界清理');
  return deadline;
};
const assertHeldAcrossDeadline = (call, event, deadline, expectedDelayMs = CROSS_MS) => {
  assert.equal(event.delayMs, expectedDelayMs);
  assert.ok(event.started < deadline && event.releaseAt > deadline, '独立读取须在期内启动、延迟释放跨期');
  assert.ok(event.upstreamDone, '独立延迟须匹配真实SQL结果');
  // sqlx允许取消只读future并回收/丢弃连接；不要求为测试强等迟到结果。
  if (event.delivered) assert.ok(event.delivered > deadline, '已透传的迟到结果必须确实跨过原期限');
  assert.ok(call.returned >= deadline - 500, '未取得完整延迟结果时也必须已触及原期限');
};
const assertFreshBeforeReceipt = (call, ids) => {
  assert.ok(callSql(call, 'fresh').some(event => event.delivered && event.delivered <= call.returned
    && ids.every(id => event.ids.includes(id))), '实际交付正文必须经原最终版本重核');
};
const assertOriginalUnknown = call => {
  assert.ok(call.issued, '本次查询Embedding必须已真实发送');
  assert.equal(call.attempts.length, 1);
  assert.equal(call.attempts[0].s, 'unknown', '本次超期原attempt按unknown收尾');
  assert.equal(call.attempts[0].cached, false, 'unknown不能伪造成功向量回执');
};

try {
  const collection = 'da_deadline_' + randomUUID().replaceAll('-', '');
  h = await harness({capture: true, startWorker: false,
    onDatabaseUrl: value => {
      const url = new URL(value.replace('@127.0.0.1:13306/', '@127.0.0.1:' + sqlProxy.address().port + '/'));
      url.searchParams.set('ssl-mode', 'DISABLED');
      return url.toString();
    },
    profile: {provider_id: 'deepseek', model_id: 'deepseek-flash',
      trial_id: 'models_deadline_' + randomUUID().replaceAll('-', '').slice(16), price_version: '2026-10-04-peak-usd',
      input_limit: 65536, output_limit: 8192, request_call_limit: 24, toolset: 'data',
      payload_bytes_limit: 131072, thinking_level: 'off', budget_mode: 'request'},
    env: {...provider.env, DATA_AGENT_LEASE_MS: '120000',
      DATA_AGENT_VECTOR_URL: 'http://127.0.0.1:' + vectorProxy.address().port,
      DATA_AGENT_VECTOR_COLLECTION: collection,
      DATA_AGENT_VECTOR_TOKEN_FILE: process.cwd() + '/.local/infra/milvus-root-password'}});

  // 夹具：唯一期限探针对象（大正文条目供字节次序取证）+ 阶段四的R/Q梯度 + 稀缺度填充。
  const needleEntry = P1_TERM + ' 正文标记 ' + NEEDLE + '。' + '例行说明段落，不含任何检索词，仅用于扩大条目体积以取得字节次序证据。'.repeat(80);
  const fixtures = [
    body('deadline-needle', 'document', '期限次序探针对象', [entry('body', needleEntry)]),
    ...Array.from({length: 30}, (_, i) =>
      body('quota-r-' + String(i).padStart(2, '0'), 'document', '词法梯度资料' + i,
        [entry('body', (SHARED + '。').repeat(30))])),
    ...Array.from({length: 6}, (_, i) =>
      body('quota-q-' + String(i).padStart(2, '0'), 'document', '语义梯度资料' + i,
        [entry('body', SHARED + ' ' + Q_TERM + '。')])),
    ...Array.from({length: 200}, (_, i) =>
      body('quota-filler-' + String(i).padStart(3, '0'), 'document', '稀缺度填充' + i,
        [entry('body', '无关填充内容第' + i + '段，不含检索词。' + ('辅助文字材料。').repeat(40))])),
  ];
  for (const value of fixtures) insert(h, value);
  await h.resumeWorker();
  assert.equal((await h.request('/knowledge-index/rebuilds', {operation_id: randomUUID()})).status, 200);
  const ids = fixtures.map(value => value.id);
  for (let i = 0; i < 300; i++) {
    const rows = h.sql(`SELECT JSON_OBJECT('k',COUNT(*),'v',SUM(vector_state='indexed')) AS s FROM knowledge_index_jobs WHERE object_id IN (${ids.map(id => `'${id}'`).join(',')})`);
    if (rows[0].k > 0 && rows[0].k === rows[0].v) break;
    if (i % 30 === 29) console.error('INDEX-STATE', JSON.stringify(rows));
    await new Promise(resolve => setTimeout(resolve, 2000));
    if (i === 299) throw new Error('期限夹具完成索引超时：' + JSON.stringify(rows));
  }
  run = await h.capture(await h.create(), '核对期限次序探针');
  await h.pauseWorker();
  // 停机时在途的非夹具目标嵌入（平台来源摘录等Index/RawIndex绑定，scope为空）
  // 按设计停在issued，待pair轮resumeWorker后由确定性重执收敛；后续场景的
  // 全局“无issued”断言以停机快照为界，场景自身账本仍逐条严格核对。
  const issuedAtPause = new Set(embeddingAttempts().filter(row => row.s === 'issued').map(row => row.i));

  // 词法超过工作期限时，期限前已经取得的dense正文仍必须交付。
  {
    phase = 'bm25-over-deadline';
    provider.setDelay(0);
    lexicalDelayMs = OVER_MS;
    const known = knownAttempts();
    const result = await search(P1_TERM, 5);
    lexicalDelayMs = 0;
    observations.bm25OverDeadline = {objects: result.objects.map(item => item.id), coverage: result.search_coverage};
    assert.ok(result.objects.some(item => item.id === 'deadline-needle'
      && item.entries.some(e => (e.effective_value || '').includes(NEEDLE))),
      '词法超期不能阻止已经就绪的dense回源交付：' + JSON.stringify(observations.bm25OverDeadline));
    assert.notEqual(result.search_coverage.state, 'complete');
    assert.ok(result.search_coverage.channels.lexical.shards >= 2, '慢词法需跨两片覆盖整个10秒期限');
    assert.equal(result.search_coverage.channels.lexical.uncovered, 'deadline');
    settledAtReturn(known);
    checks.push('词法超过10秒，dense已读正文仍交付，返回时账本已收尾');
  }

  // 账本锁跨过工作期限：HTTP必须等待原结算，不能返回后后台更新。
  {
    phase = 'settlement-held';
    provider.setDelay(OVER_MS);
    const known = knownAttempts();
    const result = await search(P1_TERM, 5);
    const returnedAt = Date.now();
    assert.ok(settlementReleasedAt && returnedAt >= settlementReleasedAt,
      '返回前必须等待被锁住的原Embedding结算');
    const fresh = settledAtReturn(known);
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0].s, 'unknown');
    assert.ok(result.objects.some(item => item.id === 'deadline-needle'));
    observations.settlement = {returnedAfterUnlock: true, state: fresh[0].s};
    checks.push('工作期限到后等待隔离库原账本锁释放，返回时已unknown收尾且保留词法正文');
  }

  if (!auditOnly) {
  // 阶段一：慢嵌入4秒。词法正文在嵌入完成前已读，最终共同排名交付，dense晚于嵌入完成。
  {
    phase = 'slow-embed';
    provider.setDelay(SLOW_MS);
    const baselineBytes = bytesUntil(Date.now());
    const sendsBefore = provider.requests.length;
    const known = knownAttempts();
    const started = performance.now();
    const result = await search(P1_TERM, 5);
    const elapsed = performance.now() - started;
    const arrival = embedArrivals.find(event => event.phase === phase);
    assert.ok(arrival, '查询嵌入必须真实发送');
    const embedDoneBy = arrival.t + SLOW_MS;
    const contentBeforeEmbed = bytesUntil(embedDoneBy - 1000) - baselineBytes;
    const dense = milvusEvents.filter(event => event.phase === phase && event.kind === 'dense');
    observations.slowEmbed = {elapsedMs: Math.round(elapsed), contentBeforeEmbed, denseRequests: dense.length,
      objects: result.objects.map(item => item.id), coverage: result.search_coverage};
    assert.ok(elapsed <= 10800, '期限覆盖全过程，响应≤10.8秒：' + elapsed);
    assert.ok(result.objects.some(item => item.id === 'deadline-needle'
      && item.entries.some(e => (e.effective_value || '').includes(NEEDLE))),
      '慢嵌入下词法正文仍须交付：' + JSON.stringify(result.objects.map(item => item.id)));
    assert.ok(contentBeforeEmbed > 8000,
      '词法正文须在嵌入完成前已读（字节次序证据）：' + contentBeforeEmbed);
    assert.ok(dense.length > 0 && dense.every(event => event.done > embedDoneBy - 500),
      'dense请求须在嵌入完成之后：' + JSON.stringify(dense));
    assert.equal(provider.requests.length - sendsBefore, 1, '查询嵌入只发送一次');
    const fresh = settledAtReturn(known);
    assert.equal(fresh.length, 1, '本次一条账本记录：' + JSON.stringify(fresh));
    assert.equal(fresh[0].s, 'settled', '期限内完成按实际结算：' + JSON.stringify(fresh));
    checks.push('阶段一（慢嵌入4秒）：期限前词法正文已读（嵌入完成前' + contentBeforeEmbed + 'B）并在共同排名中交付；dense在嵌入完成后执行；单次发送、实际结算');
  }

  // 阶段二：嵌入15秒超期。词法已读内容照常交付、如实bounded，账本unknown收尾无残留。
  {
    phase = 'over-deadline';
    provider.setDelay(OVER_MS);
    const sendsBefore = provider.requests.length;
    const known = knownAttempts();
    const started = performance.now();
    const result = await search(P1_TERM, 5);
    const elapsed = performance.now() - started;
    const dense = milvusEvents.filter(event => event.phase === phase && event.kind === 'dense');
    observations.overDeadline = {elapsedMs: Math.round(elapsed), denseRequests: dense.length,
      objects: result.objects.map(item => item.id), coverage: result.search_coverage};
    assert.ok(elapsed <= 10800, '到期交付已取得内容，响应≤10.8秒：' + elapsed);
    assert.ok(result.objects.some(item => item.id === 'deadline-needle'),
      '期限前已读内容必须交付：' + JSON.stringify(result.objects.map(item => item.id)));
    assert.equal(result.search_coverage.state, 'bounded',
      '到期未完成的检索不得冒充complete：' + JSON.stringify(result.search_coverage));
    assert.equal(result.search_coverage.channels.dense.uncovered, 'deadline',
      'dense按期限停轮如实表达：' + JSON.stringify(result.search_coverage.channels));
    assert.equal(dense.length, 0, '嵌入未就绪不得执行dense请求');
    assert.equal(provider.requests.length - sendsBefore, 1, '超期不重复发送嵌入');
    const fresh = settledAtReturn(known);
    assert.equal(fresh.length, 1, '本次一条账本记录：' + JSON.stringify(fresh));
    assert.equal(fresh[0].s, 'unknown', '已发送按剩余期限约束后unknown收尾：' + JSON.stringify(fresh));
    assert.ok(embeddingAttempts().every(row => row.s !== 'issued' || issuedAtPause.has(row.i)),
      '无issued残留：' + JSON.stringify(embeddingAttempts().filter(row => row.s === 'issued' && !issuedAtPause.has(row.i))));
    checks.push('阶段二（嵌入超期15秒）：词法已读内容照常交付、bounded如实（dense按期限停轮）；账本unknown收尾、无issued残留、无重复发送');
  }

  // 阶段三：BM25慢4秒、dense快。dense请求完成远早于词法完成（互不阻塞）。
  {
    phase = 'bm25-slow';
    provider.setDelay(0);
    lexicalDelayMs = SLOW_MS;
    const started = performance.now();
    const result = await search(P1_TERM, 5);
    const elapsed = performance.now() - started;
    lexicalDelayMs = 0;
    const lexical = milvusEvents.filter(event => event.phase === phase && event.kind === 'lexical');
    const dense = milvusEvents.filter(event => event.phase === phase && event.kind === 'dense');
    observations.bm25Slow = {elapsedMs: Math.round(elapsed), lexicalDone: lexical.at(-1)?.done, denseDone: dense[0]?.done,
      objects: result.objects.map(item => item.id)};
    assert.ok(elapsed <= 10800, '词法慢不拖垮整体期限：' + elapsed);
    assert.ok(lexical.length > 0 && dense.length > 0, '两通道都必须真实执行');
    assert.ok(dense[0].done < lexical.at(-1).done - 2500,
      'dense完成须远早于词法完成（互不阻塞）：dense=' + dense[0].done + ' lexical=' + lexical.at(-1).done);
    assert.ok(result.objects.some(item => item.id === 'deadline-needle'),
      '词法慢、dense快仍须交付命中：' + JSON.stringify(result.objects.map(item => item.id)));
    checks.push('阶段三（BM25慢4秒、dense快）：dense请求完成早于词法完成' + (lexical.at(-1).done - dense[0].done) + 'ms，通道互不阻塞');
  }

  // 阶段四：词法预读耗尽30内容名额，dense带来更高排名新项共用上限。
  // R×30（词频饱和，词法榜首，全部预读）+ Q×6（纯语义命中，dense榜首、词法31名外）
  // + 填充×100（稀缺度）。最终共同排名Q进入前30但名额已尽：不绕过上限再读，
  // 交付有界已读子集并如实bounded。
  {
    phase = 'quota-shared';
    provider.setDelay(SLOW_MS);
    const result = await search(SHARED + ' ' + Q_TERM, 30);
    const delivered = result.objects.map(item => item.id);
    observations.quotaShared = {deliveredCount: delivered.length, delivered,
      quotaDelivered: delivered.filter(id => id.startsWith('quota-q-')),
      coverage: result.search_coverage};
    assert.ok(delivered.length > 0 && delivered.length < 30,
      '名额耗尽后交付有界子集（不得为满页也不为零）：' + delivered.length);
    assert.ok(delivered.every(id => id.startsWith('quota-r-')),
      '未读的更高排名新项不得绕过上限进入交付：' + JSON.stringify(delivered));
    // 有界已读子集不得声称为完整最佳结果：名额耗尽（bounded）或通道配额未穷尽
    // （candidate_limit）都是如实有界表达，只有complete才是冒称。
    assert.ok(['bounded', 'candidate_limit'].includes(result.search_coverage.state),
      '有界已读子集不得声称为完整最佳结果：' + JSON.stringify(result.search_coverage));
    assert.ok((result.search_coverage.candidate_count || 0) >= 36,
      '两通道须覆盖全部梯度对象：' + JSON.stringify(result.search_coverage));
    checks.push('阶段四（词法预读耗尽30名额+dense更高排名新项）：共用上限不绕过，交付有界已读子集（' + delivered.length + '项）如实bounded');
  }

  }

  // 原六组完成后才加入新夹具，避免改变原有30读取名额场景的候选或排名。
  provider.setDelay(0);
  lexicalDelayMs = 0;
  phase = 'deadline-boundary-setup';
  const pair = [
    body(PAIR_A, 'document', PAIR_TERM, [entry('body', PAIR_TERM + '：合成规则A，' + PAIR_MARKERS[PAIR_A] + '。')]),
    {...body(PAIR_B, 'document', '时限合成关联规则B', [entry('body', PAIR_TERM + '：合成规则B，' + PAIR_MARKERS[PAIR_B] + '。')]),
      related_ids: [PAIR_A]},
  ];
  for (const value of pair) insert(h, value);
  await h.resumeWorker();
  assert.equal((await h.request('/knowledge-index/rebuilds', {operation_id: randomUUID()})).status, 200);
  await until(() => {
    const rows = h.sql(`SELECT JSON_OBJECT('k',COUNT(*),'v',SUM(vector_state='indexed'),
      'a',SUM(object_id='${PAIR_A}'),'b',SUM(object_id='${PAIR_B}'))
      FROM knowledge_index_jobs WHERE object_id IN ('${PAIR_A}','${PAIR_B}')`);
    // 独立文档按设计同时登记entry与excerpt两类索引作业；这里要求两份夹具的
    // 全部真实作业都已索引，不固定作业行数。
    return rows[0].k === rows[0].v && rows[0].a > 0 && rows[0].b > 0;
  }, '两份独立期限夹具真实索引', 90000);
  const previousRun = run;
  run = await h.capture(await h.create(), '核对独立范围准备与两次正文读取期限');
  h.releaseRun(previousRun.run_id);
  await h.pauseWorker();

  // 正控先确认真实Milvus、owner回读、最终重核和原保存回执都能交付A/B。
  {
    phase = 'deadline-boundary-control';
    const result = await search(PAIR_TERM, 2, pairScope);
    const call = observations.calls.at(-1);
    observations.boundaryControl = {operation: call.operation, objects: result.objects.map(item => item.id),
      sql: callSql(call), milvus: milvusEvents.filter(event => event.phase === phase)};
    assert.deepEqual(result.objects.map(item => item.id), [PAIR_A, PAIR_B], '正控须证明A精确名称排前且B可交付');
    for (const id of [PAIR_A, PAIR_B]) {
      assert.ok(result.objects.find(item => item.id === id).entries.some(value => value.effective_value.includes(PAIR_MARKERS[id])));
      assert.ok(callSql(call, 'body').some(event => event.ids.includes(id) && event.delivered));
    }
    assertFreshBeforeReceipt(call, [PAIR_A, PAIR_B]);
    assert.ok(callSql(call, 'coverage').some(event => event.upstreamDone && event.delivered),
      '正控必须观测到真实知识索引覆盖SQL，不能由未识别查询冒充到期后零请求');
    assert.equal(call.attempts[0].s, 'settled');
    assert.ok(milvusEvents.some(event => event.phase === phase && event.kind === 'lexical'
      && event.status === 200 && event.code === 0 && event.fixtureIds.includes(PAIR_A) && event.fixtureIds.includes(PAIR_B)),
    '正控须由真实Milvus词法结果取得两份候选');
    checks.push('期限正控：真实Milvus两候选→owner正文A/B→最终版本重核→原operation保存回执');
  }

  // 正文均已读取后，仅覆盖探测跨期；保留已读正文，不能将覆盖SQL排除于工作期限。
  {
    phase = 'coverage-crosses-deadline';
    coverageDelayMs = CROSS_MS;
    provider.setDelay(0);
    const result = await search(PAIR_TERM, 2, pairScope);
    const call = observations.calls.at(-1);
    coverageDelayMs = 0;
    const scope = callSql(call, 'scope')[0];
    const coverage = heldSql(call, 'coverage');
    const deadline = assertDeadlineExit(call, scope);
    observations.coverageDeadline = {operation: call.operation, scope, coverage, deadlineUpper: deadline,
      returned: call.returned, searchCoverage: result.search_coverage, sql: callSql(call)};
    assertHeldAcrossDeadline(call, coverage, deadline);
    assert.deepEqual(result.objects.map(item => item.id), [PAIR_A, PAIR_B]);
    assert.ok(callSql(call, 'body').every(event => event.delivered && event.delivered < coverage.started),
      '覆盖延迟只能发生在两份owner正文取得之后');
    assert.equal(result.search_coverage.state, 'bounded');
    assert.equal(result.search_coverage.index_state, 'incomplete', '未完成覆盖核验不能报告current');
    assert.equal(call.attempts[0].s, 'settled');
    assertFreshBeforeReceipt(call, [PAIR_A, PAIR_B]);
    checks.push('索引覆盖SQL独立跨原期限：保留两份已读正文及最终重核，覆盖为incomplete且bounded，不延长期限');
  }

  // 范围准备8秒后Embedding需4秒；沿原10秒期限只能等约2秒，不能改从launch重新起算。
  {
    phase = 'scope-consumes-deadline';
    scopeDelayMs = SCOPE_MS;
    provider.setDelay(SLOW_MS);
    const result = await search(PAIR_TERM, 2, pairScope);
    const call = observations.calls.at(-1);
    scopeDelayMs = 0;
    const scope = heldSql(call, 'scope');
    const deadline = assertOriginalDeadline(call, scope);
    const arrival = embedArrivals.find(event => event.operation === call.operation);
    observations.scopeDeadline = {operation: call.operation, scope, deadlineUpper: deadline,
      returned: call.returned, embedding: arrival, coverage: result.search_coverage, objects: result.objects.map(item => item.id)};
    assert.ok(arrival && arrival.t >= scope.delivered, 'Embedding发送必须发生在8秒范围准备之后');
    assert.ok(call.returned < arrival.t + SLOW_MS, '不能等满重新起算后可完成的4秒Embedding');
    assert.equal(milvusEvents.filter(event => event.phase === phase && event.kind === 'dense').length, 0,
      '剩余约2秒不足4秒Embedding，不得再派dense');
    assertOriginalUnknown(call);
    assert.deepEqual(result.objects.map(item => item.id), [PAIR_A, PAIR_B], '剩余期限内已读词法正文仍须交付');
    assert.equal(result.search_coverage.state, 'bounded');
    assert.equal(result.search_coverage.channels.dense.uncovered, 'deadline');
    assert.equal(callSql(call, 'coverage').length, 0, '原期限后不得启动新的覆盖SQL');
    assertFreshBeforeReceipt(call, [PAIR_A, PAIR_B]);
    checks.push('范围准备实际8秒后仅余原10秒期限，4秒查询Embedding被原期限截断且原attempt响应时unknown；已读词法A/B交付');
    // 等替身结束上次已取消的HTTP处理后再改它的延迟，避免跨场景读到可变delay。
    await delay(Math.max(0, arrival.t + SLOW_MS + 250 - Date.now()));
  }

  // 元信息独立12秒延迟：范围准备不延迟，只有真实Milvus候选就绪后才匹配。
  {
    phase = 'metadata-crosses-deadline';
    metaDelayMs = CROSS_MS;
    provider.setDelay(OVER_MS);
    const result = await search(PAIR_TERM, 2, pairScope);
    const call = observations.calls.at(-1);
    metaDelayMs = 0;
    const scope = callSql(call, 'scope')[0];
    const meta = heldSql(call, 'meta');
    const deadline = assertDeadlineExit(call, scope);
    observations.metadataDeadline = {operation: call.operation, scope, meta, deadlineUpper: deadline,
      returned: call.returned, coverage: result.search_coverage, sql: callSql(call)};
    assertHeldAcrossDeadline(call, meta, deadline);
    assert.equal(scope.delayMs, undefined, '元信息场景不得夹带范围准备延迟');
    assert.ok(meta.started >= scope.delivered, '范围准备和候选元信息须是独立读取');
    assert.ok(milvusEvents.some(event => event.phase === phase && event.kind === 'lexical'
      && event.done <= meta.started && event.fixtureIds.includes(PAIR_A) && event.fixtureIds.includes(PAIR_B)),
    '必须在真实词法候选就绪后才延迟排名元信息，不能延迟范围准备的同形SQL冒充');
    assert.equal(callSql(call, 'body').length, 0, '元信息跨期后不得再开始正文读取');
    assert.equal(callSql(call, 'coverage').length, 0, '元信息跨期后不得另启覆盖SQL');
    assert.deepEqual(result.objects, [], '迟到元信息不能带来迟到正文');
    assert.equal(result.search_coverage.state, 'bounded');
    assert.equal(result.search_coverage.channels.dense.uncovered, 'deadline');
    assertOriginalUnknown(call);
    checks.push('候选元信息独立延迟跨原期限：真实词法候选已到、无正文读取、正式回执为空且bounded，原attempt响应时unknown');
  }

  // 同一次正式调用先完整取得A，再让B的owner正文窗口跨期；只能提交原已读A。
  {
    phase = 'second-body-crosses-deadline';
    bodyDelayMs = CROSS_MS;
    provider.setDelay(OVER_MS);
    const result = await search(PAIR_TERM, 2, pairScope);
    const call = observations.calls.at(-1);
    bodyDelayMs = 0;
    const scope = callSql(call, 'scope')[0];
    const second = heldSql(call, 'body');
    const first = callSql(call, 'body').find(event => event.ids.includes(PAIR_A));
    const deadline = assertDeadlineExit(call, scope);
    observations.bodyDeadline = {operation: call.operation, scope, first, second, deadlineUpper: deadline,
      returned: call.returned, coverage: result.search_coverage, objects: result.objects.map(item => item.id), sql: callSql(call)};
    assertHeldAcrossDeadline(call, second, deadline);
    assert.equal(scope.delayMs, undefined, '正文场景不得夹带范围准备延迟');
    assert.deepEqual(callSql(call, 'body').map(event => event.ids), [[PAIR_A], [PAIR_B]], '同一调用只启动A、B两次owner正文窗口');
    assert.ok(first?.delivered && first.delivered < second.started && first.delivered < deadline,
      'A须在同次调用中完整取得并先于B启动');
    assert.deepEqual(result.objects.map(item => item.id), [PAIR_A], '迟到B不能交付，也不能丢弃已读A');
    assert.ok(result.objects[0].entries.some(value => value.effective_value.includes(PAIR_MARKERS[PAIR_A])));
    assert.ok(!JSON.stringify(call.tool.receipt).includes(PAIR_MARKERS[PAIR_B]), '保存回执不能含迟到B正文');
    assert.equal(result.search_coverage.state, 'bounded');
    assertOriginalUnknown(call);
    assertFreshBeforeReceipt(call, [PAIR_A]);
    checks.push('同次调用先完整读A、第二正文B跨原期限：原最终核验后只保存并交付A，B正文不进入回执，原attempt响应时unknown');
  }

  // 复用同一读取连接和原结算锁：读取错误先到，原Embedding结算被锁到期限后。
  {
    phase = 'read-error-settlement-held';
    bodyDelayMs = 1000;
    bodyError = true;
    provider.setDelay(OVER_MS);
    const {call, response} = await invoke(PAIR_TERM, 2, pairScope);
    bodyDelayMs = 0;
    bodyError = false;
    const error = heldSql(call, 'body');
    observations.readError = {operation: call.operation, error, settlement: call.settlement, status: response.status,
      returned: call.returned, attempts: call.attempts, toolState: call.tool.state};
    assert.equal(error.error, 'connection_closed');
    assert.ok(error.errorAt && error.errorAt < call.started + WORK_MS, '普通读取错误必须先于原工作期限出现');
    assert.ok(call.settlement?.held && call.settlement.held < error.errorAt, '读取失败前已持有本次已发Embedding的原账本锁');
    assert.ok(call.settlement.released > call.started + WORK_MS, '原结算锁须独立跨过工作期限');
    assert.ok(call.returned >= call.settlement.released && call.returned < call.started + 17000,
      '普通读取错误出口必须等待本次原Embedding结算后有界返回');
    assert.equal(response.status, 503, JSON.stringify(response.value));
    assert.equal(response.value.code, 'unavailable', '错误跨期不能被吞成bounded成功');
    assert.equal(response.value.data, undefined);
    assertOriginalUnknown(call);
    assert.equal(call.tool.state, 'rejected');
    assert.equal(call.tool.receipt.operation_id, call.operation);
    assert.equal(call.tool.receipt.data.error, 'unavailable', '原operation保存明确读取错误');
    checks.push('普通读取传输错误先到且响应跨期：等本次原Embedding锁后unknown收尾，仍503/unavailable并沿原operation保存拒绝回执');
  }

  // anchor轻量存在性核验也是检索工作；跨期不能启动Embedding或新公共召回。
  {
    phase = 'anchor-crosses-deadline';
    anchorDelayMs = OVER_MS;
    provider.setDelay(0);
    const result = await search(PAIR_TERM, 2, pairScope);
    const call = observations.calls.at(-1);
    anchorDelayMs = 0;
    const scope = callSql(call, 'scope')[0];
    const anchor = heldSql(call, 'anchor');
    const deadline = assertDeadlineExit(call, scope);
    observations.anchorDeadline = {operation: call.operation, scope, anchor, deadlineUpper: deadline,
      returned: call.returned, coverage: result.search_coverage, sql: callSql(call),
      vectorStarts: vectorStarts.filter(event => event.phase === phase)};
    assertHeldAcrossDeadline(call, anchor, deadline, OVER_MS);
    assert.equal(scope.delayMs, undefined, 'anchor场景不得夹带范围准备延迟');
    assert.equal(call.sent, 0, 'anchor核验跨期之后不得发送查询Embedding');
    assert.deepEqual(call.attempts, [], '许可前到期不得新登记attempt');
    assert.equal(milvusEvents.filter(event => event.phase === phase && ['lexical','dense'].includes(event.kind)).length, 0,
      'anchor到期以后不得重新启动公共通道');
    assert.deepEqual(vectorStarts.filter(event => event.phase === phase), [],
      'anchor跨期以后不得启动索引目标或任何新Milvus工作');
    assert.equal(callSql(call, 'body').length, 0, 'anchor跨期之后不得启动正文读取');
    assert.deepEqual(result.objects, []);
    assert.equal(result.search_coverage.state, 'bounded');
    checks.push('anchor元信息独立跨原期限：不再启动查询Embedding、公共召回或正文读取，无新attempt且正式回执bounded');
  }

  // 许可已经真实提交，只延迟其COMMIT确认包；到期后确认未调用发送函数，应沿原attempt零结算。
  {
    phase = 'permit-committed-before-send';
    permitCommitDelayMs = CROSS_MS;
    provider.setDelay(0);
    const budgetState = () => h.sql(`SELECT JSON_OBJECT('scope',b.id,'issued',b.issued_calls,
      'trial',t.id,'allocated',t.allocated_calls,'reserved',t.reserved_micros,'spent',t.spent_micros)
      FROM budget_scopes b JOIN model_trials t ON t.id=JSON_UNQUOTE(JSON_EXTRACT(b.model_profile,'$.trial_id'))
      WHERE b.id='${run.budget_scope_id}'`)[0];
    const before = budgetState();
    const result = await search(PAIR_TERM, 2, pairScope);
    const call = observations.calls.at(-1);
    permitCommitDelayMs = 0;
    const scope = callSql(call, 'scope')[0];
    const commit = heldSql(call, 'permit-commit');
    const deadline = assertDeadlineExit(call, scope);
    assertHeldAcrossDeadline(call, commit, deadline);
    assertDelivered(call, commit);
    assert.ok(commit.upstreamDone < deadline && commit.delivered > deadline,
      '真实许可提交在期限内完成，只有COMMIT确认跨期，不能用未提交许可冒充');
    assert.equal(call.sent, 0, '收到迟到许可确认后不得发送Embedding');
    assert.equal(call.attempts.length, 1, '必须沿本次原许可留下唯一attempt');
    const attempt = call.attempts[0];
    assert.equal(attempt.s, 'settled', '确认本次从未发送须响应前零消耗收尾，不留issued或unknown');
    assert.equal(attempt.operation, call.operation);
    assert.equal(attempt.scope, run.budget_scope_id);
    assert.deepEqual(attempt.usage, {input_tokens: 0, output_tokens: 0, elapsed_ms: 0});
    assert.equal(attempt.cached, false, '未发送的零结算不能伪造成功向量缓存');
    const after = budgetState();
    assert.equal(after.scope, before.scope); assert.equal(after.trial, before.trial);
    assert.equal(after.issued, before.issued + 1, '已用原请求调用次数不退款');
    assert.equal(after.allocated, before.allocated + 1, '原trial次数不退款、不换身份补额');
    assert.equal(after.reserved, before.reserved, '仅释放本次已知零消耗的预留');
    assert.equal(after.spent, before.spent);
    assert.deepEqual(result.objects.map(value => value.id), [PAIR_A, PAIR_B],
      '期限前已读词法A/B仍在最终保存回执交付');
    assert.equal(result.search_coverage.state, 'bounded');
    assert.equal(milvusEvents.filter(event => event.phase === phase && event.kind === 'dense').length, 0);
    assertFreshBeforeReceipt(call, [PAIR_A, PAIR_B]);
    observations.permitCommittedBeforeSend = {operation: call.operation, attempt, commit, deadlineUpper: deadline,
      returned: call.returned, before, after, coverage: result.search_coverage};
    checks.push('原许可已提交但确认跨期、本次尚未发送：同attempt按已知零消耗结算，无向量缓存且不退调用次数，已读词法正文保留');
  }

  // 只断本次实际已发Embedding的结算读取；其他连接仍可保存原工具的明确拒绝。
  {
    phase = 'settlement-storage-fails';
    provider.setDelay(1000);
    const budgetState = () => h.sql(`SELECT JSON_OBJECT('scope',b.id,'issued',b.issued_calls,
      'trial',t.id,'allocated',t.allocated_calls,'reserved',t.reserved_micros,'spent',t.spent_micros)
      FROM budget_scopes b JOIN model_trials t ON t.id=JSON_UNQUOTE(JSON_EXTRACT(b.model_profile,'$.trial_id'))
      WHERE b.id='${run.budget_scope_id}'`)[0];
    const before = budgetState();
    const {call, response, input} = await invoke(PAIR_TERM, 2, pairScope);
    provider.setDelay(0);
    assert.ok(call.issued && call.settlementFailed, '须真实发送后才切断本次原attempt的结算连接');
    const errors = callSql(call, 'settlement').filter(event => event.error);
    assert.equal(errors.length, 1, '只注入一次结算存储故障，不重复重试');
    assert.equal(errors[0].attempt, call.issued[0].i);
    assert.ok(errors[0].errorAt < call.returned, '工具响应前须观察到实际结算连接失败');
    assert.equal(response.status, 503, JSON.stringify(response.value));
    assert.equal(response.value.code, 'unavailable');
    assert.equal(response.value.data, undefined, '结算失败不能返回伪成功正文');
    assert.equal(call.tool.state, 'rejected');
    assert.equal(call.tool.receipt.operation_id, call.operation);
    assert.equal(call.tool.receipt.data.error, 'unavailable');
    assert.equal(call.attempts[0].s, 'issued');
    assert.equal(call.attempts[0].usage, null);
    assert.equal(call.attempts[0].cached, false);
    const after = budgetState();
    assert.equal(after.scope, before.scope);
    assert.equal(after.trial, before.trial);
    assert.equal(after.issued, before.issued + 1, '仅消耗一次原请求调用数');
    assert.equal(after.allocated, before.allocated + 1);
    assert.ok(after.reserved > before.reserved, '无法结算的原调用须保留预留');
    assert.equal(after.spent, before.spent, '无法结算不能伪造实际消耗');
    const sends = provider.requests.length;
    const originalAttempts = attemptsFor(call.operation);
    await h.restartApi();
    const registered = await h.internal('/internal/data/tool-calls', input);
    assert.equal(registered.status, 200, JSON.stringify(registered.value));
    assert.equal(registered.value.operation_id, call.operation, 'API重启后仍接回原operation');
    const rejection = await h.internal('/internal/data/tool-rejections', input);
    assert.equal(rejection.status, 200, JSON.stringify(rejection.value));
    assert.deepEqual(rejection.value, call.tool.receipt, '既有恢复入口接回原拒绝回执');
    const repeated = await h.internal('/internal/data/tools', input);
    // 现行幂等重放契约（同cursor-boundaries/delivery/search-progress）：重放
    // 接回冻结拒绝回执（200携带outcome=rejected），不重做为成功正文；下方
    // 无新发送/同attempt/同预算再证未重执行。
    assert.equal(repeated.status, 200, JSON.stringify(repeated.value));
    assert.deepEqual(repeated.value, call.tool.receipt, '重放只接回冻结拒绝，不重做为成功');
    assert.equal(provider.requests.length, sends, '恢复与直接重放都不得重复发送原Embedding');
    assert.deepEqual(attemptsFor(call.operation), originalAttempts, '不换attempt或补造结算');
    assert.deepEqual(budgetState(), after, '原身份恢复不换预算、不退款、不补额');
    const tools = h.sql(`SELECT JSON_OBJECT('operation',operation_id,'state',state,'receipt',receipt)
      FROM tool_calls WHERE operation_id='${call.operation}'`);
    assert.equal(tools.length, 1);
    assert.equal(tools[0].state, 'rejected');
    assert.deepEqual(tools[0].receipt, call.tool.receipt);
    observations.settlementStorageFailure = {operation: call.operation, attempt: call.issued[0].i,
      error: errors[0], returned: call.returned, status: response.status, attempts: call.attempts,
      before, after, replayStatus: repeated.status, rejectionRecovered: true};
    checks.push('原Embedding结算存储自身失败：503并保存原拒绝，原issued/预留保留；API重启沿原身份恢复且无重发、零消耗伪造或补额');
  }

  passed = true;
  console.log(JSON.stringify({passed, checks, observations, officialRequests: 0}));
} finally {
  if (settlementLock) await settlementLock;
  try {
    // 失败复盘用：嵌入账本终态全量快照（含operation/scope），定位issued孤儿来源。
    observations.embeddingLedger = h ? embeddingAttempts() : [];
    await writeFile('.local/checks/retrieval-deadline-order.json',
      JSON.stringify({passed, checks, observations, officialRequests: 0}, null, 2));
  } catch {}
  activeCall = undefined;
  scopeDelayMs = 0; anchorDelayMs = 0; metaDelayMs = 0; bodyDelayMs = 0; bodyError = false; permitCommitDelayMs = 0; coverageDelayMs = 0;
  if (run && h) h.releaseRun(run.run_id);
  if (h) await h.close();
  await provider.close();
  vectorProxy.closeAllConnections();
  await new Promise(resolve => vectorProxy.close(resolve));
  for (const sock of sockets) sock.destroy();
  for (const timer of pendingDelays) clearTimeout(timer);
  await new Promise(resolve => sqlProxy.close(resolve));
}

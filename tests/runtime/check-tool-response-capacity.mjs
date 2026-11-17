import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {toolResponseCapacity} from '../../apps/agent/session/capacity.ts';

const profile = {provider_id: 'deepseek', model_id: 'deepseek-flash', input_limit: 65536,
  output_limit: 8192, context_window: 131072, payload_bytes_limit: 131072};
const tools = ['read_source', 'read_knowledge'].map(name => ({name, description: '合成补读', parameters: {type: 'object'}}));
const system = {role: 'system', content: '合成容量规则', toolsAdded: tools, timestamp: 1};
const user = {role: 'user', content: '补读合成规则', timestamp: 2};
const assistant = {role: 'assistant', api: 'openai-completions', provider: 'deepseek', model: 'deepseek-flash',
  content: tools.map((tool, index) => ({type: 'toolCall', id: 'capacity-' + index, name: tool.name, arguments: {}})),
  usage: {input: 55000, output: 1000, cacheRead: 0, cacheWrite: 0, totalTokens: 56000,
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}, stopReason: 'toolUse', timestamp: 3};
const fixed = () => ({systemPrompt: system.content, tools, references: []});
const checks = [], failures = [];
async function check(name, run) {
  try {await run(); checks.push(name);} catch (error) {failures.push({name, error: error.message});}
}
async function context(capacity, messages) {
  for (const handler of capacity.extension.handlers.get('context_with_system') ?? []) await handler({type: 'context_with_system', messages});
}

await check('同一已完成助手usage与检查点恢复分配相同，无重复系统、工具或助手开销', async () => {
  const normalManager = SessionManager.inMemory('/synthetic/tool-response-capacity');
  for (const message of [system, user, assistant]) normalManager.appendMessage(structuredClone(message));
  const normal = toolResponseCapacity(profile, normalManager, fixed);
  await context(normal, [system, user]);
  normal.begin(assistant, 56000);
  const expected = normal.budget('capacity-0');
  const recoveredManager = SessionManager.inMemory('/synthetic/tool-response-capacity');
  for (const message of [system, user, assistant]) recoveredManager.appendMessage(structuredClone(message));
  const recovered = toolResponseCapacity(profile, recoveredManager, fixed);
  const actual = recovered.budget('capacity-0', 56000);
  assert.equal(actual.estimated_tokens, expected.estimated_tokens);
  assert.equal(actual.max_bytes, expected.max_bytes);
  assert.ok(actual.estimated_tokens < 200, '已使用56000 tokens时，恢复不能按零usage多分额度');
  assert.deepEqual(recovered.budget('capacity-1', 1), actual, '后续工具使用同批首次分配');
});

await check('provider不可见的details、usage/cost和时间戳不改变正文额度或投影指纹', async () => {
  const previous = {...assistant, content: [{type: 'toolCall', id: 'previous-read', name: 'read_source', arguments: {}}],
    usage: {...assistant.usage, input: 1000, output: 100, totalTokens: 1100}};
  const result = {role: 'toolResult', toolCallId: 'previous-read', toolName: 'read_source',
    content: [{type: 'text', text: '中🧪\\\"\n'.repeat(1800)}], isError: false, timestamp: 4};
  const allocate = async details => {
    const manager = SessionManager.inMemory('/synthetic/tool-response-capacity');
    const history = [system, user, previous, {...result, ...(details ? {details: {data: {text: '不发给provider'.repeat(4000)}}} : {})}];
    const capacity = toolResponseCapacity(profile, manager, fixed);
    await context(capacity, history);
    capacity.begin({...assistant, timestamp: details ? 9999 : 3}, 12000);
    return capacity.budget('capacity-0');
  };
  assert.deepEqual(await allocate(true), await allocate(false));
});

await check('已接回的toolResult只计基线，不再占尚未执行工具的份额', async () => {
  const manager = SessionManager.inMemory('/synthetic/tool-response-capacity');
  for (const message of [system, user, assistant, {role: 'toolResult', toolCallId: 'capacity-0', toolName: 'read_source',
    content: [{type: 'text', text: '合成已保存正文'}], isError: false, timestamp: 4}]) manager.appendMessage(structuredClone(message));
  const capacity = toolResponseCapacity(profile, manager, fixed);
  const remaining = capacity.budget('capacity-1', 12000);
  const reference = SessionManager.inMemory('/synthetic/tool-response-capacity');
  const oneCall = {...assistant, content: [assistant.content[1]]};
  for (const message of [system, user, oneCall]) reference.appendMessage(structuredClone(message));
  const expected = toolResponseCapacity(profile, reference, fixed);
  expected.begin(oneCall, 12000);
  assert.ok(remaining.estimated_tokens > expected.budget('capacity-1').estimated_tokens * 0.9,
    '恢复仅一项未完成时不能再次均分给已交付项');
});

await check('原成功回执大于新hint时扣减同批未执行项，原正文不改写', async () => {
  const manager = SessionManager.inMemory('/synthetic/tool-response-capacity');
  const capacity = toolResponseCapacity(profile, manager, fixed);
  await context(capacity, [system, user]);
  capacity.begin(assistant, 12000);
  const first = capacity.budget('capacity-0');
  const frozen = {text: '中🧪\\\"\n'.repeat(Math.ceil(first.max_bytes / 8))};
  const original = JSON.stringify(frozen);
  assert.ok(Buffer.byteLength(original) > first.max_bytes);
  capacity.accept(frozen, 'capacity-0');
  const next = capacity.budget('capacity-1');
  assert.ok(next.max_bytes < first.max_bytes, '冻结正文额外占用必须从剩余项扣除');
  assert.equal(JSON.stringify(frozen), original);
});

await check('同批先完成的非读取工具按实际回执释放预留，只分给尚未领取的读取额度', async () => {
  const mixed = {...assistant, content: [
    {type: 'toolCall', id: 'route', name: 'update_analysis_task', arguments: {}},
    ...assistant.content,
    {type: 'toolCall', id: 'native-read', name: 'read', arguments: {}},
  ]};
  const baseline = toolResponseCapacity(profile, SessionManager.inMemory('/synthetic/capacity-baseline'), fixed);
  await context(baseline, [system, user]); baseline.begin(mixed, 12000);
  const reserved = {...baseline.budget('capacity-0')};
  const capacity = toolResponseCapacity(profile, SessionManager.inMemory('/synthetic/capacity-mixed'), fixed);
  await context(capacity, [system, user]); capacity.begin(mixed, 12000);
  capacity.accept({task_id: 'synthetic-task', condition_version: '1'}, 'route');
  const first = {...capacity.budget('capacity-0')};
  assert.ok(first.max_bytes > reserved.max_bytes + 4000, '已完成route不再占整份24KiB非读取预留');
  capacity.accept({text: '合成原生附件'}, 'native-read');
  assert.deepEqual(capacity.budget('capacity-0'), first, '已领取的额度不能重新扩大发放');
  const second = {...capacity.budget('capacity-1')};
  assert.ok(second.max_bytes > first.max_bytes, '后完成非读取只释放给未领取项');
  capacity.accept({text: '合成短读取'}, 'capacity-0');
  assert.deepEqual(capacity.budget('capacity-1'), second, '读取已领份额不回收再分');
});

await check('容量错误从原检查点恢复，摘要开始或失败不消费标记，仅成功compact清除', async () => {
  const manager = SessionManager.inMemory('/synthetic/tool-response-capacity');
  for (const message of [system, user, assistant, {role: 'toolResult', toolCallId: 'capacity-0', toolName: 'read_source',
    content: [{type: 'text', text: JSON.stringify({error: 'tool_response_capacity'})}], isError: true, timestamp: 4}]) manager.appendMessage(structuredClone(message));
  const capacity = toolResponseCapacity(profile, manager, fixed);
  assert.throws(() => capacity.check(true), /request_too_large: model_input_limit/);
  assert.doesNotThrow(() => capacity.check(false), '摘要请求允许发出');
  for (const handler of capacity.extension.handlers.get('session_compact_failed') ?? []) await handler({type: 'session_compact_failed', aborted: false});
  assert.throws(() => capacity.check(true), /request_too_large: model_input_limit/, '摘要失败后仍须原生压缩');
  const entryId = manager.getLeafId();
  manager.appendCompaction('已完成合成压缩', entryId, 1000);
  for (const handler of capacity.extension.handlers.get('session_compact') ?? []) await handler({type: 'session_compact'});
  assert.doesNotThrow(() => capacity.check(true));
  const reopened = toolResponseCapacity(profile, manager, fixed);
  assert.doesNotThrow(() => reopened.check(true), '最新成功压缩之前保留的错误不能再次触发');
});

const passed = failures.length === 0;
const report = {passed, checks, failures, officialRequests: 0,
  boundary: '真实Pi SessionManager与公开容量分配入口；无数据库、无模型分词或压缩端到端结论'};
await mkdir('.local/checks', {recursive: true});
await writeFile('.local/checks/tool-response-capacity.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
assert.equal(passed, true, '工具组容量与恢复反例未全部通过');

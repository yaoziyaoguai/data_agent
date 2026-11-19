import {createHash} from 'node:crypto';
import {
  createSyntheticSourceInfo,
  convertToLlm,
  estimateTokens,
  type ContextWithSystemEvent,
  type Extension,
  type SessionBeforeCompactEvent,
  type SessionManager,
} from '@earendil-works/pi-coding-agent';
import type {AssistantMessage, Tool} from '@earendil-works/pi-ai';
import type {ModelProfile, ResponseBudget} from '../../../packages/contracts/generated/boundary.ts';
import { assertRuntimeOverhead, planForProfile, type CapacityPlan } from '../../../packages/contracts/capacity.ts';

// 只核对宿主固定开销与Pi真实保留边界；摘要、切点和续接仍全部由SDK执行。
export function sessionCapacity(
  plan: CapacityPlan,
  manager: SessionManager,
  fixedOverheadTokens: () => number,
) {
  let retainedOverhead = 0;
  let retainedFrom: string | undefined;
  const failure = () => {
    // 开销只属于该保留边界；Pi撤下它后不再计入，刷新回滚到原分支时仍可复用。
    const retainedIsActive = retainedFrom !== undefined && manager.buildContextEntries()
      .some(entry => entry.id === retainedFrom);
    return assertRuntimeOverhead(plan, fixedOverheadTokens() + (retainedIsActive ? retainedOverhead : 0));
  };
  const path = '<inline:data_agent_capacity>';
  const extension: Extension = {
    path, resolvedPath: path,
    sourceInfo: createSyntheticSourceInfo(path, {source: 'inline', scope: 'temporary'}),
    handlers: new Map([['session_before_compact', [async (event: unknown) => {
      const {preparation} = event as SessionBeforeCompactEvent;
      const entries = manager.buildSessionProjection().entries;
      const firstKept = entries.findIndex(entry => entry.sourceEntry.id === preparation.firstKeptEntryId);
      if (firstKept < 0) throw new Error('checkpoint_conflict');
      retainedFrom = preparation.firstKeptEntryId;
      const retainedTokens = entries.slice(firstKept).flatMap(entry => entry.messages)
        .reduce((total, message) => total + estimateTokens(message), 0);
      retainedOverhead = Math.max(0, retainedTokens - plan.keepRecent);
      const split = preparation.isSplitTurn && preparation.turnPrefixMessages.length > 0;
      const historyTokens = split && preparation.messagesToSummarize.length === 0
        ? Math.ceil((preparation.previousSummary ?? 'No prior history.').length / 4)
        : plan.summaryCap;
      const summaryTokens = historyTokens + (split ? plan.splitSummaryCap + 16 : 0);
      // 旧摘要可能来自不同输出配置；完整保留组、拼接标记和文件附记都不受K或单次O截断。
      retainedOverhead += Math.max(0, summaryTokens - plan.summaryCap - plan.splitSummaryCap);
      const paths = new Set([...preparation.fileOps.read, ...preparation.fileOps.written, ...preparation.fileOps.edited]);
      if (paths.size) retainedOverhead += Math.ceil([...paths].reduce((length, path) => length + path.length + 1, 128) / 4);
      // 不抛到会吞异常的扩展通知层；模型派发边界在发送摘要之前执行check。
    }]]]),
    tools: new Map(), messageRenderers: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map(),
  };
  return {
    extension,
    failure,
    check() {
      if (failure()) throw new Error('model_input_limit');
    },
  };
}

// 只分配本次助手工具组的正文空间；实际压缩和模型重试仍由Pi的请求边界执行。
export function toolResponseCapacity(
  profile: ModelProfile | null | undefined,
  manager: SessionManager,
  fixed: () => {systemPrompt: string; tools: Tool[]; references: string[]; usageTokens?: number | null},
) {
  let projected: ContextWithSystemEvent['messages'] | undefined;
  let batch: AssistantMessage | undefined;
  let allocations = new Map<string, ResponseBudget>();
  const accepted = new Set<string>();
  const claimed = new Set<string>();
  const nonReads = new Set<string>();
  const branch = manager.getBranch();
  const lastCompact = branch.findLastIndex(entry => entry.type === 'compaction');
  const visible = new Set(manager.buildSessionProjection().entries.map(entry => entry.sourceEntry.id));
  let needsCompaction = branch.slice(lastCompact + 1).some(entry => {
    if (entry.type !== 'message' || !visible.has(entry.id) || entry.message.role !== 'toolResult' || !entry.message.isError) return false;
    return entry.message.content.some(part => {
      if (part.type !== 'text') return false;
      try { return JSON.parse(part.text)?.error === 'tool_response_capacity'; }
      catch { return false; } // 其他工具错误可为普通文本，不是容量信号。
    });
  });
  const path = '<inline:data_agent_tool_capacity>';
  const extension: Extension = {
    path, resolvedPath: path,
    sourceInfo: createSyntheticSourceInfo(path, {source: 'inline', scope: 'temporary'}),
    handlers: new Map<string, ((event: unknown) => Promise<void>)[]>([
      ['context_with_system', [async event => { projected = (event as ContextWithSystemEvent).messages; }]],
      ['session_compact', [async () => {
        needsCompaction = false;
        projected = undefined;
        batch = undefined;
        allocations.clear();
        accepted.clear();
        claimed.clear();
        nonReads.clear();
      }]],
    ]),
    tools: new Map(), messageRenderers: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map(),
  };
  return {
    extension,
    begin(message: AssistantMessage, usageTokens?: number | null) {
      batch = message;
      allocations = new Map();
      accepted.clear();
      claimed.clear();
      nonReads.clear();
      const fixedContext = fixed();
      const messages = projected ?? manager.buildSessionProjection().messages;
      const allCalls = message.content.filter(part => part.type === 'toolCall');
      const assistantIndex = messages.findLastIndex(item => item.role === 'assistant' && item.content.some(part =>
        part.type === 'toolCall' && allCalls.some(call => call.id === part.id)));
      const completed = new Set(messages.slice(assistantIndex + 1).filter(item => item.role === 'toolResult').map(item => item.toolCallId));
      const calls = allCalls.filter(call => !completed.has(call.id));
      const reads = calls.filter(call => ['search_knowledge', 'read_knowledge', 'read_source'].includes(call.name));
      if (!reads.length) return;
      const plan = profile ? planForProfile(profile) : null;
      if (typeof plan === 'string') throw new Error('provider_configuration_invalid');
      const inputLimit = plan ? plan.trigger : (profile?.input_limit ?? 65536);
      const snapshot = convertToLlm(assistantIndex < 0 ? [...messages, message] : messages).map(item => {
        // details、usage和时间戳不发给模型；正文只按content计一次。
        if (item.role === 'system') return {role: item.role, content: item.content, sections: item.sections,
          toolsAdded: item.toolsAdded?.map(({name, description, parameters}) => ({name, description, parameters})), toolsRemoved: item.toolsRemoved};
        if (item.role === 'toolResult') return {role: item.role, content: item.content, toolCallId: item.toolCallId, toolName: item.toolName};
        return {role: item.role, content: item.content};
      });
      const context = {messages: snapshot,
        ...(!projected ? {
          ...(!snapshot.some(item => item.role === 'system') ? {systemPrompt: fixedContext.systemPrompt, tools: fixedContext.tools} : {}),
          ...(fixedContext.references.length ? {references: fixedContext.references} : {}),
        } : {}),
      };
      const serialized = JSON.stringify(context);
      const wrappers = calls.map(call => JSON.stringify({role: 'tool', tool_call_id: call.id, content: ''})).join('');
      const protocolBytes = Buffer.byteLength(JSON.stringify(serialized)) + Buffer.byteLength(wrappers) + 4096;
      const estimatedTokens = Math.ceil((serialized.length + wrappers.length) / 4) + 1024;
      const usage = usageTokens === undefined ? fixedContext.usageTokens : usageTokens;
      const currentTokens = usage == null ? estimatedTokens : Math.max(usage, estimatedTokens);
      for (const call of calls) if (!reads.includes(call)) nonReads.add(call.id);
      const otherTools = nonReads.size;
      const byteRemainder = Math.max(0, (profile?.payload_bytes_limit ?? 131072) - protocolBytes - otherTools * 24576);
      const tokenRemainder = Math.max(0, inputLimit - currentTokens - otherTools * 8192 - 1024);
      const maxBytes = Math.min(98304, Math.floor(byteRemainder / reads.length / 2));
      const tokens = Math.floor(tokenRemainder / reads.length / 2);
      const fingerprint = createHash('sha256').update(serialized).update(JSON.stringify(profile ?? null)).digest('hex');
      for (const call of reads) allocations.set(call.id, {
        max_bytes: maxBytes, estimated_tokens: tokens, projection_fingerprint: fingerprint,
      });
    },
    budget(sdkId: string, usageTokens?: number | null): ResponseBudget {
      if (!allocations.has(sdkId)) {
        const last = manager.buildSessionProjection().messages.findLast(message => message.role === 'assistant');
        if (last?.role === 'assistant' && last !== batch) this.begin(last, usageTokens);
      }
      const budget = allocations.get(sdkId);
      if (!budget) throw new Error('tool_capacity_unavailable');
      claimed.add(sdkId);
      return budget;
    },
    accept(data: Record<string, unknown>, sdkId: string) {
      if (data.error === 'tool_response_capacity') needsCompaction = true;
      const budget = allocations.get(sdkId);
      if ((!budget && !nonReads.has(sdkId)) || accepted.has(sdkId)) return;
      accepted.add(sdkId);
      const serialized = JSON.stringify(data);
      const bytes = Buffer.byteLength(serialized), tokens = Math.ceil(serialized.length / 4);
      if (!budget) {
        const pending = [...allocations].filter(([id]) => !claimed.has(id));
        // 非读取工具已完成的预留可释放；只调整尚未领取的份额，不重复发放已用余量。
        const spareBytes = 24576 - bytes, spareTokens = 8192 - tokens;
        for (const [, next] of pending) {
          next.max_bytes = Math.max(0, Math.min(98304, next.max_bytes + Math.floor(spareBytes / pending.length / 2)));
          next.estimated_tokens = Math.max(0, next.estimated_tokens + Math.floor(spareTokens / pending.length / 2));
        }
        return;
      }
      const extraBytes = Math.max(0, bytes - budget.max_bytes);
      const extraTokens = Math.max(0, tokens - budget.estimated_tokens);
      const pending = [...allocations].filter(([id]) => !accepted.has(id));
      // 原成功回执不能重剪；超出新份额的部分从同组尚未执行项扣除，不回收前项余量。
      for (const [, next] of pending) {
        next.max_bytes = Math.max(0, next.max_bytes - Math.ceil(extraBytes / pending.length));
        next.estimated_tokens = Math.max(0, next.estimated_tokens - Math.ceil(extraTokens / pending.length));
      }
    },
    check(hasTools: boolean) {
      if (needsCompaction && hasTools) throw new Error('request_too_large: model_input_limit');
    },
  };
}

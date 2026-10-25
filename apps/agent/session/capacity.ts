import {
  createSyntheticSourceInfo,
  estimateTokens,
  type Extension,
  type SessionBeforeCompactEvent,
  type SessionManager,
} from '@earendil-works/pi-coding-agent';
import { assertRuntimeOverhead, type CapacityPlan } from '../../../packages/contracts/capacity.ts';

// 只核对宿主固定开销与Pi真实保留边界；摘要、切点和续接仍全部由SDK执行。
export function sessionCapacity(
  plan: CapacityPlan,
  manager: SessionManager,
  fixedOverheadTokens: () => number,
) {
  let retainedOverhead = 0;
  const failure = () => assertRuntimeOverhead(plan, fixedOverheadTokens() + retainedOverhead);
  const path = '<inline:data_agent_capacity>';
  const extension: Extension = {
    path, resolvedPath: path,
    sourceInfo: createSyntheticSourceInfo(path, {source: 'inline', scope: 'temporary'}),
    handlers: new Map([['session_before_compact', [async (event: unknown) => {
      const {preparation} = event as SessionBeforeCompactEvent;
      const entries = manager.buildSessionProjection().entries;
      const firstKept = entries.findIndex(entry => entry.sourceEntry.id === preparation.firstKeptEntryId);
      if (firstKept < 0) throw new Error('checkpoint_conflict');
      const retainedTokens = entries.slice(firstKept).flatMap(entry => entry.messages)
        .reduce((total, message) => total + estimateTokens(message), 0);
      retainedOverhead = Math.max(0, retainedTokens - plan.keepRecent);
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

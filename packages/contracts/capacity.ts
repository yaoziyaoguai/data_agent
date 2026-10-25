import type { ModelProfile } from './generated/boundary.ts';

// 模型容量推导（实现设计17.7），与Rust侧model_configuration::capacity同公式同向量。
// C=总窗口，I=输入策略，O=输出策略；B=min(I,C-O)，H按B缩放。
export interface CapacityPlan {
  contextWindow: number;     // C：Pi注册的总窗口
  historyReserve: number;    // R=C-B+H，Pi reserveTokens；触发线T=C-R=B-H
  toolReserve: number;       // H：工具/临时资料/估算误差预留
  keepRecent: number;        // K=min(65536,floor(T/4))
  trigger: number;           // T=B-H
  summaryCap: number;        // S1=min(floor(0.8R),O)
  splitSummaryCap: number;   // S2=min(floor(0.5R),O)
}

export type CapacityFailure =
  | 'invalid_field'
  | 'reserve_exceeds_history'
  | 'summary_space_insufficient'
  | 'fixed_overhead_insufficient';

export function deriveCapacityPlan(
  contextWindow: number,
  inputLimit: number,
  outputLimit: number,
): CapacityPlan | CapacityFailure {
  if (
    !Number.isSafeInteger(contextWindow) || !Number.isSafeInteger(inputLimit) ||
    !Number.isSafeInteger(outputLimit) || contextWindow < 1024 || inputLimit < 1024 ||
    outputLimit < 1 || inputLimit > 2_000_000
  ) return 'invalid_field';
  const body = Math.min(inputLimit, contextWindow - outputLimit);
  const scaled = Math.min(65536, Math.max(16384, Math.ceil(contextWindow / 50)));
  const toolReserve = Math.min(scaled, Math.max(1024, Math.floor(body / 8)));
  if (body <= 2 * toolReserve) return 'reserve_exceeds_history';
  const historyReserve = contextWindow - body + toolReserve;
  const trigger = body - toolReserve;
  const keepRecent = Math.min(65536, Math.floor(trigger / 4));
  const summaryCap = Math.min(Math.floor((historyReserve * 4) / 5), outputLimit);
  const splitSummaryCap = Math.min(Math.floor(historyReserve / 2), outputLimit);
  if (summaryCap + splitSummaryCap + keepRecent >= trigger) return 'summary_space_insufficient';
  return { contextWindow, historyReserve, toolReserve, keepRecent, trigger, summaryCap, splitSummaryCap };
}

// 固定另外两个字段，搜索单调可行区间；输入上端只显示窗口中实际能使用的部分。
export function capacityRanges(context: number, input: number, output: number) {
  const feasible = (i: number, o: number) => o <= i && typeof deriveCapacityPlan(context, i, o) !== 'string';
  const inputMax = Math.min(2_000_000, context - output);
  let inputRange: [number, number] | null = null;
  if (feasible(inputMax, output)) {
    let low = Math.max(1024, output), high = inputMax;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (feasible(mid, output)) high = mid; else low = mid + 1;
    }
    inputRange = [low, inputMax];
  }
  let outputRange: [number, number] | null = null;
  if (feasible(input, 1)) {
    let low = 1, high = Math.min(393216, input, context - 1);
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (feasible(input, mid)) low = mid; else high = mid - 1;
    }
    outputRange = [1, low];
  }
  return { input: inputRange, output: outputRange };
}

export function capacityRangeMessage(context: number, input: number, output: number): string {
  const ranges = capacityRanges(context, input, output);
  const describe = (range: [number, number] | null) => range ? `${range[0]}–${range[1]} tokens` : '无可行值';
  return `总上下文保持 ${context} tokens：保留当前输出时，可用输入范围 ${describe(ranges.input)}；保留当前输入时，输出范围 ${describe(ranges.output)}。范围仅校验容量，端点和思考档位另行校验。`;
}

// 新冻结profile带context_window才走新公式；历史profile缺字段走legacy接入。
export function planForProfile(profile: ModelProfile): CapacityPlan | CapacityFailure | null {
  if (profile.context_window === undefined || profile.context_window === null) return null;
  return deriveCapacityPlan(
    profile.context_window,
    Number(profile.input_limit),
    Number(profile.output_limit),
  );
}

// 运行时按固定规则、工具定义和不可再压缩消息的实际开销F复核（Pi按字符/4估算token的同一启发式）。
export function assertRuntimeOverhead(
  plan: CapacityPlan,
  fixedOverheadTokens: number,
): CapacityFailure | null {
  if (
    plan.summaryCap + plan.splitSummaryCap + plan.keepRecent + fixedOverheadTokens >= plan.trigger
  ) return 'fixed_overhead_insufficient';
  return null;
}

// Node provider实际输出cap：min(SDK本次maxTokens, profile输出上限, 已知端点上限)。
export function effectiveOutputCap(
  profileOutputLimit: number,
  sdkRequestedMaxTokens: number | undefined,
  endpointOutputLimit: number | undefined,
): number {
  return Math.min(
    profileOutputLimit,
    sdkRequestedMaxTokens ?? Number.POSITIVE_INFINITY,
    endpointOutputLimit ?? Number.POSITIVE_INFINITY,
  );
}

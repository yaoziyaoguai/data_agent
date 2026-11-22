import type { ModelDefinition, ModelService, SaveModelDefinition, SaveModelService } from "../../../../../packages/contracts/generated/boundary.ts";
import { deriveCapacityPlan, capacityRangeMessage } from "../../../../../packages/contracts/capacity.ts";

// 旧配置缺新容量字段时允许编辑中为空；提交前由必填与容量校验补齐。
export type ModelDraft = Omit<
  SaveModelDefinition,
  "context_window" | "request_timeout_ms" | "capability_source"
> &
  Partial<
    Pick<
      SaveModelDefinition,
      "context_window" | "request_timeout_ms" | "capability_source"
    >
  >;
// DeepSeek已核对1M窗口的待验初值（实现设计17.7）；其他型号按已核实文档声明，不默认1M。
export const deepseekInitialValues = {
  context_window: 1000000,
  input_limit: 900000,
  output_limit: 65536,
  payload_bytes_limit: 8388608,
  request_timeout_ms: 600000,
  capability_source: "admin_declared" as const,
};
export const deepseekLongOutput = { output_limit: 131072 };
export const levels: SaveModelDefinition["thinking_levels"] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
export const levelLabel = {
  off: "关闭",
  minimal: "最轻",
  low: "轻度",
  medium: "中等",
  high: "深度",
  xhigh: "更深",
  max: "最高",
};
export const protocolLabel = {
  "openai-completions": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
  "anthropic-messages": "Anthropic Messages",
};
export function serviceDraft(value: ModelService): SaveModelService {
  const { version, credential_configured, ...draft } = value;
  return { ...draft, expected_version: version };
}
export function modelDraft(value: ModelDefinition): ModelDraft {
  const { version, ...draft } = value;
  return { ...draft, expected_version: version };
}

export function initialCapacity() {
  // 未选定具体型号时不推测总窗口；其余字段是可编辑的请求策略初值。
  return {
    input_limit: 65536,
    output_limit: 8192,
    payload_bytes_limit: 131072,
    request_timeout_ms: 90000,
    capability_source: "admin_declared" as const,
  };
}

// 提交前按同一容量公式预检并给出字段级原因；服务端仍按合同拒绝。
export function capacityProblem(draft: ModelDraft): string {
  if (
    draft.context_window === undefined ||
    draft.request_timeout_ms === undefined ||
    draft.capability_source === undefined
  )
    return "请填写总上下文、请求超时和能力来源。";
  const plan = deriveCapacityPlan(
    draft.context_window,
    draft.input_limit,
    draft.output_limit,
  );
  if (plan === "reserve_exceeds_history")
    return "历史与工具预留空间不足。" + capacityRangeMessage(draft.context_window, draft.input_limit, draft.output_limit);
  if (plan === "summary_space_insufficient")
    return "当前组合放不下两段摘要和近期保留。" + capacityRangeMessage(draft.context_window, draft.input_limit, draft.output_limit);
  if (plan === "invalid_field")
    return "请检查总上下文、最大输入与最大输出的数值范围。";
  return "";
}

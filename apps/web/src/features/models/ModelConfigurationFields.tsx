import { useEffect, useState } from "react";
import type { ModelService, SaveModelService } from "../../../../../packages/contracts/generated/boundary.ts";
import { capacityProblem, deepseekInitialValues, deepseekLongOutput, levels, levelLabel, protocolLabel, type ModelDraft } from "./model-configuration-draft.ts";

function formatPayloadMib(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  return String(Number((bytes / 1048576).toFixed(6)));
}

export function ServiceFields({
  draft,
  change,
}: {
  draft: SaveModelService;
  change: (draft: SaveModelService) => void;
}) {
  return (
    <>
      <label>
        服务名称
        <input
          required
          maxLength={100}
          value={draft.name}
          onChange={(e) => change({ ...draft, name: e.target.value })}
        />
      </label>
      <div className="configuration-grid">
        <label>
          供应商
          <select
            aria-label="供应商"
            value={draft.provider_id}
            onChange={(e) => {
              const value = e.target.value;
              if (
                value === "openai" ||
                value === "deepseek" ||
                value === "anthropic" ||
                value === "compatible"
              )
                change({
                  ...draft,
                  provider_id: value,
                  api:
                    value === "openai"
                      ? "openai-responses"
                      : value === "anthropic"
                        ? "anthropic-messages"
                        : value === "deepseek"
                          ? "openai-completions"
                          : draft.api,
                });
            }}
          >
            {[
              ["compatible", "兼容服务"],
              ["openai", "OpenAI"],
              ["anthropic", "Anthropic"],
              ["deepseek", "DeepSeek"],
            ].map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          接口协议
          <select
            aria-label="接口协议"
            value={draft.api}
            onChange={(e) => {
              const value = e.target.value;
              if (
                value === "openai-completions" ||
                value === "openai-responses" ||
                value === "anthropic-messages"
              )
                change({ ...draft, api: value });
            }}
          >
            {Object.entries(protocolLabel).map(([id, label]) => (
              <option
                key={id}
                value={id}
                disabled={
                  draft.provider_id === "deepseek" &&
                  id !== "openai-completions"
                }
              >
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        服务地址
        <input
          type="url"
          required
          maxLength={2048}
          placeholder={
            draft.provider_id === "openai"
              ? "https://api.openai.com/v1"
              : draft.api === "anthropic-messages"
                ? "https://api.anthropic.com"
                : "https://api.example.com/v1"
          }
          value={draft.base_url}
          onChange={(e) => change({ ...draft, base_url: e.target.value })}
        />
      </label>
      <p className="configuration-help">
        填写 API 基础地址。Chat Completions 和 Responses 通常包含 /v1；Anthropic
        使用服务根地址。只允许公网 HTTPS 服务。
      </p>
      <label>
        API Key
        <input
          type="password"
          autoComplete="new-password"
          maxLength={8192}
          required={draft.expected_version === "0"}
          value={draft.api_key ?? ""}
          placeholder={
            draft.expected_version === "0" ? "填写服务密钥" : "留空保留已有密钥"
          }
          onChange={(e) => {
            const next = { ...draft };
            if (e.target.value) next.api_key = e.target.value;
            else delete next.api_key;
            change(next);
          }}
        />
      </label>
      <label className="configuration-checkbox">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => change({ ...draft, enabled: e.target.checked })}
        />
        启用服务
      </label>
      <p className="configuration-help">
        修改地址或协议时，请重新输入 API
        Key。保存不会发起模型调用。停用会阻止该服务下所有模型的后续请求。
      </p>
    </>
  );
}
export function ModelFields({
  draft,
  services,
  change,
}: {
  draft: ModelDraft;
  services: ModelService[];
  change: (draft: ModelDraft) => void;
}) {
  const service = services.find((service) => service.id === draft.service_id);
  const protocol = service?.api;
  const providerId = service?.provider_id ?? "compatible";
  const budgetThinking =
    protocol === "anthropic-messages" &&
    draft.anthropic_thinking_mode !== "adaptive";
  const [payloadMib, setPayloadMib] = useState(() =>
    formatPayloadMib(draft.payload_bytes_limit),
  );
  useEffect(() => {
    const parsed =
      payloadMib.trim() === "" ? undefined : Number(payloadMib);
    const currentBytes =
      parsed !== undefined && Number.isFinite(parsed)
        ? Math.round(parsed * 1048576)
        : undefined;
    if (currentBytes !== draft.payload_bytes_limit) {
      setPayloadMib(formatPayloadMib(draft.payload_bytes_limit));
    }
  }, [draft.payload_bytes_limit]);
  return (
    <>
      <fieldset>
        <legend>所属服务与模型标识</legend>
        <label>
          所属服务
          <select
            aria-label="所属服务"
            required
            value={draft.service_id}
            onChange={(e) => {
              const next = { ...draft, service_id: e.target.value };
              const targetApi = services.find(
                (service) => service.id === next.service_id,
              )?.api;
              if (targetApi !== "anthropic-messages") {
                delete next.anthropic_thinking_mode;
              } else if (next.anthropic_thinking_mode !== "adaptive") {
                const filtered = next.thinking_levels.filter(
                  (level) => level !== "xhigh" && level !== "max",
                );
                const [first, ...rest] = filtered.length
                  ? filtered
                  : (["off"] as const);
                next.thinking_levels = [first, ...rest];
                if (
                  !([first, ...rest] as ModelDraft["default_thinking"][]).includes(
                    next.default_thinking,
                  )
                ) {
                  next.default_thinking = first;
                }
              }
              change(next);
            }}
          >
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.enabled ? "" : "（已停用）"}
              </option>
            ))}
          </select>
        </label>
        <div className="configuration-grid" style={{ marginTop: 10 }}>
          <label>
            Model ID
            <input
              required
              maxLength={200}
              value={draft.model_id}
              placeholder="供应商提供的模型标识"
              onChange={(e) => change({ ...draft, model_id: e.target.value })}
            />
          </label>
          <label>
            展示名称
            <input
              required
              maxLength={100}
              value={draft.label}
              onChange={(e) => change({ ...draft, label: e.target.value })}
            />
          </label>
        </div>
      </fieldset>
      {protocol === "anthropic-messages" && (
        <label>
          Anthropic 思考方式
          <select
            aria-label="Anthropic 思考方式"
            value={draft.anthropic_thinking_mode ?? "budget"}
            onChange={(e) => {
              if (e.target.value === "budget") {
                const filtered = draft.thinking_levels.filter(
                  (level) => level !== "xhigh" && level !== "max",
                );
                const [first, ...rest] = filtered.length
                  ? filtered
                  : (["off"] as const);
                change({
                  ...draft,
                  anthropic_thinking_mode: "budget",
                  thinking_levels: [first, ...rest],
                  default_thinking: ([first, ...rest] as ModelDraft["default_thinking"][]).includes(
                    draft.default_thinking,
                  )
                    ? draft.default_thinking
                    : first,
                });
              } else if (e.target.value === "adaptive") {
                change({ ...draft, anthropic_thinking_mode: "adaptive" });
              }
            }}
          >
            <option value="budget">思考预算（传统模型）</option>
            <option value="adaptive">自适应（支持 adaptive 的模型）</option>
          </select>
        </label>
      )}
      {protocol === "anthropic-messages" && (
        <p className="configuration-help">
          按模型文档选择。预算模式最多支持深度思考，启用思考时输出上限至少为
          2048；更高档位需要模型支持自适应模式。
        </p>
      )}
      <label className="configuration-checkbox">
        <input
          type="checkbox"
          checked={draft.reasoning_supported}
          onChange={(e) =>
            change(
              e.target.checked
                ? { ...draft, reasoning_supported: true }
                : {
                    ...draft,
                    reasoning_supported: false,
                    thinking_levels: ["off"],
                    default_thinking: "off",
                  },
            )
          }
        />
        模型支持思考（即使只开放关闭档位，也需要声明此能力）
      </label>
      <fieldset>
        <legend>支持的思考档位</legend>
        <div className="configuration-levels">
          {levels.map((level) => (
            <label key={level}>
              <input
                type="checkbox"
                checked={draft.thinking_levels.includes(level)}
                disabled={
                  (draft.thinking_levels.length === 1 &&
                    draft.thinking_levels.includes(level)) ||
                  (budgetThinking &&
                    (level === "xhigh" || level === "max") &&
                    !draft.thinking_levels.includes(level))
                }
                onChange={(e) => {
                  const selected = levels.filter((item) =>
                    item === level
                      ? e.target.checked
                      : draft.thinking_levels.includes(item),
                  );
                  const [first, ...rest] = selected;
                  if (first)
                    change({
                      ...draft,
                      thinking_levels: [first, ...rest],
                      reasoning_supported:
                        draft.reasoning_supported ||
                        selected.some((level) => level !== "off"),
                      default_thinking: selected.includes(
                        draft.default_thinking,
                      )
                        ? draft.default_thinking
                        : first,
                    });
                }}
              />
              {levelLabel[level]}
            </label>
          ))}
        </div>
      </fieldset>
      <label>
        默认思考档位
        <select
          aria-label="默认思考档位"
          value={draft.default_thinking}
          onChange={(e) => {
            const level = levels.find((level) => level === e.target.value);
            if (level) change({ ...draft, default_thinking: level });
          }}
        >
          {levels.map((level) => (
            <option
              key={level}
              disabled={!draft.thinking_levels.includes(level)}
              value={level}
            >
              {levelLabel[level]}
            </option>
          ))}
        </select>
      </label>
      <p className="configuration-help">
        按供应商能力填写；接入未知 Model ID 不会验证供应商是否实际支持所选档位。
      </p>
      <fieldset>
        <legend>容量与限额</legend>
        <p className="configuration-help">
          按供应商已核实文档填写；目录外型号不猜窗口。字段含义：总上下文
          tokens（模型总窗口）、最大输入 tokens（请求输入策略）、最大输出
          tokens（含思考的单次输出）、请求体 MiB（完整 JSON 字节）、请求超时秒。
        </p>
        {providerId === "deepseek" && draft.model_id === "deepseek-flash" && (
          <div className="configuration-grid">
            <button
              type="button"
              onClick={() =>
                change({ ...draft, ...deepseekInitialValues })
              }
            >
              填入 DeepSeek Flash 已核对初值（1M 窗口）
            </button>
            <button
              type="button"
              onClick={() =>
                change({
                  ...draft,
                  ...deepseekInitialValues,
                  ...deepseekLongOutput,
                })
              }
            >
              长输出档（输出 131072）
            </button>
          </div>
        )}
        {(() => {
          if (draft.context_window === undefined) {
            return (
              <p className="capacity-summary warning">
                尚未声明总上下文；保存前需按此型号已核实的能力填写。历史消息仍按原配置执行。
              </p>
            );
          }
          const problem = capacityProblem(draft);
          return (
            <p className={"capacity-summary" + (problem ? " warning" : "")}>
              {problem
                ? `容量校验提示：${problem}`
                : `已声明容量关系：总窗口 ${draft.context_window.toLocaleString()} tokens · 单次输入上限 ${(draft.input_limit ?? 0).toLocaleString()} · 单次输出上限 ${(draft.output_limit ?? 0).toLocaleString()}`}
            </p>
          );
        })()}
        <div className="configuration-grid">
          {(
            [
              ["context_window", "总上下文 tokens", 1024, 2000000, 1],
              ["input_limit", "最大输入 tokens", 1024, 2000000, 1],
              [
                "output_limit",
                "最大输出 tokens",
                1,
                393216,
                protocol === "openai-responses"
                  ? 16
                  : budgetThinking &&
                      draft.thinking_levels.some((level) => level !== "off")
                    ? 2048
                    : 1,
              ],
            ] as const
          ).map(([key, label, min, max, fieldMin]) => (
            <label key={key}>
              {label}
              <input
                type="number"
                required
                min={Math.max(min, fieldMin)}
                max={max}
                step={1}
                value={draft[key] ?? ""}
                onChange={(e) =>
                  change({
                    ...draft,
                    [key]:
                      e.target.value === "" ? undefined : Number(e.target.value),
                  })
                }
              />
            </label>
          ))}
        </div>
        <div className="configuration-grid">
          <label>
            请求体 MiB
            <input
              type="number"
              required
              min={2048 / 1048576}
              max={8}
              step="any"
              value={payloadMib}
              onChange={(e) => {
                const raw = e.target.value;
                setPayloadMib(raw);
                const parsed = raw.trim() === "" ? NaN : Number(raw);
                change({
                  ...draft,
                  payload_bytes_limit: Number.isFinite(parsed)
                    ? Math.round(parsed * 1048576)
                    : undefined,
                });
              }}
            />
          </label>
          <label>
            请求超时秒
            <input
              type="number"
              required
              min={1}
              max={600}
              step={1}
              value={
                draft.request_timeout_ms === undefined
                  ? ""
                  : draft.request_timeout_ms / 1000
              }
              onChange={(e) =>
                change({
                  ...draft,
                  request_timeout_ms:
                    e.target.value === ""
                      ? undefined
                      : Math.round(Number(e.target.value) * 1000),
                })
              }
            />
          </label>
          <label>
            能力来源
            <select
              aria-label="能力来源"
              required
              value={draft.capability_source ?? ""}
              onChange={(e) => {
                const value = e.target.value;
                if (value === "sdk_catalog" || value === "admin_declared")
                  change({
                    ...draft,
                    capability_source: value,
                  });
              }}
            >
              <option value="" disabled>
                请选择
              </option>
              <option value="sdk_catalog">SDK 目录</option>
              <option value="admin_declared">管理员声明</option>
            </select>
          </label>
        </div>
      </fieldset>
      <fieldset>
        <legend>计价信息</legend>
        <p className="configuration-help">
          单位：美元 / 百万
          tokens。输入价按未命中缓存价填写，用于保守预留和内部用量估算；不代表供应商账单。
        </p>
        <div className="configuration-grid">
          {(
            [
              ["input_rate", "输入价格"],
              ["output_rate", "输出价格"],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              {label}
              <input
                type="number"
                required
                min={0}
                max={999999.999999}
                step={0.000001}
                value={draft[key] === "" ? "" : Number(draft[key]) / 1000000}
                onChange={(e) =>
                  change({
                    ...draft,
                    [key]:
                      e.target.value === ""
                        ? ""
                        : String(Math.round(Number(e.target.value) * 1000000)),
                  })
                }
              />
            </label>
          ))}
        </div>
      </fieldset>
      <label className="configuration-checkbox">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => change({ ...draft, enabled: e.target.checked })}
        />
        启用模型
      </label>
    </>
  );
}

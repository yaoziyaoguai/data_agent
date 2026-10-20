import { useEffect, useState } from "react";
import type {
  ModelConfiguration,
  ModelDefinition,
  ModelService,
  SaveModelDefinition,
  SaveModelService,
} from "../../../../../packages/contracts/generated/boundary.ts";
import { api } from "../../shared/api.ts";
import { Modal } from "../../shared/Modal.tsx";
import { useUnsavedChanges } from "../../shared/UnsavedChanges.tsx";
import "./model-configuration.css";

type Editor =
  | { kind: "service"; draft: SaveModelService; original: string }
  | { kind: "model"; draft: SaveModelDefinition; original: string };
const levels: SaveModelDefinition["thinking_levels"] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const levelLabel = {
  off: "关闭",
  minimal: "最轻",
  low: "轻度",
  medium: "中等",
  high: "深度",
  xhigh: "更深",
  max: "最高",
};
const protocolLabel = {
  "openai-completions": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
  "anthropic-messages": "Anthropic Messages",
};
function serviceDraft(value: ModelService): SaveModelService {
  const { version, credential_configured, ...draft } = value;
  return { ...draft, expected_version: version };
}
function modelDraft(value: ModelDefinition): SaveModelDefinition {
  const { version, ...draft } = value;
  return { ...draft, expected_version: version };
}
function explanation(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  return (
    (
      {
        forbidden: "当前账号没有模型配置权限。",
        version_conflict:
          "其他管理员已更新配置。你的输入已保留；请关闭编辑并重新读取，再核对修改。",
        invalid_input: "请检查必填项、数值和默认思考档位。",
        invalid_model_endpoint:
          "服务地址需要 HTTPS，不能使用本机、私有地址、账户信息或查询参数。",
        model_credential_required:
          "新服务或修改连接目标时，需要重新提供 API Key。",
        model_secret_unavailable:
          "无法读取密钥存储，请联系服务维护者检查主密钥文件。",
        model_unavailable: "模型或关联服务已停用，请重新读取配置。",
      } as Record<string, string>
    )[code] ?? "未确认保存成功，请保留输入后重试。"
  );
}
export function ModelConfigurationPage() {
  const [configuration, setConfiguration] = useState<ModelConfiguration | null>(
    null,
  );
  const [editor, setEditor] = useState<Editor | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [denied, setDenied] = useState(false);
  const leave = useUnsavedChanges(
    !!editor && JSON.stringify(editor.draft) !== editor.original,
  );
  async function reload() {
    setBusy(true);
    setError("");
    try {
      setConfiguration(await api("ModelConfiguration", "/model-configuration"));
      setDenied(false);
    } catch (e) {
      setError(explanation(e));
      if (e instanceof Error && e.message === "forbidden") {
        setDenied(true);
        setConfiguration(null);
        setEditor(null);
      }
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void reload();
  }, []);
  function editService(value?: ModelService) {
    const draft: SaveModelService = value
      ? serviceDraft(value)
      : {
          id: crypto.randomUUID(),
          name: "",
          provider_id: "compatible",
          api: "openai-completions",
          base_url: "",
          enabled: true,
          expected_version: "0",
        };
    setEditor({ kind: "service", draft, original: JSON.stringify(draft) });
    setError("");
    setNotice("");
  }
  function editModel(value?: ModelDefinition) {
    const draft: SaveModelDefinition = value
      ? modelDraft(value)
      : {
          id: crypto.randomUUID(),
          service_id: configuration?.services[0]?.id ?? "",
          model_id: "",
          label: "",
          thinking_levels: ["off"],
          reasoning_supported: false,
          default_thinking: "off",
          input_limit: 65536,
          output_limit: 8192,
          payload_bytes_limit: 131072,
          input_rate: "0",
          output_rate: "0",
          enabled: true,
          expected_version: "0",
        };
    setEditor({ kind: "model", draft, original: JSON.stringify(draft) });
    setError("");
    setNotice("");
  }
  async function save(path: string, input: unknown, close = false) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      setConfiguration(await api("ModelConfiguration", path, "POST", input));
      if (close) {
        leave.markSaved();
        setEditor(null);
      }
      setNotice("配置已保存。从下一条消息生效；已停用的模型将停止后续请求。");
    } catch (e) {
      setError(explanation(e));
    } finally {
      setBusy(false);
    }
  }
  if (denied)
    return (
      <section className="model-configuration">
        <h1>模型配置</h1>
        <p role="alert">{error}</p>
      </section>
    );
  if (!configuration)
    return (
      <section className="model-configuration">
        <h1>模型配置</h1>
        {error ? (
          <>
            <p role="alert">{error}</p>
            <button onClick={() => void reload()}>重试</button>
          </>
        ) : (
          <p>正在读取配置…</p>
        )}
      </section>
    );
  return (
    <section className="model-configuration">
      <header className="configuration-heading">
        <div>
          <h1>模型配置</h1>
          <p>管理本空间的服务连接和可选模型。仅超级管理员可以查看和修改。</p>
        </div>
        <button disabled={busy} onClick={() => void reload()}>
          重新读取
        </button>
      </header>
      {!editor && error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <section aria-labelledby="services-title">
        <header>
          <div>
            <h2 id="services-title">服务连接</h2>
            <p>同一个服务可以添加多个模型。API Key 保存后不再显示。</p>
          </div>
          <button
            className="primary"
            disabled={busy}
            onClick={() => editService()}
          >
            添加服务
          </button>
        </header>
        {!configuration.services.length ? (
          <p className="configuration-empty">
            先添加服务地址和 API Key，再添加该服务提供的模型。
          </p>
        ) : (
          <div className="configuration-list">
            {configuration.services.map((service) => (
              <article key={service.id}>
                <div>
                  <h3>
                    {service.name}{" "}
                    <span className="configuration-state">
                      {service.enabled ? "启用" : "停用"}
                    </span>
                  </h3>
                  <p>
                    {protocolLabel[service.api]} ·{" "}
                    {service.credential_configured ? "密钥已设置" : "缺少密钥"}
                  </p>
                  <p className="configuration-address">{service.base_url}</p>
                </div>
                <div className="configuration-actions">
                  <button
                    disabled={busy}
                    aria-label={"编辑服务 " + service.name}
                    onClick={() => editService(service)}
                  >
                    编辑
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void save("/model-services", {
                        ...serviceDraft(service),
                        enabled: !service.enabled,
                      })
                    }
                  >
                    {service.enabled ? "停用" : "启用"}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      <section aria-labelledby="models-title">
        <header>
          <div>
            <h2 id="models-title">可选模型</h2>
            <p>
              添加供应商的 Model ID
              和能力。默认模型用于新对话，已有对话保留自己的选择。
            </p>
          </div>
          <button
            className="primary"
            disabled={busy || !configuration.services.length}
            onClick={() => editModel()}
          >
            添加模型
          </button>
        </header>
        {!configuration.models.length ? (
          <p className="configuration-empty">尚未添加模型。</p>
        ) : (
          <div className="configuration-list">
            {configuration.models.map((model) => {
              const service = configuration.services.find(
                (s) => s.id === model.service_id,
              );
              return (
                <article key={model.id}>
                  <div>
                    <h3>
                      {model.label}{" "}
                      <span className="configuration-state">
                        {!model.enabled
                          ? "停用"
                          : !service?.enabled
                            ? "服务已停用"
                            : "启用"}
                        {configuration.default_model_id === model.id
                          ? " · 默认"
                          : ""}
                      </span>
                    </h3>
                    <p>
                      {service?.name} · {model.model_id}
                    </p>
                    <p>
                      思考：
                      {model.thinking_levels
                        .map((level) => levelLabel[level])
                        .join("、")}{" "}
                      · 上下文 {model.input_limit.toLocaleString()} tokens
                    </p>
                  </div>
                  <div className="configuration-actions">
                    <button
                      disabled={busy}
                      aria-label={"编辑模型 " + model.label}
                      onClick={() => editModel(model)}
                    >
                      编辑
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void save("/model-definitions", {
                          ...modelDraft(model),
                          enabled: !model.enabled,
                        })
                      }
                    >
                      {model.enabled ? "停用" : "启用"}
                    </button>
                    <button
                      disabled={
                        busy ||
                        !model.enabled ||
                        !service?.enabled ||
                        configuration.default_model_id === model.id
                      }
                      onClick={() =>
                        void save("/model-configuration/default", {
                          model_id: model.id,
                          expected_version: configuration.version,
                        })
                      }
                    >
                      设为默认
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
        {!!configuration.models.length &&
          !configuration.models.some(
            (m) =>
              m.id === configuration.default_model_id &&
              m.enabled &&
              configuration.services.some(
                (s) => s.id === m.service_id && s.enabled,
              ),
          ) && (
            <p role="status">
              尚无可用的默认模型。请选择一个启用模型设为默认；现有对话的选择不会自动更改。
            </p>
          )}
      </section>
      {editor && (
        <Modal
          title={
            editor.draft.expected_version === "0"
              ? editor.kind === "service"
                ? "添加服务"
                : "添加模型"
              : editor.kind === "service"
                ? "编辑服务"
                : "编辑模型"
          }
          className="configuration-dialog"
          onClose={() => {
            if (!busy) leave(() => setEditor(null));
          }}
          footer={
            <>
              <button
                disabled={busy}
                onClick={() => leave(() => setEditor(null))}
              >
                取消
              </button>
              <button
                form="model-configuration-form"
                className="primary"
                type="submit"
                disabled={busy}
              >
                {busy ? "保存中…" : "保存配置"}
              </button>
            </>
          }
        >
          <form
            id="model-configuration-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy)
                void save(
                  editor.kind === "service"
                    ? "/model-services"
                    : "/model-definitions",
                  editor.draft,
                  true,
                );
            }}
          >
            {editor.kind === "service" ? (
              <ServiceFields
                draft={editor.draft}
                change={(draft) => setEditor({ ...editor, draft })}
              />
            ) : (
              <ModelFields
                draft={editor.draft}
                services={configuration.services}
                change={(draft) => setEditor({ ...editor, draft })}
              />
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
          </form>
        </Modal>
      )}
    </section>
  );
}
function ServiceFields({
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
                    value === "anthropic"
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
            draft.api === "anthropic-messages"
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
function ModelFields({
  draft,
  services,
  change,
}: {
  draft: SaveModelDefinition;
  services: ModelService[];
  change: (draft: SaveModelDefinition) => void;
}) {
  const protocol = services.find(
    (service) => service.id === draft.service_id,
  )?.api;
  const budgetThinking =
    protocol === "anthropic-messages" &&
    draft.anthropic_thinking_mode !== "adaptive";
  return (
    <>
      <label>
        所属服务
        <select
          aria-label="所属服务"
          required
          value={draft.service_id}
          onChange={(e) => {
            const next = { ...draft, service_id: e.target.value };
            if (
              services.find((service) => service.id === next.service_id)
                ?.api !== "anthropic-messages"
            )
              delete next.anthropic_thinking_mode;
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
      <div className="configuration-grid">
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
      {protocol === "anthropic-messages" && (
        <label>
          Anthropic 思考方式
          <select
            aria-label="Anthropic 思考方式"
            value={draft.anthropic_thinking_mode ?? "budget"}
            onChange={(e) => {
              if (e.target.value === "budget" || e.target.value === "adaptive")
                change({ ...draft, anthropic_thinking_mode: e.target.value });
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
      <div className="configuration-grid">
        {(
          [
            ["input_limit", "上下文上限（tokens）", 1024, 2000000],
            ["output_limit", "输出上限（tokens）", 1, 131072],
            ["payload_bytes_limit", "请求体上限（字节）", 2048, 8388608],
          ] as const
        ).map(([key, label, min, max]) => (
          <label key={key}>
            {label}
            <input
              type="number"
              required
              min={
                key === "output_limit"
                  ? protocol === "openai-responses"
                    ? 16
                    : budgetThinking &&
                        draft.thinking_levels.some((level) => level !== "off")
                      ? 2048
                      : min
                  : min
              }
              max={max}
              step={1}
              value={draft[key]}
              onChange={(e) =>
                change({ ...draft, [key]: Number(e.target.value) })
              }
            />
          </label>
        ))}
      </div>
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

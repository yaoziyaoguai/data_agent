import { useEffect, useState } from "react";
import type {
  ModelConfiguration,
  ModelDefinition,
  ModelService,
  SaveModelDefinition,
  SaveModelService,
} from "../../../../../packages/contracts/generated/boundary.ts";
import { ModelFields, ServiceFields } from "./ModelConfigurationFields.tsx";
import { capacityProblem, initialCapacity, levelLabel, modelDraft, protocolLabel, serviceDraft, type ModelDraft } from "./model-configuration-draft.ts";
import { api } from "../../shared/api.ts";
import { Modal } from "../../shared/Modal.tsx";
import { useUnsavedChanges } from "../../shared/UnsavedChanges.tsx";
import "./model-configuration.css";

type Editor =
  | { kind: "service"; draft: SaveModelService; original: string }
  | { kind: "model"; draft: ModelDraft; original: string };

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
        model_capacity_invalid:
          "容量组合不可行：总上下文、最大输入与最大输出的组合放不下历史、工具预留和两段摘要。请调整总上下文或最大输出。",
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
    const draft: ModelDraft = value
      ? modelDraft(value)
      : {
          id: crypto.randomUUID(),
          service_id: configuration?.services[0]?.id ?? "",
          model_id: "",
          label: "",
          thinking_levels: ["off"],
          reasoning_supported: false,
          default_thinking: "off",
          ...initialCapacity(),
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
                      · 总上下文{" "}
                      {(model.context_window ?? model.input_limit).toLocaleString()}{" "}
                      tokens
                      {model.context_window
                        ? ` · 最大输出 ${model.output_limit.toLocaleString()} tokens · 超时 ${Math.round(model.request_timeout_ms! / 1000)} 秒`
                        : " · 旧配置（未声明总窗口）"}
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
              if (busy) return;
              if (editor.kind === "model") {
                const problem = capacityProblem(editor.draft);
                if (problem) {
                  setError(problem);
                  return;
                }
              }
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

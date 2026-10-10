import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationModelSelection, ModelCatalog, ModelSelection } from "../../../../../packages/contracts/generated/boundary.ts";
import { api } from "../../shared/api.ts";

export function useModelSelection(user: string, conversationId: string | null) {
  const key = user + ":" + (conversationId ?? "new");
  const generation = useRef(0);
  const [state, setState] = useState<{ key: string; catalog: ModelCatalog; settings: ConversationModelSelection } | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const path = "/conversations/" + conversationId + "/model-selection";
  const reload = useCallback(async () => {
    const request = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const [catalog, settings] = await Promise.all([
        api("ModelCatalog", "/models"),
        conversationId ? api("ConversationModelSelection", "/conversations/" + conversationId + "/model-selection") : Promise.resolve({ selection: null, version: "0" }),
      ]);
      if (request === generation.current) setState({ key, catalog, settings });
    } catch {
      if (request === generation.current) {
        setState(null);
        setError("暂时无法读取模型设置，请重试。");
      }
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }, [key, conversationId]);
  useEffect(() => {
    void reload();
    return () => { ++generation.current; };
  }, [reload]);
  const current = state?.key === key ? state : null;
  const selection = current?.settings.selection ?? current?.catalog.default_selection ?? null;
  const change = async (choice: ModelSelection) => {
    if (!current || busy) return;
    const request = ++generation.current;
    setError("");
    if (!conversationId) {
      setState({ ...current, settings: { selection: choice, version: "0" } });
      return;
    }
    setBusy(true);
    try {
      const settings = await api("ConversationModelSelection", path, "POST", { selection: choice, expected_version: current.settings.version });
      if (request === generation.current) setState({ ...current, settings });
    } catch (e) {
      if (request !== generation.current) return;
      try {
        const settings = await api("ConversationModelSelection", path);
        if (request === generation.current) setState({ ...current, settings });
      } catch {
        if (request === generation.current) setState(null);
      }
      if (request === generation.current) setError(e instanceof Error && e.message === "version_conflict"
        ? "其他窗口更新了模型设置，已重新读取，请确认后再发送。"
        : "模型设置未确认保存，请检查当前选择后重试。");
    } finally {
      if (request === generation.current) setBusy(false);
    }
  };
  return { selection, models: current?.catalog.models ?? [], busy, error, ready: !!current && !busy, change, reload };
}

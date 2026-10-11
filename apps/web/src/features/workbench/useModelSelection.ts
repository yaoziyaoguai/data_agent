import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationModelSelection, ModelCatalog, ModelSelection } from "../../../../../packages/contracts/generated/boundary.ts";
import { api } from "../../shared/api.ts";
import { modelDraftStorageKey, readModelDraft } from "./conversation-storage.ts";

export function useModelSelection(space: string, user: string, conversationId: string | null) {
  const key = modelDraftStorageKey(space, user, conversationId);
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
      if (request === generation.current) {
        const draft = readModelDraft(space, user, conversationId);
        const available = draft && catalog.models.some(model => model.id === draft.model_id &&
          model.thinking_options.some(option => option.value === draft.thinking_level));
        if (settings.selection) localStorage.removeItem(key);
        setState({ key, catalog, settings: settings.selection || !available ? settings : { ...settings, selection: draft } });
      }
    } catch {
      if (request === generation.current) {
        setState(null);
        setError("暂时无法读取模型设置，请重试。");
      }
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }, [key, space, user, conversationId]);
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
      localStorage.setItem(key, JSON.stringify(choice));
      setState({ ...current, settings: { selection: choice, version: "0" } });
      return;
    }
    setBusy(true);
    try {
      const settings = await api("ConversationModelSelection", path, "POST", { selection: choice, expected_version: current.settings.version });
      if (request === generation.current) {
        localStorage.removeItem(key);
        setState({ ...current, settings });
      }
    } catch (e) {
      if (request !== generation.current) return;
      try {
        const settings = await api("ConversationModelSelection", path);
        if (request === generation.current) {
          // 尚未发言的会话可能来自选用方法；保存失败仍保留之前确认的本地选择。
          const draft = readModelDraft(space, user, conversationId);
          if (settings.selection) localStorage.removeItem(key);
          setState({ ...current, settings: settings.selection || !draft ? settings : { ...settings, selection: current.settings.selection } });
        }
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
  const observedGeneration = generation.current;
  const afterMessageSaved = () => {
    // 选用方法创建的空会话在首问时才保存模型；只刷新未被后续选择替代的初始设置。
    if (current?.settings.version === "0" && !busy && observedGeneration === generation.current) void reload();
  };
  return { selection, models: current?.catalog.models ?? [], busy, error, ready: !!current && !busy, change, reload, afterMessageSaved };
}

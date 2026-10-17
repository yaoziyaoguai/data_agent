import { useEffect, useRef, useState } from "react";
import type { SkillDraft } from "../../../../../packages/contracts/generated/boundary.ts";
import { api } from "../../shared/api.ts";

export type PendingSkillDraft = Extract<SkillDraft, {status: "pending"}>;

export function SkillDrafts({user, refreshKey, onEdit}: {
  user: string;
  refreshKey: number;
  onEdit: (draft: PendingSkillDraft) => void;
}) {
  const [drafts, setDrafts] = useState<SkillDraft[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const request = useRef(0);
  const active = useRef(true);
  const load = async (after = "") => {
    const current = ++request.current;
    setLoading(true);
    try {
      const result = await api("SkillDraftList", "/assets/skill-drafts" + (after ? `?after_id=${encodeURIComponent(after)}` : ""));
      if (!active.current || current !== request.current) return;
      setDrafts(previous => after ? [...previous, ...result.drafts] : result.drafts);
      setNext(result.next_after_id);
      setError("");
    } catch (failure) {
      if (active.current && current === request.current) setError(failure instanceof Error ? failure.message : "草稿暂时未能读取");
    } finally {
      if (active.current && current === request.current) setLoading(false);
    }
  };
  useEffect(() => {
    active.current = true;
    setDrafts([]); setNext(null); setNotice("");
    void load();
    return () => { active.current = false; request.current++; };
  }, [user, refreshKey]);
  const open = async (id: string) => {
    const current = ++request.current;
    setLoading(true); setError(""); setNotice("");
    try {
      const draft = await api("SkillDraft", `/assets/skill-drafts/${encodeURIComponent(id)}`);
      if (!active.current || current !== request.current) return;
      setDrafts(previous => previous.map(item => item.reference.draft_id === id ? draft : item));
      if (draft.status === "pending") onEdit(draft);
      else setNotice(draft.status === "confirmed" ? "这份方法已保存，请从我的 Skill 查看。" : "分析条件或来源已经变化，请在原对话中重新准备方法草稿。");
    } catch (failure) {
      if (active.current && current === request.current) setError(failure instanceof Error ? failure.message : "草稿暂时未能读取");
    } finally {
      if (active.current && current === request.current) setLoading(false);
    }
  };
  const visible = drafts.filter(draft => draft.status !== "confirmed");
  return <section aria-label="待确认的个人 Skill" className="skill-drafts">
    <div className="actions"><h2>待确认的个人 Skill{visible.length > 0 ? ` · ${visible.length}` : ""}</h2><button disabled={loading} onClick={() => void load()}>刷新草稿</button></div>
    {visible.length > 0 && <p className="quiet">来自你明确要保留的分析方法。核对并保存后，可以在需要的对话中选用。</p>}
    {visible.map(draft => <article className="asset-card" key={draft.reference.draft_id}>
      {draft.status === "pending" ? <><h3>{draft.name}</h3><p>{draft.scope}</p><button disabled={loading} onClick={() => void open(draft.reference.draft_id)}>核对并保存</button></>
        : <p role="status">{draft.status === "condition_changed" ? "分析条件已变化，这份未确认草稿已失效。" : "来源已不可用，这份未确认草稿已失效。"}请在原对话中重新准备。</p>}
    </article>)}
    {loading && <p role="status">正在核对草稿来源…</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {next && <button disabled={loading} onClick={() => void load(next)}>更多草稿</button>}
  </section>;
}

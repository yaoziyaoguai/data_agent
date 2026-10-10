import { useEffect, useState } from "react";
import { KnowledgeReference } from "../../shared/KnowledgeReference.tsx";
import { api } from "../../shared/api.ts";
import { semanticError as message } from "./semantic-commands.ts";
import {
  CorrectionComposer,
  type CorrectionContent,
} from "./CorrectionComposer.tsx";
import { ReviewCorrection } from "./ReviewCorrection.tsx";
import type {
  Proposal,
  SemanticCorrection,
  SemanticCorrectionList,
} from "../../../../../packages/contracts/generated/boundary.ts";
const labels = {
  submitted: "待处理",
  accepted: "已接受 · 待修改",
  rejected: "已驳回",
  applied: "已保存到正式语义",
};
export function SemanticCorrections({
  user,
  proposals,
  onSaved,
}: {
  user: string;
  proposals: Proposal[];
  onSaved: () => void;
}) {
  const [items, setItems] = useState<SemanticCorrection[]>([]),
    [next, setNext] = useState<string | null>(null),
    [error, setError] = useState("");
  const [compose, setCompose] = useState<{
    content: CorrectionContent;
    revision?: { id: string; value: string };
  } | null>(null);
  const [review, setReview] = useState<{
    correction: SemanticCorrection;
    action: "accepted" | "rejected" | "apply";
  } | null>(null);
  const [pageCount, setPageCount] = useState(1);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const values: SemanticCorrection[] = [];
        let cursor: string | null = null;
        for (let index = 0; index < pageCount; index++) {
          const page: SemanticCorrectionList = await api(
            "SemanticCorrectionList",
            "/semantic-corrections" +
              (cursor ? "?after_id=" + encodeURIComponent(cursor) : ""),
          );
          values.push(...page.corrections);
          cursor = page.next_after_id;
          if (!cursor) break;
        }
        if (live) {
          setItems(values);
          setNext(cursor);
          setError("");
        }
      } catch (e) {
        if (live) setError(message(e));
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [user, pageCount, reload]);
  const saved = () => {
    onSaved();
    setReload((v) => v + 1);
  };
  const loadMore = () => setPageCount((v) => v + 1);
  return (
    <section className="proposal-panel" aria-label="语义纠错协作">
      <h2>语义纠错协作</h2>
      <p className="quiet">
        我的提交与需要我处理的建议。接受后需另行核对、编辑并保存。
      </p>
      {proposals.length > 0 && (
        <details>
          <summary>我的私人草稿 · {proposals.length}</summary>
          {proposals.map((p) => (
            <article key={p.id}>
              <strong>
                <KnowledgeReference id={p.object_id} path={p.entry_id}/>
              </strong>
              <p>{p.reason}</p>
              <blockquote>{p.value}</blockquote>
              <button onClick={() => setCompose({ content: p })}>
                整理并提交给负责人
              </button>
            </article>
          ))}
        </details>
      )}
      {items.length === 0 && (
        <p className="quiet">
          暂无已提交的建议。可从语义条目的“提出纠错”开始。
        </p>
      )}
      {items.map((c) => (
        <article key={c.id} data-correction-id={c.id}>
          <div className="actions">
            <strong>
              <KnowledgeReference id={c.object_id} path={c.entry_id}/>
            </strong>
            <span className="status-pill">{labels[c.state]}</span>
          </div>
          <p>
            提出者 {c.submitter_id}
          </p>
          <p>{c.reason}</p>
          <details>
            <summary>查看修改与依据</summary>
            <h4>原内容</h4>
            <pre className="source-body">{c.original_value}</pre>
            <h4>建议内容</h4>
            <pre className="source-body">{c.value}</pre>
            <ul>
              {c.evidence.map((r, i) => (
                <li key={i}>
                  <KnowledgeReference id={r.object_id} path={r.path}/>
                </li>
              ))}
            </ul>
          </details>
          {c.review_reason && (
            <p>
              处理意见 · {c.reviewer_id}：{c.review_reason}
            </p>
          )}
          {c.applied_version && (
            <p>
              由 {c.applied_by} 保存：{c.applied_value}
            </p>
          )}
          <div className="actions">
            {c.can_revise && (
              <button
                onClick={() =>
                  setCompose({
                    content: c,
                    revision: { id: c.id, value: c.revision },
                  })
                }
              >
                修订建议
              </button>
            )}
            {c.can_review && c.state === "submitted" && (
              <>
                <button
                  onClick={() =>
                    setReview({ correction: c, action: "rejected" })
                  }
                >
                  驳回
                </button>
                <button
                  onClick={() =>
                    setReview({ correction: c, action: "accepted" })
                  }
                >
                  接受，待修改
                </button>
              </>
            )}
            {c.can_review && c.state === "accepted" && (
              <button
                className="primary"
                onClick={() => setReview({ correction: c, action: "apply" })}
              >
                核对并编辑保存
              </button>
            )}
          </div>
        </article>
      ))}
      {next && (
        <button onClick={() => void loadMore()}>加载更多纠错建议</button>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {compose && (
        <CorrectionComposer
          {...compose}
          onClose={() => setCompose(null)}
          onSaved={saved}
        />
      )}
      {review && (
        <ReviewCorrection
          {...review}
          onClose={() => setReview(null)}
          onSaved={saved}
        />
      )}
    </section>
  );
}

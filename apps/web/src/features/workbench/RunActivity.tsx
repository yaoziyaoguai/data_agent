import { useEffect, useState } from "react";
import type { RunSnapshot, RunStepSummary } from "../../../../../packages/contracts/generated/boundary.ts";
import { api } from "../../shared/api.ts";
import "./run-activity.css";

function Steps({ steps }: { steps: RunStepSummary[] }) {
  return <ol aria-label="已完成的运行步骤">
    {steps.map(({ category, target_name, duration_ms }, index) => <li key={index}>
      <span>{category}{target_name && <> · {target_name}</>}</span>
      <span className="step-duration">{duration_ms === null ? "耗时不可用" : `${duration_ms.toLocaleString("zh-CN")} ms`}</span>
    </li>)}
  </ol>;
}

export function RunActivity({ run, label, onStop }: { run: RunSnapshot; label: string; onStop: () => void }) {
  const steps = run.completed_step_summaries;
  return <section className="run-activity" aria-label="运行进度">
    <div className="activity">
      <span className="activity-current" role="status"><i aria-hidden="true"/>{label}</span>
      <button onClick={onStop}>停止生成</button>
    </div>
    {steps?.length ? <details className="run-steps" key={run.run_id}>
      <summary>已完成 {run.completed_steps ?? steps.length} 步</summary>
      <Steps steps={steps}/>
    </details> : run.completed_steps ? <p className="run-step-count">已完成 {run.completed_steps} 步</p> : null}
  </section>;
}

export function CompletedRunSteps({ cid, runId, authorityRevision }: {
  cid: string;
  runId: string;
  authorityRevision: number;
}) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<{
    revision: number;
    steps: RunStepSummary[] | null;
  } | null>(null);
  useEffect(() => {
    if (!open) {
      setLoaded(null);
      return;
    }
    const request = new AbortController();
    const path = "/conversations/" + encodeURIComponent(cid) + "/runs/" + encodeURIComponent(runId) + "/steps";
    void api("RunStepList", path, "GET", undefined, undefined, request.signal)
      .then(({steps}) => { if (!request.signal.aborted) setLoaded({revision: authorityRevision, steps}); })
      .catch(() => { if (!request.signal.aborted) setLoaded({revision: authorityRevision, steps: null}); });
    return () => request.abort();
  }, [open, cid, runId, authorityRevision]);
  const current = loaded?.revision === authorityRevision ? loaded : null;
  return <details className="run-steps" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>查看运行步骤</summary>
    {open && (!current ? <p role="status">正在读取运行步骤…</p>
      : current.steps === null ? <p role="alert">运行步骤暂时不可读取。</p>
      : current.steps.length ? <Steps steps={current.steps}/>
      : <p className="quiet">本次没有记录到工具步骤。</p>)}
  </details>;
}

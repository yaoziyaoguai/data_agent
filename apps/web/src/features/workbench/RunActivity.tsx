import type { RunSnapshot } from "../../../../../packages/contracts/generated/boundary.ts";
import "./run-activity.css";

export function RunActivity({ run, label, onStop }: { run: RunSnapshot; label: string; onStop: () => void }) {
  const steps = run.completed_step_summaries;
  return <section className="run-activity" aria-label="运行进度">
    <div className="activity">
      <span className="activity-current" role="status"><i aria-hidden="true"/>{label}</span>
      <button onClick={onStop}>停止生成</button>
    </div>
    {steps?.length ? <details className="run-steps" key={run.run_id}>
      <summary>已完成 {run.completed_steps ?? steps.length} 步</summary>
      <ol aria-label="已完成的运行步骤">
        {steps.map(({ category, target_name, duration_ms }, index) => <li key={index}>
          <span>{category}{target_name && <> · {target_name}</>}</span>
          <span className="step-duration">{duration_ms.toLocaleString("zh-CN")} ms</span>
        </li>)}
      </ol>
    </details> : run.completed_steps ? <p className="run-step-count">已完成 {run.completed_steps} 步</p> : null}
  </section>;
}

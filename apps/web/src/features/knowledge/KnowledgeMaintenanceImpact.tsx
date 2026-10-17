import { useEffect, useRef, useState } from "react";
import type { MaintenanceDependent, MaintenanceImpactKind, MaintenanceReference } from "../../../../../packages/contracts/generated/boundary.ts";
import { ApiError, api } from "../../shared/api.ts";
import { Tabs } from "../../shared/Tabs.tsx";
import { knowledgeKindLabels } from "../../shared/knowledge-labels.ts";

type ImpactPage = {
  key: string;
  items: MaintenanceDependent[];
  next: string | null;
  pending: boolean;
  error: string;
};
const referenceLabels: Record<MaintenanceReference["relation_kind"], string> = {
  structure: "计算结构",
  source_material: "采用的资料",
  query_example: "案例依据",
  skill: "方法依赖",
  related: "关联对象",
};
const stateLabels: Record<MaintenanceReference["reference_state"], string> = {
  current: "当前引用一致",
  version_changed: "知识已改版，需核对",
  unavailable: "知识已停用，需核对",
  related: "关联，未绑定版本",
};

export function KnowledgeMaintenanceImpact({ objectId, version }: {
  objectId: string;
  version: string;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<MaintenanceImpactKind>("knowledge");
  const key = `${objectId}:${version}:${kind}`;
  const [page, setPage] = useState<ImpactPage>({ key: "", items: [], next: null, pending: false, error: "" });
  const requestGeneration = useRef(0);
  const visible = page.key === key ? page : { key, items: [], next: null, pending: true, error: "" };
  const load = async (after: string | null = null) => {
    const generation = ++requestGeneration.current;
    setPage(old => ({ key, items: after && old.key === key ? old.items : [], next: after, pending: true, error: "" }));
    const params = new URLSearchParams({ kind, expected_version: version });
    if (after) params.set("after_id", after);
    try {
      const result = await api("MaintenanceImpact", `/knowledge/${encodeURIComponent(objectId)}/maintenance-impact?${params}`);
      if (generation !== requestGeneration.current) return;
      setPage(old => {
        const items = new Map((after && old.key === key ? old.items : []).map(item => [item.id, item]));
        for (const item of result.items) items.set(item.id, item);
        return { key, items: [...items.values()], next: result.next_after_id, pending: false, error: "" };
      });
    } catch (error) {
      if (generation !== requestGeneration.current) return;
      const message = error instanceof ApiError && error.code === "version_conflict"
        ? "知识已改版，请重新打开当前对象后查看维护影响。"
        : error instanceof ApiError && error.code === "not_available"
          ? "当前知识已不可读取，请返回目录核对。"
          : "维护影响读取失败，尚不能判断引用范围。请重试。";
      setPage(old => ({ key, items: after && old.key === key ? old.items : [], next: after, pending: false, error: message }));
    }
  };
  useEffect(() => {
    if (open) void load();
    return () => { ++requestGeneration.current; };
  }, [open, objectId, version, kind]);

  return <details className="knowledge-maintenance-impact" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>查看直接维护影响</summary>
    {open && <>
      <p className="quiet">这里列出已记录的直接引用，包括本空间公共知识、我的 Skill 与本空间公共 Skill。文字中的未记录引用和间接依赖需另行核对。</p>
      <Tabs label="维护影响范围" value={kind} onChange={value => setKind(value === "skill" ? "skill" : "knowledge")} items={[
        { value: "knowledge", label: "公共知识" },
        { value: "skill", label: "我的与公共 Skill" },
      ]}/>
      {visible.items.map(item => <article className="semantic-entry" key={item.id} data-dependent-id={item.id}>
        <div className="entry-head"><strong>{item.name}</strong><span className="status-pill">{item.state === "disabled" ? "已停用" : "已启用"}</span></div>
        <p className="quiet">{item.kind === "skill" ? item.visibility === "personal" ? "我的 Skill" : "空间公共 Skill" : knowledgeKindLabels[item.kind]} · {item.can_edit ? "可维护" : "可查看"}</p>
        <ul>{item.references.map((reference, index) => <li key={index} data-reference-state={reference.reference_state}>
          {referenceLabels[reference.relation_kind]} · {stateLabels[reference.reference_state]}
        </li>)}</ul>
        <details className="technical-details"><summary>引用详情</summary>
          <p>对象版本 {item.version}</p>
          <ul>{item.references.map((reference, index) => <li key={index}>
            {reference.dependent_path}
            {reference.referenced_version !== null && ` · 绑定版本 ${reference.referenced_version}`}
            {reference.referenced_path && ` · ${reference.referenced_path}`}
          </li>)}</ul>
        </details>
        {!item.references_complete && <p className="quiet">该对象的引用位置较多，此处展示前 50 条；请维护时继续核对完整对象。</p>}
      </article>)}
      {visible.pending && <p role="status">正在读取维护影响…</p>}
      {!visible.pending && !visible.error && visible.items.length === 0 && <p className="quiet">这个范围内尚未记录直接引用。</p>}
      {visible.error && <p className="error" role="alert">{visible.error}</p>}
      <div className="actions">
        {visible.next && !visible.error && <button disabled={visible.pending} onClick={() => void load(visible.next)}>加载更多直接引用</button>}
        {visible.error && <button disabled={visible.pending} onClick={() => void load(visible.next)}>重试读取维护影响</button>}
      </div>
    </>}
  </details>;
}

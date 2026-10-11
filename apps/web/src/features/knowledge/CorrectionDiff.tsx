/** 保留全文供核对，默认只展示首尾相同段落之间的实际改动。 */
export function CorrectionDiff({ before, after }: { before: string; after: string }) {
  const original = before.split("\n"), proposed = after.split("\n");
  let start = 0, end = 0;
  while (start < original.length && start < proposed.length && original[start] === proposed[start]) start++;
  while (end < original.length - start && end < proposed.length - start && original[original.length - 1 - end] === proposed[proposed.length - 1 - end]) end++;
  const oldPart = original.slice(start, original.length - end).join("\n");
  const newPart = proposed.slice(start, proposed.length - end).join("\n");
  return <div className="correction-diff">
    {before === after ? <p className="quiet">正文没有变化。</p> : <>
      {(start > 0 || end > 0) && <p className="quiet">已省略前后未改动的内容。</p>}
      <div className="correction-before"><strong>修改前</strong><pre className="source-body">{oldPart || "（新增内容）"}</pre></div>
      <div className="correction-after"><strong>修改后</strong><pre className="source-body">{newPart || "（删除内容）"}</pre></div>
    </>}
    <details><summary>查看完整对照</summary><h4>原内容</h4><pre className="source-body">{before}</pre><h4>建议内容</h4><pre className="source-body">{after}</pre></details>
  </div>;
}

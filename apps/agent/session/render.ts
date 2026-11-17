// 流式标记渲染：与Rust analysis_answers::substitute同一替换规则，只做字符串拼接，
// 不重复业务校验或数值计算。普通文字立即流出；只缓存可能尚未闭合的标记尾部；
// 替换值不再扫描；未知/孤儿/未闭合标记原样流出且本条不定稿，不静默删字。
export type RenderFinish =
  | {ok: true; display: string; emit: string}
  | {ok: false; error: "answer_render_invalid"};

export function renderedStream(bindings: Record<string, string>) {
  let pending = "";
  let display = "";
  let invalid = false;
  const push = (delta: string): string => {
    let buffer = pending + delta;
    pending = "";
    let emitted = "";
    while (true) {
      const start = buffer.indexOf("{{");
      if (start < 0) {
        // 尾部连续"}"可能与后续增量组成孤儿"}}"，单个尾"{"可能补成标记开头"{{"：
        // 两者都先缓存再定论；其余普通文字立即流出。无"{{"时全串最多一个"{"。
        let keep = 0;
        while (keep < buffer.length && buffer[buffer.length - 1 - keep] === "}") keep++;
        if (keep === 0 && buffer.endsWith("{")) keep = 1;
        const flush = keep > 0 ? buffer.slice(0, -keep) : buffer;
        pending = keep > 0 ? buffer.slice(-keep) : "";
        emitted += flush;
        display += flush;
        if (buffer.includes("}}")) invalid = true;
        return emitted;
      }
      emitted += buffer.slice(0, start);
      display += buffer.slice(0, start);
      const after = buffer.slice(start + 2);
      const end = after.indexOf("}}");
      if (end < 0) {
        // 已开始的双花括号标记尚未闭合：整段缓存等待后续增量，不提前流出。
        pending = buffer.slice(start);
        return emitted;
      }
      const name = after.slice(0, end);
      const bound = bindings[name];
      if (bound === undefined) {
        emitted += `{{${name}}}`;
        display += `{{${name}}}`;
        invalid = true;
      } else {
        emitted += bound;
        display += bound;
      }
      buffer = after.slice(end + 2);
    }
  };
  const finish = (requiredSuffix: string): RenderFinish => {
    let held = "";
    if (pending) {
      // 缓存只可能因未闭合标记、待定论"}"尾或单个尾"{"存在；
      // 含"{{"即未闭合，连续"}}”即孤儿；单个"{"是普通文字。
      invalid = invalid || pending.includes("{{") || pending.includes("}}");
      display += pending;
      held = pending;
      pending = "";
    }
    if (invalid) return {ok: false, error: "answer_render_invalid"};
    const text = display + requiredSuffix;
    if (!text.trim() || [...text].length > 8000) return {ok: false, error: "answer_render_invalid"};
    // emit是finish时尚未流出的合法残留加后缀，由调用方一次送出，
    // 保证所有展示delta拼接 == display == 正式正文。
    return {ok: true, display: text, emit: held + requiredSuffix};
  };
  return {push, finish};
}

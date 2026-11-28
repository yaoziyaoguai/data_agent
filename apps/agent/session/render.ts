// 流式标记渲染：与Rust analysis_answers::substitute同一替换规则，只做字符串拼接，
// 不重复业务校验或数值计算。普通文字立即流出；只缓存可能尚未闭合的标记尾部；
// 替换值不再扫描；未知/孤儿/未闭合标记原样流出且本条不定稿，不静默删字。
export type RenderFinish =
  | {ok: true; display: string; emit: string}
  | {ok: false; error: "answer_render_invalid"};

function formatBound(rendered: string, inCodeSpan: boolean): string {
  let output = "";
  for (const c of rendered) {
    if (c === "\n" || c === "\r") {
      output += " ";
    } else if (inCodeSpan) {
      output += c === "`" ? "'" : c;
    } else {
      if ("\\`*_[]<>|#".includes(c)) output += "\\";
      output += c;
    }
  }
  return output;
}

export function renderedStream(
  bindings: Record<string, string>,
  requiredMarkers: readonly string[] = [],
) {
  let pending = "";
  let display = "";
  let invalid = false;
  let codeTicks = 0;
  let newlines = 0;
  const used = new Set<string>();
  const advanceCodeSpan = (segment: string) => {
    for (let i = 0; i < segment.length; ) {
      const c = segment[i];
      if (c === "`") {
        newlines = 0;
        let run = 1;
        while (i + run < segment.length && segment[i + run] === "`") run++;
        if (codeTicks === 0) codeTicks = run;
        else if (codeTicks === run) codeTicks = 0;
        i += run;
      } else {
        if (c === "\n") {
          newlines += 1;
          if (newlines >= 2) codeTicks = 0;
        } else if (c !== "\r") {
          newlines = 0;
        }
        i += 1;
      }
    }
  };
  const push = (delta: string): string => {
    let buffer = pending + delta;
    pending = "";
    let emitted = "";
    while (true) {
      const start = buffer.indexOf("{{");
      if (start < 0) {
        // 尾部连续"}"可能与后续增量组成孤儿"}}"，单个尾"{"可能补成标记开头"{{"，
        // 尾部连续"`"需等下一非反引号字符确认代码围栏长度：先缓存再定论。
        let keep = 0;
        while (keep < buffer.length && buffer[buffer.length - 1 - keep] === "}") keep++;
        if (keep === 0 && buffer.endsWith("{")) keep = 1;
        else if (keep === 0) {
          while (keep < buffer.length && buffer[buffer.length - 1 - keep] === "`") keep++;
        }
        const flush = keep > 0 ? buffer.slice(0, -keep) : buffer;
        pending = keep > 0 ? buffer.slice(-keep) : "";
        advanceCodeSpan(flush);
        emitted += flush;
        display += flush;
        if (buffer.includes("}}")) invalid = true;
        return emitted;
      }
      const prefix = buffer.slice(0, start);
      if (prefix.includes("}}")) invalid = true;
      advanceCodeSpan(prefix);
      emitted += prefix;
      display += prefix;
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
        newlines = 0;
        emitted += `{{${name}}}`;
        display += `{{${name}}}`;
        invalid = true;
      } else {
        used.add(name);
        const formatted = formatBound(bound, codeTicks > 0);
        if (formatted.length > 0) newlines = 0;
        emitted += formatted;
        display += formatted;
      }
      buffer = after.slice(end + 2);
    }
  };
  const finish = (requiredSuffix: string): RenderFinish => {
    let held = "";
    if (pending) {
      // 缓存只可能因未闭合标记、待定论"}"尾、单个尾"{"或尾部"`"存在；
      // 含"{{"即未闭合，连续"}}”即孤儿；单个"{"或尾部"`"是普通文字。
      invalid = invalid || pending.includes("{{") || pending.includes("}}");
      advanceCodeSpan(pending);
      display += pending;
      held = pending;
      pending = "";
    }
    for (const required of requiredMarkers) {
      if (!used.has(required)) invalid = true;
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

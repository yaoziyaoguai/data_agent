import assert from "node:assert/strict";
import { renderedStream } from "../../apps/agent/session/render.ts";

// 流式渲染与Rust substitute同规则的窄检查：各种delta切分下输出与批量替换一致。
const bindings = {rate: "98.5%", count: "200", total: "203"};
const template = "达成率为{{rate}}，对应{{count}} / {{total}}。";
const suffix = "\n\n范围说明：以上仅覆盖实际取得的结果，不能视作全量统计。";

// 任意切分下：拼接的增量等于最终展示，标记替换值不再扫描。
// 遍历每个单切分点（含两个"{"之间）并逐字符输入；finish把合法残留连同后缀一次补送。
const runCase = (pieces, label) => {
  const renderer = renderedStream(bindings);
  let streamed = "";
  for (const piece of pieces) streamed += renderer.push(piece);
  const finished = renderer.finish(suffix);
  assert.equal(finished.ok, true, label);
  assert.equal(streamed + finished.emit, finished.display, label);
  assert.equal(finished.display, "达成率为98.5%，对应200 / 203。" + suffix, label);
};
runCase([template], "整段");
for (let cut = 1; cut < template.length; cut++) {
  runCase([template.slice(0, cut), template.slice(cut)], `单切点${cut}`);
}
runCase([...template], "逐字符");

// 未闭合标记不定稿；已流出部分保留原文，不静默删字。
{
  const renderer = renderedStream(bindings);
  const streamed = renderer.push("达成率为{{ra");
  assert.equal(streamed, "达成率为");
  assert.equal(renderer.finish(suffix).ok, false);
}
// 未知标记原样流出且不定稿。
{
  const renderer = renderedStream(bindings);
  assert.equal(renderer.push("达成率为{{missing}}。"), "达成率为{{missing}}。");
  assert.equal(renderer.finish("").ok, false);
}
// 孤儿"}}”不定稿，包括跨增量补成的对；原文仍流出，不静默删字。
{
  const renderer = renderedStream(bindings);
  assert.equal(renderer.push("合计100%}"), "合计100%");
  assert.equal(renderer.push("}。"), "}}。");
  assert.equal(renderer.finish("").ok, false);
}
// 单个左花括号和单个尾部"}"是普通文字；残留经finish连同后缀一次补送。
{
  const renderer = renderedStream(bindings);
  const streamed = renderer.push("JSON示例 {\"a\":1} 剩余}");
  assert.equal(streamed, "JSON示例 {\"a\":1} 剩余");
  const finished = renderer.finish("");
  assert.equal(finished.ok, true);
  assert.equal(finished.display, "JSON示例 {\"a\":1} 剩余}");
  assert.equal(streamed + finished.emit, finished.display);
}
// 标记开头的两个"{"分在两次增量时不误拒：尾"{"先缓存，后续增量补成标记再替换。
{
  const renderer = renderedStream(bindings);
  assert.equal(renderer.push("成功率为{"), "成功率为");
  assert.equal(renderer.push("{rate}}。"), "98.5%。");
  const finished = renderer.finish("");
  assert.equal(finished.ok, true);
  assert.equal(finished.display, "成功率为98.5%。");
}
// 结束时仍是单个"{"按普通文字定稿，缓存经finish送出而不是丢弃。
{
  const renderer = renderedStream(bindings);
  const streamed = renderer.push("尾{");
  assert.equal(streamed, "尾");
  const finished = renderer.finish("。");
  assert.equal(finished.ok, true);
  assert.equal(finished.display, "尾{。");
  assert.equal(streamed + finished.emit, finished.display);
}
// 替换值中的花括号不递归解释。
{
  const renderer = renderedStream({nested: "a{{b}}c"});
  assert.equal(renderer.push("值{{nested}}尾"), "值a{{b}}c尾");
  assert.equal(renderer.finish("").ok, true);
}
// 嵌套双花括号按未知名拒绝（与Rust first-"}}”切分一致）。
{
  const renderer = renderedStream(bindings);
  renderer.push("{{ra{{te}}}");
  assert.equal(renderer.finish("").ok, false);
}
// 空白或超限正文不定稿。
{
  assert.equal(renderedStream(bindings).finish("").ok, false);
  const long = renderedStream({x: "字".repeat(8001)});
  long.push("{{x}}");
  assert.equal(long.finish("").ok, false);
}
console.log("check-rendered-text: ok");

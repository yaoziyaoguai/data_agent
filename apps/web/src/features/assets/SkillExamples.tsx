import { useState } from "react";
import { Modal } from "../../shared/Modal.tsx";
type SkillExample = { name: string; description: string; body: string; scope: string };

const examples: SkillExample[] = [
  {
    name: "收入概览", description: "看收入总额、渠道构成和变化原因。",
    scope: "收入与渠道分析；时间、币种或净收入口径不清时先询问。",
    body: "先确认统计时间、渠道和金额单位，查阅正式的收入定义。\n按总额、渠道构成、与上期的变化组织分析；资料不足时说明缺口。\n需要取数时展示 SQL 和条件，等用户在聊天中明确要求执行后查询。\n输出先给结论，再给数据表、口径依据和限制。没有数据支撑时不要推测原因。",
  },
  {
    name: "退款分析", description: "先问清退款口径，再查看分布和变化。",
    scope: "订单或金额退款分析；不能把退款金额换算成退货件数。",
    body: "先询问退款率的分母，并核对统计按支付时间还是退款发生时间。\n确认时间和筛选范围后，生成可核对的 SQL，等用户在聊天中明确要求执行。\n展示分子、分母和退款率，再按可用维度比较。\n说明部分退款、跨期退款和无支付订单时如何处理；缺少字段时直接说明。",
  },
  {
    name: "分析结果汇报", description: "把结果整理成适合分享的简明报告。",
    scope: "整理已获得的分析结果；新增查询仍需逐次确认。",
    body: "先用一小段话回答用户的问题。\n接着列出关键数据，注明时间、范围和金额单位。\n解释计算口径并引用采用的资料。\n最后说明数据限制和仍待核对的问题。\n只有结果能支持的判断才写入结论，不补造原因、数值或业务规则。",
  },
];

export function SkillExamples({ onChoose, disabled, hasDraft }: { onChoose: (value: SkillExample) => void; disabled: boolean; hasDraft: boolean }) {
  const [selected, setSelected] = useState("");
  const [expanded, setExpanded] = useState(true);
  const [pending, setPending] = useState<SkillExample | null>(null);
  const choose = (example: SkillExample) => { onChoose(example); setSelected(example.name); setExpanded(false); setPending(null); };
  return <section className="skill-examples" aria-label="分析方法示例">
    {selected && !expanded ? <div className="template-selection"><span>已采用「{selected}」，可以继续修改</span><button disabled={disabled} onClick={() => setExpanded(true)}>更换模板</button></div> : <><h3>从模板开始</h3><div>{examples.map(example => <article key={example.name}><strong>{example.name}</strong><p>{example.description}</p><button type="button" disabled={disabled} onClick={() => hasDraft ? setPending(example) : choose(example)}>{hasDraft ? "替换草稿为" : "使用"}{example.name}示例</button></article>)}</div></>}
    {pending && <Modal title="替换当前草稿？" onClose={() => setPending(null)} footer={<><button onClick={() => setPending(null)}>保留草稿</button><button className="primary" onClick={() => choose(pending)}>使用这个模板</button></>}><p>名称、内容和适用范围会换成「{pending.name}」的模板内容。</p></Modal>}
  </section>;
}

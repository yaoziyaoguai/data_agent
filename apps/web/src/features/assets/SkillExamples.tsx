import { useState } from "react";
import { Modal } from "../../shared/Modal.tsx";
type SkillExample = { name: string; description: string; body: string; scope: string };

const examples: SkillExample[] = [
  {
    name: "语音链路概览", description: "核对语音轮次、各阶段和最终处理结果。",
    scope: "座舱语音链路分析；先区分轮次、阶段尝试、取消和完整结果。",
    body: "先确认统计期间、车型/构建及用户关注的链路终点，查阅正式语音口径。\n分别统计合格轮次、处理成功、取消和缺失阶段，避免把多次ASR尝试当成多次用户请求。\n展示SQL和条件，等用户在聊天中明确要求执行；差值、比率与分位数在SQL中计算。\n结论引用实际结果并说明范围；阶段成功不代表动作成功或用户听完，不凭共现断言原因。",
  },
  {
    name: "端云耗时对比", description: "比较端侧与云端的原始耗时、重试及覆盖范围。",
    scope: "座舱语音阶段和端云路径对比；不把平均P95、重叠阶段相加或网络共现当作因果。",
    body: "先核对开始/结束时点和毫秒耗时字段，确定用最终尝试、首次成功还是所有尝试。\n按原始非空样本计算平均与最近秩P95，补充分子、分母、失败和取消数量。\n比较端侧/云端及车型/版本时说明样本构成差异；有回退的轮次单列。\nSQL先展示再按用户明确授权执行，结果引用具体来源，未知原因标为待验证。",
  },
  {
    name: "分析结果汇报", description: "把结果整理成适合分享的简明报告。",
    scope: "整理已获得的分析结果；新增查询仍需逐次确认。",
    body: "先用一小段话回答用户的问题。\n接着列出关键数据，注明时间、样本范围和单位。\n解释计算口径并引用采用的资料。\n最后说明数据限制和仍待核对的问题。\n只有结果能支持的判断才写入结论，不补造原因、数值或业务规则。",
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

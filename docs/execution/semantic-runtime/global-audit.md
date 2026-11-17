# 全项目审计入口

> 历史任务：审计报告已交付并完成[逐项复核](../../reviews/project-readiness-confirmation-20261102.md)。当前实施入口为[前置修复包](dogfood-readiness-repairs.md)及修订后的[09](integrated-dogfood.md)。下文“只审计、不修改09”和旧09指纹只描述当时审计范围，不约束新的实施任务，也不证明原审计者审过修订后的包。

目标：独立审计**09之前整个项目的完成度、与最终确认原型/使用方式/效果的差异、09执行包的正确性和覆盖**。包含既有产品、01–08及后续修复，不限最近diff。只写报告；不修改产品/测试/09，不执行付费模型、部署、提交或推送。保留全部未提交变化，不自动另开Agent或Oracle。

## 最少启动阅读

遵守已加载的AGENTS，不重复加载。本文件和 [09原文](integrated-dogfood.md) 是必读；[详细导航](global-audit-map.md)只按能力查对应行，**不是164个路径的必读清单**。不要先读完整CURRENT、所有设计/执行包/旧报告；疑点需要完整上下文时再补足。

先用下列命令摘取唯一当前记录，避免读约1MB历史；分支与工作树另用git简要核对。已关闭增量不是全项目通过。

```sh
python3 - <<'PY'
import json,re
from pathlib import Path
s=Path('docs/CURRENT.md').read_text()
m=json.loads(re.match(r'\A---\n(.*?)\n---',s,re.S).group(1)); i=m['delivery']['increment']
print(json.dumps({'revision':m['goal_revision'],'current_task':m['reason'],
 'increment':{k:i[k] for k in ['id','status','goal','review','evidence']}},ensure_ascii=False,indent=2))
PY
```

最近实现收据是 `.local/delivery/I2-SEMANTIC-DELIVERY-REPAIRS-result.json`：18条去重命令通过，准备时573份文件指纹匹配。证据摘要在 `.local/audits/project-readiness-20261102/evidence-index.json`，只需按疑点取字段，不输出整份hash/日志。它们不证明真实模型效果；旧dogfood也不能直接算本版通过或本版缺陷。

## 全范围扫描索引

每行都检查实际入口和完成依据；先覆盖全局，再深入高影响疑点。文件存在、声明和测试数量不能算完成。下表只给最短入口，缺路径/合同/测试定位时再看详细导航对应行。

路径前缀：`U=crates/data-agent/src/use_cases/`，`W=apps/web/src/features/`，`P=apps/agent/`。设计指 `docs/architecture/implementation-design.md`。

| 能力与要核的结果 | 入口；设计章节 |
| --- | --- |
| 工作台/历史/导航：三入口、结果优先、返回、编辑保护、窄屏可用 | W `workbench/Workbench.tsx`；系统设计§16；批准体验原型 |
| 同步：空库与更新、稳定身份、完整字段/负责人/单表SQL、后台进度 | U `catalog_import.rs`；W `knowledge/SourceSynchronization.tsx`；§17.2–3 |
| 文档/语义整理：任意长文、多关联、条件例外、出处、人工保护 | U `source_preparation.rs`、`knowledge_documents.rs`；§17.3/17.6 |
| 检索：raw/知识、词法/向量/标识、范围、相关排序、续页、失败表达 | U `knowledge.rs`；§17.5–6 |
| 依据交付：批量/定点读、支持与例外、容量及完整性不误报 | U `evidence_delivery.rs`、`knowledge_supports.rs`；§17.5–6 |
| 多轮/澄清：条件与时间口径继承、来源限制、自由回答与换题归属 | U `data_tools.rs`、`source_limits.rs`；§12/17.4 |
| 多任务答案：原文不丢、不混来源、恢复/刷新一致、控制与正文正确 | U `task_answers.rs`、`finish_run.rs`；§17.4 |
| SQL/查询：生成可用SQL、聊天授权、批量/取消/未知/晚到各归原任务 | U `query_workflow.rs`；W `workbench/QueryCard.tsx`；§10/12/13 |
| 结果/报告：数值和条件、分页/截断、图/CSV一致、历史可读、因果限制 | U `analysis_answers.rs`、`historical_analysis.rs`；W `workbench/AnalysisReport.tsx`；§13–14 |
| 语义维护/协作：负责人、创建者、纠错接受再保存、文档/计算规则可编辑 | U `semantic_governance.rs`；W `knowledge/KnowledgePage.tsx`；§4.2.1/15 |
| 记忆：可复用纠错、仅本次不保存、编辑/停用/删除、真实Mem0路径 | U `personal_memory.rs`；`apps/memory/service.py`；系统设计§11 |
| Skill/案例：草稿确认、显式选用、原生read、独立公共副本/来源有效性 | U `skill_drafts.rs`；P `session/skills.ts`；§9/15 |
| 模型：超级管理者配置可选项、用户选用、容量/超时冻结及端点能力 | U `model_configuration.rs`；P `session/capacity.ts`；§16/17.7 |
| Pi/后台：原生循环/压缩/取消/恢复、长期会话、慢检索与Worker续租 | P `session/deliver.ts`；`apps/worker/src/main.rs`；§17.4/17.7 |
| 升级：旧会话/回执/预算、内容回填→索引→新工具、统一版本与可复现配置 | `compatible-upgrade.md`、`scripts/development.py`；§17.8 |

所有行还查权限/来源/模型端点隔离、合同、owner、幂等/预算和短事务。全要求见 [覆盖表第1节](coverage-and-validation.md#1-全要求映射)（D01–D18、C01–C08、A01–A10）；对账不能漏掉未体现在最近diff里的要求。D18邀请/发布等已明确后置项，不冒充实现遗漏。

## 判断依据与已确认取舍

业务以最新明确决定、系统设计及实现设计对应章节为准，重点§17。体验以 `prototype/experience-preview/README.md`、`preview.html`和后续决定为准；CURRENT“正式页面体验优化”记录了批准。旧零售原型、固定演示回复不能覆盖新合同。区分已批准变化、实现退化、文档过期和未验证；未看当前渲染就不称视觉通过。

保持已定方案：MySQL正式内容＋Milvus公共索引＋Mem0个人记忆＋Pi原生Skill；一表一份生产SQL、手动全量比较/异步整理、格式未变复用/人工保护；文档不限定格式，同名字段不自动同义。没有SQL血缘不禁止合理JOIN，指标可有查询示例。千表是底库规模，单次查询按相关性取证，不设类型配额。

普通语义更新保留旧分析，当前采用另核验；不新增历史变更监听/提醒/重算、多生产者、重写/重排模型或Agent框架。每消息24次、连续临时失败3次，恢复/摘要沿原operation/origin/budget。tokens与字节分开，充分利用容量并复用Pi压缩。

已确认多答案单份与组合容量分开；同候选窗严格去重，跨新窗允许晚到同身份重现。不要重新判为必须撤销的缺陷；具体查§17.4–6和 `closure-repairs.md` 的R02/R07。

简洁性审查针对真实问题：重复Pi能力、影响正常能力的过度限制、同边界重复校验、无用抽象/helper/catch和重复测试。新增理论防护不算优化；不同边界/权限/状态变化重核不自动算重复。删除建议需交代保护的合同和保留职责，不按行数或helper数量定罪。

## 审09与交付

09必须核：08前提和实际切换、100项＋10条综合轨迹对全能力的覆盖、用例前置/清理顺序、应用库/平台/索引隔离、真实Node/Pi与Worker重启、UI与API证据区别、输入allowlist/52条独立参考隔离、8MiB/600秒验证的合理样本和授权、完整分母/失败attempt保留、文档图与现状一致。按能力查看 `docs/dogfood/cockpit/scenarios.json` 和对应规范/判分，不把参考答案送入产品。旧160项包不能混入新100项。

不默认重跑大套件或构建千表；先读已有证据，必要时做小而明确的无付费反证。不要堆审计过程输出、复述整份方案或生成新测试平台。缺动态证据就明确未验证，不用静态代码承诺真实质量。不得因节省额度把未查项写成通过。

提交 `docs/reviews/project-readiness-audit-20261102.md`（已有他人文件则用不冲突名）：

- 一张15行能力对账表：实现程度、已查入口/证据、体验或效果缺口、09覆盖。
- 全部实质发现，按影响排序，同根因合并：触发/后果、要求、`file:line`或反证、确定程度、最小修法/删除建议、是否阻断09。不预设数量，不只复述旧报告。
- 09结论及必要修改的具体步骤/观察/通过标准；区分“09前修 / 09验证 / 后置”。

已有表格能表达的内容不再写长段重复；有实质新问题则完整保留。额度将尽先保存已查范围和准确待查入口，不假称审完。最后回复主要结论及报告路径，等待讨论后实施。

# Dogfood收口执行包交叉审查（2026-11-15）

本轮交付是收口规格与交接，不是产品修复完成证明。当前产品仍有已证兼容缺陷、失败工程出口和未跑的真实原题；I3保持active，实施独审恢复pending。

## 方法与来源

- 本地先固定独立方案（`.local/audits/dogfood-closure-20261115/local-plan.md`），再取得Oracle独立执行包（`.local/audits/dogfood-closure-20261115/oracle-answer.md`），随后对照实际源码和本轮隔离证据合并。本地稿未发给Oracle。
- Oracle只收到事实（`.local/audits/dogfood-closure-20261115/facts.md`）与源码摘录（`.local/audits/dogfood-closure-20261115/code.md`），不含凭据、真实业务资料或全量CURRENT。其意见是静态审计，不声称执行仓库测试。
- 网页会话：会话链接留存本地证据。发送前和附件就绪后均记录`Power, item 5 of 5 (slider ARIA)`，模型选择策略current；不拿CLI请求的模型名当网页实际模型证据。
- **抓取限制如实记录：**网页已显示“回答已完成”，命令行旧选择器却仍等待，未取得CLI成功退出。本轮仅从元数据记录的同一target只读提取完整main正文，两次文本相同、无停止按钮且完成标记存在，保存4306字符答复后关闭确切自有Chrome；CLI因此exit1。不是重发、不是草稿，也没有第二次咨询。确切PID已退出、临时Profile已清理，来源Profile未动。抓取与清理证据（`.local/audits/dogfood-closure-20261115/oracle-provenance.json`）
- Oracle未按要求附最终YAML，也没有详细列齐F01–F10原题与所有本地命令；这些由本地规格补齐，不能称Oracle原稿已经完整。合并稿没有再送第二次Oracle，不称其逐字批准。

## 根因与交叉结论

| 项目 | 本地证据与Oracle判断 | 最终处置 |
| --- | --- | --- |
| 旧默认配置409 | 固定空间trial_id+整体配置fingerprint，删历史字段使自动初始化被当成重配置；隔离GET/POST均409 | 采用Oracle更准确的“默认引导缺失创建、存在保留”职责；显式重配置仍严格幂等。覆盖旧含字段、当前无字段、新空间及环境profile撤下四类 |
| 组合测试失败 | 本轮无filter实测3/7通过；旁路采样看见seq2旧任务被后例领取、新seq3仍queued，随后连锁错领；Oracle认可隔离根因 | 修fixture生命周期和领取身份；仍须整个未过滤7例通过，不改生产claim排序或恢复版本 |
| 租约失效 | 单例通过、本次组合第一例lease_lost；不能唯一归因Defender或产品未续租 | 采纳Oracle指出的“释放future先assert遮蔽prepare结果”：先采样释放、join后断言。补入场/续租/退出时序，按证据修；不延TTL、不反复刷绿 |
| 标题来源 | 纯Rust失败唯一差异是whole-object规范化空路径；Oracle同意期待值过期 | 保旧形状输入，显式完整规范期望；保持重排、原依赖及最后null断言，不能用被测merge生成答案 |
| 环境模型撤下 | 已托管定义仍有效；两方同意旧fixture前提失效 | 加撤环境仍可用正例；用现有配置接口真正停用会话选中模型，保拒绝无副作用与草稿恢复 |
| 预填上界 | payload字节检查+固定usage测试不证明token输入预留；两方均不称已证超支 | 沿真实完整装配补证明。证据成立只加测试；真实反例才修原发送/分批路径，不造token服务 |
| 非法null入口 | prepareArguments针对Pi规范化前的信息损失 | 必要边界保留，不能误当重复校验删除；不添加第二套ready状态或全量decode |
| 完成证据 | 原38组最新第6失败、真实路径仍旧成绩、关键回归漏接 | 已预绑12个现有命令，共50条；真实新聚合产生后替换两旧路径，保原要求与完整分母；独审与完整收据最后冻结 |
| 原F01–F10/Skill | 工程修法不自动证明真实质量；F08缺供应商/原窗口回执 | 本地补齐原题矩阵、产品Skill七步和100/10对账；原100元账本及期限保持；unknown不清、不换ID重发 |

## 本轮实际验证与局限

1. 旧配置隔离复现（`.local/checks/dogfood-closure-review-20261115/legacy-profile.json`）：当前新库首次200，模拟旧合法默认指纹后GET与新消息均409；当前typed形状hash与API实际行一致，allocated/reserved/spent均0，隔离资源已清。最终实施必须补真实旧配置建立→当前API的持久回归，不能只沿用手设hash的诊断。
2. 租约单例：`.local/checks/tool-contract-version-closure-lease-audit-1794709403069.log`，1通过、0失败；它不推翻组合故障。
3. 完整合同组合本轮日志（`.local/audits/dogfood-closure-20261115/contract-suite-audit.log`）：7项中3过4败，含一条lease_lost及三个错领后续失败。只读DB采样（`.local/audits/dogfood-closure-20261115/contract-suite-observation.json`）证明隔离问题；只观察本次随机库，runner退出已删除该库。
4. 标题来源单测（`.local/audits/dogfood-closure-20261115/report-title-test.log`）：exit101，失败差异为新增knowledge_entries整对象范围；尚未修测试，不能标通过。
5. 原完整收据仍failed（`.local/delivery/I3-SEMANTIC-DOGFOOD-result.json`），不是本轮新收据。没有重跑全部工程，没有调用真实模型/embedding/Mem0；原100元未产生新增费用。
6. 源码指纹（`.local/audits/dogfood-closure-20261115/source-manifest.json`）核对本轮未改产品；审计源码片段有限，不声称全仓无缺陷。原456个累计变更保留。

## 合并与验收

最终权威规格：[执行包](../execution/semantic-runtime/dogfood-report-repairs.md)；短入口：[执行Prompt](../execution/semantic-runtime/DOGFOOD_REPAIR_PROMPT.md)。沿六项任务连续实施，原已修行为只做有影响的回归，不重开九阶段。

本地补齐了Oracle未展开的真实原题/Skill链、现有agent-library隔离DB入口、具体命令与要求映射、先工程后真实后冻结出口的顺序。没有采纳会扩成新配置框架、预算产品或额外Agent循环的路线。两份方案对主要原因一致；租约的唯一原因和真实模型改善仍保留证据缺口。

文档检查仅证明包、链接、增量声明和命令入口有效，不证明修复已通过。最终工程/真实效果/09整体三种完成结论必须分别由实施者提交当前证据；本记录不用于冒签实现审查。

本轮定稿检查：`make verify-delivery`退出0，声明检查及16项检查器测试通过；四份改动文档的`git diff --check`通过。原38条验收逐项保持，新增12条后共50条，未删除或修改原验收；包内本地链接与命令入口存在，未写个人绝对路径。18份相关源码/测试指纹与审计起点一致。本轮未执行这50条业务验收，也未生成完成收据。定稿结构检查（`.local/audits/dogfood-closure-20261115/final-structure-check.json`）

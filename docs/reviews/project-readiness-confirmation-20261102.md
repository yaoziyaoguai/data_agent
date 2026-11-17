# 全项目审计发现复核与执行范围（2026-11-02）

复核对象为当前完整工作树，HEAD `04d27d06ba7b97d4cf3e288d4cf9e6300ef491a9`。保留[原独立报告](project-readiness-audit-20261102.md)，本文件记录采纳、修正和不采纳的部分，不改写原审查者的结论。

**结论：可以立即开展09前置修复及无需费用的准备，但不能用现有默认演示直接宣称09通过。** 已确认的产品缺陷集中在模拟provider对工具合同的适配；环境选择、轨迹、记录和覆盖需要补齐。没有证据支持推倒01–08、全量重跑四组升级套件，或新增累计试验费用/次数限制。

## 逐项处置

| 原发现 | 本轮确认与更正 | 处置 |
| --- | --- | --- |
| F1 默认v1/词法/builtin | `scripts/development.py:144–163`确实如此；但`docs/development.md`升级章节明确约定兼容默认和显式切换，不能判为实施漏切或擅自翻默认。09缺少明确的三层环境配置成立。本地模型＋真实Milvus已有harness接缝，不需要放宽启动器的收费边界。 | 补09环境矩阵与实际run观察；保持日常默认。工程检索走现有harness。 |
| F2 mock不兼容v2 | **已用实际函数和同源Schema复现。** 三条座舱演示均发出v1 `read_knowledge`参数，被`KnowledgeReadInput`拒绝。进一步给合法v2回执（真实ref版本7），下一步仍保存版本1；说明不能只改请求形状。ASR解释分支收到读取错误后仍输出固定解释。零售演示还消费`knowledge.objects`并调用旧`read_source`，见`synthetic-analysis.ts:184,192,199,335`。 | 修模拟provider调用和回执消费，不改v2合同，不把v1参数偷偷转成产品兼容旁路。旧v1演示继续保留。 |
| F3 综合轨迹与判分 | 原09只有描述，没有完整冻结消息/观察/记录位。`grade.py:45`的100项约束是原套件正确合同，不是应删除的产品限制。 | 保留100项；十条轨迹另存清单和结果，共用现有记录校验，默认100项原行为不变。 |
| F4 空库 | 默认合成目录确会自动seed；不能用这一起点证明空库导入。不过`synthetic_catalog`只要求synthetic，`register_catalog_in_tx`和`seed_in_tx`接受空objects，`current_catalog_in_tx`也未要求非空。报告“无法成立”过强。 | 采用隔离sourceDirectory、objects=[]，启动后先证明业务对象为空。完整启动和raw召回仍待实际验收；不增全局seed开关，不把失败后改成“仅新来源”作为默认退路。 |
| F5 真实试验配置/预算 | 小样默认配置可能不适用09，但“本机唯一旧配置”不能推出没有配置途径。启动器支持`--model-profile`；Schema支持`budget_mode=request`、data工具、大容量。`model_database`接受新隔离试验库。禁止换ID绕过原预算不等于禁止建立获准新试用；二者不冲突。 | 核对所选配置及实际首个run；新试用保留自己的稳定ID/库/账本，恢复不换。沿用户已确认每消息24次、连续临时失败3次、套件不设额外累计上限。付费执行按实际会话授权，不在编包时调用或重新规定总额度。 |
| F6 旧升级证据 | 后续确改了控制回执、答案、支持交付和Pi恢复。最新收据已有原生压缩、pending恢复、回执重放及旧control负控；并非完全没有当前恢复证据。对比前轮指纹，迁移、索引切换、准备冻结实现未变化。 | 补旧合同/检查点与新回执交叉路径；沿影响扩大，不机械重跑`verify-upgrade-current/frozen/index`。若本轮真的改了相应模块，再运行相关旧组。 |
| F7 原型回归 | 当前渲染未查、09缺显式体验验证成立。harness明确继承process.env并合并options.env，可传v2；个别测试自设版本须保留。`check-experience-optimization.mjs`已验390/320px、Escape、后退和未保存保护，并保存截图。 | 复用现有UI回归，加本版语音实例的实际桌面/窄屏/键盘观察，不复制一整套UI用例。 |
| F8 需求映射 | 需要补“需求→用例/轨迹/工程证据”映射成立。但退休、负责人变化、改名并非没测试：`check-catalog-import.mjs:35–60`覆盖改名/退休/重现，`check-source-sync-recovery.mjs:30–59`覆盖负责人持久接续，`check-source-upgrade.mjs:131–137`覆盖稳定身份。 | 映射并核对证据适用范围，不把所有工程风险再塞入100个真实模型案例。 |
| F9 8MiB/600秒 | 真实端点样本和判据未定义成立。载荷上限、tokens窗口、实际接收、生成质量、取消/结算是不同问题。等待若干秒后取消不能证明600秒全程能力；返回token错误也不能当8MiB成功处理。 | 分本地精确边界和获准端点样本；记录实测上界及未验证部分。不得为了凑上限盲目付费灌满窗口或静默降低产品配置。 |
| F10 两处快路判据 | 确有重复覆盖判断，但两处前置状态不同（pending恢复前/后、grounded优先）。本轮未找到新行为错误，提取整个快路容易混淆责任。 | 后置。不以审计为由重构；将来改该逻辑再考虑仅共用纯覆盖判据。 |
| F11 README状态 | “08尚未关闭”已过期；默认archive/v1仍真实。 | 更新状态与验收实例命令，区分演练、真实效果和部署；不把计划写成已上线。 |

## 可复核证据与限制

无付费、无数据库探针：`.local/audits/project-readiness-confirmation-20261102/mock-contract-probe.json`。调用正式`cockpitAction`和`validateContract`，3个输入被v2参数Schema拒绝；合法`KnowledgeReadReply`通过Schema后，模拟动作引用仍从7降为1；错误读取仍输出ASR解释。该证据证明函数/合同错误，**不是完整UI失败复现**。完整RED/GREEN由实施者在现有harness补齐。

升级范围对比使用 `.local/delivery/I2-SEMANTIC-CLOSURE-REPAIRS-result.json` 与 `.local/delivery/I2-SEMANTIC-DELIVERY-REPAIRS-result.json` 的实际文件指纹和命令；后者18命令仍保留历史及当前范围证据，不推导全部产品通过。原型、真实模型、真实embedding/Mem0和端点行为本轮未执行；未读取密钥或据旧小样配置重新授权费用。

完整后续任务见[09前置修复及整体验收执行包](../execution/semantic-runtime/dogfood-readiness-repairs.md)。本轮仅核实与编包，没有修产品、提交推送或启动日常服务。原报告未深读的内部实现仍不是“全局已排除缺陷”；09出现新问题按真实原因归所属模块处理。

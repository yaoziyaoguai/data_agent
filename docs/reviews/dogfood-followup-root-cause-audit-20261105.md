# 09 后续根因与执行包复审

日期为2026-11-05。本次接续用户要求，核对上一位实施者的实际结果，并为下一位实施者准备连续修复包。本地核对、根因外审和最终执行包外审已完成，执行包已合入末轮意见。产品实施及运行复验交下一位实施者。

## 1. 当前证据

上一包69份冻结文件的实际SHA与限定独审scope全部一致，基线HEAD为`04d27d06ba7b97d4cf3e288d4cf9e6300ef491a9`。已完成答案读取绑定、已加载历史刷新、澄清状态收敛、合成默认资料及选择性来源同步。取消输出枚举缺项已经完成定点修复。

当前核心为15pass、5partial、1not_run。五项partial是S03、T02、J01、J06、J19，A03等待T02两稿。成绩具有不同的原因，需要分别判断。

本地复审读取了实际实施delta、直接消费者、原工具/provider输入及记录。对同一合成隔离库只做SELECT，核了当前字段结构、表DDL和预填失败。两个内存SQLite诊断使用合成材料，产品模型请求为0。主程序构建、服务启动和完整产品回归留给实施阶段。

本轮证据目录为`.local/checks/dogfood-next-repairs-audit-20261105/`。`baseline.json`保存当前69份文件身份，`delta/`保存上一包相对其开工快照的实现差异。

## 2. 必须解决的共同原因

| 发现 | 已核事实与影响 | 处理方向 |
| --- | --- | --- |
| 结构引用被整对象版本卡住 | 当前四个字段绑定表版本1，表当前版本为2/3，三张表DDL逐字相同。读字段成功，采用该字段时追结构依赖报stale_knowledge | 区分正文引用和结构绑定用途，统一相关结构与来源核验 |
| 预填展示和引文认可范围不一致 | 14个失败逐字引用了宿主type元数据，原schema也包含这些引文，校验只看前1315字节正文而拒绝 | 核心片段进入同一同版可见集合，复用supporting_excerpts与coverage |
| 其他失败输入阻断未执行草稿 | S03最后保存草稿时被other_message_unrouted拒绝，代码使用全会话confirmation门 | 本条归属及草稿版本检查与执行确认阻断分责 |
| 旧未完成操作只通过了输入层兼容 | 旧AnalysisUpdate被接受，但所有create无条件规范为新采纳并写格式2，旧未决被拒绝 | 宿主边界识别真实旧请求方言，所属owner按原合同完成 |
| 数据覆盖没有进入本次推理依据 | J01全部provider输入中固定快照出现0次，ASR最终率无规范metric对象，模型反复检索后选请求时刻 | 整理已有首末定义和实际覆盖支持，贯通资料到工具回执 |
| 澄清关闭说明限制了可查事实 | 默认允许唯一资料决定事实，但等待提示只允许本轮用户回答后关闭 | 对齐已批准的事实采用和真实用户选择规则 |
| 合法零轮次日表行被SQL遗漏 | 用真实ETL生成wake-only合法行，turn_count为0，原SQL以turn日期驱动而返回空集 | 共享SQL按实际键集/范围聚合保零，结合快照与覆盖说明 |

这些问题涉及跨边界合同和资料交付。上一包的大部分改动沿既有模块职责，继续使用其实际证据。当前仍有模型表现与验收覆盖缺口，后文分别记录。

### 2.1 结构绑定

`knowledge.rs::checked_refs_in_tx`把`structure_dependencies`产生的table引用当作普通`EvidenceRef(path=ddl)`再核当前知识对象版本。`read_table_binding_in_tx`也直接比较整表知识版本。普通read_knowledge正文路径没有采用这条结构核验链。

实际存储中，field-voice_turn-locale和field-voice_session-locale均为当前版本2，绑定表版本1，表当前分别为3和2。ASR的attempt_no、outcome字段同样绑定表版本1，表当前为3。当前DDL与前包before目录中对应原始DDL逐字一致，schema来源版本仍为1。这解释了重新读当前字段之后仍被相同版本门拒绝的普通路径。

正文引用的语义版本、结构依赖的相关内容与来源权限需要分别落实。具体接口取舍已按首轮外审补到执行包第3节。相关证据为`current-reference-structures.json`、`table-binding-source-comparison.json`及S03/T02工具时间线。

接口复核还发现`dependency_validation::walk_required_in_tx`在目标修订改变但相关正文指纹相同时直接跳过下游。A依赖B、B依赖S，B仅说明改版后S变化，会使该调用漏查S。指纹只覆盖有效正文，`contribution_roots_in_tx`只取登记来源身份，两者均无法代替下游必要内容核验。实现设计17.3.2已明确这一要求。此项已作源码因果核对，运行反例留在原依赖链检查中补充，与结构绑定修复一并处理。原登记贡献关系和本次实际采用的结构来源分别核验。

### 2.2 预填材料

18个invalid_prefill中14个为合法JSON的analysis结果。其schema引文与宿主字段type.source_facts.quote逐字一致，来源真实包含引文，原输入对象版本与当前失败对象一致。来源交付范围只含前1315字节，这些字段均位于范围之后。

`prepare_stage`把字段type引文作为metadata交给模型，`validate_result`只检查sources.body和supporting_excerpts。因此该引用被第一轮校验拒绝，复核补料没有机会执行。`bound_bodies`按来源均分前缀，进一步导致本对象的关键字段位于材料缺口。

核对使用保存的失败输出、固定source范围和同版字段事实重建关系。原HTTP完整预填输入没有在本次wire中找到，本报告只按上述可核事实说明证据。十四份逐项比较保存在`prefill-metadata-evidence-contradiction.json`。

另4个为provider在tool_calls终态给出的malformed_json，长度为498至3628字符，见`prefill-failure-types.json`。其错误来源与14个引文拒绝分别记录。现有材料不足以承诺通过调整输出上限消除这类格式错误。

### 2.3 草稿和恢复

正式设计19.5规定其他未归属或处理失败输入阻断执行确认。当前`request_condition_authority_in_tx`在准备未执行草稿时调用同一个全会话门，S03真实回执为message_pending，reason为other_message_unrouted。

保留当前消息未归属时原有拒绝，并以LockedRun真实message_id核本轮归属。保存草稿与确认执行分别执行其规则，涉及状态变化仍由原版本与授权边界核验。接口修订的工程反例交下一包实施。

当前task_context_required与stale_knowledge提示也未提供足够恢复方向。需要在原错误回执位置提供已有工具可完成的具体操作，并让Pi继续决定任务和取证。

### 2.4 旧已登记操作

实际合同探针证明含needs_clarification的旧create能通过AnalysisUpdate，CurrentAnalysisUpdate会拒绝。register对已有旧操作仍接受旧形状，但apply_update所有create都调用normalized_adoption并写格式2，后者立即拒绝旧未决。这是源码已核的兼容缺口，真实进程恢复反例尚待实施者补齐。

证据在`legacy-pending-contract-probe.json`。完成receipt重放与registered无receipt的恢复需要分别验证。旧恢复沿原fingerprint、operation、origin、预算和原请求方言处理。

## 3. SQL、语义和判分

### 3.1 J01的参数前提

原SQL使用2026-11-04T23:51:00Z快照，得到428个有尝试轮次、390个最终成功轮次和平均候选数3。独立逐行计算得到相同结果。诊断性地使用资料快照2026-10-04T00:00:00Z时，原SQL与独立计算均为424、386和3。

这将问题定位到资料快照选择和无草稿，当前样本支持候选均值公式。诊断参数变体单独标记，原SQL/原参数、原attempt及原评分按历史保存。证据为`candidate-mean-aligned-premise-probe.json`。`j01-snapshot-delivery-check.json`记录原provider输入中固定快照出现0次。

目录有28个metric对象，其中ASR最终尝试成功率主要存在于文档段落及其他指标说明。规范对象和相关范围支持可以提高这条普通检索的可用性，效果仍须通过实际回执及下一次模型结果确认。

### 3.2 J19的合法反例

本次用原schema、原合成维表和一条已有合法的sessionless wake构造独立内存输入，再执行未修改ETL。外键检查通过，日表得到2026-07-01、turn_count=0、session_count=0、wakeup_attempt_count=1。原模型SQL仍返回空数组，因为fact_days只由turn构造。

这证明了生产SQL可达的遗漏。原模型对“缺日表行等于缺测”和“有行即可解释真实零”的断言还需覆盖依据。资料示例、合法反例及实际模型SQL分开验证。证据为`zero-legal-etl-probe.json`。初次探针误用了不存在的唤醒计数字段名，已按实际schema纠正，初次错误没有作为产品结论。

### 3.3 补充验收已获准

用户2026-11-05明确允许J06验证会话冻结ASR策略、J19验证零分母比例的两条补充提问。以新attempt记录补充前提、结果和费用，保留原题及原partial。具体固定输入与验收在执行包第8节。

J06已有七项数值与原参考一致，复用其适用证据。S04/G02等非核心未触发断言继续保留原回归库身份。

## 4. 范围与工程规则

源码复审覆盖前包实际实现差异及本次根因涉及的直接调用链。没有发现需要另建Agent、图数据库、评分平台或全局恢复框架的依据。既有read_binding、SnapshotRefresh、当前澄清owner和选择性同步继续承担其职责。

本包应清理用途混用造成的多余限制、材料交付的重复口径及不完整兼容分支。引用权限、同版来源、当前消息身份、执行确认和unknown查证属于已有合同。字段或表名来自本轮合成资料，只作失败证据，修复实现使用一般规则。

历史API PoolTimedOut、首次失租和旧启动事故的原因继续按已有记录表述。当前有现场的启动全目录重分析问题已取得独立RED/GREEN，符合选择性同步目标。

## 5. Oracle交叉审查

根因咨询`dogfood-next-roots-1105`已正常完成，运行日志两次核实`Power, item 5 of 5 (slider ARIA)`，输入约10,237 tokens。配置源为既有专用Profile，咨询结束后精确核实临时Chrome进程退出及副本删除。输入SHA、答复和清理记录在本地证据目录。

| 外审意见 | 本地核实与处置 |
| --- | --- |
| 显式知识引用和内部结构表绑定分责，选中path只核实际依赖 | 接受，补结构边登记和已核绑定返回，原来源及范围继续检查 |
| 缺旧DDL不能拿当前hash自证 | 接受，核实旧全文缺失，只允许真实同版原文补证或定点重整，before仅作诊断旁证 |
| 发送、冻结、引用白名单共用最终裁剪集合 | 接受，metadata字节同样计容量，放不下同步撤下并记录coverage |
| 草稿移出全会话确认门 | 接受，保本条归属和原执行确认门，同一夹具验证保存与执行的差别 |
| 旧方言须由真实登记及参数判定，当前状态不得降版 | 接受，沿原事务和operation处理旧registered无receipt，补create/revise恢复 |
| J01证据无法证明均值算法错误，J19须用生产可达反例 | 接受，分别固定实际快照前提与合法wake-only ETL证据 |
| 两条未触发断言需要用户决定补验 | 用户随后明确批准，已写入包第8节，保留原attempt及费用 |

最终包咨询`dogfood-followup-package-1105`正常完成，最高档仍有两次`Power, item 5 of 5 (slider ARIA)`实证，输入约19,693 tokens。外审结论为“需两处定点修订，无新增产品未决”。临时Chrome进程已退出，临时Profile副本已删除。

| 末轮定点意见 | 最终包处置 |
| --- | --- |
| entry选择须贯穿有效性游走、全部贡献来源、去重及草稿来源门 | 已补第1.1、3.2、3.3及5.1节。知识边沿原版本和target_path展开，内部已核选择供草稿使用，省略path仍表达全对象 |
| 恢复验收须包含同一v2中的旧registered形状 | 已补第6.1–6.2节。明确ledger协议2、registered、无receipt、原fingerprint及合法旧create/revise，经实际宿主链验证 |
| 发送前额外裁剪也须服从最终证据集合 | 已补第4.2节，定位prepare_stage现有裁剪，归入同一材料装配修复 |

本地按实际源码逐项核实这些意见。进一步核到`DependencyCollector::push`的登记去重元组遗漏target_path，将其纳入同一条目范围修复和双entry反例。此项为本地源码补充，未宣称Oracle单独发现或运行验证。资料新增两项已有定义所需的生成物及计数同步也已写清，原事实及旧参考按原身份保留。

两轮咨询均为限定材料的静态分析。Oracle读取源码摘录和诊断摘要，运行证据由本地诊断取得。外审没有亲自运行产品，最高档依据取自提交前控件状态。原答复、发送材料SHA及定点处置记录在本地证据目录。

- 根因咨询原会话为dogfood-next-roots-1105（会话链接留存本地证据）。
- 最终包咨询原会话为dogfood-followup-package-1105（会话链接留存本地证据）。

## 6. 交付和验证边界

本轮交付为[连续执行包](../execution/semantic-runtime/dogfood-followup-repairs.md)、[接手Prompt](../execution/semantic-runtime/CONTINUATION_PROMPT.md)及本报告。实施结果仍由下一位coding agent以真实代码和对应验收证明。

本轮完成范围包括根因与接口核对、详细连续包、当前记录和接手入口。执行包保留原架构、当前核心范围及四条编程规则，明确修复一般原因、复用已有接缝和受影响证据。J06/J19补充提问已获批准，当前编包没有待用户选择的产品问题。

材料校验运行`make verify-materials verify-delivery`，其中准备材料527项和交付脚本16项单测通过。新增文档及入口链接、空白、个人路径检查通过，69份上一包冻结文件在本轮末尾仍全部匹配。最终命令输出与文档指纹保存到本地证据目录。

本轮产品构建、完整回归、真实模型新attempt尚待执行。新四项验收为待实现占位，CURRENT保持active、实施review pending、evidence null，未执行verify-increment。供应商四份坏JSON的内部成因尚无证据，资料修正后的真实模型效果须由后续运行确认。

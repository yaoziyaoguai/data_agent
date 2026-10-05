# Data Agent 架构与实现对齐审计

日期：2026-10-05。审计对象是当前 I2-MVP 工作树；尚无 Git 提交。当前任务与后续动作仍以 [CURRENT](../CURRENT.md) 为准。

## 结论

进程分工、模块存储边界和 Pi 主循环基本遵循已有架构。确定的偏移集中在知识资料输入、预填结果回传、宿主替模型判断记忆范围，以及把样例单位和时区写进全局指令。

近期工作确实修复了协议、会话持久化和索引并发问题，也保留了失败证据。但后续逐题增加提示词、反复跑少数代表题，已经挤占了对通用产品链路的检查。模型拿不到的资料、被工具裁掉的缺口，不能靠更长的提示词补回来。当前 MVP 保持未完成。

本轮由主审直接核对代码、架构图、模块契约与 OpenAPI，并复用两位未负责对应实现的审查者做只读核对。独立审查结果来自本轮工具回传；本报告是主审汇总，不充当最终增量的通过审查。

## 1. 当前实际在做什么

最新用户纠偏前，开发处于 MVP 收尾修复及质量验收：修复 Pi 原生会话保存/恢复、工具输入、维护操作重传、索引锁序等问题，并用真实 DeepSeek 检查回答与语义预填。最近多轮调用集中在 S01、P01、P04、P05，未完成当前完整 16 题及最终增量验收。

用户提出先审计后，暂停新增业务代码、提示词和官方试验。已有 scope-separation 代表试验自然结束、退出 1：P01/P04 机器检查通过，P05 再次预填为 `invalid_prefill / invalid_input`；12 次调用均已结算、预留为 0。失败产物已归档，不能标为语义或 MVP 通过。本轮只增加审计证据和更新当前记录。

## 2. 要求与实现对照

| 约定 | 当前实现与依据 | 审计判断 |
| --- | --- | --- |
| React 展示；Rust 保存业务事实；Pi 理解和调用工具；Worker 同步/预填/索引/跟踪 | [容器图](../architecture/data-agent-c4-container.png)、[模块视图](../architecture/implementation-views.md)、`apps/api`、`apps/worker` 与 `crates/data-agent/src/use_cases` 对应这些分工 | 基本对齐；Mem0 仍是候选组件，未接入不能算已实现 |
| 模块私有存储，跨模块用例组合 | `scripts/check_architecture.py` 对当前代码检查通过；7 项检查器反例通过 | 只证明声明的依赖、SQL 位置和表归属；不能证明所有业务规则正确 |
| 模型自主选工具，宿主守住权限/版本/确认 | Pi 注册 12 个受控数据工具；`request_query` 保存草稿。`query_workflow.rs:26` 与 `queries/store.rs:119` 在确认时核对用户、任务、依据、草稿版本、条件版本及新消息阻塞 | 核对的核心路径对齐；记忆的整消息词表另有偏移 |
| 元数据、SQL、血缘、文档共同帮助预填 | 通用目录只传当前表快照，原始快照含上游 ID，但未加载上游正文或关联文档 | 存在资料输入缺口，见 ALIGN-02 |
| 来源事实、模型建议、人工覆盖分开保存；保留未知及依据 | 保存结构区分三者，但给聊天模型的正文裁掉整个 `suggestion` | 保存到使用的链路未完整对齐，见 ALIGN-01 |
| 明确纠错保存为本人记忆；一次性条件不长期化 | 资产归属、版本、依赖、幂等由 Rust 校验；整条消息出现否定子串就阻止全部保存/修订 | 多目标范围被合并，见 ALIGN-03 |
| 对话长期续接，Pi 原生压缩与恢复 | 使用原生 JSONL、精确 leaf、`session.prompt/compact/abort`；全空间依据快照会使无关改版中断会话 | 原生能力已复用；失效范围是有影响的保守限制 |
| 跨语言以 OpenAPI/JSON Schema 为真源 | 51 组 OpenAPI 方法/路径均有实际注册；参数名称规范化，并展开两类 action 路由后比对 | 路径注册一致；设计说明存在漂移，不能据此宣称全部 API 行为已验收 |

## 3. 需要优先处理的发现

### ALIGN-01 / P1：预填保存的分析缺口和多来源依据未完整交给聊天模型

[prefill.rs](../../crates/data-agent/src/modules/ingestion/prefill.rs) 第 178 行将 `value/evidence/gaps` 保存到 `suggestion`。但 [retrieval/mod.rs](../../crates/data-agent/src/modules/retrieval/mod.rs) 第 107、168 行在搜索预览和正式正文页中把 `suggestion` 替换成 `{}`。正文只保留 `source_facts.gap`，这是原始资料缺口，与分析后的 `suggestion.gaps` 含义不同。[data_tools.rs](../../crates/data-agent/src/use_cases/data_tools.rs) 第 297 行正式使用该正文投影。

结果是：预填已说明的某些边界若仅在 `gaps` 中，后续 Agent 读知识仍看不到；分析记录里的多来源引用也丢失。保留了基础来源 ID 和当前 `effective_value`，并不等于保留了全部有效解释及依据。Agent 可以另读原文重新调查，但预填积累没有完整复用。

应先明确当前有效解释的缺口、依据与状态如何交给模型。人工覆盖后的待比较建议须单独标记，不能把全部新建议直接当成已采用事实。

### ALIGN-02 / P1：通用表预填缺少关联文档与上游资料

[knowledge.rs](../../crates/data-agent/src/use_cases/knowledge.rs) 第 149–154 行，`catalog-` 对象重新预填只读取当前表的一个来源；合成零售分支会读整套允许资料。[catalog_import.rs](../../crates/data-agent/src/use_cases/catalog_import.rs) 第 111–120 行，自动分析也只打包当前表来源。

[catalog.rs](../../crates/data-agent/src/modules/ingestion/catalog.rs) 第 20 行的快照包含本表元数据、DDL、注释、节点 SQL、上游 ID；没有读取上游正文和另行维护的关联文档。[prefill.rs](../../crates/data-agent/src/modules/ingestion/prefill.rs) 第 251–281 行固定材料包，唯一模型工具是提交结果，无法自行补读。

这与[系统设计](../semantic-retrieval-design.md)第 3 节“透传字段按需追上游”的要求不完整对齐。即使用户已维护文档，模型仍可能因材料未装入而报告未提供。

应先完善有权限、版本和范围约束的材料装配及必要补查。若引入自主调查，复用 Pi 的工具循环；不另造 Rust 调查 Agent。

### ALIGN-03 / P2：宿主用整条消息的词表替代具体记忆范围判断

[data_tools.rs](../../crates/data-agent/src/use_cases/data_tools.rs) 第 502–512 行，只要原消息包含“仅本次 / 不要记住 / 仅这次 / 不要保存”，就拒绝全部 `save_memory/update_memory`。

静态可确认的反例：用户说“仅本次按 web 渠道分析；另外请记住以后金额用元展示。”模型正确保存后半句，宿主仍必然返回 `scope_incomplete`。

[AGENTS](../../AGENTS.md)第 5、12 条要求保留 Agent 的理解空间；系统设计第 14.3 节要求明确长期纠错可保存、临时条件不长期化。这里应按具体操作绑定用户意图和范围，保留归属、结构、版本、依赖、幂等校验。不能直接删掉保存范围检查并开放任意长期保存。

### ALIGN-04 / P2：样例金额单位和时区被写成全局业务规则

[resources.ts](../../apps/agent/session/resources.ts) 第 13 行写死“金额保留整数分、UTC”。这些只适用于当前部分样例，应来自被读取的语义和目标配置。全局指令不应改变另一张表已有的金额单位或业务时区。

该文件及预填指令也累积了多组相关防错要求。一般调查指导可以保留，但应区分业务事实、工具协议、程序硬约束和历史回归反例；当前优先修知识链路，再收敛重复指令。

### ALIGN-05 / P2：代表验收没有充分覆盖正式多条目维护结构

通用 [catalog.rs](../../crates/data-agent/src/modules/ingestion/catalog.rs) 第 93、141 行将表说明、粒度、时间、主键、过滤、指标、限制及字段含义、单位、取值、计算分别保存。但真实 P01–P05 的 [验收 runner](../../tests/mvp/run-business-acceptance.mjs) 第 215 行仍集中在合成对象的单个 `meaning` 条目。

当前提示又要求每个语义条目描述多种内容，存在重复填入整份说明和输出过长的风险；本次未把这一风险当作已实际复现的正式整表失败。

后续验收需要使用通用目录中的真实多条目结构，覆盖关联文档、上游、人工修改后再次预填，以及 Agent 读取这些有效产物。一组题反复通过不能证明未见表和未见问题的质量。

## 4. Pi 与模型能力的实际复用

以下源码已直接核对，均为真实 SDK 接入：

- [deliver.ts](../../apps/agent/session/deliver.ts) 第 184–243 行：`createAgentSession`、`session.prompt`；模型选择受控工具，未编码正常调查顺序。
- 同文件第 207–236 行：原生事件订阅、`session.abort`、`session.compact`；宿主字节门槛触发 SDK 摘要，不自行生成压缩摘要。
- [journal.ts](../../apps/agent/session/journal.ts) 第 54–62 行及 [checkpoint.ts](../../apps/agent/session/checkpoint.ts) 第 14–27 行：`SessionManager.create/open/branch/resetLeaf`、原生 JSONL 和精确 leaf；宿主增加私有存储、落盘和业务事务绑定。
- [deepseek.ts](../../apps/agent/provider/deepseek.ts) 第 82–111 行：Pi `streamSimple/openai-completions`，外层包裹调用许可、发送、用量核验及结算。

稳定操作账本、权限、SQL 确认、预算和恢复身份是业务适配职责。关闭隐式 SDK 重试有持久许可和未知回执契约依据。明确交付拒绝只经 Pi 反馈一次让模型修正，未由宿主补造任务。

原生 Skill 文件发现未启用有已确认依据：Pi 的 `/skill:name` 直接读 `filePath`，自动提示依赖文件工具；当前经 MySQL 本人资产及用户选择校验，再由受控工具交正文。见[系统设计](../semantic-retrieval-design.md)第 12.3 节。因此 `getSkills=[]` 本身不构成未利用 Pi 的缺陷，也不能宣称已完整兼容其本机 Skill 加载方式。

语义预填是架构允许的有界维护模型调用，不需要伪装成用户聊天；固定“分析 + 复核”两阶段本身没有新增规划器。同一模型对相同材料做第二次检查是质量手段，不能作为独立正确性证明。缺少资料时，两次仍然缺少同一资料。

## 5. 限制与资料漂移

### 长对话的失效范围过宽

[context_authority.rs](../../crates/data-agent/src/use_cases/context_authority.rs) 第 8–20 行将整个空间有效知识和来源纳入快照，包括从未交给模型的条目。[deliver.ts](../../apps/agent/session/deliver.ts) 第 195–196 行明确不发送此快照正文给模型。任一旧版本消失，调用前校验会拒绝；[deliver_run.rs](../../crates/data-agent/src/use_cases/deliver_run.rs) 第 89–104 行在同输入恢复时拒绝，新输入时清空原检查点和近期消息。

例如对话只读 A，后台将未读 B 改版，也会影响该对话续接。这是有明确行为影响的保守实现限制。[运行模块](../architecture/runtime-modules.md)第 263 行允许依赖无法证明完整时保守重建，本次不将其归为授权安全缺陷，也不建议关闭失效检查。后续应记录实际正文、工具结果和摘要依赖，收窄影响范围；需验证无关改版继续、实际采用项失效拒绝、摘要依赖失效三类行为。

### 设计文档需要同步

- [实现设计](../architecture/implementation-design.md)第 124 行仍列 `POST /query-requests/{id}/confirm`，实际 OpenAPI 与注册路径为 `POST /queries/{id}/confirm`。
- 同文件第 194 行及整体模块视图仍说明单次预填；[知识模块](../architecture/knowledge-modules.md)第 196 行及当前代码为分析/复核各一次。
- 设计操作表中的资产、同步批次和提案接口也与当前操作面有差异。部分职责已有合并接口承接；这些差异不能直接等同于能力全缺失。需要区分已实现替代操作、仍待实现接口与旧设计说明，并同步图册。

## 6. 本轮验证及边界

- 实际执行 `python3 scripts/check_architecture.py`，退出 0。
- 实际执行 `python3 -m unittest discover -s tests/architecture`，7/7 通过、退出 0。
- 主审对注册代码做静态方法/路径比对：OpenAPI 51 对全部匹配；另有未列入业务 OpenAPI 的 `GET /health`。这只验证注册覆盖，没有重新运行 HTTP 合同或数据库业务测试。
- 两位独立审查者均未修改实现、运行模型、构建或操作数据库；给出了代码和需求的执行路径依据。
- 本轮未重新执行完整 MVP、真实平台或新模型验收；已有试验自然收尾并保留失败。本报告不能关闭 I2-MVP。

当前审计输入与核对结果保存为忽略的 `.local/checks/mvp-architecture-alignment-20261005.json`；代码改动后应重新核对受影响结论。

## 7. 后续工作的顺序

1. 先补知识闭环：预填材料可发现且足够，当前有效说明、缺口和依据完整回传。
2. 修正宿主对多目标记忆范围的词表判断，以及全局样例单位/时区。
3. 同步模块契约、API 说明与图册，明确长对话失效范围的当前限制及改进边界。
4. 用通用多条目对象、关联文档、上游及混合意图做回归；再完成当前完整业务验收和独立审查。

上述是对原 MVP 工作优先级的纠正，没有删减原验收要求。具体修复仍需按对应模块边界实现；本轮仅完成审计。

# 交互修复与试用就绪审计（2026-11-09）

本次接续交付审计由 Codex 按 `dev_co`、`contract-first` 和 `oracle-web` 完成。范围为最新交互修复、后续有限真实验收及其直接依赖；不是重新验收全部项目。审计基线是分支 `codex/semantic-maintenance-prototype`、HEAD `04d27d0` 加现有未提交工作，实际状态只在 [CURRENT](../CURRENT.md) 维护。

## 结论与证明范围

**尚未完成，不能宣布当前入口已经具备本轮修复后的正常试用条件。** 流式、保存尾项、短游标、模块归属和 Pi 原生上下文编辑已有限定工程证据；正确配置的真实代表仍未走通“明确执行 → 平台一次提交 → 自动解释”，且本机日常入口没有更新到本轮候选版本。

最近实施者没有新增 Agent、规划器、压缩器或恢复框架。发现的是已有来源控制与工具合同、错误信息交付和验证接线之间的缺口。不能因这些缺口删除必要的来源/权限门，也不能再通过堆提示、自动猜任务或另造恢复循环解决。

本轮核对了正式设计、相关生产代码、Pi 1.3.0 本地实现及版本化文档、真实轨迹、收尾收据和文件指纹，并做了一次零网络生产投影复现。未调用产品真实模型、未运行数据库电池、未改产品或日常服务、未提交推送。Oracle 只接收相关公开源码摘录和脱敏事实，不含凭据、私密原对话或数据库导出。

| 证据 | 本次可支持的结论 | 不能支持的结论 |
| --- | --- | --- |
| `interaction-repairs/g7-final-state.json` 中 13 份核心产品/合同文件与当前一致 | 原六组相应工程证据可按影响范围复用 | 不能证明真实模型续接或整个09完成 |
| `finite-acceptance-final-state.json` 的5份源码、13份证据指纹一致 | 最新验收报告与其归档版本一致 | 实施者的根因解释仍须源码交叉核对 |
| `configured-real-finite-final-accounting.json` | 新增22次实际请求、202027微美元，另有1笔未发送预留；平台提交0、续接未跑 | 账本分配差值23不是23次供应商请求；预留不是实际费用 |
| `interaction-final-audit-20261109/projection-reproduction.json` | 实际生产投影删掉了 `hint/recovery`，旧资料哨兵没有泄漏，网络调用0 | 未证明修后真实模型一定遵从 |
| 日常进程启动时间与候选文件/二进制时间核对 | 当前19173入口的API/Bridge/Worker仍是11月7日启动 | 不能把磁盘上的新源码当作已部署版本 |

上表路径前缀为忽略目录 `.local/checks/`。它们是本机证据，不是公开仓库运行所需资料；缺失时不得凭文件名宣布通过。

## 确认问题

### P1：错误恢复指导在模型输入投影中被删除

触发：新消息的来源范围尚未确定，模型尝试读取普通任务/对话正文，Rust 返回 `task_context_required`。

`crates/data-agent/src/use_cases/data_tools.rs::rejection_data_in_tx` 生成固定 `hint` 和受控 `recovery`。`apps/agent/session/task-projection.ts` 的 `context_with_system` 分支重新投影当前工具结果，字段白名单没有这两项。最终发给供应商的控制消息只剩 `error/outcome` 等身份、状态；Pi 不会补回应用已删除的信息。当前测试还把只剩这两项写成了成功预期。

零网络复现直接调用生产投影：原回执有 hint；投影后 hint=false、recovery=false，error仍为task_context_required；禁止正文哨兵未泄漏。故“Rust产生六次明确指导”成立，“模型收到了六次指导仍不遵守”没有证据，原 CURRENT 的归因须纠正。

最小修复：在既有来源控制投影中保留可信、可行动的控制信息。只传固定指导和已授权控制身份/版本/状态；不能整体透传任意 hint、recovery、原错误 content 或 details。尤其 `stale_knowledge` 的 hint 会拼接错误详情，不应按“所有hint都安全”处理。已有原始回执及 Pi 分支保留，不重写历史，不另建错误恢复协议或模型循环。

### P1：执行说明与新合同的准入前提冲突

相关接缝：

- `apps/agent/tools/data-tools.ts`：批量 execute 说明含“不先route”。
- `apps/agent/session/resources.ts`：写执行已有SQL可由execute登记归属，另要求先get_query核对SQL。
- `task-projection.ts`：来源未就绪时隐藏execute_query和get_query。
- `crates/data-agent/src/use_cases/data_tools.rs::requires_source_context`：v2执行也要求来源就绪。
- `use_cases/source_limits.rs::input_context_ready_in_tx`：当前消息未routed一律false。
- 系统设计§15、§19.5–19.6与实现设计的批量确认合同：同事务核对、追加归属、确认，不要求逐目标预route。

这些说明不能让模型同时满足。真实轨迹出现两次Pi原生 `Tool ... not found`，随后六次普通对话读取被拒，最后模型改为澄清并使原稿失效。不能将普通真实消息入口卡死解释成模型配置太小；本次冻结配置已核实为1M上下文、900k输入、65536输出、8MiB及600秒。

这里应区分**本条消息的来源准入**与**具体SQL集合的执行授权**。修复不能简单豁免execute的来源门、默认把来源设为null，也不能把批量授权拆到多个事务。可实施方案与旧合同的兼容说明须在执行包明确，不能继续让两种互相矛盾的指令并列。

### P2：上下文测试没有接生产活动工具门

`tests/runtime/check-request-context.mjs` 的fixture创建Pi会话后没有接生产 `attachToolGate`；生产 `deliver.ts` 有该接线。测试因此仍可调用生产中已隐藏的工具；本地provider又预设下一步route，并断言错误只含error/outcome。它没有证明生产工具可见性、实际模型请求中的恢复指导及二者组合。

另一个证明范围缺口：`tests/mvp/check-conversational-query.mjs` 的harness默认v1，包含“未归属直接执行”和“批量不用预route”断言。这些通过不能覆盖实际v2来源门冲突。应保留v1断言，并在既有接缝补v2对应行为，不把旧测试整体换合同或批量改expected。

最小修复：原fixture接同一个Pi活动工具门，断言真实序列化payload；分别覆盖“调用隐藏工具被Pi拒绝、Rust未派发”和“多用途可见工具选择正文分支被Rust拒绝、控制指导送达”。来源确认后恢复原工具集合；原来源正文哨兵继续不能泄漏。用少量行为场景替换错误断言，不新建测试平台。

### P2：完成记录的归因和试用版本表述需纠正

最新真实代表确实失败，实施者保留了失败、账本、费用和未知预留，没有把mock或SQL校验器通过冒称业务完成，这一点正确。问题在于将“原工具回执有指导”当成“供应商已收到指导”，并把剩余工作表述为只等模型遵守route。应记录上述确定的接入问题，修后再判断模型余留风险。

现有19173工作台及22780/22781后端对应旧启动进程。后续交付需同时说明源码验证、真实代表结果、实际服务版本三层；未更新日常服务前不能发旧URL并称最新版就绪。OpenAI直连/代理认证的原缺口独立保留，本包不顺带实现网络代理。

## Pi、范围和编程规则核对

- Pi 1.3.0 继续负责工具循环、流式事件、会话、压缩、取消与恢复。生产使用 `createAgentSession`、`setActiveToolsByName`、原生context hooks和context edit；没有发现最新变化复制这些能力。
- 来源、条件、SQL授权和持久预算属于应用业务，Pi不会替应用决定。临时来源投影有必要；问题是投影把正常恢复所需控制信息一并删除，不是需要换框架。
- 本次未发现新的座舱表名/题目特判。旧零售合成代表只能证明通用执行链，不能替代座舱语义质量验收；保留其原证据身份，不另刷整套旧题。
- 已有短游标引用、数值绑定、正文来源核验和批量授权有实际需求依据。本次没有证据支持把它们整块删除或继续加通用封装。
- 四条编程规则的修复重点是删冲突指令和错误测试预期、补缺失控制信息与接线。不得增加自动route分类器、强制步骤调度器、全局工具重试、查询重建、宽泛异常兜底或新的观测/评分框架。

## 交叉审计与处置

Oracle两轮均要求最高5/5、单路分析，不委派其他模型。第一轮 `interaction-root-audit-20261109-final` 提交前两次核实 `Power, item 5 of 5 (slider ARIA)`，已取得会话提交身份；随后在共享45分钟截止处超时。以原会话执行 `oracle session ... --render` 只恢复运行日志，没有审查答复；该自动抓取结果不能作为意见。该会话精确Chrome PID已退出，临时Profile已清理；未重发根因问题。

**用户随后复制了原会话完整答复。** 答复引用本轮 `root-evidence.md`、同一源码行号和真实事件，结论为 `needs_revision`，确认两项产品接入问题及测试接线问题，要求先补证方案A的关联/来源/确认边界。原文按用户提供方式归档为`.local/checks/interaction-final-audit-20261109/oracle-root-answer-user-supplied.txt`，SHA256 `b73040966ea13d6fd7c28851fb1ac3b5ad258e5cc0bfdcacb3f67ea068850bfd`；不冒称自动抓取成功，也不声称Oracle访问了本地仓库或运行测试。

主审按该意见补读了下列接缝，不改产品、不扩数据库试验：

| 必需问题 | 已核源码事实 | 方案处置 |
| --- | --- | --- |
| route是否改条件或将全部执行目标提前关联 | `analysis/store.rs:446`仅核当前任务版本/状态并返回；`source_limits.rs:765`的route直接返回，不改source_limits；`data_tools.rs:2274`仅传当前选定task；`conversations/store.rs:473`写入这一task的消息关联，普通route不标已应用 | 准入采用一个确为读取所需的目标，不预route整个执行集合。该已成功route是execute前基线，不能谎称被后续批量失败回滚 |
| 一个活动范围是否自动并集 | `source_limits.rs:149/182/655`优先按活动任务的当前声明解析，null表示已声明无限制，缺失保持未知；不同任务限制不并集 | 沿原来源门，不增加taskless/null解锁。合法同范围/已明确无限制的多目标可在一次准入后读取；超出范围的读取继续拒绝 |
| 读第二个合法查询是否必须关联它 | `data_tools.rs:2360`按会话、正文来源和活动来源门读取get_query，没有消息关联写入；route与get_query职责分开 | 对两个已明确无限制的合法任务，route一个目标后可核对两份草稿，第二目标尚未关联，足以构造本包v2事务验收 |
| 批量新增关联是否仍在确认事务 | `query_workflow.rs:257`仅单条分支要求已登记目标包含它；批量完整集合独立核对。279起全部confirm成功后，307才逐项route；`confirm_locked_in_tx`核原上下文来源有效性、当前条件/知识版本和查询权限，CheckedTextResults核结果可读性，不替代来源准入 | 保留原确认事务。新v2验收在调用前留状态基线，证明后项拒绝无本调用新增状态、合法集合一次成功；本次静态核对不是该验收已通过 |

据此，本包选择沿既有v2准入接线澄清，不开放未裁决execute、不改批量事务。此选择证明普通合法入口存在，并不宣布任意跨受限来源组合已经通过；原来源/跨任务合同和必要既有回归保持。

其余Oracle意见的处置：`query_recovery`、`recovery_state_in_tx`完整返回形状已核，只包含控制身份、版本、状态/问题ID及后续读取建议；隐藏投影仍显式择字段，不整体透传。两次SDK未知工具缺少逐次实际tools名单，不能据其断定Pi时序缺陷；clarify后的superseded不判作状态机错误。账本另1笔保留原reserved记录，只能说明未取得发送/结算证据，不能宣布服务商必然零费用或允许清账。

第二轮 `interaction-package-audit-20261110-final` 单独审执行包及必要接口补证，材料约12,259 tokens，低于第一轮约17,142 tokens；已重新doctor、dry-run并确认无并行Oracle，提交前两次核实最高5/5。自动取得完整答复，退出码0，结论为 **“小修后可实施”**。它认可来源准入与批量授权的职责分工，不要求新增用户决策；四项必要修订均已回核并纳入最终包：

| Oracle必要修订 | 最终包处置 |
| --- | --- |
| route成功不等于来源就绪 | §4–5只在宿主确认`source_context_ready=true`后恢复工具，等待必要刷新；固定hint指向继续原请求，不重建草稿或自动补null |
| 工具可见不等于实际可调用 | §6要求同会话/同消息实际派发get_query与execute，消费者fixture接生产工具门；v1默认断言必须真实运行一次，不只保留代码 |
| 批量原子性反例必须先失败后成功 | §6从两份未确认草稿开始，先后项版本失效并核零新增，再沿同消息/预算用新operation合法确认；已成功route为原基线，不承诺外部平台跨查询原子性 |
| 新attempt不能沿用旧稿的正确性成绩 | §7独立验证本次实际保存的有效SQL与参数，所有提交/结果/prepare/刷新证据绑定本次query及task/condition/result |

Oracle保留的唯一最小待核事实是v2先准入A、读取合法B、随后A+B整批确认是否另受前置检查阻塞。本地已补读相关接缝，但静态阅读不能代替运行；最终包明确由既有v2场景证明，失败不豁免来源门。消费者fixture的合同替身与真实Rust/MySQL场景分别报告，不冒称前者已访问真实Rust。

第二轮原会话为执行包审查（会话链接留存本地证据）。自动答复从`oracle-package-run.log`的`Answer`段归档至`oracle-package-answer.txt`，5373字节，SHA256 `b7ed8d70150dfa2da9160cbbd279edca34b9e20e5d852c1ffd54b80bd21f2cc1`；对应模型日志文件为空，未用空文件冒充答复。完成记录见`oracle-package-completion.json`。该会话精确Chrome PID已退出，临时Profile已清理。两轮日志和第一轮恢复记录均在`.local/checks/interaction-final-audit-20261109/`。

后续交付入口为 [任务续接修复执行包](../execution/semantic-runtime/interaction-continuation-repairs.md)和[交接Prompt](../execution/semantic-runtime/CONTINUATION_PROMPT.md)。最终文档检查记录为`.local/checks/interaction-final-audit-20261109/final-document-checks.json`及`verify-delivery-final.log`；该检查只核文档与记录，编包和审包均不代表产品已修复或真实代表已通过，09保持active。

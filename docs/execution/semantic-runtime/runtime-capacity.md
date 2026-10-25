# 运行恢复与模型容量

前置：当前基线。沿用 CURRENT 的 `I2-RUNTIME-CAPACITY`，需求 D03/D07/D08/D09、C01/C02/C05/C07、A02/A10。职责映射 M01/M02/M04/M05/M08/M10/M11/M12，仅供文档审查。

## 结果与范围

检索慢时会话仍续租；临时数据库故障不会结束整个Worker；用户能使用已核实的大窗口模型，普通请求与Pi原生摘要按真实容量和冻结限额执行。旧消息与检查点仍能续接。

允许范围：`apps/agent/`、`apps/worker/`、必要 `apps/api/`、`apps/web/src/features/models/`；Rust的runtime/conversations/jobs及检索组合边界；`packages/contracts/`、必要迁移、相关测试与文档。知识/检索模块仅改锁外公开读取边界，不提前做新索引、来源迁移或任务新合同。

## 当前入口与顺序

1. 核对 `use_cases/data_tools.rs` 的登记、锁会话/运行、`retrieve_scoped_in_tx` 和最后commit。当前embedding部分锁外不等于整个慢读取锁外。先给慢读取和提交前改版反例，再改为：短事务核验并登记稳定操作→锁外召回/批量读取→短事务重核任务/权限/修订/代次并存回执。模块私有store承担SQL，同会话逻辑仍串行。
2. 核对 `apps/worker/src/main.rs` 的claim/context/defer/fail/renew错误传播。只对已分类临时故障做既有有界恢复；未知派发先查证，不无脑重发；进程配置错误明确失败。不把所有错误catch后无限继续，也不把取消/额度耗尽变成临时重试。
3. 串行修改模型真源、存储与冻结profile，再修改provider/Pi/UI。新定义要求 `context_window`、`request_timeout_ms` 和能力来源；历史profile允许缺字段并走legacy。现有管理员权限保持。输出schema至少能表达393216，但实际端点及可行组合仍受校验。
4. `provider/configured.ts`、`session/deliver.ts`使用总窗口；`provider/controlled.ts`按 `min(SDK当次maxTokens, profile.output_limit, 已知端点上限)` 请求及reserve。SDK未提供cap才用profile。普通/摘要都遵守，不覆盖摘要reasoning选择。
5. 沿[17.7](../../architecture/implementation-design.md#177-模型容量与pi原生压缩)实现可单测的容量推导和运行校验。不得另写摘要器。`request-size.ts`核对完整JSON字节，不能把字节阈值叫tokens或遗漏临时workspace、工具定义、转义。摘要请求本身也须能装下；不能只检查压缩后的结果。
6. `transport/server.ts`现有failureCode已经读Error.code；要修的是不完整白名单及HTTP/Worker映射，不能删已有分类逻辑。保留timeout/rate_limited/retry_exhausted/usage_unknown/run_cancelled、容量、额度与未知的含义。
7. 已核实DeepSeek型号的相应新修订采用初值C=1000000、I=900000、O=65536、payload=8MiB、单请求600秒；明确长输出O=131072。这是已核对能力下的待验初值。其他型号按已核实目录或管理员声明配置，不默认1M；旧profile缺超时仍90秒；旧消息限额/预算不改。UI展示tokens、MiB、秒，拒绝不可行配置并说明字段原因。

容量实现必须使用完整公式：B=min(I,C−O)，H0=min(65536,max(16384,ceil(0.02C)))，H=min(H0,max(1024,floor(B/8)))，要求B>2H；R=C−B+H，T=B−H，K=min(65536,floor(T/4))。S1=min(floor(0.8R),O)，S2=min(floor(0.5R),O)，保存时S1+S2+K<T，运行时再加固定开销F校验。保留消息边界超额计入F；不能用平均消息短把K降至256/128。

开工时另做一次有界SDK接入核对：沿锁定Pi工具事件和现有output持久化链，确认07的route显式定稿能取得完整助手条目及已持久片段；可用本地协议替身记录真实SDK事件顺序。此时只验证接入，不提前实现07；若根本无法在原身份下成立，提交最小复现及合同影响，避免后期才发现。

为后续v2保留清晰的“当前投影余量”计算入口，但本包不添加尚未消费的新工具参数或空壳预算系统。06沿同一实现分配同批回执空间。

## 必须证明的行为

| 场景 | 可观察断言 |
| --- | --- |
| 慢读取超过一个续租周期；期间更新知识/撤权 | 心跳续租；提交前发现变化，不交付混合正文；无重复副作用 |
| claim/context/renew/结算各注入一次临时DB失败 | Worker存活、后续任务可处理；旧代次晚到被拒绝 |
| C=1M/I=900000/O=65536；I=O=65536反例 | 前者R=120000/T=880000/K=65536；后者因摘要空间不成立被拒绝 |
| SDK摘要输出cap小于O；split-turn | 实际payload与费用reserve尊重较小cap；两段摘要自身输入均受检查 |
| 中文、转义、工具定义、临时资料加入后超阈值 | 完整发送前走Pi原生压缩；不重复统计整份历史；不发送已知超限payload |
| 固定规则/单条输入不可压缩；摘要失败；取消；24次用尽 | 明确对应错误，无无限摘要/重试；取消及时中止请求 |
| 旧profile/检查点、提交成功丢回执后恢复 | 原I/O/载荷/90秒/预算保持；旧操作接回一次；仍是同一Pi会话 |
| 600秒配置与代理链 | 本地协议测试证明冻结/传递/取消；真实首事件等待和8MiB接收留待09授权样本，不冒称已测 |

## 检查、回退与交接

现有命令：`make verify-contracts verify-code verify-architecture`、`make verify-model-provider verify-runtime-flow verify-recovery`；相关脚本 `check-configured-provider.mjs`、`check-request-policy.mjs`（tests/runtime），以及 tests/mvp下 `check-model-configuration.mjs`、`check-native-compaction.mjs`、`check-large-tool-context.mjs`、`check-recovery-continuation.mjs`、`check-checkpoint-storage.mjs`、`check-worker-run-deadline.mjs`。

这些脚本需扩展上述反例。现有原生压缩夹具包含旧64KB/12次profile，保留legacy测试，另加新公式场景；不要统一抬高旧夹具阈值令回归消失。Worker既有约67秒测试证明无60秒整轮截止，不证明临时DB恢复或600秒真实请求。

回退通过新模型修订停止采用未验证配置，不能重写旧冻结profile。关闭时交付实际错误映射、锁序/三段式代码、容量计算测试、旧会话恢复证据、管理员UI单位截图，以及真实端点尚未测的明确记录。独立审查者重点检查Pi能力是否被重复实现。

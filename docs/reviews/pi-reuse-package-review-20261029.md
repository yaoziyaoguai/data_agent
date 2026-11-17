# Pi复用审计与后续执行包复核

日期：2026-10-29。本轮审计当前Pi接入，并更新06–09的实施规格；不实施产品、不关闭05。当前状态仍由 [CURRENT](../CURRENT.md) 维护，规格入口为 [Pi复用约束](../execution/semantic-runtime/pi-reuse.md) 和 [接续提示](../execution/semantic-runtime/CONTINUATION_PROMPT.md)。本文不是实现增量的独立审查JSON或业务通过收据。

## 本地回源结论

锁定和安装版本均为 `@earendil-works/pi-agent-core`、`pi-ai`、`pi-coding-agent` 1.3.0。源码已使用AgentSession、SessionManager、原生工具循环、压缩、retry、abort、模型协议和Skill loader/read；没有证据支持推倒重写Agent层。

| 已核事实 | 代码及既有反例 | 执行包处置 |
| --- | --- | --- |
| 工具每次导出检查点整读并解析Pi JSONL | `apps/agent/tools/data-tools.ts` 的invokeRecorded调用exportCheckpoint；`session/checkpoint.ts`到`journal.ts::storedReference`再调用readJournal；后者readFileSync、逐行JSON.parse、validateEntries。`tests/runtime/check-checkpoint-journal.mjs`已有长日志及原leaf/坏文件负控 | 06先建立实际读取成本基线，再去掉已加载运行内的整本重扫；首次导入/恢复严格核验、原生持久化和确认leaf保留；08/09验证 |
| Node同侧重复校验同一信封与回执 | `data-tools.ts`对DataToolInvocation先validate；`transport/client.ts::post`再validate，同一DataToolOutcome返回后又decode。工具参数和外层信封是不同合同，Rust是独立进程边界 | 06收敛为边界校验后的生成类型，保旧回执优先及错误含义，只改直接调用点 |
| 单answer槽和末条助手消息不足以保留多任务定稿 | `data-tools.ts`的invokeRecorded/execute清空answer，`deliver.ts::commitAnswer`仅取单答案或最近assistant。`check-answer-state.mjs`证明同任务后续失败必须让未定稿旧答失效 | 07沿原输出/工具回执保存各任务定稿引用，保护前项、保持同任务失效；不把所有清空逻辑删除，不猜拼调查正文 |

前两项证实重复执行，没有测得延迟/费用改善比例；第三项是原07合同的已知缺口，不称为05新回归。本轮没有运行产品测试。

## 必须保留的适配

- **恢复打开的严格性。** 锁定SDK的parseSessionEntries/loadEntriesFromFile会跳过坏行，后者可补尾换行。不能直接用它们替代现有坏文件拒绝；正常已加载运行则不必为每个引用重复扫描。应用仍确认原session/leaf和副作用身份。
- **半轮工具接回。** SDK Agent.continue拒绝assistant尾部，也不知道Rust副作用是否提交。应用只沿原调用登记/回执接回再交给Pi，不能改为盲重发或另一规划器。
- **输出持久化。** AgentSession公开订阅回调不await；message_end通知发生在SessionManager落条目前，output-stream还可能在异步写库。07使用工具execute边界的原生条目加原output.drain，事件名不等于业务定稿。
- **生命周期。** 已核对AgentSession.prompt调用并等待_startRun，后者完成原生后处理并发agent_settled后返回。现有await prompt没有因为缺少另一个订阅就失去收尾；不加结束轮询或状态机。
- **业务边界。** 04范围投影、token/请求字节容量、原预算和未知回执、权限及异步后版本重核、02/03同步整理、05索引和检索，都不是Pi能自动替应用落实的业务规则。Skill已有原生接入，未证实的进一步简化不扩成本轮强制项目。

## 包间对应与防漂移

06两项旧接入修复→v2知识/原文纵向小样→批量/支持/容量/游标；07定稿与集成；08旧状态/写入/索引/v2按序切换；09分层语音座舱验收。没有第十包，也不重做01–05。用户的四条复杂度约束已写入共同规格与接续prompt，未知低概率不编数字、不据假设增设框架。

05当前执行提示正文和停止点保留。新增后续prompt是下一实施者的入口；它要求先核05当前证据关闭，再启动06。正式架构合同及现有图册本轮不改，因为这是现有第17节的接入细化，没有模块拓扑变化。

## Oracle交叉审查

首轮咨询 `data-agent-pi-reuse-package-20261029-120231` 使用最高Power 5/5，不启用外部并行代理；附件前后两次确认档位，已提交新会话并取得完整答复。三份冻结附件约59.2K输入tokens；答复SHA256 `c909cd3910fb65b9b661115fef38547bbc100719330b1cf6e3bf1b54d0829b77`。确切Chrome进程已退出、临时Profile已删除。原材料及证据在 `.local/pi-reuse-package-20261029/`，处置导航见 [cross-validation](../execution/semantic-runtime/cross-validation.md)。

Oracle确认三项问题和既定责任划分，结论为“需修订”。主代理回源后采纳以下三处补充：

1. **写盘失败仍必须拒绝无效引用。** SDK `_appendEntry`先更新内存leaf后persist，`isPersisted`仅模式；当前deliver错误出口又导出checkpoint。取消健康路径整读不能只保留fsync就声称安全。06增加真实SDK追加/首次flush/同步失败窄反例，错误出口不替换宿主确认引用；文件完整才沿原leaf恢复，坏文件继续拒绝。未知故障发生率不虚构数字，此为现有持久化合同，不是新增保护框架。
2. **候选成功与业务定稿分开。** 查询答案成功回执是内容依据，只有Rust已提交的可恢复part才进入已定稿集合。明确原有提交点，保留同任务未定稿失败反例，不把旧v1缺字段猜为定稿，不增新工具/调用。
3. **同步修改单槽消费者与半轮接回。** `text_delta`写入不能因A已有part抑制B；恢复在新outputStream创建前直接调用invokeRecorded。沿原登记保存宿主条目/原attempt/片段绑定，分别测试登记未冻结和冻结丢回执。本地额外核对runtime登记与output_chunks后确认这项接线要求，不新增账本或正文副本。

上述修订已进入执行包。第二轮 `data-agent-pi-reuse-final-20261029-121812` 已在附件前后确认Power 5/5，但网页出现 `cloudflare_challenge`；本次target只读核查显示0个已提交user/assistant条目，没有可采用答复。主代理停止确切临时Chrome，wrapper随后以chrome-closed退出；浏览器及临时Profile均已清理，没有重试或操作挑战。固定资料、只读观察及清理证据在 `.local/pi-reuse-package-20261029/final-review/`。

最终稿由主代理对照首轮原答复、SDK更新/异常顺序、现有Rust工具登记及输出attempt存储复核。首轮三项意见均有对应修改和窄反例，没有新增产品功能、框架或用户必须决定的取舍；查询part的具体字段及原事务接线属于07首个contract-first切片的工程选择。执行包可以作为后续实施规格使用，但**不能宣称Oracle已批准最终稿**，也不能把未运行的失败小样算通过。真正移除现有检查点保护前，实施者须先拿到06指定的实际故障证据。

## 本轮验证边界

最终 `make verify-materials verify-delivery` 通过：473项准备静态核对、297文档链接、当前complete收据与契约/输入一致、16项检查器测试通过。另查本轮12份文档80个本地链接/锚点（CURRENT仅新增交接节）通过；`git diff --check`通过。没有重新运行产品验收。

最终检查曾碰到05原实施者关闭记录的中间状态：increment已为complete、evidence仍为null，检查器明确拒绝；当时正式四组收据已passed。待原实施者补入指定收据路径后，重新检查通过。失败日志保存在 `final-static-before-05-closure.log`，成功日志为 `final-static-checks.log`；未修改或代填05的状态/收据，未把中间失败抹掉。

对照本轮开工快照，05的contract、18项决定、冻结文件、声明路径与检查器指纹均未变化；后续文件不在它的verification_inputs内。CURRENT中05实施进展和关闭字段由原实施者更新，本轮仅增加后续包交接节。所有本轮快照、资料清单及检查结果留在忽略目录 `.local/pi-reuse-package-20261029/`，不把其他实施者的全部git diff算成本轮改动。

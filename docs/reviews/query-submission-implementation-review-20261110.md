# 查询准备修复限定独审

日期：2026-11-10。审查依据为[查询准备与试用收尾包](../execution/semantic-runtime/query-submission-repairs.md) §3–7、AGENTS 和 M07 模块合同。当前状态只在 [CURRENT](../CURRENT.md) 维护。本记录不关闭整个09，不证明真实模型、真实平台或 OpenAI 接入通过。

## 范围和方法

由未参与本轮实现的单名审查者完成一次限定独审。全程只读，未编辑、委派、跑测试、连接数据库、读取凭据或调用网络、模型。使用 `.local/checks/query-submission-implementation-20261110/baseline.json` 与 `before/` 比较，不以 Git HEAD 的全部继承差异作为本轮变化。15份基线副本哈希均核对一致。

审查范围：

- 产品：`modules/queries/{mod.rs,store.rs}` 和 `use_cases/query_workflow.rs`，参照原 `deliver_run::start_delivery` 的双 future 结构。
- 测试：`harness.mjs`、`check-conversational-query.mjs`、新 `check-query-preparation-lease.mjs`、新 Rust `query_preparation_lease.rs`；后来仅新增的 `check-query-text-authority.mjs` 一条通知身份断言也定点核对。
- 正式设计中的续租表项/段落、CURRENT 的验收变更及运行证据。
- 本地一次性真实代表候选 `run-real-representative.mjs` 的范围、独立预期、草稿/提交/通知/续聊和账本保全；脚本尚未运行。

## 结论

未发现最终三处产品差异内的确定缺陷。产品续租、事务边界及已提供的相称工程检查符合执行包；真实候选脚本发现的两处验收缺口均已修复并定点复核。最终相关动态日志为 EXIT0，但审查者没有自行运行动态验证。

M07续租的条件 UPDATE 核 query、真实 Worker `lease_owner`、epoch、数据库时间下未过期及可处理状态。业务 `owner_id` 继续用于用户权限与平台身份。领取、续租、事务交接同源15秒，续租不改授权、预算、owner/epoch或提交计数。末尾刷新 UPDATE 自身核 query/epoch/未过期，拒绝错误沿原事务路径传播，新增提交状态和计数回滚。

`process_due` 的准备与续租 future 持续并行轮询，准备覆盖读取、来源预检、锁内重核至 commit；不存在 tick 分支串行 await 续租而暂停准备的问题。commit 后仍先拦截 `authorization_error`，原 submit/lookup/cancel、未知查证、计数及结果通知预算路径保持。SQL 留在 M07 私有 store，组合层只调用公开操作。未增加重复 Schema 校验、通用租约框架、宽泛错误吞没或额外 Agent 循环，符合四条编程规则。

## 测试与实际证据

证据目录：`.local/checks/query-submission-implementation-20261110/`。

| 证据 | 核对结果 |
| --- | --- |
| `preparation-red.log`、`preparation-red-evidence.json` | EXIT1；跨原到期2369ms，同领取到期值未推进，实际 submit=0 |
| `preparation-green4.log`、`preparation-green-evidence.json` | EXIT0；跨原到期2177ms仍持原领取，首次 submit 同 owner/epoch，实际请求1次；最终 epoch=2为正常 lookup 换代 |
| `storage-green.log` | EXIT0，真实 MySQL 局部测试1项通过：有效续租、错误Worker/代次/过期/终态拒绝，交接刷新及首次检查后跨到期的事务回滚 |
| `conversational-v1.log` | EXIT0，12项原业务检查完整通过 |
| `conversational-v2-after-startup-probe.log` | EXIT0，单条/批量2项通过 |
| `query-text-authority2.log` | EXIT0，8项原检查通过，提交前撤源零提交、unknown原身份查证/取消保持 |
| `rust-check-build.log`、`binary-freshness.json` | 最终 EXIT0；三处产品源码与构建记录一致，当前 API/Worker 实际 SHA256 均匹配 |
| `types-architecture.log` | EXIT0；类型、模块依赖/SQL位置/表归属及12个边界检查通过 |
| `reused-source-evidence.json` | 9份原工具门、控制投影、Pi交付和来源输入当前指纹一致 |

新慢准备回归严格核领取之后越过原到期、同 owner/epoch 续租、阻塞期间零 submit、首次提交承接原领取、实际代理请求恰1次及原授权/operation/预算不变。同代次要求不扩至终态。动态阻塞的是会话行锁；准备持查询行锁、续租等待该锁时的并行性按包通过双 future 结构静态核对，不冒称动态覆盖。

Rust局部测试的延迟触发器只在随机合成库由 harness 既有管理连接建立/清理，不改应用权限或数据库全局设置。前几次静态类型和DDL夹具失败全部保留，不作为通过证据。

v2首次 API health 超时的 `conversational-v2.log` EXIT1与空启动日志保留；一次限定启动诊断22.448秒健康，仅说明该次启动成功，不能解释之前的超时。默认60秒启动窗口未改，之后仅复验一次取得上述 EXIT0。

原聊天测试只调整指定 capture 与首查询完成等待，默认 `until` 仍20秒，其余业务断言未放宽。`query-text-authority` 首跑因旧夹具缺 `task_ref` EXIT1；仅补严格任务/条件深比较，依据为未改动的 `deliver_run.rs` 和 WorkspaceContext 原合同。其余撤源、授权、预算、unknown/取消断言保持。CURRENT已记录原值、新值及依据。

## 候选脚本发现与修订

两处均为未运行的本地验收脚本缺口，不涉及产品修改。

1. 原候选无条件发送“原结果中的已知与匿名客户数”续聊，并凭 prepare 绑定和关键词置通过；Q02合法结果可能只有已知数或匿名存在标记，不能证明题目数据前提。修后复用独立 `customer_roles`，要求原结果确有 known/anonymous 两组及对应去重客户度量；不满足就在发消息前记 `not_run_precondition_not_met`，不改题、补查或强制零提交。即便调用完成，也只记 `continuationCompleted`，语义审查保持 pending，不能把匿名组去重0说成实际匿名人数0。
2. 跳过续聊时，原候选会漏掉代表结束时是否另造草稿的核验。修后在 `representativePassed=true` 之前无条件严格检查本会话查询数量为1。

两处最终修订均已复读，`real-runner-syntax.log` EXIT0。其余静态流程沿原 trial/库与额度、唯一新草稿、本次实际SQL/参数独立校验、正常消息交给Pi自主执行、实际submit请求计数、原通知预算及历史查询/调用/费用/预留前后核对。语法与静态审查不构成真实通过。

## 剩余边界

审查完成时真实代表及续聊未运行，trial尚未延期，日常服务未更新。原trial只读预检保持33次分配、276399微美元已花费和348644微美元预留，窗口已过期。日常API/Bridge/Worker仍为11月7日启动的进程。

主线程将在归档本记录后执行 `make verify-delivery`；这项记录检查由主线程负责，审查者没有收到其完成证据，也不将其计为本次动态独审。09继续 `active / review pending / evidence null`，真实窗口按执行包§7处理，不重做本包工程或扩全量评测。

## 主实施者后续运行附记

以下为独审结束后主实施者实际运行，不冒称审查者动态复验或新的独立结论。`verify-delivery.log` 已取得EXIT0及16个记录检查自测通过。用户随后批准原trial延期两小时，事务回执仅expires_at改变，其余列相等。

唯一真实attempt已运行并在新有效草稿独立Q02校验处失败，见上述证据目录内`real-representative.json`/`.log`及`real-representative-diagnosis.json`。完整四列形状未获独立验证，新稿自行增加“已知客户数+匿名存在1”度量；平台语法通过不证明业务通过，不能把expected_rows=null冒称每列数值都错误。实际submit0，明确执行/自动结果解释/续聊均未进入，按包停止，不改SQL或校验预期再试。10次真实HTTP与10条settled调用对账，新增89908微美元，原348644预留及全部旧历史保持。工程结论与这条真实失败分别记录；日常服务仍未更新。

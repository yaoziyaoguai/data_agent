# 任务续接修复限定独审（2026-11-10）

审查范围为[任务续接修复包](../execution/semantic-runtime/interaction-continuation-repairs.md)§4–6。基线为`codex/semantic-maintenance-prototype / 04d27d0`加继承的未提交工作；逐文件副本及指纹见`.local/checks/interaction-continuation-20261110/before/`与`baseline.json`，不能以HEAD替代被审工作树。当前实施状态只在[CURRENT](../CURRENT.md)维护。

未参与本包实现的一名审查者只读核对以下六文件相对副本的差异、相关正式设计及指定日志/payload：

- `apps/agent/session/task-projection.ts`
- `apps/agent/session/resources.ts`
- `apps/agent/tools/data-tools.ts`
- `crates/data-agent/src/use_cases/data_tools.rs`
- `tests/runtime/check-request-context.mjs`
- `tests/mvp/check-conversational-query.mjs`

没有重新审计六组产品实现或全项目，没有编辑、委派、运行测试/数据库/模型/网络，也没有读取凭据或其他私有会话。主owner提供了正在结束的v1回归最终结果，审查者在原限定审查中补充结论，没有再组织审查团。

## 审查者结论

未发现指定差异内的确定产品缺陷，但§4–6验证未闭合，不能宣称工程通过。

| 核对项 | 限定结论及依据 |
| --- | --- |
| 安全控制投影 | 仅为已核定`task_context_required`保留固定hint及task/query的身份、版本、状态和问题ID；不携SQL、参数、条件、问题/答案正文、自由detail或尚未开放的read_tool。RED/GREEN实际序列化payload由只有error/outcome转为带安全指导，GREEN无旧正文/恢复正文哨兵。SDK隐藏调用保留原ID、isError及空data，不伪造Rust operation/error/recovery。 |
| 生产活动工具门 | fixture接同一`attachToolGate → setActiveToolsByName`；隐藏工具由Pi拒绝，Rust派发0。随后在同session/message内，经合同替身拒绝、route、一次宿主刷新，实际派发get_query/execute_query。刷新仍未知、错误ready回执均不解锁。消费者GREEN为38个合成请求、外部网络0；不证明真实模型理解。 |
| v2事务证明 | 真实Rust/MySQL中，两份草稿均未确认，仅route A后读A/B；以完整基线证明后项版本失效无本批新增确认/关联/授权，先前route保持。合法集合用新operation、同消息/预算，各查询实际合成平台提交1次。该真实场景没有产生context_reset，必要刷新由消费者接缝证明，不冒称真实Rust此次经历了刷新。 |
| v1错误回执断言 | 原`assert.rejects(piTool.execute)`与已存在的`isError:true`回执合同不符。主owner改为核isError、原details深比较及完整error/recovery身份；原授权、归属、其他消息阻塞和恢复断言未放宽。首次EXIT1保留。 |
| Pi与实现边界 | Schema、deliver、workspace-context基线指纹不变；Rust差异仅固定hint。无新增Agent循环、自动route、重试规划器、会话或恢复框架，无重复Schema校验、推测性防护、无必要helper或try/catch。原来源、权限、批量授权事务及操作/预算身份不改。 |

## 已运行证据及未通过出口

以下日志均位于`.local/checks/interaction-continuation-20261110/`；测试由主owner运行，不能称为审查者复验。

| 检查 | 实际结果 |
| --- | --- |
| 消费者最小RED | `request-context-red3.log` EXIT=1，实际payload删掉新增控制字段。前两次测试接线错误也保留；`consumer-control-red-payloads.json`保留原RED载荷。 |
| 消费者GREEN及收尾 | `request-context-green.log`、`stateless-final.log` EXIT=0；后者包含消费者、原SDK请求容量与状态检查、contracts:check、类型检查。 |
| Rust检查/构建 | `rust-check-build.log` EXIT=0，fmt/clippy和API、Worker分别顺序重建；`binary-freshness.json`核新mtime及API实际hint。首次误要求Worker包含API hint的检查失败单列，不据此反复重建。 |
| v2来源准入 | `conversational-source-admission2.log` EXIT=0；原始回执在`.local/checks/conversational-query-source-admission.json`。首次成功回执error:null被fixture误按undefined拒绝，失败日志/快照保留，仅修测试成功判定。 |
| 默认v1首次 | `conversational-v1.log` EXIT=1；直接执行、长文本场景通过后，停在上述旧throws断言。 |
| v1修正后复验 | `conversational-v1-compatibility.log` EXIT=1，第二条消息capture超时；该轮Worker恢复后无run_started。 |
| 一次只读诊断后复验 | `conversational-v1-after-diagnosis.log` EXIT=1，停在“自动归属查询完成”。服务日志有`query_worker_failure code=lease_lost`，平台submissions为空。诊断后停止该分支，没有继续重跑。 |

审查者根据主owner最终回报明确保留v1验证缺口：15秒领取租约、领取后来源/权限preflight、提交前租约核验构成定位线索，不能用当前MySQL 770ms、锁等待0解释失败时序，也不能因该路径不在本包差异内就豁免必跑回归。具体证据在`v1-capture-timeout-diagnosis.json`及`v1-stopped-service-diagnosis.json`；没有修改租约、提高等待阈值或干预用户进程。底层延迟/租约失效原因未确定。

## 结论边界

工程出口尚未通过，真实代表未进入，不能用消费者或v2合成平台通过替代默认v1完整回归或真实模型通过。原trial窗口读回已过期，原33次分配、276399微美元已花费及348644微美元预留保持；本轮真实模型调用、费用和预留新增为0。未请求或实施延期来绕过工程前置条件，未复活superseded稿或人工执行。

09保持active、review pending、evidence null；OpenAI网络与其他09缺口不在本包处置。未提交、推送、部署或更新日常服务。当前下一动作与停止状态以CURRENT为准。

# 本地试用前的收尾交接

日期：2026-11-24。本文件是这一刻的交接快照，回答三件事：还要做什么、现在有哪些问题、它们在代码的什么位置。**唯一当前记录是 [CURRENT](../../CURRENT.md) 最新一节“本地试用前的剩余修复（2026-11-24）”及其 front matter。** 本文件与它不一致时以 CURRENT 为准。接手时重新核实分支、工作树和进程，本文不授予提交、推送或付费调用的权限。

## 1. 现在到哪一步

目标是让项目可以开始本地试用。基线是 `5f6e4d0` 加两轮未提交的修复，分支 `codex/semantic-maintenance-prototype`（远端默认分支）。

| 部分 | 状态 |
| --- | --- |
| 上一轮留下的 11 条待决项 | 已逐条裁决，见 CURRENT“裁决”。裁决可以否决，推翻哪条都是产品改动 |
| 四处修复：目录刷新、结果卡权限再读、结构缺口、文档原文向量目标 | 代码和相关测试已改完 |
| 设计文档、契约说明 | 已同步到封板后的行为 |
| 受“文档原文向量目标”影响的非绑定脚本和 Rust 用例 | 已对齐并逐份运行。两份改动前后都失败的旧脚本没有修，见 3.2 |
| 48 项可运行的绑定验收 | 在最终二进制上串行重跑：47 项首次通过，`CONTRACT-RECOVERY-SUITE` 在宿主负载尖峰时首次失败、单独重跑通过。见 CURRENT“验证” |
| 静态门禁 | 10 步通过 |
| 混合检索长电池 | 只验证了到整理夹具为止的前缀，覆盖本轮改动的全部段落；整条电池在当前宿主负载下没有跑完 |
| 提交与推送 | 按用户要求分 9 批提交到当前分支并推送，清单见第 5 节；终轮结果随其后的记录提交补入 |

## 2. 接下来要做的事

本轮的修复和验证已经做完，剩下的事按先后：

1. 用户启动试用：`make infra-up && make dev`。试用库的 547 条知识条目在 11 月 21 日已完成词法索引，向量状态保持 `pending`，启动后 Worker 没有东西要处理；首次启动会在原库上补跑 12 个迁移（2026-11-25 更正：原文写“试用库有 547 条知识条目待索引，首次启动由 Worker 处理”；在库副本上的启动演练见 CURRENT 的“本地试用收尾（2026-11-25）”）。
2. 可选：宿主安静时（负载 10 以下）完整跑一次 `node tests/mvp/check-hybrid-retrieval.mjs`，约 45 分钟，含三次全量索引。本轮只验证了它的前半段。
3. 可选：修两份改动前后都失败的旧脚本，见 3.2 的 Q1、Q2。
4. 关闭增量之前：真实模型冒烟需要授权；`make verify-increment --complete` 还缺两项验收的输入（Q5）。

不在这一轮的事：真实模型冒烟（需要授权）、里程碑标签和 CI、清理不是本轮启动的残留进程和测试库。

## 3. 问题、原因和代码位置

### 3.1 已处理

| 编号 | 现象 | 原因 | 位置 | 处理 |
| --- | --- | --- | --- | --- |
| P1 | `DIRECTORY-REFRESH` 在基线脚本 29 行超时 | 11-21 返工后语义页不再定时刷新目录；维护入口只对维护者角色可见，角色由是否负责对象推导 | [check-knowledge-experience-browser.mjs](../../../tests/mvp/check-knowledge-experience-browser.mjs)；[KnowledgePage.tsx](../../../apps/web/src/features/knowledge/KnowledgePage.tsx) 第 149 行 `canMaintain`、第 223 行 `catalog_changed`；[semantic_governance.rs](../../../crates/data-agent/src/use_cases/semantic_governance.rs) 第 13 行 `highest_role` | 脚本改按目录变更信号核验；Bob 的空目录改用全部对象加无结果筛选。产品没有改 |
| P2 | 编辑器打开期间，别人保存了多章文档的非代表章节，阅读区看不到新正文 | 阅读区只在进入页面和回到窗口时读取；代表章节的版本不随其他章节变化 | [KnowledgeDocument.tsx](../../../apps/web/src/features/knowledge/KnowledgeDocument.tsx) 第 68 行读取依赖；`KnowledgePage.tsx` 第 127、223、563 行 | 目录变更信号递增 `catalogRevision`，阅读区随之重读。产品修复 |
| P3 | `QUERY-RESULT-PERMISSION-POLL` 在基线脚本 84 行等不到定时再读 | 结果卡不再定时读取，按权限通知或窗口唤醒重验 | [check-report-reading-position-browser.mjs](../../../tests/mvp/check-report-reading-position-browser.mjs) 第 87、104 行 | 脚本改按事件核验。产品没有改 |
| P4 | 条目的列不在当前 DDL，或表 DDL 改版后指纹对不上，只读读取整次失败 | 读后复核沿采用路径核对结构绑定 | [references.rs](../../../crates/data-agent/src/use_cases/knowledge/references.rs) 第 12 行 `check_delivered_refs_in_tx`、第 59 行依赖表读取、第 97 行绑定证明、第 311 行缺口规则；调用点 [context_authority.rs](../../../crates/data-agent/src/use_cases/context_authority.rs) 第 484 行 | 依赖表读不到仍拒绝；绑定对不上当前 DDL 时，已按缺口交付的读取不再拒绝。正式采用和写路径继续严格 |
| P5 | 每次保存文档都把全文再嵌入一遍写进向量集合，但永远召回不到 | `4e1f2a6` 起原文召回只查平台摘录，文档原文目标的登记没有跟着停 | [knowledge_documents.rs](../../../crates/data-agent/src/use_cases/knowledge_documents.rs) 第 156 行；[raw_index_handover.rs](../../../crates/data-agent/src/use_cases/raw_index_handover.rs) 第 86 行；召回过滤在 `crates/data-agent/src/modules/retrieval/vector/scan.rs` 第 469 行，没有改；调用点 [maintenance.rs](../../../crates/data-agent/src/use_cases/knowledge/maintenance.rs) 第 206、346、410 行 | 保存只排队语义准备；显式重建只补登记平台来源。封板前登记的文档目标和旧 raw 作业仍由原路径收敛。试用库没有这类行，不需要迁移 |
| P6 | 设计文档和契约说明仍写“先 route，宿主确认就绪后才恢复工具” | `4e1f2a6` 移除了 v2 就绪门，文字没有跟着改 | [implementation-design.md](../../architecture/implementation-design.md) 六处、[runtime-modules.md](../../architecture/runtime-modules.md) 第 324 行、[semantic-retrieval-design.md](../../semantic-retrieval-design.md) 第 637、922 行；`packages/contracts/schema.json` 里 `source_context_ready` 等字段的说明 | 改成封板后的准入规则。规则本身在 `crates/data-agent/src/use_cases/source_limits.rs` 第 103 行，没有改。契约只改说明，字段和枚举保留 |
| P7 | `QUERY-NOTIFICATION-SOURCES` 实跑 358 秒，绑定超时 360 秒 | 脚本场景增多，`make verify-increment --complete` 会按这个超时终止进程 | `docs/CURRENT.md` front matter 的 `timeout_seconds` | 改为 480 秒。脚本内部的时限和断言没有改 |

上一轮（第二份独立审计）修的三处产品问题在同一个工作树里：成功答案回执重放前补核结果权限（[preflight.rs](../../../crates/data-agent/src/use_cases/data_tools/preflight.rs) 第 112 行）；草稿采用的知识停用后确认返回 `stale_context`（[query_workflow.rs](../../../crates/data-agent/src/use_cases/query_workflow.rs) 第 76 行）；契约保留显式空值（`packages/contracts/generate.mjs`）。详见 CURRENT 的“审计收口修复与绑定验收对齐（2026-11-24）”。

### 3.2 已知但没有处理

| 编号 | 问题 | 位置 | 说明 |
| --- | --- | --- | --- |
| Q1 | `check-public-index-upgrade.mjs` 两种模式都失败 | [第 119 行](../../../tests/mvp/check-public-index-upgrade.mjs)、第 237 行；`--owner` 模式不先准备向量集合 | 不在绑定验收里，改动前就失败。修法：原文夹具换成已索引超过 10 万字符的平台来源，owner 模式先准备集合 |
| Q2 | `check-retrieval-allowed-set.mjs` 在第 97 行失败 | [第 97 行](../../../tests/mvp/check-retrieval-allowed-set.mjs) | 按合同 1 取 `objects`，新运行的回执按合同 2 只有 `hits`。HEAD 版本在同一行失败。要按合同 2 重写读取和检索断言 |
| Q3 | `update_analysis_task` 的回执重放不重新核验 `knowledge_refs` | `crates/data-agent/src/use_cases` 的任务回执重放 | 设计问题，两轮都没有改 |
| Q4 | 宿主负载、被整体删除的 `target/`、不是本轮启动的合成平台进程和测试库 | 环境记录见 CURRENT“未执行与未处理” | 没有动。本轮采样 259 次有 17 次负载超过 50，最高 162；`CONTRACT-RECOVERY-SUITE` 的首次失败和长电池没有跑完都发生在负载尖峰 |
| Q6 | 到期断言余量小 | `crates/data-agent/tests/tool_contract_version.rs` 第 357 行 | 租约 1000 毫秒、只多睡 100 毫秒就断言到期，负载尖峰时虚拟机时钟走得慢会误报。本轮没有改 |
| Q5 | `INTEGRATED-EVIDENCE` 和 `SOURCE-TRAJECTORY-EVIDENCE` 缺输入 | `.local/dogfood-runs/qa-usability-20261116/` 在本机不存在 | 没有运行 |

## 4. 裁决清单

11 条待决项的完整理由在 CURRENT“裁决”。一览：

| 待决项 | 裁决 |
| --- | --- |
| `related` 依赖行 | 确认封板语义，草稿来源门只比较所选条目自己的来源身份 |
| 普通用户的维护入口 | 确认 P-04；角色由是否负责对象推导，服务端 `can_edit` 没有改 |
| 结果卡的定时再读 | 确认事件驱动 |
| 按 run 新旧的整次拒绝 | 保持封板行为 |
| DDL 指纹不一致 | 只读读取不再整次失败，正式采用继续严格 |
| 没有来源身份的知识条目 | 保持现状。试用库 1661 条启用条目全部带来源身份 |
| 文档原文的向量索引 | 停掉 |
| 来源准入 | 确认封板语义，文字同步 |
| 通知验收的时间余量 | 绑定超时 360 秒改为 480 秒 |
| `validate_sql` 对已停用来源的宽容 | 保持基线行为 |
| 只读过、未采用已停用文档的 run | 保持用户已确认的预期 |

## 5. 提交清单

按依赖顺序：

| 提交 | 内容 |
| --- | --- |
| `80c4031` fix(contracts) | 契约保留显式空值；旧就绪字段的说明改为旧字段；重新生成类型 |
| `e3a903f` fix(authority) | 结构缺口不再让只读读取整次失败，含 `check-structure-column-bindings.mjs` |
| `032c7a6` fix(authority) | 成功答案回执重放前补核；草稿采用的知识停用后确认返回 `stale_context` |
| `a7e8e64` fix(index) | 文档不再登记原文向量目标，含相关 Rust 用例和脚本 |
| `3736a10` test(retrieval) | 原文召回夹具改用平台来源 |
| `d91a68f` fix(web) | 文档阅读区随目录变更信号重读，含两条浏览器门禁脚本 |
| `d5d8f7e` test | 绑定验收脚本随封板后的合同和来源规则对齐 |
| `a1d0cdb` docs | 设计文档同步封板后的准入规则和“原文向量目标只属于平台来源” |
| `7b10289` docs | CURRENT 记录和本文件 |

终轮结果随其后的一个 `docs` 提交补入。中间提交没有逐个单独构建，只有最终工作树经过完整检查；验证状态写在 CURRENT“验证”。

## 6. 验证证据

都在 `.local/checks/audit2/roundd/`，没有纳入 Git：

- `base-chain.log` 和 `base-*.log`：改动前的对照运行。
- `diag-red.log`、`diag.log`：文档阅读区探针，去掉修复和保留修复各一次。
- `diag-runner.log`：索引收尾等待超时的原因（测试清理留下 4 条没有对象的知识行）。
- `prebuild-summary.txt`、`bin-roundd.sha256`：fmt、clippy、类型检查和两个二进制的摘要。
- `rd-new-summary.txt`、`rd-new2-summary.txt`：受影响的非绑定脚本。
- `rd-F1-summary.txt` 到 `rd-F4-summary.txt`、`rd-master2-summary.txt`：绑定验收终轮。
- `rd-contract-recovery.log`、`rd-contract-recovery-rerun.log`：负载尖峰时的首次失败和单独重跑。
- `rd-hybrid-prefix.log`：混合检索长电池的前缀。
- `st-static-summary.txt`、`post-static-summary.txt`：静态门禁。
- `load.log`：宿主负载采样。

## 7. 接手提示

- 同一时间只跑一个 harness 脚本。构建（含 `cargo test` 的编译）不要和带时限的验收同时进行。
- 同一条 cargo 命令带多个 `-p` 又加 `--bin` 过滤时，只构建被选中的目标，api 和 worker 的二进制原样不动。不带过滤的多 `-p` 构建两个都会重链（2026-11-25 更正：原文写成“多个 `-p` 的 cargo 构建会静默跳过 api 或 worker 的重链”，把带 `--bin` 过滤的那一次观测推广了；对照实验见 CURRENT 的“本地试用收尾（2026-11-25）”）。构建后核对两个二进制的修改时间。
- 看门狗或手动终止 harness 后，api、worker、桥接、合成平台进程，以及测试库和 Milvus 集合都会留下，先确认归属再清。
- `check-shared-index-todo.mjs` 的 SQL 代理按语句前缀识别领取和头查询。领取语句的文本变了，分类器要跟着改。
- `docs/CURRENT.md` 的正文表格含 `---` 分隔行，只能用锚定在文件开头的正则解析 front matter。
- 预填相关验收需要 `.local/tokenizer-reference-venv`，Makefile 不负责创建。

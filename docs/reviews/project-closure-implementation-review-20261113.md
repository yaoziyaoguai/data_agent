# 指标语义与报告定位收尾实施审查

日期：2026-11-13。审查依据为[指标语义与报告定位收尾执行包](../execution/semantic-runtime/project-closure.md) §1–2、§4、§5、§8、§10，由未参与本轮实现的单名审查者完成范围明确的代码级独审。当前状态只在 [CURRENT](../../CURRENT.md) 维护；本记录不关闭 09，不证明真实模型、真实平台通过，也不构成产品审查或绑定验收。

## 范围和方法

全程只读产品/测试/文档，未编辑任何受审文件，未连接数据库，未运行数据库 harness，未调用网络或模型，未提交推送。以 `.local/checks/metric-report-closure-20261113/` 的 20 份 before/ 副本逐文件 diff 划定本轮改动集（14 份有差异、6 份确认未改），不以 Git HEAD 的全部继承差异充当本轮变化；基线 32 份哈希与环境记录核对存在且不含凭据值。工作树内其余未提交改动不属本次审查范围。

审查范围（本轮全部改动）：

- 规则与工具说明：`apps/agent/session/resources.ts`、`apps/agent/tools/data-tools.ts`。
- 判分器与基准：`scripts/evaluate_business_sql.py`、`tests/mvp/check-business-evaluator.mjs`。
- 报告锚点产品链：`packages/contracts/schema.json`（含生成两侧）、`crates/data-agent/src/modules/conversations/{store.rs,mod.rs}`、`crates/data-agent/src/use_cases/read_conversation.rs`、`apps/web/src/features/workbench/conversation-timeline.ts`。
- 测试：`tests/mvp/check-conversation-timeline.mjs`、`check-analysis-reports.mjs`、`tests/runtime/check-evidence-tool-shape.mjs` 及新 fixture `q02-read-knowledge-receipt-data.json`。
- 文档：`docs/architecture/runtime-modules.md`、`docs/architecture/implementation-design.md`、执行包 §10 本身。

审查者自行复跑（均无数据库依赖）：合同检查 667 项通过；时间线投影 11 项通过；工具正文/规则装配 9 项通过（`databaseUsed:false`）；独立判分 13 参考用例通过；架构/SQL 位置与锁序检查通过；`cargo build --offline --locked`、`cargo fmt --all --check` 通过。数据库 harness 按约束未复跑，仅核对已保存证据与时间线。

## 结论

**有条件通过。** 未发现产品代码或测试改动内的确定缺陷；§10 实施记录的陈述与实际 diff、保存证据基本一致。条件为补足一项证据时序缺口：全部数据库 harness 运行所用二进制构建于 `read_conversation.rs` 最后一次修改之前，冻结重建后未复跑（见建议 1）。补跑一次冻结后数据库 harness、或在记录中披露该次修改的具体内容，即可转为此轮工程证据完整。

## 逐项发现

### A. SQL 与事务正确性——通过

- `report_first_saved_seq_in_tx`（`crates/data-agent/src/modules/conversations/store.rs:107-137`）SQL 为 `WHERE conversation_id=? AND event_type='analysis_report_saved' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.report_id')) IN (…) GROUP BY rid` 取 `MIN(event_seq)`，无版本、任务条件版本或事件页筛选，符合"同一 conversation_id+report_id 全部已保存版本取最小序号"。紧邻的既有 `first_query_changed_seq_in_tx`（store.rs:84-104）同构，事件表列名（`event_seq/event_type/payload`）与 `append_event_in_tx` 写入（store.rs:435）一致；两处 `analysis_report_saved` 发出点（`use_cases/analysis_reports.rs:600-609`、`use_cases/data_tools.rs:2615-2621`）payload 即 receipt，`save_report_in_tx` 返回的 reference 顶层含 `report_id`（`modules/analysis/report/store.rs:196-197,232`），`$.report_id` 提取正确。
- 占位符绑定顺序正确：`conversation_id=?` 先绑 cid，`IN` 列表按 `report_ids` 顺序循环绑定（store.rs:123-126）；空列表前置短路（store.rs:112-114）。`sqlx::query(sqlx::AssertSqlSafe(sql))` 与仓库先例一致（`knowledge/store.rs:1104-1114`、`knowledge/dependency_index/store.rs:102-110`、`ingestion/store.rs:555`）。
- 组合位置：`read_page` 在任务保护循环（`read_conversation.rs:276-281`）之后、runs 读取（:300）之前、同一 `AppTx` 内写入任务投影（:282-298）。`Snapshot`（GET）与 `SnapshotRefresh`（POST）同经 `read_page`（`apps/api/src/routes.rs:154-180,181-214`），共路径成立；MySQL 场景测试同时断言两条路径。
- 无 N+1：每次 `read_page` 至多一条聚合查询；锚点不注入 events，`first_event_seq/last_event_seq/has_older/has_newer` 计算未动（:400）。
- 缺保存事件省略字段：仅 `anchors.get(report_id)` 命中才写（:291-297），不写 0/null；真实 MySQL 测试对无报告任务断言 `undefined`。
- 非问题记录：先例对 `IN` 列表按 200 分块，新查询未分块；`report_ids` 由会话任务数约束，实际规模有限，MySQL 占位符上限充足，不构成缺陷。`MIN` 结果必为已插入事件的序号（事件序号从 1 递增，store.rs:427-435），满足 Schema `^[1-9][0-9]{0,19}$`。

### B. 合同语义——通过

`TaskSnapshot` 新增 `report_timeline_event_seq`（`schema.json:1103-1105`，string、`^[1-9][0-9]{0,19}$`）；`required` 保持 `['id','condition_version']`，`additionalProperties:false` 未变。与 `QueryView.timeline_event_seq`（允许 null/"0"）的先例刻意不同：新字段缺省即省略，语义与 §5.2"不填 null 或 0 冒充稳定锚点"一致，§10.1 已如实声明该差异。生成两侧一致：`boundary.ts:3577,4167`（`report_timeline_event_seq?: string`，对应 Snapshot 与 SnapshotRefresh 两处 tasks）、`boundary.rs:4429,5177`（`Option<String>`）；`SnapshotRefresh.tasks` 经 `$ref` 复用 Snapshot 的 TaskSnapshot。审查者复跑合同检查 667 项通过，与 §10.2 记录一致。

### C. 前端匹配逻辑——通过

`conversation-timeline.ts:37-40`：锚点只取 `report_ref.report_id` 与卡片 `reference.report_id` 一致的任务，不凭 task_id 套用；回退顺序为持久锚点 → 当前已加载页 `analysis_report_saved` 事件 → `"0"`，与查询卡既有模式（:15-17）同构。`mergeSnapshot` 快速返回按 tasks 整体 JSON 判等（:107-109）、旧页合并以 previous/incoming 整体替换 tasks（:134），新字段随之透传，不存在被忽略路径。序号全链为字符串经 `BigInt`（:41），Schema 限 20 位十进制、无 Number 中转，无精度或溢出问题；`event_seq` 合同本为 string。外任务锚点反例见时间线测试（`check-conversation-timeline.mjs` 新增块），r2 的锚点不影响 r1。受限文本保护由 Rust 侧 `protect_task_context_in_tx` 处理且不触及 `report_ref`；锚点只影响排序，不新增内容泄露面，旧事件后备行为为既有语义未变。

### D. 不变量未被破坏——通过

本轮 14 份改动均不触及 Pi 原生会话/工具循环、每消息 24 次调用、连续临时失败 3 次、权限/操作/预算身份相关代码：`resources.ts` 仅在既有段落内追加提示文本，`data-tools.ts` 仅改两处工具描述字符串，Rust 侧为只读查询加投影组合，前端为纯投影。`capacity.ts`、`journal.ts`、`deliver.rs`、transport 等不在本轮改动集。§4.1 声明"未改产品交付代码"与 diff 相符（formatResult、投影、容量裁剪、压缩均未动）。

### E. 测试不是改题凑绿——通过

- 与 before/ 副本逐字对照：四份测试全部纯增量，无删除断言、无放宽既有预期；`restoreTool` 仅新增可选 `data` 覆盖缝（`check-evidence-tool-shape.mjs:73`），默认路径不变。
- 原 Q02 失败 SQL 与 `.local/checks/query-submission-implementation-20261110/real-representative.json` 的 `toolObservations[7].arguments.sql` 逐字一致（仅去结尾分号）；测试断言 `passed=false`、`scoring=cannot_autoscore_shape`、`rows=[[5,1,1,6]]`（`check-business-evaluator.mjs:37-39`）——失败仍为失败，分类未把它变成通过。`evaluate_business_sql.py:299` 只新增 `scoring` 键，`passed` 计算未动；数值不符例同时断言 `passed=false` 与 `expected_rows=[[5]]`，"已核算数值不符"与"无法自动判分"分开成立。判分器 13 参考用例、变体与反例计数与 §10.2 一致（审查者复跑）。
- 新增断言走产品路径：MySQL 场景（`check-analysis-reports.mjs` 约及修订后两处插入）经真实 API（GET snapshot、POST refresh、before_seq 补旧页）与真实 `/internal/outputs`、`/internal/finish` 合成 1001+ 流式块；期望锚点 `firstSaveSeq` 由测试直接从数据库 `MIN(event_seq)` 独立读出，非手工塞值；反例前提（保存事件确不在最新页）有显式断言。交付验证 fixture 与原回执 `outcome.data` 逐字相等（含 434/1150 字符分页状态），经真实 v2 `formatResult` 与原生 Pi 会话后在 provider 协议正文与系统提示中断言——规则接线观测的是实际装配后的系统提示，不是源码字符串。
- 浏览器两份脚本与 before/ 一致未改，作为回归运行（保存结果 11+4 项通过）。

### F. 实施记录与证据一致性——基本一致，一处时序缺口（建议 1）

- §10.1 各实现差异陈述与 diff 逐项相符：规则并入既有段落未建第二块（resources.ts:24 段内追加，覆盖 §4.2 五条原则）；v1/v2 各加一句引用（data-tools.ts:37,178）；schema/store/组合/前端与文档描述一致；§10 对执行包为纯追加。
- §10.2 计数核对：timeline 11、evidence-tool-shape 9、判分 13、contracts 667 由审查者复跑一致；analysis-reports 20（脚本 `checks.push` 恰 20 且保存结果 passed/20）、conversational-query 12 与 2、report-text-authority 7、browser 11+4 与保存 JSON 一致；`verify-block-6-1.log` 两次构建及 make verify 均 exit=0，最终二进制 mtime（06:58）晚于最后一次 Rust 源码修改（06:25）。conversational-query 首跑崩溃已如实披露。environment.json 仅记变量名不记值。
- 时序缺口（建议 1）：`read_conversation.rs` 最后修改时间 06:25:45 晚于全部数据库 harness 运行（analysis-reports 06:23:50、conversational-query 06:36/06:41、report-text-authority 06:42、浏览器 06:49/06:51、evidence-knowledge 06:57）；§6.1 冻结重建（06:58，日志中 data-agent 全量重编 51 秒，佐证其间无构建）之后未复跑任何数据库 harness。即数据库证据全部产生于最终二进制之前。缓解事实：06:23 的 20 项运行已含全部新锚点断言并通过，被测二进制已具备完整功能；`store.rs` 自 04:51 未再修改；最终树上全部无数据库检查通过。但 §6.1 要求"实现冻结后……随后串行跑数据库 harness"，实际顺序倒置且 §10.2 未披露。

## 分级清单

- **确定缺陷：** 无。
- **建议 1（证据时序）**：`crates/data-agent/src/use_cases/read_conversation.rs`（mtime 06:25:45）晚于全部数据库 harness 证据（最早 06:23:50），冻结重建后未复跑；§10.2 未披露。建议补一次冻结后数据库 harness 复跑，或在记录中说明该次修改的具体内容（若仅注释/格式）。
- **建议 2（基线覆盖）**：`docs/architecture/runtime-modules.md` 本轮有改动但未纳入 20 份 before/ 副本，确切增量无法逐字隔离；基线哈希显示其接手时已偏离 HEAD，git diff 其余 hunks 内容（M05/M06/M07 台账方言等）与本包无关，判属既有未提交工作，§10.1 所称"conversations 操作表新增该查询行"已在当前文件核实。建议后续把实际触碰文件全部入 before/。
- **非问题**：IN 列表未按先例 200 分块（规模由任务数约束）；`scoring='compared'` 是"已核算比对"标签、通过与否仍由 `passed` 表达；混部场景不命中 mergeSnapshot 快速返回会走慢路径正确合并，包明确不承诺混部。

## 剩余边界

审查者未运行数据库 harness、真实模型与浏览器脚本，相关结论基于保存证据、时间线与静态复核，不冒充动态复验。真实代表按 §10.4 为 `NOT_RUN_AUTHORIZATION`，与无新付费授权一致；DA-001 真实模型改善、产品审查（review pending）与绑定验收（evidence null）维持原状态，本审查不改变它们。

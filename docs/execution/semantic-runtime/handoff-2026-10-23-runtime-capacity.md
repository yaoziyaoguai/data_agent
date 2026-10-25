# 接续交接：运行与容量未关闭，随后连续实施其余八包

日期：2026-10-23。本文件是本次停止时的交接快照；**唯一当前记录是 [CURRENT](../../CURRENT.md) 顶部「停止实施与最终交接」及 `delivery.increment`**。下方启动提示供下一位 coding agent 使用；接手时重新核实分支、文件和进程，不能把历史通过或本文当成新授权。

## 可直接交给下一位 coding agent 的 prompt

请接手本仓库的语义检索与运行改造，完成九阶段执行包。上一个 agent 因额度不足停止，当前仍在 01「运行与容量」；主要代码已落地，但最终回归、独立审查指纹与增量验收未完成，02–09 尚未实施。先收完 01，再依次连续推进 02–09，不要每完成一个包就停下来等待批准。

### 先读这些，不重新开展全架构调研

1. 根目录 `AGENTS.md`。
2. `docs/CURRENT.md` 的 JSON frontmatter、`delivery.increment` 和顶部「停止实施与最终交接（2026-10-23，01未关闭）」；历史节仅按需要追溯。
3. 本交接文件。
4. `docs/execution/semantic-runtime/README.md`、`AGENT_PROMPT.md`、`coverage-and-validation.md`。
5. 当前包 `docs/execution/semantic-runtime/runtime-capacity.md`。
6. `docs/architecture/implementation-design.md` 第17节；这是正式业务合同，执行材料冲突时以已确认合同和最新用户决定为准。

使用已安装 `dev_co` 维护范围和 CURRENT；后续新增行为按 `tdd` 的失败测试→最小实现推进，跨语言合同按 `contract-first` 与仓库同源 Schema 执行。复用已接受的需求，不重新向用户逐项确认。继承的代码不能追溯宣称为 TDD。

### 接手基线

- 分支 `codex/semantic-maintenance-prototype`，HEAD `fed8276577748c1f77c49c7c8ca2317408129ec3`。
- 原设计、架构图、文档与本轮产品/测试修改全部未提交。保留完整工作树，不 reset，不用旧 HEAD 覆盖未提交实现，不另建工作副本。
- 当前增量 `I2-RUNTIME-CAPACITY` 为 active，审查状态已回到 pending，evidence 为空；不能先改 complete 再补测试。
- 本次已停止测试进程。知识 runner 的 `check-boundaries`、`check-lifecycle` 完整通过；`check-mixed-task-cancellation` 按用户停止要求被 SIGTERM，中断后17项未运行。中断不是产品失败，也不是通过。
- 两个专用库保留为诊断证据：`data_agent_test_9e38ff1964cad2ae` 是查询失败现场，`data_agent_test_ce7b38898475b81a` 是中断的知识测试。对应 `.local/checks/mvp-*` 目录保留。不要批量删库或停止共享 MySQL；若清理，先核对专用资源归属。
- 没有 commit、push、付费模型调用、部署或更新日常服务。

### 已有实现，不要重复重写

| 部分 | 主要入口与当前行为 |
| --- | --- |
| 容量合同 | `packages/contracts/schema.json`、`packages/contracts/capacity.ts`、`crates/data-agent/src/modules/runtime/model_configuration/capacity.rs`：总窗口、输入、输出、UTF-8字节、冻结超时分离，Rust/TS同公式 |
| Pi/Provider | `apps/agent/session/capacity.ts`、`session/deliver.ts`、`provider/controlled.ts`、`configured.ts`、`endpoint.ts`、`deepseek.ts`：复用Pi压缩、摘要实际cap/reasoning、运行时开销、完整载荷预检、overflow分类和冻结HTTP超时 |
| 慢检索 | `crates/data-agent/src/use_cases/data_tools.rs`、`knowledge.rs`及领域store：短事务准备→锁外慢读取→回执前短事务重核权限/运行/版本，失效拒绝 `stale_knowledge` |
| Worker | `apps/worker/src/main.rs`、`modules/jobs/store.rs`、`modules/conversations/store.rs`、`modules/runtime/model_calls/store.rs`：临时存储失败不退出、有限恢复、原租约/预算身份和错误分类 |
| legacy文字来源 | `use_cases/invoke_tool.rs`：只为本run绑定的真实完整用户原话记录独立来源，其余及旧NULL仍严格核验 |
| 管理UI | `apps/web/src/features/models/ModelConfigurationPage.tsx`：容量声明及验证；未知型号窗口留空，仅已核实的deepseek-flash提供显式预填 |
| 合成调用方 | `apps/agent/provider/synthetic-analysis.ts`：正确关闭已回答澄清；SQL搜索回执不完整时同ID/版本分页补读，失败/跨版/缺页不造查询 |

`check-slow-retrieval-lease.mjs`、`check-worker-storage-recovery.mjs`、`check-configured-compaction.mjs`、`check-capacity-boundaries.mjs`、`check-capacity-derivation.mjs`、`check-sdk-event-order.mjs`、`check-synthetic-knowledge-reading.mjs` 均已存在并有相应接线。旧交接中要求“新写这些测试”的步骤已经过时。

### 第一个要修的明确失败

`tests/mvp/check-workflow-reliability.mjs` 尚未修改。约128行新 `start(cid)` 后直接 `request_query` 修订，没有先通过 `update_analysis_task` 归属本轮消息。停止前读取的持久工具回执为：

```text
tool_name: request_query
state: rejected
error: message_pending
recovery.reason: current_message_unrouted
```

这不是 Skill 选择失败。请求在进入平台验证屏障前已经拒绝，而测试创建 `revision` Promise 后只等待 `reached`，拒绝没有及时被处理，导致进程退出、`finally` 没有完成。

按现有合同修测试调用前提和错误等待：

1. 保留并显式检查“当前消息未归属时直接修订被拒”的负控。
2. 正式 route 到原任务后，再继续原“平台校验等待期间旧稿已经不能执行”的竞争场景。不能去掉屏障、顺序化该竞争或放宽旧稿拒绝要求。
3. 等待验证屏障时也能收到修订调用的早期失败，保证进入 `finally` 清理测试资源。
4. 先单跑该文件和未运行的 `check-answer-phase.mjs`。没有新增影响时，不为碰运气重跑已通过的前三个查询脚本。

证据：`.local/checks/runtime-capacity-query-boundaries-and-remaining.log`，以及保留的查询专用库。**`.local/checks/mvp-workflow-reliability.json` 仍是旧passed文件，不能作为本轮通过证据。**

### 01剩余工作，按实际缺口接续

1. 修完上述失败，完成两个剩余查询检查。
2. 知识Node回归从中断的 `check-mixed-task-cancellation.mjs` 开始，再依Makefile执行后17项。精确列表和已完成脚本SHA256在 `.local/checks/knowledge-remaining-suite-skill-lifecycle-fixed/result.json`。核对target中prefill/assets/retrieval三组Rust单测是否有当前有效证据，缺口补跑。不要把前两个文件通过写成整个target通过。
3. 最终稳定代码上完成四组已绑定验收：`verify-runtime-capacity`、`verify-retrieval-lease`、`verify-worker-storage-recovery`、`verify-compatible-restore`。慢检索后续租约修正、Worker最后claim/defer注入分支、管理UI及兼容恢复仍需完整gate；不要用此前窄报告替代。
4. 修正涉及合同、类型或架构时补相关检查；继承的通过结果按输入版本和影响复用，既不盲目全跑，也不忽略失效证据。
5. 取得未负责相应实现者的有界独立审查，更新原审查文件及 `scope_sha256`。现有 `docs/reviews/runtime-capacity-implementation-review-20261023.json` 是历史静态审查，指纹早于后续修改，不能关闭当前增量。主实施者不能冒充审查者签结论。
6. 执行 `make verify-delivery`，正式关闭时执行 `make verify-increment`；后者会实际跑四组绑定验收。全部满足后才更新 CURRENT 关闭01并进入02。若在诊断期已单跑某验收，仍按仓库规定完成最终gate，不把文档检查当成业务通过。
7. 依执行包连续推进02–09，按每个增量的契约、反例、回归和审查关闭；不提前宣称真实模型、真实索引或整套dogfood已通过。

### 已有证据与限制

| 检查 | 本轮已知结果 / 证据 |
| --- | --- |
| 合同/代码/架构/运行恢复/provider | 先前通过；合同544项，代码日志 `.local/checks/runtime-capacity-final-code.log`。后续修改需按影响补检，不能当作最终全范围通过 |
| 原两句退款澄清及补读 | 真实本地Pi/Worker/Bridge，合成模型；`refund-clarification-diagnosis-before.json` / `refund-clarification-diagnosis-after.json` |
| 合成调用方7项反例 | `.local/checks/synthetic-knowledge-reading.json`；固定独立输入和SQL期望，零网络；实现及测试有独立静态审查 |
| 查询工作流 | 原8组通过，`.local/checks/runtime-capacity-query-regressions-after-readback.log` |
| 查询边界 / request-clock | 原10组 / 2组通过，`.local/checks/runtime-capacity-query-boundaries-and-remaining.log` |
| 知识工作流 | 原15场景及新增旧引用负控通过，`.local/checks/knowledge-workflow-verified-preconditions-final.log` |
| Skill边界 / 生命周期 | 7组 / 6组通过，`.local/checks/knowledge-remaining-suite-skill-lifecycle-fixed/`逐文件日志 |
| 新配置Pi压缩 | `.local/checks/mvp-configured-compaction.json`：同session三轮、24份正文、split-turn、原预算身份；不等于真实供应商8MiB/600秒验收 |
| SDK事件探针 | `.local/checks/sdk-event-order.json`：message_end先于工具execute，需等待既有output.drain；只证明07接入点，答案定稿尚未实现 |
| 慢检索 / Worker | 有早期通过及专项报告；最后修改后仍待四组最终验收，不从历史report推断全通过 |

表中没有完整目录的诊断JSON均位于 `.local/checks/`。这些本地证据不纳入Git，换机器接手需另核对证据可用性。

夹具修正的原值、新值、独立依据和影响已写入CURRENT：知识指标先重核当前表版本；浏览器非过期用例移除10秒TTL；Skill先结束输入再选择。不要恢复无效前提，也不要以这些修正为借口降低其他断言。

### 环境与执行边界

- 根目录使用当前仓库；Cargo可能需 `export PATH="$HOME/.cargo/bin:$PATH"`，Docker使用 `--context colima-data-agent`。
- harness使用 `target/debug` 二进制。修改Rust后先 `cargo build --offline --locked -p data-agent-api -p data-agent-worker`。
- MySQL容器只有1GiB，已有OOM证据 `.local/checks/mysql-memory-diagnostic.log`。**数据库harness串行运行；不要 `make -j` 并行跑这些target。**
- 不在带真实provider密钥的shell环境直接运行cargo集成测试，不读取或打印 `.env`。优先沿 `tests/mvp/harness.mjs` 清理后的环境；运行验证前清除 `DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、`DEEPSEEK_MODEL`、`DATA_AGENT_MODEL_PROFILE`、`DATA_AGENT_MODEL_FAULT`，仅向测试显式传入本地协议端点。
- 每消息24次模型调用、连续临时失败3次保持；摘要/重试/恢复沿原预算范围、operation_id与回执，不能重新获得旧操作额度。Pi是唯一Agent/压缩/恢复机制。
- 修一般原因；不靠改问题、删场景、降低断言或换mock冒充通过。平台mock、合成可执行数据、真实Pi、本地协议模型、真实供应商分别报告。
- 共享Schema、迁移、Rust组合入口和Pi交付入口由单一owner顺序整合；如使用协作者，给明确归属并说明共享工作树不能撤销他人修改。关键审查仍须独立于相应实现者，遵守当前宿主的代理使用规则。
- 实现目录、函数、变量、数据库对象及测试名不用M01/M02、包号、阶段号，使用业务或技术职责名称。
- 本任务授权代码、相称验证与相关文档。不要据历史授权执行付费调用、commit/push、部署或更新日常服务；不为了跑完09将未获授权的真实验收换成mock。遇到实际授权边界时保留明确缺口，继续不依赖它的已授权工作。
- 只在CURRENT维护当前进度，重要决定和验收变更及时记录；本交接快照不另行滚动维护。

## 02只读准备备忘（未实现，不替代正式规格）

01关闭后先读 `source-sync.md`，复用已经核对的入口，避免重新通读全部历史：

- 同步改为POST 202及GET进度；旧已成功命令保持原200回执，不补做新作业。`catalog_imports`负责同步业务状态，jobs只负责专用`source_sync_jobs`调度，不复用具有conversation/message外键的`background_jobs`。
- 页内容、unchanged成员、子对象、待生效负责人、待办与游标同事务；完整成功后应用负责人/退休/终态。每页成功清连续失败，不能按领取次数限制大目录。
- 新同步不叠加旧catalog的15分钟第二套租约；预填等待同步终态。旧快照兼容写仍需保留，08才按消费者就绪条件切换。
- SQL比较使用已有sqlparser和adapter声明的方言。仅忽略无意义空白，保留字符串、引号、大小写、注释/hint和token边界；未知方言沿原文比较，不把AST打印当等价证明。具体首轮方言范围仍按正式规格和实际adapter核实。
- 纯排版变化不改原正文、修订和位置；观测/负责人独立更新；比较算法升级须对新旧两侧用同算法重算。
- 现有22个测试直接使用source-sync，部分在Worker暂停时执行。测试执行器应复用正式同步process_due，等待helper轮询真实GET，不能伪造成功或抢跑预填/embedding；晚到目录竞争仍需两个同步执行者。
- SourceLocator按Unicode codepoint；完整来源8MiB/页16MiB。大SQL要连同旧KnowledgeEntry的100000字符限制一起核对，不能只改CatalogNode。

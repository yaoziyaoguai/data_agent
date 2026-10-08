# 原生 Skill 与空间共享：最终审计及试用

日期：2026-10-07。当前授权、实施状态、最终收据和推送状态统一见 [CURRENT](../CURRENT.md)。本记录覆盖已确认的产品流程与可信异常边界，不能证明所有输入、网络故障或调度组合都正确，也不是模型准确率评测。

## 范围与方法

- 基线为 `cdf4b0c` 之后尚未提交的原生 Skill、空间公共方法及四项试用修复。沿用 [执行包](../dogfood-repair-execution.md) 和既定权限，不新增产品能力。
- 独立审查服务端授权、版本、幂等、Pi 资源读取及恢复；主任务用真实浏览器检查交互，并复用已有契约、接口、异常注入和界面场景。
- 本地测试使用隔离 MySQL、合成平台和模拟模型；官方 Flash/Mem0/向量服务单独记录，同一主试验账本累计计费。真实 Datasight 和生产身份未接入。

## 发现与修复

| 编号 | 复现与影响 | 修复与验收 |
| --- | --- | --- |
| ASSET-CATEGORY | 在空间公共分类新建个人 Skill，后台保存成功，页面仍留在公共分类，新对象不可见 | 根据正式保存响应的种类和可见范围切到对应分类；浏览器确认新条目可见，Bob 仍不可见 |
| READ-REPLAY | 相同原生read成功后使依赖存储不可用，重放仍返回旧成功正文；下一次模型准入另有检查，但当前读取错误地表示成功 | 仅沿用原六类已提交操作的回执接回，读取保留本次失败；验证故障时read拒绝、恢复后同身份成功、写操作仍接回原回执 |
| ASSET-LATE-RECEIPT | 保存第一份方法后延迟回执，关闭弹窗并编辑第二份草稿，旧回执会关闭新弹窗并丢弃草稿 | 编辑会话代次隔离迟到结果，保存期间禁用原字段与附件；允许关闭后另开编辑，旧结果不改新草稿或保存状态 |
| REANALYZE-RECEIPT | 重新预填的首次回执与并发重放回执不一致：重放提前返回，遗漏维护权限视图 | 重放复用同一 `decorate_in_tx` 后再验证响应；原八路并发、同回执、仅一版及计数断言保持，`check-maintenance-replay.mjs` 完整通过 |
| MEMORY-EMBEDDING-RESERVATION | 最终真实试用中，Mem0短查询只按9字节预留9 tokens，百炼实际返回18 tokens，触发预算封锁，后续SQL调查停止 | 每条文本按UTF-8字节数加64 tokens预留，与共享语义向量适配一致；保留20条批量、8192输入总预留上限、实际usage结算及超限封锁，不开放隐式重试 |
| ASSET-EXACT-NAME | 按完整名称搜索启动摘要之外的记忆时，等名对象与同前缀对象被排在同级；随机ID排序和长摘要分页可能把等名对象挤出首页 | 先排名称完全相等，再沿用名称包含和其他正文/范围匹配，组内仍按稳定ID；中文和大小写反例验证等名项在首页，保留分页及原ASSETS全部断言 |

修复前独立浏览器探针：`.local/skill-release/assets-probe-before.json`，两项均复现。修复后 `tests/mvp/check-asset-editor-browser.mjs` 覆盖四组行为，包含迟到成功、迟到失败及“服务端已保存但回执丢失”的相同操作重试，要求最终只存在一份资产。个人确认标签保持原“我已核对这条个人定义”，公共编辑明确标为公共定义；未改变业务校验。

修复前回执探针`.local/skill-release/read-replay-confirmed.json`确认初次成功、故障期间重放成功且返回旧正文。初次探针误查不存在的data.content字段，后按正式DataToolOutcome的data.text纠正诊断标记，原输出也保留。

短文本预留问题来自第一次正式验收的真实回执，非模型回答错误。失败快照保存在 `.local/skill-release/final-attempt-1-result.json`，账本调用明细在 `.local/skill-release/budget-breach-calls.json`。修复前新增回归实际失败，修复后12项Mem0测试完整通过，日志分别为 `embedding-budget-before.log`、`embedding-budget-after.log`。新增反例覆盖短文本及20条批量的模板开销、预留超8192时不发送请求、实际usage超预留时先结算且不隐式重试。64 tokens是保守估算，实际usage核验仍保留；账本恢复必须沿用明确授权与原有历史，不能改失败记录或以本地测试替代真实验收。

名称排序问题在第二次正式验收的ASSETS原断言暴露；失败收据另存 `.local/skill-release/final-attempt-2-result.json`。原测试未改，新增确定性反例让目标ID排在20个同前缀ID之后，并用长摘要触发字节分页，修复前必现错误，日志为 `.local/skill-release/asset-search-before.log`。这项修复落实原有“启动候选外资产保持可搜索”的要求，不改变资产可见性、正文长度或分页上限。

修复后3项检索单元测试、API/Worker重建和原ASSETS全场景通过，日志为 `.local/skill-release/asset-search-after.log`。保持原长正文完整拼接、旧版本拒绝、27项分页无重复和未选Skill不可见断言。

### 验收脚本修正及依据

- 关联内容回归原先直接向知识表造数，没有登记后来新增的 `semantic_ownership`，实际页面返回 `not_available`。按 `semantic_governance::register_object_in_tx` 的正式规则补齐合成维护关系：字段沿用所属表，独立对象保留自己的关系；并在打开页面前断言关联 API 返回 200。此前只修正标题定位器未解决该原因，原失败和截图保留。完整标题包含既有“打开详情”，保留105字段翻页、四类内容与404/400反例。尾段 `check-retrieval-coverage.mjs` 也有相同的直接造数缺口，补齐1001个合成指标的系统归属；1000条来源过期、候选上限与后方精确召回的原断言全部保留。
- 第三次正式验收完成全部知识流程后，历史浏览器测试的230张直接造数表也暴露相同归属缺口。原完整失败收据保存在 `.local/skill-release/final-attempt-3-result.json`；新增目录API必须200的前提断言，修复前稳定得到404 `not_available`，见 `history-ownership-before.log`。只补本批表的Datasight/self authority；保留1200+50事件、100条以外的会话、230张表三页游标和60000字文档编辑的原断言。
- 补齐归属后，历史浏览器全部5项和管理按钮/关联内容全部场景通过，日志为 `.local/skill-release/history-ownership-after.log`、`management-final-check.log`。本次不修改产品代码，也不增加维护成员。
- 工作台全流程测试仍寻找旧按钮 `新增Skill`；按当前明确的个人/公共含义改为 `新增个人 Skill`。其余录入、选用、刷新、SQL确认及结果断言未改。
- Mem0协议回归只释放捕获器的HTTP回执，没有结束待处理输入；旧消息租约到期后重领，再次被捕获并阻塞后续输入。按公开撤回接口结束用完的合成输入，逐次断言成功，再释放捕获器；不改产品调度、租约或记忆行为。新建、修订、跨会话召回、旧版过滤及故障断言全部保留。

- 多目标取消测试原设1500ms租约。独立反例在取消前就已发生 `lease_lost` 和运行换代；取消本身仍正确退回当前尝试。改用Worker原有默认15000ms，并新增取消前 `attempts=1`、运行/作业代次一致及仅一条运行的断言。普通/延迟两个场景仍严格要求最终尝试1/3、6次模型调用、仅1次未知回执及原任务/账本身份；延迟场景仍须真实出现Bridge 409。独立正对照通过，报告 `.local/checks/reviewer-mixed-default-lease-a40b61ef-22f3-41b2-a22d-99d5fa6f0a95.json`，不改生产租约或恢复逻辑。

- 业务协议fixture的请求体上限仍为旧65536字节，B04在准入处因超限失败。只将 `--check` 分支同步为已确认的131072字节；官方profile、问题、参考答案、调用/费用限额及provider硬限制保持。独立检查再次证明旧64KiB拒绝70KB、128KiB接受进入预算检查、超128KiB仍拒绝；完整业务回归已通过，均为0官方请求。
- 原生Skill测试完成平台拒绝执行断言后，未消费失败查询产生的结果唤醒，捕获器占住下一场景。使用已有任务取消接口结束该合成目标并释放捕获；平台失败和后续依赖故障、旧回执重放的断言保留。

最初的记忆捕获、按钮定位及关联内容三项修正已分别完整运行成功，日志见 `.local/skill-release/repaired-local/`。原失败在 `.local/skill-release/local-regression/02.log`、`06.log`、`07.log` 和 `.local/skill-release/management.log`，未覆盖或删除。


## 场景覆盖

| 领域 | 覆盖的操作与边界 | 验证入口 |
| --- | --- | --- |
| 登录与工作台 | 登录/退出、跨用户隔离、同会话多任务、历史/草稿、刷新、延迟回执、Markdown、图表、CSV | `verify-mvp-browser`、`verify-management-buttons`、既有 runtime/query 场景 |
| 查询 | 生成与修订、先展示再确认、旧版本拒绝、重复提交、取消、未知平台回执、结果归属/分页/截断、预算 | `verify-query-workflow`、`verify-model-provider` |
| 语义构建与检索 | 来源导入、预填、人工覆盖、冲突、引用/血缘、文档/指标、来源失效、索引并发、检索回源 | `verify-knowledge-workflow`、`verify-hybrid-retrieval`、`verify-shared-embedding` |
| 语义维护权限 | Datasight维护人来源、创建者归属、转交、失效成员、跨用户建议、接受后另行保存、撤权与私人草稿 | `verify-semantic-governance` |
| 个人记忆 | 新建/修订、适用范围、个人隔离、索引失败/恢复、旧版回源、Mem0保存与新会话召回 | `verify-memory`、`verify-knowledge-workflow`、真实Skill试用 |
| 个人与公共Skill | 个人隔离、明确发布独立副本、不复制私人备注、负责人/超级维护者、建议、并发修订、启停/删除、跨空间拒绝 | `check-shared-skills.mjs`、`check-workspace-feedback-browser.mjs` |
| 原生Pi | 目录、按需正文/附件读取、长文分页、路径拒绝、超长行拒绝、多Skill、显式固定版本、恢复身份、改版/撤权后旧上下文失效、原生压缩 | `check-native-skills.mjs`、`verify-mvp-regression` |
| 新增交互反例 | 公共入口新建私人方法、保存中编辑保护、关闭后新草稿、迟到成功/失败、未知回执后幂等重试 | `check-asset-editor-browser.mjs` |
| 启动与交付 | 就绪/提前退出/超时、TIME_WAIT、重复启动、原真实配置、契约同源、模块边界、密钥排除 | 启动测试、`verify-code`、`verify-contracts`、最终差异检查 |

## 执行证据

本轮分组日志与问题复现存放 `.local/skill-release/`，新增浏览器回归在 `.local/checks/asset-editor/`。原生及共享行为证据继续使用 `.local/checks/native-skills.json`、`.local/checks/shared-skills.json` 和 `.local/checks/workspace-feedback/`。

最终完成必须由 CURRENT 所绑定的 `I2-SKILL-CLOSEOUT` 完整执行收据证明；先前 `I2-NATIVE-SKILLS` 的十组成功记录只证明其原范围。任何失败须保留原日志，区分产品缺陷、过期测试定位及环境问题后修正，不能以删除场景或改为 mock 代替真实要求。

### 本地长时检索检查

预跑统一包装器的900秒上限不足以覆盖千表首次索引、丢库自动重建和受控完整重建三段流程。包装器到期后保留超时记录，原隔离子测试曾继续，随后会话结束时被停止，没有完整结果，未计为通过；最终以本增量正式收据中重跑的完整结果判定。通过隔离库中唯一合成对象ID定位该次向量集合，已清理这一个临时库和集合，未改常驻数据；证据 `.local/skill-release/hybrid-interrupted-resources.json`。历史同场景仅首次索引约606秒，本轮亦观察到索引状态持续推进和重建阶段切换。最终 REGRESSION 组合等待上限由2400改为4200秒，容纳完整流程及其他本地回归；不改变数据规模、单段有限等待、结果断言、产品超时或任何付费预算。

补齐历史造数前提后，REGRESSION内部将千表检查调到首位，优先取得此前缺少的完整结果；其余命令、断言与组合上限保持。所有正式组仍需在同一冻结范围完整通过。

### 会话恢复测试的调度前提修正

第十一次统一执行中，千表8项及前两个恢复用例通过，第三次Pi导入停在 `imports_started`，超过原20秒健康等待；原失败为 `.local/skill-release/runtime-startup-failure-11.json`。隔离复跑又在第二次运行提交工具后收到明确 `lease_lost`，随后第三次运行完成，违反原“恰好2次运行”断言；证据 `.local/skill-release/runtime-startup-probe-11.json`、`runtime-recovery-isolated-11.log`。该测试全局将租约缩至1500ms，而产品原默认是15000ms；没有重复业务副作用的证据。独立审查据此确认测试的快速恢复前提被主机调度延迟打破。

只在 `tests/runtime/check-runtime.mjs` 中让恢复 Worker 使用原默认15000ms，故障 Worker仍为1500ms；增加恢复前仅1次运行、1次领取的前提断言。原恰好2次运行、稳定操作/SDK调用身份、仅1次任务和正式输出、旧代次拒绝及预算归属断言全部保留。健康等待从20秒改为有限60秒，并新增子进程退出时立即失败；仅容纳已观察到的模块导入延迟，不改产品启动器、模型请求、续租、行为等待或生产超时。修正后限定正对照日志为 `.local/skill-release/runtime-recovery-fixed-11.log`，最终结论仍须当前冻结范围完整验收。

为避免长时千表完成后才遇多次进程启动的包装失败，最终验收只调整先后：GOVERNANCE在REGRESSION前；REGRESSION原其他8个目标先运行、千表最后。原13组、数据量和业务断言保留，组超时不变。旧成功和失败收据均保留，不能拼接成完整通过。

第十二次完整执行的恢复三例已通过，但后续查询工作流在公共harness的Pi导入阶段超过20秒，尚未发送业务请求；同期主机负载60.98。第7次千表启动也出现同一入口/同一阶段的超时。保留 `.local/skill-release/final-attempt-12-result.json` 与 `query-startup-failure-12.json` 后，仅将 `tests/mvp/harness.mjs` 默认健康等待20→60秒，与恢复测试采用同一有限余量。显式 `startupTimeout`、普通业务等待和所有断言不变，未改产品或数据规模。限定正对照为 `.local/skill-release/query-workflow-startup-fixed-12.log`；完整收据仍须重新执行，不拼接旧成功。

### 最终验收前的结果

- 15组预跑原日志全部保留；其中初次失败经上述原因区分和修正，相关复跑分别在 `.local/skill-release/repaired-local/`，不覆盖原失败。
- 编辑器四组、共享Skill、会话选择、工作台反馈和语义治理已通过。原生Skill八组完整复跑通过，包含本轮新增的依赖故障/read回执边界；重新预填的原严格并发回执测试也通过。
- 业务验收完整通过16个协议场景；模拟输出只验证工程链路，不作为真实模型准确率。
- 本轮完整验收尚须执行 CURRENT 中13个命令组；独立审查允许进入验收，不预先宣称整体通过。该收据的最终状态、真实模型调用统计与提交推送结果保存到 CURRENT，避免修改冻结输入后误用旧证据。

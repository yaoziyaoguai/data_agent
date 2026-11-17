# 全产品审计导航

这是按需索引，不是启动必读清单。先按 [精简审计入口](global-audit.md) 开始；只有定位某能力的合同、测试或历史证据时，读取本文件相应行，不全文加载所有路径。本表列定位入口和待核行为，不给任何功能预填“通过”。按能力审实际产品，不局限于01–08新diff。权威需求完整含义在[系统设计第21节](../../semantic-retrieval-design.md#21-需求与增量验收对应)，静态映射在[覆盖表第1节](coverage-and-validation.md#1-全要求映射)。

## 快照与证据入口

准备于2026-11-02，分支 `codex/semantic-maintenance-prototype`，HEAD `04d27d06ba7b97d4cf3e288d4cf9e6300ef491a9`，存在大量继承未提交修改。真正受审对象是**当前完整工作树**；HEAD或diff都不能单独代表它。接手时核对有无新变化。

- 最新实现增量：`I2-SEMANTIC-DELIVERY-REPAIRS`。CURRENT声明complete；[独立审查](../../reviews/semantic-delivery-implementation-review-20261102.json)及 `.local/delivery/I2-SEMANTIC-DELIVERY-REPAIRS-result.json` 是该范围证据。22条验收去重为18条命令，不能推广为项目整体通过。
- 本次资料准备只重算了文件指纹及证据元信息，未重跑产品验收。精简索引：`.local/audits/project-readiness-20261102/evidence-index.json`。其中最新收据范围匹配结果、01–08收据路径/时间/命令数和旧dogfood状态便于定位；它不代替原收据和日志。其他机器缺此索引时按上面原路径查，不判产品失败。
- 上一轮旧14项、八项修复已分别取得收据。先独立看当前功能，再按需读 `closure-repairs.md`、`delivery-repairs.md` 和对应review，避免只寻找旧问题。审查写于最终验收之前的“待收据”须与后续收据合看。
- 旧语音试用 `.local/dogfood-runs/voice-cockpit-20261022/results.json`：100项中pass10、partial5、fail2、not_run83。HANDOFF另记已执行未判分尝试，两者不能混算。它是旧 `fed8276` / lexical / Flash-high证据，不是本次Milvus混合检索或新工具合同质量结论。
- 旧 `.local/dogfood-runs/flash-r1/` 是160项历史包；`v2-20261021/`、`repairs-20261022/`也是各自旧版本。新100项模板 `docs/dogfood/cockpit/records/results-template.json` 全not_run只是模板，不是“从未试过”的全局事实。
- 09仍未开始。`integrated-dogfood.md` 准备时SHA256：`ebcdc8798f6d63dcad8c399d95822a0db1e8103b44bcce9c305b9c9541c01e74`；本次不改09。Pi三包在 `package.json` 锁定1.3.0，使用方式按lock及已安装源码核对，不按最新互联网版本猜。

## 定位约定

下面短路径均相对于这些根；可先 `rg --files` 或按符号定向读，不必全文遍历目录：

| 缩写 | 仓库根下路径 |
| --- | --- |
| UI | `apps/web/src/features/` |
| UC | `crates/data-agent/src/use_cases/` |
| OWNER | `crates/data-agent/src/modules/` |
| PI | `apps/agent/` |
| TEST | `tests/mvp/` |
| 设计 | `docs/architecture/implementation-design.md` |

统一接口入口：`apps/web/src/shared/api.ts` → `apps/api/src/routes.rs` → UC → OWNER；模型工具 `PI/tools/data-tools.ts` → `UC/data_tools.rs`。合同从 `packages/contracts/schema.json` / `openapi.json` 的具体定义查起，生成文件按疑点展开。源码名只帮助定位，仍须追真实调用和错误返回。

## 用户功能逐项核对

| 能力、要求与应有行为 | 权威依据/原型 | 正式实现入口 | 现有测试线索、09连接 |
| --- | --- | --- | --- |
| **入口与工作台** D13、C08：三主入口；连续会话/历史、地址恢复、来源跳转后返回、结果优先；桌面/窄屏能操作，不能只能通过API使用 | 系统§16；批准体验预览的工作台、导航和编辑交互；CURRENT“正式页面体验优化” | `apps/web/src/main.tsx`、`shared/WorkspaceShell.tsx`；UI `workbench/Workbench.tsx`、`workbench/ConversationFeed.tsx`、`workbench/AssistantMessage.tsx`；UC `receive_message.rs`、`read_conversation.rs`、`conversation_lifecycle.rs` | TEST `check-experience-optimization.mjs`、`check-experience-regressions.mjs`、`check-conversation-experience-browser.mjs`、`check-history-browser.mjs`。09两主链/100项UI；源文件存在不等于视觉通过 |
| **平台同步** D01/D04/D05、A05/A07：空库/再次同步同路，手动全量比较、后台进度；完整字段/负责人/单表生产SQL；稳定身份、未变复用 | 设计§17.2–17.3；`source-sync.md`；原型无后续同步细节，以正式合同为准 | UI `knowledge/SourceSynchronization.tsx`；UC `catalog_import.rs`、`knowledge_sources.rs`；OWNER `ingestion/catalog.rs`、`ingestion/catalog_content.rs`、`ingestion/store.rs`；`apps/worker/src/main.rs` | TEST `check-source-sync.mjs`、`check-source-sync-browser.mjs`、`check-source-sync-recovery.mjs`。09空库/更新与人工保护；不要为缺权限资料新增状态体系 |
| **文档与语义整理** D04/D05/D06、A05/A07：任意结构/长文/表格可整理，文档多关联；条件/例外有出处；SQL一次提取可复用，格式变不重整；人工值不被覆盖 | 系统§6/10及维护补充；设计§17.2–17.3/17.6；`semantic-preparation.md` | UI `knowledge/KnowledgeDocument.tsx`、`knowledge/SemanticStructure.tsx`；UC `knowledge_documents.rs`、`source_preparation.rs`、`semantic_prefill.rs`、`source_fanout.rs`；OWNER `ingestion/preparation/`、`knowledge/` | TEST `check-document-preparation.mjs`、`check-semantic-preparation.mjs`、`check-source-repreparation.mjs`、`check-source-storage.mjs`。09空库长尾/来源更新；观察缺口表达和实际整理产物，不只查入队 |
| **公共检索与索引** D04/D06、C02/C06、A06：raw/知识、词法/向量/标识召回，范围在通道生效，多个强字段不被弱类型挤掉；空/失败/未覆盖区分，更新期间能读当前资料 | 设计§17.5–17.6；`hybrid-retrieval.md`；本轮已确认候选窗去重取舍 | UC `knowledge.rs`、`raw_index_handover.rs`、`knowledge_embeddings.rs`；OWNER `retrieval/`、`knowledge/`；`crates/data-agent/src/search_scope.rs` | TEST `check-hybrid-retrieval.mjs`、`check-retrieval-ranking.mjs`、`check-retrieval-channel-faults.mjs`、`check-search-continuation-lifetime.mjs`。09检索/支持容量；实际Milvus与本地协议embedding、真实语义质量分别记 |
| **工具依据交付** D06/D07、C02/C06/C07、A02/A06：批量读、原文定位、必要支持/例外、分页续读；正文送到模型才算交付，末页耗尽不代表完整 | 设计§17.5–17.6；`evidence-delivery.md`；后续修复合同 | UC `evidence_delivery.rs`、`knowledge_supports.rs`、`data_tools.rs`；OWNER `retrieval/search_reply.rs`、`retrieval/excerpts.rs`；PI `tools/data-tools.ts` | TEST `check-evidence-delivery.mjs`、`check-evidence-search.mjs`、`check-evidence-support-continuation.mjs`、`check-evidence-response-budget.mjs`、`check-evidence-replay-boundaries.mjs`。09检索容量/实际Pi链；原成功回执不因恢复后新预算重写 |
| **多轮理解与澄清** D03/D08/D09、C03、A04：按任务继承月份/时间角色/口径/来源，自由回答/解释选项/换题有正确归属，未答不算同意；普通浏览不强制建任务 | 系统自然澄清补充；设计§12/17.4；`task-context.md` | UC `data_tools.rs`、`source_limits.rs`、`context_authority.rs`；OWNER `analysis/`；PI `tools/update-analysis-task.ts`、`session/task-projection.ts`、`session/workspace-context.ts` | TEST `check-clarification.mjs`、`check-time-roles.mjs`、`check-source-limits.mjs`、`check-task-projection.mjs`。09时间口径续接/语音歧义；程序保存值不证明模型理解对 |
| **多目标答案与持久交付** D08/D09/D13、C01/C02/C05、A01/A02/A04：同消息多题分别完成，已有答案不被保存工具/后续任务覆盖；互斥来源不混入另一任务模型上下文；刷新可见原文 | 设计§17.4；`task-answers.md`；R02及最新修复 | UC `task_answers.rs`、`finish_run.rs`、`deliver_run.rs`、`analysis_answers.rs`；OWNER `runtime/outputs.rs`、`analysis/`；PI `session/deliver.ts`、`session/workspace-context.ts` | TEST `check-task-answers.mjs`、`check-waiting-task-delivery.mjs`、`check-result-notification-answers.mjs`、`check-control-context-edit.mjs`。09双任务中断/原生接入；检查合成工具序列是否掩盖真实模型困难 |
| **SQL生成、授权与查询** D02/D08/D09/D15、C04/C05、A01/A03/A10：能从依据生成SQL；明确聊天执行才提交；批量授权准确；长查询不挡新问，取消/未知/失败/晚到结果不混淆 | 系统§15；设计§4.4/10/12/13/17.4；不能回退为旧独立确认按钮流程 | UI `workbench/QueryCard.tsx`；UC `query_workflow.rs`、`query_semantics.rs`、`cancel_run.rs`；OWNER `queries/platform.rs`、`queries/`；平台适配见 `apps/platform-mock/server.py` | TEST `check-conversational-query.mjs`、`check-query-workflow.mjs`、`check-query-boundaries.mjs`、`check-mixed-task-cancellation.mjs`、`check-background-queries-browser.mjs`。09两主链/晚到；合成平台不证明真实平台接入 |
| **结果、计算与报告** D02/D13/D14/D15、C02/C04/C08：表格/图/CSV同查询，分页与截断清楚；数字和条件可核对，NULL/零/分母区别；报告多来源和阅读位置正确；不编因果 | 系统§16与分析补充；设计§13–14/17.4；批准预览结果优先 | UI `workbench/QueryResultsView.tsx`、`workbench/AnalysisReport.tsx`、`workbench/analysis-report-chart.ts`；UC `analysis_evidence.rs`、`analysis_answers.rs`、`analysis_reports.rs`、`historical_analysis.rs`；OWNER `queries/`、`analysis/report/` | TEST `check-query-result-statistics.mjs`、`check-analysis-evidence.mjs`、`check-analysis-report-chart.mjs`、`check-analysis-reports-browser.mjs`、`check-report-reading-position-browser.mjs`。09复杂分析/历史；旧资料改版与撤权、结果过期分别核 |
| **语义维护与协作** D01/D05/D06、C02/C08、A08：负责人/超级维护者可编辑；创建者归属；纠错接受后仍需保存，私人内容不自动公开；整篇文档、业务域/关联/计算规则可维护 | 系统§6.1/11.7；设计§4.2.1/10/15；预览语义管理与编辑保护 | UI `knowledge/KnowledgePage.tsx`、`knowledge/SemanticCorrections.tsx`、`knowledge/ReviewCorrection.tsx`、`knowledge/SemanticMaintainer.tsx`、`knowledge/KnowledgeMaintenanceImpact.tsx`；UC `semantic_governance.rs`、`knowledge_impact.rs`；OWNER `access/`、`knowledge/` | TEST `check-semantic-governance-browser.mjs`、`check-semantic-role-boundaries-browser.mjs`、`check-creator-ownership-browser.mjs`、`check-semantic-rules-browser.mjs`。09 L5/来源人工保护；只看隐藏按钮不算权限实现 |
| **个人记忆** D10/D11、C02/C05：可复用纠错可提取、告知、检索；只本次不长期化；编辑/停用/删除生效，故障不假成功，原操作回放不重复 | 系统§11；设计§9及上下文接入说明；预览个人积累 | UI `assets/AssetsPage.tsx`；UC `personal_memory.rs`、`personal_assets.rs`；OWNER `assets/memory_provider.rs`、`assets/memory_index/`；`apps/memory/service.py`、`apps/memory/providers.py` | TEST `check-memory-provider.mjs`、`check-memory-context.mjs`、`check-memory-revisions.mjs`、`check-memory-source-cleanup.mjs`。09个人能力；builtin/本地替身不能证明Mem0真实提取效果 |
| **个人/公共Skill与案例** D12/D13、C02、A08：方法草稿经确认，显式选用，Pi原生读资源；公共是独立副本，权限/来源/版本仍生效，目录分页和建议可操作 | 系统§12；设计§9/15；预览个人/公共分开 | UI `assets/SkillDrafts.tsx`、`assets/SkillFilesEditor.tsx`、`assets/PublishSkill.tsx`、`assets/SkillSuggestions.tsx`；`workbench/SkillSelections.tsx`；UC `skill_drafts.rs`、`personal_assets.rs`；PI `session/skills.ts`、`tools/read-skill.ts` | TEST `check-native-skills.mjs`、`check-shared-skills.mjs`、`check-asset-directory.mjs`、`check-skill-text-authority.mjs`、`check-knowledge-reuse-browser.mjs`。09个人能力/L4；不是仅列出Skill名即实现采用 |
| **模型管理与容量** D07、C01/C02/C05：超级管理者配置连接/可选模型，用户只选择允许项；配置冻结、输入/输出/窗口/字节/超时对应；无硬编码单一模型 | 设计§16/17.7；`runtime-capacity.md`；这部分晚于体验预览 | UI `models/ModelConfigurationPage.tsx`、`workbench/ModelSelector.tsx`；UC `model_configuration.rs`、`conversation_models.rs`；OWNER `runtime/model_configuration/`；PI `provider/configured.ts`、`provider/controlled.ts`、`session/capacity.ts` | TEST `check-model-configuration.mjs`、`check-model-selection.mjs`、`check-configured-compaction.mjs`；`tests/runtime/check-capacity-derivation.mjs`。09容量真实边界；Schema可表达上限不等于端点实测 |
| **会话、后台与恢复** D03/D07/D08/D09、C01/C05、A01–A04/A10：Pi唯一循环、原生压缩/流式/取消/检查点；长期会话不中途换身份补额，慢检索不持会话锁，Worker临时故障可恢复 | 设计§5/17.4/17.7；`pi-reuse.md`、`runtime-capacity.md` | PI `session/deliver.ts`、`session/checkpoint.ts`、`session/journal.ts`、`session/output-stream.ts`、`transport/`；UC `context_authority.rs`、`deliver_run.rs`；OWNER `runtime/`、`jobs/`；`apps/worker/src/main.rs` | TEST `check-native-compaction.mjs`、`check-recovery-continuation.mjs`、`check-long-conversation.mjs`、`check-slow-retrieval-lease.mjs`、`check-worker-storage-recovery.mjs`。09真实进程恢复/原生压缩；需区分SDK能力与必要业务适配 |
| **迁移、配置与部署边界** D02/D03/D07、C05/C07、A02/A05/A07：旧会话/任务/成功回执沿原身份恢复；当前内容/依赖回填、公共索引、新工具按序切换；个人集合保持 | 设计§17.8；`compatible-upgrade.md`；README和开发文档也是受审对象 | `migrations/`、`scripts/development.py`、`.env.example`；UC `historical_analysis.rs`、`raw_index_handover.rs`；OWNER `runtime/`、`retrieval/` | TEST `check-source-upgrade.mjs`、`check-public-index-upgrade.mjs`、`check-tool-contract-version.mjs`、`check-historical-source-access.mjs`、`check-checkpoint-storage.mjs`。09前置及配置；演练通过不等于日常服务已部署 |

上表是入口，不限制进一步查文件。跨行还须统一核：C02来源/用户/模型端点隔离，C07合同/错误分类/无泄露日志，A09 owner/SQL/模块依赖，A10短事务和副作用；看 `scripts/check_architecture.py` 的实际能力与盲区，不能只读“检查通过”。D16/D17和C08由全范围对账、合成资料与独立判分覆盖；D18真实邀请/发布保持明确后置授权，不算偷偷漏做。

## 原型与图怎么省读而不漏

- 先读 `prototype/experience-preview/README.md` 的体验范围，再定向查看 `preview.html` 或 `preview.js` 的对应流程。CURRENT批准段同时规定结果优先、来源跳转、地址/后退、编辑底栏/未保存保护、紧凑字段行和窄屏导航。
- 正式UI从上述组件和 `apps/web/src/shared/` 追入口、请求、错误/空/等待/取消/过期/保存失败状态。截图可作历史佐证，不能代替当前渲染。无需为读图默认启动收费/生产服务。
- `docs/architecture/implementation-views.md` 是视图源，`implementation-atlas.html` 是阅读图册；以源中“目标/已实现/未验证”分别核对实际调用、存储和接口。全局架构检查至少覆盖资料链、分析链和个人资产/模型管理支路。
- 本次准备已发现README“08尚未关闭”等时态与新收据有冲突；这是**待对账提示**，不是凭此断言代码未完成。实现设计里的“未来开始实现”也须结合章节用途判断，不能仅按措辞判缺陷。

## 09与既有试用材料按需展开

必读 `integrated-dogfood.md` 全文；再读 `docs/dogfood/cockpit/START.md`、`SCOPE.md`、`OPERATIONS.md`、`GRADING.md` 的相应约束。`scenarios.json` 是100项用例真源，`coverage.json`是映射；先用 `python3 docs/dogfood/cockpit/build.py --list` 看全目录，再按能力查case的消息、前置、断言及reference_key，不默认全文读取长 `CASES.md`。

来源规范在 `docs/sources/cockpit/README.md`、`knowledge-manifest.json`；独立判分在 `docs/dogfood/cockpit/reference/`。审计者可看参考，**不得把参考、评分、seed、生成器或本报告加入产品知识/提示**。`fixtures/`仅按对应场景使用。

09的10条综合轨迹是附加集成验证，不等于已经替代全部100项；100项未覆盖的新合同也不能被“沿用原包”掩盖。审计要给出具体缺口映射，避免逐个方法都新造测试。动态结果质量、静态逻辑错误、工程故障和真实平台未接入分别下结论。

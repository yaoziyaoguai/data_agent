# 09前置修复与整体验收执行包

本包承接[审计复核](../../reviews/project-readiness-confirmation-20261102.md)，随后连续完成[09](integrated-dogfood.md)。不是新一轮架构改造。唯一状态在[CURRENT](../../CURRENT.md)，已完成的01–08及两轮修复保留；不按历史prompt从头重做。

## 入口、顺序与边界

启动必读：AGENTS、CURRENT最新摘要/`delivery.increment`、本节。处理当前任务时再读下面对应节、相关源码和合同；[原审计](../../reviews/project-readiness-audit-20261102.md)只用于追溯，复核记录修正了F1/F4/F5/F6/F8的过强结论。

连续顺序：**模拟provider适配 → 试用环境与冻结记录 → 受影响兼容/UI验证 → 09分层执行与一般原因修复 → 文档/证据收尾**。前置修复后不要停下来等待新的“继续”。付费权限不足只阻塞付费层，仍完成其余工作；发生真实产品决定冲突才询问。

- 使用dev_co衔接；实际行为修改按TDD，先复现后最小修复；仅有跨语言合同变化时用contract-first。本包不预设需要修改产品Schema。
- 继承全部未提交工作，不reset、不覆盖。实现/测试用业务名称，包号只出现在计划和要求映射。
- Pi仍唯一Agent/压缩/恢复；不新增框架、检索会话库、种子开关、双写、通用兼容适配器或大测试平台。旧成功回执、operation/origin/budget身份保持。
- 每消息24次、连续临时失败3次；测试套件不额外设累计调用/费用上限。不把建立新的已授权隔离试用当作绕过预算，也不复制有限旧trial补额。统计实际费用不等于增加新的费用门。
- 不强制新增防护。入口验证后内部用既有类型；简单一次性逻辑就地写；抽取只为实际复用/独立责任；try/catch须有恢复或边界错误语义。测试证明用户行为和可信失败，不能多层重复同一断言。
- 此执行指令包含代码、隔离本地验证及文档。真实端点使用须核实实际会话授权；主库/日常服务、提交推送、部署和外部发布不由本包授权。

## 模拟provider按真实工具合同工作

**问题与所有权：** `apps/agent/provider/synthetic-cockpit.ts`、`synthetic-analysis.ts`及必要的`mock.ts`；相关现有检查优先扩展`tests/mvp/check-cockpit-source.mjs`。不在Rust工具入口放宽v2，不在transport对旧参数增加隐式转换。

已证反例见复核报告：旧read参数被拒；v2成功回执版本7被误用为1；解释分支读取失败仍输出固定结论。零售回归还使用v1的search.objects、read.entries和read_source参数。只是把read改成items仍不完整。

实施要求：

1. 沿运行的`tool_contract_version`产生和消费对应合同。v2 search取`hits`中的实际`ref`/`citation`，知识read用`items`并检查逐项状态，分页保留原ref/位置；原文read用citation。不得硬编码版本1、不假造引用、不拿部分正文当完整SQL。
2. 固定演示仍只处理已有小范围问题，不能借适配写新的自动规划器或针对100项题库编码答案。`synthetic-analysis.ts`中的旧零售演示只为保住既有回归，不新增零售产品功能；result notification的已有答案路径也须检查受影响形状。
3. 三条README演示均在v2实际Pi/API/Worker链中成功；任务达成率先产草稿，明确“执行这条”才提交，结果解释能完成。只解释的两条不产生查询。缺失/失效/错误读取给明确缺口，不返回仿佛完成取证的固定解释。
4. 保留v1行为。版本选择只在模拟provider接缝；如果两种形状确需规范化，限定为本演示模块内部的实际共享逻辑，不建立全局v1/v2兼容框架。

**验收：** 先让现有座舱演示检查在显式v2配置下RED，再修至GREEN；扩展同一脚本覆盖三条演示＋执行续接、至少一条非1修订引用、一条不可读资料。用原v1脚本作兼容正控。无需为三层分别新建同义测试；单纯Schema探针不能替正式链。确认旧UI脚本涉及的零售search/read/source行为仍可用，不把所有旧测试强制改成v2。

## 环境和记录先确定，再运行

### 三层实例

| 层 | 实际配置和启动方式 | 能证明什么 |
| --- | --- | --- |
| 本地演示/UI | 统一启动器`--model mock --tool-contract-version 2 --public-content-retention latest_only --memory builtin --retrieval lexical`，独立runtime-dir/端口；现有harness可继承v2或显式options.env | 正式UI与状态/工具链，不是混合召回或真实模型能力 |
| 本地完整工程链 | 现有harness＋回环协议模型/embedding＋真实MySQL/Milvus；公共集合唯一，data工具、v2、latest_only；参考`check-hybrid-retrieval.mjs`、`check-public-index-upgrade.mjs`、`embedding-provider.mjs` | SQL/索引/恢复/工具的实际通路；协议向量不证明真实语义召回 |
| 获准真实层 | 统一启动器显式`--model deepseek --model-profile <本轮获准配置> --retrieval hybrid --memory mem0 --tool-contract-version 2 --public-content-retention latest_only --public-collection <本轮集合>`，同一固定试用库/runtime-dir | 该模型、真实embedding/Mem0与本版配置下实际场景效果 |

启动器兼容默认保持不变；不为了第二层放宽付费端点门。示意参数中的路径/集合须先实例化，不把占位符作为可执行命令。使用完整语音资料源；harness默认是旧零售，**语音层必须传`sourceDirectory=docs/sources/cockpit`的绝对解析值**。旧零售兼容检查保持自己的源。

每层保存 `environment.json`或同义的非秘密清单：源码/锁文件指纹、实际二进制、Pi版本、模型/思考档/容量、data工具、合同、retention、资料指纹、数据库/公共集合/个人记忆目标和进程PID。首条新run必须实际读回v2和冻结profile；不能只检查命令行。MySQL/平台账本/Milvus/Mem0目标均隔离，单独端口不等于数据隔离。新空实例可直接采用新格式；旧状态演练严格按08回填→新写→公共索引→v2，不拿新空库冒充升级。

### 真实模型配置

不依赖`.local/model-trial/configuration.json`这个历史小样的默认值。通过已有配置方式建立/选择本轮固定配置，核对所选模型能力，使用`toolset=data`、`budget_mode=request`、`request_call_limit=24`；续接/重启使用原配置ID和库。不能改旧有限trial、重置其账本或把当前任务切到旧task-only小样。

沿已确认的Flash/high首轮配置方案核对：C=1,000,000 tokens，I=900,000，O=65,536，payload=8,388,608 bytes，request_timeout_ms=600,000；使用现有同源容量推导及实际固定开销校验，端点能力不符须报告，不能猜型号能力或静默降低配置。模型/价格版本和凭据从获准的配置入口取得，公开文件不放凭据。embedding与Mem0使用已有获准提供方及持久预算/目标，不更换供应商。

实际付费前把模型、端点、用途（100项及十条轨迹中的真实部分、embedding/Mem0和容量样本）、隔离目标及原24/3规则写入本轮授权记录。已有实际授权覆盖时直接继续；缺授权只请求一次具体范围，不重新要求用户选择已决定的“套件总额度”。获准后代表样本正常即继续既定套件，无逐批再次审批；异常费用/重复失败先定位，不盲目扩大。当前编包没有执行或授予新的付费调用。

### 空库与原文链

原始“空库到可回答”要求不变。在本轮隔离目录复制语音**允许输入**，仅将`semantic-catalog.json`的`objects`置空，保留合法source_bundle及原来源文件hash、平台DDL/ETL，并单独记录这份试验目录的指纹。API/Worker/平台统一sourceDirectory；不要修改正式语音资料或独立预期。

启动后先证明业务知识对象为0（迁移、来源登记、身份/账本记录可以存在），再经正常同步导入平台表。独立文档经正式语义管理/API创建，暂停其语义整理但允许raw索引消费，核对没有已整理陈述；使用冻结轨迹的长文末尾问题。如何只暂停准备工作优先复用既有harness的worker调度/锁外消费接缝，不新增产品配置。不允许直接写一份整理答案到数据库后称raw路径通过。

源码已表明空objects可解码和登记，但完整启动未在本轮验证。实施者先跑最小启动反例；若失败，定位一般原因，不能把空库改成“已有预置资料，只新增一张表”来过关。

### 冻结十条轨迹及记录

十条输入、前置、观察、清理在[轨迹清单](integrated-trajectories.json)，共10条，使用业务ID。它引用的原case消息/预期以`scenarios.json`指纹固定。`related_cases`只作覆盖导航；`reuse_cases`才要求完整执行原case及其`depends_on`，可引用本轮已满足全部断言的证据，不强制重复执行。不同场景保持各自会话和产物，不能把T09的草稿当成A03依赖的T02双草稿。空库轨迹不先执行要求全量资料的P02。运行前保存清单、原100项、资料、参考的SHA；动态创建的对象ID只作为本次绑定值，不改业务预期。

- 原100项继续放`results.json`，保持原grade默认的100个ID和断言；十条另放`trajectory-results.json`。不能删除原100项固定分母，也不能将十条硬塞进去。
- 复用`docs/dogfood/cockpit/grade.py`的现有检查：新增显式`--trajectories`模式，只选择本清单，按其ID数量和原expect校验；默认仍严格原100项。沿同一状态/attempt/证据规则，不另建评分引擎，不自动判断模型语义。
- 可用短脚本从清单创建本地结果：每条`case_id=id`、`status=not_run`、`attempts=[]`、`assertions=[{expected,status:not_run,reason:'',evidence:[]}]`。不要覆盖已有运行结果。状态、证据、失败attempt均沿原约定；工程轨迹的真实端点子断言必须有对应真实证据才可判通过。
- 以一份最小记录证明新增校验接线：合法not_run、缺ID、pass无证据、模型项只有mock四种情形足够；复用既有校验，不堆一套新测试矩阵。更新dogfood脚本/操作文档后运行`build.py`同步生成物和manifest，**不使用`--freeze-reference`，不改原100题输入/expect**。

## 相称验证与复用旧证据

保持串行harness；Rust未改就不重复cargo build。确实改了Rust时分别重建API和Worker，并核对实际二进制；不要用旧二进制跑新源码。普通Node检查不建千表库，源码/环境未变的同一检查不反复跑。

| 目的 | 本轮选择 | 不自动追加的内容 |
| --- | --- | --- |
| mock适配 | 扩展座舱脚本v2＋原v1；受影响旧演示/通知路径；`npm run check:types` | 重写100题模型、全量Rust构建、改变产品合同 |
| 旧合同恢复缺口 | `check-checkpoint-storage.mjs`、`check-tool-contract-version.mjs`、`check-evidence-tool-versions.mjs`；读取最近pending/原生压缩/回执重放收据并核当前受影响路径 | 没动迁移/准备/索引切换时重跑全部四个升级make目标 |
| 体验 | v2下运行`check-experience-optimization.mjs`、`check-experience-regressions.mjs`、`check-history-browser.mjs`、`check-conversation-experience-browser.mjs`、`check-query-stop-browser.mjs`；语音本版实际页面核对见09 | 重复运行包含相同脚本的多个大make目标；把拦截的假成功记为真实业务 |
| 同步遗漏映射 | `check-catalog-import.mjs`、`check-source-sync-recovery.mjs`、`check-source-upgrade.mjs`已有对应断言；按轨迹/本轮改动选用 | 为退休/改名/负责人各复制一套真实模型测试 |
| 公共检索工程 | 使用现有harness和真实Milvus的代表链，十条轨迹复用已验证夹具；变更/未闭环的部分实际跑 | 每个Node或UI检查重复重建千表索引 |
| 资料/记录 | `make verify-materials verify-cockpit`；grade原100模板和新轨迹模板；独立参考校验 | 重冻答案、修改失败题预期、按实现输出生成预期 |

表中省略目录的`check-*.mjs`均位于`tests/mvp/`；明确列出的mock双合同、三条旧合同/检查点和五条体验检查是本轮前置出口，原生压缩等已匹配工程证据按作用范围复用。其余行按实际改动和综合轨迹选择，不无条件全跑。将选定命令去重后绑定CURRENT，写清各自承担的缺口；声明必需的验收不能以手工“看起来没影响”跳过。升级适配若实际涉及新消费者/存储，补受影响旧组及独立审查。环境阻塞先凭日志定位，不一律归因Defender；同失败没有新证据就停下改诊断。

## 增量出口和连续进入09

接手开始产品修改时，将CURRENT切为有界的前置增量，例如 `I3-DOGFOOD-READINESS`，保留原完成收据链接。允许范围为模拟provider、现有相关测试、dogfood记录校验/材料、09执行文档、必要README/开发说明；脚本/共享harness只作已证需要的薄接线。Rust业务或产品Schema非默认修改范围，发现一般缺陷先写原因和影响后归属处理；产品行为变更才需用户决定。

绑定至少以下行为出口（名称是验收标识，不进入产品类/函数）：mock双合同正式链及引用/失败、空库raw可行性、记录双分母/需求覆盖、受影响旧合同恢复、v2体验和环境读回。新检查未实现前不能填“passed”；已有证据只支持其原范围。独立审查者检查修法、测试预期和未增加防护/抽象，随后一次正式`verify-increment`，失败只回到受影响处。不要先跑一整套绿色再为凑冻结状态无条件重跑；按仓库证据规则保留最终有效收据。

前置出口完成后，直接切到既有 `I3-SEMANTIC-DOGFOOD`，按09连续推进。100项和十条轨迹全部有状态；真实质量不能用工程证据替代。缺授权保留对应blocked_authorization而非宣称09全部完成。由同题失败定位的一般缺陷可以在所属模块做独立小修、反例和受影响复验，不扩新业务；独立预期保持冻结。

最终同步README、开发说明、CURRENT与确实受影响的设计/图。默认和验收实例配置分开写；新图只有架构/数据链路真实变化才重画，状态说明过期只改说明。F10快路重构不在本包。报告给实现、工程、真实模型、真实embedding/Mem0、真实端点、合成平台、真实平台未接入各自证据与缺口；清理本轮进程/临时对象但保留账本、失败attempt和产物。提交推送和日常服务更新等待相应实际授权。

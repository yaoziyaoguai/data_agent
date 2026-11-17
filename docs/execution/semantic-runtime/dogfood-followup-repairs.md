# 09 剩余问题连续修复执行包

编包日期为2026-11-05。本地根因核对及两轮Oracle最高5/5审查已完成，末轮两项定点意见已合入并作本地复核。入口与实施状态以[CURRENT](../../CURRENT.md)为准。上一包的69份冻结文件已核对，HEAD为`04d27d06ba7b97d4cf3e288d4cf9e6300ef491a9`。本包接续[前包](dogfood-convergence-repairs.md)已经完成的工程结果，产品实现和运行验收由下一位实施者完成。

## 1. 目标、入口和顺序

目标是使当前有效的语义资料能够从读取进入条件和SQL草稿，使语义整理的引文核验与实际材料一致，并补齐旧操作恢复、共享时间依据和核心验收的剩余缺口。

启动阅读AGENTS、CURRENT最新摘要和`delivery.increment`、本包第1–2节。随后按当前任务展开对应源码与证据。根因与审包取舍见[复审报告](../../reviews/dogfood-followup-root-cause-audit-20261105.md)。历史原包按兼容或断言疑点查用。

| 连续任务 | 交付行为 | 主要归属 | 前置 |
| --- | --- | --- | --- |
| 核接手基线 | 当前文件、旧证据和本轮修改可区分 | CURRENT及既有检查目录 | 启动 |
| 结构绑定与采用 | 表的普通说明改版后，结构仍有效的字段可被正式采用 | knowledge、dependency owner、语义组合用例 | 第3节 |
| 预填可见依据 | 模型收到的合法字段原句能通过同一引文合同 | ingestion/prefill、prefill_materials | 第4节 |
| 草稿与执行边界 | 当前输入已归属时能准备草稿，执行检查各自落实 | conversations、queries、data_tools | 第5节 |
| 旧操作恢复 | 已登记且尚无回执的旧命令能按原合同完成 | runtime、analysis、工具边界 | 第6节 |
| 共享语义和解释 | 首末ASR定义、数据覆盖、合法零与事实澄清形成一致链路 | 现有合成资料、检索支持、Pi说明 | 第7节 |
| 相称验证与交付 | 受影响真实流程和两条补充验收有实际结果 | 原09实例和记录 | 第8–10节 |

同一实施者顺序整合Schema、Rust组合入口、Pi工具入口和CURRENT。每个连贯出口记录结果后继续下一项。接口复用`packages/contracts`同源Schema、原生成器和所属模块公开操作。

### 1.1 代码与接口导航

表中源码路径均相对仓库根目录。进入当前任务再展开相应文件，原实现设计17.3.2、17.4、17.5及系统设计19.5分别约束依赖、历史、交付和执行确认。边界改变后同步相应段落。

| 本包章节 | 所属文件与主要入口 | 最小接口交付 |
| --- | --- | --- |
| 第3节 | `crates/data-agent/src/modules/knowledge/structure.rs`、`store.rs`、`dependency_index/{mod,store}.rs`；`crates/data-agent/src/use_cases/{knowledge,knowledge_sources,dependency_validation,dependency_registration,source_limits}.rs` | knowledge公开操作按对象和选中entry读取结构/依赖，返回已核表绑定。组合层经ingestion公开操作取同版来源，按来源和任务范围核验后交给原上下文登记 |
| 第4节 | `crates/data-agent/src/use_cases/prefill_materials.rs`、`semantic_prefill.rs`；`crates/data-agent/src/modules/ingestion/prefill.rs` | `collect_in_tx`装配并裁剪实际材料，`prepare_stage`、冻结及`validate_result`消费同一最终可见集合 |
| 第5节 | `crates/data-agent/src/use_cases/data_tools.rs::request_condition_authority_in_tx`及两个调用点；`crates/data-agent/src/modules/conversations/store.rs`；`crates/data-agent/src/use_cases/query_workflow.rs::confirm_locked_in_tx` | LockedRun本条message_id进入草稿核验，conversation owner判断本条归属。全会话阻断继续由执行入口调用 |
| 第6节 | `crates/data-agent/src/use_cases/data_tools.rs::{register,invoke}`；`crates/data-agent/src/modules/runtime/tool_ledger.rs`；`crates/data-agent/src/modules/analysis/store.rs::apply_update_in_tx` | 可信工具登记/派发边界确定内部请求方言，analysis owner据此保留旧写语义，原事务和receipt仍只有一套 |
| 第7节 | `docs/sources/cockpit/build_catalog.py`、`documents/{overview,metrics-analysis,asr-candidates,time-quality}.md`及其生成物；`apps/agent/session/resources.ts`、`apps/agent/tools/data-tools.ts`；Rust原错误提示位置 | 来源生成规范定义与相关支持，实际v2工具交付后由Pi采用。事实澄清可引用有效资料解决，用户选择及授权沿真实回答 |
| 第8–10节 | 原`.local/dogfood-runs/semantic-20261102/`；`docs/dogfood/cockpit/grade.py`；既有检查脚本及CURRENT | 追加新attempt与逐断言证据，沿原记录格式更新汇总，原题/原attempt保留 |

本包优先复用现有公开wire。内部结构用途、已核绑定和请求方言用所属模块类型表达，新增字段只包含实际下游所需数据。确有跨语言形状变动时，从`packages/contracts`定义开始生成两侧类型，同时核真实provider/consumer与旧持久数据。禁止用一个新wire字段让模型自行选择兼容方言。

## 2. 执行范围和约定

- 基线使用接手时的实际工作树。上一包基线目录和69文件scope保留历史身份。本包在现有`.local/checks/`保存自己的修改前快照、局部diff和实际结果。
- Pi 1.3.0负责Agent循环、会话、取消、压缩及恢复。应用改动限于语义、资料、任务、查询与外部接入边界。
- 本轮所需DeepSeek、语义整理、Embedding和Mem0真实调用沿既有09授权直接执行。每消息24次、连续临时失败3次、原operation/origin/budget/账本与未知调用查证纪律继续适用。执行窗口沿已批准到09结束的授权恢复。测试累计费用按实际记录，服务商与现行账本的真实耗尽须报告具体事实。
- 服务操作限于同一09隔离实例及必要工程harness。提交、推送、部署与日常服务更新按后续明确指令执行。
- 新代码只解决本包普通可达故障或已确认合同。低概率新保护须说明实际触发、证据与代价，再取得用户决定。外部边界完成一次结构校验，内部依靠已识别类型传递，权限或状态变化后的核验按原业务边界执行。
- 简单单用逻辑就地实现。抽取须服务真实复用、模块责任或明显复杂度隔离。catch用于明确恢复、错误翻译或清理。替换职责同时清理失效的旧路径。
- 测试扩展已有接缝，以一个区分性反例及必要回归证明行为。每次重新构建或扩大检查须能关联本次代码变化、失败或证据缺口。数据库harness串行运行，日志保存完整退出码。
- 原100项、原attempt、partial/fail和费用按原身份保留。用户2026-11-05已批准J06与J19各一条补充提问，作为新补充attempt记录。其余后置用例继续由原回归库管理。
- 产品、函数、类型、数据库对象和测试名称使用业务含义。任务编号只用于本包导航与验收映射。

## 3. 结构绑定与实际采用一致

### 3.1 已核根因

四个当前字段的结构仍指向表知识版本1，而对应表已为2或3。三个表当前DDL与前包初始目录逐字一致，schema来源版本仍为1。`read_knowledge`交付当前字段正文成功，`check_refs_in_tx`却把结构table引用转换为普通`EvidenceRef(path=ddl)`，继而按整表知识版本拒绝。S03和T02重复读取字段后仍遇到相同拒绝。

源码入口为`knowledge.rs::checked_refs_in_tx`、`knowledge/store.rs::read_structure_refs_in_tx/read_table_binding_in_tx`、`knowledge/structure.rs::structure_dependencies/validate_current_bindings_in_tx`及`dependency_index`。设计依据为实现设计17.3.2中依赖用途、相关内容指纹及元数据变化规则。

### 3.2 接口合同

按下表区分两类引用。公开工具继续使用既有EvidenceRef，结构用途由已保存结构和宿主路径确定。

| 引用用途 | 核验与返回 |
| --- | --- |
| 模型明确采用的字段/指标正文、样例语义依据、显式table@version#ddl | 核原object_id/version/path、有效层、实际来源、权限和任务范围。过期正文沿原拒绝规则 |
| 字段、指标、关系内部的表结构绑定 | 按稳定表ID读取当前相关DDL，核原相关内容指纹/来源与当前实际列、类型、键及适用约束。成功后返回本次核实的当前表依赖 |

`checked_refs_in_tx`先处理显式引用，由knowledge owner把已支持的entry_id/path解析为规范条目选择，再处理该条目的结构。省略path表示全对象。所选范围贯穿`read_structure_refs_in_tx`、`knowledge_sources::assert_in_tx`、required有效性游走及全部用途的贡献来源游走。相应依赖按被采用的有效条目取完整集合，使用既有按entry/statement登记的索引。

知识边继续沿原登记版本及target_path展开。遍历节点与去重键包含所选条目范围，避免同对象先检查一个条目后漏掉另一个。登记端`DependencyCollector::push`也须保留target_path，当前去重元组遗漏该字段。规范选择和指纹内容定位采用同一已核条目，目标缺失沿原缺口处理。对象访问检查、unknown含义及历史贡献来源照常生效。

required游走检查必要内容有效性。权限和任务来源范围检查所选条目的全部有效用途贡献，包含实际贡献正文的related来源。草稿入口消费这份已核选择及本次实际返回的当前结构绑定，替换目前重新读取整对象并调用`SourceGate::assert_object_in_tx`的路径。省略path的调用保持整对象含义。相同选择在同一事务内复用已核结果，状态变化后按原边界重核。

M02的结构核验负责生成内部已核绑定，组合用例继续检查这些绑定的真实来源和任务范围。`validate_current_bindings_in_tx`、结构采用、结构窄读复用这个责任。显式query_example语义dependencies和verification.evidence_refs保持知识引用用途，内部结构表绑定单独处理。

相关内容比较复用现有`knowledge_dependencies.target_path/target_fingerprint`和来源revision。目标为DDL时绑定该条实际DDL的内容，普通说明改动可继续使用已证结构。DDL指纹覆盖其中类型、键和约束变化，沿既有解析及列/表达式检查即可。当前实现尚未登记字段等结构表边，须在知识保存/依赖登记边界补齐此用途。owner、目标路径、来源出处仍落原依赖表族。结构用途在内部类型及既有purpose/role中清楚表达，必要枚举变化同步同源定义。

新保存结构在原事务核目标版本与实际DDL，登记当时已验证的相关指纹和出处。随后比较相关内容及当前结构，采用回执登记本次真实核定的表依赖。原结构说明、旧分析read_binding、旧receipt保留其原内容和身份。

旧条目缺结构指纹时按下面的次序处理。

1. 先用仍存在、权限允许、来源revision匹配的原文补证，例如字段source_facts的table/column/location及相应schema来源。核到同一张表的原DDL及本条绑定，再在所属owner登记其原相关内容指纹。
2. 原文可核且相关DDL一致时，当前绑定可采用。实际相关内容变化时，进入既有定点重分析/维护保存流程产生新有效绑定。
3. 原文已不可取得时，该条保缺口，通过既有定点整理取得新的依据。仅有当前hash无法证明旧版等价，`before/`目录只用于诊断旁证。

兼容只处理实际触及的条目。采用成功的内部返回值带本次真实表身份、版本、结构依据和来源，外层按其继续登记上下文。保留现有结构校验，相关DDL发生变化时交原重新整理流程处理。真实来源变化、停用/撤权沿各自现有规则处理。

复用依赖游走时一并修正已核的短路。`dependency_validation::walk_required_in_tx`在目标修订变化而相关正文指纹相等时直接`continue`。A依赖B，B依赖S，B仅说明改版后S变化，会因此漏查S。`contribution_roots_in_tx`保存来源身份，职责覆盖来源限制，无法代替必要内容有效性检查。

相关正文相等只完成该边的内容比较，后续仍沿原登记版本及所选entry的完整必要依赖核验，保留原贡献来源。新结构绑定实际采用当前表依赖时，继续核本次返回的当前来源及范围。复用现有遍历并按上述所选范围去重，缺依赖映射走原unknown/待核路径。不能凭正文相同重写旧贡献事实或静默换源。

### 3.3 验收

沿现有`check-structure-column-bindings.mjs`、`check-query-semantics.mjs`或同一owner接缝建立一个连贯场景。字段已读且当前，表仅说明改版，随后revise和request_query能采用。对同一夹具改变真实DDL或撤回来源，再核必要拒绝。保显式旧正文引用的原断言，同一对象未选条目失效或不在允许来源时不阻断当前条目，已选条目的全部贡献来源仍受限。再选择该对象两个条目，证明两者依赖都被登记和核验，去重没有吞掉后一个。旧指纹缺失按真实同版原文补证，缺原文时明确留缺口。在既有`knowledge_dependencies`或`check-context-dependencies.mjs`链式样本上补“中间对象仅说明改版、下游来源变化”的区分性断言。试用S03/T02前先通过这些相关工程路径。

## 4. 预填材料与引文使用同一可见集合

### 4.1 已核根因及边界

本轮18个invalid_prefill中，14个结果引用了宿主提供的字段type原文。对应引用在原schema真实存在，与同版字段元数据相等，但不在sources.schema已交付的前1315字节。`prepare_stage`提供这段metadata quote，`validate_result`却仅核sources正文和supporting_excerpts，因而在第一轮就拒绝，第二轮补料无法开始。

另外4个结果在provider给出tool_calls终态时包含格式不完整的JSON。分别记录其返回形态、原费用和失败原因。这四份记录支持无效输出的分类，供应商内部成因仍待其自身证据。

入口为`prefill_materials::collect_in_tx/bound_bodies/freeze_review_in_tx/review`、`ingestion/prefill::prepare_stage/validate_result/decode_completion_for`与`semantic_prefill`的现有分析/复核边界。

### 4.2 统一材料合同

- 在材料收集阶段，将将要交付的字段类型、相关DDL与生产SQL片段绑定到同版来源的实际位置，纳入现有`supporting_excerpts`和coverage范围。metadata展示与可引用材料使用同一批已核内容。
- 优先交付本对象对应的table/column及其真实关联所需片段。复用已有来源分段和定位，字段原文的位置以source_facts的table/column/location及同版原文核实。重复列声明按所属表定位。
- 保留UTF-8范围、来源revision和实际字节预算。先满足本对象核心依据，再在剩余空间内选择相关支持。metadata与sources重复展示的字节也计入实际请求容量。裁剪后放不下的引文同步从metadata展示中移除，coverage记录缺口。
- 最终裁剪后的sources、supporting_excerpts与coverage由发送、冻结和validate_result共同消费。片段完整与整来源完整分别表达，引用白名单只包含实际交付部分。
- `prepare_stage`当前还有独立的额外裁剪，须纳入同一最终集合，防止收集阶段补齐的原句在发送前再次被裁掉而白名单仍保留。
- 两阶段冻结同一组来源身份及原文位置。复核阶段沿已有补料操作取得需要的剩余内容，引用检查继续逐字核对实际可见材料。
- 结构Schema和引文核验在各自外部输入边界执行。通过校验的内部材料直接传递到后续阶段。

具体删除/替换边界是“字段metadata额外展示，但引文集合不知道这段内容”的分裂，以及本对象关键依据被所有资料前缀均分挤出的装配。保留现有来源权限、原版本和输出失败记录。

### 4.3 验收及格式失败处置

扩`check-prefill-materials.mjs`及既有prefill模块检查，采用位于schema后部的真实字段声明。断言实际请求包含同版定位的原句，模型原样引用能进入复核，伪造或错版引文仍被拒绝。复核输入的范围可回指同一冻结材料，已有容量断言继续成立。

先用一个曾受影响字段完成正常真实重分析，再按影响处理仍无有效成果的对象。已有成功成果按来源与方法有效性复用。四个坏JSON结果经现有明确重试入口产生新attempt，至少保留一个代表观察，返回仍无效时记录其实际形态和剩余缺口。维护调用结算沿原身份和账本。格式处理只接收供应商真实给出的合法结构，SQL/语义正文进入正式资料仍需原验证。

## 5. 草稿、执行和错误恢复各守边界

### 5.1 草稿准入

`request_condition_authority_in_tx`当前使用`confirmation_blocked_in_tx`检查整会话。S03已按当前输入修订条件，仍因另一条旧失败输入未归属而无法保存未执行草稿。

草稿入口核本轮真实消息的归属、任务及条件版本、来源、SQL只读与平台目标。将本轮message_id从LockedRun传入，沿现有conversation公开操作核验。来源门消费第3节同一已核条目选择及结构绑定，避免又扩大为整对象。执行和确认继续由原会话阻断规则检查其他待归属或失败输入。

保存草稿、产生执行授权和向平台提交分别记录。新输入或条件变化按原规则使旧草稿失效。已成功确认的原操作恢复沿原回执处理。

### 5.2 让拒绝回执能指导下一步

当前`task_context_required`和`stale_knowledge`只附“按错误原因核对”的通用提示。针对本包已发生的拒绝，在原错误回执生成位置给出具体恢复方向。

- 尚未登记本条归属时，指向现有update_analysis_task或受控任务目录读取。Pi决定任务归属。
- 当前资料或其结构依赖失效时，按权限允许的身份给出失效对象/用途及重新定位读取的方法。原内容采用须等当前核验成功。
- 等待澄清时，说明问题可由哪类已允许依据解决。源事实已唯一确定与真实用户选择分别说明，沿第7节规则执行。

优先复用现有hint和recovery合同。确需增加结构字段时先改同源Schema，再接Rust、Pi格式化和任务投影消费者。字段只含完成恢复所需的控制信息。

### 5.3 验收

沿`check-workflow-reliability.mjs`保留当前消息未归属时的原拒绝。增加同一会话另一旧失败输入未归属、当前消息已正确归属的情形，证明可保存草稿且执行仍拒绝。另核消息或条件在原平台验证等待期间改变时的既有版本行为。错误提示复用实际Pi工具接缝核可见字段与错误状态。

## 6. 旧已登记操作的未完成窗口

### 6.1 根因和合同

当前register可以接回旧AnalysisUpdate的原fingerprint，完成receipt也可重放。实际apply_update却对所有create执行normalized_adoption并写格式2，旧needs_clarification在这里失败。旧未决revise也可能被新迁移要求挡住。

在工具边界依据真实已登记操作、原tool合同和合法原参数，一次识别旧请求方言，传递内部类型给analysis owner。v1调用及已有、指纹相符且确属旧AnalysisUpdate形状的合法未完成操作按旧写语义完成。已有operation本身只证明登记身份，仍须核原契约及参数。

同一tool_contract_version=2中也有升级前合法登记的旧AnalysisUpdate形状，方言判定须包含这一窗口。新v2登记继续使用CurrentAnalysisUpdate。通过宽AnalysisUpdate结构校验本身不能把普通当前命令转成旧命令，兼容分支须同时具有真实既有登记、匹配fingerprint和合法旧形状。

保持原wire/fingerprint/operation/origin和调用预算。旧未完成命令按当时允许的决定形状完成，并写对应旧格式。新v2命令沿CurrentAnalysisUpdate及当前澄清模型。普通新命令操作旧任务时，按现有明确转换入口推进。目标已经进入新决定格式时，旧操作须遵守其原expected_version和现有冲突规则，新状态保持新格式。

兼容判断由宿主登记事实决定，模型通过其当前公开工具合同提交业务参数。旧/新分支仅覆盖决定规范化、未决更新和格式写入，事务、权限、版本和幂等使用原同一更新流程。已完成回执按原重放操作返回，unknown按既有查证纪律处理。

### 6.2 验收

扩`check-tool-contract-version.mjs`和原澄清恢复接缝。恢复夹具明确含ledger.tool_contract_version=2、state=registered、receipt为空、原fingerprint相符的合法旧未决create和revise，通过实际register/invoke/analysis更新链完成。完成后核对应旧格式和真实开放问题，同operation重放只产生一次条件修订，新v2登记仍拒绝旧未决形状。目标已迁移新格式时，沿原expected_version冲突规则处理并保新格式。既有v1证据按影响复用，重跑范围限于受影响的兼容场景。

## 7. 共享语义、时间依据与合法零

### 7.1 首末ASR定义和时间范围

当前28个指标对象包含重试救回和最终成功候选平均，ASR首次/最终尝试成功率仍主要放在文档段落。J01的8次相近检索没有把固定数据快照送入任何一份provider输入，随后采用当前请求时刻，并把年份/快照交给用户选择。

在现有合成资料owner中将已有首末ASR定义整理为可检索的规范指标及参数化SQL，别名与原表达一致。定义采用全部可见ASR尝试的合格轮次总体，首次取最小attempt_no，最终取最大，先选末次再判断状态，最终取消/超时保留在分母。新增定义的出处、列绑定、适用范围沿原资料生成链。

资料清单、生成物和`verify.py`中的指标计数随这两项已有定义同步，记录原28项到新增两项后的合法计数变化。原28表、421字段及原事实保留，独立参考按已批准口径核算，旧参考key和原成绩保留各自历史身份。

overview中已经给出的2026年7至9月活动期和排他快照，通过现有资料关系/支持交付连接到相关统计定义。时间质量文档引用同一权威段落，避免产生多个独立维护的日期默认。资料限定只作用于这套合成数据。

分析时间、来源快照、请求时刻各有含义。用户指定及已采用的任务条件优先，当前有效且获准资料唯一确定的事实可自行采用。默认值必须能在实际工具回执中找到来源，进入对应任务和time_roles。模型输入的系统日期只用于其实际职责。

### 7.2 已登记问题的解决

统一resources、实际v2工具说明与waiting_clarification恢复提示。对用户选择类问题，依据真实回答更新条件。对待查事实类问题，当前有效且获准资料能唯一解决时，Pi可在同次revise中更新事实条件、引用依据并关闭对应ID。

复用现有semantic_resolution的explicit_user/unambiguous含义及resolved_clarification_ids。问题语义由Pi理解，宿主核当前版本、资料引用、消息身份和问题归属。仍有真实多义或冲突的事项继续保持open，部分回答只影响对应问题。

### 7.3 合法零和覆盖

日表ETL的键集合来自wake、session、turn并集。只从turn生成fact_days会遗漏合法的零轮次日表行。本轮内存反例用真实schema、原合成维表及一条合法sessionless wake运行未修改ETL，得到turn_count=0、wake_count=1，原模型核对SQL返回空集。

共享文档明确稀疏日表的实际生成范围、快照与测量样本规则。核对SQL采用能覆盖问题所需来源的键集，或用对请求范围返回聚合结果的形式表达零、NULL及覆盖。资料未知的覆盖保持未知。参数、窗口和日期粒度须与日表快照相符。

把原模型SQL、资料示例和下一次真实生成SQL分别验证。保留已通过的子事实快照逻辑。优先用合法wake-only产物、无测量样本和空分母三种相互区分的输入，沿现有SQLite接缝核对。

### 7.4 来源链路与验收

资料变化经原手动同步、差异整理和索引路径进入工具。实际回执证明首末定义、默认时间范围及相关支持已经交付。使用原始合成事实及独立参考验证SQL，说明参数前提。

J01原SQL在其实际11月快照下与独立逐行计算一致，使用资料快照时也与独立计算一致。其旧失败原因应精确写为时间依据未取得/快照选择及无草稿，候选均值算法据现有样本可核。原attempt和评分原件保留历史记录。

## 8. 已批准的两条补充验收

用户于2026-11-05批准两条补充提问，以新attempt保存，保原题、原partial、失败和费用。补充项写入现有运行报告及该case的attempt列表，记录本节批准日期和补充输入。原scenarios及原attempt文件保留。

| 归属 | 固定补充输入 | 可观察验收 |
| --- | --- | --- |
| J06 | 沿刚才的九月ASR分析，补充各会话的ASR最大尝试次数。策略后来更新时，历史会话按哪份配置解释？给核对SQL，不执行。 | 实际SQL与说明通过session.policy_id取冻结策略的asr_max_attempts，配置与实际attempt数分别表达，Data Agent调用预算保持其原用途 |
| J19 | 在零个符合条件的轮次，或符合条件的轮次都没有可见ASR尝试时，最终ASR成功率应如何表达？给核对SQL，不执行。 | 采用正确尝试总体，空分母输出NULL，计数与测量/比例口径分别核实，原稿在独立合法样本上验证 |

补充证据只覆盖其实际断言。每条原断言按原成功证据和获准补充证据逐项判断，case汇总可按实际新增覆盖更新，原attempt自己的状态维持原值。原`grade.py`已有多attempt及断言证据能力，沿此记录即可。

## 9. 连贯验证与工程出口

每项先运行最小区分检查，再完成相应范围的构建和原回归。以下是影响映射，执行者在CURRENT绑定实际命令和断言。

| 修改范围 | 主要既有接缝 | 需要证明的接口 |
| --- | --- | --- |
| 结构依赖和引用 | check-structure-column-bindings、check-query-semantics、依赖owner测试 | 当前字段读取到采用一致、真实DDL变化及来源撤回仍正确 |
| 预填材料 | check-prefill-materials、ingestion/prefill原测试 | 同版metadata引文可用、错版/伪引文拒绝、冻结范围一致 |
| 草稿边界 | check-workflow-reliability、check-query-workflow | 本条归属/版本与执行确认各自落实 |
| 旧操作恢复 | check-tool-contract-version、原恢复接缝 | registered未完成和已完成重放分别验证 |
| 工具提示与资料交付 | check-tool-schema、check-request-context、原资料verify | 新提示真实进入v2、数据范围支持可见、原来源权限 |
| 资料SQL | 原reference及docs/sources/cockpit/verify | 独立事实、合法生产路径、参数前提一致 |

Rust变化后在连贯边界分别重建API/Worker，核实际运行二进制。工程harness清除继承的真实模型环境，真实09使用原已批准配置。保留Cargo缓存和串行数据库检查。

当前声明、同源合同、代码和模块边界通过`make verify-materials verify-contracts verify-code verify-architecture verify-delivery`核验。与本次无关的旧通过证据在CURRENT记录适用理由。绑定调整保存原命令、现命令、对应要求和变化原因。第3–6节已有四项验收占位，实际补断言后将command绑定到表中现有脚本或其现有过滤入口，先前脚本通过仅支持先前断言。

相关工程命令按实际修改选择，包括`node tests/mvp/check-structure-column-bindings.mjs`、`node tests/mvp/check-context-dependencies.mjs`、`node tests/mvp/check-query-semantics.mjs`、`node tests/mvp/check-prefill-materials.mjs`、`node tests/mvp/check-workflow-reliability.mjs`及`node tests/mvp/check-tool-contract-version.mjs`。旧恢复检查已有filter能力，补新断言时同步其真实测试计数，禁止让过滤器命中零项也报通过。开发期在这些接缝取得区分性RED/GREEN，随后做所需回归，重复覆盖的组合命令只执行一次。

真实补验顺序为一个能区分修复效果的S03代表，随后T02到A03、J01、J19，以及J06和J19获准补充。S03继续利用原S01/S02条件及合法结果。T02确有两稿后才发A03原执行消息。J06已有数值证据按影响复用。G08在实际消费者受到影响时补原普通刷新检查。

每个受影响场景先作一次新attempt。新的失败若指出另一条可修的一般原因，先修再复验该范围。没有新依据时保存实际缺口，避免重复同一试用。工程、真实模型、真实索引/Mem0和合成平台分别报告。

## 10. 文档、审查与交接

同步本轮实际改变的接口说明、实现设计对应段落、README完成度及CURRENT。图只更新发生职责变化的来源绑定、材料交付或草稿执行链，生成后查看实际结果。

完成实现后，由未参与实施者限定核对实际delta、原要求、新旧协议、引用权限、四条编程规则及真实证据。独审记录沿原格式保存。全部当前绑定验收和核心断言具备证据时，执行verify-increment取得本增量收据。

工程修复、核心真实效果和后置回归分别交付。若仍有具体模型表现或外部问题，写清实际输入、已交付依据、失败边界及下一步所需事实。当前执行包阶段只完成计划和审查。

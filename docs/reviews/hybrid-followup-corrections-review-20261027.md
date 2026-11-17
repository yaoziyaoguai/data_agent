# 二次接手有限纠偏独立审查

日期：2026-10-27。审查者：独立子代理 `followup_corrections_review`。未参与本轮产品、测试或架构检查器实现；只写本记录。审查状态：**最终有限审查通过：本轮纠偏代码、相称验证及Oracle后执行包文字已核对，无剩余本轮阻断**。冻结配置选择及完整消费者接续仍为05的open缺口；本记录不关闭05，不生成05最终passed收据。

## 范围与依据

依据 `AGENTS.md`、`docs/CURRENT.md` 顶部 `delivery.increment` 及“二次接手审计”，核对本轮删除漂移与修复普通缺陷，不把05剩余主链扩成此次修复范围。05仍为 `active`，不能由本记录关闭，也不推进06–09。

逐文件对照 `.local/hybrid-followup-audit-20261027/before/`，不以相对HEAD的累计差异代表本轮。产品、测试与检查器范围为 `.local/hybrid-followup-audit-20261027/corrections-scope.json` 的15个文件：

- `crates/data-agent/src/modules/knowledge/{mod,store}.rs`
- `crates/data-agent/src/modules/retrieval/vector.rs`
- `crates/data-agent/src/use_cases/{knowledge,knowledge_embeddings,knowledge_sources}.rs`
- `crates/data-agent/tests/{raw_index_handover,retrieval_channel_coverage,source_excerpt_recall}.rs`
- `scripts/check_architecture.py`、`tests/architecture/test_boundaries.py`
- `tests/mvp/check-retrieval-{allowed-set,channel-coverage,channel-faults,ranking}.mjs`

另核对接续执行包 `docs/execution/semantic-runtime/hybrid-retrieval.md`、`AGENT_PROMPT.md`、`coverage-and-validation.md`、`cross-validation.md` 顶部本轮处置、`docs/architecture/implementation-design.md` 第17.6.1节及所引用容量边界、`docs/CURRENT.md` 最新“二次接手审计”节。未把修改前快照中没有的实验工具归入本轮；未修改产品、CURRENT或执行包。未运行数据库harness或付费服务；数据库与综合检查由主实施者串行执行。本审查者独立运行过临时目录中的纯Python架构检查反例，并读取主实施者的红绿日志与实现。

## 当前结论

本轮有限纠偏可接受，已核代码与相称验证通过，没有剩余的本轮新增阻断。已核实并修复文档窗口迁移遗漏总长度约束、CTE豁免掩盖已登记跨owner物理表，以及合并授权事务导致预算拒绝时丢失首次冻结三个问题。原回执先于当前配置、通道部分成功、失效后同排名补位、文档窗口及来源引用窄投影等有限修复符合原合同。

另核实一项尚未解决的配置优先级问题：直接调用Embedding时，已有冻结profile、尚未发出的raw新批次仍会在读取冻结值前被非法环境profile阻断；真实消费者入口的全局guard还会因当前profile缺失/非法而停止所有目标。现有测试未覆盖冻结后新批次遇到非法配置及相应真实消费者分支。主实施者决定把完整消费接续明确留在下一执行包，不只修叶函数或凭迁接标记猜测有回执。该问题保持open；本轮有限纠偏通过不代表05整体完成。

共享Embedding回归曾失败并暴露本轮首用冻结回滚，见发现5。该退化在本轮修复，保留原强断言重跑通过，没有转交下一包或用其他绿色日志覆盖。原失败日志继续保留。

## 发现与处置

### 1. 文档窗口越界不能由SQL截短后通过校验——已修

本轮把文档回源从旧 `verify_and_merge` 改用 `verify_and_merge_windows`，但后者初版遗漏旧路径的总长度约束。正文为“甲乙”，命中 `offset=1,length=9`，hash为“乙”时，MySQL `SUBSTRING` 返回“乙”；旧初版会交付内容，同时保留长度9的错误locator及 `source_length=2`。

修复在 `use_cases/knowledge_sources.rs` 沿现有窗口核验加入 `offset.checked_add(length).is_some_and(|end| end <= total_length)`，没有增加新读取路径。新增 `truncated_source_window_cannot_validate_an_out_of_range_locator` 从此反例验证过滤。

已读取 `.local/checks/followup-source-window-bounds-red.log` 的实际失败与 `followup-source-window-bounds-green.log` 的4项完整通过结果。此修复保持现有定位/版本/hash约束，不改变文档拼接语义。

### 2. CTE别名不能豁免已登记的跨owner物理表——已修

为 `JSON_TABLE` 和CTE误报添加的初版豁免按全文件CTE名跳过检查。独立反例在knowledge store先声明名为 `analysis_tasks` 的CTE，再发出另一条 `SELECT ... FROM analysis_tasks`；检查器曾返回无违规。同名CTE内部读取物理表的形式也能漏检。

修复先确认表是否为 `OWNERS` 中已登记物理表，只有未登记名字才进入CTE/`JSON_TABLE(...)`词法豁免；已登记表仍按owner判断。新增 `test_cte_alias_cannot_exempt_registered_cross_owner_table`。没有新增allowlist、通用SQL parser或权限框架。

已读取 `.local/checks/followup-architecture-alias-red.log` 的真实失败，以及 `followup-architecture-final.log` 的12项检查和仓库静态检查通过结果。该工具仍是简单词法工程检查，不是完整SQL解析器或安全边界。

### 3. 同一raw入口重复静态授权——已简化

初版在RawIndex分支与 `authorize_in_tx` 重复检查合成空间和 `authorize_model("bailian")`。修复把这两项统一留在 `embed` 入口一次；事务内租约、运行身份、账本及业务新鲜度核验保留。

`raw_index_operation` 用于原回执查询和新调用身份的两处实际复用，保留合理。`DocumentWindows` 是来源owner返回窗口和总长度的明确职责，不属于为一次调用提前建立框架。

### 4. 冻结后新批次及真实消费者的配置优先级——open，交接05完整修复

`knowledge_embeddings::embed` 对无旧回执的RawIndex批次，先调用 `maintenance_profile()?` 并配置当前trial，再进入 `authorize_in_tx`。后者把 `maintenance_profile()?.as_ref()` 作为参数传给 `bind_source_index_embedding_in_tx`；参数求值先于owner函数内部“已有 `embedding_profile` 则返回”的分支。因此当前环境包含非法JSON或不合法Schema时，已有冻结值也不能使新批次继续。

缺失环境profile返回 `None`，owner已有冻结值时仍成功；不能把缺失与非法笼统写成同一故障。已有成功或unknown批次的缓存优先级已修，不受此问题影响。

以上区别限于直接调用 `embed`。真实 `knowledge::process_index` 入口仍有全局维护配置guard：当前profile缺失或非法即返回 `Ok(false)`，尚未读取目标冻结值或原回执。因此直接Embedding成功不能证明真实消费者可继续。该guard同时承担“未绑定且从未发送的新目标在无有效配置时保持pending、不消耗尝试”的现有行为；修复顺序时需要保留这一行为，并分别验证旧操作与真正首次发送。

同一顺序也提前调用 `configure_embedding_trial`：`runtime/model_calls/store.rs::configure_budget` 会写入当前trial或比较其配置指纹。合法当前profile若沿用已有trial id但改了配置，也可能先报 `idempotency_conflict`；合法新trial会先登记一个此次实际预算不使用的trial。这是同一配置选择顺序的影响，不需要另一套恢复机制。

现有 `raw_index_handover.rs` 循环 `[None, invalid-profile, valid frozen profile]` 只验证尚未冻结目标的旧成功/unknown批次。之后首次发送批2冻结，再用另一个合法profile发送批3；没有验证“已经冻结、尚未发送的新批次、非法当前profile”。

建议在现有owner绑定流程中先选择已保存配置，只有明确未冻结且确需首次发送才解析和配置环境fallback。保持原operation、租约及账本；不catch非法输入伪装缺失，不重复查询/重试绑定，不为此创建runtime恢复框架。

最终范围决定：本轮不只补叶函数，完整消费者资格、owner冻结与trial配置顺序一并交给下一包05恢复切片。旧raw移交项可以没有profile； `origin_job_id` 或已用attempts不能证明实际有Embedding回执。现有operation按来源/修订/批次文本指纹生成，不能凭迁接标记替代原账本判定。惰性fallback可解决绑定接口的参数提前求值，但单独采用不能证明真实消费者接续完成。需要真实consumer分别验证已有成功/unknown回执、冻结后新批次与从未发送新目标的pending行为；本轮不宣称此项已实现或通过。

### 5. 合并授权事务使预算拒绝同时撤销首次冻结——已修并重跑通过

`followup-regression-embedding-verified.log` 以exit 2结束，实际失败在 `check-shared-embedding.mjs` 等待“原文目标实际冻结原预算并耗尽，才更换当前配置”。该场景先把维护trial的剩余调用数设为1，知识索引先消耗该次，随后原文目标需以同一个预算冻结并如实失败；测试没有改变此要求。

修改前 `knowledge_embeddings::embed` 先经 `authorize_in_tx` 冻结并提交，再进入许可事务。本轮为消除重复授权把二者合成一笔：`bind_source_index_embedding_in_tx` 的profile写入与 `provider_calls::issue_in_tx` 在同一事务。后者先INSERT attempt，再检查预算并可能返回 `budget_exhausted`；错误传播使整笔事务回滚，首用冻结也消失。这一明确控制流与上述超时一致，不能归为无证据的环境波动。

修复仅对 `Binding::Index`/`RawIndex` 恢复首次绑定的独立事务提交，后续许可事务再次核对当前租约/知识版本后调用issue。已有两事务间状态可能变化的明确理由，因此动态核验不能当作无意义重复删除。Tool/Browse不增加该首事务；入口静态授权仍一次，原raw回执优先保持。

已独立复读 `AppTx`、issue和finish边界：许可失败仍通过错误传播回滚本许可事务的attempt INSERT与预留，不会误提交issued；先前绑定独立保留。三个发送/结算时点没有改动。`followup-freeze-regression-summary.json` 及对应完整日志确认API/Worker重建、共享Embedding原9组强断言（含2项Embedding单测、10项开发harness单测）、共享待办2项来源登记及3项raw迁接均exit 0，`officialRequests:0`。补修后 `verify-code` 也完整exit 0。没有放宽原测试；这一修复不消除发现4的配置选择与消费者缺口。

## 已核对的有限行为

- 通道部分成功保留可用结果并标 `bounded`；失败不增加completed、不标exhausted。聚合用 `Option` 区分raw尚未执行，避免其空状态掩盖全路失败。同版本对象合并新fragment，同通道相同fragment保留较高可比较分数，不同对象版本分别保留。
- `knowledge::retrieve_scoped_in_tx` 留住至多30个既有排名候选，供legacy首项回源失效后沿同一排名补位；没有再搜一轮或再次RRF。v1的knowledge允许集为空时直接停止，不因raw来源非空触发无用Embedding。
- RawIndex旧成功/unknown回执查询先于当前profile解析和绑定；runtime缓存核对purpose、operation和parameters，unknown不重发。配置优先级剩余问题见发现4，不能把已修回执分支概括成所有冻结后首发都已通过。
- 文档窗口SQL按原entry顺序连接字符串 `effective_value`，空字符串保留分隔，非字符串跳过，分隔为两个换行；Unicode位置使用字符码点。只回传相交子串和总长度，未把整篇body送回调用层。
- 来源引用窄投影覆盖root/fact/evidence/material/structured五类引用，保留JSON类型和数组类型条件，重建最小requirements形状；不传quote或body。相应引用的来源修订变化仍报 `stale_knowledge`，未发现权限或修订检查被削弱。
- `check-retrieval-channel-faults.mjs` 本轮只有注释纠正，没有删除场景或放宽断言。SQL前1200排序不能证明Milvus深度实际前进；最后有正文也不能证明期限前已读到。这两处不再以注释作过度结论。

## 运行证据与限制

以下均为本审查者读取的主实施者日志，未冒称亲自运行。通过项只支持对应范围，不证明完整05、真实模型、真实平台或部署。

| 日志（均在 `.local/checks/`） | 已核结果及范围 |
| --- | --- |
| `followup-vector-unit-final.log` | 9项向量单测通过 |
| `followup-vector-all-failed-green.log` | 2项Rust通道集成通过；Milvus协议替身，`officialRequests:0`；日志中的unused helper警告属于后续已删除代码的历史构建 |
| `followup-empty-scope-green.log` | allowed-set实际检查 `passed:true` |
| `followup-refill-green.log` | 正式工具首项失效后补位检查 `passed:true` |
| `followup-receipt-final.log` | source index registration 2项、raw handover 3项通过；`passed:true, officialRequests:0`；不覆盖发现4 |
| `followup-document-window-verified.log` | 真MySQL/专用真Milvus的5项检查通过；中文、emoji、组合字符、空/非字符串entry、大未选正文、旧修订及五类引用依赖均有断言，`officialRequests:0` |
| `followup-source-window-bounds-green.log` | 4项窗口单测完整通过 |
| `followup-architecture-final.log` | 12项架构单测及仓库静态检查通过 |
| `followup-build-final.log` | API/Worker完整构建成功 |

文档窗口曾出现两次真实失败：`followup-document-window-green.log` 为 `Incorrect arguments to JSON_TABLE`，`followup-document-window-final.log` 为 `FOR ORDINALITY` 的signed BIGINT与Rust `Option<u64>`不匹配。最终直接从 `k.body` 展开JSON、以 `Option<i64>`读取ordinal，采用 `followup-document-window-verified.log` 的完整通过结果；没有依据green/final文件名认定通过。红日志保留。

最终回归已核对 `followup-regression-summary.json` 与实际日志：code、contracts、build、scope、architecture、historical、dependencies均完整exit 0。对应结果是fmt/clippy/TypeScript/web完成，584项双侧合同通过，API/Worker重建成功，8组 `verify-hybrid-scope`（含41项检索单测、5项来源集成、2项来源登记和3项迁接）通过，架构12项自测及真实DB锁/事务检查通过，历史来源5组和上下文依赖7组通过。日志使用 `followup-regression-{code,build,scope,architecture,historical,dependencies}-verified.log`，合同日志为 `followup-regression-contracts.log`；首次格式失败记录保留。

随后 `followup-regression-embedding-verified.log` 完整exit 2：2项Embedding单测和10项开发harness单测通过，但共享Embedding主脚本在等待raw首用冻结时超时。这份失败证据保留，不能因名称含verified认作通过。修复后的 `followup-freeze-regression-summary.json` 记录重建、共享Embedding整组、共享待办/迁接、再次 `verify-code` 均exit 0；本审查者已逐份读取 `followup-freeze-{build,embedding,raw}-verified.log` 与 `followup-code-after-freeze.log` 的完整结果。详细行为和限制见发现5。

完整05 `verify-increment` 未执行，不关闭增量。上述已通过检查不证明原文/知识完整主链和完整恢复已完成。

## 接续执行包复核

已核对执行包与启动提示中的5个纵向切片：原配置选择与真实消费者接续；知识owner窄读；统一深度进度及有效性补取；覆盖元信息/正文的10秒工作期限；内部raw+knowledge同链交付及05收口。新增第一切片明确承接发现4，分别要求冻结后新批次遭遇缺失/非法/同trial改值/新trial、原成功/unknown回执、全新无配置目标的消费者反例，没有把直接Embedding绿色写成完整恢复。先核实锁定Milvus的实际分页能力，不把重复top200冒称推进；原Embedding账本收尾不因期限而被取消。

发现5的教训已加入第一切片与启动提示：首次冻结独立持久化，许可失败回滚不带走原绑定，跨事务租约重核不能当重复Schema校验删除。后续取消无关新trial登记时，原共享测试中“新trial存在且调用数为0”的检查应按已确认行为改成“未登记且零派发”，并在CURRENT留下原预期、新预期与独立依据；不能为保旧断言保留无用登记。本次代码没有修改该测试或提前宣称上述未来行为已实现。

审查指出“提前词法30项、dense到达后再读30项”可能违反已有读取上限。包中现已明确：30是整次请求共享内容读取上限，提前词法、后来dense和失效均计入且不返还；已读内容在当前调用集合复用，额外高排名未读项不得绕限读取，只交已取得有效子集并如实bounded、保留定位。没有新通道配额或预算服务。

Oracle审包重试返回后，已逐项核对其五处建议与最终5个切片、启动提示、覆盖导航、正式接口设计和CURRENT最新记录，未发现剩余计划级阻断，具体核对见下一节。本结论来自本地独立复核，不代表Oracle再次批准修订版。

05的已知缺口仍包括真实深度推进、元信息/正文的完整期限、entry/statement/anchor整读替换、生产与内部双类型统一交付。这些没有被本轮有限修复或小范围绿色日志消除。

## Oracle后最终文档复核

已读取 `.local/oracle-hybrid-followup-package-20261027-retry/answer.md`，独立核对其SHA256为 `4aef283b80ff0a8506aa7860acc9a9fe8f34f6b77db3c6acaa4c16a79d66025b`，与交叉验证记录一致。原结论为“需修订，补齐后可以继续执行05”；没有把静态意见当作运行验收，也没有把它表述成对最终文字的逐字批准。

| 复核重点 | 最终文档与相容性结论 |
| --- | --- |
| 资格判定、实际领取及原预算 | 详细包和Prompt都先经M02公开窄接口读待办头/冻结值，按原确定性批次查原账本，再对可处理目标执行增attempts的领取。队首无配置新目标不耗次数，也不能挡后面的冻结/可恢复目标；origin和历史次数不证明回执。混合队列同时覆盖成功、unknown与无回执的旧raw，索引尝试与provider发送分别断言。首次冻结独立提交、许可事务重核与预算拒绝不换trial均保留，没有引入资格状态表、恢复Worker或新账本 |
| 窄内容、完整必要依赖与v1消费 | 所选正文保留原对象/entry/statement身份、修订、原位置、总长度和补读信息；依赖与实际贡献来源由既有元信息/索引/legacy窄引用另行取得，不能从裁小entries推断没有依赖。最终来源限制、新鲜度核验、v1装配和裁剪后实际交付依赖都消费这份依据。非首条目补读、正文外必要来源、异步换版及裁剪一致均有明确反例；与17.6.1相容，不靠回读整对象补兼容 |
| 唯一推进职责 | 明确扩展现有 `use_cases/knowledge.rs::search_stage_outside_lock` 为唯一推进owner，持有候选身份、分片/深度、有效性、共享内容与绝对期限。`knowledge_embeddings`保留原授权/发送/结算，M04提供一次深度请求和共同融合；旧入口仅必要委托。返回已回源命中、最终核验依据、实际扫描进度和有界未交付定位，与17.6.1一致。真实锁定Milvus分页须先取得证据，不凭参数拼接或重复top200关闭；没有新增协调框架 |
| 可成立的有界验收 | 第201条反例的前200条在元信息/依赖索引/窄引用阶段淘汰，不消耗内容名额；正文后失效另测30以内补取及耗尽后bounded。规则/例外跨批给出不足或已有必要支持的触发，不要求猜测未知例外后无条件扩搜。1200是语料规模，非单次接收数。共同1000唯一record、5轮含首轮、10秒工作期限及共享30内容读取不变，失效不退款；dense后到不另获轮次或读取名额。CURRENT记录了原计划夹具、修订理由和独立边界依据，没有修改既有产品断言 |
| 公开v1与内部双类型验收 | v1可表达的范围/故障/预算/期限/知识窄读走真实工具登记、执行、锁外读、最终重核、裁剪和保存。raw与双类型经同一个正式内部组合入口取得真实MySQL/Milvus召回、owner正文、修订核验及全局次序。覆盖导航与Prompt均分别报告两组；不以GET、索引行、协议数组或测试手拼结果代替，不新增临时v1 raw分支或公开v2端点 |

期限、读取额度和融合条款也相容：词法可在Embedding尚未结束时窄读，按当前需要读取，不抢跑用满30或预设dense配额；后来候选继续进入同一RRF层，不把既有融合分数当新票。期限到达停止新检索工作，保留期限前已取得内容，仍等待已发Embedding按原身份收尾及最终动态核验。该约束没有被写成严格10秒HTTP SLA，也没有借此省略来源核验。

`coverage-and-validation.md`保留全要求映射并明确05承担上述缺口；17.6.1把窄投影与唯一用例写为目标合同，未冒称实现已完成；CURRENT最新节继续将有限修复、发现4及其他05剩余主链分开，优先于历史A–E自报。所有文件保持05完成后停止、06另行接公开v2/支持装配/续读编码的边界。

主实施者补充的 `.local/checks/followup-package-final-summary.json` 已读取：`make verify-delivery verify-materials`、架构文档检查及 `git diff --check` 三项完整exit 0。它们只支持声明、材料和文档一致性，不能证明未实现的05主链。本审查阶段未重跑产品或数据库检查，只更新本记录。

## 最终指纹与结论边界

最终15项冻结清单已独立逐项核对，全部匹配。`.local/hybrid-followup-audit-20261027/corrections-scope.json` SHA256为 `c649755822c820efa77d3083264cb35b4982a9cf9f80ca3687c1eea677e51963`，已包含raw测试rustfmt及发现5的事务边界修复；最终 `knowledge_embeddings.rs` SHA256为 `79f6767d0da4be04a6060ea0871fb5e8f081c3105de1c8b53d0d86780f9c0236`。

已独立核对 `.local/checks/followup-evidence-manifest.json` 中28份日志/汇总的字节数和SHA256，全部匹配；该清单自身SHA256为 `a25575fcfb8eddb84f8e97c80622681ba571f84f5f543e210aa840367248ac9f`。其中包含真实失败，不能把哈希一致解释为全部检查通过；通过范围以上文实际结果为准。

Oracle后文字复核完成时再次核对15文件清单及实际内容，全部仍匹配上述 `c6497558…e51963` 清单。本轮有限纠偏与最终接续说明无剩余阻断；05仍active，发现4及其余主链继续按接续包执行。本记录不替代05最终独立review JSON、绑定验收或 `verify-increment`。

发现5发生并修复于Oracle审包附件提交之后，最终五处文字也未再次发送Oracle；不能声称Oracle看过最终代码或逐字批准最终包。本地独立代码/文档复核与实际重跑分别承担相应证据。保持独立审查与实现分工，不把本记录或检查脚本表述为不可篡改的保证。

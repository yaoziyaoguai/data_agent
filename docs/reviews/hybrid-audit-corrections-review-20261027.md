# 混合检索有限纠偏与接续包独立复核

日期：2026-10-27。审查者：独立子代理 `hybrid_contract_audit`，未参与本轮产品实现。

## 范围与证据边界

对照本地接手快照 `.local/hybrid-audit-baseline-20261027/` 审查本轮增量：`modules/retrieval/{mod,vector,store}.rs`、`modules/knowledge/store.rs`、`modules/jobs/store.rs`、`use_cases/{knowledge,knowledge_sources,data_tools}.rs`，并核对相关新增或修订测试、`raw_index_handover.rs` 的调用关系。快照仅用于区分本轮有限纠偏与仓库其他累计改动，不是业务通过证据。

同时审查 `docs/execution/semantic-runtime/hybrid-retrieval.md`、`AGENT_PROMPT.md`、`evidence-delivery.md` 与正式设计第17.5–17.6.1节。审查未运行测试、数据库或付费模型，未修改产品和执行包；主实施者的运行证据应独立列明。本记录不能替代05的最终独立审查、验收收据或内容指纹。

## 当前结论

本轮修复方向符合原合同，主要是删除错误路径、恢复正确身份/顺序及保留一般错误；没有发现本轮引入新的权限框架、Agent循环、调度器、分层重复校验或无意义抽象。

审查发现一个确定状态问题，以及两处执行包的可实施性说明。主实施者修正后，本审查者已复读相应代码、测试和执行包；这批有限纠偏与接续包在所审范围内可接受，没有剩余的本轮阻断发现。运行验证仍由主实施者的实际证据单独证明，不能据此把05标为完成。

## 复核发现与处理

### 1. 已用完尝试数的迁接项会永远停在 pending

`modules/knowledge/store.rs::register_source_index_target_in_tx` 现在正确接续旧 `attempts`，但新行仍使用默认 `vector_state='pending'`。当旧第三次执行中断、租约到期后，`jobs::legacy_raw_backlog_in_tx` 会接受 `running/queued, attempts=3` 的记录并迁接。新记录不能被 `claim_source_index_in_tx` 的 `vector_attempts<3` 条件领取；已有耗尽收敛只覆盖 `sending/unknown`，也不会处理这个 pending。旧行已 finished，而新行持续显示未完成。

这是现有三次尝试合同与迁接状态不一致的普通可复现输入，不需要假设额外并发或编造概率。最小修正是在既有耗尽收敛路径覆盖这类 pending，或在登记时沿现有状态语义明确收敛；不能重置次数、补一次尝试或新建恢复器。需要补充 `attempts=3` 迁接后执行消费者检查、终态明确且不产生外发的反例。发现问题时 `raw_index_handover` 测试只覆盖迁接前已尝试两次。

复核结果：既有耗尽收敛SQL已把pending加入原sending/unknown集合，没有新增机制。新增 `exhausted_handover_reaches_terminal_state_without_another_claim` 构造第三次运行后租约过期，验证迁接保留3次、该目标不再被领取、最终failed且保留 `vector_receipt_unknown`。静态复核通过；本审查者未执行此测试。

### 2. 统一截止时间不能直接取消整段 Embedding 账本流程

执行包把统一10秒期限从查询表示/目标解析开始计入，方向正确，但必须明确实施边界。当前 `knowledge_embeddings::embed` 先提交 `issue_in_tx`，等待 `request.send()` 后才调用 `finish_embedding_in_tx`。若实施者用 `timeout_at` 直接包裹并丢弃整个 `embed` future，就会跳过成功/unknown结算；后续原调用回读只看到 issued 并拒绝重发。

包中应明确：剩余期限传至实际网络发送边界，发送超时仍经现有结算路径落为unknown；已开始操作的必要账本收尾不能被检索工作期限一并取消。继续复用现有 permit/cache/finish，不增加任务框架、保活服务或新operation/trial。期限限制候选工作，不把数据库收尾等同于严格10秒HTTP响应承诺。慢Embedding协议替身应验证原账本状态与无重复发送，不能只断言前台超时。

这是下一包的实现约束缺口；当前有限修复没有新增这一取消行为。

复核结果：执行包已补明实际网络发送期限、复用 `finish_embedding_in_tx` 收尾及不得取消整段future；同时要求慢Embedding替身验证原账本与不重复发送，不另建后台结算任务。该建议仍是下一包工作，不冒称产品已实现统一期限。

### 3. 旧 Embedding 绑定恢复不能引用不存在的公开查询

执行包“复用runtime公开操作查询”需要具体化。当前 `runtime::provider_calls` 公开的是 `issue_in_tx`、`finish_in_tx`、`cached_embedding_in_tx`、`finish_embedding_in_tx`；缓存接口不返回旧trial/profile。`runtime::recorded_tool_operations_in_tx` 查的是工具账本，不是Embedding调用账本。

应明确复用现有许可/缓存/结算机制；如果迁接必须读取原attempt的trial、状态与已知回执，仅在runtime owner内补一个按稳定attempt/operation的窄查询，再由组合用例调用。不能让下一实施者跨私表读取，也不能假定完整旧profile已经保存。无须为此建立通用provider恢复框架。

复核结果：执行包已列出现有公开入口、指出缓存接口不返回旧trial/profile，并将可能新增的查询限定在runtime owner内。不存在的恢复接口不再被描述为已可复用能力。

## 已核对可接受的有限改动

- raw身份加入修订和位置，同一文档不同位置不再被来源级去重；跨BM25/COSINE的“取最大原始分数”已删除，回源保留融合分数。新增反例能区分一文规则和后段例外。
- `recall_excerpts_in_tx` 把窗口展开后逐命中排序，去掉按文档整组交付；跨来源高/中/低窗口反例能击中原错误。仍先读整篇的旧责任明确留在05剩余项，不能称已完成定点读取。
- 两条范围外计数扫描及 `gate_excluded` 传递已删除；v1计数仅取实际拿到的候选。原“必须过滤数大于0”的错误断言按前置范围合同纠正，不应为了保住旧断言恢复反向扫描。
- 分片失败会使覆盖 bounded，成功通道结果保留。新测试明确标为Milvus协议替身，父Node异步等待Rust，失败会传播。它不证明真实Milvus完整召回，也不证明已落实逐通道公开coverage。
- `process_index` 不再同时领取尚未执行的另一类任务；当前混合待办测试验证第一次知识处理期间raw仍pending且未耗次数，再推进至raw完成。一般owner错误不再通过宽泛分支或 `.is_ok()` 被吞成失效结果。
- 迁接次数承接与首次绑定目标时不清零的方向正确；发现1中的耗尽状态也已通过原有路径修正。

## 共享Embedding测试前提的复核

主实施者随后报告共享Embedding检查在重建阶段失败，并提出修正夹具等待条件。本审查者核对源码：原测试仅等待长文knowledge目标indexed就停止worker，不能证明raw取得完整回执；部分索引场景也仅等待knowledge unknown便改当前profile，不能证明raw已首用冻结旧profile。当前 `bind_source_index_embedding_in_tx` 的已定合同是首用冻结，未执行目标没有旧绑定。不能为这个错误前提把产品改成所有任务保存时提前冻结。

修订后的测试分别等待长文raw indexed、部分raw实际绑定旧trial并达到unknown/failed，才改变配置；重建后分别等待两项raw的真实终态。原新trial零调用、成功回执复用及原预算不变的断言保留。此修改建立了验收本来声称的前置状态，没有把未验证行为换成mock，也没有放宽预算断言。运行通过与否仍以本轮实际日志为准，本审查者没有执行该检查。

## 四条复杂度约束核对

1. 本轮原文多位置、分片失败、旧迁接次数和错误分类都有具体正常场景，不是为了理论上的极低概率事件加保护。没有发生率数据，未给概率数字。
2. 本轮没有新增分层Schema重复验证；下一包明确保留独立HTTP边界校验、删除同份SearchInput重复解析，并保留异步结束后的业务版本核验。
3. 本轮主要原位修改和删除，无新trait、策略基类或通用框架。source owner窄接口属于已确定的职责边界，不应机械归为“只用一次所以不能有接口”。
4. Rust新增错误分支只区分可信的缺失/失效与普通故障，其他错误直接传播；没有增加多层catch或自动重试。测试资源finally清理不属于产品防御层。

## 接续包与整体05状态

三个文件已经明确：05仍需前置允许记录、raw/knowledge共享候选预算与进度、每批不超过50元信息、选中不超过30的owner定点读取、正常规模和尾部反例。05真实绑定验收和当前指纹独立审查通过后停止；06不得接管这些遗漏，也不得提前默认启用工具合同2。

现有owner接口、文档多entry拼接与Unicode定位、已保存required/贡献来源、当前仅合成空间端点授权均已具体列出。没有要求补造真实企业ACL或字段出域策略。06仅在05关闭后接入公开hits/批量补读、最终支持交付、四类续读与Pi容量；新增 `supports_complete` 必须由保存来源证明，历史缺字段保持unknown。

后续真实关闭05仍需验证：统一待办迁接的原operation/trial/已知与未知回执接续、范围前置、候选预算实际停止、元信息与正文实际读取粒度、尾部/规模与索引覆盖。当前纯逻辑或协议替身结果不能替代这些证据，也不能宣称真实模型效果和真实平台接入通过。

## Oracle六项修订后的最终执行包复核

本审查者读取了 `.local/oracle-hybrid-package-20261027/answer.md`，逐项对照最终 `hybrid-retrieval.md` 和 `AGENT_PROMPT.md`，并回源检查相关runtime、knowledge与来源拼接代码。没有再次调用Oracle，没有修改产品或执行包。Oracle原结论是“需定向修订后可执行”；以下是对修订后文字的本地独立复核，不表述为Oracle已再次批准修订版。

| Oracle要求 | 最终文字与核对结果 |
| --- | --- |
| 共享1000与5轮必须在请求前约束实际工作 | 已明确5轮含首轮，最多再扩4轮；身份在失效筛除/窗口合并前计入，重复不再计、失效不返还；并发请求先合计分配剩余额度，不方便分配时顺序执行。已区分本页所需深度完成与通道穷举。没有引入通用budget类或调度器 |
| SQL词法路径不能成为第三票 | 已明确BM25成功空不触发补扫，只有明确未配置/故障才选择后备词法；后备SQL来源先统一含义再形成一条排名，不与BM25/dense原始分数混比。1200弱竞争反例必须直接验证SQL路径，不能由dense救回掩盖 |
| deadline覆盖三个许可/发送时点，实际保留词法正文 | 已明确许可前停止、本次许可后确认未发送零消耗收尾、已发送沿实际/unknown结算；不取消账本收尾，不修改后台索引期限。验收检查最终可交付词法正文，候选ID不冒称交付，也不延长期限补做 |
| 按真实API区分轻量头与候选窄读，保持文档定位 | `current_enabled_heads_in_tx`正确写为空间头信息；`current_versions_in_tx`允许调用方传≤50；anchor和已映射依赖不旁路装配body。多entry按原数组顺序，保留空字符串、跳过非字符串、双换行拼接，与当前 `document_source` 一致；合并窗口不沿用错误子窗口hash |
| 原attempt查询先于当前配置绑定，并明确接续分支 | 已明确先确定旧operation/attempt/参数，再经runtime owner查询；未发送、成功、unknown、冲突/不可恢复分别处理。不得先改绑当前trial，旧schema没有完整profile就不补造；unknown可以正确保持unknown，不新增查证成功义务 |
| 覆盖范围不能按问句主题猜测 | 已明确以实际空间、硬过滤、显式来源限制、可交付种类、修订和集合代次决定覆盖；A/B均在范围内时不能因只问A而隐去B的lag，v1未查询raw也不混入raw覆盖。反例同时覆盖显式排除B与范围仍含A/B两种情况 |

六项均已覆盖，未发现新的执行包阻断歧义。这些是原合同的实现条件和可观察反例，没有额外建立ACL、任务框架、结算服务、持久检索会话或重试系统。05关闭后停止、06只消费实际存在内部接口的边界保持。

### 本次许可已提交、尚未发送时的零消耗收尾

该方案与已核实合同不冲突，依据如下：

- `docs/semantic-retrieval-design.md` 第19.8.5明确规定未知保留预留，只有“已确认未发出才释放”。本分支依赖本次执行栈确知发送函数尚未被调用，不能从历史issued/unknown记录或缺usage倒推出未发送。
- `packages/contracts/schema.json::ModelUsage` 允许 `input_tokens=0`、`output_tokens=0`；这可以表示宿主确知未发生模型消耗，不需要伪造供应商回执。
- `runtime/provider_calls/store.rs::finish_in_tx` 已核原attempt/operation/参数绑定，支持issued/unknown以已知用量结算。零输入输出得到actual=0，原事务扣回该attempt的金额预留并保存settled；不会回退 `allocated_calls` 或 `issued_calls`，不会新授予发送许可。
- 本分支不写 `response_json` 向量缓存，不把结算成功当作Embedding成功；后续不能用原attempt再发送。既有 `cached_embedding_in_tx` 对无成功向量的settled行返回不可用，并不会当作新的首发机会。

因此可在本次新许可确认尚未发送的确定分支复用原finish路径，无须新建not_sent状态机。未来实现仍须用真实runtime/MySQL与本地协议替身证明该时点、零发送、预留释放而次数不退、无成功缓存；当前审查只确认执行方案及现有接口能力，不宣称新分支已经实现或验收。

### 最终运行证据的归属

主实施者提供的本轮结果为：35项检索单测、584项双侧合同、fmt/clippy/types/web、架构与锁检查、七项定向回归、共享索引四个Rust测试（含三次耗尽的RED/GREEN）、`verify-shared-embedding`，以及补入两条raw旧profile显式断言后的整脚本重跑均exit 0。本审查者核对了两条profile断言确实存在，但没有运行上述检查，也没有把它们表述为亲自取得的执行证据。

这些证据支持本轮有限纠偏收尾；整体05继续active。最终图册源指纹一致且本轮没有产品拓扑变更，为主实施者提供的检查结论；本次执行包复核没有新增图或架构模块。

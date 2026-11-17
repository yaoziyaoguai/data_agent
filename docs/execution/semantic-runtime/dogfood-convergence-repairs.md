# 09 整体问题连续修复执行包

本包保存上一轮实施规格。其主要工程已有对应收据，当前后续任务见[剩余问题执行包](dogfood-followup-repairs.md)及[CURRENT](../../CURRENT.md)，按实际影响复用本包结果。

编包日期：2026-11-05。基线：`codex/semantic-maintenance-prototype`，HEAD `04d27d06ba7b97d4cf3e288d4cf9e6300ef491a9`。这是待实施的规格，不是通过报告。唯一进度在 [CURRENT](../../CURRENT.md)；根因依据是 [09整体审计](../../reviews/dogfood-whole-phase-root-cause-audit-20261104.md)。本包取代旧[核心修复包](dogfood-core-repairs.md)的“下一步”，保留其中有效不变量和历史证据，不重做已经修好的事项。

## 1. 启动入口、顺序和出口

启动必读：AGENTS、CURRENT最新摘要及`delivery.increment`、本包1–3节。进入某项才读对应任务节及列出的源码/证据；历史报告按疑点查，不先加载九个旧包、全部attempt或完整wire。

仍属`I3-SEMANTIC-DOGFOOD`，不重开01–08，不把case编号变成新业务模块。连续顺序：

| 顺序 | 工作 | 可观察成果 | 要求/owner |
| --- | --- | --- | --- |
| 1 | 核当前证据与接口（第4节） | 旧问题/当前缺口/已修项不混淆，实际修改边界明确 | C07；原09映射 |
| 2 | 答案提交保存读取绑定（第5节） | 新答案不靠正文相等或Markdown反推来源；旧答案仍可回看 | D02/D03/D09、C02/C05/C07；runtime、task_answers、finish_run |
| 3 | 已加载历史的权限刷新（第6节） | 无新增事件也能在正常刷新后隐藏/恢复相应正文，旧页也覆盖 | D02/D03、C02/C08；read_conversation、API、Workbench |
| 4 | 澄清与采纳状态收敛（第7节） | 回答一个问题只解决该决定，其他问题保留；没有第二份可写未决列表 | D09、C03/C04/C05/C07；analysis、query_semantics、Pi工具 |
| 5 | 已批准共享语义和SQL依据（第8节） | 口径可复用；子事实快照和真实零判断有正确依据 | D04/D06、C03/C06/C07；现有语义资料、检索/交付接缝 |
| 6 | 有界验证、文档和交付（第9–11节） | 修复有证据，真实效果及遗留分别交付 | 09核心原要求；不扩大试用 |

每项完成更新CURRENT后自动进入下一项，不等用户逐项批准。能独立继续的工作不停；费用/业务范围确有阻塞时只暂停依赖部分。共享Schema、Rust组合入口、Pi交付入口及CURRENT由同一实施owner顺序整合。

**两种完成不能混淆：** 本包工程修复和相称验证可以完成；09只有原21核心项、已授权来源轨迹及必要工程/独审出口都满足才关闭。不能承诺模型永不犯错，不能用mock、规格审查或构建代替真实效果。

## 2. 约束、授权与禁止事项

- 保留继承未提交工作。整仓HEAD diff不是本轮diff；开工记录受影响文件指纹和局部基线。禁止reset、覆盖旧结果、清库、换实验ID或换账本补额。
- Pi 1.3.0仍是唯一Agent循环、会话、压缩、恢复与取消实现；不升级SDK、不新增LLM问题改写、答案裁判、SQL修补器或规划器。24次/消息、连续临时失败3次、原operation/origin/budget/output身份不变。
- **真实模型可用。** 用户2026-11-05再次澄清：沿用已授权的DeepSeek、语义整理模型、Embedding及Mem0，完成必要真实验证；不新增测试累计费用门槛，不逐题/逐批重新请求付费授权。保持同一09隔离实例、已批准配置和账本身份及完整已用费用；用户已批准到09结束的执行窗口继续有效，不能因默认期限机械重复审批。未知副作用先查证不重发；若实际供应商硬额度或现行账本金额/次数确已耗尽，报具体事实，不换ID绕过，不能把默认过期误称新业务未授权。更换付费服务或实质扩大范围才另行确认。本包不授权提交、推送、部署或日常服务更新。工程harness用合成隔离库，不误用主库。
- 不跑完100项/十轨迹；当前固定21+1仅用于证明范围，不是全部重新运行清单。保留原题、原断言、原fail/unknown及费用。新增事实前提的新attempt独立注明，不能倒改原成绩。
- **防过度防御：** 新保护必须对应本包已证反例、明确合同或普通可达风险。推测的低概率/并发情形只记触发、证据、代价并请求用户决定，不编概率、不自行建设保护。
- **边界一次校验：** 外部请求/持久格式解码在真实边界校验；同一内部值走生成类型。外部权限调用后的状态重核、历史读取授权仍保留，不能以“只校验一次”删除。
- **不早抽象：** 单用简单逻辑就地处理；只有owner边界、真实复用或明显复杂度隔离才抽取。替换职责同时删除新路径旧旁路；不建通用决策引擎、投影框架、权限总线、缓存平台或repository层。
- **控制流程：** catch只做可解释的恢复、边界翻译或资源清理；不吞错返回成功/空结果，不层层重复catch/重试。
- 测试以现有接缝和已证反例为主，不按类型/状态笛卡尔积铺矩阵，不做实现细节断言，不为删冗余文字造测试。变更前最小RED，变更后GREEN及实际影响回归；源码不变不重建、通过且未受影响不重跑。
- 实现名称用业务含义；本包序号、G08/T02等只能出现在计划/证据说明，不进入产品分支、类型、函数、数据库名或新测试名。

## 3. 已确认决定与保留项

用户2026-11-05明确批准以下**公开合成资料**口径，不能宣称真实公司通用规则：

1. 轮次或轮次成功率分析中，“语言”默认取`turn.locale`，不是`session.locale`。显式分析会话语言、已采用会话条件或用户指定其他粒度时尊重原选择；两者不宣称相等。
2. “重试救回占比”：有效且有ASR尝试的轮次中，首次未成功、最终成功且存在后续尝试的轮次数 / 全部有ASR尝试的有效轮次数。首次就回退且成功不算这项救回，另行说明，不偷偷并入分子；未请求时不另加指标卡。首次/最终按快照内最小/最大`attempt_no`，既有质量/车辆/完整会话范围保持，零分母NULL。
3. 未另指定的“平均候选数”：按最终成功尝试平均，成功但零候选计0；最终失败/取消/超时不进入该平均总体。ASR最终成功率仍按原有全部有尝试轮次分母，两种统计总体必须各自说明，不能用候选JOIN改变成功率分母。
4. 省略年份优先沿用本任务已确定年份；没有时，只在相关且已获准读取的资料能唯一确定分析年份时采用并说明。仍不唯一则只登记一个该问题并复用等待状态；不能反复问已答年份、从系统当前年或题号硬填2026。“只问一次”不是永远禁止在用户改目标或产生新冲突后澄清。

保留既有：普通语义改版不抹掉旧分析；历史读取撤权/停用/删除和结果TTL按各自现有合同；新分析用当前来源。来源不足不能自动扩权；原来源轨迹fail与三个车辆字段获准后的独立成功轨迹都保留。

## 4. 接手核对：只修当前缺口

先读整体审计第1–4节，按其问题台账核CURRENT及对应实际代码，不重新审完所有01–08。已有记忆修订/unknown保护、游标gzip、来源身份、source_limits:null、Pi isError回执、准备租约、首次冻结来源、目录轮询等修复继续复用；不把这些再列成待实现。

更新CURRENT的当前诊断（不是改历史attempt）：核心现有15pass/4partial/1fail/1not_run只是原记录；G08虽记pass，增量刷新已证缺口仍开放；T02最新attempt没有split，不能用早次拆分证明当前行为；S03不能继续写“缺S01”，已有较新S01/S02证据。`quality-and-coverage.json`和运行HANDOFF仅同步实际已核事实，保留原attempt和时间。

待修接口表（先改同源合同，再实现/生成消费者）：

| 接口/数据 | 现状问题 | 本包变化 | 兼容约束 |
| --- | --- | --- | --- |
| `finish_run`→runtime持久输出 | 只给部分组合保存引用，单份/控制输出读时反推 | Rust构造并原子保存有序读取绑定 | 不让Node/模型提交权限凭证，不改原commit/operation身份 |
| snapshot→`mergeSnapshot` | after_seq无新事件，已加载正文永不更新 | 增量事件与已加载输出的当前投影分别表达 | 原GET/SSE保留；旧消费者不接收不认识的新字段 |
| `AnalysisUpdate`/Conditions→draft | clarified状态和字符串未决列表独立可写 | 开放问题为唯一当前阻断事实，采纳记录单独表达；一次修订 | 旧持久状态/已登记工具按原合同，不清掉旧未决 |
| 文档→整理/索引→工具回执 | 默认未定、一般规则可能未被交付/应用 | 已批准共享定义+通用样例，按真实交付链判责 | 不注入参考答案，不悄悄改变原来源许可 |

完整问题台账的处置不得遗漏：

| 审计发现 | 本包处置/出口 |
| --- | --- |
| G08全量读取保护已有、普通增量缓存未闭合；读时逆向绑定 | 第5–6节修复；保旧snapshot/SSE与TTL行为 |
| T02旧未决与resolved矛盾、最新未拆分；A03缺前置 | 第7节接口修复及第9节真实T02→A03，不能拿旧拆分/人工稿代证 |
| S03语言、J06救回、J01候选平均及重复询问、T02年份 | 第3/8节已批准共用定义，分别保真实歧义和已答不重问 |
| J19子事实快照错误、真实零证据不够 | 第8.2节两个普通反例；追规则实际交付，不新建SQL守卫 |
| 旧attempt/最新诊断混用、原评分前提不一致 | 第4/9.3节订正当前诊断；新口径新参考保留旧记录 |
| P05额外量化误差推断、P08/A08未出稿 | 非核心已知缺口继续登记；无宿主通用原因证据，不新增数学裁判或刷这几题；本包不得宣称已修 |
| S04/G02未触发复合断言 | 后置保持未覆盖，不改题/删断言获得pass |
| API PoolTimedOut、首次失租、8193差额、旧启动超时 | 第11节保未定因；不无现场无限调查，不新增保护框架 |
| 09已经修复的v2接线/游标/来源/记忆/锁/租约/提示/回执/轮询 | 整体审计第2节逐项保留证据与影响判断；本轮无相关改动就复用，不能以年代久自动作废 |

`packages/contracts/schema.json`为跨边界真源；HTTP同步`packages/contracts/openapi.json`，生成Rust/TS。持久JSON解码也有明确格式；同进程内组合返回值可用Rust类型，不为其新增网络Schema。

## 5. 在正式提交时保存答案读取绑定

### 5.1 当前任务必读

`use_cases/finish_run.rs::finish_run`、`task_answers.rs::compose_in_tx`/`original_text_in_tx`、`analysis_answers.rs`；`modules/runtime/outputs.rs`的`OutputReadBinding`和`output_read_units_in_tx`，runtime私有store的输出读写；`read_conversation.rs::protect_output_events`；Schema中的`AnswerPartReference`/`AssistantOutputBinding`。根因报告3.2及既有`check-grounded-answers.mjs`、`check-task-query-answers.mjs`、`check-task-answer-recovery.mjs`按需读。

### 5.2 写入合同

沿现有runtime owner给`assistant_outputs`加一个可空JSON列（建议名`read_binding`），**只为这项职责加一个持久格式，不建新台账**。旧行NULL走旧读取兼容；新提交必须有绑定。对象包含`schema:1`和有序`units`；每项保存：

- 在完整`final_text`中的`start_byte`/`end_byte`半开范围，覆盖该份标题与正文；分隔符由现有组合逻辑确定，不靠读取时拆Markdown。UTF-8字节范围仅在Rust内部消费，写时由实际拼接得到并保证字符边界；不和JS的UTF-16长度混用。
- 该份正文/标题的原authority、实际`query_id/result_ref`依赖；复用已核`AnswerPartReference`、handoff/成功答案回执及原字段authority，不拿最后run的来源并集替代其他已冻结份。
- 需要回读流式片段时保存原`attempt_id`及chunk范围，复用`AssistantOutputBinding`已有身份。单份来源答案保存其成功回执身份；控制输出保存其原控制投影来源；普通自然final保存提交时已核的实际上下文来源。

由Rust现有核验/组合过程产出`final_text + read_binding`，与原commit、checkpoint、assistant_committed同事务。`compose_in_tx`可改为私有类型返回正文和单元，不先生成正文、随后再解析一次。FinishRun的客户端参数不用因此扩出一个可伪造authority字段。仍沿原Unicode字符容量计算；字节定位不是缩小或扩大内容上限。

各提交分支的来源固定如下，不能只改组合分支：

| 提交分支 | 绑定构造时采用的事实 |
| --- | --- |
| `answer_sdk_tool_call_id`单答案 | 本次已核成功`present_analysis_answer`回执的原query/result依赖、该输出的实际来源及chunk身份；提交时正文相等校验继续保留，删除的是读时全链猜匹配 |
| 冻结A＋末项B或多个冻结项 | 每项原`AnswerPartReference`、handoff及已核正文，使用各自来源；拼接同时记录范围，不拿末项上下文覆盖A |
| 冻结A＋控制尾项 | A沿冻结来源；尾项用已存`control_delivery.text_authority`及其任务引用，不能因为是宿主文字就默认公开 |
| 无工具引用的自然final | 已核本次输出实际上下文来源与流式范围；保现有整体来源粒度，不新增逐句追踪，不污染其他已冻结份 |
| 组合标题 | 与实际拼入标题对应的任务字段来源及版本；冻结标题沿冻结时来源，末项标题沿本次实际采用的字段。宿主固定标签不虚构字段来源。可合并进该份单元所需authority，不读时换成当前标题或新增逐标题展示机制 |

除组合器固定的分隔字面量外，全部实际展示字节都由有序单元覆盖；标题、换行及正文不能出现未归属片段。完整可读时重建结果必须与已存`final_text`逐字一致。

同一提交重放取原已存结果；不重新采用当前任务标题/来源、不重组旧文。单答案、冻结A+末项B、冻结A+控制尾项都覆盖。控制尾项若现有合同只有整体authority，本轮保持该实际边界，不无证拆成新的逐句权限系统。

### 5.3 读取与删除

新绑定按持久边界解码后直接建立`OutputReadBinding`，不再扫描同恢复链全部工具回执做`answer_text == final_text`，也不按标题/前后缀推导边界。旧NULL行保留一个窄兼容入口，复用现有实际可支持路径；不批量回填历史，不加更多猜测匹配。无法证明来源时沿原不可读投影，不能回退成公开文本。

仅NULL表示旧格式；非NULL格式错误不能降成“无来源自然文本”。权限/TTL继续经过`read_conversation::read_output_authorities_in_tx`和`context_authority::{CheckedTextResults::include_history,allows_history,validate_history_in_tx}`：合并原query的text_authority与结果依赖，检查来源/会话当前可读；历史正文不因结果明细TTL到期被清空，图表/明细读取仍按原到期合同。已有`check-task-query-answers.mjs --history-permissions`与`check-historical-source-access.mjs`分别有组合正文/报告的TTL断言，按实际改动复用，不把仅存`result_ref`称为完成TTL验证。

read_conversation锁外查平台权限前取得绑定，回来后保留必要的当前状态/来源有效性重核。已提交绑定不可变时不重复做完整重建；活跃未提交输出仍按原状态读取，不假定它与committed同样不可变。不把外部请求放进持锁事务。

删的是**新格式路径的逆向重建与重复装配**，不是删授权检查。普通语义改版/结果TTL的历史展示合同不改；永久内容不清空。Schema迁移只新增列，旧程序读旧列仍可用；新writer启用前完成迁移，不安排线上部署。

### 5.4 最少验收

扩展现有答案/历史脚本，共用fixture覆盖上表实际不同提交分支；标题有独立来源，正文含中文、emoji和原分隔符仍逐份准确；撤权仅隐藏依赖份，恢复原文逐字一致；旧NULL绑定能读；commit重放/原恢复链仍有效。TTL复用原断言，不复制大矩阵。一个新绑定读取测试可在既有测试接缝证明无需链回执扫描，不靠全文源码字符串断言。不能为此向产品加专用fault开关或监控计数；没有便宜可用的接缝时由源码审查证明路径，功能回归照常。

## 6. 正常增量刷新更新所有已加载输出

### 6.1 接口

必读`Workbench.tsx`的refresh/loadOlder、`conversation-timeline.ts::mergeSnapshot/projectMessages`、`routes.rs::snapshot`、conversations事件分页store、`read_conversation.rs`。已有本地失败反例在`.local/checks/dogfood-convergence-audit-20261104-223601/history-incremental-cache-probe.json`。

保留现有GET快照和SSE；为带已加载状态的读取在**同一个snapshot资源增加POST**，复用同一read_page业务操作，不新建历史服务。请求Schema `SnapshotRequest`：

- `before_seq`或`after_seq`至多一个，仍是十进制字符串；省略沿现有首次页语义。
- `loaded_outputs`：客户端已缓存的输出片段，元素为`attempt_id`、实际已读连续事件区间中的`first_event_seq/last_event_seq`、可选`projection_fingerprint`。客户端不能传source、authority或readable=true等授权结论。范围来自所有已加载页，不仅可视区/最新页；同attempt有未加载区间时保留分段，只合并已证重叠/相邻的已读区间，不用min/max吞掉空洞。先核现有分页是否始终连续，连续时用一个范围即可，不为假想跳页增加功能。
- fingerprint只表达该缓存投影的内容版本，不能授读取权。省略时服务端返回该片段当前完整投影；权限状态仍每次由服务端核对。不要另加全局权限epoch。

POST响应使用同源Schema定义的`SnapshotRefresh`，复用原`Snapshot`各字段并增加`output_projections`；不改变旧GET的严格形状。对每个请求范围明确返回一项，回显attempt和first/last，带当前输出状态、fingerprint及`unchanged|replace|not_available`结果：

- `unchanged`：已核当前可读投影，fingerprint相同；不传正文，保该范围缓存。
- `replace`：fingerprint变化或请求未提供；返回该范围内**完整替换用的assistant事件**，空数组也是明确替换，不代表请求未处理。
- `not_available`：缺失或不属于当前会话，对两者返回同一种结果，不泄漏其他会话身份；客户端移除该请求范围缓存的对应assistant投影。正常撤权仍是`replace`且沿原受限占位，不混为对象不存在。

fingerprint包含会话/attempt、范围、当前状态和事件序列，不能跨范围复用；服务端先核归属/当前可读性再比较。新分页events与已加载投影合并需要检查的attempt，走同一次共同读取投影流程，不能各取一套权限结果再混拼。投影不追加新持久事件，不推进event cursor；相同attempt多范围规范化仅按上述已读区间含义，不把客户端范围当授权。

投影生成直接使用第5节相同读取逻辑。fingerprint由实际当前投影（含状态/被隐藏文字）生成，不能复用事件序号。不为本次另设低小固定历史上限、静默截断旧页或每次重读全对话。沿现有HTTP请求大小约束（当前API为512 KiB，与模型8 MiB请求限制不同，不混用）；普通已加载页一次提交，若实际证据证明需要分批才设计分批，禁止先造分片协议。

旧GET响应不带新字段，保证现有严格解码消费者；新POST消费者与API一次兼容发布。Schema/OpenAPI、Rust入口、TS api调用与mock同步。SSE新读/重放仍用原投影owner，本轮不添加推送权限事件总线。

### 6.2 前端合并

1. 先合并普通分页events；对`replace/not_available`按attempt和响应回显范围删除旧assistant事件，再放入替换事件；`unchanged`不删除。最后统一`projectMessages`。不能只改messages，因为下一轮会从events复活旧正文。
2. 已提交/被替代attempt必须保留状态，使旧delta不能拼回被隐藏正文；读取返回的restricted占位沿已有文案。替换不永久删除服务器原文。
3. 已加载旧页一起刷新；没有新event也必须处理投影。翻页游标按服务端实际读取的分页first/last及has_older/has_newer合并，独立于展示事件增删；仅投影变化不推进或回退游标，不因隐藏后数组变短重复加载/漏页，不动用户消息或未加载区间。
4. 恢复权限后相同事件原文可恢复；来源无变化时不重复发送大正文。当前refresh有局部refreshing标记，但loadOlder独立请求，普通操作确可重叠。组件内让首次页、轮询与loadOlder共用一个snapshot读取门：前次响应合并完成后才捕获下一次范围/fingerprint并发起，轮询只合并一个待刷新意图。无需全局队列或额外重试；QueryList等无关请求不串行化，其失败不应丢弃已成功的snapshot。保既有换会话generation检查，响应只替换回显范围，不删除该范围外事件。

### 6.3 最少验收

优先`check-conversation-timeline.mjs`扩现有离线反例，再复用`check-history-browser.mjs`/`check-grounded-answers.mjs`已有合法答案和权限夹具：打开两页→撤权、不追加会话事件→正常轮询→旧新页对应份隐藏、无关份保留→恢复→正常轮询原文恢复。浏览器不手动刷新、不清空snapshot绕过问题；没有新模型调用。在原timeline/请求接缝补空events仍替换、unchanged不删正文、分页与刷新按序合并、游标不随投影回退及旧delta不复活；不另做并发压力矩阵。保snapshot/SSE原回归；一条跨层流程即可，不重建G08整条模型报告。

## 7. 澄清阻断与采纳信息分责

### 7.1 保留字段，缩减职责

现状并非Rust丢写。`resolved_clarification_ids`更新成功，而`semantic_resolution.unresolved_differences/basis`按patch保留，两个表示同一未决决定的入口发生分离。本包不新增`adopted_decision`或`decision_state.adopted`让模型再维护一份对象：

- **clarifications**：唯一的当前未决状态；归analysis owner。复用ID、open/resolved、正文/来源、预览与split迁移。
- **Conditions.semantic_resolution**：保留字段名，新格式只说明已采用解释及依据，含`interpretation`、`basis=explicit_user|unambiguous`、`user_quote`、`adoption_message_id`、`evidence_refs`；不再携带可写未决数组或`needs_clarification`。这是采纳说明，不是所有任务的必填开关，也不要求每次回答重写累计解释。
- **条件版本及原来源**：保存实际条件；同次revise处理必要值变更、必要采纳信息及指定问题关闭。执行授权仍走原消息/最终SQL合同，不由问题resolved授予。

先读`analysis/store.rs::apply_update_in_tx/split_task_in_tx`、`query_semantics.rs`、`data_tools.rs`两处条件/草稿核验、Schema的Conditions/ConditionSet/ConditionPatch/QuerySemanticResolution/AnalysisUpdate及实际v2工具覆盖；不重写整个data_tools。

### 7.2 新写入与省略/null合同

同源Schema区分“新采纳说明”与只在兼容边界使用的旧形状；仍使用现有semantic_resolution字段，不以字段是否出现切换模式。由analysis owner在`condition_revisions`加一个宿主写入的`decision_state_version`（旧行默认1，新条件及明确转换后的版本写2），不允许模型set/unset它。不是新增Agent协议或决策表；旧SQL按原task/condition_version取得原格式。普通修订默认继承当前格式；仅第7.3节无旧未决的情况允许无损规范化，读取不迁移。

| 输入/状态 | 固定行为 |
| --- | --- |
| 局部patch省略semantic_resolution | 保留原说明/身份；不切格式、不关问题 |
| 新格式显式set为null或unset | 只清采纳说明，clarifications和其他条件来源保持；不等于用户同意或已经无歧义 |
| 旧格式仍有未决却set null/unset/覆盖成已决 | 不能据此消掉旧阻断；先按7.3明确转换 |
| resolved_clarification_ids省略或[] | 不关闭问题；null不是全部关闭的别名，沿明确数组合同 |
| 非空resolved IDs | 同次revise处理实际需要的条件/采纳与指定问题；允许确认原值，`set:{}`不强造值变化，不强加每次都填采纳对象 |
| 说明选项或询问“什么意思” | 沿route解释，不关闭问题；普通补充不自动解决全部问题 |
| 新任务未决定 | 只登记真实缺口到clarifications；可先检索，不要求create填假采纳 |
| 无开放问题、无旧未决且条件充分 | 可直接出稿，允许没有额外解释对象，不强迫再调用一次工具补声明 |

新草稿从目标task/condition_version继承说明和未决状态，不能借request_query另写一份独立决定；若明确需要改变已采用解释，先在同一次任务修订记录。兼容输入携带同义说明时只核对目标版本已有内容；普通无声明查询继续可用，不能借“统一采纳”缩窄原能力。

`explicit_user`的新采纳仍绑定本轮真实用户完整原话；复制旧采纳仍须与宿主已核对象一致。不接受模型随意填旧消息ID，不把读到旧原话等同已验证采纳。`unambiguous`依据已交付资料及当前条件，不伪装用户选择，不为无资料来源的普通值发明必填引用。一个说明只证明其实际选择，不让最后一句quote替所有累计条件背书。

部分回答不重写未变条件/采纳；既有字段authority和条件修订保留先前选择的来源。split复制相同条件及说明时沿原身份、原字段来源，并迁移明确列出的开放问题；不能把两轮选择重绑split消息，不能丢失源任务未移走的问题。开放问题不可读时保控制ID/不可读状态；分页只影响显示，不把未显示问题当成不存在。

### 7.3 旧任务仅做一次明确转换

兼容目标是保旧数据/原操作身份，并解除双重写入；不全库回填、不创建通用迁移框架。仅旧格式仍有未决的活动任务需要以下窄入口；旧无未决可在一次普通修订中无损规范化，原采纳不变。只有普通读取时不写库。

**已核事实：** condition_revisions保存body/field_authorities，没有历史回答证明列；clarifications保存state，却没有“由哪个操作解决”的列。runtime的tool_calls保存成功receipt、origin_run_id和原fingerprint；agent_runs绑定原message_id。成功update回执含task_id、condition_version、conditions。因此可核“这个旧版本确实由那条真实消息的成功操作产生”，但不能声称原回执已保存每项resolved ID，不能凭一个resolved状态制造新explicit_user。

转换合同：

1. `read_analysis_task`在旧未决任务上返回只读`legacy_pending`：来源condition_version及该版本未决数组的稳定索引/原文。只有basis=needs_clarification但数组为空时给一个basis遗留项，不漏掉这种原阻断。复用旧版本加索引定位，不建UUID台账或签名凭证；来源权限沿原任务读取。
2. 仅现有revise增加可选`legacy_resolution_migration`，含`from_condition_version`及各遗留项到已有clarification_id的明确links。省略不转换；null不表示清空。模型负责解释对应关系，宿主核引用和状态；不按相似文字自动认定已答。未对应项在同事务登记为开放问题，继承旧说明原来源，不静默删除。
3. 对应开放问题：保持原ID和open即可，不复制第二题。对应已解决问题：link给出实际承载已采用条件的`resolution_condition_version`及该遗留项对应的`condition_fields`，字段名复用Conditions的现有顶层字段，不新增任意JSON路径/表达式。允许确认同值，不要求值发生变化。runtime公开的窄查询按原读取权限取得同会话/任务、成功update的该版本回执与原run/message；analysis owner核回执body与原修订一致、原消息为真实用户，**仅按所指字段**核当前值及原来源仍被保留，不以完整conditions相等误拒其他字段的后续修订。links的语义对应由Pi判断，宿主核客观引用与一致性，不声称回执已记录哪些ID被关闭；analysis不直接查runtime私有表。必要历史依据随只读回执交付，模型不能造authority。继承旧explicit_user时，用所取原用户消息对采纳部分复用已有核验，并保原身份；`validate_condition_resolution`对旧未决的早退不算采纳核验通过。只能证明条件落地时保条件/字段来源，省略无法核实的采纳说明，不制造explicit_user。条件依据也不足时，关联问题保持或恢复open；未关联项沿第2项登记，不留下游离于clarifications的“待确认”标志。全部核验仅在显式转换时执行，不加证明存储或全历史扫描。
4. 本轮真实用户新回答可沿7.2原合同采纳，并在同次修订关闭指定问题，不要求先产生一个有完整采纳对象的中间版本。仍有开放问题也能转换到新格式。
5. 同事务完成对应、必要条件/采纳、问题状态与新条件版本写入，最后标记version=2；旧字符串只退出**当前**阻断，历史版本/旧稿/旧receipt不改。仅说明性模式转换不新增执行授权。
6. 已登记旧操作先按原wire核fingerprint并命中原receipt，再在业务边界解释；不得先补默认字段/删旧键而改变原operation身份。旧形状兼容解码可保留，当前新工具暴露的参数不再让模型写旧未决字段；旧任务普通修订未显式转换时仍保原阻断。新格式禁止再写回旧未决形状。

`legacy_pending`的目的仅是处理已存在的无ID字符串，不成为新任务的长期字段。新内部以analysis owner读出的明确格式类型传递，兼容逻辑不散落各use_case。历史证据核验用于旧状态转换，不在每次任务读取扫描全部工具历史；不新增决策账本、证明服务或额外模型。

### 7.4 消费者和最少验收

同步update_analysis_task参数/实际v2说明、read_analysis_task、WorkspaceContext、草稿消费、生成类型与mock；旧已登记调用和旧持久内容的合法样本仍保留。对外请求在边界校验一次，内部使用已识别格式；source_limits:null、错误details及宿主授权保持。

扩既有`check-query-semantics.mjs`与澄清/多任务测试，复用一条序列：两个旧未决→一个有真实用户操作及条件修订依据→只改无关字段后明确转换，仍只剩另一题→下一轮答完→split→按原选择出两稿。保一个basis-only旧项不被遗漏的断言；没有历史依据的resolved不能假清；旧未决早退不等于explicit_user已核，原quote/消息身份不重绑。再用普通无歧义直出稿、确认同值关闭题、patch省略保持、重复原操作不推第二版本作少量区分断言；不新建大矩阵。保现有伪造旧ID、未答不算同意、来源失效断言。

真实T02→A03另按第9节；接口通过不等于模型自主split成功。模型仍漏split时按真实轨迹判责，不人工造两稿、改mock或加case分支代替效果。

## 8. 共享语义、快照SQL和简化提示

### 8.1 资料一次补全并沿正常链路使用

只修改已批准语音定义相关文件：`docs/sources/cockpit/documents/asr-candidates.md`、`metrics-analysis.md`、`time-quality.md`、`dialogue-context.md`或实际拥有轮次locale的文档，必要的`business-guide.md`。先定位owner，不复制四份不同定义。

把第3节默认定义写成有粒度、总体、首末选择、快照和NULL边界的可复用业务段落及参数化SQL示例。不得含题号、预期数值、评分断言、实际生成答案。资料例子可展示通用救回/候选两种总体，不能把“有回退”当“首次失败后被救回”。不另建指标平台。

保持28表及实际字段/事实数据。只为新增解释/样例更新必要语义目录、manifest哈希；复用`build_catalog.py`，不重生成seed、独立参考或整套事实以迁就模型。语义参考采用当前用户批准的新定义：现有`reference/oracle_queries.py::asr_candidate_join`对全部最终尝试计算均值，与已批准的最终成功总体不同。保留该旧key/SQL/旧冻结结果；在既有ORACLES中增加业务命名的独立新key（如`final_successful_attempt_candidate_mean`），用固定原始事实按新批准定义独立计算并冻结该新增结果，不从模型SQL抄答案。原参考结果全部逐项保持；必要新增生成产物沿原reference/build工具，不建新评分器。新attempt的判分证据明确引用新key与本节批准日期；原scenarios消息/expect及原attempt成绩不改。J06旧recovered分子与新定义一致，救回占比可由既有recovered_turns/turns派生，无需改原key。若发现其他实际口径冲突先精确记录，不批量重算覆盖旧参考。

新key必须实际传入既有`grade.py --reference-key <新key> --actual <该attempt实际结果>`，并保存调用/结果；不能仅在说明中换key而仍用旧期望判分。`verify.py`会比较all_results和expected-results，新增参考只增加对应新项，逐项核旧结果未变，不另改评分引擎。

必要资料版本变化只经原手动同步→差异整理→相关索引链路，不直接写派生索引或人工塞模型上下文；仅处理变化来源。新增默认不能改旧attempt前提，新的attempt记录实际source revision与采用依据。

最小证据链保留：修改文件/修订→原同步回执→变化来源整理/索引实际可用→对应工具交付的片段与修订→新attempt采用关系。文件改了或索引任务入队不等于模型已拿到定义；不用整篇全文注入替代定位交付。

### 8.2 J19的一般修复

用整体审计保存的原SQL与两个离线反例分辨：

- 观察快照前的主轮次，唯一TTS在快照后才接收：快照内应仍为“无可见TTS”。所有参与存在性/反存在性/计数的子事实按**自身**接收时间裁剪，先过滤再做MAX/EXISTS/JOIN，不能仅筛父表；维表不机械套不属于它的received_at。
- 无汇总行与有行全零，原COALESCE给出相同数字：这些数字不能单独证明真实零。结合实际覆盖合同或有意义的记录存在性；完整稀疏汇总可合法以缺行表示零，缺行不自动等于漏采。样本数/覆盖不足不能被0耗时或0%替代。

先对照已存模型实际工具回执：规则未被完整交付，就修对应资料定位/支持交付缺口；规则已交付而生成未应用，则修通用调查说明/共享示例并一次有界复验，明确仍可能是模型表现。不能先假定检索坏、扩大top-k/全文灌入或设每次必须额外检索。

只核该一般规则所需落点。不得建万能SQL语义验证器、给宿主拼固定SQL、强制所有查询加row_count或强制每轮模型审稿。日期参数只用于有覆盖的离线反例；原未执行示例日期错误不篡改成已执行事故。

分别保存三类结论：原SQL在反例上失败证明原问题；新资料示例在独立样本正确证明规则可执行；新模型实际生成稿在同类样本正确才证明本轮效果。禁止改写原SQL后宣称原反例GREEN，或拿资料示例冒充模型稿。

### 8.3 不必要澄清与提示收敛

J01最终ASR定义已真实交付，不再询问all-attempt/NLU来覆盖用户已选“最终”；候选平均的新增共享默认按第3节。语义明确时直接调查/出稿，真正冲突才问具体缺口。规则写在共有资源的一个原则位置，工具说明保参数、null、省略、引用和作用域含义。

合并`resources.ts`与`data-tools.ts`重复的大段来源原则，保当前v2实际覆盖和工具错误details；不删除模型恢复后需要的业务上下文，不把执行授权挪到提示。没有测量就不宣称省了多少tokens或保证模型命中率。

## 9. 验证范围与停机条件

### 9.1 工程最小证明和受影响回归

优先扩既有文件（可先在test标题查现有场景）：

| 变化 | 首要检查 | 受影响补验（有对应改动才跑） |
| --- | --- | --- |
| 提交绑定/历史读取 | `check-grounded-answers.mjs`、`check-task-query-answers.mjs` | `check-task-answer-recovery.mjs`、`check-historical-source-access.mjs`、`check-result-notification-answers.mjs` |
| 普通刷新和旧页 | `check-conversation-timeline.mjs`、`check-history-browser.mjs` | 原snapshot/SSE读取断言；实际浏览器一条撤权恢复流程 |
| 澄清/采纳 | `check-query-semantics.mjs`、`check-workflow-reliability.mjs` | `check-task-text-authority.mjs`、`check-time-roles.mjs`、`check-source-scope-equivalence.mjs`；实际Pi续接的一条原检查 |
| Schema/v2说明 | `tests/contracts/check-contracts.mjs`、`check-tool-schema.mjs` | `tests/runtime/check-request-context.mjs`、`check-answer-state.mjs`；mock实际新形状 |
| 语义资料/SQL | 目录和资料现有verify；原SQL的两个SQLite离线对照 | 相关共享SQL范式检查；不建新通用验证器 |

本表是影响映射，不要求无条件跑所有排列。开工将每项可观察出口绑定实际命令及断言；不能给没有新断言的旧绿命令冠新名称。旧有效断言保留，合同改变的预期必须记录原值/新值/批准来源/影响。

静态/工程出口复用`make verify-contracts verify-code verify-architecture`；必要材料`make verify-materials verify-delivery`。这些只在实际代码完成的连贯边界执行，不在每个文档编辑后跑。harness要读新二进制：Rust改后分别构建`data-agent-api`和`data-agent-worker`并核mtime/指纹；保留cargo缓存，不反复clean或同时重建。用现有Node版本与Docker context，数据库harness串行。

工程harness的子shell清除`DEEPSEEK_API_KEY DEEPSEEK_BASE_URL DEEPSEEK_MODEL DATA_AGENT_MODEL_PROFILE DATA_AGENT_MODEL_FAULT DATABASE_URL`，避免继承真实配置；第9.2节真实流程则加载同一09获准配置，不能照此清空模型配置后宣称无法实测。两类均不打印凭据。具体命令先核本机工具，不能因历史路径失效自行装基础设施。

### 9.2 真实效果仅补受影响部分

沿已获准的真实模型及辅助端点，先用一个受影响核心流程做代表样本，再继续必要链；这一步应实际运行，不因“付费”默认跳过或重新逐批审批：

- G08：原合法报告/答案回读即可，零新增模型请求。
- S03：沿原S01条件和原消息，不重跑不受影响S01/S02；新资料只验证正确locale、其余条件/未执行状态保持。
- T02三条原消息→确有两稿后才A03：按原九月/八月、两个任务/条件、原授权执行和组合，不人工造稿。
- J01/J06：用新共享定义避免假歧义，保原题/原执行指令、真实生成SQL及一对多分母核对。
- J19：原输入不执行，保存原模型SQL并用离线有区分力样本评估快照和零/缺测；不能将工程SQL范例冒充模型稿。

每个场景一次新attempt。只有新证据指出可修的一般原因且已实际修改后，才对受影响部分再试；同根因无新信息不继续刷。不重跑既有Mem0生命周期或公共Skill；如果本包真实触及其调用/来源语义，明确影响后再用最小已有证据核对。相关共享文档更新可能使原证据前提改变，按内容影响判定，不简单看哈希不同就全废。

### 9.3 评测前提不能悄改

J19原题没请求比例，原expect却含零分母比例；S04/G02同类未触发问题保留。原题新attempt若自然交付足以覆盖原断言，可按真实证据评价；否则不得为获得100%绿格删断言、向产品塞expect或借别题算pass。先证明本包实际SQL/展示修复；原未触发断言仍记未覆盖。若要用补充提问覆盖，先给用户具体新增输入、原/新预期及评分影响，只在明确批准后作为新attempt/补充证据；这不阻塞其他工程工作，也不强行关闭09。

原核心固定gate沿`dogfood-core-repairs.md`第7节及CURRENT两条命令；不改grade使partial算pass。只有对应真实证据都具备才运行最终gate。保存历史原来源轨迹fail，调整车辆前提后的轨迹按现行同一独立文件判断。

## 10. 文档、审查和冻结

实施后同步实际受影响的`implementation-design.md`（澄清、交付、历史读取相关节）、系统设计19.6附近决策说明、Schema/OpenAPI说明、README完成度、09当前缺口。这里只是待实施规格，不能在代码完成前把方案图标为已实现。

相应图源只改：答案提交→持久绑定→历史读取→页面投影；澄清→同次条件/采纳→草稿。模块owner不变，不重画全部架构或原型，不新增第四主入口。图若表达原来的错误数据归属，修对应源并生成相关图；图意未变不刷无关SVG。

CURRENT仍为唯一进度：启动时加入本包实际允许路径（包括必要`migrations`及语义资料）和验收，保原09映射、状态active/独审pending/evidence=null；不因计划写完领收据。新增路径必须可追到本包具体责任，不扩大成任意全仓修改许可。

实现冻结后一次有范围的独立审查：未参与实施者核实际diff、同源接口、旧状态恢复、上述反例和四条编程规则。审查结论/`scope_sha256`按既有格式，不自写他人passed。只有后续变更影响证据才补审。`verify-delivery`只验证记录；全部当前绑定验收实际通过才可`verify-increment`关闭。核心仍partial、未覆盖或存在具体外部阻塞时交付已完成修复及准确缺口，不反复运行已知必败的总gate。

## 11. 保留的未知与交接报告

不重新漫长追查历史API PoolTimedOut、S05首次失租、8193/8192差额、旧启动超时；过去有限调查结论仍是未定因，不能归Defender或因后续正常而宣称解决。若当前正常必要路径再现，保现场后针对新原因处理，不把后置压力组合搬回本包。

本包明确删除/收敛目标：新输出读时逆向重建、重复装配；新决策路径独立可写未决字符串；资源和工具重复原则。不得再把已撤掉的定制cursor字典、内部Schema重复校验、恒等epoch或90秒启动窗口当新清理任务。

最终报告逐项写：修了什么/删了什么、实际接口和迁移、验证环境与版本、真实效果及未验证项、仍需用户决定的具体点。原型无新能力；Pi/MySQL/Milvus/Mem0选择不变。完成授权部分后停止，不自动提交、推送、部署或扩试用。

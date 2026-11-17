# 真实任务续接修复与试用交付执行包

当前接续已转至[查询准备与试用收尾包](query-submission-repairs.md)。本包§4–6产品修改及消费者/v2验证已完成，默认v1未闭合的原因另有诊断；不要从本包开头重做。新包工程完成后仍沿本包§7–8做有限真实代表与交付，实际状态只看[CURRENT](../../CURRENT.md)。

编包日期：2026-11-09至10。已完成本地核对和两轮Oracle最高5/5交叉审查；第一轮答复由用户复制归档，第二轮自动取得“小修后可实施”，四项必要修订已纳入本包，处置见 [审计记录](../../reviews/interaction-trial-readiness-audit-20261109.md)。本包保存审定的实施和验收规格；代码、证据与未闭合回归的唯一当前状态见 [CURRENT](../../CURRENT.md)，限定实施审查见[审查记录](../../reviews/interaction-continuation-implementation-review-20261110.md)。规格或局部检查通过不代表工程、真实模型或09整体通过。

## 1. 入口、目标和顺序

启动只读根 `AGENTS.md`、CURRENT frontmatter及最新摘要、本包§1–3。每进入一个任务再展开对应代码和检查，不加载全部历史九包。基线为 `codex/semantic-maintenance-prototype` / `04d27d0` 加现有未提交工作；接手重新核对，保留全部继承修改，不reset。

沿 `dev_co` 的接续/交付方法；涉及共享字段时用 `contract-first`，继续以 `packages/contracts/schema.json` 为唯一源。具体行为先给最小失败反例，再改代码；不要为文档字句和简单接线增加实现镜像测试。

目标是修通普通用户消息的 **已有任务 → 正确来源准入 → 核对草稿 → 明确执行 → 一次提交 → 原结果自动解释**。先完成工程闭环，再完成一条有限真实代表，通过后至多一条同任务原结果续接。未成功时准确定位并停止受影响付费分支，不为了取得绿色继续重复。

顺序：

| 任务 | 可观察结果 | 落点与入口 |
| --- | --- | --- |
| 统一执行与来源合同 | 模型说明、活动工具和Rust接受的前提一致；批量授权仍原子 | §4；resources、data-tools、正式设计 |
| 补齐安全控制投影 | 实际provider payload收到可行动的拒绝信息，不泄漏旧正文 | §5；task-projection、原拒绝回执 |
| 证明生产接线与兼容 | 同一Pi活动工具门参与测试；v1/v2按各自合同验证 | §6；两个既有测试接缝 |
| 有限真实验收与交付 | 不代替模型操作；结果、正文、历史和费用分别有据 | §7–8；现有harness和正常消息API |

这些是文档导航，禁止把任务号、包号或临时阶段名写入产品和测试名称。

## 2. 继承事实和范围

上一轮六组交互修复已经有相应工程证据；最新13份核心产品/合同文件与其收尾指纹一致。不要重做流式渲染、数值准备、保存尾项、短游标、Pi context edit或模块拆分。其原实现包为 [interaction-delivery-repairs](interaction-delivery-repairs.md)，只在相关疑点需要时按章节读取。

后续真实代表的配置和SQL独立验证已核实，但执行消息遇到2次SDK未知工具、6次Rust `task_context_required`，平台提交0，结果解释和后续续接均未完成。最后模型clarify使条件变为2，原草稿superseded。**这不是仍然只差延长账本，也不能继续归因于模型收到恢复提示后不遵守。** 生产投影实际上删掉了hint/recovery。

允许修改范围：

- 产品主要是 `apps/agent/session/task-projection.ts`、`apps/agent/session/resources.ts`、`apps/agent/tools/data-tools.ts`；仅在生产接线确需调整时改同目录 `deliver.ts`，不能借机拆重写。
- `crates/data-agent/src/use_cases/data_tools.rs` 只在现有固定恢复指导需要与合同同步时局部修改。`query_workflow.rs`、`source_limits.rs`、analysis的恢复状态是核对入口；默认不修改其权限、来源、事务或状态规则。
- 测试主要复用 `tests/runtime/check-request-context.mjs` 与 `tests/mvp/check-conversational-query.mjs`。既有测试因说明变化被合理影响时，记录原因后做必要调整，不批量改变脚本预期。
- 同源Schema及生成产物只在确实新增/改变跨边界形状时修改。本包优先沿用已有字段与工具，不要求新协议、迁移或新API。
- 更新 CURRENT、审查记录、执行目录入口、相关设计段落和交接Prompt。无需重新绘制无变化的架构图，不增第二套当前计划。

不做：OpenAI代理/网络接入、更换模型/档位、缩减原容量、索引/召回重排、业务语义改造、UI重设计、通用错误或恢复框架、自动重试规划器、固定执行句识别、新来源解析模型、永久游标缓存、100题/十轨迹全量重跑。09其他缺口保持原状态。

## 3. 必须保持的约束

1. Pi 1.3.0是唯一Agent/会话/压缩/取消/恢复实现。复用现有 `setActiveToolsByName`、context hooks、SessionManager与原检查点；不升级SDK或改其源码来解决本包。
2. Rust继续负责权限、来源、SQL只读、版本、原子授权、幂等和持久预算。单消息24次、连续临时失败3次、原operation/origin/output/budget身份不变。
3. 用户明确执行不要求另点按钮或再问一次相同授权。route是内部归属操作，不是给用户增加步骤，不授SQL执行权，也不自动改变条件。
4. 来源未知不得默认null；taskless route不清除已有受限来源。不把读任务、读SQL或执行工具从来源门无条件豁免。
5. 固定hint、控制身份和资料正文分开；验证外部回执的原边界保持，内部投影不再重复验证同一结构。状态、权限或信任边界变化的必要核验不属于重复防护。
6. 只修有证据的普通路径。假设性的低概率保护须先说明具体触发证据、代价及用户取舍；不编造概率。单次简单逻辑就地写，真实复用或独立职责才抽函数；无必要不加try/catch，不吞异常。
7. 原题、原SQL、原attempt、失败、费用、unknown和未发送预留均保留。不得人工执行、回滚条件、修改查询状态、重写检查点或换账本补额制造通过。
8. 本包不授权commit/push、发布或更新日常服务。真实模型沿已有且仍有效的明确授权；正常已授权调用不逐条重问。持久有效期届满或成本范围改变时，只有该实质变化需要决定。

## 4. 统一来源准入与SQL授权

采用既有v2来源准入机制，避免为“直接execute”新增豁免或隐式范围推断。已定点核对实际route写入、活动来源选择、读查询和批量确认接缝，源码依据见审计记录；运行证据由§6限定场景补齐。实施前将以下解释同步到 `resources.ts`、工具说明、系统设计§15/§19.5–19.6和实现设计的任务/来源及批量执行段落；旧文中无条件的“不先route”不能与新说明并列。

### 4.1 两种职责分别说明

- **v2本条消息来源准入**：`source_context_ready=false` 时，Pi先用控制事实或 `read_conversation(task_directory=true)` 判定目标，沿原 `update_analysis_task` route/create/revise落实当前消息与资料范围。操作成功不等于来源就绪；发生context_reset时走原刷新，仅在宿主回执/刷新确认 `source_context_ready=true` 后恢复相应工具并继续原请求。仍未知时沿既有来源裁决处理，不自动补null。普通浏览可task_id:null，已有受限活动任务沿原限制，不通过null解除。已知来源但业务口径待澄清，两者仍分开处理。
- **SQL集合的授权**：来源已就绪后，get_query核对当前SQL/参数/版本，execute_query按完整用户原话授权。批量仍一次传完整queries，在原事务核对全部项目、追加本调用新增关联并确认；任一拒绝无本调用新增确认/授权/关联。先前已成功的普通route不伪称被execute回滚。
- 不要求为了批量**授权**逐一route每个目标；读取不同目标是否需要切换活动来源，继续由已有实际来源规则决定，不能自动并集允许集。本包不改查询集合、原授权事务或各查询原预算绑定。
- v1及旧登记操作保留已实现的直接执行/原子归属合同。v2说明明确来源前提，不能拿v1的“尚未route直接execute”通过证据证明v2可直接调用隐藏工具。

这是对新来源准入与原授权事务的接线澄清。不能悄悄删除原批量原子授权保证；如果实际代码证明上述组合仍需改变用户确认的边界，记录最小反例再讨论，不自行豁免或新增协议。

### 4.2 提示写法与修改边界

以替换旧冲突句为主，不在system末尾叠加长篇“必须遵守”警告。把来源前提放在现有任务/依据段，在execute工具说明指向该前提。明确仅在宿主提供 `source_context_ready=false` 时使用该准入说明；v1缺字段不解释成false，不为说明另加版本分派框架。现有“依赖前一步ID/授权须等待成功回执”保留，避免同轮安排route与依赖它的get_query。

来源就绪后，执行已有草稿仍须get_query核对并execute；提交后结束当前轮，由已有结果通知接回读取和解释。已具备准入事实的同消息恢复或有效结果唤醒不加形式route。没有真实歧义时不能为了避开工具错误改成clarify、改条件或重造草稿。具体目标/意图继续由Pi判断，宿主不得识别“执行上面这条”等字符串后自行route或执行。

同步修改 `data_tools.rs::rejection_data_in_tx` 的 `task_context_required` 固定hint：以宿主来源就绪为继续前提，等待必要刷新，随后继续**原请求**；执行已有SQL应读回该query再execute，不能泛化成每次重新准备草稿。使用原固定指导位置替换冲突句，不加错误码解释表或新状态机。

## 5. 修复模型输入的控制信息

先在原消费者测试复现：Rust拒绝回执含固定hint/recovery，经生产 `context_with_system` 和Pi真实序列化后消失。观察目标必须是实际provider payload，不只检查formatResult、details或数据库里的原回执。

### 5.1 Rust拒绝与Pi本地错误分开

在 `task-projection.ts` 原当前输入控制投影中就地补齐：

- 对当前已校验Rust拒绝保留 `error/outcome/isError`、确有的 `new_execution_authorized=false`、与该错误对应的可信固定hint及安全恢复身份。
- 本次只补已核实的 `task_context_required` 固定hint。按原recovery结构显式选择task/query的ID、条件/草稿版本、生命周期/执行/确认状态及原有问题ID；不得透传conditions、SQL、问题文本、goal、答案、任意嵌套对象或任意外部错误详情。错误回执保持isError，不能改变source_context_ready；保留acceptReceipt遇到错误即返回的语义。
- 仅凭字段名为hint/recovery不足以断言安全。当前 `stale_knowledge` hint会拼接detail；本包不为全错误族新增净化框架。其他原错误行为保持，确需扩展须从实际消费者问题给证据。
- 来源未就绪时，`read_tool`指向尚未开放的get_query/read_analysis_task只能作为准入后的动作，不能作为立即可调用的下一步；可以在隐藏投影暂不携带该建议，固定hint先说明当前可调用的归属动作。范围就绪后沿原回执读取指导，不复制一套恢复状态机。
- Pi `Tool ... not found` 没有Rust DataToolOutcome；不得伪造operation、Rust错误码或拒绝回执。保留当前调用身份和isError，以当前宿主来源状态提供简短控制说明，可复用现有宿主控制消息；不从arguments拼恢复身份，不把任意SDK异常正文或tool arguments整体重新带入模型。原两次未知工具的实际时序尚未独立证明，不按这两个报错另改Pi分发器。

安全投影是模型输出边界的字段选择，不另做递归清洗器/运行时Schema验证层。使用已验证的回执类型；确有跨语言新字段才按同源Schema生成。不要凭上游模型输出扩充工具名单。

### 5.2 保留Pi生命周期

复用已存在的 `attachToolGate`、`acceptReceipt`、`context_reset/refresh` 接线。状态未就绪时继续隐藏必拒工具；多用途工具保留合法控制分支。只有宿主确认来源就绪后，Pi下一轮才读取恢复后的活动工具集合；route成功但scope仍未知不能解锁。错误不触发自动route、手写重试循环或新的会话。

不改原append-only历史、原拒绝回执、旧操作参数、检查点身份。原来源/Skill/记忆/摘要隐藏规则和原生压缩路径保持；不要把本次错误指导补齐变成重做压缩管理。

## 6. 相称验证与独审

### 6.1 先补两个已有接缝

`tests/runtime/check-request-context.mjs`：fixture接入与 `deliver.ts` 相同的 `projection.attachToolGate(names => session.setActiveToolsByName(names), ...)`，不要复制另一份工具暂停表作为产品逻辑。保留真实Pi循环/序列化和网络禁止，至少覆盖以下连贯行为：

1. 来源未就绪时payload不列正文/执行工具；model尝试一个隐藏工具，Pi原生拒绝，Rust工具派发次数为0；下一请求仍有可行动控制事实，无旧正文。
2. 可见 `read_conversation` 选普通正文分支被Rust拒绝。固定hint和恢复身份进入下一次实际payload，SQL/条件/旧答案哨兵不进入。
3. 同一Pi会话、同一用户消息处理中，由实际route工具调用的回执及必要的原刷新流程恢复工具，随后**实际派发**get_query/execute；不能手改ready、重建会话或只断言工具名单。route成功但宿主仍返回来源未知时仍保持收窄，错误回执也不得解锁。消费者fixture的合同替身不冒称真实Rust，真实来源状态由下述v2harness另证；mock固定选择只证明接线，不声称模型理解通过。

把旧“data恰好仅含error/outcome”断言改成上述业务内容与边界断言，在CURRENT记录原值、新值、缺陷证据和影响。不要为每个错误码排列同类测试。

`tests/mvp/check-conversational-query.mjs`：保留默认v1场景及直接执行断言。新增一个有业务含义的限定v2入口（建议 `--source-admission`，这是待实现入口，不能提前宣称可运行），复用原harness/事务检查，验证：

- 单任务来源归属成功不修改条件/草稿版本、也不授权执行；核实际回执及必要刷新返回source_context_ready=true，再读取当前SQL并用完整真实消息确认，平台恰好一次提交。
- 两个已明确无限制的合法目标都从**尚未确认的草稿**开始。先仅为读取所需route到A，核来源就绪，读A/B时不得顺便route到B；记录进入execute前的关联、确认、授权和预算基线。**先**提交“前项合法、后项版本失效”的完整集合，证明本批零新增确认/授权/关联。**随后**在同一原消息和预算下，以新的operation提交合法版本，验证各查询恰好一次平台提交。成功route保持原状，原已确认项和其他消息阻塞回归不放宽；不承诺平台跨查询原子性，不自动并集来源。

消费者接缝使用合成provider/宿主合同替身；事务接缝使用真实Rust/MySQL和合成平台，分别报告，不能写成真实模型或真实数据平台成绩。若v2跨任务路径被未预期的前置检查挡住，先给具体失败位置与真实回执，不为绿色豁免权限或扩大来源；不以已有静态核对替代这条运行证明。若需要新增fixture，沿原公共harness创建独立测试库；不触碰日常库。

### 6.2 检查顺序

先跑RED，再跑同一最小GREEN；结束一个连贯改动后跑相邻回归。记录真实退出码，后台completed不等于passed。

| 检查 | 何时必跑 | 作用 |
| --- | --- | --- |
| `node tests/runtime/check-request-context.mjs` | 投影/工具说明/fixture改动后 | 生产Pi活动工具门、真实请求payload及旧来源不泄漏 |
| `node tests/mvp/check-request-context.mjs` | 说明/Schema改变后 | 真实SDK请求容量估算及已有状态输出，零网络 |
| `node tests/mvp/check-conversational-query.mjs --source-admission` | 新v2限定入口实现后 | Rust来源准入与原单/批量执行事务 |
| `node tests/mvp/check-conversational-query.mjs` | v2入口未包含默认v1断言时，收尾执行一次 | 旧直接执行、批量授权及原身份兼容；若新入口已实际执行同一v1断言，记录证据后不重复 |
| `npm run check:types` | 本包代码收尾 | Node/React/合同类型一致 |
| `npm run contracts:check` | 共享描述或Schema改动后 | 同源生成物无漂移 |
| 原 `make verify-contracts` | Schema实质改动时 | 双侧同源合同；不因只改hint字符串重跑所有合同样本 |
| Rust fmt/clippy及API/Worker重建 | 本包Rust固定hint修改后 | 复用原命令，源码冻结后统一重建一次，再跑数据库harness；不在每条检查前重复构建 |
| `make verify-delivery` | 文档和证据收尾 | 只核记录完整性，不证明业务通过 |

默认不重跑全部verify-code/verify-runtime-flow/verify-task-scope、100题、29组或所有历史浏览器。原生压缩、流式浏览器和恢复证据在相关代码不变时按指纹/影响范围复用；若修改了deliver生命周期或压缩接线，则补相应一个既有回归，不以本包范围替代必要证明。

数据库harness串行，Rust只在源码实际变化后重建，先核二进制新鲜度。测试子shell清除 `DEEPSEEK_API_KEY/DEEPSEEK_BASE_URL/DEEPSEEK_MODEL/DATA_AGENT_MODEL_PROFILE/DATA_AGENT_MODEL_FAULT`；用原harness隔离环境，禁止日志泄密。不杀Defender等用户进程；环境故障一次诊断，别反复全量重跑。

代码完成后由未实施者做一次限定独审：只审本包差异、合同、关键payload、真实退出码和来源边界；不组织多轮审查团。主实施者不能伪造独立结论。小修按影响有界复查，普通未证建议不自动扩范围。

## 7. 一条真实代表，成功后至多一条续接

### 7.1 运行前

只在工程和限定独审完成后进入。使用现有配置管理API和验收harness，确认实际run冻结 `configured_model`、tool2、原Flash/high及1M/900k/65536/8MiB/600秒、单消息24次。配置页面保存或测试启动参数本身不是冻结证据。无需再做模型选型或为这次试验缩小容量。

沿原trial、隔离库和累计限额核对当前有效窗口、实际已用/预留。上一轮账本为33次分配、276399微美元已结、348644微美元预留；该笔未取得发送/结算证据，不能由此宣布服务商必然零费用或允许清账。这是历史核对点，不是接手可直接写回的值，实际当前值必须读回。不要清预留、换ID补额或无限延长；若窗口已过期，唯一必要授权是同账本延期，明确保全部历史和原上限，不重新询问已授权的服务本身。

旧失败会话已clarify到条件2，原稿superseded，不再按“保存SQL不变，直接续执行”的旧脚本前提操作。新增一个明确标识的修复后attempt，沿原题/独立预期，在同账本、同库以正常消息重新建立合法代表；原失败和旧query不修改。新attempt是新测量，不给原失败操作补预算，不循环开新消息直到通过。

### 7.2 成功标准

通过正常消息API让Pi自主完成，不用按钮确认、直调Rust工具、人工route或手工SQL提交。代表应证明：

1. 草稿来自获准语义且保存有效；现有独立校验器核对**本attempt实际持久化的有效草稿SQL及参数**，对照既有原题和独立预期，不要求与旧superseded稿字节相同，也不能复用旧稿校验成绩冒充新稿正确。提交、通知、prepare和刷新证据均绑定本次实际query及其task/condition/result。不能为通过修题或改答案；沿用既有通用代表，不把它当座舱质量总验收。
2. 一条明确执行消息完成来源归属、读回草稿、execute。数据库显示正确原消息/预算/查询绑定，平台代理同一查询提交恰好一次。
3. 原结果通知沿原Pi会话和原scope接回；get_query取得实际结果，prepare绑定正确query/task/condition/result，正式解释与展示chunks、最终文本、刷新读回一致。不能用草稿说明/失败说明的增长证据替代结果解释。
4. 首可读、正式完成、平台开始/完成、模型请求数分别记录；观察实际内容增长，不把进程活着、HTTP200或关键词出现当完成。

通过才补至多一条同任务原结果续接，证明不用重跑查询也能解释/补读；有真实问题需要新SQL时不得强行断言零提交，而应将该题判为不满足既定续接前提并如实说明，不能临时改题求过。

真实代表再次遇到相同task_context_required循环或新失败且没有新诊断证据时，停止该分支，保留最终provider payload的脱敏控制字段、工具轨迹和原错误。不要把临时故障恢复改为应用自建循环，不降低断言或追加全量试用。返回一个具体未解根因及证据，不能只说模型差或机器慢。

## 8. 交付和停止条件

在CURRENT分别报告：工程通过/未通过；真实代表与续接结果；实际服务是否更新；OpenAI和09其余缺口。引用可核对的日志、源码指纹、真实调用/费用/预留差值。旧“六次提示已送达模型”的归因加明确更正，原失败数据不改写。

只要09其他必须项尚缺，就保持09 `active / review pending / evidence null`，不运行全量verify-increment取得不相称关闭收据。本包完成不等于全部09、真实平台或任意模型质量通过。

当前日常入口在19173，API22780/Bridge22781及Worker为旧启动进程。若本次真实代表通过，准备候选版本、现有启动方式、端口、配置与源码/二进制身份对应；**有本次实际更新授权才操作日常服务**。没有授权则交付具体更新步骤并明确旧入口未更新，不能把磁盘新源码当运行中的新版本。隔离验收服务只清理自己启动的实例，保留共享基础设施和全部历史。

达到上述本包结果后停止。未授权服务更新是部署状态，不应阻止先完成全部已授权代码、相称验证、独审和具体交付准备。交接入口统一回CURRENT与本包，不重新从六组或九阶段开头执行。

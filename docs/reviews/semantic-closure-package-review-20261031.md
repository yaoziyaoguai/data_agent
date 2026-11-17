# 关闭后复审修复包的交叉核对

日期：2026-10-31。对象：[closure-repairs.md](../execution/semantic-runtime/closure-repairs.md)。这是**执行规格核对**，不属于产品实现独立审查，不产生实现passed收据。

## 当前结论

**草稿的Oracle交叉审查已完成，意见已回源纳入详细包；仍有R02/R07两项具体取舍待用户决定。** 本地核对后，14项问题、D1/D2和相关消费者已分入五个连贯工作项。已有架构、存储分工及Pi职责保留；没有依据要求重做01–08或新增09任务。

Oracle对送审草稿的原结论为“有条件可执行，尚不宜原样交接”。主要缺口是D1完整提交链、D2两处Node分支、R11上游支持读取及目录内容身份、窄允许路径和03/04文档影响。本地核对源码后均补入。**最终修订没有再次发送Oracle，不能将本地处置写成Oracle直接批准最终稿。** 这份规格审查也不代替未来产品实现审查。

D1/D2沿用户已确认建议，不再次征求同一授权。R02拟保单份8000、合并按已有最多24项推导；R07拟保同候选窗精确去重、跨新窗允许同身份重现。R07确实改变旧测试的跨窗保证，两项选择未到前不得改相应产品合同或旧断言。其他确定项可以在用户交付实施后继续。

## Oracle咨询与证据

| 会话 | 实际结果 |
| --- | --- |
| `semantic-closure-package-20261031` | doctor/dry-run通过；在composer就绪前跳登录页。`promptSubmitted=false`、`modelSelection=null`，无审计答复 |
| `semantic-closure-package-20261031-login` | 用户在原持久源登录后，上传前后两次核5/5、提交并完成。但答复只请求只读附件权限：提示中“不要执行命令”过宽，未产生审计结论 |
| `semantic-closure-package-20261031-readonly` | 明确允许只读5份附件，禁止项目执行/修改、联网及外部并行代理。两次核实`Power, item 5 of 5 (slider ARIA)`，已提交新会话、捕获完整审计，exit0、714.84秒 |

有效咨询发送5份公开合成资料、源码/设计摘录与执行包快照，共392292字节、wrapper估计约106.9K tokens。未发送真实业务资料或凭据，未启用外部并行代理。CLI requested model字段不作为网页实际模型证明。完整答复SHA256为`5c35a4095ab8583cd86227590b97e9ae6d0d0c20b638fd85bc77e7080432eae1`。

证据根为`.local/audits/semantic-closure-package-20261031/`：有效结果在`oracle-package-readonly-review/{oracle-answer.md,run.log,exit.json,sent-files.json,session-evidence.json}`；送审冻结材料在`oracle-package-prepared/`，它们保留送审版本，不能用后来修订覆盖。前两次证据分别在`oracle-package/`和`oracle-package-login-review/`。各自确切Chrome均已退出、临时Profile均已删除，用户的持久登录源保留。公开文档不保存私人会话链接或Profile路径。

## Oracle意见逐项处置

| 意见 | 回源与最终规格 |
| --- | --- |
| R01不能用D1豁免所有分析或统一套全run并集 | 适用正文核自己的authority；宿主控制只核控制事实和展示字段；保成功commit重放、锁外查证和提交前短事务 |
| R02消费者及旧Schema描述不全 | 已核goal上限8000、TEXT列和ChatMessage统一32000。确认后仅扩真实合并存储及assistant历史合同，删共同8000描述；保FinishRun单份/API限制。23冻结项加控制提示仍在24项推导内 |
| R03恢复构造与事务尾部缺证 | 本地核`source_preparation.rs`两处PendingBatch；应用、依赖登记、complete_batch同tx，作业settle另短事务。两处沿持久sequence，不加第二epoch |
| R04/R05只删DELETE不能完成修复 | knowledge owner区分新修订与同版派生更新；旧档不变，真实新投影重新pending，保首次profile、账本/lease，区分工作周期重试 |
| R06额外项应先保最小集合 | 已核验Mem0额外项身份不可尾删；目录保持前缀/cursor；最小集合不足明确容量，不增游标服务 |
| R07旧合同已含跨窗去重 | 采纳，移出无条件删除清单；旧cursor先把命中旧history的当前成员转入retired，再释放历史。跨新窗能力取舍明确待决，不用offset推断全局安全淘汰 |
| R08不能传空authority或只修descriptor | 按真实资产身份核来源，覆盖启动/后续派发/恢复、目录与Mem0合并；保unknown范围和未知来源，合法资产不再被整体清空 |
| R09集合与R10查询归属 | 来源排序去重即可；R10同时核answerTask/currentAnswer、deferResultAnswer、冻结part判据和commitAnswer，增加同task/version但另一query不能冒充的负控 |
| R11遗漏上游、目录内容绑定及末片含义 | `knowledge_supports.rs`须先取得最多50项元信息再选正文；按原位置续读，末片消费不等于本回执delivered。优先复用knowledge_revisions.fingerprint，补同revision支持变化反例 |
| R12–R14遗漏最终消费者事实 | SQL限制沿当前窗实际参与保留；lag与deadline分别记录，可同时成立；分片失败已有scan_progress事实，优先修v2装配，不默认扩Schema |
| D1宿主正文到Pi及FinishRun的完整链不明确 | 在WorkspaceContext/成功DataToolOutcome携可选宿主投影，用内部FinishRun引用回核，检查点与正式正文一致。操作事实稳定，不绑request_clock或实时状态变化；不造新服务/工具/账本 |
| D2有冻结项时Node仍强造末项 | 普通commit及恢复快速路径都允许已有冻结引用、无新分析末项；共用Rust义务判据。任务卡持久查询/刷新证明可见，不加ack或已读服务 |
| 允许路径及03/04影响不全 | 明列knowledge_supports、checkpoint/journal、真实历史消费者；同步03同版整理、04受限资产及05–08直接相关条款，09保持原文 |

**Pi接线的进一步本地核对：** 锁定的`@earendil-works/pi-coding-agent@1.3.0`不只有`SessionManager.appendContextEdit`。`extensions/types.d.ts`声明`agent_before_settle`可返回`context_edit`草稿；`agent-session.js::_commitBoundaryDrafts`会追加记录并刷新活动投影。因此执行包指定活动会话优先沿现有inline extension使用这个公开边界，`continue:false`不追加模型轮次；恢复无活动会话时使用原manager/检查点接口。禁止调用私有刷新函数或手写agent.state。此处是源码核实后的规格细化，尚未运行接入验证。

## 本地审包发现与处置

| 发现 | 原因与处理 |
| --- | --- |
| R02仅提前拒绝新定稿不能处理已有7998字符冻结项 | 提出单份8000、宿主合并按合法份数推导；旧冻结正文直接可组合，不增加汇总模型。此具体取舍待用户确认 |
| 删除合并8000后会撞其他consumer | 已核`assistant_outputs.final_text TEXT`与`ChatMessage.text<=32000`。包中列出专用输出迁移、按角色Schema和实际SSE/历史刷新验证；不扩大API512KiB入站限制，FinishRun仍只传单份末项 |
| R07“offset变大就能淘汰旧身份”没有一般证明 | 独立通道排名可让同身份极晚出现。提出仅保当前候选窗不重交，跨新窗允许同身份重现，不装作全查询恰一次。该具体取舍待用户确认 |
| R03换应用身份可能诱发不必要兼容框架 | 已核`apply_and_advance`应用与推进同事务，使用现有batch_sequence贯穿PendingBatch并补旧applying恢复；未证需要时不增加ID映射或epoch |
| R04/R05不能仅删除两条DELETE | 当前persist有两个无条件INSERT，会冲主键；改INSERT IGNORE又可能不推进新投影。必须在knowledge owner区分同版派生更新与新修订保存 |
| R05“所有次数永不归零”会变成新的过度限制 | 当前vector_attempts<3是投影重试门。已知终态后新内容需要新尝试周期；费用/调用账本与首次profile仍不重置，lease_epoch单调，unknown不重发 |
| R11重排输出会误推进支持游标 | 当前SupportCursor只有next/content_offset且以输出下标推进。改为最多50成员的当前目录页状态，按原位置/偏移续接，页结束即丢状态；跨页不冒称delivered |
| D1按waiting直接豁免会放行任意分析文字 | 交付必须基于宿主可核验操作/状态，不能识别句子或信任模型自报；自然/parts共用完成义务，不建立第二账本 |
| D1只替换最终UI短句会让Pi续接保留错误交付事实 | 要求正式正文、Pi持久会话、恢复事实一致；活动会话使用原生settle边界context edit，恢复接原检查点，不增加清洗器、重写模型或新账本 |
| D2仅API有问题不等于任务卡可见 | 加真实浏览器刷新与版本/权限正负控；“可见”是产品合同，不新增每轮浏览器ack或已读服务 |
| R10仅删deferResultAnswer仍会被候选过滤拦住 | 已核data-tools的answerTask来自调用前active且currentAnswer再过滤。候选需保成功回执sources，通知匹配原query/task/condition；正常任务定稿归属检查保留 |
| 50条支持测试混淆数量与字节 | 保已有两轮，再加51短支持且容量足够的独立数量反例，不能据当前裁剪条数反写期望 |
| 历史AGENT_PROMPT入口仍要求完成08验收 | 只更新文件顶部入口，明确原08已关闭、接续closure-repairs；不改历史05正文、不覆盖原收据或启动09 |

## 问题覆盖

| 审计项 | 执行包工作项 | 必需证明 |
| --- | --- | --- |
| R01自然final有效性 | 4 | 正常提交；正式停用/撤权后拒绝且不commit/consume/answered；原重放 |
| R02冻结与合并长度 | 4 | 旧7998冻结、新多份长文、字符/字节边界、输出存储/Schema/刷新 |
| R03同修订新批身份 | 5 | ready且已应用→依赖变化→新批成功；原批恢复只应用一次 |
| R04既有archive不可覆盖 | 5 | 同版current更新，旧档哈希和精确历史保持；latest-only正控 |
| R05冻结profile与待办 | 5 | A冻结/环境B或无配置、实际新投影、多个新内容周期、原账本/unknown |
| R06额外Mem0最小身份 | 6 | 实际小余量不能静默丢A；原目录进度；持久回执与Pi可见一致 |
| R07深翻页生命周期 | 7 | 累计>1000且后面有页、反序通道、同窗不重不漏、旧cursor恢复 |
| R08合法同源Skill | 6 | 已选D技能在只D时descriptor/read可用；未知/越界/未选保持拒绝 |
| R09等价来源集合 | 4 | 正式写入重复/乱序等价集合；不同与unknown仍拒绝 |
| R10原查询通知 | 4 | 实际Node route后及恢复，旧query/condition交付且新任务不推进 |
| R11短支持优先 | 6 | 同一命中长条在前、短例外完整优先、长条不丢且原位置续接 |
| R12未执行SQL截词 | 7 | 健康混合长问句不因此bounded；SQL实际替代才报告其限制 |
| R13覆盖未核完 | 7 | current、已证lag、deadline未核完三类最终回执区分 |
| R14部分片失败 | 7 | 成功正文保留且已有失败原因到v2；全成功/全败正负控 |
| D1/D2自然控制/澄清 | 4 | 持久控制依据、任务卡刷新、有无parts一致、任务仍等待 |
| 50项/同侧校验/文档 | 6、8、9 | 独立数量证据、原入口与恢复边界保留、状态说明不夸大 |

09场景已经包含两主链、长会话、互斥来源、晚到查询、资产与支持容量；无需为这些修复另增09任务。其文件在编包前后按SHA256核对，保持原样。R02/R07的正式合同如获确认，应写入相应05/06/07和实现设计；09沿最新版合同验收，不复制新的边界测试目录。

## 证据限度

意见合入后的`make verify-materials verify-delivery`退出0：490项材料、16项检查器测试通过；声明明确业务未验证。241个本轮相对链接有效，`git diff --check`退出0。与编包前manifest对照仅8份允许文档改变，产品/正式测试不变；09的SHA256保持`ebcdc8798f6d63dcad8c399d95822a0db1e8103b44bcce9c305b9c9541c01e74`。结构化结果为`.local/audits/semantic-closure-package-20261031/{material-validation-final-result,scope-and-links-final-result}.json`，与前一次7文档/234链接记录区分。

本轮未修改产品/正式测试，未重跑23组，未构建/启动服务/调用真实产品模型或embedding，未提交推送部署。Oracle网页咨询与产品模型验收是两类证据。材料和声明检查只能证明文件/引用及计划记录有效，不能证明R01–R14已修。新包计划状态与待解决事项只由CURRENT维护；本报告不冒充第二份进度表。

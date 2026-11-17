# 混合检索续审与有界纠偏（2026-10-28）

本次核对coding agent在05前四切片的实施声明。当前状态只在[CURRENT](../CURRENT.md)，本文保存审计和验证证据。修改前工作树已保存在`.local/hybrid-resume-audit-20261028/before/`与对应640文件清单；HEAD累计差异不等于本轮修改。

## 判断

**不能认可“前四切片完成”。架构分工可保留，当前问题主要是普通工程缺陷、未完成的内容粒度接线，以及测试覆盖小于完成声明。** MySQL正式内容、Milvus派生索引、业务owner、Pi唯一Agent/压缩/恢复没有被替换。本轮没有增加产品功能、模型、表、服务、队列、通用预算框架或恢复器。

本轮先修可独立验证的缺陷；真正entry/statement/window身份、SQL后备与双类型的统一推进仍需整体替换当前对象级主链。这些明确留在05，不能挪给06或靠LIMIT兜底。详细接续合同见[执行包](../execution/semantic-runtime/hybrid-retrieval.md)。

## 发现、修复与仍需闭合的部分

| 普通触发 | 根因及本轮处置 | 证据边界 |
| --- | --- | --- |
| 第三次raw索引在途退出，当前配置无效 | 发送资格只含attempts<3，却拿它过滤attempts>=3的收敛；已将收敛独立于发送资格 | 消费者RED/GREEN，原次数保留、零派发 |
| 冻结配置已提交，trial登记前中断 | 恢复不再被视为fresh，原trial永远不登记；按真实冻结profile复用幂等登记 | 消费者RED/GREEN，不换trial、不重置预算 |
| 恢复资格读取发生存储错误 | catch-all跳过/空列表伪装无工作；只跳过既定失效来源，其他直接传播 | 实际隔离库42S02反例RED/GREEN |
| 未展示entry依赖在锁外换版 | 初读检查required_sources，最终却只从裁小entries推导；复用完整投影重核 | 正式Rust组合/最终核验反例RED/GREEN；完整mapping未改 |
| 结构metric关联大表 | semantic_object经完整snapshot重拉本对象和关联表；改用窄引用和必要DDL投影，保留来源、版本/path及列绑定核验 | 初始RED：表1,548,238 B，额外下行7,794,914 B；最终一表一SQL夹具表1,544,966 B，增量17,951 B；3条列绑定及原10条语义规则通过 |
| 两路同时请求剩余100个候选 | allocate只看已接收，未扣在途；现有预算增加本次请求的预留/释放，不建预算服务 | RED合计领取200，GREEN合计100；重复身份与失败释放回归 |
| BM25占满工作期限，dense已就绪 | 等词法骨架及只允许词法预读，dense无法读正文；现有循环改为接收任一就绪通道 | 两片真实Milvus慢词法RED：零对象；末次重跑另发现停轮进度丢失，修后`deadline-closure.log`6项全通过，含2分片/1轮/deadline和最终正文 |
| 到期或读取报错 | drop JoinHandle后先返回；重写循环出口统一等待原Embedding收尾，词法也接回受同一期限约束的停轮事实；存储等错误不再一律降成None | 隔离账本锁跨期限后收尾的实际反例已通过；普通读取错误及全期限强反例范围仍见接续包 |
| dense后页、正文后失效补取 | 首轮向量丢失；以元信息数量/failed项算够了；已保留向量、按有效读取推进 | 最终正式dense-only深页与未耗尽补取须补，不凭本地编译声称完成 |
| 期限晚起算、迟到内容 | 已把期限前移到范围准备前、传至原launch，预读与正文按剩余期限并拒绝迟到内容 | 完整范围/元信息/正文/结算次序电池仍列下一包，不能从一个慢通道例推导全部通过 |
| 同对象多个位置/单条巨大entry | SQL仍按hints OR全部词取完整entry，StageReads仍按对象；此项没有用假LIMIT掩盖 | 下一05包先整体替换成真实内容身份，继续保留为未完成 |
| 后续页慢或BM25失败后备 | 当前后页await仍可能阻断另一通道，SQL后备还在最后装配才进入 | 下一05包与内容主链一起原位替换；不得声称独立推进已完整 |

没有发生率测量，故不编造百分比。本轮修的都是现有正常长文、并发通道和已约定中断恢复，不是为理论风险新加保护。异步后的权限、来源修订、租约和原副作用身份检查必须保留；它们不属于同一外部输入重复Schema校验。一次性简单逻辑原位处理，清楚的owner读接口保留，不按行数机械拆文件。

## 独立审查追加的修复

结构优化最初错误地认为全部保存入口均已验证列绑定。独立审查沿正常`reanalyze`与自动预填写回反证后，新增`check-structure-column-bindings.mjs`：平台DDL删列仍保留人工旧规则、预填结构格式合法却引用不存在列，两条真实维护链均先RED。修复复用M02原列绑定规则，只查相关表的当前DDL；不增加持久有效性标记、不恢复完整snapshot、不重复Schema。两条负控及合法`needs_review`正控均GREEN，人工原值保留。新脚本纳入`verify-hybrid-scope`，原10项语义规则仍通过。最终下行数据已包含必要DDL，不能继续引用中间状态的16,385 B。

末次期限电池还发现：出口立即abort只读词法任务，会丢掉它已执行分片和轮次，回执出现`shards=0/rounds=0`，原“至少两片”断言失败。已改为接回受同一期限约束的词法停轮结果，错误先存下，仍等待Embedding结算后传播；最后一片自身跨期也记录deadline。没有增加等待期限、重试或后台任务，没有修改失败断言。两处正文读取在时间判断前传播内层错误，防止已返回的存储错误被误吞成正常bounded。

静态复核与红绿证据见[有界纠偏独立审查](hybrid-resume-corrections-review-20261028.md)。最终`deadline-closure.log`6项、`retrieval-lib-closure.log`42项、`knowledge-reuse-closure.log`16项、完整`architecture-closure.log`、`verify-code-closure.log`及API/Worker重建均通过；6组退出0汇总在`closure-checks.json`。证据统一登记于CURRENT，不拿早期通过覆盖后续修改。本轮产品/测试/命令相对接手快照的15文件范围保存在`.local/hybrid-resume-audit-20261028/correction-scope.json`，它只定位本轮修复，不是05完整验收指纹。

## 测试及审查纪律

数据库测试串行，隔离合成MySQL与专用真实Milvus集合，本地Embedding/provider协议替身；没有真实模型质量或真实平台证明，没有付费API、commit/push或日常服务更新。

初始单片慢词法夹具未复现完整期限：Milvus单请求8秒超时，10秒前仍可走后备；当时失败只是coverage期望过窄，不作为缺陷RED。修正为两片，按既有状态合同允许bounded/candidate_limit，成功复现dense正文遗漏。原词法先耗满30再dense到达的场景明确给Embedding加延迟，固定原要求的事件顺序；未降低内容/额度断言。结构夹具最终扩大已有唯一加工SQL条目，保持一表一份SQL；初始RED和该语义纠正后的GREEN分别记录，不冒称完全同一夹具。

正式可交付类型、原ref/offset、完整来源与裁剪后依赖，仍由原合同定义。对本轮修复的独立审查与实际完整日志见CURRENT最终证据。05仍active，本轮不生成整包passed审查或借旧verify-increment收据关闭。

## Oracle交叉核对

代码会话`data-agent-retrieval-continuation-audit-20261028`已完成，提交前两次确认`Power, item 5 of 5 (slider ARIA)`；不启用外部并行代理。答复SHA256为`2e8e2e7a9011006e4e2722608cc1b124b193d6f7a9e9e98589a7ea870c4e9b88`，精确Chrome进程已退出、临时Profile已删除。材料/完整答复在`.local/hybrid-resume-audit-20261028/`。

Oracle确认7项静态缺陷，完整来源最终校验因附件不全列待补证据；本地进一步读最终转调并用实际RED/GREEN证实该窄投影缺口。Oracle没有运行测试，不能将其意见当业务验收。它还指出后页partial状态和共同轮深报告需补，均写进下一包；保留真实分片消费位置，不再重复解释成架构选型失败。

接续包另用独立会话`data-agent-retrieval-continuation-package-20261028`完成最高Power 5/5审查，答复为`request_changes`：先补规范候选身份、唯一1000/5/30口径、SQL后备就绪事件三处定义，方向与架构可保留。最终包已逐条修订，并补账本不可写的错误边界与raw最终核验同链。本地未编写执行包的审查者已复核最终文字；Oracle没有再次审过最终稿，也没有运行测试，不能将咨询当成05通过。两次咨询指纹、清理证据及不采纳项缘由见[交叉验证](../execution/semantic-runtime/cross-validation.md)及[接续包独立复核](hybrid-resume-package-review-20261028.md)。

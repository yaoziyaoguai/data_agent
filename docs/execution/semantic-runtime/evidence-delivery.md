# 工具合同2与最终依据回执

前置：01容量、04任务范围、05候选及回源可用。需求 D04/D06/D07、C01/C02/C06/C07、A02/A06/A09；保持D10/D11/D12。职责 M02/M03/M04/M08/M09/M11。合同为17.5及17.6.1。

**2026-10-29修订：** 先执行 [Pi接入复用与既有实现修复](pi-reuse.md) 的01–05能力核对，以及“检查点引用导出、单边界校验”两项已证修复，再做下述v2纵向小样。它们属于本包开头的有界维护，不新增阶段，也不能推迟到08才处理。D03长期会话、C05原操作/预算恢复同时纳入本包验收覆盖。

## 执行前置与复杂度边界

本包不得在05仅有旧passed报告时执行。先取得05当前指纹下的闭环证据：各路范围前置、共享候选预算/进度、元信息分批与owner定点读取。06消费这些内部接口，不接收05遗漏作为本包新工作。执行时沿用 [混合检索](hybrid-retrieval.md) 的四条复杂度约束；不加全仓类型迁移、跨回执记账器、资料包会话或罕见竞态框架。

先走一个受控纵向小样：合同版本2 → 一条knowledge与一条raw命中 → owner定点读取 → Rust最终回执 → Pi无损包装 → 实际provider输入。小样通过后，再逐条扩批量、支持和游标，不能先铺全部Schema再接第一条链。这里provider可以是本地协议替身；没有真实模型授权就不付费。

### 文件和接口责任

| 责任 | 入口 | 本包动作 |
| --- | --- | --- |
| 同源合同 | `packages/contracts/schema.json`及生成类型、`tests/contracts/cases.json` | 定义v1/v2可辨别形状，历史缺省1；模型参数与宿主response_budget分离 |
| 工具组合与最终回执 | `use_cases/data_tools.rs`、`knowledge.rs`、`knowledge_sources.rs` | 使用05当前候选/进度/窄读取，不再建立新的检索链；批量逐项状态、最终裁剪和四类续读位置 |
| 陈述/支持owner | `modules/knowledge/preparation`、knowledge私有store及公开接口 | 复用已有knowledge_statements；补支持完整性来源和按陈述/位置读取，不新建第二份支持库 |
| 原成功回执恢复 | runtime工具账本、`context_authority.rs` | 冻结首次成功正文及游标；容量提示不改变业务指纹或原操作身份 |
| Pi容量和包装 | `apps/agent/session/deliver.ts`、`tools/data-tools.ts`、provider边界 | 从实际Pi投影及冻结profile分配同批余量；v2正文不二次结构裁剪；不足用Pi原生压缩 |
| 原生会话持久引用 | `apps/agent/session/journal.ts`、`checkpoint.ts`及原导出调用点 | 首次打开/导入严格核验，已加载会话每次导出不再整本解析；保原Pi文件、session/leaf及必要落盘顺序，不建第二份存储 |
| 进程接入校验 | `apps/agent/transport/client.ts`、`tools/data-tools.ts`及必要直接调用点 | 边界解析校验后传生成类型，删除同侧相同Schema重复校验；旧登记回执优先、Rust独立校验保留 |
| 兼容资产 | assets公开读取、原memory/skill分支 | 保留原归属/版本/选择权及各自分页；不改Mem0、不将Skill改为公共SourceCitation |

### 支持完整性不能由空列表猜测

当前SemanticStatement只有supports列表，没有可证明“支持已完整提取”的来源字段。实现时在既有陈述保存/读取合同中补可空的 `supports_complete`（或经contract-first确认的同义字段），由人工保存或整理成果中经校验的明确覆盖声明写入；历史缺字段为unknown。不能从supports=[]、分页结束、semantic_status=ready或“没有报错”推导true。不要为历史数据编造完整性，也不要新增跨回执状态表。

新增字段必须同时更新Schema、生成类型、保存/读回与历史解码反例；只加响应字段但来源从未保存不算完成。真正delivered仍按本次最终可见正文计算，完整性声明本身不是内容交付。

## 结果与范围

搜索直接返回足够读懂的正文和补读位置；批量读取可部分成功；必要条件/例外、分页游标与最终可见内容一致。个人记忆、Skill、结构补读能力全部保留。

允许同源Schema/OpenAPI及生成器样本，Rust知识/资产/来源公开读取和具名取证用例，Pi工具/回执包装，相关测试。由一个owner整合data_tools/knowledge/context_authority，由Pi owner整合deliver/data-tools；不建立资料包会话或跨回执交付账本。

## 实施顺序

先按 [Pi复用约束第3节](pi-reuse.md#3-06先修接入再扩工具合同) 修复两项既有问题，分别取得窄反例与恢复回归，之后按下列步骤连续推进。不要为这两个Node接入修复重跑千表索引；有检索行为变化才扩大对应检查。工具选择、补读和循环全部交给Pi中的模型，不增加固定步骤编排器。

删除检查点整读前，必须先证明SDK“内存leaf已推进、追加/首次flush失败”及必要同步失败时，错误出口不发布无效引用、不替换宿主已确认检查点。`isPersisted`与fsync不能独自证明新leaf落盘；故障路径可严格核验，健康路径不再每工具整读。原日志完整才恢复原leaf，坏日志沿既有明确拒绝；不新增日志或恢复框架。这项验证就在本包，不推迟到08。

1. 合同负责人发布 `RunEnvelope.tool_contract_version`：历史缺省1，新2的可辨别形状。先完成两端解码与运行时校验；旧登记调用/回执按原版本恢复，业务参数指纹/operation身份不变。07完成完整集成，08在新公共索引目标切换后再启用默认新消息v2；当前仅在已接上新集合的专用验收实例采用2。
2. `search_knowledge` v2保留query/limit/kinds/asset_after；加入task_ref、hints、cursor，返回区分raw/knowledge的hits及coverage。hints只是排序，v1已发布硬过滤继续原义。raw有citation/source_length/text/semantic_status，不伪造Knowledge EvidenceRef。
3. `read_knowledge` v2按输入顺序返回1–20项：knowledge的ref/statement_id/structure_only、memory的asset_ref和body/scope/source_text、已选skill descriptor。单项stale/not_available不抹掉其他合法项；真正服务失败返回upstream_failed，不伪装全部不存在。
4. `read_source`按citation/revision/locator定点读取，返回实际locator、source_length、text、content_state及next_locator。next只续本次请求范围，扩大到别段需显式新locator。Unicode单位沿02，不接受chunk_id充当业务定位。
5. M11生成内部 `DataToolInvocation.response_budget={max_bytes,estimated_tokens,projection_fingerprint}`，从真实Pi投影/冻结profile及同批工具组分配，预扣SDK包装。字段不出现在模型工具参数，不参与业务参数指纹、不当费用额度。同批总分配不能重复使用余量。
6. Rust按提示和本端上限较小值最终裁剪：目标96KiB、硬256KiB且受token/字节余量；v1仍24KiB。优先完整条件/例外，不能半句截断标完整。Rust生成最终状态/游标并冻结成功回执；Node仅无损SDK包装，不能再二次剪正文。
7. content_state=complete/partial只表示指定内容；support_state=delivered/partial/unknown依据本回执实际内容；search_coverage表达通道覆盖。支持附content或指向仍保留完整内容的delivered_in，ID不等于交付；supports_complete区分完整性未知。大支持以可选content_page标明自己的字符位置，仍沿supports_next_cursor续读同一支持；保存正文不能被引用全文替换。支持目录到底不等于本页交齐全部必要内容。
8. 四类续读独立：content_next_offset、supports_next_cursor、公共cursor、asset_after。支持续读可limit=0不重传正文。游标绑定原查询/范围/条件/修订和有界待交付位置，无正文、不建服务器检索会话。整项裁掉不得按扫描序推进越过它；stale/invalid cursor区分。
9. 单次最小身份/续读位置也放不下则明确容量状态；工具内不递归启动摘要。M11下次派发先用Pi原生压缩。恢复余量更小时接回原成功正文/游标、不重做或改写回执，再处理Pi空间；非法超大单项明确错误。
10. 保留资产目录query=*、next_asset_after/asset_total/asset_cursor_invalid/memory_retrieval及个人记忆三种分页；资产不占公共hits名额但共同受回执容量。预算裁剪重建不得按目录顺序丢弃Mem0额外召回的已核验个人记忆：目录资产优先、额外项随后参与同一容量裁剪，超预算时按正文续读游标交付而非静默删除；next_asset_after只反映目录位置，Mem0额外项不成为游标、其被裁不改变目录后继。Skill仅已选当前descriptor，正文附件继续Pi原生read，不改成SourceCitation、不改变选择权。

## 验收表

| 场景 | 必须结果 |
| --- | --- |
| 只给支持ID；支持提取未知；第二页支持目录结束 | 均不能错误标本回执delivered；已知缺项提供补读，unknown不误写无例外 |
| delivered_in承载段被裁掉 | 同步修正状态与位置，无悬空“已交付” |
| 公共命中/支持/资产同时超小余量 | 各游标不越过未交付项；续读交付/推进或真实终止，无永远同页 |
| 同批多工具；随后恢复剩余变小 | 总预算不重复分配；原成功回执不变；Pi压缩续接、业务调用仅一次 |
| 一批含合法knowledge、他人memory、未选Skill、过期ref | 合法项仍返回，无权项不泄露；状态与真正upstream_failed分开 |
| 长正文/structure_only/记忆三分支/原生Skill read | 每分支分页语义保持；不因v2只保留公共hits而丢资产 |
| 原文/知识同源、同文不同位置、跨段例外 | 回执明确出处，相关内容与必要支持不被类型配额挤走 |
| 游标后参数/任务/权限/来源版本改变 | 重新核验，invalid或stale明确；游标不是授权票据 |
| 同一会话旧v1登记调用恢复，随后新v2消息 | 按各自原形状，session/operation/budget不更换；不能再执行未知副作用 |

## 检查与交接

既有接入修复扩展 `tests/runtime/check-checkpoint-journal.mjs`、`check-pi-sdk.mjs` 与 `check-tool-serialization.mjs`；用原 `check-request-policy.mjs`、`tests/mvp/check-native-compaction.mjs`、`check-recovery-continuation.mjs` 检验原生压缩/重试/恢复。实际计数或读字节观察放测试进程，不新增生产观测字段。保留损坏/错leaf/旧内联检查点、未登记坏参数与已登记旧参数恢复的反例。只有绑定真实可执行命令并运行后才登记通过。

扩展 `make verify-contracts`，tests/runtime `check-tool-serialization.mjs`；tests/mvp `check-large-tool-context.mjs`、`check-asset-directory.mjs`、`check-memory-revisions.mjs`、`check-completion-gaps.mjs`、`check-retrieval-coverage.mjs`、`check-authority.mjs`、`check-recovery-continuation.mjs`。新增反例必须检验**最终序列化回执与实际provider输入**，不只断言裁剪前内部对象。

独立审查追一条“候选→最终正文→四个游标→账本→Pi包装→provider”的完整路径。当前通过仅说明受控v2运行，完整集成待07，默认切换在08；不存在的消费者不能用mock成功吞掉。交接07：完整v2读工具、response_budget冻结/重放、资产兼容，以及仍未启用的唯一运行选择位置。交接08：旧合同样本和升级后回读/恢复证据。

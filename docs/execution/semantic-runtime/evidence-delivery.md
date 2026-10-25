# 工具合同2与最终依据回执

前置：01容量、04任务范围、05候选及回源可用。需求 D04/D06/D07、C01/C02/C06/C07、A02/A06/A09；保持D10/D11/D12。职责 M02/M03/M04/M08/M09/M11。合同为17.5及17.6.1。

## 结果与范围

搜索直接返回足够读懂的正文和补读位置；批量读取可部分成功；必要条件/例外、分页游标与最终可见内容一致。个人记忆、Skill、结构补读能力全部保留。

允许同源Schema/OpenAPI及生成器样本，Rust知识/资产/来源公开读取和具名取证用例，Pi工具/回执包装，相关测试。由一个owner整合data_tools/knowledge/context_authority，由Pi owner整合deliver/data-tools；不建立资料包会话或跨回执交付账本。

## 实施顺序

1. 合同负责人发布 `RunEnvelope.tool_contract_version`：历史缺省1，新2的可辨别形状。先完成两端解码与运行时校验；旧登记调用/回执按原版本恢复，业务参数指纹/operation身份不变。07完成完整集成，08在新公共索引目标切换后再启用默认新消息v2；当前仅在已接上新集合的专用验收实例采用2。
2. `search_knowledge` v2保留query/limit/kinds/asset_after；加入task_ref、hints、cursor，返回区分raw/knowledge的hits及coverage。hints只是排序，v1已发布硬过滤继续原义。raw有citation/source_length/text/semantic_status，不伪造Knowledge EvidenceRef。
3. `read_knowledge` v2按输入顺序返回1–20项：knowledge的ref/statement_id/structure_only、memory的asset_ref和body/scope/source_text、已选skill descriptor。单项stale/not_available不抹掉其他合法项；真正服务失败返回upstream_failed，不伪装全部不存在。
4. `read_source`按citation/revision/locator定点读取，返回实际locator、source_length、text、content_state及next_locator。next只续本次请求范围，扩大到别段需显式新locator。Unicode单位沿02，不接受chunk_id充当业务定位。
5. M11生成内部 `DataToolInvocation.response_budget={max_bytes,estimated_tokens,projection_fingerprint}`，从真实Pi投影/冻结profile及同批工具组分配，预扣SDK包装。字段不出现在模型工具参数，不参与业务参数指纹、不当费用额度。同批总分配不能重复使用余量。
6. Rust按提示和本端上限较小值最终裁剪：目标96KiB、硬256KiB且受token/字节余量；v1仍24KiB。优先完整条件/例外，不能半句截断标完整。Rust生成最终状态/游标并冻结成功回执；Node仅无损SDK包装，不能再二次剪正文。
7. content_state=complete/partial只表示指定内容；support_state=delivered/partial/unknown依据本回执实际内容；search_coverage表达通道覆盖。支持附content或指向仍保留完整内容的delivered_in，ID不等于交付；supports_complete区分完整性未知。支持目录到底不等于本页交齐全部必要内容。
8. 四类续读独立：content_next_offset、supports_next_cursor、公共cursor、asset_after。支持续读可limit=0不重传正文。游标绑定原查询/范围/条件/修订和有界待交付位置，无正文、不建服务器检索会话。整项裁掉不得按扫描序推进越过它；stale/invalid cursor区分。
9. 单次最小身份/续读位置也放不下则明确容量状态；工具内不递归启动摘要。M11下次派发先用Pi原生压缩。恢复余量更小时接回原成功正文/游标、不重做或改写回执，再处理Pi空间；非法超大单项明确错误。
10. 保留资产目录query=*、next_asset_after/asset_total/asset_cursor_invalid/memory_retrieval及个人记忆三种分页；资产不占公共hits名额但共同受回执容量。Skill仅已选当前descriptor，正文附件继续Pi原生read，不改成SourceCitation、不改变选择权。

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

扩展 `make verify-contracts`，tests/runtime `check-tool-serialization.mjs`；tests/mvp `check-large-tool-context.mjs`、`check-asset-directory.mjs`、`check-memory-revisions.mjs`、`check-completion-gaps.mjs`、`check-retrieval-coverage.mjs`、`check-authority.mjs`、`check-recovery-continuation.mjs`。新增反例必须检验**最终序列化回执与实际provider输入**，不只断言裁剪前内部对象。

独立审查追一条“候选→最终正文→四个游标→账本→Pi包装→provider”的完整路径。当前通过仅说明受控v2运行，完整集成待07，默认切换在08；不存在的消费者不能用mock成功吞掉。交接07：完整v2读工具、response_budget冻结/重放、资产兼容，以及仍未启用的唯一运行选择位置。交接08：旧合同样本和升级后回读/恢复证据。

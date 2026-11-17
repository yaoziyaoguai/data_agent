# 任务条件、来源范围与历史分析

前置：来源身份及有效内容/贡献根接口可用。需求 D02/D03/D08/D09/D13/D15、C01/C02/C03/C04/C05/C07、A01/A02/A04；职责 M05/M06/M07/M08/M09/M11/M12。合同为实现设计17.4、17.8；保留现有查询执行授权规则。

## 结果与范围

用户只改月份时其他条件不丢；明确来源限制跨轮、轮内、任务切换都生效；普通语义改版后仍能看旧SQL、条件、结论和报告。旧分析用于复述历史，不自动获得新执行权或当前口径资格。

允许analysis/queries/runtime/conversations的相关模块；`query_semantics.rs`、`context_authority.rs`、`data_tools.rs`、`deliver_run.rs`、query/evidence/report/read_conversation用例；Pi会话/检查点、必要工作台/报告UI、同源合同/迁移/测试。来源有效性调用03公开接口，不重复私表查询或造另一套范围系统。多任务最终组合在07，本包完成活动任务投影边界。

## 实施切片

1. 同源扩展Conditions、ConditionPatch、QuerySemanticResolution、QueryView及持久修订：source_limits、time_roles、semantic_resolution和采纳来源。set替换、unset清空、省略继承；旧channel可解码，新任务使用通用filters，不硬编码座舱channel枚举。旧查询决策缺证据返回null，不从模型历史猜回填。
2. source_limits用稳定SourceKey非空允许集及宿主绑定origin_message_ids。legacy解码保留“原字段缺失”与新记录显式null的区别，不能用默认值把它们压成同一事实。旧任务缺字段不能证明用户从未限制：续接按原条件/可核实消息恢复，不能静默解除。无受限任务的普通知识浏览继续无需建任务。
3. time_roles区分event_time、observation_cutoff、data_batch；event_time含字段/业务意义，统计区间沿原time_start/end；截点带时区值，批次带批次值。request_clock和平台freshness不冒充用户截点。
4. 新explicit_user由宿主核对本轮真实消息与原话；继承只从同任务已验证条件版本复制原采纳身份。模型自由填旧message_id不成立。needs_clarification不能用省略变unambiguous；request_query保存决策须与目标条件版本一致。口径采纳不授予SQL执行权。
5. 将input_task_ids与持久active_task_ref分开。route/修订核验归属；缺task_ref继承真正活动任务，不绕过限制。来源不同的任务不取并集，同批跨任务读取不能暗中切换；批量已确认SQL控制仍逐项核验。
6. 轮内收紧范围或切活动任务后，**下一次普通或摘要provider派发前**通过Pi原生接口重核/重投影：旧工具正文、个人资产、历史投影、派生摘要均在内。若SDK身份无法安全续接，按既有stale_context明确返回，不换operation_id重做。不要只修改下一run启动资源便宣称覆盖轮内。两侧任务都已明确无限制时只更新活动归属；任一侧受限/未知，或同任务范围声明变化才重新投影，不因普通月份修订机械清空上下文。
7. history_display/current_use由具体用例指定，不接受客户端或模型自由选择宽松purpose。普通语义改版不隐藏已存SQL/条件/决策/摘要/结论/报告；旧引用全文缺失只影响补读。撤权/删除/停用仍限制实际派生内容；原始结果过期只让依赖结果重建的图表/明细不可用，不整份报告消失、不自动重跑。
8. 模型读取旧query/evidence/report用受控historical_analysis投影，含原记录引用、生成时间、条件、内容指纹和实际来源。authority增加historical_analyses[]并递增格式，保留dependency_schema=5解码，新格式未使用也带空数组。不能直接给所有旧记录追加required造成恢复失败。
9. 摘要继承真实输入用途与来源；混合摘要缺可靠区分则沿原保守重建，重新读取允许的历史记录，不把整段摘要改标历史豁免。历史引用不能直接充当新草稿当前EvidenceRef。原回执、session、budget和operation身份保持。

## 关键反例

- “只用文档A”→“改十月”：限制、采纳口径、观察截点保留，只改统计区间；显式unset才撤限制。
- “分析ASR”仍可读共享语音定义；“只用A”才执行硬限制。分析目标、检索hint、证据允许集不混用。
- 模型未得到真实采纳却声明explicit_user被拒；继承已核实选择无需逼用户重复旧原话；采纳后没有执行请求也不运行SQL。
- 轮内先读A再收紧到B：拦截实际普通请求与摘要请求，不能残留A正文/摘要。只断言工具拒绝不够。
- 活动任务不明确时可见任务目录/控制信息；受限正文读返回task_context_required，不并集；普通无约束浏览可用。
- 已存报告普通改版后刷新仍完整；结果过期只局部受影响；撤权后Web与Pi都不复活派生内容。
- 旧schema5、新空historical_analyses、混合摘要、旧成功工具丢回执重放分别覆盖。
- 新输入、查询晚到、取消单任务不改变其他任务条件/结果归属；不改原授权/幂等测试期望。

## 现有检查与交接

扩展 tests/mvp：`check-request-context.mjs`、`check-query-semantics.mjs`、`check-task-text-authority.mjs`、`check-task-host-authority.mjs`、`check-task-result-authority.mjs`、`check-query-text-authority.mjs`、`check-report-text-authority.mjs`、`check-authority.mjs`、`check-context-dependencies.mjs`、`check-history-browser.mjs`、`check-analysis-reports.mjs`、`check-analysis-reports-browser.mjs`，配合 `make verify-query-workflow` 及共享检查。

这批旧测试需补新条件/用途/派发反例，不能全局取消“stale拒绝”断言：普通历史展示放宽与新采用/撤权仍拒绝应分成正反例。迁移只回填有证据的数据；旧缺范围身份按既有失效/新输入重建路径处理，不猜空集。

交接05/06：可读原文/知识/资产的任务范围接口、actual active_task_ref、轮内Pi投影验证。交接07：按任务来源追踪及输出引用所需身份；本包不提前把调查消息当最终答案。

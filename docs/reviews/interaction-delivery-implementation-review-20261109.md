# 交互交付修复限定独审（2026-11-09）

审查对象为[交互修复包](../execution/semantic-runtime/interaction-delivery-repairs.md)§3.1六组及§7收尾，重点是Pi复用、四条编程规则、验收预期变化和官方模型凭据前提。分支为`codex/semantic-maintenance-prototype`，HEAD为`04d27d0`，对象包含未提交实现；不将HEAD单独当作被审代码版本。

未参与实现的同一审查者因宿主API 429中断后恢复并完成，只读核对源码、合同和已有日志，没有运行测试、访问数据库、操作服务或编辑文件。本文归档其实际结论，并单独标明主owner随后实施的修正与复验。当前工作状态只在[CURRENT](../CURRENT.md)维护。

## 审查者返回的结论

发现三处验收证明缺口，未定位到六组生产实现中的确定性功能缺陷。未发现新增Agent、压缩或恢复框架，也未发现四条编程规则的实质违反。

| 严重性 | 原发现 | 触发及遗漏 |
| --- | --- | --- |
| P2 | `tests/mvp/check-answer-streaming-browser.mjs`以`!s.finished || s.generating`筛“结束前”样本 | provider已结束、UI仍显示生成中时，积压片段的DOM增长也可参与断言；无法强制§7.2所需的provider结束前可见与增长。 |
| P2 | `tests/mvp/check-waiting-task-delivery.mjs`冻结后直接生成“说明已保存” | 未实际执行保存工具，不能捕获保存导致交付状态或新尾项丢失；只证明冻结后接受自然尾项。 |
| P3 | `tests/mvp/check-native-compaction.mjs`使用`if (legacyEntry)` | 旧search条目丢失时会跳过原条目保留和context edit幂等断言，即使普通/摘要请求计数满足也不能证明原条目仍在。 |

其他限定核对：

- 组1的普通残留与后缀经`emit`接入输出；组2保留`(!alreadyFrozen || !control)`，未覆盖任务的控制交付仍在。
- 组3暂停集合与Rust `requires_source_context`一致，多用途工具合法分支保留。
- 组4仅解除短引用读取的recovery chain约束，调用方仍锁定并授权会话；原任务/条件/来源范围及检索选择核验未放宽。`source_identity`和个人资产游标保持原协议。
- 组5消除runtime→use_cases反向依赖，替换规则只有一份；事务上下文传参与仓库现有惯例一致。
- 组6使用Pi原生context edit修改模型可见content，原entry、持久回执和调用参数保持。
- task-query正常展示chunks改为`firstBody+secondBody`、registered/committed恢复仍为`secondBody`，符合一次展示流与恢复不重播合同。v2来源就绪、记忆参考和旧回执注入轮次的调整有对应依据。
- 浏览器使用页面真实会话ID，create→纯文本stop补齐合法运行前提。官方模式经`/model-services`写入加密凭据只补启动前提，不进入互斥的`--check`路径；未改变成功断言或模型、来源、预算门。

## 主owner修正与复验

以下修正发生在独审返回后，属于主owner实施与实际检查，不另称一次独审通过。

| 发现 | 修正 | 新证据 |
| --- | --- | --- |
| 浏览器结束前时序 | 只选择`!s.finished`，增长与严格正文前缀均在该集合断言。复验前的旧samples、report和截图已存`before-review/`。 | `.local/checks/interaction-repairs/g7-review-browser-streaming.log`：passed=true、EXIT=0、providerCalls=4、officialRequests=0；provider结束前4次增长，定稿/刷新一致，短句一次。 |
| 冻结后真实保存 | route冻结后经真实Pi/Rust调用`save_analysis_evidence`；核对真实成功引用和持久化说明，再经历非法尾项补正与合法新尾项，待确认SQL仍未提交。 | `g7-review-waiting-save.log`：已有`--same-task-explanation`入口，passed=true、EXIT=0、calls=11、officialRequests=0；evidence_saved_after_freeze=true、两单元一任务、原候选恢复零调用。 |
| 原search条目保留 | 按注入时原entry ID强制查到条目，与注入时完整entry深比较；每轮恰一条目标context edit，无条件断言。 | `g7-review-legacy-projection.log`：passed=true、EXIT=0、calls=22、compactions=8、legacyRequests=1、legacySummaries=1，原分支保留与幂等均通过。 |

上述三项在数据库harness中串行执行，没有扩跑旧电池或新增官方模型调用。native-compaction中的一次`request_too_large: model_input_limit`是请求发送前触发Pi原生压缩的设计内路径，最终检查完整通过。

工程出口沿用`.local/checks/interaction-repairs/g7-verify-gate3.log`的EXIT=0；修正只涉及测试与文档，没有变更产品Rust/TypeScript实现。更早的fmt、clippy、浏览器、短引用和原生压缩失败日志全部保留；后台任务completed不作为passed依据。

## 证明范围与剩余缺口

本次审查支持限定的代码与验收核对，不能证明真实供应商质量、生产部署、用户接受或整个09完成。真实DeepSeek代表仍未通过：S02独立验证器对SQL列角色重复匹配，正确性未证；两次S05输入33693/33905超过误用的legacy 32768策略，不能证明09原大容量配置的代表流程。没有取得本轮真实“草稿→确认执行→自动解释”的完整通过证据，后续S03未运行，全部失败与费用保留。

三处验收缺口已由主owner补强并复验；本包真实模型验收仍有缺口，09保持active、review pending、evidence null。未运行verify-increment或100项电池，未提交、推送、部署或修改/重启用户日常服务。具体调用、tokens、费用、日志和预期变更表见CURRENT，不以本记录覆盖旧成绩。

## 本次验收根因修复的限定独审（2026-11-09）

用户接续要求修复S02独立校验及原09配置接线后，为本次三份代码差异另由一名未参与该变化的审查者只读核对：`scripts/evaluate_business_sql.py`、`tests/mvp/check-business-evaluator.mjs`、`tests/mvp/run-business-acceptance.mjs`。后者相对本轮开始前归档的`before-config-run-business-acceptance.mjs`审查，未将更早凭据修改混算为新变化。未重新审计六组产品实现或组织审查团。

审查者发现一处P2：普通`paid_order_lines`、`order_line_count`先命中order角色，误把订单数当行数接受；若同时给出订单列，则正确行数又被误拒为重复角色。其纯函数复核表明基础数据及七变体都可能错误通过；原正反例只用paying_orders/paying_lines，没有覆盖复合粒度名称。

主owner随后按同一命令行接缝补反例，`s02-compound-grain-red.log`为EXIT=1，实际`true !== false`复现错误查询被接受。最小修复将line/row/行优先于order/订单，也覆盖匿名订单行；不使用题目ID、具体输出别名或结果数值选预期。`s02-compound-grain-green.log`为EXIT=0：13个独立参考、3种分组形状、3种中英文复合行别名、12个分组/粒度反例与既有反例通过，原持久SQL及七变体的实际行和独立预期均不变。后续修正和复验由主owner实施，不另称第二次独审通过。

审查者其余限定结论：预期仍来自独立合成数据，仅规范实际分组标签；接线经现有管理API恢复模型定义，核对实际冻结profile及模型/服务修订和工具合同2；沿用deliver及既有容量规划，未发现新增Agent/压缩/恢复框架、四条编程规则的实质违反或修改正式trial/expiry/预算身份。审查者只做差异、证据及不访问数据库的纯函数复核，未编辑、委派、读取凭据或私有会话，未执行完整校验器、数据库、真实模型或工程检查。

配置回环`configuration-wiring-green.log`由主owner核对EXIT=0、passed=true、9次合成调用、官方0次；`configuration-preflight.json`归档原09配置来源指纹、实际两run的tool2/模型与服务v2、1M/900k/65536/8MiB/600s/24/high及Pi容量。粒度修复不改配置接线，配置证明沿用该日志；校验器最终行为用上述新GREEN证明，不把旧报告源指纹冒称最终全套成绩。

该次接续结束时真实流程未运行：`s02-runtime-preflight.json`确认原S02 trial已于2026-11-09 05:35:15.395 UTC到期，查询仍待确认、提交0次；当时没有续期、重置或换ID补额。原持久SQL独立正确性已补证，但真实明确执行、一次平台提交、原结果自动解释和正文时序仍缺证。该次官方调用/费用新增均为0，原失败和费用保留；后续用户授权和当前状态只在CURRENT维护。

## 同一账本新验收的运行前限定核对（2026-11-09）

用户随后明确授权只延长原S02 trial窗口，并允许同一账本、同一隔离库追加标注“配置修正后的新验收”的正常请求。正式`run-business-acceptance.mjs`零账本门不删，旧S02冻结profile及失败不改作新配置成绩。一次性脚本位于`.local/checks/interaction-repairs/run-configured-representative.mjs`，不进入产品或新增恢复框架。

一名未参与该脚本实现的审查者仅只读核对该脚本及相关合同/源码，未执行脚本、测试、数据库、网络或真实模型，也未编辑。返回五项验收证明缺口：启动基线未全比费用/额度/指纹；新费用差值未逐回执对账；get_query仅搜索rows文字可被空末页满足；续接仅凭关键词未证同任务/原结果；历史不变快照未含原模型调用回执。主owner在真实调用前分别补全与已授权窗口快照的逐字段比对、冻结费率逐调用向上取整及总差值核算、实际原始行内容核对、正式渲染绑定追溯prepare成功回执的任务/条件/query/result四元组，以及原十次模型回执前后深比较。上述为主owner修正，不伪称修改后第二次独审。

审查者确认独立SQL核验实际执行只读SQL及数据变体，平台代理在Worker启动前接入，未发现该启动顺序漏计提交的确定问题。该核对只证明脚本标准的审查范围，不替代真实运行结果。新增日志、真实调用/费用、正文和当前完成判断在CURRENT登记。

## 非分组整体订单与明细行核验补充独审（2026-11-09）

真实草稿保存后，独立核验因非分组分支直接拒绝已识别的paid_orders/paid_lines而停止，未执行查询。主owner补最小反例后，`s02-overall-metrics-red.log` EXIT=1；仅调整`customer_expectation`非分组聚合，按同一时间、非测试、正支付过滤，从独立合成数据分别核算匿名订单/行、全体订单/行。客户去重仍使用原参考与变体重算，不读取模型结果反写预期，不改保存SQL或参数。`check-business-evaluator.mjs`新增2种正形状及7个错粒度、常数、错误匿名标志、重复和未知角色反例；`s02-overall-metrics-green.log` EXIT=0，13个原参考和全部旧反例仍通过，两份保存SQL及七变体通过。

未参与该修改的同一审查者限定6次工具读取源码小差异和公开seed/etl，返回无确定缺陷：独立聚合符合一般指标定义，无匿名记录的COUNT保留零，固定种子5客户/8订单/10明细与断言一致；既有逐列严格匹配和七变体未放宽。审查者没有编辑、委派、执行测试、数据库、模型、网络或读取凭据，GREEN由主owner实际运行，不冒称审查者复验。当前真实验收进展、原未发送预留与费用只在CURRENT维护。

# 交互等待与流式交付执行包审查

记录范围：2026-11-07两轮Oracle最高5/5与本地审包，以及2026-11-08实施中本地复核。前者的四项必要澄清保持；后者确认六组实施问题并修订原包§3.1，未再次提交Oracle。本报告不代表当前实现验收通过，实际进度只看CURRENT。

## 2026-11-08实施中复核

相对实施者保存的开工指纹核对实际改动，未将先前累积工作算作本轮新增；审计时58份已有文件变化、3份新增文件。主要实现方向沿原包，Pi会话、订阅、活动工具集合、原生压缩和abort继续复用，未发现新Agent或恢复框架。数值格式化依赖和薄字符串渲染器属于原包范围；实现尚有下列问题。

| 问题 | 核实依据 | 性质 |
| --- | --- | --- |
| 两个左花括号间分片失败；普通尾部右花括号不进入chunks | 直接运行当前renderedStream：`成功率为{`接`{rate}}。`返回answer_render_invalid；`这是普通文字}`的streamed与finish.display不同。原check-rendered-text仍通过，反例未被覆盖 | 实现错误及断言缺口 |
| 普通自然尾项仍被吞 | deliver的allTasksFrozen只给rendered例外，natural继续要求!alreadyFrozen | 原包§5.4未完整落实 |
| 工具集与Rust准入不一致 | 直接构造source_context_ready=false的taskProjection，read_analysis_task仍可见；Rust requires_source_context未豁免它。对应测试还要求其可见，另有validate_sql等纯受限工具 | 接线错误及错误测试预期 |
| 短引用被额外限于同恢复链 | runtime/store按recovery_chain_id相等读回执，而新用户消息生成新链；原SearchSelection绑定任务/查询/范围，没有此消息限制 | 过度限制 |
| 表归属与依赖方向越界 | 当前架构脚本实际拒绝runtime/store JOIN conversations；runtime/outputs另反调use_cases::analysis_answers，当前脚本未检查该方向 | 架构规则违反 |
| 旧搜索结果没有Pi context edit短化 | 本轮checkpoint/workspace-context保持原指纹，相关Agent路径无旧游标短化接线；原包§4.2明确要求正常及压缩请求覆盖 | 漏项 |

上述局部复现使用Node 26.8.1，无模型或数据库请求；只读架构检查返回失败。本次没有运行完整构建、数据库端到端、浏览器或真实模型。短游标后页和新prepare交付已有合成通过记录；rendered-freeze-recovery材料能核对原prepare回执/operation/origin保持，不据此扩称全部恢复场景通过。

57份回归日志包含重复批次，不能按数量报进度。最新日志里的旧present目录调用和source_limits字段差异还须实施者分类；早期中间版本编译失败不作为当前编译结论。CURRENT当时仍停留待实施，已更新为纠偏接续。六组的具体修法、文件归属和最小验收只在[原包§3.1](../execution/semantic-runtime/interaction-delivery-repairs.md#31-2026-11-08实施纠偏与接续顺序)维护，不另起执行包或扩展09。

以下为2026-11-07历史审包记录，时间和证据边界保持。

## 范围与证据边界

核对当前试用的应用/平台记录、Pi journal、工具回执、前端事件投影、对应Rust/Node/React源码及锁定Pi 1.3.0。编包基线为`04d27d0`及接手时现有工作树，不把HEAD视作全部实现。本轮不改产品、不重跑查询、不调用产品真实模型、不更新服务、不提交推送。

试用原话和完整数据仅存本地诊断目录，未发送Oracle或写进公开报告。外部咨询只收到脱敏技术事实、源码摘录和修复包。Oracle意见是代码与合同建议，不替代运行验收。

## 已证问题及根因

| 问题 | 已核事实 | 根因与处理 |
| --- | --- | --- |
| 执行后看起来又查了一遍 | 应用与平台都只有一次SQL提交；后续为原结果解释 | 异步解释合理，统一活动提示和迟到等待正文误导；明确阶段与原query归属，不删除解释运行 |
| 等待主要在模型链 | 约93秒确认到结果，真正提交至返回约2秒；此前准备约73秒、随后解释约95秒 | 单样本不能给分位数或收益比例；先去已证的上下文负担和无效往返，网络失败另列 |
| 大游标进入每次模型输入 | 三份回执87,302字节，游标71,126字节，本次并未翻页 | 自包含候选窗口放在模型可见回执；改引用已有持久回执，保原搜索范围/续页行为 |
| 结果解释整段出现 | 前两轮有delta，最终解释只有committed；deliver在grounded候选后抑制delta | 应用交付合同压住Pi原生流；准备值后一次自然正文流，完整来源与输出绑定一起改 |
| 完整解释生成两次 | 先present.template，之后助手复述 | 工具承担全文与自然final重复；prepare只给已核数值，正文只生成一次，不承诺必少一次模型调用 |
| 续接无效读取与空补丁拒绝 | 两次task_context_required，省略unset被拒 | 来源未裁决工具仍可见、空集合形式要求；Pi活动工具集配合现有来源门，unset省略在唯一入口规范化 |
| 正常数字说明被拒，百分比不便显示 | 数字0模板失败、换中文零通过；原ratio只能原值展示 | 字符禁令不证明数字事实，缺展示格式；去字符禁令，新增单值decimal/percent格式，不加计算引擎 |
| 状态和卡片位置不一致 | 完成事件后出现自然waiting正文；findLast用后续状态事件定位卡片 | 提交文案只确认过去事实，当前状态由卡片维护；持久首次锚点跨分页稳定 |
| 冻结后合法尾项会被吞 | selectDelivery先allTasksFrozen/alreadyFrozen，Rust组合同时禁同task尾项 | 本次新交付必须保保存结果等新尾项；按新原entry允许最多一个合法末项，不解除任意重复冻结限制 |

主要问题位于应用工程实现和应用交付合同；没有证据需要替换Pi、MySQL或Milvus。模型网络失败和自由语言质量仍是独立因素，不能全部归因于本包。

## 本地与Oracle的交叉取舍

本地独立草案在Oracle答复前保存。第一轮Oracle使用最高5/5，结论与本地首选一致：prepare绑定、Pi一次正文、原回执短游标、保留快照轮询。下列意见已按源码核对后调整：

| 意见 | 处置与依据 |
| --- | --- |
| 原文hash不能指向渲染后的正文 | 采用独立RenderedAnswerBinding；补source_text，由Node原entry产生，Rust核hash/原prepare/展示chunks，沿现有host信任边界 |
| 增加raw chunks，让Rust逐片渲染 | 未采用本地早期候选。保留AppendOutput及output_chunks为展示文本，Rust仅最终整体重渲染，减少wire与存储变化 |
| 冻结后保存说明不能消失 | 本地确认Node和Rust两侧限制，纳入新交付的窄修复；保每份来源及原容量 |
| 旧cursor上下文hook可能不影响压缩 | 已核锁定Pi prepareCompaction消费buildSessionProjection；用持久context edit处理当前结构化结果，旧summary全面迁移后置 |
| 控制事实够用就可减少读取 | 仅采纳避免无效调用。当前workspace没有完整SQL/参数，执行前get_query仍须保留 |
| 只改等待control即可 | 未采纳。原journal证明迟到句是自然assistant，改稳定事实约定与结构化UI；不宣称任意自然句都能机械验证 |
| 查询卡片用find而非findLast | 只改find不足，首事件可能不在当前页；用conversations既有事件批量读持久锚点，无需新表 |
| 部分结果说明 | 本地补齐required_suffix，流式与最终正文一致保留；不能改造流式时丢范围限制 |
| 来源与数字强保证 | 限于绑定值/来源/格式/身份；自由数字、因果和时态仍依赖模型，禁止用字符检查冒充证明 |

## 执行边界

权威规格见[交互修复执行包](../execution/semantic-runtime/interaction-delivery-repairs.md)。共享Schema、Rust交付入口及Pi交付入口由单owner顺序整合，使用dev_co、contract-first和相称TDD。UI只处理当前阶段、首次锚点和正文层次。

不建新Agent/恢复/压缩框架、游标会话/Redis、任意表达式计算器或持续SSE；不降低模型容量/思考档、不改检索排序、不按座舱字段特判、不为低概率事件增加保护层；不自动刷100题或为强关09跑全套旧电池。

工程验收使用既有接缝，明确真实Pi+合成provider、真实Rust/MySQL、浏览器屏障、获准真实模型代表各证明什么。当前09继续active，其他既有缺口不消失。

## 第二轮结论与最终处置

准确原答复的结论是“补小修后可实施，整体路线成立，没有需要重选方案的阻断项”。四项意见均已采纳，未增加新的产品目标：

| 必要澄清 | 最终落点与本地核对 |
| --- | --- |
| 渲染等式包含范围后缀，区分单份、末项和整轮 | 包§5.3–5.4固定display=单次替换+required_suffix；后缀计入长度/展示chunks，SHA仅原source_text。单份final_text核单份，组合final_text核未冻结末项，整轮沿FinalOutput::compose。旧bound_output_text不直接复用于新路径 |
| 冻结来源和输出消费者识别prepare | 包§5.4点名finalize_in_tx的旧present判断、FinalOutput::answer_sdk_tool_call_ids及covered_notification等消费者；新rendered从已核result_dependencies生成source_query_ids，准备与旧答案身份分开 |
| 普通工具之后恢复原准备表 | 包§5.5明确无完整正文与有完整候选两种恢复：前者沿当前task/condition/source context接有效原回执，后者固定使用binding指定ID；普通读/保存不抹掉准备，不以最后一个工具决定恢复 |
| 一任务冻结后可交一条新保存说明 | 包§5.4保留一任务一冻结part，限定调整最终组合/Schema说明的同task尾项；一个冻结结果加一个新尾项仍是一任务，不增加额度，不突破24项及原字符上界 |

本地复核了`finish_run.rs`候选比较对象、`task_answers.rs`冻结和组合条件、`outputs.rs`旧ID枚举，以及Schema的任务集合说明。Oracle未附的完整消费者链仍须实施时接通并运行验证，本次没有把静态方案审查当作新实现通过。

本地另作三项措辞收敛：一份查询的幂等不限制合法批量SQL；时序图明确经Node受控工具转发；工程出口直接用Make现有目标，不把展开命令重复跑一遍。必要验收并入既有小集，没有新增测试矩阵。

交付前定点核对确认：当前v2执行入口的来源门同样覆盖批量execute，工具可见性依照现有准入事实，不新添逐查询route；来源身份、任务目录和资产停用等已有合法分支继续可用。包§5.4同时将新输出单元的prepare身份写为必接字段，并使用完整FinishRun字段名，避免把必要接线误读为可选工作。

## Oracle证据与工具限制

第一轮已核实发送前最高5/5、实际提交会话及完整网页答复。Oracle wrapper没有识别网页更新后的回答DOM；从同一已提交、准确target只读采集完整答复后，关闭准确owned Chrome并核实临时profile已删除。wrapper退出码为1（浏览器关闭），不能说自动抓取成功；完整答复与最高档证据均已保存。

第二轮发送前后最高5/5均验证，提问和实际提交会话正确；wrapper退出0并自动清理临时浏览器，但自动正文属于无关任务，`oracle session --render`重复同文，因此该份自动输出作废。用户随后回传准确原会话的完整审查答复及两份附件，附件SHA256逐一匹配实际提交清单；本报告基于这份有对应材料的原答复完成核对，不能宣称自动采集成功。

本地资料在`.local/checks/interaction-package-20261107/`，包括独立草案、源码指纹、第一轮完整答复、第二轮用户回传原答复、附件匹配记录、无效采集记录及最终复核。原试用诊断在`.local/checks/manual-dogfood-review-20261107/`，仅本地定位使用，未作为公开附件发送。两轮临时Chrome及复制profile均已清理，没有升级或修改Oracle工具。

## 最终出口

[执行包](../execution/semantic-runtime/interaction-delivery-repairs.md)可交下一位coding agent按序实施，第9节是复制用Prompt；它替代本轮此前草案，不替代整个09的其他缺口。文档格式、链接、CURRENT frontmatter与相关源码指纹已核对。产品行为、真实模型速度和修复后浏览器表现仍由实施阶段相称验证，当前09继续active、review pending、evidence null。

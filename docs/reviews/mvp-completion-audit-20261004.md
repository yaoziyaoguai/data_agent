# MVP 完成度复审

日期：2026-10-04。范围：已确认要求、正式源码、当前验收脚本与本地证据。三路独立只读检查分别覆盖语义/检索、Pi/真实模型路径、正式产品流程；主审复核关键源码并重跑历史拼接与记忆契约探针。

**结论：完整产品 MVP 尚未完成。** React、Rust、MySQL、Pi 及平台 mock 的主要流程已经实现，旧增量收据与当前源码一致；通过这些检查不能说明聊天纠错、长期历史、持续文档维护和真实模型业务能力均已完成。以下实现问题不依赖真实 Datasight 接口就可以修复和验收。

本次未修改业务源码、契约、测试或运行配置，未读取凭据、访问数据库、启停服务或调用模型。仅保存本报告及更正 CURRENT 的完成状态。此前收据和审查保留为历史证据。

| 编号 | 级别 | 确定问题及影响 | 代码与要求依据 | 应补的验收 |
| --- | --- | --- | --- | --- |
| R01 | P1 | Agent 的记忆工具只能新增。先说“以后默认 web”，再说“改成 app，忘掉 web”，无法通过工具修订或停用旧记忆，只能新增冲突记录。管理页可手动编辑，聊天纠错替代仍缺。 | `crates/data-agent/src/use_cases/data_tools.rs:381–405` 固定 `id:null`、`expected_version:null`；`packages/contracts/schema.json:2072–2117` 没有旧资产 ID/版本/停用操作。设计第 14.3 节、第 21 节 D10 要求修订不只追加冲突文字。 | 连续两次互相替代的纠错，跨新会话只采用新偏好；“忘掉旧偏好”后不再采用，旧上下文恢复也不能复活。 |
| R02 | P1 | 正式启动器未接通模型语义预填。使用 `--model deepseek --model-profile ...` 仍没有为 Worker 设置预填 profile/URL，模型凭据只传给 bridge。页面重新分析会因缺预算配置而失败，手工补 profile 后仍缺调用配置。 | `scripts/development.py:97–116`；`crates/data-agent/src/use_cases/semantic_prefill.rs:145–151`；`modules/ingestion/prefill.rs:141–161`。综合测试在 `tests/mvp/run-deepseek-workflow.mjs:69–73` 另行注入配置，未走正式启动路径。 | 以文档中的正式启动方式运行，使用获准的共用预算，从语义页面完成初次/再次分析，并核对人工值保护和账本。先用回环模型验证接线，再在授权内验证质量。 |
| R03 | P2 | 长对话加载旧页后继续聊天，会在页面形成消息缺口。后端每次返回最近 1000 个事件，前端固定旧页后用滚动新页直接拼接。跨页的流式片段和完整回答也可能重复显示。数据库记录仍存在。 | `modules/conversations/store.rs:385–387`；`apps/web/src/features/workbench/Workbench.tsx:77–90,140–151,199–203`；`use_cases/read_conversation.rs:45–88`。对应 D03、D09 及长期多轮要求。 | 超过 1000 个事件后加载历史并继续多轮，确认消息连续、无重复、无相同 React key；跨页输出提交只显示最终回答。事件数不等于用户消息或对话轮数。 |
| R04 | P2 | “全部会话”仅列最近 100 条，返回值没有标题或分页；界面“按标题搜索”实际只能筛 UUID。更早会话没有正式 UI 找回入口。 | `modules/conversations/store.rs:271`；`Workbench.tsx:233,483`。对应 D03、D13。 | 创建超过 100 个会话后可继续翻页并回看；按用户问题标题能找到对应会话。 |
| R05 | P2 | 业务文档创建后不能修改来源链接和关联对象；长文创建允许 100000 字符，编辑只允许 40000，因此一篇 60000 字符文档改一个字也无法保存。 | `KnowledgePage.tsx:46,246`；`packages/contracts/schema.json:1454–1516`；`modules/knowledge/store.rs:170`。对应 D06 的正文、链接、对象关联和版本可维护。 | 修改既有文档的链接/关联对象并保留版本；创建并再次编辑超过 40000 字符的正文；对应权限和旧引用仍正确。 |
| R06 | P2 | 模型缺少可信的当前日期/业务时区。提示要求解析“上个月”“最近 7 天”，宿主上下文、历史工具和当前 Pi 默认提示均未提供时钟。 | `crates/data-agent/src/use_cases/deliver_run.rs:102–125`；`apps/agent/session/resources.ts:13`；`apps/agent/tools/data-tools.ts:15–63`。设计第 13.4 节要求提供日期/业务时区，第 16.3 节明确相对时间修订。 | 请求绑定参考时间和业务时区；相对时间展开正确，跨日恢复不改变原请求的时间含义。 |
| R07 | P1（验收） | 真实业务效果尚未取得完成证据，准备好的真实综合脚本也不足以覆盖约定的起步题。 | 见下方验收核对。 | 完成 S01–S05 的适用范围、B01–B08、代表性 Q/P 题及跨会话纠错/Skill 的业务判断；结果与独立参考比较，正确澄清、事实缺口和失败分别记录。 |

P1/P2 表示本次复审建议的处理优先级，不改变原业务要求。R03–R06 同样属于交付前应补的已确认行为，不能因列为 P2 就默认排除出 MVP。

**历史拼接的无数据库复现**

按现有分页与拼接算法，初始 1200 个消息事件加载完整后，再增加 50 个事件：存储有 1250，界面只有 1200；中间的 201–250 消失，且 `canLoadOlder=false`。主审和产品审查者分别执行了内存探针。此证据属于算法复现，未冒称正式浏览器端到端运行。

```js
const ids = Array.from({ length: 1250 }, (_, i) => i + 1);
const before = ids.slice(0, 1200);
const older = [{ messages: before.slice(0, -1000), has_older: false }];
const after = [...older.flatMap(p => p.messages), ...ids.slice(-1000)];
const missing = ids.filter(id => !after.includes(id));
console.log({ stored: ids.length, visible: after.length,
  missingFrom: missing[0], missingTo: missing.at(-1),
  canLoadOlder: older[0].has_older });
// { stored: 1250, visible: 1200, missingFrom: 201, missingTo: 250, canLoadOlder: false }
```

**验收核对（R07）**

- 主审重新运行 `python3 scripts/check_delivery.py`，退出 0，旧收据与审计前的当前契约/输入一致。这证明此前列出的命令确实通过且文件未漂移。
- 五项绑定验收各自都填写全部 36 个需求编号。这种声明不能证明每个业务行为已被具体用例覆盖；例如契约类型检查不能证明记忆替代、SQL 口径或模型澄清正确。
- `.local/model-workflow/result.json` 不存在；`.local/checks/mvp-deepseek-workflow.json` 是回环协议结果，官方请求为 0，P01–P05 均为 `protocol_only`。
- 旧官方小样只有两次请求，完成建立分析任务和回复。它没有调查语义、生成 SQL 或执行取数；所绑定的 11 个输入已有 9 个变化，保留为历史兼容证据。
- `tests/mvp/run-deepseek-workflow.mjs:55–67` 只测“1 月净收入→app 修订→确认→解释”，解释断言主要检查回答含数值。第 91–97 行检查五字段建议非空、存在引用和人工值保护；官方模式也将业务质量标为 `pending_independent_evaluation`。
- 设计第 20.1 节要求的零金额解释、整月客户去重、退款率分母澄清、标签一对多关联等，尚无这套真实模型验收的对应完成证据。`docs/sources/verify.py` 执行独立参考 SQL，不等于验证模型自己生成的 SQL。

**目录与检索的范围缺口**

当前来源同步固定读取三份合成文件，知识对象来自预先整理的 `semantic-catalog.json`，共 31 个对象（5 表、13 字段、3 指标、8 文档、2 关系）。增加 DDL 表/字段不会自动建立对象，仍需先修改目录；字段类型刷新限定 `demo_order_detail`。依据：`modules/ingestion/store.rs:19–23`、`modules/ingestion/mod.rs:24–30`、`modules/knowledge/store.rs:57–71`、`modules/ingestion/prefill.rs:5–35`。

当前检索只有词法匹配，没有应用级 Embedding/Milvus 组合检索。另有确定的静默截断风险：`modules/knowledge/store.rs:78` 按 `kind,name` 仅读前 5000 对象；`use_cases/knowledge.rs:315–325` 将索引候选限制到这个列表。字段/文档超过 5000 后，后面的指标/表即使精确命中也会被丢弃，且公共知识没有分页或覆盖不足提示。该结论来自完整静态路径核对，未运行扩大目录数据库复现。

全空间、千表扩大验证、真实 Datasight 和实际试用原本就在 I3（设计第 17.2 节及 D04/C06），本次没有发现它们被临时偷偷挪期的证据。真实平台先 mock 是用户已确认的选择，不将“未接公司接口”单独当成本地 MVP 阻断；但当前固定样例和词法检索也不能表述为目标规模的通用语义层已完成。

**应保留的已完成成果**

正式三个入口、Rust 持久状态、SQL 具体版本确认、合成平台真实 SQLite 计算、个人数据隔离、人工覆盖和引用版本检查已有实现与测试。Pi 是唯一生产 Agent 循环，恢复和压缩确实使用 SDK；未发现模拟策略偷偷作为真实 provider 的成功降级，也未发现独立参考答案进入生产模型输入。上述成果支持继续补齐 MVP。

建议接续顺序：修复 R01–R06 并各补针对性反例；把需求与实际行为用例逐项对应；在已有付费边界内完成 R07，未获新预算前继续本地验证；另明确 I3 的目录/检索交付范围和扩大验证。修复后需要重新进行独立审查及生成当前版本收据。

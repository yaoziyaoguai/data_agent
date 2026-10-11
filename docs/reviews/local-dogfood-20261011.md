# 全功能本地试用与修复记录

日期：2026-10-11。当前进度和最终冻结验收收据以 [CURRENT](../CURRENT.md) 为准。基线 `ba21773228e7a73cc69a655f0e46b40d2ea101f6`，保留此前全部未提交成果；本轮不提交推送。

## 本轮结果

按三类角色、三个主入口，实际点击、编辑并核对保存回读。第一轮21个脚本17通过，4个旧观察与现有页面不一致；修正后四项均通过。另有8个恢复/展示/记忆/Pi专项、2个新增浏览器专项。自动化脚本实际运行React、Rust API和独立数据库，不把页面存在当成功。

发现并修复四个通用问题：

| 问题 | 影响与修复 | 复现和回归 |
| --- | --- | --- |
| 新对话导航/刷新丢模型设置 | 未发送选择按用户、空间、会话暂存，现有服务端设置优先 | `new-conversation-before.log` → `first-message-model-after.log` |
| 新对话选Skill后丢草稿和选择 | 创建空会话时迁移未发送草稿；不覆盖目标已有内容、不自动发消息 | 实际浏览器前后记录及新增专项 |
| 回执未知时选Skill误迁草稿 | 独立审查确认：原消息已保存时可另建会话并留下重复未发草稿。现在先核对原回执，不另建会话；原ID和后来草稿均保留 | `new-conversation-pending-before.log` → 新增专项第6组 |
| 选Skill创建的空会话首问后第一次换模型冲突 | 首问使服务端设置版本从0变1；前端在当前页面且选择未变化时接回版本，避免误报其他窗口修改 | `first-message-model-before.log` → 新增专项第3组 |

上述日志位于 `.local/local-dogfood/checks/`。实现不依赖表名、业务关键词或固定答案，不新增Agent规划/会话/记忆框架。Pi循环、SQL授权、预算、服务端版本检查保持原职责。

## 覆盖清单

“浏览器脚本”指真实页面点按与真实API/数据库，本地模型协议替身用于可重复的异常场景。主页面试用使用既有DeepSeek Flash、Mem0及向量服务；所有业务材料是合成的。

| 领域 | 已使用的操作 | 证据 |
| --- | --- | --- |
| 账号与导航 | 三种角色登录/退出，角色加载/失败/撤权、主导航、手机抽屉、键盘与返回对话 | workspace-role、workspace-feedback、experience及角色浏览器脚本；主页面Bob/Carol |
| 对话与历史 | 新建、示例、发送、补充纠错、长期续聊、停止生成、搜索/分页/删除、草稿及未知回执 | management-buttons、history、conversation-reliability、new-conversation-draft；1200事件加载后再增50 |
| 模型设置 | Flash/Pro全部支持档位、设置说明、首次/现有会话保存、刷新、失败恢复、原请求冻结 | model-selection及new-conversation-draft；真实试用使用Flash/关闭 |
| SQL与结果 | 草稿与复制、聊天执行/修改、并发、单条停止、未知回执、完成通知、表格/图表/指标、最终SQL、CSV、依据返回 | query-boundaries、query-stop、background-queries、evidence-return、query-result-statistics；真实查询与独立SQLite对照 |
| 个人记忆 | 新增/编辑/核对、范围与来源、搜索/筛选、启停/删除、本人隔离、Mem0召回与失效 | management-buttons、asset相关脚本、memory-provider/revisions；真实启用召回→停用后同会话不再采用 |
| 个人Skill | 三模板、替换确认、正文/范围/附件、依赖、保存/放弃、启停/删除、选用/移除/重选 | asset-experience/editor/mutation/dependencies、native-skills；真实正文和附件read回执 |
| 公共Skill | 明确发布独立副本、成员选用/提建议、负责人处理/驳回、正文单独保存、隔离 | shared-skills、workspace-feedback、角色脚本；主页面Carol发布、Bob建议 |
| 语义目录 | 按表/全部/负责范围、搜索/筛选/刷新/分页、字段展开、关联血缘、指标SQL、整篇文档、来源/历史 | management、knowledge/related-knowledge、history；230个合成目录对象跨页保持 |
| 语义维护 | 表/字段/指标/文档编辑、放弃/保存、清除覆盖、来源链接、多表关联、启停、常用、负责人调整 | management、creator-ownership、semantic-role-boundaries、analysis-preference；60000→60002字完整回读 |
| 纠错协作 | 私人草稿、共享依据核对、提交/修订/撤回、负责人接受/驳回、核对后正式保存 | semantic-governance/role-boundaries、management；主页面Bob→Carol的时区纠错 |
| 维护操作 | 原有来源同步、预填、索引重建，成功/失败、版本冲突、人工保护 | workspace-feedback、prefill、index-concurrency、maintenance-browser；维护用隔离数据与Milvus集合 |
| 异常与恢复 | 回执丢失、旧响应、并发、停用/撤权、重启、空/过期/失败结果、宽表滚动 | conversation-reliability、asset-mutation、model-selection、query-boundaries、memory/native-skills、message-markdown等 |

## 真实模型和主页面证据

- 本轮合成库存记忆由Carol明确录入，Skill附带 `references/checklist.md`，经发布预览后生成空间公共副本。
- 工具回执确认两次Pi原生 `read` 分别读取Skill正文和附件；`search_knowledge` 的 `memory_retrieval=mem0_authoritative`，返回本人记忆的当前版本。首次有一次错误读取被拒绝，模型随后通过搜索得到有效资料并完成解释；没有伪装读取成功。
- 同一会话继续问订单明细，先只生成SQL，下一条明确执行才提交。结果14行、12个订单，渠道web/app/store为6/6/2，正支付12行、正退款4行、正净额10行。独立直接查询合成SQLite得到完全相同的统计；页面预览10行，点击CSV、图表/指标、最终SQL、口径依据及返回对话。
- 停用该记忆后，在原会话询问当前个人记忆。新回复明确没有启用中的记忆，没有沿用旧约定；随后通过页面重新启用。Bob的个人记忆为空，能看到明确发布的公共Skill，不能看到Carol私人记忆。
- 主页面创建并完整编辑一篇三章节文档，阅读预览与保存一致。Bob只能提纠错，不能直接编辑Carol文档；负责人接受与正式保存分别操作。公共方法建议同样不自动改正文。
- 此会话共有17次已结算真实模型请求，包含工具往返与结果解释；不是17个用户问题，也不是整体准确率样本。自动化检查的官方模型调用为0。本轮手工记忆和语义编辑会使用现有embedding配置，未声称向量调用为0。

原始材料位于 `.local/local-dogfood/`：`live-tools.json`、`live-memory-skill-tools.jsonl`、`live-query-complete.txt`、`query-independent-reference.json`、`live-memory-after-disable.txt`、`live-bob-personal-isolation.txt`、`live-correction-submitted.txt`。不公开凭据、浏览器存储或任何真实业务数据。

## 测试观察修正

1. query-stop仅首次登录等待模型目录准备完成，运行中立即可发的原断言保留。
2. history按会话行计数，使用整篇文档编辑器和名称选择关联资料；原文长度、版本、关联顺序及外部修改刷新断言保持。
3. 390px角色检查先打开空间导航并等真实角色，退出仍走界面。
4. 公共Skill外部修改后触发已有focus刷新；不把30秒超时与30秒空闲周期相撞解释为产品失败。

初次失败保存在 `checks/report.json` 及同名日志，不以修后结果覆盖历史。补充8项结果见 `supplementary/report.json`。独立审查见 [审查记录](local-dogfood-review.json)。最终统一验收由 `make verify-increment` 执行，收据与运行范围记录于CURRENT。

## 证据边界

本轮覆盖当前可见入口和关键成功/失败/恢复分支，没有穷举任意输入与并发组合。Datasight仍是可执行合成平台，真实接入权限和生产容量未因此得到证明。真实模型只有上述代表性流程，不据此宣称100%正确或全量准确率。没有扩大同步缓冲方案、模型或记忆选型。

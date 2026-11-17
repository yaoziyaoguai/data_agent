# 历史05专用提示（已被当前接续入口替代）

**当前接手不要执行下面的历史提示。** 原08已取得23组通过收据并关闭；下一步是[关闭后复审的14项修复](closure-repairs.md)，使用[CONTINUATION_PROMPT.md](CONTINUATION_PROMPT.md)，完成新修复增量后停止。具体取舍与审包就绪状态见CURRENT。下面保留的是05当时的任务与证据边界，不授权重做05、重新关闭原08或进入09。

状态以[CURRENT](../../CURRENT.md)为准；本提示当时与[05详细执行包](hybrid-retrieval.md)一起交给实施者。2026-10-28续审撤回了“前四切片已完成”的旧声明。

当时后续06–09另有连续提示；现 [CONTINUATION_PROMPT](CONTINUATION_PROMPT.md) 已更新为关闭后复审修复接续。[Pi复用约束](pi-reuse.md)仍为业务/SDK边界依据。以下正文只保存历史任务，不作为当前授权。

```text
接续 Data Agent 的05混合检索改造。先修完05内部剩余主链并取得当前指纹的独立审查和真实绑定验收，然后停止；不执行06–09，不重新立项。

先读 AGENTS.md、docs/CURRENT.md 顶部最新记录和delivery.increment，再读：
- docs/reviews/hybrid-resume-audit-20261028.md
- docs/execution/semantic-runtime/hybrid-retrieval.md
- docs/execution/semantic-runtime/coverage-and-validation.md
- docs/execution/semantic-runtime/cross-validation.md 最新两次Oracle处置
- docs/architecture/implementation-design.md 17.1、17.3.2、17.4、17.5、17.6、17.6.1。

核实当前分支、HEAD和未提交工作。全部保留，不reset/覆盖。旧“前四切片完成”、旧passed报告和旧指纹均不能用于关闭当前05。CURRENT列出的本轮已修行为先保留、做相称回归，不重新写一套。尤其保留耗尽收敛与发送资格分开、冻结profile原trial登记、存储错误传播、投影外完整来源最终重核、结构引用窄读、当前列绑定的必要DDL核验、共享在途候选额度和原Embedding结算等待。新列绑定反例已经纳入verify-hybrid-scope：保留人工原值与合法needs_review，不能用“保存时已验证”删除当前绑定检查。

按详细包五条纵向顺序逐条TDD，实际核心剩两条：
1. 用真实entry/statement/window身份替换对象级候选/缓存/30主命中读取名额。SQL与Milvus必须复用同一确定性索引投影的规范内容单元，不能一个按query造窗口、另一个按索引片段却称同身份。raw绑定record_kind/owner/SourceKey/修订/locator/切块版本；knowledge绑定原EvidenceRef/entry-path/修订/适用statement_id/规范窗口/投影版本。hash核内容，不代替身份；相交窗口仅交付合并。owner只读已选内容和必要支持，不再hints OR全query词展开全文。原ref/Unicode坐标可同版补读，标题不进offset、文档保持有效entry以\n\n拼接；完整有效性依据、实际贡献来源与裁剪后登记分开，legacy不能因裁小正文推窄来源。
2. 在现有search_stage_outside_lock中闭合同一推进链：有效交付不足才扩深，已知必要支持沿原定点补读路径；dense真实后页、partial保留、失败片不拖健康片。整条BM25明确不可用即启动SQL首批，SQL替代词法票，不当第三票；成功空或已有成功片/页不加SQL。继续分配正文前处理所有已就绪通道，慢后页不能阻塞另一通道。SQL强项测试固定其在名额耗尽前已就绪且应入选，实际迟到则如实bounded，不退款追补。最后内部raw+knowledge进入同一stage已回源命中及核验依据、同一RRF和最终owner修订核验；v1仅末端对象聚合，不手拼raw数组、不新增v2端点。

统一计数：1000=规范唯一已收身份+在途预留，失败/重复释放未用预留但失效已收不退款；5=同一owner实际派发的共享深度，首批1、同轮通道/分片共轮号，迟到dense/SQL不重置，不取各路max冒充共享；30=按内容身份启动owner主命中读取占用，批读多个逐项计、失败不退、重复复用。必要支持不占主命中名额，沿现行每回执50项、容量和共同期限，不新增支持上限。各后端按真实消费位置推进，SQL也报告耗尽事实。

期限相关证据也必须补齐：范围准备前同一10秒期限；独立延迟范围/元信息/正文/结算，证明迟到正文不交付、已读内容保留、没有新检索；普通读取错误也等待本次原Embedding结算并处理结果，不能因跨期吞错。账本可写的成功、已知未发送和阻塞后恢复场景，响应时原operation/attempt不得残留issued；结算存储自身失败则明确报错、保留原身份并沿既有恢复，不假零消耗、不无限重试、不加后台恢复器。10秒是工作期限，必要提交/结算可晚于它。保持三种许可时点语义、原operation/attempt/trial/budget，不退款、不换身份重发unknown。

必需反例详见包：巨大命中entry的小窗口、非首statement、同对象E1先到E2后到；投影外来源锁外换版和回执裁剪；dense-only第201条、少量正文失效后补后页、共享30耗尽反向例；两路在途最后100名额、SQL展示窗口不同但同规范record去重；慢后页、BM25失败+已就绪SQL强项；真实切块>129尾部、整理pending/failed独立例、raw/knowledge全局交错及raw锁外回读后换版拒绝。公开v1场景走登记→执行→回源→最终核验→裁剪保存，内部双类型走同一个正式组合入口和最终核验。协议数组、GET、索引存在或局部helper测试不能替代最终交付。

四条约束必须落实：
- 只修有证据的普通失败；未知发生率写未知。新提极低概率边界先给触发、证据、代价等用户决定，禁止理论保护膨胀。
- 同一外部边界校验一次，内部用类型；独立请求、新权限状态与异步后版本/租约重核不能删。
- 一次性简单逻辑默认内联；仅真实复用或清楚owner职责抽取，不建调度/预算/恢复/权限框架。
- 默认直接传播错误；只在明确可恢复边界分状态处理，不多层catch、重试或空成功。替代链通过后删除旧职责，不叠第三条路径。

使用已安装dev_co，新增行为逐条红→绿；跨语言合同有变化才用contract-first和packages/contracts唯一真源。代码/测试命名用业务含义，不含M编号、包号、step/phase标签。MySQL正式内容、Milvus可重建公共索引、Mem0个人记忆、Pi原生Skill不变；Pi仍是唯一Agent/会话/压缩/恢复，保持24次/消息、连续临时失败3次。

数据库harness串行（verify-architecture也含DB），不make -j；测试子进程清除DEEPSEEK_API_KEY、DEEPSEEK_BASE_URL、DEEPSEEK_MODEL、DATA_AGENT_MODEL_PROFILE、DATA_AGENT_MODEL_FAULT。Rust变更后先离线锁定重建API/Worker再跑E2E，避免拿旧二进制报绿。用隔离合成MySQL、专用Milvus和本地Embedding协议替身；不碰主库、不输出凭据。父Node提供代理的Rust子进程须异步等待，不能execFileSync卡死代理。失败按实际证据定位，不预设Defender原因。

把新增反例接入Makefile与CURRENT绑定验收，先窄检查再相关回归、verify-contracts/verify-code及05四组验收。由未参与相应实现者独立审查；最后真实运行make verify-delivery与make verify-increment。缺证/失败/过期指纹保持active，不能手写passed。更新受影响接口文档与CURRENT；图仅在边界/拓扑变化时更新。

授权只有代码、相称验证和相关文档；无付费API、提交推送、部署或日常服务更新授权。完成05后报告实际删除/替换、当前证据、未验证范围和06入口，然后停止。
```

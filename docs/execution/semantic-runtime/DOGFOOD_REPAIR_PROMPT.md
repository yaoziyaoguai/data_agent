# Data Agent 可用性收口接续 Prompt

在 AGENTS.md 指定的唯一仓库继续修复。先核分支和工作树，接手记录为 codex/local-trial-closure / 04d27d0；保留所有累计未提交改动，不 reset、不在旧 worktree 维护第二份源码。

使用已安装 dev_co。启动只读 AGENTS.md、docs/CURRENT.md 的最新摘要与 delivery.increment、docs/execution/semantic-runtime/dogfood-report-repairs.md 的入口与执行顺序。进入任务再读对应章节/源码/证据；详细审计在 docs/reviews/data-agent-readiness-audit-20261116.md。不从头重读 CURRENT 历史、不重开九阶段。

按执行包连续推进：
1. 先删除 ready 解锁时过滤 assistant thinking 的错误逻辑，按真实 Pi/provider 协议纠正测试，保持来源门、权限、原生压缩与恢复。免费验证默认 DeepSeek 和另一不同协议的实际 SDK 序列化。
2. 定点收口两项首败：准备租约错误 owner 负例锁超时、固定 250ms 等待后领取为空；保 TTL、领取时原有 epoch 递增/attempt 断言和原 7 项组合。只对有证据的原因修代码，无法还原的历史原因留 unknown，不为“已修复”制造修改。查 P06 Bridge 原轨迹，不足时只补既有错误边界的安全故障定位，不加重试框架。
3. 先复用有效证据、补无外发 UI/权限步骤；具备有效费用授权后再跑 S08 代表、固定 core_21 缺项和必过来源续接，不重跑全部 100 题。不把 Skill 七步通过等同记忆/附件全部通过，不重发 T02 已接收消息。
4. 沿原维护 owner 分清分片估计与有独立依据的收费上界，预留/实际输出 cap/结算绑定原调用，不回退到当前 profile；复用已有冻结关联与先提交结算的事务出口，旧 issued/unknown 按原合同保持，不预先新建迁移。免费反例、正常材料与已知超界用量持久结算检查先做。获得有效授权后才开最小真实新增/变更→整理→索引→检索回源闭环。不能等待证明供应商私有模板，也不能把估计冒充硬上界。
5. 完成文档、当前报告、未参与实现者独审和原 50 条完整验收。工程、真实核心、维护、I3/09 分别给结论；未完成的留 active。

修复按 TDD 小步；跨语言合同实际变化才用 contract-first。已通过的默认配置、测试隔离、P06 范围纠错、P05/P07、Skill 七步不重做。保原 50 条 expected/requirements/超时、core_21、来源轨迹、完整 100/10 分母和原失败；不删场景、降断言、改题、换 mock 或把记录检查当业务通过。纠正错误 fixture 需写独立依据和原/新预期。

Pi 1.3.0 是唯一 Agent/压缩/恢复/重试机制。正常产品不恢复累计调用、默认费用、总时长硬帽；3 次连续临时失败停止、成功清零和单请求/端点限制保持。原 100 元是独立的 dogfood 总授权，已花与四笔 unknown 不清；先读实时账本、子帽、有效期和在途状态。当前聊天余额不足一次最坏预留、维护/embedding 原期限已到，不自动延期、互挪、换 trial/scope 或付费重发。免费工作先完成，之后一次列清所需范围请求授权；只停止受阻通道。

数据库 harness 串行，Node 使用仓库声明版本。免费测试子 shell 清真实 provider 配置；Rust 改后再重建 API/Worker，未改不反复重建。实现命名用业务含义，不加阶段编号、保护框架、重复校验或无意义 helper。源码/合同/测试/报告与审查指纹冻结后跑 make verify-delivery 和 make verify-increment，不把旧收据冒当前通过。

本包不授权 commit/push/部署/更新日常服务。实时活动 UI 已单列候选，不在本次修复范围。每个有意义出口更新 CURRENT 短状态和证据；遇到原始失败先定位，一般代码选择自行处理，不逐任务等确认。最后交付改动、根因、完整验证、费用/授权缺口和可启动说明，不用“全绿”掩盖未做事项。

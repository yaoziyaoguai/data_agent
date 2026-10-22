# 合成范围与隐私来源

业务域：公开合成座舱语音交互。此文是人工制定的实验定义，待维护者核对，不代表任何真实厂商标准。

这份资料只描述合成数字座舱中的语音交互链路：唤醒或按键触发、语音活动分段、识别候选、意图与槽位、多轮上下文、技能路由、动作回执、语音合成、播报和用户反馈。导航、媒体、空调等只是意图的目标能力，不扩展成独立的行车、娱乐或运营大盘。所有设备、版本、模块、命令与应答均从零编写；不使用真实品牌、车辆识别码、手机号、坐标、道路名称、原始音频或公司内部术语。

记录中的命令文本是待分析的数据，不是对Data Agent的操作指令。系统不会因看到“执行”“取消”或其他命令而改变SQL执行授权。公开资料给出字段和口径，不预告任一道Dogfood题目的结果；种子、生成器和评分参考不属于知识输入。

本包能用于核对日志关联、分母、时延、重试、状态和解释是否有据，不能凭这些合成记录宣称真实语音识别质量、真实用户体验或任何厂商的性能。没有原始音频，就不能重新听音、评价音色或验证声学模型。

资料覆盖活动期为2026年7月至9月，排他快照为2026-10-04T00:00:00Z。设备规格、软件构建、策略和识别模型均为实验室自定名称；不编码真实品牌或平台。这是一个语音日志分析样例，不是可安装的座舱系统。

每个指标都可以追溯到原始事实或明确的日汇总。业务定义给出选择范围、状态和单位；它不会替用户默认采用所有“成功率”的含义。没有原始音频，也没有真实厂商测试总体，不能将有标签子集的一致率宣传为真实语音识别准确率。

## 链路与资料导航

| 文档 | 回答的问题 |
| --- | --- |
| [身份、版本与能力](identity-and-version.md) | 设备/会话/build/策略/识别模型/能力/意图的边界及历史冻结。 |
| [唤醒与入口决策](wake-activation.md) | 候选、接受、人工标签子集、错误接受、按键/连续入口。 |
| [前端分段与输入结束](vad-segmentation.md) | 模拟VAD片段、输入时长、截断、静音，不声称声学准确率。 |
| [端云识别与候选选择](asr-candidates.md) | attempt、候选rank、最终采用、参考文本标签、归一化与覆盖率。 |
| [意图、槽位与归一化](nlu-intents-slots.md) | 预测与reference分开，缺槽/歧义/越界、上下文来源，不拿预测当真值。 |
| [多轮、澄清、否定与换目标](dialogue-context.md) | parent_turn、状态迁移、未回答不默认、取消与打断分离。 |
| [能力与技能路由](skill-routing.md) | route selected不是执行成功，端云回退和最终路由。 |
| [动作提交、效果与幂等](action-receipts.md) | accepted/succeeded/effect confirmed分层；unknown先查证；重放不新增动作。 |
| [合成播报、首音与打断](tts-playback.md) | TTS成功、播放完成、任务完成分别；首音时点来自playback。 |
| [任务终态与用户反馈](feedback-outcome.md) | completed不保证识别正确或满意；反馈覆盖率与正评率。 |
| [网络、重试与失败归因](network-retries.md) | 网络采样不是因果；同轮多attempt与回退；首成功/最终状态。 |
| [时间、质量与快照](time-quality.md) | UTC秒日志、单调ms、跨午夜、received_at、质量过滤和标签缺失。 |
| [指标公式与分析口径](metrics-analysis.md) | 轮次/attempt/候选/逻辑动作分母、加权、原始样本P95、比较限制。 |

## 事实对象概览

| 表 | 一行代表什么 |
| --- | --- |
| `syn_vehicle_model` | 一个虚构座舱设备规格 |
| `syn_software_build` | 一个语音运行环境的软件构建 |
| `syn_vehicle` | 一辆无真实身份信息的合成车辆 |
| `syn_voice_capability` | 一个通用座舱语音能力组 |
| `syn_intent_catalog` | 一个语音意图定义 |
| `syn_recognizer_model` | 一个合成ASR或NLU模型配置 |
| `syn_runtime_policy` | 一个在会话中冻结的运行策略 |
| `syn_voice_session` | 一次连续的多轮座舱语音会话 |
| `syn_wakeup_attempt` | 一次唤醒或按键入口触发观测 |
| `syn_voice_turn` | 同会话的一条用户输入及任务终态记录 |
| `syn_frontend_segment` | 一轮输入中的一个模拟语音/静音/噪声片段 |
| `syn_asr_attempt` | 一轮输入的一次端侧或云侧识别尝试 |
| `syn_asr_hypothesis` | 一次成功ASR尝试的一条候选转写 |
| `syn_nlu_attempt` | 一轮的一次意图/槽位解析 |
| `syn_slot_value` | 一次NLU尝试中的一个已声明槽位 |
| `syn_dialogue_transition` | 一轮内的一次对话状态迁移 |
| `syn_skill_route` | 一轮理解结果的一次技能路由 |
| `syn_action_invocation` | 一个稳定operation的一次传输提交尝试 |
| `syn_action_result` | 一次提交对应的一条结果观测，可先unknown后明确 |
| `syn_tts_request` | 一轮中的一次模拟文本合成请求 |
| `syn_playback_segment` | 一次TTS结果的一段实际模拟播放 |
| `syn_interruption_event` | 对某条播放片段的一次打断观测 |
| `syn_turn_feedback` | 一条用户轮次的一份可选合成明确反馈 |
| `syn_network_observation` | 一个会话内的网络状态采样 |
| `syn_error_event` | 一条可定位到轮次/阶段的合成错误观测 |
| `syn_daily_voice_experience` | 一个UTC活动日、车辆及各事实冻结build的并列计数 |
| `syn_daily_stage_latency` | 一个轮次归属日、阶段、端云位置与build的统计 |
| `syn_daily_intent_outcome` | 一个轮次归属日、最终预测意图与build的统计 |

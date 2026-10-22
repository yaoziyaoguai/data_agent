# 公开合成座舱语音交互资料

业务域标识：`cockpit_voice`。

本包围绕唤醒/按键入口、VAD、ASR候选、NLU槽位、多轮上下文、技能路由、执行回执、TTS、播报与反馈建立语义。导航、媒体、空调只作为意图目标能力，不提供独立业务大盘。所有实体和命令从零构造，没有读取真实公司资料；不包含品牌、VIN、个人身份、真实轨迹或原始音频。

活动期：2026-07-01T00:00:00Z（含）至2026-10-01T00:00:00Z（不含）。排他快照：2026-10-04T00:00:00Z。默认语言、入口、端云和版本均需以事实记录为准，不把某次样例的默认值推成所有记录的保证。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [合成范围与隐私来源](documents/overview.md) | 无音频、真实用户、品牌、VIN、真实地理或公司术语；只分析人工合成交互日志。 |
| [身份、版本与能力](documents/identity-and-version.md) | 设备/会话/build/策略/识别模型/能力/意图的边界及历史冻结。 |
| [唤醒与入口决策](documents/wake-activation.md) | 候选、接受、人工标签子集、错误接受、按键/连续入口。 |
| [前端分段与输入结束](documents/vad-segmentation.md) | 模拟VAD片段、输入时长、截断、静音，不声称声学准确率。 |
| [端云识别与候选选择](documents/asr-candidates.md) | attempt、候选rank、最终采用、参考文本标签、归一化与覆盖率。 |
| [意图、槽位与归一化](documents/nlu-intents-slots.md) | 预测与reference分开，缺槽/歧义/越界、上下文来源，不拿预测当真值。 |
| [多轮、澄清、否定与换目标](documents/dialogue-context.md) | parent_turn、状态迁移、未回答不默认、取消与打断分离。 |
| [能力与技能路由](documents/skill-routing.md) | route selected不是执行成功，端云回退和最终路由。 |
| [动作提交、效果与幂等](documents/action-receipts.md) | accepted/succeeded/effect confirmed分层；unknown先查证；重放不新增动作。 |
| [合成播报、首音与打断](documents/tts-playback.md) | TTS成功、播放完成、任务完成分别；首音时点来自playback。 |
| [任务终态与用户反馈](documents/feedback-outcome.md) | completed不保证识别正确或满意；反馈覆盖率与正评率。 |
| [网络、重试与失败归因](documents/network-retries.md) | 网络采样不是因果；同轮多attempt与回退；首成功/最终状态。 |
| [时间、质量与快照](documents/time-quality.md) | UTC秒日志、单调ms、跨午夜、received_at、质量过滤和标签缺失。 |
| [指标公式与分析口径](documents/metrics-analysis.md) | 轮次/attempt/候选/逻辑动作分母、加权、原始样本P95、比较限制。 |

## 阅读与分析顺序

先确定统计单位是入口候选、用户轮次、阶段尝试、候选文本、槽位、逻辑动作还是播放片段；再确认时间队列、快照、版本和资格。读取字段与关联定义，避免把一对多事实直接JOIN后累加。查看指标定义中的分子、分母和空值规则，必要时向提出问题的人澄清，而不是自动选一个看起来接近的成功率。

本包的日表是快照下的派生事实。`syn_daily_voice_experience`并列保存session日、wake日、turn日计数，不能同日相除当成同批漏斗。ASR/意图一致率只针对人工合成标签子集，标签缺失不是失败标签，缺预测也不能从分母中删除。P95按原始非空样本最近秩计算，分母为零的比例返回NULL。

## 来源边界

知识允许列表只包含本索引、14份业务文档、DDL与ETL。`seed.sql`、`domain-spec.json`、生成器、验证脚本和Dogfood评分参考不进入检索或提示；它们分别负责造数和独立验收。业务定义与实际结果分开：本文不包含任何场景的预期数值，也不把合成演示当作真实语音模型效果。

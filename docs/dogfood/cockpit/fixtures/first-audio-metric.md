# {{run_prefix}}输入结束到实际首音P95

粒度：一条有效语音轮次。范围：授权、非实验车辆，完整有效session与valid turn；turn.started_at的UTC半开区间，事实业务时间和received早于快照。

取syn_playback_segment中played_ms>0的最早start_offset_ms，减syn_voice_turn.input_ms，单位ms。没有可听片段的轮次保留为缺测，不填0，也不进入时延样本数。样本排序后最近秩位置ceil(0.95*n)，空样本P95=NULL、样本数0。

依赖syn_voice_turn、syn_voice_session、syn_vehicle、syn_playback_segment及tts-playback业务定义。只描述指标，未由真实生产数据验证。

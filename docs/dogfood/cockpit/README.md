# 座舱语音交互 Dogfood 包

这套资料供另一位 coding agent 实际试用 Data Agent。共100项，从读懂资料、单环节统计逐步走到多表、多轮、报告、个人资产、权限与中断恢复。全部从 `not_run` 开始；准备校验通过不表示产品已经通过试用。

业务资料是从零构造的语音交互日志：唤醒/VAD → ASR候选 → NLU和槽位 → 多轮对话 → 技能路由 → 动作与回执 → TTS → 播报、打断和反馈。车辆、软件构建、语言与网络用作分析维度。没有原始录音、真实车主、公司名称、真实车型或真实业务资料。

| 层级 | 内容 | 数量 |
| --- | --- | ---: |
| L0 | 资料、身份、模型入口、时间和口径 | 10 |
| L1 | 逐环节统计、草稿与执行 | 20 |
| L2 | 多表关联、重试、分母、NULL、版本、延迟 | 20 |
| L3 | 澄清、独立目标、批量执行、取消、续接、分页 | 15 |
| L4 | 多来源报告、个人方法、记忆、公开副本 | 15 |
| L5 | 语义维护、纠错、预填、归属、模型管理和权限 | 10 |
| L6 | 全链路、版本比较、回退、多轮复盘和恢复 | 10 |

先读[开始说明](START.md)，把[执行Prompt](AGENT_PROMPT.md)交给试用Agent。阅读长用例时用[可搜索导航](guide.html)或分批命令。完整操作在[用例手册](CASES.md)，[操作约定](OPERATIONS.md)说明隔离和证据，[评分说明](GRADING.md)区分通过、失败与未验证。

```sh
python3 docs/dogfood/cockpit/build.py --list
python3 docs/dogfood/cockpit/build.py --case S01
python3 docs/dogfood/cockpit/build.py --level 2
python3 docs/dogfood/cockpit/build.py --order
python3 docs/dogfood/cockpit/build.py --case S03 --messages-only --run-prefix voice-local-01
python3 docs/dogfood/cockpit/verify.py
```

`--order`遵守对象依赖，G10清理放最后。级别代表难度，依赖可能跨级别；例如引用展示需要先有报告。`--messages-only`只输出产品应收到的输入，其余验收和参考留在操作者侧。

来源为[28表、421字段、14文档和26指标](../../sources/cockpit/README.md)。`manifest.json`保存资料和包文件指纹，`coverage.json`映射全部28表与14文档的场景。覆盖映射表示用例安排，不保证每字段每组合均已实测。能力范围与证据限制见[SCOPE.md](SCOPE.md)。

`reference/`有52条独立SQL和冻结结果摘要；核心计数、ASR、标签匹配、首音、动作效果与反馈还经过原始行Python计算交叉核对。所有参考通过实际合成平台的编译、执行和结果分页，包含超过1000行的截断场景。这些只是数据/工具通路证据，0模型请求，没有代跑新Dogfood。

试用结果放忽略目录 `.local/dogfood-runs/<run_id>/`。从[结果模板](records/results-template.json)开始，每批更新[交接模板](records/HANDOFF-template.md)，最终使用[报告模板](records/REPORT-template.md)。`grade.py`检查状态与证据完整性，不会自动把自然语言判断成正确，也不会修改试用结果。

只有来源的 `knowledge-manifest.json` 允许项进入产品知识。这个包、参考、答案、种子和生成器都不能输入产品模型。`fixtures/`是特定场景允许的公开合成输入，只按需使用，不整目录上传。

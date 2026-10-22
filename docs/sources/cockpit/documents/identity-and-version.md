# 身份、版本与能力

业务域：公开合成座舱语音交互。此文是人工制定的实验定义，待维护者核对，不代表任何真实厂商标准。

本包的身份层级是车辆、会话、轮次、阶段尝试及尝试产物。session_id是一段连续语音会话，turn_id是一条输入及其任务终态；同一会话可包含多个目标，parent_turn_id记录沿用或取消的前一目标。这里没有另外一张独立“请求表”或“对话表”，分析时必须说明实际采用哪个键计数。

分析历史事实时沿记录冻结的build_id和policy_id，不用设备当前版本重标以前的轮次。ASR与NLU的识别器配置、技能实现和软件build分别表达，不能把相似显示名称当作同一套配置。能力启用只表示具备资格，不等于已经调用或执行成功。

所有身份都是匿名合成编码。音区和语言用于业务分组，不代表真实人员身份。版本间的总体差异还可能来自入口、网络、意图及端云路径构成；这些资料没有随机实验分配，不能仅凭分组差异得出升级的因果效果。



## `syn_vehicle_model` · 合成座舱设备型号

仅为语音链路分析提供硬件分层，不代表真实设备、厂商或性能测量。

- 行粒度：一个虚构座舱设备规格
- 主键：`model_id`
- 唯一键：除主键外未额外声明
- 时间口径：维度按快照读取；事实按各自文档时点与接收截止核对。

| 字段 | SQLite 类型 / 空值 | 单位 | 含义与限定 |
| --- | --- | --- | --- |
| `model_id` | TEXT / NOT NULL | — | 合成规格标识，不编码品牌。 |
| `model_name` | TEXT / NOT NULL | — | 虚构型号名。 |
| `hardware_family` | TEXT / NOT NULL | — | 抽象硬件族。 |
| `microphone_zone_count` | INTEGER / NOT NULL | count | 模拟拾音区域数量；无原始音频。 下界：0。 |
| `speaker_zone_count` | INTEGER / NOT NULL | count | 可播报音区数量。 下界：0。 |
| `memory_capacity_mib` | INTEGER / NOT NULL | MiB | 规格内存。 下界：1。 |
| `edge_compute_tier` | TEXT / NOT NULL | — | 合成端侧算力档位。 允许值：basic, standard, extended。 |
| `supports_barge_in` | INTEGER / NOT NULL | boolean | 规格是否支持播报打断。 允许值：0, 1。 |
| `supports_offline_asr` | INTEGER / NOT NULL | boolean | 规格是否支持离线识别。 允许值：0, 1。 |
| `supported_locales` | TEXT / NOT NULL | — | 逗号分隔的公开locale标签。 |
| `introduced_date` | TEXT / NOT NULL | UTC date | 规格加入本包的UTC日期。 |
| `is_simulated` | INTEGER / NOT NULL | boolean | 固定1，表明人工合成。 允许值：0, 1。 |

约束：

- `is_simulated=1`

## `syn_software_build` · 合成软件构建

build是会话冻结维度，不从车辆当前build重写历史。该包不含OTA业务表。

- 行粒度：一个语音运行环境的软件构建
- 主键：`build_id`
- 唯一键：除主键外未额外声明
- 时间口径：维度按快照读取；事实按各自文档时点与接收截止核对。

| 字段 | SQLite 类型 / 空值 | 单位 | 含义与限定 |
| --- | --- | --- | --- |
| `build_id` | TEXT / NOT NULL | — | 构建主键。 |
| `build_label` | TEXT / NOT NULL | — | 从零命名的合成版本。 |
| `released_at` | TEXT / NOT NULL | UTC RFC3339 second | 最早允许运行此构建的时点。 |
| `base_build_id` | TEXT / NULL | — | 基线构建；首版为NULL。 引用`syn_software_build.build_id`。 |
| `release_track` | TEXT / NOT NULL | — | 合成发布轨道。 允许值：lab, trial。 |
| `protocol_revision` | INTEGER / NOT NULL | — | 日志/协议代次。 下界：1。 |
| `dialogue_engine_revision` | INTEGER / NOT NULL | — | 合成对话引擎代次。 下界：1。 |
| `routing_revision` | INTEGER / NOT NULL | — | 合成技能路由代次。 下界：1。 |
| `default_locale` | TEXT / NOT NULL | — | 默认公开locale。 允许值：zh-CN, en-US。 |
| `allows_cloud_fallback` | INTEGER / NOT NULL | boolean | 构建是否允许端云回退；具体请求以policy为准。 允许值：0, 1。 |
| `is_withdrawn` | INTEGER / NOT NULL | boolean | 快照时是否停止新部署，不删除历史会话。 允许值：0, 1。 |
| `withdrawn_at` | TEXT / NULL | UTC RFC3339 second | 撤回时点，未撤回为NULL。 |

约束：

- `(is_withdrawn=0 AND withdrawn_at IS NULL) OR (is_withdrawn=1 AND withdrawn_at IS NOT NULL)`

## `syn_vehicle` · 合成语音设备

默认体验指标限定telemetry_consent=1且is_lab_unit=0。没有VIN、账号、手机号、GPS或公司标识。

- 行粒度：一辆无真实身份信息的合成车辆
- 主键：`vehicle_id`
- 唯一键：除主键外未额外声明
- 时间口径：维度按快照读取；事实按各自文档时点与接收截止核对。

| 字段 | SQLite 类型 / 空值 | 单位 | 含义与限定 |
| --- | --- | --- | --- |
| `vehicle_id` | TEXT / NOT NULL | — | 合成设备号，不是VIN。 |
| `model_id` | TEXT / NOT NULL | — | 设备规格。 引用`syn_vehicle_model.model_id`。 |
| `fleet_group` | TEXT / NOT NULL | — | 虚构分组。 允许值：group_a, group_b, group_c。 |
| `region_code` | TEXT / NOT NULL | — | 抽象区域，不表示真实地点。 允许值：zone_n, zone_s, zone_e, zone_w。 |
| `enrolled_at` | TEXT / NOT NULL | UTC RFC3339 second | 加入观察的时点。 |
| `first_activated_at` | TEXT / NOT NULL | UTC RFC3339 second | 最早可产生有效语音会话的时点。 |
| `current_build_id` | TEXT / NOT NULL | — | 快照末的构建；只用于库存观察，不代表历史。 引用`syn_software_build.build_id`。 |
| `telemetry_consent` | INTEGER / NOT NULL | boolean | 合成遥测允许标记；为0不生成有效交互事实。 允许值：0, 1。 |
| `is_lab_unit` | INTEGER / NOT NULL | boolean | 实验设备；默认运营指标排除。 允许值：0, 1。 |
| `business_timezone` | TEXT / NOT NULL | — | 本包固定UTC。 允许值：UTC。 |
| `default_locale` | TEXT / NOT NULL | — | 设备默认locale。 允许值：zh-CN, en-US。 |
| `retired_at` | TEXT / NULL | UTC RFC3339 second | 退出观察时点，未退出NULL。 |
| `identity_policy` | TEXT / NOT NULL | — | 固定合成身份声明。 允许值：synthetic_only。 |

约束：

- `first_activated_at >= enrolled_at`
- `retired_at IS NULL OR retired_at > first_activated_at`

## `syn_voice_capability` · 语音能力组

空调、媒体、导航等只作为语音意图目标，不建立独立业务运营大盘。

- 行粒度：一个通用座舱语音能力组
- 主键：`capability_id`
- 唯一键：除主键外未额外声明
- 时间口径：维度按快照读取；事实按各自文档时点与接收截止核对。

| 字段 | SQLite 类型 / 空值 | 单位 | 含义与限定 |
| --- | --- | --- | --- |
| `capability_id` | TEXT / NOT NULL | — | 能力组标识。 |
| `capability_name` | TEXT / NOT NULL | — | 通用业务名称。 |
| `domain_code` | TEXT / NOT NULL | — | 能力域。 允许值：climate, media, navigation, vehicle_status, system_settings, assistant_help, communication。 |
| `execution_kind` | TEXT / NOT NULL | — | 本地动作、信息读取或模拟外部动作。 允许值：local_action, read_only, simulated_remote。 |
| `requires_network` | INTEGER / NOT NULL | boolean | 配置上的网络需求，不是某次失败的成因证据。 允许值：0, 1。 |
| `supports_context` | INTEGER / NOT NULL | boolean | 是否可利用先前轮次补槽。 允许值：0, 1。 |
| `supports_cancel` | INTEGER / NOT NULL | boolean | 是否允许用户取消。 允许值：0, 1。 |
| `supports_clarification` | INTEGER / NOT NULL | boolean | 是否可询问缺失信息。 允许值：0, 1。 |
| `latency_budget_ms` | INTEGER / NOT NULL | ms | 能力标称任务处理预算。 下界：0。 |
| `seat_scope` | TEXT / NOT NULL | — | 允许发起音区。 允许值：driver, front, all。 |
| `capability_state` | TEXT / NOT NULL | — | 快照时能力状态。 允许值：active, deprecated。 |
| `scope_note` | TEXT / NOT NULL | — | 能力边界，只保留通用合成动作。 |

## `syn_intent_catalog` · 意图与必填槽位

意图定义不是模型预测。人工合成reference_intent_id与预测predicted_intent_id分开保存，准确率只对有标签子集报告。

- 行粒度：一个语音意图定义
- 主键：`intent_id`
- 唯一键：除主键外未额外声明
- 时间口径：维度按快照读取；事实按各自文档时点与接收截止核对。

| 字段 | SQLite 类型 / 空值 | 单位 | 含义与限定 |
| --- | --- | --- | --- |
| `intent_id` | TEXT / NOT NULL | — | 稳定意图标识。 |
| `capability_id` | TEXT / NOT NULL | — | 所属能力组。 引用`syn_voice_capability.capability_id`。 |
| `intent_name` | TEXT / NOT NULL | — | 面向人的意图名称。 |
| `action_name` | TEXT / NOT NULL | — | 对应的合成动作名；纯对话意图使用none。 |
| `required_slot_names` | TEXT / NOT NULL | — | 逗号分隔的必填槽位名，无则空串。 |
| `optional_slot_names` | TEXT / NOT NULL | — | 逗号分隔的可选槽位名。 |
| `slot_validation_rule` | TEXT / NOT NULL | — | 人工制定的合成参数规则，如温度范围；不推断未写的限制。 |
| `may_use_context` | INTEGER / NOT NULL | boolean | 是否可从先前有效轮次取得缺失槽位。 允许值：0, 1。 |
| `requires_effect_receipt` | INTEGER / NOT NULL | boolean | 任务完成是否要求实际效果回执。 允许值：0, 1。 |
| `confirmation_mode` | TEXT / NOT NULL | — | 该合成意图是否需额外确认。 允许值：none, clarify_missing。 |
| `intent_state` | TEXT / NOT NULL | — | 定义状态。 允许值：active, deprecated。 |
| `example_command` | TEXT / NOT NULL | — | 从零构造的通用例句，不来自真实用户。 |

## `syn_recognizer_model` · 识别与理解模型

这里只模拟端云配置和输出日志，不宣称这些配置是可执行识别模型，也不据此评估真实声学性能。

- 行粒度：一个合成ASR或NLU模型配置
- 主键：`recognizer_id`
- 唯一键：除主键外未额外声明
- 时间口径：维度按快照读取；事实按各自文档时点与接收截止核对。

| 字段 | SQLite 类型 / 空值 | 单位 | 含义与限定 |
| --- | --- | --- | --- |
| `recognizer_id` | TEXT / NOT NULL | — | 合成处理模型标识。 |
| `recognizer_name` | TEXT / NOT NULL | — | 虚构配置名，不使用真实供应商。 |
| `component` | TEXT / NOT NULL | — | 处理环节。 允许值：asr, nlu。 |
| `endpoint_kind` | TEXT / NOT NULL | — | 运行位置。 允许值：edge, cloud。 |
| `model_revision` | TEXT / NOT NULL | — | 合成模型代次。 |
| `locale` | TEXT / NOT NULL | — | 适用locale。 允许值：zh-CN, en-US。 |
| `available_from` | TEXT / NOT NULL | UTC RFC3339 second | 配置可用起点。 |
| `available_until` | TEXT / NULL | UTC RFC3339 second | 配置截止时点，无截止NULL。 |
| `timeout_ms` | INTEGER / NOT NULL | ms | 本配置默认超时。 下界：0。 |
| `supports_streaming` | INTEGER / NOT NULL | boolean | 是否支持流式处理。 允许值：0, 1。 |
| `supports_context_bias` | INTEGER / NOT NULL | boolean | 是否可利用已知上下文。 允许值：0, 1。 |
| `training_origin` | TEXT / NOT NULL | — | 固定说明，不暗示使用真实训练资料。 允许值：synthetic_profile_only。 |

## `syn_runtime_policy` · 交互运行策略

策略冻结在voice_session中。上限是配置，不是实际尝试次数；回退或重试不能凭空证明用户目标成功。

- 行粒度：一个在会话中冻结的运行策略
- 主键：`policy_id`
- 唯一键：除主键外未额外声明
- 时间口径：维度按快照读取；事实按各自文档时点与接收截止核对。

| 字段 | SQLite 类型 / 空值 | 单位 | 含义与限定 |
| --- | --- | --- | --- |
| `policy_id` | TEXT / NOT NULL | — | 策略标识。 |
| `policy_name` | TEXT / NOT NULL | — | 合成策略名称。 |
| `valid_from` | TEXT / NOT NULL | UTC RFC3339 second | 生效起点。 |
| `valid_until` | TEXT / NULL | UTC RFC3339 second | 失效起点，NULL表示无已知结束。 |
| `endpoint_preference` | TEXT / NOT NULL | — | ASR/NLU识别理解的端云偏好，不改变能力动作的执行位置。 允许值：edge_only, cloud_preferred, adaptive。 |
| `asr_max_attempts` | INTEGER / NOT NULL | — | 每轮ASR尝试上限。 下界：1。 上界：3。 |
| `nlu_max_attempts` | INTEGER / NOT NULL | — | 每轮NLU尝试上限。 下界：1。 上界：3。 |
| `action_max_attempts` | INTEGER / NOT NULL | — | 同operation的传输尝试上限。 下界：1。 上界：3。 |
| `clarification_max_turns` | INTEGER / NOT NULL | — | 同一目标允许的合成澄清轮数。 下界：1。 上界：4。 |
| `turn_timeout_ms` | INTEGER / NOT NULL | ms | 本策略端到端处理期限。 下界：0。 |
| `allow_barge_in` | INTEGER / NOT NULL | boolean | 允许播报被新输入打断。 允许值：0, 1。 |
| `allow_context_carry` | INTEGER / NOT NULL | boolean | 允许使用同会话前文补槽。 允许值：0, 1。 |
| `late_response_policy` | TEXT / NOT NULL | — | 旧请求晚回执处理方式。 允许值：discard, accept_if_pending。 |
| `cloud_rtt_threshold_ms` | INTEGER / NOT NULL | ms | 选择云处理时采用的模拟RTT阈值。 下界：0。 |
| `fallback_policy` | TEXT / NOT NULL | — | 云失败后是否允许端侧回退。 允许值：edge_fallback, none。 |
| `deduplicate_actions` | INTEGER / NOT NULL | boolean | 必须按operation_key接回重复动作回执。 允许值：0, 1。 |

## 可机读定义

以下记录是上文的明确结构定义，目录生成器只复用这些定义并与实际DDL核对；没有种子安排或用例预期值。

```semantic-definitions
{"kind":"table","table":"syn_vehicle_model","label":"合成座舱设备型号","grain":"一个虚构座舱设备规格","primary_key":["model_id"],"unique_keys":[],"description":"仅为语音链路分析提供硬件分层，不代表真实设备、厂商或性能测量。","time_basis":"维度按快照读取；事实按各自文档时点与接收截止核对。","checks":["is_simulated=1"],"time_columns":[{"column":"introduced_date","role":"business"}],"default_filters":[]}
{"kind":"field","table":"syn_vehicle_model","name":"model_id","type":"TEXT","nullable":false,"meaning":"合成规格标识，不编码品牌。"}
{"kind":"field","table":"syn_vehicle_model","name":"model_name","type":"TEXT","nullable":false,"meaning":"虚构型号名。"}
{"kind":"field","table":"syn_vehicle_model","name":"hardware_family","type":"TEXT","nullable":false,"meaning":"抽象硬件族。"}
{"kind":"field","table":"syn_vehicle_model","name":"microphone_zone_count","type":"INTEGER","nullable":false,"meaning":"模拟拾音区域数量；无原始音频。","unit":"count","minimum":0}
{"kind":"field","table":"syn_vehicle_model","name":"speaker_zone_count","type":"INTEGER","nullable":false,"meaning":"可播报音区数量。","unit":"count","minimum":0}
{"kind":"field","table":"syn_vehicle_model","name":"memory_capacity_mib","type":"INTEGER","nullable":false,"meaning":"规格内存。","unit":"MiB","minimum":1}
{"kind":"field","table":"syn_vehicle_model","name":"edge_compute_tier","type":"TEXT","nullable":false,"meaning":"合成端侧算力档位。","enum":["basic","standard","extended"]}
{"kind":"field","table":"syn_vehicle_model","name":"supports_barge_in","type":"INTEGER","nullable":false,"meaning":"规格是否支持播报打断。","unit":"boolean","enum":[0,1]}
{"kind":"field","table":"syn_vehicle_model","name":"supports_offline_asr","type":"INTEGER","nullable":false,"meaning":"规格是否支持离线识别。","unit":"boolean","enum":[0,1]}
{"kind":"field","table":"syn_vehicle_model","name":"supported_locales","type":"TEXT","nullable":false,"meaning":"逗号分隔的公开locale标签。"}
{"kind":"field","table":"syn_vehicle_model","name":"introduced_date","type":"TEXT","nullable":false,"meaning":"规格加入本包的UTC日期。","unit":"UTC date"}
{"kind":"field","table":"syn_vehicle_model","name":"is_simulated","type":"INTEGER","nullable":false,"meaning":"固定1，表明人工合成。","unit":"boolean","enum":[0,1]}
{"kind":"table","table":"syn_software_build","label":"合成软件构建","grain":"一个语音运行环境的软件构建","primary_key":["build_id"],"unique_keys":[],"description":"build是会话冻结维度，不从车辆当前build重写历史。该包不含OTA业务表。","time_basis":"维度按快照读取；事实按各自文档时点与接收截止核对。","checks":["(is_withdrawn=0 AND withdrawn_at IS NULL) OR (is_withdrawn=1 AND withdrawn_at IS NOT NULL)"],"time_columns":[{"column":"released_at","role":"business"},{"column":"withdrawn_at","role":"business"}],"default_filters":[]}
{"kind":"field","table":"syn_software_build","name":"build_id","type":"TEXT","nullable":false,"meaning":"构建主键。"}
{"kind":"field","table":"syn_software_build","name":"build_label","type":"TEXT","nullable":false,"meaning":"从零命名的合成版本。"}
{"kind":"field","table":"syn_software_build","name":"released_at","type":"TEXT","nullable":false,"meaning":"最早允许运行此构建的时点。","unit":"UTC RFC3339 second"}
{"kind":"field","table":"syn_software_build","name":"base_build_id","type":"TEXT","nullable":true,"meaning":"基线构建；首版为NULL。","references":{"table":"syn_software_build","column":"build_id"}}
{"kind":"field","table":"syn_software_build","name":"release_track","type":"TEXT","nullable":false,"meaning":"合成发布轨道。","enum":["lab","trial"]}
{"kind":"field","table":"syn_software_build","name":"protocol_revision","type":"INTEGER","nullable":false,"meaning":"日志/协议代次。","minimum":1}
{"kind":"field","table":"syn_software_build","name":"dialogue_engine_revision","type":"INTEGER","nullable":false,"meaning":"合成对话引擎代次。","minimum":1}
{"kind":"field","table":"syn_software_build","name":"routing_revision","type":"INTEGER","nullable":false,"meaning":"合成技能路由代次。","minimum":1}
{"kind":"field","table":"syn_software_build","name":"default_locale","type":"TEXT","nullable":false,"meaning":"默认公开locale。","enum":["zh-CN","en-US"]}
{"kind":"field","table":"syn_software_build","name":"allows_cloud_fallback","type":"INTEGER","nullable":false,"meaning":"构建是否允许端云回退；具体请求以policy为准。","unit":"boolean","enum":[0,1]}
{"kind":"field","table":"syn_software_build","name":"is_withdrawn","type":"INTEGER","nullable":false,"meaning":"快照时是否停止新部署，不删除历史会话。","unit":"boolean","enum":[0,1]}
{"kind":"field","table":"syn_software_build","name":"withdrawn_at","type":"TEXT","nullable":true,"meaning":"撤回时点，未撤回为NULL。","unit":"UTC RFC3339 second"}
{"kind":"table","table":"syn_vehicle","label":"合成语音设备","grain":"一辆无真实身份信息的合成车辆","primary_key":["vehicle_id"],"unique_keys":[],"description":"默认体验指标限定telemetry_consent=1且is_lab_unit=0。没有VIN、账号、手机号、GPS或公司标识。","time_basis":"维度按快照读取；事实按各自文档时点与接收截止核对。","checks":["first_activated_at >= enrolled_at","retired_at IS NULL OR retired_at > first_activated_at"],"time_columns":[{"column":"enrolled_at","role":"business"},{"column":"first_activated_at","role":"business"},{"column":"retired_at","role":"business"}],"default_filters":["telemetry_consent = 1","is_lab_unit = 0"]}
{"kind":"field","table":"syn_vehicle","name":"vehicle_id","type":"TEXT","nullable":false,"meaning":"合成设备号，不是VIN。"}
{"kind":"field","table":"syn_vehicle","name":"model_id","type":"TEXT","nullable":false,"meaning":"设备规格。","references":{"table":"syn_vehicle_model","column":"model_id"}}
{"kind":"field","table":"syn_vehicle","name":"fleet_group","type":"TEXT","nullable":false,"meaning":"虚构分组。","enum":["group_a","group_b","group_c"]}
{"kind":"field","table":"syn_vehicle","name":"region_code","type":"TEXT","nullable":false,"meaning":"抽象区域，不表示真实地点。","enum":["zone_n","zone_s","zone_e","zone_w"]}
{"kind":"field","table":"syn_vehicle","name":"enrolled_at","type":"TEXT","nullable":false,"meaning":"加入观察的时点。","unit":"UTC RFC3339 second"}
{"kind":"field","table":"syn_vehicle","name":"first_activated_at","type":"TEXT","nullable":false,"meaning":"最早可产生有效语音会话的时点。","unit":"UTC RFC3339 second"}
{"kind":"field","table":"syn_vehicle","name":"current_build_id","type":"TEXT","nullable":false,"meaning":"快照末的构建；只用于库存观察，不代表历史。","references":{"table":"syn_software_build","column":"build_id"}}
{"kind":"field","table":"syn_vehicle","name":"telemetry_consent","type":"INTEGER","nullable":false,"meaning":"合成遥测允许标记；为0不生成有效交互事实。","unit":"boolean","enum":[0,1]}
{"kind":"field","table":"syn_vehicle","name":"is_lab_unit","type":"INTEGER","nullable":false,"meaning":"实验设备；默认运营指标排除。","unit":"boolean","enum":[0,1]}
{"kind":"field","table":"syn_vehicle","name":"business_timezone","type":"TEXT","nullable":false,"meaning":"本包固定UTC。","enum":["UTC"]}
{"kind":"field","table":"syn_vehicle","name":"default_locale","type":"TEXT","nullable":false,"meaning":"设备默认locale。","enum":["zh-CN","en-US"]}
{"kind":"field","table":"syn_vehicle","name":"retired_at","type":"TEXT","nullable":true,"meaning":"退出观察时点，未退出NULL。","unit":"UTC RFC3339 second"}
{"kind":"field","table":"syn_vehicle","name":"identity_policy","type":"TEXT","nullable":false,"meaning":"固定合成身份声明。","enum":["synthetic_only"]}
{"kind":"table","table":"syn_voice_capability","label":"语音能力组","grain":"一个通用座舱语音能力组","primary_key":["capability_id"],"unique_keys":[],"description":"空调、媒体、导航等只作为语音意图目标，不建立独立业务运营大盘。","time_basis":"维度按快照读取；事实按各自文档时点与接收截止核对。","checks":[],"time_columns":[],"default_filters":[]}
{"kind":"field","table":"syn_voice_capability","name":"capability_id","type":"TEXT","nullable":false,"meaning":"能力组标识。"}
{"kind":"field","table":"syn_voice_capability","name":"capability_name","type":"TEXT","nullable":false,"meaning":"通用业务名称。"}
{"kind":"field","table":"syn_voice_capability","name":"domain_code","type":"TEXT","nullable":false,"meaning":"能力域。","enum":["climate","media","navigation","vehicle_status","system_settings","assistant_help","communication"]}
{"kind":"field","table":"syn_voice_capability","name":"execution_kind","type":"TEXT","nullable":false,"meaning":"本地动作、信息读取或模拟外部动作。","enum":["local_action","read_only","simulated_remote"]}
{"kind":"field","table":"syn_voice_capability","name":"requires_network","type":"INTEGER","nullable":false,"meaning":"配置上的网络需求，不是某次失败的成因证据。","unit":"boolean","enum":[0,1]}
{"kind":"field","table":"syn_voice_capability","name":"supports_context","type":"INTEGER","nullable":false,"meaning":"是否可利用先前轮次补槽。","unit":"boolean","enum":[0,1]}
{"kind":"field","table":"syn_voice_capability","name":"supports_cancel","type":"INTEGER","nullable":false,"meaning":"是否允许用户取消。","unit":"boolean","enum":[0,1]}
{"kind":"field","table":"syn_voice_capability","name":"supports_clarification","type":"INTEGER","nullable":false,"meaning":"是否可询问缺失信息。","unit":"boolean","enum":[0,1]}
{"kind":"field","table":"syn_voice_capability","name":"latency_budget_ms","type":"INTEGER","nullable":false,"meaning":"能力标称任务处理预算。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_voice_capability","name":"seat_scope","type":"TEXT","nullable":false,"meaning":"允许发起音区。","enum":["driver","front","all"]}
{"kind":"field","table":"syn_voice_capability","name":"capability_state","type":"TEXT","nullable":false,"meaning":"快照时能力状态。","enum":["active","deprecated"]}
{"kind":"field","table":"syn_voice_capability","name":"scope_note","type":"TEXT","nullable":false,"meaning":"能力边界，只保留通用合成动作。"}
{"kind":"table","table":"syn_intent_catalog","label":"意图与必填槽位","grain":"一个语音意图定义","primary_key":["intent_id"],"unique_keys":[],"description":"意图定义不是模型预测。人工合成reference_intent_id与预测predicted_intent_id分开保存，准确率只对有标签子集报告。","time_basis":"维度按快照读取；事实按各自文档时点与接收截止核对。","checks":[],"time_columns":[],"default_filters":[]}
{"kind":"field","table":"syn_intent_catalog","name":"intent_id","type":"TEXT","nullable":false,"meaning":"稳定意图标识。"}
{"kind":"field","table":"syn_intent_catalog","name":"capability_id","type":"TEXT","nullable":false,"meaning":"所属能力组。","references":{"table":"syn_voice_capability","column":"capability_id"}}
{"kind":"field","table":"syn_intent_catalog","name":"intent_name","type":"TEXT","nullable":false,"meaning":"面向人的意图名称。"}
{"kind":"field","table":"syn_intent_catalog","name":"action_name","type":"TEXT","nullable":false,"meaning":"对应的合成动作名；纯对话意图使用none。"}
{"kind":"field","table":"syn_intent_catalog","name":"required_slot_names","type":"TEXT","nullable":false,"meaning":"逗号分隔的必填槽位名，无则空串。"}
{"kind":"field","table":"syn_intent_catalog","name":"optional_slot_names","type":"TEXT","nullable":false,"meaning":"逗号分隔的可选槽位名。"}
{"kind":"field","table":"syn_intent_catalog","name":"slot_validation_rule","type":"TEXT","nullable":false,"meaning":"人工制定的合成参数规则，如温度范围；不推断未写的限制。"}
{"kind":"field","table":"syn_intent_catalog","name":"may_use_context","type":"INTEGER","nullable":false,"meaning":"是否可从先前有效轮次取得缺失槽位。","unit":"boolean","enum":[0,1]}
{"kind":"field","table":"syn_intent_catalog","name":"requires_effect_receipt","type":"INTEGER","nullable":false,"meaning":"任务完成是否要求实际效果回执。","unit":"boolean","enum":[0,1]}
{"kind":"field","table":"syn_intent_catalog","name":"confirmation_mode","type":"TEXT","nullable":false,"meaning":"该合成意图是否需额外确认。","enum":["none","clarify_missing"]}
{"kind":"field","table":"syn_intent_catalog","name":"intent_state","type":"TEXT","nullable":false,"meaning":"定义状态。","enum":["active","deprecated"]}
{"kind":"field","table":"syn_intent_catalog","name":"example_command","type":"TEXT","nullable":false,"meaning":"从零构造的通用例句，不来自真实用户。"}
{"kind":"table","table":"syn_recognizer_model","label":"识别与理解模型","grain":"一个合成ASR或NLU模型配置","primary_key":["recognizer_id"],"unique_keys":[],"description":"这里只模拟端云配置和输出日志，不宣称这些配置是可执行识别模型，也不据此评估真实声学性能。","time_basis":"维度按快照读取；事实按各自文档时点与接收截止核对。","checks":[],"time_columns":[],"default_filters":[]}
{"kind":"field","table":"syn_recognizer_model","name":"recognizer_id","type":"TEXT","nullable":false,"meaning":"合成处理模型标识。"}
{"kind":"field","table":"syn_recognizer_model","name":"recognizer_name","type":"TEXT","nullable":false,"meaning":"虚构配置名，不使用真实供应商。"}
{"kind":"field","table":"syn_recognizer_model","name":"component","type":"TEXT","nullable":false,"meaning":"处理环节。","enum":["asr","nlu"]}
{"kind":"field","table":"syn_recognizer_model","name":"endpoint_kind","type":"TEXT","nullable":false,"meaning":"运行位置。","enum":["edge","cloud"]}
{"kind":"field","table":"syn_recognizer_model","name":"model_revision","type":"TEXT","nullable":false,"meaning":"合成模型代次。"}
{"kind":"field","table":"syn_recognizer_model","name":"locale","type":"TEXT","nullable":false,"meaning":"适用locale。","enum":["zh-CN","en-US"]}
{"kind":"field","table":"syn_recognizer_model","name":"available_from","type":"TEXT","nullable":false,"meaning":"配置可用起点。","unit":"UTC RFC3339 second"}
{"kind":"field","table":"syn_recognizer_model","name":"available_until","type":"TEXT","nullable":true,"meaning":"配置截止时点，无截止NULL。","unit":"UTC RFC3339 second"}
{"kind":"field","table":"syn_recognizer_model","name":"timeout_ms","type":"INTEGER","nullable":false,"meaning":"本配置默认超时。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_recognizer_model","name":"supports_streaming","type":"INTEGER","nullable":false,"meaning":"是否支持流式处理。","unit":"boolean","enum":[0,1]}
{"kind":"field","table":"syn_recognizer_model","name":"supports_context_bias","type":"INTEGER","nullable":false,"meaning":"是否可利用已知上下文。","unit":"boolean","enum":[0,1]}
{"kind":"field","table":"syn_recognizer_model","name":"training_origin","type":"TEXT","nullable":false,"meaning":"固定说明，不暗示使用真实训练资料。","enum":["synthetic_profile_only"]}
{"kind":"table","table":"syn_runtime_policy","label":"交互运行策略","grain":"一个在会话中冻结的运行策略","primary_key":["policy_id"],"unique_keys":[],"description":"策略冻结在voice_session中。上限是配置，不是实际尝试次数；回退或重试不能凭空证明用户目标成功。","time_basis":"维度按快照读取；事实按各自文档时点与接收截止核对。","checks":[],"time_columns":[],"default_filters":[]}
{"kind":"field","table":"syn_runtime_policy","name":"policy_id","type":"TEXT","nullable":false,"meaning":"策略标识。"}
{"kind":"field","table":"syn_runtime_policy","name":"policy_name","type":"TEXT","nullable":false,"meaning":"合成策略名称。"}
{"kind":"field","table":"syn_runtime_policy","name":"valid_from","type":"TEXT","nullable":false,"meaning":"生效起点。","unit":"UTC RFC3339 second"}
{"kind":"field","table":"syn_runtime_policy","name":"valid_until","type":"TEXT","nullable":true,"meaning":"失效起点，NULL表示无已知结束。","unit":"UTC RFC3339 second"}
{"kind":"field","table":"syn_runtime_policy","name":"endpoint_preference","type":"TEXT","nullable":false,"meaning":"ASR/NLU识别理解的端云偏好，不改变能力动作的执行位置。","enum":["edge_only","cloud_preferred","adaptive"]}
{"kind":"field","table":"syn_runtime_policy","name":"asr_max_attempts","type":"INTEGER","nullable":false,"meaning":"每轮ASR尝试上限。","minimum":1,"maximum":3}
{"kind":"field","table":"syn_runtime_policy","name":"nlu_max_attempts","type":"INTEGER","nullable":false,"meaning":"每轮NLU尝试上限。","minimum":1,"maximum":3}
{"kind":"field","table":"syn_runtime_policy","name":"action_max_attempts","type":"INTEGER","nullable":false,"meaning":"同operation的传输尝试上限。","minimum":1,"maximum":3}
{"kind":"field","table":"syn_runtime_policy","name":"clarification_max_turns","type":"INTEGER","nullable":false,"meaning":"同一目标允许的合成澄清轮数。","minimum":1,"maximum":4}
{"kind":"field","table":"syn_runtime_policy","name":"turn_timeout_ms","type":"INTEGER","nullable":false,"meaning":"本策略端到端处理期限。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_runtime_policy","name":"allow_barge_in","type":"INTEGER","nullable":false,"meaning":"允许播报被新输入打断。","unit":"boolean","enum":[0,1]}
{"kind":"field","table":"syn_runtime_policy","name":"allow_context_carry","type":"INTEGER","nullable":false,"meaning":"允许使用同会话前文补槽。","unit":"boolean","enum":[0,1]}
{"kind":"field","table":"syn_runtime_policy","name":"late_response_policy","type":"TEXT","nullable":false,"meaning":"旧请求晚回执处理方式。","enum":["discard","accept_if_pending"]}
{"kind":"field","table":"syn_runtime_policy","name":"cloud_rtt_threshold_ms","type":"INTEGER","nullable":false,"meaning":"选择云处理时采用的模拟RTT阈值。","unit":"ms","minimum":0}
{"kind":"field","table":"syn_runtime_policy","name":"fallback_policy","type":"TEXT","nullable":false,"meaning":"云失败后是否允许端侧回退。","enum":["edge_fallback","none"]}
{"kind":"field","table":"syn_runtime_policy","name":"deduplicate_actions","type":"INTEGER","nullable":false,"meaning":"必须按operation_key接回重复动作回执。","unit":"boolean","enum":[0,1]}
```

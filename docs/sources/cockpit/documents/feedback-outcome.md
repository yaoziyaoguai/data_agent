# 任务终态与用户反馈

业务域：公开合成座舱语音交互。此文是人工制定的实验定义，待维护者核对，不代表任何真实厂商标准。

技术链成功、动作效果确认、播报完成和用户满意是不同维度。技术记录成功但得到negative反馈并不矛盾；没有反馈不能算满意。重复追问或切换操作在本包中没有被定义为隐式评价，不能据此替用户填入rating。

syn_turn_feedback的一行是一份明确的合成轮次反馈，turn_id唯一且不能为空，一轮至多一份；本包没有会话级反馈、未归属反馈或多次评分修订。is_explicit固定为1，rating只允许positive、neutral和negative。comment_text是人工合成评语，不是真实用户调研。

正评率仅在可见有效反馈子集中计算，并同时报告反馈覆盖率。量表代次rating_scale_revision不同的记录比较时需说明一致性。本包没有真实用户画像或对照实验，不能从这些合成评价推断真实人群偏好或因果结论。

一条轮次最多一份明确反馈，is_explicit固定为1；rating只允许positive、neutral、negative。feedback_coverage的分母是全部可见有效轮次，positive_feedback_rate的分母只包含有反馈轮次。两者必须分开，未反馈不能补成positive或negative。

## `syn_turn_feedback` · 交互反馈

满意率只在有可见明确反馈的子集中报告覆盖率。任务执行成功也可能获得负面反馈。

- 行粒度：一条用户轮次的一份可选合成明确反馈
- 主键：`feedback_id`
- 唯一键：(turn_id)
- 时间口径：维度按快照读取；事实按各自文档时点与接收截止核对。

| 字段 | SQLite 类型 / 空值 | 单位 | 含义与限定 |
| --- | --- | --- | --- |
| `feedback_id` | TEXT / NOT NULL | — | 反馈主键。 |
| `turn_id` | TEXT / NOT NULL | — | 被评价的轮次。 引用`syn_voice_turn.turn_id`。 |
| `collected_at` | TEXT / NOT NULL | UTC RFC3339 second | 反馈发生时点。 |
| `rating` | TEXT / NOT NULL | — | 明确评价，不反馈不等于满意。 允许值：positive, neutral, negative。 |
| `reason_category` | TEXT / NOT NULL | — | 合成反馈分类。 允许值：correct, wrong_action, slow, no_response, stopped, unclear。 |
| `feedback_source` | TEXT / NOT NULL | — | 固定人工合成标签，不是真实调研。 允许值：synthetic_authored。 |
| `is_explicit` | INTEGER / NOT NULL | boolean | 固定1；不存在隐式满意推断。 允许值：0, 1。 |
| `comment_text` | TEXT / NULL | — | 可选从零构造的简短评语，无则NULL。 |
| `rating_scale_revision` | INTEGER / NOT NULL | — | 反馈量表代次。 下界：1。 |
| `received_at` | TEXT / NOT NULL | UTC RFC3339 second | 该规范记录进入快照的接收时间；received_at必须早于snapshot_exclusive才可用于快照统计。 |
| `quality_state` | TEXT / NOT NULL | — | 记录质量；默认指标仅采用valid，invalid保留用于质量排查。 允许值：valid, invalid。 |

约束：

- `is_explicit=1`

## 可机读定义

以下记录是上文的明确结构定义，目录生成器只复用这些定义并与实际DDL核对；没有种子安排或用例预期值。

```semantic-definitions
{"kind":"table","table":"syn_turn_feedback","label":"交互反馈","grain":"一条用户轮次的一份可选合成明确反馈","primary_key":["feedback_id"],"unique_keys":[["turn_id"]],"description":"满意率只在有可见明确反馈的子集中报告覆盖率。任务执行成功也可能获得负面反馈。","time_basis":"维度按快照读取；事实按各自文档时点与接收截止核对。","checks":["is_explicit=1"],"time_columns":[{"column":"collected_at","role":"business"},{"column":"received_at","role":"received"}],"default_filters":["quality_state = 'valid'"]}
{"kind":"field","table":"syn_turn_feedback","name":"feedback_id","type":"TEXT","nullable":false,"meaning":"反馈主键。"}
{"kind":"field","table":"syn_turn_feedback","name":"turn_id","type":"TEXT","nullable":false,"meaning":"被评价的轮次。","references":{"table":"syn_voice_turn","column":"turn_id"}}
{"kind":"field","table":"syn_turn_feedback","name":"collected_at","type":"TEXT","nullable":false,"meaning":"反馈发生时点。","unit":"UTC RFC3339 second"}
{"kind":"field","table":"syn_turn_feedback","name":"rating","type":"TEXT","nullable":false,"meaning":"明确评价，不反馈不等于满意。","enum":["positive","neutral","negative"]}
{"kind":"field","table":"syn_turn_feedback","name":"reason_category","type":"TEXT","nullable":false,"meaning":"合成反馈分类。","enum":["correct","wrong_action","slow","no_response","stopped","unclear"]}
{"kind":"field","table":"syn_turn_feedback","name":"feedback_source","type":"TEXT","nullable":false,"meaning":"固定人工合成标签，不是真实调研。","enum":["synthetic_authored"]}
{"kind":"field","table":"syn_turn_feedback","name":"is_explicit","type":"INTEGER","nullable":false,"meaning":"固定1；不存在隐式满意推断。","unit":"boolean","enum":[0,1]}
{"kind":"field","table":"syn_turn_feedback","name":"comment_text","type":"TEXT","nullable":true,"meaning":"可选从零构造的简短评语，无则NULL。"}
{"kind":"field","table":"syn_turn_feedback","name":"rating_scale_revision","type":"INTEGER","nullable":false,"meaning":"反馈量表代次。","minimum":1}
{"kind":"field","table":"syn_turn_feedback","name":"received_at","type":"TEXT","nullable":false,"meaning":"该规范记录进入快照的接收时间；received_at必须早于snapshot_exclusive才可用于快照统计。","unit":"UTC RFC3339 second"}
{"kind":"field","table":"syn_turn_feedback","name":"quality_state","type":"TEXT","nullable":false,"meaning":"记录质量；默认指标仅采用valid，invalid保留用于质量排查。","enum":["valid","invalid"]}
```

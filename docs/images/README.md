# README 图片来源

这些图片用于[项目首页](../../README.md)，共 11 张：1 张封面、4 张概念说明图、5 张实际页面截图和 1 张正式架构图。四张说明图和模型配置截图于 2026-10-20 更新；工作台、报告、语义管理和个人 Skill 四张截图于 2026-10-22 换为座舱语音资料。

## 视觉方向

封面采用深墨色、米白大字和分层数据结构。正文用米白底、冰蓝结构和少量黄绿色标记，突出来源、权限边界与用户操作。说明图帮助理解对象和流程；精确接口与调用关系仍以[系统设计](../semantic-retrieval-design.md)和[架构说明](../architecture/README.md)为准。

## 图片清单

| 文件 | 来源与用途 |
| --- | --- |
| [data-agent-cover.png](data-agent-cover.png) | 2026-10-11，内置 GPT Image 生成。产品主题封面，本次核对后保留。 |
| [semantic-construction.png](semantic-construction.png) | 2026-10-20 重绘。来源事实、模型建议与人工修改分别保留；纠错建议经负责人核对、编辑并保存，语义维护权与平台查询权分开。 |
| [conversation-query-flow.png](conversation-query-flow.png) | 2026-10-20 重绘。从问题、SQL 草稿和聊天授权，到后台查询、分析依据与本人报告；每份依据保留原条件与来源。 |
| [knowledge-recall.png](knowledge-recall.png) | 2026-10-20 重绘。共享语义与个人记忆分别检索；报告和个人方法保存来源，再次读取时重新核验。 |
| [skill-reuse.png](skill-reuse.png) | 2026-10-20 重绘。分析成果先形成本人方法草稿，编辑保存后成为个人 Skill；明确发布生成独立公共副本，明确选用后由 Pi 按需读取。 |
| [workbench-sql.jpg](workbench-sql.jpg) | 2026-10-22，当前工作台截图。合成座舱语音的月度任务达成率、实际 SQL、已完成查询和 CSV 下载。 |
| [analysis-report.png](analysis-report.png) | 2026-10-22，当前分析报告截图。滚动至主要结论与趋势图，展示月度达成率、合格分母、解读限制和查询来源。 |
| [semantic-management.jpg](semantic-management.jpg) | 2026-10-22，当前语义管理页。合成管理员 Alice 查看 syn_voice_turn 的粒度、状态、时间与维护入口。 |
| [personal-skills.png](personal-skills.png) | 2026-10-22，当前“确认个人 Skill”页面。核对语音任务达成率分析形成的方法、适用范围与附件，再保存为本人资产。 |
| [model-configuration.png](model-configuration.png) | 2026-10-20，当前模型配置页。合成管理员维护示例服务与模型；只展示凭据已设置状态，未连接真实供应商。 |
| [data-agent-overview.svg](../architecture/data-agent-overview.svg) | 2026-10-20 已更新的正式架构总览，本次重新核对；另有[可编辑 draw.io](../architecture/data-agent-c4-container.drawio)。 |

## 页面截图如何取得

截图沿用仓库 `tests/mvp/harness.mjs`，启动隔离数据库、当前 Rust API / Worker、合成 SQLite 平台和 React 页面；浏览器视口为 1440 × 1060。四张新截图的合成数据来自 `docs/sources/cockpit`。查询按轮次 UTC 开始日汇总七月至九月的达成数与合格轮次数，再在 SQL 中计算百分比；快照截止时间为 `2026-10-04T00:00:00Z`。取消和无语音不进入合格分母，失败、拒绝、未知与待澄清仍保留。使用日表时只接受整日边界。

工具选择和说明文字由截图脚本控制。SQL 经聊天执行授权工具提交，在合成平台实际运行；定量正文通过 `present_analysis_answer` 引用真实结果单元格，由业务端生成。分析依据、报告和待确认方法由正式业务入口保存，再从真实页面截图。个人方法随后通过页面确认保存。该过程没有调用付费模型，不证明模型能自主完成同样的分析。

保留的模型配置截图来自 2026-10-20 独立环境，其中服务名称、模型限制和价格是隔离环境的示例配置，不是供应商报价或兼容性验证。凭据为专用合成占位值，不出现在截图中。截图未读取本地日常试用聊天，未改写页面 DOM 或拼接界面；报告只通过正常滚动定位。截图环境结束后关闭并清理，不影响原本地服务。

旧图及旧提示词可以从 Git 历史查看。真实模型、真实平台的验证范围仍以 [CURRENT](../CURRENT.md) 为准。

## 生成提示词

以下保留封面及 2026-10-20 四张概念说明图的生成提示词。说明图使用内置 `image_gen`，以对应旧图作为视觉风格参考，完整重绘内容；没有使用 CLI 或额外 API 凭据。

<details>
<summary>封面 · data-agent-cover.png</summary>

```text
Create a distinctive, art-directed cover for the GitHub README of "Data Agent", a real data analysis workbench built around shared semantic knowledge, conversational SQL and private memory.

Asset: wide landscape 2.25:1 editorial technology poster, designed to remain sharp and legible at 1000 pixels wide. It should look like an excellent specialist software publication with a memorable visual identity.

ART DIRECTION — "Anatomy of a data question":
Deep near-black ink background (#111c23), warm ivory type (#f2f0e7), restrained acid-chartreuse highlights (#d4ec74), translucent ice-blue surfaces (#a9cbd8). Rich material depth, hard clean edges, subtle physical shadows, very fine drafting lines. Strong asymmetrical Swiss editorial composition with large confident typography, not an app interface.
Left 44%: enormous tightly set modern grotesk title "DATA" then "AGENT", warm ivory, beautifully spaced. Under it, a simple clear Chinese subtitle "让数据有据可问". At bottom left in small but readable monospaced capitals: "SEMANTICS / SQL / MEMORY".
Right 56%: one striking exploded axonometric sculpture built from three different semi-transparent rectangular layers: the bottom layer is a precise miniature grid of data cells, the middle layer is a dictionary-like mapping of columns connected by crisp hairline routes with a few vivid chartreuse cells, the upper layer is an elegant white query sheet folding into an orderly table of results. A small detached solid memory tile sits nearby, distinct from the shared stack. This sculpture is the main visual subject; it must feel engineered, tactile and spatial, not generic floating cards. Add a few restrained coordinate ticks and thin construction lines, but no fake numbers or pretend metrics.
Integrate the illustration with the typography; generous deliberate margins. Crisp high-end print quality. Short text only, all text exactly as provided. No other text.
Avoid robots, brains, chat-bubble clipart, books, plants, rocket icons, stock SaaS cartoons, logos from other companies, neon cyberpunk, purple gradients, glows, rounded card grids, or invented UI. The user rejected an ordinary blue illustration of books and speech bubbles; this needs a clearly stronger composition. This is a conceptual product cover, not an architecture diagram.
```

</details>

<details>
<summary>共享语义与维护归属 · semantic-construction.png</summary>

```text
Use the input image only as a visual style reference. Create a NEW complete explanatory plate for the current Data Agent GitHub README. Landscape about 2.1:1. Retain the premium technical-atlas look: warm ivory paper, near-black Chinese typography, fine engineering rules, translucent ice-blue structures and small chartreuse highlights. Simplify the scene enough to read at 1000px width. All Chinese must be accurate and large. This is a conceptual diagram, never a fake product screenshot. No performance claims, no robots, no decorative prose, no additional labels beyond those specified. Diagrams must show the stated arrows accurately and avoid overlaps.
Title "语义有来源，修改有归属". Small plate number "01 / SEMANTICS".
Upper main row, left to right:
LEFT a group "平台资料" with three sheets "元数据", "血缘", "加工 SQL".
CENTER three distinct stacked layers "来源事实", "模型建议", "人工修改". Platform materials feed the first two; a separate pen feeds manual changes. Each layer leads to the right.
RIGHT "共享语义" organized as three rows "表与字段", "指标与计算 SQL", "业务文档与关系".
A small note under center "重新预填，保留人工值".
LOWER clearly separated governance lane with three steps "纠错建议" → "负责人核对" → "编辑并保存". The final step points upward into shared semantics; the first step has no direct arrow to the official content. Caption "接受建议不等于正式生效".
Bottom note "语义维护权与平台查询权分别校验".
Make the governance lane prominent and visually distinct from source ingestion. The image should explain current ownership and review without implying all model suggestions require manual approval.
```

</details>

<details>
<summary>从问题到报告 · conversation-query-flow.png</summary>

```text
Use the input image only as a visual style reference. Create a NEW complete explanatory plate for the current Data Agent GitHub README. Landscape about 2.1:1. Retain the premium technical-atlas look: warm ivory paper, near-black Chinese typography, fine engineering rules, translucent ice-blue structures and small chartreuse highlights. Simplify the scene enough to read at 1000px width. All Chinese must be accurate and large. This is a conceptual diagram, never a fake product screenshot. No performance claims, no robots, no decorative prose, no additional labels beyond those specified. Diagrams must show the stated arrows accurately and avoid overlaps.
Title "从问题到可复核的报告". Small plate number "02 / ANALYSIS".
Top clear five-step reading path with restrained sheet/database/result icons:
"提问与澄清" → "SQL 草稿" → "聊天授权" → "后台查询" → "结果与下载".
Add a return arrow from SQL draft to question labelled "补充条件".
Highlight only the explicit chat authorization step in chartreuse. Nothing bypasses it.
Lower row continues from query results to "分析依据" and then "本人报告". Show two smaller evidence sheets converging on one report to express multiple evidence sources. Their only labels are "查询 A" and "查询 B". One small report label "各自保留原条件与来源".
Under the top flow, separate thin continuous conversation line labelled "查询在后台，对话可继续".
Footer "新 SQL 单独授权 · 10 行预览 · CSV 下载".
Do not invent charts or numbers. No mandatory sequence of model tool calls: this is the product's object relationships. Strong visual distinction between query result and saved analysis report.
```

</details>

<details>
<summary>检索与来源有效性 · knowledge-recall.png</summary>

```text
Use the input image only as a visual style reference. Create a NEW complete explanatory plate for the current Data Agent GitHub README. Landscape about 2.1:1. Retain the premium technical-atlas look: warm ivory paper, near-black Chinese typography, fine engineering rules, translucent ice-blue structures and small chartreuse highlights. Simplify the scene enough to read at 1000px width. All Chinese must be accurate and large. This is a conceptual diagram, never a fake product screenshot. No performance claims, no robots, no decorative prose, no additional labels beyond those specified. Diagrams must show the stated arrows accurately and avoid overlaps.
Title "检索之后，来源继续跟着内容". Small plate number "03 / SOURCES".
Left half has two independent retrieval lanes:
top "共享语义" with small sublabel "名称 · 关键词 · 向量";
bottom "个人记忆" with small sublabel "Mem0 · 用户与空间隔离".
They meet only at a clear validation gate "回源校验", sublabel "权限 · 版本 · 状态", connected below to "MySQL".
After this gate arrow to "当前对话".
From current conversation an arrow labelled "保存来源" goes downward to a group "报告与个人方法".
Then arrow to "再次读取", with a small gate labelled "重查来源".
Final bottom emphasis "来源失效，隐藏相关正文".
Do not imply all persistent objects have the same invalidation granularity. The footer is general. No guarantee of correctness, complete retrieval, or perfect citations. Keep arrows uncrossed and both personal/shared lanes clearly separate.
```

</details>

<details>
<summary>方法草稿与 Skill 复用 · skill-reuse.png</summary>

```text
Use the input image only as a visual style reference. Create a NEW complete explanatory plate for the current Data Agent GitHub README. Landscape about 2.1:1. Retain the premium technical-atlas look: warm ivory paper, near-black Chinese typography, fine engineering rules, translucent ice-blue structures and small chartreuse highlights. Simplify the scene enough to read at 1000px width. All Chinese must be accurate and large. This is a conceptual diagram, never a fake product screenshot. No performance claims, no robots, no decorative prose, no additional labels beyond those specified. Diagrams must show the stated arrows accurately and avoid overlaps.
Title "把这次分析，留成下次的方法". Small plate number "04 / SKILLS".
Top main path: "分析成果" → "本人方法草稿" → "编辑并保存" → "个人 Skill".
Use a small report, a draft page, an editing pen, and a substantial method packet. Clearly show saving the draft does not itself select the method.
Second row: a branch from personal Skill labelled "明确发布" leads to "公共副本", with sublabel "独立维护".
Both personal Skill and public copy have separate arrows into a chartreuse junction "明确选用".
After that junction arrow to a structured resource "Pi 按需读取" with the three short lines "正文", "说明", "文本模板".
Footer "来源失效仍需核对 · 私人聊天不会随发布公开".
Use a readable layout with no crossing connectors. Preserve the fact that a personal Skill can be selected without publication. No automated publishing or implicit authorization arrows.
```

</details>

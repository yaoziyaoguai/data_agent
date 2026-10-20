# README 图片来源

这些图片用于[项目首页](../../README.md)。本轮共展示10张图：1张封面、4张概念说明图、4张实际页面截图和1张正式架构图。

## 视觉方向

封面采用深墨色、米白大字和分层数据结构。正文用米白底、冰蓝结构和少量黄绿色标记，让来源、边界和用户操作成为图中的重点。说明图帮助理解流程；精确接口、组件与调用关系仍以[系统设计](../semantic-retrieval-design.md)和[架构说明](../architecture/README.md)为准。

概念图的标题和箭头按现有能力核对。实际界面使用页面截图；图片中的账号、表、订单和文档均为项目合成资料。

## 图片清单

| 文件 | 来源与用途 |
| --- | --- |
| [data-agent-cover.png](data-agent-cover.png) | 2026-10-11，内置 GPT Image 生成。深色封面，以分层数据结构、查询和独立记忆块表现产品主题。 |
| [semantic-construction.png](semantic-construction.png) | 2026-10-11，内置 GPT Image 生成。平台资料、来源事实、模型建议与人工修改如何组成语义记录。 |
| [conversation-query-flow.png](conversation-query-flow.png) | 2026-10-11，内置 GPT Image 生成。SQL 先展示，经聊天要求执行；查询在后台运行，支持单独停止。 |
| [knowledge-recall.png](knowledge-recall.png) | 2026-10-11，内置 GPT Image 生成。共享语义与个人记忆分开检索，候选回源核对权限、版本和状态。 |
| [skill-reuse.png](skill-reuse.png) | 2026-10-11，内置 GPT Image 生成。个人 Skill 可直接选用，明确发布才生成独立公共副本；选用后由 Pi 原生能力加载。 |
| [workbench-sql.jpg](workbench-sql.jpg) | 2026-10-11，本地正式工作台截图，展示合成订单结果、CSV 下载、最终 SQL 与模型选择 |
| [semantic-management.jpg](semantic-management.jpg) | 2026-10-11，本地正式语义管理页截图，合成维护者 Carol 按本人负责范围查看表与字段 |
| [personal-skills.png](personal-skills.png) | 现有资产体验浏览器检查的 1440 × 1000 截图，展示分析模板、正文、适用范围、附件与保存操作 |
| [model-configuration.png](model-configuration.png) | 2026-10-20，本地正式模型配置页，合成管理员 Alice 查看首次导入的服务与模型；只有密钥已设置状态，无凭据值 |
| [data-agent-overview.svg](../architecture/data-agent-overview.svg) | 现有正式架构总览；另有[可编辑 draw.io](../architecture/data-agent-c4-container.drawio) |

工作台和语义截图按浏览器实际返回的 JPEG 格式保存，未重新绘制界面。旧截图保留为历史资料；旧封面与旧版图片说明可从 Git 历史查看。浏览器业务试用范围见[本地试用记录](../reviews/local-dogfood-20261011.md)。

## 生成提示词

生成方式：内置 `image_gen` 工具，未使用 CLI 或额外 API 凭据。以下是本次实际使用的提示词；图片已复制到本目录。查询图生成后，将额外出现的“历史示例”改为“文档”，避免暗示独立的历史 SQL 检索能力；中间一次编辑出现错字，最终定向修正提示词见下。

<details>
<summary>对话查询图 · 最终文字修正</summary>

```text
Correct a single label in the attached diagram. To the left of the large SQL sheet there are three small blue evidence blocks. Their labels are arranged vertically. The bottom label currently contains incorrect Chinese characters. Completely erase that entire bottom label and typeset only these TWO large Chinese characters: "文档". It must be exactly 文 followed by 档, with no characters before or after it. Match the existing dark text size and baseline. Leave the other two labels "表结构" and "业务规则", all other text, arrows, graphics, colors, dimensions, and layout completely unchanged. Do not regenerate the rest of the illustration.
```

</details>

<details>
<summary>新封面 · data-agent-cover.png</summary>

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
<summary>语义构建 · semantic-construction.png</summary>

```text
Create a wide landscape 2.15:1 explanatory illustration for a Chinese developer-facing GitHub README. Art direction: a premium printed technical atlas, warm ivory paper #f2f0e7, dark ink #111c23, translucent ice-blue structures #a9cbd8, sparing chartreuse highlights #d4ec74. Large impeccably legible Chinese sans-serif text. Fine engineering rules and shallow axonometric depth, generous margins, visually organized and calm. It must be easy to read at 1000 pixels wide. No fake app UI, no logos, no people, no robot, no brain, no plant or book clipart, no gradients or glow, no tiny decorative type. It is an explanatory plate, with accurate relationships; limit written text to the exact strings specified.
Title top left exactly "语义从哪里来". Small plate label "01 / SEMANTICS".
Below, make a three-part left-to-right composition, with each part built from beautiful ruled sheets and subtle glasslike structured blocks.
LEFT at 10-28%: three fanned source sheets with readable labels "元数据", "血缘", "加工 SQL". Group label "平台资料".
MIDDLE at 40-63%: three visibly separate horizontal layers, aligned vertically, large clear labels "来源事实", "模型建议", "人工修改". The manual layer has a distinct chartreuse highlighted tab and a small pen mark. All three layers are preserved independently. A branch from the left sources feeds the first two layers. A small neutral edit symbol feeds the manual layer.
RIGHT at 76-93%: an orderly semantic catalog block with four clear rows "表与字段", "指标与 SQL", "业务文档", "关联关系". Group label "共享语义".
Use thin clear arrows from all three middle layers to the catalog. This depicts the composition of semantic information; it is NOT an automatic publishing pipeline or a claim that every entry is human verified. Use one short highlighted note along the bottom: "重新预填，保留人工修改".
Do not add a mandatory review gate or the words 自动发布, 全部验证, or 高准确率. Hierarchy: main title largest, group headings next, row labels clearly readable.
```

</details>

<details>
<summary>对话查询 · conversation-query-flow.png</summary>

```text
Create a wide landscape 2.15:1 explanatory illustration for a Chinese developer-facing GitHub README. Art direction: a premium printed technical atlas, warm ivory paper #f2f0e7, dark ink #111c23, translucent ice-blue structures #a9cbd8, sparing chartreuse highlights #d4ec74. Large impeccably legible Chinese sans-serif text. Fine engineering rules and shallow axonometric depth, generous margins, visually organized and calm. It must be easy to read at 1000 pixels wide. No fake app UI, no logos, no people, no robot, no brain, no plant or book clipart, no gradients or glow, no tiny decorative type. It is an explanatory plate, with accurate relationships; limit written text to the exact strings specified.
Title top left exactly "先看 SQL，再决定怎么查". Small plate label "02 / CONVERSATION".
Create a clean four-stage horizontal story, using physical query sheets, small data grids and fine arrows, not browser mockups. Large stage labels in order:
"提问与补充" → "展示 SQL" → "聊天要求执行" → "结果与下载".
First stage shows short abstract question lines and a small branching evidence route. Second stage shows a single light query sheet with only the word "SQL" and typographic placeholder lines, not actual code. Third stage has a chartreuse highlight, visibly representing the user's decision. Fourth stage shows a precise little result table and download mark.
Above the first two stages, a small return arrow from the SQL sheet back toward the question is labelled exactly "修改条件"; this loop does not reach the execution stage. No arrow bypasses "聊天要求执行".
Below, separated by a thin horizontal rule, show a wide timeline with two slim parallel running bars labelled "查询 A" and "查询 B" and a thin line of continuing conversation across them. Use the label "查询在后台，对话可继续". Put a small stop mark next to each query bar and one shared label "可单独停止".
At the far lower right a concise readable footer: "10 行预览 · CSV 下载".
No stopwatch values, no completion percentage, no fake claims about response speed, no invented data. Make the top reading path extremely obvious and preserve a lot of whitespace between stages.
```

</details>

<details>
<summary>共享语义与个人记忆召回 · knowledge-recall.png</summary>

```text
Create a wide landscape 2.15:1 explanatory plate for a Chinese developer-facing GitHub README, part of a cohesive "anatomy of a data question" visual series. Premium technical atlas style: warm ivory paper #f2f0e7, near-black ink #111c23, translucent ice-blue axonometric structures #a9cbd8, restrained chartreuse #d4ec74 to mark an important boundary. Beautiful large Chinese sans-serif headings, secondary text remains readable at 1000px width. Clean thin rules, generous margins, shallow tactile depth, no fake UI or browser chrome. Avoid robots, brains, plants, generic clipart, neon, glows and purple. A correct, lucid diagram with an editorial presence. Use only the specified text and no extra examples or tiny gibberish.
Title at top left: "共享知识，个人经验". Small plate label "03 / RECALL".
Composition: two separate parallel left-to-right retrieval lanes in the left 60% of the image, converging ONLY at a visible common validation gate at 72%, then ending at a single conversation destination at 91%.
Upper lane: a translucent organized catalog block with title "共享语义" and subtitle "表 · 字段 · 指标 · 文档". A short arrow leads to a compact search lens / structured index shape labelled "名称 · 关键词 · 向量".
Lower lane: a smaller personal archive tile with a subtle lock and title "个人记忆". Directly below: "按用户与空间隔离". Its separate arrow leads to a matching search lens / index shape labelled "Mem0".
Keep a thin clear horizontal separator between these lanes. There is NO arrow from personal memory into shared knowledge. Under the two search index shapes, a bracket label "Milvus · 独立集合". This means both paths use distinct collections, not a common shared memory pool.
Both lanes point toward one visibly emphasized validation station, chartreuse accents, title "回源校验", subtitle "权限 · 版本 · 状态". Put a small authoritative datastore block below this station labelled "MySQL" connected by a fine vertical line.
Only AFTER this station is an arrow to a crisp plain stack of conversation sheets titled "当前对话".
Along the bottom a single concise note: "命中候选 ≠ 可以直接使用".
Do not imply that index hits automatically authorize use, that personal memory becomes global, that all data is public, or that Mem0 replaces MySQL. Keep arrows distinct and typography large.
```

</details>

<details>
<summary>个人与公共 Skill 复用 · skill-reuse.png</summary>

```text
Create a wide landscape 2.15:1 explanatory plate for a Chinese developer-facing GitHub README, part of a cohesive "anatomy of a data question" visual series. Premium technical atlas style: warm ivory paper #f2f0e7, near-black ink #111c23, translucent ice-blue axonometric structures #a9cbd8, restrained chartreuse #d4ec74 to mark an important boundary. Beautiful large Chinese sans-serif headings, secondary text remains readable at 1000px width. Clean thin rules, generous margins, shallow tactile depth, no fake UI or browser chrome. Avoid robots, brains, plants, generic clipart, neon, glows and purple. A correct, lucid diagram with an editorial presence. Use only the specified text and no extra examples or tiny gibberish.
Title at top left: "把分析方法留给下一次". Small plate label "04 / SKILLS".
Create a clear spacious diagram about personal and public analysis Skills, with separate ownership and explicit selection. Upper left: a folded method packet labelled "个人 Skill", with an abstract text template sheet and two attached smaller sheets, no code. Upper middle: a thin arrow labelled "明确发布" pointing to an independent second packet at upper right labelled "公共副本". Below the second packet, readable short text "独立维护".
At lower center, a small chartreuse selection junction titled "明确选用". Two clearly separate thin arrows go from the PERSONAL packet and the PUBLIC packet into this junction. This shows either may be selected. The public packet is optional; the personal packet does not have to be published before use.
From the selection junction, draw one clean horizontal arrow into a precise layered resource block titled "Pi 原生 Skill", with three small readable contents: "正文", "说明", "文本模板". Then a short arrow reaches a rightmost compact plain sheet stack titled "当前对话".
Use deliberate balanced spacing, avoid crossing arrows, and ensure "明确发布" applies only to making the public copy, while "明确选用" applies to using either kind.
Along the bottom margin separated by a thin rule, place one short note exactly: "私人记忆与聊天不会随发布公开".
No automated publication, no global unrestricted access, no model selecting methods without the user's choice, no fake app screenshot. The diagram explains method reuse; it is not a replacement for the software architecture diagram.
```

</details>

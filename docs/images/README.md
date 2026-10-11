# README 图片来源

这些图片用于[项目首页](../../README.md)。封面是概念插画；功能截图来自正式 React 页面，表、订单、文档和账号均为项目合成资料。

| 文件 | 来源与用途 |
| --- | --- |
| `data-agent-cover.png` | 2026-10-11 使用内置 GPT Image 工具生成。概念封面，表现共享语义、对话与 SQL、个人记忆之间的关系 |
| `workbench-sql.jpg` | 2026-10-11 截取本地工作台。展示合成订单结果、CSV 下载、最终 SQL 与模型选择 |
| `semantic-management.jpg` | 2026-10-11 截取本地语义管理页。合成维护者 Carol 按本人负责范围查看表与字段 |
| `personal-skills.png` | 本地资产体验浏览器检查生成的 1440 × 1000 截图。展示三个分析模板、正文、适用范围、附件和保存操作 |

工作台与语义截图按浏览器实际返回的 JPEG 格式保存，未重新绘制界面。旧 `.png` 截图保留作历史资料，项目首页使用上表文件。浏览器试用范围见[本地试用记录](../reviews/local-dogfood-20261011.md)。

软件架构使用[现有 SVG](../architecture/data-agent-overview.svg)和[可编辑 draw.io](../architecture/data-agent-c4-container.drawio)，组件与调用关系以[架构说明](../architecture/README.md)为准。

## 封面生成提示词

生成方式：内置 `image_gen` 工具；未使用 CLI 或额外 API 凭据。输出保存为 `data-agent-cover.png`。

```text
Use case: illustration-story
Asset type: landscape editorial cover for the GitHub README of Data Agent, a real data-analysis workbench.
Primary request: create a carefully composed, polished illustration explaining how table knowledge, conversation, SQL and a personal notebook work together. It should feel like a thoughtful software manual cover, not an advertisement or a fake app screenshot.
Composition: wide landscape, approximately 2:1. On an off-white paper-like background, place the title in the upper left, and a single connected editorial illustration across the lower two thirds: a blue outlined catalog of table columns and an open reference book, a crisp conversation bubble beside a SQL sheet, an orderly result table, and a separate small personal notebook with a subtle lock symbol. Use flowing fine drafting lines to relate them without implying automatic SQL execution. Keep generous negative space and a clear visual hierarchy.
Style: precise flat technical illustration with a little paper depth, disciplined navy ink outlines, muted blue fills, subtle shadows, almost no texture. Match a calm grey-blue and white enterprise data workbench. No photorealism, no glossy 3D, no robots, no brains, no neon, no gradients.
Text, exactly: large title "Data Agent"; smaller subtitle "从业务口径，到查询结果". Three small captions only: "共享语义", "对话与 SQL", "个人记忆". Render Chinese text clearly and accurately.
Do not add code snippets, metrics, company logos, URLs, avatars, invented interface controls or other text. Keep all content comfortably inside margins. The image is a conceptual cover, not an architecture specification.
```

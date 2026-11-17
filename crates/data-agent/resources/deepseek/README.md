# DeepSeek 维护输入计量资产

此目录保存维护请求计量使用的固定公开数据，归 `ingestion::prefill::input_tokens` 所有。运行时只在 Rust 内计数，不下载权重、不调用远程计数接口，也不启动新的服务。两个 tokenizer JSON 合计 12,734,403 字节，首次使用时各自在进程内解析并缓存。

- `manifest.json` 是型号、公开来源与 SHA-256 的记录。
- `*-tokenizer.json` 是官方 tokenizer 数据，分别保留 Flash-1017 与 Pro-0813 的 added tokens。
- `*-format.json` 是从对应公开 encoder 字面量提取的四段边界，按模式保存 system 前、system/function 间、function/user 间和 user 后文本。只适用于两条纯文本消息及一个无 namespace function。
- `*-encoding.py.txt` 仅供测试读取 AST 字面量作为独立参考，不作为应用代码执行。
- `LICENSE` 保留官方 MIT 许可与版权声明；官方模型仓库声明仓库及模型权重均采用 MIT。

计量一次编码完整公开 prompt，包含实际 system、材料 JSON、展开后的 function schema、角色标识与思考模式前缀。function 按公开 encoder 的 Python 默认 JSON 空格呈现，HTTP 外层转义不重复计入。该 BPE 计数用于本地分片和发送准备，保留原中文材料容量及 `profile.input_limit` 策略；它不等于托管 API 的计费上界，输出仍使用同一原 profile 的实际 `max_tokens`。

维护计费由原 `runtime::model_calls` owner 处理。依据[官方模型元数据](https://api-docs.deepseek.com/api/list-models/)、[Chat Completions 合同](https://api-docs.deepseek.com/api/create-chat-completion/)和[价格表](https://api-docs.deepseek.com/quick_start/pricing)，当前 Flash-1017 / Pro-0813 的总上下文是 1,048,576 tokens，包含输入与输出；输入预留保守使用完整总窗口，不减去请求的最大输出。单次输出沿实际 `max_tokens`（服务最大 393,216），按峰值、输入缓存未命中价预留：Flash 每百万输入/输出为 0.30/1.20 USD，Pro 为 1.32/3.96 USD；托管配置声明价格不得低于此依据。账本金额单位为整数微美元，每次向上取整，不依赖缓存或非高峰折扣。

新调用在 `maintenance_model_calls.budget_json` 冻结格式版本、原 profile、服务输入上界和实际输出 cap；实际 usage 沿该快照结算，不回退到当前选择。旧 issued 行的 NULL 快照保持 NULL，只用原 trial 不可变指纹匹配的原 profile 与原输入限额结算；旧 unknown 保留原身份和占用。超界但已知的用量仍先落实际费用、释放本调用预留并标记 breached，owner 提交后才报告失败；usage 缺失不释放预留。

公开编码与托管 API 的模板映射仍是独立证据问题，尤其是顶层 tools/tool_choice 与模型别名更新。这里不宣称本地估计构成服务端输入硬截断或无条件费用上界，收费通道状态以 `docs/CURRENT.md` 为准。更新型号时须同时复核来源、许可、格式、tokenizer 和原材料/预留回归，不能静默更换固定资产。

独立协议检查使用 Python 官方绑定和公开 encoder 字面量，环境与日常 Mem0 环境隔离：

```sh
python3 -m venv .local/tokenizer-reference-venv
.local/tokenizer-reference-venv/bin/python -I -m pip --isolated install --no-deps -r tests/mvp/requirements-tokenizer-reference.txt
node tests/mvp/check-prefill-materials.mjs
node tests/mvp/check-prefill-materials.mjs --field-evidence
```

工程检查不调用真实模型。公共来源资产仅用于编码，业务表、SQL、资料和试验输入继续使用从零构造的合成材料。

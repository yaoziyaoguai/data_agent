# Dogfood 修复执行包交叉核对

日期：2026-11-14。结论：最终执行包可交实施者按范围执行。它覆盖本轮已发现的问题和验证缺口；本轮没有修改产品、运行新付费dogfood或完成实现验收。I3/09仍active，未来实现审查pending。

## 两份独立方案与方法

当前Codex先按 `dev_co` 的渐进读取/交接约定编制本地独立稿（`.local/audits/qa-repair-package-20261114/local-plan.md`），使用 `contract-first` 校对现有同源Schema与消费者，将 `tdd` 的RED/GREEN要求用于未来实施。本轮没有执行产品TDD。独立稿在读取Oracle答案前冻结，SHA256为 `b02111236ed301b0870e7c57d4ec6f5624235455a37e8e6be1bbdd6addc3a47f`。

随后通过已安装 `oracle-web` 提交三份共同事实/必要代码/验证入口，约17,225输入tokens，不发送本地方案或整个仓库，不使用子代理。Oracle独立稿（`.local/audits/qa-repair-package-20261114/oracle-plan.md`）提出八片，本地稿为六项；差别主要是把回答、CTE和试用前提分列，不是新增产品能力。最终把相关工作合并为六项，保留全部问题的定位、边界及出口。

Oracle会话：生成修复执行包（会话链接留存本地证据）。两次发送前选择证据均为 `Power, item 5 of 5 (slider ARIA)`。网页显示思考8分50秒后给出完整方案，包含范围表、执行建议和交接文本。

**抓取限制如实保留：** CLI没有识别新版页面的最终回复，持续等待。本轮只读访问它自己记录的Chrome端口与target，在同一已提交会话两次核对回复稳定、无停止生成按钮、有复制/朗读工具栏，并补齐可见文本未展开的表格和代码块。随后只关闭该临时浏览器；CLI因此exit 1，不能记作自动抓取成功。本记录采用已核完整网页回复，不采用错误进程的部分日志或未完成草稿，没有重发问题。对应Chrome PID已退出，临时Profile已删除，没有信号操作controller或清理其他会话。详见来源和清理证据（`.local/audits/qa-repair-package-20261114/oracle-provenance.json`）与完整正文（`.local/audits/qa-repair-package-20261114/oracle-complete-response.txt`）。

最终稿由当前Codex逐条对照代码和用户决定修订，没有再送Oracle审最终措辞，不声称Oracle逐字批准。

## 交叉差异与定稿处理

| 问题 | 独立方案及核对 | 最终处理 |
| --- | --- | --- |
| 新运行规则 | 两方均采用取消正常累计次数/费用/总时长门，保3次临时失败、取消、单请求超时与容量 | 不是改48/100，也不是只把embedding挪出24；新正常scope用NULL表达无次数门，三条签发路径均核对 |
| 配置指纹 | 本地初稿曾列配置身份派生备选；Oracle建议用“现有配置身份机制”，但未展开本仓库固定空间trial_id与整个profile指纹的矛盾 | 选更小改法：保既有序列化/指纹，历史字段仅作兼容，新scope不执行其24门；允许新正常profile省略字段。不新增身份派生框架，不覆盖旧trial或给原100元换账 |
| 后台维护 | 两方均指出EmbeddingProfile和configure_embedding_trial，Oracle明确无前台scope也收费 | 省略普通累计限额/一小时到期默认；旧冻结值不清。scope_id=None不等于免费，显式测试绑定仍参与所有通道预留 |
| 非法null | 两方均确认prepareArguments在Pi规范化前、beforeToolCall太晚 | 仅在当前工具原参数接缝用既有抛错路径拒绝非法set.source_limits:null；不自动unset、不重复整份Schema校验、不改SDK、不部分成功 |
| options与旧版本 | Oracle写从AnalysisUpdate全局required移除；当前CurrentAnalysisUpdate实际allOf继承旧定义 | 只调整当前v2无关动作；保v1和历史回执。共享属性仍同源，不能在allOf外删除required假装放宽，也不复制两套字段 |
| 就绪状态 | 两方均区分Rust true与Pi pending reset；消费者探针不能补出历史wire | 当前有效投影进入可见控制事实，保原data正文；refresh完成前不解锁。F01/F04/F09/A15分别核因，不新建状态机/强制工具流水线 |
| CTE授权 | Oracle要求结构解析并保真实底表检查；本地要求先核SQLite实际授权接缝 | 先复现原J02、核实际虚拟读身份；不预先引入完整SQL解析器。合法CTE重名可用，真实未授权底表仍拒绝，不按空列名/database=null全放行 |
| UI与抽象范围 | Oracle列ModelConfigurationPage作为修改入口，但未证明必改UI | 页面只有确有旧限额文案或合同消费才改；不新增预算开关、页面或策略系统。单用简单逻辑就地处理 |
| F05/F06与P07 | 两方均要求权限→召回→补读→入模→回答逐段判别；本地初稿P07定位不够显式 | 最终补NLU理解与动作执行分别解释；数学反例不当SQL错误或Mem0错误，不向产品塞原题答案 |
| 未知embedding/预填 | 两方均要求先证后改，不能凭8MiB推出900k token安全 | 找不到原回执允许单项阻塞，不释放47微美元或重建求绿；预填能补输入上界证明就不改产品，缺口才沿原装配/批次修 |
| 六个旧v2夹具 | 两方均要求prepare→render及旧present回放 | 保原断言，新增调用退休present仍拒绝，不恢复旧入口换绿；本地函数入口名按当前源码修为open_budget_scope_in_tx |
| 工程与真实出口 | 两方均保100/10分母、38组工程、原100元余额、产品生成Skill七步 | 原S01→S02先过，再扩依赖场景；新attempt不覆盖旧报告，旧成绩/旧审查不关闭本轮。工程、真实模型、真实存储、合成平台分别报告 |

## 问题覆盖与未决项

| 最终任务 | 报告问题/缺口 |
| --- | --- |
| 运行政策与原账本 | F03，所有收费通道、旧scope/配置恢复 |
| 当前工具参数与Skill | F02，非法null、无关options、E07/A15选择到采用 |
| 有效就绪状态与续接 | F01、F04、F09，T01原两句、Carol真实空态、相似拒绝分别归因 |
| CTE与有依据的解释 | F10、F05、F06，包括P04/P05/P07、三字段和A12 |
| 资料与维护证据 | F07、F08、预填/整理输入上界、A13素材/负责人前提 |
| 验收与原题复验 | 六个旧v2夹具、原38组、原100项/10轨迹、产品生成Skill七步、报告与文档 |

没有新的全局产品方向需要再问用户。根因未知和证据待补不等于产品决定未确认。A13若确实找不到已批准合成素材，记录具体缺项；不能擅自发明业务规则，也不因此停止其他工作。若后续实施证明必须新增能力、增加费用或改变已确认行为，说明证据与影响后再讨论，不把假设写成必做保护。

## 本轮检查与限制

- 文档链接与所列现有命令文件核对；原38组验收、要求编号和失败记录保留。
- 编包前记录的17份产品/测试/Schema文件哈希保持；本轮实际改动为执行包、Prompt、审查记录、CURRENT和相关设计/入口。
- `make verify-delivery`及其16项检查器测试通过；它只证明声明覆盖和记录结构，不代表产品业务通过。最终检查细节见本轮验证记录（`.local/audits/qa-repair-package-20261114/document-validation.json`）。
- 没有运行新真实模型dogfood、完整工程验收、提交推送、部署或更新日常服务。独立方案交叉核对不替代未来独立实现审查。

执行入口：[最终详细包](../execution/semantic-runtime/dogfood-report-repairs.md)；[完整交接Prompt](../execution/semantic-runtime/DOGFOOD_REPAIR_PROMPT.md)。

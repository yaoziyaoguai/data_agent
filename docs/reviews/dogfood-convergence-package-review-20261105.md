# 09 整体连续修复包交叉审查

日期：2026-11-05。范围：[连续修复执行包](../execution/semantic-runtime/dogfood-convergence-repairs.md)、[交接入口](../execution/semantic-runtime/CONTINUATION_PROMPT.md)及其接口依据。实施基线为`codex/semantic-maintenance-prototype` / `04d27d06ba7b97d4cf3e288d4cf9e6300ef491a9`，工作树含大量继承修改。本报告是方案审查，不是产品实施审查，不给实现签发passed或关闭09。

## 当前结论

可以按最终包开始连续实施。首轮Oracle指出的新增采纳门槛、旧状态转换缺口、历史刷新合同缺口已定点修订；末轮指定的旧转换字段定位和采纳核验条款也已合入并由本地逐条核对。未发现还需要用户决定的产品方向；实现正确性和真实模型效果仍待实施验证。当前实施状态保持active / review pending / evidence null。

## 审查方法与证据范围

沿dev_co既有执行包/交接流程，用contract-first核HTTP、工具和持久格式；domain-modeling用于分清未决、采纳、条件与执行授权；codebase-design用于保持owner边界并删除被替换职责。没有启动并行审查面板，没有新建术语库或流程平台。

本地核对包括finish_run/task_answers/runtime输出、read_conversation历史授权、Workbench和timeline、analysis条件/澄清持久化、query_semantics采纳规则、runtime成功回执以及独立候选均值参考。历史事故按[整体根因报告](dogfood-whole-phase-root-cause-audit-20261104.md)的证据引用，未重新跑产品测试或真实模型；不能将旧已修报告当成本轮重验。

本轮只改执行包、相关入口和CURRENT，不改产品、测试、原数据、原题、成绩，不构建、提交、推送、部署或更新日常服务。必要真实模型验证是下一位实施者的已授权工作，不因付费默认跳过。

## 首轮Oracle及本地处置

咨询`dogfood-repair-package-1105`，页面（会话链接留存本地证据）。提交前两次实证均为`Power, item 5 of 5 (slider ARIA)`。采用网页当前模型，不以CLI请求名断言网页模型身份。

页面显示回答完成；wrapper未识别新版页面的助手选择器。本地只读精确session target，保存完整可见答复后结束该咨询的Chrome。wrapper最终exit=1/connection-lost，不伪记CLI成功。证据位于`.local/checks/dogfood-repair-package-20261105/`的`oracle-visible-main.txt`、`oracle-page-readonly.json`、`oracle-answer.md`、`oracle-cleanup.json`；已确认该Chrome退出且临时Profile删除，源Profile未动。

原稿冻结为同目录`package-submitted.md`；实际发送文件清单及SHA见`oracle-inputs.json`。最终包有修订，不能用首轮原稿SHA冒充最终稿。

| 发现 | 本地取舍与执行包落点 |
| --- | --- |
| B1：新增采纳对象会变成所有草稿的必填槽；字段省略与格式切换混淆 | 删除该新槽，复用semantic_resolution并缩减职责；宿主拥有持久格式标记；省略/null/同值确认分别定清；普通无歧义任务保持可出稿。见第7节 |
| B2：读旧原话不等于已验证采纳；旧未决、部分回答和split没有闭合 | 核实际数据库：旧clarification无解决操作列，成功工具回执有条件版本/正文及原run/message。限定一次旧状态转换，保条件/来源，缺证不造explicit_user；basis-only也保留。新任务不建立迁移台账。见第7.3节 |
| B3：已加载范围、fingerprint、翻页顺序和游标合同不全 | 独立SnapshotRefresh形状；每范围明确unchanged/replace/not_available；新页与缓存共用权限投影；组件内snapshot读串行，游标不随展示替换改变。见第6节 |
| N1：写时绑定方向正确，缺提交分支、标题、TTL落点 | 补五种来源构造及字节覆盖；核history读取owner和现有TTL断言。新格式不再逆向匹配，旧NULL窄兼容，动态权限仍保留。见第5节 |
| N2：需要证明资料确已交付，不能混用三类SQL证据 | 来源修订→同步整理索引→实际工具回执→新attempt；分开原SQL反例、资料示例与真实生成稿。见第8节 |
| N3：整体问题台账没有明显大类遗漏，但旧报告不构成当前实测 | 保已修、当前待修、后置、历史未定因四类事实；P05/P08/A08等不宣称本包已解决，不重开01–08。见第4/11节 |
| N4：补有区分力的出口即可，不扩大试用 | 扩现有接缝，普通直出稿/同值确认/旧转换/翻页顺序；真实仅补受影响链，G08零新模型。见第9节 |

没有采纳泛化的决策账本、签名pending凭证、SQL守卫、权限事件总线、全历史重读或全测试矩阵。旧状态兼容只为实际存在的旧未决任务，不以理论边界扩大新任务协议。

## 本地补充核对

- 用户已批准四项合成定义，不再提交同一产品选择。候选均值新总体与`oracle_queries.py::asr_candidate_join`旧总体确实不同；保留旧key和旧冻结成绩，新增业务命名的独立参考，用原grader选择，禁止模型输出反写参考。
- 当前Workbench的refresh与loadOlder各自请求，可以重叠；组件级顺序约定有实际入口依据，不是臆造高并发防护。与之无关的查询列表请求不串行化。
- runtime成功receipt并没有保存resolved ID对应；不能把“成功条件修订”夸成已有逐问题历史证明。转换的语义判断仍由Pi承担，身份、范围、已落地条件和权限由宿主核验。
- 费用表述已按用户澄清：DeepSeek、语义整理、Embedding及Mem0沿原09授权用于必要验证，不逐题逐批审批、不新增累计测试门槛；每消息24次/连续临时失败3次及原操作身份保持。

## 最终条款复审与材料检查

第二轮咨询`dogfood-package-final-1105`，页面（会话链接留存本地证据），只发送首轮后实质修订条款与必要源码，输入约11,765 tokens；发送清单见同目录`final-review-inputs.json`，完整候选稿另存`package-final-review-snapshot.md`。提交前两次均验证`Power, item 5 of 5 (slider ARIA)`，约10分钟返回，wrapper exit=0、session completed。完整意见为`final-review-answer.md`；`final-review-cleanup.json`确认精确Chrome已退出、临时Profile已移除。

末轮结论为“需定点修订后交付”，剩余一项阻断位于7.3.3，未要求重做其他任务。本地采纳其给出的替换条款：

- migration link明确`condition_fields`，只比较所指现有字段，支持先答A再改B及确认同值，不比较整份conditions、不扩任意JSON路径。
- 旧未决路径曾早退，成功receipt本身不能证明explicit_user已核；复用原用户消息核采纳部分，不能伪继承。缺实际条件依据的项明确留在或恢复为open，不另造“待确认”状态。
- 新候选总体key实际进入原grader调用并保存证据，不只在说明里注明。现有`grade.py`支持`--reference-key`，`verify.py`比较all_results/冻结结果；未新增引擎。

第5节补充宿主固定标题无需虚构字段来源；第9节区分隔离工程harness的清环境与真实09配置。这两处为本地措辞澄清。末轮具体替换已合入、经本地复核，未再发第三次Oracle；不把外审的有条件结论改写成对最终产品实现的passed。

最终材料验证见同目录`local-materials-final.json`和检查日志：文档链接/既有测试入口/当前JSON声明可核；`make verify-materials`、`make verify-delivery`和限定文档的`git diff --check`只证明材料及记录。没有执行产品构建、产品回归、真实DeepSeek/Embedding/Mem0试用或verify-increment，新增验收命令仍待实施者写出对应断言后绑定。

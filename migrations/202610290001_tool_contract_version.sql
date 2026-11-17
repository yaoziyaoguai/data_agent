-- 历史运行和已登记工具仍使用原合同；恢复不能由当前部署配置改写版本。
ALTER TABLE agent_runs
 ADD COLUMN tool_contract_version TINYINT UNSIGNED NOT NULL DEFAULT 1,
 ADD CONSTRAINT agent_runs_tool_contract_version CHECK (tool_contract_version IN (1,2));
ALTER TABLE tool_calls
 ADD COLUMN tool_contract_version TINYINT UNSIGNED NOT NULL DEFAULT 1,
 ADD CONSTRAINT tool_calls_tool_contract_version CHECK (tool_contract_version IN (1,2));

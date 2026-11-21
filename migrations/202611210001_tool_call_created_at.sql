-- 运行活动提示需要每条工具调用的登记时间；历史行以默认值冻结，不回填推定顺序。
ALTER TABLE tool_calls
 ADD COLUMN created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

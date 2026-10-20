-- 生成正文来源独立于模型选择的引用；旧记录缺少完整来源，不伪造空依赖。
ALTER TABLE analysis_evidence ADD COLUMN text_authority JSON NULL;
ALTER TABLE analysis_report_revisions ADD COLUMN text_authorities JSON NULL;

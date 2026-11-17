-- 新提交保存原文的有序来源边界；旧NULL行继续使用历史兼容读取，不回填历史。
ALTER TABLE assistant_outputs ADD COLUMN read_binding JSON NULL;

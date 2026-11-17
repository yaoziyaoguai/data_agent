-- 正常request scope不再携带累计调用上限：call_limit允许NULL表达无次数门。
-- 旧scope数字与已用计数原样冻结；不清计数、不改旧trial或未知预留。
ALTER TABLE budget_scopes
 MODIFY COLUMN call_limit INT UNSIGNED NULL;

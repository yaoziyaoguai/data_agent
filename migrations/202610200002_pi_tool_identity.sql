-- Pi Responses 使用 call_id|item_id，完整保留SDK身份和区分大小写的重放键。
ALTER TABLE tool_calls MODIFY sdk_tool_call_id VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL;

-- 定稿沿原工具行保存宿主条目与输出引用；旧操作缺字段不推断为已定稿。
ALTER TABLE tool_calls
 ADD COLUMN answer_handoff JSON NULL,
 ADD COLUMN answer_part_sequence BIGINT UNSIGNED NULL,
 ADD UNIQUE KEY answer_part_order (conversation_id,recovery_chain_id,answer_part_sequence);

ALTER TABLE assistant_outputs ADD COLUMN answer_parts JSON NULL;

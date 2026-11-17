-- retrieval私有保存raw来源在实际集合上的投影进度：集合身份含代次，完成状态
-- 不只绑定配置名。applied_position为已应用到的原文Unicode字符位置；knowledge
-- 目标的投影进度仍由knowledge_index_jobs的待办状态承担。
CREATE TABLE retrieval_source_projections(
 source_kind VARCHAR(16) NOT NULL,
 source_id VARCHAR(64) NOT NULL,
 space_id VARCHAR(64) NOT NULL,
 revision BIGINT UNSIGNED NOT NULL,
 collection_target VARCHAR(64) NOT NULL,
 embedding_model VARCHAR(64) NOT NULL,
 segmentation_version INT UNSIGNED NOT NULL,
 applied_position BIGINT UNSIGNED NOT NULL,
 complete TINYINT UNSIGNED NOT NULL DEFAULT 0,
 updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
 PRIMARY KEY(source_kind,source_id,space_id)
);

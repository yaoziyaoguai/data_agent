-- 服务端可吊销会话：Cookie只下发随机令牌，库中仅存SHA-256摘要；吊销即拒登。
CREATE TABLE user_sessions (
 id CHAR(64) NOT NULL,
 user_id VARCHAR(64) NOT NULL,
 space_id VARCHAR(64) NOT NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 expires_at DATETIME(3) NOT NULL,
 revoked_at DATETIME(3) NULL,
 PRIMARY KEY(id)
);

CREATE TABLE model_space_settings (
    space_id VARCHAR(128) PRIMARY KEY,
    version BIGINT UNSIGNED NOT NULL DEFAULT 1,
    default_model_id VARCHAR(128) NULL,
    managed BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE model_services (
    space_id VARCHAR(128) NOT NULL,
    id VARCHAR(128) NOT NULL,
    version BIGINT UNSIGNED NOT NULL,
    payload JSON NOT NULL,
    last_fingerprint CHAR(64) NOT NULL,
    PRIMARY KEY(space_id,id)
);
CREATE TABLE model_service_versions (
    space_id VARCHAR(128) NOT NULL,
    id VARCHAR(128) NOT NULL,
    version BIGINT UNSIGNED NOT NULL,
    payload JSON NOT NULL,
    encrypted_key LONGBLOB NULL,
    updated_by VARCHAR(128) NOT NULL,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY(space_id,id,version)
);
CREATE TABLE model_definitions (
    space_id VARCHAR(128) NOT NULL,
    id VARCHAR(128) NOT NULL,
    version BIGINT UNSIGNED NOT NULL,
    payload JSON NOT NULL,
    last_fingerprint CHAR(64) NOT NULL,
    PRIMARY KEY(space_id,id)
);
CREATE TABLE model_definition_versions (
    space_id VARCHAR(128) NOT NULL,
    id VARCHAR(128) NOT NULL,
    version BIGINT UNSIGNED NOT NULL,
    payload JSON NOT NULL,
    updated_by VARCHAR(128) NOT NULL,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY(space_id,id,version)
);

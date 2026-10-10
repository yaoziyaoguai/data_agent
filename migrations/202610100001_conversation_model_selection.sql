ALTER TABLE conversations
  ADD COLUMN model_selection JSON NULL,
  ADD COLUMN model_selection_version BIGINT UNSIGNED NOT NULL DEFAULT 0;

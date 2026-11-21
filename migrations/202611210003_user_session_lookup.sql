ALTER TABLE user_sessions
  ADD INDEX sessions_by_owner (space_id, user_id),
  ADD INDEX sessions_by_expiration (expires_at);

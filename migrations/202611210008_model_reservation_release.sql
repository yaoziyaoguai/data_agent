ALTER TABLE model_call_attempts
 ADD COLUMN reservation_released_at DATETIME(3) NULL,
 ADD INDEX model_reservation_expiry(state,reservation_released_at,permit_expires_at);

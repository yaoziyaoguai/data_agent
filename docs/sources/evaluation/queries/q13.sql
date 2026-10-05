SELECT SUM(paid_amount_cents) AS test_paid_cents
FROM demo_order_detail WHERE is_test = 1
  AND paid_at >= '2026-01-01T00:00:00Z'
  AND paid_at < '2026-02-01T00:00:00Z';

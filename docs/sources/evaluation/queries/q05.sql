SELECT ROUND(1.0 * SUM(refunded_amount_cents) /
       NULLIF(SUM(paid_amount_cents), 0), 4) AS amount_refund_rate
FROM demo_order_detail
WHERE paid_at >= '2026-01-01T00:00:00Z'
  AND paid_at < '2026-02-01T00:00:00Z' AND is_test = 0;

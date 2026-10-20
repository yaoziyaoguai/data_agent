SELECT channel,
       SUM(paid_amount_cents - refunded_amount_cents) AS net_cents
FROM demo_order_detail
WHERE is_test = 0
  AND paid_amount_cents > 0
  AND paid_at >= '2026-01-01T00:00:00Z'
  AND paid_at < '2026-02-01T00:00:00Z'
GROUP BY channel
ORDER BY channel;

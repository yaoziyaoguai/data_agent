SELECT SUBSTR(paid_at,1,7) AS month,
       SUM(paid_amount_cents) AS paid_cents,
       SUM(refunded_amount_cents) AS refund_cents,
       SUM(paid_amount_cents-refunded_amount_cents) AS net_cents,
       COUNT(DISTINCT order_id) AS paid_orders,
       COUNT(DISTINCT customer_id) AS known_customers
FROM demo_order_detail
WHERE is_test=0 AND paid_amount_cents>0
  AND paid_at >= '2026-01-01T00:00:00Z' AND paid_at < '2026-04-01T00:00:00Z'
GROUP BY SUBSTR(paid_at,1,7) ORDER BY month;

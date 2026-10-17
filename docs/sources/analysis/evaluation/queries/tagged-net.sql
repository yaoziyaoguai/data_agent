SELECT SUBSTR(d.paid_at,1,7) AS month,
       SUM(d.paid_amount_cents) AS paid_cents,
       SUM(d.refunded_amount_cents) AS refund_cents,
       SUM(d.paid_amount_cents-d.refunded_amount_cents) AS net_cents,
       COUNT(DISTINCT d.customer_id) AS known_customers
FROM demo_order_detail d
WHERE d.is_test=0 AND d.paid_amount_cents>0
  AND d.paid_at >= '2026-01-01T00:00:00Z' AND d.paid_at < '2026-04-01T00:00:00Z'
  AND EXISTS (SELECT 1 FROM customer_tags t WHERE t.customer_id=d.customer_id AND t.tag IN ('vip','newsletter'))
GROUP BY SUBSTR(d.paid_at,1,7) ORDER BY month;

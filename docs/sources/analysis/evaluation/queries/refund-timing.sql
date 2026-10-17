SELECT SUBSTR(p.event_at,1,7) AS month,
       SUM(p.amount_cents) AS refund_cents,
       COUNT(DISTINCT l.order_id) AS refund_orders
FROM raw_order_lines l JOIN raw_payments p
  ON l.order_id=p.order_id AND l.line_id=p.line_id
WHERE l.is_test=0 AND p.event_status='success' AND p.event_type='refund'
  AND p.event_at >= '2026-01-01T00:00:00Z' AND p.event_at < '2026-04-04T00:00:00Z'
GROUP BY SUBSTR(p.event_at,1,7) ORDER BY month;

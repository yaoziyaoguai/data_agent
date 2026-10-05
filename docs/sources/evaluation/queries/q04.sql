WITH paid_orders AS (
 SELECT DISTINCT order_id
 FROM demo_order_detail
 WHERE paid_at >= '2026-01-01T00:00:00Z'
  AND paid_at < '2026-02-01T00:00:00Z' AND is_test = 0 AND paid_amount_cents > 0
), orders AS (
 SELECT p.order_id, EXISTS (
  SELECT 1 FROM demo_order_detail AS r
  WHERE r.order_id = p.order_id AND r.is_test = 0 AND r.refunded_amount_cents > 0
 ) AS has_refund
 FROM paid_orders AS p
)
SELECT SUM(has_refund) AS refunded_orders, COUNT(*) AS paid_orders,
       1.0 * SUM(has_refund) / NULLIF(COUNT(*), 0) AS order_refund_rate
FROM orders;

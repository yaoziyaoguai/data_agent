-- 合成演示快照截止 2026-02-04T00:00:00Z，区间右侧不含截止时点。
-- 在事务内完整重建，避免将重复运行误算为新增业务记录。
BEGIN;
DELETE FROM demo_order_detail;
WITH line_payments AS (
    SELECT order_id, line_id,
           SUM(CASE WHEN event_type = 'charge' THEN amount_cents ELSE 0 END) AS paid,
           SUM(CASE WHEN event_type = 'refund' THEN amount_cents ELSE 0 END) AS refunded,
           MIN(CASE WHEN event_type = 'charge' THEN event_at END) AS paid_at
    FROM raw_payments
    WHERE event_status = 'success'
      AND event_at < '2026-02-04T00:00:00Z'
    GROUP BY order_id, line_id
), order_totals AS (
    SELECT order_id, SUM(paid) AS paid, SUM(refunded) AS refunded
    FROM line_payments
    GROUP BY order_id
)
INSERT INTO demo_order_detail
SELECT l.order_id, l.line_id, l.customer_id, l.product_id, l.quantity,
       COALESCE(p.paid, 0), COALESCE(p.refunded, 0), p.paid_at,
       SUBSTR(l.ordered_at, 1, 10), l.channel, c.region, l.is_test,
       CASE WHEN l.source_status = 'cancelled' THEN 'cancelled'
            WHEN COALESCE(t.paid, 0) = 0 THEN 'unpaid'
            WHEN t.refunded = t.paid THEN 'refunded'
            ELSE 'paid' END
FROM raw_order_lines AS l
LEFT JOIN line_payments AS p ON l.order_id = p.order_id AND l.line_id = p.line_id
LEFT JOIN order_totals AS t ON l.order_id = t.order_id
LEFT JOIN dim_customers AS c ON l.customer_id = c.customer_id
WHERE l.ordered_at < '2026-02-04T00:00:00Z';
COMMIT;

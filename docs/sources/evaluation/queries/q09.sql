SELECT SUBSTR(paid_at, 1, 7) AS paid_month,
       SUM(paid_amount_cents - refunded_amount_cents) AS net_cents,
       COUNT(DISTINCT customer_id) AS customer_uv
FROM demo_order_detail
WHERE paid_at IS NOT NULL AND is_test = 0
GROUP BY SUBSTR(paid_at, 1, 7) ORDER BY paid_month;

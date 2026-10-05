WITH daily AS (
 SELECT SUBSTR(paid_at, 1, 10) AS day, COUNT(DISTINCT customer_id) AS uv
 FROM demo_order_detail
 WHERE paid_at >= '2026-01-01T00:00:00Z'
  AND paid_at < '2026-02-01T00:00:00Z' AND is_test = 0
 GROUP BY SUBSTR(paid_at, 1, 10)
)
SELECT SUM(uv) AS daily_uv_sum FROM daily;

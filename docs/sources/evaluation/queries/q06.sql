SELECT SUM(d.paid_amount_cents - d.refunded_amount_cents) AS net_cents
FROM demo_order_detail AS d
WHERE paid_at >= '2026-01-01T00:00:00Z'
  AND paid_at < '2026-02-01T00:00:00Z' AND is_test = 0
  AND EXISTS (SELECT 1 FROM customer_tags AS t
              WHERE t.customer_id = d.customer_id
                AND t.tag IN ('vip', 'newsletter'));

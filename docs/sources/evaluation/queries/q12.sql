SELECT SUM(p.amount_cents) AS refund_cash_cents
FROM raw_payments AS p
JOIN raw_order_lines AS l ON p.order_id = l.order_id AND p.line_id = l.line_id
WHERE p.event_type = 'refund' AND p.event_status = 'success' AND l.is_test = 0
  AND p.event_at >= '2026-02-01T00:00:00Z'
  AND p.event_at < '2026-02-04T00:00:00Z';

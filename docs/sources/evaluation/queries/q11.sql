SELECT line_id, paid_amount_cents, refunded_amount_cents, order_status
FROM demo_order_detail WHERE order_id = 'O1013' ORDER BY line_id;

WITH channel_months AS (
  SELECT channel,SUBSTR(paid_at,1,7) AS month,
         SUM(paid_amount_cents-refunded_amount_cents) AS net_cents
  FROM demo_order_detail
  WHERE is_test=0 AND paid_amount_cents>0
    AND paid_at >= '2026-02-01T00:00:00Z' AND paid_at < '2026-04-01T00:00:00Z'
  GROUP BY channel,SUBSTR(paid_at,1,7)
), changes AS (
  SELECT channel,
         SUM(CASE WHEN month='2026-02' THEN net_cents ELSE 0 END) AS previous_net_cents,
         SUM(CASE WHEN month='2026-03' THEN net_cents ELSE 0 END) AS current_net_cents
  FROM channel_months GROUP BY channel
)
SELECT channel,previous_net_cents,current_net_cents,
       current_net_cents-previous_net_cents AS delta_cents,
       SUM(current_net_cents-previous_net_cents) OVER () AS total_delta_cents
FROM changes ORDER BY channel;

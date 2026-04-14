-- Dashboard 2 — Subscription Health
-- Paste each "-- ==" block into a separate Metabase SQL question.

-- == Q1 — Active subscriptions (scalar) ==
select count(*) as active_subscriptions
from public.subscriptions
where status = 'active';

-- == Q2 — Subscriptions due in the next 7 days ==
-- Visualization: Table, sorted by next_fulfillment_date.
select
  subscription_id,
  order_id,
  customer_email,
  product_name,
  frequency,
  next_fulfillment_date,
  (next_fulfillment_date - current_date) as days_until_due
from public.subscriptions
where status = 'active'
  and next_fulfillment_date is not null
  and next_fulfillment_date between current_date
                                and current_date + interval '7 days'
order by next_fulfillment_date asc;

-- == Q3 — Overdue subscriptions ==
-- Visualization: Table. Anything active with a next_fulfillment_date in the past.
select
  subscription_id,
  order_id,
  customer_email,
  product_name,
  frequency,
  next_fulfillment_date,
  (current_date - next_fulfillment_date) as days_overdue
from public.subscriptions
where status = 'active'
  and next_fulfillment_date is not null
  and next_fulfillment_date < current_date
order by next_fulfillment_date asc;

-- == Q4 — Subscription status breakdown (pie chart) ==
select
  coalesce(status, 'unknown') as status,
  count(*) as subscriptions
from public.subscriptions
group by 1
order by 2 desc;

-- == Q5 — Churn over time (monthly) ==
-- Treat any status that isn't 'active' as churn for reporting.
-- Visualization: Line chart, x = month, y = churned count.
select
  date_trunc('month', synced_at)::date as month,
  count(*) filter (where status <> 'active') as churned,
  count(*) filter (where status  = 'active') as active,
  round(
    100.0 *
      count(*) filter (where status <> 'active')::numeric /
      nullif(count(*), 0),
    2
  ) as churn_pct
from public.subscriptions
group by 1
order by 1;

-- Dashboard 2 — Subscription Health
-- Paste each "-- ==" block into a separate Metabase SQL question.
--
-- Schema note: Monto's /orders/{id}/subscriptions endpoint only returns
--   { stripe_id, status, created_at }
-- so public.subscriptions has columns next_fulfillment_date / frequency /
-- product_name / customer_email that are always NULL. These questions
-- therefore pull customer identity from public.orders via order_id and
-- derive timing from raw->>'created_at' (Monto's view of Stripe time).
-- If you later hydrate next_fulfillment / frequency / product from Stripe
-- directly, add back the date-based upcoming/overdue queries.

-- == Q1 — Active subscriptions (scalar) ==
select count(*) as active_subscriptions
from public.subscriptions
where status = 'active';

-- == Q2 — Subscription status breakdown (pie chart) ==
select
  coalesce(status, 'unknown') as status,
  count(*) as subscriptions
from public.subscriptions
group by 1
order by 2 desc;

-- == Q3 — Active subscribers, joined to order details (table) ==
-- Use this as the action list for the subscription team. Customer
-- identity comes from the linked Webflow order since Monto itself
-- doesn't return it on this endpoint.
select
  s.subscription_id,
  s.status,
  s.order_id,
  o.customer_name,
  o.customer_email,
  (s.raw->>'created_at')::timestamptz as subscription_started_at,
  o.accepted_on                      as original_order_date,
  o.customer_paid                    as original_order_amount
from public.subscriptions s
left join public.orders o on o.order_id = s.order_id
where s.status = 'active'
order by (s.raw->>'created_at')::timestamptz desc nulls last;

-- == Q4 — New subscriptions per week (line chart) ==
-- Uses Monto's created_at (i.e. when the Stripe subscription was born),
-- not synced_at (when we first saw it in our sync).
select
  date_trunc('week', (raw->>'created_at')::timestamptz)::date as week,
  count(*) as new_subscriptions
from public.subscriptions
where raw ? 'created_at'
group by 1
order by 1;

-- == Q5 — Churn over time (monthly) ==
-- Cohort each subscription by the month Monto says it was created, then
-- split into still-active vs churned based on current status.
-- Visualization: stacked bar, x = cohort_month.
select
  date_trunc('month', (raw->>'created_at')::timestamptz)::date as cohort_month,
  count(*) filter (where status = 'active')  as still_active,
  count(*) filter (where status <> 'active') as churned,
  round(
    100.0 *
      count(*) filter (where status <> 'active')::numeric /
      nullif(count(*), 0),
    2
  ) as churn_pct
from public.subscriptions
where raw ? 'created_at'
group by 1
order by 1;

-- == Q6 — Orders with a subscription vs without (scalar / pie) ==
-- Pulls from monto_sync_log so we count every order we've checked, not
-- just ones that happened to match a subscription. Anything not yet in
-- the log is excluded.
select
  case when has_subscription then 'subscription' else 'one-time' end as kind,
  count(*) as orders
from public.monto_sync_log
group by 1
order by 2 desc;

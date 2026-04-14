-- Dashboard 1 — Order Fulfillment
-- Paste each "-- ==" block into a separate Metabase SQL question.

-- == Q1 — Unfulfilled orders sorted by age ==
-- Visualization: Table
select
  order_id,
  customer_name,
  customer_email,
  accepted_on,
  date_trunc('day', now() - accepted_on)::text as age,
  customer_paid,
  purchased_items_count,
  shipping_city,
  shipping_state
from public.orders
where status <> 'fulfilled'
  and refunded_on is null
  and disputed_on is null
  and accepted_on is not null
order by accepted_on asc;

-- == Q2 — Orders missing tracking where shipping is required ==
-- Visualization: Table. Action item list for the fulfillment team.
select
  order_id,
  customer_name,
  customer_email,
  accepted_on,
  fulfilled_on,
  shipping_provider,
  shipping_city,
  shipping_state,
  shipping_zip
from public.orders
where is_shipping_required = true
  and (shipping_tracking is null or shipping_tracking = '')
  and status <> 'refunded'
  and refunded_on is null
order by accepted_on asc;

-- == Q3 — Orders fulfilled today ==
-- Visualization: Scalar (big number) + a table below.
select
  count(*) as fulfilled_today_count,
  coalesce(sum(customer_paid), 0) as fulfilled_today_revenue
from public.orders
where fulfilled_on >= date_trunc('day', now() at time zone 'UTC')
  and fulfilled_on <  date_trunc('day', now() at time zone 'UTC') + interval '1 day';

-- == Q4 — Fulfilled-today detail list ==
-- Visualization: Table
select
  order_id,
  customer_name,
  fulfilled_on,
  shipping_provider,
  shipping_tracking,
  shipping_tracking_url,
  customer_paid
from public.orders
where fulfilled_on >= date_trunc('day', now() at time zone 'UTC')
order by fulfilled_on desc;

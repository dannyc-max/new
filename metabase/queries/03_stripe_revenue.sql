-- Dashboard 3 — Stripe Revenue
-- Revenue numbers are pulled from public.stripe_charges (true money moved)
-- rather than public.orders.customer_paid (what Webflow believed was paid).
-- Joining lets you slice by order metadata if you want.

-- == Q1 — Gross revenue by week (line chart) ==
select
  date_trunc('week', created_at)::date as week,
  sum(amount_captured) - sum(amount_refunded) as gross_revenue,
  count(*) as charges
from public.stripe_charges
where status = 'succeeded'
group by 1
order by 1;

-- == Q2 — Gross revenue by month (bar chart) ==
select
  date_trunc('month', created_at)::date as month,
  sum(amount_captured) - sum(amount_refunded) as gross_revenue,
  count(*) as charges
from public.stripe_charges
where status = 'succeeded'
group by 1
order by 1;

-- == Q3 — Stripe fees by week ==
select
  date_trunc('week', created_at)::date as week,
  sum(fee) as stripe_fees
from public.stripe_charges
where status = 'succeeded'
group by 1
order by 1;

-- == Q4 — Stripe fees by month ==
select
  date_trunc('month', created_at)::date as month,
  sum(fee) as stripe_fees
from public.stripe_charges
where status = 'succeeded'
group by 1
order by 1;

-- == Q5 — Net revenue after fees (combined weekly line chart) ==
select
  date_trunc('week', created_at)::date as week,
  sum(amount_captured) - sum(amount_refunded) as gross_revenue,
  sum(fee)                                   as stripe_fees,
  sum(net)                                   as net_revenue
from public.stripe_charges
where status = 'succeeded'
group by 1
order by 1;

-- == Q6 — Average fee percentage (scalar) ==
-- Fee as a share of captured amount over the last 90 days.
select
  round(
    100.0 * sum(fee)::numeric /
      nullif(sum(amount_captured) - sum(amount_refunded), 0),
    3
  ) as avg_fee_pct_90d
from public.stripe_charges
where status = 'succeeded'
  and created_at >= now() - interval '90 days';

-- == Q7 — Per-order true economics (table, last 30 days) ==
-- Ties Webflow order data to Stripe fees — useful for gross-margin reporting.
select
  o.order_id,
  o.accepted_on,
  o.customer_email,
  o.customer_paid      as webflow_customer_paid,
  sc.amount_captured   as stripe_captured,
  sc.amount_refunded   as stripe_refunded,
  sc.fee               as stripe_fee,
  sc.net               as stripe_net,
  sc.refunded
from public.orders o
left join public.stripe_charges sc on sc.charge_id = o.stripe_charge_id
where o.accepted_on >= now() - interval '30 days'
order by o.accepted_on desc;

-- Monto subscriptions table. One row per subscription id.
-- An order can have multiple subscriptions (one per subscribed product line).
create table if not exists public.subscriptions (
  subscription_id        text primary key,
  order_id               text references public.orders(order_id) on delete set null,
  status                 text,
  next_fulfillment_date  date,
  frequency              text,
  product_name           text,
  customer_email         text,
  raw                    jsonb,
  synced_at              timestamptz not null default now()
);

create index if not exists subscriptions_order_idx
  on public.subscriptions (order_id);

create index if not exists subscriptions_status_idx
  on public.subscriptions (status);

create index if not exists subscriptions_next_fulfillment_idx
  on public.subscriptions (next_fulfillment_date);

alter table public.subscriptions enable row level security;

comment on table public.subscriptions is
  'Monto subscription data synced daily at 8am UTC by the monto-sync edge function.';

-- Log table tracks which orders have been checked against Monto so we can
-- skip orders that never subscribe during routine daily syncs.
create table if not exists public.monto_sync_log (
  order_id         text primary key references public.orders(order_id) on delete cascade,
  last_checked_at  timestamptz not null default now(),
  has_subscription boolean not null default false
);

create index if not exists monto_sync_log_has_sub_idx
  on public.monto_sync_log (has_subscription);

alter table public.monto_sync_log enable row level security;

comment on table public.monto_sync_log is
  'Bookkeeping for monto-sync so full order scans are not repeated daily.';

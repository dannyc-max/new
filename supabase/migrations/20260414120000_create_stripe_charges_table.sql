-- Stripe charges table. One row per Stripe charge id.
-- Joined to public.orders via orders.stripe_charge_id = stripe_charges.charge_id.
create table if not exists public.stripe_charges (
  charge_id              text primary key,
  amount                 numeric,
  amount_captured        numeric,
  fee                    numeric,
  net                    numeric,
  currency               text default 'usd',
  status                 text,
  created_at             timestamptz,
  customer_id            text,
  payment_intent_id      text,
  refunded               boolean default false,
  amount_refunded        numeric,
  receipt_url            text,
  balance_transaction_id text,
  raw                    jsonb,
  synced_at              timestamptz not null default now()
);

create index if not exists stripe_charges_created_at_idx
  on public.stripe_charges (created_at desc);

create index if not exists stripe_charges_payment_intent_idx
  on public.stripe_charges (payment_intent_id);

create index if not exists stripe_charges_customer_idx
  on public.stripe_charges (customer_id);

alter table public.stripe_charges enable row level security;

comment on table public.stripe_charges is
  'Stripe charge data synced daily at 7am UTC by the stripe-sync edge function.';

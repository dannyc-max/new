# Penny Cup Coffee — Data Pipeline

Retail data pipeline (phase 1) that pulls from Webflow, Stripe, and Monto
into Supabase, then visualizes in Metabase.

```
Webflow ─┐
Stripe  ─┼──▶ Supabase Postgres ──▶ Metabase
Monto   ─┘
```

## Repository layout

```
supabase/
├── migrations/                              # versioned schema + cron
│   ├── 20260414120000_create_stripe_charges_table.sql
│   ├── 20260414120100_create_subscriptions_table.sql
│   └── 20260414120200_schedule_stripe_and_monto_syncs.sql
└── functions/
    ├── stripe-sync/index.ts                 # 7am UTC daily
    └── monto-sync/index.ts                  # 8am UTC daily
metabase/
├── README.md                                # self-host + connection guide
└── queries/                                 # copy-paste dashboard SQL
    ├── 01_order_fulfillment.sql
    ├── 02_subscription_health.sql
    └── 03_stripe_revenue.sql
index.html                                   # marketing page (unchanged)
```

## Pipelines

| Source  | Function              | Slug (URL)        | Schedule  | Target tables                    |
| ------- | --------------------- | ----------------- | --------- | -------------------------------- |
| Webflow | `sync-webflow-orders` | `hyper-processor` | 6 AM UTC  | `orders`                         |
| Stripe  | `stripe-sync`         | `stripe-sync`     | 7 AM UTC  | `stripe_charges`                 |
| Monto   | `monto-sync`          | `monto-sync`      | 8 AM UTC  | `subscriptions`, `monto_sync_log`|

> The Webflow function's slug (`hyper-processor`) is immutable in Supabase, so
> the URL and cron job still reference the original slug even though the
> display name has been updated to `sync-webflow-orders`.

Each job is scheduled through `pg_cron` and invokes the corresponding
edge function via `pg_net`. See the scheduling migration for the exact SQL.

## One-time setup you still need to do

All schema + cron + edge functions are deployed. To activate the two new
pipelines you still need to:

1. **Add two secrets** to Supabase → Project Settings → Edge Functions → Secrets:
   - `STRIPE_SECRET_KEY` — your Stripe secret key (`sk_live_…` or `sk_test_…`)
   - `MONTO_API_KEY` — your Monto API key
2. **Trigger a one-time backfill** so the tables aren't empty on day one:
   - `GET /functions/v1/stripe-sync?mode=full`
   - `GET /functions/v1/monto-sync?mode=full`
   (Details and curl examples in `metabase/README.md`.)
3. **Stand up Metabase** per `metabase/README.md` (Fly.io or Railway,
   ~$5/mo) and import the dashboard SQL from `metabase/queries/`.

After step 1 and 2 the daily cron runs will keep everything fresh with no
further action required.

## Cost budget

| Item                               | Monthly |
| ---------------------------------- | ------- |
| Supabase (free tier covers this)   | $0      |
| Metabase on Fly.io (1 GB machine)  | ~$5–15  |
| Stripe / Monto / Webflow API calls | $0      |
| **Total**                          | **≤ $15** |

## Phase 2 (not yet built)

RoasterTools wholesale data sync when their API ships. Plan: add a
`wholesale_orders` table and a third edge function on the same pattern.

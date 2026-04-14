# Metabase setup for Penny Cup Coffee

Metabase is the dashboard layer over the Supabase Postgres database.
Everything below is browser-only or one-click-deploy — no local installs.

## 1. Host Metabase

Goal: < $20/mo total for the whole stack.

### Option A — Metabase Cloud (easiest, $85/mo starter)

Too expensive for the $20 cap. Skip unless budget changes.

### Option B — Fly.io ($5–15/mo, recommended)

1. Sign in at [fly.io](https://fly.io) (GitHub login works).
2. Click **Launch app** → paste the public Metabase Docker image
   `metabase/metabase:latest`.
3. Choose region `iad` (closest to Supabase US-East), 1GB memory.
4. Skip Postgres (Metabase will store its own internal state on the
   attached volume; we only need a volume of 1GB).
5. Add a persistent volume named `metabase_data` mounted at `/metabase-data`.
6. Set the env var `MB_DB_FILE=/metabase-data/metabase.db`.
7. Deploy. Fly gives you a `*.fly.dev` URL.

### Option C — Railway ($5/mo)

Similar to Fly. Paste `metabase/metabase:latest`, attach a 1GB volume,
set `MB_DB_FILE=/metabase-data/metabase.db`.

## 2. Connect Metabase to Supabase

In Metabase → **Admin settings → Databases → Add database**:

| Field           | Value                                        |
| --------------- | -------------------------------------------- |
| Database type   | PostgreSQL                                   |
| Display name    | Penny Cup (Supabase)                         |
| Host            | `aws-0-us-east-1.pooler.supabase.com`        |
| Port            | `6543` (transaction pooler — Metabase-safe)  |
| Database name   | `postgres`                                   |
| Username        | `postgres.jiqkhinnzqxvkzkihufa`              |
| Password        | Supabase project DB password                 |
| SSL             | Required                                     |

The pooler host / port / username come from
**Supabase → Project Settings → Database → Connection string → Transaction**.
Use the session pooler (port `5432`) instead if you need prepared statements.

## 3. Build the dashboards

Use the SQL files in `metabase/queries/`. In Metabase each `-- ==` block
is one question. Create each question with **+ New → SQL query**, paste
it, save, then drop the saved questions onto a dashboard.

| Dashboard              | Query file                      |
| ---------------------- | ------------------------------- |
| Order Fulfillment      | `queries/01_order_fulfillment.sql` |
| Subscription Health    | `queries/02_subscription_health.sql` |
| Stripe Revenue         | `queries/03_stripe_revenue.sql` |

## 4. Backfill the data once

The cron schedules will start running tomorrow. To populate the tables
immediately, invoke each edge function once from the Supabase dashboard
(**Edge Functions → <fn> → Invoke**) or via curl with your service role
key in the `apikey` header:

```
# Full Stripe backfill (walks every charge in the account)
curl -s "https://jiqkhinnzqxvkzkihufa.supabase.co/functions/v1/stripe-sync?mode=full" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY"

# Full Monto scan (walks every order, batched concurrently)
curl -s "https://jiqkhinnzqxvkzkihufa.supabase.co/functions/v1/monto-sync?mode=full" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY"
```

If `monto-sync` returns `"timedOut": true`, just invoke it again — the
log table ensures the second run skips what was already processed.

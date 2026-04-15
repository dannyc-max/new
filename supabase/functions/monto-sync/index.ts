// Monto subscription sync.
// For each order in public.orders we call
//   GET https://api.monto.io/orders/{order_id}/subscriptions?api_key=...
// and upsert returned subscription rows into public.subscriptions.
//
// Monto doesn't expose a list endpoint so we paginate per-order.
// We keep a monto_sync_log table so we can skip orders that have already
// been confirmed to have no subscriptions on subsequent daily runs.
//
// Priority order on each run:
//   1. Orders known to have a subscription (so status/next_fulfillment refresh).
//   2. Orders never checked before.
//   3. Orders last checked > 14 days ago (re-verify stale nulls).
//
// Env vars required:
//   MONTO_API_KEY
//   DB_URL
//   DB_SERVICE_ROLE_KEY
//
// Query params:
//   ?mode=full   - ignore the log and recheck every order
//   ?limit=N     - max orders to process in this invocation (default 2000)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const MONTO_BASE = "https://api.monto.io";
// Monto's API is Laravel throttled at ~30 req/min/IP (measured empirically:
// 60 successes in a 120s probe, with 25 further requests returning 429).
// Pace at 2200ms/request (~27/min) for safe headroom.
const CONCURRENCY = 1;
const INTER_REQUEST_DELAY_MS = 2200;
const DEFAULT_LIMIT = 2000;
const WALL_CLOCK_BUDGET_MS = 140_000;

// Monto returns each subscription as:
//   { stripe_id: "sub_...", status: "trialing", created_at: "2026-..." }
// That's all the fields Monto exposes; next_fulfillment_date, frequency,
// product_name, customer_email etc. live in Stripe and can be hydrated
// there if we ever pull /v1/subscriptions.
type MontoSubscription = {
  stripe_id?: string;
  id?: string;
  subscription_id?: string;
  status?: string;
  created_at?: string;
  [k: string]: unknown;
};

Deno.serve(async (req: Request) => {
  const MONTO_KEY = Deno.env.get("MONTO_API_KEY");
  const SUPABASE_URL = Deno.env.get("DB_URL");
  const SUPABASE_KEY = Deno.env.get("DB_SERVICE_ROLE_KEY");

  if (!MONTO_KEY) return json({ error: "MONTO_API_KEY not set" }, 500);
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return json({ error: "Supabase creds not set" }, 500);
  }

  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") ?? "incremental";
  const maxToProcess = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const started = Date.now();

  // Build the target order list.
  const orderIds = await buildOrderQueue(supabase, mode, maxToProcess);

  let processed = 0;
  let subsUpserted = 0;
  let errors = 0;
  let timedOut = false;
  const errorSamples: Array<{ order_id: string; error: string }> = [];
  const errorStatusCounts: Record<string, number> = {};
  const subSamples: Array<{ order_id: string; raw: unknown }> = [];

  // Process in concurrent chunks.
  for (let i = 0; i < orderIds.length; i += CONCURRENCY) {
    if (Date.now() - started > WALL_CLOCK_BUDGET_MS) {
      timedOut = true;
      break;
    }

    if (i > 0) await sleep(INTER_REQUEST_DELAY_MS);
    const chunk = orderIds.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      chunk.map((id) => fetchForOrder(id, MONTO_KEY)),
    );

    const subsRows: Record<string, unknown>[] = [];
    const logRows: Record<string, unknown>[] = [];
    const now = new Date().toISOString();

    for (const r of results) {
      processed += 1;
      if (r.error) {
        errors += 1;
        errorStatusCounts[r.error] = (errorStatusCounts[r.error] ?? 0) + 1;
        if (errorSamples.length < 5) {
          errorSamples.push({ order_id: r.order_id, error: r.error });
        }
        continue;
      }
      logRows.push({
        order_id: r.order_id,
        last_checked_at: now,
        has_subscription: r.subscriptions.length > 0,
      });
      if (r.subscriptions.length > 0 && subSamples.length < 3) {
        subSamples.push({ order_id: r.order_id, raw: r.subscriptions });
      }
      for (const s of r.subscriptions) {
        const subId = s.stripe_id ?? s.id ?? s.subscription_id;
        if (!subId) continue;
        subsRows.push({
          subscription_id: String(subId),
          order_id: r.order_id,
          status: s.status ?? null,
          raw: s as unknown as Record<string, unknown>,
          synced_at: now,
        });
      }
    }

    if (subsRows.length > 0) {
      const { error } = await supabase
        .from("subscriptions")
        .upsert(subsRows, { onConflict: "subscription_id" });
      if (error) return json({ error: error.message, processed }, 500);
      subsUpserted += subsRows.length;
    }

    if (logRows.length > 0) {
      const { error } = await supabase
        .from("monto_sync_log")
        .upsert(logRows, { onConflict: "order_id" });
      if (error) return json({ error: error.message, processed }, 500);
    }
  }

  return json({
    ok: true,
    mode,
    queued: orderIds.length,
    processed,
    subsUpserted,
    errors,
    errorStatusCounts,
    errorSamples,
    subSamples,
    timedOut,
    durationMs: Date.now() - started,
  });
});

async function buildOrderQueue(
  supabase: ReturnType<typeof createClient>,
  mode: string,
  maxToProcess: number,
): Promise<string[]> {
  if (mode === "full") {
    const { data, error } = await supabase
      .from("orders")
      .select("order_id")
      .order("accepted_on", { ascending: false })
      .range(0, maxToProcess - 1);
    if (error) throw new Error(error.message);
    return (data ?? []).map((r: { order_id: string }) => r.order_id);
  }

  // NOTE: PostgREST caps `select()` at 1000 rows by default. Our orders
  // table has ~3500 rows; without `.range()` the "never-checked" bucket
  // appears empty once the 1000 most-recent orders have been logged, and
  // the backfill stalls. Using .range() up to a large upper bound pulls
  // the full set in a single request.

  // Priority 1: orders with a known subscription — recheck every run.
  const { data: knownSubOrders, error: e1 } = await supabase
    .from("monto_sync_log")
    .select("order_id")
    .eq("has_subscription", true)
    .range(0, 9999);
  if (e1) throw new Error(e1.message);

  const known = new Set<string>(
    (knownSubOrders ?? []).map((r: { order_id: string }) => r.order_id),
  );

  // Priority 2: orders we've never checked.
  const { data: allOrders, error: e2 } = await supabase
    .from("orders")
    .select("order_id, accepted_on")
    .order("accepted_on", { ascending: false })
    .range(0, 49999);
  if (e2) throw new Error(e2.message);

  const { data: checkedRows, error: e3 } = await supabase
    .from("monto_sync_log")
    .select("order_id, last_checked_at, has_subscription")
    .range(0, 49999);
  if (e3) throw new Error(e3.message);

  const checkedMap = new Map<
    string,
    { last_checked_at: string; has_subscription: boolean }
  >();
  for (const c of checkedRows ?? []) {
    checkedMap.set(c.order_id as string, {
      last_checked_at: c.last_checked_at as string,
      has_subscription: c.has_subscription as boolean,
    });
  }

  const never: string[] = [];
  const staleNulls: string[] = [];
  const cutoffDays14 = Date.now() - 14 * 24 * 60 * 60 * 1000;

  for (const o of allOrders ?? []) {
    const id = o.order_id as string;
    if (known.has(id)) continue;
    const checked = checkedMap.get(id);
    if (!checked) {
      never.push(id);
    } else if (
      !checked.has_subscription &&
      new Date(checked.last_checked_at).getTime() < cutoffDays14
    ) {
      staleNulls.push(id);
    }
  }

  const queue: string[] = [];
  for (const id of known) queue.push(id);
  for (const id of never) queue.push(id);
  for (const id of staleNulls) queue.push(id);

  return queue.slice(0, maxToProcess);
}

async function fetchForOrder(
  orderId: string,
  apiKey: string,
): Promise<
  | { order_id: string; subscriptions: MontoSubscription[]; error: null }
  | { order_id: string; subscriptions: []; error: string }
> {
  const url =
    `${MONTO_BASE}/orders/${encodeURIComponent(orderId)}/subscriptions?api_key=${encodeURIComponent(apiKey)}`;
  try {
    const resp = await fetch(url);
    if (resp.status === 404) {
      return { order_id: orderId, subscriptions: [], error: null };
    }
    if (!resp.ok) {
      const body = await resp.text();
      return {
        order_id: orderId,
        subscriptions: [],
        error: `monto ${resp.status}: ${body.slice(0, 120)}`,
      };
    }
    const body = await resp.json();
    const subs: MontoSubscription[] = Array.isArray(body)
      ? body
      : Array.isArray(body?.subscriptions)
      ? body.subscriptions
      : Array.isArray(body?.data)
      ? body.data
      : [];
    return { order_id: orderId, subscriptions: subs, error: null };
  } catch (e) {
    return {
      order_id: orderId,
      subscriptions: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

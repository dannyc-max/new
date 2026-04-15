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
    const data = await fetchAllPaged<{ order_id: string }>(
      supabase,
      "orders",
      "order_id",
      { order: { column: "accepted_on", ascending: false } },
    );
    return data.map((r) => r.order_id).slice(0, maxToProcess);
  }

  // NOTE: PostgREST caps `select()` at 1000 rows server-side regardless of
  // what a client .range() asks for. Our orders table has ~3500 rows, so we
  // must paginate manually to get the full set.

  // Priority 1: orders with a known subscription — refresh on each run so
  // status/cancellations stay current. During backfill (cron every few
  // minutes) this would monopolise the ~56-req budget and starve the
  // never-checked bucket, so we skip any known order that was already
  // refreshed within KNOWN_REFRESH_COOLDOWN_MS. The daily cron still
  // refreshes everything because 24h > the cooldown.
  const KNOWN_REFRESH_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h
  const knownSubRows = await fetchAllPaged<
    { order_id: string; last_checked_at: string }
  >(
    supabase,
    "monto_sync_log",
    "order_id, last_checked_at",
    { eq: { column: "has_subscription", value: true } },
  );

  const nowMs = Date.now();
  const known = new Set<string>(
    knownSubRows
      .filter((r) =>
        !r.last_checked_at ||
        nowMs - new Date(r.last_checked_at).getTime() >
          KNOWN_REFRESH_COOLDOWN_MS
      )
      .map((r) => r.order_id),
  );
  // Track every known order (even skipped) so the never bucket below
  // doesn't accidentally re-queue one as "never checked".
  const knownAll = new Set<string>(knownSubRows.map((r) => r.order_id));

  // Priority 2: orders we've never checked.
  const allOrders = await fetchAllPaged<
    { order_id: string; accepted_on: string | null }
  >(
    supabase,
    "orders",
    "order_id, accepted_on",
    { order: { column: "accepted_on", ascending: false } },
  );

  const checkedRows = await fetchAllPaged<
    { order_id: string; last_checked_at: string; has_subscription: boolean }
  >(
    supabase,
    "monto_sync_log",
    "order_id, last_checked_at, has_subscription",
    {},
  );

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
    if (knownAll.has(id)) continue;
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

// Paginate around PostgREST's server-enforced 1000-row cap. We walk the
// table in fixed chunks until a short page tells us we're done.
async function fetchAllPaged<T>(
  supabase: ReturnType<typeof createClient>,
  table: string,
  columns: string,
  opts: {
    eq?: { column: string; value: unknown };
    order?: { column: string; ascending: boolean };
  },
): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  for (let from = 0; from < 200_000; from += PAGE) {
    let q = supabase.from(table).select(columns);
    if (opts.eq) q = q.eq(opts.eq.column, opts.eq.value);
    if (opts.order) {
      q = q.order(opts.order.column, { ascending: opts.order.ascending });
    }
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as T[];
    out.push(...batch);
    if (batch.length < PAGE) break;
  }
  return out;
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

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
const CONCURRENCY = 20;
const DEFAULT_LIMIT = 2000;
const WALL_CLOCK_BUDGET_MS = 120_000;

type MontoSubscription = {
  id?: string;
  subscription_id?: string;
  status?: string;
  next_fulfillment_date?: string;
  nextFulfillmentDate?: string;
  frequency?: string;
  product_name?: string;
  productName?: string;
  customer_email?: string;
  customerEmail?: string;
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

  // Process in concurrent chunks.
  for (let i = 0; i < orderIds.length; i += CONCURRENCY) {
    if (Date.now() - started > WALL_CLOCK_BUDGET_MS) {
      timedOut = true;
      break;
    }

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
        continue;
      }
      logRows.push({
        order_id: r.order_id,
        last_checked_at: now,
        has_subscription: r.subscriptions.length > 0,
      });
      for (const s of r.subscriptions) {
        const subId = s.id ?? s.subscription_id;
        if (!subId) continue;
        subsRows.push({
          subscription_id: String(subId),
          order_id: r.order_id,
          status: s.status ?? null,
          next_fulfillment_date: s.next_fulfillment_date ??
            s.nextFulfillmentDate ?? null,
          frequency: s.frequency ?? null,
          product_name: s.product_name ?? s.productName ?? null,
          customer_email: s.customer_email ?? s.customerEmail ?? null,
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
      .limit(maxToProcess);
    if (error) throw new Error(error.message);
    return (data ?? []).map((r: { order_id: string }) => r.order_id);
  }

  // Priority 1: orders with a known subscription — recheck every run.
  const { data: knownSubOrders, error: e1 } = await supabase
    .from("monto_sync_log")
    .select("order_id")
    .eq("has_subscription", true);
  if (e1) throw new Error(e1.message);

  const known = new Set<string>(
    (knownSubOrders ?? []).map((r: { order_id: string }) => r.order_id),
  );

  // Priority 2: orders we've never checked.
  const { data: allOrders, error: e2 } = await supabase
    .from("orders")
    .select("order_id, accepted_on")
    .order("accepted_on", { ascending: false });
  if (e2) throw new Error(e2.message);

  const { data: checkedRows, error: e3 } = await supabase
    .from("monto_sync_log")
    .select("order_id, last_checked_at, has_subscription");
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
      // Order unknown to Monto — treat as no subscriptions.
      return { order_id: orderId, subscriptions: [], error: null };
    }
    if (!resp.ok) {
      return {
        order_id: orderId,
        subscriptions: [],
        error: `monto ${resp.status}`,
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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

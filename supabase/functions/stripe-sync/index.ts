// Stripe charge sync.
// Pulls all charges from Stripe (paginated, most-recent first) and upserts
// them into public.stripe_charges. We expand balance_transaction so we get
// the Stripe processing fee in a single API call.
//
// By default we pull charges created in the last 7 days (incremental mode).
// Pass ?mode=full to backfill every charge in the account.
//
// Env vars required:
//   STRIPE_SECRET_KEY    - sk_live_... or sk_test_...
//   DB_URL               - Supabase project URL
//   DB_SERVICE_ROLE_KEY  - Supabase service role key

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STRIPE_API = "https://api.stripe.com/v1";
const PAGE_SIZE = 100;

type StripeCharge = {
  id: string;
  amount: number;
  amount_captured: number;
  amount_refunded: number;
  currency: string;
  status: string;
  created: number;
  customer: string | null;
  payment_intent: string | null;
  refunded: boolean;
  receipt_url: string | null;
  balance_transaction:
    | string
    | { id: string; fee: number; net: number }
    | null;
};

Deno.serve(async (req: Request) => {
  const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY");
  const SUPABASE_URL = Deno.env.get("DB_URL");
  const SUPABASE_KEY = Deno.env.get("DB_SERVICE_ROLE_KEY");

  if (!STRIPE_KEY) {
    return json({ error: "STRIPE_SECRET_KEY not set" }, 500);
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return json({ error: "Supabase creds not set" }, 500);
  }

  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") ?? "incremental";
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // Incremental mode pulls the last 7 days of charges (enough buffer to catch
  // late-arriving refunds). Full mode pulls every charge.
  const createdGte = mode === "full"
    ? undefined
    : Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;

  let startingAfter: string | undefined;
  let totalFetched = 0;
  let totalUpserted = 0;
  const batchStart = Date.now();
  const WALL_CLOCK_BUDGET_MS = 120_000; // hard stop at 2 minutes

  while (true) {
    if (Date.now() - batchStart > WALL_CLOCK_BUDGET_MS) {
      return json({
        ok: false,
        reason: "wall_clock_budget_exceeded",
        totalFetched,
        totalUpserted,
        lastCursor: startingAfter,
      }, 200);
    }

    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    params.append("expand[]", "data.balance_transaction");
    if (startingAfter) params.set("starting_after", startingAfter);
    if (createdGte !== undefined) {
      params.set("created[gte]", String(createdGte));
    }

    const resp = await fetch(`${STRIPE_API}/charges?${params}`, {
      headers: { Authorization: `Bearer ${STRIPE_KEY}` },
    });

    if (!resp.ok) {
      const body = await resp.text();
      return json({ error: `Stripe ${resp.status}`, body }, 502);
    }

    const page = await resp.json() as {
      data: StripeCharge[];
      has_more: boolean;
    };

    if (page.data.length === 0) break;

    const rows = page.data.map(toRow);
    const { error } = await supabase
      .from("stripe_charges")
      .upsert(rows, { onConflict: "charge_id" });

    if (error) return json({ error: error.message, totalUpserted }, 500);

    totalFetched += page.data.length;
    totalUpserted += rows.length;
    startingAfter = page.data[page.data.length - 1].id;

    if (!page.has_more) break;
  }

  return json({
    ok: true,
    mode,
    totalFetched,
    totalUpserted,
    durationMs: Date.now() - batchStart,
  });
});

function toRow(c: StripeCharge) {
  const bt = typeof c.balance_transaction === "object" && c.balance_transaction
    ? c.balance_transaction
    : null;
  return {
    charge_id: c.id,
    amount: c.amount / 100,
    amount_captured: (c.amount_captured ?? 0) / 100,
    amount_refunded: (c.amount_refunded ?? 0) / 100,
    fee: bt ? bt.fee / 100 : null,
    net: bt ? bt.net / 100 : null,
    currency: (c.currency ?? "usd").toLowerCase(),
    status: c.status,
    created_at: new Date(c.created * 1000).toISOString(),
    customer_id: c.customer,
    payment_intent_id: c.payment_intent,
    refunded: c.refunded,
    receipt_url: c.receipt_url,
    balance_transaction_id: bt ? bt.id : null,
    raw: c as unknown as Record<string, unknown>,
    synced_at: new Date().toISOString(),
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

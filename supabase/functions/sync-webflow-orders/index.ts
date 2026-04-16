// Webflow order sync.
// Deployed under the (immutable) Supabase slug `hyper-processor`.
// Cron calls it at 0 6 * * * UTC — see supabase/migrations/.
//
// Why this function looks weird:
//   Supabase free-tier edge functions have a small memory ceiling. The
//   previous version accumulated every Webflow order (~3500) into one
//   in-memory array, mapped that array to a second one of equal size,
//   and then pushed everything as a single upsert. That tripped
//   WORKER_RESOURCE_LIMIT (status 546) and stopped syncing new orders.
//
// The streaming approach below holds at most one Webflow page (≤100
// orders) in memory at a time, upserts it, and moves on. Peak memory
// is bounded by one page's worth of JSON.
//
// Env vars required:
//   WEBFLOW_API_TOKEN
//   DB_URL
//   DB_SERVICE_ROLE_KEY
//
// Query params (all optional):
//   ?limit=N  - stop after N orders (useful for probes)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const WEBFLOW_SITE_ID = "64c2ba72d1b19e81e88ead0a";
const PAGE_SIZE = 100;
const WALL_CLOCK_BUDGET_MS = 140_000;

type WebflowOrder = {
  orderId: string;
  status?: string;
  acceptedOn?: string | null;
  fulfilledOn?: string | null;
  refundedOn?: string | null;
  disputedOn?: string | null;
  customerInfo?: { fullName?: string; email?: string };
  customerPaid?: { value?: number; unit?: string };
  netAmount?: { value?: number };
  applicationFee?: { value?: number };
  totals?: {
    subtotal?: { value?: number };
    extras?: Array<{ type?: string; price?: { value?: number } }>;
  };
  isShippingRequired?: boolean;
  shippingProvider?: string | null;
  shippingTracking?: string | null;
  shippingTrackingURL?: string | null;
  shippingAddress?: { city?: string; state?: string; postalCode?: string };
  stripeDetails?: {
    paymentIntentId?: string;
    customerId?: string;
    chargeId?: string;
  };
  purchasedItemsCount?: number;
  purchasedItems?: unknown;
};

Deno.serve(async (req: Request) => {
  const WEBFLOW_API_TOKEN = Deno.env.get("WEBFLOW_API_TOKEN");
  const SUPABASE_URL = Deno.env.get("DB_URL");
  const SUPABASE_KEY = Deno.env.get("DB_SERVICE_ROLE_KEY");

  if (!WEBFLOW_API_TOKEN) return json({ error: "WEBFLOW_API_TOKEN not set" }, 500);
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return json({ error: "Supabase creds not set" }, 500);
  }

  const url = new URL(req.url);
  const maxOrders = url.searchParams.has("limit")
    ? Number(url.searchParams.get("limit"))
    : Infinity;

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const started = Date.now();

  let offset = 0;
  let pagesFetched = 0;
  let ordersUpserted = 0;
  let timedOut = false;

  while (ordersUpserted < maxOrders) {
    if (Date.now() - started > WALL_CLOCK_BUDGET_MS) {
      timedOut = true;
      break;
    }

    const resp = await fetch(
      `https://api.webflow.com/v2/sites/${WEBFLOW_SITE_ID}/orders?limit=${PAGE_SIZE}&offset=${offset}`,
      {
        headers: {
          Authorization: `Bearer ${WEBFLOW_API_TOKEN}`,
          "accept-version": "1.0.0",
        },
      },
    );

    if (!resp.ok) {
      const body = await resp.text();
      return json({
        error: `webflow ${resp.status}: ${body.slice(0, 200)}`,
        offset,
        pagesFetched,
        ordersUpserted,
      }, 502);
    }

    const data = await resp.json();
    const page: WebflowOrder[] = data.orders ?? [];
    pagesFetched += 1;

    if (page.length === 0) break;

    const rows = page.map(mapOrder);
    const { error } = await supabase
      .from("orders")
      .upsert(rows, { onConflict: "order_id" });
    if (error) {
      return json({
        error: error.message,
        offset,
        pagesFetched,
        ordersUpserted,
      }, 500);
    }
    ordersUpserted += rows.length;

    // End of pagination: Webflow returned fewer than a full page.
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return json({
    ok: true,
    pagesFetched,
    ordersUpserted,
    timedOut,
    durationMs: Date.now() - started,
  });
});

function mapOrder(order: WebflowOrder): Record<string, unknown> {
  const cents = (v?: number) => (typeof v === "number" ? v / 100 : null);

  const extras = order.totals?.extras ?? [];
  const shippingExtra = extras.find((e) => e?.type === "shipping");
  const taxCents = extras
    .filter((e) => e?.type === "tax")
    .reduce((sum, e) => sum + (e?.price?.value ?? 0), 0);

  return {
    order_id: order.orderId,
    status: order.status ?? null,
    accepted_on: order.acceptedOn ?? null,
    fulfilled_on: order.fulfilledOn ?? null,
    refunded_on: order.refundedOn ?? null,
    disputed_on: order.disputedOn ?? null,
    customer_name: order.customerInfo?.fullName ?? null,
    customer_email: order.customerInfo?.email ?? null,
    customer_paid: cents(order.customerPaid?.value),
    net_amount: cents(order.netAmount?.value),
    application_fee: cents(order.applicationFee?.value),
    subtotal: cents(order.totals?.subtotal?.value),
    shipping_cost: cents(shippingExtra?.price?.value),
    tax_total: taxCents ? taxCents / 100 : null,
    currency: order.customerPaid?.unit ?? "USD",
    is_shipping_required: order.isShippingRequired ?? false,
    shipping_provider: order.shippingProvider ?? null,
    shipping_tracking: order.shippingTracking ?? null,
    shipping_tracking_url: order.shippingTrackingURL ?? null,
    shipping_city: order.shippingAddress?.city ?? null,
    shipping_state: order.shippingAddress?.state ?? null,
    shipping_zip: order.shippingAddress?.postalCode ?? null,
    stripe_payment_intent: order.stripeDetails?.paymentIntentId ?? null,
    stripe_customer_id: order.stripeDetails?.customerId ?? null,
    stripe_charge_id: order.stripeDetails?.chargeId ?? null,
    purchased_items_count: order.purchasedItemsCount ?? null,
    purchased_items: order.purchasedItems ?? null,
    synced_at: new Date().toISOString(),
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

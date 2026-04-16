import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async () => {
  const WEBFLOW_API_TOKEN = Deno.env.get("WEBFLOW_API_TOKEN");
  const SUPABASE_URL = Deno.env.get("DB_URL");
  const SUPABASE_KEY = Deno.env.get("DB_SERVICE_ROLE_KEY");
  const WEBFLOW_SITE_ID = "64c2ba72d1b19e81e88ead0a";

  const supabase = createClient(SUPABASE_URL!, SUPABASE_KEY!);

  let allOrders: any[] = [];
  let offset = 0;
  const limit = 100;

  // Keep fetching until we have all orders
  while (true) {
    const response = await fetch(
      `https://api.webflow.com/v2/sites/${WEBFLOW_SITE_ID}/orders?limit=${limit}&offset=${offset}`,
      {
        headers: {
          Authorization: `Bearer ${WEBFLOW_API_TOKEN}`,
          "accept-version": "1.0.0",
        },
      }
    );

    const data = await response.json();
    const orders = data.orders ?? [];
    allOrders = allOrders.concat(orders);

    // If we got fewer than the limit we've reached the end
    if (orders.length < limit) break;
    offset += limit;
  }

  if (allOrders.length === 0) {
    return new Response(JSON.stringify({ message: "No orders found" }), {
      status: 200,
    });
  }

  const rows = allOrders.map((order: any) => ({
    order_id: order.orderId,
    status: order.status,
    accepted_on: order.acceptedOn ?? null,
    fulfilled_on: order.fulfilledOn ?? null,
    refunded_on: order.refundedOn ?? null,
    disputed_on: order.disputedOn ?? null,
    customer_name: order.customerInfo?.fullName ?? null,
    customer_email: order.customerInfo?.email ?? null,
    customer_paid: order.customerPaid?.value ? order.customerPaid.value / 100 : null,
    net_amount: order.netAmount?.value ? order.netAmount.value / 100 : null,
    application_fee: order.applicationFee?.value ? order.applicationFee.value / 100 : null,
    subtotal: order.totals?.subtotal?.value ? order.totals.subtotal.value / 100 : null,
    shipping_cost: order.totals?.extras?.find((e: any) => e.type === "shipping")?.price?.value
      ? order.totals.extras.find((e: any) => e.type === "shipping").price.value / 100
      : null,
    tax_total: order.totals?.extras?.filter((e: any) => e.type === "tax")
      ?.reduce((sum: number, e: any) => sum + (e.price?.value ?? 0), 0) / 100 ?? null,
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
  }));

  const { error } = await supabase.from("orders").upsert(rows, {
    onConflict: "order_id",
  });

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
    });
  }

  return new Response(
    JSON.stringify({ success: true, synced: rows.length }),
    { status: 200 }
  );
});

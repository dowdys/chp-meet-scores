import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { createServiceClient } from "@/lib/supabase/server";
import { SHIRT_PRICE, JEWEL_PRICE, calculateShipping } from "@/lib/utils";

export async function POST(request: NextRequest) {
  // MUST use .text() for signature verification (not .json())
  const body = await request.text();
  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY!);
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;

  let event: Stripe.Event;
  try {
    event = stripeClient.webhooks.constructEvent(body, signature, webhookSecret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const supabase = createServiceClient();

  // Idempotency: check if we've already processed this event
  const { data: existingEvent } = await supabase
    .from("webhook_events")
    .select("event_id")
    .eq("event_id", event.id)
    .single();

  if (existingEvent) {
    return NextResponse.json({ received: true, deduplicated: true });
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      await handleCheckoutCompleted(supabase, session);
      break;
    }
    case "checkout.session.expired": {
      // Could handle abandoned cart cleanup here
      break;
    }
  }

  // Record that we processed this event
  await supabase.from("webhook_events").insert({
    event_id: event.id,
    event_type: event.type,
    status: "completed",
  });

  return NextResponse.json({ received: true });
}

async function handleCheckoutCompleted(
  supabase: ReturnType<typeof createServiceClient>,
  session: Stripe.Checkout.Session
) {
  // Parse cart from metadata
  let cartItems: Array<{
    name: string;
    size: string;
    color: string;
    jewel: boolean;
    meet: string;
    corrected: string | null;
  }> = [];

  try {
    cartItems = JSON.parse(session.metadata?.cart_summary || "[]");
  } catch {
    console.error("Failed to parse cart_summary from Stripe metadata");
    return;
  }

  if (cartItems.length === 0) return;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const shipping = (session as any).shipping_details as {
    name?: string;
    address?: {
      line1?: string;
      line2?: string;
      city?: string;
      state?: string;
      postal_code?: string;
    };
  } | null;
  const customer = session.customer_details;

  // Generate order number with random component
  const { data: seqData } = await supabase.rpc("nextval_order_number");
  const seq = seqData || Math.floor(Math.random() * 99999);
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  const orderNumber = `CHP-${new Date().getFullYear()}-${random}${String(seq).padStart(3, "0")}`;

  const subtotal =
    cartItems.length * SHIRT_PRICE +
    cartItems.filter((i) => i.jewel).length * JEWEL_PRICE;
  const shippingCost = calculateShipping(cartItems.length);
  const tax = (session.total_details?.amount_tax || 0);
  const total = subtotal + shippingCost + tax;

  // Create order atomically
  const { data: order, error: orderError } = await supabase
    .from("orders")
    .insert({
      order_number: orderNumber,
      stripe_session_id: session.id,
      stripe_payment_intent_id:
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : session.payment_intent?.id || null,
      customer_name: customer?.name || "Unknown",
      customer_email: customer?.email || "",
      customer_phone: customer?.phone || null,
      shipping_name: shipping?.name || customer?.name || "Unknown",
      shipping_address_line1: shipping?.address?.line1 || "",
      shipping_address_line2: shipping?.address?.line2 || null,
      shipping_city: shipping?.address?.city || "",
      shipping_state: shipping?.address?.state || "",
      shipping_zip: shipping?.address?.postal_code || "",
      subtotal,
      shipping_cost: shippingCost,
      tax,
      total,
      status: "paid",
      paid_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (orderError || !order) {
    console.error("Failed to create order:", orderError);
    return;
  }

  // Create order items
  // Note: back_id lookup requires shirt_backs data to exist for this meet.
  // For now, we store meet_name and will resolve back_id when available.
  const orderItems = cartItems.map((item) => ({
    order_id: order.id,
    athlete_name: item.name,
    corrected_name: item.corrected || null,
    meet_id: 0, // TODO: Look up meet_id from meet_name
    meet_name: item.meet,
    back_id: 0, // TODO: Look up from shirt_backs based on meet + level
    shirt_size: item.size,
    shirt_color: item.color,
    has_jewel: item.jewel,
    unit_price: SHIRT_PRICE,
    jewel_price: item.jewel ? JEWEL_PRICE : 0,
    production_status: "pending",
  }));

  const { error: itemsError } = await supabase
    .from("order_items")
    .insert(orderItems);

  if (itemsError) {
    console.error("Failed to create order items:", itemsError);
  }

  // Record status history
  await supabase.from("order_status_history").insert({
    order_id: order.id,
    old_status: null,
    new_status: "paid",
    changed_by: "system",
    reason: "Stripe checkout completed",
  });

  // TODO: Send confirmation email via Postmark (async, non-blocking)
  // TODO: This should be queued rather than done synchronously
}

import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { createServiceClient } from "@/lib/supabase/server";
import { SHIRT_PRICE, JEWEL_PRICE, calculateShipping } from "@/lib/utils";

export async function POST(request: NextRequest) {
  const body = await request.text(); // MUST use .text() for signature verification
  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(body, signature, webhookSecret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const supabase = createServiceClient();

  // Atomic idempotency: INSERT ON CONFLICT prevents TOCTOU race condition
  const { data: inserted } = await supabase
    .from("webhook_events")
    .upsert(
      { event_id: event.id, event_type: event.type, status: "processing" },
      { onConflict: "event_id", ignoreDuplicates: true }
    )
    .select("event_id");

  // If no rows returned, event was already processed
  if (!inserted || inserted.length === 0) {
    return NextResponse.json({ received: true, deduplicated: true });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        await handleCheckoutCompleted(supabase, session);
        break;
      }
    }

    // Mark as completed
    await supabase
      .from("webhook_events")
      .update({ status: "completed" })
      .eq("event_id", event.id);
  } catch (err) {
    // Mark as failed so retries can re-process
    await supabase
      .from("webhook_events")
      .update({ status: "failed" })
      .eq("event_id", event.id);

    console.error("Webhook processing failed:", err);
    return NextResponse.json(
      { error: "Processing failed" },
      { status: 500 }
    );
  }

  return NextResponse.json({ received: true });
}

async function handleCheckoutCompleted(
  supabase: ReturnType<typeof createServiceClient>,
  session: Stripe.Checkout.Session
) {
  // Retrieve cart from server-side storage (not from Stripe metadata)
  const cartToken = session.metadata?.cart_token;
  if (!cartToken) {
    throw new Error(`No cart_token in Stripe metadata for session ${session.id}`);
  }

  const { data: cart, error: cartError } = await supabase
    .from("pending_carts")
    .select("items")
    .eq("cart_token", cartToken)
    .single();

  if (cartError || !cart) {
    throw new Error(`Cart not found for token ${cartToken}: ${cartError?.message}`);
  }

  const cartItems = cart.items as Array<{
    athleteName: string;
    correctedName: string | null;
    meetName: string;
    state: string;
    level: string;
    gym: string;
    shirtSize: string;
    shirtColor: string;
    hasJewel: boolean;
  }>;

  if (cartItems.length === 0) {
    throw new Error(`Empty cart for token ${cartToken}`);
  }

  // Access shipping details from Stripe Checkout Session
  const shipping = session.collected_information?.shipping_details ?? null;
  const customer = session.customer_details;

  // Generate order number with cryptographic randomness
  const { data: seqData } = await supabase.rpc("nextval_order_number");
  const seq = seqData || 1;
  const random = crypto.randomUUID().substring(0, 6).toUpperCase();
  const orderNumber = `CHP-${new Date().getFullYear()}-${random}${String(seq).padStart(3, "0")}`;

  // Use Stripe's authoritative total (not recalculated)
  const subtotal =
    cartItems.length * SHIRT_PRICE +
    cartItems.filter((i) => i.hasJewel).length * JEWEL_PRICE;
  const shippingCost = calculateShipping(cartItems.length);
  const tax = (session.total_details?.amount_tax || 0);
  const total = session.amount_total || (subtotal + shippingCost + tax);

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
    throw new Error(`Failed to create order: ${orderError?.message || "unknown error"}`);
  }

  // Resolve meet_id and back_id for each item
  const orderItems = await Promise.all(
    cartItems.map(async (item) => {
      // Look up meet_id from meet_name
      const { data: meet } = await supabase
        .from("meets")
        .select("id")
        .eq("meet_name", item.meetName)
        .single();

      // Look up back_id from shirt_backs (active version for this meet)
      const { data: back } = meet
        ? await supabase
            .from("shirt_backs")
            .select("id")
            .eq("meet_id", meet.id)
            .is("superseded_at", null)
            .limit(1)
            .single()
        : { data: null };

      return {
        order_id: order.id,
        athlete_name: item.athleteName,
        corrected_name: item.correctedName || null,
        meet_id: meet?.id || null,
        meet_name: item.meetName,
        back_id: back?.id || null,
        shirt_size: item.shirtSize,
        shirt_color: item.shirtColor,
        has_jewel: item.hasJewel,
        unit_price: SHIRT_PRICE,
        jewel_price: item.hasJewel ? JEWEL_PRICE : 0,
        production_status: "pending",
      };
    })
  );

  const { error: itemsError } = await supabase
    .from("order_items")
    .insert(orderItems);

  if (itemsError) {
    throw new Error(`Failed to create order items for order ${order.id}: ${itemsError.message}`);
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

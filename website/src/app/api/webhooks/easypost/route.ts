import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getEasyPost } from "@/lib/easypost";

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const webhookSecret = process.env.EASYPOST_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error("EASYPOST_WEBHOOK_SECRET not configured");
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
  }

  // Verify HMAC signature using the SDK's built-in method
  // (handles NFKD normalization, weight float correction, and hmac-sha256-hex prefix)
  let event;
  try {
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });

    const client = getEasyPost();
    event = client.Utils.validateWebhook(Buffer.from(rawBody), headers, webhookSecret);
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  try {
    const supabase = createServiceClient();

    if (event.description === "tracker.updated") {
      const tracker = event.result;
      const trackingCode = tracker?.tracking_code;
      const status = tracker?.status;

      let orderStatus: string | null = null;
      if (status === "delivered") {
        orderStatus = "delivered";
      } else if (status === "in_transit" || status === "out_for_delivery") {
        orderStatus = "shipped";
      }

      if (orderStatus && trackingCode) {
        const { data: order } = await supabase
          .from("orders")
          .select("id, status")
          .eq("tracking_number", trackingCode)
          .single();

        if (order && order.status !== orderStatus) {
          await supabase
            .from("orders")
            .update({ status: orderStatus })
            .eq("id", order.id);

          await supabase.from("order_status_history").insert({
            order_id: order.id,
            old_status: order.status,
            new_status: orderStatus,
            changed_by: "easypost_webhook",
            reason: `Tracking status: ${status}`,
          });

          // Send delivery confirmation email
          if (orderStatus === "delivered") {
            try {
              const { sendShippingConfirmationEmail } = await import("@/lib/admin-actions");
              await sendShippingConfirmationEmail(order.id);
            } catch {
              console.error("Failed to send delivery email for order:", order.id);
            }
          }
        }
      }
    }

    return NextResponse.json({ received: true });
  } catch (err) {
    console.error("EasyPost webhook processing failed:", err);
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}

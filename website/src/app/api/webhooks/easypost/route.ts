import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // TODO: Verify HMAC signature using EasyPost webhook secret
    // const hmacHeader = request.headers.get("X-Hmac-Signature");
    // const isValid = easypost.Webhook.validateWebhook(body, hmacHeader, secret);

    const supabase = createServiceClient();
    const event = body;

    if (event.description === "tracker.updated") {
      const tracker = event.result;
      const trackingCode = tracker.tracking_code;
      const status = tracker.status;

      // Map EasyPost status to our order status
      let orderStatus: string | null = null;
      if (status === "delivered") {
        orderStatus = "delivered";
      } else if (status === "in_transit" || status === "out_for_delivery") {
        orderStatus = "shipped"; // Already shipped
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
        }
      }
    }

    return NextResponse.json({ received: true });
  } catch {
    return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 });
  }
}

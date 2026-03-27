import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getEasyPost } from "@/lib/easypost";
import crypto from "crypto";

function verifyWebhookSignature(
  body: string,
  signature: string | null,
  secret: string
): boolean {
  if (!signature) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const hmacSignature = request.headers.get("X-Hmac-Signature");
  const webhookSecret = process.env.EASYPOST_WEBHOOK_SECRET;

  // Verify HMAC signature
  if (!webhookSecret) {
    console.error("EASYPOST_WEBHOOK_SECRET not configured");
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
  }

  if (!verifyWebhookSignature(rawBody, hmacSignature, webhookSecret)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  try {
    const body = JSON.parse(rawBody);
    const supabase = createServiceClient();

    if (body.description === "tracker.updated") {
      const tracker = body.result;
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
        }
      }
    }

    return NextResponse.json({ received: true });
  } catch (err) {
    console.error("EasyPost webhook processing failed:", err);
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}

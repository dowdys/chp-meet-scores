"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { render } from "@react-email/render";
import { OrderConfirmationEmail } from "@/emails/order-confirmation";
import { ShippingConfirmationEmail } from "@/emails/shipping-confirmation";
import { sendBatchEmails } from "@/lib/postmark";
import { formatPrice } from "@/lib/utils";

function getDb() {
  return createServiceClient();
}

// ============================================================
// NAME CORRECTIONS
// ============================================================

export async function applyNameCorrection(itemId: number) {
  const db = getDb();
  await db
    .from("order_items")
    .update({ name_correction_reviewed: true })
    .eq("id", itemId);

  return { success: true };
}

export async function dismissNameCorrection(itemId: number) {
  const db = getDb();
  await db
    .from("order_items")
    .update({
      name_correction_reviewed: true,
      corrected_name: null, // Clear the correction
    })
    .eq("id", itemId);

  return { success: true };
}

// ============================================================
// PRINTER BATCHES
// ============================================================

export async function createPrinterBatch(
  backIds: number[],
  printer: "printer_1" | "printer_2" = "printer_2"
) {
  const db = getDb();

  const weekStr = new Date().toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  const batchName = `Week of ${weekStr} - ${printer === "printer_1" ? "Printer 1" : "Printer 2"}`;

  // Create batch
  const { data: batch, error } = await db
    .from("printer_batches")
    .insert({ batch_name: batchName, screen_printer: printer })
    .select("id")
    .single();

  if (error || !batch) return { success: false, error: error?.message };

  // Add backs to batch with shirt counts
  for (const backId of backIds) {
    const { count } = await db
      .from("order_items")
      .select("*", { count: "exact", head: true })
      .eq("back_id", backId)
      .in("production_status", ["pending"]);

    await db.from("printer_batch_backs").insert({
      batch_id: batch.id,
      back_id: backId,
      shirt_count: count || 0,
    });

    // Update order items to queued
    await db
      .from("order_items")
      .update({
        production_status: "queued",
        printer_batch_id: batch.id,
      })
      .eq("back_id", backId)
      .eq("production_status", "pending");
  }

  return { success: true, batchId: batch.id };
}

export async function updateBatchStatus(
  batchId: number,
  newStatus: "at_printer" | "returned"
) {
  const db = getDb();

  const updates: Record<string, string | null> = { status: newStatus };
  if (newStatus === "at_printer") {
    updates.sent_at = new Date().toISOString();
  }
  if (newStatus === "returned") {
    updates.returned_at = new Date().toISOString();
  }

  await db.from("printer_batches").update(updates).eq("id", batchId);

  // Update order items status based on batch status
  if (newStatus === "at_printer") {
    // Get all backs in this batch
    const { data: batchBacks } = await db
      .from("printer_batch_backs")
      .select("back_id")
      .eq("batch_id", batchId);

    if (batchBacks) {
      for (const bb of batchBacks) {
        await db
          .from("order_items")
          .update({ production_status: "at_printer" })
          .eq("printer_batch_id", batchId)
          .eq("back_id", bb.back_id);
      }
    }
  }

  if (newStatus === "returned") {
    await db
      .from("order_items")
      .update({ production_status: "printed" })
      .eq("printer_batch_id", batchId);
  }

  return { success: true };
}

// ============================================================
// SHIPPING
// ============================================================

export async function createShippingLabels(orderIds: number[]) {
  const res = await fetch(
    `${process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000"}/api/shipping`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderIds }),
    }
  );
  return res.json();
}

// ============================================================
// EMAIL SENDING
// ============================================================

export async function sendOrderConfirmationEmail(orderId: number) {
  const db = getDb();

  const { data: order } = await db
    .from("orders")
    .select("*, order_items(*)")
    .eq("id", orderId)
    .single();

  if (!order) return { success: false };

  const htmlBody = await render(
    OrderConfirmationEmail({
      orderNumber: order.order_number,
      customerName: order.customer_name,
      items: (order.order_items || []).map((i: { athlete_name: string; shirt_size: string; shirt_color: string; has_jewel: boolean }) => ({
        athleteName: i.athlete_name,
        shirtSize: i.shirt_size,
        shirtColor: i.shirt_color,
        hasJewel: i.has_jewel,
      })),
      total: formatPrice(order.total),
      shippingAddress: `${order.shipping_address_line1}, ${order.shipping_city}, ${order.shipping_state} ${order.shipping_zip}`,
    })
  );

  await sendBatchEmails([
    {
      to: order.customer_email,
      subject: `Order Confirmed - ${order.order_number}`,
      htmlBody,
      stream: "outbound",
    },
  ]);

  return { success: true };
}

export async function sendShippingConfirmationEmail(orderId: number) {
  const db = getDb();

  const { data: order } = await db
    .from("orders")
    .select("order_number, customer_name, customer_email, tracking_number, carrier")
    .eq("id", orderId)
    .single();

  if (!order || !order.tracking_number) return { success: false };

  const htmlBody = await render(
    ShippingConfirmationEmail({
      orderNumber: order.order_number,
      customerName: order.customer_name,
      trackingNumber: order.tracking_number,
      carrier: order.carrier || "USPS",
    })
  );

  await sendBatchEmails([
    {
      to: order.customer_email,
      subject: `Your Order Has Shipped - ${order.order_number}`,
      htmlBody,
      stream: "outbound",
    },
  ]);

  return { success: true };
}

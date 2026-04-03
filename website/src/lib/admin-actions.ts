"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/auth";
import { render } from "@react-email/render";
import { OrderConfirmationEmail } from "@/emails/order-confirmation";
import { ShippingConfirmationEmail } from "@/emails/shipping-confirmation";
import { sendBatchEmails } from "@/lib/postmark";
import { formatPrice, calculateShipping } from "@/lib/utils";
import { getStripe } from "@/lib/stripe";

/** Verify caller is admin before any mutating action */
async function ensureAdmin() {
  const auth = await requireAdmin();
  if (auth.error) throw new Error("Unauthorized");
}

function getDb() {
  return createServiceClient();
}

// ============================================================
// NAME CORRECTIONS
// ============================================================

export async function applyNameCorrection(itemId: number) {
  await ensureAdmin();
  const db = getDb();
  await db
    .from("order_items")
    .update({ name_correction_reviewed: true })
    .eq("id", itemId);

  return { success: true };
}

export async function dismissNameCorrection(itemId: number) {
  await ensureAdmin();
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
  await ensureAdmin();
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
  await ensureAdmin();
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

// ============================================================
// CANCEL & REFUND
// ============================================================

export async function cancelOrder(
  orderId: number,
  itemIds?: number[]
): Promise<{ success: boolean; error?: string }> {
  await ensureAdmin();
  const db = getDb();

  // Fetch order with items
  const { data: order, error: fetchErr } = await db
    .from("orders")
    .select("*, order_items(*)")
    .eq("id", orderId)
    .single();

  if (fetchErr || !order) {
    return { success: false, error: "Order not found" };
  }

  if (!["paid", "processing"].includes(order.status)) {
    return {
      success: false,
      error: `Cannot cancel a ${order.status} order. Only paid or processing orders can be cancelled.`,
    };
  }

  if (!order.stripe_payment_intent_id) {
    return { success: false, error: "No payment intent found for this order" };
  }

  const stripe = getStripe();
  const activeItems = (order.order_items || []).filter(
    (i: { production_status: string }) => i.production_status !== "cancelled"
  );

  try {
    if (!itemIds || itemIds.length === 0) {
      // FULL CANCEL
      await stripe.refunds.create({
        payment_intent: order.stripe_payment_intent_id,
      });

      await db
        .from("order_items")
        .update({ production_status: "cancelled" })
        .eq("order_id", orderId);

      await db
        .from("orders")
        .update({ status: "refunded" })
        .eq("id", orderId);

      await db.from("order_status_history").insert({
        order_id: orderId,
        old_status: order.status,
        new_status: "refunded",
        changed_by: "admin",
        reason: "Full cancellation and refund",
      });
    } else {
      // PARTIAL CANCEL
      const selectedItems = activeItems.filter((i: { id: number }) =>
        itemIds.includes(i.id)
      );
      if (selectedItems.length === 0) {
        return { success: false, error: "No valid items selected" };
      }

      const itemRefund = selectedItems.reduce(
        (sum: number, i: { unit_price: number; jewel_price: number }) =>
          sum + i.unit_price + i.jewel_price,
        0
      );
      const remainingCount = activeItems.length - selectedItems.length;
      const newShipping =
        remainingCount > 0 ? calculateShipping(remainingCount) : 0;
      const shippingRefund = Math.max(0, order.shipping_cost - newShipping);
      const refundAmount = itemRefund + shippingRefund;

      await stripe.refunds.create({
        payment_intent: order.stripe_payment_intent_id,
        amount: refundAmount,
      });

      for (const item of selectedItems) {
        await db
          .from("order_items")
          .update({ production_status: "cancelled" })
          .eq("id", item.id);
      }

      if (remainingCount === 0) {
        await db
          .from("orders")
          .update({ status: "refunded" })
          .eq("id", orderId);

        await db.from("order_status_history").insert({
          order_id: orderId,
          old_status: order.status,
          new_status: "refunded",
          changed_by: "admin",
          reason: `All items cancelled (partial cancellation of ${selectedItems.length} items)`,
        });
      } else {
        await db
          .from("orders")
          .update({ shipping_cost: newShipping, total: order.total - refundAmount })
          .eq("id", orderId);

        await db.from("order_status_history").insert({
          order_id: orderId,
          old_status: order.status,
          new_status: order.status,
          changed_by: "admin",
          reason: `Partial cancellation: ${selectedItems.length} item(s) refunded (${formatPrice(refundAmount)})`,
        });
      }
    }

    return { success: true };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Stripe refund failed";
    return { success: false, error: message };
  }
}

// ============================================================
// STATUS OVERRIDE
// ============================================================

export async function overrideOrderStatus(
  orderId: number,
  newStatus: string,
  reason: string
): Promise<{ success: boolean; error?: string }> {
  await ensureAdmin();
  const db = getDb();

  if (!reason.trim()) {
    return { success: false, error: "A reason is required" };
  }

  const validStatuses = [
    "pending", "paid", "processing", "shipped",
    "delivered", "refunded", "cancelled",
  ];
  if (!validStatuses.includes(newStatus)) {
    return { success: false, error: `Invalid status: ${newStatus}` };
  }

  const { data: order } = await db
    .from("orders")
    .select("status")
    .eq("id", orderId)
    .single();

  if (!order) {
    return { success: false, error: "Order not found" };
  }

  if (order.status === newStatus) {
    return { success: true };
  }

  await db.from("orders").update({ status: newStatus }).eq("id", orderId);

  await db.from("order_status_history").insert({
    order_id: orderId,
    old_status: order.status,
    new_status: newStatus,
    changed_by: "admin-override",
    reason: reason.trim(),
  });

  return { success: true };
}

export async function overrideItemStatus(
  itemId: number,
  newStatus: string,
  reason: string
): Promise<{ success: boolean; error?: string }> {
  await ensureAdmin();
  const db = getDb();

  if (!reason.trim()) {
    return { success: false, error: "A reason is required" };
  }

  const validStatuses = [
    "pending", "queued", "at_printer", "printed", "packed", "cancelled",
  ];
  if (!validStatuses.includes(newStatus)) {
    return { success: false, error: `Invalid status: ${newStatus}` };
  }

  const { data: item } = await db
    .from("order_items")
    .select("production_status, order_id")
    .eq("id", itemId)
    .single();

  if (!item) {
    return { success: false, error: "Item not found" };
  }

  if (item.production_status === newStatus) {
    return { success: true };
  }

  await db
    .from("order_items")
    .update({ production_status: newStatus })
    .eq("id", itemId);

  await db.from("order_status_history").insert({
    order_id: item.order_id,
    old_status: item.production_status,
    new_status: newStatus,
    changed_by: "admin-override",
    reason: `Item status override: ${reason.trim()}`,
  });

  return { success: true };
}

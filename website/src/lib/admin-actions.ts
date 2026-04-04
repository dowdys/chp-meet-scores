"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin, requireRole } from "@/lib/auth";
import type { AdminRole } from "@/lib/auth";
import { render } from "@react-email/render";
import { OrderConfirmationEmail } from "@/emails/order-confirmation";
import { ShippingConfirmationEmail } from "@/emails/shipping-confirmation";
import { sendBatchEmails } from "@/lib/postmark";
import { formatPrice, calculateShipping } from "@/lib/utils";
import { getStripe } from "@/lib/stripe";

/** Verify caller is admin before any mutating action (legacy, equivalent to requireRole('viewer')) */
async function ensureAdmin() {
  const auth = await requireAdmin();
  if (auth.error) throw new Error("Unauthorized");
}

/** Require a minimum role for a mutating action */
async function ensureRole(minRole: AdminRole) {
  await requireRole(minRole);
}

function getDb() {
  return createServiceClient();
}

// ============================================================
// NAME CORRECTIONS
// ============================================================

export async function applyNameCorrection(itemId: number) {
  await ensureRole("admin");
  const db = getDb();
  await db
    .from("order_items")
    .update({ name_correction_reviewed: true })
    .eq("id", itemId);

  return { success: true };
}

export async function dismissNameCorrection(itemId: number) {
  await ensureRole("admin");
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
  await ensureRole("shipping");
  const db = getDb();

  const weekStr = new Date().toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  const printerLabel = printer === "printer_1" ? "Printer 1" : "Printer 2";
  const baseName = `Week of ${weekStr} - ${printerLabel}`;

  // Append sequence number to prevent batch name collisions
  const { count: existingCount } = await db
    .from("printer_batches")
    .select("*", { count: "exact", head: true })
    .like("batch_name", `${baseName}%`);
  const seq = (existingCount || 0) + 1;
  const batchName = seq === 1 ? baseName : `${baseName} (#${seq})`;

  // Use atomic RPC to create batch + backs + items in one transaction.
  // This prevents partial state (batch created but items not updated).
  const { data: rpcResult, error } = await db.rpc("create_printer_batch_atomic", {
    p_batch_name: batchName,
    p_screen_printer: printer,
    p_back_ids: backIds,
  });

  if (error) return { success: false, error: error.message };

  const result = rpcResult as { success: boolean; batch_id?: number };
  if (!result.success) return { success: false, error: "Batch creation failed" };

  // The RPC handles: create batch, insert backs with counts, update items
  // to queued, transition orders from paid→processing, and record history.
  // Everything in one transaction.

  return { success: true, batchId: result.batch_id };
}

export async function updateBatchStatus(
  batchId: number,
  newStatus: "at_printer" | "returned"
) {
  await ensureRole("shipping");
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

export async function updateBatchReturnedCounts(
  counts: Array<{ batchBackId: number; returnedCount: number }>
): Promise<{ success: boolean; error?: string }> {
  await ensureRole("shipping");
  const db = getDb();

  for (const { batchBackId, returnedCount } of counts) {
    await db
      .from("printer_batch_backs")
      .update({ returned_count: returnedCount })
      .eq("id", batchBackId);
  }

  return { success: true };
}

// ============================================================
// SHIPPING
// ============================================================

export async function createShippingLabels(orderIds: number[]) {
  await ensureRole("shipping");
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
  await ensureRole("admin");
  const db = getDb();

  // Fetch order for refund amount calculation
  const { data: order, error: fetchErr } = await db
    .from("orders")
    .select("*, order_items(*)")
    .eq("id", orderId)
    .single();

  if (fetchErr || !order) {
    return { success: false, error: "Order not found" };
  }

  if (!order.stripe_payment_intent_id) {
    return { success: false, error: "No payment intent found for this order" };
  }

  const activeItems = (order.order_items || []).filter(
    (i: { production_status: string }) => i.production_status !== "cancelled"
  );

  // Calculate refund details for partial cancel
  let refundAmount: number | undefined;
  let newSubtotal: number | undefined;
  let newShipping: number | undefined;
  let newTotal: number | undefined;
  let reason = "Full cancellation and refund";

  if (itemIds && itemIds.length > 0) {
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
    newShipping = remainingCount > 0 ? calculateShipping(remainingCount) : 0;
    const shippingRefund = Math.max(0, order.shipping_cost - newShipping);
    refundAmount = itemRefund + shippingRefund;
    newSubtotal = order.subtotal - itemRefund;
    newTotal = newSubtotal + newShipping + order.tax;
    reason = `Partial cancellation: ${selectedItems.length} item(s) refunded (${formatPrice(refundAmount!)})`;
  }

  try {
    // Step 1: Atomically lock the order row and update DB state in a transaction.
    // This uses SELECT FOR UPDATE inside the RPC to prevent double-cancel races.
    const { data: rpcResult, error: rpcError } = await db.rpc("begin_cancel_order", {
      p_order_id: orderId,
      p_item_ids: itemIds && itemIds.length > 0 ? itemIds : null,
      p_new_subtotal: newSubtotal ?? null,
      p_new_shipping: newShipping ?? null,
      p_new_total: newTotal ?? null,
      p_reason: reason,
    });

    if (rpcError) {
      return { success: false, error: rpcError.message };
    }

    const result = rpcResult as { success: boolean; error?: string; payment_intent_id?: string };
    if (!result.success) {
      return { success: false, error: result.error || "Cancel failed" };
    }

    // Step 2: DB is updated. Now issue the Stripe refund.
    // If Stripe fails, the DB state is already 'refunded' — we log the Stripe
    // failure but don't rollback DB (the refund can be retried or reconciled).
    const stripe = getStripe();
    await stripe.refunds.create({
      payment_intent: order.stripe_payment_intent_id,
      ...(refundAmount ? { amount: refundAmount } : {}),
    });

    return { success: true };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Stripe refund failed";
    // DB already shows refunded — log the Stripe failure for manual reconciliation
    console.error(`Stripe refund failed for order ${orderId} after DB update:`, message);
    return { success: false, error: `Order cancelled in DB but Stripe refund failed: ${message}. Manual reconciliation needed.` };
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
  await ensureRole("admin");
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

  // Warn about Stripe-inconsistent transitions (but still allow — that's the point of override)
  const stripeInconsistent =
    (order.status === "refunded" && ["paid", "processing"].includes(newStatus)) ||
    (order.status === "cancelled" && ["paid", "processing"].includes(newStatus));

  const warningPrefix = stripeInconsistent
    ? "WARNING: This creates a Stripe-inconsistent state (order was refunded/cancelled in Stripe). "
    : "";

  await db.from("orders").update({ status: newStatus }).eq("id", orderId);

  await db.from("order_status_history").insert({
    order_id: orderId,
    old_status: order.status,
    new_status: newStatus,
    changed_by: "admin-override",
    reason: `${warningPrefix}${reason.trim()}`,
  });

  return {
    success: true,
    ...(stripeInconsistent
      ? { error: "Status overridden, but this order was already refunded/cancelled in Stripe. Manual Stripe reconciliation may be needed." }
      : {}),
  };
}

export async function overrideItemStatus(
  itemId: number,
  newStatus: string,
  reason: string
): Promise<{ success: boolean; error?: string }> {
  await ensureRole("admin");
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

// ============================================================
// REPRINT / RE-BATCH
// ============================================================

export async function rebatchItem(
  itemId: number,
  reason: string
): Promise<{ success: boolean; error?: string }> {
  await ensureRole("admin");
  const db = getDb();

  if (!reason.trim()) {
    return { success: false, error: "A reason is required" };
  }

  const { data: item } = await db
    .from("order_items")
    .select("production_status, order_id, printer_batch_id")
    .eq("id", itemId)
    .single();

  if (!item) {
    return { success: false, error: "Item not found" };
  }

  // Already pending — no-op
  if (item.production_status === "pending") {
    return { success: true };
  }

  // Cannot re-batch a cancelled item
  if (item.production_status === "cancelled") {
    return { success: false, error: "Cannot re-batch a cancelled item" };
  }

  const oldStatus = item.production_status;

  // Reset item to pending and clear batch association
  await db
    .from("order_items")
    .update({
      production_status: "pending",
      printer_batch_id: null,
    })
    .eq("id", itemId);

  // Record in status history
  await db.from("order_status_history").insert({
    order_id: item.order_id,
    old_status: oldStatus,
    new_status: "pending",
    changed_by: "admin-rebatch",
    reason: `Re-batch: ${reason.trim()}`,
  });

  // Check if the order status should revert. If the order was processing
  // but now all non-cancelled items are back to pending, revert to paid.
  const { data: siblingItems } = await db
    .from("order_items")
    .select("production_status")
    .eq("order_id", item.order_id)
    .neq("production_status", "cancelled");

  if (siblingItems) {
    const allPending = siblingItems.every(
      (i) => i.production_status === "pending"
    );

    if (allPending) {
      const { data: order } = await db
        .from("orders")
        .select("status")
        .eq("id", item.order_id)
        .single();

      if (order && order.status === "processing") {
        await db
          .from("orders")
          .update({ status: "paid" })
          .eq("id", item.order_id);

        await db.from("order_status_history").insert({
          order_id: item.order_id,
          old_status: "processing",
          new_status: "paid",
          changed_by: "admin-rebatch",
          reason: "All items returned to pending via re-batch",
        });
      }
    }
  }

  return { success: true };
}

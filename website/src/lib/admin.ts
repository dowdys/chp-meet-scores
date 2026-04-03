import "server-only";

import { createServiceClient } from "@/lib/supabase/server";

const supabase = () => createServiceClient();

export async function getDashboardStats() {
  const db = supabase();

  const [orders, pendingBacks, batches, readyToShip, corrections, captures] =
    await Promise.all([
      db.from("orders").select("id, total, status, created_at").gte("created_at", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()).limit(5000),
      db
        .from("order_items")
        .select("back_id")
        .eq("production_status", "pending"),
      db.from("printer_batches").select("id, status"),
      db
        .from("orders")
        .select("id")
        .eq("status", "processing"),
      db
        .from("order_items")
        .select("id")
        .not("corrected_name", "is", null)
        .eq("name_correction_reviewed", false),
      db.from("email_captures").select("id").eq("notified", false),
    ]);

  const orderData = (orders.data || []) as Array<{ id: number; total: number; status: string; created_at: string }>;
  const thisWeek = orderData.filter(
    (o) =>
      new Date(o.created_at) >
      new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  );

  return {
    totalOrders: orderData.length,
    ordersThisWeek: thisWeek.length,
    revenueThisWeek: thisWeek.reduce((sum: number, o) => sum + (o.total || 0), 0),
    pendingBacks: new Set((pendingBacks.data || []).map((i) => i.back_id)).size,
    activeBatches: (batches.data || []).filter(
      (b) => b.status === "at_printer"
    ).length,
    readyToShip: (readyToShip.data || []).length,
    pendingCorrections: (corrections.data || []).length,
    pendingCaptures: (captures.data || []).length,
  };
}

export async function getOrders(filters?: {
  status?: string;
  search?: string;
  limit?: number;
  offset?: number;
}) {
  const db = supabase();
  let query = db
    .from("orders")
    .select("*, order_items(*)")
    .order("created_at", { ascending: false });

  if (filters?.status) {
    query = query.eq("status", filters.status);
  }
  if (filters?.search) {
    // Sanitize: escape PostgREST filter special characters
    const s = filters.search.replace(/[%_.,()]/g, "");
    if (s.length > 0) {
      query = query.or(
        `customer_name.ilike.%${s}%,customer_email.ilike.%${s}%,order_number.ilike.%${s}%`
      );
    }
  }
  if (filters?.limit) {
    query = query.limit(filters.limit);
  }

  const { data, error } = await query;
  return { data: data || [], error };
}

export async function getOrdersByBack() {
  const db = supabase();
  const { data, error } = await db
    .from("order_items")
    .select(
      "*, shirt_backs(id, meet_name, level_group_label), orders(status, order_number)"
    )
    .in("production_status", ["pending", "queued"])
    .order("back_id");

  return { data: data || [], error };
}

export async function getPrinterBatches() {
  const db = supabase();
  const { data, error } = await db
    .from("printer_batches")
    .select("*, printer_batch_backs(*, shirt_backs(meet_name, level_group_label))")
    .order("created_at", { ascending: false });

  if (!data) return { data: [], error };

  // Enrich batches with item status breakdown and jewel counts
  const enriched = await Promise.all(
    data.map(async (batch) => {
      const { data: items } = await db
        .from("order_items")
        .select("production_status, has_jewel")
        .eq("printer_batch_id", batch.id);

      const statusBreakdown: Record<string, number> = {};
      let jewelCount = 0;
      for (const item of items || []) {
        statusBreakdown[item.production_status] =
          (statusBreakdown[item.production_status] || 0) + 1;
        if (item.has_jewel) jewelCount++;
      }

      return {
        ...batch,
        item_count: (items || []).length,
        status_breakdown: statusBreakdown,
        jewel_count: jewelCount,
      };
    })
  );

  return { data: enriched, error };
}

export async function getShippingQueue() {
  const db = supabase();
  // Orders where all items are printed and order not yet shipped
  const { data, error } = await db
    .from("orders")
    .select("*, order_items(*)")
    .in("status", ["paid", "processing"])
    .order("created_at", { ascending: true });

  // Filter to orders where ALL items are printed or packed
  const ready =
    data?.filter((order) => {
      const items = order.order_items || [];
      return (
        items.length > 0 &&
        items.every(
          (item: { production_status: string }) =>
            item.production_status === "printed" ||
            item.production_status === "packed"
        )
      );
    }) || [];

  return { data: ready, error };
}

/**
 * Get orders where SOME items are printed but not ALL.
 * These are "waiting on production" — multi-back orders where some backs
 * have returned from the printer but others haven't.
 */
export async function getPartiallyPrintedOrders() {
  const db = supabase();
  const { data: orders } = await db
    .from("orders")
    .select("*, order_items(*, printer_batches:printer_batch_id(id, batch_name, status))")
    .in("status", ["paid", "processing"])
    .order("created_at", { ascending: true });

  if (!orders) return { data: [] };

  const partial = orders.filter((order) => {
    const items = (order.order_items || []).filter(
      (i: { production_status: string }) => i.production_status !== "cancelled"
    );
    if (items.length === 0) return false;

    const hasPrinted = items.some(
      (i: { production_status: string }) =>
        i.production_status === "printed" || i.production_status === "packed"
    );
    const allPrinted = items.every(
      (i: { production_status: string }) =>
        i.production_status === "printed" || i.production_status === "packed"
    );

    // Has some printed items but not all
    return hasPrinted && !allPrinted;
  });

  return { data: partial };
}

export async function getNameCorrections() {
  const db = supabase();
  const { data, error } = await db
    .from("order_items")
    .select("*, orders(order_number, customer_email), shirt_backs(meet_name, level_group_label)")
    .not("corrected_name", "is", null)
    .eq("name_correction_reviewed", false)
    .order("created_at", { ascending: true });

  return { data: data || [], error };
}

export async function getOrderDetail(orderId: string) {
  const db = supabase();

  // Fetch the order by order_number (e.g. CHP-2026-001)
  const { data: order, error: orderError } = await db
    .from("orders")
    .select("*")
    .eq("order_number", orderId)
    .single();

  if (orderError || !order) {
    return { data: null, error: orderError };
  }

  // Fetch order items with shirt_backs join for back design info
  const { data: items, error: itemsError } = await db
    .from("order_items")
    .select("*, shirt_backs(id, meet_name, level_group_label)")
    .eq("order_id", order.id)
    .order("created_at", { ascending: true });

  if (itemsError) {
    return { data: null, error: itemsError };
  }

  // Fetch status history ordered by most recent first
  const { data: history, error: historyError } = await db
    .from("order_status_history")
    .select("*")
    .eq("order_id", order.id)
    .order("created_at", { ascending: false });

  if (historyError) {
    return { data: null, error: historyError };
  }

  return {
    data: {
      ...order,
      order_items: items || [],
      status_history: history || [],
    },
    error: null,
  };
}

export async function getEmailCaptures(filters?: { state?: string; notified?: boolean }) {
  const db = supabase();
  let query = db
    .from("email_captures")
    .select("*")
    .order("created_at", { ascending: false });

  if (filters?.state) {
    query = query.eq("state", filters.state);
  }
  if (filters?.notified !== undefined) {
    query = query.eq("notified", filters.notified);
  }

  const { data, error } = await query;
  return { data: data || [], error };
}

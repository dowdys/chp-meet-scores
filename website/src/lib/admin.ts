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

  return { data: data || [], error };
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

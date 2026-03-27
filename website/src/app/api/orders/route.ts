import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";

// Order lookup by order_number + email (customer-facing)
export async function GET(request: NextRequest) {
  const orderNumber = request.nextUrl.searchParams.get("order_number");
  const email = request.nextUrl.searchParams.get("email");

  if (!orderNumber || !email) {
    return NextResponse.json(
      { error: "Order number and email are required" },
      { status: 400 }
    );
  }

  const supabase = createServiceClient();

  // Look up order — generic error message regardless of whether
  // the order exists but email doesn't match, or doesn't exist at all
  const { data: order, error } = await supabase
    .from("orders")
    .select("*, order_items(*)")
    .eq("order_number", orderNumber)
    .eq("customer_email", email.toLowerCase().trim())
    .single();

  if (error || !order) {
    return NextResponse.json(
      { error: "Order not found" },
      { status: 404 }
    );
  }

  // Return limited data (no internal IDs, no full addresses)
  return NextResponse.json({
    order_number: order.order_number,
    status: order.status,
    customer_name: order.customer_name,
    total: order.total,
    tracking_number: order.tracking_number,
    carrier: order.carrier,
    created_at: order.created_at,
    shipped_at: order.shipped_at,
    items: (order.order_items || []).map((item: {
      athlete_name: string;
      shirt_size: string;
      shirt_color: string;
      has_jewel: boolean;
      production_status: string;
    }) => ({
      athlete_name: item.athlete_name,
      shirt_size: item.shirt_size,
      shirt_color: item.shirt_color,
      has_jewel: item.has_jewel,
      production_status: item.production_status,
    })),
  });
}

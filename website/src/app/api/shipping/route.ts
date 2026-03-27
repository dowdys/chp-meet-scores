import { NextRequest, NextResponse } from "next/server";
import { easypost, SHIRT_PARCEL, FROM_ADDRESS } from "@/lib/easypost";
import { createServiceClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  try {
    const { orderIds }: { orderIds: number[] } = await request.json();

    if (!orderIds || orderIds.length === 0) {
      return NextResponse.json(
        { error: "No order IDs provided" },
        { status: 400 }
      );
    }

    const supabase = createServiceClient();

    // Fetch orders
    const { data: orders, error } = await supabase
      .from("orders")
      .select("*, order_items(*)")
      .in("id", orderIds);

    if (error || !orders) {
      return NextResponse.json(
        { error: "Failed to fetch orders" },
        { status: 500 }
      );
    }

    const results: Array<{ orderId: number; orderNumber: string; success: boolean; trackingNumber?: string; labelUrl?: string | null; error?: string }> = [];

    for (const order of orders) {
      try {
        // Create EasyPost shipment
        const itemCount = order.order_items?.length || 1;
        const shipment = await easypost.Shipment.create({
          from_address: FROM_ADDRESS,
          to_address: {
            name: order.shipping_name,
            street1: order.shipping_address_line1,
            street2: order.shipping_address_line2 || undefined,
            city: order.shipping_city,
            state: order.shipping_state,
            zip: order.shipping_zip,
            country: "US",
          },
          parcel: {
            ...SHIRT_PARCEL,
            weight: SHIRT_PARCEL.weight * itemCount, // Scale weight by item count
          },
        });

        // Buy the cheapest rate
        const boughtShipment = await easypost.Shipment.buy(
          shipment.id,
          shipment.lowestRate()
        );

        // Update order with tracking info
        await supabase
          .from("orders")
          .update({
            easypost_shipment_id: boughtShipment.id,
            tracking_number: boughtShipment.tracking_code,
            carrier: boughtShipment.selected_rate?.carrier || "USPS",
            status: "shipped",
            shipped_at: new Date().toISOString(),
          })
          .eq("id", order.id);

        // Record status change
        await supabase.from("order_status_history").insert({
          order_id: order.id,
          old_status: order.status,
          new_status: "shipped",
          changed_by: "system",
          reason: "Shipping label created via EasyPost",
        });

        // Update all order items to packed
        await supabase
          .from("order_items")
          .update({ production_status: "packed" })
          .eq("order_id", order.id);

        results.push({
          orderId: order.id,
          orderNumber: order.order_number,
          trackingNumber: boughtShipment.tracking_code,
          labelUrl: boughtShipment.postage_label?.label_url || null,
          success: true,
        });
      } catch (err) {
        results.push({
          orderId: order.id,
          orderNumber: order.order_number,
          success: false,
          error: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }

    return NextResponse.json({ results });
  } catch {
    return NextResponse.json(
      { error: "Failed to create shipping labels" },
      { status: 500 }
    );
  }
}

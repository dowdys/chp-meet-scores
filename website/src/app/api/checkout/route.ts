import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getStripe } from "@/lib/stripe";
import {
  SHIRT_PRICE,
  JEWEL_PRICE,
  calculateShipping,
  SHIRT_SIZES,
  SHIRT_COLORS,
} from "@/lib/utils";

interface CartItemInput {
  athleteName: string;
  correctedName?: string;
  meetName: string;
  state: string;
  level: string;
  gym: string;
  shirtSize: string;
  shirtColor: string;
  hasJewel: boolean;
}

export async function POST(request: NextRequest) {
  try {
    const { items }: { items: CartItemInput[] } = await request.json();

    if (!items || items.length === 0) {
      return NextResponse.json({ error: "Cart is empty" }, { status: 400 });
    }

    if (items.length > 20) {
      return NextResponse.json(
        { error: "Maximum 20 items per order" },
        { status: 400 }
      );
    }

    // Validate all items server-side (never trust client prices)
    for (const item of items) {
      if (!item.athleteName || !item.meetName || !item.shirtSize) {
        return NextResponse.json(
          { error: "Invalid item data" },
          { status: 400 }
        );
      }
      if (!SHIRT_SIZES.includes(item.shirtSize as (typeof SHIRT_SIZES)[number])) {
        return NextResponse.json(
          { error: `Invalid shirt size: ${item.shirtSize}` },
          { status: 400 }
        );
      }
      if (!SHIRT_COLORS.includes(item.shirtColor as (typeof SHIRT_COLORS)[number])) {
        return NextResponse.json(
          { error: `Invalid shirt color: ${item.shirtColor}` },
          { status: 400 }
        );
      }
    }

    // Build Stripe line items (server-calculated prices)
    const shirtCount = items.length;
    const jewelCount = items.filter((i) => i.hasJewel).length;

    const lineItems: Array<{
      price_data: {
        currency: string;
        product_data: { name: string; tax_code?: string };
        unit_amount: number;
        tax_behavior: "exclusive";
      };
      quantity: number;
    }> = [
      {
        price_data: {
          currency: "usd",
          product_data: {
            name: "Championship T-Shirt",
            tax_code: "txcd_99999999", // General tangible goods
          },
          unit_amount: SHIRT_PRICE,
          tax_behavior: "exclusive",
        },
        quantity: shirtCount,
      },
    ];

    if (jewelCount > 0) {
      lineItems.push({
        price_data: {
          currency: "usd",
          product_data: {
            name: "Jewel Accent Add-On",
            tax_code: "txcd_99999999",
          },
          unit_amount: JEWEL_PRICE,
          tax_behavior: "exclusive",
        },
        quantity: jewelCount,
      });
    }

    // Add shipping as a line item
    const shippingCost = calculateShipping(shirtCount);
    lineItems.push({
      price_data: {
        currency: "usd",
        product_data: {
          name:
            shirtCount === 1
              ? "Shipping"
              : `Shipping (${shirtCount} shirts)`,
        },
        unit_amount: shippingCost,
        tax_behavior: "exclusive",
      },
      quantity: 1,
    });

    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";

    // Store cart server-side (avoids Stripe's 500-char metadata limit)
    const cartToken = crypto.randomUUID();
    const supabase = createServiceClient();
    const { error: cartError } = await supabase.from("pending_carts").insert({
      cart_token: cartToken,
      items: items.map((i) => ({
        athleteName: i.athleteName,
        correctedName: i.correctedName || null,
        meetName: i.meetName,
        state: i.state,
        level: i.level,
        gym: i.gym,
        shirtSize: i.shirtSize,
        shirtColor: i.shirtColor,
        hasJewel: i.hasJewel,
      })),
    });

    if (cartError) {
      console.error("Failed to store cart:", cartError);
      return NextResponse.json(
        { error: "Failed to prepare checkout" },
        { status: 500 }
      );
    }

    const session = await getStripe().checkout.sessions.create({
      mode: "payment",
      line_items: lineItems,
      shipping_address_collection: { allowed_countries: ["US"] },
      success_url: `${siteUrl}/confirmation?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/order`,
      metadata: {
        cart_token: cartToken,
        item_count: shirtCount.toString(),
      },
    });

    return NextResponse.json({ url: session.url });
  } catch (error) {
    console.error("Checkout session creation failed:", error);
    return NextResponse.json(
      { error: "Failed to create checkout session" },
      { status: 500 }
    );
  }
}

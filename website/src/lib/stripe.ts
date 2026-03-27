import "server-only";

import Stripe from "stripe";

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  typescript: true,
});

// Prices in cents
export const SHIRT_PRICE = 2795; // $27.95
export const JEWEL_PRICE = 450; // $4.50
export const SHIPPING_FIRST = 525; // $5.25
export const SHIPPING_ADDITIONAL = 290; // $2.90

export function calculateShipping(itemCount: number): number {
  if (itemCount <= 0) return 0;
  return SHIPPING_FIRST + SHIPPING_ADDITIONAL * (itemCount - 1);
}

export function calculateItemPrice(hasJewel: boolean): number {
  return SHIRT_PRICE + (hasJewel ? JEWEL_PRICE : 0);
}

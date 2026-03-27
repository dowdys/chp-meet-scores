import "server-only";

import Stripe from "stripe";

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  typescript: true,
});

// Re-export pricing from utils for server-side convenience
export {
  SHIRT_PRICE,
  JEWEL_PRICE,
  SHIPPING_FIRST,
  SHIPPING_ADDITIONAL,
  calculateShipping,
  calculateItemPrice,
} from "./utils";

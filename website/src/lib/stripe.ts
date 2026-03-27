import "server-only";

import Stripe from "stripe";

let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (!_stripe) {
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      typescript: true,
    });
  }
  return _stripe;
}

// Re-export pricing from utils for server-side convenience
export {
  SHIRT_PRICE,
  JEWEL_PRICE,
  SHIPPING_FIRST,
  SHIPPING_ADDITIONAL,
  calculateShipping,
  calculateItemPrice,
} from "./utils";

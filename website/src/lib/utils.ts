/**
 * Format cents to display price string.
 * 2795 → "$27.95"
 */
export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Generate a human-friendly order number with random component.
 * Format: CHP-2026-A7K3F (non-sequential to prevent enumeration)
 */
export function generateOrderDisplay(sequenceNum: number): string {
  const year = new Date().getFullYear();
  const random = Math.random().toString(36).substring(2, 7).toUpperCase();
  return `CHP-${year}-${random}`;
}

/**
 * Prices in cents (shared between client and server).
 */
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

/**
 * Shirt sizes in display order.
 */
export const SHIRT_SIZES = [
  "YS",
  "YM",
  "YL",
  "S",
  "M",
  "L",
  "XL",
  "XXL",
] as const;

export type ShirtSize = (typeof SHIRT_SIZES)[number];

/**
 * Shirt colors.
 */
export const SHIRT_COLORS = ["white", "grey"] as const;
export type ShirtColor = (typeof SHIRT_COLORS)[number];

/**
 * Gymnastics events.
 */
export const EVENTS = ["vault", "bars", "beam", "floor", "aa"] as const;
export type GymEvent = (typeof EVENTS)[number];

export const EVENT_DISPLAY: Record<GymEvent, string> = {
  vault: "Vault",
  bars: "Bars",
  beam: "Beam",
  floor: "Floor",
  aa: "All Around",
};

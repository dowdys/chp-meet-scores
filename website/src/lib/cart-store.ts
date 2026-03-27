import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ShirtSize, ShirtColor } from "./utils";
import { SHIRT_PRICE, JEWEL_PRICE, calculateShipping } from "./utils";

export interface CartItem {
  id: string; // unique key for this item
  athleteName: string;
  correctedName?: string;
  meetName: string;
  state: string;
  level: string;
  gym: string;
  shirtSize: ShirtSize;
  shirtColor: ShirtColor;
  hasJewel: boolean;
}

interface CartState {
  items: CartItem[];
  addItem: (item: Omit<CartItem, "id">) => void;
  removeItem: (id: string) => void;
  clearCart: () => void;
  getSubtotal: () => number;
  getShippingCost: () => number;
  getTotal: () => number;
}

function generateId(): string {
  return Math.random().toString(36).substring(2, 10);
}

function itemPrice(item: CartItem): number {
  return SHIRT_PRICE + (item.hasJewel ? JEWEL_PRICE : 0);
}

export const useCartStore = create<CartState>()(
  persist(
    (set, get) => ({
      items: [],

      addItem: (item) =>
        set((state) => ({
          items: [...state.items, { ...item, id: generateId() }],
        })),

      removeItem: (id) =>
        set((state) => ({
          items: state.items.filter((i) => i.id !== id),
        })),

      clearCart: () => set({ items: [] }),

      getSubtotal: () => {
        return get().items.reduce((sum, item) => sum + itemPrice(item), 0);
      },

      getShippingCost: () => {
        return calculateShipping(get().items.length);
      },

      getTotal: () => {
        return get().getSubtotal() + get().getShippingCost();
      },
    }),
    {
      name: "chp-cart",
      skipHydration: true, // Prevent SSR hydration mismatch
    }
  )
);

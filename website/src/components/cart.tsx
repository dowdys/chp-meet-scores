"use client";

import Link from "next/link";
import { useCartStore } from "@/lib/cart-store";
import { formatPrice, calculateItemPrice } from "@/lib/utils";

export function Cart() {
  const { items, removeItem, getSubtotal, getShippingCost, getTotal } =
    useCartStore();

  if (items.length === 0) {
    return (
      <div className="text-center py-8 text-gray-400">
        <p>Your cart is empty</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-bold text-white">
        Your Cart ({items.length} {items.length === 1 ? "shirt" : "shirts"})
      </h3>

      {items.map((item) => (
        <div
          key={item.id}
          className="bg-white/5 rounded-xl p-4 flex justify-between items-start"
        >
          <div>
            <p className="font-medium text-white">
              {item.correctedName || item.athleteName}
              {item.correctedName && (
                <span className="text-xs text-yellow-400 ml-2">
                  (corrected)
                </span>
              )}
            </p>
            <p className="text-sm text-gray-400">
              {item.shirtSize} • {item.shirtColor}
              {item.hasJewel && " • 💎 Jewel"}
            </p>
            <p className="text-xs text-gray-500">
              Level {item.level} • {item.state}
            </p>
          </div>
          <div className="text-right">
            <p className="font-medium text-white">
              {formatPrice(calculateItemPrice(item.hasJewel))}
            </p>
            <button
              onClick={() => removeItem(item.id)}
              className="text-xs text-red-400 hover:text-red-300 mt-1"
            >
              Remove
            </button>
          </div>
        </div>
      ))}

      {/* Totals */}
      <div className="border-t border-white/10 pt-4 space-y-2">
        <div className="flex justify-between text-sm text-gray-300">
          <span>Subtotal</span>
          <span>{formatPrice(getSubtotal())}</span>
        </div>
        <div className="flex justify-between text-sm text-gray-300">
          <span>Shipping</span>
          <span>{formatPrice(getShippingCost())}</span>
        </div>
        <div className="flex justify-between text-lg font-bold text-white">
          <span>Total</span>
          <span>{formatPrice(getTotal())}</span>
        </div>
        <p className="text-xs text-gray-500">+ applicable tax at checkout</p>
      </div>

      <Link
        href="/checkout"
        className="block w-full text-center bg-yellow-400 text-black py-3 rounded-lg font-bold hover:bg-yellow-300 transition"
      >
        Proceed to Checkout
      </Link>
    </div>
  );
}

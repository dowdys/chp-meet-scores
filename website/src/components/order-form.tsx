"use client";

import { useState } from "react";
import { useCartStore, type CartItem } from "@/lib/cart-store";
import {
  SHIRT_SIZES,
  SHIRT_COLORS,
  formatPrice,
  calculateItemPrice,
  type ShirtSize,
  type ShirtColor,
} from "@/lib/utils";

interface OrderFormProps {
  athleteName: string;
  meetName: string;
  state: string;
  level: string;
  gym: string;
  onColorChange?: (color: "white" | "grey") => void;
  onJewelChange?: (hasJewel: boolean) => void;
}

export function OrderForm({
  athleteName,
  meetName,
  state,
  level,
  gym,
  onColorChange,
  onJewelChange,
}: OrderFormProps) {
  const { addItem } = useCartStore();

  const [size, setSize] = useState<ShirtSize>("M");
  const [color, setColor] = useState<ShirtColor>("white");
  const [hasJewel, setHasJewel] = useState(false);
  const [nameCorrection, setNameCorrection] = useState("");
  const [showNameCorrection, setShowNameCorrection] = useState(false);
  const [added, setAdded] = useState(false);

  const handleAddToCart = () => {
    const item: Omit<CartItem, "id"> = {
      athleteName,
      meetName,
      state,
      level,
      gym,
      shirtSize: size,
      shirtColor: color,
      hasJewel,
      ...(showNameCorrection && nameCorrection
        ? { correctedName: nameCorrection }
        : {}),
    };
    addItem(item);
    setAdded(true);
    setTimeout(() => setAdded(false), 2000);
  };

  const price = calculateItemPrice(hasJewel);

  return (
    <div className="space-y-6">
      {/* Athlete info */}
      <div className="bg-white/5 rounded-xl p-4">
        <p className="text-sm text-gray-400">Ordering for</p>
        <p className="text-xl font-bold text-white">{athleteName}</p>
        <p className="text-sm text-red-400">{gym}</p>
        <p className="text-sm text-gray-400">
          Level {level} • {state}
        </p>
      </div>

      {/* Name correction */}
      <div>
        <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
          <input
            type="checkbox"
            checked={showNameCorrection}
            onChange={(e) => setShowNameCorrection(e.target.checked)}
            className="rounded"
          />
          Name needs a spelling correction
        </label>
        {showNameCorrection && (
          <input
            type="text"
            value={nameCorrection}
            onChange={(e) => setNameCorrection(e.target.value)}
            placeholder="Enter correct spelling..."
            className="mt-2 w-full rounded-lg border border-gray-600 bg-gray-800 px-3 py-2 text-white"
            maxLength={100}
          />
        )}
      </div>

      {/* Size */}
      <div>
        <label className="block text-sm font-medium text-gray-300 mb-2">
          Shirt Size
        </label>
        <div className="grid grid-cols-4 gap-2">
          {SHIRT_SIZES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSize(s)}
              className={`py-2 rounded-lg text-sm font-medium transition ${
                size === s
                  ? "bg-red-600 text-black"
                  : "bg-white/10 text-white hover:bg-white/20"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Color */}
      <div>
        <label className="block text-sm font-medium text-gray-300 mb-2">
          Shirt Color
        </label>
        <div className="flex gap-3">
          {SHIRT_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => { setColor(c); onColorChange?.(c); }}
              className={`flex-1 py-2 rounded-lg text-sm font-medium capitalize transition ${
                color === c
                  ? "ring-2 ring-yellow-400 bg-white/20 text-white"
                  : "bg-white/10 text-gray-300 hover:bg-white/20"
              }`}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {/* Jewel */}
      <label className="flex items-center justify-between bg-white/5 rounded-xl p-4 cursor-pointer">
        <div>
          <p className="text-white font-medium">Add Jewel Accent</p>
          <p className="text-sm text-gray-400">
            Rhinestone crystal on the design
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-red-500 font-medium">+$4.50</span>
          <input
            type="checkbox"
            checked={hasJewel}
            onChange={(e) => { setHasJewel(e.target.checked); onJewelChange?.(e.target.checked); }}
            className="w-5 h-5 rounded"
          />
        </div>
      </label>

      {/* Price + Add to Cart */}
      <div className="flex items-center justify-between">
        <p className="text-2xl font-bold text-white">{formatPrice(price)}</p>
        <button
          onClick={handleAddToCart}
          className={`px-6 py-3 rounded-lg font-bold transition ${
            added
              ? "bg-green-500 text-white"
              : "bg-red-600 text-black hover:bg-red-500"
          }`}
        >
          {added ? "Added!" : "Add to Cart"}
        </button>
      </div>
    </div>
  );
}

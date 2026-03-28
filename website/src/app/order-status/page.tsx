"use client";

import { useState } from "react";
import Link from "next/link";
import { formatPrice } from "@/lib/utils";

interface OrderResult {
  order_number: string;
  status: string;
  customer_name: string;
  total: number;
  tracking_number: string | null;
  carrier: string | null;
  created_at: string;
  shipped_at: string | null;
  items: Array<{
    athlete_name: string;
    shirt_size: string;
    shirt_color: string;
    has_jewel: boolean;
    production_status: string;
  }>;
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  pending: { label: "Pending Payment", color: "bg-gray-100 text-gray-700" },
  paid: { label: "Order Received", color: "bg-green-100 text-green-700" },
  processing: { label: "Being Printed", color: "bg-yellow-100 text-yellow-700" },
  shipped: { label: "Shipped", color: "bg-blue-100 text-blue-700" },
  delivered: { label: "Delivered", color: "bg-green-200 text-green-800" },
  refunded: { label: "Refunded", color: "bg-red-100 text-red-700" },
  cancelled: { label: "Cancelled", color: "bg-gray-200 text-gray-600" },
};

export default function OrderStatusPage() {
  const [orderNumber, setOrderNumber] = useState("");
  const [email, setEmail] = useState("");
  const [order, setOrder] = useState<OrderResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleLookup = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    setOrder(null);

    try {
      const res = await fetch(
        `/api/orders?order_number=${encodeURIComponent(orderNumber)}&email=${encodeURIComponent(email)}`
      );

      if (!res.ok) {
        // Generic error — don't distinguish "not found" from "wrong email"
        setError("Order not found. Please check your order number and email.");
        setLoading(false);
        return;
      }

      const data = await res.json();
      setOrder(data);
    } catch {
      setError("Something went wrong. Please try again.");
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-900 to-black text-white">
      <header className="p-6 max-w-6xl mx-auto">
        <Link href="/" className="text-xl font-bold">
          The State Champion
        </Link>
      </header>

      <main className="max-w-lg mx-auto px-6 py-12">
        <h1 className="text-3xl font-bold mb-2 text-center">
          Track Your Order
        </h1>
        <p className="text-gray-400 mb-8 text-center">
          Enter your order number and email to check your order status.
        </p>

        <form onSubmit={handleLookup} className="space-y-4 mb-8">
          <div>
            <label className="block text-sm font-medium mb-1">
              Order Number
            </label>
            <input
              type="text"
              required
              value={orderNumber}
              onChange={(e) => setOrderNumber(e.target.value)}
              placeholder="CHP-2026-A7K3F001"
              className="w-full rounded-lg border border-gray-600 bg-gray-800 px-3 py-2 text-white font-mono"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com"
              className="w-full rounded-lg border border-gray-600 bg-gray-800 px-3 py-2 text-white"
            />
          </div>

          {error && <p className="text-red-400 text-sm">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-red-600 text-black py-3 rounded-lg font-bold hover:bg-red-500 transition disabled:opacity-50"
          >
            {loading ? "Looking up..." : "Find My Order"}
          </button>
        </form>

        {order && (
          <div className="bg-white/5 rounded-xl p-6 space-y-4">
            <div className="flex justify-between items-center">
              <div>
                <p className="text-sm text-gray-400">Order</p>
                <p className="font-mono font-bold">{order.order_number}</p>
              </div>
              <span
                className={`px-3 py-1 rounded-full text-sm font-medium ${
                  STATUS_LABELS[order.status]?.color || "bg-gray-100"
                }`}
              >
                {STATUS_LABELS[order.status]?.label || order.status}
              </span>
            </div>

            <div className="border-t border-white/10 pt-4">
              <p className="text-sm text-gray-400 mb-2">Items</p>
              {order.items.map((item, i) => (
                <div
                  key={i}
                  className="flex justify-between py-1 text-sm"
                >
                  <span>
                    {item.athlete_name} — {item.shirt_size}{" "}
                    {item.shirt_color}
                    {item.has_jewel && " 💎"}
                  </span>
                  <span className="text-gray-400">
                    {item.production_status}
                  </span>
                </div>
              ))}
            </div>

            <div className="border-t border-white/10 pt-4">
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Total</span>
                <span className="font-bold">{formatPrice(order.total)}</span>
              </div>
              <div className="flex justify-between text-sm mt-1">
                <span className="text-gray-400">Ordered</span>
                <span>{new Date(order.created_at).toLocaleDateString()}</span>
              </div>
              {order.tracking_number && (
                <div className="flex justify-between text-sm mt-1">
                  <span className="text-gray-400">Tracking</span>
                  <span className="font-mono text-blue-400">
                    {order.tracking_number}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useCartStore } from "@/lib/cart-store";
import { Cart } from "@/components/cart";

export default function CheckoutPage() {
  const { items } = useCartStore();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (items.length === 0) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-gray-900 to-black text-white flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold mb-4">Your cart is empty</h1>
          <Link href="/find" className="text-yellow-400 hover:underline">
            Find your champion
          </Link>
        </div>
      </div>
    );
  }

  const handleCheckout = async () => {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to start checkout");
        setLoading(false);
        return;
      }

      const data = await res.json();
      if (data.url) {
        // Redirect to Stripe Checkout
        window.location.href = data.url;
      }
    } catch {
      setError("Network error. Please try again.");
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-900 to-black text-white">
      <header className="p-6 max-w-6xl mx-auto">
        <Link href="/" className="text-xl font-bold">
          The State Champion
        </Link>
      </header>

      <main className="max-w-lg mx-auto px-6 py-8">
        <h1 className="text-3xl font-bold mb-8">Review & Pay</h1>

        <Cart />

        {error && (
          <div className="mt-4 bg-red-500/10 border border-red-500/30 rounded-lg p-4">
            <p className="text-red-400">{error}</p>
          </div>
        )}

        <button
          onClick={handleCheckout}
          disabled={loading}
          className="mt-6 w-full bg-yellow-400 text-black py-4 rounded-lg text-lg font-bold hover:bg-yellow-300 transition disabled:opacity-50"
        >
          {loading ? "Redirecting to payment..." : "Pay with Stripe"}
        </button>

        <p className="mt-4 text-center text-xs text-gray-500">
          You&apos;ll be redirected to Stripe&apos;s secure checkout to complete
          payment. Card, Apple Pay, and Google Pay accepted.
        </p>
      </main>
    </div>
  );
}

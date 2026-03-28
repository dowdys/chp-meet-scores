"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, Suspense } from "react";
import Link from "next/link";
import { useCartStore } from "@/lib/cart-store";

function ConfirmationContent() {
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("session_id");
  const { clearCart } = useCartStore();

  // Clear cart on successful checkout
  useEffect(() => {
    if (sessionId) {
      clearCart();
    }
  }, [sessionId, clearCart]);

  return (
    <div className="min-h-screen bg-white text-gray-900 dark:bg-gray-950 dark:text-white flex items-center justify-center px-6">
      <div className="text-center max-w-lg">
        <div className="text-6xl mb-6">🎉</div>
        <h1 className="text-3xl font-bold mb-4">Order Confirmed!</h1>
        <p className="text-gray-300 mb-2">
          Thank you for your order. A confirmation email is on its way.
        </p>
        <p className="text-gray-400 text-sm mb-8">
          Your championship shirt will be screen-printed and shipped directly to
          you. We&apos;ll send tracking info when it ships.
        </p>

        <div className="flex gap-4 justify-center">
          <Link
            href="/order-status"
            className="bg-red-600 text-white px-6 py-3 rounded-lg font-bold hover:bg-red-500 transition"
          >
            Track Your Order
          </Link>
          <Link
            href="/"
            className="border border-white/30 px-6 py-3 rounded-lg hover:bg-white/10 transition"
          >
            Back to Home
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function ConfirmationPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-white text-gray-900 dark:bg-gray-950 dark:text-white flex items-center justify-center">
          Loading...
        </div>
      }
    >
      <ConfirmationContent />
    </Suspense>
  );
}

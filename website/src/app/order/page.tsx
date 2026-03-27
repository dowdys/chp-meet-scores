"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import Link from "next/link";
import { OrderForm } from "@/components/order-form";
import { Cart } from "@/components/cart";

function OrderContent() {
  const searchParams = useSearchParams();

  const name = searchParams.get("name") || "";
  const gym = searchParams.get("gym") || "";
  const meet = searchParams.get("meet") || "";
  const state = searchParams.get("state") || "";
  const level = searchParams.get("level") || "";

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-900 to-black text-white">
      <header className="flex items-center justify-between p-6 max-w-6xl mx-auto">
        <Link href="/" className="text-xl font-bold">
          The State Champion
        </Link>
        <Link href="/find" className="text-sm hover:text-yellow-400">
          Find Another Athlete
        </Link>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-8">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          {/* Left: Order Form */}
          <div>
            <h1 className="text-2xl font-bold mb-6">
              Order Championship Shirt
            </h1>
            {name ? (
              <OrderForm
                athleteName={name}
                meetName={meet}
                state={state}
                level={level}
                gym={gym}
              />
            ) : (
              <div className="bg-white/5 rounded-xl p-6 text-center">
                <p className="text-gray-400 mb-4">No athlete selected.</p>
                <Link
                  href="/find"
                  className="text-yellow-400 underline"
                >
                  Find your champion first
                </Link>
              </div>
            )}

            {/* Add another shirt link */}
            {name && (
              <div className="mt-6 text-center">
                <Link
                  href="/find"
                  className="text-sm text-yellow-400 hover:underline"
                >
                  + Add a shirt for another athlete
                </Link>
              </div>
            )}
          </div>

          {/* Right: Cart */}
          <div>
            <h2 className="text-2xl font-bold mb-6">Your Cart</h2>
            <Cart />
          </div>
        </div>
      </main>
    </div>
  );
}

export default function OrderPage() {
  return (
    <Suspense fallback={<div className="p-8 text-white">Loading...</div>}>
      <OrderContent />
    </Suspense>
  );
}

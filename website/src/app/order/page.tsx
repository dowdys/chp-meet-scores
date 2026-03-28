"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useState, useEffect } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { OrderForm } from "@/components/order-form";
import { Cart } from "@/components/cart";
import { ShirtPreview } from "@/components/shirt-preview";
import { getFrontUrl } from "@/lib/shirt-urls";

const ConfettiBurst = dynamic(
  () => import("@/components/celebration/confetti-burst").then((m) => m.ConfettiBurst),
  { ssr: false }
);
const PodiumReveal = dynamic(
  () => import("@/components/celebration/podium-reveal").then((m) => m.PodiumReveal),
  { ssr: false }
);

function OrderContent() {
  const searchParams = useSearchParams();

  const name = searchParams.get("name") || "";
  const gym = searchParams.get("gym") || "";
  const meet = searchParams.get("meet") || "";
  const state = searchParams.get("state") || "";
  const level = searchParams.get("level") || "";

  const [showCelebration, setShowCelebration] = useState(!!name);
  const [confettiTrigger, setConfettiTrigger] = useState(false);
  const [shirtColor, setShirtColor] = useState<"white" | "grey">("white");
  const [hasJewel, setHasJewel] = useState(false);

  // Front image URL (PNG from shirt-fronts bucket)
  const frontImageUrl = meet ? getFrontUrl(meet) : null;

  // Back image URL (PNG from shirt-backs bucket)
  const backImageUrl = (() => {
    if (!meet) return null;
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    // Extract state abbreviation from meet name
    const stateMatch = meet.match(/\d{4}\s+([A-Z]{2})/);
    if (!stateMatch) return null;
    return `${supabaseUrl}/storage/v1/object/public/shirt-backs/${stateMatch[1]}_back_1.png`;
  })();

  useEffect(() => {
    if (name && showCelebration) {
      const timer = setTimeout(() => setConfettiTrigger(true), 300);
      const hideTimer = setTimeout(() => setShowCelebration(false), 4000);
      return () => { clearTimeout(timer); clearTimeout(hideTimer); };
    }
  }, [name, showCelebration]);

  return (
    <div className="min-h-screen bg-white text-gray-900 dark:bg-gray-950 dark:text-white">
      <header className="flex items-center justify-between p-6 max-w-6xl mx-auto">
        <Link href="/" className="text-xl font-bold">
          The State Champion
        </Link>
        <Link href="/find" className="text-sm hover:text-red-500">
          Find Another Athlete
        </Link>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-8">
        {/* Celebration animation when arriving from /find */}
        {showCelebration && name && (
          <div className="mb-8 text-center py-8">
            <ConfettiBurst trigger={confettiTrigger} />
            <PodiumReveal
              athleteName={name}
              events={[]}
              level={level}
              state={state}
              gym={gym}
            />
          </div>
        )}

        {/* Shirt Preview */}
        {name && (frontImageUrl || backImageUrl) && (
          <div className="mb-8">
            <ShirtPreview
              frontImageUrl={frontImageUrl}
              backImageUrl={backImageUrl}
              color={shirtColor}
            />
          </div>
        )}

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
                onColorChange={setShirtColor}
                onJewelChange={setHasJewel}
              />
            ) : (
              <div className="bg-white/5 rounded-xl p-6 text-center">
                <p className="text-gray-400 mb-4">No athlete selected.</p>
                <Link
                  href="/find"
                  className="text-red-500 underline"
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
                  className="text-sm text-red-500 hover:underline"
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

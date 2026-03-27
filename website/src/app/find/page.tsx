"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useState } from "react";
import Link from "next/link";

const AthleteLookup = dynamic(
  () => import("@/components/athlete-lookup").then((m) => m.AthleteLookup),
  { ssr: false }
);

export default function FindYourChampionPage() {
  const router = useRouter();
  const [showEmailCapture, setShowEmailCapture] = useState(false);

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-900 to-black text-white">
      <header className="flex items-center justify-between p-6 max-w-6xl mx-auto">
        <Link href="/" className="text-xl font-bold">
          The State Champion
        </Link>
      </header>

      <main className="max-w-lg mx-auto px-6 py-12">
        <h1 className="text-3xl font-bold mb-2 text-center">
          Find Your Champion
        </h1>
        <p className="text-gray-400 mb-8 text-center">
          Search for your athlete to see their achievements and order their
          championship shirt.
        </p>

        <AthleteLookup
          onAthleteSelected={(athlete) => {
            // Navigate to celebration page — in a real implementation,
            // we'd look up the athlete's token first
            const params = new URLSearchParams({
              name: athlete.name,
              gym: athlete.gym,
              meet: athlete.meet_name,
              state: athlete.state,
              level: athlete.level,
            });
            router.push(`/order?${params.toString()}`);
          }}
          onNoResults={() => setShowEmailCapture(true)}
        />

        {showEmailCapture && (
          <div className="mt-8 p-6 bg-yellow-400/10 border border-yellow-400/30 rounded-xl">
            <h3 className="font-bold text-yellow-400 mb-2">
              Results Not Ready Yet
            </h3>
            <p className="text-sm text-gray-300 mb-4">
              We&apos;re still processing results for this meet. Enter your
              email and we&apos;ll notify you when they&apos;re ready!
            </p>
            <Link
              href="/email-capture"
              className="text-yellow-400 underline text-sm"
            >
              Sign up for notifications
            </Link>
          </div>
        )}
      </main>
    </div>
  );
}

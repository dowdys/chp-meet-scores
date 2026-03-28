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
    <div className="min-h-screen bg-white text-gray-900 dark:bg-gray-950 dark:text-white">
      <header className="flex items-center justify-between p-6 max-w-6xl mx-auto">
        <Link href="/" className="text-xl font-bold">
          The State Champion
        </Link>
      </header>

      <main className="max-w-lg mx-auto px-6 py-12">
        <h1 className="text-3xl font-bold mb-2 text-center">
          Find Your Champion
        </h1>
        <p className="text-gray-500 dark:text-gray-400 mb-8 text-center">
          Search for your athlete to see their achievements and order their
          championship shirt.
        </p>

        <AthleteLookup
          onAthleteSelected={async (athlete) => {
            // Try to find athlete's QR token for full celebration experience
            const { createClient } = await import("@/lib/supabase/client");
            const supabase = createClient();
            const { data: token } = await supabase
              .from("athlete_tokens")
              .select("token")
              .eq("meet_name", athlete.meet_name)
              .eq("athlete_name", athlete.name)
              .eq("gym", athlete.gym)
              .limit(1)
              .single();

            if (token?.token) {
              // Full celebration experience with event-specific animation
              router.push(`/celebrate/${token.token}`);
            } else {
              // No token yet — go to order page with inline celebration
              const params = new URLSearchParams({
                name: athlete.name,
                gym: athlete.gym,
                meet: athlete.meet_name,
                state: athlete.state,
                level: athlete.level,
              });
              router.push(`/order?${params.toString()}`);
            }
          }}
          onNoResults={() => setShowEmailCapture(true)}
        />

        {showEmailCapture && (
          <div className="mt-8 p-6 bg-red-600/10 border border-red-500/30 rounded-xl">
            <h3 className="font-bold text-red-500 mb-2">
              Results Not Ready Yet
            </h3>
            <p className="text-sm text-gray-300 mb-4">
              We&apos;re still processing results for this meet. Enter your
              email and we&apos;ll notify you when they&apos;re ready!
            </p>
            <Link
              href="/email-capture"
              className="text-red-500 underline text-sm"
            >
              Sign up for notifications
            </Link>
          </div>
        )}
      </main>
    </div>
  );
}

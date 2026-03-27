"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { ConfettiBurst } from "@/components/celebration/confetti-burst";
import { PodiumReveal } from "@/components/celebration/podium-reveal";

interface CelebrationClientProps {
  token: string;
  athleteName: string;
  gym: string;
  level: string;
  meetName: string;
  events: Array<{ event: string; score: number; is_tie: boolean }>;
}

export function CelebrationClient({
  token,
  athleteName,
  gym,
  level,
  meetName,
  events,
}: CelebrationClientProps) {
  const [showConfetti, setShowConfetti] = useState(false);
  const [showCTA, setShowCTA] = useState(false);

  // Extract state from meet_name: "USAG W Gymnastics - 2026 NV - March 14-16" → get state
  const meetParts = meetName.split(" - ");
  const state = meetParts[1]?.replace(/^\d{4}\s*/, "") || "";

  useEffect(() => {
    // Trigger confetti after a brief delay for dramatic effect
    const confettiTimer = setTimeout(() => setShowConfetti(true), 400);
    // Show CTA after animations complete
    const ctaTimer = setTimeout(() => setShowCTA(true), 2500);

    // Track scan (fire-and-forget, non-blocking)
    fetch("/api/celebrate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    }).catch(() => {}); // Ignore errors — analytics are non-critical

    return () => {
      clearTimeout(confettiTimer);
      clearTimeout(ctaTimer);
    };
  }, [token]);

  const orderParams = new URLSearchParams({
    name: athleteName,
    gym,
    meet: meetName,
    level,
  });

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 py-12 relative">
      <ConfettiBurst trigger={showConfetti} />

      <PodiumReveal
        athleteName={athleteName}
        events={events}
        level={level}
        state={state}
        gym={gym}
      />

      {/* CTA */}
      <div
        className={`mt-10 transition-all duration-700 ${
          showCTA ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
        }`}
      >
        <Link
          href={`/order?${orderParams.toString()}`}
          className="inline-block bg-yellow-400 text-black px-10 py-4 rounded-xl text-xl font-bold hover:bg-yellow-300 transition shadow-lg shadow-yellow-400/20"
        >
          Order Your Championship Shirt →
        </Link>
      </div>

      {/* Attribution */}
      <p className="absolute bottom-6 text-gray-600 text-xs">
        thestatechampion.com
      </p>
    </div>
  );
}

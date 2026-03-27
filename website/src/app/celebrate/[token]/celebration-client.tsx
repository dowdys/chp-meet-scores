"use client";

import { useState, useEffect } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { ConfettiBurst } from "@/components/celebration/confetti-burst";
import { PodiumReveal } from "@/components/celebration/podium-reveal";

// Dynamically import event-specific animations (code-split)
const VaultAnimation = dynamic(
  () => import("@/components/celebration/vault-animation").then((m) => m.VaultAnimation),
  { ssr: false }
);
const BarsAnimation = dynamic(
  () => import("@/components/celebration/bars-animation").then((m) => m.BarsAnimation),
  { ssr: false }
);
const BeamAnimation = dynamic(
  () => import("@/components/celebration/beam-animation").then((m) => m.BeamAnimation),
  { ssr: false }
);
const FloorAnimation = dynamic(
  () => import("@/components/celebration/floor-animation").then((m) => m.FloorAnimation),
  { ssr: false }
);
const AllAroundAnimation = dynamic(
  () =>
    import("@/components/celebration/all-around-animation").then(
      (m) => m.AllAroundAnimation
    ),
  { ssr: false }
);

const EVENT_ANIMATIONS: Record<string, React.ComponentType> = {
  vault: VaultAnimation,
  bars: BarsAnimation,
  beam: BeamAnimation,
  floor: FloorAnimation,
  aa: AllAroundAnimation,
};

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

  const meetParts = meetName.split(" - ");
  const state = meetParts[1]?.replace(/^\d{4}\s*/, "") || "";

  // Determine primary event for animation (first event, or AA if they won AA)
  const primaryEvent =
    events.find((e) => e.event === "aa")?.event ||
    events[0]?.event ||
    "aa";
  const EventAnimation = EVENT_ANIMATIONS[primaryEvent] || AllAroundAnimation;

  useEffect(() => {
    const confettiTimer = setTimeout(() => setShowConfetti(true), 400);
    const ctaTimer = setTimeout(() => setShowCTA(true), 2500);

    // Track scan (fire-and-forget)
    fetch("/api/celebrate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    }).catch(() => {});

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

      {/* Event-specific animation */}
      <EventAnimation />

      <PodiumReveal
        athleteName={athleteName}
        events={events}
        level={level}
        state={state}
        gym={gym}
      />

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

      <p className="absolute bottom-6 text-gray-600 text-xs">
        thestatechampion.com
      </p>
    </div>
  );
}

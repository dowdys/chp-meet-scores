"use client";

import { useState, useCallback } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import type { ChampionshipEvent } from "@/lib/utils";

const CelebrationOverlay = dynamic(
  () =>
    import("@/components/celebration/celebration-overlay").then(
      (mod) => mod.CelebrationOverlay
    ),
  { ssr: false }
);

interface CelebrationPageClientProps {
  token: string;
  athleteName: string;
  gym: string;
  level: string;
  meetName: string;
  events: ChampionshipEvent[];
}

export function CelebrationPageClient({
  token,
  athleteName,
  gym,
  level,
  meetName,
  events,
}: CelebrationPageClientProps) {
  const [complete, setComplete] = useState(false);

  const meetParts = meetName.split(" - ");
  const state = meetParts[1]?.replace(/^\d{4}\s*/, "") || "";

  const orderParams = new URLSearchParams({
    name: athleteName,
    gym,
    meet: meetName,
    level,
    state,
  });
  const orderUrl = `/order?${orderParams.toString()}`;

  const handleComplete = useCallback(() => {
    setComplete(true);
  }, []);

  if (complete) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center px-6 py-12 bg-gradient-to-b from-gray-900 to-black text-white relative">
        <div className="text-center space-y-6 max-w-md">
          <h1 className="text-3xl md:text-4xl font-bold">{athleteName}</h1>
          <p className="text-amber-400">{gym}</p>
          <p className="text-sm text-amber-200/70">
            Level {level} &bull; {state} State Champion
          </p>
          <Link
            href={orderUrl}
            className="inline-block bg-amber-500 text-black px-10 py-4 rounded-xl text-xl font-bold hover:bg-amber-400 transition shadow-lg shadow-amber-900/30"
          >
            Order Your Championship Shirt &rarr;
          </Link>
        </div>
        <p className="absolute bottom-6 text-gray-600 text-xs">
          thestatechampion.com
        </p>
      </div>
    );
  }

  return (
    <CelebrationOverlay
      token={token}
      athleteName={athleteName}
      gym={gym}
      level={level}
      state={state}
      meetName={meetName}
      events={events}
      onComplete={handleComplete}
      orderUrl={orderUrl}
    />
  );
}

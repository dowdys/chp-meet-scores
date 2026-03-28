"use client";

import { m } from "framer-motion";
import { EVENT_DISPLAY, type GymEvent, type ChampionshipEvent } from "@/lib/utils";

interface PodiumRevealProps {
  athleteName: string;
  events: ChampionshipEvent[];
  level: string;
  state: string;
  gym: string;
}

export function PodiumReveal({
  athleteName,
  events,
  level,
  state,
  gym,
}: PodiumRevealProps) {
  return (
    <div className="text-center space-y-5 relative">
      {/* Golden glow — CSS radial-gradient (GPU-composited, not SVG feGaussianBlur) */}
      <div
        className="absolute inset-0 -top-20 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse at center 60%, rgba(255,215,0,0.15) 0%, rgba(255,193,7,0.06) 40%, transparent 70%)",
        }}
      />

      {/* Podium */}
      <m.div
        initial={{ y: 60, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.1, type: "spring", stiffness: 120, damping: 14 }}
        className="relative mx-auto"
      >
        <svg viewBox="0 0 120 60" className="w-32 h-16 mx-auto">
          <rect x="10" y="10" width="100" height="50" rx="4" fill="#FFD700" opacity={0.8} />
          <rect x="15" y="14" width="90" height="42" rx="3" fill="#FFC107" opacity={0.4} />
          <text x="60" y="42" textAnchor="middle" fill="#000" fontSize="20" fontWeight="bold" fontFamily="inherit">1</text>
        </svg>

        {/* Medal */}
        <m.div
          className="absolute -top-8 left-1/2 -translate-x-1/2"
          initial={{ opacity: 0, scale: 0 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.6, type: "spring", stiffness: 200, damping: 12 }}
        >
          <svg viewBox="0 0 40 50" className="w-8 h-10">
            <path d="M14,0 L20,18 L26,0" fill="#FFC107" opacity={0.7} />
            <circle cx="20" cy="28" r="12" fill="#FFD700" />
            <circle cx="20" cy="28" r="9" fill="#FFC107" opacity={0.6} />
            <text x="20" y="33" textAnchor="middle" fill="#000" fontSize="10" fontWeight="bold">&#9733;</text>
          </svg>
        </m.div>
      </m.div>

      {/* Athlete name */}
      <m.h1
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.4, duration: 0.5 }}
        className="text-3xl md:text-5xl font-bold text-white"
      >
        {athleteName}
      </m.h1>

      {/* Gym */}
      <m.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.7 }}
        className="text-lg text-amber-400"
      >
        {gym}
      </m.p>

      {/* Events won */}
      {events.length > 0 && (
        <div className="space-y-2">
          {events.map((evt, i) => (
            <m.div
              key={evt.event}
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.9 + i * 0.15 }}
              className="flex items-center justify-center gap-3 text-white"
            >
              <span className="text-amber-400 text-xl">&#9733;</span>
              <span className="font-semibold">
                {EVENT_DISPLAY[evt.event] || evt.event}
              </span>
              <span className="text-gray-400">
                {evt.score?.toFixed(3) ?? "---"}
              </span>
              {evt.is_tie && (
                <span className="text-xs bg-amber-900/30 px-2 py-0.5 rounded text-amber-200">
                  Co-Champion
                </span>
              )}
            </m.div>
          ))}
        </div>
      )}

      {/* Level + State badge */}
      <m.div
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ delay: 1.3, type: "spring" }}
        className="inline-block bg-amber-900/30 px-6 py-2 rounded-full text-sm text-amber-200"
      >
        Level {level} &bull; {state} State Champion
      </m.div>
    </div>
  );
}

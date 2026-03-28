"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { LazyMotion, domAnimation, AnimatePresence, m, useReducedMotion } from "framer-motion";
import Link from "next/link";
import { ConfettiBurst } from "./confetti-burst";
import { PodiumReveal } from "./podium-reveal";
import { VaultAnimation } from "./vault-animation";
import { BarsAnimation } from "./bars-animation";
import { BeamAnimation } from "./beam-animation";
import { FloorAnimation } from "./floor-animation";
import { AllAroundAnimation } from "./all-around-animation";
import { EVENT_DISPLAY, type GymEvent, type ChampionshipEvent } from "@/lib/utils";

const EVENT_ANIMATIONS: Record<GymEvent, React.ComponentType<{ isActive?: boolean }>> = {
  vault: VaultAnimation,
  bars: BarsAnimation,
  beam: BeamAnimation,
  floor: FloorAnimation,
  aa: AllAroundAnimation,
};

type CelebrationStage = "intro" | "reveal";

interface CelebrationOverlayProps {
  token: string;
  athleteName: string;
  gym: string;
  level: string;
  state: string;
  meetName: string;
  events: ChampionshipEvent[];
  onComplete: () => void;
  orderUrl: string;
}

function StaticCelebrationCard({
  athleteName,
  gym,
  level,
  state,
  events,
  orderUrl,
}: Omit<CelebrationOverlayProps, "token" | "meetName" | "onComplete">) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center px-6 bg-gradient-to-b from-gray-900 to-black text-white">
      <div className="max-w-md mx-auto text-center space-y-6 p-8 rounded-2xl border border-amber-900/30">
        <svg viewBox="0 0 40 50" className="w-12 h-14 mx-auto">
          <path d="M14,0 L20,18 L26,0" fill="#FFC107" opacity={0.7} />
          <circle cx="20" cy="28" r="12" fill="#FFD700" />
          <circle cx="20" cy="28" r="9" fill="#FFC107" opacity={0.6} />
          <text x="20" y="33" textAnchor="middle" fill="#000" fontSize="10" fontWeight="bold">&#9733;</text>
        </svg>
        <h1 className="text-3xl md:text-4xl font-bold">{athleteName}</h1>
        <p className="text-amber-400">{gym}</p>
        {events.length > 0 && (
          <div className="space-y-1">
            {events.map((evt) => (
              <div key={evt.event} className="flex items-center justify-center gap-2">
                <span className="text-amber-400">&#9733;</span>
                <span>{EVENT_DISPLAY[evt.event] || evt.event}</span>
                <span className="text-gray-400">{evt.score?.toFixed(3) ?? "---"}</span>
              </div>
            ))}
          </div>
        )}
        <p className="text-sm text-amber-200/70">
          Level {level} &bull; {state} State Champion
        </p>
        <Link
          href={orderUrl}
          className="inline-block bg-amber-500 text-black px-8 py-3 rounded-xl text-lg font-bold hover:bg-amber-400 transition shadow-lg shadow-amber-900/30"
        >
          Order Your Championship Shirt &rarr;
        </Link>
      </div>
    </div>
  );
}

export function CelebrationOverlay({
  token,
  athleteName,
  gym,
  level,
  state,
  meetName,
  events,
  onComplete,
  orderUrl,
}: CelebrationOverlayProps) {
  const prefersReducedMotion = useReducedMotion();
  const [stage, setStage] = useState<CelebrationStage>("intro");
  const [showConfetti, setShowConfetti] = useState(false);
  const [showCTA, setShowCTA] = useState(false);
  const cancelRef = useRef({ cancelled: false });
  const hasCompletedRef = useRef(false);
  const onCompleteRef = useRef(onComplete);
  const ctaRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);

  // Determine primary event for animation
  const primaryEvent: GymEvent =
    (events.find((e) => e.event === "aa")?.event as GymEvent) ||
    (events[0]?.event as GymEvent) ||
    "aa";
  const EventAnimation = EVENT_ANIMATIONS[primaryEvent] || AllAroundAnimation;

  const handleComplete = useCallback(() => {
    if (hasCompletedRef.current) return;
    hasCompletedRef.current = true;
    cancelRef.current.cancelled = true;
    onCompleteRef.current();
  }, []);

  // Check for replay via sessionStorage
  useEffect(() => {
    const key = `celebrated-${token}`;
    if (sessionStorage.getItem(key)) {
      handleComplete();
      return;
    }
    sessionStorage.setItem(key, "1");
  }, [token, handleComplete]);

  // Track scan (fire-and-forget)
  useEffect(() => {
    fetch("/api/celebrate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    }).catch(() => {});
  }, [token]);

  // Animation timeline — all timers from single origin, cancellable
  useEffect(() => {
    if (prefersReducedMotion || hasCompletedRef.current) return;

    const cancel = cancelRef.current;
    cancel.cancelled = false;

    const timers = [
      setTimeout(() => {
        if (cancel.cancelled) return;
        setStage("reveal");
      }, 2000),
      setTimeout(() => {
        if (cancel.cancelled) return;
        setShowConfetti(true);
      }, 3500),
      setTimeout(() => {
        if (cancel.cancelled) return;
        setShowCTA(true);
      }, 5000),
      setTimeout(() => {
        if (cancel.cancelled) return;
        handleComplete();
      }, 6500),
    ];

    return () => {
      cancel.cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [prefersReducedMotion, handleComplete]);

  // Escape key handler
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleComplete();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [handleComplete]);

  // Focus CTA when it appears
  useEffect(() => {
    if (showCTA && ctaRef.current) {
      ctaRef.current.focus();
    }
  }, [showCTA]);

  // Reduced motion: show static card
  if (prefersReducedMotion) {
    return (
      <StaticCelebrationCard
        athleteName={athleteName}
        gym={gym}
        level={level}
        state={state}
        events={events}
        orderUrl={orderUrl}
      />
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center px-6 overflow-hidden"
      style={{
        background: "radial-gradient(ellipse at center, #1a1a2e 0%, #0a0a0a 50%, #000 100%)",
      }}
      role="dialog"
      aria-modal="true"
      aria-label={`Championship celebration for ${athleteName}`}
    >
      <LazyMotion features={domAnimation} strict>
        <ConfettiBurst trigger={showConfetti} />

        <AnimatePresence mode="wait">
          {stage === "intro" && (
            <m.div
              key="intro"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="flex flex-col items-center justify-center"
            >
              <EventAnimation isActive />
            </m.div>
          )}

          {stage === "reveal" && (
            <m.div
              key="reveal"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.4 }}
              className="flex flex-col items-center justify-center max-w-lg mx-auto"
            >
              <PodiumReveal
                athleteName={athleteName}
                events={events}
                level={level}
                state={state}
                gym={gym}
              />

              {/* CTA button */}
              <m.div
                className="mt-10"
                initial={{ opacity: 0, y: 20 }}
                animate={{
                  opacity: showCTA ? 1 : 0,
                  y: showCTA ? 0 : 20,
                }}
                transition={{ duration: 0.5 }}
              >
                <Link
                  ref={ctaRef}
                  href={orderUrl}
                  className="inline-block bg-amber-500 text-black px-10 py-4 rounded-xl text-xl font-bold hover:bg-amber-400 transition shadow-lg shadow-amber-900/30"
                >
                  Order Your Championship Shirt &rarr;
                </Link>
              </m.div>
            </m.div>
          )}
        </AnimatePresence>
      </LazyMotion>

      {/* Skip button — always visible */}
      <button
        onClick={handleComplete}
        className="fixed bottom-8 left-1/2 -translate-x-1/2 text-gray-500 hover:text-gray-300 text-sm transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center z-[51]"
        aria-label="Skip celebration"
      >
        Skip
      </button>

      <p className="fixed bottom-2 left-1/2 -translate-x-1/2 text-gray-700 text-xs">
        thestatechampion.com
      </p>
    </div>
  );
}

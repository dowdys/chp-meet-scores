"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { LazyMotion, domAnimation, AnimatePresence, m, useReducedMotion } from "framer-motion";
import Link from "next/link";
import confetti from "canvas-confetti";
import { ConfettiBurst } from "./confetti-burst";
import { PodiumReveal } from "./podium-reveal";
import { EventAnimation } from "./event-animation";
import { EVENT_DISPLAY, type GymEvent, type ChampionshipEvent } from "@/lib/utils";

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

  // Determine primary event for animation
  const primaryEvent: GymEvent =
    events.find((e) => e.event === "aa")?.event ??
    events[0]?.event ??
    "aa";

  const handleComplete = useCallback(() => {
    if (hasCompletedRef.current) return;
    hasCompletedRef.current = true;
    cancelRef.current.cancelled = true;
    confetti.reset();
    onComplete();
  }, [onComplete]);

  // P1 #1 fix: Read-only sessionStorage check (separate from write)
  useEffect(() => {
    if (sessionStorage.getItem(`cel-${token.slice(0, 8)}`)) {
      handleComplete();
    }
  }, [token, handleComplete]);

  // P1 #3 fix: Reduced motion skips animation entirely
  useEffect(() => {
    if (prefersReducedMotion) {
      handleComplete();
    }
  }, [prefersReducedMotion, handleComplete]);

  // Track scan (fire-and-forget)
  useEffect(() => {
    fetch("/api/celebrate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    }).catch(() => {});
  }, [token]);

  // Animation timeline — P2 #7 fix: fresh cancel token per mount
  useEffect(() => {
    if (prefersReducedMotion || hasCompletedRef.current) return;

    // Write sessionStorage only when timeline actually starts (P1 #1 fix)
    sessionStorage.setItem(`cel-${token.slice(0, 8)}`, "1");

    const cancel = { cancelled: false };
    cancelRef.current = cancel;

    const timers = [
      setTimeout(() => {
        if (cancel.cancelled) return;
        setStage("reveal");
      }, 2000),
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
  }, [prefersReducedMotion, handleComplete, token]);

  // Escape key handler
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleComplete();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [handleComplete]);

  // P2 #6 fix: Trigger confetti from reveal animation completion, not setTimeout
  const handleRevealAnimationStart = useCallback(() => {
    if (!cancelRef.current.cancelled) {
      setShowConfetti(true);
    }
  }, []);

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
              <EventAnimation event={primaryEvent} />
            </m.div>
          )}

          {stage === "reveal" && (
            <m.div
              key="reveal"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.4 }}
              onAnimationComplete={handleRevealAnimationStart}
              className="flex flex-col items-center justify-center max-w-lg mx-auto"
            >
              <PodiumReveal
                athleteName={athleteName}
                events={events}
                level={level}
                state={state}
                gym={gym}
              />

              {/* CTA button — focus managed via onAnimationComplete */}
              <m.div
                className="mt-10"
                initial={{ opacity: 0, y: 20 }}
                animate={{
                  opacity: showCTA ? 1 : 0,
                  y: showCTA ? 0 : 20,
                }}
                transition={{ duration: 0.5 }}
                onAnimationComplete={() => {
                  if (showCTA) {
                    const el = document.querySelector<HTMLAnchorElement>("[data-cta]");
                    el?.focus();
                  }
                }}
              >
                <Link
                  data-cta
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

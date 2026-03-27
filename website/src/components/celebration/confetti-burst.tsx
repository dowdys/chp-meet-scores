"use client";

import { useEffect } from "react";
import confetti from "canvas-confetti";

export function ConfettiBurst({ trigger }: { trigger: boolean }) {
  useEffect(() => {
    if (!trigger) return;

    // Check for reduced motion preference
    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    if (prefersReducedMotion) return;

    // Check for slow connection
    const conn = (navigator as { connection?: { effectiveType?: string; saveData?: boolean } }).connection;
    const isSlow =
      conn?.saveData ||
      conn?.effectiveType === "2g" ||
      conn?.effectiveType === "slow-2g";
    const particleCount = isSlow ? 30 : 80;

    // Gold + white confetti burst
    const colors = ["#FFD700", "#FFC107", "#FFFFFF", "#FFE082"];

    confetti({
      particleCount,
      spread: 70,
      origin: { y: 0.6 },
      colors,
      disableForReducedMotion: true,
    });

    // Second burst slightly delayed for a richer effect
    setTimeout(() => {
      confetti({
        particleCount: Math.floor(particleCount * 0.6),
        spread: 100,
        origin: { y: 0.5, x: 0.3 },
        colors,
        disableForReducedMotion: true,
      });
      confetti({
        particleCount: Math.floor(particleCount * 0.6),
        spread: 100,
        origin: { y: 0.5, x: 0.7 },
        colors,
        disableForReducedMotion: true,
      });
    }, 300);
  }, [trigger]);

  return null;
}

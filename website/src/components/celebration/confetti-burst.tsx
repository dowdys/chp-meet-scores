"use client";

import { useEffect } from "react";
import confetti from "canvas-confetti";

export function ConfettiBurst({ trigger }: { trigger: boolean }) {
  useEffect(() => {
    if (!trigger) return;

    const colors = ["#FFD700", "#FFC107", "#FFFFFF", "#FFE082"];

    confetti({
      particleCount: 80,
      spread: 70,
      origin: { y: 0.6 },
      colors,
      disableForReducedMotion: true,
    });

    const burstTimer = setTimeout(() => {
      confetti({
        particleCount: 48,
        spread: 100,
        origin: { y: 0.5, x: 0.3 },
        colors,
        disableForReducedMotion: true,
      });
      confetti({
        particleCount: 48,
        spread: 100,
        origin: { y: 0.5, x: 0.7 },
        colors,
        disableForReducedMotion: true,
      });
    }, 300);

    return () => {
      clearTimeout(burstTimer);
      confetti.reset();
    };
  }, [trigger]);

  return null;
}

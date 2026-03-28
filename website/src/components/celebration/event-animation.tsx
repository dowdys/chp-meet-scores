"use client";

import { m } from "framer-motion";
import { EVENT_ANIMATION_DATA } from "./event-animation-data";
import type { GymEvent } from "@/lib/utils";

const AA_LABELS = ["Vault", "Bars", "Beam", "Floor"];

interface EventAnimationProps {
  event: GymEvent;
  onComplete?: () => void;
}

export function EventAnimation({ event, onComplete }: EventAnimationProps) {
  const data = EVENT_ANIMATION_DATA[event];
  const Apparatus = data.apparatus;
  const isAA = event === "aa";

  return (
    <div className="relative w-full h-64 flex items-center justify-center">
      <svg viewBox="0 0 250 220" className="w-full h-full max-w-md">
        {Apparatus && <Apparatus />}

        {/* Silhouette poses crossfade */}
        {data.poses.map((d, i) => (
          <m.g
            key={i} // Static array — index key is stable
            initial={{ opacity: 0 }}
            animate={{ opacity: [0, 1, 1, 0] }}
            transition={{
              opacity: { times: [0, 0.05, 0.85, 1], duration: 0.5, delay: i * 0.5 },
            }}
            onAnimationComplete={i === data.poses.length - 1 ? onComplete : undefined}
          >
            <path d={d} fill={data.fill} opacity={0.95} />
          </m.g>
        ))}

        {/* Gold sparkle particles */}
        {data.sparkles?.map((s, i) => (
          <m.circle
            key={`spark-${i}`}
            cx={s.cx} cy={s.cy} r={2}
            fill="#FFD700"
            initial={{ opacity: 0, scale: 0 }}
            animate={{ opacity: [0, 1, 0], scale: [0, 1.5, 0] }}
            transition={{ duration: 0.4, delay: s.delay }}
          />
        ))}

        {/* AA: gold flash between poses + event labels */}
        {isAA && (
          <>
            {[0.5, 1.0, 1.5].map((delay, i) => (
              <m.rect
                key={`flash-${i}`}
                x="0" y="0" width="250" height="220"
                fill="#FFD700"
                initial={{ opacity: 0 }}
                animate={{ opacity: [0, 0.12, 0] }}
                transition={{ duration: 0.2, delay }}
              />
            ))}
            {AA_LABELS.map((label, i) => (
              <m.text
                key={`label-${i}`}
                x="125" y="215"
                textAnchor="middle"
                fill="#FFD700"
                fontSize="10"
                fontFamily="inherit"
                initial={{ opacity: 0 }}
                animate={{ opacity: [0, 0.6, 0.6, 0] }}
                transition={{
                  opacity: { times: [0, 0.1, 0.85, 1], duration: 0.5, delay: i * 0.5 },
                }}
              >
                {label}
              </m.text>
            ))}
          </>
        )}
      </svg>
    </div>
  );
}

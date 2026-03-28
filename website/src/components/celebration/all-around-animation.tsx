"use client";

import { m } from "framer-motion";

// One signature pose from each event — gold fill distinguishes the AA champion
const POSES = [
  // Vault flight
  "M125,96 C127,90 130,84 130,80 A7,7 0 1,0 118,80 C118,84 121,90 123,96 L113,106 L101,118 C98,122 96,126 96,130 L106,120 L118,108 L126,100 L134,108 L146,120 C150,126 154,132 156,136 L148,124 L136,112 L128,104 L124,116 C122,126 120,138 120,144 L124,130 L126,116 L130,130 C132,140 134,150 134,156 L130,140 Z",
  // Bars swing
  "M126,78 C128,74 130,70 130,68 A6,6 0 1,0 120,68 C120,70 122,74 124,78 L112,90 L100,108 C96,116 96,126 100,136 L104,152 C106,162 110,170 114,174 L120,168 L114,152 L110,136 L114,122 L122,108 L128,92 Z",
  // Beam leap
  "M126,122 C128,118 130,112 130,108 A6,6 0 1,0 120,108 C120,112 122,118 124,122 L108,132 C100,136 92,140 88,142 L98,138 L112,132 L122,126 L132,126 L142,132 C148,136 156,142 162,146 L152,140 L140,134 Z",
  // Floor landing
  "M126,200 L126,178 C126,168 126,158 125,150 L124,138 C124,132 123,126 122,124 A6,6 0 1,1 132,124 C131,126 130,132 129,138 L127,148 L118,130 L112,116 C110,112 108,108 107,106 L112,114 L120,132 L128,150 L134,132 L140,116 C142,112 144,108 146,106 L142,114 L134,132 Z",
];

const POSE_LABELS = ["Vault", "Bars", "Beam", "Floor"];

export function AllAroundAnimation({ isActive = true }: { isActive?: boolean }) {
  if (!isActive) return null;

  return (
    <div className="relative w-full h-64 flex items-center justify-center">
      <svg viewBox="0 0 250 220" className="w-full h-full max-w-md">
        {POSES.map((d, i) => (
          <m.g
            key={i}
            initial={{ opacity: 0 }}
            animate={{ opacity: [0, 1, 1, 0] }}
            transition={{
              opacity: { times: [0, 0.05, 0.85, 1], duration: 0.5, delay: i * 0.5 },
            }}
          >
            <path d={d} fill="#FFD700" opacity={0.95} />
          </m.g>
        ))}
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
        {POSE_LABELS.map((label, i) => (
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
      </svg>
    </div>
  );
}

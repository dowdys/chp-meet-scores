"use client";

import { m } from "framer-motion";

function BeamApparatus() {
  return (
    <g opacity={0.3}>
      <rect x="40" y="168" width="170" height="4" rx="1" fill="#FFD700" opacity={0.5} />
      <line x1="65" y1="172" x2="60" y2="200" stroke="#FFD700" strokeWidth="1.5" opacity={0.4} />
      <line x1="185" y1="172" x2="190" y2="200" stroke="#FFD700" strokeWidth="1.5" opacity={0.4} />
    </g>
  );
}

const POSES = [
  // Standing — graceful arms extended
  "M82,168 L82,150 C82,142 82,134 82,128 C83,122 84,116 85,112 A6,6 0 1,0 77,112 C78,116 80,122 80,128 L78,120 L70,108 C68,104 66,102 64,101 L70,106 L78,118 L82,128 L86,118 L94,106 C96,102 98,100 100,99 L96,104 L88,116 Z",
  // Split leap — mid-air
  "M118,132 C120,128 122,122 122,118 A6,6 0 1,0 114,118 C114,122 116,128 118,132 L106,140 L94,150 C90,153 86,155 84,156 L92,152 L106,144 L116,136 L122,136 L134,144 C140,148 146,153 150,156 L144,152 L132,144 Z",
  // Back tuck — tucked rotation
  "M156,138 C158,134 160,128 160,124 A6,6 0 1,0 150,124 C150,128 152,132 154,136 L150,146 C148,152 150,158 154,162 L160,158 C162,154 162,148 158,144 Z",
  // Dismount landing
  "M212,200 L212,178 C212,168 212,158 211,150 L210,138 C210,132 209,126 208,124 A6,6 0 1,1 218,124 C217,126 216,132 215,138 L213,148 L206,130 L200,116 C198,112 196,108 195,106 L200,114 L208,132 L214,150 L220,132 L226,116 C228,112 230,108 232,106 L228,114 L220,132 Z",
];

export function BeamAnimation({ isActive = true }: { isActive?: boolean }) {
  if (!isActive) return null;

  return (
    <div className="relative w-full h-64 flex items-center justify-center">
      <svg viewBox="0 0 250 220" className="w-full h-full max-w-md">
        <BeamApparatus />
        {POSES.map((d, i) => (
          <m.g
            key={i}
            initial={{ opacity: 0 }}
            animate={{ opacity: [0, 1, 1, 0] }}
            transition={{
              opacity: { times: [0, 0.05, 0.85, 1], duration: 0.5, delay: i * 0.5 },
            }}
          >
            <path d={d} fill="white" opacity={0.95} />
          </m.g>
        ))}
      </svg>
    </div>
  );
}

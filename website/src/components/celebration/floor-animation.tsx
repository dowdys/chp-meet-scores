"use client";

import { m } from "framer-motion";

function FloorApparatus() {
  return (
    <g opacity={0.2}>
      <polyline points="30,30 30,42 42,42" fill="none" stroke="#FFD700" strokeWidth="1" />
      <polyline points="220,30 220,42 208,42" fill="none" stroke="#FFD700" strokeWidth="1" />
      <polyline points="30,200 30,188 42,188" fill="none" stroke="#FFD700" strokeWidth="1" />
      <polyline points="220,200 220,188 208,188" fill="none" stroke="#FFD700" strokeWidth="1" />
      <line x1="45" y1="185" x2="205" y2="45" stroke="#FFD700" strokeWidth="0.5" strokeDasharray="6 4" opacity={0.4} />
    </g>
  );
}

const POSES = [
  // Opening pose — dramatic, one arm up
  "M62,200 L62,178 C62,168 62,158 62,150 L62,138 C62,132 63,126 64,122 A6,6 0 1,0 56,122 C57,126 58,130 60,134 L56,122 L48,108 C46,104 44,100 42,98 L48,104 L56,116 L60,130 L64,118 L70,104 C72,98 73,92 73,88 L72,96 L68,110 Z",
  // Round-off — inverted
  "M112,128 C114,122 116,116 116,112 A6,6 0 1,0 106,112 C106,116 108,122 110,128 L106,108 L100,86 C98,78 100,70 104,66 L108,72 L112,86 L114,72 L118,64 C120,58 122,56 124,55 L120,62 L116,76 Z",
  // Layout in air — stretched
  "M158,82 C160,76 162,70 162,66 A6,6 0 1,0 152,66 C152,70 154,76 156,82 L146,90 L134,102 C130,106 128,110 128,114 L136,108 L148,96 L156,86 L164,96 L176,108 C180,114 182,118 184,122 L178,114 L166,102 L158,92 L154,104 C152,114 150,124 150,130 L154,118 L158,104 L162,118 C164,128 166,138 166,142 L162,128 Z",
  // Stick landing
  "M200,200 L200,178 C200,168 200,158 199,150 L198,138 C198,132 197,126 196,124 A6,6 0 1,1 206,124 C205,126 204,132 203,138 L201,148 L194,130 L188,116 C186,112 184,108 183,106 L188,114 L196,132 L202,150 L208,132 L214,116 C216,112 218,108 220,106 L216,114 L208,132 Z",
];

export function FloorAnimation({ isActive = true }: { isActive?: boolean }) {
  if (!isActive) return null;

  return (
    <div className="relative w-full h-64 flex items-center justify-center">
      <svg viewBox="0 0 250 220" className="w-full h-full max-w-md">
        <FloorApparatus />
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

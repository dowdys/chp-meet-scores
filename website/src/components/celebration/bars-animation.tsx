"use client";

import { m } from "framer-motion";

function BarsApparatus() {
  return (
    <g opacity={0.3}>
      <line x1="80" y1="70" x2="170" y2="70" stroke="#FFD700" strokeWidth="2" />
      <line x1="85" y1="130" x2="165" y2="130" stroke="#FFD700" strokeWidth="2" />
      <line x1="78" y1="70" x2="73" y2="200" stroke="#FFD700" strokeWidth="1.5" opacity={0.4} />
      <line x1="172" y1="70" x2="177" y2="200" stroke="#FFD700" strokeWidth="1.5" opacity={0.4} />
    </g>
  );
}

const POSES = [
  // Kip mount — piked hang
  "M126,74 C126,72 128,70 130,69 A6,6 0 1,0 120,69 C122,70 124,72 126,74 L122,86 L116,104 C114,112 116,120 120,126 L128,132 L134,124 C136,118 136,110 132,102 L126,86 Z",
  // Giant swing — full extension
  "M126,72 C126,70 128,68 130,67 A6,6 0 1,0 120,67 C122,68 124,70 126,72 L114,82 L102,100 C98,108 98,118 100,128 L102,148 C104,158 108,166 112,170 L118,164 L112,148 L108,132 L112,118 L120,102 L126,86 Z",
  // Release — tucked in air
  "M130,98 C132,94 134,90 134,86 A6,6 0 1,0 124,86 C124,90 126,94 128,98 L124,108 C122,114 124,120 128,124 L134,120 C136,116 136,110 132,106 Z",
  // Stick landing
  "M195,200 L194,178 C194,168 193,158 192,150 L191,138 C190,132 189,126 188,124 A6,6 0 1,1 198,124 C197,126 196,132 195,138 L193,148 L186,130 L180,116 C178,112 176,108 175,106 L180,114 L188,132 L194,150 L200,132 L206,116 C208,112 210,108 212,106 L208,114 L200,132 Z",
];

export function BarsAnimation({ isActive = true }: { isActive?: boolean }) {
  if (!isActive) return null;

  return (
    <div className="relative w-full h-64 flex items-center justify-center">
      <svg viewBox="0 0 250 220" className="w-full h-full max-w-md">
        <BarsApparatus />
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

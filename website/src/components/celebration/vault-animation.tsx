"use client";

import { m } from "framer-motion";

function VaultApparatus() {
  return (
    <g opacity={0.3}>
      <line x1="20" y1="195" x2="115" y2="195" stroke="#FFD700" strokeWidth="1" strokeDasharray="4 3" />
      <rect x="125" y="178" width="28" height="7" rx="2" fill="#FFD700" opacity={0.5} />
      <rect x="133" y="185" width="4" height="15" fill="#FFD700" opacity={0.3} />
      <rect x="143" y="185" width="4" height="15" fill="#FFD700" opacity={0.3} />
    </g>
  );
}

const POSES = [
  // Running approach
  "M52,140 C52,136 54,130 56,126 C58,121 59,115 59,112 A7,7 0 1,0 49,112 C49,115 50,120 52,124 L48,138 L40,158 C38,164 42,170 46,175 L54,192 C56,196 58,198 60,200 L50,168 L56,148 L64,166 L70,180 C72,186 73,192 72,196 L65,170 L58,148 L60,135 L72,122 C74,120 75,118 74,116 Z",
  // Handspring contact
  "M140,180 C138,177 137,174 137,171 L136,160 C135,152 137,144 140,138 L144,128 C146,122 147,116 146,112 A6,6 0 1,0 136,112 C136,116 138,122 140,126 L142,140 L138,152 L130,138 L124,124 C122,120 120,116 119,114 L126,132 L136,155 L144,148 L152,132 L158,118 C160,114 161,110 160,108 L154,125 L146,145 Z",
  // Flight
  "M158,108 C160,104 162,98 162,94 A7,7 0 1,0 148,94 C148,98 150,104 152,108 L146,116 C142,120 138,124 135,127 L130,132 L144,120 L154,110 L164,120 L178,132 C180,134 182,136 184,138 L170,126 L158,114 L154,124 C152,132 150,142 150,148 L154,136 L158,122 L162,132 C164,140 166,150 166,156 L163,142 Z",
  // Stick landing
  "M192,200 L192,180 C192,170 192,160 191,152 L190,140 C190,136 189,130 188,126 A6,6 0 1,1 198,126 C197,130 196,136 195,140 L193,150 L186,132 L180,118 C178,114 176,110 175,108 L180,116 L188,134 L194,150 L200,134 L206,118 C208,114 210,110 212,108 L208,116 L200,134 Z",
];

export function VaultAnimation({ isActive = true }: { isActive?: boolean }) {
  if (!isActive) return null;

  return (
    <div className="relative w-full h-64 flex items-center justify-center">
      <svg viewBox="0 0 250 220" className="w-full h-full max-w-md">
        <VaultApparatus />
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
        {[
          { cx: 155, cy: 95, delay: 1.1 },
          { cx: 170, cy: 100, delay: 1.2 },
          { cx: 148, cy: 105, delay: 1.3 },
          { cx: 175, cy: 90, delay: 1.15 },
        ].map((s, i) => (
          <m.circle
            key={`spark-${i}`}
            cx={s.cx} cy={s.cy} r={2}
            fill="#FFD700"
            initial={{ opacity: 0, scale: 0 }}
            animate={{ opacity: [0, 1, 0], scale: [0, 1.5, 0] }}
            transition={{ duration: 0.4, delay: s.delay }}
          />
        ))}
      </svg>
    </div>
  );
}

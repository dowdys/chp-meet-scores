"use client";

import { motion } from "framer-motion";
import { EVENT_DISPLAY, type GymEvent } from "@/lib/utils";

interface PodiumRevealProps {
  athleteName: string;
  events: Array<{ event: string; score: number; is_tie: boolean }>;
  level: string;
  state: string;
  gym: string;
}

export function PodiumReveal({
  athleteName,
  events,
  level,
  state,
  gym,
}: PodiumRevealProps) {
  return (
    <div className="text-center space-y-6">
      {/* Podium icon */}
      <motion.div
        initial={{ scale: 0, rotate: -10 }}
        animate={{ scale: 1, rotate: 0 }}
        transition={{ delay: 0.2, type: "spring", stiffness: 200, damping: 15 }}
        className="text-7xl"
      >
        🏆
      </motion.div>

      {/* Athlete name */}
      <motion.h1
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.5, duration: 0.6 }}
        className="text-4xl md:text-5xl font-bold text-white"
      >
        {athleteName}
      </motion.h1>

      {/* Gym */}
      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.8 }}
        className="text-lg text-red-400"
      >
        {gym}
      </motion.p>

      {/* Events won */}
      <div className="space-y-2">
        {events.map((evt, i) => (
          <motion.div
            key={evt.event}
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 1.0 + i * 0.15 }}
            className="flex items-center justify-center gap-3 text-white"
          >
            <span className="text-red-500 text-xl">★</span>
            <span className="font-semibold">
              {EVENT_DISPLAY[evt.event as GymEvent] || evt.event}
            </span>
            <span className="text-gray-400">
              {evt.score.toFixed(3)}
            </span>
            {evt.is_tie && (
              <span className="text-xs bg-gray-100 dark:bg-white/10 px-2 py-0.5 rounded">
                Co-Champion
              </span>
            )}
          </motion.div>
        ))}
      </div>

      {/* Level + State badge */}
      <motion.div
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ delay: 1.5, type: "spring" }}
        className="inline-block bg-gray-100 dark:bg-white/10 backdrop-blur px-6 py-2 rounded-full text-sm text-gray-300"
      >
        Level {level} • {state} State Champion
      </motion.div>
    </div>
  );
}

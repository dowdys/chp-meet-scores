"use client";

import { motion } from "framer-motion";

export function FloorAnimation() {
  return (
    <motion.div
      className="flex flex-col items-center"
      initial={ { opacity: 0 } }
      animate={ { opacity: 1 } }
      transition={ { duration: 0.5 } }
    >
      <motion.div
        className="text-6xl mb-4"
        initial={ { scale: 0, rotate: -20 } }
        animate={ { scale: 1, rotate: 0 } }
        transition={ { delay: 0.2, type: "spring", stiffness: 200, damping: 12 } }
      >
        🤸
      </motion.div>
      <motion.p
        className="text-sm text-red-400/70 italic"
        initial={ { opacity: 0, y: 10 } }
        animate={ { opacity: 1, y: 0 } }
        transition={ { delay: 0.6 } }
      >
        Explosive tumbling, artistic expression, clean finish
      </motion.p>
    </motion.div>
  );
}

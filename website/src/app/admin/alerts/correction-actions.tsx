"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  applyNameCorrection,
  dismissNameCorrection,
} from "@/lib/admin-actions";

export function CorrectionActions({ itemId }: { itemId: number }) {
  const router = useRouter();
  const [loading, setLoading] = useState<"apply" | "dismiss" | null>(null);

  const handleApply = async () => {
    setLoading("apply");
    await applyNameCorrection(itemId);
    router.refresh();
  };

  const handleDismiss = async () => {
    setLoading("dismiss");
    await dismissNameCorrection(itemId);
    router.refresh();
  };

  return (
    <div className="flex gap-2">
      <button
        onClick={handleApply}
        disabled={loading !== null}
        className="bg-green-500 text-white px-3 py-1 rounded text-xs hover:bg-green-600 disabled:opacity-50"
      >
        {loading === "apply" ? "..." : "Apply"}
      </button>
      <button
        onClick={handleDismiss}
        disabled={loading !== null}
        className="bg-gray-200 text-gray-700 px-3 py-1 rounded text-xs hover:bg-gray-300 disabled:opacity-50"
      >
        {loading === "dismiss" ? "..." : "Dismiss"}
      </button>
    </div>
  );
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { updateBatchStatus } from "@/lib/admin-actions";

export function BatchActions({
  batchId,
  currentStatus,
}: {
  batchId: number;
  currentStatus: string;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const nextStatus =
    currentStatus === "queued"
      ? "at_printer"
      : currentStatus === "at_printer"
        ? "returned"
        : null;

  const handleTransition = async () => {
    if (!nextStatus) return;
    setLoading(true);
    await updateBatchStatus(batchId, nextStatus as "at_printer" | "returned");
    setLoading(false);
    router.refresh();
  };

  return (
    <div className="flex items-center gap-2">
      <a
        href={`/api/admin/print-manifest?batchId=${batchId}`}
        target="_blank"
        rel="noopener noreferrer"
        className="bg-gray-100 text-gray-700 px-3 py-1 rounded text-xs hover:bg-gray-200 border border-gray-300"
      >
        Print Manifest
      </a>
      {currentStatus === "returned" && (
        <a
          href={`/api/admin/print-bundle?batchId=${batchId}`}
          target="_blank"
          rel="noopener noreferrer"
          className="bg-purple-600 text-white px-3 py-1 rounded text-xs hover:bg-purple-700"
        >
          Generate Print Bundle
        </a>
      )}
      {nextStatus && (
        <button
          onClick={handleTransition}
          disabled={loading}
          className="bg-blue-500 text-white px-3 py-1 rounded text-xs hover:bg-blue-600 disabled:opacity-50"
        >
          {loading
            ? "..."
            : nextStatus === "at_printer"
              ? "Mark Sent to Printer"
              : "Mark Returned"}
        </button>
      )}
    </div>
  );
}

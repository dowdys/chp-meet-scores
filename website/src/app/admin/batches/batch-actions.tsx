"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { updateBatchStatus, updateBatchReturnedCounts } from "@/lib/admin-actions";
import type { AdminRole } from "@/lib/auth";

interface BatchBack {
  id: number;
  back_id: number;
  shirt_count: number;
  returned_count: number | null;
  shirt_backs: { meet_name: string; level_group_label: string } | null;
}

export function BatchActions({
  batchId,
  currentStatus,
  batchBacks,
  userRole,
}: {
  batchId: number;
  currentStatus: string;
  batchBacks: BatchBack[];
  userRole: AdminRole;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [showReturnDialog, setShowReturnDialog] = useState(false);
  const [returnedCounts, setReturnedCounts] = useState<Record<number, string>>(() => {
    const initial: Record<number, string> = {};
    for (const bb of batchBacks) {
      initial[bb.id] = String(bb.shirt_count);
    }
    return initial;
  });

  const canManage = userRole === "admin" || userRole === "shipping";

  const nextStatus =
    currentStatus === "queued"
      ? "at_printer"
      : currentStatus === "at_printer"
        ? "returned"
        : null;

  const handleTransition = async () => {
    if (!nextStatus) return;

    // For "returned", show the return dialog with count inputs
    if (nextStatus === "returned") {
      setShowReturnDialog(true);
      return;
    }

    setLoading(true);
    await updateBatchStatus(batchId, nextStatus as "at_printer" | "returned");
    setLoading(false);
    router.refresh();
  };

  const handleConfirmReturn = async () => {
    setLoading(true);

    // Save returned counts first
    const counts: Array<{ batchBackId: number; returnedCount: number }> = [];
    for (const bb of batchBacks) {
      const val = parseInt(returnedCounts[bb.id] || "0", 10);
      // Clamp to valid range: 0 to expected count (no negatives, no absurd values)
      const clamped = isNaN(val) ? bb.shirt_count : Math.max(0, Math.min(val, bb.shirt_count * 2));
      counts.push({ batchBackId: bb.id, returnedCount: clamped });
    }

    await updateBatchReturnedCounts(counts);
    await updateBatchStatus(batchId, "returned");

    setLoading(false);
    setShowReturnDialog(false);
    router.refresh();
  };

  // Check for any discrepancies in the return counts
  const hasDiscrepancy = batchBacks.some((bb) => {
    const val = parseInt(returnedCounts[bb.id] || "0", 10);
    return !isNaN(val) && val < bb.shirt_count;
  });

  return (
    <>
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
        {canManage && nextStatus && (
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

      {/* Return dialog with count inputs (Unit 7c) */}
      {showReturnDialog && (
        <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-lg w-full max-h-[80vh] overflow-y-auto">
            <div className="p-6">
              <h3 className="text-lg font-semibold mb-1">Mark Batch Returned</h3>
              <p className="text-sm text-gray-500 mb-4">
                Enter the number of shirts returned for each back design. If fewer shirts
                were returned than expected, a discrepancy warning will be shown.
              </p>

              <div className="space-y-3 mb-4">
                {batchBacks.map((bb) => (
                  <div key={bb.id} className="flex items-center justify-between gap-3 p-3 bg-gray-50 rounded-lg">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">
                        {bb.shirt_backs?.meet_name || "Unknown"}
                      </p>
                      <p className="text-xs text-gray-500">
                        {bb.shirt_backs?.level_group_label || "All Levels"}
                        {" \u2022 "}{bb.shirt_count} expected
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-gray-500">Returned:</label>
                      <input
                        type="number"
                        min={0}
                        max={bb.shirt_count * 2}
                        value={returnedCounts[bb.id] || ""}
                        onChange={(e) =>
                          setReturnedCounts((prev) => ({
                            ...prev,
                            [bb.id]: e.target.value,
                          }))
                        }
                        className="w-20 border rounded px-2 py-1 text-sm text-center"
                        disabled={loading}
                      />
                    </div>
                  </div>
                ))}
              </div>

              {/* Discrepancy warning */}
              {hasDiscrepancy && (
                <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg">
                  <p className="text-sm font-medium text-red-700">
                    Discrepancy detected
                  </p>
                  <p className="text-xs text-red-600 mt-1">
                    Some backs have fewer returned shirts than expected. Missing items
                    can be re-batched from the order detail panel.
                  </p>
                </div>
              )}

              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setShowReturnDialog(false)}
                  disabled={loading}
                  className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleConfirmReturn}
                  disabled={loading}
                  className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50"
                >
                  {loading ? "Processing..." : "Confirm Return"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

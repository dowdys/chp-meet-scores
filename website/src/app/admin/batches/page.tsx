import { getPrinterBatches } from "@/lib/admin";
import { getUserRole } from "@/lib/auth";
import { StatusBadge } from "@/components/admin/status-badge";
import { BatchActions } from "./batch-actions";

export const dynamic = "force-dynamic";

export default async function BatchesPage() {
  const [{ data: batches }, userRole] = await Promise.all([
    getPrinterBatches(),
    getUserRole(),
  ]);

  const canManageBatches = userRole === "admin" || userRole === "shipping";

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Printer Batches</h1>
        <span className="text-sm text-gray-500">{batches.length} batches</span>
      </div>

      <div className="space-y-4">
        {batches.map((batch: any) => (
          <div key={batch.id} className="bg-white rounded-xl border p-4">
            <div className="flex justify-between items-start">
              <div>
                <h3 className="font-bold">{batch.batch_name}</h3>
                <p className="text-sm text-gray-500">
                  {batch.screen_printer === "printer_1" ? "Printer 1" : "Printer 2"}
                  {batch.printer_batch_backs?.length > 0 &&
                    ` \u2022 ${batch.printer_batch_backs.length} back${batch.printer_batch_backs.length !== 1 ? "s" : ""}`}
                  {` \u2022 ${batch.item_count || 0} shirt${(batch.item_count || 0) !== 1 ? "s" : ""}`}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <StatusBadge status={batch.status} type="batch" />
                {canManageBatches && (
                  <BatchActions
                    batchId={batch.id}
                    currentStatus={batch.status}
                    batchBacks={batch.printer_batch_backs || []}
                    userRole={userRole || "viewer"}
                  />
                )}
              </div>
            </div>

            {/* Item status breakdown (Unit 7c) */}
            {batch.status_breakdown && Object.keys(batch.status_breakdown).length > 0 && (
              <div className="mt-3 flex gap-3 flex-wrap">
                {Object.entries(batch.status_breakdown as Record<string, number>).map(
                  ([status, count]) => (
                    <div key={status} className="flex items-center gap-1.5">
                      <StatusBadge status={status} type="item" />
                      <span className="text-sm font-medium">{count as number}</span>
                    </div>
                  )
                )}
              </div>
            )}

            {/* Jewel count */}
            {(batch.jewel_count || 0) > 0 && (
              <div className="mt-2">
                <span className="text-sm font-semibold text-purple-600">
                  {batch.jewel_count} jewel{batch.jewel_count !== 1 ? "s" : ""}
                </span>
              </div>
            )}

            {/* Returned count discrepancy per back (Unit 7c) */}
            {batch.status === "returned" && batch.printer_batch_backs?.some(
              (bb: any) => bb.returned_count !== null && bb.returned_count < bb.shirt_count
            ) && (
              <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded-lg">
                <p className="text-xs font-medium text-red-700">Discrepancy detected:</p>
                {batch.printer_batch_backs
                  .filter((bb: any) => bb.returned_count !== null && bb.returned_count < bb.shirt_count)
                  .map((bb: any) => (
                    <p key={bb.id} className="text-xs text-red-600 mt-0.5">
                      {bb.shirt_backs?.meet_name} - {bb.shirt_backs?.level_group_label}:
                      expected {bb.shirt_count}, returned {bb.returned_count}
                      ({bb.shirt_count - bb.returned_count} missing)
                    </p>
                  ))}
              </div>
            )}

            {/* Dates */}
            {batch.sent_at && (
              <p className="text-xs text-gray-400 mt-2">
                Sent: {new Date(batch.sent_at).toLocaleDateString()}
                {batch.returned_at &&
                  ` | Returned: ${new Date(batch.returned_at).toLocaleDateString()}`}
              </p>
            )}
          </div>
        ))}

        {batches.length === 0 && (
          <p className="text-gray-400 text-center py-8">No batches yet</p>
        )}
      </div>
    </div>
  );
}

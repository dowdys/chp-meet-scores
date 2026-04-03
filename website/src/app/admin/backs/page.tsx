import { getOrdersByBack } from "@/lib/admin";
import { getUserRole } from "@/lib/auth";
import { StatusBadge } from "@/components/admin/status-badge";
import { BatchCreator } from "./batch-creator";

export const dynamic = "force-dynamic";

export default async function BacksPage() {
  const [{ data: items }, userRole] = await Promise.all([
    getOrdersByBack(),
    getUserRole(),
  ]);

  // Production stage summary across all items
  const stageCounts = { pending: 0, queued: 0, at_printer: 0, printed: 0 };
  let totalJewels = 0;

  for (const item of items) {
    const status = item.production_status as keyof typeof stageCounts;
    if (status in stageCounts) stageCounts[status]++;
    if (item.has_jewel) totalJewels++;
  }

  // Group items by back
  const backGroups = new Map<number, { label: string; meetName: string; items: typeof items }>();
  for (const item of items) {
    const backId = item.back_id || 0;
    const back = (item as any).shirt_backs;
    // Fall back to order_items.meet_name when shirt_backs not published yet
    // Strip the date portion from meet name: "USAG W Gymnastics - 2026 MN - March 20" -> "USAG W Gymnastics - 2026 MN"
    const rawMeetName = back?.meet_name || item.meet_name || "Unknown";
    const meetName = rawMeetName.replace(/\s*-\s*[A-Z][a-z]+ \d{1,2}(?:-\d{1,2})?$/, "");
    if (!backGroups.has(backId)) {
      backGroups.set(backId, {
        label: back?.level_group_label || "All Levels",
        meetName,
        items: [],
      });
    }
    backGroups.get(backId)!.items.push(item);
  }

  const canCreateBatch = userRole === "admin" || userRole === "shipping";

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-2">Orders by Back</h1>

      {/* Inline help text */}
      <p className="text-sm text-gray-500 mb-4">
        Items grouped by back design. Select backs and create a printer batch to move them into the production pipeline.
        Items progress: <strong>Pending</strong> &rarr; <strong>Queued</strong> &rarr; <strong>At Printer</strong> &rarr; <strong>Printed</strong>.
      </p>

      {/* Production stage summary (Unit 7b) */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        <div className="bg-white rounded-lg border p-3">
          <p className="text-xs text-gray-500">Pending</p>
          <p className="text-xl font-bold">{stageCounts.pending}</p>
        </div>
        <div className="bg-white rounded-lg border p-3">
          <p className="text-xs text-gray-500">Queued</p>
          <p className="text-xl font-bold">{stageCounts.queued}</p>
        </div>
        <div className="bg-white rounded-lg border p-3">
          <p className="text-xs text-gray-500">At Printer</p>
          <p className="text-xl font-bold">{stageCounts.at_printer}</p>
        </div>
        <div className="bg-white rounded-lg border p-3">
          <p className="text-xs text-gray-500">Printed</p>
          <p className="text-xl font-bold">{stageCounts.printed}</p>
        </div>
        <div className="bg-white rounded-lg border border-purple-200 bg-purple-50 p-3">
          <p className="text-xs text-purple-600">Total Jewels</p>
          <p className="text-xl font-bold text-purple-700">{totalJewels}</p>
        </div>
      </div>

      <p className="text-sm text-gray-500 mb-4">
        {backGroups.size} backs with pending/queued orders
      </p>

      {canCreateBatch && backGroups.size > 0 && (
        <BatchCreator backIds={Array.from(backGroups.keys())} />
      )}

      <div className="space-y-4">
        {Array.from(backGroups.entries()).map(([backId, group]) => {
          const sizes: Record<string, number> = {};
          let jewelCount = 0;
          let correctionCount = 0;
          const statusBreakdown: Record<string, number> = {};

          for (const item of group.items) {
            sizes[item.shirt_size] = (sizes[item.shirt_size] || 0) + 1;
            if (item.has_jewel) jewelCount++;
            if (item.corrected_name && !item.name_correction_reviewed) correctionCount++;
            statusBreakdown[item.production_status] = (statusBreakdown[item.production_status] || 0) + 1;
          }

          return (
            <div key={backId} className="bg-white rounded-xl border p-4">
              <div className="flex justify-between items-start">
                <div>
                  <h3 className="font-bold">{group.meetName}</h3>
                  <p className="text-sm text-gray-500">{group.label}</p>
                </div>
                <div className="text-right">
                  <p className="font-bold">{group.items.length} shirts</p>
                  {jewelCount > 0 && (
                    <p className="text-sm font-semibold text-purple-600">
                      {jewelCount} jewel{jewelCount !== 1 ? "s" : ""}
                    </p>
                  )}
                  {correctionCount > 0 && (
                    <p className="text-sm text-red-600">
                      {correctionCount} correction{correctionCount !== 1 ? "s" : ""}
                    </p>
                  )}
                </div>
              </div>
              <div className="mt-2 flex gap-2 flex-wrap">
                {Object.entries(sizes).map(([size, count]) => (
                  <span key={size} className="bg-gray-100 px-2 py-0.5 rounded text-xs">
                    {size}: {count}
                  </span>
                ))}
              </div>
              {/* Status breakdown per back group */}
              <div className="mt-2 flex gap-2 flex-wrap">
                {Object.entries(statusBreakdown).map(([status, count]) => (
                  <span key={status} className="flex items-center gap-1">
                    <StatusBadge status={status} type="item" />
                    <span className="text-xs text-gray-500">{count}</span>
                  </span>
                ))}
              </div>
            </div>
          );
        })}

        {backGroups.size === 0 && (
          <p className="text-gray-400 text-center py-8">No pending orders</p>
        )}
      </div>
    </div>
  );
}

import { getNameCorrections } from "@/lib/admin";
import { CorrectionActions } from "./correction-actions";

export const dynamic = "force-dynamic";

export default async function AlertsPage() {
  const { data: corrections } = await getNameCorrections();

  // Dedup: group corrections by (athlete_name, corrected_name, meet_name)
  const groups = new Map<
    string,
    { items: typeof corrections; athlete_name: string; corrected_name: string; meet_name: string }
  >();

  for (const item of corrections) {
    const key = `${item.athlete_name}|${item.corrected_name}|${item.meet_name}`;
    if (!groups.has(key)) {
      groups.set(key, {
        items: [],
        athlete_name: item.athlete_name,
        corrected_name: item.corrected_name,
        meet_name: item.meet_name,
      });
    }
    groups.get(key)!.items.push(item);
  }

  const uniqueCorrections = Array.from(groups.values());

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-6">
        Alerts
        {uniqueCorrections.length > 0 && (
          <span className="ml-2 bg-red-100 text-red-700 px-2 py-0.5 rounded text-sm">
            {uniqueCorrections.length} pending
          </span>
        )}
      </h1>

      <h2 className="text-lg font-semibold mb-4">Name Corrections</h2>

      <div className="space-y-3">
        {uniqueCorrections.map((group) => (
          <div
            key={`${group.athlete_name}-${group.corrected_name}`}
            className="bg-white rounded-xl border p-4"
          >
            <div className="flex justify-between items-start">
              <div>
                <p className="text-sm text-gray-500">
                  {group.items.length} shirt{group.items.length > 1 ? "s" : ""} affected
                  {" \u2022 "}
                  Order {(group.items[0] as any).orders?.order_number || "Unknown"}
                </p>
                <div className="flex items-center gap-2 mt-1">
                  <span className="line-through text-red-500">
                    {group.athlete_name}
                  </span>
                  <span className="text-gray-400">{"\u2192"}</span>
                  <span className="font-bold text-green-700">
                    {group.corrected_name}
                  </span>
                </div>
                <p className="text-xs text-gray-400 mt-1">
                  {group.meet_name}
                </p>
              </div>
              {/* Apply/Dismiss applies to ALL items in the group */}
              <CorrectionActions
                itemId={group.items[0].id}
                allItemIds={group.items.map((i) => i.id)}
              />
            </div>
          </div>
        ))}

        {uniqueCorrections.length === 0 && (
          <p className="text-gray-400 text-center py-8">
            No pending corrections
          </p>
        )}
      </div>
    </div>
  );
}

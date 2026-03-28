import { getOrdersByBack } from "@/lib/admin";
import { BatchCreator } from "./batch-creator";

export const dynamic = "force-dynamic";

export default async function BacksPage() {
  const { data: items } = await getOrdersByBack();

  // Group items by back
  const backGroups = new Map<number, { label: string; meetName: string; items: typeof items }>();
  for (const item of items) {
    const backId = item.back_id || 0;
    const back = (item as any).shirt_backs;
    // Fall back to order_items.meet_name when shirt_backs not published yet
    // Strip the date portion from meet name: "USAG W Gymnastics - 2026 MN - March 20" → "USAG W Gymnastics - 2026 MN"
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

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-6">Orders by Back</h1>
      <p className="text-sm text-gray-500 mb-4">
        {backGroups.size} backs with pending orders
      </p>

      {backGroups.size > 0 && (
        <BatchCreator backIds={Array.from(backGroups.keys())} />
      )}

      <div className="space-y-4">
        {Array.from(backGroups.entries()).map(([backId, group]) => {
          const sizes: Record<string, number> = {};
          let jewelCount = 0;
          let correctionCount = 0;

          for (const item of group.items) {
            sizes[item.shirt_size] = (sizes[item.shirt_size] || 0) + 1;
            if (item.has_jewel) jewelCount++;
            if (item.corrected_name && !item.name_correction_reviewed) correctionCount++;
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
                    <p className="text-sm text-purple-600">{"💎"} {jewelCount} jewel</p>
                  )}
                  {correctionCount > 0 && (
                    <p className="text-sm text-red-600">{"⚠️"} {correctionCount} corrections</p>
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

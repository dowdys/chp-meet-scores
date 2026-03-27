import { getNameCorrections } from "@/lib/admin";

export const dynamic = "force-dynamic";

export default async function AlertsPage() {
  const { data: corrections } = await getNameCorrections();

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-6">
        Alerts
        {corrections.length > 0 && (
          <span className="ml-2 bg-red-100 text-red-700 px-2 py-0.5 rounded text-sm">
            {corrections.length} pending
          </span>
        )}
      </h1>

      <h2 className="text-lg font-semibold mb-4">Name Corrections</h2>

      <div className="space-y-3">
        {corrections.map((item: any) => (
          <div key={item.id} className="bg-white rounded-xl border p-4">
            <div className="flex justify-between items-start">
              <div>
                <p className="text-sm text-gray-500">
                  Order {(item as any).orders?.order_number || "Unknown"}
                </p>
                <div className="flex items-center gap-2 mt-1">
                  <span className="line-through text-red-500">{item.athlete_name}</span>
                  <span className="text-gray-400">\u2192</span>
                  <span className="font-bold text-green-700">{item.corrected_name}</span>
                </div>
                <p className="text-xs text-gray-400 mt-1">
                  {(item as any).shirt_backs?.meet_name || item.meet_name} \u2022{" "}
                  {(item as any).shirt_backs?.level_group_label || ""}
                </p>
              </div>
              <div className="flex gap-2">
                <button className="bg-green-500 text-white px-3 py-1 rounded text-xs hover:bg-green-600">
                  Apply
                </button>
                <button className="bg-gray-200 text-gray-700 px-3 py-1 rounded text-xs hover:bg-gray-300">
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        ))}

        {corrections.length === 0 && (
          <p className="text-gray-400 text-center py-8">No pending corrections</p>
        )}
      </div>
    </div>
  );
}

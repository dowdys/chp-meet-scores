import { getNameCorrections } from "@/lib/admin";
import { CorrectionActions } from "./correction-actions";

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
                  Order {item.orders?.order_number || "Unknown"}
                </p>
                <div className="flex items-center gap-2 mt-1">
                  <span className="line-through text-red-500">
                    {item.athlete_name}
                  </span>
                  <span className="text-gray-400">{"\u2192"}</span>
                  <span className="font-bold text-green-700">
                    {item.corrected_name}
                  </span>
                </div>
                <p className="text-xs text-gray-400 mt-1">
                  {item.shirt_backs?.meet_name || item.meet_name}
                  {" \u2022 "}
                  {item.shirt_backs?.level_group_label || ""}
                </p>
              </div>
              <CorrectionActions itemId={item.id} />
            </div>
          </div>
        ))}

        {corrections.length === 0 && (
          <p className="text-gray-400 text-center py-8">
            No pending corrections
          </p>
        )}
      </div>
    </div>
  );
}

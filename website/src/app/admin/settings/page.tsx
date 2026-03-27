import { createServiceClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const supabase = createServiceClient();
  const { data: admins } = await supabase
    .from("admin_users")
    .select("*")
    .order("created_at");

  const { data: history } = await supabase
    .from("order_status_history")
    .select("*, orders(order_number)")
    .order("created_at", { ascending: false })
    .limit(50);

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-6">Settings</h1>

      <h2 className="text-lg font-semibold mb-3">Team Members</h2>
      <div className="bg-white rounded-xl border mb-8">
        {(admins || []).map((admin: any) => (
          <div key={admin.id} className="p-4 border-b last:border-b-0 flex justify-between">
            <div>
              <p className="font-medium">{admin.name}</p>
              <p className="text-sm text-gray-500">{admin.role}</p>
            </div>
          </div>
        ))}
        {(!admins || admins.length === 0) && (
          <p className="p-4 text-gray-400">No admin users configured</p>
        )}
      </div>

      <h2 className="text-lg font-semibold mb-3">Activity Log</h2>
      <div className="bg-white rounded-xl border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left p-3">Time</th>
              <th className="text-left p-3">Order</th>
              <th className="text-left p-3">Change</th>
              <th className="text-left p-3">By</th>
              <th className="text-left p-3">Reason</th>
            </tr>
          </thead>
          <tbody>
            {(history || []).map((h: any) => (
              <tr key={h.id} className="border-b">
                <td className="p-3 text-xs text-gray-500">
                  {new Date(h.created_at).toLocaleString()}
                </td>
                <td className="p-3 font-mono text-xs">{h.orders?.order_number || "-"}</td>
                <td className="p-3">
                  {h.old_status && <span className="text-gray-400">{h.old_status} \u2192 </span>}
                  <span className="font-medium">{h.new_status}</span>
                </td>
                <td className="p-3">{h.changed_by || "system"}</td>
                <td className="p-3 text-gray-500">{h.reason || "-"}</td>
              </tr>
            ))}
            {(!history || history.length === 0) && (
              <tr>
                <td colSpan={5} className="p-4 text-center text-gray-400">No activity yet</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

import { createServiceClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  const supabase = createServiceClient();

  const [scansResult, capturesResult, ordersResult] = await Promise.all([
    supabase.from("athlete_tokens").select("scan_count").gt("scan_count", 0),
    supabase.from("email_captures").select("source"),
    supabase.from("orders").select("total, shipping_state, created_at"),
  ]);

  const tokens = scansResult.data || [];
  const totalScans = tokens.reduce((sum: number, t: { scan_count: number }) => sum + (t.scan_count || 0), 0);
  const scannedCount = tokens.length;

  const captures = capturesResult.data || [];
  const orders = ordersResult.data || [];

  // Revenue by state
  const revenueByState = new Map<string, number>();
  for (const o of orders) {
    const state = o.shipping_state || "Unknown";
    revenueByState.set(state, (revenueByState.get(state) || 0) + (o.total || 0));
  }

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-6">Analytics</h1>

      <div className="grid grid-cols-3 gap-4 mb-8">
        <div className="bg-white rounded-xl border p-4">
          <p className="text-sm text-gray-500">Total QR Scans</p>
          <p className="text-3xl font-bold">{totalScans.toLocaleString()}</p>
          <p className="text-xs text-gray-400">{scannedCount} unique athletes scanned</p>
        </div>
        <div className="bg-white rounded-xl border p-4">
          <p className="text-sm text-gray-500">Email Signups</p>
          <p className="text-3xl font-bold">{captures.length}</p>
        </div>
        <div className="bg-white rounded-xl border p-4">
          <p className="text-sm text-gray-500">Total Orders</p>
          <p className="text-3xl font-bold">{orders.length}</p>
        </div>
      </div>

      <h2 className="text-lg font-semibold mb-3">Revenue by State</h2>
      <div className="bg-white rounded-xl border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left p-3">State</th>
              <th className="text-left p-3">Orders</th>
              <th className="text-left p-3">Revenue</th>
            </tr>
          </thead>
          <tbody>
            {Array.from(revenueByState.entries())
              .sort((a, b) => b[1] - a[1])
              .map(([state, revenue]) => (
                <tr key={state} className="border-b">
                  <td className="p-3 font-medium">{state}</td>
                  <td className="p-3">{orders.filter((o: { shipping_state: string }) => o.shipping_state === state).length}</td>
                  <td className="p-3">${(revenue / 100).toFixed(2)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

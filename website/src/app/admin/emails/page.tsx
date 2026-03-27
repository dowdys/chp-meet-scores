import { getEmailCaptures } from "@/lib/admin";
import { BlastAction } from "./blast-action";

export const dynamic = "force-dynamic";

export default async function EmailsPage() {
  const { data: captures } = await getEmailCaptures();
  const pending = captures.filter((c: any) => !c.notified);
  const notified = captures.filter((c: any) => c.notified);

  // Group pending by state
  const byState = new Map<string, typeof pending>();
  for (const c of pending) {
    const state = (c as any).state || "Unknown";
    if (!byState.has(state)) byState.set(state, []);
    byState.get(state)!.push(c);
  }

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-6">Email Captures</h1>
      <p className="text-sm text-gray-500 mb-4">
        {pending.length} pending \u2022 {notified.length} notified
      </p>

      <h2 className="text-lg font-semibold mb-3">Pending by State</h2>
      <div className="space-y-3 mb-8">
        {Array.from(byState.entries()).map(([state, stateCaptures]) => (
          <div key={state} className="bg-white rounded-xl border p-4 flex justify-between items-center">
            <div>
              <h3 className="font-bold">{state}</h3>
              <p className="text-sm text-gray-500">{stateCaptures.length} signups</p>
            </div>
            <BlastAction state={state} count={stateCaptures.length} />
          </div>
        ))}
        {byState.size === 0 && (
          <p className="text-gray-400 text-center py-4">No pending captures</p>
        )}
      </div>

      <h2 className="text-lg font-semibold mb-3">All Captures</h2>
      <div className="bg-white rounded-xl border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left p-3">Email</th>
              <th className="text-left p-3">Athlete</th>
              <th className="text-left p-3">State</th>
              <th className="text-left p-3">Gym</th>
              <th className="text-left p-3">Status</th>
              <th className="text-left p-3">Date</th>
            </tr>
          </thead>
          <tbody>
            {captures.map((c: any) => (
              <tr key={c.id} className="border-b">
                <td className="p-3">{c.email}</td>
                <td className="p-3">{c.athlete_name}</td>
                <td className="p-3">{c.state || "-"}</td>
                <td className="p-3">{c.gym || "-"}</td>
                <td className="p-3">
                  <span className={`px-2 py-0.5 rounded text-xs ${
                    c.notified ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-700"
                  }`}>
                    {c.notified ? "notified" : "pending"}
                  </span>
                </td>
                <td className="p-3 text-gray-500">{new Date(c.created_at).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

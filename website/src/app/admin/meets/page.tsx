import { createServiceClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function MeetsPage() {
  const supabase = createServiceClient();
  const { data: meets } = await supabase
    .from("meets")
    .select("*, shirt_backs(id), athlete_tokens(id)")
    .order("published_at", { ascending: false })
    .limit(50);

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-6">Meet Processing Status</h1>

      <div className="bg-white rounded-xl border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left p-3">Meet</th>
              <th className="text-left p-3">State</th>
              <th className="text-left p-3">Year</th>
              <th className="text-left p-3">Winners</th>
              <th className="text-left p-3">Backs</th>
              <th className="text-left p-3">Tokens</th>
              <th className="text-left p-3">Published</th>
            </tr>
          </thead>
          <tbody>
            {(meets || []).map((meet: any) => {
              const hasBacks = meet.shirt_backs?.length > 0;
              const hasTokens = meet.athlete_tokens?.length > 0;
              const ready = hasBacks && hasTokens;

              return (
                <tr key={meet.id} className="border-b hover:bg-gray-50">
                  <td className="p-3 font-medium">{meet.meet_name}</td>
                  <td className="p-3">{meet.state}</td>
                  <td className="p-3">{meet.year}</td>
                  <td className="p-3">{meet.winner_count}</td>
                  <td className="p-3">
                    {hasBacks ? (
                      <span className="text-green-600">\u2713 {meet.shirt_backs.length}</span>
                    ) : (
                      <span className="text-gray-400">\u2014</span>
                    )}
                  </td>
                  <td className="p-3">
                    {hasTokens ? (
                      <span className="text-green-600">\u2713 {meet.athlete_tokens.length}</span>
                    ) : (
                      <span className="text-gray-400">\u2014</span>
                    )}
                  </td>
                  <td className="p-3">
                    <span className={`px-2 py-0.5 rounded text-xs ${
                      ready ? "bg-green-100 text-green-700" : "bg-yellow-100 text-yellow-700"
                    }`}>
                      {ready ? "Ready" : "Pending"}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

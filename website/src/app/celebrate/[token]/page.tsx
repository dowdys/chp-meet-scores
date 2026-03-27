import { createServiceClient } from "@/lib/supabase/server";
import { CelebrationClient } from "./celebration-client";
import Link from "next/link";
import type { Metadata } from "next";

interface PageProps {
  params: Promise<{ token: string }>;
}

// ISR: cache celebration pages at the edge, revalidate daily
export const revalidate = 86400;

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { token } = await params;
  const supabase = createServiceClient();

  // Read-only query — do NOT use lookup_athlete_token (which mutates scan_count)
  const { data } = await supabase
    .from("athlete_tokens")
    .select("athlete_name, gym")
    .eq("token", token)
    .single();

  if (!data) {
    return { title: "The State Champion", robots: { index: false } };
  }

  return {
    // Generic title for COPPA — don't put child's name in meta tags
    title: "Championship Results | The State Champion",
    description: "View your championship results and order your shirt!",
    robots: { index: false },
  };
}

export default async function CelebrationPage({ params }: PageProps) {
  const { token } = await params;
  const supabase = createServiceClient();

  // Read-only query for page rendering (scan tracking moved to client-side)
  const { data, error } = await supabase
    .from("athlete_tokens")
    .select("token, meet_name, athlete_name, gym, level, division, events")
    .eq("token", token)
    .single();

  if (error || !data) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold mb-4">Page Not Found</h1>
          <p className="text-gray-400 mb-6">
            This celebration link may have expired or been updated.
          </p>
          <Link
            href="/find"
            className="bg-yellow-400 text-black px-6 py-3 rounded-lg font-bold"
          >
            Find Your Champion
          </Link>
        </div>
      </div>
    );
  }

  // Server-render the athlete data immediately (visible before JS loads)
  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-900 via-gray-800 to-black">
      {/* Server-rendered fallback visible immediately */}
      <noscript>
        <div className="text-center text-white py-20 px-6">
          <div className="text-7xl mb-6">🏆</div>
          <h1 className="text-4xl font-bold mb-4">{data.athlete_name}</h1>
          <p className="text-yellow-300 mb-4">{data.gym}</p>
          <p className="text-gray-400">
            Level {data.level} • {data.meet_name.split(" - ")[2]?.split(" -")[0] || "State"} Champion
          </p>
          <Link
            href={`/order?name=${encodeURIComponent(data.athlete_name)}&gym=${encodeURIComponent(data.gym)}&meet=${encodeURIComponent(data.meet_name)}&level=${encodeURIComponent(data.level)}`}
            className="inline-block mt-8 bg-yellow-400 text-black px-8 py-4 rounded-lg font-bold"
          >
            Order Your Championship Shirt
          </Link>
        </div>
      </noscript>

      {/* Client-side animated version (loads on top of server content) */}
      <CelebrationClient
        token={data.token}
        athleteName={data.athlete_name}
        gym={data.gym}
        level={data.level}
        meetName={data.meet_name}
        events={data.events || []}
      />
    </div>
  );
}

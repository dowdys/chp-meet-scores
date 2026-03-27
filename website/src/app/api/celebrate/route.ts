import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";

// Scan tracking — called from celebration page client component on mount
export async function POST(request: NextRequest) {
  try {
    const { token } = await request.json();

    if (!token || typeof token !== "string") {
      return NextResponse.json({ error: "Invalid token" }, { status: 400 });
    }

    const supabase = createServiceClient();

    // Increment scan count atomically
    await supabase.rpc("lookup_athlete_token", { p_token: token });

    return NextResponse.json({ tracked: true });
  } catch {
    // Non-critical — don't fail loudly for analytics
    return NextResponse.json({ tracked: false });
  }
}

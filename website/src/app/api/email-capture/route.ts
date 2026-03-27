import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";

interface EmailCaptureBody {
  email: string;
  phone?: string;
  athlete_name: string;
  state?: string;
  association?: string;
  gym?: string;
  level?: string;
  source?: string;
}

// Simple email format validation
function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function POST(request: NextRequest) {
  try {
    const body: EmailCaptureBody = await request.json();

    // Validate required fields
    if (!body.email || !body.athlete_name) {
      return NextResponse.json(
        { error: "Email and athlete name are required" },
        { status: 400 }
      );
    }

    if (!isValidEmail(body.email)) {
      return NextResponse.json(
        { error: "Invalid email format" },
        { status: 400 }
      );
    }

    if (body.athlete_name.length > 100) {
      return NextResponse.json(
        { error: "Athlete name too long" },
        { status: 400 }
      );
    }

    // Sanitize: strip any HTML tags from all string fields
    const sanitize = (s?: string) =>
      s?.replace(/<[^>]*>/g, "").trim().substring(0, 200);

    const supabase = createServiceClient();

    const { error } = await supabase.from("email_captures").upsert(
      {
        email: body.email.trim().toLowerCase(),
        phone: sanitize(body.phone) || null,
        athlete_name: sanitize(body.athlete_name)!,
        state: sanitize(body.state) || null,
        association: sanitize(body.association) || null,
        gym: sanitize(body.gym) || null,
        level: sanitize(body.level) || null,
        source: body.source || "website",
      },
      {
        onConflict: "email,athlete_name,state", // matches unique index
        ignoreDuplicates: true,
      }
    );

    if (error) {
      console.error("Email capture insert error:", error);
      return NextResponse.json(
        { error: "Failed to save. Please try again." },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "Invalid request" },
      { status: 400 }
    );
  }
}

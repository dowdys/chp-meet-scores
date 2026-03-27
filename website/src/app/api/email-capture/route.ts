import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { emailCaptureSchema } from "@/lib/validation";

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
    const raw = await request.json();

    // Validate with Zod schema
    const parsed = emailCaptureSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message || "Invalid data" },
        { status: 400 }
      );
    }

    const body = parsed.data;

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
        phone: sanitize(body.phone ?? undefined) || null,
        athlete_name: sanitize(body.athlete_name) || body.athlete_name,
        state: sanitize(body.state ?? undefined) || null,
        association: sanitize(body.association ?? undefined) || null,
        gym: sanitize(body.gym ?? undefined) || null,
        level: sanitize(body.level ?? undefined) || null,
        source: sanitize(body.source) || "website",
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

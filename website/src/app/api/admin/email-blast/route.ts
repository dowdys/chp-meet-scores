import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/auth";
import { sendBatchEmails } from "@/lib/postmark";
import { render } from "@react-email/render";
import { ResultsReadyEmail } from "@/emails/results-ready";

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  try {
    const { state }: { state: string } = await request.json();

    if (!state) {
      return NextResponse.json(
        { error: "State is required" },
        { status: 400 }
      );
    }

    const supabase = createServiceClient();

    // Get unnotified captures for this state
    const { data: captures, error } = await supabase
      .from("email_captures")
      .select("*")
      .eq("state", state)
      .eq("notified", false);

    if (error || !captures || captures.length === 0) {
      return NextResponse.json(
        { error: "No pending captures for this state" },
        { status: 404 }
      );
    }

    // Render email template for each recipient
    const emails = await Promise.all(
      captures.map(async (capture) => ({
        to: capture.email,
        subject: `${state} Championship Results Are Ready!`,
        htmlBody: await render(
          ResultsReadyEmail({
            athleteName: capture.athlete_name,
            state,
          })
        ),
        stream: "broadcasts",
      }))
    );

    // Send via Postmark broadcast stream
    const results = await sendBatchEmails(emails);

    // Mark captures as notified
    const captureIds = captures.map((c) => c.id);
    await supabase
      .from("email_captures")
      .update({
        notified: true,
        notified_at: new Date().toISOString(),
      })
      .in("id", captureIds);

    return NextResponse.json({
      sent: results.length,
      state,
    });
  } catch (err) {
    console.error("Email blast failed:", err);
    return NextResponse.json(
      { error: "Failed to send email blast" },
      { status: 500 }
    );
  }
}

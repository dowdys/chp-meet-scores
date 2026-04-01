import { NextRequest, NextResponse } from "next/server";
import { sendEmail } from "@/lib/postmark";
import { timingSafeEqual } from "crypto";

const RELAY_SECRET = process.env.RELAY_API_SECRET;

// Hardcoded recipients — the client never specifies who gets the email
const RECIPIENTS = {
  designer: "chn@netscape.com",
  report: "dowdy@marketdriveauto.com",
} as const;

const MAX_BODY_BYTES = 4 * 1024 * 1024; // 4 MB

function isValidKey(provided: string): boolean {
  if (!RELAY_SECRET) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(RELAY_SECRET);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function sanitize(s: string): string {
  return s.replace(/[\r\n]/g, " ").trim();
}

export async function POST(request: NextRequest) {
  // Auth
  const apiKey = request.headers.get("x-api-key");
  if (!apiKey || !isValidKey(apiKey)) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  // Size guard
  const contentLength = parseInt(request.headers.get("content-length") || "0", 10);
  if (contentLength > MAX_BODY_BYTES) {
    return NextResponse.json(
      { success: false, error: "Payload too large. Max 4 MB." },
      { status: 413 }
    );
  }

  try {
    const body = await request.json();
    const { type, meetName, note, attachments } = body as {
      type: "designer" | "report";
      meetName: string;
      note?: string;
      attachments?: Array<{ filename: string; content: string; contentType: string }>;
    };

    if (!type || !["designer", "report"].includes(type)) {
      return NextResponse.json(
        { success: false, error: "Invalid type. Must be 'designer' or 'report'." },
        { status: 400 }
      );
    }

    if (!meetName) {
      return NextResponse.json(
        { success: false, error: "meetName is required." },
        { status: 400 }
      );
    }

    const cleanName = sanitize(meetName);
    const to = RECIPIENTS[type];

    if (type === "designer") {
      await sendEmail({
        to,
        subject: `[CHP] ${cleanName} — Designer Files`,
        textBody: `IDML files for meet: ${cleanName}\n\n${attachments?.length || 0} file(s) attached.`,
        attachments: attachments || [],
      });
    } else {
      const noteText = note ? sanitize(note) : "(No description provided)";
      await sendEmail({
        to,
        subject: `[CHP] Issue Report — ${cleanName}`,
        textBody: `Issue report for meet: ${cleanName}\n\nUser's description:\n${noteText}\n\n${attachments?.length ? "Process log attached." : "No process log available."}`,
        attachments: attachments || [],
      });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[send-email] Error:", message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

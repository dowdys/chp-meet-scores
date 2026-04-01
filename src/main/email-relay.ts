/**
 * Email relay client — sends emails through the Vercel API route using Postmark.
 * Replaces the old SMTP service (smtp-service.ts). No user configuration needed.
 */

// The relay route URL and shared secret are hardcoded.
// The secret only grants access to send to two hardcoded server-side addresses
// (designer + dowdy), so the blast radius of extraction is minimal.
const API_URL = 'https://order.thestatechampion.com/api/send-email';
const API_KEY = 'b5c25e5868da88dee445850944e9def5106c85e0ecc6f0ea0feee54852d1ee4f';

/** Max payload size before base64 overhead — keep under Vercel's 4.5MB limit. */
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

const TIMEOUT_MS = 30_000;

interface RelayAttachment {
  filename: string;
  content: string;      // base64-encoded
  contentType: string;
}

interface RelayRequest {
  type: 'designer' | 'report';
  meetName: string;
  note?: string;
  attachments?: RelayAttachment[];
}

interface RelayResult {
  success: boolean;
  error?: string;
}

function classifyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('abort') || msg.includes('timeout'))
    return 'Email send timed out. Check your internet connection and try again.';
  if (msg.includes('fetch') || msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED'))
    return 'Could not reach email server. Check your internet connection.';
  return `Email send failed: ${msg}`;
}

export async function sendViaRelay(request: RelayRequest): Promise<RelayResult> {
  // Pre-flight size check
  if (request.attachments) {
    const totalBytes = request.attachments.reduce((sum, a) => sum + a.content.length, 0);
    if (totalBytes > MAX_PAYLOAD_BYTES) {
      const sizeMB = Math.round(totalBytes / 1024 / 1024);
      return {
        success: false,
        error: `Attachments total ~${sizeMB} MB, exceeding the 4 MB relay limit. Consider sharing files via another method.`,
      };
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    const data = await response.json() as { success: boolean; error?: string };

    if (!response.ok) {
      if (response.status === 401) return { success: false, error: 'Email relay authentication failed. The app may need updating.' };
      if (response.status === 413) return { success: false, error: 'Files too large for email. Try sending fewer files.' };
      return { success: false, error: data.error || `Server error (${response.status})` };
    }

    return data;
  } catch (err) {
    return { success: false, error: classifyError(err) };
  } finally {
    clearTimeout(timer);
  }
}
